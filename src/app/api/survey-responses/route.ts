import { NextRequest, NextResponse } from "next/server"
import { Pool } from 'pg';
import { getActiveCycle, generateSurveyNumber, getNextSurveySequence } from '@/utils/surveyCycleHelpers';
import { verifyGPSLocation, validateGPSCoordinates, type GPSCoordinates } from '@/app/survey/forms/utils/gpsVerification';
import { validateSurveyNFAData } from '@/lib/validation/nfa-storage-validation';
import { transformNFAFields } from '@/app/survey/forms/utils/nfaFieldTransform';
import { getClientWithRetry, withRetry } from '@/lib/db/retry-utils';
import {
  badRequestResponse,
  missingFieldsResponse,
  nfaValidationErrorResponse,
  handleDatabaseError,
  validateRequiredFields
} from '@/lib/api/error-responses';

// Initialize PostgreSQL connection pool
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('Missing DATABASE_URL in environment variables');
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false // Required for Supabase connections
  }
});

/**
 * Recalculate survey target progress for a specific barangay and cycle
 * This counts actual completed/submitted responses and updates the survey_target table
 */
async function recalculateSurveyTargetProgress(client: any, barangayId: number, cycleId: number) {
  try {
    // Count actual completed/submitted responses
    const countQuery = `
      SELECT COUNT(*) as count
      FROM survey_response
      WHERE barangay_id = $1 
        AND survey_cycle_id = $2
        AND status IN ('completed', 'submitted')
    `;
    const countResult = await client.query(countQuery, [barangayId, cycleId]);
    const actualCount = parseInt(countResult.rows[0].count) || 0;

    // Update the survey target with actual count
    const updateQuery = `
      UPDATE survey_target
      SET 
        achieved = $1,
        percentage = CASE 
          WHEN target > 0 THEN LEAST(100, ROUND(($1::decimal / target::decimal) * 100))
          ELSE 0 
        END,
        updated_at = NOW()
      WHERE barangay_id = $2 AND survey_cycle_id = $3
    `;
    const updateResult = await client.query(updateQuery, [actualCount, barangayId, cycleId]);

    if (updateResult.rowCount === 0) {
      console.warn(
        `⚠️ recalculateSurveyTargetProgress: no survey_target row found for ` +
        `barangay_id=${barangayId}, cycle_id=${cycleId} — achieved/percentage not updated`
      );
    } else {
      console.log(`✅ Recalculated progress for barangay ${barangayId}: ${actualCount} responses`);
    }
  } catch (error) {
    // Log with full detail so the failure is visible in server logs.
    // We still don't throw because the survey submission itself succeeded —
    // the stored columns are a cache; the live COUNT queries are the source of truth.
    console.error(
      `❌ recalculateSurveyTargetProgress failed for barangay_id=${barangayId}, cycle_id=${cycleId}:`,
      error
    );
  }
}

export async function POST(request: NextRequest) {
  let client;
  try {
    const body = await request.json()
    
    const {
      surveyNumber,
      location,
      verificationLocation,
      selectedMember,
      interviewerId,
      barangayId,
      respondentDemographics,
      sections,
      questionnaireId,
      spotId
    } = body

    // Requirement 3.1, 3.2: Validate required fields
    const missingFields = validateRequiredFields(body, ['location', 'interviewerId', 'barangayId']);
    if (missingFields.length > 0) {
      return missingFieldsResponse(missingFields);
    }

    // Transform NFA field names from internal format to database format
    let transformedSections = sections;
    if (sections) {
      console.log('🔍 [NFA Transform] Original sections keys:', Object.keys(sections));
      transformedSections = Object.entries(sections).reduce((acc, [sectionKey, sectionData]: [string, any]) => {
        console.log(`🔍 [NFA Transform] Processing section: ${sectionKey}`, {
          hasSectionData: !!sectionData,
          hasDataProperty: sectionData && 'data' in sectionData,
          sampleKeys: sectionData ? Object.keys(sectionData).slice(0, 5) : []
        });
        
        const dataToTransform = sectionData.data || sectionData;
        const transformed = transformNFAFields(dataToTransform);
        
        console.log(`🔍 [NFA Transform] Section ${sectionKey} - Before/After sample:`, {
          beforeKeys: Object.keys(dataToTransform).filter(k => k.includes('nfa') || k.includes('suggestion')),
          afterKeys: Object.keys(transformed).filter(k => k.includes('need_for_action'))
        });
        
        acc[sectionKey] = {
          ...sectionData,
          data: transformed
        };
        return acc;
      }, {} as Record<string, any>);
    }

    // Requirement 3.3: Validate NFA data structure completeness before storage
    if (transformedSections) {
      // Debug: Check financial section data
      if (transformedSections.financial && transformedSections.financial.data) {
        const financialData = transformedSections.financial.data;
        console.log('🔍 [NFA Debug] Financial section NFA fields:', {
          has_binary_financial: 'need_for_action_binary_financial' in financialData,
          binary_financial_value: financialData.need_for_action_binary_financial,
          has_suggestion_financial: 'need_for_action_suggestion_financial' in financialData,
          suggestion_financial_value: financialData.need_for_action_suggestion_financial,
          suggestion_type: typeof financialData.need_for_action_suggestion_financial
        });
      }
      
      const nfaValidation = validateSurveyNFAData(transformedSections);
      if (!nfaValidation.valid) {
        console.warn('NFA validation errors:', nfaValidation.errors);
        if (nfaValidation.warnings) {
          console.warn('NFA validation warnings:', nfaValidation.warnings);
        }
        return nfaValidationErrorResponse(nfaValidation.errors, nfaValidation.warnings);
      }
      
      // Log warnings even if validation passes
      if (nfaValidation.warnings && nfaValidation.warnings.length > 0) {
        console.warn('NFA validation warnings:', nfaValidation.warnings);
      }
    }

    // Requirement 3.3: Get database client with retry logic for connection failures
    client = await getClientWithRetry(pool, { maxAttempts: 3 });

    // Get active survey cycle
    const activeCycle = await getActiveCycle();
    if (!activeCycle) {
      return NextResponse.json(
        { error: "No active survey cycle found. Please set an active cycle before creating survey responses." },
        { status: 400 }
      )
    }

    // Calculate GPS verification if verificationLocation is provided
    let gpsVerificationStatus = 'pending';
    let gpsDistanceMeters: number | null = null;
    let verificationLocationJson: any = null;

    if (verificationLocation && validateGPSCoordinates(verificationLocation)) {
      verificationLocationJson = verificationLocation;

      // Get assigned spot location if spotId is provided
      if (spotId) {
        try {
          const spotQuery = 'SELECT starting_point FROM spots WHERE spot_id = $1';
          const spotResult = await client.query(spotQuery, [parseInt(spotId)]);
          
          if (spotResult.rows.length > 0 && spotResult.rows[0].starting_point) {
            const assignedSpot = spotResult.rows[0].starting_point as GPSCoordinates;
            
            // Verify GPS location against assigned spot
            const verificationResult = verifyGPSLocation(
              assignedSpot,
              verificationLocation,
              { thresholdMeters: parseInt(process.env.GPS_VERIFICATION_THRESHOLD || '200') }
            );

            gpsDistanceMeters = verificationResult.distanceMeters;
            gpsVerificationStatus = verificationResult.flagForReview ? 'flagged' : 'verified';
          }
        } catch (error) {
          console.error('Error calculating GPS verification:', error);
          // Continue with pending status if verification fails
        }
      }
    }

    // Check if this is an update (multi-visit scenario) or new record
    let responseId: number | undefined;
    let isUpdate = false;
    let finalSurveyNumber = surveyNumber;

    if (questionnaireId) {
      // Check if record exists for this questionnaire_id + cycle_id
      const existingQuery = `
        SELECT response_id, survey_number, visit_count 
        FROM survey_response 
        WHERE questionnaire_id = $1 AND survey_cycle_id = $2
        LIMIT 1
      `;
      const existingResult = await client.query(existingQuery, [questionnaireId, activeCycle.cycle_id]);

      if (existingResult.rows.length > 0) {
        // Update existing record (multi-visit scenario)
        isUpdate = true;
        responseId = existingResult.rows[0].response_id;
        finalSurveyNumber = existingResult.rows[0].survey_number;
        const currentVisitCount = existingResult.rows[0].visit_count || 1;

        // Map gender values to match database enum
        let genderValue = respondentDemographics?.gender || null;
        if (genderValue === "LGBTQI+") {
          genderValue = "LGBTQI";
        } else if (genderValue === "Prefer not to say") {
          genderValue = "PreferNotToSay";
        }

        // Update the existing record
        const updateQuery = `
          UPDATE survey_response SET
            respondent_name = $1,
            respondent_age = $2,
            respondent_gender = $3,
            respondent_educational_attainment = $4,
            respondent_household_income = $5,
            respondent_purok = $6,
            location_lat = $7,
            location_lng = $8,
            location_address = $9,
            location_accuracy = $10,
            location_timestamp = $11,
            location_barangay = $12,
            location_municipality = $13,
            location_province = $14,
            verification_location = $15,
            gps_verification_status = $16,
            gps_distance_meters = $17,
            status = $18,
            progress = $19,
            visit_count = $20,
            completed_at = NOW(),
            submitted_at = NOW(),
            updated_at = NOW()
          WHERE response_id = $21
        `;

        await client.query(updateQuery, [
          selectedMember,
          respondentDemographics?.age || null,
          genderValue,
          respondentDemographics?.educationalAttainment || null,
          respondentDemographics?.householdIncome || null,
          respondentDemographics?.purok || null,
          parseFloat(location.lat),
          parseFloat(location.lng),
          location.address,
          location.accuracy ? parseFloat(location.accuracy) : null,
          location.timestamp ? new Date(location.timestamp) : null,
          location.barangay,
          location.municipality,
          location.province,
          verificationLocationJson ? JSON.stringify(verificationLocationJson) : null,
          gpsVerificationStatus,
          gpsDistanceMeters,
          'completed',
          100,
          currentVisitCount + 1,
          responseId
        ]);

        // Delete existing sections before re-inserting
        await client.query('DELETE FROM survey_section WHERE response_id = $1', [responseId]);
      }
    }

    if (!isUpdate) {
      // Generate survey number if not provided, using cycle-aware format
      if (!finalSurveyNumber) {
        const sequenceNumber = await getNextSurveySequence(parseInt(barangayId));
        finalSurveyNumber = await generateSurveyNumber(parseInt(barangayId), sequenceNumber);
      }

      // Create new survey response record
      const insertQuery = `
        INSERT INTO survey_response (
          survey_number, barangay_id, interviewer_id, survey_cycle_id, questionnaire_id, spot_id,
          respondent_name, respondent_age, respondent_gender, respondent_educational_attainment,
          respondent_household_income, respondent_purok, location_lat, location_lng,
          location_address, location_accuracy, location_timestamp,
          location_barangay, location_municipality, location_province,
          verification_location, gps_verification_status, gps_distance_meters,
          status, progress, visit_count, completed_at, submitted_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, NOW(), NOW(), NOW())
        RETURNING response_id
      `;
      
      // Map gender values to match database enum
      let genderValue = respondentDemographics?.gender || null;
      if (genderValue === "LGBTQI+") {
        genderValue = "LGBTQI";
      } else if (genderValue === "Prefer not to say") {
        genderValue = "PreferNotToSay";
      }

      const responseResult = await client.query(insertQuery, [
        finalSurveyNumber,
        parseInt(barangayId),
        parseInt(interviewerId),
        activeCycle.cycle_id,
        questionnaireId || null,
        spotId ? parseInt(spotId) : null,
        selectedMember,
        respondentDemographics?.age || null,
        genderValue,
        respondentDemographics?.educationalAttainment || null,
        respondentDemographics?.householdIncome || null,
        respondentDemographics?.purok || null,
        parseFloat(location.lat),
        parseFloat(location.lng),
        location.address,
        location.accuracy ? parseFloat(location.accuracy) : null,
        location.timestamp ? new Date(location.timestamp) : null,
        location.barangay,
        location.municipality,
        location.province,
        verificationLocationJson ? JSON.stringify(verificationLocationJson) : null,
        gpsVerificationStatus,
        gpsDistanceMeters,
        'completed',
        100,
        1
      ]);

      responseId = responseResult.rows[0].response_id;
    }

    // Ensure responseId is defined before proceeding
    if (!responseId) {
      return NextResponse.json(
        { error: "Failed to create or update survey response" },
        { status: 500 }
      );
    }

    // Save survey sections data (use transformed sections with standardized field names)
    if (transformedSections && typeof transformedSections === 'object') {
      for (const [sectionKey, sectionData] of Object.entries(transformedSections)) {
        if (sectionData && typeof sectionData === 'object' && 'data' in sectionData && sectionData.data) {
          const sectionInsertQuery = `
            INSERT INTO survey_section (
              response_id, section_key, section_name, status, data, started_at, completed_at, created_at
            ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), NOW())
          `;

          // Map section keys to readable names
          const sectionNames: Record<string, string> = {
            financial: 'Financial Administration',
            disaster: 'Disaster Preparedness',
            safety: 'Safety & Peace Order',
            social: 'Social Protection',
            business: 'Business Friendliness',
            environmental: 'Environmental Management',
            overall: 'Overall Satisfaction'
          };

          const sectionName = sectionNames[sectionKey] || sectionKey;

          await client.query(sectionInsertQuery, [
            responseId,
            sectionKey,
            sectionName,
            'completed',
            JSON.stringify((sectionData as any).data)
          ]);
        }
      }
    }

    // Auto-create visit record with outcome "Interview_Completed" if questionnaireId provided
    if (questionnaireId) {
      // Get current visit count for this questionnaire
      const visitCountQuery = `
        SELECT COALESCE(MAX(visit_number), 0) as max_visit
        FROM visits
        WHERE questionnaire_id = $1
      `;
      const visitCountResult = await client.query(visitCountQuery, [questionnaireId]);
      const currentMaxVisit = visitCountResult.rows[0].max_visit;
      const nextVisitNumber = currentMaxVisit + 1;

      // Only log visit if this is the first visit (no previous visits exist)
      // For callbacks, visits are already logged in the visitation log
      if (currentMaxVisit === 0) {
        // Insert visit record for first visit
        const visitInsertQuery = `
          INSERT INTO visits (
            questionnaire_id, visit_number, visit_timestamp, outcome, notes,
            location_lat, location_lng, created_at
          ) VALUES ($1, $2, NOW(), $3, $4, $5, $6, NOW())
        `;

        await client.query(visitInsertQuery, [
          questionnaireId,
          nextVisitNumber,
          'Interview_Completed',
          'First visit - Interview completed successfully',
          parseFloat(location.lat),
          parseFloat(location.lng)
        ]);

        console.log(`✅ Visit 1 logged for ${questionnaireId} on survey submission`);
      } else {
        console.log(`ℹ️ Callback interview completed for ${questionnaireId} - visit already logged`);
      }

      // Update questionnaire status to "Completed" and set visit_count to nextVisitNumber
      const updateQuestionnaireQuery = `
        UPDATE questionnaires SET
          status = $1,
          visit_count = $2,
          updated_at = NOW()
        WHERE questionnaire_id = $3
      `;

      await client.query(updateQuestionnaireQuery, ['Completed', nextVisitNumber, questionnaireId]);
    }

    // Recalculate survey target progress for the barangay in the active cycle
    // This ensures accurate counts even after deletions or updates
    await recalculateSurveyTargetProgress(client, parseInt(barangayId), activeCycle.cycle_id);

    return NextResponse.json({
      success: true,
      responseId: responseId,
      surveyNumber: finalSurveyNumber,
      cycleId: activeCycle.cycle_id,
      cycleName: activeCycle.name,
      questionnaireId: questionnaireId || null,
      isUpdate: isUpdate,
      gpsVerification: {
        status: gpsVerificationStatus,
        distanceMeters: gpsDistanceMeters,
        flagged: gpsVerificationStatus === 'flagged'
      },
      message: isUpdate ? "Survey updated successfully" : "Survey submitted successfully"
    })

  } catch (error) {
    // Requirement 3.3: Return appropriate HTTP status codes and error messages
    return handleDatabaseError(error, 'save survey response');
  } finally {
    if (client) {
      client.release();
    }
  }
}

export async function DELETE(request: NextRequest) {
  let client;
  try {
    client = await pool.connect();
    const { searchParams } = new URL(request.url)
    const responseId = searchParams.get('responseId')
    const barangayId = searchParams.get('barangayId')
    const deleteAll = searchParams.get('deleteAll')
    const confirmWord = searchParams.get('confirmWord')

    // Verify confirmation word
    if (confirmWord !== 'DELETE') {
      return NextResponse.json({ error: "Invalid confirmation word" }, { status: 400 })
    }

    if (deleteAll === 'true' && barangayId) {
      // Get active cycle for cycle-scoped deletion
      const activeCycle = await getActiveCycle();
      if (!activeCycle) {
        return NextResponse.json({ error: "No active survey cycle found" }, { status: 400 });
      }

      // Delete all responses for the barangay in the active cycle
      await client.query('DELETE FROM survey_section WHERE response_id IN (SELECT response_id FROM survey_response WHERE barangay_id = $1 AND survey_cycle_id = $2)', [parseInt(barangayId), activeCycle.cycle_id]);
      await client.query('DELETE FROM survey_metadata WHERE response_id IN (SELECT response_id FROM survey_response WHERE barangay_id = $1 AND survey_cycle_id = $2)', [parseInt(barangayId), activeCycle.cycle_id]);
      await client.query('DELETE FROM survey_answer WHERE response_id IN (SELECT response_id FROM survey_response WHERE barangay_id = $1 AND survey_cycle_id = $2)', [parseInt(barangayId), activeCycle.cycle_id]);
      await client.query('DELETE FROM survey_attachment WHERE response_id IN (SELECT response_id FROM survey_response WHERE barangay_id = $1 AND survey_cycle_id = $2)', [parseInt(barangayId), activeCycle.cycle_id]);
      await client.query('DELETE FROM survey_validation WHERE response_id IN (SELECT response_id FROM survey_response WHERE barangay_id = $1 AND survey_cycle_id = $2)', [parseInt(barangayId), activeCycle.cycle_id]);
      const result = await client.query('DELETE FROM survey_response WHERE barangay_id = $1 AND survey_cycle_id = $2', [parseInt(barangayId), activeCycle.cycle_id]);

      // Recalculate survey target progress for the active cycle
      await recalculateSurveyTargetProgress(client, parseInt(barangayId), activeCycle.cycle_id);

      return NextResponse.json({
        success: true,
        message: `Deleted ${result.rowCount} responses for barangay`,
        deletedCount: result.rowCount
      })

    } else if (responseId) {
      // Get the survey response details BEFORE deleting
      const responseQuery = 'SELECT barangay_id, survey_cycle_id FROM survey_response WHERE response_id = $1';
      const responseResult = await client.query(responseQuery, [parseInt(responseId)]);
      
      if (responseResult.rows.length === 0) {
        return NextResponse.json({ error: 'Response not found' }, { status: 404 });
      }
      
      const { barangay_id, survey_cycle_id } = responseResult.rows[0];
      
      // Delete single response
      await client.query('DELETE FROM survey_section WHERE response_id = $1', [parseInt(responseId)]);
      await client.query('DELETE FROM survey_metadata WHERE response_id = $1', [parseInt(responseId)]);
      await client.query('DELETE FROM survey_answer WHERE response_id = $1', [parseInt(responseId)]);
      await client.query('DELETE FROM survey_attachment WHERE response_id = $1', [parseInt(responseId)]);
      await client.query('DELETE FROM survey_validation WHERE response_id = $1', [parseInt(responseId)]);
      const result = await client.query('DELETE FROM survey_response WHERE response_id = $1', [parseInt(responseId)]);

      // Recalculate survey target progress for the cycle
      if (result.rowCount && result.rowCount > 0) {
        await recalculateSurveyTargetProgress(client, barangay_id, survey_cycle_id);
      }

      return NextResponse.json({
        success: true,
        message: "Response deleted successfully",
        deletedCount: result.rowCount
      })
    } else {
      return NextResponse.json({ error: "Missing responseId or barangayId parameter" }, { status: 400 })
    }

  } catch (error) {
    console.error("Error deleting survey response:", error)
    return NextResponse.json(
      { error: "Failed to delete survey response" },
      { status: 500 }
    )
  } finally {
    if (client) {
      client.release();
    }
  }
}

export async function GET(request: NextRequest) {
  let client;
  try {
    client = await pool.connect();
    const { searchParams } = new URL(request.url)
    const barangayId = searchParams.get('barangayId')
    const interviewerId = searchParams.get('interviewerId')
    const cycleId = searchParams.get('cycleId')

    // Get active cycle if no specific cycle requested
    let targetCycleId = cycleId;
    if (!targetCycleId) {
      const activeCycle = await getActiveCycle();
      if (!activeCycle) {
        return NextResponse.json({ error: "No active survey cycle found" }, { status: 400 });
      }
      targetCycleId = activeCycle.cycle_id.toString();
    }

    let whereConditions = [`sr.survey_cycle_id = $1`];
    let queryParams = [parseInt(targetCycleId)];
    let paramIndex = 2;
    
    if (barangayId) {
      whereConditions.push(`sr.barangay_id = $${paramIndex}`);
      queryParams.push(parseInt(barangayId));
      paramIndex++;
    }
    
    if (interviewerId) {
      whereConditions.push(`sr.interviewer_id = $${paramIndex}`);
      queryParams.push(parseInt(interviewerId));
      paramIndex++;
    }

    const whereClause = `WHERE ${whereConditions.join(' AND ')}`;

    const query = `
      SELECT
        sr.response_id,
        sr.survey_number,
        sr.questionnaire_id,
        sr.respondent_name,
        sr.respondent_age,
        sr.respondent_gender,
        sr.respondent_educational_attainment,
        sr.respondent_household_income,
        sr.submitted_at,
        sr.status,
        JSON_BUILD_OBJECT(
          'firstName', u."firstName",
          'lastName', u."lastName",
          'email', u.email
        ) as interviewer,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'section_name', ss.section_name,
              'data', ss.data
            )
          ) FILTER (WHERE ss.section_id IS NOT NULL),
          '[]'::json
        ) as survey_section
      FROM survey_response sr
      LEFT JOIN survey_section ss ON sr.response_id = ss.response_id
      LEFT JOIN "user" u ON sr.interviewer_id = u.id
      ${whereClause}
      GROUP BY sr.response_id, sr.survey_number, sr.questionnaire_id, sr.respondent_name, sr.respondent_age, sr.respondent_gender, sr.respondent_educational_attainment, sr.respondent_household_income, sr.submitted_at, sr.status, u."firstName", u."lastName", u.email
      ORDER BY sr.created_at DESC
    `;

    const result = await client.query(query, queryParams);
    return NextResponse.json(result.rows);

  } catch (error) {
    console.error("Error fetching survey responses:", error)
    return NextResponse.json(
      { error: "Failed to fetch survey responses" },
      { status: 500 }
    )
  } finally {
    if (client) {
      client.release();
    }
  }
}