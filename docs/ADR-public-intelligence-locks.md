# ADR — Public Company AI Intelligence module locks

> Sister document to `docs/ADR-F3.16-closure.md`.
> Same discipline shape (numbered Locks documenting architectural failure
> classes prevented by code), applied to a different module.
> Date opened: 2026-05-27 with Phase A→D ship.

This module ships its own Lock stack because its failure classes are
genuinely different from the Romanian trial-balance engine's. F3.16's
Locks were about adapter/methodology coherence, plan-prediction discipline,
and gate-script deployability. The intelligence module's Locks are about
multi-source data provenance, deterministic-vs-LLM separation, and
multi-container observability honesty.

---

## Lock #1 — Process-local state must be labeled, not silently presented as cluster-wide

**Date locked**: 2026-05-27 (Phase D)
**Class of failure prevented**: A consumer reads `cache_hit_rate: 0.87`
from `/health`, assumes it's the cluster-wide hit rate, makes a
capacity decision based on a number that's actually one container's
since-last-restart counter. Decision is wrong by a factor of N (number
of pods). The error compounds when multi-container scaling is added
later and the field meaning silently shifts.

**Same shape as**:
- F3.16 Lock #9 (gate scripts must ship in Docker image, not depend on
  docker-cp residue)
- F3.16 Lock #10 (canonical adapter + methodology must share prefix
  coverage, not depend on overlapping-by-accident)

The pattern: infrastructure-dependent state that pretends to be
globally consistent. The fix: label the scope honestly so consumers
can't mistake the value for something it isn't.

**The rule**:
Any metric or counter whose value depends on which process served the
request MUST carry a scope label in the response payload. The
anti-pattern is fields like `cache_hit_rate: 0.87` with no scope
context, leaving the reader to assume cluster-wide aggregation.

**Concrete implementation (Phase D `/health` filings_cache block)**:

```json
{
  "filings_cache": {
    "hits": 142,
    "misses": 23,
    "cache_hit_rate": 0.86,
    "evictions_last_24h": 4,
    "metrics_scope": "container-local"  // ← the Lock-mandated label
  }
}
```

If we ever multi-pod deploy, the resolution is:
- Persist counters to Redis/DB (Phase E scope) — the metrics become
  genuinely cluster-wide
- OR change the label to `metrics_scope: "per-pod-sampled"` and have the
  consumer's metrics tool aggregate across pods

What we DON'T do: keep `metrics_scope` reading `cluster-wide` while the
underlying counters are still process-local. The label tracks reality.

**Tests that lock this in**:
- `test_phase_d.py::test_metrics_labeled_container_local` — asserts the
  scope label is present and exactly "container-local"

---

## Lock #2 — LLM never produces the deterministic numeric score

**Date locked**: 2026-05-27 (Phase A, reaffirmed Phase B + C)
**Class of failure prevented**: A future engineer thinks "we have Claude,
why not let it pick the risk score directly from the company data?" The
answer is that deterministic scores are reproducible (proven by
`test_determinism_same_inputs_same_output`) and LLM scores aren't. If
scores drift between runs, the entire confidence ladder is meaningless
because today's "75/100 critical" might be tomorrow's "55/100 medium"
on identical inputs.

**The rule**:
The numeric risk + opportunity scores are computed deterministically by
`risk_scoring_engine.py` and `opportunity_scoring_engine.py`. The LLM
INTERPRETS the score (writes the narrative in `ai_market_read.py`) but
NEVER produces or overrides it.

**Tests that lock this in**:
- `test_risk_scoring_engine.py::test_no_llm_in_score_path` — proves no
  network/anthropic deps in the scoring engine's import path
- `test_risk_scoring_engine.py::test_determinism_same_inputs_same_output`
  — 3 invocations produce identical scores + identical category
  breakdowns + identical top-risk ordering
- `test_ai_market_read.py::test_user_prompt_carries_deterministic_scores`
  — proves the LLM sees the score as INPUT with "do not override"
  guidance, never as output

---

## Lock #3 — Source labels must reflect actual provenance

**Date locked**: 2026-05-27 (Phase A, enforced through C)
**Class of failure prevented**: A user reads "source: filings · confidence
0.85" and trusts the data came from a 10-K. It actually came from the
sector library because the EDGAR fetch failed but the engine returned a
sector_model profile with `source: "filings"` due to a copy-paste error.
User makes a decision on misattributed provenance.

**The rule**:
The `source` field on every `CompanyExposureProfile` MUST honestly
reflect which resolution layer produced the profile:
- `manual` — operator override (confidence 0.95)
- `filings` — SEC EDGAR + Claude extraction (confidence 0.85)
- `ai_inferred` — Claude-only inference (confidence 0.70, reserved)
- `sector_model` — in-repo sector library (confidence 0.55)

**Anti-pattern explicitly forbidden**: confidence-weighted blending across
layers. If filings says "high oil exposure" (0.85) and sector_model says
"low oil exposure" (0.55), we pick filings outright and label it
`filings`. We do NOT compute a weighted average and label it some new
hybrid source. Honest labeling beats clever blending.

**Tests that lock this in**:
- `test_phase_c.py::test_filings_returns_none_when_ticker_not_in_cik_map`
  — filings path returns None on miss; caller falls back to sector
  model with correct `source: "sector_model"` label
- `test_phase_d.py::test_set_cached_refuses_non_filings_source` — the
  filings cache won't accept a non-filings profile, preventing
  cross-source pollution at the cache layer

---

## Lock #4 — Graceful degradation per provider, not all-or-nothing

**Date locked**: 2026-05-27 (Phase B)
**Class of failure prevented**: News API rate-limits us → entire intelligence
endpoint returns 503 → Risk Radar tab goes dark → users can't see ANY
risk data including the sector-library-only signals that don't depend on
NewsAPI at all.

**The rule**:
Every signal adapter implements the `SignalAdapter` Protocol. Each
adapter's `configured` property reports honestly whether its env is set,
and `fetch_recent_signals()` returns an empty list rather than raising
when the provider fails. The macro_signal_service aggregates whatever
each adapter returns; a single failing provider doesn't poison the rest.

Same discipline at the LLM layer: `compose_ai_market_read()` falls back
to a deterministic template when ANTHROPIC_API_KEY is unset, when the
Claude call fails, or when the LLM returns malformed JSON. The `/health`
endpoint surfaces `feed_status: "sector_model_only"` when no live
adapter is configured so the FE can render an honest banner.

**Tests that lock this in**:
- `test_phase_b_adapters.py::test_*_unconfigured_without_env_var` (×3) —
  each Phase B adapter reports configured=False + returns [] when env
  is missing
- `test_ai_market_read.py::test_compose_with_no_client_uses_deterministic`
  — no-key path returns deterministic-fallback narrative
- `test_ai_market_read.py::test_malformed_llm_output_triggers_fallback`
  — bad JSON from Claude → deterministic narrative, not 500

---

## Lock #5 — Refresh loops must not multiply provider load under horizontal scale

**Date locked**: 2026-05-27 (Phase D.2)
**Class of failure prevented**: We add an in-process scheduler that polls
EDGAR every 15 min from each backend container. We scale to 4 pods. EDGAR
suddenly sees 4× the request rate from the same User-Agent. SEC throttles
us; refresh loop stops working across ALL pods at once because they're
seen as one IP-shared offender.

**The rule**:
External orchestration for any periodic provider poll. Expose a POST
endpoint (`/refresh-filings-cache`) that performs ONE refresh on
invocation. The operator wires their existing cron / k8s CronJob /
Lambda to hit it on the right cadence. Single source of truth for the
schedule = single source of truth for the load.

Anti-pattern explicitly forbidden:
```python
# WRONG — multiplies by N pods
@app.on_event("startup")
async def schedule_refresh():
    asyncio.create_task(refresh_every_15_min())
```

Right pattern:
```bash
# In the operator's cron, NOT in the app
*/15 * * * * curl -X POST https://api/refresh-filings-cache
```

**Tests that lock this in**:
- `test_phase_d.py::test_run_refresh_only_invalidates_universe_tickers`
  — proves the refresh handler is idempotent + bounded (only operates
  on tickers we'd actually have cached)

---

## Notes for the next engineer

If a 6th Lock candidate emerges from a future Phase E or beyond, add it
here with the same shape:
1. Class of failure prevented (the concrete bug, in one sentence)
2. The rule (the discipline that prevents it)
3. Tests that lock it in (file::test_name references)

Don't add a Lock for a stylistic preference. Locks are for architectural
failure classes that have a way of sneaking back in when the codebase
grows. The test references are non-negotiable — without them the Lock is
documentation, not a lock.
