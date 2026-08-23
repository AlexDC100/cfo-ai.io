# ADR — AI decision engine: model registry, per-role spend breaker, advisory pass (D3)

Date: 2026-08-23 · Status: accepted · Owner: engine (agent REG build)

## Context

The operator specified an AI decision engine on top of the canonical_bs
v2 pipeline: one config-not-code model registry, a per-role daily spend
circuit breaker, and an advisory AI-validation pass that can never gate
serving. Two hard rules frame everything:

- **R1** — the deterministic validator remains the ONLY gate. The AI
  validation pass can never block serving, mutate IR/layers, or change
  a machine status.
- **R2** — its output is additive: an `ai_review` layer at the ENVELOPE
  ROOT plus additive envelope fields (the `pack_provenance` placement
  discipline), per the additive-only envelope contract.

## Decisions

### 1. Model registry is config (`src/engine/ai/models.yaml`)

`engine.ai.registry` loads + schema-validates one
`{role -> model_id, prompt_version, max_tokens, temperature: 0,
breaker caps}` table (cached; `ENGINE_AI_MODELS_PATH` override; LOUD
`RegistryError` on a missing/corrupt/incomplete file — never a silent
fallback model). Wired call sites, all VALUE-IDENTICAL at cutover:

- `engine.ai_lane.config` — `MODEL_ID` (role `extract`) + the three
  per-stage prompt versions + max-token ceilings. The classify
  pack-hash prompt-version derivation composes ON TOP of the registry
  base version, unchanged.
- `engine.ai_lane._client.call_strict_json` — per-stage model
  resolution (stage name == registry role), with a `config.MODEL_ID`
  fallback for unknown ad-hoc stages. Audit entries additively gained
  `{role, model_id}` next to the existing keys.
- `engine.api._reconcile` — `AI_MODEL` / `PROMPT_VERSION` (role
  `reconcile_proposal`).

**Model-pin conflict, resolved in favor of byte-stability.** The
operator spec pins the flagship `claude-fable-5` for
ai_validator/reconcile_proposal/extract/classify and the cheap
`claude-haiku-4-5-20251001` for format_detect — but the corpus goldens
byte-freeze `claude-opus-4-7` (`corpus/hu_ai_lane/expected/*`), stored
envelopes key the AI-lane cache on it, and
`tests/engine/test_ai_lane.py` locks "all lane stages call the ONE
MODEL_ID". The non-destructive contract (ZERO golden-change lines) and
the same spec's own "keep the existing constants as the yaml VALUES so
nothing behaviorally changes" clause therefore win: the four wired
roles ship on `claude-opus-4-7`; ONLY the brand-new `ai_validator` role
(no golden pins it) ships on `claude-fable-5`. The target strings are
documented inline in models.yaml; flipping any wired role is now a
one-line YAML edit executed as a deliberate golden-refreeze event
(UPDATE_GOLDEN=1, `golden-change:` PR line, relax the one-model lane
invariant). Verify both target model-id strings at deploy — model ids
change with releases.

`temperature: 0` is registry-validated for every role but NOT yet
passed on requests — today's call sites do not send temperature, and
adding it is a live-behavior change (interaction with effort/thinking
settings) that belongs to its own change, not the registry cutover.

### 2. Per-role daily spend breaker (`engine.ai.breaker`)

- Caps are config: `breaker.max_calls_per_day` /
  `breaker.max_tokens_per_day` per role in models.yaml (defaults
  merged). Conservative single-tenant defaults: 200 calls / 2M tokens
  per day, format_detect 500 calls, extract+classify 5M tokens,
  reconcile_proposal 100 calls / 200K tokens. `0` = role fully closed
  (ops kill switch; how the trip tests force the state).
- The counter is a FILE under the existing data/ dir convention —
  `<repo>/data/ai_spend/ai_spend_breaker.json` (== `/app/data/...` in
  the container, the gdelt-cache volume habit), `AI_BREAKER_STATE_DIR`
  override. UTC-day rollover resets. Atomic writes + advisory flock;
  best-effort counting by design (armor, not a ledger). No new
  datastore.
- On trip OR missing credits: the honest **"advisory unavailable"**
  degraded state (`engine.ai.breaker.degraded_marker`) — serving
  proceeds regardless. Proven by tests/engine/test_breaker.py for BOTH
  paths: the advisory pass attaches `ai_review_degraded` and nothing
  else; the reconcile-AI path degrades through its existing calm
  MINOR_DRIFT + needs_review marker.
- The reconcile-proposal enforcement point is
  `engine.ai.breaker.check("reconcile_proposal")` at the top of
  `_reconcile._ai_propose` — NOT yet wired (the file is locked beyond
  the constants cutover); the test applies the guard at that exact seam
  and the coordinator lands the one-liner.

### 3. Advisory pass (`engine.ai.advisory`) — guardrails by construction

- Pure function `run_ai_review(envelope, gateway_facts,
  client_factory)`; pipeline seam `pipeline_hook` (never raises,
  additive-only writes, env-gated by `AI_ADVISORY_ENABLED`, DEFAULT
  OFF so nothing changes in prod until the operator flips it).
- Job 1 (llm atoms only, source text required): the ai_validator model
  re-reads source rows via provenance coordinates — the prompt
  withholds the engine's readings — per-atom cent compare, doc-level
  agreement score persisted; disagreement → the ONE permitted write,
  an id-only `EscalationLedger.raise_needs_review` (TypeError by
  signature on any value) + a side-by-side finding.
- Job 2 (all docs): read-only facts via the facts gateway PUBLIC API +
  pack statement map + deterministic findings; model findings are
  whitelist-projected to `{id, severity(info|warn|flag), code,
  rationale, pointers}` — forged status keys are stripped; findings are
  dismissible with the dismissal audited additively in the layer.
- Separate client per role: ai_validator has its own factory; the
  reconcile flow never constructs it (V6 sentinel). Raw model
  responses persist inside `ai_review.audit.stages` (`{role, model_id,
  prompt_version, raw_response}` per attempt) so a degraded run leaves
  the envelope byte-identical (V3).
- V1-V7 invariants locked in tests/engine/test_ai_advisory.py, V1/V2
  parametrized over all 17 golden-corpus envelopes.

### 4. Deploy probe + self-activating live baseline

`scripts/check_anthropic_probe.py`: registry health, then KEY_MISSING /
CREDITS_OK / CREDITS_ABSENT / PROBE_ERROR via a 1-token cheapest-tier
call — **exit 0 always** (a notice, not a gate). On CREDITS_OK with
`src/engine/ai/evals/baseline.json` absent it runs
`engine.ai.evals.run_baseline` once (live scores over the pinned
3-case corpus set). Today credits are ABSENT on the prod key, so the
probe degrades to its loud notice and the baseline stays deferred. CI
stays fully mocked forever — nothing in the test battery or the corpus
replay touches a live SDK.

## Consequences

- Corpus replay, determinism gate, gateway facts and every served byte
  are UNCHANGED with the pass off (default) and byte-identical with it
  on (proven). The AI engine is pure addition.
- Model/prompt churn becomes YAML review instead of code archaeology;
  spend is capped per role per day with an honest degraded state.
- Two wiring one-liners remain with their owners: the stage_persist
  advisory hook (pipeline.py, agent JRN) and the `_ai_propose` breaker
  guard (_reconcile.py, locked beyond constants for this build).
