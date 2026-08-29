#!/usr/bin/env python3
"""Public-funnel rollup CLI (Lane 5, public-data acquisition engine).

Aggregates the funnel_events table (data/public_ro.db) over a trailing
window, best-effort joins the Supabase attribution counts (signups
attributed IN THAT SAME WINDOW; of those, users who uploaded), writes
the honest record to data/obs/funnel_last.json (the /ops funnel panel +
the ``engine_ops.py status`` funnel lines read it), and prints a summary.

Honesty rules (wave contract):
  * rates are None ("n/a") on a zero/unknown denominator — absence is
    never reconstructed as a measurement;
  * when Supabase is unreachable (no service key on this host, network
    down) the attributed counts are None, not 0;
  * ``--window-days`` sizes BOTH sides of every rate. It is passed to
    the attribution read too, so an all-time numerator can never be
    divided by a windowed denominator (that printed rates above 100%).

Conventions (matches scripts/engine_ops.py): exit 0 always, 2 only for
usage/internal errors; NOTICE lines for anomalies, never red.

Usage:
  python scripts/public_funnel.py [--db PATH] [--window-days N]
                                  [--out PATH] [--no-supabase] [--json]

Env:
  PUBLIC_RO_DB_PATH  moves the events DB (default data/public_ro.db)
  ENGINE_OBS_DIR     moves data/obs (funnel_last.json home)
"""
from __future__ import annotations

import argparse
import json
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

from engine.public_ro import funnel  # noqa: E402


def _fmt_rate(value) -> str:
    return "n/a" if value is None else "%.1f%%" % (float(value) * 100.0)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="public_funnel.py",
        description="Roll up public-funnel events into data/obs/funnel_last.json.",
    )
    parser.add_argument("--db", default=None, help="events DB path (default: PUBLIC_RO_DB_PATH or data/public_ro.db)")
    parser.add_argument("--window-days", type=int, default=30)
    parser.add_argument("--out", default=None, help="record path (default: <obs dir>/funnel_last.json)")
    parser.add_argument(
        "--no-supabase", action="store_true",
        help="skip the attribution join (counts become n/a, not 0)",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    try:
        counts = funnel.read_event_counts(db=args.db, window_days=args.window_days)
        if args.no_supabase:
            signups, uploads = None, None
        else:
            # ONE window for both halves of every rate: the attributed
            # signups must be counted over the same trailing days as the
            # traffic they are divided by, or the panel prints >100%.
            signups, uploads = funnel.fetch_attributed_counts(
                window_days=args.window_days
            )
            if signups is None:
                print(
                    "NOTICE  public funnel: Supabase attribution source "
                    "unreachable — attributed counts recorded as n/a, not 0"
                )
            elif uploads is None:
                print(
                    "NOTICE  public funnel: attributed upload count "
                    "unavailable — recorded as n/a, not 0"
                )
        record = funnel.compute_funnel_rollup(
            event_counts=counts,
            signups_attributed=signups,
            uploads_attributed=uploads,
        )
        target = funnel.write_funnel_record(record, path=args.out)

        if args.json:
            print(json.dumps(record, indent=2, ensure_ascii=False))
            return 0
        print("PUBLIC FUNNEL — %sd window" % record.get("window_days"))
        print("=" * 62)
        print("page views      %s (%s browser)" % (record["traffic"], record["traffic_browser"]))
        print("searches        %s" % record["searches"])
        print("report opens    %s" % record["report_opens"])
        print("locked taps     %s" % record["locked_ratio_taps"])
        print("CTA clicks      %s" % record["cta_clicks"])
        print("teardown exports %s" % record["teardown_exports"])
        print(
            "signups attributed  %s"
            % ("n/a" if record["signups_attributed"] is None else record["signups_attributed"])
        )
        print(
            "uploads attributed  %s"
            % ("n/a" if record["uploads_attributed"] is None else record["uploads_attributed"])
        )
        print("public→signup   %s" % _fmt_rate(record["public_to_signup_rate"]))
        print("signup→upload   %s" % _fmt_rate(record["signup_to_upload_rate"]))
        print("written         %s" % target)
        return 0
    except Exception:  # noqa: BLE001 — internal error is the ONLY red path
        import traceback

        traceback.print_exc()
        return 2


if __name__ == "__main__":
    sys.exit(main())
