"""Romania country pack — OMFP 1802 / RAS.

F3.1 status (Partially Calibrated):
  - 2 real fixtures: EEI Imobiliara Investment SRL (commercial real
    estate, single-asset), Scandia Food SRL (food manufacturing).
  - F-A3.1 BS-correctness GREEN on both (EEI 0.0000% drift, Scandia
    0.3698%).
  - Engine canonical contract: v2.1 (assembled_pl / _bs / _cf /
    _bands / _piotroski / _metrics envelope).

Importing this subpackage triggers the side-effect registration of
`RomaniaPack` with `engine.core.country_pack_registry`. Pipeline code
should reach the pack via `get_pack("RO")` rather than importing this
class directly, to keep the pack-dispatch boundary clean.
"""

from .pack import RomaniaPack  # noqa: F401  — side-effect: register_pack(RomaniaPack())

# F3.1d: `ParseError` now lives inside the pack alongside the parser.
# `engine.api._trial_balance_parser` is a shim re-exporting from here.
from .trial_balance_parser import ParseError  # noqa: F401, E402
