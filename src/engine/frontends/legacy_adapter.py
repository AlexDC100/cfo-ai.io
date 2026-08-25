"""legacy_adapter — derive the EXACT legacy structures from a LedgerDoc.

THE PHASE-1 KEYSTONE. `derive_legacy(doc)` reproduces, bit-for-bit, the
structures the current pipeline consumes from each wrapped parser, so
N2 equivalence is provable over the golden corpus:

    parser-direct legacy structures == derive_legacy(front_end.parse(bytes))

For the deterministic trial-balance lanes (legacy_shape 'tb_rows_v10' —
saga_10_col / saga_compact_6_col / generic_4_col / csv / pdf_positional)
the derived view carries what `pipeline.stage_extract` +
`RomaniaPack.assemble_parsed_tb` consume:

  * `tb_rows`   — a REAL `TrialBalanceParseResult`: the 10-key row
                  dicts, the `.extraction` block, and the
                  `.source_anchor` recomputed by the REAL
                  `compute_source_anchor` from the reconstructed anchor
                  INPUTS (rows, file totals, pairs_present,
                  totals_row_index, synthesized_sf), then enriched with
                  `closing_result` by the REAL pack seam
                  (`RomaniaPack.attach_closing_result`) — the same code
                  objects production runs, never mirrors.
  * `assemble_shape` — the REAL `accounts_to_assemble_shape(tb_rows)`
                  output (accounts + unmapped/excluded telemetry).
  * `anchor_inputs` — the five reconstructed `compute_source_anchor`
                  arguments, exposed for inspection.

Bit-exactness rests on three mechanisms, each proven corpus-wide by
tests/engine/test_frontends.py:

  1. Money -> float is one correctly-rounded division, the exact
     inverse of the front-ends' repr-based construction;
  2. values a Money cannot hold exactly (float noise beyond scale 9,
     negative zero) are restored from the diagnosed exact-repr
     overrides in `source_meta`;
  3. values the legacy shape COMPUTES are recomputed here with the
     IDENTICAL float expressions, in the identical order, over
     bit-identical inputs: Layout B's synthesized sf
     (net = (si_d + r_d) - (si_c + r_c), landed on the natural side)
     and the PDF lane's collapsed rulaj (r = prec + cur, prec first).

For the AI-lane extract front-end (legacy_shape 'ai_extract_rows') the
derived view is the extract-stage legacy shape run_ai_lane consumes:
the {code, label, debit, credit, balance} row dicts (ExtractedRow's
fields, verbatim — balance-only rows reconstructed from the closing
side + sign, sides restored to null) plus the document's own totals
values (totals_debit / totals_credit).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Union

from engine.ir import LedgerDoc, Money

from .llm_extractor import LEGACY_SHAPE_AI_EXTRACT
from .map_guided import LEGACY_SHAPE_MAP_GUIDED
from .saga10 import (
    LEGACY_SHAPE_TB_ROWS,
    LEGACY_SLOT_FIELDS,
    META_EXTRACTION,
    META_LEGACY_SHAPE,
    META_OVERRIDES,
    META_PAIRS_PRESENT,
    META_RC_FILE_TOTALS,
    META_RC_PAIR,
    META_RULAJ_PREC,
    META_SYNTHESIZED_SF,
    META_TOTALS_ROW_INDEX,
    FrontEndError,
    money_to_float,
)


__all__ = ["LegacyTbView", "LegacyExtractView", "derive_legacy"]


@dataclass
class LegacyTbView:
    """Deterministic-lane legacy structures (see module docstring)."""
    tb_rows: Any                       # TrialBalanceParseResult
    assemble_shape: Any                # AssembleShapeResult
    anchor_inputs: Dict[str, Any] = field(default_factory=dict)


@dataclass
class LegacyExtractView:
    """AI-lane extract-stage legacy structures."""
    rows: List[Dict[str, Any]] = field(default_factory=list)
    totals_debit: Optional[float] = None
    totals_credit: Optional[float] = None


def _thaw(value: Any) -> Any:
    """MappingProxy/tuple (the frozen source_meta) -> plain dict/list."""
    if isinstance(value, Mapping):
        return {k: _thaw(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_thaw(v) for v in value]
    return value


def _slot_float(money: Optional[Money]) -> float:
    return 0.0 if money is None else money_to_float(money)


def _derive_tb(doc: LedgerDoc) -> LegacyTbView:
    from engine.country_packs.ro_romania.trial_balance_parser import (
        TrialBalanceParseResult,
        accounts_to_assemble_shape,
        compute_source_anchor,
    )

    meta = doc.header.source_meta
    extraction: Dict[str, Any] = _thaw(meta.get(META_EXTRACTION) or {})
    pairs_present: Optional[Dict[str, bool]] = _thaw(meta.get(META_PAIRS_PRESENT))
    totals_row_index: Optional[int] = meta.get(META_TOTALS_ROW_INDEX)
    synthesized_sf: bool = bool(meta.get(META_SYNTHESIZED_SF))
    rc_pair: Dict[str, Any] = _thaw(meta.get(META_RC_PAIR) or {})
    rulaj_prec: Dict[str, Any] = _thaw(meta.get(META_RULAJ_PREC) or {})
    overrides: Dict[str, Any] = _thaw(meta.get(META_OVERRIDES) or {})

    rows: List[Dict[str, Any]] = []
    for atom in doc.atoms:
        row: Dict[str, Any] = {
            "cont": atom.account_code,
            "nume_cont": atom.label,
        }
        for legacy_field, slot in LEGACY_SLOT_FIELDS:
            row[legacy_field] = _slot_float(getattr(atom, slot))

        rc = rc_pair.get(atom.atom_id)
        row["st_d"] = float(rc[0]) if rc else 0.0
        row["st_c"] = float(rc[1]) if rc else 0.0

        # Exact-repr overrides restore floats Money could not hold
        # (noise beyond scale 9, negative zero). Applied to the SLOT-
        # carried component — for the PDF lane that is rulaj_cur, i.e.
        # BEFORE the prec+cur addition below.
        for legacy_field, exact_repr in (overrides.get(atom.atom_id) or {}).items():
            row[legacy_field] = float(exact_repr)

        prec = rulaj_prec.get(atom.atom_id)
        if prec is not None:
            # PDF lane: legacy r = rulaj_prec + rulaj_cur — the IDENTICAL
            # float addition, prec first (operand order is bit-relevant).
            row["r_d"] = float(prec[0]) + row["r_d"]
            row["r_c"] = float(prec[1]) + row["r_c"]

        if synthesized_sf:
            # Layout B: the parser's exact synthesis, re-run verbatim
            # (trial_balance_parser.parse_trial_balance_df).
            net = (row["si_d"] + row["r_d"]) - (row["si_c"] + row["r_c"])
            if net >= 0:
                row["sf_d"], row["sf_c"] = net, 0.0
            else:
                row["sf_d"], row["sf_c"] = 0.0, -net

        rows.append({
            "cont": row["cont"], "nume_cont": row["nume_cont"],
            "si_d": row["si_d"], "si_c": row["si_c"],
            "r_d": row["r_d"], "r_c": row["r_c"],
            "st_d": row["st_d"], "st_c": row["st_c"],
            "sf_d": row["sf_d"], "sf_c": row["sf_c"],
        })

    file_totals = _reconstruct_file_totals(doc, totals_row_index)
    anchor_inputs: Dict[str, Any] = {
        "file_totals": file_totals,
        "pairs_present": pairs_present,
        "totals_row_index": totals_row_index,
        "synthesized_sf": synthesized_sf,
    }
    anchor = compute_source_anchor(
        rows,
        file_totals=file_totals,
        pairs_present=pairs_present,
        totals_row_index=totals_row_index,
        synthesized_sf=synthesized_sf,
    )

    tb = TrialBalanceParseResult(rows, extraction=extraction, source_anchor=anchor)

    # The pack parse seam enriches the anchor with `closing_result` —
    # run the REAL seam (registered pack), same as stage_extract.
    import engine.country_packs.ro_romania  # noqa: F401 — registers RomaniaPack
    from engine.core.country_pack_registry import get_pack
    get_pack("RO").attach_closing_result(tb)

    return LegacyTbView(
        tb_rows=tb,
        assemble_shape=accounts_to_assemble_shape(tb),
        anchor_inputs=anchor_inputs,
    )


def _reconstruct_file_totals(
    doc: LedgerDoc, totals_row_index: Optional[int]
) -> Optional[Dict[str, Optional[float]]]:
    """Rebuild the `compute_source_anchor` file_totals input from the
    verbatim `document_totals` + the rc side-channel. Legacy semantics:
    the dict is None when no totals row was found; a pair's value is
    looked up by `.get`, so an ABSENT slot and a stored-None key are
    equivalent — reconstruction emits only the present values."""
    if totals_row_index is None:
        return None
    totals = doc.header.document_totals
    out: Dict[str, Optional[float]] = {}
    if totals is not None:
        for slot, semantic in (
            ("opening_debit", "initial_debit"),
            ("opening_credit", "initial_credit"),
            ("period_debit", "period_debit"),
            ("period_credit", "period_credit"),
            ("closing_debit", "final_debit"),
            ("closing_credit", "final_credit"),
        ):
            money = getattr(totals, slot)
            if money is not None:
                out[semantic] = money_to_float(money)
    rc_file = _thaw(doc.header.source_meta.get(META_RC_FILE_TOTALS))
    if rc_file:
        if rc_file.get("debit") is not None:
            out["cumulative_debit"] = float(rc_file["debit"])
        if rc_file.get("credit") is not None:
            out["cumulative_credit"] = float(rc_file["credit"])
    return out


def _derive_extract(doc: LedgerDoc) -> LegacyExtractView:
    meta = doc.header.source_meta
    balance_form = set(_thaw(meta.get("balance_form") or []))
    extra_balance: Dict[str, str] = _thaw(meta.get("extra_balance") or {})
    overrides: Dict[str, Any] = _thaw(meta.get("float_repr_overrides") or {})
    totals_overrides: Dict[str, str] = _thaw(meta.get("totals_overrides") or {})

    rows: List[Dict[str, Any]] = []
    for atom in doc.atoms:
        entry: Dict[str, Any] = {
            "code": atom.account_code,
            "label": atom.label,
            "debit": None,
            "credit": None,
            "balance": None,
        }
        if atom.atom_id in balance_form:
            if atom.closing_debit is not None:
                entry["balance"] = money_to_float(atom.closing_debit)
            elif atom.closing_credit is not None:
                entry["balance"] = -money_to_float(atom.closing_credit)
            else:
                raise FrontEndError(
                    "balance-form atom %r carries no closing slot" % atom.atom_id
                )
        else:
            if atom.closing_debit is not None:
                entry["debit"] = money_to_float(atom.closing_debit)
            if atom.closing_credit is not None:
                entry["credit"] = money_to_float(atom.closing_credit)
            if atom.atom_id in extra_balance:
                entry["balance"] = float(extra_balance[atom.atom_id])
        for legacy_field, exact_repr in (overrides.get(atom.atom_id) or {}).items():
            entry[legacy_field] = float(exact_repr)
        rows.append(entry)

    totals_debit: Optional[float] = None
    totals_credit: Optional[float] = None
    totals = doc.header.document_totals
    if totals is not None:
        if totals.closing_debit is not None:
            totals_debit = money_to_float(totals.closing_debit)
        if totals.closing_credit is not None:
            totals_credit = money_to_float(totals.closing_credit)
    if "debit" in totals_overrides:
        totals_debit = float(totals_overrides["debit"])
    if "credit" in totals_overrides:
        totals_credit = float(totals_overrides["credit"])

    return LegacyExtractView(
        rows=rows, totals_debit=totals_debit, totals_credit=totals_credit
    )


def derive_legacy(doc: LedgerDoc) -> Union[LegacyTbView, LegacyExtractView]:
    """Dispatch on the front-end's declared legacy shape."""
    if not isinstance(doc, LedgerDoc):
        raise FrontEndError("derive_legacy takes a LedgerDoc, got %s" % type(doc).__name__)
    shape = doc.header.source_meta.get(META_LEGACY_SHAPE)
    if shape == LEGACY_SHAPE_TB_ROWS:
        return _derive_tb(doc)
    if shape == LEGACY_SHAPE_AI_EXTRACT:
        return _derive_extract(doc)
    if shape == LEGACY_SHAPE_MAP_GUIDED:
        from .map_guided_legacy import derive_map_guided_legacy
        return derive_map_guided_legacy(doc)
    raise FrontEndError(
        "LedgerDoc carries no known legacy_shape (source_meta[%r] = %r) — "
        "was it built by an engine.frontends adapter?" % (META_LEGACY_SHAPE, shape)
    )
