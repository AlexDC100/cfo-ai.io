"""engine.passes — compiler-style pipeline passes.

The compiler restructure's pass layer: each pass consumes the immutable
IR (``engine.ir.LedgerDoc``) plus pure jurisdiction DATA
(``engine.packs.CompiledPack``) and produces a typed layer. Phase order
(planned): classify -> assemble -> check -> reconcile; only CLASSIFY
exists at this vintage.

PHASE 3 STATUS: production classification is PACK-DRIVEN — the RO
tables were deleted and ``engine.country_packs.ro_romania`` reads the
CompiledPack (``engine.packs.runtime``). The classify PASS here is the
compiler-style formulation over the front-end IR; the production
pipeline still composes the parser/assembler seam, and the comparator
(``engine.passes.shadow``) cross-checks the two CODE PATHS against the
one pack data source (front-end/IR drift detection — no longer a
legacy-vs-pack divergence gate). The single opt-in pipeline probe stays
``SHADOW_CLASSIFY=1`` (log-only, default OFF) in
``engine.api.pipeline._deterministic_tb_parsed``; the golden corpus is
byte-identical with the flag off AND on.

The comparator lives here (``engine.passes.shadow``) rather than at
``engine/shadow.py``: it composes the classify pass with the production
seam, and keeping it under ``passes/`` means Phase 2's assembler pass
joins its comparator in one place instead of splitting the machinery
across two roots. (The task spec allowed either location; this is the
documented choice.)
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
