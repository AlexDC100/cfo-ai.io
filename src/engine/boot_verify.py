"""Boot-time config validation. Called from `create_app()` once at startup.

Fail-fast policy (chosen narrowly to avoid breaking dev environments):
  · FAIL on the Supabase trio (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY) — without these the engine cannot read or
    write users / subscriptions / periods. There is no degraded mode worth
    starting.
  · WARN (log + continue) on everything else (Stripe, Anthropic, OpenAI,
    Nasdaq, ENGINE_API_TOKEN). Each surface degrades gracefully on its
    own — billing returns 503, AI panel falls back to deterministic prose,
    public companies module shows empty state — and the operator may
    intentionally not configure them in early dev.

Mode detection (LIVE vs TEST vs UNSET) is logged loudly at boot so the
container restart in compose-up shows it in `docker compose logs backend`.
"""
from __future__ import annotations

import logging
import os
from typing import List, Tuple

logger = logging.getLogger(__name__)


_CRITICAL: Tuple[str, ...] = (
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
)

# (env_name, what_breaks_without_it) — ordered by user-impact so the
# warning log is scannable.
_OPTIONAL: Tuple[Tuple[str, str], ...] = (
    ("STRIPE_SECRET_KEY",     "billing endpoints return 503"),
    ("STRIPE_WEBHOOK_SECRET", "Stripe webhooks rejected with 200 no-op"),
    ("STRIPE_PRICE_INTRO",    "Intro €0.99 checkout returns 503"),
    ("STRIPE_PRICE_STARTER",  "Starter checkout returns 503"),
    ("STRIPE_PRICE_PRO",      "Pro checkout returns 503"),
    ("ANTHROPIC_API_KEY",     "AI panel falls back to deterministic prose"),
    ("OPENAI_API_KEY",        "ai_orchestrator runs Claude-only (no GPT verifier)"),
    ("NASDAQ_DATA_LINK_API_KEY", "public companies module shows empty state"),
    ("APP_URL",               "Stripe redirects fall back to localhost:5173"),
    ("ENGINE_API_TOKEN",      "/run-daily endpoint unprotected"),
)


def verify_config() -> None:
    """Run on app boot. Raises RuntimeError on missing critical env."""
    missing_critical: List[str] = [k for k in _CRITICAL if not os.environ.get(k)]
    if missing_critical:
        raise RuntimeError(
            f"[boot_verify] FATAL — critical env vars missing: {missing_critical}. "
            f"The engine cannot reach Supabase without these. Fix /opt/cfo-ai/.env "
            f"and restart. (Set CFO_AI_SKIP_BOOT_VERIFY=1 to bypass — dev only.)"
        )

    # Mode banner — first thing in container logs after restart.
    sk = os.environ.get("STRIPE_SECRET_KEY", "")
    if sk.startswith("sk_live_"):
        mode = "LIVE — real charges enabled"
    elif sk.startswith("sk_test_"):
        mode = "TEST — Stripe test mode (4242 cards only)"
    elif sk:
        mode = f"INVALID — STRIPE_SECRET_KEY has unexpected prefix '{sk[:8]}'"
    else:
        mode = "UNSET — billing disabled"
    logger.warning("[boot_verify] Stripe mode: %s", mode)

    # Warn on missing optional, one line per gap so it's grep-friendly.
    missing_optional = [(k, why) for k, why in _OPTIONAL if not os.environ.get(k)]
    for k, why in missing_optional:
        logger.warning("[boot_verify] %s unset — %s", k, why)

    if not missing_optional:
        logger.warning("[boot_verify] all optional env vars present — full feature set active")


def verify_config_safe() -> None:
    """`verify_config` wrapped with the dev-only bypass. Use this from
    `create_app()`; let pytest / local dev set the env var to skip when
    the dev tree doesn't have a full .env."""
    if os.environ.get("CFO_AI_SKIP_BOOT_VERIFY") == "1":
        logger.warning("[boot_verify] skipped via CFO_AI_SKIP_BOOT_VERIFY=1")
        return
    verify_config()
