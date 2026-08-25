"""Legacy bridge for map_guided documents — derive the 10-key legacy
tb_rows shape (+ TrialBalanceParseResult carrier with `.extraction` and
`.source_anchor`) from a `MapGuidedFrontEnd` LedgerDoc.

This is the map_guided sibling of `legacy_adapter._derive_tb`, kept in
its own module so `map_guided.py` (the mechanical parse lane) stays
100% jurisdiction-blind: the LEGACY 10-key row shape (si/r/st/sf) and
the anchor machinery ARE the RO legacy vocabulary, so this bridge —
exactly like `legacy_adapter.py` — reaches the real
`compute_source_anchor` / `TrialBalanceParseResult` seams in the RO
country pack, and the pack-level enrichment (`attach_closing_result`,
`accounts_to_assemble_shape`) through `get_pack(doc.header.
jurisdiction)` — jurisdiction from DATA, never a literal.

The C1 consensus seed: `derive_map_guided_legacy(doc).tb_rows` must be
row-by-row byte-comparable against the classic parser's output on a
file both lanes can read (proven on agras by
tests/engine/test_map_guided.py). To that end this derivation mirrors
the classic float expressions exactly:

  * slot floats via `money_to_float` (the exact inverse of the
    front-end's repr-based Money construction);
  * exact-repr overrides restore floats Money could not hold;
  * st_d/st_c (the legacy collapsed "cumulative" slot) come from the
    map's DISTINCT cumulative side-channels — `total_with_opening`
    preferred when both are present, because that is the semantic the
    legacy `rc` slot has always meant on true Sume-totale files; a
    movement-cumulative pair lands in the same legacy slot because
    that is where the CLASSIC parser (mis)files it today (the
    documented enum-conflation) and the bridge's job is byte-parity,
    not correction — the distinct semantics stay available to
    consensus via the IR side-channels;
  * absent closing pair -> the classic Layout-B synthesis, verbatim:
    net = (si_d + r_d) - (si_c + r_c), landed on the natural side.
"""
from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional

from engine.ir import LedgerDoc

from .map_guided import (
    LEGACY_SHAPE_MAP_GUIDED,
    META_MOVEMENT_CUMULATIVE_FILE_TOTALS,
    META_MOVEMENT_CUMULATIVE_PAIR,
    META_TOTAL_WITH_OPENING_FILE_TOTALS,
    META_TOTAL_WITH_OPENING_PAIR,
    META_TOTALS_OVERRIDES,
)
from .saga10 import (
    LEGACY_SLOT_FIELDS,
    META_EXTRACTION,
    META_LEGACY_SHAPE,
    META_OVERRIDES,
    META_PAIRS_PRESENT,
    META_SYNTHESIZED_SF,
    META_TOTALS_ROW_INDEX,
    FrontEndError,
    money_to_float,
)


__all__ = ["derive_map_guided_legacy"]


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {k: _thaw(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_thaw(v) for v in value]
    return value


def derive_map_guided_legacy(doc: LedgerDoc) -> Any:
    """map_guided LedgerDoc -> `legacy_adapter.LegacyTbView` (real
    TrialBalanceParseResult with .extraction/.source_anchor enriched by
    the real pack seams — never mirrors)."""
    from engine.country_packs.ro_romania.trial_balance_parser import (  # noqa: PLC0415
        TrialBalanceParseResult,
        compute_source_anchor,
    )
    from . import legacy_adapter  # deferred: legacy_adapter imports this module

    meta = doc.header.source_meta
    if meta.get(META_LEGACY_SHAPE) != LEGACY_SHAPE_MAP_GUIDED:
        raise FrontEndError(
            "derive_map_guided_legacy takes a map_guided doc, got legacy_shape %r"
            % (meta.get(META_LEGACY_SHAPE),)
        )

    extraction: Dict[str, Any] = _thaw(meta.get(META_EXTRACTION) or {})
    pairs_present: Optional[Dict[str, bool]] = _thaw(meta.get(META_PAIRS_PRESENT))
    totals_row_index: Optional[int] = meta.get(META_TOTALS_ROW_INDEX)
    synthesized_sf: bool = bool(meta.get(META_SYNTHESIZED_SF))
    overrides: Dict[str, Any] = _thaw(meta.get(META_OVERRIDES) or {})
    two_pair: Dict[str, Any] = _thaw(meta.get(META_TOTAL_WITH_OPENING_PAIR) or {})
    mc_pair: Dict[str, Any] = _thaw(meta.get(META_MOVEMENT_CUMULATIVE_PAIR) or {})

    rows: List[Dict[str, Any]] = []
    for atom in doc.atoms:
        row: Dict[str, Any] = {
            "cont": atom.account_code,
            "nume_cont": atom.label,
        }
        for legacy_field, slot in LEGACY_SLOT_FIELDS:
            money = getattr(atom, slot)
            row[legacy_field] = 0.0 if money is None else money_to_float(money)

        # Legacy collapsed cumulative slot — total_with_opening wins
        # when both semantics are mapped (see module docstring).
        cum = two_pair.get(atom.atom_id) or mc_pair.get(atom.atom_id)
        row["st_d"] = float(cum[0]) if cum else 0.0
        row["st_c"] = float(cum[1]) if cum else 0.0

        for legacy_field, exact_repr in (overrides.get(atom.atom_id) or {}).items():
            row[legacy_field] = float(exact_repr)

        if synthesized_sf:
            # The classic Layout-B synthesis, verbatim (identical float
            # expression + operand order — bit-relevant).
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

    # Pack-level enrichment through DATA-carried jurisdiction — the same
    # real seams stage_extract runs. A jurisdiction with no registered
    # pack simply skips the enrichment (the carrier stays valid).
    assemble_shape: Any = None
    try:
        from engine.core.country_pack_registry import get_pack
        pack = get_pack(doc.header.jurisdiction)
    except Exception:  # noqa: BLE001 — no pack for this jurisdiction
        pack = None
    if pack is not None:
        pack.attach_closing_result(tb)
        assemble_shape = pack.accounts_to_assemble_shape(tb)

    return legacy_adapter.LegacyTbView(
        tb_rows=tb,
        assemble_shape=assemble_shape,
        anchor_inputs=anchor_inputs,
    )


def _reconstruct_file_totals(
    doc: LedgerDoc, totals_row_index: Optional[int]
) -> Optional[Dict[str, Optional[float]]]:
    """Rebuild the `compute_source_anchor` file_totals dict (semantic
    column names) from the verbatim document_totals + the cumulative
    file-totals side-channels. None when no totals row; only present
    values are emitted (ABSENT stays absent). Totals repr overrides
    restore exact floats Money could not hold."""
    if totals_row_index is None:
        return None
    out: Dict[str, Optional[float]] = {}
    totals = doc.header.document_totals
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
    totals_overrides: Dict[str, str] = _thaw(
        doc.header.source_meta.get(META_TOTALS_OVERRIDES) or {}
    )
    for slot, semantic in (
        ("opening_debit", "initial_debit"),
        ("opening_credit", "initial_credit"),
        ("period_debit", "period_debit"),
        ("period_credit", "period_credit"),
        ("closing_debit", "final_debit"),
        ("closing_credit", "final_credit"),
    ):
        if slot in totals_overrides:
            out[semantic] = float(totals_overrides[slot])
    # Whichever cumulative semantic(s) the map carried feed the legacy
    # collapsed cumulative file totals — total_with_opening wins when
    # both exist (mirror of the per-row rule).
    for ft_key in (META_TOTAL_WITH_OPENING_FILE_TOTALS,
                   META_MOVEMENT_CUMULATIVE_FILE_TOTALS):
        entry = _thaw(doc.header.source_meta.get(ft_key) or {})
        if not entry:
            continue
        if entry.get("debit") is not None:
            out.setdefault("cumulative_debit", float(entry["debit"]))
        if entry.get("credit") is not None:
            out.setdefault("cumulative_credit", float(entry["credit"]))
    return out
