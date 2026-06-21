// F6.0.1c (2026-06-21) — PowerPoint (.pptx) budget parser, client-side.
//
// Reads a management-pack budget deck (e.g. the Scandia GROUP BUG'26 deck)
// and pulls the P&L budget out of it. The P&L tables in these decks are
// embedded as EMF (vector) images, NOT native PowerPoint tables — so we:
//   1. unzip the .pptx (fflate, lazy-imported),
//   2. parse the text-drawing records out of each EMF image,
//   3. group them into rows, match each row label to a P&L line, and take
//      the RIGHTMOST number (the consolidated / Group total column),
//   4. detect the unit scale (EUR'000 → ×1000) + currency from slide text.
//
// Budget-only: these decks are a budget, so lastYear stays empty (it fills
// from the MTM actuals deck or a prior period). Best-effort: lines it can't
// find are simply absent (render "—").

import {
  type ComparisonDataset,
  type VarianceLineKey,
} from "./types";
import { parseNumber } from "./parseBudget";

// ── EMF text extraction ────────────────────────────────────────────────
interface EmfCell {
  y: number;
  x: number;
  s: string;
}

/** Extract EMR_EXTTEXTOUTW / A text records from an EMF byte buffer. */
function parseEmfText(buf: Uint8Array): EmfCell[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: EmfCell[] = [];
  const n = buf.byteLength;
  let off = 0;
  let guard = 0;
  while (off + 8 <= n && guard++ < 200_000) {
    const itype = dv.getUint32(off, true);
    const size = dv.getUint32(off + 4, true);
    if (size < 8 || off + size > n) break;
    if (itype === 84 || itype === 83) {
      // EMRTEXT: x@36, y@40, nChars@44, offString@48 (offset from record start)
      try {
        const x = dv.getInt32(off + 36, true);
        const y = dv.getInt32(off + 40, true);
        const nChars = dv.getUint32(off + 44, true);
        const offString = dv.getUint32(off + 48, true);
        const start = off + offString;
        if (start >= 0 && nChars > 0 && nChars < 4096) {
          let s = "";
          if (itype === 84) {
            for (let i = 0; i < nChars; i++) {
              const c = dv.getUint16(start + i * 2, true);
              if (c) s += String.fromCharCode(c);
            }
          } else {
            for (let i = 0; i < nChars; i++) {
              const c = buf[start + i];
              if (c) s += String.fromCharCode(c);
            }
          }
          s = s.trim();
          if (s) out.push({ y, x, s });
        }
      } catch {
        /* skip malformed record */
      }
    }
    off += size;
  }
  return out;
}

/** Group EMF cells into visual rows (by y), each sorted left→right. */
function toRows(cells: EmfCell[]): string[][] {
  const sorted = [...cells].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: string[][] = [];
  let cur: EmfCell[] = [];
  let lastY: number | null = null;
  for (const c of sorted) {
    if (lastY === null || Math.abs(c.y - lastY) <= 6) cur.push(c);
    else {
      rows.push(cur.sort((a, b) => a.x - b.x).map((x) => x.s));
      cur = [c];
    }
    lastY = c.y;
  }
  if (cur.length) rows.push(cur.sort((a, b) => a.x - b.x).map((x) => x.s));
  return rows;
}

// ── Row → P&L line matching ────────────────────────────────────────────
// Ordered: EBITDA before EBIT (substring), net profit before generic, etc.
// First match per key wins (so the headline "DIRECT MARGIN" beats the later
// "DM net of MKT" row).
const MATCHERS: { key: VarianceLineKey; test: (l: string) => boolean }[] = [
  { key: "net_profit", test: (l) => /net profit|net result|net income|profit net/.test(l) },
  { key: "income_tax", test: (l) => /taxation|income tax|profit tax|impozit/.test(l) },
  { key: "net_financial_result", test: (l) => /financial result|net financial|rezultat financiar/.test(l) },
  { key: "ebitda", test: (l) => /ebitda/.test(l) },
  { key: "ebit", test: (l) => /\bebit\b|operating result|operating profit/.test(l) },
  { key: "opex", test: (l) => /total fixed expenses|operating expenses|operating costs|total ofc|cheltuieli fixe/.test(l) },
  { key: "gross_profit", test: (l) => /direct margin|gross profit|gross margin|marja/.test(l) },
  { key: "cogs", test: (l) => /cost of goods|cost of sales|\bcogs\b|cost achizit/.test(l) },
  {
    key: "operating_revenue",
    test: (l) =>
      /niv turnover|net invoiced|net in pocket|nip revenue|\bturnover\b|cifra de afaceri|net revenue/.test(l) ||
      (/\brevenue\b|vanzari|sales value/.test(l) && !/gross|brut/.test(l)),
  },
];

/** Take the rightmost finite number in a row (the consolidated total). */
function rightmostNumber(cells: string[]): number | null {
  for (let i = cells.length - 1; i >= 1; i--) {
    const v = parseNumber(cells[i]);
    if (v !== null) return v;
  }
  return null;
}

function matchRow(label: string): VarianceLineKey | null {
  const l = label.toLowerCase();
  // Skip ratio / percentage rows ("% EBITDA from NIV", "% COGS …").
  if (l.includes("%") || /\bfrom niv\b|\bfrom nip\b/.test(l)) return null;
  for (const m of MATCHERS) if (m.test(l)) return m.key;
  return null;
}

// ── Unit + currency detection ──────────────────────────────────────────
function detectScaleAndCurrency(slideText: string): { scale: number; currency: string } {
  const t = slideText.toLowerCase();
  const thousands = /['’`]\s*000|\beur\s*['’`]?\s*000|\bron\s*['’`]?\s*000|in eur|in ron|mii eur|mii lei|mii ron|k\s*eur|keur|kron/.test(t);
  const currency = /\beur\b|euro|€/.test(t) ? "EUR" : /\bron\b|\blei\b/.test(t) ? "RON" : "EUR";
  return { scale: thousands ? 1000 : 1, currency };
}

// ── Public entry ───────────────────────────────────────────────────────
export async function parsePptxBudget(file: File): Promise<ComparisonDataset> {
  const { unzipSync } = await import("fflate");
  const data = new Uint8Array(await file.arrayBuffer());
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch {
    throw new Error("That .pptx couldn't be opened — it may be corrupt or password-protected.");
  }

  // Slide text (for unit/currency hints) from slideN.xml <a:t> runs.
  const decoder = new TextDecoder();
  let slideText = "";
  for (const name of Object.keys(files)) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) {
      const xml = decoder.decode(files[name]);
      slideText += " " + (xml.match(/<a:t>([^<]*)<\/a:t>/g) || []).join(" ").replace(/<[^>]+>/g, " ");
    }
  }
  const { scale, currency } = detectScaleAndCurrency(slideText);

  // Parse every EMF into its own partial P&L, then merge RICHEST-FIRST: the
  // table with the most matched lines (the full by-entity P&L) is
  // authoritative, and any line it lacks is filled from other tables. This
  // stops a partial EBITDA-only slide from clobbering the full P&L.
  const emfNames = Object.keys(files)
    .filter((n) => /^ppt\/media\/.*\.emf$/i.test(n))
    .sort();
  const partials: Partial<Record<VarianceLineKey, number>>[] = [];
  for (const name of emfNames) {
    const rows = toRows(parseEmfText(files[name]));
    const p: Partial<Record<VarianceLineKey, number>> = {};
    const seen = new Set<VarianceLineKey>();
    for (const row of rows) {
      if (row.length < 2) continue;
      const key = matchRow(row[0]);
      if (!key || seen.has(key)) continue;
      const v = rightmostNumber(row);
      if (v === null) continue;
      seen.add(key);
      p[key] = v * scale;
    }
    if (Object.keys(p).length) partials.push(p);
  }
  partials.sort((a, b) => Object.keys(b).length - Object.keys(a).length);
  const budget: Partial<Record<VarianceLineKey, number>> = {};
  for (const p of partials) {
    for (const [k, v] of Object.entries(p) as [VarianceLineKey, number][]) {
      if (budget[k] === undefined) budget[k] = v;
    }
  }

  // Derive D&A from EBITDA − EBIT when both present (decks rarely show it).
  if (
    budget.ebitda !== undefined &&
    budget.ebit !== undefined &&
    budget.depreciation === undefined
  ) {
    budget.depreciation = budget.ebitda - budget.ebit;
  }

  if (Object.keys(budget).length === 0) {
    throw new Error(
      "No P&L budget table was found in that presentation. The slides need a P&L with lines like Turnover, EBITDA, Net profit.",
    );
  }

  return {
    budget,
    lastYear: {},
    currency,
    label: file.name.replace(/\.[^.]+$/, ""),
    source: "upload",
    updatedAt: new Date().toISOString(),
  };
}
