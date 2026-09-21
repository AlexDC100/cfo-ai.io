"""Scenario templates as pack data, compiled by the ENGINE (forecast-scenarios-live).

``packs/scenarios/templates.yaml`` declares each template as shocks in the
lever registry's own vocabulary. This module loads that file, refuses a
malformed one at first use, and compiles one template over the driver keys a
book actually serves: a ``<prefix>.*`` key expands over the served keys with
that prefix, and a key (or pattern) the book does not serve refuses the whole
template BY NAME — a template run in part under its whole name would be a
different scenario.

The compiled shocks carry the ids and sources the plan contract reserves for
templates (``template:<id>:<n>``, source ``template:<id>``, 2.4); every one
starts in the first plan month with no ramp and no end, so a template is a
level move against the base plan.

Nothing here computes a figure. ``engine.forecast.levers.project_levers`` is
the one caller; the Scenarios page sends a template id and paints what comes
back.

Python 3.9 - no ``match``, no ``X | Y``.
"""

from __future__ import annotations

import os
import re
from fractions import Fraction
from typing import Any, Dict, List, Optional, Sequence, Tuple

import yaml

from .errors import PlanRequestError
from .levers_pack import PackError, _clean, _mapping, _text

__all__ = ["TEMPLATES_FILE", "ScenarioTemplate", "TemplateShock", "catalogue",
           "compile_template", "load_templates"]

#: The pack's address, as a rule id writes it.
TEMPLATES_FILE = "packs/scenarios/templates.yaml"
SCHEMA_VERSION = "scenario_templates/1"
BASE_TEMPLATE = "base"

_DECIMAL = re.compile(r"^-?[0-9]+(\.[0-9]+)?$")
_OPS = ("level_pct", "add_days", "add_pp")


class TemplateShock(object):
    __slots__ = ("driver_key", "op", "value", "text")

    def __init__(self, driver_key: str, op: str, text: str) -> None:
        self.driver_key = driver_key
        self.op = op
        self.text = text
        self.value = Fraction(text)

    @property
    def pattern(self) -> bool:
        return self.driver_key.endswith(".*")


class ScenarioTemplate(object):
    __slots__ = ("id", "shocks")

    def __init__(self, template_id: str, shocks: Sequence[TemplateShock]) -> None:
        self.id = template_id
        self.shocks = tuple(shocks)


class TemplatePack(object):
    __slots__ = ("pack_id", "jurisdiction", "family", "templates", "refusals")

    def __init__(self, raw: Any) -> None:
        body = _mapping(raw, TEMPLATES_FILE)
        if body.get("schema_version") != SCHEMA_VERSION:
            raise PackError("%s: schema_version must be %r"
                            % (TEMPLATES_FILE, SCHEMA_VERSION))
        self.pack_id = _text(body, "pack_id", TEMPLATES_FILE)
        self.jurisdiction = _text(body, "jurisdiction", TEMPLATES_FILE)
        self.family = _text(body, "family", TEMPLATES_FILE)
        where = "%s#refusals" % TEMPLATES_FILE
        refusals = _mapping(body.get("refusals"), where)
        self.refusals = dict((k, _clean(_text(refusals, k, where)))
                             for k in ("unknown_template", "unmatched_key"))
        items = body.get("templates")
        if not isinstance(items, list) or not items:
            raise PackError("%s#templates: a non-empty list" % TEMPLATES_FILE)
        seen = set()  # type: set
        templates = []  # type: List[ScenarioTemplate]
        for index, item in enumerate(items):
            where = "%s#templates[%d]" % (TEMPLATES_FILE, index)
            item = _mapping(item, where)
            template_id = _text(item, "id", where)
            if not re.match(r"^[a-z][a-z0-9_]*$", template_id):
                raise PackError("%s.id: %r is not a template id" % (where, template_id))
            if template_id in seen:
                raise PackError("%s.id: %r is declared twice" % (where, template_id))
            seen.add(template_id)
            shocks = []  # type: List[TemplateShock]
            for j, raw_shock in enumerate(item.get("shocks") or []):
                at = "%s.shocks[%d]" % (where, j)
                shock = _mapping(raw_shock, at)
                op = _text(shock, "op", at)
                if op not in _OPS:
                    raise PackError("%s.op: %r is not one of %s" % (at, op, ", ".join(_OPS)))
                value = shock.get("value")
                if not isinstance(value, str) or not _DECIMAL.match(value):
                    raise PackError("%s.value: a decimal STRING (never a float)" % (at,))
                shocks.append(TemplateShock(_text(shock, "driver_key", at), op, value))
            templates.append(ScenarioTemplate(template_id, shocks))
        if BASE_TEMPLATE not in seen:
            raise PackError("%s: the %r template (no shock) is required"
                            % (TEMPLATES_FILE, BASE_TEMPLATE))
        base = [t for t in templates if t.id == BASE_TEMPLATE][0]
        if base.shocks:
            raise PackError("%s: the %r template carries no shock" % (TEMPLATES_FILE,
                                                                    BASE_TEMPLATE))
        self.templates = tuple(templates)

    def get(self, template_id: str) -> Optional[ScenarioTemplate]:
        for template in self.templates:
            if template.id == template_id:
                return template
        return None


_CACHE = {}  # type: Dict[str, TemplatePack]


def _path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "..", "..", TEMPLATES_FILE))


def load_templates(path: Optional[str] = None) -> TemplatePack:
    target = path or _path()
    cached = _CACHE.get(target)
    if cached is not None:
        return cached
    if not os.path.isfile(target):
        raise PackError("scenario template pack not found: %s" % target)
    with open(target, "r", encoding="utf-8") as fh:
        pack = TemplatePack(yaml.safe_load(fh))
    _CACHE[target] = pack
    return pack


def _display(op: str, text: str) -> Dict[str, str]:
    """The shock as the reader reads it, in the unit the page prints: a level
    change in percent ("-20"), a days change in days ("30"). Exact decimal
    arithmetic HERE, so the page formats a served string and computes
    nothing."""
    value = Fraction(text)
    if op == "level_pct":
        value = value * 100
        unit = "percent"
    elif op == "add_days":
        unit = "days"
    else:
        value = value * 100
        unit = "percentage_points"
    sign = "-" if value < 0 else ""
    value = abs(value)
    digits = 0
    while (value * 10 ** digits).denominator != 1 and digits < 12:
        digits += 1
    scaled = int(value * 10 ** digits)
    whole = str(scaled).rjust(digits + 1, "0")
    shown = whole if digits == 0 else "%s.%s" % (whole[:-digits], whole[-digits:])
    return {"unit": unit, "value": sign + shown}


def catalogue() -> Dict[str, Any]:
    """Every template, as served to the page (GET
    /api/forecast/templates/scenarios): its id and its declared shocks with
    the display value the page prints. No figure of any book."""
    pack = load_templates()
    return {
        "pack_id": pack.pack_id, "source": TEMPLATES_FILE,
        "jurisdiction": pack.jurisdiction, "family": pack.family,
        "templates": [{
            "id": t.id,
            "shocks": [{"driver_key": s.driver_key, "op": s.op, "value": s.text,
                        "pattern": s.pattern, "display": _display(s.op, s.text)}
                       for s in t.shocks]} for t in pack.templates]}


def compile_template(template_id: str, served_keys: Sequence[str]
                     ) -> Tuple[ScenarioTemplate, List[Dict[str, Any]]]:
    """(template, wire shocks) over the driver keys ONE book serves, in the
    served order. Refuses (PlanRequestError, 422) an unknown template, and a
    template whose key or pattern this book does not serve."""
    pack = load_templates()
    template = pack.get(template_id)
    if template is None:
        raise PlanRequestError(
            "unknown_template",
            pack.refusals["unknown_template"].format(
                template=template_id,
                served=", ".join(t.id for t in pack.templates)),
            "template")
    served = list(served_keys)
    shocks = []  # type: List[Dict[str, Any]]
    n = 0
    for spec in template.shocks:
        if spec.pattern:
            prefix = spec.driver_key[:-1]
            keys = [k for k in served if k.startswith(prefix)]
            group = "template:%s:%s" % (template.id, prefix.rstrip("."))
        else:
            keys = [spec.driver_key] if spec.driver_key in served else []
            group = None
        if not keys:
            raise PlanRequestError(
                "template_key_not_served",
                pack.refusals["unmatched_key"].format(key=spec.driver_key,
                                                      template=template.id),
                "template")
        for key in keys:
            n += 1
            shocks.append({"id": "template:%s:%d" % (template.id, n),
                           "driver_key": key, "op": spec.op, "value": spec.text,
                           "start_month": 1, "ramp_months": 0, "end_month": None,
                           "source": "template:%s" % template.id,
                           "group_id": group})
    return template, shocks
