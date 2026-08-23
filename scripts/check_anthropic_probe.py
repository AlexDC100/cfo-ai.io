#!/usr/bin/env python3
"""Deploy-time Anthropic probe — a NOTICE, never a gate (exit 0 always).

Reports, in order:
  1. REGISTRY_OK / REGISTRY_ERROR — engine.ai/models.yaml loads and
     validates (a broken registry is the loudest possible deploy bug,
     but this script still exits 0: the engine's own import fails loud).
  2. KEY_MISSING     — ANTHROPIC_API_KEY unset: every AI role degrades
     to the honest "advisory unavailable" state; serving unaffected.
  3. CREDITS_OK      — a 1-token call on the CHEAPEST tier succeeded.
  4. CREDITS_ABSENT  — the key authenticates but the account cannot be
     billed (credit balance / permission errors). Loud notice; the
     engine keeps serving with AI degraded.
  5. PROBE_ERROR     — anything else (network, SDK missing). Notice.

SELF-ACTIVATING LIVE EVAL BASELINE: when the verdict is CREDITS_OK and
src/engine/ai/evals/baseline.json is ABSENT, this probe runs
engine.ai.evals.run_baseline ONCE (live calls over the small pinned
fixture set; scores persisted to baseline.json). Today credits are
absent on the prod key, so the probe degrades to the loud notice below.
CI never runs this script — the test suite and the corpus replay stay
fully mocked forever (their anthropic-import sentinels guarantee it).

Usage:  .venv/bin/python scripts/check_anthropic_probe.py
Exit code: 0 ALWAYS (a notice, not a gate).
"""
from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path
from typing import List, Optional


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return Path(__file__).resolve().parent.parent


REPO = _find_repo_root()
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

#: The cheapest current tier — 1 output token, the smallest billable
#: probe the API allows. VERIFY THIS STRING AT DEPLOY (model ids change
#: with releases; see also the flagship note in engine.ai/models.yaml).
PROBE_MODEL = "claude-haiku-4-5-20251001"

#: The last verdict main() reached — for tests and for callers that
#: import this module instead of parsing stdout.
LAST_VERDICT: Optional[str] = None

_CREDIT_MARKERS = (
    "credit balance",
    "credit_balance",
    "billing",
    "purchase credits",
    "insufficient_quota",
    "permission",
    "authentication",
    "invalid x-api-key",
    "401",
    "403",
)


def _baseline_path() -> Path:
    return SRC / "engine" / "ai" / "evals" / "baseline.json"


def _activate_baseline() -> None:
    """Run the live eval baseline once (CREDITS_OK + baseline absent).
    Failures are loud notices — the probe still exits 0."""
    print("[probe] baseline.json absent + credits OK -> running the live "
          "eval baseline (engine.ai.evals.run_baseline) ...")
    from engine.ai.evals import run_baseline

    run_baseline.main([])


def _notice(verdict: str, detail: str = "") -> int:
    global LAST_VERDICT
    LAST_VERDICT = verdict
    line = "[probe] VERDICT=%s" % verdict
    if detail:
        line += " — %s" % detail
    print(line)
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    # 1) Registry health (notice only — the engine itself fails loud).
    try:
        from engine.ai import registry

        registry.load_registry()
        print("[probe] REGISTRY_OK — engine.ai/models.yaml loads and validates")
    except Exception as e:  # noqa: BLE001 — a notice, not a gate
        print("[probe] REGISTRY_ERROR — %s" % e)

    # 2) Key present?
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return _notice(
            "KEY_MISSING",
            "ANTHROPIC_API_KEY is not set; every AI role degrades to the "
            "honest 'advisory unavailable' state and serving proceeds.",
        )

    # 3) The 1-token cheapest-tier probe.
    try:
        from anthropic import Anthropic
    except ImportError:
        return _notice("PROBE_ERROR", "anthropic SDK not installed")
    try:
        client = Anthropic(api_key=api_key, max_retries=0, timeout=30.0)
        client.messages.create(
            model=PROBE_MODEL,
            max_tokens=1,
            messages=[{"role": "user", "content": "ping"}],
        )
    except Exception as e:  # noqa: BLE001 — classify, never raise
        message = "%s" % e
        lowered = message.lower()
        if any(marker in lowered for marker in _CREDIT_MARKERS):
            return _notice(
                "CREDITS_ABSENT",
                "the key cannot be billed (%s). The AI lanes degrade to "
                "'advisory unavailable'; deterministic serving is "
                "unaffected. The live eval baseline stays deferred until "
                "credits exist — re-run this probe after topping up."
                % message.splitlines()[0][:200],
            )
        return _notice("PROBE_ERROR", message.splitlines()[0][:200])

    # 4) Credits OK — self-activate the live eval baseline exactly once.
    code = _notice("CREDITS_OK", "1-token probe on %s succeeded" % PROBE_MODEL)
    try:
        if not _baseline_path().is_file():
            _activate_baseline()
        else:
            print("[probe] eval baseline present (%s) — not re-run; delete "
                  "it deliberately to re-baseline." % _baseline_path())
    except Exception:  # noqa: BLE001 — the baseline is a notice too
        print("[probe] BASELINE_ERROR — the live eval baseline failed:")
        traceback.print_exc()
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
