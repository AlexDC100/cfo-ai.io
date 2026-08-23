"""engine.ai — the AI decision engine (registry + breaker + advisory).

The two hard rules this package is built around (operator spec):

  R1  The deterministic validator remains the ONLY gate. Nothing in
      this package can block serving, mutate the IR or any persisted
      layer, or change a machine status.
  R2  Its output is ADDITIVE: an `ai_review` layer at the envelope
      root plus additive envelope fields, per the additive-only
      envelope contract (same placement discipline as
      `pack_provenance` — never inside `canonical_bs`, so served
      payloads and the golden corpus stay byte-identical).

Modules:

  registry   models.yaml as config — one {role -> model_id /
             prompt_version / max_tokens / temperature / breaker caps}
             table, schema-validated and cached. The EXISTING call
             sites (engine.ai_lane.config, engine.ai_lane._client,
             engine.api._reconcile) read it with value-identical
             results — locked by tests/engine/test_model_registry.py.
  breaker    per-role daily spend circuit breaker (file-backed counter
             under the data/ dir convention — no new datastore). On
             trip OR missing credits: the honest "advisory unavailable"
             degraded state; serving proceeds regardless.
  advisory   the post-reconcile advisory pass (`run_ai_review` — pure
             function; `pipeline_hook` — the never-raising seam a
             one-line pipeline call wires in). V1-V7 invariants locked
             by tests/engine/test_ai_advisory.py.
  evals      live eval baseline runner (self-activating from
             scripts/check_anthropic_probe.py when credits exist and
             evals/baseline.json is absent). CI never runs it — CI
             stays fully mocked forever.

Import discipline: `registry` is stdlib+yaml only (safe for
engine.ai_lane.config and engine.api._reconcile to import at module
level). `advisory` imports the facts gateway PUBLIC API only
(engine.serving) and never imports engine.api at module level. The
package init exports just the registry surface; breaker/advisory are
imported by their consumers directly to keep the import graph thin.
"""
from __future__ import annotations

from .registry import (  # noqa: F401
    RegistryError,
    breaker_limits_for,
    clear_cache,
    load_registry,
    model_for,
    params_for,
)

__all__ = [
    "RegistryError",
    "breaker_limits_for",
    "clear_cache",
    "load_registry",
    "model_for",
    "params_for",
]
