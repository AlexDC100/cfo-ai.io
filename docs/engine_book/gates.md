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

## radar

`tests/engine/test_radar_series.py`, `test_radar_detectors.py`,
`test_radar_detector_pack.py`, `test_radar_detector_repairs.py`,
`test_e8_jurisdiction_blindness.py` — the cross-period spine, the twelve
detector families as pack data, and the six defects an adversarial read found
in them.

**Why this is a gate and not just part of `pytest`.** All six defects shipped
GREEN. Not one of them crashed, and not one of them produced a value a reader
would have questioned:

| defect | what a reader would have seen |
|---|---|
| a year admitted before it closed | `ro_revenue_cutoff` HIGH on a clean book: "33.3% of 2025 activity landed in 2025-03, the final period of the year". In March. |
| a gap filtered out of a quiet run | a dormancy finding built across periods where the account was absent from the book — 2023-01 and 2025-11 read as neighbours |
| the E8 jurisdiction guard case-sensitive | every pack loader lower-cases the token, so the shape a real weld takes — `if token == "ro":` — passed the guard that exists to catch it |
| `movement_signed() or 0.0` | "related-party movement 0.0% of total assets" on every persisted period, because `canonical_bs` serves no movement column. The ledger tier measures 2.12% on the same book. |
| an impact with two identical endpoints | a HIGH finding whose consequence line reads "moves from 0.0% to 0.0% (-0.0%)" |
| a concentration inside an immaterial balance | 57% of a receivable ledger that is 0.03% of total assets, surfaced as HIGH |

The last of those was found BY the fifth: the renderer-based impact check reds
on the realestate book, which is how a true ratio with no consequence became
visible at all.

**GREEN** — exit `0`: `102 passed`.

**PLANT / RED / REVERT**, six plants, each redding through its own message:

```
cutoff: admit a year on a count of periods present
  -> E  AssertionError: a half-year and a quarter produced a cut-off finding:
        33.3% of 2025 activity on 7015.01, 707.010, 707.093 landed in 2025-03,
        the final period of the year, against a median of 16.7%
dormant: filter the gaps out before measuring the run
  -> E  AssertionError: the unbroken run ending at the latest period is 1 period
        and the rule needs 3; this finding was built across a hole
        (the planted run reported quiet_run=5 across a spine with a hole in it)
E8 guard: drop re.IGNORECASE, plant `return token == "ro"` in pack.py
  -> E  src/engine/radar/detectors/pack.py:294: return token == "ro"
interco: movement_signed() or 0.0
  -> E  AssertionError: a movement share was reported from a book that serves no
        movement column: [('interco_share', 0.1958...), ('interco_movement_share', 0.0), ...]
result: accept an impact that prints the same on both sides
  -> E  Failed: DID NOT RAISE UnquantifiedFindingError
concentration: remove the materiality floor from the fire decision
  -> E  UnquantifiedFindingError: ro_receivable_concentration fired with an impact
        that prints as '0.0%' on both sides
```

Two anti-vacuity controls carry their own weight. `test_two_closed_years_of_an_
even_book_are_measured_and_stay_silent` reds if the completeness rule becomes so
strict the detector can never speak, and `test_a_material_concentration_still_
surfaces` reds if the materiality floor silences the family on every real book.
Both were confirmed by raising the floor until they went red.

**What this gate cannot see:** whether a detector is USEFUL. Fire rates come
from `scripts/measure_radar_detectors.py`, which reports
"N INSUFFICIENT to certify" on every family — four books cannot support a Wilson
interval, and printing one would be the statistical dishonesty the error budget
forbids. It also cannot see the serving lane: `run_detectors` has no production
caller yet, so nothing here is reachable by a user.

## forecast-route

`tests/engine/test_forecast_route.py` — `GET /api/forecast/{period_id}`, the
route that made the projection reachable, and the invariant it must keep on
the way out.

**Why this is a gate and not just part of `pytest`.** The failure it covers was
not a red test. `engine/forecast` (nine modules, integer minor units, exact
balance close), `engine/forecast_serving` (the fp1 contract and its boundary
guards), `frontend/lib/forecastFacts.ts` (the opaque `ProjectedMinor` type) and
`components/forecast/ProjectedAmount.tsx` were all complete and all green. No
router mounted them, no page rendered them, no menu row pointed anywhere. The
owner found it by looking for the feature in the product and not seeing it.

Joining the halves surfaced a second defect of the same family. The producer
emitted no `line_assumptions`, so the adapter attached no attribution, so
`figure_names_no_assumption` refused the WHOLE payload — on agras, carniprod,
retail AND realestate, at 3 years and at 5. The fp1 lane had only ever been
exercised against a hand-built five-line fixture with three drivers. A shape
nobody feeds back is a shape nobody has read; the same sentence appears in
`forecastFacts.ts`'s own header about a different instance of it.

**GREEN** — exit `0`: `21 passed`.

**PLANT / RED / REVERT**, four plants:

```
unmount the router in server.py  (the state the feature shipped in)
  -> E  AssertionError: the forecast route is not on the app; every projection
        is unreachable again
clamp the horizon instead of refusing it
  -> E  AssertionError: (401, '...'); assert 401 == 422
        (the refusal was the only thing standing there; with the clamp the
         request proceeds)
producer stops emitting `line_assumptions`
  -> E  ProjectionContractError: figure_names_no_assumption: figure
        'pl.amortisation'/'2026-01' names no assumption
a figure picks up the snapshot the projection stands on
  -> E  ProjectionContractError: figure_carries_actual_provenance: figure
        'pl.amortisation'/'2026-01' carries 'snapshot_id'
```

**What this gate cannot see:** what the page paints.
`frontend/pages/cfo/Forecast.tsx` is a different code path — it is rostered in
`design_review/PROVENANCE_CENSUS.json` under the `forecast` surface, whose
floor is zero and must stay zero: an affordance promising a jump to the source
cell for 2030 revenue would be an affordance over nothing.

### radar — the spine join (added 2026-09-08)

`tests/engine/test_radar_spine_join.py` folds into the `radar` gate above.

**What it covers.** Parts A and B of Radar landed in one commit and were NOT
connected. `series.py` — 1,356 lines carrying the two tiers, the typed
refusals, the cumulative-semantics guard and an identity measured exactly
zero on every account of every corpus book — was imported by nothing in
`src/`. The detectors read `detectors/book.py`, which parses `doc.atoms`
directly. The commit message said "the cross-period spine and twelve
detectors" as though the second read the first; it did not.

Joining them surfaced four defects, two of them in Part A:

| defect | what it cost |
|---|---|
| `PeriodBook` had no served-tier constructor | the serving lane holds `statement_line_items`, never a parsed ledger doc, so it could not build a `BookSeries` at all — which is why the detectors shipped with no production caller |
| the spine modelled only the *sume totale* column, never the rulaj | seven of twelve families read the PERIOD movement; none of them could be served through the spine on either tier |
| `rows_from_ledger_doc` emitted `r_d`/`r_c`, the builder read `st_d`/`st_c` | the one path from the engine's own IR into the spine produced an empty movement slot on EVERY account of EVERY book — and nothing called that adapter, so no test walked it |
| the distribution families read every row | the spine adds synthetic roll-ups (413 rows against 331 on agras); a synthetic restates its analytics' money, so the same amount entered a Benford population twice and its leading digit was not independent of its children's. It flipped realestate from clear to FIRED. Live on the direct path too — Romanian trial balances routinely list a synthetic beside its own analytics — the spine only made it visible. |

**GREEN** — the `radar` gate is now `127 passed` (floor 125).

**PLANT / RED / REVERT**, six plants:

```
served refusal becomes a zero (D4, from the other side)
  -> E  AssertionError: 101 reports a movement of 0.0 on a tier that serves none
distribution families read every row again
  -> E  AssertionError: 69 account(s) entered the population alongside their own
        analytics, e.g. ['162', '167', '213', '267', '280']
the join reads the cumulative pair instead of the rulaj
  -> E  AssertionError: 1012.01; assert 1.0 == 0.0 ± 1.0e-12
a spine gap becomes a row
  -> AttributeError: 'AccountGap' object has no attribute 'opening'
     (a crash, not the gate's own sentence — weaker than the others, recorded
      as such rather than dressed up)
mixed tiers are allowed through
  -> E  Failed: DID NOT RAISE SpineJoinError
the IR adapter stops emitting the sume-totale pair
  -> E  KeyError: 'st_d'
```

That last plant went GREEN on its first form. No corpus book's IR carries a
`total_*` pair, so removing the mapping changes nothing a real book can see —
which is exactly how the original defect survived. The test now asserts the
adapter against a STUB atom and separately measures that the corpus lacks the
column, so the gate does not depend on data that cannot exercise it.

**PARITY is the anti-vacuity control:** the spine path and the direct
`from_ledger_doc` path must reach the same verdict on all four books. They now
do, exactly. A divergence means a family has stopped reading leaves or the
join has lost a level.

**What this still cannot see:** whether the SERVE lane calls any of it. It
does not — `run_detectors` has no production caller, and the gate says so
rather than implying coverage it does not have.

### forecast-route — the membership gate (added 2026-09-08)

The FC1 table census (`test_firm_tenancy.py::test_every_module_reading_a_firm
_table_is_a_declared_firm_module_under_a_swept_prefix`) went red on the new
module the hour it landed: `_forecast_routes` names `financial_periods` and
`statement_line_items` and had not been declared or classified. Reading it
properly found a live bug the route shipped with.

`_org.resolve_org` returns `(user_id, org_id)` — BOTH. It was bound as one
name, so `org_id` was the tuple, `"eq.%s" % org_id` rendered
`eq.('uid', 'orgid')`, PostgREST was handed a filter matching nothing, and the
route would have answered **404 to every caller** while reading as "no such
period". Nothing in the route's own gate could see it: every test either fed
the engine directly or stopped at the 401/422.

Two plants, both red through their own message:

```
resolve_org bound as one name (the shipped bug)
  -> E  AssertionError: the period read was scoped to ('user-1', 'org-7'); a
        tuple here means every filter matches nothing and the route 404s for
        everyone
the period read drops its org_id filter
  -> E  AssertionError: {'id': 'eq.p-1'}; assert None == 'eq.org-7'
```

The module is now declared in `DECLARED_CLIENT_DATA_READERS` as a PRODUCT
route under its own membership gate — `resolve_org` (403 on a non-member org,
never a silent fallback), the caller's own RLS-scoped client, and the org_id
filter as a second lock on top of that. The declaration carries that
classification inline; the gate above is what makes it true rather than
claimed.

### radar — the detector lane in the serving path (added 2026-09-08)

`tests/engine/test_radar_detector_lane.py` folds into the `radar` gate.

The pack-declared families now run as a THIRD lane beside the single-period
and multi-period engines, ranked and capped by the same machinery. Two
properties, and both were wrong first:

**The flag has to be key material.** It lives on the REQUEST, not in the
environment — `compose` is pure over its request and an env read inside it
would end that — and it participates in `cache_key`, or turning the lane on
would serve the pre-flag payload out of cache for the life of the process.
The feature would look dead on exactly the deploy that enabled it.

**The lane ran and produced nothing.** Three families fired on the agras
served book and all three were refused with "the finding cites no money
figure other than a company total": the serving lane ranks on an AMOUNT AT
STAKE and the detectors published only shares. Three fires, zero candidates,
and in every payload field except `lanes.detectors.candidates` it looks
identical to "nothing found". The three families now publish the money the
finding is really about — `interco_balance`, `top_counterparty_balance`,
`net_book_value` — declared in `_ratio_units._MONEY_FACTS`, because money
"must be declared" is that module's own rule.

Measured on agras with the lane on: 4 surfaced → 7 surfaced, interleaved by
rank rather than appended (`ro_receivable_concentration` at rank 2 between two
single-lane rows), each with a real amount at stake — and the related-party
row's stake is RON 7,692,202.74, the same `ar_intercompany` figure the export
renderer was reading as 0 before that key was fixed.

**PLANT / RED / REVERT**, four plants:

```
flag dropped from the cache key
  -> E  AssertionError: the same key for both states
the lane runs even with the flag off
  -> E  the committed capture and today's payload differ
families stop publishing the money at stake
  -> E  AssertionError: the lane ran 5 famil(ies) and produced 0 ranked
        candidate(s)
the refusal loses its sentence
  -> E  assert 'no jurisdiction pack was named' in ''
```

The six radar golden captures gained exactly one key each
(`lanes.detectors: {"enabled": false}`), 18 lines across six files, verified
before writing to be the ONLY difference.

**What this gate cannot see:** any ROUTE calling it. Nothing does — the flag
is off everywhere and there is no `/radar` surface. The gate says so rather
than implying coverage it does not have.

## vitest

`scripts/check_vitest.mjs` — the frontend unit suite, 2,784 tests across 751
suites in 165 files.

**Why this is a gate.** It was not one. `tsc` and `npm-build` were in the
battery; nothing ran the unit suite. That is the `check_tsc` shape exactly —
a gate everybody assumed existed, over a body of tests nobody was watching.

**It was RED the hour it was wired, for two reasons, and the second is the
interesting one:**

1. `ENGINE_MONEY_FACTS` in `frontend/lib/capsuleFactIndex.ts` had drifted from
   `engine.api._ratio_units._MONEY_FACTS` — three names added engine-side an
   hour earlier (`interco_balance`, `top_counterparty_balance`,
   `net_book_value`) and never mirrored.
2. **The mirror test that exists to catch exactly that had been passing on a
   false match.** It regexed the RAW Python source, so it lifted quoted
   phrases out of comments and counted them as fact names. `"currency"` was in
   the frontend mirror and is not a money fact at all — the engine's only
   occurrence of the string is inside
   `` # `fmt: "currency"` in _benchmark_engine.METRIC_DISPLAY and were ``. The
   frontend had been treating a currency CODE as a money figure, and the guard
   agreed because of a comment.

   Repaired by stripping `#` comments (quote-aware, so a `#` inside a string
   literal survives) before the registry is read, in all three mirrors. The
   phantom `currency` entry is removed.

**GREEN** — exit `0`: `2783 passed, 0 failed, 1 skipped` across 165 files;
every canary area ran.

**PLANT / RED / REVERT**, three plants:

```
a real test fails (the mirror drifts again)
  -> FAIL capsuleFactIndex.test.ts :: ENGINE_MONEY_FACTS matches
     engine.api._ratio_units._MONEY_FACTS
the config stops matching files (vitest.config.ts include -> *.nomatch.*)
  -> · only 0 test(s) ran against a floor of 2500 — the config has stopped
       matching files, which exits zero and proves nothing
     · canary file(s) never ran: <all five>
a canary area collapses but the total stays high
  -> · canary file(s) never ran: frontend/lib/__tests__/aFileThatDoesNotExist.test.ts
```

The second plant is the point: **vitest exits ZERO with an include pattern
that matches nothing.** Without the floor this gate would have printed PASS
over an empty run — the same false green `check_tsc` was written to close.

**One more thing it got wrong on its first battery run,** worth recording
because it is the same family: the gate printed `canaries=5/5` and
`run_battery.py` greps a gate's own OUTPUT for each canary STRING it
declares. A count satisfied this gate and failed the battery's, with
`DISCOVERY BROKEN — canary absent from the gate's own output`. A count is a
claim; the name is the evidence. It now prints one line per canary.

**What this gate cannot see:** Playwright. `e2e/` is a separate runner and is
still NOT in the battery. That gap is real and this file does not close it.

### radar — the surface, wired (added 2026-09-08)

`tests/engine/test_radar_wiring.py` (13) folds into the `radar` gate;
`frontend/pages/cfo/__tests__/radarSurface.test.tsx` (9) runs under the new
`vitest` gate.

`src/engine/api/_radar.py` had four routes, a dismissal lane and an
explanation lane, and `build_router()` was referenced NOWHERE in `server.py`
— the THIRD "complete and unreachable" subsystem found in one session (the
forecast and Radar's own Part A were the first two). Wiring it exposed three
defects, all of which had been returning `None` quietly.

**CAEN was always absent.** `light_input` read `row.get("caen_code")` off a
`financial_periods` row, and the light projection deliberately does not
select it — because there is no such column;
`schema_phase7_benchmarks.sql` put CAEN on `organizations`. Every served
radar payload therefore ran `s_engine.run_single_period(..., caen=None)` and
no finding was qualified by an industry profile. The module's own comment
records half the story: the PROJECTION was fixed after it 400'd in
production, and the READ was left behind. That is the shape a dead read
always takes — the loud half gets repaired and the quiet half keeps
returning None.

**No company identity.** `PeriodInput.cui` was never set, and the detector
spine refuses without one. There is no CUI to set — `financial_periods`
carries none — so the identity is the WORKSPACE, which in this product IS
the company (root CLAUDE.md §16). `EntityKey.of_workspace` states that
explicitly and prefixes it `workspace:`, which `normalize_cui` can never
produce, so a period carrying a real CUI mismatches and refuses rather than
being stitched in beside one that does not.

**The line items were fetched and thrown away.** `load_statements` selected
them, rebuilt the statements and dropped the rows.

**PLANT / RED / REVERT** — engine, six plants, all red:

```
the surface mounts unconditionally      -> ['/api/radar/…'] == [] failed
CAEN read off the period row again      -> the row's phantom caen_code won
                                           over the org's real one: '9999' == '1013'
a half-configured pack guesses          -> ('ro','/app/packs') == (None,None) failed
the line items are dropped again        -> the rows did not reach the period input
the workspace identity becomes a bare id-> 'workspace:' prefix absent
an empty CAEN string reaches the engine -> assert '' is None
```

**PLANT / RED / REVERT** — frontend, four plants:

```
a 404 renders as an empty findings list -> no [data-testid=radar-surface-absent]
the cap's held-back count disappears    -> no [data-testid=radar-strip-held]
the strip queries while the feature is hidden
  -> a hidden feature must not even ask the engine: spy called 1 time
a failed payload is read as zero findings
  -> "0 findings" over an unmounted scan is the defect; nothing is correct:
     expected 'RadarScanned — nothing surfaced.Open …' to be ''
```

The last two are worth recording twice. Their FIRST form went GREEN, because
the strip carries redundant guards (`enabled: active && …` as well as the
early return; `query.isError` as well as `readCounts` returning null on a
non-payload) and removing one guard changed no outcome. The plants above are
the real regression shape — removing BOTH — and they red. The tests pin the
OUTCOME, not one guard, which is why the redundancy is safe rather than
untested.

**The FE fixture is real engine bytes.** `radarSurface.test.tsx` reads
`tests/engine/fixtures/radar/saga_10_col_agras.json` — the committed capture
the Python R4 determinism gate compares against. A hand-written row was tried
first and was a lookalike: `parseFinding` returns null without a
`contract_elements` block, `hasContractRows` goes false, and
`<FindingsPanel>` renders nothing — so the synthetic fixture quietly tested
an empty panel and passed.

**Two flags, deliberately separate.** `ANOMALY_RADAR_ENABLED` mounts the
routes; `RADAR_DETECTORS_ENABLED` (+ `RADAR_DETECTOR_JURISDICTION`) runs the
pack families inside them. The surface can be turned on without the
detectors, which is how it will be turned on.

**Flagged, not fixed:** `GET /api/radar/{period_id}/dismissals` is the only
one of the four routes not wrapped in `_guard`, so a `RadarLoadError` raised
there would escape as a 500 rather than its carried status. Nothing on that
path raises one today (`load_dismissals` fails open), so this is latent.

### radar / forecast — what turning the flags on found (2026-09-08)

Both flags were flipped on the agras corpus book and the real pages rendered
headless over the real engine bytes. Two defects surfaced that no gate had:

**The detector lane refused every real period.** `_detector_spine` built its
entity with `EntityKey.of`, which NORMALIZES — and `normalize_cui` strips
`workspace:<id>` to nothing. That is exactly what the serving path carries,
because `financial_periods` has no CUI column. Measured on the first flip:
`"cannot normalize a CUI from 'workspace:qa-org'"`, **0 families run on a
book where 5 do**. Every other test in the lane's own suite passes a
CUI-shaped identity, so none could see it. Now pinned by
`test_a_workspace_identity_reaches_the_spine`, plant-proven: routing the
workspace identity back through `of` reds with the engine's own sentence.

**Every projected figure read `RON 100,709projected`.** The mark painted the
word inline with no separator, 912 times on one page, sixteen per row — on a
page whose every column header is a future period and which carries a
standing banner saying every figure is a projection. A mark nobody can read
past is not a warning. It is now a glyph (`◇`), with the WORD kept in
`aria-label` and `title` and the machine-readable carrier unchanged
(`data-projected="true"`). The two component gates were updated to assert the
guarantee that matters — the mark exists and the word is reachable — rather
than that the word is painted inline.

**Also measured, and NOT a defect:** a first capture showed blank rows across
the balance sheet. The DOM had every value (`RON 22,794◇`, `RON 85,134◇`); a
viewport screenshot taken straight after `scrollIntoViewIfNeeded()` on a
2400px viewport caught the page mid-repaint. Recorded because a screenshot
that looks like a defect and is not costs the same time as one that is.

**What the flags produced, on agras.** Forecast at 5 years: 16 periods (12
monthly + 4 annual), 912 figures, 25 drivers, `unbalanced_periods: []` — and
the rendered balance sheet closes month by month (total assets RON 404,305 =
total equity and liabilities RON 404,305 in 2026-01). Radar with the detector
lane on: 7 surfaced under a cap of 7, lanes `detectors · 3` and
`this period · 4`, interleaved by rank.

**Noted, not fixed:** the three detector rows render no "View evidence"
button while the four engine rows do. `EvidenceLine` needs a verified fact,
and the detector families' fact names are not in `serve.FACT_ACCESSORS`, so
nothing walks back to a gateway accessor. That is the honest behaviour — the
affordance appears only where the evidence can actually be walked — but it is
a real asymmetry between the two lanes and is written down rather than left
to be rediscovered.

### radar — three ship-blockers found by READING the output (2026-09-09)

All three were green, plausible and wrong. None was found by a failing test;
all three were found by printing the seven findings a real book produces and
reading them.

**1. The same exposure, twice.** Agras surfaced RON 7,692,202.74 of
related-party balances at rank 3 (detector lane) and rank 4 (engine lane) —
adjacent, under two names, two of a reader's seven slots. The ranker groups on
`root_cause`, and the lanes spell the same accounts differently: the engine
names the SYNTHETICS it scans (`461+451+452+455`), the detector the ANALYTICS
that carry the balance (`4511.01+461.016+461.07`).

`root_cause_of` now normalizes to synthetics — which also means a dismissal
scoped to `461` covers a detector finding on `461.016`, as a reader expects.
Normalizing alone is not enough (the engine names four synthetics, the
detector two), so `dedupe_across_lanes` runs before the cap: two findings are
one when their synthetic sets OVERLAP **and** they cite an identical subject
figure to the cent.

**The false merge that cost, measured.** The first form compared every cited
money figure and absorbed `fx_exposure` into `liquidity_cash_tight`: both cite
total cash of RON 1,168,047.04 — one as the balance whose cover is thin, the
other as the denominator an FX share is taken of. Neither is ABOUT total cash.
`CONTEXT_FACTS` excludes company totals, reusing the judgement
`amount_at_stake` already makes rather than inventing a second one.

**2. A template token in the prose.** `ro_asset_age` rendered "the remaining
net book value carries **not computed** charge periods of life". The
detector's own sentence branches correctly when there is no charge; the pack's
`why` interpolates `{life}` unconditionally, and the absent form of that token
was those two words. A template cannot branch — a clause can be empty, so the
token is now `{life_clause}`.

The gate for this is STRUCTURAL, not lexical, and an earlier lexical draft is
why. Banning "undefined", "none" and "not computed" red on real books, on
correct prose: *"multiples are undefined at non-positive EBITDA"* is a
sentence the engine means. The lexical half now catches only what nobody types
on purpose (`{`, `%s`, `[object`, a Python `None` repr); the structural half
asserts no detector hands a template an absent-form as a token VALUE.

**3. Every aggregate doubled.** All five of `Group`'s accessors summed
`self.rows`, which on a spine-built book carries a synthetic AND its
analytics. `assetage` published RON 22,011,353.08 of net book value where the
served balance sheet carries RON 11,005,676.54. The 70.5% share it fired on
was correct throughout — a ratio of two doubled numbers is the same ratio — so
the gate asserts ABSOLUTE values against the served statement, never a share.

Measured after the repair, on all four books: every money figure a detector
publishes that has a served counterpart is EXACT to the cent
(`interco_balance` == `ar_intercompany`; `net_book_value` == the four PP&E
gross rows plus accumulated depreciation).

**PLANT / RED / REVERT**, six plants, each red through its own message:

```
the cross-lane dedupe is removed
  -> …|concentration_related_party|451+452+455+461 and
     …|ro_related_party_exposure|451+461 both state 7,692,202.74 on 451+461
context facts count as a subject figure again
  -> the FX finding was absorbed by the liquidity one; they share a
     denominator, not a subject
the merge key stops normalising to synthetics
  -> …|liquidity_cash_tight|5121+5124+531 keys on '5121', deeper than a synthetic
the absent branch hands the template a phrase again
  -> the absent branch handed the template a bare {life} again
Group aggregates sum rows again
  -> the parent restates its children; summing all three gives 600
assetage sums rows again
  -> agras publishes both figures; gate went quiet
```

Two of those went GREEN on their first form, both for reasons worth keeping:
reverting `root_cause_of` left the DEDUPE green (it calls `synthetics_of`
directly — defence in depth), so the key itself is now asserted on every
served row; and the `{life}` plant could not fire because after the leaves
repair every corpus book states a depreciation charge, so the absent branch is
driven deliberately on a book built without one.

### C9 — one metric name, one formula, across every surface

The dashboard P&L and the Forecast stated two EBITDAs for one period:
42,797,225.01 against 54,443,833.33 on Scandia, every EBITDA ratio 27% apart.

The engine has ONE definition — `assembled_pl.ebitda` equals
`revenue − cogs − opex + other_operating_income` to the cent on every corpus
book, and the forecast reads that key. The frontend derived its own from
`total_operating_revenue`, which excludes account 758. **On the retail book
the two differ in SIGN**: the engine serves +220,162.84, the derivation gives
−506,705.80.

`buildPlStatement.ts` carried a comment asserting *"EBITDA downstream uses
this exact figure"* — untrue, and it justified the derivation. It is deleted,
and a test asserts it stays deleted: leaving it would tell the next reader the
defect is the rule.

The builder now renders the served figure; the fallback (for a payload with no
`ebitda` key) uses the engine's own formula so the two cannot drift even then.
What EBITDA includes is stated beside it rather than left to be inferred.
Whether 758 belongs is deliberately unanswered — the earnings-quality detector
already surfaces non-trading income inside EBITDA, which is where that
analysis belongs. Three plants red.

### A test double's schema must match the real table's

Generalised from the `financial_periods` case: a double that invents a column
answers 200 where PostgREST answers `400 42703`, and every test written
against it pins the fabrication as the contract. That is how a 500 on the
whole Firm Attention board sat green. `test_caen_one_authority.py` now parses
the real SQL and checks EVERY table in every hand-written column map. Planted
an invented column on `organizations` → RED naming it.

## playwright

The last suite outside the battery until 2026-09-09, and it had already
taken the battery down once by starving vitest of CPU.

**Baseline is a RATCHET, not a certificate.** `design_review/
PLAYWRIGHT_BASELINE.txt` records 339 ran / 29 skipped / 171 known
failures, measured serially on a quiet machine with the dev server up AND
the engine restarted from HEAD. More than half the suite is red; the
baseline may only SHRINK, so the gate reds on a NEW failure and accepts a
repaired one. Floor `PW_FLOOR_RAN=305` and a 0.75 skip ceiling exist
because `playwright.config.ts`'s `webServer` block is commented out
("locally we assume it's up") — a run with nothing on :5173 would
otherwise baseline an empty suite as green.

**PLANT** — the gate refuses any spec naming an absolute non-local origin.
Restore the hardcoded production URL that
`e2e/learning-landing-onboarding.spec.ts` used to carry:

```
-    const indexHtml = await request.get("/").then((r) => r.text());
+    const indexHtml = await request.get("https://cfo-ai.io/").then((r) => r.text());
```

**RED** (verbatim, `node scripts/check_playwright.mjs`):

```
PLAYWRIGHT GATE
==============================================================
REFUSED — these specs name an absolute non-local origin in code, so they
reach it regardless of E2E_BASE_URL:
  e2e/learning-landing-onboarding.spec.ts: https://cfo-ai.io
Make the request relative so it resolves against the project's baseURL
(--project=prod when you deliberately mean the live site).
```

**REVERT** — request made relative again; the gate proceeds to the run and
compares against the baseline.

**What it also reds on, with the defect repaired (TC-11):** a new failing
test absent from the baseline; a ran-count below the floor (the dev server
was down and the suite measured nothing); a skip rate above 0.75.

**A false baseline is the trap this gate can still fall into, and it did
once.** The first baseline (174 failures) was measured against an engine
process started six days earlier that predated a feature-registry change —
36 features where HEAD answers 47. Restarting :8000 from HEAD moved 31
tests to passing and 28 to failing: a two-way swing of 59 on a net of 3.
Identify the build before trusting a baseline; the scope of a measurement
is part of its verdict (TC-13).

## tenant-boundary

The anatomy behind two P0s found an hour apart on 2026-09-09: **a
browser-written column consumed by raw value inside a service-role
operation, behind a wall that checks a different object.** Under the
service role RLS does not apply, so THE FILTER IS THE ACCESS CONTROL.

Three suites, 41 tests, floor 35: the storage seam
(`test_storage_tenant_paths.py`), the period seam
(`test_period_id_tenant_boundary.py`), a static census over every
service-role call (`test_service_role_tenant_filter.py`), and cross-org
reads against the real app (`test_cross_org_reads.py`).

**PLANT A — the storage seam.** Remove the guard from `signed_url`:

```
-        assert_tenant_path(bucket, path, org_id, op="sign")
```

**RED:**

```
E   AssertionError: signed_url no longer calls assert_tenant_path — the
    required keyword is then decoration, not enforcement
FAILED test_storage_tenant_paths.py::test_each_storage_method_actually_calls_the_assertion[signed_url]
```

**PLANT B — the period seam.** Disable the tenant comparison in
`_period_move._period_row` (`if not caller or owner != caller:` ->
`if False:`).

**RED** — 5 of 10, including the one that matters:

```
E   AssertionError: refused, but derived tables were already deleted: [...]
```

**PLANT C — the census.** Add a new unfiltered service-role select:

```
+    with _supabase.admin() as ac:
+        return ac.select("financial_periods", filters={"id": "eq.%s" % period_id})
```

**RED:**

```
E   AssertionError: service-role calls on tenant-scoped tables with NO
    org_id in their filter, and no declaration:
E       _period_move.py:[634] select financial_periods
```

**PLANT D — cross-org reads.** Disabling RLS in the FirmWorld double reds
with the leak rendered as its own symptom:

```
E   CROSS-ORG READ — SOLO holds a membership in ...cc and none in ORG_A1,
    but these routes answered with something other than a refusal:
E     GET /api/period/...12d [own-org-header] -> 200 {"canonical_version":"v2.1",...
```

**REVERT** — all four restored; 41 green.

**One plant that proved nothing, recorded because it is the more useful
lesson.** Removing the membership check from `_org.require_org_member`
left all five cross-org read tests GREEN — those routes are guarded by RLS
in the per-user client, not by that call. A plant that does not red is not
evidence the gate is weak; it is evidence the plant was aimed at the wrong
thing. It was replaced with Plant D, which reds.

<!-- ═══ plan/2 B0 (plan_contract_v2 28.3): forecast gate wiring ═══════════
     Six gates registered by batch B0 of plan/2 (one engine for the forecast
     cockpit and Scenarios). Each is registration_only in
     docs/engine_book/plan_gates.json: an existing, already-passing test (or
     the new census) registered with no repair in the same commit, so each
     section records the plant red and, in place of the parent-commit red,
     the line the contract requires (0.5). Later batches append their own
     sections below their own anchors. -->

## forecast-model

`tests/engine/test_forecast_model.py` — the linked three-statement model in
`engine.forecast`: every projected period closes assets to equity plus
liabilities to the cent, the cash-flow statement articulates the balance
sheet, and the calendar comes from the book, never a clock. It rode the
whole-suite `pytest` gate, where a collapse of this one file hides inside
1,500 tests; plan/2 extends it in B2 (`test_forecast_timeline_tax.py`) and B5
(`test_forecast_wc_unwind.py`), so it is a named gate first.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_forecast_model.py -q` |
| work count | junit-xml, floor **220** tests (measured 223 at registration, rounded down) |
| canary | `test_f1_every_projected_period_closes_to_zero`, `test_f1_one_cent_is_enough_to_red_it`, `test_f1_the_cash_flow_statement_articulates_the_balance_sheet`, `test_f3_no_clock_is_read_and_the_calendar_comes_from_the_book` |

**SCOPE** — the four committed books (`tests/engine/fixtures/firm/saga_10_col_{agras,carniprod,realestate,retail}.json`), FY2025 anchors, year one monthly/quarterly/annual, horizons 1-5 as each test states; no SYNTHETIC pair (it lands in B7).

**GREEN** — exit `0`: `223 passed in 3.06s`.

**PLANT** — `src/engine/forecast/project.py`, one cent of closing PP&E in plan
year 2 (contract F1's plant):

```
-            "ppe_net": closing_ppe,
+            "ppe_net": closing_ppe + (1 if period.year_offset == 2 else 0),
```

**RED (plant)** — through `scripts/run_battery.py`'s own runner, exit `1`,
`165 failed, 58 passed`; the canary names the period and the cent:

```
FAIL forecast-model (exit 1, 7.4s)
E   engine.forecast.errors.BalanceViolation: projected period FY2027 does not balance: assets 65,489,692.38 − (equity + liabilities) 65,489,692.37 = 0.01 (must be exactly 0)
```

**RED (parent commit)** — no repair in this commit; registration of an existing test.

**REVERT** — file restored byte for byte (`git diff` empty); `PASS forecast-model (2.7s, 223 tests)`.

**After the repair it reds on (TC-11):** any projected period of any book
that does not close to the cent; a cash-flow statement that does not
articulate the balance sheet; a clock read anywhere in `engine.forecast`.
**It cannot see:** the served bytes (forecast-serving-boundary, forecast-route)
or any lever run (forecast-balance, B5).

## forecast-serving-boundary

`tests/engine/test_forecast_serving_boundary.py` — the fp1 serving contract
and its guard: a projected figure is not the type an actual is served as,
carries no actual provenance (no snapshot id, line id or source cell on a
figure), resolves to its drivers for its own period, and reads back through
its own gateway byte for byte. Supporting gate of contract 26.3; B6 adds
`test_no_actual_provenance_on_real_post_bytes` (3.13).

| | |
|---|---|
| command | `python -m pytest tests/engine/test_forecast_serving_boundary.py -q` |
| work count | junit-xml, floor **60** tests (measured 66, rounded down) |
| canary | `test_the_guard_is_silent_on_all_four_committed_books`, `test_every_real_book_serves_a_whole_projection_at_every_horizon`, `test_the_projected_balance_sheet_closes_to_the_cent_on_the_real_book` |

**SCOPE** — the four committed books at horizons 3 and 5, the committed fp1 fixtures `tests/engine/fixtures/forecast/fp1_agras*.json`, and hand-built contract fixtures inside the file.

**GREEN** — exit `0`: `66 passed in 1.44s`.

**PLANT** — `src/engine/forecast_serving/boundary.py`,
`actual_provenance_on_projection` treats every node as the base-period
pointer, so no source cell is ever found on a figure:

```
-    _walk(projection, "$", False)
+    _walk(projection, "$", True)
```

**RED (plant)** — exit `1`, `2 failed, 64 passed`:

```
FAIL forecast-serving-boundary (exit 1, 1.6s)
E   AssertionError: []
E   assert [] == ['$.periods[0].line_id']
FAILED tests/engine/test_forecast_serving_boundary.py::test_plant_a_source_cell_onto_a_projected_figure_and_the_guard_reds
FAILED tests/engine/test_forecast_serving_boundary.py::test_a_source_cell_on_a_producer_FIGURE_is_still_caught
```

**RED (parent commit)** — no repair in this commit; registration of an existing test.

**REVERT** — restored; `PASS forecast-serving-boundary (1.5s, 66 tests)`.

**After the repair it reds on:** a projected figure carrying a source cell; a
figure without the projected marker; a figure whose drivers do not resolve for
its period; a wire form that does not read back through its gateway.
**It cannot see:** what a page paints (forecast-boundary, vitest).

## forecast-drivers

`tests/engine/test_forecast_drivers.py` — `engine.forecast_drivers`: every
driver carries a derivation and a basis generated from it, an absent driver
is `None` and never `0`, a fallback never crosses into the model looking like
a measurement, and the package holds no model call. Supporting gate of
contract 26.3; B3 retires its `test_hx8` (listed in 28.3 B3).

| | |
|---|---|
| command | `python -m pytest tests/engine/test_forecast_drivers.py -q` |
| work count | junit-xml, floor **140** tests (measured 149 run + 1 skipped, rounded down) |
| canary | `test_b2_absent_is_none_and_never_zero`, `test_f1_the_package_contains_no_model_call_and_no_place_for_one`, `test_j8_an_absent_driver_never_becomes_a_number_in_the_handover` |

**SCOPE** — the four committed books, the forecast_drivers pack, and one-, two- and three-period histories built inside the file.

**GREEN** — exit `0`: `149 passed, 1 skipped in 1.55s`.

**PLANT** — `src/engine/forecast_drivers/derive.py`, `_absent` hands over a zero
fallback instead of an absent driver (absent read as zero):

```
-        value=None, status="absent",
+        value=0.0, status="fallback",
```

**RED (plant)** — exit `1`, `17 failed, 132 passed, 1 skipped`:

```
FAIL forecast-drivers (exit 1, 1.8s)
FAILED tests/engine/test_forecast_drivers.py::test_b2b_headcount_is_absent_on_the_real_book_not_zero
E   AssertionError: assert 'fallback' == 'absent'
FAILED tests/engine/test_forecast_drivers.py::test_hx7_the_pedigree_reaches_the_wire[agras]
```

**RED (parent commit)** — no repair in this commit; registration of an existing test.

**REVERT** — restored; `PASS forecast-drivers (1.6s, 149 tests)`.

**After the repair it reds on:** a driver without a derivation or basis; an
absent concept carrying a number; a fallback crossing into the model as a
measurement; a model call in the package.
**It cannot see:** the tier ladders of plan/2 section 3.4 (forecast-defaults, B3).

## forecast-ai-write-path

`tests/engine/test_forecast_no_ai_write_path.py` — contract F5, engine half:
importing or exercising `engine.forecast`, `engine.forecast_drivers` and
`engine.forecast_serving` loads no model surface, a model-authored numeral
about a projection is refused, and the environment cannot disarm that
channel. B18 and B19 raise its floor.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_forecast_no_ai_write_path.py -q` |
| work count | junit-xml, floor **15** tests (measured 17, rounded down) |
| canary | `test_the_scan_is_not_vacuous_and_names_what_it_covers`, `test_importing_the_forecast_packages_loads_no_model_surface`, `test_plant_a_forecast_module_that_imports_a_model_surface_and_it_reds` |

**SCOPE** — the packages `engine.forecast`, `engine.forecast_drivers`, `engine.forecast_serving` (import walk in a fresh interpreter), the model-surface roster in `forecast_serving/boundary.py`, and agras for the end-to-end gateway run.

**GREEN** — exit `0`: `17 passed in 0.73s`.

**PLANT** — `src/engine/forecast/render.py` imports a model surface:

```
 from typing import Any, List
+import engine.ai_lane  # noqa: F401
```

**RED (plant)** — exit `1`, `1 failed, 16 passed`:

```
FAIL forecast-ai-write-path (exit 1, 1.1s)
E   AssertionError: importing forecast, forecast_drivers, forecast_serving loaded a model surface: engine.ai_lane, engine.ai_lane._client, engine.ai_lane.classify, ... AI never produces a projected number — not a driver, not a result, not a rounding.
FAILED tests/engine/test_forecast_no_ai_write_path.py::test_importing_the_forecast_packages_loads_no_model_surface
```

**RED (parent commit)** — no repair in this commit; registration of an existing test.

**REVERT** — restored; `PASS forecast-ai-write-path (1.1s, 17 tests)`.

**After the repair it reds on:** a module of the model-surface roster
(`MODEL_SURFACE_MODULES` in `forecast_serving/boundary.py`) that is LOADED when
a fresh interpreter imports `engine.forecast`, `engine.forecast_drivers` and
`engine.forecast_serving`, or when the gateway runs end to end on agras; a
model-authored numeral about a projection reaching a served block; an
environment variable that disarms the guard. It measures modules loaded, not
import statements.
**It cannot see:** an import placed inside a function (never executed by the
import walk); a submodule the packages do not themselves import (a new
`engine/forecast/breakeven.py` is invisible until something imports it);
`import engine.ai` or `from engine.ai import advisory` when that loads only
`engine.ai` and `engine.ai.registry`, which the roster leaves out on purpose.
So contract 26.2 F5's own plant ("import engine.ai in
engine.forecast.breakeven") does NOT red at B0. Measured on this tree, each
applied to `src/engine/forecast/` and reverted (`git status` clean after):

```
top-level `import engine.ai` in render.py                        -> 17 passed
new breakeven.py with top-level `from engine.ai import advisory`  -> 17 passed
function-local `from engine.ai import advisory` in render.py      -> 17 passed
control: top-level `import engine.ai_lane` in render.py           -> 1 failed, 16 passed
```

`import engine.ai` loads `['engine.ai', 'engine.ai.registry']` only. A
function-local `import anthropic` in `forecast_drivers/derive.py` is caught,
but by forecast-drivers, not by this gate. The extension that closes this
(an AST scan of every import statement, function-local included, in every
module under `src/engine/forecast*`, forbidding the prefixes `engine.ai` and
`engine.ai_lane` apart from the guard's own sanctioned imports) belongs to the
batch that owns `tests/engine/test_forecast_no_ai_write_path.py` (B18). B11
creates `breakeven.py` before B18 runs, so the contract's plant shape stays
open from B11 to B18 unless the owner rules that B11 extends the test
(as-built B0-14).
It also cannot see the proposal route of section 24 (B19) or
`engine.forecast_findings` (B18), which do not exist yet.

## forecast-boundary

`node scripts/check_forecast_boundary.mjs` — contract F2, static half: a
projected figure cannot be painted as a fact (no laundering cast, no raw wire
read, no actuals primitive over a projection; the two serving namespaces never
import each other). It existed with its own vacuity probe and was never in the
battery. B0 adds the `units=` count the battery reads, an explicit red on a
zero-file scan, and prints by name the Scenarios files it does not yet hold;
its scope is unchanged. B6 extends it to `components/forecast/**`, B13 to the
Scenarios page, B20 to the exports.

| | |
|---|---|
| command | `node scripts/check_forecast_boundary.mjs` |
| work count | `GATE-WORK forecast-boundary units=(\d+)`, floor **1000** ts+py files (measured 1,167 = 761 ts + 406 py, rounded down) |
| canary | `FORECAST BOUNDARY GATE (F2, static half)`, `forecast-namespace consumers found` |

**SCOPE** — every .ts/.tsx/.py under `frontend/` and `src/engine/`; the consumer rules hold the 4 files importing `frontend/lib/forecastFacts` and the two serving namespaces. Excluded until B13, printed by name on every run: 16 Scenarios files (`pages/cfo/Scenarios.tsx`, `stores/scenario.tsx`, `components/scenarios/**`, `lib/scenarios/**`), which compute their own cascade and do not import the forecast namespace.

**GREEN** — exit `0`: `PASS — 4 forecast-namespace consumer(s); no laundering cast, ...`.

**PLANT 1** — `frontend/components/forecast/ProjectedAmount.tsx` gains a laundering cast:

```
 import { type ReactNode } from "react";
+export const launder = (x: unknown) => x as unknown as number;
```

**RED (plant)** — exit `1`:

```
FAIL forecast-boundary (exit 1, 0.1s)
FAIL — a projected figure can be painted as a fact:
  · frontend/components/forecast/ProjectedAmount.tsx casts a projected amount into a plain number. The single documented door is unwrapProjected(), which hands over the marker in the same call.
```

**PLANT 2** — a zero-file scan: the script copied alone into an empty
directory, so discovery finds nothing. **RED (plant)** — exit `1`, among ten
failures:

```
GATE-WORK forecast-boundary units=0 ts=0 py=0 consumers=0 label=files-scanned
  · ZERO FILES SCANNED — discovery found no .ts, .tsx or .py file under frontend/ or src/engine/. Nothing was checked, so nothing may pass.
  · only 0 TypeScript file(s) scanned; discovery is broken (the tree carries far more)
```

`--probe-vacuity` agrees: `PROBE OK — emptied discovery produced 4 failure(s)`.

**RED (parent commit)** — no repair in this commit; registration of an existing test.

**REVERT** — the cast removed (`git diff` empty); `PASS forecast-boundary (0.1s, 1167 ts+py files scanned)`.

**After the repair it reds on:** a laundering cast or raw wire read in a
forecast consumer; a projected value painted without `<ProjectedAmount>`; an
actuals primitive in a file reaching a projected value; the serving namespaces
importing each other or the producer; the two recognisers disagreeing; a
zero-file scan.
**It cannot see:** client arithmetic over projected values (F2's no-arithmetic
check lands in B6), and the Scenarios files it lists as excluded.

## plan-gate-census

`python scripts/check_plan_gates.py` — contract F10: every entry of
`docs/engine_book/plan_gates.json` maps to a battery gate with floor above
zero and canaries (and, for vitest and playwright entries, the same literal in
the runner's CANARIES array), and to a plant log here with PLANT, RED (plant),
the parent-commit red or the registration_only line, REVERT and a SCOPE line.
It prints the coverage of the eighteen F and S rows. Per batch it reds when the
batch's `required_gates` omits a battery gate contract 28.3 says that batch
first registers (`CONTRACT_LANDS` in the script), when its `required_rows`
omits a row whose 26.1 Lands column is that batch, and when a required gate or
row is met only by another batch's entry. Each batch adds its entries and both
keys; B21's keys must name every 26.1 battery gate and every row, and are the
only ones any batch's entry can meet. Only B0's six registrations may be
`registration_only` (0.5). Schema `plan_gates/2` (as-built B0-13).

| | |
|---|---|
| command | `python scripts/check_plan_gates.py` |
| work count | `GATE-WORK plan-gate-census units=(\d+)`, floor **6** entries (measured 6) |
| canary | `PLAN-GATE CENSUS (plan_contract_v2 F10)`, `coverage of the 18 contract rows` |

**SCOPE** — `docs/engine_book/plan_gates.json` (6 entries at B0; rows F1, F2, F5, F10 covered, 14 rows with no gate yet; batches enforced: B0, with required gates forecast-model, forecast-serving-boundary, forecast-drivers, forecast-ai-write-path, forecast-boundary, plan-gate-census and required rows F5, F10) against the full battery (engine and frontend gates) and this file. Plants run on copies passed with `--battery`, `--gates-md`, `--plan-gates`. Printed as `GATE-WORK plan-gate-census units=6 rows=4 batches=1`.

**GREEN** — exit `0`: `PASS — every listed plan gate is registered, planted and scoped.`

**PLANT 1** — contract F10's first plant: a copy of this file with the
`**PLANT**` block of `## forecast-drivers` deleted, passed with `--gates-md`.
**RED (plant)** — exit `1`:

```
FAIL — 1 plan gate claim(s) not backed by the battery and its plant log:
  · plan_gates.json entry 'forecast-drivers': plant log 'forecast-drivers' lacks PLANT
```

**PLANT 2** — F10's second plant: a copy of `scripts/run_battery.py` with
`floor=15` set to `floor=0` (the substitution also hit `capsule-gates`, which
no plan entry names), passed with `--battery`. **RED (plant)** — exit `1`:

```
FAIL — 1 plan gate claim(s) not backed by the battery and its plant log:
  · plan_gates.json entry 'forecast-ai-write-path': battery gate 'forecast-ai-write-path' has floor 0; a floor of zero passes a run over nothing
```

**PLANT 3** — F10's third plant: a copy of `plan_gates.json` listing
`forecast-ghost`, which `run_battery.py` does not register, passed with
`--plan-gates`. **RED (plant)** — exit `1`:

```
FAIL — 2 plan gate claim(s) not backed by the battery and its plant log:
  · plan_gates.json entry 'forecast-ghost': battery gate 'forecast-ghost' is not registered in scripts/run_battery.py
  · plan_gates.json entry 'forecast-ghost': no plant log — gates.md has no heading 'forecast-ghost'
```

**PLANT 4** — TC-3: a copy of `plan_gates.json` with `gates: []`.
**RED (plant)** — exit `1`:

```
FAIL — 9 plan gate claim(s) not backed by the battery and its plant log:
  · plan_gates.json lists ZERO gates. A census over nothing is a broken census, not a clean one (TC-3).
  · required_gates[B0]: gate 'forecast-model' has no plan_gates.json entry landed in B0 (an earlier batch's entry does not count)
  · required_gates[B0]: gate 'forecast-serving-boundary' has no plan_gates.json entry landed in B0 (an earlier batch's entry does not count)
  · required_gates[B0]: gate 'forecast-drivers' has no plan_gates.json entry landed in B0 (an earlier batch's entry does not count)
  · required_gates[B0]: gate 'forecast-ai-write-path' has no plan_gates.json entry landed in B0 (an earlier batch's entry does not count)
  · required_gates[B0]: gate 'forecast-boundary' has no plan_gates.json entry landed in B0 (an earlier batch's entry does not count)
  · required_gates[B0]: gate 'plan-gate-census' has no plan_gates.json entry landed in B0 (an earlier batch's entry does not count)
  · required_rows[B0]: row F5 has no registered gate landed in B0 (an earlier batch's entry does not count)
  · required_rows[B0]: row F10 has no registered gate landed in B0 (an earlier batch's entry does not count)
```

(Re-run after the B0 repair round; the first recording showed the ZERO GATES
line and the two row lines only.)

**PLANT 5** — the repair round's defect, on a copy of `plan_gates.json`:
`required_rows` gains `B5: [F1]`, `B6: [F2]`, `B21: [F1, F2, F5, F10]`, with no
forecast-balance or forecast-server-side gate anywhere. Before the repair the
census printed `PASS — every listed plan gate is registered, planted and
scoped.` (B5's F1 was met by B0's forecast-model entry, B6's F2 by B0's
forecast-boundary). **RED (plant)** — exit `1`:

```
FAIL — 63 plan gate claim(s) not backed by the battery and its plant log:
  · required_gates[B5] omits 'forecast-balance', which contract 28.3 says B5 registers
  · required_rows[B5]: row F1 has no registered gate landed in B5 (an earlier batch's entry does not count)
  · required_gates[B6] omits 'forecast-server-side', which contract 28.3 says B6 registers
  · required_rows[B6]: row F2 has no registered gate landed in B6 (an earlier batch's entry does not count)
  · required_gates[B21] omits 'forecast-balance', which contract 26.1 says the final census registers
  · ... (58 further lines, each an omission 28.3 or 26.1 names)
```

**PLANT 6** — a required gate with no entry: a copy of `plan_gates.json` with
the `forecast-drivers` entry deleted while `required_gates[B0]` still names it.
Before the repair: `PASS`. **RED (plant)** — exit `1`:

```
FAIL — 1 plan gate claim(s) not backed by the battery and its plant log:
  · required_gates[B0]: gate 'forecast-drivers' has no plan_gates.json entry landed in B0 (an earlier batch's entry does not count)
```

**PLANT 7** — `registration_only` outside 0.5: a copy adding
`{id forecast-route, gate forecast-route, rows [S4, F9], landed_in B6,
registration_only true, plant_log "forecast-route B6"}` and a copy of this file
whose `## forecast-route B6` section holds only the marker words and the
registration_only line. Before the repair: `PASS`, `units=7 rows=6`.
**RED (plant)** — exit `1`:

```
FAIL — 16 plan gate claim(s) not backed by the battery and its plant log:
  · plan_gates.json entry 'forecast-route': registration_only (landed_in 'B6') — contract 0.5 allows it only for the six B0 registrations forecast-model, forecast-serving-boundary, forecast-drivers, forecast-ai-write-path, forecast-boundary, plan-gate-census; every other gate lands with its repair and records RED (parent commit)
  · ... (15 further lines, each an omission 28.3 or 26.1 names)
```

**PLANT 8** — B21 listing every row and no gate. **RED (plant)** — exit `1`:

```
FAIL — 37 plan gate claim(s) not backed by the battery and its plant log:
  · required_gates[B21] omits 'forecast-balance', which contract 26.1 says the final census registers
  · required_rows[B21]: row F3 has no registered gate (any batch)
  · ... (35 further lines, each an omission 28.3 or 26.1 names)
```

**PLANT 9** — an earlier batch's entry offered for a later batch's gate: a
battery copy registering B5's seven gates, a `plan_gates.json` copy with every
B5 key and entry correct (this passes: `PASS`, `batches=2`), then the one change
`forecast-balance` `landed_in: B0`. **RED (plant)** — exit `1`:

```
FAIL — 2 plan gate claim(s) not backed by the battery and its plant log:
  · required_gates[B5]: gate 'forecast-balance' has no plan_gates.json entry landed in B5 (an earlier batch's entry does not count)
  · required_rows[B5]: row F1 has no registered gate landed in B5 (an earlier batch's entry does not count)
```

Before any section of this B0 block existed, the real census run over the
tree also went red (six `no plant log — gates.md has no heading ...` lines),
which is how the sections above came to be written first.

**RED (parent commit)** — no repair in this commit; registration of an existing test (the census is new in B0 and the contract marks it registration_only, 0.5).

**REVERT** — the copies discarded; the tree's files were never edited; `PASS plan-gate-census`.

**After the repair it reds on:** an F or S entry without battery registration,
floor, canary, plant log or scope line; a canary the battery gate or its
runner does not carry; an unknown row or batch; `registration_only` on any
entry but B0's six; a `retired_in` other than forecast-get-b4-parity at B6; a
landed batch whose `required_gates` omits a gate 28.3 says it first registers
or whose `required_rows` omits a row 26.1 lands there; a required gate or row
met only by another batch's entry; a B21 key short of every 26.1 battery gate
and every row; zero entries.
**It cannot see:** whether a recorded red is true; a batch that registers
nothing and writes no key (nothing marks it landed, so its 28.3 gates are
checked only at B21, and only the 26.1 battery gates are, not the 26.3
supporting ones); an extension (command extended, floor raised, canary
added) of a gate an earlier batch registered; drift between the literal
`CONTRACT_LANDS` / `ROW_BATTERY_GATES` reading and a later contract edit (the
script checks only that the two agree with each other).

<!-- ═══ plan/2 B2 (plan_contract_v2 28.3): timeline and year-to-date tax ═══
     B2 lands one new gate (forecast-base-parity, contract 5.3 delta mode)
     and extends forecast-model with tests/engine/test_forecast_timeline_tax.py
     (6.1, 6.3). Both land in the commit that changes the tax rule and moves
     the horizon out of KEYS, so each records the plant red and the gate run
     against the parent commit (0.5). -->

## forecast-base-parity

`tests/engine/test_forecast_base_parity.py` — contract 5.3, **delta mode**.
Today's engine is run on the four committed books at total_years 5 and a
twelve-month window, and every (line, period) and plan-year total (sum of the
year's periods for a flow, the closing period for a balance) is compared with
`tests/engine/fixtures/forecast/base_get_b0.json`, the B0 reference. Every
difference is printed. A difference is legal only on a line inside the
downstream closure of the test's `CHANGED` set — the lines whose static
attribution (`LINE_ASSUMPTIONS`, the inverse of consumed_by) names a CHANGED
driver or convention; the reference's `checks.*` series are attributed through
the served line each measures (declared in the test and printed). B2's CHANGED
entries: `tax_accrued_year_to_date`, `tax_no_loss_carry_forward`, and the keys
B2 removed from KEYS, `year_one_granularity` and `horizon_years` (their closure
is empty: a horizon that became an argument may move no base figure). B3
appends under its anchor; B4 re-points the gate to parity mode.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_forecast_base_parity.py -q` |
| work count | `GATE-WORK forecast-base-parity units=(\d+)`, floor **4700** cells (measured 4788 at registration, rounded down) |
| canary | `SCOPE forecast-base-parity (delta mode)`, `366-day plan year per book` |

**SCOPE** — books agras, carniprod, realestate, retail (committed
`saga_10_col` fixtures, FY2025 anchors); total_years 5; monthly_months 12 only
(delta mode's one window, contract 5.3); reference `base_get_b0.json`
(recorded on 1944109); the 366-day plan year each book's scope covers is
printed (plan year 3, FY2028, on all four) and a book with none reds (TC-3); no
SYNTHETIC pair. Printed: `SCOPE forecast-base-parity (delta mode): books agras,
carniprod, realestate, retail; total_years 5; monthly_months 12 (delta mode's
only window); reference base_get_b0.json; 366-day plan year per book: agras
plan year 3; carniprod plan year 3; realestate plan year 3; retail plan year 3`.

**GREEN** — exit `0`, `4 passed`; `differences: 135 (0 outside closure)` —
135 monthly cells moved by one minor unit (agras 55, carniprod 25, retail 55;
75 by -1, 60 by +1) on `pl.income_tax`, `pl.net_income`, `cf.net_income`,
`cf.cash_from_operating`, `cf.net_change_in_cash`, the cash roll,
`bs.equity_retained` and `checks.cash_before_funding_line_cents`, months
2026-02 to 2026-11 only; no plan-year total moved.
`PASS forecast-base-parity (2.2s, 4788 (line, period) and plan-year cells compared)`.

**PLANT 1** — contract 5.3's plant, in `src/engine/forecast/project.py`: one
minor unit of other financial expense in plan year 1 (while CHANGED holds only
B2's entries):

```
-        other_financial_expense = other_fin_expense_of[period.index]
+        other_financial_expense = other_fin_expense_of[period.index] + (1 if period.index == 0 else 0)
```

**RED (plant)** — through `scripts/run_battery.py`'s own runner, exit `1`; the
red names book, line and period (month and plan year), and the pre-tax result
it moves, which no B2 entry attributes either:

```
FAIL forecast-base-parity (exit 1, 1.6s)
E     retail pl.other_financial_expense 2026-01: -5701174 -> -5701175 (delta -1 minor) [OUTSIDE CLOSURE]
E     retail pl.other_financial_expense plan year 1: -67126728 -> -67126729 (delta -1 minor) [OUTSIDE CLOSURE]
E     retail pl.pretax_result 2026-01: 9868651 -> 9868650 (delta -1 minor) [OUTSIDE CLOSURE]
E   assert not ['agras pl.other_financial_expense 2026-01: -560095 -> -560096 (delta -1 minor) [OUTSIDE CLOSURE]', ...]
```

**PLANT 2** — contract 5.3's second plant (logged in B2 on delta mode, again in
B4 on parity mode): revenue sliced by each period's days over the days basis
instead of cumulatively over the plan year's own days:

```
-                _slice_by_days(running_revenue, periods),
+                [mul_div(running_revenue, p.days, days_basis) for p in periods],
```

**RED (plant)** — exit `1`; the 366-day plan year reds with its delta, on agras
exactly the contract's measured +324,868.00, and the twelve monthly slices of
the 365-day year are off by the per-period rounding:

```
FAIL forecast-base-parity (exit 1, 1.7s)
E     agras pl.revenue FY2028: 11857681964 -> 11890168764 (delta +32486800 minor) [OUTSIDE CLOSURE]
E     agras pl.revenue plan year 3: 11857681964 -> 11890168764 (delta +32486800 minor) [OUTSIDE CLOSURE]
E     retail pl.revenue 2026-04: 653509024 -> 653509025 (delta +1 minor) [OUTSIDE CLOSURE]
E     retail pl.revenue FY2028: 7951026465 -> 7972810099 (delta +21783634 minor) [OUTSIDE CLOSURE]
E     retail pl.revenue plan year 1: 7951026465 -> 7951026469 (delta +4 minor) [OUTSIDE CLOSURE]
```

**RED (parent commit)** — the gate file copied onto a detached worktree of the
parent `eb2ff8f` (`wave/plan-b0`), exit `1`, `3 failed, 1 passed`: the parent
engine knows neither tax convention the CHANGED set names (it still charges
tax per period, the defect B2 repairs), so the closure is empty and the
in-closure check reds too:

```
E   AssertionError: CHANGED names ids the engine does not know (neither a driver, a convention nor a declared removed key): ['tax_accrued_year_to_date', 'tax_no_loss_carry_forward']
E   AssertionError: assert ('pl.income_tax' in set())
```

**REVERT** — `project.py` restored from a byte copy after each plant (sha1
143ae735a7e3d9e24f5faf55afdf0d22a1f04cc6 before and after);
`PASS forecast-base-parity (1.5s, 4788 (line, period) and plan-year cells compared)`.

**After the repair it reds on (TC-11):** any base figure that moves on a line no
CHANGED driver or convention reaches; a revenue slice not exact to its plan
year; a line the engine stops producing; a moved period axis; a CHANGED entry
naming nothing the engine knows; a scope with no 366-day plan year or no
compared cell.
**It cannot see:** whether a move inside the closure is the intended one (the
batch's own gates and the blast radius judge that); the served GET bytes
(`scripts/measure_plan_blast_radius.py` measures those, and never asserts); a
twenty-four-month window (parity mode, B4).

### forecast-model — plan/2 B2 extension: the calendar and year-to-date tax

B2 extends the `forecast-model` command with
`tests/engine/test_forecast_timeline_tax.py` (contract 6.1, 6.3, 2.2) and
raises the floor from **220** to **240** tests (measured 246: 203 in
`test_forecast_model.py`, whose F1 matrix axis became monthly_months {12, 24}
in place of monthly/quarterly/annual, plus 43 in the new file). Canaries added:
`test_a_loss_month_then_profit_months_is_taxed_on_the_years_result`,
`test_every_period_is_charged_the_tax_on_its_year_to_date_result`,
`test_the_calendar_is_monthly_months_then_one_period_per_plan_year`. The work
source stays junit-xml over both files (as-built B2): switching it to the new
file's printed line would lose the collapse detection over
`test_forecast_model.py` and the test-name canaries; the new file prints its
own SCOPE and coverage lines instead.

Retired in the same commit (contract 28.3 B2), each with its new assertion:
`test_forecast_model.py:505` (the F1 axis monthly/quarterly/annual becomes
monthly_months {12, 24}); the calendar and label tests around `:736` (labels
asserted as twelve (or twenty-four) monthly periods then FY periods, with
year_offset (k - 1) // 12 + 1); `:904` (the tax convention texts are now the
pack's `tax_accrued_year_to_date` and `tax_no_loss_carry_forward`, served under
those ids and on the face of the plan). Every other `year_one_granularity=`
call is rewritten to the twelve-month window, and calls passing `horizon_years`
to `project()` or `derive_assumptions` are rewritten to the arguments.

**SCOPE** — books agras, carniprod, realestate, retail (committed
`saga_10_col` fixtures, FY2025 anchors); calendar over total_years 1-5 x
monthly_months 12/24; the year-to-date law over the four books x
monthly_months 12/24 x total_years 3/5; CONSTRUCTED on agras and labelled:
a loss month then profit months, an in-year reversal, a loss plan year then a
profit year; no SYNTHETIC pair. Printed: `SCOPE forecast-model/timeline-tax:
books agras, carniprod, realestate, retail (committed saga_10_col fixtures,
FY2025 anchors); monthly_months 12/24; total_years 1-5 (calendar), 3 and 5
(tax sweep); ...` and `timeline-tax coverage: 574 periods checked, 17 loss plan
years, 1 in-year reversals`.

**PLANT** — contract 6.3's plant, in `src/engine/forecast/project.py`:
per-period positive-only tax:

```
-        year_pretax += pretax
-        year_tax_due = max(0, apply_rate(year_pretax, tax_rate))
-        income_tax = year_tax_due - year_tax_charged
-        year_tax_charged = year_tax_due
+        income_tax = apply_rate(pretax, tax_rate) if pretax > 0 else 0
```

**RED (plant)** — through the battery runner, exit `1`,
`18 failed, 228 passed`; the loss-then-profit year names the over-charge, the
reversal case finds no credit, and the year-to-date walk names each period:

```
FAIL forecast-model (exit 1, 6.7s)
E   AssertionError: the year's tax 231269229 is not the tax on the year's pre-tax 1313128742 at 160000 micros (210100599); the loss month was not shielded
E   AssertionError: agras: ['2026-02: cumulative tax 40288669, due on year-to-date pre-tax 251804178 at 160000 micros is 40288668', ...]
E   assert [] == ['2026-12']
```

**RED (parent commit)** — the new file copied onto a detached worktree of the
parent `eb2ff8f`: collection error (`ModuleNotFoundError: No module named
'engine.forecast.levers_pack'`; the parent's `project()` has no `total_years`
argument either). The defect itself, measured on the parent engine through its
own API with the same construction (agras, opening debt repaid in month one at
the rate the test renders, 8.635060):

```
PARENT eb2ff8f agras loss-then-profit year (rate 8.635060): month-1 pre-tax -132303927, year pre-tax 1313128742, charged 231269229, law max(0, tax on year) 210100599, over-charge 21168630
```

**REVERT** — `project.py` restored from a byte copy (sha1
143ae735a7e3d9e24f5faf55afdf0d22a1f04cc6 before and after);
`PASS forecast-model (5.7s, 246 tests)`.

**After the repair it reds on (TC-11):** a plan year whose periods' tax differs
from max(0, tax on the year's pre-tax result) to the minor unit; a period whose
cumulative tax differs from the tax on its year-to-date result; a loss carried
into the next plan year; a monthly period whose year_offset is not
(k - 1) // 12 + 1; a calendar gap or overlap; `horizon_years` or
`year_one_granularity` accepted as a driver; a horizon refusal that does not
render the numbers it compared; a sweep that met no loss plan year, no in-year
reversal or no period.
**It cannot see:** whether the tax rate is right (forecast-defaults, B3);
cost-of-sales plan-year totals across windows (a per-period share of revenue
until the pools of B4); the served figures (forecast-route,
forecast-serving-boundary).

<!-- ═══ plan/2 B3 (plan_contract_v2 28.3): one driver authority and tier pedigree ═══
     B3 lands two gates in the commit that moves the shared driver concepts
     onto one derivation and gives every driver its tier ladder:
     forecast-authority (contract 4) and forecast-defaults, engine half (F3,
     3.3, 3.4, R16). It extends forecast-base-parity's CHANGED set under its
     own anchor and prints a scope line for forecast-drivers (B0-16). Each
     new gate records the plant red and the parent-commit red (0.5). -->

## forecast-authority

`tests/engine/test_forecast_driver_authority.py` — contract section 4, one
concept one value. For every concept the authority registry marks `supplied`
(`engine.forecast_drivers.authority.CONCEPTS`, read at run time, so a new
concept is covered the day it is registered) plus the macro anchor both
packages cite, on the four committed books: the drivers package's EXACT
integer (micros, micro-days), translated to the model's key, equals the
model's; the tiers agree; an absent concept on one side is not a book
measurement on the other; the anchor has one series id and one value. It also
checks that the crossing is exact and never demotes a tier, and that no
blocked concept remains and the renamed gross-base depreciation share never
crosses.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_forecast_driver_authority.py -q` |
| work count | `GATE-WORK forecast-authority units=(\d+)`, floor **50** comparisons (measured 52 at registration: 12 model keys x 4 books + the macro anchor x 4) |
| canary | `SCOPE forecast-authority (plan/2 B3, contract 4)`, `covered concepts` |

**SCOPE** — books agras, carniprod, realestate, retail (committed `saga_10_col`
fixtures, FY2025 anchors), one period each; no SYNTHETIC pair (history is B7);
shared concepts from `authority.CONCEPTS` status supplied plus the macro
anchor. Printed: `SCOPE forecast-authority (plan/2 B3, contract 4): books
agras, carniprod, realestate, retail; one period each (history is B7, no
SYNTHETIC pair); shared concepts from authority.CONCEPTS (status supplied) plus
the macro anchor` and `covered concepts 12: borrowing_rate, capital_intensity,
cost_of_sales_share, days_inventory_outstanding, days_payable_outstanding,
days_sales_outstanding, depreciation_rate, dividend_policy, effective_tax_rate,
macro_anchor, operating_cost_share, revenue_growth`.

**GREEN** — `8 passed`; `PASS forecast-authority (1.0s, 52 shared-concept comparisons)`.

**PLANT** — contract section 4's plant, in
`src/engine/forecast_drivers/derive.py` (`_from_engine`): move dio by one
micro-day.

```
-    exact = int(item.exact)
+    exact = int(item.exact) + (1 if model_key == "dio_cogs_days" else 0)
```

**RED (plant)** — through `scripts/run_battery.py`'s runner, `FAIL
forecast-authority (exit 1, 1.0s)`, `5 failed, 3 passed`; each red names the
concept, model key and book (realestate carries no cost of sales, so its dio is
absent on both sides and does not move):

```
E   AssertionError: agras days_inventory_outstanding (dio_cogs_days): drivers 46213148, model 46213147 (delta +1)
E   AssertionError: carniprod days_inventory_outstanding (dio_cogs_days): drivers 62259490, model 62259489 (delta +1)
E   AssertionError: retail days_inventory_outstanding (dio_cogs_days): drivers 39135095, model 39135094 (delta +1)
E   AssertionError: dio_cogs_days
```

**RED (parent commit)** — the gate file copied onto a detached worktree of the
parent `f9ca64a` (`wave/plan-b2`): collection error, `ImportError: cannot
import name 'assumptions_for_payload' from 'engine.forecast.project'`. The
defect itself, measured on the parent through its own APIs
(`scratchpad/b3/parent_probe.py`): two values for one concept on every book,
and the one blocked concept.

```
RED agras dso_days: drivers 26.2057, model 26.205674
RED agras dio_days: drivers 45.5484, model 46.213147
RED agras dpo_days: drivers 36.6412, model 37.175931
RED agras capex_pct_of_revenue: drivers 0.024957, model 0.024923
RED agras depreciation_rate: drivers 0.073739, model 0.251979
RED carniprod capex_pct_of_revenue: drivers 0.041799, model 0.037169
RED realestate depreciation_rate: drivers 0.037849, model 0.009404
blocked_model_keys: ('depreciation_rate',)
```

**REVERT** — `derive.py` restored from a byte copy (sha1
d0b82b74085a88c80825986d65d18e35650b5a30 before and after);
`PASS forecast-authority (1.0s, 52 shared-concept comparisons)`.

**After the repair it reds on (TC-11):** any shared concept whose two integers
differ by one unit on any corpus book (named by concept, model key and book); a
drivers value with no exact integer where the model measured one; one package
holding a book value the other refused; a tier disagreement; the macro anchor
under two ids or values; a hand-over that changes the integer or tier the model
holds; a blocked concept remaining or the gross-base share crossing; zero
comparisons.
**It cannot see:** whether the engine's derivation is right (the model's own
gates own that); multi-period CAGR agreement (B7); the tax rule on constructed
books where the two packages' conditions differ (a tying book with a nil charge
and no class-69 account: the drivers package refuses, the model measures a nil
rate; `test_forecast_drivers.py` hx2/hx2b and the model's nil-charge test gate
each side, and the absent hand-over makes the model honour the refusal).

## forecast-defaults

`tests/engine/test_forecast_tier_ladders.py` — the engine half of F3 (contract
26.2 F3, 3.3, 3.4, R16), through `project_payload` (`project()`) on the four
books at horizons 3 and 5: every driver carries a tier on its 3.4 ladder (the
test's `LADDERS` table) with the evidence its tier requires; no driver outside
`ABSENT_LEGAL` ends absent; every response carrying an absent driver projects
(counted, 0 reds); no revenue_growth is a silent zero (with and without a
recorded jurisdiction); the tier does not move when the capex sentence is
reworded; a book whose effective tax rate is not measured refuses with
`no_statutory_tax_rate` in a jurisdiction with no packed statutory record (HU)
and with no recorded jurisdiction, through the engine and through GET
/api/forecast as a 422 (RO still 200); deleting the statutory record refuses a
Romanian book; the jurisdiction source of every corpus book is printed and a
null reds.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_forecast_tier_ladders.py -q` |
| work count | `GATE-WORK forecast-defaults units=(\d+)`, floor **150** drivers checked (measured 160: 20 drivers x 4 books x 2 horizons) |
| canary | `SCOPE forecast-defaults (engine half, plan/2 B3)`, `jurisdiction source per corpus book`, `responses with an absent driver that projected` |

**SCOPE** — books agras, carniprod, realestate, retail; horizons 3 and 5;
through `project_payload`; no SYNTHETIC pair (history is B7); Scandia not run
in the battery. Printed: `jurisdiction source per corpus book: agras
pack_provenance=RO; carniprod pack_provenance=RO; realestate
pack_provenance=RO; retail pack_provenance=RO` and `responses 8; drivers
checked 160; responses with an absent driver that projected 8`. Locally only,
through the blast-radius harness of contract 10: Scandia FY2025 reads
`('RO', 'pack_provenance')`, revenue_growth macro, tax_rate macro (its
effective rate is not measured), interest_income_rate the one absent driver.

**GREEN** — `24 passed`; `PASS forecast-defaults (1.5s, 160 drivers checked)`.

**PLANT 1** — contract 26.2 F3: stamp revenue_growth absent, in
`src/engine/forecast/assumptions.py` (the macro rung's `put`):

```
-        put("revenue_growth", _RATIO, growth, "engine_default",
-            "no comparable book history is loaded, so revenue grows at the "
-            ...
-            evidence=anchor.evidence(), steps=growth_steps)
+        put("revenue_growth", _RATIO, None, "unavailable",
+            "planted: revenue growth stamped absent",
+            tier="absent", steps=growth_steps)
```

**RED (plant)** — `FAIL forecast-defaults (exit 1, 1.8s)`: the projection
refuses (so the projects check reds on every book and horizon) and the silent
-zero check reds naming the book:

```
E   engine.forecast.errors.AssumptionError: assumption 'revenue_growth': is unavailable, so there is no rate to spend: planted: revenue growth stamped absent
E   AssertionError: ('agras', 'absent', None)
```

**PLANT 2** — contract 26.2 F3: reword the capex sentence. The held-in-file
test rewords it (with every tier and rule word removed); the plant makes the
product infer the tier from the sentence, in `assumptions.py`:

```
-            tier="convention", rule_id=maintenance.rule_id,
+            tier=("convention" if "convention" in maintenance.sentence
+                  else "book"), rule_id=maintenance.rule_id,
```

**RED (plant)** — `FAIL forecast-defaults (exit 1, 1.6s)`,
`test_the_served_tier_never_follows_the_sentence`:

```
E   engine.forecast.errors.AssumptionError: assumption 'capex_pct_of_revenue': tier book evidence lacks method, periods_used, inputs
```

**PLANT 3** — contract 26.2 F3: delete the statutory record, in
`packs/forecast/ro_macro.yaml`:

```
-  profit_tax_rate:
+  profit_tax_rate_deleted:
```

**RED (plant)** — `FAIL forecast-defaults (exit 1, 1.6s)`: every corpus book
refuses (none measures its own effective rate):

```
E   engine.forecast.assumptions.NoStatutoryTaxRate: assumption 'tax_rate': this book's reconstructed result of 14,106,102.03 (pre-tax 15,577,652.03 less tax 1,471,550.00) does not reach the 7,533,676.02 it filed in account 121, and -6,572,426.01 of that distance is not attributable to any line on this statement. An effective rate of 9.4465% read off two figures inside that build-up would be measured ACROSS the gap rather than from the company, and no statutory profit-tax rate is packed for jurisdiction RO, so no tax rate can be assumed and the plan is refused; supply tax_rate to project it
```

**RED (parent commit)** — the gate file on the detached parent worktree
`f9ca64a`: collection error, `ImportError: cannot import name 'ABSENT_LEGAL'
from 'engine.forecast.assumptions'`. The defect itself on the parent engine
(`scratchpad/b3/parent_probe.py`): revenue growth a silent zero and a tax rate
assumed with no jurisdiction read, on every book.

```
RED agras revenue_growth: model engine_default 0 with no tier or fallback steps (silent zero); drivers 0.025
RED agras tax_rate: engine_default 0.16 with no jurisdiction read (tier attribute: False)
RED realestate revenue_growth: model engine_default 0 with no tier or fallback steps (silent zero); drivers 0.025
```

**REVERT** — `assumptions.py` restored from a byte copy after plants 1 and 2
(sha1 97f602096e2659286231289dea0705537457f0f8 before and after), `ro_macro.yaml`
after plant 3 (sha1 5a2e1b938d814fabbaf12cef6b68bcf9b39d9699);
`PASS forecast-defaults (1.5s, 160 drivers checked)` after each.

**After the repair it reds on (TC-11):** a tier outside the six or off the
driver's ladder; evidence not matching the tier; an absent driver outside 3.3's
list on a corpus book; a response with an absent driver that does not project;
a zero growth without its convention rung and fallback steps; a tier that
follows a reworded sentence; an unmeasured tax rate projected in a jurisdiction
with no statutory record, or with none recorded, through the engine or the
route; a corpus book with no recorded jurisdiction; no response carrying an
absent driver (TC-3).
**It cannot see:** the served bytes (B6, `test_forecast_defaults_f3.py`); the
book-history rung (B7) and the sector rung (no sector store); a user value
keeping its original on the wire (the engine keeps `original`; served in B6);
rate spans (history, B7); whether a pack anchor is still the published figure.

### forecast-base-parity — plan/2 B3 extension: the CHANGED set

B3 appends under its anchor in `tests/engine/test_forecast_base_parity.py` the
drivers whose tier, rung, key or convention 3.4 and 4 change (revenue_growth,
dividend_payout_pct, tax_rate, capex_pct_of_revenue,
intangible_additions_pct_of_revenue, depreciation_rate, dso_days, dio_cogs_days,
dpo_cogs_days and the three held money drivers) and `REMOVED_KEYS_B3`
(dio_days, dpo_days, renamed away; their closure is empty). Measured at B3:
`differences: 2212 (0 outside closure)`, `GATE-WORK forecast-base-parity
units=4788`. Revenue growth's closure is nearly every line, so delta mode now
reds only on a line no B2 or B3 entry reaches (for example
`pl.other_financial_income`, `bs.other_current_assets`).

**Found by the gate, repaired in the same commit:** on the first B3 run,
realestate's `pl.interest_expense_funding_line` moved OUTSIDE the closure
(`FY2030: -830162066 -> -879863128 (delta -49701062 minor)`) — its static
attribution named only the funding rate, while the charge is priced on the
opening revolver, which is the running shortfall of everything that moves
cash. `LINE_ASSUMPTIONS["pl.interest_expense_funding_line"]` now carries the
cash closure, as `bs.revolver` already did; the next run printed 0 outside
the closure. `test_revenue_is_outside_the_b2_closure_...` now states B2's claim
on B2's own entries (revenue outside the tax conventions' closure) and adds
that the renamed day drivers carry the old closure.

### forecast-drivers — plan/2 B3: printed scope

`tests/engine/test_forecast_drivers.py::test_zz_scope` prints `SCOPE
forecast-drivers (plan/2 B3): books agras, carniprod, realestate, retail, one
period each; multi-period rungs on SYNTHETIC histories scaled from agras
(constructed, labelled in this file); micro-SRL books assembled through the
real Romanian assembly; shared concepts read from engine.forecast (contract
4)`. The work source stays the junit count (B2-7's reason: a printed count
would not see one section collapse). Tests restated in B3, each named in the
commit: j7 (the exact integer and tier, not the display value), j8 (absent
crosses as AbsentHandover), j9 (a None is refused, the absent hand-over
honoured), j11 (no blocked concept remains), j13 (learns `engine_forecast`
and `pack_convention`), j17 (the refused 0% in an absent driver's engine
refusal is not a cutoff), j18, hx3, hx5, hx7, hg4 (absent crossings).
