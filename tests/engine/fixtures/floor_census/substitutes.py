"""SELF-TEST FIXTURE for scripts/check_floor_census.py (TC-2, TC-11).

Exactly ONE verbatim pre-fix instance per substitute class, S1-S8, each
copied from the site the floor sweep confirmed (specs/floor_sweep.json).
The census must find every one on every run, or it is DISCOVERY BROKEN.
This file is never imported by the product; it is data for a gate.
"""


def _at_least(value, floor):  # S5 helper definition (table.py:401 before C2)
    return value if value > floor else floor


def s1_divisor_floor(current_liab, non_current_liab, total_equity):
    total_liab_safe = max(current_liab + non_current_liab, 1)  # credit_model.py:291 before C1.1
    x4 = total_equity / total_liab_safe
    return x4


def s2_or_floor(revenue, ebit):
    return ebit / (revenue or 1)  # frontend.py:449 before C7


def s3_sentinel_on_undefined(operating_profit, interest):
    ic = (operating_profit / interest) if interest > 0 else 999  # credit_model.py:464 before C1.5
    return ic


def s4_epsilon_swap(operating_ebitda, net_debt):
    ebitda_for_ratios = operating_ebitda if operating_ebitda else 1e-9  # pipeline.py:2944 before C8
    return net_debt / ebitda_for_ratios


def s5_helper_floor(nopat, invested_capital):
    return nopat / _at_least(invested_capital, 1.0)  # table.py:695 before C2


def s6_none_to_constant(value):
    if value is None:
        return 50  # risk_scoring_engine.py:119 before C9
    return value


def s7_domain_replacement(wacc, g_terminal):
    if wacc <= g_terminal:
        wacc = g_terminal + 0.005  # _valuation.py:235 before C3
    return wacc


def s8_constant_period(ar, revenue):
    return {"periodDays": 365, "dso": ar / revenue * 365}  # chart_of_accounts.py:1706 before C10
