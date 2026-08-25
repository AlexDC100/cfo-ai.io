# Hand-verified StructuralMap fixtures (smap1)

These maps were HAND-VERIFIED against the real workbooks in `files/` —
they are the ground truth other lanes may reuse (mechanical map-guided
reads, consensus checks, prompt evaluation). Do not regenerate them from
a model run; edit them only after re-verifying against the source file.

Schema: `engine.interp.structmap.StructuralMap` (map_version "smap1").
Each file is the pretty-printed `to_json_dict(include_hash=True)` —
`map_hash` is the sha256 of the canonical JSON minus the hash itself and
stays stable across (de)serialization.

## scandia_sibiu_tb_2019.json — files/scandia_sibiu_tb_2019.xlsx

Classic 10-column layout the deterministic RO parser REJECTS (its D/C
headers are abbreviated to single letters, so header detection finds no
"debit"/"credit" tokens). Verified facts encoded here:

- sheet "Sheet1", header row 0, 250 rows, 10 columns
- col 1 ("Denumire") = account_name
- cols 6/7 ("Total sume D/C") = **total_with_opening_debit/credit** —
  verified opening-INCLUSIVE: e.g. row 3 has opening 1,549,139.17, zero
  period movement, and the same value in the total pair
- cols 4/5 ("Rulaj D/C") = movement_period (single month; the total pair
  exceeds it on rows with year-to-date activity, e.g. row 246)
- POSITIONAL analytics: separator null, synthetic_digits 4
  ('101201' = synthetic '1012' + suffix '01'; 246 six-digit codes,
  3 bare four-digit synthetics)
- NO totals row anywhere (verified by scanning all 250 rows)

## agras_tb_2025.json — files/agras_tb_2025.xlsx

Extended 21-column export. Verified facts encoded here:

- sheet "Agras Food Factory", header row 0, 644 rows
- cols 6/7 ("Rulaj cumulat D/C") = **movement_cumulative_debit/credit**
  — verified movements-ONLY (opening EXCLUDED): row 6 (account 121)
  satisfies closing_credit = opening_credit − cum_debit + cum_credit
  (851,012.45 − 109,990,261.3 + 116,672,924.87 = 7,533,676.02); an
  opening-inclusive reading does NOT reproduce the closing pair
- col 10 ("BS/PL") = marker; cols 11 ("Tip cont din OMFP") and 15/16/17
  (IFRS item labels) = hint_classification; cols 12/13/14/18/19/20
  (derived/rank/blank columns) = ignore
- DOTTED analytics: separator "." ('1012.01'), synthetic_digits null
- NO totals row; trailing rows with blank account codes are formula
  remnants (noted in anomaly_notes)

The two files together pin the mission's two-cumulative-enums
distinction: the same physical column position (6/7) means
total_with_opening_* in one file and movement_cumulative_* in the other.
