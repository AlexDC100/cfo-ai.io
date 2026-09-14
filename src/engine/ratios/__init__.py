"""Serve-time ratio authority.

`table` — one period's ratio table (values, quantized values, pack bands,
band status, census and coverage) computed from that period's SERVED
payload. Pure: no I/O, no clock.
"""
from __future__ import annotations

from .table import (
    BAND_STATUSES,
    CENSUS,
    DISPLAY_DIGITS,
    REASON_CODES,
    SECTOR_CALIBRATED_RATIOS,
    TABLE_VERSION,
    build_ratio_table,
    quantize_display,
    ratio_table_json,
)

__all__ = [
    "BAND_STATUSES",
    "CENSUS",
    "DISPLAY_DIGITS",
    "REASON_CODES",
    "SECTOR_CALIBRATED_RATIOS",
    "TABLE_VERSION",
    "build_ratio_table",
    "quantize_display",
    "ratio_table_json",
]
