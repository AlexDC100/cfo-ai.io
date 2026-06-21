// F6.0.1b (2026-06-21) — Budget file parser (client-side).
//
// Parses an uploaded budget workbook into a ComparisonDataset. Expected shape
// (matches the downloadable template): a row per P&L line with a Line column,
// a Budget column, and an optional "Last year" column. Header names are
// matched loosely (en/ro synonyms) so a lightly-reformatted file still works.
//
// CSV is parsed natively (no dependency). XLSX is parsed via a LAZY import of
// the `xlsx` lib (already a dep, ~280KB) so the variance page chunk stays
// small for users who never upload.

import {
  type ComparisonDataset,
  type VarianceLineKey,
  VARIANCE_LINES,
} from "./types";

/** Label / key aliases → canonical line key. Lowercased, stripped. */
const LINE_ALIASES: Record<string, VarianceLineKey> = {};
for (const def of VARIANCE_LINES) {
  LINE_ALIASES[def.key] = def.key;
  LINE_ALIASES[def.label.toLowerCase()] = def.key;
}
Object.assign(LINE_ALIASES, {
  revenue: "operating_revenue",
  "operating revenue": "operating_revenue",
  "net turnover": "operating_revenue",
  turnover: "operating_revenue",
  sales: "operating_revenue",
  "cifra de afaceri": "operating_revenue",
  niv: "operating_revenue",
  "cost of sales": "cogs",
  "cost of goods sold": "cogs",
  "cost of goods": "cogs",
  "direct materials": "cogs",
  "gross profit": "gross_profit",
  "gross margin": "gross_profit",
  "direct margin": "gross_profit",
  gm: "gross_profit",
  opex: "opex",
  "operating expenses": "opex",
  "operating costs": "opex",
  sga: "opex",
  ebitda: "ebitda",
  "d&a": "depreciation",
  "depreciation & amortization": "depreciation",
  "depreciation and amortization": "depreciation",
  depreciation: "depreciation",
  amortization: "depreciation",
  ebit: "ebit",
  "operating result": "ebit",
  "operating profit": "ebit",
  "net financial result": "net_financial_result",
  "financial result": "net_financial_result",
  "net financial": "net_financial_result",
  "income tax": "income_tax",
  tax: "income_tax",
  "profit tax": "income_tax",
  "net profit": "net_profit",
  "net income": "net_profit",
  "net result": "net_profit",
  "profit net": "net_profit",
} satisfies Record<string, VarianceLineKey>);

function normLineKey(raw: string): VarianceLineKey | null {
  const k = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return LINE_ALIASES[k] ?? null;
}

/** Parse a numeric cell tolerating EU/US thousands+decimal styles, spaces,
 *  currency symbols, and parenthesised negatives. Returns null if unparseable. */
export function parseNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/[()\s€$£%]/g, "").replace(/RON|EUR|USD|lei/gi, "");
  if (!s) return null;
  // Decide decimal separator: if both "," and "." present, the LAST one is
  // the decimal. If only "," present and it looks like a decimal (≤2 digits
  // after), treat as decimal; else thousands.
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (lastComma > -1) {
    const decimals = s.length - lastComma - 1;
    s = decimals <= 2 ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (lastDot > -1) {
    // Dot-only. Romanian/EU exports use "." as the THOUSANDS separator, so
    // "4.913" = 4913 not 4.913. Heuristic: multiple dots, or a single dot
    // with exactly 3 trailing digits (the thousands-group signature), means
    // grouping — strip it. 1/2/4+ trailing digits is a genuine decimal.
    const dots = (s.match(/\./g) || []).length;
    const decimals = s.length - lastDot - 1;
    if (dots > 1 || decimals === 3) s = s.replace(/\./g, "");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

interface HeaderMap {
  lineCol: number;
  budgetCol: number;
  lastYearCol: number;
}

function detectHeaders(header: string[]): HeaderMap | null {
  const idx = (preds: string[]) =>
    header.findIndex((h) => {
      const v = (h ?? "").toString().trim().toLowerCase();
      return preds.some((p) => v.includes(p));
    });
  const lineCol = idx(["line", "item", "metric", "indicator", "rand", "concept"]);
  const budgetCol = idx(["budget", "bud", "plan", "bug", "target"]);
  const lastYearCol = idx(["last year", "last-year", "prior year", "ly", "py", "an precedent", "2024", "fy24"]);
  if (lineCol < 0 || budgetCol < 0) return null;
  return { lineCol, budgetCol, lastYearCol };
}

function rowsToDataset(rows: string[][], label: string): ComparisonDataset {
  if (rows.length < 2) throw new Error("File looks empty — need a header row plus data.");
  const hm = detectHeaders(rows[0]);
  if (!hm) {
    throw new Error(
      "Couldn't find the columns. The file needs a header row with a Line column and a Budget column (a Last year column is optional).",
    );
  }
  const budget: Partial<Record<VarianceLineKey, number>> = {};
  const lastYear: Partial<Record<VarianceLineKey, number>> = {};
  let matched = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const key = normLineKey(r[hm.lineCol] ?? "");
    if (!key) continue;
    const b = parseNumber(r[hm.budgetCol]);
    if (b !== null) {
      budget[key] = b;
      matched++;
    }
    if (hm.lastYearCol >= 0) {
      const ly = parseNumber(r[hm.lastYearCol]);
      if (ly !== null) lastYear[key] = ly;
    }
  }
  if (matched === 0) {
    throw new Error(
      "No recognised P&L lines found. Use the template's line names (Revenue, EBITDA, Net profit, …).",
    );
  }
  return { budget, lastYear, label, source: "upload", updatedAt: new Date().toISOString() };
}

function parseCsv(text: string): string[][] {
  // Minimal CSV: handles quoted fields + commas inside quotes + ; delimiter.
  const delim = text.split("\n")[0].includes(";") && !text.split("\n")[0].includes(",") ? ";" : ",";
  const out: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++; }
        else q = !q;
      } else if (c === delim && !q) {
        cells.push(cur); cur = "";
      } else cur += c;
    }
    cells.push(cur);
    out.push(cells.map((c) => c.trim()));
  }
  return out;
}

/** Parse an uploaded budget file into a ComparisonDataset. Throws a
 *  user-readable Error on any structural problem. */
export async function parseBudgetFile(file: File): Promise<ComparisonDataset> {
  const name = file.name;
  const label = name.replace(/\.[^.]+$/, "");
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    const text = await file.text();
    return rowsToDataset(parseCsv(text), label);
  }
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const XLSX = await import("xlsx");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
    });
    return rowsToDataset(rows.map((r) => r.map((c) => String(c ?? ""))), label);
  }
  throw new Error("Unsupported file type. Upload a .csv or .xlsx budget file.");
}
