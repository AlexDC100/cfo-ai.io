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
    object always yields the same presentation). When the served object
    carries an ELIGIBLE consensus block (three green E9 legs) an
    additive ``trust_disclosure`` key is included (see
    ``_trust_disclosure`` below); absent everywhere else, so pre-existing
    servings and goldens are byte-identical.

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
    out: Dict[str, Optional[str]] = {
        "machine": machine,
        "display_key": display_key,
        "display_en": display_en,
        "display_ro": display_ro,
        "micro_caption": micro_caption,
    }
    trust = _trust_disclosure(cbs)
    if trust is not None:
        # ADDITIVE key — emitted ONLY when the served object carries an
        # ELIGIBLE consensus block (three green legs), so every existing
        # serving (and every corpus golden) is byte-identical without it.
        out["trust_disclosure"] = trust  # type: ignore[assignment]
    return out


# extraction.method -> (key, en, ro) — emitted only with an eligible
# (three-green-leg) consensus block alongside. The llm method stays
# undisclosed here on purpose: its existing "AI-read" badge is the
# honest surface, and consensus never upgrades an llm read.
_TRUST_DISCLOSURE = {
    "deterministic": {
        "key": "bs.trust.machine_ai_verified_full",
        "en": "Machine-computed · AI-verified (full)",
        "ro": "Calculat de mașină · verificat de AI (complet)",
    },
    "mechanical_mapped": {
        "key": "bs.trust.structure_ai_dual_verified",
        "en": "Structure AI-interpreted · numbers machine-read · dual-verified",
        "ro": "Structură interpretată de AI · cifre citite mecanic · dublu verificat",
    },
}


def _trust_disclosure(cbs: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """The consensus trust line for one served canonical_bs, or None.

    Requires BOTH an eligible consensus block (the three-leg verdict,
    read fail-closed through engine.consensus.verdict — the one E9
    predicate) and a disclosed extraction method. Deterministic (pure
    function of the served object; no I/O)."""
    consensus = cbs.get("consensus")
    if not isinstance(consensus, dict):
        return None
    try:
        from engine.consensus.verdict import eligible_from_block
        if not eligible_from_block(consensus):
            return None
    except Exception:  # noqa: BLE001 — fail closed: no disclosure
        return None
    method = str((cbs.get("extraction") or {}).get("method") or "")
    entry = _TRUST_DISCLOSURE.get(method)
    return dict(entry) if entry else None
