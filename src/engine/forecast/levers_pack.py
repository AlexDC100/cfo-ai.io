"""Loads ``packs/forecast/levers.yaml`` — the lever registry's pack data.

Pure data in, frozen objects out (plan_contract_v2 3a, 0.6). Every rule
id, sentence, cutoff, step and budget the one forecast engine reads is an
address in that file, never a literal in code (TC-10), and each section is
read here through an accessor named after it, so pack-key liveness (S8)
can tell a read key from a dead one.

A malformed pack RAISES at first use rather than degrading: a projection
that silently fell back to a built-in sentence would state a convention
nobody can audit.

Sections read so far, by the batch that added them (contract 3a.4):

- B2: ``tax`` — the two tax conventions of 6.3 (rule ids and sentences).

Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional, Tuple

import yaml

__all__ = [
    "PACK_FILE",
    "PackError",
    "TaxConvention",
    "load_levers",
    "tax_conventions",
]

#: The pack's address prefix, as a rule id writes it.
PACK_FILE = "packs/forecast/levers.yaml"

SCHEMA_VERSION = "forecast_levers/1"


class PackError(RuntimeError):
    """The lever pack is unusable. Never swallowed."""


def _clean(text):
    # type: (str) -> str
    """Folded scalars arrive with soft wraps; one space between words."""
    return " ".join(str(text).split())


def _mapping(raw, where):
    # type: (Any, str) -> Dict[str, Any]
    if not isinstance(raw, dict):
        raise PackError("%s: must be a mapping" % where)
    return raw


def _text(raw, key, where):
    # type: (Dict[str, Any], str, str) -> str
    if key not in raw:
        raise PackError("%s: missing required key %r" % (where, key))
    value = raw[key]
    if not isinstance(value, str) or not value.strip():
        raise PackError("%s: %r must be a non-empty string" % (where, key))
    return _clean(value)


class TaxConvention(object):
    """One tax convention: its served id, its rule address, its sentence."""

    __slots__ = ("key", "convention_id", "rule_id", "sentence")

    def __init__(self, key, raw):
        # type: (str, Any) -> None
        where = "%s#tax.%s" % (PACK_FILE, key)
        body = _mapping(raw, where)
        self.key = key
        self.convention_id = _text(body, "convention_id", where)
        self.rule_id = where
        self.sentence = _text(body, "sentence", where)
        if any(ch.isdigit() for ch in self.sentence):
            # A numeral in a convention sentence is a cutoff written as
            # prose; TC-10 wants it rendered from the data that used it.
            raise PackError("%s: the sentence carries a numeral" % where)


class LeversPack(object):
    """The parsed pack. Sections are validated at load, all at once."""

    __slots__ = ("path", "tax")

    #: The tax conventions of contract 6.3, in the order they are served.
    TAX_KEYS = ("accrued_year_to_date", "no_loss_carry_forward")

    def __init__(self, path, raw):
        # type: (str, Any) -> None
        self.path = path
        body = _mapping(raw, PACK_FILE)
        version = body.get("schema_version")
        if version != SCHEMA_VERSION:
            raise PackError("%s: schema_version must be %r, got %r"
                            % (PACK_FILE, SCHEMA_VERSION, version))
        tax = _mapping(body.get("tax"), "%s#tax" % PACK_FILE)
        unknown = sorted(set(tax) - set(self.TAX_KEYS))
        missing = [k for k in self.TAX_KEYS if k not in tax]
        if unknown or missing:
            raise PackError("%s#tax: expected exactly %s; missing %s, unknown %s"
                            % (PACK_FILE, ", ".join(self.TAX_KEYS),
                               missing or "none", unknown or "none"))
        self.tax = tuple(TaxConvention(k, tax[k]) for k in self.TAX_KEYS)
        ids = [c.convention_id for c in self.tax]
        if len(set(ids)) != len(ids):
            raise PackError("%s#tax: two conventions share an id: %s"
                            % (PACK_FILE, ids))


def _pack_path():
    # type: () -> str
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, "..", "..", ".."))
    return os.path.join(root, PACK_FILE)


_CACHE = {}  # type: Dict[str, LeversPack]


def load_levers(path=None):
    # type: (Optional[str]) -> LeversPack
    """Read once per path, cache, hand back the frozen pack."""
    target = path or _pack_path()
    cached = _CACHE.get(target)
    if cached is not None:
        return cached
    if not os.path.isfile(target):
        raise PackError("forecast lever pack not found: %s" % target)
    with open(target, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    pack = LeversPack(target, raw)
    _CACHE[target] = pack
    return pack


def tax_conventions(path=None):
    # type: (Optional[str]) -> Tuple[TaxConvention, ...]
    """``levers.yaml#tax``: the year-to-date accrual and the no-carry-forward
    conventions, in served order."""
    return load_levers(path).tax
