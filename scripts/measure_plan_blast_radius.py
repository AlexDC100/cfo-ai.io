#!/usr/bin/env python3
"""The forecast blast radius: what the default GET serves, per plan year,
against the baseline recorded before any plan/2 batch changed the engine.

WHY THIS EXISTS (plan_contract_v2 1.9, ruling R1)
=================================================
The plan/2 batches change served base figures on purpose: year-to-date tax
(B2), base revenue growth from the macro anchor and renamed drivers (B3),
cost pools with fixed shares and inflation (B4), prior-period history (B7).
Each of those moves is correct by the contract and still moves a number an
owner may already have read. So every such batch appends this script's
output to docs/engine_book/forecast_blast_radius.md in the same commit, and
the owner receives the cumulative table before the Scenarios cut-over (B13)
and before the forecast flag flips (B21).

It MEASURES. It never asserts: a delta here is the thing being reported,
not a failure. The gates that decide whether a delta is allowed are
forecast-base-parity (B2-B4) and the batch's own gates.

WHAT IT PRINTS
==============
For agras, carniprod, realestate and retail (the committed corpus books),
and for any book named with --local-xlsx (run locally only, aggregates
only, never committed), per plan year of the default GET (horizon 5):

  revenue          sum of pl.revenue over the plan year's periods
  EBITDA           sum of pl.ebitda over the plan year's periods
  closing cash     bs.cash in the plan year's last period
  peak funding     the largest bs.revolver balance inside the plan year
  first shortfall  the first period of the plan year in which the funding
                   line draws (cf.funding_line_movement > 0), else "none"

each beside the B0 baseline and the delta. Amounts are integer minor units
rendered with thousands separators; nothing passes through a float.

HOW THE DEFAULT GET IS REACHED
==============================
Through the real app (`create_app()`), `GET /api/forecast/{id}?horizon=5`,
with two seams replaced: `_org.resolve_org` (no Supabase auth in a script)
and `_supabase.per_user`, which is handed a ROW SERVER over one committed
book: its financial_periods row (period_end, currency, the canonical
envelope) and its statement_line_items rows, exactly as capture.py recorded
them from the real stage_persist. The route's own loader, statement
rebuild, engine, adapter, contract and boundary guard all run. The row
server is not a store double and this script is not a gate: it serves
fixed rows and answers every other table with no rows.

When a later batch changes the wire (fp1.2 at B6) the reader below takes
the served summary fields when they exist; until then it derives the five
values from the fp1 figures.

THE BASELINE
============
tests/engine/fixtures/forecast/base_get_b0.json, recorded by B0 with
`--record-baseline` from the engine in process on the four books at total
years 5 with no overrides (the delta-mode reference of contract 5.3). It
holds every line for every period in minor units, so this script and the
forecast-base-parity gate read ONE baseline. A local book's baseline is
kept beside its xlsx under --local-baseline and never committed.

Usage:
  python scripts/measure_plan_blast_radius.py
  python scripts/measure_plan_blast_radius.py --markdown
  python scripts/measure_plan_blast_radius.py --local-xlsx files/<book>.xlsx \\
      --local-baseline <scratch>/scandia_b0.json
  python scripts/measure_plan_blast_radius.py --record-baseline   # B0 only

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

BOOKS = ("agras", "carniprod", "realestate", "retail")
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"
BASELINE = REPO / "tests" / "engine" / "fixtures" / "forecast" / "base_get_b0.json"
HORIZON_YEARS = 5
BASELINE_SCHEMA = "base_get_b0/1"
METRICS = ("revenue", "ebitda", "closing_cash", "peak_funding", "first_shortfall")
METRIC_LABELS = {
    "revenue": "revenue",
    "ebitda": "EBITDA",
    "closing_cash": "closing cash",
    "peak_funding": "peak funding",
    "first_shortfall": "first shortfall",
}


# ── books ────────────────────────────────────────────────────────────────


def _corpus_book(name: str) -> Dict[str, Any]:
    path = FIRM / ("saga_10_col_%s.json" % name)
    return json.loads(path.read_text(encoding="utf-8"))


def _local_book(xlsx: Path) -> Dict[str, Any]:
    """Parse a local trial balance through the same real composition
    capture.py records the corpus with. The book never leaves this process;
    only aggregates are printed."""
    spec = importlib.util.spec_from_file_location(
        "firm_capture", str(FIRM / "capture.py"))
    capture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(capture)  # type: ignore[union-attr]
    content = xlsx.read_bytes()
    envelope, statements, currency, line_items = capture.run_engine(
        "local-book", xlsx.name, content, "2025-12-31")
    return {
        "case_id": "local:%s" % xlsx.stem,
        "period_end": "2025-12-31",
        "currency": currency,
        "envelope": envelope,
        "statements": statements,
        "line_items": line_items,
    }


# ── the default GET, through the real app ───────────────────────────────


class _RowServer(object):
    """Serves one book's persisted rows to whatever loader the route uses.
    Every table it does not hold answers no rows."""

    def __init__(self, book: Dict[str, Any], period_id: str, org_id: str) -> None:
        self._tables = {
            "financial_periods": [{
                "id": period_id,
                "org_id": org_id,
                "period_end": book["period_end"],
                "period_start": book.get("period_start"),
                "period_label": book.get("period_end"),
                "currency": book.get("currency") or "RON",
                "updated_at": "1970-01-01T00:00:00+00:00",
                "assembled_canonical_v1": book["envelope"],
            }],
            "statement_line_items": [
                dict(row, period_id=period_id) for row in book["line_items"]],
            "organizations": [{"id": org_id, "name": None,
                               "industry_key": None,
                               "industry_display_name": None,
                               "firm_id": None}],
        }

    def __enter__(self) -> "_RowServer":
        return self

    def __exit__(self, *exc: Any) -> bool:
        return False

    def close(self) -> None:
        return None

    def select(self, table: str, filters: Optional[Dict[str, str]] = None,
               columns: Optional[str] = None, limit: Optional[int] = None,
               **_kw: Any) -> List[Dict[str, Any]]:
        rows = list(self._tables.get(table, []))
        for key, cond in (filters or {}).items():
            if isinstance(cond, str) and cond.startswith("eq."):
                rows = [r for r in rows if key not in r
                        or str(r.get(key)) == cond[3:]]
        if columns and columns != "*":
            wanted = [c.strip() for c in columns.split(",") if c.strip()]
            rows = [dict((c, r.get(c)) for c in wanted if c in r) for r in rows]
        if limit is not None:
            rows = rows[:limit]
        return rows


@contextmanager
def _patched(book: Dict[str, Any], period_id: str, org_id: str) -> Iterator[None]:
    from engine.api import _org, _supabase

    saved = (_org.resolve_org, _supabase.per_user)
    _org.resolve_org = lambda jwt, requested: ("measure-user", org_id)
    _supabase.per_user = lambda jwt: _RowServer(book, period_id, org_id)
    try:
        yield
    finally:
        _org.resolve_org, _supabase.per_user = saved


_APP = None


def _app() -> Any:
    global _APP
    if _APP is None:
        os.environ.setdefault("VITE_SUPABASE_URL", "https://test.supabase.co")
        os.environ.setdefault("VITE_SUPABASE_ANON_KEY", "test-anon")
        os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service")
        os.environ.setdefault("CFO_AI_SKIP_BOOT_VERIFY", "1")
        if not ("test." in os.environ["VITE_SUPABASE_URL"]
                and "supabase.co" in os.environ["VITE_SUPABASE_URL"]):
            raise SystemExit(
                "refusing to build the app against a non-manifest Supabase URL")
        from engine.api.server import create_app
        _APP = create_app()
    return _APP


def default_get(book: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
    from fastapi.testclient import TestClient

    period_id = "blast-radius-period"
    org_id = "blast-radius-org"
    with _patched(book, period_id, org_id):
        client = TestClient(_app(), raise_server_exceptions=False)
        res = client.get(
            "/api/forecast/%s?horizon=%d" % (period_id, HORIZON_YEARS),
            headers={"Authorization": "Bearer measure",
                     "X-Org-Id": org_id},
            follow_redirects=False)
    try:
        body = res.json()
    except ValueError:
        body = {"detail": res.text}
    return res.status_code, body


# ── plan years ───────────────────────────────────────────────────────────


def _plan_year(label: str, anchor_end: str) -> int:
    """Plan year n of a served period label (contract 0.3): YYYY-MM is a
    month, FY<calendar year of the plan-year end> is an annual period."""
    ay, am = int(anchor_end[:4]), int(anchor_end[5:7])
    if label.startswith("FY"):
        # Plan year n ends n years after the anchor, so its calendar year
        # is the anchor's year plus n whatever the anchor month is.
        return int(label[2:6]) - ay
    y, m = int(label[:4]), int(label[5:7])
    months = (y * 12 + m) - (ay * 12 + am)
    return (months - 1) // 12 + 1


def _metrics_from_lines(labels: List[str], lines: Dict[str, List[Optional[int]]],
                        anchor_end: str) -> Dict[int, Dict[str, Any]]:
    out = {}  # type: Dict[int, Dict[str, Any]]
    for i, label in enumerate(labels):
        n = _plan_year(label, anchor_end)
        row = out.setdefault(n, {"revenue": 0, "ebitda": 0, "closing_cash": None,
                                 "peak_funding": 0, "first_shortfall": "none",
                                 "_periods": 0})
        row["_periods"] += 1
        for key, line in (("revenue", "pl.revenue"), ("ebitda", "pl.ebitda")):
            value = lines.get(line, [None] * len(labels))[i]
            if value is None or row[key] is None:
                row[key] = None
            else:
                row[key] += value
        row["closing_cash"] = lines.get("bs.cash", [None] * len(labels))[i]
        revolver = lines.get("bs.revolver", [None] * len(labels))[i]
        if revolver is None:
            row["peak_funding"] = None
        elif row["peak_funding"] is not None:
            row["peak_funding"] = max(row["peak_funding"], revolver)
        move = lines.get("cf.funding_line_movement", [None] * len(labels))[i]
        if row["first_shortfall"] == "none" and move is not None and move > 0:
            row["first_shortfall"] = label
    for row in out.values():
        row.pop("_periods")
    return out


def _lines_from_served(body: Dict[str, Any]) -> Tuple[List[str], Dict[str, List[Optional[int]]]]:
    horizon = body.get("horizon")
    if isinstance(horizon, dict):  # fp1.2 and later
        labels = list(horizon.get("labels") or [])
    else:
        labels = list(horizon or [])
    index = dict((label, i) for i, label in enumerate(labels))
    lines = {}  # type: Dict[str, List[Optional[int]]]
    for fig in body.get("figures") or []:
        label = fig.get("period")
        if label not in index:
            continue
        amount = fig.get("amount_minor")
        if not isinstance(amount, int) or isinstance(amount, bool):
            amount = None
        lines.setdefault(fig.get("line"), [None] * len(labels))[index[label]] = amount
    return labels, lines


# ── the baseline ─────────────────────────────────────────────────────────


def _engine_record(book: Dict[str, Any]) -> Dict[str, Any]:
    """Every line of every period, in minor units, from the engine in
    process with no overrides. The payload is exactly the committed book's
    envelope, statements, period end and currency."""
    from engine.forecast import CF_LINES, LINES, PL_LINES, project_payload
    from engine.forecast.errors import ForecastError

    payload = {
        "envelope": book["envelope"],
        "statements": book["statements"],
        "period_end": book["period_end"],
        "currency": book.get("currency") or "RON",
    }
    try:
        projection = project_payload(payload, horizon_years=HORIZON_YEARS)
    except ForecastError as exc:
        return {"refused": {"code": type(exc).__name__, "text": str(exc)}}
    periods = [p.period.as_dict() for p in projection.periods]
    lines = {}  # type: Dict[str, List[int]]
    for p in projection.periods:
        for key in PL_LINES:
            lines.setdefault("pl." + key, []).append(int(p.pl[key]))
        for key in LINES:
            lines.setdefault("bs." + key, []).append(int(p.bs[key]))
        for key in CF_LINES:
            lines.setdefault("cf." + key, []).append(int(p.cf[key]))
        for key, value in p.checks.items():
            if key.endswith("_cents"):
                lines.setdefault("checks." + key, []).append(int(value))
    return {
        "anchor_period_end": book["period_end"],
        "currency": book.get("currency") or "RON",
        "periods": periods,
        "lines": dict(sorted(lines.items())),
    }


def record_baseline(path: Path) -> None:
    try:
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(REPO),
                              capture_output=True, text=True).stdout.strip()
    except OSError:
        head = ""
    doc = {
        "schema": BASELINE_SCHEMA,
        "recorded_by": "scripts/measure_plan_blast_radius.py --record-baseline",
        "recorded_on_commit": head,
        "engine_call": "engine.forecast.project_payload(book, horizon_years=%d), "
                       "no overrides" % HORIZON_YEARS,
        "total_years": HORIZON_YEARS,
        "monthly_months": 12,
        "units": "minor (integer cents); checks.* are the engine's *_cents checks",
        "books": dict((name, _engine_record(_corpus_book(name))) for name in BOOKS),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=1, sort_keys=False) + "\n",
                    encoding="utf-8")
    print("recorded %s (%d books, commit %s)" % (path.relative_to(REPO)
          if path.is_relative_to(REPO) else path, len(BOOKS), head[:7] or "?"))


def _baseline_metrics(record: Dict[str, Any]) -> Optional[Dict[int, Dict[str, Any]]]:
    if not record or "refused" in record:
        return None
    labels = [p["label"] for p in record["periods"]]
    return _metrics_from_lines(labels, record["lines"], record["anchor_period_end"])


# ── report ───────────────────────────────────────────────────────────────


def _fmt(value: Any) -> str:
    if value is None:
        return "absent"
    if isinstance(value, int) and not isinstance(value, bool):
        sign = "-" if value < 0 else ""
        whole, cents = divmod(abs(value), 100)
        return "%s%s.%02d" % (sign, "{:,}".format(whole), cents)
    return str(value)


def _delta(base: Any, now: Any) -> str:
    if isinstance(base, int) and isinstance(now, int):
        d = now - base
        return "0" if d == 0 else ("+" if d > 0 else "") + _fmt(d)
    if base == now:
        return "same"
    return "%s -> %s" % (_fmt(base), _fmt(now))


def measure(name: str, book: Dict[str, Any],
            base_record: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    status, body = default_get(book)
    entry = {"book": name, "status": status}  # type: Dict[str, Any]
    if status != 200:
        detail = body.get("detail") if isinstance(body, dict) else body
        entry["refused"] = detail
        now = None
    else:
        labels, lines = _lines_from_served(body)
        now = _metrics_from_lines(labels, lines, book["period_end"])
    entry["now"] = now
    entry["base"] = _baseline_metrics(base_record) if base_record else None
    entry["base_refused"] = (base_record or {}).get("refused")
    return entry


def render(entries: List[Dict[str, Any]], markdown: bool) -> str:
    out = []  # type: List[str]
    for e in entries:
        head = "%s  GET status %s" % (e["book"], e["status"])
        if e.get("refused"):
            head += "  refused: %s" % e["refused"]
        if e.get("base_refused"):
            head += "  baseline refused: %s" % e["base_refused"]["text"]
        out.append(("### " if markdown else "") + head)
        years = sorted(set((e["now"] or {}).keys()) | set((e["base"] or {}).keys()))
        if not years:
            out.append("(no plan year served or recorded)")
            out.append("")
            continue
        if markdown:
            out.append("| plan year | metric | baseline B0 | now | delta |")
            out.append("|---|---|---:|---:|---:|")
        for n in years:
            for m in METRICS:
                base = ((e["base"] or {}).get(n) or {}).get(m, "not recorded")
                now = ((e["now"] or {}).get(n) or {}).get(m, "not served")
                cells = ("%d" % n, METRIC_LABELS[m], _fmt(base), _fmt(now),
                         _delta(base, now))
                if markdown:
                    out.append("| " + " | ".join(cells) + " |")
                else:
                    out.append("  year %s  %-16s base %22s  now %22s  delta %s" % cells)
        out.append("")
    return "\n".join(out)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--markdown", action="store_true",
                    help="print tables for docs/engine_book/forecast_blast_radius.md")
    ap.add_argument("--record-baseline", action="store_true",
                    help="B0 only: write tests/engine/fixtures/forecast/base_get_b0.json")
    ap.add_argument("--local-xlsx", type=Path, default=None,
                    help="a local trial balance (never committed); aggregates only")
    ap.add_argument("--local-baseline", type=Path, default=None,
                    help="where the local book's B0 record lives (written when absent)")
    args = ap.parse_args(argv)

    if args.record_baseline:
        record_baseline(BASELINE)
        return 0

    baseline = {}  # type: Dict[str, Any]
    if BASELINE.is_file():
        baseline = json.loads(BASELINE.read_text(encoding="utf-8")).get("books") or {}
    else:
        print("NOTICE no baseline at %s; deltas are not computed" % BASELINE)

    entries = [measure(name, _corpus_book(name), baseline.get(name)) for name in BOOKS]
    if args.local_xlsx is not None:
        book = _local_book(args.local_xlsx)
        record = None
        if args.local_baseline is not None:
            if args.local_baseline.is_file():
                record = json.loads(args.local_baseline.read_text(encoding="utf-8"))
            else:
                record = _engine_record(book)
                args.local_baseline.write_text(json.dumps(record) + "\n",
                                               encoding="utf-8")
                print("NOTICE local baseline written to %s (never commit it)"
                      % args.local_baseline)
        entries.append(measure("local:%s (aggregates only, not committed)"
                               % args.local_xlsx.stem, book, record))

    print("PLAN BLAST RADIUS — default GET /api/forecast/{id}?horizon=%d, "
          "per plan year, against %s" % (HORIZON_YEARS, BASELINE.name))
    print("scope: books %s%s; amounts in minor units shown as currency with "
          "two decimals; this script never asserts"
          % (", ".join(BOOKS), " + one local book" if args.local_xlsx else ""))
    print(render(entries, args.markdown))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
