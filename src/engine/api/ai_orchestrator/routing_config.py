"""Default routing rules: task_type → (primary, verifier).

This is the central source of truth for which model handles what. Tune
it based on telemetry — see the per-task agreement rate dashboard.
Rules of thumb:
  · If a task's agreement rate stays >95% for 30 days, drop the verifier.
  · If the verifier wins disagreements >50% of the time, swap them.
  · If a task type isn't on this list, the router falls back to
    Claude-only with no verifier (safe default — same behavior as the
    pre-orchestrator code).

The verifier path roughly DOUBLES the cost per call. Reserve it for
HIGH-STAKES tasks where an error would propagate through the report
(extraction of revenue/EBITDA/totals, account-COA mapping for the
core CFO ratios). For cheap-and-frequent tasks (SKU classification,
quick translations), single-pass is fine.
"""

from __future__ import annotations

from .types import RoutingConfig, RoutingRule, TaskType


ROUTING_CONFIG = RoutingConfig(rules={
    # — Extraction (HIGH STAKES — errors cascade through entire analysis) —
    TaskType.EXTRACT_TRIAL_BALANCE: RoutingRule(
        primary="claude",
        verify="gpt",
        rationale="Trial balance is the foundation; revenue/EBITDA/equity all derive from it. Cross-check.",
    ),
    TaskType.EXTRACT_BALANCE_SHEET: RoutingRule(
        primary="claude",
        verify="gpt",
        rationale="BS totals feed Altman Z, leverage ratios, NAV. Cross-check.",
    ),
    TaskType.EXTRACT_PNL: RoutingRule(
        primary="claude",
        verify="gpt",
        rationale="P&L feeds EBITDA, margins, valuation multiples. Cross-check.",
    ),
    TaskType.EXTRACT_SKU_LIST: RoutingRule(
        primary="claude",
        verify=None,
        rationale="Volume task (hundreds-thousands of rows). Single pass; row-level errors are caught by reconciliation against COGS.",
    ),

    # — Classification (low per-call cost; high volume) —
    TaskType.CLASSIFY_ACCOUNT_TO_COA: RoutingRule(
        primary="claude",
        verify=None,
        rationale="Reasoning + recall; Claude's long context handles full COA reference. Errors caught by trial-balance reconciliation downstream.",
    ),
    TaskType.CLASSIFY_SKU_CATEGORY: RoutingRule(
        primary="claude",
        verify=None,
        rationale="Fuzzy matching; low per-row stakes; volume task.",
    ),

    # — Detection (format / language / industry) —
    TaskType.DETECT_COA: RoutingRule(
        primary="claude",
        verify=None,
        rationale="Existing _detect.py pattern; single-pass with heuristic prefilter. Result is already cached by OCR hash.",
    ),
    TaskType.DETECT_INDUSTRY: RoutingRule(
        primary="claude",
        verify=None,
        rationale="Operator-confirmed in UI before analysis runs; no cross-check needed.",
    ),

    # — Numeric reasoning —
    TaskType.REASON_FINANCIAL_RATIOS: RoutingRule(
        primary="gpt",
        verify="claude",
        rationale="GPT's slight edge on arithmetic chains; Claude verifies the conclusion.",
    ),
    TaskType.REASON_BENCHMARK_COMPARE: RoutingRule(
        primary="claude",
        verify="gpt",
        rationale="Mixed numeric + qualitative; both models contribute.",
    ),

    # — Translation —
    TaskType.TRANSLATE_FINANCIAL_TERM: RoutingRule(
        primary="gpt",
        verify=None,
        rationale="GPT generally stronger on multilingual financial idioms; single pass acceptable.",
    ),

    # — Generation —
    TaskType.GENERATE_CFO_COMMENTARY: RoutingRule(
        primary="claude",
        verify="gpt",
        rationale="Claude's prose quality on analytical content; GPT verifies factual claims against source data.",
    ),
    TaskType.GENERATE_REPORT_SECTION: RoutingRule(
        primary="claude",
        verify=None,
        rationale="Prose quality; single pass acceptable for narrative sections.",
    ),
    TaskType.ASK_CFO_AI_CHAT: RoutingRule(
        primary="claude",
        verify=None,
        rationale="Conversational; latency matters; single pass.",
    ),
})
