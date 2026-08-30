# -*- coding: utf-8 -*-
"""The ``pm1`` public_market envelope — shape, normalizer, canonical
serialization, content hash.

RELATIONSHIP TO THE ADAPTERS (read this before changing anything)
-----------------------------------------------------------------
``edgar.build_envelope`` already produces a complete, provenance-carrying
document. This module does NOT redefine it and does not ask the adapter
to change: pm1 is a strict SUPERSET of what the adapter emits, and
:func:`normalize_envelope` is a THIN, ADDITIVE normalizer —

  * every key the adapter wrote is carried through byte-identically;
  * the spine adds only what the adapter cannot know: ``version``,
    ``entity_id``, ``market_id``, the ``market`` block (display name,
    currency, licence line — read from the registry), the OPTIONAL
    ``price`` block, and ``content_hash``;
  * per-figure provenance gains ONE derived key, ``accession_or_version``
    (= ``accession`` else ``dataset_version``), so the pm1 provenance
    contract {source, accession_or_version, as_of, fetched_at} is
    satisfiable without renaming anything the adapter owns.

Nothing is removed, nothing is retyped. If a future adapter emits pm1
natively, ``normalize_envelope`` becomes a no-op for it rather than a
second translation layer.

LAWS
----
* **ABSENT != ZERO.** A figure the filer never tagged is simply not in
  ``figures`` and appears in ``refusals`` with a typed code. There is no
  place in this module where a missing figure becomes 0.
* **Integer minor units.** Monetary figures carry ``value_minor`` (an
  int) plus ``currency`` / ``minor_unit``. Counts (shares) carry
  ``value`` + ``unit`` and are never run through minor-unit conversion —
  3 700 shares must never be read as 37.00 of anything.
* **The price block's ABSENCE is designed.** Keyless mode omits the
  ``price`` key entirely (``prices.price_block`` returns None). A null
  placeholder would be a claim; an absent key is the truth.
* **Sibling, never a citizen.** ``status`` is always ``PUBLIC_MARKET``
  and these envelopes never enter packs / reconcile / consensus
  (``engine.api._reconcile.is_public_market_envelope`` refuses them at
  the same seam that refuses ``public_summary``).

Python 3.9: no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import copy
import hashlib
import json
from typing import Any, Dict, List, Optional, Tuple

from engine.public_market import registry as _registry

#: The public_market envelope contract version. Parallel to — and never
#: reusing — the canonical serve stamp "sv1" or the summary tier's "ps1".
PUBLIC_MARKET_VERSION = "pm1"

#: The parallel presentation status. NEVER a MACHINE_STATUSES member.
PUBLIC_MARKET_STATUS = "PUBLIC_MARKET"

#: Document class marker (matches what the adapters already write).
PUBLIC_MARKET_DOC_CLASS = "public_market"

#: Keys excluded from the content hash. A DENYLIST, never an allowlist —
#: the public_ro page-cache lesson: digest whole rows and pay a cache
#: miss when a key is added; digest a picked list and one forgotten key
#: serves a stale fact under a fresh hash.
#:   content_hash — the field being computed
#:   meta         — cache bookkeeping the adapter flips AFTER the
#:                  envelope exists (cached / cache_reason); it says
#:                  nothing about the document's content
HASH_EXCLUDED_KEYS = ("content_hash", "meta")

#: Required top-level keys of a pm1 envelope.
REQUIRED_KEYS = (
    "version",
    "doc_class",
    "status",
    "entity_id",
    "market_id",
    "market",
    "entity",
    "figures",
    "refusals",
    "provenance",
)

#: The pm1 per-figure provenance contract.
PROVENANCE_KEYS = ("source", "accession_or_version", "as_of", "fetched_at")

#: The optional price block's contract: {price, currency, as_of,
#: delay_note}, with the price materialized as ``price_minor`` — an
#: INTEGER in minor units, exactly like every other money field in this
#: envelope. A float price here would be the one number in the document
#: that cannot be compared exactly, and a market cap is a multiplication
#: away from it. Its ABSENCE is a designed state (keyless mode).
PRICE_KEYS = ("price_minor", "currency", "as_of", "delay_note")


class ModelError(ValueError):
    """A document that cannot be normalized into pm1 without guessing."""


# ── entity ids ──────────────────────────────────────────────────────


def mint_entity_id(kind: str, value: Any) -> str:
    """Deterministic entity id, delegated to the entity lane.

    ``entity.mint_entity_id`` is the ONE minting authority (stable hash
    of a normalized deterministic key: isin / lei / cik), so two stores
    built independently agree on ids. This wrapper exists only so the
    spine has a single import point and normalizes the raw value first.
    """
    from engine.public_market import entity as _entity

    if kind not in _entity.DETERMINISTIC_KEY_PRECEDENCE:
        raise ModelError("unknown deterministic key kind %r" % kind)
    # The entity lane exports one public normalizer per key kind
    # (normalize_isin / normalize_lei / normalize_cik) — resolved by name
    # so adding a fourth key kind there needs no edit here.
    normalizer = getattr(_entity, "normalize_%s" % kind, None)
    if normalizer is None:  # pragma: no cover — guarded by the check above
        raise ModelError("entity lane exports no normalizer for %r" % kind)
    return _entity.mint_entity_id(kind, normalizer(value))


def entity_id_from_envelope(raw: Dict[str, Any]) -> Optional[str]:
    """Best deterministic id available on an adapter envelope, by the
    entity lane's own precedence (isin > lei > cik). Returns None when
    the document carries no deterministic key — the caller then queues a
    review entry rather than minting an id from a name."""
    from engine.public_market import entity as _entity

    if not isinstance(raw, dict):
        return None
    if isinstance(raw.get("entity_id"), str) and raw["entity_id"]:
        return raw["entity_id"]
    entity_block = raw.get("entity")
    if not isinstance(entity_block, dict):
        return None
    for kind in _entity.DETERMINISTIC_KEY_PRECEDENCE:
        value = entity_block.get(kind)
        if value in (None, ""):
            continue
        try:
            return mint_entity_id(kind, value)
        except Exception:  # noqa: BLE001 — a malformed key is not an id
            continue
    return None


# ── provenance normalization (additive) ─────────────────────────────


def derive_accession_or_version(provenance: Dict[str, Any]) -> Optional[str]:
    """``accession`` else ``dataset_version`` else None. NEVER a
    fabricated placeholder — a figure whose source version cannot be
    named is a figure whose provenance is incomplete, and the validator
    says so out loud."""
    for key in ("accession_or_version", "accession", "dataset_version"):
        value = provenance.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _normalized_provenance(provenance: Any) -> Dict[str, Any]:
    """The adapter's provenance dict, plus the derived
    ``accession_or_version``. Additive: no key is removed or retyped."""
    if not isinstance(provenance, dict):
        return {}
    out = dict(provenance)
    if "accession_or_version" not in out:
        out["accession_or_version"] = derive_accession_or_version(provenance)
    return out


def provenance_view(figure: Any) -> Optional[Dict[str, Any]]:
    """The four-key pm1 provenance view of one figure — or None when the
    figure carries no provenance at all."""
    if not isinstance(figure, dict):
        return None
    provenance = figure.get("provenance")
    if not isinstance(provenance, dict):
        return None
    normalized = _normalized_provenance(provenance)
    return dict((key, normalized.get(key)) for key in PROVENANCE_KEYS)


# ── figure accessors (the one reader every consumer uses) ───────────


def figure(envelope: Any, name: str) -> Optional[Dict[str, Any]]:
    """One figure dict, or None when the feed never carried it.

    None is ABSENCE, and absence is the whole point: callers turn it into
    a typed refusal. Nothing here ever substitutes a zero."""
    if not isinstance(envelope, dict):
        return None
    figures = envelope.get("figures")
    if not isinstance(figures, dict):
        return None
    value = figures.get(name)
    return value if isinstance(value, dict) else None


def figure_minor(envelope: Any, name: str) -> Optional[int]:
    """Integer minor units of one MONETARY figure, or None.

    Refuses (returns None) for a non-int ``value_minor``: a float that
    slipped into a minor-units field is a rounding bug wearing a number's
    clothes, and coercing it here would launder it."""
    fig = figure(envelope, name)
    if fig is None:
        return None
    value = fig.get("value_minor")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def figure_count(envelope: Any, name: str) -> Optional[int]:
    """Integer COUNT of one non-monetary figure (e.g. shares
    outstanding), or None. Deliberately a separate accessor from
    :func:`figure_minor` so a count can never be read as money."""
    fig = figure(envelope, name)
    if fig is None:
        return None
    value = fig.get("value")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def figure_currency(envelope: Any, name: str) -> Optional[str]:
    fig = figure(envelope, name)
    if fig is None:
        return None
    value = fig.get("currency")
    return value if isinstance(value, str) and value else None


def figure_provenance(envelope: Any, name: str) -> Optional[Dict[str, Any]]:
    return provenance_view(figure(envelope, name))


def price_block(envelope: Any) -> Optional[Dict[str, Any]]:
    """The OPTIONAL price block, or None. None here means the key is
    absent — keyless mode — not that a price was zero."""
    if not isinstance(envelope, dict):
        return None
    block = envelope.get("price")
    return block if isinstance(block, dict) else None


def refusal_codes(envelope: Any) -> Tuple[str, ...]:
    """Every figure-level refusal code on the envelope, sorted."""
    if not isinstance(envelope, dict):
        return ()
    refusals = envelope.get("refusals")
    if not isinstance(refusals, list):
        return ()
    codes = [
        str(item.get("code"))
        for item in refusals
        if isinstance(item, dict) and item.get("code")
    ]
    return tuple(sorted(codes))


def is_public_market_envelope(obj: Any) -> bool:
    """The document-class predicate every sibling seam shares.

    Deliberately structural (doc_class + status + a dict ``figures``),
    not version-pinned: a pm2 envelope is still a public_market document
    and must still be refused by reconcile. Never raises."""
    if not isinstance(obj, dict):
        return False
    if obj.get("doc_class") != PUBLIC_MARKET_DOC_CLASS:
        return False
    if obj.get("status") != PUBLIC_MARKET_STATUS:
        return False
    return isinstance(obj.get("figures"), dict)


# ── canonical serialization + content hash ──────────────────────────


def canonical_json(envelope: Dict[str, Any]) -> str:
    """Sorted-key, separator-stable JSON of the hashable content.

    Deterministic by construction: sorted keys, no whitespace drift, no
    clock, no ``hash()``. The excluded keys are the documented denylist
    (:data:`HASH_EXCLUDED_KEYS`)."""
    if not isinstance(envelope, dict):
        raise ModelError("canonical_json needs a dict envelope")
    payload = dict(
        (key, value)
        for key, value in envelope.items()
        if key not in HASH_EXCLUDED_KEYS
    )
    return json.dumps(payload, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def content_hash(envelope: Dict[str, Any]) -> str:
    """``sha256:<hex>`` over :func:`canonical_json`."""
    digest = hashlib.sha256(canonical_json(envelope).encode("utf-8")).hexdigest()
    return "sha256:%s" % digest


def stamp_content_hash(envelope: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy carrying its own ``content_hash``. Idempotent: the
    hash is computed over the content EXCLUDING the hash field, so
    re-stamping a stamped envelope yields the same value."""
    out = dict(envelope)
    out["content_hash"] = content_hash(out)
    return out


# ── the normalizer ──────────────────────────────────────────────────


def _market_block(market: "_registry.Market") -> Dict[str, Any]:
    """The registry facts an envelope must carry with it so the serving
    layer never has to re-open the registry to label a number (currency,
    licence line, market status all travel WITH the figure)."""
    return {
        "market_id": market.market_id,
        "display_name": market.display_name,
        "currency": market.currency,
        "accounting_standard": market.accounting_standard,
        "exchanges": list(market.exchanges),
        "status": market.status,
        "license_notes": market.license_notes,
        "refresh_cadence": market.refresh_cadence,
        "price_source": market.price_source,
        "fundamentals_source": market.fundamentals_source,
    }


def normalize_envelope(raw: Dict[str, Any], market: Any,
                       entity_id: Optional[str] = None,
                       price: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Adapter envelope -> pm1. Pure, additive, deterministic.

    ``market`` is a :class:`registry.Market` or a market id. ``price`` is
    the OPTIONAL price block: pass None (the keyless default,
    ``prices.price_block``'s designed absence) and the ``price`` key is
    OMITTED — never written as null.

    Raises :class:`ModelError` rather than guessing when the document is
    not a public_market document or carries no deterministic entity key.
    """
    if not isinstance(raw, dict):
        raise ModelError("normalize_envelope needs a dict envelope")
    if not isinstance(raw.get("figures"), dict):
        raise ModelError("envelope has no figures map")
    status = raw.get("status")
    if status is not None and status != PUBLIC_MARKET_STATUS:
        raise ModelError(
            "refusing to normalize a document whose status is %r — pm1 is the "
            "public_market sibling class and never relabels another class"
            % (status,)
        )
    market_obj = market if isinstance(market, _registry.Market) \
        else _registry.get_market(market)

    resolved_entity_id = entity_id or entity_id_from_envelope(raw)
    if not resolved_entity_id:
        raise ModelError(
            "no deterministic entity key (isin/lei/cik) on this document — "
            "an id minted from a name would link two companies silently; "
            "queue the record for review instead"
        )

    out = copy.deepcopy(raw)
    figures = {}
    for name, fig in out["figures"].items():
        if isinstance(fig, dict) and "provenance" in fig:
            fig = dict(fig)
            fig["provenance"] = _normalized_provenance(fig.get("provenance"))
        figures[name] = fig
    out["figures"] = figures
    if isinstance(out.get("provenance"), dict):
        out["provenance"] = _normalized_provenance(out["provenance"])
    else:
        out["provenance"] = {}
    out.setdefault("refusals", [])

    out["version"] = PUBLIC_MARKET_VERSION
    out["doc_class"] = PUBLIC_MARKET_DOC_CLASS
    out["status"] = PUBLIC_MARKET_STATUS
    out["entity_id"] = resolved_entity_id
    out["market_id"] = market_obj.market_id
    out["market"] = _market_block(market_obj)

    if price is not None:
        if not isinstance(price, dict):
            raise ModelError("price block must be a dict or None")
        out["price"] = dict(price)
    else:
        # Designed absence — the key is REMOVED, not nulled. A null price
        # is a claim about a number; an absent key is the truth.
        out.pop("price", None)

    return stamp_content_hash(out)


# ── validation ──────────────────────────────────────────────────────


def validate_envelope(envelope: Any) -> List[str]:
    """Every pm1 contract violation, as human lines. Empty list == valid.

    Returns rather than raises: the store records violations alongside
    the document it refused, and a caller that raised would lose them.
    """
    problems: List[str] = []
    if not isinstance(envelope, dict):
        return ["envelope is not a dict"]

    for key in REQUIRED_KEYS:
        if key not in envelope:
            problems.append("missing required key %r" % key)
    if envelope.get("version") != PUBLIC_MARKET_VERSION:
        problems.append("version must be %r (got %r)"
                        % (PUBLIC_MARKET_VERSION, envelope.get("version")))
    if envelope.get("status") != PUBLIC_MARKET_STATUS:
        problems.append("status must be %r (got %r)"
                        % (PUBLIC_MARKET_STATUS, envelope.get("status")))
    if envelope.get("doc_class") != PUBLIC_MARKET_DOC_CLASS:
        problems.append("doc_class must be %r (got %r)"
                        % (PUBLIC_MARKET_DOC_CLASS, envelope.get("doc_class")))

    market_id = envelope.get("market_id")
    if isinstance(market_id, str) and market_id:
        if _registry.find_market(market_id) is None:
            problems.append("market_id %r is not in the registry" % market_id)

    figures = envelope.get("figures")
    if not isinstance(figures, dict):
        problems.append("figures must be a dict")
    else:
        for name in sorted(figures):
            fig = figures[name]
            if not isinstance(fig, dict):
                problems.append("figure %r is not a dict" % name)
                continue
            has_minor = isinstance(fig.get("value_minor"), int) \
                and not isinstance(fig.get("value_minor"), bool)
            has_count = isinstance(fig.get("value"), int) \
                and not isinstance(fig.get("value"), bool)
            if not has_minor and not has_count:
                problems.append(
                    "figure %r carries neither an integer value_minor "
                    "(money) nor an integer value (count)" % name
                )
            if has_minor and not fig.get("currency"):
                problems.append("monetary figure %r has no currency" % name)
            view = provenance_view(fig)
            if view is None:
                problems.append("figure %r has no provenance" % name)
                continue
            for key in PROVENANCE_KEYS:
                if not view.get(key):
                    problems.append("figure %r provenance is missing %r"
                                    % (name, key))

    price = envelope.get("price")
    if price is not None:
        if not isinstance(price, dict):
            problems.append("price must be a dict when present")
        else:
            for key in PRICE_KEYS:
                if key not in price:
                    problems.append("price block is missing %r" % key)

    stamped = envelope.get("content_hash")
    if not isinstance(stamped, str) or not stamped.startswith("sha256:"):
        problems.append("content_hash must be a 'sha256:<hex>' string")
    elif stamped != content_hash(envelope):
        problems.append("content_hash does not match the envelope content")

    return problems
