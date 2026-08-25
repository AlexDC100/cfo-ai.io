"""DUAL-PATH CONSENSUS — two independent readings of one document,
compared atom-by-atom in integer cents, with a three-leg eligibility
verdict (E9) and an additive trust surface.

Package layout (all jurisdiction-blind — jurisdiction enters ONLY as a
runtime parameter resolved through ``engine.core.country_pack_registry``
and as data on the AI-produced StructuralMap; no jurisdiction-equality
branches, no account-code literals):

  verdict.py    the three-leg E9 predicate (pure, dependency-free)
  compare.py    atom-by-atom comparator over 10-key canonical rows
                (integer cents, zero-pruning, refusal on misalignment —
                the shadow.py discipline, re-implemented minimally, not
                imported)
  selfcheck.py  totals third-leg derivation (from the REAL
                compute_source_anchor output on the mapped doc) + the
                layout-conditional movement identity
  lane.py       orchestration: the C2 dual-map lane (two interpreter
                framings → two mechanical map_guided reads → consensus
                → payload) and the C1 classic-vs-mapped consensus probe.
                Mechanical reads run through the REAL
                engine.frontends.map_guided executor — the AI never
                sees or emits numeric cell values on this lane.
  persist.py    the stage_persist additive attach (C1)

Gates (all default OFF; absent env == byte-identical pipeline):
  AI_STRUCTURAL_READER=1  C2 dual-map lane in the parse-failure branch
  CONSENSUS_SHADOW=1      C1 log-only probe (never mutates)
  CONSENSUS_ENABLED=1     C1 consensus block persisted (served values
                          ALWAYS classic — E4)

AI calls never originate here: interpretation is delegated to
``engine.interp`` (injectable ``interpret_fn``), and tests inject
scripted functions — this package must never import ``anthropic``.
"""
from .verdict import (  # noqa: F401
    LEG_DUAL,
    LEG_MOVEMENTS,
    LEG_ORDER,
    LEG_TOTALS,
    eligible_from_block,
    three_leg_verdict,
)
from .compare import compare_readings  # noqa: F401

__all__ = [
    "LEG_DUAL",
    "LEG_TOTALS",
    "LEG_MOVEMENTS",
    "LEG_ORDER",
    "three_leg_verdict",
    "eligible_from_block",
    "compare_readings",
]
