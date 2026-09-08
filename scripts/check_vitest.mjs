#!/usr/bin/env node
/**
 * THE FRONTEND UNIT-TEST GATE.
 *
 * 2,784 vitest tests sat OUTSIDE the battery. `tsc` and `npm-build` were
 * in it; nothing ran the unit suite. That is the `check_tsc` shape again
 * — a gate everybody assumed existed, and a body of tests nobody was
 * watching. Measured the hour this was written, the suite was RED, and
 * red for a real reason:
 *
 *   · `ENGINE_MONEY_FACTS` in `frontend/lib/capsuleFactIndex.ts` had
 *     drifted from `engine.api._ratio_units._MONEY_FACTS` (three names
 *     added engine-side and never mirrored);
 *   · and the mirror test that exists to catch exactly that had been
 *     passing on a FALSE match — it regexed the raw Python source, so it
 *     scooped a quoted phrase out of a comment and counted it as a fact
 *     name. `"currency"` was in the frontend mirror and is not a money
 *     fact at all; the test agreed only because the string appears
 *     inside `# `fmt: "currency"` in _benchmark_engine...`.
 *
 * ══ WORK + FLOOR + CANARIES (TC-6) ═══════════════════════════════════
 *
 * Exit zero is half a verdict. A suite that runs zero files exits zero,
 * and so does one whose config stopped matching anything. So this prints
 * how many tests actually RAN, holds a floor, and names FILES it must
 * have executed — one per area, so a collapse in one area cannot hide
 * behind the total.
 *
 * ══ WHAT IT REDS ON (TC-11) ══════════════════════════════════════════
 *   · any failing or errored test file;
 *   · the total falling below the floor (a config that stopped matching);
 *   · a named canary file not being run at all;
 *   · vitest exiting non-zero for any other reason (a crashed worker).
 * ══ WHAT IT CANNOT SEE ═══════════════════════════════════════════════
 *   · Playwright. `e2e/` is a separate runner and is not in the battery
 *     either; that gap is real and is NOT closed by this file.
 *   · whether a passing test asserts anything worth asserting.
 *
 * Run:  node scripts/check_vitest.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MEASURED 2026-09-08: 2,784 tests across 751 suites. The floor is
// ~10% below, so a genuine addition never trips it and a collapse does.
const FLOOR = 2500;

// One file per area the suite covers, so a per-area collapse is visible
// rather than hidden inside a total that still clears the floor. Each is
// a path substring, matched against the files vitest reports running.
const CANARIES = [
  "frontend/lib/__tests__/capsuleFactIndex.test.ts",   // engine mirrors
  "frontend/lib/__tests__/forecastFactsBoundary.test.ts", // the projected boundary
  "frontend/pages/cfo/__tests__/forecastPage.test.tsx",  // a page surface
  "frontend/lib/__tests__/exportRatioFormulas.test.ts", // the export renderers
  "frontend/lib/__tests__/socialLinksFromConfig.test.ts", // the config gates
];

const dir = mkdtempSync(join(tmpdir(), "battery-vitest-"));
const out = join(dir, "vitest.json");
let exitCode = 0;
try {
  execFileSync(
    "npx",
    ["vitest", "run", "--reporter=json", `--outputFile=${out}`],
    { stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd() },
  );
} catch (err) {
  exitCode = typeof err.status === "number" ? err.status : 1;
}

let report;
try {
  report = JSON.parse(readFileSync(out, "utf-8"));
} catch {
  console.log("VITEST GATE");
  console.log("=".repeat(62));
  console.log(
    `FAIL — vitest produced no JSON report (exit ${exitCode}). The runner ` +
      `did not start, or crashed before writing one. That is a red, not a ` +
      `reason to skip: a suite that cannot run is a suite nobody is watching.`,
  );
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });

const total = report.numTotalTests ?? 0;
const passed = report.numPassedTests ?? 0;
const failed = report.numFailedTests ?? 0;
const pending = report.numPendingTests ?? 0;
const suites = report.numTotalTestSuites ?? 0;

const ranFiles = (report.testResults ?? []).map((r) => String(r.name || ""));
const missing = CANARIES.filter(
  (c) => !ranFiles.some((f) => f.replace(/\\/g, "/").includes(c)),
);

console.log("VITEST GATE");
console.log("=".repeat(62));
console.log(
  `GATE-WORK vitest units=${total} floor=${FLOOR} label=frontend-unit-tests ` +
    `canaries=${CANARIES.length - missing.length}/${CANARIES.length}`,
);
console.log(
  `  ${total} test(s) across ${suites} suite(s) in ${ranFiles.length} file(s): ` +
    `${passed} passed, ${failed} failed, ${pending} skipped`,
);

const problems = [];
if (failed > 0) {
  problems.push(`${failed} failing test(s)`);
  for (const r of report.testResults ?? []) {
    for (const a of r.assertionResults ?? []) {
      if (a.status !== "failed") continue;
      const where = String(r.name || "").split("/").slice(-2).join("/");
      console.log(`  FAIL ${where} :: ${a.fullName}`);
      const msg = (a.failureMessages ?? [])[0];
      if (msg) console.log(`       ${msg.split("\n")[0].slice(0, 200)}`);
    }
    // A file that failed to COLLECT reports no assertions at all.
    if (r.status === "failed" && !(r.assertionResults ?? []).some((a) => a.status === "failed")) {
      console.log(`  FAIL ${r.name} :: did not collect`);
      if (r.message) console.log(`       ${String(r.message).split("\n")[0].slice(0, 200)}`);
    }
  }
}
if (total < FLOOR) {
  problems.push(
    `only ${total} test(s) ran against a floor of ${FLOOR} — the config ` +
      `has stopped matching files, which exits zero and proves nothing`,
  );
}
if (missing.length) {
  problems.push(`canary file(s) never ran: ${missing.join(", ")}`);
}
if (!problems.length && exitCode !== 0) {
  problems.push(
    `vitest exited ${exitCode} with no failing test — a worker crashed or ` +
      `the runner errored after collection`,
  );
}

if (problems.length) {
  console.log("");
  console.log(`FAIL — ${problems.length} problem(s):`);
  for (const p of problems) console.log(`  · ${p}`);
  process.exit(1);
}

console.log("");
console.log(
  `PASS — ${passed} frontend unit test(s) green; every canary area ran.`,
);
