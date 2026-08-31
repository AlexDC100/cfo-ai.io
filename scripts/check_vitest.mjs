#!/usr/bin/env node
/**
 * The vitest gate — a ratchet, in the shape of scripts/check_tsc.mjs.
 *
 * `npx vitest run` was already being pasted as proof by every lane. On its
 * own it is not a gate: it reports a number nobody compares against a
 * recorded expectation, so a suite that quietly stops running tests reads
 * exactly like a suite that passes them. This file makes the number
 * answerable.
 *
 * WHAT IT ASSERTS, and why each one exists:
 *
 *  1. ZERO TESTS RUN IS A FAILURE, NOT A PASS.
 *     The `npx tsc --noEmit` incident in this repo was precisely this: a
 *     command that examined nothing and exited 0, pasted as proof for
 *     weeks. `--include` pointed at a moved directory, a config typo, a
 *     crashed worker — all of them produce "0 failed" and all of them are
 *     the failure this gate exists to catch.
 *
 *  2. A NEW FAILURE FAILS. The baseline may only ever shrink.
 *
 *  3. A HEALED-BUT-BASELINED ENTRY ALSO FAILS.
 *     Stricter than check_tsc.mjs, deliberately: that gate only PRINTS
 *     "these are fixed, re-run with --write-baseline", which means a
 *     loosened ratchet can sit there indefinitely being advisory. Here it
 *     is an error, so the baseline is forced to tighten the moment a test
 *     is repaired and can never silently re-absorb it later.
 *
 *  4. PER-FILE FLOORS, ASSERTED AFTER THE DISCOVERY LOOP (TC-6).
 *     A floor on the TOTAL cannot notice one addend collapsing. This is
 *     not hypothetical here: `import-boundary` printed "boundary holds"
 *     with a real violation planted, because the frontend half fell
 *     517 -> 1 while the total stayed above a global floor. So the
 *     baseline records an executed-test count PER TEST FILE, and every one
 *     is checked. A file that collapses 32 -> 1, or disappears entirely,
 *     fails even while the suite total looks healthy.
 *
 *  5. ONLY TESTS THAT ACTUALLY RAN COUNT.
 *     `status: "pending"` (`.skip`/`.todo`) is excluded from a file's
 *     count. Turning a failing test into a skipped one is the cheapest way
 *     to make a suite green while asserting less; under this gate it reads
 *     as a dropped test and fails. "NEVER fix a test by asserting less" is
 *     thereby mechanical rather than a matter of reviewer attention.
 *
 * The canary is asserted AFTER the discovery loop, never inside it: a
 * check inside the loop cannot fire when discovery returns nothing, which
 * is the one case it exists to catch (TC-3).
 *
 * Run:  node scripts/check_vitest.mjs [--write-baseline]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = process.cwd()
const BASELINE = 'design_review/VITEST_BASELINE.json'

// Floors on the whole run. These are not the per-file assertion (see
// FILE FLOORS below) — they are the coarse "did the runner run at all"
// tripwire, and they are what makes an empty run loud instead of green.
const MIN_FILES = 80
const MIN_TESTS = 1200

// DISCOVERY CANARY. A test file that must always be discovered. Chosen
// because it is the suite's own harness self-test: if the runner is
// working at all, this file ran.
const CANARY = 'frontend/test/harness.test.ts'

const out = mkdtempSync(join(tmpdir(), 'vitest-gate-'))
const jsonPath = join(out, 'results.json')

let raw
try {
  execFileSync('npx',
    ['vitest', 'run', '--reporter=json', `--outputFile=${jsonPath}`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'] })
} catch {
  // vitest exits non-zero when tests fail; the JSON file is the payload.
}
try {
  raw = JSON.parse(readFileSync(jsonPath, 'utf8'))
} catch (err) {
  console.log('VITEST GATE: RUNNER PRODUCED NO PARSEABLE RESULT')
  console.log(`  expected JSON at ${jsonPath}`)
  console.log(`  ${err.message}`)
  console.log('  A run that cannot even be read is not a pass.')
  rmSync(out, { recursive: true, force: true })
  process.exit(1)
}
rmSync(out, { recursive: true, force: true })

// ── discovery loop ───────────────────────────────────────────────────
const fileCounts = new Map()   // relpath -> executed test count
const failures = []            // "relpath|fullName"
let executedTotal = 0
let skipped = 0

for (const tr of raw.testResults ?? []) {
  const rel = relative(ROOT, tr.name).split('\\').join('/')
  let executed = 0
  for (const a of tr.assertionResults ?? []) {
    if (a.status === 'passed' || a.status === 'failed') {
      executed++
      executedTotal++
      if (a.status === 'failed') failures.push(`${rel}|${a.fullName}`)
    } else {
      skipped++
    }
  }
  fileCounts.set(rel, executed)
}

// ── assertions AFTER the loop (TC-3) ─────────────────────────────────
const sawCanary = fileCounts.has(CANARY)
if (!sawCanary || fileCounts.size === 0 || executedTotal === 0) {
  console.log('VITEST GATE: DISCOVERY BROKEN')
  console.log(`  ${fileCounts.size} test file(s), ${executedTotal} test(s) executed`)
  console.log(`  canary ${CANARY} ${sawCanary ? 'seen' : 'NOT seen'}`)
  if (executedTotal === 0) {
    console.log('  Zero tests over zero files is not a pass.')
  } else {
    // The dangerous case, and the reason the canary is named rather than
    // counted: a PARTIAL discovery loss still reports a healthy-looking
    // green. Narrowing the include glob to frontend/lib leaves bare
    // `npx vitest run` printing "45 passed (45) / 853 passed" and exiting
    // 0 — a result a lane would paste as proof.
    console.log('  Tests ran, but the canary file was not among them, so')
    console.log('  this run examined only PART of the suite. A partial run')
    console.log('  still reports a green total; that is what makes it worse')
    console.log('  than an empty one.')
  }
  console.log('  Check the `include` glob in vitest.config.ts, the setup')
  console.log('  files, and any --project / --dir filter in the invocation.')
  process.exit(1)
}
if (fileCounts.size < MIN_FILES || executedTotal < MIN_TESTS) {
  console.log('VITEST GATE: WORK COUNT BELOW FLOOR')
  console.log(`  files ${fileCounts.size} (floor ${MIN_FILES}), `
    + `tests ${executedTotal} (floor ${MIN_TESTS})`)
  console.log('  The suite shrank sharply. If deliberate, lower the floor')
  console.log('  in this file in the same commit that removes the tests.')
  process.exit(1)
}

failures.sort()

if (process.argv.includes('--write-baseline')) {
  const files = {}
  for (const k of [...fileCounts.keys()].sort()) files[k] = fileCounts.get(k)
  writeFileSync(join(ROOT, BASELINE),
    JSON.stringify({ failures, files }, null, 2) + '\n')
  console.log(`WROTE ${failures.length} failure(s) and `
    + `${Object.keys(files).length} file floor(s) to ${BASELINE}`)
  process.exit(0)
}

let baseline = { failures: [], files: {} }
let haveBaseline = true
try {
  baseline = JSON.parse(readFileSync(join(ROOT, BASELINE), 'utf8'))
} catch { haveBaseline = false }

// Multiset compare, as in check_tsc.mjs: the same test name can occur in
// two files, and collapsing to a Set would let a duplicate slip in free.
const remaining = (baseline.failures ?? []).slice()
const fresh = []
for (const k of failures) {
  const i = remaining.indexOf(k)
  if (i === -1) fresh.push(k)
  else remaining.splice(i, 1)
}

// FILE FLOORS — the per-component assertion. A global count cannot see
// one file collapse; this can.
const shrunk = []
const grown = []
const vanished = []
for (const [rel, want] of Object.entries(baseline.files ?? {})) {
  if (!fileCounts.has(rel)) { vanished.push(`${rel} (expected ${want})`); continue }
  const got = fileCounts.get(rel)
  if (got < want) shrunk.push(`${rel}: ${got} executed, baseline ${want}`)
  // A file that GREW is unasserted headroom: those extra tests can be
  // deleted or `.skip`ped later and the floor will not notice. An
  // adversarial audit found exactly this — capsuleCraft.test.tsx recorded
  // 10 while executing 15, and the five unguarded ones were precisely the
  // tests written to prove TC-7. `it.skip` on one of them passed.
  //
  // A ratchet that only tightens downward is half a ratchet.
  if (got > want) grown.push(`${rel}: ${got} executed, baseline ${want} `
    + `(${got - want} unasserted)`)
}

console.log('VITEST GATE')
console.log('='.repeat(62))
console.log(`GATE-WORK vitest units=${executedTotal} floor=${MIN_TESTS} `
  + `label=tests-executed`)
console.log(`  ${fileCounts.size} test file(s), ${executedTotal} test(s) `
  + `executed, ${skipped} skipped (canary ${CANARY} seen)`)
console.log(`  ${failures.length} failing (baseline `
  + `${(baseline.failures ?? []).length}, new ${fresh.length}, `
  + `healed ${remaining.length})`)
if (!haveBaseline) {
  console.log('')
  console.log(`FAIL — no ${BASELINE}. Run with --write-baseline to record one.`)
  process.exit(1)
}

let bad = false
if (fresh.length) {
  bad = true
  console.log('')
  console.log('FAIL — NEW failing tests:')
  for (const k of fresh) {
    const [file, name] = k.split('|')
    console.log(`  ${file}`)
    console.log(`      ${name}`)
  }
}
if (remaining.length) {
  bad = true
  console.log('')
  console.log('FAIL — these are FIXED but still baselined. The ratchet only')
  console.log('tightens: re-run with --write-baseline in the same commit.')
  for (const k of remaining) console.log(`  ${k}`)
}
if (vanished.length) {
  bad = true
  console.log('')
  console.log('FAIL — baselined test files produced NO results (deleted,')
  console.log('renamed, or no longer matched by the include glob):')
  for (const k of vanished) console.log(`  ${k}`)
}
if (grown.length) {
  bad = true
  console.log('')
  console.log('FAIL — these files ran MORE tests than the baseline records,')
  console.log('so the extra ones are unguarded: they can be deleted or')
  console.log('`.skip`ped later and no floor will notice. Tighten with')
  console.log('--write-baseline in the same commit.')
  for (const k of grown) console.log(`  ${k}`)
}
if (shrunk.length) {
  bad = true
  console.log('')
  console.log('FAIL — these files ran FEWER tests than the baseline records.')
  console.log('A suite total stays healthy while one file collapses; that is')
  console.log('the failure this per-file floor exists to catch. A test turned')
  console.log('`.skip` counts as dropped, by design.')
  for (const k of shrunk) console.log(`  ${k}`)
}
if (bad) process.exit(1)

console.log('')
console.log(`PASS — no new failures, none healed-but-baselined, no file `
  + `below its floor (${BASELINE}).`)
