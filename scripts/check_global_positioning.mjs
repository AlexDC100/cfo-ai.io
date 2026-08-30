#!/usr/bin/env node
/**
 * Global-positioning gates G2 + G3 (directive 2026-08-29).
 *
 * Positioning is GLOBAL. Hungary is one country in a list — never a
 * headline. And "any country" claims may describe ACCEPTANCE and the
 * dual-verified process, never deterministic certification.
 *
 * G2 HEADLINE LINT — "Hungar*" / "Ungaria" / "maghiar" are forbidden in
 *   headline positions: h1/h2 JSX, `title:` / `headline:` / `name:` /
 *   `blurb:` string fields, nav labels, dropdown GROUP labels, and
 *   marketing hero strings. They stay ALLOWED in country lists, legal
 *   citations (Act C of 2000), pack metadata, engineering docs'
 *   parentheticals, and code comments.
 *
 * G3 HONESTY LINT — the words "supported" / "certified" / "guaranteed"
 *   may not share a sentence with "any country" / "worldwide" / "150+".
 *   Approved verbs for global claims: "accepted", "dual-verified".
 *
 * Exit 1 with a readable table on violation; 0 clean.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["frontend"];
const EXT = new Set([".ts", ".tsx", ".json"]);

// Files where Hungary may appear because they ARE the country list /
// wire-code map — each entry justified.
const COUNTRY_LIST_FILES = new Set([
  // Jurisdiction display-name map: "hu: Hungary/Ungaria" is a country row.
  "frontend/components/cfo/bsCanonicalStatusI18n.ts",
  // The display taxonomy itself — Hungary is defined here as a tail row.
  "frontend/lib/markets.ts",
  // Wire-code comments (engineering truth).
  "frontend/components/cfo/JurisdictionSelect.tsx",
  // Tests may cite the codes.
  "frontend/lib/__tests__/bsAiLaneUi.test.tsx",
]);

const HU = /hungar|ungaria|maghiar/i;
// Headline-positioned string fields in our string modules.
const HEADLINE_FIELD = /\b(title|headline|name|blurb|eyebrow|subtitle|hero\w*)\s*:\s*["'`][^"'`]*$/i;

const CLAIM = /(any country|worldwide|orice țară|150\+|întreaga lume)/i;
const FORBIDDEN_VERB = /(supported|certified|guaranteed|certificat|garantat)/i;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXT.has(name.slice(name.lastIndexOf(".")))) yield p;
  }
}

const g2 = [];
const g3 = [];

// ── WORK CENSUS + DISCOVERY CANARIES ─────────────────────────────────
//
// Everything below is a walk over `frontend`. If the walk stops walking
// — a moved root, a thrown readdirSync swallowed by a future refactor,
// an EXT set that no longer matches — both arrays stay empty and this
// script prints "GLOBAL-POSITIONING GATES: PASS". That sentence is true
// of an empty tree, which is exactly how `npx tsc --noEmit` passed for
// months over zero files.
//
// Two canaries, and the second is the one that matters:
//   FILE   a path that must be in the walk (proves the walker walks).
//   MATCH  the HU pattern must FIRE somewhere (proves the detector can
//          still detect). It fires in the country-list files, which are
//          allowed — so a green G2 means "found and correctly excused",
//          not "looked and saw nothing". A regex that stopped matching
//          would otherwise be indistinguishable from a clean tree.
const CANARY_FILE = "frontend/lib/markets.ts";
let filesScanned = 0;
let linesScanned = 0;
let sawCanaryFile = false;
let huMatchesAnywhere = 0;

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const rel = file.replace(/\\/g, "/");
    if (rel === CANARY_FILE) sawCanaryFile = true;
    filesScanned += 1;
    const text = readFileSync(file, "utf-8");
    const lines = text.split("\n");
    linesScanned += lines.length;
    lines.forEach((line, i) => {
      if (HU.test(line)) huMatchesAnywhere += 1;
      if (HU.test(line) && !COUNTRY_LIST_FILES.has(rel)) {
        // Headline position: an h1/h2 tag on the line, or a headline
        // string field, or any marketing-strings module.
        const headliney =
          /<h[12][\s>]/.test(line) ||
          HEADLINE_FIELD.test(line.slice(0, line.search(HU))) ||
          /landingStrings|marketing|hero/i.test(rel);
        if (headliney) {
          g2.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
        }
      }
      // G3 applies everywhere user-facing strings live.
      if (CLAIM.test(line) && FORBIDDEN_VERB.test(line)) {
        // Same SENTENCE only: cheap check — both inside one quoted string.
        const strings = line.match(/["'`][^"'`]*["'`]/g) ?? [];
        for (const str of strings) {
          for (const sentence of str.split(/[.!?]/)) {
            if (CLAIM.test(sentence) && FORBIDDEN_VERB.test(sentence)) {
              g3.push(`${rel}:${i + 1}: ${sentence.trim().slice(0, 110)}`);
            }
          }
        }
      }
    });
  }
}

let fail = false;
if (g2.length) {
  fail = true;
  console.log("G2 HEADLINE LINT — Hungary in a headline position (%d):", g2.length);
  for (const v of g2) console.log("  " + v);
}
if (g3.length) {
  fail = true;
  console.log("G3 HONESTY LINT — certification verb beside a global claim (%d):", g3.length);
  for (const v of g3) console.log("  " + v);
}
const broken = [];
if (filesScanned === 0) broken.push("the walk produced 0 files");
if (!sawCanaryFile) {
  broken.push(`canary file ${CANARY_FILE} was never visited`);
}
if (huMatchesAnywhere === 0) {
  broken.push(
    "the HU pattern matched NOTHING anywhere in the tree — it fires in the " +
    "country-list files by design, so zero matches means the detector is " +
    "broken, not that the tree is clean");
}
if (broken.length) {
  console.log("GLOBAL-POSITIONING GATES: DISCOVERY BROKEN");
  console.log(`  scanned ${filesScanned} file(s), ${linesScanned} line(s)`);
  for (const b of broken) console.log(`  - ${b}`);
  console.log("  A lint over nothing reports no violations. That is not a pass.");
  process.exit(1);
}

console.log(
  `GATE-WORK global-positioning units=${filesScanned} floor=400 label=frontend-files`);
if (!fail) {
  console.log(
    `GLOBAL-POSITIONING GATES: PASS (G2 headline lint, G3 honesty lint) — ` +
    `${filesScanned} file(s) / ${linesScanned} line(s) scanned; ` +
    `HU pattern fired ${huMatchesAnywhere}x, all inside the allowed ` +
    `country-list files`);
}
process.exit(fail ? 1 : 0);
