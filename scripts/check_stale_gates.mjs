#!/usr/bin/env node
/**
 * Build-time gate: a gate must not assert against an element that no
 * longer exists.
 *
 * A passing gate pointed at a removed element is a FALSE GREEN, and it
 * is the same failure as the false red this repo already hit (the header
 * census double-counted `[role="radiogroup"]` and reported a violation
 * that did not exist). Both teach the next person to distrust the gate.
 * The false green is worse only because nothing forces anyone to look.
 *
 * Mechanism: collect every `data-testid` a test or gate REFERENCES, and
 * every `data-testid` the frontend DEFINES. A referenced id with no
 * definition is either a stale assertion or a typo; both are defects.
 *
 * Run: node scripts/check_stale_gates.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()

// Where gates live (they REFERENCE testids).
const GATE_ROOTS = ['e2e', 'scripts']
const GATE_EXT = /\.(spec|test)\.(ts|tsx|js|mjs)$|^check_.*\.mjs$/
// Where the app lives (it DEFINES testids).
const APP_ROOTS = ['frontend']

// Ids that are legitimately created at runtime rather than written as a
// literal in source. Each needs a reason; an unexplained entry here is
// how a real stale gate gets hidden.
const RUNTIME_IDS = new Map([
  // built as `nav-item-${slug}` / `period-row-${id}` etc.
])

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist' || e === '.git') continue
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const gateFiles = GATE_ROOTS.flatMap((r) => walk(join(ROOT, r)))
  .filter((p) => GATE_EXT.test(p.split('/').pop()))
  // Skip self: this file names example ids in its own documentation.
  .filter((p) => !p.endsWith('check_stale_gates.mjs'))
const appFiles = APP_ROOTS.flatMap((r) => walk(join(ROOT, r)))
  .filter((p) => /\.(ts|tsx)$/.test(p))

// DEFINED: three shapes, and all three are needed.
//
//   data-testid="sidebar-chat"            a literal attribute
//   data-testid={`period-row-${id}`}      a templated attribute (prefix)
//   { testId: "sidebar-dashboard" }       a CONFIG-OBJECT definition
//
// The third shape is the one that matters. A first draft of this gate
// matched attributes only and reported 20 sidebar ids as stale — every
// one of them live, defined in a nav-item config array and passed down
// as `data-testid={testId}`. That census was noise wearing a gate's
// clothing, which is exactly the failure this file exists to catch.
const defined = new Set()
const DEF_RX = /(?:data-testid|testId|testid)\s*[=:]\s*(?:"([^"]+)"|'([^']+)'|\{`([^`$]*)|`([^`$]*))/g
for (const f of appFiles) {
  const src = readFileSync(f, 'utf8')
  // A /g regex carries lastIndex between calls. Without this reset the
  // scan resumes mid-file for every file after the first, so real
  // definitions go unseen and live ids get reported stale. `testId=
  // "sidebar-theme-toggle"` was the one that exposed it.
  DEF_RX.lastIndex = 0
  let m
  while ((m = DEF_RX.exec(src))) {
    const v = m[1] || m[2] || m[3] || m[4]
    if (v) defined.add(v)
  }
}

// REFERENCED: getByTestId('x') | [data-testid="x"] | testid: 'x'
const referenced = new Map() // id -> [file:line]
const REF_RX = /(?:getByTestId\(\s*["'`]([^"'`]+)|\[data-testid=["']([^"']+)["']\])/g
for (const f of gateFiles) {
  const lines = readFileSync(f, 'utf8').split('\n')
  lines.forEach((line, i) => {
    let m
    REF_RX.lastIndex = 0
    while ((m = REF_RX.exec(line))) {
      const id = m[1] || m[2]
      // A testid is a plain identifier. Anything else came from a
      // REGEX SOURCE, not an assertion — other gate scripts contain
      // `[data-testid="..."]` patterns as string literals, and matching
      // those made `([^` and `…` look like stale ids. Defining what a
      // testid can be is the fix; suppressing the two names would leave
      // the next regex fragment to be discovered by hand.
      if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) continue
      const where = `${relative(ROOT, f)}:${i + 1}`
      if (!referenced.has(id)) referenced.set(id, [])
      referenced.get(id).push(where)
    }
  })
}

// KNOWN DEBT, ratcheted.
//
// 33 assertions across the e2e suite already point at elements that were
// removed. They are NOT producing false greens today for a blunter
// reason: `scripts/run_battery.py` does not run the Playwright suite at
// all, so those specs have not executed in CI. An entire suite going
// dark is the more serious half of this finding — a gate nobody runs and
// a gate that passes wrongly fail the same way, silently.
//
// Fixing all 33 here would collide with lanes actively rewriting some of
// these specs, so the debt is recorded instead of hidden: the baseline
// below is allowed, and the count may only ever go DOWN. A NEW stale
// reference fails the gate immediately.
const BASELINE_FILE = 'design_review/STALE_GATE_BASELINE.txt'
let baseline = new Set()
try {
  baseline = new Set(
    readFileSync(join(ROOT, BASELINE_FILE), 'utf8')
      .split('\n').map((l) => l.trim()).filter(Boolean))
} catch { /* no baseline yet: every stale id is new */ }

const stale = []
for (const [id, wheres] of referenced) {
  if (defined.has(id)) continue
  if (RUNTIME_IDS.has(id)) continue
  // Prefix match for templated ids: `period-row-` defines `period-row-3`.
  if ([...defined].some((d) => id.startsWith(d) || d.startsWith(id))) continue
  stale.push([id, wheres])
}

console.log('STALE-GATE CENSUS')
console.log('='.repeat(62))
console.log(`  ${gateFiles.length} gate files reference ${referenced.size} testids`)
console.log(`  ${appFiles.length} app files define ${defined.size} testids`)
console.log('-'.repeat(62))

// Write the baseline from the SAME code that reads it. Generating it
// with a shell grep over this script's output silently dropped one id
// whose name the pattern did not anticipate, which would have let a real
// stale assertion in through the front door.
if (process.argv.includes('--write-baseline')) {
  const { writeFileSync } = await import('node:fs')
  const ids = stale.map(([id]) => id).sort().join('\n') + '\n'
  writeFileSync(join(ROOT, BASELINE_FILE), ids)
  console.log(`\nWROTE ${stale.length} ids to ${BASELINE_FILE}`)
  process.exit(0)
}

const fresh = stale.filter(([id]) => !baseline.has(id))
const healed = [...baseline].filter((id) => !stale.some(([s]) => s === id))

console.log(`  ${stale.length} stale (baseline ${baseline.size}, `
  + `new ${fresh.length}, healed ${healed.length})`)

// A healed id left in the baseline is a loose ratchet: the gate would
// silently permit that assertion to go stale again. Tightening is one
// command, and the message says which.
if (healed.length) {
  console.log('')
  console.log('FAIL — these are FIXED but still in the baseline, which')
  console.log('leaves room for them to regress. Tighten the ratchet:')
  console.log('  node scripts/check_stale_gates.mjs --write-baseline')
  for (const id of healed.sort()) console.log(`  ${id}`)
  process.exit(1)
}

if (fresh.length) {
  console.log('')
  console.log('FAIL — these gates assert against elements that do not exist:')
  for (const [id, wheres] of fresh.sort()) {
    console.log(`  ${id}`)
    for (const w of wheres) console.log(`      ${w}`)
  }
  console.log('')
  console.log('Each is a FALSE GREEN. Retarget the assertion at the element')
  console.log('that replaced it, or delete the assertion — do not add the')
  console.log('testid to the app just to satisfy the gate.')
  process.exit(1)
}
console.log('')
console.log(`PASS — no NEW stale assertions `
  + `(${stale.length} known, tracked in ${BASELINE_FILE}).`)
