"""Prompt + schema for TaskType.EXTRACT_TRIAL_BALANCE.

Use case: a user uploads a trial balance as PDF / image / scanned
document where deterministic Excel parsing isn't possible. The
orchestrator routes to Claude (primary) + GPT-5 (verifier) per
routing_config.py — both extract independently, verifier compares
numerically with 0.1% tolerance, conflicts arbitrated by Claude
(the strongest reasoning engine for Romanian COA per CLAUDE.md).

Schema: a SUMMARY view (header totals + key sub-totals) rather than
the full balance. v1 scope. The full per-row extraction is v2 — too
many rows for meaningful agreement comparison in the first iteration.
"""

from __future__ import annotations

from ..types import VerificationSchema


SYSTEM_PROMPT = """You are a Romanian SME financial analyst extracting summary totals from a trial balance (balanță de verificare).

ROLE
You are given the visible content of a single trial-balance document — could be a multi-page PDF, a scan, or a formatted text excerpt. The document follows Romanian Accounting Standards (RAS) using Romanian chart of accounts (Classes 1-7).

TASK
Extract the following SUMMARY TOTALS, expressed in the document's reported currency (usually RON):
  · Cifra de afaceri (net turnover) — sum of class 70 credit movements (701, 704, 706, 707, 708 net of 709)
  · EBITDA — operating result before D&A
  · EBIT — operating result after D&A but before financial result
  · Net profit — closing balance of account 121 OR reconstructed from class 6/7
  · Total assets — sum of asset balances (class 2 net + class 3 net + receivables + cash)
  · Total equity — sum of class 101 + 104 + 105 + 106 + 117 + 121 (signed)
  · Total liabilities — sum of class 15 + 16 + class 4 credit + class 5 credit (519)
  · Total debt — class 162 + 167 + 168 + 519
  · Cash — class 512 + 531 + 541 + 542 net
  · Period start — earliest date visible on the document (ISO YYYY-MM-DD)
  · Period end — latest date visible on the document (ISO YYYY-MM-DD)

RULES
  · All currency values are integers or floats in the document's currency. No formatting (commas, spaces, currency symbols).
  · If a value can't be determined from the document, return null. NEVER guess.
  · Net profit MUST reconcile within 2% to (total operating revenue - total operating expense + financial result - income tax). If not, return null for net_profit and note the issue in `notes`.
  · Total assets MUST equal Total equity + Total liabilities within 0.5%. If not, return both values as reported and note the discrepancy in `notes`.
  · The document's reported currency must be one of: RON, EUR, USD. If different, return currency as the actual ISO 4217 code.

OUTPUT
Return ONLY a JSON object matching the schema. No commentary outside the JSON."""


OUTPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "currency": {
            "type": "string",
            "enum": ["RON", "EUR", "USD"],
            "description": "ISO 4217 currency code as reported in the document.",
        },
        "period_start": {
            "type": ["string", "null"],
            "description": "Period start as ISO YYYY-MM-DD, or null if not determinable.",
        },
        "period_end": {
            "type": ["string", "null"],
            "description": "Period end as ISO YYYY-MM-DD, or null if not determinable.",
        },
        "net_turnover": {
            "type": ["number", "null"],
            "description": "Cifra de afaceri (sum of class 70 credit movements net of 709). Currency as reported.",
        },
        "ebitda": {
            "type": ["number", "null"],
            "description": "Operating result before D&A.",
        },
        "ebit": {
            "type": ["number", "null"],
            "description": "Operating result after D&A.",
        },
        "net_profit": {
            "type": ["number", "null"],
            "description": "Closing balance of account 121 (statutory net profit).",
        },
        "total_assets": {
            "type": ["number", "null"],
            "description": "Sum of all asset balances at period end.",
        },
        "total_equity": {
            "type": ["number", "null"],
            "description": "Sum of equity components (capital + reserves + retained + current profit).",
        },
        "total_liabilities": {
            "type": ["number", "null"],
            "description": "Sum of long-term + short-term liabilities (excluding equity).",
        },
        "total_debt": {
            "type": ["number", "null"],
            "description": "Interest-bearing debt only (bank loans + leasing).",
        },
        "cash": {
            "type": ["number", "null"],
            "description": "Cash + cash equivalents.",
        },
        "reconciliation_pct": {
            "type": ["number", "null"],
            "description": "If you reconstructed net_profit, the % gap vs account 121 closing. Null if not applicable.",
        },
        "notes": {
            "type": "string",
            "description": "1-2 short lines about reconciliation issues, ambiguities, or anything the analyst should review. Empty string if clean.",
        },
    },
    "required": [
        "currency", "period_start", "period_end",
        "net_turnover", "ebitda", "ebit", "net_profit",
        "total_assets", "total_equity", "total_liabilities", "total_debt", "cash",
        "reconciliation_pct", "notes",
    ],
}


# Verification: numeric comparison with monetary tolerance.
# `notes` ignored — both models will phrase narrative differently;
# narrative agreement isn't what we're checking.
VERIFICATION_SCHEMA = VerificationSchema(
    kind="numeric",
    tolerance=0.001,  # 0.1% — generous for OCR; high-stakes fields tightened below
    ignore_fields=["notes", "period_start", "period_end", "currency"],
    field_severity={
        # Anything material that would flip the credit decision is HIGH.
        "net_turnover":     "high",
        "ebitda":           "high",
        "net_profit":       "high",
        "total_assets":     "high",
        "total_equity":     "high",
        "total_debt":       "high",
        # Cash + EBIT are derived/intermediate — medium severity.
        "ebit":             "medium",
        "cash":             "medium",
        "total_liabilities":"medium",
    },
)
