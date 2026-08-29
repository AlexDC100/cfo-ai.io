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

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const rel = file.replace(/\\/g, "/");
    const text = readFileSync(file, "utf-8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
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
if (!fail) {
  console.log("GLOBAL-POSITIONING GATES: PASS (G2 headline lint, G3 honesty lint)");
}
process.exit(fail ? 1 : 0);
