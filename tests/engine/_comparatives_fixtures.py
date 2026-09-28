"""Real served-shape envelopes for the comparatives gates, built from the
committed corpus through the offline reference path.

WHY NOT THE REGRESSION BASELINES. `regression_baselines/*.json` were
captured before the assembler emitted `other_operating_income` — the
term its EBITDA is built from — so a bridge that walks the assembler's
own identity cannot be verified against them. The corpus books are run
through `RomaniaPack.run_deterministic_tb` HERE, at test time, so every
envelope carries exactly what today's assembler emits, and a field the
assembler stops emitting reds the gate instead of being silently absent
from a stale fixture.

The pair is chosen by MEASUREMENT, not by name: the first corpus book the
pack classifies ANALYTIC and the first it classifies SYNTHETIC. If the
corpus ever loses one kind, the gates that need the pair skip with the
reason rather than pass over one book compared with itself.

THE ENVELOPES ARE SERVED-SHAPED. The assembler emits `canonical_bucket`
beside every line item; `pipeline.stage_persist` strips it (not a
`statement_line_items` column) and `GET /api/period` serves the persisted
legacy `bucket` alone. Every envelope built here drops the field exactly
as the persist step does, so a gate over these envelopes reads what
production reads. Measured 2026-09-26: with the assembler's field left on,
the depth-parity gate stayed green (63 passed) while the real client pair
served nine bucket-backed lines "neither period reported" — the gate's
coverage was fed by a key production never carries.
"""
from __future__ import annotations

import copy
from collections import OrderedDict
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from engine.country_packs.ro_romania.chart_of_accounts import bucket_for
from engine.country_packs.ro_romania.detail_level import (
    ANALYTIC,
    SYNTHETIC,
    SYNTHETIC_MAX_DIGITS,
    account_code_depth,
    classify_detail_level,
)
from engine.country_packs.ro_romania.pack import RomaniaPack
from engine.country_packs.ro_romania.trial_balance_parser import (
    TrialBalanceParseResult,
)

REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "corpus"

#: Real, anonymised, deterministic-lane xlsx books. Order is the pick order.
CANDIDATES = (
    "saga_10_col_carniprod",
    "saga_10_col",
    "saga_10_col_agras",
    "saga_10_col_retail",
    "saga_10_col_realestate",
    "saga_compact_6_col",
    "exact_zero",
    "rounding_004pct",
)

#: The real (anonymised) full-ledger books: every one is kept deeper than
#: the synthetic boundary, so each has a condensed counterpart to derive.
#: The depth-parity gate pairs every ordered pair of these and each one
#: against its own re-aggregation.
REAL_BOOKS = (
    "saga_10_col_carniprod",
    "saga_10_col",
    "saga_10_col_agras",
    "saga_10_col_retail",
    "saga_10_col_realestate",
)

_CACHE: Dict[str, Dict[str, Any]] = {}
_REAGG_CACHE: Dict[str, Tuple[Dict[str, Any], int]] = {}

#: The eight figure columns of a parsed 10-column row.
_FIGURE_FIELDS = ("si_d", "si_c", "r_d", "r_c", "st_d", "st_c", "sf_d", "sf_c")


#: What `pipeline.stage_persist` keeps of a line item — the
#: `statement_line_items` columns. `canonical_bucket` is not among them.
PERSISTED_LINE_ITEM_KEYS = frozenset({
    "statement", "bucket", "ro_account_code", "ro_account_name",
    "amount", "is_derived",
})


def served_line_item(item: Dict[str, Any]) -> Dict[str, Any]:
    """One line item as `GET /api/period` serves it: the persisted columns
    only. The assembler's `canonical_bucket` (and any other in-memory
    field, e.g. `via_semantic_fallback`) is dropped here exactly as the
    persist step drops it."""
    return dict((k, v) for k, v in item.items() if k in PERSISTED_LINE_ITEM_KEYS)


def _envelope_of(assembled: Dict[str, Any]) -> Dict[str, Any]:
    statements = dict(assembled["statements"])
    cv1 = assembled.get("assembled_canonical_v1") or {}
    statements["assembled_canonical_v1"] = cv1
    if isinstance(cv1, dict) and cv1.get("canonical_bs"):
        statements["canonical_bs"] = cv1["canonical_bs"]
    return {"statements": statements,
            "lineItems": [served_line_item(li) for li in assembled["lineItems"]]}


def envelope_for(case_id: str) -> Dict[str, Any]:
    """`{"statements": …, "lineItems": …}` for one corpus case, through the
    offline path — the same assembler the served path runs."""
    if case_id not in _CACHE:
        path = CORPUS / case_id / "input.xlsx"
        data = path.read_bytes()
        assembled = RomaniaPack().run_deterministic_tb(data, filename=path.name)[2]
        _CACHE[case_id] = _envelope_of(assembled)
    return copy.deepcopy(_CACHE[case_id])


_CONDENSED_ROWS_CACHE: Dict[str, Tuple[List[Dict[str, Any]], Dict[str, Any], Dict[str, Any], int]] = {}


def condensed_tb_rows(case_id: str) -> Tuple[TrialBalanceParseResult, int]:
    """The parsed rows of one corpus book folded to the synthetic boundary
    — what an external condensed balanță of the same book would print.

    Rows are merged on the first `SYNTHETIC_MAX_DIGITS` digits of the
    code (separators stripped exactly as the detail-level detector strips
    them), each of the eight figure columns summed in cents — debit and
    credit balances kept on their own sides, as a real condensed book
    keeps them. Exposed on its own so a gate can carry the SAME rows
    through the production write seam (`stage_map` -> `stage_persist`)
    and read them back through the served route, not only through the
    offline assembler (`reaggregate_to_synthetic`).

    Returns `(rows, merged_row_count)`; the rows are a fresh
    `TrialBalanceParseResult` each call. A book already at the boundary
    merges zero rows and comes back as itself.
    """
    if case_id not in _CONDENSED_ROWS_CACHE:
        pack = RomaniaPack()
        path = CORPUS / case_id / "input.xlsx"
        tb_rows = pack.parse_trial_balance(path.read_bytes(), path.name)
        agg = OrderedDict()  # type: OrderedDict[str, Dict[str, Any]]
        merged = 0
        for row in tb_rows:
            code = str(row.get("cont") or "")
            depth = account_code_depth(code)
            if depth is None:
                key = code
            else:
                digits = "".join(ch for ch in code if ch.isdigit())
                key = digits[:SYNTHETIC_MAX_DIGITS]
            if key not in agg:
                merged_row = dict(row)
                merged_row["cont"] = key
                for f in _FIGURE_FIELDS:
                    merged_row[f] = Decimal(str(row.get(f) or 0))
                agg[key] = merged_row
            else:
                merged += 1
                for f in _FIGURE_FIELDS:
                    agg[key][f] += Decimal(str(row.get(f) or 0))
        rows = []
        for merged_row in agg.values():
            for f in _FIGURE_FIELDS:
                merged_row[f] = float(
                    merged_row[f].quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
            rows.append(merged_row)
        _CONDENSED_ROWS_CACHE[case_id] = (
            rows,
            dict(getattr(tb_rows, "extraction", None) or {}),
            dict(getattr(tb_rows, "source_anchor", None) or {}),
            merged,
        )
    rows, extraction, source_anchor, merged = _CONDENSED_ROWS_CACHE[case_id]
    condensed = TrialBalanceParseResult(
        [dict(r) for r in rows],
        extraction=dict(extraction),
        source_anchor=dict(source_anchor),
    )
    return condensed, merged


def reaggregate_to_synthetic(case_id: str) -> Tuple[Dict[str, Any], int]:
    """The same book as the external condensed balanță would print it,
    assembled offline: the folded rows of `condensed_tb_rows` run through
    the SAME post-parse assembler (`assemble_parsed_tb`) the pipeline
    runs. Nothing here touches a statement figure: the condensed book's
    figures are whatever the assembler makes of the condensed rows, so a
    comparison against the original is a comparison of two assemblies,
    not of one assembly and a hand-edited copy of it.

    Returns `(envelope, merged_row_count)`.
    """
    if case_id not in _REAGG_CACHE:
        condensed, merged = condensed_tb_rows(case_id)
        assembled = RomaniaPack().assemble_parsed_tb(condensed)[2]
        _REAGG_CACHE[case_id] = (_envelope_of(assembled), merged)
    env, merged = _REAGG_CACHE[case_id]
    return copy.deepcopy(env), merged


def level_of(env: Dict[str, Any]) -> str:
    return classify_detail_level([li.get("ro_account_code") for li in env["lineItems"]]).level


def pick_pair() -> Tuple[Optional[Tuple[str, Dict[str, Any]]], Optional[Tuple[str, Dict[str, Any]]]]:
    """(analytic, synthetic) — each `(case_id, envelope)` or None."""
    analytic = synthetic = None
    for cid in CANDIDATES:
        if not (CORPUS / cid / "input.xlsx").is_file():
            continue
        env = envelope_for(cid)
        lvl = level_of(env)
        if analytic is None and lvl == ANALYTIC:
            analytic = (cid, env)
        elif synthetic is None and lvl == SYNTHETIC:
            synthetic = (cid, env)
        if analytic and synthetic:
            break
    return analytic, synthetic


def condense(envelope: Dict[str, Any], revenue_factor: float = 0.97) -> Dict[str, Any]:
    """The external condensed book derived from an analytic one: codes
    rolled to the synthetic boundary, the doubtful-receivable row folded
    into trade receivables, and — because a real prior is a different
    YEAR — net turnover moved with the P&L chain re-derived through the
    assembler's own identities so they still hold."""
    out = copy.deepcopy(envelope)
    for li in out["lineItems"]:
        code = str(li.get("ro_account_code") or "")
        rule = bucket_for(code) if code else None
        if code.isdigit():
            li["ro_account_code"] = code[:SYNTHETIC_MAX_DIGITS]
        # The condensed chart carries no "clienți incerți" row: the balance
        # sits in 4111. The envelope is served-shaped (legacy `bucket`
        # only), so the doubtful row is found by the pack's rule for its
        # code — and its CODE is folded too, or the served-shape reader
        # would derive `ar_doubtful` straight back from 4118.
        if (li.get("canonical_bucket") or (rule.bucket if rule else li.get("bucket"))) == "ar_doubtful":
            li.pop("canonical_bucket", None)
            li["ro_account_code"] = "4111"
            li["bucket"] = "ar"
    out["statements"]["assembled_bs"]["ar_doubtful_gross"] = 0.0
    pl = out["statements"]["assembled_pl"]
    pl["revenue"] = round(pl["revenue"] * revenue_factor, 2)
    # The one EBITDA (owner ruling 2026-09-26): net 72x and the measured net
    # 711 inside; the unexplained remainder vs account 121 kept as it was.
    net_72x = pl["capitalized_own_work"]["value"]
    net_711 = pl["inventory_variation"]["value"]
    unexplained = pl.get("net_income_unexplained_vs_121") or 0.0
    pl["ebitda_before_stock_variation"] = round(
        pl["revenue"] + pl["other_operating_income"] - pl["cogs"] - pl["opex_total"], 2)
    pl["ebitda"] = round(pl["ebitda_before_stock_variation"] + net_72x + net_711, 2)
    pl["ebit"] = round(pl["ebitda"] - pl["depreciation"], 2)
    pl["pretax"] = round(pl["ebit"] + pl["net_financial_result"], 2)
    pl["net_income_operational"] = round(
        pl["ebitda_before_stock_variation"] - pl["depreciation"] + pl["net_financial_result"] - pl["tax"], 2)
    pl["net_income_statutory"] = round(pl["pretax"] - pl["tax"] + unexplained, 2)
    return out


#: A served `industry_signal` that blocks sector content — the shape
#: `engine.industry.build_industry_signal` serves when the account mix
#: disputes the workspace industry. Planted on ONE side by the sector
#: withholding gate.
BLOCKING_INDUSTRY_SIGNAL: Dict[str, Any] = {
    "agreement": "disputed",
    "verdict": "the account mix does not read as the workspace industry",
    "block_sector_content": True,
}


def served_payload(env: Dict[str, Any], period_id: str, period_end: str, *,
                   metrics: Optional[List[Dict[str, Any]]] = None,
                   industry_signal: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The `/api/period/{id}` shape the route core reads.

    `metrics` defaults to the rows `stage_compute` persists for this book
    (`compute_period_metrics` over its statements) — what a period analysed
    by the pipeline carries. Pass `metrics=[]` for a period with no
    persisted rows (a prior persisted before the metrics existed)."""
    from engine.ratios.credit_model import compute_period_metrics

    # The served route attaches THE inventory-days block to every period it
    # serves (pipeline._attach_inventory_days_block, owner spec 2026-09-26
    # P1): built here by the same code object over the same evidence, on a
    # year that runs from 1 January to `period_end`, so the payload is the
    # route's. Every metric row and ratio-table row on inventory days reads it.
    from engine.api import pipeline as P
    from engine.ratios import inventory_days as ID

    statements = dict(env["statements"])
    row = {"period_end": period_end, "period_start": period_end[:4] + "-01-01",
           "assembled_canonical_v1": statements.get("assembled_canonical_v1")}
    view = dict(statements, supplementary=dict(statements.get("supplementary") or {},
                                               **P._served_supplementary(row)))
    statements["inventory_days"] = ID.build_for_statements(
        view, period_row=row, line_items=list(env["lineItems"]))
    if metrics is None:
        metrics = compute_period_metrics(copy.deepcopy(statements))
    payload = {
        "statements": statements,
        "line_items": env["lineItems"],
        "metrics": metrics,
        "period": {"id": period_id, "period_end": period_end, "currency": "RON"},
        "industry_signal": industry_signal,
    }
    cv1 = env["statements"].get("assembled_canonical_v1")
    if isinstance(cv1, dict) and isinstance(cv1.get("pack_provenance"), dict):
        payload["pack_provenance"] = cv1["pack_provenance"]
    return payload
