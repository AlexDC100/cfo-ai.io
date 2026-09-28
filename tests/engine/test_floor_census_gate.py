"""The floor census runs IN the engine suite (surfaces re-verify, medium).

`scripts/check_floor_census.py` is a battery gate; nothing under
tests/engine wrapped it, so the merge of main's C6 floors branch turned it
RED (11 baseline rows fell, 3 unreviewed OR_ZERO sites arrived in
`_industry_classifier.py`) while the full engine suite stayed green.

REDS ON: any ratchet row moving in either direction, a floor in the credit
tier, a stale allow-list entry or a stale `reviewed` row. CANNOT SEE: what
the script itself cannot (its printed 14-file scope).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def test_the_floor_census_passes_on_this_tree():
    out = subprocess.run([sys.executable, str(REPO / "scripts" / "check_floor_census.py")],
                         cwd=str(REPO), capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stdout[-2500:] + out.stderr[-500:]
    assert "PASS floor-census" in out.stdout and "credit tier clean" in out.stdout


def test_every_ratchet_row_that_arrived_by_merge_carries_its_measured_review():
    doc = json.loads((REPO / "scripts" / "floor_census_baseline.json").read_text(encoding="utf-8"))
    row = "src/engine/api/_industry_classifier.py [OR_ZERO]"
    # 3 -> 1 by the one-EBITDA ruling (2026-09-26): the two bucket defaults
    # that added 72x / other operating income to turnover were removed with
    # the total-operating-revenue denominator; the review re-states it.
    assert doc["counts"]["src/engine/api/_industry_classifier.py"]["OR_ZERO"] == 1
    assert "REMOVED by the one-EBITDA ruling" in doc["reviewed"][row]
    assert row in doc["reviewed"] and "Measured on the four corpus books" in doc["reviewed"][row]
