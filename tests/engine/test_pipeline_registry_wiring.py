"""Pipeline model literals must come from the model registry (D-part of
the engine-of-record mission). Written RED-FIRST against the five
hardcoded "claude-opus-4-7" literals in pipeline.py: stage_extract's RO
LLM fallback (role "extract") and the narrate family — stage_narrate,
stage_persist_narrative, _persist_sku_analysis, regenerate_briefing
(role "narrative"). The registry ships value-identical strings, so the
wiring is byte-neutral (corpus goldens pin the values, not the source).
A model bump becomes a models.yaml edit + recorded eval, never a code
change."""

import re
from pathlib import Path

from engine.ai import registry

PIPELINE = Path(__file__).resolve().parents[2] / "src" / "engine" / "api" / "pipeline.py"


def test_pipeline_has_no_hardcoded_model_literals():
    src = PIPELINE.read_text(encoding="utf-8")
    hits = [
        (i + 1, line.strip())
        for i, line in enumerate(src.splitlines())
        # flag literal model ids in code, not in comments/docstrings
        if re.search(r'''["']claude-[a-z0-9.-]+["']''', line)
        and not line.lstrip().startswith("#")
    ]
    assert hits == [], (
        "pipeline.py carries hardcoded model literals — route them through "
        "engine.ai.registry (roles 'extract'/'narrative'): %r" % hits
    )


def test_registry_serves_the_frozen_values():
    # The wiring must be value-identical: stored envelopes and corpus
    # goldens pin these exact strings today.
    assert registry.model_for("extract") == "claude-opus-4-7"
    assert registry.model_for("narrative") == "claude-opus-4-7"
