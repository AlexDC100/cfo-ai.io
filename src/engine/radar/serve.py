"""RADAR — one source for every findings surface.

The findings engine (``engine.api.findings``) detects and quantifies;
the ranker (``engine.api._finding_rank``) judges materiality, merges,
ranks and applies dismissals; the cap (``engine.radar.cap``) holds the
ceiling. None of that is here. This module COMPOSES them, once, into the
payload every findings surface renders — the Statements page, the
Capsule's ``list_findings`` tool and the Firm Cockpit's RADAR_FLAG
detector are all readers of what :func:`serve_period` returns.

WHAT THIS MODULE GUARANTEES

  ONE SOURCE      the rows are ``Finding.to_payload()`` from the same
                  engine run the Capsule tool performs, byte-identical
                  (gate R1). Radar adds rank, materiality, dismissal, cap,
                  group and provenance fields AROUND a row; it never
                  edits one.
  DETERMINISTIC   same snapshot, same dismissals, same pack -> same
                  bytes, every run, whether or not an AI SDK is
                  importable (gate R4). This module imports no model
                  client and reads no clock. The explanation lane
                  (``engine.radar.explain``) is the ONE writer of
                  ``row["explanation"]``; it is wired by the route AFTER
                  the rows exist, and :func:`strip_explanations` recovers
                  the deterministic bytes from an explained payload.
  MATERIALITY     assessed by the ranker's own policy against the
                  company's OWN total assets — served through the
                  FactsGateway when the period carries an envelope,
                  else the statements' total. The amount at stake is the
                  largest money figure the finding ITSELF cites, other
                  than the company totals it compares against. ABSENT
                  is not ZERO: no basis, no verdict — the finding is
                  recorded as "fired but not ranked" with the reason.
  PROVENANCE      every money figure a single-period row cites is
                  checked against the FactsGateway accessor that serves
                  it. Verified figures are what Radar itself CITES
                  (``facts_provenance.cited``); a figure with no accessor
                  is WITHHELD from Radar's citation with the reason and
                  the row says so; a figure that CONTRADICTS the gateway
                  refuses the whole row — it is a check row with the
                  reason, never a served number (SILENCE IS VALID). The
                  engine's own row, prose included, stays byte-identical
                  to the Capsule's; Radar's citation is the strict side.
  THE CAP         applied by ``engine.radar.cap`` below Critical, where
                  Critical is a property of the GROUP (primary or any
                  merged contributor); a held finding is demoted with
                  its reason on the checks list, never dropped (gate R2).
  DISMISSAL       scoped ``_finding_rank.Dismissal`` objects, supplied by
                  the caller from storage, anchored on a period id (the
                  route resolves the ordinal). A dismissed Critical stays
                  surfaced and flagged, with the reason — and so does a
                  non-Critical primary whose group carries a Critical
                  (gate R3).
  INCREMENTAL     :class:`RadarCache` keys on (org, period, snapshot
                  hash of every period on the spine, dismissal set hash,
                  cap, policy, catalogue version); opening a period whose
                  inputs did not change never recomputes.
  SILENCE         a period with nothing material answers with what was
                  checked, in the engine's own silence shape.
  MARKER          every payload and every row carries ``source: "radar"``
                  so a surface can prove which source it rendered; the
                  legacy ``alerts`` rows carry none.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import copy
import hashlib
import json
from collections import OrderedDict
from dataclasses import dataclass, replace
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from engine.api import _company_profile as CP
from engine.api import _finding as F
from engine.api import _finding_rank as R
from engine.api import _ratio_units
from engine.api.findings import m_engine
from engine.api.findings import m_series
from engine.api.findings import s_engine
from engine.serving import Fact, FactsGateway, MissingFactError

from . import cap as CAP

#: Payload contract version. Bumped to ``radar2`` when the payload grew
#: ``provenance`` / ``facts_provenance`` / ``group_severity`` and
#: ``snapshot_id`` became the envelope's content hash (the id the
#: FactsGateway stamps on every fact) with ``source_document_id`` under
#: its own name. ``frontend/lib/findings.ts`` renders the ranked-report
#: shape; every key added here is additive.
RADAR_VERSION = "radar2"

#: The marker a surface asserts on. Legacy ``/api/period`` alert rows
#: carry no ``source`` key at all, which is the whole point of it.
SOURCE = "radar"

LANE_SINGLE = "single_period"
LANE_MULTI = "multi_period"
#: The pack-declared detector families (`engine.radar.detectors`), read
#: over the `engine.radar.series` spine. A THIRD lane beside the two
#: engines above, ranked and capped by the same machinery — a finding is
#: a finding whatever produced it, and giving this one its own ranker
#: would be two policies about what a reader sees.
LANE_DETECTORS = "detectors"

#: Company totals a finding compares AGAINST. They are excluded when the
#: amount at stake is read off the finding's own figures, so a finding
#: about 0.3% of the balance sheet cannot cite the balance sheet and
#: call itself material.
BASIS_TOTALS = frozenset([
    "total_assets", "total_liabilities", "total_equity",
    "equity_plus_liabilities", "revenue",
])

MATERIALITY_BASIS_ID = "total_assets"
MATERIALITY_BASIS_LABEL = "total assets"
BASIS_SOURCE_GATEWAY = "facts_gateway"
BASIS_SOURCE_STATEMENTS = "statements"
BASIS_SOURCE_NONE = "absent"

#: Prior periods considered for persistence and the multi-period spine.
DEFAULT_HISTORY_DEPTH = 12

#: Fact name a detector cites -> the FactsGateway accessor that serves
#: the same figure, and its arguments. A REGISTRY, not a guess: every
#: entry was measured to the cent against the served canonical_bs of
#: every corpus book (design_review/radar/SERVE_GATES.md, B3). A money
#: fact that is not here has NO accessor and is withheld from Radar's
#: own citation until one lands in ``engine.serving.facts`` — the
#: composition is never re-derived here from statement rows.
FACT_ACCESSORS = {
    "total_assets": ("total_assets", ()),
    "total_liabilities": ("total_liabilities", ()),
    "total_equity": ("equity", ()),
    "equity": ("equity", ()),
    "equity_plus_liabilities": ("equity_plus_liabilities", ()),
    "cur_assets": ("current_assets", ()),
    "current_assets": ("current_assets", ()),
    "cur_liab": ("current_liabilities", ()),
    "current_liabilities": ("current_liabilities", ()),
    "working_capital": ("working_capital", ()),
    "revenue": ("revenue", ()),
    "net_income": ("net_result", ()),
    "net_result": ("net_result", ()),
    "ebitda_statutory": ("ebitda", ()),
    "ebitda": ("ebitda", ()),
    "fx_cash": ("statement_line", ("cash_fx",)),
    "intercompany_loans": ("statement_line", ("ar_intercompany",)),
    "revaluation_reserves": ("statement_line", ("revaluation_reserves",)),
}  # type: Dict[str, Tuple[str, Tuple[str, ...]]]

PROVENANCE_VERIFIED = "verified"
PROVENANCE_WITHHELD = "withheld"
PROVENANCE_CONFLICT = "conflict"
PROVENANCE_UNVERIFIED = "unverified"

PROVENANCE_RULE = (
    "every money figure a single-period row cites is checked against the "
    "FactsGateway accessor that serves it; Radar cites the verified ones, "
    "withholds the ones no accessor resolves (the reason is on the row), "
    "and refuses a row whose figure contradicts the gateway")


# ── Inputs ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PeriodInput:
    """One period as the route hands it over: identity, its place on the
    spine, and (when loaded) its rebuilt statements and persisted
    envelope. ``statements is None`` is a GAP — the period exists and
    carries nothing to detect on — and it is never treated as a clean
    book.

    ``snapshot_id`` is the envelope's CONTENT HASH — the id the
    FactsGateway stamps on every fact, so a row's figure can be joined
    to its gateway fact by the id printed on the row.
    ``source_document_id`` is the upload, under its own name. The
    detectors are handed the source document id (:meth:`engine_snapshot_id`)
    because that is what the Capsule's context builder hands them, and
    R1 holds the two byte-identical; the hand-off to move both to the
    content hash is in SERVE_GATES.md.
    """

    period_id: str
    label: str
    period_end: str
    ordinal: int
    currency: str = "RON"
    period_start: Optional[str] = None
    statements: Optional[Dict[str, Any]] = None
    envelope: Optional[Dict[str, Any]] = None
    snapshot_id: Optional[str] = None
    source_document_id: Optional[str] = None
    caen: Optional[str] = None
    #: What identifies the period's DATA for the cache key — the
    #: envelope's content hash when the route listed it light, so a key
    #: can be formed BEFORE anything heavy is loaded. When absent,
    #: :func:`snapshot_key` derives it from what the input carries.
    content_key: Optional[str] = None
    #: `statement_line_items` rows, when the route loaded them. The ONLY
    #: account-level figure a persisted period carries, and what the
    #: detector lane's SERVED-tier spine is built from. None means the
    #: route did not load them — which is a different fact from "this
    #: period has no accounts", and the lane says which.
    line_items: Optional[Sequence[Dict[str, Any]]] = None
    #: The company's CUI. A series cannot span two companies, and the
    #: spine refuses to build without an identity to check against.
    cui: Optional[str] = None

    def has_line_items(self) -> bool:
        return bool(self.line_items)

    def has_statements(self) -> bool:
        return isinstance(self.statements, dict) and bool(self.statements)

    def engine_snapshot_id(self) -> Optional[str]:
        """What the detectors stamp on ``evidence.provenance.snapshot_id``
        — the Capsule's convention (the source document), so the two
        surfaces' rows stay byte-identical (R1)."""
        return self.source_document_id or self.snapshot_id

    def content_hash(self) -> Optional[str]:
        """The envelope's content hash, from wherever the input carries
        it: the light listing's alias, the envelope's own provenance, or
        ``snapshot_id`` when the caller set it to the hash."""
        if self.content_key:
            return str(self.content_key)
        envelope = self.envelope if isinstance(self.envelope, dict) else {}
        provenance = envelope.get("provenance") or {}
        if isinstance(provenance, dict) and provenance.get("content_hash"):
            return str(provenance["content_hash"])
        return self.snapshot_id


@dataclass(frozen=True)
class RadarRequest:
    org_id: str
    target: PeriodInput
    history: Tuple[PeriodInput, ...] = ()
    dismissals: Tuple[R.Dismissal, ...] = ()
    cap_policy: Optional[CAP.CapPolicy] = None
    materiality_policy: Optional[R.MaterialityPolicy] = None
    history_depth: int = DEFAULT_HISTORY_DEPTH
    #: Run the pack-declared detector families. OFF by default and
    #: carried on the REQUEST rather than read from the environment
    #: inside `compose`, for two reasons: `compose` is pure over its
    #: request and reading an env var inside it would end that, and the
    #: flag has to reach `cache_key` or a flip would serve the previous
    #: answer from cache. The route reads the environment; this lane
    #: never does.
    detectors_enabled: bool = False
    #: The jurisdiction whose pack declares the detectors, and where the
    #: packs live. Both are data, never a constant in this module — see
    #: the N7 jurisdiction-blindness guard.
    detector_jurisdiction: Optional[str] = None
    detector_pack_root: Optional[str] = None

    def prior_periods(self) -> Tuple[PeriodInput, ...]:
        """Periods BEFORE the target on the spine, nearest first, at most
        ``history_depth`` of them. Later periods are never part of an
        older period's history."""
        prior = [p for p in self.history if p.ordinal < self.target.ordinal
                 and p.period_id != self.target.period_id]
        prior.sort(key=lambda p: (-p.ordinal, p.period_id))
        return tuple(prior[:max(0, int(self.history_depth))])


# ── Snapshot identity and the cache ──────────────────────────────────────


def snapshot_key(period: PeriodInput) -> str:
    """What identifies the period's DATA. The envelope's content hash
    when there is one (the ingest-time IR hash the gateway stamps on
    every fact), else the source document, else a digest of the
    statements themselves — never a timestamp, so a rewrite of the same
    bytes is the same snapshot. A route that listed the period light
    hands the same content hash over as ``content_key``."""
    if period.content_key:
        return "content:%s" % period.content_key
    envelope = period.envelope if isinstance(period.envelope, dict) else {}
    provenance = envelope.get("provenance") or {}
    if isinstance(provenance, dict):
        for key in ("content_hash", "source_document_id"):
            value = provenance.get(key)
            if value:
                return "%s:%s" % (key, value)
    if period.snapshot_id:
        return "snapshot:%s" % period.snapshot_id
    if period.source_document_id:
        return "document:%s" % period.source_document_id
    if period.has_statements():
        return "statements:" + _digest(period.statements)
    return "absent"


def dismissal_set_key(dismissals: Sequence[R.Dismissal]) -> str:
    rows = sorted(json.dumps(d.to_payload(), sort_keys=True, ensure_ascii=False)
                  for d in dismissals)
    return _digest(rows)


#: (path, mtime_ns) -> MaterialityPolicy. The ranker re-parses the pack
#: on every `from_pack()`; the warm path reads it on every open, so it
#: is memoised here the way the catalogue and the cap policy are.
_MATERIALITY_CACHE = {}  # type: Dict[Tuple[str, int], R.MaterialityPolicy]


def materiality_policy() -> R.MaterialityPolicy:
    target = str(CP.DEFAULT_PROFILES_PATH)
    try:
        import os
        stamp = os.stat(target).st_mtime_ns
    except OSError:
        return R.MaterialityPolicy.from_pack()
    cached = _MATERIALITY_CACHE.get((target, stamp))
    if cached is None:
        cached = R.MaterialityPolicy.from_pack()
        _MATERIALITY_CACHE[(target, stamp)] = cached
    return cached


def cache_key(request: RadarRequest) -> str:
    """(org, period, every snapshot on the spine, the dismissal set, the
    cap, the materiality policy, the catalogue, the contract version).

    The snapshot is the envelope's CONTENT HASH — a digest over the
    whole persisted envelope, the ``p121`` cross-check included — so the
    account-121 anchor the route's light listing now carries needs no
    separate key material: an envelope rewritten with a different
    anchor is a different hash. The dismissal set carries every
    dismissal's RESOLVED ``from_period_ordinal``, so a period added
    earlier on the spine (which moves every ordinal) is a new key and a
    recompute, never a stale hit."""
    catalog = CP.load_catalog()
    cap_policy = request.cap_policy or CAP.CapPolicy.from_pack()
    mpolicy = request.materiality_policy or materiality_policy()
    spine = [(p.period_id, p.ordinal, snapshot_key(p))
             for p in sorted(request.prior_periods(),
                             key=lambda p: (p.ordinal, p.period_id))]
    material = {
        "version": RADAR_VERSION,
        "org_id": request.org_id,
        "period_id": request.target.period_id,
        "ordinal": request.target.ordinal,
        "snapshot": snapshot_key(request.target),
        "caen": request.target.caen,
        "spine": spine,
        "dismissals": dismissal_set_key(request.dismissals),
        "cap": cap_policy.to_payload(),
        "materiality": {"floors": mpolicy.floors,
                        "info_fraction": mpolicy.info_fraction,
                        "source": mpolicy.source},
        "catalog": {"version": catalog.version, "origin": catalog.origin},
        # A flag flip is a different answer, so it is different key
        # material. Without this, turning the lane on would serve the
        # pre-flag payload out of cache for the life of the process.
        "detectors": {
            "enabled": bool(request.detectors_enabled),
            "jurisdiction": request.detector_jurisdiction,
            "pack_root": request.detector_pack_root,
        },
    }
    return _digest(material)


class RadarCache(object):
    """Bounded, in-process, keyed on :func:`cache_key`. Entries are held
    as their JSON bytes and a hit is parsed back, so a caller can never
    mutate the cached payload and a hit costs a parse rather than a
    deep copy (measured: ~4x cheaper on a 36 KB payload). Beside the
    bytes, an entry may hold SIDE material — the ranked rows, profile
    and gateway the explanation lane projects its subjects from — kept
    by reference and evicted with the entry. The counters are part of
    the contract: the incremental gate reads them."""

    def __init__(self, max_entries: int = 2048) -> None:
        self._entries = OrderedDict()  # type: OrderedDict
        self._side = {}  # type: Dict[str, Any]
        self.max_entries = int(max_entries)
        self.hits = 0
        self.misses = 0

    def __len__(self) -> int:
        return len(self._entries)

    def reset_counters(self) -> None:
        self.hits = 0
        self.misses = 0

    def get_or_build_with(self, key: str,
                          builder: Callable[[], "Served"]
                          ) -> Tuple[Dict[str, Any], "Served"]:
        """The payload (a fresh parse of the cached bytes) and the side
        material the builder produced for it."""
        found = self._entries.get(key)
        if found is not None:
            self.hits += 1
            self._entries.move_to_end(key)
            return json.loads(found), self._side[key]
        self.misses += 1
        built = builder()
        self._entries[key] = json.dumps(built.payload, ensure_ascii=False)
        self._side[key] = built
        while len(self._entries) > self.max_entries:
            evicted, _ = self._entries.popitem(last=False)
            self._side.pop(evicted, None)
        return json.loads(self._entries[key]), built

    def get_or_build(self, key: str,
                     builder: Callable[[], Dict[str, Any]]) -> Dict[str, Any]:
        """Payload only. ``builder`` returns a payload; it is wrapped as
        a :class:`Served` with no side material."""
        def _wrap() -> "Served":
            return Served(payload=builder(), surfaced=(), profile=None,
                          gateway=None, snapshot_hash="")
        payload, _side = self.get_or_build_with(key, _wrap)
        return payload

    def invalidate(self, key: str) -> None:
        self._entries.pop(key, None)
        self._side.pop(key, None)

    def stats(self) -> Dict[str, int]:
        return {"hits": self.hits, "misses": self.misses,
                "entries": len(self._entries)}


def serve_cached(request: RadarRequest, cache: RadarCache) -> Dict[str, Any]:
    key = cache_key(request)
    payload, _side = cache.get_or_build_with(key, lambda: compose(request))
    payload["cache"] = {"key": key, "hits": cache.hits, "misses": cache.misses}
    return payload


# ── The served gateway and the materiality basis ─────────────────────────


def gateway_for(period: PeriodInput) -> Optional[FactsGateway]:
    """The FactsGateway over the period's persisted envelope — the ONE
    sanctioned reader of served figures. None when the period carries
    no envelope, an unreadable one, or one that is not a canonical
    serving (a public summary is never served as BS truth here)."""
    envelope = period.envelope if isinstance(period.envelope, dict) else None
    if envelope is None:
        return None
    try:
        gateway = FactsGateway.from_envelope(envelope, currency=period.currency)
    except Exception:  # noqa: BLE001 — an unreadable envelope is a gap
        return None
    if gateway is None or gateway.tier != FactsGateway.TIER_CANONICAL:
        return None
    return gateway


@dataclass(frozen=True)
class Basis:
    value: Optional[float]
    source: str
    detail: str

    def to_payload(self) -> Dict[str, Any]:
        return {"id": MATERIALITY_BASIS_ID, "label": MATERIALITY_BASIS_LABEL,
                "value": self.value, "source": self.source, "detail": self.detail}


def resolve_basis(period: PeriodInput, profile: "CP.CompanyProfile",
                  gateway: Optional[FactsGateway] = None) -> Basis:
    """Total assets, served. When the period carries an envelope the
    basis is the gateway's adjusted total — exactly what /api/period
    serves. Without an envelope the statements' own total (the figure
    the profile was built from) is used and the payload says so. Neither
    present -> ABSENT, and materiality refuses rather than defaults."""
    if gateway is None and period.envelope is not None:
        gateway = gateway_for(period)
    if gateway is not None:
        try:
            fact = gateway.total_assets()
        except Exception:  # noqa: BLE001 — MissingFactError and kin
            fact = None
        if fact is not None and fact.amount_minor != 0:
            return Basis(value=fact.to_float(), source=BASIS_SOURCE_GATEWAY,
                         detail="FactsGateway.total_assets() over the "
                                "persisted assembled_canonical_v1 envelope")
    figure = profile.figures.get(MATERIALITY_BASIS_ID)
    if figure is not None and float(figure) != 0.0:
        return Basis(value=float(figure), source=BASIS_SOURCE_STATEMENTS,
                     detail="the period's own assembled statements "
                            "(no served envelope for this period)")
    return Basis(value=None, source=BASIS_SOURCE_NONE,
                 detail="neither a served envelope nor the assembled "
                        "statements carry a non-zero total assets")


@dataclass(frozen=True)
class AmountAtStake:
    fact: str
    value: float


def amount_at_stake(finding: F.Finding) -> Optional[AmountAtStake]:
    """The largest money figure the finding cites, other than the company
    totals it compares against. Read off the finding's OWN evidence —
    the same figures the prose prints — so the amount a reader is judged
    on is one they can see. Ties resolve to the first cited, which is the
    detector's subject figure."""
    best = None  # type: Optional[AmountAtStake]
    figures = finding.evidence.figures if finding.evidence is not None else ()
    for figure in figures:
        if figure.unit != F.UNIT_MONEY or figure.fact in BASIS_TOTALS:
            continue
        if _ratio_units.unit_for_fact(figure.fact) != _ratio_units.UNIT_MONEY:
            continue
        candidate = AmountAtStake(fact=figure.fact, value=float(figure.value))
        if best is None or abs(candidate.value) > abs(best.value):
            best = candidate
    if best is not None:
        return best
    # A demoted finding may carry facts and no figures; read the facts
    # in insertion order under the same rule.
    for fact, value in finding.facts_cited.items():
        if fact in BASIS_TOTALS:
            continue
        if _ratio_units.unit_for_fact(fact) != _ratio_units.UNIT_MONEY:
            continue
        candidate = AmountAtStake(fact=fact, value=float(value))
        if best is None or abs(candidate.value) > abs(best.value):
            best = candidate
    return best


def root_cause_of(finding: F.Finding) -> str:
    """The ledger accounts the finding is about — the merge key, the
    dismissal scope and the persistence key, all at once. The same
    convention the multi-period lane's ``LineSpec.scope_key`` uses."""
    accounts = finding.subject.accounts if finding.subject is not None else ()
    codes = [a.code for a in accounts if (a.code or "").strip()]
    return "+".join(codes) if codes else finding.rule_id


def finding_id(period_id: str, finding: F.Finding) -> str:
    return "%s|%s|%s" % (period_id, finding.rule_id, root_cause_of(finding))


# ── Provenance: every cited money figure through the gateway ─────────────


@dataclass(frozen=True)
class FactProvenance:
    fact: str
    status: str
    value: Optional[float] = None
    accessor: Optional[str] = None
    line_id: Optional[str] = None
    snapshot_id: Optional[str] = None
    served_value: Optional[float] = None
    reason: str = ""


@dataclass(frozen=True)
class RowProvenance:
    """What Radar itself cites for one row, and what it withholds.
    ``cited`` carries a figure only when the gateway served the same
    cents; ``withheld`` carries reasons, never values."""

    snapshot_id: Optional[str]
    gateway_tier: Optional[str]
    facts: Tuple[FactProvenance, ...]
    derived: Tuple[str, ...]

    @property
    def conflicts(self) -> Tuple[FactProvenance, ...]:
        return tuple(f for f in self.facts if f.status == PROVENANCE_CONFLICT)

    @property
    def verified(self) -> Tuple[FactProvenance, ...]:
        return tuple(f for f in self.facts if f.status == PROVENANCE_VERIFIED)

    @property
    def withheld(self) -> Tuple[FactProvenance, ...]:
        return tuple(f for f in self.facts
                     if f.status in (PROVENANCE_WITHHELD, PROVENANCE_UNVERIFIED))

    def to_payload(self) -> Dict[str, Any]:
        cited = {}  # type: Dict[str, Any]
        for f in self.verified:
            cited[f.fact] = {"value": f.value, "accessor": f.accessor,
                             "line_id": f.line_id, "snapshot_id": f.snapshot_id}
        withheld = {}  # type: Dict[str, Any]
        for f in self.withheld:
            withheld[f.fact] = {"status": f.status, "reason": f.reason}
        conflicts = [
            {"fact": f.fact, "cited": f.value, "served": f.served_value,
             "accessor": f.accessor, "reason": f.reason}
            for f in self.conflicts]
        return {
            "snapshot_id": self.snapshot_id,
            "gateway_tier": self.gateway_tier,
            "cited": cited,
            "withheld": withheld,
            "conflicts": conflicts,
            "derived": list(self.derived),
            "verified_count": len(cited),
            "withheld_count": len(withheld),
            "conflict_count": len(conflicts),
        }


def _money_facts_of(finding: F.Finding) -> Tuple[Tuple[str, float], ...]:
    """The finding's money facts in citation order: figures first (what
    the prose prints), then any money fact cited but not printed."""
    seen = []  # type: List[str]
    out = []  # type: List[Tuple[str, float]]
    figures = finding.evidence.figures if finding.evidence is not None else ()
    for figure in figures:
        if figure.unit != F.UNIT_MONEY or figure.fact in seen:
            continue
        if _ratio_units.unit_for_fact(figure.fact) != _ratio_units.UNIT_MONEY:
            continue
        seen.append(figure.fact)
        out.append((figure.fact, float(figure.value)))
    for fact, value in finding.facts_cited.items():
        if fact in seen:
            continue
        if _ratio_units.unit_for_fact(fact) != _ratio_units.UNIT_MONEY:
            continue
        seen.append(fact)
        out.append((fact, float(value)))
    return tuple(out)


def _cents(value: float) -> int:
    return int(round(float(value) * 100.0))


def _gateway_snapshot(gateway: Optional[FactsGateway]) -> Optional[str]:
    """The id the gateway stamps on its facts, read off a fact — never
    off a private field."""
    if gateway is None:
        return None
    try:
        provenance = gateway.total_assets().provenance
    except Exception:  # noqa: BLE001 — MissingFactError and kin
        return None
    if isinstance(provenance, dict) and provenance.get("snapshot_id"):
        return str(provenance["snapshot_id"])
    return None


def verify_facts(finding: F.Finding, gateway: Optional[FactsGateway],
                 lane: str = LANE_SINGLE,
                 snapshot_id: Optional[str] = None) -> RowProvenance:
    """Every money figure the finding cites, through the accessor that
    serves it. A fact with no accessor is WITHHELD with the reason; a
    fact whose accessor serves different cents is a CONFLICT on a
    single-period row (the multi lane cites series values that may
    belong to a prior period, so a mismatch there is UNVERIFIED, never a
    conflict, and never a served figure either)."""
    derived = tuple(sorted(
        name for name in finding.facts_cited
        if _ratio_units.unit_for_fact(name) != _ratio_units.UNIT_MONEY))
    snapshot = snapshot_id if snapshot_id is not None else _gateway_snapshot(gateway)
    tier = gateway.tier if gateway is not None else None
    facts = []  # type: List[FactProvenance]
    for fact, value in _money_facts_of(finding):
        if gateway is None:
            facts.append(FactProvenance(
                fact=fact, status=PROVENANCE_WITHHELD,
                reason="no served envelope for this period, so no FactsGateway "
                       "fact exists to verify '%s' against" % fact))
            continue
        spec = FACT_ACCESSORS.get(fact)
        if spec is None:
            facts.append(FactProvenance(
                fact=fact, status=PROVENANCE_WITHHELD,
                reason="no FactsGateway accessor resolves '%s'; the engine row "
                       "carries the detector's own reading of the rebuilt "
                       "statements, which Radar does not cite as a served "
                       "fact" % fact))
            continue
        accessor_name, args = spec
        label = "FactsGateway.%s(%s)" % (
            accessor_name, ", ".join(repr(a) for a in args))
        try:
            served = getattr(gateway, accessor_name)(*args)
        except MissingFactError as exc:
            facts.append(FactProvenance(
                fact=fact, status=PROVENANCE_WITHHELD, accessor=label,
                reason="%s refused: %s" % (label, exc)))
            continue
        except Exception as exc:  # noqa: BLE001 — a gateway bug is a withheld fact
            facts.append(FactProvenance(
                fact=fact, status=PROVENANCE_WITHHELD, accessor=label,
                reason="%s failed (%s)" % (label, type(exc).__name__)))
            continue
        if not isinstance(served, Fact):
            facts.append(FactProvenance(
                fact=fact, status=PROVENANCE_WITHHELD, accessor=label,
                reason="%s served a refusal, not a fact" % label))
            continue
        provenance = served.provenance if isinstance(served.provenance, dict) else {}
        if served.amount_minor == _cents(value):
            facts.append(FactProvenance(
                fact=fact, status=PROVENANCE_VERIFIED, value=float(value),
                accessor=label, line_id=provenance.get("line_id"),
                snapshot_id=provenance.get("snapshot_id") or snapshot))
            continue
        status = PROVENANCE_CONFLICT if lane == LANE_SINGLE else PROVENANCE_UNVERIFIED
        facts.append(FactProvenance(
            fact=fact, status=status, value=float(value), accessor=label,
            line_id=provenance.get("line_id"),
            snapshot_id=provenance.get("snapshot_id") or snapshot,
            served_value=served.to_float(),
            reason=("the row cites %s = %.2f but %s serves %.2f for this "
                    "period's envelope" % (fact, float(value), label,
                                           served.to_float())
                    if lane == LANE_SINGLE else
                    "multi-period series value; %s serves %.2f for the target "
                    "period, and only the target period is verifiable"
                    % (label, served.to_float()))))
    return RowProvenance(snapshot_id=snapshot, gateway_tier=tier,
                         facts=tuple(facts), derived=derived)


# ── Persistence across the spine ─────────────────────────────────────────


def _fired_keys(result: "s_engine.SinglePeriodResult") -> frozenset:
    return frozenset((f.rule_id, root_cause_of(f)) for f in result.finding_set.surfaced)


def consecutive_periods(rule_id: str, root_cause: str,
                        prior_fired: Sequence[frozenset]) -> int:
    """How many consecutive periods the same (rule, balance) has fired,
    counting this one. ``prior_fired`` is nearest-first; the walk stops
    at the first period where it did not fire, and a period with no
    statements (an empty set) stops it too — silence in a gap is not
    evidence of health."""
    count = 1
    for fired in prior_fired:
        if (rule_id, root_cause) in fired:
            count += 1
        else:
            break
    return count


# ── The single-period lane ───────────────────────────────────────────────


@dataclass(frozen=True)
class SingleLane:
    result: "s_engine.SinglePeriodResult"
    report: R.RankedReport
    basis: Basis
    refusals: Tuple[Dict[str, Any], ...]
    amount_facts: Dict[str, str]
    severity_by_rule: Dict[str, str]
    provenance: Dict[str, RowProvenance]


def rank_inputs_for(result: "s_engine.SinglePeriodResult",
                    basis: Basis, policy: R.MaterialityPolicy,
                    currency: str, period_ordinal: int,
                    prior_fired: Sequence[frozenset] = (),
                    gateway: Optional[FactsGateway] = None
                    ) -> Tuple[List[R.RankInput], List[Dict[str, Any]], Dict[str, str]]:
    """Every finding the engine produced — surfaced AND demoted — as a
    ranking candidate, or a refusal check row when no materiality
    verdict can be formed or when a cited figure contradicts the
    gateway. Demotion for an incomplete contract belongs to the ranker,
    not here, so incomplete findings are candidates too."""
    inputs, refusals, amount_facts, _prov = _rank_inputs_and_provenance(
        result, basis, policy, currency, period_ordinal, prior_fired, gateway)
    return inputs, refusals, amount_facts


def _rank_inputs_and_provenance(
        result: "s_engine.SinglePeriodResult", basis: Basis,
        policy: R.MaterialityPolicy, currency: str, period_ordinal: int,
        prior_fired: Sequence[frozenset], gateway: Optional[FactsGateway]
        ) -> Tuple[List[R.RankInput], List[Dict[str, Any]], Dict[str, str],
                   Dict[str, RowProvenance]]:
    inputs = []  # type: List[R.RankInput]
    refusals = []  # type: List[Dict[str, Any]]
    amount_facts = {}  # type: Dict[str, str]
    provenance = {}  # type: Dict[str, RowProvenance]
    findings = list(result.finding_set.surfaced) + list(result.finding_set.demoted)
    for finding in findings:
        root = root_cause_of(finding)
        key = finding.rule_id + "|" + root
        prov = verify_facts(finding, gateway, LANE_SINGLE)
        provenance[key] = prov
        stake = amount_at_stake(finding)
        reason = None  # type: Optional[str]
        verdict = None  # type: Optional[R.MaterialityVerdict]
        if prov.conflicts:
            reason = ("fired but not served: provenance conflict — "
                      + "; ".join(f.reason for f in prov.conflicts))
        elif stake is None:
            reason = ("fired but not ranked: the finding cites no money figure "
                      "other than a company total, so the amount at stake "
                      "cannot be read off its own evidence")
        else:
            try:
                verdict = R.assess_materiality(
                    policy, MATERIALITY_BASIS_ID, MATERIALITY_BASIS_LABEL,
                    basis.value, stake.value, currency)
            except R.MaterialityBasisMissing as exc:
                reason = "fired but not ranked: %s" % exc
        if verdict is None or stake is None:
            record = finding.check_record().to_payload()
            note = record.get("note") or ""
            record["note"] = "; ".join([bit for bit in (note, reason) if bit])
            record["disposition"] = R.DISPOSITION_CHECKS
            record["materiality"] = None
            if prov.conflicts:
                record["provenance_conflicts"] = [
                    dict(fact=f.fact, cited=f.value, served=f.served_value,
                         accessor=f.accessor) for f in prov.conflicts]
            refusals.append(record)
            continue
        amount_facts[key] = stake.fact
        inputs.append(R.RankInput(
            finding=finding, materiality=verdict, root_cause=root,
            persistence=consecutive_periods(finding.rule_id, root, prior_fired),
            scope_key=root, period_ordinal=period_ordinal))
    return inputs, refusals, amount_facts, provenance


def retain_dismissed_critical_groups(report: R.RankedReport,
                                     severity_by_rule: Mapping[str, str]
                                     ) -> R.RankedReport:
    """The ranker keeps a dismissed CRITICAL surfaced and flagged, but
    reads only the primary's severity: dismissing the non-Critical
    primary of a merged group took the buried Critical to the checks
    with ``dismissed_but_retained=False`` (SERVE_GATES.md, A4). Here the
    group is the unit: a dismissed row whose group carries a Critical
    comes back to the surfaced list, flagged retained, rank assigned by
    the cap. Its demotion check row is withdrawn with it."""
    moved = []  # type: List[R.RankedFinding]
    kept_demoted = []  # type: List[R.RankedFinding]
    for row in report.demoted:
        if (row.dismissal is not None
                and row.demotion_reason.startswith("dismissed:")
                and CAP.is_critical(row, severity_by_rule)):
            moved.append(replace(
                row, disposition=R.DISPOSITION_SURFACED, recommendation=True,
                dismissed_but_retained=True, demotion_reason=""))
        else:
            kept_demoted.append(row)
    if not moved:
        return report
    withdrawn = set((r.finding.rule_id, "dismissed: %s" % (
        r.dismissal.reason or "no reason recorded")) for r in moved)
    checks = []  # type: List[Dict[str, Any]]
    for check in report.checks:
        note = str(check.get("note") or "")
        hit = None
        for rule_id, reason in withdrawn:
            if check.get("rule_id") == rule_id and note.endswith(reason) \
                    and check.get("disposition") == R.DISPOSITION_CHECKS:
                hit = (rule_id, reason)
                break
        if hit is not None:
            withdrawn.discard(hit)
            continue
        checks.append(check)
    return R.RankedReport(
        surfaced=tuple(list(report.surfaced) + moved), info=report.info,
        demoted=tuple(kept_demoted), checks=tuple(checks), cap=report.cap,
        counts=dict(report.counts), policy_source=report.policy_source)


def run_single_lane(request: RadarRequest, policy: R.MaterialityPolicy,
                    index: R.DismissalIndex,
                    prior_results: Sequence[Optional["s_engine.SinglePeriodResult"]],
                    gateway: Optional[FactsGateway] = None) -> SingleLane:
    target = request.target
    result = s_engine.run_single_period(
        target.statements, period_id=target.period_id, caen=target.caen,
        snapshot_id=target.engine_snapshot_id())
    basis = resolve_basis(target, result.profile, gateway)
    prior_fired = [(_fired_keys(r) if r is not None else frozenset())
                   for r in prior_results]
    inputs, refusals, amount_facts, provenance = _rank_inputs_and_provenance(
        result, basis, policy, result.profile.currency, target.ordinal,
        prior_fired, gateway)
    severity_by_rule = dict(
        (f.rule_id, f.severity)
        for f in list(result.finding_set.surfaced) + list(result.finding_set.demoted))
    report = R.rank_findings(
        inputs, checks=tuple(result.all_checks()), cap=max(1, len(inputs)),
        dismissals=index, policy_source=policy.source)
    report = retain_dismissed_critical_groups(report, severity_by_rule)
    return SingleLane(result=result, report=report, basis=basis,
                      refusals=tuple(refusals), amount_facts=amount_facts,
                      severity_by_rule=severity_by_rule, provenance=provenance)


# ── The multi-period lane ────────────────────────────────────────────────


@dataclass(frozen=True)
class MultiLane:
    result: Optional["m_engine.MultiPeriodResult"]
    report: Optional[R.RankedReport]
    checks: Tuple[Dict[str, Any], ...]
    needs_history: Optional[Dict[str, Any]]
    notice: Optional[str]
    periods_on_spine: int
    periods_with_statements: int
    severity_by_rule: Dict[str, str]


def _series_period(period: PeriodInput) -> m_series.PeriodRef:
    year = month = None  # type: Optional[int]
    end = str(period.period_end or "")
    if len(end) >= 7 and end[4] == "-":
        try:
            year, month = int(end[:4]), int(end[5:7])
        except ValueError:
            year = month = None
    days = _days_covered(period.period_start, period.period_end)
    return m_series.PeriodRef(
        period_id=period.period_id, label=period.label or end,
        ordinal=int(period.ordinal), year=year, month=month,
        snapshot_id=period.engine_snapshot_id(), days_covered=days)


def _days_covered(start: Optional[str], end: Optional[str]) -> Optional[int]:
    """Calendar days between two ISO dates, inclusive. Pure arithmetic on
    the strings the row carries — no clock."""
    if not start or not end:
        return None
    try:
        from datetime import date
        a = date.fromisoformat(str(start)[:10])
        b = date.fromisoformat(str(end)[:10])
    except ValueError:
        return None
    span = (b - a).days + 1
    return span if span > 0 else None


def run_multi_lane(request: RadarRequest, profile: "CP.CompanyProfile",
                   policy: R.MaterialityPolicy) -> MultiLane:
    """The multi-period analyses over the spine ending at the target.
    Cold start (fewer than two periods with statements) is the engine's
    own typed answer — the requirement list — and it is served, not
    swallowed. A currency change across the spine is a notice: the
    multi-period lane refuses rather than measuring FX as movement."""
    spine = list(request.prior_periods()) + [request.target]
    spine.sort(key=lambda p: (p.ordinal, p.period_id))
    refs = [_series_period(p) for p in spine]
    by_id = dict((p.period_id, p.statements) for p in spine if p.has_statements())
    with_statements = len(by_id)
    try:
        series_set = m_series.build_series_set(refs, by_id)
    except m_series.SeriesCurrencyError as exc:
        return MultiLane(result=None, report=None, checks=(), needs_history=None,
                         notice="multi-period analyses not run: %s" % exc,
                         periods_on_spine=len(spine),
                         periods_with_statements=with_statements,
                         severity_by_rule={})
    result = m_engine.analyse_multi_period(
        series_set, profile, prior_findings=(),
        dismissals=tuple(request.dismissals), policy=policy,
        cap=max(1, 10 * len(m_series.DEFAULT_LINES) * len(m_engine.ROSTER)))
    severity_by_rule = dict(
        (f.rule_id, f.severity)
        for f in list(result.finding_set.surfaced) + list(result.finding_set.demoted))
    if result.report is None:
        needs = result.needs_history.to_payload() if result.needs_history else None
        return MultiLane(result=result, report=None,
                         checks=tuple(result.finding_set.all_checks()),
                         needs_history=needs, notice=None,
                         periods_on_spine=len(spine),
                         periods_with_statements=with_statements,
                         severity_by_rule=severity_by_rule)
    report = retain_dismissed_critical_groups(result.report, severity_by_rule)
    return MultiLane(result=result, report=report,
                     checks=tuple(report.checks), needs_history=None,
                     notice=None, periods_on_spine=len(spine),
                     periods_with_statements=with_statements,
                     severity_by_rule=severity_by_rule)


# ── The detector lane ────────────────────────────────────────────────────


@dataclass(frozen=True)
class DetectorLane:
    """The pack-declared families, over the served-tier spine."""

    inputs: Tuple[R.RankInput, ...]
    checks: Tuple[Dict[str, Any], ...]
    amount_facts: Dict[str, str]
    severity_by_rule: Dict[str, str]
    provenance: Dict[str, RowProvenance]
    #: Why the lane did not run, when it did not. None means it ran.
    notice: Optional[str] = None
    ran: Tuple[str, ...] = ()
    waiting: Tuple[str, ...] = ()


def _detector_spine(request: RadarRequest):
    """The SERVED-tier spine over the request's periods, or a sentence
    saying why there is none.

    Served tier because that is what a persisted period carries: closing
    balances from `statement_line_items`, and nothing else. The spine
    stamps a typed refusal on the opening and movement slots and
    `detectors.from_series` turns that into ABSENT, so the families that
    read a movement report NOT APPLICABLE naming the missing column
    rather than measuring a distribution over zeros.
    """
    from engine.radar import series as SER

    spine_periods = list(request.prior_periods()) + [request.target]
    spine_periods.sort(key=lambda p: (p.ordinal, p.period_id))
    cui = next((p.cui for p in spine_periods if p.cui), None)
    if not cui:
        return None, ("detectors not run: no period on the spine carries a "
                      "company identity, and a series that cannot say which "
                      "company it is for is the one thing the spine must "
                      "never produce")
    try:
        entity = SER.EntityKey.of(request.org_id, cui)
    except SER.EntityUnknownError as exc:
        return None, "detectors not run: %s" % exc

    inputs = []
    for period in spine_periods:
        if not period.has_line_items():
            # A period with no loaded accounts is a HOLE, declared as one.
            # Dropping it instead would let a quiet run be measured across
            # the gap.
            inputs.append(SER.AbsentPeriodInput(
                period_id=period.period_id,
                fiscal_end=str(period.period_end or ""),
                ordinal=int(period.ordinal), cui=str(period.cui or cui),
                label=period.label))
            continue
        inputs.append(SER.ServedPeriodInput(
            period_id=period.period_id,
            fiscal_end=str(period.period_end or ""),
            ordinal=int(period.ordinal),
            currency=str(period.currency or "RON"),
            cui=str(period.cui or cui),
            line_items=list(period.line_items or ()),
            snapshot_key=snapshot_key(period),
            snapshot_id=period.snapshot_id,
            source_document_id=period.source_document_id,
            label=period.label))
    try:
        return SER.build(entity, inputs), None
    except SER.SeriesError as exc:
        return None, "detectors not run: %s" % exc


def run_detector_lane(request: RadarRequest, profile: "CP.CompanyProfile",
                      policy: R.MaterialityPolicy, basis: Basis,
                      gateway: Optional[FactsGateway] = None) -> DetectorLane:
    """Run the pack's detector families and shape their findings as
    ranking candidates, exactly as the single lane does.

    Everything this lane cannot do says so and stops: no pack, no
    identity, no line items, a currency change on the spine. None of
    those is an empty finding list, and none of them is silence.
    """
    from engine.radar import detectors as DET
    from engine.radar.detectors import from_series as JOIN
    from engine.radar.detectors import run as RUNMOD

    empty = DetectorLane(inputs=(), checks=(), amount_facts={},
                         severity_by_rule={}, provenance={})
    jurisdiction = request.detector_jurisdiction
    pack_root = request.detector_pack_root
    if not jurisdiction or not pack_root:
        return replace(empty, notice=(
            "detectors not run: no jurisdiction pack was named for this "
            "request"))
    try:
        pack = DET.load_pack(str(jurisdiction), str(pack_root))
    except Exception as exc:  # noqa: BLE001 — the reason is the product
        return replace(empty, notice="detectors not run: %s" % exc)

    spine, why = _detector_spine(request)
    if spine is None:
        return replace(empty, notice=why)

    # The totals a share is taken of come from the FACTS GATEWAY, which is
    # the serving lane's own authority on them — `resolve_basis` already
    # used it for the target and this lane is handed that answer. Reading
    # the statement dicts directly instead was measured wrong on the very
    # first book: `canonical_bs` carries no top-level `total_assets` (it
    # carries `sections` and `invariants`), so every detector needing a
    # basis reported "total_assets is not served for this period".
    basis_by_period = {}  # type: Dict[str, Any]
    for period in list(request.prior_periods()) + [request.target]:
        totals = _detector_basis_for(
            period, basis if period.period_id == request.target.period_id else None)
        if totals is not None:
            basis_by_period[period.period_id] = totals
    try:
        series = JOIN.book_series_from_spine(
            spine, basis_by_period=basis_by_period)
    except (JOIN.SpineJoinError, ValueError) as exc:
        return replace(empty, notice="detectors not run: %s" % exc)

    run = DET.run_detectors(pack, series, profile,
                            snapshot_id=request.target.engine_snapshot_id())

    inputs = []  # type: List[R.RankInput]
    checks = []  # type: List[Dict[str, Any]]
    amount_facts = {}  # type: Dict[str, str]
    provenance = {}  # type: Dict[str, RowProvenance]
    severity_by_rule = dict(
        (f.rule_id, f.severity)
        for f in run.findings)

    # Every check the run recorded, verbatim: "measured and clear" and
    # "could not measure" are different claims and both belong on the
    # checks list.
    for check in run.checks:
        row = check.to_payload()
        # The check list is read by ONE renderer, so a detector row must
        # carry the same keys a rule row does. `rule_id` is the id the
        # reader sees beside every other check; `detector_id` stays too,
        # because the pack line it names is what a reader walks back to.
        row["rule_id"] = row.get("detector_id")
        row["note"] = row.get("reason")
        row["fired"] = row.get("status") == RUNMOD.STATUS_FIRED
        row["lane"] = LANE_DETECTORS
        row["disposition"] = R.DISPOSITION_CHECKS
        checks.append(row)

    for finding in DET.surfaced(run):
        root = root_cause_of(finding)
        key = finding.rule_id + "|" + root
        prov = verify_facts(finding, gateway, LANE_DETECTORS)
        provenance[key] = prov
        stake = amount_at_stake(finding)
        reason = None  # type: Optional[str]
        verdict = None  # type: Optional[R.MaterialityVerdict]
        if prov.conflicts:
            reason = ("fired but not served: provenance conflict — "
                      + "; ".join(f.reason for f in prov.conflicts))
        elif stake is None:
            reason = ("fired but not ranked: the finding cites no money "
                      "figure other than a company total, so the amount at "
                      "stake cannot be read off its own evidence")
        else:
            try:
                verdict = R.assess_materiality(
                    policy, MATERIALITY_BASIS_ID, MATERIALITY_BASIS_LABEL,
                    basis.value, stake.value, profile.currency)
            except R.MaterialityBasisMissing as exc:
                reason = "fired but not ranked: %s" % exc
        if verdict is None or stake is None:
            record = finding.check_record().to_payload()
            note = record.get("note") or ""
            record["note"] = "; ".join([bit for bit in (note, reason) if bit])
            record["disposition"] = R.DISPOSITION_CHECKS
            record["materiality"] = None
            record["lane"] = LANE_DETECTORS
            checks.append(record)
            continue
        amount_facts[key] = stake.fact
        inputs.append(R.RankInput(
            finding=finding, materiality=verdict, root_cause=root,
            # Persistence is a claim about the SAME finding in earlier
            # periods, and this lane runs once over the whole spine
            # rather than once per period. Claiming a run it did not
            # measure would be worse than claiming none.
            persistence=1, scope_key=root,
            period_ordinal=request.target.ordinal))

    return DetectorLane(
        inputs=tuple(inputs), checks=tuple(checks), amount_facts=amount_facts,
        severity_by_rule=severity_by_rule, provenance=provenance,
        notice=None, ran=tuple(run.ran), waiting=tuple(run.waiting))


def _detector_basis_for(period: PeriodInput, resolved: Optional[Basis] = None):
    """The totals a share is taken of, for one period.

    From the FactsGateway, which is this lane's one authority on them —
    the same accessor `resolve_basis` uses, so the detector families and
    the serving lane can never disagree about what total assets are. When
    the caller has already resolved the target's basis it is reused
    verbatim rather than read a second time.

    Never recomputed from line items: that would be a second opinion
    about a total the engine already publishes.
    """
    from engine.radar.detectors import book as DBOOK

    total_assets = resolved.value if resolved is not None else None
    revenue = None  # type: Optional[float]
    gateway = gateway_for(period)
    if gateway is not None:
        if total_assets is None:
            total_assets = _gateway_amount(gateway, "total_assets")
        revenue = _gateway_amount(gateway, "revenue")
    if total_assets is None and revenue is None:
        return None
    return DBOOK.BasisTotals(
        total_assets=total_assets, revenue=revenue,
        source="FactsGateway over the persisted envelope for %s"
               % (period.label or period.period_id))


def _gateway_amount(gateway: FactsGateway, accessor: str) -> Optional[float]:
    """One served total, or ABSENT. A fact the gateway declines to serve
    is not zero, and the detector that needs it refuses by name."""
    try:
        fact = getattr(gateway, accessor)()
    except (MissingFactError, AttributeError, ValueError):
        return None
    value = getattr(fact, "value", None)
    return None if value is None else float(value)


# ── The payload ──────────────────────────────────────────────────────────


def _row(ranked: R.RankedFinding, period_id: str, lane: str,
         amount_fact: Optional[str], severity_by_rule: Mapping[str, str],
         provenance: Optional[RowProvenance]) -> Dict[str, Any]:
    payload = ranked.finding.to_payload()
    payload.update({
        "rank": ranked.rank,
        "score": ranked.score.to_payload(),
        "disposition": ranked.disposition,
        "effective_severity": ranked.effective_severity,
        "materiality": ranked.materiality.to_payload(),
        "persistence": ranked.persistence,
        "persistence_label": ranked.persistence_label,
        "root_cause": ranked.root_cause,
        "recommendation": ranked.recommendation,
        "merged_from": list(ranked.merged_from),
        "contributor_rules": list(ranked.contributor_rules),
        "contributor_summary": ranked.contributor_summary(),
        "dismissed": ranked.dismissal is not None,
        "dismissal": (ranked.dismissal.to_payload() if ranked.dismissal else None),
        "dismissed_but_retained": ranked.dismissed_but_retained,
        "demotion_reason": ranked.demotion_reason,
    })
    payload["id"] = finding_id(period_id, ranked.finding)
    payload["source"] = SOURCE
    payload["lane"] = lane
    payload["period_id"] = period_id
    payload["materiality_amount_fact"] = amount_fact
    payload["group_severity"] = CAP.group_severity(ranked, severity_by_rule)
    payload["group_critical"] = CAP.is_critical(ranked, severity_by_rule)
    prov_payload = provenance.to_payload() if provenance is not None else None
    payload["facts_provenance"] = prov_payload
    payload["materiality_amount_verified"] = bool(
        amount_fact and prov_payload and amount_fact in prov_payload["cited"])
    return payload


def _gap_payload(request: RadarRequest, detail: str) -> Dict[str, Any]:
    target = request.target
    return {
        "version": RADAR_VERSION, "source": SOURCE,
        "period_id": target.period_id, "period_label": target.label,
        "currency": target.currency,
        "snapshot_id": target.content_hash(),
        "source_document_id": target.source_document_id,
        "available": False,
        "gap": {"code": "no_statements", "missing": ["statements"],
                "detail": detail,
                "fix": "Upload or re-run the analysis for %s."
                       % (target.label or target.period_id)},
        "profile": None,
        "surfaced": [], "info": [], "demoted": [], "checks": [],
        "cap": None, "cap_policy": None, "counts": {},
        "materiality_policy": None, "materiality": None,
        "provenance": None,
        "statement": detail, "silence": None,
        "dismissals": {"in_force": [d.to_payload() for d in request.dismissals],
                       "applied": 0, "retained_critical": 0},
        "needs_history": None, "history": None, "lanes": None,
    }


@dataclass(frozen=True)
class Served:
    """The payload and the SIDE material the explanation lane projects
    its subjects from: the surfaced ranked rows (after the cap), the
    profile that qualified them and the gateway. Never JSON — kept by
    reference beside the cache entry, evicted with it."""

    payload: Dict[str, Any]
    surfaced: Tuple[R.RankedFinding, ...]
    profile: Any
    gateway: Optional[FactsGateway]
    snapshot_hash: str


def serve_period(request: RadarRequest) -> Dict[str, Any]:
    """The Radar payload for one period. Pure over its request: no I/O,
    no clock, no model."""
    return compose(request).payload


def compose(request: RadarRequest) -> Served:
    """The Radar payload for one period, plus the side material."""
    target = request.target
    if not target.has_statements():
        return Served(
            payload=_gap_payload(
                request, "%s has no assembled statements to run the detectors "
                         "over." % (target.label or target.period_id)),
            surfaced=(), profile=None, gateway=None,
            snapshot_hash=str(target.content_hash() or ""))

    policy = request.materiality_policy or materiality_policy()
    cap_policy = request.cap_policy or CAP.CapPolicy.from_pack()
    # A total order over the dismissal set, so the bytes do not depend
    # on the order storage happened to return the rows in.
    dismissals = tuple(sorted(
        request.dismissals,
        key=lambda d: (d.dismissed_at, d.rule_id, d.scope_key, d.reason,
                       d.dismissed_by)))
    request = RadarRequest(
        org_id=request.org_id, target=request.target, history=request.history,
        dismissals=dismissals, cap_policy=cap_policy, materiality_policy=policy,
        history_depth=request.history_depth,
        detectors_enabled=request.detectors_enabled,
        detector_jurisdiction=request.detector_jurisdiction,
        detector_pack_root=request.detector_pack_root)
    index = R.DismissalIndex(dismissals)
    gateway = gateway_for(target)

    prior = request.prior_periods()
    prior_results = []  # type: List[Optional[s_engine.SinglePeriodResult]]
    for p in prior:
        if p.has_statements():
            prior_results.append(s_engine.run_single_period(
                p.statements, period_id=p.period_id, caen=p.caen,
                snapshot_id=p.engine_snapshot_id()))
        else:
            prior_results.append(None)

    single = run_single_lane(request, policy, index, prior_results, gateway)
    multi = run_multi_lane(request, single.result.profile, policy)

    # THE DETECTOR LANE IS OFF UNTIL THE REQUEST SAYS OTHERWISE, and with
    # it off nothing below changes: no lane object, no extra candidates,
    # no extra check rows, and `cache_key` carries the flag so a flip is a
    # recompute rather than a stale hit.
    detectors = None  # type: Optional[DetectorLane]
    if request.detectors_enabled:
        detectors = run_detector_lane(
            request, single.result.profile, policy, single.basis, gateway)

    severity_by_rule = dict(single.severity_by_rule)
    severity_by_rule.update(multi.severity_by_rule)
    if detectors is not None:
        severity_by_rule.update(detectors.severity_by_rule)

    surfaced_in = list(single.report.surfaced)
    info_in = list(single.report.info)
    demoted_in = list(single.report.demoted)
    if multi.report is not None:
        surfaced_in.extend(multi.report.surfaced)
        info_in.extend(multi.report.info)
        demoted_in.extend(multi.report.demoted)
    detector_ids = set()  # type: set
    if detectors is not None and detectors.inputs:
        # Ranked through the SAME ranker, with the same dismissal index and
        # the same policy source. A finding is a finding whatever produced
        # it; a second ranker here would be a second policy about what a
        # reader sees.
        detector_report = R.rank_findings(
            list(detectors.inputs), checks=(),
            cap=max(1, len(detectors.inputs)), dismissals=index,
            policy_source=policy.source)
        detector_report = retain_dismissed_critical_groups(
            detector_report, detectors.severity_by_rule)
        for bucket in (detector_report.surfaced, detector_report.info,
                       detector_report.demoted):
            for rf in bucket:
                detector_ids.add(id(rf.finding))
        surfaced_in.extend(detector_report.surfaced)
        info_in.extend(detector_report.info)
        demoted_in.extend(detector_report.demoted)
    critical_below_floor = len([
        rf for rf in info_in if CAP.is_critical(rf, severity_by_rule)]) + len([
        rf for rf in demoted_in
        if rf.demotion_reason.startswith("below the materiality floor")
        and CAP.is_critical(rf, severity_by_rule)])
    decision = CAP.apply_cap(surfaced_in, cap_policy, severity_by_rule,
                             critical_below_floor)

    multi_ids = set()  # type: set
    multi_provenance = {}  # type: Dict[int, RowProvenance]
    if multi.report is not None:
        for bucket in (multi.report.surfaced, multi.report.info, multi.report.demoted):
            for rf in bucket:
                multi_ids.add(id(rf.finding))
                multi_provenance[id(rf.finding)] = verify_facts(
                    rf.finding, gateway, LANE_MULTI)

    def lane_of(rf: R.RankedFinding) -> str:
        if id(rf.finding) in detector_ids:
            return LANE_DETECTORS
        return LANE_MULTI if id(rf.finding) in multi_ids else LANE_SINGLE

    def row(rf: R.RankedFinding) -> Dict[str, Any]:
        key = rf.finding.rule_id + "|" + rf.root_cause
        lane = lane_of(rf)
        if lane == LANE_DETECTORS and detectors is not None:
            prov = detectors.provenance.get(key)
            fact = detectors.amount_facts.get(key)
        elif lane == LANE_MULTI:
            prov = multi_provenance.get(id(rf.finding))
            fact = single.amount_facts.get(key)
        else:
            prov = single.provenance.get(key)
            fact = single.amount_facts.get(key)
        return _row(rf, target.period_id, lane, fact, severity_by_rule, prov)

    surfaced = [row(rf) for rf in decision.surfaced]
    info = [row(rf) for rf in info_in]
    demoted = [row(rf) for rf in demoted_in]
    demoted.extend(row(rf) for rf in decision.held)

    checks = list(single.report.checks) + list(single.refusals) \
        + list(multi.checks) + list(decision.checks)
    if detectors is not None:
        checks.extend(detectors.checks)

    counts = _merge_counts(single.report.counts,
                           multi.report.counts if multi.report is not None else {})
    counts["held_back"] = int(counts.get("held_back", 0)) + decision.held_back
    counts["surfaced"] = len(surfaced)
    counts["info"] = len(info)
    counts["demoted"] = len(demoted)
    counts["checks"] = len(checks)
    counts["fired"] = len([c for c in checks if c.get("fired")])
    counts["refused_materiality"] = len(
        [c for c in single.refusals if "provenance conflict" not in (c.get("note") or "")])
    counts["refused_provenance"] = len(
        [c for c in single.refusals if "provenance conflict" in (c.get("note") or "")])
    retained = len([r for r in surfaced if r.get("dismissed_but_retained")])
    applied = int(counts.get("dismissed", 0))

    profile = single.result.profile
    silence = _silence(single, surfaced, checks)
    statement = _statement(decision, counts, silence)
    provenance_summary = _provenance_summary(
        target, gateway, surfaced + info + demoted, single.refusals)

    payload = {
        "version": RADAR_VERSION,
        "source": SOURCE,
        "period_id": target.period_id,
        "period_label": target.label,
        "currency": profile.currency,
        "snapshot_id": target.content_hash(),
        "source_document_id": target.source_document_id,
        "snapshot_key": snapshot_key(target),
        "available": True,
        "gap": None,
        "profile": {
            "profile_id": profile.profile_id,
            "composite_id": profile.composite_id,
            "profile_label": profile.profile_label,
            "fingerprint": profile.fingerprint(),
        },
        "surfaced": surfaced,
        "info": info,
        "demoted": demoted,
        "checks": checks,
        "cap": decision.cap,
        "cap_policy": decision.to_payload(),
        "counts": counts,
        "materiality_policy": policy.source,
        "materiality": {
            "basis": single.basis.to_payload(),
            "method": ("the largest money figure the finding itself cites, "
                       "other than a company total, as a share of %s"
                       % MATERIALITY_BASIS_LABEL),
            "excluded_totals": sorted(BASIS_TOTALS),
            "refused": len(single.refusals),
        },
        "provenance": provenance_summary,
        "statement": statement,
        "silence": silence,
        "dismissals": {
            "in_force": [d.to_payload() for d in request.dismissals],
            "applied": applied,
            "retained_critical": retained,
        },
        "needs_history": multi.needs_history,
        "history": {
            "periods_on_spine": multi.periods_on_spine,
            "periods_with_statements": multi.periods_with_statements,
            "prior_period_ids": [p.period_id for p in prior],
            "notice": multi.notice,
        },
        "lanes": {
            LANE_SINGLE: {"counts": dict(single.report.counts),
                          "checks": len(single.report.checks),
                          "refused_materiality": counts["refused_materiality"],
                          "refused_provenance": counts["refused_provenance"]},
            LANE_MULTI: {"ran": multi.report is not None,
                         "counts": (dict(multi.report.counts)
                                    if multi.report is not None else {}),
                         "checks": len(multi.checks),
                         "cold_start": multi.needs_history is not None},
            # `enabled: False` and `enabled: True, ran: []` are different
            # facts and a reader of this payload must be able to tell
            # them apart: the first says the lane is off, the second that
            # it ran and every family declined.
            LANE_DETECTORS: ({"enabled": False} if detectors is None else {
                "enabled": True,
                "notice": detectors.notice,
                "ran": list(detectors.ran),
                "waiting": list(detectors.waiting),
                "candidates": len(detectors.inputs),
                "checks": len(detectors.checks),
            }),
        },
    }
    return Served(payload=payload, surfaced=decision.surfaced, profile=profile,
                  gateway=gateway, snapshot_hash=str(target.content_hash() or ""))


def _provenance_summary(target: PeriodInput, gateway: Optional[FactsGateway],
                        rows: Sequence[Dict[str, Any]],
                        refusals: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    verified = withheld = conflicts = 0
    withheld_facts = set()  # type: set
    for r in rows:
        block = r.get("facts_provenance") or {}
        verified += int(block.get("verified_count") or 0)
        withheld += int(block.get("withheld_count") or 0)
        conflicts += int(block.get("conflict_count") or 0)
        withheld_facts.update((block.get("withheld") or {}).keys())
    refused = [c for c in refusals if c.get("provenance_conflicts")]
    return {
        "snapshot_id": target.content_hash(),
        "source_document_id": target.source_document_id,
        "gateway": {"available": gateway is not None,
                    "tier": gateway.tier if gateway is not None else None,
                    "snapshot_id": _gateway_snapshot(gateway)},
        "rule": PROVENANCE_RULE,
        "facts": {"verified": verified, "withheld": withheld,
                  "unverified_or_withheld_facts": sorted(withheld_facts),
                  "conflicts_on_served_rows": conflicts,
                  "rows_refused_for_conflict": len(refused)},
    }


def _merge_counts(a: Dict[str, int], b: Dict[str, int]) -> Dict[str, int]:
    out = {}  # type: Dict[str, int]
    for key in sorted(set(a) | set(b)):
        out[key] = int(a.get(key, 0)) + int(b.get(key, 0))
    return out


def _silence(single: SingleLane, surfaced: Sequence[Dict[str, Any]],
             checks: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """None when something is surfaced. Otherwise the engine's own
    silence statement when the contract surfaced nothing, or the same
    shape stating that what fired did not clear materiality — with the
    checks either way. Never filler."""
    if surfaced:
        return None
    engine_silence = single.result.silence_statement()
    if engine_silence is not None:
        engine_silence["checks"] = list(checks)
        engine_silence["checks_performed"] = len(checks)
        return engine_silence
    return {
        "material_findings": 0,
        "profile_id": single.result.profile.profile_id,
        "checks_performed": len(checks),
        "statement": (
            "No finding cleared the materiality floor for this period. "
            "%d check(s) ran; each is listed with its parameter, its limit "
            "and the observed value, and every finding that fired is listed "
            "with the reason it was not surfaced." % len(checks)),
        "checks": list(checks),
    }


def _statement(decision: CAP.CapDecision, counts: Dict[str, int],
               silence: Optional[Dict[str, Any]]) -> str:
    """The payload's one-line claim. Under silence it opens with the
    engine's own silence statement, but what is TRUE about Criticals
    below the floor and about rows refused for a contradicting figure
    is said either way — those are the claims a reader must see."""
    if silence is not None:
        bits = [silence["statement"].rstrip(".")]
        if decision.critical_below_floor:
            bits.append("%d Critical(s) below the materiality floor are listed "
                        "under info or All checks with the reason, not surfaced"
                        % decision.critical_below_floor)
        if counts.get("refused_provenance"):
            bits.append("%d fired but not served (a cited figure contradicts the "
                        "served envelope)" % counts["refused_provenance"])
        return "; ".join(bits) + "."
    bits = [decision.statement().rstrip(".")]
    if counts.get("immaterial"):
        bits.append("%d below the materiality floor" % counts["immaterial"])
    if counts.get("info"):
        bits.append("%d info row(s)" % counts["info"])
    if counts.get("dismissed"):
        bits.append("%d dismissed with a recorded reason" % counts["dismissed"])
    if counts.get("incomplete"):
        bits.append("%d demoted for missing a contract element" % counts["incomplete"])
    if counts.get("refused_materiality"):
        bits.append("%d fired but not ranked (no materiality basis)"
                    % counts["refused_materiality"])
    if counts.get("refused_provenance"):
        bits.append("%d fired but not served (a cited figure contradicts the "
                    "served envelope)" % counts["refused_provenance"])
    return "; ".join(bits) + "."


# ── Explanations: recovering the deterministic bytes ─────────────────────

#: The one payload-level key the route adds beside the rows' own
#: ``explanation`` (written by ``engine.radar.explain.attach``, never
#: here). Both are removed by :func:`strip_explanations`.
EXPLANATIONS_KEY = "explanations"


def strip_explanations(payload: Dict[str, Any]) -> Dict[str, Any]:
    """The deterministic payload, recovered from an explained one: every
    row's ``explanation`` and the payload's ``explanations`` summary are
    removed and nothing else is touched — which is what the determinism
    gate asserts about the route's output."""
    out = copy.deepcopy(payload)
    for bucket in ("surfaced", "info", "demoted"):
        for row in out.get(bucket) or ():
            row.pop("explanation", None)
    out.pop(EXPLANATIONS_KEY, None)
    out.pop("explained", None)
    return out


# ── helpers ──────────────────────────────────────────────────────────────


def _digest(value: Any) -> str:
    blob = json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def canonical_bytes(payload: Dict[str, Any]) -> str:
    """The byte form the determinism gate compares. ``cache`` and
    ``notices`` are the route's own keys about the process rather than
    the period, and they are excluded here so a hit and a miss compare
    equal."""
    trimmed = dict(payload)
    trimmed.pop("cache", None)
    trimmed.pop("notices", None)
    return json.dumps(trimmed, sort_keys=True, ensure_ascii=False)


__all__ = [
    "BASIS_TOTALS", "DEFAULT_HISTORY_DEPTH", "EXPLANATIONS_KEY",
    "FACT_ACCESSORS", "LANE_MULTI", "LANE_SINGLE", "MATERIALITY_BASIS_ID",
    "PROVENANCE_CONFLICT", "PROVENANCE_RULE", "PROVENANCE_UNVERIFIED",
    "PROVENANCE_VERIFIED", "PROVENANCE_WITHHELD", "RADAR_VERSION", "SOURCE",
    "AmountAtStake", "Basis", "FactProvenance", "MultiLane", "PeriodInput",
    "RadarCache", "RadarRequest", "RowProvenance", "Served", "SingleLane",
    "amount_at_stake", "cache_key", "canonical_bytes", "compose",
    "consecutive_periods", "dismissal_set_key", "finding_id", "gateway_for",
    "rank_inputs_for", "resolve_basis", "retain_dismissed_critical_groups",
    "root_cause_of", "run_multi_lane", "run_single_lane", "serve_cached",
    "serve_period", "snapshot_key", "strip_explanations", "verify_facts",
]
