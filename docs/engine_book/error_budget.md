<!-- HAND-MAINTAINED by the error-budget agent (Part E). Not generated:
     scripts/generate_engine_book.py must list this file in FOREIGN_PAGES
     and link it from INDEX.md, never write it. Update this page whenever
     the budgets change (operator sign-off required) or a new measurement
     run materially moves the numbers. -->

# The Error Budget

## Definition

> **Silent error rate** = wrongly served numeric fields carrying **no
> review flag** ÷ total numeric fields served, per lane
> (`deterministic` | `mechanical_mapped` | `llm`).

A field that is wrong but **flagged** (the served object carries
`needs_review`) counts as the system *working* — the flag is the
product's honesty mechanism, and honesty about uncertainty is the
contract. Only an unflagged wrong number is a silent error. A refusal
to parse at all (e.g. the Sibiu 2019 XLSX, rejected by the
deterministic header matcher) is likewise a *flag*, not silence: zero
fields were served, so zero fields can be silently wrong.

## Budgets — DO NOT WIDEN

| Lane | Budget (silent errors) |
|---|---|
| `deterministic` extraction | **0.01%** (1 in 10,000 fields) |
| `mechanical_mapped` extraction | **0.01%** |
| `llm` extraction | **0.01%** |
| `classification` (account → statement line decisions) | **0.05%** |

The numbers live in one committed constants block
(`scripts/measure_error_budget.py`, `EXTRACTION_BUDGET` /
`CLASSIFICATION_BUDGET`) under a `DO NOT WIDEN` comment — the same
discipline as `scripts/measure_bs_drift.py` and
`scripts/measure_cross_path.py`. Widening a budget is a product
decision recorded here with the operator's sign-off; it is never the
fix for a red gate.

## Measurement protocol

The gate is `scripts/measure_error_budget.py` — battery gate
`error-budget` (`scripts/run_battery.py`), exit 1 iff any **silent**
mismatch exists on the labeled set or a lane with sufficient N exceeds
its budget. Two consecutive runs produce byte-identical output (no
timestamps, sorted iteration; locked by
`tests/engine/test_error_budget.py`). Each run writes
`data/obs/error_budget_last.json` atomically; `/api/ops`, the Ops page
and `scripts/engine_ops.py status` read it (honest "not measured" when
absent).

**Source (a) — corpus goldens.** For every corpus case the replay
harness's own machinery (imported from `scripts/corpus_replay.py`,
never a mirror) re-runs the full offline pipeline in-process, and every
numeric leaf of the served `canonical_bs` (row amounts, section
subtotals, totals, difference, source-anchor pairs) is compared against
the verified-frozen label in `expected/served_envelope.json`.
Classification is measured against `expected/classification.json`
(every scalar leaf = one classification decision). Lanes attribute by
`expected_parser`: the deterministic parsers → `deterministic`; the two
mocked model lanes → `llm`. No live API call is structurally possible
(the corpus guard nulls `anthropic` per case).

**Source (b) — fixture anchors.**
`files/ground_truth/verified_anchors_v1.json` holds hand-verified
board-report values (incl. the six 121 closings) compared against
*live* runs of `RomaniaPack.run_deterministic_tb` over the local
`files/*.xlsx` fixtures (sha256-pinned). Totals/net_result are read
through `FactsGateway` accessors only; account-level anchors resolve
against served `canonical_bs` rows, and **only** where granularity
matches (a single-code row that either *is* the anchor's whole account
group or whose leaf set is exactly the anchor's analytic). Anchors
finer than the served rows, and P&L-movement anchors (class 6/7 — not
on a balance sheet), are reported **NOT COMPARABLE**, never guessed.
Anchor labels carry their own precision: whole-RON board values compare
within 0.5 RON, cent-exact labels within half a cent — that is the
label's resolution, not engine slack. `files/` is gitignored, so this
half runs only where the fixtures live (operator machines); in CI the
script degrades to a loud notice and the corpus half stays fully
strict.

**Source (c) — weekly production sampling (documented operator
procedure, deliberately not automated).** Once per week the operator:

1. draws **N = 10** random documents served in production that week
   (`SELECT ... ORDER BY random() LIMIT 10` over the week's periods);
2. has a human double-verify every numeric field of each served
   `canonical_bs` against the uploaded source file (two people, or one
   person twice with a day between passes — the label must be more
   reliable than the engine);
3. appends confirmed values to the measurement set (new fixtures +
   anchors in `verified_anchors_v1.json`, or — preferred, because CI
   can see it — anonymized corpus cases via the redaction toolchain);
4. re-runs `scripts/measure_error_budget.py` and updates the numbers
   below.

This is zero-owner by design: the procedure is documented and cheap
(~1h/week); nothing automates the human verification because the whole
point is a label the pipeline did not produce.

## Statistical method

Per lane, with `k` silent mismatches over `n` fields, the script prints
the measured rate and a **95% Wilson score interval** (stdlib
`statistics.NormalDist`; no scipy/numpy — the repo's gate scripts are
stdlib-only, Python 3.9-compatible). Sufficiency: the smallest `n`
whose zero-mismatch upper bound certifies a budget `b` solves
`z²/(n+z²) ≤ b`, i.e. `n ≥ z²(1−b)/b`:

| Budget | N required (k = 0) |
|---|---|
| 0.01% (extraction) | **38,411** clean fields |
| 0.05% (classification) | **7,680** clean decisions |

A lane below that N prints **"N INSUFFICIENT to certify"** and the
target is *never claimed met* — the measured-so-far rate and its CI are
reported instead. `mechanical_mapped` currently has no measurement
source at all and says so.

## Measured numbers (run of 2026-08-25, local, corpus + anchors)

```
lane deterministic     measured 0.0000% on 908 fields — 95% CI [0.0000%, 0.4213%]
                       N INSUFFICIENT to certify <0.0100% (needs ≥38411 clean fields)
lane mechanical_mapped no measurement source yet — 0 fields; nothing certified
lane llm               measured 0.0000% on 59 fields — 95% CI [0.0000%, 6.1129%]
                       N INSUFFICIENT to certify <0.0100% (needs ≥38411 clean fields)
lane classification    measured 0.0000% on 5396 fields — 95% CI [0.0000%, 0.0711%]
                       N INSUFFICIENT to certify <0.0500% (needs ≥7680 clean fields)

anchors: 13 labeled fields compared across 6 fixtures; 27 anchors NOT COMPARABLE
         (P&L-movement anchors and rows coarser than the anchor's analytic);
         sibiu_2019 refused by the deterministic lane (a refusal is a flag).
```

Honest reading: **zero silent errors observed on every labeled field we
have** — and the labeled set is still one to two orders of magnitude
too small to *certify* the extraction budget. The path to certification
is the weekly sampling protocol above (each verified doc adds ~60
served numeric fields plus its classification decisions) and the
anonymized promotion of verified fixtures into `corpus/`.

## Ops surface

- `GET /api/ops` → `error_budget` section
  (`engine.obs.status.read_error_budget_record`).
- Ops page (`frontend/pages/cfo/Ops.tsx`) — "Error budget" card with
  the calm insufficient-N copy; the drift grid also carries the Part-E
  KPI rates (`consensus_agreement_rate`, `interpreter_call_rate` — a
  rate that should *decline* as the template library grows —
  `template_hit_rate`), all honest `null` until their sources emit.
- `scripts/engine_ops.py status` — the terminal twin of both.
