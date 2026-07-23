"""Backfill BVB universe financials from the ANAF Bilanț web service.

Reads the verified ticker→CUI map (engine/public/bvb_cui_map.py), fetches
each company's latest statutory filing (tries the newest year first, falls
back one year), and writes the result to
``src/engine/public/bvb_anaf_cache.json``.

bvb_seed.py loads that cache at import time and overlays the fields onto
the universe rows — ONLY where the curated seed has no value, so the
BET-20's consolidated annual-report figures are never overwritten by
standalone statutory numbers.

Usage (from repo root, stdlib only — no pip installs needed):

    python scripts/backfill_bvb_anaf.py                # refresh the cache
    python scripts/backfill_bvb_anaf.py --verify TICKER=CUI
                                                       # test a CUI's name echo
                                                       # before adding it to the map

Rate limit: ANAF tolerates ~1 req/sec; this script sleeps 1.1s between
calls. A full run over ~35 mapped tickers takes about a minute.

Deploy note: the generated JSON is ENGINE DATA — ship it with the normal
§14 protocol (rsync to host source, rebuild backend). Never docker cp.
"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

# Windows consoles default to cp1252, which can't print ț/ș in company
# names — force UTF-8 (best effort) so the progress log never crashes.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

# Imported as standalone modules to avoid pulling engine.public.__init__
# (which imports httpx-dependent adapters not needed here).
import importlib.util


def _load(name: str, rel: str):
    spec = importlib.util.spec_from_file_location(name, REPO / rel)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


anaf = _load("anaf_bilant", "src/engine/public/providers/anaf_bilant.py")
cui_map = _load("bvb_cui_map", "src/engine/public/bvb_cui_map.py")

CACHE_PATH = REPO / "src" / "engine" / "public" / "bvb_anaf_cache.json"
SLEEP_S = 1.1
# Latest filing year to try; ANAF publishes bilanț data with a lag, so we
# fall back one year when the newest isn't filed/published yet.
YEARS = [2024, 2023]


def verify(arg: str) -> int:
    ticker, _, cui = arg.partition("=")
    if not cui:
        print("usage: --verify TICKER=CUI")
        return 2
    for year in YEARS:
        payload = anaf.fetch_bilant(cui, year)
        if payload:
            parsed = anaf.parse_bilant(payload)
            print(f"{ticker} cui={cui} FY{year} -> {parsed['company_name']}")
            print(json.dumps(anaf.snapshot_fields_from_bilant(parsed), indent=2))
            return 0
        time.sleep(SLEEP_S)
    print(f"{ticker} cui={cui}: no filing found for {YEARS} — CUI likely wrong.")
    return 1


def main() -> int:
    if len(sys.argv) > 2 and sys.argv[1] == "--verify":
        return verify(sys.argv[2])

    out: dict = {}
    tickers = sorted(cui_map.BVB_CUI)
    print(f"Backfilling {len(tickers)} tickers from ANAF Bilanț…")
    for i, ticker in enumerate(tickers, 1):
        cui = cui_map.BVB_CUI[ticker]
        entry = None
        for year in YEARS:
            payload = anaf.fetch_bilant(cui, year)
            time.sleep(SLEEP_S)
            if not payload:
                continue
            parsed = anaf.parse_bilant(payload)
            fields = anaf.snapshot_fields_from_bilant(parsed)
            if not fields:
                continue
            entry = {
                "cui": cui,
                "year": parsed["year"],
                "anaf_name": parsed["company_name"],
                "caen": parsed.get("caen"),
                "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "fields": fields,
            }
            break
        status = f"FY{entry['year']}" if entry else "NO FILING"
        print(f"  [{i:>2}/{len(tickers)}] {ticker:<8} cui={cui:<10} {status}")
        if entry:
            out[ticker] = entry

    CACHE_PATH.write_text(
        json.dumps(out, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"\nWrote {len(out)} entries -> {CACHE_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
