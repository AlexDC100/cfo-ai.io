"""Aggregate the Ministry of Finance annual filings into sector cells.

Reads the mass files through the EXISTING public_ro reader (spec
resolution, strict parsing, derive_fields, the license gate) — there is
no second parser here. Pure and deterministic: Decimal arithmetic, a
pinned context, sorted iteration, no clocks, no hash().

Per row, per ratio: an absent operand or a non-positive denominator
drops the row FROM THAT RATIO ONLY, and the drop is counted. Nothing is
imputed; an empty field is never read as zero.
"""
from __future__ import annotations

import hashlib
from decimal import ROUND_HALF_EVEN, Decimal, localcontext
from typing import Any, Dict, Iterable, List, Optional, Tuple

from engine.public_ro.ingest import check_license, derive_fields, parse_bilant
from engine.public_ro.specs import SpecResolutionError, resolve_spec

from . import definitions as D

#: Families accepted. Both are "societati comerciale" per the portal's
#: own description file, so natural-person forms (PFA/II/IF) are absent
#: by construction; any other family is refused.
FAMILIES = ("UU", "BL")

_QUANT = {"fraction": Decimal("0.000001"), "days": Decimal("0.01")}
_Q25, _Q50, _Q75 = Decimal("0.25"), Decimal("0.5"), Decimal("0.75")
_DAYS = Decimal(365)


class BuildError(RuntimeError):
    pass


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ── reading (through the existing reader) ────────────────────────────


def read_family(
    data_bytes: bytes, spec_text: str, *, year: int, family: str,
    license_id: Optional[str], expected_sha256: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Parse one (year, family) file into canonical-slot rows.

    Fail-closed: wrong family, sha mismatch against the manifest, an
    unacceptable license, an unresolvable spec or ANY row the strict
    reader rejects aborts the build. Rows are not skipped quietly."""
    if family not in FAMILIES:
        raise BuildError("family %r is not a company bilant family" % family)
    sha = sha256_hex(data_bytes)
    if expected_sha256 and sha != expected_sha256:
        raise BuildError(
            "FY%s %s: file sha256 %s does not match the manifest %s"
            % (year, family, sha, expected_sha256))
    check_license(license_id, year=year, family=family)
    code_map = resolve_spec(spec_text, year=year, family=family)
    source_codes, rows = parse_bilant(data_bytes.decode("ascii", "strict"))
    unknown = [c for c in source_codes if c not in code_map]
    if unknown:
        raise SpecResolutionError(
            year, family, "data header carries codes absent from the "
            "spec: %s" % ", ".join(unknown))
    out: List[Dict[str, Any]] = []
    for row in rows:
        ind: Dict[str, Optional[int]] = {}
        for source_code, value in row["values"].items():
            ind[code_map[source_code]] = value
        derived = derive_fields(ind)
        out.append({
            "cui": row["cui"], "caen": D.normalize_caen(row["caen"]),
            "ind": ind, "total_assets": derived["total_assets"],
            "net_result": derived["net_result"],
        })
    return out, {"file_sha256": sha, "row_count": len(out)}


# ── per-row ratios ───────────────────────────────────────────────────

_ABSENT = "absent_operand"
_NONPOS = "nonpositive_denominator"


def _div(num: Optional[int], den: Optional[int]) -> Any:
    """Decimal quotient, or the drop reason. Absent is never zero."""
    if num is None or den is None:
        return _ABSENT
    if den <= 0:
        return _NONPOS
    return Decimal(num) / Decimal(den)


def row_ratios(row: Dict[str, Any], prior_turnover: Optional[int],
               has_prior_year: bool) -> Dict[str, Any]:
    """{ratio_key: Decimal | drop-reason string} for one filing."""
    ind, ta, net = row["ind"], row["total_assets"], row["net_result"]
    turnover = ind.get("i13")

    def days(value: Any) -> Any:
        return value * _DAYS if isinstance(value, Decimal) else value

    out = {
        "net_margin": _div(net, turnover),
        "roe": _div(net, ind.get("i10")),
        "roa": _div(net, ta),
        "equity_ratio": _div(ind.get("i10"), ta),
        "liabilities_to_assets": _div(ind.get("i7"), ta),
        "receivables_days": days(_div(ind.get("i4"), turnover)),
        "inventory_days_on_turnover": days(_div(ind.get("i3"), turnover)),
        "current_asset_share": _div(ind.get("i2"), ta),
    }
    if has_prior_year:
        growth = _div(turnover, prior_turnover)
        out["revenue_growth"] = (
            growth - 1 if isinstance(growth, Decimal) else growth)
    return out


# ── distribution ─────────────────────────────────────────────────────


def _percentile(sorted_vals: List[Decimal], q: Decimal) -> Decimal:
    """Linear interpolation between closest ranks (numpy 'linear') — the
    same method as public_ro.ingest._percentile, in Decimal."""
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = (len(sorted_vals) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = pos - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac


def _num(value: Decimal, unit: str) -> float:
    # The float is only the JSON spelling of an already-quantized
    # Decimal; repr() of it round-trips to the same digits.
    return float(value.quantize(_QUANT[unit], rounding=ROUND_HALF_EVEN))


def figure(key: str, values: List[Decimal], dropped: Dict[str, int],
           years: Tuple[int, ...]) -> Dict[str, Any]:
    """One published figure. THE LAW: source, year and n on every one;
    below MIN_PEERS there is no median, only the refusal and n."""
    spec = D.RATIOS[key]
    base: Dict[str, Any] = {
        "n": len(values),
        "year": max(years),
        "source": D.source_label(years),
        "unit": spec["unit"],
        "filed_lines": list(spec["filed_lines"]),
        "dropped": {k: dropped.get(k, 0) for k in (_ABSENT, _NONPOS)},
    }
    if len(years) > 1:
        base["prior_year"] = min(years)
    if len(values) < D.MIN_PEERS:
        base["insufficient_peers"] = True
        return base
    ordered = sorted(values)
    base["median"] = _num(_percentile(ordered, _Q50), spec["unit"])
    base["p25"] = _num(_percentile(ordered, _Q25), spec["unit"])
    base["p75"] = _num(_percentile(ordered, _Q75), spec["unit"])
    return base


def _cell(rows: List[Dict[str, Any]], prior: Optional[Dict[int, int]],
          year: int, prior_year: Optional[int]) -> Dict[str, Any]:
    values: Dict[str, List[Decimal]] = {k: [] for k in D.RATIOS}
    dropped: Dict[str, Dict[str, int]] = {k: {} for k in D.RATIOS}
    for row in rows:
        prior_turnover = prior.get(row["cui"]) if prior is not None else None
        for key, val in row_ratios(row, prior_turnover,
                                   prior is not None).items():
            if isinstance(val, Decimal):
                values[key].append(val)
            else:
                dropped[key][val] = dropped[key].get(val, 0) + 1
    figures: Dict[str, Any] = {}
    for key in D.RATIOS:
        if D.RATIOS[key].get("needs_prior_year"):
            if prior is None or prior_year is None:
                continue
            years: Tuple[int, ...] = (prior_year, year)
        else:
            years = (year,)
        figures[key] = figure(key, values[key], dropped[key], years)
    return {"n_companies": len(rows), "figures": figures}


def build_sectors(
    rows: Iterable[Dict[str, Any]], *, year: int, caen4: List[str],
    prior_turnover_by_cui: Optional[Dict[int, int]] = None,
    prior_year: Optional[int] = None,
) -> Tuple[Dict[str, Any], Dict[str, int]]:
    """Cells for each requested CAEN class plus its CAEN division (the
    labelled fallback level). Peer set = every filer with a POSITIVE
    filed turnover in the sector; the subject company, if it filed
    there, is a member like any other."""
    wanted4 = sorted({c for c in (D.normalize_caen(x) for x in caen4) if c})
    wanted2 = sorted({c[:2] for c in wanted4})
    buckets: Dict[str, Dict[str, List[Dict[str, Any]]]] = {
        s: {} for s in wanted4 + wanted2}
    counts = {"rows_in_scope": 0, "rows_without_positive_turnover": 0}
    for row in rows:
        caen = row["caen"]
        if caen is None or caen[:2] not in wanted2:
            continue
        counts["rows_in_scope"] += 1
        band = D.size_band_key(row["ind"].get("i13"))
        if band is None:
            counts["rows_without_positive_turnover"] += 1
            continue
        for sector in ([caen] if caen in buckets else []) + [caen[:2]]:
            buckets[sector].setdefault(band, []).append(row)
            buckets[sector].setdefault(D.ALL_SIZES, []).append(row)

    band_order = [b["key"] for b in D.SIZE_BANDS] + [D.ALL_SIZES]
    sectors: Dict[str, Any] = {}
    with localcontext() as ctx:
        ctx.prec = 28
        ctx.rounding = ROUND_HALF_EVEN
        for sector in sorted(buckets):
            level = "caen4" if len(sector) == 4 else "caen2"
            cells = {}
            for band in band_order:
                members = sorted(buckets[sector].get(band, []),
                                 key=lambda r: r["cui"])
                cells[band] = _cell(members, prior_turnover_by_cui,
                                    year, prior_year)
            entry: Dict[str, Any] = {"level": level, "caen": sector,
                                     "cells": cells}
            if level == "caen4":
                entry["parent_caen2"] = sector[:2]
            sectors[sector] = entry
    return sectors, counts


def assemble_dataset(*, year: int, prior_year: Optional[int],
                     sectors: Dict[str, Any],
                     provenance: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "schema": D.SCHEMA,
        "year": year,
        "prior_year": prior_year,
        "provenance": provenance,
        "min_peers": D.MIN_PEERS,
        "size_bands": [dict(b) for b in D.SIZE_BANDS],
        "all_sizes_key": D.ALL_SIZES,
        "ratios": {k: {kk: vv for kk, vv in v.items()
                       if kk != "needs_prior_year"}
                   for k, v in D.RATIOS.items()},
        "refused_ratios": {k: dict(v) for k, v in D.REFUSED_RATIOS.items()},
        "sectors": sectors,
    }
