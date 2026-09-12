"""Two periods of ONE workspace, side by side — the route's core and its wall.

THE WALL. Both period ids arrive from the browser (`?period=` and the
prior the user picked). Each is loaded with the caller's organization IN
THE FILTER — `financial_periods` by `id` AND `org_id` — never by id alone
with a membership check somewhere earlier. A period the caller's
workspace does not own is simply not found (`period_not_in_workspace`),
which is also what stops a user with two workspaces from putting one
company's year beside another company's: the prior must live in the
SAME workspace as the current period, not merely in some workspace the
caller belongs to.

THE ENVELOPES. The route calls the served period reader — the very
function `/api/period/{id}` runs — once per side, so what is compared is
byte-for-byte what the dashboard renders. There is no second assembly
here to drift from the first.

THE RULES are `engine.comparatives`': detail level per period from the
chart the pack owns; comparison struck at the level both books carry;
absent is not zero; a zero base yields no percentage; a figure only one
depth can carry never moves against the other. This module only plumbs.
"""
from __future__ import annotations

from dataclasses import asdict
from typing import Any, Dict, List, Mapping, Optional

from engine.comparatives import build_comparative_columns
from engine.comparatives.analysis import bs_bridge, common_size, movers, pl_bridge
# The synthetic/analytic boundary is a chart-of-accounts fact and lives in
# the pack. Today every served period is a Romanian book; when a second
# pack lands it exposes its own detector and this import becomes a
# pack lookup.
from engine.country_packs.ro_romania.detail_level import classify_detail_level

__all__ = [
    "ComparativesRefused",
    "load_period_in_org",
    "envelope_from_payload",
    "detail_level_of",
    "compare_payloads",
]


class ComparativesRefused(Exception):
    """A typed refusal the route maps to an HTTP status."""

    def __init__(self, code: str, message: str, status: int = 404) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def load_period_in_org(client: Any, period_id: str, *, org_id: str) -> Dict[str, Any]:
    """The period row, or a refusal. `org_id` is REQUIRED and is in the
    filter: the database answers "no such period in this workspace", and
    nothing here ever holds a row from another tenant, even briefly."""
    if not period_id or not org_id:
        raise ComparativesRefused("period_not_in_workspace",
                                  "period %r is not in this workspace" % (period_id,))
    rows = client.select(
        "financial_periods",
        filters={"id": "eq.%s" % period_id, "org_id": "eq.%s" % org_id},
        single=True,
    )
    if not rows:
        raise ComparativesRefused("period_not_in_workspace",
                                  "period %r is not in this workspace" % (period_id,))
    return rows[0]


def envelope_from_payload(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """The shape `engine.comparatives` reads: `statements` plus the
    served line items under `lineItems` (coverage is read off them)."""
    statements = payload.get("statements")
    if not isinstance(statements, Mapping):
        raise ComparativesRefused(
            "period_not_servable",
            "the period payload carries no statements block", status=409)
    return {"statements": statements, "lineItems": list(payload.get("line_items") or [])}


def detail_level_of(payload: Mapping[str, Any]):
    items = list(payload.get("line_items") or [])
    codes = [li.get("ro_account_code") for li in items if isinstance(li, Mapping)]
    return classify_detail_level(codes, row_count=len(items))


def _period_block(row: Mapping[str, Any], payload: Mapping[str, Any], level) -> Dict[str, Any]:
    statements = payload.get("statements") or {}
    return {
        "period_id": row.get("id"),
        "period_end": row.get("period_end"),
        "period_start": row.get("period_start"),
        "currency": row.get("currency") or statements.get("currency"),
        "label": statements.get("periodLabel") or row.get("period_end"),
        "company_name": statements.get("companyName"),
        "detail_level": {
            "level": level.level,
            "modal_depth": level.modal_depth,
            "reason": level.reason,
            "signals": asdict(level.signals),
        },
    }


def _canonical_bs_rows(payload: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """The prior period's canonical balance sheet, keyed for pairing by
    row id — the ids are stable leaf names, so the current period's rows
    find their opening figure without any account-code arithmetic."""
    cbs = (payload.get("statements") or {}).get("canonical_bs")
    if not isinstance(cbs, Mapping):
        return None
    rows = {}
    for row in cbs.get("rows") or []:
        if not isinstance(row, Mapping) or not row.get("id"):
            continue
        rows[str(row["id"])] = {
            "amount": row.get("amount"),
            "section": row.get("section"),
            "label": row.get("label"),
        }
    sections = {}
    for sec in cbs.get("sections") or []:
        if isinstance(sec, Mapping) and sec.get("id") is not None:
            sections[str(sec["id"])] = sec.get("subtotal")
    return {
        "rows": rows,
        "sections": sections,
        "totals": dict(cbs.get("totals") or {}),
        "status": cbs.get("status"),
    }


def compare_payloads(
    current_payload: Mapping[str, Any],
    prior_payload: Mapping[str, Any],
    *,
    current_row: Mapping[str, Any],
    prior_row: Mapping[str, Any],
) -> Dict[str, Any]:
    """Everything the comparative surfaces render, JSON-ready.

    Pure over its inputs: no clock, no I/O. Same payloads in, same
    document out."""
    cur_env = envelope_from_payload(current_payload)
    pri_env = envelope_from_payload(prior_payload)
    cur_level = detail_level_of(current_payload)
    pri_level = detail_level_of(prior_payload)

    cur_block = _period_block(current_row, current_payload, cur_level)
    pri_block = _period_block(prior_row, prior_payload, pri_level)

    table = build_comparative_columns(
        cur_env, pri_env, cur_level.level, pri_level.level,
        current_label=str(cur_block["label"]), prior_label=str(pri_block["label"]),
    )
    pl_b = pl_bridge(cur_env, pri_env, table)
    bs_assets, bs_le = bs_bridge(cur_env, pri_env, table)
    mv = movers(table)
    cs = common_size(table)

    prior_statements = prior_payload.get("statements") or {}
    return {
        "current": cur_block,
        "prior": pri_block,
        "comparability": asdict(table.comparability),
        "coverage_source": {
            "current": table.current_coverage_source,
            "prior": table.prior_coverage_source,
        },
        "columns": [asdict(c) for c in table.columns],
        "common_size": [asdict(r) for r in cs],
        "bridges": {
            "pl": asdict(pl_b),
            "bs_assets": asdict(bs_assets),
            "bs_liabilities_equity": asdict(bs_le),
        },
        "movers": asdict(mv),
        # For the balance-sheet view: the prior period's canonical rows by
        # id, so the current rows can carry an opening column that was
        # actually measured.
        "prior_canonical_bs": _canonical_bs_rows(prior_payload),
        # For the report / workbook exports and the like-for-like ratio and
        # cash-flow columns: the prior period's served statements block,
        # verbatim, and its line items.
        "prior_statements": prior_statements,
        "prior_line_items": list(prior_payload.get("line_items") or []),
        # The prior period's calculated_metrics rows — the ratio tab reads
        # ebitda_margin / net_margin / net_income_statutory off these for
        # the current period, so the prior column must be built the same
        # way or the two ratios are not the same ratio.
        "prior_metrics": list(prior_payload.get("metrics") or []),
    }
