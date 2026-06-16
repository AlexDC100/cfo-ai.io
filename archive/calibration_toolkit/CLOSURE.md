# F3.12 — Calibration Toolkit Formal Close

> **Status:** archived 2026-05-23. The engine has graduated past the need for
> a parallel oracle. This directory is preserved for forensic reference; do
> not extend or re-activate the toolkit without re-opening the calibration
> workstream explicitly.

---

## What this directory was

A standalone Python implementation of the Romanian financial-analysis
methodology (`financial_analysis.py`, 1,084 lines, pure pandas) plus its
methodology document (`financial_analysis_methodology.md`, 382 lines) and
two calibration ground-truth dumps (`scandia_oracle_bs_detail.txt`,
`scandia_oracle_cf_detail.txt`).

The toolkit served three roles over the F1 → F3 sprint:

1. **Calibration oracle.** Whenever the engine produced a number, the
   toolkit could run the same trial balance through and emit a comparable
   reference value. When the two diverged, the toolkit was right by
   default and the engine was investigated. This was the primary mechanism
   for catching engine routing bugs during the F1.a → F1.h port.

2. **Methodology canonical source.** The 8-section framework
   (Overview → P&L → BS → CF → Ratios → Valuation → Risk &
   Recommendations) lives in `financial_analysis_methodology.md`. Engine
   code referenced this document by section number in inline comments
   for traceability (e.g., "Per methodology Section 5 ratios table…").

3. **Onboarding artifact.** New Claude Code sessions could run
   `financial_analysis.py` against a fresh trial balance to produce an
   end-to-end HTML report without spinning up the full SaaS stack —
   useful for one-off analyses and for sanity-checking what the
   methodology actually demanded before touching engine code.

The full content of both files is **embedded verbatim in the project root
`CLAUDE.md` (Appendices A and B)** so a fresh session loading the project
gets the methodology + implementation regardless of whether they ever look
inside this directory. Archival does NOT erase the knowledge — only its
runnable-standalone form.

---

## Why the close happens now

The F3 sprint closed three milestones that retire the oracle's primary
function:

- **F3.8** — Systematic RAS coverage pass landed 25 catchall MappingRules
  per OMFP 1802, dropping Agras drift 2.50% → 0.12%, Retail 1.99% → 0.00%,
  Frozen 0.29% → 0.00%. The 8-fixture regression registry now spans every
  layout dialect we've encountered (Crystal Reports 8-col, Document_CH14
  10-col, SAGA extended 20-22 col, WinMENTOR PDF, JSON fixture, real-
  estate developer model, multi-store retail, single-asset CRE).

- **F3.9 + F3.10** — Source-data telemetry surfaces sf_d/sf_c raw
  imbalance to the operator (so engine-fault vs source-fault is explicit);
  semantic-name fallback routes novel codes by Romanian keyword matching
  when no MappingRule matches. The engine now handles uploads from
  industries it has never seen before, with auditable degradation.

- **F3.11** — End-to-end wiring of the F3.9 telemetry: pipeline.py
  computes + persists; FE renders an amber WARN banner above the
  analysis when the source-data imbalance exceeds 2%. The dashboard
  now distinguishes "engine got it wrong" from "the source file got it
  wrong" in real time, removing the oracle's job of doing that
  comparison manually.

Combined with the two production gates — F3.1-PARITY (byte-identical
output on EEI + Scandia) and F-A3.1 (per-fixture BS drift ≤ thresholds on
all 8 fixtures, GREEN end-to-end at deploy) — the engine's correctness
is now mechanically verified on every change. The oracle's role of being
"the second opinion when something looks off" is taken over by the
regression registry: any engine change that drifts on Scandia / EEI by
0.01 RON trips F3.1-PARITY and rolls back automatically; any change that
adds drift to one of the 6 newer fixtures trips F-A3.1.

---

## What lives here now

| File | What it is | Frozen as of |
|---|---|---|
| `financial_analysis.py` | The 1,084-line standalone implementation | engine version `v2.1+f3.10` |
| `financial_analysis_methodology.md` | The 382-line methodology doc | unchanged since F2.4 |
| `scandia_oracle_bs_detail.txt` | Scandia FY2025 balance sheet reference dump | F1.a calibration run |
| `scandia_oracle_cf_detail.txt` | Scandia FY2025 cash flow reference dump | F1.a calibration run |
| `README.md` | The original "this is the calibration oracle" README | now historical |
| `CLOSURE.md` | This file | F3.12 |

None of these files are imported, executed, or read by the engine, FE,
test harnesses, or CI at runtime. The 5 source-code comments in engine /
FE that previously cited `reference/financial_analysis.py:NNN` were
updated under F3.12 to point to `archive/calibration_toolkit/...` so the
traceability stays exact.

Historical CLOSURE_*.md and DIAGNOSTIC_*.md documents in the repo root
intentionally retain their `reference/...` paths as point-in-time
forensic records — those documents describe the world as it was when
they were written, and updating them would falsify history.

---

## What replaces it

The oracle's job — "give me a defensible second opinion on this engine
output" — is now distributed across three places:

1. **The regression registry** at
   `src/engine/country_packs/ro_romania/fixtures/regression_baselines/`
   captures 8 known-good engine outputs (EEI, Scandia, Sibiu, Frozen,
   RealEstate, Agras, Carniprod, Retail). Every engine change is gated
   against this registry via F3.1-PARITY (byte-identical) and F-A3.1
   (drift ≤ per-fixture threshold) before deploy.

2. **The BASELINE_HISTORY.md ceremony** at the same path records every
   intentional baseline change with operator authorization, pre-state
   archive, and explicit rationale. This is the modern equivalent of
   "the oracle says X, the engine says Y — which one is right?" except
   the answer is now negotiated explicitly and recorded permanently.

3. **The F3.9 / F3.11 source-data telemetry** surfaces the underlying
   source-file imbalance directly to the operator on the dashboard.
   The earlier reliance on a CFO + the oracle to spot "engine number
   looks off → must be the engine" is replaced by an automatic UI
   signal that distinguishes engine-fault from source-fault.

---

## Re-activation criteria

Do NOT re-open the toolkit lightly. The triggers for re-activating would be:

- A real-world upload arrives that produces engine output materially
  different from what a trained CFO would expect, AND the regression
  registry doesn't catch it (i.e., F-A3.1 GREEN but the human eye says
  "this is wrong"). In that case, run the toolkit on the same file to
  triangulate.

- A new country pack starts (the methodology is RAS-specific; a new
  pack would need its own calibration oracle in a parallel directory,
  not in this one).

- A migration that touches the canonical mapper substantively enough
  that re-validating the entire ratio + valuation + credit-grade stack
  is warranted. In that case, run `financial_analysis.py` over each
  fixture and diff against the registry baselines as a third-party
  sanity check.

For routine engine work, the regression registry + F3.1-PARITY +
F-A3.1 are the truth. The oracle is now a sealed reference.

---

## Provenance

- Toolkit authored: Q2 2025 during the F1 sprint as the calibration
  spine for the engine port.
- Calibrated against: Scandia Food SRL FY2025 trial balance (809
  accounts, Crystal Reports format, 460.96M RON balanced trial balance).
  Anchor values in `financial_analysis_methodology.md` Section 8.
- Final engine version validated against the toolkit: `v2.1+f3.10`
  (post-F3.10 semantic-name fallback, before this F3.12 archival).
- Engine F-A3.1 verdict at archival: 8/8 GREEN.
- Engine F3.1-PARITY verdict at archival: GREEN (EEI + Scandia
  byte-identical).

This close is intentional and final. The toolkit served its purpose.

— Romania pack, F3.12, 2026-05-23
