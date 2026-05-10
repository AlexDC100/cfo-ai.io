// Romanian trial balance ("balanță de verificare") → Statements mapper.
//
// Romania uses the OMFP-1802/2014 chart of accounts: account codes are 3–4
// digits and grouped into 9 classes:
//
//   Class 1  Capital, reserves, long-term debt
//   Class 2  Fixed assets (immobilizări)
//   Class 3  Inventory (stocuri)
//   Class 4  Third-party receivables / payables (terți)
//   Class 5  Cash & bank (trezorerie)
//   Class 6  Expenses (cheltuieli)
//   Class 7  Income (venituri)
//   Class 8  Off-balance-sheet
//   Class 9  Management accounting
//
// A balanta de verificare has at minimum: account code, label, opening
// balance (debit/credit), period movements (debit/credit), closing balance
// (sold final debit / sold final credit). For mapping we use the closing
// balance ("sold final"). Income/expense accounts (class 6/7) are P&L items;
// everything else is balance sheet.
//
// The parser accepts pasted free-text input — it scans for lines that start
// with a 3- or 4-digit account code followed by numeric tokens. It picks the
// LAST positive number on the line as the closing balance (sold final), which
// works for the most common columnar formats accountants export from SAGA,
// CIEL, NextUp, and Excel.
//
// This is intentionally heuristic and meant for "paste your trial balance"
// flow — for production-grade extraction we still need OCR + structured
// parsing on the backend (deferred).

import type { BalanceSheet, IncomeStatement, Statements } from "./financialReport";

// ─── Account-code → schema mapping ──────────────────────────────────────────
// Map prefix → bucket. Specific overrides come first; generic prefixes after.

type Bucket =
  | "cash"
  | "ar"
  | "inventory"
  | "otherCurrentAssets"
  | "ppe"
  | "intangibles"
  | "otherNonCurrentAssets"
  | "ap"
  | "stDebt"
  | "otherCurrentLiab"
  | "ltDebt"
  | "otherNonCurrentLiab"
  | "shareCapital"
  | "retainedEarnings"
  | "otherEquity"
  | "revenue"
  | "cogs"
  | "operatingExpenses"
  | "depreciation"
  | "interestExpense"
  | "otherIncome"
  | "financialIncome"
  | "financialExpense"
  | "taxExpense"
  | "ignore";

interface MappingRule {
  /** Prefix the account code must start with. Longer = more specific = wins. */
  prefix: string;
  bucket: Bucket;
  /** Some Romanian accounts have natural credit balances (e.g. revenue, debt). */
  sign: 1 | -1;
  description: string;
}

// Order matters: most specific first.
const RULES: MappingRule[] = [
  // ─ Class 1 — Capital & reserves ─
  { prefix: "101", bucket: "shareCapital", sign: 1, description: "Capital subscris" },
  { prefix: "104", bucket: "otherEquity", sign: 1, description: "Prime de capital" },
  { prefix: "105", bucket: "otherEquity", sign: 1, description: "Rezerve din reevaluare" },
  { prefix: "106", bucket: "otherEquity", sign: 1, description: "Rezerve" },
  { prefix: "1061", bucket: "otherEquity", sign: 1, description: "Rezerve legale" },
  { prefix: "117", bucket: "retainedEarnings", sign: 1, description: "Rezultatul reportat" },
  { prefix: "121", bucket: "retainedEarnings", sign: 1, description: "Profit / pierdere curentă" },
  { prefix: "129", bucket: "retainedEarnings", sign: -1, description: "Repartizare profit" },
  { prefix: "151", bucket: "otherCurrentLiab", sign: 1, description: "Provizioane" },
  { prefix: "16", bucket: "ltDebt", sign: 1, description: "Împrumuturi pe termen lung" },
  { prefix: "162", bucket: "ltDebt", sign: 1, description: "Credite bancare pe termen lung" },
  { prefix: "166", bucket: "ltDebt", sign: 1, description: "Datorii financiare pe termen lung" },
  { prefix: "167", bucket: "ltDebt", sign: 1, description: "Alte împrumuturi" },
  { prefix: "168", bucket: "interestExpense", sign: 1, description: "Dobânzi de plătit" },

  // ─ Class 2 — Fixed assets ─
  { prefix: "201", bucket: "intangibles", sign: 1, description: "Cheltuieli de constituire" },
  { prefix: "203", bucket: "intangibles", sign: 1, description: "Cheltuieli de dezvoltare" },
  { prefix: "205", bucket: "intangibles", sign: 1, description: "Concesiuni, brevete" },
  { prefix: "208", bucket: "intangibles", sign: 1, description: "Alte imobilizări necorporale" },
  { prefix: "21", bucket: "ppe", sign: 1, description: "Imobilizări corporale" },
  { prefix: "212", bucket: "ppe", sign: 1, description: "Construcții" },
  { prefix: "213", bucket: "ppe", sign: 1, description: "Echipamente, mașini" },
  { prefix: "215", bucket: "ppe", sign: 1, description: "Investiții imobiliare" },
  { prefix: "23", bucket: "ppe", sign: 1, description: "Imobilizări în curs (CIP)" },
  { prefix: "232", bucket: "ppe", sign: 1, description: "Avansuri pentru imobilizări" },
  { prefix: "26", bucket: "otherNonCurrentAssets", sign: 1, description: "Imobilizări financiare" },
  { prefix: "267", bucket: "otherNonCurrentAssets", sign: 1, description: "Creanțe imobilizate" },
  { prefix: "28", bucket: "ppe", sign: -1, description: "Amortizare imobilizări (contra-asset)" },

  // ─ Class 3 — Inventory ─
  { prefix: "3", bucket: "inventory", sign: 1, description: "Stocuri" },

  // ─ Class 4 — Receivables / payables ─
  { prefix: "401", bucket: "ap", sign: 1, description: "Furnizori" },
  { prefix: "403", bucket: "ap", sign: 1, description: "Efecte de plătit" },
  { prefix: "404", bucket: "ap", sign: 1, description: "Furnizori de imobilizări" },
  { prefix: "408", bucket: "ap", sign: 1, description: "Furnizori — facturi nesosite" },
  { prefix: "409", bucket: "otherCurrentAssets", sign: 1, description: "Avansuri către furnizori" },
  { prefix: "411", bucket: "ar", sign: 1, description: "Clienți" },
  { prefix: "418", bucket: "ar", sign: 1, description: "Clienți — facturi de întocmit" },
  { prefix: "419", bucket: "otherCurrentLiab", sign: 1, description: "Avansuri de la clienți" },
  { prefix: "421", bucket: "otherCurrentLiab", sign: 1, description: "Personal — salarii" },
  { prefix: "423", bucket: "otherCurrentLiab", sign: 1, description: "Personal — ajutoare" },
  { prefix: "425", bucket: "otherCurrentLiab", sign: 1, description: "Avansuri salarii" },
  { prefix: "426", bucket: "otherCurrentLiab", sign: 1, description: "Drepturi salariale neplătite" },
  { prefix: "43", bucket: "otherCurrentLiab", sign: 1, description: "Asigurări sociale" },
  { prefix: "441", bucket: "taxExpense", sign: 1, description: "Impozit pe profit" },
  { prefix: "442", bucket: "otherCurrentLiab", sign: 1, description: "TVA" },
  { prefix: "444", bucket: "otherCurrentLiab", sign: 1, description: "Impozit pe salarii" },
  { prefix: "446", bucket: "otherCurrentLiab", sign: 1, description: "Alte impozite" },
  { prefix: "448", bucket: "otherCurrentLiab", sign: 1, description: "Alte datorii fiscale" },
  { prefix: "455", bucket: "otherCurrentLiab", sign: 1, description: "Asociați — conturi curente" },
  { prefix: "456", bucket: "shareCapital", sign: 1, description: "Decontări cu acționarii" },
  { prefix: "457", bucket: "otherCurrentLiab", sign: 1, description: "Dividende de plată" },
  { prefix: "461", bucket: "otherCurrentAssets", sign: 1, description: "Debitori diverși" },
  { prefix: "462", bucket: "otherCurrentLiab", sign: 1, description: "Creditori diverși" },
  { prefix: "47", bucket: "otherCurrentAssets", sign: 1, description: "Conturi de regularizare (active)" },
  { prefix: "48", bucket: "otherCurrentAssets", sign: 1, description: "Decontări în cadrul unității" },

  // ─ Class 5 — Cash & bank ─
  { prefix: "5", bucket: "cash", sign: 1, description: "Trezorerie" },
  { prefix: "509", bucket: "stDebt", sign: 1, description: "Vărsăminte de efectuat" },
  { prefix: "519", bucket: "stDebt", sign: 1, description: "Credite bancare pe termen scurt" },

  // ─ Class 6 — Expenses ─
  { prefix: "60", bucket: "cogs", sign: 1, description: "Cheltuieli cu materii prime" },
  { prefix: "61", bucket: "operatingExpenses", sign: 1, description: "Lucrări și servicii executate de terți" },
  { prefix: "62", bucket: "operatingExpenses", sign: 1, description: "Alte servicii executate de terți" },
  { prefix: "63", bucket: "operatingExpenses", sign: 1, description: "Cheltuieli cu impozite și taxe" },
  { prefix: "64", bucket: "operatingExpenses", sign: 1, description: "Cheltuieli cu personalul" },
  { prefix: "65", bucket: "operatingExpenses", sign: 1, description: "Alte cheltuieli de exploatare" },
  { prefix: "66", bucket: "financialExpense", sign: 1, description: "Cheltuieli financiare" },
  { prefix: "666", bucket: "interestExpense", sign: 1, description: "Cheltuieli cu dobânzile" },
  { prefix: "665", bucket: "financialExpense", sign: 1, description: "Cheltuieli din diferențe de curs" },
  { prefix: "67", bucket: "operatingExpenses", sign: 1, description: "Cheltuieli extraordinare" },
  { prefix: "68", bucket: "depreciation", sign: 1, description: "Cheltuieli cu amortizările" },
  { prefix: "69", bucket: "taxExpense", sign: 1, description: "Cheltuieli cu impozit pe profit" },

  // ─ Class 7 — Income ─
  { prefix: "70", bucket: "revenue", sign: 1, description: "Venituri din vânzări" },
  { prefix: "704", bucket: "revenue", sign: 1, description: "Venituri din lucrări și servicii (chirii)" },
  { prefix: "706", bucket: "revenue", sign: 1, description: "Venituri din redevențe și chirii" },
  { prefix: "711", bucket: "otherIncome", sign: 1, description: "Variația stocurilor" },
  { prefix: "722", bucket: "otherIncome", sign: 1, description: "Producția de imobilizări (capitalized own work)" },
  { prefix: "74", bucket: "otherIncome", sign: 1, description: "Subvenții" },
  { prefix: "75", bucket: "otherIncome", sign: 1, description: "Alte venituri din exploatare" },
  { prefix: "76", bucket: "financialIncome", sign: 1, description: "Venituri financiare" },
  { prefix: "761", bucket: "financialIncome", sign: 1, description: "Venituri din participații (dividende)" },
  { prefix: "766", bucket: "financialIncome", sign: 1, description: "Venituri din dobânzi" },
];

function bucketFor(code: string): MappingRule | null {
  // Walk longest-first to prefer the most specific match.
  const sorted = [...RULES].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const rule of sorted) {
    if (code.startsWith(rule.prefix)) return rule;
  }
  return null;
}

// ─── Line parsing ───────────────────────────────────────────────────────────

export interface ParsedLine {
  code: string;
  label: string;
  amount: number;
  bucket: Bucket;
  rule?: MappingRule;
}

export interface ParseResult {
  lines: ParsedLine[];
  unmatched: { code: string; label: string; amount: number }[];
  totals: Record<Bucket, number>;
}

const numberToken = /-?[0-9]{1,3}(?:[.,\s ][0-9]{3})*(?:[.,][0-9]{1,2})?/g;

/** Parse a single line: "201 Cheltuieli de constituire   12,500.00   12,500.00" */
function parseLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Account code: 3–4 digits at the start of the line (allow leading bullet/tab)
  const codeMatch = trimmed.match(/^([0-9]{3,4})(?:\.[0-9]+)?\b/);
  if (!codeMatch) return null;
  const code = codeMatch[1];
  // Label: text between the code and the first number
  const afterCode = trimmed.slice(codeMatch[0].length).trim();
  const numMatches = [...afterCode.matchAll(numberToken)];
  if (numMatches.length === 0) return null;
  const labelEnd = numMatches[0].index ?? afterCode.length;
  const label = afterCode.slice(0, labelEnd).trim().replace(/[:\-—|]+$/, "").trim();
  // Amount: pick the LAST non-zero number on the line (typically sold final)
  const numbers = numMatches
    .map((m) => parseRoNumber(m[0]))
    .filter((n) => Number.isFinite(n));
  const amount = pickClosingBalance(numbers);
  const rule = bucketFor(code);
  return {
    code,
    label,
    amount,
    bucket: rule?.bucket ?? "ignore",
    rule: rule ?? undefined,
  };
}

/** Romanian numbers use either `.` or `,` as decimal separator with `.` or
 *  space thousand grouping. Try both and pick the parse that's plausible. */
function parseRoNumber(raw: string): number {
  const cleaned = raw.replace(/[\s ]/g, "");
  // Cases: 1.234,56 (RO) | 1,234.56 (EN) | 1234.56 | 1234,56 | 1234
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized: string;
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = cleaned.replace(/,/g, "");
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function pickClosingBalance(values: number[]): number {
  // The trial balance typically ends with: total debit | total credit | sold debit | sold credit
  // We want the sold final — the last non-zero value, prefer credit when it's
  // larger (passive accounts) by signaling magnitude.
  if (values.length === 0) return 0;
  // If there are 2+ trailing values, prefer the larger of the last two (sold D vs sold C).
  if (values.length >= 2) {
    const a = values[values.length - 2];
    const b = values[values.length - 1];
    return Math.abs(a) >= Math.abs(b) ? a : b;
  }
  return values[values.length - 1];
}

export function parseTrialBalance(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const parsed: ParsedLine[] = [];
  const unmatched: ParseResult["unmatched"] = [];
  const totals = emptyTotals();

  for (const raw of lines) {
    const line = parseLine(raw);
    if (!line) continue;
    if (!line.rule) {
      unmatched.push({ code: line.code, label: line.label, amount: line.amount });
      continue;
    }
    // Only roll up most-specific lines — a 3-digit summary row would double-count
    // its 4-digit children. Skip lines whose code is the prefix of any other line
    // matched in this pass. (Heuristic — works for typical exports where summary
    // rows are interleaved with detail rows.)
    parsed.push(line);
  }

  // De-dup: if both 401 and 4011 appear, drop the shorter one (summary).
  const codes = new Set(parsed.map((p) => p.code));
  const filtered = parsed.filter(
    (p) => !Array.from(codes).some((c) => c !== p.code && c.length > p.code.length && c.startsWith(p.code)),
  );

  for (const line of filtered) {
    const sign = line.rule!.sign;
    totals[line.bucket] = (totals[line.bucket] ?? 0) + line.amount * sign;
  }

  return { lines: filtered, unmatched, totals };
}

function emptyTotals(): Record<Bucket, number> {
  return {
    cash: 0,
    ar: 0,
    inventory: 0,
    otherCurrentAssets: 0,
    ppe: 0,
    intangibles: 0,
    otherNonCurrentAssets: 0,
    ap: 0,
    stDebt: 0,
    otherCurrentLiab: 0,
    ltDebt: 0,
    otherNonCurrentLiab: 0,
    shareCapital: 0,
    retainedEarnings: 0,
    otherEquity: 0,
    revenue: 0,
    cogs: 0,
    operatingExpenses: 0,
    depreciation: 0,
    interestExpense: 0,
    otherIncome: 0,
    financialIncome: 0,
    financialExpense: 0,
    taxExpense: 0,
    ignore: 0,
  };
}

// ─── Statements assembly ────────────────────────────────────────────────────

export interface BuildOptions {
  companyName: string;
  currency?: string; // default RON
  periodLabel?: string; // default "FY (current)"
  industry?: string;
}

export function buildStatementsFromTrialBalance(
  result: ParseResult,
  opts: BuildOptions,
): Statements {
  const t = result.totals;
  const balanceSheet: BalanceSheet = {
    cash: t.cash,
    accountsReceivable: t.ar,
    inventory: t.inventory,
    otherCurrentAssets: t.otherCurrentAssets,
    propertyPlantEquipment: t.ppe,
    intangibles: t.intangibles,
    otherNonCurrentAssets: t.otherNonCurrentAssets,
    accountsPayable: t.ap,
    shortTermDebt: t.stDebt,
    otherCurrentLiabilities: t.otherCurrentLiab,
    longTermDebt: t.ltDebt,
    otherNonCurrentLiabilities: t.otherNonCurrentLiab,
    shareCapital: t.shareCapital,
    retainedEarnings: t.retainedEarnings,
    otherEquity: t.otherEquity,
  };
  const incomeStatement: IncomeStatement = {
    revenue: t.revenue,
    costOfGoodsSold: t.cogs,
    operatingExpenses: t.operatingExpenses,
    depreciationAmortization: t.depreciation,
    interestExpense: t.interestExpense,
    otherIncome: t.otherIncome,
    financialIncome: t.financialIncome,
    financialExpense: t.financialExpense,
    taxExpense: t.taxExpense,
  };
  return {
    companyName: opts.companyName,
    industry: opts.industry,
    currency: opts.currency ?? "RON",
    periodLabel: opts.periodLabel ?? "Current period",
    balanceSheet,
    incomeStatement,
    supplementary: {},
  };
}

// ─── Server-extracted accounts → Statements ────────────────────────────────
// The /api/dashboard/parse endpoint returns {accounts: [{code,
// name, amount}, ...]} extracted from a PDF by Claude Opus 4.7. This helper
// runs the same RO-COA → bucket mapping the text parser uses, so the rest
// of the engine (ratios, valuation, recommendations) doesn't need to know
// where the data came from.

export interface ExtractedAccount {
  code: string;
  name: string;
  amount: number;
}

export function buildStatementsFromAccounts(
  accounts: ExtractedAccount[],
  opts: BuildOptions & { confidence?: number },
): { statements: Statements; result: ParseResult } {
  // Re-use the same bucket mapping by faking ParsedLine entries from the
  // server-supplied (code, name, amount) triples. Skip the text-parsing path.
  const lines: ParsedLine[] = [];
  const unmatched: ParseResult["unmatched"] = [];
  const sorted = [...RULES].sort((a, b) => b.prefix.length - a.prefix.length);

  for (const acc of accounts) {
    const rule = sorted.find((r) => acc.code.startsWith(r.prefix));
    if (!rule) {
      unmatched.push({ code: acc.code, label: acc.name, amount: acc.amount });
      continue;
    }
    lines.push({
      code: acc.code,
      label: acc.name,
      amount: acc.amount,
      bucket: rule.bucket,
      rule,
    });
  }

  // De-dup: drop summary codes when more-specific children exist.
  const codes = new Set(lines.map((l) => l.code));
  const filtered = lines.filter(
    (l) => !Array.from(codes).some((c) => c !== l.code && c.length > l.code.length && c.startsWith(l.code)),
  );

  const totals = emptyTotals();
  for (const line of filtered) {
    const sign = line.rule!.sign;
    totals[line.bucket] = (totals[line.bucket] ?? 0) + line.amount * sign;
  }
  const result: ParseResult = { lines: filtered, unmatched, totals };
  const statements = buildStatementsFromTrialBalance(result, opts);
  return { statements, result };
}

// ─── Demo input — paste this into the parser to test the end-to-end flow ───
//
// REAL-AUTH Step 1: previously demoed an actual real-estate operator's
// account-level trial balance (with bank names, tenant names, and exact
// figures). Replaced with fully synthetic Romanian SME numbers — every
// figure invented, no entity names that map to real companies. Use only
// for end-to-end testing of the parser, never as a marketing surface.

export const DEMO_RO_TRIAL_BALANCE = `
1012  Capital subscris vărsat                              1.000.000,00
106   Rezerve                                                900.000,00
117   Rezultatul reportat                                  1.250.000,00
121   Profit / pierdere curentă                              480.000,00
1621  Credite bancare pe termen lung                       3.500.000,00
5191  Credite bancare pe termen scurt                        700.000,00
212   Construcții                                          5.200.000,00
2131  Echipamente tehnologice                                820.000,00
2812  Amortizare construcții                              -1.150.000,00
371   Mărfuri                                              1.480.000,00
4111  Clienți                                                910.000,00
401   Furnizori                                              640.000,00
4423  TVA de plată                                            95.000,00
444   Impozit pe salarii                                      24.000,00
431   Asigurări sociale                                       82.000,00
512   Conturi curente la bănci — RON                         540.000,00
5311  Casa în lei                                             18.000,00
471   Cheltuieli înregistrate în avans                        62.000,00
707   Venituri din vânzarea mărfurilor                     8.400.000,00
711   Variația stocurilor                                    120.000,00
607   Cheltuieli privind mărfurile vândute                 5.100.000,00
628   Cheltuieli cu serviciile prestate de terți             860.000,00
641   Cheltuieli cu salariile                                950.000,00
635   Cheltuieli cu alte impozite                             86.000,00
605   Cheltuieli cu energia și apa                            74.000,00
681   Cheltuieli cu amortizările                             310.000,00
666   Cheltuieli cu dobânzile                                205.000,00
691   Cheltuieli cu impozitul pe profit                       95.000,00
`.trim();
