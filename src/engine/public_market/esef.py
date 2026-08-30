"""ESEF annual reports via filings.xbrl.org — europe lane of the
public_market document class.

WHAT THIS FEED IS
    filings.xbrl.org is XBRL International's public repository of
    Inline XBRL filings (ESEF, UKSEF, UAIFRS programmes). Discovery is
    a JSON:API endpoint (``/api/filings``); each filing exposes the
    tagged data as xBRL-JSON (``json_url``) — a flat ``facts`` map this
    adapter parses for the four core statement figures
    {revenue, profit, assets, equity}.

SOURCE TERMS (recorded verbatim from https://filings.xbrl.org/docs/about,
retrieved 2026-08-29 — also in the fixtures README):
    "Terms of use — At present, there are no restrictions on the ways
    that the data can be used."
    Footer: "© 2021-23 XBRL All Rights Reserved."  Contact: filings@xbrl.org.

HONEST COVERAGE BOUNDARY
    The About page documents that ESEF filings for Germany and Ireland
    are NOT in the repository ("Missing data ... Germany, Ireland").
    Marquee ``DE`` therefore cannot be served from this feed — that gap
    is exported as ``COVERAGE_GAPS`` so serving surfaces state it
    instead of silently showing nothing. Fact extraction is calibrated
    on ONE real filing (S.T. Dupont S.A, FR, FY 2026-03-31 — committed
    real-bytes fixture); the candidate-concept table below is the
    honest extent of tagging variety handled today.

PM LAW (this lane's slice)
    - Deterministic feed: every number here comes from the filing's own
      tagged facts. No AI anywhere in this module.
    - ABSENT != ZERO: an untagged metric is *absent from the bundle*
      (listed in ``bundle.absent``), never 0.0.
    - Fail closed: malformed documents and statement-vs-notes value
      conflicts produce typed refusals / recorded inconsistencies.
    - Provenance {source, accession, as_of, fetched_at} on EVERY figure.
    - PUBLIC_MARKET documents NEVER enter packs/reconcile/consensus —
      this module only builds the sibling-document block; the spine
      owns envelope assembly (see ``to_public_market_block``).

POLITENESS
    Declared User-Agent, https-only, >=1s spacing between requests,
    exponential backoff on 429/5xx. All network entry points accept an
    injectable ``fetch`` so tests never touch the wire.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Callable, Dict, List, Optional, Tuple, Union

from engine.public_market._refusal import Refusal, refuse

# ── service identity ────────────────────────────────────────────────

FILINGS_BASE = "https://filings.xbrl.org"
FILINGS_API = FILINGS_BASE + "/api/filings"

USER_AGENT = "cfo-ai.io engine (contact: ad.crestin@gmail.com)"

SOURCE_NAME = "filings.xbrl.org"

#: Verbatim from https://filings.xbrl.org/docs/about (2026-08-29).
TERMS_OF_USE_LINE = (
    "At present, there are no restrictions on the ways that the data "
    "can be used. (filings.xbrl.org/docs/about, retrieved 2026-08-29)"
)

#: Countries the source itself documents as missing from its ESEF
#: coverage ("Missing data" section of the About page). Serving
#: surfaces must show this as an honest gap, not an empty state.
COVERAGE_GAPS = ("DE", "IE")

# ── sibling-document constants (spine will own the envelope) ────────
# Duplicated here so the adapter is self-describing; if the spine lane
# lands its own constants module these become imports (cross-lane
# merge point, flagged in the lane report).

PUBLIC_MARKET_DOCUMENT_CLASS = "public_market"
PUBLIC_MARKET_STATUS = "PUBLIC_MARKET"

# ── polite HTTP (module-level so tests can monkeypatch) ─────────────

_urlopen = urllib.request.urlopen  # patched in tests; never called keyless
_MIN_REQUEST_INTERVAL_S = 1.0  # one request/second is plenty for annuals
_MAX_ATTEMPTS = 3
_TIMEOUT_S = 60.0
_MAX_DOCUMENT_BYTES = 64 * 1024 * 1024  # xBRL-JSON can be MBs; cap at 64MB

_last_request_monotonic = [0.0]  # single-slot mutable module state


def _polite_fetch(url):
    # type: (str) -> bytes
    """GET with declared UA, spacing and backoff. Raises on failure —
    callers wrap into typed refusals (fail closed at the boundary)."""
    wait = _MIN_REQUEST_INTERVAL_S - (time.monotonic() - _last_request_monotonic[0])
    if wait > 0:
        time.sleep(wait)
    last_error = None  # type: Optional[BaseException]
    for attempt in range(_MAX_ATTEMPTS):
        _last_request_monotonic[0] = time.monotonic()
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with _urlopen(request, timeout=_TIMEOUT_S) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            last_error = exc
            # retry only where the server says "later"; 4xx (other than
            # 429) is a hard no — retrying would be impolite and wrong
            if exc.code != 429 and exc.code < 500:
                raise
        except urllib.error.URLError as exc:
            last_error = exc
        time.sleep(2.0 ** attempt)
    if last_error is not None:
        raise last_error
    raise RuntimeError("unreachable: no attempt made")


def fetch_document(url, fetch=None):
    # type: (str, Optional[Callable[[str], bytes]]) -> Union[bytes, Refusal]
    """Fetch one URL fail-closed. https only — this feed serves plain
    financial data and MUST NOT be downgraded to http in any config."""
    if not url.startswith("https://"):
        return refuse(
            "esef_insecure_url",
            "refusing non-https URL for filings data",
            SOURCE_NAME,
        )
    fetcher = fetch if fetch is not None else _polite_fetch
    try:
        payload = fetcher(url)
    except Exception as exc:  # noqa: BLE001 — boundary: typed refusal, no guess
        return refuse(
            "esef_http_error",
            "fetch failed after retries: %s" % exc.__class__.__name__,
            SOURCE_NAME,
        )
    if len(payload) > _MAX_DOCUMENT_BYTES:
        return refuse(
            "esef_document_too_large",
            "document exceeds %d bytes" % _MAX_DOCUMENT_BYTES,
            SOURCE_NAME,
        )
    return payload


# ── discovery: /api/filings (JSON:API) ──────────────────────────────


@dataclass(frozen=True)
class EsefFiling:
    """One row of the filings index, verbatim strings — no reformatting
    of what the wire said (dates stay as served)."""

    fxo_id: str  # e.g. "969500YT2CGGAD8YNM04-2026-03-31-ESEF-FR-0"
    entity_identifier: str  # LEI for ESEF; scheme-prefixed ids elsewhere
    country: str
    period_end: str
    date_added: str
    json_url: str  # absolutized
    report_url: Optional[str]
    viewer_url: Optional[str]
    package_url: Optional[str]  # the wire serves null for some rows
    sha256: str
    error_count: int
    warning_count: int


def build_filings_query_url(country=None, page_size=10, sort="-date_added"):
    # type: (Optional[str], int, str) -> str
    """Pure builder for the JSON:API query (Flask-REST-JSONAPI filter
    dialect, verified live 2026-08-29)."""
    params = [("page[size]", str(page_size)), ("sort", sort)]
    if country is not None:
        params.append(
            ("filter", json.dumps([{"name": "country", "op": "eq", "val": country}]))
        )
    return FILINGS_API + "?" + urllib.parse.urlencode(params)


def _absolutize(path):
    # type: (Optional[str]) -> Optional[str]
    if path is None:
        return None
    if path.startswith("https://"):
        return path
    return FILINGS_BASE + path


def _entity_identifier_from_paths(attributes):
    # type: (dict) -> Optional[str]
    """The index nests the entity id as the first path segment of every
    per-filing URL (json_url is always present in observed responses).
    The attributes block itself carries no LEI field — deriving from the
    path is the stable option and matches fxo_id's prefix."""
    for key in ("json_url", "report_url", "package_url"):
        value = attributes.get(key)
        if isinstance(value, str) and value.startswith("/"):
            segments = value.split("/")
            if len(segments) > 1 and segments[1]:
                return segments[1]
    return None


def parse_filings_response(payload):
    # type: (Union[bytes, str, dict]) -> Union[List[EsefFiling], Refusal]
    """Parse one JSON:API page into typed filings. Fail closed on any
    shape surprise — a half-parsed index row would silently drop
    filings from discovery."""
    if isinstance(payload, (bytes, str)):
        try:
            document = json.loads(payload)
        except ValueError:
            return refuse(
                "esef_index_malformed",
                "filings index response is not JSON",
                SOURCE_NAME,
            )
    else:
        document = payload
    if not isinstance(document, dict) or not isinstance(document.get("data"), list):
        return refuse(
            "esef_index_malformed",
            "filings index response has no JSON:API data list",
            SOURCE_NAME,
        )
    filings = []  # type: List[EsefFiling]
    for item in document["data"]:
        if not isinstance(item, dict) or item.get("type") != "filing":
            continue  # foreign resource types in a mixed page are not ours
        attributes = item.get("attributes")
        if not isinstance(attributes, dict):
            return refuse(
                "esef_index_malformed",
                "filing row without attributes",
                SOURCE_NAME,
            )
        entity_identifier = _entity_identifier_from_paths(attributes)
        fxo_id = attributes.get("fxo_id")
        json_url = _absolutize(attributes.get("json_url"))
        if not fxo_id or not entity_identifier or not json_url:
            return refuse(
                "esef_index_malformed",
                "filing row missing fxo_id / entity path / json_url",
                SOURCE_NAME,
            )
        filings.append(
            EsefFiling(
                fxo_id=str(fxo_id),
                entity_identifier=entity_identifier,
                country=str(attributes.get("country") or ""),
                period_end=str(attributes.get("period_end") or ""),
                date_added=str(attributes.get("date_added") or ""),
                json_url=json_url,
                report_url=_absolutize(attributes.get("report_url")),
                viewer_url=_absolutize(attributes.get("viewer_url")),
                package_url=_absolutize(attributes.get("package_url")),
                sha256=str(attributes.get("sha256") or ""),
                error_count=int(attributes.get("error_count") or 0),
                warning_count=int(attributes.get("warning_count") or 0),
            )
        )
    return filings


def discover_filings(country=None, page_size=10, fetch=None):
    # type: (Optional[str], int, Optional[Callable[[str], bytes]]) -> Union[List[EsefFiling], Refusal]
    payload = fetch_document(build_filings_query_url(country, page_size), fetch=fetch)
    if isinstance(payload, Refusal):
        return payload
    return parse_filings_response(payload)


# ── fact extraction: xBRL-JSON → core figures ───────────────────────

#: Candidate concepts per metric, in preference order. Calibrated on
#: real filings — S.T. Dupont tags revenue ONLY as
#: RevenueFromContractsWithCustomers (no bare ifrs-full:Revenue fact).
#: Extending this table is how coverage grows; extending it without a
#: real filing that needs the new concept is how idealized-fixture
#: bugs happen. Real bytes first.
CORE_CONCEPTS = {
    "revenue": (
        "ifrs-full:Revenue",
        "ifrs-full:RevenueFromContractsWithCustomers",
    ),
    "profit": ("ifrs-full:ProfitLoss",),
    "assets": ("ifrs-full:Assets",),
    "equity": ("ifrs-full:Equity",),
}  # type: Dict[str, Tuple[str, ...]]

#: The four base OIM dimensions of an undimensioned (consolidated)
#: fact. Any EXTRA key means a member/segment breakdown — those never
#: feed a consolidated figure.
_BASE_DIMENSIONS = frozenset(["concept", "entity", "period", "unit"])

_XBRL_JSON_MARKER = "xbrl-json"


def derive_period(period):
    # type: (str) -> Tuple[Optional[str], str]
    """(period_start, as_of) from an xBRL-JSON period string.

    xBRL instant semantics: "2026-04-01T00:00:00" is the *moment the
    day starts*, i.e. the balance as of end of 2026-03-31 — so a
    midnight instant is shifted back one day for ``as_of``. Durations
    ("start/end") derive as_of from the end the same way. A non-ISO
    period raises ValueError (callers treat the fact as unusable).
    """

    def _shift(stamp):
        # type: (str) -> str
        moment = datetime.fromisoformat(stamp)
        if (moment.hour, moment.minute, moment.second) == (0, 0, 0):
            return (moment - timedelta(days=1)).date().isoformat()
        return moment.date().isoformat()

    if "/" in period:
        start_raw, end_raw = period.split("/", 1)
        return datetime.fromisoformat(start_raw).date().isoformat(), _shift(end_raw)
    return None, _shift(period)


@dataclass(frozen=True)
class EsefFigure:
    """One extracted statement figure with provenance on the figure
    itself — a figure without provenance must be unconstructible."""

    metric: str
    value: float
    currency: str  # ISO 4217 from the fact's unit
    concept: str  # the exact taxonomy concept that supplied the value
    period_start: Optional[str]
    as_of: str
    provenance: Dict[str, object]


@dataclass(frozen=True)
class EsefFactBundle:
    """Extraction result. ``absent`` is first-class: ABSENT != ZERO,
    and serving must SHOW the absence rather than invent a value.
    ``inconsistent`` records metrics dropped because duplicate tags of
    the same concept/period disagreed (fail closed, per figure)."""

    figures: Dict[str, EsefFigure]
    absent: Tuple[str, ...]
    inconsistent: Dict[str, str]


def _clean_facts_for_concept(facts, concept):
    # type: (dict, str) -> List[Tuple[str, float, str]]
    """All undimensioned monetary facts of one concept as
    (period, value, currency). Non-numeric values poison the concept
    (ValueError propagates to the caller's dirty-mark)."""
    rows = []  # type: List[Tuple[str, float, str]]
    for fact in facts.values():
        if not isinstance(fact, dict):
            continue
        dimensions = fact.get("dimensions")
        if not isinstance(dimensions, dict):
            continue
        if dimensions.get("concept") != concept:
            continue
        if not _BASE_DIMENSIONS.issuperset(dimensions.keys()):
            continue  # segment/member fact — never the consolidated figure
        unit = dimensions.get("unit")
        if not isinstance(unit, str) or not unit.startswith("iso4217:"):
            continue  # per-share / share-count units are other metrics
        period = dimensions.get("period")
        if not isinstance(period, str) or not period:
            continue
        value = float(fact.get("value"))  # ValueError → concept dirty
        rows.append((period, value, unit.split(":", 1)[1]))
    return rows


def extract_core_facts(document, filing, fetched_at):
    # type: (dict, Optional[EsefFiling], str) -> Union[EsefFactBundle, Refusal]
    """Parse one xBRL-JSON document into the four core figures.

    Pure — no I/O. ``fetched_at`` is REQUIRED (no default): provenance
    without a fetch stamp is not provenance, and making the caller
    supply it keeps fixture-driven tests deterministic.

    Selection per metric: first candidate concept that yields a clean
    value for the LATEST period. "Clean" means every duplicate tag of
    that concept in that period agrees exactly (xBRL-JSON serves
    canonical value strings, so exact float equality is the correct
    comparison — a tolerance would hide statement-vs-notes conflicts).
    """
    if not isinstance(document, dict) or not isinstance(document.get("facts"), dict):
        return refuse(
            "esef_document_malformed",
            "xBRL-JSON document has no facts map",
            SOURCE_NAME,
        )
    document_info = document.get("documentInfo")
    document_type = (
        document_info.get("documentType") if isinstance(document_info, dict) else None
    )
    if not isinstance(document_type, str) or _XBRL_JSON_MARKER not in document_type:
        return refuse(
            "esef_document_type_unsupported",
            "documentInfo.documentType is not an xbrl-json type",
            SOURCE_NAME,
        )

    facts = document["facts"]
    figures = {}  # type: Dict[str, EsefFigure]
    inconsistent = {}  # type: Dict[str, str]

    for metric, candidates in CORE_CONCEPTS.items():
        for concept in candidates:
            try:
                rows = _clean_facts_for_concept(facts, concept)
            except (TypeError, ValueError):
                inconsistent[metric] = "%s: non-numeric value" % concept
                continue
            if not rows:
                continue
            # latest period: order by derived (as_of, period_start) so
            # instants and durations compare on the date that matters
            def _order_key(row):
                # type: (Tuple[str, float, str]) -> Tuple[str, str]
                start, as_of = derive_period(row[0])
                return (as_of, start or "")

            try:
                latest_period = max(rows, key=_order_key)[0]
            except ValueError:
                inconsistent[metric] = "%s: unparseable period" % concept
                continue
            chosen = [row for row in rows if row[0] == latest_period]
            values = set(row[1] for row in chosen)
            currencies = set(row[2] for row in chosen)
            if len(values) != 1 or len(currencies) != 1:
                # duplicate tags disagree → this concept cannot be
                # trusted for this filing. Fail closed, keep looking.
                inconsistent[metric] = (
                    "%s: %d conflicting values in period %s"
                    % (concept, len(values), latest_period)
                )
                continue
            period_start, as_of = derive_period(latest_period)
            figures[metric] = EsefFigure(
                metric=metric,
                value=values.pop(),
                currency=currencies.pop(),
                concept=concept,
                period_start=period_start,
                as_of=as_of,
                provenance={
                    "source": SOURCE_NAME,
                    "accession": filing.fxo_id if filing is not None else None,
                    "sha256": filing.sha256 if filing is not None else None,
                    "as_of": as_of,
                    "fetched_at": fetched_at,
                },
            )
            if metric in inconsistent:
                del inconsistent[metric]  # a later candidate recovered it
            break

    absent = tuple(sorted(metric for metric in CORE_CONCEPTS if metric not in figures))
    return EsefFactBundle(figures=figures, absent=absent, inconsistent=inconsistent)


# ── sibling-document block (the spine assembles the envelope) ───────


def to_public_market_block(bundle, filing):
    # type: (EsefFactBundle, EsefFiling) -> Dict[str, object]
    """The public_market document block for one filing — a SIBLING of
    public_summary. This dict NEVER enters packs / reconcile /
    consensus; the spine mounts it under its own key with status
    PUBLIC_MARKET (parallel presentation status, same law as ps1's
    PUBLIC_SUMMARY — never a MACHINE_STATUSES member)."""
    statement_facts = {}  # type: Dict[str, object]
    for metric, figure in bundle.figures.items():
        statement_facts[metric] = {
            "value": figure.value,
            "currency": figure.currency,
            "concept": figure.concept,
            "period_start": figure.period_start,
            "as_of": figure.as_of,
            "provenance": dict(figure.provenance),
        }
    return {
        "document_class": PUBLIC_MARKET_DOCUMENT_CLASS,
        "status": PUBLIC_MARKET_STATUS,
        "market": filing.country,
        "entity_identifier": filing.entity_identifier,
        "period_end": filing.period_end,
        "statement_facts": statement_facts,
        "absent": list(bundle.absent),
        "inconsistent": dict(bundle.inconsistent),
        "source_terms": TERMS_OF_USE_LINE,
    }


def fetch_annual_facts(filing, fetch=None, now=None):
    # type: (EsefFiling, Optional[Callable[[str], bytes]], Optional[Callable[[], str]]) -> Union[Dict[str, object], Refusal]
    """Full arc for one filing: download xBRL-JSON, extract, build the
    sibling-document block. ``now`` is injectable for determinism."""
    payload = fetch_document(filing.json_url, fetch=fetch)
    if isinstance(payload, Refusal):
        return payload
    try:
        document = json.loads(payload)
    except ValueError:
        return refuse(
            "esef_document_malformed",
            "xBRL-JSON payload is not valid JSON",
            SOURCE_NAME,
        )
    fetched_at = now() if now is not None else _utc_now_iso()
    bundle = extract_core_facts(document, filing=filing, fetched_at=fetched_at)
    if isinstance(bundle, Refusal):
        return bundle
    return to_public_market_block(bundle, filing=filing)


def _utc_now_iso():
    # type: () -> str
    from datetime import timezone

    return datetime.now(timezone.utc).isoformat(timespec="seconds")
