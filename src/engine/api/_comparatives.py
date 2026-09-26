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

import functools
from dataclasses import asdict
from typing import Any, Dict, List, Mapping, Optional

from engine.comparatives import build_comparative_columns
from engine.comparatives.analysis import bs_bridge, canonical_totals, common_size, movers, pl_bridge
# The synthetic/analytic boundary is a chart-of-accounts fact and lives in
# the pack. Today every served period is a Romanian book; when a second
# pack lands it exposes its own detector and this import becomes a
# pack lookup.
from engine.country_packs.ro_romania.detail_level import classify_detail_level
# The Piotroski checks are the pack's; the jurisdiction-blind composer takes
# them as an argument rather than importing a pack.
from engine.country_packs.ro_romania.chart_of_accounts import (
    _piotroski_checks,
    canonical_bucket_of_line_item,
)
from engine.comparatives.ratio_compare import compare_ratio_tables
# The seven-element band-crossing findings, injected the same way.
from engine.api.findings.c_bands import build_band_findings

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
    served line items under `lineItems` (coverage is read off them).

    THE SERVED SHAPE HIDES THE FINE BUCKETS. `GET /api/period` serves
    each line item with the persisted `bucket` only — the legacy name
    `stage_persist` was allowed to write (`interest_income` as
    `financialIncome`, `ar_intercompany` as `otherCurrentAssets`, `cash_fx`
    as `cash`, `ppe_under_construction` / `ppe_advances` as `ppe`,
    `ap_dividends` as `otherCurrentLiab`, `ar_doubtful` as `ar`,
    `opex_third_party` as `operatingExpenses`); the assembler's
    `canonical_bucket` is stripped before the insert. Coverage matched on
    those names never met a fine bucket, so on the real client pair nine
    lines were served "neither period reported" beside non-zero served
    fields and the movers ranked without a related-party movement above
    their own floor (diagnosed 2026-09-26). Each served item is therefore re-read here
    through the pack's own rule for its account code —
    `canonical_bucket_of_line_item`, the reading the pipeline's reassembly
    loops make — and carries the canonical name beside the persisted one.
    Copies: the payload's own `line_items` (served back as
    `prior_line_items`) are not touched. Every served period today is a
    Romanian book, like the detail-level detector above; a second pack
    exposes its own reader and this becomes a pack lookup.
    """
    statements = payload.get("statements")
    if not isinstance(statements, Mapping):
        raise ComparativesRefused(
            "period_not_servable",
            "the period payload carries no statements block", status=409)
    items = []  # type: List[Dict[str, Any]]
    for li in payload.get("line_items") or []:
        if not isinstance(li, Mapping):
            continue
        item = dict(li)
        if not item.get("canonical_bucket"):
            bucket = canonical_bucket_of_line_item(item)
            if bucket:
                item["canonical_bucket"] = bucket
        items.append(item)
    return {"statements": statements, "lineItems": items}


def detail_level_of(payload: Mapping[str, Any]):
    items = list(payload.get("line_items") or [])
    codes = [li.get("ro_account_code") for li in items if isinstance(li, Mapping)]
    return classify_detail_level(codes, row_count=len(items))


def _source_document_of(payload: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """The document the served period's figures were read from, as
    `GET /api/period` names it (`period.source_document`). Served beside
    each column so a reader can see WHICH FILE a compare column holds.

    Why: a period is a slot in a workspace, and `stage_persist`'s
    same-month replace re-points the slot at whatever was uploaded for
    that month last — on 2026-09-22 another company's balanță took over
    a client's Dec 2025 period, and the compare column then printed that
    book's revenue (2,727,103.68, the `eei_dec_2025` baseline to the
    cent) under the client's label with nothing on screen naming the
    file. This is not an identity wall — that needs a persisted fiscal
    code, the workspace lane's work — it is the fact the reader can
    check. None when the payload carries no document block."""
    period = payload.get("period")
    if not isinstance(period, Mapping):
        return None
    doc = period.get("source_document")
    if not isinstance(doc, Mapping):
        return None
    return {
        "id": doc.get("id"),
        "filename": doc.get("filename"),
        "detected_type": doc.get("detected_type"),
    }


def _period_block(row: Mapping[str, Any], payload: Mapping[str, Any], level) -> Dict[str, Any]:
    statements = payload.get("statements") or {}
    return {
        "source_document": _source_document_of(payload),
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


def snapshot_id_of(row: Mapping[str, Any]) -> Optional[str]:
    """The period's snapshot id: its envelope's content hash, never
    `updated_at`. The same reading as `engine.api._radar.content_hash_of`
    (not imported: that module pulls the whole radar lane into a route
    core); `tests/engine/test_comparatives_bands.py` holds the two equal."""
    value = row.get("snapshot_hash")
    if value:
        return str(value)
    envelope = row.get("assembled_canonical_v1")
    if isinstance(envelope, Mapping):
        provenance = envelope.get("provenance") or {}
        if isinstance(provenance, Mapping) and provenance.get("content_hash"):
            return str(provenance["content_hash"])
    return None


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
        # Through the serving gateway, never the raw snapshot totals.
        "facts": canonical_totals(cbs, (payload.get("statements") or {}).get("currency")),
        "status": cbs.get("status"),
    }


def compare_payloads(
    current_payload: Mapping[str, Any],
    prior_payload: Mapping[str, Any],
    *,
    current_row: Mapping[str, Any],
    prior_row: Mapping[str, Any],
    caen: Optional[str] = None,
) -> Dict[str, Any]:
    """Everything the comparative surfaces render, JSON-ready.

    `caen` is the workspace's CAEN code (`_org.caen_for_org`, read by the
    route): the band findings' company profile is qualified by it exactly
    as the single-period lanes qualify theirs. None when the workspace has
    none — the profile then says it resolved from structure.

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
    # The two-period ratio block (engine.comparatives.ratio_compare): both
    # periods' ratios, bands, deltas, movements and credit composites,
    # computed from these two served payloads under one model revision.
    ratios = compare_ratio_tables(
        current_payload, prior_payload,
        current_label=str(cur_block["label"]), prior_label=str(pri_block["label"]),
        piotroski_checks=_piotroski_checks,
        # Read off the module at call time, so a gate that wraps the
        # builder still sees this call; the CAEN rides along.
        band_findings=functools.partial(build_band_findings, caen=caen),
        current_period_id=current_row.get("id"), prior_period_id=prior_row.get("id"),
        current_snapshot_id=snapshot_id_of(current_row),
        prior_snapshot_id=snapshot_id_of(prior_row),
    )
    return {
        "ratios": ratios,
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
