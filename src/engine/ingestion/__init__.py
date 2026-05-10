"""Ingestion subpackage — column mapping + flexible CSV/Excel parsing.

Exposes `column_mapper.map_headers` so the upload pipeline can accept files
with varied English column conventions (NIV / Net Sales / Revenue /
Turnover, etc.) without hand-coded brittle parsers.

The legacy `loader.py` still drives the calibrated Excel pivot used at
seed time; new uploads should run through `column_mapper` first to
normalize headers, then through a generic row reader.
"""
from .column_mapper import (
    ColumnMapping,
    map_headers,
    SUPPORTED_FIELDS,
    HEADER_ALIASES,
)

__all__ = ["ColumnMapping", "map_headers", "SUPPORTED_FIELDS", "HEADER_ALIASES"]
