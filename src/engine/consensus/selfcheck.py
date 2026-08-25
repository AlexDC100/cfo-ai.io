"""SELF-CHECK LEGS — deriving the totals third leg from a source_anchor
block and running the layout-conditional movement identity, both in
INTEGER CENTS over the canonical 10-key rows.

Totals leg: the anchor block itself is produced by the REAL
``compute_source_anchor`` seam (reached through the map_guided legacy
bridge — never mirrored here); this module only DERIVES the leg verdict
from it. When the file carries no totals row (``NO_ANCHOR``) the leg
degrades EXPLICITLY: the extracted closing pair's own D/C balance
stands in, mirroring the canonical builder's identity-premise
convention (canonical_adapter's ``extracted_sf_balanced``). DIVERGED
always fails the leg.

Movement leg: the per-row column-pair identity whose FORM depends on
what the cumulative pair MEANS — the discriminator the StructuralMap
carries as data (the "Total sume" vs "Rulaj cumulat" split the classic
column patterns conflate):

  cumulative_with_opening   sf_signed == st_signed
  cumulative_movements      sf_signed == si_signed + st_signed

No cumulative pair, unknown semantics, or a synthesized closing pair
(checking a synthesized value against its own inputs is circular) →
``None`` — the movement input to the E9 verdict is bool-or-None and
None fails closed there.

Jurisdiction-blind: pure arithmetic over the row shape; the pair
semantics arrive as StructuralMap/front-end data, never from account
codes.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .compare import cents

#: Source D/C balance tolerance, in cents (classic parser: 1.0 unit).
SOURCE_BALANCE_TOLERANCE_CENTS = 100

#: Cumulative-pair semantics vocabulary (StructuralMap-derived data).
CUMULATIVE_WITH_OPENING = "cumulative_with_opening"
CUMULATIVE_MOVEMENTS = "cumulative_movements"


def extracted_closing_balanced(rows: List[Dict[str, Any]]) -> bool:
    """The NO_ANCHOR stand-in: does the extracted closing (SF) pair
    balance D vs C within the source tolerance?"""
    ext_d = sum(cents(r.get("sf_d")) for r in rows if isinstance(r, dict))
    ext_c = sum(cents(r.get("sf_c")) for r in rows if isinstance(r, dict))
    return abs(ext_d - ext_c) <= SOURCE_BALANCE_TOLERANCE_CENTS


def totals_leg_from_anchor(
    anchor: Any, rows: List[Dict[str, Any]]
) -> Tuple[str, bool]:
    """(totals_match, leg_pass) from a source_anchor block.

      MATCHED   → pass (extracted sums equal the file's own totals row)
      DIVERGED  → fail (the mechanical read does not reproduce the file)
      NO_ANCHOR → pass ONLY when the extracted closing pair balances —
                  the explicit degradation for totals-row-less files.
    """
    status = ""
    if isinstance(anchor, dict):
        status = str(anchor.get("anchor_status") or "")
    if not status:
        status = "NO_ANCHOR"
    if status == "MATCHED":
        return status, True
    if status == "NO_ANCHOR":
        return status, extracted_closing_balanced(rows)
    return status, False


def movement_leg(
    rows: List[Dict[str, Any]],
    *,
    cumulative_semantics: Optional[str],
    synthesized_sf: bool = False,
) -> Optional[bool]:
    """Per-row movement identity, layout-conditional on the cumulative
    pair's declared semantics. True/False when checkable, None when not."""
    if synthesized_sf:
        return None
    if cumulative_semantics not in (CUMULATIVE_WITH_OPENING, CUMULATIVE_MOVEMENTS):
        return None
    needs_si = cumulative_semantics == CUMULATIVE_MOVEMENTS
    checked = False
    for r in rows:
        if not isinstance(r, dict):
            continue
        st_signed = cents(r.get("st_d")) - cents(r.get("st_c"))
        sf_signed = cents(r.get("sf_d")) - cents(r.get("sf_c"))
        if needs_si:
            expected = (cents(r.get("si_d")) - cents(r.get("si_c"))) + st_signed
        else:
            expected = st_signed
        checked = True
        if sf_signed != expected:
            return False
    return True if checked else None
