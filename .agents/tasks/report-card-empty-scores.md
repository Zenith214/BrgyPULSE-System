# Report Card Empty Scores — Investigation Findings

## Summary Answer

There are **two overlapping root causes** that together explain why `service_scores: {}` and `action_grid: {}` appear on the report card for Talas (barangay 15, cycle 25), even though `overall_satisfaction` shows 96% correctly:

1. **A stale `ml_cache` entry (server-side Supabase cache) was populated when the survey was still incomplete.** At that time the route returned early with `{surveyIncomplete: true, ...}` and never reached the `getCachedOrCompute` block — so no stale ML cache exists for that code path. However the separate **client-side `reportCardCache`** (in-memory, 10-minute TTL) *did* receive a `funnelData` object from a previous page load. The browser log confirms this: `"💾 Cached funnel for barangay 15, cycle 25"` appears *before* `"🔍 Processing funnel data"`, meaning the cache was written and read in the same session. If the user visited the report card page while the survey was still 0% complete, the `{surveyIncomplete: true}` response was set on `funnelData` state but **not** stored in `reportCardCache` (the code only calls `reportCardCache.set` in the `else` branch when `!funnelData.surveyIncomplete`). So that specific path is safe.

2. **The real root cause: the Railway ML service (`/api/analyze`) returns a response whose `service_scores` object is either empty `{}` or uses key names that don't survive `mapServiceKey()`.** The evidence is the browser log sequence:
   - `"💾 Cached funnel for barangay 15, cycle 25"` — this is the *client-side* `reportCardCache.set` logging, meaning a *fresh* API response just came in.
   - Immediately after: `"🔍 Processing funnel data: {action_grid: {}, ... service_scores: {}}"` — the response from the server already has empty maps.
   - `"📊 [SATISFACTION] Updating overall satisfaction to 96%"` — `overall_satisfaction` was populated correctly.
   - `"No funnel data for X, skipping"` ×6 — the processed `service_scores` is empty.
   
   This means `transformMLToFunnelFormat` ran successfully (it set `overall_satisfaction` to 96%), but the `if (mlResults.service_scores)` block produced no entries, so `funnelData.service_scores` stayed `{}`.

---

## Evidence with File/Symbol Citations

### Finding 1 — `transformMLToFunnelFormat` produces empty `service_scores` when the ML service returns no `service_scores`

**File:** `src/app/api/ml/funnel-analysis/route.ts`, ~line 185–225

```typescript
const funnelData: any = {
  ...
  service_scores: {},   // ← starts empty
  action_grid: {},      // ← starts empty
  ...
};

if (mlResults.service_scores) {
  Object.entries(mlResults.service_scores).forEach(([serviceKey, scores]) => {
    const mappedKey = mapServiceKey(serviceKey);
    if (mappedKey && serviceAreas.includes(mappedKey)) {
      funnelData.service_scores[mappedKey] = { ... };
    }
  });
}
```

Both `service_scores` and `action_grid` are initialised as `{}` and are only populated if `mlResults.service_scores` / `mlResults.action_grid` contain matching keys. **If the ML service returns `service_scores: {}` or omits the field, both maps stay empty.** The function still proceeds to calculate `overall_satisfaction` from the `survey_section` table (via the `if (!funnelData.overall_satisfaction)` Supabase query path at ~line 240), which is why `overall_satisfaction` is 96% while `service_scores` is `{}` — they come from different sources.

### Finding 2 — The ML service at Railway returns an empty `service_scores` object

The `transformMLToFunnelFormat` function logs `overall_satisfaction from ML results` (~line 179) as the value returned by the ML `/api/analyze` endpoint. The fact that `overall_satisfaction` ends up 96% (set from the Supabase fallback query, NOT from `mlResults.overall_satisfaction`) tells us that `mlResults.overall_satisfaction` was falsy/0. The ML service did respond (no error was thrown), but its payload had no `service_scores` data.

**Possible sub-causes:**
- The Railway ML service may not have barangay 15 / cycle 25 data yet in its own database.
- The ML service may return a different response schema (e.g., `scores` instead of `service_scores`, or it uses the long-form key `financial_administration` but `mapServiceKey` expects it — actually `mapServiceKey` handles `financial_administration` correctly).
- The ML service may return 200 OK with `{service_scores: {}, action_grid: {}, overall_satisfaction: 0}` when it has no data to compute from.

There is **no fallback** in the route that calls `calculateServiceFunnelMetrics` when the ML service returns empty data. The import of `calculateServiceFunnelMetrics` from `@/lib/funnel-calculations` exists only to support trend calculation (`calculateScoresFromResponses` at line ~889), not as a primary fallback for the main analysis path.

### Finding 3 — The server-side `ml_cache` (Supabase `ml_cache` table) may be serving a stale empty result

**File:** `src/lib/ml-cache.ts`, `getCachedOrCompute`

The route wraps the ML call in `getCachedOrCompute` with a **12-hour TTL** and `staleWhileRevalidate: true`. The cache key is `"ml-funnel-analysis"` + MD5 of `{barangayId: 15, cycleId: 25}`.

If the first successful request (after the survey reached 100%) was made and the ML service returned `{service_scores: {}, action_grid: {}, overall_satisfaction: 0}`, that empty result was written to the `ml_cache` table. For the next 12 hours, **every request serves this stale, empty cached object** without re-calling the ML service. `staleWhileRevalidate: true` means stale data is returned immediately and a background recompute is triggered — but the recompute calls the same ML service which may still return empty data.

The browser log confirms a cache hit: `"💾 Cached funnel for barangay 15, cycle 25"` (from `reportCardCache.set`) — this means the server returned real (non-surveyIncomplete) data, which was fresh or from the ml_cache. The `_cache: {cached: true}` field in the response would confirm if it was a server cache hit, but this isn't visible in the provided browser logs.

### Finding 4 — `processFunnelData` in the report card page correctly propagates empty data through

**File:** `src/app/reportcard/page.tsx`, ~line 744–829 (`processFunnelData`)

When `funnelData.service_scores` is `{}`, the `Object.entries(funnelData.service_scores || {}).forEach(...)` loop runs zero iterations. `processedFunnel` stays `{}`. Then `fetchConditionalReasons` (line ~641) iterates over `['financial','disaster','safety','social','business','environmental']` and for each checks `if (!processedFunnel[serviceArea])` — all six are missing — and logs `"No funnel data for X, skipping"`. This exactly matches the browser log.

The `ComprehensivePrintView` then receives:
```
serviceAreas: [
  { key: 'financial', score: 0, need: 0, quadrant: 'N/A', funnel: undefined, ... },
  ...
]
```
because `funnelData?.action_grid?.financial?.quadrant` is `undefined` (→ `'N/A'`) and `funnelData?.service_scores?.financial` is `undefined`.

### Finding 5 — The client-side `reportCardCache` does NOT cache `surveyIncomplete` responses

**File:** `src/app/reportcard/page.tsx`, ~line 547–554

```typescript
if (funnelData.surveyIncomplete) {
  setFunnelData({ surveyIncomplete: true, ... });
  // ← NO reportCardCache.set here
} else {
  reportCardCache.set(barangayId, cycleId, 'funnel', funnelData);  // ← only caches complete data
  await processFunnelData(funnelData, barangayId, cycleId);
}
```

The client-side cache is not the source of the stale empty scores — it correctly gates on `!surveyIncomplete`. The issue is upstream at the server-side `ml_cache` table (or at the ML service itself).

---

## Root Cause Summary

The Railway ML service at `https://mlgrcpulse-ml.up.railway.app/api/analyze` returns a response with **no service-level scores** (either `service_scores` is `{}`, or the field is missing entirely) for barangay 15 / cycle 25. The `transformMLToFunnelFormat` function in the route has no fallback to compute scores from raw survey responses when the ML service provides empty data. The result — `{service_scores: {}, action_grid: {}, overall_satisfaction: 0}` — may then be cached in the `ml_cache` Supabase table for 12 hours, causing every subsequent request to return the same empty payload until the cache expires or is force-refreshed.

`overall_satisfaction` appears correct (96%) because it is calculated by a **separate Supabase query** (`survey_section` where `section_key = 'overall'`) that runs *after* the ML results are consumed — this path does not depend on the ML service.

---

## Conclusions and Recommendations

### Root fixes (ordered by impact)

#### Fix 1 — Add a local-calculation fallback when ML returns empty `service_scores`

**File:** `src/app/api/ml/funnel-analysis/route.ts`, inside `transformMLToFunnelFormat`, after the `if (mlResults.service_scores)` block (~line 225).

After building `funnelData.service_scores`, check if it is still empty and fall back to the TypeScript `calculateServiceFunnelMetrics`:

```typescript
// After the ML service_scores block...
if (Object.keys(funnelData.service_scores).length === 0) {
  console.warn(`⚠️ [ML FUNNEL] ML returned no service scores — falling back to local calculation`);
  
  const serviceAreas = ['financial', 'disaster', 'safety', 'social', 'business', 'environmental'];
  
  for (const serviceArea of serviceAreas) {
    const { data: responses } = await supabaseAdmin
      .from('survey_response')
      .select(`
        response_id,
        survey_section!inner (section_key, data)
      `)
      .eq('barangay_id', barangayId)
      .eq('survey_cycle_id', cycleId)
      .eq('survey_section.section_key', serviceArea)
      .in('status', ['completed', 'submitted']);

    if (responses && responses.length > 0) {
      const metrics = calculateServiceFunnelMetrics(responses, serviceArea);
      const satisfactionPct = metrics.satisfaction.percentage ?? 0;
      const needActionPct = metrics.needForAction?.percentage ?? 0;

      funnelData.service_scores[serviceArea] = {
        awareness: metrics.awareness.percentage ?? 0,
        availment: metrics.availment.percentage ?? 0,
        satisfaction: satisfactionPct,
        need_action: needActionPct,
        sample_size: metrics.awareness.total,
        confidence: metrics.awareness.total >= 5 ? 'high' : 'low',
        bottleneck: 'satisfaction',
        concerns: [],
        quotes: {},
        recommendations: {}
      };

      if (metrics.actionGrid) {
        funnelData.action_grid[serviceArea] = {
          quadrant: metrics.actionGrid.quadrant,
          satisfaction_score: satisfactionPct,
          need_action_score: needActionPct,
          confidence: 'medium',
          trend: { change: 0, direction: 'baseline', available: false }
        };
      }
    }
  }
}
```

This uses the already-imported `calculateServiceFunnelMetrics` and makes the route self-sufficient when the Railway ML service has no data.

#### Fix 2 — Force-expire the stale `ml_cache` entry for barangay 15 / cycle 25

The existing empty result may be cached for up to 12 hours. To clear it immediately, either:
- Call the API with `?refresh=true` (e.g., `/api/ml/funnel-analysis?barangayId=15&cycleId=25&refresh=true`) — the route passes `forceRefresh: true` to `getCachedOrCompute`, which bypasses and overwrites the cached entry.
- Or add an admin cache-invalidation endpoint that calls `invalidateCachePattern('ml-funnel-analysis', 25, 15)` from `src/lib/ml-cache.ts`.

#### Fix 3 — Make the `?refresh=true` trigger visible in the report card UI

**File:** `src/app/reportcard/page.tsx`

The page has a "Refresh" button that calls `fetchDetailedAnalytics(barangayId, cycleId, true)`. This already sets `forceRefresh: true` which makes the fetch URL include `&refresh=true`. This is already wired correctly — but users may not know to use it. Consider adding a visible hint when scores show all-zero.

#### Fix 4 — Add `_cache.cached` / `_cache.stale` logging in the route response processing

**File:** `src/app/reportcard/page.tsx`, inside the `.then(async (response) => {...})` block (~line 547)

After receiving the funnel response, log `funnelData._cache` so future debugging can immediately distinguish a cache hit from a fresh ML call. This is low-effort and prevents the ambiguity present in the current investigation.

---

## Cache Interaction Timeline (reconstructed from browser logs)

```
1. User visits report card for Talas barangay 15, cycle 25
2. Client-side reportCardCache: MISS (no cached entry)
3. fetch /api/ml/funnel-analysis?barangayId=15&cycleId=25 sent
4. Server: progress check → 100% (survey is complete, does NOT early-return)
5. Server: getCachedOrCompute checks ml_cache table
   - EITHER: Cache HIT (stale from before; returns empty service_scores)
   - OR: Cache MISS → calls Railway ML → Railway returns empty service_scores
6. transformMLToFunnelFormat runs:
   - mlResults.service_scores is {} or absent → funnelData.service_scores stays {}
   - mlResults.action_grid is {} or absent → funnelData.action_grid stays {}
   - Supabase fallback query for overall_satisfaction succeeds → 96%
7. Server returns: {service_scores: {}, action_grid: {}, overall_satisfaction: 96, ...}
8. Client: reportCardCache.set('funnel', ...) ← "💾 Cached funnel for barangay 15, cycle 25"
9. processFunnelData called with service_scores: {}
10. processedFunnel stays {} → all 6 services log "No funnel data for X, skipping"
11. ComprehensivePrintView renders score: 0, need: 0, quadrant: 'N/A' for all services
```
