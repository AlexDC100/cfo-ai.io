#!/usr/bin/env node
/**
 * THE CREDIT-VERDICT GATES — one command per gate, so the battery can
 * hold them.
 *
 * ── WHY A WRAPPER AND NOT "npx vitest run" ───────────────────────────
 *
 * `npx vitest run` reports a number nobody compares against an
 * expectation, and the battery's own rule is that exit zero is not
 * evidence. Worse, for THESE two files the failure mode is specific:
 * every assertion in them is conditional on a corpus fixture parsing and
 * on named SECTIONS existing. A file that stopped collecting §9, or a
 * fixture that stopped carrying a credit envelope, still exits 0 with a
 * healthy-looking total. So each gate here:
 *
 *   1. runs ONE test file through vitest's json reporter;
 *   2. counts the tests that actually EXECUTED (pending/skipped excluded
 *      — turning a red into a `.skip` is the cheapest false green);
 *   3. requires every SECTION CANARY to be among the executed test
 *      names, so a deleted or renamed section is louder than a failing
 *      assertion;
 *   4. prints GATE-WORK so the battery can floor it.
 *
 * ── THE TWO GATES ────────────────────────────────────────────────────
 *
 *  --gate=one-letter   frontend/pages/cfo/__tests__/oneLetterOneLadder.test.tsx
 *      Renders /report Section 7 and the Risks tab and re-parses a real
 *      .xlsx, under an engine RE-BAND. Owns: a letter is minted by
 *      exactly one ladder — the engine's — and the model is named beside
 *      it on every surface; one Altman per workbook.
 *
 *  --gate=one-verdict  frontend/lib/__tests__/oneVerdictLeavesTheBuilding.test.tsx
 *      Parses the produced board-pack HTML and the produced workbook
 *      bytes. Owns: one Altman/zone/verdict leaves the building; §9 the
 *      surface→reader enumeration under a plant the deleted replica
 *      ladder cannot pass; §10 no sentence names a cutoff the letter was
 *      not banded with.
 *
 * Neither is registered in scripts/run_battery.py by this lane — the
 * battery table is not this lane's file to edit. The two Gate(...) lines
 * and their gates.md sections are handed to the owner to apply.
 *
 * Run:  node scripts/check_credit_verdict.mjs --gate=one-letter
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

const ROOT = process.cwd();

const GATES = {
  "one-letter": {
    file: "frontend/pages/cfo/__tests__/oneLetterOneLadder.test.tsx",
    label: "one-letter-one-ladder",
    // Section canaries — substrings of the full test name. Each names a
    // SECTION, not an assertion, because a section that stops being
    // collected is the failure this gate exists to catch.
    canaries: [
      "§0 non-vacuity",
      "§1 an engine re-band moves every surface together",
      "§2 the letter comes from the envelope's own ladder",
      "§3 with no engine credit envelope",
      "§4 the component under test is really mounted",
      "§5",
      "the DASHBOARD HERO follows it too",
    ],
  },
  "one-verdict": {
    file: "frontend/lib/__tests__/oneVerdictLeavesTheBuilding.test.tsx",
    label: "one-verdict-leaves-the-building",
    canaries: [
      "§0 non-vacuity",
      "§1 the printed document and every screen carry ONE Altman",
      "§3 the zone word is one word",
      "§5 no surface prints a verdict that names no model",
      "§6 the deleted arithmetic, planted, is caught",
      "§7b /report's card reads the same two authorities",
      "§9 every surface, through its own reader",
      "§10 no sentence names a cutoff the letter was not banded with",
    ],
  },
};

const arg = process.argv.find((a) => a.startsWith("--gate="));
const name = arg ? arg.slice("--gate=".length) : "";
const gate = GATES[name];
if (!gate) {
  console.log("CREDIT-VERDICT GATE: no such gate");
  console.log(`  --gate=<${Object.keys(GATES).join("|")}> is required`);
  process.exit(1);
}

const out = mkdtempSync(join(tmpdir(), "credit-gate-"));
const jsonPath = join(out, "results.json");
let raw;
try {
  execFileSync(
    "npx",
    ["vitest", "run", gate.file, "--reporter=json", `--outputFile=${jsonPath}`],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
} catch {
  // vitest exits non-zero on failures; the JSON file is the payload.
}
try {
  raw = JSON.parse(readFileSync(jsonPath, "utf8"));
} catch (err) {
  console.log(`CREDIT-VERDICT GATE ${gate.label}: RUNNER PRODUCED NO PARSEABLE RESULT`);
  console.log(`  ${err.message}`);
  console.log("  A run that cannot even be read is not a pass.");
  rmSync(out, { recursive: true, force: true });
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });

let executed = 0;
let skipped = 0;
const failed = [];
const names = [];
let sawFile = false;
for (const tr of raw.testResults ?? []) {
  const rel = relative(ROOT, tr.name).split("\\").join("/");
  if (rel !== gate.file) continue;
  sawFile = true;
  for (const a of tr.assertionResults ?? []) {
    if (a.status === "passed" || a.status === "failed") {
      executed++;
      names.push(a.fullName);
      if (a.status === "failed") failed.push(a.fullName);
    } else {
      skipped++;
    }
  }
}

console.log(`CREDIT-VERDICT GATE — ${gate.label}`);
console.log("=".repeat(62));
console.log(
  `GATE-WORK ${gate.label} units=${executed} label=tests-executed file=${gate.file}`,
);

if (!sawFile || executed === 0) {
  console.log("  DISCOVERY BROKEN");
  console.log(`  ${gate.file} ${sawFile ? "ran 0 tests" : "was not collected at all"}`);
  console.log("  Zero tests over the file this gate is named for is not a pass.");
  process.exit(1);
}

const missing = gate.canaries.filter((c) => !names.some((n) => n.includes(c)));
if (missing.length) {
  console.log(`  ${executed} test(s) executed, ${skipped} skipped`);
  console.log("  SECTION CANARY MISSING — the file ran, but not all of it:");
  for (const m of missing) console.log(`    · ${m}`);
  console.log("  A section that stops being collected reports a healthy total.");
  process.exit(1);
}

if (failed.length) {
  console.log(`  ${executed} test(s) executed, ${failed.length} FAILED:`);
  for (const f of failed) console.log(`    ✗ ${f}`);
  process.exit(1);
}

console.log(
  `  ${executed} test(s) executed, ${skipped} skipped; ` +
    `all ${gate.canaries.length} section canary/-ies seen.`,
);
console.log("  PASS");
