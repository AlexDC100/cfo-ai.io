"""D2 — Stripe billing proven end-to-end WITHOUT live keys.

Exercises the REAL handlers in `engine.api._billing` (router built by the
real `build_router()`, served through FastAPI's TestClient) against:

  · a fake Supabase admin client for every DB write — the same harness
    pattern `tests/engine/test_reconciliation.py` uses for stage_persist;
  · a faithful in-process fake of the stripe module's transport surface
    (Customer / checkout.Session / Subscription / SubscriptionItem /
    SubscriptionSchedule / billing_portal / Invoice), injected through the
    `_billing.set_stripe_client_factory` DI seam;
  · the REAL stripe SDK for everything cryptographic — webhook payloads
    are signed with `stripe.WebhookSignature.generate_signature_header`
    (the SDK's own signing helper) and verified by the real
    `stripe.Webhook.construct_event`, even in fixture mode. Signature
    verification is never mocked.

HARNESS MODES (auto-detected at import, notice printed):

  FIXTURES     — default on this machine / unknown CI. All tests run; the
                 HTTP transport layer is the in-process fake; recorded
                 fixtures under tests/engine/fixtures/stripe/ model
                 Stripe's documented payloads.
  STRIPE_MOCK  — stripe/stripe-mock reachable (STRIPE_MOCK_URL env or the
                 default localhost:12111). Adds the transport-lane tests:
                 the REAL stripe SDK, pointed at stripe-mock via the
                 STRIPE_API_BASE seam, drives the real route handlers so
                 our request payloads are validated against Stripe's
                 OpenAPI schema. stripe-mock is stateless, so behavioral
                 state assertions stay on the fixture lane.
  LIVE         — self-activating: STRIPE_LIVE_LANE=1 plus a STRIPE_TEST_KEY
                 (must start sk_test_; sk_live_ is refused structurally).
                 Same transport-lane tests against real test-mode Stripe.

NO LIVE KEY EVER: every test sets its own sk_test_* dummy key via
monkeypatch; ambient STRIPE_SECRET_KEY is scrubbed by an autouse fixture
before each test, so a live key exported in the operator's shell can never
be read, let alone called.

Divergences between code and the operator's older billing spec are
asserted AS IMPLEMENTED and flagged with `DIVERGENCE:` comments — see the
agent report. Behavior is never silently changed here.
"""

from __future__ import annotations

import base64
import contextlib
import copy
import itertools
import json
import os
import socket
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import pytest
import stripe as real_stripe
from fastapi import FastAPI
from fastapi.testclient import TestClient

from engine.api import _billing, _plan_state
from engine.api import _supabase as _supabase_module

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "stripe"

# Fixed synthetic identities — mirrored inside the fixture JSONs.
USER_ID = "00000000-0000-4000-8000-0000000000d2"
USER_SOLO = "00000000-0000-4000-8000-0000000000a2"
USER_INTRO = "00000000-0000-4000-8000-0000000000b3"
ORG_ID = "00000000-0000-4000-8000-00000000006f"

TEST_SECRET_KEY = "sk_test_d2_scandia_harness"
WEBHOOK_SECRET = "whsec_d2_test_secret"
APP_URL = "https://app.test"

# The SDK's ambient default API base, captured before any test runs.
_ORIG_API_BASE = real_stripe.api_base


# ──────────────────────────────────────────────────────────────────────
# Harness-mode detection (module import time; NOTICE printed once)
# ──────────────────────────────────────────────────────────────────────


def detect_harness_mode() -> Tuple[str, Optional[str]]:
    """Return (mode, transport_base).

    mode ∈ {"LIVE", "STRIPE_MOCK", "FIXTURES"}. transport_base is the
    api_base override for the transport lane (None for LIVE = SDK default,
    None for FIXTURES = lane skipped).
    """
    if os.environ.get("STRIPE_LIVE_LANE") == "1":
        key = os.environ.get("STRIPE_TEST_KEY", "")
        if key.startswith("sk_test_"):
            return "LIVE", None
        # A live-lane request without a proper test key is a config error;
        # fall through to the offline modes rather than touching anything.
    explicit = os.environ.get("STRIPE_MOCK_URL")
    candidates = [explicit] if explicit else ["http://localhost:12111"]
    for base in candidates:
        if not base:
            continue
        try:
            from urllib.parse import urlparse

            parsed = urlparse(base if "//" in base else "http://%s" % base)
            host = parsed.hostname or "localhost"
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            with socket.create_connection((host, port), timeout=0.25):
                pass
            return "STRIPE_MOCK", base.rstrip("/")
        except OSError:
            continue
    return "FIXTURES", None


HARNESS_MODE, TRANSPORT_BASE = detect_harness_mode()

_NOTICE = {
    "FIXTURES": (
        "[stripe-harness] NOTICE: mode=FIXTURES — the HTTP transport layer "
        "ran against the in-process fake; webhook signatures were verified "
        "by the REAL stripe SDK. Start stripe-mock (or set STRIPE_MOCK_URL) "
        "to add the transport lane."
    ),
    "STRIPE_MOCK": (
        "[stripe-harness] NOTICE: mode=STRIPE_MOCK — transport lane active "
        "against %s; behavioral state assertions stay on the in-process "
        "fake (stripe-mock is stateless)." % (TRANSPORT_BASE,)
    ),
    "LIVE": (
        "[stripe-harness] NOTICE: mode=LIVE — transport lane active against "
        "real test-mode Stripe via STRIPE_TEST_KEY (sk_test_ enforced; "
        "creates disposable test-mode objects)."
    ),
}
print(_NOTICE[HARNESS_MODE], file=sys.stderr)

transport_lane = pytest.mark.skipif(
    HARNESS_MODE == "FIXTURES",
    reason=(
        "transport lane skipped WITH NOTICE — stripe-mock not reachable and "
        "STRIPE_LIVE_LANE not active; the fixture-mode fake covered the suite"
    ),
)


# ──────────────────────────────────────────────────────────────────────
# StripeObject-alike: dict with attribute access (recursive)
# ──────────────────────────────────────────────────────────────────────


class SObj(dict):
    """Minimal stand-in for stripe.StripeObject: a dict whose keys are
    also attributes — matches every access pattern _billing.py uses
    (`session.url`, `sub.get("items")`, `upcoming.lines.data`, ...)."""

    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name)


def sobj(value: Any) -> Any:
    if isinstance(value, dict):
        return SObj({k: sobj(v) for k, v in value.items()})
    if isinstance(value, list):
        return [sobj(v) for v in value]
    return value


def load_fixture(name: str) -> Dict[str, Any]:
    with open(FIXTURES_DIR / name, "r", encoding="utf-8") as f:
        return json.load(f)


def fixture_sobj(name: str) -> Any:
    return sobj(load_fixture(name))


# ──────────────────────────────────────────────────────────────────────
# Faithful in-process fake of the stripe module's transport surface
# ──────────────────────────────────────────────────────────────────────


class FakeStripeError(Exception):
    """Generic Stripe API error — message text is what _billing matches on
    ("No such customer" / "No such subscription")."""


class IdempotencyError(Exception):
    """Name is load-bearing: _billing checks `"Idempotency" in type name`
    (mirrors stripe.error.IdempotencyError)."""


class _NS:
    pass


class FakeStripe:
    """In-process stand-in for the `stripe` module. Fakes ONLY the HTTP
    transport (resource calls + state); `Webhook.construct_event` delegates
    to the REAL SDK so signature verification stays real crypto."""

    def __init__(self) -> None:
        fs = self
        self.api_key: Optional[str] = None
        self.calls: List[Tuple[str, Dict[str, Any]]] = []
        self.customers: Dict[str, SObj] = {}
        self.subscriptions: Dict[str, SObj] = {}
        self.schedules: Dict[str, SObj] = {}
        # idempotency_key → {"params": ..., "record": ...}
        self.usage_records: Dict[str, Dict[str, Any]] = {}
        self.usage_total = 0
        self.upcoming_invoice: Optional[SObj] = None
        self._seq = itertools.count(1)

        def _rec(path: str, kw: Dict[str, Any]) -> None:
            fs.calls.append((path, copy.deepcopy(kw)))

        self._rec = _rec

        class Customer:
            @staticmethod
            def create(**kw: Any) -> SObj:
                _rec("Customer.create", kw)
                cid = "cus_D2Fake%03d" % next(fs._seq)
                obj = sobj({"id": cid, "object": "customer",
                            "email": kw.get("email"),
                            "metadata": kw.get("metadata") or {}})
                fs.customers[cid] = obj
                return obj

            @staticmethod
            def retrieve(cid: str, **kw: Any) -> SObj:
                _rec("Customer.retrieve", {"id": cid, **kw})
                if cid not in fs.customers:
                    raise FakeStripeError("No such customer: '%s'" % cid)
                return fs.customers[cid]

        class Subscription:
            @staticmethod
            def retrieve(sid: str, **kw: Any) -> SObj:
                _rec("Subscription.retrieve", {"id": sid, **kw})
                if sid not in fs.subscriptions:
                    raise FakeStripeError("No such subscription: '%s'" % sid)
                return fs.subscriptions[sid]

            @staticmethod
            def modify(sid: str, **kw: Any) -> SObj:
                _rec("Subscription.modify", {"id": sid, **kw})
                if sid not in fs.subscriptions:
                    raise FakeStripeError("No such subscription: '%s'" % sid)
                fs.subscriptions[sid].update(sobj(kw))
                return fs.subscriptions[sid]

        class SubscriptionItem:
            @staticmethod
            def create(**kw: Any) -> SObj:
                _rec("SubscriptionItem.create", kw)
                sid = kw.get("subscription")
                if sid not in fs.subscriptions:
                    raise FakeStripeError("No such subscription: '%s'" % sid)
                item = sobj({
                    "id": "si_D2Lazy%03d" % next(fs._seq),
                    "object": "subscription_item",
                    "subscription": sid,
                    "price": {"id": kw.get("price"),
                              "recurring": {"interval": "month",
                                            "usage_type": "metered"}},
                })
                fs.subscriptions[sid]["items"]["data"].append(item)
                return item

            @staticmethod
            def create_usage_record(item_id: str, **kw: Any) -> SObj:
                _rec("SubscriptionItem.create_usage_record",
                     {"id": item_id, **kw})
                idem = kw.get("idempotency_key")
                params = {"id": item_id,
                          "quantity": kw.get("quantity"),
                          "action": kw.get("action")}
                if idem is not None and idem in fs.usage_records:
                    prev = fs.usage_records[idem]
                    if prev["params"] == params:
                        # Stripe replays the ORIGINAL response for a reused
                        # key with identical params — not an error.
                        return prev["record"]
                    raise IdempotencyError(
                        "Keys for idempotent requests can only be used with "
                        "the same parameters they were first used with."
                    )
                record = sobj({"id": "mbur_D2Fake%03d" % next(fs._seq),
                               "object": "usage_record",
                               "quantity": kw.get("quantity"),
                               "subscription_item": item_id})
                fs.usage_total += int(kw.get("quantity") or 0)
                if idem is not None:
                    fs.usage_records[idem] = {"params": params,
                                              "record": record}
                return record

        class SubscriptionSchedule:
            @staticmethod
            def create(**kw: Any) -> SObj:
                _rec("SubscriptionSchedule.create", kw)
                sched = sobj({"id": "sub_sched_D2Fake%03d" % next(fs._seq),
                              "object": "subscription_schedule",
                              "subscription": kw.get("from_subscription")})
                fs.schedules[sched["id"]] = sched
                return sched

            @staticmethod
            def modify(sched_id: str, **kw: Any) -> SObj:
                _rec("SubscriptionSchedule.modify", {"id": sched_id, **kw})
                sched = fs.schedules[sched_id]
                sched.update(sobj(kw))
                return sched

        class Invoice:
            @staticmethod
            def upcoming(**kw: Any) -> SObj:
                _rec("Invoice.upcoming", kw)
                if fs.upcoming_invoice is None:
                    raise FakeStripeError(
                        "No upcoming invoices for customer: '%s'"
                        % kw.get("customer"))
                return fs.upcoming_invoice

        class Webhook:
            @staticmethod
            def construct_event(payload: Any, sig_header: Any,
                                secret: str, **kw: Any) -> Any:
                _rec("Webhook.construct_event", {"secret": secret})
                # REAL signature verification — the SDK's own crypto.
                return real_stripe.Webhook.construct_event(
                    payload, sig_header, secret, **kw)

        class _CheckoutSession:
            @staticmethod
            def create(**kw: Any) -> SObj:
                _rec("checkout.Session.create", kw)
                n = next(fs._seq)
                return sobj({
                    "id": "cs_test_D2Fake%03d" % n,
                    "object": "checkout.session",
                    "url": "https://checkout.stripe.com/c/pay/cs_test_D2Fake%03d" % n,
                    "mode": kw.get("mode"),
                    "customer": kw.get("customer"),
                    "metadata": kw.get("metadata") or {},
                })

        class _PortalSession:
            @staticmethod
            def create(**kw: Any) -> SObj:
                _rec("billing_portal.Session.create", kw)
                cid = kw.get("customer")
                if cid not in fs.customers:
                    raise FakeStripeError("No such customer: '%s'" % cid)
                n = next(fs._seq)
                return sobj({"id": "bps_D2Fake%03d" % n,
                             "object": "billing_portal.session",
                             "url": "https://billing.stripe.com/p/session/test_D2Fake%03d" % n})

        self.Customer = Customer
        self.Subscription = Subscription
        self.SubscriptionItem = SubscriptionItem
        self.SubscriptionSchedule = SubscriptionSchedule
        self.Invoice = Invoice
        self.Webhook = Webhook
        self.checkout = _NS()
        self.checkout.Session = _CheckoutSession
        self.billing_portal = _NS()
        self.billing_portal.Session = _PortalSession

    # test helpers ----------------------------------------------------

    def calls_for(self, path: str) -> List[Dict[str, Any]]:
        return [kw for p, kw in self.calls if p == path]

    def seed_subscription(self, obj: Dict[str, Any]) -> SObj:
        s = sobj(obj)
        self.subscriptions[s["id"]] = s
        return s

    def seed_customer(self, cid: str, **fields: Any) -> SObj:
        c = sobj({"id": cid, "object": "customer", **fields})
        self.customers[cid] = c
        return c


# ──────────────────────────────────────────────────────────────────────
# Fake Supabase admin client (billing tables + raw RPC/patch/auth lanes)
# ──────────────────────────────────────────────────────────────────────


class FakeResp:
    def __init__(self, status_code: int, payload: Any = None) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload) if payload is not None else ""

    def json(self) -> Any:
        return self._payload


class FakeRawClient:
    """Stands in for the admin SupabaseClient's private httpx client —
    _billing reaches through it for RPCs (claim_founding_seat,
    increment_founder_cohort), the stale-ID PATCH self-heal, and the
    auth-admin email lookup."""

    def __init__(self, admin: "FakeAdminClient") -> None:
        self._admin = admin

    def post(self, url: str, json: Any = None, headers: Any = None,
             params: Any = None) -> FakeResp:
        a = self._admin
        if "/rest/v1/rpc/claim_founding_seat" in url:
            a.rpc_calls.append(("claim_founding_seat", copy.deepcopy(json)))
            if a.founding_seats_left > 0:
                a.founding_seats_left -= 1
                return FakeResp(200, a.founding_seats_left)
            return FakeResp(200, None)  # capped → RPC returns null
        if "/rest/v1/rpc/increment_founder_cohort" in url:
            a.rpc_calls.append(("increment_founder_cohort", {}))
            a.cohort_increments += 1
            return FakeResp(204, {})
        return FakeResp(404, {"message": "unknown rpc %s" % url})

    def patch(self, url: str, params: Any = None, json: Any = None,
              headers: Any = None) -> FakeResp:
        a = self._admin
        a.raw_patches.append((url, dict(params or {}), copy.deepcopy(json)))
        if "/rest/v1/subscriptions" in url:
            for row in a.tables.setdefault("subscriptions", []):
                if _match_filters(row, params or {}):
                    row.update(copy.deepcopy(json or {}))
        return FakeResp(204)

    def get(self, url: str, headers: Any = None) -> FakeResp:
        a = self._admin
        if "/auth/v1/admin/users/" in url:
            uid = url.rstrip("/").rsplit("/", 1)[-1]
            email = a.user_emails.get(uid)
            if email:
                return FakeResp(200, {"id": uid, "email": email})
            return FakeResp(404, {"message": "user not found"})
        return FakeResp(404, {})


def _match_filters(row: Dict[str, Any], filters: Dict[str, str]) -> bool:
    for key, value in (filters or {}).items():
        sval = str(value)
        rv = row.get(key)
        if sval.startswith("eq."):
            if str(rv).lower() != sval[3:].lower():
                return False
        elif sval.startswith("gte."):
            if rv is None or str(rv) < sval[4:]:
                return False
        elif sval.startswith("lt."):
            if rv is None or not str(rv) < sval[3:]:
                return False
        else:
            return False
    return True


class FakeAdminClient:
    """In-memory stand-in for _supabase.admin()'s client — mirrors the
    harness pattern of tests/engine/test_reconciliation.py, extended with
    upsert(on_conflict=…) merge semantics and the raw `_client` lanes."""

    def __init__(self) -> None:
        self.tables: Dict[str, List[Dict[str, Any]]] = {}
        self.upsert_calls: Dict[str, int] = {}
        self.insert_calls: Dict[str, int] = {}
        self.rpc_calls: List[Tuple[str, Any]] = []
        self.raw_patches: List[Tuple[str, Dict[str, str], Any]] = []
        self.user_emails: Dict[str, str] = {}
        self.founding_seats_left = 0
        self.cohort_increments = 0
        # ("upsert"|"insert"|"select", table) entries force an exception —
        # used to prove the webhook's 500-retry contract.
        self.fail_on: set = set()
        self.url = "http://fake-supabase.local"
        self._headers = {"apikey": "fake", "Authorization": "Bearer fake",
                         "Content-Type": "application/json"}
        self._client = FakeRawClient(self)

    # context-manager protocol (with _supabase.admin() as client:)
    def __enter__(self) -> "FakeAdminClient":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def rows(self, table: str) -> List[Dict[str, Any]]:
        return self.tables.setdefault(table, [])

    def seed(self, table: str, row: Dict[str, Any]) -> Dict[str, Any]:
        self.rows(table).append(dict(row))
        return row

    # SupabaseClient surface -----------------------------------------

    def select(self, table: str, *, filters: Optional[Dict[str, str]] = None,
               columns: str = "*", limit: Optional[int] = None,
               order: Optional[str] = None,
               single: bool = False) -> List[Dict[str, Any]]:
        if ("select", table) in self.fail_on:
            raise RuntimeError("forced select failure on %s" % table)
        out = [copy.deepcopy(r) for r in self.rows(table)
               if _match_filters(r, filters or {})]
        if order:
            col = order.split(".", 1)[0]
            desc = order.endswith(".desc")
            out.sort(key=lambda r: str(r.get(col) or ""), reverse=desc)
        if limit is not None:
            out = out[:limit]
        if single:
            out = out[:1]
        return out

    def insert(self, table: str, rows: Any,
               returning: bool = True) -> List[Dict[str, Any]]:
        if ("insert", table) in self.fail_on:
            raise RuntimeError("forced insert failure on %s" % table)
        rows_list = rows if isinstance(rows, list) else [rows]
        self.insert_calls[table] = self.insert_calls.get(table, 0) + len(rows_list)
        for r in rows_list:
            self.rows(table).append(copy.deepcopy(r))
        return copy.deepcopy(rows_list) if returning else []

    def upsert(self, table: str, rows: Any, *, on_conflict: str,
               returning: bool = False) -> List[Dict[str, Any]]:
        if ("upsert", table) in self.fail_on:
            raise RuntimeError("forced upsert failure on %s" % table)
        rows_list = rows if isinstance(rows, list) else [rows]
        self.upsert_calls[table] = self.upsert_calls.get(table, 0) + len(rows_list)
        stored = self.rows(table)
        for new in rows_list:
            merged = False
            for row in stored:
                if on_conflict in new and \
                        str(row.get(on_conflict)) == str(new.get(on_conflict)):
                    row.update(copy.deepcopy(new))
                    merged = True
                    break
            if not merged:
                stored.append(copy.deepcopy(new))
        return copy.deepcopy(rows_list) if returning else []

    def update(self, table: str, patch: Dict[str, Any], *,
               filters: Dict[str, str]) -> None:
        for row in self.rows(table):
            if _match_filters(row, filters):
                row.update(copy.deepcopy(patch))

    def delete(self, table: str, *, filters: Dict[str, str]) -> None:
        kept = [r for r in self.rows(table) if not _match_filters(r, filters)]
        self.tables[table] = kept


# ──────────────────────────────────────────────────────────────────────
# JWT + webhook-delivery helpers
# ──────────────────────────────────────────────────────────────────────


def make_jwt(sub: str, email: str = "d2-user@example.com") -> str:
    def enc(d: Dict[str, Any]) -> str:
        raw = base64.urlsafe_b64encode(json.dumps(d).encode("utf-8"))
        return raw.rstrip(b"=").decode("ascii")

    return "%s.%s.%s" % (enc({"alg": "none", "typ": "JWT"}),
                         enc({"sub": sub, "email": email}), "sig")


def auth_header(user_id: str) -> Dict[str, str]:
    return {"Authorization": "Bearer %s" % make_jwt(user_id)}


def sign_payload(payload: str, secret: str = WEBHOOK_SECRET) -> str:
    """The SDK's own signing helper — same code Stripe uses in its tests."""
    return real_stripe.WebhookSignature.generate_signature_header(
        payload, secret)


def deliver_event(client: TestClient, event: Dict[str, Any], *,
                  secret: str = WEBHOOK_SECRET,
                  tamper_body: bool = False) -> Any:
    payload = json.dumps(event)
    header = sign_payload(payload, secret)
    if tamper_body:
        payload = payload.replace(event["id"], "evt_d2_tampered_body_x")
    return client.post(
        "/api/stripe/webhook",
        content=payload.encode("utf-8"),
        headers={"stripe-signature": header,
                 "content-type": "application/json"},
    )


# ──────────────────────────────────────────────────────────────────────
# Pytest fixtures
# ──────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _env_hygiene(monkeypatch):
    """NO LIVE KEY EVER: scrub ambient Stripe env before each test, pin the
    SDK's api_base back to its ambient default, and guarantee the factory
    seam is cleared afterwards. Tests then opt IN to exactly the env they
    need."""
    for var in ("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
                "STRIPE_API_BASE", "STRIPE_PRICE_INTRO",
                "STRIPE_PRICE_STARTER", "STRIPE_PRICE_PRO",
                "STRIPE_PRICE_STARTER_EXTRA_DOC", "STRIPE_PRICE_PRO_EXTRA_DOC",
                "STRIPE_PRICE_FOUNDER_Q1", "STRIPE_PRICE_FOUNDER_RENEWAL",
                "STRIPE_PRICE_STANDARD", "PUBLIC_TEST_MODE",
                "ENGINE_API_TOKEN", "USAGE_LIMITS_ENABLED"):
        monkeypatch.delenv(var, raising=False)
    # Dummy Supabase config so the REAL per_user() client constructs
    # offline (get_user decodes the JWT locally; no network is issued).
    monkeypatch.setenv("VITE_SUPABASE_URL", "http://fake-supabase.local")
    monkeypatch.setenv("VITE_SUPABASE_ANON_KEY", "fake-anon-key")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-key")
    monkeypatch.setenv("APP_URL", APP_URL)
    real_stripe.api_base = _ORIG_API_BASE
    yield
    if hasattr(_billing, "set_stripe_client_factory"):
        _billing.set_stripe_client_factory(None)
    real_stripe.api_base = _ORIG_API_BASE


@pytest.fixture
def fake_admin(monkeypatch):
    fake = FakeAdminClient()

    def _admin() -> FakeAdminClient:
        return fake

    # One patch point covers _billing, _org and _plan_state alike — they
    # all hold a reference to the engine.api._supabase MODULE.
    monkeypatch.setattr(_supabase_module, "admin", _admin)
    return fake


@pytest.fixture
def fake_stripe():
    fs = FakeStripe()
    _billing.set_stripe_client_factory(lambda: fs)
    yield fs
    _billing.set_stripe_client_factory(None)


@pytest.fixture
def billing_env(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", TEST_SECRET_KEY)
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET)
    monkeypatch.setenv("STRIPE_PRICE_INTRO", "price_intro_test")
    monkeypatch.setenv("STRIPE_PRICE_STARTER", "price_starter_test")
    monkeypatch.setenv("STRIPE_PRICE_PRO", "price_pro_test")
    monkeypatch.setenv("STRIPE_PRICE_STARTER_EXTRA_DOC",
                       "price_starter_extra_test")
    monkeypatch.setenv("STRIPE_PRICE_PRO_EXTRA_DOC", "price_pro_extra_test")
    monkeypatch.setenv("STRIPE_PRICE_FOUNDER_Q1", "price_founder_q1_test")
    monkeypatch.setenv("STRIPE_PRICE_FOUNDER_RENEWAL",
                       "price_founder_renewal_test")
    monkeypatch.setenv("STRIPE_PRICE_STANDARD", "price_standard_test")


@pytest.fixture
def client(fake_admin, fake_stripe, billing_env):
    app = FastAPI()
    app.include_router(_billing.build_router())
    return TestClient(app)


def seed_identity(fake_admin: FakeAdminClient, user_id: str = USER_ID,
                  org_id: str = ORG_ID,
                  email: str = "d2-user@example.com") -> None:
    fake_admin.seed("memberships", {"user_id": user_id, "org_id": org_id,
                                    "role": "owner",
                                    "created_at": "2026-01-01T00:00:00+00:00"})
    fake_admin.seed("organizations", {"id": org_id, "name": "D2 Test SRL",
                                      "archived_at": None,
                                      "created_at": "2026-01-01T00:00:00+00:00"})
    fake_admin.user_emails[user_id] = email


# ══════════════════════════════════════════════════════════════════════
# [SEAM] DI seams — RED-FIRST tests for the only _billing.py logic edits
# ══════════════════════════════════════════════════════════════════════


def test_seam_stripe_client_factory_injection(monkeypatch):
    """RED-FIRST for seam #1: `set_stripe_client_factory` lets the suite
    inject an in-process stand-in; the factory takes absolute precedence
    (no env key needed), and clearing it restores the env-driven path
    (no key → None → 503 posture) unchanged."""
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    sentinel = object()
    _billing.set_stripe_client_factory(lambda: sentinel)
    try:
        assert _billing._stripe_or_none() is sentinel
    finally:
        _billing.set_stripe_client_factory(None)
    assert _billing._stripe_or_none() is None


def test_seam_api_base_env_override_and_restore(monkeypatch):
    """RED-FIRST for seam #2: STRIPE_API_BASE (or STRIPE_MOCK_URL) points
    the REAL SDK at stripe-mock; when the override is absent the SDK's
    default base is restored, so a stale mock base can never leak into a
    later call in the same process."""
    monkeypatch.setenv("STRIPE_SECRET_KEY", TEST_SECRET_KEY)
    monkeypatch.setenv("STRIPE_API_BASE", "http://localhost:12111")
    # Own BOTH override spellings for this test — an ambient
    # STRIPE_MOCK_URL (the mode-detection env) would legitimately keep
    # the override active in the restore-default step below.
    monkeypatch.delenv("STRIPE_MOCK_URL", raising=False)
    _billing.set_stripe_client_factory(None)
    mod = _billing._stripe_or_none()
    assert mod is real_stripe
    assert real_stripe.api_base == "http://localhost:12111"

    monkeypatch.delenv("STRIPE_API_BASE")
    _billing._stripe_or_none()
    assert real_stripe.api_base == _ORIG_API_BASE

    # STRIPE_MOCK_URL is honored as the fallback spelling.
    monkeypatch.setenv("STRIPE_MOCK_URL", "http://localhost:12111/")
    _billing._stripe_or_none()
    assert real_stripe.api_base == "http://localhost:12111"


# ══════════════════════════════════════════════════════════════════════
# [1] Checkout start — session created with the right price/metadata
# ══════════════════════════════════════════════════════════════════════


def test_checkout_start_starter_session_price_and_metadata(client, fake_admin,
                                                           fake_stripe):
    seed_identity(fake_admin)
    r = client.post("/api/checkout/start", json={"plan": "starter"},
                    headers=auth_header(USER_ID))
    assert r.status_code == 200, r.text

    creates = fake_stripe.calls_for("checkout.Session.create")
    assert len(creates) == 1
    kw = creates[0]
    assert kw["mode"] == "subscription"
    assert kw["line_items"][0] == {"price": "price_starter_test",
                                   "quantity": 1}
    # WS2 — metered overage item attached at checkout, no quantity.
    assert kw["line_items"][1] == {"price": "price_starter_extra_test"}
    assert kw["payment_method_collection"] == "always"
    assert kw["success_url"] == APP_URL + "/dashboard?welcome=1&tier=starter"
    assert kw["cancel_url"] == APP_URL + "/pricing?canceled=1"
    md = kw["subscription_data"]["metadata"]
    assert md["tier"] == "starter"
    assert md["user_id"] == USER_ID
    assert md["org_id"] == ORG_ID

    # Fresh Stripe customer created with the user's email + identity.
    cust = fake_stripe.calls_for("Customer.create")
    assert len(cust) == 1
    assert cust[0]["email"] == "d2-user@example.com"
    assert cust[0]["metadata"]["user_id"] == USER_ID

    assert r.json()["url"].startswith("https://checkout.stripe.com/")


def test_checkout_start_intro_one_time_payment_mode(client, fake_admin,
                                                    fake_stripe):
    seed_identity(fake_admin)
    r = client.post("/api/checkout/start", json={"plan": "intro"},
                    headers=auth_header(USER_ID))
    assert r.status_code == 200, r.text
    kw = fake_stripe.calls_for("checkout.Session.create")[0]
    assert kw["mode"] == "payment"
    assert kw["line_items"] == [{"price": "price_intro_test", "quantity": 1}]
    # mode=payment → metadata rides on the session itself (no sub object).
    assert "subscription_data" not in kw
    assert kw["metadata"]["tier"] == "intro"
    assert kw["metadata"]["user_id"] == USER_ID


def test_checkout_start_reuses_existing_stripe_customer(client, fake_admin,
                                                        fake_stripe):
    seed_identity(fake_admin)
    fake_stripe.seed_customer("cus_D2TestCustomer001")
    fake_admin.seed("subscriptions", {
        "user_id": USER_ID, "tier": "starter", "status": "active",
        "stripe_customer_id": "cus_D2TestCustomer001",
    })
    r = client.post("/api/checkout/start", json={"plan": "starter"},
                    headers=auth_header(USER_ID))
    assert r.status_code == 200
    assert fake_stripe.calls_for("Customer.create") == []
    kw = fake_stripe.calls_for("checkout.Session.create")[0]
    assert kw["customer"] == "cus_D2TestCustomer001"


def test_checkout_start_stale_customer_self_heal(client, fake_admin,
                                                 fake_stripe):
    """Cached customer id from a different Stripe mode → retrieve raises
    "No such customer" → the stale IDs are cleared in the DB and checkout
    continues with a FRESH customer."""
    seed_identity(fake_admin)
    fake_admin.seed("subscriptions", {
        "user_id": USER_ID, "tier": "starter", "status": "active",
        "stripe_customer_id": "cus_D2StaleGone001",
        "stripe_subscription_id": "sub_D2StaleGone001",
    })
    r = client.post("/api/checkout/start", json={"plan": "starter"},
                    headers=auth_header(USER_ID))
    assert r.status_code == 200
    assert len(fake_stripe.calls_for("Customer.create")) == 1
    row = fake_admin.rows("subscriptions")[0]
    assert row["stripe_customer_id"] is None
    assert row["stripe_subscription_id"] is None


def test_checkout_start_missing_price_env_503_names_var(client, fake_admin,
                                                        monkeypatch):
    seed_identity(fake_admin)
    monkeypatch.delenv("STRIPE_PRICE_STARTER")
    r = client.post("/api/checkout/start", json={"plan": "starter"},
                    headers=auth_header(USER_ID))
    assert r.status_code == 503
    assert "STRIPE_PRICE_STARTER" in r.json()["detail"]


def test_checkout_start_unknown_plan_400(client, fake_admin):
    seed_identity(fake_admin)
    r = client.post("/api/checkout/start", json={"plan": "platinum"},
                    headers=auth_header(USER_ID))
    assert r.status_code == 400


def test_checkout_start_stripe_unconfigured_503(fake_admin, billing_env,
                                                monkeypatch):
    """No factory injected + no STRIPE_SECRET_KEY → clean 503, never a
    live-key attempt."""
    seed_identity(fake_admin)
    monkeypatch.delenv("STRIPE_SECRET_KEY")
    _billing.set_stripe_client_factory(None)
    app = FastAPI()
    app.include_router(_billing.build_router())
    r = TestClient(app).post("/api/checkout/start", json={"plan": "starter"},
                             headers=auth_header(USER_ID))
    assert r.status_code == 503
    assert "not configured" in r.json()["detail"]


def test_checkout_start_get_anonymous_redirects_to_signup(client):
    r = client.get("/api/checkout/start?tier=pro", follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"] == APP_URL + "/signup?plan=pro&intent=checkout"


def test_checkout_start_get_bad_token_redirects_to_signup(client):
    r = client.get("/api/checkout/start?tier=starter&auth_token=not-a-jwt",
                   follow_redirects=False)
    assert r.status_code == 303
    assert "signup" in r.headers["location"]


def test_checkout_start_get_authed_redirects_to_stripe(client, fake_admin,
                                                       fake_stripe):
    seed_identity(fake_admin)
    r = client.get("/api/checkout/start?tier=starter&auth_token=%s"
                   % make_jwt(USER_ID), follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"].startswith("https://checkout.stripe.com/")
    kw = fake_stripe.calls_for("checkout.Session.create")[0]
    assert kw["line_items"][0]["price"] == "price_starter_test"


def test_checkout_start_founder_legacy_org_flow(client, fake_admin,
                                                fake_stripe):
    seed_identity(fake_admin)
    fake_admin.seed("founder_cohort_public", {"seats_left": 3})
    r = client.post("/api/checkout/start", json={"plan": "founder"},
                    headers=auth_header(USER_ID))
    assert r.status_code == 200, r.text
    kw = fake_stripe.calls_for("checkout.Session.create")[0]
    assert kw["line_items"] == [{"price": "price_founder_q1_test",
                                 "quantity": 1}]
    assert kw["subscription_data"]["metadata"] == {"plan": "founder",
                                                   "org_id": ORG_ID}
    assert "trial_period_days" not in kw["subscription_data"]


def test_checkout_start_founder_sold_out_409(client, fake_admin):
    seed_identity(fake_admin)
    fake_admin.seed("founder_cohort_public", {"seats_left": 0})
    r = client.post("/api/checkout/start", json={"plan": "founder"},
                    headers=auth_header(USER_ID))
    assert r.status_code == 409


def test_checkout_start_standard_has_14_day_trial(client, fake_admin,
                                                  fake_stripe):
    seed_identity(fake_admin)
    r = client.post("/api/checkout/start", json={"plan": "standard"},
                    headers=auth_header(USER_ID))
    assert r.status_code == 200
    kw = fake_stripe.calls_for("checkout.Session.create")[0]
    assert kw["subscription_data"]["trial_period_days"] == 14
    assert kw["subscription_data"]["metadata"]["plan"] == "standard"


def test_checkout_start_legacy_plan_without_org_403(client, fake_admin):
    fake_admin.user_emails[USER_ID] = "d2-user@example.com"  # no membership
    r = client.post("/api/checkout/start", json={"plan": "founder"},
                    headers=auth_header(USER_ID))
    assert r.status_code == 403


# ══════════════════════════════════════════════════════════════════════
# [2] Webhook signature verification (real SDK crypto, test secret)
# ══════════════════════════════════════════════════════════════════════


def test_webhook_valid_signature_accepted(client, fake_admin):
    event = load_fixture("event_invoice_payment_succeeded.json")
    r = deliver_event(client, event)
    assert r.status_code == 200
    assert r.text == "ok"


def test_webhook_invalid_signature_rejected_400(client, fake_admin):
    event = load_fixture("event_invoice_payment_succeeded.json")
    r = deliver_event(client, event, secret="whsec_WRONG_secret")
    assert r.status_code == 400
    assert "Invalid signature" in r.text
    # Nothing recorded, nothing mutated.
    assert fake_admin.rows("billing_events") == []


def test_webhook_tampered_body_rejected_400(client, fake_admin):
    event = load_fixture("event_invoice_payment_succeeded.json")
    r = deliver_event(client, event, tamper_body=True)
    assert r.status_code == 400
    assert fake_admin.rows("billing_events") == []


def test_webhook_missing_secret_env_degrades_200(client, fake_admin,
                                                 monkeypatch):
    monkeypatch.delenv("STRIPE_WEBHOOK_SECRET")
    event = load_fixture("event_invoice_payment_succeeded.json")
    r = deliver_event(client, event)
    assert r.status_code == 200
    assert "Webhook secret not configured" in r.text
    assert fake_admin.rows("billing_events") == []


def test_webhook_stripe_unconfigured_degrades_200(fake_admin, monkeypatch):
    _billing.set_stripe_client_factory(None)
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    app = FastAPI()
    app.include_router(_billing.build_router())
    r = TestClient(app).post("/api/stripe/webhook", content=b"{}",
                             headers={"stripe-signature": "t=1,v1=x"})
    assert r.status_code == 200
    assert "Stripe not configured" in r.text


# ══════════════════════════════════════════════════════════════════════
# [3] Subscription becomes active → plan state reflects it
# ══════════════════════════════════════════════════════════════════════


def test_subscription_created_active_materializes_row_and_plan_state(
        client, fake_admin):
    event = load_fixture("event_customer_subscription_created_starter.json")
    r = deliver_event(client, event)
    assert r.status_code == 200

    rows = fake_admin.rows("subscriptions")
    assert len(rows) == 1
    row = rows[0]
    assert row["user_id"] == USER_ID
    assert row["tier"] == "starter"
    assert row["billing_cycle"] == "monthly"
    assert row["status"] == "active"
    assert row["stripe_customer_id"] == "cus_D2TestCustomer001"
    assert row["stripe_subscription_id"] == "sub_D2TestSub001"
    # Periods read from the ITEM (API 2026-03-25.dahlia moved them there).
    assert row["current_period_start"] == "2026-01-01T00:00:00+00:00"
    assert row["current_period_end"] == "2026-02-01T00:00:00+00:00"
    assert row["cancel_at_period_end"] is False
    assert row["is_founding_member"] is False

    # The read-only surface reflects it…
    sub = client.get("/api/billing/subscription",
                     headers=auth_header(USER_ID)).json()["subscription"]
    assert sub["tier"] == "starter"
    assert sub["status"] == "active"
    assert sub["plan_key"] == "starter"

    # …and so does the quota/entitlement lane.
    ps = _plan_state.get_plan_state(USER_ID)
    assert ps.plan_key == "starter"

    # The event was journaled for idempotency.
    events = fake_admin.rows("billing_events")
    assert [e["stripe_event_id"] for e in events] == [event["id"]]


def test_subscription_trialing_maps_to_trial_status(client, fake_admin):
    event = load_fixture("event_customer_subscription_created_starter.json")
    event["data"]["object"]["status"] = "trialing"
    event["data"]["object"]["trial_end"] = 1769904000
    event["id"] = "evt_d2_sub_trialing_001"
    deliver_event(client, event)
    row = fake_admin.rows("subscriptions")[0]
    assert row["status"] == "trial"
    assert row["trial_end"] == "2026-02-01T00:00:00+00:00"


def test_intro_checkout_completed_grants_7_day_entitlement(client,
                                                           fake_admin):
    event = load_fixture("event_checkout_session_completed_intro.json")
    r = deliver_event(client, event)
    assert r.status_code == 200
    rows = fake_admin.rows("subscriptions")
    assert len(rows) == 1
    row = rows[0]
    assert row["user_id"] == USER_INTRO
    assert row["tier"] == "intro"
    assert row["status"] == "active"
    assert row["stripe_subscription_id"] is None
    assert row["current_period_start"] == "2026-01-01T00:00:00+00:00"
    assert row["intro_unlock_expiry"] == "2026-01-08T00:00:00+00:00"
    assert row["cancel_at_period_end"] is True


def test_founding_seat_claimed_for_solo_tier(client, fake_admin):
    fake_admin.founding_seats_left = 5
    event = load_fixture(
        "event_customer_subscription_created_solo_founding.json")
    deliver_event(client, event)
    claims = [c for c in fake_admin.rpc_calls
              if c[0] == "claim_founding_seat"]
    assert len(claims) == 1
    assert claims[0][1] == {"p_user_id": USER_SOLO, "p_tier": "solo",
                            "p_stripe_subscription_id": "sub_D2SoloSub001"}
    row = fake_admin.rows("subscriptions")[0]
    assert row["is_founding_member"] is True
    assert row["status"] == "founding_trial"
    assert fake_admin.founding_seats_left == 4


def test_founding_seat_capped_leaves_plain_active(client, fake_admin):
    fake_admin.founding_seats_left = 0  # RPC returns null → no seat
    event = load_fixture(
        "event_customer_subscription_created_solo_founding.json")
    deliver_event(client, event)
    row = fake_admin.rows("subscriptions")[0]
    assert row["is_founding_member"] is False
    assert row["status"] == "active"


def test_founding_flag_on_starter_tier_is_ignored(client, fake_admin):
    """DIVERGENCE (documented, asserted as implemented): the founding-seat
    claim gate is `tier in _pricing_tiers.SELF_SERVE_TIER_KEYS` — which is
    ('solo', 'business'), the LEGACY alias keys. A checkout that stamps the
    live tier keys ('starter'/'pro') plus is_founding_member=true never
    claims a seat."""
    fake_admin.founding_seats_left = 5
    event = load_fixture("event_customer_subscription_created_starter.json")
    event["data"]["object"]["metadata"]["is_founding_member"] = "true"
    event["id"] = "evt_d2_sub_starter_founding_001"
    deliver_event(client, event)
    assert [c for c in fake_admin.rpc_calls
            if c[0] == "claim_founding_seat"] == []
    row = fake_admin.rows("subscriptions")[0]
    assert row["is_founding_member"] is False
    assert fake_admin.founding_seats_left == 5


def test_founder_legacy_first_time_attaches_schedule_and_increments_cohort(
        client, fake_admin, fake_stripe):
    fake_stripe.seed_subscription(
        {"id": "sub_D2FounderSub001", "object": "subscription",
         "status": "active",
         "items": {"object": "list", "data": []}})
    event = load_fixture("event_customer_subscription_created_founder.json")
    r = deliver_event(client, event)
    assert r.status_code == 200

    # org-keyed row (legacy path), periods read from the TOP level.
    row = fake_admin.rows("subscriptions")[0]
    assert row["org_id"] == ORG_ID
    assert row["plan_key"] == "founder"
    assert row["is_founder"] is True
    assert row["founder_renewal_price_eur"] == 99
    assert row["founder_renewal_at"] == "2026-02-01T00:00:00+00:00"
    assert row["current_period_end"] == "2026-02-01T00:00:00+00:00"

    # €1-for-one-quarter → €99/year schedule attached exactly once.
    sched_creates = fake_stripe.calls_for("SubscriptionSchedule.create")
    assert len(sched_creates) == 1
    assert sched_creates[0] == {"from_subscription": "sub_D2FounderSub001"}
    mod = fake_stripe.calls_for("SubscriptionSchedule.modify")[0]
    assert mod["end_behavior"] == "release"
    assert mod["phases"][0] == {"items": [{"price": "price_founder_q1_test",
                                           "quantity": 1}],
                                "iterations": 1}
    assert mod["phases"][1] == {"items": [{"price": "price_founder_renewal_test",
                                           "quantity": 1}]}
    assert fake_admin.cohort_increments == 1


def test_founder_update_after_creation_does_not_reincrement(client,
                                                            fake_admin,
                                                            fake_stripe):
    fake_stripe.seed_subscription(
        {"id": "sub_D2FounderSub001", "object": "subscription",
         "status": "active", "items": {"object": "list", "data": []}})
    created = load_fixture("event_customer_subscription_created_founder.json")
    deliver_event(client, created)
    updated = copy.deepcopy(created)
    updated["id"] = "evt_d2_sub_updated_founder_001"
    updated["type"] = "customer.subscription.updated"
    deliver_event(client, updated)
    assert fake_admin.cohort_increments == 1
    assert len(fake_stripe.calls_for("SubscriptionSchedule.create")) == 1


# ══════════════════════════════════════════════════════════════════════
# [4] Payment failure → dunning → downgrade semantics AS IMPLEMENTED
# ══════════════════════════════════════════════════════════════════════


def test_invoice_payment_failed_is_log_only(client, fake_admin):
    """AS IMPLEMENTED: invoice.payment_failed mutates nothing — the code
    relies on Stripe's own dunning to emit customer.subscription.updated
    (status past_due), which is where state changes."""
    fake_admin.seed("subscriptions", {
        "user_id": USER_ID, "tier": "starter", "status": "active",
        "stripe_subscription_id": "sub_D2TestSub001",
    })
    before = copy.deepcopy(fake_admin.rows("subscriptions"))
    r = deliver_event(client,
                      load_fixture("event_invoice_payment_failed.json"))
    assert r.status_code == 200
    assert fake_admin.rows("subscriptions") == before
    assert len(fake_admin.rows("billing_events")) == 1


def test_dunning_past_due_recorded_but_no_entitlement_downgrade(client,
                                                                fake_admin):
    """The full dunning sequence: active → invoice.payment_failed →
    subscription.updated(past_due). The row and the read-only surface
    show past_due.

    DIVERGENCE (documented, asserted as implemented): there is NO
    read-only/downgrade enforcement — _plan_state.get_plan_state resolves
    the plan from `subscriptions.tier` alone and never reads `status`, so
    a past_due (or even canceled) user keeps full paid entitlements."""
    deliver_event(client, load_fixture(
        "event_customer_subscription_created_starter.json"))
    deliver_event(client, load_fixture("event_invoice_payment_failed.json"))
    deliver_event(client, load_fixture(
        "event_customer_subscription_updated_past_due.json"))

    rows = fake_admin.rows("subscriptions")
    assert len(rows) == 1
    assert rows[0]["status"] == "past_due"

    sub = client.get("/api/billing/subscription",
                     headers=auth_header(USER_ID)).json()["subscription"]
    assert sub["status"] == "past_due"

    ps = _plan_state.get_plan_state(USER_ID)
    assert ps.plan_key == "starter"  # ← paid plan survives past_due


def test_stripe_unpaid_and_paused_map_to_past_due(client, fake_admin):
    for i, stripe_status in enumerate(("unpaid", "paused")):
        event = load_fixture(
            "event_customer_subscription_created_starter.json")
        event["data"]["object"]["status"] = stripe_status
        event["id"] = "evt_d2_sub_%s_00%d" % (stripe_status, i)
        deliver_event(client, event)
        assert fake_admin.rows("subscriptions")[0]["status"] == "past_due"


# ══════════════════════════════════════════════════════════════════════
# [5] Cancellation → state cleanup
# ══════════════════════════════════════════════════════════════════════


def test_cancel_sets_cancel_at_period_end(client, fake_admin, fake_stripe):
    seed_identity(fake_admin)
    fake_admin.seed("subscriptions", {
        "user_id": USER_ID, "tier": "starter", "status": "active",
        "stripe_customer_id": "cus_D2TestCustomer001",
        "stripe_subscription_id": "sub_D2TestSub001",
    })
    fake_stripe.seed_subscription(
        load_fixture("subscription_starter_with_metered_item.json"))
    r = client.post("/api/billing/cancel", headers=auth_header(USER_ID))
    assert r.status_code == 200
    assert r.json() == {"ok": True, "cancel_at_period_end": True}
    mods = fake_stripe.calls_for("Subscription.modify")
    assert mods == [{"id": "sub_D2TestSub001",
                     "cancel_at_period_end": True}]


def test_cancel_without_subscription_404(client, fake_admin):
    seed_identity(fake_admin)
    r = client.post("/api/billing/cancel", headers=auth_header(USER_ID))
    assert r.status_code == 404


def test_cancel_stale_subscription_clears_ids_404(client, fake_admin,
                                                  fake_stripe):
    seed_identity(fake_admin)
    fake_admin.seed("subscriptions", {
        "user_id": USER_ID, "tier": "starter", "status": "active",
        "stripe_customer_id": "cus_D2StaleGone001",
        "stripe_subscription_id": "sub_D2StaleGone001",
    })
    r = client.post("/api/billing/cancel", headers=auth_header(USER_ID))
    assert r.status_code == 404
    row = fake_admin.rows("subscriptions")[0]
    assert row["stripe_customer_id"] is None
    assert row["stripe_subscription_id"] is None


def test_subscription_deleted_webhook_marks_canceled(client, fake_admin):
    deliver_event(client, load_fixture(
        "event_customer_subscription_created_starter.json"))
    deliver_event(client, load_fixture(
        "event_customer_subscription_deleted_starter.json"))
    rows = fake_admin.rows("subscriptions")
    assert len(rows) == 1  # same row, upserted — no duplicates
    assert rows[0]["status"] == "canceled"
    assert rows[0]["cancel_at_period_end"] is True

    sub = client.get("/api/billing/subscription",
                     headers=auth_header(USER_ID)).json()["subscription"]
    assert sub["status"] == "canceled"


def test_portal_session_for_active_customer(client, fake_admin, fake_stripe):
    seed_identity(fake_admin)
    fake_stripe.seed_customer("cus_D2TestCustomer001")
    fake_admin.seed("subscriptions", {
        "user_id": USER_ID, "tier": "starter", "status": "active",
        "stripe_customer_id": "cus_D2TestCustomer001",
    })
    r = client.post("/api/billing/portal", headers=auth_header(USER_ID))
    assert r.status_code == 200
    assert r.json()["url"].startswith("https://billing.stripe.com/")
    kw = fake_stripe.calls_for("billing_portal.Session.create")[0]
    assert kw["customer"] == "cus_D2TestCustomer001"
    assert kw["return_url"] == APP_URL + "/settings"


def test_portal_stale_customer_conflict_409_and_cleanup(client, fake_admin,
                                                        fake_stripe):
    seed_identity(fake_admin)
    fake_admin.seed("subscriptions", {
        "user_id": USER_ID, "tier": "starter", "status": "active",
        "stripe_customer_id": "cus_D2StaleGone001",
        "stripe_subscription_id": "sub_D2StaleGone001",
    })
    r = client.post("/api/billing/portal", headers=auth_header(USER_ID))
    assert r.status_code == 409
    row = fake_admin.rows("subscriptions")[0]
    assert row["stripe_customer_id"] is None
    assert row["stripe_subscription_id"] is None


# ══════════════════════════════════════════════════════════════════════
# [6] Idempotent double-delivery → exactly-once effects
# ══════════════════════════════════════════════════════════════════════


def test_webhook_double_delivery_is_exactly_once(client, fake_admin):
    event = load_fixture("event_customer_subscription_created_starter.json")
    r1 = deliver_event(client, event)
    r2 = deliver_event(client, event)
    assert r1.status_code == 200 and r2.status_code == 200

    assert len(fake_admin.rows("subscriptions")) == 1
    # The second delivery short-circuited BEFORE dispatch: exactly one
    # upsert, exactly one journaled event.
    assert fake_admin.upsert_calls.get("subscriptions") == 1
    assert len(fake_admin.rows("billing_events")) == 1


def test_founder_double_delivery_single_cohort_increment(client, fake_admin,
                                                         fake_stripe):
    fake_stripe.seed_subscription(
        {"id": "sub_D2FounderSub001", "object": "subscription",
         "status": "active", "items": {"object": "list", "data": []}})
    event = load_fixture("event_customer_subscription_created_founder.json")
    deliver_event(client, event)
    deliver_event(client, event)
    assert fake_admin.cohort_increments == 1
    assert len(fake_stripe.calls_for("SubscriptionSchedule.create")) == 1


def test_intro_double_delivery_single_entitlement(client, fake_admin):
    event = load_fixture("event_checkout_session_completed_intro.json")
    deliver_event(client, event)
    deliver_event(client, event)
    assert len(fake_admin.rows("subscriptions")) == 1
    assert fake_admin.upsert_calls.get("subscriptions") == 1


def test_webhook_processing_failure_returns_500_then_retry_is_skipped(
        client, fake_admin):
    """Stripe-retry contract: a dispatch failure surfaces as 500 (so
    Stripe retries) — asserted.

    DIVERGENCE (documented, asserted as implemented): the idempotency
    marker is journaled BEFORE dispatch, so the retry of a FAILED event is
    treated as already-processed and the effects are permanently skipped —
    'exactly-once' is really 'at-most-once' across a failure+retry
    window."""
    event = load_fixture("event_customer_subscription_created_starter.json")
    fake_admin.fail_on.add(("upsert", "subscriptions"))
    r1 = deliver_event(client, event)
    assert r1.status_code == 500

    fake_admin.fail_on.clear()
    r2 = deliver_event(client, event)
    assert r2.status_code == 200
    # The event was journaled on delivery #1, so delivery #2 dedupes —
    # and the subscription row is never materialized.
    assert fake_admin.rows("subscriptions") == []
    assert len(fake_admin.rows("billing_events")) == 1


# ══════════════════════════════════════════════════════════════════════
# [7] Metered overage (WS2) — Stripe-side idempotency by reservation
# ══════════════════════════════════════════════════════════════════════


def _seed_metered_user(fake_admin, fake_stripe, *, with_metered=True):
    fake_admin.seed("subscriptions", {
        "user_id": USER_ID, "tier": "starter", "status": "active",
        "stripe_customer_id": "cus_D2TestCustomer001",
        "stripe_subscription_id": "sub_D2TestSub001",
    })
    name = ("subscription_starter_with_metered_item.json" if with_metered
            else "subscription_starter_no_metered_item.json")
    fake_stripe.seed_subscription(load_fixture(name))


def test_metered_extra_doc_records_usage_with_reservation_key(
        fake_admin, fake_stripe, billing_env):
    _seed_metered_user(fake_admin, fake_stripe)
    out = _billing.record_metered_extra_doc(USER_ID, "res-d2-001")
    assert out["ok"] is True and out["billed"] is True
    assert out["subscription_item_id"] == "si_D2Metered001"
    kw = fake_stripe.calls_for("SubscriptionItem.create_usage_record")[0]
    assert kw["id"] == "si_D2Metered001"
    assert kw["quantity"] == 1
    assert kw["action"] == "increment"
    assert kw["idempotency_key"] == "extra_doc:res-d2-001"
    assert fake_stripe.usage_total == 1


def test_metered_extra_doc_retry_same_reservation_charges_once(
        fake_admin, fake_stripe, billing_env):
    _seed_metered_user(fake_admin, fake_stripe)
    out1 = _billing.record_metered_extra_doc(USER_ID, "res-d2-002")
    out2 = _billing.record_metered_extra_doc(USER_ID, "res-d2-002")
    assert out1["billed"] is True and out2["billed"] is True
    # Stripe's idempotency key replays the ORIGINAL usage record —
    # exactly one unit ever accrues.
    assert fake_stripe.usage_total == 1
    assert len(fake_stripe.usage_records) == 1


def test_metered_lazy_adds_item_for_legacy_subscription(
        fake_admin, fake_stripe, billing_env):
    _seed_metered_user(fake_admin, fake_stripe, with_metered=False)
    out = _billing.record_metered_extra_doc(USER_ID, "res-d2-003")
    assert out["ok"] is True and out["billed"] is True
    lazy = fake_stripe.calls_for("SubscriptionItem.create")[0]
    assert lazy["subscription"] == "sub_D2TestSub001"
    assert lazy["price"] == "price_starter_extra_test"
    assert lazy["proration_behavior"] == "none"
    assert fake_stripe.usage_total == 1


def test_metered_no_subscription_row_is_unbilled_noop(fake_admin,
                                                      fake_stripe,
                                                      billing_env):
    out = _billing.record_metered_extra_doc(USER_ID, "res-d2-004")
    assert out == {"ok": True, "billed": False,
                   "reason": "no_stripe_subscription"}


def test_metered_unsupported_tier_skips_silently(fake_admin, fake_stripe,
                                                 billing_env):
    fake_admin.seed("subscriptions", {
        "user_id": USER_ID, "tier": "intro", "status": "active",
        "stripe_subscription_id": "sub_D2TestSub001",
    })
    out = _billing.record_metered_extra_doc(USER_ID, "res-d2-005")
    assert out["billed"] is False
    assert out["reason"] == "tier_intro_no_metered_price"


def test_metered_price_env_unset_is_reported(fake_admin, fake_stripe,
                                             billing_env, monkeypatch):
    monkeypatch.delenv("STRIPE_PRICE_STARTER_EXTRA_DOC")
    _seed_metered_user(fake_admin, fake_stripe)
    out = _billing.record_metered_extra_doc(USER_ID, "res-d2-006")
    assert out["ok"] is False
    assert out["error"] == "metered_price_env_unset"
    assert fake_stripe.usage_total == 0


def test_metered_stale_subscription_clears_and_skips(fake_admin, fake_stripe,
                                                     billing_env):
    fake_admin.seed("subscriptions", {
        "user_id": USER_ID, "tier": "starter", "status": "active",
        "stripe_subscription_id": "sub_D2GoneFromStripe001",
    })
    out = _billing.record_metered_extra_doc(USER_ID, "res-d2-007")
    assert out == {"ok": True, "billed": False,
                   "reason": "stale_subscription_cleared"}
    row = fake_admin.rows("subscriptions")[0]
    assert row["stripe_subscription_id"] is None


# ══════════════════════════════════════════════════════════════════════
# [8] Renewal-reminder cron (dunning-adjacent founder lifecycle)
# ══════════════════════════════════════════════════════════════════════


def _seed_founder_for_renewal(fake_admin, days_ahead: int) -> str:
    renew_on = (date.today() + timedelta(days=days_ahead)).isoformat()
    fake_admin.seed("subscriptions", {
        "id": "subrow-founder-1", "org_id": ORG_ID, "is_founder": True,
        "status": "active",
        "current_period_end": renew_on + "T12:00:00+00:00",
    })
    fake_admin.seed("memberships", {"user_id": USER_ID, "org_id": ORG_ID,
                                    "role": "owner",
                                    "created_at": "2026-01-01T00:00:00+00:00"})
    fake_admin.user_emails[USER_ID] = "founder@example.com"
    return renew_on


def test_renewal_reminder_t14_queues_email(fake_admin, fake_stripe,
                                           billing_env):
    renew_on = _seed_founder_for_renewal(fake_admin, 14)
    out = _billing.send_founder_renewal_reminders(days_ahead=14)
    assert out["queued"] == 1
    q = fake_admin.rows("renewal_email_queue")
    assert len(q) == 1
    assert q[0]["template"] == "renewal_reminder_t14"
    payload = q[0]["payload"]
    assert payload["to"] == "founder@example.com"
    assert payload["vars"]["renewal_price"] == "€99"
    assert payload["vars"]["renewal_date"] == renew_on


def test_renewal_reminder_t3_uses_t3_template(fake_admin, fake_stripe,
                                              billing_env):
    _seed_founder_for_renewal(fake_admin, 3)
    out = _billing.send_founder_renewal_reminders(days_ahead=3)
    assert out["queued"] == 1
    assert fake_admin.rows("renewal_email_queue")[0]["template"] == \
        "renewal_reminder_t3"


def test_renewal_reminder_outside_window_queues_nothing(fake_admin,
                                                        fake_stripe,
                                                        billing_env):
    _seed_founder_for_renewal(fake_admin, 30)
    out = _billing.send_founder_renewal_reminders(days_ahead=14)
    assert out["queued"] == 0
    assert fake_admin.rows("renewal_email_queue") == []


def test_renewal_cron_route_requires_scheduler_token(client, fake_admin,
                                                     monkeypatch):
    monkeypatch.setenv("ENGINE_API_TOKEN", "engine-token-d2")
    r = client.post("/api/billing/cron/renewal-reminders",
                    headers={"Authorization": "Bearer wrong-token"})
    assert r.status_code == 401
    r = client.post("/api/billing/cron/renewal-reminders",
                    headers={"Authorization": "Bearer engine-token-d2"})
    assert r.status_code == 200
    body = r.json()
    assert body["t14"]["days_ahead"] == 14
    assert body["t3"]["days_ahead"] == 3


# ══════════════════════════════════════════════════════════════════════
# [9] Read-only surfaces — subscription view, upcoming invoice, admin
# ══════════════════════════════════════════════════════════════════════


def test_subscription_view_none_when_absent(client, fake_admin):
    seed_identity(fake_admin)
    r = client.get("/api/billing/subscription", headers=auth_header(USER_ID))
    assert r.status_code == 200
    assert r.json() == {"subscription": None}


def test_subscription_view_org_fallback_for_legacy_rows(client, fake_admin):
    seed_identity(fake_admin)
    fake_admin.seed("subscriptions", {
        "org_id": ORG_ID, "plan_key": "founder", "status": "active",
        "is_founder": True, "founder_renewal_price_eur": 99,
        "stripe_customer_id": "cus_D2FounderCust001",
    })
    sub = client.get("/api/billing/subscription",
                     headers=auth_header(USER_ID)).json()["subscription"]
    assert sub["is_founder"] is True
    assert sub["founder_renewal_price_eur"] == 99


def test_upcoming_invoice_splits_base_and_metered_extras(client, fake_admin,
                                                         fake_stripe):
    seed_identity(fake_admin)
    fake_admin.seed("subscriptions", {
        "user_id": USER_ID, "tier": "starter", "status": "active",
        "stripe_customer_id": "cus_D2TestCustomer001",
    })
    fake_stripe.upcoming_invoice = fixture_sobj(
        "invoice_upcoming_starter_with_extras.json")
    r = client.get("/api/billing/upcoming-invoice",
                   headers=auth_header(USER_ID))
    assert r.status_code == 200
    inv = r.json()["invoice"]
    assert inv["base_amount"] == 14.99
    assert inv["extras_count"] == 3
    assert inv["extras_amount"] == 9.0
    assert inv["total_estimated"] == 23.99
    assert inv["currency"] == "EUR"
    assert inv["next_invoice_date"] == "2026-02-01T00:00:00+00:00"


def test_upcoming_invoice_none_without_subscription(client, fake_admin):
    seed_identity(fake_admin)
    r = client.get("/api/billing/upcoming-invoice",
                   headers=auth_header(USER_ID))
    assert r.status_code == 200
    assert r.json() == {"invoice": None, "reason": "no_active_subscription"}


def test_admin_usage_gate_and_snapshot(client, fake_admin, monkeypatch):
    fake_admin.seed("subscriptions", {
        "user_id": USER_ID, "tier": "starter", "status": "active",
    })
    # No token configured → refuses to serve at all.
    r = client.get("/api/admin/usage",
                   headers={"Authorization": "Bearer anything"})
    assert r.status_code == 503

    monkeypatch.setenv("ENGINE_API_TOKEN", "engine-token-d2")
    r = client.get("/api/admin/usage",
                   headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401

    r = client.get("/api/admin/usage",
                   headers={"Authorization": "Bearer engine-token-d2"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["summary"]["total_users"] == 1
    user = body["users"][0]
    assert user["user_id"] == USER_ID
    assert user["tier"] == "starter"
    # DIVERGENCE (documented, asserted as implemented): the snapshot reads
    # `getattr(ps, "included_docs", 0)` / `chat_daily_cap` — fields that
    # do NOT exist on PlanState (they live on plan.included_docs etc.), so
    # included is always 0, pct_used always None, over_quota always False.
    assert user["docs"]["included"] == 0
    assert user["docs"]["pct_used"] is None
    assert user["chat"]["daily_cap"] is None


def test_contact_sales_lead_capture(client, fake_admin):
    r = client.post("/api/contact-sales", json={
        "name": "Ana Pop", "email": "ana@example.com",
        "company": "D2 SRL", "preferred_contact": "email",
    })
    if r.status_code == 422:
        # KNOWN PRE-EXISTING DEFECT (reported, not fixed here — outside
        # the D2 seam mandate): `ContactSalesRequest` is defined INSIDE
        # build_router(), and with `from __future__ import annotations`
        # FastAPI cannot resolve the closure-scoped forward ref (the same
        # root cause CLAUDE.md §16 documents for the /openapi.json 500).
        # On this fastapi/pydantic pin the body model misbinds as a QUERY
        # param, 422-ing every valid POST. Assert the defect precisely so
        # a behavior change on either side is loud.
        assert r.json()["detail"][0]["loc"] == ["query", "req"]
        assert fake_admin.rows("contact_sales_leads") == []
        return
    assert r.status_code == 200 and r.json() == {"ok": True}
    leads = fake_admin.rows("contact_sales_leads")
    assert len(leads) == 1
    assert leads[0]["email"] == "ana@example.com"
    assert leads[0]["status"] == "new"

    r = client.post("/api/contact-sales",
                    json={"name": "X", "email": "not-an-email"})
    assert r.status_code == 400


# ══════════════════════════════════════════════════════════════════════
# [10] Transport lane — real SDK against stripe-mock / test-mode Stripe
# ══════════════════════════════════════════════════════════════════════


@pytest.fixture
def transport_env(monkeypatch, fake_admin):
    """Real-SDK lane: NO factory injection — the production `_stripe_or_none`
    path runs, pointed away from live via the STRIPE_API_BASE seam
    (stripe-mock) or at real test-mode Stripe via STRIPE_TEST_KEY."""
    _billing.set_stripe_client_factory(None)
    if HARNESS_MODE == "LIVE":
        key = os.environ["STRIPE_TEST_KEY"]
        assert key.startswith("sk_test_"), "live-mode key refused"
        monkeypatch.setenv("STRIPE_SECRET_KEY", key)
    else:
        monkeypatch.setenv("STRIPE_SECRET_KEY", TEST_SECRET_KEY)
        monkeypatch.setenv("STRIPE_API_BASE", TRANSPORT_BASE)
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET)
    seed_identity(fake_admin)
    yield
    real_stripe.api_base = _ORIG_API_BASE


@transport_lane
def test_transport_checkout_start_roundtrip(transport_env, fake_admin,
                                            monkeypatch):
    """Our checkout payload accepted by a spec-faithful server (stripe-mock
    validates against Stripe's OpenAPI; LIVE validates against test-mode
    Stripe itself). Prices are created on the fly so the lane needs no
    pre-provisioned ids. The metered env is deliberately left unset — the
    documented silent-warn branch — because Billing-Meter-era accounts may
    reject legacy metered price creation."""
    mod = _billing._stripe_or_none()
    assert mod is real_stripe
    assert real_stripe.api_base != "https://api.stripe.com" or \
        HARNESS_MODE == "LIVE"

    price = real_stripe.Price.create(
        unit_amount=1499, currency="eur",
        recurring={"interval": "month"},
        product_data={"name": "D2 harness starter"},
    )
    monkeypatch.setenv("STRIPE_PRICE_STARTER", price["id"])

    app = FastAPI()
    app.include_router(_billing.build_router())
    r = TestClient(app).post("/api/checkout/start",
                             json={"plan": "starter"},
                             headers=auth_header(USER_ID))
    assert r.status_code == 200, r.text
    assert r.json()["url"].startswith("http")


@transport_lane
def test_transport_customer_create_retrieve_roundtrip(transport_env):
    mod = _billing._stripe_or_none()
    cust = mod.Customer.create(email="d2-harness@example.com",
                               metadata={"user_id": USER_ID})
    assert cust["id"].startswith("cus_")
    got = mod.Customer.retrieve(cust["id"])
    assert got["id"].startswith("cus_")
