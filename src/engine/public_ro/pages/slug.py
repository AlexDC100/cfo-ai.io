"""Company URL keys: ``/companii/{cui}-{slug}`` parse + canonicalize.

The slug vocabulary itself (diacritic folding, ASCII fold) is owned by
``engine.public_ro.seo.slugify`` — lane 4 landed it first, so this module
re-exports it instead of growing a second, drifting implementation.
A wrong or missing slug 301s to the canonical form (router.py); this
module only decides *what* the canonical form is.
"""
from __future__ import annotations

import re
from typing import Optional, Tuple

from engine.public_ro.seo import company_path, slugify

__all__ = ["slugify", "company_path", "parse_company_key", "canonical_slug"]

# CUI is a bare integer, 1..10 digits (Romanian fiscal codes; leading
# "RO" VAT prefix never appears in our URLs). Slug part is optional so
# /companii/123 parses and can be redirected to /companii/123-<slug>.
_KEY_RE = re.compile(r"^(\d{1,10})(?:-(.*))?$")


def parse_company_key(key: str) -> Optional[Tuple[int, Optional[str]]]:
    """``"123-foo-bar"`` -> ``(123, "foo-bar")``; ``"123"`` -> ``(123, None)``;
    anything else -> None (router turns that into a real 404)."""
    m = _KEY_RE.match(key or "")
    if not m:
        return None
    cui = int(m.group(1))
    if cui <= 0:
        return None
    return cui, m.group(2)


def canonical_slug(name: Optional[str]) -> str:
    """Slug for a company name; bounded so URLs stay sane for very long
    legal names. Falls back to a stable token when the name is missing
    (identification join not run yet)."""
    s = slugify(name or "")
    if not s or s == "x":
        return "companie"
    return s[:60].rstrip("-")
