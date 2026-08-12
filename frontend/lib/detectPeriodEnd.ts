// detectPeriodEnd — client-side guess at a trial balance's period-end (closing)
// date. Two layers, mirroring what the engine does at persist time:
//   1. detectPeriodEndFromFilename — fast, name-only (mirrors the engine's
//      `_detect_period_end_from_filename`, src/engine/api/pipeline.py).
//   2. detectPeriodEndFromText / detectPeriodEndFromFile — reads the file's
//      HEADER CELLS. Many RO ERP exports have a generic filename ("balanta.xlsx")
//      but carry the real closing date inside ("la data de 31.12.2025"). The
//      engine prefers this content date over the filename (pipeline.py:825), so
//      the confirm dialog does too.
//
// Both return an ISO date (YYYY-MM-DD) or null when nothing is recognizable —
// the caller then asks the user to pick.

const MONTHS_RO: Record<string, number> = {
  ian: 1, feb: 2, mar: 3, apr: 4, mai: 5, iun: 6,
  iul: 7, aug: 8, sep: 9, oct: 10, noi: 11, dec: 12,
};

function iso(y: number, m: number, d: number): string | null {
  // Sane window: a trial balance is for a real accounting period, not a year
  // like 2050 or 2115 — those come from stray numbers in spreadsheet header
  // rows (RO thousand-separator dots, account codes, Excel serials) that the
  // date regexes below can accidentally match. Every detection path funnels
  // through here, so the clamp covers filename AND content detection.
  // Out-of-range → null → the confirm dialog asks the user to pick.
  const maxYear = new Date().getUTCFullYear() + 1;
  if (y < 2000 || y > maxYear) return null;
  // Validate via Date round-trip (rejects e.g. 31 Feb).
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function detectPeriodEndFromFilename(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const name = filename.trim();

  // DD.MM.YYYY / DD_MM_YYYY / DD-MM-YYYY (Romanian convention)
  let m = name.match(/(\d{1,2})[._-](\d{1,2})[._-](\d{4})/);
  if (m) {
    const r = iso(Number(m[3]), Number(m[2]), Number(m[1]));
    if (r) return r;
  }

  // YYYY-MM-DD / YYYY_MM_DD
  m = name.match(/(\d{4})[._-](\d{1,2})[._-](\d{1,2})/);
  if (m) {
    const r = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (r) return r;
  }

  // month-name + year ("dec 2025", "decembrie 2025") — default to end of month.
  const lower = name.toLowerCase().replace(/[._-]+/g, " ");
  for (const [tag, mo] of Object.entries(MONTHS_RO)) {
    const re = new RegExp(`\\b${tag}\\w*\\b.*?(\\d{4})`);
    const mm = lower.match(re);
    if (mm) {
      const y = Number(mm[1]);
      const r = iso(y, mo, lastDayOfMonth(y, mo));
      if (r) return r;
    }
  }

  // Year only → assume end of year.
  m = name.match(/\b(20\d{2})\b/);
  if (m) return iso(Number(m[1]), 12, 31);

  return null;
}

// Keywords that mark a date as the reporting period (positive signal) vs a
// print/generation stamp (negative — RO ERP headers stamp "Data listării:
// 15.07.2026" which is usually LATER than the real period-end, so a naive
// "latest date wins" rule would pick the print date).
const PERIOD_HINTS = /perioada|la data|balan|sold|luna|încheiat|incheiat|închei|inchei|final|situa|raportare|trial\s*balance|period/i;
const PRINT_HINTS = /listat|listăr|listar|tipăr|tipar|printat|generat|extras|creat|data\s*list|emis|export/i;

interface DatedMatch {
  iso: string;
  before: string; // ~40 chars of context preceding the match (lowercased)
}

function collectFullDates(text: string): DatedMatch[] {
  const out: DatedMatch[] = [];
  const push = (idx: number, r: string | null) => {
    if (!r) return;
    out.push({ iso: r, before: text.slice(Math.max(0, idx - 40), idx).toLowerCase() });
  };
  // DD.MM.YYYY / DD/MM/YYYY / DD-MM-YYYY (Romanian convention)
  for (const m of text.matchAll(/(\d{1,2})[.\/_-](\d{1,2})[.\/_-](\d{4})/g)) {
    push(m.index ?? 0, iso(Number(m[3]), Number(m[2]), Number(m[1])));
  }
  // YYYY-MM-DD / YYYY/MM/DD
  for (const m of text.matchAll(/(\d{4})[.\/_-](\d{1,2})[.\/_-](\d{1,2})/g)) {
    push(m.index ?? 0, iso(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  return out;
}

/**
 * Detect a period-end from free text (a file's header region). Prefers dates
 * sitting next to period keywords, drops dates next to print/generation
 * keywords, and treats the LATEST surviving date as the closing date (so a
 * "01.12.2025 – 31.12.2025" range resolves to the 31st). Returns ISO or null.
 */
export function detectPeriodEndFromText(text: string | null | undefined): string | null {
  if (!text) return null;

  const all = collectFullDates(text);
  if (all.length) {
    const notPrint = all.filter((d) => !PRINT_HINTS.test(d.before));
    const pool = notPrint.length ? notPrint : all;
    const periodTagged = pool.filter((d) => PERIOD_HINTS.test(d.before));
    const chosen = (periodTagged.length ? periodTagged : pool)
      .map((d) => d.iso)
      .sort();
    return chosen[chosen.length - 1] ?? null;
  }

  // Month-name + year ("decembrie 2025") — end of that month, latest wins.
  const lower = text.toLowerCase();
  let best: string | null = null;
  for (const [tag, mo] of Object.entries(MONTHS_RO)) {
    const re = new RegExp(`\\b${tag}\\w*\\b[^\\d]{0,12}(\\d{4})`, "g");
    for (const mm of lower.matchAll(re)) {
      const y = Number(mm[1]);
      const r = iso(y, mo, lastDayOfMonth(y, mo));
      if (r && (!best || r > best)) best = r;
    }
  }
  if (best) return best;

  // Year only → end of year.
  const ym = text.match(/\b(20\d{2})\b/);
  if (ym) return iso(Number(ym[1]), 12, 31);
  return null;
}

// Pull the header text (first rows) out of a spreadsheet/CSV/text file. Kept
// small — the reporting period lives in the title block, not the ledger rows,
// and scanning thousands of account rows would only add noise (and stray
// dates). Returns "" for formats we can't read client-side (pdf/images) or on
// any parse error — the caller falls back to the filename.
async function readHeaderText(file: File): Promise<string> {
  const lower = file.name.toLowerCase();
  try {
    if (/\.(xlsx|xls)$/.test(lower)) {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const parts: string[] = [];
      for (const sheet of wb.SheetNames.slice(0, 3)) {
        const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], {
          header: 1,
          blankrows: false,
        });
        for (const row of rows.slice(0, 40)) {
          parts.push((row as unknown[]).map((c) => (c == null ? "" : String(c))).join(" "));
        }
      }
      return parts.join("\n");
    }
    if (/\.csv$/.test(lower)) {
      const text = await file.text();
      return text.split(/\r?\n/).slice(0, 40).join("\n");
    }
    if (/\.(txt|tsv)$/.test(lower)) {
      return (await file.text()).slice(0, 8000);
    }
  } catch {
    // Unreadable / corrupt — silently fall back to filename detection.
  }
  return "";
}

/**
 * Best-effort period-end for a staged File. Reads the file's header for a date
 * (authoritative — it's the date printed in the trial balance) and falls back
 * to the filename. Async because it may parse a workbook; safe to call on any
 * file type (returns the filename guess, or null, for formats it can't read).
 */
export async function detectPeriodEndFromFile(file: File): Promise<string | null> {
  const fromContent = detectPeriodEndFromText(await readHeaderText(file));
  return fromContent ?? detectPeriodEndFromFilename(file.name);
}

/** "March 2025" from an ISO date; "" when unparseable. */
export function formatDetectedMonth(isoDate: string | null): string {
  if (!isoDate) return "";
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}
