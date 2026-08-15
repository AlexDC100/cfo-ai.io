# canonical_bs v2 — the single Balance Sheet authority (contract)

Every builder implements against THIS shape. It is computed ONCE, at write time, by the
engine assembler; persisted inside `financial_periods.assembled_canonical_v1.canonical_bs`
(new key in the existing JSONB — no schema migration); served verbatim by `/api/period`
as `statements.canonical_bs`; rendered by the FE and serialized by exports WITHOUT any
arithmetic. Disagreement between banner, tab, API, and export becomes architecturally
impossible because there is exactly one object.

```jsonc
{
  "schema": "bs_v2",
  "mapping_version": "ro_omfp1802_v2",       // bump on ANY rule change; NEW constant in chart_of_accounts.py
  "extraction": {
    "method": "deterministic" | "llm",        // llm ⇒ status can never be BALANCED; cap at MINOR_DRIFT w/ warning
    "parser_version": "tb_parser_v4",         // bump when parser logic changes
    "source_format": "saga_10_col" | "saga_compact_6_col" | "generic_4_col" | "pdf_positional" | "statutory_f30_f10" | "llm_freeform",
    "number_locale": "ro" | "anglo",          // detected PER DOCUMENT (majority vote over cells), never mixed
    "sheet": "Document_CH14", "header_row_index": 0
  },
  "source_anchor": {                           // requirement 2 — external conservation invariant
    "totals_row_found": true,                  // the blank-account-code totals row, when the format carries one
    "pairs": {                                 // per column pair: file value, extracted sum, delta
      "si":  { "file_debit": 63478148.44, "file_credit": 63478148.44, "extracted_debit": 0, "extracted_credit": 0, "delta_debit": 0, "delta_credit": 0 },
      "rl":  { ... },
      "rc":  { ... },                          // total sume — null pairs allowed when format lacks the block
      "sf":  { ... }
    },
    "anchor_status": "MATCHED" | "DIVERGED" | "NO_ANCHOR",   // DIVERGED ⇒ extraction FAILED: status = MATERIAL_IMBALANCE, diagnosis D0
    "source_balanced": true                     // per-pair D=C on the FILE's own numbers; false ⇒ "Sursă dezechilibrată: X RON" + which pair
  },
  "rows": [                                     // presentation-ready, ordered; FE renders as-is
    { "id": "ppe_land", "section": "non_current_assets", "label_key": "bs.row.land", "label": "Land",
      "account_codes": ["211"], "amount": 2573536.72, "opening": null,
      "leaf_ids": ["211101", "211102"] }        // drill-down to envelope leaves (traceability)
  ],
  "sections": [                                 // OMFP 1802 bilanț logic mapped to app hierarchy
    { "id": "non_current_assets", "subtotal": 11796444.09 },
    { "id": "current_assets", "subtotal": 27397734.37 },
    { "id": "prepaid_expenses", "subtotal": 0 },
    { "id": "equity", "subtotal": 23924083.72 },
    { "id": "provisions", "subtotal": 0 },
    { "id": "non_current_liabilities", "subtotal": 1440419.23 },
    { "id": "current_liabilities", "subtotal": 12934654.20 },
    { "id": "deferred_income", "subtotal": 941634.37 }
  ],
  "totals": { "assets": 39194178.46, "equity": 23924083.72, "liabilities": 15316707.80,
              "equity_plus_liabilities": 39240791.52,
              "current_assets": 27397734.37, "current_liabilities": 12934654.20 },
  "difference": -46613.06,                      // assets − (equity+liabilities); THE drift; banner % derives from this
  "status": "BALANCED" | "MINOR_DRIFT" | "MATERIAL_IMBALANCE",
  // tolerance: BALANCED  iff |difference| ≤ max(1 RON, 0.001% of assets)
  //            MINOR_DRIFT iff |difference| ≤ 0.5% of assets
  //            MATERIAL_IMBALANCE otherwise — FE MUST NOT show "Quality checks passed"
  "diagnosis": [                                // populated when status != BALANCED, deterministic order D0-D8
    { "code": "D2_FINGERPRINT", "detail": "account 4511 amount 46613.06 ≈ difference", "leaf_ids": ["4511"] }
  ],
  "unmapped": [ { "code": "8038", "name": "...", "sf_d": 0, "sf_c": 123.0, "reason": "no_rule" } ],
  "excluded": [ { "code": "891", "reason": "opening_balance_sheet_account" } ],
  "invariants": {                               // each recomputed and asserted at build time
    "assets_eq_row_sum": true,                  // totals.assets == Σ asset section subtotals == Σ asset rows
    "el_eq_row_sum": true,
    "source_conservation": true,                // Σ|classified| + Σ|unmapped| + Σ|excluded| accounts == source account census
    "p121_cross_check": { "ok": true, "p121": 7533676.02, "cls7_minus_cls6": 7533676.02 }  // when classes 6/7 present
  }
}
```

## Diagnostic codes (deterministic order — Phase 4)
- `D0_ANCHOR_DIVERGENCE` — extracted column sums ≠ file totals row (per pair, amount shown)
- `D1_SOURCE_IMBALANCED` — the FILE's own pair D≠C: "Sursă dezechilibrată: X RON (pereche Y)"
- `D2_FINGERPRINT` — leaf amount ≈ |difference| (±1 RON) or ≈ |difference|/2 (sign flip)
- `D3_CONTRA_MISPLACED` — 28x/29x/39x/49x/59x found on liability side
- `D4_BIFUNCTIONAL_SIDE` — 4111/401/455/461/462/473/5121/117/121/4428 classified against its balance side
- `D5_DUPLICATE_ROWS` — same account code appearing with identical amounts more than once
- `D6_121_MISMATCH` — 121 ≠ class7 − class6 (both from the same TB)
- `D7_MAGNITUDE` — leaf value 100× / 1000× off vs its column total (separator parse error)
- `D8_OMITTED` — source census accounts absent from classified+unmapped+excluded
- `D9_UNMAPPED_INCLUDED` — unmapped accounts included in the statement totals as
  Unclassified rows (closing identity); emitted REGARDLESS of status (also on
  BALANCED) so the inclusion stays loud; always appended after D0-D8

## CLOSING-IDENTITY MODE (additive, 2026-08-15)

For ANY deterministic source whose SF pair balances (D=C after netting
off-balance class-8 single-entry rows), `difference` is EXACTLY 0.00 and
status BALANCED — by algebraic construction: the statement is a TOTAL
PARTITION where every value-bearing account contributes its signed closing
balance to exactly one side, accumulated in INTEGER CENTS (floats only at
serialization), so assets − (equity+liabilities) == ΣSF_D − ΣSF_C. Nonzero
`difference` remains possible only for: imbalanced sources (D1 — the
difference then EQUALS the source gap to the cent), anchor divergence (D0),
llm extraction, or fallback-path results (see `result_basis`). Additive keys:

- `source_anchor.closing_result` — `{basis: "sf", p121_cents, pl_net_cents,
  codes}`: the current-year result decomposition read from the SAME closing
  column as every BS leaf (121_SF + ΣSF(cls 7) − ΣSF(cls 6), exact integer
  cents). Attached by `RomaniaPack.attach_closing_result` at the pack parse
  seam (`parse_trial_balance` / `parse_trial_balance_csv`), so both the
  pipeline and the offline scripts carry it. Source data, never a plug.
- rows `unclassified_debit` (section current_assets) / `unclassified_credit`
  (section current_liabilities) — unmapped accounts' balances IN the totals,
  by their balance side, account codes listed (`account_codes` == `leaf_ids`);
  the accounts also stay in `unmapped` and D9 flags the inclusion. Never
  silently classified, never dropped.
- the derived `current_year_profit` / `current_year_loss` row documents the
  absorbed 121/6xx/7xx accounts via `leaf_ids` when sourced from the closing
  column (empty on the reconstruction fallback).
- `invariants.identity_holds` — `difference == 0` exactly, whenever the
  source is balanced (anchor `source_balanced`, or the extracted SF pair
  within 1 RON when no file totals exist) and extraction is deterministic;
  vacuously true otherwise. Emitted, not hard-asserted — False is the honest
  signal of a fallback-path or engine leak.
- `invariants.result_basis` — `"sf_closing_column" | "reconstruction"`.
- Excluded accounts (class 8 incl. 891/892, 581 transit) stay OUT of both
  the statement and the source-balance judgment. A nonzero 581 closing
  balance is the one known case that honestly breaks the identity (money in
  transit at period end) — it surfaces as a nonzero difference with
  diagnosis, never absorbed.

Property gate: `tests/engine/test_identity_property.py` — 200 seeded random
balanced TBs (classes 1-7, contra families, bifunctionals both sides, TVA,
117 both sides, pre-/post-closing/mixed/closing-only states, unmapped codes,
class-8 memo rows) assert `difference == 0.0` EXACTLY; 20 deliberately
imbalanced TBs assert `difference` == the injected gap exactly with D1.

AI (council) may PROPOSE a correction referencing a diagnosis entry; the deterministic
validator accepts it only with source evidence + all invariants passing + confidence
above threshold. AI never does arithmetic.

## Consumption rules
- `/api/period`: if `canonical_bs` present in the envelope → serve verbatim (skip the
  lossy round-trip for BS); legacy periods (no key) keep the current Fix A1 path.
- FE `buildBsStatement`: if `statements.canonical_bs` present → render rows/sections/
  totals/status directly, ZERO local arithmetic, no residual/plug machinery; legacy
  fallback preserved for old periods.
- Banner: band derives from `status` (+ `difference`/`totals.assets` for the %); the
  MATERIAL_IMBALANCE state replaces "Quality checks passed" with the diagnosis list.
- Exports (Excel/HTML): serialize `canonical_bs` rows and totals when present.
- `periodFacts`: `bs_balance_check` reads `difference` — its own recomputation is deleted.

## Determinism (requirement 1)
For recognized formats the numeric path is 100% deterministic: template recognition →
mechanical cell reads → rules → canonical_bs. `scripts/verify_determinism.py` runs
parse+assemble 5× per golden fixture and asserts BYTE-IDENTICAL canonical JSON
(json.dumps sorted keys). Wired into CI next to the EEI canonical check.

## Reprocessing (requirement 3)
`scripts/reprocess_documents.py`: for every active document with a stored source file —
run the new extraction+assembly OFFLINE, diff new vs stored envelope totals, emit a
per-period report (JSON + MD). Apply mode: archive the old envelope under
`assembled_canonical_v1.archives[]` (with its extraction/parser/mapping versions +
timestamp), write the new envelope + canonical_bs, set
`canonical_bs.reprocessed: { "changed": true|false, "previous_totals": {...} }`.
FE shows a "Figures updated by engine vX" note on changed periods. Never a silent overwrite.
