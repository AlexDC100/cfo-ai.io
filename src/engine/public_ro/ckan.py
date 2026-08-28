"""CKAN discovery for the data.gov.ro bilanț datasets (org "mfp").

VERIFIED (live research, 2026-08):
  - One dataset per fiscal year FY2008-FY2025, slug
    situatii_financiare_<YEAR>. Exceptions: FY2023 is
    ``situatii_financiare2023`` (no underscore before the year) and a
    separate ``situatii_financiare_2024_actualizat`` re-upload exists.
  - Portal hygiene is POOR: grab-bag years (the 2020/2021 datasets hold
    files for 2011-2021), test artifacts ("test.docx" typed as XLSX,
    9-byte fisier_test.txt), misnamed resources ("WEB_ONG_AN2019;.txt"),
    duplicate "actualizat" re-uploads. Resource discovery therefore
    goes through package_show with FUZZY name matching against BOTH the
    resource name and the URL basename.
  - The data file is the ``.txt`` (comma CSV, header CUI,CAEN,I1..I20);
    the SAME-NAMED ``.csv`` is the column SPEC (label;code pairs).
  - data.gov.ro IGNORES HTTP Range headers (verified: a 6MB range
    request returned the full 435MB file) — plan full downloads only.
  - License: FY2019-FY2023 = CC-BY-4.0 (verbatim CKAN license_id);
    FY2018-earlier = legacy "uk-ogl" label; FY2025 and
    2024_actualizat = license UNSET in CKAN (ingest gate in ingest.py).

Fetching uses urllib stdlib; the fetcher is injectable so tests stay
fully offline.
"""
from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional

CKAN_PACKAGE_SHOW = "https://data.gov.ro/api/3/action/package_show?id={slug}"

#: Family -> filename stem pattern (normalized: lowercase alnum only).
FAMILY_STEMS = {
    "UU": "webuuan{year}",
    "BL": "webblbsslan{year}",
    "ONG": "webongan{year}",
}

USER_AGENT = "cfo-ai.io public-data spine (contact: cfo-ai.io)"


class CkanError(RuntimeError):
    pass


class ResourceNotFound(CkanError):
    pass


Fetcher = Callable[[str], bytes]


def default_fetcher(url: str, timeout: int = 300) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
        return resp.read()


def slug_for_year(year: int) -> str:
    if int(year) == 2023:
        return "situatii_financiare2023"  # verified portal exception
    return "situatii_financiare_%d" % int(year)


ACTUALIZAT_SLUGS = {2024: "situatii_financiare_2024_actualizat"}


def package_show(slug: str, fetcher: Optional[Fetcher] = None) -> Dict[str, Any]:
    fetch = fetcher or default_fetcher
    raw = fetch(CKAN_PACKAGE_SHOW.format(slug=urllib.parse.quote(slug)))
    try:
        doc = json.loads(raw.decode("utf-8"))
    except ValueError as exc:
        raise CkanError("package_show %s returned non-JSON: %s" % (slug, exc))
    if not doc.get("success") or not isinstance(doc.get("result"), dict):
        raise CkanError("package_show %s: success=%r" % (slug, doc.get("success")))
    return doc["result"]


def _normalize_name(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (text or "").lower())


def _url_basename(url: str) -> str:
    path = urllib.parse.urlparse(url or "").path
    return path.rsplit("/", 1)[-1]


def _resource_matches(res: Dict[str, Any], stem: str, ext: str) -> bool:
    """Fuzzy match on resource name OR url basename; the extension is
    taken from the URL basename (resource 'format' fields are dirty —
    a test.docx typed XLSX exists on the portal)."""
    basename = _url_basename(res.get("url") or "")
    norm_name = _normalize_name(res.get("name") or "")
    norm_base = _normalize_name(basename)
    if not basename.lower().endswith("." + ext):
        return False
    return stem in norm_name or stem in norm_base


def find_resources(
    pkg: Dict[str, Any], *, year: int, family: str
) -> Dict[str, Dict[str, Any]]:
    """Locate the data .txt and its companion spec .csv for a family in
    a package. Deterministic on messy portals: candidates are sorted by
    (last_modified or created or '') and the NEWEST wins (re-uploads
    supersede)."""
    stem = FAMILY_STEMS[family].format(year=int(year))
    resources = [r for r in pkg.get("resources") or [] if isinstance(r, dict)]

    def newest(matches: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not matches:
            return None
        return sorted(
            matches,
            key=lambda r: (
                str(r.get("last_modified") or r.get("created") or ""),
                str(r.get("id") or ""),
            ),
        )[-1]

    data = newest([r for r in resources if _resource_matches(r, stem, "txt")])
    spec = newest([r for r in resources if _resource_matches(r, stem, "csv")])
    if data is None:
        raise ResourceNotFound(
            "no %s data .txt matching %r in dataset %s"
            % (family, stem, pkg.get("name"))
        )
    if spec is None:
        raise ResourceNotFound(
            "no companion spec .csv matching %r in dataset %s — the "
            "i-code layout cannot be resolved without it (drift trap); "
            "refusing" % (stem, pkg.get("name"))
        )
    return {"data": data, "spec": spec}


def dataset_license(pkg: Dict[str, Any]) -> Dict[str, Optional[str]]:
    return {
        "license_id": pkg.get("license_id") or None,
        "license_title": pkg.get("license_title") or None,
    }


def discover_year(
    year: int,
    *,
    family: str = "UU",
    fetcher: Optional[Fetcher] = None,
    slug: Optional[str] = None,
) -> Dict[str, Any]:
    """Resolve (year, family) to concrete download URLs + license via
    package_show. ``slug`` overrides for the 2024_actualizat variant."""
    the_slug = slug or slug_for_year(year)
    pkg = package_show(the_slug, fetcher=fetcher)
    found = find_resources(pkg, year=year, family=family)
    lic = dataset_license(pkg)
    return {
        "slug": the_slug,
        "year": int(year),
        "family": family,
        "license_id": lic["license_id"],
        "license_title": lic["license_title"],
        "data_url": found["data"].get("url"),
        "data_resource_id": found["data"].get("id"),
        "spec_url": found["spec"].get("url"),
        "spec_resource_id": found["spec"].get("id"),
    }
