#!/usr/bin/env node
/**
 * NARRATIVE-UNIT LINT — gates U1 (source) and U3.
 *
 * Production, 2026-08-30 (severity-max). A Critical note rendered
 *
 *     Account 461 (Debitori diverși) holds RON 7,692,203 — 19.6% of
 *     total assets 7.467.122,25 €
 *
 * One claim, two currencies. `c05eab2` contained the render path. This
 * lint attacks the other end: the STRINGS. A narrative sentence that
 * bakes in a currency word, or that formats its own numeral, can never
 * follow the display currency — so the moment anything beside it does,
 * the claim is two-currency again.
 *
 * ── U1-SOURCE ────────────────────────────────────────────────────────
 *   A narrative template must not hard-code a currency label next to an
 *   interpolated value. `RON ${x}` is frozen in RON forever; its
 *   neighbour on screen is not.
 *
 * ── U3 ───────────────────────────────────────────────────────────────
 *   A narrative template must not BUILD a numeral. Placeholders only:
 *   interpolate a value that a unit-aware formatter already rendered,
 *   never `Math.round(n).toLocaleString()`.
 *
 *   This is not style. `toLocaleString()` with no locale follows the
 *   BROWSER: on a `ro-RO` machine it emits `7.692.203`, and the linkify
 *   regex — which requires comma grouping — cannot match that at all.
 *   So on Romanian browsers this prose is unconvertible even where a
 *   conversion path exists, and it is invisible to anyone testing on
 *   `en-*`. That is the defect that hides.
 *
 * ── SCOPE ────────────────────────────────────────────────────────────
 *   Deliberately narrow: the FRONTEND NARRATIVE PRODUCERS the sweep
 *   enumerated (design_review/narrative/SWEEP.md §2.3), listed in
 *   SCOPE below with their sweep ids. A lint that scanned every
 *   template literal in the app would drown in false positives and be
 *   switched off within a week. What is NOT in scope, and why, is
 *   written out in design_review/narrative/GATES.md — read that before
 *   widening this.
 *
 * ── QUARANTINE ───────────────────────────────────────────────────────
 *   Known violations are ENUMERATED with an owner, and the check is
 *   EQUALITY: a new violation fails, and a FIXED violation also fails
 *   ("delete its entry"). The list can only shrink. It is a ratchet,
 *   not an exemption.
 *
 * Zero dependencies.
 *   node scripts/check_narrative_units.mjs
 *   node scripts/check_narrative_units.mjs --self-test   (plants, in memory)
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname — the repo path contains spaces.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── scope ──────────────────────────────────────────────────────────────

/** Frontend narrative producers, with the sweep id each one carries. */
const SCOPE = [
  ["frontend/lib/recommendationRules.ts", "F1"],
  ["frontend/lib/buildCashFlowStatement.ts", "F2"],
  ["frontend/lib/financialReport.ts", "F3"],
  ["frontend/lib/financialValuation.ts", "F4"],
  ["frontend/lib/financialExports.ts", "F11/F12"],
  ["frontend/lib/thresholdSchema.ts", "F13"],
  ["frontend/pages/cfo/Chat.tsx", "F5/F6"],
];

const SWEEP = "design_review/narrative/SWEEP.md";

// ── detectors ──────────────────────────────────────────────────────────

/** A currency word immediately labelling an interpolation:
 *  `RON ${x}` / `${x} RON` / `€${x}`.
 *
 *  The `\$(?!\{)` is load-bearing. Without it, `${a}${b}` reads as
 *  "interpolation followed by a dollar sign" and the lint reports a
 *  currency that is not there — which is how a gate earns its way into
 *  someone's ignore list. */
const CUR = String.raw`(?:\b(?:RON|EUR|USD|lei)\b|€|\$(?!\{))`;
const U1_SOURCE_RX = new RegExp(`${CUR}\\s*\\$\\{|\\}\\s*${CUR}`, "g");

/** A template literal that is NOTHING BUT a currency label and one
 *  interpolation, in EITHER order — a money-stamping helper, frozen to
 *  one currency for every one of its call sites.
 *
 *  `recommendationRules.ts:49` (`RON ${…}`) and `thresholdSchema.ts:40`
 *  (`${…} kRON`) are both this. The scale prefix is included because
 *  `kRON` is a currency with a multiplier, not a different kind of
 *  thing — and a scaled unit that never converts is the same defect
 *  with a 1000x rider attached. */
const CUR_UNIT = String.raw`(?:\b[kKmM]?(?:RON|EUR|USD)\b|\blei\b|€)`;
const U1_HELPER_RX = new RegExp(
  `^\\s*(?:${CUR_UNIT}\\s*\\$\\{[^{}]*\\}|[<>~=\\s]*\\$\\{[^{}]*\\}\\s*${CUR_UNIT})\\s*$`);

/** The template builds its own MONEY numeral.
 *
 *  `toLocaleString()` and not `toFixed()`, on purpose. A ratio, a
 *  percentage, a multiple or a day-count has no currency to follow and
 *  is invariant under the display currency — rendering one inline is
 *  CORRECT, and it is what the reference-quality `contextLines.ts`
 *  does. Flagging those would bury the real finding under sixty
 *  false positives. `toLocaleString()` is the money shape, and it is
 *  the locale-dependent one: with no locale argument it follows the
 *  BROWSER, so on `ro-RO` it emits `7.692.203` — which the linkify
 *  regex cannot match at all. */
const U3_RX = /\$\{[^{}]*\.toLocaleString\s*\(/g;

/** A template literal is NARRATIVE when it reads as a sentence rather
 *  than as a label or a key: three or more words of prose outside the
 *  interpolations. Deliberately generous — a label that trips this is a
 *  sentence in disguise. */
function isNarrative(literal) {
  const prose = literal.replace(/\$\{[^{}]*\}/g, " ");
  const words = prose.match(/[A-Za-zĂÂÎȘȚăâîșț]{2,}/g) || [];
  return words.length >= 3;
}

/** Template literals in a source file, with the line each starts on.
 *  A hand-rolled scan, not a parser: it must not need a toolchain to
 *  run, and backtick literals are unambiguous enough to walk. */
function templateLiterals(src) {
  const out = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\n") { line++; i++; continue; }
    // skip comments and quoted strings so a backtick inside them is inert
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        if (src[i] === "\n") line++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "`") {
      const startLine = line;
      let depth = 0;
      let body = "";
      i++;
      while (i < src.length) {
        const c = src[i];
        if (c === "\\") { body += src.slice(i, i + 2); i += 2; continue; }
        if (c === "\n") line++;
        if (c === "$" && src[i + 1] === "{") { depth++; body += "${"; i += 2; continue; }
        if (c === "}" && depth > 0) { depth--; body += "}"; i++; continue; }
        if (c === "`" && depth === 0) { i++; break; }
        body += c;
        i++;
      }
      out.push({ line: startLine, text: body });
      continue;
    }
    i++;
  }
  return out;
}

/** How many template literals in this source read as narrative. A scoped
 *  file that yields ZERO has either been refactored past this lint or
 *  broken its walker — either way the gate has quietly stopped covering
 *  it, which is worse than failing. */
export function narrativeCount(src) {
  let n = 0;
  for (const lit of templateLiterals(src)) {
    if (U1_HELPER_RX.test(lit.text) || isNarrative(lit.text)) n++;
  }
  return n;
}

function scanSource(src) {
  const findings = [];
  for (const lit of templateLiterals(src)) {
    if (U1_HELPER_RX.test(lit.text)) {
      findings.push({
        code: "U1-HELPER",
        line: lit.line,
        match: lit.text.trim(),
      });
      continue;
    }
    if (!isNarrative(lit.text)) continue;
    for (const [code, rx] of [["U1-SOURCE", U1_SOURCE_RX], ["U3", U3_RX]]) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(lit.text)) !== null) {
        findings.push({
          code,
          line: lit.line + (lit.text.slice(0, m.index).match(/\n/g) || []).length,
          match: m[0].replace(/\s+/g, " ").trim(),
        });
      }
    }
  }
  return findings;
}

// ── quarantine ─────────────────────────────────────────────────────────
//
// file -> code -> count. OWNER is named for every entry. Equality is
// enforced, so this list can only shrink.

const QUARANTINE = {
  // F1 — one `const RON = (n) => \`RON ${Math.round(n).toLocaleString()}\``
  // helper, 27 call sites, rendered raw at RecommendationsView.tsx:100/
  // 107/119 directly above the SAME facts rendered converted at :142.
  // Owner: the recommendations lane.
  "frontend/lib/recommendationRules.ts": { "U1-HELPER": 1 },
  // F2 — the CF notes assert "the statement balances to the BS cash
  // position of RON X within RON 1" while every cell of that statement
  // is converted (CashFlowStatementView.tsx:44).
  // Owner: the cash-flow lane.
  "frontend/lib/buildCashFlowStatement.ts": { "U1-SOURCE": 3, "U3": 3 },
  // F13 — `fmtKron = (v) => \`${v.toFixed(1)} kRON\`` labels its unit
  // honestly, which is more than most of this codebase manages, but the
  // value never converts and it renders inside DecisionRulesModal beside
  // product money that does. Low severity, real class.
  // Owner: the decision-rules lane.
  "frontend/lib/thresholdSchema.ts": { "U1-HELPER": 1 },
};

// ── run ────────────────────────────────────────────────────────────────

function selfTest() {
  const cases = [
    ["U1-SOURCE", "hard-coded currency before an interpolation",
      "const s = `Dividends of RON ${x} were declared but not paid`;", true],
    ["U1-SOURCE", "hard-coded currency after an interpolation",
      "const s = `The company holds ${x} RON in related-party loans`;", true],
    ["U3", "the template formats its own money numeral",
      "const s = `Total assets of ${Math.round(v).toLocaleString()} this period`;", true],
    ["U1-HELPER", "a currency-stamping helper freezes every call site",
      "const RON = (n) => `RON ${Math.round(n).toLocaleString()}`;", true],
    ["U1-HELPER", "the same helper with the unit trailing, and scaled",
      "const fmtKron = (v) => `${v.toFixed(1)} kRON`;", true],
    // ── the inverse plants: these must NOT fire ──────────────────────
    [null, "a unit-aware formatter is the correct shape",
      "const s = `${formatCurrency(v, s.currency)} EBITDA — operating cash`;", false],
    [null, "a currency word as prose, labelling nothing",
      "const s = `Movements in EUR/RON create P&L volatility for the year`;", false],
    [null, "a non-narrative label is out of scope",
      "const k = `${row.id}-code`;", false],
    [null, "a non-currency unit suffix is not a currency",
      "const fmtTons = (v) => `${v.toFixed(1)} t`;", false],
    [null, "a RATIO rendered inline is correct, not a violation",
      "const s = `Leverage sits at ${x.toFixed(1)} times trailing EBITDA`;", false],
    [null, "adjacent interpolations are not a dollar-sign currency",
      "const s = `The company reported ${a}${b} across the whole year`;", false],
    [null, "i18n placeholders carry the value, not the template",
      "const s = t('pl.note.wash', { amount, currency });", false],
  ];
  let bad = 0;
  for (const [code, why, snippet, shouldFire] of cases) {
    const hits = scanSource(snippet);
    const fired = code ? hits.some((h) => h.code === code) : hits.length > 0;
    const ok = fired === shouldFire;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${shouldFire ? "trips" : "quiet"}  ${why}`);
  }
  console.log(bad === 0
    ? "\nSELF-TEST PASS — every detector fires on its plant and stays quiet on its inverse."
    : `\nSELF-TEST FAIL — ${bad} detector(s) do not behave as documented.`);
  return bad === 0 ? 0 : 1;
}

function main() {
  if (process.argv.includes("--self-test")) process.exit(selfTest());

  const problems = [];

  // Manifest integrity: a renamed or deleted surface must fail loudly,
  // not silently shrink the lint's coverage to nothing.
  if (!existsSync(join(ROOT, SWEEP))) {
    problems.push(`MANIFEST  ${SWEEP} is missing — the scope below cites it`);
  }
  const live = {};
  for (const [file, sweepId] of SCOPE) {
    const abs = join(ROOT, file);
    if (!existsSync(abs)) {
      problems.push(`MANIFEST  ${file} (sweep ${sweepId}) no longer exists — ` +
        `it moved or was deleted. Re-point SCOPE; do not just drop the line.`);
      continue;
    }
    const src = readFileSync(abs, "utf8");
    if (narrativeCount(src) === 0) {
      problems.push(`MANIFEST  ${file} (sweep ${sweepId}) yields NO narrative ` +
        `template literals. Either it stopped producing prose — in which ` +
        `case drop it from SCOPE deliberately — or the walker broke and this ` +
        `gate is now covering nothing here.`);
      continue;
    }
    const findings = scanSource(src);
    if (findings.length) {
      live[file] = findings;
    }
  }

  // Ratchet: live must equal quarantine, exactly.
  const files = new Set([...Object.keys(live), ...Object.keys(QUARANTINE)]);
  for (const file of [...files].sort()) {
    const counted = {};
    for (const f of live[file] || []) counted[f.code] = (counted[f.code] || 0) + 1;
    const expected = QUARANTINE[file] || {};
    for (const code of new Set([...Object.keys(counted), ...Object.keys(expected)])) {
      const got = counted[code] || 0;
      const want = expected[code] || 0;
      if (got === want) continue;
      const lines = (live[file] || []).filter((f) => f.code === code)
        .map((f) => `${f.line}: ${f.match}`);
      problems.push(
        got > want
          ? `${code}  ${file}  ${got} violation(s), quarantine allows ${want}\n` +
            lines.map((l) => `            ${l}`).join("\n") +
            `\n            → a narrative sentence must not carry its own currency ` +
            `label or build its own numeral. Fix it; do not widen QUARANTINE.`
          : `${code}  ${file}  ${got} violation(s), quarantine still claims ${want}\n` +
            `            → FIXED. Delete the stale QUARANTINE entry in the same ` +
            `commit; a quarantine nobody prunes becomes a permanent exemption.`,
      );
    }
  }

  if (problems.length) {
    console.log("NARRATIVE-UNITS: FAIL\n");
    for (const p of problems) console.log(`  ${p}`);
    console.log(`\n${problems.length} problem(s). Contract: design_review/narrative/GATES.md`);
    process.exit(1);
  }
  const quarantined = Object.values(QUARANTINE)
    .reduce((n, codes) => n + Object.values(codes).reduce((a, b) => a + b, 0), 0);
  console.log(
    `NARRATIVE-UNITS: PASS — ${SCOPE.length} narrative producer(s) scanned, ` +
    `${quarantined} known violation(s) held under quarantine (see GATES.md).`);
}

main();
