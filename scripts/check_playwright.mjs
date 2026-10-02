#!/usr/bin/env node
/**
 * THE PLAYWRIGHT GATE — the last suite outside the battery.
 *
 * ══ WHAT MEASURING IT FIRST FOUND ═════════════════════════════════════
 *
 * Wiring this naively would have produced a gate that is either
 * permanently red or quietly vacuous. Measured 2026-09-09 on this
 * checkout, against a local dev server:
 *
 *   · 41 spec files. FOUR of them gate their entire contents behind
 *     `E2E_REAL=1` — unset, they skip every test. In one three-file
 *     slice, 18 of 19 tests skipped. A gate that reports "green" over a
 *     suite that skipped itself is the `check_tsc` false green again.
 *   · A full `--project=chromium` run did NOT complete in over an hour.
 *   · `e2e/design` alone exceeded twelve minutes and left failure
 *     artifacts.
 *   · `golden-path.spec.ts:33` fails today.
 *
 * So the suite does not pass as it stands, and a gate that demands it
 * does would be reverted within a day. This gate uses the SAME shape
 * `check_tsc.mjs` uses for its 102 pre-existing type errors: a recorded
 * baseline that may only ever SHRINK, with any NEW failure red
 * immediately.
 *
 * ══ WORK + FLOOR + SKIP RATE (TC-6) ═══════════════════════════════════
 *
 * Exit zero is half a verdict, and here it is less than half: this
 * runner can exit zero having run nothing. So the gate prints how many
 * tests RAN versus SKIPPED, floors the ran count, and CEILINGS the skip
 * rate — a suite that starts skipping more is a suite going quiet, and
 * that is the failure mode a pass/fail check cannot see.
 *
 * ══ NEVER PRODUCTION ══════════════════════════════════════════════════
 *
 * `--project=prod` points at https://cfo-ai.io. A live production URL in
 * a test context is a hard error in this project, so this gate refuses
 * to run if `E2E_BASE_URL` is anything but a localhost origin, and it
 * never passes `--project=prod`. The refusal is loud and states the rule.
 *
 * ══ WHAT IT REDS ON (TC-11) ═══════════════════════════════════════════
 *   · any test failing that is not in the baseline;
 *   · the ran count falling below the floor (specs that stopped running);
 *   · the skip rate rising above the ceiling (a suite going quiet);
 *   · `E2E_BASE_URL` pointing anywhere but localhost;
 *   · the runner producing no JSON report at all;
 *   · ZERO TESTS COLLECTED — a report that holds no test (see the block
 *     below the walk). It has its own message, and `--write-baseline`
 *     refuses on it instead of recording an empty baseline.
 * ══ WHAT IT CANNOT SEE ════════════════════════════════════════════════
 *   · anything behind `E2E_REAL=1`, which needs a seeded workspace.
 *     Those specs are COUNTED as skipped and the ceiling holds their
 *     number steady; they are not run here.
 *
 * Run:  node scripts/check_playwright.mjs [--write-baseline]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASELINE = "design_review/PLAYWRIGHT_BASELINE.txt";
const WRITE = process.argv.includes("--write-baseline");

// Measured 2026-09-09; both derived from a completed run and recorded by
// `--write-baseline`, never guessed.
const FLOOR_RAN = Number(process.env.PW_FLOOR_RAN || 0);
const MAX_SKIP_RATE = 0.75;

const base = process.env.E2E_BASE_URL ?? "http://localhost:5173";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) {
  console.log("PLAYWRIGHT GATE");
  console.log("=".repeat(62));
  console.log(
    `REFUSED — E2E_BASE_URL is ${JSON.stringify(base)}. This gate runs ` +
      `against a local dev server only. A live production URL in a test ` +
      `context is a hard error in this project; use --project=prod ` +
      `deliberately and by hand if you mean to probe the deployed site.`,
  );
  process.exit(1);
}

// The E2E_BASE_URL check above only governs where RELATIVE navigations land.
// A spec can still hardcode an absolute origin in its body and reach straight
// past it — learning-landing-onboarding.spec.ts did exactly that, fetching
// https://cfo-ai.io/ and an asset bundle from the live site on every run of
// this gate. Refuse that statically, because the symptom is invisible: the
// test passes, and nothing in the report says it left the machine.
{
  const specs = execFileSync(
    "git", ["ls-files", "e2e/*.spec.ts", "e2e/**/*.spec.ts"],
    { encoding: "utf-8" },
  ).split("\n").filter(Boolean);
  const offenders = [];
  for (const spec of specs) {
    const src = readFileSync(spec, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")      // block comments
      .replace(/^\s*(\/\/|\*).*$/gm, "");     // line comments and jsdoc bodies
    for (const m of src.matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)) {
      const host = m[0];
      if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(host)) continue;
      offenders.push(`${spec}: ${host}`);
    }
  }
  if (offenders.length) {
    console.log("PLAYWRIGHT GATE");
    console.log("=".repeat(62));
    console.log(
      "REFUSED — these specs name an absolute non-local origin in code, so " +
        "they reach it regardless of E2E_BASE_URL:\n  " +
        offenders.join("\n  ") +
        "\nMake the request relative so it resolves against the project's " +
        "baseURL (--project=prod when you deliberately mean the live site).",
    );
    process.exit(1);
  }
}

const dir = mkdtempSync(join(tmpdir(), "battery-pw-"));

// THE JSON REPORTER WRITES TO STDOUT. `PLAYWRIGHT_JSON_OUTPUT_NAME` is
// documented and did not take here — the first run of this gate spent
// forty minutes and then reported "no JSON report", because it was
// reading a file the runner never created. Capture stdout, which is
// what the reporter actually produces, and give it room: a full report
// over 41 spec files is several megabytes and the default 1 MB buffer
// throws.
let raw = "";
try {
  raw = execFileSync(
    "npx",
    ["playwright", "test", "--project=chromium", "--reporter=json",
     `--output=${join(dir, "artifacts")}`, "--timeout=20000"],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 },
  );
} catch (err) {
  // Failing tests exit non-zero AND still print the report. Failures are
  // data here; only an absent report is a gate failure.
  raw = typeof err.stdout === "string" ? err.stdout : "";
}

let report;
try {
  report = JSON.parse(raw.slice(raw.indexOf("{")));
} catch {
  console.log("PLAYWRIGHT GATE");
  console.log("=".repeat(62));
  console.log(
    "FAIL — the runner produced no JSON report. It did not start, or it " +
      "died before writing one. A suite that cannot run is a suite nobody " +
      "is watching, which is the reason this gate exists.",
  );
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });

const failures = [];
let ran = 0;
let skipped = 0;
const walk = (node, file) => {
  const here = node.file || file;
  for (const s of node.suites ?? []) walk(s, here);
  for (const spec of node.specs ?? []) {
    for (const t of spec.tests ?? []) {
      if (t.status === "skipped") { skipped += 1; continue; }
      ran += 1;
      if (t.status !== "expected") failures.push(`${here} :: ${spec.title}`);
    }
  }
};
for (const s of report.suites ?? []) walk(s, s.file);

// ZERO TESTS COLLECTED IS ITS OWN RED, AND IT COMES BEFORE THE BASELINE.
//
// A report with no test in it is not a quiet suite, it is no suite. Two
// causes are measured (Playwright 1.59.1, 2026-10-02):
//   · ONE spec that throws while it is being collected empties the WHOLE
//     run — the other 44 files contribute nothing either;
//   · a second copy of @playwright/test on the resolution path does the
//     same to every file ("did not expect test.describe() to be called
//     here"). A stray `node_modules/node_modules` link did exactly that in
//     every worktree: 0 tests in 0 files, in 3 s.
// Before this block the run fell through to the skip-rate ceiling and
// printed "100.0% of tests skipped … the suite is going quiet" — the wrong
// diagnosis, nothing was skipped — and `--write-baseline` on such a run
// WROTE AN EMPTY BASELINE, exited 0 and advised PW_FLOOR_RAN=0: every
// later run would then have passed against it. The same class as the
// vacuous canaries: a verdict over nothing is never a pass.
if (ran + skipped === 0) {
  const words = (report.errors ?? [])
    .map((e) => String(e?.message ?? e?.value ?? "").split("\n")[0].trim())
    .filter(Boolean);
  console.log("PLAYWRIGHT GATE");
  console.log("=".repeat(62));
  console.log(
    `GATE-WORK playwright units=0 floor=${FLOOR_RAN} label=e2e-tests-run ` +
      `skipped=0 collected=0`,
  );
  console.log("");
  console.log(
    "FAIL — ZERO TESTS COLLECTED. The runner wrote a report and it holds no " +
      "test: nothing ran and nothing was skipped, so nothing was measured. " +
      "One spec that throws while it is being collected empties the whole " +
      "run, and so does a second copy of @playwright/test on the resolution " +
      "path (a `node_modules/node_modules` link).",
  );
  if (words.length) {
    const distinct = [...new Set(words)];
    console.log(`  the runner's own words (${words.length} error(s), ${distinct.length} distinct):`);
    for (const w of distinct.slice(0, 8)) {
      console.log(`  · ${w} (×${words.filter((x) => x === w).length})`);
    }
  } else {
    console.log("  the runner gave no error — run `npx playwright test --project=chromium --list` to see what it collects.");
  }
  if (WRITE) {
    console.log(
      `  ${BASELINE} was NOT rewritten: a baseline recorded from this run ` +
        "would be empty, and every later run would pass against it.",
    );
  }
  process.exit(1);
}

failures.sort();
if (WRITE) {
  writeFileSync(BASELINE, failures.join("\n") + (failures.length ? "\n" : ""));
  console.log(`wrote ${BASELINE} — ${failures.length} known failure(s), ${ran} ran, ${skipped} skipped`);
  console.log(`set PW_FLOOR_RAN=${Math.floor(ran * 0.9)} in run_battery.py`);
  process.exit(0);
}

const known = existsSync(BASELINE)
  ? new Set(readFileSync(BASELINE, "utf-8").split("\n").filter(Boolean))
  : new Set();
const fresh = failures.filter((f) => !known.has(f));
const healed = [...known].filter((f) => !failures.includes(f));
const total = ran + skipped;
const skipRate = total ? skipped / total : 1;

console.log("PLAYWRIGHT GATE");
console.log("=".repeat(62));
console.log(
  `GATE-WORK playwright units=${ran} floor=${FLOOR_RAN} label=e2e-tests-run ` +
    `skipped=${skipped} skip_rate=${(skipRate * 100).toFixed(1)}%`,
);
console.log(
  `  ${ran} ran, ${skipped} skipped; ${failures.length} failing ` +
    `(baseline ${known.size}, new ${fresh.length}, healed ${healed.length})`,
);

const problems = [];
if (fresh.length) {
  problems.push(`${fresh.length} NEW failing test(s)`);
  for (const f of fresh.slice(0, 12)) console.log(`  NEW FAIL ${f}`);
}
if (ran < FLOOR_RAN) {
  problems.push(
    `only ${ran} test(s) ran against a floor of ${FLOOR_RAN} — specs have ` +
      `stopped running, which a pass/fail check cannot see`,
  );
}
if (skipRate > MAX_SKIP_RATE) {
  problems.push(
    `${(skipRate * 100).toFixed(1)}% of tests skipped, ceiling ` +
      `${(MAX_SKIP_RATE * 100).toFixed(0)}% — the suite is going quiet`,
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
  `PASS — no NEW e2e failures (${known.size} known, ${BASELINE})` +
    (healed.length ? `; ${healed.length} healed — rerun with --write-baseline` : ""),
);
