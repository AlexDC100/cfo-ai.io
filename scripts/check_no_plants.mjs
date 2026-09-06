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
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SOURCE_ROOTS = ['frontend', 'src']
const SOURCE_EXT = /\.(ts|tsx|py|mjs|js|jsx)$/

// Where the word "plant" is evidence, not a defect.
const DOC_PATHS = /(^|\/)(design_review|docs|__tests__|tests)(\/|$)|\.(md|json)$|check_no_plants\.mjs$/

const MARKERS = [
  // Explicit markers this project's lanes actually use.
  [/\bG\d+\s+PLANT\b/, 'gate plant marker'],
  // `PLANT 2`, `PLANT B`, `PLANT-C` — a stopped wave left
  // `// PLANT 2 — approximate the denominator instead of refusing` in
  // frontend/lib/capsuleFactIndex.ts, and this gate walked past it
  // because the pattern above requires a leading gate id (`G8 PLANT`).
  // The marker a lane actually writes is whatever its own plant log
  // numbers, so match the bare word followed by an identifier too.
  [/\bPLANT[\s-]+[0-9A-Z][0-9A-Za-z-]*\b/, 'numbered plant marker'],
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

// --staged scans the BLOBS GIT IS ABOUT TO COMMIT, not the working tree.
//
// That distinction is the incident. When 36d34ef was made, the plant was
// live in the tree and got staged; the lane reverted the tree afterwards,
// so by the time anyone looked, the tree was clean and only the COMMIT
// carried the defect. A working-tree scan run one minute later would have
// said everything was fine. Only the staged content is the truth about
// what is being committed.
const STAGED = process.argv.includes('--staged')

let files
if (STAGED) {
  const out = execFileSync(
    'git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'],
    { cwd: ROOT, encoding: 'utf8' })
  files = out.split('\n').map((f) => f.trim()).filter(Boolean)
    .filter((f) => SOURCE_ROOTS.some((r) => f === r || f.startsWith(r + '/')))
    .filter((f) => SOURCE_EXT.test(f))
    .filter((f) => !DOC_PATHS.test(f))
    .map((f) => join(ROOT, f))
} else {
  files = SOURCE_ROOTS.flatMap((r) => walk(join(ROOT, r)))
    .filter((p) => !DOC_PATHS.test(relative(ROOT, p)))
}

function contentOf(abs) {
  if (!STAGED) return readFileSync(abs, 'utf8')
  // `git show :path` reads the INDEX version, which is what will land.
  return execFileSync('git', ['show', ':' + relative(ROOT, abs)],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

const hits = []
let scanned = 0
for (const f of files) {
  scanned++
  const rel = relative(ROOT, f)
  const lines = contentOf(f).split('\n')
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
console.log(STAGED
  ? `GATE-WORK no-plants units=${scanned} label=staged-source-files (floor N/A: a small commit is normal)`
  : `GATE-WORK no-plants units=${scanned} floor=400 label=product-source-files`)
if (!STAGED && scanned < 400) {
  console.log('')
  console.log(`DISCOVERY BROKEN — scanned ${scanned} files, floor 400. A clean`)
  console.log('verdict over a collapsed walk is the tsc failure.')
  process.exit(1)
}

// ── THE MANIFEST — the other side of the protocol ────────────────────
//
// Textual markers are lane-authored, so matching them is a convention
// only one side follows. A registered plant is a contract: the lane
// declares file, line and the red it expects; this gate enforces both
// directions.
const MANIFEST_PATH = 'design_review/PLANT_MANIFEST.json'
let registered = []
try {
  registered = JSON.parse(readFileSync(join(ROOT, MANIFEST_PATH), 'utf8')).plants || []
} catch {
  console.log(`FAIL — ${MANIFEST_PATH} is missing or unparseable. Without it`)
  console.log('this gate has no record of what is deliberately planted, so it')
  console.log('cannot tell a sanctioned plant from a shipped defect.')
  process.exit(1)
}

const keyOf = (f, l) => `${f}:${l}`
const regIndex = new Map(registered.map((r) => [keyOf(r.file, r.line), r]))

// 1. Every registered plant must ACTUALLY BE THERE. A stale entry is an
//    allowance nobody is using, and allowances outlive their reasons.
const phantom = registered.filter((r) => !hits.some((h) => keyOf(h.rel, h.line) === keyOf(r.file, r.line)))

// 2. Every suspicious shape must be registered.
const unregistered = hits.filter((h) => !regIndex.has(keyOf(h.rel, h.line)))

if (phantom.length) {
  console.log('')
  console.log('FAIL — registered plant(s) not found where the manifest says:')
  for (const r of phantom) {
    console.log(`  ${r.file}:${r.line}  expected red: ${r.expected_red || '(unstated)'}`)
  }
  console.log('')
  console.log('Either the plant was reverted and the entry was not removed —')
  console.log('a stale allowance — or it moved. Remove the entry, or correct')
  console.log('it. An allowance for a plant that is not there is a hole.')
  process.exit(1)
}

if (registered.length && !unregistered.length) {
  console.log('')
  console.log(`NOTE — ${registered.length} plant(s) registered and live. This is`)
  console.log('a sanctioned mid-plant state, not a clean tree. Revert before')
  console.log('committing; the pre-commit hook scans STAGED blobs.')
}

const hitsToReport = unregistered
if (hitsToReport.length) {
  console.log('')
  console.log('FAIL — planted defect(s) in product source:')
  for (const h of hitsToReport) {
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
