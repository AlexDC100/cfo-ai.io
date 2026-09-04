# THE GATE REGISTER

Hand-maintained. One section per gate in `scripts/run_battery.py`, each
recording the **work count** the gate reports, the **canary** it must
find, and the **plant** that was applied to watch it go RED — with the
exact red output, and the revert that put it back GREEN.

`tests/engine/test_gate_canaries.py` fails when a gate in the battery has
no section here, no canary, or a floor of zero. That is what makes this
page non-optional rather than ceremony.

---

## Why this page exists

`npx tsc --noEmit` sat in the battery and was pasted as proof by every
lane for months. **It checked zero files.** The root `tsconfig.json` is
solution-style — `"files": []` plus `references` — so without `-b`, tsc
obeys the empty file list, finds nothing, and exits 0 in 0.2 s. It hid
102 real type errors across 32 files.

The owner's verdict: *a gate that has been pasted as proof by every lane
for months while checking zero files is worse than no gate; it made every
"tsc 0" claim in this project's history meaningless retroactively.* And:
the 0.2 s-versus-9 s runtime tell is the lesson to generalize.

Three siblings, all real, all in this repo:

| where | what it did |
|---|---|
| `scripts/check_metric_declared.py`, first draft | scanned KEYWORD arguments only; reported "0 metrics" for a package containing dozens, and printed a PASS |
| `scripts/check_stale_gates.mjs`, first draft | matched `data-testid=` attributes only; called 20 live sidebar ids stale, because they are declared in a config array as `testId: "…"` |
| `e2e/design/capsule.spec.ts` | three gates passed VACUOUSLY — one stubbed an answer never requested, one a gap payload never fetched, one watched an endpoint never called. Each would have kept passing with its invariant deleted |

The generalization is that **exit zero is half a verdict**. A gate must
also be able to say what it examined, and it must fail when that number
collapses.

---

## The contract every gate now carries

Enforced in `scripts/run_battery.py` for every gate, and asserted
mechanically by `tests/engine/test_gate_canaries.py`.

1. **WORK COUNT + FLOOR.** Each gate reports a machine-readable count of
   what it actually examined — files scanned, tests run, probes made,
   rows checked. The battery reads that count back out of the gate's own
   output (a declared regex, or the junit-xml pytest writes) and FAILS
   the gate when the count is missing or below its declared floor, *even
   on exit 0*. A census that finds nothing is a broken gate, never a
   passing one.
2. **CANARY.** Each gate names something it MUST find — a fixture, a rule
   id, a test id, a verdict line. Absent ⇒ `DISCOVERY BROKEN`, whatever
   the exit code. This is the antibody already proven in
   `check_metric_declared.py` and `check_stale_gates.mjs`.
3. **A PROVEN RED.** Every gate has a plant in this page: the defect that
   gate exists to catch, applied, observed red, reverted, observed green.

Floors are **measured, then rounded down**. They detect collapse — a
suite that stops collecting, a walker that stops walking — and are not a
ratchet. A floor raised to chase a number would be the same sin as a
threshold lowered to meet one.

`python scripts/run_battery.py --show-work` prints the live contract.

---

## A third state: `PASS(VACUOUS)`

One gate on a developer host runs clean while examining nothing:
`public-sitemaps`, whose subject is ingested public-company data that
most hosts do not have. That absence is legitimate — this repo never
reconstructs a missing denominator as a failure — but "it passed" and "it
had nothing to look at" must not read the same, so the battery reports it
separately and excludes it from the green count:

```
PASS public-sitemaps (1.1s) — VACUOUS: examined 0 sitemap URLs probed on this host
...
BATTERY: PASS — 29/30 gates green, 1 VACUOUS (public-sitemaps)
```

The gate's own logic is still proven: `tests/engine/test_public_seo.py`
drives `run_gate()` against a planted fixture app inside the `pytest`
gate, and the plant below shows it going red the moment it is given a
subject.

---

## Runtime plausibility

Measured on a full `scripts/run_battery.py` run (macOS, warm caches).
A gate finishing suspiciously fast is a SUSPECT — that is exactly how
`tsc` hid. Read the two right-hand columns together: seconds alone say
nothing, and work alone says nothing; the ratio is the tell.

| gate | seconds | work units | verdict on the ratio |
|---|---:|---:|---|
| `pytest` | 287.8 | 3,259 tests | ~11 tests/s incl. fixtures and subprocess gates — consistent |
| `corpus-policy` | 63.9 | 3,658 tracked files | reads and lexes every tracked byte incl. XLSX text extraction — consistent |
| `npm-build` | 15.8 | 3,558 modules transformed | ~225 modules/s through esbuild+rollup — consistent |
| `tsc` | 14.1 | 662 project files | ~47 files/s of full type inference — consistent. **This is the gate whose predecessor did the same job in 0.2 s over 0 files.** |
| `corpus-replay` | 12.3 | 18 corpus cases | full offline pipeline per case — consistent |
| `supply-chain` | 6.5 | 3,658 tracked files | sweep + lock digest recompute — consistent |
| `determinism` | 4.8 | 4 fixtures × 5 runs | 20 full parse+assemble passes — consistent |
| `error-budget` | 4.2 | 6,363 labeled fields | re-runs the corpus pipeline in-process — consistent |
| `bs-drift` | 4.2 | 7 fixtures | 7 XLSX parses + assemblies — consistent |
| `shadow-report` | 3.9 | 18 corpus cases | two code paths per case — consistent |
| `capsule-gates` | 3.1 | 23 tests | fixture-heavy — consistent |
| `dst-explore` | 2.1 | 14 fault scenarios | in-process simulation — consistent |
| `period-integrity` | 1.8 | 37 tests | consistent |
| `import-boundary` | 1.5 | 1,603 source files | AST-parses 284 engine files, regex-scans the rest — consistent |
| `public-sitemaps` | 1.4 | **0** | **VACUOUS — see above. Not evidence.** |
| `metric-declared` | 1.2 | 41 metric names | AST walk over 7 surfaces — consistent |
| `finding-specificity` | 1.2 | 33 findings | 8 fixtures through the findings engine — consistent |
| `public-e2e` | 1.2 | 37 live probes | in-process FastAPI + sqlite — consistent |
| `engine-book` | 1.0 | 6 book pages | full import-graph AST parse per regeneration — consistent |
| `scrub-unreachable` | 0.9 | 1,224 executable files | 4 closure rounds over 26 surfaces — consistent |
| `public-market-gates` | 0.9 | 7 PM gates | real SEC bytes + sqlite — consistent |
| `metric-units` | 0.8 | 69 metric rows (320 files parsed) | consistent |
| `pack-drift-ro` / `-hu` | 0.6 | 5 / 10 pack files | regenerate + byte-diff — consistent |
| `supply-chain-selftest` | 0.5 | 18 planted cases | in-memory fixtures — consistent |
| `pack-lint` | 0.3 | 4 packs | consistent |
| `capsule-ask` | 0.3 | 540 source+spec files | consistent |
| `stale-gates` | **0.1** | 635 app files | SUSPECT — investigated below |
| `narrative-units` | **0.1** | 7 producers | SUSPECT — investigated below |
| `global-positioning` | **0.1** | 665 frontend files | SUSPECT — investigated below |

The three 0.1 s gates were investigated rather than assumed:

- **`global-positioning`** — 663 files / 6.93 MB / 178,188 lines walked.
  ~70 MB/s of warm-cache synchronous reads in Node: consistent. It now
  prints the count and asserts the HU pattern still matches somewhere, so
  the runtime no longer has to be interpreted by hand.
- **`stale-gates`** — 633 app files + 41 gate files, small sources.
  Consistent, and now both censuses carry a canary.
- **`narrative-units`** — scope is 7 named producer files by design.
  Consistent; it already failed when a scope file yields no template
  literals.

The full table is in the per-gate sections below (each carries its own
green/red timings from the plant run).

---

## What building this found

The contract was not a formality: switching it on turned four gates red
on the first full run, and every one was a real defect in the gate rather
than in the code it guards.

| finding | what it was |
|---|---|
| `metric-declared` audited **five** surfaces while its config claimed **seven** | `src/engine/api/_notes.py` and `_alerts.py` had been deleted from the tree; the loop `continue`d past a missing path. A live surface being renamed would have been swallowed the same way. Missing surfaces now FAIL. |
| `determinism` floor was set to 5 from a truncated tail; the roster is 4 | The battery caught it as `WORK BELOW FLOOR` on the first enforced run. The floor is now the measured roster size. Worth noting the direction: the mechanism caught its own author. |
| `metric-declared` verified its canary but never SAID so | Its `total_assets` canary held internally and printed nothing, so "the canary held" and "the canary was never evaluated" looked identical downstream. It now prints what it found. |
| `run_battery.py` itself tripped `scrub-unreachable` | A canary literal in the battery named the history-rewriting tooling path, and the gate correctly failed the runner as an executable file naming it. A true positive, found by accident. |
| `public-e2e` never probed a company page from the rendered index | Adding a per-surface canary revealed the `/companii` index links ONLY county and sector hubs. Company pages reach the gate through the sitemap loop alone. Recorded, not papered over — `public_ro` is another lane's package. |
| `import-boundary`, `metric-units`, `global-positioning`, `check_tsc`, `capsule-ask`, `public-e2e`, `stale-gates` printed no count at all | Each closed with a verdict sentence — "boundary holds", "every literal metric row declares a unit", "GLOBAL-POSITIONING GATES: PASS" — that is equally true of an empty walk. All now publish what they examined. |

---

## Record semantics

`data/obs/battery_last.json` gained four fields per gate: `work_units`,
`work_floor`, `work_label`, `work_source`, plus `canaries` /
`canaries_missing` and a `state` of `PASS` / `FAIL` / `VACUOUS`.

`ok` keeps its old meaning — "did not fail" — so the existing ops surface
(`scripts/engine_ops.py status`, `src/engine/obs/status.py`) reads
unchanged and does not show an environmental absence as a red. A consumer
that wants the sharper distinction should read `state`, which is the only
place `VACUOUS` appears. Teaching the ops surface that third state is a
follow-up in whichever lane owns `src/engine/obs/status.py`.

`_gates()` still yields `(name, cmd)` when unpacked, because
`tests/engine/test_error_budget.py` does `dict(run_battery._gates(True))`.
Breaking another lane's test for a reason unrelated to what it asserts
would have been its own small version of this page's subject.

---

## Cross-lane debt

Two gates take their work count from an EXTERNAL proxy — files counted
beside the gate rather than reported by it — because their scripts are
not this lane's to edit:

| gate | script | ask |
|---|---|---|
| `pack-drift-ro` | `scripts/port_ro_pack.py` | `--check` prints `clean` and no count. Please print `N file(s) compared` from `check_against()`; it already iterates `PACK_FILE_NAMES`. |
| `pack-drift-hu` | `scripts/port_hu_pack.py` | same |

The proxy is faithful today — `check_against()` fails loudly on a missing
file, so the file census equals what it compared — but it is measured
beside the gate, not by it, and `test_gate_canaries.py` requires every
such use to carry an `external_reason` so the debt stays visible.

---

## The plants

Every plant below was applied inside an isolated copy of the tree
(`rsync` of the working tree into a scratch sandbox, `node_modules` and
`.venv` symlinked). **The live working tree was never modified**, which
also keeps the plants clear of the file-ownership boundaries between
lanes.

Each section records:

- **PLANT** — the exact diff applied.
- **RED** — the gate's own output under the plant, and its exit code.
- **REVERT** — the same gate, plant removed, green again.


---

## pytest

The engine suite. Everything with a unit-level law lives here; the named gates below exist for the classes whose failure is silent.

| | |
|---|---|
| command | `python -m pytest tests/engine -q` |
| work count | junit-xml, floor **1500** tests |
| canary | `test_regeneration_is_byte_identical`, `test_this_gate_is_itself_catalogued` |

**PLANT**

```diff
--- src/engine/passes/classify.py
-rule = pack.match(code)
+rule = pack.match(code)
+        if code.startswith("401"):  # PLANT
+            rule = None
```

**RED** — exit `1` in 271.2s:

```
FAILED tests/engine/test_shadow_divergence.py::test_property_tbs_zero_divergence[148]
FAILED tests/engine/test_shadow_divergence.py::test_property_tbs_zero_divergence[152]
FAILED tests/engine/test_shadow_divergence.py::test_property_tbs_zero_divergence[156]
FAILED tests/engine/test_shadow_divergence.py::test_property_tbs_zero_divergence[160]
FAILED tests/engine/test_shadow_divergence.py::test_property_tbs_zero_divergence[164]
FAILED tests/engine/test_shadow_divergence.py::test_property_tbs_zero_divergence[168]
FAILED tests/engine/test_shadow_divergence.py::test_property_tbs_zero_divergence[172]
FAILED tests/engine/test_shadow_divergence.py::test_property_tbs_zero_divergence[176]
FAILED tests/engine/test_shadow_divergence.py::test_property_tbs_zero_divergence[184]
FAILED tests/engine/test_shadow_divergence.py::test_property_tbs_zero_divergence[188]
FAILED tests/engine/test_shadow_divergence.py::test_property_tbs_zero_divergence[192]
FAILED tests/engine/test_shadow_divergence.py::test_pipeline_probe_is_log_only_and_default_off
= 51 failed, 3208 passed, 16 skipped, 2 deselected, 1 xfailed, 6 warnings in 269.15s (0:04:29) =
sys:1: DeprecationWarning: builtin type swigvarlink has no __module__ attribute
```

**REVERT** — exit `0` in 272.0s:

```
  OPS: Operations Per Second, computed as 1 / Mean
= 3259 passed, 16 skipped, 2 deselected, 1 xfailed, 6 warnings in 270.40s (0:04:30) =
sys:1: DeprecationWarning: builtin type swigvarlink has no __module__ attribute
```

Verdict: **PROVEN RED**

---

## corpus-replay

Every golden corpus case re-run offline through the real pipeline and compared to its frozen served envelope.

| | |
|---|---|
| command | `python scripts/corpus_replay.py` |
| work count | stdout, floor **18** corpus cases |
| canary | `saga_10_col`, `pdf_positional` |

**PLANT**

```diff
--- corpus/rounding_004pct/expected/served_envelope.json
-"difference": 0.0,
+"difference": 1.0,
```

**RED** — exit `1` in 15.1s:

```
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
incorrect startxref pointer(4)
parsing for Object Streams
[period_end] no date pattern in filename 'input.pdf' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
```

**REVERT** — exit `0` in 19.7s:

```
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
```

Verdict: **PROVEN RED**

---

## period-integrity

W1-W6 — the period comes from the DOCUMENT, never from UI state. A 2025 trial balance was filed under 2017-12 because the drop target's date was written into the human-confirmation channel.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_period_integrity_gates.py -q` |
| work count | junit-xml, floor **10** tests |
| canary | `test_w1_scanner_catches_the_exact_production_plant`, `test_w3_carniprod_2025_filed_under_2017_is_recorded_as_a_mismatch` |

**PLANT**

```diff
--- frontend/lib/cfoApi.ts
+++ frontend/lib/cfoApi.ts (appended)
+// PLANT: a second writer onto the confirmation channel.
+export function laneAPlantUpload(db: any, targetEnd: string) {
+  return db.from('documents').insert({ period_end_hint: targetEnd })
+}
```

**RED** — exit `1` in 3.0s:

```
tests/engine/test_period_integrity_gates.py ..F......................... [ 75%]
.........                                                                [100%]

=================================== FAILURES ===================================
_______ test_w1_only_the_upload_helper_writes_the_period_end_hint_column _______
tests/engine/test_period_integrity_gates.py:434: in test_w1_only_the_upload_helper_writes_the_period_end_hint_column
    assert not writers, (
E   AssertionError: W1 VIOLATED — the `period_end_hint` column is written outside lib/supabase.ts's uploadDocument:
E         frontend/lib/cfoApi.ts: return db.from('documents').insert({ period_end_hint: targetEnd })
E       One writer keeps the law enforceable in one place.
E   assert not ["frontend/lib/cfoApi.ts: return db.from('documents').insert({ period_end_hint: targetEnd })"]
=========================== short test summary info ============================
FAILED tests/engine/test_period_integrity_gates.py::test_w1_only_the_upload_helper_writes_the_period_end_hint_column
========================= 1 failed, 36 passed in 1.86s =========================
```

**REVERT** — exit `0` in 1.9s:

```
.........                                                                [100%]

============================== 37 passed in 0.92s ==============================
```

Verdict: **PROVEN RED**

---

## finding-specificity

F2 — a surfaced finding must cite two figures, an imperative verb and a ledger code, and must not read the same for another book.

| | |
|---|---|
| command | `python scripts/check_finding_specificity.py` |
| work count | stdout, floor **20** surfaced findings |
| canary | `liquidity_cash_tight`, `scandia_fy2025` |

**PLANT**

```diff
--- src/engine/api/findings/s_liquidity.py
-imperative="Obtain a committed overdraft sized to one month of "
-                           "operating cost"
+imperative="Further consideration should be given to the "
+                           "liquidity position"
```

**RED** — exit `1` in 1.3s:

```
F2 SPECIFICITY: DISCOVERY BROKEN
  collected 27 finding(s) over 8 fixture(s)
  canary NOT surfaced: scandia_fy2025/liquidity_cash_tight
  A lint over an empty set passes every law it states. Fix the harness or retarget the canary — do not let it report a clean census.
```

**REVERT** — exit `0` in 1.2s:

```
    valuation_ebitda_non_positive          carniprod_fy2025         scandia_realestate_fy2025 figures-differ 0.57  anchored yes  overlap 0.48  ok

OK — every surfaced finding carries two figures, an imperative verb, a ledger code and no boilerplate, scores 7.0/7.0, and no rule renders text that would read the same for another book.
```

Verdict: **PROVEN RED**

---

## capsule-gates

C1-C9 — no figure in the language channel, no reachable write tool, provenance on every value, a named gap instead of the month next door.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_capsule_gates.py -q` |
| work count | junit-xml, floor **15** tests |
| canary | `test_c1_no_figure_ever_reaches_the_language_channel`, `test_c2_a_planted_write_tool_never_executes_through_the_dispatcher`, `test_c5_absent_period_answers_with_the_gap_and_no_number` |

**PLANT**

```diff
--- src/engine/api/_capsule_tools.py
+++ src/engine/api/_capsule_tools.py (appended)
+def update_period_label(x):
+    """PLANT: a public callable in the surface naming a mutation."""
+    return x
```

**RED** — exit `1` in 3.2s:

```
[C9-E] capsule retrieval over 60 dispatches: p50=0.03ms p95=0.75ms max=11.00ms (list_findings)
..               [100%]

=================================== FAILURES ===================================
__________ test_c2_no_public_callable_in_the_surface_names_a_mutation __________
tests/engine/test_capsule_gates.py:852: in test_c2_no_public_callable_in_the_surface_names_a_mutation
    assert not lowered.startswith(verb), (
E   AssertionError: public callable 'update_period_label' names a mutation
E   assert not True
E    +  where True = <built-in method startswith of str object at 0x11960fa80>('update_')
E    +    where <built-in method startswith of str object at 0x11960fa80> = 'update_period_label'.startswith
=========================== short test summary info ============================
FAILED tests/engine/test_capsule_gates.py::test_c2_no_public_callable_in_the_surface_names_a_mutation
========================= 1 failed, 22 passed in 2.20s =========================
```

**REVERT** — exit `0` in 2.9s:

```
..               [100%]

============================== 23 passed in 1.86s ==============================
```

Verdict: **PROVEN RED**

---

## determinism

The canonical envelope is byte-identical across five runs of the same fixture, and the frozen fixture's extracted SF sums match the file's own totals row to the cent.

| | |
|---|---|
| command | `python scripts/verify_determinism.py` |
| work count | stdout(line-count), floor **4** fixtures x5 runs |
| canary | `prod_scandia_frozen`, `anchor: SF extracted` |

> FIRST TWO ATTEMPTS, REJECTED — (a) a random default argument value, which Python evaluates once at import so all five runs shared it; (b) a 1e-9 perturbation of the P&L anchor, which rounds away before it reaches the envelope. Only a perturbation large enough to survive cent rounding produced a real byte difference. Both misses are informative: the gate is insensitive to sub-cent noise by design.

**PLANT**

```diff
--- src/engine/country_packs/ro_romania/chart_of_accounts.py
-def assemble_statements(
+import random as _lane_a_random  # PLANT
+
+
+def assemble_statements(

--- src/engine/country_packs/ro_romania/chart_of_accounts.py
-current_year_pnl=float(net_income_statutory or 0.0),
+current_year_pnl=float(net_income_statutory or 0.0)
+            + _lane_a_random.random() * 1000.0,
```

**RED** — exit `1` in 5.3s:

```
  ✗ [scandia_realestate] run 1 vs run 2 differ at:
    $.aggregates.retained_earnings.net: -947956.51 != -947694.68
    $.leaves.current_year_loss.magnitude: 801387.26 != 801125.43
    $.leaves.current_year_loss.ras_line_items_sum_signed: -801387.26 != -801125.43
    $.methodology.ratios.debt_to_equity.value: 0.460482 != 0.460479
    $.methodology.ratios.equity_ratio.value: 0.482924 != 0.482927
    $.methodology.ratios.lt_debt_to_equity.value: 0.366252 != 0.366249
    $.methodology.ratios.return_on_equity.value: -0.754422 != -0.754418
    $.methodology.totals.total_equity: 40284351.61 != 40284613.44
  ✗ [carniprod] run 1 vs run 2 differ at:
    $.aggregates.retained_earnings.net: -13509865.37 != -13509976.54
    $.leaves.current_year_profit.magnitude: 1435887.01 != 1435775.84
    $.leaves.current_year_profit.ras_line_items_sum_signed: 1435887.01 != 1435775.84
    $.methodology.totals.total_equity: 106896321.33 != 106896210.16
```

**REVERT** — exit `0` in 5.9s:

```
[carniprod] 5 runs — BYTE-IDENTICAL | rows=367 accounts=315 status=BALANCED difference=0.0 anchor=NO_ANCHOR

DETERMINISM GATE: PASS — all fixtures byte-identical across 5 runs; frozen SF sums match the file's totals row to the cent
```

Verdict: **PROVEN RED**

---

## bs-drift

F-A3.1 — |bs_balance_delta| / total_assets on every registered fixture. The closing identity is the product's core claim.

| | |
|---|---|
| command | `python scripts/measure_bs_drift.py` |
| work count | stdout(line-count), floor **7** fixtures |
| canary | `Scandia`, `Sibiu`, `identity_holds` |

> FIRST ATTEMPT, REJECTED — retargeting the 401 rule from `ap` to `otherEquity`. The gate stayed green, correctly: both lines sit on the equity-and-liabilities side, so the closing identity never opens. Moving 401 to an ASSET line is the defect the gate measures.

**PLANT**

```diff
--- packs/ro/omfp1802-v1/classification.yaml
-rule_id: "ro.401"
-    prefix: "401"
-    line_id: "ap"
+rule_id: "ro.401"
+    prefix: "401"
+    line_id: "otherCurrentAssets"
```

**RED** — exit `1` in 4.3s:

```
  Retail       drift  0.0052%   GREEN

============================================================
CLOSING-IDENTITY — canonical_bs.difference (exact, full path)
============================================================
  Scandia      difference           0.00  BALANCED           identity_holds=True  GREEN
  Sibiu        difference     -12,253.38  MATERIAL_IMBALANCE identity_holds=True  GREEN
  Frozen       difference           0.00  BALANCED           identity_holds=True  GREEN
  RealEstate   difference           0.00  BALANCED           identity_holds=True  GREEN
  Agras        difference           0.00  BALANCED           identity_holds=True  GREEN
  Carniprod    difference           0.00  BALANCED           identity_holds=True  GREEN
  Retail       difference           0.00  BALANCED           identity_holds=True  GREEN

Overall: NOT GREEN — see verdicts above.
```

**REVERT** — exit `0` in 4.3s:

```
  Retail       difference           0.00  BALANCED           identity_holds=True  GREEN

Overall: GREEN — F-A3.1 met on all registered fixtures.
```

Verdict: **PROVEN RED**

---

## error-budget

The silent-error rate: wrongly served numeric fields carrying NO review flag, per lane, against budgets that do not widen.

| | |
|---|---|
| command | `python scripts/measure_error_budget.py` |
| work count | stdout(sum), floor **5000** labeled numeric fields |
| canary | `lane deterministic`, `lane classification` |

**PLANT**

```diff
--- corpus/rounding_004pct/expected/served_envelope.json
-"difference": 0.0,
+"difference": 99.0,
```

**RED** — exit `1` in 5.6s:

```
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
incorrect startxref pointer(4)
parsing for Object Streams
[period_end] no date pattern in filename 'input.pdf' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
```

**REVERT** — exit `0` in 4.7s:

```
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
[period_end] no date pattern in filename 'input.xlsx' — defaulting to today
```

Verdict: **PROVEN RED**

---

## import-boundary

The serving gateway is the only sanctioned reader of raw canonical/envelope totals; everything else consumes served facts.

| | |
|---|---|
| command | `python scripts/check_import_boundary.py` |
| work count | stdout, floor **200** source files |
| canary | `engine=OK`, `frontend=OK` |

**PLANT**

```diff
--- src/engine/obs/status.py
+++ src/engine/obs/status.py (appended)
+def _lane_a_plant(canonical_bs_envelope):
+    """Plant: a raw totals read outside the serving gateway."""
+    return canonical_bs_envelope["totals"]["assets"]
```

**RED** — exit `1` in 1.8s:

```
IMPORT BOUNDARY VIOLATIONS (2):
  src/engine/obs/status.py:336: [E-TOTALS-FIELD] chained ["totals"]["assets"] read — read served facts through the gateway public API (src/engine/serving/facts.py) instead of the raw snapshot.
  src/engine/obs/status.py:336: [E-TOTALS-READ] raw ["totals"] read on 'canonical_bs_envelope' — read served facts through the gateway public API (src/engine/serving/facts.py) instead of the raw snapshot.

Fix: consume served balance-sheet facts through the serving gateway —
  engine:   from engine.serving.facts import <public helper>   (src/engine/serving/facts.py)
  frontend: import from frontend/lib/servedFacts.ts
Raw envelope/canonical_bs totals reads outside the gateway break the
single-authority contract (docs/CANONICAL_BS_V2_CONTRACT.md).
Legitimate build-side / serve-internal code belongs in
scripts/import_boundary_allowlist.txt (with a reason comment).
```

**REVERT** — exit `0` in 1.5s:

```
[check_import_boundary] scanned 1603 file(s): engine=284, frontend=517, private-fields=802
GATE-WORK import-boundary units=1603 floor=200 label=source-files
[check_import_boundary] boundary holds (engine=OK, frontend=OK, private-fields=OK)
```

Verdict: **PROVEN RED**

---

## pack-lint

Jurisdiction data packs: schema, dangling line ids, effective-range tiling, rule shadowing.

| | |
|---|---|
| command | `python scripts/pack_lint.py --root packs` |
| work count | stdout, floor **4** packs |
| canary | `pack(s) loaded` |

**PLANT**

```diff
--- packs/test/zz-minimal-v1/classification.yaml
-line_id: share_capital
+line_id: lane_a_line_that_does_not_exist
```

**RED** — exit `1` in 0.5s:

```
ERROR   dangling-line-id             [zz-minimal-v1/classification.yaml:zz.100] line_id 'lane_a_line_that_does_not_exist' is not defined in statement_map.yaml
-- 3 pack(s) loaded, 1 error(s), 0 warning(s)
```

**REVERT** — exit `0` in 0.4s:

```
clean — no findings
-- 4 pack(s) loaded, 0 error(s), 0 warning(s)
```

Verdict: **PROVEN RED**

---

## shadow-report

Two code paths over the same CompiledPack must agree account-for-account on real corpus inputs. Zero divergence is the claim.

| | |
|---|---|
| command | `python scripts/shadow_report.py --all` |
| work count | stdout, floor **18** corpus cases |
| canary | `saga_10_col`, `accounts=` |

> FIRST ATTEMPT, REJECTED — adding an unused function to `classify.py`. No behaviour changed, so the two paths still agreed. A divergence gate can only be tripped by an actual divergence.

**PLANT**

```diff
--- src/engine/passes/classify.py
-rule = pack.match(code)
+rule = pack.match(code)
+        if code.startswith("401"):  # PLANT
+            rule = None
```

**RED** — exit `1` in 3.9s:

```
    current_liabilities        |      28119256.42 |      25558424.92 | -2560831.50
DIVERGE  case=saga_10_col_retail lane=deterministic_tb accounts=425 pack=36e3fb50e0cc
  per-account divergences (3):
    account        | legacy                                         | pack
    401.01         | ap=3097870.40                                  | (unclassified)=-3097870.40
    401.03         | ap=395030.52                                   | (unclassified)=-395030.52
    401.110        | ap=2963879.52                                  | (unclassified)=-2963879.52
  per-section subtotal divergences (1):
    section                    |           legacy |             pack | delta
    current_liabilities        |      17006445.60 |      10549665.16 | -6456780.44
GREEN   saga_compact_6_col           accounts=5
GREEN   unmapped_equals_delta        accounts=3

SHADOW REPORT: DIVERGENCE in 8 case(s) — the two code paths disagree about the SAME pack data; fix the wrong path (front-end amount slots / effective_closing_side / flip application). The pack YAML is the source of truth and changes only as a new pack version.
```

**REVERT** — exit `0` in 4.8s:

```
GREEN   unmapped_equals_delta        accounts=3

SHADOW REPORT: GREEN — zero divergence across 18 case(s)
```

Verdict: **PROVEN RED**

---

## pack-drift-ro

A shipped pack version is immutable: regeneration from the frozen port snapshot must stay byte-identical to the checked-in YAML.

| | |
|---|---|
| command | `python scripts/port_ro_pack.py --check` |
| work count | EXTERNAL(glob), floor **5** pack files compared |
| canary | `frozen port snapshot` |
| external proxy | port_ro_pack.py is not lane A's file to edit |

**PLANT**

```diff
--- packs/ro/omfp1802-v1/pack.yaml
+++ packs/ro/omfp1802-v1/pack.yaml (appended)
+# PLANT: v1 is immutable.
```

**RED** — exit `1` in 1.8s:

```
DRIFT pack.yaml:
--- checked-in/pack.yaml
+++ regenerated/pack.yaml
@@ -24,5 +24,3 @@
   - version: v1
     date: "2026-08-19"
     notes: "Shadow-divergence fix (classification unchanged on the natural side; credit-side targets now match the deterministic lane): ported the parser-layer SIDE_FLIP_TO_LIAB_PREFIXES, which the original port missed — 418/451/452 gained side_flip {credit -> otherCurrentLiab}; 1687 gained a flip-carrier under the '168' ltDebt winner; 425 needs none (its rule already targets otherCurrentLiab); 467 has no classification rule, so the legacy flip can never fire (rule lookup precedes the flip check) and its codes stay unmapped; 455/461 were already covered identically by the bifunctional table. Found by scripts/shadow_report.py: legacy vs pack divergences on corpus cases saga_10_col (418201), saga_10_col_agras (418), saga_10_col_carniprod (418.01), saga_10_col_realestate (451105/451805), saga_10_col_retail (4511). Known legacy path-dependence, recorded not hidden: these re-routes exist ONLY on the deterministic parser lane; the legacy LLM-accounts lane does not apply them — the pack encodes the deterministic behavior."
-
-# PLANT: v1 is immutable.
port_ro_pack --check: the checked-in v1 pack no longer matches the FROZEN port snapshot (+ the still-live engine constants it mirrors). v1 is immutable — revert the YAML edit and cut a NEW pack version instead; if a live engine constant changed, that change likewise demands a deliberate new pack version.
```

**REVERT** — exit `0` in 1.1s:

```
port_ro_pack --check: clean — pack matches the frozen port snapshot.
```

Verdict: **PROVEN RED**

---

## pack-drift-hu

Same law, Hungary + the IFRS caption pack.

| | |
|---|---|
| command | `python scripts/port_hu_pack.py --check` |
| work count | EXTERNAL(glob), floor **10** pack files compared |
| canary | `frozen port snapshot` |
| external proxy | port_hu_pack.py is not lane A's file to edit |

**PLANT**

```diff
--- packs/hu/actc2000-v1/pack.yaml
+++ packs/hu/actc2000-v1/pack.yaml (appended)
+# PLANT: v1 is immutable.
```

**RED** — exit `1` in 2.1s:

```
DRIFT hu/pack.yaml:
--- checked-in/hu/pack.yaml
+++ regenerated/hu/pack.yaml
@@ -24,5 +24,3 @@
   - version: v1
     date: "2026-08-20"
     notes: "1:1 mechanical port of engine.country_packs.hu_hungary.classification_map at the Phase-4 cutover: HU_CLASS_MAP (10 account classes, Act C of 2000 számlatükör structure) rendered as prompt_guidance.class_map, HU_NOTABLE_ACCOUNTS (21 accounts) as exact rules (gloss verbatim as description; line_id pins the canonical statement line the gloss names), the classify_prompt_block frame text as prompt_guidance header/footer, + the canonical statement-line vocabulary (engine.canonical BS_BUCKETS/PL_BUCKETS) as the statement map, + the D0-D9 diagnosis configuration and auto-reconcile constants (jurisdiction-neutral engine machinery that runs on AI-lane envelopes — mirrored from the same live constants the RO pack mirrors). Generated by scripts/port_hu_pack.py; regeneration must stay byte-identical (--check). The AI-lane classify prompt renders from this pack, and the classify prompt_version derives from its content hash — this exact v1 content aliases to the frozen 'classify_v1' (engine.ai_lane.config), so stored envelopes and the golden corpus stay byte-stable; ANY content change re-versions the prompt and invalidates the AI cache."
-
-# PLANT: v1 is immutable.
port_hu_pack --check: a checked-in v1 pack no longer matches the FROZEN port snapshot (+ the still-live engine constants it mirrors). v1 is immutable — revert the YAML edit and cut a NEW pack version instead; if a live engine constant or the canonical schema changed, that change likewise demands a deliberate new pack version.
```

**REVERT** — exit `0` in 2.0s:

```
port_hu_pack --check: clean — both packs match the frozen port snapshot.
```

Verdict: **PROVEN RED**

---

## corpus-policy

Nothing in the tree may carry real client identifiers, and every corpus case must be able to answer why it is safe to ship.

| | |
|---|---|
| command | `python scripts/check_corpus_policy.py` |
| work count | stdout, floor **2500** tracked files |
| canary | `corpus case(s)`, `CORPUS POLICY` |

**PLANT**

```diff
--- corpus/rounding_004pct/meta.yaml
-synthetic: true
-anonymized: false
+synthetic: false
+anonymized: false
```

**RED** — exit `1` in 178.4s:

```
NOTICE  REAL-FILE COVERAGE MISSING: csv, generic_4_col, hu_ai_lane, public_summary, ro_llm_fallback, saga_compact_6_col
NOTICE  anonymization escape hatch in use: saga_10_col declares `anonymized_upstream: true` (real export, this repo's scrambler deliberately not applied)
EXEMPT  corpus/public_summary_ro/expected/served_envelope.json: statutory_identifier (scripts/corpus_policy_allowlist.txt:64) — Same synthetic identifier, echoed into the frozen golden artifact.
EXEMPT  scripts/measure_bs_drift.py: company_legal_name (scripts/corpus_policy_allowlist.txt:48) — Reviewed provenance reference: the F3.7c fixture-registration docstring and the display label the drift gate hands to assemble_statements. Deliberately retained and registered as an accepted residual in the ADR; the numeric baseline it produces is unaffected.
EXEMPT  src/engine/api/benchmarks_deep_seed.json: site_location (scripts/corpus_policy_allowlist.txt:46) — Collides with a retail-centre name quoted from NEPI Rockcastle's public 2024 annual report in the listed-REIT benchmark seed. Public issuer disclosure, not sourced from a client document.
EXEMPT  src/engine/public/cache.py: site_location_short (scripts/corpus_policy_allowlist.txt:44) — Three-letter collision with a weekday abbreviation in a market-calendar comment (the weekend check for the public-markets cache).
NOTICE  stale exemption: scripts/corpus_policy_allowlist.txt:42 exempts site_location_short in frontend/components/cfo/SearchDialog.tsx, which no longer matches anything — delete it or explain why it stays
NOTICE  stale exemption: scripts/corpus_policy_allowlist.txt:61 exempts CUI 90000021 in corpus/public_summary_ro/input.json, which no longer matches anything — delete it or explain why it stays
NOTICE  stale exemption: scripts/corpus_policy_allowlist.txt:62 exempts CUI 90000021 in corpus/public_summary_ro/expected/extraction.json, which no longer matches anything — delete it or explain why it stays
NOTICE  stale exemption: scripts/corpus_policy_allowlist.txt:63 exempts CUI 90000021 in corpus/public_summary_ro/expected/classification.json, which no longer matches anything — delete it or explain why it stays
checked 3618 file(s) (3588 tracked + 30 not yet added), 18 corpus case(s), 8 exemption(s) on file, 4 fired

CORPUS POLICY: FAIL — 1 violation(s)
  x corpus/rounding_004pct/meta.yaml: real input (`synthetic: false`) that is not anonymized. Either run the matching scrambler and set `anonymized: true`, or declare `anonymized_upstream: true` with the reason in source_notes, or move the case under corpus/private/ and encrypt it at rest.
```

**REVERT** — exit `0` in 118.9s:

```
NOTICE  stale exemption: scripts/corpus_policy_allowlist.txt:63 exempts CUI 90000021 in corpus/public_summary_ro/expected/classification.json, which no longer matches anything — delete it or explain why it stays
checked 3617 file(s) (3588 tracked + 29 not yet added), 18 corpus case(s), 8 exemption(s) on file, 4 fired
CORPUS POLICY: PASS
```

Verdict: **PROVEN RED**

---

## scrub-unreachable

PROOF BY ABSENCE: no CI job, hook, package script, container build or pytest entry point can reach the history-rewriting tooling.

| | |
|---|---|
| command | `python scripts/check_scrub_tooling_unreachable.py` |
| work count | stdout, floor **800** executable files |
| canary | `automation surface(s)`, `closure round(s)`, `REACHABILITY` |

> NOTE — while wiring this gate's canary, the battery runner itself was caught: `run_battery.py` named the scrub-tooling path as a canary literal, and this gate correctly failed it as an executable file naming the tooling. A true positive, found by accident, and a neat demonstration that the gate is live. The canary was changed to match the gate's verdict lines instead.

**PLANT**

```diff
--- Makefile
+++ Makefile (appended)
+lane-a-plant:
+	bash scripts/history-scrub/run.sh
```

**RED** — exit `1` in 2.8s:

```
scrub tooling on disk: scripts/history-scrub/ EXISTS
proved over: 26 automation surface(s) -> 130 reachable file(s) in 4 closure round(s); 1224 executable file(s) swept; 3588 tracked file(s) total
self-exempt (must name the token to police it): scripts/check_scrub_tooling_unreachable.py, tests/engine/test_scrub_tooling_unreachable.py
NOTICE  documented references (prose — not automation): Makefile, corpus/pdf_positional/meta.yaml, docs/decisions/ADR-corpus-history-sibiu.md, scripts/history-scrub/RUNBOOK.md

SCRUB-TOOLING REACHABILITY: FAIL — 2 file(s) name the scrub tooling from an automation path
  x [L1 automation config] Makefile
      41: bash scripts/history-scrub/run.sh
  x [L1 automation config] makefile
      41: bash scripts/history-scrub/run.sh

  Rewriting git history is a human-reviewed, one-way operation. Remove the reference; run the tooling by hand per docs/decisions/ADR-corpus-history-sibiu.md.
```

**REVERT** — exit `0` in 2.5s:

```
NOTICE  documented references (prose — not automation): corpus/pdf_positional/meta.yaml, docs/decisions/ADR-corpus-history-sibiu.md, scripts/history-scrub/RUNBOOK.md

SCRUB-TOOLING REACHABILITY: PASS — no automation path reaches scripts/history-scrub/
```

Verdict: **PROVEN RED**

---

## supply-chain-selftest

The supply-chain gate's own detectors, run against planted violations and clean fixtures. A gate's detector is itself code.

| | |
|---|---|
| command | `python scripts/check_supply_chain.py --self-test` |
| work count | stdout(line-count), floor **12** planted cases |
| canary | `C5 catches a planted Anthropic key`, `C5 does NOT flag the public anon JWT` |

**PLANT**

```diff
--- scripts/check_supply_chain.py
-r"\bsk-ant-[A-Za-z0-9_\-]{24,}"
+r"\bsk-ant-THIS-PATTERN-MATCHES-NOTHING-[0-9]{99}"
```

**RED** — exit `1` in 0.9s:

```
  [ok] C3 catches a lock install missing --require-hashes
  [ok] C3/C4 ignore Dockerfile comments (a comment installs nothing)
  [ok] C4 catches `FROM python:latest`
  [ok] C4 catches a tagless FROM
  [ok] C4 catches a bare-major tag
  [ok] C4 catches a tagless compose image:
  [ok] C4 passes explicit tags, stage refs and digest pins
  [ok] C5 catches a planted AWS access key
  [ok] C5 catches a planted private-key block
  [FAIL] C5 catches a planted Anthropic key
  [ok] C5 flags a service_role JWT
  [ok] C5 does NOT flag the public anon JWT
  [ok] C5 masks the match (never echoes the credential)
SELF-TEST: FAIL — 1 assertion(s)
```

**REVERT** — exit `0` in 0.8s:

```
  [ok] C5 does NOT flag the public anon JWT
  [ok] C5 masks the match (never echoes the credential)
SELF-TEST: PASS — every planted violation caught, every clean fixture passed
```

Verdict: **PROVEN RED**

---

## supply-chain

What ships in the image: lock shape, lock/pyproject sync, image refs, credential sweep. Born from an unpinned `anthropic>=0.30` floating to 1.0.0 and crash-looping the container.

| | |
|---|---|
| command | `python scripts/check_supply_chain.py` |
| work count | stdout, floor **2500** tracked files |
| canary | `lock pins=`, `anthropic==` |

**PLANT**

```diff
--- pyproject.toml
-"anthropic>=0.30,<1.0"
+"anthropic>=0.30"
```

**RED** — exit `1` in 19.5s:

```
PROOF   anthropic==0.125.0 satisfies 'anthropic>=0.30' — a 1.0.0 float cannot enter the image (pin + --require-hashes)
checked image refs in: Dockerfile, Dockerfile.frontend, deploy/cfo-ai-vps/docker-compose.yml, docker-compose.yml
checked 3618 tracked file(s); lock pins=58; 0 exemption(s) on file

SUPPLY CHAIN: FAIL — 1 violation(s)
  x [c2_lock_sync] requirements-lock.txt: input-digest mismatch (lock declares 'sha256:ad6c6268bdb1ddce0f25705d1e468d9534891c033f5a66118858a64290c78921', pyproject + declared extras compute 'sha256:8903f2a26bea22eaa484db81d7ba580911a2302548f34c51de34162093d85e3e') — a dependency changed without regenerating the lock; run scripts/generate_lock.py
```

**REVERT** — exit `0` in 14.8s:

```
checked image refs in: Dockerfile, Dockerfile.frontend, deploy/cfo-ai-vps/docker-compose.yml, docker-compose.yml
checked 3617 tracked file(s); lock pins=58; 0 exemption(s) on file
SUPPLY CHAIN: PASS
```

Verdict: **PROVEN RED**

---

## engine-book

The engine book is generated, never hand-rotted: regeneration must be byte-identical to what is committed.

| | |
|---|---|
| command | `python scripts/generate_engine_book.py --check` |
| work count | stdout, floor **6** book pages |
| canary | `byte-identical` |

**PLANT**

```diff
--- docs/engine_book/architecture.md
+++ docs/engine_book/architecture.md (appended)
+PLANT: hand-edited line.
```

**RED** — exit `1` in 1.2s:

```
ENGINE BOOK DRIFT — regenerate and commit:
  architecture.md: DRIFT (committed page != regeneration)
  fix: python scripts/generate_engine_book.py
```

**REVERT** — exit `0` in 1.4s:

```
engine book: clean (6 generated pages byte-identical)
```

Verdict: **PROVEN RED**

---

## dst-explore

Deterministic simulation: seeded (fixture x fault x boundary) sweeps over the real pipeline, each ending in a verified journal chain and a byte-identical recovered envelope.

| | |
|---|---|
| command | `python scripts/dst_explore.py` |
| work count | stdout, floor **14** fault scenarios |
| canary | `kill_between_stages` |

**PLANT**

```diff
--- src/engine/journal/journal.py
-self._prev_event_hash = event["event_hash"]
+self._prev_event_hash = None  # PLANT
```

**RED** — exit `1` in 2.5s:

```
    raise _Enospc("simulated ENOSPC on snapshot write")
engine.dst.faults._Enospc: [Errno 28] simulated ENOSPC on snapshot write
[period_end] no date pattern in filename 'input.csv' — defaulting to today
[journal] on_snapshot_persisted failed (non-fatal)
Traceback (most recent call last):
  File "/private/tmp/claude-501/-Users-alex-Desktop-folder-claude-Scandia-copy/3ffcb142-1cba-4f4d-a1ef-1e69d9ad3827/scratchpad/laneA_sandbox/src/engine/journal/hooks.py", line 239, in on_snapshot_persisted
    handle.record_snapshot(
  File "/private/tmp/claude-501/-Users-alex-Desktop-folder-claude-Scandia-copy/3ffcb142-1cba-4f4d-a1ef-1e69d9ad3827/scratchpad/laneA_sandbox/src/engine/journal/journal.py", line 276, in record_snapshot
    self.journal.store.write_object(data)
  File "/private/tmp/claude-501/-Users-alex-Desktop-folder-claude-Scandia-copy/3ffcb142-1cba-4f4d-a1ef-1e69d9ad3827/scratchpad/laneA_sandbox/src/engine/dst/faults.py", line 382, in _enospc_write
    raise _Enospc("simulated ENOSPC on snapshot write")
engine.dst.faults._Enospc: [Errno 28] simulated ENOSPC on snapshot write
[period_end] no date pattern in filename 'input.csv' — defaulting to today
[period_end] no date pattern in filename 'input.csv' — defaulting to today
```

**REVERT** — exit `0` in 3.9s:

```
    raise _Enospc("simulated ENOSPC on snapshot write")
engine.dst.faults._Enospc: [Errno 28] simulated ENOSPC on snapshot write
[period_end] no date pattern in filename 'input.csv' — defaulting to today
```

Verdict: **PROVEN RED**

---

## public-sitemaps

PS6 — every sitemapped public URL serves 200 with real content, and thin / unpublishable / taken-down CUIs are absent from every shard.

| | |
|---|---|
| command | `python scripts/check_public_sitemaps.py` |
| work count | stdout, floor **1** sitemap URLs probed |
| canary | `PS6 GATE` |
| vacuous | 0 work is reported `PASS(VACUOUS)`, never counted green |

**PLANT**

```diff
--- (new) data/laneA_plant_sitemaps/sitemap.xml + companies-0001.xml.gz
+ one shard listing https://cfo-ai.io/companii/999999-lane-a-plant-srl (a CUI no page serves)
```

**RED** — exit `1` in 1.2s:

```
PS6 GATE: FAIL (1 violations)
  - shard companies-0001: https://cfo-ai.io/companii/999999-lane-a-plant-srl -> HTTP 404
```

**REVERT** — exit `0` in 1.3s:

```
NOTICE no sitemap shards in data/laneA_plant_sitemaps — nothing to verify (run scripts/public_seo.py sitemaps after an ingest)
GATE-WORK public-sitemaps units=0 floor=1 label=sitemap-urls-probed
PS6 GATE: PASS (0 shards) — VACUOUS: this host has no ingested public data, so the gate probed no URL. Not evidence. Run scripts/public_ingest.py + public_seo.py sitemaps to give it a subject; the gate's own logic is proven meanwhile by tests/engine/test_public_seo.py.
```

Verdict: **PROVEN RED**

---

## public-e2e

The public storefront against the REAL store. The unit suites drove a FakeStore whose drift hid two total outages behind 244 green tests; this gate fakes nothing.

| | |
|---|---|
| command | `python scripts/check_public_e2e.py` |
| work count | stdout, floor **10** live assertions |
| canary | `PS-E2E GATE` |

> NOTE — adding this gate's surface canary revealed that the rendered `/companii` index links ONLY county and sector hubs: no company page is reachable from it. Company pages reach the gate through the sitemap loop alone. That is a public_ro linking question, recorded rather than papered over.

**PLANT**

```diff
--- src/engine/public_ro/pages/hubs.py
-store.hub_top_companies(kind, slug, limit=_HUB_TOP_LIMIT)
+store.hub_top_companies(kind, slug, _HUB_TOP_LIMIT)
```

**RED** — exit `1` in 1.2s:

```
  LINKED_URL_NOT_200: /companies links /counties/cluj -> HTTP 500
  LINKED_URL_NOT_200: /companies links /counties/satu-mare -> HTTP 500
  LINKED_URL_NOT_200: /companies links /sectors/10 -> HTTP 500
  LINKED_URL_NOT_200: /companies links /sectors/16 -> HTTP 500
  SITEMAP_URL_NOT_200: https://cfo-ai.io/sector/10 -> HTTP 500
  SITEMAP_URL_NOT_200: https://cfo-ai.io/sectors/10 -> HTTP 500
  SITEMAP_URL_NOT_200: https://cfo-ai.io/sector/16 -> HTTP 500
  SITEMAP_URL_NOT_200: https://cfo-ai.io/sectors/16 -> HTTP 500
  SITEMAP_URL_NOT_200: https://cfo-ai.io/judet/bistrita-nasaud -> HTTP 500
  SITEMAP_URL_NOT_200: https://cfo-ai.io/counties/bistrita-nasaud -> HTTP 500
  SITEMAP_URL_NOT_200: https://cfo-ai.io/judet/cluj -> HTTP 500
  SITEMAP_URL_NOT_200: https://cfo-ai.io/counties/cluj -> HTTP 500
  SITEMAP_URL_NOT_200: https://cfo-ai.io/judet/satu-mare -> HTTP 500
  SITEMAP_URL_NOT_200: https://cfo-ai.io/counties/satu-mare -> HTTP 500
```

**REVERT** — exit `0` in 1.5s:

```
GATE-WORK public-e2e units=37 floor=10 label=live-probes
PS-E2E GATE: PASS — real store, links render, sitemap URLs resolve without redirect, funnel persists, takedown is total (37 probe(s) across company-page, funnel-sink, hub, index, takedown)
```

Verdict: **PROVEN RED**

---

## public-market-gates

PM1-PM7 — no AI-authored numerics in the facts path, no cross-market percentile blending, honest small-n states, labeled staleness, keyless resilience, registry-only extension, BVB untouched.

| | |
|---|---|
| command | `python scripts/check_public_market_gates.py --no-replay` |
| work count | stdout(line-count), floor **7** PM gates |
| canary | `PM1  no AI-authored numerics in the facts path`, `PM7  BVB / public_ro untouched` |

**PLANT**

```diff
--- src/engine/public_market/prices.py
+++ src/engine/public_market/prices.py (appended)
+# PLANT: the facts path reaching a model SDK.
+import anthropic  # noqa: F401
```

**RED** — exit `1` in 1.2s:

```
FAIL PM1  no AI-authored numerics in the facts path
       ! prices.py:194 imports anthropic — the facts path may not reach a model or the AI layer
       · audited 1 stored envelope(s) at /private/tmp/claude-501/-Users-alex-Desktop-folder-claude-Scandia-copy/3ffcb142-1cba-4f4d-a1ef-1e69d9ad3827/scratchpad/laneA_sandbox/data/public_market.db (read-only)
       · the spine's own validator does NOT yet refuse an AI-sourced provenance (model.validate_envelope + store.put_filing accept it) — this gate refuses it; see design_review/markets/GATES.md PM1
SKIP PM2  no ENGINE-side cohort statistic exists to blend — the grouping law shipped on the frontend and is gated there
       · PM2's live contract lives on the FRONTEND: frontend/lib/benchmarkGroups.ts carries the grouping law (assertHomogeneous, partitionByKey, MIN_N_FOR_PERCENTILES, BenchmarkIntegrityError) and is asserted by frontend/lib/__tests__/marketGates.test.ts (the plants) and benchmarkHonesty.test.ts (the states). No cohort statistic is computed server-side, so there is nothing here to blend.
       · the engine-side partition contract is proven against a planted blending grouper in tests/engine/test_public_market_gates.py and arms itself the moment one of the engine seams appears.
PASS PM3  small-n states are exact and unsmoothed
PASS PM4  no price is served without a freshness label
PASS PM5  keyless: US live, everything else honestly degraded, zero packets to the provider
PASS PM6  a market reaches the surface through markets.yaml alone; a market-id branch in core trips the guard
PASS PM7  BVB / public_ro untouched; goldens byte-identical
PUBLIC-MARKET GATES: FAIL — 5/7 green, 1 skipped (PM2)
```

**REVERT** — exit `0` in 1.0s:

```
PASS PM6  a market reaches the surface through markets.yaml alone; a market-id branch in core trips the guard
PASS PM7  BVB / public_ro untouched; goldens byte-identical
PUBLIC-MARKET GATES: PASS — 6/7 green, 1 skipped (PM2)
```

Verdict: **PROVEN RED**

---

## metric-units

Every literal metric row a producer emits declares its unit. Production rendered 1553.0% because two layers each scaled a ratio by 100.

| | |
|---|---|
| command | `python scripts/check_metric_units.py` |
| work count | stdout, floor **50** literal metric rows |
| canary | `METRIC UNIT GATE` |

**PLANT**

```diff
--- (new file) src/engine/api/_lane_a_plant_probe.py
+"""Plant: a producer emitting a metric row with no unit."""
+def row():
+    return {"name": "gross_margin_pct", "value": 0.42}
```

**RED** — exit `1` in 0.8s:

```
METRIC UNIT GATE: FAIL (1 row(s) emit a metric without a unit)
  src/engine/api/_lane_a_plant_probe.py:3  gross_margin_pct  AMBIGUOUS-SUFFIX

  Fix: add "unit" to the row (e.g. "ratio" for 0..1, "pct"
  for 0..100, a currency code, "days", "x"). A metric whose
  scale is not declared WILL eventually be scaled twice.
```

**REVERT** — exit `0` in 0.7s:

```
GATE-WORK metric-units units=69 floor=50 label=literal-metric-rows
METRIC UNIT GATE: PASS — every literal metric row declares a unit (69 row(s) across 320 file(s); canaries seen: net_debt_to_ebitda)
```

Verdict: **PROVEN RED**

---

## test-env-isolation

No test path may be able to write to production.

| | |
|---|---|
| command | `node scripts/check_test_env_isolation.mjs` |
| work count | stdout `units=N` env vars examined, floor **1** |
| canary | `TEST-ENV ISOLATION`, `sanctioned supabase` |

**THE INCIDENT (2026-09-01).** `.env` pointed `VITE_SUPABASE_URL` at the
production project; `.env.local` set `VITE_PUBLIC_TEST_MODE=1`. Vite
merges them, so the dev server served a build that was **in test mode
and wired to production**. Every Playwright cold boot authenticated as
the fixed test identity, hit the cold-boot false zero in
`fetchOrgsForUser()`, and ensure-default created a real organisation —
about one every twelve seconds while suites ran.

**8,880 junk "Test workspace" organisations out of 8,913 — 99.6% of that
table was created by test scaffolding.**

**This was the SECOND time in one week.** The first was the vitest suite,
green only because a real Supabase URL sat in an untracked `.env`. That
was fixed with `envPin.ts` + `hermeticEnv.json` — and the fix covered
**vitest only**. Playwright drives the dev server, which never consults
the manifest, so the hole stayed open in the path that was actually
writing. A gate that closes one runner is not a gate on the class.

**PLANT** — restore the combination that shipped:

```diff
--- .env.local
-VITE_SUPABASE_URL=https://test.supabase.co
+VITE_SUPABASE_URL=https://<production-ref>.supabase.co
```

**RED**:

```
FAIL — a TEST PATH CAN WRITE TO PRODUCTION:
  .env + .env.local  (MERGED — the flag and the URL are in different files)
      test-mode flag(s): VITE_PUBLIC_TEST_MODE
      supabase host    : <production-ref>.supabase.co
```

The **merged** check is the one that matters: the flag and the URL lived
in different files, so a per-file check would have passed both.

**REVERT** — `.env.local` re-pinned to the manifest's value; gate returns
to `PASS — no test path resolves a non-sanctioned Supabase project.`

**Vacuity probe:** `--probe-vacuity` empties the file list and the gate
fails with `DISCOVERY BROKEN — examined 0 environment variables`, rather
than reporting isolation for a machine it never looked at.

## hermetic

The test suite must not depend on an untracked local file.

| | |
|---|---|
| command | `node scripts/check_hermetic.mjs` |
| work count | stdout `GATE-WORK hermetic units=N`, floor **14** variables |
| canary | `HERMETICITY`, `comparisons` |

**THE INCIDENT.** `npx vitest run` was green only because a developer's
real Supabase URL sat in a gitignored `.env`. With `VITE_SUPABASE_URL=""`
three tests went red — **G7.a, K10.a, K10.f, three of the money-boundary
tests** — and they had been reaching a live seam because a real Supabase
project happened to be configured on one machine. No CI job runs vitest,
so those tests had never passed anywhere but a developer's laptop.
Exposure window ≈35 days.

On a bare clone the suite issued **33 GETs at production**, because
`VITE_API_URL` defaults to `https://api.cfo-ai.io` in `config/site.ts`
and to localhost in `features.ts`; the untracked file was the only thing
holding it to localhost.

**PLANT** — the owner's literal ask, a variable added to a gitignored
`.env.local`:

```diff
+++ .env.local   (untracked)
+VITE_ORPHAN_LEAK=leaked-from-local-dotenv
```

**RED** — the variable is named together with the untracked file it came
from:

```
HERMETICITY BROKEN — VITE_ORPHAN_LEAK resolves from .env.local
  (untracked) with the local dotenv files loaded, and is ABSENT without
  them. A value that exists only on this machine is not a test fixture.
```

**REVERT** — `.env.local` restored to its prior contents; gate returns to
`HERMETICITY: OK — every recorded variable resolves identically with and
without the local dotenv files.` and `GATE-WORK hermetic units=14`.

**TWO PLANTS BROKE THIS GATE AND FORCED FIXES**, both worth recording:

- **Config ADDITION was invisible.** The gate mirrored three
  `vitest.config.ts` fields and checked them for PRESENCE — which detects
  removal and never addition. An audit added two: `envDir: "./frontend"`
  pointed the suite at an untracked `frontend/.env`, and `exclude`
  removed the in-suite half that would have caught it. The gate printed
  `HERMETICITY: OK` with `VITE_ORPHAN_LEAK` live in `import.meta.env`.
  Now every env-affecting config key is enumerated, and one this gate
  cannot mirror is a failure. Replaying the plant names both keys.
- **The source-scan floor had two units of free headroom.** 12 against a
  measured 14, so skipping `frontend/config` alone dropped discovery to
  12 and the gate passed clean. A floor that tolerates a partial collapse
  is a floor on a sum by another name (TC-6). Set TO the measurement.

**And its census floor was a sum of three sources** — the source scan
collapsed 14 → 3 while the census stayed 14, padded by the manifest, and
only the canary noticed. A separate `MIN_SOURCE_VARS` now guards the
scan itself. That is TC-6's fifth instance in this codebase.

**Output is redacted:** a plant made the gate print a real
`sb_publishable_…` key to stdout. Values now render as
`<redacted len=40 sha256:…>`, so gate output is safe in a CI log.

## capsule-craft

The Capsule reads as a conversation: no native tooltips, no category
column, one voice per line, live spec anchors.

| | |
|---|---|
| command | `node scripts/check_capsule_craft.mjs` |
| work count | stdout `GATE-WORK capsule-craft units=N`, floor **100** |
| canary | `familiesGated`, `rowComponents` |

**IT HAD NO RUNNER FOR A FULL WAVE.** Not in `run_battery.py`, not in any
workflow, not in `package.json`, not in the Makefile — every reference to
it in the repository was prose. It was written, plant-proven, documented,
and never executed by anything but a human typing its name. A gate nobody
runs and a gate that passes wrongly fail the same way.

**PLANT C — the one that matters.** The *previous* nine-query sweep,
restored over the build that carried the trailing labels: the exact
configuration that printed green one round earlier.

```diff
--- e2e/design/capsule-craft.spec.ts   (G4 query list restored to the old nine)
--- frontend/components/instrument/shell/CapsulePaletteRow.tsx  (trailing slot restored)
```

**RED** — the widened gate now names the family and the query that
summons it:

```
sku: 0 row(s) in state "typing:range", floor 5 (recorded query "range")
```

Under the old nine-query list the same build reported **zero offenders**,
because the list never summoned the `sku` family. That is the "sweep
never reached it" failure moved one axis over from components to
QUERIES — 57 live offenders at each viewport, invisible to a gate whose
own predicate called them offenders.

**PLANT G — a hole in the gate author's own first draft.** The initial
per-family floor summed a family's rows across all states, so `range`
could paint **zero** category rows while the total (5) still cleared the
floor (2). TC-6, discovered inside the fix for TC-6. It now reads the
count from the state the expectation names.

**REVERT** — restored; `GATE-WORK capsule-craft units=155 floor=12 ·
familiesGated=11 · PASS`.

**Vacuity self-probe:** `node scripts/check_capsule_craft.mjs
--probe-vacuity` empties the gate's own discovery and asserts it FAILS —
`VACUITY PROBE PASSED: with discovery emptied the gate FAILS`.

**Known open, recorded not hidden:** the `period` family's pin at exactly
zero is a HARNESS ARTIFACT, not a fact about the product. An adversarial
critic measured `financial_periods` returning 200 with rows and 7 period
rows painting on a SECOND navigation; the sweep's `boot()` reads the
palette on a cold mount, before `usePeriodStepper`'s query populates. So
the category-column ban has never actually been checked against that
family, at any viewport, in any theme.

## no-plants

No planted defect may be committed to product source. Gates here are
certified by planting the defect they catch, observing RED, and
reverting — this gate exists because that discipline produced a real
escape.

| | |
|---|---|
| command | `node scripts/check_no_plants.mjs` |
| work count | stdout `units=N`, floor **400** product source files |
| canary | `PLANT SCAN`, `GATE-WORK no-plants` |

**THE INCIDENT IT ENCODES.** On 2026-08-30 a coordinator ran `git add -A`
while a gates lane had its G8 plant live in the tree. Commit `36d34ef`
shipped to `main`:

```
// G8 PLANT P3 — the short-circuit disabled.
if (false && answer.answerLocally(q, resolveTier0(q, factIndex))) {
```

That line sends **every** Tier-0 question to the paid model seam — the
exact money defect the gate was built to catch — inside the commit whose
message claims the gate catches it. It reached `main` and missed
production only because the last deploy predated it. Found by an
adversarial critic reading `git show HEAD:`, not by any gate.

Why it escaped: a plant reads as ordinary code, `git add -A` swallows it,
and the suite stays green because the single gate that would catch it is
the one nobody re-runs before committing.

**PLANT** — the real incident, reintroduced verbatim:

```diff
--- frontend/components/instrument/shell/CommandPalette.tsx
-      if (answer.answerLocally(q, resolveTier0(q, factIndex))) {
+      // G8 PLANT P3 — the short-circuit disabled.
+      if (false && answer.answerLocally(q, resolveTier0(q, factIndex))) {
```

**RED** — exit `1`:

```
FAIL — planted defect(s) in product source:
  frontend/components/instrument/shell/CommandPalette.tsx:491  [gate plant marker]
  frontend/components/instrument/shell/CommandPalette.tsx:492  [disabled branch: if (false && …)]
```

Both markers fire independently, so a plant carrying **no comment** is
still caught by its structure.

**REVERT** — restored; `PASS — no planted defects in 857 product source
files.`

**A false positive fixed rather than suppressed.** The first draft
matched a bare `/planted/i`, which hit four prose comments that
legitimately describe what a test does ("invokes the planted callable",
"a planted EUR0.01 extra price still fires"). Naming those four files in
an allowlist would have left the next prose line to be discovered by
hand; the marker was narrowed instead to shapes that cannot occur in
prose. Paths that legitimately record plants as evidence — `docs/`,
`design_review/`, `__tests__/` — are excluded by path, because the word
must stay writable where the evidence lives.

## metric-declared

Every metric a surface can request is known to the ratio-unit registry, so a legitimate figure never resolves to UNIT_UNKNOWN and gets refused at render.

| | |
|---|---|
| command | `python scripts/check_metric_declared.py` |
| work count | stdout, floor **30** distinct metric names |
| canary | `total_assets`, `capsule`, `findings` |

**PLANT**

```diff
--- (new file) src/engine/api/findings/s_lane_a_plant.py
+"""Plant: a surface asking for a metric the registry does not
+declare — it would resolve to UNIT_UNKNOWN and be refused."""
+def build(bag):
+    bag.money("laneA_undeclared_metric", 1.0, "Plant")
```

**RED** — exit `1` in 1.2s:

```
  finding-rank       0 metrics   OK
  serving            0 metrics   OK
  benchmarks         0 metrics   OK
--------------------------------------------------------------
  42 distinct metric names across 7 surfaces

FAIL — these resolve to UNIT_UNKNOWN, which is a REFUSAL:
  [findings] laneA_undeclared_metric      src/engine/api/findings/s_lane_a_plant.py:4

Fix: add each to the right frozenset in
  src/engine/api/_ratio_units.py
(_MONEY_FACTS / _RATIO_FACTS / _PERCENT_FACTS), or rename it
to follow a house suffix convention. Do NOT relax the
resolver: UNIT_UNKNOWN refusing an unknown name is correct.
```

**REVERT** — exit `0` in 1.3s:

```
  41 distinct metric names across 7 surfaces

PASS — every metric a surface can request is declared.
```

Verdict: **PROVEN RED**

---

## stale-gates

An assertion pointed at an element nothing emits is a FALSE GREEN. This is the census that found 33 of them.

| | |
|---|---|
| command | `node scripts/check_stale_gates.mjs` |
| work count | stdout, floor **300** app files scanned |
| canary | `gate files reference`, `app files define` |

**PLANT**

```diff
--- e2e/design/capsule.spec.ts
+++ e2e/design/capsule.spec.ts (appended)
+// PLANT: an assertion pointed at an element nothing emits.
+test('lane-a plant', async ({ page }) => {
+  await page.getByTestId('lane-a-element-that-never-existed');
+});
```

**RED** — exit `1` in 0.1s:

```
==============================================================
  40 gate files reference 164 testids
  633 app files define 1139 testids
GATE-WORK stale-gates units=633 floor=300 label=app-files-scanned
--------------------------------------------------------------
  27 stale (baseline 26, new 1, healed 0)

FAIL — these gates assert against elements that do not exist:
  lane-a-element-that-never-existed
      e2e/design/capsule.spec.ts:1613

Each is a FALSE GREEN. Retarget the assertion at the element
that replaced it, or delete the assertion — do not add the
testid to the app just to satisfy the gate.
```

**REVERT** — exit `0` in 0.1s:

```
  26 stale (baseline 26, new 0, healed 0)

PASS — no NEW stale assertions (26 known, tracked in design_review/STALE_GATE_BASELINE.txt).
```

Verdict: **PROVEN RED**

---

## capsule-ask

K1/K8 — the command surface leads with an ASK verb in both languages, 'Ask' is not a list row, and the header budget agrees with the header lane's own set.

| | |
|---|---|
| command | `node scripts/check_capsule_ask.mjs` |
| work count | stdout, floor **100** source+spec files scanned |
| canary | `header-command-bar`, `SANCTIONED_DESKTOP` |

> FIRST ATTEMPT, REJECTED — renaming the trigger testid to `header-command-bar-RENAMED`. The gate matches the id as a SUBSTRING, so the rename still contained it; and a second component also emits the anchor. The K1 copy law was the honest plant.

**PLANT**

```diff
--- frontend/components/instrument/shell/capsuleAnswer/capsuleAnswerStrings.json
-"followUpPlaceholder": "Ask a follow-up…"
+"followUpPlaceholder": "Search this answer…"
```

**RED** — exit `1` in 0.4s:

```
     :304  DEAD-LIMB  [cmdk-root]
             an unreachable limb of a selector union, or a positive assertion that would fail loudly if reached
             const palette = page.locator('[role="dialog"], [cmdk-root]');

   ok  K1: en.shell.palette.placeholder = "Search pages, actions, periods, companies…" is DEAD COPY — no component renders this key. Not a violation; delete it before someone wires it back up.
   ok  K1: ro.shell.palette.placeholder = "Caută pagini, acțiuni, perioade, companii…" is DEAD COPY — no component renders this key. Not a violation; delete it before someone wires it back up.
   ok  K1: 2 command-surface placeholder string(s) checked
   ok  K1b: capsule trigger anchor data-testid="header-command-bar" found in frontend/components/cfo/TopHeader.tsx, frontend/components/instrument/shell/CommandPalette.tsx
   ok  K8: header.spec.ts pins SANCTIONED_DESKTOP (4 identities)

FAIL check_capsule_ask — 1 violation(s)

  [K1] frontend/components/instrument/shell/capsuleAnswer/capsuleAnswerStrings.json → en.capsuleAnswer.followUpPlaceholder carries no ask verb: "Search this answer…"
        The Capsule's verb is ASK. A user who reads "search" types a noun, gets a list, and never learns the surface answers.
```

**REVERT** — exit `0` in 0.3s:

```
GATE-WORK capsule-ask units=539 floor=100 label=source+spec-files

PASS check_capsule_ask — ASK-FIRST copy, header budget, selector census (532 source + 7 spec file(s) scanned)
```

Verdict: **PROVEN RED**

---

## narrative-units

U1/U3 — a narrative sentence must not carry its own currency label or build its own money numeral. One claim, one currency.

| | |
|---|---|
| command | `node scripts/check_narrative_units.mjs` |
| work count | stdout, floor **7** narrative producers |
| canary | `NARRATIVE-UNITS` |

**PLANT**

```diff
--- frontend/lib/thresholdSchema.ts
+++ frontend/lib/thresholdSchema.ts (appended)
+// PLANT: a narrative sentence carrying its own currency label.
+export function laneAPlantNote(v: number) {
+  return `Cash of RON ${v} covers one month.`
+}
```

**RED** — exit `1` in 0.1s:

```
NARRATIVE-UNITS: FAIL

  U1-SOURCE  frontend/lib/thresholdSchema.ts  1 violation(s), quarantine allows 0
            227: RON ${
            → a narrative sentence must not carry its own currency label or build its own numeral. Fix it; do not widen QUARANTINE.

1 problem(s). Contract: design_review/narrative/GATES.md
```

**REVERT** — exit `0` in 0.1s:

```
NARRATIVE-UNITS: PASS — 7 narrative producer(s) scanned, 8 known violation(s) held under quarantine (see GATES.md).
```

Verdict: **PROVEN RED**

---

## global-positioning

G2/G3 — Hungary is never a headline, and certification verbs never share a sentence with a global claim.

| | |
|---|---|
| command | `node scripts/check_global_positioning.mjs` |
| work count | stdout, floor **400** frontend files scanned |
| canary | `GLOBAL-POSITIONING GATES` |

**PLANT**

```diff
--- (new file) frontend/components/LaneAPlantHero.tsx
+export function LaneAPlantHero() {
+  return <h1>Hungary first — built for Hungarian accounting</h1>
+}
```

**RED** — exit `1` in 0.1s:

```
G2 HEADLINE LINT — Hungary in a headline position (1):
  frontend/components/LaneAPlantHero.tsx:2: return <h1>Hungary first — built for Hungarian accounting</h1>
GATE-WORK global-positioning units=664 floor=400 label=frontend-files
```

**REVERT** — exit `0` in 0.1s:

```
GATE-WORK global-positioning units=663 floor=400 label=frontend-files
GLOBAL-POSITIONING GATES: PASS (G2 headline lint, G3 honesty lint) — 663 file(s) / 178282 line(s) scanned; HU pattern fired 15x, all inside the allowed country-list files
```

Verdict: **PROVEN RED**

---

## tsc

THE GATE THIS PAGE IS NAMED FOR. A real per-project typecheck, with a baseline that may only shrink.

| | |
|---|---|
| command | `node scripts/check_tsc.mjs` |
| work count | stdout, floor **400** project files typechecked |
| canary | `tsconfig.app.json` |

**PLANT**

```diff
--- (new file) frontend/lib/laneAPlantType.ts
+// PLANT: a real type error in a project file.
+export const total: number = 'not a number'
```

**RED** — exit `1` in 14.8s:

```
  frontend/lib/buildCashFlowStatement.ts|TS2322|Type 'number | boolean | string[]' is not assignable to type 'number'.
  frontend/lib/buildCashFlowStatement.ts|TS2322|Type 'number | boolean | string[]' is not assignable to type 'number'.
  frontend/lib/buildCashFlowStatement.ts|TS2322|Type 'number | boolean | string[]' is not assignable to type 'number'.
  frontend/lib/buildCashFlowStatement.ts|TS2322|Type 'number | boolean | string[]' is not assignable to type 'number'.
  frontend/lib/buildCashFlowStatement.ts|TS2322|Type 'number | boolean | string[]' is not assignable to type 'number'.
  frontend/lib/buildCashFlowStatement.ts|TS2322|Type 'number | boolean | string[]' is not assignable to type 'number'.
  frontend/lib/buildCashFlowStatement.ts|TS2322|Type 'number | boolean | string[]' is not assignable to type 'number'.
  frontend/lib/buildCashFlowStatement.ts|TS2322|Type 'number | boolean | string[]' is not assignable to type 'number'.
  frontend/lib/buildCashFlowStatement.ts|TS2345|Argument of type 'number | boolean | string[]' is not assignable to parameter of type 'number'.
  frontend/lib/buildCashFlowStatement.ts|TS2362|The left-hand side of an arithmetic operation must be of type 'any', 'number', 'bigint' or an enum type.

FAIL — NEW type errors:
  frontend/lib/laneAPlantType.ts
      TS2322: Type 'string' is not assignable to type 'number'.
```

**REVERT** — exit `0` in 19.6s:

```
  frontend/lib/buildCashFlowStatement.ts|TS2362|The left-hand side of an arithmetic operation must be of type 'any', 'number', 'bigint' or an enum type.

PASS — no NEW type errors (41 known, design_review/TSC_BASELINE.txt).
```

Verdict: **PROVEN RED**

---

## npm-build

The frontend actually builds. A type error is not a build failure and a build failure is not a type error; both gates exist.

| | |
|---|---|
| command | `npm run build` |
| work count | stdout, floor **1000** modules transformed |
| canary | `dist/index.html` |

> FIRST ATTEMPT, REJECTED — a new unreferenced file `frontend/lib/laneAPlantBuild.ts` containing a syntax error. The build passed: Vite only parses what something imports, so an orphan file proves nothing. The plant had to enter the module graph (the app entry point).

**PLANT**

```diff
--- frontend/main.tsx
+++ frontend/main.tsx (appended)
+// PLANT: a syntax error in the app entry point.
+export const laneAPlant = (( => {
```

**RED** — exit `1` in 1.6s:

```
19 |  export const laneAPlant = (( => {
   |                               ^
20 |  

    at failureErrorWithLog (/Users/alex/Desktop/folder claude Scandia copy/node_modules/esbuild/lib/main.js:1472:15)
    at /Users/alex/Desktop/folder claude Scandia copy/node_modules/esbuild/lib/main.js:755:50
    at responseCallbacks.<computed> (/Users/alex/Desktop/folder claude Scandia copy/node_modules/esbuild/lib/main.js:622:9)
    at handleIncomingPacket (/Users/alex/Desktop/folder claude Scandia copy/node_modules/esbuild/lib/main.js:677:12)
    at Socket.readFromStdout (/Users/alex/Desktop/folder claude Scandia copy/node_modules/esbuild/lib/main.js:600:7)
    at Socket.emit (node:events:509:20)
    at addChunk (node:internal/streams/readable:564:12)
    at readableAddChunkPushByteMode (node:internal/streams/readable:515:3)
    at Readable.push (node:internal/streams/readable:395:5)
    at Pipe.onStreamRead (node:internal/stream_base_commons:189:23)
```

**REVERT** — exit `0` in 21.9s:

```
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
```

Verdict: **PROVEN RED**

---


## provenance-census

Every figure render site in the frontend carries a recorded verdict about
whether its payload actually holds provenance — and the one shape that
FABRICATES provenance is detected mechanically.

| | |
|---|---|
| command | `node scripts/check_provenance_census.mjs` |
| work count | stdout `GATE-WORK provenance-sites units=N`, floor **80** figure render sites |
| canary | `PROVENANCE CENSUS`, `GATE-WORK provenance-census` |
| registry | `design_review/PROVENANCE_CENSUS.json` (two-sided: unregistered file FAILS, stale entry FAILS, count drift FAILS) |

**THE INCIDENT IT ENCODES.** Found by reading, 2026-09-02, in
`frontend/components/instrument/shell/capsuleAnswer/CapsuleTier0Preview.tsx`:

```tsx
provenance={
  fact.provenance || fact.periodLabel
    ? { source: fact.periodLabel || fact.provenance?.docId }
    : undefined
}
```

Three defects pointing the same way. `periodLabel` was PREFERRED over the
real provenance, so a fact carrying a sheet name and account codes threw
both away. `periodLabel` is required on every `FactRef`, so the condition
was true for every fact in the index — the affordance appeared universally
and therefore distinguished nothing. And a period is not a source: the
card renders that field under a heading reading "Source", so every Tier-0
figure told the reader an origin it did not have.

That is the failure the affordance exists to prevent. A figure that offers
a provenance jump and lands nowhere teaches the reader the affordance is
decorative, and then the ones that DO land stop being believed. Reading is
what found it; reading is not a control.

**PLANT** — the original expression, restored verbatim:

```diff
--- frontend/components/instrument/shell/capsuleAnswer/CapsuleTier0Preview.tsx
-        provenance={provenance}
+        provenance={
+          fact.provenance || fact.periodLabel
+            ? { source: fact.periodLabel || fact.provenance?.docId }
+            : undefined
+        }
```

**RED** — exit `1`:

```
FAIL — 1 finding(s):
  · FABRICATION SHAPE at frontend/components/instrument/shell/capsuleAnswer/CapsuleTier0Preview.tsx:56 — `source: fact.periodLabel`. A period, a scope, a date or a bare label is not a SOURCE. The card labels that field "Source"; feed it what the figure was read from, or use the `period` field.
```

**REVERT** — plant removed, exit `0`:

```
PASS — 156 figure site(s) across 37 file(s), each with a recorded provenance verdict; no fabricated affordance.
```

**KNOWN LIMIT, stated rather than smoothed over.** The antibody matches
one shape — a `source:` whose value's leaf identifier names a period, a
scope, a date or a bare label. The next fabrication will look different.
That is why the REGISTRY exists alongside it: a new figure site changes a
measured count, and the author has to record a payload verdict before the
gate goes green. The registry's fifth bucket, `UNAUDITED`, is capped at 12
files so the unexamined debt is visible and cannot grow quietly.

**SELF-TEST, 2026-09-02.** `--probe-vacuity` was silently IGNORED — the gate ran its full 156-site census and printed PASS while claiming to probe itself. Now wired into discovery: exit **1**, `units=0 floor=20`. The gate always did red on empty discovery; it had never proved that about itself.

## provenance-contrast

The provenance affordance's own colours, computed from the token sheet in
BOTH themes: every text class at AA 4.5:1 against `--popover`, and the
dotted underline at the 3:1 WCAG 1.4.11 floor for a non-text indicator.

| | |
|---|---|
| command | `node scripts/check_provenance_contrast.mjs` |
| work count | stdout `GATE-WORK provenance-contrast units=N`, floor **6** colour nodes across both themes |
| canary | `PROVENANCE AFFORDANCE — CONTRAST`, `provenance underline` |

**THE INCIDENT IT ENCODES.** Two, both live at HEAD on 2026-09-02, both
invisible to the eye and to a screenshot diff.

The card's labels and its snapshot line used `--ink-mute`, which measures
**3.53:1** on the popover in light theme — an AA failure on every label in
the card. An earlier pass on this codebase found AA failing on 10 of 16
text nodes from the same single-token cause.

Worse in kind: the dotted rule under a provenanced figure is the ONLY
signal that the figure HAS provenance before anyone hovers it, which makes
it a non-text UI indicator. At `brand/40` it composites to **1.78:1** in
light and **2.27:1** in dark, against a 3:1 floor. `brand/70` was tried and
reaches only 2.93:1 in light — still failing, and exactly the "close
enough" a human eye would have shipped. It is now `brand/80` (3.50:1 /
5.48:1).

**THE GATE'S OWN FIRST BUG, also recorded.** Version one declared its
subjects as constants inside the script. Lowering the component's alpha
back to 40% left the gate GREEN, because it was measuring its own copy of
the design rather than the design — TC-7, the same shape as a fix that
once landed on `CapsuleJumpList` while `CommandPalette.renderRow` was what
painted. Every subject is now parsed out of `Provenance.tsx`.

**PLANT** — the alpha that shipped, restored:

```diff
--- frontend/components/instrument/Provenance.tsx
-    ? "underline decoration-brand/80 decoration-dotted decoration-1 underline-offset-4"
+    ? "underline decoration-brand/40 decoration-dotted decoration-1 underline-offset-4"
```

**RED** — exit `1`:

```
  FAIL   1.78:1  underline  --brand @ 40% on --surface (non-text 3:1)
  FAIL   2.27:1  underline  --brand @ 40% on --surface (non-text 3:1)
FAIL — 2 finding(s):
  · light: the provenance underline (--brand @ 40%) composites to 1.78:1 — below the 3:1 WCAG 1.4.11 threshold for a non-text indicator. It is the only thing that says a figure HAS provenance before you hover it.
  · dark: the provenance underline (--brand @ 40%) composites to 2.27:1 — below the 3:1 WCAG 1.4.11 threshold for a non-text indicator. It is the only thing that says a figure HAS provenance before you hover it.
```

**REVERT** — `/80` restored, exit `0`:

```
PASS — 6 colour node(s) measured across both themes; every text node at or above AA 4.5:1 and the underline above 3:1.
```

**KNOWN LIMIT.** This reads declared tokens and declared classes. It
cannot see an overlay, a blend mode, or a colour applied by a parent —
those need a rendered browser and are a different gate. Both defects it
encodes lived in the declarations, which is why this is where it looks.

**SELF-TEST, 2026-09-02.** `--probe-vacuity` was silently IGNORED — exit 0 with real measurements. Its discovery is a fixed six-entry roster, the easiest kind to hollow out. Now wired: exit **1**, `DISCOVERY BROKEN: 2 measurements, floor 6` — the residual 2 being the underline × 2 themes, so the floor is calibrated against the roster rather than pulled from the air.

---

## firm-cockpit-gates

FC7 + FC8 — the FIRM COCKPIT backend. FC7: a file uploaded via a request
link lands through the NORMAL pipeline (the browser's documents-row shape,
the same `_admin_set_status("queued")` + `_enqueue` the run route calls,
the request's period as the confirmation hint) and the period-mismatch and
entity guards FIRE on a wrong-period / wrong-entity file. FC8: with the
model mocked DEAD, attention items, calendar deadlines, the digest and the
brief render complete with an honest notice and zero raw model payload; a
model call planted into the ranking path reds the structural assertion.
Both defects fail SILENTLY (a side channel that files a document one month
off; a model that quietly reorders the board), which is why the gate is
named separately from `pytest`.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_firm_gates.py -q` |
| work count | junit-xml, floor **15** tests (measured: 22, rounded down) |
| canary | `test_fc7_request_link_lands_through_the_normal_pipeline`, `test_fc7_plant_wrong_entity_file_fires_the_entity_guard`, `test_fc8_dead_model_renders_items_calendar_digest_and_brief_complete`, `test_fc8_plant_model_call_in_ranking_path_reds_the_structural_assertion` |

Subjects are REAL bytes and REAL output (TC-1): the committed example
trial balances (`tests/fixtures/trial_balance/*.xlsx`, a real preamble —
company, CUI, "Balanta de verificare … Perioada") and the anonymised
corpus exports (no preamble at all — the UNKNOWN identity case), the real
attention runner over the corpus served envelopes + regression statements,
and the pipeline's own `resolve_period_end_for_persist` as the period seam.

Every plant below was applied in an isolated rsync copy of the tree
(`.venv` symlinked); the live tree was never modified and
`design_review/PLANT_MANIFEST.json` stayed empty.

**GREEN** — the clean copy, exit `0`:

```
============================== 21 passed in 1.17s ==============================
```

**PLANT P1** — the entity guard disabled:

```diff
--- src/engine/api/_firm_requests.py (land_file)
-    if inspection.entity.verdict == VERDICT_MISMATCH:
+    if inspection.entity.verdict == "never":  # PLANT P1 — the entity guard disabled
         raise LandingRefused(409, {
```

**RED** — exit `1`:

```
E   Failed: DID NOT RAISE <class 'engine.api._firm_requests.LandingRefused'>
FAILED tests/engine/test_firm_gates.py::test_fc7_plant_wrong_entity_file_fires_the_entity_guard
========================= 1 failed, 20 passed in 1.13s =========================
```

**PLANT P2** — the silent refile: the confirmation hint moved onto the
DETECTED month instead of the request's (the exact class of defect the
period-integrity W-law was written for, from the other direction):

```diff
--- src/engine/api/_firm_requests.py (land_file, the documents row)
-        "period_end_hint": period_end,
+        "period_end_hint": inspection.period.get("proposed") or period_end,  # PLANT P2
```

**RED** — exit `1` (the persist seam now sees no disagreement, because
the row was rewritten before it could):

```
E   AssertionError: assert '2025-12-31' == '2024-11-30'
E
E     - 2024-11-30
E     + 2025-12-31
FAILED tests/engine/test_firm_gates.py::test_fc7_plant_wrong_period_file_fires_the_period_mismatch_guard
========================= 1 failed, 20 passed in 1.12s =========================
```

**PLANT P3** — the model ranks: the accepted draft's `suggested_order`
becomes the brief's `order`:

```diff
--- src/engine/api/_firm_brief.py (compose_brief)
     advisory = draft_advisory(view, client_factory, state_dir)
+    if advisory.get("available"):  # PLANT P3 — the model ranks
+        by_id = dict((it.item_id, it) for it in view.items)
+        view = BriefView(view.as_of, view.firm_key, tuple(by_id[i] for i in advisory["suggested_order"]),
+                         view.groups, view.slugs, view.facts, view.item_set_hash)
     payload = brief_payload(view, advisory)
```

**RED** — exit `1`:

```
E   AssertionError: assert ['DEADLINE:or...6-08-31', ...] == ['MISSING_FIL...6-07-31', ...]
E
E     At index 0 diff: 'DEADLINE:org-carni:deadline:d300_vat_return:2026-09-25' != 'MISSING_FILE:org-carni:period:2026-02-28'
FAILED tests/engine/test_firm_gates.py::test_fc8_model_may_suggest_but_never_ranks
========================= 1 failed, 20 passed in 1.13s =========================
```

**PLANT P4** — a model reachable from the ranking path:

```diff
--- src/engine/firm/digest.py
 from . import model as _model
+from engine.ai import breaker  # PLANT P4 — a model reachable from the ranking path
```

**RED** — exit `1`:

```
E   AssertionError: assert ['digest.py i...e.ai.breaker'] == []
E
E     Left contains 2 more items, first extra item: 'digest.py imports engine.ai'
FAILED tests/engine/test_firm_gates.py::test_fc8_plant_model_call_in_ranking_path_reds_the_structural_assertion
========================= 1 failed, 20 passed in 1.08s =========================
```

**REVERT** — all four plants removed, exit `0`:

```
============================== 21 passed in 1.07s ==============================
```

Verdict: **PROVEN RED** (four plants, four distinct tests, each red for
its own reason; 20 of 21 stayed green under every plant, so each red is
the defect and not collateral).

**PLANT P5** — added after the four above, for
`test_fc7_firm_request_routes_resolve_past_the_tenancy_router`: the two
single-segment READS (`GET /api/firm/requests`, `GET /api/firm/cadence`)
restored, AND the tenancy router's `GET /api/firm/{firm_id:uuid}` (mounted
first) stripped of its uuid converter — the day either lane drifts that
way, a read is swallowed as a firm id and answered 403. Two-sided on
purpose: with the converter in place the single-segment reads resolve
(nothing matches them, so they fall through to this lane), which is why
the first attempt with only this lane's side planted stayed GREEN — a
plant that reproduces the hazard, not one that merely edits the subject.

```diff
--- src/engine/api/_firm_requests.py
-    @router.get("/requests/list")
+    @router.get("/requests")  # PLANT P5 — single-segment read
-    @router.get("/cadence/status")
+    @router.get("/cadence")  # PLANT P5
--- src/engine/api/_firm.py
-    @router.get("/{firm_id:uuid}")
+    @router.get("/{firm_id}")  # PLANT P5 — converter dropped
```

**RED** — exit `1` (Starlette's own matcher, both routers mounted in
server order):

```
E   AssertionError: ['GET /api/firm/requests -> /api/firm/{firm_id}', 'GET /api/firm/cadence -> /api/firm/{firm_id}']
FAILED tests/engine/test_firm_gates.py::test_fc7_firm_request_routes_resolve_past_the_tenancy_router
============================== 1 failed in 0.57s ===============================
```

**REVERT** — exit `0`: `22 passed`.

**KNOWN LIMITS.** The landing's side effects (blob write, row insert,
status, enqueue) are recorded fakes; what is proven real is the ORDER and
the ROW SHAPE (checked against the frontend's own `uploadDocument` insert,
read from `frontend/lib/supabase.ts`) and that `production_deps()` binds
to the pipeline's actual `_admin_set_status` / `_enqueue`. The
`stage_persist` seam is exercised through `resolve_period_end_for_persist`
on the row the landing wrote; the full persist (line items, envelope) is
the corpus-replay gate's subject. The entity guard reads the preamble
above the header row the real parser locates; a PDF export yields UNKNOWN
(recorded, not refused) — a PDF preamble reader is a later wave.

## firm-attention-fc2

FC2 — DETERMINISM of the Firm Cockpit's attention items. The same client
data must produce the same items, in the same order, at the same
severities — with the AI flag on or off and the input shuffled. The defect
it exists to catch fails SILENTLY: an environment flag that nudges a grade
would never throw, it would just re-order a firm's morning.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_firm_attention.py -q -k fc2` |
| work count | junit-xml, floor **3** tests |
| canary | `test_fc2_same_data_same_items_same_order_same_severities` |

Subjects are real engine output (TC-1): `tests/engine/fixtures/firm/`,
captured by `capture.py` through parse → assemble → the real
`stage_persist`; `capture.py --check` re-captures and fails on one
differing byte.

**PLANT FC2-A** — `src/engine/firm/severity.py`, an AI flag in the
environment moves the grade:

```diff
-    severity = policy.clamp(index)
-    breakdown["result"] = severity
+    import os  # PLANT FC2-A: an AI flag in the environment moves the grade
+    if os.environ.get("ANTHROPIC_API_KEY"):
+        index = _clamped(index + 1)
+    severity = policy.clamp(index)
+    breakdown["result"] = severity
```

**RED** — exit `1`:

```
E   AssertionError: FC2 DETERMINISM VIOLATED — the same client data produced different items, order or severities across runs (AI on/off, input shuffled)
FAILED tests/engine/test_firm_attention.py::test_fc2_same_data_same_items_same_order_same_severities
================== 1 failed, 2 passed, 38 deselected in 4.15s ==================
```

**REVERT** — exit `0`: `3 passed, 38 deselected in 0.67s`. Verdict: proven RED.

## firm-attention-fc4

FC4 — MATERIALITY. The same absolute delta must grade differently on a
small client and a large one, because severity is scaled by the client's
own totals via `_finding_rank.assess_materiality`. The pair is two REAL
corpus periods (agras, served total assets 39.27 M RON; carniprod,
125.89 M RON): the same 250 000 RON covenant headroom is `material` on
one and `info` on the other, so it grades `high` vs `medium`.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_firm_attention.py -q -k fc4` |
| work count | junit-xml, floor **3** tests |
| canary | `test_fc4_end_to_end_one_covenant_two_real_clients_two_severities` |

**PLANT FC4-A** — `src/engine/firm/attention.py`, the grade ignores the
client's own totals:

```diff
-    basis_id = spec.materiality_basis
-    if basis_id is None:
-        return None, None
+    basis_id = spec.materiality_basis  # PLANT FC4-A: ignore the client's own totals
+    if basis_id is None or True:
+        return None, None
```

FIRST ATTEMPT — RED for the WRONG reason (recorded, because it changed
the gate): `TypeError: 'NoneType' object is not subscriptable` three
lines before the claim. A TypeError is not evidence (TC-2); the gate now
asserts its own claim FIRST and states the un-graded case in its own
words.

**RED** — second attempt, same plant, exit `1`:

```
E   AssertionError: FC4 MATERIALITY VIOLATED — identical covenant headroom of 250000 RON graded 'high' on the small client and 'high' on the large one
FAILED tests/engine/test_firm_attention.py::test_fc4_end_to_end_one_covenant_two_real_clients_two_severities
================== 1 failed, 2 passed, 38 deselected in 0.71s ==================
```

**REVERT** — exit `0`: `3 passed, 38 deselected in 0.60s`. Verdict: proven RED.

## firm-attention-fc5

FC5 — DEDUP. N attention items on one client are ONE row with N reasons,
never N rows. The board is a list of clients, not a list of alarms; a row
per item is the shape that buries the one client that matters under
twelve lines of its own noise.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_firm_attention.py -q -k fc5` |
| work count | junit-xml, floor **2** tests |
| canary | `test_fc5_five_items_on_one_client_is_one_row_with_five_reasons` |

**PLANT FC5-A** — `src/engine/firm/dedup.py`, one row PER ITEM:

```diff
-    return tuple(sorted(rows, key=lambda r: r.sort_key()))
+    from dataclasses import replace  # PLANT FC5-A: one row PER ITEM, not per client
+    rows = [replace(r, items=(i,)) for r in rows for i in r.items] or rows
+    return tuple(sorted(rows, key=lambda r: r.sort_key()))
```

**RED** — exit `1`:

```
E   AssertionError: FC5 DEDUP VIOLATED — 12 rows for one client
FAILED tests/engine/test_firm_attention.py::test_fc5_five_items_on_one_client_is_one_row_with_five_reasons
================== 1 failed, 1 passed, 39 deselected in 0.61s ==================
```

**REVERT** — exit `0`: `2 passed, 39 deselected in 0.56s`. Verdict: proven RED.

## firm-attention-fc9

FC9 — PERFORMANCE, measured not claimed. 200 clients: opening an
unchanged board recomputes nothing; one changed snapshot recomputes
exactly one client; the p50 per client is printed by the test. Two
defects, both silent: a cache that is never trusted (a full recompute on
every open) and the dangerous one — a cache keyed on the CLIENT alone,
which serves STALE facts for a changed snapshot and looks fast doing it.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_firm_attention.py -q -k fc9` |
| work count | junit-xml, floor **2** tests |
| canary | `test_fc9_two_hundred_clients_compute_incrementally_and_the_p50_is_measured` |

**PLANT FC9-A** — `src/engine/firm/facts.py`, never trust the cache:

```diff
-        if found is not None and found.snapshot_key == key:
+        if False:  # PLANT FC9-A: never trust the cache — a full recompute on every open
```

**RED** — exit `1`:

```
E   AssertionError: FC9 NOT INCREMENTAL — opening an unchanged board recomputed 200 client(s)
FAILED tests/engine/test_firm_attention.py::test_fc9_two_hundred_clients_compute_incrementally_and_the_p50_is_measured
================== 1 failed, 1 passed, 39 deselected in 2.57s ==================
```

**REVERT** — exit `0`, and the measurement prints again:
`[FC9] 200 clients — cold facts: p50=5.1ms p95=5.5ms/client, total=1.00s; warm open (0 changed): 78ms total, 0.39ms/client; incremental (1 changed): 78ms total, misses=1 hits=199`.

**PLANT FC9-B** — the cache keyed on the client alone. The first attempt
changed only the `if` guard and left the `(client, key)` lookup intact, so
nothing stale was ever served and the gate stayed green — a plant that
does not create the defect proves nothing. The second attempt plants the
real shape:

```diff
-        found = self._entries.get(cache_key)
-        if found is not None and found.snapshot_key == key:
+        found = next((v for k, v in self._entries.items()  # PLANT FC9-B: keyed on the client alone
+                      if k[0] == client.client_id), None)
+        if found is not None:
```

**RED** — exit `1`:

```
E   AssertionError: FC9 NOT INCREMENTAL — one client changed; expected exactly 1 recompute, got 0 (0 = the cache served STALE facts for a changed snapshot; 200 = a full recompute)
FAILED tests/engine/test_firm_attention.py::test_fc9_two_hundred_clients_compute_incrementally_and_the_p50_is_measured
================== 1 failed, 1 passed, 39 deselected in 1.77s ==================
```

**REVERT** — exit `0`: `2 passed, 39 deselected in 1.62s`. Both times
`design_review/PLANT_MANIFEST.json` returned to `"plants": []` and every
planted file was restored byte-for-byte. Verdict: proven RED.

## firm-tenancy-fc1

FC1 — TENANCY. FIRM → CLIENTS → PERIODS with roles as data. A firm member
sees exactly the clients their firm is assigned to, at the cell of the
role matrix their role holds; a client workspace that was never assigned
to a firm is untouched; a member of firm B never reaches firm A's client
through their own firm — blocked at BOTH walls (the SQL RLS helper
`can_read_client_org` and the Python `require_client` gate), because a
wall that exists only in Python is a wall the next REST client walks
through. The defects it exists to catch are silent: a helper that returns
true, a skipped check that answers 200, a matrix cell flipped in one
place and not the other.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_firm_tenancy.py -q` |
| work count | junit-xml, floor **150** tests (measured: 203) |
| canary | `test_fc1_plant_cross_firm_read_is_blocked_at_both_walls`, `test_fc1_solo_workspace_is_untouched`, `test_fc1_rls_shows_firm_a_rows_to_firm_a_roles_by_the_read_cell` |

The SQL double evaluates the migration's helper BODIES
(`schema_phase_firm.sql`: `can_read_client_org`, `firm_can`) rather than
mirroring them — `test_the_double_evaluates_the_migrations_helper_bodies_not_a_mirror`
exists so that a fake store cannot hide a policy defect (the class of
failure recorded under *Fake stores hid 20+ defects*). Every plant below
was applied in an rsync copy of the tree; the live tree stayed clean and
`design_review/PLANT_MANIFEST.json` stayed empty.

**GREEN** — exit `0`: `203 passed in 3.77s`.

**PLANT 1** — the SQL wall opened: `can_read_client_org` returns `true`
for everyone.

**RED** — exit `1`, `11 failed, 192 passed`:

```
test_firm_tenancy.py:1587: AssertionError: RLS wall breached: {"version":"firm-a1","firm_i…
test_firm_tenancy.py:1494: AssertionError: assert [{'assembled_...: 'RON', ...}] == []
FAILED tests/engine/test_firm_tenancy.py::test_fc1_rls_hides_every_firm_a_row_from_a_non_member[b_owner-financial_periods-]
FAILED tests/engine/test_firm_tenancy.py::test_fc1_plant_cross_firm_read_is_blocked_at_both_walls
FAILED tests/engine/test_firm_tenancy.py::test_fc1_solo_workspace_is_untouched
FAILED tests/engine/test_firm_tenancy.py::test_sql_client_data_firm_policies_are_select_only_and_go_through_can_read_client_org
```

**REVERT** — exit `0`: `203 passed in 3.79s`.

**PLANT 2** — the Python wall skipped: `require_client` no longer refuses
a client outside the caller's firm.

**RED** — exit `1`, `11 failed, 192 passed` — the route answers with the
role's own refusal instead of "Not a client of this firm", i.e. the
request reached the matrix it should never have been shown:

```
test_firm_tenancy.py:1530: assert "Your firm ro...old 'assign'." == 'Not a client of this firm'
FAILED tests/engine/test_firm_tenancy.py::test_fc1_a_firm_member_cannot_reach_another_firms_client_through_their_own_firm[firm_b_client-periods]
FAILED tests/engine/test_firm_tenancy.py::test_fc1_a_firm_member_cannot_reach_another_firms_client_through_their_own_firm[solo-detach]
FAILED tests/engine/test_firm_tenancy.py::test_detach_by_firm_manage_or_workspace_owner_only
```

**REVERT** — exit `0`: `203 passed in 3.89s`.

**PLANT 3** — the role matrix flipped in SQL only (`viewer` granted
`manage` in the seed, not in Python).

**RED** — exit `1`, `4 failed, 199 passed`:

```
test_firm_tenancy.py:1239: AssertionError: SQL seed viewer/manage = True, recorded False
FAILED tests/engine/test_firm_tenancy.py::test_matrix_cell_agrees_across_sql_python_and_the_record[viewer-manage]
FAILED tests/engine/test_firm_tenancy.py::test_fc1_rls_shows_firm_a_rows_to_firm_a_roles_by_the_read_cell
```

**REVERT** — exit `0`: `203 passed in 4.12s`.

**PLANT 4** — the role matrix flipped in Python only (`ROLE_MATRIX`
viewer/manage = True).

**RED** — exit `1`, `5 failed, 198 passed`:

```
test_firm_tenancy.py:1656: AssertionError: viewer must NOT hold manage: 200 {"firm_id":"00…
test_firm_tenancy.py:1240: AssertionError: ROLE_MATRIX viewer/manage = True, recorded False
FAILED tests/engine/test_firm_tenancy.py::test_matrix_cell_is_enforced_by_the_route[viewer-manage]
FAILED tests/engine/test_firm_tenancy.py::test_roles_endpoint_publishes_the_matrix_verbatim
```

**REVERT** — exit `0`: `203 passed in 4.19s`. Verdict: proven RED, four
ways, at both walls.

## route-binding

Every mutating route in the REAL app parses its body, and the full OpenAPI
schema generates. The defect class was live in production twice at once
(found 2026-09-04): a Pydantic request model defined INSIDE a router
factory in a module under `from __future__ import annotations` — the
handler's annotation is then a string FastAPI cannot resolve from module
globals, so the body is demanded as a required QUERY parameter and every
real request is answered 422 `loc: ["query", <param>]`. `ToolCall` broke
every grounded Capsule tool call; `ContactSalesRequest` broke every
contact-sales submission (and 500'd `/openapi.json`, together with a
`-> JSONResponse` return annotation whose import was closure-local in
`public_market/search.py`). The Playwright specs intercept those routes,
which is exactly why no UI gate ever saw it: an intercepted route is a
route with no gate.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_route_bindings.py -q` |
| work count | junit-xml, floor **3** tests; the tests themselves floor their subjects (≥40 mutating routes probed — measured 87; ≥5 future-annotations modules scanned; ≥100 OpenAPI paths — measured 177) |
| canary | `test_no_mutating_route_demands_its_body_as_a_query_param`, `test_no_request_model_is_nested_inside_a_function_under_future_annotations`, `test_the_full_openapi_schema_generates` |

Subject is the real `create_app()` (test-manifest Supabase URL, boot
verification skipped, no network); the fixture refuses to build against a
non-manifest URL.

**GREEN** — exit `0`:

```
[route-binding] 87 mutating routes probed, 0 body-as-query
[route-binding] openapi paths: 177
3 passed
```

**PLANT** — `src/engine/api/_billing.py`: `ContactSalesRequest` nested back
inside `build_router` (the exact shape that shipped).

**RED** — exit `1`, `3 failed`, each through its own message:

```
ROUTE-BINDING VIOLATED — 1 route(s) demand their BODY as a QUERY param (closure-local Pydantic model under `from __future__ import annotations`):
  POST /api/contact-sales  loc=['query', 'req']
ROUTE-BINDING VIOLATED — Pydantic model(s) nested inside a function under `from __future__ import annotations` (unresolvable forward ref):
  _billing.py:… ContactSalesRequest (inside build_router)
PydanticUserError: … is not fully defined   (test_the_full_openapi_schema_generates)
```

**REVERT** — exit `0`: `3 passed`; no `# PLANT` marker left. Verdict:
proven RED.

## cron-auth

Every scheduler-only route FAILS CLOSED without `ENGINE_API_TOKEN`, and
refuses a wrong or missing bearer when the token is set. Found 2026-09-04
by sweeping every mutating route of the real app for an unauthenticated
2xx: `POST /api/billing/cron/renewal-reminders` skipped its bearer check
when the token was unset (its docstring called this "degrades to open").
In production the token turned out to be set — the live routes answer 401
— so the exposure was latent, not live; the gate exists so it can never
become live. `/api/workspaces/cron/purge-expired` and the two firm crons
already failed closed.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_cron_auth.py -q` |
| work count | junit-xml, floor **8** tests (4 routes × 2 claims) |
| canary | `test_cron_without_a_configured_token_is_503_never_run`, `test_cron_with_a_wrong_bearer_is_refused` |

Subject is the real `create_app()` under the test-manifest Supabase URL, no
network. The "unset token" test treats *the handler ran at all* as the
violation — in a hermetic process an open cron surfaces as a connection
error, and a gate that let that pass as "not a 503 assertion" would be red
for the wrong reason (TC-2).

**GREEN** — exit `0`: `8 passed`.

**PLANT** — `src/engine/api/_billing.py`: the open branch restored
(`if token:` around the bearer check; the 503 disabled).

**RED** — exit `1`, `1 failed, 7 passed`, through the gate's own message:

```
E   AssertionError: CRON RUNS OPEN — POST /api/billing/cron/renewal-reminders ran and raised ConnectError (it reached for the database) with ENGINE_API_TOKEN unset (an anonymous caller can trigger it)
FAILED tests/engine/test_cron_auth.py::test_cron_without_a_configured_token_is_503_never_run[POST-/api/billing/cron/renewal-reminders]
```

(The first attempt at this plant died on the ConnectError itself — a red
for the wrong reason; the test was rewritten to name the violation before
the transcript above was taken.)

**REVERT** — exit `0`: `8 passed`; no `# PLANT` marker left. Verdict:
proven RED.

## public-refresh-shield

The public cache-BUST routes are shielded by a rate limiter plus an operator
bearer. Found 2026-09-04: `POST /api/public/companies/{ticker}/refresh` and
`POST /api/public/intelligence/refresh-signals` each answered 200 to twelve
consecutive unauthenticated POSTs against the real app, and neither module
referenced any limiter. They leak nothing and fetch nothing themselves — they
INVALIDATE caches, so the next read is cold against upstream. The US market is
served from SEC EDGAR, whose terms this repo quotes in
`src/engine/public_market/markets.yaml` ("Current max request rate: 10
requests/second"). A loop drives cold reads until the host is blocked and the
whole US market goes down. An availability risk, not a disclosure one.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_public_refresh_shield.py -q` |
| work count | junit-xml, floor **20** tests (measured 21) |
| canary | `test_both_guarded_routes_still_exist_on_the_real_app`, `test_anonymous_calls_are_limited_after_the_budget`, `test_a_limited_call_mutates_no_cache`, `test_a_valid_bearer_is_never_limited`, `test_rotating_a_spoofed_leftmost_hop_cannot_mint_new_buckets`, `test_the_shield_and_the_limiter_read_the_same_hop` |

Subject is the real `create_app()` under the test-manifest Supabase URL, no
network and no intercepts — §22's rule that an intercepted route is a route
with no gate is why the Capsule 422 reached production.

The budget is derived, not guessed: the shortest TTL either route invalidates
is 60 s, so one bust per minute is already the ceiling of usefulness; the
default is 5/min for headroom, one bucket per CLIENT rather than per route,
because cold upstream reads are a shared resource and a per-route budget would
let a loop alternate for double fan-out.

Two asymmetries are deliberate and asserted. **ABSENT is not ZERO on
`ENGINE_API_TOKEN`**: unlike `cron-auth`, an unset token does NOT fail closed —
the bearer path is simply unavailable and the anonymous limited path still
serves, because refusing would break a working public surface to protect a
cache. A route that WRITES does not get this treatment. **A wrong bearer is
treated as anonymous**, not 401, so the route is not an oracle for probing.

The limiter keys on the RIGHTMOST forwarded hop. Caddy fronts this backend
with a bare `reverse_proxy`, which APPENDS the real peer, so index 0 is always
caller-written. `engine.public_ro.ratelimit._client_ip` read index 0 until
2026-09-04 — the RO storefront's own shield over 600k public pages was
bypassable by rotating one header — and `funnel._client_ip` had been fixed
long before without being back-ported. All three now agree, and
`test_the_shield_and_the_limiter_read_the_same_hop` pins that so they cannot
drift again. The bypass itself is pinned in
`tests/engine/test_public_compliance.py`.

**GREEN** — exit `0`: `21 passed`.

**PLANT** — `src/engine/public/intelligence/routes.py`: the two guard lines
deleted from `refresh_signals`.

**RED** — exit `1`, through the gate's own message naming the route:

```
E   AssertionError: ROUTE IS UNSHIELDED — /api/public/intelligence/refresh-signals answered 200 to the N+1st anonymous cache-bust in the window. An unbounded loop here forces cold upstream reads until the provider blocks the host.
FAILED tests/engine/test_public_refresh_shield.py::test_anonymous_calls_are_limited_after_the_budget[/api/public/intelligence/refresh-signals]
```

**REVERT** — exit `0`: `21 passed`; no `# PLANT` marker left.

**Recorded honestly:** an adversarial critic reproducing this plant measured
`10 failed, 10 passed`, not the 4 the authoring lane reported, and the extra
failures included a route that was still guarded — so the message discriminates
less than claimed. The plant reds; the blast radius is wider than one
parametrisation.

## public-post-surface

Every mutating route under `/api/public` is classified — walled, shielded, or
public by design with a stated reason — and the classification is checked
against the REAL `create_app()`, so a new route cannot appear unclassified.

Found 2026-09-04, both live in production:

- `POST /api/public/intelligence/signals/manual` answered **422 to an empty
  body**, meaning it reached validation with no authentication of any kind. An
  anonymous caller with a valid payload **creates a macro signal** that the
  product serves to users through the risk radar and every per-ticker risk
  score. That is content injection, not a cache bust. Reproduced locally: an
  anonymous POST returned 200 and created a live signal.
- `POST /api/public/intelligence/refresh-filings-cache` answered 200
  unauthenticated and performs the SEC EDGAR request **itself, synchronously,
  inside the handler**. SEC publishes a 10 requests/second ceiling; the US
  market is served from EDGAR, so a loop here gets the host blocked and takes
  that market down.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_public_post_surface.py -q` |
| work count | junit-xml, floor **21** tests |
| canary | `test_every_public_post_on_the_real_app_is_classified`, `test_the_walled_payloads_are_valid_so_a_401_means_the_wall`, `test_a_walled_route_refuses_when_the_token_is_unset`, `test_a_walled_route_refuses_a_wrong_bearer`, `test_an_unauthenticated_manual_signal_creates_nothing`, `test_an_unauthenticated_filings_refresh_never_calls_edgar`, `test_sync_is_limited_after_the_budget`, `test_ps8_compliance_routes_are_walled_and_never_rate_limited` |

**Why the two walled routes fail closed and the shielded ones do not.** The
deciding question is what a FALSE REFUSAL costs. `refresh_shield` deliberately
does not fail closed on an unset token, because refusing would break a live
public surface to protect a cache. Neither walled route is a public surface:
both have zero callers in `frontend/`, `e2e/`, `scripts/` and `deploy/`, and
one of them writes. A rate limit is the wrong control for a durable write —
it still admits one injected signal per window, and one is enough, because the
damage is durable rather than proportional to call rate.

**The vacuity trap this gate had to dodge.** FastAPI validates the body BEFORE
the handler, so an anonymous POST with `{}` returns 422 whether or not the wall
exists. A gate posting `{}` and asserting "not 200" stays green with the wall
deleted. Every wall assertion therefore uses a KNOWN-VALID payload, and
`test_the_walled_payloads_are_valid_so_a_401_means_the_wall` proves that
validity by driving the same body through with a correct bearer. Corrupting the
payload reds that control, so it is load-bearing.

**PS8 is respected deliberately.** The takedown and teardown routes are walled
but never rate-limited, and the gate pins that. A limiter can refuse; a
takedown that answers 429 under load is a takedown that was not honoured. An
authenticated operator who is never limited is the correct control.

The EDGAR fetch is replaced by a spy in every test that can reach that route,
so even a planted regression is caught without a request leaving the machine.

**GREEN** — exit `0`: `21 passed`.

**PLANT / RED / REVERT**, three plants, each redding only its own route:

```
remove _require_operator from post_manual_signal      -> 4 failed, 17 passed
  E  OPERATOR ROUTE RUNS OPEN — /api/public/intelligence/signals/manual answered 200 to an anonymous, VALID-payload POST with ENGINE_API_TOKEN unset
remove _require_operator from refresh_filings_cache   -> 4 failed, 17 passed
  E  OUTBOUND AMPLIFIER OPEN — /api/public/intelligence/refresh-filings-cache answered 200 to anonymous call 1 with ENGINE_API_TOKEN unset. This handler performs the SEC EDGAR request itself, synchronously.
remove the two _refresh_guard lines from sync_company -> 3 failed, 18 passed
  E  ROUTE IS UNSHIELDED — /api/public/companies/AAPL/sync answered 503 to the N+1st anonymous sync (budget 3/min)
```

In each case the other routes' parametrisations stayed green, and an
independent critic reproduced all three counts and confirmed no collateral
reds suite-wide. Two further plants held: a new unclassified `/api/public` POST
reds exactly one test naming it, and corrupting the known-valid payload reds
the anti-vacuity control.

**Known and NOT closed by this gate:** it filters on mutating methods, and the
real upstream amplifiers are anonymous GET routes — `price-history?refresh=true`,
`universe?refresh=true`, `companies/{ticker}` and `search` each reach Yahoo or
Nasdaq on every call, unbounded, while the two shielded POST routes make zero
outbound calls ever. That inversion is tracked separately; this gate must not
be read as covering it.
