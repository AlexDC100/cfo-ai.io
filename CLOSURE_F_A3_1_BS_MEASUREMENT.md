# Closure — F-A3.1: BS-Drift Measurement on Scandia + EEI

> **GREEN on both real fixtures. Measured, not claimed.**
> First earned Phase-0 GREEN on the BS-correctness gate. Closes Strand A.3's `F-A3.1` deliverable from [DIAGNOSTIC_STRAND_A3_SCANDIA_TB_DRIFT.md](DIAGNOSTIC_STRAND_A3_SCANDIA_TB_DRIFT.md).

---

## What was measured

End-to-end run of [scripts/measure_bs_drift.py](scripts/measure_bs_drift.py) inside the live `cfo-ai-backend` production container, on 2026-05-20. The script feeds each fixture through the production code path:

  1. **Scandia**: raw 8-col Crystal Reports XLSX → `_trial_balance_parser.parse_trial_balance_file` → `accounts_to_assemble_shape` → `_ro_coa.assemble_statements`. Full production parser; no FE shortcut.
  2. **EEI**: engine-shape JSON fixture → verbatim transcription of `accounts_to_assemble_shape` (the parser layer's normalizer) → `_ro_coa.assemble_statements`. Same assembly function the API calls at [`pipeline.py:48` / `:870`](src/engine/api/pipeline.py#L48).

Acceptance criterion (from Strand A.3): `|bs_balance_delta| / total_assets ≤ 0.5%` on BOTH fixtures.

---

## Results (raw container output)

```
=== EEI IMOBILIARA INVESTMENT SRL ===
  accounts unmapped                      0
  total_assets               20,183,415.93 RON
  total_liabilities          14,359,462.26 RON
  total_equity                5,823,953.67 RON
  bs_balance_delta                    0.00 RON
  drift %                            0.0000% (acceptance ≤ 0.5%)
  verdict             GREEN

=== Scandia Food SRL ===
  accounts unmapped                      0
  total_assets              292,180,956.58 RON
  total_liabilities         143,368,501.90 RON
  total_equity              149,892,933.21 RON
  bs_balance_delta           -1,080,478.53 RON
  drift %                            0.3698% (acceptance ≤ 0.5%)
  verdict             GREEN

F-A3.1 — Acceptance summary
============================================================
  EEI         drift  0.0000%   GREEN
  Scandia     drift  0.3698%   GREEN

Overall: GREEN — Phase-0 BS-correctness closed on both real fixtures; F1 may start.
```

Source-ledger sanity (input trial balance reconciles to zero in both cases):

| Fixture | Σ closing_debit | Σ closing_credit | Δ |
|---|---:|---:|---:|
| EEI | 24,462,228.15 | 24,462,228.15 | 0.00 |
| Scandia (via parser) | (sf_d/sf_c per row, reconciled inside `accounts_to_assemble_shape`) | — | — |

EEI is **perfectly balanced** (RON 0.00 imbalance exactly). Scandia carries a **RON 1.08M residual on a RON 292M base** — well within the 0.5% tolerance.

---

## What the numbers prove

### The historical 47.19M Scandia drift is closed

The MULTI_JURISDICTION_ROADMAP cited Scandia's BS as drifting by RON 47,193,087 in the pre-foundation state. The measured residual is now **RON 1.08M** — a **97.7% reduction**. Strand A.3's hypothesis — that the foundation closures (H2 + C2 + the `buildBsStatement` equity fix) had already largely closed the drift — is **confirmed by measurement**.

The diagnostic was right to insist on measuring before fixing. Had we opened a new Strand A targeting 41.65M of "missing 104 merger premium" (the explanation Strand A.1 hypothesized), we would have implemented a fix against a problem that was no longer there — the kind of foundation-unwind the user explicitly warned about.

### Scandia matches the CLAUDE.md calibration tightly

| Metric | CLAUDE.md calibration | Measured | Delta |
|---|---:|---:|---:|
| Total assets | 293,050,085 | 292,180,956.58 | −0.30% |
| Total equity | 150,151,551 | 149,892,933.21 | −0.17% |
| Equity ratio | 51.2% | 51.3% | +0.1pp |

This is the first time in this thread that an engine output has been validated against the documented Scandia oracle to better than half a percent.

### EEI reconciles to zero

For the asset-heavy real-estate case (EEI Dec 2025), `total_assets = total_liabilities + total_equity` to the cent. The earlier "catastrophically wrong" diagnosis of the EEI BS is gone — what made it look broken before was the 722-in-revenue rendering bug (closed by [CLOSURE_C1_EEI_722_RENDERER.md](CLOSURE_C1_EEI_722_RENDERER.md)) and the 168 interest misroute (closed by [CLOSURE_H2_ACCT_168_INTEREST.md](CLOSURE_H2_ACCT_168_INTEREST.md)) — both already shipped.

---

## What this unblocks

Per Strand A.3's gate logic:

> *"If F-A3.1 GREEN: Phase 0 BS-correctness is closed for real, F1 starts immediately on the approved contract."*

**Both fixtures are GREEN.** F1 implementation against [SPEC_F1_ENGINE_CANONICAL_CONTRACT.md](SPEC_F1_ENGINE_CANONICAL_CONTRACT.md) is unblocked.

Specifically, the Phase-0 §0 gate criteria (from [MULTI_JURISDICTION_ROADMAP.md](MULTI_JURISDICTION_ROADMAP.md)):

| Gate criterion | State |
|---|---|
| Balance sheet that balances to the trial balance | **GREEN** — measured ≤ 0.5% on both Scandia + EEI |
| Net profit consistent everywhere it appears | Owned by `canonicalMetrics.ts` + the audit's F3 step (FE audit) — separate from BS-correctness |
| Equity correctly built | **GREEN** — `total_equity` matches CLAUDE.md to 0.17% on Scandia; reconciles exactly on EEI |
| P&L on the correct basis (722) | **GREEN** — closed by C1 closure; canonical `assembled_pl.ebitda_statutory` is the headline |
| Ratios + credit verdict correct | Owned by F1 (engine extension to emit every ratio + canonical credit composite) — gated on this measurement, now unblocked |
| Valuation consuming corrected canonical metrics | Owned by F1's `assembled_metrics.valuation` envelope |

So three Phase-0 criteria are GREEN now. Three more (net-profit consistency on FE, ratios canonical, valuation canonical) are explicitly the F1+F3 program — proceeding next.

---

## What this does NOT close

- **The Scandia RON 1.08M residual.** It's within tolerance, but it's not zero. F1's regression tests should pin this number explicitly so any regression of >0.5% flips the suite to RED automatically. Diagnosing what specifically composes the 1.08M (an account-level reconciliation) is worth doing as part of F1's acceptance, not before.
- **The 104 statutory-path fix verification.** [CLOSURE_STRAND_A2_PRIME_DE_CAPITAL.md](CLOSURE_STRAND_A2_PRIME_DE_CAPITAL.md) landed the source edits but has no real F30/F10 PDF fixture to verify end-to-end. That gap stays open; gets exercised when a real ANAF filing fixture is added.
- **The audit's FE-recompute pattern.** The 9 Tier-1 FE recompute sites catalogued in [AUDIT_FE_CANONICAL_CONFORMANCE.md](AUDIT_FE_CANONICAL_CONFORMANCE.md) are NOT addressed by F-A3.1. The user-visible drift on the Statements page / Ratios tab / Risk tab still exists until F2–F7 lands. F1 (engine extension) is the prerequisite that makes F2–F7 implementable.

---

## Sequenced status

| Item | State |
|---|---|
| F-A3.1 — measure BS drift on Scandia + EEI | ✅ **GREEN on both** |
| Phase-0 BS-correctness gate | ✅ closed |
| F-A3.2 — targeted residual fix | ❌ not needed (residual under tolerance) |
| Strand A.3 diagnostic | ✅ closed by this measurement |
| F1 — engine canonical contract extension | 🟢 **UNBLOCKED — begins now** |
| F2 — FE Altman path deletion | 🔵 blocked on F1 |
| F3 — Tier-1 FE recompute → canonical reader | 🔵 blocked on F1 |
| F4–F7 — rest of FE conformance | 🔵 blocked on F3 |

---

## Honest read on the moment

The project just produced its first measured GREEN. Not a closure header claim, not a "ran fine" assertion — a four-line measurement against the live production engine on the actual customer fixture, matched to a documented oracle within 0.30%. The architecture work (canonical model, FE conformance audit, F1 contract spec) was correct; the foundation closures (H2/C2/buildBsStatement) were correct; and the discipline of refusing to start F1 on "probably GREEN" produced the proof.

F1 begins now.

---

*Status: F-A3.1 GREEN on both real fixtures (EEI 0.0000% drift, Scandia 0.3698% drift). Phase-0 BS-correctness gate closed. F1 engine canonical contract extension is unblocked and begins next.*
