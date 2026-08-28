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


def _is_noindex(resp: Any) -> bool:
    if "noindex" in (resp.headers.get("x-robots-tag") or "").lower():
        return True
    ctype = (resp.headers.get("content-type") or "").lower()
    if "html" in ctype and _META_NOINDEX_RE.search(resp.text or ""):
        return True
    return False


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
        resp = client.get(_to_path(url, base), headers=headers)
        if resp.status_code in (404, 410):
            continue
        if not _is_noindex(resp):
            violations.append(
                "excluded url %s answers %d WITHOUT noindex when requested"
                " directly" % (url, resp.status_code))

    # 2) per-shard sampled liveness + marker + indexability
    for name, urls in sorted(shards.items()):
        if not urls:
            violations.append("shard %s is empty" % name)
            continue
        for url in sample_urls(urls, sample_n):
            if not url.startswith(base + "/"):
                violations.append(
                    "shard %s: non-canonical-origin url %s" % (name, url))
                continue
            resp = client.get(_to_path(url, base), headers=headers)
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
        slug = row.get("slug") or seo.slugify(name)
        url = base + seo.company_path(cui, str(slug), "ro")
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
                slug = str(entry.get("slug") or entry.get("key") or "")
                label = str(entry.get("label_ro") or slug)
                if not slug:
                    continue
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
    with TestClient(app) as client:
        violations = run_gate(client, sitemap_dir, base,
                              markers=markers, excluded_urls=excluded,
                              sample_n=args.sample,
                              host=seo.canonical_domain())
    if violations:
        print("PS6 GATE: FAIL (%d violations)" % len(violations))
        for v in violations:
            print("  - %s" % v)
        return 1
    print("PS6 GATE: PASS (%d shards)" % len(load_shard_urls(sitemap_dir)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
