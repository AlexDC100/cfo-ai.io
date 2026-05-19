"""Production-grade chart-of-accounts + language detector.

Runs as the first stage of the pipeline (before extraction). Takes the raw
OCR text + the original filename and returns:

  {
    "coa_key":       "skr_03",       # which chart-of-accounts to map against
    "country_code":  "DE",
    "language":      "de",
    "currency":      "EUR",
    "number_format": {"decimal": ",", "thousand": "."},
    "confidence":    0.87,            # 0–1
    "decided_by":    "heuristic" | "opus" | "fallback",
    "runner_up":     {...} | None,    # second-best candidate
    "needs_user_confirmation": bool,  # true when confidence < 0.80 or ambiguous
    "launch_status": "ga" | "beta" | "preview",
  }

Strategy:
  1. Heuristic scoring against every active coa_registries row. Four signals
     (filename, header keywords, account-code regex, language markers) are
     weighted and summed into a [0,1] total.
  2. Confidence buckets:
       ≥0.85 high   — silent flow
       ≥0.60 medium — show "We detected …" badge but proceed
       <0.60 low    — escalate to Opus 4.7
     Plus an ambiguity check: if the runner-up is within 0.10 of the top,
     treat as low even if the absolute number is above 0.85.
  3. Opus 4.7 fallback: a short JSON-mode call with the top-3 candidates
     and the OCR head. SHA-256 cached so re-uploads of the same file don't
     re-pay for inference.
  4. Number format inferred from the actual digits in the document (catches
     copy-paste documents where the registry's expected format is wrong).

Adding a country = (a) seed coa_registries.detection_signatures with strong
keywords/code patterns and (b) ensure ≥60 coa_account_mappings rows. No
code change in this module.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

from . import _supabase


logger = logging.getLogger(__name__)


# ─── Tunables ───────────────────────────────────────────────────────────────


CONFIDENCE_HIGH = 0.85
CONFIDENCE_MEDIUM = 0.60
AMBIGUITY_DELTA = 0.10            # if top and runner-up within this → ambiguous

# Weights — must sum to 1.0. Account-code pattern is the strongest single
# signal (a German Saldenliste with 1200/1400/8400 patterns is unambiguously
# SKR 03 even if the language detection fumbles).
W_FILENAME = 0.20
W_KEYWORDS = 0.30
W_ACCOUNT_CODES = 0.35
W_LANG_MARKERS = 0.15

# Cache table for Opus fallback — keyed by SHA-256 of the OCR text head.
OCR_CACHE_TABLE = "detection_opus_cache"  # created lazily; persist fails fall back to in-memory

# In-memory fallback cache (TTL ~24h via dict; Python process restart clears it)
_MEMORY_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_MEMORY_TTL_SEC = 24 * 60 * 60


# ─── Currency derivation by country ─────────────────────────────────────────


_CURRENCY_BY_COUNTRY = {
    "RO": "RON", "DE": "EUR", "AT": "EUR", "FR": "EUR", "ES": "EUR",
    "IT": "EUR", "NL": "EUR", "BE": "EUR", "PL": "PLN", "CZ": "CZK",
    "HU": "HUF", "CH": "CHF", "PT": "EUR", "SE": "SEK", "DK": "DKK",
    "IE": "EUR", "GR": "EUR", "FI": "EUR", "NO": "NOK", "GB": "GBP",
}


def _currency_for(country: Optional[str], text: str) -> str:
    """Country's default currency, with a quick override when the text itself
    names a different currency (e.g. a Swiss subsidiary reporting in EUR)."""
    if not country:
        return "EUR"
    default = _CURRENCY_BY_COUNTRY.get(country.upper(), "EUR")
    # If the document mentions a different ISO currency code in plausible
    # accounting context, prefer it.
    overrides = {"EUR", "USD", "GBP", "CHF", "RON", "PLN", "HUF", "CZK", "SEK", "DKK", "NOK"}
    for code in overrides:
        if code == default:
            continue
        # Word-boundary occurrences in the document head (not just any letters)
        if re.search(rf"\b{code}\b", text[:5000]):
            return code
    return default


# ─── Registry loader ────────────────────────────────────────────────────────


def load_active_registries() -> List[Dict[str, Any]]:
    """Pull every active registry from Supabase. Cached for the process so
    repeated detections don't re-fetch."""
    cache_key = "__registries__"
    cached = _MEMORY_CACHE.get(cache_key)
    if cached and (time.time() - cached[0]) < 3600:
        return cached[1]  # type: ignore

    try:
        with _supabase.admin() as client:
            rows = client.select(
                "coa_registries",
                filters={"active": "eq.true"},
            )
    except Exception:  # noqa: BLE001
        logger.exception("[detect] failed to load coa_registries; returning empty")
        return []

    _MEMORY_CACHE[cache_key] = (time.time(), rows)  # type: ignore
    return rows


# ─── Scoring ────────────────────────────────────────────────────────────────


def _safe_re_compile(pattern: Optional[str]) -> Optional[re.Pattern]:
    if not pattern:
        return None
    try:
        return re.compile(pattern)
    except re.error:
        return None


def _normalize(text: str) -> str:
    """Collapse whitespace and lowercase for keyword matching. The original
    text is preserved separately for extraction; this is only used for the
    detect pass."""
    return re.sub(r"\s+", " ", text or "").lower()


def score_registry(
    registry: Dict[str, Any],
    *,
    raw_text: str,
    normalized: str,
    filename: Optional[str],
) -> Dict[str, float]:
    """Returns the per-signal sub-scores plus the weighted total."""
    sig = registry.get("detection_signatures") or {}
    if isinstance(sig, str):
        try:
            sig = json.loads(sig)
        except json.JSONDecodeError:
            sig = {}

    filename_score = 0.0
    keywords_score = 0.0
    account_codes_score = 0.0
    language_markers_score = 0.0

    filename_lower = (filename or "").lower()

    # 1. Filename — any pattern hits gives full score
    fname_patterns = sig.get("filename_patterns") or []
    if filename_lower and any(p.lower() in filename_lower for p in fname_patterns):
        filename_score = 1.0

    # 2. Header keywords — fraction of hits up to 3 keywords
    kw = sig.get("header_keywords_native") or []
    kw_hits = [k for k in kw if k and k.lower() in normalized]
    if kw:
        keywords_score = min(1.0, len(kw_hits) / 3.0)

    # 3. Account-code regex — sample digit-tokens and see what fraction matches
    pattern = _safe_re_compile(sig.get("account_code_pattern"))
    if pattern is not None:
        # Pull plausible-looking account codes from the document head
        candidates = re.findall(r"\b\d{2,8}\b", raw_text[:20000])[:200]
        if candidates:
            matches = sum(1 for c in candidates if pattern.fullmatch(c))
            account_codes_score = matches / len(candidates)

    # 4. Language markers — fraction of hits up to 4 markers
    markers = sig.get("language_markers") or []
    marker_hits = [m for m in markers if m and m.lower() in normalized]
    if markers:
        language_markers_score = min(1.0, len(marker_hits) / 4.0)

    total = (
        filename_score * W_FILENAME
        + keywords_score * W_KEYWORDS
        + account_codes_score * W_ACCOUNT_CODES
        + language_markers_score * W_LANG_MARKERS
    )

    return {
        "filename": filename_score,
        "keywords": keywords_score,
        "account_codes": account_codes_score,
        "language_markers": language_markers_score,
        "total": round(total, 4),
    }


# ─── Number format inference ────────────────────────────────────────────────


def infer_number_format(text: str) -> Optional[Dict[str, str]]:
    """Read the actual digits in the document and decide whether the file is
    using EU-style (1.234,56) or US/UK-style (1,234.56) or Swiss-style
    (1'234.56). Returns None when there aren't enough numbers to be sure.
    """
    # Numbers with at least one thousand-separator group, possibly followed
    # by a decimal segment with 1–2 digits.
    candidates = re.findall(
        r"\b\d{1,3}(?:[.,\s']\d{3})+(?:[.,]\d{1,2})?\b",
        text[:30000],
    )
    if len(candidates) < 5:
        return None

    dot_decimal = 0
    comma_decimal = 0
    swiss = 0
    for n in candidates[:50]:
        # The last "." or "," followed by 1–2 trailing digits indicates the decimal.
        m = re.search(r"[.,](?=\d{1,2}$)", n)
        if not m:
            continue
        sep = m.group(0)
        if sep == ".":
            # Swiss-style uses ' as thousand separator with . as decimal
            if "'" in n:
                swiss += 1
            else:
                dot_decimal += 1
        else:
            comma_decimal += 1

    if comma_decimal > dot_decimal and comma_decimal > swiss:
        return {"decimal": ",", "thousand": "."}
    if swiss >= dot_decimal and swiss > 0:
        return {"decimal": ".", "thousand": "'"}
    if dot_decimal > comma_decimal:
        return {"decimal": ".", "thousand": ","}
    return None


# ─── Language detection (lightweight) ───────────────────────────────────────


# Tiny per-language signature lookup. Detection here is best-effort and
# secondary to the registry's own language tag. Used when the registry is
# ambiguous (e.g. Belgium's PCMN renders in both fr and nl).
_LANGUAGE_SIGNATURES = {
    "de": ["soll", "haben", "konto", "bilanz", "umsatzsteuer", "gewinn", "verlust", "abschreibung"],
    "fr": ["solde", "débit", "crédit", "compte", "bilan", "résultat", "ventes", "amortissement"],
    "es": ["saldo", "debe", "haber", "cuenta", "balance", "resultados", "ventas", "amortización"],
    "it": ["saldo", "dare", "avere", "conto", "bilancio", "ricavi", "costi", "ammortamenti"],
    "ro": ["sold", "debit", "credit", "cont", "bilanț", "venituri", "cheltuieli", "amortizări"],
    "nl": ["saldo", "debet", "credit", "rekening", "balans", "omzet", "kosten", "afschrijving"],
    "pl": ["saldo", "winien", "ma", "konto", "bilans", "przychody", "koszty", "amortyzacja"],
    "cs": ["saldo", "má dáti", "dal", "účet", "rozvaha", "výnosy", "náklady", "odpisy"],
    "hu": ["egyenleg", "tartozik", "követel", "számla", "mérleg", "bevétel", "költség", "értékcsökkenés"],
    "pt": ["saldo", "débito", "crédito", "conta", "balanço", "receita", "custos", "amortização"],
    "sv": ["saldo", "debet", "kredit", "konto", "balans", "intäkter", "kostnader", "avskrivning"],
    "da": ["saldo", "debet", "kredit", "konto", "balance", "indtægter", "udgifter", "afskrivning"],
    "en": ["balance", "debit", "credit", "account", "revenue", "cost", "depreciation", "ledger"],
}


def detect_language(normalized: str) -> Optional[str]:
    best_code: Optional[str] = None
    best_hits = 0
    for code, words in _LANGUAGE_SIGNATURES.items():
        hits = sum(1 for w in words if w in normalized)
        if hits > best_hits:
            best_hits = hits
            best_code = code
    return best_code if best_hits >= 2 else None


# ─── Opus 4.7 fallback ──────────────────────────────────────────────────────


_OPUS_SYSTEM = (
    "You identify the chart-of-accounts standard and language of a financial "
    "document. Return strict JSON. The first character must be '{'."
)


def _ocr_hash(ocr_text: str) -> str:
    return hashlib.sha256(ocr_text[:5000].encode("utf-8", errors="replace")).hexdigest()


def _read_cached_opus(key: str) -> Optional[Dict[str, Any]]:
    # In-memory first (fast)
    cached = _MEMORY_CACHE.get(key)
    if cached and (time.time() - cached[0]) < _MEMORY_TTL_SEC:
        return cached[1]  # type: ignore
    # Then persistent cache (best-effort; table may not exist)
    try:
        with _supabase.admin() as client:
            rows = client.select(
                OCR_CACHE_TABLE,
                filters={"ocr_hash": f"eq.{key}"},
                single=True,
            )
            if rows:
                payload = rows[0].get("payload") or {}
                if isinstance(payload, str):
                    payload = json.loads(payload)
                _MEMORY_CACHE[key] = (time.time(), payload)  # type: ignore
                return payload
    except Exception:  # noqa: BLE001
        pass
    return None


def _write_cached_opus(key: str, payload: Dict[str, Any]) -> None:
    _MEMORY_CACHE[key] = (time.time(), payload)  # type: ignore
    try:
        with _supabase.admin() as client:
            client.upsert(
                OCR_CACHE_TABLE,
                {"ocr_hash": key, "payload": payload},
                on_conflict="ocr_hash",
                returning=False,
            )
    except Exception:  # noqa: BLE001
        # Cache table doesn't exist or RLS rejects — fine; in-memory is enough
        # for the lifespan of the process.
        pass


def opus_identify_coa(
    *,
    ocr_text: str,
    top_candidates: List[Dict[str, Any]],
    supported: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Ask Opus 4.7 to pick a coa_key when the heuristic is ambiguous or
    low-confidence. Returns the parsed JSON dict or None on any failure.
    Result is cached by SHA-256 of the OCR head."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None

    key = _ocr_hash(ocr_text)
    cached = _read_cached_opus(key)
    if cached:
        return cached

    try:
        from anthropic import Anthropic  # type: ignore
    except ImportError:
        return None

    allowed = ", ".join(f"{r['key']} ({r['country_code']})" for r in supported)
    candidates_block = "\n".join(
        f"- {c['key']} ({c.get('country_code','?')}, score {c.get('total',0):.2f})"
        for c in top_candidates
    )
    user_payload = (
        "Document excerpt:\n\"\"\"\n"
        f"{ocr_text[:3000]}\n"
        "\"\"\"\n\n"
        f"Top heuristic candidates:\n{candidates_block}\n\n"
        f"Allowed coa_key values: {allowed}\n\n"
        'Return strict JSON: {"coa_key": "<one of allowed or unknown>", '
        '"country_code": "<ISO-3166-1 alpha-2>", "language": "<ISO 639-1>", '
        '"confidence": 0.0-1.0, "evidence": "<one sentence>"}'
    )

    try:
        # max_retries=5 protects against transient Opus 529 overloads
        # (SDK default is 2, not enough during sustained capacity events).
        client = Anthropic(api_key=api_key, max_retries=5, timeout=120.0)
        resp = client.messages.create(
            model="claude-opus-4-7",
            max_tokens=400,
            system=[{"type": "text", "text": _OPUS_SYSTEM,
                     "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user_payload}],
            output_config={"effort": "low"},
        )
    except Exception:  # noqa: BLE001
        logger.exception("[detect] Opus fallback failed")
        return None

    text = "".join(
        getattr(b, "text", "") for b in resp.content
        if getattr(b, "type", None) == "text"
    ).strip()
    if text.startswith("```"):
        text = text.strip("`").lstrip("json").strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        logger.warning("[detect] Opus returned non-JSON: %.200s", text)
        return None

    _write_cached_opus(key, parsed)
    return parsed


# ─── Main entry point ───────────────────────────────────────────────────────


def detect_format(
    ocr_text: str,
    *,
    filename: Optional[str] = None,
) -> Dict[str, Any]:
    """Identify chart-of-accounts, language, currency, and number format
    from an OCR'd document. Returns a dict suitable to attach to the
    document row or pass to the extractor."""
    registries = load_active_registries()
    if not registries:
        return _empty_result()

    normalized = _normalize(ocr_text)
    scored: List[Tuple[Dict[str, Any], Dict[str, float]]] = []
    for r in registries:
        s = score_registry(r, raw_text=ocr_text, normalized=normalized, filename=filename)
        scored.append((r, s))
    scored.sort(key=lambda pair: pair[1]["total"], reverse=True)

    top_reg, top_score = scored[0]
    second_reg, second_score = (scored[1] if len(scored) >= 2 else (None, None))

    if top_score["total"] >= CONFIDENCE_HIGH:
        confidence_band = "high"
    elif top_score["total"] >= CONFIDENCE_MEDIUM:
        confidence_band = "medium"
    else:
        confidence_band = "low"

    ambiguous = bool(
        second_score is not None
        and (top_score["total"] - second_score["total"]) < AMBIGUITY_DELTA
        and top_score["total"] > 0
    )

    decided_by = "heuristic"
    chosen_reg = top_reg
    chosen_score = top_score["total"]

    # Escalate to Opus when low confidence OR ambiguous
    if confidence_band == "low" or ambiguous:
        opus_top = [
            {
                "key": r["key"],
                "country_code": r["country_code"],
                "total": s["total"],
            }
            for r, s in scored[:3]
        ]
        opus = opus_identify_coa(
            ocr_text=ocr_text,
            top_candidates=opus_top,
            supported=[{"key": r["key"], "country_code": r["country_code"]} for r in registries],
        )
        if opus and opus.get("coa_key") and opus.get("coa_key") != "unknown":
            opus_reg = next((r for r in registries if r["key"] == opus["coa_key"]), None)
            opus_conf = float(opus.get("confidence") or 0.0)
            # Only adopt Opus's answer if it's more confident than the heuristic
            if opus_reg and opus_conf > chosen_score:
                chosen_reg = opus_reg
                chosen_score = opus_conf
                decided_by = "opus"
                if opus_conf >= CONFIDENCE_HIGH:
                    confidence_band = "high"
                elif opus_conf >= CONFIDENCE_MEDIUM:
                    confidence_band = "medium"

    # Number format — prefer the file's own digits over the registry's hint
    inferred_format = infer_number_format(ocr_text)
    registry_format = chosen_reg.get("number_format") or {}
    if isinstance(registry_format, str):
        try:
            registry_format = json.loads(registry_format)
        except json.JSONDecodeError:
            registry_format = {}
    number_format = inferred_format or registry_format or {"decimal": ".", "thousand": ","}

    # Language — prefer detected, fall back to registry tag
    language = detect_language(normalized) or chosen_reg.get("language") or "en"

    country_code = chosen_reg.get("country_code")
    currency = _currency_for(country_code, ocr_text)

    runner_up = None
    if second_reg is not None and second_score is not None and second_score["total"] > 0.10:
        runner_up = {
            "coa_key": second_reg["key"],
            "country_code": second_reg["country_code"],
            "score": second_score["total"],
        }

    return {
        "coa_key": chosen_reg["key"],
        "country_code": country_code,
        "language": language,
        "currency": currency,
        "number_format": number_format,
        "confidence": round(float(chosen_score), 4),
        "confidence_band": confidence_band,
        "decided_by": decided_by,
        "runner_up": runner_up,
        "needs_user_confirmation": confidence_band != "high",
        "launch_status": chosen_reg.get("launch_status", "preview"),
        "scores": {  # diagnostic — useful for the eval harness
            "top": top_score,
            "runner_up": second_score,
        },
    }


def _empty_result() -> Dict[str, Any]:
    return {
        "coa_key": None,
        "country_code": None,
        "language": "en",
        "currency": "EUR",
        "number_format": {"decimal": ".", "thousand": ","},
        "confidence": 0.0,
        "confidence_band": "low",
        "decided_by": "fallback",
        "runner_up": None,
        "needs_user_confirmation": True,
        "launch_status": "preview",
        "scores": {"top": None, "runner_up": None},
    }
