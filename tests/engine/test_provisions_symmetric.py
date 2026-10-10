"""GATE provisions-symmetric — provisions are never inside EBITDA, on either
side, and the operating result does not move.

THE RULING (owner, 2026-09-28, R2): "exclude both charges (6812/6814) and
reversals (7812/7814) from EBITDA; show net provisions as its own
reconciliation line." Before it the engine added the charges back with D&A
while the reversals sat inside EBITDA as other operating income — Scandia
Food FY2025 carried 8,415,275.41 of 7814 reversals inside its EBITDA while
2,042,470.24 of 6814 charges were outside it. The account lists are the P&L
definition pack's (packs/ro/pl_definition.yaml); every other 68x / 78x
account (6811, 6813, 7813, 7815, …) stays where it was — not ruled.

WHAT THIS GATE HOLDS, on CONSTRUCTED synthetic books (no client data), each
through the offline composition AND the real write path, GET /api/period
and the briefing rebuild:

  prov_both            charges and reversals, a net RELEASE; the unruled
                       6813 stays in D&A and the unruled 7813 in EBITDA
  prov_charges_only    a net charge; EBITDA as before the ruling
  prov_reversals_only  the Scandia shape: a reversal and nothing else
  prov_code_forms      "6812.01", "681401", "7812.04", "781401" — the
                       classification pack's startswith convention
  no_provisions        the block is served with zeros, nothing moves

and on each, against figures computed by hand from the rows:
  · EBITDA holds neither side: the served EBITDA is the pre-ruling figure
    less the ruled reversals, and other operating income is the bucket
    without them;
  · D&A is the depreciation bucket without the ruled charges;
  · net provisions = charges − reversals, per account, signed as a charge;
  · EBIT UNCHANGED — the pre-ruling operating result to the cent — and
    EBIT = EBITDA − D&A − net provisions on the served figures;
  · the reconciliation chain carries the line (EBITDA + D&A line + net
    provisions line = operating result) and the one-line bridge carries it
    after EBITDA; the line's name and accounts are the pack's;
  · core and adjusted EBITDA are the pre-ruling figures (no reversal is
    stripped twice), the methodology's `reported` / `strict` / operating
    result equal the in-code EBITDA / adjusted / EBIT, and the credit
    model's EBITDA and operating-profit rows read the same figures.

WHAT IT REDS ON, with the rule in place (TC-11): a reversal back inside
EBITDA, a charge back inside D&A, an operating result that forgets the
net-provisions line, a rebuild seam that loses the placement, a
methodology operating result that subtracts a reversal. In-file plants
(PROVISIONS-PLANTS) prove each checker fails; the source-edit plant log is
in docs/engine_book/gates.md "provisions-symmetric".
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
from engine.country_packs.ro_romania import chart_of_accounts as coa
from engine.country_packs.ro_romania import pl_definition as pld
from engine.ratios import credit_model

WORK: Dict[str, Any] = {"units": 0, "books": [], "routes": [], "plants": []}

_row = N._row


def _closed(code: str, name: str, amount: float) -> Dict[str, Any]:
    """A closed class-6/7 leaf: cumulative debit = credit, closing 0."""
    return _row(code, name, st_d=amount, st_c=amount)


# The manufacturer of the net-711 gate (revenue 1,000,000; materials
# 600,000; salaries 200,000; 6811 50,000; tax 30,000; 711 bridge +50,000)
# with the provision rows each book adds. Account 121 closes to the full
# result, so the bridge measures 711 at +50,000 on every book.
def _book(extra: List[Dict[str, Any]], result_121: float) -> List[Dict[str, Any]]:
    return N._closed_pl(extra=extra) + N._bs(result_121)


def book_prov_both() -> List[Dict[str, Any]]:
    return _book([
        _closed("6812", "Cheltuieli de exploatare privind provizioanele", 20_000.0),
        _closed("6814", "Cheltuieli privind ajustarile pentru deprecierea activelor circulante", 15_000.0),
        _closed("6813", "Cheltuieli privind ajustarile pentru deprecierea imobilizarilor", 2_000.0),
        _closed("7812", "Venituri din provizioane", 5_000.0),
        _closed("7814", "Venituri din ajustari pentru deprecierea activelor circulante", 40_000.0),
        _closed("7813", "Venituri din ajustari pentru deprecierea imobilizarilor", 3_000.0),
    ], 181_000.0)


def book_prov_charges_only() -> List[Dict[str, Any]]:
    return _book([_closed("6814", "Cheltuieli privind ajustarile pentru deprecierea activelor circulante",
                          25_000.0)], 145_000.0)


def book_prov_reversals_only() -> List[Dict[str, Any]]:
    return _book([_closed("7814", "Venituri din ajustari pentru deprecierea activelor circulante",
                          60_000.0)], 230_000.0)


def book_prov_code_forms() -> List[Dict[str, Any]]:
    return _book([
        _closed("6812.01", "Provizioane litigii", 8_000.0),
        _closed("681401", "Ajustari clienti incerti", 12_000.0),
        _closed("7812.04", "Venituri din provizioane", 1_500.0),
        _closed("781401", "Venituri din ajustari clienti", 30_000.0),
    ], 181_500.0)


def book_no_provisions() -> List[Dict[str, Any]]:
    return _book([], 170_000.0)


BOOKS = {
    "prov_both": book_prov_both,
    "prov_charges_only": book_prov_charges_only,
    "prov_reversals_only": book_prov_reversals_only,
    "prov_code_forms": book_prov_code_forms,
    "no_provisions": book_no_provisions,
}

#: By hand from the rows. EBIT_before is the PRE-RULING operating result
#: (revenue − materials − salaries + every 78x − every 68x + net 711);
#: the served EBIT must equal it to the cent.
#: (ebitda, ebit, D&A, net provisions, charges, reversals, other operating income)
EXPECTED = {
    #                     EBITDA      EBIT        D&A        net prov   charges   reversals  OOI
    "prov_both":          (253_000.0, 211_000.0,  52_000.0, -10_000.0, 35_000.0, 45_000.0, 3_000.0),
    "prov_charges_only":  (250_000.0, 175_000.0,  50_000.0,  25_000.0, 25_000.0,      0.0, 0.0),
    "prov_reversals_only": (250_000.0, 260_000.0, 50_000.0, -60_000.0,      0.0, 60_000.0, 0.0),
    "prov_code_forms":    (250_000.0, 211_500.0,  50_000.0, -11_500.0, 20_000.0, 31_500.0, 0.0),
    "no_provisions":      (250_000.0, 200_000.0,  50_000.0,       0.0,      0.0,      0.0, 0.0),
}
#: The pre-ruling EBITDA (the ruled reversals inside it) — what the served
#: figure moved FROM; core / adjusted EBITDA are unchanged by the ruling.
PRE_RULING_EBITDA = {"prov_both": 298_000.0, "prov_charges_only": 250_000.0,
                     "prov_reversals_only": 310_000.0, "prov_code_forms": 281_500.0,
                     "no_provisions": 250_000.0}


def _assemble(name: str) -> Dict[str, Any]:
    _tb, _shaped, assembled = N.PACK.assemble_parsed_tb(BOOKS[name]())
    return assembled


# ── The checker (the plants below prove it can fail) ────────────────────


def check(name: str, pl: Dict[str, Any], methodology: Any = None,
          statements: Any = None) -> List[str]:
    problems: List[str] = []
    ebitda, ebit, dna, net, charges, reversals, ooi = EXPECTED[name]

    def near(a: Any, b: float) -> bool:
        return isinstance(a, (int, float)) and abs(a - b) < 0.005

    np_ = pl.get("net_provisions") or {}
    for label, got, want in (
            ("EBITDA", pl.get("ebitda"), ebitda),
            ("EBIT (unchanged by the ruling)", pl.get("ebit"), ebit),
            ("operating_result", pl.get("operating_result"), ebit),
            ("D&A without the ruled charges", pl.get("depreciation"), dna),
            ("net provisions", np_.get("value"), net),
            ("charges", (np_.get("charges") or {}).get("value"), charges),
            ("reversals", (np_.get("reversals") or {}).get("value"), reversals),
            ("other operating income without the ruled reversals", pl.get("other_operating_income"), ooi),
            # Core EBITDA is the PRE-RULING core (pre-ruling EBITDA − 758 −
            # every 781 reversal): no reversal stripped twice.
            ("core EBITDA (pre-ruling)", pl.get("core_ebitda"),
             PRE_RULING_EBITDA[name] - _all_78x(name)),
    ):
        if not near(got, want):
            problems.append("%s: %s served %r, expected %.2f" % (name, label, got, want))
    # The identity on the SERVED figures.
    if all(isinstance(pl.get(k), (int, float)) for k in ("ebitda", "ebit", "depreciation")) \
            and isinstance(np_.get("value"), (int, float)):
        if abs(pl["ebitda"] - pl["depreciation"] - np_["value"] - pl["ebit"]) >= 0.005:
            problems.append("%s: EBITDA − D&A − net provisions ≠ EBIT" % name)
    # The line is the pack's: its name and its accounts.
    lab = pld.net_provisions_label()
    if np_.get("label_ro") != lab["ro"] or np_.get("accounts") != lab["accounts"]:
        problems.append("%s: the net-provisions line is not the pack's (%r)" % (name, np_.get("label_ro")))
    # The reconciliation chain and the one-line bridge carry it.
    recon = pl.get("ebitda_reconciliation") or {}
    lines = dict((l.get("key"), l) for l in recon.get("lines") or [])
    npl = lines.get("net_provisions") or {}
    if not near(npl.get("value"), -net):
        problems.append("%s: the chain's net-provisions line is %r, expected %.2f"
                        % (name, npl.get("value"), -net))
    if npl.get("label_ro") != lab["ro"]:
        problems.append("%s: the chain's net-provisions line is not named by the pack" % name)
    try:
        chain = lines["ebitda"]["value"] + lines["depreciation"]["value"] + npl["value"]
        if abs(chain - lines["operating_result"]["value"]) >= 0.005:
            problems.append("%s: EBITDA + D&A line + net provisions line ≠ operating result "
                            "on the chain" % name)
    except (KeyError, TypeError):
        problems.append("%s: the chain misses a line between EBITDA and the operating result" % name)
    after = (recon.get("bridge") or {}).get("after_ebitda") or []
    if not after or after[0].get("key") != "net_provisions" or not near(after[0].get("value"), -net):
        problems.append("%s: the one-line bridge does not carry net provisions after EBITDA" % name)
    # Adjusted EBITDA strips every 78x reversal exactly once: pre-ruling.
    if not near(pl.get("adjusted_ebitda"), PRE_RULING_EBITDA[name] - _all_78x(name)):
        problems.append("%s: adjusted EBITDA %r moved (a reversal stripped twice or not at all)"
                        % (name, pl.get("adjusted_ebitda")))
    if methodology is not None:
        eb = methodology.get("ebitda") or {}
        tot = methodology.get("totals") or {}
        for label, got, want in (("methodology ebitda.reported", eb.get("reported"), pl.get("ebitda")),
                                 ("methodology ebitda.strict", eb.get("strict"), pl.get("adjusted_ebitda")),
                                 ("methodology operating result", tot.get("operating_profit_reported"),
                                  pl.get("ebit"))):
            if not (isinstance(got, (int, float)) and isinstance(want, (int, float))
                    and abs(got - want) < 1.0):
                problems.append("%s: %s %r ≠ in-code %r" % (name, label, got, want))
    if statements is not None:
        rows = dict((m["name"], m["value"]) for m in credit_model.compute_period_metrics(statements))
        for label, got, want in (("credit-model ebitda row", rows.get("ebitda"), ebitda),
                                 ("credit-model operating_profit row", rows.get("operating_profit"), ebit)):
            if not near(got, want):
                problems.append("%s: %s %r, expected %.2f" % (name, label, got, want))
    return problems


def _all_78x(name: str) -> float:
    """Every 781 reversal the book posted (ruled and unruled) — no book here
    posts 758 or a 74x / 75x / 77x line, so this is the pre-ruling strip."""
    return {"prov_both": 48_000.0, "prov_charges_only": 0.0, "prov_reversals_only": 60_000.0,
            "prov_code_forms": 31_500.0, "no_provisions": 0.0}[name]


# ── 1. The offline composition ──────────────────────────────────────────


@pytest.mark.parametrize("name", sorted(BOOKS))
def test_the_ruling_on_each_constructed_book(name):
    assembled = _assemble(name)
    pl = assembled["statements"]["assembled_pl"]
    meth = (assembled.get("assembled_canonical_v1") or {}).get("methodology")
    problems = check(name, pl, meth, assembled["statements"])
    assert not problems, "\n".join(problems)
    # net 711 is the bridge's +50,000 on every book (the anchor holds).
    assert pl["inventory_variation"]["value"] == pytest.approx(50_000.0, abs=0.005)
    # The per-account split names the accounts the book posted.
    np_ = pl["net_provisions"]
    if name == "prov_code_forms":
        assert sorted(np_["charges"]["by_account"]) == ["6812.01", "681401"]
        assert sorted(np_["reversals"]["by_account"]) == ["7812.04", "781401"]
    WORK["books"].append(name)
    WORK["units"] += 16


def test_the_unruled_accounts_stay_where_they_were():
    """6813 stays in D&A, 7813 inside EBITDA (other operating income): the
    ruling names 6812 / 6814 / 7812 / 7814 and nothing else."""
    pl = _assemble("prov_both")["statements"]["assembled_pl"]
    assert "6813" not in pl["net_provisions"]["charges"]["by_account"]
    assert "7813" not in pl["net_provisions"]["reversals"]["by_account"]
    assert pl["depreciation"] == pytest.approx(52_000.0, abs=0.005)   # 6811 + 6813
    assert pl["other_operating_income"] == pytest.approx(3_000.0, abs=0.005)  # 7813
    assert pl["other_income_781_reversals"] == pytest.approx(3_000.0, abs=0.005)
    WORK["units"] += 5


# ── 2. The real write path and the served seams ─────────────────────────


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
    return resp.json()["statements"]


@pytest.mark.parametrize("name", ["prov_both", "prov_code_forms", "no_provisions"])
def test_every_served_seam_carries_the_ruling(name):
    bk = _persisted(name)
    served = _served(bk)
    problems = check(name, served["assembled_pl"], None, served)
    assert not problems, "GET /api/period:\n" + "\n".join(problems)
    rebuilt = P._rebuild_assembled_for_briefing(bk.line_items, bk.period, bk.org)
    problems = check(name, rebuilt["statements"]["assembled_pl"],
                     (rebuilt.get("assembled_canonical_v1") or {}).get("methodology"))
    assert not problems, "briefing rebuild:\n" + "\n".join(problems)
    # The persisted leaves keep their classification: a charge is a
    # depreciation leaf, a reversal an other-income leaf — the placement is
    # the assembly's, the rows are not rewritten.
    by_code = dict((str(li["ro_account_code"]), li["bucket"]) for li in bk.line_items
                   if li.get("statement") == "PL")
    for code, bucket in by_code.items():
        if pld.matches(code, pld.provision_charge_prefixes()):
            assert bucket == "depreciation", (code, bucket)
        if pld.matches(code, pld.provision_reversal_prefixes()):
            assert bucket == "otherIncome", (code, bucket)
    WORK["routes"].append(name)
    WORK["units"] += 8


def test_the_definition_stamp_moved():
    """Every served block names the definition it is on; a methodology
    block stamped with the previous revision is not the current one."""
    pl = _assemble("prov_both")["statements"]["assembled_pl"]
    assert pl["ebitda_definition"] == coa.EBITDA_DEFINITION_REVISION
    assert pl["ebitda_definition"] not in coa.EBITDA_DEFINITION_PREVIOUS_REVISIONS
    assert "provisions-6812-6814-7812-7814-outside" in coa.EBITDA_DEFINITION_REVISION
    WORK["units"] += 3


# ── 3. Plants: the checker must fail on each defect ─────────────────────


def _plant_definition(monkeypatch, side: str) -> None:
    real = pld.definition()
    planted = copy.deepcopy(real)
    planted["provisions"][side] = ("9999",)
    monkeypatch.setattr(pld, "definition", lambda: planted)


def _plant_ebit_forgets(monkeypatch) -> None:
    original = coa.assemble_statements

    def planted(*a, **kw):
        out = original(*a, **kw)
        pl = out["statements"]["assembled_pl"]
        if isinstance(pl.get("ebitda"), (int, float)):
            pl["ebit"] = pl["operating_result"] = round(pl["ebitda"] - pl["depreciation"], 2)
        return out

    monkeypatch.setattr(coa, "assemble_statements", planted)


def _plant_methodology_subtracts_reversals(monkeypatch) -> None:
    from engine import methodology as M
    original = M.evaluate

    def planted(doc, env, **kw):
        out = original(doc, env, **kw)
        dap = ((env.get("aggregates") or {}).get("dap") or {}).get("net") or 0.0
        if isinstance((out.get("ebitda") or {}).get("reported"), (int, float)):
            out["totals"]["operating_profit_reported"] = out["ebitda"]["reported"] - dap
        return out

    monkeypatch.setattr(M, "evaluate", planted)


@pytest.mark.parametrize("plant,book", [
    ("reversals-back-inside-ebitda", "prov_reversals_only"),
    ("charges-back-inside-da", "prov_charges_only"),
    ("ebit-forgets-net-provisions", "prov_both"),
    ("methodology-subtracts-reversals", "prov_both"),
])
def test_plant_is_caught(plant, book, monkeypatch):
    if plant == "reversals-back-inside-ebitda":
        _plant_definition(monkeypatch, "reversals")
    elif plant == "charges-back-inside-da":
        _plant_definition(monkeypatch, "charges")
    elif plant == "ebit-forgets-net-provisions":
        _plant_ebit_forgets(monkeypatch)
    else:
        _plant_methodology_subtracts_reversals(monkeypatch)
    assembled = _assemble(book)
    problems = check(book, assembled["statements"]["assembled_pl"],
                     (assembled.get("assembled_canonical_v1") or {}).get("methodology"))
    assert problems, "PLANT %s on %s went unnoticed — the checker is blind" % (plant, book)
    WORK["plants"].append(plant)
    WORK["units"] += 1


def test_plant_a_rebuild_that_loses_the_ruling(monkeypatch):
    """The served route rebuilt with the reversals back inside EBITDA (a
    seam that assembled on another definition) reds on GET /api/period."""
    bk = _persisted("prov_both")
    _plant_definition(monkeypatch, "reversals")
    served = _served(bk)
    assert check("prov_both", served["assembled_pl"]), (
        "PLANT rebuild-loses-the-ruling went unnoticed")
    WORK["plants"].append("rebuild-loses-the-ruling")
    WORK["units"] += 1


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE provisions-symmetric (owner ruling R2 2026-09-28, packs/ro/pl_definition.yaml): "
              "%d constructed books, %d through the real write path and GET /api/period, "
              "%d plants" % (len(WORK["books"]), len(WORK["routes"]), len(WORK["plants"])))
        print("PROVISIONS-BOOKS: %s" % ", ".join(sorted(WORK["books"])))
        print("PROVISIONS-PLANTS: %s" % ", ".join(WORK["plants"]))
        print("GATE-WORK provisions-symmetric units=%d" % WORK["units"])
    assert len(WORK["books"]) == len(BOOKS)
    assert len(WORK["plants"]) == 5
