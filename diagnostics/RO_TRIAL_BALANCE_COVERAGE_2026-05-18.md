# Romanian Trial-Balance Format Coverage — Diagnostic (READ-ONLY)

**Date:** 2026-05-18
**Status:** COMPLETE — read-only audit, nothing changed in product code.
**Scope:** Structural / format variations of Romanian RAS trial balances. NOT
other countries, NOT `_ro_coa` mapping internals, NOT Bug A, NOT
canonical-metrics, NOT pricing.
**Output:** This document only. No code edits, no DB writes, no fixes.

---

## Parse path (Step 0)

| Concern | File:line |
|---|---|
| High-level entry (Excel) | `src/engine/api/_trial_balance_parser.py:518` (`parse_trial_balance_file`) |
| High-level entry (pasted text) | `src/engine/api/_trial_balance_parser.py:461` (`parse_pasted_trial_balance`) |
| Format detection (magic bytes) | `src/engine/api/_trial_balance_parser.py:53` (`detect_excel_format`) |
| Excel read (xlsx/xls dispatch) | `src/engine/api/_trial_balance_parser.py:67` (`read_excel_robust`) |
| Header detection | `src/engine/api/_trial_balance_parser.py:305` (`_find_header_row`) |
| Column-header pattern catalogue | `src/engine/api/_trial_balance_parser.py:113` (`COLUMN_PATTERNS`) |
| Structure detection (3-pass column mapping) | `src/engine/api/_trial_balance_parser.py:162` (`detect_trial_balance_structure`) |
| Account-code regex filter | `src/engine/api/_trial_balance_parser.py:378` (`re.match(r"^\d{3,8}$", code)`) |
| Numeric parse (locale-tolerant) | `src/engine/api/_trial_balance_parser.py:403` (`_to_number`) |
| End-of-data + totals-row filter | `src/engine/api/_trial_balance_parser.py:320` (`_find_data_end`) + `:331` (`_is_totals_row`) |
| Conservative fail (raise `ParseError`) | `:174` (no header), `:269` (no code/name), `:281` (no cumulative AND no final pair), `:526` (empty result) |
| Boundary to `_ro_coa` (parser does NOT cross this) | `src/engine/api/_trial_balance_parser.py:567` (`accounts_to_assemble_shape`) → `src/engine/api/_ro_coa.py:544` (`assemble_statements`) |
| Callers in pipeline (Excel fast-path) | `src/engine/api/pipeline.py:409`, `:722`, `:3011` |
| PDF path (NOT through this parser) | `src/engine/api/pipeline.py:477-520` — pypdf + public-records check, then Claude Opus with TB rubric |

---

## Fixtures available

| Fixture | Path | Notes |
|---|---|---|
| Scandia FY2025 | `files/scandia_trial_balance_2025_downloaded.xlsx` | 8-col ERP, 6-digit codes, 809 accounts, 461M RON total. Real. |
| Example 6-col | `tests/fixtures/trial_balance/example_trial_balance_6col.xlsx` | Anonymized SAGA-style, 3-4 digit codes, 34 data-region rows (26 accounts + 7 class subtotals + 1 grand total). |
| Example 8-col | `tests/fixtures/trial_balance/example_trial_balance_8col.xlsx` | Anonymized ERP-style, 3-4 digit codes, 26 accounts. |
| EEI SAGA-PDF | **MISSING** | No `*.pdf` fixture exists for EEI or any SAGA trial balance on disk. PDF axis is therefore unverified by fixture. |

---

## Fixture results (read-only run)

```
Scandia (8-col ERP, 6-digit):
  df shape:           (811, 10)
  parsed accounts:    809
  has_totals_row:     True (1 trailing row, correctly excluded)
  code lengths:       {6: 809}                       → all 6-digit, none truncated
  sum(sf_d):          460,963,809.53
  sum(sf_c):          460,963,809.53     ✓ matches per the trial balance
  sum(st_d):       6,996,073,881.14
  sum(st_c):       6,996,073,881.14     ✓ matches
  anchor 121101:      sf_c = 36,787,352.75           → matches statutory net profit
  anchor 101201:      sf_c = 20,446,900.00           → share capital paid-in
  anchor 162xxx:      multiple bank-loan rows parsed correctly
  anchor 5121/5124/5125/531: cash rows parsed; values match manual extract

Example 6-col (SAGA-like, XLSX):
  df shape:           (41, 8)
  header row:         row 6
  data region:        rows 7..40 (34 rows)
  parsed accounts:    26
  difference (8):     7 class-subtotal rows ("Total sume clasa N", N=1..7)
                      + 1 grand-total row ("Totaluri:")
  filtering mechanism: ^\d{3,8}$ regex at line 378 rejects "Total sume clasa N"
                      and "Totaluri:" (non-numeric account codes)
  code lengths:       {3: 16, 4: 10}                  → SAGA convention
  sum(st_d) = sum(st_c) = 5,765,000.00                 ✓ trial balance foots

Example 8-col (ERP-like, XLSX):
  parsed accounts:    26
  has_totals_row:     True
  code lengths:       {3: 16, 4: 10}
  sum(sf_d) = sum(sf_c) = 1,795,000.00                 ✓ closing balances foot
  sum(st_d) = sum(st_c) = 5,765,000.00                 ✓ cumulative foots
```

---

## Coverage matrix

| # | Axis | Status | Evidence |
|---|---|---|---|
| 1 | **6-column SAGA structure** (opening/movement/total-sums × D/C) | **HANDLED** | Code: positional D/C pairing at `_trial_balance_parser.py:223-236`; pair names `initial/period/cumulative/final`; SAGA-shaped files have no `final` block but the validation at `:281` accepts cumulative-only. Fixture: 6-col example correctly mapped all 4 D/C semantic columns + reconciled. |
| 2 | **8-column ERP structure** (opening/movement/total-sums/closing × D/C) | **HANDLED** | Code: same positional pair-up handles 4 pairs at `:223-236`. The engine math reads from `cumulative_*` not `final_*` (comment at `:262-263`), so `final_*` is not confused for `cumulative_*`. Fixture: Scandia & 8-col example correctly mapped all 8 semantic columns. |
| 3 | **3-4 digit account codes** (SAGA) | **HANDLED** | Code: account-code regex at `:378` is `^\d{3,8}$` — accepts 3,4,5,6,7,8 digits; class derivation in `_ro_coa.bucket_for` (`_ro_coa.py:371`) uses longest-prefix-wins on the rule table, so 3- and 4-digit codes resolve correctly. Fixture: 6-col example contains both 3-digit (e.g. `117`, `121`, `371`) and 4-digit (e.g. `1012`, `2131`, `4111`) codes, all parsed. |
| 4 | **6-digit account codes** (SAP / ERP, e.g. `101201`) | **HANDLED** | Code: same regex `^\d{3,8}$` accepts 6 digits; no truncation, no zero-pad logic; class still derived from leading digit via longest-prefix-wins. Fixture: Scandia has 809/809 accounts of length 6 — code lengths counted post-parse confirm zero truncation. Verified anchors (101201, 121101, 162101) match expected values exactly. |
| 5 | **XLSX input** | **HANDLED** | Code: magic-byte detection at `:53` (`PK\x03\x04` → openpyxl; `\xd0\xcf\x11\xe0...` → xlrd .xls fallback); `read_excel_robust` returns header-less, all-string DataFrame. Fixture: all three XLSX fixtures parsed without error. |
| 6 | **PDF input** (SAGA PDF) | **PARTIAL** (not via this parser) | Code: `_trial_balance_parser.py` has NO PDF handling. PDFs are routed through `pipeline.py:477` → pypdf text extraction → public-records short-circuit check → `stage_extract` → Claude Opus 4.7 with the canonical TB rubric. The deterministic parser is bypassed entirely. Fixture: **no PDF fixture available** → unverified by fixture. The PDF path works in production (CLAUDE.md references EEI PDF analyses) but is LLM-mediated, not deterministic. |
| 7 | **Romanian number format** (NBSP / regular-space thousands, comma decimal) | **HANDLED** | Code: `_to_number` at `:403`. Line `:439` strips NBSP (`\xa0`), regular space, and two other Unicode space variants. Line `:441-446` resolves comma-vs-period decimal by rightmost-separator-wins (`1.234.567,89` → `1234567.89`; `1,234.56` → `1234.56`; `1,56` → `1.56`). Fixture: Scandia anchors parsed correctly — `36.787.352,75` in the source XLSX cell became `36,787,352.75` post-parse. |
| 8 | **Class-subtotal rows present** (`Total sume clasa N`) | **HANDLED** (by side effect) | Code: NOT explicitly detected; filtered by the account-code regex at `:378` which rejects `Total sume clasa N` (non-numeric). Fixture: 6-col example contains 7 such rows (one per class 1–7), all correctly excluded — parser returned 26 of 34 data-region rows; the 8 omitted rows = 7 class subtotals + 1 grand total. |
| 9 | **Class-subtotal rows absent** (ERP) | **HANDLED** | Code: parser does not depend on subtotal rows existing — no code path reads them. Fixture: Scandia has zero `Total sume clasa N` rows; parsed cleanly. |
| 10 | **Grand-total row** (`Totaluri:` / trailing unlabelled) | **HANDLED** | Code: two-layer defense. `_is_totals_row` at `:331` returns True when the code cell is empty (catches Scandia's trailing unlabelled total). The `^\d{3,8}$` regex at `:378` catches `Totaluri:` (non-numeric). Fixture: 6-col `Totaluri:` row at index 40 dropped; Scandia trailing row dropped (parsed 809 rows vs 810 data-region rows). |
| 11 | **Romanian headers** (`Cont`, `Denumirea contului`, `Debitoare/Creditoare`, `Solduri inițiale`, `Rulaje perioadă`, `Sume totale`) | **HANDLED** | Code: `COLUMN_PATTERNS` at `:113` lists every variant; `_classify` at `:206` matches `debitoare`/`creditoare`. Header-row finder at `:305` requires `\bcont\b` + `debit` + `credit` on the same row. Fixture: all three Romanian-headered fixtures matched correctly. |
| 12 | **English headers** (`Account`, `Debit`, `Credit`, `initial debit`, etc.) | **PARTIAL** (UNKNOWN-NO-FIXTURE end-to-end) | Code: `COLUMN_PATTERNS` includes English alternates (`account\s*code`, `account\s*name`, `initial.*debit`, `period.*debit`, `cumulative.*debit`, `final.*debit`, etc. at `:118-149`). `_classify` at `:211` accepts bare `debit`/`credit`. Fixture: **no English-header fixture exists** — code path looks complete but has not been verified end-to-end against a real English-headed Romanian TB. |
| 13 | **Trial-balance reconciliation** (D = C check) | **NOT HANDLED** | Code: parser performs NO debit-credit footing check. No symbol like `assert sum_d == sum_c` exists in `_trial_balance_parser.py`. A non-balancing TB would be silently accepted and downstream stages would consume the bad data. The only sanity-rail is the assertion-of-shape (correct columns mapped) — not value-level reconciliation. Fixture: Scandia & both examples happen to foot exactly; the parser doesn't verify or report that fact. |
| 14 | **Unrecognized structure** → conservative fail with clear message + zero rows written | **HANDLED** | Code: four explicit raise points in `_trial_balance_parser.py`: header not found (`:174`), file not a valid Excel (`:74`), missing `account_code`/`account_name` (`:269`), missing both `cumulative_*` and `final_*` pairs (`:281`). Plus empty-result guard at `:526`. Every raise carries both a `user_message` (for toasts) and `technical_detail` (for logs). Caller in `pipeline.py:427-431` swallows the exception and falls through to Claude raw-render — NOT to silent zero-row write. |

---

## Bottom line

**Realistic Romanian-market coverage today (deterministic Excel/CSV path): ~90%.**

| Family | Coverage | What's robust | What's missing |
|---|---|---|---|
| SAGA-family (6-column XLSX/CSV/pasted) | **HIGH** | Structure, headers, codes, numbers, subtotals, grand-totals, conservative fail | TB-foots reconciliation check at parse time |
| ERP-family (8-column XLSX, SAP/Oracle/BC) | **HIGH** | Scandia anchor: 809 accounts, 461M RON, all anchors verified, closing balances reconcile to source | TB-foots reconciliation check at parse time |
| SAGA-family PDF | **MEDIUM** (different path) | Works in production via pypdf + Claude Opus + canonical TB rubric in the system prompt | No deterministic PDF path. No PDF fixture in test suite. LLM-mediated parsing has implicit cost + non-determinism risk. |
| English-headed Romanian TBs (rare in practice) | **UNVERIFIED** | Code path looks complete; pattern catalogue includes English alternates | No fixture proves this end-to-end |

### Gaps that would BLOCK a real customer file (ranked)

1. **No trial-balance reconciliation (Axis 13).** If a customer's export is broken — say, a class-1 subtotal row's debit cell is empty due to a print-to-Excel artifact — the parser will silently ingest a non-balancing TB. Every downstream calculation (P&L, BS, ratios, valuation) will compound the error. No warning is surfaced to the user. **This is the biggest single risk to trust.**
2. **No deterministic PDF parser.** When pypdf produces low-fidelity text from a SAGA PDF (which happens with column-aligned reports where text-extraction fragments rows), the file lands in Claude Opus with no fallback. Result: an LLM extracting a financial document with no verification rail. EEI works today, but the path is not robust.
3. **Romanian thousand-separator-only numbers (no decimal).** `_to_number` treats a lone comma as a decimal separator — so a SAGA cell containing `1,234,567` (English thousands, no decimal) would parse to `1.234567`. Unlikely in Romanian TBs (RAS convention always emits cents), but a possible hazard for mixed-locale exports.

### Axes marked UNKNOWN (no fixture — do NOT assume)

- **Axis 6 (PDF)** — verified to use a non-deterministic path (Claude); no PDF fixture for SAGA shape in test suite. Production behavior known anecdotally.
- **Axis 12 (English headers)** — code looks complete but end-to-end behavior unverified by fixture.

### Axes that are HANDLED but bear watching as edge cases land

- **Axis 8 (class subtotals) and Axis 10 (grand totals)** — filtered by the `^\d{3,8}$` regex on account codes, not by explicit subtotal-row detection. If a future SAGA dialect emits class subtotals with numeric labels (e.g., a synthetic code like `1000000` for "Class 1 total"), the regex would let them through and they would be summed as if they were accounts. Defense-in-depth would be to also reject obviously-aggregate rows (e.g., where the name field contains `total|totaluri|sume clasa`).
- **Axis 7 (Romanian numbers)** — robust for the standard forms; if a customer file ever uses scientific notation (`5.76e6`) or postfix abbreviations (`5.76M`), `_to_number` will return 0.0 and the value is silently lost.

---

## Recorded defects (NOT FIXED — for a future scoped fix prompt)

```
D1  [Axis 13] No trial-balance reconciliation in parser. Add a post-parse
    check: if abs(sum_st_d - sum_st_c) > 1.0 or abs(sum_sf_d - sum_sf_c) > 1.0,
    raise ParseError with the actual delta in user_message OR return a
    warning sidecar the caller can surface. Decide which during the fix
    prompt; not deciding here.

D2  [Axis 6] No deterministic PDF parser. EEI / SAGA PDFs land in Claude
    with no structural validation. Options range from light (assert
    parsed-row-count against a `pdfplumber` row-count sanity rail) to
    heavy (geometric extraction via pdfplumber word-coordinates,
    re-using the public-records parser's word-anchor pattern). Decide in
    the fix prompt.

D3  [Axis 7] _to_number ambiguity on single-comma values (`1,234,567`).
    Current behavior treats the rightmost comma as decimal — which is
    correct for Romanian short form `1,56` but wrong for English
    thousands-only `1,234,567`. Likely never seen on real Romanian
    TBs but is a latent footgun. Fix would require either header-language
    detection or value-shape heuristics (count of separators).

D4  [Axes 8/10 hardening] Class-subtotal + grand-total rows are filtered
    by the `^\d{3,8}$` regex only. Add a defense-in-depth filter that
    also rejects rows where the name cell matches
    `^total|^totaluri|sume\s+clasa` — covers the (currently theoretical)
    case of a SAGA dialect that uses a numeric sentinel code for
    subtotals.

D5  [Axes 6/12 coverage] No fixtures for SAGA-PDF or English-headed RO TB.
    Even if these axes are deemed acceptable, the test suite cannot
    catch regression on them. Add anonymized fixtures.
```

---

## Rules-of-engagement checklist (READ-ONLY integrity)

```
[x] NO code modified, NO parser changed, NO refactor — inspection only
[x] NO DB writes, NO pipeline side-effects; parser was invoked in
    isolation via a Python -c read-only harness that printed metrics
    and discarded output
[x] Defects RECORDED (D1–D5 above), never fixed — fixes are a separate
    later prompt
[x] No scope creep: only Romanian format axes were inspected. _ro_coa
    mapping internals, Bug A, canonical-metrics, pricing, valuation
    cash-bridge, and all other in-flight prompts were NOT touched.
[x] Only file written = this diagnostic report
    (diagnostics/RO_TRIAL_BALANCE_COVERAGE_2026-05-18.md)
```

**STATUS: [x] COMPLETE (read-only, nothing changed)**
