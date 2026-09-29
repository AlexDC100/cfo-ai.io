#!/usr/bin/env node
/**
 * NO TEST PATH MAY BE ABLE TO WRITE TO PRODUCTION.
 *
 * THE INCIDENT (2026-09-01). `.env` points VITE_SUPABASE_URL at the
 * production project; `.env.local` sets VITE_PUBLIC_TEST_MODE=1. The dev
 * server reads both, so it served a build that was IN TEST MODE AND
 * WIRED TO PRODUCTION. Every Playwright cold boot authenticated as the
 * fixed test identity, hit the cold-boot false-zero in
 * fetchOrgsForUser(), and ensure-default created a real organisation —
 * in production, roughly one every twelve seconds while suites ran.
 *
 * 8,880 junk "Test workspace" organisations out of 8,913 total: 99.6% of
 * that table was created by test scaffolding.
 *
 * This is the SECOND time in one week that test scaffolding reached
 * production. The first was the vitest suite, green only because a real
 * Supabase URL sat in an untracked `.env`. That was fixed with
 * `frontend/test/envPin.ts` + `hermeticEnv.json` — and the fix covered
 * VITEST ONLY. Playwright drives the dev server, which never consults
 * the manifest, so the hole stayed open in the path that was actually
 * writing.
 *
 * THE RULE, per the owner: test env resolves ONLY from the manifest, and
 * a live production URL in a test context is a HARD ERROR, not a
 * warning.
 *
 * Run: node scripts/check_test_env_isolation.mjs [--probe-vacuity]
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const MANIFEST = 'frontend/test/hermeticEnv.json'

// Files a TEST PATH can read. The dev server reads dotenv files; the
// Playwright suite drives the dev server.
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.test']

// Any flag that puts the app into a test identity. These are what make a
// production URL dangerous rather than merely wrong.
const TEST_MODE_FLAGS = ['VITE_PUBLIC_TEST_MODE', 'PUBLIC_TEST_MODE', 'VITE_TEST_USER_ID', 'VITE_TEST_ORG_ID']

const PROBE = process.argv.includes('--probe-vacuity')

// THE SUBJECT IS EVERY ENV A TEST PATH READS — not only dotenv files
// (owner ruling 2026-09-29: the gate must not depend on a checkout's
// dotenv). Until then it read the dotenv files alone, so in a worktree or
// on CI — where there are none — it examined nothing and went red for a
// machine it never looked at. Three sources, each counted:
//   1. the vitest manifest (always present): what `npx vitest run` resolves.
//      It is CHECKED too, not trusted: its Supabase and API hosts must be
//      unreachable. Before, the manifest WAS the sanctioned value, so a
//      production URL pasted into it would have been "sanctioned".
//   2. the process environment this runs in — the dev server and Playwright
//      inherit it, and vite gives it priority over every dotenv file;
//   3. the dotenv files a dev server reads, when a checkout has them.
const UNREACHABLE_HOST = /(^|\.)test\.supabase\.co$|\.invalid$/
const hostOf = (url) => (String(url).match(/^https?:\/\/([^/:]+)/) || [, ''])[1]
const RELEVANT = /^(VITE_|SUPABASE_URL$|PUBLIC_TEST_MODE$)/
const isOn = (v) => v !== undefined && v !== null && v !== '' && v !== '0' && v !== 'false'

function parseEnv(rel) {
  const p = join(ROOT, rel)
  if (!existsSync(p)) return null
  const out = new Map()
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || !t.includes('=')) continue
    const i = t.indexOf('=')
    out.set(t.slice(0, i).trim(), t.slice(i + 1).trim().replace(/^["']|["']$/g, ''))
  }
  return out
}

const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8')).env
const SANCTIONED_SUPABASE = manifest.VITE_SUPABASE_URL
if (!SANCTIONED_SUPABASE) {
  console.log(`FAIL — ${MANIFEST} declares no VITE_SUPABASE_URL, so this gate`)
  console.log('has no sanctioned value to compare against and would pass anything.')
  process.exit(1)
}

let examined = 0
const sources = []
const violations = []

// ── 1. the vitest manifest ───────────────────────────────────────────────
if (!PROBE) {
  const entries = Object.entries(manifest)
  examined += entries.length
  sources.push(`${MANIFEST} (${entries.length})`)
  for (const key of ['VITE_SUPABASE_URL', 'VITE_API_URL']) {
    const v = manifest[key]
    if (typeof v === 'string' && v && !UNREACHABLE_HOST.test(hostOf(v))) {
      violations.push({ rel: `${MANIFEST} → ${key}`, flags: ['(the vitest run itself)'], host: hostOf(v) || v })
    }
  }
  const manifestFlags = TEST_MODE_FLAGS.filter((f) => isOn(manifest[f]))
  if (manifestFlags.length && !UNREACHABLE_HOST.test(hostOf(SANCTIONED_SUPABASE))) {
    violations.push({ rel: MANIFEST, flags: manifestFlags, host: hostOf(SANCTIONED_SUPABASE) })
  }
}

// ── 3. the dotenv files (read first: the process env overrides them) ────
const files = PROBE ? [] : ENV_FILES
const present = []
const merged = new Map()
for (const rel of files) {
  const env = parseEnv(rel)
  if (!env) continue
  present.push(rel)
  examined += env.size
  for (const [k, v] of env) merged.set(k, v)

  const flags = TEST_MODE_FLAGS.filter((f) => isOn(env.get(f)))
  const supabase = env.get('VITE_SUPABASE_URL') || env.get('SUPABASE_URL')
  if (flags.length && supabase && supabase !== SANCTIONED_SUPABASE) {
    violations.push({ rel, flags, host: hostOf(supabase) || supabase })
  }
}
sources.push(`dotenv: ${present.join(', ') || '(none in this checkout)'}`)

// ── 2. the process environment — vite gives it priority ─────────────────
const procKeys = PROBE ? [] : Object.keys(process.env).filter((k) => RELEVANT.test(k))
examined += procKeys.length
for (const k of procKeys) merged.set(k, process.env[k])
sources.push(`process env (${procKeys.length} VITE_/SUPABASE/test-mode key(s))`)

// A production URL is dangerous only WITH a test flag — but the flag and
// the URL routinely live in DIFFERENT places (two dotenv files, or a shell
// export over a dotenv file), which is exactly how this shipped. So also
// check the MERGED view, the way vite resolves it.
const mergedFlags = TEST_MODE_FLAGS.filter((f) => isOn(merged.get(f)))
const mergedSupabase = merged.get('VITE_SUPABASE_URL') || merged.get('SUPABASE_URL')
if (mergedFlags.length && mergedSupabase && mergedSupabase !== SANCTIONED_SUPABASE
    && !violations.some((v) => present.includes(v.rel))) {
  violations.push({
    rel: [...present, procKeys.length ? 'process env' : null].filter(Boolean).join(' + ') +
      '  (MERGED — the flag and the URL come from different places)',
    flags: mergedFlags,
    host: hostOf(mergedSupabase) || mergedSupabase,
  })
}

console.log('TEST-ENV ISOLATION')
console.log('='.repeat(62))
console.log(`GATE-WORK test-env-isolation units=${examined} floor=14 label=env-vars-examined`)
console.log(`  sources examined     : ${sources.join(' · ')}`)
console.log(`  sanctioned supabase  : ${SANCTIONED_SUPABASE}  (from ${MANIFEST})`)

// TC-3/TC-9: a census over nothing must FAIL, not report clean.
if (examined === 0) {
  console.log('')
  console.log('DISCOVERY BROKEN — examined 0 environment variables. A clean')
  console.log('verdict over no subject is the tsc failure: this gate would')
  console.log('report isolation for a machine it never looked at.')
  process.exit(1)
}

if (violations.length) {
  console.log('')
  console.log('FAIL — a TEST PATH CAN WRITE TO PRODUCTION:')
  for (const v of violations) {
    console.log(`  ${v.rel}`)
    console.log(`      test-mode flag(s): ${v.flags.join(', ')}`)
    console.log(`      supabase host    : ${v.host}`)
  }
  console.log('')
  console.log('This combination created 8,880 junk organisations in production')
  console.log('on 2026-09-01 — 99.6% of that table — one per ~12s while suites')
  console.log('ran. Point the test context at the manifest\'s value, or remove')
  console.log('the test-mode flag. A live production URL in a test context is')
  console.log('a hard error, not a warning.')
  process.exit(1)
}

console.log('')
console.log('PASS — no test path resolves a non-sanctioned Supabase project.')
