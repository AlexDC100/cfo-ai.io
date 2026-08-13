#!/usr/bin/env python3
"""canonical_bs v2 determinism gate (docs/CANONICAL_BS_V2_CONTRACT.md,
"Determinism (requirement 1)").

For each golden XLSX fixture, runs the OFFLINE deterministic parse+assemble
(`RomaniaPack.run_deterministic_tb` — no DB, no LLM; the SAME code object
the pipeline's stage_extract + stage_map compose) 5 times and asserts the
canonical envelope (`assembled_canonical_v1`, canonical_bs included) is
BYTE-IDENTICAL across runs under `json.dumps(..., sort_keys=True)`.

For the frozen production fixture it additionally asserts the EXTERNAL
conservation anchor: the extracted SF column sums must equal the file's
own totals row to the cent, per files/prod_scandia_frozen_31.12.2025
.expected.json — an extraction that balances internally but diverges from
the source anchors is a FAILED extraction (BS_ENGINE_ROOT_CAUSE Layer 2).

Exit code: 0 all green; 1 on any failure, with a precise per-path diff.

Wired into CI next to the EEI canonical check
(.github/workflows/tier1-validation.yml, job `eei-canonical-numbers`).
Requires pandas + openpyxl (the XLSX parser's own dependencies); no
network, no environment variables.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, List, Tuple


# ── Repo-root + sys.path setup — independent of cwd (same pattern as
# scripts/measure_bs_drift.py) ────────────────────────────────────────


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return Path(__file__).resolve().parent.parent


REPO = _find_repo_root()
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import engine.country_packs.ro_romania  # noqa: E402,F401 — registers RomaniaPack
from engine.core.country_pack_registry import get_pack  # noqa: E402


RUNS = 5

# (fixture path, label, expected-anchor json path or None)
FIXTURES: List[Tuple[Path, str, Path | None]] = [
    (
        REPO / "files" / "prod_scandia_frozen_31.12.2025.xlsx",
        "prod_scandia_frozen",
        REPO / "files" / "prod_scandia_frozen_31.12.2025.expected.json",
    ),
    (REPO / "files" / "agras_tb_2025.xlsx", "agras", None),
    (REPO / "files" / "scandia_realestate_tb_2025.xlsx", "scandia_realestate", None),
    (REPO / "files" / "carniprod_tb_2025.xlsx", "carniprod", None),
]


def _json_paths_diff(a: Any, b: Any, path: str = "$", out: List[str] | None = None,
                     limit: int = 25) -> List[str]:
    """Recursive structural diff — returns up to `limit` differing JSON
    paths with both values, so a determinism break points at the exact
    field instead of a byte offset."""
    if out is None:
        out = []
    if len(out) >= limit:
        return out
    if type(a) is not type(b):
        out.append(f"{path}: type {type(a).__name__} != {type(b).__name__}")
        return out
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append(f"{path}.{k}: missing in run A")
            elif k not in b:
                out.append(f"{path}.{k}: missing in run B")
            else:
                _json_paths_diff(a[k], b[k], f"{path}.{k}", out, limit)
            if len(out) >= limit:
                break
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append(f"{path}: list length {len(a)} != {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            _json_paths_diff(x, y, f"{path}[{i}]", out, limit)
            if len(out) >= limit:
                break
    elif a != b:
        out.append(f"{path}: {a!r} != {b!r}")
    return out


def main() -> int:
    pack = get_pack("RO")
    failures: List[str] = []

    for fixture_path, label, expected_path in FIXTURES:
        if not fixture_path.is_file():
            failures.append(f"[{label}] fixture missing: {fixture_path}")
            continue
        content = fixture_path.read_bytes()

        dumps: List[str] = []
        envelopes: List[Any] = []
        tb_first = None
        error = None
        for i in range(RUNS):
            try:
                tb_rows, _shaped, assembled = pack.run_deterministic_tb(
                    content, fixture_path.name,
                )
            except Exception as e:  # noqa: BLE001
                error = f"[{label}] run {i + 1}/{RUNS} raised {type(e).__name__}: {e}"
                break
            if tb_first is None:
                tb_first = tb_rows
            env = assembled.get("assembled_canonical_v1")
            if not isinstance(env, dict):
                error = f"[{label}] run {i + 1}/{RUNS}: no assembled_canonical_v1 emitted"
                break
            if "canonical_bs" not in env:
                error = f"[{label}] run {i + 1}/{RUNS}: envelope has no canonical_bs"
                break
            envelopes.append(env)
            dumps.append(json.dumps(env, sort_keys=True, ensure_ascii=False))
        if error:
            failures.append(error)
            continue

        identical = all(d == dumps[0] for d in dumps[1:])
        cbs = envelopes[0]["canonical_bs"]
        print(
            f"[{label}] {RUNS} runs — "
            f"{'BYTE-IDENTICAL' if identical else 'NON-DETERMINISTIC'} | "
            f"rows={len(tb_first)} accounts={len(_shaped)} "
            f"status={cbs.get('status')} difference={cbs.get('difference')} "
            f"anchor={((cbs.get('source_anchor') or {}).get('anchor_status'))}"
        )
        if not identical:
            for i, d in enumerate(dumps[1:], start=2):
                if d != dumps[0]:
                    diff = _json_paths_diff(envelopes[0], envelopes[i - 1])
                    failures.append(
                        f"[{label}] run 1 vs run {i} differ at:\n    "
                        + "\n    ".join(diff)
                    )
                    break

        # ── External anchor check (frozen fixture only) ────────────────
        if expected_path is not None:
            if not expected_path.is_file():
                failures.append(f"[{label}] expected.json missing: {expected_path}")
                continue
            expected = json.loads(expected_path.read_text(encoding="utf-8"))
            src_totals = expected.get("source_totals_row") or {}
            exp_sf_d = float(src_totals.get("sf_debit"))
            exp_sf_c = float(src_totals.get("sf_credit"))
            anchor = getattr(tb_first, "source_anchor", None) or {}
            sf_pair = (anchor.get("pairs") or {}).get("sf") or {}
            got_sf_d = float(sf_pair.get("extracted_debit") or 0.0)
            got_sf_c = float(sf_pair.get("extracted_credit") or 0.0)
            # "to the cent" — anything beyond 0.005 rounding slack fails.
            for side, got, exp in (("debit", got_sf_d, exp_sf_d),
                                   ("credit", got_sf_c, exp_sf_c)):
                if abs(got - exp) > 0.005:
                    failures.append(
                        f"[{label}] SF {side} sum {got:,.2f} != expected "
                        f"{exp:,.2f} (delta {got - exp:+,.2f})"
                    )
            exp_rows = int(expected.get("account_rows") or 0)
            if exp_rows and len(tb_first) != exp_rows:
                failures.append(
                    f"[{label}] parsed {len(tb_first)} account rows, "
                    f"expected {exp_rows}"
                )
            print(
                f"[{label}] anchor: SF extracted {got_sf_d:,.2f} / {got_sf_c:,.2f} "
                f"vs file {exp_sf_d:,.2f} / {exp_sf_c:,.2f} — "
                f"{'MATCH' if not any(f.startswith(f'[{label}] SF') for f in failures) else 'DIVERGED'}"
            )

    print()
    if failures:
        print(f"DETERMINISM GATE: FAIL ({len(failures)} failure(s))")
        for f in failures:
            print(f"  ✗ {f}")
        return 1
    print("DETERMINISM GATE: PASS — all fixtures byte-identical across "
          f"{RUNS} runs; frozen SF sums match the file's totals row to the cent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
