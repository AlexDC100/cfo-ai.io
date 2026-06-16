"""AICache — in-memory result cache keyed by request shape.

Cache key: SHA256 of (task_type, system_prompt, user_message, schema,
temperature). NOT keyed on task_id or metadata (those vary per call
without changing the answer).

Storage backend is pluggable. v1 ships in-memory (process-local dict
with TTL). Production will swap to Redis for cross-process sharing —
but the API is identical, so the swap is one constructor change.

TTL policy:
  · Deterministic tasks (extraction, classification): 30 days. The same
    document, the same prompt, the same model → same answer.
  · Analytical tasks (commentary, ratios, chat): 24 hours. Source data
    might be re-uploaded; recent results stay fresh.
  · Default (unknown task): 1 hour. Safe-side; pay the cost again sooner
    than serve a stale answer.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

from .types import AIRequest, ContentPart, ExecutionResult, TaskType, TextPart

logger = logging.getLogger(__name__)


# Per-task-type TTL in seconds. Falls back to _DEFAULT_TTL.
_TTL_BY_TASK: Dict[TaskType, int] = {
    # Deterministic / high-stakes extraction — long TTL
    TaskType.EXTRACT_TRIAL_BALANCE: 30 * 24 * 3600,
    TaskType.EXTRACT_BALANCE_SHEET: 30 * 24 * 3600,
    TaskType.EXTRACT_PNL: 30 * 24 * 3600,
    TaskType.EXTRACT_SKU_LIST: 30 * 24 * 3600,
    TaskType.CLASSIFY_ACCOUNT_TO_COA: 30 * 24 * 3600,
    TaskType.CLASSIFY_SKU_CATEGORY: 30 * 24 * 3600,
    TaskType.DETECT_COA: 30 * 24 * 3600,
    TaskType.DETECT_INDUSTRY: 7 * 24 * 3600,
    TaskType.TRANSLATE_FINANCIAL_TERM: 30 * 24 * 3600,

    # Analytical — shorter; source data may evolve
    TaskType.REASON_FINANCIAL_RATIOS: 24 * 3600,
    TaskType.REASON_BENCHMARK_COMPARE: 24 * 3600,
    TaskType.GENERATE_CFO_COMMENTARY: 24 * 3600,
    TaskType.GENERATE_REPORT_SECTION: 24 * 3600,

    # Conversational — short; same question may want a fresh answer
    TaskType.ASK_CFO_AI_CHAT: 60 * 60,
}
_DEFAULT_TTL = 3600


@dataclass
class _CacheEntry:
    result: ExecutionResult
    expires_at: float


class AICache:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._store: Dict[str, _CacheEntry] = {}
        self._hits = 0
        self._misses = 0

    # ── Public API ────────────────────────────────────────────────────

    def get(self, req: AIRequest) -> Optional[ExecutionResult]:
        key = self._key(req)
        now = time.time()
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                self._misses += 1
                return None
            if entry.expires_at < now:
                # Lazy expiry — clean up on access
                del self._store[key]
                self._misses += 1
                return None
            self._hits += 1
            return entry.result

    def set(self, req: AIRequest, result: ExecutionResult) -> None:
        key = self._key(req)
        ttl = _TTL_BY_TASK.get(req.task_type, _DEFAULT_TTL)
        with self._lock:
            self._store[key] = _CacheEntry(result=result, expires_at=time.time() + ttl)

    def stats(self) -> Dict[str, int]:
        """Cache hit/miss counters for telemetry / dashboards."""
        with self._lock:
            total = self._hits + self._misses
            hit_rate = (self._hits / total) if total > 0 else 0.0
            return {
                "hits": self._hits,
                "misses": self._misses,
                "size": len(self._store),
                "hit_rate_pct": round(hit_rate * 100, 1),
            }

    def clear(self) -> None:
        with self._lock:
            self._store.clear()
            self._hits = 0
            self._misses = 0

    # ── Key derivation ────────────────────────────────────────────────

    @staticmethod
    def _key(req: AIRequest) -> str:
        """Stable hash of the request shape. Excludes task_id and
        metadata (those vary per-call without changing the answer)."""
        payload = {
            "task_type": req.task_type.value,
            "system": req.system_prompt,
            "user": AICache._normalize_user(req.user_message),
            "schema": req.output_schema,
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
        }
        canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    @staticmethod
    def _normalize_user(user_message) -> object:
        if isinstance(user_message, str):
            return user_message
        # Multimodal parts → dict for stable hashing
        out = []
        for part in user_message:
            if isinstance(part, TextPart):
                out.append({"type": "text", "text": part.text})
            else:
                # Hash binary content by its own hash to avoid huge
                # blobs in the cache key.
                data = getattr(part, "data_b64", "") or getattr(part, "url", "")
                out.append({
                    "type": getattr(part, "type", "unknown"),
                    "data_hash": hashlib.sha256(str(data).encode()).hexdigest(),
                    "media_type": getattr(part, "media_type", None),
                })
        return out
