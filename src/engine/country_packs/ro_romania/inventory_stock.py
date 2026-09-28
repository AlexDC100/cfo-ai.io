"""STOCK EVIDENCE — the class-3 balances at 1 January and 31 December,
measured from the trial balance's own rows at PERSIST time.

WHY IT IS PERSISTED. Inventory days are measured on the AVERAGE stock
(owner spec 2026-09-26, P1 point 2: "(opening + closing) ÷ 2 and say so"),
and every balanță this engine reads in its 10-column / 8-column / 6-column
layouts carries the 1 January balance in its ``si`` columns (on the
owner's own FY2025 book the opening equals the FY2024 file's closing to
the cent). The served period is rebuilt from ``statement_line_items``,
which persist ONE amount per account — the closing balance — so the opening
is lost after the write unless it is stored. This block (schema
``inventory_stock/1``) is stored on the period envelope
(``assembled_canonical_v1.inventory_stock``) beside the stock-variation
evidence, and ``engine.ratios.inventory_days`` reads it back.

WHEN THE ``si`` COLUMN IS THE FISCAL-YEAR OPENING. Only then is
(opening + closing) ÷ 2 the average of the year's two year-end points:

  * the format carried no ``si`` block (a 4-column generic layout, the
    model's extraction) → ``si_column_absent``. The row shape fills an
    absent ``si`` with 0.0; that zero is ABSENT, never a zero stock.
  * the movement convention (``engine.passes.movements``) is ``B``
    ("Total sume" includes the opening) or ``C`` ("Rulaj cumulat"
    excludes it) → the cumulative block runs from the ``si`` date, which
    is the start of the fiscal year: available.
  * convention ``A`` (``si`` + the period movement = closing) holds on an
    annual file AND on a monthly file whose ``si`` is the month opening —
    the file cannot say which → ``si_date_undetermined``.
  * ``B`` winning only by an exact TIE with ``A`` (a 4-pair export whose
    ``st`` = ``si`` + the period movement: every annual 4-pair file, and a
    single-month file whose ``si`` is the month opening, alike) → the
    opening is the fiscal-year opening only when the file proves it: the
    class 6/7 ``si`` columns are all zero (profit-and-loss accounts open
    every fiscal year at zero, never a month). Otherwise — a non-zero
    class 6/7 ``si``, or no class 6/7 rows to read — ``si_date_undetermined``.
  * ``mixed`` / ``insufficient`` → ``si_convention_undecided``.

Pure: no I/O, no clock. Rows are read in CODE order, so the block is a
function of the book (row permutation is a metamorphic invariant of the
whole envelope). Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

__all__ = [
    "SCHEMA",
    "OPENING_AVAILABLE",
    "OPENING_ABSENT",
    "REASON_SI_ABSENT",
    "REASON_SI_UNKNOWN",
    "REASON_SI_DATE",
    "REASON_SI_CONVENTION",
    "REASON_NO_ROWS",
    "measure",
    "absent_evidence",
    "is_measured",
    "is_no_rows_marker",
    "holds_no_rows",
    "attach_to_envelope",
]

#: Bump on any change to what the block records.
SCHEMA = "inventory_stock/1"

OPENING_AVAILABLE = "available"
OPENING_ABSENT = "absent"

REASON_SI_ABSENT = "si_column_absent"
REASON_SI_UNKNOWN = "si_column_unknown"
REASON_SI_DATE = "si_date_undetermined"
REASON_SI_CONVENTION = "si_convention_undecided"
#: The period's rows never reached this measurement (an extraction path
#: that holds no trial-balance columns, a statutory return).
REASON_NO_ROWS = "trial_balance_rows_unavailable"

#: Conventions under which the ``si`` block is the fiscal-year opening.
_FISCAL_YEAR_OPENING_CONVENTIONS = ("B", "C")

_FIGURES = ("si_d", "si_c", "st_d", "st_c", "sf_d", "sf_c")


def _f(value: Any) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _si_present(source_anchor: Any) -> Optional[bool]:
    """True/False from ``source_anchor.pairs.si`` (None pair = the format
    lacks the block); None when no anchor was handed over."""
    if not isinstance(source_anchor, Mapping):
        return None
    pairs = source_anchor.get("pairs")
    if not isinstance(pairs, Mapping) or "si" not in pairs:
        return None
    return pairs.get("si") is not None


def _ties_with_a(winner: Optional[str], rates: Any) -> bool:
    """True when identity ``A`` (``si`` + the period movement = closing)
    matched at the winner's exact rate — the probe then reported B/C only by
    its fixed tie preference, and the file has not said its ``si`` is the
    fiscal-year opening."""
    if winner not in _FISCAL_YEAR_OPENING_CONVENTIONS or not isinstance(rates, Mapping):
        return False
    a, w = rates.get("A"), rates.get(winner)
    if not isinstance(a, Mapping) or not isinstance(w, Mapping):
        return False
    if not a.get("testable") or a.get("by_construction"):
        return False
    return a.get("rate") is not None and a.get("rate") == w.get("rate")


def _pl_opening_zero(rows: List[Mapping[str, Any]]) -> Optional[bool]:
    """Whether every class 6/7 row's ``si`` is zero (True), some is not
    (False), or the file carries no class 6/7 row to read (None). A
    fiscal-year opening has every profit-and-loss account at zero; a month
    opening carries the year-to-date."""
    pl = [r for r in rows
          if str(r.get("cont") or "").strip()[:1] in ("6", "7")]
    if not pl:
        return None
    return all(_f(r.get("si_d")) == 0.0 and _f(r.get("si_c")) == 0.0 for r in pl)


def _convention(rows: List[Mapping[str, Any]], si_present: Optional[bool],
                source_anchor: Any) -> Tuple[Optional[str], bool]:
    from engine.passes.movements import compute_movement_checks

    pairs_present = None
    if isinstance(source_anchor, Mapping) and isinstance(source_anchor.get("pairs"), Mapping):
        pairs_present = {k: v is not None for k, v in source_anchor["pairs"].items()}
    synthesized = False
    if isinstance(source_anchor, Mapping):
        sf = (source_anchor.get("pairs") or {}).get("sf")
        synthesized = bool(isinstance(sf, Mapping) and sf.get("synthesized_from_identity"))
    result = compute_movement_checks(
        rows, pairs_present,
        layout_hint={"synthesized_sf": True} if synthesized else None)
    conv = result.get("convention") if isinstance(result, Mapping) else None
    winner = conv.get("winner") if isinstance(conv, Mapping) else None
    winner = winner if isinstance(winner, str) else None
    rates = conv.get("rates") if isinstance(conv, Mapping) else None
    return winner, _ties_with_a(winner, rates)


def absent_evidence(reason: str) -> Dict[str, Any]:
    """The marker a path with no trial-balance rows carries. ``is_measured``
    is False, so the served block falls back to the closing snapshot with
    this reason for the absent opening. Stored only for ``REASON_NO_ROWS``
    (``attach_to_envelope``): a period whose source holds no rows says so
    on every rebuild, instead of "recomputed when reprocessed" — which a
    reprocess of that source can never do."""
    return {"schema": SCHEMA, "measured": False,
            "opening": {"status": OPENING_ABSENT, "reason": reason, "convention": None},
            "accounts": []}


def is_measured(block: Any) -> bool:
    return (isinstance(block, Mapping) and block.get("schema") == SCHEMA
            and block.get("measured") is True)


def is_no_rows_marker(block: Any) -> bool:
    """The stored absence of a path that holds no trial-balance rows."""
    return (isinstance(block, Mapping) and block.get("schema") == SCHEMA
            and block.get("measured") is False
            and isinstance(block.get("opening"), Mapping)
            and block["opening"].get("reason") == REASON_NO_ROWS)


def holds_no_rows(extraction: Any) -> bool:
    """True when the extraction provenance (``parsed["extraction"]`` /
    ``canonical_bs.extraction``) names a path that holds no trial-balance
    columns: the model's extraction (``method: llm``) or a filed statutory
    return (``source_format: statutory_f30_f10``). Reprocessing such a
    source never measures an opening."""
    if not isinstance(extraction, Mapping):
        return False
    return (str(extraction.get("method") or "") == "llm"
            or str(extraction.get("source_format") or "") == "statutory_f30_f10")


def measure(tb_rows: Iterable[Mapping[str, Any]],
            source_anchor: Any = None) -> Dict[str, Any]:
    """The evidence block from parsed rows. PURE.

    ``accounts`` lists every class-3 row the assembler reads (leaves and
    distinct accounts — ``stock_variation.row_reading``; an aggregate row's
    figures are already in its leaves), in code order, with its signed
    balances: opening = si_d − si_c (None when the opening is not the
    fiscal-year opening), closing = sf_d − sf_c. Amounts to the cent."""
    from .stock_variation import row_reading

    rows = sorted(
        (r for r in tb_rows if isinstance(r, Mapping)),
        key=lambda r: (str(r.get("cont") or "").strip(),)
        + tuple(_f(r.get(f)) for f in _FIGURES),
    )
    si_present = _si_present(source_anchor)
    if si_present is False:
        status, reason, conv = OPENING_ABSENT, REASON_SI_ABSENT, None
    elif si_present is None:
        status, reason, conv = OPENING_ABSENT, REASON_SI_UNKNOWN, None
    else:
        conv, tied_with_a = _convention(rows, si_present, source_anchor)
        if conv in _FISCAL_YEAR_OPENING_CONVENTIONS and tied_with_a and _pl_opening_zero(rows) is not True:
            # B/C only by the tie preference, and nothing in the file dates
            # the ``si`` at 1 January: never the average of "1 January and
            # the period end" over what may be a month opening.
            status, reason = OPENING_ABSENT, REASON_SI_DATE
        elif conv in _FISCAL_YEAR_OPENING_CONVENTIONS:
            status, reason = OPENING_AVAILABLE, None
        elif conv == "A":
            status, reason = OPENING_ABSENT, REASON_SI_DATE
        else:
            status, reason = OPENING_ABSENT, REASON_SI_CONVENTION
    available = status == OPENING_AVAILABLE

    reading = row_reading(rows)
    accounts: List[Dict[str, Any]] = []
    for r, kind in zip(rows, reading):
        if kind == "aggregate":
            continue
        code = str(r.get("cont") or "").strip()
        digits = code.replace(".", "").replace(" ", "").replace("'", "").replace("-", "")
        if not digits.startswith("3"):
            continue
        accounts.append({
            "code": code,
            "opening": round(_f(r.get("si_d")) - _f(r.get("si_c")), 2) if available else None,
            "closing": round(_f(r.get("sf_d")) - _f(r.get("sf_c")), 2),
        })
    return {
        "schema": SCHEMA,
        "measured": True,
        "opening": {"status": status, "reason": reason, "convention": conv},
        "accounts": accounts,
    }


def attach_to_envelope(assembled: Any, evidence: Any) -> None:
    """Store a MEASURED block on the assembled envelope
    (``assembled_canonical_v1.inventory_stock``), or the no-rows marker of
    a path that holds no trial-balance columns — never any other absence
    marker, so a period written without evidence keeps saying so on every
    rebuild. ONE code object for the pipeline's write seam (``stage_map``)
    and the offline seam (``RomaniaPack.assemble_parsed_tb``)."""
    canonical = assembled.get("assembled_canonical_v1") if isinstance(assembled, dict) else None
    if isinstance(canonical, dict) and (is_measured(evidence) or is_no_rows_marker(evidence)):
        canonical["inventory_stock"] = dict(evidence)
