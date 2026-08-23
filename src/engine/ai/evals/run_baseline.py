"""Live eval baseline for the AI advisory pass (engine.ai.evals).

Runs `run_ai_review` with REAL model calls (the ai_validator role's own
client) over the PINNED fixture set below and persists per-case scores
to `baseline.json` (same directory). The baseline is the reference the
operator compares future prompt/model changes against — agreement score
on the llm case, finding counts by severity everywhere.

PINNED FIXTURES (golden-corpus cases; envelopes rebuilt from
`expected/served_envelope.json`, the byte-frozen canonical truth):
  · saga_10_col              — the RO deterministic sentinel (Job 2 only)
  · hu_ai_lane               — the llm-extraction case; its input.csv is
                               passed as source_text so Job 1 (the live
                               re-read + agreement score) runs for real
  · llm_fallback_scanned_pdf — llm-method envelope WITHOUT source text
                               (Job 1 skips honestly; Job 2 runs)

ACTIVATION: scripts/check_anthropic_probe.py runs this exactly once —
CREDITS_OK + baseline.json absent. Today credits are ABSENT on the prod
key, so the probe degrades to its loud notice and this stays deferred.
Standalone use (deliberate re-baseline): delete baseline.json, ensure
ANTHROPIC_API_KEY has credits, then
  .venv/bin/python -m engine.ai.evals.run_baseline
Never wired into CI or the test suite — those stay fully mocked.

Exit codes: 0 baseline written; 1 no key / no cases / all cases errored.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

_HERE = Path(__file__).resolve().parent
REPO = _HERE.parents[3]
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

BASELINE_PATH = _HERE / "baseline.json"

#: (case_id, source_text file or None) — the pinned set. Keep SMALL:
#: every entry is live model spend.
PINNED_CASES = (
    ("saga_10_col", None),
    ("hu_ai_lane", "input.csv"),
    ("llm_fallback_scanned_pdf", None),
)


def _envelope_for_case(case_dir: Path) -> Optional[Dict[str, Any]]:
    expected = case_dir / "expected" / "served_envelope.json"
    if not expected.is_file():
        return None
    return {
        "canonical_bs": json.loads(expected.read_text(encoding="utf-8")),
        "provenance": {
            "source_document_id": "eval-%s" % case_dir.name,
            "original_filename": case_dir.name,
            "content_hash": "eval-%s" % case_dir.name,
            "written_at": datetime.now(timezone.utc).isoformat(),
        },
    }


def _score(review: Dict[str, Any]) -> Dict[str, Any]:
    by_severity: Dict[str, int] = {}
    for finding in review.get("findings") or []:
        sev = str(finding.get("severity"))
        by_severity[sev] = by_severity.get(sev, 0) + 1
    ev = review.get("extraction_verification") or {}
    return {
        "degraded": False,
        "findings_total": len(review.get("findings") or []),
        "findings_by_severity": by_severity,
        "dropped_findings": review.get("dropped_findings"),
        "escalations": len(review.get("needs_review_escalations") or []),
        "job1_ran": ev.get("ran"),
        "agreement_score": ev.get("agreement_score"),
        "atoms_checked": ev.get("atoms_checked"),
        "model": review.get("model"),
        "prompt_version": review.get("prompt_version"),
    }


def main(argv: Optional[List[str]] = None) -> int:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("[evals] ANTHROPIC_API_KEY is not set — the live baseline "
              "cannot run. Nothing written.")
        return 1

    from engine.ai import advisory, registry

    corpus_root = REPO / "corpus"
    cases: Dict[str, Any] = {}
    any_ok = False
    for case_id, source_name in PINNED_CASES:
        case_dir = corpus_root / case_id
        envelope = _envelope_for_case(case_dir)
        if envelope is None:
            print("[evals] SKIP %s — no expected served envelope" % case_id)
            cases[case_id] = {"error": "fixture_missing"}
            continue
        source_text = None
        if source_name:
            source_path = case_dir / source_name
            if source_path.is_file():
                source_text = source_path.read_text(encoding="utf-8",
                                                    errors="replace")
        print("[evals] running live review for %s ..." % case_id)
        try:
            review = advisory.run_ai_review(envelope, source_text=source_text)
            cases[case_id] = _score(review)
            any_ok = True
            print("[evals]   ok — findings=%s agreement=%s"
                  % (cases[case_id]["findings_total"],
                     cases[case_id]["agreement_score"]))
        except advisory.AdvisoryUnavailable as e:
            cases[case_id] = {"degraded": True, "reason": e.reason,
                              "detail": e.detail}
            print("[evals]   degraded — %s (%s)" % (e.reason, e.detail))
        except Exception as e:  # noqa: BLE001 — a baseline run must report, not crash
            cases[case_id] = {"error": "%s: %s" % (type(e).__name__, e)}
            print("[evals]   ERROR — %s" % e)

    baseline = {
        "schema": "ai_eval_baseline_v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": registry.model_for("ai_validator"),
        "prompt_version": registry.params_for("ai_validator")["prompt_version"],
        "cases": cases,
    }
    if not any_ok:
        print("[evals] every case degraded/errored — baseline NOT written "
              "(fix credits/fixtures and re-run).")
        return 1
    BASELINE_PATH.write_text(
        json.dumps(baseline, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print("[evals] baseline written to %s" % BASELINE_PATH)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
