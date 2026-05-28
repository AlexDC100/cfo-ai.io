"""SEC EDGAR + Claude → filings-derived CompanyExposureProfile.

This is the Phase C upgrade path for company exposure: instead of using
the sector library's default profile, we extract the company-specific
Item 1A "Risk Factors" section from the latest 10-K filing and have
Claude turn it into structured exposure data.

Design contract:

  · This module is the ONLY place we call Claude with filings text.
    Other intelligence modules never touch SEC EDGAR.
  · Output shape MUST be the same CompanyExposureProfile dataclass —
    drop-in replacement for the sector-model profile so the rest of
    the engine (risk scoring, radar aggregation, AI Market Read)
    doesn't need to know whether it got a sector or filings profile.
  · `source = "filings"` on the returned profile. Confidence rises
    from 0.55 (sector default) to 0.85 (filings-derived).
  · Lazy imports + graceful fallback: if SEC_EDGAR_ENABLED is unset,
    if ANTHROPIC_API_KEY is missing, if the EDGAR fetch fails, OR if
    Claude returns malformed output → caller falls back to sector
    model. The module never crashes the request path.

Architectural invariants:

  · Lazy `anthropic` import — same pattern as ai_market_read.py and
    briefing/client.py. The intelligence layer never hard-requires
    anthropic at import time.
  · Polite HTTP — SEC EDGAR requires a User-Agent identifying the
    requesting org per their fair-access policy. Hard-coded here.
  · TTL cache — 10-Ks update annually so we cache by ticker for 30
    days in the existing macro_signal_cache Supabase table (or
    process-local for Phase C.0 pre-DB).

Phase C.1+ scope (deferred): 10-Q (quarterly) updates between annual
filings; multi-year corpus for trend extraction. The hot path stays
the latest 10-K because that's where management's own risk disclosure
lives.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Optional

from .models import (
    CompanyExposureProfile,
    OpportunityRef,
    RiskRef,
)

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────
# Constants — SEC EDGAR + Claude config
# ─────────────────────────────────────────────────────────────────────────

# Per SEC fair-access policy. The User-Agent MUST identify the requesting
# org with an email contact. Without this, EDGAR returns 403.
_EDGAR_USER_AGENT = (
    "CFO-AI-Intelligence research@cfo-ai.io "
    "(https://cfo-ai.io)"
)

_HTTP_TIMEOUT_SEC = 15

# Risk Factors sections in 10-Ks run 5-40 pages. Cap at 60K chars to keep
# the Claude call cheap + bounded; that's enough for the typical "Item 1A"
# section. If a filing is much longer, we truncate at section boundaries.
_MAX_RISK_FACTORS_CHARS = 60_000

# Filings-derived confidence ceiling. Phase C: 0.85 vs Phase A sector_model's
# 0.55. Allows ai_inferred (Phase C+) to land between at 0.70.
FILINGS_CONFIDENCE = 0.85


# ─────────────────────────────────────────────────────────────────────────
# Public entry point — drop-in replacement for sector profile resolution
# ─────────────────────────────────────────────────────────────────────────

def try_filings_derived_profile(
    *,
    ticker: str,
    company_name: str,
    sector: str,
    industry: Optional[str],
    client: Optional[Any] = None,
) -> Optional[CompanyExposureProfile]:
    """Attempt to build a filings-derived profile for a ticker.

    Returns `CompanyExposureProfile` with `source="filings"` on success,
    or `None` on any failure (caller should fall back to sector model).

    Flow:
      1. Check SEC_EDGAR_ENABLED + ANTHROPIC_API_KEY env vars
      2. ticker → CIK (SEC's company identifier) via EDGAR's tickers.json
      3. CIK → latest 10-K accession number via EDGAR's submissions.json
      4. Accession → 10-K full-text URL
      5. Fetch + extract Item 1A "Risk Factors" section
      6. Hand the text to Claude → structured JSON
      7. Parse + build CompanyExposureProfile

    `client` is an injectable LLM client (for tests). When None and the
    env is configured, builds a real ClaudeFilingsClient.
    """
    if os.environ.get("SEC_EDGAR_ENABLED", "").lower() not in {"1", "true", "yes"}:
        return None
    if not os.environ.get("ANTHROPIC_API_KEY"):
        logger.info("filings_extractor: SEC_EDGAR_ENABLED but no ANTHROPIC_API_KEY")
        return None

    # Phase D cache lookup — DB-primary, in-memory read-through.
    # On hit we avoid the entire EDGAR + Claude chain. On miss we drop
    # through to the extraction path below and call set_cached() at the
    # end so the next request hits the cache.
    from .filings_cache import get_cached, set_cached
    cached = get_cached(ticker)
    if cached is not None:
        return cached

    try:
        cik = _ticker_to_cik(ticker)
        if cik is None:
            return None
        accession, filing_date = _latest_10k_accession(cik)
        if accession is None:
            return None
        risk_factors = _fetch_risk_factors_text(cik, accession)
        if not risk_factors:
            return None

        llm = client if client is not None else _build_default_client()
        if llm is None:
            return None

        extracted = _extract_via_claude(
            llm=llm,
            ticker=ticker,
            company_name=company_name,
            sector=sector,
            industry=industry,
            risk_factors=risk_factors,
        )
        if extracted is None:
            return None

        profile = _build_profile(
            ticker=ticker,
            company_name=company_name,
            sector=sector,
            industry=industry,
            extracted=extracted,
            filing_date=filing_date,
        )
        # Phase D — persist to the DB-primary cache so subsequent
        # requests skip the entire EDGAR + Claude chain. set_cached()
        # writes through to both layers (DB then in-memory).
        try:
            set_cached(profile)
        except Exception as e:
            logger.warning("filings_extractor: cache write failed for %s: %s", ticker, e)
        return profile
    except Exception as e:
        logger.warning("filings_extractor failed for %s: %s", ticker, e)
        return None


# ─────────────────────────────────────────────────────────────────────────
# SEC EDGAR — ticker → CIK → latest 10-K
# ─────────────────────────────────────────────────────────────────────────

# Cache the ticker → CIK map at module-level. The map is ~50K entries and
# only changes when companies IPO / delist; refreshing once per process
# lifetime is fine. Reset for tests via `_reset_cik_cache()`.
_TICKER_TO_CIK_CACHE: Optional[dict[str, str]] = None


def _ticker_to_cik(ticker: str) -> Optional[str]:
    """Resolve a ticker to its 10-digit zero-padded CIK string."""
    global _TICKER_TO_CIK_CACHE
    if _TICKER_TO_CIK_CACHE is None:
        _TICKER_TO_CIK_CACHE = _load_cik_map()
    return _TICKER_TO_CIK_CACHE.get(ticker.upper())


def _load_cik_map() -> dict[str, str]:
    """Fetch SEC's master ticker → CIK lookup.

    EDGAR publishes this as a JSON map at
    https://www.sec.gov/files/company_tickers.json — refreshed daily,
    ~50K entries. We pull it once at process start.
    """
    url = "https://www.sec.gov/files/company_tickers.json"
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": _EDGAR_USER_AGENT}
        )
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SEC) as resp:
            payload = json.loads(resp.read())
    except Exception as e:
        logger.warning("filings_extractor: CIK map fetch failed: %s", e)
        return {}
    # Payload shape: {"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}, ...}
    result: dict[str, str] = {}
    for entry in payload.values():
        ticker = entry.get("ticker", "").upper()
        cik = entry.get("cik_str")
        if ticker and cik is not None:
            result[ticker] = str(cik).zfill(10)
    return result


def _latest_10k_accession(cik: str) -> tuple[Optional[str], Optional[str]]:
    """Return (accession_number, filing_date) for the latest 10-K filing."""
    url = f"https://data.sec.gov/submissions/CIK{cik}.json"
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": _EDGAR_USER_AGENT}
        )
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SEC) as resp:
            payload = json.loads(resp.read())
    except Exception as e:
        logger.warning("filings_extractor: submissions fetch failed for CIK %s: %s", cik, e)
        return (None, None)

    recent = payload.get("filings", {}).get("recent", {})
    forms: list[str] = recent.get("form", [])
    accessions: list[str] = recent.get("accessionNumber", [])
    dates: list[str] = recent.get("filingDate", [])
    # SEC returns these as parallel arrays sorted by filingDate desc.
    for form, accession, filing_date in zip(forms, accessions, dates):
        if form == "10-K":
            # accession comes in "0000320193-23-000106" format; strip dashes
            # for URL building.
            return (accession.replace("-", ""), filing_date)
    return (None, None)


def _fetch_risk_factors_text(cik: str, accession_no_dashes: str) -> Optional[str]:
    """Pull the 10-K's primary text document and extract Item 1A Risk Factors.

    The SEC archive layout is:
      https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession}/{accession_with_dashes}.txt

    We use the .txt aggregate filing — easier to parse than the multi-doc
    HTML layout — then carve out the Risk Factors section.
    """
    # Strip leading zeros for the path component
    cik_int = str(int(cik))
    # Re-insert dashes for the document filename
    dashed = (
        accession_no_dashes[:10] + "-" + accession_no_dashes[10:12] + "-"
        + accession_no_dashes[12:]
    )
    url = (
        f"https://www.sec.gov/Archives/edgar/data/{cik_int}/"
        f"{accession_no_dashes}/{dashed}-index.json"
    )
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": _EDGAR_USER_AGENT}
        )
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SEC) as resp:
            index = json.loads(resp.read())
    except Exception as e:
        logger.warning("filings_extractor: index fetch failed: %s", e)
        return None

    # Find the primary 10-K doc (largest .htm or .txt with "10-k" type)
    items = index.get("directory", {}).get("item", [])
    primary_url: Optional[str] = None
    for item in items:
        item_type = (item.get("type") or "").upper()
        name = item.get("name", "")
        if item_type == "10-K" and (name.endswith(".htm") or name.endswith(".html")):
            primary_url = (
                f"https://www.sec.gov/Archives/edgar/data/{cik_int}/"
                f"{accession_no_dashes}/{name}"
            )
            break
    if primary_url is None:
        return None

    try:
        req = urllib.request.Request(
            primary_url, headers={"User-Agent": _EDGAR_USER_AGENT}
        )
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SEC) as resp:
            raw_html = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        logger.warning("filings_extractor: primary doc fetch failed: %s", e)
        return None

    return _extract_risk_factors_section(raw_html)


def _extract_risk_factors_section(html: str) -> Optional[str]:
    """Carve out Item 1A Risk Factors from a 10-K HTML/text blob.

    Strategy: regex-find "Item 1A" and "Item 1B" (or "Item 2") markers,
    return the text between, stripped of HTML tags. Most 10-Ks follow
    this exact heading convention so a simple boundary-marker carve
    works without a full HTML parser.
    """
    # Drop HTML tags (crude but sufficient — we want text, not structure)
    text = re.sub(r"<[^>]+>", " ", html)
    # Collapse whitespace
    text = re.sub(r"\s+", " ", text).strip()

    # Find "Item 1A" — case insensitive, tolerant of period / dot separators
    start_match = re.search(
        r"item\s*1[\s\.\-]*a[\s\.\-:]*risk\s*factors",
        text,
        flags=re.IGNORECASE,
    )
    if start_match is None:
        return None
    start = start_match.end()

    # Find the next section boundary — Item 1B, Item 2, Unresolved Staff
    # Comments are the typical successors.
    end_match = re.search(
        r"item\s*(1[\s\.\-]*b|2[\s\.\-]*(?:propert|description))",
        text[start:],
        flags=re.IGNORECASE,
    )
    end = start + end_match.start() if end_match else len(text)

    section = text[start:end].strip()
    if len(section) > _MAX_RISK_FACTORS_CHARS:
        section = section[:_MAX_RISK_FACTORS_CHARS]
    return section or None


# ─────────────────────────────────────────────────────────────────────────
# Claude extraction
# ─────────────────────────────────────────────────────────────────────────

class ClaudeFilingsClient:
    """Real Anthropic client used to structure risk-factors text.

    Mirrors the ClaudeMarketReadClient pattern — lazy SDK import +
    adaptive thinking + JSON-coerced output."""

    model_id = "claude-opus-4-7"

    def __init__(self, api_key: Optional[str] = None, max_tokens: int = 2000):
        from anthropic import Anthropic
        resolved = api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not resolved:
            raise RuntimeError("ClaudeFilingsClient requires ANTHROPIC_API_KEY")
        self._client = Anthropic(api_key=resolved)
        self._max_tokens = max_tokens

    def complete(self, system: str, user: str) -> str:
        resp = self._client.messages.create(
            model=self.model_id,
            max_tokens=self._max_tokens,
            system=[
                {
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user}],
            thinking={"type": "adaptive"},
            output_config={"effort": "high"},
        )
        parts: list[str] = []
        for block in resp.content:
            if getattr(block, "type", None) == "text":
                parts.append(block.text)
        return "".join(parts).strip()


def _build_default_client() -> Optional[Any]:
    """Build a ClaudeFilingsClient when env is configured."""
    try:
        return ClaudeFilingsClient()
    except Exception as e:
        logger.warning("filings_extractor: client build failed: %s", e)
        return None


_FILINGS_SYSTEM_PROMPT = """You are CFO AI's filings analyst. You receive the Item 1A "Risk Factors" section from a public company's most recent 10-K and your job is to convert it into structured exposure data for our deterministic risk-scoring engine.

STRICT RULES:
1. Extract ONLY what the filing itself says. Do not import outside knowledge about the company.
2. Geographic exposure values must SUM to approximately 1.0 (it's a partition).
3. Supply chain + financial sensitivity values are INDEPENDENT 0–1 intensities — each one represents "how much does this lever pull on the company."
4. Identify 3-6 main risks the management actually highlights. Use their wording for the label.
5. For each risk, choose ONE severity: low / medium / high / critical.
6. For each risk, list the financial impact channels affected. Valid channels are: revenue, gross_margin, ebitda_margin, capex, working_capital, inventory, debt_cost, fx, valuation_multiple, supply_availability.
7. Return ONLY JSON in the exact shape shown below — no markdown fences, no preamble.

OUTPUT FORMAT:
{
  "geographic_exposure": {"us": 0.45, "china": 0.20, "europe": 0.15, ...},
  "supply_chain_exposure": {"semiconductors": 0.8, "energy": 0.5, "shipping": 0.4, ...},
  "financial_sensitivity": {"interest_rates": 0.6, "fx": 0.5, "energy_prices": 0.4, ...},
  "main_risks": [
    {"key": "snake_case_id", "label": "Human-readable label", "severity": "high", "channels": ["revenue", "ebitda_margin"], "explanation": "1 sentence from the filing"}
  ],
  "main_opportunities": [
    {"key": "snake_case_id", "label": "Tailwind label", "severity": "high", "channels": ["revenue"], "explanation": "1 sentence from the filing"}
  ]
}

If the filing is too terse to extract specific numbers, return null exposures (e.g. "geographic_exposure": null) — DO NOT make them up. The engine will fall back to sector defaults for missing dimensions."""


def _extract_via_claude(
    *,
    llm: Any,
    ticker: str,
    company_name: str,
    sector: str,
    industry: Optional[str],
    risk_factors: str,
) -> Optional[dict[str, Any]]:
    """Call the LLM, parse the JSON envelope. Return None on failure."""
    user = (
        f"# {ticker} — {company_name}\n"
        f"Sector: {sector}\n"
        f"Industry: {industry or '(unspecified)'}\n\n"
        f"## Item 1A — Risk Factors (verbatim from latest 10-K)\n"
        f"{risk_factors}\n"
    )
    try:
        raw = llm.complete(_FILINGS_SYSTEM_PROMPT, user)
    except Exception as e:
        logger.warning("filings_extractor LLM call failed for %s: %s", ticker, e)
        return None
    return _parse_filings_envelope(raw)


def _parse_filings_envelope(raw: str) -> Optional[dict[str, Any]]:
    """Tolerant JSON envelope parser — strips code fences + leading prose."""
    if not raw:
        return None
    text = raw.strip()
    if text.startswith("```"):
        first_newline = text.find("\n")
        if first_newline != -1:
            text = text[first_newline + 1:]
        if text.endswith("```"):
            text = text[:-3].rstrip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        return json.loads(text[start: end + 1])
    except json.JSONDecodeError:
        return None


# ─────────────────────────────────────────────────────────────────────────
# Profile assembly
# ─────────────────────────────────────────────────────────────────────────

def _build_profile(
    *,
    ticker: str,
    company_name: str,
    sector: str,
    industry: Optional[str],
    extracted: dict[str, Any],
    filing_date: Optional[str],
) -> CompanyExposureProfile:
    """Turn the LLM-extracted dict → CompanyExposureProfile dataclass.

    Tolerant of partial extractions: any of geographic / supply_chain /
    financial_sensitivity may be None (the LLM was honest about not finding
    the data) — we use {} in that case, and the scoring engine treats
    empty maps as "no signal" rather than "zero everywhere."
    """
    risks: list[RiskRef] = []
    for raw_risk in extracted.get("main_risks") or []:
        if not isinstance(raw_risk, dict):
            continue
        risks.append(RiskRef(
            key=str(raw_risk.get("key", ""))[:80] or "filings_risk",
            label=str(raw_risk.get("label", "Risk identified by filing"))[:160],
            severity=_validate_severity(raw_risk.get("severity")),
            channels=_validate_channels(raw_risk.get("channels") or []),
            explanation=str(raw_risk.get("explanation", ""))[:600],
        ))

    opportunities: list[OpportunityRef] = []
    for raw_opp in extracted.get("main_opportunities") or []:
        if not isinstance(raw_opp, dict):
            continue
        opportunities.append(OpportunityRef(
            key=str(raw_opp.get("key", ""))[:80] or "filings_opportunity",
            label=str(raw_opp.get("label", "Opportunity identified by filing"))[:160],
            severity=_validate_severity(raw_opp.get("severity")),
            channels=_validate_channels(raw_opp.get("channels") or []),
            explanation=str(raw_opp.get("explanation", ""))[:600],
        ))

    return CompanyExposureProfile(
        ticker=ticker,
        company_name=company_name,
        sector=sector,
        industry=industry,
        geographic_exposure=_validate_exposure_map(
            extracted.get("geographic_exposure")
        ),
        supply_chain_exposure=_validate_exposure_map(
            extracted.get("supply_chain_exposure")
        ),
        financial_sensitivity=_validate_exposure_map(
            extracted.get("financial_sensitivity")
        ),
        main_risks=risks,
        main_opportunities=opportunities,
        confidence=FILINGS_CONFIDENCE,
        source="filings",
        last_updated=datetime.now(timezone.utc),
    )


_VALID_SEVERITIES = {"low", "medium", "high", "critical"}
_VALID_CHANNELS = {
    "revenue", "gross_margin", "ebitda_margin", "capex", "working_capital",
    "inventory", "debt_cost", "fx", "valuation_multiple", "supply_availability",
}


def _validate_severity(value: Any) -> str:
    """Map LLM-supplied severity → valid enum, defaulting to medium."""
    if isinstance(value, str) and value.lower() in _VALID_SEVERITIES:
        return value.lower()
    return "medium"


def _validate_channels(values: Any) -> list[str]:
    """Drop any channel the LLM hallucinated outside the valid set."""
    if not isinstance(values, list):
        return []
    return [v for v in values if isinstance(v, str) and v in _VALID_CHANNELS]


def _validate_exposure_map(value: Any) -> dict[str, float]:
    """Normalize a {key: number} map. Drops non-numeric entries."""
    if not isinstance(value, dict):
        return {}
    cleaned: dict[str, float] = {}
    for k, v in value.items():
        if not isinstance(k, str):
            continue
        if isinstance(v, (int, float)) and 0 <= v <= 1.5:
            cleaned[k] = float(v)
    return cleaned


# ─────────────────────────────────────────────────────────────────────────
# Test helpers
# ─────────────────────────────────────────────────────────────────────────

def _reset_cik_cache() -> None:
    """Drop the in-process CIK map — used by tests to inject fixtures."""
    global _TICKER_TO_CIK_CACHE
    _TICKER_TO_CIK_CACHE = None
