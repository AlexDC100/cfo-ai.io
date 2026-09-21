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

## ratio-credit-model

The credit model is ONE pure function and ONE letter ladder
(`engine.ratios.credit_model`, batch B1). `stage_compute` used to hold the
arithmetic inline beside its database writes, and `get_period` served a
second, literal copy of the letter ladder that happened to agree. A weight or
rung moved in one copy and not the other prints a composite beside a letter
from a different model, and nothing crashes.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_credit_model_pure.py tests/engine/test_credit_ladder_single_source.py tests/engine/test_credit_model_refusals.py tests/engine/test_credit_model_rungs_and_ranges.py tests/engine/test_credit_refusal_fe_fixture.py -q` |
| work count | junit-xml, floor **60** tests (measured 70: the purity claims, the ladder scan, the refusal gates, the 35 rung / range / withdrawal / pack gates and the FE fixture capture) |
| canary | `test_pure_rows_are_the_pre_extraction_rows_byte_for_byte`, `test_stage_compute_inserts_exactly_the_pure_rows`, `test_there_is_exactly_one_literal_ladder`, `test_a_book_with_no_liabilities_refuses_the_composite_and_the_letter_through_the_real_route`, `test_every_book_refuses_exactly_where_its_liabilities_are_below_the_model`, `test_the_block_and_the_refusals_take_no_rows_only_fallback`, `test_a_filed_altman_and_composite_outside_the_range_are_withdrawn_never_reprinted`, `test_a_broken_pack_refuses_the_credit_block_and_the_period_still_serves`, `test_the_fe_credit_fixture_is_what_the_route_serves_today`, `test_interest_coverage_divides_ebit_and_ebitda_to_interest_divides_ebitda` |

**Reds on, after the repair (TC-11):** any persisted row (weight, sub-score
mapping, Altman coefficient, rounding, operand, unit, direction, order) on
any of the seven cases differing from the golden captured from
`stage_compute` BEFORE the extraction; an `interest_coverage` row that is
not EBIT ÷ interest by operands, an `ebitda_to_interest` row that is not
statutory EBITDA ÷ interest, or the two rows printing one figure on an
interest-paying book with D&A (the basis gate, added 2026-09-19 — it reds by
operands, so a re-captured golden cannot carry the EBITDA basis back); an I/O call or client import in
`credit_model.py`; `stage_compute` inserting anything but the pure rows; a
second ladder literal in `pipeline.py` or `engine/ratios`. It proves no
change against the pre-extraction commit, not that the numbers are right,
and it does not pin the rung values (a rung moved with no revision bump
stays green — recorded by the B1 verifier; not re-measured by this section).

**GREEN** — exit `0`: `PASS ratio-credit-model (1.9s, 22 tests)`.

**PLANT** — `src/engine/ratios/credit_model.py`: the Altman weight in the
composite raised by 0.01
(`(CREDIT_COMPOSITE_WEIGHTS["altman"] + 0.01) * altman_subscore`).

**PLANT 2 (2026-09-19, the interest-coverage basis)** —
`src/engine/ratios/credit_model.py` `compute_period_metrics`: the
`interest_coverage` row restored to `safe(ebitda, interest)` (the basis it
carried until 2026-09-19; the methodology, CLAUDE.md Appendix A section 5,
defines interest coverage as EBIT ÷ interest expense, and `ebitda_to_interest`
is the EBITDA row).

**RED 2** — exit `1`, `11 failed, 62 passed` on
`tests/engine/test_credit_model_pure.py` (the golden's five interest-paying
cases ×2 and the basis gate):

```
E   AssertionError: scandia_fy2025_baseline: interest_coverage 17.704 is not EBIT / interest = 13.2654 (EBITDA / interest would be 17.704)
E       scandia_fy2025_baseline: interest_coverage and ebitda_to_interest print one figure 17.704 under two names
E       saga_10_col_retail: interest_coverage 0.0909 is not EBIT / interest = -0.519 (EBITDA / interest would be 0.0909)
E   AssertionError: [saga_10_col_agras] compute_period_metrics drifted from what stage_compute persisted before the extraction:
E     interest_coverage: pure {'name': 'interest_coverage', 'value': 66.2774, ...} vs persisted {'name': 'interest_coverage', 'value': 55.644, ...}
FAILED tests/engine/test_credit_model_pure.py::test_interest_coverage_divides_ebit_and_ebitda_to_interest_divides_ebitda
FAILED tests/engine/test_credit_model_pure.py::test_pure_rows_are_the_pre_extraction_rows_byte_for_byte[scandia_fy2025_baseline]
```

**REVERT 2** — exit `0`: `18 passed` on the file. Verdict: proven RED. The
golden was re-captured deliberately in the same commit
(`rows_moved_on_recapture_2026_09_19_interest_coverage_ebit` inside the
file): scandia 17.704 → 13.2654, agras 66.2774 → 55.644 (both cases),
realestate −25.0795 → −25.1332, retail 0.0909 → −0.519 (a sign flip),
carniprod unchanged (no interest expense: the R-D1 rung, not a division).

**RED** — exit `1`, `10 failed, 12 passed`, battery record `FAIL`:

```
FAILED tests/engine/test_credit_model_pure.py::test_pure_rows_are_the_pre_extraction_rows_byte_for_byte[saga_10_col_agras]
FAILED ...::test_pure_rows_are_the_pre_extraction_rows_byte_for_byte[scandia_fy2025_baseline]
FAILED ...::test_stage_compute_inserts_exactly_the_pure_rows[saga_10_col_retail]
======================== 10 failed, 12 passed in 1.04s =========================
RECORD ratio-credit-model {'state': 'FAIL', 'exit_code': 1, 'work_units': 22}
```

**REVERT** — exit `0`: `PASS ratio-credit-model (1.9s, 22 tests)`. Verdict:
proven RED.

**REVISION 2 (2026-09-15, ruling Q2: absent is never zero).** Added
`tests/engine/test_credit_model_refusals.py`. Reds on, after the repair:
`corpus/saga_compact_6_col` through the real GET /api/period route serving a
number for X4, Z'' or the Altman or liquidity sub-score; a refused sub-score
missing from `refused_subscores` or carrying another code; served `weights`
that are not the computed sub-scores' weights renormalised; a composite that
is not those weights times the served sub-scores; the envelope's
composite_weights differing from the ratio table's; on every deterministic
corpus book and the five served books, a refused set other than exactly
{liquidity when current liabilities are not positive, altman when total
liabilities are not positive} (census: 20 books, 7 with a refusal); the
two-period block giving a refused row any reason but the model's own.

**GREEN** — `PASS ratio-credit-model (19.6s, 26 tests)`.

**PLANT A** — `credit_model.py`: X4 back on the revision-1 divisor
(`x4 = total_equity / max(total_liab, 1)`). **RED** — exit `1`,
`FAIL ratio-credit-model (exit 1, 9.7s)`, `3 failed, 23 passed`:

```
E   AssertionError: saga_compact_6_col: refused sub-scores {'liquidity': 'current_liabilities_not_positive'}, expected {'liquidity': 'current_liabilities_not_positive', 'altman': 'total_liabilities_not_positive'} from the liabilities
```

**PLANT B** — liquidity back to zero (`liq_subscore = 0.0` before the
`current_liab > 0` branch): 4 failed. **PLANT C** — no renormalisation
(`CREDIT_COMPOSITE_WEIGHTS[k]` without `/ total`): 3 failed,
`AssertionError: ('saga_compact_6_col', {'coverage': 0.1, 'dscr': 0.1, 'equity': 0.05, 'leverage': 0.15, ...})`.
**PLANT D** — `credit_block` serving the model table as `weights`: 3 failed.
**PLANT E** — `ratio_compare._composite_rows.refused` ignoring the
sub-score's own refusal: 1 failed,
`AssertionError: ('altman_z', {'code': 'credit_inputs_absent', 'inputs': []})`.

**REVERT** — `PASS ratio-credit-model (19.6s, 26 tests)`. Verdict: proven RED.

## ratio-table

The per-period ratio table (`engine.ratios.table`, batch B2): every census
ratio's value, printed digits, band, ladder and refusal, from the served
payload, held to the digits `computeRatios` prints on four committed books.
The defect class is a number one digit off: the engine rounding the repr
instead of the binary value, a metric row winning where the FE reads the
balance sheet, a withheld row still serving the ladder its badge hides.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_ratio_table.py -q` |
| work count | junit-xml, floor **50** tests (measured 56) |
| canary | `test_census_is_every_fe_row_plus_every_pack_banded_key`, `test_engine_value_is_the_printed_fe_value_on_every_shared_key`, `test_a_legacy_period_reads_the_served_assembled_bs_totals` (current_ratio's operands on a legacy period), `test_a_value_on_a_rung_takes_that_rung` |

**Reds on, after the repair (TC-11):** any shared key on any book and
variant (served, disputed, perturbed) whose `value_q` differs from what
`formatRatio` prints, or whose refusal kind does not map; a display string
that is not ROUND_HALF_UP of the exact binary value; a row of any status
without a boolean `higher_is_better`; a non-graded row serving a ladder; a
value exactly on a rung not taking that rung; a verdict difference against
the FE not in the declared divergence set.

**GREEN** — exit `0`: `PASS ratio-table (4.3s, 56 tests)`.

**PLANT** — `src/engine/ratios/table.py` `quantize_display`: banker's
rounding (`rounding="ROUND_HALF_EVEN"`).

**RED** — exit `1`, `8 failed, 48 passed`, battery record `FAIL`:

```
FAILED tests/engine/test_ratio_table.py::test_quantization_is_half_up_on_the_exact_binary_value[0.125-x-0.13]
FAILED ...::test_quantization_is_half_up_on_the_exact_binary_value[2.5-days-3]
FAILED ...::test_quantization_is_half_up_on_the_exact_binary_value[1.125-z-1.13]
========================= 8 failed, 48 passed in 3.56s =========================
RECORD ratio-table {'state': 'FAIL', 'exit_code': 1, 'work_units': 56}
```

**REVERT** — exit `0`: `PASS ratio-table (4.3s, 56 tests)`. Verdict: proven
RED.

## ratio-compare

The two-period ratio block (`engine.comparatives.ratio_compare`, batch B4):
both periods' ratios, bands, deltas, movements and credit composites under
one model revision, served by `GET /api/period/{id}/comparatives`. The
defect class: a prior composite silently absent (the FE dropped to a second
credit model), a printed prior plus printed delta that does not equal the
printed current, a materiality or width computed on the wrong base.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_ratio_compare.py -q` |
| work count | junit-xml, floor **30** tests (measured 34) |
| canary | `test_a_prior_with_no_persisted_metric_rows_still_carries_its_composite` (altman_z prior present), `test_printed_prior_plus_printed_delta_is_printed_current_on_every_row`, `test_materiality_is_the_hand_checked_figure_for_each_unit_on_the_real_pair` |

**Reds on, after the repair (TC-11):** see the module docstring — a prior
with `calculated_metrics: []` serving no Altman Z'', composite or letter;
sector withholding not the declared set on both sides; a crossing whose
status, rung, distance or colour disagrees with its ranks and direction;
printed prior + printed delta != printed current on any row, or the pair
losing its `.x5` case; the rows not being the census, `both_sides_census`
not partitioning it, or an undeclared reason code; the hand-checked
materiality or the floored DPO width serving anything else.

**GREEN** — exit `0`: `PASS ratio-compare (6.9s, 34 tests)`.

**PLANT** — `src/engine/comparatives/ratio_compare.py` `_delta`: the delta
from full precision (`Decimal(repr(cur["value"])) - Decimal(repr(pri["value"]))`)
instead of the quantized sides.

**RED** — exit `1`, `1 failed, 33 passed`, battery record `FAIL`:

```
E   AssertionError: the document does not tie to itself:
E       roa: printed 33.3 + -32.6 != 0.8
E       asset_turnover: printed 0.53 + +0.38 != 0.92
FAILED tests/engine/test_ratio_compare.py::test_printed_prior_plus_printed_delta_is_printed_current_on_every_row
RECORD ratio-compare {'state': 'FAIL', 'exit_code': 1, 'work_units': 34}
```

**REVERT** — exit `0`: `PASS ratio-compare (6.9s, 34 tests)`. Verdict:
proven RED.

## ratio-band-findings

Band crossings as seven-element findings (`engine.api.findings.c_bands`,
batch B5). Every ratio (and the Altman zone and the letter) that changed band
between two periods is a `Finding` built through `_base.build_finding` and
serialised by `Finding.to_payload()`: surfaced when `validate()` finds all
seven, otherwise the check row it demotes to, carrying its missing elements.
The silent failure this exists for is a demoted crossing that simply
vanishes, so the deteriorated list reads "nothing crossed" while a ratio fell
two bands. Over all 20 ordered pairs of the five served books (the four corpus
books and the Scandia baseline) 350 crossings serve 302 surfaced findings and
48 demoted check rows, every one of them `impact: no impact supplied` on ccc
(16), letter_grade (18) or altman_z (14) — no money denominator, so no
headroom impact (held for the owner). Before the repair round 17 more demoted
on formatting: carniprod serves the code `701.00'`, and subject selection
named it.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_comparatives_bands.py -q` |
| work count | junit-xml, floor **55** tests (measured 60 after R2b, all over REAL GET /api/period bodies; 20 of them the every-finding check, 20 the prose check, one per ordered pair) |
| canary | `test_a_planted_current_ratio_crossing_across_the_1_5_rung_surfaces_with_all_seven` (current_ratio present; one crossing surfaces), `test_every_finding_carries_the_served_rows_figures_rung_headroom_severity_and_rank`, `test_a_served_code_the_contract_rejects_is_never_named_and_the_crossing_surfaces`, `test_the_movement_lists_partition_both_sides_and_demoted_crossings_stay_listed`, `test_a_lower_is_better_crossing_is_classified_by_direction`, `test_a_ratio_that_did_not_cross_produces_no_finding`, `test_a_two_period_finding_never_says_no_prior_period_was_supplied`, `test_no_finding_names_a_contra_account_and_subjects_rank_by_signed_amount`, `test_the_smallest_crossing_is_listed_with_its_surfaced_finding_and_no_floor_is_served` |

**Reds on, after the repair (TC-11):** the planted current_ratio crossing
(prior agras with its served current liabilities raised to a 1.30 ratio,
current carniprod 1.84, across the 1.5 rung) not surfacing, or its
`validate()` returning any missing element, or its provenance (both period
ids, both snapshot ids equal to `_radar.content_hash_of` of the rows)
differing; `ratio_compare` calling into c_bands other than exactly once.
On EVERY finding of all 20 ordered pairs, surfaced or demoted: a printed
prior or current figure differing from the served `value_q` in the row's
unit (the letter: the composite score) or absent from a surfaced body; the
threshold limit, back in display units, differing from
`movement.rung_crossed.value`; a severity other than the landing rule (any
rung up low; landing critical or two or more rungs down high; one down
medium); an impact present without served materiality or absent with it;
impact baseline / adjusted not the at-rung / held numerator
(rung x |served denominator| / unit scale, days on the served period length)
to float precision, not cited under `band_numerator_at_rung` /
`band_numerator_held`, or |delta| more than half a cent from the served
`headroom_money`; the findings, improved or deteriorated list out of the
printed rank order (spelled in the test from `rank_basis.order`). With
carniprod current against each other book: a subject naming a served code
`is_ledger_code` rejects, a finding demoting on "is not a ledger code", or a
revenue-bucket crossing not surfacing. A composite citing the band table
instead of a credit-model constant equal to the rung, or the letter's figures
not labelled as the composite. Prose: a why-here not opening in a capital,
an audience followed by a verb, the capitalised label mid-sentence, a doubled
word in a title. A finding for a ratio that did not cross, or a company
compared with itself producing one; a lower-is-better crossing listed against
the direction its value moved; `improved + deteriorated + unchanged +
not_comparable != coverage.both_sides`, a one-sided entry missing from
`refused`, a crossing without its finding row, or the PLANTED demotion (the
top surfaced crossing with its subject line items removed, every movement
list otherwise unchanged) dropped or not demoted on `subject` — the gate no
longer leans on a natural demotion, all of which are held impact-only ones;
two compositions serialising differently. It cannot see whether a surface
renders the rows, or the CAEN (the route passes none; the profile is
inferred from the account mix).

**GREEN** — exit `0`: `PASS ratio-band-findings (4.7s, 56 tests)` (repair
round, through `run_battery.main` with the gate list narrowed to this gate).
The wave-1 record below it (9 tests) is kept as it ran.

**REPAIR-ROUND PLANTS** — each through `run_battery.main`, each reverted:

| plant | where | battery record |
|---|---|---|
| M8 | `c_bands._figure_value` without the /100 for pct | `FAIL` exit 1, `20 failed, 36 passed` |
| S1 | `c_bands._accounts` ledger-code and name filter removed | `FAIL` exit 1, `5 failed, 51 passed` (`assert ['701'] == ['707']`) |
| P1 | `build_band_findings` drops non-surfaced rows | `FAIL` exit 1, `27 failed, 29 passed` |
| W4 | `parameter_label` back to `<label> <rung> rung` | `FAIL` exit 1, `16 failed, 40 passed` |

Direct pytest runs on the same round, each reverted RED: M12 days headroom on
360 (`agras|carniprod dpo` baseline 12937720.66 vs 12760491.61), M1 / M1b
impact endpoints swapped, M4 every severity low (`'low' == 'high'`), M11 the
composer sorting crossed rows by key and M11b `_rank_key` without
distance_fraction (`findings are not in the printed rank order`), P2 the
composer dropping rows demoted on anything but impact (`11 finding rows for
15 crossings`), Q1/Q1b/Q2/Q3 the composite source, Altman source, letter
figure label and basis sentence reverted, W2/W3/W6 the audience verb, the
capitalised embedded scope, an audience-first template without sentence
casing. W1 (sentence casing removed alone) stays GREEN: every template opens
in a capital, so it is a guard proven only with W6.

**WAVE-1 GREEN** — exit `0`: `PASS ratio-band-findings (3.8s, 9 tests)`.

**PLANT A** — `src/engine/api/findings/c_bands.py` `build_band_findings`:
drop demoted rows (`if not payload["surfaced"]: continue`).

**RED** — exit `1`, `5 failed, 4 passed`, battery record `FAIL`:

```
E   AssertionError: 11 finding rows for 14 crossings — a crossing lost its row
E    +  and   6 = len(['current_ratio', 'debt_to_equity', 'lt_debt_to_equity', 'debt_to_assets', 'letter_grade', 'altman_z'])
FAILED tests/engine/test_comparatives_bands.py::test_the_movement_lists_partition_both_sides_and_demoted_crossings_stay_listed[retail-realestate]
FAILED ...::test_a_ratio_that_did_not_cross_produces_no_finding[agras-carniprod]
FAILED ...::test_a_lower_is_better_crossing_is_classified_by_direction
========================= 5 failed, 4 passed in 2.96s ==========================
RECORD ratio-band-findings {'state': 'FAIL', 'exit_code': 1, 'work_units': 9}
```

**PLANT B** — `src/engine/comparatives/ratio_compare.py`: `not_comparable`
counting entries refused on one side (the pre-B5 shape).

**RED** — exit `1`, `2 failed, 7 passed`:

```
E   AssertionError: improved 8 + deteriorated 6 + unchanged 12 + not_comparable 5 != both_sides 30
E   assert 31 == 30
```

**PLANT C** — `ratio_compare.py`: an extra call into the builder per improved
row before the real call.

**RED** — exit `1`, `1 failed, 8 passed`:

```
E   AssertionError: ratio_compare called into c_bands 6 times, not once
```

Also observed RED during authoring, each reverted (direct pytest runs):
direction taken from the delta's sign (`('dso', 'deteriorated', 'improved')`),
prior provenance dropped (`assert ('p-carniprod-cur', None) == ('p-carniprod...'p-agras-pri')`),
same-band rows handed to c_bands (6 failed, including the self-comparison
test), the threshold comparator ignoring `higher_is_better`
(`('dso', '>=')`), and no headroom impact
(`the planted crossing demotes: ['impact: no impact supplied']`).

**REVERT** — exit `0`: `PASS ratio-band-findings (3.8s, 9 tests)` after each
plant; no `# PLANT` marker left. Verdict: proven RED.

**R2b (2026-09-15, rulings Q3 Q4 Q5 Q7 Q8 Q9).** The 48 impact-only
demotions described above are gone: ccc carries working-capital money
(days past the rung x revenue / period days), Altman Z'' headroom in Z units
and the letter in notches of the served band width; 350 of 350 crossings
surface. Added reds: a composite finding without its own-unit impact or
demoted; a ccc crossing without materiality on the dso revenue denominator;
"no prior period was supplied" in any two-period finding (Q4); a contra
account (28x/29x/39x/49x) in any subject, or a subject not ranked by signed
amount (Q5); a Z'' figure printed with the ratio marker, or not UNIT_INDEX
(Q7 — the previous `"z": "\u00d7"` expectation was the defect written into
the gate); a day count not agreeing with its printed number (Q8); a served
materiality floor, or a crossing of any share missing from its list or
findings (Q9).

**GREEN** — `PASS ratio-band-findings (16.2s, 60 tests)`.

**PLANT** — `c_bands._headroom`: the `NON_MONEY_IMPACT_KEYS` branch removed.
**RED** — `FAIL ratio-band-findings (exit 1, 13.9s)`, `18 failed, 42 passed`:

```
E   AssertionError: ('agras|carniprod letter_grade', None)
```

Also observed RED (direct pytest, each reverted): `denominators["ccc"]`
removed (`('agras|carniprod ccc', 'ccc crossed with no materiality')`);
notches unsigned (`('carniprod|agras letter_grade', 0.07000000000000028, -1)`);
notches not divided by the width (`('agras|carniprod letter_grade',
0.7000000000000028, '0.070')`); the two-period caveat override dropped
(`('agras|carniprod roic', 'Cash-flow lines are indirect-method
approximations because no prior period was supplied; ...')`); abs()
ranking back (`('carniprod|agras letter_grade', ['117.1', '4111.01',
'401.01'], ['4111.01', '5124.9.8', '401.01'])`); the contra exclusion
removed (planted bucket only — on the real pairs signed ranking already
keeps contra lines out of the top slots, measured); "z" back to UNIT_RATIO
(`('agras|realestate altman_z', 'prior', '2.43\u00d7', '2.43')`); the days
printer back to "days" (`('carniprod|retail dso', 'prior', '1 days',
'1 day')`); findings filtered below a 1% share (`agras|carniprod
cash_ratio`); materiality_floor "0.01" (`('agras', 'carniprod')`).

**REVERT** — `PASS ratio-band-findings (16.2s, 60 tests)`. Verdict: proven RED.

**REPAIR-ROUND PLANTS (B8 verifier, 2026-09-19)** — `tests/engine/test_credit_model_rungs_and_ranges.py`
(the file the refusals docstring had named before it existed), each
applied to `src/engine/ratios/credit_model.py`, run, and reverted
(`33 passed` clean before each):

**P1** — the rows-only fallback restored (`statements: Optional[...] = None`
on `credit_block`). **RED** — `1 failed, 32 passed`:
`AssertionError: credit_block: statements must be required, got default None`.

**P2** — the as-filed withdrawal off (`filed_bad = {}`). **RED** —
`1 failed`: `assert (1584.89 is None)` on `as_filed.altman_z`
(`{'altman_z': 1584.89, 'composite': 88.5, 'credit_model_revision': 1, 'letter': 'AA', ...}`).

**P2b** — the withdrawal kept but `as_filed_differs` compared AFTER nulling
(the defect this gate found while being written). **RED** — `1 failed`:
`assert False is True` on `as_filed_differs` — the withdrawal note was
never served.

**P3** — the served re-check off (`served_bad = {}`). **RED** — `3 failed`:
`assert (200.0 is None)` (X4), `assert (140.0 is None)` (composite),
`assert 120.0 is None` (leverage).

**P4** — the liquidity negative-term refusal off (`if False:`). **RED** —
`2 failed`: `assert (66.7 is None)` / `assert (59.3 is None)` (liquidity
scored on cash -1 / -1,000,000).

**P5** — the -0.0 row read with `v < 0`. **RED** — `1 failed`:
`['credit_subscore_liquidity'] == ['cash_ratio']` (the refusal named the
sub-score, not the negative term).

**P6** — a letter minted from an out-of-range composite (the range check
removed from `composite_to_letter_grade`). **RED** — `3 failed`:
`'CC' == None` (nan), `'CC' == None` (-5.0), `'AAA' == None` (140.0).

**FE (vitest, `ratioCompareTab.test.tsx`)** — `asFiledSentence` ignoring
`withdrawn` (`new Set<string>()`). **RED** — `1 failed | 38 passed`:
`expected "As filed: composite not filed, letter…" to contain "composite
withdrawn, letter withdrawn…"`.

**FE (vitest, `creditRefusedSubscores.test.tsx`)** — the reader's range
branch off (`if (false)` on `compositeRefusalOf`) over the fully scored
agras envelope (`agras_serve` in `served_credit_refusals.json`) with a
planted composite 140 / AAA. **RED** — `4 failed | 45 passed`:
`expected 140 to be null` (the reader), `expected 'strong' to be
'pending'` (the hero band), the Risks tab and the exports. Over the
compact cases alone this plant reds on ONE assertion only (the code:
`expected 'credit_component_undefined' to be 'credit_out_of_range'`) —
the beside-refused branch withholds the composite anyway — which is why
the agras case exists.

**REVERT** after each — `33 passed`. Verdict: proven RED.

## comparatives-route

`GET /api/period/{id}/comparatives` UN-INTERCEPTED (batch B8). Every
frontend ratio gate renders a committed capture, the hermetic Playwright
harness answers the route from a file, and the earlier route test mounts one
router on a bare `FastAPI()` with `_org.resolve_org` stubbed — so no gate had
sent a request to the route the Ratios tab and the exports call. An
intercepted route is a route with no gate (CLAUDE.md 22). This one builds
`engine.api.create_app()` itself, points `_supabase.per_user` / `admin` at
`firm_postgrest_double` (it refuses a column no migration declares and
verifies ES256 signatures against the session JWKS), carries agras and
carniprod through the production write seam (parse -> `stage_map` ->
`stage_persist`) as two periods of one workspace (with a CAEN), persists
their metric rows as `stage_compute` does, and a third book (retail) into
another workspace. `tests/engine/_real_app_comparatives.py` is that world,
shared with `scripts/capture_comparatives_pair.py --current/--prior`, so an
owner's local capture is produced by exactly the path this gate proves.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_comparatives_route_real_app.py -q` |
| work count | junit-xml, floor **7** tests (measured 7) |
| canary | `test_the_route_serves_every_ratio_and_a_numeric_prior_for_every_composite`, `test_the_committed_frontend_fixture_is_what_this_route_serves_for_the_pair`, `test_a_prior_from_another_workspace_is_not_found`, `test_a_current_period_from_another_workspace_is_not_found` |

**Reds on, after the repair (TC-11):** the route unmounted, renamed or its
query binding broken (404 / 405 / 422); the served document without `ratios`,
a census row or composite missing, or a prior Altman Z'', composite or letter
that is not a number on this pair; the route's `ratios` serialising
differently from `compare_payloads` over the two GET /api/period bodies the
same app serves; `pair_served.json` (what `ratio-byte-match` and the Ratios
tab gates render) carrying a quantized figure, band, change or movement the
route does not serve for the pair; a band finding whose profile is not
resolved from the workspace's CAEN (ruling Q6 — this closes the "the route
passes none" blind spot recorded under ratio-band-findings); a forged bearer
served (not 401), a caller outside the workspace served (not 403), a prior
from another workspace served (not 404 `period_not_in_workspace`); a CURRENT
period from another workspace served through the path parameter (the B8
verifier's plant A11: `cur_row` loaded by an id-only select left all six
earlier tests green while `current_label 2024-12-31` — the foreign book —
was served; `test_a_current_period_from_another_workspace_is_not_found`
now reds on it: `AssertionError: (200, '{"ratios":{...,"current_label":
"2024-12-31",...')`; reverted, 7 passed).
**Cannot see:** whether the ratios are right (ratio-compare,
ratio-band-findings); the frontend's reading of the response
(ratio-byte-match); row-level security — the double does not model RLS, so
the cross-workspace case proves the org filter in `load_period_in_org`, the
wall the route owns, not Postgres policies.

**GREEN** — `PASS comparatives-route (5.9s, 6 tests)` (through
`run_battery.main` with the gate list narrowed to the two B8 gates).

**PLANT** — `src/engine/api/_comparatives.py` `load_period_in_org`: the
filter without `org_id` (`filters={"id": "eq.%s" % period_id}`).

**RED** — `FAIL comparatives-route (exit 1, 6.4s)`, battery record
`{'state': 'FAIL', 'exit_code': 1, 'work_units': 6}`:

```
E   AssertionError: (200, '{"ratios":{"table_version":"ratio_compare.v1","current_label":"2025-12-31","prior_label":"2024-12-31","stamps":...
E   assert 200 == 404
FAILED tests/engine/test_comparatives_route_real_app.py::test_a_prior_from_another_workspace_is_not_found
========================= 1 failed, 5 passed in 5.33s ==========================
```

Also observed RED (direct pytest, each reverted): the route path renamed to
`/comparatives-v0` (`6 failed`, `AssertionError: (404, '{"detail":"Not
Found"}')`); the route passing `caen=None` (`2 failed, 4 passed`, `('roic',
'profile inventory_operator/band_mid/fin_related_party_funded resolved from
structure')` and the recomposition with the CAEN no longer equal); the
committed fixture's current_ratio prior `1.82` -> `1.83` (`{'current_ratio':
('2.10', '1.82', 'strong', 'healthy', '+0.28', '+15.4', ...)} !=
{'current_ratio': ('2.10', '1.83', ...)}`).

**REVERT** — `PASS comparatives-route (5.9s, 6 tests)` after each plant.
Verdict: proven RED.

## served-range

THE SERVED-RANGE LAW (ruling R-RANGE, 2026-09-15; owner 2026-09-18: the
range gate is absolute). Credit model revision 2 refuses instead of
flooring — but a refusal that lives only in the product can be undone by
the product. `tests/engine/served_range_law.py` states every credit score's
bound, domain and refusal vocabulary as literals with their source and
IMPORTS NOTHING from the engine (pinned by
`test_the_law_is_independent_of_the_product`), so the product's own
`score_out_of_range` cannot pass its own bug. The domain predicates read
operands from the SERVED statements' leaves, never from a served total or
ratio.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_served_range.py -q` |
| work count | junit-xml, floor **44** tests (measured 51: 4 parametrised laws × 11 books + 7 named gates) |
| canary | `test_every_served_credit_score_is_inside_the_law_or_refused_with_a_reason`, `test_the_zero_liability_books_refuse_altman_liquidity_the_composite_and_the_letter`, `test_one_ron_of_liabilities_is_not_a_capital_structure`, `test_the_law_is_independent_of_the_product`, `test_the_revision_1_filing_of_the_compact_book_is_withdrawn_on_the_route`, `test_the_r_d1_debt_leg_declares_no_rung_on_the_route`, `test_roic_refuses_on_the_route_when_invested_capital_is_not_positive` |

Eleven books through the real `GET /api/period` router over the
projection-faithful Supabase double: agras, carniprod, realestate, retail,
the Scandia FY2025 regression baseline, `corpus/imbalance_03pct` (no
liabilities, empty P&L), `synthetic_thin_equity` (no liabilities), the
same thin book assembled through the production write seam with ONE
planted 401 row of exactly 1 RON (R-D4: a divisor that is rounding, not a
capital structure), and — added in the B8 repair round because two rows
of the law matched no book — `saga_compact_6_col` with one planted 1621
row of 1,000 (R-D1's debt leg: debt > 0, interest 0, EBIT > 0 declares
NO rung), `synthetic_negative_equity` (invested capital not positive:
ROIC refuses) and `saga_compact_6_col` with its REVISION-1 rows persisted
(X4 1500 / Z'' 1584.89 / composite 88.5: withdrawn as filed, by name and
value — the fourth law, `AS_FILED_LAW`).

**Reds on, after the repair (TC-11):** a zero-liability book (or the 1-RON
book) serving any Altman figure, a liquidity score or a composite; a
composite or letter beside a refused component; a sub-score outside
[0, 100]; X1 above 1, X4 above 1 / share, Z'' above the bound derived from
the component bounds with the book's own X2 and X3; a refused score with
no reason or a reason outside the law's vocabulary; ROIC served with
invested capital <= 0; the composite envelope disagreeing with the
ratio-table credit block; fewer than five scoring books (non-vacuity).

**What it cannot see (TC-13):** whether an in-range value is the RIGHT
value (ratio-credit-model's golden), the FE reader (creditRefusedSubscores
in vitest re-checks the range there), any book outside these eight.

**GREEN** — exit `0`: `28 passed in 3.25s`.

**PLANT A** — `credit_model.py`: `tl_material` forced true and X4 back on
`max(ops["total_liab"], 1)` (the revision-1 divisor). **RED** — exit `1`,
`1 failed, 27 passed`: only the 1-RON gate trips, because the model's own
range check withholds the exploded X4 (`credit_out_of_range` where the law
demands `total_liabilities_below_materiality`):

```
FAILED tests/engine/test_served_range.py::test_one_ron_of_liabilities_is_not_a_capital_structure
E   AssertionError: assert 'credit_out_of_range' == 'total_liabil...w_materiality'
```

**PLANT A3** — Plant A plus the model's Altman range check off
(`bad = None`) plus the served block's re-check off
(`_served_out_of_range` returning `{}`): three independent guards down, so
the zero-liability book RENDERS an Altman value. **RED** — exit `1`,
`5 failed, 23 passed`:

```
FAILED ...::test_every_served_credit_score_is_inside_the_law_or_refused_with_a_reason[imbalance_03pct]
FAILED ...::test_every_served_credit_score_is_inside_the_law_or_refused_with_a_reason[synthetic_thin_equity]
FAILED ...::test_every_served_credit_score_is_inside_the_law_or_refused_with_a_reason[thin_plus_1_ron]
FAILED ...::test_the_zero_liability_books_refuse_altman_liquidity_the_composite_and_the_letter
FAILED ...::test_one_ron_of_liabilities_is_not_a_capital_structure
E   AssertionError: imbalance_03pct credit_subscore_altman (subscores.altman): served 100.0 outside its domain (absent is never a value)
```

**PLANT B** — `credit_model.py`: the coverage refusal removed and the
revision-1 sentinel restored (`ic = (operating_profit / interest) if
interest > 0 else 999`). **RED** — exit `1`, `3 failed, 25 passed`:

```
E   AssertionError: imbalance_03pct credit_subscore_coverage (subscores.coverage): served 95.0 outside its domain (absent is never a value)
E   AssertionError: synthetic_thin_equity credit_subscore_coverage (subscores.coverage): served 95.0 outside its domain (absent is never a value)
```

**REVERT** — exit `0`: `28 passed in 3.23s`. Verdict: proven RED. The gate
is independent of all three product-side guards: with every one of them
down it still reds, and with one of them up it reds on the refusal code.

**REPAIR-ROUND PLANTS (B8 verifier, 2026-09-19)** — over the widened
eleven books (`51 passed` clean before each), each reverted:

**SR-A** — `credit_model.py`: the as-filed withdrawal off (`filed_bad =
{}`). **RED** — `2 failed`:
```
E   AssertionError: compact_filed_rev1 altman_z_score (as_filed.altman_z): filed 1584.89 reprinted outside [-inf, 114.88666666666667]
E   assert (1584.89 is None)
```

**SR-B** — `credit_model.py`: the R-D1 rung without `total_debt == 0`
(`if ops["interest_zero"] and ops["ebit"] > 0:`). **RED** — `2 failed`:
```
E   AssertionError: compact_ltd_1000 credit_subscore_coverage (subscores.coverage): served 95.0 outside its domain (absent is never a value)
E   assert {'coverage': ...'score': 90, ...}} == {}
```
(Before the widening this plant stayed GREEN on served-range; only the FE
fixture capture caught it, and that file was not in the credit gate.)

**SR-C** — `ratios/table.py`: the ROIC floor restored
(`_positive(_known(max(invested_capital.value or 0.0, 1.0)), ...)`).
**RED** — `2 failed`:
```
E   AssertionError: ('negative_equity', 'roic', {'code': 'negative_denominator', ...})
E   assert (-10080000.0 is None)
```
(Before the widening this plant stayed GREEN on served-range: no book had
invested capital <= 0.)

**REVERT** after each — `51 passed`. Verdict: proven RED.

## credit-boundary

THE CREDIT SERVING BOUNDARY (owner, 2026-09-20: "the credit range gate goes
at the serving boundary so no fallback can bypass it; plant a model-failure
path serving an exploded value -> RED"). Until this gate the range law was
held per path: `credit_block` on the switched path, `withhold_persisted` in
get_period's as-filed branch, `lawful_persisted_rows` in the narrator. Each
was correct and each was one fallback away from being skipped.
`engine.ratios.credit_boundary.enforce_credit_boundary(payload, surface=)`
is now the one function applied to the object a route returns:
GET /api/period, GET /api/period/{id}/comparatives, and the briefing
narrator's payload (`enforce_metric_rows`). It finds credit content BY SHAPE
(envelope, block, metric rows, comparatives rows) under any key, so a cache
or a future fallback is read against the pack ranges without registering
itself. The unswitched period's as-filed envelope is COMPOSED there: the
route hands over the persisted rows untouched and no longer reads a
credit-family value at all. It fails closed (a pack that cannot be read, or
an exception in the check, withholds the whole family).

| | |
|---|---|
| command | `python -m pytest tests/engine/test_credit_boundary.py -q` |
| work count | junit-xml, floor **32** tests (measured 35) |
| canary | `test_a_model_failure_path_serves_no_exploded_figure_no_zone_and_no_letter`, `test_with_the_boundary_bypassed_the_failure_path_serves_the_exploded_value`, `test_the_independent_law_holds_on_every_surface_of_every_path`, `test_the_comparatives_prior_serves_no_exploded_figure`, `test_the_narrator_payload_passes_the_boundary`, `test_the_boundary_fails_closed`, `test_every_credit_reader_in_the_api_layer_is_behind_the_boundary` |

What is real: `engine.api.create_app()` over the tenancy double with an
ES256 bearer; `saga_compact_6_col` carried through the production write
seam with its revision-1 rows persisted (X4 1500 / Z'' 1584.89 / composite
88.5 AA, measured 2026-09-14) beside a healthy agras period. The model is
broken at three seams the route has a fallback for:
`credit_model.compute_period_metrics` raises, `table.serve_time_metric_rows`
returns None, `table.build_ratio_table` raises.

**PLANT (RED first), 2026-09-20.** The route's return replaced by
`return _period_body  # PLANT: boundary bypassed`:

```
FAILED test_credit_boundary.py::test_a_model_failure_path_serves_no_exploded_figure_no_zone_and_no_letter[build_ratio_table raises]
FAILED ...[compute_period_metrics raises]
FAILED ...[serve_time_metric_rows returns None]
FAILED test_credit_boundary.py::test_the_switched_path_serves_the_filed_figures_only_as_withheld_records
FAILED test_credit_boundary.py::test_every_credit_reader_in_the_api_layer_is_behind_the_boundary
FAILED test_served_range.py::test_the_unswitched_path_serves_no_persisted_figure_outside_the_law[...] (x5)
FAILED test_served_range.py::test_a_planted_persisted_altman_of_1584_89_never_renders_on_an_unswitched_period
FAILED test_served_range.py::test_the_comparatives_prior_inherits_the_law_on_an_unswitched_prior
E   AssertionError: compute_period_metrics raises: the exploded figure 1584.89 is served as a figure
E   AssertionError: switched: the exploded figure 1584.89 is served as a figure
15 failed, 70 passed
```

REVERT (the saved pipeline.py copied back, `git diff` clean of the plant):
35 passed, and test_served_range 61 passed. The same plant is kept IN
the suite: `test_with_the_boundary_bypassed_...` replaces the boundary with
the identity and asserts the route then serves 1584.89 / 1500.0 / 88.5 -
the day that stops being true the route has a second authority and the gate
above no longer measures the boundary.

**What the independent law found on its first run (a live defect, not a
plant).** `served_range_law.served_figures` reads every surface of a body;
on the SWITCHED path it redded on
`credit_metrics_as_filed[] serves credit_subscore_liquidity = 0.0 outside
the law (domain False)` - and the same list served Z'' 1584.89 and X4 1500
verbatim on every analysed zero-liability period. The boundary now holds
those rows to the whole law over the period's statements and serves a
failing row as a record (`value: null, withheld: {code, inputs, value,
text}`); `build_ratio_table` reads the record back as as-filed EVIDENCE, so
the comparatives' `as_filed` disclosure is unchanged.

REDS ON, after the repair (TC-11): any exploded figure, a zone beside no
Z'' or a letter beside no composite on any surface of the period body, the
comparatives body or the narrator payload, healthy or with the model
broken; a withheld body that does not say `credit_out_of_range`; a new file
under `src/engine/api` that names a credit-family figure; the route reading
the persisted credit rows itself again. CANNOT SEE (TC-13): whether an
in-range figure is the right figure (ratio-credit-model); the domain half
of the law where a payload carries no statements (comparatives rows, a
cached envelope: range, finiteness and dependents only); the comparatives
route under a RAISING model - it has no fallback and answers 500, which the
gate pins as "500, or 200 without the figure"; the FE reader
(creditRefusedSubscores.test.tsx); Capsule tools and exports serve no
credit figure from the engine today (the census test reds the day one
does).

## floor-census

THE FLOOR CENSUS, engine half (owner rule 2026-09-15 / 2026-09-18: absent
is never zero and never a floor). Measured before the repair:
`max(total_liabilities, 1)` served X4 1500.0 and Z'' 1584.89 on a book
with no liabilities; the `999` sentinel scored coverage 95 on a book with
no interest and no EBIT; ROIC over a 1-RON floor printed 1,299,072,170.8 %.
A stdlib-`ast` census over an explicit, printed 14-file scope
(`scripts/check_floor_census.py`, scope from the floor sweep's
`synth.census_gate`) for the eight substitute classes — S1 divisor floor,
S2 or-floor, S3 sentinel-on-undefined, S4 epsilon swap, S5 helper floor,
S6 none-to-constant, S7 domain replacement, S8 constant period — plus the
soft CLAMP class and the OR_ZERO ratchet. Denominator reach is computed
inside each function (direct, through a local, inside a denominator
expression, or as the denominator argument of a registered division
helper).

| | |
|---|---|
| command | `python scripts/check_floor_census.py` |
| work count | `GATE-WORK floor-census units=(\d+)`, floor **100** candidate sites (measured 131 over 14 files) |
| canary | `self-test S1 DIVISOR_FLOOR`, `self-test S8 CONSTANT_PERIOD`, `credit   src/engine/ratios/credit_model.py`, `credit tier clean` |

Two tiers, printed on every run. The CREDIT TIER (credit_model.py,
credit_pack.py, ratios/table.py, comparatives/ratio_compare.py) is RED on
any S1-S7 or CLAMP site without an allow-list entry
(`scripts/floor_census_allowlist.json`: 14 entries — the 13 band
saturations of the documented 0-100 piecewise map, each naming its domain
guard by CODE TEXT, and the Decimal precision context in
`quantize_display`). The RATCHET TIER (the other ten files, and S8 /
OR_ZERO everywhere) holds every (file, class) count to
`scripts/floor_census_baseline.json` and reds when a count moves in
EITHER direction — a baseline left stale would hide the next regression
back up to the old count. A self-test over
`tests/engine/fixtures/floor_census/substitutes.py` (one verbatim pre-fix
instance per class) runs first; a class going undetected is DISCOVERY
BROKEN (exit 2), as is a missing scope file.

**Reds on, after the repair (TC-11):** `max(total_liab, 1)` back in
credit_model.py; a `999` sentinel back on coverage; an unlisted clamp in
the credit tier; a stale allow-list row (its code no longer matches, its
guard text gone from the file, or its legitimacy outside the vocabulary);
any ratchet row rising or falling without its baseline; any of the eight
classes going undetected on the fixture.

**What it cannot see (TC-13):** a floor written as arithmetic (`x + 1` as
a divisor), a literal fed through a name defined in another function, the
FE half (a TypeScript census, not yet built), anything outside the printed
scope.

**GREEN** — exit `0`:
`PASS floor-census — 131 candidate site(s) over 14 files; credit tier clean; ratchet held.`

**PLANT A** — `credit_model.py`: X4 back on `max(ops["total_liab"], 1)`.
**RED** — exit `1`:

```
GATE-WORK floor-census units=132 label=candidate-sites scope=14 files credit_tier=4 ratchet_tier=10
FAIL floor-census — 1 problem(s):
  FLOOR in the credit tier: src/engine/ratios/credit_model.py:825 [S1 DIVISOR_FLOOR] in compute_period_metrics: max(ops['total_liab'], 1)
```

**PLANT B** — the coverage `999` sentinel restored. **RED** — exit `1`:

```
  FLOOR in the credit tier: src/engine/ratios/credit_model.py:899 [S3 SENTINEL_ON_UNDEFINED] in compute_period_metrics: operating_profit / interest if interest > 0 else 999
```

**PLANT C** — a new `x / max(total_assets, 1)` appended to
`src/engine/api/_valuation.py` (ratchet tier). **RED** — exit `1`:

```
FAIL floor-census — 1 problem(s):
  ratchet: src/engine/api/_valuation.py [S1 DIVISOR_FLOOR] rose 1 -> 2 (a new floor)
```

**REVERT** — exit `0`:
`PASS floor-census — 131 candidate site(s) over 14 files; credit tier clean; ratchet held.`
Verdict: proven RED.

## ratio-byte-match

The owner's brief as one assertion: every ratio's six cells — [current]
[prior] [change] [band now] [band prior] [band movement] — print the same
bytes on the dashboard Ratios tab, in the exported report and in the
workbook Ratios sheet, and the improved / deteriorated lists carry the same
order and cells on the tab, in the report's executive summary and in the
workbook's Band movements block (batch B8). B6 (the tab) and B7 (the
exports) were built on sibling branches; each held its own surfaces to a
handle named `data-ratio-cmp-json` with DIFFERENT contents, and a turns row's
change printed `+0.28x` over `+15.4%` on the tab and `+0.28x (+15.4%)` in
the report. Every per-surface gate was green. On the merged state before the
fix (225e48f) this gate was `68 failed, 2 passed`.

The fixture is `pair_served.json` — the agras corpus book's real GET
/api/period body and the comparatives document for agras against carniprod,
rebuilt from the committed corpus by `scripts/capture_comparatives_pair.py`
(`--check` for freshness; comparatives-route holds it equal to what the
route serves) — plus the same pair with the prior blocking sector bands. No
Scandia data (ruling Q10). The surfaces are fed through `ratioSurfacesOf`,
the page's own join.

| | |
|---|---|
| command | `npx vitest run --root . frontend/lib/__tests__/ratioTableByteMatch.test.tsx --reporter=verbose` |
| work count | stdout `Tests N passed`, floor **120** (measured 144: 2 documents x (31 rows x {six cells, name} + non-vacuity + handles + headings + 2 lists) + the 10 B6 source-gate tests) |
| canary | `B4 non-vacuity: every census row and composite is compared`, `B1/B2 altman_z: the tab, the report and the workbook print the same six cells`, `B3 the deteriorated list: the served order and the same cells`, `B5 altman_z: the same name beside the six cells`, `B5 the six column headings are one string`, `B6 non-vacuity: every named path is extracted whole and is the real served-row path` |

**Reds on, after the repair (TC-11):** any census row or composite whose six
cells differ by one byte between the tab table, the report (card table,
served-only row, every element embedding the row) and the workbook; a
surface's `data-ratio-cmp-json` that is not the served row serialised, or a
row absent from a surface; a blank or dash cell; the lists in another order
or with other cells on any of the three; fewer than every served row
compared, no turns row with its percent, no refused prior, no numeric prior
Altman, an empty list; **B5 (2026-09-19)** the NAME beside the six cells, or
any of the six headings, differing by one byte between the three surfaces,
or the tab's name not being the i18n label `ratioLabelForKey` prints, or a
heading not its i18n word (the B8 verifier's 31 mismatched rows: "Current
Ratio" / "Current ratio", "Δ" / "Change", "Band now" / "Band, 2025-12-31";
one label authority: `statements.ratioCmp.label.<key>`, resolved by the
report's `row()` helper into `Ratio.label` so the cover line, rail, charts,
cards and workbook move together, and by `altmanLabelOf` for the credit
reader); **B6 (2026-09-19, the export-side source gate)** browser
arithmetic on a served value inside the export paths that print the six
cells — `financialExports.ts` `sixCells` and its Band-movements region,
`financialReport.ts` `ratioCmpCells` / `ratioCmpCardTable` /
`servedOnlyRatioTable` / `bandMovementsBlock` / `ratioCmpBasisClause` /
`creditMovementBlock`, `executiveSummary.ts` `buildBandMovements` — each
body extracted by balanced braces from comment/string-blanked source and
scanned for `toFixed`, `toPrecision`, `Math.*`, `parseFloat`, `parseInt`,
`Number(`, unary `+`, `Intl.NumberFormat`, `toLocaleString` or an operator
on `.value` / `.value_q`; a named path renamed or inlined out of the scan
(the B8 verifier's plant A8: a same-bytes recompute that every byte gate
passed). **Cannot see:** the one formatter printing a figure
wrongly on every surface at once (ratioTableFormat.test.ts owns that); the
Romanian tab (the exports print English); the PDF; the live route
(comparatives-route).

**GREEN** — `PASS ratio-byte-match (2.5s, 70 row x surface comparisons)`.

**PLANT** — one rounding on ONE surface each, applied, run, reverted:

| plant | surface | red |
|---|---|---|
| `frontend/lib/financialExports.ts` `sixCells`: a days row's current printed `toFixed(1)` | workbook | `FAIL ratio-byte-match (exit 1, 2.4s)`, battery record `work_units 62` (`8 failed, 62 passed`) |
| `frontend/lib/ratioCompareView.ts` `printRatioRow`: a pct row's current printed `toFixed(0)` | tab | `22 failed, 48 passed` |
| `frontend/lib/financialReport.ts` `ratioCmpCardTable`: the prior cell cut to one decimal | report | `14 failed, 56 passed` |

**RED** — excerpts, one per plant:

```
→ dso: the workbook's six cells differ from the tab's: expected [ '26.0 days', '40 days', …(4) ] to deeply equal [ '26 days', '40 days', …(4) ]
→ roe: the report's six cells differ from the tab's: expected [ '31.5%', '1.3%', '+30.2 pp', …(3) ] to deeply equal [ '32%', '1.3%', '+30.2 pp', …(3) ]
→ roic: report summary vs tab list: expected [ '4.6%', '47.1%', '+42.5 pp', …(1) ] to deeply equal [ '4.6%', '47%', '+42.5 pp', …(1) ]
→ current_ratio: the report's six cells differ from the tab's: expected [ '2.10×', '1.8×', …(4) ] to deeply equal [ '2.10×', '1.82×', …(4) ]
→ altman_z: the report's six cells differ from the tab's: expected [ '7.31', '6.6', '+0.69', …(3) ] to deeply equal [ '7.31', '6.62', '+0.69', …(3) ]
```

**PLANT (B5, 2026-09-19)** — applied, run, reverted (134 passed after each):

| plant | red |
|---|---|
| `financialReport.ts` `row()`: `const label = fallbackLabel` (the card keeps its own words) | `current_ratio: no single row in the workbook Ratios sheet: expected undefined to be defined` (B1/B2, 22 rows) plus B5 `the report's name differs from the tab's` |
| `financialValuation.ts` `altmanLabelOf`: `return fallback` (the reader spells `Altman Z"-Score`) | `altman_z: the report's name differs from the tab's: expected 'Altman Z"-Score' to be 'Altman Z″'` |
| `financialExports.ts` `cmpHeadings`: `"Δ", "Band now", …` spelled by hand | `B5 the six column headings …: expected [ 'Dec 2025', 'Dec 2024', 'Δ', …(3) ] to deeply equal [ 'Dec 2025', 'Dec 2024', …(4) ]` |

The tile and the drawer are held to the table's one joined change cell by
`ratioCompareTab.test.tsx` G13 (plant: the tile prints the percent as a
second string → `current_ratio: the tile's change is not the table's one
cell: expected '+0.28×+15.4%' to be '+0.28× (+15.4%)'`; the same on the
drawer; reverted, 1 passed).

**PLANT (B6, 2026-09-19)** — applied, run, reverted (144 passed after each):

| plant | red |
|---|---|
| `financialExports.ts` `sixCells`: the pp change recomputed as `Number(current.value_q) − Number(prior.value_q)` printed `toFixed(1)` — the SAME bytes as the served cell (verifier plant A8; B1–B5 stay green) | `1 failed \| 143 passed`: `B6 financialExports.ts sixCells parses, rounds, formats and operates on no number` — `browser arithmetic on a served value — /\.toFixed\(/ matched ".toFixed("` |
| `financialReport.ts` `ratioCmpCardTable`: the prior cell re-rounded from `row.prior.value` with `Math.round(x * 100) / 100` | B6 (`-t B6`): `financialReport.ts ratioCmpCardTable … /\bMath\.\w+\(/ matched "Math.round("`; and, unfiltered, B1/B2 on 22 rows (`current_ratio: … expected [ '2.10×', '1.82', …] to deeply equal [ '2.10×', '1.82×', …]`) because this plant also moved the bytes |

**REVERT** — `Tests 70 passed (70)` after each of the first plants,
`144 passed (144)` after the B5 and B6 plants; no `# PLANT` marker left.
Verdict: proven RED.

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

## floor-valuation

Floor substitutes, batch C3 of the 2026-09-15 sweep (owner rulings R-D5,
R-D6, R-OTHER): the valuation DCF, `POST /api/period/{id}/valuation/
recompute`, the AI briefing's citable ratio block, the RO pack's ROA check
and the served period day count. Every defect it covers served a believable
number built on a figure the book never yielded — book equity floored at
1 RON (an insolvent book valued 2.5x the same book at +5M equity), a 5%
cost of debt that overrode a measured 2% rate, an effective tax rate clamped
into [0, 25%], a base FCF floored at 0 (EV exactly 0 and equity = −net debt
served as a valuation on three corpus books), a WACC nudged to g + 0.5%
(terminal_growth 0.2 served EV 692.6M), an operating EBITDA of zero divided
as 1e-9 (Debt/EBITDA 2e15x handed to the model), margins of 0.00% on no
revenue, ROA graded FAIL at an invented 0.00% on a zero asset base, and a
hard-coded `periodDays: 365` at both served-rebuild seams (a June
year-to-date book's DSO / DIO / DPO at 365/181 times their value). Each is
now a stated refusal (`{code, inputs, text}`, the text is the sentence the
page shows) or a DECLARED assumption served with its source and range,
rendered from pack data (`country_packs/ro_romania/parameters.py`, TC-10).

| | |
|---|---|
| command | `python -m pytest tests/engine/test_floor_dcf.py tests/engine/test_floor_period_days.py tests/engine/test_floor_briefing_ratios.py -q` |
| work count | junit-xml, floor **54** tests (measured 59: 37 DCF / wiring / recompute / valuation-assumptions, 16 period days / ROA of which 1 is a strict xfail, 6 briefing ratios; the recompute, valuation-assumptions, period-days and stage_narrate tests run over the REAL router and the real `stage_narrate` on corpus books through the anchor test's projection-faithful double — no network, no paid call) |
| canary | `test_dcf_refuses_when_book_equity_is_not_positive`, `test_a_measured_implied_cost_of_debt_is_used_even_below_the_old_floor`, `test_recompute_answers_400_on_an_out_of_domain_override`, `test_a_31_december_corpus_book_serves_exactly_the_bytes_it_served_before`, `test_stage_narrate_hands_the_model_refusals_not_fabricated_ratios` |

**Reds on, after the repair (TC-11):** a non-positive or absent equity, a
negative debt, a non-positive base FCF, an absent FCF input, or a WACC at or
below g ever yielding an enterprise value, an equity value or a sensitivity
band again (every refusal asserts the values are None, never 0 and never
−net debt); a measured implied cost of debt (2% on the skeptic's book)
serving the same Kd and EV as an absent one; an unmeasurable Kd served as a
number without `kd_source: methodology_assumption`, the range from
`METHODOLOGY_KD_AFTER_TAX_RANGE` rendered in `kd_note`, or 5% on a book with
no debt; an effective tax rate of 55%, a negative one, one on a pre-tax loss
or an absent one served as anything but the statutory rate with its bound in
the label, or an in-range one (12.5%) not used; a WC-approximated book whose
DCF text or tiles do not say so, or whose numbers move because of the label;
the recompute endpoint computing (200) at `forecast_years` 0 or 2.5,
`terminal_growth` 0.2 or `rf` NaN instead of answering 400 with the domain
sentence, or answering anything but 200 with a computed DCF at in-domain
overrides on corpus agras; a 31 December corpus book serving anything but
exactly `{"periodDays": 365}` and the DSO operand `{"period_days": 365.0,
"source": "supplementary.periodDays"}` (the corpus regression); a June book
serving 365 or a DSO other than 181/365 of December's; a `fallback_today`
filing serving any day count or no `periodDaysRefusal`; the assembler
claiming a length it was not given; ROA on a zero or negative asset base
graded pass or fail, or counted in the score; a positive asset base graded
differently than before; a zero or absent EBITDA or revenue reaching the
briefing model as a numeral `facts_from_briefing` would let it cite, or the
Scandia-figure ratio block changing by a cent.

Repair round (2026-09-19), also reds on: the `compute_valuation` WIRING —
the layer every served / recompute path calls — re-flooring an absent
equity, debt, cash or working-capital change before the DCF sees it
(statements with the key REMOVED, asserted at the served envelope, so the
`_dcf_cross_check` tests can no longer stay green over a floor one layer
up); a net income BUILT from `pretax - tax` when either is unreported (the
same envelope declaring "tax expense not reported" and serving an NI that
read the tax as 0); a nil interest charge on positive debt served as a 0%
Kd, or as the methodology range without the ruling sentence from
`METHODOLOGY_KD_ZERO_INTEREST_RULING` on `kd_note`; an absent total debt or
cash reaching the briefing block as `debt_to_ebitda 0.0` / `debt_to_equity
0.0` / `net_debt 0.0` (or an explicit None raising TypeError); PUT or DELETE
`/api/period/{id}/valuation-assumptions` persisting a valuations row without
the DCF the GET path serves for the same period (the bucket-only rebuild).
STRICT XFAIL, not a red: the DSO row of a `fallback_today` book still
carries a value multiplied by `constant.period_days_default` — lane 1 owns
`src/engine/ratios/table.py`; the marker turns red the day it refuses and is
removed then.

**GREEN** — exit `0`:

```
tests/engine/test_floor_dcf.py .............................
tests/engine/test_floor_period_days.py ...............
tests/engine/test_floor_briefing_ratios.py .....
49 passed in 2.18s
```

**PLANT 1 (C3)** — `src/engine/api/_valuation.py`: the shipped
`equity_book = max(total_equity, 1.0)` restored (`elif total_equity <= 0`
made unreachable; `wd = total_debt / (total_debt + max(total_equity, 1.0))`).

**RED** — exit `1`, `2 failed` (both parametrisations of the canary):

```
    assert _codes(d) == ["dcf_equity_not_positive"]
E   AssertionError: assert [] == ['dcf_equity_not_positive']
E     Right contains one more item: 'dcf_equity_not_positive'
FAILED tests/engine/test_floor_dcf.py::test_dcf_refuses_when_book_equity_is_not_positive[-5000000.0]
FAILED tests/engine/test_floor_dcf.py::test_dcf_refuses_when_book_equity_is_not_positive[0.0]
```

**REVERT** — the refusal branch restored; `49 passed in 2.18s`, exit `0`.

**PLANT 2 (C4)** — `src/engine/api/pipeline.py::_briefing_ratios`: the
shipped `round(total_debt / (ebitda or 1e-9), 2)` restored in place of the
refusal.

**RED** — exit `1`, `3 failed`:

```
    assert ratios[key] is None and refusals[key]
E   assert (2000000000000000.0 is None)
    assert ratios[key] is None and refusals[key]
E   assert (-0.0 is None)
    assert facts["ratios"][key] is None, (key, facts["ratios"][key])
E   AssertionError: ('debt_to_ebitda', 0.0)
FAILED tests/engine/test_floor_briefing_ratios.py::test_briefing_ratios_refuse_instead_of_substituting[pl0-bs0-expect_none0]
FAILED tests/engine/test_floor_briefing_ratios.py::test_briefing_ratios_refuse_instead_of_substituting[pl1-bs1-expect_none1]
FAILED tests/engine/test_floor_briefing_ratios.py::test_briefing_ratios_refuse_instead_of_substituting[pl2-bs2-expect_none2]
```

**REVERT** — the refusal restored; `49 passed`, exit `0`.

**PLANT 3 (C5)** — `src/engine/api/pipeline.py::_served_supplementary`: the
shipped `return {"periodDays": 365}` placeholder restored at the served seam.

**RED** — exit `1`, `2 failed`:

```
    assert june["statements"]["supplementary"] == {"periodDays": 181}
E   AssertionError: assert {'periodDays': 365} == {'periodDays': 181}
    assert sup["periodDays"] is None
E   assert 365 is None
FAILED tests/engine/test_floor_period_days.py::test_a_june_year_to_date_book_serves_its_true_day_count
FAILED tests/engine/test_floor_period_days.py::test_a_fallback_filed_period_serves_no_day_count_and_says_why
```

**REVERT** — `_served_supplementary` reads the period again; `49 passed`,
exit `0` (the 31 December corpus book still serves exactly
`{"periodDays": 365}`).

**PLANT 4 (C3, wiring — P5b)** — `src/engine/api/_valuation.py::compute_valuation`:
`dcf_cash = _first(..., 0.0)`, legacy debt `else 0.0`, legacy equity
`else 1.0` — the re-floor one layer above `_dcf_cross_check` that left the
first 49 tests green.

**RED** — exit `1`, `3 failed`:

```
E   assert [] == ['dcf_equity_absent']
E   assert [] == ['dcf_debt_absent']
E   assert [] == ['dcf_cash_absent']
FAILED tests/engine/test_floor_dcf.py::test_compute_valuation_refuses_an_absent_balance_or_wc_input[assembled_bs.total_equity-dcf_equity_absent]
FAILED tests/engine/test_floor_dcf.py::test_compute_valuation_refuses_an_absent_balance_or_wc_input[assembled_bs.total_debt-dcf_debt_absent]
FAILED tests/engine/test_floor_dcf.py::test_compute_valuation_refuses_an_absent_balance_or_wc_input[assembled_bs.cash-dcf_cash_absent]
3 failed, 55 passed, 1 xfailed
```

**REVERT** — restored; `58 passed, 1 xfailed`, exit `0`.

**PLANT 5 (C3, wiring — P5c)** — `dcf_net_wc_change = _first(cf_canonical.get("net_wc_change"), 0.0)`.

**RED** — exit `1`, `1 failed`:

```
E   assert [] == ['dcf_fcf_input_absent']
FAILED tests/engine/test_floor_dcf.py::test_compute_valuation_refuses_an_absent_balance_or_wc_input[assembled_cf.net_wc_change-dcf_fcf_input_absent]
1 failed, 57 passed, 1 xfailed
```

**REVERT** — restored; `58 passed, 1 xfailed`, exit `0`.

**PLANT 6 (C3, wiring — net income from an absent tax)** — the shipped
`dcf_net_income = _first(pl_canonical.get("net_income_statutory"), pretax - tax)`
with `pretax` / `tax` `_safe`d, and `pretax=pretax` handed to the DCF.

**RED** — exit `1`, `1 failed`:

```
E   AssertionError: assert [] == ['dcf_fcf_input_absent']
FAILED tests/engine/test_floor_dcf.py::test_compute_valuation_never_builds_net_income_from_an_absent_tax
1 failed, 57 passed, 1 xfailed
```

**REVERT** — restored; `58 passed, 1 xfailed`, exit `0`.

**PLANT 7 (C3 — Kd on a nil interest charge)** — `_cost_of_debt_for_dcf`:
the `interest_expense == 0` note without the ruling sentence.

**RED** — exit `1`, `1 failed`:

```
E   AssertionError: assert 'a nil interest charge on interest-bearing debt is read as an unstated cost of debt (shareholder loan, capitalised or reclassified interest), not as a measured 0%' in 'The book carries 10.00M RON of debt but no interest expense (class 666) is booked, so its cost of debt cannot be meas...'
FAILED tests/engine/test_floor_dcf.py::test_a_nil_interest_charge_on_positive_debt_is_the_declared_range_not_a_measured_zero
1 failed, 57 passed, 1 xfailed
```

**REVERT** — restored; `58 passed, 1 xfailed`, exit `0`.

**PLANT 8 (C4 — absent debt / cash)** — `pipeline.py::_briefing_ratios`:
`total_debt = bs_canonical.get("total_debt", 0.0)` / `cash_val = bs_canonical.get("cash", 0.0)` restored.

**RED** — exit `1`, `1 failed`:

```
E   AssertionError: ({}, 'debt_to_ebitda', {'debt_to_ebitda': 0.0, 'debt_to_equity': 0.0, 'ebitda_margin_pct': 10.0, 'net_debt': 0.0, ...})
E   assert 0.0 is None
FAILED tests/engine/test_floor_briefing_ratios.py::test_briefing_ratios_refuse_an_absent_debt_or_cash_instead_of_reading_zero
1 failed, 57 passed, 1 xfailed
```

**REVERT** — restored; `58 passed, 1 xfailed`, exit `0`.

**PLANT 9 (C3 — the sibling routes)** — PUT / DELETE
`/api/period/{id}/valuation-assumptions` back on the bucket-only
`_rebuild_assembled(line_items, period)`.

**RED** — exit `1`, `2 failed`:

```
E   AssertionError: {'cash_used': 1168047.04, 'confidence': 'low', 'dcf_enterprise_value': None, 'dcf_equity_value': None, ...}
E   assert (None is not None)
FAILED tests/engine/test_floor_dcf.py::test_saving_or_resetting_assumptions_persists_the_dcf_the_get_path_serves[put]
FAILED tests/engine/test_floor_dcf.py::test_saving_or_resetting_assumptions_persists_the_dcf_the_get_path_serves[delete]
2 failed, 56 passed, 1 xfailed
```

**REVERT** — restored; `58 passed, 1 xfailed`, exit `0`.

**Measured blast radius** (GET /api/period over the six RO corpus books
through the real router, main → this batch; `scripts` scratch
`blast_radius_served.py`): `saga_10_col`, `saga_10_col_realestate` and
`imbalance_03pct` had DCF EV 0.0 and equity −31.7M / −17.4M / +1.0M
(= −net debt) served as a valuation — now `enterprise_value`,
`equity_value` and both sensitivities are null with
`dcf_base_fcf_not_positive` in `cross_checks.dcf.refusals` and
`method_warnings`; `fcf_breakdown.stabilized_fcf` 0.0 → −301,904.65 /
−4,017,685.40 (signed). WACC 6.46% → 6.91% (`saga_10_col`: effective tax
55.2% → statutory 16% labelled, was clamped to 25%) and 11.73% → 11.41%
(`realestate`: pre-tax loss → statutory 16% labelled, was 0%); both Kd
implied (6.16% / 6.24%) and unchanged. `saga_10_col_agras`,
`saga_10_col_carniprod`, `saga_10_col_retail`: byte-identical (Kd above the
old floor, effective tax in range, positive base FCF). `statements.
supplementary` identical (`{"periodDays": 365}`) on all six.
`measure_bs_drift.py` GREEN on all seven fixtures (Scandia 0.00);
`check_assembled_parity.py` RED on inventory leaves identically on main
(pre-existing, untouched here); `check_cross_view_consistency.py`: the DCF
gates 18 / 19 / 19b pass, the two failures (BS balance 2,827,483.85; the
`risk_inventory_leverage` EBITDA citation) are identical on main.

**Repair round, measured blast radius (2026-09-19; the same probe, main →
branch tip, six corpus books):** the served GET /api/period envelope
changes are EXACTLY the paragraph above — this round adds none on the
canonical path. The DCF wiring change is latent there (`assemble_statements`
always emits `pretax`, `tax` and `net_income_statutory`); the Kd ruling
changes only `kd_note` on a book with positive debt and a nil class-666
charge, and no corpus book is one (measured on the write-seam statements:
`kd_source` implied on saga_10_col / agras / realestate / retail,
`not_applicable_no_debt` on carniprod / imbalance_03pct). Outside the six:
(a) a **leap-year** book — an established FY2024 period (period_end
2024-12-31 with a real signal) serves `periodDays 366`
(`(end - fy_start).days + 1`), was 365, so DSO / DIO / DPO move by 1/365 on
every FY2024 book; correct, and the earlier "no RO period with an
established length changes" was wrong for those. (b) The **persisted
`valuations` row** written by PUT / DELETE `/valuation-assumptions` now
carries the DCF the GET path serves (agras / carniprod / retail: an EV;
saga_10_col / realestate / imbalance_03pct: the same
`dcf_base_fcf_not_positive` refusal as GET) — before, every save / reset
persisted `dcf_fcf_input_absent`; the FE reads only `res.ok`, so no page
changed. (c) The **Valuation tab equity tile** on the three refused books
renders the engine's refusal sentence (`data-testid="dcf-equity-refused"`)
instead of the FE `runDcf` figure (−31.7M / −17.4M / +1.0M = −net debt) it
fell through to beside a `method_warnings` line saying the DCF was not
computed. (d) The **Statements page day-count ratios** on a period whose
length is not established — a `fallback_today` filing, or any row persisted
before 2026-08-30 (`c568098` first stamped `period_detection`;
`stage_persist` wrote `period_start == period_end`) — now REFUSE DSO / DIO /
DPO / CCC ("Not reported — this filing does not carry the period's day
count"); the page used to fall back to the engine's `metrics.dso` etc.,
multiplied by `constant.period_days_default`. Established periods (every
31 December corpus book: `periodDays 365`) print byte-identical values and
captions (G4 `exportRatioFormulas` and F2 `ratioRefusal` green; G4 no
longer carries its own `?? 365`). The FE fixture harnesses
(`exportBooks.statementsFor`, `reportBooks.periodResponse`) render the
SERVED shape: the write-seam fixtures carry `periodDays: null` since
`b45739f`, and the harness joins the day count from the fixture's own
stated span exactly as `_served_supplementary` does — the same join it
already made for `canonical_bs`, never a `?? 365` (with the card's floor
gone, 19 vitest gates over the four firm books had started printing "not
established" on periods that ARE established).

**UNDONE — C5 end-to-end (lane 1):** the engine's own ratio table on the
same GET response still serves DSO at 365 under
`constant.period_days_default` (`src/engine/ratios/table.py:628`, lane 1)
and DIO / DPO from `metrics.*` beside `supplementary.periodDaysRefusal`;
`periodDaysRefusal` has no consumer in the engine. The batch's page is
honest because the FE no longer reads those rows when the day count is
absent; the API row is not, and exports or callers reading
`assembled_metrics.ratio_table` directly still get the substitute. Pinned
as a STRICT xfail (`test_the_dso_row_on_a_fallback_filed_period_carries_no_
value`) that turns red the day lane 1 refuses. Blast radius when it lands:
every pre-2026-08-30 persisted row and every `fallback_today` filing loses
its DSO / DIO / DPO / CCC values in the served ratio table (byte-identical
today only because of the constant).

**What it cannot see:** the FE's own client-side DCF
(`frontend/lib/financialValuation.ts` `runDcf`, sweep cluster C9) still
carries the 1 RON equity, 5% Kd, 0 FCF and g + 0.5% substitutes; the
Valuation tab's equity tile is now guarded by `cross_checks.dcf.refusals`
(empty or absent → it still renders `equity_value ?? dcf.equityValue`), but
the base-FCF / WACC line and the year table beside it are still the FE's
`runDcf` until C9 lands. The Piotroski half of C5.2 (cfo_positive /
cfo_gt_ni graded on the approximated CFO) is NOT in this batch: it changes
a lender-facing score on every single-period book and is held for its own
batch with a measurement.

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

## floor-public-score

Floor sweep cluster C6 (`wave/floor-c6-public-sku`, 2026-09-18). The public
risk and opportunity engines (`engine.public.intelligence.risk_scoring_engine`,
`opportunity_scoring_engine`) scored an ABSENT input as a number: a missing
financial read as a neutral 50, a missing market cap as 30, and the snapshot
boundary (`routes._financials_from_snapshot`) read percentage points as
fractions, so a 5% EBITDA margin took the best tier. Measured before the
repair: an unknown-sector ticker with no snapshot at all served 21/100
"low"; every one of the 291 offline universe rows (88 BVB seed + 203 NASDAQ
demo) served a composite. After: a category with an absent input is `null`
with `{code, component, inputs, text}`, the composite refuses when any
weighted category is absent, and the route serves the refusal sentence.

| | |
|---|---|
| command | `python -m pytest tests/engine/public/intelligence/test_risk_scoring_engine.py tests/engine/public/intelligence/test_opportunity_scoring_engine.py tests/engine/public/intelligence/test_public_score_refusal_route.py -q` |
| work count | junit-xml, floor **30** tests (measured 33) |
| canary | `test_no_financials_refuses_every_financial_category_and_the_composite`, `test_snapshot_boundary_converts_points_and_keeps_a_measured_zero`, `test_no_financials_refuses_instead_of_scoring_medium` |

**Reds on, after the repair (TC-11):** any risk or opportunity category
scoring an absent, NaN or non-positive-denominator input; a composite or
level minted while a weighted category is `null`; net debt over a
non-positive EBITDA read as net cash; a ratio crossing the snapshot boundary
without the points-to-fraction conversion, or a measured 0 turned into
"not reported" by an `or` chain; the per-ticker route serving a number
where the engine refused.

**GREEN** — exit `0`: `33 passed`.

**PLANT A** — `risk_scoring_engine.py` `_score_financial`: the refusal
replaced by the old neutral (`return 50, None  # neutral when unknown`).

**RED** — exit `1`:

```
tests/engine/public/intelligence/test_public_score_refusal_route.py:70: assert 50 is None
FAILED tests/engine/public/intelligence/test_risk_scoring_engine.py::test_no_financials_refuses_every_financial_category_and_the_composite
FAILED tests/engine/public/intelligence/test_public_score_refusal_route.py::test_per_ticker_risk_score_refuses_for_a_live_shaped_snapshot
```

**PLANT B** — `opportunity_scoring_engine.py` market position: absent
market cap scored 30 again (`return 30, None`).

**RED** — exit `1`:

```
E   AssertionError: ('market_position', [ScoreRefusal(code='opportunity_category_unavailable', component='financial_quality', ...)])
E   assert 0 == 1
```

**PLANT C** — `routes.py` `_points_to_fraction`: `return value` (no
conversion).

**RED** — exit `1`:

```
    assert fin["ebitda_margin"] == pytest.approx(0.3445)
E   assert 34.45 == 0.3445 ± 3.4e-07
```

**PLANT D** — `risk_scoring_engine.py`: the `ebitda <= 0` rejection of
net-debt/EBITDA disabled (`if False:`).

**RED** — exit `1`:

```
    assert score.categories.financial is None
E   AssertionError: assert 36 is None
E    +  where 36 = RiskCategoryScores(macro=65, supply_chain=66, geopolitical=40, financial=36, ...).financial
```

**REVERT** — all four restored; exit `0`, `33 passed`. Verdict: proven RED
four ways.

### floor-public-score — repair round (2026-09-19)

**The live keyed path is exactly as dark as the offline one — stated
plainly.** The 2026-09-18 entry above measured the 291 OFFLINE universe rows
and read as if a keyed deployment differed. It does not: the live producers
write `"revenueGrowth": None` for every row (`universe_service.py:484`,
`normalizer.py:337`) and never write `interestExpense`, so `_score_financial`
refuses on `interest_coverage` and `_score_operational` on `revenue_growth`
for every ticker on every deployment. **The composite risk score and
risk_level are null universe-wide in production until the producers carry
interest expense and revenue growth.** That is what the ruling mandates
(absent is never a neutral number), and it retires the composite risk
feature as a served figure. Measured on this branch against the main probe
(`wt-floor-c1-main-probe` @1f3ff4b) with the stated command
`PYTHONPATH=<tree>/src python scratchpad/c6_public_blast.py <tree> out.json`
(88 BVB seed + 203 NASDAQ demo rows, no keys):

| | main | branch |
|---|---|---|
| composite risk numeric | 291 / 291 | **0 / 291** |
| opportunity numeric | 291 / 291 | 174 / 291 |
| financial / operational / valuation category null | 0 / 0 / 0 | 291 / 101 / 107 |
| top_risks[] with a null `score_contribution` | 0 of 844 | 61 of 844 (61 tickers) |

**Owner ruling required before merge (open):** refuse (this branch) versus
*drop-with-redistribution-and-say-so* for the two inputs `interest_expense`
and `revenue_growth`. **Producer work, filed here as the ticket
`PT-PUBLIC-1`:** `universe_service.py` and `normalizer.py` carry
`interestExpense` (SF1 `intexp` / EDGAR `InterestExpense`) and
`revenueGrowth` (prior-period revenue), after which the financial and
operational categories measure again without any engine change.

The Risk tab (`RiskBreakdownPanel.tsx`) now renders the refusal: its types
were `number` (the FE could not see the null), so `null >= 25` minted "low"
with a 2 % bar on Financial / Operational for every ticker. Pinned by
`frontend/components/public-companies/__tests__/riskBreakdownRefusal.test.tsx`
(runs under the `vitest` battery gate's include glob): a null category
renders "unavailable" plus its refusal text, no bar, no level word, no digit;
a null composite renders the "overall" refusal, no "/ 100". `tsc --noEmit -p
tsconfig.app.json` reports 0 errors in touched files; its 10 errors are all
in `capsuleEmpty/capsuleAskGuard(.test).ts`, identical to main.

`RiskItem.score_contribution` is served `null` when every category the
risk's channels map to is refused (it was severity × the 0.3 relevance floor:
48 / 39 / 34 beside overall None); the fallback read's watch sentence says
"No watch flags: composite risk unavailable." instead of "score is
composite-low."; `routes._build_watchlist` and `_derive_categories_for_profile`
(zero callers) are deleted.

| | |
|---|---|
| command | `python -m pytest tests/engine/public/intelligence/test_risk_scoring_engine.py tests/engine/public/intelligence/test_opportunity_scoring_engine.py tests/engine/public/intelligence/test_public_score_refusal_route.py tests/engine/public/intelligence/test_ai_market_read.py -q` |
| work count | junit-xml, floor **42** tests (measured 47) |
| added canaries | `test_top_risk_contribution_is_null_when_every_mapped_category_is_refused`, `test_fallback_watch_flags_state_a_refused_composite_not_composite_low` |

**Reds on, after the repair (TC-11), added:** a numeric `score_contribution`
on a risk whose mapped categories are all refused; a "composite-low"
sentence beside a refused composite; a level word, bar or digit rendered
for a null category on the Risk tab.

**GREEN** — exit `0`: `47 passed`.

**PLANT E** — `risk_scoring_engine.py` `_risk_to_category_weight`:
`return max(TOP_RISK_MIN_RELEVANCE, best or 0.0)` (the floor over refused
categories).

**RED** — exit `1`:

```
E   AssertionError: assert 0.3 is None
E    +  where 0.3 = <function _risk_to_category_weight>(['capex'], RiskCategoryScores(macro=65, supply_chain=66, geopolitical=40, financial=None, valuation=None, operational=None, regulatory=38))
FAILED tests/engine/public/intelligence/test_risk_scoring_engine.py::test_top_risk_contribution_is_null_when_every_mapped_category_is_refused
```

**PLANT F** — `ai_market_read.py` `_deterministic_fallback`: the
unconditional `watch.append("No specific watch flags — score is composite-low.")`.

**RED** — exit `1`:

```
E     At index 0 diff: 'No specific watch flags — score is composite-low.' != 'No watch flags: composite risk unavailable.'
FAILED tests/engine/public/intelligence/test_ai_market_read.py::test_fallback_watch_flags_state_a_refused_composite_not_composite_low
```

**REVERT** — both restored; exit `0`, `47 passed`.

### floor-public-score — R-PUBLIC-ABSENT (2026-09-19, C6 follow-up)

**The owner ruled** (scratchpad floor_rulings.md R-PUBLIC-ABSENT): in the
PUBLIC risk score a category whose input NO data producer carries is
DROPPED — its weight redistributed over the categories that computed, and
the served block lists the dropped categories, the reason and the weights
actually applied — while a category whose input the producer carries but
THIS company lacks still REFUSES, and the composite with it. Refusing on a
structurally absent input had nulled the composite universe-wide (0 / 291
above), which hides the score rather than stating what it covers. The
private credit composite never redistributes (R-COMPOSITE); this is the
public score's rule alone.

**Measured before designing** (`scratchpad/c6_measure_coverage.py`, the
291 offline rows): `interestExpense` is a key on **0 / 291** rows and
neither live builder reads the adapter's `interest_expense` — structural
for every producer. `revenueGrowth` is **not** 291/291 absent as the
ruling's note said: the seed and demo producers carry it as a field
(203 / 203 demo rows with a value, 7 / 88 seed rows) and both LIVE builders
write a literal `None` ("requires prior period — v2"). So the drop is
declared **per producer** — the row's `mode`, carried as
`financials["producer"]` — in `risk_scoring_engine.PRODUCER_COVERAGE`:
live → financial + operational dropped; demo, seed → financial dropped; a
row with no producer marker drops nothing (per-company refusals only). A
dropped category is never scored, even for a row that happens to carry the
input, so every row of one producer keeps the same categories and weights.
`applied_weights` = `CATEGORY_WEIGHTS` rescaled over the scored set (sums
to 1; exactly the declared weights when nothing is dropped). The
declaration is itself gated: over every seed/demo row a declared input has
no key and every other category input is a key; both live builders driven
with inputs that DO carry an interest expense still emit no
`interestExpense` and `revenueGrowth None`. Once a producer carries a
declared input (`PT-PUBLIC-1`) that test reds and the entry comes out.

Blast radius, same command as above (`c6_public_blast.py`, extended with
the coverage counts):

| | main @1f3ff4b | branch before (refuse) | branch after (drop) |
|---|---|---|---|
| composite risk numeric | 291 / 291 | 0 / 291 | **183 / 291** (NASDAQ demo 183 / 203, BVB seed 0 / 88) |
| financial category | 291 scored (30 % of it a fixed 50) | 291 refused | 291 **dropped** |
| operational category | 291 scored | 101 refused | 101 refused per company (demo carries growth; 88 seed rows lack capex, 13 demo rows lack growth/capex) |
| valuation refused per company | 0 | 107 | 107 |
| risk levels | medium 260 · high 31 | — | medium 151 · high 32 |

The 88 BVB seed rows still score 0 / 88: their curated rows carry the
`capex` field but leave it None on every row and P/E on 81, so operational
and valuation refuse per company — a curation gap, not a producer one, and
the refusal sentence names the field.

| | |
|---|---|
| command | `python -m pytest tests/engine/public/intelligence/test_risk_scoring_engine.py tests/engine/public/intelligence/test_opportunity_scoring_engine.py tests/engine/public/intelligence/test_public_score_refusal_route.py tests/engine/public/intelligence/test_ai_market_read.py tests/engine/public/intelligence/test_risk_producer_coverage.py -q` |
| work count | junit-xml, floor **52** tests (measured 57) |
| added canaries | `test_the_declaration_is_measured_against_the_live_producers`, `test_a_per_company_absence_still_refuses_the_category_and_the_composite`, `test_per_ticker_route_serves_the_composite_with_its_coverage_block` |

**Restated in a named commit (83f78cf):** `test_public_score_refusal_route.py`
pinned the live-shaped AAPL row REFUSING — the shape the ruling reverses.
The live AAPL row now scores (pinned in the coverage file); the per-company
refusal moved to a live MSFT row lacking P/E, a field the producer carries:
valuation refuses, the composite, the batch row and the AI-read headline
refuse with it, and P/E being an opportunity input that score refuses too
(the file had asserted it measured).

**Reds on, after the repair (TC-11), added:** a composite refused on a
structurally absent input; a composite served while a REFUSED scored
category is redistributed away; applied weights that are not the declared
weights rescaled, or that do not sum to 1; a dropped category with no
stated reason; a declared "not carried" input that a producer does carry;
the per-ticker route or the batch row serving the composite without the
coverage block; on the Risk tab, a level word, a bar, a digit outside the
engine's sentence, or the word "unavailable" beside a dropped category; a
coverage note whose weights come from anywhere but the served block.

**RED first** — `test_risk_producer_coverage.py` on the parent engine:
`ImportError: cannot import name 'CATEGORY_INPUTS'` at collection.

**GREEN** — exit `0`: `57 passed`; `tests/engine/public/intelligence` +
`tests/engine/test_public_egress.py`: `1095 passed`.

**PLANT G** — `dropped_categories()` reads `not_carried = ()` (the drop
reverted; every structural absence refuses again).

**RED** — exit `1`:

```
E   AssertionError: assert 'risk_category_unavailable' == 'risk_category_dropped'
E   AssertionError: assert 8 is None
E    +  where 8 = RiskCategoryScores(macro=65, supply_chain=56, geopolitical=4, financial=8, ...).financial
E   - Composite risk unavailable: valuation inputs not reported for MSFT.
E   + Composite risk unavailable: financial, valuation and operational inputs not reported for MSFT.
FAILED tests/engine/public/intelligence/test_risk_producer_coverage.py::test_every_producer_drops_financial_and_only_live_drops_operational
FAILED tests/engine/public/intelligence/test_risk_producer_coverage.py::test_a_live_row_drops_financial_and_operational_and_scores_the_rest
FAILED tests/engine/public/intelligence/test_risk_producer_coverage.py::test_a_per_company_absence_still_refuses_the_category_and_the_composite
FAILED tests/engine/public/intelligence/test_risk_producer_coverage.py::test_a_dropped_category_is_never_scored_even_when_the_row_carries_the_input
```

**PLANT H** — the weights renormalised over the MEASURED subset (a refused
category redistributed away: the R-COMPOSITE fabrication).

**RED** — exit `1`:

```
E   AssertionError: assert (43 is None)
E    +  where 43 = PublicCompanyRiskScore(ticker='MSFT', overall_risk_score=43, risk_level='medium', ...).overall_risk_score
FAILED tests/engine/public/intelligence/test_risk_producer_coverage.py::test_a_per_company_absence_still_refuses_the_category_and_the_composite
FAILED tests/engine/public/intelligence/test_risk_scoring_engine.py::test_no_financials_refuses_every_financial_category_and_the_composite
FAILED tests/engine/public/intelligence/test_risk_scoring_engine.py::test_one_absent_financial_input_refuses_the_category[interest_expense-interest coverage]
(+5 more in test_risk_scoring_engine.py)
```

**REVERT** — both restored; exit `0`, `57 passed`.

**FE (vitest, `riskBreakdownDropped.test.tsx`, 9 tests + the refusal file's
4).** PLANT FE-1 — `CategoryGrid`'s dropped branch removed (`const dropped
= null`): a drop falls to the refusal branch.

**RED** — exit `1`:

```
   × CategoryGrid — a dropped category > renders 'not scored' plus the engine's sentence: no bar, no level, no digit, not 'unavailable'
     → expected 'unavailable' to be 'dropped' // Object.is equality
   × CategoryGrid — a dropped category > falls back to the block's reason when the refusal list lacks the sentence
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯
```

PLANT FE-2 — `CoverageNote` prints `declared_weights` instead of
`applied_weights` (a remembered constant in place of the served block).

**RED** — exit `1`:

```
AssertionError: expected 'Scored over 5 of 7 categories. Not sc…' to contain 'Macro 26.5%'
Received: "... Weights applied: Macro 18.0% · Supply chain 17.0% · Geopolitical 13.0% · Valuation 10.0% · Regulatory 10.0%."
      Tests  2 failed | 7 passed (9)
```

**REVERT** — both restored; `13 passed` across the two files. `tsc
--noEmit -p tsconfig.app.json`: 10 errors, all pre-existing in
`capsuleEmpty/capsuleAskGuard(.test).ts`, identical to main — the
`DailyRun.roicPct` / `anchorProfitShare` widening to `number | null`
surfaced its consumers (`cfoDerive.ts`, `chatResponder.ts`), each now
stating the refusal.


## floor-sku-portfolio

Floor sweep cluster C7 (`wave/floor-c6-public-sku`, 2026-09-18). The SKU /
portfolio engine divided by a floored denominator wherever the real one was
zero: share of category profit over `total or 1.0` (a net-zero category
served shares of 50,000.0 / −50,000.0), the NIV-weighted portfolio margin
over `total_niv or 1.0` (NIV +1000/−1000 served 20,000.00; NIV 0 served 0.00
beside a category at 29.3), ROIC `if trapped > 0 else 0.0` (300 kRON on zero
capital served 0.00%), the volume-weighted category DIO over `volume or 1.0`
(rows at 180/120 days with no volume served DIO 0 and zero trapped capital
while the upload sheet said 150), the DIO sheet clamped to [7, 365] (a real
1,483-day stock served 365) or assumed a 90-day period, a zero-revenue
category served GM 0.0 and was ELIMINATED on real margin −1.6, and
`composite_score` ranked over `max(DIO, 1)`. All of these went out on
`POST /run-daily`, `/api/cfo/today`, `/profit`, the board summary and the
CLI file. Now every one refuses with `{code, component, inputs, text}`
through one authority (`engine.metrics.niv_weighted_margin`,
`portfolio_roic`), the DIO falls through the ladder (sheet → canonical →
labelled default), and the outlier DIO is served measured and flagged.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_floor_sku_portfolio.py tests/test_metrics.py -q` |
| work count | junit-xml, floor **35** tests (measured 40) |
| canary | `test_skus_share_of_category_profit_refuses_net_zero`, `test_zero_volume_dio_rows_fall_through_to_the_upload_sheet`, `test_zero_revenue_category_is_refused_not_eliminated`, `test_composite_score_dio_zero_is_undefined` |

**Reds on, after the repair (TC-11):** a share, margin, ROIC or composite
served as a number over a zero, negative or floored denominator on any of
the four surfaces; a zero-volume DIO row set winning over the upload sheet;
a sheet DIO clamped or computed over an assumed period; a zero-revenue
category or SKU classified instead of refused; a refusal missing from the
`/run-daily` payload or from the board-summary prose.

**GREEN** — exit `0`: `40 passed`.

**PLANT A** — `frontend.py` share of category profit: `total = sum(...) or
1.0` and the `if total > 0` guard forced true.

**RED** — exit `1`:

```
tests/engine/test_floor_sku_portfolio.py:212: assert 50000.0 is None
tests/engine/test_floor_sku_portfolio.py:223: assert False
FAILED ...::test_skus_share_of_category_profit_refuses_net_zero
FAILED ...::test_skus_share_of_category_profit_refuses_negative_total
```

**PLANT B** — `metrics.py` `niv_weighted_margin`: `total = sum(...) or 1.0`
returning the average before the sign checks.

**RED** — exit `1`:

```
tests/engine/test_floor_sku_portfolio.py:151: assert (0.0 is None)
FAILED ...::test_run_daily_route_serves_the_refusal
FAILED ...::test_cfo_today_refuses_and_the_briefing_states_why
```

**PLANT C** — `metrics.py` `portfolio_roic`: `return 0.0, None` on zero
trapped capital.

**RED** — exit `1`:

```
tests/engine/test_floor_sku_portfolio.py:127: assert 0.0 is None
tests/engine/test_floor_sku_portfolio.py:192: assert 'Portfolio ROIC unavailable' in "# Demo Company — CFO AI Board Summary\n..."
```

**PLANT D** — `frontend.py` weighted DIO: `/ (dio_weight or 1.0)` with the
`dio_weight > 0` guard dropped.

**RED** — exit `1`: `AssertionError: assert 0 == 150`.

**PLANT E** — `frontend.py` DIO sheet: `min(max(avg * period_days /
sold_kg, 7), 365)` restored.

**RED** — exit `1`: `assert 365 == 1483`.

**PLANT F** — `frontend.py` DIO sheet: `period_days = 90` assumed when no
period is confirmed.

**RED** — exit `1`: `AssertionError: assert {'SUC': 45} == {}`.

**PLANT G** — `frontend.py` category GM: the `total_niv <= 0` refusal
disabled (`if False:`) and the division floored (`/ (total_niv or 1.0)`).

**RED** — exit `1`:

```
E   AssertionError: assert ('ZZZERO' not in ['ZZLIVE', 'ZZZERO'])
FAILED ...::test_zero_revenue_category_is_refused_not_eliminated
```

**PLANT H** — `metrics.py` `composite_score`: `/ max(dio_days, 1)` restored.

**RED** — exit `1`: `assert 10000.0 is None` (both suites).

**REVERT** — all eight restored; exit `0`, `40 passed`. Verdict: proven RED
eight ways.

**One plant that proved nothing, recorded (TC-2).** The first plant for G
floored only the division at line 558 (`... / total_niv if total_niv > 0
else 0.0`) and stayed GREEN — that line is behind the guard, so the plant
was dead code. The plant was re-aimed at the guard itself, which is the
repair; that is the one recorded above.

### floor-sku-portfolio — repair round (2026-09-19)

Two verifier plants on f68d45a had left this gate GREEN: `anchor_share =
0.0` served on a zero/loss total (a headline on `/run-daily`,
`/classify-rows` and the upload payload that no test read) and the DIO-sheet
banner span clamped into `DIO_SHEET_PERIOD_DAYS_RANGE` instead of refused.
Two more sites were found while closing them: the analysis narrative
formatted `run.get("roicPct", 0)` — a PRESENT None is not defaulted, so
`POST /api/analyze` and `/upload-excel` answered **500** for exactly the
portfolios whose figures refused; and `sku_pipeline.compute_sku_metrics`
(the CLI loader path) floored the SKU's share of category NIV at `total or
1.0` — measured, a 1,000 kRON SKU in a category netting to zero took a
1,000× share (500,000 kRON of a 500 kRON parent WOCA). `frontend/lib/engine.ts`
carried a dead browser mirror of the engine with the same floors and a
[0, 1] clamp on anchorProfitShare; nothing imported it but a type, and it is
now that type alone.

**Blast radius on the Scandia trading workbook, reproducible.** Stated
command: `PYTHONPATH=<tree>/src CFO_AI_SKIP_BOOT_VERIFY=1
LEGACY_SKU_AI_ENABLED=1 python scratchpad/c6_sku_blast.py <tree> out.json`
— `POST /api/upload-excel?period_months=10` on
`engine.api.create_app(config_path=<tree>/config.yaml)` (the app's own
canonical calibration, so the workbook's uncalibrated categories fall to the
labelled DIO=90 default), no model key, `GENERAL_BODY_LIMIT_BYTES` lifted to
64 MiB for the 12.4 MB file. The 2026-09-18 entry's 38.8 / 0.833 / 10.57
came from a bare `create_frontend_router` with the workbook passed as its
own canonical file — a different calibration, not a different engine.
Measured main probe @1f3ff4b versus this branch: headline **byte-identical**
(roicPct 31.3, anchorProfitShare 0.83, workingCapitalMRon 13.03, confidence
high, 24 categories, 220 SKUs, flag counts equal, no run refusals); **8 SKU
rows lose their share**, all in the three categories whose SKU profit nets
to ≤ 0 — Calamar (1 row, −3.16 kRON), SUC DE ROSII (1 row, −0.67) and
MURATURI (all 6 rows; the category nets −7.42 kRON from −31.36, −3.43,
−2.19, +1.55, +5.58, +22.43) — each with `share_of_category_profit_refusal`;
served share extremes go from [−302.3, +422.6] (2 rows beyond ±100) to
[−72.1, 100.0] (0). Note the consequence: a mixed category netting to a
loss refuses every SKU's share in it, the profitable rows included — a share
of a loss is not a share.

| | |
|---|---|
| command | unchanged |
| work count | junit-xml, floor **42** tests (measured 48) |
| added canaries | `test_classify_rows_refuses_anchor_profit_share_when_profit_nets_to_a_loss`, `test_dio_sheet_out_of_range_banner_span_is_not_used`, `test_analyze_route_states_refused_roic_and_share_instead_of_500` |

**Reds on, after the repair (TC-11), added:** a numeric anchorProfitShare
served over a zero or loss total; a banner span outside the declared range
used as a period; a 500 or a "0.0% ROIC" from the narrative for a refused
figure; a parent WOCA or inventory allocated over a non-positive category
NIV total.

**GREEN** — exit `0`: `48 passed`.

**PLANT I** (verifier V3) — `frontend.py` `_to_daily_run`: `anchor_share =
0.0` on a non-positive total, refusal still appended.

**RED** — exit `1`: `tests/engine/test_floor_sku_portfolio.py: assert 0.0 is None` — `test_classify_rows_refuses_anchor_profit_share_when_profit_nets_to_a_loss`.

**PLANT J** (verifier V4) — `frontend.py` `_load_dio_from_workbook`:
`period_days = min(max(diff, lo_p), hi_p)` in place of the range check.

**RED** — exit `1`:

```
E   AssertionError: assert {'SUC': 15} == {}       (10-day banner)
E   AssertionError: assert {'SUC': 183} == {}      (400-day banner)
```

**PLANT K** — `frontend.py` `_run_figure`: `value = run.get(key) or 0.0`.

**RED** — exit `1`:

```
E   AssertionError: assert 'ROIC unavailable (Portfolio ROIC unavailable: capital trapped is zero.)' in '0 eliminations, 0 anchor alerts, 0 scale opportunities. Working capital 0.0M RON at 0.0% ROIC.'
```

**PLANT L** — `sku_pipeline.py` `compute_sku_metrics`: `cat_total_niv = … or
1.0` and the unguarded division restored.

**RED** — exit `1`: `E   AssertionError: assert (500000.0 is None)` — `woca_kron=500000.0` on a 1,000 kRON SKU.

**REVERT** — all four restored; exit `0`, `48 passed`.


## floor-industry-absent

Floor sweep cluster C8 (`wave/floor-c6-public-sku`, 2026-09-18).
`_industry_classifier.py` evaluated its cost-structure rules over `m.get(key,
0) or 0` numerators and a `.get(revenue, 1)` divisor, so a period whose
metrics carried no cost lines had COGS 0 / revenue and matched the real-estate
rule at confidence 0.7. Measured before: every firm fixture (agras,
carniprod, retail, realestate, Scandia FY2025) suggested CAEN 6820 "Real
estate / property rental" at 0.7 from `calculated_metrics` alone;
`detect_industry_for_period` never read the P&L line items that carry the
cost lines. After: a rule set is evaluated only when every one of its six
inputs is measured, otherwise it refuses with the missing names; detection
reads the line items, so Scandia classifies 1012/1013 (two rules match →
ambiguous 0.4, which the rules always said and the zero-read had hidden) and
the fixtures without line items fall to the universal fallback at 0.30 with
the reason stated.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_industry_classifier_absent_inputs.py -q` |
| work count | junit-xml, floor **12** tests (measured 14) |
| canary | `test_metrics_without_cost_lines_refuse_instead_of_suggesting_real_estate`, `test_detect_industry_for_period_reads_the_pl_line_items` |

**Reds on, after the repair (TC-11):** a CAEN suggested while any of the six
cost inputs or the revenue is absent or non-positive; a refusal without the
missing names; detection that ignores the P&L line items; the services
fallback deciding on an absent COGS.

**GREEN** — exit `0`: `14 passed`.

**PLANT A** — `_industry_classifier.py`: `missing = []` and every absent
cost input pre-filled with 0.

**RED** — exit `1`:

```
    assert result.caen is None
E   AssertionError: assert '6820' is None
E    +  where '6820' = CostStructureClassification(caen='6820', label='Real estate / property rental', confidence=0.7, refusal=None).caen
```

**PLANT B** — `_industry_detection.py`: `cost_structure_metrics(metric_rows,
[])` (line items dropped).

**RED** — exit `1`:

```
E   AssertionError: assert 'fallback' == 'auto_account_structure'
```

**PLANT C** — `_industry_detection.py`: `cogs = metrics.get("cogs") or 0` in
the services fallback.

**RED** — exit `1`:

```
E   AssertionError: assert 'professional...vices_generic' == 'manufacturing_generic'
```

**REVERT** — all three restored; exit `0`, `14 passed`. Verdict: proven RED
three ways.

### floor-industry-absent — repair round (2026-09-19)

**The C8.1 refusal was bypassed on the served benchmark path.**
`_benchmarks._load_period_signals` kept its own flattening that pre-filled
`cogs`, `depreciation_amortization` and the four opex lines with 0 when the
period had no PL line items; `_resolve_effective_caen` step 2 then called
`suggest_caen_code` on six "measured" zeros, rule 6820 fired at 0.7 — exactly
`_AUTODETECT_MIN_CONFIDENCE` — and `GET /api/benchmarks/report/{period_id}`
auto-assigned real estate to a period with no cost lines: the defect the
batch fixed, one caller over. The loader now delegates to
`_industry_classifier.cost_structure_metrics` (the one flattening
`detect_industry_for_period` reads), the resolver reads
`classify_cost_structure` and returns `(caen, source, refusal)`, and the
`caen_not_set` gate serves the refusal and appends its sentence to the
message.

**Blast radius.** Every committed firm fixture (agras, carniprod ×2, retail,
realestate, imbalance_03pct, the two synthetic books) carries 0 PL line
items: through `/report` each would previously have been served a
real-estate benchmark report wherever CAEN 6820 is seeded; each is now gated
with `cost_structure_classification_unavailable` naming the six absent
lines (or "operating revenue is not positive" for the three zero-revenue
books). `scandia_fy2025` (653 line items) auto-detects 1012 at 0.7, as before
the loader change. **Open, to measure before intl periods go live:** line
items without `ro_account_code` sum the four opex prefixes to a true 0 in
both loaders — a measured zero, not an absence — so a non-RO period with
PL items could still match a rule on zero personnel; the classifier cannot
tell that case from an RO period with no payroll accounts.

| | |
|---|---|
| command | unchanged |
| work count | junit-xml, floor **15** tests (measured 18) |
| added canary | `test_report_route_gates_a_no_line_items_period_with_the_refusal` |

**Reds on, after the repair (TC-11), added:** a CAEN auto-detected through
`/report` for a period with no PL line items; a `caen_not_set` gate without
the classifier's refusal; the benchmark loader's flattening diverging from
the classifier's.

**GREEN** — exit `0`: `18 passed`.

**PLANT D** — `_benchmarks.py` `_load_period_signals`: the six cost lines
pre-filled with 0 after the classifier flattening.

**RED** — exit `1`:

```
E   AssertionError: ('6820', 'auto_detected')
E   assert ('6820', 'auto_detected') == ('', 'unknown')
FAILED tests/engine/test_industry_classifier_absent_inputs.py::test_report_route_gates_a_no_line_items_period_with_the_refusal
FAILED tests/engine/test_industry_classifier_absent_inputs.py::test_the_benchmark_loader_is_the_classifier_flattening
```

**REVERT** — restored; exit `0`, `18 passed`.

## ratios wave three — second repair round (2026-09-20)

Seven verifier findings on `wave/ratios-b8-milestone` (one medium, six low).
Every plant below was applied to the product, run, and reverted; the gate
named is green at HEAD. What each gate reds on AFTER the repair (TC-11) is
stated in the gate's own docstring.

| # | Plant (product side) | Gate | RED excerpt |
|---|---|---|---|
| 1 | `serve_credit_rows`: `family = set(CREDIT_FAMILY_METRICS)` (the definition-revised row not replaced) | `tests/engine/test_period_route_revised_rows.py` (battery `ratio-credit-model`, canary) | `agras: metrics[] serves 66.2774, ratio_table serves '55.64' under ONE key` · `retail: … 0.0909 … '-0.52'` — 5 failed |
| 2 | get_period: the typed `ratios.coverage` patch disabled | same | `agras: assembled_metrics.ratios.coverage serves 66.2774, ratio_table '55.64'` — 3 failed |
| 3 | `/report` coverage row back to the bare `"Interest coverage"` | `frontend/pages/cfo/__tests__/comprehensiveReportRatioLabel.test.tsx` | 1 failed (row name ≠ label authority) |
| 4 | `statement_operands`: absent BS leaves and `interestExpense` read as `0.0` (verifier's plant) | `test_credit_model_rungs_and_ranges.py::test_an_absent_debt_or_interest_leaf_declares_nothing` (canary) | `assert {…operands…} is None` — 4 failed |
| 5 | `SUBJECT_BUCKETS["interest_coverage"]` → `_EBITDA` | `test_comparatives_bands.py::test_the_interest_coverage_subject_names_ebit_accounts_and_the_ebitda_row_does_not` | `assert ('depreciation' in ('revenue', 'otherIncome', 'cogs', 'operatingExpenses'))` |
| 6 | no-envelope FE model: `intCov` on `ebitdaStatutory` | `frontend/lib/__tests__/interestCoverageBasis.test.ts` | `expected '66.28' to be '55.64'` · `expected '0.09' to be '-0.52'` — 3 failed |
| 7 | `ro.json` interest_coverage label `(EBITDA / dobânzi)` | same | `expected 'Gradul de acoperire a dobânzilor (EBI…' to match /\(EBIT \/ /` |
| 8 | workbook served-only loop: pp change recomputed, `toFixed(1)` (verifier's X_b6gap) | `ratioTableByteMatch.test.tsx` B6 (battery `ratio-byte-match`) | `financialExports.ts Ratios-sheet builder: … /\.toFixed\(/ matched ".toFixed("` |
| 9 | `sixCells`: `value_q as unknown as number; cq * 1 - pq * 1` (verifier's A8-alias) | same | `/\bas\s+(?:unknown\s+as\s+)?number\b/ matched "as unknown as number"` — 2 failed |
| 10 | the same alias typed `any`, no cast | same | `/[\w)\]]\s*[-*/%]\s*[\w(]/ matched "q * 1"` — 2 failed |
| 11 | FE `engineWeightOf`: Altman range breach ignored | `creditRefusedSubscores.test.tsx` (agras block) | `expected 100 to be null` — 3 failed |
| 12 | FE `altmanFromEngine`: breach not withdrawn | same | `expected 10416.74 to be null` — 3 failed |
| 13 | get_period as-filed branch: `withhold_out_of_range` dropped | `test_credit_model_rungs_and_ranges.py::test_the_as_filed_basis_withdraws_a_filed_altman_outside_its_range_on_the_route` | `assert (1584.89 is None)` |
| 14 | same branch: `metrics[]` rows left raw | same | `AssertionError: ('altman_z_score', 1584.89)` |
| 15 | `safeFacts` as before the repair (git stash) | `recommendationMateriality.test.ts` §8 | `expected null not to be null` |

B6 now blanks template-literal TEXT and keeps its `${…}` expressions: the
binary-operator rule would otherwise read `data-ratio-key` and `</td>` as
arithmetic (first run: 5 false reds on the report closures).

## ratios wave three — repair round credit2 (2026-09-20)

One medium and six lows from the credit re-verify. Every plant below was
applied to the product, run, and reverted; the gate named is green at HEAD.
What each gate reds on AFTER the repair and what it cannot see (TC-11) is in
the gate's own docstring.

| # | Plant (product side) | Gate | RED excerpt |
|---|---|---|---|
| 1 | `reportedInterestExpense`: shelved-record bridge removed | `retainedEarningsMapped.test.tsx` | `expected undefined to be 2935000000` · `expected [ 'longTermDebt', …(15) ] to not include 'interestExpense'` — 2 failed |
| 2 | `debtReported` reads the two (always shelved) legs only | same | `expected +0 to be 2` (no declared rung on a reported total debt of 0) |
| 3 | `canonical()` rebuilds EBIT instead of reading the reported level | same | `expected 129.3321976149915 to be close to 41.98160136286201` |
| 4 | M7b — `enforce_metric_rows` except branch returns the rows raw | `test_credit_boundary.py::test_the_narrator_rows_fail_closed` | `assert {'altman_x4':...} == {'altman_x4':...}` (1584.89 / 1500.0 / 88.5 reach the narrator) |
| 5 | M8 — comparatives route returns `compare_payloads(...)` raw | `::test_the_comparatives_composer_itself_exploding_is_refused_at_the_boundary` | `AssertionError: ('altman_z', {...})  assert (1584.89 is None)` |
| 6 | A — envelope recognised by `altman_components` only | `::test_shape_a_…` | `assert (250 is None)` |
| 7 | B — `beside = False` (R-COMPOSITE not held by shape) | `::test_shape_b_…` | `AssertionError: null sub-score  assert (80.0 is None)` |
| 8 | C — last row of a name wins | `::test_shape_c_…` | `assert '1584.89' not in '[1584.89, 1...5, 3.1, 1.2]'` |
| 9 | D1 — a mixed compare list skipped whole under its parent | `::test_shape_d_…` | `assert 100.0 is None` |
| 10 | D2 — `_COMPARE_DEPENDENTS = {}` | same | `assert 100.0 is None` (the Altman sub-score row of the exploded side survives) |
| 11 | E — filed Z'' read for finiteness only | `::test_shape_e_…` | `assert 1584.89 is None` |
| 12 | `def _planted_floor(tl, e): return e / max(tl, 1)` in `credit_boundary.py` | `scripts/check_floor_census.py` (battery `floor-census`) | `FLOOR in the credit tier: src/engine/ratios/credit_boundary.py:665 [S1 DIVISOR_FLOOR] in _planted_floor: max(tl, 1)` — before the scope change: `PASS … credit tier clean` |
| 13 | `_planted = {"operands": [{"name": "net_debt", "value": 123456.0, "source": "x"}]}` in `ratio_compare.py` | `scripts/check_metric_units.py` (battery `metric-units`) | `METRIC UNIT GATE: FAIL — the operand scope-out moved · ratio_compare.py::<module>  scoped out 1, pinned 0` — before the pin: `PASS … 4 operand record(s)` |

Plant 9 reds on the sibling-list assertion, not on the composite: the list
branch of the walk reads compare rows per row as well, so a mixed list is
covered twice. Stated so the redundancy is not mistaken for the gate.

## benchmarks-ro — sourced sector benchmark, data layer (2026-09-20)

`tests/engine/test_benchmarks_ro.py` over `engine.benchmarks_ro` and the
committed aggregate `src/engine/data/ro_sector_benchmarks.json`, built from
the Ministry of Finance annual filings (data.gov.ro, CC-BY-4.0) by
`scripts/build_ro_sector_benchmarks.py`. The law: no figure without source,
year and n; fewer peers than `MIN_PEERS` (declared in
`benchmarks_ro/definitions.py`, printed from there) is "insufficient peers"
with no median; absent is never zero; a ratio the filed summary does not
carry is refused with the reason. Every plant was applied to the product,
run, and reverted; all gates are green at HEAD.

| # | Plant (product side) | Gate | RED excerpt |
|---|---|---|---|
| 1 | `specs.CANONICAL_LABELS` without "profitul brut" / "profitul net" | `test_public_ro_spine.py::test_real_data_gov_ro_2024_bl_spec_resolves` | `SpecResolutionError: spec for FY2024 family BL cannot be resolved: unrecognized indicator label 'Profitul brut' (normalized 'profitul brut') at source code I16` |
| 2 | `dataset.check_law` no longer reports a figure without n | `::test_a_figure_without_source_year_or_n_does_not_load[n]` | `Failed: DID NOT RAISE <class 'engine.benchmarks_ro.dataset.DatasetLawError'>` |
| 3 | `build.figure` publishes below the minimum (`if len(values) < 1`) | `::test_fewer_than_min_peers_has_no_median` | `KeyError: 'insufficient_peers'` |
| 4 | `build._div` reads an absent numerator as zero (`num = num or 0`) | `::test_an_empty_field_is_absent_not_zero`, `::test_two_builds_are_byte_identical`, `::test_committed_class_cells_equal_a_build_from_the_real_slice` | `assert Decimal('0') == 'absent_operand'` · slice build sha `4ecbb16b…` != pinned `8634fb11…` · 3 failed |

TC-11, what each reds on after the repair: (1) either articulated label
leaving the vocabulary, a byte change in the real BL spec fixture, or BL
resolving differently from UU. (2) any figure in a dataset handed to
`validate` lacking n, year, source or filed lines, or carrying a median on
fewer peers than the minimum — the check runs at load, so such a dataset
cannot be served at all. (3) the builder emitting median/p25/p75 on a thin
cell. (4) any change to per-row arithmetic, drop rules, quantisation,
percentile method or key order: the slice build is pinned by sha256 and its
CAEN-class cells must equal the committed dataset's. What they cannot see:
the CAEN-division ("10") cells are not rebuilt in the suite (the slice holds
classes 1011 and 1013 only); they are covered by the law walk, not by a
rebuild. The full mass files are not in git, so a re-issue of a file by the
portal is caught only at build time, by the manifest sha check
(`::test_a_tampered_file_aborts_the_build` demonstrates the abort).

TC-12 coverage: the law walk visits every figure in the dataset (asserted to
be at least one hundred); the slice holds every FY2024 filer in CAEN 1011 and
1013 and the FY2023 filings of the same CUIs, real bytes, per-file sha256 in
`tests/engine/fixtures/benchmarks_ro/slice_manifest.json`.

## benchmarks-ro-serving — company vs sector, the serving seam (2026-09-20)

`GET /api/period/{id}/sector-benchmark` (pipeline.py, beside comparatives) +
`engine.benchmarks_ro.sector`. Gate: `tests/engine/test_sector_benchmark_route_real_app.py`
(real `create_app()`, signature-verifying tenancy double, corpus books through
the production write seam; nothing on the request path stubbed but the network).

| # | Plant | Reds | Excerpt |
|---|---|---|---|
| A | the route loads the current period by id only (org dropped from the filter) | `::test_a_period_from_another_workspace_is_not_found` | `AssertionError: (200, '{"schema":"sector_benchmark/1","period":{"id":"p-retail-foreign",…` · `assert 200 == 404` |
| B | `check_document_law` no longer reports a figure without n | `::test_a_figure_without_n_year_or_source_is_a_violation` | `AssertionError: n` · `assert False` |
| C | `_row_sum` answers 0.0 when the statement has no such row | `::test_an_absent_company_operand_refuses_the_row_never_zero` | `assert ('sourced' == 'company_absent'` |
| D | inventory days on turnover declared the same as the card's DIO | `::test_every_census_key_has_a_sector_band_or_a_stated_reason`, `::test_the_company_side_is_the_ratio_table…` | `KeyError: 'reason'` · `assert 'ratio_table.dio' == 'restated_on_filed_basis'` |

TC-11, after the repair: (A) reds on any load of a browser-supplied period id
without the caller's organization in the filter, on a forged bearer served, on
a non-member workspace served. (B) on any row, ratio card or movement item
leaving the route without source, year or n, or with a median under the
minimum — the route runs the same check and answers 500 rather than serve it.
(C) on any company operand defaulted to a number. (D) on a card taking a
sector band whose definition is not the card's own, and on a census key
with neither a band nor a stated reason. It also reds when the committed
frontend fixture (`frontend/lib/__tests__/fixtures/sectorBenchmark/served_pair.json`)
is not byte-for-byte what the route serves. What it cannot see: the medians
themselves (`test_benchmarks_ro.py`), and Scandia's own figures — the corpus
pair is Agras FY2025 / Carniprod FY2024 under CAEN 1011.

### Repair pass, 2026-09-20 (plant I)

| # | Plant | Reds | Excerpt |
|---|---|---|---|
| I | the persisted-metric refusal narrowed back to ROE alone (`and (key != "roe" or _card_states_its_filed_basis(row))`) | `test_sector_benchmark_route_real_app.py::test_no_company_figure_rests_on_a_persisted_metric`, `::test_the_company_side_is_the_ratio_table_the_same_app_serves` | `AssertionError: [('net_margin', 'ratio_table.net_margin', 'metrics.net_margin')]` · `- ratio_table.net_margin` / `+ restated_on_filed_basis` · `2 failed \| 11 passed` |

TC-11, after the repair: (I) reds on any served row whose printed operands
cite `metrics.` — a number that states no basis, so nothing holds it to the
account-121 anchor the dashboard prints; on net_margin differing from that
anchored net income over revenue as the SAME app serves them in
`GET /api/period`; and on a ratio card keeping its sector band while what the
card PRINTS is a different number from the filed-basis figure the band was
positioned against. A card keeps its band by proof, not by provenance:
`card_agrees` is true only within the served `card_agreement_tolerance`.

TC-10: size-band cut-offs, the minimum peer count, the percentile minimum and
the card-agreement tolerance are served in the document (`size_bands`,
`min_peers`, `percentile_min_n`, `card_agreement_tolerance`);
nothing downstream types them. TC-12 coverage: nine sourced ratio keys, all
census keys on `ratio_cards` (asserted equal to `CENSUS`). The percentile is
refused (`quartiles_only`): the dataset holds quartiles, and a percentile
between them would be an interpolation.

## benchmarks-ro-surface — company vs sector on the page, the card and the report (2026-09-20)

One reader and one printer (`frontend/lib/sectorBenchmark.ts`) behind three
surfaces: the `/benchmark` page section
(`components/cfo/benchmark/SectorBenchmarkSection.tsx` + `SectorRangeBar.tsx`),
the ratio card's band-source line (`components/cfo/ratios/RatiosTab.tsx`) and
the CFO report section (`lib/financialReport.ts`). Gates:
`frontend/lib/__tests__/sectorBenchmark.test.tsx` (17) and the
`ratio tile: where the band comes from` block of
`frontend/lib/__tests__/ratioCompareTab.test.tsx` (2). Both read the committed
document `frontend/lib/__tests__/fixtures/sectorBenchmark/served_pair.json`,
which `tests/engine/test_sector_benchmark_route_real_app.py::test_the_committed_frontend_fixture_is_what_this_route_serves`
holds byte-for-byte to what the route serves — so the FE gates cannot drift
onto a document the engine would never send.

| # | Plant | Reds | Excerpt |
|---|---|---|---|
| E | `lawfulFigure` no longer requires `n` (the law's door accepts a figure without a peer count) | `sectorBenchmark.test.tsx::THE LAW… > a row without n prints words, no number and no bar`, `::a sector card without n falls back to the general sentence` | `AssertionError: expected 'sourced' to be 'refused'` · `AssertionError: expected 'Sector: median 3.1%, middle half 1.3%…' to be 'General SME band, not calibrated to y…'` · `2 failed \| 15 passed` |
| F | the served minimum peer count is not enforced at the boundary (`n < minPeers` → `n < 1`) | `::fewer peers than the served minimum is words, never a median` | `AssertionError: expected { Object (median, p25, ...) } to be null` · `1 failed \| 16 passed` |
| G | the report prints a median the page does not (`r.median.replace("%", " pct")` in `sectorReportSectionHtml`) | `::page rows and report rows are the same bytes > every cell, en` and `> every cell, ro`, `::the CFO report > prints the served document…` | `AssertionError: net_margin.median: expected '3.1 pct' to be '3.1%'` · `AssertionError: net_margin.median: expected '3,1 pct' to be '3,1%'` · `3 failed \| 14 passed` |
| H | the band-source sentence written INSIDE `ratio-ladder` instead of the sibling element | `ratioCompareTab.test.tsx::ratio tile… > with one: sector lines carry n, FY and source…`, and the seven pre-existing ladder gates (G10–G12) | `expected 'Strong from 15%, Healthy from 8%, Wat…' not to contain 'Ministerul'` · `Expected: "Strong from 2×, Healthy from 1.5×, Watch from 1×, Critical below General SME band, not calibrated to your sector."` · `8 failed \| 34 passed` |

TC-11, after the repair: (E) reds on any sector figure reaching a page row, a
report cell, a ratio-card line or a movement item without its n, year or
source — the row turns into words and loses its bar. (F) reds on a median
printed on a cell thinner than the served minimum, on any surface. (G) reds
when the page cell and the report cell for the same ratio differ by one byte,
in either language — label, company, median, middle half, n, FY, position.
(H) reds on anyone folding the band's provenance into the ladder element the
ladder gates pin, and on a general ladder labelled "sector" (the same test
asserts `dio` and `gross_margin` stay general and say why).

### Repair pass, 2026-09-20 (plants J, K)

| # | Plant | Reds | Excerpt |
|---|---|---|---|
| J | the report's `cols` list drops `level`, so a band that fell back to the CAEN division is disclosed on the page and not in the report | `sectorBenchmark.test.tsx::a band that fell back to the CAEN division says so everywhere > the report row carries the division marker, byte-identical to the page` | `AssertionError: net_margin: the report row must carry the division marker: expected null not to be null` · `4 failed \| 17 passed` |
| K | the ratio tile's `data-band-source` reads the raw served card (`sectorDoc?.ratio_cards?.[engineKey]?.band_source ?? "general"`) instead of the law's door | `ratioCompareTab.test.tsx::ratio tile… > the attribute is the same decision as the sentence, never the raw card` | `AssertionError: net_margin: the hook must not claim what the line does not say: expected 'sector' to be 'general'` · `1 failed \| 42 skipped` |

TC-11, after the repair: (J) reds on a fallback band printed in the report
without its `level` cell, on a `level` cell whose bytes differ from the page's,
on a class-level band that prints a marker anyway, and on a card band line that
names a division number without saying it is a division — in either language.
(K) reds on the test hook disagreeing with the sentence the reader sees, on any
served tile, on any document. `orgScopedFetch.test.ts` now also scopes a
sector-benchmark path, and reds on a raw fetch there that does not build its
headers with `authOrgHeaders` (`expected [ 'lib/sectorBenchmark.ts' ] to deeply
equal []`). The wider `/api/period` family is deliberately NOT in scope yet —
ten further files name it and each needs its own audit.

TC-10: the size-band cut-offs, the peer minimum, the year, the peer-set
sentence and the CAEN level are interpolated from the served document; the string gate
(`EN and RO carry the same keys, and no numeral is typed into either`) reds on
any numeral typed into a `benchmarkPage.sector.*` string in either language.
TC-12 coverage: every served row, every served `ratio_cards` key, every served
`refused` key and every served reason code is asserted to have a sentence in
both languages; the report gate asserts a band-source line on more than ten
cards and none at all when no document was served. What these gates cannot
see: whether the medians are right (`test_benchmarks_ro.py`), the tenancy of
the fetch (`test_sector_benchmark_route_real_app.py`), and the rendered pixel
layout at phone width (`e2e/i18n-mobile-sweep.spec.ts` walks `/benchmark`).

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

<!-- ═══ plan/2 B3 repair (plan_contract_v2 28.3, convergence review of B3) ═══
     Two medium defects repaired with their gates: the days basis quoted a
     methodology ratio under the ratio table's name (R8), and tax_rate had
     two derivations (contract 4). Low findings closed in the same files:
     the ai_audit jurisdiction rung, the rungs passed over, the statutory
     value against its pack record, and the R16 precondition built rather
     than borrowed from the corpus. -->

### forecast-defaults — plan/2 B3 repair: the ratio table's own days value, the rungs passed over, the jurisdiction rungs

Added to `tests/engine/test_forecast_tier_ladders.py`:

* `test_the_days_basis_quotes_the_served_ratio_tables_own_value` — the
  dio_cogs_days / dpo_cogs_days basis quotes `ratio_table.dio|dpo`, the value
  `engine.ratios.table.build_ratio_table` computes (inventory or accounts
  payable x period days / total operating expense), and never
  `methodology.ratios` (which divides by cost of sales). Checked against
  `tests/engine/fixtures/firm/served_metrics.json` at that file's own rounding
  (the finest decimal places its dio/dpo values carry, 4, plus half a
  micro-day). Printed: `ratio-table quotes checked 6` (realestate has no cost
  of sales, so its two drivers are absent and quote nothing).
* `STEPS` — the rungs each driver passed over, as data, keyed (driver, end
  tier, rule); every driver of every response and of four built SYNTHETIC
  shapes (agras with no depreciation charge, no interest income, no financial
  income, no financial expense) must record exactly those steps. Printed:
  `built step shapes 4`.
* `test_the_jurisdiction_is_read_from_pack_provenance_then_ai_audit` — an
  envelope with only `ai_audit.jurisdiction` reaches the macro and statutory
  rungs; with both present `pack_provenance` wins (and a HU pack_provenance
  beside an RO ai_audit refuses).
* `test_the_statutory_rung_holds_the_pack_records_value` — the record's value
  is moved by 0.03 in a tmp copy of `ro_macro.yaml`; the rung must follow.
* The R16 refusal test and the statutory-deletion plant test now build their
  precondition (account 121 forced one unit off the reconstruction) instead of
  relying on no corpus book tying.
* `PLAN_LOCAL_XLSX=<local trial balance>` prints the local book's jurisdiction
  source from the scope test (opt-in, never in the battery). Run on the local
  Scandia FY2025 book: `jurisdiction source, local book
  scandia_trial_balance_2025_downloaded.xlsx: pack_provenance=RO`.

| | |
|---|---|
| work count | unchanged, `GATE-WORK forecast-defaults units=(\d+)`, floor **150** |
| canary | adds `built step shapes`, `ratio-table quotes checked` |

**GREEN** — `34 passed`; `PASS forecast-defaults (2.1s, 160 drivers checked)`.

**PLANT R1** — quote methodology.ratios, in `src/engine/forecast/assumptions.py`
(`BookContext.from_payload`):

```
-        return cls(jurisdiction, source, ratio_table_days(payload))
+        return cls(jurisdiction, source, {"dio": dict(envelope["methodology"]["ratios"]["days_inventory_outstanding"], operands=[]), "dpo": dict(envelope["methodology"]["ratios"]["days_payable_outstanding"], operands=[])})
```

**RED (plant)** — `3 failed, 31 passed`:

```
E   AssertionError: agras dio_cogs_days quotes ratio_table.dio = 45.548379, the served ratio table reads 31.5035 (tolerance 0.0000505, 4 places)
E     agras dpo_cogs_days quotes ratio_table.dpo = 36.641162, the served ratio table reads 26.6422 (tolerance 0.0000505, 4 places)
E   AssertionError: carniprod dio_cogs_days quotes ratio_table.dio = 61.458927, the served ratio table reads 37.662 (tolerance 0.0000505, 4 places)
E   AssertionError: retail dio_cogs_days quotes ratio_table.dio = 38.362280, the served ratio table reads 30.4348 (tolerance 0.0000505, 4 places)
```

**RED (parent commit)** — the repaired gate file on a detached worktree of
`01a8894` (`wave/plan-b3` before the repair):

```
E   AssertionError: agras dio_cogs_days quotes methodology.ratios
E     agras dio_cogs_days quotes the ratio table 0 times
E   AssertionError: carniprod dio_cogs_days quotes methodology.ratios
E   AssertionError: retail dio_cogs_days quotes methodology.ratios
E   AssertionError: no ratio-table quote was checked (TC-3)
```

**PLANT R2** — the tax macro rung records no step (`steps=steps` ->
`steps=()`). **RED** `12 failed, 22 passed`:
`E   AssertionError: agras h3 tax_rate: fallback_steps [], the ladder passed over [('book', 'absent')]`.

**PLANT R3** — the payout convention rung records no book step. **RED**:
`E   AssertionError: agras h3 dividend_payout_pct: fallback_steps [], the ladder passed over [('book', 'absent')]`.

**PLANT R4** — the capex no-charge terminal rung records no rejected
maintenance step. **RED** `1 failed, 33 passed`:
`E   AssertionError: agras without a depreciation charge capex_pct_of_revenue: fallback_steps [], the ladder passed over [('convention', 'rejected')]`.

**PLANT R5** — the statutory integer as a code literal
(`rate = _micros_of(statutory.value)` -> `rate = micros_from(0.16)`). **RED**
`1 failed, 33 passed`:
`E   AssertionError: the statutory rung holds 160000 with the pack record at 0.19 (was 0.16)`.

**PLANT R6** — drop the ai_audit rung (`("pack_provenance", "ai_audit")` ->
`("pack_provenance",)`). **RED** `1 failed, 33 passed`:
`E   AssertionError: assert (None, None) == ('RO', 'ai_audit')`.

**PLANT R7** — read ai_audit first. **RED** `1 failed, 33 passed`:
`E   AssertionError: assert ('HU', 'ai_audit') == ('RO', 'pack_provenance')`.

R2-R7 guard correct parent behaviour (the parent passes them): each records
the plant red only. **REVERT** — each plant applied by
`scratchpad/b3r/plant.py` from a byte copy and restored from it
(`assumptions.py` sha1 fb2d2ceb1aaefa8472e87c5e7529f1d93bd52ae6 before and
after every plant).

**After the repair it also reds on (TC-11):** a days basis quoting any value
under the ratio table's name that is not engine.ratios.table's own, or quoting
methodology.ratios; a rung passed over and not recorded, or a driver ending on
a rung the STEPS table does not name; a statutory integer that does not follow
its pack record; the jurisdiction read from anywhere but pack_provenance, then
ai_audit.
**It cannot see:** the payables operand mismatch between the model
(canonical trade payables) and the ratio table (balanceSheet.accountsPayable)
— the quote renders the ratio table's own operands rather than claiming one
figure; it is recorded for the owner, not gated.

### forecast-authority — plan/2 B3 repair: one tax derivation, the hand-over, and the SYNTHETIC tying books

B3 left `tax_rate` with two derivations: `engine.forecast_drivers.derive`
kept its own `_tax_rate` (a class-69 account must stand behind the charge AND
the build-up must reach account 121) while the model applied the engine's
existing effective-rate rule (positive pre-tax result, reconstruction reaching
account 121 with nothing unexplained), which contract 3.4 and R16 name as the
book rung. On a book that ties with a nil charge and no class-69 account the
model measured 0% and the drivers refused; B3's AbsentHandover then made the
drivers path take the 16% statutory rung, so the same book projected 0 tax on
GET and 549,384.54 RON of tax over three years on the drivers path. The repair
makes derive.py read `_from_engine("tax_rate")` like the other shared concepts
and deletes the second rule.

Added to `tests/engine/test_forecast_driver_authority.py`:

* `compare_book` also compares every shared concept after
  `model_overrides` is applied: the drivers path and the GET path must hold
  one tier and one integer.
* `test_a_tying_book_holds_one_tax_rate_on_both_paths` over two SYNTHETIC
  books (TC-13): retail with its account-121 gap removed, with no class-69
  account and with a nil 691. Both must hold the engine's measured nil rate
  (book, 0) alone, in the drivers package and after the hand-over.

| | |
|---|---|
| work count | `GATE-WORK forecast-authority units=(\d+)`, floor raised **50 -> 140** (measured 150: the 52 of B3, plus 12 hand-over comparisons x 4 books, plus 25 x 2 SYNTHETIC books) |
| canary | adds `each concept compared alone and after the hand-over` |

**SCOPE** — printed: `SCOPE forecast-authority (plan/2 B3, contract 4): books
agras, carniprod, realestate, retail; one period each (history is B7);
SYNTHETIC books SYNTHETIC retail-ties-nil-class-69, SYNTHETIC
retail-ties-no-class-69; shared concepts from authority.CONCEPTS (status
supplied) plus the macro anchor; each concept compared alone and after the
hand-over`.

**GREEN** — `10 passed`; `PASS forecast-authority (1.3s, 150 shared-concept
comparisons)`.

**PLANT T1** — restore the second rule: `src/engine/forecast_drivers/derive.py`
replaced by its pre-repair bytes (the `_tax_rate` class-69 rule and its
dispatch). **RED (plant)** `3 failed, 7 passed`:

```
E   engine.forecast.errors.AssumptionError: assumption 'tax_rate': a hand-over carries None in None, and this driver holds micros
E   AssertionError: SYNTHETIC retail-ties-no-class-69 effective_tax_rate (tax_rate): drivers ABSENT, model measured 0
E     SYNTHETIC retail-ties-no-class-69 effective_tax_rate (tax_rate): the hand-over moves the model from book 0 to macro 160000
```

(The first line is a second defect of the same rule on the nil-class-69 book:
its `derived 0.0` driver crossed with no exact integer and the model refused
the hand-over.)

**RED (parent commit)** — the repaired gate file on the detached worktree of
`01a8894`: the same three reds (`zz_b3r_test_forecast_driver_authority.py`,
`test_a_tying_book_holds_one_tax_rate_on_both_paths[SYNTHETIC
retail-ties-no-class-69]` and `[... nil-class-69]`, and the scope check).

**REVERT** — derive.py restored from its repaired byte copy (sha1
d23afb774eab0fda2bee3af91a897f0942960837 before the plant and after the
revert); `10 passed` after.

**Retired / restated in this commit, by name (test_forecast_drivers.py):**
`test_hx2b_a_tying_book_with_no_charge_account_still_refuses` RETIRED,
replaced by
`test_hx2b_a_tying_book_measures_the_same_nil_rate_with_or_without_a_charge_account`
(new assertion: both packages and the crossing hold book 0 with and without a
class-69 account, and GET and the drivers path charge the same tax).
Restated over the one derivation: `test_hx1` (a zero no class-69 account
stands behind is never a book rate unless the book ties), `test_hx2` (the
measured nil carries the engine's sentence), `test_hx3` (one tier and one
integer, and the crossing keeps them), `test_hx4` (comment), `test_hg1`,
`test_hg2`, `test_hg4`, `test_hg5`, `test_hg8` (the book rung refused with the
engine's reason recorded as the first fallback step; the statutory rung
taken), `test_hg6` (the distance pin moves to
`engine.forecast.history.unexplained_vs_filed`), `test_d5` (status mirrors
the engine tier), `test_j9` (the absent hand-over is built from a copy whose
jurisdiction is not recorded), `test_j17` (a percentage quoted verbatim from a
rejected rung's recorded reason is the refused measurement, not a threshold).

**After the repair it reds on (TC-11):** a shared concept whose model value
moves when the drivers' hand-over is applied; either SYNTHETIC tying book
holding anything but the engine's measured nil rate on any path; everything
it redded on at B3.
**It cannot see:** constructed shapes other than the two SYNTHETIC tying
books; whether the engine's rule is right (forecast-model's nil-charge and
p121 tests own that).

## statements-anchor-gap

Production lineage (fix/parser-v6-port, merged here on feat/forecast-scenarios-live):
Parser v6 (owner ruling 2026-09-18: the 609/709 double count is a P0;
2026-09-21: v6 is correct and ships as its own deploy). Ported from
wave/forecast-v15's plan/2 B4a (ca2e40c, 4d97d9b, 6f2db0f, 22fb9db,
641d519) onto the production tree without any forecast/plan code.
`tests/engine/test_statements_anchor_gap.py`, registered in
`scripts/run_battery.py` beside `cron-auth`.

plan/2 B4a (plan_contract_v2 5.1 / 28.3 B4; owner ruling 2026-09-18: the
609/709 double count is a P0, fixed with a RED test first).
`tests/engine/test_statements_anchor_gap.py`, registered in
`scripts/run_battery.py` under the plan/2 B4a anchor.

THE DEFECT. Saga exports that close class 6/7 into account 121 print each
P&L row's cumulative value on both turnover sides ("mirrored"). For an
account whose nature is contra to the bucket it lands in — 609 supplier
discounts in operating expenses, 709 customer reductions in revenue — the
exporters disagree on the sign: the frozen Scandia golden and both local
Scandia years write the reductions NEGATIVE, the retail, agras and
carniprod exports write them POSITIVE. `accounts_to_assemble_shape` took
the printed sign as the entry's direction, so on the positive-writing books
every supplier discount was ADDED to operating cost and every customer
reduction ADDED to revenue: retail opex 16,640,349.00 for 14,105,136.48,
revenue 79,510,264.65 for 79,018,306.77, and a reconstruction that missed
account 121 by 2,043,254.64. The served-P&L guard `pl_sanity` (PL3) pinned
the same reading as its law, so the correct statement would have been
refused by the live pipeline.

THE REPAIR. Each contra FAMILY (609 cost reductions, 709 revenue
reductions) is decided once per document from that family's own mirrored
rows (`trial_balance_parser.contra_reading`: the net is positive only when
reductions print positive; a family with no mirrored row decides nothing
and nothing flips; a document whose families disagree is served as
`mixed`) — never a per-row guess. Under `entry_magnitude` a mirrored contra
row enters its bucket negated; under `natural_signed` it enters as printed.
The contra nature is the canonical schema's declared sign meaning of the
leaf, never a hand-kept list. `pl_sanity.class_movement` reads the same
row through the same `contra_reading`. `PARSER_VERSION` moves
`tb_parser_v5` -> `tb_parser_v6`, so a re-parsed period is told from a
stale one.

WHAT THE GATE CHECKS. On every corpus book, the Scandia regression baseline
(aggregates only) and any book in `PLAN_LOCAL_XLSX`,
`|account 121 - reconstruction|` is printed and must be within a floor
rendered from `packs/ro/statements_anchor.yaml#anchor_gap` and the book
(TC-10): the cent tolerance plus the turnover of the book's 711/712 rows.
On retail, which has no 711, the floor is one cent. Then: retail
reproduces 121 to the cent; every mirrored contra row of every corpus xlsx
enters as a reduction under its document's convention; the metamorphic
pair (the same ledger rewritten into the other convention) is identical on
revenue, cost of sales, operating cost and the reconstruction; 781 is
never contra to its bucket; four test-built documents (609-only, 709-only,
mixed, storno-heavy) each decide by their own family's net.

| | |
|---|---|
| work count | `GATE-WORK statements-anchor-gap units=(\d+)` (books judged + mirrored contra rows checked + metamorphic comparisons + decision-rule documents; measured 63 on the port), floor 58 |
| canaries | `SCOPE statements-anchor-gap (plan/2 B4a, contract 5.1)`, `floor from packs/ro/statements_anchor.yaml#anchor_gap`, `convention per document`, `mirrored contra rows checked` |

**SCOPE** — printed: `SCOPE statements-anchor-gap (plan/2 B4a, contract
5.1): books examined 14 (6 carry account 121), floor from
packs/ro/statements_anchor.yaml#anchor_gap`, one line per book with gap,
floor, hidden turnover and decided convention, then `convention per
document: ... saga_10_col natural_signed (3 mirrored contra rows, net
-226845.35); saga_10_col_agras entry_magnitude (4 ..., net 3956453.98);
saga_10_col_carniprod entry_magnitude (7 ..., net 2617417.71);
saga_10_col_realestate not_decided (0 ...); saga_10_col_retail
entry_magnitude (7 ..., net 1513585.20)` and `mirrored contra rows checked
21; metamorphic comparisons 16`.

**GREEN** (port) — `9 passed`: retail 0.00 (floor 0.01), agras
1,071,687.03 (192,091,846.34), carniprod 186,849.53 (88,453,995.51),
realestate 29,589,814.24 (29,589,814.25), saga_10_col 231,203.19
(82,948,008.60), regression baseline 519,389.11 (630,091,698.20).

**RED (parent commit)** (the v5 parser) — the gate file committed first,
run on f7fec0f9's parser, `9 failed`:

```
E   AssertionError: corpus saga_10_col_retail: |121 - reconstruction| = 2043254.64 exceeds the floor 0.01: the reconstruction misses account 121 by more than the production-variation turnover of this book can hide, so a class-6/7 row entered a statement bucket with the wrong sign
E   AssertionError: retail: the build-up reaches 1161957.98, account 121 filed 3205212.62
```

(the contra-sign and decision-rule checks red on the missing helpers).

**PLANTS, observed on the port tree** (each applied by string replacement,
the gate run, the file restored from its byte copy; sha1 checked before
and after; `48 passed, 6 skipped` over this gate plus `test_pl_sanity.py`
after the reverts):

| # | Plant | RED (plant) — result | Excerpt |
|---|---|---|---|
| P1 | `ContraReading.reads_as_reduction` returns False (the exporter's sign taken as printed) | `6 failed, 3 passed` | `corpus saga_10_col_retail: \|121 - reconstruction\| = 2043254.64 exceeds the floor 0.01` |
| P2 | `_pl_contra_to_bucket` returns `code.startswith(("609", "709", "781"))` (a hand-kept list) | `4 failed, 5 passed` | `assert not True` (781); `saga_10_col net_income_reconstructed: natural_signed 171665.97, the same ledger in the other exporter convention (entry_magnitude) -437661.51` |
| P4 | a natural-signed document flipped too (`!= CONTRA_NOT_DECIDED`) | `2 failed, 7 passed` | `saga_10_col 709101: printed -202772.78 under natural_signed entered 202772.78, want -202772.78` |
| P5 | `hidden_net_prefixes` deleted from the pack (TC-10 liveness) | `1 failed, 8 passed` | `KeyError: 'hidden_net_prefixes'` |
| P6 | `pl_sanity.class_movement` reads the printed class-70 sum (gate `tests/engine/test_pl_sanity.py`) | `7 failed, 32 passed, 6 skipped` | `saga_10_col_agras would be refused: PL3_REVENUE_IS_NOT_THE_CLASS70_CREDIT — Served revenue 110,798,309.14 does not equal the trial balance's one-sided class-70 credit 118,576,819.64` |
| R11 | the document net forced onto both families (`decided = None`) | `1 failed, 8 passed` | `SYNTHETIC mixed (709 natural-signed, 609 magnitudes): opex_excluding_cogs_and_da 16640349.00, the same ledger printed in one convention gives 14105136.48 (delta 2535212.52)` |

**REVERT** — every plant restored from the byte copy taken before it
(`scratchpad/v6_verify/plants.py`): sha1 trial_balance_parser.py
516daac7df64e1481726b28d0ae8b89c80868e3c, pl_sanity.py
d00db72b4aa0eb791e12ad267f3ee56168c09297, statements_anchor.yaml
d1a6219a12d88ef45ef8cbb066096b756cb1d124 before every plant and after
every revert; GREEN after: `48 passed, 6 skipped`.

**After the repair it reds on (TC-11):** a class-6/7 row entering its
bucket with the wrong sign on a book whose production-variation turnover
cannot hide it; a mirrored contra row entering with the exporter's sign
on an entry-magnitude document; a natural-signed document flipped; a
contra account read from a hand-kept list; a family forced onto another
family's decision; a floor written as a code literal; a scope with no
document of either convention or no book carrying account 121 (TC-3).

**It cannot see:** a wrong sign on a book whose 711 turnover is larger
than the error (agras and carniprod: the residual beyond the production
stock movement — 1,018,671.15 and 185,677.27 — is PRINTED, not judged);
non-mirrored rows (the one-side SAGA path is covered by the corpus
replay); the served statements of periods persisted before v6 (a stored
period keeps its v5 line items until its document is re-parsed —
`extraction.parser_version` tells them apart).

## interest-coverage-one-operand

The 0.32 / 0.3257 seam (owner, 2026-09-21: "confirm the served metric
equals its own recomputation; fix the 0.32 vs 0.3257 seam").
`tests/engine/test_interest_coverage_one_operand.py`, registered in
`scripts/run_battery.py` beside `statements-anchor-gap`; the frontend
halves are vitest (`interestCoverageBasis.test.ts`,
`exportRatioFormulas.test.ts` G4, and `interestCoveragePopover.test.tsx`,
the Ratios card's learning popover — see "The popover half" below).

THE DEFECT. `assembled_pl` carries two EBITs: `ebit` (revenue − COGS −
opex + other operating income − D&A) and `operating_ebit` (the operating
view: `ebit` plus 722 capitalized own work and 767 discounts received).
On the retail corpus book under tb_parser_v6 they are 1,923.78 apart
(786,579.83 / 788,503.61, interest 2,421,110.34). The engine's
`interest_coverage` row divided `ebit` (0.3249 → "0.32"); the frontend's
no-envelope credit model (`financialValuation.ts computeCreditScore`,
`c.ebitStatutory` = `operating_ebit`) and G4's recomputation divided
`operating_ebit` (0.3257 → "0.33"). One book, three printed coverages,
two numbers.

THE DECISION. The engine is internally consistent — its row
(`credit_model.operating_profit`), its coverage sub-score, its
declared-rung predicate and the ratio table's own fallback (`table.ebit`)
all divide `ebit`, and `ebit` is the EBIT the P&L PRINTS (the
ComprehensiveReport and export "EBIT" rows read `assembled_pl.ebit`, and
`ebit + net_financial_result` foots to `pretax`). So no engine number
moves: the frontend moved to the engine's operand. The credit model now
divides `ebitCoverage` (= `assembled_pl.ebit`, else the feed's reported
EBIT, else `deriveTotals`' reconstruction — the engine table's own
fallback arithmetic) for the coverage row and its debt-free declared
rung; G4 recomputes coverage and ROIC from `e.pl.ebit`. Measured on the
four firm books: only retail's no-envelope coverage VALUE moves
(0.325679 → 0.324884, printed 0.33 → 0.32); its sub-score (15), the
composite and the grade do not move on any book.

WHAT THE GATE CHECKS. On the four corpus books and the Scandia baseline
through the real GET /api/period (`_served_books`): `ebit` foots to
`pretax` with the net financial result; the served row and the
serve-time table print quantize(ebit / interest); the table's own
fallback (a payload with no metric rows) prints the same digits from the
operands it lists, and those operands build `ebit` to the cent; the
metric row carries the quotient to 4 dp. TC-3: at least two books with
positive interest and at least one (retail) on which `operating_ebit`
would print a different coverage.

| | |
|---|---|
| work count | `GATE-WORK interest-coverage-one-operand units=(\d+)` (books served + coverages recomputed; measured 9), floor 8 |
| canaries | `SCOPE interest-coverage-one-operand`, `books where operating_ebit would print a different coverage: 1`, `retail             EBIT 786579.83` |

**SCOPE** — printed: `SCOPE interest-coverage-one-operand: books 5
(agras, carniprod, realestate, retail, scandia_baseline); interest
measured on 4; books where operating_ebit would print a different
coverage: 1`, then per book `retail EBIT 786579.83 / interest 2421110.34
= 0.32 printed; served 0.32; operating_ebit 788503.61 would print 0.33`
(carniprod: interest 0.0, refused `zero_denominator`).

**GREEN** — `1 passed`; agras 28.14, realestate −25.13, retail 0.32,
Scandia baseline 13.27, each equal to its recomputation.

**PLANTS, each observed RED** (`scratchpad/v6_verify/plants_seam.py`, each
applied by string replacement, the gate run, the file restored byte-exact):

| # | Plant | Result | Excerpt |
|---|---|---|---|
| E1 | the engine metric row divides `operating_ebit` (`credit_model.py`) | `1 failed` | `retail: served interest_coverage prints 0.33, EBIT / interest recomputes 0.32` |
| E2 | the ratio table's fallback divides EBITDA (`table.py`) | `1 failed` | `agras: the table's own EBIT / interest prints 38.77, recomputes 28.14` |
| F1 | the no-envelope credit model divides `c.ebitStatutory` again (`interestCoverageBasis.test.ts`) | `1 failed` | `expected '0.33' to be '0.32'` |
| F2 | G4 recomputes from `operating_ebit` again (`exportRatioFormulas.test.ts`) | `1 failed` | `retail: a rendered ratio does not equal its stated formula` |

**REVERT** — every planted file restored from its byte copy (sha1
checked); the gate `1 passed`, `interestCoverageBasis` and
`exportRatioFormulas` `26 passed` after.

**After the repair it reds on (TC-11):** any served, serve-time or
fallback interest coverage whose printed digits are not quantize(ebit /
interest); a served `ebit` that stops footing to pretax; a scope with no
book that tells the two operands apart; (vitest) the no-envelope model or
G4 dividing any EBIT but `assembled_pl.ebit`.

**It cannot see:** books with zero interest (carniprod is refused and
printed as such); other ratios that read `operating_ebit` — the
no-envelope Altman X3 and the Piotroski operating-margin check
(`financialValuation.ts`, and the engine's own Piotroski check in
`chart_of_accounts.py`) still read the operating view; those are not
interest coverage and are reported, not changed, here.

### The popover half (`frontend/lib/__tests__/interestCoveragePopover.test.tsx`)

THE DEFECT (adversarial verifier, v6 port round 1; older than the port —
both files unchanged since f7fec0f9). The Ratios tab wraps each measured
interest-coverage card in `<LearnableNumber conceptKey="interest_coverage">`,
whose "How it's computed" popover prints `EBIT <x> ÷ Interest <y>`.
`buildReportingMetricsSnapshot` never set `interestExpense` (declared in
`_schema.ts`), and the concept printed `m.interestExpense ?? 0`: every book
with interest read `Interest 0 RON` beneath its served coverage (retail
0.32×, agras 28.14×, realestate −25.13×, Scandia 13.27×). Neither the
engine gate nor the other two vitest halves read this surface.

THE REPAIR. The snapshot carries `interestExpense` from the authority the
engine row divides — `assembled_pl.interest_expense`, else
`incomeStatement.interestExpense` (the same `pick` `financialReport.ts`
uses); a source that declares the line absent carries none. The concept's
two operands are absent-aware (`coverageOperand`): a figure the snapshot
lacks prints "Interest not reported" / "Interest neraportat" as text,
never a value token reading 0. Nothing else reads the snapshot's
`interestExpense` (the dashboard resolver, the variance lines and the
scenario cascade do not), so no other figure moves.

WHAT IT CHECKS. On the same five books (the firm books in their served
shape with the served metric map, and the Scandia baseline): the card
prints the served digits (literals re-read from the served GET); the
popover's value tokens are EBIT and Interest, equal to `assembled_pl.ebit`
and `assembled_pl.interest_expense` to the cent; token EBIT ÷ token
Interest prints the card's digits; the rendered formula prints the
interest figure and never `Interest 0 RON`. Controls: the snapshot without
`interestExpense` renders "not reported" in both languages with no
interest value token; a declared-absent source carries no figure.

**SCOPE** — printed: `SCOPE interest-coverage-one-operand (popover half):
books 5 (agras, carniprod, realestate, retail, scandia_baseline); popover
operands recomputed on 4`, then per book e.g. `retail card 0.32×; popover
EBIT 786579.83 ÷ Interest 2421110.34 = 0.32; rendered "EBIT787K
RONInterest2.42M RON"` (carniprod: card refused, no popover renders).

**PLANTS, each observed RED** (`scratchpad/v6_repair/plants_popover.py`,
each file restored byte-exact, sha1 checked):

| # | Plant | Result | Excerpt |
|---|---|---|---|
| L0 | both files as on f7fec0f9 (the pre-repair tree) | `3 failed` | `retail: the rendered popover reads "EBIT787K RONInterest0 RON"` |
| L1 | the snapshot drops `interestExpense` | `3 failed` | `retail: the popover's value tokens are [{…"conceptKey":"ebit"…}]` |
| L2 | the concept's `m.interestExpense ?? 0` restored | `1 failed` | `expected [ 'ebit', 'interest_expense' ] to deeply equal [ 'ebit' ]` |
| L3 | interest read from `financial_expense_total` | `2 failed` | `retail: popover EBIT 786579.83 ÷ Interest 3092377.62 = 0.25, the card prints 0.32×` |
| L4 | the EBIT token on `operating_ebit` | `1 failed` | `retail: popover EBIT 788503.61 ÷ Interest 2421110.34 = 0.33, the card prints 0.32×` |

**After the repair it reds on (TC-11):** the snapshot dropping or zeroing
interest; a `?? 0` operand; an EBIT or interest token read from another
authority than the engine row's; an absent operand printed as a number.
**It cannot see:** the engine row (the gate above); the export and the
no-envelope model (the other two halves); carniprod's reported 0.00
interest — its card is refused and no popover renders.

(the two contra-sign checks red on the missing parser helpers). Per book
on the parent: retail 2,043,254.64 BEYOND floor 0.01; agras -6,572,426.01
within 192,091,846.34; carniprod -4,407,915.45 within 88,453,995.51;
realestate 29,589,814.24 within 29,589,814.25; golden 231,203.19 within
82,948,008.60; baseline 519,389.11 within 630,091,698.20.

**PLANT P1** — the exporter's sign taken as printed
(`ContraReading.reads_as_reduction` returns False). **RED (plant)**
`3 failed, 2 passed`:

```
E   AssertionError: corpus saga_10_col_retail: |121 - reconstruction| = 2043254.64 exceeds the floor 0.01
E   AssertionError: retail: the build-up reaches 1161957.98, account 121 filed 3205212.62
E   AssertionError: saga_10_col revenue: natural_signed 48349081.59, the same ledger in the other exporter convention (entry_magnitude) 48802772.29
```

**PLANT P2** — a hand-kept account list in place of the schema's sign
meaning (`_pl_contra_to_bucket` returns `code.startswith(("609", "709",
"781"))`). **RED (plant)** `4 failed, 1 passed`: the 781 check reds
(`assert not True`) and, because the provision reversals were flipped, the
anchor gap reds too:

```
E   AssertionError: corpus saga_10_col_retail: |121 - reconstruction| = 155869.22 exceeds the floor 0.01
E   AssertionError: retail: the build-up reaches 3049343.40, account 121 filed 3205212.62
```

**PLANT P3** — a per-row guess (flip any positive mirrored contra row,
ignore the document's decision). **RED (plant)** `3 failed, 2 passed`: the
retail stornos (609.304 -34,053.41, 609.904 -7,429.40) enter unflipped:

```
E   AssertionError: corpus saga_10_col_retail: |121 - reconstruction| = -82965.62 exceeds the floor 0.01
E   AssertionError: saga_10_col_carniprod 6090.03: printed -892.09 under entry_magnitude entered -892.09, want 892.09
```

**PLANT P4** — a natural-signed document flipped too (`!= CONTRA_NOT_DECIDED`
in place of `!= CONTRA_ENTRY_MAGNITUDE`). **RED (plant)** `1 failed, 4
passed`:

```
E   AssertionError: saga_10_col 709101: printed -202772.78 under natural_signed entered 202772.78, want -202772.78
E     saga_10_col revenue: natural_signed 48802772.29, the same ledger in the other exporter convention (entry_magnitude) 48349081.59
```

**PLANT P5** — the floor's `hidden_net_prefixes` deleted from the pack
(TC-10 liveness). **RED (plant)** `1 failed, 4 passed`:
`E   KeyError: 'hidden_net_prefixes'`.

**PLANT P6** — the served-P&L witness reads the printed class-70 sum
(`pl_sanity.class_movement`, `c70_c += st_c` unconditionally), gate
`tests/engine/test_pl_sanity.py`. **RED (plant)** `7 failed, 32 passed, 6
skipped`:

```
E   AssertionError: saga_10_col_agras would be refused: PL3_REVENUE_IS_NOT_THE_CLASS70_CREDIT — Served revenue 110,798,309.14 does not equal the trial balance's one-sided class-70 credit 118,576,819.64, its 709 reductions read under the document's contra convention (entry_magnitude; drift -7,778,510.50)
E   AssertionError: saga_10_col_carniprod would be refused: PL3_REVENUE_IS_NOT_THE_CLASS70_CREDIT — Served revenue 94,509,939.96 does not equal ...
```

**REVERT** — each plant applied by string replacement to
`trial_balance_parser.py`, `pl_sanity.py` or `statements_anchor.yaml`,
observed, and the three files restored from byte copies (sha1
f28ee5c899cf2fb503f668e1e9de54de9cf9e1a0, d00db72b4aa0eb791e12ad267f3ee56168c09297,
715f19a92dfc694cab48ef2ca4bf68eb7d4aed7c before every plant and after
every revert); `5 passed` after.

**Retired / restated in this commit, by name:**
`tests/engine/test_pl_sanity.py::test_revenue_is_exactly_the_one_sided_class70_credit`
pinned the defect as law (revenue = the printed class-70 sum) and is
restated: the one-sided class-70 credit reads each mirrored 709 row under
the document's convention; new
`test_the_witness_reads_a_mirrored_709_as_a_reduction_on_entry_magnitude_books`
proves the witness differs from the naive printed sum by twice the mirrored
709 on entry-magnitude books and equals it on natural-signed ones.
`tests/engine/test_insights_wire.py::test_agras_serves_the_reconstruction_gap`
and `::test_agras_carries_all_eight_findings_into_the_summary_ordering`
pinned agras's 46.6% reconstruction gap, most of which was the double count;
restated to the measured 16.6% (+1,071,687.03, the hidden 711 net) and the
ranking it gives.

**After the repair it reds on (TC-11):** a class-6/7 row entering its
bucket with the wrong sign on a book whose 711 turnover cannot hide it
(retail, floor one cent); a mirrored contra row entering with the
exporter's sign on an entry-magnitude document; a natural-signed document
flipped; a per-row guess; a contra account read from a hand-kept list; a
floor whose data is not in the pack; the served-P&L witness disagreeing
with the assembler; a scope with no document of either convention or no
book carrying 121.
**It cannot see:** a wrong sign on a book whose 711 turnover is larger than
the error (agras and carniprod on the parent parser were inside their
floors; retail decided); a document whose contra rows net positive only
because stornos outweigh the reductions they reverse; non-mirrored rows;
the served statements of periods persisted before this repair (they need
re-processing; the count is owed by the owner, forecast_blast_radius.md
under 609).

## forecast-pools

plan/2 B4b (plan_contract_v2 5.1, 5.2, 5.3, 5.6; 28.3 B4, the pools half
after the B4a statements repair). `tests/engine/test_forecast_pools.py`,
registered in `scripts/run_battery.py` under the plan/2 B4b anchor; pack
`packs/forecast/cost_behaviour.yaml` (new), engine `src/engine/forecast/pools.py`
(new).

THE DEFECT (0.1, the engine half). The engine priced cost of sales and
operating costs as SHARES of each period's revenue (`cogs_pct_of_revenue`,
`opex_pct_of_revenue`), so every cost was fully variable: a revenue fall took
personnel and rent down with it, the opposite error to the page cascade's
flat cost of sales. The measured fixed share of operating cost (agras
0.739606 by the pack's prefix classification) never reached the model, and
forecast_drivers held a SECOND derivation of it (a leaf-based nature split in
`drivers.yaml`) that disagreed with anything the engine could have said.
Other operating income was grown with revenue.

THE REPAIR. The anchor's `statement_line_items` rows are the only pool
source: `operatingExpenses` rows split into the pools of
`cost_behaviour.yaml#prefix_to_pool` by longest account prefix (a prefix under
two pools refuses at load; a pooled prefix with no `nature` refuses at load),
`cogs` rows are the cost_of_sales pool, `envelope.leaves` is never read. Each
opex pool resolves a fixed share down the 5.2 ladder — nil pool (base 0) ->
fixed 0 by convention; a NET-CREDIT pool (retail materials_non_inventory,
-1,071,951.53, where the 609 supplier discounts outweigh the materials) ->
fixed 0 by convention `#negative_pool` (a credit that scales with purchases
follows volume; the classification share of a negative base is meaningless);
book two_point_fit recorded absent ("prior periods are not read in this
build", B7); sector absent; convention classification = fixed-classified
amount / pool amount; then the cap: a variable base above
`#variable_base_max_share_of_revenue` x revenue is served fully fixed with the
rejected rung kept. `unallocated_operating` follows the amount-weighted share
of the pooled costs. A split that cannot be made refuses BY NAME into one
pool `operating_costs` (`#max_unallocated_share`, `#rows_disagree`,
`#no_line_items`), never a guessed split. `project()` then carries, per plan
year n, F = round(B x f x C(n)) and V = round(B x G(n)) - round(B x f x G(n)),
each ONE exact rational rounded once (5.3), sliced by days; cost of sales is
fixed share 0 by convention `#cogs_variable`; other operating income is held
(`other_operating_income_annual`, 5.5). `inflation` joins KEYS (macro anchor,
else `levers.yaml#inflation.terminal_rung`); `cogs_pct_of_revenue`,
`opex_pct_of_revenue` and `other_operating_income_pct_of_revenue` leave it.
The per-book drivers `pool_fixed_share.<pool>` (cost_of_sales first) and
`pool_level.<opex pool>` (neutral, `levers.yaml#index_neutral`) expand from
the two `levers.yaml#pools.templates` entries; forecast_drivers reads the
engine's `pools.opex_fixed_share` / `pools.cost_of_sales_share` /
`pools.operating_cost_share` facts (concept status `read`, contract 4) and its
leaf split is deleted.

WHAT THE GATE CHECKS (5.6, no shocks): on the four books the pools plus
unallocated equal `opex_excluding_cogs_and_da` to the cent and the projection
runs on that split (shares printed, unallocated amount and share printed
beside the refusal cutoff rendered from the pack); the amount-weighted fixed
share computed in the test equals the engine fact equals forecast_drivers
`opex_fixed_share`, to the micro; the cap checked DIRECTLY on every non-user
pool (capped names and counts printed; realestate must cap, and must cap
third_party_services); at revenue_growth -0.20 and inflation 0, plan-year-one
cost of sales equals mul_div(base, 800000, MICRO) and operating costs equal
the 5.3 formula evaluated in the test per pool; nil-pool counts printed; a
test-built agras without its 624 rows serves transport_logistics on the
nil_pool rung (fixed 0, convention, book and sector absent, classification
rejected "nil pool") and projects; the pack refuses a duplicate prefix and an
unclassified prefix at load.

| | |
|---|---|
| work count | `GATE-WORK forecast-pools units=(\d+)` (sum, share, cap, growth and nil checks; measured 53), floor 50 |
| canaries | `SCOPE forecast-pools (plan/2 B4b, contract 5.6)`, `capped pools per book`, `nil pools per book` |

**SCOPE** — printed: `SCOPE forecast-pools (plan/2 B4b, contract 5.6): books
agras, carniprod, realestate, retail; horizon 1 for the year-one checks (2 for
the nil shape); no shocks; SYNTHETIC agras without its 624 rows
(transport_logistics nil); pack packs/forecast/cost_behaviour.yaml`, then
`capped pools per book: agras 0 (none); carniprod 0 (none); realestate 3
(energy_utilities, third_party_services, materials_non_inventory); retail 0
(none)` and `nil pools per book: ... 1 (unallocated_operating)` on each.

**GREEN** — `25 passed`. Measured fixed shares (amount-weighted): agras
0.739606, carniprod 0.749519, realestate 0.999978 (three pools capped against
revenue of 162,365.46), retail 0.808766.

**RED (parent commit)** — the gate file on fa2a04c (the B3 engine over the
repaired books): `ERROR collecting tests/engine/test_forecast_pools.py —
ModuleNotFoundError: No module named 'engine.forecast.pools'` — the parent has
no pool split; its operating cost is one share of revenue.

**PLANT P1** — the nil_pool rung deleted (`_classified_pool` no longer
branches on base 0). **RED (plant)** `1 failed, 24 passed`:

```
FAILED tests/engine/test_forecast_pools.py::test_a_book_whose_pool_is_nil_serves_the_nil_pool_rung_and_projects
E   ValueError: denominator must be positive, got 0
```

(the test-built book refuses instead of projecting). **REVERT** byte copy restored, sha verified.

**PLANT P2** — one 641 row dropped from the pool input. **RED (plant)**
`7 failed, 18 passed`:

```
E   AssertionError: agras: the split did not come from the line items (rows_disagree, packs/forecast/cost_behaviour.yaml#rows_disagree)
```

(every book's sum check reds: the rows no longer tie to the assembled figure
and the split refuses by name). **REVERT** ok.

**PLANT P3** — forecast_drivers derives its own opex fixed share (reads a
different fact than the pool split). **RED (plant)** `4 failed, 21 passed`:

```
E   AssertionError: agras: forecast_drivers opex_fixed_share 636807, the engine's pool split 739606 — two derivations of one concept (contract 4)
```

**REVERT** ok.

**PLANT P4** — the cap removed (`_cap` returns every pool). **RED (plant)**
`2 failed, 23 passed`:

```
E   AssertionError: realestate energy_utilities: variable base 210,740.84 exceeds 1.0 x revenue 162,365.46 = 162,365.46 and the pool was left variable
```

**REVERT** ok.

**PLANT P5** — cost of sales grown with the inflation index instead of
revenue growth. **RED (plant)** `3 failed, 22 passed`:

```
E   AssertionError: agras: plan-year-one cost of sales 70,557,114.68, expected 70,557,114.68 x 0.8 = 56,445,691.74
```

(realestate, whose cost of sales is nil, cannot see this plant — the TC-3
companion asserts a book with cost of sales is in scope). **REVERT** ok.

**PLANT P6** — fixed shares ignored (every pool fully variable). **RED
(plant)** `4 failed, 21 passed`:

```
E   AssertionError: agras: plan-year-one operating costs 23,883,925.42, the 5.3 formula gives 28,300,097.59 (delta -4,416,172.17)
E     personnel base 20,642,734.00 fixed 100.0000% -> fixed part 20,642,734.00 + variable part 0.00
```

**REVERT** ok.

**IT CANNOT SEE:** a shock (B5, scenario-cost-behaviour); the two-point fit
rung (B7); the served bytes of the pools (B6); a wrong prefix-to-pool map
that still ties to the cent (the classification is pack data, argued in
`cost_behaviour.yaml`, not measured here).

### forecast-base-parity — plan/2 B4b: parity mode

Re-pointed from delta mode (B2/B3) to PARITY MODE (contract 5.3). Reference
`tests/engine/fixtures/forecast/base_b3_growth0.json` (recorded fa2a04c: the
B3 engine over the B4a-repaired books, `revenue_growth` 0, four books,
total_years 5, windows 12 and 24). Today's engine runs with `revenue_growth`
AND `inflation` at 0 and no shocks; revenue must match exactly in every
period and plan year; every other cell may differ only within a bound
RENDERED FROM THE RUN and printed beside it: per share-priced line and period
`ceil(|revenue_p| / (2 x MICRO))` (the B3 share rounded to micros) +
`ceil(share_micros / MICRO)` (the revenue slice's minor-unit rounding
multiplied through the share — on realestate operating cost is 180x revenue,
so one minor unit of revenue moved the B3 line by 180) + 1 (final rounding)
+ 2 per pool (a pool sliced in two parts); EBITDA the sum of the three;
balances and every line downstream of a balance the accumulation since the
anchor; the year-to-date tax line and what it reaches twice the accumulation
(a period's charge is the difference of two accumulated figures). The bound
inputs (revenue, the three B3 shares in micros, pool counts) are printed per
book and window.

| | |
|---|---|
| work count | `GATE-WORK forecast-base-parity units=(\d+)` (measured 12084 over both windows), floor 12000 (was 4700 in delta mode) |
| canaries | `SCOPE forecast-base-parity (parity mode, plan/2 B4b)`, `366-day plan year per book`, `bound inputs` |

**GREEN** — `7 passed`; differences w12 1504, w24 2284, 0 outside bound; the
tightest cell is carniprod w12 pl.operating_costs FY2027 delta -4720 against
bound 4744 (the share rounding at its theoretical maximum on an annual
period), then realestate pl.ebitda 2026-02 +135 against 207 (the slice
multiplied through the 180x share). Revenue exact on 16 + 28 periods per book.

**RED (parent commit)** — the file on fa2a04c, `5 failed, 2 passed`:

```
E   engine.forecast.errors.AssumptionError: assumption 'overrides': unknown driver(s): inflation. Known: revenue_growth, cogs_pct_of_revenue, opex_pct_of_revenue, other_operating_income_pct_of_revenue, ...
```

(the parent knows no `inflation` driver and still carries the three share
keys, so the parity run cannot even be made against it).

**PLANT** (held in the file) — one minor unit above the bound on agras
pl.cost_of_sales 2026-01 reds naming `agras w12 pl.cost_of_sales 2026-01 ...
[OUTSIDE BOUND]`; revenue sliced by `days_m / days_basis` reds the 366-day
plan year (`agras w12 pl.revenue plan year 3`); a move inside the bound is
printed, not red.

**RETIRED** with the re-point: `test_base_parity_delta_mode_moves_only_the_changed_closure`
and the CHANGED-closure law (its B2 plant, one minor unit of other financial
expense outside the closure, is replaced by the bound plant above; B4b's held
other operating income and the pools move every operating line, so a closure
law over `base_get_b0.json` would have needed every line in CHANGED).
`base_get_b0.json` stays as the blast-radius baseline only.

### forecast-route — plan/2 B4b: the GET canary (28.3 B4)

`test_get_through_the_real_app_answers_200_with_no_clause_violation`: GET
through `create_app()` (the org and per-user seams replaced as
`scripts/measure_plan_blast_radius.py` replaces them) on the four books at
horizons 3 and 5 answers 200, `contract.clause_violations(body) == []`, and
the served assumptions carry the EXPANDED pool ids (`pool_fixed_share.<pool>`,
`pool_level.<pool>`), never a `.*` template. Floor 22 -> 30 (31 tests).

**PLANT P7** — one pool template (`pool_level.*`) dropped from
`Projection.fp1_assumptions`. **RED (plant)** `8 failed`:

```
ERROR engine.api._forecast_routes: [forecast] contract refused period blast-radius-period: fp1 contract broken — figure_names_unknown_assumption: figure 'pl.ebit'/'2026-01' ...
E   AssertionError: ('agras', 3, 500, "{'detail': 'The projection did not satisfy its own serving contract, so it was not served.'}")
```

**REVERT** ok. **RED (parent commit)**: on fa2a04c the GET answers 200 but no
served assumption id starts with `pool_fixed_share.` (the parent has no
pools), so the canary reds on its id check.

### plan/2 B4 REPAIR ROUND (2026-09-20) — the verifier's unheld behaviours, each with its red

Every plant below was applied by byte-exact replacement, run, and reverted by
byte copy of the pre-plant file (`scratchpad/b4r/plant.py`; log
`scratchpad/b4r/plants.log`). Each names WHAT IT REDS ON AFTER THE REPAIR
(TC-11): none of these tests pins a served number that the repair itself
would have to move.

**R1 — absent cost total read as zero** (forecast-model,
`test_an_absent_cost_total_refuses_the_plan_by_its_pool`; 8 cases = cogs / opex
× agras / retail × missing / null, + the served-unavailable cases + the true-nil
control on realestate). Plant: `split_for_payload` reads
`cents_from(pl.get("cogs") or 0)` again. **RED**:

```
tests/engine/test_forecast_model.py:1761: Failed: DID NOT RAISE <class 'engine.forecast.errors.AssumptionError'>
FAILED ...::test_an_absent_cost_total_refuses_the_plan_by_its_pool[pool_fixed_share.cost_of_sales-agras-cogs-missing]
```

Reds after the repair on: any path that projects a cost line whose assembled
total is missing or null. Does not red on a true 0.00 (realestate control).

**R2 — inflation dropped from the fixed part** (forecast-pools,
`test_inflation_moves_each_pools_fixed_part_and_leaves_the_variable_part`, growth 0 /
inflation 5% / two plan years / four books). Plant: `fixed_total =
_round(pool.base_cents * share)`. **RED**:

```
AssertionError: agras plan year 1 at growth 0, inflation 5%: operating costs 29,854,906.77, sum of round(B x f x C^n) + variable 30,958,949.80 (delta -1,104,043.03)
```

**R3 — other operating income grown with revenue** (forecast-pools,
`test_other_operating_income_is_held_at_the_anchor_amount_through_a_fall`, which also
holds EBITDA = revenue − cost of sales − operating costs + held income per plan
year). Plant: `_slice_by_days(_round(ooi_annual * growth_factor), periods)`. **RED**:

```
AssertionError: agras plan year 1 at revenue -20%: other operating income 312,072.44, the anchor holds 390,090.55 (it scales with neither volume nor growth)
```

R2 + R3 together are the verifier's VP5 + VP6, which passed the whole engine
suite (6861 passed) on 50cc222.

**R4 — a net-credit pool served fully fixed** (forecast-pools,
`test_retail_materials_non_inventory_is_a_net_credit_served_fully_variable`). Plant:
the `#negative_pool` branch serves `fixed_share_micros=MICRO`. **RED**:
`AssertionError: (1000000, 'convention', 'packs/forecast/cost_behaviour.yaml#negative_pool')`.

**R5 — the max-unallocated refusal switched off** (forecast-pools,
`test_a_book_with_more_unallocated_than_the_pack_allows_refuses_the_split`; SYNTHETIC
agras with its class-64 rows re-coded to an account no pool lists; the untouched
book is the not-refused control). Plant: `if False and share > ...`. **RED**:
`AssertionError: (False, None)`.

**R6 — the route-to-pools join deleted** (forecast-route canary). Plant:
`"line_items": line_items,` removed from `_forecast_routes._load_period`. **RED**:

```
AssertionError: agras h3: the served pools are ['pool_fixed_share.cost_of_sales', 'pool_fixed_share.operating_costs'] — the statement line items did not reach the engine (complete and unreachable)
```

On 50cc222 this plant left forecast-route, forecast-pools, forecast-base-parity,
forecast-serving-boundary and forecast-authority green (139 passed) with the
real app answering 200 over the refused single pool.

**R7 — an absent profit-tax charge read as a measured nil** (forecast-model
`test_a_tying_book_with_no_profit_tax_row_takes_the_statutory_rung`, control
`..._whose_profit_tax_row_closes_at_nil_keeps_the_book_rung`; forecast-drivers hx1 /
hx2b; forecast-authority's two synthetic tying shapes). Plant: `charge_absent =
False`. **RED**: `AssertionError: ('book', 'derived', 0)`.

**R8 — PARSER_VERSION not bumped** (`scripts/corpus_replay.py`, byte compare of
18 cases). Plant: `PARSER_VERSION = "tb_parser_v5"`. **RED** (exit 1):
`✗ $.extraction.parser_version: expected 'tb_parser_v6', actual 'tb_parser_v5'`
on every deterministic case.

**R9 / R10 / R11 — the contra decision rule** (statements-anchor-gap, four
SYNTHETIC documents test-built from the retail corpus rows: 609-only, 709-only,
mixed, storno-heavy). R9 decides by row count (`entry[1] += (1 if st_c > 0 else
-1)`), R10 lets only the 709 family decide, R11 forces the document net onto both
families (`decided = None`). **RED** each; R11:

```
AssertionError: SYNTHETIC mixed (709 natural-signed, 609 magnitudes): opex_excluding_cogs_and_da 16640349.00, the same ledger printed in one convention gives 14105136.48 (delta 2535212.52)
```

On 50cc222 the verifier's VP3 / VP4 passed both gates (44 passed): every real
book prints both families on one sign, so the rule was unobservable.

**Floors**: forecast-pools 50 → 85 (87 measured); statements-anchor-gap 45 → 58
(61 without the two local Scandia books, 63 with).

**WHAT THE REPAIRED GATES STILL CANNOT SEE**: `pool_level.*` is served neutral
and a projection that ignored it would still pass (B5 compiles the first
non-neutral level and owns that red — VP9); the anchor-gap residual beyond the
production-stock movement is PRINTED, not judged (agras 1,018,671.15, carniprod
185,677.27, realestate −0.05).

## forecast-balance

plan/2 B5 (plan_contract_v2 28.3 B5, gate row F1). `tests/engine/test_forecast_levers_f1.py`, registered in `scripts/run_battery.py` under the plan/2 B5 anchor.

WHAT IT HOLDS. Every projected period of every run project_plan makes (base and plan) closes assets to equity plus liabilities to the minor unit, over four books x monthly_months {12, 24} x total_years {3, 5} x one lever set per shock op plus a behaviour override with a debt schedule. The test re-adds the balance sheet from the served lines; it never reads the engine's own balance_delta.

THE DEFECT. Before B5 nothing projected a lever set: the engine had no shocks, no per-year drivers and no debt rows by plan year, so F1 was held on the base run only (forecast-model). The Scenarios page computed its own cascade in the browser with no balance sheet at all (defect 0.5).

SCOPE. Printed by the test on every run (TC-13) with its GATE-WORK line; books are the four corpus fixtures, each from its own anchor; SYNTHETIC inputs are named in the scope line.

PLANT 1. add 1 minor unit to closing PP&E in one period (project.py: closing_ppe + (1 if period.index == 5 else 0)). Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/f1-1-ppe-plus-one.log).

RED (plant):

    E   engine.forecast.errors.BalanceViolation: projected period 2026-06 does not balance: assets 42,910,075.48 − (equity + liabilities) 42,910,075.47 = 0.01 (must be exactly 0)
    FAILED tests/engine/test_forecast_levers_f1.py::test_every_period_of_every_run_closes[agras-12-3]

REVERT. `git status` clean on the planted file after the run; the gate is green again.

RED (parent commit): the gate file run inside the parent tree (wave/plan-b4 5bf8b23), where the entry point it tests does not exist:

    E   ImportError: cannot import name 'BehaviourOverride' from 'engine.forecast'

AFTER THE REPAIR IT REDS ON (TC-11): any period of any run kind with a non-zero difference; a run that catches BalanceViolation and continues; a run kind of this batch missing from the scope line; a matrix cell that projected nothing. The legacy-opening plant (OpeningPositionError at period zero) stays in forecast-model, where it has lived since B0; the tornado-probe, FY-aggregate and export plants land with B11, B6 and B20, which create those run kinds.

## scenario-funding-line

plan/2 B5 (plan_contract_v2 28.3 B5, gate row S3). `tests/engine/test_scenario_funding_line.py`, registered in `scripts/run_battery.py` under the plan/2 B5 anchor.

WHAT IT HOLDS. On the Plan returned by project_plan: over four books x three template-like shock sets x volume_index {0 .. -1.0} at monthly_months 24, closing cash never below min_cash, every draw equal to the shortfall, the revolver equal to cumulative draws less repayments, next-period funding interest equal to the _period_charge identity at revolver_rate, summary and runway per 6.6, the ShortfallRefusal of 6.5 wherever a book cannot price the line it draws, and the runway annual-tail case found by integer bisection on retail.

THE DEFECT. Defect 0.3, engine half: an unpriceable funding line refused the WHOLE plan as a bare AssumptionError naming no period, so a probe could not count it as a breach and a reader got a blanket 422; the page had no floor at all (cash 6.105M to -107.630M on Scandia). There was no runway.

SCOPE. Printed by the test on every run (TC-13) with its GATE-WORK line; books are the four corpus fixtures, each from its own anchor; SYNTHETIC inputs are named in the scope line.

PLANT 1. funding draw forced to 0. Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/s3-1-draw-zero.log).

RED (plant):

    E   engine.forecast.errors.BalanceViolation: projected period 2026-02 does not balance: assets -1,278,497.27 − (equity + liabilities) 0.00 = -1,278,497.27 (must be exactly 0)
    E   AssertionError: ('agras vol 0 recession-like', BalanceViolation('projected period 2026-02 does not balance: assets -1,278,497.27 − (equity + liabilities) 0.00 = -1,278,497.27 (must be exactly 0)'))
    E   assert None == 'days_not_measured'

REVERT. `git status` clean on the planted file after the run; the gate is green again.

PLANT 2. revolver interest 0. Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/s3-2-revolver-interest-zero.log).

RED (plant):

    E   AssertionError: ('agras vol 0 recession-like', '2026-03')
    E   assert -0 == 829044
    E    +  where 829044 = _period_charge(127849727, 76350, 31, 365)

REVERT. `git status` clean on the planted file after the run; the gate is green again.

PLANT 3. revolver_rate defaulted to 0 when unavailable (`or 0`). Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/s3-3-rate-defaults-to-zero.log).

RED (plant):

    E   AssertionError: ('carniprod vol 0 recession-like', '2027-12')
    E   assert None is not None
    FAILED tests/engine/test_scenario_funding_line.py::test_the_funding_line_identities_hold_over_the_grid[carniprod]

REVERT. `git status` clean on the planted file after the run; the gate is green again.

PLANT 4. the bare AssumptionError without a period (period_label dropped). Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/s3-4-bare-error-no-period.log).

RED (plant):

    E   AssertionError: carniprod vol 0 recession-like
    E   assert None == '2027-11'
    E    +  where None = AssumptionError("assumption 'revolver_rate': the plan draws 19,851.61 on the funding line in 2027-11 and this book can...% would be an invented rate, and the cheapest one. Supply revolver_rate, or change the plan so the line is not drawn.").period_label

REVERT. `git status` clean on the planted file after the run; the gate is green again.

PLANT 5. count the annual index as months in the runway. Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/s3-5-annual-index-as-months.log).

RED (plant):

    E   AssertionError: {'bound': 'exact', 'facility_limit': {'refused': {'code': 'facility_limit_not_loaded', 'text': 'facility limit not loaded'}}, 'first_shortfall_period': 'FY2027', 'months': 12, ...}
    E   assert ('exact' == 'at_least'
    E     

REVERT. `git status` clean on the planted file after the run; the gate is green again.

RED (parent commit): the gate file run inside the parent tree (wave/plan-b4 5bf8b23), where the entry point it tests does not exist:

    E   ImportError: cannot import name 'PlanRequest' from 'engine.forecast'

AFTER THE REPAIR IT REDS ON (TC-11): served cash below the floor, a draw not equal to the shortfall, funding interest not at revolver_rate, an unpriceable line served at a zero rate or refused without its period, a runway that reads an annual period as months. AS-BUILT B0-8: carniprod's BASE plan never draws (measured), so the refusal is asserted on every cell that draws an unpriceable line (17 carniprod cells, printed) and zero such cells reds. The page-fixture plant lands with B13.

## scenario-cost-behaviour

plan/2 B5 (plan_contract_v2 28.3 B5, gate row S1). `tests/engine/test_scenario_cost_behaviour.py`, registered in `scripts/run_battery.py` under the plan/2 B5 anchor.

WHAT IT HOLDS. The shock half of S1 on four books with revenue_growth and inflation overridden to 0: template growth_pp -0.20 moves year-one cost of sales to mul_div(base, 800000, MICRO); volume_index -0.20 moves every monthly cost of sales; price_index -0.10 leaves cost of sales byte-identical; the EBITDA law where variable bases fit inside revenue; and B4R-8a: a volume move over a refused cost split refuses by name (cost_split_refused).

THE DEFECT. Defect 0.1: the page cascade held cost of sales flat under a revenue move (Scandia Recession EBITDA 54.444M to -20.257M, 42.407M understated). Over a refused split the B4 engine made every cost fully variable, the optimistic end in a downturn: measured at B4RV-4, retail served +1,956,107.72 where the measured split gives -805,701.65 (a loss served as a profit).

SCOPE. Printed by the test on every run (TC-13) with its GATE-WORK line; books are the four corpus fixtures, each from its own anchor; SYNTHETIC inputs are named in the scope line.

PLANT 1. hold cost_of_sales flat against volume (the cascade). Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/scb-1-cogs-flat.log).

RED (plant):

    E   AssertionError: agras 2026-01: cost of sales -5,992,522.07, expected -4,794,017.66
    E   assert -599252207 == -479401766
    FAILED tests/engine/test_scenario_cost_behaviour.py::test_volume_index_moves_every_monthly_cost_of_sales[agras]

REVERT. `git status` clean on the planted file after the run; the gate is green again.

PLANT 2. drop G from the variable part. Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/scb-2-drop-G.log).

RED (plant):

    E   AssertionError: agras: year-one cost of sales -70,557,114.68 under growth -20%, expected -56,445,691.74 (base -70,557,114.68)
    E   assert -7055711468 == -5644569174
    FAILED tests/engine/test_scenario_cost_behaviour.py::test_growth_pp_moves_year_one_cost_of_sales_in_full[agras]

REVERT. `git status` clean on the planted file after the run; the gate is green again.

PLANT 3. serve a volume move over a refused split. Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/scb-3-serve-refused-split.log).

RED (plant):

    E   Failed: DID NOT RAISE <class 'engine.forecast.errors.PlanRequestError'>
    FAILED tests/engine/test_scenario_cost_behaviour.py::test_a_volume_move_over_a_refused_split_refuses_by_name

REVERT. `git status` clean on the planted file after the run; the gate is green again.

PLANT 4. ignore the pool level (project.py: `operating_costs += parts`). B4R-8b: pool_level.<pool> was held by no gate; the check added here moves every opex pool's level by -5% on the four books and holds each monthly operating cost to 95% of base within one minor unit per pool, revenue and cost of sales byte-identical.

RED (plant):

    E   AssertionError: agras 2026-01: operating costs -2,535,622.20, 95% of base is -2,408,841.09 (band 8 minor units, one per pool)

REVERT. Byte-exact; the gate is green again.

RED (parent commit): the gate file run inside the parent tree (wave/plan-b4 5bf8b23), where the entry point it tests does not exist:

    E   ImportError: cannot import name 'PlanRequest' from 'engine.forecast'

AFTER THE REPAIR IT REDS ON (TC-11): a pool flat against volume, cost of sales following the selling price, a variable part that ignores growth, a downturn that raises EBITDA where costs fit inside revenue, a volume or input-price move served over a refused split, zero books meeting the law's precondition.

## forecast-magnitude

plan/2 B5 (plan_contract_v2 28.3 B5, gate row F6). `tests/engine/test_forecast_magnitude_f6.py`, registered in `scripts/run_battery.py` under the plan/2 B5 anchor.

WHAT IT HOLDS. Year-one revenue equals source x (1 + effective year-one growth) with the effective volume and price indices applied per period, within the number of rounding operations the run itself counted on year-one revenue (Projection.work; half a minor unit each). At zero growth and neutral indices year one equals source exactly. An absent source revenue refuses.

THE DEFECT. B4RV-2: pools.py read an absent assembled_pl.revenue as 0 and the engine projected revenue 0.00 (agras year-one EBITDA -102,532,231.44), where wave/plan-b3 refused the same payload. No gate compared projected revenue with its source under levers, because there were no levers.

SCOPE. Printed by the test on every run (TC-13) with its GATE-WORK line; books are the four corpus fixtures, each from its own anchor; SYNTHETIC inputs are named in the scope line.

PLANT 1. multiply revenue by 100 in the by-year loop. Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/f6-1-revenue-x100.log).

RED (plant):

    E   AssertionError: agras [default]: year-one revenue 11,356,826,687.00, source 110,798,309.14 x (1 + 1/40) with the indices applied is 113,568,266.86; difference 22486516840263/20 minor units, band 13/2 (13 rounding operations)
    E   assert Fraction(22486516840263, 20) <= Fraction(13, 2)
    E    +  where Fraction(22486516840263, 20) = abs((1135682668700 - Fraction(227136533737, 20)))

REVERT. `git status` clean on the planted file after the run; the gate is green again.

PLANT 2. stamp a year-one growth of 0.08 without applying it. Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/f6-2-growth-stamped-not-applied.log).

RED (plant):

    E   AssertionError: agras [growth override 0.08]: year-one revenue 113,568,266.87, source 110,798,309.14 x (1 + 2/25) with the indices applied is 119,662,173.87; difference -15234767503/25 minor units, band 13/2 (13 rounding operations)
    E   assert Fraction(15234767503, 25) <= Fraction(13, 2)
    E    +  where Fraction(15234767503, 25) = abs((11356826687 - Fraction(299155434678, 25)))

REVERT. `git status` clean on the planted file after the run; the gate is green again.

PLANT 3. read an absent source revenue as nil. Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/f6-3-absent-revenue-as-nil.log).

RED (plant):

    E   TypeError: unsupported operand type(s) for *: 'NoneType' and 'Fraction'
    FAILED tests/engine/test_forecast_magnitude_f6.py::test_an_absent_source_revenue_refuses_and_is_never_read_as_nil

REVERT. `git status` clean on the planted file after the run; the gate is green again.

RED (parent commit): the gate file run inside the parent tree (wave/plan-b4 5bf8b23), where the entry point it tests does not exist:

    E   ImportError: cannot import name 'PlanRequest' from 'engine.forecast'

AFTER THE REPAIR IT REDS ON (TC-11): year-one revenue outside the band on any book, a stamped growth that was never applied, a missing source revenue projected, a band the run did not render (zero counted roundings reds as vacuous). The frontend-fixture and export-formatter plants land with B9 and B20.

## period-loader-parity

plan/2 B5 (plan_contract_v2 28.3 B5). `tests/engine/test_load_period_rows.py`, registered in `scripts/run_battery.py` under the plan/2 B5 anchor.

WHAT IT HOLDS. pipeline.load_period_rows, the one module-scope period reader, rebuilds the statements GET /api/period/{id} serves: assembled_pl, assembled_bs, assembled_cf and assembled_canonical_v1 byte for byte on four books, through create_app. A rebuild failure raises StatementsRebuildError and the forecast GET answers 409 with its sentence; a period outside the resolved workspace is not found.

THE DEFECT. The forecast route had its own copy of the period read and swallowed a rebuild failure into statements=None, then projected off it. get_period, nested in a router factory, could not be imported as a loader.

SCOPE. Printed by the test on every run (TC-13) with its GATE-WORK line; books are the four corpus fixtures, each from its own anchor; SYNTHETIC inputs are named in the scope line.

PLANT 1. drop the last line item before the rebuild. Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/loader-1-drop-last-row.log).

RED (plant):

    E   AssertionError: agras: assembled_pl differs; assembled_cf differs; assembled_canonical_v1 differs
    E   assert not ['assembled_pl differs', 'assembled_cf differs', 'assembled_canonical_v1 differs']
    FAILED tests/engine/test_load_period_rows.py::test_loader_statements_equal_the_statements_get_period_serves[agras]

REVERT. `git status` clean on the planted file after the run; the gate is green again.

PLANT 2. swallow the rebuild failure into statements None. Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/loader-2-swallow-rebuild-failure.log).

RED (plant):

    E   Failed: DID NOT RAISE <class 'engine.api.pipeline.StatementsRebuildError'>
    FAILED tests/engine/test_load_period_rows.py::test_a_rebuild_failure_raises_and_a_foreign_org_is_not_found

REVERT. `git status` clean on the planted file after the run; the gate is green again.

RED (parent commit): the gate file run inside the parent tree (wave/plan-b4 5bf8b23), where the entry point it tests does not exist:

    E   AttributeError: module 'engine.api.pipeline' has no attribute 'load_period_rows'

AFTER THE REPAIR IT REDS ON (TC-11): any byte of the four keys differing on any book (named by key and book), a key absent on either side, a swallowed rebuild failure, a foreign-org period returned.

## forecast-get-b4-parity

plan/2 B5 (plan_contract_v2 28.3 B5). `tests/engine/test_forecast_get_b4_parity.py`, registered in `scripts/run_battery.py` under the plan/2 B5 anchor.

WHAT IT HOLDS. GET /api/forecast bytes on four books at horizons 3 and 5 equal the recorded B4 GET (tests/engine/fixtures/forecast/get_b4.json, a digest recorded from 5bf8b23 by the file's own --record), except the named org-row field company_name, which is printed with both values (null -> organizations.name).

THE DEFECT. Not a defect gate: B5 moves GET onto project_plan and the loader, and this gate is the proof no served byte moved. It is retired by B6 when fp1.2 replaces the bytes.

SCOPE. Printed by the test on every run (TC-13) with its GATE-WORK line; books are the four corpus fixtures, each from its own anchor; SYNTHETIC inputs are named in the scope line.

PLANT 1. add one minor unit to month-one revenue. Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/getb4-1-one-cent-of-revenue.log).

RED (plant):

    E   AssertionError: GET moved off the recorded B4 bytes:
    E       agras:h3 figure bs.ar 2026-01: recorded 872621972, served 872621973
    E       agras:h3 figure bs.cash 2026-02: recorded 201209777, served 201209778

REVERT. `git status` clean on the planted file after the run; the gate is green again.

PLANT 2. let the organization name leak into a field outside the allowed list (notes). Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/getb4-2-org-name-into-notes.log).

RED (plant):

    E   AssertionError: GET moved off the recorded B4 bytes:
    E       agras:h3 root key 'notes' moved
    E       agras:h5 root key 'notes' moved

REVERT. `git status` clean on the planted file after the run; the gate is green again.

RED (parent commit): not applicable in the usual sense and recorded as such: the fixture IS the parent commit's GET, so the gate is green on 5bf8b23 by construction. Its two plant reds above stand in for it; the census marker is kept so the entry reads as a gate that lands with a change (the GET's move onto project_plan), not as a registration of an existing test.

AFTER THE REPAIR IT REDS ON (TC-11): any served byte outside company_name differing from the recorded B4 GET, a changed status, a fixture that does not cover the eight cells.

## forecast-debt-timing

plan/2 B5 (plan_contract_v2 28.3 B5). `tests/engine/test_forecast_debt_timing.py`, registered in `scripts/run_battery.py` under the plan/2 B5 anchor.

WHAT IT HOLDS. packs/forecast/levers.yaml#debt_timing: a debt_schedule row's draws land in the first period of its plan year and its repayments in the last, on four books at monthly_months 12 and 24, with identical per-plan-year sums at both; a year beyond total_years is refused naming it.

THE DEFECT. DebtSchedule was indexed by period index, so the same plan-year schedule meant different cash timing at monthly_months 12 and 24, and a request could not state a plan year at all.

SCOPE. Printed by the test on every run (TC-13) with its GATE-WORK line; books are the four corpus fixtures, each from its own anchor; SYNTHETIC inputs are named in the scope line.

PLANT 1. land draws in the last period of the plan year. Applied to the product source, observed, reverted byte-exact (scratchpad/b5/plants.py; log scratchpad/b5/plants/debt-1-draws-land-last.log).

RED (plant):

    E   AssertionError: agras mm12: a draw of 200000000 landed in 2026-12, the first period of plan year 1 is 2026-01
    E   assert '2026-12' == '2026-01'
    E     

REVERT. `git status` clean on the planted file after the run; the gate is green again.

RED (parent commit): the gate file run inside the parent tree (wave/plan-b4 5bf8b23), where the entry point it tests does not exist:

    E   ImportError: cannot import name 'DebtRow' from 'engine.forecast'

AFTER THE REPAIR IT REDS ON (TC-11): a draw or repayment in any other period of its year, per-year sums that depend on the monthly window, a year beyond the horizon accepted, a schedule that moved nothing.

## forecast-wc-unwind (joins forecast-model)

plan/2 B5 (contract 6.2; 28.3 B5 "forecast-model command extended with test_forecast_wc_unwind.py"). Not a first registration: `tests/engine/test_forecast_wc_unwind.py` joins the forecast-model battery command, with two canaries added under the B5 anchor.

PLANT. Restore the full re-price in the period a lever lands (project.py: the unwind branch disabled).

RED (plant), both tests, as the contract requires:

    E   AssertionError: agras 2026-01 inventory 7,325,332.54, the 6.2 formula gives 7,928,198.65 (target 7,325,332.54, base target 9,156,665.67)
    E   assert 732533254 == 792819865
    E   AssertionError: retail 2026-01 inventory moved 2,089,525.72 in the month the lever landed; a month of its flow change is 1,655,171.64
    E   assert 208952572 <= 165517164

REVERT. Byte-exact; green again. SCOPE printed by the test. Measured fact recorded in the test: on agras the receivable days (28.05) are shorter than the first month, so receivables land on target inside it and only inventory (46.21 days) and payables (37.18 days) can show a full re-price; the test walks all three balances and reds as vacuous when none is still mid-unwind after month one.

RED (parent commit): `E   ImportError: cannot import name 'PlanRequest' from 'engine.forecast'` (the parent tree has no lever path to unwind).

### plan/2 B5 REPAIR ROUND (2026-09-20) — the verifier's unheld behaviours, each with its red

Eighteen plants. R1-R16 were applied by byte-exact replacement, run and
reverted by byte copy (`scratchpad/b5r2/plants.py`, log
`scratchpad/suite/b5r2_plants.log`); R17-R18 the same way by hand
(`scratchpad/b5r3`). Each names WHAT IT REDS ON AFTER THE REPAIR (TC-11); none
pins a served number the repair itself would have to move.

**R1 — the unwind measured from the first divergence ever, never reset**
(forecast-wc-unwind, `test_a_lever_that_lands_after_an_earlier_one_still_unwinds`
and the every-month formula test). Plant: the closing balance ramps from the
first period whose target ever left the base target. **RED**:

    E   AssertionError: agras 2026-04 inventory 7,325,332.53, the 6.2 trailing window gives 7,325,332.54 (target 7,325,332.53, base target 9,156,665.68)
    2 failed, 3 passed

Reds after the repair on: a lever that lands after an earlier one on the same
flow and books more than (days of the month / days in force) of ITS OWN move in
its landing month, measured against the same request without it; a shock that
ends and snaps back. Does not red on the single-step case, where the trailing
window and the contract's min(E, D) / D are the same number.

**R2 (V8) — op rank swapped, level_pct before set** (forecast-balance command,
test_plan_request_validation.py). **RED**: `E   AssertionError: ('a', 500000)` /
`assert 500000 == 550000`. Reds on: set-then-level order on one driver.

**R3 (V9) — end_month ignored.** **RED**:
`E   assert [1000000, 800...00000, 800000] == [1000000, 800...0000, 1000000]`.
Reds on: a windowed shock still in force after its end month.

**R4 (V10) — the annual tail takes the last month.** **RED**:
`E   AssertionError: (700000, 0.7246575342465753)` / `assert Fraction(9, 365) <= Fraction(1, 1000000)`.
Reds on: an annual-period compiled value that is not the day-weighted mean.

**R5 (V11) — a behaviour override's fixed_share never reaches the pool**
(scenario-cost-behaviour). **RED**:

    E   AssertionError: agras [personnel fixed share 0.50] year-one operating costs 28,300,097.58, the 5.3 formula gives 26,235,824.17 (band 384 minor units)

**R6 (V12) — tax_rate lever ignored.** **RED**: `E   assert -130963805 == -245557135`.

**R7 (V13) — volume_elasticity 0 ignored.** **RED**:

    E   AssertionError: agras [personnel fixed share 0.50, volume elasticity 0] year-one operating costs 26,235,824.17, the 5.3 formula gives 28,300,097.57 (band 384 minor units)

**R8 (V14) — min_cash lever ignored.** **RED**: `E   assert 0 == (248978821 - 148978821)`
(the draw moves by exactly the floor's move).

**R9 (V1) — the fixed part follows volume**, now held by a direct 5.3 formula
check under volume -20% on agras and retail (the owner's measured-split ruling),
not only by realestate's EBITDA law. **RED** (6 failed):

    E   AssertionError: agras [the measured split] year-one operating costs 23,883,925.44, the 5.3 formula gives 28,300,097.57 (band 384 minor units)

**R10 (V2) — only growth needs the split.** The refused-split test now sends
volume_index, input_price_index and inflation each ALONE, with no `_flat`
override. **RED** (4 failed): `E   Failed: DID NOT RAISE <class 'engine.forecast.errors.PlanRequestError'>`.

**R11 — inflation served over a refused split** (inflation dropped from
`_SPLIT_DEPENDENT`). **RED** (2 failed): `E   Failed: DID NOT RAISE <class 'engine.forecast.errors.PlanRequestError'>`.
Reds on: any inflation lever projected over `#no_line_items` (agras served
11,036,035.43 = base where the measured split gives 8,827,949.35).

**R12 (V3) — the route serves a truncated plan** (forecast-route; SYNTHETIC
carniprod whose base plan draws: payout 0.95, min_cash 2M, capex 20%, through
`create_app`). Plant: the route's `stop_at_unpriced_draw=False` flipped. **RED**:

    E   AssertionError: the GET answered 200 with 6 period(s) of 16 on a base plan that draws a line this book cannot price
    E   assert 200 == 422

**R13 — the loader accepts statements with no assembled P&L**
(period-loader-parity). Plant: the presence check loops over `()`. **RED**:
`E   Failed: DID NOT RAISE <class 'engine.api.pipeline.StatementsRebuildError'>`.
Reds on: a rebuild that swallowed its own assembly failure reaching a caller as
statements; the route answers 409 statements_rebuild_failed.

**R14 — the wire elasticity truncated** (`int(Fraction)`). **RED**:
`E   Failed: DID NOT RAISE <class 'engine.forecast.errors.PlanRequestError'>` ("0.5", "1.9", "-0.4").

**R15 — an unpriced rate refused in a days driver's words.** **RED**:
`E   assert 'days_not_measured' == 'rate_not_measured'`.

**R16 (B4RV-3) — a payload with no statement rows keeps the nil tax rate**
(forecast-model, `-k tying_book`). **RED**: `E   AssertionError: ('book', 'derived', 0)` /
`assert ('book', 'derived') == ('macro', 'engine_default')`.

**R17 — the base run inherits every override** (decision B5R-4; SYNTHETIC agras
with its interest expense removed). Plant: the base is compiled from
`request.overrides`. **RED**: `E   assert [1035129409, ...] == [964552404, ...]`
(the base's revenue moved with the request's growth). **R18 — no inheritance**
(`_BASE_PRICING_RATES = ()`). **RED**:

    E   engine.forecast.errors.AssumptionError: assumption 'interest_rate_debt': the plan carries 3,640,202.33 of interest-bearing debt in 2026-01 and this book cannot price it ...

Reds after the repair on: a request that supplies the rate the base refused for
and is still refused, or a base that takes anything but that rate. Does not red
on a request that omits the rate: it refuses, as before.
<!-- ═══ plan/2 B1 (plan_contract_v2 28.3, section 7, S7): sign flips ════════
     One battery gate (sign-flip) and two vitest canaries, landed in the
     same commit as the repair they guard (0.5): each section records the
     plant red AND the red on the parent commit eb2ff8f. -->

## sign-flip

`tests/engine/test_change_kind.py` + `tests/engine/test_comparatives.py` — S7,
defect 0.4. A change from zero, to zero or across sign is one of seven kinds
(R21) from ONE classifier per runtime (`src/engine/serving/change_kind.py`,
`frontend/lib/changeKind.ts`), both held to
`tests/fixtures/contracts/change_kind_truth_table.json`; only the kind
`compared` with a non-zero base carries a `delta_pct`
(`packs/serving/change_kind.yaml#delta_pct_places`, rounded once, half away
from zero, on the EXACT value of each binary64 in both runtimes).
`engine.comparatives.columns` keeps its disclosure statuses, sets
`change_kind` only on `compared` / `compared_no_base`, and serves no
cross-sign or to-zero percentage.

| | |
|---|---|
| command | `python -m pytest tests/engine/test_change_kind.py tests/engine/test_comparatives.py -v -s` |
| work count | sum of the printed `GATE-WORK sign-flip units=` lines (truth-table rows 70 + converted consumers 14 + comparative columns swept 255 = 339), floor **300** |
| canary | `test_the_python_classifier_matches_every_truth_table_row`, `test_a_cross_sign_column_carries_its_kind_and_no_percentage`, `SIGN-FLIP truth table (python)` |

**SCOPE** — the truth table: every sign pair with null and zero on both
sides in integer minor units (floor 0) and in rounded major-unit money
(floor 0.005, with sub-floor values of both signs), the floor edge, the
rounding ties, and the two defect pairs measured on Scandia FY2025 (cash
6,104,815.29 to -107,630,000; EBITDA 54,444,000 to -20,257,000; aggregates
only, no client book committed); the 14 consumers contract 7 names; the
comparatives column model over hand-built envelopes and the committed
regression baselines `scandia_fy2025` (analytic), its condensed roll-up and
`eei_dec_2025` (synthetic), 255 columns, 173 carrying a change kind, 6 of
them a word kind (a real cross-sign EBITDA between the two books). No
forecast book: compare_base rows and waterfall steps join at B8.

**GREEN** — `PASS sign-flip (2.4s, 339 truth-table rows + consumers + columns)`.

**PLANT 1** — restore the columns.py cross-sign percent (contract S7 plant):

```
-            elif change.kind != CHANGE_COMPARED:
+            elif False and change.kind != CHANGE_COMPARED:
```

**RED (plant)** — through `scripts/run_battery.py`'s runner, exit `1`:

```
FAIL sign-flip (exit 1, 2.7s)
E   AssertionError: a sign flip served a percentage: -18.630345
E   AssertionError: assert (-0.999995, 'to_zero') == (None, 'to_zero')
E   AssertionError: ('pl.ebitda', 'flip_to_positive')
FAILED tests/engine/test_comparatives.py::test_a_cross_sign_column_carries_its_kind_and_no_percentage
FAILED tests/engine/test_comparatives.py::test_a_move_to_zero_or_from_zero_is_a_kind_never_a_hundred_percent
FAILED tests/engine/test_comparatives.py::test_change_kind_is_set_exactly_on_movement_statuses_over_every_orientation
========================= 3 failed, 59 passed in 1.02s =========================
```

**PLANT 2** — the truth table loses its null-base rows (TC-3 on the fixture):

```
E   AssertionError: the table must exercise all seven kinds: Counter({'compared': 25, 'absent_plan': 8, 'to_zero': 8, 'from_zero': 8, 'flip_to_negative': 7, 'flip_to_positive': 4})
E   AssertionError: minor_units_floor_0 is missing sign pairs [('null', 'neg'), ('null', 'null'), ('null', 'pos'), ('null', 'zero')]
========================= 2 failed, 17 passed in 3.80s =========================
```

**RED (parent commit)** — the new comparatives tests copied onto eb2ff8f
(`wt-plan-b1-parent`, detached) and run against the unrepaired columns.py:
the defect itself, the -19x source value served as a percentage:

```
E   AssertionError: a sign flip served a percentage: -18.630345
E   assert -18.630345 is None
E   AttributeError: 'ComparativeColumn' object has no attribute 'change_kind'
FAILED tests/engine/test_comparatives.py::test_a_cross_sign_column_carries_its_kind_and_no_percentage
FAILED tests/engine/test_comparatives.py::test_a_move_to_zero_or_from_zero_is_a_kind_never_a_hundred_percent
FAILED tests/engine/test_comparatives.py::test_change_kind_is_set_exactly_on_movement_statuses_over_every_orientation
======================= 3 failed, 40 deselected in 0.70s =======================
```

**REVERT** — both files restored from their copies; `PASS sign-flip (2.4s, 339 ...)`.

**After the repair it reds on (TC-11):** a truth-table row the Python
classifier classifies differently (kind or delta_pct byte); a delta_pct on
any kind but compared with a non-zero base; a comparatives column that
serves a percentage across zero or to zero, or a change_kind on a refusal
status; the TS pack mirror disagreeing with the pack; the rounded-money
floor drifting from `PCT_BASE_FLOOR`; a converted consumer that stops
importing the classifier (directly or through `computeDeltas.delta`) or
divides a difference by its own `|base|`; a truth table that stops
enumerating every sign pair, both zero-floor groups, or all seven kinds.
**It cannot see:** what a page paints (the vitest canaries below) or
whether the TS classifier agrees (changeKind.test.ts; the fixture is the
join); sign-flip percentages in consumers contract 7 does not list
(`lib/capsuleTier0.ts:673`, `lib/reportComparatives.ts:143`,
`lib/financialExports.ts:752`, `components/cfo/PublicRecordsQuickCard.tsx:106`,
`components/cfo/ComparativesPanel.tsx` movers) — recorded in
plan_as_built B1 for an owner ruling.

### vitest — sign-flip canaries (plan/2 B1)

`frontend/lib/__tests__/changeKind.test.ts` (the TS classifier against the
shared truth table) and `frontend/components/scenarios/__tests__/signFlip.test.tsx`
(every converted DOM consumer renders a flipping pair as words, with a
same-sign percent control on each surface) — canaries of the `vitest` gate,
path literals in `scripts/check_vitest.mjs` CANARIES and the battery.

**SCOPE** — 70 truth-table rows (typescript); rendered flips on
ScenarioComparison, VarianceTable, KpiVarianceStrip, Money/DeltaBadge,
KeyMetricsRow, StoryOverview, CmpCells, BsCmpCells and Amount in ro (11
flip renderings printed); the Scandia FY2025 cash and EBITDA aggregates and
hand-built fixtures; en and ro; jsdom, no browser (the page walk is B13's).

**PLANT A** — revert `delta()` to absolute over `|comparison|` (contract S7):

```
-  return { absolute, pct: deltaPctNumber(change), change };
+  return { absolute, pct: comparison === 0 ? null : absolute / Math.abs(comparison), change: { kind: "compared", ... } };
```

**RED (plant)** — `npx vitest run --root . frontend/components/scenarios/__tests__/signFlip.test.tsx`:

```
× ScenarioComparison: cash 6,104,815.29 → -107,630,000 is 'turned negative', no percent, no multiplier
  → expected '−19×' to contain 'turned negative'
× VarianceTable and KpiVarianceStrip: EBITDA vs last year crossing zero shows words beside the money change
× Money + DeltaBadge: a comparison across zero and a comparison from zero are words
  → expected '↓1863.0%' to contain 'turned negative'
Tests  4 failed | 2 passed (6)
```

**PLANT B** — revert only VarianceTable (the file restored from eb2ff8f):

```
× VarianceTable and KpiVarianceStrip: EBITDA vs last year crossing zero shows words beside the money change
Received: "EBITDA−20.3 M54.4 M−74.7 M"
Tests  1 failed | 5 passed (6)
```

**PLANT C** — change only the TS classifier (`flip_to_negative` falls through to compared):

```
× classifies every truth-table row exactly as the table says
+   "row 58 defect_0.4 base=6104815.29 plan=-107630000 floor=0.005: want (flip_to_negative, null), got (compared, -18.630345)",
+   "row 59 defect_0.4 base=54444000 plan=-20257000 floor=0.005: want (flip_to_negative, null), got (compared, -1.372070)",
× renders the measured defect pairs as flips, never a ratio
```

**RED (parent commit)** — signFlip.test.tsx on eb2ff8f with the cases whose
props exist there (ScenarioComparison, Variance, Money, CmpCells): the
defect exactly as the live page painted it:

```
× ScenarioComparison ... → expected '−19×' to contain 'turned negative'
Received: "EBITDA−20.3 M54.4 M−74.7 M−137.2%"
Received: "↓1863.0%"
Tests  4 failed (4)
```

**REVERT** — every planted file restored from its copy; `Tests 6 passed (6)`
and `Tests 5 passed (5)`; the full vitest gate lists both canaries `ran`.

**After the repair it reds on:** a money change across zero or sign rendered
as a percent or a multiplier on any of the nine surfaces above; a flip
without its words in en or ro; a same-sign control that stops painting its
percent; the TS classifier disagreeing with any fixture row.
**It cannot see:** the live page in a browser (B13's no-intercept walk) or
the forecast compare_base rows (B8).


<!-- ═══ plan/2 B6 (plan_contract_v2 28.3): fp1.2 serving and POST recompute ═══
     B6 appends below this anchor only (contract 0.6). -->

## plan-gate-census — three loopholes closed (plan/2 B6)

The B0 re-verifier left three ways for `plan_gates.json` to claim a gate the
battery does not run. `scripts/check_plan_gates.py` now closes each. The three
plants are copies of `plan_gates.json` in the session scratchpad, read through
`--plan-gates`; the tree's file was never edited. Each was also run against the
parent commit's census (`git show d4f2b5c:scripts/check_plan_gates.py`), which
is the defect itself.

**SCOPE** — every entry of `docs/engine_book/plan_gates.json` (22 at this
commit), every batch that has landed (B0, B1, B2, B3, B4, B5).

**PLANT 1 — an id borrowed as a second name.** The `forecast-balance` entry's
`gate` re-pointed to `forecast-model` (canaries dropped so nothing else reds):
`required_gates[B5]` names `forecast-balance`, and `_met_gate` accepted
`e["id"] == name`, so a batch could meet its required gate with an entry that
runs another gate.

```
RED (plant)
  · plan_gates.json entry 'forecast-balance': id must be 'forecast-model' (the gate name); an id is never a second name for another gate
  · required_gates[B5]: gate 'forecast-balance' has no plan_gates.json entry landed in B5 (an earlier batch's entry does not count)
RED (parent commit) — the defect: the d4f2b5c census on the same copy printed
PASS — every listed plan gate is registered, planted and scoped.
```

**PLANT 2 — a runner entry with zero canaries.** `vitest:B1` with
`"canaries": []`. The shared runner exists for every batch, so the entry met
`required_gates[B1] = vitest` while naming no file of its own.

```
RED (plant)
  · plan_gates.json entry 'vitest:B1': an entry on the shared runner 'vitest' names ZERO canaries; the runner's own existence is not this batch's gate (TC-3)
RED (parent commit) — the d4f2b5c census on the same copy printed
PASS — every listed plan gate is registered, planted and scoped.
```

**PLANT 3 — retired by a batch that has not landed.** `forecast-get-b4-parity`
given `"retired_in": "B6"` on a registry where B6 has no entry and no
`required_*` key: the census stopped every battery check for it.

```
RED (plant)
  · plan_gates.json entry 'forecast-get-b4-parity': retired_in 'B6' names a batch that has not landed (landed: B0, B1, B2, B3, B4, B5); the gate stays in the battery until the batch that retires it lands
RED (parent commit) — the d4f2b5c census on the same copy printed
PASS — every listed plan gate is registered, planted and scoped.
```

**REVERT** — the copies discarded; `PASS plan-gate-census` on the tree.

**After the repair it reds on:** an entry whose id is not its gate name (or
`<gate>:<landed_in>` on vitest or playwright); a vitest or playwright entry
that lists no canary; a `retired_in` whose batch has no entry and no
`required_gates` / `required_rows` key. **It cannot see:** whether a named
canary file asserts anything (tests/engine/test_gate_canaries.py), or a
retirement the contract never named (the RETIREMENTS table, unchanged).

### B6 route gates — how the plants and the parent reds were taken

Eight gates land with the repair they guard (contract 0.5): fp1.2 serving and
`POST /api/forecast/{period_id}/recompute`. Every plant below was applied by
monkeypatch from a scratch test module (session scratchpad `b6/plants_gates.py`
and `b6/plants_cache.py`, never committed; the no-plants gate forbids plant
code in product source), observed, and discarded. The parent commit is
`d4f2b5c` (wave/plan-b5). Run against it, every one of these gates reds for one
reason, recorded once here and quoted under each heading:

```
RED (parent commit) d4f2b5c, probed through create_app on agras:
d4f2b5c POST /api/forecast/{id}/recompute -> 404 {"detail":"Not Found"}
d4f2b5c GET contract fp1 | body_hash None | drivers False | series False | lever_ids on a figure False | per-figure basis prose True
d4f2b5c _forecast_history cache: False
the eight gate files copied onto d4f2b5c: 33 failed, 3 passed, 6 errors
```

## forecast-server-side

| | |
|---|---|
| command | `python -m pytest tests/engine/test_forecast_recompute_f2.py -q -s` |
| canary | `SCOPE forecast-server-side (plan/2 B6, gate row F2)` |
| work count | `GATE-WORK forecast-server-side units=(\d+)`, floor **4000** (measured 4300) |

**SCOPE** — books agras, carniprod, retail, realestate; requests base 3y/12m,
base 2y/24m, levered 3y/12m (every lever kind B6 accepts); through create_app
and the committed-book row server.

**PLANT** — `blocks/series._value` returns fcf_cumulative one minor unit high.

```
RED (plant)
E   AssertionError: ('agras', '2026-01')
E   assert 32174118 == 32174117
```

**RED (parent commit)** — no series, summary, strip or FY aggregate is served
on d4f2b5c (`series False` above): every total a surface wanted was the
browser's to compute, which is the F2 defect.

**REVERT** — monkeypatch undone; `5 passed`.

**After the repair it reds on:** a series point, FY aggregate, balance-sheet
total, summary amount or strip amount that differs from the integer walk over
the served figures of the same run; a float in the body. **It cannot see**
what a page does with the values (forecast-boundary, vitest).

## forecast-provenance

| | |
|---|---|
| command | `python -m pytest tests/engine/test_forecast_provenance_f4.py -q -s` |
| canary | `SCOPE forecast-provenance (plan/2 B6, gate row F4)` |
| work count | `GATE-WORK forecast-provenance units=(\d+)`, floor **8000** (measured 8712) |

**SCOPE** — the four corpus books, base and levered 3y/12m.

**PLANT** — the "six-key normalisation" restored: `blocks/drivers._basis`
drops the `book` evidence object (and the builder's own clause check is
silenced, so the bytes leave).

```
RED (plant)
E   AssertionError: ('agras', 'interest_rate_debt', 'book', [])
E   assert [] == ['book']
```

**RED (parent commit)** — `drivers False` above: fp1 served an assumption as
{id, label, unit, values, basis, derived_from}, with no tier and no evidence.

**REVERT** — monkeypatch undone; `5 passed`.

**After the repair it reds on:** an id that resolves in neither drivers nor
conventions; a tier without exactly its evidence object; a user tier without
its original; a figure naming a driver the same response marks inert; a line
outside a driver's consumed_by. **It cannot see** whether a driver's value is
right (forecast-authority, forecast-defaults).

## forecast-byte-stability

| | |
|---|---|
| command | `python -m pytest tests/engine/test_forecast_byte_stability_f8.py -q -s` |
| canary | `SCOPE forecast-byte-stability (plan/2 B6, gate row F8)`, `PYTHONHASHSEED=12345` |
| work count | `GATE-WORK forecast-byte-stability units=(\d+)`, floor **16** (measured 16) |

**SCOPE** — the four corpus books, base and levered; two calls in process and
one fresh interpreter with its own hash seed.

**PLANT** — a process fact in the body: `plan_response._sentences` appends a
note carrying `os.getpid()` (in the parent process only).

```
RED (plant)
E   AssertionError: another process serves different bytes: ['agras', 'carniprod', 'realestate', 'retail']
```

**RED (parent commit)** — `body_hash None` above: fp1 carried no hash, so
nothing could be compared across processes at all.

**REVERT** — monkeypatch undone; `2 passed`.

**After the repair it reds on:** one request giving two body hashes, in or
across processes; recompute_ms inside the hash; lever_set_hash depending on
lever order or a decimal's spelling. **It cannot see** saved-case replay
(B15), compares (B11) or the export (B20).

## forecast-latency

| | |
|---|---|
| command | `python -m pytest tests/engine/test_forecast_recompute_f9.py -q -s` |
| canary | `SCOPE forecast-latency (plan/2 B6, gate row F9, in process)`, `bytes (cap` |
| work count | `GATE-WORK forecast-latency units=(\d+)`, floor **80** (measured 80 = N 20 x 4 books) |

**SCOPE** — chart profile, monthly_months 24, two shocks, N=20 per book; the
clock includes the loader, the statements rebuild and the TestClient. Measured
p50 136-186 ms against the packed 1500; largest body 339,293 bytes against the
packed cap 400,000 (both thresholds printed from
`packs/forecast/levers.yaml#latency`, TC-10).

**PLANT 1** — a wrapper that delays the handler by 2 s.
**PLANT 2** — per-point basis prose back on the series block.

```
RED (plant) 1
E   AssertionError: ('agras', 2189.4847910000053)
E   assert 2189.4847910000053 <= 1500
RED (plant) 2
E   AssertionError: ('agras', 1606826)
E   assert 1606826 <= 400000
```

**RED (parent commit)** — `per-figure basis prose True` above: the fp1 GET
inlined the full basis of every driver into every figure (the recorded B4 GET
bodies were ~5 MB each), and there was no chart profile to time.

**REVERT** — monkeypatches undone; `1 passed`.

**After the repair it reds on:** in-process p50 above the packed budget; a
chart-profile body above the packed cap; N below 20. **It cannot see** the
browser (B9), the analysis profile (B11) or the network.

## forecast-lever-reach

| | |
|---|---|
| command | `python -m pytest tests/engine/test_forecast_lever_reach.py -q -s` |
| canary | `SCOPE forecast-lever-reach (plan/2 B6, contract 12)`, `levers declared 38`, `cross-book: ` (B6 repair) |
| work count | `GATE-WORK forecast-lever-reach units=(\d+)`, floor **350** (measured 376 nudges) |

**SCOPE** — the four corpus books, 3y/12m; every driver key x every allowed
op, nudged by its served reach_step through POST recompute (overrides, shocks,
behaviour overrides); printed per book: levers declared, moved, the inert list
with the engine's sentences, the nudges the engine refused and why.

**PLANT** — volume_index compiles to a no-op (`_Compiler.compile` drops it).
The first version of this gate PASSED the plant: the engine's own nudge was
blind in the same way, so it served "moving volume index changes no figure"
and the gate took the sentence as the answer. The gate now refuses an inert
sentence on a driver the registry wires directly to pl.revenue or
pl.cost_of_sales while that line carries an amount.

```
RED (plant)
E   AssertionError: agras: volume_index is served as inert while pl.revenue, pl.cost_of_sales carries an amount in the base plan: the lever compiles to nothing
```

**RED (parent commit)** — no POST route (404 above), so no lever reached
anything through a route. Built against the B6 tree before its repairs, the
gate also found two attribution defects, both repaired in this batch
(`project.py`): `bs_totals.current_liabilities` moved under a pool fixed-share
nudge on realestate, outside the driver's consumed_by; and a dso_days nudge
moved pl.pretax_result, pl.net_income and bs.equity_retained on realestate
(the funding interest is priced on a balance everything that moves cash has
sized):

```
E   AssertionError: realestate: nudging dso_days (override) moved ['bs.equity_retained', 'bs_totals.equity', 'cf.net_income', 'pl.net_income', 'pl.pretax_result'], outside its consumed_by
```

**REVERT** — monkeypatch undone; `5 passed`.

**After the repair it reds on:** a nudge that moves nothing on a driver not
served as inert; an inert driver whose nudge moves a number; a revenue or
cost-of-sales lever served as inert on a book that has the line; changed lines
outside consumed_by; a driver with no consumer or no tier. **It cannot see**
pool and debt reach steps of their own (not packed in B6) or block-field
consumers (B12).

## scenario-one-engine

| | |
|---|---|
| command | `python -m pytest tests/engine/test_scenario_one_engine.py -q -s` |
| canary | `SCOPE scenario-one-engine (plan/2 B6, gate row S4` |
| work count | `GATE-WORK scenario-one-engine units=(\d+)`, floor **10** (measured 10) |

**SCOPE** — the four corpus books x horizons 3 and 5; the mounted
/api/forecast routes. The Scenarios cascade, the Capsule preview and
forecast_drivers cases are NOT yet on this engine (B13); the scope line says so.

**PLANT 1** — cost_of_sales multiplied by 1.0001 in the POST path only.
**PLANT 2** — a `/api/forecast/{period_id}/scenario` path mounted.

```
RED (plant) 1
E   AssertionError: ('agras', 3)
E   assert 'sha256:6d2d8...0b6a32dc8a14c' == 'sha256:ceaf7...d43a4318153bd'
RED (plant) 2
E   AssertionError: [('/api/forecast/{period_id}', ('GET',)), ('/api/forecast/{period_id}/recompute', ('POST',)), ('/api/forecast/{period_id}/scenario', ('POST',))]
```

**RED (parent commit)** — the POST answers 404 above; the GET built its body
through project_plan, the fp1 adapter and the fp1 gateway, a path no lever
could enter.

**REVERT** — monkeypatch undone, the planted route removed; `10 passed`.

**After the repair it reds on:** GET and the default POST differing in
body_hash; either verb not going through the one handler; the handler calling
project_payload, the fp1 adapter or the fp1 gateway; a mounted path ending in
/scenario. **It cannot see** the three calculators B13 removes.

## scenario-provenance

| | |
|---|---|
| command | `python -m pytest tests/engine/test_scenario_provenance.py -q -s` |
| canary | `SCOPE scenario-provenance (plan/2 B6, gate row S6)`, `realestate/windowed: figures and series points checked` (B6 repair) |
| work count | `GATE-WORK scenario-provenance units=(\d+)`, floor **8000** (measured 8408: figures and series points, LEVERED and WINDOWED; was 3400 over figures only) |

**SCOPE** — the four corpus books, 3y/12m; lever kinds shock, shock group,
override, behaviour override, debt row; SYNTHETIC debt rate 8% where the book
cannot price debt; every removal run re-POSTed by the test, never read from
the response under test.

**PLANT** — an FY aggregate takes the union of its months' lever ids. This is
the defect the gate found while B6 was being built (a closing balance is
reached only by what reaches the closing month); it was repaired in
`blocks/figures.py` (`lever_ids_of`: the aggregate's own removal test) and is
re-applied here as the plant.

```
RED (plant)
E   AssertionError: agras ('pl.revenue', 'FY2026') lists ['rail:volume_index', 'template:t', 'override:dividend_payout_pct', 'behaviour:personnel', 'debt:2']; removing each lever in turn changes it for ['rail:volume_index', 'template:t']
```

**RED (parent commit)** — `lever_ids on a figure False` above, and no route
took a lever.

**REVERT** — monkeypatch undone; `5 passed`.

**After the repair it reds on:** a figure listing a lever whose removal does
not change it; a figure that changes on a removal and does not list the lever;
a figure that differs from the base run and names none; a lever id the request
never sent. **It cannot see** slot, track and contribution figures (B8), case
and spread levers (B11).

## forecast-cache

| | |
|---|---|
| command | `python -m pytest tests/engine/test_forecast_cache.py -q -s` |
| canary | `SCOPE forecast-cache (plan/2 B6, contract 1.5)` |
| work count | `GATE-WORK forecast-cache units=(\d+)`, floor **8** (measured 8) |

**SCOPE** — the REAL tenancy double (FirmWorld, row visibility evaluated from
the migrations' policy text), ORG_A1's period carrying the agras corpus book;
the owner POSTs base, shocked, base; strangers SOLO and B_OWNER POST the same
period id with their own and with the victim's org header.

**PLANT 1** — the cache keyed without org_id and read before the select.
**PLANT 2** — the cache hands out live objects and the shocked run edits one.

```
RED (plant) 1
E   AssertionError: SOLO [00000000-0000-0000-0000-0000000000cc] was answered 200 on a period whose rows are cached: {"kind":"projection","contract":"fp1.2","currency":"RON","base_period":{"label":"2025-12-31","period_id":"00000000-0000-0000-0000-00000000012d",...
RED (plant) 2
E   AssertionError: the base body changed after a shocked run: a run mutated the cached rows
E   assert 'sha256:0658c...77af4d2948589' == 'sha256:dceb7...6f3164523e1a9'
```

**RED (parent commit)** — `_forecast_history cache: False` above: every GET
re-read and re-rebuilt the period.

**REVERT** — monkeypatches undone; `3 passed`.

**After the repair it reds on:** a base body_hash that changes after a shocked
run; a stranger answered anything but 401/403/404 on a cached period; the
cache read before the org-filtered select (a deleted row still served); a
cached value that is not immutable bytes; a changed updated_at reusing an
entry. **It cannot see** history periods in the key (B7) or a second process.

## cross-org sweep — POST /api/forecast/{period_id}/recompute (plan/2 B6)

`tests/engine/test_cross_org_reads.py` lists the POST beside the GET in its
route table, on the REAL tenancy double with ORG_A1's period carrying the agras
book (fixture `book_world`), so the owner's answer is an fp1.2 body and not a
refusal a stranger's 422 could hide behind.

**SCOPE** — GET and POST recompute, requested by SOLO and B_OWNER (members of
other workspaces) with their own org header, with the victim's org header and
with none; the owner's expected 200 on the same table.

**PLANT** — the classic service-role defect, taken in an isolated copy of the
tree (scratchpad b6/pt; the branch was never edited): `_forecast_history.
load_plan_inputs` opens `_supabase.admin()` instead of `per_user(jwt)`, and
`_forecast_routes.recompute` trusts `X-Org-Id` instead of `resolve_org`.

```
RED (plant) — 3 failed, 3 passed
E   AssertionError: CROSS-ORG READ — SOLO holds a membership in 00000000-0000-0000-0000-0000000000cc and none in ORG_A1, but these routes answered with something other than a refusal:
E       POST /api/forecast/00000000-0000-0000-0000-00000000012d/recompute [victim-org-header] -> 422 {"detail":{"code":"no_statutory_tax_rate",...
E   AssertionError: ('SOLO', '00000000-0000-0000-0000-0000000000c9', 200, '{"kind":"projection","contract":"fp1.2","currency":"RON","base_period":{"label":"2025-12-31",...
E   assert 200 in {401, 403, 404}
FAILED tests/engine/test_cross_org_reads.py::test_a_stranger_cannot_recompute_the_book_the_owner_can
```

**REVERT** — the copy discarded; 6 passed on the tree.

**After the repair it reds on:** a non-member answered anything but 401, 403
or 404 on the POST (a 422 that names the book's own refusal counts as a read);
the owner not getting fp1.2 on the same period. **It cannot see:** a wall that
holds only because the double's RLS holds while the route's own org filter is
gone (either half alone keeps it green — `forecast-cache` PLANT 1 holds the
cache half), or a cross-org WRITE (the route writes nothing).

## B6 repair round — six plants on the verifier's defects (plan/2 B6 repair)

Every plant was applied to the product file in the worktree, observed and
reverted from a saved copy (`git status` clean of it afterwards); none is in
product source. Reds are verbatim.

**A. forecast-server-side (F2) — a partial serve's strip headline.** The gate's
walk held the truncation as law: it compared `strip.closing_cash` with
`bs.cash` at the last SERVED label, so the cash of 2026-10 passed as the
closing cash of a horizon ending FY2028 (TC-11: a gate encoding the defect).
The walk now takes a partial-refusal request (carniprod, volume_index level_pct
-0.6) and asserts the three strip headlines equal `{refused: <the refusal's
sentence>}`. Plant: `strip.py` guards only an empty period tuple, so a partial
serve answers the last served month again.

```
RED (plant A)
E   AssertionError: ('carniprod-partial', 'cumulative_fcf', {'amount_minor': -893273171, 'driver_ids': ['revenue_growth', 'volume_index', ...], 'formula': 'sum of operating and investing cash over the served periods', 'joint': False, ...})
1 failed, 1 passed
```

**B. forecast-route — a refusal that begins in the first period.**
`test_a_refusal_that_begins_in_the_first_period_is_200_with_nothing_served`
(carniprod, `overrides.min_cash ["12000000"]`, opening cash about 10.0M RON, no
priceable funding line; default want, `["strip"]` alone, and all four blocks).
Plant: `strip.py` indexes `periods[-1]` whenever there is a shortfall.

```
RED (plant B, and the parent 63fee82)
E   AssertionError: (None, 500, "{'error': {'code': 'internal_error', ...}}")
E   assert 500 == 200
IndexError: tuple index out of range
```

After the repair it reds on: a 500; a from_period other than labels[0]; a
served_through; a strip field, series point or figure carrying an amount. It
cannot see a refusal that begins later (the partial test beside it holds that).

**C. scenario-provenance (S6) — a series point's own removal test.** The gate's
docstring claimed series lever ids were checked; the code only checked they
were a subset of the ids sent. It now re-derives every series point's lever ids
from the same removal re-POSTs, and runs a second WINDOWED request (volume
-20%, months 1-3). Against the parent it found the verifier's fcf_cumulative
points and two defects nobody had reported: `series.funding_draw` named levers
that do not move it, and `series.min_cash` did not name a lever whose removal
run refuses. Plant: `series.py` tests fcf_cumulative over its own month only.

```
RED (parent 63fee82)
E   AssertionError: agras series ('funding_draw', '2026-03') lists ['rail:volume_index', 'template:t', 'behaviour:personnel']; removing each lever in turn changes it for []
E   AssertionError: carniprod series ('min_cash', '2026-01') lists []; removing each lever in turn changes it for ['override:interest_rate_debt']
E   AssertionError: agras/windowed series ('fcf_cumulative', '2026-08') lists []; removing each lever in turn changes it for ['rail:volume_index']
E   AssertionError: carniprod/windowed series ('fcf_cumulative', 'FY2027') lists []; removing each lever in turn changes it for ['rail:volume_index']
7 failed, 2 passed
RED (plant C)
E   AssertionError: agras/windowed series ('fcf_cumulative', '2026-08') lists []; removing each lever in turn changes it for ['rail:volume_index']
E   AssertionError: retail/windowed series ('fcf_cumulative', '2026-07') lists []; removing each lever in turn changes it for ['rail:volume_index']
7 failed, 2 passed
```

It cannot see: `series.min_cash` when two levers both set the floor (the floor
is not a line of a projected period; its test is "the served floor left the
book's own"); slot, track and contribution figures (B8).

**D. forecast-lever-reach — a lever dead on every book.** The verifier's plant:
`dso_days` popped from the CompiledPlan at the end of `_Compiler.compile`
(overrides, shocks and the engine's own inert nudge all become no-ops). The
parent gate: `5 passed`. The gate now holds, across the four books, that every
(driver, op) nudge moves a number on at least one corpus book, or on a labelled
SYNTHETIC request (`interest_income_rate add_pp` on agras with a stated 2%
rate: no corpus book measures a rate on cash), or is a pool key every book
serves as nil with a zero base (`cost_behaviour.yaml#nil_pool`, evidence
value_minor 0 — the book's evidence, not the inert sentence). Measured: 95
nudges, 90 live on a corpus book, 1 SYNTHETIC, 4 nil pool.

```
RED (plant D)
E   AssertionError: moves a number on no corpus book, no SYNTHETIC row shows it live and no book explains it (a lever that compiles to nothing): dso_days override, dso_days shock:add_days, dso_days shock:set
1 failed, 5 passed
```

It still cannot see: a lever dead on ONE book and live on another, for a driver
not wired directly to pl.revenue or pl.cost_of_sales — there the engine's
inert sentence is taken at its word.

**E. plan-gate-census — a carried registration is a debt with a name.**
`plan_gates.json#owed` rows {what, carried_from, owed_in, closed_by}. Plant: a
copy of the registry in which B8 has landed (`required_gates.B8 = []`) and the
seven B6 carries are still open.

```
RED (plant E)
  · plan_gates.json owed[0]: forecast-defaults extended over served bytes (tests/engine/test_forecast_defaults_f3.py) was carried from B6 and owed in B8, which has landed; no closed_by names the gate that carries it
```

**F. request refusals.** `"1/3"`, `"1e-1"` and `source "ai:proposal"` each
answered 200 on the parent (three rows of
`test_an_invalid_request_is_422_with_code_text_and_field`, `3 failed, 8
passed`); they now answer 422 `not_exact` / `shock_source_unknown`.

## vitest — fp1.2 reader canaries (plan/2 B6)

| | |
|---|---|
| canaries | `frontend/lib/__tests__/forecastFactsReader.test.ts`, `frontend/pages/cfo/__tests__/forecastMagnitude.test.tsx` |

**SCOPE** — `readProjection` over `fp1_2_agras_served.json` (the bytes GET
/api/forecast really serves on agras, held to the route by
test_forecast_serving_boundary.py); `periodPayloadSnapshotId` against the
engine's rule on the four corpus books; the magnitude band over the served FY
aggregate of plan year one.

**PLANT** — the reader pointed back at the fp1 shape (the state of the tree
between the route change and the reader change, observed while B6 was built).

```
RED (plant)
 Failed Tests 51
 FAIL  frontend/lib/__tests__/forecastFactsBoundary.test.ts > the wire form the engine actually serves > reads as a projection at all
 FAIL  frontend/pages/cfo/__tests__/forecastPage.test.tsx > the forecast page > paints a projected figure WITH its marker, never as a bare number
```

**RED (parent commit)** — forecastMagnitude.test.tsx:190-192 on d4f2b5c left
the band by `if (!match) return;` when no basis named the source revenue: a
payload with nothing to stand on PASSED. Both early returns are now
assertions.

**REVERT** — the reader reads fp1.2; `Tests 72 passed (72)` on the four
forecast files, `13 passed` on forecastFactsReader.test.ts.

**After the repair it reds on:** a driver losing its tier or its plan-year
value; a convention painted as a quantity; an FY aggregate missing or not read
as a served figure; a refused aggregate painted as a number; the TypeScript
snapshot-id rule disagreeing with the engine's; a magnitude band with no source
revenue behind it.

<!-- ═══ plan/2 B13, minimal cut (2026-09-21): the Scenarios page on the engine ═══
The page stops computing: every figure comes from POST /api/forecast/{id}/recompute
through lib/forecastFacts. Two battery gates and one vitest canary. Not entered in
plan_gates.json: the full B13 (scenario-closure, playwright) has not landed. -->

## scenario-page-templates

`tests/engine/test_scenario_page_templates.py`, registered in `scripts/run_battery.py`
under the plan/2 B13 anchor.

**SCOPE** — the four corpus books, each from its own anchor; the Scenarios horizon
(monthly_months 12, total_years omitted and filled from the pack, contract 2.2); every
template of `frontend/lib/scenarioTemplates.json` (base, recession, input_cost_inflation,
price_pressure, working_capital_squeeze) compiled as the page compiles it and put through
the route's wire path (PlanRequestBody -> _wire -> plan_request_from_body -> project_plan).
Printed on every run with its GATE-WORK line. Measured: 19 projected, 1 refused by name
(realestate/working_capital_squeeze, days_not_measured), 515 units.

**PLANT 1** — the recession template's volume shock set to `"0"` in the data file
(cost of sales held flat under a downturn: the cascade's shape, defect 0.1). Applied,
observed, reverted byte-exact.

```
RED (plant)
E   AssertionError: agras/recession: year-one cost of sales -7232104255 against base -7232104255 — a volume fall must reach cost of sales (defect 0.1)
E   AssertionError: carniprod/recession: year-one cost of sales -5886554114 against base -5886554114 — a volume fall must reach cost of sales (defect 0.1)
E   AssertionError: retail/recession: year-one cost of sales -6496103699 against base -6496103699 — a volume fall must reach cost of sales (defect 0.1)
========================= 3 failed, 3 passed in 0.47s ==========================
```

**PLANT 2** — price_pressure pointed at `input_price_index` (cost of sales following the
selling price, R2).

```
RED (plant)
E   AssertionError: agras/price_pressure: cost of sales moved with the SELLING price (R2)
E   AssertionError: carniprod/price_pressure: cost of sales moved with the SELLING price (R2)
E   AssertionError: retail/price_pressure: cost of sales moved with the SELLING price (R2)
========================= 3 failed, 3 passed in 0.49s ==========================
```

**RED (parent commit)** — no repair on the engine side in this commit: the engine already
carried cost of sales with volume, held other operating income and floored cash (B4, B5).
The repair is the page's; its parent-commit red is recorded under `scenarios-closure`.

**REVERT** — the data file restored byte-exact; `6 passed`.

**After the repair it reds on:** a page template the engine refuses for any reason other
than a named book refusal (days_not_measured, rate_not_measured, cost_split_refused); a
projected period with negative cash or an open balance sheet; recession leaving cost of
sales flat or moving other operating income; price pressure moving cost of sales; input
cost inflation leaving cost of sales flat or moving revenue; the working-capital squeeze
moving revenue or EBITDA; a pool pattern expanding over nothing; zero projected templates.

## scenarios-closure

`scripts/check_forecast_boundary.mjs` (the forecast-boundary script, its B13 section),
registered in `scripts/run_battery.py` under the plan/2 B13 anchor with its own work count
(`GATE-WORK forecast-boundary-scenarios`) and canaries.

**SCOPE** — the import closure of `frontend/pages/cfo/Scenarios.tsx` (static imports,
re-exports and literal dynamic imports resolved inside frontend/; measured 78 modules),
checked against `frontend/lib/scenarios/**` and `frontend/stores/scenario.tsx`. The old
cascade renderers under `frontend/components/scenarios/` stay on disk (the sign-flip
canary renders ScenarioComparison) and are printed by name as unreachable from the page,
never counted as coverage.

**PLANT** — `import { applyCascade } from "@/lib/scenarios/cascade";` added to the page.

```
RED (plant)
FAIL — a projected figure can be painted as a fact:
  · frontend/pages/cfo/Scenarios.tsx reaches frontend/lib/scenarios/cascade.ts through its imports. The Scenarios page computes nothing: ...
  · frontend/pages/cfo/Scenarios.tsx reaches frontend/lib/scenarios/types.ts through its imports. ...
```

**RED (parent commit)** — the gate run over the parent commit's page
(`git show HEAD:frontend/pages/cfo/Scenarios.tsx`):

```
FAIL — a projected figure can be painted as a fact:
  · frontend/pages/cfo/Scenarios.tsx reaches frontend/lib/scenarios/baseline.ts through its imports. ...
  · frontend/pages/cfo/Scenarios.tsx reaches frontend/lib/scenarios/cascade.ts through its imports. ...
  · frontend/pages/cfo/Scenarios.tsx reaches frontend/lib/scenarios/covenants.ts through its imports. ...
  · frontend/pages/cfo/Scenarios.tsx reaches frontend/lib/scenarios/dashboardCanon.ts through its imports. ...
  · frontend/pages/cfo/Scenarios.tsx reaches frontend/lib/scenarios/levers.ts through its imports. ...
  · frontend/pages/cfo/Scenarios.tsx reaches frontend/lib/scenarios/templates.ts through its imports. ...
  · frontend/pages/cfo/Scenarios.tsx reaches frontend/lib/scenarios/types.ts through its imports. ...
```

**REVERT** — the page restored; `PASS — 14 forecast-namespace consumer(s)`.

**After the repair it reds on:** the page or anything it imports reaching a module under
`frontend/lib/scenarios/` or `frontend/stores/scenario.tsx`; the closure not reaching
`frontend/lib/forecastFacts.ts`; the page no longer calling `forecastRecompute`; the page
file missing.

## vitest — Scenarios engine canary (plan/2 B13, minimal cut)

| | |
|---|---|
| canary | `frontend/pages/cfo/__tests__/scenariosEngine.test.tsx` |

**SCOPE** — the page rendered over `fp1_2_agras_served.json` with
`cfoApi.forecastRecompute` the only seam; en and ro.

**PLANT A** — the cascade imported by the page: `reaches no client scenario-math module`
and `names no cascade` red (2 failed). **PLANT B** — the negative-cash guard in
`ScenarioOutcome.CashFigure` disabled: `paints the served funding line instead` red.
**PLANT C** — recession `-0.20` -> `-0.25` in the data file: the literal shock-set pin and
the card text red (2 failed). **PLANT D** — `rent` added to the en chrome, then `chiria`
to the ro chrome: the en and the ro industry-word tests red in turn. **PLANT E** — the
body stating `total_years`: the base and all four template POST pins red (5 failed).

```
RED (plant A)
   × the page computes nothing (one engine) > reaches no client scenario-math module, through any import
     → the Scenarios page reaches client scenario math: frontend/lib/scenarios/cascade.ts, frontend/lib/scenarios/types.ts: expected [ …(2) ] to deeply equal []
RED (plant B)
   × a served negative cash is never the page's cash > paints the served funding line instead, and withholds the chart
RED (plant D, ro)
   × no industry word on the page > ro: base plus every template, every rendered word
     → ro: /\bchiri(e|i|ile|a)\b/i appears on the Scenarios page
```

**RED (parent commit)** — the parent commit's page against this suite: the boundary
tests red, and every template/render test reds with `Unable to find an element by:
[data-testid="scenarios-outcome-table"]` (the page never asked the engine).

**REVERT** — every plant restored byte-exact; `Tests 17 passed (17)`.

**After the repair it reds on:** client scenario math in the page's closure; a template
POSTing anything but its pinned set (or a body stating total_years); a template the data
file declares that the suite does not pin; a 409/422 painting anything but the engine's
sentence, or painting the previous template's figures while a new one loads; an industry
word in the rendered page (en, ro); a served negative cash painted as cash or drawn on the
chart.

<!-- ═══ plan/2 B13 repair (2026-09-21): arithmetic planted in the page stayed green ═══
An adversarial review of feat/scenarios-engine @ adc994a planted arithmetic in the page's
own files. Every plant passed forecast-boundary, scenarios-closure and the vitest canary.
Two repairs, one per half: the static gate reads the page-owned files for value reads, and
the canary asserts that every digit on the rendered page is served. -->

## scenarios-closure — the page-owned files read no value (B13 repair)

`scripts/check_forecast_boundary.mjs`, the same gate as `scenarios-closure` above. Two
changes:

1. **The `<ProjectedAmount>` presence test reads code, not prose.** The rule "a `.tsx`
   that reaches a projected value must use `<ProjectedAmount>`" tested the RAW source.
   Scenarios.tsx's header comment names the primitive (`and <ProjectedAmount>. No delta
   column…`), so the comment alone satisfied the rule and it never fired on the page.
   The reviewer's own evidence: the same plant with that comment reworded went red. The
   presence test now runs on `presenceCode(src)` (`stripProse`, then trailing `//`
   comments). That errs toward stripping more, because for a presence test a false red
   is loud and a false green is silent.
2. **A new rule for the page-owned files in the closure** (`pages/cfo/Scenarios.tsx`,
   `components/scenarios/*`, `lib/scenarioTemplates.ts`), with comments stripped by
   `absenceCode`. That stripper errs toward stripping less: whole `//` lines go first,
   then only block comments that start a line or a JSX expression. It reds on:
   `unwrapProjected` or `projectedDisplay`, named at all; `amountMinor` / `amount_minor`
   in any spelling, including bracket access; `as any`, `as unknown`, `<any>`, or a
   ts-ignore / ts-expect-error / ts-nocheck directive; a namespace or dynamic import of
   lib/forecastFacts; fewer than three page-owned code files found, or the page or
   ScenarioOutcome missing from them.
   Scope printed on every run as `page-owned, checked for value reads and type escapes:
   <path>` (4 files). Two of those lines are battery canaries.

**PLANT A** (the rendered form is A2): in Scenarios.tsx, `unwrapProjected(baseView.figure("pl.revenue",
"FY2026"), …) - 1`, painted through `Intl.NumberFormat` as `<p data-testid="plant-delta">`.
The header comment was left intact.
**PLANT B** — in Scenarios.tsx, `Number((baseView.figure(…) as any)["amountMinor"]) / 100 * 1.1`
painted as `<p data-testid="plant-scaled">`.
**PLANT C** — in ScenarioOutcome.tsx, a delta row: `unwrapProjected(template revenue)/100 -
unwrapProjected(base revenue)/100`, painted with the table's `format()`.
**PLANT D** — in ScenarioOutcome.tsx, `const plantD = (f) => unwrapProjected(f, "", (m) => m * 2)`
placed between `// the old cascade lived under lib/scenarios/*` and `/* end of the plant */`.
Block-first stripping would open a "block" at the `/*` in the `//` line and swallow the
plant.

```
GREEN (plants A, B, C against the gate as it stood at adc994a)
exit 0 — PASS — 14 forecast-namespace consumer(s); no laundering cast, no raw-wire read, ...

RED (plant A, repaired gate) exit 1
  · frontend/pages/cfo/Scenarios.tsx reaches a projected VALUE but does not use <ProjectedAmount>. ...
  · frontend/pages/cfo/Scenarios.tsx:50 names unwrapProjected — the door that hands over a projected number ("unwrapProjected"). ...
RED (plant B) exit 1
  · frontend/pages/cfo/Scenarios.tsx:318 reads amountMinor / amount_minor — the projected amount itself ("amountMinor"). ...
  · frontend/pages/cfo/Scenarios.tsx:318 casts to any — a way around the opaque ProjectedMinor type ("as any"). ...
RED (plant C) exit 1
  · frontend/components/scenarios/ScenarioOutcome.tsx:26 names unwrapProjected — the door that hands over a projected number ("unwrapProjected"). ...
RED (plant D) exit 1
  · frontend/components/scenarios/ScenarioOutcome.tsx:245 names unwrapProjected — ...
```

**REVERT** — both files restored byte-exact (Scenarios.tsx sha `7daf1346`,
ScenarioOutcome.tsx sha `fc26bfdf`); `PASS`, `--probe-vacuity` `PROBE OK`.

**After the repair it reds on:** everything listed for scenarios-closure above. It also
reds on a page-owned Scenarios file that names unwrapProjected or projectedDisplay, reads
amountMinor in any form, or carries a type escape or a namespace/dynamic import of
lib/forecastFacts, and on a forecast-namespace `.tsx` whose only mention of
`<ProjectedAmount>` is a comment.
**CANNOT SEE:** a value reached through a key built at runtime from a plain import
(`Object.values(fig)`, `fig[k]`); a shared, non-page-owned module that computes and hands
the page a string. The DOM half below catches both.

## vitest — Scenarios engine canary: every digit is served (B13 repair)

`frontend/pages/cfo/__tests__/scenariosEngine.test.tsx`, section 8, and
`expectEveryDigitServed` called from sections 3, 5, 6, 7. Every text node on the rendered
page that carries a digit must be one of four things:

- inside `[data-projected="true"]` (a `<ProjectedAmount>`);
- a served sentence, verbatim (runway, funding-rate basis, a refusal);
- the served runway month count, in the runway row;
- made of digits that all belong to served period labels.

Two regions are out of scope, by name: the template picker (declared shock values) and
the lever rail. The test counts what it checked, so it cannot pass vacuously: more than
ten projected nodes, and more checked nodes than projected ones.

```
RED (plant A2)  × every digit ... > en: base plus every template   (and ro, and the digit checks in sections 3, 5, 6)
     → a number is painted on the Scenarios page that is not a served figure, label or sentence:
       expected [ '"<the planted delta>" (in plant-delta)' ] to deeply equal []      Tests 6 failed | 20 passed (26)
RED (plant B)   the same six; offender '"<the planted figure>" (in plant-scaled)'   Tests 6 failed | 20 passed (26)
RED (plant C)   × every digit ... > en / ro; offender '"RON 0" (in plant-delta-row)' Tests 2 failed | 24 passed (26)
```

(Plant C paints "RON 0" because the mock serves the same payload to both columns. That is
still a number the page computed, and it reds.)

**REVERT** — `Tests 26 passed (26)`.

**After the repair it reds on:** a number painted anywhere on the page, outside the
picker and the lever rail, that is not a served figure inside `<ProjectedAmount>`, a
served sentence, the served runway count or a served period label.
**CANNOT SEE:** a computed number painted INSIDE the template picker or the lever rail.
The static rule above covers the picker's file. Also out of reach: pixels, and a number
drawn as SVG geometry rather than text.

<!-- ═══ forecast-scenarios-live (2026-09-21): the owner's Forecast and
     Scenarios gates F1-F6, the sector rung, the preview flag. Plants were
     applied by scratchpad/fcst_tools/plants.py: each edit written into the
     worktree, the named tests run, the file restored byte-exact and its
     sha256 re-checked before the next plant. ═══════════════════════════════ -->

## forecast-f-gates

| | |
|---|---|
| command | `python -m pytest tests/engine/test_forecast_f_gates.py -q -s` |
| canary | `SCOPE forecast-f1..f5 (forecast-scenarios-live)`, `F1 books: agras, carniprod, retail, realestate` |
| work count | `GATE-WORK forecast-f-gates units=(\d+)`, floor **20000** (measured 32,512 with the opt-in Scandia pair) |

**SCOPE** — the four committed corpus books (agras is files/agras_tb_2025.xlsx,
the preliminary close, not the filed year) through the REAL `create_app()`
over the tenancy double; opt-in, never committed, the owner's Scandia FY2025
(`Balanta Scandia Food_31.12.2025 LV.xls`) with FY2024 as the comparable prior
(`FORECAST_LOCAL_SCANDIA=<fy2025>,<fy2024>`). Every scenario template of
packs/scenarios/templates.yaml.

- **F1** year 0 of the forecast IS the dashboard's actuals: the engine's anchor
  (revenue, EBITDA, net income, cash, total assets, equity) equals GET
  /api/period to the cent (assembled_pl.revenue, the methodology's reported
  EBITDA, net_income_statutory, assembled_bs.cash, canonical_bs totals), and
  the first period's served cf.opening_cash is that cash. Scandia FY2025:
  revenue 413,727,560.16, EBITDA 54,443,833.33, net income 36,787,352.75, cash
  6,104,815.29, total assets 292,906,384.88, equity 150,151,550.76 on both sides.
- **F2** every period and FY aggregate balances, balance-sheet cash equals
  cash-flow closing cash, each period opens on the previous close — on the
  forecast (h3, h5) and on every template.
- **F3** GET twice with a fresh loader cache, the scenario twice, and a second
  PROCESS under PYTHONHASHSEED=12345: byte-identical (recompute_ms excluded).
- **F4** scenario(base) == forecast block by block; revenue −10%, price
  pressure, input inflation, a DSO override and a payout override each move
  only lines in their driver's served consumed_by, every moved figure names the
  lever, held lines (other operating income, held balances, debt, debt
  interest) never move; a lever the plan cannot feel must carry the engine's
  inert sentence; after all of them, the forecast is byte-identical to before.
- **F5** every served figure is an integer or a refusal with a sentence, every
  strip slot a figure or a refusal; every period with a debt balance is charged
  interest.

**PLANT f1-revenue-reader** — `history.py`: the P&L reader takes
`total_operating_revenue` for `revenue` (a second reader of year 0).
**PLANT f2-cash-tie** — `blocks/figures.py`: `cf.closing_cash` served one
minor unit above the engine's figure.
**PLANT f3-clock** — `plan_response.py`: `served_at_ns = time.time_ns()` inside
the hashed body.
**PLANT f4-base-moves** — `levers.project_levers`: the base template compiles to
a +0.01% volume shock.
**PLANT f4-ooi-follows-volume** — `project.py`: other operating income scaled
by the volume index (the R3 defect).
**PLANT f5-no-interest** — `project.py`: the debt interest charge multiplied by
zero.

```
RED (plant f1-revenue-reader)
E   AssertionError: retail: year 0 of the forecast is not the served actuals (dashboard, engine): {'revenue': (7901830677, 7902023055)}
RED (plant f2-cash-tie)
E   AssertionError: agras/forecast h3 2026-01: balance-sheet cash 148978821, cash-flow closing cash 148978822
RED (plant f3-clock)
E   AssertionError: agras: GET differs between two identical runs
E     At index 1042 diff: b'8' != b'5'
RED (plant f4-base-moves)
E   AssertionError: agras: the base scenario is not the forecast
RED (plant f4-ooi-follows-volume)
E   AssertionError: agras/revenue_down_10 moved pl.other_operating_income 2026-01 (3313098 -> 2981788), a line volume_index does not drive
RED (plant f5-no-interest)
E   AssertionError: agras/forecast 2026-01: debt of 364020233 charged 0 interest
```

**REVERT** — each file restored byte-exact (sha256 checked by the runner);
`22 passed` with the Scandia pair, `18 passed` without it.

**After the repair it reds on:** a year-0 figure of the engine differing from
the dashboard's served one; any unbalanced period, any BS/CF cash split, any
cash discontinuity, on the forecast or a template; any byte difference between
identical runs or processes; the base scenario differing from the forecast; a
single lever moving a line outside its driver's consumed_by, a moved figure not
naming its lever, a held line moving, or the forecast changing after levers
ran; a null amount or a sentence-less refusal; a period with debt charged no
interest. **It cannot see** what the page paints (vitest: forecastYearZero,
scenariosEngine, scenariosSaved) or whether a forecast is a good one. The
Scandia rows run only where the owner's files are named; on a clean checkout
the four corpus books carry every assertion.

## forecast-sector-rung

| | |
|---|---|
| command | `python -m pytest tests/engine/test_forecast_sector_rung.py -q -s` |
| canary | `SCOPE forecast-sector-rung`, `sector rung: agras CAEN 1011` |
| work count | `GATE-WORK forecast-sector-rung units=(\d+)`, floor **30** (measured 35) |

**SCOPE** — the agras corpus book as a ONE-YEAR company with workspace CAEN
1011, 4711 (not in the dataset) and none; agras with carniprod dated one year
back in the same workspace (a SYNTHETIC pairing, labelled) for the book rung;
src/engine/data/ro_sector_benchmarks.json read through its own lookup.

**PLANT sector-skip** — `assumptions.py`: the ladder's sector branch disabled
(`if False and ...`).
**PLANT sector-p25** — `sector.py`: the reading serves the cell's p25 in place
of its median.

```
RED (plant sector-skip)
FAILED tests/engine/test_forecast_sector_rung.py::test_a_one_year_book_with_a_known_sector_grows_at_the_sector_median
RED (plant sector-p25)
E   AssertionError: {"detail":{"code":"AssumptionError","text":"assumption 'revenue_growth': tier sector serves -13927, its evidence median is 54094","field":"revenue_growth"}}
```

**REVERT** — both files restored byte-exact; `7 passed`.

**PLANT sector-offer-says-no-history** (added with the offer sentence, found
on the Scenarios screenshots: the lever rail printed "Use the sector figure —
no comparable book history is loaded" on Scandia, whose workspace holds FY2024
beside FY2025) — `levers.py`: alternatives.sector served with the rung's own
sentence instead of `reading.offer_sentence`.

```
RED (plant sector-offer-says-no-history)
E   AssertionError: no comparable book history is loaded, so revenue grows at the median net turnover growth of this company's sector: CAEN 1011 Prelucrarea si conservarea carnii (class), size band 50m_250m, 5.4094% over 35 filers, 2023 to 2024 (...)
```

**REVERT** — restored; `7 passed`, `GATE-WORK forecast-sector-rung units=37`.

**After the repair it reds on:** a one-year book with a sector the dataset
carries not standing on tier `sector`; its value not the dataset's own median
for the company's class and size band (agras: CAEN 1011, 50m_250m, 5.4094%,
n=35); a contract 3.3 sector field missing, n below
levers.yaml#sector.min_n, or pins.sector_snapshot_id not the dataset digest; no
CAEN or an unknown CAEN not falling to macro with the rung's reason; a median
below the floor being used; a comparable prior leaving the book rung or not
offering alternatives.sector; the offered sector figure saying the book history is
missing. **It cannot see** sectors outside the dataset
(CAEN 10, 1011, 1013 today) or whether a sector median is a good forecast.

## scenarios-preview

| | |
|---|---|
| command | `python -m pytest tests/engine/test_scenarios_preview_acceptance.py -q` |
| canary | `test_forecast_and_scenarios_are_preview_in_the_source`, `test_the_active_env_promotes_exactly_the_listed_keys_per_request` |
| work count | junit tests, floor **4** (measured 4) |

**SCOPE** — `src/engine/api/_features.py` and GET /api/features/status through
the real `create_app()`. Replaces tests/engine/test_scenarios_off_path.py, whose
own docstring asked to be deleted when the acceptance it named was held; it is
now held by scenario-page-templates, scenario-one-engine, forecast-f-gates and
scenarios-closure.

**PLANT preview-active** — `_features.py`: the forecast row's status evaluates
to `active`.
**PLANT preview-sticks** — `served_registry()` writes the promotion INTO the
module registry instead of a copy.

```
RED (plant preview-active)
E   AssertionError: forecast is 'active' in the source registry. Everyone-on is the owner's switch (CFO_FEATURES_ACTIVE), never an edit here.
RED (plant preview-sticks)
E   AssertionError: the promotion stuck
```

**REVERT** — restored byte-exact; `4 passed`.

**After the repair it reds on:** either row leaving `preview` in the source;
CFO_FEATURES_ACTIVE not promoting a listed key, promoting an unknown one, or
sticking after it is unset; the evidence or a named gate file vanishing.
**It cannot see** the frontend's per-user half (user_prefs.prefs.
preview_features): vitest `featuresPreview.test.ts`.

### scenario-one-engine — R6 extension (forecast-scenarios-live)

The route set is now GET /{period_id}, POST /{period_id}/recompute, POST
/{period_id}/scenario and GET /templates/scenarios; the three projecting
routes go through `recompute`, which calls `project_levers` (never
`project_plan` around it), and `project_levers` calls `project_plan`. New
cells: scenario(base) == GET block by block on the four books at h3 and h5.
The old "a mounted path ending in /scenario" red is retired by name: R6
(scenarios_rulings) puts the scenario on that path.

**PLANT one-engine-bypass** — the handler calls `project_plan` directly and
serves no scenario block.

```
RED (plant one-engine-bypass)
E   KeyError: 'scenario'
FAILED tests/engine/test_scenario_one_engine.py::test_the_base_scenario_is_the_forecast[agras-3]
```

**REVERT** — restored byte-exact; `18 passed`.

### scenario-page-templates — the templates are engine pack data (forecast-scenarios-live)

frontend/lib/scenarioTemplates.json is gone; packs/scenarios/templates.yaml
(FMCG Romania: base, recession [volume −20%, every operating-cost pool −5%,
DSO +30 days], revenue_down_10, input_cost_inflation, price_pressure,
energy_shock, working_capital_squeeze) is compiled by
`engine.forecast.scenario_templates.compile_template` and run through
`project_levers`. New reds: revenue −10% moving other operating income or the
debt interest; the energy shock moving revenue or cost of sales; the base
template differing from the plan with no template.

## forecast-f-page

| | |
|---|---|
| command | `npx vitest run --root . frontend/components/forecast/__tests__/forecastYearZero.test.tsx frontend/pages/cfo/__tests__/forecastCompanyAndPlaceholders.test.tsx frontend/pages/cfo/__tests__/scenariosSaved.test.tsx frontend/pages/cfo/__tests__/scenariosEngine.test.tsx frontend/lib/__tests__/featuresPreview.test.ts --reporter=verbose` |
| canary | `gate F1: year 0 is the dashboard's headline`, `gate F5 on the Forecast statements`, `gate F5: no dash and no zero where the engine served a figure`, `gate F6: a saved scenario survives reload and belongs to its company` |
| work count | `Tests N passed`, floor **50** (measured 57) |

**SCOPE** — the PAGE half of the owner's gates, rendered over the real served
bytes (fp1_2_agras_served.json, the engine's own scenario_catalogue.json, the
four corpus envelopes and their line items). cfoApi and the company on screen
are the only stubs; F6 runs the real lib/savedScenarios over a Supabase double
that behaves like schema_phase_prefs.sql (org_prefs rows keyed by org_id, the
set_org_pref RPC's one-key `||` merge).

- **F1 (page)** the Forecast page's YEAR 0 strip paints the dashboard's four
  headline figures through the one function the dashboard computes them with
  (lib/dashboardHeadline.computeDashboardHeadline), and each equals the served
  field the engine's anchor reads (assembled_pl.revenue / ebitda /
  net_income_statutory, assembled_bs.cash); the dashboard itself computes its
  headline through the same function.
- **F5 (page)** every Forecast statement cell and every Scenarios outcome cell
  whose served figure is non-zero paints that figure (never blank, "—" or a
  zero); a sub-unit figure keeps its cents; every period with debt paints its
  interest; the Scenarios summary never shows a bare placeholder.
- **F6** a save lands in the company on screen (the RPC's p_org_id); it survives
  a reload (fresh query cache, fresh page, the double's rows only); a Scandia
  scenario never shows on Agras (fresh load, an in-session company switch, a
  foreign entry inside the bag); opening one re-sends exactly its saved template
  and levers.

**PLANT f6-foreign-entry** — `savedScenarios.ts`: the `r.orgId !== orgId` filter
removed. **PLANT f6-wrong-org** — `saveScenario` writes the list into another
org. **PLANT f6-no-persist** — `writeList` returns before the RPC.
**PLANT f6-open-drops-levers** — `Scenarios.tsx` opens a saved scenario with no
levers. **PLANT f1-page-builder-ebitda** — the strip paints the builder's
operating EBITDA (a second derivation). **PLANT f1-page-reconstructed-np** — the
strip paints assembled_pl.net_income instead of the account-121 seam.
**PLANT f5-page-sub-unit-zero** — the Forecast formatter back to whole units.
**PLANT f5-scenarios-dash** — the "none within the plan" summary back to "—".

```
RED (plant f6-foreign-entry)
AssertionError: expected 'Agras leakBase planScandia ownBase pl…' not to contain 'Agras leak'
RED (plant f6-wrong-org)
AssertionError: expected 'org-agras' to be 'org-scandia' // Object.is equality
AssertionError: expected { scenarios: [ { …(8) } ] } to be undefined
RED (plant f6-no-persist)
AssertionError: expected undefined to be 'org-scandia' // Object.is equality
RED (plant f6-open-drops-levers)
AssertionError: expected {} to deeply equal { Object (dso_days) }
RED (plant f1-page-builder-ebitda)
× agras: every year-0 figure is the dashboard's, and the engine's anchor field
→ expected 10776378.239999998 to be 10776378.24 // Object.is equality
RED (plant f1-page-reconstructed-np)
→ expected NaN to be 7533676.02 // Object.is equality
RED (plant f5-page-sub-unit-zero)
AssertionError: cf.change_in_receivables 2026-02 painted as zero or a dash: expected 'RON 0' to match /[1-9]/
RED (plant f5-scenarios-dash)
AssertionError: summary first-shortfall is a bare placeholder: expected '—' not to match /^[—-]?$/
```

**REVERT** — each file restored byte-exact (sha256 checked by the runner,
scratchpad fcst_tools/plants_fe.py); `Tests 55 passed (55)`.

**Language of the engine's fixed sentences** (added the same day, found on the
Romanian 390 px screenshots: the covenant slot, the runway and the strip formula
read in English on a Romanian page). lib/forecastSentences.ts translates an
ALLOWLIST of fixed served sentences (by code; the strip formulas by their
served text) and prints the served words verbatim in English.
**PLANT ro-served-english** — the translator returns the served text in every
language. **PLANT en-overruled** — English prints the copy instead of the served
words (a reworded engine sentence would be overruled).

```
RED (plant ro-served-english)
AssertionError: expected 'this is not served in this build' to be 'motorul nu servește încă această cifră' // Object.is equality
RED (plant en-overruled)
AssertionError: expected 'this is not served in this build' to be 'covenants are not modelled for this b…' // Object.is equality
```

REVERT — restored byte-exact; `Tests 57 passed (57)` over the gate's files. A
first en-overruled run stayed GREEN (the English copy equals today's served
text); the reworded-sentence test was added so the plant has something to red
on, rather than counting it.

A first f6-wrong-org plant (`p_org_id` taken from the list's last entry) stayed
GREEN — every entry already names the company on screen, so it moved nothing;
it was replaced by a plant that really sends the write elsewhere rather than
recorded as coverage.

**After the repair it reds on:** a year-0 figure on the Forecast page that is
not the dashboard function's, or not the served field the engine's anchor reads;
the dashboard's headline no longer computed by that function; a non-zero served
figure painted as a blank, a dash or a zero on either page; an allowlisted fixed
engine sentence left in English on a Romanian page, or an English page printing
anything but the served words; a period with debt
painting no interest; a saved scenario written to any org but the company on
screen, lost on reload, listed on another company, or re-opened with anything
but its saved template and levers. **It cannot see** RLS on org_prefs (the
migration's own tests), a two-tab race on the whole saved list (documented in
lib/savedScenarios.ts), or pixels.

### forecast-f-page — every served sentence in the reader's language (RO + EN)

Found on the Romanian 1440 px screenshots of this branch: the Forecast page's
statement rows ("Revenue", "Cost of sales", "Trade receivables"), its assumption
names (the wire ids, "pool fixed share.cost of sales", "dso days") and every
engine sentence that carries a figure (each lever's basis, the growth card's
basis and ladder, the funding-line pricing, the runway, every refusal) printed
in English on a Romanian page. The allowlist of FIXED sentences above covered
none of them.

The repair: statement rows and driver names come from the locale bundle
(forecast.row.*, forecast.driver.*, forecast.pool.*, English and Romanian);
`lib/forecastSentencesRo.ts` re-says each engine sentence template in Romanian,
anchored at both ends, under a DIGIT LAW — the Romanian carries exactly the
digit runs the engine served (a figure's two separators swap, 413,727,560.16 ->
413.727.560,16; years, dates, CAEN codes and account numbers are copied), checked
on every call; a breach, or a sentence no rule says in full, prints the served
English. English prints the served text byte for byte.
`frontend/lib/__tests__/forecastSentencesRo.test.ts` (added to this gate) puts
all 164 entries of the engine's own inventory (tests/engine/fixtures/forecast/
served_sentences.json, pinned by forecast-served-sentences) through the one
function the pages print with; the Scenarios digit gate (section 8 of
scenariosEngine) accepts a translated served sentence only when its digit runs
are the served sentence's, checked in the gate itself.

**PLANT ro-rule-invents-digit** — `forecastSentencesRo.ts`: the DSO rule prints
`x 360 zile` instead of the served day count. **PLANT ro-law-off** — the same,
with the digit-law check removed. **PLANT ro-english-leak** — the DSO rule
keeps "days sales outstanding". **PLANT ro-overrules-english** —
`forecastSentences.ts`: the English guard removed, so English readers get the
Romanian rules' output. **PLANT ro-number-convention** — a figure keeps the
English separators. **PLANT gate-trusts-translation** — the law removed and the
borrowing-rate rule prints "(365 zile)"; run against scenariosEngine's digit
gate.

```
RED (plant ro-rule-invents-digit)
AssertionError: painted in English on a Romanian page: expected [ …(4) ] to deeply equal []
RED (plant ro-law-off)
AssertionError: a Romanian rendering changed the served digits: expected [ …(4) ] to deeply equal []
RED (plant ro-english-leak)
AssertionError: English left inside a Romanian rendering: expected [ …(4) ] to deeply equal []
RED (plant ro-overrules-english)
AssertionError: expected 'Banca Naţională a României — țintă de…' to be 'Banca Naţională a României — flat inf…' // Object.is equality
RED (plant ro-number-convention)
AssertionError: a figure left in the English convention: expected [ …(73) ] to deeply equal []
RED (plant gate-trusts-translation)
× every digit on the page is a served figure, label or sentence > ro: base plus every template
AssertionError: a number is painted on the Scenarios page that is not a served figure, label or sentence: expected [ Array(1) ] to deeply equal []
```

REVERT — every file restored byte-exact (sha256 checked by scratchpad
fcst_i18n/plants_ro.py); `Tests 64 passed (64)` over the gate's files.

**After the repair it also reds on:** an engine sentence the pages paint that
comes out in English on a Romanian page; a Romanian rendering whose digit runs
are not the served ones; English words left in a Romanian rendering; a figure in
the English convention on a Romanian page; an English page printing anything
but the served words; a translated sentence on the Scenarios page carrying a
digit the engine did not serve. **It cannot see** whether the Romanian reads
well, or sentences the corpus books never provoke (those print in English, as
served, until the inventory grows to include them).

## forecast-served-sentences

| | |
|---|---|
| command | `python -m pytest tests/engine/test_forecast_served_sentences.py -q -s` |
| canary | `SCOPE forecast-served-sentences`, `worlds agras, agras_caen1011, agras_caen1011_paired` |
| work count | `GATE-WORK forecast-served-sentences units=(\d+)`, floor **150** (measured 164) |

**SCOPE** — `tests/engine/forecast_sentence_inventory.collect()`: the REAL
`create_app()` over the tenancy double on the four committed corpus books (agras
is files/agras_tb_2025.xlsx, the preliminary close, not the filed year), agras
with workspace CAEN 1011, and agras paired with carniprod dated one year back (a
SYNTHETIC pairing, labelled — the one way a committed book reaches the [book]
growth rung); GET /api/forecast at horizons 3 and 5, POST /scenario for every
template of packs/scenarios/templates.yaml and four lever overrides on base and
recession; every string served where the pages paint a sentence (driver basis,
alternative, ladder step, inert note, macro source, convention, runway, facility
limit, funding-rate basis, refused slot, refusal, unserved lever, 4xx detail),
with its code and kinds. The owner's local books never enter it.

**PLANT engine-sentence-reworded** — `src/engine/forecast/assumptions.py`:
"HELD flat rather than grown" -> "HELD flat, never grown" (the interest-income
basis).

```
RED (plant engine-sentence-reworded)
E   AssertionError: served_sentences.json is stale (re-capture with scripts/gen_fp1_2_fixtures.py, then re-read frontend/lib/forecastSentencesRo.ts)
FAILED tests/engine/test_forecast_served_sentences.py::test_the_committed_sentence_inventory_is_what_the_route_serves
```

**REVERT** — restored byte-exact (sha256 checked); `1 passed`, `GATE-WORK
forecast-served-sentences units=164`.

**After the repair it reds on:** a sentence the pages paint reworded, added or
dropped by the engine without the inventory being re-captured — the moment the
Romanian rules must be re-read, because a rule that no longer matches prints the
engine's English on a Romanian page. **It cannot see** sentences the corpus
books never provoke, or whether a sentence is a good explanation.
