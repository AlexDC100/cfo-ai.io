// cmdbarSources.ts — THE ONLY readers the command bar uses on a served
// period body (GET /api/period/{id}). The browser twin of
// src/engine/attention/sources.py, and for the same reason:
//
// Two figures are being redefined by parallel lanes while this bar ships,
// so each has exactly ONE reader here and nothing else in the bar touches
// the underlying fields:
//
//   EBITDA          `servedEbitda` returns the served `assembled_pl.ebitda`
//                   and its typed refusal. The 711/722 ruling moves the
//                   definition (711 and 722 inside EBITDA, outside
//                   turnover) and adds `assembled_pl.ebitda_refusal` when
//                   the stock variation cannot be measured; the day it
//                   lands, THIS function is the one place that learns it.
//
//   INVENTORY DAYS  `inventoryDays` returns today's served ratio-table
//                   `dio` row with the basis it is computed on and the
//                   claim policy that follows from it (a year-end snapshot
//                   on one basis may NOT be called slow or fast). When
//                   `assembled_metrics.inventory_days` (inventory_days/1)
//                   is served, it is read instead, with its own policy.
//
// Also the account-121 rule: the net result is "din contul 121" only when
// the served anchor status says it IS account 121.
//
// Pure. No arithmetic: every value returned is a served value or null
// with the served reason.

import type { PeriodApiResponse } from "@/lib/activePeriod";
import type { RatioTableRow } from "@/lib/ratioTable";

export interface ServedReason {
  code: string;
  inputs?: unknown[];
}

type Body = Pick<PeriodApiResponse, "statements"> & {
  assembled_metrics?: Record<string, unknown> | null;
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pl(body: Body | null | undefined): Record<string, unknown> {
  const st = body?.statements as unknown;
  const p = isObj(st) ? st.assembled_pl : null;
  return isObj(p) ? p : {};
}

function bs(body: Body | null | undefined): Record<string, unknown> {
  const st = body?.statements as unknown;
  const b = isObj(st) ? st.assembled_bs : null;
  return isObj(b) ? b : {};
}

export interface ServedFigure {
  value: number | null;
  refusal: ServedReason | null;
  /** The served path the value was read from. */
  source: string;
}

/** EBITDA as served, or its typed refusal. Never 0 for an absent figure. */
export function servedEbitda(body: Body | null | undefined): ServedFigure {
  const p = pl(body);
  const refusal = p.ebitda_refusal;
  if (isObj(refusal) && typeof refusal.code === "string" && refusal.code) {
    return {
      value: null,
      refusal: { code: refusal.code, inputs: Array.isArray(refusal.inputs) ? refusal.inputs : [] },
      source: "assembled_pl.ebitda",
    };
  }
  const value = num(p.ebitda);
  return value === null
    ? { value: null, refusal: { code: "ebitda_absent", inputs: ["assembled_pl.ebitda"] }, source: "assembled_pl.ebitda" }
    : { value, refusal: null, source: "assembled_pl.ebitda" };
}

/** Net-result statuses that mean "this IS account 121". Mirrors
 *  packs/serving/attention.yaml `anchor_statuses`. */
export const ANCHOR_STATUSES: readonly string[] = ["anchored", "within_tolerance"];

export function anchorStatus(body: Body | null | undefined): string | null {
  const s = pl(body).net_income_anchor_status;
  return typeof s === "string" ? s : null;
}

/** The net result the bar may print: the served statutory figure, and only
 *  when the served anchor says it is account 121. Otherwise a refusal
 *  naming the status — never the reconstructed (metrics[]) figure. */
export function servedNetResult(body: Body | null | undefined): ServedFigure & { anchor: string | null } {
  const anchor = anchorStatus(body);
  const value = num(pl(body).net_income_statutory);
  if (!anchor || !ANCHOR_STATUSES.includes(anchor)) {
    return {
      value: null,
      refusal: { code: "net_result_not_account_121", inputs: [anchor ?? "absent"] },
      source: "assembled_pl.net_income_statutory",
      anchor,
    };
  }
  if (value === null) {
    return {
      value: null,
      refusal: { code: "net_result_absent", inputs: ["assembled_pl.net_income_statutory"] },
      source: "assembled_pl.net_income_statutory",
      anchor,
    };
  }
  return { value, refusal: null, source: "assembled_pl.net_income_statutory", anchor };
}

/** A money line of the served statements (`assembled_pl.<field>` /
 *  `assembled_bs.<field>`) — the SAME path the comparatives column reads
 *  (src/engine/comparatives/lines.py), so the value printed before the
 *  comparison lands is the column's `current` once it does. */
export function servedLine(body: Body | null | undefined, statement: "pl" | "bs", field: string): ServedFigure {
  const value = num((statement === "pl" ? pl(body) : bs(body))[field]);
  const source = `assembled_${statement}.${field}`;
  return value === null
    ? { value: null, refusal: { code: "line_absent", inputs: [source] }, source }
    : { value, refusal: null, source };
}

// ── Ratios: assembled_metrics.ratio_table ONLY ──────────────────────────

/** The served ratio-table rows by key. NEVER `metrics[]`: on the corpus the
 *  two disagree (current ratio 1.1601 vs the table's 1.15, the net result
 *  36,267,963.64 vs account 121's 36,787,352.75), and the table is the
 *  one the Ratios tab, the report and the workbook print. */
export function ratioTableRows(body: Body | null | undefined): Map<string, RatioTableRow> {
  const am = body?.assembled_metrics;
  const table = isObj(am) ? am.ratio_table : null;
  const rows = isObj(table) && Array.isArray(table.rows) ? table.rows : [];
  const out = new Map<string, RatioTableRow>();
  for (const r of rows) {
    if (isObj(r) && typeof r.key === "string") out.set(r.key, r as unknown as RatioTableRow);
  }
  return out;
}

// ── Inventory days: ONE reader ─────────────────────────────────────────

export interface InventoryClaimPolicy {
  may_call_slow: boolean;
  requires: string[];
  reason: string;
}

/** What today's served inventory-days figure may claim (owner ruling on
 *  inventory days, point 5): quoted with its basis, never slow or fast. */
export const INVENTORY_DAYS_SNAPSHOT_POLICY: InventoryClaimPolicy = Object.freeze({
  may_call_slow: false,
  requires: ["split_by_stock_type", "average_balance"],
  reason: "single_basis_year_end_snapshot",
}) as InventoryClaimPolicy;

export interface InventoryDays {
  /** The served ratio-table row when that is the source (printed through
   *  the ratio printer); null when the served block is the source. */
  row: RatioTableRow | null;
  /** The served block's total when that is the source. */
  total: { value: number | null; value_q: string | null } | null;
  /** Which basis the figure is on — printed beside it, always. */
  basis: "ratio_table_dio_snapshot" | string | null;
  source: string;
  claimPolicy: InventoryClaimPolicy;
  reason: ServedReason | null;
}

export function inventoryDays(body: Body | null | undefined): InventoryDays {
  const am = body?.assembled_metrics;
  const block = isObj(am) ? am.inventory_days : null;
  if (isObj(block) && typeof block.schema === "string" && block.schema.startsWith("inventory_days/")) {
    const total = isObj(block.total) ? block.total : {};
    const policy = isObj(block.claim_policy) ? (block.claim_policy as unknown as InventoryClaimPolicy) : INVENTORY_DAYS_SNAPSHOT_POLICY;
    return {
      row: null,
      total: { value: num(total.value), value_q: typeof total.value_q === "string" ? total.value_q : null },
      basis: typeof block.basis === "string" ? block.basis : null,
      source: "assembled_metrics.inventory_days",
      claimPolicy: policy,
      reason: isObj(total.reason) && typeof total.reason.code === "string" ? (total.reason as unknown as ServedReason) : null,
    };
  }
  const row = ratioTableRows(body).get("dio") ?? null;
  if (!row) {
    return {
      row: null, total: null, basis: null,
      source: "assembled_metrics.ratio_table.dio",
      claimPolicy: INVENTORY_DAYS_SNAPSHOT_POLICY,
      reason: { code: "inventory_days_absent", inputs: ["assembled_metrics.ratio_table.dio"] },
    };
  }
  return {
    row,
    total: null,
    basis: "ratio_table_dio_snapshot",
    source: "assembled_metrics.ratio_table.dio",
    claimPolicy: INVENTORY_DAYS_SNAPSHOT_POLICY,
    reason: null,
  };
}
