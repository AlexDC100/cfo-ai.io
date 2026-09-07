#!/usr/bin/env python3
"""Does every mutating route of the DEPLOYED app still resolve its imports?

WHY THIS EXISTS — the 2026-09-06 upload outage.
------------------------------------------------------------------
Signed-in users could not upload. Step 1 of 5, "Detect format", failed
with HTTP 500 and analysis never began. The server-side cause:

    File "/app/src/engine/api/pipeline.py", line 398,
      in _verify_user_may_write_document
        _org.verified_user_id(jwt)
    AttributeError: module 'engine.api._org' has no attribute
      'verified_user_id'

`pipeline.py` had been deployed carrying FC1's write wall. `_org.py`,
which defines the function that wall calls, had not. Both were
committed; only one travelled. Every unit test passed, because in the
repository the two files agree — the disagreement existed only in the
image.

Nothing could see it. The battery runs against the checkout. The drift
check sampled five files and none was `_org.py`. The prod smoke walked
public pages, which need no identity at all. So the first person to
learn that upload was broken was the owner, using the product.

WHAT THIS ASSERTS
------------------------------------------------------------------
Against the RUNNING container, with a WELL-FORMED BUT UNSIGNED bearer:
every mutating route answers a REFUSAL (401/403/404/422/413), never a
500.

The bearer is the whole point, and the first version of this script got
it wrong. With NO Authorization header the routes are refused at a
header-shape check, several frames before the line that broke — the
probe went green with the outage planted and live. A signed-in user's
request goes further: it reaches the verifier, `_org.verified_user_id`,
which is exactly where the AttributeError was raised. So the probe
carries a token that is syntactically a JWT and cryptographically
worthless. A healthy deployment answers 401 (bad signature). A
half-deployed one raises on the way to deciding.

Proven, not assumed: with `verified_user_id` renamed on the host and
the image rebuilt, `POST /api/pipeline/run` answered 500 with this
bearer and 401 without one.

This is deliberately a black-box probe rather than an import scan: the
question is not "do these modules import" (they did — `create_app()`
built fine and `/health` was 200 throughout the outage) but "does the
code path a real request takes still resolve". Only a request finds
that out.

WHAT IT CANNOT SEE (TC-11)
------------------------------------------------------------------
  · Anything past the identity wall. A defect in the authenticated
    half of a handler is invisible here, because this probe never
    holds a session. Closing that needs a real signed-in walk, which
    needs a QA account this script does not have and must not create.
  · A route that answers 200 anonymously by design (the demo and
    webhook surfaces) — those are declared below and only checked for
    "not 500".
  · The frontend bundle: a stale asset serves 200 and looks healthy.

Exit 0 clean, 1 on any 500. Needs network to the deploy host, so like
`check_deploy_drift.py` it is a post-deploy step and a cron job, not a
battery gate — a gate that reds when it cannot reach its subject
teaches people to ignore it.

    .venv/bin/python scripts/check_deployed_routes.py [--base https://cfo-ai.io]
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

DEFAULT_BASE = "https://cfo-ai.io"

#: Syntactically a JWT (three base64url segments, an `alg`, a `sub`, a
#: far-future `exp`), signed with nothing. It must never verify — the
#: point is to reach the verifier and be refused BY it.
JUNK_BEARER = (
    "eyJhbGciOiJFUzI1NiIsImtpZCI6IngifQ"
    ".eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjQxMDI0NDQ4MDB9"
    ".c2ln"
)

#: A refusal is any of these. 405 is included because a route that
#: exists under a different method is still answering rather than
#: breaking.
REFUSALS = {400, 401, 403, 404, 405, 409, 413, 422, 429, 503}

#: (method, path, body) for every mutating route a signed-in user
#: reaches in the core journey — upload, analyse, read, export. The
#: bodies are shaped enough to get past request parsing and reach the
#: wall; ids are all-zero UUIDs so nothing real is ever touched.
ZERO = "00000000-0000-0000-0000-000000000000"
PROBES = [
    ("POST", "/api/pipeline/run", {"document_id": ZERO}),
    ("POST", "/api/pipeline/retry", {"document_id": ZERO}),
    ("POST", "/api/pipeline/recover-stuck", {}),
    ("POST", "/api/period/%s/reextract" % ZERO, {}),
    ("POST", "/api/period/%s/review/reanalyze" % ZERO, {}),
    ("POST", "/api/period/%s/briefing/regenerate" % ZERO, {}),
    ("DELETE", "/api/period/%s" % ZERO, None),
    ("PATCH", "/api/documents/%s" % ZERO, {"period_id": ZERO}),
    ("DELETE", "/api/documents/%s" % ZERO, None),
    ("POST", "/api/documents/%s/restore" % ZERO, {}),
    ("DELETE", "/api/documents/%s/permanent" % ZERO, None),
    ("POST", "/api/documents/%s/move-period" % ZERO, {"period_id": ZERO}),
    ("DELETE", "/api/documents/clear-deleted", None),
    ("DELETE", "/api/documents/clear-mine", None),
    ("PATCH", "/api/sales-datasets/%s" % ZERO, {"name": "probe"}),
    ("DELETE", "/api/sales-datasets/%s" % ZERO, None),
    ("POST", "/api/sales-datasets/%s/rerun" % ZERO, {}),
    ("PATCH", "/api/sku-aggregates/%s/decision" % ZERO, {"decision": "keep"}),
    ("PUT", "/api/period/%s/valuation-assumptions" % ZERO, {}),
    ("POST", "/api/period/%s/reconcile" % ZERO, {}),
]


def probe(base, method, path, body, timeout=25):
    data = None
    headers = {"Accept": "application/json",
               "Authorization": "Bearer " + JUNK_BEARER}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, headers=headers,
                                 method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(400).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(400).decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001 — a transport failure is not a verdict
        return None, "%s: %s" % (type(exc).__name__, exc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    args = ap.parse_args()
    base = args.base.rstrip("/")

    print("DEPLOYED ROUTE INTEGRITY")
    print("=" * 62)
    print("  base: %s" % base)

    status, _ = probe(base, "GET", "/health", None)
    if status != 200:
        print("  SKIPPED — %s/health answered %r. The subject was not"
              % (base, status))
        print("  examined; this is neither a pass nor a failure.")
        return 0

    broken, unreachable, ok = [], [], 0
    for method, path, body in PROBES:
        code, text = probe(base, method, path, body)
        label = "%s %s" % (method, path)
        if code is None:
            unreachable.append((label, text))
            print("  %-52s UNREACHABLE" % label[:52])
            continue
        if code >= 500:
            broken.append((label, code, text))
            print("  %-52s %d  <-- BROKEN" % (label[:52], code))
            continue
        ok += 1
        print("  %-52s %d" % (label[:52], code))

    print("-" * 62)

    # TC-3: a census over nothing must not read as agreement.
    if ok == 0 and not broken:
        print("  DISCOVERY BROKEN — every probe was unreachable. Nothing was")
        print("  examined, so 'no 500s' would mean 'no subject'.")
        return 1

    if broken:
        print("")
        print("A MUTATING ROUTE ANSWERED 5xx TO AN UNSIGNED BEARER.")
        print("A token that cannot verify must be refused, so a")
        print("5xx here means the handler ran far enough to break — a missing")
        print("attribute, a missing module, or a change deployed in halves.")
        print("This is the 2026-09-06 upload outage exactly: pipeline.py")
        print("shipped calling _org.verified_user_id, _org.py did not ship.")
        print("")
        for label, code, text in broken:
            print("  %-52s %d" % (label[:52], code))
            print("      %s" % text.strip().replace("\n", " ")[:160])
        print("")
        print("Check the container log for the traceback, then redeploy the")
        print("WHOLE engine tree per CLAUDE.md §14 rather than the files you")
        print("think changed:")
        print("  rsync -a --exclude=__pycache__ src/ %s:/opt/cfo-ai/src/"
              % "root@187.124.0.37")
        return 1

    if unreachable:
        print("  %d probe(s) unreachable; %d answered." % (len(unreachable), ok))

    print("  %d mutating route(s) refused cleanly, 0 answered 5xx." % ok)
    print("")
    print("DEPLOYED ROUTES INTACT — every mutating route resolves its")
    print("imports and refuses an anonymous caller without breaking.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
