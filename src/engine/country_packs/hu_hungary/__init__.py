"""F4.5 Hungary pack — SKELETON ONLY (UNCALIBRATED).

This pack implements the minimum interface for the Hungarian
accounting standard (lt_001_2017_iv — Act C of 2000 on Accounting,
2017 IV amendments). It is intentionally NOT calibrated against real
Hungarian trial balances; the chart-of-accounts mapping is a placeholder
based on the standard's structural classes (1-9) and will fail
realistic reconciliation.

Why ship a skeleton: it lets F4.4 fan-out routing exercise multi-pack
logic (currently the RO pack is the only candidate, so fan-out always
collapses to fast_path). When a real Hungarian fixture lands, the
chart_of_accounts.py module gets filled in following the same
F4.1b-cont calibration loop pattern that brought the RO adapter to 0.00%
round-trip on all 6 RO fixtures.

DO NOT use this pack for any real Hungarian extraction; the
calibration_tier is set to EXPERIMENTAL to signal this to consumers.
The classify_industry method returns 0 confidence so the existing
generic-industry fallback handles all Hungarian uploads.

Operator action to graduate this pack:
  1. Source 3-5 real Hungarian trial balances + ground-truth financials
  2. Fill _RULES in chart_of_accounts.py with prefix → bucket mappings
  3. Implement canonical_adapter.py per the F4.1b-cont calibration loop
  4. Register fixtures in scripts/measure_bs_drift.py
  5. Iterate until F-A3.1 GREEN at <0.5% drift across all fixtures
  6. Bump calibration_tier from EXPERIMENTAL to PARTIALLY_CALIBRATED
"""
from .pack import HungaryPack
from engine.core.country_pack_registry import register_pack

# Auto-register on import so the engine sees the pack at startup.
# Same pattern as engine.country_packs.ro_romania.
register_pack(HungaryPack())

__all__ = ["HungaryPack"]
