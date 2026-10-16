import { NextRequest, NextResponse } from 'next/server'
import { Pool } from 'pg'
import { getActiveCycleId } from '@/utils/surveyCycleHelpers'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

// Helper function to calculate need for action from binary questions
async function calculateBarangayNeedForAction(client: any, barangayId: number, cycleId: number): Promise<number> {
  // Get all survey sections for this barangay
  const query = `
    SELECT 
      ss.section_key,
      ss.data
    FROM survey_response sr
    LEFT JOIN survey_section ss ON sr.response_id = ss.response_id
    WHERE sr.barangay_id = $1 
      AND sr.survey_cycle_id = $2 
      AND sr.status IN ('completed', 'submitted')
      AND ss.section_key IN ('financial', 'disaster', 'safety', 'social', 'business', 'environmental')
  `
  
  const result = await client.query(query, [barangayId, cycleId])
  
  if (result.rows.length === 0) {
    return 0
  }
  
  // Count respondents who answered "Yes" to any need_for_action_binary question
  const respondentsWithNeed = new Set<number>()
  let totalRespondents = 0
  
  result.rows.forEach((row: any) => {
    if (row.data) {
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
      
      // Look for need_for_action_binary fields
      Object.keys(data).forEach(key => {
        if (key.startsWith('need_for_action_binary_')) {
          const answer = String(data[key]).toLowerCase().trim()
          if (answer === 'yes' || answer === 'oo') {
            respondentsWithNeed.add(row.response_id)
          }
        }
      })
    }
  })
  
  // Get total unique respondents for this barangay
  const totalQuery = `
    SELECT COUNT(DISTINCT response_id) as total
    FROM survey_response
    WHERE barangay_id = $1 
      AND survey_cycle_id = $2 
      AND status IN ('completed', 'submitted')
  `
  const totalResult = await client.query(totalQuery, [barangayId, cycleId])
  totalRespondents = parseInt(totalResult.rows[0]?.total || 0)
  
  // Need for Action % = (Count with Need / Total Respondents) × 100
  return totalRespondents > 0 ? Math.round((respondentsWithNeed.size / totalRespondents) * 100) : 0
}

// Helper function to calculate satisfaction from survey responses
async function calculateBarangaySatisfaction(client: any, barangayId: number, cycleId: number): Promise<number> {
  // Get the overall satisfaction from the "overall" section
  const overallQuery = `
    SELECT 
      ss.data->>'overallSatisfaction' as overall_satisfaction
    FROM survey_response sr
    LEFT JOIN survey_section ss ON sr.response_id = ss.response_id
    WHERE sr.barangay_id = $1 
      AND sr.survey_cycle_id = $2 
      AND sr.status IN ('completed', 'submitted')
      AND ss.section_key = 'overall'
      AND ss.data->>'overallSatisfaction' IS NOT NULL
  `
  
  const result = await client.query(overallQuery, [barangayId, cycleId])
  
  if (result.rows.length === 0) {
    return 0
  }
  
  // Calculate satisfaction using count-based approach
  // Count respondents who are satisfied (rating >= 4 or "Yes")
  let satisfiedCount = 0
  let totalCount = 0
  
  result.rows.forEach((row: any) => {
    const satisfactionStr = row.overall_satisfaction
    if (satisfactionStr) {
      const satisfactionValue = String(satisfactionStr).toLowerCase();
      totalCount++
      
      // Check if it's the new binary format
      if (satisfactionValue.includes('yes') || satisfactionValue.includes('oo')) {
        // Binary "Yes" = satisfied
        satisfiedCount++
      } else if (satisfactionValue.includes('no') || satisfactionValue.includes('hindi')) {
        // Binary "No" = not satisfied
        // Don't increment satisfiedCount
      } else {
        // Old format: Extract the numeric value (first character)
        const numericValue = parseInt(satisfactionValue.charAt(0))
        if (!isNaN(numericValue) && numericValue >= 1 && numericValue <= 5) {
          // Rating >= 4 is considered satisfied
          if (numericValue >= 4) {
            satisfiedCount++
          }
        }
      }
    }
  })
  
  // Overall Satisfaction % = (Satisfied Count / Total Count) × 100
  return totalCount > 0 ? Math.round((satisfiedCount / totalCount) * 100) : 0
}

export async function GET(request: NextRequest) {
  let client: any
  try {
    client = await pool.connect()
    const activeCycleId = await getActiveCycleId()

    console.log('[Dashboard Summary] Active Cycle ID:', activeCycleId)

    if (!activeCycleId) {
      return NextResponse.json({ error: 'No active cycle' }, { status: 400 })
    }

    // Get list of barangays with completed surveys
    // First check what statuses exist
    const statusCheckQuery = `
      SELECT DISTINCT status, COUNT(*) as count
      FROM survey_response
      WHERE survey_cycle_id = $1
      GROUP BY status
    `
    const statusCheck = await client.query(statusCheckQuery, [activeCycleId])
    console.log('[Dashboard Summary] Available statuses:', statusCheck.rows)
    
    const barangaysQuery = `
      SELECT DISTINCT 
        sr.barangay_id,
        b.barangay_name,
        b.households
      FROM survey_response sr
      LEFT JOIN barangay b ON sr.barangay_id = b.barangay_id
      WHERE sr.survey_cycle_id = $1 
        AND sr.status IN ('completed', 'submitted')
      ORDER BY b.barangay_name
    `
    
    const barangaysResult = await client.query(barangaysQuery, [activeCycleId])
    const barangays = barangaysResult.rows
    
    console.log('[Dashboard Summary] Found barangays with completed surveys:', barangays.length)
    
    // Calculate satisfaction and need for action for each barangay
    const barangayScores: Array<{barangayId: number, barangayName: string, satisfaction: number, needForAction: number, responseCount: number}> = []
    let totalSatisfaction = 0
    let totalNeedForAction = 0
    
    // Minimum sample size for statistical validity (at least 30 responses recommended)
    const MIN_SAMPLE_SIZE = 30
    
    for (const barangay of barangays) {
      // Get response count for this barangay
      const countQuery = `
        SELECT COUNT(*) as count
        FROM survey_response
        WHERE barangay_id = $1 
          AND survey_cycle_id = $2 
          AND status IN ('completed', 'submitted')
      `
      const countResult = await client.query(countQuery, [barangay.barangay_id, activeCycleId])
      const responseCount = parseInt(countResult.rows[0]?.count || 0)
      
      // Only include barangays with sufficient sample size
      if (responseCount < MIN_SAMPLE_SIZE) {
        console.log(`[Dashboard Summary] Skipping ${barangay.barangay_name} - insufficient sample size (${responseCount} < ${MIN_SAMPLE_SIZE})`)
        continue
      }
      
      const satisfaction = await calculateBarangaySatisfaction(client, barangay.barangay_id, activeCycleId)
      const needForAction = await calculateBarangayNeedForAction(client, barangay.barangay_id, activeCycleId)
      
      barangayScores.push({
        barangayId: barangay.barangay_id,
        barangayName: barangay.barangay_name,
        satisfaction,
        needForAction,
        responseCount
      })
      totalSatisfaction += satisfaction
      totalNeedForAction += needForAction
    }
    
    // Sort by satisfaction
    barangayScores.sort((a, b) => b.satisfaction - a.satisfaction)
    
    // Get total responses and target
    // Target: 150 responses per survey target (barangay with survey target set)
    const statsQuery = `
      SELECT 
        COUNT(*) as total_responses,
        (SELECT COUNT(*) FROM survey_target WHERE survey_cycle_id = $1) as survey_targets_count,
        (SELECT COUNT(*) FROM barangay) as total_barangays
      FROM survey_response
      WHERE survey_cycle_id = $1 AND status IN ('completed', 'submitted')
    `
    
    const statsResult = await client.query(statsQuery, [activeCycleId])
    
    // Target: number of survey targets × 150 responses per target
    const surveyTargetsCount = parseInt(statsResult.rows[0]?.survey_targets_count || 0)
    const targetPerBarangay = 150
    const targetResponses = surveyTargetsCount * targetPerBarangay
    
    console.log('[Dashboard Summary] Survey targets:', surveyTargetsCount, 'Target per barangay:', targetPerBarangay, 'Total target:', targetResponses)
    
    // Count barangays that have finished surveys (live count >= target)
    const finishedBarangaysQuery = `
      SELECT COUNT(*) as finished_count
      FROM survey_target st
      WHERE st.survey_cycle_id = $1
        AND st.target > 0
        AND (
          SELECT COUNT(*)
          FROM survey_response sr
          WHERE sr.barangay_id = st.barangay_id
            AND sr.survey_cycle_id = st.survey_cycle_id
            AND sr.status IN ('completed', 'submitted')
        ) >= st.target
    `
    const finishedResult = await client.query(finishedBarangaysQuery, [activeCycleId])
    const finishedBarangays = parseInt(finishedResult.rows[0]?.finished_count || 0)
    
    console.log('[Dashboard Summary] Finished barangays:', finishedBarangays, 'out of', surveyTargetsCount)
    
    const kpis = {
      overallSatisfaction: barangayScores.length > 0 ? Math.round(totalSatisfaction / barangayScores.length) : 0,
      overallNeedForAction: barangayScores.length > 0 ? Math.round(totalNeedForAction / barangayScores.length) : 0,
      totalResponses: parseInt(statsResult.rows[0]?.total_responses || 0),
      targetResponses: targetResponses,
      barangaysCovered: finishedBarangays,
      totalBarangays: surveyTargetsCount
    }

    // Get top 5 and bottom 5
    const top5 = barangayScores.slice(0, 5).map(b => ({
      ...b,
      trend: 'stable' as 'up' | 'down' | 'stable'
    }))
    
    const bottom5 = barangayScores.slice(-5).reverse().map(b => ({
      ...b,
      trend: 'stable' as 'up' | 'down' | 'stable'
    }))

    // Get trend data across all cycles
    const cyclesQuery = `
      SELECT cycle_id, name, year
      FROM survey_cycle
      ORDER BY year ASC, cycle_id ASC
    `
    
    const cyclesResult = await client.query(cyclesQuery)
    const trendData = []
    
    for (const cycle of cyclesResult.rows) {
      // Get barangays with completed surveys for this cycle
      const cycleBarangaysQuery = `
        SELECT DISTINCT sr.barangay_id
        FROM survey_response sr
        WHERE sr.survey_cycle_id = $1 
          AND sr.status IN ('completed', 'submitted')
      `
      
      const cycleBarangaysResult = await client.query(cycleBarangaysQuery, [cycle.cycle_id])
      
      if (cycleBarangaysResult.rows.length > 0) {
        let cycleTotalSatisfaction = 0
        let cycleCount = 0
        
        for (const barangay of cycleBarangaysResult.rows) {
          const satisfaction = await calculateBarangaySatisfaction(client, barangay.barangay_id, cycle.cycle_id)
          if (satisfaction > 0) {
            cycleTotalSatisfaction += satisfaction
            cycleCount++
          }
        }
        
        if (cycleCount > 0) {
          trendData.push({
            cycleName: cycle.name,
            cycleYear: cycle.year,
            avgSatisfaction: Math.round(cycleTotalSatisfaction / cycleCount)
          })
        }
      }
    }

    // Service area performance - use ml_cache data if available, otherwise calculate from sections
    const serviceAreas = [
      { key: 'financial', name: 'Financial Administration' },
      { key: 'disaster', name: 'Disaster Preparedness' },
      { key: 'safety', name: 'Safety & Peace Order' },
      { key: 'social', name: 'Social Protection' },
      { key: 'business', name: 'Business Friendliness' },
      { key: 'environmental', name: 'Environmental Management' }
    ]

    // Try to get data from ml_cache first (pre-calculated metrics)
    const mlCacheQuery = `
      SELECT data
      FROM ml_cache
      WHERE cycle_id = $1
      LIMIT 1
    `
    
    const mlCacheResult = await client.query(mlCacheQuery, [activeCycleId])
    
    let serviceAreaPerformance: Array<{ serviceArea: string; avgSatisfaction: number }> = []
    
    if (mlCacheResult.rows.length > 0 && mlCacheResult.rows[0].data?.service_scores) {
      // Use pre-calculated ml_cache data
      console.log('[Dashboard Summary] Using ml_cache service scores')
      
      const serviceScores = mlCacheResult.rows[0].data.service_scores
      
      serviceAreaPerformance = serviceAreas.map(area => {
        const score = serviceScores[area.key]?.satisfaction || 0
        return {
          serviceArea: area.name,
          avgSatisfaction: Math.round(score)
        }
      })
    } else {
      // Fallback: Calculate from survey sections
      console.log('[Dashboard Summary] Calculating service area performance from survey sections')
      
      serviceAreaPerformance = await Promise.all(
        serviceAreas.map(async (area) => {
          // Get all satisfaction scores for this service area
          const satisfactionQuery = `
            SELECT ss.data
            FROM survey_response sr
            LEFT JOIN survey_section ss ON sr.response_id = ss.response_id
            WHERE sr.survey_cycle_id = $1
              AND sr.status IN ('completed', 'submitted')
              AND ss.section_key = $2
              AND ss.data IS NOT NULL
          `
          
          const result = await client.query(satisfactionQuery, [activeCycleId, area.key])
          
          console.log(`[Dashboard Summary] Service area ${area.key}: Found ${result.rows.length} responses`)
          
          let totalSatisfaction = 0
          let satisfactionCount = 0
          
          result.rows.forEach((row: any) => {
            const sectionData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
            
            // Extract all satisfaction scores from this section
            Object.keys(sectionData).forEach((key) => {
              if (key.toLowerCase().includes('satisfaction')) {
                const value = sectionData[key]
                
                // Handle different satisfaction formats
                let numericValue: number | null = null
                
                if (typeof value === 'number') {
                  numericValue = value
                } else if (typeof value === 'string') {
                  const valueStr = value.toLowerCase().trim()
                  
                  // Check for binary format (Yes/No or Oo/Hindi)
                  if (valueStr.includes('yes') || valueStr.includes('oo')) {
                    numericValue = 5 // Satisfied = 5
                  } else if (valueStr.includes('no') || valueStr.includes('hindi')) {
                    numericValue = 1 // Not satisfied = 1
                  } else {
                    // Try to extract numeric value from "N - Description" format
                    numericValue = parseInt(value.charAt(0))
                  }
                }
                
                if (numericValue !== null && !isNaN(numericValue) && numericValue >= 1 && numericValue <= 5) {
                  totalSatisfaction += (numericValue / 5) * 100
                  satisfactionCount++
                }
              }
            })
          })
          
          const avgSatisfaction = satisfactionCount > 0 
            ? Math.round(totalSatisfaction / satisfactionCount) 
            : 0
          
          console.log(`[Dashboard Summary] Service area ${area.key}: ${satisfactionCount} satisfaction scores, avg: ${avgSatisfaction}%`)
          
          return {
            serviceArea: area.name,
            avgSatisfaction
          }
        })
      )
    }

    return NextResponse.json({
      kpis,
      leaderboard: { top5, bottom5 },
      trendData,
      serviceAreaPerformance
    })

  } catch (error) {
    console.error('[Dashboard Summary] Error:', error)
    return NextResponse.json(
      { 
        error: 'Failed to fetch dashboard summary',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  } finally {
    if (client) client.release()
  }
}
