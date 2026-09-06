"""LAUNCH SURVIVAL — the backend half of the launch posture (2026-09-05).

Five claims, each driven against the REAL ``create_app()`` — never an
import-shape regex, never a mirror of the app:

  L1  A GUARDED IMPORT THAT ACTUALLY GUARDS. ``server.py`` wraps the RO
      storefront and the public-market mounts in ``except Exception:
      logger.exception(...)`` and calls that "never fatal". There was no
      module-level ``logger`` in ``server.py``: the only name bound to
      logging inside ``create_app`` is the local ``_logging``. So on the
      day either import failed — the exact partially-provisioned
      deployment the comment names — the handler itself raised
      ``NameError: name 'logger' is not defined`` OUT of the except
      block and ``create_app()`` died. The whole API, not the surface.

  L2  THE PUBLIC-MARKETS WALL. Public Companies ships hidden at launch,
      so its API surface must not be reachable anonymously: every
      ``/api/public/*`` route that can reach a provider or a model sits
      behind ONE flag, ``PUBLIC_MARKETS_ENABLED``, default off, and
      answers a stable JSON 404. The RO storefront (``/api/public/ro/*``
      and the clean paths) is NOT behind that flag and keeps serving.

  L3  NO RAW ERRORS. An unhandled exception in any route returns a
      designed JSON body with an id and no traceback, no ``.py`` path,
      and no exception class name. FastAPI's own 422 is untouched.

  L4  SECURITY HEADERS on every API response.

  L5  ANONYMOUS AMPLIFICATION. ``GET /api/health`` pinged Supabase AND
      Stripe AND BNR on EVERY anonymous hit (measured live: 3.9 s), and
      ``fx_rates`` had no negative cache — with BNR down, N anonymous
      hits were N outbound 8-second fetches. Both are memoised now.

TC-11 — what this gate reds on AFTER the repairs:
  L1  the plant is deleting ``logger = logging.getLogger(__name__)`` from
      server.py; the test reds naming the NameError raised out of the
      handler that was supposed to swallow it. It would equally red on
      the opposite defect — a mount failure that is silently swallowed
      without any log record.
  L2  the plant is moving one route out from behind the flag (mounting
      ``create_public_company_router()`` unconditionally); the test reds
      naming that route and the status it answered instead of 404. It
      also reds if the wall over-reaches and swallows the RO storefront.
  L3  the plant is removing the handler; the body carries "Traceback"
      and the test reds quoting it.
  L4  the plant is deleting one header; the test reds naming it.
  L5  the plant is dropping either memo; the test reds with the second
      call's outbound count.

Hermetic: the app is built against the test-manifest Supabase URL with
boot verification skipped. Nothing here points at production.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient


def _hermetic_env() -> None:
    os.environ.setdefault("VITE_SUPABASE_URL", "https://test.supabase.co")
    os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "test-anon")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service")
    os.environ["CFO_AI_SKIP_BOOT_VERIFY"] = "1"
    assert "test." in os.environ["VITE_SUPABASE_URL"], (
        "refusing a non-manifest Supabase URL")


@pytest.fixture(scope="module")
def walled_app():
    """The PRODUCTION posture: PUBLIC_MARKETS_ENABLED unset."""
    _hermetic_env()
    os.environ.pop("PUBLIC_MARKETS_ENABLED", None)
    from engine.api.server import create_app

    return create_app()


@pytest.fixture(scope="module")
def open_app():
    """The same app with the markets surface explicitly enabled."""
    _hermetic_env()
    os.environ["PUBLIC_MARKETS_ENABLED"] = "1"
    try:
        from engine.api.server import create_app

        yield create_app()
    finally:
        os.environ.pop("PUBLIC_MARKETS_ENABLED", None)


def _paths(app, method: str = "GET"):
    out = []
    for r in app.routes:
        p = getattr(r, "path", None)
        methods = getattr(r, "methods", None) or set()
        if p and method in methods:
            out.append(p)
    return sorted(set(out))


def _concrete(path: str) -> str:
    """Substitute a harmless value for every path parameter."""
    parts = []
    for seg in path.split("/"):
        if seg.startswith("{") and seg.endswith("}"):
            parts.append("1" if "shard" in seg else "AAPL")
        else:
            parts.append(seg)
    return "/".join(parts)


# ── L1 — the guarded import actually guards ─────────────────────────────


def test_a_failing_storefront_mount_does_not_take_the_whole_api_down(monkeypatch):
    """The comment says "never fatal". Measure it.

    The plant that reds this: delete ``logger = logging.getLogger(__name__)``
    from server.py. The except block then raises NameError out of itself
    and create_app() dies — which is what happened before this gate.
    """
    _hermetic_env()
    monkeypatch.delenv("PUBLIC_MARKETS_ENABLED", raising=False)
    import engine.public_ro.pages.router as ro_router
    from engine.api.server import create_app

    def _boom():
        raise RuntimeError("public_ro.db not provisioned on this host")

    monkeypatch.setattr(ro_router, "build_router", _boom, raising=True)

    app = create_app()  # must not raise

    ro = [p for p in _paths(app) if p.startswith("/companii")]
    assert ro == [], (
        "the storefront mount was supposed to fail in this test; it did not, "
        "so the guard was never exercised: %r" % ro)
    # and the rest of the API is alive
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200


def test_the_server_module_has_the_logger_its_handlers_call():
    from engine.api import server

    lg = getattr(server, "logger", None)
    assert lg is not None and hasattr(lg, "exception"), (
        "server.py calls logger.exception() inside two except blocks that "
        "claim to be non-fatal; without a module-level logger that call is "
        "a NameError raised out of the handler.")


# ── L2 — the public-markets wall ────────────────────────────────────────

WALL_CODE = "surface_not_enabled"


def _markets_paths(app):
    """Every /api/public/* path that is NOT the RO storefront."""
    out = []
    for r in app.routes:
        p = getattr(r, "path", "") or ""
        methods = sorted((getattr(r, "methods", None) or set()) - {"HEAD", "OPTIONS"})
        if p.startswith("/api/public/") and not p.startswith("/api/public/ro/"):
            for m in methods:
                out.append((m, p))
    return sorted(set(out))


def test_the_markets_surface_exists_when_the_flag_is_on(open_app):
    """Positive control — without this the wall test could pass on an app
    that simply never had those routes."""
    found = _markets_paths(open_app)
    assert len(found) >= 20, found
    paths = set(p for _, p in found)
    for expected in (
        "/api/public/companies/{ticker}",
        "/api/public/search",
        "/api/public/universe",
        "/api/public/intelligence/risk-radar",
        "/api/public/intelligence/companies/{ticker}/ai-market-read",
        "/api/public/markets/company/{market}/{ticker}",
    ):
        assert expected in paths, (expected, sorted(paths))


def test_every_markets_route_is_walled_with_the_flag_off(walled_app, open_app):
    """The claim: with PUBLIC_MARKETS_ENABLED unset, not one of the routes
    that reaches a provider or a model answers anything but a stable 404."""
    client = TestClient(walled_app)
    failures = []
    for method, path in _markets_paths(open_app):
        url = _concrete(path)
        resp = client.request(method, url, json={} if method != "GET" else None)
        if resp.status_code != 404:
            failures.append("%s %s -> %s" % (method, url, resp.status_code))
            continue
        try:
            body = resp.json()
        except Exception:  # noqa: BLE001
            failures.append("%s %s -> 404 with a non-JSON body" % (method, url))
            continue
        code = (body.get("error") or {}).get("code")
        if code != WALL_CODE:
            failures.append("%s %s -> 404 %r (want error.code=%r)"
                            % (method, url, body, WALL_CODE))
    assert failures == [], (
        "the public-markets surface is hidden at launch, so these routes must "
        "not be reachable anonymously:\n  " + "\n  ".join(failures))


def test_the_wall_names_the_flag_that_lifts_it(walled_app):
    body = TestClient(walled_app).get("/api/public/companies/AAPL").json()
    details = (body.get("error") or {}).get("details") or {}
    assert details.get("flag") == "PUBLIC_MARKETS_ENABLED", body


def test_the_ro_storefront_is_not_behind_the_markets_flag(walled_app):
    """PS-scope: the RO storefront is deterministic, provider-free and
    rate-limited, and it keeps serving with the markets flag off."""
    client = TestClient(walled_app)
    ro = client.get("/api/public/ro/companies")
    assert ro.status_code != 404 or (ro.json().get("error") or {}).get("code") != WALL_CODE, (
        "the wall swallowed the RO storefront: %r" % (ro.text[:200],))
    sitemap = client.get("/sitemap.xml")
    assert sitemap.status_code in (200, 404, 503), sitemap.status_code
    if sitemap.status_code == 404:
        assert WALL_CODE not in sitemap.text, "the wall swallowed /sitemap.xml"


def test_the_ro_storefront_serve_path_reaches_no_outbound_module():
    """The claim "zero outbound hosts other than its own store", read from
    the code that serves a page rather than asserted."""
    import engine.public_ro.pages.router as ro

    src = open(ro.__file__, encoding="utf-8").read()
    for banned in ("urlopen", "httpx", "import requests", "anthropic"):
        assert banned not in src, (
            "the RO page router reaches a network transport (%r); the "
            "storefront's whole safety argument is that it does not." % banned)
    # ckan / anaf are the operator ingest path, never a serve path.
    for mod in ("ckan", "anaf_client"):
        assert mod not in src, mod


# ── L2b — the anonymous paid completion ─────────────────────────────────
#
# MEASURED 2026-09-05 against the real create_app() with the transport
# spies attached: an anonymous ``POST /api/analyze`` carrying a ~200-byte
# body answers 200 in 0.01 s having spent ONE api.anthropic.com
# completion (``powered_by: claude-sonnet-4-7``). No bearer, no rate
# limit, no usage gate — and in production ANTHROPIC_API_KEY is set while
# USAGE_LIMITS_ENABLED is false. That is money per anonymous hit,
# literally: a loop is a bill. ``/api/upload-excel`` reaches the same
# ``_build_analysis`` and the same model.
#
# Both routes belong to the LEGACY SKU / Products surface, which ships
# hidden at launch (the live upload path is the dashboard dropzone into
# the financial pipeline; UploadDialog is mounted nowhere). So they go
# behind a flag, default off, exactly like the markets surface.


def test_no_anonymous_request_can_spend_a_model_completion(walled_app, monkeypatch):
    """No anonymous request reaches the paid model, measured at the SDK.

    Self-contained on purpose: the richer transport harness lives with the
    public-egress wave (`tests/engine/public/egress_wire.py`) and imports
    that wave's uncommitted `engine.public.egress_ledger`, so depending on
    it would make this gate — and the launch commit that carries it —
    undeployable without unrelated code. A gate that cannot run in the tree
    it ships with is not a gate. The spy below is the minimum that answers
    the question this test asks: did anyone construct an Anthropic client
    and ask it for a completion.
    """
    import sys
    import types

    class _Recorder(object):
        def __init__(self):
            self.calls = 0
        def reset(self):
            self.calls = 0
        def completions(self):
            return self.calls
        def hosts(self):
            return {"api.anthropic.com": self.calls} if self.calls else {}

    rec = _Recorder()

    class _Messages(object):
        def create(self, *a, **kw):
            rec.calls += 1
            block = types.SimpleNamespace(text="{}", type="text")
            return types.SimpleNamespace(content=[block],
                                         usage=types.SimpleNamespace(
                                             input_tokens=1, output_tokens=1))

    class _Client(object):
        def __init__(self, *a, **kw):
            self.messages = _Messages()

    fake = types.ModuleType("anthropic")
    fake.Anthropic = _Client            # type: ignore[attr-defined]
    fake.APIError = Exception           # type: ignore[attr-defined]
    fake.APIStatusError = Exception     # type: ignore[attr-defined]
    fake.RateLimitError = Exception     # type: ignore[attr-defined]
    fake.APIConnectionError = Exception  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "anthropic", fake)
    rec.escapes = []                    # type: ignore[attr-defined]

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-FAKE-for-this-gate")
    client = TestClient(walled_app, raise_server_exceptions=False)
    run = {"eliminate": [{"name": "Cat A", "realMargin": -12.0,
                          "absoluteProfit": -900.0, "reason": "below hurdle"}],
           "review": [], "scale": [], "anchors": []}
    spenders = []
    for method, url, body in (
        ("POST", "/api/analyze", {"run": run}),
        ("POST", "/api/upload-excel", {"run": run}),
    ):
        rec.reset()
        resp = client.request(method, url, json=body)
        if rec.completions():
            spenders.append("%s %s -> %s, %d paid completion(s) to %s"
                            % (method, url, resp.status_code,
                               rec.completions(), rec.hosts()))
    assert rec.escapes == [], rec.escapes
    assert spenders == [], (
        "ANONYMOUS ROUTES THAT SPEND A PAID MODEL CALL — one loop is one "
        "bill:\n  " + "\n  ".join(spenders))


def test_the_legacy_sku_ai_routes_are_walled_with_a_stable_body(walled_app):
    client = TestClient(walled_app, raise_server_exceptions=False)
    for url in ("/api/analyze", "/api/upload-excel"):
        resp = client.post(url, json={})
        assert resp.status_code == 404, (url, resp.status_code)
        body = resp.json()
        assert (body.get("error") or {}).get("code") == WALL_CODE, (url, body)
        assert (body["error"]["details"] or {}).get("flag") == "LEGACY_SKU_AI_ENABLED", body


def test_the_legacy_sku_ai_routes_come_back_when_their_flag_is_set(monkeypatch):
    """Positive control — the wall is a flag, not a deletion."""
    _hermetic_env()
    monkeypatch.setenv("LEGACY_SKU_AI_ENABLED", "1")
    monkeypatch.delenv("PUBLIC_MARKETS_ENABLED", raising=False)
    from engine.api.server import create_app

    client = TestClient(create_app(), raise_server_exceptions=False)
    resp = client.post("/api/analyze", json={})
    assert resp.status_code == 422, (
        "with the flag on the route must be reachable again (422 = the "
        "route validated the empty body), got %s" % resp.status_code)


def test_the_deterministic_sku_compute_routes_are_untouched(walled_app):
    """Only the two routes that reach a MODEL are walled. The four that
    compute deterministically from the body still answer — walling them
    would be scope creep, and their cost is CPU, not money (measured:
    0.17-0.58 s on a 2.2 MB body). Their body-size + rate limit is a
    BACKLOG ticket (LB-SKU-1), not a launch change."""
    client = TestClient(walled_app, raise_server_exceptions=False)
    for url in ("/api/classify-rows", "/api/skus", "/api/alerts", "/api/drill"):
        resp = client.post(url, json={})
        assert resp.status_code == 422, (url, resp.status_code)


# ── L3 — no raw errors ──────────────────────────────────────────────────


def test_an_unhandled_exception_returns_a_designed_body(walled_app):
    from fastapi import APIRouter

    router = APIRouter()

    @router.get("/api/_launch_test/boom")
    def _boom():
        raise RuntimeError("the customer must never read this string")

    walled_app.include_router(router)
    client = TestClient(walled_app, raise_server_exceptions=False)
    resp = client.get("/api/_launch_test/boom")
    assert resp.status_code == 500, resp.status_code
    text = resp.text
    assert resp.headers.get("content-type", "").startswith("application/json"), (
        "an unhandled error answered %r with body %r — there is no designed "
        "error body, so the caller gets whatever the framework prints"
        % (resp.headers.get("content-type"), text[:200]))
    for leak in ("Traceback", ".py", "RuntimeError",
                 "the customer must never read this string"):
        assert leak not in text, (
            "the 500 body leaks %r:\n%s" % (leak, text[:800]))
    body = resp.json()
    assert (body.get("error") or {}).get("id"), body
    assert (body.get("error") or {}).get("code") == "internal_error", body


def test_validation_errors_are_still_422(walled_app):
    """The handler must not swallow FastAPI's own contract."""
    client = TestClient(walled_app, raise_server_exceptions=False)
    resp = client.post("/api/sessions/track", json={})
    assert resp.status_code == 422, (resp.status_code, resp.text[:300])


# ── L4 — security headers ───────────────────────────────────────────────

REQUIRED_HEADERS = {
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=()",
}


@pytest.mark.parametrize("header,fragment", sorted(REQUIRED_HEADERS.items()))
def test_api_responses_carry_the_security_header(walled_app, header, fragment):
    resp = TestClient(walled_app).get("/health")
    got = resp.headers.get(header)
    assert got is not None, "missing %s (have: %s)" % (
        header, sorted(resp.headers.keys()))
    assert fragment in got, (header, got)


def test_the_csp_is_report_only_on_the_api(walled_app):
    """A hard CSP on a Vite SPA without testing is a P0 waiting to happen.
    Report-Only now; enforcement is a backlog ticket."""
    resp = TestClient(walled_app).get("/health")
    assert resp.headers.get("content-security-policy") is None, (
        "an ENFORCED CSP shipped without being tested against the SPA")
    assert "frame-ancestors" in (
        resp.headers.get("content-security-policy-report-only") or "")


# ── L5 — anonymous amplification ────────────────────────────────────────


def test_api_health_pings_its_dependencies_at_most_once_per_window(walled_app, monkeypatch):
    """/api/health is anonymous and pinged Supabase + Stripe + BNR on EVERY
    hit. The second call inside the window must ping nothing."""
    from engine.api import _health

    calls = {"n": 0}

    def _counting_db():
        calls["n"] += 1
        return {"ok": True, "latency_ms": 0.0}

    monkeypatch.setattr(_health, "_check_db", _counting_db, raising=True)
    monkeypatch.setattr(_health, "_check_stripe",
                        lambda: {"ok": True, "latency_ms": 0.0}, raising=True)
    monkeypatch.setattr(_health, "_check_fx_rates",
                        lambda: {"ok": True, "latency_ms": 0.0}, raising=True)
    _health.reset_health_cache()

    client = TestClient(walled_app)
    first = client.get("/api/health")
    second = client.get("/api/health")
    assert first.status_code == 200 and second.status_code == 200
    assert calls["n"] == 1, (
        "every anonymous /api/health hit pinged the database %d times; the "
        "deep probe must be memoised for its window" % calls["n"])
    assert second.json().get("cached") is True, second.json()


def test_api_health_reports_the_operator_fields(walled_app, monkeypatch):
    from engine.api import _health

    _health.reset_health_cache()
    body = TestClient(walled_app).get("/api/health").json()
    for field in ("version", "mode", "checks", "sentry", "country_packs",
                  "public_markets"):
        assert field in body, (field, sorted(body.keys()))
    assert isinstance(body["sentry"], dict) and "configured" in body["sentry"]
    assert body["public_markets"]["enabled"] is False


def test_a_dead_bnr_is_fetched_once_not_once_per_anonymous_hit(monkeypatch):
    """With BNR unreachable there was no negative cache: every anonymous
    GET /api/fx-rates was a fresh 8-second outbound fetch."""
    from engine.api import fx_rates

    fx_rates.reset_fx_cache()
    attempts = {"n": 0}

    def _dead():
        attempts["n"] += 1
        raise OSError("bnr.ro unreachable")

    monkeypatch.setattr(fx_rates, "_fetch_bnr_rates", _dead, raising=True)

    payloads = [fx_rates.get_fx_rates() for _ in range(5)]
    assert attempts["n"] == 1, (
        "5 anonymous reads made %d outbound BNR fetches; a failure must be "
        "memoised for its cooldown" % attempts["n"])
    for p in payloads:
        assert p["rates"]["RON"] > 0 and p["stale"] is True, p


def test_a_forced_refresh_still_bypasses_the_negative_cache(monkeypatch):
    """The cooldown must not make the operator's ?refresh=true a no-op."""
    from engine.api import fx_rates

    fx_rates.reset_fx_cache()
    attempts = {"n": 0}

    def _dead():
        attempts["n"] += 1
        raise OSError("bnr.ro unreachable")

    monkeypatch.setattr(fx_rates, "_fetch_bnr_rates", _dead, raising=True)
    fx_rates.get_fx_rates()
    fx_rates.get_fx_rates(force_refresh=True)
    assert attempts["n"] == 2, attempts["n"]
