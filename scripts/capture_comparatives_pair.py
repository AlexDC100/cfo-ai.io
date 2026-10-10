#!/usr/bin/env python3
"""Capture a served two-period ratio comparison — the documents the Ratios
tab, the report and the workbook render — from books through the real
engine.

TWO MODES, ONE RULE: nothing but corpus books is ever written into the
repository (ruling Q10 — no client book or served capture is committed).

  CORPUS (default): rewrite the committed frontend fixtures the byte-match
  and Ratios-tab gates render,
      frontend/lib/__tests__/fixtures/comparatives/pair_served.json
      frontend/lib/__tests__/fixtures/comparatives/pair_prior_blocks.json
  and the two the single-period share gate renders,
      frontend/lib/__tests__/fixtures/comparatives/period_common_size.json
      frontend/lib/__tests__/fixtures/comparatives/pair_prior_later.json
  from the committed corpus pair (agras current, carniprod prior — and, for
  the last, the same pair the other way round: a prior that closes later).
  The builders live in tests/engine/test_ratio_compare_fe_fixture.py and
  tests/engine/test_common_size_fe_fixture.py, which also red when the
  committed bytes drift; this is their command line, not a second capture.

      .venv/bin/python scripts/capture_comparatives_pair.py
      .venv/bin/python scripts/capture_comparatives_pair.py --check

  LOCAL BOOKS (offline): two trial-balance workbooks carried through the
  production write seam (parse -> stage_map -> stage_persist), seeded as two
  periods of one workspace in the tenancy double, then served by
  `engine.api.create_app()` itself — GET /api/period/{id} for each and
  GET /api/period/{current}/comparatives?prior=… — with a real ES256 bearer
  (tests/engine/_real_app_comparatives.py, the world the un-intercepted
  route gate proves). No network, no Supabase, no model call. The output
  directory must lie OUTSIDE the repository: the script refuses otherwise.

      .venv/bin/python scripts/capture_comparatives_pair.py \\
          --current "/path/Balanta_FY2025.xls" --current-end 2025-12-31 \\
          --prior   "/path/Balanta_FY2024.xlsx" --prior-end 2024-12-31 \\
          --company "Company SRL" --industry food_manufacturing --caen 1013 \\
          --out /private/tmp/…/scratchpad/harness

  Writes period_current.json, period_prior.json, comparatives.json and
  periods_list.json (synthesised in the periods-with-documents shape) into --out (the hermetic Playwright harness serves them),
  and prints the prior Altman Z'', composite and letter the route served.

Run with PYTHONPATH=src and CFO_AI_SKIP_BOOT_VERIFY=1.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO / "tests" / "engine"))

USER = "00000000-0000-4000-8000-000000000001"
ORG = "00000000-0000-4000-8000-00000000c0f0"


def _corpus(check: bool) -> int:
    import test_common_size_fe_fixture as CS
    import test_ratio_compare_fe_fixture as FX

    outputs = ((FX.FIXTURE, FX.fixture_text()), (FX.PRIOR_BLOCKS_FIXTURE, FX.prior_blocks_fixture_text()))
    outputs += tuple((path, text()) for path, text in CS.OUTPUTS)
    if check:
        stale = [p.name for p, text in outputs if (p.read_text(encoding="utf-8") if p.is_file() else "") != text]
        if stale:
            print("stale: %s — re-run scripts/capture_comparatives_pair.py" % ", ".join(stale), file=sys.stderr)
            return 1
        print("fresh: %s" % ", ".join(p.name for p, _ in outputs))
        return 0
    for p, text in outputs:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        print("wrote %s (%d bytes)" % (p, p.stat().st_size))
    return 0


def _period_uuid(period_end: str) -> str:
    return "11111111-1111-4111-8111-%012d" % int(period_end.replace("-", ""))


def _outside_repo(out: Path) -> bool:
    try:
        out.resolve().relative_to(REPO.resolve())
    except ValueError:
        return True
    return False


def _local(args: argparse.Namespace) -> int:
    out = Path(args.out)
    if not _outside_repo(out):
        print("refused: --out %s is inside the repository; a local book's capture is client data "
              "and never enters git (ruling Q10)" % out, file=sys.stderr)
        return 2
    import _real_app_comparatives as RA
    import firm_postgrest_double as D

    # UUID-shaped ids (the dashboard reads `?period=` as a period uuid),
    # stable per period end so a re-capture keeps the harness's URLs.
    cur_id = _period_uuid(args.current_end)
    pri_id = _period_uuid(args.prior_end)
    books = []
    for path, end, pid in ((Path(args.current), args.current_end, cur_id),
                           (Path(args.prior), args.prior_end, pri_id)):
        bk = RA.book_from_workbook(path, period_end=end, industry=args.industry, key=pid)
        books.append((bk, pid, ORG, end[:4] + "-01-01", end))
        print("persisted %s -> %s (%d line items)" % (path.name, pid, len(bk.line_items)))
    org = {"id": ORG, "name": args.company, "default_currency": "RON"}
    if args.industry:
        org["industry_key"] = args.industry
    if args.caen:
        org["caen_code"] = args.caen
    double = RA.seed_double(
        orgs=[org],
        memberships=[{"user_id": USER, "org_id": ORG, "role": "owner", "created_at": "2026-01-01T00:00:00+00:00"}],
        periods=books)
    app = RA.build_app()
    with RA.installed(double):
        bearer = D.mint_jwt(USER, "owner@local.invalid")
        RA.seed_metrics(app, double, (cur_id, pri_id), ORG, bearer)
        bodies: Dict[str, Any] = {}
        for name, pid in (("period_current.json", cur_id), ("period_prior.json", pri_id)):
            resp = RA.get(app, "/api/period/%s" % pid, bearer, ORG)
            if resp.status_code != 200:
                print("GET /api/period/%s -> %d %s" % (pid, resp.status_code, resp.text[:400]), file=sys.stderr)
                return 1
            bodies[name] = resp.json()
        resp = RA.get(app, "/api/period/%s/comparatives?prior=%s" % (cur_id, pri_id), bearer, ORG)
        if resp.status_code != 200:
            print("GET comparatives -> %d %s" % (resp.status_code, resp.text[:400]), file=sys.stderr)
            return 1
        comparatives = resp.json()
    out.mkdir(parents=True, exist_ok=True)
    # The period picker's list, in GET /api/org/periods-with-documents'
    # shape but SYNTHESISED here: that route also reads documents, SKU and
    # public-record tables this world does not seed. It carries ids and
    # dates only, no figure.
    periods_list = {"recently_deleted": [], "periods": [
        {"period_id": pid, "period_label": end, "period_start": end[:4] + "-01-01", "period_end": end,
         "is_active": True,
         "documents": [{"id": "doc-%s" % end[:4], "filename": Path(path).name, "is_active": True,
                        "status": "analyzed", "scope": "financial"}]}
        for pid, end, path in ((cur_id, args.current_end, args.current), (pri_id, args.prior_end, args.prior))]}
    files = dict(bodies)
    files["comparatives.json"] = comparatives
    files["periods_list.json"] = periods_list
    for name, doc in files.items():
        (out / name).write_text(json.dumps(doc, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        print("wrote %s" % (out / name))
    comps = {c["key"]: c for c in (comparatives.get("ratios") or {}).get("composites", [])}
    for key in ("altman_z", "credit_composite", "letter_grade"):
        row = comps.get(key) or {}
        print("%s: current %s, prior %s" % (key, (row.get("current") or {}).get("value_q"),
                                             (row.get("prior") or {}).get("value_q")))
    bm = (comparatives.get("ratios") or {}).get("band_movements") or {}
    print("improved %s" % bm.get("improved"))
    print("deteriorated %s" % bm.get("deteriorated"))
    return 0


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--check", action="store_true", help="corpus mode: exit 1 when a committed fixture is stale")
    ap.add_argument("--current", help="local mode: the current period's trial balance")
    ap.add_argument("--prior", help="local mode: the prior period's trial balance")
    ap.add_argument("--current-end", default="2025-12-31")
    ap.add_argument("--prior-end", default="2024-12-31")
    ap.add_argument("--company", default="Local company")
    ap.add_argument("--industry", default=None)
    ap.add_argument("--caen", default=None)
    ap.add_argument("--out", help="local mode: output directory, outside the repository")
    args = ap.parse_args(argv)
    if args.current or args.prior or args.out:
        if not (args.current and args.prior and args.out):
            ap.error("local mode needs --current, --prior and --out")
        return _local(args)
    return _corpus(args.check)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
