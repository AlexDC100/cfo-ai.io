# "Period not found" + Industry Picker / Recalc Failure — Diagnostic (READ-ONLY)

**Date:** 2026-05-18
**Status:** COMPLETE — read-only audit, nothing changed.
**Period ID under investigation:** `e2737a17-c5af-46ac-8906-9ef6c4d05335`
**Scope:** Only the Set-Industry screen's flow (period resolution → catalog
search → recalc it triggers). NOT the whole benchmark subsystem, NOT Bug A,
NOT canonical-metrics, NOT pricing, NOT P&L footing, NOT Products, NOT
chat, NOT valuation, NOT dashboard-restyle.
**Output:** This file only.

> **Production DB access was not available from this audit environment.**
> Every conclusion below is grounded in code-path inspection. Where a
> conclusion depends on what's in the live `financial_periods` or
> `industry_profiles` tables, the report says so and proposes the
> one-shot SQL the next maintainer can run to confirm.

---

## Flow map (Step 0)

| Concern | File:line |
|---|---|
| `?period=` read from URL | `scandi-desk-main/src/lib/activePeriod.ts:275` (`useActivePeriod`) |
| URL → backend lookup | `scandi-desk-main/src/lib/activePeriod.ts:244` (`fetchPeriodFromApi`) — `GET /api/period/{period_id}` |
| Backend period read | `src/engine/api/pipeline.py:4187` `@router.get("/api/period/{period_id}")` |
| Backend period lookup query | `pipeline.py:4196` — `client.select("financial_periods", filters={"id": f"eq.{period_id}"}, single=True)` |
| `404 Period not found` raise | `pipeline.py:4198` |
| Industry catalog list (period-INDEPENDENT) | `src/engine/api/_industry_intelligence.py:375` `GET /api/industry/profiles` |
| Industry catalog search (period-INDEPENDENT) | `_industry_intelligence.py:499` `GET /api/industry/search?q=…` |
| Catalog tables read | `industry_profiles` + `industry_aliases` (Phase A schema) |
| Detect industry for period (period-SCOPED) | `_industry_intelligence.py:554` `GET /api/industry/detect/{period_id}` |
| Detect's 404 raise | `_industry_intelligence.py:572` |
| Recalc industry (period-SCOPED) | `_industry_intelligence.py:765` `POST /api/industry/assignment/{period_id}/recalc` |
| Recalc's 404 raise | `_industry_intelligence.py:780` |
| FE picker entry | `scandi-desk-main/src/components/cfo/industry/IndustryPicker.tsx:46` |
| FE hook (assignment + detection) | `scandi-desk-main/src/hooks/useIndustryAssignment.ts:56` |
| FE catalog fetch on open | `IndustryPicker.tsx:111` (`listProfiles()`) |
| FE search effect | `IndustryPicker.tsx:143` (`searchIndustries(q, 30)`) |
| FE "No matches" render | `IndustryPicker.tsx:353` |
| FE "Recalc failed" toast | `IndustryPicker.tsx:223-225` |
| FE 404 → "Period not found." copy | `IndustryPicker.tsx:538` (`humanizeError`) |

**Key determinant — is catalog search period-scoped?**
**NO.** Both `GET /api/industry/profiles` (line 376) and `GET /api/industry/search` (line 500) accept no `period_id` parameter. Their handlers query `industry_profiles` + `industry_aliases` via `_supabase.admin()` with no period join, no period filter, and no `_resolve_user_org` call. A valid period is **not required** for the catalog to return rows.

**This single fact almost answers the diagnostic.** If the catalog endpoints don't depend on a period, a "Period not found" cannot be the cause of the catalog's "No matches". The two failures must be independent.

---

## Period failure (Step 1)

### Trace of `e2737a17-c5af-46ac-8906-9ef6c4d05335`

The frontend `useActivePeriod` calls `GET /api/period/e2737a17-...` (`activePeriod.ts:252`). The handler at `pipeline.py:4196` runs:

```python
periods = client.select("financial_periods",
                        filters={"id": f"eq.e2737a17-c5af-46ac-8906-9ef6c4d05335"},
                        single=True)
if not periods:
    raise HTTPException(404, "Period not found.")
```

`client` here is `_supabase.per_user(jwt)` — RLS-scoped to the caller. So the 404 fires when EITHER:
- the row doesn't exist in `financial_periods` at all, OR
- the row exists but the caller's RLS policy hides it (different org).

### Likely cause: stale URL — period was hard-deleted

`financial_periods` rows are hard-deleted from two paths:

1. **`_maybe_drop_empty_period`** (`pipeline.py:2897`) — fires when EVERY document referencing the period is gone (live or soft-deleted). Triggered by `/api/documents/{id}/permanent-delete` (`pipeline.py:4175`) and by Settings → "clear my data" actions. Has a 5-minute young-period safety window (`pipeline.py:2933`).
2. **`DELETE /api/period/{period_id}`** (`pipeline.py:4599`) — explicit user-initiated period delete.

Both paths trigger `ON DELETE CASCADE` on `statement_line_items`, `calculated_metrics`, `briefings`, `benchmark_reports`, `valuations`, `user_valuation_assumptions` (note at `pipeline.py:2915-2917`).

The screen evidence strongly supports stale-URL:
- Romanian meat-production / CAEN text was visible in the background → the period existed at some point, the dashboard rendered it.
- The auto-detect ran in a previous session — implying period + statements + metrics WERE there.
- Now both `/api/period/{id}` and `/api/industry/detect/{id}` 404 with the same period_id.
- All three 404 raises (`pipeline.py:4198`, `_industry_intelligence.py:572`, `_industry_intelligence.py:780`) use the IDENTICAL query (`select("financial_periods", filters={"id": f"eq.{period_id}"})`). A lookup-key-mismatch in one would mean the same mismatch in all three — and the rest of the app (Dashboard, Reports, Benchmarks) uses the same query and demonstrably works for other periods. So the query shape is fine. The row simply isn't there for THIS UUID.

### Less likely (cannot be ruled out without DB access)

- **RLS scope mismatch:** the row exists but belongs to a different org_id than the caller's. Would manifest identically as 404. The fact that the URL has THIS specific UUID (not random) means the user almost certainly had access at some point — RLS doesn't suddenly hide a row from its original creator unless org membership changed. Low probability.
- **Soft-delete / `deleted_at` filter:** `financial_periods` doesn't appear to have a `deleted_at` column in the schema files inspected (the soft-delete pattern is on `documents`, not on periods — see `pipeline.py:3272-3282`). So this branch doesn't apply.

### Classification

**Cause: `stale-URL-period-gone`** with high confidence based on code paths + screen evidence. Verifiable by running:

```sql
SELECT id, created_at, org_id FROM financial_periods
 WHERE id = 'e2737a17-c5af-46ac-8906-9ef6c4d05335';
-- Expected: 0 rows.
```

If 0 rows → confirmed stale URL. If 1 row → the failure shifts to RLS-scope-mismatch (check `org_id` against the caller's `memberships`).

---

## Industry picker failure (Step 2)

### Sub-failure 1: "No matches" in the catalog search

`searchIndustries(q, 30)` hits `GET /api/industry/search` (`_industry_intelligence.py:499`). Period IS NOT a parameter; the handler reads:

```python
ac.select("industry_profiles",
          filters={"display_name": f"ilike.*{needle}*", "is_active": "eq.true"},
          columns=..., limit=limit)
ac.select("industry_aliases",
          filters={"alias": f"ilike.*{needle}*"},
          columns=..., limit=limit)
```

Both via `_supabase.admin()` (line 507) — RLS-bypassing. If those two tables have rows, the queries WILL return matches for at least common terms like "food", "meat", "real estate" — the Phase A `industries.yaml` seeded 116 industries spanning every common keyword.

User reports "No matches" for **every** query. The PostgREST `ilike.*term*` syntax is correct (used identically on working surfaces elsewhere in the codebase). The catalog list on first open (rendered from `listProfiles()` at `IndustryPicker.tsx:111`) is also empty — otherwise typing a single character would show partial matches from the cached `profiles` array (`searchResults ?? profiles` at `IndustryPicker.tsx:160`).

**Most likely cause: the Phase A catalog loader has not been run on this environment.** `industry_profiles` and `industry_aliases` are empty. The catalog endpoints execute without error but return `[]`, which the FE displays as "No matches" at `IndustryPicker.tsx:353`.

Verifiable by running:

```sql
SELECT count(*) FROM industry_profiles WHERE is_active = true;
SELECT count(*) FROM industry_aliases;
SELECT count(*) FROM caen_industry_mappings;
-- Expected for Phase A loaded: 116 / >0 / 275.
-- If all 0: catalog loader was never run on this DB.
```

This bug is **completely independent** of the period failure. Fixing one would not fix the other.

### Sub-failure 2: "Recalc failed: Period not found"

User clicks "Re-detect" → FE calls `recalcAssignment(periodId)` (`useIndustryAssignment.ts:157`) → `POST /api/industry/assignment/{period_id}/recalc` → backend at `_industry_intelligence.py:773-780` runs the SAME `select("financial_periods", filters={"id": f"eq.{period_id}"})` → returns 0 rows → raises 404 → FE's `humanizeError` (line 538) converts to "Period not found." → toast at `IndustryPicker.tsx:223-225` says "Recalc failed: Period not found."

This is the period failure surfacing through the recalc path. **No additional/independent recalc bug.** Recalc's defensive period check at `_industry_intelligence.py:774-780` is doing its job — refusing to recalculate against a phantom period.

### Why the picker still opens (instead of refusing to render)

`useIndustryAssignment.ts:70-76` swallows 404s from `detectIndustry` (returns null instead of throwing). `industryApi.ts:259` swallows 404s from `getAssignment` (returns null — "no assignment yet is a normal first-render state"). The hook therefore reports `loading=false` with `assignment=null` and `detection=null`, no error. The picker renders empty + the catalog search input + the catalog list… but the catalog is also empty (sub-failure 1), so the empty-state shows everywhere.

This swallow-404-on-detect behaviour is helpful for a fresh period mid-import; it's harmful here because it MASKS the underlying "this period doesn't exist anymore" condition. The user only sees the failure when they click an explicit action (Recalc / Save) that doesn't swallow 404s.

---

## Conclusion

**TWO INDEPENDENT BUGS:**

| # | Failure | Root cause | Independent? |
|---|---|---|---|
| A | "Period not found" inline + on Recalc | Stale URL — period `e2737a17-...` was hard-deleted (likely by `_maybe_drop_empty_period` cascade after the source document was permanent-deleted) | YES — would still fail with a valid catalog |
| B | "No matches" for every catalog search | `industry_profiles` / `industry_aliases` tables are empty — the Phase A catalog loader (`python -m engine.api.seed.load_industry_catalog`) has not been applied to this environment | YES — would still fail with a valid period |

**Proof of independence:**
- The catalog endpoints (`/api/industry/profiles`, `/api/industry/search`) have no `period_id` parameter (`_industry_intelligence.py:376` + `:500`). They cannot fail "because the period doesn't exist". They can only return empty results when the catalog tables are empty.
- The period 404 originates in the SAME three-line query repeated at `pipeline.py:4196`, `_industry_intelligence.py:566-572`, `_industry_intelligence.py:774-780`. None of those touch the catalog tables. Fixing the catalog would not affect the period query.

The two bugs happen to render in the same screen, which is why they look entangled. They are not.

---

## Minimal fix surface (RECORDED, NOT implemented)

### Fix A — stale URL handling (period genuinely gone)

The period failure is **not a resolution-logic bug** — the query is correct. The fix shape is **graceful stale-URL handling**, not "find the missing period". Recommended minimal changes:

1. `scandi-desk-main/src/lib/activePeriod.ts:255-258` — when `/api/period/{id}` returns 404, the hook currently sets state to `EMPTY` and logs a console warning. Add a typed `notFound: true` field so callers can distinguish "no period selected" from "period was selected but is gone".
2. `scandi-desk-main/src/components/cfo/industry/IndustryPicker.tsx` (around line 312, just before the IndustrySuggestionCard) — when `useActivePeriod` reports `notFound`, render a stale-URL banner offering "Go to dashboard" + "Pick another period" instead of the broken picker.
3. `scandi-desk-main/src/components/cfo/AppShell.tsx` (around the `Routes` config) — optionally redirect `?period=<missing>` to `/dashboard` with a one-time toast. Cheaper alternative: a route-level wrapper on routes that REQUIRE a period to operate (Benchmark, Set-Industry, Reports).

No backend change required for Fix A. The 404 is the backend behaving correctly.

### Fix B — load the Phase A catalog

The Phase A artifacts already exist on disk (built in prior phases):

- `supabase/schema_phase_industry_intelligence.sql` — migration
- `src/engine/api/seed/industries.yaml` — 116 industries
- `src/engine/api/seed/caen_industry_mappings.yaml` — 275 CAEN mappings
- `src/engine/api/seed/peer_candidates.yaml` — 16 peers
- `src/engine/api/seed/load_industry_catalog.py` — idempotent loader

The fix is OPERATIONAL, not code:

1. Apply `schema_phase_industry_intelligence.sql` to the target Supabase project (idempotent — `create table if not exists`).
2. Run `python -m engine.api.seed.load_industry_catalog --dry-run` for a sanity check.
3. Run `python -m engine.api.seed.load_industry_catalog` to load the catalog.
4. Run `python -m engine.api.seed.load_industry_catalog --verify` to confirm the four calibration mappings land (1013, 4511, 6820, 7830).

Plus one defensive code change worth considering (optional):

5. `src/engine/api/_industry_intelligence.py:387-396` (`list_profiles` handler) — when the result is empty, log a `logger.warning("[industry] industry_profiles is empty — Phase A loader not yet applied")` so the SRE can spot this in logs instead of through user complaints.

### Period-failure classification (for the next fix prompt)

**Stale-URL case** with high confidence. The next targeted fix prompt should therefore be shaped as **"add graceful stale-URL handling on routes that require a period"**, NOT as **"fix the period lookup query"** — the query is correct. This distinction matters because the wrong framing would waste time looking for a bug that doesn't exist in the resolution logic.

---

## RULES (read-only integrity)

```
[x] NO code modified, NO fix applied, NO refactor
[x] NO DB writes; NO period created/restored/deleted; NO recalc triggered
    that mutates state; catalog/period inspected via code-path reads only
[x] Defects RECORDED, never fixed (fix = separate later prompt)
[x] Scope = ONLY this screen's flow (period resolution + Set-Industry
    picker + the recalc it triggers). Bug A / canonical-metrics / pricing
    / P&L / Products / chat / valuation / dashboard-restyle untouched.
[x] Only file written = this diagnostic report
```

**STATUS: [x] COMPLETE (read-only, nothing changed)**

---

## RECORDED DEFECTS (for the targeted fix prompt)

```
D1  [Period failure] Stale-URL handling missing for the period
    ?period=e2737a17-... after the underlying period row was hard-deleted
    (likely via _maybe_drop_empty_period or DELETE /api/period/{id}).
    The user is trapped on a broken URL with no in-product way to
    recover. Fix shape: graceful stale-URL banner + redirect on
    routes that require a period. Three file:line edits sized in §3.

D2  [Catalog failure] Phase A industry catalog has not been loaded into
    the Supabase project this environment points at. industry_profiles
    and industry_aliases tables are empty, so /api/industry/profiles and
    /api/industry/search return []. Fix is operational: apply
    schema_phase_industry_intelligence.sql, then run
    `python -m engine.api.seed.load_industry_catalog`. Plus an optional
    one-line server-log warning in list_profiles so this condition is
    visible in ops, not only via user reports.

D3  [Diagnostics hygiene — minor] useIndustryAssignment silently swallows
    404s on detectIndustry/getAssignment (useIndustryAssignment.ts:70-76,
    industryApi.ts:259). This is correct for "no assignment yet" but
    masks "period was deleted". When D1 ships, the hook should distinguish
    "period gone" (route-level redirect) from "period exists but no
    assignment yet" (normal empty-state) — a `periodNotFound` flag would
    bubble that distinction cleanly.
```
