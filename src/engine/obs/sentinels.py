"""Drift sentinels — the "new SAGA variant in the wild" detector.

Nightly logic, runnable any time (``scripts/engine_ops.py sentinels``;
also folded into GET /api/ops). Compares today's observed rates against
a rolling baseline and prints alert-level NOTICES — corpus_replay
style, NEVER red: a sentinel departure is an operator signal, not a
gate, and every entry point here exits 0.

WATCHED RATES (from ``engine.obs.metrics.collect_metrics``):
    unclassified_rate        docs with ≥1 unmapped account / docs — the
                             headline "a trial-balance layout we cannot
                             fully map showed up" signal
    ai_proposal_rate         docs whose reconciliation receipt came from
                             the AI proposal path / docs
    frontend_fallback_rate   docs extracted via the LLM fallback lane
                             (extraction.method == "llm") / docs

BASELINE — ``data/obs/baseline.json`` (``ENGINE_OBS_DIR`` overrides the
directory; same gitignored data/ convention as the AI spend breaker and
the journal). Shape:

    {"schema": "obs_baseline_v1", "updated_at": iso,
     "rates": {name: {"mean": float, "samples": int}}}

The mean is an EWMA (alpha 0.3) so one noisy night decays instead of
poisoning the reference forever. The FIRST observation of a rate seeds
the baseline silently (nothing to compare against — a seed is not a
departure). A rate with no coverage tonight (denominator 0 → None) is
skipped without touching its baseline.

DEPARTURE RULE: |current − mean| > max(ABS_FLOOR, REL_BAND × mean).
Defaults: ABS_FLOOR 0.10 (ten points of rate), REL_BAND 0.5 (±50% of
the baseline). Departures in BOTH directions notice — a fallback rate
collapsing to zero is as newsworthy as one exploding.

Corrupt/unreadable baseline files reset loudly to empty (the breaker's
discipline) — never raise into the caller.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .metrics import SENTINEL_RATE_KEYS, collect_metrics

logger = logging.getLogger("engine.obs.sentinels")

#: Env override for the obs state directory (baseline + battery record).
OBS_DIR_ENV = "ENGINE_OBS_DIR"

BASELINE_FILENAME = "baseline.json"
BASELINE_SCHEMA = "obs_baseline_v1"

#: EWMA smoothing weight for tonight's observation.
EWMA_ALPHA = 0.3

#: Departure thresholds (see module docstring).
ABS_FLOOR = 0.10
REL_BAND = 0.5

#: Sentinel-name → plain-language hint printed with a departure.
_HINTS = {
    "unclassified_rate": (
        "possible new trial-balance variant in the wild (accounts the "
        "pack cannot map)"
    ),
    "ai_proposal_rate": "reconcile diagnoses drifting toward the AI path",
    "frontend_fallback_rate": (
        "deterministic front-ends matching less — uploads falling back "
        "to the LLM lane"
    ),
}


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def obs_dir() -> Path:
    env = os.environ.get(OBS_DIR_ENV)
    if env:
        return Path(env)
    return _repo_root() / "data" / "obs"


def baseline_path() -> Path:
    return obs_dir() / BASELINE_FILENAME


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_baseline(path: Optional[Any] = None) -> Dict[str, Any]:
    """Read the baseline; corruption resets to empty (logged loudly)."""
    target = Path(path) if path is not None else baseline_path()
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or not isinstance(raw.get("rates"), dict):
            raise ValueError("baseline shape invalid")
        return raw
    except FileNotFoundError:
        return {"schema": BASELINE_SCHEMA, "updated_at": None, "rates": {}}
    except Exception:  # noqa: BLE001 — reset, never raise
        logger.warning("[obs.sentinels] baseline %s unreadable — resetting", target)
        return {"schema": BASELINE_SCHEMA, "updated_at": None, "rates": {}}


def save_baseline(baseline: Dict[str, Any], path: Optional[Any] = None) -> None:
    """Atomic write (tmp + os.replace) — best-effort, never raises."""
    target = Path(path) if path is not None else baseline_path()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_text(
            json.dumps(baseline, sort_keys=True, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(str(tmp), str(target))
    except Exception:  # noqa: BLE001
        logger.warning("[obs.sentinels] could not persist baseline to %s", target)


def evaluate_sentinels(
    metrics: Optional[Dict[str, Any]] = None,
    *,
    journal_root: Optional[Any] = None,
    baseline_file: Optional[Any] = None,
    update_baseline: bool = True,
    abs_floor: float = ABS_FLOOR,
    rel_band: float = REL_BAND,
) -> Dict[str, Any]:
    """Compare current rates to the rolling baseline. Returns

        {"schema", "generated_at", "rates", "notices": [str, ...],
         "departures": [{sentinel, current, baseline_mean, delta}, ...],
         "baseline": <the (possibly updated) baseline dict>,
         "baseline_updated": bool}

    ``notices`` are ready-to-print ``NOTICE  obs sentinel: ...`` lines
    (informational entries included); ``departures`` carry only the
    threshold breaches. Never raises.
    """
    try:
        if metrics is None:
            metrics = collect_metrics(journal_root)
        rates = metrics.get("rates") or {}
        baseline = load_baseline(baseline_file)
        stored = baseline.get("rates") or {}
        notices: List[str] = []
        departures: List[Dict[str, Any]] = []
        changed = False

        for name in SENTINEL_RATE_KEYS:
            current = rates.get(name)
            if current is None:
                notices.append(
                    "NOTICE  obs sentinel: %s has no coverage tonight "
                    "(no analyzed documents in the journal) — baseline untouched"
                    % name
                )
                continue
            entry = stored.get(name)
            if not isinstance(entry, dict) or not isinstance(
                entry.get("mean"), (int, float)
            ):
                stored[name] = {"mean": round(float(current), 6), "samples": 1}
                changed = True
                notices.append(
                    "NOTICE  obs sentinel: %s baseline seeded at %.4f "
                    "(first observation — nothing to compare yet)"
                    % (name, current)
                )
                continue
            mean = float(entry["mean"])
            delta = float(current) - mean
            threshold = max(abs_floor, rel_band * abs(mean))
            if abs(delta) > threshold:
                hint = _HINTS.get(name, "drift vs rolling baseline")
                notices.append(
                    "NOTICE  obs sentinel: %s %.4f vs baseline %.4f "
                    "(%+.4f, threshold %.4f) — %s"
                    % (name, current, mean, delta, threshold, hint)
                )
                departures.append(
                    {
                        "sentinel": name,
                        "current": round(float(current), 6),
                        "baseline_mean": round(mean, 6),
                        "delta": round(delta, 6),
                        "threshold": round(threshold, 6),
                        "hint": _HINTS.get(name),
                    }
                )
            if update_baseline:
                new_mean = (1 - EWMA_ALPHA) * mean + EWMA_ALPHA * float(current)
                stored[name] = {
                    "mean": round(new_mean, 6),
                    "samples": int(entry.get("samples") or 0) + 1,
                }
                changed = True

        baseline["schema"] = BASELINE_SCHEMA
        baseline["rates"] = stored
        if changed and update_baseline:
            baseline["updated_at"] = _now_iso()
            save_baseline(baseline, baseline_file)

        return {
            "schema": "obs_sentinels_v1",
            "generated_at": _now_iso(),
            "rates": {k: rates.get(k) for k in SENTINEL_RATE_KEYS},
            "notices": notices,
            "departures": departures,
            "baseline": baseline,
            "baseline_updated": bool(changed and update_baseline),
        }
    except Exception as exc:  # noqa: BLE001 — sentinels never take anything down
        logger.exception("[obs.sentinels] evaluation failed (non-fatal)")
        return {
            "schema": "obs_sentinels_v1",
            "generated_at": _now_iso(),
            "rates": {},
            "notices": [
                "NOTICE  obs sentinel: evaluation failed (%s) — see logs" % (exc,)
            ],
            "departures": [],
            "baseline": {"schema": BASELINE_SCHEMA, "rates": {}},
            "baseline_updated": False,
        }
