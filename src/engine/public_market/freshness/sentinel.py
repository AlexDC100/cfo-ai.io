"""D3 -- freshness sentinel over the seeded public_market entities.

The core is fully deterministic and runs identically dark or lit:
  * per entity, compare the latest KNOWN filing/price date against the
    source's declared cadence (from the seed / registry record);
  * stale entities land in a refetch queue (jsonl, deduped per day);
  * persistent gaps (>= PERSISTENT_GAP_CYCLES missed cadences, or a cadence
    with no observation at all -- ABSENT != ZERO, "never seen" is treated as
    the WORST staleness, not as fresh) are summarized into
    data/obs/market_freshness_last.json for the /ops surface to read.

The AI part is a FALLBACK DETECTOR only: for persistently-gapped entities it
may propose "this looks delisted" / "ticker changed" -- proposals go into a
review queue jsonl for a human. Nothing in this module mutates entity
identity, the registry, or any persisted figure; the test suite asserts the
only files this module touches are its own queue/summary outputs.
"""

import datetime
import json
import os
import tempfile
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from engine.public_market.freshness import (
    AiUnavailable,
    parse_model_json,
)

ROLE = "pm_identity_sentinel"
PROMPT_VERSION = "pm-identity-v1"

# A gap of this many full cadence periods (or an observation that never
# happened at all) counts as persistent, not merely stale.
PERSISTENT_GAP_CYCLES = 3

_PROPOSAL_TYPES = ("delisting", "ticker_change")


class SeedFormatError(ValueError):
    """Typed refusal for a malformed seed file. The CLI maps this to exit 2
    with the message verbatim; the library never half-loads a bad seed."""


@dataclass(frozen=True)
class SourceCadence:
    """Expected maximum age, in days, per observation kind. ``None`` means
    the source declares no cadence for that kind (e.g. an unlisted issuer
    with filings only) -- that kind is then simply not assessed."""

    filing_days: Optional[int] = None
    price_days: Optional[int] = None


@dataclass(frozen=True)
class SeededEntity:
    entity_id: str
    source: str
    cadence: SourceCadence
    name: Optional[str] = None
    last_filing_date: Optional[str] = None  # YYYY-MM-DD or None (= never seen)
    last_price_date: Optional[str] = None


@dataclass(frozen=True)
class Assessment:
    entity_id: str
    source: str
    kind: str  # "filing" or "price"
    last_seen: Optional[str]
    age_days: Optional[int]  # None when never seen
    allowed_days: int
    stale: bool
    persistent: bool
    reason: str  # "fresh" | "stale" | "never_seen"

    def as_dict(self):
        # type: () -> Dict[str, Any]
        return {
            "entity_id": self.entity_id,
            "source": self.source,
            "kind": self.kind,
            "last_seen": self.last_seen,
            "age_days": self.age_days,
            "allowed_days": self.allowed_days,
            "stale": self.stale,
            "persistent": self.persistent,
            "reason": self.reason,
        }


def _parse_iso_date(value, context):
    # type: (Any, str) -> Optional[datetime.date]
    if value is None:
        return None
    if not isinstance(value, str):
        raise SeedFormatError("%s: date must be a YYYY-MM-DD string" % context)
    try:
        return datetime.date.fromisoformat(value)
    except ValueError:
        raise SeedFormatError("%s: bad date %r" % (context, value))


def _parse_cadence_days(value, context):
    # type: (Any, str) -> Optional[int]
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise SeedFormatError("%s: cadence days must be a positive int" % context)
    return value


def load_seed(path):
    # type: (str) -> List[SeededEntity]
    """Load the seeded-entities file (JSON list, or JSONL of objects).

    Fails closed: ANY malformed record refuses the whole load -- a sentinel
    running over a silently-truncated universe would report false freshness.
    """
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        raise SeedFormatError("cannot read seed file %s: %s" % (path, exc))
    text = text.strip()
    if not text:
        raise SeedFormatError("seed file %s is empty" % path)

    if text.startswith("["):
        try:
            rows = json.loads(text)
        except ValueError as exc:
            raise SeedFormatError("seed file %s: bad JSON: %s" % (path, exc))
        if not isinstance(rows, list):
            raise SeedFormatError("seed file %s: top level must be a list" % path)
    else:
        rows = []
        for lineno, line in enumerate(text.splitlines(), start=1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError as exc:
                raise SeedFormatError(
                    "seed file %s line %d: bad JSON: %s" % (path, lineno, exc)
                )

    entities = []  # type: List[SeededEntity]
    seen_ids = set()
    for i, row in enumerate(rows):
        ctx = "seed entry %d" % i
        if not isinstance(row, dict):
            raise SeedFormatError("%s: must be an object" % ctx)
        entity_id = row.get("entity_id")
        source = row.get("source")
        if not isinstance(entity_id, str) or not entity_id.strip():
            raise SeedFormatError("%s: entity_id is required" % ctx)
        if not isinstance(source, str) or not source.strip():
            raise SeedFormatError("%s (%s): source is required" % (ctx, entity_id))
        if entity_id in seen_ids:
            raise SeedFormatError("%s: duplicate entity_id %s" % (ctx, entity_id))
        seen_ids.add(entity_id)
        cadence_raw = row.get("cadence") or {}
        if not isinstance(cadence_raw, dict):
            raise SeedFormatError("%s (%s): cadence must be an object" % (ctx, entity_id))
        cadence = SourceCadence(
            filing_days=_parse_cadence_days(
                cadence_raw.get("filing_days"), "%s (%s) filing_days" % (ctx, entity_id)
            ),
            price_days=_parse_cadence_days(
                cadence_raw.get("price_days"), "%s (%s) price_days" % (ctx, entity_id)
            ),
        )
        # Dates are validated here but stored as the original strings so the
        # queue/summary echo exactly what the feed recorded.
        _parse_iso_date(row.get("last_filing_date"), "%s (%s) last_filing_date" % (ctx, entity_id))
        _parse_iso_date(row.get("last_price_date"), "%s (%s) last_price_date" % (ctx, entity_id))
        entities.append(
            SeededEntity(
                entity_id=entity_id.strip(),
                source=source.strip(),
                cadence=cadence,
                name=row.get("name") if isinstance(row.get("name"), str) else None,
                last_filing_date=row.get("last_filing_date"),
                last_price_date=row.get("last_price_date"),
            )
        )
    return entities


def assess_freshness(entities, now):
    # type: (List[SeededEntity], datetime.datetime) -> List[Assessment]
    """Pure staleness math. Deterministic given (entities, now)."""
    today = now.date()
    out = []  # type: List[Assessment]
    for ent in entities:
        for kind, allowed, last_str in (
            ("filing", ent.cadence.filing_days, ent.last_filing_date),
            ("price", ent.cadence.price_days, ent.last_price_date),
        ):
            if allowed is None:
                continue  # source declares no cadence for this kind
            if last_str is None:
                # Never observed. ABSENT != ZERO: no date is not "current",
                # it is the strongest possible staleness signal.
                out.append(
                    Assessment(
                        entity_id=ent.entity_id, source=ent.source, kind=kind,
                        last_seen=None, age_days=None, allowed_days=allowed,
                        stale=True, persistent=True, reason="never_seen",
                    )
                )
                continue
            age = (today - datetime.date.fromisoformat(last_str)).days
            stale = age > allowed
            persistent = age > allowed * PERSISTENT_GAP_CYCLES
            out.append(
                Assessment(
                    entity_id=ent.entity_id, source=ent.source, kind=kind,
                    last_seen=last_str, age_days=age, allowed_days=allowed,
                    stale=stale, persistent=persistent,
                    reason="stale" if stale else "fresh",
                )
            )
    return out


def _read_jsonl_keys(path):
    # type: (str) -> set
    keys = set()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue  # foreign garbage never blocks new queueing
                if isinstance(row, dict):
                    keys.add((row.get("entity_id"), row.get("kind"), row.get("day")))
    except OSError:
        pass
    return keys


def write_refetch_queue(assessments, queue_path, now):
    # type: (List[Assessment], str, datetime.datetime) -> int
    """Append one refetch request per stale (entity, kind), deduped per day
    so a sentinel re-run does not double-queue the same work."""
    day = now.date().isoformat()
    existing = _read_jsonl_keys(queue_path)
    os.makedirs(os.path.dirname(queue_path) or ".", exist_ok=True)
    appended = 0
    with open(queue_path, "a", encoding="utf-8") as fh:
        for a in assessments:
            if not a.stale:
                continue
            dedup_key = (a.entity_id, a.kind, day)
            if dedup_key in existing:
                continue
            record = {
                "queued_at": now.isoformat(),
                "day": day,
                "entity_id": a.entity_id,
                "source": a.source,
                "kind": a.kind,
                "last_seen": a.last_seen,
                "age_days": a.age_days,
                "allowed_days": a.allowed_days,
                "reason": a.reason,
            }
            fh.write(json.dumps(record, sort_keys=True) + "\n")
            existing.add(dedup_key)
            appended += 1
    return appended


@dataclass
class ProposalOutcome:
    """Result of the AI identity fallback pass. Proposals are REVIEW ITEMS
    only -- appended to a jsonl queue, never applied to anything."""

    status: str  # "ok" | "unavailable" | "skipped"
    proposals: List[Dict[str, Any]] = field(default_factory=list)
    dropped_proposal_count: int = 0
    unavailable: Optional[AiUnavailable] = None

    def as_dict(self):
        # type: () -> Dict[str, Any]
        out = {
            "status": self.status,
            "proposals": list(self.proposals),
            "dropped_proposal_count": self.dropped_proposal_count,
        }
        if self.unavailable is not None:
            out["unavailable"] = self.unavailable.as_dict()
        return out


def _build_identity_prompt(gapped):
    # type: (List[SeededEntity]) -> str
    listing = "\n".join(
        "- entity_id=%s source=%s name=%s" % (e.entity_id, e.source, e.name or "?")
        for e in gapped
    )
    return (
        "These listed companies have stopped producing filings/prices on "
        "their usual cadence. Using web search, check whether any has been "
        "DELISTED or has CHANGED TICKER. Respond with ONLY JSON:\n"
        '[{"entity_id": "<id from the list>", '
        '"proposal_type": "delisting" or "ticker_change", '
        '"evidence_url": "<https URL supporting this>", '
        '"note": "<one line>"}]\n'
        "Include ONLY entities you found real evidence for; an empty list "
        "is a valid answer.\n%s" % listing
    )


def propose_identity_review(
    gapped_entities,     # type: List[SeededEntity]
    client,              # type: Any
    breaker,             # type: Any
    review_queue_path,   # type: str
    now,                 # type: datetime.datetime
):
    # type: (...) -> ProposalOutcome
    """AI fallback detector for delistings / ticker changes.

    PROPOSALS ONLY: validated entries are appended to the review queue for a
    human decision. This function has no path that mutates entity identity
    or any persisted market figure -- dark or lit, the deterministic
    staleness output above is already complete before this runs.
    """
    if not gapped_entities:
        return ProposalOutcome(status="skipped")

    refusal = breaker.allow(ROLE)
    if refusal is not None:
        return ProposalOutcome(status="unavailable", unavailable=refusal)

    completion = client.complete(
        ROLE, _build_identity_prompt(gapped_entities), max_tokens=1200,
        want_web_search=True,
    )
    if isinstance(completion, AiUnavailable):
        return ProposalOutcome(status="unavailable", unavailable=completion)

    breaker.record(ROLE)

    parsed = parse_model_json(completion.text)
    if not isinstance(parsed, list):
        return ProposalOutcome(
            status="unavailable",
            unavailable=AiUnavailable(
                reason="model_output_invalid",
                detail="identity reply was not a JSON list",
            ),
        )

    known_ids = set(e.entity_id for e in gapped_entities)
    kept = []  # type: List[Dict[str, Any]]
    dropped = 0
    for item in parsed:
        ok = (
            isinstance(item, dict)
            and item.get("entity_id") in known_ids
            and item.get("proposal_type") in _PROPOSAL_TYPES
            and isinstance(item.get("evidence_url"), str)
            and item["evidence_url"].startswith("http")
            and isinstance(item.get("note"), str)
        )
        if not ok:
            dropped += 1
            continue
        kept.append(
            {
                "proposed_at": now.isoformat(),
                "entity_id": item["entity_id"],
                "proposal_type": item["proposal_type"],
                "evidence_url": item["evidence_url"],
                "note": item["note"][:300],
                "status": "pending_review",
            }
        )

    if kept:
        os.makedirs(os.path.dirname(review_queue_path) or ".", exist_ok=True)
        with open(review_queue_path, "a", encoding="utf-8") as fh:
            for record in kept:
                fh.write(json.dumps(record, sort_keys=True) + "\n")

    return ProposalOutcome(
        status="ok", proposals=kept, dropped_proposal_count=dropped
    )


def write_summary(
    assessments,      # type: List[Assessment]
    summary_path,     # type: str
    now,              # type: datetime.datetime
    queue_path,       # type: str
    queued_count,     # type: int
    proposal_outcome, # type: Optional[ProposalOutcome]
):
    # type: (...) -> Dict[str, Any]
    """Write the last-run summary record (atomic replace) for /ops to read.
    This module only ever writes its own observability artifacts."""
    persistent = [a.as_dict() for a in assessments if a.persistent]
    summary = {
        "generated_at": now.isoformat(),
        "checks": len(assessments),
        "stale_count": sum(1 for a in assessments if a.stale),
        "persistent_gap_count": len(persistent),
        "persistent_gaps": persistent,
        "refetch_queue": queue_path,
        "refetch_queued_now": queued_count,
        "ai_identity_review": (
            proposal_outcome.as_dict() if proposal_outcome is not None
            else {"status": "skipped"}
        ),
    }
    directory = os.path.dirname(summary_path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(summary, fh, indent=2, sort_keys=True)
        os.replace(tmp_path, summary_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    return summary
