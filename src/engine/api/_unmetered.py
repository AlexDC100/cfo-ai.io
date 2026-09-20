"""Operator exemption from usage metering (owner ruling, 2026-09-20).

The owner tests the product on production with real uploads. Under Pricing V3
every upload past the plan's included documents answers 402 (extra-document
confirmation) and, once confirmed, is a BILLABLE extra on a LIVE Stripe
account. Testing must never bill, and must never be capped.

`USAGE_UNMETERED_USER_IDS` is a comma-separated list of Supabase user ids
(UUIDs). A listed user is treated exactly as if enforcement were disabled:
nothing is reserved, nothing is committed, nothing is billed.

Fails CLOSED. Unset or empty exempts nobody; there is no wildcard; an entry
that is not a UUID is ignored, so a stray `*` or `true` can never open the
meter for every customer. Gate: tests/engine/test_unmetered_users.py.
"""
from __future__ import annotations

import os
import re
from typing import FrozenSet, Optional

ENV_VAR = "USAGE_UNMETERED_USER_IDS"

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def unmetered_user_ids() -> FrozenSet[str]:
    raw = os.environ.get(ENV_VAR, "")
    ids = (part.strip().lower() for part in raw.split(","))
    return frozenset(i for i in ids if _UUID.match(i))


def is_unmetered(user_id: Optional[str]) -> bool:
    if not user_id:
        return False
    return str(user_id).strip().lower() in unmetered_user_ids()
