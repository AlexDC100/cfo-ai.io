"""THE ARTIFACT SPEC — the shape the model is allowed to return, and nothing else.

THE LAW THIS MODULE KEEPS
=========================
    THE MODEL COMPOSES AND EXPLAINS; THE ENGINE COMPUTES.

The generative surface hands the model three things: the question, a
FACT INDEX SUMMARY (names and SHAPES — never a value it could retype),
and the artifact schemas from :func:`spec_tool_schema`. What comes back
is an ARTIFACT SPEC: metric ids, period ids, grouping, chart kind,
labels. Presentation and reference. No numbers.

That is not a prompt instruction. It is enforced HERE, at parse, by
construction:

  · **Unknown keys are refused.** ``{"series": [...]}`` cannot be
    accepted because ``series`` is not a key this schema has. There is
    no field anywhere in the spec that could HOLD a data series, so a
    well-formed spec carrying one does not exist.
  · **Numbers are refused everywhere except two bounded presentation
    slots** (``limit``, ``decimals``). A float is refused outright — no
    presentation field needs one. An integer outside those two slots is
    refused. An integer inside them but out of range is refused.
  · **A list containing a number is refused as a NUMERIC SERIES**, under
    its own code, so the plant that "returns a series" trips a refusal
    that names what it did — even when it hides inside a key the schema
    does know (``labels: [1, 2, 3]``). Unknown-key alone would have let
    that through, and a gate that goes red for the wrong reason is not
    evidence (TC-2).
  · **A string that parses as a number is refused.** ``"4834908159"`` is
    a value wearing a string's clothes.
  · **Prose carries no digits.** Title, subtitle, note, axis labels and
    series labels are model-authored text; a numeral in one of them is a
    figure the engine never computed. NO EXCEPTION FOR "it is just a
    chart label" — a caption saying "Revenue grew 12%" is a claim, and
    an unbacked one.

WHY IDS ARE NOT CHECKED FOR DIGITS, AND PROSE IS
------------------------------------------------
An id is verified by EXISTENCE: an unknown metric or an absent period
resolves to an honest gap card naming what is missing (C5, and
:mod:`engine.api._artifact_resolve` is where that happens). A model that
smuggles "4,834,908" into a metric id gets a gap card, not a leak.
Prose has no such backstop — it renders verbatim — so prose is verified
by ATTRIBUTION instead.

ATTRIBUTION, NOT A BAN ON DIGITS
--------------------------------
The prose guard is the ``finding_sharpen`` pattern: TEMPLATIZE, THEN
CHECK. :func:`attributable` lifts every correctly-rendered engine figure
back into its ``{{money:fact}}`` placeholder using the engine's own
authority on which printed token belongs to which cited fact
(:func:`engine.api._ratio_units.templatize`), and only then looks for
numerals. A figure the engine computed disappears; a figure it did not
stays as digits and is refused.

At PARSE time the fact map is empty on purpose — the model was never
shown a value, so nothing it wrote can lift, and every digit is
model-authored by construction. At RENDER time (after resolution) the
same guard runs against the RESOLVED facts, which is where a
correctly-attributed figure is allowed to survive. The two calls are the
same function; only the evidence differs. ``tests/engine/
test_artifact_spec.py`` proves the distinction on one identical string.

THE SCANNER CANNOT REPORT CLEAN WITHOUT HAVING WALKED
-----------------------------------------------------
TC-3 lives inside the product code here, not only in a gate: the scan
returns a :class:`ParseReport` census (nodes walked, strings scanned,
prose fields checked, ints seen), and a non-empty payload that produced
a zero walk is itself a refusal (:data:`CODE_SCANNER_DID_NOT_WALK`).
A census that finds nothing is a broken instrument, and this one says so
instead of printing a pass.

BUDGET
------
Composition spend is capped per role in ``src/engine/ai/models.yaml``.
:func:`budget_for_role` reads the RAW registry file rather than
:func:`engine.ai.registry.params_for`, because the registry MERGES
``defaults.breaker`` into every role — after that merge an inherited cap
is indistinguishable from a declared one. The law is "every role carries
EXPLICIT caps, no role may inherit defaults", so it must be checked
before the merge. A role that is absent, or that leans on the defaults
for either cap, REFUSES: composition is closed and the deterministic
fallback serves. Refusing is the safe direction — an uncapped role is an
uncapped bill.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import _ratio_units

#: Contract version of the spec payload. Consumers pin it; bump ONLY
#: with a note in the lane hand-off and a schema-snapshot test update.
ARTIFACT_SPEC_VERSION = "as1"

#: The AI role that composes artifact specs. Its caps live in
#: ``src/engine/ai/models.yaml`` and must be declared ON THE ROLE.
ROLE_ARTIFACT_COMPOSE = "artifact_compose"


# ══════════════════════════════════════════════════════════════════════
# THE VOCABULARY — closed sets, all of them
# ══════════════════════════════════════════════════════════════════════

KIND_LINE = "line"
KIND_BAR = "bar"
KIND_TABLE = "table"
KIND_KPI_GRID = "kpi_grid"
KIND_DELTA_TABLE = "delta_table"

#: Every artifact kind that exists. A kind outside this tuple is refused
#: — there is no "other", and no free-form renderer to fall through to.
ARTIFACT_KINDS = (KIND_LINE, KIND_BAR, KIND_TABLE, KIND_KPI_GRID,
                  KIND_DELTA_TABLE)

GROUP_BY_PERIOD = "period"
GROUP_BY_METRIC = "metric"
GROUP_BY = (GROUP_BY_PERIOD, GROUP_BY_METRIC)

SORT_SPEC = "spec"          # the order the spec listed them
SORT_LABEL = "label"        # alphabetical by label
SORTS = (SORT_SPEC, SORT_LABEL)

EMPHASIS_NONE = ""
EMPHASIS_PRIMARY = "primary"
EMPHASIS_MUTED = "muted"
EMPHASES = (EMPHASIS_NONE, EMPHASIS_PRIMARY, EMPHASIS_MUTED)

DERIVE_NONE = ""
#: b − a in integer minor units. Same unit, same currency, same scale,
#: or a typed refusal — never a coerced subtraction.
DERIVE_DELTA = "delta"
#: (b − a) / a as a dimensionless fraction, through the ratio law.
DERIVE_PCT_CHANGE = "pct_change"
#: metric / the spec's declared denominator metric, same period.
DERIVE_SHARE = "share"
DERIVATIONS = (DERIVE_NONE, DERIVE_DELTA, DERIVE_PCT_CHANGE, DERIVE_SHARE)


# ══════════════════════════════════════════════════════════════════════
# REFUSAL CODES
# ══════════════════════════════════════════════════════════════════════

CODE_NOT_AN_OBJECT = "not_an_object"
CODE_UNKNOWN_KEY = "unknown_key"
CODE_NUMERIC_SERIES = "numeric_series"
CODE_VALUE_FLOAT = "value_float"
CODE_VALUE_INT = "value_int"
CODE_VALUE_OUT_OF_RANGE = "value_out_of_range"
CODE_VALUE_AS_STRING = "value_as_string"
CODE_MODEL_AUTHORED_NUMERAL = "model_authored_numeral"
CODE_LOOSE_CURRENCY = "loose_currency_label"
CODE_BAD_ENUM = "bad_enum"
CODE_BAD_ID = "bad_id"
CODE_BAD_TYPE = "bad_type"
CODE_EMPTY = "empty_spec"
CODE_TOO_MANY = "too_many"
CODE_SCANNER_DID_NOT_WALK = "scanner_did_not_walk"
CODE_BUDGET_ROLE_ABSENT = "budget_role_absent"
CODE_BUDGET_INHERITS_DEFAULTS = "budget_inherits_defaults"
CODE_BUDGET_UNREADABLE = "budget_unreadable"


@dataclass(frozen=True)
class SpecRefusal(object):
    """A typed refusal. RETURNED, never raised — the surface renders it
    as the reason the artifact was not composed, and the deterministic
    fallback takes over. It never carries a substitute spec, because a
    silently-corrected spec is a spec nobody reviewed."""

    code: str
    path: str
    detail: str
    fix: str = ""
    excerpt: str = ""

    @property
    def refused(self) -> bool:
        return True

    def to_payload(self) -> Dict[str, Any]:
        return {
            "kind": "spec_refusal",
            "code": self.code,
            "path": self.path,
            "detail": self.detail,
            "fix": self.fix,
            "excerpt": self.excerpt,
        }


# ══════════════════════════════════════════════════════════════════════
# THE SPEC — references and presentation, and nothing that could hold a
# number
# ══════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class MetricRef(object):
    """ONE metric the artifact plots, BY ID.

    There is deliberately no ``value``, no ``data``, no ``points`` and no
    ``series`` field on this class. A model cannot supply a figure
    through it because there is nowhere to put one.
    """

    metric: str
    label: str = ""
    emphasis: str = EMPHASIS_NONE

    def to_payload(self) -> Dict[str, Any]:
        return {"metric": self.metric, "label": self.label,
                "emphasis": self.emphasis}


@dataclass(frozen=True)
class ArtifactSpec(object):
    """What the model returned, after it survived the parse.

    Every field is a reference (an id) or presentation (a label, an
    enum, a bounded integer). Nothing here can express a quantity.
    """

    kind: str
    metrics: Tuple[MetricRef, ...] = ()
    periods: Tuple[str, ...] = ()
    group_by: str = GROUP_BY_PERIOD
    sort: str = SORT_SPEC
    derive: str = DERIVE_NONE
    #: Denominator metric id for ``derive="share"``.
    denominator: str = ""
    title: str = ""
    subtitle: str = ""
    note: str = ""
    x_label: str = ""
    y_label: str = ""
    limit: int = 0
    decimals: int = 0

    def metric_ids(self) -> Tuple[str, ...]:
        return tuple(m.metric for m in self.metrics)

    def prose_fields(self) -> Tuple[Tuple[str, str], ...]:
        """Every model-authored string, with its path. The prose guard
        and its census both read THIS — one list, so a new prose field
        cannot be added without the guard seeing it."""
        out = [
            ("title", self.title),
            ("subtitle", self.subtitle),
            ("note", self.note),
            ("x_label", self.x_label),
            ("y_label", self.y_label),
        ]  # type: List[Tuple[str, str]]
        for i, m in enumerate(self.metrics):
            out.append(("metrics[%d].label" % i, m.label))
        return tuple(out)

    def to_payload(self) -> Dict[str, Any]:
        return {
            "version": ARTIFACT_SPEC_VERSION,
            "kind": self.kind,
            "metrics": [m.to_payload() for m in self.metrics],
            "periods": list(self.periods),
            "group_by": self.group_by,
            "sort": self.sort,
            "derive": self.derive,
            "denominator": self.denominator,
            "title": self.title,
            "subtitle": self.subtitle,
            "note": self.note,
            "x_label": self.x_label,
            "y_label": self.y_label,
            "limit": self.limit,
            "decimals": self.decimals,
        }


@dataclass(frozen=True)
class ParseReport(object):
    """The scan's own census.

    TC-3 in the product code: a scanner that walked nothing must not be
    able to report clean. Callers and gates read these counts and assert
    a floor PER COMPONENT (nodes, strings, prose fields) rather than one
    floor on a sum — a sum stays above its floor while one addend
    collapses, and that has happened here six times.
    """

    nodes_walked: int = 0
    strings_scanned: int = 0
    ints_seen: int = 0
    lists_walked: int = 0
    keys_seen: Tuple[str, ...] = ()
    prose_fields_checked: int = 0
    prose_chars_checked: int = 0

    def to_payload(self) -> Dict[str, Any]:
        return {
            "nodes_walked": self.nodes_walked,
            "strings_scanned": self.strings_scanned,
            "ints_seen": self.ints_seen,
            "lists_walked": self.lists_walked,
            "keys_seen": list(self.keys_seen),
            "prose_fields_checked": self.prose_fields_checked,
            "prose_chars_checked": self.prose_chars_checked,
        }


@dataclass(frozen=True)
class ParsedSpec(object):
    """The parse result. ``spec`` is None whenever ANY refusal fired —
    there is no partial acceptance, because a spec accepted with one
    refused field is a spec whose author was overruled without being
    told."""

    spec: Optional[ArtifactSpec] = None
    refusals: Tuple[SpecRefusal, ...] = ()
    report: ParseReport = field(default_factory=ParseReport)

    @property
    def ok(self) -> bool:
        return self.spec is not None and not self.refusals

    def codes(self) -> Tuple[str, ...]:
        return tuple(r.code for r in self.refusals)

    def to_payload(self) -> Dict[str, Any]:
        return {
            "version": ARTIFACT_SPEC_VERSION,
            "ok": self.ok,
            "spec": self.spec.to_payload() if self.spec is not None else None,
            "refusals": [r.to_payload() for r in self.refusals],
            "report": self.report.to_payload(),
        }


# ══════════════════════════════════════════════════════════════════════
# THE SCHEMA — what the model is shown, and what parse enforces
# ══════════════════════════════════════════════════════════════════════

#: The ONLY keys a spec object may carry, with their declared type.
#: ``parse`` reads this table; :func:`spec_tool_schema` renders it. One
#: table, so the schema the model is shown and the schema the parser
#: enforces cannot drift apart.
_TOP_KEYS = {
    "kind": "enum",
    "metrics": "metric_list",
    "periods": "id_list",
    "group_by": "enum",
    "sort": "enum",
    "derive": "enum",
    "denominator": "id",
    "title": "prose",
    "subtitle": "prose",
    "note": "prose",
    "x_label": "prose",
    "y_label": "prose",
    "limit": "int",
    "decimals": "int",
}  # type: Dict[str, str]

_METRIC_KEYS = {
    "metric": "id",
    "label": "prose",
    "emphasis": "enum",
}  # type: Dict[str, str]

_ENUMS = {
    "kind": ARTIFACT_KINDS,
    "group_by": GROUP_BY,
    "sort": SORTS,
    "derive": DERIVATIONS,
    "emphasis": EMPHASES,
}  # type: Dict[str, Tuple[str, ...]]

#: The two integer slots, with their bounds. Everything else numeric is
#: a value, and a value is not the model's to author.
_INT_SLOTS = {
    "limit": (0, 50),
    "decimals": (0, 4),
}  # type: Dict[str, Tuple[int, int]]

#: Slot families that hold an ID rather than prose. Digits are legal in
#: an id ("2024-12" is a period), because an id is checked by resolving
#: it, not by scanning it.
_ID_SLOTS = ("id", "id_list", "metric_list")

#: Slot families that must be a SCALAR string. A list in one of these is
#: a type error, and one worth naming: a `title: [...]` is how a payload
#: sneaks extra strings past a scalar reader.
_SCALAR_SLOTS = ("prose", "id", "enum", "int")

#: A metric id: the engine's own metric vocabulary shape.
_METRIC_ID_RX = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
#: A period id: opaque, but bounded and free of separators that would
#: let one id smuggle a list.
_PERIOD_ID_RX = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$")

_MAX_METRICS = 12
_MAX_PERIODS = 24
_MAX_PROSE = 240

#: A number written as a string. Accepts the separators a model reaches
#: for; ``"2024"`` is caught too, which is the point — an id slot has an
#: id rule, and a prose slot has the prose rule.
_NUMERIC_STRING_RX = re.compile(r"^\s*[-+]?[\d][\d,._ ]*\d*\s*[%×x]?\s*$")

#: Any digit run left after placeholders are lifted out.
_DIGIT_RX = re.compile(r"\d")

#: Currency codes/symbols/words a model might write into prose. A label
#: belongs to its fact, never to the sentence around it.
_CURRENCY_RX = re.compile(
    r"(?:(?<![A-Za-z])(?:RON|EUR|USD|GBP|CHF|HUF|PLN|BGN|CZK|MDL|TRY|"
    r"JPY|CNY|SEK|NOK|DKK|RSD)(?![A-Za-z]))|[€£¥$]"
    r"|(?<![A-Za-z])lei(?![A-Za-z])",
    re.IGNORECASE,
)

_PLACEHOLDER_RX = re.compile(
    r"\{\{money:(?P<name>[A-Za-z0-9_]+)(?P<opts>(?:\|[a-z0-9]+)*)\}\}"
)


def spec_tool_schema() -> Dict[str, Any]:
    """The JSON schema handed to the model as its tool definition.

    ``additionalProperties: false`` everywhere is load-bearing, not
    decoration: it is the same rule the parser enforces, stated where
    the model can read it, so a refusal is never a surprise. The schema
    itself carries no example values — an example figure in a schema is
    a figure the model has seen, and a model that has seen one will
    reuse it.
    """
    return {
        "name": "compose_artifact",
        "description": (
            "Compose a financial artifact by REFERENCE. Name the metric "
            "ids and period ids to plot and how to present them. You "
            "cannot supply figures: the engine resolves every id against "
            "the served statements and computes every number. Any digit "
            "in a label, title or note is rejected."
        ),
        "input_schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["kind", "metrics"],
            "properties": {
                "kind": {"type": "string", "enum": list(ARTIFACT_KINDS)},
                "metrics": {
                    "type": "array",
                    "maxItems": _MAX_METRICS,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["metric"],
                        "properties": {
                            "metric": {"type": "string",
                                       "pattern": _METRIC_ID_RX.pattern},
                            "label": {"type": "string",
                                      "maxLength": _MAX_PROSE},
                            "emphasis": {"type": "string",
                                         "enum": list(EMPHASES)},
                        },
                    },
                },
                "periods": {
                    "type": "array",
                    "maxItems": _MAX_PERIODS,
                    "items": {"type": "string",
                              "pattern": _PERIOD_ID_RX.pattern},
                },
                "group_by": {"type": "string", "enum": list(GROUP_BY)},
                "sort": {"type": "string", "enum": list(SORTS)},
                "derive": {"type": "string", "enum": list(DERIVATIONS)},
                "denominator": {"type": "string",
                                "pattern": _METRIC_ID_RX.pattern},
                "title": {"type": "string", "maxLength": _MAX_PROSE},
                "subtitle": {"type": "string", "maxLength": _MAX_PROSE},
                "note": {"type": "string", "maxLength": _MAX_PROSE},
                "x_label": {"type": "string", "maxLength": _MAX_PROSE},
                "y_label": {"type": "string", "maxLength": _MAX_PROSE},
                "limit": {"type": "integer", "minimum": _INT_SLOTS["limit"][0],
                          "maximum": _INT_SLOTS["limit"][1]},
                "decimals": {"type": "integer",
                             "minimum": _INT_SLOTS["decimals"][0],
                             "maximum": _INT_SLOTS["decimals"][1]},
            },
        },
    }


# ══════════════════════════════════════════════════════════════════════
# THE PROSE GUARD — templatize, then check (attribution, not a ban)
# ══════════════════════════════════════════════════════════════════════


def attributable(text: Any, facts: Optional[Dict[str, Any]] = None,
                 currency: str = "RON") -> str:
    """Lift every CORRECTLY-RENDERED engine figure back into its
    placeholder before the guard looks at the text.

    Delegates to the engine's own authority on which printed token
    belongs to which cited fact. With an empty fact map — the parse-time
    case — nothing can lift, which is exactly right: the model was never
    shown a value, so any digit it wrote is one it made up.

    Idempotent, so already-placeholdered text passes through unchanged.
    """
    raw = text if isinstance(text, str) else ""
    if not raw:
        return ""
    try:
        return _ratio_units.templatize(raw, dict(facts or {}),
                                       (currency or "RON").upper())
    except Exception:  # noqa: BLE001 — untemplatizable text is judged raw
        return raw


def prose_violations(text: Any, path: str = "",
                     facts: Optional[Dict[str, Any]] = None,
                     currency: str = "RON") -> Tuple[SpecRefusal, ...]:
    """Refusals for one model-authored string.

    Runs :func:`attributable` first, so a figure the engine computed is
    invisible here and a figure it did not is a numeral. Deduplicated:
    one repeated digit run is one defect, not five.
    """
    lifted = attributable(text, facts, currency)
    if not lifted:
        return ()
    stripped = _PLACEHOLDER_RX.sub(" ", lifted)
    out = []  # type: List[SpecRefusal]
    seen = set()  # type: set

    for m in re.finditer(r"[\d][\d.,' ]*[\d]|\d", stripped):
        token = m.group(0).strip()
        if not token or token in seen:
            continue
        seen.add(token)
        out.append(SpecRefusal(
            code=CODE_MODEL_AUTHORED_NUMERAL, path=path,
            detail=("the numeral %r in this label is a figure the engine "
                    "never computed" % token),
            fix=("Name the metric and let the engine resolve it, or cite "
                 "it as {{money:<fact>}}."),
            excerpt=token))

    for m in _CURRENCY_RX.finditer(stripped):
        token = m.group(0)
        key = "cur:" + token.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(SpecRefusal(
            code=CODE_LOOSE_CURRENCY, path=path,
            detail=("the currency label %r belongs to its fact, not to the "
                    "prose around it" % token),
            fix="Drop the currency word; the resolved figure carries its own.",
            excerpt=token))
    return tuple(out)


def assert_prose_attributable(text: Any, facts: Dict[str, Any],
                              currency: str, path: str = "") -> None:
    """The RENDER-time twin of the parse-time check, for engine-authored
    output. Raises, because at this point a violation is an engine bug,
    not a model one — and an engine bug must not ship quietly."""
    violations = prose_violations(text, path, facts, currency)
    if violations:
        raise ValueError(
            "artifact prose at %s carries a numeral no fact backs: %s"
            % (path or "?", "; ".join(v.excerpt for v in violations)))


# ══════════════════════════════════════════════════════════════════════
# THE VALUE SCAN — before any schema binding
# ══════════════════════════════════════════════════════════════════════


class _Scan(object):
    """Mutable accumulator for one walk. Deliberately a plain object:
    the census counters must be incremented at every visit, and a frozen
    dataclass would push that bookkeeping into the caller where it could
    be forgotten."""

    def __init__(self) -> None:
        self.refusals = []  # type: List[SpecRefusal]
        self.nodes = 0
        self.strings = 0
        self.ints = 0
        self.lists = 0
        self.keys = []  # type: List[str]
        self.prose_fields = 0
        self.prose_chars = 0

    def refuse(self, code: str, path: str, detail: str, fix: str = "",
               excerpt: str = "") -> None:
        self.refusals.append(SpecRefusal(code=code, path=path, detail=detail,
                                         fix=fix, excerpt=excerpt))


def _slot_kind(path_key: str, in_metric: bool) -> Optional[str]:
    """The slot family for a key, in the table that governs it.

    Falls back to the top-level table when a key is not a metric key —
    ``metrics`` itself is scanned with ``in_metric`` already true (the
    flag is set when the walk ENTERS the list), so without the fallback
    the list's own shorthand id strings would be judged as if they had
    no declared family.
    """
    if in_metric:
        found = _METRIC_KEYS.get(path_key)
        if found is not None:
            return found
    return _TOP_KEYS.get(path_key)


def _scan_value(scan: "_Scan", node: Any, path: str, key: str,
                in_metric: bool) -> None:
    """Walk one node. Every visit counts, whether or not it refuses —
    a scanner that only counts its findings cannot tell 'clean' from
    'never looked'."""
    scan.nodes += 1

    if node is None:
        return

    if isinstance(node, bool):
        # A bool is not a value the way a number is, but no slot in this
        # schema takes one, so it is a type error rather than a leak.
        scan.refuse(CODE_BAD_TYPE, path,
                    "boolean is not a type any spec field carries",
                    "Remove this field.", repr(node))
        return

    if isinstance(node, float):
        scan.refuse(CODE_VALUE_FLOAT, path,
                    "a fractional number in a spec is a VALUE; the engine "
                    "computes values, the spec references them",
                    "Name the metric id instead of its figure.", repr(node))
        return

    if isinstance(node, int):
        scan.ints += 1
        bounds = _INT_SLOTS.get(key) if not in_metric else None
        if bounds is None:
            scan.refuse(CODE_VALUE_INT, path,
                        "an integer here is a VALUE; only %s carry numbers, "
                        "and they carry presentation counts"
                        % ", ".join(sorted(_INT_SLOTS)),
                        "Name the metric id instead of its figure.",
                        repr(node))
            return
        low, high = bounds
        if node < low or node > high:
            scan.refuse(CODE_VALUE_OUT_OF_RANGE, path,
                        "%s must be between %d and %d (got %d)"
                        % (key, low, high, node),
                        "Use a presentation count inside the range.",
                        repr(node))
        return

    if isinstance(node, str):
        scan.strings += 1
        slot = _slot_kind(key, in_metric)
        if slot == "prose":
            scan.prose_fields += 1
            scan.prose_chars += len(node)
            for refusal in prose_violations(node, path):
                scan.refusals.append(refusal)
            return
        if slot in _ID_SLOTS:
            # An id slot is verified by EXISTENCE, not by digits: a period
            # id is legitimately "2024-12", and an unknown metric id
            # resolves to an honest gap card rather than to a figure. The
            # id regexes below are what govern here.
            return
        if _NUMERIC_STRING_RX.match(node) and _DIGIT_RX.search(node):
            scan.refuse(CODE_VALUE_AS_STRING, path,
                        "the string %r is a number wearing a string's "
                        "clothes" % node[:60],
                        "Name the metric id instead of its figure.",
                        node[:60])
        return

    if isinstance(node, (list, tuple)):
        scan.lists += 1
        numeric = [i for i, item in enumerate(node)
                   if isinstance(item, (int, float))
                   and not isinstance(item, bool)]
        if numeric:
            scan.refuse(
                CODE_NUMERIC_SERIES, path,
                "this list carries %d number(s) — a spec names what to "
                "plot, it never carries the data" % len(numeric),
                "Name the metric ids; the engine resolves the series.",
                repr([node[i] for i in numeric[:4]]))
            # Keep walking: a mixed list may hide a second defect, and a
            # scan that stops at the first finding under-reports.
        for i, item in enumerate(node):
            _scan_value(scan, item, "%s[%d]" % (path, i), key, in_metric)
        return

    if isinstance(node, dict):
        table = _METRIC_KEYS if in_metric else _TOP_KEYS
        for k in sorted(node.keys()):
            k_str = str(k)
            scan.keys.append(k_str)
            child_path = "%s.%s" % (path, k_str) if path else k_str
            if k_str not in table:
                scan.refuse(
                    CODE_UNKNOWN_KEY, child_path,
                    "%r is not a field of the artifact spec; the known "
                    "fields are %s" % (k_str, ", ".join(sorted(table))),
                    "Remove it. There is no field that carries data.",
                    k_str)
                # Still walk it — an unknown key holding a series should
                # report BOTH, so the failure names what it actually did.
            slot = table.get(k_str)
            if slot in _SCALAR_SLOTS and isinstance(node[k], (list, tuple, dict)):
                scan.refuse(
                    CODE_BAD_TYPE, child_path,
                    "%r takes a single value, not a %s"
                    % (k_str, type(node[k]).__name__),
                    "Give it one string.", type(node[k]).__name__)
            child_in_metric = in_metric or (k_str == "metrics")
            _scan_value(scan, node[k], child_path, k_str, child_in_metric)
        return

    scan.refuse(CODE_BAD_TYPE, path,
                "%s is not a type any spec field carries"
                % type(node).__name__,
                "Remove this field.", repr(node)[:60])


# ══════════════════════════════════════════════════════════════════════
# PARSE
# ══════════════════════════════════════════════════════════════════════


def _enum_or_refuse(scan: "_Scan", node: Dict[str, Any], key: str,
                    default: str, path: str) -> str:
    if key not in node:
        # An ABSENT enum is not a bad enum. Reporting both would give the
        # retry two things to fix where there is one, and a critique that
        # names a defect the model did not commit teaches it a wrong
        # lesson.
        return default
    raw = node.get(key, default)
    if raw is None:
        raw = default
    if not isinstance(raw, str):
        return default
    allowed = _ENUMS[key]
    if raw not in allowed:
        scan.refuse(CODE_BAD_ENUM, path,
                    "%s must be one of %s (got %r)"
                    % (key, ", ".join(repr(a) for a in allowed if a), raw),
                    "Pick one of the listed values.", raw)
        return default
    return raw


def _id_or_refuse(scan: "_Scan", raw: Any, rx: "re.Pattern", path: str,
                  what: str) -> str:
    if raw is None:
        return ""
    if not isinstance(raw, str):
        scan.refuse(CODE_BAD_TYPE, path,
                    "%s must be a string (got %s)" % (what, type(raw).__name__),
                    "Name the id as a string.", repr(raw)[:60])
        return ""
    text = raw.strip()
    if not text:
        return ""
    if not rx.match(text):
        scan.refuse(CODE_BAD_ID, path,
                    "%r is not a well-formed %s" % (text[:60], what),
                    "Use an id from the fact index summary.", text[:60])
        return ""
    return text


def _prose_or_empty(node: Dict[str, Any], key: str) -> str:
    raw = node.get(key, "")
    if not isinstance(raw, str):
        return ""
    return raw.strip()[:_MAX_PROSE]


def parse_artifact_spec(payload: Any) -> ParsedSpec:
    """Parse a model-returned artifact spec, or refuse it.

    Order matters. The VALUE SCAN runs FIRST, over the raw payload,
    before any field is bound — so a payload carrying a data series is
    refused for carrying a data series, named as such, rather than for
    some downstream type error it also happens to cause. A red for the
    wrong reason is not evidence (TC-2).

    Returns a :class:`ParsedSpec` in every state; never raises.
    """
    scan = _Scan()

    if not isinstance(payload, dict):
        scan.refuse(CODE_NOT_AN_OBJECT, "$",
                    "an artifact spec is a JSON object (got %s)"
                    % type(payload).__name__,
                    "Return the compose_artifact tool input object.")
        return ParsedSpec(None, tuple(scan.refusals), _report(scan))

    _scan_value(scan, payload, "", "", False)

    # TC-3, in the product code: a non-empty payload that produced a zero
    # walk means the scanner is broken, and a broken scanner must be loud
    # rather than serene.
    if payload and scan.nodes <= 1:
        scan.refuse(CODE_SCANNER_DID_NOT_WALK, "$",
                    "the value scan visited %d node(s) on a payload with %d "
                    "key(s) — the scanner did not walk, so 'clean' here "
                    "would mean 'never looked'"
                    % (scan.nodes, len(payload)),
                    "This is an engine defect, not a model one.")

    kind = _enum_or_refuse(scan, payload, "kind", "", "kind")
    if not kind:
        scan.refuse(CODE_EMPTY, "kind",
                    "the spec names no artifact kind",
                    "Pick one of %s." % ", ".join(ARTIFACT_KINDS))

    metrics = []  # type: List[MetricRef]
    raw_metrics = payload.get("metrics")
    if raw_metrics is None:
        raw_metrics = []
    if not isinstance(raw_metrics, (list, tuple)):
        scan.refuse(CODE_BAD_TYPE, "metrics",
                    "metrics must be a list of metric references (got %s)"
                    % type(raw_metrics).__name__,
                    "Return a list of {metric, label} objects.")
        raw_metrics = []
    if len(raw_metrics) > _MAX_METRICS:
        scan.refuse(CODE_TOO_MANY, "metrics",
                    "%d metrics exceeds the %d an artifact may carry"
                    % (len(raw_metrics), _MAX_METRICS),
                    "Split it into two artifacts.")
    for i, raw in enumerate(raw_metrics[:_MAX_METRICS]):
        path = "metrics[%d]" % i
        if isinstance(raw, str):
            # A bare id is a legitimate shorthand; it carries no label,
            # so there is nothing to attribute.
            metric_id = _id_or_refuse(scan, raw, _METRIC_ID_RX,
                                      path, "metric id")
            if metric_id:
                metrics.append(MetricRef(metric=metric_id))
            continue
        if not isinstance(raw, dict):
            scan.refuse(CODE_BAD_TYPE, path,
                        "a metric reference is an object or an id string "
                        "(got %s)" % type(raw).__name__,
                        "Return {\"metric\": \"<id>\"}.")
            continue
        metric_id = _id_or_refuse(scan, raw.get("metric"), _METRIC_ID_RX,
                                  path + ".metric", "metric id")
        if not metric_id:
            continue
        emphasis = raw.get("emphasis", EMPHASIS_NONE)
        if not isinstance(emphasis, str) or emphasis not in EMPHASES:
            if emphasis not in (None, ""):
                scan.refuse(CODE_BAD_ENUM, path + ".emphasis",
                            "emphasis must be one of %s (got %r)"
                            % (", ".join(repr(e) for e in EMPHASES if e),
                               emphasis),
                            "Pick one of the listed values.", str(emphasis))
            emphasis = EMPHASIS_NONE
        label = raw.get("label", "")
        metrics.append(MetricRef(
            metric=metric_id,
            label=label.strip()[:_MAX_PROSE] if isinstance(label, str) else "",
            emphasis=emphasis))

    if not metrics:
        scan.refuse(CODE_EMPTY, "metrics",
                    "the spec names no metric to plot",
                    "Name at least one metric id from the fact index.")

    periods = []  # type: List[str]
    raw_periods = payload.get("periods")
    if raw_periods is None:
        raw_periods = []
    if isinstance(raw_periods, str):
        raw_periods = [raw_periods]
    if not isinstance(raw_periods, (list, tuple)):
        scan.refuse(CODE_BAD_TYPE, "periods",
                    "periods must be a list of period ids (got %s)"
                    % type(raw_periods).__name__,
                    "Return a list of id strings.")
        raw_periods = []
    if len(raw_periods) > _MAX_PERIODS:
        scan.refuse(CODE_TOO_MANY, "periods",
                    "%d periods exceeds the %d an artifact may carry"
                    % (len(raw_periods), _MAX_PERIODS),
                    "Narrow the range.")
    for i, raw in enumerate(raw_periods[:_MAX_PERIODS]):
        pid = _id_or_refuse(scan, raw, _PERIOD_ID_RX,
                            "periods[%d]" % i, "period id")
        if pid and pid not in periods:
            periods.append(pid)

    group_by = _enum_or_refuse(scan, payload, "group_by", GROUP_BY_PERIOD,
                               "group_by")
    sort = _enum_or_refuse(scan, payload, "sort", SORT_SPEC, "sort")
    derive = _enum_or_refuse(scan, payload, "derive", DERIVE_NONE, "derive")
    denominator = _id_or_refuse(scan, payload.get("denominator"),
                                _METRIC_ID_RX, "denominator", "metric id")
    if derive == DERIVE_SHARE and not denominator:
        scan.refuse(CODE_EMPTY, "denominator",
                    "derive='share' needs a denominator metric id",
                    "Name the metric the share is taken of.")

    limit = payload.get("limit", 0)
    decimals = payload.get("decimals", 0)
    limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else 0
    decimals = (decimals if isinstance(decimals, int)
                and not isinstance(decimals, bool) else 0)
    low, high = _INT_SLOTS["limit"]
    if limit < low or limit > high:
        limit = 0
    low, high = _INT_SLOTS["decimals"]
    if decimals < low or decimals > high:
        decimals = 0

    spec = ArtifactSpec(
        kind=kind or KIND_TABLE,
        metrics=tuple(metrics),
        periods=tuple(periods),
        group_by=group_by,
        sort=sort,
        derive=derive,
        denominator=denominator,
        title=_prose_or_empty(payload, "title"),
        subtitle=_prose_or_empty(payload, "subtitle"),
        note=_prose_or_empty(payload, "note"),
        x_label=_prose_or_empty(payload, "x_label"),
        y_label=_prose_or_empty(payload, "y_label"),
        limit=limit,
        decimals=decimals,
    )

    report = _report(scan)
    if scan.refusals:
        return ParsedSpec(None, tuple(scan.refusals), report)
    return ParsedSpec(spec, (), report)


def _report(scan: "_Scan") -> ParseReport:
    return ParseReport(
        nodes_walked=scan.nodes,
        strings_scanned=scan.strings,
        ints_seen=scan.ints,
        lists_walked=scan.lists,
        keys_seen=tuple(scan.keys),
        prose_fields_checked=scan.prose_fields,
        prose_chars_checked=scan.prose_chars,
    )


# ══════════════════════════════════════════════════════════════════════
# COMPOSITION — refuse, regenerate ONCE, then the deterministic fallback
# ══════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class Composition(object):
    """The outcome of asking the model for a spec.

    ``source`` is one of ``model`` / ``model_retry`` / ``fallback`` /
    ``closed``. It is recorded rather than inferred, because "did the
    model author this?" is the question every audit of this surface
    starts with.
    """

    spec: Optional[ArtifactSpec]
    source: str
    attempts: int = 0
    refusals: Tuple[SpecRefusal, ...] = ()
    critique: str = ""
    degraded: Optional[Dict[str, Any]] = None
    reports: Tuple[ParseReport, ...] = ()

    @property
    def ok(self) -> bool:
        return self.spec is not None

    def to_payload(self) -> Dict[str, Any]:
        return {
            "version": ARTIFACT_SPEC_VERSION,
            "ok": self.ok,
            "source": self.source,
            "attempts": self.attempts,
            "spec": self.spec.to_payload() if self.spec is not None else None,
            "refusals": [r.to_payload() for r in self.refusals],
            "critique": self.critique,
            "degraded": copy.deepcopy(self.degraded) if self.degraded else None,
            "reports": [r.to_payload() for r in self.reports],
        }


def critique_for(refusals: Sequence[SpecRefusal]) -> str:
    """The one regeneration hint. Names EXACTLY what was refused and
    where — a critique that says "try again" teaches nothing and costs a
    second call for the same defect."""
    if not refusals:
        return ""
    lines = []  # type: List[str]
    for r in refusals[:8]:
        where = r.path or "$"
        lines.append("- %s at %s: %s" % (r.code, where, r.detail))
    return ("Your spec was refused. Fix exactly this and answer again:\n"
            + "\n".join(lines)
            + "\nYou may not write any figure. Name metric ids and period "
              "ids; the engine resolves them.")


def compose_spec(request, fallback: Optional[ArtifactSpec] = None,
                 budget: Optional["ArtifactBudget"] = None) -> Composition:
    """Ask for a spec; refuse, regenerate ONCE, then fall back.

    ``request`` is called as ``request(critique)`` — ``None`` on the
    first attempt, the critique string on the retry. It returns whatever
    the model produced (a dict, or anything at all); this function never
    trusts its shape.

    THE BUDGET IS CHECKED BEFORE THE FIRST CALL, not after. A closed
    budget means ZERO model calls — the fallback serves and the
    degradation is stated. Checking after the call would have already
    spent the money the cap exists to protect.
    """
    if budget is not None and not budget.available:
        return Composition(spec=fallback, source="closed", attempts=0,
                           refusals=budget.refusals,
                           degraded=budget.degraded_marker())

    reports = []  # type: List[ParseReport]
    critique = None  # type: Optional[str]
    last = ()  # type: Tuple[SpecRefusal, ...]
    for attempt in (1, 2):
        try:
            payload = request(critique)
        except Exception as exc:  # noqa: BLE001 — a model error is a degrade
            return Composition(
                spec=fallback, source="fallback", attempts=attempt,
                refusals=(SpecRefusal(
                    code=CODE_BUDGET_UNREADABLE, path="$",
                    detail="the composer raised %s" % type(exc).__name__,
                    fix="The deterministic artifact is served instead."),),
                degraded={"marker": "artifact_composer_unavailable",
                          "available": False,
                          "reason": type(exc).__name__})
        parsed = parse_artifact_spec(payload)
        reports.append(parsed.report)
        if parsed.ok:
            return Composition(spec=parsed.spec,
                               source="model" if attempt == 1 else "model_retry",
                               attempts=attempt, reports=tuple(reports))
        last = parsed.refusals
        critique = critique_for(parsed.refusals)

    return Composition(spec=fallback, source="fallback", attempts=2,
                       refusals=last, critique=critique or "",
                       reports=tuple(reports))


# ══════════════════════════════════════════════════════════════════════
# BUDGET — explicit caps per role, checked BEFORE the merge
# ══════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class ArtifactBudget(object):
    """The composer's spend envelope, or the reason there is none."""

    role: str
    available: bool
    model_id: str = ""
    prompt_version: str = ""
    max_tokens: int = 0
    max_calls_per_day: int = 0
    max_tokens_per_day: int = 0
    refusals: Tuple[SpecRefusal, ...] = ()

    def degraded_marker(self) -> Dict[str, Any]:
        reason = (self.refusals[0].detail if self.refusals
                  else "no budget declared")
        return {
            "marker": "ai_advisory_unavailable",
            "available": False,
            "role": self.role,
            "reason": reason,
        }

    def to_payload(self) -> Dict[str, Any]:
        return {
            "role": self.role,
            "available": self.available,
            "model_id": self.model_id,
            "prompt_version": self.prompt_version,
            "max_tokens": self.max_tokens,
            "max_calls_per_day": self.max_calls_per_day,
            "max_tokens_per_day": self.max_tokens_per_day,
            "refusals": [r.to_payload() for r in self.refusals],
        }


def _raw_registry(path: Optional[Any] = None) -> Dict[str, Any]:
    """The registry file BEFORE defaults are merged.

    ``engine.ai.registry.params_for`` merges ``defaults.breaker`` into
    every role, so after it an inherited cap and a declared one are the
    same bytes. The law is about the DECLARATION, so it is checked on
    the file.
    """
    import os
    from pathlib import Path

    import yaml

    from ..ai import registry as _registry

    if path is not None:
        resolved = Path(path)
    else:
        env = os.environ.get(_registry.PATH_ENV)
        resolved = Path(env) if env else _registry.default_path()
    raw = yaml.safe_load(resolved.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("models.yaml top level is not a mapping")
    return raw


def roles_inheriting_defaults(path: Optional[Any] = None) -> Dict[str, Tuple[str, ...]]:
    """AUDIT — ``{role: (inherited keys, …)}`` for every role that leans
    on ``defaults`` for a cap.

    A census, so it names what it found rather than asserting a clean
    result: an empty mapping from a registry with roles means every role
    declares its own caps; an empty mapping from a registry with NO roles
    means the census is broken, and the caller can tell the two apart
    because :func:`declared_roles` reports the denominator.
    """
    raw = _raw_registry(path)
    roles = raw.get("roles") or {}
    out = {}  # type: Dict[str, Tuple[str, ...]]
    if not isinstance(roles, dict):
        return out
    for role, params in roles.items():
        if not isinstance(params, dict):
            continue
        inherited = []  # type: List[str]
        breaker = params.get("breaker")
        if not isinstance(breaker, dict):
            breaker = {}
        for cap in ("max_calls_per_day", "max_tokens_per_day"):
            if cap not in breaker:
                inherited.append("breaker." + cap)
        if "max_tokens" not in params:
            inherited.append("max_tokens")
        if "temperature" not in params:
            inherited.append("temperature")
        if inherited:
            out[str(role)] = tuple(inherited)
    return out


def declared_roles(path: Optional[Any] = None) -> Tuple[str, ...]:
    """Every role name in the registry file, in file order. The
    denominator for :func:`roles_inheriting_defaults` — without it, an
    empty audit result is indistinguishable from an empty registry
    (TC-9)."""
    raw = _raw_registry(path)
    roles = raw.get("roles") or {}
    if not isinstance(roles, dict):
        return ()
    return tuple(str(r) for r in roles)


def budget_for_role(role: str = ROLE_ARTIFACT_COMPOSE,
                    path: Optional[Any] = None) -> ArtifactBudget:
    """The composer's budget, or a REFUSAL that closes composition.

    Three ways to be closed, all of them safe directions:
      · the registry is unreadable — no model call is worth guessing a
        cap for;
      · the role is absent — an undeclared role has no cap, and an
        uncapped role is an uncapped bill;
      · either cap is inherited from ``defaults`` — the law is EXPLICIT
        caps per role, and an inherited cap is one nobody sized for this
        workload.
    """
    try:
        raw = _raw_registry(path)
    except Exception as exc:  # noqa: BLE001 — unreadable closes the role
        return ArtifactBudget(
            role=role, available=False,
            refusals=(SpecRefusal(
                code=CODE_BUDGET_UNREADABLE, path="models.yaml",
                detail="the model registry is unreadable (%s)"
                       % type(exc).__name__,
                fix="Fix src/engine/ai/models.yaml."),))

    roles = raw.get("roles") or {}
    params = roles.get(role) if isinstance(roles, dict) else None
    if not isinstance(params, dict):
        return ArtifactBudget(
            role=role, available=False,
            refusals=(SpecRefusal(
                code=CODE_BUDGET_ROLE_ABSENT, path="models.yaml:roles",
                detail=("role %r is not declared in the model registry, so "
                        "artifact composition has no cap and is closed"
                        % role),
                fix=("Declare the role in src/engine/ai/models.yaml with "
                     "its own model_id, prompt_version, max_tokens, "
                     "temperature: 0 and an explicit breaker block."),),))

    inherited = roles_inheriting_defaults(path).get(role, ())
    if inherited:
        return ArtifactBudget(
            role=role, available=False,
            refusals=(SpecRefusal(
                code=CODE_BUDGET_INHERITS_DEFAULTS,
                path="models.yaml:roles.%s" % role,
                detail=("role %r inherits %s from defaults; every role must "
                        "carry EXPLICIT caps" % (role, ", ".join(inherited))),
                fix="Declare %s on the role itself." % ", ".join(inherited)),))

    breaker = params.get("breaker") or {}
    return ArtifactBudget(
        role=role,
        available=True,
        model_id=str(params.get("model_id") or ""),
        prompt_version=str(params.get("prompt_version") or ""),
        max_tokens=int(params.get("max_tokens") or 0),
        max_calls_per_day=int(breaker.get("max_calls_per_day") or 0),
        max_tokens_per_day=int(breaker.get("max_tokens_per_day") or 0),
    )


# ══════════════════════════════════════════════════════════════════════
# PER-ARTIFACT COST
# ══════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class ArtifactCost(object):
    """What ONE artifact cost. Per-artifact, not per-session: a session
    total cannot tell an expensive artifact from ten cheap ones, and the
    cap that matters is the one on the thing a user just asked for."""

    artifact_id: str
    role: str
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0

    @property
    def tokens(self) -> int:
        return int(self.input_tokens) + int(self.output_tokens)

    def to_payload(self) -> Dict[str, Any]:
        return {
            "artifact_id": self.artifact_id,
            "role": self.role,
            "calls": self.calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "tokens": self.tokens,
        }


class SpendLedger(object):
    """In-process per-artifact cost record.

    Deliberately NOT a second spend authority: the daily caps live in
    :mod:`engine.ai.breaker`, which owns the file counter. This records
    what one artifact cost so the surface can show it and a test can
    assert it, and it defers every trip decision to the breaker.
    """

    def __init__(self, role: str = ROLE_ARTIFACT_COMPOSE) -> None:
        self.role = role
        self._by_artifact = {}  # type: Dict[str, ArtifactCost]

    def record(self, artifact_id: str, *, calls: int = 1,
               input_tokens: int = 0, output_tokens: int = 0) -> ArtifactCost:
        prior = self._by_artifact.get(artifact_id)
        cost = ArtifactCost(
            artifact_id=artifact_id, role=self.role,
            calls=(prior.calls if prior else 0) + int(calls),
            input_tokens=(prior.input_tokens if prior else 0) + int(input_tokens),
            output_tokens=(prior.output_tokens if prior else 0) + int(output_tokens),
        )
        self._by_artifact[artifact_id] = cost
        return cost

    def cost_for(self, artifact_id: str) -> ArtifactCost:
        return self._by_artifact.get(
            artifact_id, ArtifactCost(artifact_id=artifact_id, role=self.role))

    def artifacts(self) -> Tuple[str, ...]:
        return tuple(sorted(self._by_artifact))

    def over_cap(self, artifact_id: str, budget: ArtifactBudget) -> bool:
        """Has this ONE artifact already spent more than a single day's
        token cap? A per-artifact runaway is the shape a caller can act
        on; the daily ceiling is the breaker's job."""
        if not budget.available or budget.max_tokens_per_day <= 0:
            return True
        return self.cost_for(artifact_id).tokens > budget.max_tokens_per_day

    def to_payload(self) -> Dict[str, Any]:
        return {
            "role": self.role,
            "artifacts": [self._by_artifact[a].to_payload()
                          for a in sorted(self._by_artifact)],
        }
