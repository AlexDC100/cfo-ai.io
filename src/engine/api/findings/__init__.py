"""FINDINGS — deterministic detectors that carry the seven-element
contract.

Deliberately thin. Two lanes share this package and each keeps its own
entry point, so nothing here needs rewriting when either grows:

    s_*   SINGLE-PERIOD detectors — one period, one profile, the
          seventeen detectors registered in
          ``country_packs/ro_romania/profiles.yaml``. Runner:
          :mod:`engine.api.findings.s_engine`.
    m_*   MULTI-PERIOD analyses — a window of periods, its own policy
          table, its own runner. Imported directly
          (``from engine.api.findings import m_engine``); not
          re-exported here.

The single-period runner is re-exported for the common call, because
"run the detectors over this period" is what most callers want::

    from engine.api import findings
    result = findings.run_single_period(statements, period_id="…")

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

from .s_engine import (DETECTORS, MODULES, DetectorCoverageError,
                       SinglePeriodResult, assert_full_coverage,
                       run_single_period)

__all__ = [
    "DETECTORS", "MODULES", "DetectorCoverageError", "SinglePeriodResult",
    "assert_full_coverage", "run_single_period",
]
