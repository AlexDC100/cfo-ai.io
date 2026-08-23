"""The AI advisory pass (engine.ai.advisory) — ai_validator role.

Runs AFTER auto-reconcile and BEFORE the snapshot persist, as a PURE
FUNCTION over frozen views: `run_ai_review(envelope, gateway_facts,
client_factory) -> ai_review dict`. The pipeline seam is
:func:`pipeline_hook` (never raises; env-gated OFF by default) — the
coordinator wires it with ONE call in `pipeline.stage_persist`, directly
after `_reconcile.auto_reconcile_envelope(canonical)`:

    _ai_advisory.pipeline_hook(canonical)        # + the module import

THE TWO HARD RULES (operator spec, locked by tests/engine/
test_ai_advisory.py V1-V7):
  R1  the deterministic validator stays the ONLY gate — this pass can
      never block serving, mutate IR/layers, or change machine status;
  R2  output is ADDITIVE: the `ai_review` layer lives at the ENVELOPE
      ROOT (the pack_provenance placement discipline — never inside
      `canonical_bs`), so the served payload, the golden corpus and the
      gateway facts are byte-identical with the pass ON or OFF.

Jobs:
  1. EXTRACTION VERIFICATION — only when the envelope shows llm atoms
     (`extraction.method == "llm"`) AND the caller provided the source
     text: the ai_validator model re-reads the source rows via the
     provenance coordinates (the prompt WITHHOLDS the engine's own
     readings so the model cannot echo) and returns its own reading;
     compared per-atom to the cent. The doc-level agreement score is
     persisted (the determinism proxy for the AI lane). A disagreement
     triggers the ONE permitted write — an id-only needs_review
     escalation (:class:`EscalationLedger`, TypeError on anything but
     an id string) — plus a side-by-side finding.
  2. STATEMENT SANITY REVIEW — all docs incl. RO: input is READ-ONLY
     facts through the facts-gateway PUBLIC API + the pack statement
     map + the deterministic findings; the model emits findings
     {severity: info|warn|flag, rationale, pointers to line_ids}.
     Findings are whitelist-projected (a forged status-flip key is
     stripped), advisory, and dismissible — dismissals are AUDITED in
     the layer, additively. Nothing consumes findings for status.

GUARDRAILS BY CONSTRUCTION: the pass reads DEEP COPIES of the envelope
(and builds its gateway from a copy), so no mutation API is in scope
except the audited escalation ledger; the ai_validator role has its own
client factory — the reconcile stage never consults it (quarantine, V6)
and this module never imports engine.api at module level.

FAILURE ISOLATION: breaker trip, missing credits, client construction
failure, model timeout/error/malformed-JSON → :class:`AdvisoryUnavailable`
→ the hook attaches ONLY the honest degraded marker (`ai_review_degraded`,
ai_review absent) and everything else stays byte-identical; serving
proceeds regardless.
"""
from __future__ import annotations

import copy
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from engine.serving import FactsGateway, MissingFactError

from . import breaker, registry

logger = logging.getLogger("engine.ai.advisory")

#: The registry role this pass runs as (its OWN client; quarantined
#: from the reconcile_proposal role by construction).
ROLE = "ai_validator"

#: Envelope keys (both at the ENVELOPE ROOT — additive, never served
#: inside canonical_bs).
AI_REVIEW_KEY = "ai_review"
DEGRADED_KEY = "ai_review_degraded"

#: Env gate for the pipeline hook. DEFAULT OFF — flipping it on is a
#: deliberate ops action (see models.yaml + the ADR); tests pass
#: `enabled=True` explicitly.
ENABLE_ENV = "AI_ADVISORY_ENABLED"

#: Finding vocabulary + whitelist projection (V5's forge-strip).
SEVERITIES = ("info", "warn", "flag")
_FINDING_KEYS = ("id", "severity", "code", "rationale", "pointers")

#: Payload ceilings.
_MAX_SOURCE_CHARS = 200_000
_MAX_ROWS_IN_PAYLOAD = 300

_SCHEMA = "ai_review_v1"


class AdvisoryUnavailable(Exception):
    """The pass cannot run (breaker / credits / client / model). The
    hook maps this to the degraded marker; it never blocks serving."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__("%s: %s" % (reason, detail) if detail else reason)
        self.reason = reason
        self.detail = detail


class EscalationLedger(object):
    """The ONE permitted write surface: an audited needs_review
    flag-raiser accepting atom/account IDS ONLY — no values. Passing a
    second positional/keyword argument fails by signature (TypeError);
    a non-string id fails the type check. Locked by V4."""

    __slots__ = ("_ids",)

    def __init__(self) -> None:
        self._ids: List[str] = []

    def raise_needs_review(self, atom_id):
        # ids only — a float/dict/list "reading" is a VALUE, refused.
        if isinstance(atom_id, bool) or not isinstance(atom_id, str) or not atom_id.strip():
            raise TypeError(
                "needs_review escalation accepts an atom/account id string "
                "ONLY (got %r) — values are never written" % (atom_id,)
            )
        if atom_id not in self._ids:
            self._ids.append(atom_id)

    @property
    def ids(self) -> List[str]:
        return list(self._ids)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _cents(value: Any) -> Optional[int]:
    try:
        return int(round(float(value) * 100))
    except (TypeError, ValueError):
        return None


def _default_client_factory() -> Any:
    """The production ai_validator client (module-level so the V6
    quarantine sentinel can replace it). Fails honestly without a key —
    the caller degrades, never fabricates."""
    from engine.ai_lane.config import default_client_factory

    return default_client_factory()


# ── Payload builders (read-only views) ─────────────────────────────────


_FACT_ACCESSORS = (
    "total_assets", "total_liabilities", "equity",
    "equity_plus_liabilities", "current_assets", "current_liabilities",
    "working_capital", "difference", "net_result", "revenue",
    "expenses", "ebitda",
)


def _facts_payload(gateway: Optional[FactsGateway]) -> Dict[str, int]:
    """Served facts in integer minor units — the ONLY totals source this
    pass reads (the facts-gateway public API; never raw envelope totals)."""
    out: Dict[str, int] = {}
    if gateway is None:
        return out
    for name in _FACT_ACCESSORS:
        try:
            out["%s_minor" % name] = getattr(gateway, name)().amount_minor
        except MissingFactError:
            continue
        except Exception:  # noqa: BLE001 — a facts gap is context, not a failure
            continue
    return out


def _statement_map_lines(cbs: Dict[str, Any]) -> List[str]:
    """Best-effort pack statement-map context (line ids), resolved from
    the envelope's recorded jurisdiction. Omitted on any trouble — the
    review runs fine without it."""
    try:
        jurisdiction = None
        jur_block = cbs.get("jurisdiction")
        if isinstance(jur_block, dict):
            jurisdiction = jur_block.get("resolved")
        if not jurisdiction and str(cbs.get("mapping_version") or "").startswith("ro_"):
            jurisdiction = "RO"
        if not jurisdiction:
            return []
        from engine.packs.runtime import active_pack

        pack = active_pack("HU" if jurisdiction == "HU" else
                           ("RO" if jurisdiction == "RO" else "INTL"))
        lines: List[str] = []

        def _walk(nodes: Any) -> None:
            for node in nodes or ():
                line_id = getattr(node, "line_id", None) or getattr(node, "id", None)
                if line_id:
                    lines.append(str(line_id))
                _walk(getattr(node, "children", None))

        _walk(getattr(pack, "balance_sheet", None))
        _walk(getattr(pack, "profit_loss", None))
        return lines
    except Exception:  # noqa: BLE001 — context only
        return []


def _rows_compact(cbs: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = []
    for row in (cbs.get("rows") or [])[:_MAX_ROWS_IN_PAYLOAD]:
        if isinstance(row, dict):
            rows.append({
                "id": row.get("id"),
                "section": row.get("section"),
                "amount": row.get("amount"),
            })
    return rows


def _atoms(cbs: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The verification atoms: canonical rows with a numeric reading."""
    atoms = []
    for row in cbs.get("rows") or []:
        if isinstance(row, dict) and _cents(row.get("amount")) is not None and row.get("id"):
            atoms.append(row)
    return atoms


# ── Model calls (shared strict-JSON helper; ai_validator role) ─────────


def _call(client: Any, *, prompt_version: str, system: str, user_text: str,
          max_tokens: int, audit_stages: List[Dict[str, Any]]) -> Dict[str, Any]:
    from engine.ai_lane._client import call_strict_json
    from engine.ai_lane.schemas import AiLaneError

    try:
        data = call_strict_json(
            client,
            stage=ROLE,
            prompt_version=prompt_version,
            system=system,
            user_text=user_text,
            max_tokens=max_tokens,
            audit_stages=audit_stages,
        )
    except AiLaneError as e:
        raise AdvisoryUnavailable("model_error", str(e))
    breaker.record(ROLE, tokens=0)
    return data


_JOB1_SYSTEM = (
    "You are the ai_validator for a financial statements engine. Re-read "
    "the SOURCE DOCUMENT below and return YOUR OWN reading of each listed "
    "atom's closing amount, located via the provenance coordinates and "
    "account codes. You are a second, independent reader: the engine's "
    "readings are deliberately withheld. You never classify, never fix, "
    "never total — you only read. Respond with ONLY the JSON object "
    '{"atoms": [{"id": "<atom id>", "amount": <number>}]} — no prose.'
)

_JOB2_SYSTEM = (
    "You are the ai_validator for a financial statements engine. Review "
    "the served facts, statement rows, and deterministic findings below "
    "and emit ADVISORY findings only: sign anomalies, ratio outliers, "
    "concentration, capitalized-own-work patterns, period-over-period "
    "jumps (when prior facts exist). You cannot change any status, total "
    "or classification — findings are informational and dismissible. "
    "Respond with ONLY the JSON object {\"findings\": [{\"id\": str, "
    "\"severity\": \"info\"|\"warn\"|\"flag\", \"code\": str, "
    "\"rationale\": str, \"pointers\": [<line_id>]}]} — no prose."
)


def _job1_extraction_verification(
    client: Any,
    cbs: Dict[str, Any],
    provenance: Dict[str, Any],
    source_text: Optional[str],
    prompt_version: str,
    max_tokens: int,
    audit_stages: List[Dict[str, Any]],
    ledger: EscalationLedger,
    findings: List[Dict[str, Any]],
) -> Dict[str, Any]:
    method = str((cbs.get("extraction") or {}).get("method") or "")
    if method != "llm":
        return {"ran": False, "reason": "not_llm_extraction"}
    if not source_text:
        return {"ran": False, "reason": "source_text_unavailable"}
    atoms = _atoms(cbs)
    if not atoms:
        return {"ran": False, "reason": "no_atoms"}

    coordinates = {
        "extraction": {
            k: (cbs.get("extraction") or {}).get(k)
            for k in ("source_format", "number_locale", "sheet",
                      "header_row_index", "separators", "scale", "language")
            if k in (cbs.get("extraction") or {})
        },
        "original_filename": provenance.get("original_filename"),
        "content_hash": provenance.get("content_hash"),
    }
    # The engine's own readings are WITHHELD — ids + coordinates only.
    atom_refs = [
        {
            "id": a.get("id"),
            "section": a.get("section"),
            "label": a.get("label"),
            "account_codes": a.get("account_codes"),
            "leaf_ids": a.get("leaf_ids"),
        }
        for a in atoms
    ]
    user_text = (
        "PROVENANCE COORDINATES:\n%s\n\nATOMS (re-read each amount from "
        "the source; the engine's readings are withheld):\n%s\n\n"
        "SOURCE DOCUMENT:\n%s"
        % (
            json.dumps(coordinates, sort_keys=True, ensure_ascii=False),
            json.dumps(atom_refs, sort_keys=True, ensure_ascii=False),
            source_text[:_MAX_SOURCE_CHARS],
        )
    )
    data = _call(
        client, prompt_version=prompt_version, system=_JOB1_SYSTEM,
        user_text=user_text, max_tokens=max_tokens, audit_stages=audit_stages,
    )

    readings: Dict[str, Optional[int]] = {}
    for entry in data.get("atoms") or []:
        if isinstance(entry, dict) and entry.get("id"):
            readings[str(entry["id"])] = _cents(entry.get("amount"))

    checked = 0
    agreed = 0
    disagreements: List[Dict[str, Any]] = []
    for atom in atoms:
        atom_id = str(atom.get("id"))
        engine_cents = _cents(atom.get("amount"))
        ai_cents = readings.get(atom_id)
        if ai_cents is None:
            continue
        checked += 1
        if ai_cents == engine_cents:
            agreed += 1
            continue
        disagreements.append({
            "atom_id": atom_id,
            "engine_reading": engine_cents / 100.0,
            "ai_reading": ai_cents / 100.0,
            "delta": (ai_cents - engine_cents) / 100.0,
        })
        # The ONE permitted write: raise the flag by id — never a value.
        ledger.raise_needs_review(atom_id)
        findings.append({
            "id": "extraction-%s" % atom_id,
            "severity": "flag",
            "code": "extraction_disagreement",
            "rationale": (
                "independent re-read disagrees on '%s': engine %.2f vs "
                "model %.2f (delta %.2f)"
                % (atom_id, engine_cents / 100.0, ai_cents / 100.0,
                   (ai_cents - engine_cents) / 100.0)
            ),
            "pointers": [atom_id],
        })

    return {
        "ran": True,
        "atoms_total": len(atoms),
        "atoms_checked": checked,
        "atoms_agreed": agreed,
        "atoms_unreturned": len(atoms) - checked,
        "agreement_score": (agreed / checked) if checked else None,
        "disagreements": disagreements,
    }


def _sanitize_findings(raw: Any) -> Any:
    """Whitelist projection: only {id, severity, code, rationale,
    pointers} survive, severity must be in the vocabulary, pointers are
    coerced to strings. Everything else — including any forged status /
    difference / mutation key — is dropped. Returns (findings, dropped)."""
    findings: List[Dict[str, Any]] = []
    dropped = 0
    for i, entry in enumerate(raw or []):
        if not isinstance(entry, dict) or entry.get("severity") not in SEVERITIES:
            dropped += 1
            continue
        finding = {
            "id": str(entry.get("id") or "finding-%d" % (i + 1)),
            "severity": str(entry["severity"]),
            "rationale": str(entry.get("rationale") or ""),
            "pointers": [str(p) for p in (entry.get("pointers") or [])
                         if isinstance(p, (str, int, float))],
        }
        if entry.get("code"):
            finding["code"] = str(entry["code"])
        findings.append(finding)
    return findings, dropped


def _job2_sanity_review(
    client: Any,
    cbs: Dict[str, Any],
    gateway: Optional[FactsGateway],
    prior_gateway: Optional[FactsGateway],
    prompt_version: str,
    max_tokens: int,
    audit_stages: List[Dict[str, Any]],
) -> Any:
    payload: Dict[str, Any] = {
        "status": cbs.get("status"),
        "facts": _facts_payload(gateway),
        "rows": _rows_compact(cbs),
        "deterministic_findings": cbs.get("diagnosis") or [],
        "unmapped_count": len(cbs.get("unmapped") or []),
        "statement_map": _statement_map_lines(cbs),
    }
    if prior_gateway is not None:
        payload["prior_facts"] = _facts_payload(prior_gateway)
    user_text = (
        "Advisory statement sanity review. Facts are integer minor units "
        "served by the facts gateway; findings are advisory only.\n"
        "INPUT:\n%s" % json.dumps(payload, sort_keys=True, ensure_ascii=False)
    )
    data = _call(
        client, prompt_version=prompt_version, system=_JOB2_SYSTEM,
        user_text=user_text, max_tokens=max_tokens, audit_stages=audit_stages,
    )
    return _sanitize_findings(data.get("findings"))


# ── The pure pass ──────────────────────────────────────────────────────


def run_ai_review(
    envelope: Dict[str, Any],
    gateway_facts: Optional[FactsGateway] = None,
    client_factory: Optional[Callable[[], Any]] = None,
    *,
    source_text: Optional[str] = None,
    prior_envelope: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Run both jobs over FROZEN views and return the ai_review layer.

    Raises :class:`AdvisoryUnavailable` on breaker trip / missing
    credits / client construction failure / model failure — the caller
    (the hook) degrades honestly; nothing is ever half-written.
    """
    if not isinstance(envelope, dict) or not isinstance(envelope.get("canonical_bs"), dict):
        raise AdvisoryUnavailable("not_reviewable", "envelope has no canonical_bs")

    try:
        breaker.check(ROLE)
    except breaker.BreakerOpen as e:
        raise AdvisoryUnavailable("breaker_open", e.reason)

    try:
        params = registry.params_for(ROLE)
    except registry.RegistryError as e:
        raise AdvisoryUnavailable("registry_error", str(e))
    prompt_version = params["prompt_version"]
    max_tokens = params["max_tokens"]

    # FROZEN VIEWS — the pass can never mutate pipeline state.
    env_view = copy.deepcopy(envelope)
    cbs = env_view["canonical_bs"]
    provenance = env_view.get("provenance") or {}
    gateway = gateway_facts
    if gateway is None:
        try:
            gateway = FactsGateway.from_envelope(copy.deepcopy(envelope))
        except Exception:  # noqa: BLE001 — facts are context; review still runs
            gateway = None
    prior_gateway = None
    if isinstance(prior_envelope, dict):
        try:
            prior_gateway = FactsGateway.from_envelope(copy.deepcopy(prior_envelope))
        except Exception:  # noqa: BLE001
            prior_gateway = None

    factory = client_factory if client_factory is not None else _default_client_factory
    try:
        client = factory()
    except Exception as e:  # noqa: BLE001 — missing key/credits/SDK → degrade
        raise AdvisoryUnavailable("client_unavailable", str(e))

    audit_stages: List[Dict[str, Any]] = []
    ledger = EscalationLedger()
    findings: List[Dict[str, Any]] = []

    extraction_verification = _job1_extraction_verification(
        client, cbs, provenance, source_text, prompt_version, max_tokens,
        audit_stages, ledger, findings,
    )
    model_findings, dropped = _job2_sanity_review(
        client, cbs, gateway, prior_gateway, prompt_version, max_tokens,
        audit_stages,
    )
    findings.extend(model_findings)

    review = {
        "schema": _SCHEMA,
        "role": ROLE,
        "model": params["model_id"],
        "prompt_version": prompt_version,
        "generated_at": _now_iso(),
        # Declared AND enforced: nothing reads this layer for status.
        "status_invariant": True,
        "extraction_verification": extraction_verification,
        "findings": findings,
        "dropped_findings": dropped,
        "needs_review_escalations": ledger.ids,
        "dismissals": [],
        # Raw responses per attempt — the persist-everything audit
        # contract, carried INSIDE the layer so a degraded run leaves
        # the envelope byte-identical (V3).
        "audit": {"stages": audit_stages},
    }
    logger.info(
        "[ai.advisory] review complete: findings=%d escalations=%d "
        "job1_ran=%s agreement=%s",
        len(findings), len(ledger.ids), extraction_verification.get("ran"),
        extraction_verification.get("agreement_score"),
    )
    return review


# ── The pipeline seam ──────────────────────────────────────────────────


def pipeline_hook(
    envelope: Any,
    *,
    gateway_facts: Optional[FactsGateway] = None,
    client_factory: Optional[Callable[[], Any]] = None,
    source_text: Optional[str] = None,
    prior_envelope: Optional[Dict[str, Any]] = None,
    enabled: Optional[bool] = None,
) -> None:
    """The one-line pipeline seam. NEVER raises; mutates the envelope
    ADDITIVELY only: `ai_review` on success, `ai_review_degraded` on an
    honest failure, nothing at all when disabled or not reviewable.
    Env-gated by AI_ADVISORY_ENABLED (default OFF)."""
    try:
        if enabled is None:
            enabled = os.environ.get(ENABLE_ENV, "").strip().lower() in (
                "1", "true", "yes", "on",
            )
        if not enabled:
            return
        if not isinstance(envelope, dict):
            return
        if not isinstance(envelope.get("canonical_bs"), dict):
            logger.debug("[ai.advisory] no canonical_bs — nothing to review")
            return
        try:
            review = run_ai_review(
                envelope,
                gateway_facts=gateway_facts,
                client_factory=client_factory,
                source_text=source_text,
                prior_envelope=prior_envelope,
            )
        except AdvisoryUnavailable as e:
            marker = breaker.degraded_marker(ROLE, e.reason)
            marker["detail"] = e.detail
            marker["at"] = _now_iso()
            envelope[DEGRADED_KEY] = marker
            logger.info(
                "[ai.advisory] degraded (%s) — serving proceeds: %s",
                e.reason, e.detail,
            )
            return
        envelope[AI_REVIEW_KEY] = review
    except Exception:  # noqa: BLE001 — the hook must never break the persist
        logger.exception("[ai.advisory] hook failed (non-fatal; no layer written)")


def hook_for_pipeline() -> Callable[..., None]:
    """The callable the coordinator wires into stage_persist."""
    return pipeline_hook


def dismiss_finding(
    envelope: Dict[str, Any],
    finding_id: str,
    *,
    dismissed_by: str,
    reason: str = "",
) -> Dict[str, Any]:
    """Dismiss one advisory finding — AUDITED, ADDITIVE. The finding
    itself stays (audit trail); the dismissal entry is appended to the
    layer; status/totals/serving are untouched by construction."""
    review = envelope.get(AI_REVIEW_KEY) if isinstance(envelope, dict) else None
    if not isinstance(review, dict):
        raise ValueError("envelope carries no ai_review layer to dismiss from")
    known = {f.get("id") for f in review.get("findings") or [] if isinstance(f, dict)}
    if finding_id not in known:
        raise ValueError("unknown finding id %r" % (finding_id,))
    entry = {
        "finding_id": str(finding_id),
        "dismissed_by": str(dismissed_by),
        "reason": str(reason or ""),
        "at": _now_iso(),
    }
    review.setdefault("dismissals", []).append(entry)
    return entry
