"""The ONE priority order, the digest, and the item view they share —
engine.firm.digest.

WHAT THIS FILE IS
  The CONSUMER side of the attention board. `engine.firm.attention`
  computes the items (one detector per kind, DATA in
  packs/firm/attention.yaml); `engine.firm.dedup` ranks them per client
  row. This file takes that report and produces the two things a person
  reads away from the board — the daily digest (per accountant, new
  items since the last one) and the flat priority order the "brief me"
  role narrates over — from the SAME ranking the board uses, so no
  surface disagrees with another about what comes first.

THREE THINGS LIVE HERE
  1. THE ITEM VIEW — `AttentionItem` (this module's) is the read-only
     projection of `engine.firm.model.AttentionItem` a digest line or a
     brief paragraph needs: an id, the client's name, the engine-authored
     `reason`, the typed evidence facts (money with currency, ratios,
     counts, date/text labels — each with its provenance), the due date,
     the suppression flag, the kind's pack order. `coerce_item` is the
     only validator; an item that does not meet the contract is REFUSED
     WITH A REASON and recorded, never silently dropped.
  2. THE PRIORITY ORDER — `deterministic_order` / `group_items`. Severity,
     then days to due (overdue first, no deadline last), then the pack's
     kind order, then client name, then id: the board's own key
     (`engine.firm.dedup.item_sort_key`), flattened across clients. No
     model is consulted and no model may reorder it;
     `assert_no_model_in_critical_path` scans this file and cadence.py
     for any AI import or client token so the property is structural.
  3. THE DIGEST — plain language, deep links as ROUTE STRINGS ONLY (the
     frontend owns the routes), deterministic bytes for the same items
     and the same `as_of`. "New since the last digest" is decided against
     the item ids the previous digest carried (persisted per accountant),
     never against a clock.

FIGURES. `reason` and `action` are prose the detectors authored WITHOUT
figures (engine.firm.model's rule). Figures travel typed in `evidence`
and are rendered here from their own unit and currency, each traceable
to its fact id and provenance (`facts_used` on every line). A fact that
cannot be rendered is stated as withheld, never guessed.

AI enters the digest in exactly ONE place: `AiSummary`, a single labeled
line that engine.api._firm_brief produces AFTER guarding it through the
numeral guard and that this file only attaches; a line without the
guard's receipt, or carrying a digit no fact backs, is refused here too.

Python 3.9 — no `match`, no `X | Y` unions. Stdlib only at import.
"""
from __future__ import annotations

import ast
import hashlib
import html as _html
import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from . import model as _model

# ── Vocabulary ───────────────────────────────────────────────────────────

SEVERITIES = ("critical", "high", "medium", "low", "info")
SEVERITY_RANK = dict(_model.SEVERITY_RANK)

#: The one kind THIS lane emits (an open file request); every other kind
#: is a detector in engine.firm.attention.
KIND_FILE_REQUESTED = "FILE_REQUESTED"

_KIND_RX = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
_ITEM_ID_RX = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._@+/ -]{0,299}$")
_DIGIT_RX = re.compile(r"\d")

FACT_KINDS = ("money", "ratio", "count", "label")

#: Route templates — STRINGS ONLY. The frontend owns what they render.
ROUTE_CLIENT = "/firm/clients/{client_org_id}"
ROUTE_ITEM = "/firm/clients/{client_org_id}/attention/{item_id}"
ROUTE_REQUESTS = "/firm/clients/{client_org_id}/requests"

#: Group titles (plain language, no numerals).
GROUP_ACT_NOW = ("act_now", "Act now")
GROUP_THIS_WEEK = ("this_week", "This week")
GROUP_LATER = ("later", "Everything else")

#: "This week" horizon, in days from `as_of`.
WEEK_HORIZON_DAYS = 7

_NO_DEADLINE = 10 ** 6
_NO_KIND_RANK = 999


class ItemContractError(ValueError):
    """An attention item does not meet the contract. Carries the reason a
    person can read; the caller records it beside the item id."""


class CriticalPathViolation(AssertionError):
    """A model reached the ranking / severity / suppression path."""


# ── Typed facts ──────────────────────────────────────────────────────────


def _group(value: float, decimals: int) -> str:
    return ("{:,.%df}" % decimals).format(value)


@dataclass(frozen=True)
class ItemFact:
    """One typed fact an item carries. `kind` fixes how it renders; money
    carries its currency with it (a money fact without one cannot be
    constructed). `label_text` is the evidence's human label; `provenance`
    is the period / snapshot / served row the figure came from."""

    name: str
    kind: str
    amount: Optional[float] = None
    currency: Optional[str] = None
    value: Optional[float] = None
    style: str = "ratio"        # ratio | pct | multiple (kind == ratio)
    unit: str = ""              # kind == count
    text: Optional[str] = None  # kind == label
    label_text: str = ""
    provenance: Dict[str, Any] = field(default_factory=dict)

    def is_absent(self) -> bool:
        if self.kind == "money":
            return self.amount is None
        if self.kind == "label":
            return self.text is None or not str(self.text).strip()
        return self.value is None

    def render(self) -> str:
        if self.is_absent():
            raise ItemContractError("fact %r is absent — absent is not zero" % self.name)
        if self.kind == "money":
            return "%s %s" % (str(self.currency).upper(), _group(float(self.amount), 2))
        if self.kind == "ratio":
            v = float(self.value)
            if self.style == "multiple":
                return "%s×" % _group(v, 2)
            if self.style == "pct":
                return "%s%%" % _group(v, 1)
            return "%s%%" % _group(v * 100.0, 1)
        if self.kind == "count":
            v = float(self.value)
            body = _group(v, 0) if v.is_integer() else _group(v, 2)
            return ("%s %s" % (body, self.unit)).strip()
        return str(self.text)

    def to_payload(self) -> Dict[str, Any]:
        out = {"kind": self.kind, "label": self.label_text,
               "provenance": dict(self.provenance)}  # type: Dict[str, Any]
        if self.kind == "money":
            out["amount"] = self.amount
            out["currency"] = self.currency
        elif self.kind == "label":
            out["text"] = self.text
        else:
            out["value"] = self.value
            if self.kind == "ratio":
                out["style"] = self.style
            else:
                out["unit"] = self.unit
        return out


def _number(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        f = float(value)
        return f if f == f and f not in (float("inf"), float("-inf")) else None
    return None


def coerce_fact(name: str, raw: Any) -> ItemFact:
    """A fact in THIS module's shape ({kind, ...})."""
    if not isinstance(raw, dict):
        raise ItemContractError("fact %r must be a mapping with a 'kind'" % name)
    kind = raw.get("kind")
    if kind not in FACT_KINDS:
        raise ItemContractError("fact %r has unknown kind %r (known: %s)"
                                % (name, kind, ", ".join(FACT_KINDS)))
    label = str(raw.get("label") or "")
    prov = raw.get("provenance") if isinstance(raw.get("provenance"), dict) else {}
    if kind == "money":
        currency = raw.get("currency")
        if not isinstance(currency, str) or not currency.strip():
            raise ItemContractError("money fact %r carries no currency" % name)
        amount = raw.get("amount")
        if amount is not None and _number(amount) is None:
            raise ItemContractError("money fact %r amount is not a number" % name)
        return ItemFact(name=name, kind="money", amount=_number(amount),
                        currency=currency.strip().upper(), label_text=label,
                        provenance=dict(prov))
    if kind == "label":
        text = raw.get("text")
        return ItemFact(name=name, kind="label",
                        text=(None if text is None else str(text)),
                        label_text=label, provenance=dict(prov))
    value = raw.get("value")
    if value is not None and _number(value) is None:
        raise ItemContractError("%s fact %r value is not a number" % (kind, name))
    if kind == "ratio":
        style = raw.get("style") or "ratio"
        if style not in ("ratio", "pct", "multiple"):
            raise ItemContractError("ratio fact %r has unknown style %r" % (name, style))
        return ItemFact(name=name, kind="ratio", value=_number(value), style=str(style),
                        label_text=label, provenance=dict(prov))
    return ItemFact(name=name, kind="count", value=_number(value),
                    unit=str(raw.get("unit") or ""), label_text=label,
                    provenance=dict(prov))


def fact_from_evidence(raw: Any) -> ItemFact:
    """An `engine.firm.model.EvidenceFact` (or its payload) as a typed
    fact. Units map by the model's own vocabulary; a unit the model does
    not declare is a refusal, not a guess."""
    if isinstance(raw, _model.EvidenceFact):
        raw = raw.to_payload()
    if not isinstance(raw, dict):
        raise ItemContractError("evidence must be an EvidenceFact or its payload")
    name = str(raw.get("fact") or "").strip()
    if not name:
        raise ItemContractError("evidence carries no fact name")
    unit = raw.get("unit")
    label = str(raw.get("label") or "")
    prov = raw.get("provenance") if isinstance(raw.get("provenance"), dict) else {}
    value = raw.get("value")
    if value is not None and _number(value) is None:
        raise ItemContractError("evidence %r value is not a number" % name)
    if unit == _model.UNIT_MONEY:
        currency = raw.get("currency")
        if not isinstance(currency, str) or not currency.strip():
            raise ItemContractError("money evidence %r carries no currency" % name)
        return ItemFact(name=name, kind="money", amount=_number(value),
                        currency=currency.strip().upper(), label_text=label,
                        provenance=dict(prov))
    if unit == _model.UNIT_PERCENT:
        return ItemFact(name=name, kind="ratio", value=_number(value), style="ratio",
                        label_text=label, provenance=dict(prov))
    if unit == _model.UNIT_RATIO:
        return ItemFact(name=name, kind="ratio", value=_number(value), style="multiple",
                        label_text=label, provenance=dict(prov))
    if unit == _model.UNIT_DAYS:
        return ItemFact(name=name, kind="count", value=_number(value), unit="days",
                        label_text=label, provenance=dict(prov))
    if unit == _model.UNIT_COUNT:
        return ItemFact(name=name, kind="count", value=_number(value),
                        label_text=label, provenance=dict(prov))
    if unit in (_model.UNIT_DATE, _model.UNIT_TEXT):
        text = raw.get("text")
        return ItemFact(name=name, kind="label",
                        text=(None if text is None else str(text)),
                        label_text=label, provenance=dict(prov))
    raise ItemContractError("evidence %r has a unit the model does not declare: %r"
                            % (name, unit))


def render_evidence_line(facts: Sequence[ItemFact]) -> Tuple[str, Tuple[str, ...], List[str]]:
    """`label value; label value` for every renderable fact, the names
    used, and the names withheld (absent, so not printed)."""
    parts = []  # type: List[str]
    used = []  # type: List[str]
    withheld = []  # type: List[str]
    for fact in facts:
        try:
            rendered = fact.render()
        except ItemContractError:
            withheld.append(fact.name)
            continue
        parts.append(("%s %s" % (fact.label_text, rendered)).strip()
                     if fact.label_text else rendered)
        used.append(fact.name)
    return "; ".join(parts), tuple(used), withheld


# ── The item view ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AttentionItem:
    """The read-only projection of one board item. `reason` and `action`
    are the detector's prose (no figures by construction); `facts` are
    the typed evidence; `evidence_line` is the rendered evidence."""

    item_id: str
    kind: str
    severity: str
    client_org_id: str
    client_name: str
    reason: str
    route: str
    action: str = ""
    facts: Tuple[ItemFact, ...] = ()
    evidence_line: str = ""
    facts_used: Tuple[str, ...] = ()
    figures_withheld: Tuple[str, ...] = ()
    due_by: Optional[date] = None
    detected_at: Optional[str] = None
    dismissed: bool = False
    kind_rank: int = _NO_KIND_RANK
    #: Everything the producer wants carried through: source, period id,
    #: scope key, severity breakdown, materiality. Never read for ranking.
    provenance: Dict[str, Any] = field(default_factory=dict)

    @property
    def headline(self) -> str:
        if self.evidence_line:
            return "%s — %s" % (self.reason, self.evidence_line)
        return self.reason

    def fact(self, name: str) -> Optional[ItemFact]:
        for f in self.facts:
            if f.name == name:
                return f
        return None

    def to_payload(self) -> Dict[str, Any]:
        return {
            "item_id": self.item_id,
            "kind": self.kind,
            "severity": self.severity,
            "client_org_id": self.client_org_id,
            "client_name": self.client_name,
            "reason": self.reason,
            "action": self.action,
            "headline": self.headline,
            "evidence_line": self.evidence_line,
            "route": self.route,
            "facts": dict((f.name, f.to_payload()) for f in self.facts),
            "facts_used": list(self.facts_used),
            "figures_withheld": list(self.figures_withheld),
            "due_by": self.due_by.isoformat() if self.due_by else None,
            "detected_at": self.detected_at,
            "dismissed": self.dismissed,
            "kind_rank": self.kind_rank,
            "provenance": dict(self.provenance),
        }


def _opt_date(value: Any, what: str) -> Optional[date]:
    if value is None or value == "":
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        raise ItemContractError("%s is not a date: %r" % (what, value))


def _opt_iso(value: Any, what: str) -> Optional[str]:
    if value is None or value == "":
        return None
    text = str(value)
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise ItemContractError("%s is not an ISO timestamp: %r" % (what, value))
    return text


def board_item_id(kind: str, client_id: str, scope_key: str) -> str:
    """The stable id of a board item: kind, client, scope — the same
    triple the board's suppression index is keyed on."""
    return "%s:%s:%s" % (kind, client_id, scope_key)


def _is_board_payload(raw: Dict[str, Any]) -> bool:
    return "client_id" in raw and "scope_key" in raw and "reason" in raw


def _from_board(raw: Dict[str, Any], client_names: Dict[str, str],
                kind_order: Dict[str, int]) -> AttentionItem:
    kind = str(raw.get("kind") or "").strip()
    client_id = str(raw.get("client_id") or "").strip()
    scope_key = str(raw.get("scope_key") or "").strip()
    if not _KIND_RX.match(kind):
        raise ItemContractError("board item: kind %r is not an UPPER_SNAKE identifier" % kind)
    if not client_id:
        raise ItemContractError("board item %s: client_id is required" % kind)
    if not scope_key:
        raise ItemContractError("board item %s for %s: scope_key is required" % (kind, client_id))
    item_id = board_item_id(kind, client_id, scope_key)
    severity = str(raw.get("severity") or "").strip().lower()
    if severity not in SEVERITY_RANK:
        raise ItemContractError("item %s: severity %r is not one of %s"
                                % (item_id, severity, ", ".join(SEVERITIES)))
    client_name = str(raw.get("client_name") or client_names.get(client_id) or "").strip()
    if not client_name:
        raise ItemContractError("item %s: no client name is known for %s"
                                % (item_id, client_id))
    reason = str(raw.get("reason") or "").strip()
    if not reason:
        raise ItemContractError("item %s: reason is required" % item_id)
    facts = tuple(fact_from_evidence(e) for e in (raw.get("evidence") or ()))
    line, used, withheld = render_evidence_line(facts)
    suppression = raw.get("suppression")
    dismissed = bool(raw.get("suppressed_but_retained")) or (
        isinstance(suppression, dict) and bool(suppression))
    return AttentionItem(
        item_id=item_id, kind=kind, severity=severity,
        client_org_id=client_id, client_name=client_name, reason=reason,
        action=str(raw.get("action") or "").strip(),
        route=ROUTE_ITEM.format(client_org_id=client_id, item_id=item_id),
        facts=facts, evidence_line=line, facts_used=used,
        figures_withheld=tuple(withheld),
        due_by=_opt_date(raw.get("due_at"), "item %s due_at" % item_id),
        detected_at=_opt_iso(raw.get("detected_at"), "item %s detected_at" % item_id),
        dismissed=dismissed,
        kind_rank=int(raw.get("kind_rank", kind_order.get(kind, _NO_KIND_RANK))),
        provenance={
            "source": raw.get("source"),
            "period_id": raw.get("period_id"),
            "scope_key": scope_key,
            "base_severity": raw.get("base_severity"),
            "severity_breakdown": dict(raw.get("severity_breakdown") or {}),
            "materiality": raw.get("materiality"),
            "materiality_refusal": raw.get("materiality_refusal"),
            "persistence": raw.get("persistence"),
            "suppression": suppression,
        },
    )


def _from_view(raw: Dict[str, Any], client_names: Dict[str, str],
               kind_order: Dict[str, int]) -> AttentionItem:
    """This module's own shape (an `AttentionItem.to_payload()`, or a
    producer writing it directly — the file-request item does)."""
    item_id = str(raw.get("item_id") or "").strip()
    if not _ITEM_ID_RX.match(item_id):
        raise ItemContractError("item_id %r is missing or malformed" % item_id)
    kind = str(raw.get("kind") or "").strip()
    if not _KIND_RX.match(kind):
        raise ItemContractError("item %s: kind %r is not an UPPER_SNAKE identifier"
                                % (item_id, kind))
    severity = str(raw.get("severity") or "").strip().lower()
    if severity not in SEVERITY_RANK:
        raise ItemContractError("item %s: severity %r is not one of %s"
                                % (item_id, severity, ", ".join(SEVERITIES)))
    client_id = str(raw.get("client_org_id") or "").strip()
    if not client_id:
        raise ItemContractError("item %s: client_org_id is required" % item_id)
    client_name = str(raw.get("client_name") or client_names.get(client_id) or "").strip()
    if not client_name:
        raise ItemContractError("item %s: no client name is known for %s"
                                % (item_id, client_id))
    route = str(raw.get("route") or "").strip()
    if not route.startswith("/"):
        raise ItemContractError("item %s: route must be a path string starting with '/'"
                                % item_id)
    reason = str(raw.get("reason") or "").strip()
    if not reason:
        raise ItemContractError("item %s: reason is required" % item_id)
    facts_raw = raw.get("facts") or {}
    if not isinstance(facts_raw, dict):
        raise ItemContractError("item %s: facts must be a mapping" % item_id)
    facts = tuple(coerce_fact(str(name), fact_raw)
                  for name, fact_raw in facts_raw.items())
    line, used, withheld = render_evidence_line(facts)
    provenance = raw.get("provenance") or {}
    if not isinstance(provenance, dict):
        raise ItemContractError("item %s: provenance must be a mapping" % item_id)
    return AttentionItem(
        item_id=item_id, kind=kind, severity=severity,
        client_org_id=client_id, client_name=client_name, reason=reason,
        action=str(raw.get("action") or "").strip(), route=route,
        facts=facts, evidence_line=line, facts_used=used,
        figures_withheld=tuple(withheld),
        due_by=_opt_date(raw.get("due_by"), "item %s due_by" % item_id),
        detected_at=_opt_iso(raw.get("detected_at"), "item %s detected_at" % item_id),
        dismissed=bool(raw.get("dismissed", False)),
        kind_rank=int(raw.get("kind_rank", kind_order.get(kind, _NO_KIND_RANK))),
        provenance=dict(provenance),
    )


def coerce_item(raw: Any, client_names: Optional[Dict[str, str]] = None,
                kind_order: Optional[Dict[str, int]] = None) -> AttentionItem:
    """The ONE validator. Accepts a board item (`engine.firm.model
    .AttentionItem` or its payload), this module's own item (or payload),
    and returns a frozen view — or raises ItemContractError."""
    names = client_names or {}
    order = kind_order or {}
    if isinstance(raw, AttentionItem):
        return raw
    if isinstance(raw, _model.AttentionItem):
        raw = raw.to_payload()
    if not isinstance(raw, dict):
        raise ItemContractError("an attention item must be a mapping")
    if _is_board_payload(raw):
        return _from_board(raw, names, order)
    return _from_view(raw, names, order)


@dataclass(frozen=True)
class Refusal:
    index: int
    item_id: Optional[str]
    reason: str

    def to_payload(self) -> Dict[str, Any]:
        return {"index": self.index, "item_id": self.item_id, "reason": self.reason}


def coerce_items(raws: Iterable[Any], client_names: Optional[Dict[str, str]] = None,
                 kind_order: Optional[Dict[str, int]] = None
                 ) -> Tuple[List[AttentionItem], List[Refusal]]:
    """Every item that meets the contract, plus every refusal WITH its
    reason. Duplicate ids are refused: two items with one id would let a
    later one silently replace an earlier one."""
    items = []  # type: List[AttentionItem]
    refusals = []  # type: List[Refusal]
    seen = set()  # type: set
    for index, raw in enumerate(raws):
        try:
            item = coerce_item(raw, client_names, kind_order)
        except ItemContractError as exc:
            raw_id = None
            if isinstance(raw, dict):
                raw_id = raw.get("item_id") or (
                    board_item_id(str(raw.get("kind")), str(raw.get("client_id")),
                                  str(raw.get("scope_key")))
                    if _is_board_payload(raw) else None)
            refusals.append(Refusal(index, (str(raw_id) if raw_id else None), str(exc)))
            continue
        if item.item_id in seen:
            refusals.append(Refusal(index, item.item_id, "duplicate item_id"))
            continue
        seen.add(item.item_id)
        items.append(item)
    return items, refusals


def kind_order_from_report(report: Any) -> Dict[str, int]:
    """The pack's kind order as the board payload publishes it
    (`pack.kinds` is already sorted by order)."""
    pack = getattr(report, "pack_payload", None)
    if pack is None and isinstance(report, dict):
        pack = report.get("pack")
    kinds = (pack or {}).get("kinds") if isinstance(pack, dict) else None
    if not isinstance(kinds, list):
        return {}
    return dict((str(k), i) for i, k in enumerate(kinds))


def items_from_report(report: Any) -> Tuple[List[AttentionItem], List[Refusal]]:
    """Every kept item on a `FirmAttentionReport` (or its payload), as
    views, in the board's own order. Suppressed non-critical items are
    NOT here — the board already moved them to `suppressed` with their
    reason; a critical one stays, flagged."""
    order = kind_order_from_report(report)
    rows = getattr(report, "rows", None)
    if rows is None and isinstance(report, dict):
        rows = report.get("clients") or ()
    raws = []  # type: List[Any]
    names = {}  # type: Dict[str, str]
    for row in rows or ():
        client_id = str(getattr(row, "client_id", None) or
                        (row.get("client_id") if isinstance(row, dict) else "") or "")
        client_name = str(getattr(row, "client_name", None) or
                          (row.get("client_name") if isinstance(row, dict) else "") or "")
        if client_id:
            names[client_id] = client_name
        for item in (getattr(row, "items", None) or
                     (row.get("items") if isinstance(row, dict) else ()) or ()):
            raws.append(item)
    return coerce_items(raws, names, order)


# ── The one item THIS lane produces ──────────────────────────────────────


def item_for_open_request(request: Dict[str, Any], client_name: str,
                          as_of: date) -> AttentionItem:
    """FILE_REQUESTED for an open file request (a `firm_file_requests`
    row). The prose carries no figure; the age and the reminder count
    travel as typed counts."""
    requested_at = str(request.get("requested_at") or "")[:10]
    age = None  # type: Optional[int]
    try:
        age = (as_of - date.fromisoformat(requested_at)).days
    except ValueError:
        age = None
    facts = {
        "period_end": {"kind": "label", "label": "period requested",
                       "text": str(request.get("period_end") or "")[:10] or None,
                       "provenance": {"source": "firm_file_requests",
                                      "request_id": request.get("id")}},
    }  # type: Dict[str, Any]
    if age is not None:
        facts["requested_ago_days"] = {"kind": "count", "label": "requested",
                                       "value": age, "unit": "day(s) ago",
                                       "provenance": {"source": "firm_file_requests",
                                                      "field": "requested_at"}}
    reminders = request.get("reminder_count")
    if isinstance(reminders, int) and not isinstance(reminders, bool):
        facts["reminders_sent"] = {"kind": "count", "label": "reminders sent",
                                   "value": reminders,
                                   "provenance": {"source": "firm_file_requests",
                                                  "field": "reminder_count"}}
    client_id = str(request.get("client_org_id") or "")
    return coerce_item({
        "item_id": "%s:%s:request:%s" % (KIND_FILE_REQUESTED, client_id, request.get("id")),
        "kind": KIND_FILE_REQUESTED,
        "severity": "low" if (age or 0) < 7 else "medium",
        "client_org_id": client_id,
        "client_name": client_name,
        "reason": "A trial balance was requested from the client and no file has landed",
        "action": "Chase the client, or revoke and re-issue the request link",
        "facts": facts,
        "due_by": str(request.get("expires_at") or "")[:10] or None,
        "route": ROUTE_REQUESTS.format(client_org_id=client_id),
        "detected_at": request.get("requested_at"),
        "provenance": {"source": "firm_file_requests", "request_id": request.get("id"),
                       "status": request.get("status")},
    })


# ── THE PRIORITY ORDER — no model here, ever ─────────────────────────────


def due_status(item: AttentionItem, as_of: date) -> Tuple[int, int]:
    """(rank, days). rank 0 = overdue, 1 = due within the week, 2 = due
    later, 3 = no due date. `days` is signed distance to `due_by`."""
    if item.due_by is None:
        return 3, _NO_DEADLINE
    days = (item.due_by - as_of).days
    if days < 0:
        return 0, days
    if days <= WEEK_HORIZON_DAYS:
        return 1, days
    return 2, days


def priority_key(item: AttentionItem, as_of: date) -> Tuple[int, int, int, str, str]:
    """The board's key (severity, days to due, kind order, then identity),
    flattened across clients: client name and id break the last ties."""
    _rank, days = due_status(item, as_of)
    return (SEVERITY_RANK[item.severity], days, item.kind_rank,
            item.client_name.lower(), item.item_id)


def deterministic_order(items: Iterable[AttentionItem], as_of: date) -> List[AttentionItem]:
    """Severity first, then days to due (overdue first, no deadline
    last), then the pack's kind order, then client name, then id. A
    dismissed CRITICAL keeps its place — dismissal never reorders, it
    flags (the finding-rank law, applied here)."""
    return sorted(items, key=lambda it: priority_key(it, as_of))


def priority_rationale(item: AttentionItem, as_of: date) -> str:
    """Why this item sits where it sits — plain language, engine text."""
    rank, days = due_status(item, as_of)
    parts = ["%s severity" % item.severity]
    if rank == 0:
        parts.append("overdue by %d day(s)" % (-days))
    elif rank == 1:
        parts.append("due today" if days == 0 else "due in %d day(s)" % days)
    elif rank == 2:
        parts.append("due in %d day(s)" % days)
    else:
        parts.append("no due date")
    if item.dismissed:
        parts.append("dismissed with a recorded reason but kept visible")
    if item.figures_withheld:
        parts.append("some figures withheld")
    return "; ".join(parts)


@dataclass(frozen=True)
class Group:
    key: str
    title: str
    items: Tuple[AttentionItem, ...]

    def to_payload(self) -> Dict[str, Any]:
        return {"key": self.key, "title": self.title,
                "item_ids": [it.item_id for it in self.items]}


def group_items(ordered: Sequence[AttentionItem], as_of: date) -> List[Group]:
    """Three fixed groups over the deterministic order. Membership is a
    function of severity and due date only; order within a group is the
    deterministic order, untouched."""
    act_now = []  # type: List[AttentionItem]
    this_week = []  # type: List[AttentionItem]
    later = []  # type: List[AttentionItem]
    for item in ordered:
        rank, _days = due_status(item, as_of)
        if item.severity == "critical" or rank == 0:
            act_now.append(item)
        elif item.severity == "high" or rank == 1:
            this_week.append(item)
        else:
            later.append(item)
    return [Group(GROUP_ACT_NOW[0], GROUP_ACT_NOW[1], tuple(act_now)),
            Group(GROUP_THIS_WEEK[0], GROUP_THIS_WEEK[1], tuple(this_week)),
            Group(GROUP_LATER[0], GROUP_LATER[1], tuple(later))]


def item_set_hash(items: Iterable[AttentionItem]) -> str:
    """Identity of a set of items for caching: ids, severities, due
    dates, headlines and dismissal flags — everything a brief or a
    digest could say something about."""
    rows = sorted(
        [it.item_id, it.severity, it.due_by.isoformat() if it.due_by else "",
         it.headline, it.client_org_id, "1" if it.dismissed else "0"]
        for it in items)
    blob = json.dumps(rows, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# ── The digest ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AiSummary:
    """The ONE labeled line a model may add to a digest. Constructed by
    engine.api._firm_brief AFTER the numeral guard accepted the text;
    `guarded` is that receipt and `attach_ai_summary` refuses a line
    without it."""

    available: bool
    text: str = ""
    label: str = "AI summary (advisory)"
    reason: str = ""
    guarded: bool = False
    facts_used: Tuple[str, ...] = ()

    def to_payload(self) -> Dict[str, Any]:
        return {"available": self.available, "text": self.text, "label": self.label,
                "reason": self.reason, "facts_used": list(self.facts_used)}


def unavailable_summary(reason: str) -> AiSummary:
    return AiSummary(available=False, reason=reason)


@dataclass(frozen=True)
class DigestLine:
    item_id: str
    client_org_id: str
    client_name: str
    kind: str
    severity: str
    text: str
    evidence: str
    action: str
    route: str
    due_by: Optional[date]
    is_new: bool
    dismissed: bool
    rationale: str
    facts_used: Tuple[str, ...]
    figures_withheld: Tuple[str, ...]

    def to_payload(self) -> Dict[str, Any]:
        return {
            "item_id": self.item_id, "client_org_id": self.client_org_id,
            "client_name": self.client_name, "kind": self.kind,
            "severity": self.severity, "text": self.text,
            "evidence": self.evidence, "action": self.action, "route": self.route,
            "due_by": self.due_by.isoformat() if self.due_by else None,
            "is_new": self.is_new, "dismissed": self.dismissed,
            "rationale": self.rationale, "facts_used": list(self.facts_used),
            "figures_withheld": list(self.figures_withheld),
        }


@dataclass(frozen=True)
class ClientSection:
    client_org_id: str
    client_name: str
    route: str
    lines: Tuple[DigestLine, ...]

    def to_payload(self) -> Dict[str, Any]:
        return {"client_org_id": self.client_org_id, "client_name": self.client_name,
                "route": self.route, "lines": [ln.to_payload() for ln in self.lines]}


@dataclass(frozen=True)
class Digest:
    user_id: str
    firm_key: str
    as_of: date
    seen_ids: Tuple[str, ...]
    item_ids: Tuple[str, ...]
    item_set_hash: str
    sections: Tuple[ClientSection, ...]
    counts: Dict[str, int]
    refusals: Tuple[Refusal, ...]
    ai_summary: AiSummary

    @property
    def is_empty(self) -> bool:
        return self.counts.get("shown", 0) == 0

    def to_payload(self) -> Dict[str, Any]:
        return {
            "user_id": self.user_id,
            "firm_key": self.firm_key,
            "as_of": self.as_of.isoformat(),
            "item_ids": list(self.item_ids),
            "seen_ids": list(self.seen_ids),
            "item_set_hash": self.item_set_hash,
            "sections": [s.to_payload() for s in self.sections],
            "counts": dict(self.counts),
            "refusals": [r.to_payload() for r in self.refusals],
            "ai_summary": self.ai_summary.to_payload(),
            "subject": digest_subject(self),
        }


def build_digest(raw_items: Iterable[Any], as_of: Any,
                 seen_ids: Optional[Iterable[str]] = None,
                 user_id: str = "", firm_key: str = "",
                 client_names: Optional[Dict[str, str]] = None,
                 kind_order: Optional[Dict[str, int]] = None,
                 include_seen: bool = False) -> Digest:
    """The digest for one accountant. Items are coerced (refusals kept),
    filtered to those NOT in `seen_ids` — the ids the previous digest
    carried (None == no previous digest: everything is new) — unless
    `include_seen`, put in the deterministic order, and grouped by client
    in first-appearance order of that ranking, so the client with the
    most urgent item leads. No AI summary is attached here; see
    `attach_ai_summary`."""
    day = as_of if isinstance(as_of, date) else date.fromisoformat(str(as_of)[:10])
    items, refusals = coerce_items(raw_items, client_names, kind_order)
    seen = tuple(sorted(set(str(s) for s in (seen_ids or ()))))
    seen_set = set(seen)
    ordered = deterministic_order(items, day)
    chosen = [it for it in ordered if include_seen or it.item_id not in seen_set]

    sections = []  # type: List[ClientSection]
    by_client = {}  # type: Dict[str, List[DigestLine]]
    names = {}  # type: Dict[str, str]
    order = []  # type: List[str]
    for it in chosen:
        if it.client_org_id not in by_client:
            by_client[it.client_org_id] = []
            names[it.client_org_id] = it.client_name
            order.append(it.client_org_id)
        by_client[it.client_org_id].append(DigestLine(
            item_id=it.item_id, client_org_id=it.client_org_id,
            client_name=it.client_name, kind=it.kind, severity=it.severity,
            text=it.reason, evidence=it.evidence_line, action=it.action,
            route=it.route, due_by=it.due_by,
            is_new=it.item_id not in seen_set, dismissed=it.dismissed,
            rationale=priority_rationale(it, day), facts_used=it.facts_used,
            figures_withheld=it.figures_withheld))
    for org_id in order:
        sections.append(ClientSection(
            client_org_id=org_id, client_name=names[org_id],
            route=ROUTE_CLIENT.format(client_org_id=org_id),
            lines=tuple(by_client[org_id])))
    counts = {
        "items": len(items),
        "new": len([it for it in ordered if it.item_id not in seen_set]),
        "shown": len(chosen),
        "clients": len(sections),
        "refused": len(refusals),
        "critical": len([it for it in chosen if it.severity == "critical"]),
        "overdue": len([it for it in chosen if due_status(it, day)[0] == 0]),
        "dismissed_kept": len([it for it in chosen if it.dismissed]),
    }
    return Digest(
        user_id=user_id, firm_key=firm_key, as_of=day, seen_ids=seen,
        item_ids=tuple(it.item_id for it in ordered),
        item_set_hash=item_set_hash(items), sections=tuple(sections),
        counts=counts, refusals=tuple(refusals),
        ai_summary=unavailable_summary("no advisory summary was requested"),
    )


def attach_ai_summary(digest: Digest, summary: AiSummary) -> Digest:
    """Attach the one labeled line. A summary that was not guarded, or
    that carries a digit no resolved fact backs, is refused here as well
    — this file is the last hand before the reader."""
    if summary.available:
        if not summary.guarded:
            return _with_summary(digest, unavailable_summary(
                "the advisory line was not passed through the numeral guard"))
        if _DIGIT_RX.search(summary.text or "") and not summary.facts_used:
            return _with_summary(digest, unavailable_summary(
                "the advisory line carries a figure no fact backs"))
    return _with_summary(digest, summary)


def _with_summary(digest: Digest, summary: AiSummary) -> Digest:
    return Digest(
        user_id=digest.user_id, firm_key=digest.firm_key, as_of=digest.as_of,
        seen_ids=digest.seen_ids, item_ids=digest.item_ids,
        item_set_hash=digest.item_set_hash, sections=digest.sections,
        counts=digest.counts, refusals=digest.refusals, ai_summary=summary)


def digest_subject(digest: Digest) -> str:
    n = digest.counts.get("shown", 0)
    if n == 0:
        return "CFO AI — nothing new needs your attention (%s)" % digest.as_of.isoformat()
    crit = digest.counts.get("critical", 0)
    over = digest.counts.get("overdue", 0)
    bits = ["%d item(s) need attention" % n]
    if crit:
        bits.append("%d critical" % crit)
    if over:
        bits.append("%d overdue" % over)
    return "CFO AI — %s (%s)" % (", ".join(bits), digest.as_of.isoformat())


def render_digest_text(digest: Digest, app_url: str = "") -> str:
    """Plain-text body: one block per client, one entry per item, deep
    links as route strings (prefixed with `app_url` when given)."""
    base = (app_url or "").rstrip("/")
    lines = [digest_subject(digest), ""]
    if not digest.sections:
        lines.append("No new attention items since your last digest.")
    for section in digest.sections:
        lines.append("%s  %s%s" % (section.client_name, base, section.route))
        for ln in section.lines:
            flag = ""
            if ln.severity == "critical":
                flag = "[CRITICAL] "
            elif ln.severity == "high":
                flag = "[HIGH] "
            dismissed = " (dismissed, kept visible)" if ln.dismissed else ""
            lines.append("  - %s%s%s" % (flag, ln.text, dismissed))
            if ln.evidence:
                lines.append("    %s" % ln.evidence)
            if ln.action:
                lines.append("    Do: %s" % ln.action)
            lines.append("    %s  ->  %s%s" % (ln.rationale, base, ln.route))
        lines.append("")
    if digest.ai_summary.available:
        lines.append("%s: %s" % (digest.ai_summary.label, digest.ai_summary.text))
    else:
        lines.append("Advisory summary: not shown (%s)." % digest.ai_summary.reason)
    if digest.refusals:
        lines.append("")
        lines.append("%d item(s) could not be shown because they did not meet the "
                     "item contract; each is listed in the digest payload with "
                     "its reason." % len(digest.refusals))
    return "\n".join(lines)


def render_digest_email(digest: Digest, app_url: str = "") -> str:
    """The branded HTML body, built from the shared email shell in
    engine.api._email_templates (imported lazily: this module stays
    importable without the API package)."""
    from engine.api import _email_templates as T  # noqa: WPS433 — lazy on purpose

    base = (app_url or "").rstrip("/")
    esc = _html.escape
    blocks = [T._eyebrow("Firm digest"), T._h1(digest_subject(digest))]
    if not digest.sections:
        blocks.append(T._p("No new attention items since your last digest.", gap=22))
    for section in digest.sections:
        blocks.append(
            '<p style="margin:18px 0 6px 0;font-family:%s;font-size:16px;'
            'font-weight:600;color:%s;"><a href="%s%s" style="color:%s;'
            'text-decoration:none;">%s</a></p>'
            % (T.SANS, T.INK, esc(base), esc(section.route), T.TEAL_DARK,
               esc(section.client_name)))
        rows = []
        for ln in section.lines:
            colour = {"critical": "#c62828", "high": "#b26a00"}.get(ln.severity, T.INK_2)
            kept = (' <span style="color:%s;">(dismissed, kept visible)</span>' % T.MUTED
                    if ln.dismissed else "")
            evidence = ('<br><span style="color:%s;">%s</span>' % (T.INK_2, esc(ln.evidence))
                        if ln.evidence else "")
            action = ('<br><span style="color:%s;">Do: %s</span>' % (T.INK_2, esc(ln.action))
                      if ln.action else "")
            rows.append(
                '<tr><td style="padding:8px 0;border-bottom:1px solid %s;'
                'font-family:%s;font-size:14px;line-height:1.5;color:%s;">'
                '<span style="font-weight:600;color:%s;">%s</span> %s%s%s%s'
                '<br><span style="font-size:12px;color:%s;">%s — '
                '<a href="%s%s" style="color:%s;text-decoration:none;">open</a>'
                '</span></td></tr>'
                % (T.BORDER, T.SANS, T.INK_2, colour, esc(ln.severity.upper()),
                   esc(ln.text), kept, evidence, action, T.MUTED, esc(ln.rationale),
                   esc(base), esc(ln.route), T.TEAL_DARK))
        blocks.append('<table role="presentation" width="100%%" cellpadding="0" '
                      'cellspacing="0" border="0">%s</table>' % "".join(rows))
    if digest.ai_summary.available:
        blocks.append(T._p("<strong>%s:</strong> %s"
                           % (esc(digest.ai_summary.label), esc(digest.ai_summary.text)),
                           small=True, gap=0))
    else:
        blocks.append(T._p("Advisory summary: not shown (%s)."
                           % esc(digest.ai_summary.reason), muted=True, small=True, gap=0))
    if base:
        blocks.append('<div style="height:18px;"></div>')
        blocks.append(T._button("Open the firm board", base + "/firm"))
    return T._layout(
        title=digest_subject(digest),
        body_html="\n".join(blocks),
        footer_html="You receive this because digests are switched on in your "
                    "firm preferences; switch them off there at any time.",
        preheader=digest_subject(digest),
    )


# ── The structural assertion: no model in the critical path ──────────────

#: The files that decide ranking, severity handling and suppression on
#: this lane's side: the cadence verdict and the order/digest. (The
#: board's detectors, severity ladder and suppression index are guarded
#: by the attention lane's own suite.)
CRITICAL_PATH_FILES = (
    Path(__file__).resolve().with_name("cadence.py"),
    Path(__file__).resolve(),
)

#: Import roots that mean "a model is reachable from here".
AI_IMPORT_ROOTS = ("anthropic", "openai", "engine.ai", "engine.ai_lane",
                   "engine.passes.movement_review", "engine.interp",
                   "engine.consensus", "engine.briefing")

#: Tokens that mean "a client is constructed or called from here".
AI_CLIENT_TOKENS = ("Anthropic(", "OpenAI(", "messages.create", "chat.completions",
                    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "call_strict_json")


def _imported_names(path: Path) -> List[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names = []  # type: List[str]
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.extend(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level:
                module = "engine.firm" + ("." + module if module else "")
            names.append(module)
            for alias in node.names:
                names.append(module + "." + alias.name if module else alias.name)
    return names


def critical_path_violations(paths: Sequence[Path] = CRITICAL_PATH_FILES) -> List[str]:
    """Every way a model could reach the ranking path, as readable lines.
    Empty == the property holds."""
    offenders = []  # type: List[str]
    for path in paths:
        for name in _imported_names(path):
            for root in AI_IMPORT_ROOTS:
                if name == root or name.startswith(root + "."):
                    offenders.append("%s imports %s" % (path.name, name))
        text = path.read_text(encoding="utf-8")
        # The token table itself lives in this file; scan the source with
        # the table's own definition masked so the definition does not
        # trip the scan it defines.
        masked = re.sub(r"AI_CLIENT_TOKENS = \([^)]*\)", "", text, flags=re.S)
        for token in AI_CLIENT_TOKENS:
            if token in masked:
                offenders.append("%s contains %r" % (path.name, token))
    return offenders


def assert_no_model_in_critical_path(paths: Sequence[Path] = CRITICAL_PATH_FILES) -> None:
    """Raise CriticalPathViolation when a model import or a client token
    appears in the ranking / severity / suppression code. Called by the
    brief router at mount time and by the firm gates suite."""
    offenders = critical_path_violations(paths)
    if offenders:
        raise CriticalPathViolation(
            "a model is reachable from the attention ranking path: "
            + "; ".join(offenders))


__all__ = [
    "SEVERITIES", "SEVERITY_RANK", "KIND_FILE_REQUESTED", "FACT_KINDS",
    "ROUTE_CLIENT", "ROUTE_ITEM", "ROUTE_REQUESTS", "ItemContractError",
    "CriticalPathViolation", "ItemFact", "coerce_fact", "fact_from_evidence",
    "render_evidence_line", "AttentionItem", "Refusal", "board_item_id",
    "coerce_item", "coerce_items", "kind_order_from_report", "items_from_report",
    "item_for_open_request", "due_status", "priority_key", "deterministic_order",
    "priority_rationale", "Group", "group_items", "item_set_hash", "AiSummary",
    "unavailable_summary", "DigestLine", "ClientSection", "Digest",
    "build_digest", "attach_ai_summary", "digest_subject", "render_digest_text",
    "render_digest_email", "CRITICAL_PATH_FILES", "AI_IMPORT_ROOTS",
    "AI_CLIENT_TOKENS", "critical_path_violations",
    "assert_no_model_in_critical_path",
]
