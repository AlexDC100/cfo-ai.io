"""F3.1-PARITY gate companion — Run AFTER each F3.1 sub-chunk deploy.

Re-runs assemble_statements() on both Romanian fixtures and compares the
output to the captured baselines under
src/engine/country_packs/ro_romania/fixtures/regression_baselines/.

Exit 0 (GREEN) if every field matches to 0.0001 RON.
Exit 1 (RED) on any drift — prints the first 20 differing paths.

This is the byte-identical gate the F3.1 architecture proposal commits to.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for c in [here, *here.parents][:6]:
        if (c / "pyproject.toml").is_file():
            return c
    return here.parent


REPO = _find_repo_root()
sys.path.insert(0, str(REPO / "src"))

# Reuse the loaders from the capture script
sys.path.insert(0, str(REPO / "scripts"))
from capture_assembled_baseline import (  # noqa: E402
    _capture, _load_ro_coa, load_eei, load_scandia,
    _normalize_for_assembler,
)


def _diff(a: Any, b: Any, path: str = "") -> List[Tuple[str, Any, Any]]:
    """Return list of (path, baseline, current) for every leaf disagreement."""
    out: List[Tuple[str, Any, Any]] = []
    if type(a) != type(b):
        out.append((path or "<root>", a, b))
        return out
    if isinstance(a, dict):
        keys = set(a.keys()) | set(b.keys())
        for k in sorted(keys):
            if k not in a:
                out.append((f"{path}.{k}", "<missing>", b[k]))
            elif k not in b:
                out.append((f"{path}.{k}", a[k], "<missing>"))
            else:
                out.extend(_diff(a[k], b[k], f"{path}.{k}"))
        return out
    if isinstance(a, list):
        if len(a) != len(b):
            out.append((path, f"len={len(a)}", f"len={len(b)}"))
        for i, (x, y) in enumerate(zip(a, b)):
            out.extend(_diff(x, y, f"{path}[{i}]"))
        return out
    if isinstance(a, float) and isinstance(b, float):
        if abs(a - b) > 1e-4:
            out.append((path, a, b))
        return out
    if a != b:
        out.append((path, a, b))
    return out


def main() -> None:
    baseline_dir = REPO / "src/engine/country_packs/ro_romania/fixtures/regression_baselines"
    if not baseline_dir.is_dir():
        print(f"FAIL: baseline dir not found at {baseline_dir}")
        print("Run capture_assembled_baseline.py first.")
        sys.exit(2)

    ro_coa = _load_ro_coa()
    if ro_coa is None:
        print("FAIL: _ro_coa not importable")
        sys.exit(2)

    print(f"REPO root: {REPO}")
    print(f"Baselines: {baseline_dir}")
    print()

    overall_green = True
    for slug, loader in [("eei_dec_2025", load_eei), ("scandia_fy2025", load_scandia)]:
        baseline_path = baseline_dir / f"{slug}.json"
        if not baseline_path.is_file():
            print(f"  SKIP {slug} — no baseline at {baseline_path}")
            continue
        try:
            accts, name = loader()
            # EEI ships JSON-fixture-shape rows; needs normalising before
            # assemble_statements. Scandia is already assemble-shape.
            if slug == "eei_dec_2025":
                accts = _normalize_for_assembler(accts, ro_coa)
        except Exception as e:
            print(f"  {slug} loader FAILED: {type(e).__name__}: {e}")
            overall_green = False
            continue
        wrapped = json.loads(baseline_path.read_text())
        baseline = wrapped["assembled"]
        current = _capture(name, accts, ro_coa)
        diffs = _diff(baseline, current)
        if not diffs:
            print(f"  GREEN  {slug:<20}  byte-identical (account_count={len(accts)})")
        else:
            print(f"  RED    {slug:<20}  {len(diffs)} differing paths:")
            for path, base, cur in diffs[:20]:
                print(f"           {path}")
                print(f"             baseline: {base}")
                print(f"             current:  {cur}")
            if len(diffs) > 20:
                print(f"         (+ {len(diffs) - 20} more)")
            overall_green = False

    print()
    if overall_green:
        print("Overall: GREEN — F3.1-PARITY gate passes; byte-identical on both fixtures.")
        sys.exit(0)
    else:
        print("Overall: RED — F3.1-PARITY gate FAILS. Do not deploy.")
        sys.exit(1)


if __name__ == "__main__":
    main()
