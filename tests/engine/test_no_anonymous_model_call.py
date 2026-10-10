"""THE NO-ANONYMOUS-MODEL-CALL LAW — gate ``no-anonymous-model-call``.

THE INCIDENT (measured 2026-10-04, by a read-only audit and then on
production). ``POST /api/financial-statements/parse`` was mounted
unconditionally on the real app and took NO Authorization header, no
dependency, no meter and no rate limiter. It sent the caller's PDF
(``pdf_b64``) — or FETCHED A URL THE CALLER NAMED (``pdf_url``), addresses
inside the Docker network included, the whole body read into memory before
any size check — to the model on the backend's key and returned the model's
text. An anonymous POST with a 20-byte body answered 502 with the model
API's 401 inside on both production hosts: the route reached the model
client; only the backend's key being invalid stopped the spend. No screen
ever called it. The upload pipeline calls the handler IN-PROCESS.

THE LAW. No request a stranger can send makes this backend construct or call
a model client, or fetch a host the stranger named.

  Over EVERY route of the real ``create_app()`` — the route TREE: a
  sub-application mounted with ``app.mount`` is walked into and its routes
  swept under their prefix — every method it lists, path parameters filled,
  for a body-carrying method a JSON ``{}``, the bodies that matter
  (``pdf_b64``, ``pdf_url``, ``messages``, ``document_id``, ``run``…), every
  body its own schema accepts, a multipart file, a RAW PDF as the request
  body (``application/pdf`` and ``application/octet-stream``), and every
  query / header / cookie parameter the route or a dependency of it
  DECLARES filled three ways (by its schema; every boolean and free string
  as ``1``; as ``true``) — sent as (a) no Authorization header, (b) a
  forged bearer (a three-part token signed by a key the JWKS does not
  hold), (c) the project's PUBLIC anon key as the bearer; with a planted
  non-empty model key in the environment, the model SDKs (``anthropic``,
  and ``openai`` for the orchestrator's GPT adapter) replaced by recorders,
  and every outbound transport replaced by an answering recorder:

    * ZERO model clients constructed and ZERO model calls, except on the
      routes DECLARED in ``DECLARED`` below, each with the bound that makes
      it acceptable — and a declared route that no longer reaches a model is
      a red too (the list is exact, it only shrinks deliberately);
    * ZERO outbound requests to a host the caller named, on any route;
    * every host the backend contacts at all is in ``OUTBOUND_HOSTS`` for
      the state — a model bought over plain HTTP at an address that is
      neither SDK's is a model call the first rule cannot name;
    * every route a request can reach is a FastAPI ``APIRoute`` the sweep
      entered: a plain Starlette route, a websocket route or a mount with no
      route list reds by name.

  In two flag states: ``closed`` (no surface flag — the public markets
  surface is a 404) and ``open`` (PUBLIC_MARKETS_ENABLED and
  SEC_EDGAR_ENABLED set, with the cockpit and the AI lanes on, so the
  widest route table is swept). THE TWO STATES ARE THE WHOLE FLAG SPACE, and
  that is a law too: a route registered under any condition other than the
  flags in ``ROUTE_FLAGS`` (each on in ``open``, off in ``closed``) exists
  in neither state, so it reds in the source census instead.

WHAT THE REVIEW OF 2026-10-04 FOUND GREEN (each planted alone, each proven a
real model call by a direct anonymous request, the gate 56 passed every
time): the PDF lane mounted back through a sub-application; mounted on the
main app behind a new flag; a plain ``app.add_route`` calling the model; a
model call behind ``?ai=true``, behind ``X-Use-Ai: 1``, behind a raw
``application/pdf`` body; a completion bought at another host over httpx.
The sweep sent one bare GET to anything that was not an ``APIRoute``, never
looked inside a mount, filled required parameters only, and counted two
hosts as "a model". Each is a law here now, and a plant in gates.md.

WHY A 404 OR A 422 IS NOT EVIDENCE. A route answered before its handler ran
proves nothing about the handler. Every route's endpoint is instrumented
(``Dependant.call`` wrapped, kind preserved) and the sweep must ENTER it, or
the refusal must be a wall (the surface wall's own 404 body) or an auth
dependency (401 / 403 / 503 with the handler never entered). Anything else —
a route only ever answered 422 / 405 / a router 404 — reds as UNPROVEN,
naming the route. The parse route is the proof the sweep reaches: with its
mount planted back the law is RED (docs/engine_book/gates.md).

WHY THE TRANSPORT ANSWERS. A recorder that raises makes every line after a
successful provider response unreachable (tests/engine/public/egress_wire.py
has the history): the public filings chain is four EDGAR hops and THEN a
completion. So ``httpx`` is replaced at the transport
(``HTTPTransport.handle_request`` — the client's own redirect and timeout
logic still runs), ``urllib`` at ``OpenerDirector.open``, ``requests`` at
``HTTPAdapter.send``, and each answers a 200 a real parser accepts: the
provider bodies of the shared wire harness, PostgREST-shaped empties for the
project's own Supabase host (a signed URL for a sign request, a PDF for a
storage download), a PDF for a caller-named host. A socket tripwire under all
of them records and refuses. The MODEL recorder raises after recording, so no
handler consumes or caches a made-up answer.

THE PDF LANE'S OWN LAWS are here too, on the handler itself: a URL that
is not this project's document storage is refused before any request; the
request carries exactly the path the check read (a key with a space is sent
percent-encoded, not refused); with no project configured nothing is
fetched; no redirect is followed; the 25 MB cap is enforced while reading;
every phase has a timeout and the body a deadline (the status line and the
headers are bounded per read only); bytes that are not a PDF never reach the
model; and the pipeline's in-process contract (``build_router()`` → the
route named ``parse_document``) holds.

WHAT THIS GATE CANNOT SEE
  * SIGNED-IN spend: a member's re-runs, failed runs, ``/reconcile``,
    ``/briefing/regenerate`` (other lanes' gates); the plan a free account
    resolves to; the breaker's counting.
  * A handler that dies at a service-role READ: the project's Supabase host
    answers PostgREST-shaped EMPTIES here, which is what a stranger naming a
    made-up id gets. A stranger naming a REAL row's id on a route that reads
    it through the service role with no bearer check would go further than
    this sweep does — the member wall on every mutating route is
    tests/engine/test_identity_wall.py's census, not this one's.
  * The public reads' ceiling ACROSS containers or restarts: the counter is
    in memory, per process (``engine.public.egress_ledger``).
  * A model call made by a thread still running after the sweep's last
    request plus its grace period, or from an executor worker.
  * A provider reached through a transport none of the four recorders
    replace AND with no socket (there is none in this tree today).
  * A model reached at a host ``OUTBOUND_HOSTS`` already declares for
    something else (a completion endpoint on the project's own Supabase
    host, say): the census is by host, not by path.
  * A switch a handler reads WITHOUT declaring it — ``request.query_params
    .get("ai")``, ``request.headers.get("x-use-ai")`` — other than the keys
    every request carries (``QUERY_EXTRAS``, ``SPOOF_HEADERS``); a declared
    string that must hold a particular word other than ``1`` / ``true`` or
    what its schema names; a switch inside a JSON body the route's schema
    does not describe; a raw body that is not PDF bytes under one of the two
    media types sent.
  * A model call inside an existing handler behind an ENVIRONMENT flag
    neither state sets. (A ROUTE behind such a flag is the source census's
    red; behaviour inside a handler is not.)
  * A route registered by a helper that is itself called under a condition
    OUTSIDE ``create_app`` (inside it, any condition that touches the app
    reds), or by a router factory that builds its route list from a setting.
  * The Edge Function (``supabase/functions/chat-llm``): not this app.
  * What the front proxy routes: this is the app's own route table.

AFTER THE REPAIR this gate reds on: the PDF lane's handler served by any
route of the tree in either state (mounts walked into), and ANY reference to
the lane's module under src/ outside the pipeline's in-process call — which
is what a mount behind a flag this gate never sets starts with; a route
registered under a condition that is not a declared route flag, or after an
early exit; a route that is not an ``APIRoute``, or a mount the sweep cannot
enumerate; any new route — in the app or in a mounted sub-application — that
reaches a model client for a caller with no verified identity, an optional
declared parameter or a raw PDF body included; a host contacted that
``OUTBOUND_HOSTS`` does not declare; a declared public read that stops
reaching the model (the census is stale) or whose completions are no longer
reserved against the daily ceiling; the legacy SKU wall removed; a route that
fetches a URL its caller named; a route the sweep can no longer enter; the
handler fetching outside the project's storage (port 0, an escape inside the
fixed prefix or standing for a separator, a host label that does not decode),
refusing a storage key that holds a space, following a redirect, reading past
the cap, losing its timeout, or sending non-PDF bytes to the model.

NOTE ON INVARIANT IDS. This file claims NO bare invariant marker (a capital
letter and digits): scripts/generate_engine_book.py would credit it with
someone else's invariant. The register is docs/engine_book/gates.md.

Hermetic: nothing leaves the machine (every transport is replaced, the
socket tripwire refuses the rest); the app is built against the test-manifest
Supabase URL with boot verification skipped; every on-disk store is in a
temporary directory. Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import ast
import base64
import importlib.util
import json
import os
import re
import socket
import sys
import threading
import time
import types
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Set, Tuple

import httpx
import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from starlette.routing import Mount, Route

import firm_postgrest_double as D

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"

# ── the shared wire harness (provider bodies a real parser accepts) ──────
_WIRE_PATH = Path(__file__).resolve().parent / "public" / "egress_wire.py"
_spec = importlib.util.spec_from_file_location("no_anon_model_wire", str(_WIRE_PATH))
wire = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wire)  # type: ignore[union-attr]

GATE = "no-anonymous-model-call"
UUID = "00000000-0000-0000-0000-000000000001"

# ══════════════════════════════════════════════════════════════════════
# THE CENSUS — the only anonymous routes that may reach a model client
# ══════════════════════════════════════════════════════════════════════

_PUBLIC_BOUND = (
    "public market read, mounted only with PUBLIC_MARKETS_ENABLED: every completion is "
    "reserved in engine.public.egress_ledger BEFORE it is sent — PUBLIC_LLM_COMPLETIONS_PER_DAY, "
    "default 300 per UTC day per container, across both paid paths (measured below: "
    "test_the_declared_public_reads_stop_at_their_daily_ceiling); behind the per-client "
    "egress guard and the read's own cache (tests/engine/test_public_egress.py)")

#: (method, route template) -> the bound that makes an anonymous model call
#: there acceptable. EXACT in the ``open`` state: a route here that the sweep
#: no longer sees reaching a model reds, exactly like a route that is not
#: here and does. ``closed`` declares nothing — the surface is a 404.
DECLARED = {
    ("GET", "/api/public/intelligence/companies/{ticker}/ai-market-read"):
        "the market-read narrative (one completion) over the filings-derived profile "
        "(one more with SEC_EDGAR_ENABLED) — " + _PUBLIC_BOUND,
    ("GET", "/api/public/intelligence/companies/{ticker}/exposure"):
        "the filings-derived exposure profile (SEC_EDGAR_ENABLED: one extraction per "
        "ticker and accession per process) — " + _PUBLIC_BOUND,
    ("GET", "/api/public/intelligence/companies/{ticker}/risk-score"):
        "scores over the same filings-derived profile — " + _PUBLIC_BOUND,
    ("GET", "/api/public/intelligence/supply-chain"):
        "the same filings-derived profile, for ?ticker= — " + _PUBLIC_BOUND,
}  # type: Dict[Tuple[str, str], str]

DECLARED_IN = {"closed": set(), "open": set(DECLARED)}  # type: Dict[str, Set[Tuple[str, str]]]

#: The most completions ONE anonymous request to a declared route may cost
#: (the narrative plus the filings extraction it shares).
MAX_COMPLETIONS_PER_DECLARED_REQUEST = 2

#: EVERY host the backend may contact for a caller with no verified identity,
#: per flag state, each with what is asked of it. A model is a model at any
#: host: the two SDK modules and ``MODEL_API_HOSTS`` are how this tree reaches
#: one TODAY, and a provider reached over plain HTTP at another address (an
#: aggregator, a self-hosted endpoint, a new vendor) would be none of them —
#: so a host that is not here reds, whatever it is. An UPPER bound, not an
#: exact list: a provider's own cache (the FX feed's five-minute memo) decides
#: whether a declared host is contacted in a given run.
_SUPABASE_WHY = (
    "the project's own Supabase: the signature keys, and PostgREST reads / writes made with "
    "the service role for a caller who named rows (answered here as empty)")
OUTBOUND_HOSTS = {
    "closed": {
        "test.supabase.co": _SUPABASE_WHY,
        # release/r-trust reads the feed where the bank moved it (curs.bnr.ro)
        # and keeps the old address as the fallback (engine.api.fx_rates).
        "curs.bnr.ro": "GET /api/fx-rates: the central bank's daily reference rates, where BNR moved the feed (public, no key)",
        "www.bnr.ro": "GET /api/fx-rates: the feed's previous address, tried when the first does not answer (public, no key)",
    },
    "open": {
        "test.supabase.co": _SUPABASE_WHY,
        # release/r-trust reads the feed where the bank moved it (curs.bnr.ro)
        # and keeps the old address as the fallback (engine.api.fx_rates).
        "curs.bnr.ro": "GET /api/fx-rates: the central bank's daily reference rates, where BNR moved the feed (public, no key)",
        "www.bnr.ro": "GET /api/fx-rates: the feed's previous address, tried when the first does not answer (public, no key)",
        "query1.finance.yahoo.com": "the public markets surface: quotes (no key), behind the egress guard",
        "www.sec.gov": "the public markets surface: EDGAR filing index and documents (no key)",
        "data.sec.gov": "the public markets surface: EDGAR company facts and submissions (no key)",
    },
}  # type: Dict[str, Dict[str, str]]

#: Routes the sweep cannot ENTER and that are refused by neither a wall nor
#: an auth dependency, each with why that is still evidence. Empty on
#: purpose: a route landing here must be argued for, not waved through.
UNPROVEN_DECLARED = {}  # type: Dict[Tuple[str, str], str]

# ── the two flag states ──────────────────────────────────────────────────

PLANTED_MODEL_KEY = "planted-model-key-for-the-no-anonymous-model-call-gate"
OPERATOR_TOKEN = "an-operator-token-the-sweep-never-sends"
SUPABASE_HOST = "test.supabase.co"


def _b64url(obj):  # type: (Any) -> str
    raw = obj if isinstance(obj, bytes) else json.dumps(obj, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


#: A syntactically plausible PUBLIC anon key: the three-part HS256 token a
#: Supabase project ships in its frontend bundle (role ``anon``). Anyone has
#: it; sent as a bearer it must be nobody.
ANON_KEY = ".".join((
    _b64url({"alg": "HS256", "typ": "JWT"}),
    _b64url({"iss": "supabase", "ref": "testmanifestref", "role": "anon",
             "iat": 1700000000, "exp": 4102444800}),
    _b64url(b"not-a-signature-anyone-could-verify-0123456789abcdef"),
))

_ENV_OFF = (
    "PUBLIC_TEST_MODE", "PRICING_ADMIN_USER_IDS", "SUPABASE_JWT_SECRET",
    "PUBLIC_MARKETS_ENABLED", "SEC_EDGAR_ENABLED", "FIRM_COCKPIT_ENABLED",
    "LEGACY_SKU_AI_ENABLED", "ANOMALY_RADAR_ENABLED", "AI_ADVISORY_ENABLED",
    "AI_STRUCTURAL_READER", "CONSENSUS_SHADOW", "CONSENSUS_ENABLED",
    "USAGE_LIMITS_ENABLED", "USAGE_UNMETERED_USER_IDS", "NASDAQ_API_KEY",
    "NASDAQ_DATA_LINK_API_KEY", "POLYGON_API_KEY", "PROVIDER_API_KEY",
    "NEWS_API_KEY", "RSS_FEED_URLS", "FRED_API_KEY", "EIA_API_KEY",
    "GDELT_ENABLED", "PUBLIC_LLM_COMPLETIONS_PER_DAY",
    "PUBLIC_PROVIDER_DAILY_CEILINGS", "PUBLIC_PROVIDER_DAILY_CEILING_DEFAULT",
    "ANTHROPIC_WORKSPACE_ID", "PDF_SERVICE_TOKEN", "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET", "RESEND_API_KEY", "SENTRY_DSN",
    "ENGINE_JOURNAL_DIR", "CFO_FEATURES_ACTIVE", "HTTP_PROXY", "HTTPS_PROXY",
    "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
)

_BASE_ENV = {
    "VITE_SUPABASE_URL": "https://%s" % SUPABASE_HOST,
    "VITE_SUPABASE_ANON_KEY": ANON_KEY,
    "SUPABASE_SERVICE_ROLE_KEY": "test-service",
    "CFO_AI_SKIP_BOOT_VERIFY": "1",
    "ENGINE_QUOTA_LEDGER_MAINTENANCE": "0",
    "ENGINE_ACCESS_LOG": "0",
    "ANTHROPIC_API_KEY": PLANTED_MODEL_KEY,
    "OPENAI_API_KEY": PLANTED_MODEL_KEY,
    "ENGINE_API_TOKEN": OPERATOR_TOKEN,
}

STATES = {
    # What a deployment with no surface flag mounts: the public markets
    # surface and the legacy SKU AI routes are a wall's 404.
    "closed": {},
    # The widest table: the markets surface with its filings layer, the
    # cockpit, the radar, the AI lanes and the meter on.
    "open": {
        "PUBLIC_MARKETS_ENABLED": "1",
        "SEC_EDGAR_ENABLED": "1",
        "FIRM_COCKPIT_ENABLED": "1",
        "ANOMALY_RADAR_ENABLED": "1",
        "AI_ADVISORY_ENABLED": "1",
        "AI_STRUCTURAL_READER": "1",
        "CONSENSUS_SHADOW": "1",
        "USAGE_LIMITS_ENABLED": "true",
        "FIRM_REQUEST_SIGNING_KEY": "no-anonymous-model-call-signing-key-0123456789",
    },
}  # type: Dict[str, Dict[str, str]]

# ══════════════════════════════════════════════════════════════════════
# What a caller can name
# ══════════════════════════════════════════════════════════════════════

#: Every URL the sweep supplies carries this marker, so a request the server
#: makes to a caller-SUPPLIED URL is recognised whatever host it names — the
#: project's own storage included.
CALLER_MARKER = "caller-named-marker-7f3a"
CALLER_HOSTS = frozenset({
    "caller-named-body.invalid",        # a host in a JSON body
    "caller-named-query.invalid",       # … in a query parameter
    "caller-named-header.invalid",      # … in a request header
    "cfo-ai-pdf",                       # a name inside the Docker network
    "198.51.100.7",                     # an address literal
    "169.254.169.254",                  # the metadata address
})
MODEL_API_HOSTS = frozenset({"api.anthropic.com", "api.openai.com"})

URL_BODY = "http://caller-named-body.invalid/%s/x.pdf" % CALLER_MARKER
URL_INTERNAL = "http://cfo-ai-pdf:3000/%s/render" % CALLER_MARKER
URL_IP = "http://198.51.100.7/%s/x.pdf" % CALLER_MARKER
URL_METADATA = "http://169.254.169.254/latest/%s" % CALLER_MARKER
URL_QUERY = "https://caller-named-query.invalid/%s" % CALLER_MARKER
URL_HEADER = "https://caller-named-header.invalid/%s" % CALLER_MARKER
#: The project's OWN storage, named by the caller: the one URL the PDF lane
#: accepts. A stranger able to hand it over would make the backend fetch and
#: read whatever the token opens.
URL_OWN_STORAGE = ("https://%s/storage/v1/object/sign/documents/%s/uploads/%s.pdf?token=%s"
                   % (SUPABASE_HOST, UUID, UUID, CALLER_MARKER))

#: Short enough for a length-capped field: the body where EVERY free string
#: is a URL (a handler may fetch from a field no one would call "url").
URL_SHORT = "http://198.51.100.7/x"

TINY_PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
PDF_B64 = base64.b64encode(TINY_PDF).decode("ascii")

_SKU_RUN = {"eliminate": [{"name": "Cat A", "realMargin": -12.0, "absoluteProfit": -900.0,
                           "reason": "below hurdle"}],
            "review": [], "scale": [], "anchors": [],
            "categories": [{"name": "Cat A", "decision": "eliminate"}]}

#: The bodies that matter, as one rich JSON object: every field name a model
#: lane in this tree reads from a request.
RICH_BODY = {
    "args": {}, "pdf_b64": PDF_B64, "original_filename": "balanta.pdf",
    "document_id": UUID, "period_id": UUID, "org_id": UUID, "dataset_id": UUID,
    "intent": "user", "force": True, "language": "en", "output_language": "en",
    "jurisdiction": "HU", "run": _SKU_RUN, "rows": [],
    "messages": [{"role": "user", "content": "Summarise my company."}],
    "message": "Summarise my company.", "question": "Summarise my company.",
    "prompt": "Summarise my company.", "ticker": "AAPL", "tickers": ["AAPL", "MSFT"],
    "email": "probe@example.invalid", "name": "probe",
}
#: The same, with every URL-shaped field a caller could fill and NO inline
#: document — a handler that prefers ``pdf_b64`` never reads the URL.
URL_BODY_JSON = {
    "pdf_url": URL_BODY, "url": URL_INTERNAL, "file_url": URL_IP, "source_url": URL_METADATA,
    "image_url": URL_BODY, "callback_url": URL_INTERNAL, "webhook_url": URL_INTERNAL,
    "redirect_to": URL_BODY, "return_url": URL_BODY, "success_url": URL_BODY,
    "cancel_url": URL_BODY, "original_filename": "balanta.pdf", "document_id": UUID,
    "period_id": UUID, "language": "en", "args": {"url": URL_INTERNAL},
    "name": URL_SHORT, "source": URL_SHORT, "target": URL_SHORT, "host": "198.51.100.7",
    "path": URL_SHORT, "file": URL_SHORT, "document": URL_SHORT, "image": URL_SHORT,
    "message": URL_SHORT, "email": "probe@caller-named-body.invalid",
}
OWN_STORAGE_BODY = {"pdf_url": URL_OWN_STORAGE, "url": URL_OWN_STORAGE,
                    "original_filename": "balanta.pdf", "document_id": UUID}

QUERY_EXTRAS = {"q": "app", "ticker": "AAPL", "url": URL_QUERY, "pdf_url": URL_QUERY,
                "next": URL_QUERY, "redirect_to": URL_QUERY, "callback": URL_QUERY}

SPOOF_HEADERS = {"Referer": URL_HEADER, "Origin": "https://caller-named-header.invalid",
                 "X-Forwarded-Host": "caller-named-header.invalid", "X-Org-Id": UUID}

PATH_VALUES = {"ticker": "AAPL", "market": "us", "cui": "1234567", "run_date": "2026-01-01",
               "shard": "0001", "slug": "agricultura", "key": "probe-1234567",
               "token": "caller-token", "name": "get_facts", "rec_id": "1",
               "rule_id": "1", "kind": "welcome"}

# ══════════════════════════════════════════════════════════════════════
# The ledger and the recorders
# ══════════════════════════════════════════════════════════════════════


class ModelCallRecorded(Exception):
    """Raised by the recording SDK after it recorded: nothing downstream
    consumes, stores or caches a made-up model answer."""


class Ledger(object):
    """Everything the sweep's requests caused, attributed to the request in
    flight (the sweep is sequential)."""

    def __init__(self):  # type: () -> None
        self.lock = threading.Lock()
        self.current = None  # type: Optional[Dict[str, Any]]
        self.last_label = "(before the first request)"
        self.model = []  # type: List[Dict[str, Any]]
        self.outbound = []  # type: List[Dict[str, Any]]
        self.reached = set()  # type: Set[Tuple[str, str]]
        self.threads = []  # type: List[threading.Thread]
        self.respond_with = None  # type: Optional[str]

    def _where(self):  # type: () -> Dict[str, Any]
        cur = self.current
        if cur is None:
            return {"route": None, "label": "(between requests, after %s)" % self.last_label}
        return {"route": cur["route"], "label": cur["label"]}

    def model_event(self, sdk, what, detail=""):  # type: (str, str, str) -> None
        with self.lock:
            event = self._where()
            event.update({"sdk": sdk, "what": what, "detail": detail,
                          "thread": threading.current_thread().name})
            self.model.append(event)

    def outbound_event(self, transport, url, method="GET"):  # type: (str, str, str) -> Dict[str, Any]
        host = _host_of(url)
        with self.lock:
            event = self._where()
            event.update({"transport": transport, "host": host, "method": method,
                          "url": url.split("?", 1)[0][:160],
                          "caller_named": host in CALLER_HOSTS or CALLER_MARKER in url})
            self.outbound.append(event)
        if host in MODEL_API_HOSTS:
            # A model call that went round the SDK recorder (a client built
            # before it was installed, or a raw HTTP call to the API).
            self.model_event("transport", "request", "%s %s" % (method, host))
        return event

    def enter(self, method, path):  # type: (str, str) -> None
        with self.lock:
            self.reached.add((method, path))


def _host_of(url):  # type: (str) -> str
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower()
    except ValueError:
        return wire.host_of(url)


def _fake_sdk(name, ledger):  # type: (str, Ledger) -> types.ModuleType
    """A module standing in for ``anthropic`` / ``openai``: every client class
    records its construction, every method on it (``messages.create``,
    ``messages.stream``, ``responses.create``, ``chat.completions.create``,
    ``models.list`` …) records the call."""

    class _Path(object):
        def __init__(self, path):  # type: (Tuple[str, ...]) -> None
            self._path = path

        def __getattr__(self, item):  # type: (str) -> Any
            if item.startswith("__"):
                raise AttributeError(item)
            return _Path(self._path + (item,))

        def __call__(self, *a, **kw):  # type: (*Any, **Any) -> Any
            ledger.model_event(name, "call", "%s model=%s max_tokens=%s" % (
                ".".join(self._path), kw.get("model"),
                kw.get("max_tokens", kw.get("max_output_tokens"))))
            if ledger.respond_with is None:
                raise ModelCallRecorded("%s.%s recorded" % (name, ".".join(self._path)))
            block = types.SimpleNamespace(type="text", text=ledger.respond_with)
            usage = types.SimpleNamespace(input_tokens=1, output_tokens=1,
                                          cache_read_input_tokens=0, cache_creation_input_tokens=0)
            return types.SimpleNamespace(content=[block], usage=usage, model="recorded-model",
                                         stop_reason="end_turn", output_text=ledger.respond_with)

    class _Client(object):
        def __init__(self, *a, **kw):  # type: (*Any, **Any) -> None
            ledger.model_event(name, "construct", "%s(%s)" % (
                type(self).__name__, ", ".join(sorted(k for k in kw if k != "api_key"))))

        def __getattr__(self, item):  # type: (str) -> Any
            if item.startswith("__"):
                raise AttributeError(item)
            return _Path((item,))

    mod = types.ModuleType(name)
    made = {}  # type: Dict[str, Any]

    def _module_getattr(attr):  # type: (str) -> Any
        if attr.startswith("__"):
            raise AttributeError(attr)
        if attr not in made:
            if attr.endswith(("Error", "Exception")):
                made[attr] = type(attr, (Exception,), {})
            elif attr[:1].isupper():
                made[attr] = type(attr, (_Client,), {})
            else:
                raise AttributeError(attr)
        return made[attr]

    mod.__getattr__ = _module_getattr  # type: ignore[attr-defined]
    mod.__version__ = "0.0-recorder"  # type: ignore[attr-defined]
    return mod


def _supabase_answer(method, url):  # type: (str, str) -> Tuple[int, Dict[str, str], bytes]
    """The project's own Supabase host, answered the way it answers a caller
    who names rows that do not exist — and a storage that signs and serves,
    so a chain that got as far as the PDF lane would run to the model."""
    path = urllib.parse.urlsplit(url).path
    js = {"content-type": "application/json"}
    if path.startswith("/auth/v1/"):
        return 401, js, b'{"code":401,"msg":"invalid JWT"}'
    if path.startswith("/storage/v1/object/sign/") and method == "POST":
        rest = path[len("/storage/v1"):]
        return 200, js, json.dumps({"signedURL": "%s?token=canned" % rest}).encode()
    if path.startswith("/storage/v1/object/"):
        if method == "GET":
            return 200, {"content-type": "application/pdf"}, TINY_PDF
        return 200, js, b"{}"
    if path.startswith("/rest/v1/"):
        return 200, dict(js, **{"content-range": "*/0"}), b"[]"
    return 200, js, b"{}"


def _install_recorders(mp, ledger):  # type: (Any, Ledger) -> None
    from engine.public.bvb_seed import bvb_universe
    from engine.public.universe import universe_tickers

    canned = wire.Canned(list(universe_tickers()) + list(bvb_universe().keys()))

    def _answer(transport, method, url):  # type: (str, str, str) -> Tuple[int, Dict[str, str], bytes]
        event = ledger.outbound_event(transport, url, method)
        host = event["host"]
        if event["caller_named"] and host != SUPABASE_HOST:
            return 200, {"content-type": "application/pdf"}, TINY_PDF
        if host == SUPABASE_HOST:
            return _supabase_answer(method, url)
        if host in MODEL_API_HOSTS:
            return 401, {"content-type": "application/json"}, b'{"type":"error"}'
        return 200, {"content-type": "application/json"}, canned.body_for(url)

    # 1. httpx, at the transport: the client's own redirect / timeout logic
    #    still runs, and the TestClient (its own transport class) is untouched.
    def _handle(self, request):  # type: (Any, httpx.Request) -> httpx.Response
        status, headers, body = _answer("httpx", request.method, str(request.url))
        return httpx.Response(status, headers=headers, content=body)

    async def _handle_async(self, request):  # type: (Any, httpx.Request) -> httpx.Response
        status, headers, body = _answer("httpx-async", request.method, str(request.url))
        return httpx.Response(status, headers=headers, content=body)

    mp.setattr(httpx.HTTPTransport, "handle_request", _handle, raising=True)
    mp.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _handle_async, raising=True)

    # 2. urllib, below urlopen.
    def _open(self, fullurl, data=None, timeout=None):  # type: (Any, Any, Any, Any) -> Any
        url = getattr(fullurl, "full_url", None) or str(fullurl)
        method = (getattr(fullurl, "get_method", None) or (lambda: "GET"))()
        _status, _headers, body = _answer("urllib", method, url)
        return wire._CannedResponse(url, body)

    mp.setattr(urllib.request.OpenerDirector, "open", _open, raising=True)

    # 3. requests, at the adapter (recorded and refused: nothing in this tree
    #    needs an answer from it).
    try:
        import requests
        import requests.adapters

        def _adapter_send(self, request, **kw):  # type: (Any, Any, **Any) -> Any
            ledger.outbound_event("requests", str(request.url), str(request.method))
            raise requests.exceptions.ConnectionError("%s: outbound refused" % GATE)

        mp.setattr(requests.adapters.HTTPAdapter, "send", _adapter_send, raising=True)
    except ImportError:  # pragma: no cover — requests is in the lock today
        pass

    # 4. the model SDKs.
    mp.setitem(sys.modules, "anthropic", _fake_sdk("anthropic", ledger))
    mp.setitem(sys.modules, "openai", _fake_sdk("openai", ledger))

    # 5. the socket tripwire: whatever got past the three transports.
    real_gai, real_connect = socket.getaddrinfo, socket.socket.connect
    real_connect_ex, real_create = socket.socket.connect_ex, socket.create_connection

    def _loopback(host):  # type: (Any) -> bool
        if host is None:
            return True
        if isinstance(host, bytes):
            host = host.decode("ascii", "replace")
        h = str(host).strip("[]").lower()
        return h in ("localhost", "testserver", "::1") or h.startswith("127.")

    def _addr_host(address):  # type: (Any) -> Any
        return address[0] if isinstance(address, (tuple, list)) and address else None

    def _gai(host, port, *a, **kw):  # type: (Any, Any, *Any, **Any) -> Any
        if _loopback(host):
            return real_gai(host, port, *a, **kw)
        ledger.outbound_event("socket", "socket://%s:%s" % (host, port), "DNS")
        raise socket.gaierror(-2, "%s: outbound DNS refused for %s" % (GATE, host))

    def _connect(self, address):  # type: (Any, Any) -> Any
        if isinstance(address, (str, bytes)) or _loopback(_addr_host(address)):
            return real_connect(self, address)
        ledger.outbound_event("socket", "socket://%s:%s" % tuple(address[:2]), "CONNECT")
        raise OSError("%s: outbound connect refused: %r" % (GATE, address))

    def _connect_ex(self, address):  # type: (Any, Any) -> Any
        if isinstance(address, (str, bytes)) or _loopback(_addr_host(address)):
            return real_connect_ex(self, address)
        ledger.outbound_event("socket", "socket://%s:%s" % tuple(address[:2]), "CONNECT")
        raise OSError("%s: outbound connect refused: %r" % (GATE, address))

    def _create(address, *a, **kw):  # type: (Any, *Any, **Any) -> Any
        if _loopback(_addr_host(address)):
            return real_create(address, *a, **kw)
        ledger.outbound_event("socket", "socket://%s:%s" % tuple(address[:2]), "CONNECT")
        raise OSError("%s: outbound connect refused: %r" % (GATE, address))

    mp.setattr(socket, "getaddrinfo", _gai)
    mp.setattr(socket.socket, "connect", _connect)
    mp.setattr(socket.socket, "connect_ex", _connect_ex)
    mp.setattr(socket, "create_connection", _create)

    # 6. threads a request starts (the pipeline's "one daemon thread per
    #    run"), so the sweep can wait for them before it reads the ledger.
    real_start = threading.Thread.start

    def _start(self):  # type: (threading.Thread) -> None
        name = self.name or ""
        target = getattr(getattr(self, "_target", None), "__name__", "")
        # Not the app's: the TestClient's own portal thread (it runs the ASGI
        # app and ends with the request) and executor / event-loop workers.
        if (ledger.current is not None and target != "run_blocking_portal"
                and not name.startswith(("AnyIO", "asyncio", "ThreadPoolExecutor", "anyio"))):
            with ledger.lock:
                ledger.threads.append(self)
        return real_start(self)

    mp.setattr(threading.Thread, "start", _start)


#: The framework's own four routes (FastAPI.setup): the schema and its two
#: viewers. Recognised by path AND by where the endpoint was defined.
FRAMEWORK_PATHS = ("/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc")

#: Every method a route that lists none answers.
ALL_METHODS = ("DELETE", "GET", "PATCH", "POST", "PUT")

#: Routes that are NOT FastAPI ``APIRoute``s — a plain Starlette route
#: (``app.add_route``), a websocket route, a mounted application the sweep
#: cannot enumerate — by path template, each with why it may exist. EMPTY on
#: purpose: on such a route the framework validates nothing, no dependency
#: runs before the handler and the schema does not list it, so it is swept
#: (when it can be) AND reds by name until someone argues for it here.
NOT_API_ROUTES_DECLARED = {}  # type: Dict[str, str]


class Entry(object):
    """One route of the TREE a request can reach: the app's own, or one
    inside a mounted sub-application (``app.mount``), at any depth."""

    __slots__ = ("kind", "route", "template", "owner")

    def __init__(self, kind, route, template, owner):  # type: (str, Any, str, Any) -> None
        self.kind = kind            # api | plain | framework | mount | opaque
        self.route = route
        self.template = template    # the full path template, mount prefixes included
        self.owner = owner          # the application whose router holds the route


def _is_framework_route(route, owner):  # type: (Any, Any) -> bool
    urls = [getattr(owner, attr, None) for attr in (
        "openapi_url", "docs_url", "swagger_ui_oauth2_redirect_url", "redoc_url")]
    return (getattr(route, "path", None) in [u for u in urls if u]
            and getattr(getattr(route, "endpoint", None), "__module__", "") == "fastapi.applications")


def _route_tree(app):  # type: (Any) -> List[Entry]
    """Every route a request to ``app`` can reach, depth first. A ``Mount``
    is walked into with its prefix (a sub-application's routes are as public
    as the app's own — the sweep used to send one bare GET to the mount and
    never look inside); a mount with no route list to read is ``opaque``."""
    out = []  # type: List[Entry]

    def _walk(routes, owner, prefix, depth):  # type: (Any, Any, str, int) -> None
        for route in routes:
            template = prefix + (getattr(route, "path", None) or "")
            if isinstance(route, APIRoute):
                out.append(Entry("api", route, template, owner))
            elif isinstance(route, Mount):
                inner = getattr(route, "_base_app", None) or getattr(route, "app", None)
                sub = list(getattr(route, "routes", None) or [])
                if sub and depth < 8:
                    out.append(Entry("mount", route, template, owner))
                    _walk(sub, inner, template, depth + 1)
                else:
                    out.append(Entry("opaque", route, template, owner))
            elif isinstance(route, Route) and _is_framework_route(route, owner):
                out.append(Entry("framework", route, template, owner))
            elif isinstance(route, Route):
                out.append(Entry("plain", route, template, owner))
            else:
                out.append(Entry("opaque", route, template, owner))

    _walk(app.routes, app, "", 0)
    return out


def _instrument(app, ledger):  # type: (Any, Ledger) -> None
    """Record every endpoint the sweep ENTERS, across the whole route tree.
    ``run_endpoint_function`` calls ``dependant.call`` at request time;
    whether it awaits it was decided when the route was built, so the wrapper
    keeps the endpoint's kind. A plain Starlette route has no dependant: its
    ASGI app is wrapped instead."""

    def _wrap_plain(route, path):  # type: (Any, str) -> None
        inner = route.app

        async def _entered_plain(scope, receive, send):  # type: (Any, Any, Any) -> None
            cur = ledger.current
            ledger.enter(cur["method"] if cur else "?", path)
            await inner(scope, receive, send)

        route.app = _entered_plain

    def _wrap(route, path):  # type: (APIRoute, str) -> None
        dependant = route.dependant
        call = dependant.call
        if dependant.is_coroutine_callable:
            async def _entered(*a, **kw):  # type: (*Any, **Any) -> Any
                cur = ledger.current
                ledger.enter(cur["method"] if cur else "?", path)
                return await call(*a, **kw)
        else:
            def _entered(*a, **kw):  # type: (*Any, **Any) -> Any
                cur = ledger.current
                ledger.enter(cur["method"] if cur else "?", path)
                return call(*a, **kw)
        try:
            dependant.call = _entered
        except Exception:  # noqa: BLE001 — a frozen dataclass
            object.__setattr__(dependant, "call", _entered)

    for entry in _route_tree(app):
        if entry.kind == "api":
            _wrap(entry.route, entry.template)
        elif entry.kind == "plain":
            _wrap_plain(entry.route, entry.template)


# ══════════════════════════════════════════════════════════════════════
# The requests
# ══════════════════════════════════════════════════════════════════════

_URLISH = re.compile(r"url|uri|link|href|callback|webhook|redirect|endpoint", re.I)
_B64ISH = re.compile(r"b64|base64", re.I)
_SINGLED = re.compile(r"url|uri|link|href|callback|webhook|redirect|b64|base64|message|prompt|question", re.I)


def _string_for(name, schema, all_urls=False):  # type: (str, Dict[str, Any], bool) -> str
    fmt = schema.get("format") or ""
    low = name.lower()
    if (all_urls and fmt in ("", "uri", "url") and not schema.get("pattern")
            and int(schema.get("maxLength") or 4096) >= len(URL_SHORT)):
        return URL_SHORT
    if fmt == "uuid":
        value = UUID
    elif fmt == "date":
        value = "2025-12-31"
    elif fmt == "date-time":
        value = "2025-12-31T00:00:00Z"
    elif fmt == "email" or "email" in low:
        value = "probe@example.invalid"
    elif fmt in ("uri", "url") or _URLISH.search(low):
        value = URL_BODY
    elif _B64ISH.search(low):
        value = PDF_B64
    elif low == "id" or low.endswith(("_id", "id")):
        value = UUID
    elif "date" in low or low in ("period_end", "as_of"):
        value = "2025-12-31"
    elif "lang" in low or "locale" in low:
        value = "en"
    elif "currency" in low:
        value = "RON"
    elif "ticker" in low or "symbol" in low:
        value = "AAPL"
    elif "jurisdiction" in low or "country" in low:
        value = "RO"
    elif "hash" in low:
        value = "a" * 64
    elif "filename" in low:
        value = "balanta.pdf"
    else:
        value = "probe"
    pattern = schema.get("pattern")
    if pattern and not re.search(pattern, value):
        # A closed vocabulary written as a pattern ("^(remove|annotate)$"):
        # its own first word, then a few shapes a pattern usually wants.
        words = re.findall(r"[A-Za-z][A-Za-z0-9_\-]*", pattern)
        for candidate in words + [UUID, "a" * 64, "2025-12-31", "2025-12", "AAPL", "probe", "1", "1234567"]:
            if re.search(pattern, candidate):
                value = candidate
                break
    minimum = int(schema.get("minLength") or 0)
    if len(value) < minimum:
        value = (value * (minimum // max(1, len(value)) + 1))[:max(minimum, len(value))]
    maximum = schema.get("maxLength")
    if isinstance(maximum, int) and len(value) > maximum:
        value = value[:maximum]
    return value


def _synth(schema, components, name="", only=None, depth=0, all_urls=False):
    # type: (Any, Dict[str, Any], str, Optional[Set[str]], int, bool) -> Any
    """A value the JSON schema accepts. ``only`` (top level only) limits an
    object to its required properties plus the named ones; ``all_urls`` makes
    every free string a caller-named URL."""
    if not isinstance(schema, dict) or depth > 6:
        return {}
    if "$ref" in schema:
        return _synth(components.get(schema["$ref"].rsplit("/", 1)[-1], {}), components,
                      name, only, depth + 1, all_urls)
    for key in ("anyOf", "oneOf"):
        if key in schema:
            options = [s for s in schema[key] if s.get("type") != "null"] or schema[key]
            return _synth(options[0], components, name, only, depth + 1, all_urls)
    if "allOf" in schema:
        return _synth(schema["allOf"][0], components, name, only, depth + 1, all_urls)
    if "const" in schema:
        return schema["const"]
    if schema.get("enum"):
        return schema["enum"][0]
    kind = schema.get("type")
    if kind == "object" or "properties" in schema:
        props = schema.get("properties") or {}
        required = set(schema.get("required") or [])
        out = {}
        for prop, sub in props.items():
            if only is not None and prop not in required and prop not in only:
                continue
            out[prop] = _synth(sub, components, prop, None, depth + 1, all_urls)
        return out
    if kind == "array":
        return [_synth(schema.get("items") or {}, components, name, None, depth + 1, all_urls)
                for _ in range(max(1, int(schema.get("minItems") or 0)))]
    if kind == "string":
        return _string_for(name, schema, all_urls)
    if kind == "integer":
        return int(max(schema.get("minimum", 1), schema.get("exclusiveMinimum", 0) + 1, 1))
    if kind == "number":
        return float(max(schema.get("minimum", 1), schema.get("exclusiveMinimum", 0) + 1, 1))
    if kind == "boolean":
        return True
    if kind == "null":
        return None
    return {}


def _top_schema(schema, components):  # type: (Any, Dict[str, Any]) -> Dict[str, Any]
    seen = 0
    while isinstance(schema, dict) and "$ref" in schema and seen < 6:
        schema = components.get(schema["$ref"].rsplit("/", 1)[-1], {})
        seen += 1
    return schema if isinstance(schema, dict) else {}


def _schema_bodies(operation, components):  # type: (Dict[str, Any], Dict[str, Any]) -> List[Any]
    """Every JSON body the route's OWN schema accepts that is worth sending:
    all properties; the required ones alone; all properties with EVERY free
    string a caller-named URL; and each URL / inline-document / message
    property alone beside the required ones (a handler that prefers one of
    two sources reads the other only when it stands alone)."""
    content = ((operation.get("requestBody") or {}).get("content") or {})
    schema = (content.get("application/json") or {}).get("schema")
    if not schema:
        return []
    top = _top_schema(schema, components)
    bodies = [_synth(schema, components), _synth(schema, components, only=set()),
              _synth(schema, components, all_urls=True)]
    required = set(top.get("required") or [])
    for prop in (top.get("properties") or {}):
        if prop not in required and _SINGLED.search(prop):
            bodies.append(_synth(schema, components, only={prop}))
            if _URLISH.search(prop):
                own = _synth(schema, components, only={prop})
                if isinstance(own, dict):
                    own[prop] = URL_OWN_STORAGE
                    bodies.append(own)
    out, seen = [], set()
    for body in bodies:
        key = json.dumps(body, sort_keys=True, default=str)
        if key not in seen:
            seen.add(key)
            out.append(body)
    return out


def _multipart(operation, components):  # type: (Dict[str, Any], Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, str]]
    """A multipart file for the route: its own file and form fields when it
    declares them, a generic ``file`` otherwise."""
    content = ((operation.get("requestBody") or {}).get("content") or {})
    files = {}  # type: Dict[str, Any]
    data = {}  # type: Dict[str, str]
    for media in ("multipart/form-data", "application/x-www-form-urlencoded"):
        top = _top_schema((content.get(media) or {}).get("schema"), components)
        for prop, sub in (top.get("properties") or {}).items():
            sub = _top_schema(sub, components)
            flat = sub
            for key in ("anyOf", "oneOf"):
                if key in sub:
                    flat = ([s for s in sub[key] if s.get("type") != "null"] or sub[key])[0]
            if flat.get("format") == "binary" or flat.get("contentMediaType"):
                files[prop] = ("balanta.pdf", TINY_PDF, "application/pdf")
            else:
                value = _synth(flat, components, prop)
                data[prop] = value if isinstance(value, str) else json.dumps(value)
    if not files:
        files["file"] = ("balanta.pdf", TINY_PDF, "application/pdf")
    return files, data


def _annotation_value(field, name):  # type: (Any, str) -> str
    annotation = getattr(getattr(field, "field_info", None), "annotation", None)
    text = getattr(annotation, "__name__", str(annotation))
    if name in PATH_VALUES:
        return PATH_VALUES[name]
    if "int" in text:
        return "1"
    if "date" in text.lower():
        return "2025-12-31"
    if "bool" in text:
        return "true"
    if "float" in text:
        return "1.0"
    return UUID


def _concrete_path(route, template=None):  # type: (Any, Optional[str]) -> str
    """The route's path with its parameters filled. ``template`` is the full
    template when the route sits under a mount (the prefix may carry
    parameters of its own)."""
    fields = dict((getattr(f, "alias", None) or f.name, f)
                  for f in getattr(getattr(route, "dependant", None), "path_params", []) or [])

    def _fill(match):  # type: (Any) -> str
        name = match.group(1).split(":", 1)[0]
        if name in fields:
            return _annotation_value(fields[name], name)
        return PATH_VALUES.get(name, UUID)

    return re.sub(r"\{([^}]+)\}", _fill, template if template is not None else route.path)


def _is_required(field):  # type: (Any) -> bool
    info = getattr(field, "field_info", None)
    probe = getattr(info, "is_required", None)
    if callable(probe):
        return bool(probe())
    return bool(getattr(field, "required", False))


def _required_query(route):  # type: (Any) -> Dict[str, str]
    out = {}
    for field in getattr(getattr(route, "dependant", None), "query_params", []) or []:
        if _is_required(field):
            name = getattr(field, "alias", None) or field.name
            out[name] = QUERY_EXTRAS.get(name) or _annotation_value(field, name)
    return out


#: Headers that carry — or would carry — who the caller is. The sweep's three
#: identities own them; a declared-parameter variant never fills them. The
#: second set is what every request already sends (``SPOOF_HEADERS``).
_IDENTITY_HEADERS = frozenset({"authorization", "apikey", "cookie", "proxy-authorization"})

#: The words an opt-in switch is usually compared with.
SWITCH_WORDS = ("1", "true")


def _flat_dependant(route):  # type: (Any) -> Any
    """The route's parameters WITH those of every dependency under it."""
    dependant = getattr(route, "dependant", None)
    if dependant is None:
        return None
    from fastapi.dependencies.utils import get_flat_dependant

    return get_flat_dependant(dependant, skip_repeats=True)


def _param_value(field, name, schema, components, word):
    # type: (Any, str, Optional[Dict[str, Any]], Dict[str, Any], Optional[str]) -> str
    if schema:
        flat = _top_schema(schema, components)
        for key in ("anyOf", "oneOf"):
            if key in flat:
                options = [o for o in flat[key] if o.get("type") != "null"] or flat[key]
                flat = _top_schema(options[0], components)
        kind = flat.get("type")
        free = kind == "string" and not (
            flat.get("enum") or flat.get("pattern") or flat.get("format") or "const" in flat)
        if word is not None and (kind == "boolean" or free):
            return word
        if word is None and free and name in QUERY_EXTRAS:
            return QUERY_EXTRAS[name]
        value = _synth(flat, components, name)
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, list):
            value = value[0] if value else ""
        return value if isinstance(value, str) else json.dumps(value)
    # A route the schema does not list (include_in_schema=False): by annotation.
    annotation = str(getattr(getattr(field, "field_info", None), "annotation", ""))
    if word is not None and ("bool" in annotation or "str" in annotation):
        return word
    return QUERY_EXTRAS.get(name) or _annotation_value(field, name)


def _declared(route, operation, components, word=None):
    # type: (Any, Dict[str, Any], Dict[str, Any], Optional[str]) -> Tuple[Dict[str, str], Dict[str, str]]
    """(query, headers) filling EVERY query, header and cookie parameter the
    route — or a dependency of it — DECLARES, required or not, so a switch a
    handler reads from an OPTIONAL parameter (``?ai=true``, ``X-Use-Ai: 1``)
    is on. ``word`` None: each by its own schema / type and name. A ``word``
    ("1", "true"): written into every boolean and every unconstrained
    string, the rest by schema. Identity headers are never filled."""
    schemas = {}  # type: Dict[Tuple[str, str], Dict[str, Any]]
    for param in operation.get("parameters") or []:
        schemas[(str(param.get("in")), str(param.get("name")).lower())] = param.get("schema") or {}
    query, headers, cookies = {}, {}, []  # type: Dict[str, str], Dict[str, str], List[str]
    flat = _flat_dependant(route)
    if flat is None:
        return query, headers
    spoofed = set(k.lower() for k in SPOOF_HEADERS)
    for where, fields in (("query", flat.query_params), ("header", flat.header_params),
                          ("cookie", flat.cookie_params)):
        for field in fields or []:
            name = getattr(field, "alias", None) or field.name
            if where == "header" and (name.lower() in _IDENTITY_HEADERS or name.lower() in spoofed):
                continue
            value = _param_value(field, name, schemas.get((where, name.lower())), components, word)
            if where == "query":
                query[name] = value
            elif where == "header":
                headers[name] = value
            else:
                cookies.append("%s=%s" % (name, value))
    if cookies:
        headers["Cookie"] = "; ".join(cookies)
    return query, headers


#: The least each added variant must have been sent, per state (measured
#: 2026-10-04 — see the GATE-WORK ``variants`` line).
VARIANT_FLOORS = {
    # measured: raw 207 each, declared 204 / 75 / 66
    "closed": {"raw-pdf": 180, "raw-octet-stream": 180, "declared": 180, "declared-1": 60, "declared-true": 50},
    # measured: raw 288 each, declared 303 / 123 / 114
    "open": {"raw-pdf": 250, "raw-octet-stream": 250, "declared": 270, "declared-1": 100, "declared-true": 90},
}  # type: Dict[str, Dict[str, int]]

#: The raw request bodies sent to every body-carrying method: PDF bytes
#: under the two media types an upload door reads them as.
RAW_BODIES = (("raw-pdf", "application/pdf"), ("raw-octet-stream", "application/octet-stream"))

IDENTITIES = ("anonymous", "forged", "anon-key")


def _identity_headers(identity):  # type: (str) -> Dict[str, str]
    headers = dict(SPOOF_HEADERS)
    if identity == "forged":
        headers["Authorization"] = "Bearer %s" % D.forged_jwt(UUID, "stranger@example.invalid")
    elif identity == "anon-key":
        headers["Authorization"] = "Bearer %s" % ANON_KEY
        headers["apikey"] = ANON_KEY
    return headers


def _variants(route, method, openapi):  # type: (Any, str, Dict[str, Any]) -> Iterator[Tuple[str, Dict[str, Any]]]
    components = ((openapi.get("components") or {}).get("schemas") or {})
    # ``path_format`` is the template without converters ("{firm_id:uuid}" ->
    # "{firm_id}"), which is how the schema keys it.
    schema_path = getattr(route, "path_format", None) or route.path
    operation = ((openapi.get("paths") or {}).get(schema_path) or {}).get(method.lower()) or {}
    required = _required_query(route)
    query = dict(QUERY_EXTRAS)
    query.update(required)
    # Every parameter the route DECLARES, three ways: by its own schema, and
    # with each switch word in every boolean / free string.
    declared = []  # type: List[Tuple[str, Dict[str, str], Dict[str, str]]]
    for label, word in (("declared", None),) + tuple(("declared-%s" % w, w) for w in SWITCH_WORDS):
        declared_query, declared_headers = _declared(route, operation, components, word)
        params = dict(query)
        params.update(declared_query)
        declared.append((label, params, declared_headers))
    if method in ("GET", "HEAD", "OPTIONS", "DELETE"):
        yield "query", {"params": query}
        yield "bare", {"params": required}
        for label, params, headers in declared:
            yield label, {"params": params, "headers": headers}
        if method == "DELETE":
            yield "json-rich", {"params": required, "json": RICH_BODY}
        return
    yield "json-empty", {"params": required, "json": {}}
    yield "json-rich", {"params": query, "json": RICH_BODY}
    yield "json-urls", {"params": required, "json": URL_BODY_JSON}
    yield "json-own-storage", {"params": required, "json": OWN_STORAGE_BODY}
    schema_bodies = _schema_bodies(operation, components)
    for i, body in enumerate(schema_bodies):
        yield "schema-%d" % i, {"params": required, "json": body}
    files, data = _multipart(operation, components)
    yield "multipart", {"params": required, "files": files, "data": data}
    # … beside the fullest body the route's own schema accepts.
    fullest = schema_bodies[0] if schema_bodies else RICH_BODY
    for label, params, headers in declared:
        yield label, {"params": params, "headers": headers, "json": fullest}
    # A RAW document as the request body — what a handler that reads
    # ``await request.body()`` receives; no JSON, no multipart envelope.
    for label, media in RAW_BODIES:
        headers = dict(declared[0][2])
        headers["Content-Type"] = media
        yield label, {"params": declared[0][1], "headers": headers, "content": TINY_PDF}


def _cold():  # type: () -> None
    """Every cache, ledger and limiter the public surface owns, dropped — so
    each request is the COLD read (the one that spends), no request is
    answered 429 before its handler, and one request's extraction is not
    hidden by the previous one's memo."""
    wire.cold()
    from engine.public.intelligence import filings_extractor as fx

    reset = getattr(fx, "_reset_extraction_memo", None)
    if reset is not None:
        reset()


class Sweep(object):
    def __init__(self, state):  # type: (str) -> None
        self.state = state
        self.ledger = Ledger()
        self.routes = []  # type: List[Tuple[str, str]]          # APIRoutes, mounts walked into
        self.other_routes = []  # type: List[str]               # the framework's own
        self.plain_routes = []  # type: List[Tuple[str, str]]    # swept, but not APIRoutes
        self.opaque = []  # type: List[str]                     # could not be enumerated / swept
        self.mounts = []  # type: List[str]
        self.handlers = {}  # type: Dict[Tuple[str, str], Any]   # key -> the route's endpoint
        self.requests = 0
        self.answers = {}  # type: Dict[Tuple[str, str], List[Tuple[str, str, int, str]]]
        self.seconds = 0.0
        self.stray_threads = 0

    # ── what the law reads ───────────────────────────────────────────
    def model_routes(self):  # type: () -> Dict[Any, List[Dict[str, Any]]]
        out = {}  # type: Dict[Any, List[Dict[str, Any]]]
        for event in self.ledger.model:
            out.setdefault(event["route"], []).append(event)
        return out

    def caller_named(self):  # type: () -> List[Dict[str, Any]]
        return [e for e in self.ledger.outbound if e["caller_named"]]

    def unproven(self):  # type: () -> Dict[Tuple[str, str], str]
        """Routes the sweep never entered and that neither a wall nor an auth
        dependency refused — where a green would be no evidence."""
        out = {}
        for key in self.routes:
            if key in self.ledger.reached:
                continue
            answers = self.answers.get(key) or []
            statuses = sorted(set(a[2] for a in answers))
            if answers and all(a[3] == "wall" for a in answers):
                continue
            if answers and all(a[2] in (401, 403, 503) or a[3] == "wall" for a in answers):
                continue
            out[key] = "never entered; answers %s" % statuses
        return out

    def walled(self):  # type: () -> List[Tuple[str, str]]
        return sorted(k for k in self.routes if k not in self.ledger.reached
                      and (self.answers.get(k) or []) and all(a[3] == "wall" for a in self.answers[k]))


def _apply_env(mp, state, tmp):  # type: (Any, str, Path) -> None
    for key in _ENV_OFF:
        mp.delenv(key, raising=False)
    env = dict(_BASE_ENV)
    env.update(STATES.get(state) or {})
    env.update({
        "PUBLIC_RO_DB_PATH": str(tmp / "public_ro.db"),
        "PUBLIC_MARKET_DB_PATH": str(tmp / "public_market.db"),
        "AI_BREAKER_STATE_DIR": str(tmp / "breaker"),
        "INTERP_CACHE_DIR": str(tmp / "interp_cache"),
        "ENGINE_TEMPLATES_DIR": str(tmp / "templates"),
        "ENGINE_OBS_DIR": str(tmp / "obs"),
        "GDELT_CACHE_PATH": str(tmp / "gdelt_cache.json"),
    })
    for key, value in env.items():
        mp.setenv(key, value)
    assert "test." in os.environ["VITE_SUPABASE_URL"], "refusing a non-manifest Supabase URL"


def _build(mp, state, tmp, ledger):  # type: (Any, str, Path, Ledger) -> Any
    _apply_env(mp, state, tmp)
    D.install_test_jwks(mp)
    _install_recorders(mp, ledger)
    from engine.api.server import create_app

    app = create_app(config_path=REPO / "config.yaml")
    assert ledger.model == [], "create_app() itself reached a model client: %s" % ledger.model
    _instrument(app, ledger)
    return app


def _send(client, sweep, key, label, method, url, kwargs):
    # type: (Any, Sweep, Any, str, str, str, Dict[str, Any]) -> Any
    ledger = sweep.ledger
    ledger.current = {"route": key, "label": label, "method": method}
    status, kind = -1, "raised"
    try:
        resp = client.request(method, url, **kwargs)
        status = resp.status_code
        kind = "answer"
        if status == 404 and "surface_not_enabled" in resp.text[:400]:
            kind = "wall"
        return resp
    except Exception as exc:  # noqa: BLE001 — a handler that raises is an answer too
        kind = "raised:%s" % type(exc).__name__
        return None
    finally:
        ledger.last_label = label
        ledger.current = None
        sweep.requests += 1
        if key is not None:
            sweep.answers.setdefault(key, []).append((label, method, status, kind))


def run_sweep(state, tmp):  # type: (str, Path) -> Sweep
    sweep = Sweep(state)
    started = time.time()
    with pytest.MonkeyPatch.context() as mp:
        app = _build(mp, state, tmp, sweep.ledger)
        openapi = app.openapi()
        client = TestClient(app, raise_server_exceptions=False, follow_redirects=False)
        schemas = {id(app): openapi}  # type: Dict[int, Dict[str, Any]]

        def _schema_of(owner):  # type: (Any) -> Dict[str, Any]
            if id(owner) not in schemas:
                maker = getattr(owner, "openapi", None)
                try:
                    schemas[id(owner)] = maker() if callable(maker) else {}
                except Exception:  # noqa: BLE001 — a mounted app with no readable schema
                    schemas[id(owner)] = {}
            return schemas[id(owner)]

        for entry in _route_tree(app):
            route, template = entry.route, entry.template
            if entry.kind == "mount":
                sweep.mounts.append(template)
                continue
            if entry.kind == "framework":
                # /openapi.json, /docs, /docs/oauth2-redirect, /redoc: swept,
                # with no endpoint of ours to enter.
                sweep.other_routes.append(template)
                _send(client, sweep, None, "GET %s" % template, "GET", template, {})
                continue
            if entry.kind == "opaque":
                # A websocket route, a host route, a mounted application with
                # no route list: nothing the sweep can send proves anything.
                sweep.opaque.append("%s %s" % (type(route).__name__, template or "/"))
                continue
            listed = sweep.routes if entry.kind == "api" else sweep.plain_routes
            schema = _schema_of(entry.owner) if entry.kind == "api" else {}
            url = _concrete_path(route, template)
            for method in sorted(getattr(route, "methods", None) or ALL_METHODS):
                key = (method, template)
                listed.append(key)
                sweep.handlers[key] = getattr(route, "endpoint", None)
                sent = set()  # type: Set[str]
                for identity in IDENTITIES:
                    for variant, kwargs in _variants(route, method, schema):
                        # Two variants that came out the same request are sent once.
                        shape = identity + json.dumps(
                            dict((k, v) for k, v in kwargs.items() if v or k != "headers"),
                            sort_keys=True, default=repr)
                        if shape in sent:
                            continue
                        sent.add(shape)
                        _cold()
                        kw = dict(kwargs)
                        headers = _identity_headers(identity)
                        headers.update(kw.get("headers") or {})
                        kw["headers"] = headers
                        label = "%s %s [%s, %s]" % (method, template, identity, variant)
                        _send(client, sweep, key, label, method, url, kw)
        # Threads a request started: give them a bounded time to finish, so
        # what they do is in the ledger before anyone reads it.
        deadline = time.time() + 5.0
        for thread in list(sweep.ledger.threads):
            thread.join(max(0.0, deadline - time.time()))
        sweep.stray_threads = sum(1 for t in sweep.ledger.threads if t.is_alive())
        _cold()
    from engine.api import _jwt

    _jwt.reset_cache()
    sweep.seconds = time.time() - started
    return sweep


_SWEEPS = {}  # type: Dict[str, Sweep]


@pytest.fixture(scope="module")
def sweeps(tmp_path_factory):
    """Both flag states, swept once per run of this file."""
    for state in sorted(STATES):
        if state not in _SWEEPS:
            _SWEEPS[state] = run_sweep(state, tmp_path_factory.mktemp("sweep-%s" % state))
    return _SWEEPS


@pytest.fixture()
def harness(monkeypatch, tmp_path):
    """The recorders alone (no app): for the handler's own laws."""
    ledger = Ledger()
    _apply_env(monkeypatch, "closed", tmp_path)
    _install_recorders(monkeypatch, ledger)
    return ledger


def _describe(events, limit=12):  # type: (List[Dict[str, Any]], int) -> str
    lines = ["%s — %s %s %s" % (e.get("label"), e.get("sdk") or e.get("transport"),
                                e.get("what") or e.get("method"), e.get("detail") or e.get("url"))
             for e in events[:limit]]
    if len(events) > limit:
        lines.append("… and %d more" % (len(events) - limit))
    return "\n    ".join(lines)


# ══════════════════════════════════════════════════════════════════════
# THE LAW — the sweep
# ══════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("state", sorted(STATES))
def test_no_anonymous_request_constructs_or_calls_a_model_client(sweeps, state):
    """ZERO model clients constructed, ZERO model calls, for a caller with no
    verified identity — except on the DECLARED routes, exactly."""
    sweep = sweeps[state]
    by_route = sweep.model_routes()
    declared = DECLARED_IN[state]
    undeclared = dict((k, v) for k, v in by_route.items() if k not in declared)
    assert not undeclared, (
        "NO-ANONYMOUS-MODEL-CALL VIOLATED [%s] — %d route(s) construct or call a model client "
        "for a caller with NO verified identity (a planted key was in the environment; in "
        "production this is a paid call per request):\n  %s"
        % (state, len(undeclared), "\n  ".join(
            "%s:\n    %s" % (" ".join(k) if k else "(no request in flight)", _describe(v))
            for k, v in sorted(undeclared.items(), key=lambda kv: str(kv[0])))))
    silent = sorted(k for k in declared if not any(e["what"] == "call" for e in by_route.get(k, [])))
    assert not silent, (
        "NO-ANONYMOUS-MODEL-CALL CENSUS STALE [%s] — declared as reaching a model, but the sweep "
        "saw no model call there (remove the entry deliberately, or the sweep no longer reaches "
        "the handler's paid path): %s" % (state, silent))
    assert sweep.stray_threads == 0, (
        "%d thread(s) started by an anonymous request were still running when the ledger was "
        "read — what they do next is not in it" % sweep.stray_threads)


@pytest.mark.parametrize("state", sorted(STATES))
def test_no_anonymous_request_makes_the_backend_fetch_a_host_the_caller_named(sweeps, state):
    """ZERO outbound requests to a host — or a URL — the caller supplied, on
    any route. There is no census for this one."""
    sweep = sweeps[state]
    named = sweep.caller_named()
    assert not named, (
        "NO-ANONYMOUS-MODEL-CALL VIOLATED [%s] — the backend made %d outbound request(s) to a "
        "host or URL the CALLER supplied (server-side request forgery: the Docker network and "
        "the metadata address are reachable from there):\n    %s"
        % (state, len(named), _describe(named)))


@pytest.mark.parametrize("state", sorted(STATES))
def test_the_backend_contacts_only_declared_hosts_for_an_anonymous_caller(sweeps, state):
    """A MODEL IS A MODEL AT ANY HOST. The SDK recorders and the two model
    API hosts are how this tree reaches one today; a completion bought over
    plain HTTP at another address would be neither. So every host the backend
    contacts while serving the sweep — over httpx, urllib, requests or a bare
    socket — is in ``OUTBOUND_HOSTS`` for the state, or the law is red."""
    sweep = sweeps[state]
    declared = OUTBOUND_HOSTS[state]
    assert SUPABASE_HOST in declared and not (set(declared) & MODEL_API_HOSTS), sorted(declared)
    contacted = {}  # type: Dict[str, List[Dict[str, Any]]]
    for event in sweep.ledger.outbound:
        if not event["caller_named"]:               # those are the law above
            contacted.setdefault(event["host"], []).append(event)
    undeclared = dict((h, v) for h, v in contacted.items() if h not in declared)
    assert not undeclared, (
        "NO-ANONYMOUS-MODEL-CALL VIOLATED [%s] — for a caller with NO verified identity the "
        "backend contacted %d host(s) that are not in OUTBOUND_HOSTS (a model provider reached "
        "over plain HTTP looks exactly like this — declare the host with what is asked of it, "
        "or remove the call):\n  %s"
        % (state, len(undeclared), "\n  ".join(
            "%s:\n    %s" % (h, _describe(v, 6)) for h, v in sorted(undeclared.items()))))
    # Not vacuous: the recorders saw the hosts the sweep is known to reach.
    assert SUPABASE_HOST in contacted, (
        "the sweep reached the project's own Supabase host zero times [%s] — the outbound "
        "recorder is not recording" % state)
    if state == "open":
        assert "www.sec.gov" in contacted and "data.sec.gov" in contacted, sorted(contacted)
    print("GATE-WORK %s state=%s outbound_hosts=%d declared_hosts=%d (%s)"
          % (GATE, state, len(contacted), len(declared), ", ".join(sorted(contacted))))


@pytest.mark.parametrize("state", sorted(STATES))
def test_every_route_a_request_can_reach_is_an_api_route_the_sweep_swept(sweeps, state):
    """THE TREE, not the top level. A sub-application mounted with
    ``app.mount`` is walked into and its routes swept under their prefix; a
    route that is not a FastAPI ``APIRoute`` (``app.add_route``, a websocket
    route) or a mount with no route list reds by name — the framework
    validated nothing there and no dependency ran before the handler."""
    sweep = sweeps[state]
    plain = sorted(set("%s %s" % k for k in sweep.plain_routes if k[1] not in NOT_API_ROUTES_DECLARED))
    assert not plain, (
        "NO-ANONYMOUS-MODEL-CALL UNPROVEN [%s] — %d route(s) are not FastAPI APIRoutes "
        "(app.add_route / a plain Starlette route): no schema, no dependency, no validation "
        "before the handler. Register them as APIRoutes, or declare each in "
        "NOT_API_ROUTES_DECLARED with why it may exist:\n  %s" % (state, len(plain), "\n  ".join(plain)))
    opaque = sorted(o for o in sweep.opaque if o.split(" ", 1)[-1] not in NOT_API_ROUTES_DECLARED)
    assert not opaque, (
        "NO-ANONYMOUS-MODEL-CALL UNPROVEN [%s] — %d route(s) the sweep cannot enumerate or "
        "send to (a websocket route, a host route, a mounted application with no route "
        "list). A green says nothing about them:\n  %s" % (state, len(opaque), "\n  ".join(opaque)))
    # The framework's own: the root's four exactly, and four more per mounted
    # FastAPI application — nothing else is waved through as "the framework's".
    roots = sorted(p for p in sweep.other_routes if p in FRAMEWORK_PATHS)
    assert roots == sorted(FRAMEWORK_PATHS), (
        "the app's own framework routes are not the four expected: %s" % sweep.other_routes)
    assert all(p.endswith(FRAMEWORK_PATHS) for p in sweep.other_routes), sweep.other_routes
    assert len(sweep.other_routes) <= 4 * (1 + len(sweep.mounts)), (sweep.other_routes, sweep.mounts)


@pytest.mark.parametrize("state", sorted(STATES))
def test_the_sweep_enters_every_handler_or_meets_a_wall(sweeps, state):
    """A 404 or a 422 answered before the handler ran is not evidence. Every
    route's endpoint is ENTERED by at least one request, or every answer was
    the surface wall's 404 or an auth dependency's 401 / 403 / 503."""
    sweep = sweeps[state]
    unproven = sweep.unproven()
    undeclared = dict((k, v) for k, v in unproven.items() if k not in UNPROVEN_DECLARED)
    assert not undeclared, (
        "NO-ANONYMOUS-MODEL-CALL UNPROVEN [%s] — the sweep never entered %d handler(s), and "
        "nothing that refused it was a wall or an auth dependency. A green over these says "
        "nothing about them — give the sweep a body the route accepts:\n  %s"
        % (state, len(undeclared), "\n  ".join(
            "%s %s — %s" % (k[0], k[1], v) for k, v in sorted(undeclared.items()))))
    stale = sorted(k for k in UNPROVEN_DECLARED if k in sweep.routes and k not in unproven)
    assert not stale, "UNPROVEN_DECLARED names routes the sweep now enters: %s" % stale


def test_the_sweep_covered_the_whole_route_table_in_both_states(sweeps):
    """The work, counted — and the floors that make an empty sweep a red."""
    closed, opened = sweeps["closed"], sweeps["open"]
    for sweep in (closed, opened):
        entered = len(sweep.ledger.reached & set(sweep.routes))
        print("GATE-WORK %s state=%s routes=%d framework_routes=%d mounts=%d not_api_routes=%d "
              "requests=%d entered=%d walled=%d auth_refused=%d outbound=%d model_events=%d "
              "seconds=%.1f"
              % (GATE, sweep.state, len(sweep.routes), len(sweep.other_routes), len(sweep.mounts),
                 len(sweep.plain_routes) + len(sweep.opaque), sweep.requests,
                 entered, len(sweep.walled()),
                 len(sweep.routes) - entered - len(sweep.walled()) - len(sweep.unproven()),
                 len(sweep.ledger.outbound), len(sweep.ledger.model), sweep.seconds))
    print("GATE-WORK %s routes=%d requests=%d"
          % (GATE, len(closed.routes) + len(opened.routes), closed.requests + opened.requests))
    assert len(closed.routes) >= 150, "VACUOUS — only %d routes swept (closed)" % len(closed.routes)
    assert len(opened.routes) > len(closed.routes), (
        "the open state mounts no more routes than the closed one (%d vs %d): the flags did "
        "not take" % (len(opened.routes), len(closed.routes)))
    # Measured 2026-10-04: closed 159 routes / 2,611 requests / 155 entered;
    # open 229 routes / 3,745 requests / 225 entered. Collapse detectors.
    assert closed.requests >= 2400 and opened.requests >= 3400, (closed.requests, opened.requests)
    # The variants the review of 2026-10-04 asked for were SENT, not merely
    # written: a raw PDF body to every body-carrying route under both media
    # types, and the declared parameters filled each way wherever a route
    # declares one the plain variants do not already send.
    for sweep, floors in ((closed, VARIANT_FLOORS["closed"]), (opened, VARIANT_FLOORS["open"])):
        sent = {}  # type: Dict[str, int]
        for answers in sweep.answers.values():
            for label, _method, _status, _kind in answers:
                variant = label.rsplit(", ", 1)[-1].rstrip("]")
                sent[variant] = sent.get(variant, 0) + 1
        print("GATE-WORK %s state=%s variants %s" % (GATE, sweep.state, " ".join(
            "%s=%d" % (k, v) for k, v in sorted(sent.items()) if not k.startswith("schema-"))))
        for variant, floor in sorted(floors.items()):
            assert sent.get(variant, 0) >= floor, (
                "VACUOUS — only %d %r request(s) were sent in the %s state (floor %d): %s"
                % (sent.get(variant, 0), variant, sweep.state, floor, sent))
    for sweep, floor in ((closed, 145), (opened, 210)):
        entered = len(sweep.ledger.reached & set(sweep.routes))
        assert entered >= floor, "VACUOUS — the sweep entered only %d handlers (%s)" % (entered, sweep.state)
        assert len(sweep.other_routes) >= 1, "the framework's own routes were not swept"
    mutating = [k for k in opened.routes if k[0] in ("POST", "PUT", "PATCH")]
    assert len(mutating) >= 80, "only %d mutating routes discovered" % len(mutating)
    # The public surface is a wall when closed, and mounted when open.
    assert not any(p.startswith("/api/public/intelligence") for _m, p in closed.routes)
    assert all(k in opened.routes for k in DECLARED), [k for k in DECLARED if k not in opened.routes]
    # The legacy SKU AI routes are mounted and walled in both states.
    for sweep in (closed, opened):
        assert ("POST", "/api/analyze") in sweep.walled(), sweep.answers.get(("POST", "/api/analyze"))
        assert ("POST", "/api/upload-excel") in sweep.walled()


def test_every_declared_request_costs_at_most_its_stated_completions(sweeps):
    """One anonymous request to a declared route is one bounded bill, never a
    loop: the narrative plus the filings extraction it shares."""
    sweep = sweeps["open"]
    per_request = {}  # type: Dict[str, int]
    for event in sweep.ledger.model:
        if event["what"] == "call":
            per_request[event["label"]] = per_request.get(event["label"], 0) + 1
    assert per_request, "the open sweep recorded no model call at all — the census is not exercised"
    over = dict((k, v) for k, v in per_request.items() if v > MAX_COMPLETIONS_PER_DECLARED_REQUEST)
    assert not over, "one request cost more than %d completions: %s" % (
        MAX_COMPLETIONS_PER_DECLARED_REQUEST, over)


# ══════════════════════════════════════════════════════════════════════
# The bounds the census states, measured
# ══════════════════════════════════════════════════════════════════════

_DECLARED_URLS = (
    "/api/public/intelligence/companies/%s/ai-market-read",
    "/api/public/intelligence/companies/%s/exposure",
    "/api/public/intelligence/companies/%s/risk-score",
    "/api/public/intelligence/supply-chain?ticker=%s",
)


def test_the_declared_public_reads_stop_at_their_daily_ceiling(tmp_path):
    """THE BOUND. With PUBLIC_LLM_COMPLETIONS_PER_DAY = 3, twenty COLD
    anonymous reads over five tickers and all four declared routes — caches
    and the per-client limiter reset before each, the day's ledger KEPT — send
    exactly three completions, and every later read sends none."""
    from engine.public import egress_ledger, refresh_shield
    from engine.public_ro import ratelimit as ro_ratelimit

    ledger = Ledger()
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("PUBLIC_LLM_COMPLETIONS_PER_DAY", "3")
        app = _build(mp, "open", tmp_path, ledger)
        mp.setenv("PUBLIC_LLM_COMPLETIONS_PER_DAY", "3")   # _apply_env cleared it
        _cold()                                           # re-reads the ceiling
        assert egress_ledger.completions_remaining() == 3
        client = TestClient(app, raise_server_exceptions=False)
        sent = []
        for ticker in ("AAPL", "MSFT", "NVDA", "GOOGL", "AMZN"):
            for template in _DECLARED_URLS:
                wire.cold(keep_budget=True)
                refresh_shield.reset_limiter()
                ro_ratelimit.reset_limiter()
                before = sum(1 for e in ledger.model if e["what"] == "call")
                ledger.current = {"route": None, "label": template % ticker, "method": "GET"}
                resp = client.get(template % ticker)
                ledger.current = None
                assert resp.status_code == 200, (template % ticker, resp.status_code, resp.text[:200])
                sent.append(sum(1 for e in ledger.model if e["what"] == "call") - before)
        remaining = egress_ledger.completions_remaining()
        _cold()
    calls = sum(sent)
    assert calls == 3, (
        "the public reads sent %d completions against a daily ceiling of 3 (per request: %s) — "
        "the bound the census states does not hold" % (calls, sent))
    assert remaining == 0
    assert sum(sent[-8:]) == 0, "reads after the ceiling still sent completions: %s" % sent


def test_the_legacy_sku_routes_reach_a_model_the_moment_their_wall_is_lifted(tmp_path):
    """WHAT THE WALL HOLDS BACK — and the proof the sweep's bodies REACH that
    model call. With LEGACY_SKU_AI_ENABLED set, an anonymous POST /api/analyze
    with the sweep's own rich body constructs a model client and calls it. So
    the zero the sweep reports for these two routes is the wall, not a body
    that never got there."""
    ledger = Ledger()
    with pytest.MonkeyPatch.context() as mp:
        _apply_env(mp, "closed", tmp_path)
        mp.setenv("LEGACY_SKU_AI_ENABLED", "1")
        D.install_test_jwks(mp)
        _install_recorders(mp, ledger)
        from engine.api.server import create_app

        app = create_app(config_path=REPO / "config.yaml")
        _instrument(app, ledger)
        client = TestClient(app, raise_server_exceptions=False)
        ledger.current = {"route": ("POST", "/api/analyze"), "label": "POST /api/analyze", "method": "POST"}
        resp = client.post("/api/analyze", json=RICH_BODY)
        ledger.current = None
    assert ("POST", "/api/analyze") in ledger.reached, (resp.status_code, resp.text[:300])
    kinds = [e["what"] for e in ledger.model]
    assert "construct" in kinds and "call" in kinds, (
        "with the wall lifted the rich body did not reach /api/analyze's model call (%s, HTTP %s) "
        "— the sweep's zero for that route would then prove nothing" % (ledger.model, resp.status_code))


# ══════════════════════════════════════════════════════════════════════
# The PDF model lane is mounted on no app
# ══════════════════════════════════════════════════════════════════════


#: The module that IS the PDF model lane, and the only module that may refer
#: to it — with the names it may take from it. Exact: a second importer reds,
#: and so does this entry going stale.
PDF_LANE = "financial_statements"
PDF_LANE_FILE = "src/engine/api/financial_statements.py"
PDF_LANE_IMPORTERS = {
    "src/engine/api/pipeline.py": (
        frozenset({"ParseRequest", "build_router", "parse_document", "ParseResponse"}),
        "stage_extract builds the router object, finds the route named parse_document and "
        "calls its handler IN-PROCESS with a URL the engine signed itself"),
}  # type: Dict[str, Tuple[Any, str]]

#: How a router, an app or a handler becomes reachable over HTTP.
_MOUNT_VERBS = frozenset({"include_router", "mount", "add_api_route", "add_route",
                          "add_websocket_route", "add_api_websocket_route", "host"})
_ROUTE_DECORATORS = frozenset({"get", "post", "put", "patch", "delete", "options", "head", "trace",
                               "api_route", "route", "websocket", "websocket_route"})
_DYNAMIC_IMPORTS = frozenset({"import_module", "__import__"})


def _unparse(node):  # type: (Any) -> str
    return ast.unparse(node) if hasattr(ast, "unparse") else ast.dump(node)


def _is_module_path(value, component):  # type: (Any, str) -> bool
    """A string that NAMES a module (``"engine.api.financial_statements"``) —
    what a dynamic import, or a list of routers to mount, would hold. Prose
    that merely mentions the word is not one."""
    return (isinstance(value, str) and re.match(r"^[A-Za-z_][\w.]*$", value) is not None
            and component in value.split("."))


def _pdf_lane_references(tree):  # type: (Any) -> Tuple[List[str], Set[str], Set[str], List[Any]]
    """(how the module is referred to, the names bound from it, the names
    taken from it, the scopes the references were made in) — every way a
    module can get hold of the PDF lane: an import in any spelling, a dynamic
    import, the module's dotted path as a string (a list of routers to
    mount), or a bare attribute reach. A scope is the function the reference
    stands in, or the whole module for one made at module level."""
    how, bound, taken = [], set(), set()  # type: List[str], Set[str], Set[str]
    parents = {}  # type: Dict[Any, Any]
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    scopes = []  # type: List[Any]

    def _scope_of(node):  # type: (Any) -> None
        cursor = node
        while cursor in parents:
            cursor = parents[cursor]
            if isinstance(cursor, (ast.FunctionDef, ast.AsyncFunctionDef)):
                break
        if cursor not in scopes:
            scopes.append(cursor)

    for node in ast.walk(tree):
        before = (len(how), len(bound))
        if isinstance(node, ast.ImportFrom):
            if (node.module or "").split(".")[-1] == PDF_LANE:
                how.append("line %d: from %s%s import …" % (node.lineno, "." * node.level, node.module))
                for alias in node.names:
                    bound.add(alias.asname or alias.name)
                    taken.add(alias.name)
            for alias in node.names:
                if alias.name == PDF_LANE:
                    how.append("line %d: from %s%s import %s" % (
                        node.lineno, "." * node.level, node.module or "", PDF_LANE))
                    bound.add(alias.asname or alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if PDF_LANE in alias.name.split("."):
                    how.append("line %d: import %s" % (node.lineno, alias.name))
                    bound.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.Constant) and _is_module_path(node.value, PDF_LANE):
            how.append("line %d: the module path %r as a string" % (node.lineno, node.value))
        elif isinstance(node, ast.Attribute) and node.attr == PDF_LANE:
            how.append("line %d: %s" % (node.lineno, _unparse(node)))
            bound.add(_unparse(node))
        elif isinstance(node, ast.Name) and node.id == PDF_LANE:
            bound.add(PDF_LANE)
        if (len(how), len(bound)) != before:
            _scope_of(node)
    return how, bound, taken, scopes


def _tainted_names(tree, bound):  # type: (Any, Set[str]) -> Set[str]
    """``bound`` plus every name assigned, looped or bound from an expression
    that mentions one — to a fixpoint (``fs_router = _build()``; ``for route
    in fs_router.routes``; ``handler = route.endpoint``)."""
    tainted = set(bound)

    def _mentions(expr):  # type: (Any) -> bool
        if expr is None:
            return False
        text = _unparse(expr)
        return any(re.search(r"(?<![\w.])%s(?![\w])" % re.escape(name), text) for name in tainted)

    def _names(target):  # type: (Any) -> List[str]
        return [n.id for n in ast.walk(target) if isinstance(n, ast.Name)]

    changed = True
    while changed:
        changed = False
        for node in ast.walk(tree):
            pairs = []  # type: List[Tuple[Any, Any]]
            if isinstance(node, ast.Assign):
                pairs = [(t, node.value) for t in node.targets]
            elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
                pairs = [(node.target, node.value)]
            elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
                pairs = [(node.target, node.iter)]
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                pairs = [(item.optional_vars, item.context_expr) for item in node.items if item.optional_vars]
            elif hasattr(ast, "NamedExpr") and isinstance(node, ast.NamedExpr):
                pairs = [(node.target, node.value)]
            for target, value in pairs:
                if _mentions(value):
                    for name in _names(target):
                        if name not in tainted:
                            tainted.add(name)
                            changed = True
    return tainted


def _mounts_of(tree, tainted):  # type: (Any, Set[str]) -> List[str]
    """Every call that would put something tainted on the wire: a mount verb
    taking it, or a route decorator applied to it."""

    def _mentions(expr):  # type: (Any) -> bool
        text = _unparse(expr)
        return any(re.search(r"(?<![\w.])%s(?![\w])" % re.escape(name), text) for name in tainted)

    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        handed = list(node.args) + [kw.value for kw in node.keywords]
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr in _MOUNT_VERBS and any(_mentions(a) for a in handed):
            out.append("line %d: %s" % (node.lineno, _unparse(node)[:120]))
        elif (isinstance(func, ast.Call) and isinstance(func.func, ast.Attribute)
              and func.func.attr in _ROUTE_DECORATORS and any(_mentions(a) for a in handed)):
            out.append("line %d: %s" % (node.lineno, _unparse(node)[:120]))
    return out


def _source_modules():  # type: () -> List[Tuple[str, str]]
    return [(str(path.relative_to(REPO)), path.read_text(encoding="utf-8"))
            for path in sorted(SRC.rglob("*.py"))]


def test_the_pdf_model_lane_is_mounted_on_no_app(sweeps):
    """THE ROUTE TREE, both swept states, mounts walked into: no path carries
    the lane's name, and no route's endpoint IS the lane's handler at any
    path. (The first version of this law read the top-level route table and
    followed one import spelling: it was green with the lane mounted through
    a sub-application. What the two states cannot show — a mount behind a
    flag neither sets — is the source law below.)"""
    from engine.api import financial_statements as lane

    for state, sweep in sorted(sweeps.items()):
        mounted = sorted(set("%s %s" % k for k in sweep.routes + sweep.plain_routes
                             if "financial-statements" in k[1]))
        assert not mounted, (
            "NO-ANONYMOUS-MODEL-CALL VIOLATED [%s] — the PDF model lane is a route again: %s. "
            "It takes no bearer, no meter and no limiter; the pipeline calls it in-process."
            % (state, mounted))
        served = sorted(set("%s %s" % k for k, endpoint in sweep.handlers.items()
                            if endpoint is lane.parse_document))
        assert not served, (
            "NO-ANONYMOUS-MODEL-CALL VIOLATED [%s] — the PDF model lane's handler is served "
            "over HTTP under another path: %s" % (state, served))
        assert len(sweep.handlers) >= len(sweep.routes) >= 150, (len(sweep.handlers), len(sweep.routes))


def test_nothing_but_the_pipeline_refers_to_the_pdf_model_lane():
    """THE SOURCE — what holds in EVERY flag state, the ones this gate never
    sets included. No module under src/ refers to the lane's module AT ALL —
    an import in any spelling, a dynamic import, its dotted path as a string
    (a list of routers to mount), a bare attribute reach — except the
    pipeline, which may take only the names its in-process call needs; and
    there, nothing taken from the lane (nor anything assigned from it) is
    handed to a mount verb or a route decorator. A mount behind any flag
    starts with a reference: with the lane mounted on the main app under
    ``if os.environ.get("PDF_LANE_HTTP") == "1"`` the first version of this
    gate was 56 passed."""
    scanned, importers, offenders = 0, {}, []
    for rel, text in _source_modules():
        scanned += 1
        if rel == PDF_LANE_FILE or PDF_LANE not in text:
            continue
        tree = ast.parse(text)
        how, bound, taken, scopes = _pdf_lane_references(tree)
        if not how and not bound:
            continue                                  # a comment or a docstring
        importers[rel] = how or sorted(bound)
        allowed = PDF_LANE_IMPORTERS.get(rel)
        if allowed is None:
            offenders.append("%s refers to the PDF lane's module (%s)" % (rel, "; ".join(how or sorted(bound))))
            continue
        extra = sorted(taken - allowed[0])
        if extra:
            offenders.append("%s takes %s from the PDF lane (allowed: %s)" % (rel, extra, sorted(allowed[0])))
        # Followed inside the function that made the reference (the whole
        # module for a module-level one): what it bound, and what is assigned
        # or looped from that.
        for scope in scopes:
            for call in _mounts_of(scope, _tainted_names(scope, bound)):
                offenders.append("%s puts the PDF lane on the wire — %s" % (rel, call))
    assert scanned >= 200, "VACUOUS — only %d modules under src/ were read" % scanned
    assert (REPO / PDF_LANE_FILE).is_file(), "the PDF lane's module moved: %s" % PDF_LANE_FILE
    assert not offenders, (
        "NO-ANONYMOUS-MODEL-CALL VIOLATED — the PDF model lane is reachable from an app "
        "factory. Nothing but the pipeline's in-process call may refer to it (a mount behind "
        "a flag this gate never sets starts with a reference):\n  %s" % "\n  ".join(offenders))
    stale = sorted(k for k in PDF_LANE_IMPORTERS if k not in importers)
    assert not stale, (
        "PDF_LANE_IMPORTERS names modules that no longer refer to the lane: %s (found: %s)"
        % (stale, sorted(importers)))
    print("GATE-WORK %s pdf_lane modules_read=%d importers=%d" % (GATE, scanned, len(importers)))


#: The flags a route's EXISTENCE may depend on: the predicate as it is written
#: in an ``if``, the variable it reads, and what it mounts. Each is ON in the
#: ``open`` state and OFF in ``closed`` (asserted), so both sides of every
#: one are swept. A route registered under any other condition is one neither
#: state can see — it reds until its flag is declared here AND set in
#: ``STATES["open"]``.
ROUTE_FLAGS = {
    "_public_markets_enabled()": ("PUBLIC_MARKETS_ENABLED", "the public markets surface and its intelligence layer"),
    "_anomaly_radar_enabled()": ("ANOMALY_RADAR_ENABLED", "the anomaly radar"),
    "_firm_cockpit_enabled()": ("FIRM_COCKPIT_ENABLED", "the firm cockpit"),
}  # type: Dict[str, Tuple[str, str]]

#: An early exit that stands before a route registration and is NOT a flag:
#: (file, the ``if`` test) -> why.
EARLY_EXITS_DECLARED = {
    ("src/engine/public_market/router.py", "factory is None"):
        "a sibling lane's module that carries no router factory is skipped — the module "
        "list is a constant, no setting is read",
}  # type: Dict[Tuple[str, str], str]

_REGISTRATION_VERBS = frozenset({"include_router", "add_api_route", "add_route",
                                 "add_websocket_route", "add_api_websocket_route"})
_CONDITIONS = (ast.If, ast.IfExp, ast.BoolOp, ast.While) + ((ast.Match,) if hasattr(ast, "Match") else ())
_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)


def _is_registration(node):  # type: (Any) -> bool
    """A statement that puts a route on a router or an app: a mount verb
    (``mount`` only when it is given a path), or a function carrying a route
    decorator (``@router.post("/x")``)."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        verb = node.func.attr
        if verb in _REGISTRATION_VERBS:
            return True
        if verb == "mount":
            # ``app.mount("/prefix", sub)`` — not ``session.mount("https://", adapter)``.
            first = node.args[0] if node.args else None
            literal = getattr(first, "value", None) if isinstance(first, ast.Constant) else None
            return not isinstance(first, ast.Constant) or literal == "" or (
                isinstance(literal, str) and literal.startswith("/"))
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        for deco in node.decorator_list:
            if (isinstance(deco, ast.Call) and isinstance(deco.func, ast.Attribute)
                    and deco.func.attr in _ROUTE_DECORATORS and deco.args
                    and isinstance(deco.args[0], ast.Constant) and isinstance(deco.args[0].value, str)
                    and (deco.args[0].value == "" or deco.args[0].value.startswith("/"))):
                return True
    return False


def _own_nodes(node):  # type: (Any) -> Iterator[Any]
    """The nodes under ``node`` that run in ITS scope — nested functions,
    lambdas and classes (the handlers themselves) are not entered."""
    stack = list(ast.iter_child_nodes(node))
    while stack:
        inner = stack.pop()
        if isinstance(inner, _SCOPES):
            continue
        yield inner
        stack.extend(ast.iter_child_nodes(inner))


def _conditional_registrations(rel, tree):
    # type: (str, Any) -> Tuple[int, List[Tuple[str, str]], List[str]]
    """(registrations found, [(flag predicate, where)] for those under a
    declared flag, offenders)."""
    parents = {}  # type: Dict[Any, Any]
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    found, flagged, offenders = 0, [], []  # type: int, List[Tuple[str, str]], List[str]
    for node in ast.walk(tree):
        if not _is_registration(node):
            continue
        found += 1
        where = "%s:%d" % (rel, node.lineno)
        # (a) every condition the registration sits under, out to its function.
        cursor = node
        while cursor in parents:
            cursor = parents[cursor]
            if isinstance(cursor, _SCOPES):
                break
            if isinstance(cursor, ast.If) and _unparse(cursor.test) in ROUTE_FLAGS:
                flagged.append((_unparse(cursor.test), where))
            elif isinstance(cursor, _CONDITIONS):
                test = getattr(cursor, "test", None) or getattr(cursor, "subject", None) or cursor
                offenders.append("%s — registered under `%s`, which is not a declared route flag"
                                 % (where, _unparse(test)[:90]))
        # (b) an early exit standing before it in the same function.
        scope = node
        while scope in parents and not isinstance(parents[scope], _SCOPES + (ast.Module,)):
            scope = parents[scope]
        scope = parents.get(scope)
        if scope is None:
            continue
        for inner in _own_nodes(scope):
            if not isinstance(inner, ast.If) or inner.lineno >= node.lineno:
                continue
            exits = [n for n in _own_nodes(inner)
                     if isinstance(n, (ast.Return, ast.Raise, ast.Continue, ast.Break))]
            test = _unparse(inner.test)
            if exits and test not in ROUTE_FLAGS and (rel, test) not in EARLY_EXITS_DECLARED:
                offenders.append("%s — `if %s:` (line %d) exits before this registration and is "
                                 "not a declared route flag" % (where, test[:90], inner.lineno))
    return found, flagged, sorted(set(offenders))


def test_no_route_exists_behind_a_flag_the_sweep_does_not_set(monkeypatch, tmp_path):
    """THE TWO STATES ARE THE WHOLE FLAG SPACE — or the law is red. A route
    mounted under ``if os.environ.get("SOME_NEW_FLAG")`` exists in neither
    swept state, so the sweep cannot see what it reaches. Every route
    registration under src/ that sits under a condition (or after an early
    exit) is under one of ``ROUTE_FLAGS`` exactly as written, each of those is
    on in ``open`` and off in ``closed``, and inside ``create_app`` no other
    ``if`` touches the app at all (a helper that mounts, called under a
    condition, is a conditional mount too)."""
    total, flagged, offenders = 0, [], []
    for rel, text in _source_modules():
        if not any(word in text for word in _REGISTRATION_VERBS | {"mount", "APIRouter", "FastAPI"}):
            continue
        found, under, bad = _conditional_registrations(rel, ast.parse(text))
        total += found
        flagged.extend(under)
        offenders.extend(bad)

    # Inside the app factory, a condition that is not a declared flag may not
    # mention the app.
    server = ast.parse((SRC / "engine" / "api" / "server.py").read_text(encoding="utf-8"))
    factory = [n for n in ast.walk(server) if isinstance(n, ast.FunctionDef) and n.name == "create_app"]
    assert len(factory) == 1, "create_app() is not where this law looks for it"
    conditions = 0
    for node in _own_nodes(factory[0]):
        if not isinstance(node, _CONDITIONS):
            continue
        conditions += 1
        test = getattr(node, "test", None) or getattr(node, "subject", None) or node
        if isinstance(node, ast.If) and _unparse(node.test) in ROUTE_FLAGS:
            continue
        if any(isinstance(n, ast.Name) and n.id == "app" for n in ast.walk(node)):
            offenders.append("src/engine/api/server.py:%d — create_app() touches the app under "
                             "`%s`, which is not a declared route flag" % (node.lineno, _unparse(test)[:90]))

    assert not offenders, (
        "NO-ANONYMOUS-MODEL-CALL UNPROVEN — %d route registration(s) depend on a condition "
        "neither swept state sets, so the sweep cannot see what they reach. Declare the flag "
        "in ROUTE_FLAGS and set it in STATES['open'], or register unconditionally:\n  %s"
        % (len(offenders), "\n  ".join(sorted(set(offenders)))))

    # The census is not vacuous, and not stale.
    print("GATE-WORK %s route_flags registrations=%d under_a_flag=%d create_app_conditions=%d"
          % (GATE, total, len(flagged), conditions))
    assert total >= 200, "VACUOUS — only %d route registrations found under src/ (measured 237)" % total
    assert conditions >= 4, "VACUOUS — create_app() was not read (%d conditions)" % conditions
    used = set(flag for flag, _where in flagged)
    assert used == set(ROUTE_FLAGS), (
        "ROUTE_FLAGS is stale: declared %s, found gating a registration %s" % (sorted(ROUTE_FLAGS), sorted(used)))

    # Each flag is ON in ``open`` and OFF in ``closed`` — by the predicate itself.
    from engine.api import server as server_module

    for state, expected in (("closed", False), ("open", True)):
        _apply_env(monkeypatch, state, tmp_path)
        for predicate, (variable, _what) in sorted(ROUTE_FLAGS.items()):
            assert variable in STATES["open"], "%s is not set in the open state" % variable
            got = getattr(server_module, predicate[:-2])()
            assert bool(got) is expected, (
                "%s is %r in the %s state — one side of this flag is never swept" % (predicate, got, state))


def test_the_unrouted_path_answers_404_and_reaches_nothing(tmp_path):
    """The exact request measured on production (an anonymous POST, a 20-byte
    body) and the three that matter — answered 404 by the router with no
    model client, no outbound request, on both flag states' apps."""
    for state in sorted(STATES):
        ledger = Ledger()
        with pytest.MonkeyPatch.context() as mp:
            app = _build(mp, state, tmp_path / state, ledger)
            client = TestClient(app, raise_server_exceptions=False)
            for body in ({"pdf_b64": "AAAA"}, {"pdf_b64": PDF_B64}, {"pdf_url": URL_BODY},
                         {"pdf_url": URL_OWN_STORAGE}):
                for identity in IDENTITIES:
                    resp = client.post("/api/financial-statements/parse", json=body,
                                       headers=_identity_headers(identity))
                    assert resp.status_code == 404, (state, identity, body, resp.status_code, resp.text[:200])
            _cold()
        assert ledger.model == [] and ledger.outbound == [], (state, ledger.model, ledger.outbound)


# ══════════════════════════════════════════════════════════════════════
# What the handler itself will fetch, and what it sends
# ══════════════════════════════════════════════════════════════════════

_OWN = "https://%s/storage/v1/object/sign/documents/%s/uploads/%s.pdf?token=t" % (SUPABASE_HOST, UUID, UUID)

REFUSED_URLS = [
    ("another host", URL_BODY.replace("http://", "https://")),
    ("an address inside the Docker network", URL_INTERNAL),
    ("an address literal", URL_IP),
    ("the metadata address", URL_METADATA),
    ("http to the project's own host", _OWN.replace("https://", "http://")),
    ("the project's host as a subdomain of another", _OWN.replace(SUPABASE_HOST, SUPABASE_HOST + ".evil.invalid")),
    ("the project's host as the userinfo of another", _OWN.replace(SUPABASE_HOST, SUPABASE_HOST + "@evil.invalid")),
    ("a backslash before the real host", _OWN.replace(SUPABASE_HOST, "evil.invalid\\@" + SUPABASE_HOST)),
    ("credentials on the project's own host", _OWN.replace("https://", "https://user:pw@")),
    ("another port on the project's host", _OWN.replace(SUPABASE_HOST, SUPABASE_HOST + ":8443")),
    ("a trailing dot on the host", _OWN.replace(SUPABASE_HOST, SUPABASE_HOST + ".")),
    ("the REST API of the project", "https://%s/rest/v1/documents?select=*" % SUPABASE_HOST),
    ("the auth admin API of the project", "https://%s/auth/v1/admin/users" % SUPABASE_HOST),
    ("another bucket", "https://%s/storage/v1/object/sign/exports/%s/x.pdf?token=t" % (SUPABASE_HOST, UUID)),
    ("an unsigned object path", "https://%s/storage/v1/object/documents/%s/x.pdf" % (SUPABASE_HOST, UUID)),
    ("a path that climbs out of the bucket",
     "https://%s/storage/v1/object/sign/documents/../../../../auth/v1/admin/users" % SUPABASE_HOST),
    ("an encoded climb out of the bucket",
     "https://%s/storage/v1/object/sign/documents/%%2e%%2e/%%2e%%2e/secrets?token=t" % SUPABASE_HOST),
    ("an empty path segment", "https://%s/storage/v1/object/sign/documents//x.pdf" % SUPABASE_HOST),
    ("a file URL", "file:///etc/passwd"),
    ("a scheme-relative URL", "//%s/storage/v1/object/sign/documents/a/b.pdf" % SUPABASE_HOST),
    ("a newline in the URL", _OWN + "\nHost: evil.invalid"),
    ("a non-ASCII host", _OWN.replace(SUPABASE_HOST, "tést.supabase.co")),
    ("not a URL", "balanta.pdf"),
    ("a URL of 5,000 characters", _OWN + "&x=" + "a" * 5000),
    # The check and the request must read the SAME URL (review of 2026-10-04).
    ("port 0 on the project's host", _OWN.replace(SUPABASE_HOST, SUPABASE_HOST + ":0")),
    ("an encoded slash inside the fixed prefix",
     "https://%s/storage%%2fv1/object/sign/documents/a/b.pdf?token=t" % SUPABASE_HOST),
    ("an encoded letter inside the fixed prefix",
     "https://%s/storage/v1/object/sign/%%64ocuments/a/b.pdf?token=t" % SUPABASE_HOST),
    ("twice-encoded dot segments",
     "https://%s/storage/v1/object/sign/documents/%%252e%%252e/%%252e%%252e/secrets?token=t" % SUPABASE_HOST),
    ("an encoded slash inside the object key",
     "https://%s/storage/v1/object/sign/documents/a%%2fb.pdf?token=t" % SUPABASE_HOST),
    ("an encoded backslash inside the object key",
     "https://%s/storage/v1/object/sign/documents/a%%5cb.pdf?token=t" % SUPABASE_HOST),
    ("an encoded dot inside the object key",
     "https://%s/storage/v1/object/sign/documents/a/b%%2Epdf?token=t" % SUPABASE_HOST),
    ("an encoded percent sign inside the object key",
     "https://%s/storage/v1/object/sign/documents/a/b%%2520c.pdf?token=t" % SUPABASE_HOST),
    ("a host label that does not decode", _OWN.replace(SUPABASE_HOST, "xn--." + SUPABASE_HOST)),
    ("another host label that does not decode", _OWN.replace(SUPABASE_HOST, "xn--a.supabase.co")),
    ("a space after the host", _OWN.replace(SUPABASE_HOST, SUPABASE_HOST + " ")),
    ("a space before the host", _OWN.replace(SUPABASE_HOST, " " + SUPABASE_HOST)),
    ("a tab inside the object key", _OWN.replace(".pdf", ".a\tb")),
    ("a non-ASCII character inside the object key", _OWN.replace(".pdf", ".d\u00e9cembrie")),
]


@pytest.mark.parametrize("label,url", REFUSED_URLS, ids=[r[0] for r in REFUSED_URLS])
def test_a_url_that_is_not_this_projects_storage_is_refused_before_any_request(harness, label, url):
    from fastapi import HTTPException

    from engine.api.financial_statements import ParseRequest, parse_document

    with pytest.raises(HTTPException) as refusal:
        parse_document(ParseRequest(pdf_url=url, original_filename="balanta.pdf"))
    assert refusal.value.status_code == 400, (label, refusal.value.status_code, refusal.value.detail)
    assert "pdf_url refused" in str(refusal.value.detail)
    assert url not in str(refusal.value.detail), "the refusal quotes the URL it was given"
    assert harness.outbound == [], (
        "%s: the handler made %d request(s) before refusing: %s" % (label, len(harness.outbound), harness.outbound))
    assert harness.model == [], (label, harness.model)


@pytest.mark.parametrize("configured", [None, "", "not a url", "http://%s" % SUPABASE_HOST,
                                         "https://user:pw@%s" % SUPABASE_HOST, "https://"],
                         ids=["unset", "empty", "unreadable", "http", "with-credentials", "no-host"])
def test_with_no_project_storage_configured_nothing_is_fetched(harness, monkeypatch, configured):
    """Where the engine cannot say which project is its own, it fetches
    nothing — the project's own signed URL included."""
    from fastapi import HTTPException

    from engine.api.financial_statements import ParseRequest, parse_document

    if configured is None:
        monkeypatch.delenv("VITE_SUPABASE_URL", raising=False)
    else:
        monkeypatch.setenv("VITE_SUPABASE_URL", configured)
    for url in (_OWN, URL_BODY):
        with pytest.raises(HTTPException) as refusal:
            parse_document(ParseRequest(pdf_url=url))
        assert refusal.value.status_code == 503, (configured, url, refusal.value.status_code)
        assert "pdf_url refused" in str(refusal.value.detail)
    assert harness.outbound == [] and harness.model == []


#: Signed URLs of the documents bucket this lane must go on fetching, with
#: the path the request carries. The browser builds a key's ending from the
#: uploaded file's own name (``{org}/uploads/{document}.{ext}``, ``ext`` the
#: text after the last dot, unsanitised), the storage API allows a space in a
#: key, and the sign response hands the key back as it is.
_KEY = "/storage/v1/object/sign/documents/%s/uploads/%s" % (UUID, UUID)
ACCEPTED_URLS = [
    ("a plain signed URL", _OWN, _KEY + ".pdf?token=t"),
    ("a key with a space, as the sign response returns it",
     "https://%s%s.balanta dec 2025?token=t" % (SUPABASE_HOST, _KEY), _KEY + ".balanta%20dec%202025?token=t"),
    ("the same key already percent-encoded",
     "https://%s%s.balanta%%20dec%%202025?token=t" % (SUPABASE_HOST, _KEY), _KEY + ".balanta%20dec%202025?token=t"),
    ("a key ending in ' (1)'",
     "https://%s%s.pdf (1)?token=t" % (SUPABASE_HOST, _KEY), _KEY + ".pdf%20(1)?token=t"),
    ("the default port written out", _OWN.replace(SUPABASE_HOST, SUPABASE_HOST + ":443"), _KEY + ".pdf?token=t"),
    ("the host in capitals", _OWN.replace(SUPABASE_HOST, SUPABASE_HOST.upper()), _KEY + ".pdf?token=t"),
    ("escapes inside the token only", _OWN.replace("token=t", "token=a%2Fb%25c"), _KEY + ".pdf?token=a%2Fb%25c"),
]


@pytest.mark.parametrize("label,url,sent", ACCEPTED_URLS, ids=[a[0] for a in ACCEPTED_URLS])
def test_a_signed_url_of_the_projects_storage_is_fetched_as_written(harness, monkeypatch, label, url, sent):
    """What the pipeline hands over is still read — a space in the key
    included (main read it; the first version of this lane refused it and the
    document with it) — and the request carries exactly the path the check
    read: one GET, to the project's host on the default port, the space sent
    percent-encoded once."""
    from engine.api import financial_statements as FS

    script = _Script(monkeypatch)
    script.respond = lambda request: httpx.Response(
        200, headers={"content-type": "application/pdf"}, content=TINY_PDF)
    harness.respond_with = _model_json()
    out = FS.parse_document(FS.ParseRequest(pdf_url=url, original_filename="balanta.pdf"))
    assert [a.code for a in out.accounts] == ["5121"], label
    assert len(script.requests) == 1, (label, [str(r.url) for r in script.requests])
    request = script.requests[0]
    assert request.url.raw_path.decode("ascii") == sent, (label, request.url.raw_path)
    assert request.url.host == SUPABASE_HOST and request.url.port is None and request.url.scheme == "https"
    assert request.headers.get("host") == SUPABASE_HOST, (label, request.headers.get("host"))
    assert [e["what"] for e in harness.model] == ["construct", "call"], (label, harness.model)


class _Script(object):
    """A storage that answers what the test says, at the transport — the
    client's own send / redirect logic runs above it."""

    def __init__(self, mp):  # type: (Any) -> None
        self.requests = []  # type: List[httpx.Request]
        self.pulled = 0
        self.closed = 0
        self.respond = None  # type: Any
        script = self

        def _handle(transport, request):  # type: (Any, httpx.Request) -> httpx.Response
            script.requests.append(request)
            return script.respond(request)

        mp.setattr(httpx.HTTPTransport, "handle_request", _handle, raising=True)

    def stream(self, chunks):  # type: (Any) -> httpx.SyncByteStream
        script = self

        class _Stream(httpx.SyncByteStream):
            def __iter__(self):  # type: () -> Iterator[bytes]
                for chunk in chunks:
                    script.pulled += len(chunk)
                    yield chunk

            def close(self):  # type: () -> None
                script.closed += 1

        return _Stream()


def _model_json():  # type: () -> str
    return json.dumps({"company_name": None, "period_label": "FY", "period_end": None,
                       "currency": "RON", "confidence": 0.5, "detected_type": "trial_balance",
                       "accounts": [{"code": "5121", "name": "Banca", "amount": "10.5"}],
                       "warnings": []})


def test_the_pipelines_in_process_contract_holds(harness, monkeypatch):
    """What ``pipeline.stage_extract`` does, to the letter: build the router,
    find the route NAMED ``parse_document``, call its endpoint with a URL the
    engine signed. One GET to the project's storage (30 s per phase, no
    redirect following, identity encoding), one model client, one call."""
    from engine.api import financial_statements as FS

    script = _Script(monkeypatch)
    script.respond = lambda request: httpx.Response(
        200, headers={"content-type": "application/pdf"}, content=TINY_PDF)
    harness.respond_with = _model_json()

    router = FS.build_router()
    handler = next((r.endpoint for r in router.routes if getattr(r, "name", None) == "parse_document"), None)
    assert handler is FS.parse_document, "the router's parse_document route is not the module's handler"
    out = handler(FS.ParseRequest(pdf_url=_OWN, original_filename="balanta.pdf"))

    assert [a.code for a in out.accounts] == ["5121"] and out.accounts[0].amount == 10.5
    assert len(script.requests) == 1
    request = script.requests[0]
    assert request.method == "GET" and str(request.url) == _OWN
    assert request.headers.get("accept-encoding") == "identity"
    assert request.extensions.get("timeout") == {"connect": 30.0, "read": 30.0, "write": 30.0, "pool": 30.0}, (
        "the storage download has no (or another) timeout: %s" % request.extensions.get("timeout"))
    kinds = [e["what"] for e in harness.model]
    assert kinds == ["construct", "call"], harness.model
    assert "claude-opus-4-7" in harness.model[1]["detail"] and "max_tokens=8000" in harness.model[1]["detail"]


def test_no_redirect_is_followed(harness, monkeypatch):
    """A 3xx from storage is refused. With redirects followed the client
    would issue a second request — to a host the storage's answer named."""
    from fastapi import HTTPException

    from engine.api.financial_statements import ParseRequest, parse_document

    for location in ("https://evil.invalid/x.pdf", "http://cfo-ai-pdf:3000/x", _OWN + "&again=1"):
        script = _Script(monkeypatch)
        script.respond = lambda request, location=location: httpx.Response(
            302, headers={"location": location}, content=b"")
        with pytest.raises(HTTPException) as refusal:
            parse_document(ParseRequest(pdf_url=_OWN))
        assert refusal.value.status_code == 502 and "redirect" in str(refusal.value.detail)
        assert [str(r.url) for r in script.requests] == [_OWN], (
            "the handler followed a redirect to %s: %s" % (location, [str(r.url) for r in script.requests]))
    assert harness.model == []


def test_the_size_cap_is_enforced_while_reading(harness, monkeypatch):
    """A body with no declared length that never ends: the handler stops
    reading as soon as what it holds passes 25 MB — not after the whole body
    is in memory. A declared length over the cap is refused before a byte."""
    from fastapi import HTTPException

    from engine.api import financial_statements as FS

    chunk = b"%PDF-1.4\n" + b"0" * (1024 * 1024 - 9)
    endless = (chunk for _ in range(60))                      # 60 MB on offer
    script = _Script(monkeypatch)
    script.respond = lambda request: httpx.Response(
        200, headers={"content-type": "application/pdf"}, stream=script.stream(endless))
    with pytest.raises(HTTPException) as refusal:
        FS.parse_document(FS.ParseRequest(pdf_url=_OWN))
    assert refusal.value.status_code == 413
    assert script.pulled <= FS.PDF_MAX_BYTES + 2 * len(chunk), (
        "the handler pulled %d bytes of a 60 MB body before refusing (cap %d) — the cap is "
        "checked after the read, not while reading" % (script.pulled, FS.PDF_MAX_BYTES))
    assert script.closed >= 1, "the stream was left open"

    script = _Script(monkeypatch)
    script.respond = lambda request: httpx.Response(
        200, headers={"content-type": "application/pdf", "content-length": str(FS.PDF_MAX_BYTES + 1)},
        stream=script.stream(chunk for _ in range(30)))
    with pytest.raises(HTTPException) as refusal:
        FS.parse_document(FS.ParseRequest(pdf_url=_OWN))
    assert refusal.value.status_code == 413 and script.pulled == 0, (refusal.value.status_code, script.pulled)

    # An encoded body is refused: the bytes counted must be the bytes held.
    script = _Script(monkeypatch)
    script.respond = lambda request: httpx.Response(
        200, headers={"content-encoding": "gzip"}, stream=script.stream(iter([b"\x1f\x8b"])))
    with pytest.raises(HTTPException) as refusal:
        FS.parse_document(FS.ParseRequest(pdf_url=_OWN))
    assert refusal.value.status_code == 502 and script.pulled == 0

    # Inline base64 has the same ceiling.
    with pytest.raises(HTTPException) as refusal:
        FS.parse_document(FS.ParseRequest(
            pdf_b64=base64.b64encode(b"%PDF-1.4\n" + b"0" * FS.PDF_MAX_BYTES).decode()))
    assert refusal.value.status_code == 413
    assert harness.model == []


def test_the_download_has_a_deadline(harness, monkeypatch):
    """A body that keeps trickling inside the per-read timeout is cut off at
    the whole-download deadline."""
    from fastapi import HTTPException

    from engine.api import financial_statements as FS

    clock = {"now": 1000.0}
    monkeypatch.setattr(FS, "_monotonic", lambda: clock["now"])

    def _trickle():  # type: () -> Iterator[bytes]
        for _ in range(10000):
            clock["now"] += 25.0                              # under the 30 s read timeout
            yield b"%PDF-1.4\n"

    script = _Script(monkeypatch)
    script.respond = lambda request: httpx.Response(200, stream=script.stream(_trickle()))
    with pytest.raises(HTTPException) as refusal:
        FS.parse_document(FS.ParseRequest(pdf_url=_OWN))
    assert refusal.value.status_code == 504, refusal.value.detail
    assert script.pulled <= 9 * 8, "the handler read %d bytes past its %d s deadline" % (
        script.pulled, FS.STORAGE_FETCH_DEADLINE_S)
    assert harness.model == []


def test_a_storage_failure_is_reported_without_the_signed_url(harness, monkeypatch):
    from fastapi import HTTPException

    from engine.api.financial_statements import ParseRequest, parse_document

    script = _Script(monkeypatch)
    for respond in (lambda request: httpx.Response(400, content=b'{"error":"InvalidJWT"}'),
                    lambda request: (_ for _ in ()).throw(httpx.ConnectError("refused", request=request))):
        script.respond = respond
        with pytest.raises(HTTPException) as refusal:
            parse_document(ParseRequest(pdf_url=_OWN))
        assert refusal.value.status_code == 502
        assert "token=" not in str(refusal.value.detail) and SUPABASE_HOST not in str(refusal.value.detail), (
            "the failure text carries the signed URL: %s" % refusal.value.detail)
    assert harness.model == []


def _zip_bytes():  # type: () -> bytes
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml", "<w:document/>")
    return buf.getvalue()


NOT_A_PDF = [
    ("text", b"not a pdf at all"),
    ("empty", b""),
    ("a Word document", _zip_bytes()),
    ("an OLE2 file", b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1" + b"\x00" * 600),
    ("binary", b"\x00\x01\x02\x03" * 64),
    ("JSON", b'{"detail":"Not Found"}'),
]


@pytest.mark.parametrize("label,content", NOT_A_PDF, ids=[n[0] for n in NOT_A_PDF])
def test_bytes_that_are_not_a_pdf_never_reach_the_model(harness, monkeypatch, label, content):
    """Inline or downloaded: refused 415 before the SDK is imported."""
    from fastapi import HTTPException

    from engine.api.financial_statements import ParseRequest, parse_document

    harness.respond_with = _model_json()
    if content:
        with pytest.raises(HTTPException) as refusal:
            parse_document(ParseRequest(pdf_b64=base64.b64encode(content).decode()))
        assert refusal.value.status_code == 415, (label, refusal.value.status_code, refusal.value.detail)
    script = _Script(monkeypatch)
    script.respond = lambda request: httpx.Response(200, content=content)
    with pytest.raises(HTTPException) as refusal:
        parse_document(ParseRequest(pdf_url=_OWN))
    assert refusal.value.status_code == 415, (label, refusal.value.status_code, refusal.value.detail)
    assert harness.model == [], (
        "%s bytes reached the model client as application/pdf: %s" % (label, harness.model))


def test_what_the_pdf_branch_reads_as_a_pdf_is_still_sent(harness):
    """The rule is the pipeline guard's own (``_upload_type.reads_as_pdf`` on
    the .pdf branch): a PDF, and text carrying ``%PDF-`` past the sniffer's
    window, are read exactly as before."""
    from engine.api.financial_statements import ParseRequest, parse_document

    harness.respond_with = _model_json()
    for content in (TINY_PDF, b"\n" * 2000 + TINY_PDF, b"junk before the header " + TINY_PDF):
        before = len(harness.model)
        out = parse_document(ParseRequest(pdf_b64=base64.b64encode(content).decode()))
        assert out.accounts and [e["what"] for e in harness.model[before:]] == ["construct", "call"]


# ══════════════════════════════════════════════════════════════════════
# The recorders are not blind
# ══════════════════════════════════════════════════════════════════════


def test_the_recorders_see_every_transport_and_both_sdks(harness):
    """A zero from a recorder that records nothing is not a zero. Each
    transport and each SDK is driven once, directly, and must be in the
    ledger — and nothing may have left the machine."""
    import anthropic
    import openai

    with pytest.raises(ModelCallRecorded):
        anthropic.Anthropic(api_key="k", max_retries=5).messages.create(model="m", max_tokens=1)
    with pytest.raises(ModelCallRecorded):
        openai.OpenAI(api_key="k").responses.create(model="m", input="x")
    assert [(e["sdk"], e["what"]) for e in harness.model] == [
        ("anthropic", "construct"), ("anthropic", "call"), ("openai", "construct"), ("openai", "call")]
    assert issubclass(anthropic.RateLimitError, Exception)

    with httpx.Client() as client:
        assert client.get(URL_BODY).content == TINY_PDF
        assert client.get("https://%s/rest/v1/documents?id=eq.1" % SUPABASE_HOST).json() == []
        client.post("https://api.anthropic.com/v1/messages", json={})
    urllib.request.urlopen(URL_INTERNAL, timeout=1).read()
    try:
        import requests

        with pytest.raises(requests.exceptions.ConnectionError):
            requests.get(URL_IP, timeout=1)
    except ImportError:  # pragma: no cover
        harness.outbound_event("requests", URL_IP)
    with pytest.raises(OSError):
        socket.create_connection(("169.254.169.254", 80), timeout=1)

    transports = [e["transport"] for e in harness.outbound]
    assert transports == ["httpx", "httpx", "httpx", "urllib", "requests", "socket"], harness.outbound
    assert [e["caller_named"] for e in harness.outbound] == [True, False, False, True, True, True]
    assert harness.model[-1]["sdk"] == "transport", (
        "a raw request to the model API was not counted as a model call: %s" % harness.model[-1])


def test_the_census_names_routes_the_app_mounts(sweeps):
    opened = set(sweeps["open"].routes)
    stale = sorted(k for k in DECLARED if k not in opened)
    assert not stale, "DECLARED names routes the app no longer mounts: %s" % stale
    for key, bound in DECLARED.items():
        assert "PUBLIC_LLM_COMPLETIONS_PER_DAY" in bound, "%s is declared with no bound" % (key,)
    assert DECLARED_IN["closed"] == set(), "nothing may be declared for the closed state"
