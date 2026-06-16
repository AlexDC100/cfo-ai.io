"""F4.1 canonical schema layer — country-agnostic financial statement
representation that every country pack adapts to.

Per `CANONICAL_SCHEMA_V1.md` (F4.0 design artifact):
  · 79 Balance Sheet leaf buckets across 26 parent aggregates
  · 55 P&L leaf buckets across 9 parent aggregates
  · 25 Cash Flow leaf buckets across 3 parent aggregates
  · Always-positive magnitudes with explicit sign_meaning metadata
  · Wide-grained (~30 BS / ~20 PL floor; more allowed when cross-standard
    discipline surfaces real economic distinctions — operator decision 3a)

The country pack adapters (e.g. `country_packs/ro_romania/canonical_adapter.py`)
read pack-specific outputs (RAS line_items, IFRS reclassified statements,
etc.) and produce the canonical representation defined here. The
methodology layer (F4.2, YAML files at `methodology/`) reads canonical
and produces named methodology views (EBITDA variants, ratios, etc.).
"""
from .schema_v1 import (
    CanonicalBucket,
    BucketType,
    SignMeaning,
    BS_BUCKETS,
    PL_BUCKETS,
    CF_BUCKETS,
    ALL_BUCKETS,
    PARENT_AGGREGATES_BS,
    PARENT_AGGREGATES_PL,
    PARENT_AGGREGATES_CF,
    bucket_by_name,
    leaves_for_aggregate,
    schema_version,
)

__all__ = [
    "CanonicalBucket",
    "BucketType",
    "SignMeaning",
    "BS_BUCKETS",
    "PL_BUCKETS",
    "CF_BUCKETS",
    "ALL_BUCKETS",
    "PARENT_AGGREGATES_BS",
    "PARENT_AGGREGATES_PL",
    "PARENT_AGGREGATES_CF",
    "bucket_by_name",
    "leaves_for_aggregate",
    "schema_version",
]
