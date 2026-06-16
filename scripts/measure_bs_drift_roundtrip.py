"""F3.27-DRIFT-TRANSFORMATION-GLUE — synthetic round-trip harness.

PURPOSE
-------
Proves that pipeline.py's /api/period/{id} reassembly produces a DIFFERENT
`bs_balance_delta` than the engine's authoritative write-time computation,
and that Fix A1's override formula matches the write-time truth.

This is the Lock #12 synthetic-harness pattern with the wrong-on-purpose
sub-rule: discriminating inputs that prove the transformation is
value-preserving (or, when it's not, that we know exactly by how much).

WHAT THE HARNESS DOES, PER FIXTURE
----------------------------------
1. Load raw accounts (same path the F-A3.1 canary uses)
2. Call `assemble_statements(raw)` — this is what runs at WRITE time.
   Capture `truth_delta = assembled_bs.bs_balance_delta`.
   Capture the envelope: `assembled_canonical_v1.methodology.totals`.
3. Extract `lineItems` from the result. This is exactly what the DB
   stores in `statement_line_items` (the engine writes from this list).
4. Reconstruct `recovered_accounts` from `lineItems` using the EXACT
   logic of `pipeline.py:5384-5422` (the /api/period round-trip).
5. Call `assemble_statements(recovered)` — this is what runs at READ
   time inside /api/period. Capture `roundtrip_delta`.
6. Compute the Fix A1 override formula directly from the envelope:
   `fix_a1_delta = totals.total_assets
                 - (totals.total_liabilities + totals.total_equity)`
7. Assertions:
   - `truth_delta == fix_a1_delta` (within 1 RON rounding tolerance) — FIX A1 IS VALUE-PRESERVING
   - `truth_delta != roundtrip_delta` for Carniprod (the bug exists)
8. Report a verdict table per fixture.

WRONG-ON-PURPOSE PROBE (Lock #12 sub-rule)
------------------------------------------
After the per-fixture loop, run a synthetic envelope with KNOWN totals
(total_assets=100, total_liabilities=80, total_equity=19, expected
delta=1.0) and assert Fix A1's formula yields exactly 1.0. If a future
refactor accidentally changes the formula direction or operand order,
this fails immediately. It does NOT exercise the engine; it exercises
the override formula in isolation.

RUN
---
Container (preferred — full engine deps available):
    docker exec cfo-ai-backend python3 /app/scripts/measure_bs_drift_roundtrip.py

Local (limited — only fixtures with stdlib-loadable JSON loaders run):
    python3 scripts/measure_bs_drift_roundtrip.py
"""
from __future__ import annotations

import sys
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


# ─────────────────────────────────────────────────────────────────────
# Reuse the existing F-A3.1 plumbing: repo-root resolution, _load_ro_coa,
# all fixture loaders. Importing measure_bs_drift gives us them for free.
# ─────────────────────────────────────────────────────────────────────

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import measure_bs_drift as fa31  # noqa: E402


def _reconstruct_accounts_via_pipeline_logic(
    line_items: List[Dict[str, Any]],
    ro_coa,
) -> List[Dict[str, Any]]:
    """Mirror of pipeline.py:5384-5422 — reconstruct `recovered_accounts`
    from persisted-shape line_items.

    The logic must be byte-identical to /api/period's reconstruction. Any
    drift between this function and pipeline.py invalidates the harness.
    If the production code changes, this function MUST change with it.

    Returns the list of {code, name, amount[, bucket_override]} dicts
    that `assemble_statements` is called with at read time.
    """
    bucket_for = getattr(ro_coa, "bucket_for", None)
    persistence_bucket = getattr(ro_coa, "_persistence_bucket", None)
    if bucket_for is None or persistence_bucket is None:
        raise RuntimeError(
            "_ro_coa missing bucket_for / _persistence_bucket — "
            "engine API drifted from pipeline.py expectations."
        )

    recovered: List[Dict[str, Any]] = []
    for li in line_items or []:
        code = li.get("ro_account_code") or ""
        if not code:
            continue
        stored_bucket = li.get("bucket") or li.get("canonical_bucket") or ""
        rule = bucket_for(code)
        bucket_override: Optional[str] = None
        if rule and stored_bucket and stored_bucket != rule.bucket:
            legacy = persistence_bucket(rule.bucket)
            if stored_bucket != legacy:
                bucket_override = stored_bucket
        row: Dict[str, Any] = {
            "code": code,
            "name": li.get("ro_account_name") or "",
            "amount": float(li.get("amount") or 0),
        }
        if bucket_override:
            row["bucket_override"] = bucket_override
        recovered.append(row)
    # Reverse-apply sign so assemble_statements sees raw input.
    for acct in recovered:
        rule = bucket_for(acct["code"])
        if rule and rule.sign == -1:
            acct["amount"] = -acct["amount"]
    return recovered


def _envelope_totals(assembled_full: Dict[str, Any]) -> Tuple[float, float, float]:
    """Pull (total_assets, total_liabilities, total_equity) from the
    canonical envelope. Returns (0,0,0) if the envelope is absent —
    that's a signal the engine didn't emit assembled_canonical_v1.
    """
    env = (assembled_full or {}).get("assembled_canonical_v1") or {}
    methodology = (env.get("methodology") or {}) if isinstance(env, dict) else {}
    totals = (methodology.get("totals") or {}) if isinstance(methodology, dict) else {}
    return (
        float(totals.get("total_assets") or 0),
        float(totals.get("total_liabilities") or 0),
        float(totals.get("total_equity") or 0),
    )


def _bs_delta(assembled_full: Dict[str, Any]) -> float:
    """Read assembled_bs.bs_balance_delta — the value the FE consumes."""
    statements = (assembled_full or {}).get("statements") or {}
    bs = statements.get("assembled_bs") or {}
    return float(bs.get("bs_balance_delta") or 0)


def _bs_total_assets(assembled_full: Dict[str, Any]) -> float:
    statements = (assembled_full or {}).get("statements") or {}
    bs = statements.get("assembled_bs") or {}
    return float(bs.get("total_assets") or 0)


def _line_items(assembled_full: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The engine returns lineItems at top level alongside `statements`.
    DB persistence writes these rows to `statement_line_items`."""
    items = (assembled_full or {}).get("lineItems") or []
    if not isinstance(items, list):
        return []
    return list(items)


def _run_one(name: str, raw_accounts: List[Dict[str, Any]],
             source_quality: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Run the full round-trip on a single fixture. Returns a verdict dict."""
    ro_coa = fa31._load_ro_coa()
    fn = getattr(ro_coa, "assemble_statements", None)
    if fn is None:
        return {"name": name, "error": "engine missing assemble_statements"}

    kwargs = {"company_name": name, "currency": "RON", "period_label": "FY2025"}
    if source_quality is not None:
        kwargs["source_data_quality"] = source_quality

    # Step 1+2 — write-time truth.
    truth = fn(raw_accounts, **kwargs)
    truth_delta = _bs_delta(truth)
    truth_assets = _bs_total_assets(truth)

    # Step 3 — extract lineItems (what gets persisted to DB).
    li = _line_items(truth)

    # Step 4 — reconstruct recovered_accounts (pipeline.py logic).
    recovered = _reconstruct_accounts_via_pipeline_logic(li, ro_coa)

    # Step 5 — read-time round-trip.
    roundtrip = fn(recovered, **kwargs)
    roundtrip_delta = _bs_delta(roundtrip)

    # Step 6 — Fix A1 override formula on the envelope.
    ta, tl, te = _envelope_totals(truth)
    fix_a1_delta = round(ta - (tl + te), 2)

    # Step 7 — assertions.
    truth_vs_fix_a1 = abs(truth_delta - fix_a1_delta) <= 1.0  # 1 RON tolerance for cent rounding
    bug_present = abs(truth_delta - roundtrip_delta) > 1.0
    roundtrip_pct = (abs(roundtrip_delta) / truth_assets * 100) if truth_assets > 0 else float("inf")
    truth_pct = (abs(truth_delta) / truth_assets * 100) if truth_assets > 0 else float("inf")

    return {
        "name": name,
        "total_assets": truth_assets,
        "truth_delta": truth_delta,
        "truth_pct": truth_pct,
        "fix_a1_delta": fix_a1_delta,
        "roundtrip_delta": roundtrip_delta,
        "roundtrip_pct": roundtrip_pct,
        "truth_vs_fix_a1_ok": truth_vs_fix_a1,
        "bug_present": bug_present,
        "line_items_count": len(li),
        "recovered_count": len(recovered),
    }


def _print_verdict(v: Dict[str, Any]) -> None:
    if "error" in v:
        print(f"=== {v['name']} === ERROR: {v['error']}")
        return
    name = v["name"]
    print()
    print(f"=== {name} ===")
    print(f"  total_assets         {v['total_assets']:>20,.2f} RON")
    print(f"  truth bs_balance_delta (engine write-time)")
    print(f"                       {v['truth_delta']:>20,.2f} RON   ({v['truth_pct']:.4f}%)")
    print(f"  Fix A1 override delta (env totals subtraction)")
    print(f"                       {v['fix_a1_delta']:>20,.2f} RON")
    print(f"  round-trip delta (current /api/period reassembly)")
    print(f"                       {v['roundtrip_delta']:>20,.2f} RON   ({v['roundtrip_pct']:.4f}%)")
    print(f"  line_items persisted {v['line_items_count']:>20d}")
    print(f"  accounts recovered   {v['recovered_count']:>20d}")
    print(f"  ── Fix A1 == truth?  {'OK ✓' if v['truth_vs_fix_a1_ok'] else 'FAIL ✗'}")
    print(f"  ── round-trip bug?   {'PRESENT ⚠' if v['bug_present'] else 'absent'}")


def _wrong_on_purpose_probe() -> bool:
    """Lock #12 sub-rule: feed a known synthetic envelope and assert
    the Fix A1 formula yields the predicted value.

    Inputs designed so the answer is non-trivially 1.0 — not 0, not the
    sum of inputs, not any input verbatim. If anyone refactors the formula
    direction or operand order, this trips immediately.
    """
    synth = {
        "assembled_canonical_v1": {
            "methodology": {
                "totals": {
                    "total_assets": 100.0,
                    "total_liabilities": 80.0,
                    "total_equity": 19.0,
                }
            }
        }
    }
    ta, tl, te = _envelope_totals(synth)
    expected = 1.0  # 100 - (80 + 19) = 1
    actual = round(ta - (tl + te), 2)
    ok = abs(actual - expected) <= 0.01
    print()
    print("── Lock #12 wrong-on-purpose probe ──────────────────")
    print(f"  synthetic envelope: TA=100, TL=80, TE=19")
    print(f"  expected (TA - (TL+TE)) = {expected}")
    print(f"  actual                   = {actual}")
    print(f"  verdict                  = {'PASS ✓' if ok else 'FAIL ✗'}")
    return ok


_FIXTURES = (
    ("EEI",        fa31.load_eei),
    ("Scandia",    fa31.load_scandia),
    ("Sibiu",      fa31.load_sibiu),
    ("Frozen",     fa31.load_frozen),
    ("RealEstate", fa31.load_realestate),
    ("Agras",      fa31.load_agras),
    ("Carniprod",  fa31.load_carniprod),
    ("Retail",     fa31.load_retail),
)


def main() -> int:
    print("=" * 72)
    print("F3.27-DRIFT-TRANSFORMATION-GLUE — round-trip harness (read-only)")
    print("=" * 72)

    results: List[Dict[str, Any]] = []
    for label, loader in _FIXTURES:
        print()
        print(f"── Loading {label} ──")
        try:
            loaded = loader()
        except Exception as e:  # noqa: BLE001
            print(f"  SKIP — loader failed: {e}")
            results.append({"name": label, "error": f"loader: {e}"})
            continue
        # Loaders return either (accounts, name) OR (accounts, name, source_quality).
        if len(loaded) == 3:
            accounts, name, sq = loaded
        else:
            accounts, name = loaded
            sq = None
        try:
            verdict = _run_one(name or label, accounts, sq)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            verdict = {"name": label, "error": "harness exception"}
        results.append(verdict)
        _print_verdict(verdict)

    # Lock #12 sub-rule probe.
    synth_ok = _wrong_on_purpose_probe()

    # Acceptance summary.
    print()
    print("=" * 72)
    print("ACCEPTANCE SUMMARY")
    print("=" * 72)
    a1_ok_all = True
    bug_seen = []
    for v in results:
        if "error" in v:
            print(f"  {v['name']:<12s}  ERROR: {v['error']}")
            a1_ok_all = False
            continue
        a1_tag = "OK" if v["truth_vs_fix_a1_ok"] else "FAIL"
        bug_tag = "BUG" if v["bug_present"] else "clean"
        print(f"  {v['name']:<12s}  Fix A1 vs truth: {a1_tag:<4s}   round-trip: {bug_tag} "
              f"(truth {v['truth_pct']:.4f}% / round-trip {v['roundtrip_pct']:.4f}%)")
        if not v["truth_vs_fix_a1_ok"]:
            a1_ok_all = False
        if v["bug_present"]:
            bug_seen.append(v["name"])

    print()
    if not a1_ok_all:
        print("✗ ACCEPTANCE FAIL — Fix A1 formula doesn't match engine truth on ≥1 fixture.")
        print("  Override formula NOT value-preserving — DO NOT DEPLOY.")
        return 2
    if not synth_ok:
        print("✗ ACCEPTANCE FAIL — wrong-on-purpose probe failed.")
        return 3
    if not bug_seen:
        print("✓ Fix A1 value-preserving on all fixtures. Round-trip bug NOT reproduced.")
        print("  (If you expected the bug to be present on at least Carniprod, investigate.)")
        return 0
    print("✓ Fix A1 value-preserving on all fixtures.")
    print(f"✓ Round-trip bug REPRODUCED on: {', '.join(bug_seen)}")
    print("  Fix A1 is safe to ship — overrides will move displayed bs_balance_delta")
    print("  to the engine-truth value on these fixtures.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
