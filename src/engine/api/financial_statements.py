"""Document pipeline router — extract Romanian financial documents into
structured trial-balance lines via Claude Opus 4.7.

Single endpoint today: POST /api/financial-statements/parse
    Body: { pdf_url?: str, pdf_b64?: str, original_filename?: str }
    Response:
        {
            company_name: str | None,
            period_label: str,
            period_end: str | None,        # ISO yyyy-mm-dd
            currency: str,
            confidence: float,             # 0..1
            detected_type: str,            # 'trial_balance' | 'bilant' | ...
            accounts: [{ code, name, amount }],
            warnings: list[str],
        }

The frontend's existing trialBalanceParser.ts maps the returned account codes
to standardized buckets (clase 1–7 → IFRS-lite); this endpoint just runs the
OCR + extract steps so the API key stays server-side.

Phase 2 master-prompt rule: all AI calls go through one server-side service.
The Anthropic SDK is imported lazily so the FastAPI server can boot even
without ANTHROPIC_API_KEY set (the endpoint returns a friendly 503 instead).
"""

from __future__ import annotations

import base64
import json
import os
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


class ParseRequest(BaseModel):
    """One of pdf_url or pdf_b64 is required."""
    pdf_url: Optional[str] = None
    pdf_b64: Optional[str] = None
    original_filename: Optional[str] = None


class ExtractedAccount(BaseModel):
    code: str = Field(..., description="Romanian account code, e.g. '5121' or '4111'")
    name: str = Field(..., description="Romanian label of the account")
    amount: float = Field(
        ..., description="Closing balance (sold final). Positive when the account's natural side is non-zero; sign reflects the side per Romanian accounting convention."
    )


class ParseResponse(BaseModel):
    company_name: Optional[str]
    period_label: str
    period_end: Optional[str]
    currency: str
    confidence: float
    detected_type: str
    accounts: List[ExtractedAccount]
    warnings: List[str]
    model: Optional[str] = None
    usage: Optional[Dict[str, int]] = None


# ─── Heuristic document classifier ──────────────────────────────────────────
# Runs on filename (and is cheap). The LLM extraction stage validates with
# the document's own content; this just prepares a hint.

def _detect_from_filename(name: Optional[str]) -> str:
    if not name:
        return "unknown"
    n = name.lower()
    if "balanta" in n and "verificare" in n: return "trial_balance"
    if "balanta" in n or "bilant" in n: return "bilant"
    if "saft" in n or "d406" in n or "factura" in n or "invoice" in n: return "invoice_register"
    if "anual" in n or "annual" in n: return "annual_report"
    if "p&l" in n or "p_l" in n or "profit" in n: return "pl"
    return "unknown"


# ─── Extraction system prompt ───────────────────────────────────────────────
# We ask Opus 4.7 to read the PDF and emit a strict JSON object describing the
# trial balance. The schema mirrors ExtractedAccount above; we re-validate
# with Pydantic on receipt and repair common shape errors.

_SYSTEM_PROMPT = """You are a forensic accountant analyzing a Romanian financial document.

Your job: extract the trial balance ("balanță de verificare") or balance sheet
("bilanț") into a strict JSON object. Romanian accounting uses the OMFP-1802
chart of accounts (account codes 3–4 digits, classes 1–9).

CRITICAL RULES — read these before extracting:

1. Output STRICT JSON matching <schema>. No prose, no preamble, no markdown
   fences. The first character of your reply must be '{'.

2. For each account on a Romanian balanță de verificare, emit ONE entry
   with the YEAR-END CLOSING BALANCE — read directly from the "Solduri
   finale" columns (the rightmost columns of the trial balance).

   This is the AUDITED convention: it's what Romanian statutory
   financial statements report, what banks measure covenants against,
   and what published annual reports show. It corresponds to the
   company's position at the balance-sheet date (e.g. 31 Dec 2025).

   For accounts with separate "Solduri finale Debitoare" and "Solduri
   finale Creditoare" columns:
   - Class 1, 4-passive, 5-passive-bank, 7-income, plus contra-asset
     classes 28x/29x/491: take the credit balance, emit POSITIVE.
   - Class 2-current, 3, 4-active, 5-cash, 6-expense: take the debit
     balance, emit POSITIVE.
   - If both sides have non-zero values, emit the larger; the
     direction follows the side with the larger balance.

   For P&L accounts (Class 6, 7), use the YTD movement total (Sume
   totale Cr for revenue accounts; Sume totale Dr for expenses). These
   accounts close to zero on Solduri finale at year-end so the YTD
   movement is what represents the period's activity.

   Always emit the closing-balance number as POSITIVE. The pipeline's
   `sign='reverse'` rule in the canonical OMFP-1802 mapping handles
   direction in the standardized model.

3. Romanian numbers use either '.' or ',' as decimal separator with '.' or
   space thousand grouping. Always emit clean decimal numbers in your JSON
   (e.g. 1494837.00 not "1.494.837,00").

4. Do NOT invent accounts. If a row is unclear, OMIT it and add a string
   describing why to the "warnings" array.

5. If the document is NOT a Romanian trial balance / bilanț (e.g. it's an
   invoice or an annual report narrative), still try to extract balance-sheet
   and P&L line items into pseudo-accounts using common 3-4 digit RO codes:
   - Cash → 5121
   - Trade receivables → 4111
   - Inventory → 371
   - PPE → 212
   - Trade payables → 401
   - Long-term debt → 1621
   - Short-term debt → 5191
   - Share capital → 1012
   - Retained earnings → 117
   - Revenue (services/rent) → 704
   - Materials → 602
   - External services → 628
   - Salaries → 641
   - Property tax → 635
   - D&A → 681
   - Interest expense → 666
   - Tax expense → 691

6. Confidence rubric (emit a number 0..1):
   - 0.95: clear "balanță de verificare" with 4-column closing balance, all rows mapped
   - 0.80: balance sheet + P&L with explicit RON values, mapped to canonical codes
   - 0.60: scanned/OCR'd image, some rows unclear
   - 0.40: heavily inferred from narrative / PDF text fragments
   - <0.40: only company name + a few headline figures

<schema>
{
  "company_name": string | null,         // Entity name from header/cover
  "period_label": string,                // Human-readable, e.g. "FY 2025" or "Decembrie 2025"
  "period_end": string | null,           // ISO yyyy-mm-dd if discoverable
  "currency": string,                    // Default "RON"
  "confidence": number,                  // 0..1 per rubric above
  "detected_type": "trial_balance" | "bilant" | "pl" | "annual_report" | "unknown",
  "accounts": [
    { "code": "5121", "name": "Cont curent la bănci RON", "amount": 815734.00 }
  ],
  "warnings": [string]                   // Human-readable issues you couldn't resolve
}
</schema>

Begin."""


def build_router() -> APIRouter:
    router = APIRouter(prefix="/api/financial-statements", tags=["financial-statements"])

    @router.post("/parse", response_model=ParseResponse)
    def parse_document(req: ParseRequest) -> ParseResponse:
        if not req.pdf_url and not req.pdf_b64:
            raise HTTPException(400, "Either pdf_url or pdf_b64 is required.")

        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise HTTPException(
                503,
                "ANTHROPIC_API_KEY is not configured on the backend — financial statement parsing requires Claude Opus 4.7.",
            )

        # ── Fetch the PDF bytes ────────────────────────────────────────────
        if req.pdf_b64:
            try:
                pdf_bytes = base64.b64decode(req.pdf_b64)
            except Exception as e:
                raise HTTPException(400, f"Invalid base64 in pdf_b64: {e}")
        else:
            assert req.pdf_url is not None
            try:
                with httpx.Client(timeout=30.0) as http:
                    r = http.get(req.pdf_url)
                    r.raise_for_status()
                    pdf_bytes = r.content
            except httpx.HTTPError as e:
                raise HTTPException(502, f"Could not fetch PDF from URL: {e}")

        if len(pdf_bytes) > 25 * 1024 * 1024:
            raise HTTPException(413, "PDF too large — 25 MB ceiling.")

        # ── Lazy-import Anthropic SDK ──────────────────────────────────────
        try:
            from anthropic import Anthropic
        except ImportError:
            raise HTTPException(503, "anthropic SDK is not installed on the backend.")

        # SDK default max_retries is 2 — not enough during sustained Opus
        # overload. Bumping to 5 gives us ~6 attempts with exponential
        # backoff (roughly 1s → 2s → 4s → 8s → 16s), which typically
        # clears a transient 529 without the user ever seeing an error.
        client = Anthropic(api_key=key, max_retries=5, timeout=180.0)
        pdf_b64 = base64.standard_b64encode(pdf_bytes).decode("ascii")

        # ── Call Claude with the PDF as a document content block ───────────
        try:
            resp = client.messages.create(
                model="claude-opus-4-7",
                max_tokens=8000,
                system=[
                    {
                        "type": "text",
                        "text": _SYSTEM_PROMPT,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "document",
                                "source": {
                                    "type": "base64",
                                    "media_type": "application/pdf",
                                    "data": pdf_b64,
                                },
                            },
                            {
                                "type": "text",
                                "text": (
                                    "Extract this Romanian financial document into the JSON schema above. "
                                    "If it's a 'balanță de verificare', extract every account row with its "
                                    "closing balance (sold final). If it's a balance sheet + P&L, map line "
                                    "items to canonical RO account codes per the rubric. Return JSON only."
                                ),
                            },
                        ],
                    }
                ],
                output_config={"effort": "high"},
            )
        except Exception as e:  # noqa: BLE001
            # User-friendly framing for the most common transient class:
            # Anthropic 529 (overloaded). Status code lives on either the
            # SDK's APIStatusError.status_code or in the stringified error.
            status = getattr(e, "status_code", None)
            err_str = str(e)
            is_overloaded = status == 529 or "overloaded_error" in err_str or "529" in err_str
            is_rate_limited = status == 429 or "rate_limit" in err_str
            if is_overloaded:
                raise HTTPException(
                    503,
                    "Claude is temporarily overloaded after multiple retries. "
                    "This is a transient capacity issue on Anthropic's side — your "
                    "document is fine. Try again in 1-2 minutes.",
                )
            if is_rate_limited:
                raise HTTPException(
                    429,
                    "Rate limit reached on the Claude API. Try again in a minute.",
                )
            raise HTTPException(502, f"Claude extraction failed: {e}")

        text = "".join(
            getattr(b, "text", "") for b in resp.content if getattr(b, "type", None) == "text"
        ).strip()

        # ── Parse + validate the JSON. Repair common shape errors. ─────────
        if text.startswith("```"):
            # Defensive: strip ```json fences if Opus emitted them.
            text = text.strip("`")
            if text.startswith("json"):
                text = text[4:]
            text = text.strip()

        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            raise HTTPException(
                502,
                f"Claude returned invalid JSON. First 200 chars: {text[:200]!r}. Error: {e}",
            )

        # Repair: missing fields → defaults
        data.setdefault("company_name", None)
        data.setdefault("period_label", "Imported period")
        data.setdefault("period_end", None)
        data.setdefault("currency", "RON")
        data.setdefault("confidence", 0.5)
        data.setdefault("detected_type", _detect_from_filename(req.original_filename))
        data.setdefault("accounts", [])
        data.setdefault("warnings", [])

        # Coerce account amounts to floats (Opus sometimes returns strings).
        cleaned_accounts: List[Dict[str, Any]] = []
        for raw in data["accounts"]:
            try:
                amt = float(raw.get("amount", 0)) if not isinstance(raw.get("amount"), (int, float)) else float(raw["amount"])
                cleaned_accounts.append({
                    "code": str(raw.get("code", "")).strip(),
                    "name": str(raw.get("name", "")).strip(),
                    "amount": amt,
                })
            except (TypeError, ValueError):
                data["warnings"].append(f"Dropped malformed account row: {raw}")
        data["accounts"] = cleaned_accounts

        # Wrap usage info for the client; useful for cost telemetry.
        usage = {
            "input_tokens": resp.usage.input_tokens,
            "output_tokens": resp.usage.output_tokens,
            "cache_read_input_tokens": getattr(resp.usage, "cache_read_input_tokens", 0),
            "cache_creation_input_tokens": getattr(resp.usage, "cache_creation_input_tokens", 0),
        }

        try:
            return ParseResponse(**data, model=resp.model, usage=usage)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(
                502,
                f"Claude response did not match the expected schema: {e}. Payload: {json.dumps(data)[:400]}",
            )

    return router
