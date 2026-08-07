import { NextRequest, NextResponse } from "next/server";
import { createClient } from '@supabase/supabase-js';

// Force dynamic rendering - don't evaluate at build time
export const dynamic = 'force-dynamic'

// Initialize Supabase admin client lazily
function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Missing required environment variables for Supabase');
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

/**
 * GET - Get cache statistics
 */
export async function GET(request: NextRequest) {
  try {
    const { data: stats, error } = await supabase
      .from('ml_cache')
      .select('endpoint, hit_count, is_stale, computed_at, expires_at');

    if (error) {
      console.error('Error fetching cache stats:', error);
      return NextResponse.json(
        { error: 'Failed to fetch cache statistics' },
        { status: 500 }
      );
    }

    if (!stats || stats.length === 0) {
      return NextResponse.json({
        totalEntries: 0,
        freshEntries: 0,
        staleEntries: 0,
        totalHits: 0,
        avgHitsPerEntry: 0,
        byEndpoint: {}
      });
    }

    const now = new Date();
    const totalEntries = stats.length;
    const staleEntries = stats.filter(s => s.is_stale || new Date(s.expires_at) < now).length;
    const freshEntries = totalEntries - staleEntries;
    const totalHits = stats.reduce((sum, s) => sum + (s.hit_count || 0), 0);
    const avgHitsPerEntry = totalEntries > 0 ? totalHits / totalEntries : 0;

    const byEndpoint = stats.reduce((acc: any, s) => {
      if (!acc[s.endpoint]) {
        acc[s.endpoint] = { count: 0, hits: 0 };
      }
      acc[s.endpoint].count++;
      acc[s.endpoint].hits += s.hit_count || 0;
      return acc;
    }, {});

    return NextResponse.json({
      totalEntries,
      freshEntries,
      staleEntries,
      totalHits,
      avgHitsPerEntry: Math.round(avgHitsPerEntry * 100) / 100,
      byEndpoint
    });

  } catch (error) {
    console.error('Error in GET /api/tools/invalidate-ml-cache:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Invalidate all cache entries
 */
export async function DELETE(request: NextRequest) {
  try {
    // Get current stats before deletion
    const { data: statsBefore } = await supabase
      .from('ml_cache')
      .select('id', { count: 'exact', head: true });

    const countBefore = statsBefore?.length || 0;

    // Delete all cache entries
    const { error, count } = await supabase
      .from('ml_cache')
      .delete()
      .neq('id', 0); // Delete all rows (using a condition that's always true)

    if (error) {
      console.error('Error invalidating cache:', error);
      return NextResponse.json(
        { error: `Failed to invalidate cache: ${error.message}` },
        { status: 500 }
      );
    }

    // Verify cache is empty
    const { data: statsAfter } = await supabase
      .from('ml_cache')
      .select('id', { count: 'exact', head: true });

    const countAfter = statsAfter?.length || 0;

    return NextResponse.json({
      success: true,
      message: 'ML cache invalidated successfully',
      entriesDeleted: countBefore,
      entriesRemaining: countAfter,
      verified: countAfter === 0
    });

  } catch (error) {
    console.error('Error in DELETE /api/tools/invalidate-ml-cache:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST - Invalidate cache for specific endpoint or barangay/cycle
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { endpoint, barangayId, cycleId } = body;

    let query = supabase.from('ml_cache').delete();

    if (endpoint) {
      // Delete by endpoint
      query = query.eq('endpoint', endpoint);
    } else if (barangayId && cycleId) {
      // Delete by barangay and cycle
      query = query
        .eq('barangay_id', barangayId)
        .eq('cycle_id', cycleId);
    } else if (barangayId) {
      // Delete by barangay only
      query = query.eq('barangay_id', barangayId);
    } else if (cycleId) {
      // Delete by cycle only
      query = query.eq('cycle_id', cycleId);
    } else {
      return NextResponse.json(
        { error: 'Must provide endpoint, barangayId, or cycleId' },
        { status: 400 }
      );
    }

    const { error, count } = await query;

    if (error) {
      console.error('Error invalidating cache:', error);
      return NextResponse.json(
        { error: `Failed to invalidate cache: ${error.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Cache entries invalidated successfully',
      entriesDeleted: count || 0,
      filter: { endpoint, barangayId, cycleId }
    });

  } catch (error) {
    console.error('Error in POST /api/tools/invalidate-ml-cache:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
