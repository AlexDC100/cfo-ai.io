"""GATE turnover-7411 — operating subsidies related to turnover are INSIDE
cifra de afaceri netă.

THE RULING (owner, 2026-09-28, R3): "the statutory F20 includes operating
subsidies related to turnover in cifra de afaceri netă. Include it; verify
filed-turnover matching on any book with 7411." F20 rd. 01 (cifra de
afaceri netă) = rd. 02 … rd. 05, and rd. 05 is ct. 7411. The placement is
the P&L definition pack's (packs/ro/pl_definition.yaml); the classification
pack still says what 7411 IS (an operating subsidy) and is untouched.

NO LOCAL BOOK, CORPUS BOOK OR COMMITTED FIXTURE POSTS 7411 (searched
2026-09-28: the corpus inputs, every tests/engine fixture workbook, the
local client books; two books post 7418 — other operating subsidies — and
those STAY outside turnover, which is what makes their served turnover the
filed I13 to under 1 leu). So the witness is CONSTRUCTED: a synthetic book
whose statement of account F20 rd. 01 is written beside it, sent through the
offline composition and the REAL write path, GET /api/period and the
briefing rebuild.

WHAT THIS GATE HOLDS on the witness:
  · served turnover = class 70 − 709 + 7411 = the witness's F20 rd. 01;
  · the 7411 leaf is PERSISTED in the turnover line (bucket `revenue`),
    and a rebuild from the stored rows reads the same turnover;
  · 7418 stays in other operating income (the prefix is 7411, not 741);
  · EBITDA does not move with the placement (a turnover line and an
    other-income line are both inside it), the EBITDA margin divides the
    turnover that holds 7411, the methodology's `totals.revenue_net` and
    FactsGateway.revenue() are that turnover, adjusted EBITDA no longer
    strips it;
  · the turnover line's leaves (the evidence view's feeds) sum to it.

WHAT IT REDS ON, with the rule in place (TC-11): 7411 left in other
operating income; 7418 pulled into turnover; a rebuild that drops the
placement. In-file plants (TURNOVER7411-PLANTS); the source-edit plant log
is in docs/engine_book/gates.md "turnover-7411".
"""
from __future__ import annotations

import copy
import types
from typing import Any, Dict, List

import pytest
from _pytest.monkeypatch import MonkeyPatch

import test_net_711_rule as N
import test_rebuild_net_income_anchor as ANCHOR
from engine.api import pipeline as P
from engine.country_packs.ro_romania import pl_definition as pld
from engine.ratios import credit_model
from engine.serving.facts import FactsGateway

WORK: Dict[str, Any] = {"units": 0, "books": [], "routes": [], "plants": []}

_row = N._row


def _closed(code: str, name: str, amount: float) -> Dict[str, Any]:
    return _row(code, name, st_d=amount, st_c=amount)


def _pl(extra: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """A closed book with no 711 postings: revenue 1,000,000; materials
    600,000; salaries 200,000; 6811 50,000; tax 30,000."""
    return N._closed_pl(amount_711=0.0, extra=extra)


def book_subsidy_7411() -> List[Dict[str, Any]]:
    return _pl([
        _closed("7411", "Venituri din subventii de exploatare aferente cifrei de afaceri", 80_000.0),
        _closed("7418", "Venituri din subventii de exploatare pentru alte venituri", 12_000.0),
    ]) + N._bs(212_000.0)


def book_subsidy_7411_analytic() -> List[Dict[str, Any]]:
    """The same witness with the subsidy split into analytics as SAGA writes
    them (7411.01 / 7411.02) — the classification pack's startswith rule."""
    return _pl([
        _closed("7411.01", "Subventii pret energie", 50_000.0),
        _closed("7411.02", "Subventii tarif transport", 30_000.0),
        _closed("7418", "Venituri din subventii de exploatare pentru alte venituri", 12_000.0),
    ]) + N._bs(212_000.0)


def book_only_7418() -> List[Dict[str, Any]]:
    return _pl([_closed("7418", "Venituri din subventii de exploatare pentru alte venituri",
                        12_000.0)]) + N._bs(132_000.0)


BOOKS = {
    "subsidy_7411": book_subsidy_7411,
    "subsidy_7411_analytic": book_subsidy_7411_analytic,
    "only_7418": book_only_7418,
}

#: F20 rd. 01 as the witness's statement of account prints it, and what the
#: engine must serve beside it. (F20 rd. 01, 7411 placed, other operating
#: income, EBITDA, adjusted EBITDA)
EXPECTED = {
    "subsidy_7411":          (1_080_000.0, 80_000.0, 12_000.0, 292_000.0, 280_000.0),
    "subsidy_7411_analytic": (1_080_000.0, 80_000.0, 12_000.0, 292_000.0, 280_000.0),
    "only_7418":             (1_000_000.0, 0.0,      12_000.0, 212_000.0, 200_000.0),
}


def _assemble(name: str) -> Dict[str, Any]:
    _tb, _shaped, assembled = N.PACK.assemble_parsed_tb(BOOKS[name]())
    return assembled


def check(name: str, pl: Dict[str, Any], env: Any = None,
          statements: Any = None, line_items: Any = None) -> List[str]:
    problems: List[str] = []
    filed_rd01, placed, ooi, ebitda, adjusted = EXPECTED[name]

    def near(a: Any, b: float) -> bool:
        return isinstance(a, (int, float)) and abs(a - b) < 0.005

    td = pl.get("turnover_definition") or {}
    for label, got, want in (
            ("turnover = F20 rd. 01", pl.get("turnover"), filed_rd01),
            ("revenue (the same figure)", pl.get("revenue"), filed_rd01),
            ("7411 placed inside turnover", td.get("placed_extra"), placed),
            ("other operating income (7418 stays)", pl.get("other_operating_income"), ooi),
            ("EBITDA (the placement does not move it)", pl.get("ebitda"), ebitda),
            ("adjusted EBITDA (7411 no longer stripped)", pl.get("adjusted_ebitda"), adjusted),
    ):
        if not near(got, want):
            problems.append("%s: %s served %r, expected %.2f" % (name, label, got, want))
    if td.get("accounts") != pld.turnover_accounts_label():
        problems.append("%s: the turnover accounts are not the pack's (%r)" % (name, td.get("accounts")))
    lines = dict((l.get("key"), l) for l in ((pl.get("ebitda_reconciliation") or {}).get("lines") or []))
    if (lines.get("turnover") or {}).get("accounts") != pld.turnover_accounts_label():
        problems.append("%s: the chain's turnover line does not name 7411" % name)
    if env is not None:
        meth = (env or {}).get("methodology") or {}
        rev_net = (meth.get("totals") or {}).get("revenue_net")
        if not (isinstance(rev_net, (int, float)) and abs(rev_net - filed_rd01) < 1.0):
            problems.append("%s: methodology totals.revenue_net %r ≠ turnover %.2f"
                            % (name, rev_net, filed_rd01))
        gw = FactsGateway.from_envelope(env)
        try:
            got = gw.revenue().amount_minor / 100.0 if gw is not None else None
        except Exception as exc:  # noqa: BLE001 — reported
            got = "raised %s" % type(exc).__name__
        if not near(got, filed_rd01):
            problems.append("%s: FactsGateway.revenue() %r ≠ turnover %.2f" % (name, got, filed_rd01))
    if statements is not None:
        rows = dict((m["name"], m["value"]) for m in credit_model.compute_period_metrics(statements))
        margin = rows.get("ebitda_margin")
        want = ebitda / filed_rd01 * 100.0
        if not (isinstance(margin, (int, float)) and (abs(margin - want) < 0.01
                                                        or abs(margin * 100.0 - want) < 0.01)):
            problems.append("%s: the EBITDA margin %r does not divide the turnover that holds 7411 "
                            "(%.4f %%)" % (name, margin, want))
    if line_items is not None:
        feeds = [li for li in line_items if li.get("statement") == "PL" and li.get("bucket") == "revenue"]
        total = sum(float(li.get("amount") or 0) for li in feeds)
        if not near(total, filed_rd01):
            problems.append("%s: the turnover line's leaves sum to %.2f, not %.2f" % (name, total, filed_rd01))
        codes = [str(li.get("ro_account_code")) for li in feeds]
        if placed and not any(c.startswith("7411") for c in codes):
            problems.append("%s: no 7411 leaf is persisted under turnover" % name)
        if any(c.startswith("7418") for c in codes):
            problems.append("%s: a 7418 leaf is persisted under turnover" % name)
    return problems


@pytest.mark.parametrize("name", sorted(BOOKS))
def test_the_ruling_on_each_constructed_book(name):
    assembled = _assemble(name)
    problems = check(name, assembled["statements"]["assembled_pl"],
                     assembled.get("assembled_canonical_v1"), assembled["statements"],
                     assembled.get("lineItems"))
    assert not problems, "\n".join(problems)
    # The leaf keeps what it was classified as beside its placement.
    placed = [li for li in assembled["lineItems"] if li.get("placement") == "turnover"]
    assert all(li.get("classified_bucket") == "otherIncome" for li in placed), placed
    assert len(placed) == {"subsidy_7411": 1, "subsidy_7411_analytic": 2, "only_7418": 0}[name]
    WORK["books"].append(name)
    WORK["units"] += 14


def _persisted(name: str) -> types.SimpleNamespace:
    saved = N.BOOKS.get(name)
    N.BOOKS[name] = BOOKS[name]
    try:
        return N._persisted(name)
    finally:
        if saved is None:
            N.BOOKS.pop(name, None)
        else:
            N.BOOKS[name] = saved


def _served(bk) -> Dict[str, Any]:
    mp = MonkeyPatch()
    try:
        with ANCHOR._routed(bk, mp) as (client, _db):
            resp = client.get("/api/period/%s" % bk.period_id,
                              headers={"Authorization": "Bearer test"})
    finally:
        mp.undo()
    assert resp.status_code == 200, resp.text[:400]
    return resp.json()


@pytest.mark.parametrize("name", ["subsidy_7411", "subsidy_7411_analytic"])
def test_the_real_write_path_and_every_served_seam(name):
    bk = _persisted(name)
    # The persisted leaves: 7411 under turnover, 7418 under other income.
    problems = check(name, bk.write_pl, bk.period["assembled_canonical_v1"], None, bk.line_items)
    assert not problems, "stage_persist:\n" + "\n".join(problems)
    body = _served(bk)
    problems = check(name, body["statements"]["assembled_pl"], None, body["statements"],
                     body.get("line_items"))
    assert not problems, "GET /api/period:\n" + "\n".join(problems)
    rebuilt = P._rebuild_assembled_for_briefing(bk.line_items, bk.period, bk.org)
    problems = check(name, rebuilt["statements"]["assembled_pl"], rebuilt.get("assembled_canonical_v1"))
    assert not problems, "briefing rebuild:\n" + "\n".join(problems)
    WORK["routes"].append(name)
    WORK["units"] += 10


# ── Plants ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("plant,book", [
    ("7411-left-in-other-income", "subsidy_7411"),
    ("7418-pulled-into-turnover", "only_7418"),
])
def test_plant_is_caught(plant, book, monkeypatch):
    real = pld.definition()
    planted = copy.deepcopy(real)
    planted["turnover"]["extra_prefixes"] = ("9999",) if plant == "7411-left-in-other-income" else ("741",)
    monkeypatch.setattr(pld, "definition", lambda: planted)
    assembled = _assemble(book)
    problems = check(book, assembled["statements"]["assembled_pl"],
                     assembled.get("assembled_canonical_v1"), None, assembled.get("lineItems"))
    assert problems, "PLANT %s on %s went unnoticed — the checker is blind" % (plant, book)
    WORK["plants"].append(plant)
    WORK["units"] += 1


def test_plant_a_rebuild_that_drops_the_placement(monkeypatch):
    """A rebuild that reads the stored 7411 leaf back as the other income it
    was classified as (the placement lost at the seam) reds on the route."""
    bk = _persisted("subsidy_7411")
    monkeypatch.setattr(pld, "is_turnover_placement", lambda code, line: False)
    body = _served(bk)
    assert check("subsidy_7411", body["statements"]["assembled_pl"]), (
        "PLANT rebuild-drops-the-placement went unnoticed")
    WORK["plants"].append("rebuild-drops-the-placement")
    WORK["units"] += 1


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE turnover-7411 (owner ruling R3 2026-09-28, F20 rd. 05, packs/ro/pl_definition.yaml): "
              "%d constructed witnesses (no real book posts 7411), %d through the real write path and "
              "GET /api/period, %d plants" % (len(WORK["books"]), len(WORK["routes"]), len(WORK["plants"])))
        print("TURNOVER7411-BOOKS: %s" % ", ".join(sorted(WORK["books"])))
        print("TURNOVER7411-PLANTS: %s" % ", ".join(WORK["plants"]))
        print("GATE-WORK turnover-7411 units=%d" % WORK["units"])
    assert len(WORK["books"]) == len(BOOKS)
    assert len(WORK["plants"]) == 3
