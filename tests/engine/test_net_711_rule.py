"""GATE net-711-rule — net 711 is MEASURED, never the gross memo, never a
zero standing in for an absent anchor.

THE RULING (owner, 2026-09-26): account 711 inside EBITDA and the
operating result, with its sign, shown as "Variația stocurilor de produse"
beside cost of sales; outside cifra de afaceri. 722 the same way. One
definition everywhere, with the reconciliation line.

THE INCIDENT THIS GATE DESCENDS FROM (specs-durable/ebitda711/measure.md):
the engine served `inventory_variation_memo` = Σ sume totale C of 711 — the
GROSS production stocked on a closed trial balance — and a view
`ebitda_statutory_with_711` built on it: EBITDA margins of 98.9 %-191.0 % on
every closed manufacturer (Scandia Food FY2025: 630,091,698.19 of "stock
variation" against a filed variation of about 1.08M). The direct net
Σ(credit − debit) is 0.00 on every closed book. The only correct reading
of a closed book is the account-121 bridge, and it is only as good as the
anchor and the reading of every other line — so it is GUARDED and it
REFUSES rather than approximates.

WHAT THIS GATE HOLDS, on CONSTRUCTED synthetic books (no client data):

  OPEN                 net 711 = Σ(st_c − st_d), provenance 711_net_movement
  CLOSED, no activity  exactly 0.00, no_711_activity; a 121 remainder stays
                       visible, never folded
  CLOSED-bridge        the 121 bridge, account_121_bridge; the chain closes
  MIXED                refused book_state_mixed
  unanchored (G2)      refused account_121_anchor_absent — NEVER 0.00
  G4 unread leaf       refused unread_pl_activity
  G4 total row read    refused pl_total_row_read_as_account (a total row
                       printed beside its analytics is read twice); a
                       DISTINCT prefix-coded account is read, not skipped
  G5 residual > 711    refused residual_exceeds_711_activity
  G6 uncleared 121     refused account_121_opening_not_cleared
  G7 older reader      refused reprocess_required (design A10) — the rows
                       were read by another trial-balance parser version,
                       so the residual may be a reading difference

and on each: EBITDA / EBIT / gross profit / PBT on the one definition — or
refused with the SAME typed reason; the gross 711 credit turnover served
only under its audit name; the reconciliation line signed and closing to
account 121 where it is anchored. The bridge book and a legacy envelope go
through the REAL write path (stage_map → stage_persist) and the REAL
GET /api/period and briefing-rebuild seams: the evidence block is persisted
with the envelope and read back; an envelope written before the measurement
refuses 711 with `period_predates_stock_variation_measurement`.

WHAT IT REDS ON, with the rule in place (TC-11): serving the gross memo
(or any line amount) as the variation; an absent anchor turned into 0.00;
a guard dropped; a refusal that leaves EBITDA served; a rebuild seam that
stops threading the persisted evidence. In-file plants prove the checkers
fail on each (NET711-PLANTS); the source-edit plant log is in
docs/engine_book/gates.md "net-711-rule".
"""
from __future__ import annotations

import copy
import types
from typing import Any, Dict, List

import pytest
from _pytest.monkeypatch import MonkeyPatch

import test_rebuild_net_income_anchor as ANCHOR
from engine.api import pipeline as P
from engine.country_packs.ro_romania import chart_of_accounts as coa
from engine.country_packs.ro_romania import stock_variation as sv
from engine.country_packs.ro_romania.pack import RomaniaPack

import corpus_replay  # scripts/ on sys.path via the anchor module

PACK = RomaniaPack()
WORK: Dict[str, Any] = {"units": 0, "books": [], "plants": [], "routes": []}

LINE_NAME = "Variația stocurilor de produse"


# ── Constructed books ────────────────────────────────────────────────────


def _row(code: str, name: str = "", *, si_d: float = 0.0, si_c: float = 0.0,
         st_d: float = 0.0, st_c: float = 0.0, sf_d: float = 0.0,
         sf_c: float = 0.0) -> Dict[str, Any]:
    return {"cont": code, "nume_cont": name or code,
            "si_d": si_d, "si_c": si_c,
            "r_d": st_d - si_d, "r_c": st_c - si_c,
            "st_d": st_d, "st_c": st_c, "sf_d": sf_d, "sf_c": sf_c}


def _closed_pl(amount_711: float = 300_000.0, extra: List[Dict[str, Any]] = ()) -> List[Dict[str, Any]]:
    """Class 6/7 of a CLOSED manufacturer: every leaf closed into 121
    (cumulative debit = credit, closing 0). Revenue 1,000,000; materials
    600,000; salaries 200,000; depreciation 50,000; tax 30,000; 711 turned
    over `amount_711` each side (production stocked 300,000, destocked
    250,000 → true net +50,000; the closing entry makes the sides equal)."""
    rows = [
        _row("701", "Venituri din vanzarea produselor finite", st_d=1_000_000.0, st_c=1_000_000.0),
        _row("601", "Cheltuieli cu materiile prime", st_d=600_000.0, st_c=600_000.0),
        _row("641", "Cheltuieli cu salariile personalului", st_d=200_000.0, st_c=200_000.0),
        _row("6811", "Cheltuieli cu amortizarea", st_d=50_000.0, st_c=50_000.0),
        _row("691", "Cheltuieli cu impozitul pe profit", st_d=30_000.0, st_c=30_000.0),
    ]
    if amount_711:
        rows.append(_row("711", "Venituri aferente costurilor stocurilor de produse",
                         st_d=amount_711, st_c=amount_711))
    return rows + list(extra)


def _bs(result_121: float, *, opening_121: float = 80_000.0, cleared: bool = True,
        with_121: bool = True) -> List[Dict[str, Any]]:
    """The balance sheet around it. Account 121 closes to `result_121`;
    its opening (the prior-year profit) is transferred to 1171 in the
    period when `cleared` — the equal movement G6 looks for."""
    transfer = opening_121 if cleared else 0.0
    rows = [
        _row("1012", "Capital subscris varsat", si_c=100_000.0, st_c=100_000.0, sf_c=100_000.0),
        _row("1171", "Rezultatul reportat", si_c=20_000.0, st_c=20_000.0 + transfer,
             sf_c=20_000.0 + transfer),
        _row("345", "Produse finite", si_d=200_000.0, st_d=500_000.0, st_c=250_000.0,
             sf_d=250_000.0),
    ]
    if with_121:
        closing = result_121 + (0.0 if cleared else opening_121)
        rows.append(_row("121", "Profit si pierdere", si_c=opening_121,
                         st_d=transfer + 880_000.0,
                         st_c=opening_121 + 880_000.0 + result_121,
                         sf_c=closing))
    equity = 100_000.0 + 20_000.0 + transfer + (
        (result_121 + (0.0 if cleared else opening_121)) if with_121 else 0.0)
    cash = equity - 250_000.0
    rows.append(_row("5121", "Conturi la banci in lei", st_d=max(cash, 0.0) + 880_000.0,
                     st_c=880_000.0 + max(-cash, 0.0),
                     sf_d=max(cash, 0.0), sf_c=max(-cash, 0.0)))
    return rows


def book_closed_bridge() -> List[Dict[str, Any]]:
    return _closed_pl() + _bs(170_000.0)


def book_closed_no_activity() -> List[Dict[str, Any]]:
    # 121 closes at 122,000 while the accounts give 120,000: a 2,000.00
    # remainder no line explains (a constructed misread). No 711 posting.
    return _closed_pl(amount_711=0.0) + _bs(122_000.0)


def book_open() -> List[Dict[str, Any]]:
    """OPEN: class 6/7 carry their own net (no closing entry, no 121)."""
    return [
        _row("701", "Venituri din vanzarea produselor finite", st_c=1_000_000.0, sf_c=1_000_000.0),
        _row("601", "Cheltuieli cu materiile prime", st_d=600_000.0, sf_d=600_000.0),
        _row("641", "Cheltuieli cu salariile personalului", st_d=200_000.0, sf_d=200_000.0),
        _row("6811", "Cheltuieli cu amortizarea", st_d=50_000.0, sf_d=50_000.0),
        _row("691", "Cheltuieli cu impozitul pe profit", st_d=30_000.0, sf_d=30_000.0),
        _row("711", "Venituri aferente costurilor stocurilor de produse",
             st_d=250_000.0, st_c=300_000.0, sf_c=50_000.0),
        _row("1012", "Capital subscris varsat", st_c=100_000.0, sf_c=100_000.0),
        _row("5121", "Conturi la banci in lei", st_d=270_000.0, sf_d=270_000.0),
    ]


def book_mixed() -> List[Dict[str, Any]]:
    """MIXED: a monthly-closing exporter, December not closed. Every leaf
    prints its December net in both the cumulative and the closing column
    (January-November closing entries cancel inside the cumulative sides)
    — only account 121, which DID receive closing entries in the period,
    tells it from an open book."""
    return [
        _row("701", "Venituri", st_d=900_000.0, st_c=1_000_000.0, sf_c=100_000.0),
        _row("601", "Materii prime", st_d=600_000.0, st_c=540_000.0, sf_d=60_000.0),
        _row("641", "Salarii", st_d=200_000.0, st_c=180_000.0, sf_d=20_000.0),
        _row("6811", "Amortizare", st_d=50_000.0, st_c=45_000.0, sf_d=5_000.0),
        _row("691", "Impozit", st_d=30_000.0, st_c=27_000.0, sf_d=3_000.0),
        _row("711", "Variatia stocurilor", st_d=290_000.0, st_c=300_000.0, sf_c=10_000.0),
        _row("121", "Profit si pierdere", st_d=792_000.0, st_c=945_000.0, sf_c=153_000.0),
        _row("1012", "Capital", st_c=100_000.0, sf_c=100_000.0),
        _row("5121", "Banca", st_d=275_000.0, sf_d=275_000.0),
    ]


def book_unanchored() -> List[Dict[str, Any]]:
    """The closed-bridge book with account 121 absent (G2)."""
    return _closed_pl() + _bs(170_000.0, with_121=False)


def book_g4_unread() -> List[Dict[str, Any]]:
    """An active class-7 leaf the pack has no rule for (7311): its 5,000
    would sit in the remainder and print as stock variation."""
    return _closed_pl(extra=[_row("7311", "Venit neclasificat", st_d=5_000.0, st_c=5_000.0)]) + \
        _bs(175_000.0)


def book_g4_double_read() -> List[Dict[str, Any]]:
    """A synthetic total row 601 printed beside its analytics 601.1 / 601.2
    (its figures are their sum): the assembler reads all three, so the
    build-up the bridge is measured against counts 600,000 twice (G4)."""
    rows = [r for r in _closed_pl() if r["cont"] != "601"]
    rows += [
        _row("601", "Cheltuieli cu materiile prime (total)", st_d=600_000.0, st_c=600_000.0),
        _row("601.1", "Materii prime A", st_d=400_000.0, st_c=400_000.0),
        _row("601.2", "Materii prime B", st_d=200_000.0, st_c=200_000.0),
    ]
    return rows + _bs(170_000.0)


def book_distinct_prefix_account() -> List[Dict[str, Any]]:
    """A condensed book prints 6028 beside an unmerged 6028.9 — two
    DISTINCT accounts (the prefix row is not their sum). Both are read,
    exactly as the assembler reads them, and the bridge holds."""
    rows = [r for r in _closed_pl() if r["cont"] != "601"]
    rows += [
        _row("601", "Cheltuieli cu materiile prime", st_d=500_000.0, st_c=500_000.0),
        _row("6028", "Alte materiale consumabile", st_d=70_000.0, st_c=70_000.0),
        _row("6028.9", "Alte materiale consumabile (analitic)", st_d=30_000.0, st_c=30_000.0),
    ]
    return rows + _bs(170_000.0)


def book_g5_residual() -> List[Dict[str, Any]]:
    """711 turned over 30,000 each side, yet 121 exceeds the other lines by
    50,000 — larger than 711's own turnover, so it cannot be its net."""
    return _closed_pl(amount_711=30_000.0) + _bs(170_000.0)


def book_g6_uncleared() -> List[Dict[str, Any]]:
    """121 still carries last year's 80,000 profit (no transfer to 1171,
    no 121 ledger structure showing it): the bridge would put it into this
    year's 711 (residual 130,000 ≤ 711's 300,000 — G5 alone passes)."""
    return _closed_pl() + _bs(170_000.0, cleared=False)


def book_bridge_with_722() -> List[Dict[str, Any]]:
    """The bridge book plus own work capitalised 40,000 (closed, one-sided)."""
    return _closed_pl(extra=[_row("722", "Venituri din productia de imobilizari corporale",
                                  st_d=40_000.0, st_c=40_000.0)]) + _bs(210_000.0)


#: The reader version G7's witness was "read" by — any version but the
#: running one (the pack stamps the parse result's own version).
OLDER_PARSER = "tb_parser_v5"


def book_g7_older_parser() -> List[Dict[str, Any]]:
    """G7 (design A10): the bridge book as an OLDER trial-balance reader
    returned it — it read 701 at 1,040,000 where the file says 1,000,000
    (Carniprod 7c29a71b: turnover 99,424,740.16 served, 94,509,940 filed).
    Account 121 still says 170,000, so the residual is 10,000 — a reading
    difference that passes G4-G6 and would print as "stock variation".
    The parse result carries its reader's version; the running reader is
    another, so the fold refuses `reprocess_required`."""
    from engine.country_packs.ro_romania.trial_balance_parser import TrialBalanceParseResult

    rows = [r for r in book_closed_bridge() if r["cont"] != "701"]
    rows.insert(0, _row("701", "Venituri din vanzarea produselor finite",
                        st_d=1_040_000.0, st_c=1_040_000.0))
    return TrialBalanceParseResult(
        rows, extraction={"method": "deterministic", "parser_version": OLDER_PARSER})


BOOKS = {
    "open": book_open,
    "closed_no_activity": book_closed_no_activity,
    "closed_bridge": book_closed_bridge,
    "mixed": book_mixed,
    "unanchored": book_unanchored,
    "g4_unread": book_g4_unread,
    "g4_double_read": book_g4_double_read,
    "distinct_prefix_account": book_distinct_prefix_account,
    "g5_residual": book_g5_residual,
    "g6_uncleared": book_g6_uncleared,
    "bridge_with_722": book_bridge_with_722,
    "g7_older_parser": book_g7_older_parser,
}

#: What each book must serve: (net 711, provenance or refusal code,
#: EBITDA or None, gross profit or None, net 72x).
EXPECTED = {
    "open":               (50_000.0, "711_net_movement",               250_000.0, 450_000.0, 0.0),
    "closed_no_activity": (0.0,      "no_711_activity",                200_000.0, 400_000.0, 0.0),
    "closed_bridge":      (50_000.0, "account_121_bridge",             250_000.0, 450_000.0, 0.0),
    "mixed":              (None,     "book_state_mixed",               None,      None,      0.0),
    "unanchored":         (None,     "account_121_anchor_absent",      None,      None,      0.0),
    "g4_unread":          (None,     "unread_pl_activity",             None,      None,      0.0),
    "g4_double_read":     (None,     "pl_total_row_read_as_account",   None,      None,      0.0),
    "distinct_prefix_account": (50_000.0, "account_121_bridge",        250_000.0, 450_000.0, 0.0),
    "g5_residual":        (None,     "residual_exceeds_711_activity",  None,      None,      0.0),
    "g6_uncleared":       (None,     "account_121_opening_not_cleared", None,     None,      0.0),
    "bridge_with_722":    (50_000.0, "account_121_bridge",             290_000.0, 450_000.0, 40_000.0),
    "g7_older_parser":    (None,     "reprocess_required",             None,      None,      0.0),
}

BOOK_STATE = {
    "open": sv.OPEN, "closed_no_activity": sv.CLOSED, "closed_bridge": sv.CLOSED,
    "mixed": sv.MIXED, "unanchored": sv.CLOSED, "g4_unread": sv.CLOSED,
    "g4_double_read": sv.CLOSED, "distinct_prefix_account": sv.CLOSED,
    "g5_residual": sv.CLOSED, "g6_uncleared": sv.CLOSED, "bridge_with_722": sv.CLOSED,
    "g7_older_parser": sv.CLOSED,
}

_BALANCE_TOLERANCE = 0.005


def _assemble(name: str) -> Dict[str, Any]:
    """The OFFLINE production composition (`RomaniaPack.assemble_parsed_tb`
    — the same calls stage_extract + stage_map make)."""
    _tb, _shaped, assembled = PACK.assemble_parsed_tb(BOOKS[name]())
    return assembled


# ── The checkers (plants below prove each one can fail) ─────────────────


def check_served_pl(name: str, pl: Dict[str, Any]) -> List[str]:
    """Every problem with one served `assembled_pl` against the rule."""
    problems: List[str] = []
    v711, prov_or_code, ebitda, gross, v72 = EXPECTED[name]
    inv = pl.get("inventory_variation") or {}
    cap = pl.get("capitalized_own_work") or {}
    if inv.get("line_name_ro") != LINE_NAME:
        problems.append("%s: the line is not named %r" % (name, LINE_NAME))
    if cap.get("value") != v72:
        problems.append("%s: net 72x %r, expected %r" % (name, cap.get("value"), v72))
    # Retired: no served field may carry the gross memo as a number.
    for retired in ("inventory_variation_memo", "ebitda_statutory_with_711",
                    "total_operating_revenue_statutory"):
        if retired in pl:
            problems.append("%s: the retired gross-memo field %r is served" % (name, retired))
    if v711 is None:
        ref = inv.get("refusal") or {}
        if inv.get("value") is not None:
            problems.append("%s: 711 served %r where the rule refuses (%s)"
                            % (name, inv.get("value"), prov_or_code))
        if ref.get("code") != prov_or_code:
            problems.append("%s: 711 refusal %r, expected %r" % (name, ref.get("code"), prov_or_code))
        if not ref.get("text_ro") or not ref.get("text_en"):
            problems.append("%s: the refusal carries no RO/EN text" % name)
        for fld in ("ebitda", "ebit", "operating_result", "gross_profit", "pretax",
                    "ebitda_statutory", "ebitda_operational", "operating_ebitda",
                    "core_ebitda", "adjusted_ebitda"):
            if pl.get(fld) is not None:
                problems.append("%s: %s served %r while 711 is refused" % (name, fld, pl.get(fld)))
        er = pl.get("ebitda_refusal") or {}
        if er.get("code") != prov_or_code:
            problems.append("%s: EBITDA refusal %r, expected the 711 reason %r"
                            % (name, er.get("code"), prov_or_code))
    else:
        if inv.get("refusal") is not None:
            problems.append("%s: 711 refused (%r) where the rule serves %r"
                            % (name, (inv.get("refusal") or {}).get("code"), v711))
        if inv.get("value") is None or abs(inv["value"] - v711) > _BALANCE_TOLERANCE:
            problems.append("%s: net 711 %r, expected %r" % (name, inv.get("value"), v711))
        if inv.get("provenance") != prov_or_code:
            problems.append("%s: provenance %r, expected %r" % (name, inv.get("provenance"), prov_or_code))
        if not inv.get("label_ro", "").startswith(LINE_NAME) or not inv.get("label_en"):
            problems.append("%s: the provenance label is missing or renamed" % name)
        for fld, want in (("ebitda", ebitda), ("gross_profit", gross)):
            got = pl.get(fld)
            if got is None or abs(got - want) > _BALANCE_TOLERANCE:
                problems.append("%s: %s %r, expected %r" % (name, fld, got, want))
        if pl.get("ebitda") is not None:
            for alias in ("ebitda_statutory", "ebitda_operational", "ebitda_operating_view",
                          "ebitda_cash", "operating_ebitda"):
                if pl.get(alias) != pl.get("ebitda"):
                    problems.append("%s: %s %r is a second EBITDA (the one is %r)"
                                    % (name, alias, pl.get(alias), pl.get("ebitda")))
            before = pl.get("ebitda_before_stock_variation")
            if before is None or abs(before + inv["value"] + cap["value"] - pl["ebitda"]) > 0.01:
                problems.append("%s: EBITDA %r != before %r + 711 %r + 72x %r"
                                % (name, pl.get("ebitda"), before, inv["value"], cap["value"]))
            if pl.get("ebit") is None or abs(pl["ebitda"] - pl["depreciation"] - pl["ebit"]) > 0.01:
                problems.append("%s: EBIT %r is not EBITDA − D&A" % (name, pl.get("ebit")))
        if pl.get("ebitda_refusal") is not None:
            problems.append("%s: an EBITDA refusal is served beside a served 711" % name)
    # The gross credit turnover: served ONLY under its audit name.
    if inv.get("stock_production_credit_turnover") is None and v711 is not None and \
            prov_or_code != "no_711_activity":
        problems.append("%s: the audit figure stock_production_credit_turnover is absent" % name)
    if prov_or_code == "account_121_bridge":
        rec = pl.get("ebitda_reconciliation") or {}
        lines = {ln["key"]: ln for ln in rec.get("lines") or []}
        if not rec.get("identity_with_121"):
            problems.append("%s: the reconciliation does not say it closes by construction" % name)
        ne = (lines.get("not_explained") or {}).get("value")
        if ne is None or abs(ne) > 0.01:
            problems.append("%s: the chain does not close to account 121 (not explained %r)" % (name, ne))
        iv_line = lines.get("inventory_variation") or {}
        if iv_line.get("beside") != "cost_of_sales" or iv_line.get("value") != inv.get("value"):
            problems.append("%s: the 711 line is not beside cost of sales with the served value" % name)
    if name == "closed_no_activity":
        if abs((pl.get("net_income_unexplained_vs_121") or 0.0) - 2_000.0) > _BALANCE_TOLERANCE:
            problems.append("closed_no_activity: the 2,000.00 remainder was folded "
                            "(unexplained %r)" % pl.get("net_income_unexplained_vs_121"))
    return problems


# ── 1. The rule on every constructed book (offline composition) ──────────


@pytest.mark.parametrize("name", sorted(BOOKS))
def test_the_rule_on_each_constructed_book(name):
    assembled = _assemble(name)
    pl = assembled["statements"]["assembled_pl"]
    ev = assembled["assembled_canonical_v1"]["stock_variation"]
    assert ev["book_state"] == BOOK_STATE[name], (name, ev["book_state"])
    problems = check_served_pl(name, pl)
    assert not problems, "\n".join(problems)
    WORK["books"].append(name)
    WORK["units"] += 1 + len(EXPECTED[name])


def test_the_evidence_is_a_function_of_the_book_not_of_its_row_order():
    """Row permutation is a metamorphic invariant of the whole envelope:
    the evidence block (which clearing account it names, which codes it
    lists) must not depend on the order the exporter printed rows in."""
    rows = book_g6_uncleared() + [_row("7311", "x", st_d=1.0, st_c=1.0)]
    base = sv.measure(rows)
    assert sv.measure(list(reversed(rows))) == base
    assert sv.measure(rows[3:] + rows[:3]) == base
    bridge = book_closed_bridge() + [_row("1172", "Rezultat reportat 2", st_c=80_000.0,
                                          si_c=0.0, sf_c=80_000.0)]
    assert sv.measure(bridge) == sv.measure(list(reversed(bridge)))
    WORK["units"] += 3


def test_the_gross_memo_is_never_the_variation_on_a_closed_book():
    """The incident, stated on the bridge book: the 711 line amount (the
    gross production stocked, 300,000) is on the line item, and nothing
    served reads it as the variation."""
    assembled = _assemble("closed_bridge")
    pl = assembled["statements"]["assembled_pl"]
    li_711 = [li for li in assembled["lineItems"] if li["ro_account_code"] == "711"]
    assert li_711 and li_711[0]["amount"] == 300_000.0
    assert pl["inventory_variation"]["value"] == 50_000.0
    assert pl["inventory_variation"]["stock_production_credit_turnover"] == 300_000.0
    assert pl["ebitda"] == 250_000.0, "EBITDA %r read the gross memo" % pl["ebitda"]
    WORK["units"] += 4


def test_an_absent_anchor_is_a_refusal_never_zero():
    """G2 — the bridge without its anchor: refused, the typed reason, and
    the guard block says why. Never 0.00, never the reconstruction."""
    pl = _assemble("unanchored")["statements"]["assembled_pl"]
    inv = pl["inventory_variation"]
    assert inv["value"] is None and inv["guards"]["G2_anchored"] is False
    assert inv["guards"]["G5_residual"] is None, "a residual was computed without an anchor"
    assert pl["ebitda"] is None and pl["ebit"] is None
    WORK["units"] += 3


def test_the_statutory_return_and_the_absent_evidence_branches():
    """A filed return prints the variation net (the measurement itself);
    with NO evidence the line items decide whether 711 is posted at all —
    none posted is exactly 0.00, one posted refuses with the reason."""
    base = [{"code": "701", "name": "v", "amount": 1_000.0},
            {"code": "601", "name": "c", "amount": 400.0}]
    stat = coa.assemble_statements(base + [{"code": "711", "name": "var", "amount": -120.0}],
                                   stock_variation_evidence=sv.evidence_from_statutory_return(-120.0))
    pl = stat["statements"]["assembled_pl"]
    assert pl["inventory_variation"]["value"] == -120.0
    assert pl["inventory_variation"]["provenance"] == sv.PROV_STATUTORY
    assert pl["ebitda"] == 480.0 and pl["gross_profit"] == 480.0
    assert stat["assembled_canonical_v1"]["stock_variation"]["basis"] == sv.BASIS_STATUTORY

    none = coa.assemble_statements(base)["statements"]["assembled_pl"]
    assert none["inventory_variation"]["value"] == 0.0
    assert none["inventory_variation"]["provenance"] == sv.PROV_NO_ACTIVITY
    assert none["ebitda"] == 600.0

    posted = coa.assemble_statements(base + [{"code": "711", "name": "var", "amount": 900.0}])
    ppl = posted["statements"]["assembled_pl"]
    assert ppl["inventory_variation"]["refusal"]["code"] == sv.REASON_EVIDENCE_ABSENT
    assert ppl["ebitda"] is None and ppl["ebitda_refusal"]["code"] == sv.REASON_EVIDENCE_ABSENT
    assert "stock_variation" not in (posted.get("assembled_canonical_v1") or {}), (
        "an absence marker was stored on the envelope as if it were a measurement")
    WORK["units"] += 10


def test_767_is_financial_and_the_open_72x_is_its_net():
    """767 (discounts received) sits in the financial result, outside
    EBITDA and EBIT; an OPEN book's 72x is Σ(credit − debit)."""
    rows = book_open() + [
        _row("767", "Venituri din sconturi obtinute", st_c=7_000.0, sf_c=7_000.0),
        _row("722", "Venituri din productia de imobilizari", st_d=5_000.0, st_c=40_000.0,
             sf_c=35_000.0),
    ]
    _tb, _sh, a = PACK.assemble_parsed_tb(rows)
    pl = a["statements"]["assembled_pl"]
    assert pl["capitalized_own_work"]["value"] == 35_000.0
    assert pl["capitalized_own_work"]["provenance"] == sv.PROV_72X_MOVEMENT
    assert pl["ebitda"] == 250_000.0 + 35_000.0, pl["ebitda"]
    assert pl["discounts_received"] == 7_000.0
    assert pl["pretax"] == pytest.approx(pl["ebit"] + pl["net_financial_result"], abs=0.01)
    assert pl["net_financial_result"] == 7_000.0
    WORK["units"] += 5


# ── 2. The real write path and the real served seams ─────────────────────


def _persisted(name: str) -> types.SimpleNamespace:
    """A constructed book through the REAL write seam: `_deterministic_tb_
    parsed` (which measures the evidence) → `stage_map` → `stage_persist`
    over the corpus replay's fake admin — exactly what a served route later
    reads back."""
    tb_rows = BOOKS[name]()
    shaped = PACK.accounts_to_assemble_shape(tb_rows)
    doc = {"id": "doc-net711-%s" % name, "org_id": "org-corpus",
           "original_filename": "net711_%s_2025.xlsx" % name,
           "content_hash": "sha256-net711-%s" % name, "period_end_hint": "2025-12-31"}
    parsed = P._deterministic_tb_parsed(
        doc, tb_rows, shaped, PACK.compute_statutory_net_profit_anchor(tb_rows),
        PACK.compute_source_imbalance(tb_rows))
    assert sv.is_measured(parsed.get("stock_variation_evidence")), (
        "the persist seam did not measure the evidence")
    assembled = P.stage_map(doc, parsed, None)
    with corpus_replay.fake_persist_seam() as fake:
        period_id = P.stage_persist(doc, parsed, assembled)
        line_items = [dict(r) for r in fake.inserted_line_items]
        period = dict(fake.period_rows[0])
        writes = [patch["assembled_canonical_v1"] for table, patch, _f in fake.updates
                  if table == "financial_periods" and "assembled_canonical_v1" in patch]
    assert writes, "stage_persist wrote no envelope"
    period["assembled_canonical_v1"] = writes[-1]
    return types.SimpleNamespace(
        period=period, line_items=line_items, period_id=period_id,
        org={"id": doc["org_id"], "name": "Net 711 constructed %s" % name},
        write_pl=assembled["statements"]["assembled_pl"])


def _served_pl(bk) -> Dict[str, Any]:
    mp = MonkeyPatch()
    try:
        with ANCHOR._routed(bk, mp) as (client, _db):
            resp = client.get("/api/period/%s" % bk.period_id,
                              headers={"Authorization": "Bearer test"})
    finally:
        mp.undo()
    assert resp.status_code == 200, resp.text[:400]
    return resp.json()["statements"]["assembled_pl"]


@pytest.mark.parametrize("name", ["closed_bridge", "open", "unanchored", "bridge_with_722"])
def test_the_evidence_is_persisted_and_every_served_seam_reads_it(name):
    bk = _persisted(name)
    env = bk.period["assembled_canonical_v1"]
    assert sv.is_measured(env.get("stock_variation")), (
        "%s: the persisted envelope carries no stock_variation block" % name)
    served = _served_pl(bk)
    problems = check_served_pl(name, served)
    assert not problems, "GET /api/period:\n" + "\n".join(problems)
    # The briefing-rebuild seam (Capsule tools, Radar, firm lane, forecast
    # route, briefing regenerate) — a different rebuild, the same answer.
    rebuilt = P._rebuild_assembled_for_briefing(bk.line_items, bk.period, bk.org)
    problems = check_served_pl(name, rebuilt["statements"]["assembled_pl"])
    assert not problems, "briefing rebuild:\n" + "\n".join(problems)
    for fld in ("ebitda", "gross_profit", "net_income_statutory"):
        assert served.get(fld) == bk.write_pl.get(fld), (
            "%s: %s served %r, written %r" % (name, fld, served.get(fld), bk.write_pl.get(fld)))
    assert served["inventory_variation"]["value"] == bk.write_pl["inventory_variation"]["value"]
    WORK["routes"].append(name)
    WORK["units"] += 6


def test_a_period_written_before_the_measurement_refuses_711():
    """A legacy envelope (no stock_variation block) — what every period
    persisted before this change looks like until it is reprocessed: 711
    refuses with `period_predates_stock_variation_measurement`, EBITDA with
    it; the line amount (the gross memo) is never read in its place."""
    bk = _persisted("closed_bridge")
    bk.period = copy.deepcopy(bk.period)
    bk.period["assembled_canonical_v1"].pop("stock_variation")
    served = _served_pl(bk)
    inv = served["inventory_variation"]
    assert inv["value"] is None
    assert inv["refusal"]["code"] == sv.REASON_PREDATES
    assert served["ebitda"] is None and served["ebitda_refusal"]["code"] == sv.REASON_PREDATES
    # A row that never selected the envelope says THAT, not "predates".
    assert P._stock_variation_evidence_for({"id": "p"})["absent_reason"] == sv.REASON_ENVELOPE_NOT_READ
    WORK["units"] += 4


def test_g7_the_block_carries_its_reader_and_an_older_reader_never_bridges():
    """G7 (design A10), at both times. PERSIST: the block records the reader
    that produced the rows (the running one on a fresh parse; the parse
    result's own version when it carries one). REBUILD: a period persisted
    by an older reader — its stored block stamped with that reader —
    refuses 711 `reprocess_required` on the served route, EBITDA with it,
    and never serves its residual as the variation; the same period
    persisted by the running reader bridges."""
    from engine.country_packs.ro_romania.trial_balance_parser import PARSER_VERSION as running
    fresh = _assemble("closed_bridge")["assembled_canonical_v1"]["stock_variation"]
    assert fresh["parser_version"] == running, fresh.get("parser_version")
    old = _assemble("g7_older_parser")
    assert old["assembled_canonical_v1"]["stock_variation"]["parser_version"] == OLDER_PARSER
    guards = old["statements"]["assembled_pl"]["inventory_variation"]["guards"]
    assert guards["G7_parser_version"] == OLDER_PARSER and guards["G7_current"] is False
    assert guards["G5_within_activity"] is True and guards["G6_cleared_by"], (
        "the witness must pass every other guard — only G7 stands between it and the fold")
    assert round(guards["G5_residual"], 2) == 10_000.0, guards["G5_residual"]
    # a caller that does not state the running reader gets no fold (fail
    # closed): decide on the CURRENT block, without the running version
    cur = _assemble("closed_bridge")
    inv, _cap = sv.decide(
        cur["assembled_canonical_v1"]["stock_variation"],
        account_121=170_000.0,
        net_income_operational=cur["statements"]["assembled_pl"]["net_income_operational"],
        read_711_lines=300_000.0, read_72x_lines=0.0)
    assert inv["value"] is None and inv["refusal"]["code"] == sv.REASON_REPROCESS, inv

    bk = _persisted("closed_bridge")
    stored = bk.period["assembled_canonical_v1"]["stock_variation"]
    assert stored["parser_version"] == running, "stage_persist dropped the reader stamp"
    bk.period = copy.deepcopy(bk.period)
    bk.period["assembled_canonical_v1"]["stock_variation"]["parser_version"] = OLDER_PARSER
    served = _served_pl(bk)
    inv = served["inventory_variation"]
    assert inv["value"] is None and inv["refusal"]["code"] == sv.REASON_REPROCESS, inv
    assert served["ebitda"] is None and served["ebitda_refusal"]["code"] == sv.REASON_REPROCESS
    # an unstamped block (measured before G7 existed) is not the running reader either
    bk.period["assembled_canonical_v1"]["stock_variation"].pop("parser_version")
    unstamped = _served_pl(bk)["inventory_variation"]
    assert unstamped["refusal"]["code"] == sv.REASON_REPROCESS, unstamped
    WORK["routes"].append("g7_older_parser")
    WORK["units"] += 9


# ── 3. Plants: the checkers above must fail on each defect ───────────────


def _with_plant(monkeypatch, plant: str) -> None:
    original = sv.decide

    def planted(evidence, **kw):
        inv, cap = original(evidence, **kw)
        if plant == "serve-the-gross-memo" and inv.get("provenance") == sv.PROV_BRIDGE:
            inv["value"] = inv["stock_production_credit_turnover"]
        elif plant == "absent-anchor-to-zero" and (inv.get("refusal") or {}).get("code") == \
                sv.REASON_UNANCHORED:
            inv.update(value=0.0, refusal=None, provenance=sv.PROV_NO_ACTIVITY)
        elif plant == "drop-guard-g6" and (inv.get("refusal") or {}).get("code") == \
                sv.REASON_OPENING:
            inv.update(value=inv["guards"]["G5_residual"], refusal=None, provenance=sv.PROV_BRIDGE)
        elif plant == "drop-guard-g7" and (inv.get("refusal") or {}).get("code") == \
                sv.REASON_REPROCESS:
            inv.update(value=inv["guards"]["G5_residual"], refusal=None, provenance=sv.PROV_BRIDGE)
        return inv, cap

    monkeypatch.setattr(sv, "decide", planted)


@pytest.mark.parametrize("plant,book", [
    ("serve-the-gross-memo", "closed_bridge"),
    ("absent-anchor-to-zero", "unanchored"),
    ("drop-guard-g6", "g6_uncleared"),
    ("drop-guard-g7", "g7_older_parser"),
])
def test_plant_is_caught(plant, book, monkeypatch):
    _with_plant(monkeypatch, plant)
    pl = _assemble(book)["statements"]["assembled_pl"]
    problems = check_served_pl(book, pl)
    assert problems, "PLANT %s on %s went unnoticed — the checker is blind" % (plant, book)
    WORK["plants"].append(plant)
    WORK["units"] += 1


def test_plant_a_rebuild_that_forgets_the_evidence(monkeypatch):
    """A rebuild seam that stops threading the persisted evidence: every
    manufacturer's 711 turns into a refusal on the served route."""
    bk = _persisted("closed_bridge")
    monkeypatch.setattr(P, "_evidence_kwargs", lambda assembler, evidence: {})
    served = _served_pl(bk)
    assert check_served_pl("closed_bridge", served), (
        "PLANT rebuild-forgets-the-evidence went unnoticed")
    WORK["plants"].append("rebuild-forgets-the-evidence")
    WORK["units"] += 1


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE net-711-rule (stock_variation.measure/decide, owner ruling 2026-09-26): "
              "%d constructed books, %d through the real write path and GET /api/period, "
              "%d plants" % (len(WORK["books"]), len(WORK["routes"]), len(WORK["plants"])))
        print("NET711-BOOKS: %s" % ", ".join(sorted(WORK["books"])))
        print("NET711-PLANTS: %s" % ", ".join(WORK["plants"]))
        print("GATE-WORK net-711-rule units=%d" % WORK["units"])
    assert len(WORK["books"]) == len(BOOKS), "TC-3: the sweep judged %d of %d books" % (
        len(WORK["books"]), len(BOOKS))
    assert len(WORK["plants"]) == 5
