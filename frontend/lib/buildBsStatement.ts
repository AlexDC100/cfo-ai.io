// Build a structured Balance Sheet statement from per-account line items.
//
// The reference layout (provided by the user) has:
//   - Two periods side-by-side: 01.01.<year> opening + 31.12.<year> closing
//   - Delta column showing closing − opening
//   - Asset side: NON-CURRENT + CURRENT subsections
//   - Equity & Liabilities side: EQUITY + NON-CURRENT LIAB + CURRENT LIAB
//   - Accumulated depreciation as contra-asset (shown in parens)
//   - Net fixed-assets subtotal mid-section, then remaining non-current items
//
// CONVENTION: opening balances come from the prior period when available;
// otherwise they default to 0. Closing balances come from the line items
// emitted by the canonical OMFP-1802 mapping in _ro_coa.py.

import { ApiLineItem, sumByExact, sumByPrefix } from "./plStructure";
import type { BSLine, BSSection, BSStatement } from "./bsStructure";
import {
  canonicalBsSectionMeta,
  type CanonicalBs,
  type CanonicalBsReconciliation,
  type CanonicalBsStatus,
} from "./financialReport";

interface BuildArgs {
  /** Per-account line items from the backend (BS entries used). */
  lineItems: ApiLineItem[];
  /** Optional prior-period line items for the opening column. */
  priorLineItems?: ApiLineItem[];
  /** Entity + dates for the header. */
  entity: string;
  asOf: string;
  comparativeDate: string;
  /** Currency code (defaults RON). */
  currency?: string;
  /** Net profit for the year — derived from the P&L. Drives equity's
   *  "Current year net profit" line. */
  currentYearNetProfit?: number;
  /**
   * F2.1 — Engine canonical `assembled_bs`. When supplied, the BS totals
   * (`totalAssets`, `totalEquityLiab`, `balanceCheck`) are read directly
   * from this object instead of being computed by FE row aggregation, and
   * per-engine-bucket residual rows ("Other [bucket]") are inserted where
   * the FE per-account row enumeration doesn't sum to the engine bucket
   * value. Result: BS subtotals match engine to the cent; any FE-coverage
   * gap surfaces as an explicit "Other [bucket]" line rather than as a
   * silent drift between rows and totals. Falls back to the legacy
   * FE-recompute behavior when absent (back-compat for periods without
   * `statements.assembled_bs`).
   */
  assembledBs?: Record<string, number>;
  /**
   * canonical_bs v2 — the engine-owned Balance Sheet authority
   * (docs/CANONICAL_BS_V2_CONTRACT.md, served by /api/period as
   * `statements.canonical_bs`). When present, the ENTIRE statement is
   * built from its rows/sections/totals/status verbatim: zero FE
   * arithmetic, no residual entries, no reconcile plugs, and
   * `assembledBs` / `lineItems` are not consulted. Legacy periods
   * (no canonical_bs) keep the assembledBs / FE-recompute path
   * below EXACTLY as before.
   */
  canonicalBs?: CanonicalBs;
}

// ─── canonical_bs v2 pass-through ────────────────────────────────────────

/** AUTO-RECONCILE (revised operator spec, 2026-08-19) — fields the engine
 *  serves on top of the base contract types. The base types live in
 *  financialReport.ts (owned by the export workstream); these widenings
 *  let the FE read the new served flags without touching that file, and
 *  every field is optional so pre-auto-stage envelopes stay valid. */
export type CanonicalBsReconciliationExt = CanonicalBsReconciliation & {
  /** Where the "Diferențe de reconciliere" line lives: class-6/7 causes
   *  route to the P&L (reaching the BS via the result line — the BS row
   *  may then be absent), everything else is a balance-sheet line. */
  placement?: "balance_sheet" | "pnl";
};
export type CanonicalBsExt = CanonicalBs & {
  /** Served when the auto-reconcile stage ran and was REJECTED by the
   *  validator (or the diagnosis was inconclusive): honest imbalance +
   *  "needs manual mapping". Never accompanies RECONCILED/BALANCED. */
  needs_review?: boolean;
  reconciliation?: CanonicalBsReconciliationExt | null;
};

/** Engine balance verdict attached to the view-model on the canonical
 *  path — BSStatementView renders its status strip from this verbatim.
 *  MATERIAL_IMBALANCE is the blocking state: the view must render it red
 *  with the diagnosis list, never as "all good". */
export interface BSCanonicalMeta {
  status: CanonicalBsStatus;
  /** assets − (equity + liabilities), signed — straight from the object. */
  difference: number;
  /** totals.assets — denominator for the strip's % readout (the one
   *  derived display value the contract explicitly sanctions). */
  totalAssets: number;
  /** totals.equity_plus_liabilities — kept for % readouts that mirror
   *  the engine's max(assets, e+l) denominator. */
  equityPlusLiabilities?: number;
  /** Deterministic D0–D8 entries; empty when status is BALANCED. */
  diagnosis: { code: string; detail: string }[];
  mappingVersion: string;
  /** AUTO-RECONCILE — engine-served flag: the automatic stage could not
   *  close the drift (validator reject / inconclusive diagnosis). Drives
   *  the calm amber "Needs manual mapping" panel. Never derived FE-side. */
  needsReview: boolean;
  /** Present iff status is RECONCILED — receipt for the green chip's
   *  micro-caption + tap-receipt and the synthetic row tooltip. */
  reconciliation?: CanonicalBsReconciliationExt;
}

/** Extract the strip's view-meta from a canonical_bs object verbatim.
 *  Shared by the builder below and by the undo POST response
 *  (BsCanonicalStatusStrip swaps its local meta from the response). */
export function canonicalMetaFromBs(cbs: CanonicalBs): BSCanonicalMeta {
  const ext = cbs as CanonicalBsExt;
  return {
    status: cbs.status,
    difference: cbs.difference,
    totalAssets: cbs.totals.assets,
    equityPlusLiabilities: cbs.totals.equity_plus_liabilities,
    diagnosis: (cbs.diagnosis ?? []).map((d) => ({ code: d.code, detail: d.detail })),
    mappingVersion: cbs.mapping_version,
    needsReview: ext.needs_review === true,
    reconciliation: (ext.reconciliation as CanonicalBsReconciliationExt | null) ?? undefined,
  };
}

/** Tooltip for the synthetic "Diferențe de reconciliere" row: rationale ·
 *  origin · timestamp, straight from the stored receipt (no invention). */
function syntheticNoteFrom(rec: CanonicalBsReconciliation | null | undefined): string | undefined {
  if (!rec) return undefined;
  const parts = [rec.rationale, rec.origin, rec.applied_at].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** buildBSStatement return shape — `canonical` is present iff the period
 *  carried canonical_bs (i.e. the statement is an engine pass-through). */
export type BSStatementWithCanonical = BSStatement & { canonical?: BSCanonicalMeta };

/**
 * Pure pass-through of the engine object (contract "Consumption rules"):
 * every row, section subtotal, grand total and the balance status render
 * verbatim. Rows are deliberately NEVER summed here — if rows disagreed
 * with a section subtotal that is an engine bug to surface upstream, not
 * something for the FE to plug (none of the residual/carve-out machinery
 * in the legacy path below runs on this path).
 */
function buildFromCanonicalBs(cbs: CanonicalBs, args: BuildArgs): BSStatementWithCanonical {
  // Group rows per section id, preserving the object's own row order.
  const syntheticNote = syntheticNoteFrom(cbs.reconciliation);
  const rowsBySection = new Map<string, BSLine[]>();
  for (const row of cbs.rows) {
    const line: BSLine = {
      accountCode: row.account_codes.length > 0 ? row.account_codes.join("+") : undefined,
      // Label comes from the object (label_key i18n is optional per the
      // contract; `label` is the render-as-is fallback and what we use).
      label: row.label,
      // bs_v2 carries closing truth; per-row `opening` is often null. A
      // null opening mirrors closing (Δ 0) so both columns stay symmetric
      // — never the legacy asymmetry of 0-vs-closing across sides.
      opening: row.opening ?? row.amount,
      closing: row.amount,
      style: "item",
      // RECONCILIATION FLOW — the adjusting row carries a visible marker
      // + tooltip (rationale · origin · timestamp). Pass-through only:
      // the engine decides which row is synthetic, never the FE.
      ...(row.synthetic === true
        ? { synthetic: true, ...(syntheticNote ? { syntheticNote } : {}) }
        : {}),
    };
    const bucket = rowsBySection.get(row.section);
    if (bucket) bucket.push(line);
    else rowsBySection.set(row.section, [line]);
  }

  // Section order follows the object's `sections` array (engine-ordered);
  // the meta table only says which side each id renders on.
  const assetSections: BSSection[] = [];
  const equityLiabSections: BSSection[] = [];
  for (const sec of cbs.sections) {
    const meta = canonicalBsSectionMeta(sec.id);
    const lines = rowsBySection.get(sec.id) ?? [];
    if (lines.length === 0 && sec.subtotal === 0) continue; // empty section — nothing to show
    const section: BSSection = {
      header: meta.header,
      lines,
      subtotalLabel: meta.subtotalLabel,
      // Engine subtotal verbatim. bs_v2 has no opening subtotals, so the
      // opening column mirrors closing (Δ 0) — same convention as rows.
      subtotalOpening: sec.subtotal,
      subtotalClosing: sec.subtotal,
      subtotalDelta: 0,
      subtotalBucket: meta.subtotalBucket,
    };
    if (meta.side === "assets") assetSections.push(section);
    else equityLiabSections.push(section);
  }

  const totalAssets = cbs.totals.assets;
  const totalEL = cbs.totals.equity_plus_liabilities;
  return {
    entity: args.entity,
    asOf: args.asOf,
    comparativeDate: args.comparativeDate,
    currency: args.currency ?? "RON",
    assetSections,
    totalAssets: { opening: totalAssets, closing: totalAssets, delta: 0 },
    equityLiabSections,
    totalEquityLiab: { opening: totalEL, closing: totalEL, delta: 0 },
    // THE drift — assets − (equity + liabilities), straight from the object.
    balanceCheck: cbs.difference,
    canonical: canonicalMetaFromBs(cbs),
  };
}

// Romanian account labels — used to render the per-line description next to
// the code. Matches the user's reference output. Keep these aligned with
// the canonical mapping in _ro_coa.py.
const ACCOUNT_LABELS: Record<string, string> = {
  // Non-current assets
  "208":  "Intangibles",
  "2808": "Intangibles amortization",
  "2131": "Tech equipment",
  "2132": "Measurement & control",
  "2133": "Transport",
  "214":  "Furniture & office",
  "215":  "Investment property",
  "231":  "Construction in progress",
  "2811": "Accum. depreciation",
  "2812": "Accum. depreciation",
  "2813": "Accum. depreciation",
  "2814": "Accum. depreciation",
  "2815": "Accum. depreciation — investment property",
  "261":  "Shares in affiliates",
  "263":  "Interests in participations",
  "265":  "Other LT securities",
  "2671": "LT receivables",
  "2678": "Other LT receivables",
  // Current assets
  "4091": "Supplier advances — stocks",
  "4092": "Supplier advances — services",
  "4093": "Advances for fixed assets",
  "4111": "Trade receivables",
  "4118": "Doubtful receivables",
  "491":  "Allowance — doubtful",
  "425":  "Wage advances",
  "4382": "Social receivables",
  "4424": "VAT recoverable",
  "4426": "VAT deductible",
  "4482": "Other state receivables",
  "461":  "Other debtors (intercompany)",
  "471":  "Prepaid expenses",
  "5121": "Bank — RON",
  "5124": "Bank — FX",
  "5311": "Cash on hand",
  "5314": "Cash on hand FX",
  // Equity
  "1012": "Share capital",
  "105":  "Revaluation reserves",
  "1061": "Legal reserves",
  "1068": "Other reserves",
  "1171": "Retained earnings",
  // Liabilities
  "1621": "LT bank loans",
  "1622": "LT bank loans — overdue",
  "1625": "LT bank loans — unpaid at maturity",
  "5191": "ST bank credit",
  "5192": "ST bank credit — unpaid",
  "401":  "Trade payables",
  "408":  "Invoices not received",
  "421":  "Personnel — salaries",
  "4281": "Other personnel liabilities",
  "4315": "Social security payable",
  "4316": "Health insurance payable",
  "436":  "Work insurance contribution",
  "4411": "Income tax payable",
  "4427": "VAT collected",
  "444":  "Income tax on wages",
  "446":  "Other taxes & duties",
  "455":  "Shareholder current accounts",
  "457":  "Dividends payable",
  "462":  "Other creditors",
};

function labelFor(code: string, fallback?: string): string {
  return ACCOUNT_LABELS[code] ?? fallback ?? code;
}

// ─── Helper: per-account close-balance amount for BS lines ──────────────
// Line items emit `statement: "BS"` for balance-sheet rows. The `amount`
// is already sign-corrected by the canonical mapping (positive for the
// account's natural side). For credit-natural accounts that map to a
// debit-side BS field via sign='reverse', the amount comes out positive.
/**
 * Sum BS line items whose account code belongs to the given OMFP-1802
 * code family.
 *
 * Why family-match instead of literal `===`: Romanian trial balances
 * ship in two coding conventions. SAGA-style exports use 4-digit codes
 * like `5121` (bank-RON), `4111` (trade receivables), `401` (suppliers).
 * Crystal Reports / SAP exports — and Scandia's trial balance — use
 * 6-digit codes for the same accounts: `512120`, `411101`, `401106`.
 * Both are equally valid; OMFP only fixes the first 3-4 digits and
 * lets each ERP add sub-account suffixes (the "analytical" level).
 *
 * Callers pass the 4-digit family root (`5121`, `4111`, `1012`, ...).
 * We match by `startsWith` so the same builder lights up both Saga
 * AND Crystal Reports TBs. Without this fix, every BS line for a
 * Crystal Reports company comes back zero — the bug the user saw on
 * Scandia where the Balance Sheet showed only the prefix-matched
 * accumulated-depreciation row + the P&L-sourced net-profit line.
 *
 * Collision safety: every call site in this builder passes a code
 * that's unambiguous at the family level (e.g. 1012 ≠ 1011, 5121 ≠
 * 5124, 401 ≠ 408). No two distinct OMFP families share a prefix.
 */
function bsSumByExact(items: ApiLineItem[], code: string): number {
  let total = 0;
  for (const li of items) {
    if (li.statement !== "BS") continue;
    if (li.ro_account_code.startsWith(code)) total += li.amount;
  }
  return total;
}

function bsSumByPrefix(items: ApiLineItem[], ...prefixes: string[]): number {
  let total = 0;
  for (const li of items) {
    if (li.statement !== "BS") continue;
    if (prefixes.some((p) => li.ro_account_code.startsWith(p))) total += li.amount;
  }
  return total;
}

// ─── Builder ─────────────────────────────────────────────────────────────

export function buildBSStatement(args: BuildArgs): BSStatementWithCanonical {
  // canonical_bs v2 short-circuit — the engine object IS the statement.
  // Everything below this line is the legacy path and must stay byte-for-
  // byte identical for old periods that lack canonical_bs.
  if (args.canonicalBs) return buildFromCanonicalBs(args.canonicalBs, args);

  const items = args.lineItems;
  const prior = args.priorLineItems ?? [];
  const currency = args.currency ?? "RON";

  // Closing values + opening values for every code we render
  const both = (code: string) => ({
    opening: bsSumByExact(prior, code),
    closing: bsSumByExact(items, code),
  });
  const bothPrefix = (...prefixes: string[]) => ({
    opening: bsSumByPrefix(prior, ...prefixes),
    closing: bsSumByPrefix(items, ...prefixes),
  });

  // ── NON-CURRENT ASSETS ───────────────────────────────────────────────
  // Gross PPE + intangibles, then accumulated depreciation as contra.
  // OMFP families 211 (Land) and 212 (Buildings) were previously omitted
  // — that hid the largest PPE bucket on industrial / real-estate
  // entities. Now included so a typical manufacturer's BS (Scandia,
  // Transavia, etc.) reads correctly.
  const intangiblesGross = both("208");
  const land211 = both("211");
  const buildings212 = both("212");
  // Class 213 family — equipment. Pre-existing breakdown into
  // 2131/2132/2133 stays for the granular display rows; the catchall
  // 213 prefix here picks up any "213" code that doesn't have a 4-digit
  // sub-prefix in the SAGA TB.
  const tech2131 = both("2131");
  const measure2132 = both("2132");
  const transport2133 = both("2133");
  const furniture214 = both("214");
  const investment215 = both("215");
  const cip231 = both("231");
  // Accumulated depreciation across 281x + 28x families (contra-asset)
  // The canonical mapping has sign=-1 on the 28x rules so the amount in
  // line_items is NEGATIVE (reduces PPE). For the contra row we show
  // the absolute value in parens.
  const accumDep = bothPrefix("2811", "2812", "2813", "2814", "2815");
  const intangibleAmort = bothPrefix("2801", "2803", "2805", "2808");

  const shares261 = both("261");
  const ltRecv2678 = both("2678");

  // Net fixed-assets subtotal (gross fixed - accumulated depreciation).
  // `tech213Catchall` covers any 213 family member that isn't picked
  // up by 2131/2132/2133 — defensive against ERPs that emit codes like
  // "213" or "21399".
  const tech213Catchall = both("213");
  const tech213Residual =
    tech213Catchall.closing - tech2131.closing - measure2132.closing - transport2133.closing;
  const tech213ResidualOpening =
    tech213Catchall.opening - tech2131.opening - measure2132.opening - transport2133.opening;

  // F1.n — Intangibles sign fix. `intangibleAmort` is the sum of 28xx
  // amortization line items, which the engine emits with `sign=-1` already
  // applied (i.e. line_item.amount is NEGATIVE). The prior `−` here
  // double-counted: `gross − (−amort)` = `gross + amort`. Correct math is
  // `gross + amort` (which subtracts because amort is already negative),
  // matching the established `+ accumDep.closing` pattern one line below.
  const netFixedClosing =
    land211.closing + buildings212.closing +
    tech2131.closing + measure2132.closing + transport2133.closing +
    Math.max(0, tech213Residual) +
    furniture214.closing + investment215.closing + cip231.closing +
    (intangiblesGross.closing + intangibleAmort.closing) +
    accumDep.closing;  // accumDep amount is negative (sign=-1), so adding subtracts
  const netFixedOpening =
    land211.opening + buildings212.opening +
    tech2131.opening + measure2132.opening + transport2133.opening +
    Math.max(0, tech213ResidualOpening) +
    furniture214.opening + investment215.opening + cip231.opening +
    (intangiblesGross.opening + intangibleAmort.opening) +
    accumDep.opening;

  const nonCurrentLines: BSLine[] = [
    {
      accountCode: "208/2808",
      label: "Intangibles (208 net of 2808)",
      // F1.n — see netFixed sign-fix comment above. Same formula, same fix.
      opening: intangiblesGross.opening + intangibleAmort.opening,
      closing: intangiblesGross.closing + intangibleAmort.closing,
      style: "item",
    },
    { accountCode: "211",  label: "Land", opening: land211.opening, closing: land211.closing, style: "item" },
    { accountCode: "212",  label: "Buildings", opening: buildings212.opening, closing: buildings212.closing, style: "item" },
    { accountCode: "2131", label: "Tech equipment", opening: tech2131.opening, closing: tech2131.closing, style: "item" },
    { accountCode: "2132", label: "Measurement & control", opening: measure2132.opening, closing: measure2132.closing, style: "item" },
    { accountCode: "2133", label: "Transport", opening: transport2133.opening, closing: transport2133.closing, style: "item" },
    { accountCode: "214",  label: "Furniture & office", opening: furniture214.opening, closing: furniture214.closing, style: "item" },
    { accountCode: "215",  label: "Investment property", opening: investment215.opening, closing: investment215.closing, style: "item" },
    { accountCode: "231",  label: "Construction in progress", opening: cip231.opening, closing: cip231.closing, style: "item" },
    {
      accountCode: "281x/29x",
      label: "Less: Accum. depreciation",
      opening: accumDep.opening,    // already negative
      closing: accumDep.closing,
      isContra: true,
      style: "contra",
    },
  ].filter((l) => Math.abs(l.opening ?? 0) > 0 || Math.abs(l.closing ?? 0) > 0);

  // Remaining non-current items (long-term investments) shown after net fixed assets
  const remainingNonCurrent: BSLine[] = [
    { accountCode: "261",  label: "Shares in affiliates", opening: shares261.opening, closing: shares261.closing, style: "item" },
    { accountCode: "2678", label: "Other LT receivables", opening: ltRecv2678.opening, closing: ltRecv2678.closing, style: "item" },
  ].filter((l) => Math.abs(l.opening ?? 0) > 0 || Math.abs(l.closing ?? 0) > 0);

  const totalNonCurrentClosing = netFixedClosing + shares261.closing + ltRecv2678.closing;
  const totalNonCurrentOpening = netFixedOpening + shares261.opening + ltRecv2678.opening;

  const nonCurrentAssets: BSSection = {
    header: "NON-CURRENT",
    lines: [
      ...nonCurrentLines,
      // Net fixed-assets mid-subtotal (inline; the SectionView will render a rule above it)
      {
        label: "Net fixed assets",
        opening: netFixedOpening,
        closing: netFixedClosing,
        style: "subtotal",
      },
      ...remainingNonCurrent,
    ],
    subtotalLabel: "Total non-current",
    subtotalOpening: totalNonCurrentOpening,
    subtotalClosing: totalNonCurrentClosing,
    subtotalDelta: totalNonCurrentClosing - totalNonCurrentOpening,
  };

  // ── CURRENT ASSETS ───────────────────────────────────────────────────
  // Inventory (Class 3) — was entirely omitted from the FE BS view
  // pre-fix. On Scandia FY2025 that's ~65M of raw materials + finished
  // goods missing from the asset side, contributing to the -200M
  // "balance sheet drift" the user reported. Pull the whole inventory
  // family net of provisions (39x is contra).
  const rawMaterials301 = both("301");
  const consumables302 = both("302");
  const smallInventory303 = both("303");
  const wip331 = both("331");
  const semiFinished341 = both("341");
  const finishedProducts345 = both("345");
  const merchandise371 = both("371");
  const packaging381 = both("381");
  const inventoryProvisions39 = bothPrefix("391", "392", "393", "394", "395", "396", "397", "398");

  const sup4091 = both("4091");
  const sup4092 = both("4092");
  const adv4093 = both("4093");
  const ar4111 = both("4111");
  const ar4118 = both("4118");
  const allowance491 = both("491");
  const wage425 = both("425");
  const soc4382 = both("4382");
  const vat4424 = both("4424");
  const vat4426 = both("4426");
  const other4482 = both("4482");
  const debt461 = both("461");
  const prepaid471 = both("471");
  const cash5121 = both("5121");
  const cash5124 = both("5124");
  const cash5311 = both("5311");
  const cash5314 = both("5314");

  const cashTotalClosing = cash5121.closing + cash5124.closing + cash5311.closing + cash5314.closing;
  const cashTotalOpening = cash5121.opening + cash5124.opening + cash5311.opening + cash5314.opening;

  // Inventory total: raw materials + WIP + finished + merchandise +
  // packaging, NET of provisions (39x is contra). The provisions are
  // emitted with sign=-1 by the mapping rule, so they're already
  // negative in the line items — adding them subtracts.
  const inventoryGrossClosing =
    rawMaterials301.closing + consumables302.closing + smallInventory303.closing +
    wip331.closing + semiFinished341.closing + finishedProducts345.closing +
    merchandise371.closing + packaging381.closing;
  const inventoryGrossOpening =
    rawMaterials301.opening + consumables302.opening + smallInventory303.opening +
    wip331.opening + semiFinished341.opening + finishedProducts345.opening +
    merchandise371.opening + packaging381.opening;
  const inventoryNetClosing = inventoryGrossClosing + inventoryProvisions39.closing;
  const inventoryNetOpening = inventoryGrossOpening + inventoryProvisions39.opening;

  const currentLines: BSLine[] = [
    { accountCode: "301",  label: "Raw materials",                opening: rawMaterials301.opening, closing: rawMaterials301.closing, style: "item" },
    { accountCode: "302",  label: "Consumables",                  opening: consumables302.opening, closing: consumables302.closing, style: "item" },
    { accountCode: "303",  label: "Small inventory / tools",      opening: smallInventory303.opening, closing: smallInventory303.closing, style: "item" },
    { accountCode: "331",  label: "Work-in-progress",             opening: wip331.opening, closing: wip331.closing, style: "item" },
    { accountCode: "341",  label: "Semi-finished",                opening: semiFinished341.opening, closing: semiFinished341.closing, style: "item" },
    { accountCode: "345",  label: "Finished products",            opening: finishedProducts345.opening, closing: finishedProducts345.closing, style: "item" },
    { accountCode: "371",  label: "Merchandise",                  opening: merchandise371.opening, closing: merchandise371.closing, style: "item" },
    { accountCode: "381",  label: "Packaging",                    opening: packaging381.opening, closing: packaging381.closing, style: "item" },
    {
      accountCode: "39x",
      label: "Less: Inventory provisions",
      opening: inventoryProvisions39.opening,
      closing: inventoryProvisions39.closing,
      isContra: true,
      style: "contra",
    },
    { accountCode: "4091", label: "Supplier advances — stocks",   opening: sup4091.opening, closing: sup4091.closing, style: "item" },
    { accountCode: "4092", label: "Supplier advances — services", opening: sup4092.opening, closing: sup4092.closing, style: "item" },
    { accountCode: "4093", label: "Advances for fixed assets",    opening: adv4093.opening, closing: adv4093.closing, style: "item" },
    { accountCode: "4111", label: "Trade receivables",            opening: ar4111.opening,  closing: ar4111.closing,  style: "item", bucket: "accountsReceivable" },
    {
      accountCode: "4118-491",
      label: "Doubtful receivables net",
      // F1.n — Doubtful receivables sign fix. 491 (Ajustări depreciere
      // creanțe) is emitted with `sign=-1` by the engine, so its line_item
      // amount is already negative. The prior `−` double-counted:
      // `4118 − (−491)` = `4118 + 491`. Correct: `4118 + 491` where 491
      // is negative, which subtracts. Engine `ar_provisions` already
      // nets globally; this restores agreement.
      opening: ar4118.opening + allowance491.opening,
      closing: ar4118.closing + allowance491.closing,
      style: "item",
    },
    { accountCode: "425",  label: "Wage advances",                opening: wage425.opening, closing: wage425.closing, style: "item" },
    { accountCode: "4382", label: "Social receivables",           opening: soc4382.opening, closing: soc4382.closing, style: "item" },
    { accountCode: "4424", label: "VAT recoverable",              opening: vat4424.opening, closing: vat4424.closing, style: "item" },
    { accountCode: "4426", label: "VAT deductible",               opening: vat4426.opening, closing: vat4426.closing, style: "item" },
    { accountCode: "4482", label: "Other state receivables",      opening: other4482.opening, closing: other4482.closing, style: "item" },
    { accountCode: "461",  label: "Other debtors (intercompany)", opening: debt461.opening, closing: debt461.closing, style: "item" },
    { accountCode: "471",  label: "Prepaid expenses",             opening: prepaid471.opening, closing: prepaid471.closing, style: "item" },
    {
      accountCode: "5121+5124+5311",
      label: "Cash & equivalents",
      opening: cashTotalOpening,
      closing: cashTotalClosing,
      style: "item",
      bucket: "cash",
    },
  ].filter((l) => Math.abs(l.opening ?? 0) > 0 || Math.abs(l.closing ?? 0) > 0);

  const totalCurrentClosing = currentLines.reduce((s, l) => s + (l.closing ?? 0), 0);
  const totalCurrentOpening = currentLines.reduce((s, l) => s + (l.opening ?? 0), 0);

  const currentAssets: BSSection = {
    header: "CURRENT",
    lines: currentLines,
    subtotalLabel: "Total current",
    subtotalOpening: totalCurrentOpening,
    subtotalClosing: totalCurrentClosing,
    subtotalDelta: totalCurrentClosing - totalCurrentOpening,
    subtotalBucket: "totalCurrentAssets",
  };

  const totalAssetsClosing = totalNonCurrentClosing + totalCurrentClosing;
  const totalAssetsOpening = totalNonCurrentOpening + totalCurrentOpening;

  // ── EQUITY ───────────────────────────────────────────────────────────
  // Pre-fix this section was missing 104 (share premium / merger
  // premium) and 1068 (other reserves), and 117 was only picking up
  // 1171 — leaving 1174 (debit-side retained-earnings adjustments) out.
  // On Scandia those three lines combined add ~50M to total equity,
  // closing most of the previously-reported balance-sheet drift.
  const share1012 = both("1012");
  const premium104 = both("104");
  const reval105 = both("105");
  const legal1061 = both("1061");
  const otherReserves1068 = both("1068");
  // Retained earnings catchall: pre-fix only summed 1171. The 117
  // family includes 1171 (credit balance — prior-year profit) AND 1174
  // (debit-side errors / contra). Use the family root so both flow in.
  const retained117 = both("117");
  const currentYearNP = args.currentYearNetProfit ?? 0;

  const equityLines: BSLine[] = [
    { accountCode: "1012", label: "Share capital", opening: share1012.opening, closing: share1012.closing, style: "item" },
    { accountCode: "104",  label: "Share premium / merger premium", opening: premium104.opening, closing: premium104.closing, style: "item" },
    { accountCode: "105",  label: "Revaluation reserves", opening: reval105.opening, closing: reval105.closing, style: "item" },
    { accountCode: "1061", label: "Legal reserves", opening: legal1061.opening, closing: legal1061.closing, style: "item" },
    { accountCode: "1068", label: "Other reserves", opening: otherReserves1068.opening, closing: otherReserves1068.closing, style: "item" },
    { accountCode: "117",  label: "Retained earnings", opening: retained117.opening, closing: retained117.closing, style: "item" },
    {
      accountCode: "121",
      label: "Current year net profit",
      opening: 0,
      closing: currentYearNP,
      style: "item",
      bucket: "currentYearNetProfit",
    },
  ].filter((l) => Math.abs(l.opening ?? 0) > 0 || Math.abs(l.closing ?? 0) > 0);

  const totalEquityClosing = equityLines.reduce((s, l) => s + (l.closing ?? 0), 0);
  const totalEquityOpening = equityLines.reduce((s, l) => s + (l.opening ?? 0), 0);

  const equity: BSSection = {
    header: "EQUITY",
    lines: equityLines,
    subtotalLabel: "Total equity",
    subtotalOpening: totalEquityOpening,
    subtotalClosing: totalEquityClosing,
    subtotalDelta: totalEquityClosing - totalEquityOpening,
    subtotalBucket: "totalEquity",
  };

  // ── NON-CURRENT LIABILITIES ──────────────────────────────────────────
  // Pre-fix only LT bank loans (1621-1625) were rendered. Class 15
  // provisions, 167 leasing, 168 accrued LT interest, 475 investment
  // subsidies, and 478 grants together can be 15-30M on a mid-cap
  // industrial entity. Including them closes the residual BS drift
  // from ~7% to <1% on Scandia.
  const ltDebt = bothPrefix("1621", "1622", "1623", "1625");
  const leasing167 = both("167");
  const ltInterest168 = both("168");
  const provisions15 = bothPrefix("151", "152", "153", "154", "155", "158");
  const subsidies475 = both("475");
  const grants478 = both("478");
  const nonCurrentLiabLines: BSLine[] = [
    { accountCode: "1621", label: "LT bank loans", opening: ltDebt.opening, closing: ltDebt.closing, style: "item", bucket: "longTermDebt" },
    { accountCode: "167",  label: "Leasing obligations", opening: leasing167.opening, closing: leasing167.closing, style: "item" },
    { accountCode: "168",  label: "Accrued LT interest", opening: ltInterest168.opening, closing: ltInterest168.closing, style: "item" },
    { accountCode: "15x",  label: "Provisions (litigation, decommissioning)", opening: provisions15.opening, closing: provisions15.closing, style: "item" },
    { accountCode: "475",  label: "Investment subsidies", opening: subsidies475.opening, closing: subsidies475.closing, style: "item" },
    { accountCode: "478",  label: "Grants", opening: grants478.opening, closing: grants478.closing, style: "item" },
  ].filter((l) => Math.abs(l.opening ?? 0) > 0 || Math.abs(l.closing ?? 0) > 0);
  const totalNonCurrentLiabClosing =
    ltDebt.closing + leasing167.closing + ltInterest168.closing +
    provisions15.closing + subsidies475.closing + grants478.closing;
  const totalNonCurrentLiabOpening =
    ltDebt.opening + leasing167.opening + ltInterest168.opening +
    provisions15.opening + subsidies475.opening + grants478.opening;
  const nonCurrentLiab: BSSection = {
    header: "NON-CURRENT LIABILITIES",
    lines: nonCurrentLiabLines,
    subtotalLabel: "Total non-current liabilities",
    subtotalOpening: totalNonCurrentLiabOpening,
    subtotalClosing: totalNonCurrentLiabClosing,
    subtotalDelta: totalNonCurrentLiabClosing - totalNonCurrentLiabOpening,
    subtotalBucket: "totalNonCurrentLiabilities",
  };

  // ── CURRENT LIABILITIES ──────────────────────────────────────────────
  // Pre-fix this section was missing 519 (short-term bank credit —
  // ~15.6M on Scandia), 403 (notes payable), 405 (fixed-asset
  // payables), 419 (customer advances), and the 45x affiliate
  // payables — leaving meaningful ST liabilities off the BS and
  // contributing to the asset-vs-E&L drift.
  const stBank519 = both("519");
  const ap401 = both("401");
  const notesPayable403 = both("403");
  const faPayable405 = both("405");
  const ap408 = both("408");
  const custAdv419 = both("419");
  const sal421 = both("421");
  const personnel4281 = both("4281");
  const cas4315 = both("4315");
  const cass4316 = both("4316");
  const cam436 = both("436");
  const incTax4411 = both("4411");
  const vatCol4427 = both("4427");
  const salTax444 = both("444");
  const othTax446 = both("446");
  const affiliated45 = bothPrefix("451", "452", "455");
  const div457 = both("457");
  const creditors462 = both("462");
  const deferredRev472 = both("472");

  const currentLiabLines: BSLine[] = [
    { accountCode: "519",  label: "Short-term bank credit",      opening: stBank519.opening, closing: stBank519.closing, style: "item", bucket: "shortTermDebt" },
    { accountCode: "401",  label: "Trade payables",              opening: ap401.opening, closing: ap401.closing, style: "item", bucket: "accountsPayable" },
    { accountCode: "403",  label: "Notes payable",               opening: notesPayable403.opening, closing: notesPayable403.closing, style: "item" },
    { accountCode: "405",  label: "Fixed-asset payables",        opening: faPayable405.opening, closing: faPayable405.closing, style: "item" },
    { accountCode: "408",  label: "Invoices not received",       opening: ap408.opening, closing: ap408.closing, style: "item" },
    { accountCode: "419",  label: "Customer advances",           opening: custAdv419.opening, closing: custAdv419.closing, style: "item" },
    { accountCode: "421",  label: "Personnel — salaries",        opening: sal421.opening, closing: sal421.closing, style: "item" },
    { accountCode: "4281", label: "Other personnel liabilities", opening: personnel4281.opening, closing: personnel4281.closing, style: "item" },
    { accountCode: "4315", label: "Social security payable",     opening: cas4315.opening, closing: cas4315.closing, style: "item" },
    { accountCode: "4316", label: "Health insurance payable",    opening: cass4316.opening, closing: cass4316.closing, style: "item" },
    { accountCode: "436",  label: "Work insurance contribution", opening: cam436.opening, closing: cam436.closing, style: "item" },
    { accountCode: "4411", label: "Income tax payable",          opening: incTax4411.opening, closing: incTax4411.closing, style: "item" },
    { accountCode: "4427", label: "VAT collected",               opening: vatCol4427.opening, closing: vatCol4427.closing, style: "item" },
    { accountCode: "444",  label: "Income tax on wages",         opening: salTax444.opening, closing: salTax444.closing, style: "item" },
    { accountCode: "446",  label: "Other taxes & duties",        opening: othTax446.opening, closing: othTax446.closing, style: "item" },
    { accountCode: "451",  label: "Affiliated parties (payable)",opening: affiliated45.opening, closing: affiliated45.closing, style: "item" },
    { accountCode: "457",  label: "Dividends payable",           opening: div457.opening, closing: div457.closing, style: "item" },
    { accountCode: "462",  label: "Other creditors",             opening: creditors462.opening, closing: creditors462.closing, style: "item" },
    { accountCode: "472",  label: "Deferred revenue",            opening: deferredRev472.opening, closing: deferredRev472.closing, style: "item" },
  ].filter((l) => Math.abs(l.opening ?? 0) > 0 || Math.abs(l.closing ?? 0) > 0);

  const totalCurrentLiabClosing = currentLiabLines.reduce((s, l) => s + (l.closing ?? 0), 0);
  const totalCurrentLiabOpening = currentLiabLines.reduce((s, l) => s + (l.opening ?? 0), 0);

  const currentLiab: BSSection = {
    header: "CURRENT LIABILITIES",
    lines: currentLiabLines,
    subtotalLabel: "Total current liabilities",
    subtotalOpening: totalCurrentLiabOpening,
    subtotalClosing: totalCurrentLiabClosing,
    subtotalDelta: totalCurrentLiabClosing - totalCurrentLiabOpening,
    subtotalBucket: "totalCurrentLiabilities",
  };

  // ── TOTALS ───────────────────────────────────────────────────────────
  // F2.1 — When engine canonical `assembled_bs` is supplied, the top-level
  // totals + balance check read directly from it. The legacy line-549
  // formula `totalEquity + ltDebt + totalCurrentLiab` (which silently
  // omitted leasing/167, accrued-LT-interest/168, provisions/15x,
  // subsidies/475, grants/478) is removed — replaced by engine reads.
  // Per-bucket residual rows are injected into the appropriate sections
  // before computing FE-side section subtotals.
  const ab = args.assembledBs;
  const useEngineTotals = !!ab;

  // F2.1 per-bucket residual helper — surfaces FE-coverage gaps as named
  // "Other [bucket]" rows. The bucket-to-FE-rows map below mirrors what
  // the engine canon emits at the `assembled_bs.*` level. Sign matters:
  // a positive residual means FE rows undercount the engine bucket;
  // a negative residual means FE rows overcount it.
  const TOLERANCE = 0.5;  // RON; below this we treat the residual as noise

  // ─── Asset-side per-bucket residuals ────────────────────────────────
  // Each entry: [engine bucket value, FE row sum for that bucket, label,
  // target section ("non-current" | "current")]
  type ResidualEntry = {
    engineValue: number;
    feSum: number;
    label: string;
    section: "non-current" | "current" | "equity" | "nc-liab" | "c-liab";
  };

  const residualEntries: ResidualEntry[] = ab ? [
    // PP&E (excluding the dedicated investment / under-construction / advances
    // sub-buckets the engine carves out separately).
    {
      engineValue: ab.ppe_net ?? 0,
      feSum:
        land211.closing + buildings212.closing +
        tech2131.closing + measure2132.closing + transport2133.closing +
        Math.max(0, tech213Residual) +
        furniture214.closing +
        accumDep.closing
        // ppe_net the engine reports nets out the 215 investment property
        // AND 231 CIP into separate buckets, AND ppe_advances. So those
        // are NOT in the FE row sum for ppe_net comparison.
        + investment215.closing + cip231.closing,
      label: "Other PP&E",
      section: "non-current",
    },
    // Intangibles bucket (engine `intangibles_net` already nets amort).
    {
      engineValue: ab.intangibles_net ?? 0,
      feSum: intangiblesGross.closing + intangibleAmort.closing,
      label: "Other intangibles",
      section: "non-current",
    },
    // Long-term investments (engine `investments` = 261 + 263 + 265 + 267
    // + 2678 etc., FE only renders 261 and 2678 today).
    {
      engineValue: ab.investments ?? 0,
      feSum: shares261.closing + ltRecv2678.closing,
      label: "Other LT investments",
      section: "non-current",
    },
    // ppe_advances — 4093 today on FE renders in the CURRENT section, but
    // the engine routes it to PPE-advances (non-current PPE family). Treat
    // any residual as a "non-current" line for engine alignment.
    {
      engineValue: ab.ppe_advances ?? 0,
      feSum: adv4093.closing,
      label: "Other PP&E advances",
      section: "non-current",
    },
    // Cash bucket — FE sums 5121 + 5124 + 5311 + 5314; engine may also
    // route other class-5 cash (581 transit handled separately as ignored).
    {
      engineValue: ab.cash ?? 0,
      feSum: cashTotalClosing,
      label: "Other cash",
      section: "current",
    },
    // Aggregated receivables — engine reports ar_net + ar_doubtful_gross
    // + ar_provisions + ar_intercompany + ar_other; FE rows that sum to
    // this aggregate: 4111 + 4118 + 491 + 461 + 4091 + 4092 + 425 + 4382
    // + 4424 + 4426 + 4482 + 471.
    {
      engineValue:
        (ab.ar_net ?? 0) + (ab.ar_doubtful_gross ?? 0) +
        (ab.ar_provisions ?? 0) + (ab.ar_intercompany ?? 0) +
        (ab.ar_other ?? 0),
      feSum:
        ar4111.closing +
        (ar4118.closing + allowance491.closing) +  // F1.n net
        debt461.closing +
        sup4091.closing + sup4092.closing +
        wage425.closing + soc4382.closing +
        vat4424.closing + vat4426.closing +
        other4482.closing + prepaid471.closing,
      label: "Other receivables / current assets",
      section: "current",
    },
    // Inventory — engine doesn't emit a single inventory bucket field,
    // so there's no per-bucket residual to inject for inventory at the
    // F2.1 scope. Inventory rows roll into the current-section subtotal
    // as before. (Engine has total_assets that captures inventory; any
    // inventory-mapping miss surfaces in the asset-side bottom-line
    // residual below.)

    // ─── E&L per-bucket residuals ─────────────────────────────────────
    // Equity sub-buckets — engine emits five named fields. FE renders
    // 1012/104/105/1061/1068/117/121.
    {
      engineValue: ab.share_capital ?? 0,
      feSum: share1012.closing,
      label: "Other share capital",
      section: "equity",
    },
    {
      engineValue: ab.revaluation_reserves ?? 0,
      feSum: reval105.closing,
      label: "Other revaluation reserves",
      section: "equity",
    },
    {
      engineValue: ab.retained_earnings ?? 0,
      feSum: retained117.closing,
      label: "Other retained earnings",
      section: "equity",
    },
    {
      engineValue: ab.other_equity_non_revaluation ?? 0,
      feSum: premium104.closing + legal1061.closing + otherReserves1068.closing,
      label: "Other equity (uncategorized)",
      section: "equity",
    },
    // current_year_pnl matches the `121` line we render from
    // `args.currentYearNetProfit` (F1.n statutory anchor) — no residual.

    // LT debt — engine `lt_debt` aggregates bank loans + leasing + LT
    // interest accruals ONLY (chart_of_accounts.py: lt_debt =
    // bs["longTermDebt"]; provisions/subsidies/grants live in the separate
    // `other_non_current_liabilities` bucket). Comparing it against FE rows
    // that INCLUDED 15x/475/478 minted a negative residual that cancelled
    // real liabilities out of the section — Scandia Frozen's 941,634 RON of
    // investment subsidies vanished from TOTAL EQUITY & LIABILITIES, one of
    // the two legs of the 6.6M display imbalance (2026-08-13).
    {
      engineValue: ab.lt_debt ?? 0,
      feSum: ltDebt.closing + leasing167.closing + ltInterest168.closing,
      label: "Other long-term debt",
      section: "nc-liab",
    },
    // Other non-current liabilities — provisions 15x + subsidies 475 +
    // grants 478 vs the engine's dedicated bucket, so a mapping gap there
    // surfaces as its own honest residual instead of polluting lt_debt.
    {
      engineValue: (ab as { other_non_current_liabilities?: number }).other_non_current_liabilities ?? (provisions15.closing + subsidies475.closing + grants478.closing),
      feSum: provisions15.closing + subsidies475.closing + grants478.closing,
      label: "Other non-current liabilities",
      section: "nc-liab",
    },
    // ST debt — engine `st_debt` = 519 alone.
    {
      engineValue: ab.st_debt ?? 0,
      feSum: stBank519.closing,
      label: "Other short-term debt",
      section: "c-liab",
    },
    // Trade payables — engine `ap` = 401.
    {
      engineValue: ab.ap ?? 0,
      feSum: ap401.closing,
      label: "Other trade payables",
      section: "c-liab",
    },
    // Dividends payable — engine `ap_dividends` = 457.
    {
      engineValue: ab.ap_dividends ?? 0,
      feSum: div457.closing,
      label: "Other dividends payable",
      section: "c-liab",
    },
    // Other current liabilities — engine `ap_other` aggregates the long
    // tail (403, 405, 408, 419, personnel, social, tax, intercompany
    // C-side flips, 462, 472).
    {
      engineValue: ab.ap_other ?? 0,
      feSum:
        notesPayable403.closing + faPayable405.closing + ap408.closing +
        custAdv419.closing + sal421.closing + personnel4281.closing +
        cas4315.closing + cass4316.closing + cam436.closing +
        incTax4411.closing + vatCol4427.closing + salTax444.closing +
        othTax446.closing + affiliated45.closing +
        creditors462.closing + deferredRev472.closing,
      label: "Other current liabilities",
      section: "c-liab",
    },
  ] : [];

  // Build "Other [bucket]" residual lines from non-zero entries.
  const otherLinesNonCurrentAssets: BSLine[] = [];
  const otherLinesCurrentAssets: BSLine[] = [];
  const otherLinesEquity: BSLine[] = [];
  const otherLinesNCLiab: BSLine[] = [];
  const otherLinesCLiab: BSLine[] = [];
  for (const r of residualEntries) {
    const diff = r.engineValue - r.feSum;
    if (Math.abs(diff) < TOLERANCE) continue;
    const line: BSLine = {
      accountCode: "other",
      label: r.label,
      opening: 0,    // prior-period assembled_bs is not supplied (no opening canonical)
      closing: diff,
      style: "item",
    };
    if (r.section === "non-current") otherLinesNonCurrentAssets.push(line);
    else if (r.section === "current") otherLinesCurrentAssets.push(line);
    else if (r.section === "equity") otherLinesEquity.push(line);
    else if (r.section === "nc-liab") otherLinesNCLiab.push(line);
    else if (r.section === "c-liab") otherLinesCLiab.push(line);
  }

  // If engine canonical is in use, append "Other" residual rows AND
  // recompute the section subtotals to include them, so each section's
  // displayed subtotal equals the sum of its visible rows (no silent
  // discrepancy). Top-level totals come from engine.
  if (useEngineTotals) {
    nonCurrentAssets.lines = [
      ...nonCurrentAssets.lines,
      ...otherLinesNonCurrentAssets,
    ];
    const ncAddOpen = otherLinesNonCurrentAssets.reduce((s, l) => s + (l.opening ?? 0), 0);
    const ncAddClose = otherLinesNonCurrentAssets.reduce((s, l) => s + (l.closing ?? 0), 0);
    nonCurrentAssets.subtotalOpening = (nonCurrentAssets.subtotalOpening ?? 0) + ncAddOpen;
    nonCurrentAssets.subtotalClosing = (nonCurrentAssets.subtotalClosing ?? 0) + ncAddClose;
    nonCurrentAssets.subtotalDelta =
      (nonCurrentAssets.subtotalClosing ?? 0) - (nonCurrentAssets.subtotalOpening ?? 0);

    currentAssets.lines = [
      ...currentAssets.lines,
      ...otherLinesCurrentAssets,
    ];
    const cAddOpen = otherLinesCurrentAssets.reduce((s, l) => s + (l.opening ?? 0), 0);
    const cAddClose = otherLinesCurrentAssets.reduce((s, l) => s + (l.closing ?? 0), 0);
    currentAssets.subtotalOpening = (currentAssets.subtotalOpening ?? 0) + cAddOpen;
    currentAssets.subtotalClosing = (currentAssets.subtotalClosing ?? 0) + cAddClose;
    currentAssets.subtotalDelta =
      (currentAssets.subtotalClosing ?? 0) - (currentAssets.subtotalOpening ?? 0);

    equity.lines = [
      ...equity.lines,
      ...otherLinesEquity,
    ];
    const eqAddClose = otherLinesEquity.reduce((s, l) => s + (l.closing ?? 0), 0);
    equity.subtotalClosing = (equity.subtotalClosing ?? 0) + eqAddClose;
    equity.subtotalDelta =
      (equity.subtotalClosing ?? 0) - (equity.subtotalOpening ?? 0);

    nonCurrentLiab.lines = [
      ...nonCurrentLiab.lines,
      ...otherLinesNCLiab,
    ];
    const ncLAddClose = otherLinesNCLiab.reduce((s, l) => s + (l.closing ?? 0), 0);
    nonCurrentLiab.subtotalClosing = (nonCurrentLiab.subtotalClosing ?? 0) + ncLAddClose;
    nonCurrentLiab.subtotalDelta =
      (nonCurrentLiab.subtotalClosing ?? 0) - (nonCurrentLiab.subtotalOpening ?? 0);

    currentLiab.lines = [
      ...currentLiab.lines,
      ...otherLinesCLiab,
    ];
    const cLAddClose = otherLinesCLiab.reduce((s, l) => s + (l.closing ?? 0), 0);
    currentLiab.subtotalClosing = (currentLiab.subtotalClosing ?? 0) + cLAddClose;
    currentLiab.subtotalDelta =
      (currentLiab.subtotalClosing ?? 0) - (currentLiab.subtotalOpening ?? 0);
  }

  // F2.1 — Top-level totals come from engine canonical when available.
  // No more `totalEquity + ltDebt + totalCurrentLiab` (line-549 bug). The
  // engine emits the truth as `assembled_bs.total_assets`,
  // `assembled_bs.total_equity`, `assembled_bs.total_liabilities`, and
  // `assembled_bs.bs_balance_delta`. We consume those directly.
  const totalAssetsClosingFinal = useEngineTotals
    ? (ab.total_assets ?? totalAssetsClosing)
    : totalAssetsClosing;
  const totalAssetsOpeningFinal = totalAssetsOpening; // no prior assembled_bs
  const totalELClosingFinal = useEngineTotals
    ? ((ab.total_equity ?? 0) + (ab.total_liabilities ?? 0))
    : (totalEquityClosing + ltDebt.closing + totalCurrentLiabClosing);
  const totalELOpeningFinal = useEngineTotals
    ? totalELClosingFinal  // we don't have prior canonical; opening matches closing
    : (totalEquityOpening + ltDebt.opening + totalCurrentLiabOpening);
  const balanceCheck = useEngineTotals
    ? (ab.bs_balance_delta ?? 0)
    : (totalAssetsClosing - (totalEquityClosing + ltDebt.closing + totalCurrentLiabClosing));

  // F2.1 — Section-to-grand-total reconciliation. The engine's
  // sub-aggregate buckets are not a clean partition of total_assets /
  // total_liab+equity (engine sub-aggregates have carve-outs and
  // overlap relationships not exposed at the BS-field level). After
  // per-bucket residuals are injected, residual error can still remain
  // between (sum of section subtotals) and (engine grand total) — this
  // shows up as a visible "section subtotals don't add to TOTAL"
  // defect on prod, which is the Shape B failure mode we explicitly
  // rejected. To prevent this, compute one final "Other (uncategorized)"
  // reconciliation row per side that closes the gap, so visible rows
  // sum to displayed subtotals AND displayed subtotals sum to engine
  // grand totals.
  if (useEngineTotals) {
    const assetSectionsSum =
      (nonCurrentAssets.subtotalClosing ?? 0) +
      (currentAssets.subtotalClosing ?? 0);
    const assetReconcile = totalAssetsClosingFinal - assetSectionsSum;
    if (Math.abs(assetReconcile) >= TOLERANCE) {
      const reconLine: BSLine = {
        accountCode: "other",
        label: "Other (uncategorized — engine bucket carve-outs)",
        opening: 0,
        closing: assetReconcile,
        style: "item",
      };
      currentAssets.lines = [...currentAssets.lines, reconLine];
      currentAssets.subtotalClosing =
        (currentAssets.subtotalClosing ?? 0) + assetReconcile;
      currentAssets.subtotalDelta =
        (currentAssets.subtotalClosing ?? 0) - (currentAssets.subtotalOpening ?? 0);
    }

    const elSectionsSum =
      (equity.subtotalClosing ?? 0) +
      (nonCurrentLiab.subtotalClosing ?? 0) +
      (currentLiab.subtotalClosing ?? 0);
    const elReconcile = totalELClosingFinal - elSectionsSum;
    if (Math.abs(elReconcile) >= TOLERANCE) {
      const reconLine: BSLine = {
        accountCode: "other",
        label: "Other (uncategorized — engine bucket carve-outs)",
        opening: 0,
        closing: elReconcile,
        style: "item",
      };
      currentLiab.lines = [...currentLiab.lines, reconLine];
      currentLiab.subtotalClosing =
        (currentLiab.subtotalClosing ?? 0) + elReconcile;
      currentLiab.subtotalDelta =
        (currentLiab.subtotalClosing ?? 0) - (currentLiab.subtotalOpening ?? 0);
    }
  }

  // Dividends-payable note when 457 has a material closing balance
  const note =
    div457.closing > 1000
      ? `Note: Dividends of ${div457.closing.toLocaleString("en-US", { maximumFractionDigits: 0 })} RON were DECLARED (debit to 1171, credit to 457 payable) but NOT paid in cash during the period — they sit on the balance sheet as a current liability awaiting distribution.`
      : undefined;

  return {
    entity: args.entity,
    asOf: args.asOf,
    comparativeDate: args.comparativeDate,
    currency,
    assetSections: [nonCurrentAssets, currentAssets],
    totalAssets: {
      opening: totalAssetsOpeningFinal,
      closing: totalAssetsClosingFinal,
      delta: totalAssetsClosingFinal - totalAssetsOpeningFinal,
    },
    equityLiabSections: [equity, nonCurrentLiab, currentLiab],
    totalEquityLiab: {
      opening: totalELOpeningFinal,
      closing: totalELClosingFinal,
      delta: totalELClosingFinal - totalELOpeningFinal,
    },
    balanceCheck,
    note,
  };
}

// Re-export label lookup so tests + the renderer can share the table.
export { labelFor };
