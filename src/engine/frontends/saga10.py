"""SAGA 10-column front-end — the REFERENCE deterministic adapter.

Phase 1 of the compiler restructure: front-ends WRAP the existing
deterministic parsers and EMIT the `engine.ir.LedgerDoc` IR. The old
pipeline keeps running exactly as-is — nothing routes through these
adapters yet (cutover is a later phase); the adapters exist so that N2
equivalence (parser-direct legacy structures == derive_legacy(parse))
is provable over the golden corpus before anything moves.

This module also hosts the machinery SHARED by the four deterministic
trial-balance formats (`saga_10_col`, `saga_compact_6_col`,
`generic_4_col`, `csv`) because all four are dialects of ONE parser
(`trial_balance_parser.parse_trial_balance_file` /
`parse_trial_balance_csv`) — the sibling modules (`saga6`, `generic4`,
`csv_fe`) are thin format-id shells over `build_tb_ledgerdoc` below.

CONTRACT (Part B item 1): each front-end exposes
    parse(data: bytes, hints: dict) -> (LedgerDoc, diagnostics: list)
Front-ends do NO classification and NO totals logic beyond copying the
file's own totals row verbatim into `header.document_totals`.

COLUMN-PAIR MAPPING — legacy tb_rows carry FOUR pairs, the IR atom has
THREE slots (`MONEY_FIELDS`):

    si_d / si_c   (solduri initiale)   -> opening_debit / opening_credit
    r_d  / r_c    (rulaj perioada)     -> period_debit  / period_credit
    sf_d / sf_c   (solduri finale)     -> closing_debit / closing_credit
    st_d / st_c   (sume totale, "rc")  -> header.source_meta["rc_pair"]

The RO-specific cumulative pair (sume totale = opening + cumulated
rulaj — NOT derivable from the other three: on a mid-year balanta
st != si + r, and even on an annual one float addition differs in the
last ulp from the file's own cell) rides a documented per-atom
side-channel in `source_meta` as exact decimal repr strings until the
IR grows a fourth pair at cutover. ABSENT-vs-ZERO semantics:

  * a column pair the FORMAT lacks maps to ABSENT (None) — e.g.
    generic_4_col has only the closing pair, so opening/period slots
    are None; Layout B (saga_compact_6_col) has no Solduri-finale
    block, so closing slots are None (the parser SYNTHESIZES sf from
    the si+rl identity — that synthesis is re-derived, not stored;
    the front-end asserts the parser's synthesized values match the
    identity so the ABSENT encoding is provably lossless);
  * a present-but-zero cell maps to ZERO Money, never None.

FLOAT EXACTNESS — the legacy parser produces Python floats; the IR
carries exact integer Money. Conversion goes through the float's
shortest repr (string math, no rounding), choosing the minimal scale
>= the currency's ISO scale that represents the value exactly. Two
pathological float shapes cannot be Money at scale <= 9 and are
handled by a DIAGNOSED exact-repr override side-channel
(`source_meta["float_repr_overrides"]`) so `derive_legacy` reproduces
the legacy float bit-exactly anyway:

  * genuine float noise stored in the source workbook (seen in the
    corpus: a true numeric cell holding 21200.02000000002 — 11
    fractional digits in shortest repr); the atom carries the value
    rounded half-even to scale 9 (error <= 5e-10, never material) and
    the exact repr rides the override;
  * negative zero (a parenthesized/minus zero cell parses to -0.0,
    which integer Money cannot encode); the atom carries ZERO.

PROVENANCE — method='mechanical', confidence 1.0 (exact by
definition; the mechanical FAMILY now also includes 'mechanical_mapped'
— the map-guided executor in map_guided.py, which DOES carry per-cell
refs). The wrapped parser's output rows do NOT carry per-row
sheet/row/col coordinates (TrialBalanceParseResult loses the dataframe
index), so per-atom cell SourceRefs are unavailable in Phase 1: atoms
carry a stage ref ('frontend:<format_id>') and the gap is reported as
a diagnostic (per the phase spec: extend only if the parser already
carries the info — it does not; real cell refs land at cutover when
the parser itself emits them).
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

from engine.ir import (
    AccountAtom,
    DocHeader,
    DocumentTotals,
    LedgerDoc,
    Money,
    Provenance,
    SourceRef,
    scale_for_currency,
)


__all__ = [
    "FrontEndError",
    "Saga10FrontEnd",
    "build_tb_ledgerdoc",
    "float_to_money",
    "money_to_float",
    "LEGACY_SLOT_FIELDS",
    "META_EXTRACTION",
    "META_FRONT_END",
    "META_LEGACY_SHAPE",
    "META_OVERRIDES",
    "META_PAIRS_PRESENT",
    "META_RC_FILE_TOTALS",
    "META_RC_PAIR",
    "META_RULAJ_PREC",
    "META_SYNTHESIZED_SF",
    "META_TOTALS_ROW_INDEX",
    "LEGACY_SHAPE_TB_ROWS",
]


class FrontEndError(ValueError):
    """A front-end could not faithfully represent the parsed document
    in the IR (distinct from the wrapped parser's own ParseError /
    PdfIngestError, which propagate untouched)."""


# ── source_meta vocabulary (the Phase-1 bridge keys) ────────────────────────
# None of these keys is in schema.VOLATILE_SOURCE_META_KEYS — they are
# content-bearing and participate in content_hash by design.

META_FRONT_END = "front_end"                # "<format_id>@<version>" spec
META_LEGACY_SHAPE = "legacy_shape"          # dispatch key for derive_legacy
META_EXTRACTION = "extraction"              # the parser's extraction block, verbatim
META_PAIRS_PRESENT = "pairs_present"        # {"si","rl","rc","sf": bool} | None
META_TOTALS_ROW_INDEX = "totals_row_index"  # int | None (None == no totals row)
META_SYNTHESIZED_SF = "synthesized_sf"      # bool (Layout B identity synthesis)
META_RC_PAIR = "rc_pair"                    # {atom_id: [repr st_d, repr st_c]} sparse
META_RC_FILE_TOTALS = "rc_file_totals"      # {"debit": repr|None, "credit": repr|None}
META_RULAJ_PREC = "rulaj_prec"              # PDF only: {atom_id: [repr d, repr c]} sparse
META_OVERRIDES = "float_repr_overrides"     # {atom_id: {legacy_field: exact repr}}

LEGACY_SHAPE_TB_ROWS = "tb_rows_v10"        # the 10-key RO trial-balance row shape

#: (legacy row key, atom slot) — the three IR-slot pairs in legacy order.
LEGACY_SLOT_FIELDS: Tuple[Tuple[str, str], ...] = (
    ("si_d", "opening_debit"),
    ("si_c", "opening_credit"),
    ("r_d", "period_debit"),
    ("r_c", "period_credit"),
    ("sf_d", "closing_debit"),
    ("sf_c", "closing_credit"),
)

#: anchor pair key -> (legacy debit key, legacy credit key) for the slots.
_PAIR_TO_LEGACY: Dict[str, Tuple[str, str]] = {
    "si": ("si_d", "si_c"),
    "rl": ("r_d", "r_c"),
    "sf": ("sf_d", "sf_c"),
}

_MAX_MONEY_SCALE = 9  # engine.ir.money._MAX_SCALE — the IR's sanity ceiling


# ── float <-> Money (exact by construction, overrides when impossible) ──────


def _plain_decimal_repr(value: float) -> str:
    """The float's shortest round-trip repr as a PLAIN decimal string
    (scientific notation expanded by string surgery — no float math, no
    decimal module). float(result) == value always."""
    if not math.isfinite(value):
        raise FrontEndError("non-finite float %r cannot enter the IR" % (value,))
    text = repr(value)
    if "e" not in text and "E" not in text:
        return text
    mantissa, _, exp_text = text.replace("E", "e").partition("e")
    exponent = int(exp_text)
    sign = ""
    if mantissa.startswith(("-", "+")):
        sign = "-" if mantissa[0] == "-" else ""
        mantissa = mantissa[1:]
    int_part, _, frac_part = mantissa.partition(".")
    digits = int_part + frac_part
    point = len(int_part) + exponent  # digits left of the decimal point
    if point <= 0:
        out = sign + "0." + ("0" * -point) + digits
    elif point >= len(digits):
        out = sign + digits + ("0" * (point - len(digits)))
    else:
        out = sign + digits[:point] + "." + digits[point:]
    if float(out) != value:  # pure safety net — expansion is exact
        raise FrontEndError(
            "scientific-notation expansion of %r produced %r" % (value, out)
        )
    return out


def _is_negative_zero(value: float) -> bool:
    return value == 0.0 and math.copysign(1.0, value) < 0


def float_to_money(value: float, currency: str) -> Tuple[Money, Optional[str]]:
    """Legacy float -> (Money, override_repr_or_None).

    Exact path (override None): the value's shortest repr fits within
    scale <= 9, so Money holds it exactly and
    `money_to_float(money) == value` bit-for-bit (repr(x) round-trips,
    and int/10**scale division is correctly rounded to the SAME double).

    Override path (override = the exact repr string): the float cannot
    be integer minor units at any sane scale (fractional digits > 9, or
    negative zero). The Money then carries the closest scale-9 value
    (round half-even by string math) / ZERO for -0.0, and the caller
    must record the override so `derive_legacy` reproduces the exact
    legacy float from the repr instead of the Money.
    """
    value = float(value)
    if _is_negative_zero(value):
        return Money.zero(currency), "-0.0"
    text = _plain_decimal_repr(value)
    body = text[1:] if text.startswith("-") else text
    int_part, _, frac_part = body.partition(".")
    frac_needed = frac_part.rstrip("0")
    base_scale = scale_for_currency(currency)
    scale = max(base_scale, len(frac_needed))
    if scale <= _MAX_MONEY_SCALE:
        return Money.from_decimal_str(currency, text, scale=scale), None
    # Round half-even to the ceiling scale by pure string math.
    keep = frac_part[:_MAX_MONEY_SCALE].ljust(_MAX_MONEY_SCALE, "0")
    remainder = frac_part[_MAX_MONEY_SCALE:]
    minor = int(int_part + keep)
    half = "5" + "0" * (len(remainder) - 1)
    if remainder > half or (remainder == half and minor % 2 == 1):
        minor += 1
    if text.startswith("-"):
        minor = -minor
    return Money(currency, minor, _MAX_MONEY_SCALE), text


def money_to_float(money: Money) -> float:
    """Money -> the legacy float: exact-integer minor units divided by
    10**scale (one correctly-rounded operation — for every value the
    exact path of `float_to_money` produced, this returns the original
    double bit-for-bit)."""
    return money.amount_minor / (10 ** money.scale)


def repr_of(value: float) -> str:
    """Exact plain-decimal repr for side-channel storage (rc pair,
    rulaj_prec). float(repr_of(x)) == x always, -0.0 included."""
    if _is_negative_zero(float(value)):
        return "-0.0"
    return _plain_decimal_repr(float(value))


# ── shared LedgerDoc builder for the trial_balance_parser lanes ─────────────


def _carries_value(debit: float, credit: float) -> bool:
    """True when the pair carries information a zero-default would lose:
    any nonzero value, or a negative zero (which is != +0.0 in repr)."""
    return (
        debit != 0.0 or credit != 0.0
        or _is_negative_zero(debit) or _is_negative_zero(credit)
    )


def build_tb_ledgerdoc(
    result: Any,
    *,
    format_id: str,
    spec: str,
    hints: Optional[Dict[str, Any]] = None,
) -> Tuple[LedgerDoc, List[Dict[str, str]]]:
    """TrialBalanceParseResult (the wrapped parser's output) -> LedgerDoc.

    `result` is the parse output of `parse_trial_balance_file` /
    `parse_trial_balance_csv`: a list of 10-key row dicts carrying the
    `.extraction` block and the `.source_anchor` block. Everything the
    legacy pipeline consumes is recoverable from the built doc — proven
    by `legacy_adapter.derive_legacy` + the corpus equivalence suite.
    """
    hints = dict(hints or {})
    diagnostics: List[Dict[str, str]] = []
    currency = str(hints.get("currency") or "RON")
    jurisdiction = str(hints.get("jurisdiction") or "RO")
    filename = str(hints.get("filename") or "")

    extraction = dict(getattr(result, "extraction", {}) or {})
    anchor = dict(getattr(result, "source_anchor", {}) or {})
    anchor_pairs: Dict[str, Any] = dict(anchor.get("pairs") or {})

    detected_format = extraction.get("source_format")
    if detected_format and detected_format != format_id and format_id != "csv":
        # The parser is the authority on the layout; the front-end id is
        # only the caller's routing expectation. Record, don't override.
        diagnostics.append({
            "code": "format_mismatch",
            "detail": "front-end %s wraps a document the parser detected as %r"
                      % (format_id, detected_format),
        })

    pairs_present: Dict[str, bool] = {
        key: anchor_pairs.get(key) is not None for key in ("si", "rl", "rc", "sf")
    }
    sf_entry = anchor_pairs.get("sf") or {}
    synthesized_sf = bool(sf_entry.get("synthesized_from_identity"))
    totals_row_index = anchor.get("totals_row_index")

    provenance = Provenance.mechanical(
        SourceRef.pipeline_stage("frontend:%s" % format_id)
    )
    diagnostics.append({
        "code": "cell_provenance_unavailable",
        "detail": "tb_parser output carries no per-row sheet/row/col "
                  "coordinates; atoms use a stage ref until cutover",
    })

    atoms: List[AccountAtom] = []
    rc_pair: Dict[str, List[str]] = {}
    overrides: Dict[str, Dict[str, str]] = {}
    leaked_pairs: List[str] = []

    def _slot_money(atom_id: str, legacy_field: str, value: float) -> Money:
        money, override = float_to_money(value, currency)
        if override is not None:
            overrides.setdefault(atom_id, {})[legacy_field] = override
            diagnostics.append({
                "code": "float_repr_override",
                "detail": "%s %s=%s exceeds exact Money encoding; exact repr "
                          "preserved in source_meta" % (atom_id, legacy_field, override),
            })
        return money

    for index, row in enumerate(result):
        code = str(row.get("cont") or "").strip()
        atom_id = "r%05d:%s" % (index, code)
        slots: Dict[str, Optional[Money]] = {}

        for pair_key, (d_key, c_key) in _PAIR_TO_LEGACY.items():
            d_val = float(row.get(d_key) or 0.0)
            c_val = float(row.get(c_key) or 0.0)
            if pair_key == "sf":
                if synthesized_sf:
                    # Layout B: the file has NO closing block — the parser
                    # synthesized sf from the si+rl identity. ABSENT in the
                    # IR; derive_legacy re-runs the identical synthesis.
                    # Assert losslessness: the stored sf must equal the
                    # identity's output bit-for-bit (it does, by parser
                    # construction — a mismatch means the parser changed).
                    net = (float(row.get("si_d") or 0.0) + float(row.get("r_d") or 0.0)) - (
                        float(row.get("si_c") or 0.0) + float(row.get("r_c") or 0.0)
                    )
                    expect_d, expect_c = (net, 0.0) if net >= 0 else (0.0, -net)
                    if repr(expect_d) != repr(d_val) or repr(expect_c) != repr(c_val):
                        raise FrontEndError(
                            "synthesized sf for %s does not reproduce from the "
                            "si+rl identity ((%r, %r) vs stored (%r, %r)) — "
                            "parser synthesis changed; ABSENT encoding would "
                            "be lossy" % (atom_id, expect_d, expect_c, d_val, c_val)
                        )
                    continue  # closing slots stay ABSENT
                present = True  # non-synthesized sf is always carried
            else:
                present = pairs_present[pair_key]
                if not present and _carries_value(d_val, c_val):
                    # One-sided/unpaired column mapping leaked real values
                    # into a pair the anchor reports absent. Carry them (a
                    # zero-default would silently drop money) and diagnose.
                    present = True
                    if pair_key not in leaked_pairs:
                        leaked_pairs.append(pair_key)
                        diagnostics.append({
                            "code": "values_on_absent_pair",
                            "detail": "pair %r reported absent by the anchor "
                                      "but rows carry nonzero values; slots "
                                      "populated anyway" % pair_key,
                        })
            if present:
                slots[_slot_name(d_key)] = _slot_money(atom_id, d_key, d_val)
                slots[_slot_name(c_key)] = _slot_money(atom_id, c_key, c_val)

        st_d = float(row.get("st_d") or 0.0)
        st_c = float(row.get("st_c") or 0.0)
        if _carries_value(st_d, st_c):
            if not pairs_present["rc"] and "rc" not in leaked_pairs:
                leaked_pairs.append("rc")
                diagnostics.append({
                    "code": "values_on_absent_pair",
                    "detail": "pair 'rc' reported absent by the anchor but rows "
                              "carry nonzero sume-totale values; side-channel "
                              "populated anyway",
                })
            rc_pair[atom_id] = [repr_of(st_d), repr_of(st_c)]

        atoms.append(AccountAtom(
            atom_id=atom_id,
            account_code=code,
            label=str(row.get("nume_cont") or ""),
            provenance=provenance,
            **slots
        ))

    document_totals, rc_file_totals = _build_document_totals(
        anchor_pairs, totals_row_index, currency
    )

    source_meta: Dict[str, Any] = {
        META_FRONT_END: spec,
        META_LEGACY_SHAPE: LEGACY_SHAPE_TB_ROWS,
        "original_filename": filename,
        META_EXTRACTION: extraction,
        META_PAIRS_PRESENT: pairs_present,
        META_TOTALS_ROW_INDEX: totals_row_index,
        META_SYNTHESIZED_SF: synthesized_sf,
        META_RC_PAIR: rc_pair,
        META_OVERRIDES: overrides,
    }
    if rc_file_totals is not None:
        source_meta[META_RC_FILE_TOTALS] = rc_file_totals

    header = DocHeader(
        jurisdiction=jurisdiction,
        currency=currency,
        document_totals=document_totals,
        source_meta=source_meta,
    )
    return LedgerDoc(header=header, atoms=tuple(atoms)), diagnostics


def _slot_name(legacy_field: str) -> str:
    for lf, slot in LEGACY_SLOT_FIELDS:
        if lf == legacy_field:
            return slot
    raise FrontEndError("unknown legacy field %r" % (legacy_field,))


def _build_document_totals(
    anchor_pairs: Dict[str, Any],
    totals_row_index: Optional[int],
    currency: str,
) -> Tuple[Optional[DocumentTotals], Optional[Dict[str, Optional[str]]]]:
    """The file's own totals row, verbatim, from the anchor's file_*
    values (`_round2z`'d by the parser — always exactly representable at
    scale 2, asserted below). si/rl/sf pairs land in DocumentTotals
    slots; the cumulative (rc) pair rides `source_meta` as exact repr
    strings. Returns (totals | None, rc_file_totals | None) — both None
    when the file has no totals row."""
    if totals_row_index is None:
        return None, None
    slot_values: Dict[str, Optional[Money]] = {}
    for pair_key, slot_prefix in (("si", "opening"), ("rl", "period"), ("sf", "closing")):
        entry = anchor_pairs.get(pair_key)
        if not entry:
            continue
        for side, slot_side in (("file_debit", "debit"), ("file_credit", "credit")):
            value = entry.get(side)
            if value is None:
                continue  # blank cell in the totals row -> ABSENT slot
            money, override = float_to_money(float(value), currency)
            if override is not None:
                # _round2z output is by construction <= 2 fractional
                # digits and never -0.0 — an override here means the
                # parser's rounding contract changed. Fail loud.
                raise FrontEndError(
                    "totals value %r (%s.%s) not exactly representable — "
                    "parser _round2z contract violated" % (value, pair_key, side)
                )
            slot_values["%s_%s" % (slot_prefix, slot_side)] = money
    rc_file_totals: Optional[Dict[str, Optional[str]]] = None
    rc_entry = anchor_pairs.get("rc")
    if rc_entry:
        rc_file_totals = {
            "debit": None if rc_entry.get("file_debit") is None
            else repr_of(float(rc_entry["file_debit"])),
            "credit": None if rc_entry.get("file_credit") is None
            else repr_of(float(rc_entry["file_credit"])),
        }
    return DocumentTotals(**slot_values), rc_file_totals


# ── the front-end classes ───────────────────────────────────────────────────


class _DeterministicTbFrontEnd:
    """Base for the four trial_balance_parser-backed formats. Subclasses
    set `format_id`; `version` derives from the wrapped parser's
    PARSER_VERSION (Part B item 5)."""

    format_id: str = ""

    @property
    def version(self) -> str:
        from engine.country_packs.ro_romania.trial_balance_parser import PARSER_VERSION
        return PARSER_VERSION

    @property
    def spec(self) -> str:
        return "%s@%s" % (self.format_id, self.version)

    def _parse_legacy(self, data: bytes, filename: str) -> Any:
        from engine.country_packs.ro_romania.trial_balance_parser import (
            parse_trial_balance_file,
        )
        return parse_trial_balance_file(data, filename)

    def parse(
        self, data: bytes, hints: Optional[Dict[str, Any]] = None
    ) -> Tuple[LedgerDoc, List[Dict[str, str]]]:
        hints = dict(hints or {})
        filename = str(hints.get("filename") or "")
        result = self._parse_legacy(data, filename)
        return build_tb_ledgerdoc(
            result, format_id=self.format_id, spec=self.spec, hints=hints
        )


class Saga10FrontEnd(_DeterministicTbFrontEnd):
    """SAGA / ContSal / Crystal-Reports 10-column layout: all four D/C
    pairs (SI / RL / RC / SF). Atoms carry opening/period/closing; the
    cumulative pair rides the rc side-channel."""

    format_id = "saga_10_col"
