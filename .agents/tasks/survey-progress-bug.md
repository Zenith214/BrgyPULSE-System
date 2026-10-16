# Survey Progress Bug — Investigation Report

## Summary Answer

**Root cause:** The survey listing page (`/survey`) and the dashboard both read progress from a
*stored, stale field* (`survey_target.achieved` / `survey_target.percentage`) that is only updated
when a survey response is saved or deleted via the API.  
The `survey/barangay/[id]` detail page bypasses that stored field entirely — it **recomputes**
progress live by counting rows directly from `survey_response`.  
If `survey_target.achieved` was never populated (or fell out of sync), the list page and
dashboard show 0 % while the detail page correctly shows the real count.

---

## Evidence

### 1. How `survey/barangay/[id]` calculates progress (always live)

**File:** `src/app/survey/barangay/[id]/page.tsx`

The detail page fetches two things independently and recomputes progress in the browser:

```typescript
// Fetches raw survey responses for this barangay
const responsesResponse = await fetch(`/api/survey-responses?barangayId=${barangayId}`)
const surveyResponses = responsesResponse.ok ? await responsesResponse.json() : []

// Recomputes progress from the live count of responses
const actualResponseCount = barangay.survey_response?.length || 0
const progress = maxRespondents > 0
  ? Math.min(100, Math.round((actualResponseCount / maxRespondents) * 100))
  : 0
```

It **ignores** whatever `percentage` is stored in `survey_target`. This is why it always shows
the correct number.

---

### 2. How the survey listing page reads progress (from stale stored field)

**File:** `src/app/survey/page.tsx`  
**API:** `GET /api/barangays-with-assignments`  
**File:** `src/app/api/barangays-with-assignments/route.ts`

The survey page calls `/api/barangays-with-assignments`, which reads `achieved` directly from
the `survey_target` table:

```typescript
const { data: targets, error: targetsError } = await supabaseAdmin
  .from('survey_target')
  .select('barangay_id, target, achieved')   // ← reads stored field
  .eq('survey_cycle_id', activeCycle.cycle_id);

// Progress computed from stored value, NOT a live count
const progress = b.surveyTarget > 0
  ? Math.round((b.surveyAchieved / b.surveyTarget) * 100)
  : 0;
```

If `survey_target.achieved` is 0 (its default), `progress` is always 0%.

---

### 3. How the dashboard reads progress (same stale stored field)

**File:** `src/components/dashboard/BarangayListView.tsx`  
**API:** `GET /api/barangays/all?cycle_id=...&include_awards=true`  
**File:** `src/app/api/barangays/all/route.ts`

The dashboard's list view calls `/api/barangays/all`, which reads `st.percentage` from the
`survey_target` join:

```sql
SELECT
  b.barangay_id,
  b.barangay_name,
  ...
  st.percentage          -- ← reads stored field
FROM barangay b
LEFT JOIN survey_target st
  ON b.barangay_id = st.barangay_id
  AND st.survey_cycle_id = $1
WHERE b.is_active = true
```

The `percentage` column is then used directly as `progress`:

```typescript
const progress = barangay.percentage || 0;   // 0 when not recalculated
```

The dashboard's `BarangayDetailsCard` / `BarangaySatisfactionIndex` component also shows
`barangay.progress` from this same API response.

---

### 4. The `survey_target.achieved` / `percentage` columns are NOT auto-updated

**File:** `scripts/create-tables.sql`

The `survey_target` table is defined with defaults of 0:

```sql
CREATE TABLE survey_target (
    ...
    achieved   INTEGER DEFAULT 0,
    percentage INTEGER DEFAULT 0,
    ...
);
```

These columns are only written to in two places:

| When | Where |
|------|-------|
| After a `POST /api/survey-responses` (new submission) | `src/app/api/survey-responses/route.ts` — calls `recalculateSurveyTargetProgress()` |
| After a `DELETE /api/survey-responses` | Same file and `delete-by-barangay/route.ts` |

**Crucially, there is no trigger, webhook, or background job that backfills these columns for
existing responses.** If responses were inserted by any other path (direct DB seeding, migration,
the old `/api/survey` route, mock-data tools), the columns stay at 0.

---

### 5. The manual recalculate endpoint exists but is not called automatically

**File:** `src/app/api/survey-targets/calculate-progress/route.ts`

A `POST /api/survey-targets/calculate-progress` endpoint exists that counts live responses and
writes back `achieved`/`percentage`. But:

- It is never called on page load.
- It is never called after a survey cycle is activated.
- It must be triggered manually (e.g. via admin tooling).

The `GET` variant of that endpoint also exposes `actual_count` (live count) vs `achieved`
(stored count), which can be used to confirm the mismatch:

```sql
SELECT
  st.achieved,                -- stored (possibly stale, 0)
  sr_count.actual_count       -- live count from survey_response table
FROM survey_target st
LEFT JOIN (
  SELECT barangay_id, COUNT(*) as actual_count
  FROM survey_response
  WHERE survey_cycle_id = $1 AND status IN ('completed', 'submitted')
  GROUP BY barangay_id
) sr_count ON st.barangay_id = sr_count.barangay_id
```

---

### 6. The `survey_target` filter in `dashboard-summary` route adds another problem

**File:** `src/app/api/analytics/dashboard-summary/route.ts`

The dashboard KPI summary only includes barangays where `sr.progress = 100` on individual
`survey_response` rows:

```sql
WHERE sr.survey_cycle_id = $1
  AND sr.status IN ('completed', 'submitted')
  AND sr.progress = 100       -- ← individual response-level progress flag
```

This `progress` column lives on `survey_response`, not `survey_target`. If individual responses
have `progress < 100` (e.g. they were saved as drafts or the column was never set to 100), those
barangays are excluded from the dashboard KPIs — even though they appear complete.

---

## Conclusions

| Page / Component | Data source | What it reads | Why it shows 0 % |
|---|---|---|---|
| `survey/barangay/[id]` (detail) | Live: `/api/survey-responses` count | Row count | Works correctly — always live |
| `survey/page.tsx` (list) | Stale: `survey_target.achieved` | Stored column | 0 if not recalculated |
| Dashboard list (`/dashboard`) | Stale: `survey_target.percentage` | Stored column | 0 if not recalculated |
| Dashboard KPI summary | `survey_response.progress = 100` | Per-response flag | Excluded if flag not set |

There are two separate bugs:

1. **Primary bug (all three problem surfaces):** `survey_target.achieved` and
   `survey_target.percentage` are stale / zero because they are never automatically recalculated
   after a survey response is recorded via paths other than `POST /api/survey-responses`.
2. **Secondary bug (dashboard KPIs only):** The `AND sr.progress = 100` filter on individual
   response rows can exclude valid completed responses if that row-level `progress` field is not
   exactly 100.

---

## Recommendations (do not implement here)

### Fix 1 — Recalculate on startup (immediate, low-risk)

Call `POST /api/survey-targets/calculate-progress` once after the active cycle is confirmed.
This can be done from an admin settings page or a one-time script. This syncs the stored
`achieved`/`percentage` columns with reality.

### Fix 2 — Make `/api/barangays-with-assignments` compute progress live

In `src/app/api/barangays-with-assignments/route.ts`, replace the read of
`survey_target.achieved` with a live `COUNT(*)` from `survey_response`:

```sql
-- Replace:
.select('barangay_id, target, achieved')

-- With a JOIN that counts live:
SELECT st.barangay_id, st.target,
       COALESCE(rc.count, 0) AS achieved
FROM survey_target st
LEFT JOIN (
  SELECT barangay_id, COUNT(*) AS count
  FROM survey_response
  WHERE survey_cycle_id = $1
    AND status IN ('completed', 'submitted')
  GROUP BY barangay_id
) rc ON st.barangay_id = rc.barangay_id
WHERE st.survey_cycle_id = $1
```

This eliminates the stale-read problem entirely for the survey list page.

### Fix 3 — Make `/api/barangays/all` compute progress live

Same change in `src/app/api/barangays/all/route.ts`. Replace reading `st.percentage` with a
live subquery (or a `COUNT` JOIN), then calculate `progress` from the live count. This fixes
the dashboard list view.

### Fix 4 — Remove the `sr.progress = 100` filter from `dashboard-summary`

In `src/app/api/analytics/dashboard-summary/route.ts`, remove the
`AND sr.progress = 100` condition from `barangaysQuery`. A response with
`status = 'completed'` or `status = 'submitted'` is complete regardless of the `progress`
integer field.

### Fix 5 — Ensure `POST /api/survey-responses` always fires `recalculateSurveyTargetProgress`

The function already exists and is called — verify it is not silently failing (it catches and
swallows errors). Consider logging when it fails or propagating the error.
