#!/usr/bin/env python3
"""Operator CLI for the public_market freshness sentinel (Part D3).

Deterministic core (runs identically with or without AI credits):
  * assess every seeded entity's filing/price freshness vs source cadence;
  * append stale items to the refetch queue (jsonl, deduped per day);
  * write the last-run summary to data/obs/market_freshness_last.json
    (the /ops surface can read it later).

Optional AI fallback (--propose-identity): for persistently-gapped entities,
ask the flagship whether they look delisted / ticker-changed. PROPOSALS ONLY
-- they land in a review-queue jsonl for a human; nothing is auto-mutated.
Dark (no ANTHROPIC_API_KEY): the flag degrades to a calm notice.

Usage:
  .venv/bin/python scripts/public_market_sentinel.py --seed data/public_market/seed_entities.json
  .venv/bin/python scripts/public_market_sentinel.py --seed ... --propose-identity
  .venv/bin/python scripts/public_market_sentinel.py --seed ... --dry-run --json

Exit codes: 0 = ran (stale entities are a finding, not a failure);
            2 = seed file refused (typed message on stderr).
"""

import argparse
import datetime
import json
import os
import sys

# Repo-standard bootstrap: scripts/ runs against src/ without installation.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SRC = os.path.join(_REPO_ROOT, "src")
if os.path.isdir(_SRC) and _SRC not in sys.path:
    sys.path.insert(0, _SRC)

from engine.public_market.freshness import (  # noqa: E402
    resolve_ai_client,
    resolve_spend_breaker,
)
from engine.public_market.freshness.sentinel import (  # noqa: E402
    SeedFormatError,
    assess_freshness,
    load_seed,
    propose_identity_review,
    write_refetch_queue,
    write_summary,
)


def _parse_now(value):
    # type: (str) -> datetime.datetime
    dt = datetime.datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def main(argv=None):
    # type: (list) -> int
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--seed", required=True,
        help="seeded entities file (JSON list or JSONL; see sentinel.load_seed)",
    )
    parser.add_argument(
        "--now", default=None,
        help="ISO timestamp to assess against (default: current UTC time)",
    )
    parser.add_argument(
        "--data-dir", default=os.path.join(_REPO_ROOT, "data"),
        help="base data directory (default: <repo>/data)",
    )
    parser.add_argument(
        "--propose-identity", action="store_true",
        help="run the AI delisting/ticker-change detector over persistent "
             "gaps (proposals only; dark-safe)",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="assess and print, but write no queue/summary files",
    )
    parser.add_argument(
        "--json", action="store_true", dest="as_json",
        help="print the summary as JSON instead of human lines",
    )
    args = parser.parse_args(argv)

    now = _parse_now(args.now) if args.now else datetime.datetime.now(
        datetime.timezone.utc
    )
    obs_dir = os.path.join(args.data_dir, "obs")
    queue_path = os.path.join(obs_dir, "market_refetch_queue.jsonl")
    review_path = os.path.join(obs_dir, "market_identity_review_queue.jsonl")
    summary_path = os.path.join(obs_dir, "market_freshness_last.json")

    try:
        entities = load_seed(args.seed)
    except SeedFormatError as exc:
        sys.stderr.write("SEED_REFUSED: %s\n" % exc)
        return 2

    assessments = assess_freshness(entities, now)
    stale = [a for a in assessments if a.stale]
    persistent_ids = set(a.entity_id for a in assessments if a.persistent)
    gapped = [e for e in entities if e.entity_id in persistent_ids]

    queued = 0
    if not args.dry_run:
        queued = write_refetch_queue(assessments, queue_path, now)

    proposal_outcome = None
    if args.propose_identity:
        client = resolve_ai_client()
        breaker = resolve_spend_breaker()
        review_target = os.devnull if args.dry_run else review_path
        proposal_outcome = propose_identity_review(
            gapped, client, breaker, review_target, now
        )

    if args.dry_run:
        summary = {
            "generated_at": now.isoformat(),
            "checks": len(assessments),
            "stale_count": len(stale),
            "persistent_gap_count": len(persistent_ids),
            "dry_run": True,
        }
    else:
        summary = write_summary(
            assessments, summary_path, now, queue_path, queued, proposal_outcome
        )

    if args.as_json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        print(
            "freshness sentinel @ %s: %d checks, %d stale, %d persistent gaps"
            % (now.isoformat(), len(assessments), len(stale), len(persistent_ids))
        )
        for a in stale:
            age = "never seen" if a.age_days is None else "%dd old" % a.age_days
            print(
                "  STALE %-6s %-24s %s (allowed %dd)%s"
                % (
                    a.kind, a.entity_id, age, a.allowed_days,
                    "  [PERSISTENT]" if a.persistent else "",
                )
            )
        if not args.dry_run:
            print("  refetch queue: +%d -> %s" % (queued, queue_path))
            print("  summary: %s" % summary_path)
        if proposal_outcome is not None:
            if proposal_outcome.status == "unavailable":
                print("  identity check: %s" % proposal_outcome.unavailable.notice)
            elif proposal_outcome.status == "skipped":
                print("  identity check: no persistent gaps to examine")
            else:
                print(
                    "  identity check: %d proposal(s) -> %s (%d dropped)"
                    % (
                        len(proposal_outcome.proposals),
                        review_path,
                        proposal_outcome.dropped_proposal_count,
                    )
                )
    return 0


if __name__ == "__main__":
    sys.exit(main())
