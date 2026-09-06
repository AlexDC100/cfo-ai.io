"""engine.firm.digest — the item view, the ONE order, the digest.

Fixtures are REAL BOARD OUTPUT (TC-1): the real attention runner over
the corpus served envelopes + regression statements. The key property
asserted is that this module's order IS the board's order: for every
client row, the items restricted to that client come out in the exact
sequence engine.firm.dedup ranked them.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from engine.firm import attention as A
from engine.firm import dedup
from engine.firm import digest as DG
from engine.firm import model as M

REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "corpus"
BASELINES = REPO / "src" / "engine" / "country_packs" / "ro_romania" / "fixtures" / "regression_baselines"
AS_OF = date(2026, 9, 3)
NAMES = {"org-carni": "Carniprod SRL", "org-agras": "Agras SA"}


def _client(case, baseline, org_id, name, period_end):
    served = json.loads((CORPUS / case / "expected" / "served_envelope.json").read_text("utf-8"))
    statements = json.loads((BASELINES / (baseline + ".json")).read_text("utf-8"))["assembled"]["statements"]
    env = {"canonical_bs": served, "provenance": {"content_hash": "sha256-" + case}}
    return M.ClientRecord(client_id=org_id, client_name=name, jurisdiction="RO",
                          periods=(M.PeriodRecord(period_id="p-" + org_id, period_end=period_end,
                                                  envelope=env, statements=statements,
                                                  updated_at="t"),))


@pytest.fixture(scope="module")
def report():
    return A.compute_firm_attention([
        _client("saga_10_col_carniprod", "carniprod_fy2025", "org-carni", "Carniprod SRL", "2025-12-31"),
        _client("saga_10_col_agras", "agras_fy2025", "org-agras", "Agras SA", "2026-06-30"),
    ], as_of=AS_OF)


@pytest.fixture(scope="module")
def items(report):
    views, refusals = DG.items_from_report(report)
    assert refusals == []
    return views


# ── the view over board items ────────────────────────────────────────────


def test_every_board_item_becomes_a_view(report, items):
    assert len(items) == report.counts()["items"] >= 10
    ids = [it.item_id for it in items]
    assert len(set(ids)) == len(ids)
    for it in items:
        assert it.client_name in NAMES.values()
        assert it.reason and it.route.startswith("/firm/clients/")
        assert it.item_id.startswith(it.kind + ":" + it.client_org_id + ":")


def test_evidence_becomes_typed_facts_with_provenance(items):
    money = [(it, f) for it in items for f in it.facts if f.kind == "money"]
    assert money, "the board cites money somewhere"
    it, f = money[0]
    assert f.currency == "RON" and f.provenance.get("period_id")
    assert f.name in it.facts_used and f.render().startswith("RON ")
    labels = [f for it in items for f in it.facts if f.kind == "label"]
    assert labels and all(f.render() for f in labels)
    counts = [f for it in items for f in it.facts if f.kind == "count"]
    assert counts and all("days" in f.unit or f.unit == "" for f in counts)


def test_the_headline_is_reason_plus_rendered_evidence(items):
    it = [i for i in items if i.facts][0]
    assert it.headline.startswith(it.reason + " — ")
    for name in it.facts_used:
        assert it.fact(name).render() in it.evidence_line


def test_the_order_is_the_boards_order(report, items):
    """For each client row, this module's deterministic order restricted
    to that client reproduces engine.firm.dedup's ranking exactly."""
    ordered = DG.deterministic_order(items, AS_OF)
    for row in report.rows:
        mine = [it.item_id for it in ordered if it.client_org_id == row.client_id]
        theirs = [DG.board_item_id(i.kind, i.client_id, i.scope_key) for i in row.items]
        assert mine == theirs, row.client_id


def test_the_order_is_severity_then_due_then_kind_then_client(items):
    ordered = DG.deterministic_order(items, AS_OF)
    keys = [DG.priority_key(it, AS_OF) for it in ordered]
    assert keys == sorted(keys)
    sev = [DG.SEVERITY_RANK[it.severity] for it in ordered]
    assert sev == sorted(sev)


def test_groups_partition_the_order(items):
    ordered = DG.deterministic_order(items, AS_OF)
    groups = DG.group_items(ordered, AS_OF)
    assert [g.key for g in groups] == ["act_now", "this_week", "later"]
    flat = [it.item_id for g in groups for it in g.items]
    assert sorted(flat) == sorted(it.item_id for it in ordered)
    assert len(flat) == len(ordered)
    for it in groups[0].items:
        assert it.severity == "critical" or DG.due_status(it, AS_OF)[0] == 0


def test_item_set_hash_is_order_independent(items):
    assert DG.item_set_hash(items) == DG.item_set_hash(list(reversed(items)))
    assert DG.item_set_hash(items) != DG.item_set_hash(items[:-1])


# ── refusals ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("raw, needle", [
    ({"client_id": "c", "scope_key": "s", "reason": "r", "kind": "bad kind", "severity": "high"}, "UPPER_SNAKE"),
    ({"client_id": "c", "scope_key": "s", "reason": "r", "kind": "MISSING_FILE", "severity": "urgent"}, "severity"),
    ({"client_id": "c", "scope_key": "s", "reason": "r", "kind": "MISSING_FILE", "severity": "high"}, "client name"),
    ({"client_id": "c", "client_name": "C", "scope_key": "s", "reason": "", "kind": "MISSING_FILE", "severity": "high"}, "reason"),
    ({"client_id": "c", "client_name": "C", "scope_key": "s", "reason": "r", "kind": "MISSING_FILE",
      "severity": "high", "evidence": [{"fact": "x", "unit": "furlongs", "value": 1}]}, "unit the model does not declare"),
    ({"client_id": "c", "client_name": "C", "scope_key": "s", "reason": "r", "kind": "MISSING_FILE",
      "severity": "high", "evidence": [{"fact": "x", "unit": "money", "value": 1}]}, "currency"),
    ({"item_id": "X", "kind": "FILE_REQUESTED", "severity": "low", "client_org_id": "c",
      "client_name": "C", "reason": "r", "route": "nope"}, "route"),
    ("not a mapping", "mapping"),
])
def test_a_bad_item_is_refused_with_a_reason(raw, needle):
    with pytest.raises(DG.ItemContractError) as exc:
        DG.coerce_item(raw)
    assert needle in str(exc.value)


def test_refusals_are_recorded_never_dropped(items):
    raws = [it.to_payload() for it in items[:3]] + [{"item_id": "bad"}] + [items[0].to_payload()]
    views, refusals = DG.coerce_items(raws)
    assert len(views) == 3
    assert "kind" in refusals[0].reason and refusals[0].item_id == "bad"
    assert refusals[1].reason == "duplicate item_id" and refusals[1].item_id == items[0].item_id
    digest = DG.build_digest(raws, AS_OF)
    assert digest.counts["refused"] == 2 and len(digest.refusals) == 2


def test_an_absent_fact_is_withheld_not_zero():
    it = DG.coerce_item({"item_id": "K:c:s", "kind": "KIND_X", "severity": "low", "client_org_id": "c",
                         "client_name": "C", "reason": "r", "route": "/firm/clients/c",
                         "facts": {"cash": {"kind": "money", "currency": "RON", "amount": None},
                                   "n": {"kind": "count", "value": 3, "unit": "days"}}})
    assert it.figures_withheld == ("cash",) and it.facts_used == ("n",)
    assert "3 days" in it.evidence_line and "0" not in it.evidence_line.replace("3 days", "")


# ── the digest ───────────────────────────────────────────────────────────


def test_digest_new_since_last_is_keyed_on_item_ids(report, items):
    ordered = DG.deterministic_order(items, AS_OF)
    seen = [it.item_id for it in ordered[:5]]
    digest = DG.build_digest(report.items(), AS_OF, seen_ids=seen, client_names=NAMES,
                             kind_order=DG.kind_order_from_report(report))
    assert digest.counts["items"] == len(items)
    assert digest.counts["shown"] == len(items) - 5
    assert digest.counts["new"] == len(items) - 5
    shown = [ln.item_id for s in digest.sections for ln in s.lines]
    assert not set(shown) & set(seen)
    assert all(ln.is_new for s in digest.sections for ln in s.lines)
    assert set(digest.item_ids) == set(it.item_id for it in items), "item_ids carries the whole set"
    everything = DG.build_digest(report.items(), AS_OF, seen_ids=[it.item_id for it in items],
                                 client_names=NAMES)
    assert everything.is_empty and everything.counts["shown"] == 0
    assert "nothing new" in DG.digest_subject(everything)


def test_digest_sections_follow_the_order_and_carry_routes(report, items):
    digest = DG.build_digest(report.items(), AS_OF, client_names=NAMES,
                             kind_order=DG.kind_order_from_report(report))
    ordered = DG.deterministic_order(items, AS_OF)
    assert digest.sections[0].client_org_id == ordered[0].client_org_id
    for section in digest.sections:
        assert section.route == "/firm/clients/%s" % section.client_org_id
        for ln in section.lines:
            assert ln.route.startswith("/firm/clients/%s/" % section.client_org_id)
            assert ln.rationale and ln.text
    text = DG.render_digest_text(digest, "https://cfo-ai.io")
    assert "https://cfo-ai.io/firm/clients/org-carni" in text
    assert "Advisory summary: not shown" in text
    html = DG.render_digest_email(digest, "https://cfo-ai.io")
    assert "/firm/clients/org-carni" in html and "<html" in html
    assert "Firm digest" in html


def test_digest_bytes_are_deterministic(report):
    a = DG.build_digest(report.items(), AS_OF, client_names=NAMES).to_payload()
    b = DG.build_digest(list(reversed(report.items())), AS_OF, client_names=NAMES).to_payload()
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def test_ai_summary_is_refused_without_the_guards_receipt(report):
    digest = DG.build_digest(report.items(), AS_OF, client_names=NAMES)
    unguarded = DG.attach_ai_summary(digest, DG.AiSummary(available=True, text="Two clients.", guarded=False))
    assert unguarded.ai_summary.available is False and "guard" in unguarded.ai_summary.reason
    digit = DG.attach_ai_summary(digest, DG.AiSummary(available=True, text="Cash is 12.", guarded=True))
    assert digit.ai_summary.available is False and "no fact backs" in digit.ai_summary.reason
    ok = DG.attach_ai_summary(digest, DG.AiSummary(available=True, text="Beta first, then Alpha.",
                                                   guarded=True))
    assert ok.ai_summary.available is True
    resolved = DG.attach_ai_summary(digest, DG.AiSummary(available=True, text="Drift is RON 1,000.00.",
                                                         guarded=True, facts_used=("i1__drift",)))
    assert resolved.ai_summary.available is True
    assert "AI summary (advisory)" in DG.render_digest_text(ok)


def test_the_open_request_item():
    it = DG.item_for_open_request({"id": "req-9", "client_org_id": "org-a", "period_end": "2026-07-31",
                                   "requested_at": "2026-08-25T10:00:00+00:00", "reminder_count": 1,
                                   "status": "reminded", "expires_at": "2026-09-08T10:00:00+00:00"},
                                  "Alpha SRL", AS_OF)
    assert it.kind == DG.KIND_FILE_REQUESTED and it.severity == "medium"
    assert it.fact("requested_ago_days").value == 9 and it.fact("reminders_sent").value == 1
    assert it.due_by == date(2026, 9, 8) and it.route == "/firm/clients/org-a/requests"
    assert "2026-07-31" in it.evidence_line


def test_the_pack_kind_order_is_read_from_the_report(report):
    order = DG.kind_order_from_report(report)
    assert order and order == DG.kind_order_from_report(report.to_payload())
    assert order["MISSING_FILE"] < order["DEADLINE"]


def test_a_board_item_object_is_accepted_directly(report):
    board_item = report.items()[0]
    view = DG.coerce_item(board_item, client_names=NAMES)
    assert view.item_id == DG.board_item_id(board_item.kind, board_item.client_id, board_item.scope_key)
    assert view.severity == board_item.severity and view.reason == board_item.reason


def test_dismissed_critical_is_flagged_not_reordered(items):
    crit = [it for it in items if it.severity == "critical"][0]
    raw = crit.to_payload()
    raw["dismissed"] = True
    dismissed = DG.coerce_item(raw)
    others = [it for it in items if it.item_id != crit.item_id]
    order_a = [it.item_id for it in DG.deterministic_order(others + [crit], AS_OF)]
    order_b = [it.item_id for it in DG.deterministic_order(others + [dismissed], AS_OF)]
    assert order_a == order_b
    assert "dismissed" in DG.priority_rationale(dismissed, AS_OF)
