"""The attention pack (packs/serving/attention.yaml) — loaded, validated, frozen.

Every rule the composer applies and every string it serves lives in the pack,
so the document can print its own rules back (TC-10). A pack that is not
well formed raises `AttentionPackError` at load: a half-read rule table would
rank on a rule nobody wrote.

Pure: one file read, cached. Python 3.9 — no `match`, no `X | Y`.
"""
from __future__ import annotations

import copy
import os
from functools import lru_cache
from typing import Any, Dict, List, Mapping, Optional

import yaml

__all__ = ["PACK_SCHEMA", "AttentionPackError", "load_pack", "default_pack_path"]

PACK_SCHEMA = "attention/1"

#: The slot names a plan may use, and the modes that have a plan.
SLOT_NAMES = ("movement", "worst_vs_sector", "improvement", "finding")
MODES = ("with_prior", "single_period")
LANGS = ("ro", "en")
EVIDENCE_KINDS = ("statement", "ratio", "benchmark_row", "account")
STATEMENT_TABS = ("pl", "balance_sheet", "cash_flow")
#: The actions the composer offers (now._actions), each a label in the pack.
#: Ruling R4 (2026-09-28): ONE export action, `bank_export` — "Exportă
#: raportul pentru bancă" — whose target is the CFO Report PDF.
ACTION_KEYS = ("compare_prior", "compare_previous_period", "add_prior_year",
               "bank_export", "set_industry")


class AttentionPackError(RuntimeError):
    """packs/serving/attention.yaml is unusable. Never swallowed."""


def default_pack_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "..", "..", "packs", "serving",
                                        "attention.yaml"))


def _fail(where: str, message: str) -> None:
    raise AttentionPackError("%s: %s" % (where, message))


def _text(where: str, node: Any) -> Dict[str, str]:
    """A bilingual string: both languages, both non-empty."""
    if not isinstance(node, Mapping):
        _fail(where, "expected {ro, en}, got %r" % (node,))
    out = {}
    for lang in LANGS:
        value = node.get(lang)
        if not isinstance(value, str) or not value.strip():
            _fail(where, "missing the %s text" % lang)
        out[lang] = value
    extra = set(node) - set(LANGS)
    if extra:
        _fail(where, "unknown languages %s" % sorted(extra))
    return out


def _str_list(where: str, node: Any) -> List[str]:
    if not isinstance(node, list) or not all(isinstance(x, str) and x for x in node):
        _fail(where, "expected a list of names, got %r" % (node,))
    return list(node)


def _validate(raw: Any, where: str) -> Dict[str, Any]:
    if not isinstance(raw, Mapping):
        _fail(where, "the pack must be a mapping")
    if raw.get("schema") != PACK_SCHEMA:
        _fail(where, "schema is %r, expected %r" % (raw.get("schema"), PACK_SCHEMA))
    pack = copy.deepcopy(dict(raw))

    max_items = pack.get("max_items")
    if isinstance(max_items, bool) or not isinstance(max_items, int) or max_items < 1:
        _fail(where, "max_items must be a positive integer")

    slots = pack.get("slots")
    if not isinstance(slots, Mapping) or set(slots) != set(MODES):
        _fail(where, "slots must name exactly %s" % (MODES,))
    for mode in MODES:
        plan = _str_list("%s slots.%s" % (where, mode), slots[mode])
        if len(plan) > max_items:
            _fail(where, "slots.%s has more slots than max_items" % mode)
        bad = [s for s in plan if s not in SLOT_NAMES]
        if bad:
            _fail(where, "slots.%s names unknown slots %s" % (mode, bad))

    lines = pack.get("statement_lines")
    if not isinstance(lines, list) or not lines:
        _fail(where, "statement_lines must be a non-empty list")
    seen = set()
    for i, line in enumerate(lines):
        w = "%s statement_lines[%d]" % (where, i)
        if not isinstance(line, Mapping):
            _fail(w, "expected a mapping")
        key = line.get("key")
        if not isinstance(key, str) or not (key.startswith("pl.") or key.startswith("bs.")):
            _fail(w, "key must be a pl.* or bs.* comparatives column, got %r" % (key,))
        if key in seen:
            _fail(w, "duplicate key %s" % key)
        seen.add(key)
        if not isinstance(line.get("identity"), str) or not line["identity"]:
            _fail(w, "identity missing")
        if line.get("tab") not in STATEMENT_TABS:
            _fail(w, "tab must be one of %s" % (STATEMENT_TABS,))
        line["subject"] = _text(w + ".subject", line.get("subject"))
        line["requires_anchor"] = bool(line.get("requires_anchor", False))

    _str_list(where + " anchor_statuses", pack.get("anchor_statuses"))

    fam = _str_list(where + " improvement_family_order", pack.get("improvement_family_order"))
    if sorted(fam) != ["ratio_band", "statement_line"]:
        _fail(where, "improvement_family_order must order statement_line and ratio_band")

    sector = pack.get("sector")
    if not isinstance(sector, Mapping):
        _fail(where, "sector block missing")
    if sector.get("eligible_vs_sector") != "worse":
        _fail(where, "sector.eligible_vs_sector must be 'worse'")
    ids = sector.get("identities")
    if not isinstance(ids, Mapping) or not ids:
        _fail(where, "sector.identities missing")
    for key in _str_list(where + " sector.position_only", sector.get("position_only") or []):
        if key not in ids:
            _fail(where, "sector.position_only names %s, which has no identity" % key)
    for key, text in (sector.get("basis_labels") or {}).items():
        sector["basis_labels"][key] = _text("%s sector.basis_labels.%s" % (where, key), text)
    subjects = sector.get("subjects")
    if not isinstance(subjects, Mapping):
        _fail(where, "sector.subjects missing")
    for key in ids:
        if key not in subjects:
            _fail(where, "sector.subjects has no subject for %s" % key)
        sector["subjects"][key] = _text("%s sector.subjects.%s" % (where, key), subjects[key])

    rb = pack.get("ratio_band")
    if not isinstance(rb, Mapping):
        _fail(where, "ratio_band block missing")
    _str_list(where + " ratio_band.inventory_days_keys", rb.get("inventory_days_keys"))
    for k in ("composite_letter", "composite_score"):
        if not isinstance(rb.get(k), str):
            _fail(where, "ratio_band.%s missing" % k)
    for key, text in (rb.get("subjects") or {}).items():
        rb["subjects"][key] = _text("%s ratio_band.subjects.%s" % (where, key), text)

    ins = pack.get("insights")
    if not isinstance(ins, Mapping):
        _fail(where, "insights block missing")
    _str_list(where + " insights.material_levels", ins.get("material_levels"))
    detectors = ins.get("detectors")
    if not isinstance(detectors, Mapping) or not detectors:
        _fail(where, "insights.detectors missing")
    for det_id, spec in detectors.items():
        w = "%s insights.detectors.%s" % (where, det_id)
        if det_id in (ins.get("excluded") or {}):
            _fail(w, "a detector cannot be both excluded and described")
        if not isinstance(spec, Mapping):
            _fail(w, "expected a mapping")
        for k in ("identity", "headline"):
            if not isinstance(spec.get(k), str) or not spec[k]:
                _fail(w, "%s missing" % k)
        ev = spec.get("evidence")
        if not isinstance(ev, Mapping) or ev.get("kind") not in EVIDENCE_KINDS:
            _fail(w, "evidence.kind must be one of %s" % (EVIDENCE_KINDS,))
        if ev["kind"] == "statement" and ev.get("tab") not in STATEMENT_TABS:
            _fail(w, "a statement receiver needs a statement tab")
        if ev["kind"] == "ratio" and not ev.get("ratio"):
            _fail(w, "a ratio receiver needs a ratio key")
        spec["subject"] = _text(w + ".subject", spec.get("subject"))

    actions = pack.get("actions")
    if not isinstance(actions, Mapping):
        _fail(where, "actions missing")
    for key in ACTION_KEYS:
        if key not in actions:
            _fail(where, "actions.%s missing" % key)
        spec = actions[key]
        if not isinstance(spec, Mapping):
            _fail(where, "actions.%s: expected a mapping" % key)
        # Ruling R4: an action is its label — no feature gate, no target.
        # The bank report is the CFO Report PDF whatever the Forecast
        # registry says, and the composer (now._actions) owns the target.
        extra = sorted(set(spec) - {"label"})
        if extra:
            _fail(where, "actions.%s carries %s: an action carries its label only "
                  "(ruling R4 — the bank report never depends on a feature)" % (key, extra))
        spec["label"] = _text("%s actions.%s.label" % (where, key), spec.get("label"))
    unknown = sorted(set(actions) - set(ACTION_KEYS))
    if unknown:
        _fail(where, "actions %s are not composed by the engine (ruling R4: one export "
              "action, the bank report, which is the CFO Report PDF)" % (unknown,))

    caveats = pack.get("caveats")
    if not isinstance(caveats, Mapping):
        _fail(where, "caveats missing")
    for key in ("restated_comparatives", "single_period", "comparison_off"):
        caveats[key] = _text("%s caveats.%s" % (where, key), caveats.get(key))
    return pack


@lru_cache(maxsize=4)
def _load(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh)
    except OSError as exc:
        raise AttentionPackError("cannot read %s: %s" % (path, exc))
    return _validate(raw, path)


def load_pack(path: Optional[str] = None) -> Dict[str, Any]:
    """The validated pack. A deep copy, so no caller can edit the cache."""
    return copy.deepcopy(_load(path or default_pack_path()))
