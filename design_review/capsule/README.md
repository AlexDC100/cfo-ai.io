# THE CAPSULE — DELIVERY PACK

What the owner was owed, and where each piece is.

| Owed | Delivered in | State |
|---|---|---|
| The grounded numeric demo — a real number, a working provenance jump, the citation footer, both themes | **`GROUNDED_DEMO.md`** · frames in `grounded-r2/` · receipt `grounded-r2/demo-report.json` | Number **delivered and cross-checked to the cent**. Provenance jump **RED** — it lands on the wrong tab; both ends captured anyway, see F2 |
| Post-fix latency, measured on the shipped surface | **`LATENCY.md` § SECOND PASS** · `latency-as-shipped.json`, `latency-repaired.json` | Tier-0 first paint **34.7 ms p50**. Tier-1 fact card **UNMEASURABLE as shipped** (F1), measured separately with the defect bypassed: the facts land at **24.5 ms** and the card paints at **7 317 ms** — a 300× hold. "First token" **does not exist** on this surface: nothing streams |
| Post-fix coverage, end to end, on the shipped surface | **`COVERAGE_E2E.md`** · `coverage-e2e.json` | **34.7% (25/72)** measured end to end, against K3's unit **51.4% (37/72)**. The 12-question gap is located and explained; the spend boundary itself leaked **0 of 24** |
| Before / after in both themes | **`BEFORE_AFTER_GROUNDED.md`** · `before-fictional/` ↔ `grounded-r2/` · plus the earlier surface comparison in `BEFORE_AFTER.md` | Delivered — and the before column is where **F1** was hiding |
| The autonomous-decisions report | **`DECISIONS.md`** | Delivered |
| — | **`FINDINGS.md`** | Four defects measuring found. None fixed here — the frontend and `_capsule_tools.py` are other lanes' files |
| — | **`MEASURED_TREE.md`** | The exact file hashes every number on these pages was taken against |

---

## How to re-run any of it

```bash
# 1. the sidecar — the REAL routers over a REAL trial balance
.venv/bin/python design_review/capsule/tools/demo_engine.py --port 8010
.venv/bin/python design_review/capsule/tools/demo_engine.py --port 8011 --repair-tool-body

# 2. the demo (exits 1 on the provenance-jump defect, by design)
node scripts/capsule_demo.mjs demo --label grounded-r2

# 3. latency, both ways
node scripts/capsule_demo.mjs latency --runs 9 --model-runs 5 --engine http://127.0.0.1:8010
node scripts/capsule_demo.mjs latency --runs 9 --model-runs 5 --engine http://127.0.0.1:8011

# 4. coverage, end to end over all 72
node scripts/capsule_demo.mjs coverage

# the fixture, as a standalone cross-check artifact
.venv/bin/python design_review/capsule/tools/make_period_fixture.py \
  --input files/prod_scandia_frozen_31.12.2025.xlsx --company "Scandia Food SRL" \
  --out design_review/capsule/fixtures/period-scandia-fy2025.json
```

Requires the vite dev server on :5173. The sidecars need `files/` present
(gitignored working copies); everything else is in the tree.

---

## The one thing to read if you read nothing else

The previous wave's screenshots were captured with
`design_shots_capsule.mjs --stub-tools 1` — the engine's tool layer
replaced by a literal inside the driver. Those figures were the driver's
own. Removing that stub, and only that stub, is what surfaced **F1**:
`POST /api/capsule/tools/*` has been returning `422` for every call, so
the Tier-1 fact card cannot paint at all and the model is billed to
answer questions with no evidence attached.

A stub put there to get a screenshot had been standing in for a broken
endpoint.

---

## VERIFICATION — what was run, and what it said

Nothing in this lane edits a `.ts`, a `.tsx` or a `.py` under `src/`.
The gates below are run to prove that, not to claim credit for them.

| | Result |
|---|---|
| `node scripts/check_tsc.mjs` | **PASS** — 662 project files typechecked, 10 known baseline errors, **0 new** |
| `.venv/bin/python scripts/corpus_replay.py` | **PASS — 18/18** |
| `.venv/bin/python scripts/check_corpus_policy.py` | **PASS** — 3644 files checked, every artifact on these pages in the tree |
| `node scripts/check_design_lint.mjs` | **PASS** — 0 hex, 0 shadow, 0 serif |
| `node scripts/check_stale_gates.mjs` | **PASS** — 26 known stale, **0 new**. Every one of the ten testids `capsule_demo.mjs` references is defined in the app |
| `.venv/bin/python scripts/verify_determinism.py` | **PASS** — 4 fixtures × 5 runs, byte-identical |
| `.venv/bin/python scripts/run_battery.py` | **27/30 green, 1 vacuous — FAIL.** Not 30/30. See below |

`vitest` was not run for this lane: it adds no `.test.ts` and changes no
TypeScript.

### The battery did not end 30/30, and the three items are named

**None of the three is this lane's, and both failures re-verify green on
their own immediately afterwards.** `scripts/run_battery.py` was being
edited by another lane *while the battery ran* (`git status` shows it
modified; the diff shows a conversion from tuples to typed `Gate(...)`
objects in progress), and both failures are that race:

1. **`pytest`** — 1 failed of 3258.
   `test_error_budget.py::test_battery_gate_list_includes_error_budget`,
   a test that reads `run_battery.py`'s gate list. Re-run on its own
   straight after: **22 passed**.
2. **`determinism`** — the gate's own output says
   `DETERMINISM GATE: PASS — all fixtures byte-identical across 5 runs`.
   The battery failed it on its **work floor**: *"examined 4 fixtures x5
   runs, floor 5."* `verify_determinism.py`'s `FIXTURES` table lists
   exactly four. The current `run_battery.py` already carries the fix and
   explains it in a comment (*"Floor 4 … a first draft guessed 5 from a
   truncated tail"*); my run read the file before that edit landed.
   Re-run on its own: **PASS, exit 0**.
3. **`public-sitemaps`** — NOTICE, ran clean and examined nothing,
   correctly recorded as **vacuous** and not counted as evidence. Its
   subject is absent on this host.

Reporting this as "30/30" would have been available and wrong. The number
is 27/30, and the reason each of the three is not mine is written above
so it can be checked rather than believed.
