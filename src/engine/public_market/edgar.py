# -*- coding: utf-8 -*-
"""SEC EDGAR fundamentals adapter for the `public_market` document class.

Free, official, keyless. Produces the public_market summary IR + envelope
(statement-level values with per-figure provenance) from the EDGAR
companyfacts API. Python 3.9 (no match statements, no X|Y unions).

SEC FAIR ACCESS (https://www.sec.gov/search-filings/edgar-search-assistance/
accessing-edgar-data, retrieved 2026-08-29): "Current max request rate:
10 requests/second." — enforced here with a token bucket; "Please declare
your user agent" — every request carries USER_AGENT below; efficient
scripting / download-only-what-you-need — callers fetch one CIK on demand,
never crawl. Backoff on 429/5xx is exponential; exhaustion is a TYPED error,
never a silent empty result.

INVARIANTS (the PM laws for this document class):
* doc_class `public_market` is a SIBLING of public_summary: its envelopes
  NEVER enter packs/reconcile/consensus. `status` is always "PUBLIC_MARKET".
* Every figure carries provenance {source, accession (= dataset_version),
  as_of, fetched_at} plus form/fy/fp/filed.
* ABSENT != ZERO: a concept the filer never tagged is a missing figure plus a
  typed refusal record — never 0.
* Deterministic: same input bytes -> same IR. All selection logic lives in
  edgar_concepts (pure).

JOURNAL CHOICE (documented per lane instructions): this module ships a
minimal append-only jsonl journal (journal.jsonl + dlq.jsonl) instead of
importing the engine.journal machinery. Reasons: (a) engine.journal pulls the
full engine-of-record dependency tree, which is not a cheap import for an
on-demand adapter; (b) this session's environment could not read the
pre-existing engine sources to verify that import safely. Discipline is the
same: append-only, one JSON object per line, records never rewritten. Swapping
to engine.journal later only touches the Journal class below.

SPINE STORE (documented interface, coded against, not yet imported): the spine
lane's store is expected at engine.public_market.store with
    get_store() -> store;  store.put(envelope);  store.get(cik) -> envelope|None
Discovery is guarded: when the module is absent the adapter honestly reports
meta.cached=False / cache_reason="store_unavailable" (and journals it) instead
of failing or pretending.
"""

import datetime
import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

from engine.public_market import edgar_concepts
from engine.public_market.edgar_concepts import (  # re-exported for callers
    EdgarError,
    EdgarFormatError,
)

__all__ = [
    "USER_AGENT",
    "TICKERS_URL",
    "COMPANYFACTS_URL_TMPL",
    "EdgarError",
    "EdgarFormatError",
    "EdgarTransportError",
    "EdgarHTTPError",
    "EdgarRateLimitedError",
    "EdgarTickerUnknown",
    "TokenBucket",
    "EdgarClient",
    "Journal",
    "EdgarAdapter",
    "resolve_cik",
    "fetch_companyfacts",
    "build_summary_ir",
    "build_envelope",
]

# Declared traffic, per SEC guidance ("Please declare your user agent").
USER_AGENT = "cfo-ai.io engine (contact: ad.crestin@gmail.com)"

TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
COMPANYFACTS_URL_TMPL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"

SOURCE = "sec_edgar_companyfacts"
SCHEMA_VERSION = "public_market.edgar.v1"

# SEC fair-access ceiling. We run AT the ceiling only in bursts; the bucket
# refills at the declared max so sustained traffic never exceeds it.
SEC_MAX_REQUESTS_PER_SEC = 10


# ---------------------------------------------------------------------------
# Typed errors (EdgarError base + EdgarFormatError live in edgar_concepts)
# ---------------------------------------------------------------------------


class EdgarTransportError(EdgarError):
    """Socket/DNS/OS-level failure talking to SEC (after retries)."""

    code = "TRANSPORT"


class EdgarHTTPError(EdgarError):
    """Non-success HTTP status that is not retryable (or retries exhausted)."""

    code = "HTTP"

    def __init__(self, message, status):
        super(EdgarHTTPError, self).__init__(message)
        self.status = status


class EdgarRateLimitedError(EdgarHTTPError):
    """429 responses persisted through the whole backoff schedule."""

    code = "RATE_LIMIT_EXHAUSTED"

    def __init__(self, message):
        super(EdgarRateLimitedError, self).__init__(message, status=429)


class EdgarTickerUnknown(EdgarError):
    """Ticker not present in the SEC company_tickers mapping."""

    code = "TICKER_UNKNOWN"


# ---------------------------------------------------------------------------
# Polite client
# ---------------------------------------------------------------------------


class TokenBucket(object):
    """Client-side enforcement of the SEC fair-access rate.

    Burst up to `capacity`, refill `rate_per_sec` tokens/second. `clock` and
    `sleeper` are injectable so tests never sleep for real.
    """

    def __init__(self, rate_per_sec=SEC_MAX_REQUESTS_PER_SEC,
                 capacity=SEC_MAX_REQUESTS_PER_SEC, clock=None, sleeper=None):
        self.rate = float(rate_per_sec)
        self.capacity = float(capacity)
        self._clock = clock if clock is not None else time.monotonic
        self._sleeper = sleeper if sleeper is not None else time.sleep
        self._tokens = self.capacity
        self._last = self._clock()

    def _refill(self):
        now = self._clock()
        elapsed = max(0.0, now - self._last)
        self._last = now
        self._tokens = min(self.capacity, self._tokens + elapsed * self.rate)

    def acquire(self):
        """Block (via sleeper) until one request token is available."""
        self._refill()
        if self._tokens < 1.0:
            deficit = 1.0 - self._tokens
            self._sleeper(deficit / self.rate)
            self._refill()
            # After sleeping exactly the deficit the bucket must hold >= 1
            # token under a monotonic clock; clamp defensively regardless.
            self._tokens = max(self._tokens, 1.0)
        self._tokens -= 1.0


def _default_transport(timeout):
    """transport(url, headers) -> (status, body_bytes). HTTP statuses are
    RETURNED (the retry policy lives in EdgarClient); OS-level failures raise
    OSError for the client to wrap into EdgarTransportError."""

    def transport(url, headers):
        req = urllib.request.Request(url, headers=dict(headers))
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
            try:
                return (resp.status, resp.read())
            finally:
                resp.close()
        except urllib.error.HTTPError as e:
            body = b""
            try:
                body = e.read()
            except Exception:
                pass
            return (e.code, body)
        except urllib.error.URLError as e:
            raise OSError("EDGAR transport failure for %s: %s" % (url, e.reason))

    return transport


class EdgarClient(object):
    """Polite HTTP client: declared UA, token bucket, exponential backoff.

    Failure is always a typed error — this client never returns None or an
    empty payload to paper over a problem.
    """

    RETRYABLE = (429, 500, 502, 503, 504)

    def __init__(self, user_agent=USER_AGENT, transport=None, token_bucket=None,
                 max_attempts=4, backoff_base=0.5, sleeper=None, timeout=30):
        self.user_agent = user_agent
        self.max_attempts = int(max_attempts)
        self.backoff_base = float(backoff_base)
        self._sleeper = sleeper if sleeper is not None else time.sleep
        self._bucket = token_bucket if token_bucket is not None else TokenBucket()
        self._transport = transport if transport is not None else _default_transport(timeout)

    def _headers(self):
        return {
            "User-Agent": self.user_agent,
            "Accept": "application/json",
        }

    def get_bytes(self, url):
        # type: (str) -> bytes
        last_status = None
        last_exc = None
        for attempt in range(1, self.max_attempts + 1):
            # every attempt (retries included) spends a fair-access token
            self._bucket.acquire()
            try:
                status, body = self._transport(url, self._headers())
                last_exc = None
            except OSError as e:
                last_exc = e
                status, body = None, b""
            if last_exc is None:
                if status == 200:
                    return body
                if status not in self.RETRYABLE:
                    raise EdgarHTTPError(
                        "EDGAR returned HTTP %s for %s" % (status, url), status=status
                    )
                last_status = status
            if attempt < self.max_attempts:
                # deterministic exponential backoff: base * 2^(attempt-1)
                self._sleeper(self.backoff_base * (2 ** (attempt - 1)))
        if last_exc is not None:
            raise EdgarTransportError(
                "EDGAR unreachable after %d attempts for %s: %s"
                % (self.max_attempts, url, last_exc)
            )
        if last_status == 429:
            raise EdgarRateLimitedError(
                "EDGAR rate limit persisted through %d attempts for %s"
                % (self.max_attempts, url)
            )
        raise EdgarHTTPError(
            "EDGAR returned HTTP %s through %d attempts for %s"
            % (last_status, self.max_attempts, url),
            status=last_status,
        )

    def get_json(self, url):
        # type: (str) -> Any
        body = self.get_bytes(url)
        try:
            return json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            raise EdgarFormatError(
                "EDGAR response for %s is not valid JSON: %s" % (url, e)
            )


# ---------------------------------------------------------------------------
# Ticker -> CIK resolution
# ---------------------------------------------------------------------------


def resolve_cik(ticker, client):
    # type: (str, EdgarClient) -> str
    """Resolve a ticker via SEC's company_tickers.json to a 10-digit CIK.

    Case-insensitive. Unknown tickers are a typed refusal (never None)."""
    if not ticker or not isinstance(ticker, str):
        raise EdgarTickerUnknown("empty ticker")
    doc = client.get_json(TICKERS_URL)
    if not isinstance(doc, dict):
        raise EdgarFormatError("company_tickers.json: expected object, got %s" % type(doc))
    wanted = ticker.strip().upper()
    for entry in doc.values():
        try:
            if str(entry.get("ticker", "")).upper() == wanted:
                return str(int(entry["cik_str"])).zfill(10)
        except (AttributeError, TypeError, ValueError, KeyError):
            # one malformed row must not break resolution of the rest
            continue
    raise EdgarTickerUnknown("ticker %r not in SEC company_tickers mapping" % (ticker,))


def fetch_companyfacts(cik, client):
    # type: (str, EdgarClient) -> Dict
    """Fetch the companyfacts document for a zero-padded 10-digit CIK."""
    if not (isinstance(cik, str) and len(cik) == 10 and cik.isdigit()):
        raise EdgarFormatError("CIK must be a 10-digit string, got %r" % (cik,))
    doc = client.get_json(COMPANYFACTS_URL_TMPL.format(cik=cik))
    if not isinstance(doc, dict) or "facts" not in doc:
        raise EdgarFormatError("companyfacts for CIK %s: missing 'facts'" % cik)
    return doc


# ---------------------------------------------------------------------------
# Summary IR
# ---------------------------------------------------------------------------


def _usd_facts(doc, taxonomy="us-gaap"):
    # type: (Dict, str) -> Dict[str, List[Dict]]
    """{concept: USD facts}. Concepts without a USD unit behave as absent —
    v1 of this adapter is USD-only; FX-denominated filers (some 20-F) are a
    later wave and must refuse rather than mix currencies silently."""
    out = {}
    tax = doc.get("facts", {}).get(taxonomy, {})
    for concept, payload in tax.items():
        units = payload.get("units", {}) if isinstance(payload, dict) else {}
        facts = units.get("USD")
        if facts:
            out[concept] = facts
    return out


def _fiscal(fact):
    return {
        "fy": fact.get("fy"),
        "fp": fact.get("fp"),
        "start": fact.get("start"),
        "end": fact.get("end"),
    }


def _provenance(taxonomy, concept, unit, fact, fetched_at):
    accession = fact.get("accn")
    return {
        "source": SOURCE,
        "taxonomy": taxonomy,
        "concept": concept,
        "unit": unit,
        "accession": accession,
        # dataset_version for companyfacts figures IS the filing accession:
        # it names the exact submission the value came from.
        "dataset_version": accession,
        "form": fact.get("form"),
        "fy": fact.get("fy"),
        "fp": fact.get("fp"),
        "filed": fact.get("filed"),
        "as_of": fact.get("end"),
        "fetched_at": fetched_at,
    }


def _monetary_figure(concept, fact, fetched_at):
    """USD fact -> figure dict with integer minor units (cents) + provenance."""
    return {
        "value_minor": edgar_concepts.usd_to_minor(fact["val"]),
        "currency": "USD",
        "minor_unit": "cent",
        "fiscal": _fiscal(fact),
        "provenance": _provenance("us-gaap", concept, "USD", fact, fetched_at),
    }


def _refusal(figure, code, detail):
    return {"figure": figure, "code": code, "detail": detail}


def _select_simple(figures, refusals, name, facts_by_concept, chain, kind, fetched_at):
    sel = edgar_concepts.select_latest_annual(facts_by_concept, chain, kind)
    if sel is None:
        refusals.append(_refusal(
            name, "CONCEPT_ABSENT",
            "no annual %s fact for any of %s" % (kind, "|".join(chain)),
        ))
        return
    concept, fact = sel
    try:
        figures[name] = _monetary_figure(concept, fact, fetched_at)
    except EdgarFormatError as e:
        code = ("NON_INTEGRAL_MINOR_UNITS"
                if getattr(e, "reason", None) == "non_integral" else "VALUE_FORMAT")
        refusals.append(_refusal(name, code, e.message))


def _component(concept, fact):
    """Per-component record for composite figures: value + own provenance."""
    return {
        "concept": concept,
        "value_minor": edgar_concepts.usd_to_minor(fact["val"]),
        "accession": fact.get("accn"),
        "form": fact.get("form"),
        "end": fact.get("end"),
        "filed": fact.get("filed"),
    }


def _short_debt_components(facts_by_concept):
    # type: (Dict[str, List[Dict]]) -> Optional[List[Tuple[str, Dict]]]
    """Short-term debt side. Umbrella DebtCurrent when tagged; else the
    composite: REQUIRED anchor LongTermDebtCurrent + optional add-ons tagged
    at the same instant (see edgar_concepts docstring for the scoped
    ABSENT!=ZERO exception this composite is allowed). None = unresolvable."""
    umbrella = edgar_concepts.select_latest_annual(
        facts_by_concept, edgar_concepts.SHORT_DEBT_UMBRELLA_CHAIN, "instant"
    )
    composite = None
    anchor_facts = facts_by_concept.get(edgar_concepts.SHORT_DEBT_ANCHOR)
    if anchor_facts:
        cands = edgar_concepts.annual_instant_candidates(anchor_facts)
        if cands:
            anchor_end = max(f["end"] for f in cands)
            anchor = edgar_concepts.best_at_end(cands, anchor_end)
            composite = [(edgar_concepts.SHORT_DEBT_ANCHOR, anchor)]
            for addon in edgar_concepts.SHORT_DEBT_ADDONS:
                addon_facts = facts_by_concept.get(addon)
                if not addon_facts:
                    continue
                addon_cands = edgar_concepts.annual_instant_candidates(addon_facts)
                addon_fact = edgar_concepts.best_at_end(addon_cands, anchor_end)
                if addon_fact is not None:
                    composite.append((addon, addon_fact))
    if umbrella is not None and composite is not None:
        # Freshness beats concept preference: a filer that tagged DebtCurrent
        # historically and then stopped must not pin the short side to a stale
        # balance date. Ties go to the umbrella (single cleaner concept).
        if composite[0][1]["end"] > umbrella[1]["end"]:
            return composite
        return [umbrella]
    if umbrella is not None:
        return [umbrella]
    return composite


def _build_total_debt(figures, refusals, facts_by_concept, fetched_at):
    """total_debt = short + long. BOTH sides required, at the SAME instant,
    or the figure is refused (never a one-sided understatement)."""
    long_sel = edgar_concepts.select_latest_annual(
        facts_by_concept, edgar_concepts.LONG_DEBT_CHAIN, "instant"
    )
    short_comps = _short_debt_components(facts_by_concept)
    if short_comps is None or long_sel is None:
        missing = []
        if short_comps is None:
            missing.append(
                "short side (neither %s nor anchor %s tagged)"
                % ("|".join(edgar_concepts.SHORT_DEBT_UMBRELLA_CHAIN),
                   edgar_concepts.SHORT_DEBT_ANCHOR)
            )
        if long_sel is None:
            missing.append(
                "long side (%s absent)" % "|".join(edgar_concepts.LONG_DEBT_CHAIN)
            )
        refusals.append(_refusal(
            "total_debt", "DEBT_COMPONENT_MISSING", "; ".join(missing)
        ))
        return
    long_concept, long_fact = long_sel
    short_end = short_comps[0][1]["end"]
    long_end = long_fact["end"]
    if short_end != long_end:
        refusals.append(_refusal(
            "total_debt", "DEBT_PERIOD_MISMATCH",
            "short side instant %s != long side instant %s — refusing to mix "
            "balance dates" % (short_end, long_end),
        ))
        return
    all_pairs = list(short_comps) + [(long_concept, long_fact)]
    try:
        components = [_component(c, f) for c, f in all_pairs]
    except EdgarFormatError as e:
        code = ("NON_INTEGRAL_MINOR_UNITS"
                if getattr(e, "reason", None) == "non_integral" else "VALUE_FORMAT")
        refusals.append(_refusal("total_debt", code, e.message))
        return
    total_minor = sum(c["value_minor"] for c in components)
    # figure-level provenance rides on the freshest-filed component; every
    # component still carries its own accession above.
    lead = sorted(all_pairs, key=lambda p: (p[1].get("filed") or "", p[1].get("accn") or ""))[-1][1]
    figures["total_debt"] = {
        "value_minor": total_minor,
        "currency": "USD",
        "minor_unit": "cent",
        "fiscal": _fiscal(lead),
        "components": components,
        "provenance": _provenance(
            "us-gaap", "composite(short_term_debt+long_term_debt)", "USD",
            lead, fetched_at,
        ),
    }


def _build_shares(figures, refusals, doc, fetched_at):
    dei = doc.get("facts", {}).get("dei", {})
    facts = None
    concept_used = None
    for concept in edgar_concepts.SHARES_DEI_CHAIN:
        payload = dei.get(concept)
        if isinstance(payload, dict):
            shares_facts = payload.get("units", {}).get("shares")
            if shares_facts:
                facts = shares_facts
                concept_used = concept
                break
    if facts is None:
        refusals.append(_refusal(
            "shares_outstanding", "CONCEPT_ABSENT",
            "no dei shares fact for any of %s" % "|".join(edgar_concepts.SHARES_DEI_CHAIN),
        ))
        return
    fact = edgar_concepts.select_latest_shares(facts)
    if fact is None:
        refusals.append(_refusal(
            "shares_outstanding", "CONCEPT_ABSENT",
            "dei %s present but holds no usable facts" % concept_used,
        ))
        return
    try:
        value = edgar_concepts.shares_to_int(fact["val"])
    except EdgarFormatError as e:
        refusals.append(_refusal("shares_outstanding", "VALUE_FORMAT", e.message))
        return
    figures["shares_outstanding"] = {
        # a COUNT, not currency: no minor-unit conversion applies
        "value": value,
        "unit": "shares",
        "fiscal": _fiscal(fact),
        "provenance": _provenance("dei", concept_used, "shares", fact, fetched_at),
    }


def build_summary_ir(doc, fetched_at):
    # type: (Dict, str) -> Dict
    """companyfacts document -> summary IR.

    Figures that resolve land in `figures`; everything that cannot resolve
    lands in `refusals` with a typed code. ABSENT != ZERO throughout.
    """
    if not isinstance(doc, dict) or "facts" not in doc:
        raise EdgarFormatError("companyfacts document missing 'facts'")
    if "cik" not in doc or "entityName" not in doc:
        raise EdgarFormatError("companyfacts document missing cik/entityName")

    gaap_usd = _usd_facts(doc, "us-gaap")
    figures = {}  # type: Dict[str, Dict]
    refusals = []  # type: List[Dict]

    _select_simple(figures, refusals, "revenue", gaap_usd,
                   edgar_concepts.REVENUE_CHAIN, "duration", fetched_at)
    _select_simple(figures, refusals, "net_income", gaap_usd,
                   edgar_concepts.NET_INCOME_CHAIN, "duration", fetched_at)
    _select_simple(figures, refusals, "total_assets", gaap_usd,
                   edgar_concepts.ASSETS_CHAIN, "instant", fetched_at)
    _select_simple(figures, refusals, "equity", gaap_usd,
                   edgar_concepts.EQUITY_CHAIN, "instant", fetched_at)
    _build_total_debt(figures, refusals, gaap_usd, fetched_at)
    _build_shares(figures, refusals, doc, fetched_at)

    return {
        "entity": {
            "cik": str(int(doc["cik"])).zfill(10),
            "cik_int": int(doc["cik"]),
            "name": doc["entityName"],
        },
        "figures": figures,
        "refusals": refusals,
        "fetched_at": fetched_at,
    }


# ---------------------------------------------------------------------------
# Envelope
# ---------------------------------------------------------------------------


def _fiscal_anchor(figures):
    """Latest ANNUAL period across the monetary FY figures. shares_outstanding
    is excluded: its `end` is a cover date, not a fiscal period end."""
    annual = [
        fig for name, fig in figures.items()
        if name != "shares_outstanding" and fig.get("fiscal", {}).get("fp") == "FY"
    ]
    if not annual:
        return {"latest_fy": None, "latest_annual_end": None}
    lead = sorted(annual, key=lambda f: f["fiscal"]["end"] or "")[-1]
    return {
        "latest_fy": lead["fiscal"]["fy"],
        "latest_annual_end": lead["fiscal"]["end"],
    }


def _anchor_dataset_version(figures, anchor):
    """Envelope-level dataset_version = accession backing the fiscal anchor
    (the annual filing), NOT the freshest filing overall — the cover-page
    shares figure updates every 10-Q and must not relabel the annual dataset."""
    end = anchor.get("latest_annual_end")
    if end is None:
        return None
    candidates = [
        fig["provenance"] for name, fig in figures.items()
        if name != "shares_outstanding" and fig.get("fiscal", {}).get("end") == end
    ]
    if not candidates:
        return None
    return sorted(candidates, key=lambda p: (p.get("filed") or "", p.get("accession") or ""))[-1]["accession"]


def build_envelope(ir, ticker=None):
    # type: (Dict, Optional[str]) -> Dict
    """Wrap the summary IR in the public_market envelope.

    status PUBLIC_MARKET marks the sibling document class: these envelopes
    NEVER enter packs/reconcile/consensus (enforced downstream by the spine;
    asserted here by construction — nothing in this module emits any other
    status)."""
    figures = ir["figures"]
    anchor = _fiscal_anchor(figures)
    entity = dict(ir["entity"])
    entity["ticker"] = ticker.strip().upper() if ticker else None
    entity["source"] = "sec_edgar"
    return {
        "schema_version": SCHEMA_VERSION,
        "doc_class": "public_market",
        "status": "PUBLIC_MARKET",
        "entity": entity,
        "figures": figures,
        "refusals": ir["refusals"],
        "fiscal_anchor": anchor,
        "segments": {
            # Honest unavailability, not silence: companyfacts carries only
            # entity-level facts. Segment breakdowns need a per-filing XBRL
            # parse — out of the "cheap" scope by design.
            "status": "UNAVAILABLE",
            "reason": "segment data is not present in the EDGAR companyfacts "
                      "dataset; requires per-filing XBRL parsing",
        },
        "provenance": {
            "source": SOURCE,
            "fetched_at": ir["fetched_at"],
            "as_of": anchor.get("latest_annual_end"),
            "dataset_version": _anchor_dataset_version(figures, anchor),
            "user_agent": USER_AGENT,
        },
        "meta": {"cached": False, "cache_reason": "not_attempted"},
    }


# ---------------------------------------------------------------------------
# Minimal append-only journal + DLQ (choice documented in module docstring)
# ---------------------------------------------------------------------------


class Journal(object):
    """Append-only jsonl journal. One JSON object per line; records are never
    rewritten (files opened in "a" only). dlq.jsonl is created lazily so a
    clean run leaves no empty DLQ file behind."""

    def __init__(self, dir_path):
        self.dir_path = dir_path
        os.makedirs(dir_path, exist_ok=True)

    def _append(self, filename, record):
        rec = dict(record)
        rec.setdefault("ts", datetime.datetime.now(datetime.timezone.utc).isoformat())
        line = json.dumps(rec, sort_keys=True, separators=(",", ":"))
        with open(os.path.join(self.dir_path, filename), "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def append(self, record):
        self._append("journal.jsonl", record)

    def dead_letter(self, record):
        self._append("dlq.jsonl", record)


class _NullJournal(object):
    def append(self, record):
        pass

    def dead_letter(self, record):
        pass


# ---------------------------------------------------------------------------
# Adapter: on-demand resolve with journaling, DLQ, spine-store caching
# ---------------------------------------------------------------------------


def _discover_store():
    """Guarded discovery of the spine lane's store (documented interface:
    engine.public_market.store.get_store() -> obj with .put(envelope)).
    Returns None when the spine lane has not landed yet."""
    try:
        from engine.public_market import store as spine_store  # noqa: WPS433
    except Exception:
        return None
    getter = getattr(spine_store, "get_store", None)
    if getter is None:
        return None
    try:
        candidate = getter()
    except Exception:
        return None
    if candidate is not None and hasattr(candidate, "put"):
        return candidate
    return None


def _now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class EdgarAdapter(object):
    """ticker -> public_market envelope, journaled, with best-effort caching
    into the spine store.

    Failures are typed and re-raised AFTER being journaled + dead-lettered:
    the caller always sees the real error, and the DLQ always sees the
    payload that produced it.
    """

    def __init__(self, client=None, journal_dir=None, store=None, now_fn=None):
        self.client = client if client is not None else EdgarClient()
        self.journal = Journal(journal_dir) if journal_dir else _NullJournal()
        self._store = store
        self._store_discovery_done = store is not None
        self._now_fn = now_fn if now_fn is not None else _now_iso

    def _get_store(self):
        if not self._store_discovery_done:
            self._store = _discover_store()
            self._store_discovery_done = True
        return self._store

    def resolve(self, ticker):
        # type: (str) -> Dict
        self.journal.append({"event": "ingest_start", "ticker": ticker})
        try:
            cik = resolve_cik(ticker, self.client)
            doc = fetch_companyfacts(cik, self.client)
            ir = build_summary_ir(doc, fetched_at=self._now_fn())
            envelope = build_envelope(ir, ticker=ticker)
        except EdgarError as e:
            self.journal.append({
                "event": "ingest_fail",
                "ticker": ticker,
                "error_code": e.code,
                "detail": e.message,
            })
            self.journal.dead_letter({
                "ticker": ticker,
                "error_code": e.code,
                "detail": e.message,
                "stage": "ingest",
            })
            raise

        store = self._get_store()
        if store is None:
            envelope["meta"] = {"cached": False, "cache_reason": "store_unavailable"}
        else:
            try:
                store.put(envelope)
                envelope["meta"] = {"cached": True, "cache_reason": None}
            except Exception as e:  # cache is best-effort; the envelope is not
                envelope["meta"] = {
                    "cached": False,
                    "cache_reason": "store_error: %s" % (e,),
                }
                self.journal.append({
                    "event": "cache_fail",
                    "ticker": ticker,
                    "detail": str(e),
                })

        self.journal.append({
            "event": "ingest_ok",
            "ticker": ticker,
            "cik": envelope["entity"]["cik"],
            "dataset_version": envelope["provenance"]["dataset_version"],
            "figures": sorted(envelope["figures"].keys()),
            "refusal_count": len(envelope["refusals"]),
            "cached": envelope["meta"]["cached"],
        })
        return envelope
