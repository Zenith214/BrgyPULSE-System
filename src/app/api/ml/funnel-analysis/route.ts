import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { supabaseAdmin } from '@/lib/supabase';
import { getCachedOrCompute } from '@/lib/ml-cache';
import { calculateServiceFunnelMetrics, ServiceFunnelMetrics } from '@/lib/funnel-calculations';

const execAsync = promisify(exec);

// Increase timeout for ML analysis routes (60 seconds)
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const barangayId = searchParams.get('barangayId');
    const cycleId = searchParams.get('cycleId');
    const forceRefresh = searchParams.get('refresh') === 'true';

    console.log(`\n🚀 [ML FUNNEL] API called - Barangay ${barangayId}, Cycle ${cycleId}`);

    if (!barangayId) {
      return NextResponse.json(
        { error: "barangayId parameter is required" },
        { status: 400 }
      );
    }

    if (!cycleId) {
      console.log(`⚠️ [ML FUNNEL] Missing cycleId parameter`);
      return NextResponse.json(
        { error: "cycleId parameter is required" },
        { status: 400 }
      );
    }

    // Check if survey is complete by counting actual completed/submitted responses
    // against the target — avoids reading the stale survey_target.percentage column.
    const { data: surveyTargetData, error: targetError } = await supabaseAdmin
      .from('survey_target')
      .select('target')
      .eq('barangay_id', barangayId)
      .eq('survey_cycle_id', cycleId)
      .single();

    if (targetError && targetError.code !== 'PGRST116') {
      console.error('Error checking survey target:', targetError);
    }

    // Live count of completed/submitted responses
    const { count: actualCount } = await supabaseAdmin
      .from('survey_response')
      .select('*', { count: 'exact', head: true })
      .eq('barangay_id', barangayId)
      .eq('survey_cycle_id', cycleId)
      .in('status', ['completed', 'submitted']);

    const target = surveyTargetData?.target || 0;
    const achieved = actualCount || 0;
    const progress = target > 0 ? Math.min(100, Math.round((achieved / target) * 100)) : 0;

    // If survey is not complete, return a special response
    if (progress < 100) {
      console.log(`⏳ [ML FUNNEL] Survey incomplete (${progress}%)`);
      return NextResponse.json({
        surveyIncomplete: true,
        progress: progress,
        message: `Survey is ${progress}% complete. ML analysis will be available when survey reaches 100% completion.`,
        barangay_id: parseInt(barangayId),
        cycle_id: parseInt(cycleId)
      });
    }

    // Use caching with 12-hour TTL for funnel analysis
    const result = await getCachedOrCompute(
      'ml-funnel-analysis',
      { barangayId: parseInt(barangayId), cycleId: parseInt(cycleId) },
      async () => {

        let mlResults;

        // Check if ML_API_URL is configured (for Railway/production)
        let mlApiUrl = process.env.ML_API_URL;
        
        if (mlApiUrl) {
          // Ensure URL has protocol
          if (!mlApiUrl.startsWith('http://') && !mlApiUrl.startsWith('https://')) {
            mlApiUrl = `https://${mlApiUrl}`;
          }
          
          // Remove trailing slash to avoid double slashes
          mlApiUrl = mlApiUrl.replace(/\/$/, '');
          
          // Use HTTP API call to separate ML service
          try {
            const response = await fetch(`${mlApiUrl}/api/analyze`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                barangay_id: parseInt(barangayId),
                cycle_id: parseInt(cycleId)
              })
            });

            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(`ML API returned ${response.status}: ${errorText}`);
            }

            mlResults = await response.json();
          } catch (fetchError: any) {
            console.error('❌ [ML FUNNEL] Failed to call ML API:', fetchError.message);
            throw new Error(`Failed to connect to ML service: ${fetchError.message}`);
          }
        } else {
          // Fall back to local Python execution (for local development)
          const mlScriptPath = path.join(process.cwd(), 'ml', 'analyze_barangay.py');
          const venvPython = process.platform === 'win32' 
            ? path.join(process.cwd(), '.venv', 'Scripts', 'python.exe')
            : path.join(process.cwd(), '.venv', 'bin', 'python');
          const pythonCommand = `"${venvPython}" "${mlScriptPath}" --barangay_id ${barangayId} --cycle_id ${cycleId}`;

          const { stdout, stderr } = await execAsync(pythonCommand);

          if (stderr) {
            console.error('ML Analysis Error:', stderr);
          }

          try {
            mlResults = JSON.parse(stdout);
          } catch (parseError) {
            console.error('Failed to parse ML results:', parseError);
            throw new Error("Failed to parse ML analysis results");
          }
        }

        // Transform ML results into funnel analysis format
        return await transformMLToFunnelFormat(mlResults, parseInt(barangayId), parseInt(cycleId));
      },
      {
        ttl: 43200, // 12 hours
        staleWhileRevalidate: true,
        forceRefresh
      }
    );

    // Add cache metadata to response
    const responseData = result.data;

    // If the cached result has no service scores (stale empty result from before the
    // local-fallback was added), force a fresh computation and discard this cache hit.
    if (
      result.cached &&
      responseData &&
      Object.keys(responseData.service_scores || {}).length === 0 &&
      !forceRefresh
    ) {
      console.warn(`⚠️ [ML FUNNEL] Cached result has empty service_scores — forcing refresh`);
      const freshResult = await getCachedOrCompute(
        'ml-funnel-analysis',
        { barangayId: parseInt(barangayId), cycleId: parseInt(cycleId) },
        async () => {
          let mlResults;
          let mlApiUrl = process.env.ML_API_URL;
          if (mlApiUrl) {
            if (!mlApiUrl.startsWith('http://') && !mlApiUrl.startsWith('https://')) mlApiUrl = `https://${mlApiUrl}`;
            mlApiUrl = mlApiUrl.replace(/\/$/, '');
            try {
              const r = await fetch(`${mlApiUrl}/api/analyze`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ barangay_id: parseInt(barangayId!), cycle_id: parseInt(cycleId!) })
              });
              mlResults = r.ok ? await r.json() : {};
            } catch { mlResults = {}; }
          } else {
            mlResults = {};
          }
          return await transformMLToFunnelFormat(mlResults, parseInt(barangayId!), parseInt(cycleId!));
        },
        { ttl: 43200, staleWhileRevalidate: true, forceRefresh: true }
      );
      const response = {
        ...freshResult.data,
        _cache: { cached: false, stale: false, computedAt: freshResult.computedAt, expiresAt: freshResult.expiresAt }
      };
      return NextResponse.json(response);
    }

    const response = {
      ...responseData,
      _cache: {
        cached: result.cached,
        stale: result.stale,
        computedAt: result.computedAt,
        expiresAt: result.expiresAt
      }
    };

    return NextResponse.json(response);

  } catch (error) {
    console.error("Error in ML funnel analysis:", error);
    return NextResponse.json(
      { error: "Failed to perform ML funnel analysis" },
      { status: 500 }
    );
  }
}

async function transformMLToFunnelFormat(mlResults: any, barangayId: number, cycleId: number) {
  const serviceAreas = ['financial', 'disaster', 'safety', 'social', 'business', 'environmental'];

  console.log(`📊 [ML FUNNEL] Overall satisfaction from ML results: ${mlResults.overall_satisfaction}`);

  const funnelData: any = {
    barangay_id: barangayId,
    total_responses: mlResults.total_responses || 0,
    overall_satisfaction: mlResults.overall_satisfaction || 0,
    service_scores: {},
    action_grid: {},
    ml_insights: mlResults.insights || {},
    recommendations: mlResults.recommendations || {},
    data_quality: mlResults.data_quality || {}
  };

  console.log(`📊 [ML FUNNEL] Funnel data overall_satisfaction: ${funnelData.overall_satisfaction}`);

  // Transform service scores from ML format to funnel format
  const satisfactionScores: number[] = [];

  if (mlResults.service_scores) {
    Object.entries(mlResults.service_scores).forEach(([serviceKey, scores]: [string, any]) => {
      // Map ML service keys to our standard service areas
      const mappedKey = mapServiceKey(serviceKey);
      if (mappedKey && serviceAreas.includes(mappedKey)) {
        // Check if scores are in new structured format (with count, total, percentage)
        // or old format (just percentages)
        const isStructuredFormat = scores.awareness && typeof scores.awareness === 'object' && 'percentage' in scores.awareness;
        
        let serviceScores;
        if (isStructuredFormat) {
          // New structured format from Python ML
          serviceScores = {
            awareness: scores.awareness.percentage || 0,
            availment: scores.availment.percentage || 0,
            satisfaction: scores.satisfaction.percentage || 0,
            need_action: scores.need_action_score || 0,
            // Include structured data for detailed analysis
            awareness_metrics: scores.awareness,
            availment_metrics: scores.availment,
            satisfaction_metrics: scores.satisfaction
          };
        } else {
          // Old format (backward compatibility)
          serviceScores = {
            awareness: scores.awareness_score || 0,
            availment: scores.availment_score || 0,
            satisfaction: scores.satisfaction_score || 0,
            need_action: scores.need_action_score || 0
          };
        }

        // Collect satisfaction scores for overall calculation
        satisfactionScores.push(serviceScores.satisfaction);

        funnelData.service_scores[mappedKey] = {
          ...serviceScores,
          sample_size: scores.sample_size || 0,
          confidence: scores.sample_size >= 5 ? 'high' : scores.sample_size >= 3 ? 'medium' : 'low',
          bottleneck: identifyBottleneck(scores),
          concerns: extractConcerns(mlResults, mappedKey, serviceScores),
          quotes: extractQuotes(mlResults, mappedKey, serviceScores),
          recommendations: extractRecommendations(mlResults, mappedKey, serviceScores)
        };
      }
    });
  }

  // ─── Local fallback when ML service returns no service scores ───────────────
  // This happens when the Railway ML service has no data for this barangay/cycle
  // or returns an empty payload. We compute scores directly from survey_section rows
  // using the same TypeScript funnel-calculation logic used elsewhere in the app.
  if (Object.keys(funnelData.service_scores).length === 0) {
    console.warn(`⚠️ [ML FUNNEL] ML returned no service scores for barangay ${barangayId} / cycle ${cycleId} — falling back to local calculation`);

    // Fetch all completed responses with their sections for this barangay/cycle
    const { data: rawResponses } = await supabaseAdmin
      .from('survey_response')
      .select(`
        response_id,
        survey_section (section_key, data)
      `)
      .eq('barangay_id', barangayId)
      .eq('survey_cycle_id', cycleId)
      .in('status', ['completed', 'submitted']);

    if (rawResponses && rawResponses.length > 0) {
      funnelData.total_responses = rawResponses.length;

      for (const serviceArea of serviceAreas) {
        // Filter to responses that have a section for this service area
        const responsesForArea = rawResponses.filter((r: any) => {
          const sections = Array.isArray(r.survey_section) ? r.survey_section : [r.survey_section];
          return sections.some((s: any) => s?.section_key === serviceArea);
        });

        if (responsesForArea.length === 0) continue;

        const metrics = calculateServiceFunnelMetrics(responsesForArea, serviceArea);

        const satisfactionPct = metrics.satisfaction.percentage ?? 0;
        const needActionPct   = metrics.needForAction?.percentage ?? 0;
        const awarenessPct    = metrics.awareness.percentage ?? 0;
        const availmentPct    = metrics.availment.percentage ?? 0;
        const sampleSize      = metrics.awareness.total;

        funnelData.service_scores[serviceArea] = {
          awareness:    awarenessPct,
          availment:    availmentPct,
          satisfaction: satisfactionPct,
          need_action:  needActionPct,
          sample_size:  sampleSize,
          confidence:   sampleSize >= 5 ? 'high' : sampleSize >= 3 ? 'medium' : 'low',
          bottleneck:   awarenessPct < availmentPct && awarenessPct < satisfactionPct
                          ? 'awareness' : availmentPct < satisfactionPct
                          ? 'availment' : 'satisfaction',
          concerns:        [],
          quotes:          {},
          recommendations: {}
        };

        if (metrics.actionGrid) {
          funnelData.action_grid[serviceArea] = {
            quadrant:           metrics.actionGrid.quadrant,
            satisfaction_score: satisfactionPct,
            need_action_score:  needActionPct,
            confidence:         sampleSize >= 5 ? 'high' : 'medium',
            trend: { change: 0, direction: 'baseline', available: false }
          };
        } else {
          funnelData.action_grid[serviceArea] = {
            quadrant:           'INSUFFICIENT_DATA',
            satisfaction_score: satisfactionPct,
            need_action_score:  needActionPct,
            confidence:         'low',
            trend: { change: 0, direction: 'baseline', available: false }
          };
        }
      }

      console.log(`✅ [ML FUNNEL] Local fallback computed scores for ${Object.keys(funnelData.service_scores).length} service areas`);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // Calculate overall satisfaction - prefer the "overall" section score if available
  // Otherwise fall back to averaging the 6 service areas
  if (!funnelData.overall_satisfaction) {
    // Try to get the overall section satisfaction score from the database
    // IMPORTANT: Filter by barangay_id and cycle_id to get only this barangay's data
    try {
      const { data: overallSectionData } = await supabaseAdmin
        .from('survey_section')
        .select('data, response:survey_response!inner(barangay_id, survey_cycle_id)')
        .eq('section_key', 'overall')
        .eq('survey_response.barangay_id', barangayId)
        .eq('survey_response.survey_cycle_id', cycleId)
        .not('data', 'is', null);
      
      if (overallSectionData && overallSectionData.length > 0) {
        // Calculate satisfaction from overallSatisfaction field using count-based approach
        let satisfiedCount = 0;
        let totalCount = 0;
        
        overallSectionData.forEach((row: any) => {
          const data = row.data;
          if (data && data.overallSatisfaction) {
            const satisfactionValue = String(data.overallSatisfaction).toLowerCase();
            totalCount++;
            
            // Check if it's the new binary format
            if (satisfactionValue.includes('yes') || satisfactionValue.includes('oo')) {
              // Binary "Yes" = satisfied
              satisfiedCount++;
            } else if (satisfactionValue.includes('no') || satisfactionValue.includes('hindi')) {
              // Binary "No" = not satisfied
              // Don't increment satisfiedCount
            } else {
              // Old format: Extract numeric value from format like "5 - Very Satisfied / Lubos na Nasiyahan"
              const numericValue = parseInt(satisfactionValue.charAt(0));
              if (!isNaN(numericValue) && numericValue >= 1 && numericValue <= 5) {
                // Rating >= 4 is considered satisfied
                if (numericValue >= 4) {
                  satisfiedCount++;
                }
              }
            }
          }
        });
        
        if (totalCount > 0) {
          // Overall Satisfaction % = (Number Satisfied / Total Sample Size) × 100
          funnelData.overall_satisfaction = Math.round((satisfiedCount / totalCount) * 1000) / 10;
          console.log(`📊 [ML FUNNEL] Using overall section satisfaction: ${funnelData.overall_satisfaction}% (${satisfiedCount} satisfied out of ${totalCount} responses for barangay ${barangayId}, cycle ${cycleId})`);
        }
      }
    } catch (error) {
      console.error('Error fetching overall section data:', error);
    }
    
    // NOTE: We do NOT fall back to averaging service scores if overall section is not available
    // because service satisfaction uses (satisfied / availed) while overall satisfaction uses
    // (satisfied / total_sample_size). These are fundamentally different metrics and cannot be averaged.
    // If overall section data is missing, overall_satisfaction will remain 0 or from ML results.
  }

  // Transform action grid from ML format
  if (mlResults.action_grid) {
    for (const [serviceKey, grid] of Object.entries(mlResults.action_grid)) {
      const mappedKey = mapServiceKey(serviceKey);
      if (mappedKey && serviceAreas.includes(mappedKey)) {
        const trend = await calculateTrend(mlResults, mappedKey, barangayId, cycleId, funnelData.service_scores[mappedKey]);
        funnelData.action_grid[mappedKey] = {
          quadrant: (grid as any).quadrant || 'INSUFFICIENT_DATA',
          satisfaction_score: (grid as any).satisfaction_score || 0,
          need_action_score: (grid as any).need_action_score || 0,
          confidence: (grid as any).confidence || 'low',
          trend: trend
        };
      }
    }
  }

  return funnelData;
}

function mapServiceKey(mlServiceKey: string): string | null {
  const keyMappings: { [key: string]: string } = {
    'financial_administration': 'financial',
    'financial': 'financial',
    'disaster_preparedness': 'disaster',
    'disaster': 'disaster',
    'safety_peace_order': 'safety',
    'safety': 'safety',
    'social_protection': 'social',
    'social': 'social',
    'business_friendliness': 'business',
    'business': 'business',
    'environmental_management': 'environmental',
    'environmental': 'environmental'
  };

  return keyMappings[mlServiceKey.toLowerCase()] || null;
}

function identifyBottleneck(scores: any): string {
  // Handle both structured format (with percentage field) and old format
  const awareness = scores.awareness?.percentage ?? scores.awareness_score ?? 0;
  const availment = scores.availment?.percentage ?? scores.availment_score ?? 0;
  const satisfaction = scores.satisfaction?.percentage ?? scores.satisfaction_score ?? 0;

  // Find the lowest score to identify bottleneck
  if (awareness < availment && awareness < satisfaction) {
    return 'awareness';
  } else if (availment < satisfaction) {
    return 'availment';
  } else {
    return 'satisfaction';
  }
}

function extractConcerns(mlResults: any, serviceArea: string, scores: any): string[] {
  // Extract concerns from ML insights
  const concerns = mlResults.insights?.[serviceArea]?.concerns || [];

  if (concerns.length > 0) {
    return concerns.slice(0, 3);
  }

  // Generate deterministic concerns based on service area and scores
  const serviceScores = mlResults.service_scores?.[serviceArea] || {};
  const awareness = serviceScores.awareness_score || 0;
  const availment = serviceScores.availment_score || 0;
  const satisfaction = serviceScores.satisfaction_score || 0;

  // Use score-based selection for deterministic concerns
  const concernPools: { [key: string]: string[] } = {
    financial: [
      'Budget transparency needs improvement',
      'Slow processing of financial assistance',
      'Limited information about available programs',
      'Need better communication of budget allocations',
      'Improve accessibility of financial reports',
      'Streamline application procedures'
    ],
    disaster: [
      'Need early warning systems',
      'Insufficient evacuation centers',
      'Lack of emergency supplies',
      'Improve disaster preparedness training',
      'Better coordination with emergency services',
      'Upgrade emergency communication systems'
    ],
    safety: [
      'Poor street lighting',
      'Need more police patrols',
      'Install CCTV cameras',
      'Improve response time to incidents',
      'Strengthen community watch programs',
      'Better coordination with law enforcement'
    ],
    social: [
      'Need more healthcare services',
      'Educational support programs',
      'Senior citizen assistance',
      'Expand social welfare programs',
      'Improve access to health facilities',
      'Strengthen family support services'
    ],
    business: [
      'Complicated permit processes',
      'High fees and requirements',
      'Lack of business support programs',
      'Simplify business registration',
      'Reduce processing time for permits',
      'Provide business development assistance'
    ],
    environmental: [
      'Poor waste collection',
      'Need more recycling programs',
      'Water quality issues',
      'Improve waste segregation compliance',
      'Expand environmental education',
      'Better enforcement of environmental regulations'
    ]
  };

  const pool = concernPools[serviceArea] || concernPools.financial;
  const scoreBasedIndex = Math.floor((awareness + availment + satisfaction) / 100 * pool.length) % pool.length;

  return [
    pool[scoreBasedIndex],
    pool[(scoreBasedIndex + 1) % pool.length],
    pool[(scoreBasedIndex + 2) % pool.length]
  ];
}

function extractQuotes(mlResults: any, serviceArea: string, scores: any): any {
  // Extract quotes from ML results or use score-based selection for deterministic quotes
  const quotes = mlResults.insights?.[serviceArea]?.quotes || {};

  if (Object.keys(quotes).length > 0) {
    return quotes;
  }

  // Use score-based selection for deterministic quotes
  const awarenessQuotes: { [key: string]: string[] } = {
    financial: [
      "I didn't know about the financial assistance programs available.",
      "More information campaigns needed about available services.",
      "We need better communication about budget allocations.",
      "Many residents are unaware of social programs.",
      "Information about services should be more accessible."
    ],
    disaster: [
      "We need more information about disaster preparedness programs.",
      "Not everyone knows where the evacuation centers are.",
      "Better awareness campaigns about emergency procedures needed.",
      "More residents should know about disaster response plans.",
      "Information about emergency services is lacking."
    ],
    safety: [
      "Everyone knows about the safety programs.",
      "Most residents are aware of security measures.",
      "Information about safety services is well-distributed.",
      "Community is well-informed about peace and order programs.",
      "Awareness of safety initiatives is high."
    ],
    social: [
      "Most people know about social services available.",
      "Information about health programs is widespread.",
      "Many are aware of social welfare assistance.",
      "Community knows about available support services.",
      "Social program awareness is generally good."
    ],
    business: [
      "Many don't know about business support programs.",
      "Information about permits and clearances is unclear.",
      "Business owners need more guidance on requirements.",
      "Awareness of business assistance is low.",
      "Better information dissemination for entrepreneurs needed."
    ],
    environmental: [
      "People know about environmental programs but participation is low.",
      "Awareness of waste management rules is moderate.",
      "More education about environmental protection needed.",
      "Community knows about recycling but needs encouragement.",
      "Environmental awareness campaigns should continue."
    ]
  };

  const availmentQuotes: { [key: string]: string[] } = {
    financial: [
      "The application process is too complicated and takes too long.",
      "Access to financial assistance is difficult.",
      "Processing of applications needs improvement.",
      "Too many requirements for simple transactions.",
      "Service delivery should be faster and easier."
    ],
    disaster: [
      "Emergency response is slow and not well-coordinated.",
      "Access to evacuation centers needs improvement.",
      "Emergency supplies are insufficient.",
      "Response time during disasters is too long.",
      "Better coordination with emergency services needed."
    ],
    safety: [
      "Police response is usually quick when called.",
      "Security services are accessible to residents.",
      "Tanods are visible and responsive.",
      "Safety services are generally available.",
      "Response to security concerns is adequate."
    ],
    social: [
      "Services are available but sometimes hard to access.",
      "Health center hours should be extended.",
      "Access to social programs needs simplification.",
      "Service delivery could be more efficient.",
      "Some residents find it difficult to avail services."
    ],
    business: [
      "Permit process is too slow and expensive.",
      "Business clearance takes too long to process.",
      "Too many steps in the application process.",
      "Fees are high for small businesses.",
      "Processing time should be reduced."
    ],
    environmental: [
      "Waste collection is irregular and unreliable.",
      "Garbage collection schedule is inconsistent.",
      "Access to recycling facilities is limited.",
      "Waste management services need improvement.",
      "Collection frequency should be increased."
    ]
  };

  const satisfactionQuotes: { [key: string]: string[] } = {
    financial: [
      "Good service, but more funding is needed for programs.",
      "Staff are helpful but resources are limited.",
      "Service quality is acceptable but can improve.",
      "Programs are beneficial but need expansion.",
      "Overall satisfied but more support needed."
    ],
    disaster: [
      "Response was good but we need better equipment.",
      "Emergency services are adequate but need upgrading.",
      "Disaster response is satisfactory but can be better.",
      "Preparedness is okay but needs more resources.",
      "Overall response is acceptable with room for improvement."
    ],
    safety: [
      "Security is okay but needs improvement in some areas.",
      "Safety services are satisfactory but not excellent.",
      "Peace and order is maintained but can be better.",
      "Security measures are adequate but need enhancement.",
      "Overall safety is good but requires more attention."
    ],
    social: [
      "Good programs but need more resources and staff.",
      "Services are helpful but capacity is limited.",
      "Social programs are beneficial but need expansion.",
      "Quality is good but accessibility needs improvement.",
      "Overall satisfied but more support is needed."
    ],
    business: [
      "Service needs major improvement to help local businesses.",
      "Business support is minimal and needs enhancement.",
      "Permit services are slow and need modernization.",
      "More assistance needed for entrepreneurs.",
      "Business environment needs significant improvement."
    ],
    environmental: [
      "Environmental services exist but need better implementation.",
      "Waste management is functional but needs upgrading.",
      "Programs are in place but enforcement is weak.",
      "Services are available but quality varies.",
      "Overall environmental management needs improvement."
    ]
  };

  const awareness = scores.awareness || 0;
  const availment = scores.availment || 0;
  const satisfaction = scores.satisfaction || 0;

  const awarenessPool = awarenessQuotes[serviceArea] || awarenessQuotes.financial;
  const availmentPool = availmentQuotes[serviceArea] || availmentQuotes.financial;
  const satisfactionPool = satisfactionQuotes[serviceArea] || satisfactionQuotes.financial;

  const awarenessIndex = Math.floor(awareness / 100 * awarenessPool.length) % awarenessPool.length;
  const availmentIndex = Math.floor(availment / 100 * availmentPool.length) % availmentPool.length;
  const satisfactionIndex = Math.floor(satisfaction / 100 * satisfactionPool.length) % satisfactionPool.length;

  return {
    awareness: awarenessPool[awarenessIndex],
    availment: availmentPool[availmentIndex],
    satisfaction: satisfactionPool[satisfactionIndex]
  };
}

function extractRecommendations(mlResults: any, serviceArea: string, scores: any): any {
  // Extract ML-generated recommendations or use score-based selection
  const mlRecommendations = mlResults.recommendations?.[serviceArea] || {};

  if (Object.keys(mlRecommendations).length > 0) {
    return mlRecommendations;
  }

  // Use score-based selection for deterministic recommendations
  const awareness = scores.awareness || 0;
  const availment = scores.availment || 0;
  const satisfaction = scores.satisfaction || 0;
  const needAction = scores.need_action || 0;

  // Identify bottleneck
  let bottleneck = 'satisfaction';
  if (awareness < availment && awareness < satisfaction) {
    bottleneck = 'awareness';
  } else if (availment < satisfaction) {
    bottleneck = 'availment';
  }

  // Short-term recommendations based on bottleneck
  const shortTermOptions: { [key: string]: string[] } = {
    awareness: [
      'Launch information campaign through barangay announcements',
      'Distribute flyers and posters in high-traffic areas',
      'Conduct house-to-house information drives',
      'Use social media to promote available services',
      'Hold community assemblies to explain programs',
      'Create infographics for easy understanding'
    ],
    availment: [
      'Simplify application and registration processes',
      'Extend service hours to accommodate more residents',
      'Set up mobile service points in different sitios',
      'Reduce documentary requirements for applications',
      'Provide assistance desks for application help',
      'Implement online application systems'
    ],
    satisfaction: [
      'Gather detailed feedback from service users',
      'Address immediate service quality issues',
      'Improve staff training and customer service',
      'Upgrade facilities and equipment',
      'Reduce waiting times and processing delays',
      'Establish complaint resolution mechanisms'
    ]
  };

  // Medium-term recommendations
  const mediumTermOptions = needAction > 50 ? [
    'Allocate additional budget for service improvements',
    'Upgrade facilities and equipment',
    'Hire additional staff or volunteers',
    'Develop comprehensive training programs',
    'Establish partnerships with NGOs and agencies',
    'Create service quality monitoring systems'
  ] : [
    'Establish regular monitoring and feedback mechanisms',
    'Create service quality standards and benchmarks',
    'Develop partnerships with NGOs and other agencies',
    'Implement continuous improvement processes',
    'Build community engagement programs',
    'Strengthen coordination with other departments'
  ];

  // Long-term recommendations
  const longTermOptions = [
    'Integrate digital solutions for service delivery',
    'Develop comprehensive service improvement plan',
    'Build sustainable funding mechanisms for service continuity',
    'Establish innovation and modernization programs',
    'Create long-term capacity building initiatives',
    'Develop strategic partnerships for sustainability'
  ];

  // Use deterministic selection based on scores
  const shortTermPool = shortTermOptions[bottleneck] || shortTermOptions.satisfaction;
  const scoreBasedIndex = Math.floor((awareness + availment + satisfaction) / 100 * shortTermPool.length) % shortTermPool.length;

  const mediumIndex = Math.floor((satisfaction + needAction) / 100 * mediumTermOptions.length) % mediumTermOptions.length;
  const longIndex = Math.floor((awareness + availment + satisfaction + needAction) / 200 * longTermOptions.length) % longTermOptions.length;

  return {
    shortTerm: [
      shortTermPool[scoreBasedIndex],
      shortTermPool[(scoreBasedIndex + 1) % shortTermPool.length]
    ],
    mediumTerm: [
      mediumTermOptions[mediumIndex],
      mediumTermOptions[(mediumIndex + 1) % mediumTermOptions.length]
    ],
    longTerm: [
      longTermOptions[longIndex],
      longTermOptions[(longIndex + 1) % longTermOptions.length]
    ]
  };
}

async function calculateTrend(
  mlResults: any,
  serviceArea: string,
  barangayId: number,
  currentCycleId: number,
  currentScores: any
): Promise<any> {
  try {
    console.log(`🔍 [TREND] Calculating trend for ${serviceArea}, Barangay ${barangayId}, Current Cycle ${currentCycleId}`);
    console.log(`🔍 [TREND] Current scores:`, currentScores);

    // Extract trend data from ML results if available
    const trends = mlResults.trends?.[serviceArea];

    if (trends) {
      console.log(`✅ [TREND] Using ML-provided trends for ${serviceArea}:`, trends);
      return {
        change: trends.change || 0,
        direction: trends.change >= 0 ? 'up' : 'down',
        available: true
      };
    }

    console.log(`🔍 [TREND] No ML trends, fetching previous cycle...`);

    // Get the current cycle info first to compare years
    const { data: currentCycleInfo } = await supabaseAdmin
      .from('survey_cycle')
      .select('cycle_id, name, year, is_active')
      .eq('cycle_id', currentCycleId)
      .single();

    console.log(`🔍 [TREND] Current cycle info:`, currentCycleInfo);

    // Get the previous completed cycle (different year to avoid comparing same cycle)
    const { data: previousCycle, error: cycleError } = await supabaseAdmin
      .from('survey_cycle')
      .select('cycle_id, name, year, is_active')
      .lt('cycle_id', currentCycleId)
      .neq('year', currentCycleInfo?.year || 9999) // Exclude same year
      .order('cycle_id', { ascending: false })
      .limit(1)
      .single();

    console.log(`🔍 [TREND] Previous cycle query result:`, { previousCycle, cycleError: cycleError?.message });

    if (cycleError || !previousCycle) {
      // No previous cycle - this is baseline
      console.log(`⚠️ [TREND] No previous cycle found - returning baseline`);
      return {
        change: 0,
        direction: 'baseline',
        available: false,
        message: 'No historical data available for comparison'
      };
    }

    console.log(`✅ [TREND] Found previous cycle: ${previousCycle.name} (ID: ${previousCycle.cycle_id})`);

    // Try to find a previous cycle with actual data for this barangay
    // This handles cases where a barangay was not surveyed in the immediate previous cycle
    // but has historical data from earlier cycles
    let previousResponses: any[] = [];
    let actualPreviousCycle = previousCycle;
    let attemptsRemaining = 5; // Check up to 5 previous cycles

    while (attemptsRemaining > 0 && previousResponses.length === 0) {
      console.log(`🔍 [TREND] Attempt ${6 - attemptsRemaining}: Fetching responses for Barangay ${barangayId}, Cycle ${actualPreviousCycle.cycle_id}, Service ${serviceArea}...`);

      const { data: responses, error: responsesError } = await supabaseAdmin
        .from('survey_response')
        .select(`
          response_id,
          survey_section!inner (
            section_key,
            data
          )
        `)
        .eq('barangay_id', barangayId)
        .eq('survey_cycle_id', actualPreviousCycle.cycle_id)
        .eq('survey_section.section_key', serviceArea)
        .in('status', ['completed', 'submitted']);

      console.log(`🔍 [TREND] Query result:`, {
        cycleId: actualPreviousCycle.cycle_id,
        cycleName: actualPreviousCycle.name,
        count: responses?.length || 0,
        error: responsesError?.message
      });

      if (!responsesError && responses && responses.length > 0) {
        // Found data!
        previousResponses = responses;
        console.log(`✅ [TREND] Found ${responses.length} responses in ${actualPreviousCycle.name}`);
        break;
      }

      // No data in this cycle, try the next older cycle
      console.log(`⚠️ [TREND] No data in ${actualPreviousCycle.name}, looking for older cycle...`);
      
      const { data: olderCycle } = await supabaseAdmin
        .from('survey_cycle')
        .select('cycle_id, name, year, is_active')
        .lt('cycle_id', actualPreviousCycle.cycle_id)
        .neq('year', currentCycleInfo?.year || 9999)
        .order('cycle_id', { ascending: false })
        .limit(1)
        .single();

      if (!olderCycle) {
        console.log(`⚠️ [TREND] No older cycles available`);
        break;
      }

      actualPreviousCycle = olderCycle;
      attemptsRemaining--;
    }

    if (previousResponses.length === 0) {
      // No data found in any previous cycle for this barangay
      console.log(`⚠️ [TREND] No historical data found for this barangay - returning baseline`);
      return {
        change: 0,
        direction: 'baseline',
        available: false,
        message: `No historical data available for this barangay`
      };
    }

    // Calculate scores for previous cycle using the same logic as current
    console.log(`🔍 [TREND] Calculating scores from ${previousResponses.length} previous responses...`);
    const previousScores = calculateScoresFromResponses(previousResponses, serviceArea);
    console.log(`🔍 [TREND] Previous scores calculated:`, previousScores);

    if (!previousScores) {
      console.log(`⚠️ [TREND] Failed to calculate previous scores - returning baseline`);
      return {
        change: 0,
        direction: 'baseline',
        available: false,
        message: 'Unable to calculate previous cycle scores'
      };
    }

    // Calculate change in satisfaction score
    // Handle both formats: number or object with percentage
    const currentSatisfaction = typeof currentScores.satisfaction === 'number' 
      ? currentScores.satisfaction 
      : (currentScores.satisfaction?.percentage || 0);
    
    const previousSatisfaction = typeof previousScores.satisfaction === 'number'
      ? previousScores.satisfaction
      : (previousScores.satisfaction?.percentage || 0);
    
    const change = currentSatisfaction - previousSatisfaction;

    console.log(`✅ [TREND] Trend calculated successfully:`, {
      currentScores_satisfaction: currentScores.satisfaction,
      currentSatisfaction,
      previousScores_satisfaction: previousScores.satisfaction,
      previousSatisfaction,
      change,
      direction: change > 0 ? 'up' : change < 0 ? 'down' : 'stable'
    });

    const trendResult = {
      change: Math.round(change),
      direction: change > 0 ? 'up' : change < 0 ? 'down' : 'stable',
      available: true,
      previousScore: previousSatisfaction,
      currentScore: currentSatisfaction,
      previousCycle: actualPreviousCycle.name,
      previousCycleYear: actualPreviousCycle.year,
      cyclesSkipped: previousCycle.cycle_id - actualPreviousCycle.cycle_id - 1 // How many cycles were skipped
    };

    console.log(`🎉 [TREND] Returning trend result:`, trendResult);
    return trendResult;

  } catch (error) {
    console.error('❌ [TREND] Error calculating trend:', error);
    return {
      change: 0,
      direction: 'baseline',
      available: false,
      message: 'Error calculating trend'
    };
  }
}

// Helper function to calculate scores from raw survey responses using cascading funnel
function calculateScoresFromResponses(responses: any[], serviceArea: string): ServiceFunnelMetrics | null {
  try {
    // Use the shared funnel calculation utility
    const funnelMetrics = calculateServiceFunnelMetrics(responses, serviceArea);
    
    console.log(`📊 [FUNNEL] Calculated funnel metrics for ${serviceArea}:`, funnelMetrics);
    
    return funnelMetrics;
  } catch (error) {
    console.error(`❌ [FUNNEL] Error calculating funnel metrics for ${serviceArea}:`, error);
    return null;
  }
}