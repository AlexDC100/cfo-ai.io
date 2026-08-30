# BEFORE — the generic-findings baseline, measured (2026-08-30)

Measured against PRODUCTION, not sampled by eye. 59 rule-authored
findings live (the 8 `ai_council::summary` rows are excluded — they are
a different surface).

## Against the Part A contract

| Contract element | Result |
|---|---|
| ≥ 2 figures per surfaced finding (F2) | **34 of 59 FAIL** (58%) |
| ≥ 1 imperative verb per finding (F2)  | **47 of 59 FAIL** (80%) |
| banned/boilerplate phrasing present   | 5 of 59 (all `concentration_intercompany_loan`) |
| distinct rules firing                 | 11 |

So four out of five live findings tell the reader nothing to DO, and
more than half state a single number with no comparison basis. The
owner's verdict is confirmed quantitatively.

## Rules currently firing (count)

    risk_inventory_fx_exposure              12
    risk_inventory_cash_tight               10
    equity_quality_revaluation_reserves      9
    leverage_debt_to_ebitda_high             7
    risk_inventory_leverage                  7
    concentration_intercompany_loan          5
    risk_inventory_affiliate_dep             3
    fcf_negative_development_phase           2
    earnings_quality_capitalized_own_work    2
    valuation_ebitda_negative                1

## The worked example (the 461 case, native-unit)

Current body, period 11b8e759:
> Account 461 (Debitori diverși) holds RON 7,692,203 due from related
> parties — 19.6% of total assets RON 39,194,178. Recoverability and
> intent on settlement should be confirmed. Lenders typically haircut
> related-party receivables during covenant measurement.

Contract audit: SUBJECT ok (461 named). EVIDENCE partial (figures, no
provenance to source cells, no comparison basis). THRESHOLD **absent**
(the 10% rule that fired is never stated). IMPACT **absent** (no
recomputed ratio). WHY-HERE **absent** (identical for any company).
ACTION **absent** ("should be confirmed" is the banned form — no
artefact named, no provider named). CONFIDENCE **absent**.
→ 1.5 of 7 elements. Under F1 this is DEMOTED, not surfaced.

The figures themselves are correct and native-unit: 7,692,202.74 /
39,194,178.46 = 19.63% (RON/RON). The mixed-currency RENDER of this
note was a separate defect, fixed in c05eab2.
