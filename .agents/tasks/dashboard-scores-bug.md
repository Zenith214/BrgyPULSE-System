# Dashboard Scores Bug — Investigation Findings

## Summary Answer

There are **four distinct bugs** causing satisfaction scores and Need-for-Action (NFA) scores to show as 0 on the dashboard:

1. **`MIN_SAMPLE_SIZE = 30` filter** in `dashboard-summary/route.ts` silently skips every barangay with fewer than 30 responses, so if no barangay has reached that threshold the entire `barangayScores` array stays empty and both `overallSatisfaction` and `overallNeedForAction` are calculated as 0.

2. **`row.response_id` is `undefined`** in `calculateBarangayNeedForAction`. The SQL query selects only `ss.section_key` and `ss.data` — it does **not** select `sr.response_id` or `ss.response_id`. So every call to `respondentsWithNeed.add(row.response_id)` adds `undefined` to the Set, meaning `respondentsWithNeed.size` is always 0 or 1, and the NFA score is always 0 or near-0.

3. **`overallSatisfaction` key name mismatch** is a latent risk: `calculateBarangaySatisfaction` queries `ss.data->>'overallSatisfaction'` (camelCase). If the survey form saved the field under a different key (e.g. `overall_satisfaction`, `overallsatisfaction`, or a Tagalog label), all rows come back NULL and the function returns 0.

4. **`DashboardSummaryView` calls `.toFixed(1)` directly on integer values** returned by the API (`kpis.overallSatisfaction` is typed as `number` but the API uses `Math.round()` which returns an integer). This is safe because JavaScript integers have `.toFixed()`, but it *would* crash if the API ever returns a non-numeric type — which is the exact crash that already happened with the `surveyProgress.toFixed is not a function` error. The data shape contract between API and UI is fragile.

---

## Evidence with File/Symbol Citations

### Bug 1 — `MIN_SAMPLE_SIZE` gate silently zeroes out all scores

**File:** `src/app/api/analytics/dashboard-summary/route.ts`, lines ~150–162  
**Code:**
```typescript
const MIN_SAMPLE_SIZE = 30

for (const barangay of barangays) {
  // ...
  if (responseCount < MIN_SAMPLE_SIZE) {
    console.log(`[Dashboard Summary] Skipping ${barangay.barangay_name} - insufficient sample size ...`)
    continue   // ← skips the barangay entirely
  }
  // calculateBarangaySatisfaction / calculateBarangayNeedForAction only called if >= 30
  barangayScores.push(...)
  totalSatisfaction += satisfaction
  totalNeedForAction += needForAction
}

const kpis = {
  overallSatisfaction: barangayScores.length > 0
    ? Math.round(totalSatisfaction / barangayScores.length) : 0,  // ← 0 if array is empty
  overallNeedForAction: barangayScores.length > 0
    ? Math.round(totalNeedForAction / barangayScores.length) : 0,
  ...
}
```

If every barangay in the active cycle has fewer than 30 completed/submitted responses, `barangayScores` is empty and both KPI values are 0. There is no indication of this in the API response — the consumer sees `{overallSatisfaction: 0, overallNeedForAction: 0}` and has no way to distinguish "zero because the threshold wasn't met" from "zero because residents are genuinely unhappy."

The `DashboardSummaryView` (`src/components/analytics/DashboardSummaryView.tsx`, line 48–49) renders `data.kpis.overallSatisfaction.toFixed(1)%` and `data.kpis.overallNeedForAction.toFixed(1)%` — both show `0.0%` with no warning.

---

### Bug 2 — `response_id` is never selected; Set always receives `undefined`

**File:** `src/app/api/analytics/dashboard-summary/route.ts`, function `calculateBarangayNeedForAction`, lines ~14–51

The NFA query:
```sql
SELECT
  ss.section_key,
  ss.data
FROM survey_response sr
LEFT JOIN survey_section ss ON sr.response_id = ss.response_id
WHERE ...
```
Only `section_key` and `data` are projected. `response_id` is **not included** in the `SELECT` list.

Later in the loop:
```typescript
result.rows.forEach((row: any) => {
  if (row.data) {
    Object.keys(data).forEach(key => {
      if (key.startsWith('need_for_action_binary_')) {
        if (answer === 'yes' || answer === 'oo') {
          respondentsWithNeed.add(row.response_id)  // row.response_id === undefined
        }
      }
    })
  }
})
```

`row.response_id` is `undefined`. A JavaScript `Set` can hold `undefined` as a value, so `respondentsWithNeed.size` will be at most **1** regardless of how many respondents actually answered "yes". This means the NFA percentage is floored at either 0 (no "yes" answers found) or a very small number (1 / totalRespondents × 100).

**Fix required:** Add `sr.response_id` to the `SELECT` clause:
```sql
SELECT
  sr.response_id,
  ss.section_key,
  ss.data
FROM survey_response sr
LEFT JOIN survey_section ss ON sr.response_id = ss.response_id
WHERE ...
```

---

### Bug 3 — `overallSatisfaction` field key is hardcoded and may not match actual data

**File:** `src/app/api/analytics/dashboard-summary/route.ts`, function `calculateBarangaySatisfaction`, line ~71:
```sql
SELECT
  ss.data->>'overallSatisfaction' as overall_satisfaction
FROM survey_response sr
LEFT JOIN survey_section ss ON sr.response_id = ss.response_id
WHERE ...
  AND ss.section_key = 'overall'
  AND ss.data->>'overallSatisfaction' IS NOT NULL
```

The `AND ss.data->>'overallSatisfaction' IS NOT NULL` clause acts as a filter — if the actual stored key differs in case or spelling, zero rows are returned and the function returns 0.

The same key is used in the ML funnel analysis route (`src/app/api/ml/funnel-analysis/route.ts`, ~line 235):
```typescript
if (data && data.overallSatisfaction) {
```
And in `src/components/analytics/DetailedResponsesView.tsx` (line 101):
```typescript
const overallSection = response.sections?.find(s => s.key === 'overall')
if (!overallSection?.data?.overallSatisfaction) return 0
```

These three places all agree on `overallSatisfaction` (camelCase). This is likely consistent with the survey form — but if the form ever stored the field differently, all three break simultaneously.

---

### Bug 4 — Data shape fragility / `.toFixed()` risk pattern

**File:** `src/components/analytics/DashboardSummaryView.tsx`, lines 48–49:
```tsx
{data.kpis.overallSatisfaction.toFixed(1)}%
{data.kpis.overallNeedForAction.toFixed(1)}%
```

The API always calls `Math.round()` so the values are integers. `.toFixed()` on an integer works fine in JavaScript. However, the exact same `.toFixed` pattern in `BarangayDetailsCard.tsx` line 140 was the source of the recent `TypeError: surveyProgress.toFixed is not a function` crash — the `progress` field came back as a string from the API. There is no defensive coercion (`Number(...)`) before calling `.toFixed()` in `DashboardSummaryView`, so if the API ever returns a string, the component will throw the same error.

---

### Where the score cards actually live

There are **two separate display paths** for these scores:

| Surface | Component | Data Source |
|---------|-----------|-------------|
| Analytics tab → Dashboard Summary | `DashboardSummaryView.tsx` | `/api/analytics/dashboard-summary` → `kpis.overallSatisfaction` / `kpis.overallNeedForAction` |
| Map view → barangay click modal (desktop) | `BarangaySatisfactionIndex.tsx` | `/api/ml/funnel-analysis?barangayId=&cycleId=` → `overall_satisfaction` + averaged `service_scores[*].need_action` |
| Map view → list view → barangay detail (mobile/officer) | `BarangayListView.tsx` | Same ML funnel-analysis endpoint |

The ML funnel-analysis route (`src/app/api/ml/funnel-analysis/route.ts`) has its own separate calculation path and its own gate: if `survey_target.percentage < 100` it returns `{surveyIncomplete: true}` and the component shows "Survey Ongoing" instead of a score. This is a correct and intentional behavior for per-barangay cards.

The broken scores (showing 0) are specifically the **dashboard-level aggregate KPIs** in `DashboardSummaryView`, driven by the `dashboard-summary` API. The per-barangay modal scores are driven by the ML funnel route and may work correctly for individual barangays if their surveys are 100% complete.

---

### `system-stats` / `OverallAnalytics` — separate route, hardcoded placeholder

**File:** `src/app/api/analytics/system-stats/route.ts`, line ~42:
```typescript
const averageSatisfaction = 66; // Placeholder - will be calculated from actual data
```

The `OverallAnalytics.tsx` component (used in the analytics tab) calls this endpoint. The `average_satisfaction` value is **always 66** — it is a hardcoded constant, not derived from actual survey data.

---

## Conclusions

| # | Bug | Severity | Root Cause |
|---|-----|----------|------------|
| 1 | MIN_SAMPLE_SIZE=30 silently zeros dashboard KPIs | **High** | Threshold not reached; array stays empty; no diagnostic in response |
| 2 | `response_id` not selected → NFA Set receives `undefined` → NFA always ≈ 0 | **High** | Missing column in SELECT list |
| 3 | `overallSatisfaction` key mismatch risk | **Medium** | Fragile assumption about stored field name |
| 4 | No `Number()` coercion before `.toFixed()` | **Low** | Defensive coding gap (same bug caused the recent crash) |
| 5 | `average_satisfaction` is hardcoded 66 in system-stats | **Medium** | Placeholder never replaced |

---

## Recommended Fixes

### Fix 1 — Lower or remove the MIN_SAMPLE_SIZE gate (or make it configurable)
In `dashboard-summary/route.ts`, change or remove the `if (responseCount < MIN_SAMPLE_SIZE) continue` block. If statistical validity is important, keep the filter but add a `filteredCount` / `skippedCount` field to the KPI response so the UI can explain why scores are 0.

```typescript
// Option A: remove the gate entirely (show all data)
// Option B: lower threshold to something like 5 for early-stage cycles
const MIN_SAMPLE_SIZE = 5

// Option C: keep gate but add diagnostic to response
kpis.insufficientSampleBarangays = skippedBarangays
kpis.eligibleBarangays = barangayScores.length
```

### Fix 2 — Add `sr.response_id` to the NFA SELECT clause
In `calculateBarangayNeedForAction`:
```sql
SELECT
  sr.response_id,   -- ← ADD THIS
  ss.section_key,
  ss.data
FROM survey_response sr
LEFT JOIN survey_section ss ON sr.response_id = ss.response_id
WHERE ...
```

### Fix 3 — Verify the `overallSatisfaction` key name in the database
Run a quick query against `survey_section` where `section_key = 'overall'` to confirm the actual JSON keys stored. If inconsistent, normalize on read or correct the key used in all three files.

### Fix 4 — Add `Number()` coercion before `.toFixed()` in DashboardSummaryView
```tsx
{Number(data.kpis.overallSatisfaction).toFixed(1)}%
{Number(data.kpis.overallNeedForAction).toFixed(1)}%
```

### Fix 5 — Replace hardcoded satisfaction in system-stats
The `averageSatisfaction = 66` placeholder in `system-stats/route.ts` should calculate from actual `survey_section` data using the same logic as `calculateBarangaySatisfaction`. This affects `OverallAnalytics.tsx` → System-Wide Statistics card.
