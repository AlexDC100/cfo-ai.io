"""Country-agnostic engine core.

This package holds the universal financial-engine surfaces that any
country accounting pack plugs into:

  - `country_pack`   — the `CountryAccountingPack` Protocol every pack
                       implements (F3.1 interface).
  - `country_pack_registry` — registry mapping country code to pack
                       instance, populated at import time.

Country-specific behaviour (RAS chart of accounts, OMFP-1802 row maps,
SAGA layout detection, RON formatting, etc.) lives under
`engine.country_packs.<country>/` and is reached via the interface
defined here. `engine.api.*` (the existing FastAPI surface) consumes
that interface for any decision that depends on the source country.

F3.1 status — interface created, registry empty.
"""
