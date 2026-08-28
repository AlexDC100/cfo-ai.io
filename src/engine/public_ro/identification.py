"""Identification-snapshot ingestion — the name/county/PJ join.

Source: data.gov.ro dataset ``date_de_identificare_platitori`` (June
snapshots 2018-2026). The 2026 format (verified live): TWO
caret(^)-delimited files A/B with a header row, ISO-8859-2/CP1250
encoding (NOT UTF-8 — diacritics corrupt if read as UTF-8), CRLF,
~2.6M rows including ~423K PF (natural persons). It is a
CURRENT-STATE snapshot — no historical names.

This wave supports the caret 2026 format ONLY. Older snapshot years
use per-county comma CSVs (≤2020) or ZIPs (2023/24) with different
schemas — those are refused with a notice, never guessed at.

PS7 AT INGESTION (belt and braces):
  - Only ``Sediu central`` rows are considered (subunits skipped).
  - TIP_CONTRIB == PF rows are COUNTED then DISCARDED — a natural
    person's data NEVER enters the store, not even unpublishable.
  - TIP_CONTRIB == PJ rows upsert into ``companies``; publishable=1
    only when the trade-register series is J (company) or C
    (cooperative). An F-series register (PFA/II/IF — measured: 200,630
    of 201,719 PF rows with a register number are F-series) forces
    publishable=0 ALWAYS, even on a PJ-marked row.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from .store import PublicRoStore


class IdentificationFormatError(RuntimeError):
    """The file is not the caret-delimited 2026-format snapshot."""


#: Columns this ingester requires from the caret header (the full 2026
#: header has ~62 columns; we read by name, order-independent).
REQUIRED_COLUMNS = frozenset(
    {
        "COD_FISCAL", "DENUMIRE", "TIP_UNITATE", "TIP_CONTRIB",
        "LOCALITATE", "JUDET", "JUDET_COMERT", "NR_COMERT", "AN_COMERT",
    }
)

ENCODING = "iso-8859-2"


def _register_series(judet_comert: str) -> Optional[str]:
    """Leading letter of the trade-register county code ('J40' -> 'J',
    'F12' -> 'F', 'C..' -> 'C'). None when there is no register."""
    text = (judet_comert or "").strip().upper()
    return text[0] if text and text[0].isalpha() else None


def _reg_number(row: Dict[str, str]) -> Optional[str]:
    judet = (row.get("JUDET_COMERT") or "").strip()
    nr = (row.get("NR_COMERT") or "").strip()
    an = (row.get("AN_COMERT") or "").strip()
    if not judet or not nr:
        return None
    return "%s/%s/%s" % (judet, nr, an) if an else "%s/%s" % (judet, nr)


def ingest_identification(
    store: PublicRoStore,
    data_bytes: bytes,
    *,
    source_label: str,
) -> Dict[str, int]:
    """Ingest one caret-delimited snapshot file (2026 format). Returns
    counts: rows, pj_upserted, pf_discarded, non_sediu_skipped,
    pj_f_series_unpublishable."""
    try:
        text = data_bytes.decode(ENCODING)
    except UnicodeDecodeError as exc:
        raise IdentificationFormatError(
            "file does not decode as %s: %s" % (ENCODING, exc)
        )
    lines = text.splitlines()
    if not lines:
        raise IdentificationFormatError("empty file")
    header_line = lines[0]
    if "^" not in header_line:
        raise IdentificationFormatError(
            "no caret delimiter in header — this looks like a pre-2026 "
            "snapshot format (per-county comma CSVs / ZIPs), which this "
            "wave refuses rather than misreads; use the June-2026 A/B "
            "caret files"
        )
    header = [h.strip().upper() for h in header_line.split("^")]
    missing = REQUIRED_COLUMNS - set(header)
    if missing:
        raise IdentificationFormatError(
            "header lacks required columns: %s" % ", ".join(sorted(missing))
        )
    idx = {name: header.index(name) for name in header}

    counts = {
        "rows": 0,
        "pj_upserted": 0,
        "pf_discarded": 0,
        "non_sediu_skipped": 0,
        "pj_f_series_unpublishable": 0,
        "bad_rows_skipped": 0,
    }

    def field(parts: list, name: str) -> str:
        i = idx[name]
        return parts[i].strip() if i < len(parts) else ""

    for line in lines[1:]:
        if not line.strip():
            continue
        counts["rows"] += 1
        parts = line.split("^")
        cui_text = field(parts, "COD_FISCAL")
        if not cui_text.isdigit():
            counts["bad_rows_skipped"] += 1
            continue
        if field(parts, "TIP_UNITATE").lower() != "sediu central":
            counts["non_sediu_skipped"] += 1
            continue
        tip = field(parts, "TIP_CONTRIB").upper()
        if tip == "PF":
            # PS7: counted, then DISCARDED — never stored anywhere.
            counts["pf_discarded"] += 1
            continue
        if tip != "PJ":
            counts["bad_rows_skipped"] += 1
            continue
        series = _register_series(field(parts, "JUDET_COMERT"))
        publishable = series != "F"
        if not publishable:
            counts["pj_f_series_unpublishable"] += 1
        store.set_identification(
            int(cui_text),
            name=field(parts, "DENUMIRE") or None,
            county=field(parts, "JUDET") or None,
            locality=field(parts, "LOCALITATE") or None,
            reg_number=_reg_number(
                {k: field(parts, k) for k in
                 ("JUDET_COMERT", "NR_COMERT", "AN_COMERT")}
            ),
            tip_contrib="PJ",
            publishable=publishable,
            name_source=source_label,
        )
        counts["pj_upserted"] += 1
    return counts
