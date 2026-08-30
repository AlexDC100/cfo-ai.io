"""Installs the AI-sharpening advisory twin onto `_finding`.

This module exists so the numeral guard is *installed*, not merely
importable. `tests/engine/test_findings_gates.py` (F9) looks up
`apply_advisory_narrative` here and requires the install to have already
run, which is why both names are imported.

Use `install_guard`, never a bare attribute assignment. Assigning the
twin onto `_finding` before the original has been captured makes the
twin call itself — a stack overflow rather than an error, which is the
kind of failure that reads as a hang. `_bind_raw_apply` refuses that
ordering loudly, and both behaviours are covered by
`tests/engine/test_finding_sharpen.py`.
"""
from engine.ai.finding_sharpen import (  # noqa: F401
    apply_advisory_narrative,
    install_guard,
)

from . import _finding as _F

install_guard(_F)
