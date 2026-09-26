"""engine.attention — "Ce contează acum", the command bar's empty state.

`compose_attention` (now.py) builds the attention/1 document from served
sources only: the period body, the comparatives document for the same
company's previous period of the same length, the sector benchmark, and the
period's deterministic findings. `sources` holds the only readers of the two
figures other lanes are redefining (EBITDA, inventory days) and the
same-length prior rule. `pack` loads packs/serving/attention.yaml.

Served by GET /api/period/{period_id}/attention (engine.api.pipeline).
"""
from __future__ import annotations

from .now import EXCLUDED_SOURCES, SCHEMA, compose_attention
from .pack import AttentionPackError, load_pack
from .sources import same_length_prior

__all__ = [
    "SCHEMA",
    "EXCLUDED_SOURCES",
    "compose_attention",
    "load_pack",
    "AttentionPackError",
    "same_length_prior",
]
