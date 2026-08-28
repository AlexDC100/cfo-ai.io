"""Source registry, licensing, and the PS7 publishability gate.

Every byte the public RO surface serves must trace to a REGISTERED source
with an asserted license. The registry is data-driven so lane 3's page
footer renders attribution + license from here (``license_line`` /
``attribution_footer_html``) and lane 1's ingesters gate on
``check_ingest_allowed`` before touching a dataset.

License facts (verified live against CKAN package_show, 2026-08 wave
research — treat as ground truth):
  - situatii_financiare_2019..2023 and the recent
    date_de_identificare_platitori snapshots: license_id "CC-BY-4.0"
    (verbatim CKAN).
  - situatii_financiare_2008..2018: license_id "uk-ogl" (the portal's
    legacy default label).
  - situatii_financiare_2025 and situatii_financiare_2024_actualizat:
    license UNSET in CKAN. These are REFUSED by default; the operator may
    override with env PUBLIC_INGEST_UNLICENSED_OK=1, which logs a loud
    notice (the operator confirms terms out-of-band before flipping it).
  - situatii_financiare_2024 (base dataset): not individually
    license-verified in the wave research — kept UNSET here on purpose
    (fail-closed) until a package_show confirmation lands; the override
    env applies the same way.

PS7 belt-and-braces: bilanț files are companies-only by construction, but
CUI namespaces overlap with PFAs, so ``validate_publishable`` is the ONE
predicate pages / sitemaps / search route through (implemented HERE; the
store facade calls it by contract). It requires a positive PJ signal
(TIP_CONTRIB == "PJ" from the identification snapshot, or a J/C-series
trade-register number — F-series = PFA/II/IF is refused), refuses
taken-down CUIs (takedown.is_removed), and refuses thin rows with no
filings. Missing signals fail CLOSED.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from html import escape
from pathlib import Path
from typing import Any, Dict, Iterable, Mapping, Optional, Tuple

from engine.public_ro import takedown as _takedown

logger = logging.getLogger(__name__)

_ENV_UNLICENSED_OK = "PUBLIC_INGEST_UNLICENSED_OK"

# License ids considered open for our default ingest path.
OPEN_LICENSE_IDS = frozenset({"CC-BY-4.0", "uk-ogl"})

LICENSE_URLS = {
    "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
    "uk-ogl": (
        "https://www.nationalarchives.gov.uk/doc/open-government-licence/"
    ),
}


@dataclass(frozen=True)
class Source:
    id: str
    name: str
    url: str
    license_id: Optional[str]
    license_url: Optional[str]
    terms_note: str
    added: str  # ISO date the source entered the registry


SOURCE_REGISTRY: Dict[str, Source] = {
    s.id: s
    for s in (
        Source(
            id="mfinante_datagov",
            name=(
                "Ministerul Finanțelor — situații financiare"
                " anuale (data.gov.ro)"
            ),
            url="https://data.gov.ro/organization/mfp",
            license_id="CC-BY-4.0",
            license_url=LICENSE_URLS["CC-BY-4.0"],
            terms_note=(
                "Yearly bilanț indicator extracts (OMF 1420/2021)."
                " Per-dataset license varies by year — see"
                " DATAGOV_DATASET_LICENSES; FY2025 and 2024_actualizat are"
                " unset in CKAN and refused by default. Bulk downloads are"
                " sequential with backoff; the server ignores HTTP Range."
            ),
            added="2026-08-28",
        ),
        Source(
            id="mfinante_datagov_identificare",
            name=(
                "ANAF/MF — date de identificare plătitori"
                " (data.gov.ro, June snapshots)"
            ),
            url=(
                "https://data.gov.ro/dataset/"
                "date_de_identificare_platitori_actualizate_iunie_2026"
            ),
            license_id="CC-BY-4.0",
            license_url=LICENSE_URLS["CC-BY-4.0"],
            terms_note=(
                "Current-state taxpayer identification snapshot (name,"
                " county, TIP_CONTRIB). PF rows are never ingested or"
                " published (PS7). ISO-8859-2 / caret-delimited (2026)."
            ),
            added="2026-08-28",
        ),
        Source(
            id="anaf_v9",
            name="ANAF — serviciul web PlatitorTvaRest v9",
            url=(
                "https://static.anaf.ro/static/10/Anaf/Informatii_R/"
                "Servicii_web/doc_WS_V9.txt"
            ),
            license_id="anaf-public-webservice",
            license_url=(
                "https://static.anaf.ro/static/10/Anaf/Informatii_R/"
                "Servicii_web/doc_WS_V9.txt"
            ),
            terms_note=(
                "Public no-auth API; published limits: max 100 CUIs per"
                " request, MAX 1 request/second (penalty clause) —"
                " hard-enforced by the adapter. Current-state data only."
            ),
            added="2026-08-28",
        ),
        # Pluggable licensed-provider slot (PS contract): stays refused
        # until an operator configures a real provider + license terms.
        Source(
            id="licensed_provider",
            name="Licensed data provider (unconfigured slot)",
            url="",
            license_id=None,
            license_url=None,
            terms_note=(
                "Reserved slot for a commercial/licensed enrichment"
                " provider. license_id is None until configured, so every"
                " gate refuses it by construction."
            ),
            added="2026-08-28",
        ),
    )
}


def _datagov_year_licenses() -> Dict[str, Optional[str]]:
    out: Dict[str, Optional[str]] = {}
    for year in range(2008, 2019):
        out["situatii_financiare_%d" % year] = "uk-ogl"
    for year in range(2019, 2024):
        out["situatii_financiare_%d" % year] = "CC-BY-4.0"
    # 2023 slug exception on the portal (no underscore before the year).
    out["situatii_financiare2023"] = "CC-BY-4.0"
    # FY2024 base: NOT individually license-verified in the wave research —
    # fail-closed None until package_show confirms (see module docstring).
    out["situatii_financiare_2024"] = None
    # Verified UNSET in CKAN — refused by default, env-gated override.
    out["situatii_financiare_2024_actualizat"] = None
    out["situatii_financiare_2025"] = None
    return out


# slug -> license_id (None == no license asserted / not verified).
DATAGOV_DATASET_LICENSES: Dict[str, Optional[str]] = _datagov_year_licenses()


def dataset_license(slug: str) -> Optional[str]:
    """License id for a data.gov.ro dataset slug (None = unset/unknown).
    Identification snapshots match by prefix (all recent = CC-BY-4.0)."""
    if slug in DATAGOV_DATASET_LICENSES:
        return DATAGOV_DATASET_LICENSES[slug]
    if slug.startswith("date_de_identificare_platitori"):
        return "CC-BY-4.0"
    return None


def check_ingest_allowed(slug: str) -> Tuple[bool, str]:
    """Gate an ingest of a data.gov.ro dataset by its license.

    Open license -> allowed. Unset/unknown -> REFUSED unless the operator
    set PUBLIC_INGEST_UNLICENSED_OK=1, in which case ingest proceeds with
    a loud notice (the operator has confirmed terms out-of-band).
    """
    lic = dataset_license(slug)
    if lic in OPEN_LICENSE_IDS:
        return True, "license %s" % lic
    if os.environ.get(_ENV_UNLICENSED_OK) == "1":
        logger.warning(
            "[public-ro compliance] NOTICE: ingesting dataset %r WITHOUT an"
            " asserted open license because %s=1 was set by the operator."
            " Confirm reuse terms with Ministerul Finanțelor before"
            " serving this data publicly.",
            slug,
            _ENV_UNLICENSED_OK,
        )
        return True, "unlicensed override (%s=1)" % _ENV_UNLICENSED_OK
    return False, (
        "dataset %r has no asserted open license in CKAN; refused by"
        " default (set %s=1 only after confirming terms)" % (slug, _ENV_UNLICENSED_OK)
    )


class UnlicensedSourceError(RuntimeError):
    """Raised when a footer/attribution is requested for a source without
    an asserted license — such a source must never reach a public page."""


def get_source(source_id: str) -> Source:
    try:
        return SOURCE_REGISTRY[source_id]
    except KeyError:
        raise KeyError(
            "unregistered public-ro source %r — every dataset row must"
            " reference a SOURCE_REGISTRY id" % source_id
        )


def license_line(dataset_id: str) -> str:
    """Attribution + license sentence for a page footer (lane 3 contract).

    ``dataset_id`` is a SOURCE_REGISTRY id. Unregistered ids raise
    KeyError; a registered source with no asserted license raises
    UnlicensedSourceError — both mean "do not render this page".
    """
    src = get_source(dataset_id)
    if not src.license_id:
        raise UnlicensedSourceError(
            "source %r has no asserted license; refusing to attribute it"
            " on a public page" % dataset_id
        )
    line = "Sursa datelor: %s · Licență: %s" % (src.name, src.license_id)
    if src.license_url:
        line += " (%s)" % src.license_url
    return line


def attribution_footer_html(dataset_ids: Iterable[str]) -> str:
    """Inline-styled footer block with one license line per source —
    the building block lane 3 embeds in every rendered page."""
    lines = []
    for dataset_id in dataset_ids:
        src = get_source(dataset_id)
        text = escape(license_line(dataset_id))
        if src.url:
            text += ' · <a href="%s" rel="license noopener">%s</a>' % (
                escape(src.url, quote=True),
                escape(src.url),
            )
        lines.append(
            '<p style="margin:2px 0;font-size:12px;color:#666">%s</p>' % text
        )
    return (
        '<div class="public-ro-attribution" style="margin-top:24px;'
        'border-top:1px solid #d6dde6;padding-top:8px">%s</div>'
        % "".join(lines)
    )


# ──────────────────────────────────────────────────────────────────────
# PS7 — publishability gate
# ──────────────────────────────────────────────────────────────────────

# Trade-register series letters: J = company, C = cooperative (publishable);
# F = PFA/II/IF (natural-person forms — never publishable).
_PUBLISHABLE_REGISTER_SERIES = frozenset({"J", "C"})


def _register_series(reg_number: Optional[str]) -> Optional[str]:
    if not reg_number:
        return None
    for ch in str(reg_number).strip():
        if ch.isalpha():
            return ch.upper()
    return None


def publishable_reason(
    company_row: Mapping[str, Any],
    *,
    db_path: Optional[Path] = None,
) -> Tuple[bool, str]:
    """(publishable, reason). Row contract (store facade):

      cui           int, required
      tip_contrib   "PJ"/"PF" from the identification snapshot (optional)
      reg_number    trade-register string, e.g. "J40/1234/2001" (optional)
      has_filings   bool, or
      filing_years  iterable of years with a bilanț row

    Fail-closed: with NEITHER a PJ tip_contrib NOR a J/C-series register
    number, the CUI is not publishable (belt-and-braces vs the CUI
    namespace overlap with PFAs).
    """
    cui = company_row.get("cui")
    if not isinstance(cui, int) or cui <= 0:
        return False, "missing or invalid cui"

    tip = company_row.get("tip_contrib")
    tip_norm = str(tip).strip().upper() if tip is not None else None
    series = _register_series(company_row.get("reg_number"))

    if tip_norm == "PF":
        return False, "TIP_CONTRIB=PF (natural person)"
    if series == "F":
        return False, "F-series register number (PFA/II/IF)"
    pj_signal = tip_norm == "PJ" or series in _PUBLISHABLE_REGISTER_SERIES
    if not pj_signal:
        return False, "no positive PJ signal (fail-closed)"

    if _takedown.is_removed(cui, db_path):
        return False, "taken down (operator remove)"

    has_filings = bool(company_row.get("has_filings"))
    years = company_row.get("filing_years") or ()
    if not has_filings and not any(True for _ in years):
        return False, "no filings (thin row)"

    return True, "ok"


def validate_publishable(
    company_row: Mapping[str, Any],
    *,
    db_path: Optional[Path] = None,
) -> bool:
    """The single PS7 predicate pages / sitemaps / search route through
    (the store facade delegates here by contract)."""
    ok, _ = publishable_reason(company_row, db_path=db_path)
    return ok
