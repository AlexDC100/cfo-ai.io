"""Flexible column mapping for uploaded workbooks (English only).

A user uploads a sheet with headers in their own convention
("NIV", "Net Sales", "Revenue", "Turnover") and we map each one to the
canonical engine field (`sales_value`, `volume_tons`, `gross_margin_pct`, …).

The mapper is intentionally rule-based, not LLM-based:
  - Deterministic: same input always produces the same mapping.
  - Auditable: the user sees exactly which header matched which field, and
    can override before classification runs.
  - Cheap: zero-cost in tests and CI.

If a header doesn't match any alias, it's left unmapped and the caller
either prompts the user or rejects the upload with a clear error.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence


# Canonical fields the engine consumes. Names mirror models.SkuRow / CategoryRow.
SUPPORTED_FIELDS = (
    "sku",
    "sku_name",
    "category",
    "supplier",
    "customer",
    "channel",
    "sales_value",         # NIV / Revenue / Net Sales
    "sales_volume",        # Volume / Tons / Quantity
    "cogs",
    "gross_margin_value",
    "gross_margin_pct",
    "avg_inventory_value",
    "dio_days",
    "dso_days",
    "dpo_days",
    "ccc_days",
    "woca_kron",
)


# Each canonical field lists every header we recognize, lowercased and
# whitespace-collapsed. New aliases are cheap to add.
HEADER_ALIASES: Dict[str, List[str]] = {
    "sku": [
        "sku", "product code", "code", "item", "item code", "article",
        "article code", "part number",
    ],
    "sku_name": [
        "product", "product name", "name", "description", "title",
        "item description",
    ],
    "category": [
        "category", "product group", "group", "department", "class",
        "product class", "subcategory",
    ],
    "supplier": [
        "supplier", "vendor", "manufacturer",
    ],
    "customer": [
        "customer", "client", "buyer", "account",
    ],
    "channel": [
        "channel", "sales channel", "distribution channel",
    ],
    "sales_value": [
        "niv", "revenue", "sales", "net sales", "net revenue", "turnover",
        "sales value", "gross revenue", "gross sales",
    ],
    "sales_volume": [
        "volume", "tons", "tonnes", "kg", "kilograms", "quantity",
        "qty", "units", "units sold",
    ],
    "cogs": [
        "cogs", "cost", "cost of goods", "cost of goods sold",
        "cost of sales", "unit cost",
    ],
    "gross_margin_value": [
        "gross margin", "gm", "margin value", "direct margin",
        "gross profit",
    ],
    "gross_margin_pct": [
        "gm%", "gross margin %", "gross margin pct", "margin %",
        "gm pct", "gross margin percent", "gross margin percentage",
        "margin percent", "margin percentage",
    ],
    "avg_inventory_value": [
        "avg inventory", "average inventory", "average stock",
        "inventory value", "stock value", "inventory",
    ],
    "dio_days": [
        "dio", "days inventory outstanding", "days in inventory",
        "dio days", "inventory days",
    ],
    "dso_days": [
        "dso", "days sales outstanding", "dso days", "receivables days",
    ],
    "dpo_days": [
        "dpo", "days payable outstanding", "dpo days", "payables days",
    ],
    "ccc_days": [
        "ccc", "cash conversion cycle", "ccc days",
    ],
    "woca_kron": [
        "woca", "working capital cost", "wc cost",
    ],
}


@dataclass(frozen=True)
class ColumnMapping:
    """Result of `map_headers` — what each input header was mapped to.

    `mapped[input_header] = canonical_field` for every header we matched.
    `unmatched` contains headers we couldn't place; the caller decides
    whether to prompt the user, accept the gap, or reject the upload.
    `missing_required` lists canonical fields that no header maps to and
    that the caller marked as required.
    """
    mapped: Dict[str, str]
    unmatched: List[str]
    missing_required: List[str]


def _normalize(header: str) -> str:
    return " ".join(header.strip().lower().split())


def map_headers(
    headers: Sequence[str],
    *,
    required: Optional[Sequence[str]] = None,
    overrides: Optional[Dict[str, str]] = None,
) -> ColumnMapping:
    """Map an arbitrary set of headers to canonical engine fields.

    Args:
        headers: the column headers as they appear in the uploaded file.
        required: canonical field names that MUST resolve. If any aren't
            mapped, they appear in `missing_required`.
        overrides: per-header forced mappings (`{input_header: canonical}`)
            — used by the UI when the user manually corrects a guess.

    Order of precedence per header:
        1. Explicit override
        2. Exact alias match (case- and whitespace-insensitive)
        3. Substring match against any alias (e.g. "Net Sales 2025" → sales_value)
    """
    overrides = overrides or {}
    required = required or ()

    # Build reverse index: alias → canonical
    alias_to_field: Dict[str, str] = {}
    for field, aliases in HEADER_ALIASES.items():
        for alias in aliases:
            alias_to_field[_normalize(alias)] = field

    mapped: Dict[str, str] = {}
    unmatched: List[str] = []

    for h in headers:
        if h in overrides:
            mapped[h] = overrides[h]
            continue

        norm = _normalize(h)
        # Exact match first
        if norm in alias_to_field:
            mapped[h] = alias_to_field[norm]
            continue

        # Substring match — header CONTAINS an alias (handles "Net Sales 2025")
        match: Optional[str] = None
        # Prefer the longest matching alias to avoid 'gm' winning over 'gm%'
        candidates = sorted(alias_to_field.keys(), key=len, reverse=True)
        for alias in candidates:
            # Bound the alias with word edges where possible — avoid 'cost'
            # accidentally matching 'cost center'.
            if alias in norm and (alias == norm or any(
                norm.startswith(alias + sep) or norm.endswith(sep + alias)
                or (sep + alias + sep) in (sep + norm + sep)
                for sep in (" ", "_", "-", ".", "/")
            )):
                match = alias_to_field[alias]
                break
        if match:
            mapped[h] = match
        else:
            unmatched.append(h)

    mapped_fields = set(mapped.values())
    missing_required = [f for f in required if f not in mapped_fields]

    return ColumnMapping(
        mapped=mapped,
        unmatched=unmatched,
        missing_required=missing_required,
    )
