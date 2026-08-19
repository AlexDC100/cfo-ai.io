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

See facts.py's module docstring for the raw_* accessor boundary (audit /
receipt / undo surfaces only).
"""

from .facts import (
    ENVELOPE_VERSION,
    AdditiveServeViolation,
    Fact,
    FactsGateway,
    MissingFactError,
    additive_serve_violations,
    assert_additive_serve,
)
from .status import MACHINE_STATUSES, SURFACES, present_status

__all__ = [
    "ENVELOPE_VERSION",
    "AdditiveServeViolation",
    "Fact",
    "FactsGateway",
    "MissingFactError",
    "MACHINE_STATUSES",
    "SURFACES",
    "additive_serve_violations",
    "assert_additive_serve",
    "present_status",
]
