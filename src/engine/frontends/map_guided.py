"""map_guided front-end — MECHANICAL execution of an AI-interpreted
StructuralMap (AI-first-reader mission, Lane 2 Part B).

Division of labor: an AI interpretation step (a separate lane) produces
a **StructuralMap** — a pure-structure description of WHERE things are
in a spreadsheet (sheet, header row, column semantics, skip rows,
totals row, number separators). This front-end then reads EXACTLY the
cells the map names, with zero inference of its own: no header
guessing, no column-pattern matching, no locale voting. The numbers on
the page never pass through a model — that is the whole point.

CONTRACT (uniform with every registered adapter):

    parse(data: bytes, hints: dict) -> (LedgerDoc, diagnostics)

`hints` must carry:
    "structural_map": the map (plain dict, or an object whose __dict__
                      carries the same keys — the interp lane's
                      dataclass works either way),
    "jurisdiction":   ISO code for the DocHeader (NO default — this
                      module is jurisdiction-blind; identity always
                      enters via hints/map, never via a literal here),
    "filename":       original filename (optional, meta only).
Currency resolves hints["currency"] -> map["currency"]; absent raises.

STRUCTURALMAP VOCABULARY — the interp lane's **smap1** shape
(`engine.interp.structmap.StructuralMap`; the hand-verified fixture
maps in tests/engine/fixtures/structmaps/ are the ground truth):

    map_version: "smap1"        map_hash: str
    sheet: str | int | None     (name or 0-based index; default first)
    header_row_index: int       (0-based, physical grid row)
    columns: [{"index": int, "semantic": str}] with semantics
        account_code (required, exactly one), account_name,
        opening_debit/opening_credit,
        movement_period_debit/movement_period_credit,
        movement_cumulative_debit/movement_cumulative_credit,
        total_with_opening_debit/total_with_opening_credit,
        closing_debit/closing_credit,
        marker / hint_classification / ignore  (not read here)
    account_code_col: int       (cross-checked against columns)
    totals_row_indexes: [int]   (all excluded from data; the FIRST one
                                 feeds DocumentTotals)
    subtotal_row_indexes / repeated_header_rows: [int]  (skipped, counted)
    number_locale: {"decimal_sep": str|None, "thousands_sep": str|None}
    analytic_structure / anomaly_notes: carried opaquely (not read)
    scale: int                  (must be 1 — a scaled document would
                                 need value transformation, which a
                                 mechanical executor refuses; raises)
    currency: str | None

A `StructuralMap` instance is accepted directly (via its
`to_json_dict`), as is a plain dict in the same shape. Tolerated
conveniences for hand-written test maps: `columns` as a flat
{semantic: index} mapping, `period_debit`/`period_credit` as aliases
of the movement_period pair, a scalar `totals_row_index`, a
`skip_rows` list, flat `decimal_sep`/`thousands_sep`, and optional
`data_start_row` / `data_end_row` (EXCLUSIVE) bounds plus an
`account_code_pattern` regex override.

Interpretation-RUN metadata is NOT part of the map (the map is
content): `hints["interpreter_roles"]` / `hints["map_prompt_versions"]`
feed the extraction stamp (content-bearing version pins), and
`hints["interpretation_meta"]` (model ids, cache keys, run stamps)
parks under the hash-VOLATILE source_meta key
"structural_interpretation_meta".

TWO DISTINCT CUMULATIVE ENUMS. The classic parser conflates "Sume
totale" (opening + cumulated movements) and "Rulaj cumulat"
(cumulated movements only) into ONE `cumulative_*` semantic — a live
mislabel on 20-col extended exports. The map carries them as two
distinct semantics and this front-end keeps them distinct: each rides
its OWN per-atom side-channel (`total_with_opening_pair` /
`movement_cumulative_pair`, exact float repr strings, sparse — only
rows that carry a value) and its own file-totals side-channel. The IR's
six Money slots stay opening/period/closing.

ABSENT-vs-ZERO: a pair the MAP does not name maps to ABSENT (None on
every atom — never Money.zero); a mapped-but-blank cell maps to ZERO
(mirroring the classic parser's degrade contract, so the legacy bridge
is row-comparable). A pair mapped on one side only is a malformed map
and raises.

PER-ATOM CELL PROVENANCE — the first lane with real coordinates. Every
atom carries a FRESH `Provenance.mechanical_mapped(SourceRef.cell(
sheet, row, account_code_col))` anchored at the row's account-code
cell; any value's exact cell is (that row, structural_map.columns[
semantic]) — the map in `source_meta["structural_map"]` is part of the
provenance record. No `cell_provenance_unavailable` diagnostic here.

NUMBER PARSING is map-driven, implemented LOCALLY and deliberately
minimal: strip whitespace-class thousands chars, honor the map's
`thousands_sep` / `decimal_sep`, parenthesized/minus negatives, blank
and 'nan'-ish cells -> 0.0 (the classic degrade-to-zero contract),
unparseable text -> 0.0 + a counted diagnostic. We do NOT import the
classic locale grammar from the country pack: (a) N7 — this module is
jurisdiction-blind and a country-pack import path carries a
jurisdiction token; (b) grammar GUESSING is exactly what a mechanical
map executor must not do — the map is the separator authority. Floats
convert to exact integer Money through the shared saga10 bridge
(`float_to_money` + repr side-channels), so `derive_legacy` reproduces
the legacy floats bit-exactly.

N7: nothing in this module imports from `engine.country_packs.*`, no
jurisdiction-equality branches, no account-code literals — the default
code-shape regex is a generic digits-and-dots shape, overridable per
map. The legacy-shape bridge for these docs lives in the sibling
module `map_guided_legacy.py` (same status as `legacy_adapter.py`).
"""
from __future__ import annotations

import io
import math
import re
from typing import Any, Dict, List, Mapping, Optional, Tuple

from engine.ir import (
    AccountAtom,
    DocHeader,
    DocumentTotals,
    LedgerDoc,
    Money,
    Provenance,
    SourceRef,
)

from .saga10 import (
    FrontEndError,
    LEGACY_SLOT_FIELDS,
    META_EXTRACTION,
    META_FRONT_END,
    META_LEGACY_SHAPE,
    META_OVERRIDES,
    META_PAIRS_PRESENT,
    META_SYNTHESIZED_SF,
    META_TOTALS_ROW_INDEX,
    _carries_value,
    float_to_money,
    repr_of,
)


__all__ = [
    "MAP_GUIDED_PARSER_VERSION",
    "LEGACY_SHAPE_MAP_GUIDED",
    "META_STRUCTURAL_MAP",
    "META_INTERPRETATION_META",
    "META_TOTAL_WITH_OPENING_PAIR",
    "META_MOVEMENT_CUMULATIVE_PAIR",
    "META_TOTAL_WITH_OPENING_FILE_TOTALS",
    "META_MOVEMENT_CUMULATIVE_FILE_TOTALS",
    "META_TOTALS_OVERRIDES",
    "MapGuidedFrontEnd",
]


#: Version of the mechanical map executor (NOT of any wrapped parser —
#: nothing is wrapped). Bump on any change to cell selection, number
#: parsing, or meta emission.
MAP_GUIDED_PARSER_VERSION = "map_guided_v1"

#: derive_legacy dispatch key for map-guided documents.
LEGACY_SHAPE_MAP_GUIDED = "map_guided_tb_rows_v1"

# ── source_meta vocabulary (additions over saga10's) ────────────────────────
# All CONTENT-BEARING (participate in content_hash) except
# META_INTERPRETATION_META, which is in schema.VOLATILE_SOURCE_META_KEYS.

META_STRUCTURAL_MAP = "structural_map"                # normalized map structure
META_INTERPRETATION_META = "structural_interpretation_meta"  # run-varying (volatile)
META_TOTAL_WITH_OPENING_PAIR = "total_with_opening_pair"      # {atom_id: [repr d, repr c]}
META_MOVEMENT_CUMULATIVE_PAIR = "movement_cumulative_pair"    # {atom_id: [repr d, repr c]}
META_TOTAL_WITH_OPENING_FILE_TOTALS = "total_with_opening_file_totals"
META_MOVEMENT_CUMULATIVE_FILE_TOTALS = "movement_cumulative_file_totals"
META_TOTALS_OVERRIDES = "totals_float_repr_overrides"  # {slot_or_side: exact repr}

#: Default account-code shape — MIRRORS the classic parser's discipline
#: (digits 3-8, optional dot-separated sub-segments, optional trailing
#: apostrophe) so the two consensus legs drop the same rows (C1
#: row-count parity). Generic digits shape, not a jurisdiction literal;
#: a map may override via `account_code_pattern`.
_DEFAULT_CODE_RE = r"^\d{3,8}(\.\d{1,5})*'?$"

#: The six IR slot semantics, as (pair_name, debit_semantic, credit_semantic).
_SLOT_PAIRS: Tuple[Tuple[str, str, str], ...] = (
    ("opening", "opening_debit", "opening_credit"),
    ("period", "period_debit", "period_credit"),
    ("closing", "closing_debit", "closing_credit"),
)

#: The two cumulative semantics -> their per-atom + file-totals meta keys.
_CUMULATIVE_PAIRS: Tuple[Tuple[str, str, str, str, str], ...] = (
    (
        "total_with_opening",
        "total_with_opening_debit",
        "total_with_opening_credit",
        META_TOTAL_WITH_OPENING_PAIR,
        META_TOTAL_WITH_OPENING_FILE_TOTALS,
    ),
    (
        "movement_cumulative",
        "movement_cumulative_debit",
        "movement_cumulative_credit",
        META_MOVEMENT_CUMULATIVE_PAIR,
        META_MOVEMENT_CUMULATIVE_FILE_TOTALS,
    ),
)

#: IR slot name -> legacy tb_rows field (for the shared overrides
#: side-channel, which is keyed by LEGACY field names).
_SLOT_TO_LEGACY: Dict[str, str] = {slot: lf for lf, slot in LEGACY_SLOT_FIELDS}

# Whitespace-class characters seen as thousands separators in
# accounting exports (regular/nbsp/thin/narrow-nbsp/figure spaces).
_WS_RE = re.compile(u"[\\s    ]")


# ── map normalization ───────────────────────────────────────────────────────


def _as_mapping(value: Any, what: str) -> Dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if hasattr(value, "to_json_dict"):
        # engine.interp.structmap.StructuralMap (or compatible): its
        # canonical dict form carries map_hash and the full smap1 shape.
        return dict(value.to_json_dict(include_hash=True))
    if hasattr(value, "__dict__"):
        return dict(vars(value))
    raise FrontEndError("%s must be a mapping (or dataclass-like), got %s"
                        % (what, type(value).__name__))


def _opt_int(value: Any, what: str) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise FrontEndError("%s must be an int or None, got %r" % (what, value))
    return value


def _normalize_skip_rows(raw: Any) -> List[Dict[str, Any]]:
    """-> [{"row": int, "kind": str}] sorted by row, deterministic."""
    out: List[Dict[str, Any]] = []
    for i, entry in enumerate(raw or []):
        if isinstance(entry, bool):
            raise FrontEndError("structural_map.skip_rows[%d] invalid: %r" % (i, entry))
        if isinstance(entry, int):
            out.append({"row": entry, "kind": "unspecified"})
        elif isinstance(entry, Mapping):
            row = entry.get("row")
            if isinstance(row, bool) or not isinstance(row, int):
                raise FrontEndError(
                    "structural_map.skip_rows[%d].row must be an int, got %r"
                    % (i, row)
                )
            out.append({"row": row, "kind": str(entry.get("kind") or "unspecified")})
        else:
            raise FrontEndError(
                "structural_map.skip_rows[%d] must be an int or mapping, got %s"
                % (i, type(entry).__name__)
            )
    out.sort(key=lambda e: (e["row"], e["kind"]))
    return out


#: smap1 semantic aliases -> the executor's canonical semantic names.
_SEMANTIC_ALIASES: Dict[str, str] = {
    "movement_period_debit": "period_debit",
    "movement_period_credit": "period_credit",
}

#: smap1 column semantics that carry no extractable value for this lane.
_NON_VALUE_SEMANTICS = frozenset({"marker", "hint_classification", "ignore"})


def _normalize_columns(raw: Any) -> Dict[str, int]:
    """smap1 columns list ([{"index","semantic"}]) OR a flat
    {semantic: index} mapping -> {canonical_semantic: index} for the
    extraction-relevant semantics only."""
    entries: List[Tuple[str, Any]] = []
    if isinstance(raw, (list, tuple)):
        for i, col in enumerate(raw):
            col_map = _as_mapping(col, "structural_map.columns[%d]" % i)
            entries.append((str(col_map.get("semantic")), col_map.get("index")))
    else:
        cols = _as_mapping(raw, "structural_map.columns")
        entries = [(str(k), v) for k, v in cols.items()]
    out: Dict[str, int] = {}
    for key, idx in entries:
        semantic = _SEMANTIC_ALIASES.get(key, key)
        if semantic in _NON_VALUE_SEMANTICS:
            continue
        if isinstance(idx, bool) or not isinstance(idx, int) or idx < 0:
            raise FrontEndError(
                "structural_map.columns[%r] must carry a non-negative int "
                "index, got %r" % (key, idx)
            )
        if semantic in out:
            raise FrontEndError(
                "structural_map maps semantic %r twice (columns %d and %d)"
                % (semantic, out[semantic], idx)
            )
        out[semantic] = idx
    if "account_code" not in out:
        raise FrontEndError("structural_map.columns must name 'account_code'")
    # Pair discipline: a half-mapped D/C pair is a malformed map — one
    # side would silently read as fabricated zero.
    for pair_name, d_key, c_key in _SLOT_PAIRS:
        if (d_key in out) != (c_key in out):
            raise FrontEndError(
                "structural_map maps only one side of the %s pair (%s/%s) — "
                "a D/C pair is mapped both sides or not at all"
                % (pair_name, d_key, c_key)
            )
    for pair_name, d_key, c_key, _, _ in _CUMULATIVE_PAIRS:
        if (d_key in out) != (c_key in out):
            raise FrontEndError(
                "structural_map maps only one side of the %s pair (%s/%s)"
                % (pair_name, d_key, c_key)
            )
    return out


# ── map-driven cell -> float (LOCAL; see module docstring for why) ──────────


def _parse_cell(
    raw: Any, decimal_sep: str, thousands_sep: Optional[str]
) -> Tuple[float, str]:
    """One cell -> (value, status); status in {"ok", "blank",
    "unparseable"}. Blank and unparseable both degrade to 0.0 (the
    classic contract — a garbage cell degrades, never raises
    mid-document); the caller counts "unparseable" into a diagnostic."""
    if raw is None or isinstance(raw, bool):
        return 0.0, "blank"
    if isinstance(raw, (int, float)):
        value = float(raw)
        if value != value:  # NaN
            return 0.0, "blank"
        if not math.isfinite(value):
            return 0.0, "unparseable"
        return value, "ok"
    s = str(raw).strip()
    if not s or s.lower() in ("nan", "none", "-", "—", "–"):
        return 0.0, "blank"
    negative = False
    if s.startswith("(") and s.endswith(")"):
        negative = True
        s = s[1:-1].strip()
    if s.startswith("-"):
        negative = True
        s = s[1:].strip()
    s = _WS_RE.sub("", s)
    if thousands_sep:
        s = s.replace(thousands_sep, "")
    if decimal_sep != ".":
        s = s.replace(decimal_sep, ".")
    if not s:
        return 0.0, "blank"
    try:
        value = float(s)
    except ValueError:
        return 0.0, "unparseable"
    if not math.isfinite(value):
        return 0.0, "unparseable"
    return (-value if negative else value), "ok"


# ── sheet loading (generic file sniffing, mirrors the classic read mode) ────


def _load_sheet(data: bytes, sheet: Any) -> Tuple[Any, str]:
    """bytes -> (DataFrame read with header=None + dtype=str, sheet
    NAME). dtype=str matches the classic parser's read mode so both
    consensus legs see the identical cell strings."""
    import pandas as pd

    if data[:4] == b"PK\x03\x04":
        engine = "openpyxl"
    elif data[:4] == b"\xd0\xcf\x11\xe0":
        engine = "xlrd"
    else:
        engine = None  # let pandas sniff (raises on non-workbooks)
    try:
        xl = pd.ExcelFile(io.BytesIO(data), engine=engine)
    except Exception as exc:  # noqa: BLE001
        raise FrontEndError(
            "map_guided could not open the workbook: %s: %s"
            % (type(exc).__name__, exc)
        )
    names = list(xl.sheet_names)
    if sheet is None:
        sheet_name = names[0]
    elif isinstance(sheet, int) and not isinstance(sheet, bool):
        try:
            sheet_name = names[sheet]
        except IndexError:
            raise FrontEndError(
                "structural_map.sheet index %d out of range (%d sheet(s))"
                % (sheet, len(names))
            )
    else:
        sheet_name = str(sheet)
        if sheet_name not in names:
            raise FrontEndError(
                "structural_map.sheet %r not in workbook (sheets: %s)"
                % (sheet_name, ", ".join(names))
            )
    try:
        df = xl.parse(sheet_name, header=None, dtype=str)
    except Exception as exc:  # noqa: BLE001
        raise FrontEndError(
            "map_guided could not read sheet %r: %s: %s"
            % (sheet_name, type(exc).__name__, exc)
        )
    return df, sheet_name


# ── the front-end ───────────────────────────────────────────────────────────


class MapGuidedFrontEnd:
    """Mechanical executor of a StructuralMap. See module docstring."""

    format_id = "map_guided"

    @property
    def version(self) -> str:
        return MAP_GUIDED_PARSER_VERSION

    @property
    def spec(self) -> str:
        return "%s@%s" % (self.format_id, self.version)

    def parse(
        self, data: bytes, hints: Optional[Dict[str, Any]] = None
    ) -> Tuple[LedgerDoc, List[Dict[str, str]]]:
        hints = dict(hints or {})
        raw_map = hints.get("structural_map")
        if raw_map is None:
            raise FrontEndError(
                "map_guided requires hints['structural_map'] — this front-end "
                "executes a map, it does not infer structure"
            )
        smap = _as_mapping(raw_map, "structural_map")

        jurisdiction = hints.get("jurisdiction") or smap.get("jurisdiction")
        if not jurisdiction:
            raise FrontEndError(
                "map_guided requires a jurisdiction (hints['jurisdiction'] or "
                "structural_map['jurisdiction']) — this module carries no default"
            )
        currency = hints.get("currency") or smap.get("currency")
        if not currency:
            raise FrontEndError(
                "map_guided requires a currency (hints['currency'] or "
                "structural_map['currency']) — this module carries no default"
            )
        currency = str(currency)
        filename = str(hints.get("filename") or "")

        header_row_index = smap.get("header_row_index")
        if isinstance(header_row_index, bool) or not isinstance(header_row_index, int):
            raise FrontEndError(
                "structural_map.header_row_index must be an int, got %r"
                % (header_row_index,)
            )
        columns = _normalize_columns(smap.get("columns"))
        code_col_pin = smap.get("account_code_col")
        if code_col_pin is not None and code_col_pin != columns["account_code"]:
            raise FrontEndError(
                "structural_map.account_code_col (%r) disagrees with the "
                "columns entry (%r)" % (code_col_pin, columns["account_code"])
            )
        scale = smap.get("scale")
        if scale not in (None, 1):
            raise FrontEndError(
                "structural_map.scale %r: a scaled document needs value "
                "transformation, which the mechanical executor refuses "
                "(map_guided v1 reads cells verbatim)" % (scale,)
            )

        # Skip rows: smap1's subtotal_row_indexes + repeated_header_rows,
        # plus the tolerated flat skip_rows list.
        skip_source: List[Any] = list(smap.get("skip_rows") or [])
        for key, kind in (("subtotal_row_indexes", "subtotal"),
                          ("repeated_header_rows", "repeated_header")):
            for row in (smap.get(key) or ()):
                skip_source.append({"row": row, "kind": kind})
        skip_rows = _normalize_skip_rows(skip_source)

        # Totals rows: smap1 list (all excluded from data; the FIRST
        # feeds DocumentTotals) or the tolerated scalar.
        totals_rows: List[int] = []
        raw_totals = smap.get("totals_row_indexes")
        if raw_totals is not None:
            for row in raw_totals:
                value = _opt_int(row, "structural_map.totals_row_indexes[]")
                if value is not None:
                    totals_rows.append(value)
        else:
            scalar = _opt_int(smap.get("totals_row_index"),
                              "structural_map.totals_row_index")
            if scalar is not None:
                totals_rows.append(scalar)
        totals_row_index = totals_rows[0] if totals_rows else None

        data_start = smap.get("data_start_row")
        data_start = header_row_index + 1 if data_start is None else _opt_int(
            data_start, "structural_map.data_start_row"
        )
        data_end = _opt_int(smap.get("data_end_row"), "structural_map.data_end_row")

        # Number separators: smap1's nested number_locale object, or the
        # tolerated flat keys. The map is the separator AUTHORITY — no
        # grammar voting here.
        locale_obj = smap.get("number_locale")
        if isinstance(locale_obj, Mapping):
            decimal_sep = str(locale_obj.get("decimal_sep") or ".")
            thousands_sep = locale_obj.get("thousands_sep")
        else:
            decimal_sep = str(smap.get("decimal_sep") or ".")
            thousands_sep = smap.get("thousands_sep")
        thousands_sep = None if thousands_sep in (None, "") else str(thousands_sep)
        if thousands_sep == decimal_sep:
            raise FrontEndError(
                "structural_map decimal_sep and thousands_sep are both %r"
                % decimal_sep
            )
        code_pattern = str(smap.get("account_code_pattern") or _DEFAULT_CODE_RE)
        try:
            code_re = re.compile(code_pattern)
        except re.error as exc:
            raise FrontEndError(
                "structural_map.account_code_pattern %r is not a valid regex: %s"
                % (code_pattern, exc)
            )

        df, sheet_name = _load_sheet(data, smap.get("sheet"))
        n_rows, n_cols = df.shape
        max_col = max(columns.values())
        if max_col >= n_cols:
            raise FrontEndError(
                "structural_map names column %d but sheet %r has only %d columns"
                % (max_col, sheet_name, n_cols)
            )
        end = n_rows if data_end is None else min(data_end, n_rows)

        diagnostics: List[Dict[str, str]] = []
        if len(totals_rows) > 1:
            diagnostics.append({
                "code": "multiple_totals_rows",
                "detail": "map names %d totals rows (%s); all excluded from "
                          "data, the first feeds document_totals"
                          % (len(totals_rows), sorted(totals_rows)),
            })
        totals_rows_set = set(totals_rows)
        skip_by_row: Dict[int, str] = {e["row"]: e["kind"] for e in skip_rows}

        code_col = columns["account_code"]
        name_col = columns.get("account_name")
        mapped_slot_pairs = [
            (pair, d, c) for pair, d, c in _SLOT_PAIRS if d in columns
        ]
        mapped_cum_pairs = [
            entry for entry in _CUMULATIVE_PAIRS if entry[1] in columns
        ]

        atoms: List[AccountAtom] = []
        overrides: Dict[str, Dict[str, str]] = {}
        cum_channels: Dict[str, Dict[str, List[str]]] = {
            entry[3]: {} for entry in mapped_cum_pairs
        }
        blank_dropped = 0
        shape_dropped = 0
        marked_skipped = 0
        unparseable_cells = 0

        import pandas as pd

        def _cell_value(row_idx: int, col_idx: int) -> Tuple[float, str]:
            raw = df.iloc[row_idx, col_idx]
            if raw is not None and not isinstance(raw, str) and pd.isna(raw):
                raw = None
            return _parse_cell(raw, decimal_sep, thousands_sep)

        def _slot_money(atom_id: str, slot: str, value: float) -> Money:
            money, override = float_to_money(value, currency)
            if override is not None:
                overrides.setdefault(atom_id, {})[_SLOT_TO_LEGACY[slot]] = override
                diagnostics.append({
                    "code": "float_repr_override",
                    "detail": "%s %s=%s exceeds exact Money encoding; exact "
                              "repr preserved in source_meta"
                              % (atom_id, slot, override),
                })
            return money

        for row_idx in range(max(data_start, 0), end):
            if row_idx in totals_rows_set:
                continue
            if row_idx in skip_by_row:
                marked_skipped += 1
                continue
            raw_code = df.iloc[row_idx, code_col]
            code = "" if (raw_code is None or (not isinstance(raw_code, str)
                                              and pd.isna(raw_code))) \
                else str(raw_code).strip()
            if not code or code.lower() == "nan":
                blank_dropped += 1
                continue
            if not code_re.match(code):
                shape_dropped += 1
                continue

            label = ""
            if name_col is not None:
                raw_name = df.iloc[row_idx, name_col]
                if raw_name is not None and (isinstance(raw_name, str)
                                             or not pd.isna(raw_name)):
                    label = str(raw_name).strip()
                    if label.lower() == "nan":
                        label = ""

            atom_id = "r%05d:%s" % (len(atoms), code)
            slots: Dict[str, Optional[Money]] = {}
            for _pair, d_key, c_key in mapped_slot_pairs:
                for slot_key in (d_key, c_key):
                    value, status = _cell_value(row_idx, columns[slot_key])
                    if status == "unparseable":
                        unparseable_cells += 1
                    slots[slot_key] = _slot_money(atom_id, slot_key, value)

            for _name, d_key, c_key, pair_meta_key, _ft_key in mapped_cum_pairs:
                d_val, d_status = _cell_value(row_idx, columns[d_key])
                c_val, c_status = _cell_value(row_idx, columns[c_key])
                for status in (d_status, c_status):
                    if status == "unparseable":
                        unparseable_cells += 1
                if _carries_value(d_val, c_val):
                    cum_channels[pair_meta_key][atom_id] = [
                        repr_of(d_val), repr_of(c_val)
                    ]

            atoms.append(AccountAtom(
                atom_id=atom_id,
                account_code=code,
                label=label,
                # FRESH per-atom provenance with a REAL cell coordinate,
                # anchored at the row's account-code cell; column
                # coordinates for the value cells are recoverable from
                # source_meta["structural_map"]["columns"].
                provenance=Provenance.mechanical_mapped(
                    SourceRef.cell(sheet_name, row_idx, code_col)
                ),
                **slots
            ))

        dropped = blank_dropped + shape_dropped
        if dropped:
            diagnostics.append({
                "code": "dropped_rows",
                "detail": "%d data-region row(s) dropped: %d blank/absent "
                          "account code, %d failing the code-shape pattern %r "
                          "(mirrors the classic parser's silent drop — "
                          "surfaced here for row-count parity accounting)"
                          % (dropped, blank_dropped, shape_dropped, code_pattern),
            })
        if marked_skipped:
            diagnostics.append({
                "code": "skipped_marked_rows",
                "detail": "%d row(s) skipped as map-marked (%s)"
                          % (marked_skipped, ", ".join(sorted({
                              e["kind"] for e in skip_rows
                          }))),
            })
        if unparseable_cells:
            diagnostics.append({
                "code": "unparseable_cells",
                "detail": "%d mapped cell(s) did not parse as numbers under "
                          "the map's separators and degraded to 0.0"
                          % unparseable_cells,
            })

        document_totals, cum_file_totals, totals_overrides = self._read_totals(
            df, sheet_name, columns, totals_row_index, mapped_slot_pairs,
            mapped_cum_pairs, decimal_sep, thousands_sep, currency, diagnostics,
        )

        pairs_present = {
            "si": "opening_debit" in columns,
            "rl": "period_debit" in columns,
            "rc": any(entry[1] in columns for entry in _CUMULATIVE_PAIRS),
            # Legacy rows ALWAYS carry sf: from the mapped closing pair,
            # or synthesized from the si+rl identity by the bridge.
            "sf": True,
        }
        synthesized_sf = "closing_debit" not in columns

        structural_map_meta: Dict[str, Any] = {
            "sheet": sheet_name,
            "header_row_index": header_row_index,
            "data_start_row": data_start,
            "data_end_row": data_end,
            "columns": dict(sorted(columns.items())),
            "skip_rows": skip_rows,
            "totals_row_indexes": sorted(totals_rows),
            "totals_row_index": totals_row_index,
            "decimal_sep": decimal_sep,
            "thousands_sep": thousands_sep,
            "account_code_pattern": code_pattern,
        }

        # The extraction stamp — `method` is NEVER left empty (the
        # scanned-PDF incident inverse): every mapped document declares
        # itself mechanical_mapped, with the map identity pinned.
        # interpreter_roles / map_prompt_versions are interpretation-RUN
        # version pins (content-bearing, like parser versions) supplied
        # by the caller — the map itself carries content, not run info.
        extraction: Dict[str, Any] = {
            "method": "mechanical_mapped",
            "parser_version": MAP_GUIDED_PARSER_VERSION,
            "source_format": "map_guided",
            "number_locale": {"decimal_sep": decimal_sep,
                              "thousands_sep": thousands_sep},
            "sheet": sheet_name,
            "header_row_index": header_row_index,
            "map_hash": smap.get("map_hash"),
            "map_version": smap.get("map_version"),
            "interpreter_roles": list(
                hints.get("interpreter_roles")
                or smap.get("interpreter_roles") or []
            ),
            "map_prompt_versions": dict(
                hints.get("map_prompt_versions")
                or smap.get("map_prompt_versions") or {}
            ),
        }

        source_meta: Dict[str, Any] = {
            META_FRONT_END: self.spec,
            META_LEGACY_SHAPE: LEGACY_SHAPE_MAP_GUIDED,
            "original_filename": filename,
            META_EXTRACTION: extraction,
            META_STRUCTURAL_MAP: structural_map_meta,
            META_PAIRS_PRESENT: pairs_present,
            META_TOTALS_ROW_INDEX: totals_row_index,
            META_SYNTHESIZED_SF: synthesized_sf,
            META_OVERRIDES: overrides,
        }
        for _name, _d, _c, pair_meta_key, _ft in mapped_cum_pairs:
            source_meta[pair_meta_key] = cum_channels[pair_meta_key]
        for ft_key, values in cum_file_totals.items():
            source_meta[ft_key] = values
        if totals_overrides:
            source_meta[META_TOTALS_OVERRIDES] = totals_overrides

        interp_meta = hints.get("interpretation_meta") or smap.get("runtime")
        if isinstance(interp_meta, Mapping) and interp_meta:
            # Run-varying interpretation metadata — hash-volatile by
            # schema.VOLATILE_SOURCE_META_KEYS.
            source_meta[META_INTERPRETATION_META] = dict(interp_meta)

        header = DocHeader(
            jurisdiction=str(jurisdiction),
            currency=currency,
            document_totals=document_totals,
            source_meta=source_meta,
        )
        return LedgerDoc(header=header, atoms=tuple(atoms)), diagnostics

    def _read_totals(
        self,
        df: Any,
        sheet_name: str,
        columns: Dict[str, int],
        totals_row_index: Optional[int],
        mapped_slot_pairs: List[Tuple[str, str, str]],
        mapped_cum_pairs: List[Tuple[str, str, str, str, str]],
        decimal_sep: str,
        thousands_sep: Optional[str],
        currency: str,
        diagnostics: List[Dict[str, str]],
    ) -> Tuple[Optional[DocumentTotals], Dict[str, Dict[str, Optional[str]]],
               Dict[str, str]]:
        """The file's own totals row, verbatim, read at the map's
        coordinates. si/rl/sf pairs land in DocumentTotals slots; each
        cumulative semantic rides its own file-totals side-channel as
        exact repr strings. Blank cells -> ABSENT (never fabricated
        zero). A totals cell whose float exceeds exact Money encoding
        keeps the scale-9 Money and records the exact repr in
        `totals_float_repr_overrides` (a DELIBERATE relaxation of
        saga10's raise: mapped totals are direct cell reads without the
        classic parser's _round2z guarantee)."""
        import pandas as pd

        cum_file_totals: Dict[str, Dict[str, Optional[str]]] = {}
        totals_overrides: Dict[str, str] = {}
        if totals_row_index is None:
            return None, cum_file_totals, totals_overrides
        if totals_row_index >= len(df):
            raise FrontEndError(
                "structural_map.totals_row_index %d beyond sheet %r (%d rows)"
                % (totals_row_index, sheet_name, len(df))
            )

        def _totals_cell(semantic: str) -> Tuple[Optional[float], str]:
            raw = df.iloc[totals_row_index, columns[semantic]]
            if raw is not None and not isinstance(raw, str) and pd.isna(raw):
                raw = None
            value, status = _parse_cell(raw, decimal_sep, thousands_sep)
            if status == "blank":
                return None, status  # ABSENT — no fabricated zero
            return value, status

        slot_values: Dict[str, Money] = {}
        for pair, d_key, c_key in mapped_slot_pairs:
            for slot_key in (d_key, c_key):
                value, status = _totals_cell(slot_key)
                if status == "unparseable":
                    diagnostics.append({
                        "code": "unparseable_cells",
                        "detail": "totals-row cell %s did not parse; slot "
                                  "left ABSENT" % slot_key,
                    })
                    continue
                if value is None:
                    continue
                money, override = float_to_money(value, currency)
                if override is not None:
                    totals_overrides[slot_key] = override
                    diagnostics.append({
                        "code": "totals_float_repr_override",
                        "detail": "totals cell %s=%s exceeds exact Money "
                                  "encoding; exact repr preserved"
                                  % (slot_key, override),
                    })
                slot_values[slot_key] = money

        for _name, d_key, c_key, _pair_key, ft_key in mapped_cum_pairs:
            entry: Dict[str, Optional[str]] = {"debit": None, "credit": None}
            any_value = False
            for side, sem in (("debit", d_key), ("credit", c_key)):
                value, status = _totals_cell(sem)
                if status == "unparseable":
                    diagnostics.append({
                        "code": "unparseable_cells",
                        "detail": "totals-row cell %s did not parse; side "
                                  "left ABSENT" % sem,
                    })
                    continue
                if value is not None:
                    entry[side] = repr_of(value)
                    any_value = True
            if any_value:
                cum_file_totals[ft_key] = entry

        return DocumentTotals(**slot_values), cum_file_totals, totals_overrides
