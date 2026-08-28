"""Programmatic SEO for the public RO company directory (lane 4, part C).

Sitemap generation + serving, regeneration journal, and the URL/slug
vocabulary shared by the hub pages (pages/hubs.py) and — by contract —
the per-company pages (lane 3).

Sitemap shape
-------------
Shards are written to ``data/public_sitemaps/`` (override via
``PUBLIC_SITEMAP_DIR``), gzip-compressed, at most :data:`SHARD_MAX_URLS`
URLs per shard (the sitemaps.org hard limit of 50,000). ``sitemap.xml``
(the sitemap index, uncompressed) references every shard by its clean
canonical URL ``https://cfo-ai.io/sitemaps/<shard>.xml.gz``. ``lastmod``
comes from the ingested dataset_version's fetch date (lane 1 provenance),
never from wall-clock generation time.

Inclusion policy (PS6):
  * company URLs — ONLY publishable companies with >= 1 filing year.
    Thin / no-data CUIs are excluded here even if the store hands them
    over (belt-and-braces), and every CUI in the takedowns table
    (engine.public_ro.takedown.removed_cuis, lane 6) is excluded — a
    takedown disappears from the sitemap within one regen call.
  * company URLs are the RO form only (``/companii/{cui}-{slug}``);
    the EN twin is expressed on-page via hreflang, not in the sitemap.
  * hub URLs — sector + county hubs with at least
    :data:`HUB_MIN_COMPANIES` companies (below that the page itself is
    noindex, so listing it would contradict the on-page directive),
    in BOTH languages (each hub page is self-canonical per language).
  * the two directory index pages ``/companii`` and ``/companies``.

Serving: ``build_sitemap_router()`` serves ``/sitemap.xml`` +
``/sitemaps/{shard}.xml.gz`` from the generated files (404 until
generated) AND the ``/api/public/ro/...`` twins so everything is
reachable through the existing Caddy ``/api/*`` matcher before the
operator adds the clean-path matcher. When the request Host is not the
canonical domain (api.cfo-ai.io duplicate-host risk), responses carry
``X-Robots-Tag: noindex``.

Verified data facts cited: dataset slugs situatii_financiare_<YEAR>
(FY2008-FY2025, org mfp on data.gov.ro CKAN); mass files
WEB_UU_AN<yr>.txt / WEB_BL_BS_SL_AN<yr>.txt are companies-only by
construction, and the identification join gates on TIP_CONTRIB==PJ
before a CUI becomes publishable (PS7) — this module additionally
re-checks nothing about PF because the store contract only yields
publishable PJ rows; the year / takedown filters here are the
belt-and-braces PS6 layer.

AI: none. Deterministic output; zero anthropic imports (wave contract).
"""

from __future__ import annotations

import functools
import gzip
import hashlib
import io
import json
import os
import re
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from xml.sax.saxutils import escape as _xml_escape

from fastapi import APIRouter, Request, Response

# ── constants ──────────────────────────────────────────────────────────

#: sitemaps.org hard limit per sitemap file.
SHARD_MAX_URLS = 50_000

#: A hub page with fewer companies than this is rendered noindex
#: (pages/hubs.py) and therefore EXCLUDED from the sitemap — the two
#: policies must agree or the PS6 gate would sample a noindex URL.
HUB_MIN_COMPANIES = 3

_ENV_SITEMAP_DIR = "PUBLIC_SITEMAP_DIR"
_DEFAULT_SITEMAP_DIR = Path("data") / "public_sitemaps"

_SITEMAP_NS = "http://www.sitemaps.org/schemas/sitemap/0.9"
_SHARD_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")

_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400"

_JOURNAL_NAME = "_journal.jsonl"
_MANIFEST_NAME = "manifest.json"


# ── site identity ──────────────────────────────────────────────────────

def canonical_base() -> str:
    """Canonical absolute origin (no trailing slash), from the backend
    mirror of the FE SITE constant (src/engine/api/_site.py)."""
    try:
        from engine.api._site import SITE  # single source of truth
        return str(SITE["url"]).rstrip("/")
    except Exception:  # pragma: no cover — _site.py is stable repo infra
        return "https://cfo-ai.io"


def canonical_domain() -> str:
    try:
        from engine.api._site import SITE
        return str(SITE["domain"])
    except Exception:  # pragma: no cover
        return "cfo-ai.io"


def host_is_canonical(request: Request) -> bool:
    """True when the request Host header is the canonical public domain.

    api.cfo-ai.io routes to the same backend (Caddyfile 137-147): identical
    HTML on a second host is a duplicate-content risk, so every non-canonical
    host gets X-Robots-Tag: noindex from the routes in this package.
    """
    host = (request.headers.get("host") or "").split(":")[0].strip().lower()
    return host == canonical_domain()


def robots_headers_for(request: Request) -> Dict[str, str]:
    if host_is_canonical(request):
        return {}
    return {"X-Robots-Tag": "noindex"}


# ── slug / URL vocabulary (shared with hubs + lane 3 by contract) ──────

_RO_DIACRITICS = str.maketrans(
    {"ă": "a", "â": "a", "î": "i", "ș": "s", "ş": "s", "ț": "t", "ţ": "t",
     "Ă": "a", "Â": "a", "Î": "i", "Ș": "s", "Ş": "s", "Ț": "t", "Ţ": "t"}
)


def slugify(text: str) -> str:
    """Lowercase ASCII slug: Romanian diacritics folded, everything
    non-alphanumeric collapsed to single hyphens."""
    text = (text or "").translate(_RO_DIACRITICS)
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text or "x"


def company_path(cui: int, slug: str, lang: str = "ro") -> str:
    prefix = "/companii" if lang == "ro" else "/companies"
    return "%s/%d-%s" % (prefix, int(cui), slug)


def sector_slug(caen2_code: str, label: str) -> str:
    """Hub slug for a CAEN 2-digit division, e.g. ``10-industria-alimentara``.
    CAEN rev is detected per year upstream (lane 1) — the slug carries only
    the 2-digit code + label, never a rev assumption."""
    return "%s-%s" % (str(caen2_code).strip(), slugify(label))


def county_slug(label: str) -> str:
    return slugify(label)


def hub_path(kind: str, slug: str, lang: str = "ro") -> str:
    if kind == "sector":
        prefix = "/sector" if lang == "ro" else "/sectors"
    elif kind == "judet":
        prefix = "/judet" if lang == "ro" else "/counties"
    else:
        raise ValueError("unknown hub kind: %r" % (kind,))
    return "%s/%s" % (prefix, slug)


def index_path(lang: str = "ro") -> str:
    return "/companii" if lang == "ro" else "/companies"


# ── store contract (lane 2) ────────────────────────────────────────────
# Coded against by contract; the concrete module may not have landed yet.
# Required surface (duck-typed, verified at call time):
#   store.publishable_companies() -> iterable of dicts with at least
#       {cui:int, name:str} and either years:list[int] or latest_year:int;
#       optional slug:str. Rows are PJ-only by the PS7 gate upstream.
#   store.hub_keys(kind:str) -> list of dicts {slug:str, label_ro:str,
#       company_count:int} (optional label_en).
#   store.dataset_version() -> dict {version:str, fetch_date:"YYYY-MM-DD"}
#       or None before first ingest.

def _open_default_store() -> Any:
    try:
        from engine.public_ro import store as store_mod  # lane 2 contract
    except ImportError as exc:  # pragma: no cover — depends on lane 2 landing
        raise RuntimeError(
            "engine.public_ro.store is not available yet (lane 2). "
            "Pass an explicit store object, or land the store module "
            "exposing open_store()/PublicStore/connect."
        ) from exc
    # PublicRoStore is the name the store module actually shipped; the
    # other three were the contract guesses this module was written
    # against while the lanes built in parallel. Keep all four so a
    # future rename on either side degrades to a clear error, not a
    # silent unopened store.
    for name in ("PublicRoStore", "open_store", "PublicStore", "connect"):
        factory = getattr(store_mod, name, None)
        if factory is not None:
            return factory()
    raise RuntimeError(
        "engine.public_ro.store exposes none of "
        "PublicRoStore/open_store/PublicStore/connect"
    )  # pragma: no cover


def _takedown_cuis() -> frozenset:
    """CUIs removed via the PS8 takedown flow (lane 6) — excluded from
    every shard; called once per regeneration per the takedown contract."""
    try:
        from engine.public_ro.takedown import removed_cuis
    except ImportError:  # pragma: no cover — takedown.py is landed repo code
        return frozenset()
    return removed_cuis()


# ── sitemap XML writers ────────────────────────────────────────────────

def sitemap_dir(path: Optional[Path] = None) -> Path:
    if path is not None:
        return Path(path)
    override = os.environ.get(_ENV_SITEMAP_DIR)
    return Path(override) if override else _DEFAULT_SITEMAP_DIR


def _atomic_write(path: Path, data: bytes) -> None:
    """Same-directory temp + fsync + os.replace (engine.journal.store
    discipline): a crash never leaves a half-written shard at a valid name."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-%s-" % path.name[:16],
                               dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, str(path))
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _urlset_xml(urls: Sequence[str], lastmod: Optional[str]) -> bytes:
    parts = ['<?xml version="1.0" encoding="UTF-8"?>\n',
             '<urlset xmlns="%s">\n' % _SITEMAP_NS]
    lm = "<lastmod>%s</lastmod>" % _xml_escape(lastmod) if lastmod else ""
    for u in urls:
        parts.append("<url><loc>%s</loc>%s</url>\n" % (_xml_escape(u), lm))
    parts.append("</urlset>\n")
    return "".join(parts).encode("utf-8")


def _gzip_bytes(data: bytes) -> bytes:
    """Deterministic gzip (mtime=0, no filename): same input, same bytes —
    keeps the disk cache / ETag stable across regenerations with no delta."""
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
        gz.write(data)
    return buf.getvalue()


def _chunk(seq: List[str], size: int) -> Iterable[List[str]]:
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def _company_years(row: Dict[str, Any]) -> List[int]:
    years = row.get("years")
    if years:
        return [int(y) for y in years]
    latest = row.get("latest_year")
    return [int(latest)] if latest else []


def collect_company_urls(store: Any,
                         takedowns: Optional[frozenset] = None,
                         base: Optional[str] = None,
                         ) -> Tuple[List[str], Dict[str, int]]:
    """RO-form company URLs for every publishable company with >= 1 filing
    year, minus takedowns. Returns (urls, exclusion_counts)."""
    base = base or canonical_base()
    removed = _takedown_cuis() if takedowns is None else takedowns
    urls: List[str] = []
    excluded = {"thin": 0, "takedown": 0}
    seen = set()
    for row in store.publishable_companies():
        cui = int(row["cui"])
        if cui in seen:
            continue
        seen.add(cui)
        if not _company_years(row):        # PS6: thin / no-data CUI
            excluded["thin"] += 1
            continue
        if cui in removed:                 # lane 6 takedown
            excluded["takedown"] += 1
            continue
        slug = row.get("slug") or slugify(str(row.get("name", "")))
        urls.append(base + company_path(cui, slug, "ro"))
    return urls, excluded


def collect_hub_urls(store: Any, base: Optional[str] = None) -> List[str]:
    """Hub URLs (both languages, self-canonical each) + the two directory
    index pages. Hubs below HUB_MIN_COMPANIES are noindex on-page, so
    they are not listed."""
    base = base or canonical_base()
    urls: List[str] = [base + index_path("ro"), base + index_path("en")]
    hub_keys = getattr(store, "hub_keys", None)
    if hub_keys is None:
        return urls
    for kind in ("sector", "judet"):
        for entry in hub_keys(kind):
            if int(entry.get("company_count", 0)) < HUB_MIN_COMPANIES:
                continue
            slug = entry.get("slug") or entry.get("key")
            if not slug:
                continue
            urls.append(base + hub_path(kind, str(slug), "ro"))
            urls.append(base + hub_path(kind, str(slug), "en"))
    return urls


def generate_sitemaps(store: Any,
                      out_dir: Optional[Path] = None,
                      base_url: Optional[str] = None) -> Dict[str, Any]:
    """Write all shards + the sitemap index + manifest.json atomically.
    Pure function of the store snapshot (company set, hub keys,
    dataset_version) — same snapshot, byte-identical output.
    Returns the manifest dict."""
    out = sitemap_dir(out_dir)
    base = (base_url or canonical_base()).rstrip("/")

    dsv = store.dataset_version() if hasattr(store, "dataset_version") else None
    lastmod = None
    if isinstance(dsv, dict):
        lastmod = dsv.get("fetch_date")

    company_urls, excluded = collect_company_urls(store, base=base)
    hub_urls = collect_hub_urls(store, base=base)

    shards: List[Dict[str, Any]] = []

    def _write_family(family: str, urls: List[str]) -> None:
        for i, chunk in enumerate(_chunk(urls, SHARD_MAX_URLS), start=1):
            name = "%s-%05d" % (family, i)
            payload = _gzip_bytes(_urlset_xml(chunk, lastmod))
            _atomic_write(out / ("%s.xml.gz" % name), payload)
            shards.append({
                "name": name,
                "url_count": len(chunk),
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            })

    _write_family("companies", company_urls)
    _write_family("hubs", hub_urls)

    # Sitemap index — clean canonical URLs always (the /api/public/ro twins
    # are a transport detail, never advertised to crawlers).
    idx = ['<?xml version="1.0" encoding="UTF-8"?>\n',
           '<sitemapindex xmlns="%s">\n' % _SITEMAP_NS]
    lm = "<lastmod>%s</lastmod>" % _xml_escape(lastmod) if lastmod else ""
    for s in shards:
        idx.append("<sitemap><loc>%s/sitemaps/%s.xml.gz</loc>%s</sitemap>\n"
                   % (_xml_escape(base), s["name"], lm))
    idx.append("</sitemapindex>\n")
    _atomic_write(out / "sitemap.xml", "".join(idx).encode("utf-8"))

    # Drop shards from previous generations that no longer exist.
    live = {"%s.xml.gz" % s["name"] for s in shards}
    for stale in out.glob("*.xml.gz"):
        if stale.name not in live:
            try:
                stale.unlink()
            except OSError:  # pragma: no cover
                pass

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "base_url": base,
        "dataset_version": (dsv or {}).get("version") if isinstance(dsv, dict) else None,
        "lastmod": lastmod,
        "total_urls": len(company_urls) + len(hub_urls),
        "company_urls": len(company_urls),
        "hub_urls": len(hub_urls),
        "excluded": excluded,
        "shards": shards,
    }
    _atomic_write(out / _MANIFEST_NAME,
                  json.dumps(manifest, indent=1, sort_keys=True).encode("utf-8"))
    return manifest


# ── regeneration job (journaled) ───────────────────────────────────────

def regenerate(affected_by_dataset_version: Optional[str] = None,
               store: Optional[Any] = None,
               out_dir: Optional[Path] = None,
               trigger: str = "manual") -> Dict[str, Any]:
    """Regenerate every shard and append a journal line.

    Called by scripts/public_seo.py (``sitemaps`` subcommand) and — by
    contract — from the lane-1 ingest script after a dataset_version
    lands (see wiring notes). The journal is an append-only JSONL beside
    the shards (the engine.journal event vocabulary is a CLOSED frozenset,
    same reasoning as takedown.py's audit-trail decision, so sitemap
    regens keep their own trail instead of minting a new event kind).
    """
    if store is None:
        store = _open_default_store()
    out = sitemap_dir(out_dir)
    manifest = generate_sitemaps(store, out_dir=out)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": "sitemap_regen",
        "trigger": trigger,
        "affected_by_dataset_version": affected_by_dataset_version,
        "dataset_version": manifest["dataset_version"],
        "total_urls": manifest["total_urls"],
        "shards": [s["name"] for s in manifest["shards"]],
        "excluded": manifest["excluded"],
    }
    journal_path = out / _JOURNAL_NAME
    journal_path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(entry, sort_keys=True) + "\n"
    with open(journal_path, "a", encoding="utf-8") as fh:
        fh.write(line)
        fh.flush()
        os.fsync(fh.fileno())
    return manifest


def read_journal(out_dir: Optional[Path] = None) -> List[Dict[str, Any]]:
    path = sitemap_dir(out_dir) / _JOURNAL_NAME
    if not path.is_file():
        return []
    entries = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            entries.append(json.loads(line))
    return entries


# ── serving ────────────────────────────────────────────────────────────

@functools.lru_cache(maxsize=64)
def _cached_file(path_str: str, mtime_ns: int, size: int) -> bytes:
    # (mtime_ns, size) key the cache entry to the on-disk generation; a
    # regen replaces the file atomically and naturally misses the cache.
    return Path(path_str).read_bytes()


def _read_generated(path: Path) -> Optional[bytes]:
    try:
        st = path.stat()
    except OSError:
        return None
    return _cached_file(str(path), st.st_mtime_ns, st.st_size)


def _etag_for(data: bytes) -> str:
    return '"%s"' % hashlib.sha256(data).hexdigest()[:20]


def build_sitemap_router(out_dir: Optional[Path] = None) -> APIRouter:
    """Router serving /sitemap.xml + /sitemaps/{shard}.xml.gz plus the
    /api/public/ro twins. 404 until ``generate_sitemaps`` has run.

    Registered with NO prefix (paths are absolute) — the aggregate router
    (lane 3) includes it via try/except ImportError.
    """
    router = APIRouter(tags=["public-ro-seo"])
    configured_dir = out_dir  # resolved per-request so env/tests can retarget

    def _dir() -> Path:
        return sitemap_dir(configured_dir)

    def _serve_index(request: Request) -> Response:
        data = _read_generated(_dir() / "sitemap.xml")
        if data is None:
            return Response(status_code=404,
                            content=b"sitemap not generated yet",
                            media_type="text/plain")
        headers = {"Cache-Control": _CACHE_CONTROL, "ETag": _etag_for(data)}
        headers.update(robots_headers_for(request))
        return Response(content=data, media_type="application/xml",
                        headers=headers)

    def _serve_shard(request: Request, shard: str) -> Response:
        if not _SHARD_NAME_RE.match(shard):
            return Response(status_code=404, content=b"unknown shard",
                            media_type="text/plain")
        data = _read_generated(_dir() / ("%s.xml.gz" % shard))
        if data is None:
            return Response(status_code=404, content=b"unknown shard",
                            media_type="text/plain")
        headers = {"Cache-Control": _CACHE_CONTROL, "ETag": _etag_for(data)}
        headers.update(robots_headers_for(request))
        # Served as a gzip FILE (sitemaps.org convention for .xml.gz),
        # not as Content-Encoding'd XML.
        return Response(content=data, media_type="application/gzip",
                        headers=headers)

    @router.get("/sitemap.xml", include_in_schema=False)
    def sitemap_index(request: Request) -> Response:  # pragma: no cover — thin wrapper
        return _serve_index(request)

    @router.get("/sitemaps/{shard}.xml.gz", include_in_schema=False)
    def sitemap_shard(request: Request, shard: str) -> Response:  # pragma: no cover
        return _serve_shard(request, shard)

    # /api/public/ro twins — reachable through the existing Caddy matcher
    # with zero infra change; never advertised as canonical.
    @router.get("/api/public/ro/sitemap.xml", include_in_schema=False)
    def sitemap_index_api(request: Request) -> Response:  # pragma: no cover
        return _serve_index(request)

    @router.get("/api/public/ro/sitemaps/{shard}.xml.gz", include_in_schema=False)
    def sitemap_shard_api(request: Request, shard: str) -> Response:  # pragma: no cover
        return _serve_shard(request, shard)

    return router
