"""ONE CLIENT, ONE ROW. Five items on a client are five REASONS on one
row, and the rows are ranked by their top item, then by the nearest
deadline — so the accountant reads a list of clients, not a list of
alarms.

Ordering is total and deterministic: severity rank, then days to due
(items with no deadline last), then the pack's kind order, then the
scope key. Two boards over the same data sort identically on every host.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .model import SEVERITY_RANK, AttentionItem, ClientRecord, Gap

_NO_DEADLINE = 10 ** 6


def item_sort_key(item: AttentionItem, kind_order: Dict[str, int]) -> Tuple[int, int, int, str, str]:
    due = item.days_to_due if item.days_to_due is not None else _NO_DEADLINE
    return (item.severity_rank(), int(due), kind_order.get(item.kind, 999),
            item.scope_key, item.period_id or "")


def rank_items(items: Sequence[AttentionItem],
               kind_order: Dict[str, int]) -> Tuple[AttentionItem, ...]:
    return tuple(sorted(items, key=lambda i: item_sort_key(i, kind_order)))


@dataclass(frozen=True)
class ClientRow:
    client_id: str
    client_name: str
    items: Tuple[AttentionItem, ...]           # ranked
    gaps: Tuple[Gap, ...]
    suppressed_count: int

    @property
    def top(self) -> Optional[AttentionItem]:
        return self.items[0] if self.items else None

    @property
    def top_severity(self) -> Optional[str]:
        return self.top.severity if self.top else None

    @property
    def nearest_due_at(self) -> Optional[str]:
        dues = [i for i in self.items if i.days_to_due is not None and i.due_at]
        if not dues:
            return None
        return min(dues, key=lambda i: (int(i.days_to_due), i.due_at)).due_at

    @property
    def nearest_days_to_due(self) -> Optional[int]:
        dues = [i.days_to_due for i in self.items if i.days_to_due is not None]
        return min(dues) if dues else None

    def reasons(self) -> List[str]:
        return [i.reason for i in self.items]

    def counts(self) -> Dict[str, int]:
        out = {}  # type: Dict[str, int]
        for i in self.items:
            out[i.severity] = out.get(i.severity, 0) + 1
        return dict(sorted(out.items(), key=lambda kv: SEVERITY_RANK.get(kv[0], 9)))

    def sort_key(self) -> Tuple[int, int, int, str, str]:
        top_rank = self.top.severity_rank() if self.top else 99
        due = self.nearest_days_to_due
        return (top_rank, due if due is not None else _NO_DEADLINE,
                -len(self.items), self.client_name.lower(), self.client_id)

    def to_payload(self) -> Dict[str, Any]:
        top = self.top
        return {
            "client_id": self.client_id,
            "client_name": self.client_name,
            "top_severity": self.top_severity,
            "top_kind": (top.kind if top else None),
            "top_reason": (top.reason if top else None),
            "nearest_due_at": self.nearest_due_at,
            "nearest_days_to_due": self.nearest_days_to_due,
            "item_count": len(self.items),
            "counts": self.counts(),
            "reasons": self.reasons(),
            "items": [i.to_payload() for i in self.items],
            "gaps": [g.to_payload() for g in self.gaps],
            "suppressed_count": self.suppressed_count,
        }


def group_by_client(clients: Sequence[ClientRecord],
                    items: Sequence[AttentionItem],
                    gaps: Dict[str, Sequence[Gap]],
                    suppressed: Sequence[AttentionItem],
                    kind_order: Dict[str, int]) -> Tuple[ClientRow, ...]:
    """N items on one client -> ONE row with N reasons. Every client the
    caller passed gets a row — a quiet client is a row with no items,
    which is a claim ("nothing needs attention") the reader can see."""
    by_client = {}  # type: Dict[str, List[AttentionItem]]
    for item in items:
        by_client.setdefault(item.client_id, []).append(item)
    suppressed_by_client = {}  # type: Dict[str, int]
    for item in suppressed:
        suppressed_by_client[item.client_id] = suppressed_by_client.get(item.client_id, 0) + 1
    rows = []  # type: List[ClientRow]
    for client in sorted(clients, key=lambda c: c.client_id):
        rows.append(ClientRow(
            client_id=client.client_id, client_name=client.client_name,
            items=rank_items(by_client.get(client.client_id, ()), kind_order),
            gaps=tuple(gaps.get(client.client_id, ())),
            suppressed_count=suppressed_by_client.get(client.client_id, 0)))
    return tuple(sorted(rows, key=lambda r: r.sort_key()))


__all__ = ["ClientRow", "group_by_client", "item_sort_key", "rank_items"]
