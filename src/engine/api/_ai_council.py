"""AI Council — extraction-integrity review of uploaded financial documents.

WHAT THIS IS
------------
An "AI Council" is a panel of independent Claude reviewers ("members"),
each of which scans a freshly-extracted document through its own lens and
returns a structured verdict. A deterministic chair then aggregates the
member verdicts into a single consensus review.

SCOPE (locked, per product decision 2026-07-20)
-----------------------------------------------
The council's ONLY concern is **extraction integrity** — i.e. "can we
trust the numbers the extractor pulled out of this file?". It does NOT
opine on financial health, fraud, plausibility vs industry, or valuation.
Three complementary members cover the lens:

  1. reconciliation_auditor  — does the reconstructed P&L tie to the
     statutory net profit (account 121) and does the balance sheet
     balance (Assets == Equity + Liabilities)?
  2. completeness_auditor    — given the account count, class coverage
     and unmapped/ignored lists, is anything whole missing?
  3. classification_auditor  — are there signs of RAS mis-classification
     that would DISTORT reconciliation (709 contra-revenue double-count,
     711 production-variation, mixed class-4 netting, class-44 VAT vs tax)?

BEHAVIOUR
---------
· Advisory only. The council NEVER blocks the pipeline. `run_council`
  never raises — any failure degrades to a partial or deterministic result.
· Graceful degradation. With no ANTHROPIC_API_KEY (or if every member
  call fails), the council falls back to a purely deterministic verdict
  computed from the reconciliation numbers themselves, so the feature is
  useful — and unit-testable — offline.
· Reproducible-ish. Members run with effort-constrained structured output
  at the lowest sampling the API allows; the chair is fully deterministic.

The public surface is:
  · run_council(assembled, parsed, *, model=..., api_key=None) -> dict
  · council_findings_as_alerts(council_result) -> list[dict]

Both return plain JSON-serialisable dicts so the pipeline can log,
persist, and ship them to the frontend without adapters.
"""

from __future__ import annotations

import concurrent.futures
import json
import logging
import os
import urllib.request
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


# ── Realtime event broadcast ─────────────────────────────────────────────
# The council streams its "thinking" to the frontend (the CouncilSphere
# visualizer) over a Supabase Realtime *broadcast* channel — no DB table,
# no migration. The FE subscribes to `council:{document_id}` and maps the
# events onto the sphere. Every broadcast is best-effort: a failure here
# NEVER affects the analysis (the council stays advisory + exception-safe).

def _broadcast(document_id: Optional[str], event_type: str, **fields: Any) -> None:
    if not document_id:
        return
    url = (os.environ.get("SUPABASE_URL") or os.environ.get("VITE_SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("VITE_SUPABASE_ANON_KEY")
    if not url or not key:
        return
    body = json.dumps({
        "messages": [{
            "topic": f"council:{document_id}",
            "event": "council",
            "payload": {"type": event_type, **fields},
        }],
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{url}/realtime/v1/api/broadcast",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "apikey": key,
            "Authorization": f"Bearer {key}",
        },
    )
    try:
        urllib.request.urlopen(req, timeout=5).read()
    except Exception as e:  # noqa: BLE001 — telemetry-only, never fatal
        logger.debug("[ai_council] broadcast %s failed: %s", event_type, e)

# The repo standardises on this model id (see ai_analyzer.claude_analysis).
# Override per-deploy with AI_COUNCIL_MODEL without touching code.
DEFAULT_MODEL = os.environ.get("AI_COUNCIL_MODEL", "claude-opus-4-7")

# Reconciliation thresholds mirror the methodology (CLAUDE.md §5, Gate 1/2):
#   P&L reconstruction acceptable within ±2%; balance sheet within ±1%.
PNL_TOLERANCE_PCT = 2.0
BS_TOLERANCE_PCT = 1.0

# A verdict ranking so "worst wins" aggregation is a simple max().
_VERDICT_RANK = {"pass": 0, "warn": 1, "fail": 2, "unknown": 3}
_RANK_VERDICT = {v: k for k, v in _VERDICT_RANK.items()}

# Council finding severity → persisted alert severity. Advisory: we cap at
# "high" (never "critical") because the council can't block, and a critical
# tag in the UI implies a hard stop the council doesn't enforce.
_SEVERITY_TO_ALERT = {"high": "high", "medium": "medium", "low": "low"}


# ── Member definitions ───────────────────────────────────────────────────
# Each member is a Claude persona with a distinct system prompt. They all
# receive the SAME evidence packet; the diversity is in what each is told
# to scrutinise. `key` is stable and used in alert_keys + telemetry.
_MEMBERS: List[Dict[str, str]] = [
    {
        "key": "reconciliation_auditor",
        "title": "Reconciliation Auditor",
        "system": (
            "You are the Reconciliation Auditor on an AI council that reviews "
            "the INTEGRITY OF A DATA EXTRACTION from a Romanian trial balance "
            "(balanță de verificare). You do NOT judge whether the company is "
            "healthy — only whether the extracted numbers are internally "
            "consistent and trustworthy.\n\n"
            "Focus strictly on two reconciliations:\n"
            "1. BALANCE SHEET: Total Assets must equal Total Equity + Total "
            f"Liabilities. A gap above ±{BS_TOLERANCE_PCT:.1f}% of total assets "
            "signals a mis-classified or dropped account, not a real imbalance.\n"
            "2. P&L: the reconstructed net result should be close to the "
            "statutory net profit carried in account 121 (the legally filed "
            f"figure). A gap above ±{PNL_TOLERANCE_PCT:.1f}% signals missing "
            "class 6/7 accounts or year-end classification entries.\n\n"
            "You are given the deterministically-computed gaps. Decide whether "
            "the extraction is trustworthy (pass), needs a human glance (warn), "
            "or is likely broken (fail). Be specific: cite the actual gap "
            "percentages and name the likely cause. Never invent numbers."
        ),
    },
    {
        "key": "completeness_auditor",
        "title": "Completeness Auditor",
        "system": (
            "You are the Completeness Auditor on an AI council that reviews the "
            "INTEGRITY OF A DATA EXTRACTION from a Romanian trial balance. Your "
            "single question: did the extractor capture the WHOLE document, or "
            "is a section missing?\n\n"
            "Signals of an incomplete extract:\n"
            "· Fewer than ~50 active accounts for a real operating company "
            "(likely a truncated PDF/page).\n"
            "· A whole RAS class absent — e.g. no class 5 (cash/bank), no class "
            "6 (expenses) or no class 7 (revenue) when the company clearly "
            "operates.\n"
            "· A large number of UNMAPPED accounts relative to total (the "
            "extractor read rows it couldn't place).\n"
            "· Trial balance debit totals not equal to credit totals.\n\n"
            "Decide: pass (looks complete), warn (suspicious gaps), or fail "
            "(clearly truncated). Cite the counts you were given. Never invent "
            "numbers."
        ),
    },
    {
        "key": "classification_auditor",
        "title": "Classification Auditor",
        "system": (
            "You are the Classification Auditor on an AI council that reviews "
            "the INTEGRITY OF A DATA EXTRACTION from a Romanian trial balance. "
            "You look ONLY for mapping mistakes that would DISTORT the "
            "reconciliations — not for accounting-policy opinions.\n\n"
            "Known RAS traps to check against the evidence:\n"
            "· 709 (commercial reductions) is contra-revenue and is ALREADY "
            "netted inside the class-70 turnover sum — double-subtracting it "
            "understates revenue.\n"
            "· 711 (production variation) nets debit vs credit to ~0; a large "
            "one-sided 711 suggests a sign error.\n"
            "· Class 4 is mixed: the same prefix can be a receivable (debit) or "
            "a payable (credit). Netting them collapses both sides.\n"
            "· Class 44 splits into VAT recoverable (442x debit = asset) vs "
            "taxes payable (441 credit = liability); summing as one is wrong.\n"
            "· 581 internal transfers and 121 control should be excluded from "
            "totals (they appear in the 'ignored' list when handled correctly).\n\n"
            "From the subtotals and ignored/unmapped lists you're given, decide: "
            "pass (no distortion evident), warn (a plausible mis-map), or fail "
            "(a mapping error that breaks reconciliation). Never invent numbers."
        ),
    },
]

# Strict structured-output schema each member must return.
_MEMBER_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "verdict": {
            "type": "string",
            "enum": ["pass", "warn", "fail"],
            "description": "Trust verdict on the extraction from this member's lens.",
        },
        "confidence": {
            "type": "number",
            "description": "0.0-1.0 confidence in the verdict.",
        },
        "summary": {
            "type": "string",
            "description": "One or two sentences, specific, citing the numbers you were given.",
        },
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "severity": {"type": "string", "enum": ["high", "medium", "low"]},
                    "title": {"type": "string"},
                    "detail": {"type": "string"},
                },
                "required": ["severity", "title", "detail"],
                "additionalProperties": False,
            },
            "description": "Zero or more concrete extraction-integrity concerns. Empty if clean.",
        },
    },
    "required": ["verdict", "confidence", "summary", "findings"],
    "additionalProperties": False,
}


# ── Evidence packet ──────────────────────────────────────────────────────

def _f(value: Any) -> Optional[float]:
    """Coerce to float or None — the assembled envelope mixes ints/floats/None."""
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _build_evidence(assembled: Dict[str, Any], parsed: Dict[str, Any]) -> Dict[str, Any]:
    """Compact, defensively-extracted packet the members reason over.

    Everything is pulled with .get() chains so a shape change upstream
    degrades to None rather than raising — the council must never crash the
    pipeline.
    """
    assembled = assembled or {}
    parsed = parsed or {}
    statements = assembled.get("statements") or {}
    bs = statements.get("assembled_bs") or {}
    pl = statements.get("assembled_pl") or {}

    accounts = parsed.get("accounts") or []
    account_count = len(accounts)

    # Class coverage — first digit of each account code. Confirms whole
    # sections (cash / expenses / revenue) are present.
    class_counts: Dict[str, int] = {}
    for a in accounts:
        code = str(a.get("code") or a.get("account") or a.get("cont") or "").strip()
        if code:
            cls = code[0]
            class_counts[cls] = class_counts.get(cls, 0) + 1

    total_assets = _f(bs.get("total_assets") or bs.get("totalAssets"))
    total_equity = _f(bs.get("total_equity") or bs.get("totalEquity"))
    total_liabilities = _f(bs.get("total_liabilities") or bs.get("totalLiabilities"))
    bs_balance_delta = _f(bs.get("bs_balance_delta"))
    if bs_balance_delta is None and None not in (total_assets, total_equity, total_liabilities):
        bs_balance_delta = total_assets - (total_equity + total_liabilities)

    bs_recon_pct = None
    if bs_balance_delta is not None and total_assets:
        bs_recon_pct = abs(bs_balance_delta) / abs(total_assets) * 100.0

    # P&L reconciliation: reconstructed operational result vs the statutory
    # 121 anchor. The anchor is captured by the parser before any line-drop.
    net_income_statutory = _f(
        pl.get("net_income_statutory")
        or bs.get("net_income_statutory")
        or parsed.get("statutory_net_profit_anchor")
    )
    net_income_reconstructed = _f(
        pl.get("net_income") or pl.get("net_profit") or pl.get("net_result")
    )
    pnl_recon_pct = None
    if (
        net_income_reconstructed is not None
        and net_income_statutory not in (None, 0)
    ):
        pnl_recon_pct = (
            abs(net_income_reconstructed - net_income_statutory)
            / abs(net_income_statutory)
            * 100.0
        )

    unmapped = assembled.get("unmapped") or []
    ignored = assembled.get("ignored") or []

    return {
        "company_name": parsed.get("company_name") or "Imported entity",
        "period_label": parsed.get("period_label") or parsed.get("period_end") or "Imported period",
        "currency": parsed.get("currency") or "RON",
        "account_count": account_count,
        "class_counts": class_counts,
        "unmapped_count": len(unmapped),
        "ignored_count": len(ignored),
        "totals": {
            "total_assets": total_assets,
            "total_equity": total_equity,
            "total_liabilities": total_liabilities,
        },
        "reconciliation": {
            "bs_balance_delta_ron": bs_balance_delta,
            "bs_reconciliation_pct": bs_recon_pct,
            "bs_tolerance_pct": BS_TOLERANCE_PCT,
            "net_income_statutory": net_income_statutory,
            "net_income_reconstructed": net_income_reconstructed,
            "pnl_reconciliation_pct": pnl_recon_pct,
            "pnl_tolerance_pct": PNL_TOLERANCE_PCT,
        },
        "source_data_quality": assembled.get("source_data_quality"),
    }


# ── Deterministic baseline ───────────────────────────────────────────────

def _deterministic_baseline(evidence: Dict[str, Any]) -> Dict[str, Any]:
    """A rule-based verdict computed purely from the reconciliation numbers.

    Serves two purposes: (1) the offline fallback when no LLM member can
    run, and (2) a grounding signal fed into every member prompt so the
    panel argues from the same facts. Pure function — fully reproducible.
    """
    recon = evidence.get("reconciliation") or {}
    findings: List[Dict[str, str]] = []
    verdict_rank = 0  # pass

    bs_pct = recon.get("bs_reconciliation_pct")
    if bs_pct is not None:
        if bs_pct > BS_TOLERANCE_PCT * 2:
            verdict_rank = max(verdict_rank, 2)
            findings.append({
                "severity": "high",
                "title": "Balance sheet does not reconcile",
                "detail": (
                    f"Assets vs Equity+Liabilities gap is {bs_pct:.2f}% "
                    f"(tolerance ±{BS_TOLERANCE_PCT:.1f}%). Likely a dropped or "
                    "mis-classified account."
                ),
            })
        elif bs_pct > BS_TOLERANCE_PCT:
            verdict_rank = max(verdict_rank, 1)
            findings.append({
                "severity": "medium",
                "title": "Balance sheet reconciliation outside tolerance",
                "detail": f"Assets vs Equity+Liabilities gap is {bs_pct:.2f}% (tolerance ±{BS_TOLERANCE_PCT:.1f}%).",
            })

    pnl_pct = recon.get("pnl_reconciliation_pct")
    if pnl_pct is not None:
        if pnl_pct > PNL_TOLERANCE_PCT * 2.5:
            verdict_rank = max(verdict_rank, 2)
            findings.append({
                "severity": "high",
                "title": "P&L does not reconcile to statutory net profit",
                "detail": (
                    f"Reconstructed net result differs from account 121 by "
                    f"{pnl_pct:.2f}% (tolerance ±{PNL_TOLERANCE_PCT:.1f}%). "
                    "Likely missing class 6/7 accounts."
                ),
            })
        elif pnl_pct > PNL_TOLERANCE_PCT:
            verdict_rank = max(verdict_rank, 1)
            findings.append({
                "severity": "low",
                "title": "P&L reconciliation slightly outside tolerance",
                "detail": (
                    f"Reconstructed net result differs from account 121 by "
                    f"{pnl_pct:.2f}% — usually year-end classification entries."
                ),
            })

    account_count = evidence.get("account_count") or 0
    if account_count and account_count < 50:
        verdict_rank = max(verdict_rank, 1)
        findings.append({
            "severity": "medium",
            "title": "Few accounts extracted",
            "detail": f"Only {account_count} accounts — the extract may be truncated.",
        })

    class_counts = evidence.get("class_counts") or {}
    if account_count >= 50:
        for cls, label in (("5", "cash/bank"), ("6", "expenses"), ("7", "revenue")):
            if class_counts.get(cls, 0) == 0:
                verdict_rank = max(verdict_rank, 1)
                findings.append({
                    "severity": "medium",
                    "title": f"No class {cls} accounts ({label})",
                    "detail": f"An operating company should have class {cls} ({label}); none were extracted.",
                })

    unmapped = evidence.get("unmapped_count") or 0
    if account_count and unmapped > max(5, account_count * 0.1):
        verdict_rank = max(verdict_rank, 1)
        findings.append({
            "severity": "low",
            "title": "Many unmapped accounts",
            "detail": f"{unmapped} of {account_count} accounts could not be mapped to the chart of accounts.",
        })

    confidence = 0.9 if verdict_rank == 0 else (0.6 if verdict_rank == 1 else 0.85)
    return {
        "verdict": _RANK_VERDICT[verdict_rank],
        "confidence": confidence,
        "summary": _baseline_summary(_RANK_VERDICT[verdict_rank], findings),
        "findings": findings,
    }


def _baseline_summary(verdict: str, findings: List[Dict[str, str]]) -> str:
    if verdict == "pass":
        return "Deterministic checks pass: reconciliations within tolerance and no structural gaps."
    lead = {
        "warn": "Deterministic checks raise minor concerns",
        "fail": "Deterministic checks indicate the extraction is unreliable",
    }.get(verdict, "Deterministic checks completed")
    return f"{lead}: {'; '.join(f['title'] for f in findings)}."


# ── Member calls ─────────────────────────────────────────────────────────

def _anthropic_client(api_key: Optional[str]):
    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    try:
        from anthropic import Anthropic
    except ImportError:
        return None
    # max_retries=5 covers transient 429/529 overloads, matching ai_analyzer.
    return Anthropic(api_key=key, max_retries=5, timeout=120.0)


def _parse_member_json(raw: str) -> Optional[Dict[str, Any]]:
    raw = (raw or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if "\n" in raw:
            raw = raw.split("\n", 1)[1]
        raw = raw.rsplit("```", 1)[0].strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _call_member(
    member: Dict[str, str],
    evidence: Dict[str, Any],
    baseline: Dict[str, Any],
    *,
    client,
    model: str,
    emit: Callable[..., None] = lambda *a, **k: None,
) -> Dict[str, Any]:
    """Run one member. Always returns a verdict dict; on any failure returns
    an availability-degraded verdict rather than raising. Streams
    member_active / finding / member_done broadcast events via `emit`."""
    base = {"member": member["key"], "member_title": member["title"], "model": model}

    if client is None:
        return {**base, "available": False, "verdict": None, "confidence": 0.0,
                "summary": "Member unavailable (no ANTHROPIC_API_KEY).", "findings": []}

    emit("member_active", member=member["key"])

    user_prompt = (
        "Review this freshly-extracted Romanian trial balance for EXTRACTION "
        "INTEGRITY only. Here is the evidence packet (numbers are already "
        "computed deterministically — reason from them, do not recompute):\n\n"
        f"```json\n{json.dumps(evidence, indent=2, default=str)}\n```\n\n"
        "For grounding, an independent rule-based checker reported:\n"
        f"```json\n{json.dumps(baseline, indent=2, default=str)}\n```\n\n"
        "Return your verdict in the required JSON shape. Agree or disagree "
        "with the rule-based checker as your judgment dictates, but cite the "
        "actual figures."
    )

    try:
        resp = client.messages.create(
            model=model,
            max_tokens=1500,
            system=[{"type": "text", "text": member["system"],
                     "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user_prompt}],
            output_config={
                "effort": "medium",
                "format": {"type": "json_schema", "schema": _MEMBER_SCHEMA},
            },
        )
    except Exception as e:  # noqa: BLE001 — advisory stage, degrade never crash
        logger.warning("[ai_council] member %s call failed: %s", member["key"], e)
        emit("member_done", member=member["key"], verdict=None)
        return {**base, "available": False, "verdict": None, "confidence": 0.0,
                "summary": f"Member call failed: {e}", "findings": []}

    text = "".join(
        getattr(b, "text", "") for b in resp.content if getattr(b, "type", None) == "text"
    )
    parsed = _parse_member_json(text)
    if not isinstance(parsed, dict) or parsed.get("verdict") not in ("pass", "warn", "fail"):
        logger.warning("[ai_council] member %s returned unusable output", member["key"])
        emit("member_done", member=member["key"], verdict=None)
        return {**base, "available": False, "verdict": None, "confidence": 0.0,
                "summary": "Member returned malformed output.", "findings": []}

    findings = parsed.get("findings")
    if not isinstance(findings, list):
        findings = []
    clean_findings = [
        {
            "severity": (f.get("severity") or "low").lower() if isinstance(f, dict) else "low",
            "title": (f.get("title") if isinstance(f, dict) else str(f)) or "Concern",
            "detail": (f.get("detail") if isinstance(f, dict) else "") or "",
        }
        for f in findings
    ]
    try:
        confidence = max(0.0, min(1.0, float(parsed.get("confidence", 0.5))))
    except (TypeError, ValueError):
        confidence = 0.5

    for f in clean_findings:
        emit("finding", member=member["key"], severity=f["severity"], title=f["title"])
    emit("member_done", member=member["key"], verdict=parsed["verdict"])

    return {
        **base,
        "available": True,
        "verdict": parsed["verdict"],
        "confidence": confidence,
        "summary": (parsed.get("summary") or "").strip(),
        "findings": clean_findings,
    }


# ── Chair (deterministic aggregation) ────────────────────────────────────

def _aggregate(members: List[Dict[str, Any]], baseline: Dict[str, Any]) -> Dict[str, Any]:
    """Deterministic chair. Consensus verdict = worst member verdict (a
    council flags on any credible concern). When no member ran, fall back to
    the deterministic baseline verdict."""
    voting = [m for m in members if m.get("available") and m.get("verdict")]

    if not voting:
        consensus = baseline["verdict"]
        confidence = baseline["confidence"]
        chair_note = "No AI members available; consensus is the deterministic baseline."
        member_findings: List[Dict[str, str]] = []
    else:
        worst_rank = max(_VERDICT_RANK[m["verdict"]] for m in voting)
        consensus = _RANK_VERDICT[worst_rank]
        confidence = round(sum(m["confidence"] for m in voting) / len(voting), 3)
        agreed = len({m["verdict"] for m in voting}) == 1
        chair_note = (
            f"{len(voting)} member(s) reviewed; "
            + ("unanimous" if agreed else "split — worst verdict adopted")
            + f". Verdict: {consensus}."
        )
        member_findings = [f for m in voting for f in m.get("findings", [])]

    # Union of baseline + member findings, deduped by lowercased title.
    all_findings = list(baseline.get("findings", [])) + member_findings
    deduped: List[Dict[str, str]] = []
    seen: set[str] = set()
    for f in all_findings:
        key = (f.get("title") or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(f)
    _sev_order = {"high": 0, "medium": 1, "low": 2}
    deduped.sort(key=lambda f: _sev_order.get((f.get("severity") or "low").lower(), 3))

    return {
        "verdict": consensus,
        "confidence": confidence,
        "chair_note": chair_note,
        "findings": deduped,
    }


# ── Public entry point ───────────────────────────────────────────────────

def run_council(
    assembled: Dict[str, Any],
    parsed: Dict[str, Any],
    *,
    model: str = DEFAULT_MODEL,
    api_key: Optional[str] = None,
    max_workers: int = 3,
    document_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Run the extraction-integrity council over one extracted document.

    Never raises. When `document_id` is provided, streams the council's
    "thinking" to the frontend (CouncilSphere) over the Supabase Realtime
    broadcast channel `council:{document_id}` — started / member_active /
    finding / member_done / verdict / done. Broadcasts are best-effort.

    Returns a JSON-serialisable dict:
      { verdict, confidence, summary, findings[], members[], evidence, model }
    """
    def emit(event_type: str, **fields: Any) -> None:
        _broadcast(document_id, event_type, **fields)

    try:
        evidence = _build_evidence(assembled, parsed)
        baseline = _deterministic_baseline(evidence)
    except Exception:  # noqa: BLE001
        logger.exception("[ai_council] evidence/baseline build failed; returning unknown")
        emit("done", verdict="unknown")
        return {
            "verdict": "unknown", "confidence": 0.0,
            "summary": "Council could not build evidence from the extraction.",
            "findings": [], "members": [], "evidence": {}, "model": model,
        }

    emit(
        "started",
        members=[m["key"] for m in _MEMBERS],
        files=[evidence.get("company_name") or "trial balance"],
        account_count=evidence.get("account_count") or 0,
    )

    client = _anthropic_client(api_key)
    members_out: List[Dict[str, Any]] = []
    if client is not None:
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as ex:
                futures = {
                    ex.submit(_call_member, m, evidence, baseline, client=client, model=model, emit=emit): m
                    for m in _MEMBERS
                }
                for fut in concurrent.futures.as_completed(futures):
                    members_out.append(fut.result())
        except Exception:  # noqa: BLE001
            logger.exception("[ai_council] member fan-out failed; degrading to baseline")
    else:
        logger.info("[ai_council] no ANTHROPIC_API_KEY — deterministic baseline only")
        members_out = [
            {"member": m["key"], "member_title": m["title"], "model": model,
             "available": False, "verdict": None, "confidence": 0.0,
             "summary": "Member unavailable (no ANTHROPIC_API_KEY).", "findings": []}
            for m in _MEMBERS
        ]
        # Baseline-only run: emit a synthetic per-member sweep so the
        # visualizer still animates the council even without live members.
        for m in _MEMBERS:
            emit("member_active", member=m["key"])
            emit("member_done", member=m["key"], verdict=baseline["verdict"])

    # Stable member ordering for reproducible output/logs.
    order = {m["key"]: i for i, m in enumerate(_MEMBERS)}
    members_out.sort(key=lambda m: order.get(m.get("member"), 99))

    consensus = _aggregate(members_out, baseline)
    emit("verdict", verdict=consensus["verdict"], confidence=consensus["confidence"],
         findings=len(consensus["findings"]))
    emit("done", verdict=consensus["verdict"])
    return {
        "verdict": consensus["verdict"],
        "confidence": consensus["confidence"],
        "summary": consensus["chair_note"],
        "findings": consensus["findings"],
        "members": members_out,
        "evidence": evidence,
        "model": model,
    }


# ── Pipeline bridge ──────────────────────────────────────────────────────

def council_findings_as_alerts(council_result: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Convert a council result into `validation_alerts`-shaped rows so the
    pipeline can surface them through the existing alerts channel (category
    'data_quality') without a schema migration.

    Emits one summary alert (info/medium/high by verdict) plus one alert per
    finding. alert_key is deterministic so re-runs upsert instead of
    duplicating.
    """
    if not council_result:
        return []

    verdict = council_result.get("verdict", "unknown")
    confidence = council_result.get("confidence", 0.0)
    summary_sev = {"pass": "info", "warn": "medium", "fail": "high"}.get(verdict, "info")

    alerts: List[Dict[str, Any]] = [{
        "alert_key": "ai_council::summary",
        "severity": summary_sev,
        "category": "data_quality",
        "title": f"AI Council extraction review: {verdict.upper()}",
        "body": (
            f"{council_result.get('summary', '')} "
            f"(confidence {float(confidence):.0%}). This is an advisory review "
            "of extraction integrity and does not block the analysis."
        ),
        "rule_key": "ai_council",
        "facts_cited": None,
        "industry": None,
    }]

    for i, f in enumerate(council_result.get("findings", []) or []):
        sev = _SEVERITY_TO_ALERT.get((f.get("severity") or "low").lower(), "low")
        title = (f.get("title") or "Extraction concern").strip()
        slug = "".join(c if c.isalnum() else "_" for c in title.lower())[:48]
        alerts.append({
            "alert_key": f"ai_council::finding::{i}::{slug}",
            "severity": sev,
            "category": "data_quality",
            "title": f"AI Council: {title}",
            "body": (f.get("detail") or "").strip(),
            "rule_key": "ai_council",
            "facts_cited": None,
            "industry": None,
        })
    return alerts
