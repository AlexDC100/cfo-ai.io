"""F3.1 — Country-pack registry.

Single source of truth for which country packs are loaded into this
engine instance. Packs self-register at import time via
`register_pack(...)`. The orchestrator (`engine.api.pipeline`) calls
`get_pack(country_code)` to dispatch country-specific behaviour.

Lookup is case-insensitive on the ISO 3166-1 alpha-2 code ("ro" / "RO"
both resolve to the Romania pack).

# F3.1 status
Registry exists, no pack registered yet. F3.1b registers the Romania
pack as a thin delegating wrapper around the existing `_ro_coa.py` /
`_trial_balance_parser.py` / `_valuation.py` modules; F3.1c switches
the pipeline to use the registry for dispatch; F3.1d/e move data
into the pack and remove the legacy direct-import paths.
"""
from __future__ import annotations

from threading import RLock
from typing import Dict, List, Optional

from .country_pack import CountryAccountingPack


_LOCK = RLock()
_PACKS: Dict[str, CountryAccountingPack] = {}


def register_pack(pack: CountryAccountingPack) -> None:
    """Register a country pack. Idempotent — re-registering the same
    `country_code` is allowed (replaces the previous instance), which
    keeps hot-reload workflows simple.
    """
    code = pack.country_code.upper()
    if not isinstance(pack, CountryAccountingPack):
        raise TypeError(
            f"register_pack({code}): object does not satisfy "
            f"CountryAccountingPack Protocol."
        )
    with _LOCK:
        _PACKS[code] = pack


def get_pack(country_code: str) -> Optional[CountryAccountingPack]:
    """Look up a registered pack by ISO 3166-1 alpha-2 code. Returns
    None if no pack is registered for that country — caller decides
    whether to fall back to Review Mode (F3.4) or fail.
    """
    if not country_code:
        return None
    with _LOCK:
        return _PACKS.get(country_code.upper())


def require_pack(country_code: str) -> CountryAccountingPack:
    """Lookup helper that raises `KeyError` when no pack matches. Used
    by code paths that are known to be country-scoped (e.g. processing
    a trial balance that has already been classified).
    """
    pack = get_pack(country_code)
    if pack is None:
        raise KeyError(
            f"No country pack registered for {country_code!r}. "
            f"Available: {sorted(_PACKS.keys())}"
        )
    return pack


def registered_country_codes() -> List[str]:
    """Snapshot of currently-registered country codes, sorted alpha."""
    with _LOCK:
        return sorted(_PACKS.keys())


def all_packs() -> List[CountryAccountingPack]:
    """Snapshot of every registered pack — used by the F3.3 upload-
    classifier to ask each pack for a detection confidence score.
    """
    with _LOCK:
        return list(_PACKS.values())


def assert_at_least_one_registered() -> None:
    """Startup gate (F3.1e): refuse to serve if no country pack
    registered. Catches the failure mode where the
    `engine.country_packs.<country>` subpackage failed to import
    silently and the engine would otherwise run with zero coverage.
    """
    with _LOCK:
        if not _PACKS:
            raise RuntimeError(
                "No country accounting pack registered. The engine "
                "cannot process trial balances without at least one "
                "pack. Check that engine.country_packs.<country> "
                "imports cleanly at startup."
            )
