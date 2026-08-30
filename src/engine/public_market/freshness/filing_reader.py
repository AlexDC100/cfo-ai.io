"""D2 -- filing narrative reader (MD&A / risk / outlook) with figure echo.

The model summarizes SECTION TEXT that the deterministic pipeline extracted;
it is never the source of a number.  Any figure the model references must
name a ``fact_key`` present in the XBRL facts passed in, and the value we
serve is ALWAYS echoed from those facts:

  * model value  == facts value -> figure served (value from facts);
  * model value  != facts value -> figure served with the FACTS value plus a
    flagged entry recording both numbers -- the mismatch is surfaced, never
    silently corrected (the reader's text stays the model's, the number does
    not);
  * fact_key unknown            -> figure dropped + flagged;
  * fact_key present, value None -> figure dropped + flagged; ABSENT != ZERO,
    a missing fact must never be echoed as 0.0.

Cached per accession (content-addressed over accession + prompt version +
facts digest + sections digest).  Dark -> typed AiUnavailable in the result.
"""

import datetime
import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from engine.public_market.freshness import (
    AiUnavailable,
    cache_key,
    cache_read,
    cache_write,
    parse_model_json,
)

ROLE = "pm_filing_reader"
PROMPT_VERSION = "pm-filing-brief-v1"

# Relative tolerance for "the model quoted the same number" -- generous
# enough for rounding in prose, far too tight for a materially wrong figure.
_REL_TOLERANCE = 1e-6


@dataclass(frozen=True)
class FigureEcho:
    """A figure served in the brief. ``value`` is ALWAYS the facts value."""

    label: str
    fact_key: str
    value: float
    model_claimed: Optional[float]
    matched: bool

    def as_dict(self):
        # type: () -> Dict[str, Any]
        return {
            "label": self.label,
            "fact_key": self.fact_key,
            "value": self.value,
            "model_claimed": self.model_claimed,
            "matched": self.matched,
        }


@dataclass
class SectionBrief:
    section: str
    summary: str
    figures: List[FigureEcho] = field(default_factory=list)

    def as_dict(self):
        # type: () -> Dict[str, Any]
        return {
            "section": self.section,
            "summary": self.summary,
            "figures": [f.as_dict() for f in self.figures],
        }


@dataclass
class FilingBriefResult:
    status: str  # "ok" or "unavailable"
    accession: str
    facts_digest: str
    updated_at: Optional[str] = None
    model: Optional[str] = None
    cache_hit: bool = False
    sections: List[SectionBrief] = field(default_factory=list)
    flags: List[Dict[str, Any]] = field(default_factory=list)
    unavailable: Optional[AiUnavailable] = None

    def as_dict(self):
        # type: () -> Dict[str, Any]
        out = {
            "status": self.status,
            "accession": self.accession,
            "facts_digest": self.facts_digest,
            "updated_at": self.updated_at,
            "model": self.model,
            "cache_hit": self.cache_hit,
            "sections": [s.as_dict() for s in self.sections],
            "flags": list(self.flags),
        }
        if self.unavailable is not None:
            out["unavailable"] = self.unavailable.as_dict()
        return out


def _digest_facts(xbrl_facts):
    # type: (Dict[str, Any]) -> str
    canon = json.dumps(
        {k: (None if v is None else float(v)) for k, v in xbrl_facts.items()},
        sort_keys=True,
    )
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def _digest_sections(sections):
    # type: (Dict[str, str]) -> str
    canon = json.dumps(sections, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def _build_prompt(accession, sections, xbrl_facts):
    # type: (str, Dict[str, str], Dict[str, Any]) -> str
    fact_keys = ", ".join(sorted(xbrl_facts.keys())) or "(none provided)"
    parts = [
        "You are a filings analyst. Summarize the narrative sections of "
        "filing %s below. Respond with ONLY JSON of this exact shape:\n"
        '{"sections": [{"section": "<name exactly as given>", '
        '"summary": "<3-5 sentence summary>", '
        '"figures": [{"label": "<what the number is>", '
        '"fact_key": "<one of the allowed fact keys>", '
        '"model_value": <number as stated in the text>}]}]}\n'
        "Allowed fact keys (cite figures ONLY through these): %s\n"
        "If a number in the text has no matching fact key, do not emit it."
        % (accession, fact_keys)
    ]
    for name in sorted(sections.keys()):
        parts.append("\n--- SECTION: %s ---\n%s" % (name, sections[name]))
    return "".join(parts)


def _coerce_number(value):
    # type: (Any) -> Optional[float]
    if isinstance(value, bool):  # bool is an int subclass; refuse it
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _numbers_match(a, b):
    # type: (float, float) -> bool
    scale = max(abs(a), abs(b), 1.0)
    return abs(a - b) <= _REL_TOLERANCE * scale


def _validate_brief(raw, provided_sections, xbrl_facts):
    # type: (Any, Dict[str, str], Dict[str, Any]) -> Optional[Dict[str, Any]]
    """Enforce the section + figure-echo contract. None -> invalid output."""
    if not isinstance(raw, dict) or not isinstance(raw.get("sections"), list):
        return None
    briefs = []  # type: List[SectionBrief]
    flags = []   # type: List[Dict[str, Any]]
    for item in raw["sections"]:
        if not isinstance(item, dict):
            flags.append({"type": "section_entry_invalid", "entry": repr(item)[:200]})
            continue
        name = item.get("section")
        summary = item.get("summary")
        if not isinstance(name, str) or name not in provided_sections:
            # Citations must point at sections we actually handed over.
            flags.append({"type": "unknown_section", "section": str(name)[:100]})
            continue
        if not isinstance(summary, str) or not summary.strip():
            flags.append({"type": "empty_summary", "section": name})
            continue
        figures = []  # type: List[FigureEcho]
        for fig in item.get("figures") or []:
            if not isinstance(fig, dict):
                flags.append({"type": "figure_entry_invalid", "section": name})
                continue
            fact_key = fig.get("fact_key")
            label = fig.get("label")
            model_value = _coerce_number(fig.get("model_value"))
            if not isinstance(fact_key, str) or not isinstance(label, str):
                flags.append({"type": "figure_entry_invalid", "section": name})
                continue
            if fact_key not in xbrl_facts:
                # The model referenced a number the facts do not carry:
                # dropped, flagged, and never served.
                flags.append(
                    {
                        "type": "unknown_fact_key",
                        "section": name,
                        "fact_key": fact_key,
                        "model_claimed": model_value,
                    }
                )
                continue
            facts_value = xbrl_facts[fact_key]
            if facts_value is None:
                # ABSENT != ZERO: a fact key with no value cannot be echoed.
                flags.append(
                    {
                        "type": "fact_value_absent",
                        "section": name,
                        "fact_key": fact_key,
                        "model_claimed": model_value,
                    }
                )
                continue
            facts_value = float(facts_value)
            matched = model_value is not None and _numbers_match(
                model_value, facts_value
            )
            if not matched:
                # Never corrected, always surfaced: both numbers stay on
                # record while the served value remains the facts value.
                flags.append(
                    {
                        "type": "model_facts_mismatch",
                        "section": name,
                        "fact_key": fact_key,
                        "model_claimed": model_value,
                        "facts_value": facts_value,
                        "disposition": "flagged_not_corrected",
                    }
                )
            figures.append(
                FigureEcho(
                    label=label.strip(),
                    fact_key=fact_key,
                    value=facts_value,
                    model_claimed=model_value,
                    matched=matched,
                )
            )
        briefs.append(
            SectionBrief(section=name, summary=summary.strip(), figures=figures)
        )
    return {"sections": briefs, "flags": flags}


def _from_cache_payload(accession, facts_digest, payload):
    # type: (str, str, Dict[str, Any]) -> Optional[FilingBriefResult]
    try:
        sections = [
            SectionBrief(
                section=s["section"],
                summary=s["summary"],
                figures=[
                    FigureEcho(
                        label=f["label"],
                        fact_key=f["fact_key"],
                        value=float(f["value"]),
                        model_claimed=f.get("model_claimed"),
                        matched=bool(f["matched"]),
                    )
                    for f in s["figures"]
                ],
            )
            for s in payload["sections"]
        ]
        return FilingBriefResult(
            status="ok",
            accession=accession,
            facts_digest=facts_digest,
            updated_at=payload["updated_at"],
            model=payload.get("model"),
            cache_hit=True,
            sections=sections,
            flags=list(payload.get("flags", [])),
        )
    except (KeyError, TypeError, ValueError):
        return None


def read_filing_brief(
    accession,     # type: str
    sections,      # type: Dict[str, str]
    xbrl_facts,    # type: Dict[str, Any]
    client,        # type: Any
    breaker,       # type: Any
    cache_dir,     # type: str
    now=None,      # type: Optional[datetime.datetime]
):
    # type: (...) -> FilingBriefResult
    """Structured brief over a filing's narrative sections, figure-echoed
    against the deterministic XBRL facts. Never raises for AI problems."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    facts_digest = _digest_facts(xbrl_facts)
    key = cache_key(
        "filing_brief", PROMPT_VERSION, accession, facts_digest,
        _digest_sections(sections),
    )

    cached = cache_read(cache_dir, key)
    if cached is not None:
        hydrated = _from_cache_payload(accession, facts_digest, cached)
        if hydrated is not None:
            return hydrated

    refusal = breaker.allow(ROLE)
    if refusal is not None:
        return FilingBriefResult(
            status="unavailable", accession=accession, facts_digest=facts_digest,
            unavailable=refusal,
        )

    completion = client.complete(
        ROLE, _build_prompt(accession, sections, xbrl_facts), max_tokens=2000
    )
    if isinstance(completion, AiUnavailable):
        return FilingBriefResult(
            status="unavailable", accession=accession, facts_digest=facts_digest,
            unavailable=completion,
        )

    breaker.record(ROLE)

    parsed = parse_model_json(completion.text)
    validated = (
        _validate_brief(parsed, sections, xbrl_facts) if parsed is not None else None
    )
    if validated is None:
        return FilingBriefResult(
            status="unavailable", accession=accession, facts_digest=facts_digest,
            unavailable=AiUnavailable(
                reason="model_output_invalid",
                detail="filing brief reply did not match the sections contract",
            ),
        )

    updated_at = now.isoformat()
    result = FilingBriefResult(
        status="ok",
        accession=accession,
        facts_digest=facts_digest,
        updated_at=updated_at,
        model=completion.model,
        cache_hit=False,
        sections=validated["sections"],
        flags=validated["flags"],
    )
    cache_write(
        cache_dir,
        key,
        {
            "accession": accession,
            "facts_digest": facts_digest,
            "updated_at": updated_at,
            "model": completion.model,
            "sections": [s.as_dict() for s in validated["sections"]],
            "flags": validated["flags"],
        },
        stored_at=updated_at,
    )
    return result
