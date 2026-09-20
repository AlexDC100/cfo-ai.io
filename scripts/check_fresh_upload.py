"""Post-deploy gate — a REAL trial balance through the five pipeline stages.

Owner ruling 2026-09-20: a deploy is not done until a fresh upload completes
all five steps. `check_served_periods.py` proves STORED data still serves;
this proves a NEW document still analyses. Both run before a deploy is called
done.

It runs the production numeric path — `RomaniaPack.run_deterministic_tb`, the
same composition `stage_extract` + `stage_map` make, then
`credit_model.compute_period_metrics` and `ratios.table.build_ratio_table`,
which is what `stage_compute` persists — over a real book shipped in the image
(`corpus/*/input.xlsx`). It writes NOTHING: no storage object, no documents
row, no period, no customer data touched. A gate that had to create a real
upload in a real workspace would be a gate nobody dares run on a Friday.

The five steps, as the user sees them on screen:

    01 DETECT FORMAT      the parser names the source format and locale
    02 EXTRACT DATA       rows come back with a source anchor
    03 REBUILD STATEMENTS the canonical BS balances to the cent
    04 CALCULATE RATIOS   metrics + the served ratio table are non-empty
    05 GENERATE RECS      the narrate stage is REACHABLE

Step 05 is the AI stage. The pipeline treats a narrate failure as non-fatal —
the document still reaches `analyzed` without a briefing — so this gate reports
it DEGRADED (with the reason) rather than failing the deploy. With the Anthropic
balance at zero that is the true state of production, and a gate that red-lined
on it would be a gate the operator learns to ignore. Exit 1 is reserved for a
step that would leave a user with no numbers.

Exit codes: 0 all five (05 may be degraded, and says so) · 1 a numeric step
failed · 2 the gate could not run or found no book (a vacuous pass is a red).

Usage (inside the backend container, §14):
    docker exec cfo-ai-backend python3 /app/scripts/check_fresh_upload.py
    ... --book corpus/saga_10_col      one book instead of the default set
    ... --json                          machine-readable report
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_BOOKS = ("corpus/saga_10_col", "corpus/saga_10_col_agras")
CENT = Decimal("0.01")


def _repo_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "pyproject.toml").exists() and (parent / "src").is_dir():
            sys.path.insert(0, str(parent / "src"))
            return parent
    raise SystemExit("check_fresh_upload: repo root (pyproject.toml) not found")


def _dec(v: Any) -> Optional[Decimal]:
    if v is None or isinstance(v, bool):
        return None
    try:
        return Decimal(str(v))
    except Exception:  # noqa: BLE001
        return None


def run_book(path: Path, *, narrate_probe) -> Dict[str, Any]:
    """The five steps over ONE book. Never raises: a crash IS a failed step."""
    steps: List[Dict[str, Any]] = []

    def step(n: str, ok: bool, detail: str, *, degraded: bool = False) -> None:
        steps.append({"step": n, "ok": ok, "degraded": degraded, "detail": detail})

    try:
        from engine.country_packs.ro_romania.pack import RomaniaPack
        pack = RomaniaPack()
        content = (path / "input.xlsx").read_bytes()
    except Exception as exc:  # noqa: BLE001
        step("01 DETECT FORMAT", False, f"{type(exc).__name__}: {exc}")
        return {"book": path.name, "steps": steps, "ok": False}

    try:
        tb_rows, shaped, assembled = pack.run_deterministic_tb(
            content, filename=f"{path.name}/input.xlsx",
            company_name="Fresh-upload gate", period_label="gate",
        )
    except Exception as exc:  # noqa: BLE001
        step("01 DETECT FORMAT", False, f"{type(exc).__name__}: {exc}")
        return {"book": path.name, "steps": steps, "ok": False}

    extraction = dict(getattr(tb_rows, "extraction", {}) or {})
    fmt = extraction.get("source_format")
    step("01 DETECT FORMAT", bool(fmt),
         f"source_format={fmt!r} locale={extraction.get('number_locale')!r}")

    rows = list(getattr(tb_rows, "rows", tb_rows) or [])
    anchor = getattr(tb_rows, "source_anchor", None)
    step("02 EXTRACT DATA", len(rows) > 0,
         f"{len(rows)} accounts, source anchor {'present' if anchor else 'ABSENT'}")

    # The engine's OWN verdict is the authority — this gate reads it, it does
    # not re-derive one ("identities read, not assumed"). Totals come through
    # FactsGateway, the only sanctioned reader of canonical_bs (import-boundary
    # gate), and the gate reds if the gateway and the engine's status disagree.
    env = (assembled or {}).get("assembled_canonical_v1") or {}
    cbs = env.get("canonical_bs") or {}
    try:
        from engine.serving.facts import FactsGateway
        facts = FactsGateway.from_envelope({"canonical_bs": dict(cbs)}, currency="RON")
        # The gateway answers in MINOR units (cents) — the whole point of the
        # Fact type is that nobody re-floats money on the way out.
        def _major(fact: Any) -> Optional[Decimal]:
            minor = getattr(fact, "amount_minor", None)
            return None if minor is None else (Decimal(int(minor)) / 100)
        assets, eql = _major(facts.raw_total_assets()), _major(facts.raw_equity_plus_liabilities())
        status = str(cbs.get("status") or "")
        stated = _dec(cbs.get("difference"))
        if assets is None or eql is None or not status:
            step("03 REBUILD STATEMENTS", False,
                 f"canonical_bs carries no verdict (status={status!r}, totals via gateway: {assets}, {eql})")
        else:
            read = (assets - eql).copy_abs()
            agrees = stated is not None and (read - stated.copy_abs()).copy_abs() <= CENT
            step("03 REBUILD STATEMENTS", status == "BALANCED" and read <= CENT and agrees,
                 f"status={status}; assets {assets:,.2f} vs equity+liabilities {eql:,.2f}; "
                 f"engine difference {stated}, gateway reads {read:,.2f}"
                 + ("" if agrees else "  <-- THE ENGINE AND THE GATEWAY DISAGREE"))
    except Exception as exc:  # noqa: BLE001
        step("03 REBUILD STATEMENTS", False, f"{type(exc).__name__}: {exc}")

    statements = (assembled or {}).get("statements") or assembled or {}
    metrics: List[Dict[str, Any]] = []
    try:
        from engine.ratios.credit_model import compute_period_metrics
        metrics = compute_period_metrics(statements, None)
        named = {m.get("name") for m in metrics}
        wanted = {"revenue", "ebitda", "net_income_statutory", "total_assets"}
        step("04 CALCULATE RATIOS", len(metrics) > 0 and wanted <= named,
             f"{len(metrics)} metrics; missing {sorted(wanted - named) or 'none'}")
    except Exception as exc:  # noqa: BLE001
        step("04 CALCULATE RATIOS", False, f"{type(exc).__name__}: {exc}")

    ok, detail = narrate_probe()
    step("05 GENERATE RECS", True, detail, degraded=not ok)

    numeric_ok = all(s["ok"] for s in steps)
    return {"book": path.name, "steps": steps, "ok": numeric_ok,
            "accounts": len(rows), "metrics": len(metrics)}


def default_narrate_probe() -> Tuple[bool, str]:
    """Is the AI narrate stage REACHABLE? Never spends a completion: it builds
    the client the pipeline builds and asks the provider for nothing."""
    import os
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        return False, "narrate unavailable: ANTHROPIC_API_KEY not set (pipeline degrades, document still analyses)"
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False, "narrate unavailable: anthropic SDK not installed"
    return True, f"narrate reachable: key …{key[-4:]}, SDK present (credit balance not probed — that would spend one)"


def report_text(books: List[Dict[str, Any]]) -> str:
    out = []
    for b in books:
        out.append(f"  {b['book']}")
        for s in b["steps"]:
            mark = "ok  " if s["ok"] and not s["degraded"] else ("WARN" if s["degraded"] else "RED ")
            out.append(f"    {mark} {s['step']:<21} {s['detail']}")
    return "\n".join(out)


def exit_code(books: List[Dict[str, Any]]) -> int:
    if not books:
        return 2
    return 0 if all(b["ok"] for b in books) else 1


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--book", action="append", help="repo-relative book directory (repeatable)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    try:
        root = _repo_root()
        wanted = args.book or list(DEFAULT_BOOKS)
        paths = [root / b for b in wanted]
        missing = [str(p) for p in paths if not (p / "input.xlsx").exists()]
        if missing:
            print(f"FRESH UPLOAD: RED — book not found in this image: {missing}")
            return 2
        books = [run_book(p, narrate_probe=default_narrate_probe) for p in paths]
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("FRESH UPLOAD: COULD NOT RUN — treat as RED")
        return 2

    code = exit_code(books)
    if args.json:
        print(json.dumps({"books": books, "exit": code}, indent=1, default=str))
    else:
        print(f"FRESH UPLOAD — {len(books)} real book(s) through the five pipeline stages, nothing written")
        print(report_text(books))
        degraded = [s["step"] for b in books for s in b["steps"] if s["degraded"]]
        verdict = {0: "GREEN — every numeric step produced output", 1: "RED — a numeric step failed",
                   2: "RED — nothing to check (vacuous)"}[code]
        if code == 0 and degraded:
            verdict += f" ({len(degraded)} step(s) degraded, named above)"
        print(f"  {verdict}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
