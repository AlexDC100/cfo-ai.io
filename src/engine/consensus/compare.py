"""ATOM-BY-ATOM COMPARATOR over two readings of the same document.

Both readings arrive as lists of the canonical 10-key row dicts
(``cont`` / ``nume_cont`` + the four D/C column pairs). The comparator:

  · converts every value to INTEGER CENTS (floats only at the edges —
    the shadow.py discipline, re-implemented minimally, never imported);
  · prunes zero atoms — a (row, field) where BOTH sides read 0 carries
    no comparison signal (the legacy lanes drop value-free rows for the
    same reason);
  · REFUSES to compare misaligned readings: a row-count difference or an
    account-code mismatch at any index yields ``structural.aligned ==
    False`` with ``atoms_compared == 0`` — a faithful comparison could
    not be set up, which is a structural failure, not a disagreement.

Jurisdiction-blind: field names are the engine's canonical legacy row
shape (``tb_rows_v10``); no account-code semantics live here.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

#: The eight money fields of the canonical 10-key row shape.
MONEY_FIELDS = ("si_d", "si_c", "r_d", "r_c", "st_d", "st_c", "sf_d", "sf_c")


def cents(value: Any) -> int:
    """Currency value → integer cents (garbage coerces to 0 — both
    lanes pass through the same coercion, so the comparison stays
    symmetric)."""
    try:
        return int(round(float(value or 0) * 100))
    except (TypeError, ValueError):
        return 0


def _code(row: Any) -> str:
    if not isinstance(row, dict):
        return ""
    return str(row.get("cont") or "").strip()


def _name(row: Any) -> str:
    if not isinstance(row, dict):
        return ""
    return str(row.get("nume_cont") or "").strip()


def compare_readings(
    rows_a: List[Dict[str, Any]],
    rows_b: List[Dict[str, Any]],
    *,
    source_refs: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Compare reading A against reading B atom by atom.

    ``source_refs`` (optional) supplies grid coordinates for the A-side
    reading: ``{"sheet": str|None, "rows": [grid_row_idx per row],
    "cols": {field: grid_col_idx}}`` — each disagreement then carries a
    ``source_ref`` of ``{"sheet", "row", "col"}`` (or None).

    Returns the comparison core:
      {consensus_pct, atoms_compared, disagreements: [{code, name,
       field, classic_cents, mapped_cents, source_ref}], structural:
       {row_count_a, row_count_b, aligned}}

    Key-name note: ``classic_cents`` is ALWAYS side A (the reading that
    would be served), ``mapped_cents`` side B — on the C1 lane A is the
    classic parser, on the C2 dual-map lane A is framing A.
    """
    n_a = len(rows_a or [])
    n_b = len(rows_b or [])
    structural: Dict[str, Any] = {
        "row_count_a": n_a,
        "row_count_b": n_b,
        "aligned": n_a == n_b,
    }
    if structural["aligned"]:
        for row_a, row_b in zip(rows_a, rows_b):
            if _code(row_a) != _code(row_b):
                structural["aligned"] = False
                break
    if not structural["aligned"]:
        # Refusal: a faithful atom comparison cannot be set up.
        return {
            "consensus_pct": 0.0,
            "atoms_compared": 0,
            "disagreements": [],
            "structural": structural,
        }

    ref_sheet = None
    ref_rows: List[Any] = []
    ref_cols: Dict[str, Any] = {}
    if isinstance(source_refs, dict):
        ref_sheet = source_refs.get("sheet")
        ref_rows = list(source_refs.get("rows") or [])
        ref_cols = dict(source_refs.get("cols") or {})

    atoms_compared = 0
    agreed = 0
    disagreements: List[Dict[str, Any]] = []
    for i, (row_a, row_b) in enumerate(zip(rows_a, rows_b)):
        for field in MONEY_FIELDS:
            a_c = cents(row_a.get(field))
            b_c = cents(row_b.get(field))
            if a_c == 0 and b_c == 0:
                continue  # zero-pruned: no signal
            atoms_compared += 1
            if a_c == b_c:
                agreed += 1
                continue
            source_ref = None
            grid_row = ref_rows[i] if i < len(ref_rows) else None
            grid_col = ref_cols.get(field)
            if grid_row is not None and grid_col is not None:
                source_ref = {"sheet": ref_sheet, "row": grid_row, "col": grid_col}
            disagreements.append({
                "code": _code(row_a),
                "name": _name(row_a) or _name(row_b),
                "field": field,
                "classic_cents": a_c,
                "mapped_cents": b_c,
                "source_ref": source_ref,
            })

    if atoms_compared:
        consensus_pct = round(agreed * 100.0 / atoms_compared, 4)
    else:
        # Aligned readings with zero value-bearing atoms: vacuous but
        # honest agreement (an all-zero document carries nothing to
        # disagree about).
        consensus_pct = 100.0
    return {
        "consensus_pct": consensus_pct,
        "atoms_compared": atoms_compared,
        "disagreements": disagreements,
        "structural": structural,
    }
