import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-middleware';
import { supabaseAdmin } from '@/lib/supabase';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/**
 * GET /api/analytics/system-stats
 * Get system-wide statistics across all cycles
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) {
    return NextResponse.json({ error: authError.error }, { status: 401 });
  }

  let pgClient: any;
  try {
    // Get total cycles
    const { count: totalCycles } = await supabaseAdmin
      .from('survey_cycle')
      .select('*', { count: 'exact', head: true });

    // Get completed cycles
    const { count: completedCycles } = await supabaseAdmin
      .from('survey_cycle')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', false);

    // Get total barangays
    const { count: totalBarangays } = await supabaseAdmin
      .from('barangay')
      .select('*', { count: 'exact', head: true });

    // Get total responses across all cycles
    const { count: totalResponses } = await supabaseAdmin
      .from('survey_response')
      .select('*', { count: 'exact', head: true });

    // Get total awardees (unique barangays that have been awardees in any cycle)
    const { data: awardees } = await supabaseAdmin
      .from('cycle_award')
      .select('barangay_id')
      .eq('is_awardee', true);

    const uniqueAwardees = new Set(awardees?.map(a => a.barangay_id) || []).size;

    // Calculate average satisfaction from actual survey data across all cycles.
    // Reads the 'overallSatisfaction' field from the 'overall' survey_section for
    // every completed/submitted response, then converts to a 0–100 percentage.
    pgClient = await pool.connect();
    const satisfactionQuery = `
      SELECT ss.data->>'overallSatisfaction' AS overall_satisfaction
      FROM survey_response sr
      JOIN survey_section ss ON sr.response_id = ss.response_id
      WHERE sr.status IN ('completed', 'submitted')
        AND ss.section_key = 'overall'
        AND ss.data->>'overallSatisfaction' IS NOT NULL
    `;
    const satisfactionResult = await pgClient.query(satisfactionQuery);

    let satisfiedCount = 0;
    let totalCount = 0;

    satisfactionResult.rows.forEach((row: any) => {
      const val = String(row.overall_satisfaction).toLowerCase().trim();
      totalCount++;
      if (val.includes('yes') || val.includes('oo')) {
        // Binary "Yes" = satisfied
        satisfiedCount++;
      } else if (val.includes('no') || val.includes('hindi')) {
        // Binary "No" = not satisfied — don't increment satisfiedCount
      } else {
        // Legacy numeric format "N - Description": first char is the rating (1–5)
        const numeric = parseInt(val.charAt(0));
        if (!isNaN(numeric) && numeric >= 4) {
          satisfiedCount++;
        }
      }
    });

    const averageSatisfaction = totalCount > 0
      ? Math.round((satisfiedCount / totalCount) * 100)
      : 0;

    return NextResponse.json({
      total_cycles: totalCycles || 0,
      cycles_completed: completedCycles || 0,
      total_barangays: totalBarangays || 0,
      total_responses: totalResponses || 0,
      total_awardees: uniqueAwardees,
      average_satisfaction: averageSatisfaction
    });

  } catch (error) {
    console.error('Error fetching system stats:', error);
    return NextResponse.json(
      { error: 'Failed to fetch system statistics' },
      { status: 500 }
    );
  } finally {
    if (pgClient) pgClient.release();
  }
}
