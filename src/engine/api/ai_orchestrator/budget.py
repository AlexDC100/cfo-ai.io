"""BudgetGuard — admission control for AI calls.

Two ceilings:
  · Per-user daily cap: derived from plan tier (free/trial/starter/pro).
    Prevents one user from draining the AI budget.
  · Global daily cap (AI_BUDGET_DAILY_CAP_USD env): circuit breaker for
    runaway costs across all users. Trips when crossed; alerts ops.

This module deliberately does NOT decide the per-plan cap — that comes
from the pricing config (`/api/pricing/config`). The guard just enforces
whatever the plan layer says.

v1 implementation: in-memory spend counter per user, reset daily at
UTC midnight. v2 will move to Postgres so the cap survives restarts +
load-balanced backend instances.
"""

from __future__ import annotations

import datetime as _dt
import logging
import os
import threading
from collections import defaultdict
from typing import Dict, Optional

from .errors import BudgetExceededError

logger = logging.getLogger(__name__)


# Default per-plan daily caps (USD). Override via env at deploy time
# OR feed from the pricing config layer in production.
_DEFAULT_PLAN_CAPS_USD: Dict[str, float] = {
    "trial":   1.00,    # 7-day trial: 1 doc × ~$0.50 + headroom
    "intro":   0.75,    # single doc only
    "starter": 5.00,    # 5 docs/mo × ~$0.50 + commentary
    "pro":     20.00,   # 15 docs/mo + heavy commentary + chat
}
# Anyone without a recognized plan gets the trial cap as the safe default.
_UNKNOWN_PLAN_CAP_USD = 0.50

# Global circuit-breaker — hard stop across all users/orgs if exceeded.
_GLOBAL_CAP_ENV = "AI_BUDGET_DAILY_CAP_USD"
_GLOBAL_CAP_DEFAULT = 200.0


class BudgetGuard:
    def __init__(self, plan_caps_usd: Optional[Dict[str, float]] = None) -> None:
        self._plan_caps = plan_caps_usd or dict(_DEFAULT_PLAN_CAPS_USD)
        self._global_cap = float(os.environ.get(_GLOBAL_CAP_ENV, _GLOBAL_CAP_DEFAULT))
        self._lock = threading.Lock()
        # Spend tracking — keyed by (user_id, utc_date_str)
        self._user_spend: Dict[tuple, float] = defaultdict(float)
        # Global spend — keyed by utc_date_str
        self._global_spend: Dict[str, float] = defaultdict(float)

    def assert_within_budget(
        self,
        *,
        user_id: Optional[str],
        plan_key: Optional[str],
        estimated_cost_usd: float,
    ) -> None:
        """Raise BudgetExceededError if the call would push the user
        OR the global counter over its cap. Idempotent — caller can
        retry with a smaller request and pass again."""
        today = _today_utc()

        # Global circuit-breaker first (cheap check, prevents runaway).
        with self._lock:
            global_after = self._global_spend[today] + estimated_cost_usd
            if global_after > self._global_cap:
                logger.warning(
                    "[budget] global cap hit: %.4f + %.4f > %.2f",
                    self._global_spend[today], estimated_cost_usd, self._global_cap,
                )
                raise BudgetExceededError(
                    "Daily AI budget circuit-breaker tripped",
                    details={
                        "scope": "global",
                        "cap_usd": self._global_cap,
                        "spent_today_usd": self._global_spend[today],
                    },
                )

        # Per-user cap (skip if no user_id — internal/system calls).
        if not user_id:
            return

        cap = self._plan_caps.get(plan_key or "", _UNKNOWN_PLAN_CAP_USD)
        with self._lock:
            user_key = (user_id, today)
            user_after = self._user_spend[user_key] + estimated_cost_usd
            if user_after > cap:
                logger.info(
                    "[budget] user %s plan=%s cap=%.2f hit: %.4f + %.4f",
                    user_id, plan_key, cap, self._user_spend[user_key], estimated_cost_usd,
                )
                raise BudgetExceededError(
                    "Daily AI usage cap reached for your plan",
                    details={
                        "scope": "user",
                        "plan_key": plan_key,
                        "cap_usd": cap,
                        "spent_today_usd": round(self._user_spend[user_key], 4),
                    },
                )

    def record_actual_cost(
        self,
        *,
        user_id: Optional[str],
        actual_cost_usd: float,
    ) -> None:
        """Record post-call actual cost so future admission checks are
        accurate. Always called after a successful (or failed) call to
        keep the meter honest."""
        today = _today_utc()
        with self._lock:
            self._global_spend[today] += actual_cost_usd
            if user_id:
                self._user_spend[(user_id, today)] += actual_cost_usd

    def remaining_for_user(
        self,
        *,
        user_id: str,
        plan_key: Optional[str],
    ) -> float:
        """How many USD of headroom remains today. Useful for UI hints
        ('You have $0.42 of AI budget remaining today')."""
        today = _today_utc()
        cap = self._plan_caps.get(plan_key or "", _UNKNOWN_PLAN_CAP_USD)
        with self._lock:
            spent = self._user_spend.get((user_id, today), 0.0)
        return max(0.0, cap - spent)


def _today_utc() -> str:
    """UTC date as YYYY-MM-DD. Day boundaries are UTC for predictable
    rollover regardless of where the VPS lives."""
    return _dt.datetime.now(_dt.timezone.utc).date().isoformat()
