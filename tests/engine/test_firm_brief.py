"""engine.api._firm_brief — the guard matrix, the cache, the facts map.

The FC8 gate (test_firm_gates.py) proves the properties on the real
board; this file pins the parser's individual refusals so a future
loosening of any one of them is a visible diff.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

import json
from datetime import date

import pytest

from engine.ai import numerals as N
from engine.api import _firm_brief as FB
from engine.firm import digest as DG

AS_OF = date(2026, 9, 3)


def _items():
    return DG.coerce_items([
        {"item_id": "CRITICAL_FINDING:org-b:x", "kind": "CRITICAL_FINDING", "severity": "critical",
         "client_org_id": "org-b", "client_name": "Beta SA",
         "reason": "Balance sheet control total drifts", "action": "Reconcile the classes",
         "route": "/firm/clients/org-b",
         "facts": {"drift": {"kind": "money", "label": "drift", "amount": 8562437.54, "currency": "RON"},
                   "drift_share": {"kind": "ratio", "label": "share", "value": 0.074},
                   "absent": {"kind": "money", "label": "absent", "amount": None, "currency": "RON"}}},
        {"item_id": "STALE_PERIOD:org-a:latest:2026-05-31", "kind": "STALE_PERIOD", "severity": "high",
         "client_org_id": "org-a", "client_name": "Alpha SRL", "due_by": "2026-08-25",
         "reason": "The latest attached period is older than the cadence allows",
         "action": "Request the missing months", "route": "/firm/clients/org-a",
         "facts": {"age_days": {"kind": "count", "label": "age", "value": 95, "unit": "days"},
                   "period": {"kind": "label", "label": "latest", "text": "2026-05-31"}}},
    ])[0]


@pytest.fixture()
def view():
    return FB.build_view(_items(), AS_OF, "firm-t")


def _draft(view, **over):
    ids = view.item_ids()
    d = {"opening": "Beta first, then Alpha.",
         "groups": [{"title": "Act now", "item_ids": [ids[0]],
                     "rationale": "The drift of {i1__drift} is {i1__drift_share} of the balance sheet."},
                    {"title": "This week", "item_ids": [ids[1]],
                     "rationale": "Alpha's latest period is {i2__period}, {i2__age_days} old."}],
         "suggested_order": ids}
    d.update(over)
    return d


def test_view_slugs_and_facts(view):
    assert view.slugs == {"CRITICAL_FINDING:org-b:x": "i1", "STALE_PERIOD:org-a:latest:2026-05-31": "i2"}
    assert isinstance(view.facts["i1__drift"], N.MoneyFact)
    assert isinstance(view.facts["i1__drift_share"], N.RatioFact)
    assert isinstance(view.facts["i2__age_days"], N.CountFact)
    assert isinstance(view.facts["i2__period"], N.LabelFact)
    assert view.facts["i1__absent"].is_absent()


def test_a_good_draft_renders_every_placeholder_from_its_fact(view):
    accepted, reasons = FB.validate_draft(_draft(view), view)
    assert reasons == [] and accepted is not None
    assert accepted["groups"][0]["rationale"] == \
        "The drift of RON 8,562,437.54 is 7.4% of the balance sheet."
    assert accepted["groups"][1]["rationale"] == "Alpha's latest period is 2026-05-31, 95 days old."
    assert accepted["facts_used"] == ["i1__drift", "i1__drift_share", "i2__age_days", "i2__period"]


@pytest.mark.parametrize("field, value, needle", [
    ("opening", "Drift is 8.5M.", "bare_numeral"),
    ("opening", "Drift is RON {i1__drift}.", "loose_currency_label"),
    ("opening", "Drift is {i1__nope}.", "unresolved_placeholder"),
    ("opening", "Absent is {i1__absent}.", "absent_fact"),
    ("opening", "", "not text"),
    ("opening", 42, "not text"),
    ("opening", "In 2026 things happen.", "bare_numeral"),
])
def test_every_numeral_defect_is_a_rejection(view, field, value, needle):
    accepted, reasons = FB.validate_draft(_draft(view, **{field: value}), view)
    assert accepted is None
    assert any(needle in r for r in reasons), reasons


def test_structural_defects_are_rejections(view):
    ids = view.item_ids()
    cases = [
        ({"groups": [{"title": "All", "item_ids": ids + ["ghost:1"], "rationale": "x"}]}, "unknown item_id"),
        ({"groups": [{"title": "One", "item_ids": ids[:1], "rationale": "x"}]}, "omit"),
        ({"groups": [{"title": "A", "item_ids": ids, "rationale": "x"},
                     {"title": "B", "item_ids": ids[:1], "rationale": "y"}]}, "repeat"),
        ({"groups": [{"title": "A", "item_ids": [], "rationale": "x"}]}, "no item_ids"),
        ({"groups": []}, "missing or empty"),
        ({"suggested_order": ids[:1]}, "permutation"),
        ({"suggested_order": ids + ids}, "permutation"),
        ({"suggested_order": "nope"}, "missing"),
    ]
    for over, needle in cases:
        accepted, reasons = FB.validate_draft(_draft(view, **over), view)
        assert accepted is None, over
        assert any(needle in r for r in reasons), (over, reasons)
    assert FB.validate_draft("text", view)[0] is None
    assert FB.validate_draft(None, view)[0] is None


def test_a_rejected_draft_never_returns_the_models_words(view):
    accepted, reasons = FB.validate_draft(_draft(view, opening="Secret 123 words"), view)
    assert accepted is None
    assert "Secret" not in " ".join(reasons)


def test_deterministic_payload_is_complete_without_a_model(view):
    payload = FB.brief_payload(view, FB._unavailable("dead", "credits_absent"))
    assert payload["degraded"] is True and payload["item_count"] == 2
    assert [r["rank"] for r in payload["order"]] == [1, 2]
    assert payload["order"][0]["slug"] == "i1" and payload["order"][0]["rationale"].startswith("critical")
    assert [g["key"] for g in payload["groups"]] == ["act_now", "this_week", "later"]
    assert payload["advisory"]["opening"] is None
    assert "Advisory brief: dead" == payload["notice"]


class _Stub(object):
    def __init__(self, payload):
        self.payload = payload
        self.calls = 0

    @property
    def messages(self):
        return self

    def create(self, **kwargs):
        self.calls += 1
        block = type("B", (), {"type": "text", "text": json.dumps(self.payload)})()
        return type("R", (), {"content": [block]})()


def test_cache_holds_only_a_brief_the_model_earned(tmp_path, view):
    store = FB.MemoryBriefStore()
    items = _items()
    dead = lambda: (_ for _ in ()).throw(RuntimeError("dead"))  # noqa: E731
    first = FB.compose_brief(items, AS_OF, "firm-t", client_factory=dead, store=store, state_dir=tmp_path)
    assert first["degraded"] is True and store.rows == {}, "a degraded brief is not cached"
    stub = _Stub(_draft(view))
    second = FB.compose_brief(items, AS_OF, "firm-t", client_factory=lambda: stub, store=store,
                              state_dir=tmp_path)
    assert second["advisory"]["available"] is True and second["cached"] is False
    assert len(store.rows) == 1 and stub.calls == 1
    third = FB.compose_brief(items, AS_OF, "firm-t", client_factory=dead, store=store, state_dir=tmp_path)
    assert third["cached"] is True and third["advisory"]["available"] is True
    forced = FB.compose_brief(items, AS_OF, "firm-t", client_factory=lambda: stub, store=store,
                              state_dir=tmp_path, force=True)
    assert forced["cached"] is False and stub.calls == 2
    # a different item set is a different key
    other = FB.compose_brief(items[:1], AS_OF, "firm-t", client_factory=dead, store=store,
                             state_dir=tmp_path)
    assert other["cached"] is False and other["degraded"] is True


def test_malformed_model_json_degrades(tmp_path):
    class _Garbage(_Stub):
        def create(self, **kwargs):
            block = type("B", (), {"type": "text", "text": "not json"})()
            return type("R", (), {"content": [block]})()

    brief = FB.compose_brief(_items(), AS_OF, "firm-t", client_factory=lambda: _Garbage(None),
                             state_dir=tmp_path)
    assert brief["degraded"] is True and brief["advisory"]["kind"] == "model_error"


def test_empty_item_set_needs_no_model(tmp_path):
    called = []
    brief = FB.compose_brief([], AS_OF, "firm-t", client_factory=lambda: called.append(1),
                             state_dir=tmp_path)
    assert called == [] and brief["item_count"] == 0
    assert brief["advisory"]["kind"] == "empty"


def test_summary_line_is_one_guarded_sentence(tmp_path):
    items = _items()
    ok = FB.ai_summary_line(items, AS_OF, client_factory=lambda: _Stub(
        {"summary": "Beta's drift of {i1__drift} comes before Alpha's stale books."}), state_dir=tmp_path)
    assert ok.available and ok.guarded and ok.facts_used == ("i1__drift",)
    assert "RON 8,562,437.54" in ok.text
    bad = FB.ai_summary_line(items, AS_OF, client_factory=lambda: _Stub({"summary": "Two of 3 clients."}),
                             state_dir=tmp_path)
    assert bad.available is False and "numeral guard" in bad.reason
    missing = FB.ai_summary_line(items, AS_OF, client_factory=lambda: _Stub({"nope": 1}), state_dir=tmp_path)
    assert missing.available is False


def test_mask_figures():
    assert FB.mask_figures("Period 2026-03-31 has 3 items, RON 1,200.50") == \
        "Period ‹figure› has ‹figure› items, RON ‹figure›"
    assert FB.mask_figures(None) == ""
