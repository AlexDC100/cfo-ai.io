#!/usr/bin/env python3
"""LR9 — remove the workspaces a QA walk created, and nothing else.

WHY THIS SCRIPT EXISTS
======================
The one incident in this repo's history that cost real cleanup was a test
harness pointed at the production Supabase project: it minted 8,498
organizations before anyone noticed, because the test-mode session boot
creates a workspace on first load and nothing ever removed them. The fix
that mattered was not "delete the rows" — it was making the deletion path
so narrow that it cannot be aimed at production by accident.

So this script REFUSES to run unless BOTH of these hold:

  1. `--label` is given explicitly. There is no default. A QA workspace is
     one whose NAME contains that label; nothing else is ever considered,
     so a workspace a real customer created can never match unless they
     chose to name it after the label, which the operator picks.
  2. The Supabase URL it is about to talk to passes a non-production
     check (`--allow-url-substring`, or one of the known-local hosts).
     The production project ref is refused outright, with `--i-know`
     deliberately NOT implemented: there is no flag that makes this
     script delete production data. If production ever needs cleaning,
     that is a human at the SQL console, reading each row.

It prints the org count before and after so the operator can see exactly
what moved, and it is a NO-OP — exit 0, zero deletions — when nothing
carries the label. That is the expected result on a clean tree, and it is
what the launch matrix records.

USAGE
    python3 scripts/qa_cleanup.py --label QA-LAUNCH --dry-run
    python3 scripts/qa_cleanup.py --label QA-LAUNCH

ENVIRONMENT
    VITE_SUPABASE_URL         the project to act on
    SUPABASE_SERVICE_ROLE_KEY service role (archive/purge run as the owner)

Deletion goes through the SAME RPCs the product uses — `archive_workspace`
then `purge_expired_workspaces` — rather than a raw DELETE, because
`purge_expired_workspaces()` deletes the org-scoped roots EXPLICITLY (most
`org_id` columns have no foreign key to `organizations`, so a plain
`delete from organizations` orphans every document, period and alert
instead of removing them). Reusing the product's own path means this
script cannot drift from it.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, List


# The production project ref. Hard-refused; see the module docstring.
PRODUCTION_REFS = ("cjclenykwlngqvapmisb",)

# Hosts that are self-evidently not production.
LOCAL_HOST_MARKERS = ("localhost", "127.0.0.1", "test.supabase.co", "stub")


class Refused(SystemExit):
    """Raised as a hard stop with an operator-readable reason."""


def _refuse(msg: str) -> "Refused":
    return Refused(f"REFUSED: {msg}")


def _check_target(url: str, allow_substring: str | None) -> None:
    """Fail closed unless the target is demonstrably not production."""
    if not url:
        raise _refuse(
            "VITE_SUPABASE_URL is unset. This script will not guess a target."
        )
    for ref in PRODUCTION_REFS:
        if ref in url:
            raise _refuse(
                f"target {url!r} is the PRODUCTION project ({ref}). "
                "There is no override flag. Clean production by hand, at the "
                "SQL console, reading each row."
            )
    if any(marker in url for marker in LOCAL_HOST_MARKERS):
        return
    if allow_substring and allow_substring in url:
        return
    raise _refuse(
        f"target {url!r} is neither a known-local host nor matched by "
        "--allow-url-substring. Pass --allow-url-substring <part-of-the-url> "
        "to state, explicitly, which non-production project you mean."
    )


def _rest(
    url: str, key: str, path: str, method: str = "GET", body: Any = None
) -> Any:
    req = urllib.request.Request(
        f"{url.rstrip('/')}{path}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode() or "null"
            return json.loads(raw)
    except urllib.error.HTTPError as exc:  # pragma: no cover - network path
        detail = exc.read().decode(errors="replace")[:400]
        raise SystemExit(f"Supabase {method} {path} → {exc.code}: {detail}")


def _list_orgs(url: str, key: str) -> List[Dict[str, Any]]:
    rows = _rest(url, key, "/rest/v1/organizations?select=id,name,archived_at")
    return rows if isinstance(rows, list) else []


def main(argv: List[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Delete QA-labelled workspaces.")
    ap.add_argument(
        "--label",
        required=True,
        help="Workspaces whose NAME contains this string are QA workspaces. "
        "No default, on purpose.",
    )
    ap.add_argument(
        "--allow-url-substring",
        default=None,
        help="Assert which non-production Supabase project is meant.",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be deleted and change nothing.",
    )
    args = ap.parse_args(argv)

    label = args.label.strip()
    if not label:
        raise _refuse("--label may not be empty (that would match everything).")

    url = os.environ.get("VITE_SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    _check_target(url, args.allow_url_substring)
    if not key:
        raise _refuse("SUPABASE_SERVICE_ROLE_KEY is unset.")

    orgs = _list_orgs(url, key)
    before = len(orgs)
    matched = [o for o in orgs if label in (o.get("name") or "")]

    print(f"target                : {url}")
    print(f"label                 : {label!r}")
    print(f"organizations before  : {before}")
    print(f"matching the label    : {len(matched)}")

    if not matched:
        print("NO-OP — nothing carries the label. Nothing was changed.")
        print(f"organizations after   : {before}")
        return 0

    for o in matched:
        print(f"  · {o['id']}  {o.get('name')!r}")

    if args.dry_run:
        print("DRY RUN — nothing was changed.")
        print(f"organizations after   : {before}")
        return 0

    # Archive each, then purge. `archive_workspace` sets purge_after = now()
    # + 30 days, so a plain purge would not take them yet; the purge RPC is
    # still the deleter, because it is the one that removes the org-scoped
    # roots explicitly. Archive first keeps this on the product's own path.
    for o in matched:
        _rest(url, key, "/rest/v1/rpc/archive_workspace", "POST", {"p_org_id": o["id"]})
    _rest(url, key, "/rest/v1/rpc/purge_expired_workspaces", "POST", {})

    after = len(_list_orgs(url, key))
    print(f"organizations after   : {after}")
    still = [o for o in _list_orgs(url, key) if label in (o.get("name") or "")]
    if still:
        print(
            f"NOTE: {len(still)} labelled workspaces are archived but not yet "
            "purged — purge_expired_workspaces() only removes rows whose "
            "purge_after has passed. Re-run after the retention window, or "
            "purge them at the SQL console."
        )
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
