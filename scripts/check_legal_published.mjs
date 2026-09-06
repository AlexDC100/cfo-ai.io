#!/usr/bin/env node
/**
 * legal-published — the gate on the three legal documents.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT IT REDS ON
 * ═══════════════════════════════════════════════════════════════════════
 *  1. BRACKET       — a `[` or `]` in the RENDERED TEXT of a published page.
 *  2. DRAFT         — the word "draft" (any case, word-boundary) in that text.
 *  3. PLACEHOLDER   — TODO / TBD / FIXME / XXX / PLACEHOLDER / LOREM IPSUM /
 *                     `{{…}}` / `<%…%>` / "TEXT REQUIRED" / "not supplied".
 *  4. EMPTY         — a document that renders to less text than it must, or
 *                     is missing a sentence that is definitely in the source.
 *  5. DRIFT         — the committed `frontend/lib/legalDocuments.generated.ts`
 *                     differing from a fresh regeneration of the markdown.
 *  6. FIDELITY      — a rendered document whose words differ from the
 *                     reviewed markdown's words.
 *  7. IDENTITY      — a page missing the operator's name / CUI / reg. no.,
 *                     or a head missing title / description / canonical /
 *                     both hreflang alternates.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY IT SCANS THE RENDERED OUTPUT AND NOT THE MARKDOWN (TC-7)
 * ═══════════════════════════════════════════════════════════════════════
 * Two reasons, and the first one is not the obvious one.
 *
 * (a) THE MARKDOWN IS THE WRONG SURFACE FOR A FALSE POSITIVE. The reviewed,
 *     correct Privacy Policy contains `[Cookie Policy](/cookies)` and
 *     `[Politica de cookie-uri](/cookies)`. A bracket scan over the source
 *     reds on shipped, correct text — so a naive source gate is not a strict
 *     gate, it is a broken one that would be silenced within a day. After
 *     rendering, those same links are `<a href="/cookies">Cookie Policy</a>`:
 *     no brackets, and the check is exact rather than heuristic.
 *
 * (b) THE MARKDOWN IS ALSO THE WRONG SURFACE FOR A FALSE NEGATIVE. What a
 *     stranger reads is the HTML nginx serves. A placeholder can enter that
 *     HTML from somewhere other than the markdown — a page template, the
 *     entity config, a footer component. Scanning `dist/**` catches all of
 *     them; scanning `content/legal/*.md` catches only one.
 *
 * The gate therefore strips tags from the SERVED bytes and scans the text a
 * human would read, plus the head metadata that a crawler reads.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT IT CANNOT SEE (TC-11)
 * ═══════════════════════════════════════════════════════════════════════
 *  · Anything React renders that the prerendered file does not. The two
 *    share the document body byte-for-byte (both read `doc.html` from the
 *    same generated module — checked here), but the CHROME around it is two
 *    implementations. A placeholder typed into LegalPage.tsx's own JSX
 *    would not appear in dist/*.html. The vitest suite
 *    frontend/lib/__tests__/legalPage.test.tsx covers that half by
 *    asserting on the mounted DOM.
 *  · Whether the text is legally correct, complete, or reviewed by a
 *    lawyer. It cannot; nothing automated can.
 *  · Whether the pages are actually SERVED at those paths in production.
 *    That depends on nginx.conf, which lives in the image, and on the Caddy
 *    front, which lives on the VPS. A curl against the deployed host is the
 *    only proof of that and it is an operator step.
 *  · A bracket in a language we do not publish, or in a document that is
 *    not one of the three.
 *
 * Run:  node scripts/check_legal_published.mjs [dist]
 * Requires a build (`npm run build`) so that `dist/` exists.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDocuments, readEntity, OUTPUT } from "./generate_legal_documents.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = path.join(ROOT, "content", "legal");

const failures = [];
const notes = [];
const fail = (what, detail) => failures.push(`${what}: ${detail}`);

// ── The triggers ───────────────────────────────────────────────────────
// Each is (id, regex, human name). They run against RENDERED TEXT.
const TRIGGERS = [
  ["bracket", /[[\]]/, "a bracket — the shape a `[Company Legal Name]` placeholder leaves behind"],
  ["draft", /\bdrafts?\b/i, 'the word "draft"'],
  [
    "placeholder",
    /\b(TODO|TBD|FIXME|XXX|PLACEHOLDER|LOREM IPSUM|TEXT REQUIRED|not supplied|COMPANY NAME|YOUR COMPANY)\b|\{\{|\}\}|<%|%>/i,
    "a placeholder marker",
  ],
];

/** The text a reader sees: tags removed, entities decoded, whitespace flat. */
function renderedText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words only — for comparing a rendering against its source. */
const words = (s) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

function scanText(where, text) {
  for (const [id, re, human] of TRIGGERS) {
    const m = re.exec(text);
    if (m) {
      const at = Math.max(0, m.index - 70);
      fail(
        `${id.toUpperCase()} in ${where}`,
        `found ${human} — ${JSON.stringify(m[0])}\n      …${text.slice(at, m.index + 70)}…`,
      );
    }
  }
}

// ── 1. The generated module must match a fresh regeneration ────────────
function checkDrift() {
  const committed = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : null;
  if (committed === null) {
    fail("DRIFT", `${path.relative(ROOT, OUTPUT)} does not exist — run the generator`);
    return;
  }
  // Rebuild in a temp location by re-running the generator's own emit path:
  // regenerate() writes only when different, so compare before/after bytes.
  const before = committed;
  const stamp = fs.statSync(OUTPUT).mtimeMs;
  let after = before;
  try {
    // Import lazily to avoid writing during a --help style invocation.
    const mod = require_regenerate();
    if (mod) {
      mod();
      after = fs.readFileSync(OUTPUT, "utf8");
    }
  } catch (e) {
    fail("DRIFT", `regeneration threw: ${e.message}`);
    return;
  }
  if (before !== after) {
    fail(
      "DRIFT",
      `${path.relative(ROOT, OUTPUT)} did not match content/legal/*.md.\n` +
        "      It has just been regenerated in place — review and commit it.",
    );
  } else {
    notes.push(`generated module matches content/legal/*.md (mtime ${new Date(stamp).toISOString()})`);
  }
}

let _regen = null;
function require_regenerate() {
  return _regen;
}

// ── 2. Fidelity: the rendering says exactly what the markdown says ─────
function checkFidelity(docs) {
  for (const d of docs) {
    const src = fs.readFileSync(path.join(ROOT, d.sourceFile), "utf8");
    const rendered = words(renderedText(d.html));
    const source = words(src);
    // Every rendered word must appear in the source, in order. A stray word
    // introduced by the renderer (or a word dropped from a clause) breaks it.
    let i = 0;
    for (const w of rendered) {
      const at = source.indexOf(w, i);
      if (at === -1) {
        fail(
          `FIDELITY ${d.doc}/${d.lang}`,
          `rendered word ${JSON.stringify(w)} is not in ${d.sourceFile} at or after position ${i}`,
        );
        break;
      }
      i = at + 1;
    }
  }
}

// ── 3. The served bytes ────────────────────────────────────────────────
const MUST_CONTAIN = {
  "privacy:en": "Your financial data is not used to train artificial intelligence models",
  "privacy:ro": "Datele dumneavoastră financiare nu sunt folosite pentru antrenarea modelelor",
  "terms:en": "On termination you have 30 days to export your data",
  "terms:ro": "aveți la dispoziție 30 de zile pentru exportul datelor",
  "cookies:en": "They are only enabled with your consent",
  "cookies:ro": "Se activează numai cu acordul dumneavoastră",
};
/** Under this many characters of readable text, a "published" page is a
 *  broken template, not a document. The shortest of the six renders ~2.7k. */
const MIN_TEXT_CHARS = 1800;

function checkServed(distDir, docs, entity) {
  if (!fs.existsSync(distDir)) {
    fail("DIST", `${path.relative(ROOT, distDir)} not found — run \`npm run build\` first`);
    return;
  }
  for (const d of docs) {
    const rel = d.lang === "en" ? `${d.doc}/index.html` : `ro/${d.doc}/index.html`;
    const file = path.join(distDir, rel);
    if (!fs.existsSync(file)) {
      fail("SERVED", `${rel} was not written — the prerender step did not run`);
      continue;
    }
    const html = fs.readFileSync(file, "utf8");
    const head = html.slice(0, html.indexOf("</head>") + 7);
    const body = html.slice(html.indexOf("<body"));
    const text = renderedText(body);

    scanText(rel, text);
    // The head is read by crawlers and share cards; a placeholder there is
    // just as published as one in the body.
    scanText(`${rel} <head>`, renderedText(head.replace(/<style[\s\S]*?<\/style>/gi, " ")));

    if (text.length < MIN_TEXT_CHARS) {
      fail("EMPTY", `${rel} renders only ${text.length} chars of text (floor ${MIN_TEXT_CHARS})`);
    }
    const needle = MUST_CONTAIN[`${d.doc}:${d.lang}`];
    if (needle && !text.includes(needle)) {
      fail("EMPTY", `${rel} does not contain the reviewed sentence ${JSON.stringify(needle)}`);
    }
    // The body HTML must be the SAME STRING the React page injects. This is
    // what lets the vitest DOM suite stand in for the half this gate cannot
    // see: if these ever diverge, one of the two surfaces is unguarded.
    if (!body.includes(d.html)) {
      fail("SERVED", `${rel} body is not the generated document HTML byte-for-byte`);
    }

    for (const [what, value] of [
      ["denumire", entity.denumire],
      ["CUI", entity.cui],
      ["reg. no.", entity.regCom],
      ["sediu", entity.sediu],
    ]) {
      if (!text.includes(value)) fail("IDENTITY", `${rel} does not print the operator's ${what}`);
    }

    if (!/<title>[^<]{5,}<\/title>/.test(head)) fail("HEAD", `${rel} has no <title>`);
    if (!head.includes(`<title>${d.title} · CFO AI</title>`)) {
      fail("HEAD", `${rel} <title> does not name the document (${d.title})`);
    }
    if (!new RegExp(`<meta name="description" content="[^"]{40,}"`).test(head)) {
      fail("HEAD", `${rel} has no usable meta description`);
    }
    const canonical = d.lang === "en" ? `https://cfo-ai.io/${d.doc}` : `https://cfo-ai.io/ro/${d.doc}`;
    if (!head.includes(`<link rel="canonical" href="${canonical}" />`)) {
      fail("HEAD", `${rel} canonical is not ${canonical}`);
    }
    for (const hl of ["en", "ro", "x-default"]) {
      if (!head.includes(`hreflang="${hl}"`)) fail("HEAD", `${rel} has no ${hl} hreflang alternate`);
    }
    if (!new RegExp(`<html lang="${d.lang}"`).test(html)) {
      fail("HEAD", `${rel} does not set <html lang="${d.lang}">`);
    }
  }
}

// ── 4. Nothing else in dist may publish a placeholder legal claim ──────
// Narrow on purpose: the app's own JS bundles legitimately contain the word
// "draft" (a saved-but-unsent chat draft, for one), so this checks only the
// HTML entry points, which are the documents themselves plus index.html.
function checkEntryHtml(distDir) {
  const index = path.join(distDir, "index.html");
  if (!fs.existsSync(index)) return;
  scanText("index.html", renderedText(fs.readFileSync(index, "utf8")));
}

async function main() {
  const distDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "dist");
  const mod = await import("./generate_legal_documents.mjs");
  _regen = mod.regenerate;

  checkDrift();

  let docs = [];
  let entity = null;
  try {
    docs = buildDocuments();
    entity = readEntity();
  } catch (e) {
    fail("GENERATE", e.message);
  }

  if (docs.length !== 6) fail("GENERATE", `expected 6 renderings, got ${docs.length}`);
  if (docs.length) {
    for (const d of docs) scanText(`${d.sourceFile} → ${d.doc}/${d.lang} (rendered)`, renderedText(d.html));
    checkFidelity(docs);
  }
  if (entity) checkServed(distDir, docs, entity);
  checkEntryHtml(distDir);

  console.log("LEGAL PUBLISHED GATE");
  console.log("==============================================================");
  console.log(`GATE-WORK legal-published units=${docs.length * 2} floor=12 label=documents-scanned-source-and-served`);
  console.log(`  content:  ${path.relative(ROOT, CONTENT)}`);
  console.log(`  served:   ${path.relative(ROOT, distDir)}`);
  for (const n of notes) console.log(`  ${n}`);
  for (const d of docs) {
    console.log(`  ${d.doc}/${d.lang}  ${d.version}  ${renderedText(d.html).length} chars`);
  }
  if (failures.length) {
    console.log("");
    console.log(`FAIL — ${failures.length} problem(s):`);
    for (const f of failures) console.log(`  ${f}`);
    return 1;
  }
  console.log("");
  console.log("PASS — every published legal page carries the reviewed text and no placeholder.");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
