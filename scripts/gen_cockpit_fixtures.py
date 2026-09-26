"""Regenerates tests/engine/fixtures/forecast/cockpit_agras_*.json from the
REAL route (create_app over the tenancy double, the cached loader, the
engine, engine.forecast.cockpit) on the committed agras corpus book — the
bytes the frontend's cockpit gates read instead of a hand-typed copy.
recompute_ms is removed: it is a clock reading and sits outside
pins.body_hash. Pinned by tests/engine/test_forecast_cockpit.py
(test_c_the_committed_cockpit_fixtures_are_what_the_route_serves).

Run from the repository root:
    PYTHONPATH=src CFO_AI_SKIP_BOOT_VERIFY=1 python scripts/gen_cockpit_fixtures.py

THE OWNER'S LOCAL BOOKS, NEVER COMMITTED. With FORECAST_LOCAL_SCANDIA set
(see the test module's docstring), the same requests can be captured from
the owner's local pair for the frontend's lever-scale gate
(frontend/pages/cfo/__tests__/forecastCockpitLeverScale.test.tsx, which reads
them through FORECAST_LOCAL_COCKPIT_FIXTURES=<dir>):
    python scripts/gen_cockpit_fixtures.py --book scandia_local --out <dir OUTSIDE the repo>
The script refuses an --out inside the repository for any book but the
committed corpus books: a client's figures never land in git.

THE DEVELOPER (2026-09-26). The committed corpus developer (realestate) is
captured too, for its base case and its bank export only, so the frontend's
margin gates read the cockpit the engine serves a book whose margins the rule
refuses (engine.ratios.margin_meaning) rather than a hand-typed copy:
    python scripts/gen_cockpit_fixtures.py --book realestate --requests base,export
Pinned by tests/engine/test_margin_meaning.py.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, "tests/engine")
import test_forecast_cockpit as C  # noqa: E402

BASE = "tests/engine/fixtures/forecast/"

#: The committed corpus books (anonymized, already in git): their cockpit
#: bytes may be written inside the repository. Any other book may not.
CORPUS_BOOKS = ("agras", "carniprod", "retail", "realestate")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--book", default="agras")
    ap.add_argument("--out", default=None)
    ap.add_argument("--requests", default=None,
                    help="comma-separated fixture names (default: every FIXTURE_REQUESTS entry)")
    args = ap.parse_args()
    out = args.out or BASE
    repo = os.path.realpath(os.getcwd())
    if args.book not in CORPUS_BOOKS:
        if not args.out:
            sys.exit("--out is required for a book outside the corpus (never inside the repo)")
        if os.path.realpath(out).startswith(repo + os.sep) or os.path.realpath(out) == repo:
            sys.exit("refusing to write %s's bytes inside the repository" % args.book)
    wanted = None if not args.requests else set(x.strip() for x in args.requests.split(",") if x.strip())
    os.makedirs(out, exist_ok=True)
    with C._World(args.book) as world:
        for name, route, body in C.FIXTURE_REQUESTS:
            if wanted is not None and name not in wanted:
                continue
            served = world.ok(body, route=route)
            served.pop("recompute_ms", None)
            if "cockpit" in served:
                served["cockpit"].pop("recompute_ms", None)
            path = os.path.join(out, "cockpit_%s_%s.json" % (args.book, name))
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(served, fh, indent=1, sort_keys=True, ensure_ascii=False)
                fh.write("\n")
            print(name, len(json.dumps(served)))


if __name__ == "__main__":
    main()
