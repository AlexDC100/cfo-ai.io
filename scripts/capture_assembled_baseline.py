"""F3.1-PARITY gate — Capture full assemble_statements() output for the
two Romanian fixtures (EEI, Scandia) as a byte-identical baseline.

Run AT F3.1a (before any code refactor). The captured JSONs become the
truth source the F3.1c/d/e deploys must match exactly. Any drift in any
field, even +/- 0.01 RON, fails the parity check.

Output:
  src/engine/country_packs/ro_romania/fixtures/regression_baselines/
    eei_dec_2025.json
    scandia_fy2025.json

Run modes
---------
- Container/host with /opt/cfo-ai mounted: `python3 capture_assembled_baseline.py`
- Re-baselining (explicit, after an engine change): `python3 capture_assembled_baseline.py --rebaseline`
  (refuses to overwrite without the flag)

Same fixture-load logic as `measure_bs_drift.py`; differs only in that
it serializes the FULL assemble_statements output, not just BS deltas.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return here.parent


REPO = _find_repo_root()
sys.path.insert(0, str(REPO / "src"))


def _load_ro_coa():
    # F3.1e: data lives at the pack-local path (engine.country_packs.ro_romania.chart_of_accounts).
    # Falls back to the legacy `engine.api._ro_coa` shim during the F3.1d
    # transition; deleted at F3.1e but kept here for any environment
    # still running pre-F3.1e bits.
    try:
        from engine.country_packs.ro_romania import chart_of_accounts as ro_coa  # type: ignore
        return ro_coa
    except Exception:
        try:
            from engine.api import _ro_coa  # type: ignore
            return _ro_coa
        except Exception:
            return None


def _load_tbp():
    try:
        from engine.country_packs.ro_romania import trial_balance_parser as tbp  # type: ignore
        return tbp
    except Exception:
        try:
            from engine.api import _trial_balance_parser  # type: ignore
            return _trial_balance_parser
        except Exception:
            return None


def _normalize_for_assembler(accounts: List[Dict], ro_coa) -> List[Dict]:
    """Map JSON-fixture accounts → `{code, name, amount[, bucket_override]}`
    shape that `assemble_statements()` consumes. Delegates to
    `measure_bs_drift._normalize_for_assembler` (the canonical
    transcription of `_trial_balance_parser.accounts_to_assemble_shape`
    adapted to JSON-fixture field names: closing_debit/closing_credit/
    ytd_debit/ytd_credit).

    Previously a no-op stub — caused the EEI baseline to capture all
    zeros (F3.1a bug, surfaced at F3.2 inspection). Fixed here.
    """
    # Late import: keeps capture_assembled_baseline runnable as a
    # standalone script while reusing the measure_bs_drift logic.
    from measure_bs_drift import _normalize_for_assembler as _mbd_norm
    return _mbd_norm(accounts, ro_coa)


def load_eei() -> tuple[List[Dict], str]:
    candidates = [
        REPO / "scandi-desk-main/e2e/fixtures/ground-truth/ro_eei_dec_2025/expected_extraction.json",
        Path("/app/scandi-desk-main/e2e/fixtures/ground-truth/ro_eei_dec_2025/expected_extraction.json"),
        Path("/host_repo/scandi-desk-main/e2e/fixtures/ground-truth/ro_eei_dec_2025/expected_extraction.json"),
        # Post repo-restructure fallback — the FE tree (scandi-desk-main)
        # is legacy/absent in some checkouts and excluded by .dockerignore;
        # files/ carries the same fixture (same chain measure_bs_drift
        # uses). Without this, EEI silently dropped out of the parity
        # gate on such checkouts (loader FAILED → RED with no baseline
        # comparison at all).
        REPO / "files/eei_expected_extraction.json",
        Path("/app/files/eei_expected_extraction.json"),
    ]
    p = next((c for c in candidates if c.is_file()), None)
    if p is None:
        raise FileNotFoundError("EEI fixture not found")
    d = json.loads(p.read_text())
    return d.get("accounts", []), d.get("company", {}).get("name", "EEI Imobiliara Investment SRL")


def load_scandia() -> tuple[List[Dict], str]:
    candidates = [
        REPO / "files/scandia_trial_balance_2025_downloaded.xlsx",
        Path("/app/files/scandia_trial_balance_2025_downloaded.xlsx"),
        Path("/host_repo/files/scandia_trial_balance_2025_downloaded.xlsx"),
    ]
    p = next((c for c in candidates if c.is_file()), None)
    if p is None:
        raise FileNotFoundError("Scandia fixture not found")
    tbp = _load_tbp()
    if tbp is None:
        raise RuntimeError("trial_balance_parser not loadable")
    rows = tbp.parse_trial_balance_file(p.read_bytes(), p.name)
    accounts = tbp.accounts_to_assemble_shape(rows)
    return accounts, "Scandia Food SRL"


def _capture(name: str, accounts: List[Dict], ro_coa) -> Dict[str, Any]:
    """Run assemble_statements and serialize the full output."""
    result = ro_coa.assemble_statements(
        accounts,
        company_name=name,
        currency="RON",
        period_label="2025-12-31",
        industry=None,
    )
    # Make floats JSON-serializable with full precision; round at 4
    # decimal places to absorb meaningless trailing noise but catch
    # any meaningful drift (parity gate requires >= 0.0001 match).
    def _round(obj: Any) -> Any:
        if isinstance(obj, float):
            return round(obj, 4)
        if isinstance(obj, dict):
            return {k: _round(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [_round(x) for x in obj]
        return obj
    return _round(result)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebaseline", action="store_true",
                    help="Overwrite existing baselines (default: refuse)")
    ap.add_argument("--out-dir", default=None,
                    help="Override output directory")
    args = ap.parse_args()

    out_dir = Path(args.out_dir) if args.out_dir else (
        REPO / "src/engine/country_packs/ro_romania/fixtures/regression_baselines"
    )
    out_dir.mkdir(parents=True, exist_ok=True)

    ro_coa = _load_ro_coa()
    if ro_coa is None:
        print("FAIL: _ro_coa not importable; need to run inside container or with sys.path set")
        sys.exit(2)

    targets = []
    # EEI ships JSON-fixture-shape rows (ytd_debit/closing_debit/etc.)
    # that need normalising before assemble_statements consumes them.
    try:
        eei_raw, eei_name = load_eei()
        eei_accts = _normalize_for_assembler(eei_raw, ro_coa)
        targets.append(("eei_dec_2025", eei_name, eei_accts))
    except Exception as e:
        print(f"  EEI load failed: {type(e).__name__}: {e}")

    # Scandia's `accounts_to_assemble_shape` already emits the assemble
    # shape (code/name/amount[/bucket_override]); no normalisation
    # needed here.
    try:
        scandia_accts, scandia_name = load_scandia()
        targets.append(("scandia_fy2025", scandia_name, scandia_accts))
    except Exception as e:
        print(f"  Scandia load failed: {type(e).__name__}: {e}")

    if not targets:
        print("FAIL: no fixtures captured")
        sys.exit(2)

    for slug, name, accts in targets:
        out_path = out_dir / f"{slug}.json"
        if out_path.is_file() and not args.rebaseline:
            print(f"  SKIP {slug} — baseline exists at {out_path} (use --rebaseline to overwrite)")
            continue
        captured = _capture(name, accts, ro_coa)
        # Add metadata
        wrapped = {
            "_meta": {
                "fixture": slug,
                "company": name,
                "captured_from": "F3.1a — pre-refactor baseline",
                "engine_module": getattr(ro_coa, "__file__", "?"),
                "account_count": len(accts),
            },
            "assembled": captured,
        }
        out_path.write_text(json.dumps(wrapped, indent=2, ensure_ascii=False))
        print(f"  WROTE {out_path} ({len(out_path.read_text())} bytes)")

    print(f"\nBaselines in: {out_dir}")
    print("Run check_assembled_parity.py post-deploy to verify byte-identical output.")


if __name__ == "__main__":
    main()
