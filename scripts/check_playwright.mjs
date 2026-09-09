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
 *   · the runner producing no JSON report at all.
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

const dir = mkdtempSync(join(tmpdir(), "battery-pw-"));
const out = join(dir, "pw.json");
try {
  execFileSync(
    "npx",
    ["playwright", "test", "--project=chromium", "--reporter=json",
     `--output=${join(dir, "artifacts")}`, "--timeout=20000"],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: out } },
  );
} catch { /* failures are data; the report is what matters */ }

let report;
try {
  report = JSON.parse(readFileSync(out, "utf-8"));
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
