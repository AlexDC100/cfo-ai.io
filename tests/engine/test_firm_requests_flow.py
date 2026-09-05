"""engine.api._firm_requests — the nudge cron, the digest cron, the
email stub, the auth walls. All against the recorded fake of the thin
service-role client (tests/engine/firm_fakes.py); no network.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException

from engine.api import _firm_requests as FR
from engine.api import _org
from engine.firm import attention as A
from engine.firm import model as M

from firm_fakes import FakeAdmin, install

REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "corpus"
BASELINES = REPO / "src" / "engine" / "country_packs" / "ro_romania" / "fixtures" / "regression_baselines"
NOW = datetime(2026, 9, 20, 9, 0, tzinfo=timezone.utc)


def _open_request(**kw):
    row = {"id": "req-1", "firm_id": None, "client_org_id": "org-a", "period_end": "2026-08-31",
           "requested_by": "user-1", "requested_at": "2026-09-10T10:00:00+00:00",
           "expires_at": "2026-10-10T10:00:00+00:00", "token_hash": "h", "to_email": "client@x.ro",
           "status": FR.STATUS_REQUESTED, "reminder_count": 0, "reminders_sent": [],
           "expected_identity": {"name": "Alpha SRL", "cui": None}}
    row.update(kw)
    return row


def _fake(**tables):
    base = {"organizations": [{"id": "org-a", "name": "Alpha SRL", "archived_at": None},
                              {"id": "org-b", "name": "Beta SA", "archived_at": None}],
            "firm_file_request_tokens": [{"request_id": "req-1", "token": "tok.sig"}]}
    base.update(tables)
    return FakeAdmin(base)


# ── the nudge cron ───────────────────────────────────────────────────────


def test_nudge_cron_queues_the_seven_day_reminder_once():
    fake = _fake(firm_file_requests=[_open_request()])
    out = FR.run_nudge_cron(date(2026, 9, 20), NOW, fake)
    assert out == {"as_of": "2026-09-20", "open": 1, "reminders_queued": 1, "expired": 0}
    queue = fake.tables["firm_email_queue"]
    assert len(queue) == 1 and queue[0]["kind"] == FR.EMAIL_KIND_REMINDER
    vars_ = queue[0]["payload"]["vars"]
    assert vars_["upload_url"].endswith("/upload/request/tok.sig")
    assert vars_["days_to_deadline"] == 5 and vars_["client_name"] == "Alpha SRL"
    row = fake.tables["firm_file_requests"][0]
    assert row["status"] == FR.STATUS_REMINDED and row["reminder_count"] == 1
    assert row["reminders_sent"] == [["2026-08-31", 7]]
    # same day again: idempotent
    again = FR.run_nudge_cron(date(2026, 9, 20), NOW, fake)
    assert again["reminders_queued"] == 0 and len(fake.tables["firm_email_queue"]) == 1
    # the 2-day nudge on the 24th
    later = FR.run_nudge_cron(date(2026, 9, 24), NOW, fake)
    assert later["reminders_queued"] == 1
    assert fake.tables["firm_file_requests"][0]["reminders_sent"] == [["2026-08-31", 7], ["2026-08-31", 2]]


def test_nudge_cron_expires_dead_links_and_skips_them():
    fake = _fake(firm_file_requests=[_open_request(expires_at="2026-09-01T00:00:00+00:00")])
    out = FR.run_nudge_cron(date(2026, 9, 20), NOW, fake)
    assert out["expired"] == 1 and out["reminders_queued"] == 0
    assert fake.tables["firm_file_requests"][0]["status"] == FR.STATUS_EXPIRED


def test_nudge_cron_without_a_secret_token_records_no_link():
    fake = _fake(firm_file_requests=[_open_request()], firm_file_request_tokens=[])
    out = FR.run_nudge_cron(date(2026, 9, 20), NOW, fake)
    assert out["reminders_queued"] == 0
    assert "firm_email_queue" not in fake.tables
    # the nudge is still marked so the cron does not spin on it
    assert fake.tables["firm_file_requests"][0]["reminders_sent"] == [["2026-08-31", 7]]


def test_nudge_cron_is_quiet_before_the_window():
    fake = _fake(firm_file_requests=[_open_request()])
    out = FR.run_nudge_cron(date(2026, 9, 3), NOW, fake)
    assert out["reminders_queued"] == 0


# ── the digest cron ──────────────────────────────────────────────────────


def _client(case, baseline, org_id, name, period_end):
    served = json.loads((CORPUS / case / "expected" / "served_envelope.json").read_text("utf-8"))
    statements = json.loads((BASELINES / (baseline + ".json")).read_text("utf-8"))["assembled"]["statements"]
    return M.ClientRecord(client_id=org_id, client_name=name, jurisdiction="RO",
                          periods=(M.PeriodRecord(period_id="p-" + org_id, period_end=period_end,
                                                  envelope={"canonical_bs": served,
                                                            "provenance": {"content_hash": "h-" + case}},
                                                  statements=statements, updated_at="t"),))


@pytest.fixture(scope="module")
def provider():
    """A real board over real books, keyed by the requested client ids."""
    records = {"org-a": _client("saga_10_col_carniprod", "carniprod_fy2025", "org-a", "Alpha SRL", "2025-12-31"),
               "org-b": _client("saga_10_col_agras", "agras_fy2025", "org-b", "Beta SA", "2026-06-30")}

    def _provider(client_ids, as_of):
        return A.compute_firm_attention([records[c] for c in client_ids if c in records], as_of=as_of)

    return _provider


def _pref(**kw):
    row = {"id": "pref-1", "user_id": "user-1", "firm_id": None, "enabled": True, "frequency": "daily",
           "send_hour_utc": 7, "last_sent_at": None, "last_item_ids": []}
    row.update(kw)
    return row


def _memberships():
    return [{"user_id": "user-1", "org_id": "org-a", "created_at": "2026-01-01"},
            {"user_id": "user-1", "org_id": "org-b", "created_at": "2026-01-02"}]


def test_digest_cron_sends_nothing_without_opt_in(provider):
    fake = _fake(firm_digest_prefs=[_pref(enabled=False)], memberships=_memberships())
    out = FR.run_digest_cron(date(2026, 9, 20), NOW, fake, report_provider=provider,
                             email_of=lambda u: "acct@firm.ro")
    assert out["queued"] == 0 and out["prefs"] == 0
    assert "firm_email_queue" not in fake.tables


def test_digest_cron_queues_once_per_day_then_only_new_items(provider):
    fake = _fake(firm_digest_prefs=[_pref()], memberships=_memberships(),
                 firm_file_requests=[_open_request()])
    out = FR.run_digest_cron(date(2026, 9, 20), NOW, fake, report_provider=provider,
                             email_of=lambda u: "acct@firm.ro", app_url="https://cfo-ai.io")
    assert out["queued"] == 1, out
    queue = fake.tables["firm_email_queue"]
    assert len(queue) == 1 and queue[0]["kind"] == FR.EMAIL_KIND_DIGEST
    assert queue[0]["to_email"] == "acct@firm.ro"
    payload = queue[0]["payload"]
    assert payload["digest"]["counts"]["shown"] > 1
    assert "FILE_REQUESTED" in json.dumps(payload["digest"]["item_ids"])
    assert "https://cfo-ai.io/firm/clients/org-a" in payload["text"]
    pref = fake.tables["firm_digest_prefs"][0]
    assert pref["last_sent_at"] and len(pref["last_item_ids"]) == payload["digest"]["counts"]["items"]
    assert len(fake.tables["firm_digest_log"]) == 1
    # same day: skipped (last_sent_at today)
    again = FR.run_digest_cron(date(2026, 9, 20), NOW, fake, report_provider=provider,
                               email_of=lambda u: "acct@firm.ro")
    assert again["queued"] == 0 and again["skipped"] == 1
    # next day, same items: nothing new, nothing queued
    tomorrow = datetime(2026, 9, 21, 9, 0, tzinfo=timezone.utc)
    nxt = FR.run_digest_cron(date(2026, 9, 21), tomorrow, fake, report_provider=provider,
                             email_of=lambda u: "acct@firm.ro")
    assert nxt["queued"] == 0 and nxt["nothing_new"] == 1
    assert len(fake.tables["firm_email_queue"]) == 1


def test_digest_cron_respects_the_send_hour_and_weekly_frequency(provider):
    fake = _fake(firm_digest_prefs=[_pref(send_hour_utc=12)], memberships=_memberships())
    early = FR.run_digest_cron(date(2026, 9, 20), NOW, fake, report_provider=provider,
                               email_of=lambda u: "a@b")
    assert early["queued"] == 0 and early["skipped"] == 1
    fake2 = _fake(firm_digest_prefs=[_pref(frequency="weekly", last_sent_at="2026-09-16T07:00:00+00:00")],
                  memberships=_memberships())
    weekly = FR.run_digest_cron(date(2026, 9, 20), NOW, fake2, report_provider=provider,
                                email_of=lambda u: "a@b")
    assert weekly["queued"] == 0 and weekly["skipped"] == 1


def test_digest_cron_records_a_missing_email_as_a_gap(provider):
    fake = _fake(firm_digest_prefs=[_pref()], memberships=_memberships())
    out = FR.run_digest_cron(date(2026, 9, 20), NOW, fake, report_provider=provider,
                             email_of=lambda u: None)
    assert out["queued"] == 0 and out["gaps"] == 1 and out["notes"]


# ── the email stub ───────────────────────────────────────────────────────


def test_queued_request_and_reminder_emails_render_the_branded_body():
    subject, html = FR.render_queued_email({"kind": FR.EMAIL_KIND_REQUEST, "payload": {
        "subject": "S", "vars": {"client_name": "Alpha SRL", "firm_name": "Firma X",
                                 "period_end": "2026-08-31", "upload_url": "https://cfo-ai.io/upload/request/t",
                                 "expires_at": "2026-10-10T10:00:00+00:00", "note": "please"}}})
    assert subject == "S" and "Firma X asks for the trial balance for 2026-08-31" in html
    assert "upload/request/t" in html and "please" in html and "single-use" in html
    _s, reminder = FR.render_queued_email({"kind": FR.EMAIL_KIND_REMINDER, "payload": {
        "subject": "R", "vars": {"client_name": "Alpha SRL", "firm_name": "Firma X",
                                 "period_end": "2026-08-31", "upload_url": "u", "expires_at": "2026-10-10",
                                 "days_to_deadline": 5}}})
    assert "still needs the trial balance" in reminder and "in 5 day(s)" in reminder
    _s, digest = FR.render_queued_email({"kind": FR.EMAIL_KIND_DIGEST, "payload": {"subject": "D", "html": "<p>x</p>"}})
    assert digest == "<p>x</p>"


def test_queue_email_never_raises_when_the_table_is_missing():
    class _Broken(object):
        def insert(self, *a, **k):
            raise RuntimeError("no table")

    assert FR.queue_email(_Broken(), kind=FR.EMAIL_KIND_DIGEST, to_email="a@b", template="t",
                          payload={"subject": "s"}) is None


# ── labels, views ────────────────────────────────────────────────────────


def test_request_status_labels():
    today = date(2026, 9, 12)
    assert FR.request_status_label(_open_request(), today) == "requested 2d ago"
    assert FR.request_status_label(_open_request(status=FR.STATUS_REMINDED,
                                                 last_reminded_at="2026-09-11T00:00:00+00:00"), today) == "reminded 1d ago"
    assert FR.request_status_label(_open_request(requested_at="2026-09-12T08:00:00+00:00"), today) == "requested today"
    assert FR.request_status_label(_open_request(status=FR.STATUS_RECEIVED), today) == "received"
    view = FR.public_request_view(_open_request(), today)
    assert view["route"] == "/firm/clients/org-a/requests" and "token_hash" not in view


def test_open_request_items_only_for_open_rows():
    rows = [_open_request(), _open_request(id="req-2", status=FR.STATUS_RECEIVED)]
    items = FR.open_request_items(rows, {"org-a": "Alpha SRL"}, date(2026, 9, 12))
    assert [it.item_id for it in items] == ["FILE_REQUESTED:org-a:request:req-1"]


# ── auth walls ───────────────────────────────────────────────────────────


def test_authorize_client_without_a_firm_requires_client_membership(monkeypatch):
    monkeypatch.setattr(_org, "resolve_user_id", lambda jwt: "user-1")
    monkeypatch.setattr(_org, "user_is_member", lambda u, o: (u, o) == ("user-1", "org-a"))
    assert FR.authorize_client("jwt", None, "org-a", "request_file") == ("user-1", None)
    with pytest.raises(HTTPException) as exc:
        FR.authorize_client("jwt", None, "org-b", "request_file")
    assert exc.value.status_code == 403


def test_authorize_client_with_a_firm_uses_the_tenancy_walls(monkeypatch):
    from engine.api import _firm

    class _Ctx(object):
        user_id, firm_id, role = "user-1", "firm-1", "viewer"

    monkeypatch.setattr(_firm, "resolve_firm", lambda jwt, firm_id: _Ctx())
    monkeypatch.setattr(_firm, "require_client", lambda ctx, org_id: org_id)
    with pytest.raises(HTTPException) as exc:
        FR.authorize_client("jwt", "firm-1", "org-a", "request_file")
    assert exc.value.status_code == 403, "a viewer may not request a file"
    _Ctx.role = "accountant"
    assert FR.authorize_client("jwt", "firm-1", "org-a", "request_file") == ("user-1", "firm-1")


def test_crons_fail_closed_without_the_scheduler_token(monkeypatch):
    monkeypatch.delenv("ENGINE_API_TOKEN", raising=False)
    with pytest.raises(HTTPException) as exc:
        FR._scheduler_token_or_503("Bearer x")
    assert exc.value.status_code == 503
    monkeypatch.setenv("ENGINE_API_TOKEN", "secret")
    with pytest.raises(HTTPException) as exc:
        FR._scheduler_token_or_503("Bearer wrong")
    assert exc.value.status_code == 401
    assert FR._scheduler_token_or_503("Bearer secret") is None


def test_client_org_ids_for_lists_live_memberships(monkeypatch):
    install(monkeypatch, FakeAdmin({
        "memberships": _memberships() + [{"user_id": "user-1", "org_id": "org-z", "created_at": "2026-01-03"}],
        "organizations": [{"id": "org-a", "archived_at": None}, {"id": "org-b", "archived_at": None},
                          {"id": "org-z", "archived_at": "2026-05-01"}]}))
    assert FR.client_org_ids_for("user-1", None) == ["org-a", "org-b"]
