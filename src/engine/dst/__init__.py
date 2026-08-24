"""Deterministic Simulation & Fault harness (DST — Part B).

In-process fault injection over the REAL pipeline composition — the same
code objects ``scripts/corpus_replay.py`` drives, never a mirror:

    parse (RomaniaPack.parse_trial_balance[_csv] / the HU AI lane with a
    scripted client) → ``pipeline._deterministic_tb_parsed`` →
    ``pipeline.stage_map`` → ``pipeline.stage_persist`` against the
    fake-admin harness → ``_reconcile.served_canonical_bs`` →
    ``engine.serving.FactsGateway`` — with the run-journal hooks
    (``engine.journal.hooks``) firing at every stage boundary exactly as
    ``pipeline._run_pipeline_sync`` fires them.

Faults are injected ONLY through seams that already exist:
  · the journal hooks + resume machinery (kill-and-resume),
  · the journal's cached ``Journal`` instance (store write faults,
    append faults, the injectable ``clock``),
  · the fake Supabase admin client (DB errors mid-persist, the
    serving-flip write),
  · the AI lane's injectable ``client_factory`` and the
    ``_reconcile._ai_propose`` seam (AI client faults),
  · post-hoc object-file corruption (torn writes at rest).

No production source file is modified by this package; a fault the
harness cannot inject through an existing seam is a DOCUMENTED GAP
(``faults.GAPS``), never a silent skip.

Modules:
    harness.py   the composition runner + fault-free baseline + the
                 injection plumbing (patcher, faultable admin, journal
                 env, AI sentinels)
    faults.py    the typed fault registry + one scenario per fault
                 class (each scenario asserts its K-invariants)
    explorer.py  seeded enumeration of (fixture × fault × boundary),
                 bounded per-PR profile and DST_PROFILE=deep profile,
                 failure minimization + quarantine archiving to
                 ``corpus/quarantine/dst/<sha16>/``

The journal root is ALWAYS a caller-supplied scratch directory
(``ENGINE_JOURNAL_DIR`` is set only inside ``harness.journal_env`` and
restored on exit) — the corpus and determinism gates keep running
journal-OFF and byte-identical.
"""
from .harness import (  # noqa: F401
    ARM_POINTS,
    BOUNDARIES,
    FIXTURES,
    DstRunResult,
    FakeAdminClient,
    FaultableAdmin,
    Fixture,
    InvariantViolation,
    SimulatedKill,
    admin_seam,
    ai_guard,
    baseline_for,
    journal_env,
    norm_bytes,
    run_deterministic,
    run_hu_lane,
)
from .faults import FAULTS, GAPS, FaultSpec  # noqa: F401
from .explorer import build_matrix, explore, run_config  # noqa: F401

__all__ = [
    "ARM_POINTS",
    "BOUNDARIES",
    "FIXTURES",
    "DstRunResult",
    "FakeAdminClient",
    "FaultableAdmin",
    "Fixture",
    "InvariantViolation",
    "SimulatedKill",
    "admin_seam",
    "ai_guard",
    "baseline_for",
    "journal_env",
    "norm_bytes",
    "run_deterministic",
    "run_hu_lane",
    "FAULTS",
    "GAPS",
    "FaultSpec",
    "build_matrix",
    "explore",
    "run_config",
]
