"""D4 -- peer selection: deterministic candidates, optional AI ordering.

Membership is NEVER an AI decision.  Candidates come from a deterministic
(sector, size band) filter with a stable ordering (size proximity, then
ticker A->Z).  The flagship may then RE-ORDER those same candidates and
attach a one-line rationale each -- and only that:

  * dark (credits absent)      -> deterministic order stands, labeled
    "standard ordering";
  * AI reply invalid, or not an exact permutation of the candidate set
    (anything added, dropped, duplicated or unknown) -> deterministic order
    stands, flagged;
  * AI reply valid             -> same set, AI order, labeled "ai_ranked".

ABSENT != ZERO: an entity with no size figure has NO size band -- it is not
"micro cap"; the selection then degrades to sector-only and says so.
"""

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from engine.public_market.freshness import (
    AiUnavailable,
    parse_model_json,
)

ROLE = "pm_peers"
PROMPT_VERSION = "pm-peers-v1"

STANDARD_ORDERING_LABEL = "standard ordering"
AI_ORDERING_LABEL = "ai_ranked"

# (band name, inclusive lower bound, exclusive upper bound) on the size
# figure -- callers pass one consistent size measure for the whole universe
# (market cap preferred, revenue acceptable), in one consistent currency.
SIZE_BANDS = (
    ("micro", 0.0, 50e6),
    ("small", 50e6, 500e6),
    ("mid", 500e6, 5e9),
    ("large", 5e9, 50e9),
    ("mega", 50e9, float("inf")),
)


@dataclass(frozen=True)
class PeerCandidate:
    ticker: str
    name: str
    sector: str
    size_value: Optional[float] = None  # None = size unknown (not zero)

    def as_dict(self):
        # type: () -> Dict[str, Any]
        return {
            "ticker": self.ticker,
            "name": self.name,
            "sector": self.sector,
            "size_value": self.size_value,
        }


@dataclass
class PeerResult:
    subject_ticker: str
    basis: str  # "sector_size_band" | "sector_only_size_absent"
    ordering: str  # STANDARD_ORDERING_LABEL | AI_ORDERING_LABEL
    ordering_label: str  # user-visible label for the ordering in force
    peers: List[PeerCandidate] = field(default_factory=list)
    rationales: Dict[str, str] = field(default_factory=dict)  # ticker -> line
    flags: List[Dict[str, Any]] = field(default_factory=list)
    unavailable: Optional[AiUnavailable] = None

    def as_dict(self):
        # type: () -> Dict[str, Any]
        out = {
            "subject_ticker": self.subject_ticker,
            "basis": self.basis,
            "ordering": self.ordering,
            "ordering_label": self.ordering_label,
            "peers": [p.as_dict() for p in self.peers],
            "rationales": dict(self.rationales),
            "flags": list(self.flags),
        }
        if self.unavailable is not None:
            out["unavailable"] = self.unavailable.as_dict()
        return out


def size_band(value):
    # type: (Optional[float]) -> Optional[str]
    """Band for a size figure. None in -> None out (ABSENT != ZERO: an
    unknown size must never band as micro)."""
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v < 0 or math.isnan(v) or math.isinf(v):
        return None
    for name, lo, hi in SIZE_BANDS:
        if lo <= v < hi:
            return name
    return None


def deterministic_peers(subject, universe, limit=8):
    # type: (PeerCandidate, List[PeerCandidate], int) -> Dict[str, Any]
    """Stable candidate selection. Same inputs -> same list, always.

    Order within the filter: size proximity to the subject (|delta log10|),
    then ticker A->Z as the total tiebreak. With no subject size figure the
    filter degrades to sector-only, ordered purely A->Z, and the basis says
    so -- callers can label the weaker match honestly.
    """
    subject_sector = subject.sector.strip().lower()
    subject_band = size_band(subject.size_value)

    candidates = []  # type: List[PeerCandidate]
    for cand in universe:
        if cand.ticker == subject.ticker:
            continue
        if cand.sector.strip().lower() != subject_sector:
            continue
        if subject_band is not None and size_band(cand.size_value) != subject_band:
            continue
        candidates.append(cand)

    if subject_band is not None and subject.size_value is not None:
        subject_log = math.log10(max(float(subject.size_value), 1.0))

        def sort_key(c):
            # type: (PeerCandidate) -> Any
            cand_log = math.log10(max(float(c.size_value), 1.0))
            return (abs(cand_log - subject_log), c.ticker)

        candidates.sort(key=sort_key)
        basis = "sector_size_band"
    else:
        candidates.sort(key=lambda c: c.ticker)
        basis = "sector_only_size_absent"

    return {"peers": candidates[: max(limit, 0)], "basis": basis}


def _build_prompt(subject, candidates):
    # type: (PeerCandidate, List[PeerCandidate]) -> str
    listing = "\n".join(
        "- %s (%s)" % (c.ticker, c.name) for c in candidates
    )
    return (
        "Rank these companies as comparison peers for %s (%s), most relevant "
        "first. Use ONLY the tickers listed -- do not add, drop, or invent "
        "any. Respond with ONLY JSON:\n"
        '[{"ticker": "<ticker from the list>", '
        '"rationale": "<one line: why it is (or is not) a close peer>"}]\n'
        "The list must contain each given ticker exactly once.\n%s"
        % (subject.ticker, subject.name, listing)
    )


def _apply_ai_order(candidates, parsed):
    # type: (List[PeerCandidate], Any) -> Optional[Dict[str, Any]]
    """Accept the AI ordering only if it is an exact permutation of the
    candidate tickers. Anything else -> None (deterministic order stands)."""
    if not isinstance(parsed, list):
        return None
    order = []  # type: List[str]
    rationales = {}  # type: Dict[str, str]
    for item in parsed:
        if not isinstance(item, dict) or not isinstance(item.get("ticker"), str):
            return None
        ticker = item["ticker"]
        order.append(ticker)
        rationale = item.get("rationale")
        if isinstance(rationale, str) and rationale.strip():
            rationales[ticker] = rationale.strip()[:200]
    expected = sorted(c.ticker for c in candidates)
    if sorted(order) != expected:
        return None  # added/dropped/duplicated/unknown ticker
    by_ticker = {c.ticker: c for c in candidates}
    return {
        "peers": [by_ticker[t] for t in order],
        "rationales": rationales,
    }


def rank_peers(
    subject,     # type: PeerCandidate
    universe,    # type: List[PeerCandidate]
    client,      # type: Any
    breaker,     # type: Any
    limit=8,     # type: int
):
    # type: (...) -> PeerResult
    """Deterministic candidates first; flagship ordering second (optional).

    Every failure path -- dark client, budget refusal, invalid model output,
    non-permutation reply -- leaves the deterministic result standing with
    the "standard ordering" label. The AI can only ever improve presentation.
    """
    det = deterministic_peers(subject, universe, limit=limit)
    result = PeerResult(
        subject_ticker=subject.ticker,
        basis=det["basis"],
        ordering="standard",
        ordering_label=STANDARD_ORDERING_LABEL,
        peers=list(det["peers"]),
    )
    if not result.peers:
        return result  # nothing to rank; no reason to spend

    refusal = breaker.allow(ROLE)
    if refusal is not None:
        result.unavailable = refusal
        return result

    completion = client.complete(
        ROLE, _build_prompt(subject, result.peers), max_tokens=800
    )
    if isinstance(completion, AiUnavailable):
        result.unavailable = completion
        return result

    breaker.record(ROLE)

    applied = _apply_ai_order(result.peers, parse_model_json(completion.text))
    if applied is None:
        result.flags.append(
            {
                "type": "ai_rank_invalid",
                "detail": "reply was not an exact permutation of the candidates",
            }
        )
        return result  # deterministic order stands

    result.peers = applied["peers"]
    result.rationales = applied["rationales"]
    result.ordering = "ai_ranked"
    result.ordering_label = AI_ORDERING_LABEL
    return result
