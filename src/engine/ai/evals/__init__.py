"""engine.ai.evals — the LIVE eval baseline for the advisory pass.

`run_baseline` runs `engine.ai.advisory.run_ai_review` with REAL model
calls over the small pinned fixture set (three golden-corpus cases) and
persists the scores to `baseline.json` next to this package.

SELF-ACTIVATING, NEVER IN CI: scripts/check_anthropic_probe.py runs it
exactly once — when the deploy probe reports CREDITS_OK and
baseline.json is absent. The test suite and the corpus replay never
import this package (their anthropic sentinels would refuse the SDK
anyway); CI stays fully mocked forever.
"""
