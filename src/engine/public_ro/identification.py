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
  - TIP_CONTRIB == PF rows never introduce a CUI: one the store has not
    seen is COUNTED then DISCARDED (``pf_discarded``) — a natural
    person's data NEVER enters the store, not even unpublishable. One the
    store ALREADY holds as a company is REVOKED (``pf_revoked``): the
    snapshot is annual and re-running it is the documented operational
    path, so re-classification must be able to take publishability away,
    not only grant it. The stored identity is scrubbed in the same write
    — what was a company name is now a natural person's.
  - TIP_CONTRIB == PJ rows upsert into ``companies``; publishable=1 only
    when the trade-register series is J (company) or C (cooperative).
    The gate is that WHITELIST, not "anything but F": an unknown or
    absent series fails CLOSED, matching the module rule and
    compliance.publishable_reason's F-series refusal (measured: 200,630
    of 201,719 PF rows with a register number are F-series).
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


#: Trade-register series letters that grant publishability: J = company,
#: C = cooperative. Everything else — F (PFA/II/IF), an unrecognized
#: letter, or no register at all — fails closed. Mirrors
#: compliance._PUBLISHABLE_REGISTER_SERIES, the predicate pages route
#: through; the two must not drift apart.
_PUBLISHABLE_REGISTER_SERIES = frozenset({"J", "C"})


def _register_series(judet_comert: str) -> Optional[str]:
    """First letter of the trade-register county code ('J40' -> 'J',
    'F12' -> 'F', 'C..' -> 'C'). None when there is no register.

    SCANS for the first alphabetic character rather than reading
    position 0, because compliance._register_series scans: on a
    digits-first malformation like '40F' a position-0 read returns None
    and (under any not-F rule) would have granted a page that the
    compliance predicate refuses as F-series.
    """
    for ch in (judet_comert or "").strip():
        if ch.isalpha():
            return ch.upper()
    return None


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
    counts: rows, pj_upserted, pf_discarded, pf_revoked,
    non_sediu_skipped, pj_f_series_unpublishable,
    pj_no_series_unpublishable, bad_rows_skipped.

    pf_discarded and pf_revoked are DISJOINT: a PF row either found no
    stored CUI (discarded, nothing written) or revoked one (see the PS7
    note in the module docstring)."""
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
        "pf_revoked": 0,
        "non_sediu_skipped": 0,
        "pj_f_series_unpublishable": 0,
        "pj_no_series_unpublishable": 0,
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
            # PS7: a PF row never INTRODUCES a CUI. But one already held
            # as a company must lose publishability here — without this,
            # a company reclassified to a natural-person form between two
            # annual snapshots keeps its live public financial page
            # forever. The identity fields go with it: they now describe
            # a natural person.
            if store.get_company(int(cui_text)) is not None:
                store.set_identification(
                    int(cui_text),
                    name=None,
                    county=None,
                    locality=None,
                    reg_number=None,
                    tip_contrib="PF",
                    publishable=False,
                    name_source=source_label,
                )
                counts["pf_revoked"] += 1
            else:
                counts["pf_discarded"] += 1
            continue
        if tip != "PJ":
            counts["bad_rows_skipped"] += 1
            continue
        series = _register_series(field(parts, "JUDET_COMERT"))
        publishable = series in _PUBLISHABLE_REGISTER_SERIES
        if series == "F":
            counts["pj_f_series_unpublishable"] += 1
        elif not publishable:
            counts["pj_no_series_unpublishable"] += 1
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
