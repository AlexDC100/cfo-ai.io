# Tier-1 Fixture Completion Status

| Fixture | source | expected_extraction | expected_mapping | expected_statements | expected_ratios | expected_validation | expected_briefing_signals |
|---|---|---|---|---|---|---|---|
| ro_eei_dec_2025 | ✅ real PDF (Dec 2025) + source_text.txt | ✅ extracted from PDF | ✅ canonical RO mapping | ✅ derived | ✅ derived | ✅ traps codified | ✅ keywords |
| fr_synthetic_pcg | ✅ source.md (4 traps) | ⏳ TODO | ⏳ TODO | ⏳ TODO | ⏳ TODO | ⏳ TODO | ⏳ TODO |
| de_skr03_synthetic | ✅ source.md (5 traps) | ⏳ TODO | ⏳ TODO | ⏳ TODO | ⏳ TODO | ⏳ TODO | ⏳ TODO |
| de_skr04_synthetic | ✅ source.md (4 traps) | ⏳ TODO | ⏳ TODO | ⏳ TODO | ⏳ TODO | ⏳ TODO | ⏳ TODO |
| es_pgc_synthetic | ✅ source.md (6 traps, unbalanced) | ⏳ TODO | ⏳ TODO | ⏳ TODO | ⏳ TODO | ⏳ TODO | ⏳ TODO |

## How to complete a non-RO fixture (one country at a time)

1. **Balance the markdown.** Each `source.md` must have `TOTAL debit == TOTAL credit`. The ES sample is intentionally unbalanced — adjust before rendering to PDF. The FR sample already balances (€6,539,300.00 = €6,539,300.00).

2. **Render to PDF** so the pipeline sees a "real" document:
   ```bash
   pandoc source.md -o source.pdf --pdf-engine=xelatex -V geometry:margin=2cm
   ```
   (or use any tool that produces a clean table PDF — Pages, Word + Save As PDF, browser print-to-PDF all work).

3. **Build expected_extraction.json** by transcribing every row of the source markdown into the schema used by `ro_eei_dec_2025/expected_extraction.json` (account_code / name / ytd_debit / ytd_credit). Total debit/credit at top must equal the markdown total.

4. **Build expected_mapping.json** by walking through each account_code in `expected_extraction.json` and looking up the bucket per the canonical mapping tables in the prompt's "Account-by-account mapping" section. Use the same schema as `ro_eei_dec_2025/expected_mapping.json`.

5. **Derive expected_statements.json**: assemble BS + PL totals by summing per-bucket. EBITDA = revenue − cogs − opex − payroll + other_inc (NOT including capitalized own-work).

6. **Compute expected_ratios.json** from the assembled statements: Debt/EBITDA, current_ratio, interest_coverage, debt_to_equity, gross_margin, ebitda_margin.

7. **Codify expected_validation.json**: list `must_flag` and `must_NOT_flag` rules for the country's traps (see `ro_eei_dec_2025/expected_validation.json` for the canonical shape).

8. **List expected_briefing_signals.json** keywords: every country-specific trap and number the briefing must reference.

## The EEI fixture is the contract — it must pass first

If `compare_to_fixture.py ro_eei_dec_2025` passes (all 6 expected files match within tolerance), then we know the pipeline handles a real-world Romanian trial balance correctly. Then the same discipline ports to the synthetic fixtures.

Per Gate 1 of the prompt: each country needs `total_debit == total_credit` in extraction + ≥60 accounts in mapping. RO has 67 accounts, FR source.md has 51 accounts, DE skr_03 has 58, DE skr_04 has 50, ES has 56 — the synthetic markdowns are slightly under the 60 target; add 4-10 minor accounts each (e.g. additional opex sub-accounts, small balance-sheet line items) before they're shippable.
