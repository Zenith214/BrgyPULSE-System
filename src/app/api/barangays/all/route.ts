import { NextRequest, NextResponse } from "next/server";
import { Pool } from 'pg';
import { CycleAwardsService } from '@/lib/services/cycleAwardsService';
import { getActiveCycleId } from '@/utils/surveyCycleHelpers';

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

export async function GET(request: NextRequest) {
  let client;
  try {
    client = await pool.connect();
    
    const { searchParams } = new URL(request.url);
    const cycleId = searchParams.get('cycle_id');
    const includeAwards = searchParams.get('include_awards') === 'true';
    const awardeesOnly = searchParams.get('awardees_only') === 'true';
    const legacyMode = searchParams.get('legacy_mode') === 'true';

    const parsedCycleId = cycleId ? parseInt(cycleId, 10) : undefined;

    // Validate cycle_id if provided
    if (cycleId && (isNaN(parsedCycleId!) || parsedCycleId! <= 0)) {
      return NextResponse.json(
        { 
          error: 'Invalid input',
          message: 'cycle_id must be a positive integer'
        },
        { status: 400 }
      );
    }

    const targetCycleId = parsedCycleId || await getActiveCycleId();
    
    // Fetch ALL barangays with survey targets (cycle-aware)
    let barangaysQuery;
    let queryParams: any[] = [];
    
    if (targetCycleId) {
      barangaysQuery = `
        SELECT 
          b.barangay_id,
          b.barangay_name,
          b.population,
          b.households,
          b.captain,
          b.description,
          b."currentStatus",
          b.seal,
          b.seal_expiration_date,
          b.logo_url,
          CASE
            WHEN st.target > 0 THEN
              LEAST(100, ROUND(
                (COALESCE(rc.actual_count, 0)::decimal / st.target::decimal) * 100
              ))
            ELSE 0
          END AS percentage
        FROM barangay b
        LEFT JOIN survey_target st ON b.barangay_id = st.barangay_id AND st.survey_cycle_id = $1
        LEFT JOIN (
          SELECT barangay_id, COUNT(*) AS actual_count
          FROM survey_response
          WHERE survey_cycle_id = $1
            AND status IN ('completed', 'submitted')
          GROUP BY barangay_id
        ) rc ON b.barangay_id = rc.barangay_id
        WHERE b.is_active = true
        ORDER BY b.barangay_name ASC
      `;
      queryParams = [targetCycleId];
    } else {
      barangaysQuery = `
        SELECT 
          b.barangay_id,
          b.barangay_name,
          b.population,
          b.households,
          b.captain,
          b.description,
          b."currentStatus",
          b.seal,
          b.seal_expiration_date,
          b.logo_url,
          0 AS percentage
        FROM barangay b
        WHERE b.is_active = true
        ORDER BY b.barangay_name ASC
      `;
    }
    
    const result = await client.query(barangaysQuery, queryParams);
    let barangays = result.rows;

    // Fetch officers designated to each barangay
    const officersQuery = `
      SELECT 
        "barangayDesignation",
        "firstName",
        "lastName",
        email
      FROM "user"
      WHERE role = 'officer' 
        AND "barangayDesignation" IS NOT NULL
        AND LOWER(status) = 'active'
      ORDER BY "firstName", "lastName"
    `;
    const officersResult = await client.query(officersQuery);
    
    // Group officers by barangay
    const officersByBarangay = new Map<number, any[]>();
    officersResult.rows.forEach(officer => {
      const barangayId = officer.barangayDesignation;
      if (!officersByBarangay.has(barangayId)) {
        officersByBarangay.set(barangayId, []);
      }
      officersByBarangay.get(barangayId)!.push({
        firstName: officer.firstName,
        lastName: officer.lastName,
        email: officer.email,
        fullName: `${officer.firstName} ${officer.lastName}`
      });
    });

    // Get award information if needed
    let awardeeIds: number[] = [];
    let cycleAwards: any[] = [];

    if ((includeAwards || awardeesOnly) && targetCycleId) {
      if (includeAwards) {
        // Get detailed award information
        cycleAwards = await CycleAwardsService.getCycleAwards(targetCycleId);
        console.log(`📊 Fetched ${cycleAwards.length} cycle awards for cycle ${targetCycleId}`);
        console.log('🎯 Award data:', cycleAwards.map(a => ({ barangay_id: a.barangay_id, is_awardee: a.is_awardee })));
      } else {
        // Just get awardee IDs for filtering
        awardeeIds = await CycleAwardsService.getAwardeeBarangayIds(targetCycleId);
      }
    }

    // Create award lookup map for efficient access
    const awardMap = new Map();
    if (includeAwards && cycleAwards.length > 0) {
      cycleAwards.forEach(award => {
        awardMap.set(award.barangay_id, {
          isAwardee: award.is_awardee,
          awardedDate: award.awarded_date,
          notes: award.notes,
          awardId: award.id
        });
      });
    }

    // Transform the data to match frontend expectations
    let transformedBarangays = barangays.map((barangay: any) => {
      const progress = parseInt(barangay.percentage) || 0;
      
      let status = "Pending";
      if (progress === 100) {
        status = "Completed";
      } else if (progress > 0) {
        status = "In Progress";
      }

      const officers = officersByBarangay.get(barangay.barangay_id) || [];
      
      const baseBarangay: any = {
        id: barangay.barangay_id, // Transform barangay_id to id
        barangay_id: barangay.barangay_id, // Keep original for updates
        name: barangay.barangay_name, // Transform barangay_name to name
        progress: progress,
        status: status,
        population: barangay.population || 0,
        households: barangay.households || 0,
        captain: barangay.captain,
        officers: officers, // Add officers array
        description: barangay.description,
        currentStatus: barangay.currentStatus || status,
        seal: barangay.seal, // Keep for backward compatibility
        seal_expiration_date: barangay.seal_expiration_date,
        logo_url: barangay.logo_url,
        history: [] // Add empty history for now
      };

      // Add cycle-aware award information if requested
      if (includeAwards && targetCycleId) {
        const awardInfo = awardMap.get(barangay.barangay_id);
        baseBarangay.awardStatus = awardInfo ? {
          isAwardee: awardInfo.isAwardee,
          awardedDate: awardInfo.awardedDate,
          notes: awardInfo.notes,
          awardId: awardInfo.awardId,
          cycleId: targetCycleId
        } : {
          isAwardee: false,
          awardedDate: null,
          notes: null,
          awardId: null,
          cycleId: targetCycleId
        };
        // Also set the direct isAwardee flag for convenience
        baseBarangay.isAwardee = awardInfo?.isAwardee || false;
      }

      return baseBarangay;
    });

    // Filter for awardees only if requested
    if (awardeesOnly && targetCycleId) {
      if (includeAwards) {
        // Filter based on award status in the formatted data
        transformedBarangays = transformedBarangays.filter(barangay => 
          barangay.awardStatus?.isAwardee === true
        );
      } else {
        // Filter based on awardee IDs
        transformedBarangays = transformedBarangays.filter(barangay => 
          awardeeIds.includes(barangay.id)
        );
      }
    }

    return NextResponse.json({
      success: true,
      data: transformedBarangays,
      meta: {
        cycle_id: targetCycleId,
        include_awards: includeAwards,
        awardees_only: awardeesOnly,
        legacy_mode: legacyMode,
        total_count: transformedBarangays.length
      }
    });
  } catch (error: any) {
    console.error('Error fetching all barangays:', error);
    return NextResponse.json(
      { message: 'Failed to fetch barangays', error: error.message },
      { status: 500 }
    );
  } finally {
    if (client) {
      client.release();
    }
  }
}

export async function PUT(req: Request) {
  let client;
  try {
    client = await pool.connect();
    const body = await req.json();
    const { barangayId, ...updates } = body;

    console.log('Received update request:', { barangayId, updates });

    if (!barangayId) {
      return NextResponse.json(
        { message: 'Barangay ID is required' },
        { status: 400 }
      );
    }

    // Map frontend field names to database field names
    const updateFields = [];
    const values = [parseInt(barangayId)];
    let paramIndex = 2;
    
    if (updates.name !== undefined) {
      updateFields.push(`barangay_name = $${paramIndex}`);
      values.push(updates.name);
      paramIndex++;
    }
    if (updates.seal !== undefined) {
      updateFields.push(`seal = $${paramIndex}`);
      values.push(updates.seal);
      paramIndex++;
    }
    if (updates.seal_expiration_date !== undefined) {
      updateFields.push(`seal_expiration_date = $${paramIndex}`);
      // Handle empty string dates by converting to null
      const dateValue = updates.seal_expiration_date === '' ? null : updates.seal_expiration_date;
      values.push(dateValue);
      paramIndex++;
    }
    if (updates.description !== undefined) {
      updateFields.push(`description = $${paramIndex}`);
      values.push(updates.description);
      paramIndex++;
    }
    if (updates.population !== undefined) {
      updateFields.push(`population = $${paramIndex}`);
      values.push(updates.population);
      paramIndex++;
    }
    if (updates.households !== undefined) {
      updateFields.push(`households = $${paramIndex}`);
      values.push(updates.households);
      paramIndex++;
    }
    if (updates.captain !== undefined) {
      updateFields.push(`captain = $${paramIndex}`);
      values.push(updates.captain);
      paramIndex++;
    }
    if (updates.currentStatus !== undefined) {
      updateFields.push(`"currentStatus" = $${paramIndex}`);
      values.push(updates.currentStatus);
      paramIndex++;
    }
    if (updates.is_active !== undefined) {
      updateFields.push(`is_active = $${paramIndex}`);
      values.push(updates.is_active);
      paramIndex++;
    }
    if (updates.logo_url !== undefined) {
      updateFields.push(`logo_url = $${paramIndex}`);
      values.push(updates.logo_url);
      paramIndex++;
    }

    console.log('Mapped update data:', updateFields, values);

    const query = `UPDATE barangay SET ${updateFields.join(', ')} WHERE barangay_id = $1 RETURNING *`;
    const result = await client.query(query, values);

    if (result.rows.length === 0) {
      throw new Error('Failed to update barangay');
    }

    const updatedBarangay = result.rows[0];

    // Transform response to match frontend expectations
    const transformedResponse = {
      id: updatedBarangay.barangay_id,
      barangay_id: updatedBarangay.barangay_id,
      name: updatedBarangay.barangay_name,
      seal: updatedBarangay.seal,
      seal_expiration_date: updatedBarangay.seal_expiration_date,
      description: updatedBarangay.description,
      population: updatedBarangay.population,
      households: updatedBarangay.households,
      captain: updatedBarangay.captain,
      currentStatus: updatedBarangay.currentStatus,
      is_active: updatedBarangay.is_active,
      logo_url: updatedBarangay.logo_url
    };

    console.log('Update successful:', transformedResponse);
    return NextResponse.json(transformedResponse);
  } catch (error: any) {
    console.error('Error updating barangay:', error);
    return NextResponse.json(
      { message: 'Failed to update barangay', error: error.message },
      { status: 500 }
    );
  } finally {
    if (client) {
      client.release();
    }
  }
}

export async function DELETE(req: Request) {
  let client;
  try {
    client = await pool.connect();
    const { searchParams } = new URL(req.url);
    const barangayId = searchParams.get('id');

    console.log('Received delete request for barangay ID:', barangayId);

    if (!barangayId) {
      return NextResponse.json(
        { message: 'Barangay ID is required' },
        { status: 400 }
      );
    }

    // First check if barangay exists
    const checkQuery = 'SELECT barangay_id, barangay_name FROM barangay WHERE barangay_id = $1';
    const checkResult = await client.query(checkQuery, [parseInt(barangayId)]);
    
    if (checkResult.rows.length === 0) {
      return NextResponse.json(
        { message: 'Barangay not found' },
        { status: 404 }
      );
    }

    // Soft delete by setting is_active to false
    const deleteQuery = 'UPDATE barangay SET is_active = false WHERE barangay_id = $1 RETURNING barangay_id, barangay_name';
    const result = await client.query(deleteQuery, [parseInt(barangayId)]);

    if (result.rows.length === 0) {
      throw new Error('Failed to delete barangay');
    }

    console.log('Delete successful for barangay:', result.rows[0].barangay_name);
    return NextResponse.json({ 
      message: 'Barangay deleted successfully',
      deletedBarangay: result.rows[0]
    });
  } catch (error: any) {
    console.error('Error deleting barangay:', error);
    return NextResponse.json(
      { message: 'Failed to delete barangay', error: error.message },
      { status: 500 }
    );
  } finally {
    if (client) {
      client.release();
    }
  }
}