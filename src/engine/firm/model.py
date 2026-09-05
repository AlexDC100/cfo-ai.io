"""THE ATTENTION ITEM, as a type — and the client record it is computed from.

    AttentionItem = {client, kind, severity, reason, evidence, due_at?, action}

Every field is computed by code from facts the engine already holds.
The evidence is a tuple of :class:`EvidenceFact` — a figure with its
unit, its currency and its provenance (period, snapshot, served row) —
so the frontend renders it through ``<Amount>`` and can jump to the cell.
Prose fields (``reason``, ``action``) carry NO figure a reader could
mistake for a computed number; figures travel typed, never inside a
sentence.

INPUT SHAPE. :class:`ClientRecord` is what the route (or a test) hands
the computation: the client's periods, each with its persisted
``assembled_canonical_v1`` envelope, plus the declared cadence and any
declared covenants. Statements (the assembled views the profile and the
findings engines read) may be supplied eagerly or through a provider
callable that is invoked only on a cache miss — that is what keeps the
board incremental.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

#: The evidence units an item may carry. Money converts for display;
#: everything else never does. ``date`` and ``text`` carry no number at
#: all — a period end is a label, not a figure.
UNIT_MONEY = "money"
UNIT_RATIO = "ratio"
UNIT_PERCENT = "percent"
UNIT_DAYS = "days"
UNIT_COUNT = "count"
UNIT_DATE = "date"
UNIT_TEXT = "text"

SEVERITIES = ("info", "low", "medium", "high", "critical")
SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}

#: The provenance source every served figure carries.
SOURCE_ENVELOPE = "assembled_canonical_v1"


# ── Inputs ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PeriodRecord:
    """One financial period of one client, as persisted.

    ``envelope`` is the persisted ``assembled_canonical_v1`` (None when
    the period row exists but carries no usable trial balance — a
    MISSING_FILE, not a zero). ``updated_at`` is an OPAQUE change signal
    (the row's own timestamp); it is hashed into the client's snapshot
    key and never parsed as a date.
    """

    period_id: str
    period_end: str                       # ISO date, the period's identity
    currency: str = "RON"
    period_start: Optional[str] = None    # ISO date; absent means unknown
    source_document_id: Optional[str] = None
    updated_at: str = ""
    envelope: Optional[Dict[str, Any]] = None
    statements: Optional[Dict[str, Any]] = None
    #: Lazy loaders, called only when the cache misses. A route can hand
    #: a LIGHT record (ids, timestamps, the envelope's content hash and
    #: whether one exists) and let the facts stage pull the heavy blobs
    #: for the clients that actually changed.
    envelope_provider: Optional[Callable[[], Optional[Dict[str, Any]]]] = field(
        default=None, compare=False, repr=False)
    statements_provider: Optional[Callable[[], Optional[Dict[str, Any]]]] = field(
        default=None, compare=False, repr=False)
    #: Explicit light-record facts. None -> derived from `envelope`.
    snapshot_hash: Optional[str] = None
    attached: Optional[bool] = None
    caen: Optional[str] = None
    label: str = ""

    def snapshot_id(self) -> Optional[str]:
        """The envelope's own content hash — the same id the
        FactsGateway stamps on every Fact — else the source document."""
        if self.snapshot_hash:
            return str(self.snapshot_hash)
        env = self.envelope if isinstance(self.envelope, dict) else {}
        prov = env.get("provenance")
        if isinstance(prov, dict):
            for key in ("content_hash", "source_document_id"):
                value = prov.get(key)
                if value:
                    return str(value)
        return self.source_document_id or None

    def load_envelope(self) -> Optional[Dict[str, Any]]:
        if isinstance(self.envelope, dict):
            return self.envelope
        if self.envelope_provider is not None:
            loaded = self.envelope_provider()
            return loaded if isinstance(loaded, dict) else None
        return None

    def load_statements(self) -> Optional[Dict[str, Any]]:
        if self.statements is not None:
            return self.statements
        if self.statements_provider is not None:
            return self.statements_provider()
        return None

    def has_trial_balance(self) -> bool:
        if self.attached is not None:
            return bool(self.attached)
        return isinstance(self.envelope, dict) and bool(self.envelope)


@dataclass(frozen=True)
class CovenantRecord:
    """A DECLARED covenant — the schema packs/firm/attention.yaml
    publishes under ``COVENANT_RISK.covenant_schema``. No covenant model
    existed before; with no records the kind emits nothing."""

    covenant_id: str
    label: str
    metric: str
    comparator: str                       # >=, >, <=, <
    limit: float
    unit: str = UNIT_MONEY
    headroom_warn_share: float = 0.10
    test_date: Optional[str] = None       # ISO date
    source: str = ""

    def to_payload(self) -> Dict[str, Any]:
        return {
            "covenant_id": self.covenant_id, "label": self.label,
            "metric": self.metric, "comparator": self.comparator,
            "limit": self.limit, "unit": self.unit,
            "headroom_warn_share": self.headroom_warn_share,
            "test_date": self.test_date, "source": self.source,
        }


@dataclass(frozen=True)
class ClientRecord:
    """One client company — a workspace/organization — and everything
    the attention computation may know about it."""

    client_id: str
    client_name: str
    jurisdiction: str                     # opaque; resolves a calendar by NAME
    periods: Tuple[PeriodRecord, ...] = ()
    #: The stored `firm_client_cadence` row for this client, or None for
    #: the pack default — resolved by engine.firm.cadence, never here.
    cadence_row: Optional[Dict[str, Any]] = None
    covenants: Tuple[CovenantRecord, ...] = ()

    def periods_desc(self) -> Tuple[PeriodRecord, ...]:
        """Newest first, ties broken by id — a stable order on every host."""
        return tuple(sorted(self.periods,
                            key=lambda p: (p.period_end, p.period_id),
                            reverse=True))

    def latest_attached(self) -> Optional[PeriodRecord]:
        for period in self.periods_desc():
            if period.has_trial_balance():
                return period
        return None


# ── Outputs ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class EvidenceFact:
    """One cited figure. ``value`` is the native number (money in the
    period's own currency, ratios dimensionless); ``text`` carries a
    non-numeric evidence such as a period end. Exactly one of the two is
    set. ``provenance`` names the period, the snapshot and the served
    row the figure came from."""

    fact: str
    label: str
    unit: str
    value: Optional[float] = None
    text: Optional[str] = None
    currency: Optional[str] = None
    provenance: Dict[str, Any] = field(default_factory=dict)

    def to_payload(self) -> Dict[str, Any]:
        return {
            "fact": self.fact, "label": self.label, "unit": self.unit,
            "value": self.value, "text": self.text, "currency": self.currency,
            "provenance": dict(self.provenance),
        }


@dataclass(frozen=True)
class Gap:
    """A kind that could NOT be evaluated for a client, and why. Recorded
    rather than swallowed: silence about a kind is only honest next to
    the reason it was silent."""

    kind: str
    reason: str
    period_id: Optional[str] = None

    def to_payload(self) -> Dict[str, Any]:
        return {"kind": self.kind, "reason": self.reason, "period_id": self.period_id}


@dataclass(frozen=True)
class AttentionItem:
    client_id: str
    kind: str
    severity: str
    reason: str
    action: str
    evidence: Tuple[EvidenceFact, ...]
    scope_key: str
    period_id: Optional[str] = None
    due_at: Optional[str] = None          # ISO date
    days_to_due: Optional[int] = None
    base_severity: str = "medium"
    severity_breakdown: Dict[str, Any] = field(default_factory=dict)
    materiality: Optional[Dict[str, Any]] = None
    materiality_refusal: Optional[str] = None
    persistence: int = 1
    source: str = ""                      # attention.yaml address of the rule
    suppression: Optional[Dict[str, Any]] = None
    suppressed_but_retained: bool = False

    def severity_rank(self) -> int:
        return SEVERITY_RANK.get(self.severity, 9)

    def to_payload(self) -> Dict[str, Any]:
        return {
            "client_id": self.client_id,
            "kind": self.kind,
            "severity": self.severity,
            "reason": self.reason,
            "action": self.action,
            "evidence": [e.to_payload() for e in self.evidence],
            "scope_key": self.scope_key,
            "period_id": self.period_id,
            "due_at": self.due_at,
            "days_to_due": self.days_to_due,
            "base_severity": self.base_severity,
            "severity_breakdown": dict(self.severity_breakdown),
            "materiality": (dict(self.materiality) if self.materiality else None),
            "materiality_refusal": self.materiality_refusal,
            "persistence": self.persistence,
            "source": self.source,
            "suppression": (dict(self.suppression) if self.suppression else None),
            "suppressed_but_retained": self.suppressed_but_retained,
        }


def money_evidence(fact: str, label: str, value: float, currency: str,
                   period_id: str, snapshot_id: Optional[str],
                   line_id: Optional[str] = None) -> EvidenceFact:
    return EvidenceFact(
        fact=fact, label=label, unit=UNIT_MONEY, value=float(value),
        currency=(currency or "RON").upper(),
        provenance={"period_id": period_id, "snapshot_id": snapshot_id,
                    "line_id": line_id, "source": SOURCE_ENVELOPE})


def number_evidence(fact: str, label: str, unit: str, value: float,
                    period_id: Optional[str], snapshot_id: Optional[str],
                    source: str = SOURCE_ENVELOPE) -> EvidenceFact:
    return EvidenceFact(
        fact=fact, label=label, unit=unit, value=float(value),
        provenance={"period_id": period_id, "snapshot_id": snapshot_id,
                    "line_id": None, "source": source})


def text_evidence(fact: str, label: str, text: str, unit: str = UNIT_TEXT,
                  period_id: Optional[str] = None,
                  snapshot_id: Optional[str] = None,
                  source: str = SOURCE_ENVELOPE) -> EvidenceFact:
    return EvidenceFact(
        fact=fact, label=label, unit=unit, text=str(text),
        provenance={"period_id": period_id, "snapshot_id": snapshot_id,
                    "line_id": None, "source": source})


__all__ = [
    "AttentionItem", "ClientRecord", "CovenantRecord", "EvidenceFact", "Gap",
    "PeriodRecord", "SEVERITIES", "SEVERITY_RANK", "SOURCE_ENVELOPE",
    "UNIT_COUNT", "UNIT_DATE", "UNIT_DAYS", "UNIT_MONEY", "UNIT_PERCENT",
    "UNIT_RATIO", "UNIT_TEXT", "money_evidence", "number_evidence",
    "text_evidence",
]
