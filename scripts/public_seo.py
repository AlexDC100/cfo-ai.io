#!/usr/bin/env python3
"""Operator CLI for the public RO programmatic-SEO surface (lane 4).

Subcommands:
  sitemaps       regenerate every sitemap shard + index + manifest from the
                 current store snapshot (journaled to
                 data/public_sitemaps/_journal.jsonl). This is also the
                 hook the lane-1 ingest script calls after a
                 dataset_version lands:
                     from engine.public_ro.seo import regenerate
                     regenerate(affected_by_dataset_version=<version>,
                                trigger="ingest")
  verify         run the PS6 gate (scripts/check_public_sitemaps.py)
                 in-process — exit 1 on any violation.
  hubs-preview   render one hub page (or a directory index) to stdout /
                 a file, for eyeballing the HTML without a server.

Examples:
  .venv/bin/python scripts/public_seo.py sitemaps
  .venv/bin/python scripts/public_seo.py sitemaps --dataset-version fy2024-v1
  .venv/bin/python scripts/public_seo.py verify --sample 25
  .venv/bin/python scripts/public_seo.py hubs-preview --kind sector \
      --slug 10-industria-alimentara --lang ro -o /tmp/hub.html
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import List, Optional

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))


def _cmd_sitemaps(args: argparse.Namespace) -> int:
    from engine.public_ro.seo import regenerate

    manifest = regenerate(
        affected_by_dataset_version=args.dataset_version,
        out_dir=args.sitemap_dir,
        trigger="cli",
    )
    print("sitemaps regenerated: %d urls (%d company / %d hub) in %d shards"
          % (manifest["total_urls"], manifest["company_urls"],
             manifest["hub_urls"], len(manifest["shards"])))
    print("excluded: %s" % manifest["excluded"])
    for shard in manifest["shards"]:
        print("  %s.xml.gz  urls=%d  bytes=%d"
              % (shard["name"], shard["url_count"], shard["bytes"]))
    return 0


def _cmd_verify(args: argparse.Namespace) -> int:
    import check_public_sitemaps

    argv: List[str] = []
    if args.sitemap_dir:
        argv += ["--sitemap-dir", str(args.sitemap_dir)]
    if args.sample:
        argv += ["--sample", str(args.sample)]
    return check_public_sitemaps.main(argv)


def _cmd_hubs_preview(args: argparse.Namespace) -> int:
    from engine.public_ro.pages.hubs import (
        render_hub_page,
        render_index_page,
    )
    from engine.public_ro.seo import _open_default_store

    store = _open_default_store()
    if args.kind == "index":
        html, status, _hdrs = render_index_page(store, args.lang)
    else:
        if not args.slug:
            print("--slug is required for --kind sector/judet",
                  file=sys.stderr)
            return 2
        html, status, _hdrs = render_hub_page(store, args.kind, args.slug,
                                              args.lang)
    if args.output:
        Path(args.output).write_text(html, encoding="utf-8")
        print("HTTP %d -> %s (%d bytes)" % (status, args.output, len(html)))
    else:
        sys.stdout.write(html)
    return 0 if status == 200 else 1


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("sitemaps", help="regenerate sitemap shards")
    p.add_argument("--sitemap-dir", type=Path, default=None)
    p.add_argument("--dataset-version", default=None,
                   help="dataset_version that triggered this regen"
                        " (journaled)")
    p.set_defaults(fn=_cmd_sitemaps)

    p = sub.add_parser("verify", help="run the PS6 gate")
    p.add_argument("--sitemap-dir", type=Path, default=None)
    p.add_argument("--sample", type=int, default=None)
    p.set_defaults(fn=_cmd_verify)

    p = sub.add_parser("hubs-preview", help="render one hub page")
    p.add_argument("--kind", choices=("sector", "judet", "index"),
                   required=True)
    p.add_argument("--slug", default=None)
    p.add_argument("--lang", choices=("ro", "en"), default="ro")
    p.add_argument("-o", "--output", default=None)
    p.set_defaults(fn=_cmd_hubs_preview)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
