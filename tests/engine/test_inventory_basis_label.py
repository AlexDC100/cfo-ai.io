"""INVENTORY-BASIS-LABEL — an average is an average, a snapshot says it is
one day, and the food / FMCG seasonality flag stays on while both points
are year-ends (owner spec 2026-09-26, inventory days point 2; design B2).

Scandia's 52.5 inventory days rested on ONE balance — 31 December — and
nothing said so. The block serves a basis and its label: the monthly
average where the workspace holds the fiscal year's twelve month-ends, the
average of the fiscal-year opening and the period end where the file
carries the opening, else the period-end snapshot labelled "stoc la 31
decembrie — o singură zi".

WHAT THIS REDS ON, AFTER THE REPAIR (TC-11), on corpus books through the
REAL write path and GET /api/period (and the monthly basis through the real
app, create_app over the tenancy double, twelve month-end periods seeded):

  · a block labelled as an average (monthly or two year-ends) whose parts
    carry no opening, or whose average is not (opening + closing) ÷ 2 —
    or, monthly, not the mean of the 13 balances;
  · the two-year-end label not "media soldurilor la 1 ianuarie și 31
    decembrie" / "average of the balances at 1 January and 31 December";
  · a SNAPSHOT (a 4-column file, a file whose movement columns do not date
    its opening, and every period written before the stock evidence
    existed — production today) not labelled "stoc la 31 decembrie — o
    singură zi" / "stock at 31 December — a single day", or with an
    average that is not the closing, or without the worded reason the
    opening is missing, or whose total differs from its period-end total;
  · the cycle's inventory term (`ccc_dio_term`) not the period-end figure
    under the snapshot label;
  · a monthly file whose `si` is the MONTH opening (movement convention A:
    si + rl = sf; the corpus Agras rewritten so, in the test's tmp
    directory) served as an average, or with any opening reason but
    `si_date_undetermined`, or allowed a slow claim;
  · the narrator's compact block or FactsGateway carrying another basis or
    label than the block;
  · on the twelve-month workspace, any served-rebuild seam — the shared
    rebuild with org None (Capsule tools, the firm lane), a FactsGateway on
    its envelope, `load_period_rows`, the radar's statements loader —
    serving another block than GET /api/period (it built the block without
    the caller's client: the two year-ends beside the page's monthly);
  · a food / FMCG book (CAEN 10/11/463/471/472, or the fmcg workspace key)
    NOT flagged seasonal on the two-year-end average or on the snapshot
    (both points are year-ends), or flagged on the monthly basis (which
    removes the effect); a non-food book flagged.

Plant log: docs/engine_book/gates.md "inventory-basis-label".
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List

import pytest

import _inventory_gate_books as G

CENT = 0.005
#: an average of two cent amounts, served rounded to the cent: half a cent + float
ROUNDED = 0.0051
TWO_YEAR_ENDS = {"ro": "media soldurilor la 1 ianuarie și 31 decembrie",
                 "en": "average of the balances at 1 January and 31 December"}
SNAPSHOT = {"ro": "stoc la 31 decembrie — o singură zi", "en": "stock at 31 December — a single day"}
MONTHLY = {"ro": "media celor 12 solduri lunare și a soldului inițial",
           "en": "average of the 12 month-end balances and the opening balance"}
FOOD_CAEN = ("1013", "1107", "4631", "4711", "4729")
WORK = {"averages": 0, "snapshots": 0, "seasonality": 0, "surfaces": 0, "monthly": 0}


def _parts(block: Dict[str, Any]) -> List[Dict[str, Any]]:
    return list(block["groups"]) + [block["other"]]


def _surfaces_agree(body: Dict[str, Any], block: Dict[str, Any]) -> None:
    """The narrator's compact block and the Facts gateway state the block's
    basis and label — no surface re-labels the figure."""
    from engine.api.pipeline import _narrate_inventory_days
    from engine.serving.facts import FactsGateway

    st = body["statements"]
    narr = _narrate_inventory_days(st)
    assert narr["basis"] == block["basis"] and narr["basis_label"] == block["basis_label"]["en"], narr
    assert narr["seasonal"] is block["seasonality"]["flagged"], narr
    gw = FactsGateway.from_envelope(st["assembled_canonical_v1"], currency=str(st.get("currency") or "RON"))
    got = gw.inventory_days()
    assert got["basis"] == block["basis"] and got["basis_label"] == block["basis_label"], got["basis"]
    WORK["surfaces"] += 2


def _assert_average(block: Dict[str, Any], case: str) -> None:
    assert block["basis"] == "average_two_year_ends", (case, block["basis"], block["opening"])
    assert block["basis_label"] == TWO_YEAR_ENDS, (case, block["basis_label"])
    assert block["opening"]["status"] == "available" and block["opening"]["convention"] in ("B", "C"), (
        case, block["opening"])
    for p in _parts(block):
        s = p["stock"]
        assert s["opening"] is not None, "%s: an average with no opening for %s" % (case, p["key"])
        assert abs(s["average"] - (s["opening"] + s["closing"]) / 2.0) < ROUNDED, (case, p["key"], s)
    t = block["total"]["stock"]
    assert abs(t["average"] - sum(p["stock"]["average"] for p in _parts(block))) < 2 * CENT, (case, t)
    WORK["averages"] += 1


def _assert_snapshot(block: Dict[str, Any], case: str, reason: str) -> None:
    assert block["basis"] == "year_end_snapshot", (case, block["basis"])
    assert block["basis_label"] == SNAPSHOT, (case, block["basis_label"])
    assert block["opening"]["status"] == "absent", (case, block["opening"])
    assert block["opening"]["reason"]["code"] == reason, (case, block["opening"]["reason"])
    assert block["opening"]["reason"]["text_ro"] and block["opening"]["reason"]["text_en"], case
    for p in _parts(block):
        assert p["stock"]["opening"] is None, "%s: a snapshot that carries an opening (%s)" % (case, p["key"])
        assert p["stock"]["average"] == p["stock"]["closing"], (case, p["key"], p["stock"])
    t = block["total"]
    assert t["value"] == t["closing_value"], "%s: the snapshot's total is not its one day" % case
    assert block["claim_policy"]["may_call_slow"] is False, (case, block["claim_policy"])
    WORK["snapshots"] += 1


def _assert_ccc_term(block: Dict[str, Any], case: str) -> None:
    term = block["ccc_dio_term"]
    assert term["basis"] == "year_end_snapshot" and term["basis_label"] == SNAPSHOT, (case, term)
    assert term["value"] == block["total"]["closing_value"], (case, term, block["total"]["closing_value"])


@pytest.mark.parametrize("case", G.OPENING_BOOKS)
def test_a_file_with_the_fiscal_year_opening_serves_the_two_year_end_average(case):
    body = G.served(G.corpus_book(case), cache_key=case)
    block = G.block_of(body)
    _assert_average(block, case)
    _assert_ccc_term(block, case)
    _surfaces_agree(body, block)
    if block["total"]["value"] is not None:
        assert block["claim_policy"]["may_call_slow"] is True, (case, block["claim_policy"])


@pytest.mark.parametrize("case,reason", sorted(G.SNAPSHOT_BOOKS.items()))
def test_a_file_without_a_dated_opening_is_the_one_day_snapshot(case, reason):
    body = G.served(G.corpus_book(case), cache_key=case)
    block = G.block_of(body)
    _assert_snapshot(block, case, reason)
    _assert_ccc_term(block, case)
    _surfaces_agree(body, block)


def _with_month_opening(case: str, tmp: Any) -> Any:
    """The corpus workbook (10-column SAGA: SI, RL, RC, SF pairs) rewritten
    as a MONTHLY file whose `si` is the MONTH's opening: si = sf − rl per
    account (net, on the side of its sign), rl, rc and sf untouched. The
    movement identity A (si + rl = sf) then holds on every row and B / C
    (the cumulative block from the fiscal-year opening) on none — the file
    cannot say its `si` is 1 January. Written to the test's tmp directory,
    through the real write path; never committed."""
    import openpyxl

    header, rows = G._xlsx_rows(case)
    si_d, rl_d, sf_d = 2, 4, 8
    for r in rows:
        if not str(r[0] or "").strip():
            continue
        net = (float(r[sf_d] or 0) - float(r[sf_d + 1] or 0)) - (float(r[rl_d] or 0) - float(r[rl_d + 1] or 0))
        net = round(net, 2)
        r[si_d], r[si_d + 1] = (net, 0.0) if net >= 0 else (0.0, -net)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(header)
    for r in rows:
        ws.append(r)
    out = tmp / ("%s_month_opening.xlsx" % case)
    wb.save(out)
    return out


def test_a_monthly_file_whose_opening_is_the_month_opening_is_the_one_day_snapshot(tmp_path):
    """Convention A (si + the period movement = closing) holds on an annual
    file AND on a monthly file whose `si` is the MONTH opening; the file
    cannot say which, so the opening is `si_date_undetermined` and the
    block is the snapshot — never 'the average of 1 January and <period
    end>' over a month opening, never a slow claim. No corpus book carries
    convention A, so without this variant the refusal was ungated (the
    plant ('A', 'B', 'C') stayed green on every inventory gate)."""
    path = _with_month_opening("saga_10_col_agras", tmp_path)
    bk = G.book_from_path(path, key="agras-month-opening")
    evidence = bk.period["assembled_canonical_v1"]["inventory_stock"]
    assert evidence["opening"]["convention"] == "A", evidence["opening"]
    body = G.served(bk)
    block = G.block_of(body)
    _assert_snapshot(block, "agras-month-opening", "si_date_undetermined")
    _assert_ccc_term(block, "agras-month-opening")
    _surfaces_agree(body, block)


def _as_four_pair(case: str, tmp: Any, *, month_opening: bool, period_end: str) -> Any:
    """The corpus 10-column SAGA workbook (si = 1 January, rl = the month,
    rc = the year to date, sf) rewritten as a 4-PAIR export — Solduri
    initiale / Rulaje / Sume totale / Solduri finale, with Sume totale = si +
    Rulaje on each side, so identities A and B hold on every row and tie.

    ``month_opening``: the si is the MONTH's opening (per side, the year's
    opening plus the year to date before this month) and Rulaje the month —
    a single-month export, whose class 6/7 si carries the year to date.
    Otherwise the si is 1 January and Rulaje the whole year — an annual
    export, whose class 6/7 si is zero. Written to tmp; never committed."""
    import openpyxl

    _header, rows = G._xlsx_rows(case)
    header = ["Cont", "Denumire cont", "Solduri initiale Debit", "Solduri initiale Credit",
              "Rulaje Debit", "Rulaje Credit", "Sume totale Debit", "Sume totale Credit",
              "Solduri finale Debit", "Solduri finale Credit"]
    out_rows = []
    for r in rows:
        if not str(r[0] or "").strip():
            continue
        f = [float(x or 0) for x in r[2:10]]
        si_d, si_c, rl_d, rl_c, rc_d, rc_c, sf_d, sf_c = f
        st_d, st_c = round(si_d + rc_d, 2), round(si_c + rc_c, 2)
        if month_opening:
            o_d, o_c, m_d, m_c = round(st_d - rl_d, 2), round(st_c - rl_c, 2), rl_d, rl_c
        else:
            o_d, o_c, m_d, m_c = si_d, si_c, rc_d, rc_c
        out_rows.append([r[0], r[1], o_d, o_c, m_d, m_c, st_d, st_c, sf_d, sf_c])
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(header)
    for r in out_rows:
        ws.append(r)
    out = tmp / ("%s_four_pair_%s.xlsx" % (case, "month" if month_opening else "year"))
    wb.save(out)
    return G.book_from_path(out, key="%s-4pair-%s" % (case, "month" if month_opening else "year"),
                            period_end=period_end)


def test_a_four_pair_export_whose_opening_ties_a_and_b_needs_a_zero_pl_opening(tmp_path):
    """B wins an exact tie with A on every 4-pair export (Sume totale = si +
    Rulaje): the probe reports B by its fixed preference, and the si was read
    as 1 January — so a single-month export whose si is the MONTH opening
    (the December export below: si = 1 December) served 'the average of the
    balances at 1 January and 31 December' with may_call_slow true. The file dates its si only through the class 6/7
    opening: zero on a fiscal-year opening, the year to date on a month
    opening. The month export is the snapshot (si_date_undetermined); the
    annual export of the same book, same layout, keeps its average."""
    month = _as_four_pair("saga_10_col_agras", tmp_path, month_opening=True, period_end="2025-12-31")
    evidence = month.period["assembled_canonical_v1"]["inventory_stock"]
    assert evidence["opening"]["convention"] == "B", evidence["opening"]
    body = G.served(month)
    block = G.block_of(body)
    _assert_snapshot(block, "agras-4pair-month", "si_date_undetermined")
    _surfaces_agree(body, block)
    year = _as_four_pair("saga_10_col_agras", tmp_path, month_opening=False, period_end="2025-12-31")
    ev_year = year.period["assembled_canonical_v1"]["inventory_stock"]
    assert ev_year["opening"]["convention"] == "B", ev_year["opening"]
    _assert_average(G.block_of(G.served(year)), "agras-4pair-year")


NO_ROWS = "trial_balance_rows_unavailable"
PREDATES = "period_predates_inventory_measurement"


def _served_with_env(bk: Any, edit: Any) -> Dict[str, Any]:
    import types

    period = copy.deepcopy(bk.period)
    env = period.get("assembled_canonical_v1") or {}
    env.pop("inventory_days", None)
    edit(env)
    period["assembled_canonical_v1"] = env
    return G.block_of(G.served(types.SimpleNamespace(
        period=period, line_items=bk.line_items, period_id=bk.period_id, org=dict(bk.org))))


@pytest.mark.parametrize("extraction", ({"method": "llm", "source_format": "llm_freeform"},
                                        {"method": "deterministic", "source_format": "statutory_f30_f10"}))
def test_a_source_without_trial_balance_rows_never_says_recomputed_when_reprocessed(extraction):
    """The model's extraction and a filed statutory return hold no trial-
    balance columns: no opening can ever be measured from them, and a
    reprocess of the same source measures none. They served the snapshot
    with "the period was analysed before opening stock balances were kept;
    it is recomputed when reprocessed" — a promise nothing can keep — while
    the pack's own `trial_balance_rows_unavailable` sentence was dead.
    (1) the write seam stores the no-rows marker; (2) the served block says
    the trial balance was not available; (3) a period stored before this
    repair (no marker) whose canonical_bs names such a path says the same;
    (4) a trial-balance period stored before the evidence keeps 'predates'."""
    from engine.api import pipeline as P

    bk = G.corpus_book("saga_10_col_agras")
    parsed = copy.deepcopy(bk.parsed)
    parsed.pop("inventory_stock_evidence", None)
    parsed["extraction"] = dict(extraction)
    assembled = P.stage_map(bk.doc, parsed, None)
    marker = assembled["assembled_canonical_v1"].get("inventory_stock")
    assert marker and marker["measured"] is False and marker["opening"]["reason"] == NO_ROWS, marker

    def _stored(env: Dict[str, Any]) -> None:
        env["inventory_stock"] = copy.deepcopy(marker)

    def _before_repair(env: Dict[str, Any]) -> None:
        env.pop("inventory_stock", None)
        env.setdefault("canonical_bs", {})["extraction"] = dict(extraction)

    for label, edit in (("stored marker", _stored), ("stored before the repair", _before_repair)):
        block = _served_with_env(bk, edit)
        _assert_snapshot(block, "agras %s %s" % (extraction["source_format"], label), NO_ROWS)
        text = block["opening"]["reason"]
        assert "reprocess" not in text["text_en"] and "reproces" not in text["text_ro"], (label, text)
        WORK["surfaces"] += 1
    # the control: a TRIAL-BALANCE period written before the evidence
    control = _served_with_env(bk, lambda env: env.pop("inventory_stock", None))
    assert control["opening"]["reason"]["code"] == PREDATES, control["opening"]


@pytest.mark.parametrize("case", G.OPENING_BOOKS)
def test_a_period_written_before_the_evidence_is_the_labelled_snapshot(case):
    """Every period stored today (no `inventory_stock` on its envelope)
    serves the period-end snapshot from its line items, labelled one day —
    never an average of an opening it does not have."""
    body = G.served(G.predates(G.corpus_book(case)), cache_key="predates:%s" % case)
    block = G.block_of(body)
    _assert_snapshot(block, case, "period_predates_inventory_measurement")
    _assert_ccc_term(block, case)
    _surfaces_agree(body, block)
    # The same stock on the same day as the evidence-backed period's
    # period-end figures — the snapshot is the period end, not a new number.
    full = G.block_of(G.served(G.corpus_book(case), cache_key=case))
    for a, b in zip(block["groups"], full["groups"]):
        assert abs(a["stock"]["closing"] - b["stock"]["closing"]) < CENT, (case, a["key"])
        if a["value"] is not None and b["closing_value"] is not None:
            assert abs(a["value"] - b["closing_value"]) < 1e-6, (case, a["key"], a["value"], b["closing_value"])


def test_the_owners_own_book_as_stored_today_says_it_is_one_day():
    """Scandia Food FY2025 — the book of the owner's complaint (48.8 / 52.5 /
    95.3 on one stock) — as its committed capture stores it
    (regression_baselines/scandia_fy2025.json: persisted before the stock
    evidence), served through the real router: the snapshot, labelled one
    day, with the reason the opening is missing."""
    import _served_books as SB

    body = SB.served_body("scandia_baseline")
    block = G.block_of(body)
    _assert_snapshot(block, "scandia_fy2025", "period_predates_inventory_measurement")
    _assert_ccc_term(block, "scandia_fy2025")
    _surfaces_agree(body, block)


@pytest.mark.parametrize("case", ("saga_10_col_agras", "saga_10_col_carniprod"))
def test_food_and_fmcg_stay_flagged_seasonal_on_both_year_end_bases(case):
    bk = G.corpus_book(case)
    for caen in FOOD_CAEN:
        for variant, basis in ((bk, "average_two_year_ends"), (G.predates(bk), "year_end_snapshot")):
            block = G.block_of(G.served(G.with_org(variant, caen_code=caen)))
            assert block["basis"] == basis, (case, caen, block["basis"])
            s = block["seasonality"]
            assert s["flagged"] is True and s["note_ro"] and s["note_en"], (case, caen, basis, s)
            WORK["seasonality"] += 1
    fmcg = G.block_of(G.served(G.with_org(bk, industry_key="fmcg")))
    assert fmcg["seasonality"]["flagged"] is True, fmcg["seasonality"]
    for caen in ("2511", "4120", "6201"):
        block = G.block_of(G.served(G.with_org(bk, caen_code=caen)))
        assert block["seasonality"] == {"flagged": False, "note_ro": None, "note_en": None}, (case, caen)
        WORK["seasonality"] += 1


@pytest.mark.parametrize("caen, flagged", (("1013", True), ("6201", False)))
def test_the_upload_time_block_and_the_narrator_carry_the_orgs_seasonality(caen, flagged):
    """THE WRITE PATH READS THE ORG TOO. stage_narrate (the upload-time
    briefing and recommendations) reads the block stage_persist stores; it
    was built without the organization row, so a CAEN 1013 company served
    'seasonal' on GET /api/period and never at upload — the prompt's rule
    ("when inventory_days.seasonal is true, say … seasonal") could not fire.
    Through the production write seam (stage_map -> stage_persist) with the
    workspace's organizations row answerable."""
    import contextlib

    corpus_replay = G.A.corpus_replay
    from engine.api import pipeline as P

    bk = G.corpus_book("saga_10_col_agras")
    org = {"id": bk.doc["org_id"], "name": "Corpus Entity", "caen_code": caen}

    class _OrgAnswering(corpus_replay.FakeAdminClient):
        def select(self, table, **kw):  # type: ignore[override]
            if table == "organizations":
                return [dict(org)]
            return super().select(table, **kw)

    fake = _OrgAnswering()

    @contextlib.contextmanager
    def _admin():
        yield fake

    prior = P._supabase.admin
    P._supabase.admin = _admin
    try:
        assembled = P.stage_map(bk.doc, bk.parsed, None)
        P.stage_persist(bk.doc, bk.parsed, assembled)
    finally:
        P._supabase.admin = prior
    stored = fake.period_rows[0]["assembled_canonical_v1"]["inventory_days"]
    assert stored["seasonality"]["flagged"] is flagged, (caen, stored["seasonality"])
    assert assembled["statements"]["inventory_days"] == stored, "the narrated block is not the stored one"
    narr = P._narrate_inventory_days(assembled["statements"])
    assert narr["seasonal"] is flagged, (caen, narr)
    # …and it is the flag GET /api/period serves the same workspace.
    served_block = G.block_of(G.served(G.with_org(bk, caen_code=caen)))
    assert served_block["seasonality"]["flagged"] is flagged, (caen, served_block["seasonality"])
    WORK["seasonality"] += 1
    WORK["surfaces"] += 2


# ── the monthly basis, through the real app ───────────────────────────────


def _month_end(m: int) -> str:
    import calendar

    return "2025-%02d-%02d" % (m, calendar.monthrange(2025, m)[1])


def _served_rebuild_seams(client: Any, period_id: str) -> Dict[str, Any]:
    """The inventory-days block each served-rebuild seam hands its reader,
    through `client` (the double, as the caller's own client)."""
    from engine.api import pipeline as P
    from engine.api import _radar
    from engine.serving.facts import FactsGateway

    row = client.select("financial_periods", filters={"id": "eq.%s" % period_id}, single=True)[0]
    items = client.select("statement_line_items", filters={"period_id": "eq.%s" % period_id}) or []
    out = {}
    # the Capsule tools and the firm lane: the shared seam, org None
    rebuilt = P._rebuild_assembled_for_briefing(items, copy.deepcopy(row), None, client=client)["statements"]
    out["rebuild_seam(org None)"] = rebuilt.get("inventory_days")
    out["FactsGateway(rebuilt envelope)"] = FactsGateway.from_envelope(
        rebuilt["assembled_canonical_v1"], currency="RON").inventory_days()
    # the period reader (forecast, reanalyze, the credit-pack routes)
    out["load_period_rows"] = P.load_period_rows(client, period_id)["statements"].get("inventory_days")
    # the radar's statements loader
    radar_st, _items = _radar.load_statements(client, copy.deepcopy(row))
    out["radar.load_statements"] = (radar_st or {}).get("inventory_days")
    return out


def test_twelve_month_ends_serve_the_monthly_average_and_lift_the_seasonal_flag():
    """The workspace holds the fiscal year's twelve month-end periods: the
    December period's block is the mean of the 13 balances (January's
    opening + 12 month-ends), labelled monthly, NOT flagged seasonal even
    for a food CAEN. With one month missing it falls back to the two
    year-ends, labelled. Either way every served-rebuild seam (Capsule,
    firm lane, radar, the period reader, a FactsGateway on the rebuilt
    envelope) serves the page's block, byte for byte."""
    import _real_app_comparatives as RA
    import firm_postgrest_double as D
    import types

    bk = G.corpus_book("saga_10_col_agras")
    dec_block = copy.deepcopy(bk.period["assembled_canonical_v1"]["inventory_days"])
    assert dec_block["basis"] == "average_two_year_ends"
    keys = [g["key"] for g in dec_block["groups"]] + [dec_block["other"]["key"]]
    closing = dict((p["key"], p["stock"]["closing"]) for p in _parts(dec_block))
    opening = dict((p["key"], p["stock"]["opening"]) for p in _parts(dec_block))

    def month_book(m: int, unreconciled: bool = False) -> Any:
        if m == 12:
            return bk
        period = copy.deepcopy(bk.period)
        block = period["assembled_canonical_v1"]["inventory_days"]
        for p in list(block["groups"]) + [block["other"]]:
            # a seasonal profile: month m holds (0.6 + 0.07 m) of December's stock
            p["stock"]["closing"] = round(closing[p["key"]] * (0.6 + 0.07 * m), 2)
            if m != 1:
                p["stock"]["opening"] = None
        if unreconciled:
            # a month whose split does not add up to its balance sheet
            block["reconciliation"] = dict(block["reconciliation"], status="not_reconciled")
            block["status"] = "refused"
        return types.SimpleNamespace(period=period, line_items=bk.line_items)

    user = "00000000-0000-4000-8000-000000000001"
    org = "00000000-0000-4000-8000-00000000c0da"
    app = RA.build_app()
    # (months, the month served unreconciled or None, the basis wanted)
    for months, bad, want in ((range(1, 13), None, "average_monthly"),
                              (range(2, 13), None, "average_two_year_ends"),
                              (range(1, 13), 5, "average_two_year_ends")):
        periods = [(month_book(m, unreconciled=(m == bad)), "month-%02d" % m, org, "2025-01-01",
                    _month_end(m)) for m in months]
        double = RA.seed_double(
            orgs=[{"id": org, "name": "Monthly", "default_currency": "RON", "caen_code": "1013"}],
            memberships=[{"user_id": user, "org_id": org, "role": "owner",
                          "created_at": "2026-01-01T00:00:00+00:00"}],
            periods=periods)
        with RA.installed(double):
            resp = RA.get(app, "/api/period/month-12", D.mint_jwt(user, "owner@local.invalid"), org)
            seams = _served_rebuild_seams(double, "month-12")
        assert resp.status_code == 200, (resp.status_code, resp.text[:300])
        block = G.block_of(resp.json())
        assert block["basis"] == want, (list(months), block["basis"])
        # EVERY served-rebuild seam serves the page's block — the Capsule's
        # and the firm lane's rebuild (org None), the radar's statements
        # loader, the period reader, and a FactsGateway on the rebuilt
        # envelope. Before 2026-09-27 the seam built the block without the
        # caller's client: 'average_two_year_ends 30.2' (seasonal) beside
        # the page's 'average_monthly 32.2'.
        for seam, got in seams.items():
            assert got == block, (list(months)[0], seam, (got or {}).get("basis"), block["basis"])
            WORK["surfaces"] += 1
        if want == "average_monthly":
            assert block["basis_label"] == MONTHLY, block["basis_label"]
            for p in _parts(block):
                pts = [opening[p["key"]]] + [
                    round(closing[p["key"]] * (0.6 + 0.07 * m), 2) if m != 12 else closing[p["key"]]
                    for m in range(1, 13)]
                assert abs(p["stock"]["average"] - sum(pts) / 13.0) < ROUNDED, (p["key"], p["stock"], pts)
            assert block["seasonality"]["flagged"] is False, block["seasonality"]
            assert block["claim_policy"]["may_call_slow"] is True, block["claim_policy"]
            WORK["monthly"] += len(keys)
        else:
            _assert_average(block, "agras-11-months" if bad is None else "agras-month-%d-unreconciled" % bad)
            assert block["seasonality"]["flagged"] is True, "a food CAEN on two year-ends is seasonal"


def test_zz_scope():
    print("\nSCOPE inventory-basis-label: corpus books %s (two year-ends) and %s (snapshot), the "
          "same %d books served as periods written before the evidence (snapshot), CAEN-seasonality "
          "on agras + carniprod, the monthly basis through create_app"
          % (", ".join(G.OPENING_BOOKS), ", ".join(sorted(G.SNAPSHOT_BOOKS)), len(G.OPENING_BOOKS)))
    units = sum(WORK.values())
    print("GATE-WORK inventory-basis-label units=%d averages=%d snapshots=%d seasonality=%d "
          "surfaces=%d monthly=%d" % (units, WORK["averages"], WORK["snapshots"], WORK["seasonality"],
                                     WORK["surfaces"], WORK["monthly"]))
    assert WORK["averages"] >= len(G.OPENING_BOOKS) and WORK["snapshots"] >= len(G.OPENING_BOOKS) + 2, WORK
    assert WORK["monthly"] >= 4 and WORK["seasonality"] >= 20, WORK
