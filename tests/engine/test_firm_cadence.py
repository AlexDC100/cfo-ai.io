"""engine.firm.cadence — per-client filing cadence, under test.

What is asserted is the VERDICT TABLE, per cadence (TC-6: one recorded
expectation per component, not a floor on a sum), the ABSENT != ZERO
rule, the separation of history holes from the periods a client is
behind on, nudge idempotency, and the clock-free contract.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest
import yaml

from engine.firm import cadence as C

REPO = Path(__file__).resolve().parents[2]
AS_OF = date(2026, 9, 3)


@pytest.fixture(scope="module")
def pack() -> C.CadencePack:
    return C.load_cadence_pack()


@pytest.fixture(scope="module")
def monthly(pack) -> C.ClientCadence:
    return C.resolve_client_cadence("org-m", None, pack)


@pytest.fixture(scope="module")
def quarterly_fye6(pack) -> C.ClientCadence:
    return C.resolve_client_cadence("org-q", {"cadence": "quarterly", "fiscal_year_end_month": 6}, pack)


# ── the pack ─────────────────────────────────────────────────────────────


def test_the_pack_is_data_and_loads(pack):
    assert pack.default_cadence in pack.cadences
    assert set(pack.cadences) >= {"monthly", "quarterly"}
    assert pack.nudge_days_before_deadline == (7, 2)
    assert pack.request_link_ttl_days >= 1 and pack.lookback_periods >= 1
    assert pack.source.endswith("packs/firm/cadence.yaml")
    # no pack.yaml beside it: the jurisdiction-pack tooling must not see it
    assert not (REPO / "packs" / "firm" / "pack.yaml").exists()


@pytest.mark.parametrize("mutation, needle", [
    (lambda d: d.update(schema="wrong"), "schema"),
    (lambda d: d.update(default_cadence="weekly"), "default_cadence"),
    (lambda d: d["cadences"]["monthly"].update(period_months=5), "divide 12"),
    (lambda d: d["cadences"]["monthly"].update(deadline_days_after_period_end=0), ">= 1"),
    (lambda d: d.update(nudge_days_before_deadline=[7, 7]), "repeats"),
    (lambda d: d.update(nudge_days_before_deadline=[]), "non-empty"),
    (lambda d: d.pop("request_link_ttl_days"), "request_link_ttl_days"),
])
def test_a_malformed_pack_fails_loud(tmp_path, mutation, needle):
    raw = yaml.safe_load(C.default_pack_path().read_text("utf-8"))
    mutation(raw)
    path = tmp_path / "cadence.yaml"
    path.write_text(yaml.safe_dump(raw), encoding="utf-8")
    with pytest.raises(C.CadencePackError) as exc:
        C.load_cadence_pack(path)
    assert needle in str(exc.value)


def test_a_missing_pack_fails_loud(tmp_path):
    with pytest.raises(C.CadencePackError):
        C.load_cadence_pack(tmp_path / "nope.yaml")


def test_the_loaded_pack_is_a_copy(pack):
    other = C.load_cadence_pack()
    other.cadences["monthly"] = None  # type: ignore[assignment]
    assert C.load_cadence_pack().cadences["monthly"].period_months == 1


# ── resolving a client ───────────────────────────────────────────────────


def test_default_cadence_when_nothing_is_stored(monthly):
    assert monthly.cadence_id == "monthly" and monthly.source == "pack_default"
    assert monthly.deadline_days == 25 and monthly.fiscal_year_end_month == 12
    assert monthly.nudge_days == (7, 2)


def test_stored_row_overrides_field_by_field(pack):
    c = C.resolve_client_cadence("org-x", {"cadence": "quarterly",
                                            "deadline_days_after_period_end": 30,
                                            "fiscal_year_end_month": 3,
                                            "nudge_days_before": [10, 3, 3]}, pack)
    assert c.source == "stored" and c.period_months == 3
    assert c.deadline_days == 30 and c.fiscal_year_end_month == 3
    assert c.nudge_days == (10, 3)


@pytest.mark.parametrize("row", [
    {"cadence": "weekly"},
    {"cadence": "monthly", "fiscal_year_end_month": 13},
    {"cadence": "monthly", "deadline_days_after_period_end": 0},
    {"cadence": "monthly", "nudge_days_before": [0]},
])
def test_an_undefined_override_is_refused(pack, row):
    with pytest.raises(C.CadenceInputError):
        C.resolve_client_cadence("org-x", row, pack)


# ── calendar arithmetic ──────────────────────────────────────────────────


def test_month_ends_and_period_stepping(monthly, quarterly_fye6):
    assert C.month_end(2026, 2) == date(2026, 2, 28)
    assert C.month_end(2028, 2) == date(2028, 2, 29)
    assert C.next_period_end(monthly, date(2026, 1, 31)) == date(2026, 2, 28)
    assert C.previous_period_end(monthly, date(2026, 3, 31)) == date(2026, 2, 28)
    assert C.next_period_end(quarterly_fye6, date(2026, 6, 30)) == date(2026, 9, 30)
    assert C.previous_period_end(quarterly_fye6, date(2026, 3, 31)) == date(2025, 12, 31)


def test_quarter_ends_follow_the_fiscal_year_end(quarterly_fye6, pack):
    assert [m for m in range(1, 13) if C.is_period_end_month(quarterly_fye6, m)] == [3, 6, 9, 12]
    fye11 = C.resolve_client_cadence("org-y", {"cadence": "quarterly", "fiscal_year_end_month": 11}, pack)
    assert [m for m in range(1, 13) if C.is_period_end_month(fye11, m)] == [2, 5, 8, 11]


def test_deadline_is_period_end_plus_pack_days(monthly):
    assert C.deadline_for(monthly, date(2026, 8, 31)) == date(2026, 9, 25)
    assert C.deadline_for(monthly, date(2026, 2, 28)) == date(2026, 3, 25)


def test_latest_due_and_expected_window(monthly, quarterly_fye6):
    assert C.latest_due_period_end(monthly, AS_OF) == date(2026, 7, 31)
    assert C.latest_due_period_end(monthly, date(2026, 9, 26)) == date(2026, 8, 31)
    assert [d.isoformat() for d in C.expected_period_ends(monthly, AS_OF, 3)] == \
        ["2026-05-31", "2026-06-30", "2026-07-31"]
    assert [d.isoformat() for d in C.expected_period_ends(quarterly_fye6, AS_OF, 3)] == \
        ["2025-12-31", "2026-03-31", "2026-06-30"]
    with pytest.raises(C.CadenceInputError):
        C.expected_period_ends(monthly, AS_OF, 0)


# ── the verdict table (TC-6: per cadence) ────────────────────────────────

MONTHLY_TABLE = [
    # filed                      state          behind  overdue  basis         missing
    ([],                         "never_filed", None,   162,     "2026-02-28", 6),
    (["2026-07-31"],             "current",     0,      None,    None,         0),
    (["2026-08-31"],             "current",     0,      None,    None,         0),
    (["2026-06-30"],             "stale",       1,      9,       "2026-07-31", 1),
    (["2026-05-31"],             "stale",       2,      40,      "2026-06-30", 2),
    (["2025-12-31"],             "stale",       7,      162,     "2026-02-28", 6),
    (["2026-05-31", "2026-07-31"], "current",   0,      None,    None,         0),
]


@pytest.mark.parametrize("filed, state, behind, overdue, basis, missing", MONTHLY_TABLE)
def test_monthly_verdicts(monthly, pack, filed, state, behind, overdue, basis, missing):
    s = C.assess(monthly, filed, AS_OF, pack=pack)
    assert s.state == state
    assert s.periods_behind == behind
    assert s.days_overdue == overdue
    assert (s.overdue_basis.isoformat() if s.overdue_basis else None) == basis
    assert len(s.missing_period_ends) == missing
    assert s.latest_due_period_end == date(2026, 7, 31)
    assert s.latest_due_deadline == date(2026, 8, 25)


QUARTERLY_TABLE = [
    ([],             "never_filed", None, 496, "2025-03-31"),
    (["2026-06-30"], "current",     0,    None, None),
    (["2026-03-31"], "stale",       1,    40,  "2026-06-30"),
    (["2025-09-30"], "stale",       3,    221, "2025-12-31"),
]


@pytest.mark.parametrize("filed, state, behind, overdue, basis", QUARTERLY_TABLE)
def test_quarterly_verdicts(quarterly_fye6, pack, filed, state, behind, overdue, basis):
    s = C.assess(quarterly_fye6, filed, AS_OF, pack=pack)
    assert s.state == state and s.periods_behind == behind and s.days_overdue == overdue
    assert (s.overdue_basis.isoformat() if s.overdue_basis else None) == basis
    assert s.latest_due_period_end == date(2026, 6, 30)


def test_absent_is_not_zero(monthly, pack):
    s = C.assess(monthly, [], AS_OF, pack=pack)
    assert s.state == C.STATE_NEVER_FILED
    assert s.periods_behind is None, "no filing means UNKNOWN backlog, not zero"
    assert s.latest_filed_period_end is None


def test_history_gaps_are_separated_from_the_backlog(monthly, pack):
    """A client who filed July but never April is CURRENT; April is a
    history gap, not a period they are behind on."""
    s = C.assess(monthly, ["2026-07-31"], AS_OF, pack=pack)
    assert s.state == C.STATE_CURRENT and s.missing_period_ends == ()
    assert date(2026, 4, 30) in s.history_gaps
    s2 = C.assess(monthly, ["2026-05-31"], AS_OF, pack=pack)
    assert [d.isoformat() for d in s2.missing_period_ends] == ["2026-06-30", "2026-07-31"]
    assert date(2026, 4, 30) in s2.history_gaps and date(2026, 4, 30) not in s2.missing_period_ends


def test_the_open_period_is_reported_never_stale(monthly, pack):
    s = C.assess(monthly, ["2026-07-31"], AS_OF, pack=pack)
    assert s.open_period_end == date(2026, 8, 31) and s.open_period_filed is False
    assert s.next_period_end == date(2026, 9, 30) and s.next_deadline == date(2026, 10, 25)
    s2 = C.assess(monthly, ["2026-08-31"], AS_OF, pack=pack)
    assert s2.open_period_filed is True and s2.state == C.STATE_CURRENT


def test_the_verdict_is_deterministic_and_serialises(monthly, pack):
    a = C.assess(monthly, ["2026-05-31", "2026-03-31"], AS_OF, pack=pack).to_payload()
    b = C.assess(monthly, ["2026-03-31", "2026-05-31"], AS_OF, pack=pack).to_payload()
    assert a == b
    assert a["state"] == "stale" and a["as_of"] == "2026-09-03"
    assert a["missing_period_ends"] == ["2026-06-30", "2026-07-31"]


def test_bad_dates_are_refused(monthly, pack):
    with pytest.raises(C.CadenceInputError):
        C.assess(monthly, ["not-a-date"], AS_OF, pack=pack)
    with pytest.raises(C.CadenceInputError):
        C.assess(monthly, [], "yesterday", pack=pack)


# ── nudges ───────────────────────────────────────────────────────────────


def test_nudges_fire_before_the_deadline_once_each(monthly):
    assert C.nudges_due(monthly, [], date(2026, 9, 3)) == []
    first = C.nudges_due(monthly, [], date(2026, 9, 20))
    assert [n.days_before for n in first] == [7]
    assert first[0].period_end == date(2026, 8, 31) and first[0].deadline == date(2026, 9, 25)
    assert first[0].send_on == date(2026, 9, 18)
    # the 7-day one already sent: only the 2-day one is due on the 24th
    second = C.nudges_due(monthly, [], date(2026, 9, 24), already_sent=[("2026-08-31", 7)])
    assert [n.days_before for n in second] == [2]
    # both sent: nothing
    assert C.nudges_due(monthly, [], date(2026, 9, 24),
                        already_sent=[("2026-08-31", 7), ("2026-08-31", 2)]) == []
    # a filed period needs no nudge
    assert C.nudges_due(monthly, ["2026-08-31"], date(2026, 9, 24)) == []
    # past the deadline it is the STALE verdict's business, not a reminder's
    assert C.nudges_due(monthly, [], date(2026, 9, 26)) == []


def test_nudge_payload_and_key(monthly):
    n = C.nudges_due(monthly, [], date(2026, 9, 20))[0]
    assert n.key() == ("2026-08-31", 7)
    assert n.to_payload() == {"client_org_id": "org-m", "period_end": "2026-08-31",
                              "deadline": "2026-09-25", "days_before": 7, "send_on": "2026-09-18"}


# ── the contract of the file itself ──────────────────────────────────────


def test_cadence_reads_no_clock_and_no_engine_api():
    import ast

    source = (REPO / "src" / "engine" / "firm" / "cadence.py").read_text("utf-8")
    assert "date.today()" not in source and "datetime.now(" not in source
    imported = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            imported.extend(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.append(node.module or "")
    offenders = [m for m in imported if m.startswith("engine.api") or m.startswith("engine.ai")]
    assert not offenders, offenders
