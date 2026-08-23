#!/usr/bin/env python3
"""Stripe billing test-harness mode notice (D2).

Reports — as a NOTICE, never a failure by default — which transport the
billing suite (tests/engine/test_billing_stripe.py) will run against:

  STRIPE_MOCK  stripe/stripe-mock reachable: STRIPE_MOCK_URL env, or the
               default localhost:12111. The suite's transport lane drives
               the REAL stripe SDK at it through the STRIPE_API_BASE seam.
  LIVE         self-activating: STRIPE_LIVE_LANE=1 and STRIPE_TEST_KEY
               present (must start sk_test_ — a live key is refused).
               Same transport lane against real test-mode Stripe.
  FIXTURES     neither available: the transport layer runs against the
               in-process fake + recorded fixtures under
               tests/engine/fixtures/stripe/. Webhook signatures are
               STILL verified by the real stripe SDK in this mode —
               signature crypto is never mocked.

The operator's rule holds structurally in every mode: tests scrub ambient
STRIPE_* env and set their own sk_test_* dummy key, so a live key exported
in the shell is never read, let alone called.

Exit codes:
  0  always, in every mode (mode is informational) — unless:
  1  --require-mock was passed and stripe-mock is not reachable (for the
     CI job that provisions stripe-mock as a service and must fail loudly
     when the service died), or --require-live was passed without a
     usable STRIPE_TEST_KEY.
"""

from __future__ import annotations

import argparse
import os
import socket
import sys
from typing import Optional, Tuple


DEFAULT_MOCK_URL = "http://localhost:12111"


def probe_stripe_mock() -> Tuple[bool, Optional[str]]:
    """(reachable, base_url) — STRIPE_MOCK_URL env first, else the
    stripe-mock default port on localhost. TCP connect only; 250 ms."""
    from urllib.parse import urlparse

    explicit = os.environ.get("STRIPE_MOCK_URL")
    candidates = [explicit] if explicit else [DEFAULT_MOCK_URL]
    for base in candidates:
        if not base:
            continue
        try:
            parsed = urlparse(base if "//" in base else "http://%s" % base)
            host = parsed.hostname or "localhost"
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            with socket.create_connection((host, port), timeout=0.25):
                pass
            return True, base.rstrip("/")
        except OSError:
            continue
    return False, explicit


def live_lane_state() -> Tuple[str, str]:
    """('active'|'skip'|'refused', detail)."""
    key = os.environ.get("STRIPE_TEST_KEY", "")
    requested = os.environ.get("STRIPE_LIVE_LANE") == "1"
    if key.startswith("sk_test_"):
        return ("active" if requested else "skip",
                "STRIPE_TEST_KEY present (sk_test_*)"
                + ("" if requested else "; set STRIPE_LIVE_LANE=1 to run it"))
    if key.startswith("sk_live_"):
        return "refused", "STRIPE_TEST_KEY is a LIVE key — refused; the suite never calls live Stripe"
    return "skip", "STRIPE_TEST_KEY absent — stripe-live lane skipped WITH NOTICE, never red"


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--require-mock", action="store_true",
                    help="exit 1 unless stripe-mock is reachable")
    ap.add_argument("--require-live", action="store_true",
                    help="exit 1 unless the live lane can activate "
                         "(STRIPE_TEST_KEY present and sk_test_*)")
    args = ap.parse_args(argv)

    try:
        import stripe  # type: ignore
        sdk = "stripe SDK %s (signing + verification helpers available)" % (
            getattr(stripe, "VERSION", "?"))
    except ImportError:
        sdk = ("stripe SDK NOT importable — pip install 'stripe>=8.0' "
               "(declared runtime dep in pyproject.toml)")

    mock_up, mock_base = probe_stripe_mock()
    live_state, live_detail = live_lane_state()

    if live_state == "active":
        mode = "LIVE"
    elif mock_up:
        mode = "STRIPE_MOCK"
    else:
        mode = "FIXTURES"

    print("[check_stripe_harness] NOTICE: harness mode = %s" % mode)
    print("  sdk:          %s" % sdk)
    print("  stripe-mock:  %s" % (
        "reachable at %s" % mock_base if mock_up
        else "not reachable (%s)" % (mock_base or DEFAULT_MOCK_URL)))
    print("  live lane:    %s — %s" % (live_state.upper(), live_detail))
    if mode == "FIXTURES":
        print("  transport:    in-process fake + recorded fixtures "
              "(tests/engine/fixtures/stripe/); webhook signatures still "
              "verified by the real SDK")
    ambient = os.environ.get("STRIPE_SECRET_KEY", "")
    if ambient.startswith("sk_live_"):
        print("  WARNING:      ambient STRIPE_SECRET_KEY is a LIVE key — the "
              "test suite scrubs it before every test and never reads it; "
              "consider unsetting it in shells that run tests")

    if args.require_mock and not mock_up:
        print("[check_stripe_harness] FAIL: --require-mock but stripe-mock "
              "is not reachable")
        return 1
    if args.require_live and live_state != "active":
        print("[check_stripe_harness] FAIL: --require-live but the live "
              "lane cannot activate (%s)" % live_detail)
        return 1
    print("[check_stripe_harness] OK — suite runs in %s mode" % mode)
    return 0


if __name__ == "__main__":
    sys.exit(main())
