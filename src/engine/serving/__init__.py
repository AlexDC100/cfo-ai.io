"""engine.serving — the serve-time facts gateway + status presenter.

Public API (the ONLY names the rest of the engine may import — enforced
by scripts/check_import_boundary.py):

  · :class:`FactsGateway` / :class:`Fact` — typed reader of the SERVED
    (reconciliation-adjusted) balance-sheet truth for one envelope.
  · :func:`present_status` — the one wording authority for the
    BALANCED / RECONCILED / MINOR_DRIFT / MATERIAL_IMBALANCE ladder.
  · :data:`ENVELOPE_VERSION` — the served-envelope contract version
    ("sv1"), stamped by the serve path; schema:
    docs/served_envelope.schema.json.
  · :func:`additive_serve_violations` / :func:`assert_additive_serve` —
    the additive-only serve guard (serve mutations may add keys, never
    remove or retype pipeline-produced fields).
  · :class:`MissingFactError` / :class:`AdditiveServeViolation`.
  · :func:`present_public_summary` / :data:`PUBLIC_SUMMARY_VERSION`
    ("ps1") / :data:`PUBLIC_SUMMARY_STATUS` — the reduced open-data
    tier's presenter (parallel to the canonical ladder, never in it).
  · :class:`LockedRatio` — the PS5 typed paywall refusal returned by
    account-level accessors on the public-summary tier.
  · :func:`present_public_market` / :data:`PUBLIC_MARKET_VERSION`
    ("pm1") / :data:`PUBLIC_MARKET_STATUS` — the GLOBAL PUBLIC MARKETS
    tier's presenter (a fourth, parallel presentation status; never in
    the canonical ladder, never in reconcile/packs/consensus).
  · :class:`MarketRefusal` / :class:`MarketRatio` — the PM typed
    input-absent refusal and the exact-integer ratio pair returned by
    the market accessors (price / market_cap / enterprise_value / pe /
    ev_ebitda).

See facts.py's module docstring for the raw_* accessor boundary (audit /
receipt / undo surfaces only).
"""

from .facts import (
    ENVELOPE_VERSION,
    AdditiveServeViolation,
    Fact,
    FactsGateway,
    LockedRatio,
    MarketRatio,
    MarketRefusal,
    MissingFactError,
    additive_serve_violations,
    assert_additive_serve,
)
from .public_market import (
    PUBLIC_MARKET_STATUS,
    PUBLIC_MARKET_VERSION,
    present_public_market,
)
from .public_summary import (
    PUBLIC_SUMMARY_STATUS,
    PUBLIC_SUMMARY_VERSION,
    present_public_summary,
)
from .status import MACHINE_STATUSES, SURFACES, present_status

__all__ = [
    "ENVELOPE_VERSION",
    "AdditiveServeViolation",
    "Fact",
    "FactsGateway",
    "LockedRatio",
    "MarketRatio",
    "MarketRefusal",
    "MissingFactError",
    "MACHINE_STATUSES",
    "PUBLIC_MARKET_STATUS",
    "PUBLIC_MARKET_VERSION",
    "PUBLIC_SUMMARY_STATUS",
    "PUBLIC_SUMMARY_VERSION",
    "SURFACES",
    "additive_serve_violations",
    "assert_additive_serve",
    "present_public_market",
    "present_public_summary",
    "present_status",
]
