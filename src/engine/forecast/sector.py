"""The SECTOR rung of the revenue_growth ladder (contract 3.3, 3.4).

book -> SECTOR -> macro -> convention. The book rung reads the company's own
two turnovers when a comparable prior year is loaded; when it is not, this
module reads the median net-turnover growth of the company's sector from the
ONE committed sector dataset the product already serves on the benchmark
surface: ``engine.benchmarks_ro`` (Ministry of Finance annual filings on
data.gov.ro, CC-BY-4.0, FY2023 -> FY2024, every figure with its source, year
and n, and a median never published on fewer peers than the dataset
declares).

Pure: no I/O beyond reading that committed JSON through its own loader,
which enforces the dataset's law at the load boundary. Nothing here is a
float: the dataset's fractions are six-place decimals and are read into
exact micros through ``Decimal(str(...))``, and a value that is not exact at
that scale is refused rather than rounded.

ABSENT is never zero. A workspace with no CAEN, a book with no positive
turnover, a sector outside the dataset, a cell with too few filers, or a
median below the lane's own ``min_n`` each returns a reading with no value
and the pack's sentence for that code; the ladder then records the rung as
absent with that sentence and continues to the macro anchor.

Python 3.9 - no ``match``, no ``X | Y``.
"""

from __future__ import annotations

import hashlib
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Optional

from .levers_pack import sector_pack
from .money import MICRO

__all__ = ["SectorReading", "sector_growth", "dataset_snapshot_id"]

_SNAPSHOT = {}  # type: Dict[str, str]


class SectorReading(object):
    """What the sector rung found for one book: an exact value in micros with
    the evidence contract 3.3 requires, or ``value None`` with the reason."""

    __slots__ = ("value", "evidence", "reason_code", "reason", "snapshot_id",
                 "sentence", "offer_sentence")

    def __init__(self, value: Optional[int], evidence: Optional[Dict[str, Any]],
                 reason_code: Optional[str], reason: Optional[str],
                 snapshot_id: Optional[str], sentence: Optional[str],
                 offer_sentence: Optional[str] = None) -> None:
        self.value = value
        self.evidence = evidence
        self.reason_code = reason_code
        self.reason = reason
        self.snapshot_id = snapshot_id
        #: the basis when the growth STANDS on the sector rung
        self.sentence = sentence
        #: the basis when the same figure is only OFFERED beside the book
        #: rung (alternatives.sector) — it never says the history is missing
        self.offer_sentence = offer_sentence

    @property
    def present(self) -> bool:
        return self.value is not None


def dataset_snapshot_id() -> str:
    """``ro_sector_benchmarks:sha256:<digest of the committed file>`` — the
    pin a response carries when its growth stood on the dataset
    (pins.sector_snapshot_id). Content-addressed, never a clock."""
    from engine.benchmarks_ro import dataset as _ds
    key = str(_ds.DATASET_PATH)
    if key not in _SNAPSHOT:
        digest = hashlib.sha256(_ds.DATASET_PATH.read_bytes()).hexdigest()
        _SNAPSHOT[key] = "ro_sector_benchmarks:sha256:%s" % digest
    return _SNAPSHOT[key]


def _micros(value: Any) -> Optional[int]:
    """A dataset fraction as exact micros; None when it is not exact at that
    scale (refused rather than rounded)."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        exact = Decimal(str(value)) * MICRO
    except (InvalidOperation, ValueError):
        return None
    if exact != exact.to_integral_value():
        return None
    return int(exact)


def _pct(micros: int) -> str:
    """micros -> "5.1528%" (four places, exact integer arithmetic)."""
    sign = "-" if micros < 0 else ""
    whole, frac = divmod(abs(micros), 10000)
    return "%s%d.%04d%%" % (sign, whole, frac)


def _absent(code: str) -> SectorReading:
    pack = sector_pack()
    return SectorReading(None, None, code, pack.absent[code], None, None)


def sector_growth(caen: Optional[str], revenue_cents: Optional[int]) -> SectorReading:
    """The sector median of net-turnover growth for a company of CAEN
    ``caen`` whose own turnover is ``revenue_cents``.

    The size band is chosen from the company's OWN turnover in whole RON, by
    the dataset's printed cut-offs. The CAEN class is read first; the
    division only when the class has no dataset entry or too few peers, and
    the level actually used is stated on the evidence (never silent)."""
    from engine.benchmarks_ro import dataset as _ds

    pack = sector_pack()
    if not caen or not str(caen).strip():
        return _absent("caen_absent")
    if revenue_cents is None or revenue_cents <= 0:
        return _absent("turnover_absent")
    ds = _ds.load_dataset()
    found = _ds.lookup(caen, revenue_cents // 100, ds)
    if found.get("status") != "ok":
        reason = found.get("reason")
        if reason in ("caen_absent", "turnover_absent", "sector_not_in_dataset"):
            return _absent(reason)
        return _absent("sector_not_in_dataset")
    row = (found.get("rows") or {}).get(pack.ratio)
    if not isinstance(row, dict):
        return _absent("ratio_not_in_dataset")
    if row.get("insufficient_peers") or "median" not in row:
        return _absent("insufficient_peers")
    n = row.get("n")
    if not isinstance(n, int) or isinstance(n, bool) or n < pack.min_n:
        return _absent("below_min_n")
    p25, p50, p75 = _micros(row.get("p25")), _micros(row.get("median")), _micros(row.get("p75"))
    if p50 is None or p25 is None or p75 is None:
        return _absent("ratio_not_in_dataset")
    band = found.get("size_band") or {}
    level = row.get("level")
    sector_caen = row.get("sector_caen")
    entry = (ds.get("sectors") or {}).get(str(sector_caen)) or {}
    label = entry.get("label")
    year = row.get("year")
    prior_year = row.get("prior_year")
    source_url = None
    for item in ((ds.get("provenance") or {}).get("datasets") or []):
        if item.get("year") == year and item.get("dataset_id"):
            source_url = "https://data.gov.ro/dataset/%s" % item["dataset_id"]
            break
    evidence = {
        # contract 3.3, sector
        "source_id": dataset_snapshot_id(),
        "source_url": source_url,
        "statistic": pack.statistic,
        "p25": p25, "p50": p50, "p75": p75,
        "n": n,
        "period_year": year,
        "caen_level_used": level,
        "size_band_used": band.get("key"),
        "method": pack.method,
        # The dataset records no build timestamp; source_id pins its bytes,
        # which is the only honest "as of" a committed file has.
        "computed_at": None,
        # stated beside the contract fields so the reader sees WHICH sector
        "caen": found.get("caen"),
        "sector_caen": sector_caen,
        "sector_label": label,
        "prior_year": prior_year,
        "size_band": {"min_ron": band.get("min_ron"), "max_ron": band.get("max_ron")},
        "source": row.get("source"),
        "filed_lines": list(row.get("filed_lines") or []),
        "fallback_from": row.get("fallback_from"),
        "rule_id": pack.rule_id,
    }
    fields = dict(
        sector="CAEN %s %s" % (sector_caen, label or ""),
        level=("class" if level == "caen4" else "division"),
        band=band.get("key"), growth=_pct(p50), n=n,
        prior_year=prior_year, year=year, source=row.get("source"))
    sentence = pack.sentence.format(**fields)
    offer = pack.offer_sentence.format(**fields)
    return SectorReading(p50, evidence, None, None, dataset_snapshot_id(),
                         " ".join(sentence.split()), " ".join(offer.split()))
