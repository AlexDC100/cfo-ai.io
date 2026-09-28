"""scripts/reprocess_periods_definition.py — the deploy's reprocessing of
stored periods under the ONE EBITDA (owner ruling 2026-09-26, design A9).

Runs over the tenancy double of test_workspace_v2_gates (every migration's
columns, tenant-guarded storage, the network closed, the Anthropic SDK a
stand-in, quota recorded): a REAL corpus book (corpus/saga_10_col_agras) is
uploaded and analysed by the real pipeline, then made to look like a period
persisted BEFORE the ruling (no stock-variation evidence, no definition
stamp, the pre-ruling `ebitda.reported`) — the shape every production
period has at deploy time.

WHAT THIS REDS ON (TC-11):
  · a dry run that writes anything;
  · a dry run that does not report anchor status, book state, net 711 and
    its provenance, old vs new EBITDA and the credit letter before/after;
  · an apply that does not leave the envelope carrying the evidence and the
    stamp, the metric rows on the one EBITDA, the council alerts and the
    briefing untouched;
  · an apply that is not idempotent (a second run rewrites);
  · a period whose stored evidence was read by another parser (G7 — served
    as `reprocess_required`) reported `current`, or not restamped by apply;
  · any quota call; any model call; a document that needs the model being
    written; a period whose stored document now resolves to another month
    being written; a turnover move applied without a ruling;
  · THE 2026-09-28 REVISION (owner rulings R2, R3): a period carrying the
    evidence and the PREVIOUS definition stamp reported `current`; a dry
    run that does not print the stamp it was written under, the net
    provisions and the 7411 inside turnover; a turnover move of exactly the
    placed 7411 on an earlier-definition period blocking the apply, or ANY
    other move (or one away from a named filed figure) not blocking;
  · THE VALUATIONS ROW (critic, 2026-09-27 — production held six rows the
    engine wrote under the previous definition): a dry run that does not
    print the stored row's `ebitda_used` against the one the rewrite
    persists; a period whose row carries another EBITDA reported
    `current`; an apply that leaves the row on the old EBITDA; a row the
    USER's saved override produced treated as stale (the user's figure).

The double declares the `valuations` / `user_valuation_assumptions`
columns the engine writes (no DDL for either table is in the repo; the
columns are `_valuation.persist_valuation`'s row and the save route's).
"""
from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path
from typing import Any, Dict

import pytest

import test_workspace_v2_gates as V
from test_workspace_v2_gates import app, gw  # noqa: F401 — pytest fixtures

REPO = Path(__file__).resolve().parents[2]
WORK = {"units": 0}


def _tool():
    spec = importlib.util.spec_from_file_location(
        "reprocess_periods_definition", str(REPO / "scripts" / "reprocess_periods_definition.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["reprocess_periods_definition"] = mod
    spec.loader.exec_module(mod)
    return mod


R = _tool()

#: The columns `_valuation.persist_valuation` and the save route write.
VALUATION_COLUMNS = [
    "id", "period_id", "org_id", "primary_method", "ebitda_used", "revenue_used",
    "total_debt_used", "cash_used", "multiple_ebitda_p25", "multiple_ebitda_p50",
    "multiple_ebitda_p75", "ev_ebitda_p25", "ev_ebitda_p50", "ev_ebitda_p75",
    "equity_ebitda_p25", "equity_ebitda_p50", "equity_ebitda_p75", "multiple_revenue_p25",
    "multiple_revenue_p50", "multiple_revenue_p75", "ev_revenue_equity_p25",
    "ev_revenue_equity_p50", "ev_revenue_equity_p75", "dcf_wacc", "dcf_terminal_growth",
    "dcf_enterprise_value", "dcf_equity_value", "dcf_sensitivity_low", "dcf_sensitivity_high",
    "confidence", "multiples_source", "multiples_as_of_date"]
USER_VALUATION_COLUMNS = ["user_id", "period_id", "ebitda_used", "multiple_used", "debt_used",
                          "cash_used", "notes", "ebitda_definition", "updated_at"]


@pytest.fixture(autouse=True)
def _valuation_tables(gw):
    """The two valuation tables as the engine writes them (see the module
    docstring): the analysis persists its engine-written valuations row."""
    for table, cols in (("valuations", VALUATION_COLUMNS),
                        ("user_valuation_assumptions", USER_VALUATION_COLUMNS)):
        have = gw.db.columns.setdefault(table, [])
        have += [c for c in cols if c not in have]
    yield


@pytest.fixture()
def no_quota(monkeypatch):
    """Arms the guard AFTER the setup's own upload (which is metered, as
    production's is): from then on every quota entry point raises, so the
    tool provably never meters."""
    from engine.api import _usage_gate

    def _boom(*a: Any, **k: Any) -> Any:
        raise AssertionError("the reprocessing tool touched the quota")

    def arm() -> None:
        for name in ("reserve_document", "commit_document", "release_document",
                     "reserve_chat", "commit_chat", "release_chat"):
            if hasattr(_usage_gate, name):
                monkeypatch.setattr(_usage_gate, name, _boom)
    return arm


def _analysed_pre_ruling(app, gw) -> Dict[str, Any]:
    """Agras analysed by the real pipeline, then shaped like a period
    persisted before the ruling: the evidence block and the definition stamp
    removed, `ebitda.reported` the pre-ruling figure (without net 711)."""
    out = V.one_tap(app, V.agras_workbook(), "balanta.xlsx", on_screen=V.ORG_AGRAS)
    V.run_analysis(gw, out["commit"]["document_id"])
    (period,) = gw.db.rows("financial_periods")
    env = period["assembled_canonical_v1"]
    before = env["methodology"]["ebitda"]["reported"]
    env.pop("stock_variation")
    env["methodology"].pop("ebitda_definition")
    env["methodology"]["ebitda"]["reported"] = 10776378.24
    for m in gw.db.rows("calculated_metrics"):
        if m["name"] == "credit_composite":
            m["value"] = 79.9
    gw.db.add("alerts", {"org_id": period["org_id"], "period_id": period["id"],
                         "alert_key": "ai_council::summary", "severity": "info",
                         "category": "data_quality", "title": "council verdict",
                         "body": "pass", "payload": {"rule_key": "ai_council"}})
    briefings = gw.db.rows("briefings")
    assert briefings, "the analysis wrote a briefing row"
    # The engine-written valuations row under the PREVIOUS definition (the
    # six production rows' shape): EV/EBITDA on the EBITDA without net 711.
    (vrow,) = gw.db.rows("valuations")
    assert vrow["ebitda_used"] == pytest.approx(before, abs=0.005), vrow
    vrow["ebitda_used"] = 10776378.24
    vrow["primary_method"] = "ev_ebitda"
    return {"period": period, "ruled_ebitda": before}


def _tables(gw) -> Dict[str, Any]:
    """Every stored row. A table the double materialises empty on a READ is
    not a write, so empty tables are left out of the comparison."""
    return dict((t, copy.deepcopy(rows)) for t, rows in gw.db.tables.items() if rows)


def test_the_dry_run_reports_the_move_and_writes_nothing(app, gw, no_quota):
    world = _analysed_pre_ruling(app, gw)
    no_quota()
    pid = world["period"]["id"]
    snapshot = _tables(gw)
    (row,) = R.run(apply=False, period=pid)
    assert _tables(gw) == snapshot, "the dry run wrote"
    assert row["status"] == R.WOULD_REPROCESS, row
    a, b = row["after"], row["before"]
    assert a["anchor_status"] == "anchored", a
    assert a["book_state"] == "closed", a
    assert a["net_711"] == pytest.approx(1071687.03, abs=0.005)
    assert a["net_711_provenance"] == "account_121_bridge"
    assert a["net_72x"] == 0.0
    assert b["ebitda"] == pytest.approx(10776378.24, abs=0.005)
    # R2 (2026-09-28): Agras's 7814.01 reversal (3,988.70) is outside
    # EBITDA — 11,848,065.27 under the 2026-09-26 definition, 11,844,076.57
    # now — and its net provisions (6812.01 + 6814.0x − 7814.01) are served
    # beside it; the operating result does not move.
    assert a["net_provisions"] == pytest.approx(131394.66, abs=0.005), a
    assert a["ebit"] == pytest.approx(8892718.88, abs=0.005), a
    assert a["turnover_7411"] == 0.0, a
    assert a["ebitda"] == pytest.approx(11844076.57, abs=0.005) == pytest.approx(world["ruled_ebitda"])
    assert b["composite"] == 79.9 and b["letter"] and a["letter"] and a["composite"] is not None
    assert b["has_evidence"] is False and b["definition_current"] is False
    assert row["turnover_move"] is None, row
    v = row["valuation"]
    assert v["ebitda_used"] == pytest.approx(10776378.24, abs=0.005), v
    assert v["ebitda_used_after"] == pytest.approx(11844076.57, abs=0.005), v
    assert v["current"] is False, v
    text = R.render([row])
    for needle in ("anchor anchored", "book closed", "1,071,687.03", "account_121_bridge",
                   "EBITDA 10,776,378.24 -> 11,844,076.57", "credit 79.90",
                   "valuation EBITDA 10,776,378.24 (ev_ebitda) -> 11,844,076.57",
                   "STORED ROW ON ANOTHER EBITDA",
                   "definition unstamped -> ebitda/2026-09-28:",
                   "net provisions (outside EBITDA) 131,394.66 · EBIT 8,892,718.88",
                   "(7411 inside: 0.00)"):
        assert needle in text, (needle, text)
    WORK["units"] += 22


def test_apply_rewrites_the_period_with_the_engines_stages_and_is_idempotent(app, gw, no_quota):
    world = _analysed_pre_ruling(app, gw)
    no_quota()
    pid = world["period"]["id"]
    briefing_before = copy.deepcopy(gw.db.rows("briefings"))
    (row,) = R.run(apply=True, period=pid)
    assert row["status"] == R.REPROCESSED, row
    (period,) = gw.db.rows("financial_periods")
    assert period["id"] == pid
    env = period["assembled_canonical_v1"]
    assert env["stock_variation"]["schema"] == "stock_variation/1"
    from engine.country_packs.ro_romania.chart_of_accounts import EBITDA_DEFINITION_REVISION
    assert env["methodology"]["ebitda_definition"] == EBITDA_DEFINITION_REVISION
    assert env["methodology"]["ebitda"]["reported"] == pytest.approx(11844076.57, abs=0.005)
    metrics = dict((m["name"], m["value"]) for m in gw.db.rows("calculated_metrics")
                   if m["period_id"] == pid)
    assert metrics["ebitda"] == pytest.approx(11844076.57, abs=0.005)
    assert metrics["credit_composite"] == row["after"]["composite"]
    keys = [a["alert_key"] for a in gw.db.rows("alerts") if a["period_id"] == pid]
    assert "ai_council::summary" in keys, keys          # carried over
    assert not [k for k in keys if k.startswith("earnings_quality_capitalized_own_work")]
    assert gw.db.rows("briefings") == briefing_before, "the briefing is never rewritten"
    (vrow,) = gw.db.rows("valuations")
    assert vrow["ebitda_used"] == pytest.approx(11844076.57, abs=0.005), (
        "the apply left the valuations row on the previous EBITDA", vrow)
    # A second run changes nothing: the period is current.
    snapshot = _tables(gw)
    (again,) = R.run(apply=True, period=pid)
    assert again["status"] == R.CURRENT, again
    assert _tables(gw) == snapshot, "the second apply rewrote a current period"
    WORK["units"] += 11


def test_a_period_read_by_an_older_parser_is_never_current_and_apply_restamps_it(app, gw, no_quota):
    """G7 (design A10): a stored evidence block stamped by another reader
    serves every EBITDA-built figure as `reprocess_required` on GET
    /api/period — while its stored methodology figures still agree with a
    fresh run. The tool compared only those figures, so it reported the
    period `current` and never rewrote it: the documented remedy skipped
    exactly the periods the refusal names, at the next parser bump."""
    from engine.country_packs.ro_romania.trial_balance_parser import PARSER_VERSION

    out = V.one_tap(app, V.agras_workbook(), "balanta.xlsx", on_screen=V.ORG_AGRAS)
    V.run_analysis(gw, out["commit"]["document_id"])
    no_quota()
    (period,) = gw.db.rows("financial_periods")
    pid = period["id"]
    # Freshly analysed: current.
    (fresh,) = R.run(apply=False, period=pid)
    assert fresh["status"] == R.CURRENT, fresh
    assert fresh["before"]["parser_current"] is True
    # The stamp an older reader left.
    assert PARSER_VERSION != "tb_parser_v5"
    period["assembled_canonical_v1"]["stock_variation"]["parser_version"] = "tb_parser_v5"
    snapshot = _tables(gw)
    (row,) = R.run(apply=False, period=pid)
    assert _tables(gw) == snapshot, "the dry run wrote"
    assert row["status"] == R.WOULD_REPROCESS, row
    assert row["before"]["parser_version"] == "tb_parser_v5"
    assert row["before"]["parser_current"] is False
    text = R.render([row])
    assert "reader tb_parser_v5 -> %s" % PARSER_VERSION in text, text
    assert "G7: served as reprocess_required" in text, text
    # Apply rewrites the block under the running reader, and is then current.
    (applied,) = R.run(apply=True, period=pid)
    assert applied["status"] == R.REPROCESSED, applied
    (period,) = gw.db.rows("financial_periods")
    assert period["assembled_canonical_v1"]["stock_variation"]["parser_version"] == PARSER_VERSION
    (again,) = R.run(apply=False, period=pid)
    assert again["status"] == R.CURRENT, again
    WORK["units"] += 9


def test_a_period_current_in_every_figure_but_its_valuations_row_is_never_current(app, gw, no_quota):
    """The stored envelope, metric rows and parser stamp all current — only
    the `valuations` row carries another EBITDA (written before the ruling,
    not rewritten since). Reported `current`, it would keep serving the old
    EBITDA wherever the row is read; the apply rewrites it. A row the
    USER's saved override produced is the user's, and stays current."""
    out = V.one_tap(app, V.agras_workbook(), "balanta.xlsx", on_screen=V.ORG_AGRAS)
    V.run_analysis(gw, out["commit"]["document_id"])
    no_quota()
    (period,) = gw.db.rows("financial_periods")
    pid = period["id"]
    (fresh,) = R.run(apply=False, period=pid)
    assert fresh["status"] == R.CURRENT, fresh
    (vrow,) = gw.db.rows("valuations")
    engine_ebitda = vrow["ebitda_used"]
    vrow["ebitda_used"] = 10776378.24
    snapshot = _tables(gw)
    (row,) = R.run(apply=False, period=pid)
    assert _tables(gw) == snapshot, "the dry run wrote"
    assert row["status"] == R.WOULD_REPROCESS, row
    assert row["valuation"]["current"] is False
    (applied,) = R.run(apply=True, period=pid)
    assert applied["status"] == R.REPROCESSED, applied
    (vrow,) = gw.db.rows("valuations")
    assert vrow["ebitda_used"] == pytest.approx(engine_ebitda, abs=0.005)
    # The user's override: the row persisted on the user's typed EBITDA.
    gw.db.add("user_valuation_assumptions", {"user_id": V.USER, "period_id": pid,
                                             "ebitda_used": 9_000_000.0, "multiple_used": None,
                                             "debt_used": None, "cash_used": None, "notes": None,
                                             "ebitda_definition": None, "updated_at": None})
    vrow["ebitda_used"] = 9_000_000.0
    (user_row,) = R.run(apply=False, period=pid)
    assert user_row["status"] == R.CURRENT, user_row
    assert user_row["valuation"]["user_ebitda"] == 9_000_000.0
    assert "user override EBITDA 9,000,000.00" in R.render([user_row])
    WORK["units"] += 8


def test_an_apply_that_could_not_rewrite_the_valuations_row_says_so(app, gw, no_quota, monkeypatch):
    """`_compute_and_persist_valuation` swallows its failures (non-fatal):
    an apply whose valuation write failed reported REPROCESSED over a row
    still on the previous EBITDA (critic round 3, 2026-09-28). The apply
    reads the row back: not on the fresh EBITDA -> refused,
    `valuation_not_rewritten`, with what it read; the period stays not
    current, so the next run retries it."""
    from engine.api import _valuation as VAL

    world = _analysed_pre_ruling(app, gw)
    no_quota()
    pid = world["period"]["id"]

    def down(*_a, **_k):
        raise RuntimeError("valuations table unreachable")

    with monkeypatch.context() as mp:
        mp.setattr(VAL, "persist_valuation", down)
        (row,) = R.run(apply=True, period=pid)
    assert row["status"] == R.REFUSED and row["reason"] == "valuation_not_rewritten", row
    assert row["valuation"]["ebitda_used_read_back"] == pytest.approx(10776378.24, abs=0.005), row
    (again,) = R.run(apply=False, period=pid)
    assert again["status"] == R.WOULD_REPROCESS, again
    WORK["units"] += 3


def test_a_document_that_needs_the_model_is_refused_and_nothing_is_written(app, gw, no_quota):
    no_quota()
    doc = gw.db.add("documents", {
        "id": None, "org_id": V.ORG_AGRAS, "uploaded_by": V.USER,
        "storage_path": "%s/uploads/scan.png" % V.ORG_AGRAS, "original_filename": "scan.png",
        "mime_type": "image/png", "size_bytes": 4, "status": "analyzed"})
    gw.db.storage["documents/%s" % doc["storage_path"]] = b"\x89PNG"
    period = gw.db.add("financial_periods", {
        "id": None, "org_id": V.ORG_AGRAS, "source_document_id": doc["id"],
        "period_start": "2025-12-31", "period_end": "2025-12-31", "currency": "RON",
        "assembled_canonical_v1": None, "updated_at": "2026-02-01T00:00:00+00:00"})
    snapshot = _tables(gw)
    (row,) = R.run(apply=True, period=period["id"])
    assert (row["status"], row["reason"]) == (R.REFUSED, "needs_model"), row
    assert _tables(gw) == snapshot
    WORK["units"] += 2


def test_a_period_whose_document_now_resolves_to_another_month_is_refused(app, gw, no_quota):
    world = _analysed_pre_ruling(app, gw)
    no_quota()
    (period,) = gw.db.rows("financial_periods")
    period["period_end"] = "2025-11-30"
    snapshot = _tables(gw)
    (row,) = R.run(apply=True, period=world["period"]["id"])
    assert (row["status"], row["reason"]) == (R.REFUSED, "period_end_moved"), row
    assert row["resolved_end"] == "2025-12-31"
    assert _tables(gw) == snapshot
    WORK["units"] += 3


def test_a_turnover_move_blocks_the_apply_until_it_is_ruled(app, gw, no_quota, capsys):
    world = _analysed_pre_ruling(app, gw)
    no_quota()
    pid = world["period"]["id"]
    (period,) = gw.db.rows("financial_periods")
    # An older parser's turnover (the Carniprod 7c29a71b shape): the fresh
    # run reads a different one.
    period["assembled_canonical_v1"]["methodology"]["totals"]["revenue_net"] = 99_424_740.16
    snapshot = _tables(gw)
    assert R.main(["--apply", "--period", pid]) == 3
    assert _tables(gw) == snapshot, "a blocked apply wrote"
    assert "TURNOVER MOVED: no_filed_figure" in capsys.readouterr().out
    # Moving AWAY from a known filed figure still blocks …
    assert R.main(["--apply", "--period", pid, "--filed", "%s=99424740.16" % pid]) == 3
    assert _tables(gw) == snapshot
    # … moving TOWARD it is the ruled correction and applies.
    assert R.main(["--apply", "--period", pid, "--filed", "%s=110798309" % pid]) == 0
    (period,) = gw.db.rows("financial_periods")
    assert "stock_variation" in period["assembled_canonical_v1"]
    WORK["units"] += 4


def test_a_period_stamped_with_the_previous_definition_is_reprocessed(app, gw, no_quota):
    """R2 / R3 (owner rulings 2026-09-28) moved the definition stamp. A period
    analysed under 2026-09-26 carries the evidence blocks, the running
    parser's stamp and figures a fresh run would reproduce — except EBITDA,
    which the ruling moved. It is NOT current: the dry run names the stamp
    it was written under, the apply restamps it and moves its EBITDA and
    metric rows to the new definition, and a second run finds it current."""
    from engine.country_packs.ro_romania.chart_of_accounts import (
        EBITDA_DEFINITION_PREVIOUS_REVISIONS, EBITDA_DEFINITION_REVISION)

    out = V.one_tap(app, V.agras_workbook(), "balanta.xlsx", on_screen=V.ORG_AGRAS)
    V.run_analysis(gw, out["commit"]["document_id"])
    no_quota()
    (period,) = gw.db.rows("financial_periods")
    pid = period["id"]
    previous = EBITDA_DEFINITION_PREVIOUS_REVISIONS[-1]
    assert previous != EBITDA_DEFINITION_REVISION
    # What the 2026-09-26 analysis stored: its stamp and its EBITDA (the
    # 7814.01 reversal inside) — everything else as a fresh run reads it.
    env = period["assembled_canonical_v1"]
    env["methodology"]["ebitda_definition"] = previous
    env["methodology"]["ebitda"]["reported"] = 11848065.27
    for m in gw.db.rows("calculated_metrics"):
        if m["name"] == "ebitda":
            m["value"] = 11848065.27
    (vrow,) = gw.db.rows("valuations")
    vrow["ebitda_used"] = 11848065.27
    snapshot = _tables(gw)
    (row,) = R.run(apply=False, period=pid)
    assert _tables(gw) == snapshot, "the dry run wrote"
    assert row["status"] == R.WOULD_REPROCESS, row
    assert row["before"]["definition"] == previous
    assert row["before"]["definition_current"] is False
    assert row["before"]["has_evidence"] and row["before"]["parser_current"]
    assert row["turnover_move"] is None, row
    text = R.render([row])
    for needle in ("definition %s -> %s" % (previous, EBITDA_DEFINITION_REVISION),
                   "EBITDA 11,848,065.27 -> 11,844,076.57",
                   "net provisions (outside EBITDA) 131,394.66 · EBIT 8,892,718.88"):
        assert needle in text, (needle, text)
    (applied,) = R.run(apply=True, period=pid)
    assert applied["status"] == R.REPROCESSED, applied
    (period,) = gw.db.rows("financial_periods")
    meth = period["assembled_canonical_v1"]["methodology"]
    assert meth["ebitda_definition"] == EBITDA_DEFINITION_REVISION
    assert meth["ebitda"]["reported"] == pytest.approx(11844076.57, abs=0.005)
    metrics = dict((m["name"], m["value"]) for m in gw.db.rows("calculated_metrics")
                   if m["period_id"] == pid)
    assert metrics["ebitda"] == pytest.approx(11844076.57, abs=0.005)
    (vrow,) = gw.db.rows("valuations")
    assert vrow["ebitda_used"] == pytest.approx(11844076.57, abs=0.005), vrow
    (again,) = R.run(apply=False, period=pid)
    assert again["status"] == R.CURRENT, again
    WORK["units"] += 14


def test_a_turnover_move_of_exactly_the_placed_7411_is_the_ruling_not_a_block():
    """R3: 7411 entered net turnover. On a period written under an earlier
    definition a move of EXACTLY the 7411 the fresh run placed inside
    turnover is the ruling (`definition_7411`) and does not block; a move of
    any other size, a move on a period already on the current definition,
    and a move away from a NAMED filed figure still block."""
    v = R._turnover_verdict
    assert v(100.0, 100.0, None, placed_7411=0.0, earlier_definition=True) is None
    assert v(100.0, 125.5, None, placed_7411=25.5, earlier_definition=True) == "definition_7411"
    assert v(100.0, 125.51, None, placed_7411=25.5, earlier_definition=True) == "no_filed_figure"
    assert v(100.0, 125.5, None, placed_7411=25.5, earlier_definition=False) == "no_filed_figure"
    assert v(100.0, 125.5, None, placed_7411=0.0, earlier_definition=True) == "no_filed_figure"
    # A named filed figure judges first.
    assert v(100.0, 125.5, 126.0, placed_7411=25.5, earlier_definition=True) == "toward_filed"
    assert v(100.0, 125.5, 90.0, placed_7411=25.5, earlier_definition=True) == "away_from_filed"
    rows = [{"turnover_move": m} for m in
            (None, "toward_filed", "definition_7411", "no_filed_figure", "away_from_filed")]
    assert [r["turnover_move"] for r in R.blocking(rows)] == ["no_filed_figure", "away_from_filed"]
    WORK["units"] += 9


def test_the_dry_run_names_the_stock_build_regime():
    """R1 (2026-09-28): the dry run the owner reviews before the deploy
    names each period's credit regime — for the stock-build regime its
    trigger shares, its cash status, the cash components it refused and the
    finding (the owner's sentence) — and names none on a standard book. The
    credit line carries the model revision on both sides."""
    import _served_books as SB

    dev, _rows = R._fresh_view(SB.book("realestate").persist_assembled)
    reg = dev["credit_regime"]
    assert reg is not None and reg["code"] == "stock_build", reg
    assert reg["cash_status"] == "approximated" and reg["refused"] == ["coverage", "dscr", "leverage"], reg
    assert reg["finding"]["ro"] == ("EBITDA pozitivă din stocuri capitalizate — numerarul a fost "
                                    "consumat de construcție."), reg
    assert dev["composite"] is None and dev["letter"] is None and dev["credit_model_revision"] == 5
    ag, _rows = R._fresh_view(SB.book("agras").persist_assembled)
    assert ag["credit_regime"] is None and ag["composite"] is not None
    row = {"period_id": "p-dev", "period_end": "2025-12-31", "status": R.WOULD_REPROCESS,
           "before": {"composite": 41.5, "letter": "B", "altman_z": 4.81, "credit_model_revision": 4},
           "after": dev}
    text = R.render([row])
    assert reg["finding_withheld"] is None, reg
    for needle in ("credit 41.50 B z 4.81 -> REFUSED (no composite, no letter) z 2.43 (model revision 4 -> 5)",
                   "credit regime stock_build: net_711_to_turnover 182.24 >= 1.0, "
                   "net_711_to_operating_expense 1.01 >= 0.10 · cash approximated · "
                   "refused: coverage, dscr, leverage",
                   "finding: EBITDA pozitivă din stocuri capitalizate"):
        assert needle in text, (needle, text)
    assert "credit regime" not in R.render([dict(row, after=ag)])
    # fixer round 1: a regime whose sentence the served figures contradict
    # prints the withheld premise by name, never the sentence.
    withheld = dict(dev, credit_regime=dict(reg, finding=None,
                                            finding_withheld=["ebitda_positive"]))
    wtext = R.render([dict(row, after=withheld)])
    assert "finding withheld (the served figures contradict it): ebitda_positive" in wtext, wtext
    assert "EBITDA pozitivă din stocuri capitalizate" not in wtext, wtext
    WORK["units"] += 14


def test_zz_scope(capsys):
    with capsys.disabled():
        print("\nSCOPE reprocess-periods-definition: corpus/saga_10_col_agras analysed by the "
              "real pipeline over the workspace-v2 tenancy double, shaped pre-ruling; "
              "GATE-WORK reprocess-periods-definition units=%d" % WORK["units"])
    assert WORK["units"] >= 72
