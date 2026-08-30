// REAL ENGINE OUTPUT — the whole period, not a hand-built row.
//
// Produced by running the committed `agras_fy2025` envelope
// (`src/engine/country_packs/ro_romania/fixtures/regression_baselines/`)
// through `s_engine.run_single_period` — the same book, the same 461
// balance and the same 19.6% as `design_review/findings/BASELINE.md`'s
// worked example — and dumping the result. Two findings surface, one
// falls below the materiality floor into the info tier, one is demoted,
// and eighteen checks ran. Hand-writing this would let the UI drift from
// the payload it claims to render, which is the mirror-double failure
// this repo has already paid for twice.
//
// VERBATIM FROM THE ENGINE: every `contract_elements` block, every
// figure, every threshold, every check row (including the long
// "not run: ..." notes the detectors write when a field is ABSENT), and
// the silence statement — `FindingSet.silence_statement()` over the 13
// checks the detectors recorded.
//
// TWO THINGS THE GENERATOR ADDS, both declared:
//
//   1. THE PLANT. The real `input_cost_exposure` finding has its ACTION
//      removed — the baseline's own 80%-of-rows failure, reproduced so
//      the UI can be shown refusing to recommend it. It is REPLACED, not
//      duplicated, so no rule appears twice.
//
//   2. THE RANKED WRAPPER. `s_engine.run_single_period` returns findings
//      and checks; it does NOT rank them (only the multi-period lane
//      builds `RankInput`s today — see the lane report's cross-lane
//      note). So the generator called the real
//      `_finding_rank.rank_findings` with materiality measured as "the
//      finding's first money figure against the profile's total_assets",
//      and persistence planted at 3 for the 461 finding and 2 for the
//      cash finding so the history strip has something to show. The
//      ranking MATHS is the engine's; the two inputs it has no
//      single-period source for are stated here.
export const ENGINE_REPORT: unknown = {
  "surfaced": [
    {
      "rule_key": "concentration_related_party",
      "severity": "medium",
      "category": "data_quality",
      "source_currency": "RON",
      "facts_cited": {
        "intercompany_loans": 7692202.74,
        "total_assets": 39194178.46,
        "cur_liab": 12934654.2,
        "pct_of_assets": 0.19625880786990732
      },
      "profile_id": "inventory_operator",
      "profile_fingerprint": "0d66ebe8ffd880b3",
      "narrative_source": "deterministic",
      "surfaced": true,
      "demoted": false,
      "missing_elements": [],
      "demotion_reasons": [],
      "contract_elements": {
        "subject": {
          "accounts": [
            {
              "code": "461",
              "name": "Debitori diverși",
              "statement": "BS",
              "bucket": "ar_intercompany"
            },
            {
              "code": "451",
              "name": "Decontări între entitățile afiliate",
              "statement": "BS",
              "bucket": "ar_intercompany"
            },
            {
              "code": "452",
              "name": "Decontări privind interesele de participare",
              "statement": "BS",
              "bucket": "ar_intercompany"
            },
            {
              "code": "455",
              "name": "Sume datorate acționarilor / asociaților",
              "statement": "BS",
              "bucket": "ar_intercompany"
            }
          ],
          "scope": "Related-party receivable on 461"
        },
        "evidence": {
          "figures": [
            {
              "fact": "intercompany_loans",
              "value": 7692202.74,
              "unit": "money",
              "label": "related-party balance on 461"
            },
            {
              "fact": "total_assets",
              "value": 39194178.46,
              "unit": "money",
              "label": "total assets"
            },
            {
              "fact": "cur_liab",
              "value": 12934654.2,
              "unit": "money",
              "label": "current liabilities"
            },
            {
              "fact": "pct_of_assets",
              "value": 0.19625880786990732,
              "unit": "percent",
              "label": "share of total assets"
            }
          ],
          "provenance": {
            "period_id": "p-agras_fy2025",
            "snapshot_id": "snap-agras_fy2025",
            "line_refs": [
              "461",
              "451",
              "452",
              "455"
            ],
            "source": "assembled_canonical_v1"
          },
          "comparison_basis": {
            "kind": "self_total",
            "description": "measured against the company's own total assets for the same period",
            "basis_value": 39194178.46,
            "basis_unit": "money"
          }
        },
        "threshold": {
          "rule_id": "concentration_related_party",
          "parameter": "share_of_assets_medium",
          "parameter_label": "related-party share of total assets (elevated)",
          "comparator": ">",
          "limit": 0.1,
          "observed": 0.19625880786990732,
          "unit": "percent",
          "source": "profiles.yaml#detectors.concentration_related_party.thresholds.default.share_of_assets_medium"
        },
        "impact": {
          "kind": "recomputed_ratio",
          "metric": "current_ratio_ex_related_party",
          "metric_label": "Current ratio after a full related-party haircut",
          "baseline": 2.118165197644016,
          "adjusted": 1.5234679895810437,
          "delta": -0.5946972080629724,
          "unit": "ratio",
          "currency": null,
          "baseline_fact": null,
          "adjusted_fact": null
        },
        "why_here": {
          "profile_id": "inventory_operator",
          "profile_label": "mid-size inventory-heavy operator",
          "rationale": "For a mid-size inventory-heavy operator this balance is not a customer receivable — it is capital lent inside the group with no contractual maturity on the face of the books, and the group treasury and the statutory auditor haircuts it in full when measuring the covenants.",
          "signals": [
            "bank_debt",
            "fx_exposure",
            "related_party",
            "revaluation_reserve"
          ],
          "anchors": [
            "mid-size inventory-heavy operator",
            "inventory-heavy operator",
            "mid-size company",
            "inventory-heavy operator",
            "related-party funded",
            "bank debt outstanding",
            "foreign-currency exposure",
            "related-party balances on the books",
            "revaluation reserve in equity"
          ]
        },
        "action": {
          "steps": [
            {
              "imperative": "Pull the 461 sub-ledger by counterparty with settlement dates",
              "artefact": "461 aging schedule per related entity",
              "provider": "the group financial controller",
              "horizon": "before the next covenant certificate"
            },
            {
              "imperative": "Recompute the gearing covenant with the 461 balance excluded",
              "artefact": "restated covenant calculation",
              "provider": "the treasury team",
              "horizon": null
            }
          ]
        },
        "confidence": {
          "level": "medium",
          "basis": "profile inventory_operator/band_mid/fin_related_party_funded resolved from structure",
          "caveat": "Cash-flow lines are indirect-method approximations because no prior period was supplied; working-capital movements carry a wide band."
        }
      },
      "title": "Related-party receivable on 461 at 19.6% — above the 10.0% related-party share of total assets (elevated) for mid-size inventory-heavy operator",
      "body": "461 (Debitori diverși), 451 (Decontări între entitățile afiliate), 452 (Decontări privind interesele de participare), 455 (Sume datorate acționarilor / asociaților): related-party balance on 461 — RON 7,692,203; total assets — RON 39,194,178; current liabilities — RON 12,934,654; share of total assets — 19.6%. Basis: measured against the company's own total assets for the same period. Source: period p-agras_fy2025; snapshot snap-agras_fy2025; accounts 461, 451, 452, 455; assembled_canonical_v1. Rule concentration_related_party fires when related-party share of total assets (elevated) is above 10.0%; observed 19.6%. Impact: Current ratio after a full related-party haircut moves from 2.12× to 1.52× (-0.59×). For a mid-size inventory-heavy operator this balance is not a customer receivable — it is capital lent inside the group with no contractual maturity on the face of the books, and the group treasury and the statutory auditor haircuts it in full when measuring the covenants. Do this: 1) Pull the 461 sub-ledger by counterparty with settlement dates — 461 aging schedule per related entity, from the group financial controller (before the next covenant certificate). 2) Recompute the gearing covenant with the 461 balance excluded — restated covenant calculation, from the treasury team. Confidence medium — Cash-flow lines are indirect-method approximations because no prior period was supplied; working-capital movements carry a wide band. (profile inventory_operator/band_mid/fin_related_party_funded resolved from structure).",
      "title_template": "Related-party receivable on 461 at 19.6% — above the 10.0% related-party share of total assets (elevated) for mid-size inventory-heavy operator",
      "body_template": "461 (Debitori diverși), 451 (Decontări între entitățile afiliate), 452 (Decontări privind interesele de participare), 455 (Sume datorate acționarilor / asociaților): related-party balance on 461 — {{money:intercompany_loans}}; total assets — {{money:total_assets}}; current liabilities — {{money:cur_liab}}; share of total assets — 19.6%. Basis: measured against the company's own total assets for the same period. Source: period p-agras_fy2025; snapshot snap-agras_fy2025; accounts 461, 451, 452, 455; assembled_canonical_v1. Rule concentration_related_party fires when related-party share of total assets (elevated) is above 10.0%; observed 19.6%. Impact: Current ratio after a full related-party haircut moves from 2.12× to 1.52× (-0.59×). For a mid-size inventory-heavy operator this balance is not a customer receivable — it is capital lent inside the group with no contractual maturity on the face of the books, and the group treasury and the statutory auditor haircuts it in full when measuring the covenants. Do this: 1) Pull the 461 sub-ledger by counterparty with settlement dates — 461 aging schedule per related entity, from the group financial controller (before the next covenant certificate). 2) Recompute the gearing covenant with the 461 balance excluded — restated covenant calculation, from the treasury team. Confidence medium — Cash-flow lines are indirect-method approximations because no prior period was supplied; working-capital movements carry a wide band. (profile inventory_operator/band_mid/fin_related_party_funded resolved from structure).",
      "fact_units": {
        "intercompany_loans": "money",
        "total_assets": "money",
        "cur_liab": "money",
        "pct_of_assets": "percent"
      },
      "rank": 1,
      "score": {
        "impact": 0.5,
        "confidence": 0.8,
        "persistence": 1.3,
        "actionability": 0.8999999999999999,
        "total": 0.46799999999999997
      },
      "disposition": "surfaced",
      "effective_severity": "medium",
      "materiality": {
        "basis_id": "total_assets",
        "basis_label": "total assets",
        "basis_value": 39194178.46,
        "amount": 7692202.74,
        "share": 0.19625880786990732,
        "floor": 0.005,
        "tier": "material",
        "source": "engine.api._finding_rank#DEFAULT_FLOORS",
        "statement": "19.63% of total assets (floor 0.50%, material)"
      },
      "persistence": 3,
      "persistence_label": "3rd consecutive period",
      "root_cause": "461+451+452+455",
      "recommendation": true,
      "merged_from": [],
      "contributor_rules": [],
      "contributor_summary": "",
      "dismissed": false,
      "dismissal": null,
      "dismissed_but_retained": false,
      "demotion_reason": ""
    },
    {
      "rule_key": "liquidity_cash_tight",
      "severity": "high",
      "category": "liquidity",
      "source_currency": "RON",
      "facts_cited": {
        "cash": 1168047.04,
        "cur_liab": 12934654.2,
        "cash_ratio": 0.09030369285017299
      },
      "profile_id": "inventory_operator",
      "profile_fingerprint": "0d66ebe8ffd880b3",
      "narrative_source": "deterministic",
      "surfaced": true,
      "demoted": false,
      "missing_elements": [],
      "demotion_reasons": [],
      "contract_elements": {
        "subject": {
          "accounts": [
            {
              "code": "5121",
              "name": "Conturi la bănci în lei",
              "statement": "BS",
              "bucket": null
            },
            {
              "code": "5124",
              "name": "Conturi la bănci în valută",
              "statement": "BS",
              "bucket": null
            },
            {
              "code": "531",
              "name": "Casa",
              "statement": "BS",
              "bucket": null
            }
          ],
          "scope": "Cash cover on 5121 / 5124 / 531 against current liabilities"
        },
        "evidence": {
          "figures": [
            {
              "fact": "cash",
              "value": 1168047.04,
              "unit": "money",
              "label": "cash and bank balances"
            },
            {
              "fact": "cur_liab",
              "value": 12934654.2,
              "unit": "money",
              "label": "current liabilities"
            },
            {
              "fact": "cash_ratio",
              "value": 0.09030369285017299,
              "unit": "ratio",
              "label": "cash cover of current liabilities"
            }
          ],
          "provenance": {
            "period_id": "p-agras_fy2025",
            "snapshot_id": "snap-agras_fy2025",
            "line_refs": [
              "5121",
              "5124",
              "531"
            ],
            "source": "assembled_canonical_v1"
          },
          "comparison_basis": {
            "kind": "profile_threshold",
            "description": "cash is measured against the company's own current liabilities for the same period, against the cash floor this structural profile is graded on",
            "basis_value": 12934654.2,
            "basis_unit": "money"
          }
        },
        "threshold": {
          "rule_id": "liquidity_cash_tight",
          "parameter": "cash_ratio_low",
          "parameter_label": "cash-ratio floor",
          "comparator": "<",
          "limit": 0.12,
          "observed": 0.09030369285017299,
          "unit": "ratio",
          "source": "profiles.yaml#detectors.liquidity_cash_tight.thresholds.by_profile.inventory_operator.cash_ratio_low"
        },
        "impact": {
          "kind": "recomputed_ratio",
          "metric": "days_of_operating_cost_covered_by_cash",
          "metric_label": "Days of operating cost the cash balance covers, as held versus at the floor this profile is graded on",
          "baseline": 4.0,
          "adjusted": 6.0,
          "delta": 2.0,
          "unit": "days",
          "currency": null,
          "baseline_fact": null,
          "adjusted_fact": null
        },
        "why_here": {
          "profile_id": "inventory_operator",
          "profile_label": "mid-size inventory-heavy operator",
          "rationale": "A mid-size inventory-heavy operator settles payroll and suppliers on a fixed calendar; at this cash ratio a single delayed collection cycle is funded by a revolver rather than by the balance sheet.",
          "signals": [
            "bank_debt",
            "fx_exposure",
            "related_party",
            "revaluation_reserve"
          ],
          "anchors": [
            "mid-size inventory-heavy operator",
            "inventory-heavy operator",
            "mid-size company",
            "inventory-heavy operator",
            "related-party funded",
            "bank debt outstanding",
            "foreign-currency exposure",
            "related-party balances on the books",
            "revaluation reserve in equity"
          ]
        },
        "action": {
          "steps": [
            {
              "imperative": "Obtain a committed overdraft sized to one month of operating cost",
              "artefact": "signed committed facility term sheet, with the drawdown conditions",
              "provider": "the relationship bank",
              "horizon": "within this quarter"
            },
            {
              "imperative": "Negotiate longer settlement terms on the largest 401 supplier balances",
              "artefact": "revised payment calendar for the ten largest supplier accounts",
              "provider": "the procurement lead",
              "horizon": null
            }
          ]
        },
        "confidence": {
          "level": "medium",
          "basis": "profile inventory_operator/band_mid/fin_related_party_funded resolved from structure",
          "caveat": "Cash-flow lines are indirect-method approximations because no prior period was supplied; working-capital movements carry a wide band."
        }
      },
      "title": "Cash cover on 5121 / 5124 / 531 against current liabilities at 0.09× — below the 0.12× cash-ratio floor for mid-size inventory-heavy operator",
      "body": "5121 (Conturi la bănci în lei), 5124 (Conturi la bănci în valută), 531 (Casa): cash and bank balances — RON 1,168,047; current liabilities — RON 12,934,654; cash cover of current liabilities — 0.09×. Basis: cash is measured against the company's own current liabilities for the same period, against the cash floor this structural profile is graded on. Source: period p-agras_fy2025; snapshot snap-agras_fy2025; accounts 5121, 5124, 531; assembled_canonical_v1. Rule liquidity_cash_tight fires when cash-ratio floor is below 0.12×; observed 0.09×. Impact: Days of operating cost the cash balance covers, as held versus at the floor this profile is graded on moves from 4 days to 6 days (+2 days). A mid-size inventory-heavy operator settles payroll and suppliers on a fixed calendar; at this cash ratio a single delayed collection cycle is funded by a revolver rather than by the balance sheet. Do this: 1) Obtain a committed overdraft sized to one month of operating cost — signed committed facility term sheet, with the drawdown conditions, from the relationship bank (within this quarter). 2) Negotiate longer settlement terms on the largest 401 supplier balances — revised payment calendar for the ten largest supplier accounts, from the procurement lead. Confidence medium — Cash-flow lines are indirect-method approximations because no prior period was supplied; working-capital movements carry a wide band. (profile inventory_operator/band_mid/fin_related_party_funded resolved from structure).",
      "title_template": "Cash cover on 5121 / 5124 / 531 against current liabilities at 0.09× — below the 0.12× cash-ratio floor for mid-size inventory-heavy operator",
      "body_template": "5121 (Conturi la bănci în lei), 5124 (Conturi la bănci în valută), 531 (Casa): cash and bank balances — {{money:cash}}; current liabilities — {{money:cur_liab}}; cash cover of current liabilities — 0.09×. Basis: cash is measured against the company's own current liabilities for the same period, against the cash floor this structural profile is graded on. Source: period p-agras_fy2025; snapshot snap-agras_fy2025; accounts 5121, 5124, 531; assembled_canonical_v1. Rule liquidity_cash_tight fires when cash-ratio floor is below 0.12×; observed 0.09×. Impact: Days of operating cost the cash balance covers, as held versus at the floor this profile is graded on moves from 4 days to 6 days (+2 days). A mid-size inventory-heavy operator settles payroll and suppliers on a fixed calendar; at this cash ratio a single delayed collection cycle is funded by a revolver rather than by the balance sheet. Do this: 1) Obtain a committed overdraft sized to one month of operating cost — signed committed facility term sheet, with the drawdown conditions, from the relationship bank (within this quarter). 2) Negotiate longer settlement terms on the largest 401 supplier balances — revised payment calendar for the ten largest supplier accounts, from the procurement lead. Confidence medium — Cash-flow lines are indirect-method approximations because no prior period was supplied; working-capital movements carry a wide band. (profile inventory_operator/band_mid/fin_related_party_funded resolved from structure).",
      "fact_units": {
        "cash": "money",
        "cur_liab": "money",
        "cash_ratio": "ratio"
      },
      "rank": 2,
      "score": {
        "impact": 0.4470231623270513,
        "confidence": 0.8,
        "persistence": 1.15,
        "actionability": 0.8999999999999999,
        "total": 0.37013517840679844
      },
      "disposition": "surfaced",
      "effective_severity": "high",
      "materiality": {
        "basis_id": "total_assets",
        "basis_label": "total assets",
        "basis_value": 39194178.46,
        "amount": 1168047.04,
        "share": 0.029801544155136757,
        "floor": 0.005,
        "tier": "material",
        "source": "engine.api._finding_rank#DEFAULT_FLOORS",
        "statement": "2.98% of total assets (floor 0.50%, material)"
      },
      "persistence": 2,
      "persistence_label": "2nd consecutive period",
      "root_cause": "5121+5124+531",
      "recommendation": true,
      "merged_from": [],
      "contributor_rules": [],
      "contributor_summary": "",
      "dismissed": false,
      "dismissal": null,
      "dismissed_but_retained": false,
      "demotion_reason": ""
    }
  ],
  "info": [
    {
      "rule_key": "fx_exposure",
      "severity": "medium",
      "category": "liquidity",
      "source_currency": "RON",
      "facts_cited": {
        "fx_cash": 133402.89,
        "total_cash": 1168047.04,
        "fx_cash_pct": 0.11421020338358977
      },
      "profile_id": "inventory_operator",
      "profile_fingerprint": "0d66ebe8ffd880b3",
      "narrative_source": "deterministic",
      "surfaced": true,
      "demoted": false,
      "missing_elements": [],
      "demotion_reasons": [],
      "contract_elements": {
        "subject": {
          "accounts": [
            {
              "code": "5124",
              "name": "Conturi la bănci în valută",
              "statement": "BS",
              "bucket": null
            },
            {
              "code": "765",
              "name": "Venituri din diferențe de curs valutar",
              "statement": "PL",
              "bucket": null
            },
            {
              "code": "665",
              "name": "Cheltuieli din diferențe de curs valutar",
              "statement": "PL",
              "bucket": null
            }
          ],
          "scope": "Foreign-currency cash on 5124 inside the cash balance"
        },
        "evidence": {
          "figures": [
            {
              "fact": "fx_cash",
              "value": 133402.89,
              "unit": "money",
              "label": "cash held in foreign currency on 5124"
            },
            {
              "fact": "total_cash",
              "value": 1168047.04,
              "unit": "money",
              "label": "total cash and bank balances"
            },
            {
              "fact": "fx_cash_pct",
              "value": 0.11421020338358977,
              "unit": "percent",
              "label": "foreign-currency share of the cash balance"
            }
          ],
          "provenance": {
            "period_id": "p-agras_fy2025",
            "snapshot_id": "snap-agras_fy2025",
            "line_refs": [
              "5124",
              "765",
              "665"
            ],
            "source": "assembled_canonical_v1"
          },
          "comparison_basis": {
            "kind": "self_total",
            "description": "the foreign-currency component is measured against the company's own total cash for the same period",
            "basis_value": 1168047.04,
            "basis_unit": "money"
          }
        },
        "threshold": {
          "rule_id": "fx_exposure",
          "parameter": "fx_cash_share_high",
          "parameter_label": "FX share of cash ceiling",
          "comparator": ">",
          "limit": 0.1,
          "observed": 0.11421020338358977,
          "unit": "percent",
          "source": "profiles.yaml#detectors.fx_exposure.thresholds.default.fx_cash_share_high"
        },
        "impact": {
          "kind": "recomputed_ratio",
          "metric": "net_margin_ex_currency_result",
          "metric_label": "Net margin, as reported versus excluding the recorded currency result",
          "baseline": 0.06353413797799848,
          "adjusted": 0.06276624565067479,
          "delta": -0.0007678923273236882,
          "unit": "percent",
          "currency": null,
          "baseline_fact": null,
          "adjusted_fact": null
        },
        "why_here": {
          "profile_id": "inventory_operator",
          "profile_label": "mid-size inventory-heavy operator",
          "rationale": "A mid-size inventory-heavy operator reporting in RON carries this position at the closing rate, so a move between the balance-sheet date and settlement lands in the financial result — the line the group treasury and the statutory auditor strips out of EBITDA but not out of the interest-cover test.",
          "signals": [
            "bank_debt",
            "fx_exposure",
            "related_party",
            "revaluation_reserve"
          ],
          "anchors": [
            "mid-size inventory-heavy operator",
            "inventory-heavy operator",
            "mid-size company",
            "inventory-heavy operator",
            "related-party funded",
            "bank debt outstanding",
            "foreign-currency exposure",
            "related-party balances on the books",
            "revaluation reserve in equity"
          ]
        },
        "action": {
          "steps": [
            {
              "imperative": "Match the foreign-currency cash against foreign-currency payables, currency by currency",
              "artefact": "net exposure schedule per currency at the balance-sheet date",
              "provider": "the treasury team",
              "horizon": null
            },
            {
              "imperative": "Lock a forward contract over the uncovered net position",
              "artefact": "forward contract confirmation, with its maturity set against the settlement dates",
              "provider": "the relationship bank",
              "horizon": null
            }
          ]
        },
        "confidence": {
          "level": "medium",
          "basis": "profile inventory_operator/band_mid/fin_related_party_funded resolved from structure",
          "caveat": "Cash-flow lines are indirect-method approximations because no prior period was supplied; working-capital movements carry a wide band."
        }
      },
      "title": "Foreign-currency cash on 5124 inside the cash balance at 11.4% — above the 10.0% FX share of cash ceiling for mid-size inventory-heavy operator",
      "body": "5124 (Conturi la bănci în valută), 765 (Venituri din diferențe de curs valutar), 665 (Cheltuieli din diferențe de curs valutar): cash held in foreign currency on 5124 — RON 133,403; total cash and bank balances — RON 1,168,047; foreign-currency share of the cash balance — 11.4%. Basis: the foreign-currency component is measured against the company's own total cash for the same period. Source: period p-agras_fy2025; snapshot snap-agras_fy2025; accounts 5124, 765, 665; assembled_canonical_v1. Rule fx_exposure fires when FX share of cash ceiling is above 10.0%; observed 11.4%. Impact: Net margin, as reported versus excluding the recorded currency result moves from 6.4% to 6.3% (-0.1%). A mid-size inventory-heavy operator reporting in RON carries this position at the closing rate, so a move between the balance-sheet date and settlement lands in the financial result — the line the group treasury and the statutory auditor strips out of EBITDA but not out of the interest-cover test. Do this: 1) Match the foreign-currency cash against foreign-currency payables, currency by currency — net exposure schedule per currency at the balance-sheet date, from the treasury team. 2) Lock a forward contract over the uncovered net position — forward contract confirmation, with its maturity set against the settlement dates, from the relationship bank. Confidence medium — Cash-flow lines are indirect-method approximations because no prior period was supplied; working-capital movements carry a wide band. (profile inventory_operator/band_mid/fin_related_party_funded resolved from structure).",
      "title_template": "Foreign-currency cash on 5124 inside the cash balance at 11.4% — above the 10.0% FX share of cash ceiling for mid-size inventory-heavy operator",
      "body_template": "5124 (Conturi la bănci în valută), 765 (Venituri din diferențe de curs valutar), 665 (Cheltuieli din diferențe de curs valutar): cash held in foreign currency on 5124 — {{money:fx_cash}}; total cash and bank balances — {{money:total_cash}}; foreign-currency share of the cash balance — 11.4%. Basis: the foreign-currency component is measured against the company's own total cash for the same period. Source: period p-agras_fy2025; snapshot snap-agras_fy2025; accounts 5124, 765, 665; assembled_canonical_v1. Rule fx_exposure fires when FX share of cash ceiling is above 10.0%; observed 11.4%. Impact: Net margin, as reported versus excluding the recorded currency result moves from 6.4% to 6.3% (-0.1%). A mid-size inventory-heavy operator reporting in RON carries this position at the closing rate, so a move between the balance-sheet date and settlement lands in the financial result — the line the group treasury and the statutory auditor strips out of EBITDA but not out of the interest-cover test. Do this: 1) Match the foreign-currency cash against foreign-currency payables, currency by currency — net exposure schedule per currency at the balance-sheet date, from the treasury team. 2) Lock a forward contract over the uncovered net position — forward contract confirmation, with its maturity set against the settlement dates, from the relationship bank. Confidence medium — Cash-flow lines are indirect-method approximations because no prior period was supplied; working-capital movements carry a wide band. (profile inventory_operator/band_mid/fin_related_party_funded resolved from structure).",
      "fact_units": {
        "fx_cash": "money",
        "total_cash": "money",
        "fx_cash_pct": "percent"
      },
      "rank": 0,
      "score": {
        "impact": 0.034036404191031995,
        "confidence": 0.8,
        "persistence": 1.0,
        "actionability": 0.7999999999999999,
        "total": 0.021783298682260473
      },
      "disposition": "info",
      "effective_severity": "info",
      "materiality": {
        "basis_id": "total_assets",
        "basis_label": "total assets",
        "basis_value": 39194178.46,
        "amount": 133402.89,
        "share": 0.0034036404191032,
        "floor": 0.005,
        "tier": "info",
        "source": "engine.api._finding_rank#DEFAULT_FLOORS",
        "statement": "0.34% of total assets (floor 0.50%, info)"
      },
      "persistence": 1,
      "persistence_label": "first period this has fired",
      "root_cause": "5124+765+665",
      "recommendation": false,
      "merged_from": [],
      "contributor_rules": [],
      "contributor_summary": "",
      "dismissed": false,
      "dismissal": null,
      "dismissed_but_retained": false,
      "demotion_reason": ""
    }
  ],
  "demoted": [
    {
      "rule_key": "input_cost_exposure",
      "severity": "medium",
      "category": "margin",
      "source_currency": "RON",
      "facts_cited": {
        "revenue": 118576819.64,
        "ebitda_statutory": 18420491.28,
        "input_cost_share": 0.5950329490554045,
        "input_cost_ceiling_share": 0.35
      },
      "profile_id": "inventory_operator",
      "profile_fingerprint": "0d66ebe8ffd880b3",
      "narrative_source": "deterministic",
      "surfaced": false,
      "demoted": true,
      "missing_elements": [
        "action"
      ],
      "demotion_reasons": [
        "action: no action supplied"
      ],
      "contract_elements": {
        "subject": {
          "accounts": [
            {
              "code": "601",
              "name": "Cheltuieli cu materiile prime",
              "statement": "PL",
              "bucket": null
            },
            {
              "code": "602",
              "name": "Cheltuieli cu materialele consumabile",
              "statement": "PL",
              "bucket": null
            },
            {
              "code": "607",
              "name": "Cheltuieli privind mărfurile",
              "statement": "PL",
              "bucket": null
            }
          ],
          "scope": "Input cost on 601 / 602 / 607 against turnover"
        },
        "evidence": {
          "figures": [
            {
              "fact": "revenue",
              "value": 118576819.64,
              "unit": "money",
              "label": "turnover"
            },
            {
              "fact": "ebitda_statutory",
              "value": 18420491.28,
              "unit": "money",
              "label": "statutory EBITDA"
            },
            {
              "fact": "input_cost_share",
              "value": 0.5950329490554045,
              "unit": "percent",
              "label": "input cost as a share of turnover"
            }
          ],
          "provenance": {
            "period_id": "p-agras_fy2025",
            "snapshot_id": "snap-agras_fy2025",
            "line_refs": [
              "601",
              "602",
              "607"
            ],
            "source": "assembled_canonical_v1"
          },
          "comparison_basis": {
            "kind": "profile_threshold",
            "description": "input cost is measured against the company's own turnover for the same period, and the ceiling is the one this structural profile is graded on",
            "basis_value": 0.35,
            "basis_unit": "percent"
          }
        },
        "threshold": {
          "rule_id": "input_cost_exposure",
          "parameter": "share_of_revenue_high",
          "parameter_label": "input-cost share of revenue ceiling",
          "comparator": ">",
          "limit": 0.35,
          "observed": 0.5950329490554045,
          "unit": "percent",
          "source": "profiles.yaml#detectors.input_cost_exposure.thresholds.by_profile.inventory_operator.share_of_revenue_high"
        },
        "impact": {
          "kind": "recomputed_ratio",
          "metric": "ebitda_margin_at_input_cost_ceiling",
          "metric_label": "EBITDA margin, as reported versus with input cost at the ceiling this profile is graded on",
          "baseline": 0.15534647780168784,
          "adjusted": 0.4003794268570923,
          "delta": 0.2450329490554045,
          "unit": "percent",
          "currency": null,
          "baseline_fact": null,
          "adjusted_fact": null
        },
        "why_here": {
          "profile_id": "inventory_operator",
          "profile_label": "mid-size inventory-heavy operator",
          "rationale": "Input cost is the largest single line a mid-size inventory-heavy operator carries, and it is repriced by suppliers faster than the company can reprice its own customers — the margin, not the volume, is what moves.",
          "signals": [
            "bank_debt",
            "fx_exposure",
            "related_party",
            "revaluation_reserve"
          ],
          "anchors": [
            "mid-size inventory-heavy operator",
            "inventory-heavy operator",
            "mid-size company",
            "inventory-heavy operator",
            "related-party funded",
            "bank debt outstanding",
            "foreign-currency exposure",
            "related-party balances on the books",
            "revaluation reserve in equity"
          ]
        },
        "action": null,
        "confidence": {
          "level": "medium",
          "basis": "profile inventory_operator/band_mid/fin_related_party_funded resolved from structure",
          "caveat": "Cash-flow lines are indirect-method approximations because no prior period was supplied; working-capital movements carry a wide band."
        }
      },
      "title": null,
      "body": null,
      "check_summary": {
        "rule_id": "input_cost_exposure",
        "parameter": "share_of_revenue_high",
        "comparator": ">",
        "limit": 0.35,
        "observed": 0.5950329490554045,
        "unit": "percent",
        "fired": true,
        "profile_id": "inventory_operator",
        "note": "demoted: action: no action supplied"
      },
      "rank": 0,
      "score": {
        "impact": 0.5,
        "confidence": 0.8,
        "persistence": 1.0,
        "actionability": 0.5,
        "total": 0.2
      },
      "disposition": "all_checks",
      "effective_severity": "medium",
      "materiality": {
        "basis_id": "total_assets",
        "basis_label": "total assets",
        "basis_value": 39194178.46,
        "amount": 118576819.64,
        "share": 3.0253681617798094,
        "floor": 0.005,
        "tier": "material",
        "source": "engine.api._finding_rank#DEFAULT_FLOORS",
        "statement": "302.54% of total assets (floor 0.50%, material)"
      },
      "persistence": 1,
      "persistence_label": "first period this has fired",
      "root_cause": "601+602+607",
      "recommendation": false,
      "merged_from": [],
      "contributor_rules": [],
      "contributor_summary": "",
      "dismissed": false,
      "dismissal": null,
      "dismissed_but_retained": false,
      "demotion_reason": "action: no action supplied"
    }
  ],
  "checks": [
    {
      "rule_id": "affiliate_income_dependency",
      "parameter": "",
      "comparator": "",
      "limit": null,
      "observed": null,
      "unit": "unknown",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "class 76 carries no positive residue once interest and FX are removed, so this period recorded no participation income"
    },
    {
      "rule_id": "asset_maturity",
      "parameter": "",
      "comparator": "",
      "limit": null,
      "observed": null,
      "unit": "unknown",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "not run: the accumulated-depreciation share of GROSS PP&E cannot be formed because assembled_bs.ppe_gross and assembled_bs.ppe_accumulated_depreciation is not carried by this engine's canonical views. The net book value and the period charge are present, but they answer a different question from the one this threshold asks, so no proxy was substituted."
    },
    {
      "rule_id": "cash_dividends_declared_unpaid",
      "parameter": "min_amount",
      "comparator": ">",
      "limit": 1000.0,
      "observed": 0.0,
      "unit": "money",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "no material dividend is declared and unpaid at the balance-sheet date"
    },
    {
      "rule_id": "data_quality_bs_imbalance",
      "parameter": "warn_share",
      "comparator": ">",
      "limit": 0.01,
      "observed": 0.0011892852926505759,
      "unit": "percent",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "the two sides of the balance sheet agree within tolerance"
    },
    {
      "rule_id": "data_quality_pnl_zero",
      "parameter": "min_assets",
      "comparator": ">",
      "limit": 1000000.0,
      "observed": 39194178.46,
      "unit": "money",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "revenue is recorded for this period, so the extraction gap this rule looks for is not present"
    },
    {
      "rule_id": "earnings_quality_capitalized_own_work",
      "parameter": "",
      "comparator": "",
      "limit": null,
      "observed": null,
      "unit": "unknown",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "detector earnings_quality_capitalized_own_work needs the capitalised_own_work signal, which is absent for this period"
    },
    {
      "rule_id": "equity_below_half_capital",
      "parameter": "equity_to_capital_max",
      "comparator": "<",
      "limit": 0.5,
      "observed": 2.7199285708601213,
      "unit": "ratio",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "net assets are above the statutory floor in art. 153^24 of Legea 31/1990"
    },
    {
      "rule_id": "equity_quality_revaluation_reserves",
      "parameter": "share_of_equity_high",
      "comparator": ">",
      "limit": 0.25,
      "observed": 0.07894939769087216,
      "unit": "percent",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "the revaluation reserve is a minority of book equity"
    },
    {
      "rule_id": "fcf_negative",
      "parameter": "development_capex_share",
      "comparator": ">",
      "limit": 0.7,
      "observed": null,
      "unit": "percent",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "free cash flow is not negative for this period, so the development-versus-burn split was never formed"
    },
    {
      "rule_id": "leverage_debt_to_ebitda",
      "parameter": "high",
      "comparator": ">",
      "limit": 4.0,
      "observed": 0.19761700568498627,
      "unit": "ratio",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "gross leverage sits inside the comfort ceiling this profile is graded on"
    },
    {
      "rule_id": "leverage_net_debt_ebitda",
      "parameter": "high",
      "comparator": ">",
      "limit": 3.0,
      "observed": 0.13420680547668867,
      "unit": "ratio",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "net leverage sits inside the comfort ceiling this profile is graded on"
    },
    {
      "rule_id": "receivables_allowance_quality",
      "parameter": "allowance_share_high",
      "comparator": ">",
      "limit": 0.15,
      "observed": 0.0,
      "unit": "percent",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "the 49x allowance is a minority of gross receivables"
    },
    {
      "rule_id": "valuation_ebitda_non_positive",
      "parameter": "ebitda_max",
      "comparator": "<=",
      "limit": 0.0,
      "observed": 18420491.28,
      "unit": "money",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "statutory EBITDA is positive, so an earnings multiple has a denominator"
    },
    {
      "rule_id": "concentration_related_party",
      "parameter": "share_of_assets_medium",
      "comparator": ">",
      "limit": 0.1,
      "observed": 0.19625880786990732,
      "unit": "percent",
      "fired": true,
      "profile_id": "inventory_operator",
      "note": ""
    },
    {
      "rule_id": "fx_exposure",
      "parameter": "fx_cash_share_high",
      "comparator": ">",
      "limit": 0.1,
      "observed": 0.11421020338358977,
      "unit": "percent",
      "fired": true,
      "profile_id": "inventory_operator",
      "note": ""
    },
    {
      "rule_id": "input_cost_exposure",
      "parameter": "share_of_revenue_high",
      "comparator": ">",
      "limit": 0.35,
      "observed": 0.5950329490554045,
      "unit": "percent",
      "fired": true,
      "profile_id": "inventory_operator",
      "note": ""
    },
    {
      "rule_id": "liquidity_cash_tight",
      "parameter": "cash_ratio_low",
      "comparator": "<",
      "limit": 0.12,
      "observed": 0.09030369285017299,
      "unit": "ratio",
      "fired": true,
      "profile_id": "inventory_operator",
      "note": ""
    },
    {
      "rule_id": "input_cost_exposure",
      "parameter": "share_of_revenue_high",
      "comparator": ">",
      "limit": 0.35,
      "observed": 0.5950329490554045,
      "unit": "percent",
      "fired": true,
      "profile_id": "inventory_operator",
      "note": "demoted: action: no action supplied; action: no action supplied",
      "disposition": "all_checks",
      "materiality": {
        "basis_id": "total_assets",
        "basis_label": "total assets",
        "basis_value": 39194178.46,
        "amount": 118576819.64,
        "share": 3.0253681617798094,
        "floor": 0.005,
        "tier": "material",
        "source": "engine.api._finding_rank#DEFAULT_FLOORS",
        "statement": "302.54% of total assets (floor 0.50%, material)"
      }
    }
  ],
  "cap": 7,
  "counts": {
    "candidates": 4,
    "immaterial": 0,
    "info": 1,
    "dismissed": 0,
    "incomplete": 1,
    "merged": 0,
    "held_back": 0
  },
  "materiality_policy": "engine.api._finding_rank#DEFAULT_FLOORS",
  "statement": "2 finding(s) surfaced; 1 demoted for missing a contract element."
};

export const ENGINE_SILENCE: unknown = {
  "material_findings": 0,
  "profile_id": "inventory_operator",
  "checks_performed": 13,
  "statement": "No finding met the seven-element contract for this period. 13 check(s) ran; each is listed with its parameter, its limit and the observed value.",
  "checks": [
    {
      "rule_id": "affiliate_income_dependency",
      "parameter": "",
      "comparator": "",
      "limit": null,
      "observed": null,
      "unit": "unknown",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "class 76 carries no positive residue once interest and FX are removed, so this period recorded no participation income"
    },
    {
      "rule_id": "asset_maturity",
      "parameter": "",
      "comparator": "",
      "limit": null,
      "observed": null,
      "unit": "unknown",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "not run: the accumulated-depreciation share of GROSS PP&E cannot be formed because assembled_bs.ppe_gross and assembled_bs.ppe_accumulated_depreciation is not carried by this engine's canonical views. The net book value and the period charge are present, but they answer a different question from the one this threshold asks, so no proxy was substituted."
    },
    {
      "rule_id": "cash_dividends_declared_unpaid",
      "parameter": "min_amount",
      "comparator": ">",
      "limit": 1000.0,
      "observed": 0.0,
      "unit": "money",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "no material dividend is declared and unpaid at the balance-sheet date"
    },
    {
      "rule_id": "data_quality_bs_imbalance",
      "parameter": "warn_share",
      "comparator": ">",
      "limit": 0.01,
      "observed": 0.0011892852926505759,
      "unit": "percent",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "the two sides of the balance sheet agree within tolerance"
    },
    {
      "rule_id": "data_quality_pnl_zero",
      "parameter": "min_assets",
      "comparator": ">",
      "limit": 1000000.0,
      "observed": 39194178.46,
      "unit": "money",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "revenue is recorded for this period, so the extraction gap this rule looks for is not present"
    },
    {
      "rule_id": "earnings_quality_capitalized_own_work",
      "parameter": "",
      "comparator": "",
      "limit": null,
      "observed": null,
      "unit": "unknown",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "detector earnings_quality_capitalized_own_work needs the capitalised_own_work signal, which is absent for this period"
    },
    {
      "rule_id": "equity_below_half_capital",
      "parameter": "equity_to_capital_max",
      "comparator": "<",
      "limit": 0.5,
      "observed": 2.7199285708601213,
      "unit": "ratio",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "net assets are above the statutory floor in art. 153^24 of Legea 31/1990"
    },
    {
      "rule_id": "equity_quality_revaluation_reserves",
      "parameter": "share_of_equity_high",
      "comparator": ">",
      "limit": 0.25,
      "observed": 0.07894939769087216,
      "unit": "percent",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "the revaluation reserve is a minority of book equity"
    },
    {
      "rule_id": "fcf_negative",
      "parameter": "development_capex_share",
      "comparator": ">",
      "limit": 0.7,
      "observed": null,
      "unit": "percent",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "free cash flow is not negative for this period, so the development-versus-burn split was never formed"
    },
    {
      "rule_id": "leverage_debt_to_ebitda",
      "parameter": "high",
      "comparator": ">",
      "limit": 4.0,
      "observed": 0.19761700568498627,
      "unit": "ratio",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "gross leverage sits inside the comfort ceiling this profile is graded on"
    },
    {
      "rule_id": "leverage_net_debt_ebitda",
      "parameter": "high",
      "comparator": ">",
      "limit": 3.0,
      "observed": 0.13420680547668867,
      "unit": "ratio",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "net leverage sits inside the comfort ceiling this profile is graded on"
    },
    {
      "rule_id": "receivables_allowance_quality",
      "parameter": "allowance_share_high",
      "comparator": ">",
      "limit": 0.15,
      "observed": 0.0,
      "unit": "percent",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "the 49x allowance is a minority of gross receivables"
    },
    {
      "rule_id": "valuation_ebitda_non_positive",
      "parameter": "ebitda_max",
      "comparator": "<=",
      "limit": 0.0,
      "observed": 18420491.28,
      "unit": "money",
      "fired": false,
      "profile_id": "inventory_operator",
      "note": "statutory EBITDA is positive, so an earnings multiple has a denominator"
    }
  ]
};
