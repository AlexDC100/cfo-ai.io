"""ATTENTION ITEMS — the detectors and the runner.

One function per KIND declared in packs/firm/attention.yaml, each a
cheap read over :class:`engine.firm.facts.ClientFacts` (the expensive,
cached half) and an explicit ``as_of``. A detector returns the items it
emitted and the GAPS it could not evaluate — there is no third outcome,
and a kind that "noticed something" it cannot quantify records a gap,
it does not narrate.

    from engine.firm.attention import compute_firm_attention

    report = compute_firm_attention(clients, as_of=date(2026, 2, 10))
    report.to_payload()

WHAT EVERY DETECTOR HOLDS ITSELF TO
  DETERMINISTIC. No clock (``as_of`` is an argument), no model, no
  registry lookup — the same client data and the same day produce the
  same items in the same order with the same severities.
  FACTS THROUGH THE GATEWAY. Every money figure cited comes from a
  :class:`MoneyFact` the facts stage read through the FactsGateway, and
  every division goes through ``_ratio_units`` (same unit, same currency,
  same scale, or a refusal).
  MATERIALITY PER CLIENT. Money-bearing kinds are graded against the
  client's OWN total assets by the ranker's policy; an absent basis is
  a refusal the item carries, never a default tier.
  ABSENT != ZERO. A missing input is a :class:`Gap` on the client.
  NO NAME BRANCHES. Kinds, profiles and jurisdictions are data keys;
  nothing here compares one to a literal (N7 / E8).

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from . import cadence as CAD
from ._deps import company_profile as CP
from ._deps import finding_rank as R
from ._deps import ratio_units as _ratio_units
from .calendar import ROLE_FILING, FiscalCalendar, load_calendar
from .dedup import ClientRow, group_by_client
from .facts import (AttentionCache, ClientFacts, MoneyFact, PeriodFacts,
                    build_client_facts, snapshot_key)
from .model import (UNIT_COUNT, UNIT_DATE, UNIT_DAYS, UNIT_PERCENT, UNIT_RATIO,
                    UNIT_TEXT, AttentionItem, ClientRecord, EvidenceFact, Gap,
                    money_evidence, number_evidence, text_evidence)
from .pack import AttentionPack, KindSpec, load_attention_pack
from .severity import assess, grade
from .suppress import SuppressionIndex, apply_suppressions

logger = logging.getLogger(__name__)

ATTENTION_VERSION = "firm_attention_v1"

#: Kind ids — the registry keys. They name a ROW of attention.yaml, and
#: the coverage check below refuses a detector the pack does not declare
#: (or a declared, enabled kind with no detector).
KIND_MISSING_FILE = "MISSING_FILE"
KIND_STALE_PERIOD = "STALE_PERIOD"
KIND_PERIOD_MISMATCH = "PERIOD_MISMATCH"
KIND_IMBALANCED = "IMBALANCED"
KIND_CRITICAL_FINDING = "CRITICAL_FINDING"
KIND_COVENANT_RISK = "COVENANT_RISK"
KIND_CASH_RUNWAY = "CASH_RUNWAY"
KIND_NEGATIVE_EQUITY = "NEGATIVE_EQUITY"
KIND_DEADLINE = "DEADLINE"

_COMPARATORS_HIGHER_IS_SAFE = (">=", ">")
_COMPARATORS_LOWER_IS_SAFE = ("<=", "<")


class KindCoverageError(RuntimeError):
    """The pack and this module disagree about which kinds exist. Fatal
    on purpose: an enabled kind with no detector is a rule the firm
    believes is running and is not; a detector for a disabled kind is a
    stub that could emit."""


# ── Context ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Ctx:
    client: ClientRecord
    facts: ClientFacts
    as_of: date
    pack: AttentionPack
    policy: "R.MaterialityPolicy"
    calendar: Optional[FiscalCalendar]
    client_cadence: Optional["CAD.ClientCadence"]
    cadence_status: Optional["CAD.CadenceStatus"]
    cadence_gap: Optional[str]

    def spec(self, kind: str) -> KindSpec:
        return self.pack.kind(kind)

    def latest(self) -> Optional[PeriodFacts]:
        return self.facts.latest()


Outcome = Tuple[List[AttentionItem], List[Gap]]
DetectorFn = Callable[[Ctx], Outcome]


def _render(template: str, tokens: Dict[str, Any]) -> str:
    """Not `str.format`: a stray brace in pack copy must not take the
    board down. Unknown tokens stay visible."""
    text = " ".join((template or "").split())
    for key in sorted(tokens):
        text = text.replace("{%s}" % key, str(tokens[key]))
    return text


def _money_ev(pf: PeriodFacts, fact: MoneyFact, label: str) -> EvidenceFact:
    return money_evidence(fact.name, label, fact.value, fact.currency,
                          pf.period_id, fact.snapshot_id or pf.snapshot_id,
                          fact.line_id)


def _q(fact: MoneyFact, name: Optional[str] = None) -> "_ratio_units.Quantity":
    return _ratio_units.money(fact.value, fact.currency, name=name or fact.name)


def _materiality(ctx: Ctx, spec: KindSpec, pf: Optional[PeriodFacts],
                 amount: float) -> Tuple[Optional["R.MaterialityVerdict"], Optional[str]]:
    basis_id = spec.materiality_basis
    if basis_id is None:
        return None, None
    basis = pf.fact(basis_id) if pf is not None else None
    currency = (basis.currency if basis else (pf.currency if pf else "RON"))
    return assess(ctx.policy, basis_id, basis_id.replace("_", " "),
                  (basis.value if basis else None), float(amount), currency)


def _persistence(facts: ClientFacts, predicate: Callable[[PeriodFacts], bool]) -> int:
    """Consecutive periods (newest first) for which the predicate holds."""
    count = 0
    for pf in facts.periods:
        if not pf.has_trial_balance:
            continue
        if not predicate(pf):
            break
        count += 1
    return max(1, count)


def _item(ctx: Ctx, spec: KindSpec, reason: str, action: str,
          evidence: Sequence[EvidenceFact], scope_key: str,
          period_id: Optional[str], due_at: Optional[date], graded: Any,
          materiality: Optional["R.MaterialityVerdict"],
          refusal: Optional[str], persistence: int) -> AttentionItem:
    days = (due_at - ctx.as_of).days if due_at is not None else None
    return AttentionItem(
        client_id=ctx.client.client_id, kind=spec.kind,
        severity=graded.severity, reason=reason, action=action,
        evidence=tuple(evidence), scope_key=scope_key, period_id=period_id,
        due_at=(due_at.isoformat() if due_at else None), days_to_due=days,
        base_severity=spec.base_severity, severity_breakdown=graded.breakdown,
        materiality=(materiality.to_payload() if materiality else None),
        materiality_refusal=refusal, persistence=persistence, source=spec.source)


# ── MISSING_FILE ─────────────────────────────────────────────────────────


def detect_missing_file(ctx: Ctx) -> Outcome:
    spec = ctx.spec(KIND_MISSING_FILE)
    items = []  # type: List[AttentionItem]
    gaps = []  # type: List[Gap]
    seen = set()  # type: set

    # (1) A period ROW that exists without a usable trial balance.
    for period in ctx.client.periods_desc():
        if period.has_trial_balance():
            continue
        end = _as_date(period.period_end)
        if end is None:
            gaps.append(Gap(spec.kind, "period %s has an unreadable period_end %r"
                            % (period.period_id, period.period_end), period.period_id))
            continue
        due = (CAD.deadline_for(ctx.client_cadence, end)
               if ctx.client_cadence is not None else None)
        items.append(_missing_item(ctx, spec, end, due, period.period_id,
                                   "period row exists without a trial balance"))
        seen.add(end)

    # (2) Expected periods the cadence says are due and unfiled.
    status = ctx.cadence_status
    if status is None:
        gaps.append(Gap(spec.kind, ctx.cadence_gap or
                        "cadence could not be resolved for this client"))
        return items, gaps
    for end in status.missing_period_ends:
        if end in seen:
            continue
        items.append(_missing_item(ctx, spec, end,
                                   CAD.deadline_for(ctx.client_cadence, end), None,
                                   "expected by the client's cadence, not filed"))
        seen.add(end)
    # (3) The OPEN period: ended, deadline ahead, nothing attached yet —
    # this is the item that escalates toward the deadline.
    if status.open_period_end is not None and status.open_period_filed is False \
            and status.open_period_end not in seen:
        end = status.open_period_end
        items.append(_missing_item(ctx, spec, end,
                                   CAD.deadline_for(ctx.client_cadence, end), None,
                                   "open period, deadline ahead"))
    return items, gaps


def _missing_item(ctx: Ctx, spec: KindSpec, period_end: date, due: Optional[date],
                  period_id: Optional[str], basis: str) -> AttentionItem:
    days = (due - ctx.as_of).days if due is not None else None
    graded = grade(spec, ctx.pack.severity, days_to_due=days)
    evidence = [
        text_evidence("period_end", "period without a trial balance",
                      period_end.isoformat(), unit=UNIT_DATE, period_id=period_id,
                      source="financial_periods"),
        text_evidence("missing_basis", "why it is expected", basis,
                      period_id=period_id, source="firm.cadence"),
    ]
    if due is not None:
        evidence.append(text_evidence("due_at", "trial balance due", due.isoformat(),
                                      unit=UNIT_DATE, period_id=period_id,
                                      source="firm.cadence"))
        evidence.append(number_evidence("days_to_due_days", "days to the deadline",
                                        UNIT_DAYS, float(days), period_id, None,
                                        source="firm.cadence"))
    tokens = {"period_label": period_end.isoformat(),
              "deadline_label": ("deadline of %s" % due.isoformat())
              if due else "deadline"}
    return _item(ctx, spec, _render(spec.reason_template, tokens),
                 _render(spec.action_template, tokens), evidence,
                 scope_key="period:%s" % period_end.isoformat(),
                 period_id=period_id, due_at=due, graded=graded,
                 materiality=None, refusal=None, persistence=1)


# ── STALE_PERIOD ─────────────────────────────────────────────────────────


def detect_stale_period(ctx: Ctx) -> Outcome:
    spec = ctx.spec(KIND_STALE_PERIOD)
    status = ctx.cadence_status
    if status is None:
        return [], [Gap(spec.kind, ctx.cadence_gap or
                        "cadence could not be resolved for this client")]
    if status.state == CAD.STATE_NEVER_FILED:
        return [], [Gap(spec.kind, "no period has ever been attached, so there is "
                                   "no latest period to age")]
    if status.state != CAD.STATE_STALE or status.latest_filed_period_end is None:
        return [], []
    latest = status.latest_filed_period_end
    age_days = (ctx.as_of - latest).days
    over = int(status.days_overdue or 0)
    graded = grade(spec, ctx.pack.severity, days_over_budget=over)
    latest_pf = ctx.latest()
    evidence = [
        text_evidence("latest_period_end", "latest attached period",
                      latest.isoformat(), unit=UNIT_DATE,
                      period_id=(latest_pf.period_id if latest_pf else None),
                      snapshot_id=(latest_pf.snapshot_id if latest_pf else None)),
        number_evidence("age_days", "age of the latest attached period", UNIT_DAYS,
                        float(age_days), None, None, source="firm.cadence"),
        number_evidence("days_overdue_days", "days past the oldest missing "
                        "period's deadline", UNIT_DAYS, float(over), None, None,
                        source="firm.cadence"),
        number_evidence("periods_behind_count", "expected periods behind",
                        UNIT_COUNT, float(status.periods_behind or 0), None, None,
                        source="firm.cadence"),
    ]
    tokens = {"period_label": latest.isoformat(), "age_days": age_days,
              "cadence": status.cadence_id}
    return [_item(ctx, spec, _render(spec.reason_template, tokens),
                  _render(spec.action_template, tokens), evidence,
                  scope_key="latest:%s" % latest.isoformat(),
                  period_id=(latest_pf.period_id if latest_pf else None),
                  due_at=None, graded=graded, materiality=None, refusal=None,
                  persistence=1)], []


# ── PERIOD_MISMATCH ──────────────────────────────────────────────────────


def detect_period_mismatch(ctx: Ctx) -> Outcome:
    spec = ctx.spec(KIND_PERIOD_MISMATCH)
    items = []  # type: List[AttentionItem]
    for pf in ctx.facts.periods:
        record = pf.period_detection
        if not isinstance(record, dict) or record.get("mismatch") is not True:
            continue
        detected = record.get("detected") if isinstance(record.get("detected"), dict) else {}
        proposed = detected.get("proposed_period_end")
        stored = record.get("resolved_period_end") or pf.period_end
        if not proposed:
            continue  # a mismatch flag with no detection is not evidence
        confidence = detected.get("confidence")
        evidence = [
            text_evidence("stored_period_end", "period the file is filed under",
                          str(stored), unit=UNIT_DATE, period_id=pf.period_id,
                          snapshot_id=pf.snapshot_id),
            text_evidence("detected_period_end", "period the document itself states",
                          str(proposed), unit=UNIT_DATE, period_id=pf.period_id,
                          snapshot_id=pf.snapshot_id),
            text_evidence("detection_signal", "detection signal",
                          str(detected.get("signal_used") or ""), unit=UNIT_TEXT,
                          period_id=pf.period_id, snapshot_id=pf.snapshot_id),
        ]
        if isinstance(confidence, (int, float)) and not isinstance(confidence, bool):
            evidence.append(number_evidence(
                "detection_confidence_pct", "detection confidence", UNIT_PERCENT,
                float(confidence), pf.period_id, pf.snapshot_id))
        snippet = detected.get("evidence_snippet")
        if snippet:
            evidence.append(text_evidence("evidence_snippet", "the document text that "
                                          "produced the detection", str(snippet),
                                          period_id=pf.period_id,
                                          snapshot_id=pf.snapshot_id))
        graded = grade(spec, ctx.pack.severity)
        tokens = {"detected_period_end": proposed, "stored_period_end": stored}
        items.append(_item(ctx, spec, _render(spec.reason_template, tokens),
                           _render(spec.action_template, tokens), evidence,
                           scope_key="period:%s" % pf.period_id,
                           period_id=pf.period_id, due_at=None, graded=graded,
                           materiality=None, refusal=None, persistence=1))
    return items, []


# ── IMBALANCED ───────────────────────────────────────────────────────────


def _is_open(ctx: Ctx, pf: PeriodFacts) -> bool:
    return bool(pf.served_status) and pf.served_status not in ctx.pack.closed_statuses


def detect_imbalanced(ctx: Ctx) -> Outcome:
    spec = ctx.spec(KIND_IMBALANCED)
    pf = ctx.latest()
    if pf is None:
        return [], [Gap(spec.kind, "no period with a trial balance is attached")]
    if not pf.served_status:
        return [], [Gap(spec.kind, "the served statement carries no status "
                                   "(%s)" % (pf.gaps.get("gateway") or "legacy tier"),
                        pf.period_id)]
    if not _is_open(ctx, pf):
        return [], []
    diff = pf.fact("difference")
    if diff is None:
        return [], [Gap(spec.kind, "the served statement carries no difference: %s"
                        % pf.gaps.get("difference"), pf.period_id)]
    total_assets = pf.fact("total_assets")
    share = None  # type: Optional[float]
    if total_assets is not None:
        share = _ratio_units.safe_ratio(
            _ratio_units.money(abs(diff.value), diff.currency, name="difference"),
            _q(total_assets))
    amount = abs(diff.value)
    materiality, refusal = _materiality(ctx, spec, pf, amount)
    persistence = _persistence(ctx.facts, lambda p: _is_open(ctx, p))
    graded = grade(spec, ctx.pack.severity, materiality=materiality,
                   materiality_refusal=refusal, persistence=persistence)
    evidence = [_money_ev(pf, diff, "unplaced difference on the served balance sheet")]
    if total_assets is not None:
        evidence.append(_money_ev(pf, total_assets, "total assets"))
    if share is not None:
        evidence.append(number_evidence("imbalance_share_pct",
                                        "difference as a share of total assets",
                                        UNIT_PERCENT, share, pf.period_id, pf.snapshot_id))
    evidence.append(number_evidence("auto_reconcile_gate_pct",
                                    "auto-reconcile gate (share of total assets)",
                                    UNIT_PERCENT, ctx.pack.auto_reconcile_gate_share,
                                    pf.period_id, None, source="attention.yaml"))
    evidence.append(text_evidence("served_status", "served status", pf.served_status,
                                  period_id=pf.period_id, snapshot_id=pf.snapshot_id))
    above = share is not None and share > ctx.pack.auto_reconcile_gate_share
    tokens = {"status": pf.served_status}
    reason = _render(spec.reason_template, tokens)
    if not above:
        reason = ("Balance sheet does not close (%s); the difference sits inside the "
                  "auto-reconcile gate but the period was not reconciled%s"
                  % (pf.served_status, " and needs review" if pf.needs_review else ""))
    return [_item(ctx, spec, reason, _render(spec.action_template, tokens), evidence,
                  scope_key="period:%s" % pf.period_id, period_id=pf.period_id,
                  due_at=None, graded=graded, materiality=materiality,
                  refusal=refusal, persistence=persistence)], []


# ── CRITICAL_FINDING ─────────────────────────────────────────────────────


def _step_text(step: Dict[str, Any]) -> str:
    imperative = str(step.get("imperative") or "").rstrip(". ")
    artefact = str(step.get("artefact") or "").rstrip(". ")
    provider = str(step.get("provider") or "")
    horizon = step.get("horizon")
    text = "%s — %s, from %s" % (imperative, artefact, provider)
    if horizon:
        text += " (%s)" % horizon
    return text + "."


def detect_critical_finding(ctx: Ctx) -> Outcome:
    spec = ctx.spec(KIND_CRITICAL_FINDING)
    pf = ctx.latest()
    if pf is None:
        return [], [Gap(spec.kind, "no period with a trial balance is attached")]
    if pf.findings_gap:
        return [], [Gap(spec.kind, "findings not computed: %s" % pf.findings_gap,
                        pf.period_id)]
    if not pf.critical_findings:
        return [], []
    top = pf.critical_findings[0]
    elements = top.get("contract_elements") or {}
    evidence_el = elements.get("evidence") or {}
    prov = evidence_el.get("provenance") or {}
    line_refs = ",".join(prov.get("line_refs") or ()) or None
    fact_units = top.get("fact_units") or {}
    evidence = []  # type: List[EvidenceFact]
    for name, value in sorted((top.get("facts_cited") or {}).items()):
        unit = fact_units.get(name) or _ratio_units.unit_for_fact(name)
        if unit == _ratio_units.UNIT_UNKNOWN or not isinstance(value, (int, float)) \
                or isinstance(value, bool):
            continue
        if unit == _ratio_units.UNIT_MONEY:
            evidence.append(money_evidence(name, name.replace("_", " "), float(value),
                                           str(top.get("source_currency") or pf.currency),
                                           pf.period_id, pf.snapshot_id, line_refs))
        else:
            evidence.append(number_evidence(name, name.replace("_", " "), unit,
                                            float(value), pf.period_id, pf.snapshot_id))
    evidence.append(text_evidence("rule_key", "finding rule", str(top.get("rule_key") or ""),
                                  period_id=pf.period_id, snapshot_id=pf.snapshot_id,
                                  source="findings.single_period"))
    evidence.append(number_evidence("other_critical_count",
                                    "further critical findings on this period",
                                    UNIT_COUNT, float(len(pf.critical_findings) - 1),
                                    pf.period_id, pf.snapshot_id,
                                    source="findings.single_period"))
    steps = ((elements.get("action") or {}).get("steps") or [])
    action = _step_text(steps[0]) if steps else str(top.get("body") or "")
    graded = grade(spec, ctx.pack.severity)
    tokens = {"headline": str(top.get("title") or top.get("rule_key") or ""),
              "action": action}
    return [_item(ctx, spec, _render(spec.reason_template, tokens),
                  _render(spec.action_template, tokens), evidence,
                  scope_key="rule:%s" % top.get("rule_key"), period_id=pf.period_id,
                  due_at=None, graded=graded, materiality=None, refusal=None,
                  persistence=1)], []


# ── COVENANT_RISK ────────────────────────────────────────────────────────


def detect_covenant_risk(ctx: Ctx) -> Outcome:
    spec = ctx.spec(KIND_COVENANT_RISK)
    if not ctx.client.covenants:
        return [], []  # declared model, nothing declared for this client
    pf = ctx.latest()
    if pf is None:
        return [], [Gap(spec.kind, "covenants are declared but no period with a "
                                   "trial balance is attached")]
    metrics = dict((spec.extra.get("covenant_metrics") or {}))
    items = []  # type: List[AttentionItem]
    gaps = []  # type: List[Gap]
    for cov in sorted(ctx.client.covenants, key=lambda c: c.covenant_id):
        mspec = metrics.get(cov.metric)
        if not isinstance(mspec, dict):
            gaps.append(Gap(spec.kind, "covenant %s names metric %r, which the pack "
                            "does not declare" % (cov.covenant_id, cov.metric)))
            continue
        observed = pf.fact(str(mspec.get("accessor") or cov.metric))
        if observed is None:
            gaps.append(Gap(spec.kind, "covenant %s: the served statement carries no "
                            "%s (%s)" % (cov.covenant_id, cov.metric,
                                         pf.gaps.get(cov.metric, "absent")),
                            pf.period_id))
            continue
        if cov.comparator in _COMPARATORS_HIGHER_IS_SAFE:
            headroom = observed.value - float(cov.limit)
        elif cov.comparator in _COMPARATORS_LOWER_IS_SAFE:
            headroom = float(cov.limit) - observed.value
        else:
            gaps.append(Gap(spec.kind, "covenant %s has comparator %r"
                            % (cov.covenant_id, cov.comparator)))
            continue
        share = _ratio_units.safe_ratio(
            _ratio_units.money(headroom, observed.currency, name="headroom"),
            _ratio_units.money(abs(float(cov.limit)), observed.currency, name="limit"))
        if share is None:
            gaps.append(Gap(spec.kind, "covenant %s has a zero limit, so headroom "
                            "has no denominator" % cov.covenant_id))
            continue
        if share >= float(cov.headroom_warn_share):
            continue
        breach = headroom < 0
        materiality, refusal = _materiality(ctx, spec, pf, abs(headroom))
        due = _as_date(cov.test_date) if cov.test_date else None
        days = (due - ctx.as_of).days if due else None
        graded = grade(spec, ctx.pack.severity, materiality=materiality,
                       materiality_refusal=refusal, days_to_due=days,
                       extra_steps=({"breach": 1} if breach else None))
        evidence = [
            _money_ev(pf, observed, "%s as served" % cov.metric.replace("_", " ")),
            EvidenceFact(fact="covenant_limit", label="covenant limit on %s"
                         % cov.metric.replace("_", " "),
                         unit=cov.unit, value=float(cov.limit),
                         currency=observed.currency,
                         provenance={"period_id": pf.period_id, "snapshot_id": None,
                                     "line_id": None,
                                     "source": "covenant:%s" % (cov.source or cov.covenant_id)}),
            number_evidence("covenant_headroom_pct", "headroom as a share of the limit",
                            UNIT_PERCENT, share, pf.period_id, pf.snapshot_id),
        ]
        tokens = {"label": cov.label, "metric": cov.metric.replace("_", " "),
                  "headroom_pct": ("%.1f%% %s" % (abs(share) * 100.0,
                                                  "below" if breach else "above")),
                  "comparator": cov.comparator, "limit_label": "covenant"}
        items.append(_item(ctx, spec, _render(spec.reason_template, tokens),
                           _render(spec.action_template, tokens), evidence,
                           scope_key="covenant:%s" % cov.covenant_id,
                           period_id=pf.period_id, due_at=due, graded=graded,
                           materiality=materiality, refusal=refusal, persistence=1))
    return items, gaps


# ── CASH_RUNWAY ──────────────────────────────────────────────────────────


def _runway_days(pf: PeriodFacts) -> Optional[float]:
    cash = pf.fact("cash")
    expenses = pf.fact("expenses")
    if cash is None or expenses is None or not pf.period_days:
        return None
    daily = expenses.value / float(pf.period_days)   # money per day; not a ratio
    if daily <= 0:
        return None
    return _ratio_units.safe_ratio(
        _q(cash), _ratio_units.money(daily, expenses.currency, name="daily_expenses"))


def detect_cash_runway(ctx: Ctx) -> Outcome:
    spec = ctx.spec(KIND_CASH_RUNWAY)
    pf = ctx.latest()
    if pf is None:
        return [], [Gap(spec.kind, "no period with a trial balance is attached")]
    cash = pf.fact("cash")
    expenses = pf.fact("expenses")
    if cash is None:
        return [], [Gap(spec.kind, "no cash figure: %s" % pf.gaps.get("cash"), pf.period_id)]
    if expenses is None:
        return [], [Gap(spec.kind, "no expenses figure: %s" % pf.gaps.get("expenses"),
                        pf.period_id)]
    if not pf.period_days:
        return [], [Gap(spec.kind, "the period does not declare its length, so a "
                                   "daily cost cannot be formed", pf.period_id)]
    runway = _runway_days(pf)
    if runway is None:
        return [], [Gap(spec.kind, "expenses are not positive, so days of cover are "
                                   "undefined", pf.period_id)]
    profile_id = pf.profile.structure.id if pf.profile is not None else None
    thr = ctx.pack.threshold(spec.kind, "runway_days_min", profile_id)
    if runway >= thr.value:
        return [], []
    daily = expenses.value / float(pf.period_days)
    shortfall = daily * thr.value - cash.value
    materiality, refusal = _materiality(ctx, spec, pf, shortfall)

    def _below(p: PeriodFacts) -> bool:
        r = _runway_days(p)
        pid = p.profile.structure.id if p.profile is not None else None
        return r is not None and r < ctx.pack.threshold(spec.kind, "runway_days_min", pid).value

    persistence = _persistence(ctx.facts, _below)
    graded = grade(spec, ctx.pack.severity, materiality=materiality,
                   materiality_refusal=refusal, persistence=persistence)
    evidence = [
        _money_ev(pf, cash, "cash and bank balances"),
        _money_ev(pf, expenses, "total expenses for the period"),
        number_evidence("cash_runway_days", "days of expenses the cash covers",
                        UNIT_DAYS, runway, pf.period_id, pf.snapshot_id),
        number_evidence("runway_floor_days", thr.label, UNIT_DAYS, thr.value,
                        pf.period_id, None, source=thr.source),
        number_evidence("period_length_days", "period length", UNIT_DAYS,
                        float(pf.period_days), pf.period_id, pf.snapshot_id),
    ]
    profile_label = (pf.profile.profile_label if pf.profile is not None
                     else "company of unclassified profile")
    tokens = {"runway_days": int(round(runway)), "runway_days_min": int(round(thr.value)),
              "profile_label": profile_label}
    reason = _render(spec.reason_template, tokens)
    if pf.profile is None:
        reason += " (profile not classified: %s)" % (pf.profile_gap or "no statements")
    return [_item(ctx, spec, reason, _render(spec.action_template, tokens), evidence,
                  scope_key="period:%s" % pf.period_id, period_id=pf.period_id,
                  due_at=None, graded=graded, materiality=materiality, refusal=refusal,
                  persistence=persistence)], []


# ── NEGATIVE_EQUITY ──────────────────────────────────────────────────────


def _equity_cover(pf: PeriodFacts) -> Optional[float]:
    equity = pf.fact("equity")
    capital = pf.fact("share_capital")
    if equity is None or capital is None or capital.value <= 0:
        return None
    return _ratio_units.safe_ratio(_q(equity), _q(capital))


def detect_negative_equity(ctx: Ctx) -> Outcome:
    spec = ctx.spec(KIND_NEGATIVE_EQUITY)
    pf = ctx.latest()
    if pf is None:
        return [], [Gap(spec.kind, "no period with a trial balance is attached")]
    equity = pf.fact("equity")
    capital = pf.fact("share_capital")
    if equity is None:
        return [], [Gap(spec.kind, "no equity total: %s" % pf.gaps.get("equity"), pf.period_id)]
    if capital is None:
        return [], [Gap(spec.kind, "no registered share capital row: %s"
                        % pf.gaps.get("share_capital"), pf.period_id)]
    if capital.value <= 0:
        return [], [Gap(spec.kind, "registered share capital is not positive, so the "
                                   "statutory floor has no base", pf.period_id)]
    statute = dict(spec.extra.get("statute") or {})
    floor_share = float(statute.get("floor_share_of_capital") or 0.5)
    cover = _equity_cover(pf)
    if cover is None or cover >= floor_share:
        return [], []
    deficit = capital.value * floor_share - equity.value
    materiality, refusal = _materiality(ctx, spec, pf, deficit)
    persistence = _persistence(ctx.facts, lambda p: (_equity_cover(p) is not None
                                                     and _equity_cover(p) < floor_share))
    extra = None if equity.value < 0 else {"positive_net_assets": -1}
    graded = grade(spec, ctx.pack.severity, materiality=materiality,
                   materiality_refusal=refusal, persistence=persistence,
                   extra_steps=extra)
    evidence = [
        _money_ev(pf, equity, "net assets (total equity)"),
        _money_ev(pf, capital, "registered share capital"),
        number_evidence("equity_to_capital_ratio", "net assets as a cover of "
                        "registered capital", UNIT_RATIO, cover, pf.period_id,
                        pf.snapshot_id),
        number_evidence("statutory_floor_share", "statutory floor (share of capital)",
                        UNIT_PERCENT, floor_share, pf.period_id, None,
                        source=spec.source + ".statute"),
    ]
    tokens = {"equity_to_capital_ratio": "%.2f×" % cover,
              "citation": str(statute.get("citation") or ""),
              "duty": str(statute.get("duty") or ""),
              "deadline": str(statute.get("deadline") or "")}
    return [_item(ctx, spec, _render(spec.reason_template, tokens),
                  _render(spec.action_template, tokens), evidence,
                  scope_key="period:%s" % pf.period_id, period_id=pf.period_id,
                  due_at=None, graded=graded, materiality=materiality, refusal=refusal,
                  persistence=persistence)], []


# ── DEADLINE ─────────────────────────────────────────────────────────────


def detect_deadline(ctx: Ctx) -> Outcome:
    spec = ctx.spec(KIND_DEADLINE)
    if ctx.calendar is None:
        return [], [Gap(spec.kind, "no fiscal calendar is declared for jurisdiction %r "
                                   "(packs/firm/calendar_<jurisdiction>.yaml)"
                        % ctx.client.jurisdiction)]
    items = []  # type: List[AttentionItem]
    for dl in ctx.calendar.deadlines_in_window(ctx.as_of, ctx.pack.deadline_window_days,
                                               roles=(ROLE_FILING,)):
        days = (dl.due_at - ctx.as_of).days
        graded = grade(spec, ctx.pack.severity, days_to_due=days)
        evidence = [
            text_evidence("due_at", "due date", dl.due_at.isoformat(), unit=UNIT_DATE,
                          source=ctx.calendar.origin),
            number_evidence("days_to_due_days", "days to the deadline", UNIT_DAYS,
                            float(days), None, None, source=ctx.calendar.origin),
            text_evidence("legal_basis", "legal basis", dl.basis, source=ctx.calendar.origin),
        ]
        if dl.period_end:
            evidence.append(text_evidence("period_end", "period the filing covers",
                                          dl.period_end.isoformat(), unit=UNIT_DATE,
                                          source=ctx.calendar.origin))
        tokens = {"label": dl.label, "due_at": dl.due_at.isoformat()}
        items.append(_item(ctx, spec, _render(spec.reason_template, tokens),
                           _render(spec.action_template, tokens), evidence,
                           scope_key="deadline:%s:%s" % (dl.rule_id, dl.due_at.isoformat()),
                           period_id=None, due_at=dl.due_at, graded=graded,
                           materiality=None, refusal=None, persistence=1))
    return items, []


# ── Registry + coverage ──────────────────────────────────────────────────

DETECTORS = {
    KIND_MISSING_FILE: detect_missing_file,
    KIND_STALE_PERIOD: detect_stale_period,
    KIND_PERIOD_MISMATCH: detect_period_mismatch,
    KIND_IMBALANCED: detect_imbalanced,
    KIND_CRITICAL_FINDING: detect_critical_finding,
    KIND_COVENANT_RISK: detect_covenant_risk,
    KIND_CASH_RUNWAY: detect_cash_runway,
    KIND_NEGATIVE_EQUITY: detect_negative_equity,
    KIND_DEADLINE: detect_deadline,
}  # type: Dict[str, DetectorFn]


def assert_full_coverage(pack: AttentionPack) -> None:
    """Every ENABLED kind has a detector; every detector names a declared
    kind; NO detector exists for a disabled kind (a disabled kind must be
    gracefully absent, never a stub that could emit)."""
    enabled = set(pack.enabled_kind_ids())
    declared = set(pack.kind_ids())
    implemented = set(DETECTORS)
    missing = sorted(enabled - implemented)
    unknown = sorted(implemented - declared)
    stubs = sorted(implemented & (declared - enabled))
    if missing or unknown or stubs:
        raise KindCoverageError(
            "attention kind coverage mismatch against %s — enabled but not "
            "implemented: %r; implemented but not declared: %r; implemented for a "
            "DISABLED kind (a stub that could emit): %r"
            % (pack.origin, missing, unknown, stubs))


# ── The report ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class FirmAttentionReport:
    as_of: date
    rows: Tuple[ClientRow, ...]
    suppressed: Tuple[AttentionItem, ...]
    suppression_audit: Tuple[Dict[str, Any], ...]
    absent_kinds: Tuple[Dict[str, str], ...]
    pack_payload: Dict[str, Any]
    policy_source: str
    cache_payload: Dict[str, Any]
    covenants_declared: int
    #: ClientRecords dropped because their client_id was already on the
    #: board (C7). Recorded, never silent: a duplicate input is a caller
    #: defect the reader must be able to see.
    duplicate_clients: Tuple[Dict[str, Any], ...] = ()

    def items(self) -> List[AttentionItem]:
        return [i for row in self.rows for i in row.items]

    def counts(self) -> Dict[str, Any]:
        by_severity = {}  # type: Dict[str, int]
        by_kind = {}  # type: Dict[str, int]
        for item in self.items():
            by_severity[item.severity] = by_severity.get(item.severity, 0) + 1
            by_kind[item.kind] = by_kind.get(item.kind, 0) + 1
        return {
            "clients": len(self.rows),
            "clients_with_items": len([r for r in self.rows if r.items]),
            "items": len(self.items()),
            "by_severity": dict(sorted(by_severity.items())),
            "by_kind": dict(sorted(by_kind.items())),
            "suppressed": len(self.suppressed),
            "gaps": sum(len(r.gaps) for r in self.rows),
            "duplicate_clients": len(self.duplicate_clients),
        }

    def to_payload(self) -> Dict[str, Any]:
        absent = list(self.absent_kinds)
        if self.covenants_declared == 0:
            absent.append({"kind": KIND_COVENANT_RISK,
                           "reason": "no covenant is declared for any client; the "
                                     "covenant model is declared in attention.yaml "
                                     "and emits nothing until one is recorded"})
        return {
            "version": ATTENTION_VERSION,
            "as_of": self.as_of.isoformat(),
            "pack": dict(self.pack_payload),
            "materiality_policy": self.policy_source,
            "clients": [r.to_payload() for r in self.rows],
            "suppressed": [i.to_payload() for i in self.suppressed],
            "suppression_audit": list(self.suppression_audit),
            "kinds_absent": absent,
            "counts": self.counts(),
            "cache": dict(self.cache_payload),
            "duplicate_clients": list(self.duplicate_clients),
        }


def _as_date(value: Any) -> Optional[date]:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def dedupe_clients(clients: Sequence[ClientRecord]
                   ) -> Tuple[Tuple[ClientRecord, ...], Tuple[Dict[str, Any], ...]]:
    """ONE CLIENT, ONE ROW starts at the input (C7). The same client_id
    handed as two ClientRecords is a caller defect — and without this
    guard `group_by_client` emitted one row PER RECORD, each carrying the
    items of both. The FIRST record in the caller's order wins; every
    later one is dropped and RECORDED (`duplicate_clients` on the
    payload) with what it carried, so the drop is visible."""
    seen = set()  # type: set
    unique = []  # type: List[ClientRecord]
    dropped = []  # type: List[Dict[str, Any]]
    for position, client in enumerate(clients):
        if client.client_id in seen:
            dropped.append({
                "client_id": client.client_id,
                "client_name": client.client_name,
                "position": position,
                "periods": len(client.periods),
                "covenants": len(client.covenants),
                "disposition": ("dropped: the same client_id was already on the "
                                "board; the first record in input order wins"),
            })
            continue
        seen.add(client.client_id)
        unique.append(client)
    return tuple(unique), tuple(dropped)


def compute_firm_attention(clients: Sequence[ClientRecord], as_of: date,
                           pack: Optional[AttentionPack] = None,
                           cache: Optional[AttentionCache] = None,
                           suppressions: Optional[SuppressionIndex] = None,
                           catalog: Optional["CP.ProfileCatalog"] = None,
                           policy: Optional["R.MaterialityPolicy"] = None,
                           cadence_pack: Optional["CAD.CadencePack"] = None,
                           calendar_base: Any = None,
                           run_findings: bool = True) -> FirmAttentionReport:
    """The board. ``as_of`` is the ONLY time input; nothing here reads a
    clock. ``cache`` is the incremental seam — pass the same instance
    across calls and only clients whose snapshot key changed are
    recomputed."""
    if not isinstance(as_of, date):
        raise TypeError("as_of must be a datetime.date, got %r" % type(as_of).__name__)
    cat = catalog or CP.load_catalog()
    pk = pack or load_attention_pack(catalog=cat, policy=policy)
    assert_full_coverage(pk)
    pol = policy or R.MaterialityPolicy.from_pack()
    store = cache if cache is not None else AttentionCache()
    index = suppressions or SuppressionIndex(())
    try:
        cad_pack = cadence_pack or CAD.load_cadence_pack()
    except Exception as exc:  # noqa: BLE001 — a missing cadence pack is a gap on every client
        logger.exception("[firm] cadence pack failed to load")
        cad_pack = None
        cad_pack_error = "%s: %s" % (type(exc).__name__, exc)
    else:
        cad_pack_error = None
    calendars = {}  # type: Dict[str, Optional[FiscalCalendar]]
    kind_order = dict((k, pk.kind(k).order) for k in pk.kind_ids())

    all_items = []  # type: List[AttentionItem]
    gaps_by_client = {}  # type: Dict[str, List[Gap]]
    covenants_declared = 0
    unique_clients, duplicate_clients = dedupe_clients(clients)
    for client in sorted(unique_clients, key=lambda c: c.client_id):
        covenants_declared += len(client.covenants)
        key = snapshot_key(client, pk.fingerprint())
        facts = store.get_or_build(
            client, key,
            lambda c=client: build_client_facts(c, pk.cash_row_ids, pk.fingerprint(),
                                                catalog=cat, run_findings=run_findings))
        jur = str(client.jurisdiction or "")
        if jur not in calendars:
            calendars[jur] = load_calendar(jur, calendar_base) if jur else None
        client_cadence = None  # type: Optional[CAD.ClientCadence]
        status = None  # type: Optional[CAD.CadenceStatus]
        cadence_gap = cad_pack_error
        if cad_pack is not None:
            try:
                client_cadence = CAD.resolve_client_cadence(
                    client.client_id, client.cadence_row, cad_pack)
                filed = [p.period_end for p in client.periods_desc() if p.has_trial_balance()]
                status = CAD.assess(client_cadence, filed, as_of, pack=cad_pack)
            except (CAD.CadenceInputError, CAD.CadencePackError) as exc:
                cadence_gap = "%s: %s" % (type(exc).__name__, exc)
                status = None
        ctx = Ctx(client=client, facts=facts, as_of=as_of, pack=pk, policy=pol,
                  calendar=calendars[jur], client_cadence=client_cadence,
                  cadence_status=status, cadence_gap=cadence_gap)
        gaps = []  # type: List[Gap]
        for kind in pk.enabled_kind_ids():
            try:
                items, kind_gaps = DETECTORS[kind](ctx)
            except Exception as exc:  # noqa: BLE001 — one kind must not take the board down
                logger.exception("[firm] detector %s raised for client %s", kind,
                                 client.client_id)
                gaps.append(Gap(kind, "the detector raised and produced nothing: %s: %s"
                                % (type(exc).__name__, exc)))
                continue
            all_items.extend(items)
            gaps.extend(kind_gaps)
        gaps_by_client[client.client_id] = gaps

    kept, suppressed, audit = apply_suppressions(all_items, index)
    rows = group_by_client(unique_clients, kept, gaps_by_client, suppressed, kind_order)
    return FirmAttentionReport(
        as_of=as_of, rows=rows, suppressed=suppressed,
        suppression_audit=tuple(audit), absent_kinds=tuple(pk.absent_kinds()),
        pack_payload=pk.to_payload(), policy_source=pol.source,
        cache_payload=store.to_payload(), covenants_declared=covenants_declared,
        duplicate_clients=duplicate_clients)


__all__ = [
    "ATTENTION_VERSION", "Ctx", "DETECTORS", "FirmAttentionReport",
    "KindCoverageError", "KIND_CASH_RUNWAY", "KIND_COVENANT_RISK",
    "KIND_CRITICAL_FINDING", "KIND_DEADLINE", "KIND_IMBALANCED",
    "KIND_MISSING_FILE", "KIND_NEGATIVE_EQUITY", "KIND_PERIOD_MISMATCH",
    "KIND_STALE_PERIOD", "assert_full_coverage", "compute_firm_attention",
    "dedupe_clients",
]
