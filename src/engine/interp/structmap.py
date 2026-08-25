"""StructuralMap — the typed structural description of a tabular
financial document (map version "smap1").

Frozen dataclasses + strict JSON (de)serialization. The deserializer is
the E1 gate: a structural map may carry COORDINATES, INDICES, ENUMS and
SHORT STRINGS only — never a cell VALUE. Numeric values are accepted at
an explicit whitelist of paths (row/column indexes, scale, analytic
digit count) and rejected everywhere else, including unknown keys at any
nesting level and floats anywhere (every legal numeric is an int).

Column-semantic vocabulary (jurisdiction-blind by construction — the
names describe accounting semantics, not any country's header labels):

  account_code / account_name        — identity columns
  opening_debit / opening_credit     — balances at period start
  movement_period_debit / _credit    — movements of the single current
                                       period (e.g. the month)
  movement_cumulative_debit/_credit  — cumulative movements since the
                                       start of the year, EXCLUDING
                                       opening balances (movements-only)
  total_with_opening_debit /_credit  — opening balances PLUS cumulative
                                       movements (a "total sums" pair)
  closing_debit / closing_credit     — balances at period end
  marker                             — per-row categorical marker (e.g.
                                       balance-sheet vs profit-and-loss)
  hint_classification                — source-system classification hint
                                       (statutory account type,
                                       reporting-item label, ...)
  ignore                             — no extraction relevance

The two cumulative semantics are DISTINCT on purpose: conflating a
movements-only cumulative pair with an opening-inclusive total pair is a
live semantic error in pattern-based header matching, and the map is the
fix.

`map_hash` is the sha256 of the canonical JSON minus volatile fields
(i.e. minus `map_hash` itself) — stable across (de)serialization.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Dict, FrozenSet, List, Optional, Tuple

#: Schema tag for this map shape. Bump on any shape change.
MAP_VERSION = "smap1"

#: The closed per-column semantic vocabulary.
COLUMN_SEMANTICS: Tuple[str, ...] = (
    "account_code",
    "account_name",
    "opening_debit",
    "opening_credit",
    "movement_period_debit",
    "movement_period_credit",
    "movement_cumulative_debit",
    "movement_cumulative_credit",
    "total_with_opening_debit",
    "total_with_opening_credit",
    "closing_debit",
    "closing_credit",
    "marker",
    "hint_classification",
    "ignore",
)

_SEMANTICS_SET = frozenset(COLUMN_SEMANTICS)

#: E1 numeric whitelist — the ONLY paths where a numeric value is legal.
#: List positions are normalized to "*". Everything numeric anywhere
#: else in the payload is rejected as a potential cell value.
NUMERIC_WHITELIST: FrozenSet[Tuple[str, ...]] = frozenset({
    ("header_row_index",),
    ("account_code_col",),
    ("scale",),
    ("totals_row_indexes", "*"),
    ("subtotal_row_indexes", "*"),
    ("repeated_header_rows", "*"),
    ("columns", "*", "index"),
    ("analytic_structure", "synthetic_digits"),
})

_TOP_LEVEL_KEYS = frozenset({
    "map_version", "sheet", "header_row_index", "columns",
    "totals_row_indexes", "subtotal_row_indexes", "repeated_header_rows",
    "account_code_col", "analytic_structure", "number_locale",
    "currency", "scale", "anomaly_notes", "map_hash",
})

_COLUMN_KEYS = frozenset({"index", "semantic"})
_ANALYTIC_KEYS = frozenset({"separator", "synthetic_digits"})
_LOCALE_KEYS = frozenset({"thousands_sep", "decimal_sep"})


class StructMapError(ValueError):
    """A structural map payload failed strict validation.

    Loud by design: a map carrying a cell value, an unknown key, a float
    or an out-of-vocabulary semantic must never be silently accepted —
    the whole point of the map is that a MECHANICAL reader can trust it.
    """


def _fail(message: str) -> None:
    raise StructMapError("structural map invalid: %s" % message)


def _path_str(path: Tuple[Any, ...]) -> str:
    return "/".join(str(p) for p in path) or "<root>"


def _sweep_numerics(node: Any, path: Tuple[str, ...] = ()) -> None:
    """Defense-in-depth E1 sweep: reject any numeric value at any level
    outside :data:`NUMERIC_WHITELIST`, and reject floats everywhere
    (every legal numeric field is an int)."""
    if isinstance(node, bool):
        _fail("boolean value at %s — the smap1 schema has no boolean fields"
              % _path_str(path))
    if isinstance(node, float):
        _fail("float value at %s — structural maps never carry floats "
              "(cell values are forbidden; indices are ints)" % _path_str(path))
    if isinstance(node, int):
        if path not in NUMERIC_WHITELIST:
            _fail("numeric value at %s — structural maps carry coordinates, "
                  "indices and enums, never cell values" % _path_str(path))
        return
    if isinstance(node, dict):
        for k, v in node.items():
            if not isinstance(k, str):
                _fail("non-string key %r at %s" % (k, _path_str(path)))
            _sweep_numerics(v, path + (k,))
        return
    if isinstance(node, (list, tuple)):
        for v in node:
            _sweep_numerics(v, path + ("*",))
        return
    # str / None: fine.


def _expect_index(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        _fail("'%s' must be a non-negative integer index (got %r)" % (name, value))
    return value


def _expect_opt_str(value: Any, name: str) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        _fail("'%s' must be a string or null (got %r)" % (name, value))
    return value


def _expect_index_list(value: Any, name: str) -> Tuple[int, ...]:
    if not isinstance(value, (list, tuple)):
        _fail("'%s' must be a list of row indexes (got %r)" % (name, value))
    return tuple(_expect_index(v, "%s[]" % name) for v in value)


def _reject_unknown(raw: Dict[str, Any], allowed: FrozenSet[str], where: str) -> None:
    unknown = sorted(set(raw) - allowed)
    if unknown:
        _fail("unknown key(s) %s in %s — the smap1 schema is closed"
              % (", ".join(repr(k) for k in unknown), where))


@dataclass(frozen=True)
class ColumnSpec:
    """One column: its 0-based index and its semantic."""

    index: int
    semantic: str


@dataclass(frozen=True)
class AnalyticStructure:
    """How analytic (sub-)account codes are shaped in this document.

    separator        — the character joining synthetic and analytic parts
                       (e.g. "."), or None when analytics are POSITIONAL
                       (digits appended with no separator).
    synthetic_digits — for positional analytics: how many leading digits
                       form the synthetic account; None when unknown or
                       when a separator makes the split explicit.
    """

    separator: Optional[str] = None
    synthetic_digits: Optional[int] = None


@dataclass(frozen=True)
class NumberLocale:
    """The document-wide number formatting (one decision per document)."""

    thousands_sep: Optional[str] = None
    decimal_sep: Optional[str] = None


@dataclass(frozen=True)
class StructuralMap:
    """The typed structural description of one tabular document."""

    header_row_index: int
    columns: Tuple[ColumnSpec, ...]
    account_code_col: int
    sheet: Optional[str] = None
    totals_row_indexes: Tuple[int, ...] = ()
    subtotal_row_indexes: Tuple[int, ...] = ()
    repeated_header_rows: Tuple[int, ...] = ()
    analytic_structure: AnalyticStructure = field(default_factory=AnalyticStructure)
    number_locale: NumberLocale = field(default_factory=NumberLocale)
    currency: Optional[str] = None
    scale: int = 1
    anomaly_notes: Tuple[str, ...] = ()
    map_version: str = MAP_VERSION

    # ── serialization ──────────────────────────────────────────────

    def to_json_dict(self, include_hash: bool = True) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "map_version": self.map_version,
            "sheet": self.sheet,
            "header_row_index": self.header_row_index,
            "columns": [
                {"index": c.index, "semantic": c.semantic} for c in self.columns
            ],
            "totals_row_indexes": list(self.totals_row_indexes),
            "subtotal_row_indexes": list(self.subtotal_row_indexes),
            "repeated_header_rows": list(self.repeated_header_rows),
            "account_code_col": self.account_code_col,
            "analytic_structure": {
                "separator": self.analytic_structure.separator,
                "synthetic_digits": self.analytic_structure.synthetic_digits,
            },
            "number_locale": {
                "thousands_sep": self.number_locale.thousands_sep,
                "decimal_sep": self.number_locale.decimal_sep,
            },
            "currency": self.currency,
            "scale": self.scale,
            "anomaly_notes": list(self.anomaly_notes),
        }
        if include_hash:
            out["map_hash"] = self.map_hash
        return out

    @property
    def map_hash(self) -> str:
        """sha256 of the canonical JSON minus volatile fields (minus
        `map_hash` itself)."""
        canonical = json.dumps(
            self.to_json_dict(include_hash=False),
            sort_keys=True, ensure_ascii=False, separators=(",", ":"),
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def to_json_text(self) -> str:
        """Canonical serialized form — deterministic, byte-stable, hash
        included. The cache stores exactly this text."""
        return json.dumps(
            self.to_json_dict(include_hash=True),
            sort_keys=True, ensure_ascii=False, separators=(",", ":"),
        )

    # ── deserialization / E1 validation ────────────────────────────

    @classmethod
    def from_json_dict(cls, raw: Any) -> "StructuralMap":
        if not isinstance(raw, dict):
            _fail("top level must be a JSON object (got %s)" % type(raw).__name__)
        # E1 sweep FIRST: any numeric outside the whitelist (including
        # inside unknown keys at any level) is rejected before shape
        # checks can normalize it away.
        _sweep_numerics(raw)
        _reject_unknown(raw, _TOP_LEVEL_KEYS, "the map")

        map_version = raw.get("map_version", MAP_VERSION)
        if map_version != MAP_VERSION:
            _fail("'map_version' must be %r (got %r)" % (MAP_VERSION, map_version))

        map_hash = raw.get("map_hash")
        if map_hash is not None and not isinstance(map_hash, str):
            _fail("'map_hash' must be a string when present (got %r)" % (map_hash,))

        header_row_index = _expect_index(raw.get("header_row_index"), "header_row_index")
        account_code_col = _expect_index(raw.get("account_code_col"), "account_code_col")

        columns_raw = raw.get("columns")
        if not isinstance(columns_raw, list) or not columns_raw:
            _fail("'columns' must be a non-empty list")
        columns: List[ColumnSpec] = []
        seen_indexes: set = set()
        for i, col in enumerate(columns_raw):
            if not isinstance(col, dict):
                _fail("columns[%d] must be an object (got %r)" % (i, col))
            _reject_unknown(col, _COLUMN_KEYS, "columns[%d]" % i)
            index = _expect_index(col.get("index"), "columns[%d].index" % i)
            semantic = col.get("semantic")
            if semantic not in _SEMANTICS_SET:
                _fail("columns[%d].semantic %r is not in the smap1 vocabulary %s"
                      % (i, semantic, sorted(_SEMANTICS_SET)))
            if index in seen_indexes:
                _fail("columns[%d] repeats column index %d" % (i, index))
            seen_indexes.add(index)
            columns.append(ColumnSpec(index=index, semantic=str(semantic)))

        code_cols = [c.index for c in columns if c.semantic == "account_code"]
        if len(code_cols) != 1:
            _fail("exactly one column must carry semantic 'account_code' "
                  "(got %d)" % len(code_cols))
        if account_code_col != code_cols[0]:
            _fail("'account_code_col' (%d) must equal the account_code "
                  "column's index (%d)" % (account_code_col, code_cols[0]))

        totals = _expect_index_list(raw.get("totals_row_indexes", []), "totals_row_indexes")
        subtotals = _expect_index_list(
            raw.get("subtotal_row_indexes", []), "subtotal_row_indexes")
        repeats = _expect_index_list(
            raw.get("repeated_header_rows", []), "repeated_header_rows")

        analytic_raw = raw.get("analytic_structure") or {}
        if not isinstance(analytic_raw, dict):
            _fail("'analytic_structure' must be an object (got %r)" % (analytic_raw,))
        _reject_unknown(analytic_raw, _ANALYTIC_KEYS, "analytic_structure")
        separator = _expect_opt_str(analytic_raw.get("separator"), "analytic_structure.separator")
        synthetic_digits = analytic_raw.get("synthetic_digits")
        if synthetic_digits is not None:
            synthetic_digits = _expect_index(
                synthetic_digits, "analytic_structure.synthetic_digits")
            if synthetic_digits == 0:
                _fail("'analytic_structure.synthetic_digits' must be >= 1 or null")

        locale_raw = raw.get("number_locale") or {}
        if not isinstance(locale_raw, dict):
            _fail("'number_locale' must be an object (got %r)" % (locale_raw,))
        _reject_unknown(locale_raw, _LOCALE_KEYS, "number_locale")
        thousands_sep = _expect_opt_str(
            locale_raw.get("thousands_sep"), "number_locale.thousands_sep")
        decimal_sep = _expect_opt_str(
            locale_raw.get("decimal_sep"), "number_locale.decimal_sep")

        sheet = _expect_opt_str(raw.get("sheet"), "sheet")
        currency = _expect_opt_str(raw.get("currency"), "currency")

        scale = raw.get("scale", 1)
        if isinstance(scale, bool) or not isinstance(scale, int) or scale < 1:
            _fail("'scale' must be a positive integer multiplier (got %r)" % (scale,))

        notes_raw = raw.get("anomaly_notes", [])
        if not isinstance(notes_raw, (list, tuple)):
            _fail("'anomaly_notes' must be a list of strings (got %r)" % (notes_raw,))
        notes: List[str] = []
        for i, n in enumerate(notes_raw):
            if not isinstance(n, str):
                _fail("anomaly_notes[%d] must be a string (got %r)" % (i, n))
            notes.append(n)

        return cls(
            header_row_index=header_row_index,
            columns=tuple(columns),
            account_code_col=account_code_col,
            sheet=sheet,
            totals_row_indexes=totals,
            subtotal_row_indexes=subtotals,
            repeated_header_rows=repeats,
            analytic_structure=AnalyticStructure(
                separator=separator, synthetic_digits=synthetic_digits),
            number_locale=NumberLocale(
                thousands_sep=thousands_sep, decimal_sep=decimal_sep),
            currency=currency,
            scale=scale,
            anomaly_notes=tuple(notes),
            map_version=MAP_VERSION,
        )

    @classmethod
    def from_json_text(cls, text: str) -> "StructuralMap":
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as e:
            raise StructMapError("structural map invalid: not JSON (%s)" % e)
        return cls.from_json_dict(raw)

    # ── convenience ────────────────────────────────────────────────

    def semantic_of(self, index: int) -> Optional[str]:
        for c in self.columns:
            if c.index == index:
                return c.semantic
        return None

    def columns_for(self, semantic: str) -> Tuple[int, ...]:
        return tuple(c.index for c in self.columns if c.semantic == semantic)
