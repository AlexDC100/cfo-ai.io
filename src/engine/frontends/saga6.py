"""SAGA compact 6-column front-end (Layout B: SI / RL / RC, no SF block).

Thin format-id shell over the shared machinery in `saga10` — all four
deterministic trial-balance formats are dialects of ONE wrapped parser
(`trial_balance_parser`), so the conversion lives in one place.

Layout-B specifics (handled by `build_tb_ledgerdoc`): the file carries
NO Solduri-finale block, so the atoms' closing slots are ABSENT — the
parser's synthesized sf values (from the si+rl accounting identity)
are re-derived bit-exactly by `legacy_adapter.derive_legacy`, never
stored. The cumulative pair rides the `rc_pair` side-channel.
"""
from __future__ import annotations

from .saga10 import _DeterministicTbFrontEnd


__all__ = ["Saga6FrontEnd"]


class Saga6FrontEnd(_DeterministicTbFrontEnd):
    format_id = "saga_compact_6_col"
