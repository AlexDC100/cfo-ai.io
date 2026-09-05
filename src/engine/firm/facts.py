"""CLIENT FACTS — the expensive half of the board, computed once per snapshot.

Everything a detector needs from a client's periods is gathered HERE,
through the FactsGateway (the ONE sanctioned reader of served truth),
the company profile and the single-period findings engine — and then
cached on ``(client_id, snapshot_key)``. Detectors are cheap functions
over these facts and an ``as_of`` date; opening the board on a new day
re-runs the cheap half only. That is what FC9 measures.

ABSENT != ZERO. Every accessor read here is Optional: a served envelope
that does not carry a concept yields ``None`` and a stated gap, never a
0.0 a detector could compare against.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Callable, Dict, List, Optional, Tuple

from engine.serving.facts import FactsGateway, MissingFactError

from ._deps import company_profile as CP
from .model import ClientRecord, PeriodRecord

logger = logging.getLogger(__name__)

#: (fact name, FactsGateway accessor) — every served MONEY fact this
#: package reads, in read order. The fact names are the ones an item
#: cites as evidence, so each MUST be declared money in
#: ``engine.api._ratio_units`` — scripts/check_metric_declared.py reads
#: this tuple (as source, never by import) and refuses an undeclared one.
#: ``cash`` is read separately (a sum of served rows) and ``share_capital``
#: is one served row; both are listed so the census sees them.
SERVED_MONEY_FACTS = (
    ("total_assets", "total_assets"),
    ("total_liabilities", "total_liabilities"),
    ("equity", "equity"),
    ("current_liabilities", "current_liabilities"),
    ("working_capital", "working_capital"),
    ("difference", "difference"),
    ("net_result", "net_result"),
    ("revenue", "revenue"),
    ("expenses", "expenses"),
    ("ebitda", "ebitda"),
    ("share_capital", "statement_line:share_capital"),
    ("cash", "statement_line:<cash_row_ids>"),
)

#: Money facts an item may cite that are NOT served by the gateway — a
#: DECLARED covenant limit is the one. Declared in _ratio_units too.
DECLARED_MONEY_FACTS = ("covenant_limit",)


@dataclass(frozen=True)
class MoneyFact:
    """A gateway Fact, carried as the native float plus its provenance."""

    name: str
    value: float
    currency: str
    snapshot_id: Optional[str]
    line_id: Optional[str]


@dataclass(frozen=True)
class PeriodFacts:
    period_id: str
    period_end: str
    period_start: Optional[str]
    currency: str
    snapshot_id: Optional[str]
    tier: Optional[str]
    has_trial_balance: bool
    served_status: Optional[str]
    needs_review: bool
    period_days: Optional[int]
    period_detection: Optional[Dict[str, Any]]
    money: Dict[str, MoneyFact]
    gaps: Dict[str, str]                       # fact name -> why absent
    profile: Optional["CP.CompanyProfile"]
    profile_gap: Optional[str]
    critical_findings: Tuple[Dict[str, Any], ...]
    findings_gap: Optional[str]

    def fact(self, name: str) -> Optional[MoneyFact]:
        return self.money.get(name)


@dataclass(frozen=True)
class ClientFacts:
    client_id: str
    snapshot_key: str
    periods: Tuple[PeriodFacts, ...]           # newest first

    def latest(self) -> Optional[PeriodFacts]:
        for p in self.periods:
            if p.has_trial_balance:
                return p
        return None


# ── The snapshot key ─────────────────────────────────────────────────────


def snapshot_key(client: ClientRecord, pack_fingerprint: str) -> str:
    """Hash of everything the expensive half depends on. Cheap: it reads
    ids and timestamps, never the envelopes themselves."""
    parts = []  # type: List[Any]
    for p in client.periods_desc():
        parts.append([p.period_id, p.period_end, p.period_start, p.updated_at,
                      p.snapshot_id(), p.source_document_id, p.currency, p.caen,
                      bool(p.has_trial_balance())])
    payload = {
        "client_id": client.client_id,
        "periods": parts,
        "cadence_row": client.cadence_row,
        "covenants": [c.to_payload() for c in client.covenants],
        "pack": pack_fingerprint,
    }
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# ── Building the facts of one period ─────────────────────────────────────


def _period_days(period: PeriodRecord,
                 statements: Optional[Dict[str, Any]]) -> Optional[int]:
    if period.period_start and period.period_end:
        try:
            start = date.fromisoformat(str(period.period_start)[:10])
            end = date.fromisoformat(str(period.period_end)[:10])
            days = (end - start).days + 1
            return days if days > 0 else None
        except (TypeError, ValueError):
            pass
    if isinstance(statements, dict):
        sup = statements.get("supplementary") or {}
        raw = sup.get("periodDays") if isinstance(sup, dict) else None
        if isinstance(raw, (int, float)) and not isinstance(raw, bool) and raw > 0:
            return int(raw)
    return None


def _read(gw: FactsGateway, name: str, accessor: Callable[[], Any],
          money: Dict[str, MoneyFact], gaps: Dict[str, str]) -> None:
    try:
        fact = accessor()
    except MissingFactError as exc:
        gaps[name] = str(exc)
        return
    except Exception as exc:  # noqa: BLE001 — a gateway refusal is a gap, not a crash
        gaps[name] = "%s: %s" % (type(exc).__name__, exc)
        return
    if not hasattr(fact, "amount_minor"):
        gaps[name] = "the gateway answered with a refusal (%s)" % type(fact).__name__
        return
    prov = fact.provenance if isinstance(fact.provenance, dict) else {}
    money[name] = MoneyFact(
        name=name, value=fact.to_float(), currency=str(fact.currency or "RON").upper(),
        snapshot_id=prov.get("snapshot_id"), line_id=prov.get("line_id"))


def _read_cash(gw: FactsGateway, row_ids: Tuple[str, ...],
               money: Dict[str, MoneyFact], gaps: Dict[str, str]) -> None:
    """Sum of the served cash rows. Rows absent from THIS statement are
    skipped; a statement with none of them is a refusal, never a zero."""
    total = 0
    found = []  # type: List[str]
    currency = None  # type: Optional[str]
    snapshot = None  # type: Optional[str]
    for row_id in row_ids:
        try:
            fact = gw.statement_line(row_id)
        except MissingFactError:
            continue
        total += int(fact.amount_minor)
        found.append(row_id)
        currency = str(fact.currency or "RON").upper()
        prov = fact.provenance if isinstance(fact.provenance, dict) else {}
        snapshot = prov.get("snapshot_id")
    if not found:
        gaps["cash"] = ("the served statement carries none of the cash rows %r"
                        % (list(row_ids),))
        return
    money["cash"] = MoneyFact(name="cash", value=total / 100.0,
                              currency=currency or "RON", snapshot_id=snapshot,
                              line_id="+".join(found))


def build_period_facts(period: PeriodRecord, cash_row_ids: Tuple[str, ...],
                       catalog: Optional["CP.ProfileCatalog"] = None,
                       run_findings: bool = True) -> PeriodFacts:
    """Read one period through the gateway, build its profile, and run
    the single-period findings engine over its statements (when they are
    available). Statements are loaded lazily HERE — the only place the
    provider is ever called."""
    snapshot_id = period.snapshot_id()
    money = {}  # type: Dict[str, MoneyFact]
    gaps = {}  # type: Dict[str, str]
    tier = None  # type: Optional[str]
    served_status = None  # type: Optional[str]
    needs_review = False
    detection = None  # type: Optional[Dict[str, Any]]

    if period.has_trial_balance():
        try:
            env = period.load_envelope()
        except Exception as exc:  # noqa: BLE001 — a provider failure is a gap WITH ITS CAUSE
            # The route's provider is one PostgREST read per period; a 503
            # on ONE carniprod period was HTTP 500 for the whole board,
            # agras included (critic D7) — this was the one provider its
            # two siblings below (the served reader, the statements
            # provider) wrapped and it did not. One bad period is a gap
            # that names its cause, never the board; the money kinds that
            # need the envelope then record their absence, not a zero.
            logger.exception("[firm] envelope provider raised for %s", period.period_id)
            env = None
            gaps["gateway"] = ("the envelope provider raised for this period: %s: %s"
                               % (type(exc).__name__, exc))
        if env is None:
            env = {}
            gaps.setdefault("gateway", "the period is marked as carrying a trial balance but "
                                       "no envelope could be loaded")
        raw_detection = env.get("period_detection")
        detection = dict(raw_detection) if isinstance(raw_detection, dict) else None
        gw = None  # type: Optional[FactsGateway]
        if env:
            try:
                gw = FactsGateway.from_envelope(env, currency=period.currency)
            except Exception as exc:  # noqa: BLE001 — the served reader raised
                # A gap on THIS period, never a dead board (A1): the reader
                # runs the serve path (engine.api._reconcile), and anything
                # that path cannot load — a registry it once read at import,
                # a malformed envelope — is stated here, per period, with the
                # reason. The client still renders; the money kinds record
                # the absence.
                logger.exception("[firm] served reader raised for %s", period.period_id)
                gaps["gateway"] = ("the served reader raised for this period: %s: %s"
                                   % (type(exc).__name__, exc))
        if gw is None:
            gaps.setdefault("gateway", "the persisted envelope carries neither a "
                                       "canonical_bs nor legacy methodology totals")
        else:
            tier = gw.tier
            served = gw.served_canonical_bs
            if isinstance(served, dict):
                served_status = str(served.get("status") or "") or None
                needs_review = bool(served.get("needs_review"))
            for name, accessor in SERVED_MONEY_FACTS:
                if name == "cash":
                    _read_cash(gw, cash_row_ids, money, gaps)
                elif accessor.startswith("statement_line:"):
                    row_id = accessor.split(":", 1)[1]
                    _read(gw, name, (lambda rid=row_id: gw.statement_line(rid)), money, gaps)
                else:
                    _read(gw, name, getattr(gw, accessor), money, gaps)

    statements = None  # type: Optional[Dict[str, Any]]
    profile = None  # type: Optional[CP.CompanyProfile]
    profile_gap = None  # type: Optional[str]
    criticals = ()  # type: Tuple[Dict[str, Any], ...]
    findings_gap = None  # type: Optional[str]
    if period.has_trial_balance():
        try:
            statements = period.load_statements()
        except Exception as exc:  # noqa: BLE001 — a provider failure is a gap
            # WITH ITS REASON. The route's provider rebuilds statements
            # through engine.api.pipeline (a read that can 503, a rebuild
            # that can raise); "no assembled statements available" would
            # hide that the provider, not the data, is what failed (A1).
            # (pipeline's import graph once read the model registry at
            # import, so a dead registry raised HERE; since D6 that read is
            # lazy and a dead registry is the route's notice instead.)
            logger.exception("[firm] statements provider raised for %s", period.period_id)
            statements = None
            findings_gap = "statements provider raised: %s: %s" % (type(exc).__name__, exc)
            profile_gap = findings_gap
        if not isinstance(statements, dict) or not statements:
            profile_gap = profile_gap or "no assembled statements available for this period"
            findings_gap = findings_gap or profile_gap
        else:
            try:
                profile = CP.build_company_profile(
                    statements, period_id=period.period_id, caen=period.caen,
                    catalog=catalog, snapshot_id=snapshot_id)
            except Exception as exc:  # noqa: BLE001
                logger.exception("[firm] profile build raised for %s", period.period_id)
                profile_gap = "profile build raised: %s: %s" % (type(exc).__name__, exc)
            if run_findings:
                criticals, findings_gap = _critical_findings(
                    statements, period, snapshot_id, catalog)

    return PeriodFacts(
        period_id=period.period_id, period_end=period.period_end,
        period_start=period.period_start, currency=period.currency.upper(),
        snapshot_id=snapshot_id, tier=tier,
        has_trial_balance=period.has_trial_balance(),
        served_status=served_status, needs_review=needs_review,
        period_days=_period_days(period, statements),
        period_detection=detection, money=money, gaps=gaps,
        profile=profile, profile_gap=profile_gap,
        critical_findings=criticals, findings_gap=findings_gap)


def _critical_findings(statements: Dict[str, Any], period: PeriodRecord,
                       snapshot_id: Optional[str],
                       catalog: Optional["CP.ProfileCatalog"]
                       ) -> Tuple[Tuple[Dict[str, Any], ...], Optional[str]]:
    """The surfaced CRITICAL findings of the single-period engine, in its
    own order (severity, then rule key). Lazy import: the findings
    package pulls the whole detector registry."""
    from engine.api.findings import s_engine
    try:
        result = s_engine.run_single_period(
            statements, period_id=period.period_id, caen=period.caen,
            snapshot_id=snapshot_id, catalog=catalog)
    except Exception as exc:  # noqa: BLE001
        logger.exception("[firm] findings engine raised for %s", period.period_id)
        return (), "findings engine raised: %s: %s" % (type(exc).__name__, exc)
    rows = [r for r in result.surfaced() if str(r.get("severity")) == "critical"]
    return tuple(rows), None


def build_client_facts(client: ClientRecord, cash_row_ids: Tuple[str, ...],
                       pack_fingerprint: str,
                       catalog: Optional["CP.ProfileCatalog"] = None,
                       run_findings: bool = True) -> ClientFacts:
    periods = tuple(
        build_period_facts(p, cash_row_ids, catalog=catalog, run_findings=run_findings)
        for p in client.periods_desc())
    return ClientFacts(client_id=client.client_id,
                       snapshot_key=snapshot_key(client, pack_fingerprint),
                       periods=periods)


# ── The cache ────────────────────────────────────────────────────────────


class AttentionCache(object):
    """Per-client facts keyed on (client_id, snapshot_key).

    A hit skips the gateway, the profile and the findings run for that
    client. A change to ANY period of a client changes its snapshot key
    and misses exactly that client — never the other 199. The counters
    are what FC9 reads; they are part of the contract, not debug output.
    """

    def __init__(self, max_entries: int = 4096) -> None:
        self._entries = {}  # type: Dict[Tuple[str, str], ClientFacts]
        self._order = []  # type: List[Tuple[str, str]]
        self.max_entries = int(max_entries)
        self.hits = 0
        self.misses = 0

    def __len__(self) -> int:
        return len(self._entries)

    def reset_counters(self) -> None:
        self.hits = 0
        self.misses = 0

    def clear(self) -> None:
        """Drop every entry and the counters — what a test does to a
        process-level cache before measuring a cold open."""
        self._entries.clear()
        del self._order[:]
        self.reset_counters()

    def facts_for(self, client_id: str) -> Optional[ClientFacts]:
        """The live entry for a client, if any (one per client)."""
        for key in self._order:
            if key[0] == client_id:
                return self._entries.get(key)
        return None

    def get_or_build(self, client: ClientRecord, key: str,
                     builder: Callable[[], ClientFacts]) -> ClientFacts:
        cache_key = (client.client_id, key)
        found = self._entries.get(cache_key)
        if found is not None and found.snapshot_key == key:
            self.hits += 1
            return found
        self.misses += 1
        built = builder()
        # One live entry per client: a stale snapshot must not linger.
        stale = [k for k in self._order if k[0] == client.client_id]
        for k in stale:
            self._entries.pop(k, None)
            self._order.remove(k)
        self._entries[cache_key] = built
        self._order.append(cache_key)
        while len(self._order) > self.max_entries:
            oldest = self._order.pop(0)
            self._entries.pop(oldest, None)
        return built

    def to_payload(self) -> Dict[str, Any]:
        return {"hits": self.hits, "misses": self.misses, "entries": len(self._entries)}


__all__ = [
    "AttentionCache", "ClientFacts", "DECLARED_MONEY_FACTS", "MoneyFact",
    "PeriodFacts", "SERVED_MONEY_FACTS", "build_client_facts",
    "build_period_facts", "snapshot_key",
]
