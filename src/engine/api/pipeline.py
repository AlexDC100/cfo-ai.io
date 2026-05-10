"""Phase 3 pipeline orchestrator — turn an uploaded document into a populated
financial period the UI can render.

Endpoints:
  POST /api/pipeline/run     { document_id }   → 202 (async kicked off)
  POST /api/pipeline/retry   { document_id }   → 202 (resets + reruns)
  GET  /api/period/:id                          → consolidated payload

Pipeline stages (each updates documents.status as it starts):
  queued → extracting → mapping → computing → narrating → analyzed | failed

Stages:
  detect   — filename + LLM classifier
  ocr      — Claude Opus 4.7 reads PDF directly (no separate OCR call)
  extract  — Same call returns structured RO accounts
  map      — _ro_coa.assemble_statements() rolls accounts into BS/PL buckets
  assemble — Statements blob + statement_line_items rows
  validate — BS-balance + sanity checks → alerts (data_quality)
  compute  — calculated_metrics rows (revenue, EBITDA, margin, leverage, ratios…)
  narrate  — Opus 4.7 → briefing + recommendations + alerts
  finalize — documents.status = 'analyzed'; documents.period_id set

CRITICAL: every stage is idempotent. retry() wipes prior derivatives before
re-running so the user can re-attempt without ghost data.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import traceback
import uuid
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from . import _supabase
from ._ro_coa import assemble_statements


logger = logging.getLogger(__name__)


# ─── Helpers ────────────────────────────────────────────────────────────────


def _require_jwt(authorization: Optional[str]) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token.")
    return authorization.split(" ", 1)[1].strip()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _verify_user_owns_document(jwt: str, document_id: str) -> Dict[str, Any]:
    """Returns the document row when the JWT-bearing user has read access.
    Raises 403 otherwise.
    """
    with _supabase.per_user(jwt) as client:
        rows = client.select(
            "documents",
            filters={"id": f"eq.{document_id}"},
            single=True,
        )
        if not rows:
            raise HTTPException(404, f"Document {document_id} not found or not visible to you.")
        return rows[0]


def _admin_set_status(doc_id: str, status: str, *, error: Optional[str] = None,
                      duration_ms: Optional[int] = None,
                      period_id: Optional[str] = None,
                      pipeline_started_at: Optional[str] = None) -> None:
    patch: Dict[str, Any] = {"status": status}
    if error is not None:
        patch["error"] = error
    elif status != "failed":
        patch["error"] = None
    if duration_ms is not None:
        patch["duration_ms"] = duration_ms
    if period_id is not None:
        patch["period_id"] = period_id
    if pipeline_started_at is not None:
        patch["pipeline_started_at"] = pipeline_started_at
    with _supabase.admin() as client:
        client.update("documents", patch, filters={"id": f"eq.{doc_id}"})


# ─── Pipeline stages ────────────────────────────────────────────────────────


# ─── Multi-format extraction ────────────────────────────────────────────────
# stage_extract dispatches on file type. The original PDF-only path lives at
# /api/financial-statements/parse and is reused for actual PDFs. For everything
# else (XLSX, CSV, JPG, PNG, plain text) we call Claude directly with the
# appropriate content block shape, using a broader extraction prompt that
# accepts trial balances, balance sheets, P&Ls, invoice registers, sales
# analyses, product catalogs, and bank statements.

_BROAD_SYSTEM_PROMPT = """You are a forensic accountant analyzing a financial business document.

Your job: extract structured financial data from whatever the user uploaded.
The document might be a Romanian trial balance ("balanță de verificare"), a
bilanț (balance sheet), a P&L, an invoice register (e-Factura / SAF-T /
SmartBill / generic CSV), a sales-by-product analysis, a bank statement, or
any other accounting / business document.

CRITICAL RULES — read these before extracting:

1. Output STRICT JSON matching <schema>. No prose, no preamble, no markdown
   fences. The first character of your reply must be '{'.

2. Identify the document type and set `detected_type` accordingly. Acceptable
   values: trial_balance | bilant | pl | annual_report | invoice_register |
   sales_analysis | bank_statement | unknown.

3. If the document IS a trial balance / bilanț / P&L (financial statements):
   extract account rows into the `accounts` array using Romanian OMFP-1802
   account codes. Each account: closing balance (sold final). For accounts
   with separate debit/credit columns, follow standard signing — Class 1, 4
   (passive), 5 (passive), 7 take credit, emit positive; Class 2, 3, 4
   (active), 5 (active cash), 6 take debit, emit positive. If the codes
   aren't shown, map line items to canonical RO codes (5121 cash, 4111 AR,
   371 inventory, 212 PPE, 401 AP, 1621 LT debt, 1012 share capital, 117
   retained earnings, 704/706 revenue, 602 materials, 628 services, 641
   salaries, 681 D&A, 666 interest, 691 tax).

4. If the document IS NOT a financial statement (e.g. invoice register,
   sales analysis, product list): leave `accounts` as an empty array. Do
   NOT invent accounts. Populate `summary` with what the document IS and
   what it contains so downstream tabs can render it. Suggested fields:
       summary.row_count            — number of detail rows
       summary.headline_total       — RON total if obvious
       summary.headline_label       — what the total represents
       summary.top_records          — array of up to 10 string descriptors of
                                      the most material rows (e.g. customer
                                      names, product SKUs, invoice numbers)
       summary.warnings             — anything you couldn't resolve

5. Romanian numbers use ',' or '.' as decimal separator with '.' or space
   thousand grouping. Always emit clean decimal numbers.

6. Confidence rubric (emit a number 0..1):
   0.95 — clear balanță de verificare with all rows mapped
   0.85 — bilanț + P&L extracted to canonical RO codes
   0.70 — invoice register / sales analysis with structured rows captured
   0.60 — scanned/OCR'd image, some rows unclear
   0.40 — heavily inferred from narrative
   <0.40 — only headline figures

<schema>
{
  "company_name": string | null,
  "period_label": string,
  "period_end": string | null,         // ISO yyyy-mm-dd if discoverable
  "currency": string,                  // default "RON"
  "confidence": number,                // 0..1
  "detected_type": string,             // see rule 2
  "accounts": [{ "code": "5121", "name": "...", "amount": 1494836.00 }],
  "summary": {
    "row_count": number | null,
    "headline_total": number | null,
    "headline_label": string | null,
    "top_records": [string],
    "warnings": [string]
  },
  "warnings": [string]
}
</schema>

Begin."""


def _classify_file(doc: Dict[str, Any]) -> str:
    """Returns 'pdf' | 'xlsx' | 'csv' | 'image_jpeg' | 'image_png' | 'text' | 'unknown'."""
    mime = (doc.get("mime_type") or "").lower()
    name = (doc.get("original_filename") or "").lower()
    if mime == "application/pdf" or name.endswith(".pdf"):
        return "pdf"
    if "spreadsheet" in mime or name.endswith(".xlsx") or name.endswith(".xls"):
        return "xlsx"
    if mime == "text/csv" or name.endswith(".csv"):
        return "csv"
    if mime == "image/jpeg" or name.endswith((".jpg", ".jpeg")):
        return "image_jpeg"
    if mime == "image/png" or name.endswith(".png"):
        return "image_png"
    if mime.startswith("text/") or name.endswith(".txt"):
        return "text"
    return "unknown"


def _xlsx_to_text(xlsx_bytes: bytes, *, max_chars: int = 200_000) -> str:
    """Render an XLSX workbook as TSV text Claude can read.
    Each sheet becomes a labeled section: '=== Sheet: <name> ===' followed by
    rows joined with tabs. Truncated at max_chars to stay under context limits.
    """
    import io
    from openpyxl import load_workbook  # type: ignore

    wb = load_workbook(io.BytesIO(xlsx_bytes), data_only=True, read_only=True)
    out: List[str] = []
    total_chars = 0
    for sheet_name in wb.sheetnames:
        if total_chars > max_chars:
            out.append(f"\n[truncated — additional sheets omitted at {max_chars} chars]")
            break
        ws = wb[sheet_name]
        section = [f"=== Sheet: {sheet_name} ==="]
        for row in ws.iter_rows(values_only=True):
            cells = ["" if v is None else str(v).replace("\t", " ") for v in row]
            if not any(c.strip() for c in cells):
                continue
            line = "\t".join(cells)
            if total_chars + len(line) > max_chars:
                section.append("[truncated]")
                break
            section.append(line)
            total_chars += len(line) + 1
        out.append("\n".join(section))
    return "\n\n".join(out)


def stage_extract(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Format-aware extraction. Sends the document to Claude Opus 4.7 in the
    most appropriate content-block shape for its type, then validates the
    JSON response and returns it.

    Supported inputs:
      - PDF      → document content block (handled by the legacy parser)
      - XLSX     → openpyxl-rendered TSV text content block
      - CSV      → raw text content block
      - JPG/PNG  → image content block
      - Plain text → text content block
    Anything else falls back to text after best-effort UTF-8 decoding.
    """
    storage_path: str = doc["storage_path"]
    kind = _classify_file(doc)

    # PDF still uses the existing parser (it has the canonical RO trial-balance
    # rubric in its system prompt — re-using avoids drift between two prompts).
    if kind == "pdf":
        with _supabase.admin() as admin_client:
            signed = admin_client.signed_url("documents", storage_path, expires_in=300)
        from .financial_statements import (  # type: ignore
            ParseRequest,
            build_router as _build_fs_router,
        )
        fs_router = _build_fs_router()
        parse_handler = None
        for route in fs_router.routes:
            if getattr(route, "name", None) == "parse_document":
                parse_handler = route.endpoint  # type: ignore[attr-defined]
                break
        if parse_handler is None:
            raise RuntimeError("financial_statements router missing parse_document route")
        parsed = parse_handler(ParseRequest(
            pdf_url=signed,
            original_filename=doc.get("original_filename"),
        ))
        return parsed.model_dump() if hasattr(parsed, "model_dump") else dict(parsed)

    # Everything else: download bytes, build a Claude message, parse the JSON.
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not configured.")

    with _supabase.admin() as admin_client:
        signed = admin_client.signed_url("documents", storage_path, expires_in=300)
    with httpx.Client(timeout=30.0) as http:
        r = http.get(signed)
        r.raise_for_status()
        file_bytes = r.content

    if len(file_bytes) > 25 * 1024 * 1024:
        raise RuntimeError(f"File too large ({len(file_bytes)/1_000_000:.1f} MB) — 25 MB ceiling.")

    try:
        from anthropic import Anthropic  # type: ignore
    except ImportError:
        raise RuntimeError("anthropic SDK not installed.")
    client = Anthropic(api_key=api_key)

    import base64 as _b64
    user_content: List[Dict[str, Any]]
    user_text = (
        f"Extract this document into the JSON schema. "
        f"Filename: {doc.get('original_filename') or 'unknown'}. "
        "Pick the most appropriate detected_type. Return JSON only."
    )

    if kind in ("image_jpeg", "image_png"):
        media_type = "image/jpeg" if kind == "image_jpeg" else "image/png"
        b64 = _b64.standard_b64encode(file_bytes).decode("ascii")
        user_content = [
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
            {"type": "text", "text": user_text},
        ]
    else:
        # XLSX, CSV, plain text, unknown — coerce to text.
        if kind == "xlsx":
            text_payload = _xlsx_to_text(file_bytes)
            preamble = "Workbook rendered as TSV (sheets separated by '=== Sheet:' markers)."
        elif kind == "csv":
            text_payload = file_bytes.decode("utf-8", errors="replace")
            preamble = "CSV content."
        else:
            text_payload = file_bytes.decode("utf-8", errors="replace")
            preamble = "File content as text (best-effort decode)."

        # Cap the text payload so we don't blow the context window.
        if len(text_payload) > 250_000:
            text_payload = text_payload[:250_000] + "\n[truncated at 250k chars]"

        user_content = [
            {"type": "text", "text": f"{preamble}\n\n{text_payload}"},
            {"type": "text", "text": user_text},
        ]

    try:
        resp = client.messages.create(
            model="claude-opus-4-7",
            max_tokens=8000,
            system=[
                {"type": "text", "text": _BROAD_SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}},
            ],
            messages=[{"role": "user", "content": user_content}],
            output_config={"effort": "high"},
        )
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"Claude extraction failed: {e}")

    text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", None) == "text").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Claude returned invalid JSON. First 200 chars: {text[:200]!r}. Error: {e}")

    # Repair / defaults
    data.setdefault("company_name", None)
    data.setdefault("period_label", "Imported period")
    data.setdefault("period_end", None)
    data.setdefault("currency", "RON")
    data.setdefault("confidence", 0.5)
    data.setdefault("detected_type", "unknown")
    data.setdefault("accounts", [])
    data.setdefault("warnings", [])
    data.setdefault("summary", {})

    # Coerce account amounts
    cleaned: List[Dict[str, Any]] = []
    for raw in data.get("accounts", []):
        try:
            amt = float(raw.get("amount", 0) or 0)
            cleaned.append({
                "code": str(raw.get("code", "")).strip(),
                "name": str(raw.get("name", "")).strip(),
                "amount": amt,
            })
        except (TypeError, ValueError):
            data["warnings"].append(f"Dropped malformed account row: {raw}")
    data["accounts"] = cleaned

    return data


def stage_map(doc: Dict[str, Any], parsed: Dict[str, Any], industry: Optional[str]) -> Dict[str, Any]:
    """Roll accounts into BS/PL buckets via the RO-COA mapper."""
    return assemble_statements(
        parsed.get("accounts") or [],
        company_name=parsed.get("company_name") or "Imported entity",
        currency=parsed.get("currency") or "RON",
        period_label=parsed.get("period_label") or "Imported period",
        industry=industry,
    )


def stage_persist(doc: Dict[str, Any], parsed: Dict[str, Any], assembled: Dict[str, Any]) -> str:
    """Insert financial_periods + statement_line_items, return period_id.
    Idempotent on (org_id, period_end, source_document_id) — re-running for the
    same document upserts.
    """
    period_end_str = parsed.get("period_end")
    if period_end_str:
        try:
            period_end = date.fromisoformat(period_end_str).isoformat()
        except (TypeError, ValueError):
            period_end = date.today().isoformat()
    else:
        period_end = date.today().isoformat()

    period_start = period_end  # we don't have start info — treat as point-in-time

    with _supabase.admin() as admin_client:
        # Upsert the period
        upserted = admin_client.upsert(
            "financial_periods",
            {
                "org_id": doc["org_id"],
                "source_document_id": doc["id"],
                "period_start": period_start,
                "period_end": period_end,
                "currency": parsed.get("currency") or "RON",
                "extraction_confidence": parsed.get("confidence", 0.5),
            },
            on_conflict="org_id,period_end,source_document_id",
            returning=True,
        )
        if upserted:
            period_id = upserted[0]["id"]
        else:
            existing = admin_client.select(
                "financial_periods",
                filters={
                    "org_id": f"eq.{doc['org_id']}",
                    "period_end": f"eq.{period_end}",
                    "source_document_id": f"eq.{doc['id']}",
                },
                single=True,
            )
            if not existing:
                raise RuntimeError("Failed to upsert financial_periods")
            period_id = existing[0]["id"]

        # Wipe + re-insert statement line items for this period
        admin_client.delete("statement_line_items", filters={"period_id": f"eq.{period_id}"})
        line_items = assembled.get("lineItems") or []
        if line_items:
            rows = [
                {"period_id": period_id, **item}
                for item in line_items
            ]
            # PostgREST has a soft 1MB body cap; chunk in 500s.
            for i in range(0, len(rows), 500):
                admin_client.insert("statement_line_items", rows[i:i+500], returning=False)

    return period_id


def stage_compute(doc: Dict[str, Any], assembled: Dict[str, Any], period_id: str) -> List[Dict[str, Any]]:
    """Compute headline metrics + ratios from the assembled statements.
    Persists to calculated_metrics (idempotent: wipe + re-insert).
    """
    s = assembled["statements"]
    bs = s["balanceSheet"]
    pl = s["incomeStatement"]

    revenue = pl["revenue"]
    cogs = pl["costOfGoodsSold"]
    opex = pl["operatingExpenses"]
    depreciation = pl["depreciationAmortization"]
    interest = pl["interestExpense"]
    other_inc = pl["otherIncome"]
    fin_inc = pl["financialIncome"]
    fin_exp = pl["financialExpense"]
    tax = pl["taxExpense"]

    gross_profit = revenue - cogs
    operating_profit = gross_profit - opex - depreciation + other_inc
    ebitda = operating_profit + depreciation
    pretax = operating_profit + fin_inc - fin_exp - interest
    net_income = pretax - tax

    current_assets = bs["cash"] + bs["accountsReceivable"] + bs["inventory"] + bs["otherCurrentAssets"]
    non_current_assets = bs["propertyPlantEquipment"] + bs["intangibles"] + bs["otherNonCurrentAssets"]
    total_assets = current_assets + non_current_assets

    current_liab = bs["accountsPayable"] + bs["shortTermDebt"] + bs["otherCurrentLiabilities"]
    non_current_liab = bs["longTermDebt"] + bs["otherNonCurrentLiabilities"]
    total_debt = bs["shortTermDebt"] + bs["longTermDebt"]
    total_equity = bs["shareCapital"] + bs["retainedEarnings"] + bs["otherEquity"]

    def safe(num: float, denom: float) -> Optional[float]:
        return None if denom == 0 else round(num / denom, 4)

    metrics: List[Dict[str, Any]] = [
        {"name": "revenue",            "value": round(revenue, 2),         "unit": "RON",   "direction": "higher"},
        {"name": "gross_profit",       "value": round(gross_profit, 2),    "unit": "RON",   "direction": "higher"},
        {"name": "ebitda",             "value": round(ebitda, 2),          "unit": "RON",   "direction": "higher"},
        {"name": "operating_profit",   "value": round(operating_profit, 2),"unit": "RON",   "direction": "higher"},
        {"name": "net_income",         "value": round(net_income, 2),      "unit": "RON",   "direction": "higher"},
        {"name": "gross_margin",       "value": safe(gross_profit, revenue),"unit": "ratio","direction": "higher"},
        {"name": "ebitda_margin",      "value": safe(ebitda, revenue),     "unit": "ratio", "direction": "higher"},
        {"name": "net_margin",         "value": safe(net_income, revenue), "unit": "ratio", "direction": "higher"},
        {"name": "total_assets",       "value": round(total_assets, 2),    "unit": "RON",   "direction": "neutral"},
        {"name": "total_debt",         "value": round(total_debt, 2),      "unit": "RON",   "direction": "lower"},
        {"name": "total_equity",       "value": round(total_equity, 2),    "unit": "RON",   "direction": "higher"},
        {"name": "current_ratio",      "value": safe(current_assets, current_liab), "unit": "ratio", "direction": "higher"},
        {"name": "debt_to_equity",     "value": safe(total_debt, total_equity),     "unit": "ratio", "direction": "lower"},
        {"name": "debt_to_ebitda",     "value": safe(total_debt, ebitda),           "unit": "ratio", "direction": "lower"},
        {"name": "interest_coverage",  "value": safe(ebitda, interest),             "unit": "ratio", "direction": "higher"},
        {"name": "roa",                "value": safe(net_income, total_assets),     "unit": "ratio", "direction": "higher"},
        {"name": "roe",                "value": safe(net_income, total_equity),     "unit": "ratio", "direction": "higher"},
        {"name": "roic",               "value": safe(operating_profit * (1 - 0.16), max(total_debt + total_equity, 1)), "unit": "ratio", "direction": "higher"},
        {"name": "cash",               "value": round(bs["cash"], 2),              "unit": "RON",   "direction": "higher"},
        {"name": "free_cash_flow",     "value": round(net_income + depreciation, 2),"unit": "RON",  "direction": "higher"},
    ]

    # Persist
    org_id = doc["org_id"]
    with _supabase.admin() as admin_client:
        admin_client.delete("calculated_metrics", filters={"period_id": f"eq.{period_id}"})
        rows = [
            {
                "period_id": period_id,
                "org_id": org_id,
                "name": m["name"],
                "value": m["value"],
                "unit": m["unit"],
                "direction": m["direction"],
            }
            for m in metrics
        ]
        admin_client.insert("calculated_metrics", rows, returning=False)
    return metrics


def stage_validate(doc: Dict[str, Any], assembled: Dict[str, Any], period_id: str) -> List[Dict[str, Any]]:
    """Sanity-check the assembled statements. Emits data_quality alerts.
    Returns the alert list for narrate stage to merge with its own alerts.
    """
    s = assembled["statements"]
    bs = s["balanceSheet"]
    pl = s["incomeStatement"]

    alerts: List[Dict[str, Any]] = []

    # Balance sheet equation: A = L + E, within 1% tolerance
    total_assets = (
        bs["cash"] + bs["accountsReceivable"] + bs["inventory"] + bs["otherCurrentAssets"] +
        bs["propertyPlantEquipment"] + bs["intangibles"] + bs["otherNonCurrentAssets"]
    )
    total_liab_equity = (
        bs["accountsPayable"] + bs["shortTermDebt"] + bs["otherCurrentLiabilities"] +
        bs["longTermDebt"] + bs["otherNonCurrentLiabilities"] +
        bs["shareCapital"] + bs["retainedEarnings"] + bs["otherEquity"]
    )
    delta = abs(total_assets - total_liab_equity)
    if total_assets > 0 and delta / max(total_assets, 1) > 0.01:
        alerts.append({
            "severity": "medium",
            "category": "data_quality",
            "alert_key": f"balance_sheet_imbalance:{period_id}",
            "title": "Balance sheet doesn't balance",
            "body": f"Assets ({total_assets:,.0f}) and Liabilities + Equity ({total_liab_equity:,.0f}) differ by {delta:,.0f} RON ({delta/max(total_assets,1)*100:.1f}%). Check the extracted accounts on the Statements tab.",
        })

    if pl["revenue"] == 0 and pl["costOfGoodsSold"] == 0 and pl["operatingExpenses"] == 0:
        alerts.append({
            "severity": "high",
            "category": "data_quality",
            "alert_key": f"empty_pl:{period_id}",
            "title": "P&L statement is empty",
            "body": "No revenue or expenses extracted. The document may be balance-sheet only — upload the trial balance or P&L for a complete picture.",
        })

    return alerts


def stage_narrate(doc: Dict[str, Any], assembled: Dict[str, Any], metrics: List[Dict[str, Any]],
                  org: Dict[str, Any], period_id: str,
                  parsed: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Call Opus 4.7 with the metrics + industry context. Returns:
       { briefing: str, recommendations: [...], alerts: [...] }

    For non-financial documents (invoice register, sales analysis, product
    catalog) the prompt switches modes: instead of ratio-based CFO commentary,
    Claude describes what's in the document and surfaces the headline
    findings from `parsed.summary`.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return {"briefing": "Set ANTHROPIC_API_KEY on the backend to enable AI narrative.", "recommendations": [], "alerts": []}

    try:
        from anthropic import Anthropic  # type: ignore
    except ImportError:
        return {"briefing": "anthropic SDK not installed on backend.", "recommendations": [], "alerts": []}

    client = Anthropic(api_key=api_key)

    industry_key = org.get("industry_key") or "generic"
    industry_display = org.get("industry_display_name") or industry_key

    accounts_count = len((parsed or {}).get("accounts") or [])
    detected_type = (parsed or {}).get("detected_type") or "unknown"
    is_financial = accounts_count > 0 or detected_type in ("trial_balance", "bilant", "pl", "annual_report")

    if is_financial:
        system = (
            "You are a senior CFO advising the management team of a Romanian SME.\n"
            "You receive standardized financial statements and computed ratios.\n"
            "You DO NOT compute numbers — explain them in industry context.\n\n"
            "CRITICAL: Apply industry-appropriate thresholds.\n"
            " - Real estate: 4× Debt/EBITDA is normal; do NOT recommend deleveraging at that level.\n"
            " - SaaS: focus on rule-of-40, ARR growth, gross margin >70%.\n"
            " - FMCG: working-capital efficiency, inventory turn, thin margins are normal.\n"
            " - Manufacturing: capex intensity, fixed-cost leverage are normal.\n\n"
            "Reply in English. Be specific. Quantify recommendations in RON impact when possible.\n"
            "Output STRICT JSON. No prose outside JSON. The first character of your reply must be '{'."
        )
    else:
        system = (
            "You are a senior CFO advisor reviewing a business document. The user uploaded\n"
            "a non-statement document (invoice register, sales analysis, product catalog,\n"
            "bank statement, etc.) — there is NO income statement or balance sheet to read.\n\n"
            "Your job:\n"
            "  1. Briefing (3 sentences): describe in concrete terms what the document IS,\n"
            "     what it covers, and what the most material rows / aggregates are. Use the\n"
            "     `summary` block in the input — row_count, headline_total, top_records.\n"
            "  2. Recommendations: 1–3 actionable next steps grounded in this specific\n"
            "     document. E.g. 'export accounts receivable aging from this register and\n"
            "     contact the top 3 overdue customers' or 'cross-check this sales analysis\n"
            "     against your trial balance to confirm revenue recognition'.\n"
            "  3. Alerts: only obvious data-quality issues (e.g. 'no totals row found'),\n"
            "     not financial-ratio alerts.\n\n"
            "Do NOT fabricate revenue / EBITDA / ratios. Do NOT lecture about leverage.\n"
            "Reply in English. Output STRICT JSON. The first character of your reply must be '{'."
        )

    user_payload = {
        "company": {
            "name": assembled["statements"].get("companyName"),
            "industry_key": industry_key,
            "industry_display_name": industry_display,
            "currency": assembled["statements"].get("currency", "RON"),
            "period_label": assembled["statements"].get("periodLabel"),
        },
        "document": {
            "filename": doc.get("original_filename"),
            "detected_type": detected_type,
            "accounts_extracted": accounts_count,
            "summary": (parsed or {}).get("summary") or {},
        },
        "balance_sheet": assembled["statements"]["balanceSheet"],
        "income_statement": assembled["statements"]["incomeStatement"],
        "metrics": [
            {"name": m["name"], "value": m["value"], "unit": m["unit"], "direction": m["direction"]}
            for m in metrics
        ],
        "schema": {
            "briefing": "3 sentences. Industry-aware. RON-denominated. Reference specific metrics from the input.",
            "recommendations": [
                {
                    "severity": "critical|high|medium|low",
                    "category": "financial|operational|data_quality",
                    "title": "string (8 words max)",
                    "rationale": "string (1-2 sentences explaining why)",
                    "actions": ["string action 1", "string action 2"],
                    "estimated_ron_impact": "number or null",
                    "metric_referenced": "name of the metric this is grounded in",
                }
            ],
            "alerts": [
                {
                    "severity": "critical|high|medium|low",
                    "category": "liquidity|leverage|margin|working_capital|opportunity",
                    "title": "string (10 words max)",
                    "body": "string (1-2 sentences)",
                    "metric_referenced": "string",
                }
            ],
        },
    }

    try:
        resp = client.messages.create(
            model="claude-opus-4-7",
            max_tokens=4096,
            system=system,
            messages=[{"role": "user", "content": json.dumps(user_payload)}],
            output_config={"effort": "high"},
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("Opus narrate failed: %s", e)
        return {"briefing": f"Narrative unavailable: {e}", "recommendations": [], "alerts": []}

    text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", None) == "text").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {"briefing": text[:500] or "Narrative unavailable.", "recommendations": [], "alerts": []}

    return {
        "briefing": data.get("briefing", "Narrative unavailable."),
        "recommendations": data.get("recommendations", []) or [],
        "alerts": data.get("alerts", []) or [],
    }


def stage_persist_narrative(
    doc: Dict[str, Any],
    period_id: str,
    narrate: Dict[str, Any],
    validation_alerts: List[Dict[str, Any]],
) -> None:
    org_id = doc["org_id"]
    document_id = doc["id"]
    with _supabase.admin() as admin_client:
        # Briefing — upsert one row per period
        admin_client.upsert(
            "briefings",
            {
                "period_id": period_id,
                "org_id": org_id,
                "body": narrate["briefing"],
                "language": "en",
                "model": "claude-opus-4-7",
            },
            on_conflict="period_id",
            returning=False,
        )

        # Recommendations — wipe per-document, re-insert
        admin_client.delete("recommendations", filters={"org_id": f"eq.{org_id}"})
        recs = []
        for r in narrate["recommendations"]:
            actions = r.get("actions") or []
            explanation = r.get("rationale", "") + ("\n\nActions:\n• " + "\n• ".join(actions) if actions else "")
            urgency_map = {"critical": "critical", "high": "high", "medium": "medium", "low": "low"}
            severity = (r.get("severity") or "medium").lower()
            recs.append({
                "org_id": org_id,
                "target_type": "dataset",
                "target_id": str(period_id),
                "title": r.get("title", "Untitled recommendation"),
                "explanation": explanation,
                "expected_cash_impact_kron": r.get("estimated_ron_impact"),
                "urgency": urgency_map.get(severity, "medium"),
                "status": "new",
            })
        if recs:
            admin_client.insert("recommendations", recs, returning=False)

        # Alerts — merge validation alerts + LLM alerts. Wipe per-document first.
        admin_client.delete("alerts", filters={"document_id": f"eq.{document_id}"})
        rows = []
        for a in validation_alerts + narrate["alerts"]:
            severity = (a.get("severity") or "medium").lower()
            if severity not in ("critical", "high", "medium", "low", "info"):
                severity = "medium"
            category = (a.get("category") or "data_quality").lower()
            if category not in ("liquidity", "leverage", "margin", "inventory", "compliance",
                                 "data_quality", "working_capital", "customer", "supplier", "opportunity"):
                category = "data_quality"
            rows.append({
                "org_id": org_id,
                "alert_key": a.get("alert_key") or f"narrate:{document_id}:{len(rows)}",
                "severity": severity,
                "category": category,
                "title": a.get("title", "Untitled alert"),
                "body": a.get("body", ""),
                "document_id": document_id,
                "payload": a,
            })
        if rows:
            admin_client.upsert("alerts", rows, on_conflict="org_id,alert_key", returning=False)


# ─── Orchestrator ───────────────────────────────────────────────────────────


def _run_pipeline_sync(document_id: str) -> None:
    t0 = time.time()
    try:
        with _supabase.admin() as admin_client:
            doc_rows = admin_client.select("documents", filters={"id": f"eq.{document_id}"}, single=True)
            if not doc_rows:
                logger.warning("[pipeline] document %s vanished mid-run", document_id)
                return
            doc = doc_rows[0]

            org_rows = admin_client.select("organizations", filters={"id": f"eq.{doc['org_id']}"}, single=True)
            org = org_rows[0] if org_rows else {"id": doc["org_id"], "name": "Unknown", "industry_key": None, "industry_display_name": None}

        _admin_set_status(document_id, "extracting", pipeline_started_at=_now_iso())
        parsed = stage_extract(doc)

        _admin_set_status(document_id, "mapping")
        assembled = stage_map(doc, parsed, org.get("industry_display_name") or org.get("industry_key"))
        period_id = stage_persist(doc, parsed, assembled)

        _admin_set_status(document_id, "computing")
        # For non-financial docs (no accounts extracted), skip ratio
        # computation + the empty-PL alert — they'd just produce noise. The
        # narrative stage covers what the document actually contains.
        accounts_count = len(parsed.get("accounts") or [])
        if accounts_count > 0:
            metrics = stage_compute(doc, assembled, period_id)
            validation_alerts = stage_validate(doc, assembled, period_id)
        else:
            metrics = []
            validation_alerts = []

        _admin_set_status(document_id, "narrating")
        narrative = stage_narrate(doc, assembled, metrics, org, period_id, parsed=parsed)
        stage_persist_narrative(doc, period_id, narrative, validation_alerts)

        # Persist the assembled statements blob on financial_periods so the
        # period read endpoint can return it without re-deriving.
        with _supabase.admin() as admin_client:
            admin_client.update(
                "financial_periods",
                {"updated_at": _now_iso()},  # touch to bust cache
                filters={"id": f"eq.{period_id}"},
            )

        _admin_set_status(
            document_id,
            "analyzed",
            duration_ms=int((time.time() - t0) * 1000),
            period_id=period_id,
        )
        logger.info("[pipeline] %s complete in %dms", document_id, int((time.time() - t0) * 1000))
    except Exception as exc:  # noqa: BLE001
        logger.exception("[pipeline] %s failed", document_id)
        msg = f"{type(exc).__name__}: {exc}"
        try:
            _admin_set_status(document_id, "failed", error=msg, duration_ms=int((time.time() - t0) * 1000))
        except Exception:
            logger.exception("[pipeline] also failed to mark failed")


def _enqueue(document_id: str) -> None:
    """Run the pipeline on a daemon thread. Production should swap this for a
    real queue (Inngest, Supabase Edge functions, BullMQ-equivalent), but for
    a single-server MVP a thread per upload is fine — uploads are infrequent
    and each pipeline takes <60s.
    """
    t = threading.Thread(target=_run_pipeline_sync, args=(document_id,), daemon=True)
    t.start()


# ─── HTTP shape ─────────────────────────────────────────────────────────────


class RunRequest(BaseModel):
    document_id: str


class RunResponse(BaseModel):
    document_id: str
    status: str


def build_router() -> APIRouter:
    router = APIRouter(tags=["pipeline"])

    @router.post("/api/pipeline/run", response_model=RunResponse, status_code=202)
    def run_pipeline(req: RunRequest, authorization: Optional[str] = Header(None)) -> RunResponse:
        jwt = _require_jwt(authorization)
        doc = _verify_user_owns_document(jwt, req.document_id)
        _admin_set_status(req.document_id, "queued", pipeline_started_at=_now_iso())
        _enqueue(req.document_id)
        return RunResponse(document_id=req.document_id, status="queued")

    @router.post("/api/pipeline/retry", response_model=RunResponse, status_code=202)
    def retry_pipeline(req: RunRequest, authorization: Optional[str] = Header(None)) -> RunResponse:
        jwt = _require_jwt(authorization)
        doc = _verify_user_owns_document(jwt, req.document_id)
        # Wipe prior derivatives via cascade — deleting the financial_periods
        # row removes statement_line_items, calculated_metrics, briefings,
        # AND alerts (alerts.document_id has on delete set null, we explicitly
        # wipe by document below for that one).
        if doc.get("period_id"):
            with _supabase.admin() as admin_client:
                admin_client.delete("financial_periods", filters={"id": f"eq.{doc['period_id']}"})
        with _supabase.admin() as admin_client:
            admin_client.delete("alerts", filters={"document_id": f"eq.{req.document_id}"})
            admin_client.update(
                "documents",
                {"period_id": None, "error": None, "duration_ms": None},
                filters={"id": f"eq.{req.document_id}"},
            )
        _admin_set_status(req.document_id, "queued", pipeline_started_at=_now_iso())
        _enqueue(req.document_id)
        return RunResponse(document_id=req.document_id, status="queued")

    @router.get("/api/period/{period_id}")
    def get_period(period_id: str, authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        """Return the consolidated payload for one period: statements (assembled
        from line items), metrics, briefing, recommendations, alerts.

        RLS-scoped: uses the caller's JWT so they only see their own data.
        """
        jwt = _require_jwt(authorization)
        with _supabase.per_user(jwt) as client:
            periods = client.select("financial_periods", filters={"id": f"eq.{period_id}"}, single=True)
            if not periods:
                raise HTTPException(404, "Period not found.")
            period = periods[0]

            line_items = client.select(
                "statement_line_items",
                filters={"period_id": f"eq.{period_id}"},
            )
            metrics = client.select(
                "calculated_metrics",
                filters={"period_id": f"eq.{period_id}"},
            )
            briefings = client.select("briefings", filters={"period_id": f"eq.{period_id}"})
            briefing = briefings[0] if briefings else None

            doc_rows = client.select(
                "documents",
                filters={"id": f"eq.{period['source_document_id']}"},
                single=True,
            ) if period.get("source_document_id") else []
            doc = doc_rows[0] if doc_rows else None
            org_id = period["org_id"]

            recs = client.select(
                "recommendations",
                filters={"org_id": f"eq.{org_id}"},
                order="urgency.desc,created_at.desc",
            )
            alerts = client.select(
                "alerts",
                filters={
                    "org_id": f"eq.{org_id}",
                    "resolved_at": "is.null",
                },
            )

            org_rows = client.select("organizations", filters={"id": f"eq.{org_id}"}, single=True)
            org = org_rows[0] if org_rows else None

        # Re-assemble Statements from line_items so the frontend doesn't need
        # to know how to rebuild them.
        bs_buckets = {
            "cash": "cash", "ar": "accountsReceivable", "inventory": "inventory",
            "otherCurrentAssets": "otherCurrentAssets",
            "ppe": "propertyPlantEquipment", "intangibles": "intangibles",
            "otherNonCurrentAssets": "otherNonCurrentAssets",
            "ap": "accountsPayable", "stDebt": "shortTermDebt", "otherCurrentLiab": "otherCurrentLiabilities",
            "ltDebt": "longTermDebt", "otherNonCurrentLiab": "otherNonCurrentLiabilities",
            "shareCapital": "shareCapital", "retainedEarnings": "retainedEarnings", "otherEquity": "otherEquity",
        }
        pl_buckets = {
            "revenue": "revenue", "cogs": "costOfGoodsSold", "operatingExpenses": "operatingExpenses",
            "depreciation": "depreciationAmortization", "interestExpense": "interestExpense",
            "otherIncome": "otherIncome", "financialIncome": "financialIncome",
            "financialExpense": "financialExpense", "taxExpense": "taxExpense",
        }
        bs: Dict[str, float] = {v: 0.0 for v in bs_buckets.values()}
        pl: Dict[str, float] = {v: 0.0 for v in pl_buckets.values()}
        for item in line_items:
            bucket = item["bucket"]
            amount = float(item["amount"] or 0)
            if bucket in bs_buckets:
                bs[bs_buckets[bucket]] += amount
            elif bucket in pl_buckets:
                pl[pl_buckets[bucket]] += amount

        statements = {
            "companyName": (org or {}).get("name") if org else None,
            "industry": (org or {}).get("industry_display_name") if org else None,
            "currency": period.get("currency", "RON"),
            "periodLabel": period.get("period_end"),
            "balanceSheet": {k: round(v, 2) for k, v in bs.items()},
            "incomeStatement": {k: round(v, 2) for k, v in pl.items()},
            # Required by the TS Statements interface so computeRatios() can
            # read supplementary.periodDays. Real enrichment values arrive
            # later via Settings.
            "supplementary": {"periodDays": 365},
        }

        return {
            "period": {
                "id": period["id"],
                "period_end": period["period_end"],
                "currency": period["currency"],
                "extraction_confidence": period.get("extraction_confidence"),
                "source_document": doc and {
                    "id": doc["id"],
                    "filename": doc["original_filename"],
                    "status": doc["status"],
                },
            },
            "organization": org and {
                "id": org["id"],
                "name": org["name"],
                "industry_key": org.get("industry_key"),
                "industry_display_name": org.get("industry_display_name"),
            },
            "statements": statements,
            "metrics": [
                {
                    "name": m["name"],
                    "value": m["value"],
                    "unit": m["unit"],
                    "direction": m.get("direction"),
                }
                for m in metrics
            ],
            "briefing": briefing and {
                "body": briefing["body"],
                "language": briefing.get("language", "en"),
                "model": briefing.get("model"),
            },
            "recommendations": [
                {
                    "id": r["id"],
                    "title": r["title"],
                    "explanation": r.get("explanation"),
                    "urgency": r.get("urgency"),
                    "expected_cash_impact_kron": r.get("expected_cash_impact_kron"),
                    "status": r.get("status"),
                }
                for r in recs
            ],
            "alerts": [
                {
                    "id": a["id"],
                    "alert_key": a["alert_key"],
                    "severity": a["severity"],
                    "category": a["category"],
                    "title": a["title"],
                    "body": a.get("body"),
                }
                for a in alerts
            ],
        }

    return router
