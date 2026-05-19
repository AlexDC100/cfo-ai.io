# CFO AI — FIX Bug A: Period Container Collision (TWO-PHASE: PLAN → APPROVE → EXECUTE)

**Context:** The read-only diagnostic found Bug A — period container collision. Bug B is already closed (GREEN, confirmed). This prompt fixes Bug A and ONLY Bug A.

**Bug A, precisely (from the diagnostic):**

- `src/engine/api/pipeline.py` (period lookup-or-create, diagnosed at :856-863, now at ~:910 after Bug B's +54-line shift): does lookup-or-create on `financial_periods` keyed by `(org_id, period_end)`. The DB constraint `financial_periods_org_period_unique` allows exactly one row per (org, date).
- When two different companies (EEI vs Scandia, both filing 2024-12-31) upload under the same org, the second upload **finds the first company's period, takes its period_id, wipes its `statement_line_items`, inserts its own**. Frontend shows only the latest upload's numbers under that period — the "stale data bleed."
- `src/engine/api/pipeline.py` (cascade NULL, diagnosed at :2813-2818, now at ~:2872): on document soft-delete, `_maybe_drop_empty_period` runs `UPDATE documents SET period_id=NULL WHERE period_id=<id>` for **ALL** docs sharing that period, then deletes the period — orphaning sibling companies' documents.

**THIS IS THE HIGHEST-RISK FIX OF THE PROJECT.** It is a DDL change on live Supabase (drop a unique constraint, add a different one) plus a destructive clear of existing periods/documents. There is no fast "undo" on a dropped constraint mid-flight. Therefore this prompt is **TWO PHASES**:

- **PHASE 1 (this run):** Produce the exact migration SQL, the exact clear sequence, the rollback plan, and the code-change diff — then **STOP. Do not execute anything against Supabase. Do not change the constraint. Do not clear data. Do not edit pipeline.py yet.** Output the plan and wait for explicit human approval.
- **PHASE 2 (separate, only after the human pastes "PHASE 2 APPROVED"):** Execute the approved plan exactly as written.

---

## ABSOLUTE RULES

1. **PHASE 1 IS PLAN-ONLY.** Zero DDL. Zero data writes. Zero `pipeline.py` edits. Read, analyze, produce the plan, STOP.
2. **Do not touch Bug B's code.** `_public_records_parser.py` and the Bug B gate are closed and GREEN. Out of scope.
3. **No backfill script.** Decision is locked: re-upload fixtures fresh (Option 1) with clear→migrate→re-upload sequencing (Option a). Do not propose or build a backfill.
4. **The destructive clear only runs in PHASE 2, after approval.** Soft-deleting documents and emptying `financial_periods` is irreversible-ish — it does not happen in PHASE 1 under any circumstances.
5. **One constraint, one set of code changes.** Do not refactor the pipeline, do not "improve" period handling beyond the specific collision + cascade bugs.
6. **If anything in PHASE 1 is ambiguous (constraint name, exact column for company identity, FK dependencies), surface it as an OPEN QUESTION in the plan rather than guessing.**

---

# PHASE 1 — PRODUCE THE PLAN (no execution)

## 1.1 — Confirm current schema state (read-only)

```bash
# The exact current unique constraint on financial_periods
psql -c "
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'financial_periods'::regclass
  AND contype IN ('u','p');
"

# Full financial_periods column list
psql -c "
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'financial_periods'
ORDER BY ordinal_position;
"

# Every FK that points AT financial_periods (these break if we mishandle period rows)
psql -c "
SELECT tc.table_name, kcu.column_name, ccu.table_name AS references_table
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND ccu.table_name = 'financial_periods';
"

# Current data volume that will be cleared
psql -c "
SELECT
  (SELECT COUNT(*) FROM financial_periods) AS periods,
  (SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL) AS live_docs,
  (SELECT COUNT(*) FROM statement_line_items) AS line_items,
  (SELECT COUNT(*) FROM calculated_metrics) AS metrics,
  (SELECT COUNT(*) FROM benchmark_reports) AS benchmark_reports,
  (SELECT COUNT(*) FROM briefings) AS briefings;
"
```

**Report:** the exact constraint name + definition, the full column list (identify which column carries company identity — `company_id`? `detected_company_name`? `cui`? `source_document_id`?), every FK pointing at `financial_periods`, and the row counts that PHASE 2's clear will affect.

## 1.2 — Identify the company-identity column for the new constraint

The new constraint must be 3-column: `(org_id, period_end, <company_identity>)`. Determine which column legitimately identifies the company:

```bash
# What does the period lookup-or-create actually have available at insert time?
sed -n '900,945p' src/engine/api/pipeline.py

# Is there a stable company identifier on financial_periods or documents?
psql -c "
SELECT column_name FROM information_schema.columns
WHERE table_name IN ('financial_periods','documents')
  AND column_name IN ('company_id','cui','detected_company_name',
                      'source_document_id','company_cui','tax_id')
ORDER BY table_name, column_name;
"
```

**Report:** the recommended 3rd column for the unique constraint, with justification. Preference order: a stable structured ID (`company_id` or `cui`) > `source_document_id` > `detected_company_name` (last resort — names are fuzzy). If the cleanest identity column does not yet exist on `financial_periods`, that is an OPEN QUESTION — flag it; do not silently invent a column.

## 1.3 — Produce the exact migration SQL (do not run it)

Write the precise DDL as it will be executed in PHASE 2. Example shape (Claude Code fills in real names from 1.1/1.2):

```sql
-- PHASE 2 MIGRATION — DO NOT RUN IN PHASE 1
BEGIN;

-- 1. Drop the 2-column unique constraint
ALTER TABLE financial_periods
  DROP CONSTRAINT <exact_constraint_name_from_1.1>;

-- 2. (If the identity column is missing) add it
--    <only if 1.2 found no usable column — otherwise omit>
-- ALTER TABLE financial_periods ADD COLUMN company_id uuid REFERENCES companies(id);

-- 3. Add the 3-column unique constraint
ALTER TABLE financial_periods
  ADD CONSTRAINT financial_periods_org_period_company_unique
  UNIQUE (org_id, period_end, <company_identity_column>);

COMMIT;
```

**Also produce the ROLLBACK SQL** (restore the original 2-col constraint), in case PHASE 2 must abort:

```sql
-- ROLLBACK (if PHASE 2 fails)
BEGIN;
ALTER TABLE financial_periods DROP CONSTRAINT financial_periods_org_period_company_unique;
ALTER TABLE financial_periods ADD CONSTRAINT <original_name> UNIQUE (org_id, period_end);
COMMIT;
```

## 1.4 — Produce the exact clear sequence (do not run it)

Per the locked decision (Option a: clear → migrate → re-upload). Write the exact statements PHASE 2 will run BEFORE the migration:

```sql
-- PHASE 2 CLEAR — DO NOT RUN IN PHASE 1
-- Order matters: children before parents to respect FKs.
-- (Claude Code: order this correctly based on the FK map from 1.1)
BEGIN;
DELETE FROM calculated_metrics;            -- or scope to org if multi-tenant data exists
DELETE FROM statement_line_items;
DELETE FROM benchmark_reports;
DELETE FROM briefings;                     -- if FK-dependent on period
UPDATE documents SET period_id = NULL, deleted_at = now()
  WHERE deleted_at IS NULL;                -- soft-delete all docs
DELETE FROM financial_periods;
COMMIT;
```

**Critical checks Claude Code must confirm in the plan:**
- Is this the ONLY org (single-tenant right now)? The diagnostic said one live org (`alexandru.crestin`). Confirm. If multiple orgs exist, the clear MUST be scoped to the test org only — flag as OPEN QUESTION.
- FK order correct? Children (`calculated_metrics`, `statement_line_items`) deleted before parent (`financial_periods`).
- Does any table have `ON DELETE CASCADE` already that makes some of these redundant? Report it.

## 1.5 — Produce the code-change diff (do not apply it)

Two code changes, shown as proposed diffs (NOT applied in PHASE 1):

**Change 1 — period lookup-or-create (~pipeline.py:910):** the lookup must key on `(org_id, period_end, <company_identity>)` so two companies with the same period_end get separate period rows.

**Change 2 — cascade NULL (~pipeline.py:2872):** `_maybe_drop_empty_period` must only NULL the period_id of the doc being deleted, and only drop the period when EVERY doc (live + soft-deleted) referencing it is gone — never NULL sibling docs.

Show the before/after for both, with exact line numbers (account for Bug B's +54 shift — verify by content, not just line number).

## 1.6 — PHASE 1 OUTPUT: the review package

Produce a single consolidated plan document containing:

```
═══════════════════════════════════════════════════════════
BUG A — PHASE 1 PLAN (NOTHING EXECUTED)
═══════════════════════════════════════════════════════════

CURRENT STATE:
  Constraint name + def: ______________________
  financial_periods columns: __________________
  Company-identity column chosen: _____ (justification: ___)
  FKs pointing at financial_periods: __________
  Rows that PHASE 2 clear will remove:
    periods=__ live_docs=__ line_items=__ metrics=__
    benchmark_reports=__ briefings=__
  Single org confirmed? ____ (if not → OPEN QUESTION)

MIGRATION SQL (to run in PHASE 2):
  <exact DDL>

ROLLBACK SQL (if PHASE 2 aborts):
  <exact DDL>

CLEAR SEQUENCE (to run in PHASE 2, BEFORE migration):
  <exact statements, FK-ordered>

CODE CHANGES (to apply in PHASE 2):
  Change 1 (period lookup ~:910): <before/after diff>
  Change 2 (cascade NULL ~:2872): <before/after diff>

PHASE 2 EXECUTION ORDER (exact):
  1. <clear>
  2. <migration>
  3. <code change 1>
  4. <code change 2>
  5. syntax check pipeline.py
  6. re-upload fixtures (Scandia, EEI, PRO TV) — verify each gets
     its OWN period even when period_end collides
  7. verification gates (below)

OPEN QUESTIONS / RISKS:
  - <anything ambiguous: missing identity column, multi-org,
     unexpected FK, CASCADE behavior, etc.>

ESTIMATED BLAST RADIUS IF IT GOES WRONG:
  - <honest assessment>

ROLLBACK TRIGGER CONDITIONS:
  - <exactly when PHASE 2 should abort and roll back>
═══════════════════════════════════════════════════════════
STATUS: PHASE 1 COMPLETE — AWAITING "PHASE 2 APPROVED" FROM HUMAN.
Nothing has been executed. Constraint unchanged. No data cleared.
No pipeline.py edits applied.
═══════════════════════════════════════════════════════════
```

**Then STOP. Do not proceed to PHASE 2. Wait for the human to review the plan and explicitly reply "PHASE 2 APPROVED".**

---

# PHASE 2 — EXECUTE (ONLY after human pastes "PHASE 2 APPROVED")

Do not read this section as instructions to act now. PHASE 2 runs only when the human explicitly approves the PHASE 1 plan.

When approved, execute the plan EXACTLY as written in 1.6 — no deviations, no "improvements" discovered mid-flight. If reality diverges from the plan (a FK that wasn't in the map, a constraint that won't drop), STOP, roll back per 1.3, and report — do not improvise DDL.

## PHASE 2 VERIFICATION GATES (all must pass)

### Gate 1 — Constraint changed correctly
```
[ ] Old 2-col constraint gone
[ ] New 3-col constraint present (org_id, period_end, <identity>)
[ ] Constraint definition matches the approved plan exactly
```

### Gate 2 — The collision is actually fixed (the whole point)
```
Re-upload, under the SAME org, in this order:
  1. Scandia trial balance (period_end 2024-12-31)
  2. EEI balanță (period_end 2024-12-31)  ← same date, different company
[ ] Scandia gets its OWN financial_periods row
[ ] EEI gets a SEPARATE financial_periods row (NOT Scandia's)
[ ] Scandia's statement_line_items intact after EEI upload (NOT wiped)
[ ] EEI's statement_line_items intact
[ ] Two distinct period_ids, two distinct metric sets
```

### Gate 3 — Cascade fix works
```
[ ] Soft-delete EEI's document
[ ] Scandia's document period_id UNCHANGED (not NULLed)
[ ] Scandia's period + line_items + metrics intact
[ ] EEI's period dropped only because ALL its docs are gone
```

### Gate 4 — Numbers still correct (engine unregressed)
```
After re-upload:
[ ] Scandia: net turnover 413.7M, EBITDA 54.4M, TA 292.9M (per oracle, ±2%)
[ ] EEI: numbers per expected EEI values (revenue ~4.91M / TA ~20.18M)
[ ] BS still reconciles <0.5% for both
```

### Gate 5 — Bug B still GREEN (no cross-regression)
```
[ ] Re-upload PRO TV public-records PDF → 20/20 years, conf 1.00
[ ] ELIT public-records → 17/17 years (post ELIT-oracle fix), no regression
[ ] Public-records unparseable path still raises clean error (no garbage)
```

### Gate 6 — No scope creep
```
[ ] Only the constraint + the 2 pipeline.py regions changed
[ ] Bug B code (_public_records_parser.py, gate) untouched
[ ] C2/B1/H2/C1 fixes untouched
[ ] No other schema changes
[ ] No backfill script created
```

## PHASE 2 FINAL REPORT

```
BUG A — PHASE 2 EXECUTION REPORT
  Pre-clear snapshot:    [counts printed — periods=__ live=__ sd=__ ...]
  Clear executed:        [done — rows removed: ___]
  Migration executed:    [done — new constraint: ___]
  Post-migration verify: [exactly one 3-col constraint confirmed: __]
  Code change 1:         [applied — pipeline.py:___]
  Code change 2:         [applied — pipeline.py:___]
  Re-upload fixtures:    [Scandia ✓ EEI ✓ PRO TV ✓ ELIT ✓]
  Gate 1 constraint:     [PASS/FAIL]
  Gate 2 collision fixed:[PASS/FAIL]  ← the core proof
  Gate 3 cascade fixed:  [PASS/FAIL]
  Gate 4 numbers OK:     [PASS/FAIL]
  Gate 5 Bug B intact:   [PASS/FAIL]
  Gate 6 no scope creep: [PASS/FAIL]
  STATUS: [ ] GREEN — Bug A closed, collision provably fixed
          [ ] ROLLED BACK — <reason, rollback confirmed clean>
```

---

## TIME ESTIMATE

- PHASE 1 (plan only): ~40 min, then STOP
- [human review of plan: however long you need]
- PHASE 2 (execute, only after approval): ~60 min

---

## AFTER BUG A IS GREEN

This is the last structural bug. Once Bug A is GREEN and fixtures re-upload cleanly with separate periods:

1. Re-run the post-integration verification (the YELLOW→GREEN check) to confirm the whole system is consistent end-to-end.
2. Then — and the whole session has pointed here — **stop building. Build the 30-prospect Romanian CFO list and start outreach.** The engine works (Scandia exact), Bug B closed (parse safe), Bug A closed (no data bleed). That is a demo-ready product. The next message after Bug A GREEN should be your draft outreach to the first 3 CFOs, not another fix.

Do not start PHASE 2 in this run. PHASE 1 produces the plan and stops. Nothing touches the database or pipeline.py until the human reviews the plan and explicitly approves.

---

## THREE MANDATORY ADDITIONS

**Addition 1 — Pre-clear snapshot HALT guard (PHASE 2 step 0, before the clear).** Print exact row counts: `financial_periods`, `documents` (live AND soft-deleted separately), `statement_line_items`, `calculated_metrics`, `briefings`, `benchmark_reports`, `sku_analyses`. Expected: ~2 periods, small live-doc count, ~90+ soft-deleted (the ghost pile). If wildly off, HALT before clearing and report.

**Addition 2 — Post-migration verify HALT guard (after migration, before code changes).** Print unique constraints on `financial_periods`. Expected: exactly ONE, the 3-col identity constraint. If zero/two/different, HALT, run rollback SQL, report. Do not apply pipeline.py changes on an unverified constraint.

**Addition 3 — BLOCKING, answer in Phase 1 OPEN QUESTIONS before approval of Phase 2.** In the context where the migration actually runs, can you read `pg_constraint`? PostgREST/service-role could NOT earlier this session (blocked Q1). The idempotent migration depends on introspecting `pg_constraint` at execution time. State explicitly: YES (via what — direct psql/connection string/which) or NO. Produce the migration SQL de-branched — one concrete sequence, no "if Case 1/Case 2" conditionals, since the idempotent DO-block removes the ambiguity.

Produce the full Phase 1 review package per 1.6, Additions 1 & 2 visible in PHASE 2 EXECUTION ORDER, Addition 3 answered in OPEN QUESTIONS. Then STOP. Execute nothing. Wait for explicit "PHASE 2 APPROVED."
