"""The P&L definition pack (``packs/ro/pl_definition.yaml``) — owner rulings
2026-09-28, R2 and R3.

Two statement PLACEMENTS the one assembly
(``chart_of_accounts.assemble_statements``) applies to accounts the frozen
classification pack has already classified:

  R3  7411 — operating subsidies related to turnover — sits INSIDE cifra de
      afaceri netă, as the statutory F20 prints it (rd. 01 = rd. 02 … rd. 05;
      rd. 05 is ct. 7411): net turnover = class 70 − 709 + 7411.
  R2  6812 / 6814 charges AND 7812 / 7814 reversals sit OUTSIDE EBITDA,
      symmetric; their net (charges − reversals) is its own line between
      EBITDA and the operating result. EBIT = EBITDA − D&A − net provisions,
      unchanged in value.

Every account list and every line name the engine prints for these two
rulings is read from the pack and RENDERED here (TC-10): a code literal of
"6812" or "7411" in a consumer is a second definition. The pack is
validated on load and a malformed pack raises — there is no default
placement to fall back to.

Python 3.9 — no `match`, no `X | Y`.
"""
from __future__ import annotations

import functools
import os
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping, Optional, Tuple

import yaml

__all__ = [
    "PACK_FILE",
    "PlDefinitionPackError",
    "definition",
    "pack_path",
    "turnover_prefixes",
    "is_turnover_placement",
    "provision_charge_prefixes",
    "provision_reversal_prefixes",
    "matches",
    "net_provisions_label",
    "depreciation_label",
    "turnover_accounts_label",
    "other_operating_income_accounts_label",
    "bridge_net_provisions_label",
]

SCHEMA = "ro_pl_definition/1"
DEFAULT_PACKS_DIR = Path(__file__).resolve().parents[4] / "packs" / "ro"
PACK_NAME = "pl_definition.yaml"
PACK_FILE = "packs/ro/%s" % PACK_NAME


class PlDefinitionPackError(RuntimeError):
    """packs/ro/pl_definition.yaml is unusable. Raised, never defaulted."""


def _pack_path() -> Path:
    override = os.environ.get("RO_PL_DEFINITION_PACKS_DIR")
    return (Path(override) if override else DEFAULT_PACKS_DIR) / PACK_NAME


def pack_path() -> Path:
    """The pack file this process reads (``RO_PL_DEFINITION_PACKS_DIR``
    overrides the directory) — named in the boot check's message."""
    return _pack_path()


def _text(raw: Any, where: str) -> Dict[str, str]:
    if (not isinstance(raw, Mapping) or not isinstance(raw.get("ro"), str)
            or not isinstance(raw.get("en"), str) or not raw["ro"].strip()
            or not raw["en"].strip()):
        raise PlDefinitionPackError("%s#%s: a ro and an en string are required"
                                    % (PACK_FILE, where))
    return {"ro": raw["ro"].strip(), "en": raw["en"].strip()}


def _codes(raw: Any, where: str) -> Tuple[str, ...]:
    if (not isinstance(raw, list) or not raw
            or not all(isinstance(c, str) and c.isdigit() for c in raw)):
        raise PlDefinitionPackError("%s#%s: a non-empty list of account-code strings is required"
                                    % (PACK_FILE, where))
    return tuple(raw)


def _str(raw: Any, where: str) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise PlDefinitionPackError("%s#%s: a string is required" % (PACK_FILE, where))
    return raw.strip()


@functools.lru_cache(maxsize=4)
def _load(path: str) -> Dict[str, Any]:
    try:
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    except OSError as exc:
        raise PlDefinitionPackError("%s: cannot be read (%s)" % (PACK_FILE, exc))
    if not isinstance(raw, Mapping) or raw.get("schema_version") != SCHEMA:
        raise PlDefinitionPackError("%s: schema_version %r is required" % (PACK_FILE, SCHEMA))
    t = raw.get("turnover") or {}
    p = raw.get("provisions_outside_ebitda") or {}
    d = raw.get("depreciation") or {}
    o = raw.get("other_operating_income") or {}
    out = {
        "turnover": {
            "extra_prefixes": _codes(t.get("extra_prefixes"), "turnover.extra_prefixes"),
            "placed_from_line": _str(t.get("placed_from_line"), "turnover.placed_from_line"),
            "base_accounts": _str(t.get("base_accounts"), "turnover.base_accounts"),
            "source": _str(t.get("source"), "turnover.source"),
            "name": _text(t.get("name"), "turnover.name"),
            "placement_note": _text(t.get("placement_note"), "turnover.placement_note"),
        },
        "provisions": {
            "charges": _codes(p.get("charges"), "provisions_outside_ebitda.charges"),
            "charges_from_line": _str(p.get("charges_from_line"),
                                      "provisions_outside_ebitda.charges_from_line"),
            "reversals": _codes(p.get("reversals"), "provisions_outside_ebitda.reversals"),
            "reversals_from_line": _str(p.get("reversals_from_line"),
                                        "provisions_outside_ebitda.reversals_from_line"),
            "name": _text(p.get("name"), "provisions_outside_ebitda.name"),
            "bridge_suffix": _text(p.get("bridge_suffix"), "provisions_outside_ebitda.bridge_suffix"),
        },
        "depreciation": {
            "name": _text(d.get("name"), "depreciation.name"),
            "base_accounts": _str(d.get("base_accounts"), "depreciation.base_accounts"),
            "without": _text(d.get("without"), "depreciation.without"),
        },
        "other_operating_income": {
            "name": _text(o.get("name"), "other_operating_income.name"),
            "base_accounts": _str(o.get("base_accounts"), "other_operating_income.base_accounts"),
        },
    }
    # A charge must be an expense account, a reversal an income account and
    # a turnover placement a class-7 account: a list that crossed classes
    # would move an amount to the wrong side of the result.
    for c in out["provisions"]["charges"]:
        if not c.startswith("6"):
            raise PlDefinitionPackError("%s#provisions_outside_ebitda.charges: %s is not a class-6 "
                                        "account" % (PACK_FILE, c))
    for c in out["provisions"]["reversals"] + out["turnover"]["extra_prefixes"]:
        if not c.startswith("7"):
            raise PlDefinitionPackError("%s: %s is not a class-7 account" % (PACK_FILE, c))
    return out


def definition() -> Dict[str, Any]:
    """The validated pack (cached per path)."""
    return _load(str(_pack_path()))


def matches(code: Any, prefixes: Iterable[str]) -> bool:
    """`code` (as the book writes it) falls under one of `prefixes` — the
    classification pack's `startswith` convention, so "7814", "7814.01" and
    "781401" all fall under 7814."""
    c = str(code or "").strip()
    return bool(c) and any(c.startswith(p) for p in prefixes)


def turnover_prefixes() -> Tuple[str, ...]:
    return definition()["turnover"]["extra_prefixes"]


def is_turnover_placement(code: Any, classified_line: Optional[str]) -> bool:
    """A leaf the pack places inside net turnover: an extra-turnover account
    the classification routed to the line the placement moves from."""
    t = definition()["turnover"]
    return classified_line == t["placed_from_line"] and matches(code, t["extra_prefixes"])


def provision_charge_prefixes() -> Tuple[str, ...]:
    return definition()["provisions"]["charges"]


def provision_reversal_prefixes() -> Tuple[str, ...]:
    return definition()["provisions"]["reversals"]


def net_provisions_label() -> Dict[str, str]:
    """"Provizioane și ajustări nete (6812 + 6814 − 7812 − 7814)" — the name
    and the accounts, both from the pack."""
    p = definition()["provisions"]
    accounts = "%s − %s" % (" + ".join(p["charges"]), " − ".join(p["reversals"]))
    return {"ro": "%s (%s)" % (p["name"]["ro"], accounts),
            "en": "%s (%s)" % (p["name"]["en"], accounts),
            "accounts": accounts}


def bridge_net_provisions_label() -> Dict[str, str]:
    lab = net_provisions_label()
    suf = definition()["provisions"]["bridge_suffix"]
    return {"ro": "%s — %s" % (lab["ro"], suf["ro"]), "en": "%s — %s" % (lab["en"], suf["en"])}


def depreciation_label() -> Dict[str, str]:
    """"Amortizări și alte ajustări (68x fără 6812, 6814)"."""
    d = definition()["depreciation"]
    charges = ", ".join(definition()["provisions"]["charges"])
    return {"ro": d["name"]["ro"], "en": d["name"]["en"],
            "accounts_ro": "%s %s %s" % (d["base_accounts"], d["without"]["ro"], charges),
            "accounts_en": "%s %s %s" % (d["base_accounts"], d["without"]["en"], charges)}


def turnover_accounts_label() -> str:
    """"70x − 709 + 7411"."""
    t = definition()["turnover"]
    return "%s + %s" % (t["base_accounts"], " + ".join(t["extra_prefixes"]))


def other_operating_income_accounts_label() -> Dict[str, str]:
    """"74x, 75x, 77x, 78x (fără 7411, 7812, 7814)"."""
    o = definition()["other_operating_income"]
    without = definition()["depreciation"]["without"]
    left = ", ".join(definition()["turnover"]["extra_prefixes"]
                     + definition()["provisions"]["reversals"])
    return {"ro": "%s (%s %s)" % (o["base_accounts"], without["ro"], left),
            "en": "%s (%s %s)" % (o["base_accounts"], without["en"], left)}
