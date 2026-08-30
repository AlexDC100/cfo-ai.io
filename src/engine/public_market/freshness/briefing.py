"""D1 -- per-entity "latest developments" brief (flagship + web search).

Contract:
  * every served claim carries {source_url, article_date}; a claim missing
    either is DROPPED and counted (``dropped_claim_count``), never served;
  * cached by (entity, day) in a content-addressed cache dir; a same-day
    re-request never re-bills;
  * dark (credits absent) -> typed AiUnavailable inside the result, calm
    notice, nothing cached (so activation is instant when the key bills);
  * PM1: this module has no import path into the spine's serving/persistence
    write APIs -- a briefing can never write a number anywhere the
    deterministic feeds are authoritative over. Enforced by the token-scan
    lint in tests/engine/test_public_market_freshness.py.
"""

import datetime
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from engine.public_market.freshness import (
    AiResult,
    AiUnavailable,
    cache_key,
    cache_read,
    cache_write,
    parse_model_json,
)

ROLE = "pm_briefing"
PROMPT_VERSION = "pm-briefing-v1"

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass(frozen=True)
class BriefingClaim:
    claim: str
    source_url: str
    article_date: str  # YYYY-MM-DD, as reported by the cited article

    def as_dict(self):
        # type: () -> Dict[str, str]
        return {
            "claim": self.claim,
            "source_url": self.source_url,
            "article_date": self.article_date,
        }


@dataclass
class BriefingResult:
    """Either a validated briefing (status == "ok") or a typed refusal
    (status == "unavailable", ``unavailable`` set). Deterministic metadata
    (entity, day) is present in both -- the UI always has something honest
    to render."""

    status: str  # "ok" or "unavailable"
    entity_id: str
    day: str
    updated_at: Optional[str] = None
    model: Optional[str] = None
    cache_hit: bool = False
    claims: List[BriefingClaim] = field(default_factory=list)
    sources: List[str] = field(default_factory=list)
    dropped_claim_count: int = 0
    unavailable: Optional[AiUnavailable] = None

    def as_dict(self):
        # type: () -> Dict[str, Any]
        out = {
            "status": self.status,
            "entity_id": self.entity_id,
            "day": self.day,
            "updated_at": self.updated_at,
            "model": self.model,
            "cache_hit": self.cache_hit,
            "claims": [c.as_dict() for c in self.claims],
            "sources": list(self.sources),
            "dropped_claim_count": self.dropped_claim_count,
        }
        if self.unavailable is not None:
            out["unavailable"] = self.unavailable.as_dict()
        return out


def _build_prompt(entity_id, entity_name):
    # type: (str, Optional[str]) -> str
    label = entity_name or entity_id
    return (
        "You are a markets research assistant. Using web search, list the "
        "latest notable developments (last 30 days preferred) for the listed "
        "company %r (identifier %s).\n"
        "Respond with ONLY a JSON object of this exact shape:\n"
        '{"claims": [{"claim": "<one factual sentence>", '
        '"source_url": "<https URL of the article you used>", '
        '"article_date": "<YYYY-MM-DD publication date>"}]}\n'
        "Rules: at most 6 claims; every claim MUST cite the article you took "
        "it from via source_url and article_date; do NOT include financial "
        "figures -- describe events, not numbers; if you find nothing "
        'reliable, return {"claims": []}.'
    ) % (label, entity_id)


def _validate_claims(raw):
    # type: (Any) -> Optional[Dict[str, Any]]
    """Apply the citation contract. Returns None if the document shape is
    wrong (-> model_output_invalid); otherwise kept claims + drop count."""
    if not isinstance(raw, dict) or not isinstance(raw.get("claims"), list):
        return None
    kept = []  # type: List[BriefingClaim]
    dropped = 0
    for item in raw["claims"]:
        if not isinstance(item, dict):
            dropped += 1
            continue
        claim = item.get("claim")
        source_url = item.get("source_url")
        article_date = item.get("article_date")
        ok = (
            isinstance(claim, str)
            and claim.strip()
            and isinstance(source_url, str)
            and source_url.startswith("http")
            and isinstance(article_date, str)
            and _DATE_RE.match(article_date) is not None
            and _is_real_date(article_date)
        )
        if not ok:
            # A claim without a verifiable citation is not a claim we serve.
            dropped += 1
            continue
        kept.append(
            BriefingClaim(
                claim=claim.strip(),
                source_url=source_url.strip(),
                article_date=article_date,
            )
        )
    return {"kept": kept, "dropped": dropped}


def _is_real_date(value):
    # type: (str) -> bool
    try:
        datetime.date.fromisoformat(value)
        return True
    except ValueError:
        return False


def _from_cache_payload(entity_id, day, payload):
    # type: (str, str, Dict[str, Any]) -> Optional[BriefingResult]
    """Rehydrate a cached briefing; malformed cache entries read as a miss."""
    try:
        claims = [
            BriefingClaim(
                claim=c["claim"],
                source_url=c["source_url"],
                article_date=c["article_date"],
            )
            for c in payload["claims"]
        ]
        return BriefingResult(
            status="ok",
            entity_id=entity_id,
            day=day,
            updated_at=payload["updated_at"],
            model=payload.get("model"),
            cache_hit=True,
            claims=claims,
            sources=list(payload["sources"]),
            dropped_claim_count=int(payload.get("dropped_claim_count", 0)),
        )
    except (KeyError, TypeError, ValueError):
        return None


def build_briefing(
    entity_id,          # type: str
    client,             # type: Any
    breaker,            # type: Any
    cache_dir,          # type: str
    entity_name=None,   # type: Optional[str]
    now=None,           # type: Optional[datetime.datetime]
):
    # type: (...) -> BriefingResult
    """Build (or fetch from cache) the daily developments brief for one
    entity. Never raises for AI-side problems; returns a typed result."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    day = now.date().isoformat()
    key = cache_key("briefing", PROMPT_VERSION, entity_id, day)

    cached = cache_read(cache_dir, key)
    if cached is not None:
        hydrated = _from_cache_payload(entity_id, day, cached)
        if hydrated is not None:
            return hydrated

    refusal = breaker.allow(ROLE)
    if refusal is not None:
        return BriefingResult(
            status="unavailable", entity_id=entity_id, day=day, unavailable=refusal
        )

    completion = client.complete(
        ROLE, _build_prompt(entity_id, entity_name), max_tokens=1500,
        want_web_search=True,
    )
    if isinstance(completion, AiUnavailable):
        # Dark path (credits absent / provider down). NOT cached: the next
        # request after activation must go straight to the live model.
        return BriefingResult(
            status="unavailable", entity_id=entity_id, day=day,
            unavailable=completion,
        )

    breaker.record(ROLE)

    parsed = parse_model_json(completion.text)
    validated = _validate_claims(parsed) if parsed is not None else None
    if validated is None:
        return BriefingResult(
            status="unavailable", entity_id=entity_id, day=day,
            unavailable=AiUnavailable(
                reason="model_output_invalid",
                detail="briefing reply did not match the claims contract",
            ),
        )

    updated_at = now.isoformat()
    sources = []  # type: List[str]
    for c in validated["kept"]:
        if c.source_url not in sources:
            sources.append(c.source_url)

    result = BriefingResult(
        status="ok",
        entity_id=entity_id,
        day=day,
        updated_at=updated_at,
        model=completion.model,
        cache_hit=False,
        claims=validated["kept"],
        sources=sources,
        dropped_claim_count=validated["dropped"],
    )
    cache_write(
        cache_dir,
        key,
        {
            "entity_id": entity_id,
            "day": day,
            "updated_at": updated_at,
            "model": completion.model,
            "claims": [c.as_dict() for c in validated["kept"]],
            "sources": sources,
            "dropped_claim_count": validated["dropped"],
        },
        stored_at=updated_at,
    )
    return result
