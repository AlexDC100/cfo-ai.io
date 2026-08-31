#!/usr/bin/env node
/**
 * Warn when a commit stages GATES but leaves their SUBJECT untracked.
 *
 * THE INVARIANT: verify that what is staged IS the change.
 *
 * Two incidents, one session, opposite directions:
 *
 *   `git add -A` was too BROAD — it swallowed a lane's live plant, and
 *   commit 36d34ef shipped `if (false && answerLocally(...))` to main:
 *   every Tier-0 question to the paid model seam, inside the commit
 *   certifying the gate that catches exactly that.
 *
 *   Explicit paths were too NARROW — commit 80890a8 staged
 *   capsule-craft.spec.ts, check_capsule_craft.mjs, check_vitest.mjs and
 *   a baseline, while CapsulePaletteRow.tsx, capsuleGeometry.ts and
 *   CapsuleTooltipGuard.tsx sat untracked. It committed THE GATES THAT
 *   CERTIFY A DESIGN WITHOUT THE DESIGN. A `git stash` at that moment
 *   would have left gates asserting a surface that was not in the repo.
 *
 * Neither "add everything" nor "add only what I typed" is the rule. This
 * checks the actual hazard: gates certifying an unstaged subject, which
 * is a false green with a new delivery mechanism.
 *
 * WARNS, does not block — untracked scratch files are normal, and a hook
 * that cries wolf gets bypassed, which costs more than it saves.
 *
 * Run: node scripts/check_staged_is_change.mjs [--staged]
 */
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()
const git = (args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean)

// A file that ASSERTS something about other files.
const GATE_RX = /(\.(spec|test)\.[tj]sx?$)|(^scripts\/check_.*\.(mjs|py)$)|(^e2e\/)|(_BASELINE\.(txt|json)$)/
// A file that is a SUBJECT — the thing gates assert about.
const SUBJECT_RX = /^(frontend|src)\/.*\.(ts|tsx|py)$/

const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACM'])
if (!staged.length) process.exit(0)

const stagedGates = staged.filter((f) => GATE_RX.test(f))
if (!stagedGates.length) process.exit(0)

const untracked = git(['ls-files', '--others', '--exclude-standard'])
  .filter((f) => SUBJECT_RX.test(f))
const modifiedUnstaged = git(['diff', '--name-only'])
  .filter((f) => SUBJECT_RX.test(f) && !staged.includes(f))

const orphans = [...untracked, ...modifiedUnstaged]
if (!orphans.length) {
  console.log('staged-is-change: OK — gates staged, no subject left behind.')
  process.exit(0)
}

// NO "same directory" HEURISTIC. My first draft matched a staged gate's
// top-level area against the orphan's, and reported ZERO subjects on the
// exact incident it was written for: 80890a8 staged gates in `e2e/` and
// `scripts/` while the subjects sat in
// `frontend/components/instrument/shell/`. Gates and their subjects
// almost never share a directory — that is what makes this hazard hard
// to see by eye, and the filter reproduced the blindness in the warning
// itself. It also printed a warning naming zero files, which is its own
// small version of a census that finds nothing and reports anyway.
const related = orphans

console.log('')
console.log('⚠  staged-is-change WARNING')
console.log('='.repeat(62))
console.log(`This commit stages ${stagedGates.length} gate/spec file(s):`)
for (const f of stagedGates.slice(0, 6)) console.log(`    ${f}`)
console.log('')
console.log(`…while ${related.length} SUBJECT file(s) they may assert about are`)
console.log('NOT staged:')
for (const f of related.slice(0, 12)) {
  console.log(`    ${f}${untracked.includes(f) ? '   (untracked)' : '   (modified, unstaged)'}`)
}
console.log('')
console.log('Commit 80890a8 did exactly this: it shipped the gates that')
console.log('certify a design without the design. Verify that what is')
console.log('staged IS the change. If this is deliberate, carry on.')
console.log('')
