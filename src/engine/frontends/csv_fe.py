"""CSV front-end — the delimited-text transport of the deterministic
trial-balance parser.

Thin shell over the shared machinery in `saga10`, dispatching through
`parse_trial_balance_csv` (encoding fallback chain + delimiter sniff +
the same structure detection as XLSX). `csv` is a TRANSPORT id, not a
layout id: the parser still detects the layout (`saga_10_col`,
`saga_compact_6_col`, `generic_4_col`) and stamps it in
`extraction.source_format` — the built LedgerDoc follows the DETECTED
layout, so no format-mismatch diagnostic is raised here.
"""
from __future__ import annotations

from typing import Any

from .saga10 import _DeterministicTbFrontEnd


__all__ = ["CsvFrontEnd"]


class CsvFrontEnd(_DeterministicTbFrontEnd):
    format_id = "csv"

    def _parse_legacy(self, data: bytes, filename: str) -> Any:
        from engine.country_packs.ro_romania.trial_balance_parser import (
            parse_trial_balance_csv,
        )
        return parse_trial_balance_csv(data, filename)
