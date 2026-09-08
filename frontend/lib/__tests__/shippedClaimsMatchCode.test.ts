// shippedClaimsMatchCode — NOTHING ADVERTISED THAT IS NOT REAL.
//
// THE CLAIM THIS ASSERTS
//   Product copy may name a file format the product produces, a feature
//   the registry serves, a trial length the pricing config sells, and a
//   calibration result the fixture table measured — and nothing else.
//
// WHY THIS FILE EXISTS
//   Measured on HEAD 5415906, all of it rendered:
//     · The dashboard's Export tab shipped a third card, "PowerPoint deck
//       / Investor-grade pptx export … arrives in the next phase", under
//       a "Coming next" chip. There is no pptx writer anywhere in
//       `frontend/`, `pptxgenjs` is not in `package.json`, and the only
//       PowerPoint code in the repo reads a budget deck IN
//       (`lib/comparison/parsePptxBudget.ts`). Nobody was building the
//       export either (LAUNCH_AUDIT.md:182).
//     · The landing sold four "flagship modules". One of them, "Invoice
//       Intelligence", described VAT reconciliation and counterparty
//       concentration "surfaced as dedicated tabs inside your
//       statements", in the present tense, while `_features.py` carried
//       `invoices: hidden` and its own PendingState said it waits on
//       e-Factura ingestion via ANAF SPV that does not exist.
//     · The landing hero and FAQ sold a "30-day trial" in both
//       languages; `_pricing_config.py` sells seven days and every
//       in-app string said seven.
//     · The landing and the customer-facing accuracy one-pager both said
//       "five of eight calibration fixtures reconcile to exactly 0.00%".
//       The one-pager's own table listed four zeros, and F-A3.1 measured
//       four on 2026-09-08 (EEI, Frozen, RealEstate, Retail).
//
//   Nothing checked copy against the code that has to honour it.
//
// WHY EVERY SET HERE IS DERIVED, NOT TYPED
//   A hand-kept list of "formats we ship" is the next thing to drift —
//   it would have said "xlsx, html, pptx (soon)" and stayed green. So:
//     · shipped export formats come from the actual DOWNLOAD SITES
//       (`a.download = …`, `XLSX.writeFile(wb, filename)`);
//     · feature statuses come from `src/engine/api/_features.py`, the one
//       authority behind GET /api/features/status;
//     · the trial window comes from `_pricing_config.py`;
//     · the exact-zero fixture count comes from the drift TABLE in
//       `docs/customer-facing/ROMANIAN-ENGINE-ACCURACY.md` — a column of
//       measurements, not the prose next to it, which is the half that
//       was wrong.
//   Land a real PDF writer and `pdf` enters the shipped set on its own,
//   with no edit here. Measured while writing this, on the same tree:
//   before the PDF lane's `lib/reportPdf.ts` existed the harvester read
//   [csv, html, xlsx]; with it on disk it reads [csv, html, pdf, xlsx],
//   crediting `frontend/lib/reportPdf.ts (a.download = pdf.filename)`.
//   That is the whole design — a gate that refused PDF copy after a real
//   PDF shipped would be a gate reding on a correct product.
//
// WHAT IT REDS ON, AFTER THE REPAIR (TC-11)
//   · an export claim naming a format the tree cannot write — the string,
//     its key/language and the shipped set are all named in the message;
//   · `pdf` claimed as a produced FILE while the only PDF path is the
//     browser print dialog (allowed only while the sentence says so);
//   · a landing module card naming a registry row that is not `active`,
//     or one that is not in the registry at all;
//   · a landing module card with no `featureKey` (the field is required
//     by the type, so this is the JSON-shape floor);
//   · a trial length in landing copy that is not the configured window;
//   · an "N of eight … 0.00%" claim that is not the number of 0.0000%
//     rows in the committed fixture table;
//   · any surviving reference to the three deleted PPTX-card i18n keys;
//   · an Export-tab card whose key is missing from either dictionary;
//   · the registry regex dropping a row (`invoices` / `inventory` carry an
//     explanatory `#` comment between `_feature(` and the status, and a
//     comment-blind regex silently parsed 44 of 46 — both misses hidden
//     rows, i.e. exactly the rows a copy gate exists to catch);
//   · the registry, the pricing config or the fixture table becoming
//     unparseable (floor assertions below).
//
// WHAT IT CANNOT SEE (TC-11)
//   · Copy that DESCRIBES an export without naming a format ("a
//     board-ready pack"). The scope is format tokens and registry keys.
//   · Prose outside the two dictionaries and `landingStrings.ts` —
//     component-literal copy, emails, the public storefront templates.
//     Those are audited by hand in the lane report; a tree-wide string
//     sweep was tried and rejected because code comments and test
//     fixtures dominate the hits.
//   · Whether a format the tree CAN write is actually reachable from a
//     button. `csv` passes here because `Products.tsx` writes one;
//     nothing in this file proves a user can get to it.
//   · Whether the numbers a card quotes are right. `pricingMatchesRegistry`
//     covers plan bullets against the registry; this covers landing
//     modules, formats, the trial window and the fixture count.
//   · Import copy that happens to sit under an export-ish key.
//     `productsX.xlsxExport` labels the XLSX a user UPLOADS; it passes
//     only because `xlsx` is also a shipped export. A format that were
//     import-only would red there and the fix would be the key name.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, extname } from "node:path";

import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";
import { landingStringsFor } from "@/pages/cfo/landingStrings";

const REPO = resolve(__dirname, "../../..");
const FRONTEND = join(REPO, "frontend");

// ── 1. What the tree can actually write ───────────────────────────────

/** File extensions this repo is capable of handing to a user, harvested
 *  from the download primitives themselves. */
interface ProductionCapability {
  fileFormats: Set<string>;
  /** True when some surface calls `window.print()` — the browser's own
   *  "Save as PDF" path, which is a print, not a generated file. */
  printsToPdf: boolean;
  /** Where each format was found, for the failure message. */
  sites: Record<string, string[]>;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name === "test") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if ([".ts", ".tsx"].includes(extname(p)) && !/\.(test|spec)\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const LITERAL = "(`[^`]*`|\"[^\"]*\"|'[^']*')";

function unquote(lit: string): string {
  return lit.slice(1, -1);
}

/** The extension of a FILENAME literal. Deliberately rejects a bare
 *  extension (`".pptx"` in an `accept=` list): the char before the dot
 *  must be part of a name, so an accept-attribute entry can never be
 *  mistaken for something the app writes. */
function filenameExtension(literal: string): string | null {
  const m = /[^.\s][.]([a-z0-9]{2,5})$/i.exec(unquote(literal).trim());
  return m ? m[1].toLowerCase() : null;
}

function measureProductionCapability(): ProductionCapability {
  const fileFormats = new Set<string>();
  const sites: Record<string, string[]> = {};
  let printsToPdf = false;

  const note = (ext: string, where: string) => {
    fileFormats.add(ext);
    (sites[ext] ??= []).push(where);
  };

  for (const file of walk(FRONTEND)) {
    const src = readFileSync(file, "utf8");
    const rel = file.slice(REPO.length + 1);

    if (/\bwindow\.print\(\)/.test(src)) printsToPdf = true;

    // `a.download = <literal>` — a name or a template ending in .ext.
    for (const m of src.matchAll(new RegExp(`\\.download\\s*=\\s*${LITERAL}`, "g"))) {
      const ext = filenameExtension(m[1]);
      if (ext) note(ext, `${rel} (a.download)`);
    }

    // `a.download = pdf.filename` — the value is a NAME, not a literal.
    // Resolve it one level inside the same file: any assignment, default
    // or property that gives that name a filename-shaped literal counts.
    // Without this branch a real PDF writer would land and the gate would
    // still refuse PDF copy — a gate reding on a correct product, which
    // is the gate being wrong.
    for (const m of src.matchAll(/\.download\s*=\s*([A-Za-z_$][\w$.]*)\s*;/g)) {
      const name = m[1].split(".").pop() as string;
      for (const d of src.matchAll(
        new RegExp(`\\b${name}\\b\\s*(?::[^=;\n]*)?(?:=|\\?\\?|:)\\s*${LITERAL}`, "g"),
      )) {
        const ext = filenameExtension(d[1]);
        if (ext) note(ext, `${rel} (a.download = ${m[1]})`);
      }
    }

    // `XLSX.writeFile(wb, filename)` — resolve one level of indirection
    // when the second argument is a local const.
    for (const m of src.matchAll(
      new RegExp(`XLSX\\.writeFile\\(\\s*[A-Za-z0-9_$.]+\\s*,\\s*(${LITERAL}|[A-Za-z0-9_$]+)\\s*\\)`, "g"),
    )) {
      const arg = m[1];
      let lit: string | null = /^[`"']/.test(arg) ? arg : null;
      if (!lit) {
        const decl = new RegExp(`\\b(?:const|let|var)\\s+${arg}\\s*(?::[^=]+)?=\\s*${LITERAL}`).exec(src);
        lit = decl ? decl[1] : null;
      }
      const ext = lit ? filenameExtension(lit) : null;
      if (ext) note(ext, `${rel} (XLSX.writeFile)`);
    }
  }

  return { fileFormats, printsToPdf, sites };
}

// ── 2. The copy, flattened ────────────────────────────────────────────

interface Line {
  where: string;
  text: string;
}

function flatten(obj: unknown, path: string, out: Line[], where: string): void {
  if (typeof obj === "string") {
    out.push({ where: `${where} ${path}`, text: obj });
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, `${path}[${i}]`, out, where));
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      flatten(v, path ? `${path}.${k}` : k, out, where);
    }
  }
}

function allCopy(): Line[] {
  const out: Line[] = [];
  flatten(en, "", out, "en.json");
  flatten(ro, "", out, "ro.json");
  flatten(landingStringsFor("en"), "", out, "landingStrings[en]");
  flatten(landingStringsFor("ro"), "", out, "landingStrings[ro]");
  return out;
}

/** Format words as a reader meets them, mapped to the extension the code
 *  would have to write. Both languages spell these the same way. */
const FORMAT_WORDS: Array<[RegExp, string]> = [
  [/\bpptx\b|\bpowerpoint\b/i, "pptx"],
  [/\bdocx\b|\bword document\b/i, "docx"],
  [/\bxlsx\b|\bexcel\b/i, "xlsx"],
  [/\bcsv\b/i, "csv"],
  [/\bhtml\b/i, "html"],
  [/\bpdf\b/i, "pdf"],
];

// ── Which copy is an EXPORT CLAIM ─────────────────────────────────────
//
// Scoped STRUCTURALLY, not by keyword. A first attempt used "any string
// containing an export verb" and immediately red on honest UPLOAD copy —
// `dash.docTbWhere2` reads "Export → Balanță de verificare → XLSX or
// PDF", which instructs the user to export from SAGA, not a claim about
// what CFO AI writes. Two narrower scopes replace it.

/** Scope A — every i18n key the app renders INSIDE the Export tab, read
 *  off the component. This is the surface where an export card lives, so
 *  a re-added PowerPoint card lands in it by construction. */
function exportSurfaceKeys(): string[] {
  const src = readFileSync(join(FRONTEND, "pages/cfo/FinancialStatements.tsx"), "utf8");
  const start = src.indexOf('<TabsContent value="export"');
  if (start < 0) throw new Error("Export TabsContent not found in FinancialStatements.tsx");
  const end = src.indexOf("</TabsContent>", start);
  if (end < 0) throw new Error("Export TabsContent never closes in FinancialStatements.tsx");
  const block = src.slice(start, end);
  return [...block.matchAll(/\bt\(\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** Scope B — landing sentences that name the DESTINATION of an export
 *  ("export to X" / "export în X"), which is the product speaking about
 *  its own output. "Exports FROM SAGA" is the source preposition and is
 *  deliberately out of scope; see the blind-spot note in the header. */
const LANDING_EXPORT_SENTENCE = /\bexport(?:s|ed)?\s+(?:to|in|în)\b/i;

// ── 3. The registry, the pricing config, the fixture table ────────────

type FeatureStatus = "active" | "coming_soon" | "hidden";

function parseRegistry(): Record<string, FeatureStatus> {
  const src = readFileSync(join(REPO, "src/engine/api/_features.py"), "utf8");
  const out: Record<string, FeatureStatus> = {};
  const rx = /"([a-z0-9_]+)":\s*_feature\(\s*(?:#[^\n]*\n\s*)*"(active|coming_soon|hidden)"/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(src)) !== null) out[m[1]] = m[2] as FeatureStatus;
  return out;
}

function parseTrialWindowDays(): number {
  const src = readFileSync(join(REPO, "src/engine/api/_pricing_config.py"), "utf8");
  const m = /window_days=_env_int\(\s*"PRICING_TRIAL_WINDOW_DAYS"\s*,\s*(\d+)\s*\)/.exec(src);
  if (!m) throw new Error("PRICING_TRIAL_WINDOW_DAYS default not found in _pricing_config.py");
  return Number(m[1]);
}

/** How many calibration fixtures reconcile to EXACTLY zero, counted off
 *  the drift column of the committed table — never off the prose beside
 *  it, which is the half that said five while the column showed four. */
function parseExactZeroFixtures(): { zeros: number; total: number } {
  const src = readFileSync(
    join(REPO, "docs/customer-facing/ROMANIAN-ENGINE-ACCURACY.md"),
    "utf8",
  );
  const rows = [...src.matchAll(/^\|\s*\*{0,2}([A-Za-z][\w ()]*?)\*{0,2}\s*\|[^|]*\|\s*(\d+\.\d+)\s*%\s*\|/gm)];
  const zeros = rows.filter((r) => Number(r[2]) === 0).length;
  return { zeros, total: rows.length };
}

/** Every format a line names that the tree cannot hand to a user. */
function offendingFormats(line: Line, shipped: string[]): string[] {
  const out: string[] = [];
  for (const [rx, ext] of FORMAT_WORDS) {
    if (!rx.test(line.text)) continue;
    if (CAP.fileFormats.has(ext)) continue;
    // The one allowance: the browser's print dialog really does produce a
    // PDF, so copy may say so — while it SAYS so. It may not sell a
    // generated PDF file the tree does not write.
    if (ext === "pdf" && CAP.printsToPdf && /\bprint|\btipăre|\btipare/i.test(line.text)) continue;
    out.push(
      `${line.where} claims ".${ext}" — the tree writes only [${shipped.join(", ")}]` +
        `${ext === "pdf" ? " (window.print() exists, but this sentence does not say it prints)" : ""}\n` +
        `      "${line.text.slice(0, 180)}"`,
    );
  }
  return out;
}

// ── The gate ──────────────────────────────────────────────────────────

let CAP: ProductionCapability;
let STATUS: Record<string, FeatureStatus>;
let COPY: Line[];

beforeAll(() => {
  CAP = measureProductionCapability();
  STATUS = parseRegistry();
  COPY = allCopy();
});

describe("shipped claims match the code", () => {
  it("measures a plausible production capability (floor)", () => {
    // Not a pin on the exact set — that would be the hand-kept list this
    // file exists to avoid. It is a floor: if the harvester stops finding
    // the two exports the Export tab is built on, every assertion below
    // would pass vacuously.
    expect(CAP.fileFormats.has("xlsx"), JSON.stringify(CAP.sites)).toBe(true);
    expect(CAP.fileFormats.has("html"), JSON.stringify(CAP.sites)).toBe(true);
    expect(COPY.length).toBeGreaterThan(2000);
    expect(Object.keys(STATUS).length).toBeGreaterThan(40);
    // The two rows a comment-blind regex drops. Named, because the
    // count floor alone did not notice them going missing.
    expect(STATUS.invoices, "the `invoices` row did not parse").toBeDefined();
    expect(STATUS.inventory, "the `inventory` row did not parse").toBeDefined();
  });

  it("names no export format the Export tab cannot write", () => {
    const shipped = [...CAP.fileFormats].sort();
    const keys = exportSurfaceKeys();
    // Floor: if the block stops yielding keys the assertion is vacuous.
    expect(keys.length, "no t() keys found inside the Export tab").toBeGreaterThan(3);

    const offenders: string[] = [];
    for (const line of COPY) {
      const isDict = line.where.startsWith("en.json ") || line.where.startsWith("ro.json ");
      if (!isDict) continue;
      const key = line.where.split(" ")[1];
      if (!keys.includes(key)) continue;
      offenders.push(...offendingFormats(line, shipped));
    }
    expect(offenders.join("\n")).toBe("");
  });

  it("names no export format the landing cannot deliver", () => {
    const shipped = [...CAP.fileFormats].sort();
    const offenders: string[] = [];
    let scoped = 0;
    for (const line of COPY) {
      if (!line.where.startsWith("landingStrings")) continue;
      if (!LANDING_EXPORT_SENTENCE.test(line.text)) continue;
      scoped += 1;
      offenders.push(...offendingFormats(line, shipped));
    }
    // Floor: the landing does promise exports; if this scope ever empties,
    // the assertion has stopped looking at anything.
    expect(scoped, "no landing sentence names an export destination").toBeGreaterThan(0);
    expect(offenders.join("\n")).toBe("");
  });

  it("never names a format the tree cannot write under an export key", () => {
    // The blunt half: pptx and docx are formats NOTHING in this repo can
    // produce. Under a key that says "export", in either dictionary or in
    // the landing strings, they are an advertisement whatever the wording.
    const shipped = [...CAP.fileFormats].sort();
    const offenders: string[] = [];
    for (const line of COPY) {
      if (!/export/i.test(line.where)) continue;
      for (const [rx, ext] of FORMAT_WORDS) {
        if (ext !== "pptx" && ext !== "docx") continue;
        if (!rx.test(line.text)) continue;
        if (CAP.fileFormats.has(ext)) continue;
        offenders.push(
          `${line.where} claims ".${ext}" — the tree writes only [${shipped.join(", ")}]\n` +
            `      "${line.text.slice(0, 180)}"`,
        );
      }
    }
    expect(offenders.join("\n")).toBe("");
  });

  it("gives every card the Export tab renders copy in both languages", () => {
    // The reverse drift of the PPTX removal: a card added back with a key
    // that exists in one dictionary renders a raw `dash.foo` string to
    // half the customers. Reads the keys off the component, so a new card
    // is covered the moment it is written.
    const dicts: Record<string, Line[]> = { "en.json": [], "ro.json": [] };
    flatten(en, "", dicts["en.json"], "en.json");
    flatten(ro, "", dicts["ro.json"], "ro.json");
    const missing: string[] = [];
    for (const key of exportSurfaceKeys()) {
      for (const [lang, lines] of Object.entries(dicts)) {
        if (!lines.some((l) => l.where === `${lang} ${key}`)) {
          missing.push(`${lang} has no "${key}" — the Export tab renders it`);
        }
      }
    }
    expect(missing.join("\n")).toBe("");
  });

  it("leaves no reader behind for the deleted PowerPoint-card keys", () => {
    const dead = ["exportPptxTitle", "exportPptxBody", "comingNext"];
    const readers: string[] = [];
    for (const file of walk(FRONTEND)) {
      const src = readFileSync(file, "utf8");
      for (const key of dead) {
        if (new RegExp(`\\bt\\(\\s*["'\`]dash\\.${key}["'\`]`).test(src)) {
          readers.push(`${file.slice(REPO.length + 1)} still reads dash.${key}`);
        }
      }
    }
    expect(readers.join("\n")).toBe("");
  });

  it("sells only landing modules the registry serves, in both languages", () => {
    const offenders: string[] = [];
    for (const lang of ["en", "ro"] as const) {
      const cards = landingStringsFor(lang).modules.cards;
      expect(cards.length, `${lang}: no module cards parsed`).toBeGreaterThan(0);
      for (const card of cards) {
        const status = STATUS[card.featureKey];
        if (status === "active") continue;
        offenders.push(
          `landing[${lang}] module "${card.title}" names feature "${card.featureKey}" — ` +
            `registry status ${status ?? "NOT IN REGISTRY"}, not active`,
        );
      }
    }
    expect(offenders.join("\n")).toBe("");
  });

  it("quotes the trial window the pricing config sells", () => {
    const days = parseTrialWindowDays();
    const offenders: string[] = [];
    for (const lang of ["en", "ro"] as const) {
      const lines: Line[] = [];
      flatten(landingStringsFor(lang), "", lines, `landingStrings[${lang}]`);
      for (const line of lines) {
        // "N-day trial" / "probă … de N zile" — any trial length named.
        for (const m of line.text.matchAll(/(\d+)[- ](?:day|zile|de zile)\b[^.]{0,24}?(trial|prob)/gi)) {
          if (Number(m[1]) !== days) {
            offenders.push(`${line.where}: "${m[0]}" — configured trial window is ${days} days`);
          }
        }
        for (const m of line.text.matchAll(/(?:trial|prob\w*)[^.]{0,24}?(\d+)[- ](?:day|zile)\b/gi)) {
          if (Number(m[1]) !== days) {
            offenders.push(`${line.where}: "${m[0]}" — configured trial window is ${days} days`);
          }
        }
      }
    }
    expect(offenders.join("\n")).toBe("");
  });

  it("quotes the exact-zero fixture count the drift table measured", () => {
    const { zeros, total } = parseExactZeroFixtures();
    expect(total, "the fixture table in ROMANIAN-ENGINE-ACCURACY.md did not parse").toBe(8);

    const WORDS: Record<string, number> = {
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
      unu: 1, doua: 2, două: 2, trei: 3, patru: 4, cinci: 5, sase: 6, șase: 6, sapte: 7, șapte: 7, opt: 8,
    };
    const rx = new RegExp(
      `\\b(${Object.keys(WORDS).join("|")}|\\d+)\\b\\s*(?:of|din)\\s*(?:eight|opt|8)\\b`,
      "gi",
    );

    const offenders: string[] = [];
    for (const lang of ["en", "ro"] as const) {
      const lines: Line[] = [];
      flatten(landingStringsFor(lang), "", lines, `landingStrings[${lang}]`);
      for (const line of lines) {
        for (const m of line.text.matchAll(rx)) {
          const claimed = WORDS[m[1].toLowerCase()] ?? Number(m[1]);
          // Only the exact-zero claim is under test; "all eight within 1%"
          // is a different statement with its own number.
          if (!/0[.,]00\s*%|\bexact/i.test(line.text)) continue;
          if (claimed !== zeros) {
            offenders.push(
              `${line.where}: claims "${m[0]}" at 0.00% — the drift table lists ${zeros} of ${total}`,
            );
          }
        }
      }
    }
    expect(offenders.join("\n")).toBe("");
  });
});
