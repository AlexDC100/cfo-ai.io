#!/usr/bin/env python3
"""public_market UNIVERSE — operator CLI (fetch / verify / load / resolve).

Builds and maintains the versioned seed files under
``src/engine/public_market/seeds/``, then loads them into the spine
store and (for the one market that is addressable end to end) warms the
document cache from the real feed.

Subcommands
-----------
  fetch-us [--out DIR]
        Rebuild the United States seed from the published S&P 500
        constituents data package (network). Records the exact source
        URL, its licence, and the upstream commit SHA as the seed's
        dataset_version.

  fetch-esef --market ID --country ISO [--max-pages N]
        Rebuild one ESEF market's seed from the filings.xbrl.org index
        (which entities actually filed) joined to GLEIF for their legal
        names (network, two sources, both licence-recorded).

  write-empty --market ID --reason TEXT
        Write a DECLARED-GAP seed: schema, provenance and an empty
        member list. This is how a market with no honestly-sourceable
        universe is recorded. It is never filled with plausible names.

  verify [--strict]
        Validate every seed file against the schema and the registry.
        Exit 1 on any problem.

  load [--market ID]
        Upsert seed members into the spine store as ENTITIES (identity
        only — no figure is written by this command).

  resolve --ticker T [--ticker T ...]
        Ticker -> CIK -> companyfacts -> pm1 envelope -> store, through
        the real EDGAR adapter (network, rate-limited, journaled). This
        is what makes a US company retrievable from
        GET /api/public/markets/company/us/<TICKER>.

  status
        The seed catalogue plus what the store actually holds.

Every fetch declares the SEC-style user agent and paces itself. Nothing
here writes a figure that did not come from a deterministic feed, and
nothing here invents a member: a source that cannot be reached is an
error, never an empty list quietly written over a good file.

Exit codes: 0 ok · 1 verification/refusal · 2 usage/internal error.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import socket
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return here.parent


REPO_ROOT = _find_repo_root()
SRC = REPO_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from engine.public_market import registry as _registry  # noqa: E402
from engine.public_market import universe as _universe  # noqa: E402

USER_AGENT = "cfo-ai.io engine (contact: ad.crestin@gmail.com)"

# ── source declarations (URL + verbatim licence, one place each) ─────

SP500_CSV_URL = (
    "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/"
    "main/data/constituents.csv"
)
SP500_COMMITS_URL = (
    "https://api.github.com/repos/datasets/s-and-p-500-companies/commits"
    "?path=data/constituents.csv&per_page=1"
)
SP500_HOMEPAGE = "https://github.com/datasets/s-and-p-500-companies"
#: Verbatim from the data package's own datapackage.json `licenses` block.
SP500_LICENSE = (
    "ODC-PDDL-1.0 — Open Data Commons Public Domain Dedication and "
    "License v1.0 (http://opendatacommons.org/licenses/pddl/), as declared "
    "in the data package's datapackage.json"
)

FILINGS_API = "https://filings.xbrl.org/api/filings"
GLEIF_API = "https://api.gleif.org/api/v1/lei-records"
#: Verbatim from https://www.gleif.org/en/meta/lei-data-terms-of-use
#: (retrieved 2026-08-30).
GLEIF_LICENSE = (
    "The data available through the Access Service are provided under the "
    "CC0 licence, see CC0 1.0 Universal (CC0 1.0). "
    "(gleif.org/en/meta/lei-data-terms-of-use, retrieved 2026-08-30)"
)

_MIN_INTERVAL_S = 1.0
_last_request_at = [0.0]


def _pace() -> None:
    elapsed = time.time() - _last_request_at[0]
    if elapsed < _MIN_INTERVAL_S:
        time.sleep(_MIN_INTERVAL_S - elapsed)
    _last_request_at[0] = time.time()


def _fetch(url: str, accept: Optional[str] = None, timeout: int = 90) -> bytes:
    """One paced, declared HTTP GET. A failure raises — an unreachable
    source must never degrade into an empty seed written over a good
    file."""
    _pace()
    headers = {"User-Agent": USER_AGENT}
    if accept:
        headers["Accept"] = accept
    request = urllib.request.Request(url, headers=headers)
    socket.setdefaulttimeout(timeout)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def _fetch_json(url: str, accept: Optional[str] = None) -> Any:
    return json.loads(_fetch(url, accept=accept).decode("utf-8"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _seeds_dir(args: argparse.Namespace) -> Path:
    if getattr(args, "out", None):
        return Path(args.out)
    return SRC / "engine" / "public_market" / "seeds"


def _write_seed(document: Dict[str, Any], directory: Path) -> Path:
    """Validate BEFORE writing. A seed file that fails its own schema
    must never reach disk, because the next command to read it is the
    one that loads production identities."""
    market_id = str(document.get("market_id") or "")
    problems = _universe.validate_seed(document, origin="<new>")
    if problems:
        raise SystemExit("refusing to write an invalid seed:\n  "
                         + "\n  ".join(problems))
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / ("%s.json" % market_id)
    target.write_text(
        json.dumps(document, indent=2, ensure_ascii=False, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    return target


def _market_or_die(market_id: str) -> "_registry.Market":
    market = _registry.find_market(market_id)
    if market is None:
        raise SystemExit("unknown market %r — known: %s"
                         % (market_id, ", ".join(_registry.market_ids())))
    return market


# ── fetch-us ────────────────────────────────────────────────────────


def _sp500_dataset_version() -> Tuple[str, str]:
    """(commit sha, commit date) of the constituents file — the seed's
    dataset_version. A membership list without a version is a list
    nobody can diff."""
    commits = _fetch_json(SP500_COMMITS_URL, accept="application/vnd.github+json")
    if not isinstance(commits, list) or not commits:
        raise SystemExit("could not read the constituents file's commit history")
    head = commits[0]
    sha = str(head.get("sha") or "")
    date = str(head.get("commit", {}).get("committer", {}).get("date") or "")
    if not sha or not date:
        raise SystemExit("commit history row is missing sha/date")
    return sha, date[:10]


def cmd_fetch_us(args: argparse.Namespace) -> int:
    market = _market_or_die(args.market)
    sha, committed_on = _sp500_dataset_version()
    body = _fetch(SP500_CSV_URL).decode("utf-8")
    rows = list(csv.DictReader(io.StringIO(body)))
    if len(rows) < 400:
        raise SystemExit("constituents.csv returned only %d rows — refusing to "
                         "overwrite a good seed with a truncated fetch"
                         % len(rows))

    # One ISSUER per CIK. Alphabet (GOOGL/GOOG), Fox (FOXA/FOX) and News
    # Corp (NWSA/NWS) each appear as TWO constituent rows sharing ONE
    # CIK: two listed share classes of one company. Emitting them as two
    # members mints the same entity id twice and double-counts the
    # market — the real file refuses to validate if you try, which is
    # how this was caught.
    # The ONLY name edit made here: a trailing "(Class A)" / "(Class C)"
    # is a share-class annotation on a row, not part of the issuer's
    # name. Every other parenthetical the upstream writes ("(The)",
    # "(Eli)") is its own naming convention and is kept verbatim —
    # tidying a source's values beyond a written rule is editorializing.
    class_suffix = re.compile(r"\s*\(Class\s+[A-Z]\)\s*$")

    by_cik: Dict[str, Dict[str, Any]] = {}
    rowless: List[Dict[str, Any]] = []
    for row in rows:
        ticker = (row.get("Symbol") or "").strip().upper()
        name = class_suffix.sub("", (row.get("Security") or "").strip())
        cik = (row.get("CIK") or "").strip().lstrip("0")
        if not ticker or not name:
            continue
        if not cik.isdigit():
            # No CIK: keep the row (it is still a real company and still
            # searchable) but it will queue for review at load time
            # rather than be minted from its name.
            rowless.append({"name": name, "ticker": ticker})
            continue
        issuer = by_cik.get(cik)
        if issuer is None:
            by_cik[cik] = {"name": name, "tickers": [ticker], "cik": cik}
        else:
            issuer["tickers"].append(ticker)
            # Keep the shortest name: the extra rows are share-class
            # variants ("Alphabet Inc. (Class A)"), not new companies.
            if len(name) < len(issuer["name"]):
                issuer["name"] = name

    members: List[Dict[str, Any]] = []
    for issuer in by_cik.values():
        listings = sorted(set(issuer["tickers"]))
        member: Dict[str, Any] = {"name": issuer["name"], "cik": issuer["cik"]}
        if len(listings) == 1:
            member["ticker"] = listings[0]
        else:
            member["tickers"] = listings
        members.append(member)
    members.extend(rowless)
    members.sort(key=lambda m: (m.get("ticker") or (m.get("tickers") or [""])[0]))
    multi = [m for m in members if len(m.get("tickers") or []) > 1]

    document = {
        "schema": _universe.SEED_SCHEMA,
        "market_id": market.market_id,
        "as_of": committed_on,
        "source": {
            "name": "S&P 500 Companies (Frictionless data package)",
            "url": SP500_CSV_URL,
            "homepage": SP500_HOMEPAGE,
            "dataset_version": sha,
            "retrieved_at": _now_iso(),
            "upstream": "Wikipedia — List of S&P 500 companies "
                        "(https://en.wikipedia.org/wiki/List_of_S%26P_500_companies), "
                        "as declared by the data package's own sources block",
            "identity_only": True,
        },
        "license_note": SP500_LICENSE,
        "coverage_note": (
            "S&P 500 constituents, identity only (ticker, legal name, SEC CIK) "
            "— NO figures: every US number is fetched from SEC EDGAR "
            "companyfacts per company, with its own accession. "
            "NASDAQ-100 membership is deliberately ABSENT from this file: the "
            "index composition is proprietary to Nasdaq, Inc. and no "
            "licence-clear machine-readable public dataset publishes it, so "
            "the only free copies are HTML tables — scraping, which this "
            "document class does not do. The long tail (every NASDAQ-100 name "
            "not in the S&P 500, and every other SEC registrant with a ticker) "
            "stays reachable through the SEC's own company_tickers.json "
            "mapping, which the EDGAR adapter resolves on demand. "
            "The upstream list is community-maintained and can lag an index "
            "change by days; it is used for DISCOVERY only and never as the "
            "authority for a number."
        ),
        "member_count": len(members),
        "members": members,
    }
    target = _write_seed(document, _seeds_dir(args))
    print("wrote %s — %d issuers from %d constituent rows "
          "(%d multi-class), dataset_version %s (%s)"
          % (target, len(members), len(rows), len(multi), sha[:12], committed_on))
    for issuer in multi:
        print("    multi-class issuer: %-28s %s"
              % (issuer["name"], "/".join(issuer["tickers"])))
    return 0


# ── fetch-esef ──────────────────────────────────────────────────────


def _esef_entity_ids(country: str, max_pages: int) -> Tuple[List[str], int]:
    """Distinct entity identifiers (LEIs) that actually filed for one
    country, read from the filings index the ESEF adapter already uses.

    This is COVERAGE, not index membership: it lists exactly the
    companies the feed can speak about. An index list would name
    companies we hold nothing for."""
    seen: List[str] = []
    known = set()
    total = 0
    page = 1
    while page <= max_pages:
        url = FILINGS_API + "?" + urllib.parse.urlencode([
            ("page[size]", "500"),
            ("page[number]", str(page)),
            ("sort", "fxo_id"),
            ("filter", json.dumps(
                [{"name": "country", "op": "eq", "val": country}])),
        ])
        payload = _fetch_json(url)
        if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
            raise SystemExit("filings index returned an unexpected shape for %s"
                             % country)
        rows = payload["data"]
        total = int(payload.get("meta", {}).get("count") or total)
        for item in rows:
            attributes = item.get("attributes") or {}
            for key in ("json_url", "report_url", "package_url"):
                value = attributes.get(key)
                if isinstance(value, str) and value.startswith("/"):
                    segments = value.split("/")
                    if len(segments) > 1 and segments[1]:
                        identifier = segments[1]
                        if identifier not in known:
                            known.add(identifier)
                            seen.append(identifier)
                    break
        if len(rows) < 500:
            break
        page += 1
    return sorted(seen), total


def _gleif_names(leis: List[str]) -> Tuple[Dict[str, Dict[str, Any]], Optional[str]]:
    """{LEI: {name, country}} plus GLEIF's golden-copy publish date.

    A LEI GLEIF does not return is left OUT of the map — the caller then
    keeps the entity with its LEI and no name rather than inventing one."""
    out: Dict[str, Dict[str, Any]] = {}
    golden: Optional[str] = None
    batch = 100
    for start in range(0, len(leis), batch):
        chunk = leis[start:start + batch]
        url = GLEIF_API + "?" + urllib.parse.urlencode({
            "filter[lei]": ",".join(chunk),
            "page[size]": str(batch),
        })
        payload = _fetch_json(url, accept="application/vnd.api+json")
        if not isinstance(payload, dict):
            raise SystemExit("GLEIF returned an unexpected shape")
        golden = golden or (payload.get("meta", {})
                            .get("goldenCopy", {}).get("publishDate"))
        for record in payload.get("data") or []:
            attributes = record.get("attributes") or {}
            entity = attributes.get("entity") or {}
            lei = attributes.get("lei")
            name = (entity.get("legalName") or {}).get("name")
            if not lei or not name:
                continue
            out[str(lei)] = {
                "name": str(name),
                "country": (entity.get("legalAddress") or {}).get("country"),
            }
    return out, golden


def cmd_fetch_esef(args: argparse.Namespace) -> int:
    market = _market_or_die(args.market)
    country = str(args.country).strip().upper()
    identifiers, filings_total = _esef_entity_ids(country, args.max_pages)
    if not identifiers:
        raise SystemExit(
            "the filings index returned no entities for country %s — refusing "
            "to write an empty seed from a fetch that may simply have failed. "
            "Use `write-empty` to record a DELIBERATE gap." % country
        )
    names, golden = _gleif_names(identifiers)

    members: List[Dict[str, Any]] = []
    unnamed = 0
    for lei in identifiers:
        record = names.get(lei)
        if record is None:
            # No GLEIF record: keep the identifier out rather than ship a
            # member whose only "name" would be its own LEI. It stays
            # discoverable the moment GLEIF publishes it.
            unnamed += 1
            continue
        members.append({"name": record["name"], "lei": lei})
    members.sort(key=lambda m: m["lei"])

    as_of = (golden or _now_iso())[:10]
    document = {
        "schema": _universe.SEED_SCHEMA,
        "market_id": market.market_id,
        "as_of": as_of,
        "source": {
            "name": "filings.xbrl.org ESEF filings index, joined to GLEIF "
                    "Level 1 legal names",
            "url": FILINGS_API + "?filter=country eq " + country,
            "dataset_version": "filings.xbrl.org country=%s count=%d + GLEIF "
                               "golden copy %s" % (country, filings_total,
                                                   golden or "unknown"),
            "retrieved_at": _now_iso(),
            "names_from": GLEIF_API,
            "identity_only": True,
        },
        "license_note": (
            "Filings index: at present, there are no restrictions on the ways "
            "that the data can be used (filings.xbrl.org/docs/about). "
            "Legal names: " + GLEIF_LICENSE
        ),
        "coverage_note": (
            "The entities that have actually filed ESEF reports for country "
            "%s, keyed by the LEI the filings index publishes and named from "
            "GLEIF — identity only, NO figures. This is FEED COVERAGE, not "
            "index membership: a national index list would name companies "
            "this platform holds nothing for, while this file names exactly "
            "the companies the ESEF feed can speak about. Index constituent "
            "lists were considered and rejected as a source — they are the "
            "index providers' proprietary IP with no licence-clear "
            "machine-readable public distribution, and the free copies are "
            "HTML tables. Members carry no ticker because the feed publishes "
            "none, which is exactly why this market's registry status is "
            "fundamentals_only: the figures exist, the ticker lookup does "
            "not. %d filing rows yielded %d distinct entities, %d of which "
            "had no GLEIF Level 1 record at fetch time and are therefore "
            "absent rather than named by guess."
            % (country, filings_total, len(identifiers), unnamed)
        ),
        "member_count": len(members),
        "members": members,
    }
    target = _write_seed(document, _seeds_dir(args))
    print("wrote %s — %d members from %d filings (%d entities, %d unnamed)"
          % (target, len(members), filings_total, len(identifiers), unnamed))
    return 0


# ── write-empty ─────────────────────────────────────────────────────


def cmd_write_empty(args: argparse.Namespace) -> int:
    market = _market_or_die(args.market)
    document = {
        "schema": _universe.SEED_SCHEMA,
        "market_id": market.market_id,
        "as_of": args.as_of or datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "source": {
            "name": "declared gap — no source",
            "url": "https://cfo-ai.io/docs/public-market-coverage",
            "dataset_version": "empty-%s" % market.status,
            "retrieved_at": _now_iso(),
            "identity_only": True,
        },
        "license_note": market.license_notes,
        "coverage_note": args.reason,
        "member_count": 0,
        "members": [],
    }
    target = _write_seed(document, _seeds_dir(args))
    print("wrote %s — DECLARED GAP (0 members, status %s)"
          % (target, market.status))
    return 0


# ── verify ──────────────────────────────────────────────────────────


def cmd_verify(args: argparse.Namespace) -> int:
    directory = _seeds_dir(args)
    paths = _universe.seed_paths(directory)
    if not paths:
        print("NOTICE no seed files under %s" % directory)
        return 1
    failures = 0
    for path in paths:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except ValueError as exc:
            print("FAIL %s — not valid JSON: %s" % (path.name, exc))
            failures += 1
            continue
        problems = _universe.validate_seed(raw, origin=path.name)
        if problems:
            failures += 1
            print("FAIL %s" % path.name)
            for problem in problems:
                print("    %s" % problem)
            continue
        seed = _universe.seed_from_dict(raw, origin=str(path))
        mintable = sum(1 for m in seed.members if m.entity_id() is not None)
        print("ok   %-6s %4d members (%d mintable) as_of %s — %s"
              % (seed.market_id, seed.member_count, mintable, seed.as_of,
                 seed.source.get("name")))
    if failures:
        print("\n%d seed file(s) failed validation" % failures)
        return 1
    print("\nall %d seed file(s) valid" % len(paths))
    return 0


# ── load ────────────────────────────────────────────────────────────


def _open_store():
    from engine.public_market.store import get_store

    return get_store()


def cmd_load(args: argparse.Namespace) -> int:
    store = _open_store()
    directory = _seeds_dir(args)
    if args.market:
        _market_or_die(args.market)
        seed = _universe.seed_for(args.market, directory)
        if seed is None:
            raise SystemExit("no seed file for market %r" % args.market)
        seeds = [seed]
    else:
        seeds = _universe.load_seeds(directory)
    for seed in seeds:
        report = _universe.load_into_store(seed, store)
        print("%-6s seen %4d · upserted %4d · queued %3d · market-conflicts %2d"
              % (report.market_id, report.seen, report.upserted, report.queued,
                 len(report.market_conflicts)))
        for name in report.market_conflicts:
            print("    already held by another market: %s" % name)
    print("\nstore now holds: %s" % json.dumps(store.market_counts(), sort_keys=True))
    return 0


# ── resolve (EDGAR end to end) ──────────────────────────────────────


def cmd_resolve(args: argparse.Namespace) -> int:
    from engine.public_market import search as _search

    store = _open_store()
    exit_code = 0
    for ticker in args.ticker:
        outcome = _search.resolve_on_demand(ticker, store=store,
                                            journal_dir=args.journal_dir)
        if outcome.envelope is None:
            exit_code = 1
            print("REFUSED %-8s %s — %s"
                  % (ticker, outcome.code, outcome.detail))
            continue
        envelope = outcome.envelope
        print("ok      %-8s entity_id %s · %d figures · %d refusals · "
              "as_of %s · cached=%s"
              % (ticker, outcome.entity_id,
                 len(envelope.get("figures") or {}),
                 len(envelope.get("refusals") or []),
                 (envelope.get("provenance") or {}).get("as_of"),
                 outcome.cached))
        if outcome.cache_reason:
            # A valid document that did NOT reach the cache. Loud, because
            # the serving route only ever reads the cache.
            print("        NOT CACHED: %s" % outcome.cache_reason)
            exit_code = 1
    return exit_code


# ── status ──────────────────────────────────────────────────────────


def cmd_status(args: argparse.Namespace) -> int:
    directory = _seeds_dir(args)
    catalogue = _universe.catalogue(directory)
    print("SEEDS (%d markets, %d members)"
          % (len(catalogue["seeds"]), catalogue["total_members"]))
    for entry in catalogue["seeds"]:
        print("  %-6s %5d members · as_of %s · %s"
              % (entry["market_id"], entry["member_count"], entry["as_of"],
                 entry["source"].get("name")))
    try:
        store = _open_store()
    except Exception as exc:  # noqa: BLE001
        print("\nSTORE unavailable: %s" % exc)
        return 0
    print("\nSTORE entities per market: %s"
          % json.dumps(store.market_counts(), sort_keys=True))
    queue = store.review_queue(limit=5)
    print("REVIEW QUEUE (%d most recent shown):" % len(queue))
    for row in queue:
        print("  [%s] %s — %s" % (row.get("market_id"), row.get("reason"),
                                  (row.get("detail") or "")[:90]))
    return 0


# ── argument parsing ────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="public_market_seed",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    common_out = argparse.ArgumentParser(add_help=False)
    common_out.add_argument("--out", help="seeds directory (default: the "
                                          "package's own seeds/)")

    p = sub.add_parser("fetch-us", parents=[common_out],
                       help="rebuild the S&P 500 seed (network)")
    p.add_argument("--market", required=True,
                   help="registry market id this seed belongs to")
    p.set_defaults(func=cmd_fetch_us)

    p = sub.add_parser("fetch-esef", parents=[common_out],
                       help="rebuild one ESEF market's seed (network)")
    p.add_argument("--market", required=True)
    p.add_argument("--country", required=True,
                   help="ISO-3166 code the filings index filters on "
                        "(e.g. GB for the United Kingdom market)")
    p.add_argument("--max-pages", type=int, default=20)
    p.set_defaults(func=cmd_fetch_esef)

    p = sub.add_parser("write-empty", parents=[common_out],
                       help="record a DECLARED GAP for a market")
    p.add_argument("--market", required=True)
    p.add_argument("--reason", required=True,
                   help="why this market's universe is empty — written into "
                        "coverage_note and shown to operators")
    p.add_argument("--as-of", dest="as_of")
    p.set_defaults(func=cmd_write_empty)

    p = sub.add_parser("verify", parents=[common_out],
                       help="validate every seed file")
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("load", parents=[common_out],
                       help="upsert seed members into the spine store")
    p.add_argument("--market")
    p.set_defaults(func=cmd_load)

    p = sub.add_parser("resolve",
                       help="ticker -> CIK -> companyfacts -> store (network)")
    p.add_argument("--ticker", action="append", required=True)
    p.add_argument("--journal-dir",
                   help="append the ingest journal + DLQ here")
    p.set_defaults(func=cmd_resolve)

    p = sub.add_parser("status", parents=[common_out],
                       help="seed catalogue + store counts")
    p.set_defaults(func=cmd_status)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except SystemExit:
        raise
    except _universe.SeedError as exc:
        print("REFUSED %s" % exc, file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print("ERROR %s: %s" % (type(exc).__name__, exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
