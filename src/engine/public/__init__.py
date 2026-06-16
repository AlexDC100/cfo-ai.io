# Public-company analysis pipeline.
#
# Parallel to the RO trial-balance path in `engine/api/` and the country-pack
# adapters in `engine/country_packs/`. Where that path takes a parsed balanță
# de verificare and routes it through detection/confidence/normalization to
# `assembled_canonical_v1`, this module takes a public-company ticker, fetches
# fundamentals from a market-data provider (Nasdaq Data Link / Sharadar SF1 in
# v1), normalizes US-GAAP line items to the SAME `assembled_canonical_v1`
# shape, and persists the result alongside private periods so every existing
# downstream consumer (PLStatementView, ratios engine, valuation, benchmark
# peer comparison, CFO chat) works unchanged.
#
# Design contract: the public-company surface NEVER mixes with the private
# trial-balance pipeline. They share output schema (assembled_canonical_v1)
# and DB partition (`public_company_periods` table), but every code path that
# routes RO trial balances (RO pack confidence routing, F3.13 calibration,
# F-A3.1 BS-drift gates) is untouched. The split is enforced at the API
# boundary: /api/public/* hits this module; /api/periods/* hits the existing
# private path.
#
# Layout:
#   adapter.py    — NasdaqAdapter HTTP client (Sharadar SF1 + DAILY + TICKERS)
#   cache.py      — DB-backed nasdaq_responses cache for raw payload reuse
#   errors.py     — Public-company-specific exception classes (§24-aligned)
#   normalizer.py — SF1 + DAILY → assembled_canonical_v1 (NASDAQ-4)
#   pipeline.py   — ticker × dimension → DB row + envelope (NASDAQ-5)
#   routes.py     — FastAPI router for /api/public/* endpoints (NASDAQ-6)

from .adapter import NasdaqAdapter
from .errors import (
    NasdaqEntitlementError,
    NasdaqError,
    NasdaqKeyMissing,
    NasdaqNotFound,
    NasdaqPartialData,
    NasdaqRateLimited,
)

__all__ = [
    "NasdaqAdapter",
    "NasdaqError",
    "NasdaqKeyMissing",
    "NasdaqEntitlementError",
    "NasdaqNotFound",
    "NasdaqPartialData",
    "NasdaqRateLimited",
]
