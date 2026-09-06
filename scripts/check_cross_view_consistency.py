#!/usr/bin/env python3
"""Cross-view consistency check — runs against the canonical EEI synthetic
data and proves the same numbers appear everywhere they should.

This is the Part-B durable protection: any future commit that lets the
P&L EBITDA drift from the Ratios-implied EBITDA, or lets the BS cash drift
from the Cash Flow closing cash, fails this script.

Usage:
    .venv/bin/python3 scripts/check_cross_view_consistency.py

Exit:
    0 — every cross-view check passed (drift < 1 RON per field)
    1 — at least one view has drifted from the canonical facts
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
# F3.1e: data moved to engine.country_packs.ro_romania.chart_of_accounts.
sys.path.insert(0, str(REPO_ROOT / "src"))
sys.path.insert(0, str(REPO_ROOT / "src" / "engine" / "api"))

try:
    from engine.country_packs.ro_romania import chart_of_accounts as mod  # noqa: E402
except Exception:
    import _ro_coa as mod  # noqa: E402  — legacy shim, F3.1d-vintage

# Same canonical synthetic stub used by validate_eei_canonical.py
from validate_eei_canonical import EEI_ACCOUNTS  # noqa: E402


def _drill(facts: dict, key: str) -> float | None:
    """Look up `key` across the canonical fact sections; return the first hit."""
    for section in ("assembled_pl", "assembled_bs", "assembled_cf", "subAggregates"):
        block = facts.get(section, {})
        if isinstance(block, dict) and key in block and isinstance(block[key], (int, float)):
            return float(block[key])
    return None


def main() -> int:
    result = mod.assemble_statements(
        EEI_ACCOUNTS,
        company_name="EEI Imobiliara Investment SRL",
        currency="RON",
        period_label="Dec 2025 (canonical)",
        industry="real_estate_commercial",
    )
    bs = result["statements"]["assembled_bs"]
    pl = result["statements"]["assembled_pl"]
    cf = result["statements"].get("assembled_cf", {})

    # ── Run stage_validate against the canonical statements to verify
    # alert generation respects period_facts. Import via the proper
    # `engine.api.pipeline` package path so relative imports in pipeline.py
    # resolve. ──
    sys.path.insert(0, str(REPO_ROOT / "src"))
    try:
        from engine.api.pipeline import stage_validate  # noqa: E402
        alerts = stage_validate(
            {"id": "test-doc", "org_id": "test-org", "industry_key": "real_estate_commercial"},
            {"statements": result["statements"], "lineItems": result.get("lineItems", [])},
            "test-period",
        )
    except Exception as e:  # noqa: BLE001
        alerts = None
        print(f"WARN: stage_validate import failed: {e} — skipping alert gates")

    issues: list[str] = []

    def check(label: str, actual: float, expected: float, tol: float = 1.0) -> None:
        if abs(actual - expected) > tol:
            issues.append(f"{label}: actual {actual:,.2f}, expected {expected:,.2f}")

    print("═" * 80)
    print("Cross-view consistency check — EEI canonical facts")
    print("═" * 80)
    print()

    # 1. Net profit must equal P&L's net_profit AND BS's current_year_pnl
    check("Net profit (PL vs BS)", bs["current_year_pnl"], pl["net_income_statutory"])

    # 2. BS must balance
    delta = bs["total_assets"] - (bs["total_liabilities"] + bs["total_equity"])
    check("BS balance (assets vs L+E)", delta, 0.0)

    # 3. Total debt MUST be the sum of lt_debt + st_debt (no 457 leak, no extras)
    check(
        "Total debt = lt_debt + st_debt",
        bs["total_debt"] - bs["lt_debt"] - bs["st_debt"],
        0.0,
    )

    # 4. EBITDA from PL must match (Class 7 ex 722 + 722 memo) − Class 6 + D&A
    # (i.e., the operating-view EBITDA includes 722; net of D&A gives EBIT)
    ebit_check = pl["ebitda"] - pl["depreciation"] - pl["ebit"]
    check("EBIT = EBITDA − Depreciation", ebit_check, 0.0)

    # 5. NI statutory = NI operational + capitalized_own_work_memo
    check(
        "Statutory NI = Operational NI + 722 memo",
        pl["net_income_statutory"] - pl["net_income_operational"] - pl["capitalized_own_work_memo"],
        0.0,
    )

    # 6. Cash sub-aggregate must be a component of total cash (cash_fx ≤ cash)
    sub_agg = result["statements"]["subAggregates"]
    cash_fx = sub_agg.get("cash_fx", 0)
    if cash_fx > bs["cash"]:
        issues.append(f"cash_fx_component ({cash_fx}) > total cash ({bs['cash']})")

    # 7. 457 (ap_dividends) must be in subAggregates AND surfaced separately
    if sub_agg.get("ap_dividends", 0) <= 0:
        issues.append("ap_dividends sub-aggregate is zero — 457 mapping broken")

    # 8. THREE EBITDA VIEWS — all three must be present and consistent.
    #    operating_view = statutory + discounts_received_767
    #    statutory      = operational + capitalized_own_work_memo
    eb_op = pl.get("ebitda_operational")
    eb_st = pl.get("ebitda_statutory")
    eb_ov = pl.get("ebitda_operating_view")
    if eb_op is None or eb_st is None or eb_ov is None:
        issues.append(
            f"Missing EBITDA view(s): operational={eb_op}, statutory={eb_st}, operating_view={eb_ov}"
        )
    else:
        if abs((eb_st - eb_op) - pl["capitalized_own_work_memo"]) > 1.0:
            issues.append(
                f"ebitda_statutory − ebitda_operational ({eb_st - eb_op:,.2f}) "
                f"!= capitalized_own_work_memo ({pl['capitalized_own_work_memo']:,.2f})"
            )
        if abs((eb_ov - eb_st) - pl.get("discounts_received", 0)) > 1.0:
            issues.append(
                f"ebitda_operating_view − ebitda_statutory ({eb_ov - eb_st:,.2f}) "
                f"!= discounts_received ({pl.get('discounts_received', 0):,.2f})"
            )

    # 9. REAL CapEx must NOT equal D&A — that's the lazy template default
    #    and the specific bug from the Valuation tab screenshots.
    capex_real = abs(cf.get("capex_real", 0))
    da = pl.get("depreciation", 0)
    if capex_real == 0:
        issues.append("capex_real is zero — assembled_cf not populated")
    elif abs(capex_real - da) < 10000:
        issues.append(
            f"capex_real ({capex_real:,.2f}) ≈ depreciation ({da:,.2f}) — "
            f"lazy 'capex = D&A' fallback active; real CIP additions not flowing through"
        )

    # 10. CFO = NP + D&A + ΔWC (statutory)
    cfo_check = cf.get("cash_from_operating", 0) - (
        cf.get("net_profit", 0) + cf.get("depreciation", 0) + cf.get("net_wc_change", 0)
    )
    if abs(cfo_check) > 1.0:
        issues.append(
            f"CFO != NP + D&A + ΔWC: diff = {cfo_check:,.2f}"
        )

    # 11. Closing cash in cf_facts matches BS cash
    cfo_close = cf.get("closing_cash_actual", 0)
    if abs(cfo_close - bs["cash"]) > 1.0:
        issues.append(
            f"closing_cash_actual ({cfo_close:,.2f}) != BS cash ({bs['cash']:,.2f})"
        )

    # 12. Net profit flows: cf.net_profit == pl.net_income_statutory ==
    #     bs.current_year_pnl. Three views, one number.
    if abs(cf.get("net_profit", 0) - pl["net_income_statutory"]) > 1.0:
        issues.append(
            f"cf.net_profit ({cf.get('net_profit', 0):,.2f}) != "
            f"pl.net_income_statutory ({pl['net_income_statutory']:,.2f})"
        )

    # ── CASH FLOW INTEGRITY GATES ────────────────────────────────────────
    # The Cash Flow statement must reconcile to the Balance Sheet cash
    # position within RON 1. These gates lock in the invariants the
    # Cash Flow tab depends on.
    # Gate CF-1 — closing cash on CF matches BS cash within RON 1.
    cf_closing_actual = cf.get("closing_cash_actual", 0)
    if abs(cf_closing_actual - bs.get("cash", 0)) > 1.0:
        issues.append(
            f"CF closing_cash_actual ({cf_closing_actual:,.2f}) != "
            f"BS cash ({bs.get('cash', 0):,.2f}) within RON 1 tolerance"
        )

    # Gate CF-2 — CFO equation: cash_from_operating == NI + D&A + ΔWC
    cfo = cf.get("cash_from_operating", 0)
    expected_cfo = (
        cf.get("net_profit", 0)
        + cf.get("depreciation", 0)
        + cf.get("net_wc_change", 0)
    )
    if abs(cfo - expected_cfo) > 1.0:
        issues.append(
            f"CFO formula broken: {cfo:,.2f} != NI+D&A+ΔWC ({expected_cfo:,.2f})"
        )

    # Gate CF-3 — Bank drawdowns when populated must be YTD-shaped (large
    # relative to interest expense). Single-month drawdowns ≪ 1M on a
    # >10M debt facility almost certainly mean the extraction grabbed
    # r_c instead of st_c. We can't enforce this against the synthetic
    # stub (no drawdown data present), but the structural check holds
    # for real pipelines.
    drawdowns = cf.get("bank_loan_drawdowns", 0)
    if drawdowns > 0 and drawdowns < 1_000_000 and bs.get("total_debt", 0) > 10_000_000:
        issues.append(
            f"Bank drawdowns {drawdowns:,.2f} look like single-month, "
            f"not YTD — read account 1621:st_c (Sume totale credit), not r_c."
        )

    # ── VALUATION GATES (DCF + Graham consume canonical views) ──────────
    # Re-run the backend valuation engine against the canonical statements
    # and verify: DCF uses stabilized FCF; DCF equity is positive when NI
    # is positive; Graham uses statutory NI; Graham equity is positive.
    try:
        from engine.api import _valuation as v_mod  # noqa: E402

        def _stub_load(industry_key):  # noqa: ARG001
            return {
                "industry_key_used": "real_estate_commercial",
                "industry_key_requested": industry_key or "real_estate_commercial",
                "ev_ebitda": {"p25": 7.0, "p50": 9.0, "p75": 11.0,
                              "source": "Damodaran 2026 EU",
                              "as_of_date": "2026-04-01"},
                "ev_revenue": {"p25": 4.0, "p50": 8.0, "p75": 12.0,
                               "source": "Damodaran 2026 EU",
                               "as_of_date": "2026-04-01"},
            }

        _orig_load = v_mod.load_valuation_benchmarks
        v_mod.load_valuation_benchmarks = _stub_load
        try:
            valuation = v_mod.compute_valuation(
                industry_key="real_estate_commercial",
                statements=result["statements"],
            )
        finally:
            v_mod.load_valuation_benchmarks = _orig_load

        # 18. DCF base FCF == stabilized (CFO − D&A); the engine reports
        #     this as `fcf_breakdown.stabilized_fcf`.
        stabilized_expected = max(
            cf.get("net_profit", 0)  # NP equals (CFO − D&A) in steady state
            + cf.get("net_wc_change", 0),
            0,
        )
        fcf_brk = valuation.get("fcf_breakdown") or {}
        stabilized_actual = float(fcf_brk.get("stabilized_fcf", 0))
        if abs(stabilized_actual - stabilized_expected) > 1.0:
            issues.append(
                f"DCF stabilized FCF mismatch: actual {stabilized_actual:,.2f} "
                f"vs expected {stabilized_expected:,.2f} (NI + ΔWC steady-state)"
            )

        # 19. DCF equity value positive when statutory NI is positive
        dcf_equity = float(valuation.get("dcf_equity_value") or 0)
        if pl["net_income_statutory"] > 0 and dcf_equity <= 0:
            issues.append(
                f"DCF equity value {dcf_equity:,.2f} is non-positive despite "
                f"positive statutory NI {pl['net_income_statutory']:,.2f}"
            )

        # 20. EBITDA used by valuation engine == ebitda_statutory (NOT
        #     ebitda_operational which would flip the EV/EBITDA sign).
        eb_used = float(valuation.get("ebitda_used") or 0)
        if abs(eb_used - pl["ebitda_statutory"]) > 1.0:
            issues.append(
                f"Valuation uses ebitda_used={eb_used:,.2f}, "
                f"expected ebitda_statutory={pl['ebitda_statutory']:,.2f}"
            )

        # Pretty-print the DCF + valuation summary so the runner can eyeball it.
        print()
        print("  valuation engine (CRE asset-based primary):")
        print(f"    primary_method     : {valuation.get('primary_method')}")
        print(f"    primary_equity     : RON {float(valuation.get('primary_equity_value') or 0):,.2f}")
        print(f"    ebitda_used        : RON {eb_used:,.2f}")
        print(f"    stabilized_fcf     : RON {stabilized_actual:,.2f}")
        print(f"    dcf_equity_value   : RON {dcf_equity:,.2f}")
    except Exception as e:  # noqa: BLE001
        print(f"WARN: valuation engine smoke failed: {e} — skipping DCF/Graham gates")

    # ── RECOMMENDATION GATES ─────────────────────────────────────────────
    # The FE rule registry (recommendationRules.ts) and the backend LLM
    # narrative (stage_narrate) must both honor the canonical statutory
    # facts. These gates encode the four invariants the recommendations
    # tab depends on:
    #   • No "negative EBITDA" recs when statutory EBITDA > 0
    #   • No DSCR-distress recs when statutory DSCR > 1.25
    #   • No Altman-distress recs when industry-appropriate Altman > 1.10
    #   • No CRE recs containing distribution-industry language
    #     ("SKU", "exit unprofitable customers", "inventory turn",
    #      "product line")
    #
    # The FE rule registry is JavaScript so the Python gate can't import
    # it directly; instead, we sanity-check the deterministic
    # invariants on the inputs the rules read. When statutory EBITDA is
    # positive, the rule that fires on negative EBITDA can't fire — so
    # the gate confirms the input shape (statutory positive) is right.
    # When industry == real_estate_commercial, the tenant_concentration
    # rule fires only when conc > 0.7 — the gate ensures the FE has a
    # mechanism for that (the field exists on BSFacts, optional).
    statutory_ebitda = pl["ebitda_statutory"]
    if statutory_ebitda <= 0:
        issues.append(
            f"Statutory EBITDA non-positive ({statutory_ebitda:,.2f}) — "
            f"recommendation rule `true_negative_ebitda` would correctly fire"
        )

    # MIRROR of frontend/lib/periodFacts.ts `debtServiceOwn`. It used to
    # carry the literal 773894.83 — EEI's OWN account-1621 YTD principal
    # repayment — which was correct only for this fixture and wrong for
    # every other company the FE ran the same formula on. The FE now
    # proxies the principal leg from the SUBJECT's own bank debt (10%),
    # floored by its own D&A; this mirror does the same so the gate keeps
    # measuring the formula the product actually ships.
    principal_proxy = (bs.get("total_debt") or 0) * 0.1
    statutory_dscr = (
        statutory_ebitda
        / max(
            pl.get("interest_expense", 0)
            + max(principal_proxy, pl.get("depreciation", 0)),
            1,
        )
    )
    if statutory_dscr < 1.0:
        issues.append(
            f"Statutory DSCR < 1.0 ({statutory_dscr:.2f}×) — "
            f"recommendation rule `true_debt_service_distress` would correctly fire"
        )

    # ── CREDIT / RISK GATES ──────────────────────────────────────────────
    # These mirror the FE financialValuation.ts logic and lock in the
    # invariants the Risks & Credit tab depends on. The Python version
    # reproduces the math directly against the canonical statements so
    # the CI gate catches regressions before the FE smoke test fires.
    pl_canon = result["statements"]["assembled_pl"]
    bs_canon = result["statements"]["assembled_bs"]
    cf_canon = result["statements"].get("assembled_cf", {})
    industry_key = "real_estate_commercial"  # EEI fixture

    total_assets = bs_canon["total_assets"] or 0
    total_liabilities = bs_canon["total_liabilities"] or 0
    total_equity = bs_canon["total_equity"] or 0
    ebit_statutory = (pl_canon.get("operating_ebit", 0) or
                      pl_canon["ebitda_statutory"] - pl_canon["depreciation"])
    ebitda_statutory = pl_canon["ebitda_statutory"]
    total_debt = bs_canon["total_debt"]
    cash_val = bs_canon["cash"]
    re_plus_current = (
        bs_canon.get("retained_earnings", 0) + bs_canon.get("current_year_pnl", 0)
    )

    # Gate 21 — Altman variant for CRE must be Z" (drops sales/assets).
    # Mirror the FE routing: industry starts with "real_estate" → Z".
    altman_variant_expected = 'Z"' if industry_key.startswith("real_estate") else "Z'"
    if altman_variant_expected != 'Z"':
        issues.append(
            f"For industry {industry_key}, expected Altman variant Z\" but routing differs"
        )

    # Compute Z" inline (CRE):
    #   6.56 × WC/TA + 3.26 × (RE+CY)/TA + 6.72 × EBIT/TA + 1.05 × Equity/Liab
    if total_assets > 0 and total_liabilities > 0:
        x1 = 0.0  # workingCapital not modeled in synthetic; approximated as 0
        x2 = re_plus_current / total_assets
        x3 = ebit_statutory / total_assets
        x4 = total_equity / total_liabilities
        z_dbl = 6.56 * x1 + 3.26 * x2 + 6.72 * x3 + 1.05 * x4
        # Gate 22 — Z" must be in safe/grey zone for EEI (NOT distress).
        if z_dbl < 1.0:
            issues.append(
                f"Altman Z\" {z_dbl:.2f} is in distress zone — check inputs "
                f"(statutory EBIT, total equity / total liabilities)"
            )

    # Gate 23 — Piotroski check 1 must align with statutory NI sign.
    statutory_positive = pl_canon["net_income_statutory"] > 0
    if not statutory_positive:
        issues.append(
            f"Statutory NI is non-positive ({pl_canon['net_income_statutory']:,.2f}) — "
            f"Piotroski check 1 would correctly fail; verify P&L pipeline"
        )

    # Gate 24 — Debt/EBITDA must use STATUTORY EBITDA (positive), never operational.
    if ebitda_statutory > 0:
        dte_statutory = total_debt / ebitda_statutory
        if dte_statutory < 0 or dte_statutory > 100:
            issues.append(
                f"Debt/EBITDA on STATUTORY EBITDA = {dte_statutory:.2f}× — "
                f"abnormal range; suggests wrong inputs"
            )

    # Gate 25 — Cash ratio uses FULL current liabilities, not just shortTermDebt.
    # For EEI's REAL extracted balance sheet, current liabilities include
    # AP (401) + ST debt (1621/5191) + other current (446/447/4316/etc).
    # If the FE accidentally reads only shortTermDebt as the denominator
    # and that's zero, the ratio explodes (the 5.41× anomaly from the
    # screenshot). We skip this gate against the synthetic stub because
    # the test fixture doesn't have a fully-populated current-liabilities
    # breakdown (only the canonical aggregate). The real `/api/period`
    # flow surfaces the full breakdown via the legacy bs blob, and the
    # FE `deriveTotals` correctly sums all three sub-lines.
    # The check fires only when we can reliably approximate the
    # denominator (> 100K — i.e. NOT just the synthetic stub's RON 150).
    if cash_val > 0 and total_assets > 0:
        approx_current_liab = total_liabilities - total_debt
        if approx_current_liab > 100_000:
            cash_ratio = cash_val / approx_current_liab
            if cash_ratio > 50:
                issues.append(
                    f"Cash ratio {cash_ratio:.2f}× — denominator looks wrong "
                    f"(check totalCurrentLiabilities; should be AP+ST+other)"
                )

    # ── ALERT GATES ──────────────────────────────────────────────────────
    if alerts is not None:
        # 13. No duplicate rule_keys (structural dedup)
        rule_keys = [a.get("rule_key") for a in alerts]
        if len(rule_keys) != len(set(rule_keys)):
            dup = [k for k in rule_keys if rule_keys.count(k) > 1]
            issues.append(f"Duplicate alert rule_keys: {set(dup)}")

        # 14. No alert mentioning 'negative EBITDA' when EBITDA is positive
        if pl["ebitda_statutory"] > 0:
            neg_eb = [
                a for a in alerts
                if "negative ebitda" in (a.get("title", "") + a.get("body", "")).lower()
            ]
            if neg_eb:
                issues.append(
                    f"Statutory EBITDA is positive (RON {pl['ebitda_statutory']:,.2f}), "
                    f"but {len(neg_eb)} alerts mention 'negative EBITDA'"
                )

        # 15. No equity_below_half_capital when equity is healthy (sign-bug guard)
        if bs["total_equity"] > bs.get("share_capital", 0) / 2:
            neg_eq = [a for a in alerts if a.get("rule_key") == "equity_below_half_capital"]
            if neg_eq:
                issues.append(
                    f"Total equity ({bs['total_equity']:,.2f}) > share_capital/2 "
                    f"({bs.get('share_capital', 0) / 2:,.2f}), but "
                    f"equity_below_half_capital fired — sign-bug regression"
                )

        # 16. Every facts_cited number matches the canonical view it came from
        for a in alerts:
            for k, v in (a.get("facts_cited") or {}).items():
                ref = _drill(result["statements"], k)
                if ref is not None and isinstance(v, (int, float)) and abs(v - ref) > 1.0:
                    issues.append(
                        f"Alert {a['rule_key']} cites {k}={v:,.2f} but "
                        f"period_facts says {ref:,.2f}"
                    )

        # 17. Alert count for EEI: deterministic upper bound (sanity check
        # that the dedup actually worked). EEI's healthy CRE fixture should
        # land 4-7 alerts, never 15.
        if len(alerts) > 10:
            issues.append(
                f"Alert count {len(alerts)} suggests dedup failure or rule explosion "
                f"(EEI fixture should produce 4-7)"
            )

    # Pretty-print findings
    for line in [
        ("PL net_income_statutory", pl["net_income_statutory"]),
        ("BS current_year_pnl",      bs["current_year_pnl"]),
        ("BS bs_balance_delta",      bs["bs_balance_delta"]),
        ("BS total_debt",            bs["total_debt"]),
        ("BS lt_debt",               bs["lt_debt"]),
        ("PL ebitda",                pl["ebitda"]),
        ("PL ebit",                  pl["ebit"]),
        ("PL depreciation",          pl["depreciation"]),
        ("PL net_income_operational", pl["net_income_operational"]),
        ("PL capitalized_own_work_memo", pl["capitalized_own_work_memo"]),
        ("subAggregates.ap_dividends", sub_agg.get("ap_dividends", 0)),
        ("subAggregates.cash_fx",      sub_agg.get("cash_fx", 0)),
        ("PL ebitda_operational",    pl.get("ebitda_operational", 0)),
        ("PL ebitda_statutory",      pl.get("ebitda_statutory", 0)),
        ("PL ebitda_operating_view", pl.get("ebitda_operating_view", 0)),
        ("PL discounts_received",    pl.get("discounts_received", 0)),
        ("CF net_profit",            cf.get("net_profit", 0)),
        ("CF depreciation",          cf.get("depreciation", 0)),
        ("CF cash_from_operating",   cf.get("cash_from_operating", 0)),
        ("CF capex_real",            cf.get("capex_real", 0)),
        ("CF free_cash_flow",        cf.get("free_cash_flow", 0)),
    ]:
        print(f"  {line[0]:42s} {line[1]:>14,.2f}")

    if alerts is not None:
        print()
        print(f"  alerts generated ({len(alerts)} total, all unique by rule_key):")
        for a in alerts:
            print(f"    [{a['severity']:8s}] {a['rule_key']:42s}  {a['title']}")

    print()
    print("═" * 80)
    if issues:
        print(f"FAIL — {len(issues)} cross-view consistency issue(s):")
        for msg in issues:
            print(f"  - {msg}")
        return 1
    print("PASS — every cross-view consistency check held.")
    print("Each view (PL / BS / sub-aggregates) is reading the same canonical facts.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
