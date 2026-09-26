#!/usr/bin/env python3
"""The Forecast COCKPIT's acceptance on an owner's local books — measured
through the REAL engine and written as one markdown section per company.

ONE RULE (ruling Q10): a local book is client data. Nothing it produces is
ever written inside the repository — the script refuses an --out path under
the repo — and the script carries no figure of its own.

WHAT IT MEASURES, per company (the owner's spec "ACCEPTANCE on scandia food
and Agras"):

  · year 0 = the actuals the dashboard serves (gate F1): GET /api/period/{id}
    beside the cockpit's base_period, figure by figure, to the cent;
  · every lever with the value in force and the basis the page prints (RO);
  · every case (base, optimist, pesimist): the four numbers, the engine's
    sentence in both languages, and per plan year revenue, EBITDA, net
    profit, cash (BS = CF), the funding line and its interest, the debt
    interest, DSCR against the bank's threshold, and whether the year
    balances (assets = equity + liabilities, to the cent);
  · the funding-need probe (the F8 squeeze: DSO 300 days, revenue −25%,
    full payout) — the need, its month and its interest, or the refusal by
    name;
  · slider latency through the real route: p50 / p95 over twenty moves.

THE WORLD is the gates' own (tests/engine/_real_app_comparatives): the
production write seam (parse -> stage_map -> stage_persist) into the tenancy
double, `engine.api.create_app()` itself, an ES256 bearer the app verifies.
No network, no Supabase, no model call.

    PYTHONPATH=src CFO_AI_SKIP_BOOT_VERIFY=1 .venv/bin/python \\
        scripts/forecast_cockpit_acceptance.py \\
        --current "/path/Balanta_FY2025.xls" --current-end 2025-12-31 \\
        --prior   "/path/Balanta_FY2024.xlsx" --prior-end 2024-12-31 \\
        --company "Company SRL" --caen 1013 \\
        --label "Company SRL (FY2025 + FY2024, CAEN 1013)" \\
        --out /outside/the/repo/forecast_cockpit_acceptance.md [--append]

A one-year company omits --prior (the growth default then reads the sector
median for --caen, stamped [sector], or the macro anchor).
"""
from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO / "tests" / "engine"))

USER = "00000000-0000-4000-8000-000000000001"
ORG = "00000000-0000-4000-8000-00000000c0c9"
CUR, PRI = "c0c9-cur", "c0c9-pri"
CASES = ("base", "optimist", "pesimist")
SQUEEZE = {"levers": {"dso_days": "300", "revenue_growth": "-0.25", "dividend_payout": "1"}}


def _outside_repo(out: Path) -> bool:
    try:
        out.resolve().relative_to(REPO.resolve())
    except ValueError:
        return True
    return False


def _money(minor: Optional[int]) -> str:
    if minor is None:
        return "—"
    sign = "-" if minor < 0 else ""
    minor = abs(minor)
    return "%s%s.%02d" % (sign, "{:,}".format(minor // 100), minor % 100)


def _rows(body: Dict[str, Any]) -> Dict[Tuple[str, str], int]:
    out = {}  # type: Dict[Tuple[str, str], int]
    for section in ("pl", "bs", "cf"):
        for row in body["statements"][section]:
            for value in row["values"]:
                out[(row["line"], value["period"])] = value["amount_minor"]
    return out


def _dscr_text(entry: Dict[str, Any], threshold: str) -> str:
    v = entry.get("value_micros")
    if v is None:
        return "n/a"
    return "%.2fx %s" % (v / 1e6, entry.get("status") or "")


def _head() -> str:
    head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=str(REPO),
                          capture_output=True, text=True).stdout.strip()
    branch = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=str(REPO),
                            capture_output=True, text=True).stdout.strip()
    return "%s @ %s" % (branch, head)


def measure(args: argparse.Namespace) -> Tuple[str, Dict[str, Any]]:
    import _real_app_comparatives as RA
    import firm_postgrest_double as D
    from fastapi.testclient import TestClient
    from engine.api import _forecast_history
    import test_forecast_f_gates as G

    books = []
    cur = RA.book_from_workbook(Path(args.current), period_end=args.current_end, key=CUR)
    books.append((cur, CUR, ORG, args.current_end[:4] + "-01-01", args.current_end))
    if args.prior:
        pri = RA.book_from_workbook(Path(args.prior), period_end=args.prior_end, key=PRI)
        books.append((pri, PRI, ORG, args.prior_end[:4] + "-01-01", args.prior_end))
    org = {"id": ORG, "name": args.company, "default_currency": "RON"}
    if args.caen:
        org["caen_code"] = args.caen
    double = RA.seed_double(
        orgs=[org],
        memberships=[{"user_id": USER, "org_id": ORG, "role": "owner",
                      "created_at": "2026-01-01T00:00:00+00:00"}],
        periods=books)
    app = RA.build_app()
    summary = {}  # type: Dict[str, Any]
    lines = []  # type: List[str]
    say = lines.append
    _forecast_history.clear_cache()
    with RA.installed(double):
        bearer = D.mint_jwt(USER, "owner@local.invalid")
        client = TestClient(app, raise_server_exceptions=False)
        headers = {"Authorization": "Bearer " + bearer, "X-Org-Id": ORG}

        def cockpit(body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
            r = client.post("/api/forecast/%s/cockpit" % CUR, headers=headers, json=body)
            return r.status_code, r.json()

        period = client.get("/api/period/%s" % CUR, headers=headers)
        assert period.status_code == 200, (period.status_code, period.text[:300])
        dashboard = G._dashboard_year_zero(period.json())
        status, base = cockpit({})
        assert status == 200, (status, json.dumps(base)[:600])

        say("## %s" % args.label)
        say("")
        say("Measured %s on `%s` through the real `create_app()` over the tenancy double "
            "(production write path parse -> stage_map -> stage_persist, ES256 bearer, "
            "PostgREST doubled): `GET /api/period/{id}` for the dashboard's year 0, "
            "`POST /api/forecast/{id}/cockpit` for every case and slider. Books: `%s`%s%s. "
            "Local files only, never committed. Probe: scripts/forecast_cockpit_acceptance.py."
            % (time.strftime("%Y-%m-%d"), _head(), Path(args.current).name,
               (" + `%s` (the comparable prior)" % Path(args.prior).name) if args.prior else
               " alone (no prior year loaded)",
               (", workspace CAEN %s" % args.caen) if args.caen else ", no CAEN"))
        if args.note:
            say("")
            say("> %s" % args.note)
        say("")

        # F1
        say("### Year 0 = the actuals the dashboard shows (F1)")
        say("")
        say("| figure | dashboard (GET /api/period) | cockpit year 0 | equal |")
        say("|---|---:|---:|---|")
        figures = base["base_period"]["figures"]
        f1_ok = True
        for key in ("revenue", "ebitda", "net_income", "cash", "total_assets", "equity"):
            d, c = dashboard.get(key), figures[key].get("amount_minor")
            same = d is not None and d == c
            f1_ok = f1_ok and same
            say("| %s | %s | %s | %s |" % (key, _money(d), _money(c),
                                          "yes, to the cent" if same else "NO"))
        summary["f1"] = f1_ok
        say("")

        # levers
        say("### Lever bases the page prints (RO)")
        say("")
        for lever in base["levers"]:
            src = lever.get("source") or {}
            say("- `%s` = %s [%s%s] — %s" % (
                lever["id"], lever.get("value") if lever.get("value") is not None else "not measured",
                lever.get("origin"), (", tier " + str(src.get("tier"))) if src.get("tier") else "",
                lever["basis"]["ro"]))
        growth = [l for l in base["levers"] if l["id"] == "revenue_growth"][0]
        summary["growth"] = {"value": growth.get("value"),
                             "tier": (growth.get("source") or {}).get("tier"),
                             "basis_ro": growth["basis"]["ro"]}
        say("")

        # cases
        threshold = base["numbers"]["dscr_year_one"]["threshold"]
        per_case = {}  # type: Dict[str, Any]
        for case_id in CASES:
            status, body = cockpit({"case_id": case_id})
            if status != 200:
                say("### Case: %s — refused %s" % (case_id, json.dumps(body.get("detail"))[:300]))
                say("")
                continue
            rows = _rows(body)
            served_case = [c for c in body["cases"] if c["id"] == case_id][0]
            n = body["numbers"]
            say("### Case: %s" % case_id)
            say("")
            say("Case basis: %s" % served_case["basis"]["ro"])
            say("")
            say("Sentence (RO): %s" % body["sentence"]["ro"])
            say("")
            say("Sentence (EN): %s" % body["sentence"]["en"])
            say("")
            e = n["ebitda_final_year"]
            cash = n["cash"]
            dscr = n["dscr_year_one"]
            cash_text = ("funding need %s from %s (interest %s)" % (
                _money(cash["figure"]["amount_minor"]), cash["first_period"],
                _money(cash["funding_interest"]["amount_minor"]))
                if cash["kind"] == "funding_need" else
                "minimum cash %s in %s" % (_money(cash["figure"]["amount_minor"]), cash["period"]))
            dscr_text = ("%s (%s vs threshold %s)" % (dscr["display"]["en"]["value"], dscr["status"],
                                                      dscr["display"]["en"]["threshold"])
                         if dscr.get("status") != "not_applicable" else "not applicable")
            say("Four numbers: EBITDA %s %s (margin %s vs %s today) · cumulative FCF %s (%s–%s) · %s · DSCR %s %s."
                % (e["period"], _money(e["figure"]["amount_minor"]), e["display"]["en"]["margin"],
                   e["display"]["en"]["margin_year0"], _money(n["cumulative_fcf"]["figure"]["amount_minor"]),
                   n["cumulative_fcf"]["from"], n["cumulative_fcf"]["to"], cash_text, dscr["period"], dscr_text))
            say("")
            say("| plan year | revenue | EBITDA | net profit | cash (BS = CF) | funding line | funding interest | debt interest | DSCR | balances |")
            say("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|")
            say("| year 0 (actual) | %s | %s | %s | %s | | | | | |" % (
                _money(figures["revenue"].get("amount_minor")), _money(figures["ebitda"].get("amount_minor")),
                _money(figures["net_income"].get("amount_minor")), _money(figures["cash"].get("amount_minor"))))
            years = body["horizon"]["years"]
            dscr_by = dict((d["period"], d) for d in body["dscr_by_year"])
            balanced_all = True
            table = []
            for y in years:
                bs_cash, cf_cash = rows[("bs.cash", y)], rows[("cf.closing_cash", y)]
                balanced = (rows[("bs_totals.assets", y)] == rows[("bs_totals.equity_plus_liabilities", y)]
                            and bs_cash == cf_cash)
                balanced_all = balanced_all and balanced
                row = {"year": y, "revenue": rows[("pl.revenue", y)], "ebitda": rows[("pl.ebitda", y)],
                       "net_income": rows[("pl.net_income", y)], "cash": bs_cash,
                       "funding_line": rows[("bs.revolver", y)],
                       "funding_interest": -rows[("pl.interest_expense_funding_line", y)],
                       "debt_interest": -rows[("pl.interest_expense_debt", y)],
                       "dscr": _dscr_text(dscr_by[y], threshold), "balanced": balanced}
                table.append(row)
                say("| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
                    y, _money(row["revenue"]), _money(row["ebitda"]), _money(row["net_income"]),
                    _money(row["cash"]), _money(row["funding_line"]), _money(row["funding_interest"]),
                    _money(row["debt_interest"]), row["dscr"], "yes" if balanced else "NO"))
            say("")
            say("Engine request compiled from the case: `%s`; credit line priced at: %s." % (
                json.dumps(body["engine_request"], ensure_ascii=False), body["funding_line"]["priced_at"]))
            if case_id != "base":
                b = body["bridge"]["horizon"]
                say("")
                say("Bridge from base over the horizon (%s), sums exactly: %s — %s." % (
                    b["period"], b["sums_exactly"],
                    ", ".join("%s %s" % (s["id"], _money(s["figure"]["amount_minor"]))
                              for s in b["steps"])))
            say("")
            per_case[case_id] = {"balanced": balanced_all, "years": table,
                                 "cash_kind": cash["kind"], "sentence_ro": body["sentence"]["ro"]}
        summary["cases"] = per_case

        # the funding-need probe (F8)
        say("### Funding-need probe (F8 squeeze: DSO 300 days, revenue −25%, full payout)")
        say("")
        status, body = cockpit(SQUEEZE)
        if status != 200:
            say("Refused by name: `%s` — %s" % ((body.get("detail") or {}).get("code"),
                                                (body.get("detail") or {}).get("text")))
            summary["squeeze"] = {"refused": (body.get("detail") or {}).get("code")}
        else:
            cash = body["numbers"]["cash"]
            if cash["kind"] == "funding_need":
                say("Need %s from %s (peak in %s), interest over the plan %s; chart marks the gap: %s; "
                    "cash never below zero: %s. Sentence (RO): %s"
                    % (_money(cash["figure"]["amount_minor"]), cash["first_period"], cash["peak_period"],
                       _money(cash["funding_interest"]["amount_minor"]), body["chart"]["funding_gap"],
                       all(p["cash_minor"] >= 0 for p in body["chart"]["cash"]), body["sentence"]["ro"]))
                summary["squeeze"] = {"need": cash["figure"]["amount_minor"], "from": cash["first_period"],
                                      "interest": cash["funding_interest"]["amount_minor"]}
            else:
                say("No funding need even under the squeeze: minimum cash %s in %s." % (
                    _money(cash["figure"]["amount_minor"]), cash["period"]))
                summary["squeeze"] = {"need": 0}
        say("")

        # latency
        moves = [{"levers": {"revenue_growth": "%.3f" % ((step - 10) / 200.0),
                             "raw_material_price": "%.2f" % (step / 100.0)}}
                 for step in range(20)]
        times = []
        for move in moves:
            started = time.perf_counter()
            status, _b = cockpit(move)
            assert status == 200, (move, status, json.dumps(_b)[:300])
            times.append((time.perf_counter() - started) * 1000)
        times.sort()
        p50, p95 = times[len(times) // 2], times[int(len(times) * 0.95) - 1]
        budget = base["client"]["budget_ms"]
        say("### Slider latency through the real route")
        say("")
        say("Twenty slider moves (revenue growth −5%% to +4.5%%, raw-material price 0 to +19%%) after the first "
            "open: p50 %.1f ms, p95 %.1f ms, max %.1f ms — budget %d ms (`client.budget_ms`), "
            "debounce the page waits %d ms (`client.debounce_ms`). In-process (TestClient): the "
            "network is not in it." % (p50, p95, times[-1], budget, base["client"]["debounce_ms"]))
        say("")
        summary["latency"] = {"p50_ms": round(p50, 1), "p95_ms": round(p95, 1), "budget_ms": budget}
    _forecast_history.clear_cache()
    return "\n".join(lines) + "\n", summary


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--current", required=True)
    ap.add_argument("--current-end", default="2025-12-31")
    ap.add_argument("--prior")
    ap.add_argument("--prior-end", default="2024-12-31")
    ap.add_argument("--company", default="Local company")
    ap.add_argument("--caen", default=None)
    ap.add_argument("--label", default=None)
    ap.add_argument("--note", default=None, help="a line printed under the heading (e.g. 'preliminary close — not the filed year')")
    ap.add_argument("--out", required=True, help="markdown file OUTSIDE the repository")
    ap.add_argument("--append", action="store_true")
    ap.add_argument("--summary-json", default=None, help="also write the machine summary here (outside the repo)")
    args = ap.parse_args(argv)
    out = Path(args.out)
    if not _outside_repo(out) or (args.summary_json and not _outside_repo(Path(args.summary_json))):
        print("refused: the output must lie outside the repository (a local book's capture is client "
              "data and never enters git)", file=sys.stderr)
        return 2
    args.label = args.label or args.company
    text, summary = measure(args)
    out.parent.mkdir(parents=True, exist_ok=True)
    mode = "a" if args.append and out.exists() else "w"
    with out.open(mode, encoding="utf-8") as fh:
        if mode == "a":
            fh.write("\n")
        fh.write(text)
    if args.summary_json:
        Path(args.summary_json).write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print("wrote %s (%s)" % (out, "appended" if mode == "a" else "new"))
    print("F1 to the cent: %s; cases balanced: %s; growth: %s [%s]; latency p95 %.1f ms" % (
        summary["f1"], dict((k, v["balanced"]) for k, v in summary["cases"].items()),
        summary["growth"]["value"], summary["growth"]["tier"], summary["latency"]["p95_ms"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
