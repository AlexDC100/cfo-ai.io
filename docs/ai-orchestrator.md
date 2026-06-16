# AI Orchestrator — Multi-Model Intelligence Layer

> **Status:** MVP live on production. Claude Opus 4.7 path verified end-to-end. GPT-5 verifier path coded, awaiting `OPENAI_API_KEY` to activate.
> **Owner:** Alex
> **Location:** `src/engine/api/ai_orchestrator/`

## 1 · What it does

Routes each LLM task to the best-fit model, cross-checks high-stakes outputs with an independent verifier, and arbitrates disagreements with a third pass. Same architecture as the spec, implemented in Python alongside the existing FastAPI engine.

```
Application call
    │
    ▼
AIOrchestrator.execute(req)
    │
    ├─ 1. Cache check       (hit → return, no API call)
    ├─ 2. Budget pre-check  (over plan/global cap → BudgetExceededError)
    ├─ 3. Route             (picks primary + verifier from routing_config)
    ├─ 4. Primary call      (Claude or GPT, whichever the rule says)
    ├─ 5. Verifier call     (only if rule asks for it AND verifier available)
    ├─ 6. Verify            (numeric / structured / semantic compare)
    ├─ 7. Reconcile         (primary | primary+conflicts | arbitrate)
    ├─ 8. Cache             (30d for extraction, 24h for analytical)
    └─ 9. Telemetry         (JSONL append for the feedback loop)
```

Single entry point: `AIOrchestrator.execute(req)`. Adapters, router, verifier, reconciler, cache, telemetry, and budget guard are all swappable for tests.

## 2 · File map

```
src/engine/api/ai_orchestrator/
├── __init__.py                       — public API + build_default_orchestrator()
├── types.py                          — AIRequest, AIResponse, TaskType, schemas
├── errors.py                         — typed errors with i18n keys + http status
├── adapters/
│   ├── base.py                       — BaseAdapter (cost arithmetic helpers)
│   ├── claude_adapter.py             — Anthropic SDK wrapper
│   └── gpt_adapter.py                — OpenAI SDK wrapper (graceful no-key degrade)
├── router.py                         — picks (primary, verifier) per task
├── routing_config.py                 — task → (primary, verifier, rationale) table
├── verifier.py                       — compare_numeric / structured / semantic
├── reconciler.py                     — full | partial | arbitration branching
├── cache.py                          — in-memory TTL cache keyed by request hash
├── telemetry.py                      — JSONL append-only feedback-loop log
├── budget.py                         — per-user + global daily $ caps
├── orchestrator.py                   — AIOrchestrator (the entry point)
└── prompts/
    ├── __init__.py
    └── extract_trial_balance.py      — system prompt + JSON schema + verification schema

tests/ai_orchestrator/
└── test_orchestrator.py              — 7 tests covering all paths (full/partial/conflict/arbitration/fallback/budget/cache)
```

## 3 · Live verification (run today)

```
$ docker exec cfo-ai-backend python3 -m pytest tests/ai_orchestrator -v
============================== 7 passed in 1.05s ===============================

$ docker exec cfo-ai-backend python3 -c "from engine.api.ai_orchestrator import build_default_orchestrator, AIRequest, TaskType; \
  orch = build_default_orchestrator(); \
  req = AIRequest(task_id='live-001', task_type=TaskType.DETECT_INDUSTRY, \
    system_prompt='Classify the company industry from the data given.', \
    user_message='Patiseria Bunica SRL. Revenue 4.2M RON, flour/sugar/packaging inventory, bakers + drivers.', \
    output_schema={'type':'object','required':['industry','confidence'], \
      'properties':{'industry':{'type':'string'},'confidence':{'type':'number'}}}, \
    metadata={'user_id':'live','plan_key':'pro'}); \
  r = orch.execute(req); \
  print(r.response.content, r.response.model, f'\${r.response.usage.estimated_cost_usd:.4f}')"

{'industry': 'Bakery & Pastry Manufacturing', 'confidence': 0.95}  claude-opus-4-7  $0.0072
```

## 4 · Required operator actions to activate full multi-model path

### 4.1 OPENAI_API_KEY (critical — GPT verifier path is dark without this)

Add the OpenAI key to the backend `.env` on the VPS:

```bash
# On VPS as root:
echo 'OPENAI_API_KEY=sk-...your_key_here...' >> /opt/cfo-ai/.env
# Optional: set a global circuit-breaker daily cap (default $200)
echo 'AI_BUDGET_DAILY_CAP_USD=100' >> /opt/cfo-ai/.env

# Restart backend (env file is read on container start)
cd /opt/cfo-ai && docker compose up -d backend

# Verify GPT is now available
docker exec cfo-ai-backend python3 -c "from engine.api.ai_orchestrator import GPTAdapter; print(GPTAdapter().available)"
# → True
```

Once that returns `True`, every high-stakes task (`extract.trial_balance`, `extract.balance_sheet`, `extract.pnl`, `generate.cfo_commentary`, …) automatically gets the Claude+GPT cross-check.

### 4.2 Telemetry log directory (optional)

Default: `/var/log/cfo-ai/orchestrator.jsonl`. The orchestrator creates the dir best-effort; if the path isn't writable, telemetry is silently skipped (calls still succeed). To explicitly point elsewhere:

```bash
echo 'AI_TELEMETRY_PATH=/opt/cfo-ai/data/orchestrator.jsonl' >> /opt/cfo-ai/.env
```

A logrotate config (rotate daily, keep 30 days) is recommended once volume builds up.

## 5 · How to wire a new task

Five-step pattern. Use `extract.trial_balance` as the template.

1. **Add TaskType enum entry** in `types.py`
2. **Add routing rule** in `routing_config.py` — pick primary, verifier, rationale
3. **Write prompt + schema** in `prompts/<task_name>.py`:
   - `SYSTEM_PROMPT` — same prompt used by primary, verifier, and arbiter
   - `OUTPUT_SCHEMA` — JSON Schema dict for structured output
   - `VERIFICATION_SCHEMA` — comparison strategy (numeric / structured / semantic, tolerance, per-field severity)
4. **Register verification schema** in `__init__.py`'s `build_default_orchestrator()` factory
5. **Call from your application code:**

```python
from engine.api.ai_orchestrator import build_default_orchestrator, AIRequest, TaskType
from engine.api.ai_orchestrator.prompts.your_task import SYSTEM_PROMPT, OUTPUT_SCHEMA

orch = build_default_orchestrator()
result = orch.execute(AIRequest(
    task_id="your-task-001",
    task_type=TaskType.YOUR_TASK,
    system_prompt=SYSTEM_PROMPT,
    user_message=your_input,
    output_schema=OUTPUT_SCHEMA,
    metadata={
        "user_id":     "user-uuid",        # for budget + telemetry
        "plan_key":    "pro",              # for budget cap lookup
        "document_id": "doc-uuid",         # for telemetry slicing
    },
))
# result.response.content    → validated dict per OUTPUT_SCHEMA
# result.provenance.sources  → which models contributed
# result.provenance.agreed   → False if arbitration was used
```

## 6 · How to read telemetry

Each call appends one JSON object to `orchestrator.jsonl`. To compute the per-task agreement rate (the key metric for tuning routing config):

```bash
# Per-task agreement rate
jq -r '"\(.task_type)\t\(.agreement)"' /var/log/cfo-ai/orchestrator.jsonl | \
  sort | uniq -c | sort -rn

# Cost per task type, today
jq -r 'select(.timestamp > (now - 86400)) | "\(.task_type)\t\(.total_cost_usd)"' \
  /var/log/cfo-ai/orchestrator.jsonl | \
  awk '{t[$1]+=$2} END {for (k in t) print k, t[k]}'

# When primary + verifier disagreed AND user corrected the primary's answer
# (this is the ground-truth signal — if verifier was right > 50% of the time,
# swap primary and verifier in routing_config)
jq -r 'select(.agreement == "conflict") | .task_id' /var/log/cfo-ai/orchestrator.jsonl
# → cross-reference against the application's user-correction log
```

## 7 · Routing-config tuning rhythm

Review monthly:

- **Drop verifier** on tasks with agreement > 95% for 30+ days. Verifier is doubling cost without catching real errors.
- **Swap primary + verifier** on tasks where the verifier wins disagreements > 50% of the time (after user correction).
- **Add a verifier** on tasks where users report frequent errors that single-model didn't catch.
- **Tighten tolerance** in `VERIFICATION_SCHEMA` if conflicts keep being noise; loosen if real errors are slipping through.

All changes are in `routing_config.py` + `prompts/<task>.py` — no orchestrator-core edits needed.

## 8 · Cost projection per plan tier

Defaults in `budget.py` (`_DEFAULT_PLAN_CAPS_USD`):

| Plan    | Daily $ cap | Reasoning |
|---------|-------------|-----------|
| trial   | $1.00       | 7-day trial: 1 doc × ~$0.50 + headroom |
| intro   | $0.75       | single doc unlock |
| starter | $5.00       | 5 docs/mo × ~$0.50 + commentary + chat |
| pro     | $20.00      | 15 docs/mo + heavy commentary + chat |

Plus a global circuit-breaker (`AI_BUDGET_DAILY_CAP_USD`, default $200) — hard stop across all users to catch runaway costs.

Per-document cost benchmark (Claude + GPT cross-check, no cache, with arbitration on ~10% of calls):

- Trial-balance extraction: ~$0.50/document
- CFO commentary generation: ~$0.30/section
- Chat turn (cached system prompt): ~$0.02/turn

Cached-prefix discounts (Claude's `cache_control`, OpenAI's automatic prefix cache) typically drop these by 70-90% on the second call onward — major lever for users analyzing the same document multiple times.

## 9 · Rollback

The orchestrator is purely additive — no existing call site has been retrofitted yet. To roll back the orchestrator entirely:

1. **Comment out the openai dep** in `Dockerfile` (revert pip install line)
2. **Delete the package**: `rm -rf src/engine/api/ai_orchestrator/`
3. **Rebuild backend**: `cd /opt/cfo-ai && docker compose build backend && docker compose up -d backend`

The existing engine's pre-orchestrator Claude calls (in `_detect.py`, `ask.py`, etc.) are untouched.

## 10 · v2 roadmap (post-MVP)

When the v1 has been running long enough to build telemetry intuition:

1. **Retrofit existing call sites** — `_detect.py`, `ai_analyzer.py`, `cfo_ai.py`, `briefing/client.py`, `ask.py` to use the orchestrator. Single-model behavior preserved (no verifier on those routes by default); orchestrator's benefits are cache + telemetry + budget guard.
2. **Wire the remaining task types** — `extract.balance_sheet`, `extract.pnl`, `generate.cfo_commentary` with verifier paths.
3. **Move telemetry to Postgres** — JSONL is fine at low volume; for the dashboard at scale, move to a `ai_telemetry` table partitioned by day.
4. **Build the FE dashboard** — per-task agreement rate, latency p50/p99, cost per user, top conflicts. One Recharts panel per metric on the existing admin page.
5. **Add the semantic-compare path** — OpenAI embeddings (text-embedding-3-large) + cosine threshold + LLM tie-breaker for prose tasks where structural compare is too crude.
6. **Per-task effort override** — `req.metadata["effort"]` flows through to Claude's `output_config.effort` so cheap classification tasks use `effort=low` while extraction uses `effort=high`.

## 11 · Known limitations / gotchas

- **Claude tool_choice + thinking are incompatible** on Opus 4.7. The adapter handles this — when `output_schema` is set, thinking is omitted; for plain-text tasks, adaptive thinking is on. Don't pass both.
- **In-memory cache only** in v1. Cache doesn't survive container restarts; load-balanced deploys would have per-process caches. Acceptable at single-backend-container scale; move to Redis at v2.
- **Telemetry uses local filesystem.** Same caveat — for multi-instance deploys, switch the storage backend.
- **OpenAI pricing in `gpt_adapter.py` is a snapshot.** Re-verify against current OpenAI pricing at every cost review; off-by-2x is OK for the budget gate, off-by-10x is not.
- **GPT-5 model name** — if your OpenAI account doesn't yet have GPT-5 access, change `model="gpt-5"` in `GPTAdapter.__init__` default to whatever model your account supports (gpt-4o, gpt-4.1-mini, etc.). Adapter Protocol is identical.
- **No FE integration yet.** Application code can call `build_default_orchestrator()` directly, but there's no `/api/ai/*` route exposing it. Add a thin proxy route in `src/engine/api/` if you want the FE to call orchestrator paths directly (e.g., for diagnostics or admin UIs).
