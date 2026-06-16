"""Public-company-specific exception hierarchy.

Each error carries a §24-compliant user-facing message that the FE can show
verbatim — never raw stack traces, never technical jargon. The `code`
attribute is the stable identifier the FE uses to switch on; the `message`
is the human copy.

The router (engine/public/routes.py) translates each of these to an HTTP
status + JSON envelope:
  NasdaqKeyMissing       → 503 (service unavailable — operator hasn't
                                set NASDAQ_API_KEY on the VPS)
  NasdaqEntitlementError → 402 (subscription required — operator's
                                Nasdaq key lacks SF1/DAILY entitlement)
  NasdaqNotFound         → 404 (ticker not found in Sharadar)
  NasdaqRateLimited      → 429 (Retry-After header forwarded)
  NasdaqPartialData      → NOT raised — used as a flag on the envelope
                                (some fields unavailable from Sharadar
                                for this ticker / period combination)
  NasdaqError            → 502 (catch-all upstream error)
"""

from __future__ import annotations

from typing import Any, Dict, Optional


class NasdaqError(Exception):
    """Base for all Nasdaq adapter errors. Don't raise this directly."""

    code: str = "nasdaq_error"
    user_message: str = "Nasdaq request failed."
    http_status: int = 502

    def __init__(self, message: Optional[str] = None, *, details: Optional[Dict[str, Any]] = None):
        super().__init__(message or self.user_message)
        self.details = details or {}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "code": self.code,
            "message": self.user_message,
            "details": self.details,
        }


class NasdaqKeyMissing(NasdaqError):
    """NASDAQ_API_KEY not set in environment.

    The adapter constructor doesn't raise — it sets `available = False`. The
    router raises this when an /api/public/* endpoint is hit without a key.
    """

    code = "nasdaq_key_missing"
    user_message = "Nasdaq API key is not configured."
    http_status = 503


class NasdaqEntitlementError(NasdaqError):
    """Operator's Nasdaq key lacks subscription for the requested dataset.

    Triggered by Nasdaq's 403 on SF1 or DAILY datatables for non-subscribed
    accounts. Distinct from auth failure (which is 401 → NasdaqKeyMissing).
    """

    code = "nasdaq_entitlement_missing"
    user_message = "Your Nasdaq subscription does not include this dataset."
    http_status = 402


class NasdaqNotFound(NasdaqError):
    """Ticker not found in Sharadar TICKERS table (or no rows for SF1/DAILY)."""

    code = "nasdaq_not_found"
    user_message = "No matching public company found. Try ticker or company name."
    http_status = 404


class NasdaqRateLimited(NasdaqError):
    """Hit Nasdaq's per-day or per-second rate limit.

    `retry_after_seconds` is forwarded from the response header (or estimated
    from the budget guard's local counter when the cap is local-only).
    """

    code = "nasdaq_rate_limited"
    user_message = "Nasdaq rate limit reached. Try again later."
    http_status = 429

    def __init__(self, message: Optional[str] = None, *, retry_after_seconds: Optional[int] = None, details: Optional[Dict[str, Any]] = None):
        super().__init__(message, details=details)
        self.retry_after_seconds = retry_after_seconds


class NasdaqPartialData(NasdaqError):
    """Some requested fields are unavailable from Sharadar for this ticker/period.

    Not raised in the normal flow — surfaced as a flag on the assembled
    envelope so the FE can show the §24 "some fields unavailable" notice
    without failing the whole sync.
    """

    code = "nasdaq_partial_data"
    user_message = "Some fields are unavailable from Nasdaq for this company."
    http_status = 200  # not an error to the client — informational flag
