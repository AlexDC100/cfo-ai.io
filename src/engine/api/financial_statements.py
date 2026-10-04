"""The PDF model lane — extract a Romanian financial document into structured
trial-balance lines with Claude. IN-PROCESS ONLY: this module serves no HTTP
route.

NOT MOUNTED (2026-10-04). Until that date ``server.create_app()`` mounted
``POST /api/financial-statements/parse`` unconditionally, and the handler took
no Authorization header, no dependency, no meter and no rate limiter: anyone
on the internet could send a PDF (``pdf_b64``), or NAME A URL the server then
fetched itself (``pdf_url``), and have it read by the model on the backend's
key — measured on production, where only the key being invalid stopped the
spend. No screen ever called the route. The one real caller is the upload
pipeline, which does not go through HTTP: ``pipeline.stage_extract`` builds
this router object, finds the route named ``parse_document`` and calls its
handler in-process with a URL the engine signed itself. That is why
``build_router`` still exists and still returns a router — and why nothing
may ``include_router`` it. The law is tests/engine/test_no_anonymous_model_call.py
(gate ``no-anonymous-model-call``): it sweeps every route of the real app
anonymously and reds on a model client constructed or called.

    parse_document(ParseRequest(pdf_url=<signed storage URL> | pdf_b64=...,
                                original_filename=...)) -> ParseResponse
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

WHAT THE HANDLER WILL FETCH (``own_storage_url`` / ``fetch_own_storage_pdf``).
``pdf_url`` is accepted only for this project's own document storage: https,
the host (and port) of the Supabase project the engine is configured for
(``VITE_SUPABASE_URL`` — the setting ``_supabase.load_config`` reads; where it
is unset or unreadable the fetch is refused), the path prefix the pipeline's
signed URLs carry (``/storage/v1/object/sign/documents/``). Anything else is
refused BEFORE any request is made. No redirect is followed, the 25 MB cap is
enforced WHILE the body is read, and the download has a per-read timeout and
a whole-download deadline.

WHAT REACHES THE MODEL. Bytes the .pdf branch reads as a PDF
(``_upload_type.reads_as_pdf`` — the pipeline guard's own rule) and nothing
else: text, an archive, an empty file are refused before the SDK is imported.

The Anthropic SDK is imported lazily so the FastAPI server can boot even
without ANTHROPIC_API_KEY set (the handler raises a friendly 503 instead).
"""

from __future__ import annotations

import base64
import json
import os
import time
from typing import Any, Dict, List, Optional, Tuple

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


# ─── What this lane will fetch, and how ─────────────────────────────────────

#: The decoded-PDF ceiling, for `pdf_b64` and for a storage download alike.
PDF_MAX_BYTES = 25 * 1024 * 1024

#: The path every signed URL of the `documents` bucket carries
#: (`_supabase.SupabaseClient.signed_url`: `{url}/storage/v1` + the
#: `/object/sign/documents/{org}/…` the storage API returns). The pipeline
#: signs nothing else for this lane.
STORAGE_SIGNED_PATH_PREFIX = "/storage/v1/object/sign/documents/"

#: The setting that names the project — the one `_supabase.load_config` reads.
STORAGE_PROJECT_ENV = "VITE_SUPABASE_URL"

#: Per-phase timeout (connect / read / write / pool), seconds.
STORAGE_FETCH_TIMEOUT_S = 30.0

#: The whole download, seconds. A body that keeps trickling inside the
#: per-read timeout is still cut off here.
STORAGE_FETCH_DEADLINE_S = 120.0

#: The clock the deadline reads — a module name so a test can drive it.
_monotonic = time.monotonic


class PdfUrlRefused(ValueError):
    """`pdf_url` is not a signed URL of this project's document storage.
    Raised before any request is made; the message never quotes the URL
    (a signed URL carries its token)."""

    def __init__(self, reason: str, status: int = 400) -> None:
        super().__init__(reason)
        self.status = status


def _configured_storage_origin() -> Optional[Tuple[str, int]]:
    """(host, port) of the Supabase project the engine is configured for, or
    None when that cannot be determined — unset, unparseable, not https, or
    carrying credentials. None means: fetch nothing."""
    raw = (os.environ.get(STORAGE_PROJECT_ENV) or "").strip()
    if not raw:
        return None
    try:
        base = httpx.URL(raw)
    except Exception:  # noqa: BLE001 — an unreadable setting is "unknown"
        return None
    if base.scheme != "https" or not base.host or base.userinfo:
        return None
    return (base.host.lower(), base.port or 443)


def own_storage_url(pdf_url: str) -> httpx.URL:
    """The parsed URL when `pdf_url` is a signed URL of this project's own
    `documents` bucket; `PdfUrlRefused` otherwise. PURE — no request, no DNS.

    The URL is parsed by httpx, the client that will send it, so there is no
    second parser to disagree with about which host a string names.
    """
    origin = _configured_storage_origin()
    if origin is None:
        raise PdfUrlRefused(
            "the engine's document storage is not configured (%s is unset, "
            "unreadable or not https), so nothing is fetched" % STORAGE_PROJECT_ENV,
            status=503)
    if not isinstance(pdf_url, str) or not pdf_url or len(pdf_url) > 4096:
        raise PdfUrlRefused("not a URL")
    if "\\" in pdf_url or any(ord(c) <= 32 or ord(c) >= 127 for c in pdf_url):
        raise PdfUrlRefused("not a plain ASCII URL")
    try:
        url = httpx.URL(pdf_url)
    except Exception:  # noqa: BLE001 — unparseable is refused, never guessed
        raise PdfUrlRefused("not a URL")
    if url.scheme != "https":
        raise PdfUrlRefused("only https is fetched")
    if url.userinfo:
        raise PdfUrlRefused("a URL carrying credentials is not fetched")
    if (url.host.lower(), url.port or 443) != origin:
        raise PdfUrlRefused(
            "only this project's own document storage is fetched")
    path = url.path                      # percent-decoded, dot-segments resolved
    if not path.startswith(STORAGE_SIGNED_PATH_PREFIX):
        raise PdfUrlRefused(
            "only a signed URL of the documents bucket is fetched")
    segments = path[len(STORAGE_SIGNED_PATH_PREFIX):].split("/")
    if any(seg in ("", ".", "..") for seg in segments) or "\\" in path:
        raise PdfUrlRefused("the object path is not a plain storage path")
    return url


def fetch_own_storage_pdf(url: httpx.URL) -> bytes:
    """Download one object from the project's own storage, bounded.

    `url` is what `own_storage_url` returned. No redirect is followed (the
    storage API serves a signed object directly; a 3xx is refused, so no
    other host is ever requested). The body is STREAMED and the cap is
    enforced while reading — a declared length over the cap is refused
    before the first byte, an undeclared one as soon as the bytes read
    pass it. An encoded body is refused (`Accept-Encoding: identity` is
    sent), so the bytes counted are the bytes held.
    """
    deadline = _monotonic() + STORAGE_FETCH_DEADLINE_S
    try:
        with httpx.Client(timeout=httpx.Timeout(STORAGE_FETCH_TIMEOUT_S),
                          follow_redirects=False) as http:
            with http.stream("GET", url,
                             headers={"Accept-Encoding": "identity"}) as r:
                if 300 <= r.status_code < 400:
                    raise HTTPException(
                        502, "Could not fetch the PDF from storage: it answered "
                             "with a redirect (HTTP %d), which is not followed."
                             % r.status_code)
                if r.status_code != 200:
                    raise HTTPException(
                        502, "Could not fetch the PDF from storage: HTTP %d."
                             % r.status_code)
                encoding = (r.headers.get("content-encoding") or "identity").strip().lower()
                if encoding not in ("", "identity"):
                    raise HTTPException(
                        502, "Could not fetch the PDF from storage: an encoded "
                             "body (%s) is not read." % encoding[:20])
                declared = r.headers.get("content-length")
                if declared is not None and declared.strip().isdigit() \
                        and int(declared) > PDF_MAX_BYTES:
                    raise HTTPException(413, "PDF too large — 25 MB ceiling.")
                buf = bytearray()
                # No chunk size on purpose: `iter_bytes(n)` holds what it
                # reads back until n bytes have arrived, so a body trickling
                # in small pieces would never reach the deadline check below.
                # Each piece is one transport read (at most 64 KiB).
                for chunk in r.iter_bytes():
                    buf += chunk
                    if len(buf) > PDF_MAX_BYTES:
                        raise HTTPException(413, "PDF too large — 25 MB ceiling.")
                    if _monotonic() > deadline:
                        raise HTTPException(
                            504, "Could not fetch the PDF from storage: the "
                                 "download took longer than %d s."
                                 % int(STORAGE_FETCH_DEADLINE_S))
                return bytes(buf)
    except httpx.HTTPError as e:
        # The class only: an httpx error's text quotes the URL, and a signed
        # URL carries its token.
        raise HTTPException(
            502, "Could not fetch the PDF from storage: %s." % type(e).__name__)


def parse_document(req: ParseRequest) -> ParseResponse:
    """THE handler. Called in-process (`pipeline.stage_extract`, the corpus
    replay); mounted on no app — see the module docstring."""
    if not req.pdf_url and not req.pdf_b64:
        raise HTTPException(400, "Either pdf_url or pdf_b64 is required.")

    # ── A caller-named URL is refused before anything else happens ─────
    # Pure: no request, no key, no SDK. `target` is the parsed URL the
    # fetch below sends — what was checked is what is requested.
    target: Optional[httpx.URL] = None
    if not req.pdf_b64:
        try:
            target = own_storage_url(req.pdf_url or "")
        except PdfUrlRefused as refusal:
            raise HTTPException(refusal.status, "pdf_url refused: %s" % refusal)

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
        if len(pdf_bytes) > PDF_MAX_BYTES:
            raise HTTPException(413, "PDF too large — 25 MB ceiling.")
    else:
        assert target is not None
        pdf_bytes = fetch_own_storage_pdf(target)

    # ── The bytes must BE a PDF before anything is spent on them ───────
    # The pipeline's guard (`_upload_type.refused_on("pdf", …)`) refuses a
    # non-PDF before this lane — but it logs and continues when its own
    # download failed, and this handler then fetched its own copy and sent
    # whatever it was to the model as `application/pdf` (measured 2026-10-04:
    # b"not a pdf at all" reached `messages.create`). The rule read here is
    # the guard's own — what the .pdf branch reads as a PDF — so nothing the
    # pipeline hands over today is refused, and nothing else is sent.
    from . import _upload_type as _ut

    real = _ut.sniff_container(pdf_bytes)
    if not _ut.reads_as_pdf("pdf", real, pdf_bytes):
        raise HTTPException(
            415,
            "The file is not a PDF (its bytes read as %s) — it was not sent "
            "to the model." % real,
        )

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


def build_router() -> APIRouter:
    """The router object the pipeline looks `parse_document` up on.

    NOT FOR `include_router`: no app mounts this (module docstring). It is a
    router only because `pipeline.stage_extract` finds the handler by its
    route name; the path below is served nowhere.
    """
    router = APIRouter(prefix="/api/financial-statements", tags=["financial-statements"])
    router.post("/parse", response_model=ParseResponse)(parse_document)
    return router
