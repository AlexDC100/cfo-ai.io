"""BVB ticker → CUI (Romanian fiscal code) map.

Feeds the ANAF Bilanț enrichment (providers/anaf_bilant.py +
scripts/backfill_bvb_anaf.py): ANAF is keyed by CUI, the universe is
keyed by ticker.

EVERY entry here was VERIFIED against the live ANAF web service on
2026-07-23 — the /bilant response echoes the registered company name
(``deni``), and each CUI below returned the expected issuer. Do not add
guessed CUIs: an unknown CUI silently returns an empty body, and a
WRONG-but-existing CUI would attach another company's statutory numbers
to the ticker. To extend: find the CUI on the issuer's m.bvb.ro profile
("Cod fiscal"), then run scripts/backfill_bvb_anaf.py --verify TICKER
which checks the name echo before accepting it.

Deliberately absent:
* DIGI, WINE (Purcari), PE (Premier Energy), EBS — foreign-incorporated
  parents (NL/CY/AT); they have no Romanian statutory filing at group
  level. Their RO subsidiaries file, but attaching a subsidiary's
  standalone bilanț to the listed group would be misleading.
* RRC, VNC, TTS, AROBS and the remaining small caps — candidate CUIs
  failed name verification on 2026-07-23; fill from the BVB issuer
  pages when needed.
"""

from __future__ import annotations

from typing import Dict

BVB_CUI: Dict[str, int] = {
    # ── BET-20 seed rows ──
    "TLV": 5022670,        # Banca Transilvania S.A.
    "BRD": 361579,         # BRD - Groupe Société Générale S.A.
    "FP": 18253260,        # Fondul Proprietatea S.A.
    "SNP": 1590082,        # OMV Petrom S.A.
    "SNG": 14056826,       # S.N.G.N. Romgaz S.A.
    "TGN": 13068733,       # S.N.T.G.N. Transgaz S.A.
    "H2O": 13267213,       # Hidroelectrica S.A.
    "SNN": 10874881,       # S.N. Nuclearelectrica S.A.
    "EL.BVB": 13267221,    # Societatea Energetică Electrica S.A.
    "TEL": 13328043,       # C.N.T.E.E. Transelectrica S.A.
    "M": 8422035,          # Med Life S.A.
    "ATB": 1973096,        # Antibiotice S.A.
    "AQ": 6484554,         # Aquila Part Prod Com S.A.
    "SFG": 37586457,       # Sphera Franchise Group S.A.
    "ONE": 22767862,       # One United Properties S.A.
    "TRP": 3094980,        # Teraplast S.A.
    # ── Regulated-market listing rows ──
    "OIL": 2410163,        # Oil Terminal S.A.
    "COTE": 1350020,       # Conpet S.A.
    "ALT": None,           # type: ignore[dict-item]  # placeholder — see module docstring
    "ARS": 950531,         # Aerostar S.A.
    "BIO": 341563,         # Biofarm S.A.
    "CMP": 788767,         # Compa S.A.
    "SOCP": 1870767,       # Socep S.A.
    "ALR": 1515374,        # Alro S.A.
    "BVB": 17777754,       # Bursa de Valori București S.A.
    "ELMA": 414118,        # Electromagnetica S.A.
    "ARTE": 2157428,       # Artego S.A.
    "TBM": 3156315,        # Turbomecanica S.A.
    "IARV": 1132930,       # IAR S.A. Brașov
    "CRC": 960322,         # Chimcomplex S.A. Borzești
    "CBC": 201535,         # Carbochim S.A.
    "MECF": 2045262,       # Mecanica Ceahlău S.A.
    "SNO": 1614734,        # Șantierul Naval Orșova S.A.
    "BNET": 21181848,      # Bittnet Systems S.A.
    "EVER": 2816642,       # Evergent Investments S.A.
}

# Drop unfilled placeholders so consumers can iterate the map directly.
BVB_CUI = {t: c for t, c in BVB_CUI.items() if c is not None}
