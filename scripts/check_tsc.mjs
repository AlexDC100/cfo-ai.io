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
const PROJECTS = ['tsconfig.app.json', 'tsconfig.node.json']

function run(project) {
  try {
    execFileSync('npx', ['tsc', '-p', project, '--noEmit'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return ''
  } catch (err) {
    // tsc exits non-zero when it finds errors; that is the payload.
    return `${err.stdout || ''}${err.stderr || ''}`
  }
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
console.log(`  projects: ${PROJECTS.join(', ')}`)
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
