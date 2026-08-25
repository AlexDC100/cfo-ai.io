"""In-process metrics registry + on-demand health collector (engine.obs).

REGISTRY — counters and histograms, plain dicts underneath, one
``snapshot()`` away from JSON. No Prometheus client, no exposition
format, no background thread: a :class:`MetricsRegistry` is filled by
whoever is measuring and dumped by whoever is asking.

COLLECTOR — :func:`collect_metrics` computes the engine health mix ON
DEMAND (a function call, never a daemon) from the three places truth
already lives:

  · the run journal (``ENGINE_JOURNAL_DIR`` / an explicit root):
    per-run events (front-end mix, reconcile outcomes, failures, DLQ
    depth, hash-chain verification) + the content-addressed objects
    (the parsed IR for cache-hit detection, the persisted envelopes for
    everything below);
  · the persisted envelopes themselves (the latest snapshot per
    document chain): imbalance ratio, machine status mix, extraction
    method (deterministic vs llm fallback), unclassified accounts,
    reconcile cause mix, AI-review agreement scores, verification
    coverage, token estimates from ``ai_audit`` (cost-per-doc);
  · the AI spend breaker state file (calls/tokens vs caps per role).

Totals discipline: balance-sheet amounts are read ONLY through the
facts gateway public API (``engine.serving.facts.FactsGateway``) — this
module never touches raw envelope totals (scripts/check_import_boundary
.py enforces exactly that).

Failure policy: every sub-collector degrades to an honest partial
result ({"error": ...} / zero coverage) — a broken journal, an
unreadable object, or a missing breaker file can never raise out of
:func:`collect_metrics`. With the journal disabled the collector
reports ``journal.enabled = false`` and empty mixes: honest absence,
never reconstruction.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("engine.obs.metrics")

#: Histogram bucket bounds (``le``; an implicit +Inf overflow bucket is
#: always appended). Imbalance ratios: |difference| / |assets|.
IMBALANCE_BUCKETS = (0.0, 0.00001, 0.0001, 0.001, 0.005, 0.01, 0.05)
AGREEMENT_BUCKETS = (0.5, 0.8, 0.9, 0.95, 0.99, 1.0)
TOKENS_BUCKETS = (1000.0, 5000.0, 20000.0, 50000.0, 100000.0, 250000.0)

#: Chains verified per collection (hash-chain re-verification reads every
#: event + object, so the ops surface bounds it; the journal CLI's
#: ``verify --all`` remains the exhaustive gate).
DEFAULT_VERIFY_LIMIT = 50

#: The rates the drift sentinels track (name → collector output key).
SENTINEL_RATE_KEYS = (
    "unclassified_rate",
    "ai_proposal_rate",
    "frontend_fallback_rate",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class MetricsRegistry(object):
    """Counters + histograms, JSON-dumpable, thread-safe, in-process."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: Dict[str, Dict[str, float]] = {}
        self._histograms: Dict[str, Dict[str, Any]] = {}

    # ── counters ───────────────────────────────────────────────────────

    def inc(self, name: str, key: str = "_", value: float = 1) -> None:
        """Increment counter ``name`` (sub-keyed — pass e.g. the
        front-end id as ``key``; the default key makes it a plain
        counter)."""
        with self._lock:
            bucket = self._counters.setdefault(str(name), {})
            bucket[str(key)] = bucket.get(str(key), 0) + value

    def counter(self, name: str) -> Dict[str, float]:
        with self._lock:
            return dict(self._counters.get(str(name), {}))

    def counter_total(self, name: str) -> float:
        return sum(self.counter(name).values())

    # ── histograms ─────────────────────────────────────────────────────

    def observe(
        self, name: str, value: float, buckets: Optional[Tuple[float, ...]] = None
    ) -> None:
        """Record one observation. Bucket bounds are fixed by the first
        ``observe`` for a name (later ``buckets`` args are ignored)."""
        try:
            v = float(value)
        except (TypeError, ValueError):
            return
        with self._lock:
            hist = self._histograms.get(str(name))
            if hist is None:
                bounds = tuple(float(b) for b in (buckets or IMBALANCE_BUCKETS))
                hist = {
                    "bounds": bounds,
                    "counts": [0] * (len(bounds) + 1),  # + the +Inf bucket
                    "count": 0,
                    "sum": 0.0,
                    "min": None,
                    "max": None,
                }
                self._histograms[str(name)] = hist
            idx = len(hist["bounds"])  # default: +Inf overflow
            for i, bound in enumerate(hist["bounds"]):
                if v <= bound:
                    idx = i
                    break
            hist["counts"][idx] += 1
            hist["count"] += 1
            hist["sum"] += v
            hist["min"] = v if hist["min"] is None else min(hist["min"], v)
            hist["max"] = v if hist["max"] is None else max(hist["max"], v)

    # ── export ─────────────────────────────────────────────────────────

    def snapshot(self) -> Dict[str, Any]:
        """A plain-dict view: ``json.dumps(registry.snapshot())`` always
        works (the +Inf bound is the string "+Inf", never a float)."""
        with self._lock:
            counters = {name: dict(vals) for name, vals in self._counters.items()}
            histograms: Dict[str, Any] = {}
            for name, hist in self._histograms.items():
                buckets = [
                    {"le": bound, "count": hist["counts"][i]}
                    for i, bound in enumerate(hist["bounds"])
                ]
                buckets.append({"le": "+Inf", "count": hist["counts"][-1]})
                histograms[name] = {
                    "count": hist["count"],
                    "sum": round(hist["sum"], 6),
                    "min": hist["min"],
                    "max": hist["max"],
                    "mean": (
                        round(hist["sum"] / hist["count"], 6) if hist["count"] else None
                    ),
                    "buckets": buckets,
                }
        return {"counters": counters, "histograms": histograms}


# ── collector internals ────────────────────────────────────────────────


def _repo_root() -> Path:
    # src/engine/obs/metrics.py -> parents[3] == repo root (/app in-container).
    return Path(__file__).resolve().parents[3]


def default_journal_root() -> Optional[Path]:
    env = os.environ.get("ENGINE_JOURNAL_DIR")
    if env:
        return Path(env)
    fallback = _repo_root() / "data" / "journal"
    return fallback if fallback.is_dir() else None


def _open_journal(journal_root: Optional[Any]) -> Optional[Any]:
    # An EXPLICIT root (argument or ENGINE_JOURNAL_DIR) is honored even
    # when empty — Journal() creates its subdirs exactly as the first
    # pipeline write would. Only the implicit repo-local fallback
    # requires the directory to already exist (a collector must not
    # invent a data/journal tree nobody configured).
    root = Path(journal_root) if journal_root is not None else default_journal_root()
    if root is None:
        return None
    try:
        from engine.journal import Journal

        return Journal(root)
    except Exception:  # noqa: BLE001
        logger.exception("[obs.metrics] journal open failed (non-fatal)")
        return None


def _read_object(journal: Any, digest: Optional[str]) -> Optional[Dict[str, Any]]:
    if not digest:
        return None
    try:
        data = journal.store.read_object(str(digest))
        obj = json.loads(data.decode("utf-8"))
        return obj if isinstance(obj, dict) else None
    except Exception:  # noqa: BLE001 — missing/corrupt object = no coverage
        return None


def _estimate_tokens(text: Any) -> int:
    """Chars/4 — the standing rough estimate for audit transcripts that
    carry raw response text but no usage counters."""
    if not isinstance(text, str):
        return 0
    return max(1, len(text) // 4) if text else 0


def _envelope_token_estimate(envelope: Dict[str, Any]) -> int:
    total = 0
    audit = envelope.get("ai_audit")
    if isinstance(audit, dict):
        for stage in audit.get("stages") or []:
            if isinstance(stage, dict):
                total += _estimate_tokens(stage.get("raw_response"))
    review = envelope.get("ai_review")
    if isinstance(review, dict):
        review_audit = review.get("audit")
        if isinstance(review_audit, dict):
            for stage in review_audit.get("stages") or []:
                if isinstance(stage, dict):
                    total += _estimate_tokens(stage.get("raw_response"))
    return total


def _imbalance_ratio(envelope: Dict[str, Any]) -> Optional[float]:
    """|served difference| / |served assets| through the facts gateway
    (the ONE sanctioned totals reader). None when the gateway cannot
    serve both facts."""
    try:
        from engine.serving.facts import FactsGateway, MissingFactError

        gateway = FactsGateway.from_envelope(envelope)
        if gateway is None:
            return None
        try:
            assets = gateway.total_assets().amount_minor
            diff = gateway.difference().amount_minor
        except MissingFactError:
            return None
        if not assets:
            return None
        return abs(diff) / float(abs(assets))
    except Exception:  # noqa: BLE001
        logger.debug("[obs.metrics] gateway read failed", exc_info=True)
        return None


def _rate(numerator: float, denominator: float) -> Optional[float]:
    if not denominator:
        return None
    return round(numerator / float(denominator), 6)


def _collect_chain(
    journal: Any,
    chain_key: str,
    registry: MetricsRegistry,
    tally: Dict[str, float],
) -> None:
    events = journal.chain_events(chain_key)
    latest_snapshot_digest: Optional[str] = None
    for event in events:
        etype = event.get("type")
        payload = event.get("payload") or {}
        if etype == "RUN_STARTED":
            registry.inc("runs_started")
        elif etype == "RUN_FAILED":
            registry.inc("runs_failed", str(payload.get("stage") or "unknown"))
        elif etype == "FRONTEND_DONE":
            registry.inc("frontend_mix", str(payload.get("front_end_id") or "unknown"))
            parsed = _read_object(journal, payload.get("ir_hash"))
            lane = (parsed or {}).get("ai_lane")
            if isinstance(lane, dict):
                tally["ai_lane_runs"] += 1
                if lane.get("cached"):
                    tally["ai_lane_cache_hits"] += 1
                    registry.inc("ai_lane_cache", "hit")
                else:
                    registry.inc("ai_lane_cache", "miss")
        elif etype == "RECONCILE_APPLIED":
            registry.inc("reconcile_outcomes", "applied")
            registry.inc(
                "reconcile_causes", str(payload.get("diagnosis_code") or "unknown")
            )
            if str(payload.get("origin") or "") == "ai":
                tally["ai_reconcile_proposals"] += 1
        elif etype == "RECONCILE_SKIPPED":
            reason = str(payload.get("reason") or "unknown")
            registry.inc("reconcile_outcomes", reason)
            if reason == "needs_review":
                tally["reconcile_refused"] += 1
        elif etype == "SNAPSHOT_PERSISTED":
            latest_snapshot_digest = payload.get("content_hash")
        elif etype in ("AI_REVIEW_DONE", "AI_REVIEW_DEGRADED"):
            registry.inc("ai_review_events", etype.lower())

    envelope = _read_object(journal, latest_snapshot_digest)
    if envelope is None:
        return
    tally["docs"] += 1

    # Machine status + extraction method (front-end fallback) mixes.
    cbs = envelope.get("canonical_bs")
    cbs = cbs if isinstance(cbs, dict) else {}
    status = cbs.get("status")
    if status:
        registry.inc("status_mix", str(status))
    extraction = cbs.get("extraction")
    extraction = extraction if isinstance(extraction, dict) else {}
    method = str(extraction.get("method") or "unknown")
    registry.inc("extraction_method_mix", method)
    if method == "llm":
        tally["llm_docs"] += 1

    # Imbalance ratio through the facts gateway.
    ratio = _imbalance_ratio(envelope)
    if ratio is not None:
        registry.observe("imbalance_ratio", ratio, IMBALANCE_BUCKETS)

    # Unclassified accounts (explicit `unmapped` — never guessed rows).
    unmapped = cbs.get("unmapped")
    unmapped_count = len(unmapped) if isinstance(unmapped, list) else 0
    row_list = cbs.get("rows")
    row_count = len(row_list) if isinstance(row_list, list) else 0
    if unmapped_count:
        tally["docs_with_unclassified"] += 1
        registry.inc("unclassified_accounts", "_", unmapped_count)
    tally["accounts_total"] += unmapped_count + row_count
    tally["accounts_unclassified"] += unmapped_count

    # Reconcile cause mix from the persisted receipt (covers periods
    # reconciled before the journal existed, plus manual applies).
    receipt = envelope.get("reconciliation")
    if isinstance(receipt, dict):
        registry.inc("reconciled_docs", str(receipt.get("origin") or "unknown"))
        if str(receipt.get("origin") or "") == "ai":
            tally["ai_reconcile_docs"] += 1
    auto = envelope.get("reconciliation_auto")
    if isinstance(auto, dict):
        registry.inc(
            "reconcile_auto_refused", str(auto.get("outcome") or "unknown")
        )

    # AI review — agreement scores + verification coverage.
    review = envelope.get("ai_review")
    if isinstance(review, dict):
        tally["reviewed_docs"] += 1
        verification = review.get("extraction_verification")
        if isinstance(verification, dict):
            score = verification.get("agreement_score")
            if isinstance(score, (int, float)):
                tally["verified_docs"] += 1
                registry.observe("ai_agreement_score", float(score), AGREEMENT_BUCKETS)
    if isinstance(envelope.get("ai_review_degraded"), dict):
        registry.inc("ai_review_events", "degraded_marker")

    # Part-E KPIs — derived from the shapes the consensus /
    # interpretation lanes actually persist (integration-aligned
    # 2026-08-25). The consensus block lives at canonical_bs.consensus
    # (attached by engine.consensus.persist / popped there by the
    # canonical builder); interpreter/template provenance rides the
    # extraction stamp (interpreter_roles / template_fingerprint / the
    # consensus mode). Top-level marker dicts are ACCEPTED TOO as a
    # forward-compat alias. Envelopes without any marker contribute
    # nothing: the rates stay honest None (never 0.0).
    cbs_block = envelope.get("canonical_bs")
    cbs_consensus = (
        cbs_block.get("consensus") if isinstance(cbs_block, dict) else None
    )
    consensus = (
        cbs_consensus if isinstance(cbs_consensus, dict)
        else envelope.get("consensus")
    )
    if isinstance(consensus, dict):
        tally["consensus_compared"] += 1
        agreed = (
            consensus.get("agreement") is True
            or consensus.get("consensus_pct") == 100
            or consensus.get("consensus_pct") == 100.0
        )
        if agreed:
            tally["consensus_agreements"] += 1
        registry.inc("consensus_compare", "agree" if agreed else "disagree")
    extraction_block = (
        cbs_block.get("extraction") if isinstance(cbs_block, dict) else None
    )
    interp_marker: Optional[Dict[str, Any]] = None
    if isinstance(envelope.get("interpretation"), dict):
        interp_marker = dict(envelope["interpretation"])
    elif isinstance(extraction_block, dict) and (
        extraction_block.get("interpreter_roles")
        or extraction_block.get("template_fingerprint")
        or str(extraction_block.get("method") or "") == "mechanical_mapped"
    ):
        interp_marker = {}
        if extraction_block.get("template_fingerprint"):
            interp_marker["template_hit"] = (
                isinstance(consensus, dict)
                and consensus.get("mode") == "template"
            )
    if interp_marker is not None:
        tally["interpreter_calls"] += 1
        registry.inc("interpreter_calls")
        if "template_hit" in interp_marker:
            tally["template_lookups"] += 1
            hit = interp_marker.get("template_hit") is True
            if hit:
                tally["template_hits"] += 1
            registry.inc("template_lookup", "hit" if hit else "miss")

    # Cost per doc (token estimates from the audit transcripts).
    tokens = _envelope_token_estimate(envelope)
    if tokens:
        registry.observe("ai_tokens_est_per_doc", float(tokens), TOKENS_BUCKETS)
        tally["ai_tokens_est"] += tokens


def collect_metrics(
    journal_root: Optional[Any] = None,
    *,
    verify_limit: int = DEFAULT_VERIFY_LIMIT,
    registry: Optional[MetricsRegistry] = None,
) -> Dict[str, Any]:
    """Compute the health mix now, from what is persisted. Never raises."""
    registry = registry or MetricsRegistry()
    tally: Dict[str, float] = {
        "docs": 0,
        "llm_docs": 0,
        "docs_with_unclassified": 0,
        "accounts_total": 0,
        "accounts_unclassified": 0,
        "ai_lane_runs": 0,
        "ai_lane_cache_hits": 0,
        "ai_reconcile_proposals": 0,
        "ai_reconcile_docs": 0,
        "reconcile_refused": 0,
        "reviewed_docs": 0,
        "verified_docs": 0,
        "ai_tokens_est": 0,
        "consensus_compared": 0,
        "consensus_agreements": 0,
        "interpreter_calls": 0,
        "template_lookups": 0,
        "template_hits": 0,
    }
    out: Dict[str, Any] = {
        "schema": "obs_metrics_v1",
        "generated_at": _now_iso(),
        "journal": {"enabled": False, "root": None, "chains": 0},
        "verification": {"checked": 0, "failed": 0, "errors": []},
        "dlq_depth": 0,
    }

    journal = _open_journal(journal_root)
    if journal is not None:
        out["journal"] = {
            "enabled": True,
            "root": str(getattr(journal, "root", "")),
            "chains": 0,
        }
        try:
            chains = journal.list_chains()
            out["journal"]["chains"] = len(chains)
            for chain_key in chains:
                try:
                    _collect_chain(journal, chain_key, registry, tally)
                except Exception:  # noqa: BLE001 — one bad chain never hides the rest
                    logger.exception(
                        "[obs.metrics] chain %s collection failed", chain_key
                    )
            for chain_key in chains[: max(0, int(verify_limit))]:
                try:
                    errors = journal.verify_chain(chain_key)
                except Exception as exc:  # noqa: BLE001
                    errors = ["verify raised: %s" % (exc,)]
                out["verification"]["checked"] += 1
                if errors:
                    out["verification"]["failed"] += 1
                    remaining = 5 - len(out["verification"]["errors"])
                    if remaining > 0:
                        out["verification"]["errors"].extend(errors[:remaining])
            try:
                out["dlq_depth"] = journal.dlq_depth()
            except Exception:  # noqa: BLE001
                logger.exception("[obs.metrics] dlq depth failed (non-fatal)")
        except Exception:  # noqa: BLE001
            logger.exception("[obs.metrics] journal walk failed (non-fatal)")

    # Breaker (AI spend) — file-backed, safe to read anywhere.
    try:
        from engine.ai import breaker as _breaker

        out["ai_spend"] = _breaker.status_snapshot()
    except Exception as exc:  # noqa: BLE001
        out["ai_spend"] = {"error": str(exc)}

    docs = tally["docs"]
    out["rates"] = {
        # Docs-with-any-unclassified — the sentinel headline ("a SAGA
        # variant we can't fully map showed up").
        "unclassified_rate": _rate(tally["docs_with_unclassified"], docs),
        # Finer-grained: unclassified accounts over all classified rows.
        "unclassified_account_rate": _rate(
            tally["accounts_unclassified"], tally["accounts_total"]
        ),
        "ai_proposal_rate": _rate(tally["ai_reconcile_docs"], docs),
        "frontend_fallback_rate": _rate(tally["llm_docs"], docs),
        "cache_hit_rate": _rate(tally["ai_lane_cache_hits"], tally["ai_lane_runs"]),
        "verification_coverage": _rate(tally["verified_docs"], tally["llm_docs"]),
        "avg_ai_tokens_per_doc": _rate(tally["ai_tokens_est"], docs),
        # Part-E KPIs (error-budget wave). consensus/template rates are
        # None until a consensus run / template lookup ever happens;
        # interpreter_call_rate is per served doc (0.0 is a real
        # measurement once any doc exists) and is expected to DECLINE
        # as the template library grows.
        "consensus_agreement_rate": _rate(
            tally["consensus_agreements"], tally["consensus_compared"]
        ),
        "interpreter_call_rate": _rate(tally["interpreter_calls"], docs),
        "template_hit_rate": _rate(
            tally["template_hits"], tally["template_lookups"]
        ),
    }
    out["coverage"] = {key: int(value) for key, value in tally.items()}
    out.update(registry.snapshot())
    return out
