# Deliverable A — Root cause: the 39.19M / 45.81M / "0.11%" Balance Sheet defect

**Status: root cause established with hard evidence, 2026-08-13.** This document is the
write-up half of deliverable A; the OMFP gap matrix (from the classification audit) and
the determinism test results follow as the audit/implementation completes.

## The visible defect

The Balance Sheet tab for period `fce6d3ea` (document
`Trial_Balance_Scandia_Frozen_31.12.2025.xlsx`) displayed **TOTAL ASSETS 39,194,178.46**
against **TOTAL EQUITY & LIABILITIES 45,813,217.53** — a 6.62M visible imbalance — while
the accuracy banner reported drift of **0.11%**. Both numbers were "real"; they came from
different code paths reading different books.

## Layer 1 — two representations from two code paths (fixed 2026-08-13, commit 4b6429d)

- `GET /api/period` re-assembles statements from persisted `statement_line_items`. That
  round-trip is **documented-lossy** (it drops `_IGNORE_BUCKETS` accounts such as 121/581
  and loses semantic routing context; `scripts/measure_bs_drift_roundtrip.py` measured up
  to 35% divergence on fixtures).
- An earlier fix (F3.27 "Fix A1") recognized this and overrode `bs_balance_delta` with
  the write-time envelope truth (`financial_periods.assembled_canonical_v1.methodology.totals`
  — the same source the F-A3.1 canary audits). **But it left `total_assets`,
  `total_equity`, `total_liabilities` carrying the lossy round-trip values.** The banner
  quoted the audited books (0.11% = 46,613 RON on 39.24M); the tab totals quoted the
  corrupted rebuild (liabilities +6.57M).
- Stacked on top, the frontend's `buildBsStatement` residual system compared the engine's
  `lt_debt` bucket (bank + leasing + LT interest only) against FE rows that also included
  15x provisions + 475 subsidies + 478 grants, minting a plug that cancelled 941,634 RON
  of real investment subsidies; a final "carve-outs" reconcile row then force-closed the
  section-vs-total gap by fabricating +7,514,060 of liabilities.
- Interim fix shipped (4b6429d): grand totals now come from the envelope; the lt_debt
  residual was split to match the engine's bucket composition. Verified live: the tab now
  shows 39,194,178.46 vs 39,240,791.52 — the difference IS the 0.11%.

This layer explains the *display* contradiction. It does not explain why the audited
books themselves carried a 46,613 RON imbalance from a perfectly balanced source. That is
Layer 2.

## Layer 2 — the deep defect: stale-analysis provenance + an unguarded numeric path

**CORRECTION (2026-08-13, evening).** The first draft of this section attributed the
prod-vs-local difference below to LLM extraction non-determinism. Deeper forensics
(reprocessing pass + document-linkage query) disproved that attribution and revealed
something worse. The evidence table, re-labeled correctly:

| Envelope read | total_assets | total_equity | total_liabilities | claimed SF debit sum | actually the analysis of |
|---|---|---|---|---|---|
| prod `fce6d3ea` (read 08-12/08-13) | 39,194,178.46 | 23,924,083.72 | 15,316,707.80 | 70,215,990.73 | **Agras Trial Balance 2025.xlsx** |
| local `9fcdb0f7` (Frozen scan, 08-13) | 52,722,896.54 | 7,756,589.15 | 44,966,307.39 | 60,205,165.12 | Frozen (correct) |
| the Frozen file itself | — | — | — | **60,205,165.12** | — |
| the Agras file itself | — | — | — | **70,215,990.73** | — |

Proof: the deterministic parser sums Agras's SF column to exactly 70,215,990.73 — the
figure in the `fce6d3ea` envelope — and the envelope's −46,613.06 balance delta is
Agras's own drift signature, reproduced deterministically on every Agras run.

The real defect chain on period `fce6d3ea`:

1. **2026-08-02**: an Agras document was scanned into this period; its analysis
   (line items + envelope) was persisted.
2. **2026-08-04**: the Agras documents were soft-deleted. The period KEPT the analysis
   artifacts — deletion does not clear or flag them — and displayed as an "empty" period.
3. **2026-08-12**: the user attached `Trial_Balance_Scandia_Frozen_31.12.2025.xlsx`. The
   scan completed, the document was linked as the period's source — **but the period
   continued serving the 2026-08-02 Agras envelope.** The screen said "Frozen"; the
   numbers were Agras's. Nothing in the system could detect the mismatch, because the
   envelope carried no record of which document it was built from.
4. **2026-08-13**: the user (coincidentally) uploaded Agras into the same period,
   making source and analysis agree again by accident.

Two systemic failures underneath:

1. **No provenance.** The persisted envelope did not record its source document, so a
   period serving another (even deleted) document's analysis was undetectable. Fixed:
   `stage_persist` now stamps `assembled_canonical_v1.provenance`
   {source_document_id, original_filename, content_hash, written_at}; readers can assert
   it against `period.source_document_id`.
2. **Circular self-validation + an unguarded LLM numeric path.** `source_data_quality`
   summed the *extracted* rows and checked D=C against themselves — it could confirm
   internal consistency but never fidelity to the document (the file's own totals row —
   SI 63,478,148.44 / RL 119,888,234.40 / RC 997,287,481.31 / SF 60,205,165.12, every
   pair D=C to the cent — was never consulted). And `stage_extract`
   (src/engine/api/pipeline.py:583) fell back to an LLM (`claude-opus-4-7`) that read and
   produced digits for any document the deterministic parsers rejected — including ALL
   CSVs — with no external anchor to catch infidelity. Both are now closed: the source
   anchor reconciles extraction against the file's own totals row per column pair, and
   recognized formats (SAGA 10-col, SAGA compact, generic 4-col, CSV) never touch the LLM.

## Why "0.11%" and never worse

The write-time assembly balances *whatever account set extraction hands it* using mostly
correct RAS rules, so residual imbalance stays small (46K on this document) even when the
underlying account set is wrong by millions in composition. Small drift + internal-only
validation = high confidence displayed over unfaithful numbers.

## Fix direction (approved, in progress)

1. **Deterministic parsing for recognized formats** (SAGA 10-column, SAGA compact,
   WinMentor, generic 4-column): template recognition + mechanical cell reads; the LLM
   never reads or produces digits — allowed only for ambiguous account-name
   interpretation and diagnosis proposals. CI gate: 5 identical runs → byte-identical
   canonical output.
2. **External anchor:** extraction must reconcile against the FILE's totals row; an
   extraction that balances internally but diverges from the source anchors is a FAILED
   extraction and must warn/block.
3. **Single canonical object** for totals + difference + status (BALANCED /
   MINOR_DRIFT / MATERIAL_IMBALANCE, tolerance max(1 RON, 0.001%)) consumed unchanged by
   API, UI, and exports — disagreement architecturally impossible.
4. **Versioned reprocessing** of all previously processed production documents with
   per-period old-vs-new diff report, in-app flag on changed periods, prior results
   archived under their extraction_version — no silent overwrites.

Golden anchor for this document: `files/prod_scandia_frozen_31.12.2025.expected.json`.
