// commonSize.ts — ONE PERIOD'S SHARES, AS THE ENGINE SERVED THEM.
//
// OWNER RULING (2026-10-04): "'% din venituri' must work for a single year
// without a comparison. Engine change, with a gate."
//
// The share column ("% of revenue" on the P&L, "% of total assets" on the
// balance sheet) used to exist only inside the two-period comparatives
// document, so a company with one year on file — or its earliest year on
// screen — had none. The engine now serves the period's OWN shares on the
// period payload: `statements.common_size`, schema `common_size/1`
// (src/engine/api/_comparatives.py `common_size_block`), computed by the one
// function the comparison's two sides run. Every registry line of net
// turnover / total assets, and — when the period carries the canonical
// balance sheet — every canonical row, section subtotal and grand total
// (`bs.row.<id>`, `bs.section.<id>`, `bs.total.assets`,
// `bs.total.equity_plus_liabilities`).
//
// THIS MODULE READS THAT BLOCK AND COMPUTES NOTHING. No amount is divided,
// multiplied or rounded here (gate single-year-share reads the source): the
// one printer of a share is `formatShare` (lib/comparatives.ts), over the
// served fraction.
//
// THREE RULES THE VIEWS INHERIT FROM HERE.
//
// 1. A SHARE IS PRINTED ONLY UNDER THE SHARE STATUS. A row the engine
//    refused, did not disclose, reported absent, or struck against a base
//    below the zero floor has NO share and says why — never 0 %. The rule is
//    applied where the block is read: whatever number such a row carries in
//    its `share` field is dropped.
//
// 2. THE ROW GUARD STAYS. A statement row carries the engine's share only if
//    the amount the row shows IS the block's `current` for that key, to the
//    cent — the comparison's own guard (`rowIsEngineFigure`). Otherwise the
//    cell stays blank and says the row is built another way.
//
// 3. A PAYLOAD WITHOUT THE BLOCK HAS NO SHARE COLUMN OF ITS OWN. An engine
//    that predates the block, a sample dataset, a period the engine could not
//    re-assemble: `readCommonSize` answers null, the share box is off with a
//    reason, and nothing is computed in its place.

import { BS_TOTAL_ASSETS_SHARE_KEY } from "@/lib/bsStructure";
import { engineKeyForRow, rowIsEngineFigure } from "@/lib/comparatives";

/** The schema family this reader understands. */
export const COMMON_SIZE_SCHEMA_PREFIX = "common_size/";

/** The statuses the engine serves (engine.comparatives.analysis). */
export const COMMON_SIZE_STATUSES = [
  "share",
  "no_base",
  "absent",
  "refused",
  "not_disclosed_at_this_detail_level",
] as const;

/** `unknown` is a status this build has no word for: it carries no share and
 *  reads the general "not available" reason. */
export type CommonSizeStatus = (typeof COMMON_SIZE_STATUSES)[number] | "unknown";

export interface CommonSizeRow {
  key: string;
  statement: "PL" | "BS";
  baseKey: string;
  /** The amount the share was struck from, to the cent — what the row guard
   *  compares. Null unless the period reported the line. */
  current: number | null;
  /** A FRACTION of the base (0.636807 = 63.7 %), as served. Non-null only
   *  under status "share". */
  share: number | null;
  status: CommonSizeStatus;
}

export interface CommonSizeBlock {
  schema: string;
  rows: ReadonlyMap<string, CommonSizeRow>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const finiteOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const statusOf = (v: unknown): CommonSizeStatus =>
  (COMMON_SIZE_STATUSES as readonly unknown[]).includes(v) ? (v as CommonSizeStatus) : "unknown";

/**
 * The period's own share block off a served `statements` object, or null:
 * no block, another schema family, or a shape this build cannot read. A row
 * that is not an object with a key and a statement is skipped — never
 * guessed.
 */
export function readCommonSize(statements: unknown): CommonSizeBlock | null {
  const block = isRecord(statements) ? statements.common_size : undefined;
  if (!isRecord(block)) return null;
  const schema = block.schema;
  if (typeof schema !== "string" || !schema.startsWith(COMMON_SIZE_SCHEMA_PREFIX)) return null;
  if (!Array.isArray(block.rows)) return null;
  const rows = new Map<string, CommonSizeRow>();
  for (const raw of block.rows) {
    if (!isRecord(raw) || typeof raw.key !== "string" || !raw.key) continue;
    if (raw.statement !== "PL" && raw.statement !== "BS") continue;
    const status = statusOf(raw.status);
    rows.set(raw.key, {
      key: raw.key,
      statement: raw.statement,
      baseKey: typeof raw.base_key === "string" ? raw.base_key : "",
      current: finiteOrNull(raw.current),
      // RULE 1: no share outside the share status, whatever the field holds.
      share: status === "share" ? finiteOrNull(raw.share) : null,
      status,
    });
  }
  return { schema, rows };
}

/** The share column a statement tab can paint from the period's own block. */
export interface ShareOffer {
  /** Which base the tab's column is struck against. */
  base: "PL" | "BS";
  /** The block carries this tab's rows. False: the box is off, with the
   *  reason — nothing is computed in its place. */
  served: boolean;
}

/**
 * What the P&L and the balance-sheet tab can offer with NO comparison
 * document on screen. The balance sheet's shares are the canonical rows'
 * (the tab renders the canonical object row by row), so they are served only
 * when the block carries them AND the tab renders that statement.
 */
export function shareOfferOf(
  tab: string,
  block: CommonSizeBlock | null,
  rendersCanonicalBs: boolean,
): ShareOffer | null {
  if (tab === "pl") return { base: "PL", served: block !== null };
  if (tab === "balance_sheet") {
    return {
      base: "BS",
      served: block !== null && rendersCanonicalBs && block.rows.has(BS_TOTAL_ASSETS_SHARE_KEY),
    };
  }
  return null;
}

export type ShareOutcome =
  /** The engine's share for the row — printed by `formatShare`. */
  | { kind: "share"; key: string; share: number }
  /** The engine's line, with no share: the status says why. */
  | { kind: "none"; key: string; status: Exclude<CommonSizeStatus, "share"> }
  /** The row shows an amount that is not the engine's for this line. */
  | { kind: "definition_differs"; key: string }
  /** No engine line is this row's figure by definition. */
  | { kind: "unmapped" };

/**
 * The share a statement row may print. `rowKey` is the row's bucket (P&L —
 * mapped through `PL_ROW_TO_KEY`) or a full engine key (the balance sheet's
 * canonical keys); `rowAmount` is the figure the row shows.
 */
export function shareForRow(
  block: CommonSizeBlock | null,
  rowKey: string | undefined,
  rowAmount: number | null | undefined,
): ShareOutcome {
  if (!block) return { kind: "unmapped" };
  const key = engineKeyForRow(rowKey);
  if (!key) return { kind: "unmapped" };
  const row = block.rows.get(key);
  if (!row) return { kind: "unmapped" };
  // RULE 2: the row's own amount must be the engine's, to the cent.
  if (!rowIsEngineFigure(rowAmount, row.current)) return { kind: "definition_differs", key };
  if (row.status === "share" && row.share !== null) return { kind: "share", key, share: row.share };
  return { kind: "none", key, status: row.status === "share" ? "unknown" : row.status };
}

/** The sentence (i18n key) for a line with no share — worded here, in the
 *  reader's language: the engine's `note` is its English diagnostic and is
 *  never printed. */
export function shareReasonKey(
  status: Exclude<CommonSizeStatus, "share">,
  statement: "PL" | "BS",
): string {
  switch (status) {
    case "no_base":
      return statement === "PL" ? "statements.cmp.share.noBasePl" : "statements.cmp.share.noBaseBs";
    case "absent":
      return "statements.cmp.share.absent";
    case "refused":
      return "statements.cmp.share.refused";
    case "not_disclosed_at_this_detail_level":
      return "statements.cmp.share.notAtLevel";
    default:
      return "statements.cmp.share.unavailable";
  }
}

/** The WORD a share cell prints for a line with no share, or null for the
 *  gap glyph. Absent is not zero and is not a word either: the row itself
 *  shows no figure. */
export function shareWordKey(status: Exclude<CommonSizeStatus, "share">): string | null {
  switch (status) {
    case "no_base":
      return "statements.cmp.noBase";
    case "refused":
      return "statements.cmp.refused";
    case "not_disclosed_at_this_detail_level":
      return "statements.cmp.notAtLevel";
    default:
      return null;
  }
}
