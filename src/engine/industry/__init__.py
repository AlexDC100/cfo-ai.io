"""Structural industry signal — what the ACCOUNT MIX says the company does.

Why this is its own leaf package, and not `engine/serving/` or
`engine/api/`:

  · `engine/serving/` projects an ALREADY-COMPUTED envelope for one
    surface (facts, public summary, status). This is not a projection —
    it is a measurement over the trial balance's own accounts, consumed
    by the pipeline, by the report, and (eventually) by anything that
    needs a second opinion on a user-set industry.
  · `engine/api/_industry_detection.py` and `_industry_classifier.py`
    are the DB-coupled path: the first imports `_supabase` and reads
    `caen_industry_mappings`; the second answers with a bare CAEN code
    and a confidence float, no evidence a reader can check, no way to
    say "cannot tell".

This package has no I/O, no DB, no network and no framework import, so a
test, the pipeline and a script can all call it the same way.
"""

from .structural_signal import (  # noqa: F401
    FAMILY_DISPLAY,
    build_industry_signal,
    industry_agreement,
    structural_signal,
    workspace_families,
)
