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

## RECONCILIATION FLOW (additive, 2026-08-15) — spec'd by the operator

A calm, reversible, validator-gated fix for files that land slightly off. The
engine owns arithmetic; AI may only PROPOSE; the deterministic validator decides.
No path produces BALANCED from altered numbers — RECONCILED is a distinct state.

Trigger (deterministic, computed on every build; served on canonical_bs):
- `reconcile_offer: true` iff 0 < |difference| / max(assets, equity_plus_liabilities)
  <= 0.001 (0.1%) AND no accepted reconciliation is stored. Above 0.1%: no offer
  (needs a human); exactly 0: BALANCED, no offer.

Action (only on explicit user request — POST /api/period/{id}/reconcile):
1. DETERMINISTIC diagNOSIS first, in order: (a) rounding-cent drift (|difference|
   <= 1 RON x number of sections touched); (b) a single unmapped/unclassified
   account whose |balance| equals |difference| to the cent; (c) a sign/contra
   side-flip whose 2x|balance| equals |difference|. Found -> that is the proposal.
2. Only if inconclusive: AI proposes {target_account, amount_cents, rationale} —
   a PROPOSAL OBJECT, never a mutation. Model + prompt_version recorded. AI
   unavailable/failing -> inconclusive -> hand off to human mapping (409 response
   with the diagnosis; FE shows it).
3. VALIDATOR GATE: re-run the full canonical build against the SOURCE figures
   with the proposed adjusting entry applied as a SYNTHETIC row ("Diferențe de
   reconciliere", synthetic: true, leaf_ids []). Accept ONLY if the result closes
   to EXACTLY 0 cents. Otherwise reject -> stay IMBALANCED + diagnosis.
4. Acceptance -> status "RECONCILED" (never BALANCED), served with:
   `reconciliation: { content_hash, original_difference, applied_delta,
   target_row_id, origin: "deterministic"|"llm_proposed", diagnosis_code,
   model, prompt_version, applied_at, applied_by, reversible: true }`.
   The synthetic row carries a visible marker; every adjusted figure tooltips
   its reason. Undo: POST /api/period/{id}/reconcile/undo -> removes the stored
   entry, next build serves the original status.

Persistence & refresh stability: the accepted reconciliation persists in
`assembled_canonical_v1.reconciliation` KEYED BY provenance.content_hash.
Serving path applies it only when the hash matches the period's current source
document — a re-scan of a different file drops it automatically. Hard refresh
re-serves RECONCILED with its receipt; source cents are NEVER overwritten.

Status vocabulary note: the existing ladder (BALANCED / MINOR_DRIFT /
MATERIAL_IMBALANCE) is unchanged; RECONCILED is a fourth, explicitly-entered
state. The operator-spec names "IMBALANCED" ~= MINOR_DRIFT|MATERIAL_IMBALANCE.

## AUTO-RECONCILE addendum (revised operator spec, 2026-08-19)

Reconciliation is now a FULLY AUTOMATIC server-side stage: extract →
classify → validate → **auto-reconcile** → persist snapshot → serve all
views. Users never see a sub-threshold imbalance on ANY page — the client
is never sent an intermediate unreconciled state, and there is NO manual
Reconcile button. Everything above in "RECONCILIATION FLOW" still holds
(engine owns arithmetic, AI proposes only, validator accepts ONLY an
exact 0-cent close, source cents never overwritten, RECONCILED ≠
BALANCED) — this addendum revises WHO triggers it and WHEN.

**The stage** (`engine.api._reconcile.auto_reconcile_envelope`, called by
`pipeline.stage_persist` between the canonical build and the SINGLE
envelope write):
- ratio == 0 → BALANCED, no-op.
- 0 < |difference| / max(assets, E+L) <= 0.001 AND status MINOR_DRIFT AND
  deterministic extraction AND no suppression entry matches → diagnose:
  DETERMINISTIC first, in order **R1** rounding cents (|diff| ≤ 1 RON ×
  sections touched) → **R2** single unmapped == delta → **R3** sign/contra
  flip (2×|balance| == |diff|) → **R_DUP_TOTALS_ROW** duplicated totals
  row (exactly one D5_DUPLICATE_ROWS pair appearing twice whose removal
  closes to 0, i.e. |amount| == |diff| to the cent); AI proposal ONLY if
  inconclusive. The validator accepts ONLY an exact-zero close from
  source cents.
- accepted → status **RECONCILED** (never BALANCED) written into the SAME
  envelope the persist writes (`reconciliation` receipt: origin
  "deterministic"|"llm_proposed", applied_by "system:auto-reconcile",
  plus `parser_version` + `mapping_version` on the record) — a freshly
  scanned period is already RECONCILED on its very first serving.
- rejected proposal / AI unavailable / no key → honest MINOR_DRIFT +
  `needs_review: true` stamped on the SERVED object (a
  `reconciliation_auto` marker keyed by content_hash+versions persists
  the attempt); calm, never an error, never a fake zero.
- ratio > 0.001 → no auto-fix (needs a human).

**PLACEMENT RULE** — one visible line "Diferențe de reconciliere". The
receipt carries `placement: "balance_sheet" | "pnl"` (the value the FE
strip consumes) **and** `placement_detail: "bs" | "pl_other_income" |
"pl_other_expense"` (the operator vocabulary). A class-6/7 diagnosed
cause routes the line to the P&L by the delta's sign (diff > 0 → other
income, diff < 0 → other expense), reaching the BS via the RESULT row —
the serve path adjusts `current_year_profit`/`current_year_loss` by the
delta (leaf note: `reconciliation_delta` + `reconciliation_note` on the
row; a statement with no result row gets the synthetic row in equity
instead) AND `/api/period` serves the line on `statements.assembled_pl`
as `reconciliation_adjustment` `{label, placement (3-way detail), amount
(signed effect on the result), synthetic: true}`. Any other cause is a
balance-sheet line (prior behavior). Never smear, never alter extracted
cents.

**SNAPSHOT / carry-forward** — the reconciliation state is keyed by
content_hash + parser_version + mapping_version. `stage_persist` replaces
the whole envelope on every run, so `carry_forward_reconciliation` copies
`reconciliation` + `reconciliation_history` + `reconciliation_suppressed`
from the old envelope when ALL three key parts match (same file, same
engine build) and drops them otherwise (logged). Hard refresh serves the
identical snapshot; recompute happens only on new file, version bump, or
explicit re-scan.

**UNDO** — restores the raw state (the TRUE source imbalance) and writes
a suppression entry `{content_hash, parser_version, mapping_version,
suppressed_at, suppressed_by}` under
`assembled_canonical_v1.reconciliation_suppressed`; the auto stage and
POST /reconcile honor it, so a re-scan cannot silently re-apply against
the user's explicit choice. The suppression clears on file/version change
(the key stops matching) and on an explicit POST /reconcile (the call IS
the override; matching entries are removed, logged).

**`reconcile_offer` (REVISED semantics)** — the field survives for API
compatibility but is now `true` ONLY in the needs-review situations where
the auto stage could not fix (rejected proposal / AI unavailable), i.e.
exactly when `needs_review: true` is served. The FE no longer renders a
button from it. POST /api/period/{id}/reconcile stays mounted as an
ops/manual trigger with unchanged refusal semantics (409 + diagnosis).

**UI** — calm green "Balanced"-family chip with a subtle "· auto-adjusted
{X}" micro-caption; tap reveals a one-line receipt + Undo. Machine truth
(API, exports) says RECONCILED. Audit record = the receipt: original
delta, cause (`diagnosis_code` + `target_account`), method (`origin`),
`model` + `prompt_version` when AI was consulted, timestamps, actor.

## SERVED-ENVELOPE CONTRACT sv1 — facts gateway + status presenter (2026-08-19)

The serve side now has ONE typed authority and a versioned shape. Schema:
`docs/served_envelope.schema.json` (header `envelope_version: "sv1"` +
`migration_notes`; the flattened field->type listing is snapshotted in
`tests/engine/served_envelope_schema_snapshot.json` and locked by
`tests/engine/test_envelope_contract.py` — a field removal/retype fails CI
unless the version is bumped with a migration note and the snapshot is
regenerated via `python tests/engine/test_envelope_contract.py --regen`).

**Serve stamps** — `_reconcile.served_canonical_bs` stamps every served
canonical_bs with `envelope_version: "sv1"` and `status_presentation`
(from `engine.serving.present_status` — the ONE wording object the chip /
HTML footer / Excel / API derive status copy from), alongside the existing
`needs_review` / `reconcile_offer`. **Status wording revision:** machine
RECONCILED now presents as its own band ("Reconciled" / "Reconciliat",
micro-caption "auto-adjusted {X}") — it NEVER maps to a 'balanced'-family
display string (supersedes the earlier "calm green Balanced-family chip"
UI note above; locked by `tests/engine/test_facts_gateway.py`).

**Additive-only serve guard** — serve-stage mutations may only ADD keys
(incl. the documented needs_review boolean-when-not-array stamp); removing
or retyping a pipeline-produced field (incl. the AI-lane needs_review
array → boolean retype) trips `engine.serving.additive_serve_violations`,
which logs loudly and falls back to serving the unmutated persisted object
with stamps only.

**Facts gateway** (`src/engine/serving/facts.py`) — `FactsGateway`, built
from ONE persisted envelope, is the only sanctioned reader of served
totals (integer minor units inside; reconciliation adjustment included
per its placement — pnl placement reaches net_result/revenue-expense AND
equity through the result row; balance_sheet placement reaches its BS
line). `raw_*()` accessors expose pre-adjustment source cents for
audit/receipt/undo surfaces ONLY. Boundary enforced by
`scripts/check_import_boundary.py` + `tests/engine/test_import_boundary.py`
+ the raw-caller test in `tests/engine/test_facts_gateway.py`. Engine
consumers migrated: `_apply_envelope_truth_to_statements` (both tiers),
`stage_narrate` briefing grand totals (write time now equals regenerate),
and the `_rebuild_assembled` equity completion.

**THE one intentional number change (sv1):** valuation equity — the
`_rebuild_assembled` equity completion (feeding POST/DELETE
/valuation-assumptions + POST /valuation/recompute → the persisted
valuations row → Valuation tab + dashboard hero) previously read the
persisted `canonical_bs.totals.equity` RAW, bypassing the serve path, so
RECONCILED periods were valued on pre-reconciliation equity. It now reads
`FactsGateway.equity()` — the ADJUSTED (reconciliation-inclusive) figure.
BALANCED periods are numerically unchanged.

## VERIFICATION BATTERY (2026-08-19) — the gates, in one list

Every engine change must leave ALL of these green. The PR battery runs in
`.github/workflows/tier1-validation.yml`; the heavy tier runs nightly in
`.github/workflows/nightly-deep.yml`. None of the gates below makes a live
API call — the property suite and the corpus replay both carry the
anthropic-import sentinel, so the Anthropic credit state can never affect
a gate.

PR battery (every PR + push to main):
- `scripts/verify_determinism.py` — 5 runs per golden fixture, BYTE-IDENTICAL
  canonical JSON.
- `pytest tests/engine` (2 SHARADAR deselects) — includes the corpus replay
  wrapper (`tests/engine/test_corpus_replay.py`) and the property suite.
- **Corpus replay** (NEW) — `scripts/corpus_replay.py`: the 17-case golden
  corpus under `corpus/<case_id>/`, full offline pipeline (parse → assemble →
  auto-reconcile → `stage_persist` → serve → FactsGateway), all five
  artifacts (`extraction` / `classification` / `statuses` / `served_envelope`
  / `gateway_facts`) byte-compared against `expected/`. Named CI step for
  visibility. Refreeze deliberately with `UPDATE_GOLDEN=1`.
- **Property suite, fast profile** (NEW) —
  `pytest tests/engine/test_properties.py` at the derandomized Hypothesis
  "ci" profile (P1–P9 + P2b through the REAL production chain). Named CI
  step for visibility.
- **Golden-change guard** (PR-only) — `scripts/check_golden_change_guard.py`:
  any diff under `corpus/*/expected/` requires a PR-body line starting
  `golden-change:` explaining the contract change; otherwise the PR fails.
  Also the local pre-push habit (`--base origin/main` default).
- `scripts/check_import_boundary.py` — serving-gateway boundary.
- FE: `tsc --noEmit`, `vitest`, `npm run build`.

Nightly deep tier (`nightly-deep.yml`, cron + manual dispatch):
- Deep property run — `HYPOTHESIS_PROFILE=deep` (fresh entropy, 10–15×
  counts); shrunken failures land in `corpus/quarantine/<sha16>/` and are
  uploaded as a CI artifact.
- Full corpus replay — same gate as the PR battery, re-run nightly to catch
  environment/dependency drift on a quiet main.
- **Prod canary** — `scripts/prod_canary_replay.py`: the sentinel case
  (prod_scandia_frozen, corpus id `saga_10_col`) replayed offline, AND —
  only when the optional `PROD_SSH_KEY` / `PROD_HOST` secrets exist —
  ssh-executed inside the running `cfo-ai-backend` container with a
  byte-compare of the prod-produced served envelope vs the repo golden.
  Without the secrets it prints a documented SKIP (exit 0); the operator
  runs the prod half manually over ssh, same habit as `measure_bs_drift.py`
  (both fixtures must stay GREEN: EEI 0.0000%, Scandia 0.3698%).
