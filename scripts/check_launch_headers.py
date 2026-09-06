#!/usr/bin/env python3
"""GATE `launch-headers` — the SPA's security headers, statically and live.

WHAT IT CHECKS, AND WHY IT IS STATIC
====================================
`nginx.conf` is the SPA's only header authority (Caddy fronts it and
passes responses through). The whole reason this gate exists is one nginx
rule that is easy to write correctly once and break silently forever
after: **`add_header` inside a `location` block discards every
`add_header` inherited from the server block.** Three of nginx.conf's
four locations set their own Cache-Control / Content-Disposition, so a
tidy-looking "put the security headers at the server level" edit removes
them from `/assets/`, `/templates/` and — worst — `/index.html`, the one
response where X-Frame-Options and the CSP do anything at all. Nothing
about that failure is visible in a config test or a container log; it is
visible only in a response header nobody re-reads.

So the gate reads the file and asserts the invariant directly: every
block that sets ANY header must set ALL of the required ones.

TC-11 — what this reds on after the repair: deleting one `add_header`
line from the server block or from any location (it names the block and
the header), or adding a new location with a Cache-Control and no
security headers (same). HSTS shorter than a year, or carrying `preload`
— a submission to a browser-vendor list is the owner's decision, not a
deploy's. And the CSP being switched from Report-Only to enforced without
the backlog ticket being done: an enforced CSP on a Vite SPA that has
never been served under one is the failure this gate guards against, not
a hardening it wants.

It also reds on ITSELF. The first version of `_blocks()` required the
brace to follow the word immediately, so `server {` never matched and the
gate examined only the three locations while printing a confident "3
blocks, all fine" — a removal planted in the server block stayed green.
The vacuity floor in `check_static()` (at least four blocks with their
own `add_header`) is what turns that class of blindness into a red
naming the count it actually saw.

LIVE PROBE (optional, READ-ONLY): `--url https://cfo-ai.io` does one
unauthenticated GET and prints which headers are actually present on the
deployed origin. It never fails the gate — the deployed state is the
coordinator's to change — it only reports, so the launch matrix can
carry a measured LIVE column instead of an assumed one.

    python3 scripts/check_launch_headers.py
    python3 scripts/check_launch_headers.py --url https://cfo-ai.io
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys
from typing import Dict, List, Tuple

REQUIRED = (
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Content-Security-Policy-Report-Only",
)

REPO = pathlib.Path(__file__).resolve().parents[1]
NGINX = REPO / "nginx.conf"


def _blocks(text: str) -> List[Tuple[str, str]]:
    """(label, body) for the server block and every location block.

    Deliberately a small brace walker rather than a regex: a nested
    location would make a regex silently attribute a header to the wrong
    block, which is the exact class of mistake this gate exists to catch.
    """
    out: List[Tuple[str, str]] = []
    # `\s*\{` and the non-greedy label, because `server {` has a space before
    # the brace: an earlier version of this pattern required the brace to
    # follow the word immediately and therefore never matched the server
    # block at all — it reported "3 blocks, all fine" while checking only the
    # three locations. Caught by planting a removal in the server block and
    # watching the gate stay green. The vacuity floor in check_static() is
    # what makes that failure loud rather than reassuring.
    for match in re.finditer(r"^\s*(server|location\s+[^\{]+?)\s*\{", text, re.M):
        label = " ".join(match.group(1).split())
        depth, i = 1, match.end()
        while i < len(text) and depth:
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
            i += 1
        body = text[match.end():i - 1]
        # strip nested blocks so a header is attributed to one block only
        out.append((label, re.sub(r"\{[^{}]*\}", "", body)))
    return out


def _headers_in(body: str) -> Dict[str, str]:
    found = {}
    for m in re.finditer(r"^\s*add_header\s+([A-Za-z0-9\-]+)\s+(.+?);\s*$", body, re.M):
        found[m.group(1)] = m.group(2).strip()
    return found


def check_static() -> List[str]:
    if not NGINX.is_file():
        return ["nginx.conf not found at %s" % NGINX]
    text = NGINX.read_text(encoding="utf-8")
    problems: List[str] = []
    checked = 0
    for label, body in _blocks(text):
        headers = _headers_in(body)
        if not headers:
            # A block that sets no header of its own inherits the server
            # block's set intact — nothing to assert.
            continue
        checked += 1
        for name in REQUIRED:
            if name not in headers:
                problems.append(
                    "`%s` sets add_header but not %s — nginx DISCARDS the "
                    "server-level add_header set in any block that has one of "
                    "its own, so this block serves responses without it"
                    % (label, name))
        if "Content-Security-Policy" in headers:
            problems.append(
                "`%s` sets an ENFORCED Content-Security-Policy. The SPA has "
                "never been served under one; ship Report-Only, watch the "
                "reports, then enforce (backlog LB-CSP-1)." % label)
        hsts = headers.get("Strict-Transport-Security", "")
        if "max-age=31536000" not in hsts:
            problems.append("`%s` HSTS is not one year: %s" % (label, hsts))
        if "preload" in hsts:
            problems.append(
                "`%s` HSTS carries `preload` — that is a submission to a "
                "browser-vendor list and is effectively irreversible; it is "
                "the owner's decision, not a deploy's." % label)
    # VACUITY FLOOR. `checked == 0` is not a strong enough guard: the first
    # version of `_blocks()` silently skipped the `server` block and reported
    # a confident "3 blocks, all fine". nginx.conf has a server block and
    # three locations that set headers of their own, so anything under four
    # means the walker stopped seeing part of the file.
    expected_blocks = 4
    if checked < expected_blocks:
        problems.append(
            "VACUOUS: this gate examined %d nginx block(s) with their own "
            "add_header, expected at least %d (the server block plus "
            "/assets/, /templates/ and =/index.html). The block walker is "
            "not seeing the whole file, so a green here proves nothing."
            % (checked, expected_blocks))
    if not problems:
        print("[launch-headers] %d nginx block(s) with their own add_header, "
              "all carrying the %d required headers"
              % (checked, len(REQUIRED)))
    return problems


def probe_live(url: str) -> None:
    """READ-ONLY, unauthenticated GET. Reports; never fails the gate."""
    import urllib.request

    print("\n[launch-headers] LIVE probe (read-only GET) %s" % url)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "cfo-ai-launch-gate/1.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310
            got = {k.lower(): v for k, v in resp.headers.items()}
            code = resp.status
    except Exception as exc:  # noqa: BLE001
        print("  probe failed: %s: %s" % (type(exc).__name__, exc))
        return
    print("  HTTP %s" % code)
    for name in REQUIRED:
        value = got.get(name.lower())
        print("  %-38s %s" % (name, value if value else "ABSENT"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", help="optional live origin to probe (read-only GET)")
    args = ap.parse_args()

    problems = check_static()
    if args.url:
        probe_live(args.url)
    if problems:
        print("\nLAUNCH-HEADERS GATE FAILED:")
        for p in problems:
            print("  · %s" % p)
        return 1
    print("\n[launch-headers] PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
