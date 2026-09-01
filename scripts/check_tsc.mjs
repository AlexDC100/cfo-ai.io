#!/usr/bin/env node
/**
 * The typecheck gate — the one that actually typechecks.
 *
 * `npx tsc --noEmit` was in the battery, and every lane pasted it as
 * proof. It checked ZERO FILES. The root tsconfig.json is a
 * solution-style config: `"files": []` with `references` to
 * tsconfig.app.json and tsconfig.node.json. Without `-b`, tsc obeys
 * `files: []` literally, finds nothing to check, and exits 0 in 0.2s.
 * The runtime was the tell — a real check of ~610 frontend files takes
 * tens of seconds — and nobody read it as one, because a green gate
 * invites no reading.
 *
 * That is a FALSE GREEN of the same family as a selector pointed at a
 * removed element, and a worse one: it silently covered 102 real type
 * errors across 32 files.
 *
 * Fixing all 102 is not this gate's job. Recording them is. The
 * baseline is allowed and may only ever shrink; a NEW error fails
 * immediately. Keys drop line and column so an unrelated edit above an
 * error does not read as a new one.
 *
 * Run:  node scripts/check_tsc.mjs [--write-baseline]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const BASELINE = 'design_review/TSC_BASELINE.txt'

// PER-PROJECT CANARY AND FLOOR — TC-6, learned the hard way twice.
//
// This gate used to carry ONE canary (`frontend/main.tsx`) and ONE floor
// (400) over the SUM of every project. That is the `import-boundary`
// shape exactly: the frontend half collapsed 517 -> 1 while the total
// stayed above a global floor, and both named canaries survived, because
// they lived in the half that did not collapse.
//
// Concretely, and this is not hypothetical here: `tsconfig.e2e.json` is
// added below covering 41 files. Under the old single-floor scheme, if
// that project's `include` were mistyped tomorrow and matched nothing,
// the total would fall 714 -> 673, still 1.7x the global floor of 400,
// and `frontend/main.tsx` would still be seen. The gate would print
// GREEN while the entire Playwright suite went unchecked again — the
// very defect this project was added to close.
//
// So each project names a file it MUST have loaded and a count it MUST
// clear, and both are asserted after every project has run.
const PROJECTS = [
  {
    config: 'tsconfig.app.json',
    // The app entry point: if the project graph is real, tsc loaded it.
    canary: 'frontend/main.tsx',
    floor: 400,        // 682 measured 2026-09-01
    label: 'app',
  },
  {
    config: 'tsconfig.node.json',
    // This project is exactly one file by design; the canary IS the
    // subject, and the floor of 1 is not slack, it is the whole project.
    canary: 'vite.config.ts',
    floor: 1,          // 1 measured 2026-09-01
    label: 'node',
  },
  {
    // THE SUITE IS SOURCE TOO. `e2e/` was in NO tsconfig project until
    // 2026-09-01, so this gate — the one written because
    // `npx tsc --noEmit` checked zero files — said NOTHING about any of
    // the 37 spec/helper files that constitute the Playwright gates.
    // TC-9 one directory over. A spec that does not compile cannot fail
    // correctly, and a broken gate is the false green the battery exists
    // to prevent.
    config: 'tsconfig.e2e.json',
    // The shared helper every authed spec imports. If discovery breaks,
    // this is the first file to vanish.
    canary: 'e2e/_helpers.ts',
    floor: 30,         // 41 measured 2026-09-01 (37 e2e .ts + 3 configs/scripts)
    label: 'e2e',
  },
]

// THE WORK COUNT IS THIS GATE'S WHOLE POINT.
//
// The defect it replaced did not report a wrong number — it reported NO
// number, and exit 0 was read as proof. `--listFiles` makes tsc name
// every file it actually loaded, so "0 project files" becomes visible
// instead of indistinguishable from "0 errors". Ambient .d.ts and
// node_modules typings are excluded from the count: they load even for
// an empty project, so counting them would recreate the blind spot at a
// higher number.
//
// Cost: --listFiles adds output, not compilation. It does not slow the
// check; it only makes it answerable.
let projectFilesChecked = 0
const projectFilesSeen = new Set()
/** label -> Set of project files THAT project loaded. Per-project, because
 *  a union cannot see one member collapse (TC-6). */
const seenByProject = new Map()

function run(project) {
  const mine = new Set()
  seenByProject.set(project.label, mine)
  let out = ''
  try {
    out = execFileSync('npx',
      ['tsc', '-p', project.config, '--noEmit', '--listFiles'],
      { cwd: ROOT, encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    // tsc exits non-zero when it finds errors; that is the payload.
    out = `${err.stdout || ''}${err.stderr || ''}`
  }
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(line)) continue
    if (line.includes('/node_modules/')) continue
    if (line.endsWith('.d.ts')) continue
    if (!line.startsWith(ROOT)) continue
    projectFilesSeen.add(line)
    mine.add(line)
  }
  return out
}

// "path/File.tsx(236,54): error TS2322: message" -> "path/File.tsx|TS2322|message"
const LINE_RX = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/
function parse(out) {
  const keys = []
  for (const line of out.split('\n')) {
    const m = LINE_RX.exec(line.trim())
    if (!m) continue
    keys.push(`${m[1]}|${m[4]}|${m[5]}`)
  }
  return keys
}

let all = []
for (const p of PROJECTS) all = all.concat(parse(run(p)))
all.sort()
projectFilesChecked = projectFilesSeen.size

// DISCOVERY CANARY AND FLOOR, PER PROJECT — asserted here, AFTER every
// project has run (TC-3: a check inside the loop cannot fire for a
// component the loop never visited).
//
// A canary names a FILE and a floor names a NUMBER, and each on its own
// survives the failure it exists to catch: the canary if the collapse
// spares that one file, the floor if it is a SUM and only one addend
// goes. So this is per project, and both are required.
const projectReport = []
let discoveryBroken = false
for (const p of PROJECTS) {
  const mine = seenByProject.get(p.label) ?? new Set()
  const count = mine.size
  const sawCanary = [...mine].some((f) => f.endsWith(`/${p.canary}`))
  projectReport.push({ ...p, count, sawCanary })
  if (!sawCanary || count < p.floor) discoveryBroken = true
}

if (discoveryBroken) {
  console.log('TYPECHECK GATE: DISCOVERY BROKEN')
  for (const r of projectReport) {
    const ok = r.sawCanary && r.count >= r.floor
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${r.label} (${r.config}): `
      + `${r.count} file(s), floor ${r.floor}; `
      + `canary ${r.canary} ${r.sawCanary ? 'seen' : 'NOT seen'}`)
  }
  console.log('')
  console.log('  This is the original defect, per project: a tsconfig that')
  console.log('  matches nothing makes tsc check NOTHING and exit 0. Zero')
  console.log('  errors over zero files is not a pass — and a global floor')
  console.log('  over the SUM cannot see one project collapse (TC-6).')
  process.exit(1)
}

if (process.argv.includes('--write-baseline')) {
  writeFileSync(join(ROOT, BASELINE), all.join('\n') + '\n')
  console.log(`WROTE ${all.length} errors to ${BASELINE}`)
  process.exit(0)
}

let baseline = []
try {
  baseline = readFileSync(join(ROOT, BASELINE), 'utf8')
    .split('\n').map((l) => l.trim()).filter(Boolean)
} catch { /* no baseline: every error is new */ }

// Multiset compare — the same message can legitimately occur twice in
// one file, and collapsing to a Set would let a duplicate slip in free.
const remaining = baseline.slice()
const fresh = []
for (const k of all) {
  const i = remaining.indexOf(k)
  if (i === -1) fresh.push(k)
  else remaining.splice(i, 1)
}

console.log('TYPECHECK GATE')
console.log('='.repeat(62))
// The SUM line the battery's work-count layer reads. It is kept, and it
// is deliberately NOT the only floor: see the per-project lines below,
// which are what actually gate this script when CI invokes it directly.
console.log(`GATE-WORK tsc units=${projectFilesChecked} floor=400 `
  + `label=project-files-typechecked`)
for (const r of projectReport) {
  console.log(`GATE-WORK tsc-${r.label} units=${r.count} floor=${r.floor} `
    + `label=${r.config} canary=${r.canary}:seen`)
}
console.log(`  ${projectFilesChecked} project file(s) actually loaded by tsc `
  + `across ${PROJECTS.length} project(s); every canary seen`)
console.log(`  ${all.length} errors (baseline ${baseline.length}, `
  + `new ${fresh.length}, healed ${remaining.length})`)

if (remaining.length) {
  console.log('')
  console.log('These are FIXED — re-run with --write-baseline so the')
  console.log('ratchet cannot loosen:')
  for (const k of remaining.slice(0, 20)) console.log(`  ${k}`)
}

if (fresh.length) {
  console.log('')
  console.log('FAIL — NEW type errors:')
  for (const k of fresh) {
    const [file, code, msg] = k.split('|')
    console.log(`  ${file}`)
    console.log(`      ${code}: ${msg}`)
  }
  process.exit(1)
}
console.log('')
console.log(`PASS — no NEW type errors (${all.length} known, ${BASELINE}).`)
