#!/usr/bin/env python3
"""Public RO data spine — operator CLI (discover / ingest / ident /
percentiles / status).

Subcommands:
  discover --year YYYY [--family UU|BL] [--actualizat]
                            Resolve the year's CKAN dataset to concrete
                            data/spec URLs + license (network).
  ingest --year YYYY [--family UU|BL] [--path FILE --spec FILE]
                            Ingest one bilanț file. With --path/--spec
                            the files are read locally (recommended for
                            the 70-90MB mass files — data.gov.ro ignores
                            Range headers, full downloads only);
                            otherwise discover+download via CKAN.
  ident --path FILE [--label LABEL]
                            Ingest a caret-delimited 2026-format
                            identification snapshot (PJ join; PF rows
                            counted then discarded — never stored).
  percentiles --year YYYY   Recompute the year's percentile rows.
  status                    Dataset registry + row counts.

License gate: unlicensed years (situatii_financiare_2025,
_2024_actualizat) are refused unless PUBLIC_INGEST_UNLICENSED_OK=1.

Exit codes: 0 ok (including honest refusals, printed as NOTICE) ·
2 usage/internal error.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return Path(__file__).resolve().parent.parent


REPO = _find_repo_root()
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from engine.public_ro import ckan, identification, ingest  # noqa: E402
from engine.public_ro.specs import SpecResolutionError  # noqa: E402
from engine.public_ro.store import PublicRoStore, default_db_path  # noqa: E402


def _notice(message: str) -> None:
    print("NOTICE  %s" % message)


def _store(args: argparse.Namespace) -> PublicRoStore:
    path = Path(args.db) if args.db else default_db_path()
    return PublicRoStore(path)


def cmd_discover(args: argparse.Namespace) -> int:
    slug = None
    if args.actualizat:
        slug = ckan.ACTUALIZAT_SLUGS.get(args.year)
        if slug is None:
            _notice("no known 'actualizat' variant for FY%d" % args.year)
            return 0
    try:
        info = ckan.discover_year(args.year, family=args.family, slug=slug)
    except ckan.CkanError as exc:
        _notice("discover failed: %s" % exc)
        return 0
    print(json.dumps(info, sort_keys=True, ensure_ascii=False, indent=2))
    if not info.get("license_id"):
        _notice(
            "license UNSET in CKAN for this dataset — ingest will refuse "
            "unless %s=1" % ingest.UNLICENSED_ENV
        )
    return 0


def cmd_ingest(args: argparse.Namespace) -> int:
    if bool(args.path) != bool(args.spec):
        print("ingest: --path and --spec must be given together")
        return 2
    if args.path:
        data_bytes = Path(args.path).read_bytes()
        spec_text = Path(args.spec).read_text(encoding="utf-8", errors="replace")
        source_url = "file://%s" % Path(args.path).resolve()
        resource_id = None
        license_id = args.license_id
        if license_id is None:
            _notice(
                "local-file ingest with no --license-id: the license gate "
                "sees 'unset' and refuses unless %s=1 or --license-id "
                "cc-by-4.0 is passed after verifying the CKAN record"
                % ingest.UNLICENSED_ENV
            )
    else:
        slug = ckan.ACTUALIZAT_SLUGS.get(args.year) if args.actualizat else None
        info = ckan.discover_year(args.year, family=args.family, slug=slug)
        _notice("downloading %s (full file — no Range support)" % info["data_url"])
        data_bytes = ingest.download(info["data_url"])
        spec_text = ingest.download(info["spec_url"]).decode(
            "utf-8", errors="replace"
        )
        source_url = info["data_url"]
        resource_id = info["data_resource_id"]
        license_id = info["license_id"]

    with _store(args) as store:
        try:
            summary = ingest.ingest_year(
                store,
                year=args.year,
                family=args.family,
                data_bytes=data_bytes,
                spec_text=spec_text,
                source_url=source_url,
                resource_id=resource_id,
                license_id=license_id,
            )
        except ingest.LicenseRefused as exc:
            _notice("ingest REFUSED (license): %s" % exc)
            return 0
        except SpecResolutionError as exc:
            _notice("ingest REFUSED (spec): %s" % exc)
            return 0
    print(json.dumps(summary, sort_keys=True, ensure_ascii=False, indent=2))
    return 0


def cmd_ident(args: argparse.Namespace) -> int:
    data_bytes = Path(args.path).read_bytes()
    label = args.label or ("ident_snapshot:%s" % Path(args.path).name)
    with _store(args) as store:
        try:
            counts = identification.ingest_identification(
                store, data_bytes, source_label=label
            )
        except identification.IdentificationFormatError as exc:
            _notice("ident REFUSED (format): %s" % exc)
            return 0
    print(json.dumps(counts, sort_keys=True, indent=2))
    _notice(
        "ident: %d PF rows counted and DISCARDED (never stored — PS7)"
        % counts["pf_discarded"]
    )
    return 0


def cmd_percentiles(args: argparse.Namespace) -> int:
    with _store(args) as store:
        n = ingest.compute_percentiles(store, args.year)
    print("percentiles: %d row(s) recomputed for FY%d" % (n, args.year))
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    with _store(args) as store:
        registry = store.dataset_registry()
        latest = store.latest_year()
        publishable = store.sitemap_company_count()
    print("db: %s" % (args.db or default_db_path()))
    print("datasets: %d  latest filing year: %s  publishable companies "
          "with filings: %d" % (len(registry), latest, publishable))
    for row in registry:
        print(
            "  %s  FY%s %-3s rows=%-8s license=%-10s sha=%s"
            % (
                row["dataset_id"], row["year"], row["family"],
                row.get("row_count"), row.get("license_id"),
                (row.get("sha256") or "")[:12],
            )
        )
    if os.environ.get(ingest.UNLICENSED_ENV) == "1":
        _notice("%s=1 is set — unlicensed datasets WILL ingest"
                % ingest.UNLICENSED_ENV)
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="public_ingest.py", description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--db", help="db path (default: PUBLIC_RO_DB_PATH or data/public_ro.db)"
    )
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("discover", help="resolve year -> urls + license")
    p.add_argument("--year", type=int, required=True)
    p.add_argument("--family", choices=("UU", "BL"), default="UU")
    p.add_argument("--actualizat", action="store_true")
    p.set_defaults(func=cmd_discover)

    p = sub.add_parser("ingest", help="ingest one bilanț year/family")
    p.add_argument("--year", type=int, required=True)
    p.add_argument("--family", choices=("UU", "BL"), default="UU")
    p.add_argument("--path", help="local data .txt (skips download)")
    p.add_argument("--spec", help="local companion spec .csv")
    p.add_argument("--license-id", dest="license_id",
                   help="license id verified on the CKAN record")
    p.add_argument("--actualizat", action="store_true")
    p.set_defaults(func=cmd_ingest)

    p = sub.add_parser("ident", help="ingest an identification snapshot")
    p.add_argument("--path", required=True)
    p.add_argument("--label")
    p.set_defaults(func=cmd_ident)

    p = sub.add_parser("percentiles", help="recompute a year's percentiles")
    p.add_argument("--year", type=int, required=True)
    p.set_defaults(func=cmd_percentiles)

    p = sub.add_parser("status", help="dataset registry overview")
    p.set_defaults(func=cmd_status)

    args = parser.parse_args(argv)
    func = getattr(args, "func", None)
    if func is None:
        parser.print_help()
        return 2
    try:
        return int(func(args))
    except Exception as exc:  # noqa: BLE001
        print("public_ingest internal error: %s: %s" % (type(exc).__name__, exc))
        return 2


if __name__ == "__main__":
    sys.exit(main())
