"""AI lane stage 2 — account-row extraction (strict JSON, one retry).

Every account row of the document becomes {code, label, debit, credit,
balance} in the ORIGINAL currency/scale — the lane NEVER rescales,
rounds, nets or repairs figures. The document's own totals row (when
stage 1 found one) is extracted verbatim as file values for the
self-check anchor; it is never recomputed from the rows.

Failure semantics (task contract): malformed JSON → ONE retry carrying
the parse error; a second failure raises AiLaneError → documents.status
'failed' with a clear error. Never partial numbers.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from . import config
from ._client import call_strict_json
from .schemas import ExtractedRow, ExtractResult, FormatDetectResult

_SYSTEM = (
    "You are a meticulous accounting-data extractor. You are given the "
    "raw text of a trial balance / ledger export plus its detected "
    "layout. Extract EVERY account row — do not skip small balances, do "
    "not aggregate, do not invent rows. Keep every figure exactly as the "
    "document states it, in the document's own currency and scale.\n\n"
    "Respond with ONLY a strict JSON object — no prose, no markdown "
    "fences — with exactly these keys:\n"
    "{\n"
    '  "rows": [{"code": <account code as string>,\n'
    '            "label": <account name as written>,\n'
    '            "debit": <closing debit balance as a number, or null>,\n'
    '            "credit": <closing credit balance as a number, or null>,\n'
    '            "balance": <single signed balance when the layout has one '
    "column (debit-positive), else null>}, ...],\n"
    '  "totals_row": {"debit": <the document\'s own grand-total debit>, '
    '"credit": <grand-total credit>} or null when the file has no totals row\n'
    "}\n"
    "Rules:\n"
    "- Parse numbers per the detected separators (e.g. '1 234 567,89' with "
    "space thousands + comma decimal is 1234567.89). Emit plain JSON "
    "numbers.\n"
    "- The totals_row values are the FILE's own printed totals — copy "
    "them, never compute them.\n"
    "- Exclude the totals row itself and header rows from `rows`.\n"
    "- When a document is a closing trial balance, use the CLOSING "
    "balance columns."
)


def run_extract(
    doc_text: str,
    fmt: FormatDetectResult,
    *,
    jurisdiction: str,
    filename: str = "",
    client: Any = None,
    client_factory: Optional[Callable[[], Any]] = None,
    audit_stages: Optional[List[Dict[str, Any]]] = None,
) -> ExtractResult:
    if client is None:
        client = (client_factory or config.default_client_factory)()
    layout_note = (
        "Detected layout: columns=%s header_row=%s totals_row_index=%s "
        "currency=%s scale=%s thousands_sep=%r decimal_sep=%r language=%s"
        % (
            fmt.columns, fmt.header_row, fmt.totals_row_index, fmt.currency,
            fmt.scale, fmt.thousands_sep, fmt.decimal_sep, fmt.language,
        )
    )
    user_text = (
        "Jurisdiction: %s. Filename: %s.\n%s\n\nDocument text follows.\n\n%s"
        % (jurisdiction, filename or "unknown", layout_note, doc_text)
    )
    data = call_strict_json(
        client,
        stage="extract",
        prompt_version=config.EXTRACT_PROMPT_VERSION,
        system=_SYSTEM,
        user_text=user_text,
        max_tokens=config.EXTRACT_MAX_TOKENS,
        audit_stages=audit_stages,
    )

    def _num(v: Any) -> Optional[float]:
        if v is None:
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    rows: List[ExtractedRow] = []
    for raw in data.get("rows") or []:
        if not isinstance(raw, dict):
            continue
        code = str(raw.get("code") or "").strip()
        if not code:
            continue
        rows.append(ExtractedRow(
            code=code,
            label=str(raw.get("label") or "").strip(),
            debit=_num(raw.get("debit")),
            credit=_num(raw.get("credit")),
            balance=_num(raw.get("balance")),
        ))
    totals = data.get("totals_row") if isinstance(data.get("totals_row"), dict) else None
    return ExtractResult(
        rows=rows,
        totals_debit=_num(totals.get("debit")) if totals else None,
        totals_credit=_num(totals.get("credit")) if totals else None,
        raw=data,
    )
