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
// WHAT IT REDS ON, ADDED 2026-09-08 (all six plant-proven; see the lane
// report for the verbatim PLANT → RED → REVERT → GREEN transcripts)
//   · THE HARVEST ITSELF GOING BLIND. Each of the six sources must
//     produce copy only it can produce. Removing `indexHtmlCopy()` from
//     `marketingCopy()` reds with "index.html yielded 0 lines". This is
//     the assertion whose absence let a verifier plant four false claims
//     into index.html and two into RoadmapPage and watch 9 tests pass.
//   · an unwritable format (pptx/docx) anywhere on a PURE marketing
//     surface — landingStrings, index.html's head, the roadmap;
//   · a trial length on ANY marketing surface, dictionaries included,
//     that is not `PRICING_TRIAL_WINDOW_DAYS`;
//   · two marketing surfaces quoting DIFFERENT values for the same
//     product figure (seconds / ratios / sheets). Derived: the gate does
//     not know the right number, only that the surfaces must agree;
//   · any calendar date on the public roadmap;
//   · a plan word the backend does not sell (`_pricing_config.py`
//     purchasable + recurring), in a plan-shaped context, on a marketing
//     surface or in a REACHABLE module;
//   · `lib/plans.ts` drifting from the backend's purchasable plan set in
//     either direction, or carrying any numeric literal;
//   · any euro amount on a marketing surface, or any of Landing.tsx's
//     `*MONTHLY*` price constants, that `_pricing_config.py` does not
//     charge (its constants are read by NUMBER, because the landing
//     builds `€${SOLO_MONTHLY}` and the digits never enter a string);
//   · a market named as a source of financials while markets.yaml gives
//     it `fundamentals_source: none`;
//   · a "refreshes every N minutes" claim that is not `_BVB_QUOTES_TTL_S`;
//   · a clause calling the BVB fundamentals end-of-day / daily / live
//     when the ANAF overlay carries one ANNUAL filing per company;
//   · a quarantined dead-copy module becoming reachable from main.tsx,
//     or a reachable module reading the `landing.*` namespace.
//
// WHAT IT CANNOT SEE (TC-11)
//   · Copy that DESCRIBES an export without naming a format ("a
//     board-ready pack"). The scope is format tokens and registry keys.
//   · Emails and the public storefront's server-rendered templates.
//     Neither is a frontend source; both still need a hand audit.
//   · The blunt format and figure laws deliberately do NOT run over the
//     two dictionaries — those mix product UI copy with marketing, and
//     the import half legitimately names what the product READS
//     (`budgetX.formats` says "CSV · XLSX · PPTX budget deck") or times
//     something other than the product ("60 seconds" for a scan). Both
//     were measured as false reds before the scope was narrowed. The
//     dictionaries stay covered by the export-key-scoped laws, and by
//     the trial-window and provenance laws, which are precise enough to
//     run over everything.
//   · A plan claim written as prose with no plan word within 60
//     characters ("everything in the top tier" naming nothing).
//   · Whether a format the tree CAN write is actually reachable from a
//     button. `csv` passes here because `Products.tsx` writes one;
//     nothing in this file proves a user can get to it.
//   · Whether the numbers a card quotes are right IN ABSOLUTE TERMS. The
//     figure law proves the surfaces agree, not that 90 seconds is true.
//     `pricingMatchesRegistry` covers plan bullets against the registry.
//   · Import copy that happens to sit under an export-ish key.
//     `productsX.xlsxExport` labels the XLSX a user UPLOADS; it passes
//     only because `xlsx` is also a shipped export. A format that were
//     import-only would red there and the fix would be the key name.
//   · Whether quarantined dead copy is TRUE. It is measured false (see
//     DEAD_COPY_QUARANTINE) and merely proven unreachable; the fix is
//     deletion by the lane that owns those files.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, extname, dirname } from "node:path";

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

// ── 2b. The surfaces the harvest used to miss ─────────────────────────
//
// `allCopy()` read four sources — two dictionaries and the two landing
// string tables — and nothing else. Three shipping surfaces were outside
// it, all three hand-edited in the same copy pass this gate was written
// for, and a verifier proved the hole twice by planting false claims and
// watching 9 assertions pass:
//
//   · `index.html` — the <title> and the description / og: / twitter:
//     meta. This is the copy a crawler indexes and the card every
//     LinkedIn, Slack and iMessage share renders. PLANTED into BOTH
//     og:description and twitter:description: "…in 30 seconds —
//     statements, 100+ ratios, an 8-sheet Excel model and a PowerPoint
//     deck, on a 30-day free trial." Four wrong claims. 9 passed.
//   · `pages/cfo/RoadmapPage.tsx` — a public route (`/roadmap` in
//     App.tsx). PLANTED "Shipping Q2 2026" and `tier_target:
//     "Professional"`: a date already in the past against a file whose
//     own header says "Never label anything 'shipping next month'", and
//     a plan the backend does not sell. 9 passed.
//   · component-literal copy generally — Landing's inline JSX and every
//     other .tsx that renders a string it does not read from i18n.
//
// So the harvest is now: the two dictionaries, the two landing tables,
// index.html's head, and every string literal in the frontend tree with
// comments stripped and tests excluded.
//
// WHY A TREE-WIDE LITERAL SWEEP IS TRACTABLE HERE, HAVING BEEN REJECTED
// BEFORE. The earlier note said "a tree-wide string sweep was tried and
// rejected because code comments and test fixtures dominate the hits".
// Both causes are removable and are removed: comments are stripped
// before matching, and `walk()` already excludes `__tests__`, `test/`
// and `*.test.tsx`. Measured on this tree afterwards, the whole sweep
// yields 8 hits for pptx/docx and 5 for a trial window — every one of
// them structurally identifiable (an `accept=` list, a MIME type, a bare
// extension, one import-error sentence, and the four real landing trial
// strings). That is a reviewable number, not a flood.
//
// WHY THE LAWS ARE SPLIT BY SURFACE, NOT APPLIED FLAT. A MARKETING
// surface is one whose whole purpose is to make a claim to a customer:
// the dictionaries, the landing tables, index.html's head, the roadmap.
// A CODE literal may legitimately name a format the product cannot
// WRITE, because the product can READ it — `parsePptxBudget.ts` says
// "That .pptx couldn't be opened", which is honest import copy. The
// blunt format laws therefore run over marketing surfaces; the code
// corpus is scoped the way it always was, by export-ish key.

const INDEX_HTML = join(REPO, "index.html");

/** The head copy of index.html: the <title> plus the `content` of every
 *  description / og: / twitter: meta. Deliberately not every attribute —
 *  a URL, an image path or a theme colour is not a claim. */
function indexHtmlCopy(): Line[] {
  const src = readFileSync(INDEX_HTML, "utf8");
  const out: Line[] = [];
  const title = /<title>([^<]*)<\/title>/i.exec(src);
  if (title) out.push({ where: "index.html <title>", text: title[1].trim() });
  for (const m of src.matchAll(/<meta\s+([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    const name = /(?:name|property)\s*=\s*"([^"]+)"/i.exec(attrs);
    const content = /content\s*=\s*"([^"]*)"/i.exec(attrs);
    if (!name || !content) continue;
    if (!/^(description|og:(title|description|site_name|image:alt)|twitter:(title|description|image:alt))$/i.test(name[1])) {
      continue;
    }
    out.push({ where: `index.html meta[${name[1]}]`, text: content[1].trim() });
  }
  return out;
}

/** Strip // and /* *\/ comments so a file's own prose about a defect is
 *  not read as a claim the product makes. The `[^:\\]` guard keeps
 *  "https://" out of the line-comment match. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ");
}

/** Every string literal in a non-test frontend source, comments removed.
 *  Broad on purpose: the assertions below decide what is a claim, and a
 *  harvest that guessed at "prose" would be the next thing to have a
 *  hole in it. */
function componentLiterals(): Line[] {
  const out: Line[] = [];
  for (const file of walk(FRONTEND)) {
    const rel = file.slice(REPO.length + 1);
    const src = stripComments(readFileSync(file, "utf8"));
    for (const m of src.matchAll(new RegExp(LITERAL, "g"))) {
      const text = unquote(m[1]);
      if (!text.trim()) continue;
      out.push({ where: `code ${rel}`, text });
    }
  }
  return out;
}

/** The PURE marketing surfaces — copy that exists only to sell, with no
 *  product-UI copy mixed in.
 *
 *  The two dictionaries are deliberately NOT here. They hold both halves
 *  of the app's language, and the import half legitimately names things
 *  the product cannot write: `budgetX.formats` reads "CSV · XLSX · PPTX
 *  budget deck", describing what a user may UPLOAD (`parsePptxBudget.ts`
 *  reads it), and `dash.calloutTitle` says "60 seconds" about how long a
 *  scan takes, not how fast the product is. Both would be false reds
 *  under the blunt laws below, and a false red is how a gate gets
 *  deleted. The dictionaries stay covered by the export-key-scoped laws
 *  written for them, and by the trial-window and provenance laws, which
 *  are precise enough to run over everything. */
function isPureMarketing(line: Line): boolean {
  return (
    line.where.startsWith("landingStrings[") ||
    line.where.startsWith("index.html") ||
    line.where.startsWith("RoadmapPage.tsx")
  );
}

/** Copy whose entire job is to make a claim to a customer. */
function marketingCopy(): Line[] {
  const out: Line[] = [];
  flatten(en, "", out, "en.json");
  flatten(ro, "", out, "ro.json");
  flatten(landingStringsFor("en"), "", out, "landingStrings[en]");
  flatten(landingStringsFor("ro"), "", out, "landingStrings[ro]");
  out.push(...indexHtmlCopy());
  out.push(...roadmapCopy());
  return out;
}

function allCopy(): Line[] {
  return [...marketingCopy(), ...componentLiterals()];
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

// ── 2c. The roadmap, as data ──────────────────────────────────────────

const ROADMAP_PATH = join(FRONTEND, "pages/cfo/RoadmapPage.tsx");

/** The roadmap's entry TEXT — title, description and `tier_target` —
 *  read out of the `RoadmapEntry[]` literals rather than by importing
 *  the component, so a plant in any of the three arrays is harvested
 *  whether or not the array is currently rendered. */
function roadmapCopy(): Line[] {
  const src = stripComments(readFileSync(ROADMAP_PATH, "utf8"));
  const out: Line[] = [];
  for (const field of ["title", "description", "tier_target"]) {
    for (const m of src.matchAll(new RegExp(`\\b${field}:\\s*${LITERAL}`, "g"))) {
      out.push({ where: `RoadmapPage.tsx ${field}`, text: unquote(m[1]) });
    }
    // `description:` is routinely wrapped onto the next line.
    for (const m of src.matchAll(new RegExp(`\\b${field}:\\s*\\n\\s*${LITERAL}`, "g"))) {
      out.push({ where: `RoadmapPage.tsx ${field}`, text: unquote(m[1]) });
    }
  }
  return out;
}

// ── 2d. What actually reaches a browser ───────────────────────────────
//
// Some claim-carrying copy in this tree is DEAD — defined, shipped in
// the bundle's source, and rendered by nothing. It still matters (C5:
// "dead code that states a false claim is one import away from being
// live copy"), but it cannot be held to the same law as copy a customer
// reads today, because the honest fix for some of it is deletion by the
// lane that owns it. So the gate measures reachability instead of
// guessing: BFS the import graph from `frontend/main.tsx`, resolving
// `@/` and relative specifiers. Measured on this tree: 552 of the
// walked modules are reachable.

const MODULE_EXT = [".ts", ".tsx", ".js", ".jsx"];

function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(FRONTEND, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const e of ["", ...MODULE_EXT]) {
    const p = base + e;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  for (const e of MODULE_EXT) {
    const p = join(base, "index" + e);
    if (existsSync(p)) return p;
  }
  return null;
}

const IMPORT_RX =
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;

function reachableModules(): Set<string> {
  const seen = new Set<string>();
  const stack = [join(FRONTEND, "main.tsx")];
  while (stack.length) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    let src: string;
    try {
      src = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(IMPORT_RX)) {
      const spec = m[1] || m[2] || m[3];
      const r = resolveSpecifier(spec, f);
      if (r && !seen.has(r)) stack.push(r);
    }
  }
  return seen;
}

/** Copy-carrying modules that nothing imports. Each entry states what it
 *  claims and why it is quarantined rather than deleted. The gate asserts
 *  the list does not GROW and that nothing on it becomes reachable — so
 *  a false claim cannot ship by someone wiring one of these back up.
 *
 *  Measured 2026-09-08 against the code that would have to honour them:
 *    · the six `components/landing/*` files are the only readers of the
 *      97-key `landing.*` i18n namespace (×2 languages). That copy sells
 *      "5,000+ NASDAQ + NYSE companies", "Browse all 5,000+ public
 *      companies" and "Analyze Hain Celestial in 10 seconds", while
 *      `universe.py::DEFAULT_UNIVERSE` holds 203 tickers AND
 *      `lib/publicCompanyUniverse.ts::fetchUniverse` filters the whole
 *      product to `exchange === "BVB"` (Romania-only, operator directive
 *      2026-07-23) — so the surface shows zero NASDAQ companies. It also
 *      says "108 concepts in the glossary today"; `CONCEPTS_BY_KEY` holds
 *      118. And "10 seconds" against the live landing's "90 seconds".
 *    · `lib/pricingTiers.ts` carried €19.99 / €59 tiers and a 30-day
 *      trial against a config selling €4.99 / €9.99 / €16.99 on seven
 *      days. It had zero importers and was DELETED rather than
 *      quarantined; it is named here so its return is visible.
 *
 *  They are quarantined and not deleted because the locale files are
 *  shared by three lanes mid-wave and the six components belong to
 *  another lane; losing a 97-key block from a file being concurrently
 *  edited is a worse regression than dead copy nobody can read. */
const DEAD_COPY_QUARANTINE: string[] = [
  "components/landing/BridgeSection.tsx",
  "components/landing/EntryCard.tsx",
  "components/landing/LearningLayerSection.tsx",
  "components/landing/PrivateBusinessDemo.tsx",
  "components/landing/RealPeersSection.tsx",
  "components/landing/ReassuranceCard.tsx",
  "lib/pricingTiers.ts",
];

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

// ── 3b. The plan table the backend actually sells ─────────────────────

const PRICING_CONFIG_PY = join(REPO, "src/engine/api/_pricing_config.py");

interface BackendPlan {
  key: string;
  displayName: string;
  purchasable: boolean;
  recurring: boolean;
}

/** Every `_plan(... key="x" ...)` block in `_pricing_config.py`, with the
 *  two flags that decide whether a new customer can buy it. `purchasable`
 *  and `recurring` both default true in the dataclass, so an omitted flag
 *  is read as true — the same way the backend reads it. */
function parseBackendPlans(): BackendPlan[] {
  const src = readFileSync(PRICING_CONFIG_PY, "utf8");
  const out: BackendPlan[] = [];
  const keyRx = /\bkey="([a-z_]+)"/g;
  const starts: Array<{ key: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = keyRx.exec(src)) !== null) starts.push({ key: m[1], at: m.index });
  for (let i = 0; i < starts.length; i += 1) {
    const block = src.slice(starts[i].at, starts[i + 1]?.at ?? src.length);
    const name = /display_name="([^"]+)"/.exec(block);
    out.push({
      key: starts[i].key,
      displayName: name ? name[1] : starts[i].key,
      purchasable: !/purchasable=False/.test(block),
      recurring: !/recurring=False/.test(block),
    });
  }
  return out;
}

/** The legacy aliases `_pricing_config.py` still resolves server-side.
 *  A signup surface must NOT resolve these: the backend maps
 *  `professional` to `multi`, so a link carrying it would otherwise
 *  quote whatever the frontend guessed the word meant. */
function parseLegacyAliases(): string[] {
  const src = readFileSync(PRICING_CONFIG_PY, "utf8");
  const block = /legacy_tier_map[^{]*\{([\s\S]*?)\}/.exec(src);
  if (!block) throw new Error("legacy_tier_map not found in _pricing_config.py");
  return [...block[1].matchAll(/"([a-z_]+)":\s*"[a-z_]+"/g)].map((x) => x[1]);
}

/** Plan words a customer could read as the NAME of a purchasable tier.
 *  Built from the backend's own display names plus the ids and aliases,
 *  so retiring a plan there retires it here. */
function sellablePlanWords(plans: BackendPlan[]): Set<string> {
  const out = new Set<string>();
  for (const p of plans) {
    if (!p.purchasable || !p.recurring) continue;
    out.add(p.key.toLowerCase());
    out.add(p.displayName.toLowerCase());
  }
  return out;
}

// ── 3c. The market registry + the cadence constants ───────────────────

const MARKETS_YAML = join(REPO, "src/engine/public_market/markets.yaml");

interface MarketRow {
  id: string;
  status: string;
  fundamentals: string;
  priceSource: string;
}

function parseMarkets(): MarketRow[] {
  const src = readFileSync(MARKETS_YAML, "utf8");
  const out: MarketRow[] = [];
  let cur: MarketRow | null = null;
  for (const raw of src.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    let m = /^\s*-\s*market_id:\s*([a-z]+)\s*$/.exec(line);
    if (m) {
      cur = { id: m[1], status: "", fundamentals: "", priceSource: "" };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    m = /^\s+status:\s*([a-z_]+)\s*$/.exec(line);
    if (m) cur.status = m[1];
    m = /^\s+fundamentals_source:\s*([A-Za-z0-9_.]+)\s*$/.exec(line);
    if (m) cur.fundamentals = m[1];
    m = /^\s+price_source:\s*([A-Za-z0-9_.]+)\s*$/.exec(line);
    if (m) cur.priceSource = m[1];
  }
  return out;
}

/** The BVB quote cache TTL, in minutes, read off the constant that
 *  actually governs it. This is the ONLY source for a "refreshes every N
 *  minutes" claim in product copy.
 *
 *  Note for the next reader, because the audit's stated cause was wrong
 *  here and a fix aimed at it would have been worse than none: the
 *  `/public-companies` page is served by `engine.public`, NOT by
 *  `engine.public_market`. markets.yaml's `price_source: none` for `ro`
 *  is a statement about the public_market package, which omits Romania
 *  BY DESIGN so the home market "can never be claimed twice" — it is not
 *  a statement that the page shows no prices. It does show them, from a
 *  batched Yahoo sweep on this TTL. So the price law below is driven by
 *  this constant, and NOT by markets.yaml's RO row; a law built on that
 *  row would red on correct copy. */
function parseBvbQuoteTtlMinutes(): number {
  const src = readFileSync(
    join(REPO, "src/engine/public/universe_service.py"),
    "utf8",
  );
  const m = /_BVB_QUOTES_TTL_S\s*=\s*(\d+)\s*\*\s*(\d+)/.exec(src);
  if (m) return (Number(m[1]) * Number(m[2])) / 60;
  const flat = /_BVB_QUOTES_TTL_S\s*=\s*(\d+)\s*$/m.exec(src);
  if (!flat) throw new Error("_BVB_QUOTES_TTL_S not found in universe_service.py");
  return Number(flat[1]) / 60;
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
let MARKETING: Line[];
let REACHABLE: Set<string>;
let PLANS: BackendPlan[];
let MARKETS: MarketRow[];

beforeAll(() => {
  CAP = measureProductionCapability();
  STATUS = parseRegistry();
  MARKETING = marketingCopy();
  COPY = allCopy();
  REACHABLE = reachableModules();
  PLANS = parseBackendPlans();
  MARKETS = parseMarkets();
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

  it("harvests every surface that ships copy (floor)", () => {
    // The assertion that would have caught this gate's own blind spot.
    // Each source is proven present by a sentence only IT can supply, so
    // a harvest that silently stops reading one reds here rather than
    // passing vacuously over four sources instead of six.
    const wheres = MARKETING.map((l) => l.where);
    expect(wheres.some((w) => w.startsWith("en.json ")), "en.json").toBe(true);
    expect(wheres.some((w) => w.startsWith("ro.json ")), "ro.json").toBe(true);
    expect(wheres.some((w) => w.startsWith("landingStrings[en]")), "landing EN").toBe(true);
    expect(wheres.some((w) => w.startsWith("landingStrings[ro]")), "landing RO").toBe(true);

    // index.html — the <title> plus at least the three descriptions
    // (name=description, og:description, twitter:description) that the
    // verifier planted into.
    const idx = MARKETING.filter((l) => l.where.startsWith("index.html"));
    expect(idx.length, `index.html yielded ${idx.length} lines`).toBeGreaterThanOrEqual(4);
    for (const key of ["description", "og:description", "twitter:description"]) {
      expect(
        idx.some((l) => l.where === `index.html meta[${key}]` && l.text.length > 20),
        `index.html meta[${key}] was not harvested`,
      ).toBe(true);
    }

    // RoadmapPage — every entry title in the three arrays.
    const road = MARKETING.filter((l) => l.where.startsWith("RoadmapPage.tsx"));
    expect(road.length, "RoadmapPage.tsx yielded no entry copy").toBeGreaterThanOrEqual(14);
    expect(road.some((l) => /ERP integration/.test(l.text))).toBe(true);

    // Component literals — Landing's inline JSX and everything like it.
    const code = COPY.filter((l) => l.where.startsWith("code "));
    expect(code.length, "no component literals harvested").toBeGreaterThan(5000);
    expect(
      code.some((l) => l.where === "code frontend/pages/cfo/Landing.tsx"),
      "Landing.tsx contributed no literals",
    ).toBe(true);

    // The import graph resolved something real.
    expect(REACHABLE.size, "import graph did not resolve").toBeGreaterThan(300);
    expect(REACHABLE.has(join(FRONTEND, "pages/cfo/Landing.tsx"))).toBe(true);
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

  it("quotes the trial window the pricing config sells, on EVERY surface", () => {
    // Scope widened 2026-09-08 from landingStrings alone to every
    // marketing surface. The planted og:/twitter: descriptions sold a
    // "30-day free trial" and this assertion never looked at them.
    //
    // The verb side of the pattern is `prob(ă|a)\b` rather than `prob`,
    // which matched Romanian "problemă". Harmless while the scope was
    // one file; over the whole tree it fired on a learning concept
    // reading "Peste 90 zile = problemă" — a false red, and a false red
    // is how a gate gets deleted.
    const days = parseTrialWindowDays();
    const offenders: string[] = [];
    const TRIAL_AFTER = /(\d+)[- ](?:day|days|zile|de zile)\b[^.]{0,24}?(trial|prob[ăa]\b)/gi;
    const TRIAL_BEFORE = /(?:trial|prob[ăa]\b)[^.]{0,24}?(\d+)[- ](?:day|days|zile)\b/gi;
    for (const line of MARKETING) {
      for (const m of line.text.matchAll(TRIAL_AFTER)) {
        if (Number(m[1]) !== days) {
          offenders.push(`${line.where}: "${m[0]}" — configured trial window is ${days} days`);
        }
      }
      for (const m of line.text.matchAll(TRIAL_BEFORE)) {
        if (Number(m[1]) !== days) {
          offenders.push(`${line.where}: "${m[0]}" — configured trial window is ${days} days`);
        }
      }
    }
    expect(offenders.join("\n")).toBe("");
  });

  // ── The laws added 2026-09-08, after the harvest was widened ────────

  it("names no unwritable file format on any marketing surface", () => {
    // The blunt law, applied where a sentence exists only to sell. The
    // planted og:/twitter: descriptions offered "a PowerPoint deck";
    // nothing in this repo writes a .pptx. Code literals are NOT in this
    // scope: `parsePptxBudget.ts` says "That .pptx couldn't be opened",
    // which is honest copy about a file the product READS.
    const shipped = [...CAP.fileFormats].sort();
    const scoped = MARKETING.filter(isPureMarketing);
    expect(scoped.length, "no pure-marketing copy in scope").toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const line of scoped) {
      for (const [rx, ext] of FORMAT_WORDS) {
        if (ext !== "pptx" && ext !== "docx") continue;
        if (CAP.fileFormats.has(ext)) continue;
        if (!rx.test(line.text)) continue;
        offenders.push(
          `${line.where} claims ".${ext}" — the tree writes only [${shipped.join(", ")}]\n` +
            `      "${line.text.slice(0, 180)}"`,
        );
      }
    }
    expect(offenders.join("\n")).toBe("");
  });

  it("quotes one value per product figure, across every surface", () => {
    // ONE CONCEPT, ONE VALUE, ACROSS SURFACES — applied to the numbers
    // marketing copy puts next to the product. index.html and the
    // landing both quote "90 seconds", "22 ratios" and a sheet count;
    // the plant changed the meta to "30 seconds", "100+ ratios" and an
    // "8-sheet Excel model" while the landing kept saying otherwise, and
    // nothing noticed, because no gate compared two surfaces to each
    // other. Derived, not pinned: the gate does not know the right
    // number, only that the surfaces must agree on it.
    const UNITS: Array<[string, RegExp]> = [
      ["seconds", /(\d+)\+?\s*(?:seconds|secunde|s\b)(?![a-z])/gi],
      ["ratios", /(\d+)\+?\s*(?:ratios|indicatori financiari)/gi],
      ["sheets", /(\d+)[- ](?:sheet|sheets|foi)\b/gi],
    ];
    const offenders: string[] = [];
    const scoped = MARKETING.filter(isPureMarketing);
    for (const [unit, rx] of UNITS) {
      const seen = new Map<number, string[]>();
      for (const line of scoped) {
        for (const m of line.text.matchAll(rx)) {
          const n = Number(m[1]);
          if (!Number.isFinite(n)) continue;
          const at = seen.get(n) ?? [];
          at.push(`${line.where}: "${m[0].trim()}"`);
          seen.set(n, at);
        }
      }
      // Floor: at least one surface must actually quote this figure, or
      // the "they all agree" result is agreement about nothing.
      if (unit === "seconds") {
        expect(seen.size, "no marketing surface quotes a speed at all").toBeGreaterThan(0);
      }
      if (seen.size > 1) {
        const detail = [...seen.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([n, wheres]) => `        ${n} ${unit} — ${wheres.join(" ; ")}`)
          .join("\n");
        offenders.push(
          `the product is advertised with ${seen.size} different values for "${unit}":\n${detail}`,
        );
      }
    }
    expect(offenders.join("\n")).toBe("");
  });

  it("promises no date on the public roadmap", () => {
    // RoadmapPage's own header: "Never label anything 'shipping next
    // month' unless you're literally 2 weeks from beta", and its status
    // vocabulary (research / in-design / planning / backlog) exists so a
    // date is never needed. The plant read "Shipping Q2 2026" — already
    // in the past on the day it was planted. A date that has passed on
    // an unshipped feature is the worst version of this claim, so the
    // law is the stricter one the file already states: no date at all.
    const DATE = /\bQ[1-4]\s*'?\d{2,4}\b|\b(?:H[12])\s*'?\d{2,4}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|\b20\d\d\b|\bshipping\s+(?:next|in|by)\b/i;
    const offenders: string[] = [];
    for (const line of MARKETING) {
      if (!line.where.startsWith("RoadmapPage.tsx")) continue;
      const hit = DATE.exec(line.text);
      if (hit) {
        offenders.push(
          `${line.where} promises a date — "${hit[0]}"\n` +
            `      "${line.text.slice(0, 180)}"\n` +
            `      The roadmap's status labels (research / in-design / planning / backlog) ` +
            `carry the timing; a date on this page is a promise nobody committed to.`,
        );
      }
    }
    expect(offenders.join("\n")).toBe("");
  });

  it("names no plan the backend does not sell, on any reachable surface", () => {
    // `_pricing_config.py` sells solo / pro / multi. `starter` is
    // `purchasable=False`; `professional`, `professional_contact`,
    // `business` and `pro_legacy` are LEGACY ALIASES that resolve
    // server-side to a different tier. Copy naming one of those as a
    // plan a customer can be on is a claim the checkout contradicts —
    // `/signup?plan=professional` quoted €499 for a €16.99 plan, and the
    // roadmap plant added `tier_target: "Professional"` beside it.
    //
    // Scoped to marketing surfaces plus REACHABLE code, because the
    // honest fix for a dead offender is deletion by its owning lane, and
    // the quarantine assertion below covers those instead.
    const sellable = sellablePlanWords(PLANS);
    const aliases = parseLegacyAliases();
    const retired = PLANS.filter((p) => !p.purchasable).map((p) => p.key);
    const forbidden = [...new Set([...aliases, ...retired, "enterprise"])].filter(
      (w) => !sellable.has(w.toLowerCase()),
    );
    expect(forbidden.length, "no retired/alias plan words parsed").toBeGreaterThan(2);

    // "Plan"-shaped context only, and MEASURED IN A WINDOW around the
    // word rather than anywhere in the string. The whole-string version
    // red on `lib/legalDocuments.generated.ts`, where the Terms of
    // Service is one 20 KB literal: it contains "business" and
    // "professional" in ordinary legal prose and, somewhere else
    // entirely, a "€". Proximity is what makes "Professional plan" a
    // claim and "professional standard of care" prose.
    const PLAN_CONTEXT = /\bplan(?:s|ul|uri)?\b|\btier\b|\bsubscription\b|\babonament\b|\/month|\/mo\b|€\d|\bupgrade\b/i;
    const WINDOW = 60;
    const offenders: string[] = [];
    for (const line of [...MARKETING, ...COPY.filter((l) => l.where.startsWith("code "))]) {
      if (line.where.startsWith("code ")) {
        const rel = line.where.slice("code ".length);
        if (!REACHABLE.has(join(REPO, rel))) continue;
      }
      // A STRUCTURED FIELD whose name is the context. `RoadmapPage.tsx
      // tier_target` holds the bare word "Professional" with no
      // surrounding sentence, and the page renders it as "Target:
      // Professional" — a plan claim by virtue of the field it sits in.
      // Measured: with text-window context only, the verifier's planted
      // `tier_target: "Professional"` passed this law. Deliberately NOT
      // computed from `where` in general: every literal in
      // `lib/plans.ts` would inherit "plan" from its own filename.
      const keyIsPlanField =
        line.where.startsWith("RoadmapPage.tsx") && /tier|plan/i.test(line.where);

      // An IDENTIFIER is not a claim. `lib/plans.ts` lists "starter" in
      // ALL_PLAN_IDS on purpose — it is the set used to validate a
      // persisted row, and a retired key must still parse. A plan claim
      // a customer can read is prose, so a single-token code literal is
      // out of scope.
      const isBareIdentifier = !/\s/.test(line.text.trim());
      if (line.where.startsWith("code ") && isBareIdentifier) continue;

      for (const word of forbidden) {
        const rx = new RegExp(`\\b${word.replace(/_/g, "[ _]")}\\b`, "gi");
        for (const hit of line.text.matchAll(rx)) {
          const at = hit.index ?? 0;
          const around = line.text.slice(
            Math.max(0, at - WINDOW),
            at + hit[0].length + WINDOW,
          );
          if (!keyIsPlanField && !PLAN_CONTEXT.test(around)) continue;
          offenders.push(
            `${line.where} names plan "${hit[0]}" in a plan context — ` +
              `_pricing_config.py sells only [${[...sellable].sort().join(", ")}]\n` +
              `      "…${around.replace(/\s+/g, " ").trim()}…"`,
          );
        }
      }
    }
    expect(offenders.join("\n")).toBe("");
  });

  it("resolves, on a signup surface, only plan ids the backend sells", () => {
    // The other half of the €499 chip: AuthCard resolves `?plan=` through
    // lib/plans.ts. That module's id set must equal the backend's
    // purchasable recurring plans — no more (a retired or aliased id
    // resolving is how the wrong price got quoted) and no fewer (a real
    // plan missing is why /signup?plan=solo silently did nothing).
    const src = readFileSync(join(FRONTEND, "lib/plans.ts"), "utf8");
    const m = /SELLABLE_PLAN_IDS[^=]*=\s*\[([^\]]*)\]/.exec(src);
    expect(m, "SELLABLE_PLAN_IDS not found in lib/plans.ts").not.toBeNull();
    const declared = [...(m as RegExpExecArray)[1].matchAll(/"([a-z_]+)"/g)]
      .map((x) => x[1])
      .sort();
    const expected = PLANS.filter((p) => p.purchasable && p.recurring)
      .map((p) => p.key)
      .sort();
    expect(expected.length, "no purchasable recurring plan parsed").toBeGreaterThan(1);
    expect(
      declared,
      `lib/plans.ts SELLABLE_PLAN_IDS is [${declared.join(", ")}]; ` +
        `_pricing_config.py sells [${expected.join(", ")}]`,
    ).toEqual(expected);

    // And NO NUMBER OF ITS OWN. A price the frontend keeps is a price
    // that can drift from the one the customer is charged — this module
    // held €99 / €499 against a backend selling €4.99 / €9.99 / €16.99.
    //
    // The law is "no numeric literal", not "no price-shaped literal".
    // Measured while writing it: a keyword-and-colon pattern
    // (`/(monthly|price|eur|€)\s*[:=]\s*\d/i`) did NOT red on a planted
    // `export const SOLO_MONTHLY_EUR = 4.99;`, because `_` is a word
    // character so `\beur` never matched inside `MONTHLY_EUR`. A gate
    // that cannot catch its own plant is not a gate. This module holds
    // identities and nothing else, so any number in it is out of place.
    // Comments are stripped first: the header quotes the old €499 and
    // the real €16.99 while explaining the defect, which is exactly the
    // documentation that should survive.
    const code = stripComments(src);
    const numbers = [...code.matchAll(/(?<![\w.])\d+(?:\.\d+)?/g)].map((m) => m[0]);
    expect(
      numbers,
      `lib/plans.ts carries numeric literal(s) [${numbers.join(", ")}] — this ` +
        `module names plans; every amount belongs to lib/pricingConfig.ts, ` +
        `which reads GET /api/pricing/config`,
    ).toEqual([]);
    expect(code.includes("€"), "lib/plans.ts quotes a price in euros").toBe(false);
  });

  it("quotes only prices the backend charges, wherever a price is printed", () => {
    // The generalisation of the €499 chip. Every euro amount a customer
    // can read must be one `_pricing_config.py` actually charges: a plan
    // price, an overage price, or zero.
    //
    // Landing.tsx is included by NUMERIC CONSTANT, not by string
    // harvest: it builds its pricing cards as `€${SOLO_MONTHLY}` from
    // `const SOLO_MONTHLY = 4.99`, so the digits never appear inside a
    // string literal and the copy sweep cannot see them. Measured today
    // they are right (4.99 / 9.99, matching solo / pro); the point of
    // the assertion is that they stay right when the backend changes.
    const charged = new Set<number>([0]);
    const cfg = readFileSync(PRICING_CONFIG_PY, "utf8");
    for (const m of cfg.matchAll(/_env_float\(\s*"[A-Z_]+"\s*,\s*(\d+(?:\.\d+)?)\s*\)/g)) {
      charged.add(Number(m[1]));
    }
    expect(charged.size, "no prices parsed out of _pricing_config.py").toBeGreaterThan(4);

    const offenders: string[] = [];

    // (a) Prices written into marketing copy, either currency order.
    for (const line of MARKETING.filter(isPureMarketing)) {
      for (const m of line.text.matchAll(/€\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*€/g)) {
        const raw = (m[1] ?? m[2]).replace(",", ".");
        const value = Number(raw);
        if (charged.has(value)) continue;
        offenders.push(
          `${line.where} prints €${raw} — _pricing_config.py charges ` +
            `[${[...charged].sort((a, b) => a - b).join(", ")}]\n` +
            `      "${line.text.slice(0, 160)}"`,
        );
      }
    }

    // (b) The landing's own price constants.
    const landing = stripComments(
      readFileSync(join(FRONTEND, "pages/cfo/Landing.tsx"), "utf8"),
    );
    const consts = [...landing.matchAll(/const\s+([A-Z0-9_]*MONTHLY[A-Z0-9_]*)\s*=\s*(\d+(?:\.\d+)?)/g)];
    expect(
      consts.length,
      "Landing.tsx declares no *MONTHLY* price constant — if the pricing cards " +
        "were rebuilt, point this assertion at whatever now holds the numbers",
    ).toBeGreaterThan(0);
    for (const [, name, raw] of consts) {
      if (charged.has(Number(raw))) continue;
      offenders.push(
        `Landing.tsx ${name} = ${raw} — _pricing_config.py charges ` +
          `[${[...charged].sort((a, b) => a - b).join(", ")}]`,
      );
    }

    expect(offenders.join("\n")).toBe("");
  });

  it("states the market provenance and cadence the code actually implements", () => {
    // C2 — the assertion the copy gate lacked entirely.
    //
    // Two authorities, deliberately different ones:
    //   · which MARKETS may be named as delivering financials comes from
    //     `public_market/markets.yaml` (a market with
    //     `fundamentals_source: none` has never produced a figure);
    //   · the price CADENCE comes from `_BVB_QUOTES_TTL_S` in
    //     `engine/public/universe_service.py`, which is the code that
    //     serves this page. markets.yaml's `price_source: none` for `ro`
    //     is a fact about a DIFFERENT package and must not be used here —
    //     see parseBvbQuoteTtlMinutes for why a law built on it would red
    //     on correct copy.
    expect(MARKETS.length, "markets.yaml did not parse").toBeGreaterThanOrEqual(9);
    const noFeed = MARKETS.filter((m) => m.fundamentals === "none").map((m) => m.id);
    expect(noFeed, "expected at least de/cn/ae to have no feed").toEqual(
      expect.arrayContaining(["de", "cn", "ae"]),
    );

    const ttlMinutes = parseBvbQuoteTtlMinutes();
    expect(ttlMinutes, "BVB quote TTL did not parse").toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const line of MARKETING) {
      // A "refreshes every N minutes" claim must equal the real TTL.
      for (const m of line.text.matchAll(
        /(?:every|la|refresh\w*\s+every)\s*(\d+)\s*(?:minutes?|minute|min\b)/gi,
      )) {
        if (Number(m[1]) !== ttlMinutes) {
          offenders.push(
            `${line.where}: "${m[0].trim()}" — the quote cache TTL ` +
              `(_BVB_QUOTES_TTL_S) is ${ttlMinutes} minutes`,
          );
        }
      }
      // Fundamentals are ANNUAL statutory filings: bvb_seed's ANAF
      // overlay carries one filing per company per fiscal YEAR. Copy may
      // not describe them as end-of-day, daily or live.
      //
      // Checked CLAUSE BY CLAUSE, not over the whole string. A footer
      // that correctly says "Fundamentals are annual statutory filings.
      // Prices are the last daily close." is two separate true claims,
      // and a line-level check would red on it for containing the word
      // "daily" — a gate reding on correct copy.
      for (const clause of line.text.split(/[.;·]|(?:\s—\s)/)) {
        if (!/\bfundamentals\b|\bcifrele? fundamentale\b/i.test(clause)) continue;
        const bad =
          /\bend[- ]of[- ]day\b|\bdaily\b|\breal[- ]time\b|\bînchiderea zilei\b|\bzilnice?\b|\bîn timp real\b/i.exec(
            clause,
          );
        if (bad) {
          offenders.push(
            `${line.where}: describes fundamentals as "${bad[0]}" — the ANAF ` +
              `bilanț overlay (bvb_seed._apply_anaf_cache) carries ONE ANNUAL ` +
              `filing per company; nothing refreshes them daily\n` +
              `      "${clause.trim().slice(0, 200)}"`,
          );
        }
      }
    }
    expect(offenders.join("\n")).toBe("");
  });

  it("keeps claim-carrying dead copy out of the bundle, and the list from growing", () => {
    // C5. Each quarantined module is measured false against live code
    // (see DEAD_COPY_QUARANTINE). They stay because the locale files are
    // shared mid-wave and the components belong to another lane —
    // deleting a 97-key block from a concurrently-edited file is the
    // worse regression. What the gate CAN guarantee is that none of them
    // reaches a customer, and that the list does not grow quietly.
    const wokenUp: string[] = [];
    for (const rel of DEAD_COPY_QUARANTINE) {
      const abs = join(FRONTEND, rel);
      if (!existsSync(abs)) continue; // deleted outright — the better fix
      if (REACHABLE.has(abs)) {
        wokenUp.push(
          `frontend/${rel} is now imported from main.tsx. It carries claims ` +
            `measured false on 2026-09-08 (see DEAD_COPY_QUARANTINE). Fix the ` +
            `copy against the live code, or delete the module, before wiring it up.`,
        );
      }
    }
    expect(wokenUp.join("\n")).toBe("");

    // The `landing.*` i18n namespace has no reader outside the
    // quarantined components. If a reachable module starts reading it,
    // that copy is live and its numbers must be repaired first.
    const readers: string[] = [];
    for (const file of walk(FRONTEND)) {
      if (!REACHABLE.has(file)) continue;
      const rel = file.slice(FRONTEND.length + 1);
      if (DEAD_COPY_QUARANTINE.includes(rel)) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      const hit = /\bt\(\s*["'`]landing\.[a-zA-Z0-9_.]+/.exec(src);
      if (hit) {
        readers.push(
          `frontend/${rel} reads ${hit[0].slice(hit[0].indexOf("landing."))} — the ` +
            `landing.* namespace sells "5,000+ NASDAQ + NYSE companies" on a ` +
            `product filtered to BVB only, and "108 concepts" against 118.`,
        );
      }
    }
    expect(readers.join("\n")).toBe("");
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
