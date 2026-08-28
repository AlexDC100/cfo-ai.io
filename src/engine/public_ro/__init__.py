# Public Romanian company data spine (Lane 1, public-data acquisition
# engine).
#
# Sources (verified live, 2026-08):
#   - data.gov.ro CKAN, org "mfp": one dataset per fiscal year
#     FY2008-FY2025, slug situatii_financiare_<YEAR> (2023 exception:
#     situatii_financiare2023; plus situatii_financiare_2024_actualizat).
#     Mass files WEB_UU_AN<yr>.txt (~800K rows/yr) + WEB_BL_BS_SL_AN<yr>.txt
#     (~77K rows/yr): comma-separated ASCII, header CUI,CAEN,I1..I20, CRLF,
#     empty=missing, whole-RON ints (can be negative), no name/county
#     columns. The same-named companion .csv is the COLUMN SPEC
#     (label;code semicolon pairs), not data.
#   - date_de_identificare_platitori June snapshots (name/county/PJ join),
#     2026 format: caret(^)-delimited ISO-8859-2, TIP_CONTRIB PJ|PF.
#   - ANAF v9 per-CUI API (secondary, current-state only, hard 1 rps).
#
# Storage: a SEPARATE SQLite file data/public_ro.db (backend_data
# volume) — NEVER engine.db (lock contention), NEVER Supabase (~7.5M
# company-year rows). Indicators are exact INTEGER whole RON.
#
# The public_summary envelope kind produced here NEVER rides
# canonical_bs, never enters MACHINE_STATUSES, packs, reconcile, or
# consensus — it is a parallel, provenance-first public-data surface.
#
# ZERO anthropic imports anywhere in this package (deterministic by
# construction; the PUBLIC_AI_NARRATIVE seam lives in the serving lanes).
from __future__ import annotations
