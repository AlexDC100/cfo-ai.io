"""Hub pages: /sector/{caen2-slug} and /judet/{county-slug} (+ EN twins
/sectors/, /counties/) plus the two directory index pages /companii and
/companies. Lane 4 (programmatic SEO).

Server-rendered HTML (python string templates, inline CSS, zero JS —
wave architecture). Each hub lists the top companies by latest-year
revenue with percentile context and internal links hub -> company; the
company template (lane 3) links back via its sector/county labels.

SEO contract:
  * every page is self-canonical per language, with hreflang alternates
    (ro / en / x-default -> ro);
  * a hub with fewer than seo.HUB_MIN_COMPANIES companies renders with
    ``<meta name="robots" content="noindex">`` + ``X-Robots-Tag: noindex``
    and is excluded from the sitemap (the two policies share the constant);
  * any request whose Host is not the canonical domain gets
    ``X-Robots-Tag: noindex`` (api.cfo-ai.io duplicate-host risk);
  * unknown slugs are a real 404 (the SPA's soft-404 problem must not
    leak into this URL space).

Shell: imports ``page_shell`` from engine.public_ro.pages.templates by
contract (lane 3, concurrent). Until that module lands — or if its
signature drifts — a local fallback shell with the same keyword surface
renders a complete, self-contained page so this lane stays testable
offline. See _shell().

Store contract (lane 2, duck-typed):
  store.hub_keys(kind) -> [{slug, label_ro, label_en?, company_count}]
  store.hub_top_companies(kind, slug, limit) -> rows sorted by
      latest-year revenue desc: {cui, name, slug?, latest_year,
      revenue?, net_result?, employees?, county_label?, caen_label?,
      revenue_percentile?}
  store.hub_stats(kind, slug) -> {company_count, total_revenue?,
      median_revenue?, year?}   (optional)

Indicator provenance (verified layout FY2019-FY2025): revenue is
I13 = Cifra de afaceri neta; net result is I18 - I19 (Profit net minus
Pierdere neta, both non-negative columns); employees is I20 = Numar
mediu de salariati. Whole-RON ints, resolved per (year, family) from
the companion spec .csv by lane 1 — never hard-coded here.
"""

from __future__ import annotations

from html import escape
from typing import Any, Callable, Dict, List, Optional, Tuple

from fastapi import APIRouter, Request, Response
from fastapi.responses import HTMLResponse

from engine.public_ro.seo import (
    HUB_MIN_COMPANIES,
    canonical_base,
    company_path,
    hub_path,
    index_path,
    robots_headers_for,
)

_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400"

_HUB_TOP_LIMIT = 50


# ── copy (RO / EN) ─────────────────────────────────────────────────────

_KIND_LABEL = {
    ("sector", "ro"): "Sector CAEN",
    ("sector", "en"): "CAEN sector",
    ("judet", "ro"): "Județ",
    ("judet", "en"): "County",
}

_COL_HEADERS = {
    "ro": ("#", "Companie", "An", "Cifra de afaceri (RON)",
           "Rezultat net (RON)", "Angajați"),
    "en": ("#", "Company", "Year", "Net turnover (RON)",
           "Net result (RON)", "Employees"),
}


def _fmt_int(value: Optional[int], lang: str) -> str:
    if value is None:
        return "—"
    s = "{:,}".format(int(value))
    if lang == "ro":
        s = s.replace(",", ".")
    return s


# ── shell (lane 3 contract + local fallback) ──────────────────────────

def _fallback_page_shell(*, lang: str, title: str, description: str,
                         canonical: str,
                         alternates: List[Tuple[str, str]],
                         body_html: str,
                         robots: Optional[str] = None,
                         **_ignored: Any) -> str:
    """Minimal complete page used until lane 3's templates.page_shell
    lands (same keyword surface). Inline CSS, zero JS."""
    alt_links = "".join(
        '<link rel="alternate" hreflang="%s" href="%s">\n'
        % (escape(hl, quote=True), escape(href, quote=True))
        for hl, href in alternates
    )
    robots_meta = ('<meta name="robots" content="%s">\n'
                   % escape(robots, quote=True)) if robots else ""
    return (
        "<!doctype html>\n"
        '<html lang="%(lang)s">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        "<title>%(title)s</title>\n"
        '<meta name="description" content="%(description)s">\n'
        '<link rel="canonical" href="%(canonical)s">\n'
        "%(alt_links)s%(robots_meta)s"
        "<style>\n"
        "body{font-family:'Helvetica Neue',Arial,sans-serif;margin:0;"
        "background:#fafbfc;color:#1a1a1a;font-size:14px}\n"
        "main{max-width:960px;margin:0 auto;padding:24px 16px}\n"
        "h1{color:#003366;font-size:22px}\n"
        "table{width:100%%;border-collapse:collapse;background:#fff}\n"
        "th{background:#003366;color:#fff;text-align:left;padding:8px;"
        "font-size:12px}\n"
        "td{padding:8px;border-bottom:1px solid #d6dde6}\n"
        "td.num{text-align:right;font-variant-numeric:tabular-nums}\n"
        "a{color:#1a5490}\n"
        "footer{color:#666;font-size:11px;margin-top:32px}\n"
        "</style>\n</head>\n<body>\n<main>\n%(body)s\n</main>\n</body>\n</html>\n"
        % {
            "lang": escape(lang, quote=True),
            "title": escape(title),
            "description": escape(description, quote=True),
            "canonical": escape(canonical, quote=True),
            "alt_links": alt_links,
            "robots_meta": robots_meta,
            "body": body_html,
        }
    )


def _shell(**kwargs: Any) -> str:
    try:
        from engine.public_ro.pages.templates import page_shell  # lane 3
    except ImportError:
        return _fallback_page_shell(**kwargs)
    try:
        return page_shell(**kwargs)
    except TypeError:
        # Signature drift between concurrent lanes — render via the
        # fallback rather than 500 on a public URL; flagged in wiring
        # notes so the contract gets aligned.
        return _fallback_page_shell(**kwargs)


# ── store resolution (lane 2 contract) ────────────────────────────────

def _resolve_store(store: Optional[Any]) -> Any:
    if store is not None:
        return store
    from engine.public_ro.seo import _open_default_store
    return _open_default_store()


def _hub_entry(store: Any, kind: str, slug: str) -> Optional[Dict[str, Any]]:
    hub_keys = getattr(store, "hub_keys", None)
    if hub_keys is None:
        return None
    for entry in hub_keys(kind):
        if str(entry.get("slug") or entry.get("key")) == slug:
            return entry
    return None


def _hub_label(entry: Dict[str, Any], lang: str) -> str:
    if lang == "en":
        return str(entry.get("label_en") or entry.get("label_ro")
                   or entry.get("slug"))
    return str(entry.get("label_ro") or entry.get("slug"))


# ── rendering ──────────────────────────────────────────────────────────

def _alternates(kind: Optional[str], slug: Optional[str],
                base: str) -> List[Tuple[str, str]]:
    if kind is None:  # directory index pages
        ro = base + index_path("ro")
        en = base + index_path("en")
    else:
        ro = base + hub_path(kind, slug or "", "ro")
        en = base + hub_path(kind, slug or "", "en")
    return [("ro", ro), ("en", en), ("x-default", ro)]


def _percentile_context(rows: List[Dict[str, Any]],
                        stats: Optional[Dict[str, Any]],
                        entry: Dict[str, Any], lang: str) -> str:
    count = None
    if stats and stats.get("company_count") is not None:
        count = int(stats["company_count"])
    elif entry.get("company_count") is not None:
        count = int(entry["company_count"])
    shown = len(rows)
    top_share = None
    if stats and stats.get("total_revenue"):
        shown_rev = sum(int(r.get("revenue") or 0) for r in rows)
        total = int(stats["total_revenue"])
        if total > 0:
            top_share = 100.0 * shown_rev / total
    if lang == "ro":
        txt = ("Top %d companii" % shown
               + (" din %s" % _fmt_int(count, lang) if count else "")
               + " după cifra de afaceri din ultimul an raportat")
        if top_share is not None:
            txt += (", cumulând %.1f%% din cifra de afaceri a grupului"
                    % top_share)
    else:
        txt = ("Top %d companies" % shown
               + (" of %s" % _fmt_int(count, lang) if count else "")
               + " by latest reported-year net turnover")
        if top_share is not None:
            txt += ", together %.1f%% of the group's turnover" % top_share
    return txt + "."


def _rows_table(rows: List[Dict[str, Any]], lang: str, base: str) -> str:
    heads = _COL_HEADERS[lang]
    out = ["<table>\n<tr>"]
    out.extend("<th>%s</th>" % escape(h) for h in heads)
    out.append("</tr>\n")
    for rank, row in enumerate(rows, start=1):
        cui = int(row["cui"])
        name = str(row.get("name") or cui)
        slug = row.get("slug")
        if not slug:
            from engine.public_ro.seo import slugify
            slug = slugify(name)
        href = base + company_path(cui, str(slug), "ro")
        pct = row.get("revenue_percentile")
        pct_txt = ""
        if pct is not None:
            pct_txt = (" <span style=\"color:#666;font-size:11px\">(p%d)</span>"
                       % int(round(float(pct))))
        out.append(
            "<tr><td class=\"num\">%d</td>"
            "<td><a href=\"%s\">%s</a>%s</td>"
            "<td class=\"num\">%s</td>"
            "<td class=\"num\">%s</td>"
            "<td class=\"num\">%s</td>"
            "<td class=\"num\">%s</td></tr>\n"
            % (rank,
               escape(href, quote=True), escape(name), pct_txt,
               escape(str(row.get("latest_year") or "—")),
               _fmt_int(row.get("revenue"), lang),
               _fmt_int(row.get("net_result"), lang),
               _fmt_int(row.get("employees"), lang))
        )
    out.append("</table>\n")
    return "".join(out)


def _footer(lang: str) -> str:
    try:
        from engine.public_ro.compliance import attribution_footer_html
        try:
            return "<footer>%s</footer>" % attribution_footer_html(
                ["mfinante_datagov", "mfinante_datagov_identificare"]
            )
        except Exception:
            pass
    except ImportError:
        pass
    if lang == "ro":
        txt = ("Date din surse deschise (data.gov.ro, Ministerul Finanțelor)."
               " Valori în RON întregi, așa cum au fost raportate.")
    else:
        txt = ("Data from open sources (data.gov.ro, Romanian Ministry of"
               " Finance). Whole-RON values as reported.")
    return "<footer>%s</footer>" % escape(txt)


def render_hub_page(store: Any, kind: str, slug: str, lang: str,
                    base: Optional[str] = None,
                    ) -> Tuple[str, int, Dict[str, str]]:
    """Render one hub page. Returns (html, status_code, extra_headers)."""
    base = (base or canonical_base()).rstrip("/")
    entry = _hub_entry(store, kind, slug)
    rows: List[Dict[str, Any]] = []
    if entry is not None:
        rows = list(store.hub_top_companies(kind, slug, limit=_HUB_TOP_LIMIT))
    if entry is None and not rows:
        title = "404" if lang == "en" else "404"
        body = ("<h1>404</h1><p>%s</p>"
                % ("Pagina nu există." if lang == "ro"
                   else "This page does not exist."))
        html = _shell(lang=lang, title=title,
                      description="Not found", canonical=base + hub_path(kind, slug, lang),
                      alternates=[], body_html=body, robots="noindex")
        return html, 404, {"X-Robots-Tag": "noindex"}

    entry = entry or {"slug": slug, "label_ro": slug,
                      "company_count": len(rows)}
    label = _hub_label(entry, lang)
    kind_label = _KIND_LABEL[(kind, lang)]
    thin = len(rows) < HUB_MIN_COMPANIES

    stats = None
    hub_stats = getattr(store, "hub_stats", None)
    if hub_stats is not None:
        try:
            stats = hub_stats(kind, slug)
        except Exception:
            stats = None

    if lang == "ro":
        title = "%s %s — companii, cifre de afaceri, rezultate" % (kind_label, label)
        description = ("Companiile din %s %s: cifra de afaceri, rezultat net"
                       " și angajați din situațiile financiare publice."
                       % (kind_label.lower(), label))
        back = ('<p><a href="%s">&larr; Toate sectoarele și județele</a></p>'
                % escape(base + index_path("ro"), quote=True))
        empty_note = "Nu există încă suficiente date publicate pentru această pagină."
    else:
        title = "%s %s — companies, turnover, results" % (kind_label, label)
        description = ("Companies in %s %s: net turnover, net result and"
                       " employees from public financial statements."
                       % (kind_label.lower(), label))
        back = ('<p><a href="%s">&larr; All sectors and counties</a></p>'
                % escape(base + index_path("en"), quote=True))
        empty_note = "Not enough published data yet for this page."

    body = ["<h1>%s: %s</h1>\n" % (escape(kind_label), escape(label)), back]
    if rows:
        body.append("<p>%s</p>\n"
                    % escape(_percentile_context(rows, stats, entry, lang)))
        body.append(_rows_table(rows, lang, base))
    else:
        body.append("<p>%s</p>\n" % escape(empty_note))
    body.append(_footer(lang))

    html = _shell(
        lang=lang, title=title, description=description,
        canonical=base + hub_path(kind, slug, lang),
        alternates=_alternates(kind, slug, base),
        body_html="".join(body),
        robots="noindex" if thin else None,
    )
    headers = {"Cache-Control": _CACHE_CONTROL}
    if thin:
        headers["X-Robots-Tag"] = "noindex"
    return html, 200, headers


def render_index_page(store: Any, lang: str,
                      base: Optional[str] = None,
                      ) -> Tuple[str, int, Dict[str, str]]:
    """Standalone hub-directory page: links every indexable sector +
    county hub.

    NOT the served /companii — that URL is owned by pages/router.py,
    which renders search + the same hub links (via _hub_links) in one
    page. This renderer survives as the operator preview
    (`scripts/public_seo.py hubs-preview --kind index`) and as the
    hub-link unit under test; keep the two link sets in agreement.
    """
    base = (base or canonical_base()).rstrip("/")
    hub_keys = getattr(store, "hub_keys", None)

    sections: List[str] = []
    total_hubs = 0
    for kind, heading_ro, heading_en in (
        ("sector", "Sectoare CAEN", "CAEN sectors"),
        ("judet", "Județe", "Counties"),
    ):
        links = []
        for entry in (hub_keys(kind) if hub_keys else []):
            if int(entry.get("company_count", 0)) < HUB_MIN_COMPANIES:
                continue
            slug = str(entry.get("slug") or entry.get("key") or "")
            if not slug:
                continue
            label = _hub_label(entry, lang)
            links.append('<li><a href="%s">%s</a> <span style="color:#666">'
                         "(%s)</span></li>"
                         % (escape(base + hub_path(kind, slug, lang), quote=True),
                            escape(label),
                            _fmt_int(entry.get("company_count"), lang)))
        total_hubs += len(links)
        heading = heading_ro if lang == "ro" else heading_en
        sections.append("<h2>%s</h2>\n<ul>\n%s\n</ul>\n"
                        % (escape(heading), "\n".join(links) or "<li>—</li>"))

    if lang == "ro":
        title = "Companii din România — director public pe sectoare și județe"
        description = ("Director public de companii românești din situațiile"
                       " financiare deschise: pe sectoare CAEN și județe.")
        h1 = "Companii din România"
    else:
        title = "Romanian companies — public directory by sector and county"
        description = ("Public directory of Romanian companies from open"
                       " financial statements: by CAEN sector and county.")
        h1 = "Romanian companies"

    thin = total_hubs == 0
    body = "<h1>%s</h1>\n%s%s" % (escape(h1), "".join(sections), _footer(lang))
    html = _shell(
        lang=lang, title=title, description=description,
        canonical=base + index_path(lang),
        alternates=_alternates(None, None, base),
        body_html=body,
        robots="noindex" if thin else None,
    )
    headers = {"Cache-Control": _CACHE_CONTROL}
    if thin:
        headers["X-Robots-Tag"] = "noindex"
    return html, 200, headers


# ── router ─────────────────────────────────────────────────────────────

def build_hub_router(store: Optional[Any] = None) -> APIRouter:
    """Hub + directory-index routes at clean paths AND the /api/public/ro
    twins. ``store`` is injectable for tests; defaults to the lane-2
    store resolved lazily per request (partial states stay importable)."""
    router = APIRouter(tags=["public-ro-hubs"])

    def _respond(render: Callable[[], Tuple[str, int, Dict[str, str]]],
                 request: Request) -> Response:
        html, status, headers = render()
        merged = dict(headers)
        robots = robots_headers_for(request)
        if "X-Robots-Tag" in robots:  # non-canonical host wins
            merged["X-Robots-Tag"] = robots["X-Robots-Tag"]
        return HTMLResponse(content=html, status_code=status, headers=merged)

    def _hub(request: Request, kind: str, slug: str, lang: str) -> Response:
        s = _resolve_store(store)
        return _respond(lambda: render_hub_page(s, kind, slug, lang), request)

    route_specs = [
        ("/sector/{slug}", "sector", "ro"),
        ("/sectors/{slug}", "sector", "en"),
        ("/judet/{slug}", "judet", "ro"),
        ("/counties/{slug}", "judet", "en"),
    ]
    for prefix in ("", "/api/public/ro"):
        for path, kind, lang in route_specs:
            def _make(kind: str = kind, lang: str = lang) -> Callable:
                def endpoint(request: Request, slug: str) -> Response:
                    return _hub(request, kind, slug, lang)
                return endpoint
            router.add_api_route(prefix + path, _make(),
                                 methods=["GET"], include_in_schema=False)
        # The directory index is NOT registered here. Both this router
        # and pages/router.py claimed /companii + /companies; the pages
        # router mounts first, so these registrations were dead and every
        # hub page was orphaned from internal linking (verifier finding,
        # 2026-08-28). The served index now renders the hub directory
        # itself via pages.router._hub_links + templates.render_index_page,
        # so there is exactly ONE index URL doing both jobs.

    return router
