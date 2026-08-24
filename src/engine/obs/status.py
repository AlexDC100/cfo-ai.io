"""``ops_snapshot()`` — one glance = engine health (engine.obs.status).

The single dict behind both GET /api/ops and ``scripts/engine_ops.py
status``. Sections (every one degrades independently — a failure in one
becomes ``{"error": ...}`` there, never a missing response):

    battery     last full-battery result per gate, parsed from the
                conventional record (below) — else ``"not recorded"``
    versions    engine version + jurisdiction packs (id/version/window/
                pack_hash) + the AI model registry (role → model id)
    ai_spend    breaker counters vs daily caps per role
    journal     chains, hash-chain verification, DLQ depth
    sentinels   drift notices vs the rolling baseline (READ-ONLY here —
                the nightly CLI run owns baseline updates)
    metrics     the rate/mix summary from the on-demand collector

BATTERY RECORD CONVENTION — ``data/obs/battery_last.json``
(``ENGINE_OBS_DIR`` moves the directory, ``ENGINE_BATTERY_LOG`` points
at an explicit file). Two accepted shapes:

  · JSON: ``{"ran_at": iso, "gates": {"<gate>": {"ok": bool,
    "exit_code": int, ...}, ...}}`` (a list of ``{name, ok, ...}``
    rows under "gates" also parses);
  · plain text (``*.log``): one gate per line — ``PASS <gate>`` /
    ``FAIL <gate> ...`` / ``NOTICE ...`` (notices carried through).

Nothing in this repo writes the record automatically yet — an operator
(or a future battery wrapper) drops it after a run; until then the
section honestly reads "not recorded".
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .metrics import collect_metrics
from .sentinels import evaluate_sentinels, obs_dir

logger = logging.getLogger("engine.obs.status")

BATTERY_LOG_ENV = "ENGINE_BATTERY_LOG"
BATTERY_FILENAME = "battery_last.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def battery_record_path() -> Path:
    env = os.environ.get(BATTERY_LOG_ENV)
    if env:
        return Path(env)
    return obs_dir() / BATTERY_FILENAME


def _parse_battery_text(text: str) -> Dict[str, Any]:
    gates: Dict[str, Any] = {}
    notices: List[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        upper = line.upper()
        if upper.startswith("PASS") or upper.startswith("FAIL"):
            parts = line.split(None, 2)
            if len(parts) >= 2:
                gates[parts[1]] = {
                    "ok": upper.startswith("PASS"),
                    "detail": parts[2] if len(parts) > 2 else None,
                }
        elif upper.startswith("NOTICE"):
            notices.append(line)
    return {"gates": gates, "notices": notices}


def read_battery_record(path: Optional[Any] = None) -> Dict[str, Any]:
    """Parse the last-battery record; ``{"recorded": False}`` when the
    conventional file is absent or unreadable. Never raises."""
    target = Path(path) if path is not None else battery_record_path()
    try:
        text = target.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {"recorded": False, "path": str(target)}
    except Exception:  # noqa: BLE001
        logger.warning("[obs.status] battery record %s unreadable", target)
        return {"recorded": False, "path": str(target)}
    out: Dict[str, Any] = {"recorded": True, "path": str(target)}
    parsed: Optional[Dict[str, Any]] = None
    try:
        raw = json.loads(text)
        if isinstance(raw, dict):
            gates = raw.get("gates")
            if isinstance(gates, list):
                gates = {
                    str(g.get("name") or g.get("gate") or i): {
                        k: v for k, v in g.items() if k not in ("name", "gate")
                    }
                    for i, g in enumerate(gates)
                    if isinstance(g, dict)
                }
            if not isinstance(gates, dict):
                gates = {}
            parsed = {
                "ran_at": raw.get("ran_at") or raw.get("at"),
                "gates": gates,
                "notices": list(raw.get("notices") or []),
            }
    except ValueError:
        parsed = None
    if parsed is None:
        parsed = _parse_battery_text(text)
        parsed["ran_at"] = None
    out.update(parsed)
    gate_rows = out.get("gates") or {}
    out["total"] = len(gate_rows)
    out["passed"] = sum(
        1 for g in gate_rows.values() if isinstance(g, dict) and g.get("ok")
    )
    out["all_green"] = bool(gate_rows) and out["passed"] == out["total"]
    return out


def _engine_version() -> str:
    try:
        from importlib.metadata import version

        return "scandia-engine@%s" % version("scandia-engine")
    except Exception:  # noqa: BLE001 — not installed as a dist locally
        return "scandia-engine@dev"


def _pack_versions() -> Any:
    try:
        from engine.packs import default_packs_root, discover_packs

        rows = []
        for pack in discover_packs(default_packs_root()):
            identity = pack.identity
            rows.append(
                {
                    "jurisdiction": identity.jurisdiction,
                    "pack_id": identity.pack_id,
                    "version": identity.version,
                    "effective_from": str(identity.effective_from),
                    "effective_to": (
                        str(identity.effective_to) if identity.effective_to else None
                    ),
                    "pack_hash": pack.pack_hash,
                    "pack_hash_short": pack.pack_hash[:12],
                }
            )
        return rows
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


def _model_registry_versions() -> Any:
    try:
        from engine.ai import registry as _registry

        return {
            role: {
                "model_id": params.get("model_id"),
                "prompt_version": params.get("prompt_version"),
            }
            for role, params in sorted(_registry.load_registry().items())
        }
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


def ops_snapshot(
    journal_root: Optional[Any] = None,
    *,
    verify_limit: int = 25,
) -> Dict[str, Any]:
    """The one-glance engine health dict. Read-only everywhere: no
    baseline write, no state mutation, never raises."""
    metrics = collect_metrics(journal_root, verify_limit=verify_limit)
    sentinels = evaluate_sentinels(
        metrics, journal_root=journal_root, update_baseline=False
    )
    verification = metrics.get("verification") or {}
    return {
        "schema": "obs_ops_v1",
        "generated_at": _now_iso(),
        "battery": read_battery_record(),
        "versions": {
            "engine": _engine_version(),
            "packs": _pack_versions(),
            "models": _model_registry_versions(),
        },
        "ai_spend": metrics.get("ai_spend"),
        "journal": {
            **(metrics.get("journal") or {}),
            "verification": verification,
            "verified_ok": (
                bool(verification.get("checked"))
                and not verification.get("failed")
            ),
            "dlq_depth": metrics.get("dlq_depth", 0),
        },
        "sentinels": {
            "rates": sentinels.get("rates"),
            "notices": sentinels.get("notices"),
            "departures": sentinels.get("departures"),
        },
        "metrics": {
            "rates": metrics.get("rates"),
            "coverage": metrics.get("coverage"),
            "counters": metrics.get("counters"),
            "histograms": metrics.get("histograms"),
        },
    }
