# Firm cockpit — Part B: ATTENTION ITEMS — gates FC2 / FC4 / FC5 / FC9 / CADENCE (C4)

**Lane:** Part B (attention items, the heart). Backend only; the `/firm`
screen is a later wave.
**Dates:** 2026-09-03 (build), 2026-09-04 (wave 2: the critics' findings
C4 / C5 / C6 / C7 / C8 / C9 fixed and gated).
**Owns:** `packs/firm/attention.yaml`, `packs/firm/calendar_ro.yaml`,
`src/engine/firm/{attention,severity,dedup,suppress,calendar,facts,pack,model,_deps}.py`,
`src/engine/api/_firm_attention.py`, `supabase/schema_phase_firm_attention.sql`,
`tests/engine/test_firm_attention.py`, `tests/engine/test_firm_route.py`,
`tests/engine/firm_postgrest_double.py`,
`tests/engine/test_firm_attention_migration.py`, `tests/engine/fixtures/firm/`.
**Builds ON (not beside):** `engine.serving.facts.FactsGateway` (the only
read path), `engine.api._finding_rank` (materiality policy + `Dismissal`),
`engine.api.findings.s_engine` (CRITICAL_FINDING), `engine.api._company_profile`
(profile-aware thresholds), `engine.api._period_detect` via the persisted
`period_detection` stamp (PERIOD_MISMATCH), `engine.firm.cadence` + `packs/firm/
cadence.yaml` (Part C — expected periods, deadlines, the stale verdict),
Part A's `schema_phase_firm.sql` (`can_read_client_org`, `firm_can`),
`pipeline._rebuild_assembled_for_briefing` (the route's statements rebuild).

```
.venv/bin/python -m pytest tests/engine/test_firm_attention.py tests/engine/test_firm_route.py tests/engine/test_firm_attention_migration.py -q -p netblock
.venv/bin/python tests/engine/fixtures/firm/capture.py --check
```

---

## The unit: an attention item, computed, never narrated

```
AttentionItem = {client, kind, severity, reason, evidence[], due_at?, action,
                 scope_key, period_id, base_severity, severity_breakdown,
                 materiality | materiality_refusal, persistence, source,
                 suppression?, suppressed_but_retained}
```

Every figure travels as typed `EvidenceFact {fact, label, unit, value|text,
currency, provenance{period_id, snapshot_id, line_id, source}}` — the
frontend renders money through `<Amount>` and can jump to the served row.
Prose (`reason`, `action`) never carries a currency figure
(`test_no_money_figure_is_smuggled_into_prose`).

Kinds are DATA (`packs/firm/attention.yaml`); one detector per enabled kind;
a disabled kind (RADAR_FLAG — Radar in flight) is declared with an
`absent_reason`, has NO detector (a stub for a disabled kind fails
`assert_full_coverage`), and the payload lists it under `kinds_absent`.
COVENANT_RISK's model is declared in the pack (`covenant_schema`,
`covenant_metrics`) and mirrored by `firm_covenants`; with no record the
kind emits nothing and `kinds_absent` says so.

SEVERITY = f(kind base rung, materiality for THAT client, days to deadline,
persistence) — every move is a labelled step in `severity_breakdown`, every
step comes from the pack, and the index is clamped after every move.
Materiality is `_finding_rank.assess_materiality` against the client's OWN
served total assets; an absent basis is a REFUSAL the item carries (grade
capped at `refused_cap`), never a default tier.

ONE CLIENT, ONE ROW — from the INPUT onwards (C7): the same `client_id`
handed as two `ClientRecord`s is one row (the first record in input order
wins) and the drop is written to the payload (`duplicate_clients`,
`counts.duplicate_clients`), never silent.

---

## WAVE 2 — what the critics found, what changed, what gates it

| # | finding (verified by the critics, file:line) | fix | gate that reds on it |
|---|---|---|---|
| C4 | `_firm_attention.py` selected `firm_client_cadence` by `org_id`; the table is keyed `client_org_id` and has no `org_id` (`schema_phase_firm_requests.sql:58`). PostgREST 400 (42703) swallowed as "not readable"; every quarterly client graded against the MONTHLY default → a false MISSING_FILE. | `CLIENT_COLUMN` names the key column per table, read out of the migration by the test; `read_optional_table` RAISES `TableReadDefect` (→ HTTP 500 naming the defect) on 42703/PGRST204 and states only a missing table (42P01/PGRST205) as "not applied"; `classify_read_error` is pure and unit-tested on both shapes. | `firm-attention-cadence` — `test_firm_route.py -k cadence` (11 tests): the quarterly row seeded through a PostgREST-faithful double that 400s on an unknown column, exactly as PostgREST does. |
| C5 | `import engine.firm.facts` (or pack / severity / suppress / calendar) FIRST in a fresh process → ImportError: facts → `engine.api._company_profile` → `engine.api.__init__` → server → `_firm_attention` → `engine.firm.attention` → half-built `facts`. | This lane's half: NO module under `engine.firm` imports `engine.api` at module level; `engine/firm/_deps.py` holds deferred handles (`company_profile`, `finding_rank`, `ratio_units`) that import on first attribute access, so every call site reads as before. (The walls lane's half, landed in parallel: `engine/api/__init__.py` exposes `create_app` lazily, PEP 562.) | `test_c5_no_firm_module_imports_engine_api_at_module_level` (AST guard, this suite) + `tests/engine/test_firm_imports.py` (walls lane: every module first, fresh subprocess). Both ride the `pytest` gate. |
| C6 | FC9 measured, never gated (a 50 ms sleep in `build_client_facts` stayed GREEN at p50 = 66 ms); fleet shape 1 period/client, not the route's 12; the route's rebuild path (`_rebuild_assembled_for_briefing`) never exercised; `_load_book`/`build_router` `# pragma: no cover`. | (a) budgets derived from measurement, printed beside it (`FC9_BUDGET_*`); (b) `test_fc9_route_shape_…` in `test_firm_route.py`: 4 real books × `PERIODS_PER_CLIENT` (12) through `_load_book`'s real PostgREST calls against the double, statements rebuilt by the real `pipeline._rebuild_assembled_for_briefing` from the fixtures' REAL persisted `statement_line_items`; heavy reads COUNTED (cold = 36/client, warm = 0, one-client change = exactly 36) and timed to budgets. Pragmas removed. | `firm-attention-fc9` (both files, `-k fc9`, 3 tests). The critics' `slowplant.py` now reds it: "FC9 OVER BUDGET — cold facts p50 62.5 ms/client exceeds the 25 ms budget". |
| C7 | The same `client_id` as two `ClientRecord`s → 2 rows each carrying all merged items (`group_by_client` keys items by id, emits a row per record). | `attention.dedupe_clients` before the loop: first record wins, later ones dropped and RECORDED on the payload (`duplicate_clients`, `counts.duplicate_clients`). | `firm-attention-fc5` (3 tests) — `test_fc5_the_same_client_handed_twice_is_still_one_row`. |
| C8 | Dead `self._rejected.append(s) if hasattr(self, "_rejected") else None` in `suppress.py`; agras served total assets is 39.32 M RON, the docs said 39.27 M. | Line deleted (`rejected()` lists off `_all`); 39.32 M here; the one-line `docs/engine_book/gates.md` correction is handed to the coordinator below. | — |
| C9 | The N7 "imports no AI subsystem" line scan cannot see a transitive load; `engine.firm.attention` pulled `engine.ai` via `engine.api.__init__ → server`. | Measured after the C5 fix (both halves): **0 AI modules after import, 0 after the first compute, server not loaded** (`test_c9_the_transitive_ai_load_is_measured_at_import_and_at_first_compute`, fresh subprocess). Planting the eager import back into `engine/api/__init__.py` reds it with 14 AI modules. | rides the `pytest` gate. |

---

## STATUS, AS MEASURED — 2026-09-04

Every pytest run below with `-p netblock` (any outbound socket connect
raises) and the production keys stripped from the environment
(`ANTHROPIC_API_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`).

```
tests/engine/test_firm_*.py (every firm suite, both lanes)   607 passed in 33.77s
  test_firm_attention.py 44 · test_firm_route.py 20 · test_firm_attention_migration.py 8
[FC9] 200 clients — cold facts: p50=5.2ms p95=5.7ms/client [budget p50 25ms], total=1.01s;
      warm open (0 changed): 81ms total, 0.41ms/client [budget 2.5ms/client];
      incremental (1 changed): 109ms total [budget 750ms], misses=1 hits=199
[FC9/route] 4 clients x 12 periods — cold: 726 ms/client (36 reads + 12 rebuilds each), 2.91 s total
      [budget 5000 ms/client]; warm open: 34 ms, 5 light reads, 0 heavy [budget 400 ms];
      incremental (1 client): 680 ms, 36 heavy reads [budget 4000 ms]
[C9]  engine.firm.attention: AI modules after import = 0; after first compute = 0;
      engine.api.server loaded after compute = False
fresh-process import FIRST, every src/engine/firm/*.py (11 modules): OK, engine.ai=0, engine.api=0
tests/engine/fixtures/firm/capture.py --check     byte-identical to a fresh capture (8 cases)
scripts/corpus_replay.py                          CORPUS REPLAY: PASS — 18 case(s)
scripts/check_import_boundary.py                  boundary holds (engine=OK, frontend=OK, private-fields=OK), 1675 files
scripts/check_metric_declared.py                  PASS — 59 names / 8 surfaces; firm 13 metrics OK; canary cash, covenant_limit seen
node scripts/check_no_plants.mjs                  PASS — 891 product source files
tests/engine/test_gate_canaries.py                13 passed
the critics' own refutations, against this tree:
  -p slowplant -k fc9   -> RED  "FC9 OVER BUDGET — cold facts p50 62.5 ms/client exceeds the 25 ms budget"
  -p replant PLANT=fc2  -> RED  "FC2 DETERMINISM VIOLATED …"
  -p replant PLANT=fc4  -> RED  "FC4 MATERIALITY VIOLATED …"
  -p replant PLANT=fc5  -> RED  "FC5 DEDUP VIOLATED — 12 rows for one client" (+ the C7 test: "… 2 records produced 12 rows")
  -p replant PLANT=fc9  -> RED  "FC9 NOT INCREMENTAL — … got 0 (0 = the cache served STALE facts …)"
  probe_fc5.py          -> DUPLICATE client_id passed twice -> rows for c-seven: 1 ; item counts per row: [14]
```

FC9 numbers are MEASURED on this host (Python 3.9, macOS), not targets;
the budgets are the measurements with ~4-6x headroom, and they are printed
next to every measurement so a drift is read before it is a failure.

**An operational fact the route-shaped gate exposed (not a defect, stated):**
a cold open of ONE 12-period client through the route costs 0.69–1.2 s on
this host — 36 PostgREST reads plus twelve `_rebuild_assembled_for_briefing`
calls at ~45 ms each (the rebuild, not the facts, dominates). A 200-client
book's FIRST open after a deploy is therefore ~2.5–4 min of CPU plus the
round trips; every later open is the five light reads (~30–90 ms) and only
changed clients are rebuilt. The `/firm` wave should warm the cache on
boot (or per firm) rather than on the first click.

---

## Fixtures — real engine output (TC-1)

`tests/engine/fixtures/firm/*.json` are captured by
`tests/engine/fixtures/firm/capture.py`: parse -> assemble -> the REAL
`stage_persist` (the `corpus_replay.py` fake-admin seam, reused by path).
The suite re-runs the capture and fails on a single differing byte
(`test_tc1_fixtures_are_byte_identical_to_a_fresh_engine_capture`).

**Wave 2:** every fixture now also carries `line_items` — the
`statement_line_items` rows the SAME persist run inserted (minus the
synthetic `period_id`), because the route rebuilds statements from those
rows on every cache miss and the route-shaped FC9 gate must drive that
real path over real rows. `capture.py` opens `corpus_replay.fake_persist_seam()`
itself to read the inserts (`run_stage_persist` returns only the
envelope); all eight fixtures were regenerated and `--check` is
byte-identical.

| fixture | source | what it proves |
|---|---|---|
| saga_10_col_{carniprod,agras,retail,realestate} | corpus, real anonymised TBs | CASH_RUNWAY (carniprod, agras), CRITICAL_FINDING (real findings run), quiet kinds; the four books of the route-shaped FC9 fleet |
| imbalance_03pct | corpus (synthetic input, real engine output) | IMBALANCED above the 0.1 % auto-reconcile gate; the "one client changed" envelope in both FC9 gates |
| carniprod_filed_under_2017 | the 2026-08-30 production audit case through the real persist-time resolver | PERIOD_MISMATCH reads the persisted `period_detection` record |
| synthetic_thin_equity / synthetic_negative_equity | declared synthetic TBs (committed bytes under `inputs/`), real engine output | NEGATIVE_EQUITY: 10 % of capital -> high, -20 % -> critical |

The ONE scrub: `envelope.provenance.written_at` (a wall clock the persist
stage writes) is pinned to the epoch. The two synthetic xlsx inputs are
committed as bytes because openpyxl stamps zip timestamps — the first
capture drifted on exactly that, which is how the rule got written down.

### The PostgREST double — `tests/engine/firm_postgrest_double.py`

`_supabase.per_user(jwt)` is routed to `PostgrestDouble`, which fakes the
ONE thing the real client does (rows or the error PostgREST sends) and
REFUSES what PostgREST refuses: a filter or select on a column the table
does not declare is a genuine `httpx.HTTPStatusError` (400, `42703`,
`column <table>.<col> does not exist`, raised by `Response.raise_for_status()`
on a real `httpx.Response`); an unknown table is 404 `PGRST205`; JSON-path
aliases (`snapshot_hash:assembled_canonical_v1->provenance->>content_hash`)
are evaluated; only the operators the route sends are understood (any
other RAISES — never "match everything"). The firm tables' columns are
PARSED from the migrations; every call is logged so a test COUNTS the
heavy reads an open caused. Tenancy is not modelled (FC1 owns the walls).

---

## Plants — every gate observed RED through its OWN message, then GREEN

**Method, wave 2:** an rsync SANDBOX of the tree (`src tests packs corpus
supabase scripts`) in the scratchpad; each plant is applied there, the
gate run there (`cwd` = sandbox, its `tests/engine/conftest.py` puts the
sandbox `src/` first), the file restored byte-for-byte from the repo, the
gate run again. `diff -rq` between sandbox and repo is empty afterwards;
`design_review/PLANT_MANIFEST.json` stayed `"plants": []` throughout and
`node scripts/check_no_plants.mjs` PASSES (891 files). The wave-1 plants
below (FC2-A, FC4-A, FC5-A, FC9-A, FC9-B) were re-driven in memory by the
critics' `replant.py` against this tree and all still red (STATUS block).

### FC2 — DETERMINISM

Plant FC2-A, `src/engine/firm/severity.py`:

```diff
-    severity = policy.clamp(index)
-    breakdown["result"] = severity
+    import os  # PLANT FC2-A: an AI flag in the environment moves the grade
+    if os.environ.get("ANTHROPIC_API_KEY"):
+        index = _clamped(index + 1)
+    severity = policy.clamp(index)
+    breakdown["result"] = severity
```

RED — `pytest tests/engine/test_firm_attention.py -q -k fc2`, exit 1 in 4.8 s:

```
E   AssertionError: FC2 DETERMINISM VIOLATED — the same client data produced different items, order or severities across runs (AI on/off, input shuffled)
FAILED tests/engine/test_firm_attention.py::test_fc2_same_data_same_items_same_order_same_severities
================== 1 failed, 2 passed, 38 deselected in 4.15s ==================
```

REVERT — exit 0: `3 passed, 38 deselected in 0.67s`. Verdict: **PROVEN RED**.

### FC4 — MATERIALITY (same delta, small vs large REAL client)

Plant FC4-A, `src/engine/firm/attention.py` — the grade ignores the
client's own totals:

```diff
-    basis_id = spec.materiality_basis
-    if basis_id is None:
-        return None, None
+    basis_id = spec.materiality_basis  # PLANT FC4-A: ignore the client's own totals
+    if basis_id is None or True:
+        return None, None
```

FIRST ATTEMPT — red for the WRONG reason (recorded, because it changed
the gate):

```
tests/engine/test_firm_attention.py:438: in test_fc4_end_to_end_one_covenant_two_real_clients_two_severities
    assert abs(s_items[0].materiality["amount"] - SAME_DELTA) < 1.0
E   TypeError: 'NoneType' object is not subscriptable
```

A TypeError three lines before the claim is not evidence (TC-2). The gate
now asserts its own claim FIRST and states the un-graded case in its own
words. SECOND ATTEMPT — same plant, exit 1 in 1.5 s:

```
E   AssertionError: FC4 MATERIALITY VIOLATED — identical covenant headroom of 250000 RON graded 'high' on the small client and 'high' on the large one
FAILED tests/engine/test_firm_attention.py::test_fc4_end_to_end_one_covenant_two_real_clients_two_severities
================== 1 failed, 2 passed, 38 deselected in 0.71s ==================
```

REVERT — exit 0: `3 passed, 38 deselected in 0.60s`. Verdict: **PROVEN RED**.

(The pair: agras, served total assets 39.32 M RON, vs carniprod, 125.89 M
RON — both real corpus periods; the same 250 000 RON headroom is
`material` on one and `info` on the other, so it grades `high` vs `medium`.
39.32 M is the gateway's own figure — `FactsGateway.from_envelope(agras)
.total_assets().to_float()` = 39 319 114.09; an earlier edition of this
page said 39.27 M.)

### FC5 — DEDUP (N items on one client is ONE row with N reasons)

Plant FC5-A, `src/engine/firm/dedup.py`:

```diff
-    return tuple(sorted(rows, key=lambda r: r.sort_key()))
+    from dataclasses import replace  # PLANT FC5-A: one row PER ITEM, not per client
+    rows = [replace(r, items=(i,)) for r in rows for i in r.items] or rows
+    return tuple(sorted(rows, key=lambda r: r.sort_key()))
```

RED — `pytest tests/engine/test_firm_attention.py -q -k fc5`, exit 1 in 1.3 s:

```
E   AssertionError: FC5 DEDUP VIOLATED — 12 rows for one client
FAILED tests/engine/test_firm_attention.py::test_fc5_five_items_on_one_client_is_one_row_with_five_reasons
================== 1 failed, 1 passed, 39 deselected in 0.61s ==================
```

REVERT — exit 0: `2 passed, 39 deselected in 0.56s`. Verdict: **PROVEN RED**.

**Plant FC5-B (wave 2, C7)** — `src/engine/firm/attention.py`, no input dedupe:

```diff
-    unique_clients, duplicate_clients = dedupe_clients(clients)
+    unique_clients, duplicate_clients = tuple(clients), ()  # PLANT FC5-B: no input dedupe
```

RED — `pytest tests/engine/test_firm_attention.py -q -p netblock -k fc5`, exit 1 in 1.2 s:

```
E   AssertionError: FC5 DEDUP VIOLATED — the same client_id handed as 2 records produced 2 rows
FAILED tests/engine/test_firm_attention.py::test_fc5_the_same_client_handed_twice_is_still_one_row
================== 1 failed, 2 passed, 41 deselected in 0.51s ==================
```

REVERT — exit 0: `3 passed, 41 deselected in 0.59s`. Verdict: **PROVEN RED**.

### FC9 — PERFORMANCE (200 clients, incremental, p50 MEASURED and BUDGETED)

Plant FC9-A, `src/engine/firm/facts.py` — never trust the cache:

```diff
-        if found is not None and found.snapshot_key == key:
+        if False:  # PLANT FC9-A: never trust the cache — a full recompute on every open
```

RED — `pytest tests/engine/test_firm_attention.py -q -k fc9`, exit 1 in 3.3 s:

```
E   AssertionError: FC9 NOT INCREMENTAL — opening an unchanged board recomputed 200 client(s)
FAILED tests/engine/test_firm_attention.py::test_fc9_two_hundred_clients_compute_incrementally_and_the_p50_is_measured
================== 1 failed, 1 passed, 39 deselected in 2.57s ==================
```

REVERT — exit 0, and the measurement prints again:
`[FC9] 200 clients — cold facts: p50=5.1ms p95=5.5ms/client, total=1.00s; warm open (0 changed): 78ms total, 0.39ms/client; incremental (1 changed): 78ms total, misses=1 hits=199`.
Verdict: **PROVEN RED**.

Plant FC9-B — the dangerous shape, a cache keyed on the CLIENT alone
(serves stale facts for a changed snapshot). FIRST ATTEMPT changed only
the `if` guard and left the `(client, key)` dict lookup intact, so nothing
stale was ever served and the gate stayed green — a plant that does not
create the defect proves nothing. SECOND ATTEMPT plants the real shape:

```diff
-        found = self._entries.get(cache_key)
-        if found is not None and found.snapshot_key == key:
+        found = next((v for k, v in self._entries.items()  # PLANT FC9-B: keyed on the client alone
+                      if k[0] == client.client_id), None)
+        if found is not None:
```

RED — exit 1 in 2.5 s:

```
E   AssertionError: FC9 NOT INCREMENTAL — one client changed; expected exactly 1 recompute, got 0 (0 = the cache served STALE facts for a changed snapshot; 200 = a full recompute)
FAILED tests/engine/test_firm_attention.py::test_fc9_two_hundred_clients_compute_incrementally_and_the_p50_is_measured
================== 1 failed, 1 passed, 39 deselected in 1.77s ==================
```

REVERT — exit 0: `2 passed, 39 deselected in 1.62s`. Verdict: **PROVEN RED**.

**Plant FC9-C (wave 2, C6a)** — the critics' `slowplant`, in source:
`src/engine/firm/facts.py`, the expensive half 50 ms slower per client.
Before wave 2 this stayed GREEN (p50 = 66 ms printed, nothing asserted).

```diff
+    import time as _t  # PLANT FC9-C: the expensive half got 50 ms slower per client
+    _t.sleep(0.05)
     periods = tuple(
         build_period_facts(p, cash_row_ids, catalog=catalog, run_findings=run_findings)
         for p in client.periods_desc())
```

RED — `pytest tests/engine/test_firm_attention.py tests/engine/test_firm_route.py -q -p netblock -k fc9`, exit 1 in 17.2 s:

```
[FC9] 200 clients — cold facts: p50=63.4ms p95=66.0ms/client [budget p50 25ms], total=12.46s; warm open (0 changed): 85ms total, 0.43ms/client [budget 2.5ms/client]; incremental (1 changed): 156ms total [budget 750ms], misses=1 hits=199
E   AssertionError: FC9 OVER BUDGET — cold facts p50 63.4 ms/client exceeds the 25 ms budget (reference host: 5.5 ms). The expensive half got slower: an extra pass per client, a repeated findings run, or a sleep.
FAILED tests/engine/test_firm_attention.py::test_fc9_two_hundred_clients_compute_incrementally_and_the_p50_is_measured
================= 1 failed, 2 passed, 61 deselected in 16.49s ==================
```

REVERT — exit 0: `3 passed, 61 deselected in 4.73s`. Verdict: **PROVEN RED**.
(The same plant driven in memory by the critics' own `-p slowplant`
against the repo: RED, p50 62.5 ms — the refutation now fails the gate.)

**Plant FC9-D (wave 2, C6b, the ROUTE's shape)** — `src/engine/api/_firm_attention.py`,
a fresh cache per request (the route computes but never reuses):

```diff
         report = FA.compute_firm_attention(records, as_of=_as_of(as_of),
-                                           cache=_CACHE, suppressions=suppressions)
+                                           cache=AttentionCache(), suppressions=suppressions)  # PLANT FC9-D: a fresh cache per request
```

FIRST ATTEMPT — red for the WRONG reason (`assert (None is not None)`, a
bare assertion on the cache lookup three lines before the claim); the
gate now states that case in its own words. SECOND ATTEMPT — same plant,
exit 1 in 5.0 s:

```
E   AssertionError: FC9 NOT INCREMENTAL (route) — the board was computed against a cache the route does not keep: nothing for org-0 in the process-level cache after the cold open, so the next open will rebuild it
FAILED tests/engine/test_firm_route.py::test_fc9_route_shape_twelve_periods_per_client_through_the_real_reads
================== 1 failed, 2 passed, 61 deselected in 4.29s ==================
```

REVERT — exit 0: `3 passed, 61 deselected in 4.81s`, and the route
measurement prints again (`[FC9/route] 4 clients x 12 periods — cold: 658
ms/client …; warm open: 34 ms, 5 light reads, 0 heavy …; incremental (1
client): 621 ms, 36 heavy reads`). Verdict: **PROVEN RED**.

### CADENCE — C4 (the cadence row is read by the column the MIGRATION declares)

**Plant C4-A** — `src/engine/api/_firm_attention.py`, the original defect
(the table read by `org_id`, which it does not have); with wave 2's reader
the 400 RAISES instead of being swallowed:

```diff
-    TABLE_CADENCE: "client_org_id",
+    TABLE_CADENCE: "org_id",  # PLANT C4-A: the column the table does not have
```

RED — `pytest tests/engine/test_firm_route.py -q -p netblock -k cadence`, exit 1 in 1.0 s:

```
E   AssertionError: C4 — firm_client_cadence is read by 'org_id', which the migration does not declare (it declares ['client_org_id', 'firm_id', 'cadence', 'deadline_days_after_period_end', 'fiscal_year_end_month', 'nudge_days_before', 'set_by', 'created_at', 'updated_at'])
E   AssertionError: C4 CADENCE ROW LOST — the board could not read the stored quarterly cadence through its own read path: HTTP 500 {"detail":"firm_client_cadence: the route asked for a column the table does not declare — a code defect in engine.api._firm_attention, NOT an unapplied migration (HTTP 400 42703: column firm_client_cadence.org_id does not exist)"}
FAILED tests/engine/test_firm_route.py::test_cadence_key_names_a_column_the_migration_declares
FAILED tests/engine/test_firm_route.py::test_cadence_quarterly_row_is_honoured_through_the_routes_own_read_path
FAILED tests/engine/test_firm_route.py::test_cadence_the_pack_default_is_monthly_and_the_gate_day_discriminates
FAILED tests/engine/test_firm_route.py::test_cadence_table_read_states_an_unapplied_migration_and_raises_on_a_bad_column
================== 4 failed, 7 passed, 9 deselected in 0.36s ===================
```

REVERT — exit 0: `11 passed, 9 deselected in 0.53s`. Verdict: **PROVEN RED**.

**Plant C4-B** — the original defect WHOLE: `org_id` AND the 400 swallowed
as a notice (what shipped before wave 2):

```diff
-    TABLE_CADENCE: "client_org_id",
+    TABLE_CADENCE: "org_id",  # PLANT C4-B
…
-        if kind == "bad_column":
+        if kind == "bad_column" and False:  # PLANT C4-B: swallow the 400 as "not readable"
             raise TableReadDefect(
```

RED — same command, exit 1 in 1.3 s — the claim itself, in the gate's words:

```
E   AssertionError: C4 CADENCE ROW LOST — a QUARTERLY client (Q4 filed, Q1 not due until 2026-03-31) was graded against the MONTHLY default on 2026-02-20 and 'owes' ['period:2026-01-31']
E   Failed: DID NOT RAISE <class 'engine.api._firm_attention.TableReadDefect'>
FAILED tests/engine/test_firm_route.py::test_cadence_key_names_a_column_the_migration_declares
FAILED tests/engine/test_firm_route.py::test_cadence_quarterly_row_is_honoured_through_the_routes_own_read_path
FAILED tests/engine/test_firm_route.py::test_cadence_table_read_states_an_unapplied_migration_and_raises_on_a_bad_column
FAILED tests/engine/test_firm_route.py::test_cadence_bad_column_surfaces_as_a_500_with_the_defect_named
================== 4 failed, 7 passed, 9 deselected in 0.66s ===================
```

REVERT — exit 0: `11 passed, 9 deselected in 0.55s`. Verdict: **PROVEN RED**.
(TC-9: `test_cadence_the_pack_default_is_monthly_and_the_gate_day_discriminates`
is the same world WITHOUT the stored row — it owes `period:2026-01-31` —
so the quiet board is the row being honoured, not a day nobody owes on.)

### C5 / C9 — import order and the transitive AI load

**Plant C5-A** — `src/engine/firm/facts.py`, the module-level import back:

```diff
-from ._deps import company_profile as CP
+from engine.api import _company_profile as CP  # PLANT C5-A: the cycle, back
```

RED — `pytest tests/engine/test_firm_attention.py -q -p netblock -k c5`, exit 1 in 1.3 s:

```
E   AssertionError: C5 IMPORT CYCLE — a firm module imports engine.api at module level; take a handle from engine.firm._deps instead:
E     facts.py:28 imports engine.api at module level
FAILED tests/engine/test_firm_attention.py::test_c5_no_firm_module_imports_engine_api_at_module_level
================== 1 failed, 3 passed, 40 deselected in 0.62s ==================
```

REVERT — exit 0: `4 passed, 40 deselected in 0.63s`. Verdict: **PROVEN RED**.
(With the walls lane's lazy `engine/api/__init__.py` this plant no longer
ImportErrors in a fresh process — which is exactly why the AST guard
exists: it holds the package's own invariant independently of the API
package's.)

**Plant C9-A** — `src/engine/api/__init__.py` (sandbox only; the file is
the walls lane's), the eager server import back:

```diff
 from typing import Any
+from .server import create_app  # PLANT C9-A: the eager import, back
```

RED — `pytest tests/engine/test_firm_attention.py -q -p netblock -k c9`, exit 1 in 3.6 s:

```
[C9] engine.firm.attention: AI modules after import = 0; after first compute = 14; engine.api.server loaded after compute = True
E   AssertionError: C9 — the FIRST COMPUTE loaded the server / an AI subsystem through engine.api.__init__: ['engine.ai', 'engine.ai.advisory', 'engine.ai.breaker', 'engine.ai.numerals', 'engine.ai.registry', 'engine.ai_lane', …] (server loaded = True)
FAILED tests/engine/test_firm_attention.py::test_c9_the_transitive_ai_load_is_measured_at_import_and_at_first_compute
================== 1 failed, 2 passed, 41 deselected in 2.78s ==================
```

REVERT — exit 0: `3 passed, 41 deselected in 1.70s`. Verdict: **PROVEN RED**.

---

## BATTERY LINES — handed to the coordinator VERBATIM (not applied here; TC-8)

The four wave-1 lines exist in `scripts/run_battery.py::_engine_gates()`.
Three change and one is new. Floors are the measured `-k` collections,
rounded down; every canary is a test id the selection cannot omit.

```python
        Gate("firm-attention-fc5",
             [PY, "-m", "pytest", "tests/engine/test_firm_attention.py", "-q", "-k", "fc5"],
             work_junit=True, floor=3, units="tests",
             canaries=("test_fc5_five_items_on_one_client_is_one_row_with_five_reasons",
                       "test_fc5_the_same_client_handed_twice_is_still_one_row")),
        # FC9 is GATED (wave 2): the measured cold p50 / warm / incremental
        # numbers are held to budgets derived from the measurement, and the
        # second test drives the ROUTE's shape — 12 periods per client through
        # _load_book's real PostgREST calls (a PostgREST-faithful double) and
        # pipeline._rebuild_assembled_for_briefing — counting the heavy reads
        # a warm open (0) and a one-client change (exactly 36) cause.
        Gate("firm-attention-fc9",
             [PY, "-m", "pytest", "tests/engine/test_firm_attention.py",
              "tests/engine/test_firm_route.py", "-q", "-k", "fc9"],
             work_junit=True, floor=3, units="tests",
             canaries=("test_fc9_two_hundred_clients_compute_incrementally_and_the_p50_is_measured",
                       "test_fc9_route_shape_twelve_periods_per_client_through_the_real_reads")),
        # C4 — the cadence table is keyed client_org_id, not org_id. The
        # route read it by the wrong column, PostgREST 400'd, the 400 was
        # reported as an unapplied migration and every quarterly client
        # was graded monthly. The gate reads the key column OUT OF THE
        # MIGRATION and drives the route through a double that 400s on an
        # unknown column exactly as PostgREST does. Plant log:
        # design_review/firm/GATES.md § CADENCE.
        Gate("firm-attention-cadence",
             [PY, "-m", "pytest", "tests/engine/test_firm_route.py", "-q", "-k", "cadence"],
             work_junit=True, floor=10, units="tests",
             canaries=("test_cadence_quarterly_row_is_honoured_through_the_routes_own_read_path",
                       "test_cadence_key_names_a_column_the_migration_declares")),
```

`-k cadence` collects 11 tests (floor 10); `-k fc9` across both files
collects 3 (floor 3); `-k fc5` collects 3 (floor 3). The C5 AST guard and
the C9 measurement ride the `pytest` gate (`tests/engine`), beside the
walls lane's `test_firm_imports.py`.

## `docs/engine_book/gates.md` — handed to the coordinator

1. `## firm-attention-fc4`, one line: `agras, served total assets 39.27 M RON`
   → `agras, served total assets 39.32 M RON` (the gateway's figure is
   39 319 114.09).
2. `## firm-attention-fc5`: work count `floor **3** tests`, second canary
   `test_fc5_the_same_client_handed_twice_is_still_one_row`, and the
   FC5-B plant block above (PLANT / RED / REVERT).
3. `## firm-attention-fc9`: command `python -m pytest tests/engine/test_firm_attention.py tests/engine/test_firm_route.py -q -k fc9`,
   work count `floor **3** tests`, second canary
   `test_fc9_route_shape_twelve_periods_per_client_through_the_real_reads`,
   the budget sentence, and the FC9-C / FC9-D plant blocks above.
4. NEW `## firm-attention-cadence`: the header table

   | | |
   |---|---|
   | command | `python -m pytest tests/engine/test_firm_route.py -q -k cadence` |
   | work count | junit-xml, floor **10** tests |
   | canary | `test_cadence_quarterly_row_is_honoured_through_the_routes_own_read_path`, `test_cadence_key_names_a_column_the_migration_declares` |

   followed by the C4-A and C4-B plant blocks above (PLANT / RED / REVERT).

---

## API CONTRACT (stable, for the later `/firm` wave)

```
GET  /api/firm/attention?as_of=YYYY-MM-DD&client_id=<org uuid>
     -> {version, as_of, pack{version, fingerprint, kinds, enabled_kinds, absent_kinds, ladder},
         materiality_policy, clients[ClientRow], suppressed[AttentionItem],
         suppression_audit[], kinds_absent[{kind, reason}], counts{..., duplicate_clients},
         cache{hits, misses, entries}, duplicate_clients[{client_id, client_name, position,
         periods, covenants, disposition}], notices[], suppressions_rejected[]}
     ClientRow = {client_id, client_name, top_severity, top_kind, top_reason, nearest_due_at,
                  nearest_days_to_due, item_count, counts{severity: n}, reasons[], items[AttentionItem],
                  gaps[{kind, reason, period_id}], suppressed_count}
     Rows ranked by top item severity, then nearest deadline; items inside a row by severity,
     days to due, pack kind order, scope. `as_of` is the ONLY clock; omit it for today.
     notices[]: "<table>: not applied (HTTP 404 PGRST205: …) — treated as empty" for a migration
     not yet applied; "<table>: not readable (…) — treated as empty" for any other read failure.
     500 {"detail": "<table>: the route asked for a column the table does not declare — a code
     defect in engine.api._firm_attention, NOT an unapplied migration (HTTP 400 42703: …)"}
     is a DEFECT IN THIS MODULE, never a deployment state.
GET  /api/firm/attention/kinds        -> the pack payload + kind_specs (thresholds, statute,
                                         covenant_schema, covenant_metrics) + the severity ladder
GET  /api/firm/attention/suppressions -> {suppressions[], notices[]}
POST /api/firm/attention/suppress     {client_id, kind, scope_key='*', reason, periods?, from_period_ordinal?}
                                      -> 422 on an empty reason or an unknown kind; RLS decides the rest
```

Tenancy: every read goes through the caller's own Supabase client, so the
book is exactly the organizations RLS returns — own memberships today,
plus firm-readable client workspaces once `schema_phase_firm.sql` is
applied. Tables another migration owns (`firm_client_cadence`,
`firm_covenants`, `firm_attention_suppressions`) are read by the key
column THEIR migration declares (`CLIENT_COLUMN` in `_firm_attention.py`:
`client_org_id` for the cadence table, `org_id` for the other two) and
listed under `notices` as "not applied — treated as empty" when absent.

## OPERATOR RUNBOOK — `supabase/schema_phase_firm_attention.sql`

1. Apply `schema_phase_multi_workspace.sql` and `schema_phase_firm.sql`
   first (the policies call `is_member_of`, `can_read_client_org`,
   `firm_can`, `firm_of_org`; the file fails loudly without them).
2. Run the SQL in Supabase Studio (it ends with `NOTIFY pgrst, 'reload schema';`).
3. IMMEDIATELY click Dashboard → Settings → API → "Reload schema cache".
4. Verify neither `select … from firm_attention_suppressions limit 1` nor
   `select … from firm_covenants limit 1` returns 400.
5. `GET /api/firm/attention` must no longer list either table under `notices`.
Applying it is the owner's Studio step; nothing here touched a database.
`.env.local` stays pinned to the test manifest URL; no test wrote anywhere.

---

## Notes for the coordinator

- **Two files outside this lane's ownership list were edited in wave 1,
  both additively and because the brief names them as the enforcers:**
  `src/engine/api/_ratio_units.py` (declares `covenant_limit` as money —
  the ONE money fact an item cites that the gateway does not serve) and
  `scripts/check_metric_declared.py` (a `firm` surface that reads
  `engine.firm.facts.SERVED_MONEY_FACTS` / `DECLARED_MONEY_FACTS` as source,
  canary `cash`, `covenant_limit`, floor 10 — scoped to `facts.py`, not the
  package, because Part C's `digest.py` names date/text keys under `fact=`).
  Wave 2 touched NOTHING outside the ownership list; the C9-A plant on
  `engine/api/__init__.py` ran in the sandbox only.
- **C5 has two halves and both landed:** this lane's (no module-level
  `engine.api` import under `engine.firm`; `_deps.py` handles) and the
  walls lane's (`engine/api/__init__.py` lazy `create_app`, with
  `tests/engine/test_firm_imports.py`). Either alone breaks the cycle;
  together, importing the firm package loads zero `engine.api` modules
  and the first compute loads only the three leaf modules. C9 is gone —
  measured, not inferred (STATUS block).
- **Cadence lives in Part C's pack.** `attention.yaml` deliberately has no
  cadence block (the loader REFUSES one); STALE_PERIOD and MISSING_FILE
  call `engine.firm.cadence.assess` / `deadline_for`. The table's KEY
  column is now read out of the migration by the gate; a rename on either
  side reds `test_cadence_key_names_a_column_the_migration_declares`.
- **Jurisdiction is data, not a branch:** the client's jurisdiction is the
  org row's `jurisdiction`/`country_code` if one exists (neither column
  exists today), else `pack_provenance.jurisdiction` stamped on the latest
  envelope by the engine. The RO calendar resolves by file NAME
  (`calendar_<code>.yaml`); a second jurisdiction is a second file.
- **RADAR_FLAG** is declared, disabled with an absent reason and has no
  detector; wiring it is a one-line `enabled: true` plus a detector once
  the Radar ships (coverage check refuses the reverse order).
- Not built (out of scope, stated): the `/firm` screen; the
  `firm_covenants` write route (the table + RLS exist; declaring a
  covenant is a Studio insert until a route lands); cross-period
  persistence beyond what the client's own attached periods carry; a
  boot-time cache warm for large books (see the operational fact under
  STATUS).

---

# WAVE 3 — THE BOARD MUST NOT DIE, MUST NOT LOSE CLIENTS (A1 / A2) — 2026-09-05

Two critics' findings, both re-measured with their own harnesses before a
line changed (`scratchpad/crit_c9.py`, `crit_c9_dep.py`, `crit_maxrows.py`):

```
crit_c9.py, ONE REAL CLIENT (agras):  AI modules after compute: 2  ['engine.ai', 'engine.ai.registry']
                                      engine.api._reconcile loaded: True
crit_c9_dep.py (registry planted dead): BOARD CRASHED -> RuntimeError: models.yaml unreadable / role missing
crit_maxrows.py (100 x 12 = 1200 period rows, db-max-rows=1000): truncations=[('financial_periods', 1200, 1000)]
                                      client rows that CHANGED because of the cap: 100   (11 min 01 s of real rebuilds)
```

| # | finding (verified, file:line) | fix | gate that reds on it |
|---|---|---|---|
| A1 | The C9 guard computed `compute_firm_attention([], …)` — no client, no facts, no gateway. One real client runs the served reader (`engine.serving.facts.FactsGateway.from_envelope` → `serving/facts.py:369` → `engine.api._reconcile`), and `_reconcile.py:80-82` executed `registry.params_for("reconcile_proposal")` AT IMPORT: `engine.ai` loaded on a path that calls no model, and a missing role / unreadable `models.yaml` was a `RegistryError` on every client — the whole board a 500. `models.yaml` is modified in this tree. | (1) `src/engine/api/_reconcile.py`: the registry read moved to FIRST TOUCH — PEP 562 `__getattr__` resolves `PROMPT_VERSION` / `AI_MODEL` and pins them into the module globals; the proposal call reads `_ai_constant(...)`; `from engine.ai import registry` is now inside that seam. Every external reader (`_reconcile.AI_MODEL` in 9 test files, `test_model_registry`'s sentinel fresh-load, monkeypatches) reads as before. (2) `src/engine/firm/facts.py`: the served reader is wrapped — whatever it raises is the period's `gateway` gap with the reason, never a dead board. (3) `facts.py` + `_firm_attention.py`: a statements provider that raises is recorded WITH its cause (`"statements provider raised: RegistryError: …"`), and the route's rebuild seam raises `StatementsRebuildUnavailable` + one payload notice instead of returning `None` and letting the facts stage blame the data. | `firm-attention-dead-registry` — `-k "test_a1 or test_c9"`, 5 tests: C9 over TWO REAL CLIENTS (agras + carniprod, fresh subprocess), the board under a registry missing the role and under an unreadable file (fresh subprocess, complete: CASH_RUNWAY present, no `served reader raised` gap, 0 AI modules after compute, the AI seam answering `RegistryError`), the in-process guard, and the route-shaped 200. |
| A2 | `_supabase.select` sends no Range header and never loops; `_load_book` read `organizations`, `financial_periods`, the three optional tables and each period's `statement_line_items` with NO limit. PostgREST truncates at `db-max-rows` (Supabase default 1000) silently. Past 1,000 rows clients vanished from the board, periods from clients (the critics' 100 × 12: the two oldest months of EVERY client, every row changed) — and the double could not see it because it did not cap. | `_firm_attention.select_all` — the ONE list read: an explicit `offset` walk over a TOTAL order (`ORG_ORDER`, `PERIOD_ORDER`, `PAGE_ORDER[table]`, `LINE_ITEM_ORDER` — unique tiebreaker last), page size `PAGE_ROWS = 1000`, `MAX_PAGES` stated as INCOMPLETE on the payload, `in.()` filters chunked at `IN_CHUNK = 100`. `offset` rides the query string exactly as `limit` already does (the real client forwards `filters` verbatim), so no `_supabase.py` change is required; the first-class `offset=` kwarg is handed below. The double (`firm_postgrest_double.py`) now caps at `MAX_ROWS = 1000` after ordering, applies reserved `offset`/`limit` keywords, records every cut the CAP made (`truncations`), and generates SEQUENTIAL ids so `id.asc` is insertion order. | `firm-attention-pagination` — `-k test_a2`, 5 tests: the cap is real (1,001 → 1,000, recorded), the walk is ordered and bounded, 1,200 clients × 1 period (both list reads past the cap) every client on the board with its row read, 100 × 12 every row read, and the unpaged read shown losing 200 rows in memory. |
| R1 (residual, NOT this lane's) | Through the ROUTE, a dead registry no longer 500s but DEGRADES: the statements rebuild is `engine.api.pipeline._rebuild_assembled_for_briefing`, and `pipeline.py:88-96` (`_EXTRACT_MODEL = _model_registry.model_for("extract")`, `_NARRATIVE_MODEL`) plus `engine.ai_lane.config` read the registry AT IMPORT — so `from .pipeline import …` raises, the profile and CRITICAL_FINDING are absent for every period, and a LIVE request loads 13 AI modules by presence (`engine.ai_lane.*`, `advisory`, `breaker`, `registry`). Measured: `lane_route_probe.py`, live vs dead. | In-lane: the absence is now STATED with the registry named (period gap + one notice), never "no assembled statements available". Closing the dependence is `pipeline.py`'s: hoist `_rebuild_assembled_for_briefing` (and the `_ro_pack()` it calls) into a leaf module — `engine/api/_rebuild.py` — with `pipeline` re-exporting it, OR make `pipeline.py:95-96` and `ai_lane.config`'s registry reads lazy the way `_reconcile`'s now are. Either lands the route-shaped gate at "0 AI modules after the request" and the rebuild alive under a dead registry. | `test_a1_route_answers_200_with_every_client_under_a_dead_registry_and_names_what_is_absent` holds the honest shape (200 + served facts + the cause named) and reds if the coupling returns as a 500 or an unnamed gap. |

## STATUS, AS MEASURED — 2026-09-05 (this host: Python 3.9.6, macOS; `-p netblock`, prod keys stripped — `scratchpad/lane_run.sh`)

```
tests/engine/test_firm_*.py (11 files, both lanes)          762 passed in 65.18s
  (a first run at 00:0x had test_firm_migration.py::test_no_client_write_policy_anywhere_except_own_prefs
   RED while the walls lane's schema_phase_firm*.sql were mid-edit (mtimes 23:59); the rerun on the
   settled tree is the 762 above — not this lane's file, not this lane's change)
every suite that reads _reconcile's constants                299 passed in 19.32s
  (test_model_registry, test_reconciliation, test_envelope_contract, test_facts_gateway, test_breaker,
   test_consensus, test_public_summary_serving, test_properties, test_mutation_regressions,
   test_pipeline_registry_wiring)
[C9]  engine.firm.attention over 2 real clients (8 items): AI modules after import = 0; after first
      compute = 0; after touching the AI seam = 2; engine.api.server loaded = False; _reconcile loaded = True
[A1]  registry missing `reconcile_proposal`: board RENDERED, 8 items over 2 clients; AI seam -> RegistryError
[A1]  registry file unreadable:              board RENDERED, 8 items over 2 clients; AI seam -> RegistryError
[A1/route] dead registry (missing role): HTTP 200, rows={'org-agras': ['CASH_RUNWAY', 'DEADLINE' x3]},
      pipeline importable=False, AI modules after the request = 3 (the failed import's partial), notices=1
[A2]  1200 clients x 1 detached period through the route: 1232-1302 ms, 50 light reads
      (organizations in 2 pages, financial_periods in 12 chunks), cap cuts = 0
[A2]  100 clients x 12 detached periods: every client's 12 rows read, financial_periods in 2 pages
[FC9] 200 clients — cold facts: p50=7.2ms p95=7.7ms/client [budget p50 25ms]; warm 0.59ms/client
      [budget 2.5]; incremental 139ms [budget 750]      (wave 2 on this host: 5.2 / 0.41 / 109)
[FC9/route] 4 clients x 12 periods — cold: 1589 ms/client [budget 5000]; warm open: 48 ms, 5 light
      reads (one page each — the walk adds no read below the cap), 0 heavy [budget 400];
      incremental (1 client): 1381 ms, 36 heavy reads [budget 4000]   (wave 2: 726 / 34 / 680 — the
      host was carrying the critics' 11-minute harness and two background suites; budgets hold)
fresh-process import FIRST, every src/engine/firm/*.py (11 modules): OK, engine.ai=0, engine.api=0
scripts/corpus_replay.py                          CORPUS REPLAY: PASS — 18 case(s)
scripts/check_import_boundary.py                  boundary holds (engine=OK, frontend=OK, private-fields=OK), 1685 files
scripts/check_metric_declared.py                  PASS — 59 names / 8 surfaces
tests/engine/fixtures/firm/capture.py --check     byte-identical to a fresh capture (8 cases)
node scripts/check_no_plants.mjs                  PASS — 897 product source files
the critics' harnesses, against this tree:
  crit_c9.py  ONE REAL CLIENT  -> AI modules after compute: 0 []; _reconcile loaded: True; server: False
  crit_c9_dep.py              -> board computed: items=4  gaps=[]
```

The A2 gates cost seconds because the 1,200 / 1,200 period rows are DETACHED
(no envelope, no rebuild): a period row without a trial balance is exactly
one MISSING_FILE item whose `missing_basis` evidence reads "period row
exists without a trial balance", so the number of such items on a client's
row IS the number of period rows the route read for it — a lost row is a
lost item, visible on the payload with zero heavy reads.

## The double's cap — `tests/engine/firm_postgrest_double.py`

`PostgrestDouble.MAX_ROWS = 1000` truncates every response after ordering
and after the reserved `offset`, caps a caller's `limit` above it, and
records `(table, matched, served)` in `truncations` only when the CAP (not
the caller's own `limit`) cut. `select_all` never lets it cut: the A2
gates assert `truncations == []` for the paged route AND, separately, that
the same book through one bare select IS cut (1,200 → 1,000) — a gate over
a book the cap never touched would prove nothing. Auto-ids are
`<table>-000042`, sequential, so the new `LINE_ITEM_ORDER = "id.asc"`
reads the fixtures' line items in insertion order and the rebuild sums in
the same order every run.

**Assumption stated, not measured:** `PAGE_ROWS` must not exceed the
deployment's `db-max-rows`. Supabase's default is 1000 and the double
mirrors it; a deployment with a LOWER cap returns pages shorter than
`PAGE_ROWS` and the walk would read the first as the last. Lower
`PAGE_ROWS` with the cap. `IN_CHUNK = 100` (~4.5 KB of url-encoded query
per filter) is the conservative shape for the request line; no upstream
414 threshold is pinned by it.

## Plants — every gate observed RED through its OWN message, then GREEN

All five driven in the ISOLATED copy `scratchpad/lane_sandbox_a1a2`
(`scratchpad/lane_plants.py`, log `lane_plants_a1a2.log`); the checkout
was never planted. PRISTINE sandbox first: `-k "test_a1 or test_a2 or
test_c9"` → 11 passed.

**Plant A1-a** — `src/engine/api/_reconcile.py`, the eager read back:
```
 _LAZY_CONSTANTS = ("PROMPT_VERSION", "AI_MODEL")
+from engine.ai import registry as _model_registry  # PLANT A1-a: the eager read, back
+PROMPT_VERSION = _model_registry.params_for("reconcile_proposal")["prompt_version"]
+AI_MODEL = _model_registry.model_for("reconcile_proposal")
```
RED — `-k "test_a1 or test_c9"`, exit 1, 4 failed / 1 passed in 2.63 s:
```
[C9] … AI modules after import = 0; after first compute = 2; …
E   AssertionError: C9 — the FIRST COMPUTE over a real client loaded the server / an AI subsystem (the served reader's import graph reaches the model registry again): ['engine.ai', 'engine.ai.registry'] (server loaded = False)
E   AssertionError: A1 — a registry missing the reconcile_proposal role: agras lost its served facts (CASH_RUNWAY reads cash through the gateway): kinds=['DEADLINE', 'DEADLINE', 'DEADLINE'] gaps=['the served statement carries no s…
E   AssertionError: A1 — an unreadable models.yaml: agras lost its served facts (CASH_RUNWAY reads cash through the gateway): kinds=['DEADLINE', 'DEADLINE', 'DEADLINE'] gaps=['the served statement carries no status (the served rea…
E   AssertionError: A1 — the served money facts did not survive the dead registry: {'org-agras': ['DEADLINE', 'DEADLINE', 'DEADLINE']}
FAILED test_c9_the_transitive_ai_load_is_measured_over_a_real_client_at_import_and_at_first_compute
FAILED test_a1_dead_registry_missing_role_the_board_renders_every_client_complete
FAILED test_a1_dead_registry_unreadable_file_the_board_renders_every_client_complete
FAILED test_a1_route_answers_200_with_every_client_under_a_dead_registry_and_names_what_is_absent
```
(Note what the plant shows: with the eager read back, the board no longer
DIES — the facts.py guard turns the raise into a gap — but it LOSES the
served facts, and the gates say which ones. The old empty-list C9 would
have stayed green: "after first compute = 2" is only visible over a real
client.) REVERT → 5 passed.

**Plant A1-b** — `src/engine/firm/facts.py`, the guard narrowed to nothing:
```
-            except Exception as exc:  # noqa: BLE001 — the served reader raised
+            except ZeroDivisionError as exc:  # PLANT A1-b: the guard narrowed to nothing
```
RED — `-k test_a1_a_served_reader`, exit 1: `E   RuntimeError: served reader planted to raise` /
`FAILED …::test_a1_a_served_reader_that_raises_is_a_gap_on_the_period_never_a_dead_board`. REVERT → passed.

**Plant A1-c** — `src/engine/api/_firm_attention.py`, the rebuild failure swallowed again:
```
-                raise StatementsRebuildUnavailable(reason)
+                return None  # PLANT A1-c: swallowed again, the data blamed
```
RED — `-k test_a1_route`, exit 1:
```
[A1/route] dead registry (missing role): HTTP 200, rows={'org-agras': ['CASH_RUNWAY', …]}, pipeline importable=False, …
E   AssertionError: A1 — the statements rebuild's absence is not stated with its cause (the registry): gaps=['findings not computed: no assembled statements available for this period']
```
REVERT → passed.

**Plant A2-a** — `src/engine/api/_firm_attention.py`, one read, no walk (the unpaged read, back):
```
-        if len(page) < page_rows:
-            return rows
+        return rows  # PLANT A2-a: one read, no walk (the unpaged read, back)
```
RED — `-k "test_a2 or fc9"`, exit 1, 3 failed / 3 passed in 5.93 s (the FC9 route gate stays
green — 4 clients never reach the cap, which is exactly why it could not see A2):
```
E   AssertionError: assert (1000 == 2500)
E   AssertionError: A2 CLIENTS LOST — 1000 of 1200 clients on the board (PostgREST's cap truncated an unpaged read)
E   AssertionError: A2 PERIODS LOST — 100 client(s) had fewer than 12 period rows read: [('org-0000', 10), ('org-0001', 10), ('org-0002', 10), ('org-0003', 10), ('org-0004', 10)]
FAILED …::test_a2_select_all_walks_an_ordered_page_sequence_and_refuses_an_unordered_one
FAILED …::test_a2_twelve_hundred_clients_page_past_the_cap_and_every_client_appears
FAILED …::test_a2_hundred_clients_twelve_periods_lose_no_period_past_the_cap
```
REVERT → 5 passed.

**Plant A2-b** — `tests/engine/firm_postgrest_double.py`, the cap the double did not model:
```
-    MAX_ROWS = 1000
+    MAX_ROWS = 10 ** 9  # PLANT A2-b: the cap the double did not model
```
RED — `-k test_a2`, exit 1, 3 failed / 2 passed: `E   AssertionError: assert (1200 == 1000)` /
`FAILED …::test_a2_the_double_caps_at_max_rows_like_postgrest_and_records_only_the_caps_cuts`,
`…::test_a2_hundred_clients_twelve_periods_lose_no_period_past_the_cap` (its
`n * per > MAX_ROWS` precondition), `…::test_a2_the_cap_is_visible_when_a_read_is_not_paged`.
The gate refuses a double that stops modelling the cap. REVERT → 5 passed.

## BATTERY LINES — handed to the coordinator VERBATIM (UNREGISTERED until applied to `scripts/run_battery.py::_engine_gates()`)

`-k "test_a1 or test_c9"` across both files collects 5 (floor 5); `-k
test_a2` collects 5 (floor 5); `-k fc9` still collects 3 (floor 3) — its
selection is unchanged, its route-shaped test now drives the paged reads
(5 light reads, one page each), so only its comment moves.

```python
        # FC9 is GATED (wave 2): the measured cold p50 / warm / incremental
        # numbers are held to budgets derived from the measurement, and the
        # second test drives the ROUTE's shape — 12 periods per client through
        # _load_book's real PostgREST calls (a PostgREST-faithful double that
        # caps at db-max-rows, wave 3) and pipeline._rebuild_assembled_for_
        # briefing — counting the heavy reads a warm open (0) and a one-client
        # change (exactly 36) cause. The five light reads are select_all
        # pages (one each below the cap).
        Gate("firm-attention-fc9",
             [PY, "-m", "pytest", "tests/engine/test_firm_attention.py",
              "tests/engine/test_firm_route.py", "-q", "-k", "fc9"],
             work_junit=True, floor=3, units="tests",
             canaries=("test_fc9_two_hundred_clients_compute_incrementally_and_the_p50_is_measured",
                       "test_fc9_route_shape_twelve_periods_per_client_through_the_real_reads")),
        # A1 / C9 — the deterministic board over REAL clients loads no AI
        # module and does not depend on the model registry: models.yaml
        # missing a role, or unreadable, and the board renders every client
        # COMPLETE (fresh subprocess, agras + carniprod, served CASH_RUNWAY
        # present, 0 AI modules after the compute); the AI seam
        # (_reconcile.AI_MODEL) states the registry's own error. The route
        # answers 200 and NAMES the one part pipeline's import graph still
        # ties to the registry. Plant log: design_review/firm/GATES.md § WAVE 3.
        Gate("firm-attention-dead-registry",
             [PY, "-m", "pytest", "tests/engine/test_firm_attention.py",
              "tests/engine/test_firm_route.py", "-q", "-k", "test_a1 or test_c9"],
             work_junit=True, floor=5, units="tests",
             canaries=("test_a1_dead_registry_missing_role_the_board_renders_every_client_complete",
                       "test_c9_the_transitive_ai_load_is_measured_over_a_real_client_at_import_and_at_first_compute")),
        # A2 — PostgREST caps every response at db-max-rows (Supabase 1000),
        # silently. The double caps at exactly PAGE_ROWS and records the cut;
        # the route walks pages over a total order and chunks in.() filters.
        # 1,200 clients and 100 x 12 periods through the route, every client
        # and every row present; the unpaged read reds with
        # "A2 CLIENTS LOST — 1000 of 1200". Plant log: GATES.md § WAVE 3.
        Gate("firm-attention-pagination",
             [PY, "-m", "pytest", "tests/engine/test_firm_route.py", "-q", "-k", "test_a2"],
             work_junit=True, floor=5, units="tests",
             canaries=("test_a2_twelve_hundred_clients_page_past_the_cap_and_every_client_appears",
                       "test_a2_hundred_clients_twelve_periods_lose_no_period_past_the_cap")),
```

## `docs/engine_book/gates.md` — handed to the coordinator (not edited here)

1. `## firm-attention-fc9`: add one sentence — "The route-shaped test's
   five light reads are `select_all` pages (wave 3); the double caps at
   `db-max-rows` = 1000, so a read that stops paging reds
   `firm-attention-pagination`, not this gate (4 clients never reach the cap)."
2. NEW `## firm-attention-dead-registry`:

   | | |
   |---|---|
   | command | `python -m pytest tests/engine/test_firm_attention.py tests/engine/test_firm_route.py -q -k "test_a1 or test_c9"` |
   | work count | junit-xml, floor **5** tests |
   | canary | `test_a1_dead_registry_missing_role_the_board_renders_every_client_complete`, `test_c9_the_transitive_ai_load_is_measured_over_a_real_client_at_import_and_at_first_compute` |

   followed by the A1-a / A1-b / A1-c plant blocks above (PLANT / RED /
   REVERT) and the incident line: "descends from critic A1 (2026-09-04):
   the C9 guard measured an empty client list; over one real client the
   board depended on `models.yaml` resolving at `_reconcile` import."
3. NEW `## firm-attention-pagination`:

   | | |
   |---|---|
   | command | `python -m pytest tests/engine/test_firm_route.py -q -k test_a2` |
   | work count | junit-xml, floor **5** tests |
   | canary | `test_a2_twelve_hundred_clients_page_past_the_cap_and_every_client_appears`, `test_a2_hundred_clients_twelve_periods_lose_no_period_past_the_cap` |

   followed by the A2-a / A2-b plant blocks above and the incident line:
   "descends from critic A2 (2026-09-04): `_supabase.select` sends no
   Range header; PostgREST truncates at db-max-rows (1000) silently; past
   it clients vanished from the board."

## `src/engine/api/_supabase.py` — diff handed, NOT applied (IMPORT, NEVER EDIT)

The page walk needs nothing from this file today (`offset` travels inside
`filters`, which `select` forwards verbatim — the same wire `limit` uses).
The first-class form, for when the coordinator wants the keyword explicit:

```diff
--- a/src/engine/api/_supabase.py
+++ b/src/engine/api/_supabase.py
@@ def select(self, table: str, *, filters: Optional[Dict[str, str]] = None,
     def select(self, table: str, *, filters: Optional[Dict[str, str]] = None,
                columns: str = "*", limit: Optional[int] = None,
+               offset: Optional[int] = None,
                order: Optional[str] = None, single: bool = False) -> List[Dict[str, Any]]:
+        """One PostgREST read. PostgREST caps EVERY response at the
+        deployment's ``db-max-rows`` (Supabase default 1000) with no error
+        and no marker in the body: a list read that may exceed it must
+        page — ``limit`` + ``offset`` over a TOTAL ``order`` (a unique
+        tiebreaker last), stopping on a page shorter than ``limit``.
+        ``engine.api._firm_attention.select_all`` is the reference walk."""
         params: Dict[str, str] = {"select": columns}
         if filters:
             params.update(filters)
         if limit is not None:
             params["limit"] = str(limit)
+        if offset is not None:
+            params["offset"] = str(offset)
         if order is not None:
             params["order"] = order
```

Every OTHER unbounded `select` in the engine (`_firm.py`, `_firm_requests.py`,
`_billing.py`, `pipeline.py`, …) is outside this lane and still reads one
capped page; `select_all` is importable from `_firm_attention` as the
shape to reuse, and belongs in `_supabase` once the diff above lands.

## Notes for the coordinator — wave 3

- **One file outside the YOURS list was edited: `src/engine/api/_reconcile.py`**
  (unmodified in the tree before this wave; on no never-edit / do-not-touch
  list; named by A1 as the seam — "must import it lazily behind the one
  seam that needs it"). The edit is the registry read moved to first
  touch, 40 lines, behaviour-identical for every reader (299 tests across
  its ten reader suites, the sentinel fresh-load included). `engine/ai/
  __init__.py` and `engine/ai/registry.py` docstrings still say `_reconcile`
  imports the registry "at module level" — two comment lines, not mine;
  hand-corrected by whoever next touches them.
- **`engine.api._firm_attention` is shared with the walls lane** (W4, the
  suppressions route): their identity check landed in `list_suppressions`
  while this wave edited `_load_book` / `read_optional_table`; both sets
  coexist (re-read in full before every edit; the file's mtime moved under
  this lane once). Nothing in the suppressions route was touched here.
- **The route's presence count is measured, not hidden:** a LIVE request
  loads 13 AI modules through `engine.api.pipeline`'s import graph
  (`_rebuild_assembled_for_briefing` lives there). Presence, not use; the
  dead-registry 200 proves nothing reads it on the request. R1 above is
  the follow-up that lands it at 0.
- The critics' `crit_maxrows.py` needs 11 minutes (100 × 12 REAL rebuilds,
  twice). The A2 gates make the same measurement on detached rows in ~1.3 s;
  a gate that takes eleven minutes is a gate nobody runs.

---

# PART D — THE WALLS LANE (W1 · W2 · W3 · W4 · W5), 2026-09-05

**Lane:** two walls on every WRITE, the surface from the REAL app.
**Owns:** `src/engine/api/{_firm,_firm_requests,_firm_brief,_firm_invites,_firm_import}.py`,
`_firm_attention.py` (the suppressions route only — see the coordination
sentence), `supabase/schema_phase_firm.sql`, `supabase/schema_phase_firm_requests.sql`,
`tests/engine/{test_firm_tenancy,test_firm_requests_flow,test_firm_brief,test_firm_migration}.py`,
`tests/engine/firm_fakes.py`.
**The ruling:** the Cockpit stays uncommitted until the cross-tenant WRITE is
closed — FC1 covers READS AND WRITES on every route, API and Capsule tool,
demonstrates a red on a planted cross-firm write, and passes.

## What the critics proved, and what closed it

| # | finding (file:line, verified) | what changed | the gate that reds on it |
|---|---|---|---|
| W1 | `PUT /api/firm/cadence` never touched the row as the caller — `authorize_client` then `_supabase.admin().upsert`; with the Python wall patched open a firm-B owner overwrote firm-A's client's cadence (`firm_id` A → B, `set_by` → B's owner, the nudge days → None). `firm_client_cadence` had no insert/update policy by design. The plant drove reads only. | EVERY write a signed-in user makes is the CALLER's own (`_supabase.per_user`) under an INSERT / UPDATE policy through the tenancy helpers: `firm_client_cadence firm write / firm update`, `firm_file_requests firm write / firm update` (the revocation), `firm_digest_prefs own insert / own update` (now also `is_firm_member_of(firm_id)`), `firm_briefs firm write / firm update`; the CSV importer creates each client through a new SECURITY DEFINER RPC `import_firm_client` (asks `firm_can(p_firm_id, 'import')`, refuses a duplicate CUI / a non-member accountant, writes org + memberships + assignment + audit in one transaction) called AS THE USER. An RLS refusal is a 403 naming the table (`write_as_caller`), never swallowed, never a 500; the revocation is re-read as the caller so a zero-row UPDATE cannot be reported as "revoked". Service-role writes that remain are declared with the secret that gates them (crons, token landing, admin drain, the secret token table, the queues) and the write-site CENSUS refuses an undeclared one. | `test_fc1_every_write_refuses_an_intruder_and_the_row_stays` (13 writes × 4 intruders), **`test_fc1_write_plant_python_wall_open_rls_refuses_then_the_leak`** (13 writes × 2 intruders: Python wall removed by hand → the SQL wall refuses, row byte-identical; SQL wall loosened → the SAME write lands), `test_fc1_the_write_policy_refuses_on_its_own_when_the_read_policy_is_loosened` (the insert WITH CHECK / update USING / RPC guard alone), `test_fc1_the_write_plant_names_the_route_and_the_row_when_the_service_role_writes` (the critics' exact defect, in memory, the message on record), `test_fc1_the_brief_cache_write_is_walled_by_rls_and_carries_its_clients`, `test_write_site_census_every_write_is_the_callers_or_declared_service_role`, `test_firm_modules_never_write_to_a_clients_books` (the importer's writes are the RPC's). |
| W2 | Route discovery caught ONE import shape of four: `server_firm_routers()` matched only a relative `from ._firmX import build_router as …` paired with `include_router`; an absolute import, a `from . import _firm_leak` reference, or a module named `_cockpit_extra` mounted a router serving `firm_file_requests` with NO auth and FC1 stayed green. The census enumerated the FIXTURE's routes. | The surface is enumerated from **`create_app()`'s own route table** (the real app, built once per module against the manifest URL with boot verification skipped, `config.yaml` by absolute path): the fixture's (method, path, endpoint module.name) set under `/api/firm` and `/api/capsule` must EQUAL the real app's. The census runs over the real app's routes and classifies every one as swept-read, swept-write, swept-by-name (the brief's cache write) or declared-with-reason; every mutating route must be in the write sweep. Every Capsule tool is classified (`CAPSULE_TOOL_CENSUS` == `TOOL_ALLOWLIST`), asserted read-only, and driven by six intruders. | `test_the_fixture_mounts_exactly_what_create_app_mounts`, `test_every_mounted_firm_route_is_swept_or_declared`, `test_every_capsule_tool_is_classified_and_read_only`, `test_fc1_every_capsule_tool_refuses_firm_a_client_data_to_anyone_but_its_members` (8 tools). |
| W3 | `firm_client_cadence` followed the client across firms: its firm-read policy was bare `can_read_client_org`; after detach A → attach B, firm-B's viewer read the row firm A wrote (`firm_id` = A, `set_by` = A's accountant), at the route and at RLS alone. | The policy pins the row to the client's CURRENT firm: `can_read_client_org(client_org_id) and (firm_id is null or firm_id = firm_of_org(client_org_id))`; the route pins the same way (`_cadence_row(…, firm_id)`, also in the brief's report provider), so EITHER wall alone leaves firm B nothing of firm A's era; the upsert's conflict half lets whoever serves the client NOW replace the row (and the replacement must pass the same pin). | `test_w3_a_reattached_client_leaves_firm_b_nothing_of_firm_as_cadence_or_brief`, `test_w3_the_cadence_pin_holds_at_the_route_with_rls_loosened_and_at_rls_with_the_route_loosened`. |
| W4 | `GET /api/firm/attention/suppressions` had no identity check (a `startswith("bearer ")` shape test only); in the fixture a garbage JWT returned 200 with the secret suppression because the double aliased an undecodable JWT to the service role — a fidelity gap unpinned in both directions. | The route calls `_org.resolve_user_id(jwt)` like every sibling. The double's `_Client` carries an explicit `service_role` flag: `admin()` is the ONLY service role; an undecodable bearer is PostgREST's `anon` (auth.uid() NULL — nothing visible, nothing writable, no RPC). Both directions pinned, and EVERY swept route (14 firm-model + 8 cockpit + 4 attention + 13 write + 8 Capsule) is driven with four garbage bearers → 401, no marker, nothing moved. | `test_w4_the_double_refuses_an_undecodable_jwt_in_both_directions`, `test_w4_every_swept_route_refuses_a_bearer_it_cannot_read_with_401` (47 routes), `test_w4_the_suppressions_route_checks_identity_like_its_siblings`. |
| W5 | `firm_briefs` firm-read had no client dimension: a firm-A brief row stayed readable by firm-A viewers after the client detached to B, and brief payloads carry client names. | `firm_briefs.client_org_ids uuid[]` — every client the brief names, written by the route (`brief_client_ids`) — and the SECURITY DEFINER helper `firm_brief_clients_readable(firm_id, client_org_ids)` (`unnest` … `firm_of_org(u.id) is distinct from _firm_id` / `not is_member_of(u.id)`) in the read AND write policies: a brief naming a client that left is unreadable to the firm it left, the moment it leaves. | `test_w3_a_reattached_client_leaves_firm_b_nothing_of_firm_as_cadence_or_brief` (the brief half), `test_fc1_the_brief_cache_write_is_walled_by_rls_and_carries_its_clients`, `test_fc1_rls_shows_firm_a_rows_to_firm_a_roles_by_the_read_cell`. |

**The double learned what the writes need** (tests/engine/test_firm_tenancy.py):
UPDATE policies parsed (USING + WITH CHECK, `with check` defaulting to `using`
as Postgres does); a per-user UPDATE touches only rows the SELECT policies
show AND an update USING selects, and refuses (42501) a new row no WITH CHECK
admits; a per-user UPSERT is the INSERT WITH CHECK on the proposed row first
and, on conflict, the UPDATE policies on the existing row — an ERROR, not a
skip; `is [not] distinct from`; set-returning FROM items (`unnest(x) as u(id)`)
so the brief helper's body is EVALUATED, not mirrored; `plant_write_policy` /
`plant_function` (the base `is_member_of` included) for the plants; and the
`import_firm_client` RPC with its guard read out of the SQL body
(`_require_action` refuses to enforce a guard the SQL no longer asks).

**A trap fixed on the way:** `parse_policies` advanced past a USING expression
by the length of its STRIPPED text, so a `with check (…)` after a USING whose
parenthesised body had leading/trailing whitespace was never seen. Nothing
was wrong in the migrations because no such policy existed; the first update
policy with both clauses would have been parsed as USING-only.

**Coordination — the attention lane, one sentence:** the ONE edit in
`_firm_attention.py` is the identity line in `GET /attention/suppressions`
(`_org.resolve_user_id(jwt)`); everything else there — including A1 (C9
measured against an empty client list) and A2 (`_supabase.select` sends no
Range header and no offset loop, so the board's `financial_periods` read is
truncated at db-max-rows; the critics' `crit_maxrows.py` is the harness) — is
theirs, untouched here. If pagination lands in `_supabase.py` (a `select_all`
that walks `Range` pages), hand the diff against `_supabase.select`'s
signature; the route double already logs every call.

## STATUS, AS MEASURED — 2026-09-05

Every pytest run with `-p netblock` (any outbound socket connect raises) and
the production keys stripped (`ANTHROPIC_API_KEY`, `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`PUBLIC_TEST_MODE`, `ENGINE_API_TOKEN`).

```
tests/engine/test_firm_tenancy.py -q -p netblock              513 passed in 42.19s   (was 368)
tests/engine/test_firm_*.py -q -p netblock (every firm suite)  762 passed in 68.68s   (was 607)
scripts/corpus_replay.py                                       CORPUS REPLAY: PASS — 18 case(s)
scripts/check_import_boundary.py                               boundary holds (engine=OK, frontend=OK, private-fields=OK), 1687 files
scripts/check_metric_declared.py                               PASS — every metric a surface can request is declared
node scripts/check_no_plants.mjs                               PASS — no planted defects in 897 product source files
tests/engine/test_route_bindings.py + test_cron_auth.py        11 passed (the REAL app builds and binds; the crons fail closed)
fresh-process import FIRST, 18 modules (src/engine/firm/*.py + _firm*.py)
                                                               all OK; engine.ai=False server=False everywhere except
                                                               engine.api._firm_brief (engine.ai=True, server=False)
tests/engine/test_gate_canaries.py                             13 passed
tests/engine/test_engine_book.py::test_regeneration_is_byte_identical
                                                               FAIL — architecture.md DRIFT: the radar package, engine.firm._deps,
                                                               two public modules, finding_sharpen — other lanes' new modules;
                                                               this lane added none (regenerated in a copy and diffed).
                                                               The coordinator's pending regeneration, unchanged from 2026-09-04.
```

The write sweep, with the Python wall REMOVED BY HAND, as the routes answered
(`scratchpad/probe_write_walls.py`, the transcript the plant asserts on):

```
cadence-put        B_OWNER  python-wall-open -> 403  moved=False  Write to firm_client_cadence refused by row-level security …
requests-create    B_OWNER  python-wall-open -> 404  moved=False  Workspace not found.   (organizations firm read; the insert WITH CHECK alone: test_fc1_the_write_policy_refuses_on_its_own…)
requests-revoke    B_OWNER  python-wall-open -> 404  moved=False  Request not found.     (firm_file_requests firm read; the update USING alone: idem)
digest-prefs-put   B_OWNER  python-wall-open -> 403  moved=False  Write to firm_digest_prefs refused by row-level security …
attention-suppress B_OWNER  python-wall-open -> 403  moved=False  Suppression refused: … 42501 …
assignment         B_OWNER  python-wall-open -> 403  moved=False  Your firm role does not hold 'assign'.        (assign_client, SQL body)
detach             B_OWNER  python-wall-open -> 403  moved=False  Only the workspace owner or the firm's manager can detach it.
attach             B_OWNER  python-wall-open -> 403  moved=False  Only the workspace owner can attach it to a firm.
member-role        B_OWNER  python-wall-open -> 403  moved=False  Your firm role does not hold 'manage'.
member-remove      B_OWNER  python-wall-open -> 403  moved=False  Your firm role does not hold 'manage'.
invitation-create  B_OWNER  python-wall-open -> 403  moved=False  Your firm role does not hold 'invite'.
invitation-revoke  B_OWNER  python-wall-open -> 404  moved=False  Invitation not found.  (firm_invitations inviter select; the RPC guard alone: idem)
import             B_OWNER  python-wall-open -> 403  moved=False  Your firm role does not hold 'import'.        (import_firm_client, SQL body)
… and every one of the thirteen, for B_OWNER and for SOLO:  both-walls-open -> 2xx  moved=True
```

## Plants — the walls lane, every gate observed RED through its OWN message, then GREEN

**Method:** an rsync SANDBOX of the tree (`src tests supabase corpus packs
scripts config.yaml pyproject.toml`) in the scratchpad
(`scratchpad/walls_plants.py`, log `walls_plants.log`); each plant applied
there, FC1 run there (`cwd` = sandbox), the sandbox re-synced clean, FC1 run
again. The live tree was never edited by a plant; `diff -rq` of `src`,
`tests`, `supabase` between repo and sandbox is empty afterwards;
`design_review/PLANT_MANIFEST.json` stayed `"plants": []` throughout and
`node scripts/check_no_plants.mjs` PASSES (897 files).

**GREEN** — clean sandbox: `513 passed in 41.76s`.

### P-W1a

**PLANT** — `PUT /api/firm/cadence` writes `firm_client_cadence` through `_supabase.admin()` again — the exact W1 defect the critics drove (firm-B owner overwrote firm-A's client's cadence with the Python wall patched open).

**RED** — `exit 1 in 44.2s`, `======================== 3 failed, 510 passed in 43.27s ========================`:

```
E   AssertionError: FC1 WRITE VIOLATED — route cadence-put with the Python wall removed: the SQL wall let 00000000-0000-0000-0000-00000000000b move firm_client_cadence[client_org_id=00000000-0000-0000
E   assert ([{'cadence': ...': None, ...}] == [{'cadence': ...': None, ...}]
E     At index 0 diff: {'client_org_id': '00000000-0000-0000-0000-0000000000c9', 'firm_id': '00000000-0000-0000-0000-000000000065', 'cadence': 'monthly', 'deadline_days_after_period_end': None, 'fisca
E     ...Full output truncated (2 lines hidden), use '-vv' to show)
E   AssertionError: FC1 WRITE VIOLATED — route cadence-put with the Python wall removed: the SQL wall let 00000000-0000-0000-0000-000000000015 move firm_client_cadence[client_org_id=00000000-0000-0000
E   assert ([{'cadence': ...': None, ...}] == [{'cadence': ...': None, ...}]
FAILED tests/engine/test_firm_tenancy.py::test_fc1_write_plant_python_wall_open_rls_refuses_then_the_leak[b_owner-cadence-put]
FAILED tests/engine/test_firm_tenancy.py::test_fc1_write_plant_python_wall_open_rls_refuses_then_the_leak[solo-cadence-put]
FAILED tests/engine/test_firm_tenancy.py::test_write_site_census_every_write_is_the_callers_or_declared_service_role
```

**REVERT** — re-synced clean.

### P-W1b

**PLANT** — `schema_phase_firm_requests.sql`: `firm_client_cadence firm write` WITH CHECK and `firm update` USING / WITH CHECK loosened to `true` (the route untouched).

**RED** — `exit 1 in 44.1s`, `======================== 2 failed, 511 passed in 43.06s ========================`:

```
E   AssertionError: FC1 WRITE VIOLATED — route cadence-put with the Python wall removed: the SQL wall let 00000000-0000-0000-0000-00000000000b move firm_client_cadence[client_org_id=00000000-0000-0000
E   assert ([{'cadence': ...': None, ...}] == [{'cadence': ...': None, ...}]
E     At index 0 diff: {'client_org_id': '00000000-0000-0000-0000-0000000000c9', 'firm_id': '00000000-0000-0000-0000-000000000065', 'cadence': 'monthly', 'deadline_days_after_period_end': None, 'fisca
E     ...Full output truncated (2 lines hidden), use '-vv' to show)
E   AssertionError: FC1 WRITE VIOLATED — route cadence-put with the Python wall removed: the SQL wall let 00000000-0000-0000-0000-000000000015 move firm_client_cadence[client_org_id=00000000-0000-0000
E   assert ([{'cadence': ...': None, ...}] == [{'cadence': ...': None, ...}]
FAILED tests/engine/test_firm_tenancy.py::test_fc1_write_plant_python_wall_open_rls_refuses_then_the_leak[b_owner-cadence-put]
FAILED tests/engine/test_firm_tenancy.py::test_fc1_write_plant_python_wall_open_rls_refuses_then_the_leak[solo-cadence-put]
```

**REVERT** — re-synced clean.

### P-W1c

**PLANT** — `_firm_import.py`: the `import_firm_client` RPC call replaced by the old service-role inserts of `organizations` / `memberships` / `client_assignments`.

**RED** — `exit 1 in 56.0s`, `======================== 5 failed, 508 passed in 55.00s ========================`:

```
E   KeyError: '00000000-0000-0000-0000-000000000003'
E   AssertionError: a firm-model write outside the guarded RPCs: [('_firm_invites.py', 'enqueue_invitation_email', 'service', 'firm_invite_email_queue', 117), ('_firm_import.py', 'import_clients', 'se
E   assert {'client_assi...rganizations'} == {'firm_invite_email_queue'}
E     Extra items in the left set:
E     'organizations'
E     'memberships'
FAILED tests/engine/test_firm_tenancy.py::test_import_creates_clients_honestly
FAILED tests/engine/test_firm_tenancy.py::test_firm_modules_never_write_to_a_clients_books
FAILED tests/engine/test_firm_tenancy.py::test_fc1_write_plant_python_wall_open_rls_refuses_then_the_leak[b_owner-import]
FAILED tests/engine/test_firm_tenancy.py::test_fc1_write_plant_python_wall_open_rls_refuses_then_the_leak[solo-import]
FAILED tests/engine/test_firm_tenancy.py::test_write_site_census_every_write_is_the_callers_or_declared_service_role
```

**REVERT** — re-synced clean.

### P-W2

**PLANT** — `server.py` mounts TWO extra routers by the shapes the AST regex could not see: `import engine.api._cockpit_extra as _cx` (absolute import, a module not named `_firm*`) and `from . import _firm_leak` (a module reference) — both serving `firm_file_requests` / `firm_client_cadence` service-role with NO auth under `/api/firm/leak/*`, one of them a POST that upserts the cadence.

**RED** — `exit 1 in 43.3s`, `======================== 2 failed, 511 passed in 42.28s ========================`:

```
E   AssertionError: FC1 SURFACE INCOMPLETE — create_app() serves route(s) the fixture does not mount (a router reached server.py by an import shape the fixture roster ('_firm', '_firm_requests', '_fir
E   assert not {('GET', '/api/firm/leak/cadence', 'engine.api._firm_leak.leak'), ('GET', '/api/firm/leak/requests', 'engine.api._cockpit_extra.leak'), ('POST', '/api/firm/leak/cadence', 'engine.api._c
E   AssertionError: FC1 CENSUS — route(s) mounted under /api/firm that no sweep drives and no declaration explains: [('GET', '/api/firm/leak/cadence'), ('GET', '/api/firm/leak/requests'), ('POST', '/a
E   assert not {('GET', '/api/firm/leak/cadence'), ('GET', '/api/firm/leak/requests'), ('POST', '/api/firm/leak/cadence')}
E   AssertionError: FC1 SURFACE INCOMPLETE — create_app() serves route(s) the fixture does not mount (a router reached server.py by an import shape the fixture roster ('_firm', '_firm_requests', '_fir
E   AssertionError: FC1 CENSUS — route(s) mounted under /api/firm that no sweep drives and no declaration explains: [('GET', '/api/firm/leak/cadence'), ('GET', '/api/firm/leak/requests'), ('POST', '/a
FAILED tests/engine/test_firm_tenancy.py::test_the_fixture_mounts_exactly_what_create_app_mounts
FAILED tests/engine/test_firm_tenancy.py::test_every_mounted_firm_route_is_swept_or_declared
```

**REVERT** — re-synced clean.

### P-W3

**PLANT** — `firm_client_cadence firm read` back to bare `can_read_client_org(client_org_id)` AND `_cadence_row`'s firm pin removed — the W3 defect whole: firm A's cadence row (firm_id = A, set_by = A's accountant) follows the client to firm B.

**RED** — `exit 1 in 46.4s`, `======================== 3 failed, 510 passed in 45.35s ========================`:

```
E   AssertionError: assert 'firm_id = firm_of_org(client_org_id)' in 'can_read_client_org(client_org_id)'
E   AssertionError: W3 VIOLATED — firm B reads firm A's cadence at the route: {"cadence":{"client_org_id":"00000000-0000-0000-0000-0000000000c9","cadence":"quarterly","period_months":3,"deadline_days_
E   assert ('stored' == 'pack_default'
E     - pack_default
E     + stored)
E   AssertionError: W3 VIOLATED at the route alone: {"cadence":{"client_org_id":"00000000-0000-0000-0000-0000000000c9","cadence":"quarterly","period_months":3,"deadline_days_after_period_end":25,"fisc
FAILED tests/engine/test_firm_tenancy.py::test_the_double_evaluates_the_cockpit_policy_bodies_not_a_mirror
FAILED tests/engine/test_firm_tenancy.py::test_w3_a_reattached_client_leaves_firm_b_nothing_of_firm_as_cadence_or_brief
FAILED tests/engine/test_firm_tenancy.py::test_w3_the_cadence_pin_holds_at_the_route_with_rls_loosened_and_at_rls_with_the_route_loosened
```

**REVERT** — re-synced clean.

### P-W4a

**PLANT** — `_firm_attention.py`: `_org.resolve_user_id(jwt)` removed from `GET /api/firm/attention/suppressions` — the W4 route defect.

**RED** — `exit 1 in 44.3s`, `======================== 2 failed, 511 passed in 43.17s ========================`:

```
E   AssertionError: ('attention:attention-suppressions', 'Bearer not-a-jwt', 200, '{"suppressions":[],"notices":[]}')
E   assert 200 == 401
E    +  where 200 = <Response [200 OK]>.status_code
E   AssertionError: {"suppressions":[],"notices":[]}
E   assert (200 == 401)
E    +  where 200 = <Response [200 OK]>.status_code
FAILED tests/engine/test_firm_tenancy.py::test_w4_every_swept_route_refuses_a_bearer_it_cannot_read_with_401[attention:attention-suppressions]
FAILED tests/engine/test_firm_tenancy.py::test_w4_the_suppressions_route_checks_identity_like_its_siblings
```

**REVERT** — re-synced clean.

### P-W4b

**PLANT** — `test_firm_tenancy.py`'s `_per_user`: an undecodable JWT becomes `_Client(..., service_role=True)` again — the W4 fidelity gap that hid P-W4a (with the double aliasing, a garbage bearer read every suppression and the missing identity check looked like a wall).

**RED** — `exit 1 in 48.3s`, `======================== 1 failed, 512 passed in 47.29s ========================`:

```
E   AssertionError: Bearer not-a-jwt
E   assert (True is False)
E    +  where True = <test_firm_tenancy._Client object at 0x119a26310>.service_role
E   AssertionError: Bearer not-a-jwt
FAILED tests/engine/test_firm_tenancy.py::test_w4_the_double_refuses_an_undecodable_jwt_in_both_directions
```

**REVERT** — re-synced clean.

**FINAL GREEN after the last revert** — `513 passed in 46.56s`.

```
live tree diff vs sandbox (must be empty for src/tests/supabase):
  src: identical
  tests: identical
  supabase: identical
```

## HANDED TO THE COORDINATOR, VERBATIM (not applied here; TC-8)

`scripts/run_battery.py` `_engine_gates()` — the firm gate lines are NOT in
the battery today (removed 2026-09-04 because the Cockpit tests are
uncommitted; see the comment above `capsule-gates`). Re-add `firm-tenancy-fc1`
as below in the SAME commit that lands the Cockpit tests. Floor 450 = the
measured 513, rounded down; every canary is a test id `-q` collects.

```python
        # FC1 — FIRM TENANCY, reads AND writes (the owner's ruling, 2026-09-04).
        # A member of firm A cannot READ or MOVE any firm-B client row through
        # any route the REAL app mounts under /api/firm (the surface is
        # enumerated from create_app()'s route table, not an import regex),
        # any RPC, or any Capsule tool: two walls on every read and every
        # write — the Python guard and RLS / the RPC's firm_can — each proven
        # to hold with the other removed by hand. Named separately from
        # `pytest` because a cross-tenant write fails SILENTLY. Plant log:
        # design_review/firm/GATES.md § PART D.
        Gate("firm-tenancy-fc1",
             [PY, "-m", "pytest", "tests/engine/test_firm_tenancy.py", "-q"],
             work_junit=True, floor=450, units="tests",
             canaries=("test_fc1_plant_cross_firm_read_is_blocked_at_both_walls",
                       "test_fc1_plant_cross_firm_cockpit_read_is_blocked_at_both_walls",
                       "test_fc1_write_plant_python_wall_open_rls_refuses_then_the_leak[b_owner-cadence-put]",
                       "test_fc1_write_plant_python_wall_open_rls_refuses_then_the_leak[solo-import]",
                       "test_fc1_the_write_plant_names_the_route_and_the_row_when_the_service_role_writes",
                       "test_fc1_the_brief_cache_write_is_walled_by_rls_and_carries_its_clients",
                       "test_write_site_census_every_write_is_the_callers_or_declared_service_role",
                       "test_the_fixture_mounts_exactly_what_create_app_mounts",
                       "test_every_mounted_firm_route_is_swept_or_declared",
                       "test_every_capsule_tool_is_classified_and_read_only",
                       "test_w3_a_reattached_client_leaves_firm_b_nothing_of_firm_as_cadence_or_brief",
                       "test_w4_the_double_refuses_an_undecodable_jwt_in_both_directions",
                       "test_w4_every_swept_route_refuses_a_bearer_it_cannot_read_with_401[attention:attention-suppressions]",
                       "test_fc1_solo_workspace_is_untouched",
                       "test_fc1_rls_shows_firm_a_rows_to_firm_a_roles_by_the_read_cell",
                       "test_c3_a_reattached_client_does_not_carry_the_previous_firms_requests")),
```

No new gate: the write sweep, the write-site census, the real-app surface and
the identity sweep all ride `firm-tenancy-fc1` — one gate, one name, one
plant log. (`firm-imports` — the walls lane's earlier hand-off, floor 30,
`tests/engine/test_firm_imports.py`, 37 tests — stands as handed on
2026-09-04 and is unchanged by this pass.)

`docs/engine_book/gates.md` `## firm-tenancy-fc1` — replace the header table
and append the plants; UNREGISTERED until applied:

| | |
|---|---|
| command | `python -m pytest tests/engine/test_firm_tenancy.py -q` |
| work count | junit-xml, floor **450** tests (measured: 513) |
| canary | the sixteen ids in the Gate line above |

One paragraph after the table: *"Extended 2026-09-05 to WRITES and to the
REAL app's surface. Every write a signed-in user can make under /api/firm —
cadence, request, revocation, digest preference, suppression, brief cache,
assignment, attach, detach, role, removal, invitation, revocation, CSV
import — is driven by an intruder with the Python wall standing (403, row
unchanged), with the Python wall removed by hand (the SQL wall — an
INSERT/UPDATE policy through the tenancy helpers, or the RPC's own
`firm_can` — refuses it, row byte-identical), and with the SQL wall loosened
too (the SAME write lands, which is what proves the refusals were the
walls). The surface is `create_app()`'s route table, so a router mounted by
any import shape is red until classified; every Capsule tool is classified
and swept; every swept route refuses a bearer the backend cannot read with
401; a client's cadence and brief do not follow it across firms."* — then
the seven PLANT / RED / REVERT blocks above (P-W1a … P-W4b), verbatim.

## OPERATOR RUNBOOK DELTA (the owner's Studio steps; nothing applied here)

1. `supabase/schema_phase_firm.sql` — re-run (idempotent): adds
   `import_firm_client(uuid, text, text, text, text, text, uuid, jsonb)` +
   its revoke/grant; the rollback list gained its drop line.
2. `supabase/schema_phase_firm_requests.sql` — re-run (idempotent; every
   policy is dropped-if-exists first): the write policies on
   `firm_client_cadence` / `firm_file_requests` / `firm_briefs`, the
   tightened `firm_digest_prefs` policies, the pinned cadence read policy,
   `firm_briefs.client_org_ids uuid[] not null default '{}'`, and the helper
   `firm_brief_clients_readable`. Then the Dashboard "Reload schema cache"
   click, then the header's step-4 query — FOURTEEN policy rows expected,
   listed in the file.
3. Existing `firm_briefs` rows get `client_org_ids = '{}'` (readable by the
   firm's `read` cell, as before) until the route re-caches them; existing
   `firm_client_cadence` rows keep their `firm_id` and are visible exactly
   when it is the client's current firm's.

---

# PART E — THE SQL WALLS RE-PINNED; THE SURFACE MEASURED (D1 · D3 · D2), 2026-09-05

**Lane:** the walls lane, second pass (FC1x). **Owns:** `supabase/schema_phase_firm*.sql`
(all three), the suppressions insert/revoke and covenants code path in
`src/engine/api/_firm_attention.py` (`current_era_rows` and its two call sites;
the READ/paging region is the board lane's), `_firm_requests.py::open_request_for`
(the resolve + upload landing), `tests/engine/test_firm_tenancy.py` (the policy /
privilege / trigger region of the double, the D1 · D2 · D3 gates),
`tests/engine/test_firm_migration.py`, this section.
**The ruling stands:** the Cockpit stays uncommitted until FC1 covers READS AND
WRITES on every route the REAL app mounts and reds on a planted cross-firm write.

## What the critics proved (fc1w-4), and what closed it

| # | finding (verified live before the fix) | what changed | the gate that reds on it |
|---|---|---|---|
| D1 HIGH | `firm_attention_suppressions revoke` had `WITH CHECK (revoked_by = auth.uid())` and nothing else. Firm B's owner created a suppression on B's client through the route, then PATCHed THEIR OWN row — supabase-js, anon key + user JWT, no route, no Python wall — to `{org_id: ORG_A1, dismissed_by: A_OWNER, reason: PLANTED-BY-FIRM-B}`: LANDED, `revoked_at` NULL, ACTIVE on firm A's board and in A's `/suppressions`. Supabase's project default (`grant all on tables to anon, authenticated, service_role`) made every column PATCHable; RLS chooses rows, never columns. | Closed TWICE. (a) The revoke `WITH CHECK` re-pins the NEW row through the SAME predicate as the USING — `(is_member_of(org_id) or firm_can(firm_of_org(org_id),'suppress')) and revoked_by = auth.uid()`. (b) Column privileges: `revoke update, delete on firm_attention_suppressions from anon, authenticated; grant update (revoked_at, revoked_by) … to authenticated` — a PATCH naming `org_id`, `dismissed_by`, `dismissed_at`, `kind`, `scope_key`, `firm_id`, `reason` or the period bounds is `42501 permission denied for table …` BEFORE any policy runs (Postgres's order). `reason` is deliberately NOT granted (the file's own contract: identity, kind, scope and reason immutable; the table has ONE reason column, so a revoker who could rewrite it would erase the decision's reason — the audit trail the revoke-not-delete rule exists to keep). EVERY firm table's UPDATE policy swept the same way: `firm_covenants` UPDATE on its editable figures only (identity non-updatable); `firm_file_requests` UPDATE on `(status)`; `firm_digest_prefs` on `(enabled, frequency, send_hour_utc)`; `firms` on `(name, archived_at)`; the two UPSERTED tables (`firm_client_cadence`, `firm_briefs`) keep table-wide UPDATE ON PURPOSE (ON CONFLICT DO UPDATE sets every payload column) and their WITH CHECK re-pins every tenancy column — `firm_briefs` now also pins `firm_key = cast(coalesce(firm_id, user_id) as text)`, the cache lookup key; the no-policy tables (`firm_file_request_tokens`, `firm_email_queue`, `firm_digest_log`, every firm-model table of schema_phase_firm.sql) lose INSERT/UPDATE/DELETE outright; DELETE is revoked from the API roles on every firm table except `firm_covenants` (its delete policy). **The double models column-level grants**: `parse_grants` applies each migration's revoke/grant over the Supabase default in file order; `_Client.insert/upsert/update` check the privilege FIRST (a refused column is 42501 "permission denied for table" even when the filter matches nothing), then the policies. | `test_d1_every_update_policy_in_the_migrations_is_swept` (TC-3 census over parsed UPDATE policies), **`test_d1_a_patch_of_the_callers_own_row_toward_another_firms_client_is_refused_by_each_wall_alone`** (7 tables: both walls → refused; grant opened → WITH CHECK refuses; WITH CHECK loosened → grant refuses; both open → the SAME PATCH lands, row moved), `test_d1_the_planted_suppression_never_reaches_firm_as_board` (the critics' transcript, on the repaired schema; then both walls AND the era pin opened → the marker reaches A's board), `test_d1_the_gate_reds_through_its_own_message_when_the_revoke_check_is_the_old_one`, `test_d1_the_era_pin_is_the_triggers_never_the_callers`, `test_d1_the_privilege_wall_is_parsed_from_the_migrations_not_mirrored` (TC-6 record per table), `test_column_privileges_narrow_the_supabase_default` (test_firm_migration.py). |
| D3 | `firm_attention_suppressions read` and `firm_covenants read` were bare `can_read_client_org(org_id)`: a client moved A → B carried A's suppressions (A's accountant's uuid, the secret reason) and A's covenants (A's owner's uuid, the secret label) to B's viewer — at RLS alone AND at `GET /api/firm/attention/suppressions`. Firm A's signed request link still resolved after the move (`open_request_for` never re-checked `firm_of_org`). | Both tables carry `firm_id` — THE ERA PIN, stamped by a BEFORE INSERT trigger `firm_attention_pin_era()` as `firm_of_org(new.org_id)` whatever the caller sent (a trigger because a column DEFAULT cannot read a sibling column and a GENERATED column must be IMMUTABLE while `firm_of_org` reads `organizations`); the insert WITH CHECKs assert `firm_id is not distinct from firm_of_org(org_id)` (BEFORE ROW triggers run before the WITH CHECK, so the policy sees the stamped value); the firm read policies are `can_read_client_org(org_id) and (firm_id is null or firm_id = firm_of_org(org_id))` beside a `member select` policy (the workspace's own members keep the history — the cadence / requests shape); the migration backfills `firm_id = firm_of_org(org_id)` where NULL. The route pins the same way — `current_era_rows` in `_load_book` (board) and in `list_suppressions` — so either wall alone holds, warm cache included (covenants are in the snapshot key; suppressions are applied per request). `open_request_for` re-checks the era: a request minted by `row.firm_id` answers **410** "issued by a firm that no longer serves this client" once that firm no longer serves the client (detached, or attached elsewhere); a row minted with no firm outlives any firm; an unverifiable era fails CLOSED (503). The double models the trigger: `parse_triggers` + `parse_trigger_assignments` evaluate `new.firm_id := firm_of_org(new.org_id)` on EVERY insert (seed, service role, user) before the WITH CHECK. | `test_d3_the_attention_migration_pins_the_era_in_its_text` (TC-6 record of the SQL), **`test_d3_a_reattached_client_leaves_firm_b_nothing_of_firm_as_suppressions_or_covenants`** (RLS alone for B's viewer; the board and the list for B's viewer AND owner, warm then cold cache; A's firm-only viewer loses both; rows hidden, never scrubbed; the workspace member keeps the history; B's own decision stamped B), `test_d3_the_era_pin_holds_at_the_route_with_rls_loosened_and_at_rls_with_the_route_loosened` (either wall alone; both open → the leak), **`test_d3_a_signed_request_link_dies_when_the_firm_that_minted_it_no_longer_serves_the_client`** (200 → 410 on detach → 410 under B, the upload lands nothing → a no-firm link lives → back with A, 200 again). |
| D2 | `_route_table` skipped every route without `endpoint`/`methods` (Mount, WebSocketRoute), never saw `@app.middleware`, and the prefix scope was a definition. Four sandbox plants SERVED `SECRET-FROM-PLANT` with both W2 gates green: `app.mount('/api/firm/leak', sub_app)`, `add_api_websocket_route('/api/firm/ws', …)`, an http middleware answering `/api/firm/leak6/requests`, `include_router(prefix='/api/cabinet')` reading `firm_file_requests`. | The surface is MEASURED. `_walk_routes` walks `app.routes` RECURSIVELY through every Mount (a sub-app's routes are routes, at the mount's path); `_route_table` takes only FastAPI `APIRoute`s; `_foreign_surface` reds on ANY other shape under `/api/firm` or `/api/capsule` — Mount, (API)WebSocketRoute, raw Starlette Route — by class and path; `app.user_middleware` must EQUAL `DECLARED_MIDDLEWARE = ("CORSMiddleware", "GZipMiddleware")`, an undeclared one red by class name AND dispatch function; and THE TABLE-READ CENSUS: every module of the REAL app's import closure whose source names a firm-model table (parsed from the three migrations, 17 tables) must be in `DECLARED_FIRM_TABLE_READERS`, every route such a module serves must be under a swept prefix, and a new reader of a client-data table (`organizations`, `financial_periods`, `documents`, `statement_line_items`, `alerts`, `recommendations`, `calculated_metrics`, `briefings`) is red until declared — a stranger is red BY THE TABLE IT READS, whatever its prefix. | `test_no_mount_websocket_or_raw_route_serves_the_swept_prefixes`, `test_the_real_app_declares_every_middleware`, `test_every_module_reading_a_firm_table_is_a_declared_firm_module_under_a_swept_prefix`, `test_the_table_census_is_not_vacuous` (TC-3), plus the two PART-D gates (`test_the_fixture_mounts_exactly_what_create_app_mounts`, `test_every_mounted_firm_route_is_swept_or_declared`) now over the recursive walk. |

**A wall-clock time bomb fixed on the way:** the `world` fixture's clock is frozen at
2026-09-03 12:00 UTC while `_firm_invites._now()` read the real clock; an invitation
minted with a 48 h TTL read as EXPIRED to the route from 2026-09-05 12:00 UTC on
(`test_invitation_lifecycle` was red on the untouched tree at 17:2x). The fixture now
pins `_firm_invites._now` to `w.clock` — one clock for the RPC and the route.

## STATUS, AS MEASURED — 2026-09-05 (this host, Python 3.9.6; `-p netblock`, prod keys stripped)

Measured at 17:51 on the tree with this lane's changes and the board lane's
in-flight `_firm_attention.py` paging edits; BEFORE the identity lane switched
`_org.resolve_user_id` to signature verification (17:53) while the suite's
`_jwt()` still minted `alg: none` bearers — from that moment every
authenticated route answers 401 to the suite until their bearer minting lands
(their region; see "NOT closed").

```
tests/engine/test_firm_tenancy.py + test_firm_migration.py + test_firm_attention_migration.py
                                                    554 passed in 48.41s   (tenancy alone: 533 collected; was 513)
tests/engine/test_route_bindings.py + test_cron_auth.py   11 passed in 2.40s
scripts/corpus_replay.py                              CORPUS REPLAY: PASS — 18 case(s)
scripts/check_import_boundary.py                      boundary holds (engine=OK, frontend=OK, private-fields=OK), 1691 files
scripts/check_metric_declared.py                      PASS — every metric a surface can request is declared (59 names, 8 surfaces)
fresh-process import FIRST, 18 modules (src/engine/firm/*.py + _firm*.py)
                                                      all OK; engine.ai=False server=False everywhere except
                                                      engine.api._firm_brief (engine.ai=True, server=False)
tests/engine/test_firm_*.py (every firm suite)        408 failed, 398 passed in 142.70s — run at 17:54, AFTER the
                                                      identity switch: every failure is a 401 from an alg:none
                                                      bearer (test_fc1_positive_control_the_world_is_real first);
                                                      the same suites were green 3 minutes earlier. Re-measure once
                                                      the identity lane's mint_jwt lands in test_firm_tenancy.py.
```

The critics' own harnesses, re-run unchanged against the repaired tree
(`scratchpad/crit_suppression_hole.py`, `crit_supp_board.py`, `crit_reattach.py`,
`crit_cron_reattach.py`; outputs in `scratchpad/fc1x/crit_*.out`):

```
crit_suppression_hole:  PATCH as B_OWNER: refused -> Supabase write to firm_attention_suppressions failed (HTTP 403):
                        {'code': '42501', 'message': 'permission denied for table firm_attention_suppressions'}
                        row now: org_id = ORG_B1, dismissed_by = B_OWNER, reason = "B's own reason"   (byte-identical)
                        double's admit_update verdict for that PATCH: refuse
                        PLANTED-BY-FIRM-B in A's board: False | A_OWNER shown as dismisser: False
                        A_VIEWER /suppressions carries the planted row: False
                        covenants PATCH -> refused (42501) · cadence PATCH -> refused · requests PATCH -> refused
crit_supp_board:        the PATCH now RAISES (42501 permission denied) — the harness never reaches its board read
crit_reattach:          RLS ALONE as B_VIEWER after A -> B: firm_attention_suppressions rows=0, firm_covenants rows=0
                        (were: SECRET-A1-SUPPRESSION-7f3c with A's accountant; SECRET-A1-COVENANT-7f3c with A's owner);
                        every read route: no SECRET marker, no A identity (the 'Client A1' / PERIOD_A1 hits are the
                        client's own identifiers, which B now serves — same as before)
crit_cron_reattach:     B's board after reattach (cache warm from A): identical-to-A=True (both empty of A's era),
                        A_ACCOUNTANT-in-text=False; cold == warm; reminders queued under FIRM A: 0;
                        stale firm-A link: 410 {"detail":"This request link was issued by a firm that no longer serves this client."}
```

## Plants — every gate observed RED through its OWN message, then GREEN

**Method:** an rsync SANDBOX (`scratchpad/walls_fc1x/sandbox`, `src tests supabase corpus packs
scripts config.yaml pyproject.toml`; `scratchpad/walls_fc1x/plants.py`, log `plants.log`);
each plant applied there, the named gate subset run there (`cwd` = sandbox), the sandbox
re-synced clean, the subset run again. The live tree was never edited by a plant;
`design_review/PLANT_MANIFEST.json` stayed `"plants": []` throughout. `E` lines are
cut at 230 characters by the logger.

### P-D1 — the revoke WITH CHECK back to `revoked_by = auth.uid()` AND the Supabase default grant back

```
### PLANT D1  (-k 'd1_')  rc=1  3.3s
E       AssertionError: FC1 WRITE VIOLATED — firm_attention_suppressions: the PATCH landed with both walls standing
E       assert None is not None
E           AssertionError: ('firm_attention_suppressions', {'delete': False, 'insert': True, 'update': True})
E             {'update': True} != {'update': {'revoked_at', 'revoked_by'}}
FAILED tests/engine/test_firm_tenancy.py::test_d1_a_patch_of_the_callers_own_row_toward_another_firms_client_is_refused_by_each_wall_alone[firm_attention_suppressions]
FAILED tests/engine/test_firm_tenancy.py::test_d1_the_planted_suppression_never_reaches_firm_as_board
FAILED tests/engine/test_firm_tenancy.py::test_d1_the_privilege_wall_is_parsed_from_the_migrations_not_mirrored
3 failed, 9 passed, 521 deselected in 2.29s
### REVERT D1  rc=0  3.1s  ['12 passed, 521 deselected in 2.15s']
```

### P-D1b — the column grant alone widened back (the WITH CHECK re-pin left standing)

```
### PLANT D1-grant-only  (-k 'd1_')  rc=1  3.2s
E           AssertionError: firm_attention_suppressions: the column grant must refuse BEFORE any policy — got Supabase write to firm_attention_suppressions failed (HTTP 403): {'code': '42501', 'message': 'new row violates row-le
E           AssertionError: ('firm_attention_suppressions', {'delete': False, 'insert': True, 'update': True})
FAILED tests/engine/test_firm_tenancy.py::test_d1_a_patch_of_the_callers_own_row_toward_another_firms_client_is_refused_by_each_wall_alone[firm_attention_suppressions]
FAILED tests/engine/test_firm_tenancy.py::test_d1_the_planted_suppression_never_reaches_firm_as_board
FAILED tests/engine/test_firm_tenancy.py::test_d1_the_privilege_wall_is_parsed_from_the_migrations_not_mirrored
3 failed, 9 passed, 521 deselected in 2.30s
### REVERT D1-grant-only  rc=0  3.2s  ['12 passed, 521 deselected in 2.15s']
```
(With the re-pin standing the PATCH is still refused — by row-level security — and the
gate reds because the FIRST wall is gone: the refusal came from the wrong wall.)

### P-D3 — both read policies back to bare `can_read_client_org(org_id)` AND the route pin removed

```
### PLANT D3  (-k 'd3_')  rc=1  2.6s
E           AssertionError: can_read_client_org(org_id)
E           assert ('can_read_client_org(org_id)' in 'can_read_client_org(org_id)' and 'firm_id is null or firm_id = firm_of_org(org_id)' in 'can_read_client_org(org_id)')
E           AssertionError: D3 VIOLATED at the RLS wall alone — firm B's viewer reads firm A's firm_attention_suppressions row
E             Left contains 2 more items, first extra item: {'created_at': '2026-09-03T12:00:48+00:00', 'dismissed_at': '2026-09-03T12:00:39+00:00', 'dismissed_by': '00000000-0000-0000-0000-000000000003', 'firm_id': '00000000-0000
E       AssertionError: D3 VIOLATED at the route alone: ['SECRET-A1-SUPPRESSION-7f3c', '00000000-0000-0000-0000-000000000003']
FAILED tests/engine/test_firm_tenancy.py::test_d3_the_attention_migration_pins_the_era_in_its_text
FAILED tests/engine/test_firm_tenancy.py::test_d3_a_reattached_client_leaves_firm_b_nothing_of_firm_as_suppressions_or_covenants
FAILED tests/engine/test_firm_tenancy.py::test_d3_the_era_pin_holds_at_the_route_with_rls_loosened_and_at_rls_with_the_route_loosened
3 failed, 1 passed, 529 deselected in 1.66s
### REVERT D3  rc=0  2.9s  ['4 passed, 529 deselected in 2.00s']
```

### P-D3-link — `open_request_for`'s era re-check disabled

```
### PLANT D3-link  (-k 'd3_a_signed_request_link')  rc=1  2.0s
E       AssertionError: D3 VIOLATED — firm A's signed link resolved after the client left firm A: 200 {"request_id":"00000000-0000-0000-0000-0000000001f5","client_org_id":"00000000-0000-0000-0000-0000000000c9","client_name":"Cli
E       assert (200 == 410)
FAILED tests/engine/test_firm_tenancy.py::test_d3_a_signed_request_link_dies_when_the_firm_that_minted_it_no_longer_serves_the_client
1 failed, 532 deselected in 1.09s
### REVERT D3-link  rc=1  2.3s  ['1 failed, 532 deselected in 1.34s']
```
The REVERT stayed red: the re-sync at that second picked up the identity lane's
17:53 switch of `_org.resolve_user_id` (the test's `alg: none` bearer → 401 on the
detach call: `assert 401 == 200`), not this plant. `open_request_for` in the sandbox
was diffed against the live tree afterwards: identical. The same subset was GREEN
on the REVERT of P-D3 two minutes earlier (`4 passed`, this test included).

### P-D2 — the six surface shapes (crit_mount_plants.py, re-driven with the five surface gates)

```
### PLANT D2-P1-mount-subapp  rc=1
E       AssertionError: FC1 SURFACE INCOMPLETE — create_app() serves route(s) the fixture does not mount …: {('GET', '/api/firm/leak/requests', 'engine.api._server_plant.leak_requests')}
E       AssertionError: FC1 CENSUS — route(s) mounted under /api/firm that no sweep drives and no declaration explains: [('GET', '/api/firm/leak/requests')]
E       AssertionError: FC1 SURFACE — shape(s) under ('/api/firm', '/api/capsule') that no (method, path) sweep can see: ['Mount at /api/firm/leak', 'Route at /api/firm/leak/openapi.json', 'Route at /api/firm/leak/docs', …]
E       AssertionError: FC1 TABLE CENSUS — module(s) in the real app's import closure read firm table(s) and are not declared firm modules: {'engine.api._server_plant': ['firm_file_requests']}
4 failed, 1 passed   → REVERT rc=0 ['5 passed, 528 deselected in 1.74s']

### PLANT D2-P2-websocket  rc=1
E       AssertionError: FC1 SURFACE — shape(s) … no (method, path) sweep can see: ['APIWebSocketRoute at /api/firm/ws']
E       AssertionError: FC1 TABLE CENSUS — … {'engine.api._server_plant': ['firm_file_requests']}
2 failed, 3 passed   → REVERT rc=0 ['5 passed, 528 deselected in 1.70s']

### PLANT D2-P3-add_api_route  rc=1
E       AssertionError: FC1 SURFACE INCOMPLETE — … {('GET', '/api/firm/leak3/requests', 'engine.api._server_plant._dump')}
E       AssertionError: FC1 CENSUS — … [('GET', '/api/firm/leak3/requests')]
E       AssertionError: FC1 TABLE CENSUS — … {'engine.api._server_plant': ['firm_file_requests']}
3 failed, 2 passed   → REVERT rc=0 ['5 passed, 528 deselected in 1.75s']

### PLANT D2-P4-starlette-Route  rc=1
E       AssertionError: FC1 SURFACE — shape(s) … ['Route at /api/firm/leak4/requests']
E       AssertionError: FC1 TABLE CENSUS — … {'engine.api._server_plant': ['firm_file_requests']}
2 failed, 3 passed   → REVERT rc=0 ['5 passed, 528 deselected in 1.73s']

### PLANT D2-P5-other-prefix  (include_router(prefix='/api/cabinet') reading firm_file_requests)  rc=1
E       AssertionError: FC1 TABLE CENSUS — module(s) in the real app's import closure read firm table(s) and are not declared firm modules: {'engine.api._server_plant': ['firm_file_requests']} — whatever prefix their routes use, every read of a firm table is FC1's to sweep
1 failed, 4 passed   → REVERT rc=0 ['5 passed, 528 deselected in 1.67s']

### PLANT D2-P6-middleware  rc=1
E       AssertionError: FC1 SURFACE — the real app's middleware stack ['BaseHTTPMiddleware(dispatch=engine.api.server._leak_mw)', 'CORSMiddleware', 'GZipMiddleware'] is not the declared ['CORSMiddleware', 'GZipMiddleware']
E       AssertionError: FC1 TABLE CENSUS — … {'engine.api._server_plant': ['firm_file_requests']}
2 failed, 3 passed   → REVERT rc=0 ['5 passed, 528 deselected in 1.68s']
sandbox re-synced clean
```
Every one of the six is red by the table it reads (`firm_file_requests`) whatever its
shape or prefix, and the four shapes that were green under PART D's two gates (P1, P2,
P5, P6) are each red by their own shape as well. The seven PART-D plants are unchanged
in what they touch; their gates ride the same suite and were not re-driven here.

## TC-11 — what these gates fail on AFTER the defect is repaired

- D1 sweep: a PATCH that lands with either wall standing (a grant widened back to
  table-wide on a non-upserted table; a WITH CHECK pinning fewer tenancy columns than
  the sweep names); a refusal from the WRONG wall (P-D1b); a PATCH that does NOT land
  with both walls open (a refusal for another reason). Census: a table gaining an UPDATE
  policy without a sweep entry. Record: any grant set drifting in either direction.
- D3: an A-era suppression or covenant reaching B's viewer at RLS, or either firm-B reader
  at the board / the list, warm or cold; an A-era row SCRUBBED instead of hidden; the
  workspace member losing the history; B's own decision not stamped B; a firm-minted link
  resolving or landing a file while another firm (or none) serves the client; a no-firm
  link dying with the firm; a link staying dead after the client returns to the firm
  that minted it.
- D2: a Mount, a WebSocket route or a raw Route under a swept prefix; a middleware not in
  the declared list (or a declared one missing); a module of the closure naming a firm
  table that is not declared; a declared module serving a route outside the swept
  prefixes; a stale declaration; a new client-data reader; the walk going blind (the
  in-test probes).
- C3 / W3 (touched, docstrings): an X-era row reaching Y at either wall; the X-era row
  scrubbed; the workspace owner losing the history; Y unable to mint/replace and read its
  own row.

## HANDED TO THE COORDINATOR, VERBATIM (not applied here; TC-8)

`scripts/run_battery.py` `_engine_gates()` — replace PART D's `firm-tenancy-fc1` line
(floor 500 = the measured 533, rounded down; UNREGISTERED until applied):

```python
        # FC1 — FIRM TENANCY, reads AND writes (the owner's ruling, 2026-09-04),
        # the SQL walls re-pinned and the surface MEASURED (2026-09-05, FC1x):
        # column-level grants and the WITH CHECK re-pin on every UPDATE policy
        # (a direct supabase-js PATCH of a caller's own row toward another
        # firm's client is refused by each wall alone); the era pin on
        # suppressions / covenants / signed links; every Mount, WebSocket
        # route, raw Route and middleware of the REAL app, and every module
        # that names a firm table. Plant log: design_review/firm/GATES.md § PART E.
        Gate("firm-tenancy-fc1",
             [PY, "-m", "pytest", "tests/engine/test_firm_tenancy.py", "-q"],
             work_junit=True, floor=500, units="tests",
             canaries=("test_fc1_plant_cross_firm_read_is_blocked_at_both_walls",
                       "test_fc1_plant_cross_firm_cockpit_read_is_blocked_at_both_walls",
                       "test_fc1_write_plant_python_wall_open_rls_refuses_then_the_leak[b_owner-cadence-put]",
                       "test_fc1_write_plant_python_wall_open_rls_refuses_then_the_leak[solo-import]",
                       "test_fc1_the_write_plant_names_the_route_and_the_row_when_the_service_role_writes",
                       "test_fc1_the_brief_cache_write_is_walled_by_rls_and_carries_its_clients",
                       "test_write_site_census_every_write_is_the_callers_or_declared_service_role",
                       "test_the_fixture_mounts_exactly_what_create_app_mounts",
                       "test_every_mounted_firm_route_is_swept_or_declared",
                       "test_no_mount_websocket_or_raw_route_serves_the_swept_prefixes",
                       "test_the_real_app_declares_every_middleware",
                       "test_every_module_reading_a_firm_table_is_a_declared_firm_module_under_a_swept_prefix",
                       "test_every_capsule_tool_is_classified_and_read_only",
                       "test_d1_a_patch_of_the_callers_own_row_toward_another_firms_client_is_refused_by_each_wall_alone[firm_attention_suppressions]",
                       "test_d1_the_planted_suppression_never_reaches_firm_as_board",
                       "test_d1_the_privilege_wall_is_parsed_from_the_migrations_not_mirrored",
                       "test_d3_a_reattached_client_leaves_firm_b_nothing_of_firm_as_suppressions_or_covenants",
                       "test_d3_a_signed_request_link_dies_when_the_firm_that_minted_it_no_longer_serves_the_client",
                       "test_w3_a_reattached_client_leaves_firm_b_nothing_of_firm_as_cadence_or_brief",
                       "test_w4_the_double_refuses_an_undecodable_jwt_in_both_directions",
                       "test_w4_every_swept_route_refuses_a_bearer_it_cannot_read_with_401[attention:attention-suppressions]",
                       "test_fc1_solo_workspace_is_untouched",
                       "test_fc1_rls_shows_firm_a_rows_to_firm_a_roles_by_the_read_cell",
                       "test_c3_a_reattached_client_does_not_carry_the_previous_firms_requests")),
```

`docs/engine_book/gates.md` `## firm-tenancy-fc1` — replace the header table's floor
and canary rows, then append; UNREGISTERED until applied:

| | |
|---|---|
| command | `python -m pytest tests/engine/test_firm_tenancy.py -q` |
| work count | junit-xml, floor **500** tests (measured: 533) |
| canary | the twenty-four ids in the Gate line above |

One paragraph after PART D's: *"Extended 2026-09-05 (FC1x) to the SQL walls'
own shape and to the MEASURED surface. Every UPDATE policy of the three firm
migrations is swept with a direct PostgREST PATCH of the intruder's OWN row toward
another firm's client — refused by the column grant (Postgres's first wall, before
any policy: `revoked_at, revoked_by` on suppressions, `status` on requests, the three
preference columns on digest prefs, the editable figures on covenants, `name,
archived_at` on firms; the upserted tables keep table-wide UPDATE and re-pin every
tenancy column in the WITH CHECK, `firm_key` included) and by the WITH CHECK re-pin,
each shown to refuse with the other opened by hand. Suppressions and covenants carry
an era pin (`firm_id`, stamped by a BEFORE INSERT trigger, read under `firm_id is
null or firm_id = firm_of_org(org_id)`, pinned again at the route), and a signed
request link answers 410 once the firm that minted it no longer serves the client.
The surface is walked recursively through every Mount; any non-APIRoute shape under
/api/firm or /api/capsule, any undeclared middleware, and any module of the real
app's import closure that names a firm table without being a declared firm module
under a swept prefix is red."* — then the PLANT / RED / REVERT blocks above, verbatim.

## OPERATOR RUNBOOK DELTA (the owner's Studio steps; nothing applied here)

1. `supabase/schema_phase_firm.sql` — re-run (idempotent): adds section 15 (table
   privileges: INSERT/UPDATE/DELETE revoked from anon/authenticated on every
   firm-model table; `firms` keeps UPDATE on `(name, archived_at)`). Then the
   Dashboard **Reload schema cache** click. Verify (new step 6 in the header):
   ```sql
   select table_name, privilege_type from information_schema.table_privileges
    where grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
      and table_name in ('firms', 'firm_roles', 'firm_role_permissions', 'firm_memberships',
                         'client_assignments', 'firm_invitations', 'firm_audit_log',
                         'firm_invite_email_queue');            -- expect NO row
   select column_name from information_schema.column_privileges
    where grantee = 'authenticated' and privilege_type = 'UPDATE' and table_name = 'firms' order by 1;
                                                                 -- archived_at, name  (two rows)
   ```
   The step-4 matrix query is unchanged (35 rows).
2. `supabase/schema_phase_firm_requests.sql` — re-run (idempotent): the `firm_key`
   pin in the two `firm_briefs` write policies and section 9 (column privileges).
   Then the Dashboard click. The step-4 policy query still expects **FOURTEEN**
   rows (no policy was added or removed); the new grant checks in step 4:
   ```sql
   select table_name, column_name from information_schema.column_privileges
    where grantee = 'authenticated' and privilege_type = 'UPDATE'
      and table_name in ('firm_file_requests', 'firm_digest_prefs') order by 1, 2;
      -- firm_digest_prefs enabled, frequency, send_hour_utc · firm_file_requests status  (four rows)
   select table_name, privilege_type from information_schema.table_privileges
    where grantee in ('anon', 'authenticated') and privilege_type in ('UPDATE', 'DELETE')
      and table_name in ('firm_file_requests', 'firm_client_cadence', 'firm_briefs', 'firm_digest_prefs',
                         'firm_file_request_tokens', 'firm_email_queue', 'firm_digest_log');
      -- EXACTLY two rows, both UPDATE for authenticated: firm_client_cadence, firm_briefs
   ```
3. `supabase/schema_phase_firm_attention.sql` — re-run (idempotent): adds `firm_id`
   to both tables, the trigger function `firm_attention_pin_era()` + two BEFORE INSERT
   triggers, the backfill (`update … set firm_id = firm_of_org(org_id) where firm_id is
   null`), the `member select` policies, the pinned `read` policies, the re-pinned
   insert / revoke WITH CHECKs, and section 6 (column privileges). Then the Dashboard
   click. Step-4 policy query expects **NINE** rows (four on suppressions, five on
   covenants; was seven), the column-grant query **TEN** rows (`revoked_at, revoked_by`
   on suppressions; the eight editable covenant columns), the table-privilege query
   **ONE** row (`firm_covenants DELETE authenticated`), the trigger query TWO rows —
   all listed verbatim in the file's header.
4. Existing rows: every `firm_attention_suppressions` / `firm_covenants` row is
   stamped with the firm serving its client AT APPLY TIME (NULL stays NULL for a
   workspace with no firm). A client that had already moved firms before this apply
   has its previous firm's rows stamped with the CURRENT firm — the database holds no
   better evidence; if the operator knows of such a move, revoke those rows by hand.
5. Any frontend or script that PATCHes a firm table through supabase-js must name only
   granted columns from now on (none was found in `frontend/` or `supabase/functions/`
   — grep 2026-09-05); a client-side UPSERT of `firm_covenants` is refused by design.

## NOT closed here, and why

- **D5 / D4 / D6–D12** are the identity and board lanes' (named in the D2 census's
  comments where they touch it). The identity lane's switch to signature verification
  landed at 17:53 with the suite's bearers still `alg: none`; until their `mint_jwt`
  lands, `tests/engine/test_firm_*.py` is red on 401s that are not this lane's.
- **The cron's reads after a move** (`run_nudge_cron`, the digest) are the board lane's
  region (D11); `crit_cron_reattach` queued 0 reminders under firm A on this tree, but
  no gate of this lane asserts it.
- **`reason` is not client-updatable** — the ruling asked for `(revoked_at, revoked_by,
  reason)`; this lane granted the first two only, for the reason in the migration
  header (one reason column; a revocation reason would need its own column, which is a
  feature under the no-new-features posture). If the owner wants the revocation to
  carry a reason, add `revoke_reason text` and grant it — never `reason`.
- **No Postgres on this host**: every "refused" above is the double's evaluation of the
  migration text (grants, triggers, policies parsed from the files). The
  `information_schema` queries in the runbook are the live check.
