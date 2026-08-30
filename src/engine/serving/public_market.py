"""PUBLIC_MARKET presenter — the one wording authority for the global
public-markets tier (pm1 envelopes from ``engine.public_market``).

``present_public_market(envelope)`` is the market-tier sibling of
``present_public_summary`` and of ``present_status``: a PURE function of
the persisted envelope. No I/O, no DB lookup, no registry read at serve
time — everything the wording needs (market name, currency, licence
line, freshness cadence) was stamped INTO the envelope's ``market``
block when the spine normalized it, precisely so a served page cannot
disagree with the document it was rendered from.

It never touches the BALANCED / RECONCILED / MINOR_DRIFT /
MATERIAL_IMBALANCE ladder. A market document has no balance verdict, and
``PUBLIC_MARKET`` is a parallel presentation status — never a fifth
``MACHINE_STATUSES`` member, exactly as ``PUBLIC_SUMMARY`` is not.

WHAT THE WORDING PROMISES
    Every line here describes DETERMINISTIC feed data. The AI layer of
    this document class carries freshness, narrative and resolution — it
    never authors a digit, and nothing in this module reads an AI field.
    ``delay_note`` is surfaced verbatim from the price block when one
    exists; when it does not, ``price_line`` says so plainly rather than
    leaving a blank where a quote should be.

Import boundary: this module lives INSIDE src/engine/serving/ and is
re-exported via serving/__init__ (scripts/check_import_boundary.py skips
files under the gateway package; consumers import the re-exported name).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

#: The public_market envelope contract version. Parallel to (never
#: reusing) the canonical serve stamp "sv1" or the summary tier's "ps1".
#: Kept literal, mirroring ``engine.public_market.model`` — the serving
#: package must stay importable without the public_market package.
PUBLIC_MARKET_VERSION = "pm1"

#: The parallel presentation status. NEVER a MACHINE_STATUSES member.
PUBLIC_MARKET_STATUS = "PUBLIC_MARKET"

_DOC_CLASS = "public_market"

_NO_PRICE_EN = (
    "No licensed price feed for this market — fundamentals only"
)
_NO_PRICE_RO = (
    "Fără flux de prețuri licențiat pentru această piață — doar indicatori"
)


def _is_market_envelope(envelope: Any) -> bool:
    """Structural pm1 probe, identical to the gateway's and to
    ``_reconcile.is_public_market_envelope``. Never raises."""
    if not isinstance(envelope, dict):
        return False
    if envelope.get("doc_class") != _DOC_CLASS:
        return False
    if envelope.get("status") != PUBLIC_MARKET_STATUS:
        return False
    return isinstance(envelope.get("figures"), dict)


def _join(parts: List[Optional[str]]) -> str:
    return " · ".join([p for p in parts if p])


def present_public_market(envelope: Any) -> Optional[Dict[str, Any]]:
    """The presentation object for one pm1 public_market envelope.

    Returns ``{status, market_id, market_name, currency, trust_en,
    trust_ro, source_line, license_line, price_line, as_of,
    delay_note}`` — or None when the envelope is not a public_market
    document (the caller falls back to its own path). Pure and
    deterministic: same envelope, same output; the input is never
    mutated.
    """
    if not _is_market_envelope(envelope):
        return None

    market = envelope.get("market") if isinstance(envelope.get("market"), dict) else {}
    provenance = (
        envelope.get("provenance")
        if isinstance(envelope.get("provenance"), dict)
        else {}
    )
    price = envelope.get("price") if isinstance(envelope.get("price"), dict) else None

    market_id = str(envelope.get("market_id") or market.get("market_id") or "")
    market_name = str(market.get("display_name") or market_id or "")
    currency = str(market.get("currency") or "")
    standard = str(market.get("accounting_standard") or "")
    source = str(provenance.get("source") or "")
    as_of = provenance.get("as_of")
    as_of_label = str(as_of) if as_of else ""
    version = provenance.get("accession_or_version") or provenance.get("accession") \
        or provenance.get("dataset_version")

    # The trust line names WHAT the numbers are and WHERE they came from
    # — never how fresh they feel. "Filed data" is the claim; the fiscal
    # date beside it is the evidence.
    trust_en = _join([
        "Public filing data",
        market_name or None,
        standard or None,
        ("as of %s" % as_of_label) if as_of_label else None,
    ])
    trust_ro = _join([
        "Date din raportări publice",
        market_name or None,
        standard or None,
        ("la %s" % as_of_label) if as_of_label else None,
    ])

    source_line = _join([
        source or None,
        str(version) if version else None,
        as_of_label or None,
    ])

    if price is None:
        # Designed absence, said out loud. A blank price slot reads as a
        # loading state; this reads as a policy.
        price_line_en = _NO_PRICE_EN
        price_line_ro = _NO_PRICE_RO
        delay_note = None
    else:
        delay_note = price.get("delay_note")
        delay_note = str(delay_note) if delay_note else None
        price_line_en = delay_note or "Delayed price · cadence unverified"
        price_line_ro = delay_note or "Preț întârziat · cadență neverificată"

    return {
        "status": PUBLIC_MARKET_STATUS,
        "version": str(envelope.get("version") or PUBLIC_MARKET_VERSION),
        "market_id": market_id,
        "market_name": market_name,
        "market_status": str(market.get("status") or ""),
        "currency": currency,
        "accounting_standard": standard,
        "trust_en": trust_en,
        "trust_ro": trust_ro,
        "source_line": source_line,
        "license_line": str(market.get("license_notes") or ""),
        "price_line_en": price_line_en,
        "price_line_ro": price_line_ro,
        "delay_note": delay_note,
        "as_of": as_of_label or None,
        "refusal_count": len(envelope.get("refusals") or []),
    }
