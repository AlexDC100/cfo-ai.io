"""STAGE_PERSIST ATTACH — additive-only consensus persistence (C1).

Called from the pipeline's stage_persist advisory seam (the same slot
as the auto-reconcile / advisory hooks): writes the consensus block
onto ``canonical_bs`` as a NEW top-level key. E4 by construction —
values, status, rows, totals are never touched; the block is comparison
metadata riding next to ``source_anchor``. Never raises.
"""
from __future__ import annotations

import copy
import logging
from typing import Any, Dict

logger = logging.getLogger("engine.consensus.persist")


def attach_consensus(canonical_envelope: Any, consensus_block: Any) -> bool:
    """Attach ``consensus_block`` to ``canonical_envelope['canonical_bs']``.

    Additive-only: refuses when the envelope carries no canonical_bs or
    when a consensus key is already present (a carry-forward or an
    earlier attach wins). Returns True when attached. Never raises.
    """
    try:
        if not isinstance(canonical_envelope, dict):
            return False
        if not isinstance(consensus_block, dict):
            return False
        cbs = canonical_envelope.get("canonical_bs")
        if not isinstance(cbs, dict):
            return False
        if "consensus" in cbs:
            return False
        cbs["consensus"] = copy.deepcopy(consensus_block)
        return True
    except Exception:  # noqa: BLE001 — persist must never break
        logger.exception("[consensus.persist] attach failed (ignored)")
        return False
