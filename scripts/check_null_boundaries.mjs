#!/usr/bin/env node
/**
 * THE NULL-BOUNDARY GATE — every `number | null` that flows into
 * something typed `number` is a silent zero waiting for its first caller.
 *
 * ── WHY THE EXISTING TYPECHECK GATE CANNOT SEE THIS ───────────────────
 *
 * `scripts/check_tsc.mjs` is honest and works: it loads the real
 * projects, counts the files, and fails on a NEW error. But it compiles
 * with the repo's own `tsconfig.app.json`, which says:
 *
 *     "strict": false
 *
 * and `strict: false` turns OFF `strictNullChecks`. With
 * `strictNullChecks` off, TypeScript treats `null` and `undefined` as
 * members of every type, so
 *
 *     const balanceCheck: number = toDisplay(core.differenceCents)  // number | null
 *     bs_balance_check: served.difference()                          // number | null
 *     originalDifference: facts.difference()                         // number | null
 *
 * all compile silently. In JavaScript `null / 100` is `0`, `Math.abs(null)`
 * is `0`, `Math.max(null, 1)` is `1`, and `x / null` is `Infinity` — so
 * each of those is a fabricated figure, a fabricated verdict, or a
 * fabricated picture of perfect health, wearing a `number` type.
 *
 * The last wave introduced a family of `number | null` fields precisely
 * so that an unfiled figure could stay unfiled. Under `strict: false`
 * nothing then checks that the consumers noticed. THIS gate is that
 * check: it runs `tsc` over the same frontend sources with
 * `strictNullChecks: true` and nothing else changed, and holds the result
 * to a baseline that MAY ONLY SHRINK.
 *
 * It is deliberately NOT a "fix all of these" gate — the frontend does
 * not compile clean under strict-null today and pretending otherwise
 * would make it un-runnable and therefore ignored. It is a RATCHET: the
 * known boundaries are recorded with their file and message, a new one
 * fails immediately, and a healed one has to be removed from the baseline
 * before the gate goes green again (so the baseline cannot rot upward or
 * silently keep dead entries).
 *
 * Keys drop line and column, exactly like `check_tsc.mjs`, so an edit
 * above an error does not read as a new error.
 *
 * Run:  node scripts/check_null_boundaries.mjs [--write-baseline]
 *
 * NOT REGISTERED in scripts/run_battery.py — hand it to the battery
 * owner. Until it is registered it is a gate that runs only when someone
 * runs it, which is not a gate.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const BASELINE = 'design_review/NULL_BOUNDARY_BASELINE.txt'
const WRITE = process.argv.includes('--write-baseline')

/** The only error codes this gate is about. Everything else tsc reports
 *  under strict-null (unrelated inference changes, JSX ref variance) is
 *  noise for THIS question and is filtered out, so the baseline stays
 *  readable and a new nullability hole is impossible to lose in it. */
const NULL_CODES = new Set([
  'TS2322', // Type 'X | null' is not assignable to type 'X'
  'TS2345', // Argument of type 'X | null' is not assignable to parameter 'X'
  'TS2531', // Object is possibly 'null'
  'TS2532', // Object is possibly 'undefined'
  'TS18047', // 'x' is possibly 'null'
  'TS18048', // 'x' is possibly 'undefined'
  'TS18049', // 'x' is possibly 'null' or 'undefined'
])

/** A message only counts when it is actually about null/undefined —
 *  TS2322 also fires on plain shape mismatches. */
const ABOUT_NULLISH = /\bnull\b|\bundefined\b/

// ── build a throwaway strict-null project over the SAME sources ────────
//
// It extends nothing: `extends` would re-root the relative `include`,
// `paths` and `typeRoots` against the temp directory and silently compile
// ZERO files — the false-green shape check_tsc.mjs was written to kill.
// Every path below is absolute for the same reason.
const dir = mkdtempSync(join(tmpdir(), 'nullgate-'))
const cfgPath = join(dir, 'tsconfig.nullgate.json')
const cfg = {
  compilerOptions: {
    types: ['vitest/globals'],
    typeRoots: [
      resolve(ROOT, 'node_modules/@types'),
      resolve(ROOT, 'node_modules'),
    ],
    target: 'ES2020',
    useDefineForClassFields: true,
    lib: ['ES2020', 'DOM', 'DOM.Iterable'],
    module: 'ESNext',
    skipLibCheck: true,
    moduleResolution: 'bundler',
    allowImportingTsExtensions: true,
    isolatedModules: true,
    moduleDetection: 'force',
    noEmit: true,
    jsx: 'react-jsx',
    // The ONLY difference from tsconfig.app.json.
    strict: false,
    strictNullChecks: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
    noImplicitAny: false,
    noFallthroughCasesInSwitch: false,
    baseUrl: ROOT,
    paths: { '@/*': ['./frontend/*'] },
  },
  include: [resolve(ROOT, 'frontend')],
}
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

let raw = ''
try {
  execFileSync('npx', ['tsc', '-p', cfgPath], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
} catch (e) {
  raw = `${e.stdout ?? ''}${e.stderr ?? ''}`
}

// ── COVERAGE FLOOR — a gate over nothing is not a clean gate ───────────
//
// This is the `check_tsc.mjs` lesson: a solution-style config, a moved
// `include` or a broken alias makes tsc load ZERO files, report ZERO
// errors and exit 0 in a fraction of a second, and a green gate invites
// no reading. So COUNT WHAT TSC ACTUALLY WALKED, from the same config,
// before the temp directory goes away.
let filesSeen = 0
try {
  const listing = execFileSync('npx', ['tsc', '-p', cfgPath, '--listFilesOnly'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  })
  filesSeen = listing
    .split('\n')
    .filter((l) => l.includes(`${ROOT}/frontend/`) || l.includes('/frontend/'))
    .length
} catch (e) {
  const out = `${e.stdout ?? ''}`
  filesSeen = out.split('\n').filter((l) => l.includes('/frontend/')).length
}
rmSync(dir, { recursive: true, force: true })

const lines = raw.split('\n')
const findings = []
for (const line of lines) {
  const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line)
  if (!m) continue
  const [, file, , , code, message] = m
  if (!NULL_CODES.has(code)) continue
  if (!ABOUT_NULLISH.test(message)) continue
  // Key drops line/col so an unrelated edit above does not read as new.
  findings.push(`${file.replace(`${ROOT}/`, '')} :: ${code} :: ${message.trim()}`)
}
findings.sort()

const FLOOR = 400
console.log('NULL-BOUNDARY GATE')
console.log('='.repeat(62))
console.log(
  `GATE-WORK null-boundaries units=${filesSeen} floor=${FLOOR} ` +
    `label=frontend-files-typechecked-under-strictNullChecks`,
)
if (filesSeen < FLOOR) {
  console.log(
    `\nFAIL — tsc walked only ${filesSeen} frontend file(s) (floor ${FLOOR}). ` +
      'A strict-null check over nothing is not a clean strict-null check.',
  )
  process.exit(1)
}

if (WRITE) {
  writeFileSync(join(ROOT, BASELINE), `${findings.join('\n')}\n`)
  console.log(`\nBASELINE WRITTEN — ${findings.length} known null boundary/-ies.`)
  process.exit(0)
}

let baseline = []
try {
  baseline = readFileSync(join(ROOT, BASELINE), 'utf8').split('\n').filter(Boolean)
} catch {
  console.log(
    `\nFAIL — no baseline at ${BASELINE}. Run with --write-baseline once, ` +
      'then review what it recorded.',
  )
  process.exit(1)
}

const known = new Map()
for (const b of baseline) known.set(b, (known.get(b) ?? 0) + 1)
const seen = new Map()
for (const f of findings) seen.set(f, (seen.get(f) ?? 0) + 1)

const added = []
for (const [k, n] of seen) {
  const wasN = known.get(k) ?? 0
  for (let i = wasN; i < n; i++) added.push(k)
}
const healed = []
for (const [k, n] of known) {
  const nowN = seen.get(k) ?? 0
  for (let i = nowN; i < n; i++) healed.push(k)
}

console.log(
  `  ${findings.length} null boundary/-ies (baseline ${baseline.length}, ` +
    `new ${added.length}, healed ${healed.length})`,
)

if (added.length) {
  console.log('\nFAIL — NEW null boundary/-ies:\n')
  for (const a of added) console.log(`  + ${a}`)
  console.log(
    '\nA `number | null` reaching something typed `number` is not a type\n' +
      'nit: `null / 100` is 0, `Math.abs(null)` is 0, `Math.max(null, 1)`\n' +
      'is 1 and `x / null` is Infinity. Guard the read, or widen the\n' +
      'consumer and state the absence where a reader can see it.',
  )
  process.exit(1)
}

if (healed.length) {
  console.log('\nFAIL — HEALED, but still in the baseline:\n')
  for (const h of healed) console.log(`  - ${h}`)
  console.log(
    '\nThe baseline may only ever shrink, and it must shrink DELIBERATELY:\n' +
      're-run with --write-baseline so the record matches the tree. A\n' +
      'baseline carrying entries that no longer exist quietly widens the\n' +
      'allowance for the next one.',
  )
  process.exit(1)
}

console.log(`\nPASS — no NEW null boundaries (${baseline.length} known, ${BASELINE}).`)
