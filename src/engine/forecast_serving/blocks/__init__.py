"""The shared block registry of the fp1.2 response (plan_contract_v2 0.6, 2.9).

Two declarations every batch appends to under its own anchor, and which
``engine.api._forecast_routes.PlanRequestBody`` reads at validation time, so
no batch after B6 edits the route module to lift a refusal:

  · ``LANDED_REQUEST_FIELDS`` — the request fields whose batch has landed. A
    field outside it must hold its default; a non-default value is 422
    ``not_served_in_this_build`` naming the field.
  · ``ACCEPTED_WANT_KEYS`` — the want keys whose block has landed. Any other
    want key is unknown and 422.

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

__all__ = ["ACCEPTED_WANT_KEYS", "DEFAULT_WANT", "LANDED_REQUEST_FIELDS",
           "BLOCK_FIELD_CONSUMERS", "DRIVER_ECHO_FIELDS"]

# ── plan/2 B6 ────────────────────────────────────────────────────────────
LANDED_REQUEST_FIELDS = ("horizon", "overrides", "shocks", "behaviour_overrides",
                         "debt_schedule", "want")
ACCEPTED_WANT_KEYS = ("figures", "series", "summary", "strip")
#: want omitted (2.7). GET equals it.
DEFAULT_WANT = ("figures", "series", "summary", "strip")
#: driver key -> the block fields that consume it beside LINE_ASSUMPTIONS
#: (3.2 consumed_by, 12). B12 adds dcf.
BLOCK_FIELD_CONSUMERS = {"min_cash": ("series.min_cash",)}
#: block fields that ARE the driver's own value, served as a number: moving
#: the driver always moves them, so the driver is never inert (12: a key is
#: inert only when neither the figures nor those bytes change).
DRIVER_ECHO_FIELDS = ("series.min_cash",)
# ── end plan/2 B6 ────────────────────────────────────────────────────────
