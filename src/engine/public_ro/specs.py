"""i-code resolution from the companion spec .csv, per (year, family).

VERIFIED DRIFT TRAP (live research, 2026-08): the I-codes in the
data.gov.ro bilanț files are POSITIONAL per (year, file family).
FY2019-FY2025 use one stable 20-indicator layout (both WEB_UU and
WEB_BL_BS_SL), but FY2015 BL_BS_SL had 21 indicators ("Patrimoniul
public" inserted at i13, shifting everything after it) while FY2015 UU
had only 19 — and the FY2015 UU spec carries a label TYPO ("Pierdere
neta;i16" where "Pierdere bruta" is meant). 2016-2018 specs are
unverified. Therefore the layout is NEVER hard-coded: every ingest
resolves source I-codes to the canonical FY2019-25 semantic vocabulary
from the companion spec csv, and a year+family whose spec cannot be
FULLY resolved is REFUSED with a typed error (never guessed).

Spec file format: one "label;code" pair per line, semicolon-delimited
(e.g. "Cifra de afaceri neta;I13"). Identity columns (CUI, CAEN,
CAENO) are passed through, not indicators.

Canonical vocabulary = the verified FY2019-FY2025 layout:
  i1  Active imobilizate — total     i11 Capital subscris varsat
  i2  Active circulante — total      i12 Patrimoniul regiei
  i3  Stocuri                        i13 Cifra de afaceri neta
  i4  Creante                        i14 Venituri totale
  i5  Casa si conturi la banci       i15 Cheltuieli totale
  i6  Cheltuieli in avans            i16 Profit brut
  i7  Datorii                        i17 Pierdere bruta
  i8  Venituri in avans              i18 Profit net
  i9  Provizioane                    i19 Pierdere neta
  i10 Capitaluri — total             i20 Numar mediu de salariati
  i21 Patrimoniul public (FY2015-BL-only extra slot)

Note: there is NO separate "capitaluri proprii" column — i10 is
CAPITALURI TOTAL. "Active totale" is computed (i1+i2+i6), not a column.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Dict, List, Tuple


class SpecResolutionError(ValueError):
    """A spec csv could not be fully, unambiguously resolved to the
    canonical vocabulary — the year+family MUST NOT be ingested."""

    def __init__(self, year: int, family: str, detail: str) -> None:
        super().__init__(
            "spec for FY%s family %s cannot be resolved: %s"
            % (year, family, detail)
        )
        self.year = year
        self.family = family
        self.detail = detail


#: Canonical semantic codes, keyed by NORMALIZED label (see
#: normalize_label). Multiple surface labels may map to one code
#: (diacritic/abbreviation tolerance), but one spec may never assign
#: the same canonical code twice (enforced in resolve_spec).
CANONICAL_LABELS: Dict[str, str] = {
    "active imobilizate total": "i1",
    "active imobilizate": "i1",
    "active circulante total": "i2",
    "active circulante": "i2",
    "stocuri": "i3",
    "creante": "i4",
    "casa si conturi la banci": "i5",
    "cheltuieli in avans": "i6",
    "datorii": "i7",
    "datorii total": "i7",
    "venituri in avans": "i8",
    "provizioane": "i9",
    "capitaluri total": "i10",
    "capitaluri": "i10",
    "capital subscris varsat": "i11",
    # FY2015 UU labels the paid-in-capital line just "Capital".
    "capital": "i11",
    "patrimoniul regiei": "i12",
    "cifra de afaceri neta": "i13",
    "venituri totale": "i14",
    "cheltuieli totale": "i15",
    "profit brut": "i16",
    "pierdere bruta": "i17",
    "profit net": "i18",
    "pierdere neta": "i19",
    "numar mediu de salariati": "i20",
    "numarul mediu de salariati": "i20",
    # FY2015 BL_BS_SL inserted this extra indicator at source i13.
    "patrimoniul public": "i21",
}

#: Identity (non-indicator) columns present in specs and data headers.
IDENTITY_LABELS = frozenset({"cui", "caen", "caeno", "an"})

#: Canonical concepts that MUST resolve for a year+family to be
#: ingestable — the minimum an honest public summary needs.
REQUIRED_CANONICAL = frozenset(
    {"i1", "i2", "i7", "i10", "i13", "i14", "i15", "i18", "i19", "i20"}
)

_DIACRITIC_MAP = str.maketrans(
    {
        "ă": "a", "â": "a", "î": "i", "ș": "s", "ş": "s", "ț": "t",
        "ţ": "t", "Ă": "a", "Â": "a", "Î": "i", "Ș": "s", "Ş": "s",
        "Ț": "t", "Ţ": "t",
    }
)


def normalize_label(label: str) -> str:
    """Lowercase, strip Romanian diacritics (both comma- and
    cedilla-form), drop punctuation, collapse whitespace."""
    text = unicodedata.normalize("NFC", label or "").translate(_DIACRITIC_MAP)
    text = text.lower()
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_spec(text: str) -> List[Tuple[str, str]]:
    """Parse a companion spec csv into ordered (label, source_code)
    pairs. Lines without a semicolon are ignored (blank/BOM/noise);
    codes are upper-cased (specs vary between i13 and I13)."""
    pairs: List[Tuple[str, str]] = []
    for raw_line in (text or "").replace("﻿", "").splitlines():
        line = raw_line.strip()
        if not line or ";" not in line:
            continue
        label, _, code = line.partition(";")
        label = label.strip()
        code = code.strip().rstrip(";").upper()
        if not label or not code:
            continue
        pairs.append((label, code))
    return pairs


def _repair_duplicate_pierdere_neta(
    resolved: List[Tuple[str, str, str]], year: int, family: str
) -> List[Tuple[str, str, str]]:
    """The verified FY2015 UU spec typo: "Pierdere neta" appears TWICE
    and "Pierdere bruta" is absent; the FIRST occurrence (the one that
    positionally follows "Profit brut") is actually Pierdere bruta.
    Repair deterministically ONLY in that exact configuration."""
    canon_codes = [c for _, _, c in resolved]
    if canon_codes.count("i19") == 2 and "i17" not in canon_codes:
        first_idx = canon_codes.index("i19")
        label, source, _ = resolved[first_idx]
        # Sanity: the repaired slot must directly follow Profit brut.
        if first_idx > 0 and resolved[first_idx - 1][2] == "i16":
            resolved[first_idx] = (label, source, "i17")
    return resolved


def resolve_spec(text: str, *, year: int, family: str) -> Dict[str, str]:
    """Resolve a companion spec csv to {SOURCE_CODE -> canonical_code}
    (e.g. {"I13": "i13"} for FY2024, {"I14": "i13"} for FY2015 BL).

    Raises SpecResolutionError when: the spec is empty, any indicator
    label is unrecognized, a canonical code would be assigned twice
    (after the documented FY2015-UU typo repair), or any REQUIRED
    canonical concept is missing. Refusal, never guessing — this is
    the gate that keeps unverified years (2016-2018) out until their
    specs actually resolve."""
    pairs = parse_spec(text)
    if not pairs:
        raise SpecResolutionError(year, family, "spec file is empty")

    resolved: List[Tuple[str, str, str]] = []  # (label, source, canonical)
    for label, source_code in pairs:
        norm = normalize_label(label)
        if norm in IDENTITY_LABELS:
            continue
        canonical = CANONICAL_LABELS.get(norm)
        if canonical is None:
            raise SpecResolutionError(
                year,
                family,
                "unrecognized indicator label %r (normalized %r) at "
                "source code %s" % (label, norm, source_code),
            )
        resolved.append((label, source_code, canonical))

    resolved = _repair_duplicate_pierdere_neta(resolved, year, family)

    mapping: Dict[str, str] = {}
    seen_canonical: Dict[str, str] = {}
    for label, source_code, canonical in resolved:
        if source_code in mapping:
            raise SpecResolutionError(
                year, family, "source code %s appears twice" % source_code
            )
        if canonical in seen_canonical:
            raise SpecResolutionError(
                year,
                family,
                "canonical %s assigned to both %s and %s"
                % (canonical, seen_canonical[canonical], source_code),
            )
        mapping[source_code] = canonical
        seen_canonical[canonical] = source_code

    missing = REQUIRED_CANONICAL - set(seen_canonical)
    if missing:
        raise SpecResolutionError(
            year,
            family,
            "required canonical concepts unresolved: %s"
            % ", ".join(sorted(missing)),
        )
    return mapping
