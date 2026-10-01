#!/usr/bin/env node
/**
 * Positioning gates G2 + G3.
 *
 * G2 HEADLINE LINT (directive 2026-08-29, unchanged) — "Hungar*" /
 *   "Ungaria" / "maghiar" are forbidden in headline positions: h1/h2 JSX,
 *   `title:` / `headline:` / `name:` / `blurb:` string fields, nav labels,
 *   dropdown GROUP labels, and marketing hero strings. They stay ALLOWED
 *   in country lists, legal citations, pack metadata and code comments.
 *
 * G3 COVERAGE-TRUTH LINT (rewritten 2026-10-01).
 *
 *   WHAT G3 USED TO BE, AND WHY IT ENCODED THE DEFECT. It was a VERB
 *   lint: "supported / certified / guaranteed" could not share a sentence
 *   with "any country / worldwide / 150+", and the approved verbs for a
 *   global claim were "accepted" and "dual-verified". So the landing
 *   printed "Any other country accepted — structure read by AI, numbers
 *   machine-verified twice" over a row of seven markets, this gate read
 *   it and said PASS, and it stayed that way from 2026-08-29 until the
 *   first public review on 2026-10-01. No test in the repository used a
 *   real book from any of those countries. The gate did not check whether
 *   the claim was true; it checked that the claim was phrased politely.
 *   Worse, it would RED on the honest sentence — "any country other than
 *   Romania is not supported yet" puts "any country" beside "supported".
 *   Its trigger list also had no word for Europe, so "from any European
 *   country", "EU filings supported" and "for European SMEs" passed too.
 *
 *   WHAT G3 IS NOW. The product reads Romanian trial balances; nothing
 *   else is tested (frontend/data/coverage.json). A phrase that claims
 *   coverage beyond Romania — any (other) country, any European country,
 *   worldwide, any jurisdiction, international coverage, EU filings,
 *   European SMEs / charts / software — may appear in product copy ONLY in
 *   a sentence that says it is NOT available: "not supported yet", "is not
 *   available", "other than Romania", "coming soon" and their Romanian
 *   forms. There is no approved verb for an untested claim.
 *
 *   WHAT IT REDS ON, AFTER THE REPAIR (TC-11):
 *     "Any other country accepted", "from any European country",
 *     "worldwide trial balances", "Any accounting jurisdiction",
 *     "RAS / EU filings supported", "analysis for European SMEs".
 *   WHAT IT PASSES: "Trial balances … from any country other than Romania
 *     — not supported yet"; "Coming soon — international coverage is not
 *     available yet".
 *   WHAT IT CANNOT SEE: a coverage claim with none of these phrases (a
 *     bare country name in a list), an accounting-software name, and
 *     anything assembled at render time. Those are the vitest gate
 *     `public-claims`, which mounts the real pages in both languages.
 *     Test files and comment lines are not product copy and are skipped
 *     by G3.
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
  // Wire-code comments (engineering truth).
  "frontend/components/cfo/JurisdictionSelect.tsx",
  // Tests may cite the codes.
  "frontend/lib/__tests__/bsAiLaneUi.test.tsx",
]);

const HU = /hungar|ungaria|maghiar/i;
// Headline-positioned string fields in our string modules.
const HEADLINE_FIELD = /\b(title|headline|name|blurb|eyebrow|subtitle|hero\w*)\s*:\s*["'`][^"'`]*$/i;

// A phrase that claims coverage beyond Romania …
const CLAIM = new RegExp(
  [
    "any (?:other )?country", "any european country", "worldwide", "150\\+",
    "orice (?:altă )?țară", "întreaga lume",
    "any (?:accounting )?jurisdiction", "orice jurisdicție",
    "international coverage", "acoperire(?:a)? internațională",
    "eu filings", "raportări ue",
    "european smes", "european (?:chart|accounting|countr)",
    "(?:planuri de conturi|software[^.]*) europe(?:an|ne)\\b", "țară europeană",
  ].join("|"),
  "i",
);
// … and the only company it may keep: a sentence saying it is not available.
const NEGATION = new RegExp(
  [
    "not (?:yet )?(?:supported|available|analysed|analyzed|on sale|tested)",
    "(?:is|are)n't", "\\b(?:is|are) not\\b", "other than romania", "coming soon",
    "\\bnu (?:este|sunt|e)\\b", "\\bîncă\\b", "nesuportat", "indisponibil",
    "decât românia", "în curând", "no real book",
  ].join("|"),
  "i",
);
const IS_TEST = /(^|\/)(__tests__|test)\//;

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
//   CLAIM  the coverage pattern must FIRE somewhere too — it does, in
//          the not-supported row of frontend/data/coverage.json and on the
//          coming-soon plan card, both negated and therefore allowed. Zero
//          matches would mean the detector stopped detecting.
const CANARY_FILE = "frontend/pages/cfo/landingStrings.ts";
let filesScanned = 0;
let linesScanned = 0;
let sawCanaryFile = false;
let huMatchesAnywhere = 0;
let claimMatchesAnywhere = 0;

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
      // G3 applies everywhere user-facing strings live (not in tests:
      // a gate's own patterns and plants are not product copy).
      // A comment line is the file's own prose about a defect (several
      // quote the retired claims on purpose), not copy a customer reads.
      const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
      if (!IS_TEST.test(rel) && !isComment && CLAIM.test(line)) {
        // Same SENTENCE: the claim and its negation inside one quoted
        // string, one sentence. A JSON value is a quoted string too.
        const strings = line.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g) ?? [];
        for (const str of strings) {
          for (const sentence of str.split(/[.!?](?:\s|$|["'`])/)) {
            if (!CLAIM.test(sentence)) continue;
            claimMatchesAnywhere += 1;
            if (!NEGATION.test(sentence)) {
              g3.push(`${rel}:${i + 1}: ${sentence.trim().slice(0, 130)}`);
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
  console.log("G3 COVERAGE-TRUTH LINT — coverage beyond Romania claimed, not negated (%d):", g3.length);
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
if (claimMatchesAnywhere === 0) {
  broken.push(
    "the coverage-claim pattern matched NOTHING — it fires (negated) in " +
    "frontend/data/coverage.json and on the coming-soon plan card, so zero " +
    "matches means the detector is broken, not that the tree is clean");
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
    `GLOBAL-POSITIONING GATES: PASS (G2 headline lint, G3 coverage-truth lint) — ` +
    `${filesScanned} file(s) / ${linesScanned} line(s) scanned; ` +
    `HU pattern fired ${huMatchesAnywhere}x, all inside the allowed ` +
    `country-list files; coverage claims beyond Romania: ` +
    `${claimMatchesAnywhere}, every one negated`);
}
process.exit(fail ? 1 : 0);
