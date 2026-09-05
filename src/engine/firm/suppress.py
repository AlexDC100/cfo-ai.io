"""SUPPRESSION WITH A REASON, scoped and audited.

A suppression is :class:`engine.api._finding_rank.Dismissal` — the same
type the findings ranker uses — keyed by KIND (as the rule id) and a
scope key, bound to one client, with a reason, an author and an opaque
timestamp. It moves an item off the board and onto the ``suppressed``
list WITH the reason attached.

The one rule it cannot break: a CRITICAL item is never suppressed
silently. It stays on the board, flagged ``suppressed_but_retained``,
with the reason shown beside it — a decision has to be visible to be a
decision.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ._deps import finding_rank as R
from .model import AttentionItem


@dataclass(frozen=True)
class Suppression:
    client_id: str
    dismissal: "R.Dismissal"

    @property
    def kind(self) -> str:
        return self.dismissal.rule_id

    def to_payload(self) -> Dict[str, Any]:
        payload = self.dismissal.to_payload()
        payload["client_id"] = self.client_id
        payload["kind"] = self.dismissal.rule_id
        return payload

    @classmethod
    def from_payload(cls, payload: Dict[str, Any]) -> "Suppression":
        body = dict(payload)
        if "rule_id" not in body and body.get("kind"):
            body["rule_id"] = body["kind"]
        return cls(client_id=str(payload.get("client_id") or ""),
                   dismissal=R.Dismissal.from_payload(body))


class SuppressionIndex(object):
    """The suppressions in force, per client."""

    def __init__(self, suppressions: Sequence[Suppression] = ()) -> None:
        self._by_client = {}  # type: Dict[str, List[R.Dismissal]]
        for s in suppressions:
            if not s.dismissal.reason.strip():
                # A suppression without a reason is not a decision; it
                # is ignored rather than honoured. `rejected()` below
                # lists every such row off `_all`, so the omission is
                # visible on the payload without a second list here.
                continue
            self._by_client.setdefault(s.client_id, []).append(s.dismissal)
        self._all = tuple(suppressions)

    def __len__(self) -> int:
        return sum(len(v) for v in self._by_client.values())

    def match(self, client_id: str, kind: str, scope_key: str,
              period_ordinal: Optional[int] = None) -> Optional["R.Dismissal"]:
        index = R.DismissalIndex(self._by_client.get(client_id, ()))
        return index.match(kind, scope_key, period_ordinal)

    def rejected(self) -> List[Dict[str, Any]]:
        return [s.to_payload() for s in self._all if not s.dismissal.reason.strip()]

    def payloads(self) -> List[Dict[str, Any]]:
        return [s.to_payload() for s in self._all]


def apply_suppressions(items: Sequence[AttentionItem], index: SuppressionIndex
                       ) -> Tuple[Tuple[AttentionItem, ...], Tuple[AttentionItem, ...],
                                  List[Dict[str, Any]]]:
    """(kept, suppressed, audit).

    Every suppression DECISION taken here is written to the audit list —
    the item, the kind, the scope, the reason, and whether the item was
    retained because it is critical — so the payload can show what was
    hidden and why, not only what remains.
    """
    kept = []  # type: List[AttentionItem]
    suppressed = []  # type: List[AttentionItem]
    audit = []  # type: List[Dict[str, Any]]
    for item in items:
        dismissal = index.match(item.client_id, item.kind, item.scope_key)
        if dismissal is None:
            kept.append(item)
            continue
        is_critical = item.severity == "critical"
        stamped = replace(item, suppression=dismissal.to_payload(),
                          suppressed_but_retained=is_critical)
        audit.append({
            "client_id": item.client_id, "kind": item.kind,
            "scope_key": item.scope_key, "severity": item.severity,
            "reason": dismissal.reason, "dismissed_by": dismissal.dismissed_by,
            "dismissed_at": dismissal.dismissed_at,
            "retained": is_critical,
            "disposition": ("retained: a critical item is never suppressed "
                            "silently" if is_critical else "suppressed"),
        })
        if is_critical:
            kept.append(stamped)
        else:
            suppressed.append(stamped)
    return tuple(kept), tuple(suppressed), audit


__all__ = ["Suppression", "SuppressionIndex", "apply_suppressions"]
