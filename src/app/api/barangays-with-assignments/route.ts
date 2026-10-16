import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { getActiveCycle } from '@/utils/surveyCycleHelpers';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_key';

/**
 * GET /api/barangays-with-assignments
 * Get barangays with spot assignments for the current interviewer
 * Used by Field Interviewer dashboard
 */
export async function GET(request: NextRequest) {
  try {
    // Get user from token
    const token = request.cookies.get('pulse_token')?.value;
    if (!token) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    let userId: number;
    let userRole: string;
    let userFirstName: string;
    let userLastName: string;
    let userEmail: string;
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      userId = decoded.id;
      userRole = (decoded.role || '').toLowerCase();
      userFirstName = decoded.firstName || 'Unknown';
      userLastName = decoded.lastName || 'User';
      userEmail = decoded.email || '';
    } catch {
      return NextResponse.json({ message: 'Invalid token' }, { status: 401 });
    }

    // Check if user is admin or developer (they can see all barangays)
    const isAdminOrDeveloper = userRole === 'admin' || userRole === 'developer';

    // Get active cycle
    const activeCycle = await getActiveCycle();
    if (!activeCycle) {
      return NextResponse.json([]);
    }

    // Get survey targets with LIVE response counts for the active cycle
    // This avoids the stale-read problem where survey_target.achieved defaults to 0
    let pgClient;
    let targetMap: Map<number, { target: number; achieved: number }>;
    try {
      pgClient = await pool.connect();
      const targetsResult = await pgClient.query(`
        SELECT
          st.barangay_id,
          st.target,
          COALESCE(rc.actual_count, 0) AS achieved
        FROM survey_target st
        LEFT JOIN (
          SELECT barangay_id, COUNT(*) AS actual_count
          FROM survey_response
          WHERE survey_cycle_id = $1
            AND status IN ('completed', 'submitted')
          GROUP BY barangay_id
        ) rc ON st.barangay_id = rc.barangay_id
        WHERE st.survey_cycle_id = $1
      `, [activeCycle.cycle_id]);

      if (targetsResult.rows.length === 0) {
        return NextResponse.json([]);
      }

      targetMap = new Map(targetsResult.rows.map((t: any) => [
        t.barangay_id,
        { target: t.target, achieved: parseInt(t.achieved) || 0 }
      ]));
    } catch (err) {
      console.error('Error fetching survey targets (live count):', err);
      return NextResponse.json({ error: 'Failed to fetch survey targets' }, { status: 500 });
    } finally {
      if (pgClient) pgClient.release();
    }

    const targets = Array.from(targetMap.entries()).map(([barangay_id, t]) => ({ barangay_id, ...t }));

    // Get barangay details for the targets
    const barangayIds = targets.map(t => t.barangay_id);
    const { data: barangays, error: barangaysError } = await supabaseAdmin
      .from('barangay')
      .select('barangay_id, barangay_name')
      .in('barangay_id', barangayIds);

    if (barangaysError) {
      console.error('Error fetching barangays:', barangaysError);
      return NextResponse.json({ error: 'Failed to fetch barangays', details: barangaysError.message }, { status: 500 });
    }

    // Get barangay-level assignments for this interviewer (from assignment table)
    const { data: barangayAssignments, error: assignmentsError } = await supabaseAdmin
      .from('assignment')
      .select('barangay_id, assignment_id, status, progress')
      .eq('user_id', userId);

    if (assignmentsError) {
      console.error('Error fetching barangay assignments:', assignmentsError);
    }

    // Get spots for the active cycle
    // Admin/Developer can see all spots, FI can only see their assigned spots
    let spotsQuery = supabaseAdmin
      .from('spots')
      .select(`
        spot_id,
        spot_name,
        barangay_id,
        cycle_id,
        status,
        starting_point,
        assigned_fi_id,
        questionnaires (
          questionnaire_id,
          status,
          visit_count
        )
      `)
      .eq('cycle_id', activeCycle.cycle_id);

    // Filter by assigned FI only if user is not admin/developer
    if (!isAdminOrDeveloper) {
      spotsQuery = spotsQuery.eq('assigned_fi_id', userId);
    }

    const { data: spots, error: spotsError } = await spotsQuery;

    if (spotsError) {
      console.error('Error fetching spots:', spotsError);
      return NextResponse.json({ error: 'Failed to fetch assignments' }, { status: 500 });
    }

    // Initialize barangay map - include barangays from both spot assignments and barangay assignments
    const barangayMap = new Map();
    
    // Identify which barangays this interviewer has spots in
    const spotBarangayIds = new Set(spots?.map(s => s.barangay_id) || []);
    
    // Identify which barangays this interviewer is assigned to (barangay-level)
    const assignedBarangayIds = new Set(barangayAssignments?.map(a => a.barangay_id) || []);
    
    // Combine both sets
    const allAssignedBarangayIds = new Set([...spotBarangayIds, ...assignedBarangayIds]);
    
    if (barangays) {
      barangays.forEach(barangay => {
        // Admin/Developer can see all barangays, FI can only see assigned barangays
        const shouldInclude = isAdminOrDeveloper || allAssignedBarangayIds.has(barangay.barangay_id);
        
        if (shouldInclude) {
          const targetInfo = targetMap.get(barangay.barangay_id) || { target: 0, achieved: 0 };
          const barangayAssignment = barangayAssignments?.find(a => a.barangay_id === barangay.barangay_id);
          
          barangayMap.set(barangay.barangay_id, {
            id: barangay.barangay_id,
            name: barangay.barangay_name,
            spots: [],
            totalQuestionnaires: 0,
            completedQuestionnaires: 0,
            hasAssignments: !!barangayAssignment, // Has barangay-level assignment
            hasSpots: false, // Will be set to true if spots are found
            surveyTarget: targetInfo.target,
            surveyAchieved: targetInfo.achieved,
            barangayAssignment: barangayAssignment || null
          });
        }
      });
    }
    
    // Add assigned spots to their respective barangays
    if (spots && spots.length > 0) {
      spots.forEach(spot => {
        const barangayId = spot.barangay_id;

        if (!barangayMap.has(barangayId)) return;

        const questionnaires = spot.questionnaires || [];
        const completedCount = questionnaires.filter(q => q.status === 'Completed').length;

        const barangayData = barangayMap.get(barangayId);
        barangayData.hasSpots = true;
        barangayData.spots.push({
          spotId: spot.spot_id,
          spotName: spot.spot_name,
          status: spot.status,
          startingPoint: spot.starting_point,
          totalQuestionnaires: questionnaires.length,
          completedQuestionnaires: completedCount,
          questionnaires: questionnaires.map(q => ({
            questionnaireId: q.questionnaire_id,
            status: q.status,
            visitCount: q.visit_count
          }))
        });

        barangayData.totalQuestionnaires += questionnaires.length;
        barangayData.completedQuestionnaires += completedCount;
      });
    }

    // Convert map to array and format for frontend
    const result = Array.from(barangayMap.values()).map(b => {
      // Calculate progress based on barangay's survey target
      const progress = b.surveyTarget > 0 
        ? Math.round((b.surveyAchieved / b.surveyTarget) * 100)
        : 0;

      return {
        id: b.id,
        name: b.name,
        progress: progress,
        status: b.hasAssignments || b.hasSpots ? 'assigned' : 'not_assigned',
        spots: b.spots,
        totalQuestionnaires: b.totalQuestionnaires,
        completedQuestionnaires: b.completedQuestionnaires,
        surveyTarget: b.surveyTarget,
        surveyAchieved: b.surveyAchieved,
        // Add assignment info from barangay assignment or first spot
        assignment: b.barangayAssignment ? {
          assignment_id: b.barangayAssignment.assignment_id,
          status: b.barangayAssignment.status || 'Assigned',
          progress: b.barangayAssignment.progress || progress,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          interviewer: {
            firstName: userFirstName,
            lastName: userLastName,
            email: userEmail
          }
        } : (b.spots.length > 0 ? {
          assignment_id: b.spots[0].spotId,
          status: b.spots[0].status,
          progress: progress,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          interviewer: {
            firstName: userFirstName,
            lastName: userLastName,
            email: userEmail
          }
        } : undefined)
      };
    });

    return NextResponse.json(result);

  } catch (error) {
    console.error('Error in barangays-with-assignments:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
