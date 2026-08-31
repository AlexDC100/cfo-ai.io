#!/usr/bin/env node
/**
 * THE HERMETICITY GATE — the vitest suite must not read a developer's machine.
 *
 * ── THE DEFECT THIS EXISTS FOR ───────────────────────────────────────
 * `npx vitest run` was green here and red on every other machine. Three
 * money-boundary tests — G7.a, K10.a, K10.f — passed only because a
 * gitignored `.env` supplied a real VITE_SUPABASE_URL, so the code under
 * test took the "Supabase is configured" branch and reached the seam the
 * assertion counts. Nobody could see it, because a leak of this shape makes
 * the suite MORE green: it fails on the machine that lacks the file, never
 * on the one that has it.
 *
 * frontend/test/envPin.ts pins the env so that can't happen. This gate is
 * what proves the pin is still doing its job — and, more importantly, what
 * catches the NEXT variable, which will not be the one anybody is watching.
 *
 * ── WHAT IT ACTUALLY MEASURES, AND WHY IT IS A DIFFERENTIAL ──────────
 * "Is the env correct?" cannot be answered by reading the env, because a
 * leaked value and a pinned value look identical from inside the run. The
 * only way to tell them apart is to run TWICE and compare:
 *
 *   LOCAL     envDir = repo root   → Vite loads .env / .env.local, exactly
 *                                    as a bare `npx vitest run` does.
 *   HERMETIC  envDir = empty dir   → Vite loads no dotenv file at all,
 *                                    exactly as a fresh clone / CI does.
 *
 * A variable whose resolved value DIFFERS between those two runs came from
 * an untracked local file. That is the hazard, stated exactly, with no
 * proxy in between.
 *
 * The suite is then run both ways in full and the two results compared, so
 * a leak that reaches the tests through a path this file never enumerated
 * still shows up — as the divergence in outcome that a leak always is. That
 * comparison, run against the pre-fix tree, is what named G7.a/K10.a/K10.f.
 *
 * ── HOW IT REFUSES TO PASS VACUOUSLY ─────────────────────────────────
 * Every failure mode of this gate is silent by nature: a broken probe, a
 * config that stops loading dotenv files, an empty census, all produce
 * "no differences found" and exit 0. So:
 *
 *  1. MECHANISM SELF-TEST, first. A sentinel variable is written into a
 *     throwaway dotenv file and the gate proves it can SEE it appear and
 *     DISAPPEAR across the two configurations. If the instrument cannot
 *     detect a leak it planted itself, the gate fails instead of certifying
 *     a machine it cannot measure.
 *  2. CENSUS FLOOR AND CANARY, asserted AFTER the discovery loop (TC-3) —
 *     never inside it, where they could not fire on an empty census.
 *  3. ONE RECORDED EXPECTATION PER VARIABLE, PER RUN (TC-6). Fourteen
 *     variables × two environments = 28 named checks, not one count. The
 *     incident was one variable out of fourteen; a total would have needed
 *     only that one to be missed to read green. Same reason the suite
 *     differential compares the SET OF FAILING TEST NAMES and per-file
 *     counts, not just "how many passed".
 *  4. A VARIABLE THE PRODUCT READS WITH NO ENTRY IN THE MANIFEST FAILS.
 *     The next VITE_ variable someone adds cannot enter unrecorded.
 *
 * Plant log — the proof this gate can fail: design_review/HERMETICITY.md.
 *
 * Run:  node scripts/check_hermetic.mjs [--no-suite] [--verbose]
 *       --no-suite  skips the two full-suite runs (~40 s) and keeps the
 *                   per-variable differential. For iteration only; the
 *                   battery must run the default.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync,
         readdirSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, createHash } from 'node:crypto'

const ROOT = process.cwd()
const MANIFEST_PATH = 'frontend/test/hermeticEnv.json'
const SETUP = 'frontend/test/setup.ts'
const VITEST_CONFIG = 'vitest.config.ts'
const ARGS = new Set(process.argv.slice(2))
const RUN_SUITE = !ARGS.has('--no-suite')

// Dotenv files Vite loads from envDir, in its own precedence order. Every
// one of these is gitignored in this repo, which is precisely why a value
// arriving from one is invisible to review.
const DOTENV_CANDIDATES = ['.env', '.env.local', '.env.development', '.env.development.local',
                           '.env.production', '.env.production.local', '.env.test', '.env.test.local']

// FLOORS. Measured, then rounded down. They catch collapse — a scan that
// stops scanning — not a number to ratchet upward.
// The census is a UNION of three sources (source scan / manifest / dotenv
// files), so a floor on it is a floor on a sum — and a sum cannot see one
// addend collapse. Planting `scan('frontend')` -> `scan('frontend')`
// dropped the source scan from 14 variables to 3 and the census stayed at
// 14, padded by the manifest; only the canary noticed. So the source scan
// carries its OWN floor. (TC-6, caught by this gate's own plant log.)
// Measured 14. Set TO the measurement, not below it: a floor of 12
// against a measured 14 is two units of free headroom, and an audit
// spent them — skipping `frontend/config` alone dropped discovery to
// 12 and the gate passed clean. A floor that tolerates a partial
// collapse is a floor on a sum by another name (TC-6).
const MIN_SOURCE_VARS = 14
const MIN_CENSUS = 12          // measured 14
const MIN_SUITE_TESTS = 1200   // measured 1471
const MIN_SUITE_FILES = 80     // measured 104

// CANARY. Named, not counted: the variable the incident was actually about.
// An empty census, a broken grep, or a manifest that lost its entries cannot
// print this name.
const CANARY_VAR = 'VITE_SUPABASE_URL'
const CANARY_FILE = 'frontend/lib/rates.ts'   // reads VITE_SUPABASE_URL at load

const problems = []
const notes = []
const fail = (m) => problems.push(m)


// ──────────────────────────────────────────────────────────────────────
// 0. The manifest, and the config fields this gate mirrors.
// ──────────────────────────────────────────────────────────────────────
let MANIFEST
try {
  MANIFEST = JSON.parse(readFileSync(join(ROOT, MANIFEST_PATH), 'utf8')).env
} catch (err) {
  console.log('HERMETICITY GATE: MANIFEST UNREADABLE')
  console.log(`  ${MANIFEST_PATH}: ${err.message}`)
  console.log('  Without the recorded expectation there is nothing to check')
  console.log('  against, and a gate with nothing to check against is not a')
  console.log('  gate. This is a hard stop, not a skip.')
  process.exit(1)
}

// A gate that reports env values must never become the thing that publishes
// them. The RECORDED values are safe — they live in a tracked file and are
// deliberately unreachable fakes. An OBSERVED value is not: the leak this
// gate exists to find is, by definition, a real credential from someone's
// untracked .env, and gate output lands in CI logs. So an observed value is
// printed verbatim only when it equals what was recorded; anything else is
// reduced to a fingerprint that is enough to tell two values apart and not
// enough to use.
const RECORDED_VALUES = new Set(Object.values(MANIFEST).filter((v) => typeof v === 'string'))
function show(value) {
  if (value === undefined) return 'undefined'
  if (RECORDED_VALUES.has(value)) return JSON.stringify(value)
  if (value === '') return '"" (empty)'
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 8)
  return `<redacted len=${value.length} sha256:${digest}>`
}

// The two runs below are driven by generated configs rather than by
// vitest.config.ts, because only `envDir` may differ between them. That
// duplication can drift, so it is pinned: if the real config stops matching
// what we mirror, the gate says so rather than silently measuring a suite
// nobody runs.
const configText = readFileSync(join(ROOT, VITEST_CONFIG), 'utf8')
const MIRRORED = [
  { field: 'environment: "jsdom"', why: 'the probe must load the same DOM environment' },
  { field: 'setupFiles: ["./frontend/test/setup.ts"]', why: 'the probe must run the same env pin' },
  { field: 'include: ["frontend/**/*.{test,spec}.{ts,tsx}"]', why: 'the suite runs must cover the same files' },
]
for (const { field, why } of MIRRORED) {
  if (!configText.includes(field)) {
    fail(`vitest.config.ts no longer contains \`${field}\` — this gate mirrors it (${why}).\n` +
         `        Update the MIRRORED table in scripts/check_hermetic.mjs to match.`)
  }
}

// PRESENCE IS HALF THE CHECK. ADDITION IS THE OTHER HALF.
//
// MIRRORED asks whether three fields are still there. An adversarial
// audit walked straight past it by ADDING two: `envDir: "./frontend"`
// pointed the suite at an untracked `frontend/.env`, and `exclude:
// [... hermeticity.test.ts]` removed the in-suite half that would have
// caught it. The gate printed `HERMETICITY: OK` while
// `VITE_ORPHAN_LEAK` was live in `import.meta.env`.
//
// An allowlist checked for presence detects REMOVAL and never ADDITION.
// So the config's env-affecting surface is enumerated: any key here that
// this gate does not know how to mirror is a key that can change what
// the suite loads behind its back.
const ENV_AFFECTING_KEYS = [
  'envDir', 'envPrefix', 'exclude', 'root', 'env:', 'dotenv',
  'setupFiles', 'globalSetup', 'environmentOptions',
]
const KNOWN_CONFIG_KEYS = new Set(['setupFiles'])   // already mirrored above
const surprises = ENV_AFFECTING_KEYS.filter(
  (k) => configText.includes(k) && !KNOWN_CONFIG_KEYS.has(k))
if (surprises.length) {
  fail(`vitest.config.ts carries env-affecting key(s) this gate does not\n` +
       `        mirror: ${surprises.join(', ')}. Each can change what the\n` +
       `        suite loads without moving any variable this gate watches —\n` +
       `        \`envDir\` + \`exclude\` together made it print OK with a live\n` +
       `        leak. Teach the gate to mirror the key, or remove it.`)
}

// ──────────────────────────────────────────────────────────────────────
// 1. MECHANISM SELF-TEST — can this gate see a leak it planted itself?
// ──────────────────────────────────────────────────────────────────────
// realpathSync: on macOS the OS temp dir is a symlink (/var -> /private/var).
// Vite resolves an include path to its real path and then fails to load the
// unresolved one, so the probe silently never runs — the exact "gate examines
// nothing" failure this file is built to make impossible.
const work = realpathSync(mkdtempSync(join(tmpdir(), 'hermetic-gate-')))
const emptyEnvDir = join(work, 'no-env');       mkdirSync(emptyEnvDir)
const sentinelEnvDir = join(work, 'sentinel');  mkdirSync(sentinelEnvDir)

// The generated configs must live where `vitest/config` and the react plugin
// RESOLVE from, which a temp dir outside the repo does not: vite loads a
// config as CJS from its own directory, so a config in /tmp dies on
// "Cannot find module 'vitest/config'". node_modules/ is inside the repo,
// already gitignored, and excluded from vitest's own discovery.
const cfgDir = join(ROOT, 'node_modules', '.hermetic-gate')
rmSync(cfgDir, { recursive: true, force: true })
mkdirSync(cfgDir, { recursive: true })

const nonce = randomBytes(6).toString('hex')
const SENTINEL = `VITE_HERMETIC_SENTINEL_${nonce.toUpperCase()}`
writeFileSync(join(sentinelEnvDir, '.env'), `${SENTINEL}=${nonce}\n`)

const probeFile = join(work, 'hermeticProbe.test.ts')
writeFileSync(probeFile, `
import { it, expect } from "vitest";
import fs from "node:fs";
it("hermetic probe", () => {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const seen: Record<string, string> = {};
  for (const k of Object.keys(env)) {
    if (k.startsWith("VITE_")) seen[k] = String(env[k]);
  }
  fs.writeFileSync(process.env.HERMETIC_PROBE_OUT as string, JSON.stringify(seen));
  expect(true).toBe(true);
});
`)

function writeConfig(name, { envDir, withSetup, include }) {
  const p = join(cfgDir, name)
  writeFileSync(p, `import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
export default defineConfig({
  plugins: [react()],
  root: ${JSON.stringify(ROOT)},
  envDir: ${JSON.stringify(envDir)},
  // The probe file lives outside the repo on purpose (it must not be
  // discoverable by a normal \`npx vitest run\`), and Vite's fs allowlist
  // defaults to the workspace root, which would refuse to load it.
  server: { fs: { allow: [${JSON.stringify(ROOT)}, ${JSON.stringify(work)}] } },
  test: {
    environment: "jsdom",
    globals: true,
    testTimeout: 30000,
    ${withSetup ? `setupFiles: [${JSON.stringify(join(ROOT, SETUP))}],` : ''}
    include: ${JSON.stringify(include)},
  },
  resolve: { alias: { "@": ${JSON.stringify(join(ROOT, 'frontend'))} } },
});
`)
  return p
}

const probeEnvDirUsed = {}
function runProbe(label, { envDir, withSetup }) {
  probeEnvDirUsed[label] = envDir
  const outFile = join(work, `probe.${label}.json`)
  const cfg = writeConfig(`probe.${label}.config.ts`, { envDir, withSetup, include: [probeFile] })
  try {
    execFileSync('npx', ['vitest', 'run', '--config', cfg, '--reporter=dot'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HERMETIC_PROBE_OUT: outFile },
    })
  } catch (err) {
    const tail = ((err.stdout ?? '') + (err.stderr ?? '')).trim().split('\n').slice(-12)
      .map((l) => `          ${l}`).join('\n')
    fail(`the env probe (${label}) did not complete. A probe that cannot run cannot\n` +
         `        clear a machine, so this is a failure and not a skip.\n${tail}`)
    return null
  }
  try {
    return JSON.parse(readFileSync(outFile, 'utf8'))
  } catch {
    fail(`the env probe (${label}) produced no readable result — it did not run.`)
    return null
  }
}

// The instrument, checked against a planted leak, before it is trusted to
// certify anything. `withSetup: false` on purpose: the self-test measures
// the LOADER, not the pin — the pin would delete an unrecorded sentinel and
// hide the very signal being verified.
const sentinelSeen = runProbe('sentinel', { envDir: sentinelEnvDir, withSetup: false })
const sentinelGone = runProbe('sentinel-absent', { envDir: emptyEnvDir, withSetup: false })

if (sentinelSeen && sentinelGone) {
  if (sentinelSeen[SENTINEL] !== nonce) {
    fail(`MECHANISM BLIND: a dotenv file in envDir defined ${SENTINEL}=${nonce}, and the\n` +
         `        probe did not see it. This gate detects leaks by loading dotenv files\n` +
         `        on purpose; if that no longer happens, every check below reports\n` +
         `        "no leak" for a machine it cannot actually read. Suspect the Vite\n` +
         `        \`envDir\` option, or the probe failing to run at all.`)
  }
  if (SENTINEL in sentinelGone) {
    fail(`MECHANISM BLIND: ${SENTINEL} survived into the hermetic run, whose envDir is\n` +
         `        an empty directory. The two configurations are not actually different,\n` +
         `        so the differential below compares a run against itself and can never\n` +
         `        disagree. Suspect an ambient shell export, or envDir being ignored.`)
  }
}

// The sentinel proves the LOADER works. It cannot prove the two
// configurations differ: point the "hermetic" run at the repo root and the
// pin makes both outputs identical, so the differential compares a run
// against itself and reports agreement forever. Nothing downstream can see
// that — the shape is structural, so the check has to be too. (Found by
// PLANT D; the sentinel alone stayed green under it.)
if (emptyEnvDir === ROOT) {
  fail('MECHANISM BLIND: the hermetic envDir IS the repo root, so both runs load the\n' +
       '        same dotenv files and the differential can never disagree.')
} else if (readdirSync(emptyEnvDir).length !== 0) {
  fail(`MECHANISM BLIND: the hermetic envDir is not empty (${readdirSync(emptyEnvDir).join(', ')}).\n` +
       '        It must contain no dotenv file at all, or the "no local config" run\n' +
       '        is running with local config.')
}

// ──────────────────────────────────────────────────────────────────────
// 2. DISCOVERY LOOP — the census of build-time variables.
// ──────────────────────────────────────────────────────────────────────
const requiredBy = new Map()   // VITE_NAME -> Set(relative source path)

function scan(dir) {
  for (const ent of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${ent.name}`
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name.startsWith('.')) continue
      scan(rel)
    } else if (/\.(ts|tsx)$/.test(ent.name)) {
      const text = readFileSync(join(ROOT, rel), 'utf8')
      for (const m of text.matchAll(/VITE_[A-Z0-9_]+/g)) {
        if (!requiredBy.has(m[0])) requiredBy.set(m[0], new Set())
        requiredBy.get(m[0]).add(rel)
      }
    }
  }
}
scan('frontend')

// Which dotenv files exist on THIS machine, and are they untracked? An
// untracked file is the whole hazard: a value no reviewer can see, present
// on one machine only.
const dotenvFound = []            // { file, tracked, keys: {name: value} }
for (const cand of DOTENV_CANDIDATES) {
  const abs = join(ROOT, cand)
  if (!existsSync(abs)) continue
  let tracked = true
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', cand],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] })
  } catch { tracked = false }
  const keys = {}
  let anyKey = 0
  for (const line of readFileSync(abs, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    anyKey++
    if (m[1].startsWith('VITE_')) keys[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  dotenvFound.push({ file: cand, tracked, keys, anyKey })
}

const census = new Set([...requiredBy.keys(), ...Object.keys(MANIFEST)])
for (const d of dotenvFound) for (const k of Object.keys(d.keys)) census.add(k)

// ──────────────────────────────────────────────────────────────────────
// 3. AFTER the loop: canary + floors (TC-3).
// ──────────────────────────────────────────────────────────────────────
if (census.size === 0 || requiredBy.size === 0) {
  console.log('HERMETICITY GATE: DISCOVERY BROKEN')
  console.log(`  ${requiredBy.size} variable(s) found in frontend/**, census of ${census.size}`)
  console.log('  A census that finds nothing is a broken scanner, not a clean tree.')
  console.log('  Every check below would report "no leak" having read no source.')
  rmSync(work, { recursive: true, force: true })
  rmSync(cfgDir, { recursive: true, force: true })
  process.exit(1)
}
if (!requiredBy.has(CANARY_VAR)) {
  fail(`CANARY MISSING: ${CANARY_VAR} was not found anywhere in frontend/**, and it is\n` +
       `        read at module load by ${CANARY_FILE}. The source scan is not reading\n` +
       `        what it thinks it is reading.`)
} else if (!requiredBy.get(CANARY_VAR).has(CANARY_FILE)) {
  fail(`CANARY MOVED: ${CANARY_VAR} is no longer read by ${CANARY_FILE}.\n` +
       `        If that is intentional, repoint CANARY_FILE; if not, the scan is wrong.`)
}
if (requiredBy.size < MIN_SOURCE_VARS) {
  fail(`SOURCE-SCAN FLOOR: ${requiredBy.size} variable(s) found in frontend/**, floor\n` +
       `        ${MIN_SOURCE_VARS}, measured 14. The scan collapsed. Note that the census\n` +
       `        floor below CANNOT catch this — the manifest pads the union back up to\n` +
       `        full size, which is why the two halves are floored separately.`)
}
if (census.size < MIN_CENSUS) {
  fail(`CENSUS FLOOR: ${census.size} variables, floor ${MIN_CENSUS}. Measured at 14.\n` +
       `        A census this small means the scan collapsed, not that the product\n` +
       `        shed variables.`)
}
for (const d of dotenvFound) {
  if (d.anyKey === 0) {
    fail(`${d.file} exists but the parser read zero assignments from it. A dotenv\n` +
         `        parser that reads nothing certifies every machine as clean.`)
  }
}

// THE DIFFERENTIAL'S ONE BLIND SPOT, closed here rather than documented.
// envDir controls dotenv FILES. A variable exported in the ambient shell —
// `export VITE_SUPABASE_URL=...`, or a CI job-level `env:` block, which
// .github/workflows/tier1-validation.yml really does set — is present in
// BOTH runs, so no comparison between them can ever disagree about it. The
// pin still wins for recorded variables; an UNRECORDED one would sail
// straight through. So the shell is checked directly.
for (const name of Object.keys(process.env)) {
  if (!name.startsWith('VITE_') || name in MANIFEST) continue
  fail(`${name} is exported in the ambient shell and has no entry in ${MANIFEST_PATH}.\n` +
       `        The two-environment differential cannot see this: a shell variable is\n` +
       `        present in both runs, so they agree while both are wrong. Record it,\n` +
       `        or unset it before running the suite.`)
}

// A product variable with no recorded expectation is the hole itself.
for (const name of [...requiredBy.keys()].sort()) {
  if (!(name in MANIFEST)) {
    fail(`${name} is read by the product (${[...requiredBy.get(name)].sort()[0]}) but has no\n` +
         `        entry in ${MANIFEST_PATH}. Record it: a pinned value if the suite\n` +
         `        needs one, null if it must be absent. Unrecorded means whatever the\n` +
         `        machine happens to hold.`)
  }
}
for (const name of Object.keys(MANIFEST)) {
  if (!requiredBy.has(name)) {
    notes.push(`${name} is recorded but no longer read by frontend/** — safe, but stale.`)
  }
}

// ──────────────────────────────────────────────────────────────────────
// 4. PER-VARIABLE DIFFERENTIAL — one recorded expectation per variable,
//    per environment (TC-6).
// ──────────────────────────────────────────────────────────────────────
const local = runProbe('local', { envDir: ROOT, withSetup: true })
const hermetic = runProbe('hermetic', { envDir: emptyEnvDir, withSetup: true })

let checked = 0
if (probeEnvDirUsed.local !== ROOT || probeEnvDirUsed.hermetic !== emptyEnvDir ||
    probeEnvDirUsed.local === probeEnvDirUsed.hermetic) {
  fail(`MECHANISM BLIND: the two measured runs did not use the two intended envDirs.\n` +
       `        local=${probeEnvDirUsed.local}\n` +
       `        hermetic=${probeEnvDirUsed.hermetic}\n` +
       `        Every comparison below is between a run and itself.`)
}
if (local && hermetic) {
  for (const name of [...census].sort()) {
    const expected = name in MANIFEST ? MANIFEST[name] : undefined
    const got = { local: local[name], hermetic: hermetic[name] }

    // (a) the two environments must agree — this IS the hazard.
    if (got.local !== got.hermetic) {
      const from = dotenvFound.filter((d) => name in d.keys).map((d) => d.file)
      fail(`${name} RESOLVES FROM THE MACHINE, NOT THE HARNESS.\n` +
           `        with .env files loaded : ${show(got.local)}\n` +
           `        with none loaded       : ${show(got.hermetic)}\n` +
           `        supplied by            : ${from.length ? from.join(', ') + ' (untracked)' : 'the ambient shell'}\n` +
           `        read at load by        : ${[...(requiredBy.get(name) ?? ['(no source reads it)'])].sort().slice(0, 3).join(', ')}\n` +
           `        Pin it in ${MANIFEST_PATH}. Until then this suite tests a\n` +
           `        configuration that exists on exactly one computer.`)
    }
    // (b) and both must equal what was recorded — agreement on a WRONG
    //     value is still wrong, and is what "pinned to a real project URL"
    //     would look like.
    for (const [envLabel, value] of Object.entries(got)) {
      checked++
      if (expected === null && value !== undefined) {
        fail(`${name} is recorded as must-be-absent but resolved to ${show(value)} in the ${envLabel} run.`)
      } else if (typeof expected === 'string' && value !== expected) {
        fail(`${name} is recorded as ${JSON.stringify(expected)} but resolved to ${show(value)} in the ${envLabel} run.\n` +
             `        The pin in frontend/test/envPin.ts did not take effect. Check that\n` +
             `        setup.ts still imports "./envPin" FIRST — ES imports hoist, so an\n` +
             `        import added above it runs before the pin.`)
      }
    }
  }
  if (checked === 0) {
    fail('the per-variable loop made zero comparisons. Census non-empty but nothing was checked.')
  }
}

// ──────────────────────────────────────────────────────────────────────
// 5. SUITE DIFFERENTIAL — run it BOTH ways and compare outcomes.
//    The per-variable check above only sees variables this file enumerated.
//    This one sees the consequence, whatever the path.
// ──────────────────────────────────────────────────────────────────────
function runSuite(label, envDir, include = ['frontend/**/*.{test,spec}.{ts,tsx}']) {
  const jsonPath = join(work, `suite.${label}.json`)
  const cfg = writeConfig(`suite.${label}.config.ts`, { envDir, withSetup: true, include })
  try {
    execFileSync('npx', ['vitest', 'run', '--config', cfg, '--reporter=json', `--outputFile=${jsonPath}`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch { /* non-zero exit just means tests failed; the JSON is the payload */ }
  let raw
  try { raw = JSON.parse(readFileSync(jsonPath, 'utf8')) } catch { return null }
  const files = new Map()
  const failed = new Set()
  let executed = 0
  for (const tr of raw.testResults ?? []) {
    const rel = relative(ROOT, tr.name).split('\\').join('/')
    let n = 0
    for (const a of tr.assertionResults ?? []) {
      if (a.status !== 'passed' && a.status !== 'failed') continue
      n++; executed++
      if (a.status === 'failed') failed.add(`${rel} > ${a.fullName}`)
    }
    files.set(rel, n)
  }
  return { files, failed, executed }
}

if (RUN_SUITE) {
  const a = runSuite('local', ROOT)
  const b = runSuite('hermetic', emptyEnvDir)
  if (!a || !b) {
    fail('one of the two suite runs produced no parseable result. A run that cannot\n' +
         '        be read is not evidence of agreement.')
  } else {
    // Floors first — two empty runs agree perfectly.
    if (a.executed < MIN_SUITE_TESTS || a.files.size < MIN_SUITE_FILES) {
      fail(`SUITE FLOOR: local run executed ${a.executed} test(s) over ${a.files.size} file(s);\n` +
           `        floors are ${MIN_SUITE_TESTS}/${MIN_SUITE_FILES}. Two runs that both examine\n` +
           `        nothing agree on nothing, and that is the shape this gate must not pass.`)
    }
    if (b.executed < MIN_SUITE_TESTS || b.files.size < MIN_SUITE_FILES) {
      fail(`SUITE FLOOR: hermetic run executed ${b.executed} test(s) over ${b.files.size} file(s);\n` +
           `        floors are ${MIN_SUITE_TESTS}/${MIN_SUITE_FILES}.`)
    }
    // Per-file counts, not just the total (TC-6): one file collapsing to a
    // single test is invisible in a sum that stays above a floor.
    for (const [relPath, n] of a.files) {
      const m = b.files.get(relPath)
      if (m === undefined) {
        fail(`${relPath} ran with dotenv files loaded and DID NOT RUN without them.`)
      } else if (m !== n) {
        fail(`${relPath} executed ${n} test(s) locally and ${m} hermetically.`)
      }
    }
    for (const relPath of b.files.keys()) {
      if (!a.files.has(relPath)) fail(`${relPath} ran only in the hermetic environment.`)
    }
    // The signature of the original incident: the same suite, two machines,
    // a different set of red lines.
    let onlyLocal = [...a.failed].filter((t) => !b.failed.has(t))
    let onlyHermetic = [...b.failed].filter((t) => !a.failed.has(t))

    // CONFIRMATION PASS. The two suite runs are ~20 s apart, so a divergence
    // can come from something other than the environment: a flaky test, or —
    // measured, during this gate's own bring-up — a second lane editing
    // frontend/components/instrument/shell/** BETWEEN the two runs, which
    // made a test that had nothing to do with env look like a leak. An
    // unconfirmed accusation is worse than none: it teaches people to ignore
    // this gate. So the divergent FILES are re-run back to back, and each
    // finding is reported as what it actually is.
    const suspectFiles = [...new Set([...onlyLocal, ...onlyHermetic].map((t) => t.split(' > ')[0]))]
    let unreproduced = []
    if (suspectFiles.length) {
      const ra = runSuite('confirm-local', ROOT, suspectFiles)
      const rb = runSuite('confirm-hermetic', emptyEnvDir, suspectFiles)
      if (!ra || !rb) {
        fail('the confirmation re-run produced no parseable result.')
      } else {
        const stillHermetic = new Set([...rb.failed].filter((t) => !ra.failed.has(t)))
        const stillLocal = new Set([...ra.failed].filter((t) => !rb.failed.has(t)))
        unreproduced = [...onlyHermetic.filter((t) => !stillHermetic.has(t)),
                        ...onlyLocal.filter((t) => !stillLocal.has(t))]
        onlyHermetic = onlyHermetic.filter((t) => stillHermetic.has(t))
        onlyLocal = onlyLocal.filter((t) => stillLocal.has(t))
      }
    }

    for (const t of onlyHermetic) {
      fail(`PASSES ONLY BECAUSE OF A LOCAL FILE — ${t}\n` +
           `        Green with .env / .env.local loaded, RED without them, twice.\n` +
           `        This is the exact shape of the G7.a / K10.a / K10.f defect: the\n` +
           `        test is reaching something a developer machine happens to provide.`)
    }
    for (const t of onlyLocal) {
      fail(`FAILS ONLY BECAUSE OF A LOCAL FILE — ${t}\n` +
           `        Red with .env / .env.local loaded, green without them, twice.`)
    }
    for (const t of unreproduced) {
      // Still a failure, and deliberately so: a suite whose result depends on
      // WHEN you run it cannot answer the question this gate asks. Silently
      // dropping these would be the gate asserting less to stay green.
      fail(`NOT REPRODUCIBLE — ${t}\n` +
           `        Passed in one environment and failed in the other, then did not do\n` +
           `        it again on the confirmation re-run. Either the test is flaky or\n` +
           `        the working tree changed between the two runs (another lane mid-\n` +
           `        edit). Settle the tree and re-run; a differential cannot measure a\n` +
           `        moving target.`)
    }
    // Report what was actually compared, never a conclusion. An earlier
    // draft of this line said "identical set" unconditionally and printed
    // it in the same output as a divergence it had just reported — a
    // summary that cannot disagree with the run is decoration, not evidence.
    const agree = onlyLocal.length === 0 && onlyHermetic.length === 0
    notes.push(`suite differential: ${a.executed} tests over ${a.files.size} files with dotenv ` +
               `loaded, ${b.executed} over ${b.files.size} without; ` +
               `${a.failed.size} / ${b.failed.size} failing; ` +
               (agree ? 'failing sets identical.'
                      : `${onlyHermetic.length} test(s) pass ONLY with a local file, ` +
                        `${onlyLocal.length} fail ONLY with one.`))
  }
} else {
  notes.push('suite differential SKIPPED (--no-suite) — per-variable check only.')
}

rmSync(work, { recursive: true, force: true })
rmSync(cfgDir, { recursive: true, force: true })

// ──────────────────────────────────────────────────────────────────────
// 6. Verdict.
// ──────────────────────────────────────────────────────────────────────
console.log('HERMETICITY GATE')
console.log(`  census            : ${census.size} build-time variables (${requiredBy.size} read by frontend/**)`)
console.log(`  recorded          : ${Object.keys(MANIFEST).length} in ${MANIFEST_PATH}`)
console.log(`  comparisons       : ${checked} (one per variable per environment)`)
console.log(`  dotenv on this box: ${dotenvFound.length ? dotenvFound.map((d) => `${d.file}${d.tracked ? '' : ' (untracked)'}[${Object.keys(d.keys).length} VITE_]`).join(', ') : 'none'}`)
console.log(`  mechanism         : sentinel ${SENTINEL} seen in a loaded dotenv dir, absent in an empty one`)
console.log(`  canary            : ${CANARY_VAR} read by ${CANARY_FILE}`)
// The battery's canary substring. Every other line above can be printed by a
// run that measured nothing; this one carries a value that only exists if
// both probes actually executed and returned it.
console.log(`  verified          : ${CANARY_VAR} = ${show(local?.[CANARY_VAR])} with the local dotenv files loaded, ` +
            `${show(hermetic?.[CANARY_VAR])} with none`)
for (const n of notes) console.log(`  note              : ${n}`)
console.log(`GATE-WORK hermetic units=${census.size}`)

if (problems.length) {
  console.log('')
  console.log(`HERMETICITY: ${problems.length} PROBLEM(S)`)
  for (const p of problems) console.log(`  - ${p}`)
  console.log('')
  console.log('  A suite that reads an untracked file on one machine is not a suite,')
  console.log('  it is a machine. Fix by recording the variable in')
  console.log(`  ${MANIFEST_PATH} — never by adding the value to everyone's .env.`)
  process.exit(1)
}
console.log('HERMETICITY: OK — every recorded variable resolves identically with and without the local dotenv files.')
