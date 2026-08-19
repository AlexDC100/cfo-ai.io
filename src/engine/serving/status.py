"""STATUS PRESENTER — the ONE wording authority for balance-sheet status.

``present_status(served_cbs, surface)`` maps the machine status of a
SERVED canonical_bs (BALANCED | RECONCILED | MINOR_DRIFT |
MATERIAL_IMBALANCE) to its presentation object. ALL wording — the FE
chip, the HTML report footer, the Excel export, and the API's
``status_presentation`` stamp — derives from this function; no surface
invents its own status copy.

Locked invariant (sv1, encoded in tests/engine/test_facts_gateway.py):
machine ``RECONCILED`` NEVER maps to any 'balanced'-family display
string, in any language, on any surface. RECONCILED is a distinct,
honestly-labeled state — the adjustment is disclosed via the
``micro_caption`` ("auto-adjusted {X}"), never hidden behind a
"Balanced" label. Machine truth (API, exports) stays ``RECONCILED``.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

#: The four machine statuses of the served ladder. RECONCILED is the
#: explicitly-entered fourth state (contract: RECONCILED ≠ BALANCED).
MACHINE_STATUSES = ("BALANCED", "RECONCILED", "MINOR_DRIFT", "MATERIAL_IMBALANCE")

#: Surfaces the presenter serves. One wording authority: today every
#: surface receives identical copy; the parameter exists so a future
#: surface-specific divergence still flows through THIS function.
SURFACES = ("chip", "html", "excel", "api")

# machine -> (display_key, display_en, display_ro). Note: none of the
# RECONCILED strings may ever contain a 'balanced'-family word
# ("balanc*" / "echilibr*") — see the I4 unit test.
_DISPLAY = {
    "BALANCED": ("bs.status.balanced", "Balanced", "Echilibrat"),
    "RECONCILED": ("bs.status.reconciled", "Reconciled", "Reconciliat"),
    "MINOR_DRIFT": ("bs.status.minor_drift", "Minor drift", "Abatere minoră"),
    "MATERIAL_IMBALANCE": (
        "bs.status.material_imbalance",
        "Material imbalance",
        "Dezechilibru semnificativ",
    ),
}


def _fmt_amount(value: Any) -> str:
    try:
        return "{:,.2f}".format(abs(float(value or 0)))
    except (TypeError, ValueError):
        return "0.00"


def present_status(served_cbs: Any, surface: str = "api") -> Dict[str, Optional[str]]:
    """The presentation object for one SERVED canonical_bs.

    Returns ``{machine, display_key, display_en, display_ro,
    micro_caption}`` — deterministic (serving purity: the same served
    object always yields the same presentation).

    micro_caption:
      · RECONCILED   → "auto-adjusted {applied delta}" from the served
        reconciliation receipt (the calm disclosure the chip renders;
        tap-through reveals the full receipt + Undo);
      · MINOR_DRIFT with the auto-stage needs_review boolean stamped
        True → "needs review";
      · otherwise None.
    """
    if surface not in SURFACES:
        surface = "api"
    cbs = served_cbs if isinstance(served_cbs, dict) else {}
    machine = str(cbs.get("status") or "")
    display = _DISPLAY.get(machine)
    if display is None:
        # Defensive: present the raw machine string honestly rather
        # than inventing a band. Schema-valid servings never hit this.
        return {
            "machine": machine or "UNKNOWN",
            "display_key": "bs.status.unknown",
            "display_en": machine or "Unknown",
            "display_ro": machine or "Necunoscut",
            "micro_caption": None,
        }

    micro_caption: Optional[str] = None
    if machine == "RECONCILED":
        receipt = cbs.get("reconciliation")
        delta = receipt.get("applied_delta") if isinstance(receipt, dict) else None
        micro_caption = "auto-adjusted %s" % _fmt_amount(delta)
    elif machine == "MINOR_DRIFT" and cbs.get("needs_review") is True:
        micro_caption = "needs review"

    display_key, display_en, display_ro = display
    return {
        "machine": machine,
        "display_key": display_key,
        "display_en": display_en,
        "display_ro": display_ro,
        "micro_caption": micro_caption,
    }
