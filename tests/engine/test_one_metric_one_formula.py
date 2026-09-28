"""ONE METRIC NAME, ONE FORMULA — dio, dpo, ccc and inventory_turnover
across every engine surface (owner spec 2026-09-26, inventory days point 4; design B4).

Scandia Food FY2025 printed 48.8 (Benchmark), 52.5 (Ratios card) and 95.3
(Forecast) inventory days for ONE stock, and a DPO of 52.6 days on the card
beside 82.6 in the trade-float insight. Every surface now reads ONE
authority: inventory days from the served block
(`engine.ratios.inventory_days`), DPO from `engine.ratios.table.dpo_days`,
the cycle as DSO + the split on the period-end balance − DPO.

WHAT THIS REDS ON, AFTER THE REPAIR (TC-11), on the four corpus books
served by the REAL app (GET /api/period through create_app over the tenancy
double, the metric rows the pipeline persists seeded):

  · the ratio table's dio / inventory_turnover not the block's total /
    turnover; its ccc not DSO + the block's period-end total − DPO;
  · the block's printed days (`value_q`, `closing_value_q`, every leg and
    the total) not the ratio table's days quantization, or the dio row's
    printed figure not the block's total printed figure (one string for one
    figure on the tile, the split, the report, the bank export, the
    command bar);
  · the served metric rows (dio, ccc, inventory_turnover) or
    `assembled_metrics.ratios.efficiency` carrying another figure;
  · the forecast's DIO driver not the block's period-end total (to the
    micro-day), or its flow not the block's flow;
  · the insights trade-float DPO, or the ratio table's DPO, not
    `dpo_days` (a second denominator — cost of goods sold — reds here);
  · ONE DAY COUNT (added 2026-09-27): on a leap year (2024, 366 days) and
    on year-to-date books (1 January – 30 June, 181 days) served by the
    same app, the ratio table's dso / dpo / ccc, the served metric rows
    (persisted at write time on 365, replaced at serve), the efficiency
    block, `dpo_days` and the trade-float insight's DSO and DPO not the
    figure recomputed HERE from the statements' operands on the served
    `supplementary.periodDays` — the cycle recomputed as DSO + the block's
    period-end total − DPO from operands, never from the table's own rows
    (the old law was green by construction off 365 days: the table's DPO
    was × 365 while DSO, the split and the insight were × the period's days);
  · the trade-float insight printing a DPO its printed operands do not
    reproduce: balance-sheet payables ÷ total operating expense × the
    period's day count, as printed in its measures and in its claim;
  · the forecast's DIO lever on a non-365 period not the block's
    period-end total restated on the plan's 365-day year (closing × 365 ÷
    period days), or its sentence not printing the analysis figure
    (`closing_value_q`), the period's day count and the plan's 365-day year
    beside it, or its label not naming the plan year;
  · the served methodology block carrying a DIO / DPO / CCC / inventory
    turnover view of its own;
  · the radar's parked velocity naming a cycle dio or dpo;
  · the sector row not keyed `inventory_days_on_turnover`, or its RO/EN
    label not the owner's filed-basis label;
  · a Python source under src/engine that computes inventory x 365 (or
    divides inventory by a flow) outside the declared authorities:
    engine.ratios.inventory_days (the split), benchmarks_ro / public_ro (the
    FILED basis, labelled), and the SKU layer's per-SKU days (sales upload);
  · a TypeScript source under frontend/ (tests excluded) that does the same
    — `div(B("inventory"), …)`, `inventory / flow`, `… × 365` over a stock
    identifier — outside the two namespaced measures, each under its own
    key and label: the listed company's reported basis
    (lib/publicInventoryDays.ts, "Zile stoc — bază raportată") and the
    sales file's SKU turnover days (pages/cfo/Products.tsx, "Zile de
    rotație SKU").

  · THE COCKPIT BANK EXPORT (POST /api/forecast/{id}/cockpit/export through
    create_app, every corpus book): `document.inventory_days` not the base
    period's served block byte for byte; the DIO lever not the block's
    period-end total; any text naming DPO without the one DPO's
    denominator (total operating expense), or stating inventory days with
    a formula off the split;
  · a forecast label (cockpit pack, driver pack, the three i18n labels, EN
    and RO) naming the cost-of-sales payables driver "DPO";
  · the methodology FILE declaring a view that divides the stock or the
    trade payables by a flow (or back under a retired name).

Planted (transcripts in docs/engine_book/gates.md "one-metric-one-formula";
the day-count plants of 2026-09-27: the ratio table's dpo back on the
metric row first, the credit model's dpo back on × 365, the trade-float
DSO back on × 365, the trade float's DPO operand back off its measures, the
lever's restated sentence removed):
a second denominator in the credit model's dio row; the trade-float DPO
back on cost of goods sold; a methodology DIO view restored; the browser's
computeRatios DIO back on inventory ÷ total operating expense; the
forecast's payables lever named DPO again; the bank export's block taken
from the wrong statements.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from engine.ratios import inventory_days as ID  # noqa: E402
from engine.ratios import table as _table  # noqa: E402
from engine.ratios.table import dpo_days  # noqa: E402

BOOKS = ("agras", "carniprod", "realestate", "retail")
#: The same corpus books served on periods that are NOT 365 days: a leap
#: year and two year-to-date books (1 January – 30 June). Every FY2024
#: period is 366 days and every year-to-date month counts its own days.
DAY_VARIANTS = {"agras-366": ("agras", "2024-01-01", "2024-12-31"),
                "agras-181": ("agras", "2025-01-01", "2025-06-30"),
                "retail-181": ("retail", "2025-01-01", "2025-06-30")}
ALL_SERVED = BOOKS + tuple(DAY_VARIANTS)
WORK = {"units": 0}
_TOL = 5e-5  # the metric rows' stored rounding (4 decimals)


@pytest.fixture(scope="module")
def served() -> Dict[str, Dict[str, Any]]:
    """GET /api/period for the four corpus books through the real app, each
    seeded with the metric rows the pipeline persists for it."""
    import _real_app_comparatives as RA
    import firm_postgrest_double as D
    from fastapi.testclient import TestClient

    user = "00000000-0000-4000-8000-000000000001"
    org = "00000000-0000-4000-8000-00000000c0c9"
    from engine.ratios.credit_model import compute_period_metrics

    periods = []
    persisted = {}
    for book in BOOKS:
        bk = RA.book_from_workbook(REPO / "corpus" / ("saga_10_col_%s" % book) / "input.xlsx",
                                   period_end="2025-12-31", key=book)
        periods.append((bk, book, org, "2025-01-01", "2025-12-31"))
    for key, (book, start, end) in DAY_VARIANTS.items():
        bk = RA.book_from_workbook(REPO / "corpus" / ("saga_10_col_%s" % book) / "input.xlsx",
                                   period_end=end, key=key)
        periods.append((bk, key, org, start, end))
        # The rows stage_compute PERSISTS for this period: the write-time
        # statements, which carry no `supplementary` — the metric rows a
        # served response must replace, not echo.
        persisted[key] = compute_period_metrics(bk.persist_assembled["statements"])
    double = RA.seed_double(orgs=[{"id": org, "name": "Corpus", "default_currency": "RON"}],
                            memberships=[{"user_id": user, "org_id": org, "role": "owner",
                                          "created_at": "2026-01-01T00:00:00+00:00"}],
                            periods=periods)
    app = RA.build_app()
    out = {}
    with RA.installed(double):
        bearer = D.mint_jwt(user, "owner@local.invalid")
        RA.seed_metrics(app, double, list(BOOKS), org, bearer)
        mcols = set(double.columns["calculated_metrics"])
        for key, rows in persisted.items():
            for m in rows:
                double.add("calculated_metrics", {k: v for k, v in dict(m, period_id=key, org_id=org).items()
                                                  if k in mcols})
        client = TestClient(app, raise_server_exceptions=False)
        headers = {"Authorization": "Bearer " + bearer, "X-Org-Id": org}
        for book in ALL_SERVED:
            resp = client.get("/api/period/%s" % book, headers=headers)
            assert resp.status_code == 200, (book, resp.status_code)
            out[book] = resp.json()
    return out


def _rows(body: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {r["key"]: r for r in body["assembled_metrics"]["ratio_table"]["rows"]}


def _metric(body: Dict[str, Any], name: str) -> Any:
    for m in body.get("metrics") or []:
        if m.get("name") == name:
            return m.get("value")
    return "absent"


@pytest.mark.parametrize("book", BOOKS)
def test_every_inventory_days_surface_is_the_served_block(served, book):
    body = served[book]
    block = body["assembled_metrics"]["inventory_days"]
    assert block and block["schema"] == ID.SCHEMA, book
    total = block["total"]
    rows = _rows(body)
    eff = body["assembled_metrics"]["ratios"]["efficiency"]
    # ONE QUANTIZATION: the block's printed days are the ratio table's
    # printed days — the tile's headline, the split's total, the report, the
    # bank export and the command bar print one string (the block printed
    # "30.2" under a tile of "30" until 2026-09-27).
    assert rows["dio"]["value_q"] == total["value_q"], (book, rows["dio"]["value_q"], total["value_q"])
    for part in list(block["groups"]) + [total]:
        for field in ("value", "closing_value"):
            want_q = None if part[field] is None else _table.quantize_display(part[field], "days")
            assert part[field + "_q"] == want_q, (book, part.get("key", "total"), field, part[field + "_q"], want_q)
    WORK["units"] += 1
    for key, want in (("dio", total["value"]), ("inventory_turnover", block["inventory_turnover"]["value"])):
        assert rows[key]["value"] == want, (book, key, rows[key]["value"], want)
        if want is None:
            assert rows[key]["reason"]["code"] == "inventory_days_refused", (book, key)
        got = _metric(body, key)
        assert got == "absent" or (got is None) == (want is None), (book, key, got, want)
        if want is not None and got != "absent":
            assert abs(got - want) <= _TOL, (book, key, got, want)
        if want is not None:
            assert abs(eff[key] - want) <= _TOL, (book, key, eff[key], want)
        WORK["units"] += 1
    # The cycle: DSO + the split on the PERIOD-END balance − DPO.
    closing = total["closing_value"]
    if closing is None:
        assert rows["ccc"]["value"] is None, (book, rows["ccc"])
    else:
        want = rows["dso"]["value"] + closing - rows["dpo"]["value"]
        assert abs(rows["ccc"]["value"] - want) < 1e-9, (book, rows["ccc"]["value"], want)
        got = _metric(body, "ccc")
        if got != "absent":
            st = body["statements"]
            inc, bs = st["incomeStatement"], st["balanceSheet"]
            toe = inc["costOfGoodsSold"] + inc["operatingExpenses"] + inc["depreciationAmortization"]
            days = st["supplementary"]["periodDays"]
            want_m = bs["accountsReceivable"] * days / inc["revenue"] + closing - bs["accountsPayable"] * days / toe
            assert abs(got - want_m) <= _TOL, (book, got, want_m)
    WORK["units"] += 1


@pytest.mark.parametrize("book", ALL_SERVED)
def test_one_dpo_on_the_ratio_table_and_the_trade_float(served, book):
    body = served[book]
    st = body["statements"]
    want = dpo_days(st)["value"]
    assert abs(_rows(body)["dpo"]["value"] - want) <= _TOL, (book, _rows(body)["dpo"]["value"], want)
    trade = [i for i in (st.get("insights") or {}).get("insights") or [] if i["id"] == "trade_float"]
    assert trade, "%s: the served book carries no trade_float insight" % book
    dpo = [m for m in trade[0]["measures"] if m["key"] == "dpo"][0]
    assert dpo["value"] is not None and abs(dpo["value"] - want) < 1e-9, (book, dpo["value"], want)
    WORK["units"] += 2


def _operand_days(st: Dict[str, Any]) -> Dict[str, float]:
    """DSO, DPO and the cycle recomputed HERE from the served statements'
    operands on the served day count — never read from the table."""
    inc, bs = st["incomeStatement"], st["balanceSheet"]
    days = st["supplementary"]["periodDays"]
    toe = inc["costOfGoodsSold"] + inc["operatingExpenses"] + inc["depreciationAmortization"]
    dso = bs["accountsReceivable"] / inc["revenue"] * days
    dpo = bs["accountsPayable"] / toe * days
    closing = st["inventory_days"]["total"]["closing_value"]
    return {"days": days, "dso": dso, "dpo": dpo,
            "ccc": None if closing is None else dso + closing - dpo}


def _close(a: Any, b: Any, tol: float) -> bool:
    return a is not None and b is not None and abs(a - b) <= tol * max(1.0, abs(b))


@pytest.mark.parametrize("book", ALL_SERVED)
def test_dso_dpo_and_the_cycle_share_one_day_count(served, book):
    """The ratio table, the served metric rows, the efficiency block and the
    trade-float insight: DSO, DPO and the cycle on the served period's own
    day count, the cycle's three terms on ONE count."""
    body = served[book]
    st = body["statements"]
    days = st["supplementary"]["periodDays"]
    if book in DAY_VARIANTS:
        assert days != 365, (book, days)
        assert st["inventory_days"]["period_days"] == days, (book, st["inventory_days"]["period_days"])
    want = _operand_days(st)
    rows = _rows(body)
    eff = body["assembled_metrics"]["ratios"]["efficiency"]
    for key in ("dso", "dpo", "ccc"):
        if want[key] is None:  # the split refuses its period-end total: the cycle refuses
            assert rows[key]["value"] is None and _metric(body, key) in (None, "absent"), (book, key)
            WORK["units"] += 1
            continue
        assert _close(rows[key]["value"], want[key], 1e-9), (book, key, "ratio table", rows[key]["value"], want[key])
        assert _close(_metric(body, key), want[key], _TOL), (book, key, "metrics[]", _metric(body, key), want[key])
        assert _close(eff[key], want[key], _TOL), (book, key, "efficiency", eff[key], want[key])
        WORK["units"] += 1
    trade = [i for i in (st.get("insights") or {}).get("insights") or [] if i["id"] == "trade_float"][0]
    m = dict((x["key"], x["value"]) for x in trade["measures"])
    rev = st["incomeStatement"]["revenue"]
    assert _close(m["dso"], m["trade_receivables"] / rev * days, 1e-8), (book, m["dso"], days)
    assert _close(m["dpo"], want["dpo"], 1e-9), (book, m["dpo"], want["dpo"])
    WORK["units"] += 1


@pytest.mark.parametrize("book", ALL_SERVED)
def test_the_trade_float_prints_the_operands_its_days_divide(served, book):
    """Printed payables ÷ printed total operating expense × the printed day
    count = the printed DPO — in the measures AND in the claim's words
    (the owner's own FY2025 book printed its trade-payables row beside a
    DPO built on the larger balance-sheet payables)."""
    from engine.insights.measures import Measure, format_measure

    st = served[book]["statements"]
    trade = [i for i in (st.get("insights") or {}).get("insights") or [] if i["id"] == "trade_float"][0]
    ms = dict((x["key"], x) for x in trade["measures"])
    payables, toe, days, dpo = (ms[k]["value"] for k in ("dpo_payables", "total_operating_expense",
                                                          "period_days", "dpo"))
    assert payables == round(st["balanceSheet"]["accountsPayable"], 2), (book, payables)
    assert days == st["supplementary"]["periodDays"], (book, days)
    assert abs(payables / toe * days - dpo) < 1e-6, (book, payables, toe, days, dpo)
    claim = trade["claim"]
    for k in ("dpo", "dpo_payables", "total_operating_expense", "period_days", "dso"):
        x = ms[k]
        printed = format_measure(Measure(k, x["label"], x["value"], x["unit"], x.get("noun", ""),
                                         value_q=x.get("value_q")), "RON")
        assert printed in claim, (book, k, printed, claim)
    WORK["units"] += 1


#: THE ROUNDING NOTE — the frontend's `roundedDays.note` (en.json), the one
#: authority for its words; the trade float's `rounded` claim variant must
#: carry exactly this sentence.
def _rounded_note_en():
    bundle = json.loads((REPO / "frontend" / "i18n" / "locales" / "en.json").read_text("utf-8"))
    return bundle["roundedDays"]["note"]


def _check_trade_float_gap(trade, where):
    """THE GAP IS ITS OWN SERVED FIGURE (coordinator's ruling 2026-09-28,
    one figure per report): printed on the Ratios table's precision
    (`quantize_display(value, "days")`), never the difference of the printed
    DSO and DPO; where that difference is not the printed gap, the claim
    carries the one rounding note — and only then. Returns True when the
    printed figures part (the note is due)."""
    from decimal import Decimal

    from engine.ratios.table import quantize_display

    ms = dict((x["key"], x) for x in trade["measures"])
    gap = ms["float_days"]
    assert gap["value_q"] == quantize_display(gap["value"], "days"), (where, gap)
    claim = trade["claim"]
    unit = "day" if gap["value_q"].lstrip("+-") == "1" else "days"
    parts = Decimal(ms["dso"]["value_q"]) - Decimal(ms["dpo"]["value_q"]) != Decimal(gap["value_q"])
    note = _rounded_note_en()
    if parts:
        assert claim.endswith("a gap of %s %s (%s)." % (gap["value_q"], unit, note)), (where, claim)
    else:
        assert claim.endswith("a gap of %s %s." % (gap["value_q"], unit)), (where, claim)
        assert note not in claim, (where, claim)
    # The claim prints ONE gap: no second day figure after "a gap of".
    import re
    assert len(re.findall(r"a gap of", claim)) == 1, (where, claim)
    return parts


@pytest.mark.parametrize("book", ALL_SERVED)
def test_the_trade_float_prints_dso_and_dpo_as_the_ratios_table_prints_them(served, book):
    """ONE PRINTED STRING PER FIGURE (merge contract 2026-09-28): the
    trade-float insight printed "89.6 days of sales outstanding against 79.2
    days of payables" beside the Ratios table's "90 days" and "79 days". Its
    DSO and DPO carry the table's printed digits (`value_q`, the days rule)
    and the claim prints them verbatim; the GAP prints its own served figure
    on the same precision, with the rounding note only where the printed
    DSO − DPO parts from it (coordinator's ruling 2026-09-28)."""
    from engine.insights.measures import Measure, format_measure

    st = served[book]["statements"]
    trade = [i for i in (st.get("insights") or {}).get("insights") or [] if i["id"] == "trade_float"][0]
    ms = dict((x["key"], x) for x in trade["measures"])
    table = dict((r["key"], r) for r in served[book]["assembled_metrics"]["ratio_table"]["rows"])
    claim = trade["claim"]
    for key in ("dso", "dpo"):
        assert ms[key]["value_q"] == table[key]["value_q"], (book, key, ms[key], table[key]["value_q"])
        printed = format_measure(Measure(key, ms[key]["label"], ms[key]["value"], "days",
                                         value_q=ms[key]["value_q"]), "RON")
        # The table's EN form: "90 days" (a single day: "1 day").
        assert printed == "%s %s" % (table[key]["value_q"],
                                     "day" if table[key]["value_q"].lstrip("+-") == "1" else "days")
        assert printed in claim, (book, key, printed, claim)
        WORK["units"] += 1
    _check_trade_float_gap(trade, book)
    # No one-decimal day figure survives in the sentence.
    import re
    assert not re.search(r"\b\d+\.\d days?\b", claim), (book, claim)
    WORK["units"] += 1


def test_the_trade_float_gap_is_its_own_served_figure_with_the_rounding_note_where_the_printed_terms_part():
    """The witness the corpus books cannot give: on every one of them the
    rounded exact gap happens to equal the difference of the printed DSO and
    DPO. The Scandia G7 capture (e2e/fixtures/workspace_v2, the served body
    the hermetic dashboard reads) is the book where they part: the detector,
    re-run over its served statements, must print the gap as ITS OWN served
    figure on the table's precision (never the printed DSO minus the printed
    DPO — a second figure for one gap) and carry the rounding note; and
    reproduce the served claim byte for byte."""
    from decimal import Decimal

    from engine.insights import build_insights
    from engine.ratios.table import quantize_display

    body = json.loads((REPO / "e2e" / "fixtures" / "workspace_v2" / "scandia_fy2025.json")
                      .read_text("utf-8"))["period"]
    st = body["statements"]
    block = build_insights({"statements": st, "envelope": {"canonical_bs": st.get("canonical_bs")},
                            "line_items": body.get("line_items")})
    trade = [i for i in block["insights"] if i["id"] == "trade_float"][0]
    ms = dict((x["key"], x) for x in trade["measures"])
    printed_difference = Decimal(ms["dso"]["value_q"]) - Decimal(ms["dpo"]["value_q"])
    # POSITIVE CONTROL: rounding the exact gap gives ANOTHER figure here.
    assert Decimal(quantize_display(ms["float_days"]["value"], "days")) != printed_difference, ms
    assert _check_trade_float_gap(trade, "scandia G7") is True
    assert Decimal(ms["float_days"]["value_q"]) != printed_difference, ms
    served = [i for i in st["insights"]["insights"] if i["id"] == "trade_float"][0]
    assert trade["claim"] == served["claim"], (trade["claim"], served["claim"])
    assert _check_trade_float_gap(served, "scandia G7 (served)") is True
    WORK["units"] += 1


def test_the_trade_float_rounding_note_is_the_frontends_words():
    """ONE SPELLING of the note across the two runtimes: the pack's
    `rounded` variant is the default claim plus exactly the frontend's
    `roundedDays.note` (en.json) in parentheses — and the RO bundle carries
    the owner's Romanian sentence."""
    from engine.insights.packdata import load_pack

    spec = [d for d in load_pack().detectors if d.id == "trade_float"][0]
    assert spec.claim_variants["rounded"] == spec.claim[:-1] + " (%s)." % _rounded_note_en(), (
        spec.claim_variants["rounded"], spec.claim)
    ro = json.loads((REPO / "frontend" / "i18n" / "locales" / "ro.json").read_text("utf-8"))
    assert ro["roundedDays"]["note"] == "zile rotunjite — termenii rotunjiți pot diferi de total cu o zi"
    assert _rounded_note_en() == "rounded days — the rounded terms can differ from the total by a day"
    WORK["units"] += 1


@pytest.mark.parametrize("book", ("agras", "carniprod", "retail"))
def test_the_forecast_driver_is_the_split_on_the_period_end_balance(book):
    from engine.forecast.money import MICRO_DAY
    from engine.forecast.project import assumptions_for_payload

    payload = json.loads((HERE / "fixtures" / "firm" / ("saga_10_col_%s.json" % book)).read_text("utf-8"))
    block = payload["statements"]["inventory_days"]
    driver = assumptions_for_payload(payload)["dio_cogs_days"]
    assert driver.exact is not None, book
    assert abs(driver.exact / MICRO_DAY - block["total"]["closing_value"]) < 1e-4, (
        book, driver.exact / MICRO_DAY, block["total"]["closing_value"])
    assert "forecast.dio_split" in driver.basis, driver.basis
    WORK["units"] += 1


def test_no_second_formula_is_served_or_declared(served):
    retired = {"days_inventory_outstanding", "inventory_turnover",
               "days_payable_outstanding", "cash_conversion_cycle"}
    for book, body in served.items():
        ratios = (((body["statements"].get("assembled_canonical_v1") or {}).get("methodology") or {})
                  .get("ratios") or {})
        assert not retired & set(ratios), (book, sorted(retired & set(ratios)))
    from engine.api.findings import m_detect
    ids = {c[0] for c in m_detect.CYCLES}
    assert not ids & {"dio", "dpo", "ccc", "inventory_turnover"}, ids
    from engine.benchmarks_ro import sector
    assert "dio" not in sector.DIRECTION and "inventory_days_on_turnover" in sector.DIRECTION
    # The page's label carries THE pack's words (packs/ratios/inventory_days.
    # yaml#filed_basis.label, served on every block's filed_basis_pointer) —
    # read from the pack, never a hand-typed copy (the EN copies had drifted).
    import yaml

    pack_label = yaml.safe_load((REPO / "packs" / "ratios" / "inventory_days.yaml").read_text("utf-8"))[
        "filed_basis"]["label"]
    for lang, label in (("ro", pack_label["ro"]), ("en", pack_label["en"])):
        bundle = json.loads((REPO / "frontend" / "i18n" / "locales" / ("%s.json" % lang)).read_text("utf-8"))
        row = bundle["benchmarkPage"]["sector"]["ratio"]["inventory_days_on_turnover"]
        assert label in row, (lang, row)
    WORK["units"] += 4


#: Where an inventory figure MAY be divided by a flow: the split itself, the
#: FILED basis (labelled, abridged filings), and the SKU layer's per-SKU days
#: (a sales upload, served under its own key).
_ALLOWED = ("engine/ratios/inventory_days.py", "engine/benchmarks_ro/", "engine/public_ro/",
            "engine/api/_sales_extract.py", "engine/api/_sku_classify.py", "engine/metrics.py")
#: On CODE only (strings and comments removed by the tokenizer, so a
#: string key such as bs["inventory"] reads as bs[] and the rule keys on the
#: identifier): an identifier naming inventory multiplied by 365, or divided
#: by something that is not a digit.
_FORMULA = re.compile(r"\binventory\w*\b.*\*\s*365\b|\*\s*365\b.*\binventory|"
                      r"\binventory\w*[\]\)\.\w]*\s*/\s*(?!\d)[A-Za-z_(]")
_NOT_A_DAYS_FORMULA = re.compile(r"-\s*[\w\[]*inventory")  # quick ratio: (CA - inventory) / CL


def _code_lines(text: str) -> Dict[int, str]:
    """Line number -> the line's CODE: comments dropped, a one-word string
    kept as its word (bs["inventory"] -> bs[inventory]) so the rule sees
    which balance is divided, every other string dropped."""
    import io
    import tokenize

    out: Dict[int, List[str]] = {}
    toks = tokenize.generate_tokens(io.StringIO(text).readline)
    prev = None
    for tok in toks:
        if tok.type == tokenize.COMMENT:
            continue
        if tok.type == tokenize.STRING:
            # A one-word string is a KEY naming a balance (bs["inventory"],
            # bs.get("inventory")) and is kept as that word; prose, docstrings
            # and schema ids ("inventory_days/1") are dropped.
            word = tok.string.lstrip("rRbBuUfF").strip("\"'")
            if re.fullmatch(r"\w+", word):
                out.setdefault(tok.start[0], []).append(word)
            prev = tok
            continue
        if tok.type in (tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT):
            prev = tok
            continue
        out.setdefault(tok.start[0], []).append(tok.string)
        prev = tok
    return {n: " ".join(parts) for n, parts in out.items()}


def scan_engine_sources(root: Path) -> List[str]:
    hits = []
    for path in sorted((root / "src" / "engine").rglob("*.py")):
        rel = path.relative_to(root / "src").as_posix()
        if rel.startswith(_ALLOWED):
            continue
        for n, code in sorted(_code_lines(path.read_text("utf-8")).items()):
            code = code.replace(" [ ", "[").replace(" ] ", "]").replace(" ( ", "(").replace(" ) ", ")")
            if _FORMULA.search(code) and not _NOT_A_DAYS_FORMULA.search(code):
                hits.append("%s:%d: %s" % (rel, n, code.strip()))
    return hits


def test_no_engine_source_divides_an_inventory_figure_outside_the_authorities():
    hits = scan_engine_sources(REPO)
    assert not hits, "a second inventory-days formula:\n  " + "\n  ".join(hits)
    WORK["units"] += 1


def test_the_scan_sees_a_planted_second_denominator(tmp_path):
    """Non-vacuity of the scan: a copy of the tree with a planted line reds."""
    src = tmp_path / "src" / "engine" / "ratios"
    src.mkdir(parents=True)
    (src / "planted.py").write_text(
        "def dio(bs, toe):\n    return bs['inventory'] * 365 / toe\n", encoding="utf-8")
    assert scan_engine_sources(tmp_path), "the scan missed a planted inventory x 365 / flow"


# ── THE FRONTEND (design B4: "the FE fallback computeRatios (refuse, don't
# compute), the report PDF and the cockpit bank export — all read the
# block"). The browser printed the Ratios card's 52.5 by dividing
# inventory by total operating expense in `computeRatios`; the Products
# panel added the sales file's SKU days into the company's CCC. Every
# TypeScript source that is not a test may divide an inventory figure ONLY
# where a namespaced, differently-labelled measure lives:
#: The declared exemptions, each under its own key and label (never "DIO").
_FE_ALLOWED = (
    # the filing's reported basis for a listed company: inventory ÷ cost of
    # sales, "Zile stoc — bază raportată" (key inventory_days_reported)
    "frontend/lib/publicInventoryDays.ts",
    # the sales file's per-SKU days, "Zile de rotație SKU" (never in a CCC)
    "frontend/pages/cfo/Products.tsx",
)
_FE_ROOTS = ("lib", "components", "pages", "data", "hooks", "stores")
#: An identifier naming a stock balance: any identifier containing
#: "inventory", or ending in "Inv" / being "inv" (sumInv, inv) — never
#: invoice / invested / invalid, which do not end there.
_FE_INV = r"(?:\w*[Ii]nventory\w*|\w*[a-z0-9_]Inv|inv)"
_FE_FORMULA = re.compile(
    r"\b%(i)s\b[\w\]\)\.]*\s*/\s*(?!\d)[A-Za-z_(]"          # inventory / flow
    r"|\b%(i)s\b[^;]*\*\s*365\b|\*\s*365\b[^;]*\b%(i)s\b"   # inventory ... × 365
    r"|\bdiv\(\s*(?:\w+\(\s*)?%(i)s\b"                          # div(B("inventory"), …)
    % {"i": _FE_INV})
_FE_NOT_A_DAYS_FORMULA = re.compile(r"-\s*[\w\[\(]*\b%s\b" % _FE_INV)  # quick ratio: (CA − inventory) / CL


def _ts_code_lines(text: str) -> Dict[int, str]:
    """Line number -> the line's CODE: comments dropped, a one-word string
    kept as its word (B("inventory") -> B(inventory)) so the rule sees which
    balance is divided, every other string (and template literal) dropped."""
    out: Dict[int, List[str]] = {}
    i, n, line = 0, len(text), 1
    buf: List[str] = []

    def flush_char(ch: str) -> None:
        buf.append(ch)

    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if ch == "/" and nxt == "/":
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if ch == "/" and nxt == "*":
            j = text.find("*/", i + 2)
            end = n if j < 0 else j + 2
            line += text.count("\n", i, end)
            buf.append("\n" * text.count("\n", i, end))
            i = end
            continue
        if ch in "\"'`":
            j = i + 1
            while j < n and text[j] != ch:
                j += 2 if text[j] == "\\" else 1
            body = text[i + 1:j]
            buf.append(body if re.fullmatch(r"\w+", body) else " ")
            buf.append("\n" * body.count("\n"))
            i = j + 1
            continue
        flush_char(ch)
        i += 1
    for k, code in enumerate("".join(buf).split("\n"), start=1):
        if code.strip():
            out[k] = code  # type: ignore[assignment]
    return out  # type: ignore[return-value]


def scan_frontend_sources(root: Path) -> List[str]:
    hits = []
    for base in _FE_ROOTS:
        for path in sorted((root / "frontend" / base).rglob("*.ts*")):
            rel = path.relative_to(root).as_posix()
            if (not rel.endswith((".ts", ".tsx")) or "/__tests__/" in rel or ".test." in rel
                    or "/node_modules/" in rel or rel in _FE_ALLOWED):
                continue
            for num, code in sorted(_ts_code_lines(path.read_text("utf-8")).items()):
                if _FE_FORMULA.search(code) and not _FE_NOT_A_DAYS_FORMULA.search(code):
                    hits.append("%s:%d: %s" % (rel, num, code.strip()))
    return hits


def test_no_frontend_source_divides_an_inventory_figure_outside_the_authorities():
    hits = scan_frontend_sources(REPO)
    assert not hits, "a second inventory-days formula in the browser:\n  " + "\n  ".join(hits)
    WORK["units"] += 1


def test_the_frontend_scan_sees_a_planted_second_denominator(tmp_path):
    """Non-vacuity of the browser scan: each of the three shapes the defect
    took reds on a planted copy; the quick ratio's subtraction does not."""
    lib = tmp_path / "frontend" / "lib"
    lib.mkdir(parents=True)
    (lib / "planted.ts").write_text(
        'const dio = div(B("inventory"), totalOperatingExpense, "total operating expense");\n'
        "const days = (bs.inventory / cogs) * 365;\n"
        "const skuDio = (sumInv / sumCogs) * 365;\n"
        "const quick = (currentAssets - inventory) / currentLiabilities;\n"
        "const invested = investedCapital / equity; // invested capital, not stock\n",
        encoding="utf-8")
    hits = scan_frontend_sources(tmp_path)
    assert [h.split(":")[1] for h in hits] == ["1", "2", "3"], hits


def test_the_frontend_exemptions_are_the_namespaced_measures():
    """Each exemption prints under its own label, never as DIO."""
    public = (REPO / "frontend" / "lib" / "publicInventoryDays.ts").read_text("utf-8")
    assert 'PUBLIC_INVENTORY_DAYS_KEY = "inventory_days_reported"' in public
    for lang, label in (("ro", "Zile stoc — bază raportată: stoc ÷ costul vânzărilor"),
                        ("en", "Inventory days — reported basis: inventory ÷ cost of sales")):
        bundle = json.loads((REPO / "frontend" / "i18n" / "locales" / ("%s.json" % lang)).read_text("utf-8"))
        assert bundle["publicCompany"]["inventoryDaysReported"]["label"] == label
        sku = bundle["productsX"]["wc"]["companyDio"]
        assert "SKU" in sku and "DIO" not in sku, (lang, sku)
    WORK["units"] += 3


# ── THE TWO BANK DOCUMENTS (design B4: "the report PDF and the cockpit bank
# export — all read the block"). The CFO report is the browser's (held by
# the `inventory-days-surfaces` gate over served bytes); the cockpit's bank
# export is the ENGINE's document (POST /api/forecast/{id}/cockpit/export),
# read here through create_app for every corpus book. It printed the
# forecast's payables driver as "Days payables outstanding (DPO)" over cost
# of sales beside the report's DPO over total operating expense — two DPO
# formulas across the two documents a bank receives.

#: A text that NAMES the payables-days metric, EN or RO.
_DPO_NAMES = re.compile(r"\bDPO\b|days payables? outstanding|pl[aă]t[aă] (a )?furnizorilor|"
                        r"pl[aă]t[aă] furnizori|durata de plat[aă]", re.IGNORECASE)
#: The one DPO's denominator, as every surface states it.
_DPO_FORMULA = re.compile(r"total operating (expense|cost)|cheltuielilor de exploatare|"
                          r"costul opera[tț]ional total", re.IGNORECASE)
#: A text that names inventory days WITH a formula ("=").
_DIO_NAMES = re.compile(r"\bDIO\b|inventory days|days inventory|zile(le)? de stoc", re.IGNORECASE)
_SPLIT_WORDS = re.compile(r"split by stock type|pe tipuri de stoc|cost of production sold|"
                          r"costul produc[tț]iei v[aâ]ndute", re.IGNORECASE)


def _strings(node: Any) -> List[str]:
    if isinstance(node, dict):
        return [t for v in node.values() for t in _strings(v)]
    if isinstance(node, list):
        return [t for v in node for t in _strings(v)]
    return [node] if isinstance(node, str) else []


@pytest.fixture(scope="module")
def bank_exports() -> Dict[str, Any]:
    import test_forecast_cockpit as TC

    out = {}
    for book in BOOKS:
        with TC._World(book) as w:
            out[book] = (w.ok(route="cockpit/export"), w.get("/api/period/%s" % TC.CUR))
    return out


@pytest.mark.parametrize("book", BOOKS)
def test_the_bank_export_prints_the_one_block_and_no_second_dpo(bank_exports, book):
    export, period = bank_exports[book]
    block = period["statements"]["inventory_days"]
    assert block and block["schema"] == ID.SCHEMA, book
    # the base period's block, verbatim — the report prints the same bytes
    assert export["document"]["inventory_days"] == block, book
    levers = dict((lv["id"], lv) for lv in export["assumptions_page"]["levers"])
    dio = levers["dio_days"]
    closing = block["total"]["closing_value"]
    if closing is None:
        assert dio["measured"] is False, (book, dio)
    else:
        assert abs(float(dio["value"]) - closing) < 1e-4, (book, dio["value"], closing)
        # ONE QUANTIZATION: on a 365-day book the lever's default IS the
        # split's period-end figure, and the bank export prints both — the
        # lever row and its sentence print the block's own closing_value_q
        # (agras printed "31,9" in the lever row beside the split's "32").
        q = block["total"]["closing_value_q"]
        if block.get("period_days") == 365:
            for lang in ("en", "ro"):
                want = q if lang == "en" else q.replace(".", ",")
                assert dio["display"][lang] == want, (book, lang, dio["display"], q)
                assert dio["basis"][lang].startswith(want + " "), (book, lang, dio["basis"][lang], q)
            WORK["units"] += 1
    texts = _strings(export)
    second_dpo = [t for t in texts if _DPO_NAMES.search(t) and not _DPO_FORMULA.search(t)]
    assert not second_dpo, "%s: the bank export names a DPO that is not the one DPO: %s" % (book, second_dpo[:3])
    second_dio = [t for t in texts if _DIO_NAMES.search(t) and "=" in t and not _SPLIT_WORDS.search(t)]
    assert not second_dio, "%s: the bank export states inventory days off the split: %s" % (book, second_dio[:3])
    WORK["units"] += 3


#: The bank export on periods that are NOT 365 days (the same agras world,
#: its period re-dated): a leap year and a year-to-date book.
OFF_365 = {"leap-366": ("2024-01-01", "2024-12-31"), "ytd-181": ("2025-01-01", "2025-06-30")}


@pytest.fixture(scope="module")
def bank_exports_off_365() -> Dict[str, Any]:
    import test_forecast_cockpit as TC

    out = {}
    for key, (start, end) in OFF_365.items():
        w = TC._World("agras")
        for row in w.double.tables["financial_periods"]:
            if row.get("id") == TC.CUR:
                row["period_start"], row["period_end"] = start, end
        with w:
            out[key] = (w.ok(route="cockpit/export"), w.get("/api/period/%s" % TC.CUR))
    return out


@pytest.mark.parametrize("key", tuple(OFF_365))
def test_the_bank_export_restates_the_lever_on_a_period_that_is_not_365_days(bank_exports_off_365, key):
    """One bank document, one period-end inventory-days figure: the plan's
    lever is stock ÷ flow × 365 (its year), the analysis's split × the
    period's days. On a 366-day or a 181-day period the lever must be the
    block's period-end total restated on 365 days, its label must name the
    365-day year and its sentence must print the analysis figure and the
    period's day count beside it (FY2024 Scandia printed 42,3 and 42,5 as
    two period-end figures under one name)."""
    export, period = bank_exports_off_365[key]
    block = period["statements"]["inventory_days"]
    days = period["statements"]["supplementary"]["periodDays"]
    assert days == block["period_days"] and days != 365, (key, days)
    assert export["document"]["inventory_days"] == block, key
    lever = dict((lv["id"], lv) for lv in export["assumptions_page"]["levers"])["dio_days"]
    closing = block["total"]["closing_value"]
    assert closing is not None, key
    assert abs(float(lever["value"]) - closing * 365 / days) < 1e-3, (key, lever["value"], closing, days)
    assert lever["label"]["en"].endswith("plan year") and lever["label"]["ro"].endswith("anul planului"), lever["label"]
    for lang, words in (("en", "the plan's 365-day year"), ("ro", "anul de 365 de zile al planului")):
        assert words in lever["basis"][lang], (key, lang, lever["basis"][lang])
    q = block["total"]["closing_value_q"]
    for lang, words in (("en", "day count: %d" % days), ("ro", "numărul de zile: %d" % days)):
        text = lever["basis"][lang]
        assert words in text, (key, lang, text)
        assert (q if lang == "en" else q.replace(".", ",")) in text, (key, lang, q, text)
    WORK["units"] += 2


def test_no_forecast_label_names_a_second_dpo():
    """The forecast's payables driver divides by cost of sales: it keeps its
    formula and its keys, never the name DPO (cockpit pack, driver pack, the
    three i18n labels, EN and RO)."""
    import yaml

    labels = []
    cockpit = yaml.safe_load((REPO / "packs" / "forecast" / "cockpit.yaml").read_text("utf-8"))
    for lever in cockpit["levers"]:
        if "dpo_cogs_days" in (lever.get("compiles_to") or {}).get("drivers", []):
            labels += [("cockpit.yaml:%s.%s" % (lever["id"], lang), text) for lang, text in lever["label"].items()]
    drivers = yaml.safe_load((REPO / "packs" / "forecast" / "drivers.yaml").read_text("utf-8"))
    for d in drivers["drivers"]:
        if d["key"] == "dpo":
            labels.append(("drivers.yaml:dpo", d["label"]))
    for lang in ("en", "ro"):
        bundle = json.loads((REPO / "frontend" / "i18n" / "locales" / ("%s.json" % lang)).read_text("utf-8"))
        for path in (("forecast", "lever"), ("forecast", "driver"), ("scenarios", "shock")):
            node = bundle
            for k in path:
                node = node[k]
            labels.append(("%s.json:%s.dpo_cogs_days" % (lang, ".".join(path)), node["dpo_cogs_days"]))
    assert len(labels) == 9, labels
    named = [(where, text) for where, text in labels if _DPO_NAMES.search(text)]
    assert not named, "the cost-of-sales payables driver is named DPO: %s" % named
    WORK["units"] += 1


def test_the_methodology_file_declares_no_inventory_or_payables_days_view():
    """The methodology envelope's SOURCE (methodology/ro_ras_2025_v1.yaml):
    no view divides the stock or the trade payables by a flow (the quick
    ratio subtracts the stock; it is not a days figure)."""
    import yaml

    doc = yaml.safe_load((REPO / "methodology" / "ro_ras_2025_v1.yaml").read_text("utf-8"))
    bad = []
    for key, view in (doc.get("ratios") or {}).items():
        formula = str((view or {}).get("formula") or "")
        # the quick ratio SUBTRACTS the stock: (current assets - stock) / CL
        divided = re.sub(r"-\s*(inventory_net|trade_payables)\.net", "", formula)
        if re.search(r"(inventory_net|trade_payables)\.net\s*\)?\s*/|/\s*\(?\s*(inventory_net|trade_payables)\.net",
                     divided) or \
                key in ("days_inventory_outstanding", "inventory_turnover", "days_payable_outstanding",
                        "cash_conversion_cycle", "dio", "dpo", "ccc"):
            bad.append((key, formula))
    assert not bad, "a second inventory / payables days formula in the methodology file: %s" % bad
    WORK["units"] += 1


def test_zz_scope():
    print("\nSCOPE one-metric-one-formula: corpus books %s through create_app (metric rows "
          "seeded); forecast drivers on the committed firm fixtures; the cockpit bank export "
          "through create_app; the methodology file; source scan of src/engine "
          "and of the frontend's TypeScript" % ", ".join(BOOKS))
    print("GATE-WORK one-metric-one-formula units=%d" % WORK["units"])
    # measured 46 before the day-count repair: 28 engine + 4 frontend + 12
    # bank export (3 x 4 books) + the forecast payables labels + the
    # methodology file; + the three non-365 served periods and the two
    # non-365 bank exports (measured below, floor raised with it)
    assert WORK["units"] >= 46, WORK
