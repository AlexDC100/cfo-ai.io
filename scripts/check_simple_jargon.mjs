#!/usr/bin/env node
/**
 * THE DIAL — gate M3: Simple-mode jargon lint.
 *
 * Simple mode exists so an owner never meets a bare financial acronym.
 * The glossary's dual-label convention ("Profit before financing &
 * depreciation (EBITDA)") is the ONLY sanctioned way a restricted term
 * reaches a Simple string — plain words first, the term in parentheses
 * so the reader learns the vocabulary instead of being ambushed by it.
 *
 * WHAT IS SCANNED (the Simple namespace):
 *   · any strings file under frontend/ whose name contains "simple",
 *     "story" (storyStrings), "rolechip"/"roleChips", or "explain"
 *     (explain templates) — .json, .ts, .tsx;
 *   · frontend/lib/contextLines.ts — the deterministic Simple-mode
 *     sentence templates (canonical Simple copy, name notwithstanding);
 *   · frontend/lib/glossary.ts — ONLY the `simple:` label blocks. The
 *     `term:` blocks are Pro labels (a bare term is their whole job)
 *     and the `plain:` blocks are the definitions reached THROUGH a
 *     <Term> affordance — both out of scope here, covered by gate M2.
 *
 * WHAT IS ALLOWED:
 *   · a restricted term whose nearest preceding non-space char is "("
 *     — the dual-label form;
 *   · strings under a key that ends in .pro / _pro / "Pro" (Pro-mode
 *     copy may speak the language of the trade);
 *   · comments (never rendered).
 *
 * ALSO (advisory, does not fail the gate): a readability smoke — any
 * Simple sentence longer than 140 characters is reported. Long
 * sentences are the soft failure mode of "plain language".
 *
 * Zero dependencies. Exit 1 on jargon hits; readability is advisory.
 * Run: node scripts/check_simple_jargon.mjs
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname — the repo path contains spaces.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FE = join(ROOT, "frontend");

// ── the restricted list ────────────────────────────────────────────────
// Maintain WITH comments. A term earns a row when it is trade shorthand
// an SME owner cannot be assumed to know. Acronyms match ALL-CAPS only
// (lowercase "nav"/"dso" in prose is not the finance term); word terms
// match any case incl. Romanian inflections (covenantul, covenantele).
const RESTRICTED = [
  { id: "EBITDA", re: /\bEBITDA\b/g }, // earnings before interest/tax/D&A
  { id: "DSCR", re: /\bDSCR\b/g }, // debt service coverage ratio
  { id: "DSO", re: /\bDSO\b/g }, // days sales outstanding
  { id: "DPO", re: /\bDPO\b/g }, // days payables outstanding
  { id: "DIO", re: /\bDIO\b/g }, // days inventory outstanding
  { id: "covenant", re: /\bcovenant(?:ul|ele|elor|e|s)?\b/gi }, // loan condition (RO inflections included)
  { id: "leverage", re: /\bleverage[ds]?\b/gi }, // reliance on debt
  { id: "CAPEX", re: /\bcapex\b/gi }, // capital expenditure (any casing is the term)
  { id: "YoY", re: /\byoy\b/gi }, // year over year (any casing is the term)
  { id: "LTM", re: /\bLTM\b/g }, // last twelve months
  { id: "NAV", re: /\bNAV\b/g }, // net asset value (caps only — "nav" is navigation)
  { id: "WACC", re: /\bWACC\b/g }, // weighted average cost of capital
];

const MAX_SENTENCE_CHARS = 140;

// ── scope: which files form the Simple namespace ───────────────────────

const SKIP_DIRS = new Set(["node_modules", "dist", ".vite"]);
const NAME_RE = /simple|story|rolechip|explain/i;
// "History"/"PriceHistory" contain "story" — strip that stem before the
// name test so MultiYearHistory.tsx etc. don't false-positive into scope.
const nameForMatch = (base) => base.replace(/histor/gi, "");
const EXTS = new Set([".json", ".ts", ".tsx"]);

const rel = (p) => relative(ROOT, p).split(sep).join("/");
const isTestFile = (f) =>
  /(\.test\.|\.spec\.)/.test(f) || f.includes("/__tests__/") || f.includes("/test/");

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(p);
    } else if (EXTS.has(p.slice(p.lastIndexOf(".")))) {
      yield p;
    }
  }
}

// Canonical Simple copy scanned regardless of filename. glossary.ts is
// special-cased (simple: blocks only) in scanGlossary below.
const ALWAYS_SCAN = new Set(["frontend/lib/contextLines.ts"]);
const GLOSSARY_FILE = "frontend/lib/glossary.ts";

const files = [];
for (const abs of walk(FE)) {
  const f = rel(abs);
  if (isTestFile(f)) continue;
  if (f === GLOSSARY_FILE) continue; // handled structurally below
  // "storyboard"/"history" style accidents: require the name match on the
  // BASENAME, not the directory, so a components/story/ dir doesn't drag
  // every file in — only strings-bearing names.
  const base = f.slice(f.lastIndexOf("/") + 1);
  if (ALWAYS_SCAN.has(f) || NAME_RE.test(nameForMatch(base))) files.push({ abs, f });
}

// ── string extraction ──────────────────────────────────────────────────

/** A key that marks Pro-mode copy: endsWith .pro / _pro / Pro. */
const isProKey = (key) => /(\.pro|_pro|Pro)$/.test(key) || key === "pro";

/** Pull string literals out of one line of TS/TSX source. Handles
 *  "..." '...' and single-line `...` template chunks. Good enough for
 *  strings files; multi-line templates are scanned line by line. */
function literalsInLine(line) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** Nearest preceding non-space char is "(" → dual-label form, allowed. */
function isDualLabeled(str, index) {
  for (let i = index - 1; i >= 0; i--) {
    const c = str[i];
    if (c === " " || c === " ") continue;
    return c === "(";
  }
  return false;
}

const jargonHits = []; // { file, line, term, excerpt }
const readabilityHits = []; // { file, line, chars, excerpt }

function checkString(str, file, line) {
  for (const { id, re } of RESTRICTED) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(str)) !== null) {
      if (isDualLabeled(str, m.index)) continue;
      jargonHits.push({
        file,
        line,
        term: id,
        excerpt: str.length > 80 ? str.slice(0, 77) + "…" : str,
      });
    }
  }
  // Readability smoke: sentence length. Template interpolations count as
  // written — the reader gets the substituted text, roughly same length.
  for (const sentence of str.split(/[.!?]+/)) {
    const s = sentence.trim();
    if (s.length > MAX_SENTENCE_CHARS) {
      readabilityHits.push({
        file,
        line,
        chars: s.length,
        excerpt: s.slice(0, 77) + "…",
      });
    }
  }
}

// ── scanners per file kind ─────────────────────────────────────────────

function scanJson(abs, file) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    console.error(`  ! ${file}: unparseable JSON — skipped (fix the file)`);
    return;
  }
  // Line numbers for JSON: find the value's first occurrence. Cheap and
  // honest enough for a strings file where values are unique-ish.
  const raw = readFileSync(abs, "utf8").split("\n");
  const lineOf = (value) => {
    const needle = JSON.stringify(value).slice(1, -1).slice(0, 40);
    const idx = raw.findIndex((l) => l.includes(needle));
    return idx >= 0 ? idx + 1 : 1;
  };
  (function visit(node, path) {
    if (typeof node === "string") {
      const key = path[path.length - 1] ?? "";
      if (path.some((seg) => isProKey(String(seg)))) return; // Pro namespace
      void key;
      checkString(node, file, lineOf(node));
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, [...path, i]));
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) visit(v, [...path, k]);
    }
  })(doc, []);
}

function scanTs(abs, file) {
  const lines = readFileSync(abs, "utf8").split("\n");
  let inBlockComment = false;
  lines.forEach((line, i) => {
    let code = line;
    if (inBlockComment) {
      const end = code.indexOf("*/");
      if (end === -1) return;
      code = code.slice(end + 2);
      inBlockComment = false;
    }
    const bcStart = code.indexOf("/*");
    if (bcStart !== -1 && code.indexOf("*/", bcStart + 2) === -1) {
      code = code.slice(0, bcStart);
      inBlockComment = true;
    }
    // Strip line comments (naive but fine for strings files — a "//"
    // inside a literal would truncate, so only strip when the // is not
    // preceded by a quote character on the same side; simplest robust
    // rule: strip from the LAST "//" only if no quote follows it).
    const lc = code.indexOf("//");
    if (lc !== -1 && !/["'`]/.test(code.slice(lc))) code = code.slice(0, lc);
    if (!code.trim()) return;
    // Pro-namespace key on this line exempts the line's literals.
    if (/^\s*["']?[\w.$-]*(\.pro|_pro|Pro)["']?\s*:/.test(code)) return;
    // Non-copy literals in TS/TSX: imports, Tailwind class lists, and
    // single-token strings (glossary ids, testids, matcher keys like
    // n.includes("leverage")) are code, not rendered Simple copy. The
    // known gap — a single-word LABEL written inline in TS escapes this
    // lint — is accepted; the house pattern keeps copy in *.json strings
    // files, which are scanned in full.
    if (/^\s*import\b/.test(code) || /className\s*[=:]/.test(code)) return;
    for (const lit of literalsInLine(code)) {
      if (!/\s/.test(lit.trim())) continue; // single token = code, not copy
      checkString(lit, file, i + 1);
    }
  });
}

/** glossary.ts — scan ONLY the `simple:` label blocks. */
function scanGlossary() {
  const abs = join(ROOT, GLOSSARY_FILE);
  let raw;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    console.error(`  ! ${GLOSSARY_FILE}: missing — glossary moved? update this gate`);
    process.exitCode = 1;
    return;
  }
  const lines = raw.split("\n");
  let inSimple = false;
  lines.forEach((line, i) => {
    const oneLiner = /^\s*simple:\s*\{.*\},?\s*$/.test(line);
    if (oneLiner) {
      for (const lit of literalsInLine(line)) checkString(lit, GLOSSARY_FILE, i + 1);
      return;
    }
    if (/^\s*simple:\s*\{\s*$/.test(line)) {
      inSimple = true;
      return;
    }
    if (inSimple) {
      if (/^\s*\},?\s*$/.test(line)) {
        inSimple = false;
        return;
      }
      for (const lit of literalsInLine(line)) checkString(lit, GLOSSARY_FILE, i + 1);
    }
  });
}

// ── run ────────────────────────────────────────────────────────────────

console.log("M3 jargon lint — Simple-namespace scan\n");
console.log("files in scope:");
console.log(`  ${GLOSSARY_FILE} (simple: labels only)`);
for (const { f } of files) console.log(`  ${f}`);
if (files.length <= 1) {
  console.log(
    "  (note: no *simple*/story/roleChip/explain strings files exist yet —" +
      " the gate covers what is on disk and will pick new ones up by name)",
  );
}

scanGlossary();
for (const { abs, f } of files) {
  if (f.endsWith(".json")) scanJson(abs, f);
  else scanTs(abs, f);
}

console.log(
  `\nM3-JARGON — bare restricted term in a Simple string: ${
    jargonHits.length ? jargonHits.length + " violation(s)" : "clean"
  }`,
);
for (const h of jargonHits) {
  console.log(`  ${h.file}:${h.line}:${h.term}  "${h.excerpt}"`);
}

console.log(
  `\nM3-READABILITY (advisory) — sentence > ${MAX_SENTENCE_CHARS} chars: ${
    readabilityHits.length ? readabilityHits.length + " flag(s)" : "clean"
  }`,
);
for (const h of readabilityHits) {
  console.log(`  ${h.file}:${h.line} (${h.chars} chars)  "${h.excerpt}"`);
}

console.log(`\njargon lint: ${jargonHits.length === 0 ? "PASS" : "FAIL"}`);
process.exit(jargonHits.length === 0 ? 0 : 1);
