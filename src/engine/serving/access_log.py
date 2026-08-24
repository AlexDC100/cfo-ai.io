"""Facts-gateway access log (E1 trust-boundary seam) — append-only JSONL.

Every construction of the served-truth reader (``FactsGateway
.from_envelope`` — the ONE public entry through which served facts are
obtained) appends one record

    {"who": <caller module>, "when": <ISO-8601 UTC>,
     "doc": <provenance snapshot id or null>, "accessor": <entry name>}

to ``data/obs/facts_access.jsonl`` (the existing gitignored ``data/``
storage convention — locally the repo's ``data/`` tree, in-container the
mounted ``/app/data`` volume; NO new datastore).

Discipline (same contract as engine.journal.hooks):
  * NEVER raises and NEVER mutates its arguments — an access-log failure
    is swallowed; gateway behavior is identical with the log on, off,
    or broken.  Observability must not become a serving gate.
  * Additive-only observability: nothing reads this file at runtime; it
    exists for the operator's "who read which document, when" question.
  * Env surface:
      ``ENGINE_ACCESS_LOG``      — unset/1/true = on (default ON: the
                                   record is the point of the seam);
                                   0/false/no/off = fully disabled.
      ``ENGINE_ACCESS_LOG_DIR``  — target directory override (tests
                                   point it at tmp; prod may point it at
                                   the mounted volume explicitly).
                                   Default: ``<cwd>/data/obs``.

``who`` resolution: the nearest stack frame OUTSIDE ``engine.serving``
(so the record names the consuming module — advisory, API serializer, a
test — never the gateway package itself). Explicit ``who=`` wins.

Locked by tests/engine/test_access_log.py (A1-A5, written red-first).
"""

from __future__ import annotations

import json
import os
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

ENV_ENABLE = "ENGINE_ACCESS_LOG"
ENV_DIR = "ENGINE_ACCESS_LOG_DIR"

#: File name inside the target directory. One file, append-only.
LOG_BASENAME = "facts_access.jsonl"

#: Values of ENGINE_ACCESS_LOG that switch the seam OFF.
_OFF_VALUES = ("0", "false", "no", "off")

_WRITE_LOCK = threading.Lock()


def enabled() -> bool:
    """Default ON; ``ENGINE_ACCESS_LOG=0`` (or false/no/off) disables."""
    return os.environ.get(ENV_ENABLE, "").strip().lower() not in _OFF_VALUES


def log_path() -> Path:
    """The JSONL target, honoring ``ENGINE_ACCESS_LOG_DIR``."""
    root = os.environ.get(ENV_DIR, "").strip()
    base = Path(root) if root else (Path("data") / "obs")
    return base / LOG_BASENAME


def _caller_module() -> str:
    """Nearest stack frame outside engine.serving — the consumer whose
    read this record attributes. Best-effort; never raises."""
    try:
        frame = sys._getframe(2)  # skip _caller_module + record_access
        while frame is not None:
            name = frame.f_globals.get("__name__", "")
            if name and not str(name).startswith("engine.serving"):
                return str(name)
            frame = frame.f_back
    except Exception:  # noqa: BLE001 — attribution is best-effort
        pass
    return "unknown"


def record_access(*, doc: Optional[str], accessor: str,
                  who: Optional[str] = None) -> None:
    """Append one access record. NEVER raises — any failure (disabled
    seam aside) is swallowed so observability can never block serving."""
    try:
        if not enabled():
            return
        record = {
            "who": who if who else _caller_module(),
            "when": datetime.now(timezone.utc).isoformat(),
            "doc": doc,
            "accessor": accessor,
        }
        line = json.dumps(record, sort_keys=True, ensure_ascii=False)
        path = log_path()
        with _WRITE_LOCK:
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
    except Exception:  # noqa: BLE001 — the seam must never break a read
        pass
