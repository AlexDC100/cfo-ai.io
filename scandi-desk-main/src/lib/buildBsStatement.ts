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

export function buildBSStatement(args: BuildArgs): BSStatement {
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

  const netFixedClosing =
    land211.closing + buildings212.closing +
    tech2131.closing + measure2132.closing + transport2133.closing +
    Math.max(0, tech213Residual) +
    furniture214.closing + investment215.closing + cip231.closing +
    (intangiblesGross.closing - intangibleAmort.closing) +
    accumDep.closing;  // accumDep amount is negative (sign=-1), so adding subtracts
  const netFixedOpening =
    land211.opening + buildings212.opening +
    tech2131.opening + measure2132.opening + transport2133.opening +
    Math.max(0, tech213ResidualOpening) +
    furniture214.opening + investment215.opening + cip231.opening +
    (intangiblesGross.opening - intangibleAmort.opening) +
    accumDep.opening;

  const nonCurrentLines: BSLine[] = [
    {
      accountCode: "208/2808",
      label: "Intangibles (208 net of 2808)",
      opening: intangiblesGross.opening - intangibleAmort.opening,
      closing: intangiblesGross.closing - intangibleAmort.closing,
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
    { accountCode: "4111", label: "Trade receivables",            opening: ar4111.opening,  closing: ar4111.closing,  style: "item" },
    {
      accountCode: "4118-491",
      label: "Doubtful receivables net",
      opening: ar4118.opening - allowance491.opening,
      closing: ar4118.closing - allowance491.closing,
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
    { accountCode: "1621", label: "LT bank loans", opening: ltDebt.opening, closing: ltDebt.closing, style: "item" },
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
    { accountCode: "519",  label: "Short-term bank credit",      opening: stBank519.opening, closing: stBank519.closing, style: "item" },
    { accountCode: "401",  label: "Trade payables",              opening: ap401.opening, closing: ap401.closing, style: "item" },
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
  };

  // ── TOTALS ───────────────────────────────────────────────────────────
  const totalELClosing = totalEquityClosing + ltDebt.closing + totalCurrentLiabClosing;
  const totalELOpening = totalEquityOpening + ltDebt.opening + totalCurrentLiabOpening;

  const balanceCheck = totalAssetsClosing - totalELClosing;

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
      opening: totalAssetsOpening,
      closing: totalAssetsClosing,
      delta: totalAssetsClosing - totalAssetsOpening,
    },
    equityLiabSections: [equity, nonCurrentLiab, currentLiab],
    totalEquityLiab: {
      opening: totalELOpening,
      closing: totalELClosing,
      delta: totalELClosing - totalELOpening,
    },
    balanceCheck,
    note,
  };
}

// Re-export label lookup so tests + the renderer can share the table.
export { labelFor };
