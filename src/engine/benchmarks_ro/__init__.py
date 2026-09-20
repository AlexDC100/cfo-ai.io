"""Romanian sourced sector benchmarks — Ministry of Finance annual
filings (open data, data.gov.ro, CC-BY-4.0), aggregated per CAEN class x
size band. No figure without source, year and n; n < MIN_PEERS says
"insufficient peers"; absent is never zero; unsupported ratios refuse.

Public API: load_dataset, lookup, size_band_for, check_law.
The builder lives in ``build`` and is driven by
scripts/build_ro_sector_benchmarks.py.
"""
from .definitions import (MIN_PEERS, RATIOS, REFUSED_RATIOS, SIZE_BANDS,
                          normalize_caen, size_band_key, source_label)
from .dataset import (DatasetLawError, check_law, load_dataset, lookup,
                     size_band_for, validate)

__all__ = [
    "MIN_PEERS", "RATIOS", "REFUSED_RATIOS", "SIZE_BANDS",
    "DatasetLawError", "check_law", "load_dataset", "lookup",
    "normalize_caen", "size_band_for", "size_band_key", "source_label",
    "validate",
]
