#!/usr/bin/env python3
"""Build the PUBLIC SAMPLE — a fictional company through the real engine.

The landing page links a sample anyone can inspect without signing in
(owner, 2026-10-01): a trial balance to download, the complete report the
product generates from it, the account-by-account mapping the engine
assigned, and every uncertainty label it raised. FICTIONAL DATA ONLY —
the book is authored by `scripts/build_public_sample_tb.py`, never taken
from a client.

WHAT RUNS, AND WHAT IS REAL.

  1. `build_public_sample_tb.build_books()` — the two trial balances
     (FY2024, FY2025), read off a double-entry ledger.
  2. THE ENGINE, offline. Each workbook is carried through the production
     write seam (parse -> `stage_map` -> `stage_persist`), seeded as two
     periods of one workspace, and served by `engine.api.create_app()`
     itself: GET /api/period/{id} for each year and
     GET /api/period/{2025}/comparatives?prior={2024}, with a real ES256
     bearer (tests/engine/_real_app_comparatives.py — the world the
     un-intercepted route gate proves). What is doubled: PostgREST and the
     network. Sockets are blocked for the duration; no model is called and
     the model library is never imported (asserted).
  3. The published files, all derived from those served documents:
        public/sample/balanta_exemplu_fictiv_31.12.<year>.xlsx   (two)
        public/sample/served_period_fy<year>.json                (two)
        public/sample/served_comparatives_fy2025_vs_fy2024.json
        public/sample/account_mapping_fy2025.csv
        public/sample/uncertainty_labels_fy2025.json
  4. `scripts/build_public_sample_report.mjs` — the product's own report
     builder and PDF renderer over the served documents:
        public/sample/sample_report_fy2025.html
        public/sample/sample_report_fy2025.pdf
  5. `frontend/data/publicSample.json` — what the /sample page prints:
     every figure with the JSON pointer it was read from, so the page can
     be held to the served document (gate `public-sample`).

NO CLOCK. The only date is `as_of` in scripts/public_sample_config.json.
A rebuild on any day, on any machine, writes the same bytes (the PDF
excepted: its bytes belong to the Chromium that printed it, so it is held
to its text layer).

    PYTHONPATH=src .venv/bin/python scripts/build_public_sample.py
    PYTHONPATH=src .venv/bin/python scripts/build_public_sample.py --check
    ... --no-report     skip step 4 (no Node, no Chromium)
    ... --no-pdf        step 4 writes / checks the HTML only

Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import hashlib
import io
import json
import shutil
import socket
import subprocess
import sys
import tempfile
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

REPO = Path(__file__).resolve().parents[1]
for _p in (REPO / "src", REPO / "tests" / "engine", REPO / "scripts"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import build_public_sample_tb as TB  # noqa: E402

PUBLIC_DIR = REPO / "public" / "sample"
PAGE_DATA = REPO / "frontend" / "data" / "publicSample.json"
CONFIG_PATH = REPO / "scripts" / "public_sample_config.json"
REPORT_SCRIPT = REPO / "scripts" / "build_public_sample_report.mjs"

SCHEMA = "public_sample/1"
CURRENT_YEAR, PRIOR_YEAR = 2025, 2024

SERVED_PERIOD = "served_period_fy%d.json"
SERVED_COMPARATIVES = "served_comparatives_fy2025_vs_fy2024.json"
MAPPING_CSV = "account_mapping_fy2025.csv"
LABELS_JSON = "uncertainty_labels_fy2025.json"
KNOWN_ISSUES_JSON = "known_issues_fy2025.json"
REPORT_HTML = "sample_report_fy2025.html"
REPORT_PDF = "sample_report_fy2025.pdf"

#: The sample workspace — a user, an organisation, two periods. Fixed ids,
#: so the served documents are the same bytes on every run.
SAMPLE_USER = "00000000-0000-4000-8000-000000000001"
SAMPLE_ORG = "00000000-0000-4000-8000-0000005a3b1e"
#: The workspace industry a small food manufacturer's owner would pick
#: (frontend/components/cfo/OrgIndustryPills.tsx: key + stored label).
INDUSTRY_KEY = "manufacturing"
INDUSTRY_DISPLAY = "Manufacturing · industrial"


def period_id(year: int) -> str:
    return "11111111-1111-4111-8111-%012d" % (year * 10000 + 1231)


def config() -> Dict[str, Any]:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def canonical_json(obj: Any) -> str:
    """The one serialisation of every JSON file this script writes."""
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=1, allow_nan=False) + "\n"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ── 1. the books ──────────────────────────────────────────────────────

def workbooks() -> "OrderedDict[int, bytes]":
    books = TB.build_books()
    return OrderedDict((year, TB.write_workbook(year, book["rows"])) for year, book in books.items())


# ── 2. the engine, offline ────────────────────────────────────────────

@contextlib.contextmanager
def no_network() -> Iterator[None]:
    """Any socket connect raises for the duration: the sample is produced
    by the engine alone."""
    real = socket.socket.connect

    def _refuse(*_a: Any, **_k: Any) -> None:
        raise RuntimeError("network blocked: the public sample is built offline")

    socket.socket.connect = _refuse  # type: ignore[assignment]
    try:
        yield
    finally:
        socket.socket.connect = real  # type: ignore[assignment]


def serve_workbooks(entries: Sequence[Tuple[int, str, bytes]], *,
                    compare: Optional[Tuple[int, int]] = None) -> Dict[str, Any]:
    """Carry each `(year, filename, workbook bytes)` through the production
    write seam, seed them as periods of the sample workspace and serve
    them with `create_app()`: {"periods": {year: GET /api/period body},
    "comparatives": the (current, prior) comparison or None}."""
    import _real_app_comparatives as RA
    import firm_postgrest_double as D

    # No environment is set here: `RA.build_app()` pins what the app needs
    # for the duration of its construction and restores it, so a test
    # session that imports this module is left exactly as it was.
    with no_network(), tempfile.TemporaryDirectory(prefix="public-sample-") as tmp:
        seeded = []
        for year, filename, content in entries:
            path = Path(tmp) / filename
            path.write_bytes(content)
            end = "%d-12-31" % year
            book = RA.book_from_workbook(path, period_end=end, industry=INDUSTRY_DISPLAY,
                                         key=period_id(year))
            seeded.append((book, period_id(year), SAMPLE_ORG, "%d-01-01" % year, end))
        org = {"id": SAMPLE_ORG, "name": TB.COMPANY_NAME, "default_currency": "RON",
               "industry_key": INDUSTRY_KEY, "industry_display_name": INDUSTRY_DISPLAY,
               "caen_code": TB.CAEN}
        double = RA.seed_double(
            orgs=[org],
            memberships=[{"user_id": SAMPLE_USER, "org_id": SAMPLE_ORG, "role": "owner",
                          "created_at": "2026-01-01T00:00:00+00:00"}],
            periods=seeded)
        app = RA.build_app()
        with RA.installed(double):
            bearer = D.mint_jwt(SAMPLE_USER, "owner@sample.invalid")
            years = [year for year, _name, _content in entries]
            RA.seed_metrics(app, double, [period_id(y) for y in years], SAMPLE_ORG, bearer)
            periods: Dict[int, Any] = {}
            for year in years:
                resp = RA.get(app, "/api/period/%s" % period_id(year), bearer, SAMPLE_ORG)
                if resp.status_code != 200:
                    raise RuntimeError("GET /api/period (FY%d) -> %d %s"
                                       % (year, resp.status_code, resp.text[:400]))
                periods[year] = resp.json()
            comparatives = None
            if compare is not None:
                resp = RA.get(app, "/api/period/%s/comparatives?prior=%s"
                              % (period_id(compare[0]), period_id(compare[1])), bearer, SAMPLE_ORG)
                if resp.status_code != 200:
                    raise RuntimeError("GET comparatives -> %d %s" % (resp.status_code, resp.text[:400]))
                comparatives = resp.json()
    if "anthropic" in sys.modules:
        raise RuntimeError("the model library was imported while building the public sample")
    return {"periods": periods, "comparatives": comparatives}


def serve(books: "OrderedDict[int, bytes]") -> Dict[str, Any]:
    """The sample workspace as `create_app()` serves it: both years and
    their comparison."""
    return serve_workbooks([(year, TB.workbook_filename(year), content)
                            for year, content in books.items()],
                           compare=(CURRENT_YEAR, PRIOR_YEAR))


# ── 3. what the served documents say ──────────────────────────────────

def pointer(doc: Any, path: str) -> Any:
    """RFC 6901 JSON pointer; a list segment may also be `key=value` to
    pick the item of a list of objects (`/rows/key=dso/value`)."""
    node = doc
    for raw in [seg for seg in path.split("/") if seg != ""]:
        seg = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(node, list):
            if "=" in seg:
                key, _, want = seg.partition("=")
                hits = [item for item in node if isinstance(item, dict) and str(item.get(key)) == want]
                if len(hits) != 1:
                    raise KeyError("%s: %d items match %s" % (path, len(hits), seg))
                node = hits[0]
            else:
                node = node[int(seg)]
        else:
            node = node[seg]
    return node


#: The money figures the page prints — each one a pointer into the served
#: period document. (key, pointer)
FIGURES: Tuple[Tuple[str, str], ...] = (
    ("net_turnover", "/statements/assembled_pl/turnover"),
    ("ebitda", "/statements/assembled_pl/ebitda"),
    ("operating_result", "/statements/assembled_pl/operating_result"),
    ("net_income_statutory", "/statements/assembled_pl/net_income_statutory"),
    ("stock_variation_711", "/statements/assembled_pl/inventory_variation/value"),
    ("net_provisions", "/statements/assembled_pl/net_provisions/value"),
    ("total_assets", "/statements/canonical_bs/totals/assets"),
    ("total_equity", "/statements/canonical_bs/totals/equity"),
    ("total_liabilities", "/statements/canonical_bs/totals/liabilities"),
    ("cash", "/statements/assembled_bs/cash"),
    ("total_debt", "/statements/assembled_bs/total_debt"),
)


def figures_of(period_body: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [{"key": key, "pointer": path, "value": pointer(period_body, path)}
            for key, path in FIGURES]


#: The ratios the page prints, from the served two-period comparison
#: (`ratios.rows`) — both years at the engine's own quantisation.
RATIO_KEYS: Tuple[str, ...] = (
    "ebitda_margin", "net_margin", "roe", "equity_ratio", "current_ratio", "cash_ratio",
    "net_debt_to_ebitda", "interest_coverage", "dscr", "dso", "dio", "dpo", "ccc",
)
COMPOSITE_KEYS: Tuple[str, ...] = ("letter_grade", "credit_composite", "altman_z")


def _side(side: Dict[str, Any]) -> Dict[str, Any]:
    """The fields of a served ratio side the page's printer reads."""
    return {k: side.get(k) for k in ("value", "value_q", "band", "band_status", "reason")}


def ratios_of(comparatives: Dict[str, Any]) -> List[Dict[str, Any]]:
    block = comparatives["ratios"]
    out: List[Dict[str, Any]] = []
    for collection, keys in (("rows", RATIO_KEYS), ("composites", COMPOSITE_KEYS)):
        for key in keys:
            path = "/ratios/%s/key=%s" % (collection, key)
            row = pointer(comparatives, path)
            out.append({"key": key, "kind": "ratio" if collection == "rows" else "composite",
                        "display_unit": row["display_unit"], "pointer": path,
                        "current": _side(row["current"]), "prior": _side(row["prior"])})
    return out


def verdicts_of(period_body: Dict[str, Any], prior_body: Dict[str, Any],
                rows: Sequence[Any]) -> Dict[str, Any]:
    """The engine's own verdicts on the book, copied — never re-decided."""
    st = period_body["statements"]
    cbs = st["canonical_bs"]
    pl = st["assembled_pl"]
    credit = period_body["assembled_metrics"]["ratio_table"]["credit"]
    inv = st["inventory_days"]
    variation = pl["inventory_variation"]
    insights = st["insights"]
    piotroski = st["assembled_piotroski"]
    # The balance-sheet facts through the engine's ONE authority for them
    # (engine.serving.facts — docs/CANONICAL_BS_V2_CONTRACT.md), not read
    # off the raw totals.
    from engine.serving.facts import FactsGateway

    gateway = FactsGateway.from_envelope(st["assembled_canonical_v1"], currency=st["currency"])
    if gateway is None:
        raise RuntimeError("the served envelope carries no canonical balance sheet")
    served_bs = gateway.served_canonical_bs or {}
    presentation = served_bs.get("status_presentation") or {}
    return {
        "balance": {
            "status": served_bs["status"],
            "served_difference": gateway.difference().to_float(),
            "display_en": presentation.get("display_en"),
            "display_ro": presentation.get("display_ro"),
            "assets": gateway.total_assets().to_float(),
            "equity_plus_liabilities": gateway.equity_plus_liabilities().to_float(),
            "source_anchor": cbs["source_anchor"]["anchor_status"],
            "source_balanced": cbs["source_anchor"]["source_balanced"],
            "unmapped": len(cbs.get("unmapped") or []),
        },
        "anchor": {
            "status": pl["net_income_anchor_status"],
            "account_121": pl["net_income_statutory_anchor"],
            "net_income_statutory": pl["net_income_statutory"],
            "net_income_reconstructed": pl["net_income_reconstructed"],
            "unexplained_vs_121": pl["net_income_unexplained_vs_121"] + 0.0,
        },
        "stock_variation": {
            "value": variation["value"],
            "provenance": variation["provenance"],
            "book_state": variation["book_state"],
            "refusal": variation["refusal"],
            "label_ro": variation["label_ro"],
            "label_en": variation["label_en"],
            # THE REAL CROSS-CHECK of the derived line: the movement of work
            # in progress and finished goods on the published ledger. On a
            # closed book "net income equals account 121" holds by
            # construction (the 711 line is the bridge to 121), so the page
            # prints this beside it.
            "ledger_stock_movement": ledger_stock_movement(rows),
        },
        "ebitda": ebitda_verdict(period_body),
        "credit": {
            "composite": credit["composite"],
            "letter": credit["letter"],
            "altman_z": credit["altman"]["z"],
            "altman_zone": credit["altman"]["zone"],
            "subscores": credit["subscores"],
            "refused_subscores": credit["refused_subscores"],
            "model_revision": credit["revision"],
        },
        "inventory_days": {
            "status": inv["status"],
            "basis": inv["basis"],
            "basis_label_ro": inv["basis_label"]["ro"],
            "basis_label_en": inv["basis_label"]["en"],
            "total_value_q": inv["total"]["value_q"],
            "seasonality_flagged": inv["seasonality"]["flagged"],
            "reconciliation": inv["reconciliation"]["status"],
            "may_call_slow": inv["claim_policy"]["may_call_slow"],
            # The cash conversion cycle does NOT add the figure above: it adds
            # the split on the period-end balance, so that all three of its
            # terms are period-end figures. The page prints this term and its
            # basis beside the cycle (DSO + DIO − DPO would otherwise not foot).
            "ccc_term_value_q": inv["total"]["closing_value_q"],
            "ccc_term_basis_label_ro": inv["ccc_dio_term"]["basis_label"]["ro"],
            "ccc_term_basis_label_en": inv["ccc_dio_term"]["basis_label"]["en"],
        },
        "cash_flow": cash_flow_verdict(period_body, prior_body),
        "piotroski": {"score": piotroski["score"], "score_max": piotroski["score_max"],
                      "has_prior_period": piotroski["has_prior_period"]},
        "insights": [
            {"id": item["id"], "level": item["severity"]["level"], "title": item["title"],
             "claim": item["claim"]}
            for item in insights["insights"]
        ],
        "insights_by_level": _count_by_level(insights["insights"]),
        "ratio_table": dict(period_body["assembled_metrics"]["ratio_table"]["coverage"]),
    }


def cash_flow_verdict(period_body: Dict[str, Any], prior_body: Dict[str, Any]) -> Dict[str, Any]:
    """The engine's cash-flow reconstruction beside the two balance sheets.

    The engine labels its cash flow approximated and says the movements
    "cannot be computed without a prior-period trial balance" — while the
    prior year is published on the same page. That is a limit of the
    engine, stated here rather than hidden: its reconstruction does not
    read the prior period yet. So the page prints, beside the engine's
    estimate of the year's net change in cash, the cash each served balance
    sheet closes on and the movement between them. The one subtraction is
    made HERE, between two served figures named by their pointers (gate
    `public-sample` S6 re-reads both and re-checks it); the page computes
    nothing."""
    cf = period_body["statements"]["assembled_cf"]
    cash_pointer = "/statements/assembled_bs/cash"
    closing = pointer(period_body, cash_pointer)
    opening = pointer(prior_body, cash_pointer)
    return {
        "is_approximated": cf["is_approximated"],
        "net_change_estimated": cf["net_change_in_cash"],
        "pointer_net_change": "/statements/assembled_cf/net_change_in_cash",
        "closing_cash": closing,
        "prior_closing_cash": opening,
        "pointer_cash": cash_pointer,
        "balance_sheet_movement": round(closing - opening, 2) + 0.0,
    }


# ── 3b. what this report gets wrong on this book ──────────────────────
#
# The sample is the product's real output, and three things in it are
# wrong or misleading — defects of the ENGINE (tickets exist; engine code
# is fixed in its own releases), not of the sample. Nothing known-false is
# published unflagged: /sample and the report itself open with a "Known
# issues in this report" box, and each line of it carries the figure the
# engine served beside the figure the LEDGER gives.
#
# Every ledger figure below is arithmetic on the published trial balance —
# named accounts, a named column — done here, by the generator, and held by
# gate `public-sample` (S11), which re-reads the published workbook cell by
# cell and repeats the sums. No figure is typed: not here, not in the page,
# not in the report.
#
# AN ISSUE LEAVES THE LIST BY ITSELF. Each is included only while the
# engine's figure still differs from the ledger's; when a fix ships, the
# rebuild drops the line and S11 reds until the sample is regenerated.

#: Row columns of `build_public_sample_tb.Row`.
_SI_D, _SI_C, _R_D, _R_C, _SF_D, _SF_C = 2, 3, 4, 5, 8, 9

CASH_ACCOUNTS = ("5121", "5124", "5311")
STOCK_OF_PRODUCTION = ("331", "341", "345", "348")
DEPRECIABLE_TANGIBLE = ("212", "213", "214")
TANGIBLE_DEPRECIATION = ("281",)
KNOWN_ISSUES_SCHEMA = "public_sample_known_issues/1"


def _ledger_sum(rows: Sequence[Any], prefixes: Sequence[str], column: int) -> "Any":
    """Σ of one trial-balance column over the accounts starting with any of
    `prefixes` — Decimal, to the cent."""
    total = TB.ZERO
    for row in rows:
        if any(str(row[0]).startswith(p) for p in prefixes):
            total += row[column]
    return total


def _money(value: Any) -> float:
    return float(TB.D(value)) + 0.0


def ledger_stock_movement(rows: Sequence[Any]) -> Dict[str, Any]:
    """The year's movement of work in progress and finished goods — closing
    debit balance less opening debit balance of 331 / 341 / 345 / 348. On a
    closed book the engine DERIVES the 711 line (account 711 itself reads
    zero); this is the ledger figure that derivation must equal."""
    closing = _ledger_sum(rows, STOCK_OF_PRODUCTION, _SF_D) - _ledger_sum(rows, STOCK_OF_PRODUCTION, _SF_C)
    opening = _ledger_sum(rows, STOCK_OF_PRODUCTION, _SI_D) - _ledger_sum(rows, STOCK_OF_PRODUCTION, _SI_C)
    used = sorted({str(r[0]) for r in rows if any(str(r[0]).startswith(p) for p in STOCK_OF_PRODUCTION)})
    return {"value": _money(closing - opening), "opening": _money(opening), "closing": _money(closing),
            "accounts": used}


def _cash_flow_issue(rows: Sequence[Any], current: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    cf = current["statements"]["assembled_cf"]
    opening = _ledger_sum(rows, CASH_ACCOUNTS, _SI_D) - _ledger_sum(rows, CASH_ACCOUNTS, _SI_C)
    closing = _ledger_sum(rows, CASH_ACCOUNTS, _SF_D) - _ledger_sum(rows, CASH_ACCOUNTS, _SF_C)
    movement = closing - opening
    additions = (_ledger_sum(rows, ("20", "21", "23"), _R_D) - _ledger_sum(rows, ("231",), _R_C))
    paid_fixed = _ledger_sum(rows, ("404",), _R_D)
    drawn = _ledger_sum(rows, ("1621",), _R_C)
    repaid = _ledger_sum(rows, ("1621",), _R_D)
    lease = _ledger_sum(rows, ("167",), _R_D)
    line = ((_ledger_sum(rows, ("5191",), _SF_C) - _ledger_sum(rows, ("5191",), _SF_D))
            - (_ledger_sum(rows, ("5191",), _SI_C) - _ledger_sum(rows, ("5191",), _SI_D)))
    dividends = _ledger_sum(rows, ("457",), _R_D)
    interest = _ledger_sum(rows, ("666",), _R_D)
    financing = drawn - repaid - lease + line - dividends - interest
    engine_net = cf["net_change_in_cash"]
    if not cf["is_approximated"] and abs(engine_net - _money(movement)) < 0.01:
        return None
    return {
        "id": "cash_flow_estimated",
        "engine": {
            "is_approximated": cf["is_approximated"],
            "net_change_in_cash": engine_net,
            "cash_from_investing": cf["cash_from_investing"],
            "cash_from_financing": cf["cash_from_financing"],
            "cash_from_operating": cf["cash_from_operating"],
            "implied_opening_cash": round(cf["closing_cash_actual"] - engine_net, 2) + 0.0,
            "pointers": {
                "net_change_in_cash": "/statements/assembled_cf/net_change_in_cash",
                "cash_from_investing": "/statements/assembled_cf/cash_from_investing",
                "cash_from_financing": "/statements/assembled_cf/cash_from_financing",
                "cash_from_operating": "/statements/assembled_cf/cash_from_operating",
                "closing_cash_actual": "/statements/assembled_cf/closing_cash_actual",
            },
        },
        "ledger": {
            "cash_opening": _money(opening),
            "cash_closing": _money(closing),
            "cash_movement": _money(movement),
            "fixed_asset_additions_ex_vat": _money(additions),
            "paid_to_fixed_asset_suppliers": _money(paid_fixed),
            "loans_drawn": _money(drawn),
            "loans_repaid": _money(repaid),
            "lease_repaid": _money(lease),
            "credit_line_change": _money(line),
            "dividends": _money(dividends),
            "interest": _money(interest),
            "financing": _money(financing),
            "arithmetic": {
                "cash_opening": "opening debit balance of 5121 + 5124 + 5311",
                "cash_closing": "closing debit balance of 5121 + 5124 + 5311",
                "fixed_asset_additions_ex_vat": "debit movement of classes 20, 21 and 23 less the credit movement of 231 (the transfer out of construction in progress)",
                "paid_to_fixed_asset_suppliers": "debit movement of 404",
                "loans_drawn": "credit movement of 1621",
                "loans_repaid": "debit movement of 1621",
                "lease_repaid": "debit movement of 167",
                "credit_line_change": "closing credit balance of 5191 less its opening credit balance",
                "dividends": "debit movement of 457",
                "interest": "debit movement of 666",
                "financing": "loans drawn − loans repaid − lease repaid + credit line change − dividends − interest",
            },
        },
    }


def _quick_ratio_issue(current: Dict[str, Any], comparatives: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    table_pointer = "/ratios/rows/key=quick_ratio/current"
    side = pointer(comparatives, table_pointer)
    operands = {op["name"]: op["value"] for op in side["operands"]}
    finding_pointer = "/statements/insights/insights/id=liquidity_quality"
    try:
        finding = pointer(current, finding_pointer)
    except KeyError:
        return None
    measure = [m for m in finding["measures"] if m["key"] == "quick_ratio"]
    if not measure or abs(measure[0]["value"] - side["value"]) < 0.0005:
        return None
    facts = {f["name"]: f["value"] for f in finding["facts"]}
    cash, receivables = operands["cash"], operands["accountsReceivable"]
    liabilities = operands["current_liabilities"]
    current_assets = facts["assembled_bs.total_current_assets"]
    inventory = facts["assembled_bs.inventory"]
    table_value = (cash + receivables) / liabilities
    finding_value = (current_assets - inventory) / liabilities
    if abs(table_value - side["value"]) > 1e-9 or abs(finding_value - measure[0]["value"]) > 1e-9:
        raise RuntimeError("the two quick ratios are no longer the two definitions the known-issues "
                           "box describes — re-read the engine's change before publishing")
    return {
        "id": "quick_ratio_two_definitions",
        "finding_id": finding["id"],
        "finding_title": finding["title"],
        "finding_measure_label": measure[0]["label"],
        "ratio_table": {
            "value": side["value"], "value_q": side["value_q"],
            "cash": cash, "trade_receivables": receivables, "current_liabilities": liabilities,
            "pointer": table_pointer, "document": SERVED_COMPARATIVES,
        },
        "finding": {
            "value": measure[0]["value"],
            "current_assets": current_assets, "inventory": inventory, "current_liabilities": liabilities,
            "pointer": finding_pointer + "/measures/key=quick_ratio/value",
            "document": SERVED_PERIOD % CURRENT_YEAR,
        },
    }


def _asset_age_issue(rows: Sequence[Any], current: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    finding_pointer = "/statements/insights/insights/id=asset_age"
    try:
        finding = pointer(current, finding_pointer)
    except KeyError:
        return None
    measures = {m["key"]: m["value"] for m in finding["measures"]}
    gross = _ledger_sum(rows, DEPRECIABLE_TANGIBLE, _SF_D)
    accumulated = _ledger_sum(rows, TANGIBLE_DEPRECIATION, _SF_C) - _ledger_sum(rows, TANGIBLE_DEPRECIATION, _SF_D)
    charge = _ledger_sum(rows, TANGIBLE_DEPRECIATION, _R_C)
    land = _ledger_sum(rows, ("211",), _SF_D)
    in_progress = _ledger_sum(rows, ("231",), _SF_D)
    intangibles_net = (_ledger_sum(rows, ("20",), _SF_D)
                       - (_ledger_sum(rows, ("280",), _SF_C) - _ledger_sum(rows, ("280",), _SF_D)))
    remaining = gross - accumulated
    share = float(accumulated / gross)
    years = float(remaining / charge)
    if abs(share - measures["depreciated_share"]) < 0.0005 and abs(years - measures["remaining_book_life"]) < 0.05:
        return None
    return {
        "id": "asset_age_bases",
        "finding_id": finding["id"],
        "finding_title": finding["title"],
        "engine": {
            "depreciated_share": measures["depreciated_share"],
            "remaining_book_life_years": measures["remaining_book_life"],
            "net_book_value": measures["net_book_value"],
            "gross_ppe": measures["gross_ppe"],
            "annual_charge": measures["annual_da"],
            "pointer": finding_pointer + "/measures",
        },
        "ledger": {
            "depreciable_tangible_gross": _money(gross),
            "accumulated_depreciation": _money(accumulated),
            "remaining_net_book_value": _money(remaining),
            "annual_depreciation_charge": _money(charge),
            "depreciated_share": round(share, 6),
            "remaining_life_years": round(years, 6),
            "land": _money(land),
            "construction_in_progress": _money(in_progress),
            "intangibles_net": _money(intangibles_net),
            "arithmetic": {
                "depreciable_tangible_gross": "closing debit balance of 212 + 2131 + 2133 + 214",
                "accumulated_depreciation": "closing credit balance of 2812 + 2813 + 2814",
                "annual_depreciation_charge": "credit movement of 2812 + 2813 + 2814",
                "depreciated_share": "accumulated depreciation ÷ depreciable tangible gross",
                "remaining_life_years": "(gross − accumulated depreciation) ÷ the year's depreciation charge",
                "land": "closing debit balance of 211",
                "construction_in_progress": "closing debit balance of 231",
                "intangibles_net": "closing debit balance of 208 less the closing credit balance of 2808",
            },
        },
    }


def known_issues(rows: Sequence[Any], current: Dict[str, Any],
                 comparatives: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The issues this report has on this book — each one only while the
    engine's figure still differs from the ledger's."""
    found = [_cash_flow_issue(rows, current), _quick_ratio_issue(current, comparatives),
             _asset_age_issue(rows, current)]
    return [issue for issue in found if issue is not None]


def known_issues_document(rows: Sequence[Any], current: Dict[str, Any],
                          comparatives: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "schema": KNOWN_ISSUES_SCHEMA,
        "company": {
            "name": TB.COMPANY_NAME,
            "fictional": True,
            "notice_en": "Fictional company — a generated sample, not a real entity.",
            "notice_ro": "Companie fictivă — exemplu generat, nu o entitate reală.",
        },
        "period": "FY%d" % CURRENT_YEAR,
        "about": ("What the sample report gets wrong on this book. `engine` is what the engine served "
                  "(each figure with the pointer it was read from); `ledger` is arithmetic on the published "
                  "trial balance, with the accounts and the column of every sum under `arithmetic`. An "
                  "issue is listed only while the two differ; the sample is regenerated when a fix ships."),
        "trial_balance": TB.workbook_filename(CURRENT_YEAR),
        "issues": known_issues(rows, current, comparatives),
    }


#: The three named EBITDA variants scripts/check_methodology_parity.py
#: holds within 1 RON: the methodology layer's figure against the field of
#: the engine's own computation. (variant, assembled_pl field)
EBITDA_VARIANTS: Tuple[Tuple[str, str], ...] = (
    ("reported", "ebitda"), ("strict", "adjusted_ebitda"), ("cash", "ebitda_cash"))


def ebitda_verdict(period_body: Dict[str, Any]) -> Dict[str, Any]:
    st = period_body["statements"]
    pl = st["assembled_pl"]
    methodology = st["assembled_canonical_v1"]["methodology"]["ebitda"]
    variants = [{"key": key, "methodology": methodology[key], "engine": pl[field],
                 "pointer_methodology": "/statements/assembled_canonical_v1/methodology/ebitda/%s" % key,
                 "pointer_engine": "/statements/assembled_pl/%s" % field}
                for key, field in EBITDA_VARIANTS]
    return {
        "value": pl["ebitda"],
        "refusal": pl["ebitda_refusal"],
        "definition": pl["ebitda_definition"],
        "variants": variants,
        "max_difference": round(max(abs(v["methodology"] - v["engine"]) for v in variants), 2) + 0.0,
    }


_LEVELS = ("critical", "high", "medium", "low", "info")


def _count_by_level(insights: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """[{level, count}] in severity order — a list, because the JSON this
    lands in is written with sorted keys."""
    counts = OrderedDict((level, 0) for level in _LEVELS)
    for item in insights:
        counts[item["severity"]["level"]] = counts.get(item["severity"]["level"], 0) + 1
    return [{"level": level, "count": count} for level, count in counts.items()]


def engine_identity(period_body: Dict[str, Any]) -> Dict[str, Any]:
    st = period_body["statements"]
    prov = period_body.get("pack_provenance") or {}
    table = period_body["assembled_metrics"]["ratio_table"]
    return {
        "parser_version": st["canonical_bs"]["extraction"]["parser_version"],
        "extraction_method": st["canonical_bs"]["extraction"]["method"],
        "ebitda_definition": st["assembled_pl"]["ebitda_definition"],
        "canonical_version": period_body.get("canonical_version"),
        "mapping_version": prov.get("mapping_version"),
        "pack": prov.get("pack"),
        "credit_model_revision": table["credit"]["revision"],
        "ratio_table_version": table.get("table_version"),
    }


def uncertainty_labels(period_body: Dict[str, Any], comparatives: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every place the engine itself says a figure is approximated,
    derived, on a stated basis, refused or not assessed — and every check
    it ran and found clear — in the engine's words. Nothing here is
    written by this script: `engine_ro` / `engine_en` are copied (null
    where the engine has no sentence in that language), `reason` is a
    refusal's served code and inputs, `source` is the pointer they were
    copied from."""
    st = period_body["statements"]
    labels: List[Dict[str, Any]] = []

    def add(key: str, kind: str, area: str, source: str, en: Optional[str], ro: Optional[str],
            reason: Optional[Dict[str, Any]] = None) -> None:
        labels.append({"key": key, "kind": kind, "area": area, "source": source,
                       "engine_en": en, "engine_ro": ro, "reason": reason})

    cf = st["assembled_cf"]
    if cf.get("is_approximated"):
        for i, note in enumerate(cf.get("approximation_notes") or []):
            add("cash_flow_approximated_%d" % (i + 1), "approximation", "cash_flow",
                "/statements/assembled_cf/approximation_notes/%d" % i, note, None)

    variation = st["assembled_pl"]["inventory_variation"]
    if variation.get("refusal"):
        add("stock_variation_refused", "refusal", "profit_and_loss",
            "/statements/assembled_pl/inventory_variation/refusal",
            variation["refusal"]["text_en"], variation["refusal"]["text_ro"])
    elif variation.get("provenance") == "account_121_bridge":
        add("stock_variation_derived", "derived", "profit_and_loss",
            "/statements/assembled_pl/inventory_variation",
            variation["label_en"], variation["label_ro"])
        add("stock_variation_identity", "derived", "profit_and_loss",
            "/statements/assembled_pl/inventory_variation",
            variation["identity_note_en"], variation["identity_note_ro"])

    refusal = st["assembled_pl"].get("ebitda_refusal")
    if refusal:
        add("ebitda_refused", "refusal", "profit_and_loss", "/statements/assembled_pl/ebitda_refusal",
            refusal["text_en"], refusal["text_ro"])

    bands = st.get("assembled_bands") or {}
    if bands.get("disclosure"):
        # Every band printed under a ratio is graded on this table.
        add("bands_general_sme", "basis", "ratios", "/statements/assembled_bands/disclosure",
            bands["disclosure"], None)

    inv = st["inventory_days"]
    add("inventory_days_basis", "basis", "ratios", "/statements/inventory_days/basis_label",
        inv["basis_label"]["en"], inv["basis_label"]["ro"])
    term = inv.get("ccc_dio_term") or {}
    if term.get("basis_label") and term["basis_label"] != inv["basis_label"]:
        # The cash conversion cycle adds inventory days on ANOTHER basis.
        add("ccc_inventory_term_basis", "basis", "ratios",
            "/statements/inventory_days/ccc_dio_term/basis_label",
            term["basis_label"]["en"], term["basis_label"]["ro"])
    if inv["seasonality"]["flagged"]:
        add("inventory_days_seasonality", "basis", "ratios", "/statements/inventory_days/seasonality",
            inv["seasonality"]["note_en"], inv["seasonality"]["note_ro"])
    policy_text = inv["claim_policy"].get("reason_text") or {}
    if policy_text.get("en"):
        # What may be said about the stock on this basis — stated by the
        # engine whether or not the claim is allowed.
        add("inventory_days_claim_policy", "basis", "ratios", "/statements/inventory_days/claim_policy",
            policy_text["en"], policy_text.get("ro"))

    table = period_body["assembled_metrics"]["ratio_table"]
    for row in table["rows"]:
        reason = row.get("reason")
        if row.get("value") is None and isinstance(reason, dict):
            # The engine refuses with a CODE and the inputs it lacked, not a
            # sentence; the page words it with the ratio table's own reader.
            add("ratio_refused_%s" % row["key"], "refusal", "ratios",
                "/assembled_metrics/ratio_table/rows/key=%s/reason" % row["key"], None, None,
                reason={"ratio": row["key"], "display_unit": row["display_unit"],
                        "code": reason.get("code"), "inputs": list(reason.get("inputs") or [])})

    methodology = (st["assembled_canonical_v1"].get("methodology") or {}).get("ratios") or {}
    for key in sorted(methodology):
        note = methodology[key].get("note") if isinstance(methodology[key], dict) else None
        if note:
            add("methodology_note_%s" % key, "approximation", "ratios",
                "/statements/assembled_canonical_v1/methodology/ratios/%s/note" % key, note, None)

    piotroski = st["assembled_piotroski"]
    uncertain = [c for c in piotroski["checks"] if c["result"] == "uncertain"]
    if uncertain:
        add("piotroski_prior_unavailable", "not_assessed", "risk",
            "/statements/assembled_piotroski/disclosure", piotroski.get("disclosure"), None)

    for i, item in enumerate(st["insights"].get("not_fired") or []):
        add("insight_not_fired_%s" % item["id"], "checked_clear", "findings",
            "/statements/insights/not_fired/%d/reason" % i, item["reason"], None)
    # Who worded the findings: the engine's template, with its stated reason.
    template_reasons = sorted({
        (item.get("narrative") or {}).get("reason") or ""
        for item in st["insights"].get("insights") or []
        if (item.get("narrative") or {}).get("source") == "deterministic"} - {""})
    for i, reason in enumerate(template_reasons):
        first = next(n for n, item in enumerate(st["insights"]["insights"])
                     if (item.get("narrative") or {}).get("reason") == reason)
        add("findings_wording_template" + ("" if i == 0 else "_%d" % (i + 1)), "basis", "findings",
            "/statements/insights/insights/%d/narrative/reason" % first, reason, None)

    confidence = period_body.get("confidence") or {}
    if confidence.get("calibration_tier"):
        add("calibration_tier", "basis", "document", "/confidence/calibration_tier",
            str(confidence["calibration_tier"]), None)

    detail = (comparatives.get("current") or {}).get("detail_level") or {}
    if detail.get("reason"):
        add("detail_level", "basis", "document", "comparatives:/current/detail_level/reason",
            detail["reason"], None)
    comparability = comparatives.get("comparability") or {}
    if comparability.get("reason"):
        add("comparison_level", "basis", "comparison", "comparatives:/comparability/reason",
            comparability["reason"], None)
    return labels


#: Field names under which the engine states a caveat about a figure: a
#: disclosure, the basis a figure stands on, an approximation, a refusal, a
#: note. `label_completeness` walks the served documents for them.
DISCLOSURE_FIELDS = frozenset((
    "disclosure", "basis_label", "approximation_notes", "note", "note_en", "note_ro",
    "identity_note_en", "identity_note_ro", "refusal", "reason_text", "reason",
))

#: Places a disclosure field carries something that is NOT an uncertainty
#: about a figure — each with the reason. An entry that matches nothing is
#: itself a red (the list only shrinks).
LABEL_EXCLUSIONS: Tuple[Tuple[str, str], ...] = (
    (r"/insights/insights/\d+/severity/basis_label$",
     "the name of the figure a finding's severity is measured against — printed with the finding"),
    (r"/canonical_bs/excluded/\d+/reason$",
     "why an account is not summed as a row — the mapping's own status column, account by account"),
    (r"/claim_policy/reason$",
     "the claim policy's CODE; its sentence (`reason_text`) is the label"),
    (r"^comparatives:/(prior_statements|prior_canonical_bs|prior|bridges|movers|common_size)/",
     "the prior period's own document and the comparison's working — the labels describe the current year"),
    (r"^comparatives:/columns/\d+/note$",
     "how each line of the two-year comparison states its change — printed with the comparison, line by line"),
    (r"^comparatives:/ratios/",
     "refused ratio sides of the comparison: the current year's are labels; the prior year's are printed in the two-year table"),
    (r"^/statements/common_size/rows/\d+/note$",
     "how each line of the single-year share column states its share, or why it takes none (a line the year did not "
     "report; a subdivision below the book's detail level, which is the label `detail_level`) — printed with the "
     "column, line by line, as the two-year comparison's own notes are"),
)


def _disclosures(doc: Any, prefix: str) -> List[Tuple[str, List[str]]]:
    """(pointer, the sentences or codes stated there) for every disclosure
    field of `doc` that carries a value."""
    found: List[Tuple[str, List[str]]] = []

    def strings(node: Any) -> List[str]:
        if isinstance(node, str):
            return [node] if node.strip() else []
        if isinstance(node, list):
            return [s for item in node for s in strings(item)]
        if isinstance(node, dict):
            return [s for key in sorted(node) for s in strings(node[key])]
        return []

    def walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            for key in sorted(node):
                child = "%s/%s" % (path, key)
                if key in DISCLOSURE_FIELDS:
                    texts = strings(node[key])
                    if texts:
                        found.append((child, texts))
                walk(node[key], child)
        elif isinstance(node, list):
            for i, item in enumerate(node):
                walk(item, "%s/%d" % (path, i))

    walk(doc, prefix)
    return found


def label_completeness(period_body: Dict[str, Any], comparatives: Dict[str, Any],
                       labels: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Is every caveat the engine stated ABOUT THIS BOOK on the label list?

    The page says "each uncertainty label it raised". Until 2026-10-02 the
    list was whatever `uncertainty_labels` remembered to collect, and the
    gate checked only that a listed label was the engine's own sentence —
    so a disclosure left out was invisible. Three were: the general-SME
    band table every ratio band is graded on, the basis of the inventory
    term the cash cycle adds, and two methodology notes.

    Returns {"missing": [(pointer, text)], "dead_exclusions": [pattern],
    "examined": n}: a statement found under a disclosure field of the
    served statements (or the comparison) that no label quotes and no
    exclusion explains; and an exclusion that matched nothing."""
    import re as _re

    quoted: List[str] = []
    for label in labels:
        quoted += [t for t in (label["engine_en"], label["engine_ro"]) if t]
        if label["reason"]:
            quoted.append(str(label["reason"]["code"]))
            quoted += [str(x) for x in label["reason"].get("inputs") or []]
    blob = "\n".join(quoted)
    used = set()
    missing: List[Tuple[str, str]] = []
    examined = 0
    found = _disclosures(period_body["statements"], "/statements")
    found += _disclosures(period_body.get("assembled_metrics") or {}, "/assembled_metrics")
    found += _disclosures(comparatives, "comparatives:")
    for path, texts in found:
        examined += 1
        excluded = [pattern for pattern, _why in LABEL_EXCLUSIONS if _re.search(pattern, path)]
        if excluded:
            used.update(excluded)
            continue
        for text in texts:
            if text not in blob:
                missing.append((path, text))
    return {
        "missing": missing,
        "dead_exclusions": [pattern for pattern, _why in LABEL_EXCLUSIONS if pattern not in used],
        "examined": examined,
    }


#: The served P&L line (a field of `statements.assembled_pl`) each engine
#: bucket lands on. Three lines are not a bucket and are decided by the
#: served document itself: the provisions accounts the engine nets into
#: `net_provisions` (it lists them, by account), account 711, whose line is
#: the DERIVED net, and 72x.
PL_LINE_OF_BUCKET = {
    "revenue": "turnover",
    "cogs": "cogs",
    "operatingExpenses": "opex_excluding_cogs_and_da",
    "depreciation": "depreciation",
    "otherIncome": "other_operating_income",
    "financialIncome": "financial_income",
    "financialExpense": "financial_expense",
    "interestExpense": "interest_expense",
    "taxExpense": "income_tax",
}


def _pl_line(code: str, bucket: Optional[str], pl: Dict[str, Any]) -> Optional[str]:
    provisions = pl.get("net_provisions") or {}
    for side in ("charges", "reversals"):
        if code in ((provisions.get(side) or {}).get("by_account") or {}):
            return "net_provisions"
    if code.startswith("711"):
        return "inventory_variation"
    if code.startswith("72"):
        return "capitalized_own_work"
    return PL_LINE_OF_BUCKET.get(bucket or "")


def _bs_row_for(code: str, rows: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The served balance-sheet row an account lands on. The engine lists a
    row's accounts by PREFIX ('151', '302', '442', '475'), so an analytic
    account (1518, 3022, 4423, 4751) is matched by its longest listed
    prefix — an exact-code lookup left five mapped accounts with no row."""
    best: Optional[Dict[str, Any]] = None
    best_len = -1
    for row in rows:
        for listed in row.get("account_codes") or []:
            listed = str(listed)
            if code.startswith(listed) and len(listed) > best_len:
                best, best_len = row, len(listed)
    return best


#: The mapping file's columns.
MAPPING_COLUMNS = ("account", "account_name", "statement", "engine_bucket", "balance_sheet_section",
                   "balance_sheet_row", "pl_line", "amount_ron", "status", "note")


def mapping_rows(year: int, period_body: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every account of the trial balance, and what the engine did with it
    — from the served line items and the served canonical balance sheet."""
    books = TB.build_books()
    cbs = period_body["statements"]["canonical_bs"]
    by_code: Dict[str, Dict[str, Any]] = {}
    for item in period_body["line_items"]:
        code = str(item["ro_account_code"])
        if code in by_code:
            raise RuntimeError("account %s appears twice in the served line items" % code)
        by_code[code] = item
    excluded = {str(e["code"]): e["reason"] for e in cbs.get("excluded") or []}
    pl = period_body["statements"]["assembled_pl"]
    variation = pl["inventory_variation"]
    out: List[Dict[str, Any]] = []
    for tb_row in books[year]["rows"]:  # type: ignore[index]
        code, name = tb_row[0], tb_row[1]
        item = by_code.pop(code, None)
        on_balance_sheet = (item is not None and item["statement"] == "BS") or code in excluded
        row = _bs_row_for(code, cbs["rows"]) if on_balance_sheet else None
        if item is not None:
            status = "mapped"
        elif code in excluded:
            status = "excluded:%s" % excluded[code]
        else:
            status = "no_closing_balance"
        amount = item["amount"] if item else None
        if item is None and row is not None and list(row.get("account_codes") or []) == [code]:
            amount = row["amount"]          # 121: carried as the current-year result row
        out.append({
            "account": code,
            "account_name": name,
            "statement": item["statement"] if item else None,
            "engine_bucket": item["bucket"] if item else None,
            "balance_sheet_section": row["section"] if row else None,
            "balance_sheet_row": row["id"] if row else None,
            "balance_sheet_row_label_key": row["label_key"] if row else None,
            "pl_line": (_pl_line(code, item["bucket"], pl)
                        if item is not None and item["statement"] == "PL" else None),
            "amount_ron": amount,
            "status": status,
            # 711 on a closed book: the line item carries the account's GROSS
            # turnover; the P&L line the engine serves is the derived net.
            "note": ({"key": "served_net_derived_from_121", "value": variation["value"]}
                     if item is not None and item["bucket"] and code.startswith("711")
                     and variation.get("provenance") == "account_121_bridge" else None),
        })
    if by_code:
        raise RuntimeError("the engine served line items for accounts the trial balance does not "
                           "list: %s" % sorted(by_code))
    return out


#: The first line of the mapping file: a reader who opens the CSV on its
#: own must see that the company does not exist.
MAPPING_NOTICE = ("# %s — companie fictivă, exemplu generat; nu este o entitate reală / "
                  "fictional company, a generated sample; not a real entity" % TB.COMPANY_NAME)


def mapping_csv(rows: Sequence[Dict[str, Any]]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    buf.write(MAPPING_NOTICE + "\n")      # one line, not a CSV record
    writer.writerow(MAPPING_COLUMNS)
    for row in rows:
        writer.writerow([
            row["account"], row["account_name"], row["statement"] or "", row["engine_bucket"] or "",
            row["balance_sheet_section"] or "", row["balance_sheet_row"] or "", row["pl_line"] or "",
            "" if row["amount_ron"] is None else "%.2f" % row["amount_ron"], row["status"],
            "" if row["note"] is None else "%s=%.2f" % (row["note"]["key"], row["note"]["value"]),
        ])
    # BOM: a spreadsheet opening the file reads the diacritics correctly.
    return ("﻿" + buf.getvalue()).encode("utf-8")


def company_block() -> Dict[str, Any]:
    return {
        "name": TB.COMPANY_NAME,
        "fictional": True,
        "fiscal_code": TB.FISCAL_CODE,
        "fiscal_code_valid": False,
        "trade_register": TB.TRADE_REGISTER,
        "caen": TB.CAEN,
        "caen_name_ro": TB.CAEN_NAME_RO,
        "caen_name_en": TB.CAEN_NAME_EN,
        "workspace_industry_key": INDUSTRY_KEY,
        "currency": "RON",
    }


def industry_as_served(period_body: Dict[str, Any]) -> Dict[str, Any]:
    """The industry the report's cover prints — read from the served
    document (the workspace's setting), with the pointer it came from."""
    path = "/statements/industry"
    return {"display": pointer(period_body, path), "pointer": path,
            "document": SERVED_PERIOD % CURRENT_YEAR}


# ── the file set ──────────────────────────────────────────────────────

def engine_files() -> "OrderedDict[str, bytes]":
    """Steps 1-3: every published file except the report."""
    books = workbooks()
    served = serve(books)
    current = served["periods"][CURRENT_YEAR]
    files: "OrderedDict[str, bytes]" = OrderedDict()
    for year, content in books.items():
        files[TB.workbook_filename(year)] = content
    for year in books:
        files[SERVED_PERIOD % year] = canonical_json(served["periods"][year]).encode("utf-8")
    files[SERVED_COMPARATIVES] = canonical_json(served["comparatives"]).encode("utf-8")
    files[MAPPING_CSV] = mapping_csv(mapping_rows(CURRENT_YEAR, current))
    rows = TB.build_books()[CURRENT_YEAR]["rows"]
    issues = known_issues_document(rows, current, served["comparatives"])  # type: ignore[arg-type]
    labels_document: Dict[str, Any] = {
        "schema": "public_sample_labels/3",
        "company": {
            "name": TB.COMPANY_NAME,
            "fictional": True,
            "notice_en": "Fictional company — a generated sample, not a real entity.",
            "notice_ro": "Companie fictivă — exemplu generat, nu o entitate reală.",
        },
        "period": "FY%d" % CURRENT_YEAR,
        "labels": uncertainty_labels(current, served["comparatives"]),
    }
    if any(issue["id"] == "cash_flow_estimated" for issue in issues["issues"]):
        # The labels are the engine's sentences, quoted. One of them is
        # false for this book, and a file that quotes it says so.
        labels_document["known_issues"] = {
            "file": KNOWN_ISSUES_JSON,
            "labels": sorted(label["key"] for label in labels_document["labels"]
                             if label["key"].startswith("cash_flow_approximated")),
            "note_en": ("The cash-flow labels are quoted as the engine wrote them, and one sentence in them is "
                        "false for this book: no reconciliation plug is served, and closing cash does not tie "
                        "to the prior year's balance sheet through the estimated movements. The ledger's "
                        "figures are in %s." % KNOWN_ISSUES_JSON),
            "note_ro": ("Etichetele despre fluxul de numerar sunt citate așa cum le-a scris motorul, iar o "
                        "propoziție din ele este falsă pentru această balanță: nu este servită nicio linie de "
                        "reconciliere, iar numerarul final nu se leagă de bilanțul anului precedent prin "
                        "mișcările estimate. Cifrele din registru sunt în %s." % KNOWN_ISSUES_JSON),
        }
    files[LABELS_JSON] = canonical_json(labels_document).encode("utf-8")
    files[KNOWN_ISSUES_JSON] = canonical_json(issues).encode("utf-8")
    return files


#: (file, kind) in the order the page lists them. The PDF's bytes depend
#: on the Chromium that printed it, so its size and hash are not recorded.
PUBLISHED: Tuple[Tuple[str, str], ...] = (
    (TB.workbook_filename(CURRENT_YEAR), "trial_balance"),
    (TB.workbook_filename(PRIOR_YEAR), "trial_balance"),
    (REPORT_HTML, "report_html"),
    (REPORT_PDF, "report_pdf"),
    (MAPPING_CSV, "mapping"),
    (LABELS_JSON, "labels"),
    (KNOWN_ISSUES_JSON, "known_issues"),
    (SERVED_PERIOD % CURRENT_YEAR, "served_document"),
    (SERVED_PERIOD % PRIOR_YEAR, "served_document"),
    (SERVED_COMPARATIVES, "served_document"),
)


def page_data(directory: Path) -> Dict[str, Any]:
    """Step 5 — read back from the published files, so the page's figures
    are the served document's by construction."""
    current = json.loads((directory / (SERVED_PERIOD % CURRENT_YEAR)).read_text(encoding="utf-8"))
    prior = json.loads((directory / (SERVED_PERIOD % PRIOR_YEAR)).read_text(encoding="utf-8"))
    comparatives = json.loads((directory / SERVED_COMPARATIVES).read_text(encoding="utf-8"))
    books = TB.build_books()
    files = []
    for name, kind in PUBLISHED:
        entry: Dict[str, Any] = {"name": name, "kind": kind}
        if kind != "report_pdf":
            data = (directory / name).read_bytes()
            entry["bytes"] = len(data)
            entry["sha256"] = sha256_hex(data)
        files.append(entry)
    return {
        "schema": SCHEMA,
        "as_of": config()["as_of"],
        "company": dict(company_block(), industry_as_served=industry_as_served(current)),
        "engine": engine_identity(current),
        "served_document": SERVED_PERIOD % CURRENT_YEAR,
        "periods": {
            "current": {"label": "FY%d" % CURRENT_YEAR, "period_end": current["period"]["period_end"],
                        "accounts": len(books[CURRENT_YEAR]["rows"]),  # type: ignore[arg-type]
                        "figures": figures_of(current)},
            "prior": {"label": "FY%d" % PRIOR_YEAR, "period_end": prior["period"]["period_end"],
                      "accounts": len(books[PRIOR_YEAR]["rows"]),  # type: ignore[arg-type]
                      "figures": figures_of(prior)},
        },
        "ratios": ratios_of(comparatives),
        "verdicts": verdicts_of(current, prior, books[CURRENT_YEAR]["rows"]),  # type: ignore[arg-type]
        # Read back from the PUBLISHED file: the page and the report print
        # one list, and it is the one a reader can download.
        "known_issues": json.loads((directory / KNOWN_ISSUES_JSON).read_text(encoding="utf-8"))["issues"],
        "labels": uncertainty_labels(current, comparatives),
        "mapping": mapping_rows(CURRENT_YEAR, current),
        "files": files,
    }


# ── build / check ─────────────────────────────────────────────────────

def _run_report(directory: Path, *, check: bool, pdf: bool) -> int:
    cmd = ["node", str(REPORT_SCRIPT), "--dir", str(directory)]
    if check:
        cmd.append("--check")
    if not pdf:
        cmd.append("--no-pdf")
    return subprocess.run(cmd, cwd=str(REPO)).returncode


def build(*, report: bool = True, pdf: bool = True) -> int:
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    for name, data in engine_files().items():
        (PUBLIC_DIR / name).write_bytes(data)
        print("wrote %s (%d bytes)" % ((PUBLIC_DIR / name).relative_to(REPO), len(data)))
    if report:
        code = _run_report(PUBLIC_DIR, check=False, pdf=pdf)
        if code != 0:
            return code
    if not (PUBLIC_DIR / REPORT_HTML).is_file():
        print("skipped %s: the report has not been built yet" % PAGE_DATA.relative_to(REPO))
        return 0
    PAGE_DATA.parent.mkdir(parents=True, exist_ok=True)
    PAGE_DATA.write_text(canonical_json(page_data(PUBLIC_DIR)), encoding="utf-8")
    print("wrote %s" % PAGE_DATA.relative_to(REPO))
    return 0


def stale_files() -> List[str]:
    """Names of the committed files a rebuild would change (steps 1-3 and
    5; the report is step 4's own check)."""
    stale: List[str] = []
    for name, data in engine_files().items():
        path = PUBLIC_DIR / name
        if not path.is_file() or path.read_bytes() != data:
            stale.append(name)
    expected = canonical_json(page_data(PUBLIC_DIR))
    if not PAGE_DATA.is_file() or PAGE_DATA.read_text(encoding="utf-8") != expected:
        stale.append(str(PAGE_DATA.relative_to(REPO)))
    return stale


def check(*, report: bool = True, pdf: bool = True) -> int:
    stale = stale_files()
    for name in stale:
        print("  FAIL %s is not what a rebuild produces" % name, file=sys.stderr)
    code = 1 if stale else 0
    if report:
        code = max(code, _run_report(PUBLIC_DIR, check=True, pdf=pdf))
    print("public sample: %s" % ("STALE — run scripts/build_public_sample.py" if code else "PASS"))
    return code


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true",
                        help="compare the committed files with a rebuild; write nothing")
    parser.add_argument("--no-report", action="store_true", help="skip the report (no Node)")
    parser.add_argument("--no-pdf", action="store_true", help="the report as HTML only (no Chromium)")
    args = parser.parse_args(argv)
    if shutil.which("node") is None and not args.no_report:
        print("node is not on PATH; pass --no-report to build the engine files only", file=sys.stderr)
        return 2
    if args.check:
        return check(report=not args.no_report, pdf=not args.no_pdf)
    return build(report=not args.no_report, pdf=not args.no_pdf)


if __name__ == "__main__":
    sys.exit(main())
