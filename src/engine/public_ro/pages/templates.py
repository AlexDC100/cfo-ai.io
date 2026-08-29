"""HTML templates for the public RO company pages — python strings only.

Repo precedent: board_report_renderer — NO jinja2, inline CSS, system
font stack, zero external resources (no fonts, no CDN, no images), and
ZERO JavaScript except the single inline no-dependency view beacon.
Every render is a pure function of its inputs (PS3): no clocks, no
randomness — byte-identical output for the same (model, lang).

Page-weight budget: < 60 KB per rendered company page (tested).
"""
from __future__ import annotations

from html import escape
from typing import Any, Dict, List, Optional

from engine.public_ro.compliance import (
    LICENSE_URLS,
    dataset_license,
    get_source,
    license_line,
)
from engine.public_ro.funnel import BEACON_SNIPPET
from engine.public_ro.seo import canonical_base, company_path, index_path

from .i18n import STRINGS
from .slug import canonical_slug
from .model import (
    fmt_compact_ron,
    fmt_int,
    fmt_pct,
    fmt_signed_pct,
    narrative_text,
)
from .sparkline import sparkline_svg

# The beacon URL is no longer declared here: it lives inside
# funnel.BEACON_SNIPPET, which this module embeds verbatim, so the page
# and the sink can no longer drift (see _beacon).
#
# RESOLVED 2026-08-28. The accountant CTA used to point at
# /api/public/ro/funnel/teardown/{cui}, which nothing mounts — a dead
# link on the page whose entire job is converting visitors. There is no
# public GET that could replace it: the only real teardown route is
# POST /api/public/ro/companies/{cui}/teardown behind the operator
# token, and by mission rule a teardown is never auto-published —
# publishing stays a human act. So the link cannot deliver a document,
# and the label must not promise one.
#
# Decision: send accountants to signup under their OWN utm_campaign, so
# the intent is still captured and segmentable in the funnel panel
# instead of being lost to a 404, and reword the label from "export
# (teardown)" to an explicit request. The operator can later wire a real
# fulfilment step behind that signup without touching the page.

_TREND_LABEL_KEYS = {
    "revenue": "kpi_revenue",
    "net_result": "kpi_net_result",
    "equity_total": "kpi_equity",
    "liabilities": "kpi_liabilities",
    "employees": "kpi_employees",
}

_POSITION_LABEL_KEYS = {
    "revenue": "pos_revenue",
    "net_result": "pos_net_result",
    "employees": "pos_employees",
}

# ── shared CSS (navy/teal product language, system stack) ──────────────

_CSS = """
:root{--navy:#0b1626;--navy2:#13233a;--ink:#16202e;--mut:#5b6b7d;
--teal:#14b8a6;--teal-d:#0f8f82;--bg:#f7f9fb;--card:#ffffff;
--line:#dde5ec;--pos:#0a7c3a;--neg:#c62828;--amber:#b7791f}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,
Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink);
font-size:14px;line-height:1.55}
a{color:var(--teal-d);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto;padding:20px 16px 48px}
.hdr{background:linear-gradient(135deg,var(--navy),var(--navy2));
color:#fff;border-radius:10px;padding:22px 24px;margin-bottom:18px}
.hdr h1{font-size:24px;line-height:1.25;margin-bottom:6px}
.hdr .meta{font-size:13px;color:#c3d0dd}
.hdr .meta span{margin-right:14px;white-space:nowrap}
.chip{display:inline-block;background:rgba(20,184,166,.16);
border:1px solid rgba(20,184,166,.45);color:#7fe7db;font-size:11.5px;
padding:3px 10px;border-radius:999px;margin-top:10px}
.notice{background:#fff8e1;border:1px solid #f0c674;
border-left:4px solid #d98e04;border-radius:6px;padding:12px 14px;
margin:14px 0 0;font-size:13px;color:#4a3708}
.notice strong{display:block;margin-bottom:4px}
.notice p{margin:0}
.notice .m{color:#7a6430}
h2{font-size:17px;color:var(--navy);margin:26px 0 10px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
@media(max-width:700px){.grid{grid-template-columns:repeat(2,1fr)}}
.kpi{background:var(--card);border:1px solid var(--line);
border-left:4px solid var(--teal);border-radius:8px;padding:12px 14px}
.kpi .lbl{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;
color:var(--mut)}
.kpi .val{font-size:19px;font-weight:700;color:var(--navy);
font-variant-numeric:tabular-nums;margin:2px 0}
.kpi .sub{font-size:11px;color:var(--mut)}
.kpi .up{color:var(--pos)}.kpi .down{color:var(--neg)}
.trend{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
@media(max-width:700px){.trend{grid-template-columns:1fr}}
.tcard{background:var(--card);border:1px solid var(--line);
border-radius:8px;padding:12px 14px}
.tcard .lbl{font-size:11px;color:var(--mut);text-transform:uppercase}
.tcard .rng{font-size:11.5px;color:var(--mut);
font-variant-numeric:tabular-nums}
.spark-line{fill:none;stroke:var(--teal-d);stroke-width:2}
.spark-dot{fill:var(--teal-d)}
.spark-zero{stroke:var(--line);stroke-width:1;stroke-dasharray:3 3}
.flags li{list-style:none;background:#fff8ec;border:1px solid #f0dcb4;
border-radius:6px;padding:8px 12px;margin-bottom:6px;font-size:13px}
.flags .ok{background:#eef7f1;border-color:#cfe6d8}
.ratios{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
@media(max-width:700px){.ratios{grid-template-columns:repeat(2,1fr)}}
.rcard{background:var(--card);border:1px solid var(--line);
border-radius:8px;padding:12px 14px}
.rcard .lbl{font-size:11px;color:var(--mut)}
.rcard .val{font-size:18px;font-weight:700;color:var(--navy);
font-variant-numeric:tabular-nums}
.locked-card{background:var(--card);border:1px dashed var(--line);
border-radius:8px;padding:12px 14px;position:relative}
.locked-label{display:block;font-size:11px;color:var(--mut)}
.locked-value{display:block;font-size:18px;font-weight:700;
color:var(--navy);filter:blur(5px);user-select:none;opacity:.55}
.locked-note{display:block;font-size:10.5px;color:var(--teal-d);
margin-top:4px}
.bars .row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.bars .lbl{flex:0 0 160px;font-size:12.5px;color:var(--mut)}
.bars .track{flex:1;background:#e8eef4;border-radius:999px;height:10px;
overflow:hidden}
.bars .fill{background:var(--teal);height:10px;border-radius:999px}
.bars .pct{flex:0 0 92px;font-size:12px;color:var(--navy);
font-variant-numeric:tabular-nums;text-align:right}
.note{font-size:11.5px;color:var(--mut);margin-top:6px}
.narr{background:var(--card);border:1px solid var(--line);
border-left:4px solid var(--navy);border-radius:8px;padding:14px 16px;
font-size:13.5px}
.cta{background:linear-gradient(135deg,var(--navy),var(--navy2));
color:#fff;border-radius:10px;padding:22px 24px;margin-top:28px}
.cta h2{color:#fff;margin:0 0 6px}
.cta p{color:#c3d0dd;font-size:13px;margin-bottom:14px}
.btn{display:inline-block;background:var(--teal);color:#04231f;
font-weight:700;padding:10px 20px;border-radius:8px;font-size:14px}
.btn:hover{background:#2cd3c0;text-decoration:none}
.cta .alt{display:inline-block;margin-left:14px;color:#9fd9d1;
font-size:12.5px}
footer{margin-top:34px;border-top:1px solid var(--line);
padding-top:12px;font-size:11.5px;color:var(--mut)}
footer p{margin:3px 0}
.search{display:flex;gap:8px;margin:14px 0 20px}
.search input{flex:1;padding:10px 12px;border:1px solid var(--line);
border-radius:8px;font-size:14px}
.search button{background:var(--teal);border:0;color:#04231f;
font-weight:700;padding:10px 18px;border-radius:8px;font-size:14px;
cursor:pointer}
.results li{list-style:none;background:var(--card);
border:1px solid var(--line);border-radius:8px;padding:10px 14px;
margin-bottom:8px}
.results .m{font-size:12px;color:var(--mut)}
.errbox{background:var(--card);border:1px solid var(--line);
border-radius:10px;padding:26px;text-align:center;margin-top:40px}
"""


def _s(lang: str) -> Dict[str, str]:
    return STRINGS[lang]


def _beacon(cui: Optional[int], lang: str) -> str:
    """The one allowed inline script: the fire-and-forget view beacon.

    WHY this embeds lane 5's exported constant instead of its own string:
    this function used to hand-roll a ``navigator.sendBeacon()`` POST and
    every single field of it was wrong against the endpoint lane 5 really
    mounts (``funnel.build_funnel_router``), so NO page view was ever
    recorded:
      * path  ``/api/public/ro/funnel/beacon`` — never mounted; the real
        sink is ``POST /api/public/ro/event``;
      * kind  ``"view"`` — not in ``funnel.EVENT_KINDS``, so even a
        correctly-routed event was dropped by ``record_event``;
      * cui   sent as a JSON number — ``FunnelEventIn.cui`` is
        ``Optional[str]``, so pydantic would 422 the body;
      * transport — ``sendBeacon`` sends ``text/plain``, which FastAPI
        rejects before the handler runs.
    ``funnel.BEACON_SNIPPET`` is the contract ("the lane-3 page templates
    embed [it] verbatim", funnel.py module docstring): one fetch with an
    explicit JSON content-type, keepalive, every failure swallowed.

    ``cui``/``lang`` stay in the signature (callers are unchanged) but the
    snippet carries ``location.pathname`` instead — the CUI is the first
    segment of every company path, so nothing is lost at the sink.
    """
    del cui, lang  # carried by location.pathname inside the snippet
    return BEACON_SNIPPET


def _head(
    *,
    lang: str,
    title: str,
    description: str,
    canonical: str,
    alt_ro: Optional[str] = None,
    alt_en: Optional[str] = None,
    og_image: Optional[str] = None,
    json_ld: Optional[str] = None,
    robots_index: bool = True,
) -> str:
    parts = [
        "<!doctype html>",
        '<html lang="%s">' % lang,
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        "<title>%s</title>" % escape(title),
        '<meta name="description" content="%s">' % escape(description, quote=True),
        '<link rel="canonical" href="%s">' % escape(canonical, quote=True),
    ]
    if not robots_index:
        parts.append('<meta name="robots" content="noindex">')
    if alt_ro and alt_en:
        parts.append('<link rel="alternate" hreflang="ro" href="%s">'
                     % escape(alt_ro, quote=True))
        parts.append('<link rel="alternate" hreflang="en" href="%s">'
                     % escape(alt_en, quote=True))
        parts.append('<link rel="alternate" hreflang="x-default" href="%s">'
                     % escape(alt_ro, quote=True))
    parts.append('<meta property="og:type" content="website">')
    parts.append('<meta property="og:title" content="%s">'
                 % escape(title, quote=True))
    parts.append('<meta property="og:description" content="%s">'
                 % escape(description, quote=True))
    parts.append('<meta property="og:url" content="%s">'
                 % escape(canonical, quote=True))
    if og_image:
        parts.append('<meta property="og:image" content="%s">'
                     % escape(og_image, quote=True))
        parts.append('<meta property="og:image:width" content="1200">')
        parts.append('<meta property="og:image:height" content="630">')
    if json_ld:
        parts.append('<script type="application/ld+json">%s</script>' % json_ld)
    parts.append("<style>%s</style>" % _CSS)
    parts.append("</head><body>")
    return "\n".join(parts)


# The bilanț source publishes one dataset PER YEAR and the portal's
# licence changes across them (FY2008-2018 = uk-ogl, FY2019-2023 =
# CC-BY-4.0, FY2024/2025 unset). Case + spelling are normalised because
# ingest stores CKAN's own token lowercased and accepts the "ogl-uk"
# spelling as the same OGL licence (ingest.check_license). An id that is
# neither is rendered VERBATIM: it is what the publisher asserted, and
# mapping it onto a known licence would be inventing one.
_LICENSE_ID_ALIASES = {lid.lower(): lid for lid in LICENSE_URLS}
_LICENSE_ID_ALIASES["ogl-uk"] = "uk-ogl"

# Footer sentences are Romanian on both language variants — the existing
# contract, set by compliance.license_line() which the RO and EN pages
# have always shared.
_LICENSE_UNKNOWN_TEXT = "nedeclarată pentru acest set de date"
_LICENSE_VARIES_TEXT = "variază pe set de date (vezi pagina companiei)"


def _canonical_license_id(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    return _LICENSE_ID_ALIASES.get(text.lower(), text)


def _resolve_license(evidence: Dict[str, Any]) -> Optional[str]:
    """Licence of ONE filing: what ingest recorded from CKAN, else the
    registry's per-dataset answer for its slug. None = not asserted."""
    lic = _canonical_license_id(evidence.get("license_id"))
    if lic:
        return lic
    slug = evidence.get("dataset_slug")
    if slug:
        return _canonical_license_id(dataset_license(str(slug)))
    return None


def _year_span(years: List[int]) -> str:
    ys = sorted(set(int(y) for y in years))
    runs: List[List[int]] = [[ys[0], ys[0]]]
    for y in ys[1:]:
        if y == runs[-1][1] + 1:
            runs[-1][1] = y
        else:
            runs.append([y, y])
    return ", ".join(str(a) if a == b else "%d–%d" % (a, b) for a, b in runs)


def _bilant_license_lines(model: Optional[Dict[str, Any]]) -> List[str]:
    """Attribution for the bilanț source, carrying the licence that
    actually covers the filings THIS page renders.

    The old line was ``license_line("mfinante_datagov")`` — the SOURCE
    registry's licence — on every page, so a page built entirely from
    FY2015 filings (uk-ogl, and ingestable by default) published a
    CC-BY-4.0 claim the data does not support. Pages with no filing
    provenance (index, error) state that the licence varies rather than
    picking one.
    """
    src = get_source("mfinante_datagov")
    evidence = (model or {}).get("license_evidence") or []
    if not evidence:
        return ["Sursa datelor: %s · Licență: %s"
                % (src.name, _LICENSE_VARIES_TEXT)]

    groups: Dict[Optional[str], List[int]] = {}
    order: List[Optional[str]] = []
    for ev in evidence:
        lic = _resolve_license(ev)
        if lic not in groups:
            groups[lic] = []
            order.append(lic)
        groups[lic].append(int(ev["year"]))

    lines: List[str] = []
    for lic in order:
        if lic is None:
            line = "Sursa datelor: %s · Licență: %s" % (
                src.name, _LICENSE_UNKNOWN_TEXT)
        elif lic == src.license_id:
            # Same licence the registry asserts — let compliance own the
            # wording so the two can never drift apart.
            line = license_line("mfinante_datagov")
        else:
            line = "Sursa datelor: %s · Licență: %s" % (src.name, lic)
            url = LICENSE_URLS.get(lic)
            if url:
                line += " (%s)" % url
        if len(order) > 1:
            # Only a mixed-licence page needs to say which years each
            # licence covers; a single licence covers all of them.
            line += " · Ani: %s" % _year_span(groups[lic])
        lines.append(line)
    return lines


def _footer_html(model: Optional[Dict[str, Any]], lang: str) -> str:
    s = _s(lang)
    lines: List[str] = _bilant_license_lines(model)
    if model is not None and model.get("name_source"):
        # The identification snapshots are uniformly CC-BY-4.0 across
        # every release, so the source-level line IS this source's line.
        lines.append(license_line("mfinante_datagov_identificare"))
    lis = "".join("<p>%s</p>" % escape(x) for x in lines)
    support = _support_email()
    take = (
        '<p><a href="mailto:%s?subject=Takedown%%20CUI%%20%s">%s</a></p>'
        % (escape(support, quote=True),
           model["cui"] if model else "", escape(s["footer_takedown"]))
    )
    gen = ""
    if model is not None:
        gen = "<p>%s %s · %s %d</p>" % (
            escape(s["footer_generated"]),
            escape(str(model.get("dataset_version") or "")),
            escape(s["cui_label"]), model["cui"])
    return "<footer>%s%s%s</footer>" % (lis, take, gen)


def _support_email() -> str:
    # Lazy — engine.api.__init__ pulls the whole server module; importing
    # it at module import time would recreate the server<->router cycle.
    try:
        from engine.api._site import SITE
        return str(SITE["support_email"])
    except Exception:  # pragma: no cover — _site.py is stable repo infra
        return "contact@cfo-ai.io"


def signup_url(cui: int, campaign: str = "storefront") -> str:
    return (
        "%s/signup?utm_source=public_company&utm_campaign=%s"
        "&ft_cui=%d" % (canonical_base(), campaign, int(cui))
    )


def accountant_url(cui: int) -> str:
    """Secondary CTA destination. Its own campaign so accountant-intent
    leads stay separable from ordinary storefront signups."""
    return signup_url(cui, campaign="accountant")


# ── company page ───────────────────────────────────────────────────────

def _kpi_card(label: str, value_html: str, sub: str = "") -> str:
    return (
        '<div class="kpi"><span class="lbl">%s</span>'
        '<span class="val">%s</span>'
        '<span class="sub">%s</span></div>'
        % (escape(label), value_html, sub)
    )


def _yoy_sub(k: Dict[str, Any], lang: str, s: Dict[str, str]) -> str:
    pct = k.get("yoy_pct")
    prior = k.get("prior_year")
    if pct is None or prior is None:
        return "&nbsp;"
    cls = "up" if pct >= 0 else "down"
    return '<span class="%s">%s</span> %s %d' % (
        cls, escape(fmt_signed_pct(pct, lang)), escape(s["kpi_vs"]), prior)


def _flag_text(flag: Dict[str, Any], lang: str) -> str:
    s = _s(lang)
    kind = flag["kind"]
    if kind == "negative_equity":
        return s["flag_negative_equity"].format(year=flag["year"])
    if kind == "loss_years":
        return s["flag_loss_years"].format(
            count=flag["count"], year_from=flag["year_from"],
            year_to=flag["year_to"])
    pct = fmt_pct(flag.get("pct"), lang)
    if kind == "debt_spike":
        return s["flag_debt_spike"].format(pct=pct, year=flag["year"])
    if kind == "revenue_drop":
        return s["flag_revenue_drop"].format(pct=pct, year=flag["year"])
    if kind == "employee_drop":
        return s["flag_employee_drop"].format(pct=pct, year=flag["year"])
    return ""  # pragma: no cover — build_health_flags emits only the above


def _ratio_card(r: Dict[str, Any], lang: str, s: Dict[str, str]) -> str:
    key = r["key"]
    if key == "net_margin":
        label, val = s["ratio_net_margin"], fmt_pct(r["pct"], lang)
    elif key == "debt_to_capital":
        v = ("%.2f" % r["ratio"])
        if lang == "ro":
            v = v.replace(".", ",")
        label, val = s["ratio_debt_to_capital"], v + "×"
    else:
        label, val = (s["ratio_revenue_per_employee"],
                      fmt_int(r["value"], lang) + " RON")
    return ('<div class="rcard"><span class="lbl">%s</span>'
            '<span class="val">%s</span></div>'
            % (escape(label), escape(val)))


def _trend_range(tr: Dict[str, Any], lang: str) -> Optional[str]:
    """Caption of a trend card: the endpoints, each under ITS OWN year.

    Reads the model's (year, value) endpoint pairs rather than indexing
    ``years`` and ``values`` separately — that separation is what let a
    year which reported nothing be labelled with its neighbour's number
    (build_page_model emits the pairs). No pairs means nothing was
    reported, and the card refuses instead of inventing a range.
    """
    first, last = tr.get("first_reported"), tr.get("last_reported")
    if not first or not last:
        return None
    fmt = fmt_int if tr["key"] == "employees" else fmt_compact_ron
    if first["year"] == last["year"]:
        # One reported filing is one point; an arrow from a year to
        # itself would assert a movement that was never filed.
        return "%d: %s" % (first["year"], fmt(first["value"], lang))
    return "%d: %s → %d: %s" % (
        first["year"], fmt(first["value"], lang),
        last["year"], fmt(last["value"], lang))


def _locked_card(key: str, s: Dict[str, str]) -> str:
    # HARD RULE (PS5, tested): no digit may appear anywhere inside this
    # block — labels, placeholder and note are all digit-free.
    return (
        '<div class="locked-card">'
        '<span class="locked-label">%s</span>'
        '<span class="locked-value" aria-hidden="true">▮▮,▮ ▮</span>'
        '<span class="locked-note">%s</span>'
        "</div>" % (escape(s["locked_%s" % key]), escape(s["locked_note"]))
    )


def _json_ld(model: Dict[str, Any], canonical: str) -> str:
    import json

    org: Dict[str, Any] = {
        "@context": "https://schema.org",
        "@type": "Organization",
        "name": model["name"],
        "identifier": "CUI %d" % model["cui"],
        "url": canonical,
    }
    addr: Dict[str, Any] = {"@type": "PostalAddress", "addressCountry": "RO"}
    if model.get("county"):
        addr["addressRegion"] = model["county"]
    if model.get("locality"):
        addr["addressLocality"] = model["locality"]
    org["address"] = addr
    return json.dumps(org, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))


def render_annotation_notice(public_notice: Optional[Dict[str, Any]],
                             lang: str) -> str:
    """The operator-annotation notice box.

    takedown.ANNOTATION_RENDERER names this function by (module, attr)
    and takedown.page_layer_renders_annotations() probes for it, so the
    endpoint can tell an operator whether their 'annotate' actually
    changed a served byte. Renaming or moving it silently turns the
    softer takedown action back into a no-op — grep the name before you
    touch it.

    Only PUBLIC_NOTICE_FIELDS may appear here. `reason` and
    `verified_by` stay in the private audit trail: verified_by is a real
    person's identity, and publishing it on the page this flow exists to
    protect would be a fresh disclosure.

    An absent note renders the standing label alone — the page never
    invents a sentence about the company to fill the box.
    """
    if not public_notice:
        return ""
    s = _s(lang)
    parts = ['<aside class="notice" role="note">',
             "<strong>%s</strong>" % escape(s["notice_annotated"])]
    note = public_notice.get("note")
    if note:
        parts.append('<p><span class="m">%s:</span> %s</p>'
                     % (escape(s["notice_annotated_src"]), escape(str(note))))
    parts.append("</aside>")
    return "".join(parts)


def render_company_page(model: Dict[str, Any], lang: str,
                        annotation: Optional[Dict[str, Any]] = None) -> str:
    s = _s(lang)
    base = canonical_base()
    cui, year, name = model["cui"], model["year"], model["name"]
    path_ro = company_path(cui, model["slug"], "ro")
    path_en = company_path(cui, model["slug"], "en")
    canonical = base + (path_ro if lang == "ro" else path_en)
    og_image = "%s/og/companii/%d-%d.png" % (base, cui, year)
    title = "%s (CUI %d) — %s" % (name, cui, s["title_suffix"])

    k = model["kpis"]
    desc_bits = ["%s %s (CUI %d)" % (s["meta_desc_prefix"], name, cui)]
    if k["revenue"]["value"] is not None:
        desc_bits.append("%s %s" % (s["kpi_revenue"].lower(),
                                    fmt_compact_ron(k["revenue"]["value"], lang)))
    if k["net_result"]["value"] is not None:
        desc_bits.append("%s %s" % (s["kpi_net_result"].lower(),
                                    fmt_compact_ron(k["net_result"]["value"], lang)))
    description = "%s — %s (%d)." % (desc_bits[0], ", ".join(desc_bits[1:]) or
                                     s["title_suffix"], year)

    out: List[str] = [_head(
        lang=lang, title=title, description=description, canonical=canonical,
        alt_ro=base + path_ro, alt_en=base + path_en, og_image=og_image,
        json_ld=_json_ld(model, canonical),
    )]
    out.append('<div class="wrap">')

    # header card
    meta_bits: List[str] = ["<span>%s %d</span>" % (escape(s["cui_label"]), cui)]
    if model.get("caen"):
        caen_txt = escape(str(model["caen"]))
        if model.get("sector_label"):
            caen_txt += " · " + escape(str(model["sector_label"]))
        meta_bits.append("<span>%s %s</span>" % (escape(s["caen_label"]), caen_txt))
    if model.get("county"):
        meta_bits.append("<span>%s %s</span>"
                         % (escape(s["county_label"]), escape(model["county"])))
    yrs = model["years"]
    yrs_txt = ("%d–%d" % (yrs[0], yrs[-1])) if len(yrs) > 1 else str(yrs[0])
    meta_bits.append("<span>%s: %s</span>" % (escape(s["filing_years"]), yrs_txt))
    out.append(
        '<header class="hdr" id="overview"><h1>%s</h1>'
        '<div class="meta">%s</div>'
        '<span class="chip">%s · %d</span></header>'
        % (escape(name), "".join(meta_bits), escape(s["trust_chip"]), year)
    )

    # Directly under the header, ABOVE the figures it disputes: a notice
    # printed below the KPI band would be read after the numbers it is
    # meant to qualify.
    if annotation:
        out.append(render_annotation_notice(annotation.get("public_notice"),
                                            lang))

    # KPI band
    out.append('<section id="kpi"><div class="grid">')
    out.append(_kpi_card(s["kpi_revenue"],
                         escape(fmt_compact_ron(k["revenue"]["value"], lang)),
                         _yoy_sub(k["revenue"], lang, s)))
    out.append(_kpi_card(s["kpi_net_result"],
                         escape(fmt_compact_ron(k["net_result"]["value"], lang)),
                         _yoy_sub(k["net_result"], lang, s)))
    out.append(_kpi_card(s["kpi_net_margin"],
                         escape(fmt_pct(k["net_margin"], lang)), "&nbsp;"))
    out.append(_kpi_card(s["kpi_equity"],
                         escape(fmt_compact_ron(k["equity_total"]["value"], lang)),
                         escape(s["kpi_equity_note"])))
    out.append(_kpi_card(s["kpi_liabilities"],
                         escape(fmt_compact_ron(k["liabilities"]["value"], lang)),
                         _yoy_sub(k["liabilities"], lang, s)))
    out.append(_kpi_card(s["kpi_employees"],
                         escape(fmt_int(k["employees"]["value"], lang)),
                         _yoy_sub(k["employees"], lang, s)))
    out.append("</div></section>")

    # trends
    if model["trends"]:
        out.append('<section id="trends"><h2>%s</h2><div class="trend">'
                   % escape(s["sec_trends"]))
        for tr in model["trends"]:
            label = s[_TREND_LABEL_KEYS[tr["key"]]]
            vals = tr["values"]
            rng = _trend_range(tr, lang)
            if rng is None:
                continue  # nothing reported — the card has no range to state
            out.append(
                '<div class="tcard"><span class="lbl">%s</span>%s'
                '<div class="rng">%s</div></div>'
                % (escape(label),
                   sparkline_svg(vals, baseline_zero=tr["baseline_zero"]),
                   escape(rng))
            )
        out.append("</div></section>")

    # health flags
    out.append('<section id="health"><h2>%s</h2><ul class="flags">'
               % escape(s["sec_health"]))
    if model["health_flags"]:
        for flag in model["health_flags"]:
            out.append("<li>%s</li>" % escape(_flag_text(flag, lang)))
    else:
        out.append('<li class="ok">%s</li>' % escape(s["sec_health_none"]))
    out.append("</ul></section>")

    # ratio grid — computable + locked
    out.append('<section id="ratios"><h2>%s</h2><div class="ratios">'
               % escape(s["sec_ratios"]))
    for r in model["ratios"]:
        out.append(_ratio_card(r, lang, s))
    out.append("</div>")
    out.append('<h2>%s</h2><div class="ratios" id="locked">'
               % escape(s["sec_locked"]))
    for key in model["locked_ratio_keys"]:
        out.append(_locked_card(key, s))
    out.append("</div></section>")

    # sector position
    if model["position"]:
        out.append('<section id="position"><h2>%s</h2><div class="bars">'
                   % escape(s["sec_position"]))
        for row in model["position"]:
            pct = int(row["percentile"])
            out.append(
                '<div class="row"><span class="lbl">%s</span>'
                '<span class="track"><span class="fill" '
                'style="width:%d%%"></span></span>'
                '<span class="pct">p%d</span></div>'
                % (escape(s[_POSITION_LABEL_KEYS[row["metric"]]]), pct, pct)
            )
        out.append('</div><p class="note">%s %d.</p></section>'
                   % (escape(s["pos_caption"]), year))

    # narrative
    out.append('<section id="narrative"><h2>%s</h2><div class="narr">%s</div>'
               "</section>" % (escape(s["sec_narrative"]),
                               escape(narrative_text(model, lang, s))))

    # CTA
    out.append(
        '<section class="cta" id="cta"><h2>%s</h2><p>%s</p>'
        '<a class="btn" href="%s">%s</a>'
        '<a class="alt" href="%s">%s</a></section>'
        % (escape(s["cta_headline"]), escape(s["cta_body"]),
           escape(signup_url(cui), quote=True), escape(s["cta_button"]),
           escape(accountant_url(cui), quote=True),
           escape(s["cta_accountant"]))
    )

    out.append(_footer_html(model, lang))
    out.append("</div>")
    out.append(_beacon(cui, lang))
    out.append("</body></html>")
    return "\n".join(out)


# ── index / search page ────────────────────────────────────────────────

def render_index_page(
    lang: str,
    *,
    query: str = "",
    results: Optional[List[Dict[str, Any]]] = None,
    hub_links: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """The public directory index: company search AND the sector/county
    hub directory on ONE page.

    Both jobs live here because this router and the hub router both
    registered /companii; whichever mounts first wins, which silently
    orphaned every hub page from internal linking (verifier finding,
    2026-08-28). Merging them keeps the single served URL and restores
    the hub -> company -> hub crawl path the SEO engine depends on.
    ``hub_links`` items: {href, label, count}.
    """
    s = _s(lang)
    base = canonical_base()
    path = index_path(lang)
    canonical = base + path
    title = s["index_title"]
    out: List[str] = [_head(
        lang=lang, title=title, description=s["search_invite"],
        canonical=canonical, alt_ro=base + index_path("ro"),
        alt_en=base + index_path("en"),
        # search-result variants must not be indexed as duplicates
        robots_index=not query,
    )]
    out.append('<div class="wrap">')
    out.append('<header class="hdr" id="overview"><h1>%s</h1>'
               '<div class="meta"><span>%s</span></div></header>'
               % (escape(title), escape(s["search_invite"])))
    out.append(
        '<form class="search" id="search" method="get" action="%s">'
        '<input type="text" name="q" value="%s" placeholder="%s" '
        'maxlength="80" autocomplete="off">'
        "<button type=\"submit\">%s</button></form>"
        % (escape(path, quote=True), escape(query, quote=True),
           escape(s["search_placeholder"], quote=True),
           escape(s["search_button"]))
    )
    if query:
        out.append('<h2 id="results-h">%s „%s”</h2>'
                   % (escape(s["search_results_for"]), escape(query)))
        rows = results or []
        if rows:
            out.append('<ul class="results" id="results">')
            for row in rows:
                cui = int(row["cui"])
                slug = row.get("slug") or canonical_slug(row.get("name"))
                href = company_path(cui, slug, lang)
                bits = ["%s %d" % (s["cui_label"], cui)]
                if row.get("county"):
                    bits.append(str(row["county"]))
                if row.get("caen"):
                    bits.append("%s %s" % (s["caen_label"], row["caen"]))
                out.append(
                    '<li><a href="%s">%s</a><div class="m">%s</div></li>'
                    % (escape(href, quote=True),
                       escape(row.get("name") or ("CUI %d" % cui)),
                       escape(" · ".join(bits)))
                )
            out.append("</ul>")
        else:
            out.append('<p class="note" id="results">%s</p>'
                       % escape(s["search_empty"]))
    # Hub directory — the hub -> company -> hub internal linking the SEO
    # engine depends on. Rendered on the SAME served URL as search (see
    # the docstring); absent when no hub clears its minimum size, which
    # is also what keeps a thin directory out of the index.
    if hub_links:
        out.append('<section class="hubs" id="hubs">'
                   '<h2>%s</h2><ul class="hublist">'
                   % escape(s.get("hubs_heading") or
                            ("Sectoare și județe" if lang == "ro"
                             else "Sectors and counties")))
        for hub in hub_links:
            href = str(hub.get("href") or "")
            if not href:
                continue
            count = hub.get("count")
            suffix = ("" if count is None
                      else ' <span class="m">(%s)</span>'
                      % escape(fmt_int(int(count), lang)))
            out.append('<li><a href="%s">%s</a>%s</li>'
                       % (escape(href, quote=True),
                          escape(str(hub.get("label") or href)), suffix))
        out.append("</ul></section>")
    out.append(_footer_html(None, lang))
    out.append("</div>")
    out.append(_beacon(None, lang))
    out.append("</body></html>")
    return "\n".join(out)


# ── error pages (real 404 / 410, HTML) ────────────────────────────────

def render_error_page(status: int, lang: str) -> str:
    s = _s(lang)
    base = canonical_base()
    key = "410" if status == 410 else "404"
    title = s["err_%s_title" % key]
    out: List[str] = [_head(
        lang=lang, title=title, description=s["err_%s_body" % key],
        canonical=base + index_path(lang), robots_index=False,
    )]
    out.append('<div class="wrap"><div class="errbox">')
    out.append("<h1>%s</h1>" % escape(title))
    out.append('<p class="note">%s</p>' % escape(s["err_%s_body" % key]))
    out.append('<p><a href="%s">%s</a></p>'
               % (escape(index_path(lang), quote=True), escape(s["err_back"])))
    out.append("</div>")
    out.append(_footer_html(None, lang))
    out.append("</div></body></html>")
    return "\n".join(out)
