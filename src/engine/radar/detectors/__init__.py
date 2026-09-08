"""engine.radar.detectors — THE TWELVE FAMILIES, AND THE PACK THAT
DECLARES WHICH DETECTORS EXIST.

    pack        ``packs/<jurisdiction>/detectors.yaml`` -> DetectorSpec
    registry    family name -> implementation. The ONLY join between the
                data and the arithmetic.
    book        the ledger substrate: accounts, movements and atom ids,
                period by period, ABSENT preserved
    fam_series  the seven cross-period families
    fam_static  the five single-period-valid families
    support     basis resolution, the impact constructors, and the one
                place a result becomes a ``_finding.Finding``
    run         the cold-start gate and the runner

ADDING A DETECTOR IS EDITING YAML. Adding a FAMILY is engine work. The
split is the architecture: ``tests/engine/test_radar_detector_pack.py``
admits a fictional detector through pack data alone and watches it
surface, and ``tests/engine/test_e8_jurisdiction_blindness.py`` scans this
package for a jurisdiction branch.

No module here reads a clock, calls a model, or writes anything.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from .book import AccountRow, BasisTotals, BookSeries, Group, PeriodBook
from .pack import (COLD_START_MIN_PERIODS, DetectorPack, DetectorPackError,
                   DetectorSpec, load_pack, pack_path, parse_pack)
from .registry import UnknownFamilyError, registered
from .result import DetectorResult, MeasuredFigure
from .run import DetectorCheck, DetectorRun, run_detectors, surfaced

__all__ = [
    "AccountRow", "BasisTotals", "BookSeries", "COLD_START_MIN_PERIODS",
    "DetectorCheck", "DetectorPack", "DetectorPackError", "DetectorResult",
    "DetectorRun", "DetectorSpec", "Group", "MeasuredFigure", "PeriodBook",
    "UnknownFamilyError", "load_pack", "pack_path", "parse_pack", "registered",
    "run_detectors", "surfaced",
]
