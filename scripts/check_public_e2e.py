#!/usr/bin/env python3
"""PS-E2E gate — the public RO storefront against the REAL PublicRoStore.

WHY THIS EXISTS
===============
On 2026-08-29 an adversarial wave found 20+ confirmed defects in a
storefront that had 244 passing tests and a green 19-gate battery. Two
were total outages:

  · every sector/county hub page returned HTTP 500, because
    pages/hubs.py called store.hub_top_companies(kind, slug) positionally
    while PublicRoStore declares it keyword-only with a required `year`;
  · every public funnel event was silently dropped, because
    PublicRoStore creates funnel_events WITHOUT a `day` column and
    funnel.connect() indexes `day` -> OperationalError, swallowed, 204
    returned to the browser anyway.

Neither could be caught by the existing suites, and for ONE shared
reason: they drive hand-built fakes ("a FakeStore mirrors the lane-2
store", test_public_seo.py:3). A mirror is a second implementation, and
the two drifted. Every escaped defect lived exactly in that gap.

So this gate refuses to fake anything. It builds a real PublicRoStore
on a temp path, seeds it through the store's own public methods, mounts
the real router, and asserts the properties a visitor and a crawler
actually depend on. It is deliberately end-to-end and deliberately
boring: no unit could have caught these, because each component was
individually correct and only the SEAMS were wrong.

Run:  python scripts/check_public_e2e.py [-v]
Exit: 0 green, 1 violations found (battery-shape, like check_public_sitemaps).
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parents[1]
if str(REPO / "src") not in sys.path:
    sys.path.insert(0, str(REPO / "src"))

CANON_HOST = "cfo-ai.io"
HDRS = {"host": CANON_HOST}

# Three companies sharing CAEN 10 / county Cluj so the hub tier is
# actually populated: HUB_MIN_COMPANIES is 3, and a hub below it renders
# noindex, which would let a broken hub hide behind "thin".
SEED = [
    (700001, "Alfa Prod SRL", "1071", "Cluj"),
    (700002, "Beta Panificatie SRL", "1071", "Cluj"),
    (700003, "Gamma Morarit SRL", "1061", "Cluj"),
    # A name past the page's 60-char canonical-slug truncation. The
    # sitemap and the page must agree on the slug; if the sitemap builds
    # its own, this row's URL 301s forever and the gate says so. Real
    # Romanian names reach this length routinely.
    (700004, "COMPANIA NATIONALA DE TRANSPORT AL ENERGIEI ELECTRICE "
             "TRANSELECTRICA SA", "3512", "Satu Mare"),
    # Counties whose names carry a SPACE and Romanian diacritics — both
    # must survive into <loc> as a fetchable RFC-3986 URL. "Satu Mare"
    # and "Bistrița-Năsăud" are real counties, not edge cases.
    (700005, "Delta Constructii SRL", "4120", "Satu Mare"),
    (700006, "Epsilon Textile SRL", "4120", "Satu Mare"),
    (700007, "Zeta Lemn SRL", "1610", "Bistrița-Năsăud"),
    (700008, "Eta Mobila SRL", "1610", "Bistrița-Năsăud"),
    (700009, "Theta Cherestea SRL", "1610", "Bistrița-Năsăud"),
]
YEARS = (2022, 2023, 2024)


class Violations(list):
    """Violations plus a WORK LEDGER.

    Every check in this file is "make a request, judge the response".
    With an empty seed or a broken app fixture each loop runs zero
    times, no violation is added, and the closing "PS-E2E GATE: PASS —
    real store, links render, sitemap URLs resolve…" is printed over
    nothing at all. That sentence would be TRUE and worthless — the
    exact shape of the tsc false green.

    So each probe is counted as it is made, and the count is asserted
    against a floor before the verdict prints. `witnesses` records the
    named surfaces actually exercised, so a canary can be checked
    rather than assumed.
    """

    def __init__(self, *a):
        list.__init__(self, *a)
        self.probes = 0
        self.witnesses = set()

    def add(self, code: str, detail: str) -> None:
        self.append("%s: %s" % (code, detail))

    def probe(self, witness: str = "") -> None:
        self.probes += 1
        if witness:
            self.witnesses.add(witness)


#: Surfaces this gate MUST have exercised, classified by the URL SHAPE
#: actually fetched — not by the loop that happened to fetch it. Each is
#: a distinct public tier; losing one silently is how the hub-500 and
#: dropped-funnel outages hid behind 244 green tests in the first place.
#:
#: Worth knowing (found by this canary, 2026-08-30): the rendered
#: /companii index links ONLY county and sector hubs — no company page
#: is reachable from it. Company pages reach this gate through the
#: SITEMAP loop alone. That is a public_ro linking question, recorded
#: here rather than papered over by a laxer canary.
DISCOVERY_CANARIES = ("index", "hub", "company-page",
                      "funnel-sink", "takedown")


def _url_kind(path: str) -> str:
    """Classify a public URL by shape: index / hub / company-page."""
    p = path.split("?", 1)[0].rstrip("/")
    if p in ("/companii", "/companies", ""):
        return "index"
    if p.startswith(("/sector", "/sectors", "/judet", "/counties")):
        return "hub"
    if p.startswith(("/companii/", "/companies/")):
        return "company-page"
    return "other"


def _seed_store(store: Any) -> None:
    """Seed through the store's OWN public methods only.

    Anything this function cannot express is a gap in the store's API,
    not a reason to reach into SQL — reaching into SQL is how a fake
    starts.
    """
    store.register_dataset(
        dataset_id="uu-2024", year=2024, family="UU", sha256="e" * 64,
        source_url="https://data.gov.ro/dataset/situatii_financiare_2024",
        resource_id="res-e2e", license_id="CC-BY-4.0", license_note=None,
        row_count=len(SEED), fetched_at="2026-06-15T00:00:00Z")

    for cui, name, caen, county in SEED:
        store.ensure_company_stub(cui, caen)
        store.set_identification(
            cui, name=name, county=county, locality=county,
            reg_number="J12/1/2010", tip_contrib="PJ", publishable=True,
            name_source="identification")
        for i, year in enumerate(YEARS):
            store.upsert_filing(
                cui=cui, year=year, family="UU", dataset_id="uu-2024",
                caen=caen,
                total_assets=15_000_000 + i * 1_500_000,
                net_result=1_500_000,
                indicators={
                    "i1": 10_000_000 + i * 1_000_000,
                    "i2": 5_000_000 + i * 500_000,
                    "i7": 4_000_000,
                    "i10": 11_000_000,
                    "i13": 20_000_000 + i * 2_000_000,
                    "i14": 21_000_000,
                    "i15": 19_000_000,
                    "i18": 1_500_000,
                    "i19": None,
                    "i20": 40 + i,
                },
            )


def _check_links_render(client: Any, v: Violations, verbose: bool) -> None:
    """Every internal link the served index emits must render.

    This is the hub-500 catcher. The index is the crawler's entry point;
    a link it advertises that 500s is a dead branch of the whole SEO
    tree, and no unit test of either side can see it.
    """
    import re

    for index in ("/companii", "/companies"):
        r = client.get(index, headers=HDRS)
        v.probe("index")
        if r.status_code != 200:
            v.add("INDEX_NOT_200", "%s -> HTTP %d" % (index, r.status_code))
            continue
        hrefs = set(re.findall(r'href="(/[^"#?]*)"', r.text))
        internal = sorted(h for h in hrefs
                          if h.startswith(("/companii", "/companies",
                                           "/sector", "/sectors",
                                           "/judet", "/counties")))
        if not any(h.startswith(("/sector", "/judet", "/sectors",
                                 "/counties")) for h in internal):
            v.add("INDEX_HAS_NO_HUB_LINKS",
                  "%s links no sector/county hub — the hub tier is "
                  "orphaned from internal linking" % index)
        for href in internal:
            rr = client.get(href, headers=HDRS)
            v.probe(_url_kind(href))
            if rr.status_code != 200:
                v.add("LINKED_URL_NOT_200",
                      "%s links %s -> HTTP %d" % (index, href, rr.status_code))
            elif verbose:
                print("  ok %s" % href)


def _check_sitemap_urls(client: Any, store: Any, out_dir: Path,
                        v: Violations, verbose: bool) -> None:
    """Every sitemapped URL must serve 200 WITHOUT redirecting.

    follow_redirects=False is the whole point: with the default the
    client reports the status of the redirect TARGET, so a sitemap full
    of 301s reads as perfectly healthy.
    """
    from engine.public_ro import seo

    try:
        seo.generate_sitemaps(store, out_dir=out_dir)
    except Exception as exc:  # noqa: BLE001
        v.add("SITEMAP_GENERATION_FAILED", "%s: %s" % (type(exc).__name__, exc))
        return

    urls = _load_shard_urls(out_dir)
    if not urls:
        if verbose:
            print("  NOTICE no sitemap URLs generated (empty deployment)")
        return

    for url in urls:
        parts = urlsplit(url)
        if parts.netloc != CANON_HOST:
            v.add("SITEMAP_OFF_CANONICAL_HOST", url)
        if " " in url or any(ord(c) > 127 for c in url):
            v.add("SITEMAP_LOC_NOT_RFC3986",
                  "%s contains a raw space or non-ASCII byte" % url)
        r = client.get(parts.path, headers=HDRS, follow_redirects=False)
        v.probe(_url_kind(parts.path))
        if r.status_code in (301, 302, 307, 308):
            v.add("SITEMAP_URL_REDIRECTS",
                  "%s -> HTTP %d (Location: %s) — the sitemap must list "
                  "the canonical URL, not one that redirects to it"
                  % (url, r.status_code, r.headers.get("location")))
        elif r.status_code != 200:
            v.add("SITEMAP_URL_NOT_200",
                  "%s -> HTTP %d" % (url, r.status_code))
        elif verbose:
            print("  ok %s" % url)


def _load_shard_urls(out_dir: Path) -> List[str]:
    import gzip
    import xml.etree.ElementTree as ET

    urls: List[str] = []
    for shard in sorted(out_dir.glob("*.xml.gz")):
        try:
            root = ET.fromstring(gzip.decompress(shard.read_bytes()))
        except Exception:  # noqa: BLE001
            continue
        for loc in root.iter("{http://www.sitemaps.org/schemas/sitemap/0.9}loc"):
            if loc.text:
                urls.append(loc.text.strip())
    return urls


def _check_funnel_sink(db_path: Path, v: Violations, verbose: bool) -> None:
    """The beacon sink must actually persist on a store-created DB.

    The store creates the file and funnel.py opens it second, so their
    two funnel_events definitions must agree. record_event swallows its
    own errors and the route answers 204 regardless, so nothing short of
    reading the row back can tell you it worked.
    """
    from engine.public_ro import funnel

    try:
        conn = funnel.connect(db_path)
    except Exception as exc:  # noqa: BLE001
        v.add("FUNNEL_SINK_UNUSABLE",
              "funnel.connect() on a PublicRoStore-created DB raised "
              "%s: %s — every public event is dropped while the beacon "
              "route still answers 204" % (type(exc).__name__, exc))
        return

    before = _funnel_count(conn)
    ok = funnel.record_event(kind="page_view", cui=str(SEED[0][0]),
                             path="/companii/700001-alfa-prod-srl",
                             utm=None, ip="203.0.113.9",
                             user_agent="Mozilla/5.0", db=db_path)
    after = _funnel_count(conn)
    v.probe("funnel-sink")
    if not ok or after <= before:
        v.add("FUNNEL_EVENT_NOT_PERSISTED",
              "record_event returned %r and the row count went %d -> %d"
              % (ok, before, after))
    elif verbose:
        print("  ok funnel event persisted (%d -> %d)" % (before, after))
    conn.close()


def _funnel_count(conn: Any) -> int:
    try:
        return int(conn.execute(
            "SELECT COUNT(*) FROM funnel_events").fetchone()[0])
    except Exception:  # noqa: BLE001
        return -1


def _check_takedown_is_total(client: Any, store: Any, out_dir: Path,
                             db_path: Path, v: Violations,
                             verbose: bool) -> None:
    """A verified removal must clear EVERY public surface, not just the page.

    PS8 says "honored everywhere, immediately". The page 410 is the part
    everyone remembers; search, the rendered index and the already-built
    sitemap shards are the parts that keep publishing the name.
    """
    from engine.public_ro import seo, takedown

    cui, name, _caen, _county = SEED[0]
    try:
        takedown.record_action(cui, "remove", "e2e gate",
                               "ps-e2e-gate", db_path=db_path)
    except Exception as exc:  # noqa: BLE001
        v.add("TAKEDOWN_RECORD_FAILED", "%s: %s" % (type(exc).__name__, exc))
        return

    r = client.get("/companii/%d-alfa-prod-srl" % cui, headers=HDRS,
                   follow_redirects=False)
    v.probe("takedown")
    if r.status_code != 410:
        v.add("TAKEDOWN_PAGE_NOT_410",
              "removed CUI %d page -> HTTP %d" % (cui, r.status_code))

    j = client.get("/api/public/ro/search", params={"q": name}, headers=HDRS)
    v.probe("takedown")
    if j.status_code == 200 and str(cui) in j.text:
        v.add("TAKEDOWN_LEAKS_VIA_SEARCH",
              "JSON search still returns removed CUI %d (with its name "
              "and URL)" % cui)

    h = client.get("/companii", params={"q": name}, headers=HDRS)
    v.probe("takedown")
    # Assert on the RESULT LINK, not the name: the index echoes the
    # caller's own query back into the search box, so searching for a
    # company always puts its name in the HTML. Only a link to the
    # company page proves a stored row was actually served.
    if h.status_code == 200 and ("/companii/%d-" % cui) in h.text:
        v.add("TAKEDOWN_LEAKS_VIA_INDEX",
              "the rendered directory still links removed CUI %d" % cui)

    try:
        seo.generate_sitemaps(store, out_dir=out_dir)
    except Exception:  # noqa: BLE001
        pass
    for url in _load_shard_urls(out_dir):
        if ("/%d-" % cui) in url:
            v.add("TAKEDOWN_STILL_SITEMAPPED",
                  "%s still lists removed CUI %d" % (url, cui))
            break
    if verbose:
        print("  takedown surfaces checked for CUI %d" % cui)


def run_gate(verbose: bool = False) -> Violations:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from engine.public_ro.pages import router as pages_router
    from engine.public_ro.store import PublicRoStore

    v = Violations()
    tmp = Path(tempfile.mkdtemp(prefix="public-e2e-"))
    prev_env = {k: os.environ.get(k) for k in
                ("PUBLIC_RO_DB_PATH", "PUBLIC_RO_SITEMAP_DIR",
                 "PUBLIC_RO_PAGES_DIR", "PUBLIC_RO_TAKEDOWN_DB")}
    try:
        db_path = tmp / "public_ro.db"
        out_dir = tmp / "sitemaps"
        # Point every module-level default at the temp tree: these
        # modules resolve their own paths from env, and a gate that
        # wrote into data/ would poison the real deployment.
        os.environ["PUBLIC_RO_DB_PATH"] = str(db_path)
        os.environ["PUBLIC_RO_SITEMAP_DIR"] = str(out_dir)
        os.environ["PUBLIC_RO_PAGES_DIR"] = str(tmp / "pages")
        os.environ["PUBLIC_RO_TAKEDOWN_DB"] = str(db_path)
        pages_router.reset_default_store()

        store = PublicRoStore(db_path)
        _seed_store(store)

        app = FastAPI()
        app.include_router(pages_router.build_router(store))
        # raise_server_exceptions=False so an endpoint that raises is
        # REPORTED as the 500 a real visitor would get, instead of
        # exploding the gate itself. A gate that crashes on the first
        # defect can only ever find one.
        with TestClient(app, raise_server_exceptions=False) as client:
            _check_links_render(client, v, verbose)
            _check_sitemap_urls(client, store, out_dir, v, verbose)
            _check_funnel_sink(db_path, v, verbose)
            _check_takedown_is_total(client, store, out_dir, db_path,
                                     v, verbose)
        store.close()
    finally:
        for k, val in prev_env.items():
            if val is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = val
        pages_router.reset_default_store()
        shutil.rmtree(tmp, ignore_errors=True)
    return v


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    violations = run_gate(verbose=args.verbose)
    if violations:
        print("PS-E2E GATE: FAIL (%d violations)" % len(violations))
        for item in violations:
            print("  %s" % item)
        return 1

    missing = [c for c in DISCOVERY_CANARIES if c not in violations.witnesses]
    if missing or violations.probes == 0:
        print("PS-E2E GATE: DISCOVERY BROKEN")
        print("  %d probe(s) made; surfaces exercised: %s"
              % (violations.probes, ", ".join(sorted(violations.witnesses)) or "none"))
        print("  never reached: %s" % ", ".join(missing))
        print("  Every check here is a loop over a served surface. A loop "
              "that runs zero times raises zero violations, and the PASS "
              "line below would be printed over nothing.")
        return 1

    print("GATE-WORK public-e2e units=%d floor=10 label=live-probes"
          % violations.probes)
    print("PS-E2E GATE: PASS — real store, links render, sitemap URLs "
          "resolve without redirect, funnel persists, takedown is total "
          "(%d probe(s) across %s)"
          % (violations.probes, ", ".join(sorted(violations.witnesses))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
