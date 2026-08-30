#!/usr/bin/env node
/**
 * No planted defect may be committed to product source.
 *
 * THE INCIDENT. Gates in this project are certified by planting the
 * defect they exist to catch, observing RED, and reverting. That
 * discipline is right and stays. But on 2026-08-30 a coordinator ran
 * `git add -A` while a gates lane had its G8 plant live in the tree, and
 * commit 36d34ef shipped:
 *
 *     // G8 PLANT P3 — the short-circuit disabled.
 *     if (false && answer.answerLocally(q, resolveTier0(q, factIndex))) {
 *
 * That line sends EVERY Tier-0 question to the paid model seam — the
 * exact money defect the gate was built to catch — inside the commit
 * whose message claims the gate catches it. It reached `main`. It did
 * not reach production only because the last deploy predated it.
 *
 * A plant is a temporary state that looks like ordinary code. Reviews
 * miss it, `git add -A` swallows it, and the test suite goes green
 * because the plant's whole purpose is to be caught by ONE gate that
 * nobody re-runs before committing. So this is mechanical.
 *
 * SCOPE: product source only. Files that legitimately DOCUMENT plants —
 * gate docs, GATES.md, this file — are excluded by path, because the
 * word must stay writable where plants are recorded as evidence.
 *
 * Run: node scripts/check_no_plants.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SOURCE_ROOTS = ['frontend', 'src']
const SOURCE_EXT = /\.(ts|tsx|py|mjs|js|jsx)$/

// Where the word "plant" is evidence, not a defect.
const DOC_PATHS = /(^|\/)(design_review|docs|__tests__|tests)(\/|$)|\.(md|json)$|check_no_plants\.mjs$/

const MARKERS = [
  // Explicit markers this project's lanes actually use.
  [/\bG\d+\s+PLANT\b/, 'gate plant marker'],
  [/\bPLANT[- ]ADVERSARIAL\b/i, 'adversarial plant marker'],
  // NOT a bare /planted/i: this codebase's comments legitimately use the
  // word to DESCRIBE what a test does ("invokes the planted callable",
  // "a planted EUR0.01 extra price still fires"). Four such prose lines
  // matched on the first run. Suppressing those four names would have
  // been the wrong fix — the marker itself was too broad, so it is
  // narrowed to shapes that cannot occur in prose.
  [/\b__plant_|\badv_plant_|\bplanted_[a-z_]+/, 'planted identifier'],
  // Structural short-circuits that disable a branch wholesale. These are
  // how a plant hides in plain sight — the line still reads as code.
  [/\bif\s*\(\s*(?:false|0)\s*&&/, 'disabled branch: if (false && …)'],
  [/\bif\s*\(\s*(?:true|1)\s*\|\|/, 'forced branch: if (true || …)'],
  [/\breturn\s+(?:false|true)\s*;\s*\/\/\s*PLANT/i, 'early return plant'],
]

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist' || e === '.git') continue
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (SOURCE_EXT.test(e)) out.push(p)
  }
  return out
}

const files = SOURCE_ROOTS.flatMap((r) => walk(join(ROOT, r)))
  .filter((p) => !DOC_PATHS.test(relative(ROOT, p)))

const hits = []
let scanned = 0
for (const f of files) {
  scanned++
  const rel = relative(ROOT, f)
  const lines = readFileSync(f, 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const [rx, what] of MARKERS) {
      if (rx.test(line)) hits.push({ rel, line: i + 1, what, text: line.trim().slice(0, 92) })
    }
  })
}

// Work count and floor asserted AFTER the walk, on the totals — a check
// inside the loop cannot fire for a walk that never ran.
console.log('PLANT SCAN')
console.log('='.repeat(62))
console.log(`GATE-WORK no-plants units=${scanned} floor=400 label=product-source-files`)
if (scanned < 400) {
  console.log('')
  console.log(`DISCOVERY BROKEN — scanned ${scanned} files, floor 400. A clean`)
  console.log('verdict over a collapsed walk is the tsc failure.')
  process.exit(1)
}

if (hits.length) {
  console.log('')
  console.log('FAIL — planted defect(s) in product source:')
  for (const h of hits) {
    console.log(`  ${h.rel}:${h.line}  [${h.what}]`)
    console.log(`      ${h.text}`)
  }
  console.log('')
  console.log('A plant is a temporary state. Revert it before committing;')
  console.log('record the evidence in the feature GATES.md instead, where')
  console.log('this scan deliberately does not look.')
  process.exit(1)
}
console.log('')
console.log(`PASS — no planted defects in ${scanned} product source files.`)
