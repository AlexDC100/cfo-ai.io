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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MEASURED 2026-09-08: 2,784 tests across 751 suites; re-measured
// 2026-09-29: 4,336 across 1,162 suites (the 2,500 floor had fallen to 58%
// of the suite — a collapse of 1,800 tests would have passed). The floor
// is ~10% below, so a genuine addition never trips it and a collapse does.
const FLOOR = 3900;

// One file per area the suite covers, so a per-area collapse is visible
// rather than hidden inside a total that still clears the floor. Each is
// a path substring, matched against the files vitest reports running.
const CANARIES = [
  "frontend/lib/__tests__/capsuleFactIndex.test.ts",   // engine mirrors
  "frontend/lib/__tests__/forecastFactsBoundary.test.ts", // the projected boundary
  // a page surface: the Forecast cockpit page. forecastPage.test.tsx was
  // retired with the page it tested (131061f6, its laws re-asserted on the
  // cockpit) and this canary kept naming it for a week — a canary that
  // names nothing (owner ruling 2026-09-29: a vacuous gate).
  "frontend/pages/cfo/__tests__/forecastCockpit.test.tsx",
  "frontend/lib/__tests__/exportRatioFormulas.test.ts", // the export renderers
  "frontend/lib/__tests__/socialLinksFromConfig.test.ts", // the config gates
  // plan/2 B1 (plan_contract_v2 S7): one sign-flip classifier, rendered as words
  "frontend/lib/__tests__/changeKind.test.ts",
  "frontend/components/scenarios/__tests__/signFlip.test.tsx",
  // plan/2 B6: the fp1.2 reader over the real served bytes; the magnitude band
  "frontend/lib/__tests__/forecastFactsReader.test.ts",
  "frontend/pages/cfo/__tests__/forecastMagnitude.test.tsx",
  // plan/2 B13 (minimal cut): the Scenarios page on the engine — no client
  // math in its closure, templates POST their declared sets, refusals are the
  // engine's sentence, no industry word, no negative cash painted
  "frontend/pages/cfo/__tests__/scenariosEngine.test.tsx",
  // forecast-scenarios-live: gate F1 (year 0 is the dashboard's actuals) and
  // gate F6 (a saved scenario survives reload and belongs to its company)
  "frontend/components/forecast/__tests__/forecastYearZero.test.tsx",
  "frontend/pages/cfo/__tests__/scenariosSaved.test.tsx",
  // the public sample (2026-10-01): the /sample page held to the served
  // document, and the published report to the product's own builder.
  "frontend/pages/cfo/__tests__/publicSample.test.tsx",
  // RO + EN: every served engine sentence in Romanian under the digit law
  "frontend/lib/__tests__/forecastSentencesRo.test.ts",
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
// A canary that names a file the tree does not hold is not a test that
// failed to run — it is the GATE pointing at nothing. Said separately, so
// the fix (repoint the canary) is not mistaken for a missing test.
const absent = CANARIES.filter((c) => !existsSync(join(process.cwd(), c)));

console.log("VITEST GATE");
console.log("=".repeat(62));
// THE CANARY NAMES ARE PRINTED, not counted. `run_battery.py` greps a
// gate's own OUTPUT for each canary string it declares, so "canaries=5/5"
// satisfies this gate and fails the battery's — which is exactly what
// happened the first time this ran under it. A count is a claim; the
// name is the evidence.
console.log(
  `GATE-WORK vitest units=${total} floor=${FLOOR} label=frontend-unit-tests ` +
    `canaries=${CANARIES.length - missing.length}/${CANARIES.length}`,
);
for (const canary of CANARIES) {
  const seen = !missing.includes(canary);
  console.log(`  canary ${canary}: ${seen ? "ran" : "NEVER RAN"}`);
}
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
if (absent.length) {
  problems.push(
    `canary names a file that is not in the tree (the gate points at ` +
      `nothing — repoint it): ${absent.join(", ")}`,
  );
}
const unrun = missing.filter((c) => !absent.includes(c));
if (unrun.length) {
  problems.push(`canary file(s) never ran: ${unrun.join(", ")}`);
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
