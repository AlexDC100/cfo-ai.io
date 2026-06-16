"""F3.16-3b.6 — ebitda_for_surface routing helper.

Why this module exists
----------------------
The 3b.6 consumer cutover routes 9 UI surfaces (KPI tile, P&L tab,
briefing headline + body, recommendations, risks & credit, valuation,
export PDF summary + detail) from in-code legacy EBITDA fields
(`assembled_pl.ebitda_statutory` and friends) to the canonical
methodology fields (`methodology.ebitda.reported` / `strict` / `cash`
/ `adjusted`).

This module is the **shared routing helper** the per-surface
migrations use. Per the F3.16-3b.6 plan §2, each surface calls
`ebitda_for_surface(period, variant=...)` with the variant that
surface owns (`reported` for headline tiles; `adjusted` for
valuation; etc.), and the helper returns the canonical value when
available, falling back to legacy in-code fields during the
deprecation window (F4.0 §3e parallel-emission discipline).

Scaffolding scope (this session)
--------------------------------
This module ships WITHOUT any callers — it is scaffolding for the
[F3.16-3b6-CONSUMER-CUTOVER] follow-up ticket (filed in
docs/SAGA-CALIBRATION-2026Q2.md §9 on 2026-05-26). The cutover
work routes per-surface FE consumers through this helper, behind
feature flags, across 2-3 follow-up sessions.

Shipping the helper as scaffolding now means:
  · Consumer-cutover sessions can adopt this module incrementally
    without first having to design the helper API.
  · The smoke test below proves the routing logic works on a
    real period dict before any consumer trusts it.

Deprecation window
------------------
F4.0 §3e mandates parallel emission for one quarter (cutover
horizon: 2026-11-23 per F4.7-stage). During the window:

  1. BOTH `assembled_pl.ebitda_statutory` AND
     `methodology.ebitda.reported` are written by every pipeline run.
  2. The F4.2-PARITY gate proves they are byte-identical (±1 RON)
     for the reported + strict variants — locked HARD this session.
  3. Cash variant stays soft-only with TODO pointing at
     [F3.16-3b6-FOLLOWUP-CASH-PARITY].
  4. This helper's legacy fallback branch logs to
     `deprecated_fields` so the FE can surface a telemetry warning
     (internal only — not user-visible).
  5. Removal happens in F4.7 (2026-11-23): the legacy fields get
     deleted from pipeline output, the fallback branch is removed,
     any remaining caller of the legacy field surfaces a KeyError.

Usage (in a future per-surface migration)
-----------------------------------------

    from engine.api._ebitda_routing import ebitda_for_surface

    @app.get("/api/period/{period_id}/kpi_tile")
    def get_kpi_tile(period_id: str):
        period = _load_period(period_id)
        return {
            "ebitda": ebitda_for_surface(period, variant="reported"),
            "methodology_version": _methodology_version_of(period),
            "deprecated_fields": period.get("deprecated_fields", []),
        }

`deprecated_fields` is a list of legacy-source markers (e.g.
`"legacy_ebitda:reported"`) telemetry-logged so the migration
status of every consumer is visible without instrumenting each
one individually.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

# Legacy in-code fields per F4.0 §3e parallel emission. The mapping
# is intentionally explicit (not derived from variant names) so a
# future variant addition forces a deliberate decision about which
# legacy field — if any — to fall back to.
_LEGACY_FIELD_MAP: Dict[str, str] = {
    "reported": "ebitda_statutory",
    "strict":   "adjusted_ebitda",
    # cash: NO byte-identical legacy field exists today. The in-code
    # `ebitda_cash` diverges 100-1571% from `methodology.ebitda.cash`
    # — see [F3.16-3b6-FOLLOWUP-CASH-PARITY]. Falling back to the
    # in-code field would produce a different number than the
    # canonical envelope. Until the follow-up ticket reconciles
    # them, cash-variant consumers either accept canonical-or-none
    # OR explicitly call `ebitda_for_surface(..., variant="cash",
    # allow_legacy_cash=True)` knowing the legacy fallback is a
    # different number.
    "cash":     "ebitda_cash",
    # adjusted: same in-code field as strict today. Per the
    # follow-up ticket, the YAML adjusted formula may diverge once
    # it's computed; consumers should treat adjusted as canonical-
    # preferred and surface a warning if falling back.
    "adjusted": "adjusted_ebitda",
}

_VALID_VARIANTS = frozenset(_LEGACY_FIELD_MAP.keys())


def ebitda_for_surface(
    period: Dict[str, Any],
    *,
    variant: str = "reported",
    allow_legacy_cash: bool = False,
) -> Optional[float]:
    """Return the EBITDA value for the requested variant, preferring
    the canonical methodology field and falling back to the in-code
    legacy field during the F4.0 §3e parallel-emission window.

    Args:
        period: A period dict in the canonical shape (must contain
                `assembled_canonical_v1.methodology.ebitda` if
                canonical; falls back to `statements.assembled_pl`
                otherwise).
        variant: One of `"reported"`, `"strict"`, `"cash"`,
                `"adjusted"`. Defaults to `"reported"` — the
                statutory value that ties to the filed P&L.
        allow_legacy_cash: When `variant="cash"` and the canonical
                field is missing, this flag must be `True` to
                permit the legacy fallback (because the legacy
                `ebitda_cash` diverges 100-1571% from the canonical
                cash variant — see follow-up ticket above). For all
                other variants, the fallback is unconditional during
                the deprecation window.

    Returns:
        The EBITDA value as a float. Returns `None` ONLY when:
          · the requested variant is `"cash"`, `allow_legacy_cash`
            is False, and the canonical field is missing — this is
            the "canonical-or-none" mode the cash-variant
            consumers should use until the follow-up ticket ships.

    Side effects:
        On legacy fallback, appends a deprecation marker string
        like `"legacy_ebitda:reported"` to `period["deprecated_fields"]`
        (creates the list if absent). The FE consumer surfaces these
        markers via internal telemetry, not user-visible UI.

    Raises:
        ValueError: if `variant` is not in `_VALID_VARIANTS`.
    """
    if variant not in _VALID_VARIANTS:
        raise ValueError(
            f"ebitda_for_surface: variant={variant!r} not in "
            f"{sorted(_VALID_VARIANTS)}"
        )

    # Canonical path — preferred. The methodology envelope is
    # produced by the F4.2 YAML layer and persisted on the
    # `financial_periods.assembled_canonical_v1` column (F4.1e).
    canonical = (period.get("assembled_canonical_v1") or {})
    methodology = canonical.get("methodology") or {}
    ebitda_block = methodology.get("ebitda") or {}
    canonical_value = ebitda_block.get(variant)
    if canonical_value is not None:
        return float(canonical_value)

    # Legacy fallback — used during the F4.0 §3e deprecation window
    # only. The fallback path appends a `deprecated_fields` marker
    # so the FE can telemetry-log the legacy read for migration
    # tracking. Marker format mirrors the convention from
    # `engine.api.deprecated_fields` (existing F4.6 ticket).
    if variant == "cash" and not allow_legacy_cash:
        # Cash variant has no safe legacy fallback today. Return
        # None so the caller can surface "cash-view EBITDA was not
        # computed for this period" (matches the briefing prompt's
        # EBITDA RULE wording) rather than emitting a wrong number.
        return None

    statements = period.get("statements") or {}
    pl = statements.get("assembled_pl") or {}
    legacy_field = _LEGACY_FIELD_MAP[variant]
    legacy_value = pl.get(legacy_field)
    if legacy_value is None:
        return None

    period.setdefault("deprecated_fields", []).append(
        f"legacy_ebitda:{variant}"
    )
    return float(legacy_value)


# ──────────────────────────────────────────────────────────────────────
# Smoke tests — inline because this module has no callers yet, and
# the F3.16 ADR's "predict before deploy" discipline asks for evidence
# the routing logic works before any consumer trusts it. These tests
# are runnable via `python3 -m engine.api._ebitda_routing` (the
# `__main__` block below).
# ──────────────────────────────────────────────────────────────────────

def _smoke_test() -> None:
    """Exercise every routing branch on a synthetic period dict.

    Run via:
        cd src && python3 -m engine.api._ebitda_routing

    Prints PASS/FAIL per case. Exits non-zero on any FAIL.
    """
    import sys

    failures: list[str] = []

    def _assert(name: str, actual: Any, expected: Any) -> None:
        if actual != expected:
            failures.append(f"  FAIL {name}: got {actual!r}, expected {expected!r}")
        else:
            print(f"  PASS {name}")

    # Case 1: canonical present — reported variant returns canonical value.
    period = {
        "assembled_canonical_v1": {
            "methodology": {
                "ebitda": {"reported": 54_443_834.0, "strict": 52_000_000.0,
                           "cash": 48_000_000.0, "adjusted": 53_000_000.0},
            },
        },
        "statements": {"assembled_pl": {"ebitda_statutory": 999.0}},
    }
    _assert("canonical reported", ebitda_for_surface(period, variant="reported"),
            54_443_834.0)
    _assert("canonical strict", ebitda_for_surface(period, variant="strict"),
            52_000_000.0)
    _assert("canonical cash", ebitda_for_surface(period, variant="cash"),
            48_000_000.0)
    _assert("canonical adjusted", ebitda_for_surface(period, variant="adjusted"),
            53_000_000.0)
    _assert("canonical path does NOT log deprecated_fields",
            period.get("deprecated_fields"), None)

    # Case 2: canonical missing, legacy present — reported falls back.
    period2 = {
        "assembled_canonical_v1": {"methodology": {}},
        "statements": {"assembled_pl": {
            "ebitda_statutory": 36_787_353.0,
            "adjusted_ebitda":  35_000_000.0,
            "ebitda_cash":      30_000_000.0,
        }},
    }
    _assert("legacy reported", ebitda_for_surface(period2, variant="reported"),
            36_787_353.0)
    _assert("legacy reported logs marker",
            period2.get("deprecated_fields"), ["legacy_ebitda:reported"])
    _assert("legacy strict", ebitda_for_surface(period2, variant="strict"),
            35_000_000.0)
    _assert("legacy strict appends marker",
            period2.get("deprecated_fields"),
            ["legacy_ebitda:reported", "legacy_ebitda:strict"])

    # Case 3: cash variant + no canonical + allow_legacy_cash=False → None.
    period3 = {
        "assembled_canonical_v1": {"methodology": {}},
        "statements": {"assembled_pl": {"ebitda_cash": 30_000_000.0}},
    }
    _assert("cash without allow_legacy_cash returns None",
            ebitda_for_surface(period3, variant="cash"), None)
    _assert("cash without allow_legacy_cash does NOT log marker",
            period3.get("deprecated_fields"), None)

    # Case 4: cash variant + allow_legacy_cash=True → falls back.
    period4 = {
        "assembled_canonical_v1": {"methodology": {}},
        "statements": {"assembled_pl": {"ebitda_cash": 30_000_000.0}},
    }
    _assert("cash with allow_legacy_cash falls back",
            ebitda_for_surface(period4, variant="cash", allow_legacy_cash=True),
            30_000_000.0)
    _assert("cash with allow_legacy_cash logs marker",
            period4.get("deprecated_fields"), ["legacy_ebitda:cash"])

    # Case 5: nothing present anywhere → None.
    period5 = {"assembled_canonical_v1": {}, "statements": {}}
    _assert("missing everywhere returns None",
            ebitda_for_surface(period5, variant="reported"), None)

    # Case 6: invalid variant → ValueError.
    try:
        ebitda_for_surface({}, variant="bogus")
        failures.append("  FAIL invalid variant should have raised ValueError")
    except ValueError:
        print("  PASS invalid variant raises ValueError")

    print()
    if failures:
        for f in failures:
            print(f)
        sys.exit(1)
    print("All ebitda_for_surface smoke cases PASS.")


if __name__ == "__main__":
    _smoke_test()
