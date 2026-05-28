# Public Intelligence — Activation Runbook

> Step-by-step for going from "shipped to repo" → "live in production"
> for Phase A through D of the public-company AI intelligence module.

## Pre-activation state

- ✓ 131/131 tests pass on dev (Phase A 63 + B 27 + C 19 + D 22 incl. 3 synthetic)
- ✓ Lock stack documented in `docs/ADR-public-intelligence-locks.md`
- ✓ Source-of-truth ladder documented in
  `docs/public-company-intelligence-ladder.md`
- ❌ Production backend at cfo-ai.io still runs pre-Phase-A code
- ❌ `supabase/schema_phase_intelligence_engine.sql` not yet applied
- ❌ Env vars not set
- ❌ EDGAR refresh cron not wired

Activation moves the right-column boxes to ✓.

---

## Step 0 — Apply SQL migration

Through Supabase Studio (NOT via psql — F3.24 protocol):

1. Open Supabase Studio → SQL Editor
2. Paste contents of `supabase/schema_phase_intelligence_engine.sql`
3. Run
4. Click **Settings → API → "Reload schema cache"** (deterministic step
   per F3.24; NOTIFY pgrst is only optimistic on Supabase managed
   infra)
5. Verify the 8 new tables exist (`intelligence_signals`,
   `company_exposure_profiles`, `public_company_risk_scores`,
   `public_company_opportunity_scores`, `sector_risk_models`,
   `company_signal_links`, `macro_signal_cache`, `risk_interpretations`)

## Step 1 — Edit `/opt/cfo-ai/.env`

Append (or set, if any already exist from earlier work):

```bash
# Phase B
ANTHROPIC_API_KEY=sk-ant-...        # if not already set for the briefing path
# (Optional Phase B live feeds — add the ones you want)
NEWS_API_KEY=                       # newsapi.org — 100/day free tier
RSS_FEED_URLS=                      # comma-separated URLs
FRED_API_KEY=                       # fred.stlouisfed.org — free

# Phase C
SEC_EDGAR_ENABLED=1
EIA_API_KEY=                        # eia.gov/opendata — free
```

## Step 2 — §14 deploy

```bash
# On the VPS
scp src/engine/public/intelligence/* root@vps:/opt/cfo-ai/src/engine/public/intelligence/
# (use per-file destinations to avoid the F3.14 rsync-collision class)
cd /opt/cfo-ai
docker compose build backend && docker compose up -d backend
```

## Step 3 — Wire the EDGAR refresh cron

15-minute cadence (per Lock #5 — external orchestration, not in-process):

```bash
# On the VPS (operator's existing cron):
crontab -e
# Append:
*/15 * * * * curl -X POST -s https://cfo-ai.io/api/public/intelligence/refresh-filings-cache > /dev/null 2>&1
```

(Or wire to your k8s CronJob / Lambda if that's the existing pattern.)

## Step 4 — Cold-cache fill smoke test

8 tickers across sectors + market-cap tiers:

```bash
for t in AAPL XOM JPM TSLA HAIN USPH CMCO ADUS; do
  echo "=== $t ==="
  curl -s "https://cfo-ai.io/api/public/intelligence/companies/$t/exposure" \
    | jq '{ticker, source, confidence}'
done
```

Expected first-call latency: 10–20s per ticker (EDGAR fetch + Claude
extraction). Subsequent calls < 100ms. Total time for 8 cold tickers
≈ 2 minutes, total Claude cost ≈ $2–4.

After the loop, every ticker should show `source: "filings"` and
`confidence: 0.85` (or `source: "sector_model"` with `confidence: 0.55`
if that specific ticker has no extractable 10-K — common for foreign ADRs
filing 20-F).

## Step 5 — Wait ≥30 min, then warm-cache hit-rate verification

This is the step that catches a class of bug where the cache EXISTS but
isn't being read on the hot path (early-return on `get_cached()` may be
misplaced, in-memory TTL might expire faster than expected, etc.):

```bash
# Reset metrics baseline
curl -s https://cfo-ai.io/api/public/intelligence/health | jq '.filings_cache'
# Capture { hits: X, misses: Y }

# Re-hit a ticker 3 times in succession
for i in 1 2 3; do
  curl -s "https://cfo-ai.io/api/public/intelligence/companies/AAPL/exposure" \
    | jq '.source'
done
# Should print "filings" three times

# Re-read metrics
curl -s https://cfo-ai.io/api/public/intelligence/health | jq '.filings_cache'
# Expect: hits: X+3, misses: Y (unchanged)
```

**If `hits` increment by 3 and `misses` doesn't change**: cache hit-path
is firing correctly. Activation verified.

**If `misses` increases or `hits` doesn't increment by 3**: the cache
exists but isn't being read on the hot path. Something is bypassing
`get_cached()`. Check the `filings_extractor.try_filings_derived_profile`
early-return logic — that's the most likely place for the regression.

## Step 6 — Verify EDGAR refresh ran at least once

After 15+ minutes have passed:

```bash
curl -s https://cfo-ai.io/api/public/intelligence/health | jq '.filings_cache.last_invalidation_at'
```

`null` is fine if no new 10-Ks were filed in your window (common during
off-hours). To verify the endpoint works, hit it manually:

```bash
curl -s -X POST https://cfo-ai.io/api/public/intelligence/refresh-filings-cache | jq
# Expect: { fetched_filing_count, universe_matches, invalidated, ... }
```

If `error` is set in the response, EDGAR is unreachable or rate-limiting
us. Investigate the User-Agent string + cron cadence.

## Step 7 — Verify per-adapter health

```bash
curl -s https://cfo-ai.io/api/public/intelligence/health | jq '.adapters, .feed_status'
```

`feed_status` reads:
- `"live_feed_active"` — at least one of news/rss/commodity/rates/geopolitical
  is configured (env var set)
- `"sector_model_only"` — no live feeds configured; the engine runs on
  sector library + filings only

Each adapter in `.adapters` should show its honest `configured` flag +
reason. If you set NEWS_API_KEY, the news adapter should flip to
`configured: true` with no `reason` field.

---

## What "verified" looks like

After Steps 0–7, the prod backend reports:
- `filings_cache.cache_hit_rate` > 0.5 (hot tickers cached, warming up)
- `filings_cache.total_entries` ≥ 8 (your smoke test)
- `filings_cache.oldest_entry_age_seconds` < 60 × 60 × 24 (younger than
  1 day; will grow toward 7 days × 24h × 3600s before getting evicted)
- `filings_cache.metrics_scope: "container-local"` (honest label)
- `feed_status: "sector_model_only"` (until you add a live feed key)
- All 4 of news/rss/commodity/rates adapters show `configured: false`
  with `reason` text (because env vars unset by default — set the ones
  you want)

---

## Rollback

If something looks wrong:

```bash
# Disable filings — falls back to sector_model immediately
# /opt/cfo-ai/.env:
SEC_EDGAR_ENABLED=0

docker compose up -d backend     # picks up env without rebuild
```

The cache rows stay in `company_exposure_profiles` but aren't read
(filings_extractor short-circuits on env check). To purge them:

```sql
DELETE FROM company_exposure_profiles WHERE source = 'filings';
```

The Phase A→D code itself can also be reverted via `git revert` of the
relevant commits — none of it depends on the Phase A SQL migration once
disabled.

---

## Known gaps (per Lock-stack discipline, surface honestly)

1. **Empty-result caching not implemented** (Phase D.5 deferred).
   `test_synthetic_empty_result_caching_gap_documented` documents this.
   Cost amplifier: tickers in the universe that don't file 10-Ks (e.g.
   foreign ADRs filing 20-F) trigger a full EDGAR + Claude chain on
   every drawer-open until either (a) the operator runs the
   `refresh-filings-cache` invalidation cycle that surfaces it, or
   (b) we implement Phase D.5.

2. **Container-local metrics** — when this deployment scales beyond one
   pod, the `/health` `filings_cache` block's counter fields become
   per-pod-sampled. The `metrics_scope` label tracks reality; Phase E
   (Redis counters) is the path to genuine cluster-wide aggregation.

3. **No 10-Q quarterly extraction** — only 10-K (annual). Risk-factor
   wording shifts quarterly but we don't extract 10-Q. Add when an
   operator asks.
