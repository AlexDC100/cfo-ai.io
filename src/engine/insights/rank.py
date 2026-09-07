"""Deterministic ranking, with the tie-break stated in the output.

THE ORDER, AND WHY IT IS PRINTED
================================
`rank_basis` on every insight carries the pack's ranking statement
verbatim, so the document explains its own order to the reader instead of
presenting a list whose sequence is a mystery. TC-10: the rule renders
from the same data the ranker used.

WHY THE TIE-BREAK IS AN ID AND NOT A TIMESTAMP OR A HASH
========================================================
Two insights can land on the same level with the same materiality — most
easily when both graded `info` with a materiality of exactly zero. Sorting
those by anything derived from the run (insertion order, dict iteration,
`hash()`) makes the report non-reproducible, and a report whose section
order moves between two runs over the same book is not a deterministic
artefact. Detector id ascending is stable, total, and auditable.

`materiality: None` sorts LAST within its level: a finding whose scale
could not be established is not a bigger finding than one that could.

Python 3.9 — no `match`, no `X | Y`.
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence, Tuple

from .packdata import LEVEL_ORDER

__all__ = ["sort_key", "rank_insights"]


def sort_key(insight: Dict[str, Any]) -> Tuple[int, int, float, str]:
    severity = insight.get("severity") or {}
    level = str(severity.get("level") or "info")
    level_index = LEVEL_ORDER.get(level, len(LEVEL_ORDER))
    materiality = severity.get("materiality")
    if materiality is None:
        # 1 sorts after 0: absent materiality goes last inside its level.
        return (level_index, 1, 0.0, str(insight.get("id") or ""))
    return (level_index, 0, -float(materiality), str(insight.get("id") or ""))


def rank_insights(insights: Sequence[Dict[str, Any]], statement: str,
                  summary_limit: int) -> List[Dict[str, Any]]:
    ordered = sorted(insights, key=sort_key)
    for index, insight in enumerate(ordered, start=1):
        insight["rank"] = index
        insight["rank_basis"] = statement
        insight["in_summary"] = index <= summary_limit
    return ordered
