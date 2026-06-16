"""CAEN (Romanian NACE Rev 2) → industry_category mapper.

The `industry_benchmarks` table catalogues percentile data keyed by exact
CAEN code. Coverage is sparse (8 codes at last count: 1012, 1013, 4120,
4711, 4719, 5610, 6201, 6820). Most uploaded companies — automotive
distributors, media producers, IT services, dormants — won't have a
direct catalogue hit. Without a fallback we'd 404 every benchmark request
for those companies.

This mapper provides two things:

  1. `caen_to_category(caen)` — maps the 4-digit CAEN to one of our
     `industry_category` values (manufacturing_consumer / retail_general /
     services_it / real_estate_commercial / construction /
     hospitality_restaurant / retail_grocery / generic).

  2. `caen_label(caen)` — best-effort human-readable label for the CAEN,
     used in the FE when the catalogue doesn't carry a label for that
     exact code (e.g., "Automotive wholesale & retail" for 4511).

The mapping uses 2-digit CAEN prefixes — Romanian NACE Rev 2 groups
industries that way: 10-33 manufacturing, 41-43 construction, 45-47
trade, 49-53 transport, 55-56 hospitality, 58-63 information, etc. We
err on the side of the most-similar catalogue category, not the most
specific real industry. The FE shows a "industry mapped from CAEN X"
disclosure so the user can see exactly which category we benchmarked
against, and override via the existing IndustryConfirmModal if wrong.
"""

from __future__ import annotations

from typing import Optional, Tuple


# ─── 2-digit CAEN prefix → (industry_category, generic_label) ───────────────
#
# `industry_category` MUST match one of the categories present in
# industry_benchmarks.industry_category. We aggregate across all CAENs
# within that category when an exact CAEN-code match isn't available.
#
# Codes here are from the official ANAF CAEN Rev 2 list. The mapping is
# intentionally coarse — we'd rather show a directional benchmark with
# a clear "CAEN was mapped to X" note than 404 every uncatalogued upload.

_PREFIX_MAP: dict[str, Tuple[str, str]] = {
    # Agriculture, forestry, fishing
    "01": ("agriculture",            "Agricultură / cultivarea plantelor"),
    "02": ("agriculture",            "Silvicultură"),
    "03": ("agriculture",            "Pescuit și acvacultură"),
    # Mining
    "05": ("mining",                 "Extracție cărbune"),
    "06": ("mining",                 "Extracție țiței și gaz"),
    "07": ("mining",                 "Extracție minereuri metalice"),
    "08": ("mining",                 "Alte activități extractive"),
    "09": ("mining",                 "Servicii anexe extracției"),
    # Manufacturing — split into consumer / industrial / heavy
    "10": ("manufacturing_consumer", "Industria alimentară"),
    "11": ("manufacturing_consumer", "Fabricarea băuturilor"),
    "12": ("manufacturing_consumer", "Fabricarea produselor din tutun"),
    "13": ("manufacturing_consumer", "Fabricarea produselor textile"),
    "14": ("manufacturing_consumer", "Fabricarea articolelor de îmbrăcăminte"),
    "15": ("manufacturing_consumer", "Tăbăcăria și fabricarea articolelor de pielărie"),
    "16": ("manufacturing_industrial","Prelucrarea lemnului"),
    "17": ("manufacturing_industrial","Fabricarea hârtiei și produselor din hârtie"),
    "18": ("manufacturing_industrial","Tipărire și reproducerea pe suporturi a înregistrărilor"),
    "19": ("manufacturing_heavy",    "Fabricarea produselor de cocserie și a produselor obținute prin rafinarea petrolului"),
    "20": ("manufacturing_heavy",    "Fabricarea substanțelor și produselor chimice"),
    "21": ("manufacturing_heavy",    "Fabricarea produselor farmaceutice"),
    "22": ("manufacturing_industrial","Fabricarea produselor din cauciuc și mase plastice"),
    "23": ("manufacturing_industrial","Fabricarea altor produse din minerale nemetalice"),
    "24": ("manufacturing_heavy",    "Industria metalurgică"),
    "25": ("manufacturing_industrial","Industria construcțiilor metalice și a produselor din metal"),
    "26": ("manufacturing_industrial","Fabricarea calculatoarelor și a produselor electronice și optice"),
    "27": ("manufacturing_industrial","Fabricarea echipamentelor electrice"),
    "28": ("manufacturing_industrial","Fabricarea de mașini, utilaje și echipamente"),
    "29": ("manufacturing_industrial","Fabricarea autovehiculelor de transport rutier"),
    "30": ("manufacturing_industrial","Fabricarea altor mijloace de transport"),
    "31": ("manufacturing_consumer", "Fabricarea de mobilă"),
    "32": ("manufacturing_consumer", "Alte activități industriale"),
    "33": ("manufacturing_industrial","Repararea, întreținerea și instalarea mașinilor și echipamentelor"),
    # Utilities
    "35": ("utilities",              "Producția și furnizarea de energie electrică și termică"),
    "36": ("utilities",              "Captarea, tratarea și distribuția apei"),
    "37": ("utilities",              "Colectarea și epurarea apelor uzate"),
    "38": ("utilities",              "Colectarea, tratarea și eliminarea deșeurilor"),
    "39": ("utilities",              "Activități și servicii de decontaminare"),
    # Construction
    "41": ("construction",           "Construcții de clădiri"),
    "42": ("construction",           "Lucrări de geniu civil"),
    "43": ("construction",           "Lucrări speciale de construcții"),
    # Wholesale & retail trade — split auto trade out
    "45": ("retail_general",         "Comerț cu autovehicule"),  # PORSCHE
    "46": ("retail_general",         "Comerț cu ridicata"),
    "47": ("retail_general",         "Comerț cu amănuntul"),
    # Transport & storage
    "49": ("transport_logistics",    "Transporturi terestre"),
    "50": ("transport_logistics",    "Transporturi pe ape"),
    "51": ("transport_logistics",    "Transporturi aeriene"),
    "52": ("transport_logistics",    "Depozitare și activități anexe transporturilor"),
    "53": ("transport_logistics",    "Servicii poștale și de curierat"),
    # Hospitality
    "55": ("hospitality_restaurant", "Hoteluri și alte facilități de cazare"),
    "56": ("hospitality_restaurant", "Restaurante și alte activități de servicii de alimentație"),
    # Information & communications
    "58": ("services_it",            "Activități de editare"),
    "59": ("services_it",            "Producție de filme, video, programe TV"),  # PRO TV
    "60": ("services_it",            "Activități de difuzare programe radio/TV"),
    "61": ("services_it",            "Telecomunicații"),
    "62": ("services_it",            "Servicii IT"),
    "63": ("services_it",            "Servicii de informații"),
    # Financial services (out of our wheelhouse — caller should handle)
    "64": ("financial_services",     "Intermedieri financiare"),
    "65": ("financial_services",     "Asigurări, reasigurări și administrarea fondurilor"),
    "66": ("financial_services",     "Activități anexe intermedierilor financiare"),
    # Real estate
    "68": ("real_estate_commercial", "Tranzacții imobiliare"),
    # Professional, scientific, technical
    "69": ("services_professional",  "Activități juridice și de contabilitate"),
    "70": ("services_professional",  "Consultanță în management"),
    "71": ("services_professional",  "Arhitectură, inginerie, încercări tehnice"),
    "72": ("services_professional",  "Cercetare-dezvoltare"),
    "73": ("services_professional",  "Publicitate și studierea pieței"),
    "74": ("services_professional",  "Alte activități profesionale, științifice și tehnice"),
    "75": ("services_professional",  "Activități veterinare"),
    # Admin & support services
    "77": ("services_admin",         "Activități de închiriere și leasing"),
    "78": ("services_admin",         "Activități ale agențiilor de muncă temporară"),  # ELIT
    "79": ("services_admin",         "Activități ale agențiilor turistice"),
    "80": ("services_admin",         "Activități de protecție și gardă"),
    "81": ("services_admin",         "Activități de servicii pentru clădiri"),
    "82": ("services_admin",         "Servicii administrative de birou și alte servicii de suport"),
    # Public admin / education / health / social
    "84": ("services_public",        "Administrație publică și apărare"),
    "85": ("services_public",        "Învățământ"),
    "86": ("services_public",        "Sănătate"),
    "87": ("services_public",        "Servicii combinate de îngrijire medicală și asistență socială"),
    "88": ("services_public",        "Asistență socială fără cazare"),
    # Arts, entertainment, recreation
    "90": ("services_creative",      "Activități de creație și interpretare artistică"),
    "91": ("services_creative",      "Activități ale bibliotecilor, arhivelor, muzeelor"),
    "92": ("services_creative",      "Activități de jocuri de noroc și pariuri"),
    "93": ("services_creative",      "Activități sportive, recreative și distractive"),
    # Other services
    "94": ("services_other",         "Activități asociative diverse"),
    "95": ("services_other",         "Reparații calculatoare și bunuri personale și de uz casnic"),
    "96": ("services_other",         "Alte activități de servicii pentru populație"),
}


def caen_to_category(caen: Optional[str]) -> Tuple[str, str]:
    """Map a CAEN code (string, 2-5 digits) to its industry_category.

    Returns (category, source_label) where source_label is "exact_2digit"
    if we found a prefix mapping, or "generic" if we had to fall back.
    """
    if not caen:
        return ("generic", "no_caen")
    caen_str = str(caen).strip().lstrip("0")
    if not caen_str:
        return ("generic", "no_caen")
    # Take leading 2 digits; pad if length 1 (rare).
    prefix = caen_str[:2] if len(caen_str) >= 2 else "0" + caen_str
    entry = _PREFIX_MAP.get(prefix)
    if entry:
        return (entry[0], "mapped_2digit")
    return ("generic", "uncatalogued_prefix")


def caen_label_fallback(caen: Optional[str]) -> str:
    """Best-effort human label when the catalogue doesn't carry one.
    Returns the 2-digit-prefix's generic label, or the raw CAEN string."""
    if not caen:
        return "Industry not specified"
    caen_str = str(caen).strip().lstrip("0")
    prefix = caen_str[:2] if len(caen_str) >= 2 else "0" + caen_str
    entry = _PREFIX_MAP.get(prefix)
    return entry[1] if entry else f"CAEN {caen}"
