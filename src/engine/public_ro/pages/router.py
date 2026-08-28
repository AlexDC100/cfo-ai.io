"""THE aggregate public-RO router (lane 3) — storefront + sub-lanes.

Mounts, on one APIRouter:
  - the company pages + index/search pages (this module),
  - the OG image route,
  - the JSON search endpoint,
  - sub-routers from sibling lanes via try/except ImportError so partial
    lane states stay importable (mission rule):
      engine.public_ro.seo.build_sitemap_router      (lane 4)
      engine.public_ro.funnel.build_funnel_router    (lane 5)
      engine.public_ro.takedown.build_takedown_router (lane 6)

Every route exists BOTH at its clean path (/companii/..., /og/...) and
under /api/public/ro/* — the existing Caddy matcher (@api path /api/*)
already reaches the backend, so the surface works before the operator
adds the one-line Caddy matcher for the clean paths. The canonical URL
in every page is ALWAYS the clean https://cfo-ai.io form
(seo.canonical_base()); any request whose Host is not the canonical
domain gets X-Robots-Tag: noindex (seo.robots_headers_for — the
api.cfo-ai.io duplicate-host risk).

Serving discipline:
  - real HTML 404 for unknown/unpublishable CUIs (the SPA's soft-404
    problem must not repeat here), real 410 for taken-down CUIs;
  - 301 to the canonical slug for /companii/<cui>-<wrong-slug>;
  - Cache-Control: public, max-age=3600, stale-while-revalidate=86400;
  - light token-bucket rate limit (engine.public_ro.ratelimit.check,
    crawler UAs exempt by UA string — DNS verification is future work);
  - page bytes cached per (cui, year, dataset_version, lang) — disk +
    in-process LRU (cache.PageCache).
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from engine.public_ro import ratelimit
from engine.public_ro.seo import canonical_base, company_path, robots_headers_for

from .cache import PageCache
from .i18n import STRINGS
from .model import build_page_model, fmt_compact_ron, fmt_int, net_result_of
from .og import cached_og_png
from .slug import canonical_slug, parse_company_key
from .templates import render_company_page, render_error_page, render_index_page

logger = logging.getLogger("engine.public_ro.pages")

CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400"
ERROR_CACHE_CONTROL = "public, max-age=300"

# Percentile metric names read from store.replace_percentiles output —
# the percentile-computation job must write these exact names (metric
# column) for the sector-position bars to render.
_PERCENTILE_METRICS = ("revenue", "net_result", "employees")

_SUB_ROUTERS = (
    ("engine.public_ro.seo", "build_sitemap_router"),
    ("engine.public_ro.funnel", "build_funnel_router"),
    ("engine.public_ro.takedown", "build_takedown_router"),
    # Sector / county hub pages (/sector/…, /judet/… + EN twins) — the
    # hub→company→hub internal linking the SEO engine depends on.
    ("engine.public_ro.pages.hubs", "build_hub_router"),
    # Operator-only teardown drafts (ENGINE_API_TOKEN fail-closed).
    ("engine.public_ro.teardown", "build_teardown_router"),
)


# ── store resolution (lane 2 contract: engine.public_ro.store) ─────────

_default_store: Any = None


def _resolve_store() -> Optional[Any]:
    """Process-cached default PublicRoStore. Lazy so the router mounts
    (and tests import) without touching data/public_ro.db."""
    global _default_store
    if _default_store is not None:
        return _default_store
    try:
        from engine.public_ro.store import PublicRoStore

        _default_store = PublicRoStore()
        return _default_store
    except Exception:  # pragma: no cover — depends on runtime fs state
        logger.warning("public_ro store unavailable; pages will 404",
                       exc_info=True)
        return None


def reset_default_store() -> None:
    """Test hook: drop the cached default store (env re-read)."""
    global _default_store
    _default_store = None


def _taken_down(store: Any, cui: int) -> bool:
    """Belt-and-braces PS8 check: lane 6's audit-trail authority first,
    then the store takedowns table (schema owner)."""
    try:
        from engine.public_ro.takedown import is_removed

        if is_removed(cui):
            return True
    except Exception:
        pass
    try:
        get_td = getattr(store, "get_takedown", None)
        row = get_td(cui) if callable(get_td) else None
        if row and str(row.get("status", "")).lower() in ("remove", "removed"):
            return True
    except Exception:
        pass
    return False


def _headers(request: Request, *, error: bool = False) -> Dict[str, str]:
    h = {"Cache-Control": ERROR_CACHE_CONTROL if error else CACHE_CONTROL}
    h.update(robots_headers_for(request))
    return h


def _error_html(request: Request, status: int, lang: str) -> HTMLResponse:
    return HTMLResponse(render_error_page(status, lang), status_code=status,
                        headers=_headers(request, error=True))


def _hub_links(store: Any, lang: str) -> List[Dict[str, Any]]:
    """Sector + county hub links for the directory index.

    The hub pages live in pages/hubs.py; this reads the same store
    contract (hub_keys) and builds the links so the ONE served index
    carries both search and the hub directory. Best-effort: a store
    without hub_keys (or a failing query) yields no links rather than a
    500 on the public page.
    """
    try:
        from .hubs import HUB_MIN_COMPANIES, hub_path, _hub_label
    except Exception:  # noqa: BLE001 — hubs module optional at runtime
        return []
    keys = getattr(store, "hub_keys", None)
    if keys is None:
        return []
    out: List[Dict[str, Any]] = []
    for kind in ("sector", "judet"):
        try:
            entries = keys(kind) or []
        except Exception:  # noqa: BLE001
            logger.warning("hub_keys(%s) failed", kind, exc_info=True)
            continue
        for entry in entries:
            try:
                if int(entry.get("company_count", 0)) < HUB_MIN_COMPANIES:
                    continue
                slug = str(entry.get("slug") or entry.get("key") or "")
                if not slug:
                    continue
                out.append({
                    "href": hub_path(kind, slug, lang),
                    "label": _hub_label(entry, lang),
                    "count": entry.get("company_count"),
                })
            except Exception:  # noqa: BLE001 — one bad row never breaks the page
                continue
    return out


def _percentiles_for(store: Any, *, year: int,
                     caen: Optional[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    get_pct = getattr(store, "get_percentiles", None)
    if not callable(get_pct) or not caen:
        return out
    caen2 = str(caen)[:2]
    for metric in _PERCENTILE_METRICS:
        try:
            row = get_pct(year=year, metric=metric, caen2=caen2)
        except Exception:
            row = None
        if row:
            out[metric] = row
    return out


def build_router(store: Any = None, *,
                 page_cache: Optional[PageCache] = None) -> APIRouter:
    router = APIRouter(tags=["public-ro-pages"])
    cache = page_cache or PageCache()

    def _store() -> Optional[Any]:
        return store if store is not None else _resolve_store()

    # ── company page ───────────────────────────────────────────────

    def _company_page(request: Request, key: str, lang: str) -> Response:
        limited = ratelimit.check(request)
        if limited is not None:
            return limited
        parsed = parse_company_key(key)
        if parsed is None:
            return _error_html(request, 404, lang)
        cui, given_slug = parsed
        st = _store()
        if st is None:
            return _error_html(request, 404, lang)
        if _taken_down(st, cui):
            return _error_html(request, 410, lang)
        company = st.get_company(cui)
        # PS7 belt-and-braces: bilanț-only CUIs (publishable=0, possibly
        # PF/PFA before the identification join) never render.
        if not company or not company.get("publishable"):
            return _error_html(request, 404, lang)
        filings = st.get_filings(cui)
        if not filings:
            return _error_html(request, 404, lang)
        slug = canonical_slug(company.get("name"))
        if given_slug != slug:
            return RedirectResponse(
                canonical_base() + company_path(cui, slug, lang),
                status_code=301,
            )
        latest = filings[-1]
        year = int(latest["year"])
        prov = latest.get("provenance") or {}
        dsv = str(prov.get("dataset_id") or "0")
        # The percentile epoch belongs in the key: sector bars come from
        # a job that reruns independently of any filing's dataset_id, so
        # keying on dsv alone served stale bars forever.
        try:
            epoch = str(st.percentiles_epoch())
        except Exception:  # noqa: BLE001 — older store, no epoch column
            epoch = "0"
        cache_key = (cui, year, dsv, lang, epoch)
        html = cache.get(cache_key)
        if html is None:
            pct = _percentiles_for(
                st, year=year, caen=latest.get("caen") or company.get("caen"))
            model = build_page_model(company, filings, percentiles=pct)
            html = render_company_page(model, lang)
            cache.put(cache_key, html)
        return HTMLResponse(html, headers=_headers(request))

    def company_page_ro(request: Request, key: str) -> Response:
        return _company_page(request, key, "ro")

    def company_page_en(request: Request, key: str) -> Response:
        return _company_page(request, key, "en")

    # ── index + server-rendered search ─────────────────────────────

    def _index(request: Request, q: str, lang: str) -> Response:
        limited = ratelimit.check(request)
        if limited is not None:
            return limited
        q = (q or "").strip()[:80]
        results: List[Dict[str, Any]] = []
        if q:
            st = _store()
            if st is not None:
                try:
                    results = st.search_companies(q, limit=20)
                except Exception:
                    logger.warning("search failed", exc_info=True)
        html = render_index_page(lang, query=q, results=results,
                                 hub_links=_hub_links(_store(), lang))
        return HTMLResponse(html, headers=_headers(request))

    # No max_length on the HTML routes: FastAPI answers a violated
    # constraint with a JSON 422 body, which is the wrong content type
    # for a public HTML page (and an over-long ?q= is harmless anyway).
    # _index already truncates to 80 chars before it touches the store.
    def index_ro(request: Request, q: str = Query("")) -> Response:
        return _index(request, q, "ro")

    def index_en(request: Request, q: str = Query("")) -> Response:
        return _index(request, q, "en")

    # ── JSON search ────────────────────────────────────────────────

    def search_json(request: Request,
                    q: str = Query("", max_length=80)) -> Response:
        limited = ratelimit.check(request)
        if limited is not None:
            return limited
        st = _store()
        rows: List[Dict[str, Any]] = []
        if st is not None and q.strip():
            try:
                rows = st.search_companies(q.strip(), limit=20)
            except Exception:
                logger.warning("search failed", exc_info=True)
        base = canonical_base()
        results = []
        for row in rows:
            cui = int(row["cui"])
            slug = canonical_slug(row.get("name"))
            results.append({
                "cui": cui,
                "name": row.get("name"),
                "county": row.get("county"),
                "caen": row.get("caen"),
                "slug": slug,
                "url": base + company_path(cui, slug, "ro"),
            })
        return JSONResponse(
            {"query": q, "count": len(results), "results": results},
            headers=_headers(request),
        )

    # ── OG image ───────────────────────────────────────────────────

    def og_image(request: Request, name: str) -> Response:
        limited = ratelimit.check(request)
        if limited is not None:
            return limited
        m = name.rsplit(".", 1)
        if len(m) != 2 or m[1] != "png" or "-" not in m[0]:
            return _error_html(request, 404, "ro")
        cui_s, _, year_s = m[0].rpartition("-")
        if not (cui_s.isdigit() and year_s.isdigit()):
            return _error_html(request, 404, "ro")
        cui, year = int(cui_s), int(year_s)
        st = _store()
        if st is None or _taken_down(st, cui):
            return _error_html(request, 404, "ro")
        company = st.get_company(cui)
        if not company or not company.get("publishable"):
            return _error_html(request, 404, "ro")
        filings = [f for f in st.get_filings(cui) if int(f["year"]) == year]
        if not filings:
            return _error_html(request, 404, "ro")
        filing = filings[0]
        prov = filing.get("provenance") or {}
        s = STRINGS["ro"]
        kpis = {
            s["kpi_revenue"]: (fmt_compact_ron(filing.get("i13"), "ro")
                               if filing.get("i13") is not None else None),
            s["kpi_net_result"]: (
                fmt_compact_ron(net_result_of(filing), "ro")
                if net_result_of(filing) is not None else None),
            s["kpi_employees"]: (fmt_int(filing.get("i20"), "ro")
                                 if filing.get("i20") is not None else None),
        }
        data = cached_og_png(
            name=company.get("name") or ("CUI %d" % cui),
            cui=cui, year=year,
            dataset_version=str(prov.get("dataset_id") or "0"),
            kpis=kpis,
        )
        return Response(data, media_type="image/png",
                        headers={"Cache-Control": CACHE_CONTROL})

    # ── route registration (clean path + /api/public/ro twin) ──────

    def _both(paths: List[str], endpoint: Callable[..., Any],
              **kwargs: Any) -> None:
        for p in paths:
            router.add_api_route(p, endpoint, methods=["GET"],
                                 include_in_schema=False, **kwargs)

    _both(["/companii", "/api/public/ro/companii"], index_ro)
    _both(["/companies", "/api/public/ro/companies"], index_en)
    _both(["/companii/{key}", "/api/public/ro/companii/{key}"],
          company_page_ro)
    _both(["/companies/{key}", "/api/public/ro/companies/{key}"],
          company_page_en)
    _both(["/og/companii/{name}", "/api/public/ro/og/companii/{name}"],
          og_image)
    router.add_api_route("/api/public/ro/search", search_json,
                         methods=["GET"])

    # ── sibling sub-routers (partial lane states stay importable) ──
    import importlib

    for mod_name, factory_name in _SUB_ROUTERS:
        try:
            mod = importlib.import_module(mod_name)
            factory = getattr(mod, factory_name)
        except (ImportError, AttributeError):
            logger.info("public_ro sub-router %s.%s not available yet",
                        mod_name, factory_name)
            continue
        try:
            router.include_router(factory())
        except Exception:  # pragma: no cover — a broken sibling must not
            logger.warning("mounting %s.%s failed", mod_name, factory_name,
                           exc_info=True)  # take the storefront down
    return router
