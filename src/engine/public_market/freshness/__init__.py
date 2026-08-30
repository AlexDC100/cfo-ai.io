"""AI freshness layer for the public_market document class (Part D).

Everything in this package is DARK-READY: Anthropic credits are currently
absent, so every AI call routes through a client hook that returns a typed
``AiUnavailable`` instead of raising or fabricating.  The deterministic parts
of every surface (staleness math, peer candidate selection, cache reads) run
fully in the dark.  The layer self-activates the moment ``ANTHROPIC_API_KEY``
is present and billable -- no code change, no redeploy of this package.

Discipline (mirrors the engine/ai advisory R1/R2 rules):
  R1  AI output is never numeric-authoritative and can never block, mutate,
      or change the status of anything the deterministic spine produced.
      This package therefore has NO import path into the spine's serving or
      persistence write APIs -- enforced by a token-scan lint in
      ``tests/engine/test_public_market_freshness.py`` (PM1 lint, owned by
      this lane, modeled on ``test_e8_jurisdiction_blindness.py``).
  R2  Every AI call is budgeted (per-role spend breaker), cached
      (content-addressed), cited (claims without sources are dropped and
      counted, never served), and labeled (``updated_at`` + ``sources``).

ABSENT != ZERO applies throughout: a missing date is not "fresh", a missing
XBRL fact is not 0.0, a missing size figure is not "micro cap".
"""

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

__all__ = [
    "DARK_NOTICE",
    "AiUnavailable",
    "AiResult",
    "DarkAiClient",
    "AnthropicAiClient",
    "resolve_ai_client",
    "LocalSpendCounter",
    "resolve_spend_breaker",
    "cache_key",
    "cache_read",
    "cache_write",
    "parse_model_json",
]

# Calm, user-visible notice for every dark surface.  Deliberately states that
# the deterministic data is complete -- the AI layer only adds narrative and
# freshness commentary, never numbers.
DARK_NOTICE = (
    "AI commentary is not active yet. All figures and freshness checks on "
    "this page are complete and come from deterministic sources. Narrative "
    "briefings will appear automatically once AI credits are enabled."
)

# Default flagship for this layer; per the model-registry convention the
# flagship id is env-overridable so activation never needs a code change.
DEFAULT_MODEL = os.environ.get("PM_AI_MODEL", "claude-fable-5")

_VALID_REASONS = (
    "credits_absent",       # no ANTHROPIC_API_KEY -> the standing dark state
    "sdk_missing",          # key present but the anthropic SDK is not installed
    "provider_error",       # live call failed (billing, network, 4xx/5xx)
    "budget_exhausted",     # per-role spend breaker refused the call
    "model_output_invalid", # model answered but violated the output contract
)


@dataclass(frozen=True)
class AiUnavailable:
    """Typed refusal for any AI-layer call that cannot (or must not) run.

    This is a VALUE, not an exception: callers branch on it and always keep
    their deterministic output intact.  ``notice`` is safe to show verbatim.
    """

    reason: str
    detail: str = ""
    notice: str = DARK_NOTICE
    kind: str = "AI_UNAVAILABLE"

    def as_dict(self):
        # type: () -> Dict[str, str]
        return {
            "kind": self.kind,
            "reason": self.reason,
            "detail": self.detail,
            "notice": self.notice,
        }


@dataclass(frozen=True)
class AiResult:
    """Raw successful completion. Callers must still parse + validate."""

    text: str
    model: str
    role: str


class DarkAiClient(object):
    """Client hook used while credits are absent (or SDK is missing).

    Always answers with a typed ``AiUnavailable``; never raises, never
    fabricates.  Constructing it is free, so surfaces can be wired
    unconditionally and simply light up when ``resolve_ai_client`` starts
    returning the live client instead.
    """

    is_dark = True

    def __init__(self, reason="credits_absent", detail=""):
        # type: (str, str) -> None
        if reason not in _VALID_REASONS:
            reason = "provider_error"
        self._refusal = AiUnavailable(reason=reason, detail=detail)

    def complete(self, role, prompt, max_tokens=1500, want_web_search=False):
        # type: (str, str, int, bool) -> AiUnavailable
        return self._refusal


class AnthropicAiClient(object):
    """Live flagship client. Only constructed when a key is present.

    All failures come back as ``AiUnavailable`` -- the freshness layer must
    degrade to its deterministic output on ANY provider problem (fail closed
    on narrative, never on numbers, which it does not own anyway).
    """

    is_dark = False

    def __init__(self, api_key, model=None):
        # type: (str, Optional[str]) -> None
        self._api_key = api_key
        self._model = model or DEFAULT_MODEL

    def complete(self, role, prompt, max_tokens=1500, want_web_search=False):
        # type: (str, str, int, bool) -> Any
        try:
            import anthropic  # lazy: absent SDK must not break dark installs
        except Exception as exc:  # pragma: no cover - environment dependent
            return AiUnavailable(reason="sdk_missing", detail=str(exc))
        try:  # pragma: no cover - network path, exercised only when billed
            client = anthropic.Anthropic(api_key=self._api_key)
            kwargs = {
                "model": self._model,
                "max_tokens": max_tokens,
                "messages": [{"role": "user", "content": prompt}],
            }
            if want_web_search:
                # Server-side web search tool: the model cites URLs it saw,
                # which the callers then validate claim-by-claim.
                kwargs["tools"] = [
                    {"type": "web_search_20250305", "name": "web_search", "max_uses": 4}
                ]
            resp = client.messages.create(**kwargs)
            parts = []
            for block in getattr(resp, "content", []) or []:
                if getattr(block, "type", "") == "text":
                    parts.append(getattr(block, "text", ""))
            return AiResult(text="".join(parts), model=self._model, role=role)
        except Exception as exc:  # pragma: no cover - network path
            return AiUnavailable(
                reason="provider_error",
                detail="%s: %s" % (type(exc).__name__, exc),
            )


def resolve_ai_client(env=None):
    # type: (Optional[Dict[str, str]]) -> Any
    """The single activation switch for the whole layer.

    No key  -> DarkAiClient("credits_absent")   (today's standing state)
    Key set -> live AnthropicAiClient           (self-activation, no deploy)
    """
    env = os.environ if env is None else env
    api_key = (env.get("ANTHROPIC_API_KEY") or "").strip()
    if not api_key:
        return DarkAiClient(reason="credits_absent")
    return AnthropicAiClient(api_key=api_key, model=env.get("PM_AI_MODEL"))


# ---------------------------------------------------------------------------
# Per-role budget (D5)
# ---------------------------------------------------------------------------

class LocalSpendCounter(object):
    """Simple per-role call counter with the spend-breaker contract.

    Used when ``engine.ai``'s own breaker cannot be adapted (see
    ``resolve_spend_breaker``).  Counts CALLS, not tokens -- a deliberate,
    documented simplification; caps default low and are env-tunable:

        PM_AI_CALL_CAP           global default per role   (default 25)
        PM_AI_CALL_CAP_<ROLE>    per-role override, role upper-cased

    Contract (shared with the adapter):
        allow(role)  -> None when the call may proceed, AiUnavailable if not
        record(role) -> account for one completed call
    """

    backend = "local_counter"

    def __init__(self, caps=None, env=None):
        # type: (Optional[Dict[str, int]], Optional[Dict[str, str]]) -> None
        env = os.environ if env is None else env
        self._env = env
        self._caps = dict(caps or {})
        self._used = {}  # type: Dict[str, int]

    def _cap_for(self, role):
        # type: (str) -> int
        if role in self._caps:
            return self._caps[role]
        override = self._env.get("PM_AI_CALL_CAP_%s" % role.upper())
        if override is not None:
            try:
                return int(override)
            except ValueError:
                pass  # malformed override -> fall through to the default cap
        try:
            return int(self._env.get("PM_AI_CALL_CAP", "25"))
        except ValueError:
            return 25

    def allow(self, role):
        # type: (str) -> Optional[AiUnavailable]
        cap = self._cap_for(role)
        used = self._used.get(role, 0)
        if used >= cap:
            return AiUnavailable(
                reason="budget_exhausted",
                detail="role %s used %d of %d allowed calls" % (role, used, cap),
            )
        return None

    def record(self, role, calls=1):
        # type: (str, int) -> None
        self._used[role] = self._used.get(role, 0) + calls


class _EngineAiBreakerAdapter(object):
    """Duck-typed adapter over the engine.ai per-role spend breaker.

    We only depend on it optionally: if its surface differs from what this
    adapter expects, every failure degrades to the local counter so budget
    enforcement NEVER silently disappears (fail closed on spending).
    """

    backend = "engine.ai"

    def __init__(self, inner, fallback):
        # type: (Any, LocalSpendCounter) -> None
        self._inner = inner
        self._fallback = fallback

    def allow(self, role):
        # type: (str) -> Optional[AiUnavailable]
        for name in ("allow", "check", "can_spend"):
            fn = getattr(self._inner, name, None)
            if fn is None:
                continue
            try:
                verdict = fn(role)
            except Exception:
                break  # incompatible surface -> local counter decides
            if verdict in (None, True):
                return None
            if verdict is False:
                return AiUnavailable(
                    reason="budget_exhausted",
                    detail="engine.ai spend breaker refused role %s" % role,
                )
            if isinstance(verdict, AiUnavailable):
                return verdict
            break
        return self._fallback.allow(role)

    def record(self, role, calls=1):
        # type: (str, int) -> None
        for name in ("record", "charge", "spend"):
            fn = getattr(self._inner, name, None)
            if fn is None:
                continue
            try:
                fn(role, calls)
                return
            except TypeError:
                try:
                    fn(role)
                    return
                except Exception:
                    break
            except Exception:
                break
        self._fallback.record(role, calls)


def resolve_spend_breaker(env=None):
    # type: (Optional[Dict[str, str]]) -> Any
    """Prefer the existing engine.ai per-role spend breaker; else local.

    The import is guarded twice over (module path AND constructor surface)
    because this lane ships in parallel with other work and must not couple
    hard to a module it does not own.  The chosen backend is visible on the
    returned object (``backend`` attribute) so tests and /ops can tell which
    enforcement path is live.
    """
    fallback = LocalSpendCounter(env=env)
    for modpath, attr in (
        ("engine.ai.spend", "SpendBreaker"),
        ("engine.ai.breaker", "SpendBreaker"),
        ("engine.ai", "SpendBreaker"),
    ):
        try:
            module = __import__(modpath, fromlist=[attr])
            cls = getattr(module, attr, None)
            if cls is None:
                continue
            inner = cls()  # only adopt a breaker we can construct bare
            return _EngineAiBreakerAdapter(inner, fallback)
        except Exception:
            continue
    return fallback


# ---------------------------------------------------------------------------
# Content-addressed cache (R2)
# ---------------------------------------------------------------------------

def cache_key(*parts):
    # type: (*str) -> str
    """Stable content address for a cache entry (sha256 over joined parts)."""
    joined = "\x1f".join(str(p) for p in parts)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


def cache_read(cache_dir, key):
    # type: (str, str) -> Optional[Dict[str, Any]]
    """Return the cached payload, or None. Corrupt entries read as a miss --
    recomputing is always safe here because the cache only ever holds
    AI narrative, never authoritative numbers."""
    path = os.path.join(cache_dir, key + ".json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            entry = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(entry, dict) or entry.get("key") != key:
        return None
    payload = entry.get("payload")
    if not isinstance(payload, dict):
        return None
    return payload


def cache_write(cache_dir, key, payload, stored_at):
    # type: (str, str, Dict[str, Any], str) -> None
    """Atomic write (tmp file + os.replace) so a crashed process can never
    leave a half-written entry that later parses as a briefing."""
    os.makedirs(cache_dir, exist_ok=True)
    entry = {"key": key, "stored_at": stored_at, "payload": payload}
    fd, tmp_path = tempfile.mkstemp(dir=cache_dir, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(entry, fh, ensure_ascii=False, sort_keys=True)
        os.replace(tmp_path, os.path.join(cache_dir, key + ".json"))
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Model-output parsing (shared by briefing / filing_reader / peers / sentinel)
# ---------------------------------------------------------------------------

def parse_model_json(text):
    # type: (str) -> Optional[Any]
    """Extract the JSON document from a model reply, tolerating code fences
    and prose margins. Returns None when nothing parses -- callers turn that
    into a typed ``model_output_invalid`` refusal (fail closed, no salvage).
    """
    if not isinstance(text, str) or not text.strip():
        return None
    candidate = text.strip()
    if candidate.startswith("```"):
        # Strip a ```json ... ``` (or bare ```) fence.
        lines = candidate.splitlines()
        if len(lines) >= 2:
            body = lines[1:]
            if body and body[-1].strip().startswith("```"):
                body = body[:-1]
            candidate = "\n".join(body).strip()
    try:
        return json.loads(candidate)
    except ValueError:
        pass
    # Last resort: widest brace/bracket span. Still json.loads-validated.
    for opener, closer in (("{", "}"), ("[", "]")):
        start = candidate.find(opener)
        end = candidate.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(candidate[start : end + 1])
            except ValueError:
                continue
    return None
