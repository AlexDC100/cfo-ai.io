"""engine.passes — compiler-style pipeline passes (SHADOW PHASE).

The compiler restructure's pass layer: each pass consumes the immutable
IR (``engine.ir.LedgerDoc``) plus pure jurisdiction DATA
(``engine.packs.CompiledPack``) and produces a typed layer. Phase order
(planned): classify -> assemble -> check -> reconcile; only CLASSIFY
exists at this vintage, and only in SHADOW.

ZERO-BEHAVIOR-CHANGE: production keeps running the legacy
classification (``engine.country_packs.ro_romania``). Nothing in the
default pipeline path imports this package; the single opt-in
integration point is the ``SHADOW_CLASSIFY=1`` log-only probe in
``engine.api.pipeline._deterministic_tb_parsed``, default OFF. The
golden corpus is byte-identical with the flag off AND on (the shadow
only logs — locked by the corpus battery run both ways).

The SHADOW COMPARATOR lives here too (``engine.passes.shadow``) rather
than at ``engine/shadow.py``: it composes the classify pass with the
legacy seam, and keeping the whole shadow phase under ``passes/`` means
Phase 2's assembler pass joins its comparator in one place instead of
splitting the machinery across two roots. (The task spec allowed either
location; this is the documented choice.)
"""
from .classify import (
    METHOD_RULE,
    METHOD_UNCLASSIFIED,
    AtomClassification,
    ClassificationLayer,
    ClassifyError,
    classify,
    effective_closing_side,
)

__all__ = [
    "METHOD_RULE",
    "METHOD_UNCLASSIFIED",
    "AtomClassification",
    "ClassificationLayer",
    "ClassifyError",
    "classify",
    "effective_closing_side",
]
