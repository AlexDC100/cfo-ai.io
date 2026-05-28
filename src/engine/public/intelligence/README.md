# Public Company AI Intelligence

Macro-to-micro risk reasoning layer for the public-company surfaces. Sits
alongside the trial-balance engine and the Sharadar adapter; never imports
from either. Produces per-ticker risk + opportunity scores, exposure
profiles, macro signal aggregation, and a Claude Opus narrative ("AI Market
Read") that interprets — never produces — the deterministic score.

## Source-of-truth ladder

Every `CompanyExposureProfile` carries a `source` label saying which
resolution layer produced it, and a confidence value the FE renders as a
badge. Layers are tried in strict order; the first one to return a profile
wins. No blending across layers — honest labeling beats clever averaging.

| Order | `source` | Confidence | When it fires |
|-------|----------|------------|---------------|
| 1 | `manual` | **0.95** | Operator override exists for this ticker |
| 2 | `filings` | **0.85** | `SEC_EDGAR_ENABLED=1` and Claude extracted the Risk Factors section from the latest 10-K |
| 3 | `ai_inferred` | **0.70** | Reserved enum slot — Claude-only inference without a filing. Not yet implemented |
| 4 | `sector_model` | **0.55** | Always available — the in-repo `sector_risk_library.py` (12 sectors × 10 themes) |
| 5 | empty | 0.00 | Unknown sector — last-resort fallback |

The numeric risk + opportunity scores are computed **deterministically**
from the profile + financial snapshot + matched signals
(`risk_scoring_engine.py`, `opportunity_scoring_engine.py`). The LLM in
`ai_market_read.py` reads the score as input and writes the narrative; it
never produces or overrides the number. Reproducibility of scores is
non-negotiable — see `test_no_llm_in_score_path` +
`test_determinism_same_inputs_same_output`.

## Deeper docs

- `docs/public-company-intelligence-ladder.md` — full ladder + file map +
  caching design + freshness loop.
- `docs/ADR-public-intelligence-locks.md` — five architectural Locks
  (process-local labeling, LLM never produces score, source labels never
  lie, graceful degradation per provider, refresh loops not multiplying
  load).
- `docs/public-intelligence-activation-runbook.md` — step-by-step
  activation runbook including the warm-cache hit-rate verification.
- `docs/PUBLIC-COMPANY-AI-INTELLIGENCE-PLAN.md` — original 25-section
  design brief.

## Activation summary

Disabled-by-default. Set `SEC_EDGAR_ENABLED=1` + `ANTHROPIC_API_KEY` to
turn on the filings layer; without those, the engine degrades cleanly to
sector-model-only with `feed_status: "sector_model_only"` on
`/api/public/intelligence/health`. Each Phase B+C adapter
(`NEWS_API_KEY`, `RSS_FEED_URLS`, `FRED_API_KEY`, `EIA_API_KEY`) is
independently optional — missing env = adapter reports
`configured=false` honestly and the route's `feed_status` reflects
reality.
