# Public Company AI Intelligence — Source-of-Truth Ladder

> **Audience**: the next engineer (or future you) opening
> `src/engine/public/intelligence/` cold.
> **Date locked**: 2026-05-27.

## TL;DR

Per-ticker exposure data (geographic / supply-chain / financial-sensitivity
maps + named risks/opportunities) is resolved in **strict order of
confidence**. Each layer has a constant confidence value the FE renders
as a badge; users always see where the data came from.

| Order | Source | Confidence | Activation | Phase |
|---|---|---|---|---|
| 1 | `manual` (operator override) | 0.95 | Always available | A |
| 2 | `filings` (SEC EDGAR 10-K + Claude Opus extraction) | 0.85 | `SEC_EDGAR_ENABLED=1` + `ANTHROPIC_API_KEY` | C |
| 3 | `ai_inferred` (Claude-only, no filing) | 0.70 | Reserved enum slot (not yet implemented) | C+ |
| 4 | `sector_model` (in-repo sector_risk_library) | 0.55 | Always available | A |
| 5 | (unknown sector) | 0.00 | Empty profile fallback | A |

## The contract

The resolution function is
`company_exposure_service.build_company_exposure_profile(ticker, …)`.
Each layer is tried in order; the first to return a profile wins. The
profile's `source` field carries the layer label honestly. Downstream
code (`risk_scoring_engine`, `risk_radar`, `ai_market_read`) reads only
the profile shape — never the source — so swapping layers doesn't ripple.

## Why this design ages well

When a new provider comes online (e.g. an analyst-research feed at
confidence 0.75 between `filings` and `ai_inferred`), it slots in at its
own tier without rewiring downstream code. Add a `ExposureSource` enum
value, add a resolution step at the right priority, add tests. Existing
risk-scoring code consumes the result unchanged because the profile
shape is stable.

## Two invariants that aren't going anywhere

1. **The LLM NEVER produces the deterministic numeric risk score.**
   Tests enforce this (`test_no_llm_in_score_path`,
   `test_user_prompt_carries_deterministic_scores`). The score comes
   from `risk_scoring_engine.compute_risk_score` — a deterministic
   weighted sum of category scores derived from the exposure profile
   + financial snapshot + matched signals. The LLM interprets the
   score in `ai_market_read.compose_ai_market_read` but never overrides
   it. If you ever feel the urge to "let Claude pick the number" —
   stop. The whole confidence ladder is meaningless if scores aren't
   reproducible.

2. **Source labels never lie.** The FE renders a badge like
   "source: filings · confidence 0.85" on every exposure surface. A
   user reading that knows the data came from a 10-K, not invented.
   Don't fall into the trap of "let's blend filings + sector_model
   for a smoother answer" — that breaks the contract. Either we have
   the data (filings) or we don't (sector_model). Show the user which.

## Caching (Phase D)

Filings extraction is expensive (3 EDGAR HTTP calls + 1 Claude Opus
call per ticker). The cache lives in `filings_cache.py`:

- **DB-primary**: `company_exposure_profiles` table is the source of
  truth. Survives container restarts + horizontal scale.
- **In-memory**: 5-minute TTL read-through for hot tickers.
  Process-local; never the source of truth.
- **TTL**: 7 days. Refreshed sooner by the EDGAR RSS loop
  (`filings_refresh.py`) when SEC publishes a new 10-K for a cached
  ticker.

The reverse architecture (in-memory primary, DB backup) would create
split-brain on multi-container deploys. Don't do that.

## Freshness loop (Phase D.2)

`POST /api/public/intelligence/refresh-filings-cache` polls EDGAR's
`getcurrent` Atom feed → invalidates cached profiles for any ticker
that just filed a new 10-K. Operator wires this to a 15-minute cron
or k8s CronJob (DON'T run in-process per container — that multiplies
EDGAR load by N pods).

Invalidations are lazy: we drop the cached profile but don't pre-warm.
The next user request triggers re-extraction. This smooths the load
when SEC publishes batches.

## Observability (Phase D.3)

`/api/public/intelligence/health` exposes a `filings_cache` section
with: `hits`, `misses`, `cache_hit_rate`, `evictions_last_24h`,
`total_entries`, `oldest_entry_age_seconds`, `last_invalidation_at`.

The counter fields are labeled `metrics_scope: "container-local"`
because they're process-local (not aggregated across pods). If/when
we go multi-container, either persist counters to a Redis-like (Phase
E) or query each container individually and aggregate. Don't trust the
single-pod number as cluster-wide.

## File map

```
src/engine/public/intelligence/
  __init__.py
  models.py                       # dataclasses + type aliases
  sector_risk_library.py          # 12 sectors + 10 themes (Phase A data)
  company_exposure_service.py     # the resolution function — the heart
  risk_scoring_engine.py          # deterministic 0–100 score (no LLM)
  opportunity_scoring_engine.py   # symmetric opportunity score
  macro_signal_service.py         # adapter aggregation + feed_status
  signal_orchestrator.py          # signal→ticker linking
  intelligence_cache.py           # short-TTL in-memory for radar/signals
  ai_market_read.py               # Claude Opus narrative (Phase B)
  filings_extractor.py            # SEC EDGAR → Claude → profile (Phase C)
  filings_cache.py                # DB-primary 7-day cache (Phase D.1)
  filings_refresh.py              # EDGAR Atom poll → cache invalidation (Phase D.2)
  routes.py                       # 12 FastAPI endpoints
  adapters/
    base.py                       # SignalAdapter Protocol + AdapterHealth
    manual_signal_adapter.py      # operator paste (always configured)
    rss_signal_adapter.py         # Phase B
    news_signal_adapter.py        # Phase B
    rates_signal_adapter.py       # Phase B (FRED)
    commodity_signal_adapter.py   # Phase C (EIA)
    stubs.py                      # geopolitical placeholder
```

## What still isn't built (and that's fine)

- **Geopolitical adapter** — GDELT integration was held in Phase C.
  Reason: signal density + country-to-sector mapping require operator
  feedback we don't have yet. Building speculatively would burn time
  on the wrong abstractions.
- **DB persistence for manual signals** — tech debt. Manual signal
  store is in-memory. The schema exists from Phase A migration; wire
  it when we have operator workflows that actually create signals
  (right now: zero).
- **Confidence-weighted blending across layers** — explicitly NOT a
  goal. See invariant #2.
- **10-Q quarterly extraction** — only 10-K (annual) today. 10-Qs
  shift risk-factor wording quarterly but we don't extract them.
  Add when an operator asks.
