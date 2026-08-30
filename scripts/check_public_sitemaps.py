#!/usr/bin/env python3
"""PS6 gate — sitemap integrity for the public RO directory (battery-shape).

Loads every generated sitemap shard, then exercises the URLs IN-PROCESS
through FastAPI's TestClient (zero network — wave contract):

  1. every shard gunzips and parses as a sitemaps.org urlset;
  2. per shard, a deterministic sample of N=25 URLs (plus always the
     first and the last) must return HTTP 200 with a content marker
     (the company name / hub label) present in the body, and must NOT
     be noindex (neither ``<meta name="robots" content="noindex"`` nor
     ``X-Robots-Tag: noindex`` when requested with the canonical Host);
  3. every thin / unpublishable / taken-down CUI's URL is absent from
     every shard, and when requested directly it answers with noindex
     (meta or header) or a real 404/410.

Exit 0 on a clean pass, exit 1 with one line per violation.

Usage:
    .venv/bin/python scripts/check_public_sitemaps.py [--sitemap-dir DIR]
        [--sample N]

The in-process app is the aggregate public RO router when available
(lane 3), else the sitemap + hub routers alone. Tests drive run_gate()
directly with a planted fixture app (tests/engine/test_public_seo.py).
"""

from __future__ import annotations

import argparse
import os
import gzip
import random
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

SAMPLE_N = 25
_SITEMAP_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
_META_NOINDEX_RE = re.compile(
    r'<meta[^>]+name=["\']robots["\'][^>]*content=["\'][^"\']*noindex',
    re.IGNORECASE,
)


def load_shard_urls(sitemap_dir: Path) -> Dict[str, List[str]]:
    """shard name -> URL list, from every *.xml.gz in the directory."""
    shards: Dict[str, List[str]] = {}
    for path in sorted(sitemap_dir.glob("*.xml.gz")):
        raw = gzip.decompress(path.read_bytes())
        root = ET.fromstring(raw)
        if root.tag != _SITEMAP_NS + "urlset":
            raise ValueError("%s: root tag %r is not a sitemap urlset"
                             % (path.name, root.tag))
        urls = [loc.text or ""
                for loc in root.iter(_SITEMAP_NS + "loc")]
        shards[path.name[:-len(".xml.gz")]] = urls
    return shards


def sample_urls(urls: List[str], n: int = SAMPLE_N) -> List[str]:
    """Deterministic sample: always first + last, plus up to n seeded
    random picks (stable across runs for reproducible gate output)."""
    if len(urls) <= n + 2:
        return list(urls)
    rng = random.Random(0xC0FFEE)
    picked = set(rng.sample(range(1, len(urls) - 1), n))
    picked.update((0, len(urls) - 1))
    return [urls[i] for i in sorted(picked)]


def _to_path(url: str, base: str) -> str:
    if url.startswith(base):
        return url[len(base):] or "/"
    # Foreign-origin URL in our sitemap is itself a violation; surface it
    # by probing the path portion anyway.
    m = re.match(r"https?://[^/]+(/.*)?$", url)
    return (m.group(1) or "/") if m else url


#: Statuses that mean "this is not the URL that serves the page". A
#: sitemap must list final URLs only, so every one of these is a
#: violation when it comes back from a sitemapped URL.
_REDIRECT_STATUSES = (301, 302, 303, 307, 308)


#: Self-throttle between probes. The 2026-08-29 go-live run fired the
#: gate's ~300 sampled requests as one same-IP burst at the LIVE host
#: and collected 292 HTTP 429s from our own token-bucket rate limiter —
#: every "violation" was the abuse shield working as designed. The gate
#: paces itself and treats 429 as retryable-with-backoff instead of
#: weakening the shield (a gate exemption in the limiter would be a
#: spoofable bypass). A URL that still 429s after the retries is a real
#: availability problem and stays a violation.
#: In-process TestClient runs keep a token-cost-only pace; a NETWORK run
#: against the live host must fit the public token bucket (60/min
#: default) — the go-live invocation sets PS6_PROBE_PACE_S=1.1. Either
#: way the retry ladder below converges on the bucket's refill rate, so
#: a misconfigured pace stretches the run instead of failing it.
_PROBE_PACE_S = float(os.environ.get("PS6_PROBE_PACE_S", "0.05"))
_429_RETRIES = (2.0, 5.0, 11.0, 23.0)


def _get(client: Any, path: str, headers: Dict[str, str]) -> Any:
    """THE probe. Reads the sitemapped URL itself, never its target.

    starlette's TestClient follows redirects by default, so the gate used
    to read the status of the REDIRECT TARGET — a sitemapped URL that
    301s to its canonical form answered 200 and the whole "sitemap lists
    a redirecting URL" violation class was undetectable. Clients that
    cannot take the kwarg (the documented ``.get(path, headers=...)``
    contract) fall back and are expected not to redirect on their own.

    Paced (see _PROBE_PACE_S) and 429-tolerant: rate-limit answers back
    off and retry before counting as a violation.
    """
    import time as _time

    def _once() -> Any:
        try:
            return client.get(path, headers=headers, follow_redirects=False)
        except TypeError:
            return client.get(path, headers=headers)

    _time.sleep(_PROBE_PACE_S)
    resp = _once()
    for delay in _429_RETRIES:
        if getattr(resp, "status_code", None) != 429:
            break
        _time.sleep(delay)
        resp = _once()
    return resp


def _is_noindex(resp: Any) -> bool:
    if "noindex" in (resp.headers.get("x-robots-tag") or "").lower():
        return True
    ctype = (resp.headers.get("content-type") or "").lower()
    if "html" in ctype and _META_NOINDEX_RE.search(resp.text or ""):
        return True
    return False


# ── WORK LEDGER ──────────────────────────────────────────────────────
# PS6 is the battery's one HONESTLY VACUOUS gate: on a host that has
# ingested no public data there are no shards, so it examines nothing
# and says so. That absence is legitimate (the repo never reconstructs a
# missing denominator as a failure) — but "passed" and "had nothing to
# look at" must not read the same, so the count is published and
# scripts/run_battery.py reports 0 work as PASS(VACUOUS), never green.
#
# The gate's LOGIC is exercised regardless, by tests/engine/
# test_public_seo.py driving run_gate() against a planted fixture app.
PROBES = {"urls": 0, "shards": 0}


def run_gate(client: Any,
             sitemap_dir: Path,
             base_url: str,
             markers: Optional[Dict[str, str]] = None,
             excluded_urls: Iterable[str] = (),
             sample_n: int = SAMPLE_N,
             host: str = "cfo-ai.io") -> List[str]:
    """Run the full gate. ``client`` is a fastapi TestClient (or anything
    with .get(path, headers=...) returning status_code/headers/text).
    ``markers`` maps absolute URL -> expected content marker; sampled
    URLs without an entry only get the 200 + not-noindex checks.
    Returns violations (empty == pass).
    """
    violations: List[str] = []
    markers = markers or {}
    base = base_url.rstrip("/")
    headers = {"host": host}
    # WORK LEDGER — see PROBES below. Reset per run so a caller driving
    # run_gate twice (tests do) gets this run's count, not a total.
    PROBES["urls"] = 0
    PROBES["shards"] = 0

    try:
        shards = load_shard_urls(sitemap_dir)
    except Exception as exc:
        return ["sitemap shards unreadable: %s" % exc]
    if not shards:
        # HONEST ABSENCE, NOT A VIOLATION (repo convention: a missing
        # denominator is never reconstructed as a failure — cf. the
        # obs `_rate` None rule and the battery's "not recorded" state).
        # A host with no ingested public data has no sitemap to verify;
        # the gate has nothing to say and must not turn the battery red.
        # It goes red the moment shards EXIST and something is wrong.
        print("NOTICE no sitemap shards in %s — nothing to verify "
              "(run scripts/public_seo.py sitemaps after an ingest)"
              % sitemap_dir)
        return []

    index_path = sitemap_dir / "sitemap.xml"
    if not index_path.is_file():
        violations.append("sitemap.xml index missing in %s" % sitemap_dir)
    else:
        idx = ET.fromstring(index_path.read_bytes())
        listed = {loc.text or "" for loc in idx.iter(_SITEMAP_NS + "loc")}
        for name in shards:
            want = "%s/sitemaps/%s.xml.gz" % (base, name)
            if want not in listed:
                violations.append(
                    "shard %s not referenced by sitemap.xml index" % name)

    all_urls = set()
    for urls in shards.values():
        all_urls.update(urls)

    # 3) exclusion: thin / unpublishable / takedown URLs
    for url in excluded_urls:
        if url in all_urls:
            violations.append("EXCLUDED url present in a shard: %s" % url)
            # no continue — the direct-request noindex facet is checked
            # independently so a planted violation reports both defects
        resp = _get(client, _to_path(url, base), headers)
        PROBES["urls"] += 1
        if resp.status_code in (404, 410):
            continue
        if not _is_noindex(resp):
            violations.append(
                "excluded url %s answers %d WITHOUT noindex when requested"
                " directly" % (url, resp.status_code))

    # 2) per-shard sampled liveness + marker + indexability
    for name, urls in sorted(shards.items()):
        PROBES["shards"] += 1
        if not urls:
            violations.append("shard %s is empty" % name)
            continue
        for url in sample_urls(urls, sample_n):
            if not url.startswith(base + "/"):
                violations.append(
                    "shard %s: non-canonical-origin url %s" % (name, url))
                continue
            resp = _get(client, _to_path(url, base), headers)
            PROBES["urls"] += 1
            if resp.status_code in _REDIRECT_STATUSES:
                violations.append(
                    "shard %s: %s -> HTTP %d redirect to %s (a sitemap must"
                    " list canonical URLs only)"
                    % (name, url, resp.status_code,
                       resp.headers.get("location") or "?"))
                continue
            if resp.status_code != 200:
                violations.append("shard %s: %s -> HTTP %d"
                                  % (name, url, resp.status_code))
                continue
            if _is_noindex(resp):
                violations.append(
                    "shard %s: %s is in the sitemap but serves noindex"
                    % (name, url))
            marker = markers.get(url)
            if marker and marker not in (resp.text or ""):
                violations.append(
                    "shard %s: %s missing content marker %r"
                    % (name, url, marker))
    return violations


def _build_real_app() -> Any:
    """Aggregate public RO router when landed (lane 3), else this lane's
    routers alone — partial states stay checkable."""
    from fastapi import FastAPI
    app = FastAPI()
    # The aggregate storefront router — real module path first, then the
    # contract name this script was written against while the lanes built
    # in parallel. Without the aggregate, the COMPANY PAGE routes are
    # absent and every sitemapped company URL 404s (which the gate would
    # correctly but uselessly report as a violation).
    for mod_name, factory_name in (
        ("engine.public_ro.pages.router", "build_router"),
        ("engine.public_ro.router", "build_public_ro_router"),
    ):
        try:
            import importlib
            mod = importlib.import_module(mod_name)
            factory = getattr(mod, factory_name)
        except (ImportError, AttributeError):
            continue
        app.include_router(factory())
        return app
    from engine.public_ro.seo import build_sitemap_router
    app.include_router(build_sitemap_router())
    try:
        from engine.public_ro.pages.hubs import build_hub_router
        app.include_router(build_hub_router())
    except ImportError:
        pass
    return app


def _markers_and_exclusions(base: str) -> Any:
    """Derive marker + exclusion sets from the real store + takedowns."""
    from engine.public_ro import seo
    store = seo._open_default_store()
    removed = seo._takedown_cuis()
    markers: Dict[str, str] = {}
    excluded: List[str] = []
    for row in store.publishable_companies():
        cui = int(row["cui"])
        name = str(row.get("name") or "")
        # Same authority the generator and the page use; deriving the
        # slug a third way here would file markers under URLs that are in
        # no shard, so the gate would silently check nothing.
        url = base + seo.company_path(cui, seo.canonical_company_slug(name),
                                      "ro")
        years = row.get("years") or (
            [row["latest_year"]] if row.get("latest_year") else [])
        if not years or cui in removed:
            excluded.append(url)
        elif name:
            markers[url] = name
    hub_keys = getattr(store, "hub_keys", None)
    if hub_keys:
        for kind in ("sector", "judet"):
            for entry in hub_keys(kind):
                raw = str(entry.get("slug") or entry.get("key") or "")
                label = str(entry.get("label_ro") or raw)
                if not raw:
                    continue
                slug = seo.hub_loc_slug(kind, raw)
                for lang in ("ro", "en"):
                    markers[base + seo.hub_path(kind, slug, lang)] = label
    return markers, excluded


def main(argv: Optional[List[str]] = None) -> int:
    from engine.public_ro import seo

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sitemap-dir", type=Path, default=None)
    ap.add_argument("--sample", type=int, default=SAMPLE_N)
    args = ap.parse_args(argv)

    sitemap_dir = seo.sitemap_dir(args.sitemap_dir)
    base = seo.canonical_base()

    from fastapi.testclient import TestClient
    app = _build_real_app()
    markers, excluded = _markers_and_exclusions(base)
    # follow_redirects=False belongs here too, not only in _get: the
    # default is the gate's blind spot, and a client built with it on is
    # one refactor away from being passed somewhere that doesn't override.
    with TestClient(app, follow_redirects=False) as client:
        violations = run_gate(client, sitemap_dir, base,
                              markers=markers, excluded_urls=excluded,
                              sample_n=args.sample,
                              host=seo.canonical_domain())
    if violations:
        print("PS6 GATE: FAIL (%d violations)" % len(violations))
        for v in violations:
            print("  - %s" % v)
        return 1
    shard_count = len(load_shard_urls(sitemap_dir))
    print("GATE-WORK public-sitemaps units=%d floor=1 label=sitemap-urls-probed"
          % PROBES["urls"])
    if PROBES["urls"] == 0:
        print("PS6 GATE: PASS (%d shards) — VACUOUS: this host has no "
              "ingested public data, so the gate probed no URL. Not "
              "evidence. Run scripts/public_ingest.py + public_seo.py "
              "sitemaps to give it a subject; the gate's own logic is "
              "proven meanwhile by tests/engine/test_public_seo.py."
              % shard_count)
        return 0
    print("PS6 GATE: PASS (%d shards, %d URL(s) probed across %d shard(s))"
          % (shard_count, PROBES["urls"], PROBES["shards"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
