"""Loader + lookup for the committed Romanian sector benchmark dataset.

``load_dataset`` enforces THE LAW at the load boundary: a dataset holding
a figure without source, year or n — or a median published on fewer than
min_peers peers — does not load at all (DatasetLawError). Nothing
downstream has to re-check, and nothing can serve a figure that slipped
past.

``lookup`` resolves caen + filed-basis turnover -> size band -> one
figure per ratio. CAEN class first; the CAEN division is used ONLY when
the class has no dataset entry or too few peers for that ratio, and the
level actually used is stated on the figure. Never silent.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import definitions as D

DATASET_PATH = (Path(__file__).resolve().parents[1] / "data"
                / "ro_sector_benchmarks.json")

_NUMERIC_KEYS = ("median", "p25", "p75")


class DatasetLawError(ValueError):
    """The dataset breaks the law; it must not be served."""


def check_law(dataset: Dict[str, Any]) -> List[str]:
    """Every violation, as 'sector/band/ratio: what'. Empty = lawful."""
    problems: List[str] = []
    min_peers = dataset.get("min_peers")
    if not isinstance(min_peers, int) or min_peers < D.MIN_PEERS:
        problems.append("dataset: min_peers %r is below the declared %d"
                        % (min_peers, D.MIN_PEERS))
        min_peers = D.MIN_PEERS
    for sector, entry in sorted((dataset.get("sectors") or {}).items()):
        if entry.get("level") not in ("caen4", "caen2"):
            problems.append("%s: level not stated" % sector)
        for band, cell in sorted((entry.get("cells") or {}).items()):
            for ratio, fig in sorted((cell.get("figures") or {}).items()):
                where = "%s/%s/%s" % (sector, band, ratio)
                n = fig.get("n")
                if not isinstance(n, int) or isinstance(n, bool) or n < 0:
                    problems.append("%s: figure without n" % where)
                    n = None
                if not isinstance(fig.get("year"), int):
                    problems.append("%s: figure without year" % where)
                if not (isinstance(fig.get("source"), str)
                        and fig["source"].strip()):
                    problems.append("%s: figure without source" % where)
                if not fig.get("filed_lines"):
                    problems.append("%s: figure without filed lines" % where)
                has_numbers = any(k in fig for k in _NUMERIC_KEYS)
                if has_numbers and (n is None or n < min_peers):
                    problems.append(
                        "%s: median published on n=%r (< %d peers)"
                        % (where, n, min_peers))
                if has_numbers and fig.get("insufficient_peers"):
                    problems.append("%s: insufficient_peers with a median"
                                    % where)
                if not has_numbers and not fig.get("insufficient_peers"):
                    problems.append("%s: neither a median nor a refusal"
                                    % where)
                if has_numbers and not all(
                        isinstance(fig.get(k), (int, float))
                        and not isinstance(fig.get(k), bool)
                        for k in _NUMERIC_KEYS):
                    problems.append("%s: incomplete median/p25/p75" % where)
    return problems


def validate(dataset: Dict[str, Any]) -> Dict[str, Any]:
    if dataset.get("schema") != D.SCHEMA:
        raise DatasetLawError("unknown dataset schema %r"
                              % dataset.get("schema"))
    problems = check_law(dataset)
    if problems:
        raise DatasetLawError(
            "sector benchmark dataset breaks the law (%d): %s"
            % (len(problems), "; ".join(problems[:5])))
    return dataset


_CACHE: Dict[str, Dict[str, Any]] = {}


def load_dataset(path: Optional[Path] = None) -> Dict[str, Any]:
    target = Path(path) if path is not None else DATASET_PATH
    key = str(target)
    if key not in _CACHE:
        _CACHE[key] = validate(json.loads(target.read_text("utf-8")))
    return _CACHE[key]


def size_band_for(turnover_ron: Optional[Any],
                  dataset: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The size band (with its printed cut-offs) from the DATASET's own
    declared bands, or None when turnover is absent or not positive."""
    if turnover_ron is None:
        return None
    try:
        value = int(turnover_ron)
    except (TypeError, ValueError):
        return None
    for band in dataset["size_bands"]:
        upper = band["max_ron"]
        if value >= band["min_ron"] and (upper is None or value < upper):
            return dict(band)
    return None


def _usable(fig: Optional[Dict[str, Any]]) -> bool:
    return bool(fig) and "median" in fig


def lookup(caen: Optional[Any], turnover_ron: Optional[Any],
           dataset: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Sector figures for one company. Shape:

      {status: "ok", caen, size_band: {...cut-offs}, year,
       rows: {ratio: figure + {level, sector_caen}
                   | {insufficient_peers, n, ..., level, sector_caen}},
       refused_ratios: {ratio: {reason}}}
      {status: "refused", reason: <code>, detail}
    """
    ds = dataset if dataset is not None else load_dataset()
    caen4 = D.normalize_caen(caen)
    if caen4 is None:
        return {"status": "refused", "reason": "caen_absent",
                "detail": "no four-digit CAEN class to look up"}
    band = size_band_for(turnover_ron, ds)
    if band is None:
        return {"status": "refused", "reason": "turnover_absent",
                "detail": "a size band needs a positive net turnover; "
                          "none was supplied"}
    sectors = ds["sectors"]
    class_entry = sectors.get(caen4)
    division_entry = sectors.get(caen4[:2])
    if class_entry is None and division_entry is None:
        return {"status": "refused", "reason": "sector_not_in_dataset",
                "detail": "CAEN %s and division %s are not in the sourced "
                          "dataset" % (caen4, caen4[:2])}

    def fig_of(entry: Optional[Dict[str, Any]], ratio: str):
        if entry is None:
            return None
        return ((entry["cells"].get(band["key"]) or {})
                .get("figures") or {}).get(ratio)

    rows: Dict[str, Any] = {}
    for ratio in ds["ratios"]:
        own, parent = fig_of(class_entry, ratio), fig_of(division_entry, ratio)
        if _usable(own):
            chosen, entry, fell_back = own, class_entry, False
        elif _usable(parent):
            chosen, entry, fell_back = parent, division_entry, True
        elif own is not None:
            chosen, entry, fell_back = own, class_entry, False
        elif parent is not None:
            chosen, entry, fell_back = parent, division_entry, True
        else:
            continue
        row = copy.deepcopy(chosen)
        row["level"] = entry["level"]
        row["sector_caen"] = entry["caen"]
        if fell_back:
            row["fallback_from"] = {
                "caen": caen4,
                "reason": ("class_not_in_dataset" if class_entry is None
                           else "insufficient_peers"),
                "n_at_class": None if own is None else own.get("n"),
            }
        rows[ratio] = row
    return {
        "status": "ok", "caen": caen4, "size_band": band,
        "year": ds["year"], "prior_year": ds.get("prior_year"),
        "min_peers": ds["min_peers"], "rows": rows,
        "ratio_definitions": copy.deepcopy(ds["ratios"]),
        "refused_ratios": copy.deepcopy(ds["refused_ratios"]),
    }
