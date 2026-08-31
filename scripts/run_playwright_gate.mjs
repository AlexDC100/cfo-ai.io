#!/usr/bin/env node
/**
 * THE DARK SUITE GATE — run the Playwright suite, and ratchet it.
 *
 * 34 spec files and 253 tests lived in `e2e/` and `scripts/run_battery.py`
 * ran NONE of them (33 / 251 after this pass deleted a zero-byte stub and
 * a spec whose subject was removed from the product). That is the same
 * disease as the `npx tsc --noEmit`
 * incident, one stage earlier: tsc was a gate that ran and checked zero
 * files; this was a suite that never ran at all. A gate nobody runs and a
 * gate that passes wrongly fail identically — silently — and the suite
 * rots either way. `scripts/check_stale_gates.mjs` had already measured
 * the rot: 33 assertions pointing at elements that no longer exist.
 *
 * So this file's first job is not to be clever. It is to EXECUTE the
 * suite and refuse to report anything green that it did not earn.
 *
 * THE SIX REFUSALS
 * ----------------
 *  1. ZERO TESTS RAN is a FAILURE, never a pass. This is the tsc lesson
 *     stated as code: `--noEmit` exited 0 in 0.2s having read nothing,
 *     and the 0 was believed for months. A run that executes nothing has
 *     measured nothing and must say so.
 *  2. A SPEC FILE ON DISK THAT CONTRIBUTES NO TESTS is a failure unless
 *     it is named in NOT_DISCOVERABLE with a reason. Discovery that
 *     quietly skips a file reports a clean census of a smaller world —
 *     the exact failure of check_metric_declared.py's first draft, which
 *     scanned keyword arguments only, found "0 metrics" in a package
 *     full of them, and PRINTED A PASS.
 *  3. A NAMED CANARY THAT DOES NOT RUN AND PASS is a failure. MUST_PASS
 *     below names specific tests that exercise the plumbing this gate
 *     depends on (the app boots, the test-mode session mints, a real
 *     assertion evaluates). If they vanish or start skipping, the gate
 *     is broken even when every remaining test is green.
 *  4. PRECONDITIONS ARE HARD. If vite or the engine is unreachable, or
 *     the engine is not in test-mode posture, the gate exits NON-ZERO
 *     with BLOCKED. A skip must never read as a pass.
 *  5. A FILE PLAYWRIGHT CANNOT COLLECT is a failure. Refusal 2 compares
 *     "on disk" against "in the run", so it is blind to a file that is
 *     in NEITHER census. `e2e/design/capsule-craft-surface.spec 2.ts`
 *     was tracked in git, byte-identical to a live spec, and named so
 *     that testMatch skipped it — invisible to the runner AND to the
 *     runner's own dark-file detector. Found by running this gate, not
 *     by reading it.
 *  6. A FLOOR PER FILE, NOT ON THE SUM. EXECUTED_FLOOR is a floor on a
 *     total, and this repo has already measured what that is worth:
 *     `import-boundary` printed "boundary holds" with a real violation
 *     planted, because one half collapsed 517 -> 1 while the total
 *     stayed above the global floor. modes.spec.ts alone is 52 of the
 *     249 tests here; it could collapse to 1 and the sum would still
 *     clear 150. FILE_FLOORS records an expectation PER FILE, and a
 *     file that runs with no recorded expectation fails rather than
 *     silently checking nothing.
 *
 * THE RATCHET
 * -----------
 * design_review/E2E_BASELINE.txt records the tests that fail today. Like
 * TSC_BASELINE.txt and STALE_GATE_BASELINE.txt it may only ever SHRINK:
 *   · a NEW failure fails the gate immediately;
 *   · a HEALED entry still listed in the baseline ALSO fails the gate,
 *     because a loose ratchet lets that test regress for free.
 *
 * Keys are `<spec file>::<full test title>` — no line numbers, so an
 * edit above a test does not read as a new failure.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It will not retry. `retries: 0` stays, because a retry turns a flake
 * into a pass and this ratchet cannot tell the difference between a flake
 * and a fix. If the suite is flaky, that is a finding, not a knob.
 *
 * THE INSTABILITY, AND WHAT IT TURNED OUT TO BE (closed 2026-08-31)
 * -----------------------------------------------------------------
 * This file used to record: "MEASURED 2026-08-30, four full runs on one
 * commit: seven tests move between pass and fail with no edit — four
 * `axe` checks under the dark / Simple themes, and three that mutate the
 * SHARED view-mode / learning-mode preference of the single
 * PUBLIC_TEST_MODE identity." A fifth full run reproduced it as 4 NEW +
 * 5 HEALED on one commit.
 *
 * The named cause was HALF RIGHT, and the wrong half was the loud half.
 *
 * RIGHT: every context in this suite authenticates as one fixed identity
 * that owns ONE `user_prefs.prefs` row and ONE `org_prefs.prefs` row, and
 * `frontend/lib/prefs.ts::usePrefSync` ADOPTS those over whatever a spec
 * seeded into localStorage. A spec that seeds localStorage has pinned
 * half the state. Traced live: a page seeded `view_mode=pro` is back to
 * `simple` 500 ms later. Three tests were fixed by pinning the other
 * half (e2e/_helpers.ts) — measured in runs of ten:
 *     modes M5 "Pro dashboard keeps the classic overview"  10/10 → 0/10 red
 *     learning-mode "default mode is guided"                7/10 → 0/10 red
 *     header H5 "currency persists across reload"            5/6 → 0/8 red
 *
 * WRONG: the four axe checks. A control was built before believing the
 * story — a bag serving the OPPOSITE of the seed, forced rather than
 * raced — and theme did NOT flip: `ThemePrefSync` writes on mount, and
 * `getRemotePref` returns that unconfirmed `pendingWrites` entry ahead of
 * the server's forever, because the confirming RPC never fires in test
 * mode. Those axe checks then measured 10/10 STABLE in isolation. They
 * were not flakes; they were stale baseline entries that other lanes had
 * genuinely fixed, showing up as "healed" and read as flapping. The
 * "NEW and HEALED in the same run" note below is a heuristic, and this is
 * the case it gets wrong: under five concurrent lanes both happen at once
 * for real.
 *
 * Two more were plain test bugs the shared-state story would have hidden:
 * `learning-mode-toggle` cleared its key in an `addInitScript`, which
 * re-runs on the reload the test performs, so it deleted the preference
 * whose persistence it then asserted (10/10 red, forever); and the same
 * file's reset test raced the app's own write-back.
 *
 * Nothing here is quarantined and `retries: 0` still stands.
 *
 * THE CLOSURE ABOVE WAS RE-TESTED, AND HALF OF IT DID NOT HOLD
 * -----------------------------------------------------------
 * This section used to end: "Three consecutive full runs now agree on
 * the same 83 failures: new 0, healed 0." Re-measured 2026-08-31, four
 * more full runs plus repeat runs of the individual tests:
 *
 * WHAT HELD. The three specific repairs are real. Measured ten times
 * each, in their own process, against this commit:
 *     modes M5 "Pro dashboard keeps the classic overview"   10/10 PASS
 *     learning-mode "default mode is guided"                10/10 PASS
 *     learning-mode "toggling to subtle persists"           10/10 PASS
 *     header H5 "currency persists across reload"           10/10 PASS
 * All four were also green in every full run. The shared-prefs-bag
 * diagnosis and `pinUserPrefs` earned that.
 *
 * WHAT DID NOT HOLD. "The four axe checks were stale baseline entries
 * that other lanes had genuinely fixed." They are not fixed. Measured
 * alone against this commit, `axe clean: /chat`, `: /dashboard`,
 * `: /products` and `axe clean (dark): /chat` are 10/10 FAIL — and
 * 5/5 FAIL again on a tree fingerprinted identical before and after.
 * The sidebar's `⌘J` kbd is 3.2:1 (#b2d4cc on #0e7c6b) and nobody has
 * touched it. They belong in the baseline, where they are.
 *
 * WHY THEY LOOKED HEALED, AND THE REAL DEFECT UNDER ALL OF IT. A run
 * that reports them healed is a run in which the surface never
 * rendered. Proven, not argued: with the app's JS blocked, /dashboard
 * painted 2 elements, axe inspected 9 nodes, found 0 violations, and
 * the D1 assertion PASSED. Every axe test in this suite could report
 * "clean" about a blank page. That is the `tsc --noEmit` disease one
 * more time, and it is what turned a broken surface into a "heal" and
 * a "heal" into a wrong closure. `e2e/design/_axeVacuity.ts` now puts
 * a per-route canary AND a per-route measured floor after every
 * `analyze()`, in all three axe specs (D1 light, D1 dark, M6 x2).
 *
 * WHAT IS STILL RED, HONESTLY. `capsule.spec.ts::K6` fails 10/10 on a
 * frozen tree — 113.5px of gap where the assertion allows 24 — while
 * passing earlier the same day. It is a REGRESSION from another lane's
 * uncommitted work in `frontend/components/instrument/shell/`
 * (capsuleGeometry.ts, CommandPalette.tsx, CapsulePaletteRow.tsx), not
 * a flake, and it is left red for that lane.
 *
 * AND A WARNING ABOUT MEASURING THIS AT ALL. Three of the runs behind
 * the numbers above straddled another lane's live edits to product
 * source, so their disagreement is NOT evidence of a flaky suite. Only
 * a run whose tree hashes identically before and after says anything
 * about stability. Fingerprint the tree, or do not make the claim.
 *
 * Run:
 *   node scripts/run_playwright_gate.mjs                 # gate
 *   node scripts/run_playwright_gate.mjs --write-baseline
 *   node scripts/run_playwright_gate.mjs --no-serve      # never spawn
 *   node scripts/run_playwright_gate.mjs --grep <re>     # scoped run;
 *                                                        # NEVER gates
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = process.cwd()
const BASELINE = 'design_review/E2E_BASELINE.txt'
const SPEC_ROOT = 'e2e'
const PROJECT = process.env.E2E_PROJECT || 'chromium'

const VITE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173'
const ENGINE_URL = process.env.E2E_ENGINE_URL || 'http://127.0.0.1:8000'

// ── Refusal 2: spec files that legitimately contribute no tests ────────
// Every entry needs a reason. An unexplained entry here is how a whole
// spec file goes dark without anybody noticing — which is the thing this
// gate was written to end.
const NOT_DISCOVERABLE = new Map([
  // (empty — keep it that way)
])

// ── Refusal 2b: spec files whose every test SKIPS ─────────────────────
// Contributing tests and running them are different things. A file that
// collects 9 tests and skips all 9 is as dark as a file that collects
// none, and `test.skip(...)` is the cheapest way in the world to silence
// a failure without anyone seeing red. So an all-skipped file must be
// named here WITH the exact switch that turns it on; an unlisted one
// fails the gate.
//
// This list is debt, not policy. Each entry is a spec that cannot run on
// a bare local stack — env credentials, or seeded data the local engine
// does not have.
const ALL_SKIPPED_OK = new Map([
  ['e2e/authenticated-upload-dashboard-flow.spec.ts',
    'needs E2E_EMAIL / E2E_PASSWORD for a real Supabase account'],
  ['e2e/docs-panel.spec.ts',
    'needs E2E_REAL=1 + an account with >=2 analyzed periods'],
  ['e2e/products-portfolio.spec.ts',
    'needs E2E_REAL=1 + an account with >=1 analyzed sales dataset'],
  ['e2e/real-e2e.spec.ts',
    'needs E2E_REAL=1 + Supabase + backend + an upload fixture'],
  ['e2e/valuation.spec.ts',
    'needs E2E_REAL=1 + an account with >=1 analyzed financial period'],
])

// ── Refusal 3: the discovery canaries ─────────────────────────────────
// A gate that works by discovery must NAME something it MUST find, and
// fail loudly when it does not, instead of reporting a clean census of
// whatever it happened to see. These three are chosen because each one
// dies for a DIFFERENT reason, so between them they cover the ways this
// gate could go hollow:
//
//   · axe-dark /dashboard   — the app boots, renders an authed route,
//                             and a real third-party assertion evaluates.
//                             Dies if vite/engine/test-mode auth is down.
//   · capsule ANCHORS       — every selector that file asserts on
//                             resolves against the LIVE surface. Dies if
//                             the DOM contract drifts, which is exactly
//                             the stale-selector rot this suite has.
//   · header H0 self-audit  — the header lane's own antibody: every
//                             REQUIRED selector resolves live. Dies the
//                             instant a gate points at a deleted element.
//
// If any of them stops running or stops passing, this gate is broken —
// whatever the other 250 tests say.
const MUST_PASS = [
  'e2e/design/axe-dark.spec.ts::D1 axe (Terminal theme) — serious/critical a11y violations › axe clean (dark): /dashboard',
  'e2e/design/capsule.spec.ts::ANCHORS — every selector this file asserts on can actually match › closed, open and answered anchors all resolve on the live surface',
  'e2e/design/header.spec.ts::H0 — gate self-audit (no double counting, no stale selectors) › every REQUIRED selector resolves live (no gate aimed at a deleted element)',
]

// Minimum honest work. Measured, then rounded DOWN — a collapse
// detector, not a ratchet. If the executed-test count falls under this,
// something stopped collecting and the green means nothing.
const EXECUTED_FLOOR = 150

// ── Per-file floors (Refusal 2d) ──────────────────────────────────────
// EXECUTED_FLOOR is a floor on a SUM and therefore cannot see one file
// collapse. These are the per-file executed counts MEASURED on a real
// run, rounded down. Adding tests never trips them; losing tests does.
// A file that runs with no entry here fails the gate and prints the line
// to paste — so a new spec cannot join the suite un-floored.
const FILE_FLOORS = new Map([
  // MEASURED 2026-08-31 on a full run (249 executed), then given a
  // MARGIN: -2 for files of 10+, -1 below that, never below 1. The
  // margin is not slack for its own sake — several specs carry runtime
  // `test.skip(...)` guards (modes.spec's story-overview and command-
  // palette probes, i18n-mobile-sweep's viewport gates), so an exact
  // floor would go red on one conditional skip and teach the reader to
  // ignore this check. It still catches what it is for: modes.spec
  // collapsing 52 -> 1 while the suite total stays comfortably above
  // EXECUTED_FLOOR.
  ['e2e/currency-coverage.spec.ts', 1],                        // measured 2
  ['e2e/design/axe-dark.spec.ts', 8],                          // measured 10
  ['e2e/design/axe.spec.ts', 8],                               // measured 10
  ['e2e/design/capsule-craft-surface.spec.ts', 4],             // measured 5
  ['e2e/design/capsule-craft.spec.ts', 20],                     // measured 22
  ['e2e/design/capsule.spec.ts', 25],                           // measured 27
  ['e2e/design/context-object.spec.ts', 8],                    // measured 9
  ['e2e/design/header.spec.ts', 22],                            // measured 24
  ['e2e/design/keyboard.spec.ts', 1],                          // measured 2
  ['e2e/design/modes.spec.ts', 50],                             // measured 52
  ['e2e/f61-demo-variance.prod.spec.ts', 2],                   // measured 3
  ['e2e/golden-path.spec.ts', 1],                              // measured 1
  ['e2e/i18n-mobile-sweep.spec.ts', 8],                        // measured 10
  ['e2e/learning-balance-sheet-trace.spec.ts', 5],             // measured 6
  ['e2e/learning-glossary.spec.ts', 2],                        // measured 3
  ['e2e/learning-guide-overlay.spec.ts', 3],                   // measured 4
  ['e2e/learning-keyboard-accessibility.spec.ts', 4],          // measured 5
  ['e2e/learning-landing-onboarding.spec.ts', 2],              // measured 3
  ['e2e/learning-mobile-bottom-sheet.spec.ts', 1],             // measured 2
  ['e2e/learning-mode-toggle.spec.ts', 2],                     // measured 3
  ['e2e/learning-page-guides.spec.ts', 3],                     // measured 4
  ['e2e/learning-performance.spec.ts', 1],                     // measured 2
  ['e2e/learning-plain-english.spec.ts', 1],                   // measured 2
  ['e2e/learning-popover-recursion.spec.ts', 3],               // measured 4
  ['e2e/learning-products.spec.ts', 6],                        // measured 7
  ['e2e/learning-public-companies.spec.ts', 5],                // measured 6
  ['e2e/learning-recommendations.spec.ts', 4],                 // measured 5
  ['e2e/learning-valuation-bridge.spec.ts', 4],                // measured 5
  ['e2e/prod-smoke.spec.ts', 3],                               // measured 4
  ['e2e/public-companies-drawer.spec.ts', 6],                  // measured 7
])

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const argVal = (f) => {
  const i = args.indexOf(f)
  return i === -1 ? null : args[i + 1]
}
const WRITE = has('--write-baseline')
const SERVE = !has('--no-serve')
const GREP = argVal('--grep')
// playwright.config.ts pins workers:1 for interactive runs. The gate
// raises it because most of this suite's wall clock is fixed
// `waitForTimeout(8000)` settles, not CPU — and a gate nobody can afford
// to run is the state this file exists to end. Tests inside one file
// still run serially (fullyParallel:false), so only whole files overlap.
// E2E_WORKERS=1 reproduces the config exactly when a result is disputed.
const WORKERS = process.env.E2E_WORKERS || '4'

// ──────────────────────────────────────────────────────────────────────
// PRECONDITIONS
// ──────────────────────────────────────────────────────────────────────

async function probe(url, ms = 4000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { signal: ctl.signal })
    return r.status
  } catch {
    return 0
  } finally {
    clearTimeout(t)
  }
}

async function waitFor(url, timeoutMs, ok = (s) => s > 0 && s < 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ok(await probe(url))) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

/**
 * The engine refuses to boot without the Supabase keys, and refuses to
 * mount /api/test-mode/session without PUBLIC_TEST_MODE. Both live in the
 * gitignored .env at the repo root. Reading them here is what makes the
 * difference between "the suite runs" and "every authed spec fails for an
 * environment reason and gets baselined as if it were a code defect".
 */
function dotenv() {
  const out = {}
  const p = join(ROOT, '.env')
  if (!existsSync(p)) return out
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

const started = []

function launch(name, cmd, cmdArgs, env) {
  const child = spawn(cmd, cmdArgs, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'ignore',
    detached: true,
  })
  child.unref()
  started.push({ name, child })
  return child
}

function shutdown() {
  for (const { name, child } of started) {
    try {
      process.kill(-child.pid, 'SIGTERM')
      console.log(`  stopped ${name} (pid ${child.pid}) — this gate started it`)
    } catch { /* already gone */ }
  }
  started.length = 0
}

function blocked(lines) {
  console.log('')
  console.log('BLOCKED — the suite did NOT run. This is a FAILURE, not a skip.')
  for (const l of lines) console.log(`  ${l}`)
  console.log('')
  console.log('A gate that cannot run must never report the colour of a gate')
  console.log('that ran. Bring the stack up and re-run.')
  shutdown()
  process.exit(1)
}

async function preflight() {
  console.log('PRECONDITIONS')
  console.log('-'.repeat(62))

  // 1. engine
  let engine = await probe(`${ENGINE_URL}/health`)
  if (engine !== 200 && SERVE) {
    const py = join(ROOT, '.venv/bin/python')
    if (!existsSync(py)) {
      blocked([`no engine at ${ENGINE_URL} and no .venv/bin/python to start one`])
    }
    console.log(`  engine down — starting ${py} -m engine serve on ${ENGINE_URL}`)
    launch('engine', py,
      ['-m', 'engine', 'serve', '--config', 'config.yaml',
        '--host', '127.0.0.1', '--port', '8000'],
      { ...dotenv(), PUBLIC_TEST_MODE: '1' })
    await waitFor(`${ENGINE_URL}/health`, 90_000, (s) => s === 200)
    engine = await probe(`${ENGINE_URL}/health`)
  }
  if (engine !== 200) {
    blocked([
      `engine /health = ${engine || 'unreachable'} at ${ENGINE_URL}`,
      'start it with:',
      '  set -a; . ./.env; PUBLIC_TEST_MODE=1; set +a; \\',
      '    .venv/bin/python -m engine serve --config config.yaml \\',
      '    --host 127.0.0.1 --port 8000',
    ])
  }
  console.log(`  engine  /health           200  ${ENGINE_URL}`)

  // 2. test-mode posture. Without it the FE never gets a Supabase
  //    session, every authed surface renders empty, and ~half the suite
  //    fails for an ENVIRONMENT reason that would then be baselined as
  //    if it were a code defect. That is a worse outcome than a red gate.
  const sess = await probe(`${ENGINE_URL}/api/test-mode/session`)
  if (sess !== 200) {
    blocked([
      `engine /api/test-mode/session = ${sess || 'unreachable'} (want 200)`,
      sess === 404
        ? 'the route is not mounted: PUBLIC_TEST_MODE=1 is missing from the engine env'
        : 'the route is mounted but cannot mint a session: VITE_SUPABASE_URL / '
          + 'VITE_SUPABASE_ANON_KEY are missing from the engine env (they are in ./.env)',
      'restart the engine with BOTH: `set -a; . ./.env; PUBLIC_TEST_MODE=1; set +a`',
    ])
  }
  console.log('  engine  /api/test-mode/session  200  (test-mode posture confirmed)')

  // 3. vite
  let vite = await probe(VITE_URL)
  if (vite !== 200 && SERVE) {
    console.log(`  vite down — starting npm run dev on ${VITE_URL}`)
    launch('vite', 'npm', ['run', 'dev'], {})
    await waitFor(VITE_URL, 90_000, (s) => s === 200)
    vite = await probe(VITE_URL)
  }
  if (vite !== 200) {
    blocked([`vite = ${vite || 'unreachable'} at ${VITE_URL}`, 'start it with: npm run dev'])
  }
  console.log(`  vite    /                 200  ${VITE_URL}`)

  // 4. the proxy the FE actually uses. Probing the engine directly is not
  //    the same test: the browser reaches it through vite's /api proxy,
  //    and that proxy has been misconfigured before.
  const viaVite = await probe(`${VITE_URL}/api/test-mode/session`)
  if (viaVite !== 200) {
    blocked([
      `${VITE_URL}/api/test-mode/session = ${viaVite || 'unreachable'} (want 200)`,
      'vite\'s /api proxy is not reaching the engine — check vite.config.ts server.proxy',
    ])
  }
  console.log('  vite    /api/... -> engine  200  (proxy confirmed)')
  console.log('')
}

// ──────────────────────────────────────────────────────────────────────
// THE RUN
// ──────────────────────────────────────────────────────────────────────

// Playwright's default testMatch. A file that looks like a spec to a
// human but does not match THIS is collected by nobody.
const PLAYWRIGHT_TEST_MATCH = /\.(spec|test)\.[cm]?[jt]sx?$/
// "Looks like a spec to a human": the word `spec` or `test` appears in
// the name and it is a TS/JS source file.
const LOOKS_LIKE_SPEC = /(spec|test)/i

/**
 * Returns { specs, nearMiss }.
 *
 * `nearMiss` is the hole this gate had until 2026-08-31, found by
 * measurement rather than by reading: `e2e/design/capsule-craft-surface
 * .spec 2.ts` is TRACKED IN GIT, contains 5 `test(...)` blocks, and is
 * byte-identical to a live spec — but its name ends in `2.ts`, so
 * Playwright's testMatch never collects it AND the old `/\.spec\.ts$/`
 * walk below never listed it either. It was therefore invisible to
 * BOTH the runner and the runner's own dark-file detector: Refusal 2
 * could not fire, because the file was not in the census it compares
 * against. A Finder "duplicate", a `cp file.spec.ts file.spec.2.ts`, or
 * a merge artefact all land here, and the tests inside go dark silently
 * — which is the precise disease this file was written to end.
 */
function specFilesOnDisk() {
  const specs = []
  const nearMiss = []
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) {
        if (e === 'artifacts' || e === 'fixtures') continue
        walk(p)
      } else if (PLAYWRIGHT_TEST_MATCH.test(e)) {
        specs.push(relative(ROOT, p))
      } else if (LOOKS_LIKE_SPEC.test(e) && /\.[cm]?[jt]sx?$/.test(e)
        && !e.startsWith('_')) {
        nearMiss.push(relative(ROOT, p))
      }
    }
  }
  walk(join(ROOT, SPEC_ROOT))
  return { specs: specs.sort(), nearMiss: nearMiss.sort() }
}

/** How many `test(` / `test.describe(` blocks a file declares. Used only
 *  to say whether a near-miss file is carrying real tests. */
function declaredTestCount(rel) {
  try {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    return (src.match(/^\s*test(\.\w+)*\s*\(/gm) || []).length
  } catch {
    return 0
  }
}

function runSuite(jsonPath) {
  const cmd = ['playwright', 'test', `--project=${PROJECT}`,
    '--reporter=json', '--retries=0', `--workers=${WORKERS}`]
  if (GREP) cmd.push('--grep', GREP)
  try {
    execFileSync('npx', cmd, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonPath },
    })
  } catch {
    // Non-zero exit is expected while the baseline is non-empty; the JSON
    // report is the payload, not the exit code.
  }
  if (!existsSync(jsonPath)) {
    blocked(['playwright produced no JSON report — the run did not start'])
  }
  return JSON.parse(readFileSync(jsonPath, 'utf8'))
}

/** Flatten the nested suite tree into one row per test. */
function collect(report) {
  const rows = []
  const walk = (suite, titles) => {
    const here = suite.title && suite.title !== suite.file
      ? [...titles, suite.title] : titles
    for (const spec of suite.specs || []) {
      const file = spec.file.startsWith(SPEC_ROOT + '/')
        ? spec.file : `${SPEC_ROOT}/${spec.file}`
      const title = [...here, spec.title].join(' › ')
      // A spec can carry several `tests` (one per project); we run one
      // project, but take the worst status so a multi-project run can
      // never launder a failure into a pass.
      let status = 'skipped'
      for (const t of spec.tests || []) {
        if (t.status === 'unexpected') status = 'unexpected'
        else if (t.status === 'flaky' && status !== 'unexpected') status = 'flaky'
        else if (t.status === 'expected' && status === 'skipped') status = 'expected'
      }
      rows.push({ key: `${file}::${title}`, file, status })
    }
    for (const s of suite.suites || []) walk(s, here)
  }
  for (const s of report.suites || []) walk(s, [])
  return rows
}

// ──────────────────────────────────────────────────────────────────────

async function main() {
  await preflight()

  const tmp = join(tmpdir(), `e2e-gate-${process.pid}`)
  mkdirSync(tmp, { recursive: true })
  const jsonPath = join(tmp, 'report.json')

  console.log('RUNNING THE SUITE')
  console.log('-'.repeat(62))
  console.log(`  npx playwright test --project=${PROJECT} --retries=0`)
  const t0 = Date.now()
  const report = runSuite(jsonPath)
  const secs = Math.round((Date.now() - t0) / 1000)
  rmSync(tmp, { recursive: true, force: true })

  const rows = collect(report)
  const executed = rows.filter((r) => r.status !== 'skipped')
  const failed = rows.filter((r) => r.status === 'unexpected' || r.status === 'flaky')
  const filesInRun = new Set(rows.map((r) => r.file))
  const { specs: filesOnDisk, nearMiss } = specFilesOnDisk()
  const loadErrors = report.errors || []

  console.log('')
  console.log('PLAYWRIGHT GATE')
  console.log('='.repeat(62))
  console.log(`  ${filesOnDisk.length} spec files on disk, ${filesInRun.size} contributed tests`)
  console.log(`  ${rows.length} tests discovered, ${executed.length} executed, `
    + `${rows.length - executed.length} skipped, ${failed.length} failing`)
  console.log(`  wall clock ${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`)
  // A work-floor line in the battery's format. NOTE, measured
  // 2026-08-31: NOTHING reads it. `scripts/run_battery.py` has no
  // playwright gate — its own comment says so ("that suite is not in
  // the battery") — and a grep for `GATE-WORK playwright` across the
  // repo returns only this line. An earlier version of this comment
  // claimed "the battery reads this line for its work-floor check",
  // which was a coupling that does not exist; the line is still worth
  // printing, for a human and for whoever wires it up. It counts
  // EXECUTED tests, never discovered ones — a suite that discovers 253
  // and runs 0 has done no work, and that is precisely the state this
  // gate exists to make unreportable as green.
  console.log(`GATE-WORK playwright units=${executed.length}`)
  console.log('-'.repeat(62))

  // A --grep run has deliberately narrowed discovery, so every refusal
  // below would fire for the wrong reason. Rather than soften them for
  // this mode — which is how a gate learns to lie — the scoped run is
  // taken out of the gate business entirely and exits non-zero no matter
  // what it saw, so its output can never be pasted as proof.
  if (GREP) {
    console.log('')
    console.log(`DIAGNOSTIC ONLY (--grep ${GREP}) — NOT A GATE, NOT PROOF.`)
    for (const r of rows) console.log(`  [${r.status}] ${r.key}`)
    shutdown()
    process.exit(2)
  }

  const fatal = []

  // ── Refusal 1 ────────────────────────────────────────────────────────
  if (rows.length === 0) {
    fatal.push('ZERO TESTS DISCOVERED — the run measured nothing.')
  }
  if (executed.length === 0) {
    fatal.push('ZERO TESTS EXECUTED — every test skipped. A suite that '
      + 'runs nothing has proved nothing.')
  }
  if (executed.length < EXECUTED_FLOOR) {
    fatal.push(`ONLY ${executed.length} tests executed, floor is ${EXECUTED_FLOOR}. `
      + 'Collection collapsed, or tests were skipped into silence.')
  }

  // ── Refusal 2 ────────────────────────────────────────────────────────
  for (const f of filesOnDisk) {
    if (filesInRun.has(f)) continue
    if (NOT_DISCOVERABLE.has(f)) {
      console.log(`  NOTE ${f}: contributes no tests — ${NOT_DISCOVERABLE.get(f)}`)
      continue
    }
    fatal.push(`${f} is on disk but contributed NO tests, and is not named `
      + 'in NOT_DISCOVERABLE. A dark spec file is the whole defect.')
  }
  for (const e of loadErrors) {
    fatal.push(`spec failed to LOAD (its tests never ran): `
      + `${(e.message || JSON.stringify(e)).split('\n')[0]}`)
  }

  // ── Refusal 2c: files Playwright's testMatch can never collect ───────
  // The census above compares "on disk" against "in the run", so it can
  // only see files it counted as on disk. A file whose NAME misses
  // testMatch is absent from BOTH sides and cancels out to silence.
  for (const f of nearMiss) {
    const n = declaredTestCount(f)
    fatal.push(`${f} is NOT COLLECTABLE by Playwright (its name does not match `
      + `testMatch ${PLAYWRIGHT_TEST_MATCH}) yet it declares ${n} test block(s). `
      + 'Nothing runs it and, until this check existed, nothing reported it. '
      + 'Rename it to *.spec.ts if the tests are wanted, or delete it.')
  }

  // ── Refusal 2b ───────────────────────────────────────────────────────
  const ranByFile = new Map()
  for (const r of rows) {
    const cur = ranByFile.get(r.file) || 0
    ranByFile.set(r.file, cur + (r.status === 'skipped' ? 0 : 1))
  }
  for (const [file, ran] of [...ranByFile].sort()) {
    if (ran > 0) {
      if (ALL_SKIPPED_OK.has(file)) {
        fatal.push(`${file} now RUNS tests but is still listed in `
          + 'ALL_SKIPPED_OK. Remove it — a stale entry there would let the '
          + 'whole file go dark again for free.')
      }
      continue
    }
    if (ALL_SKIPPED_OK.has(file)) {
      console.log(`  DARK ${file}: every test skipped — ${ALL_SKIPPED_OK.get(file)}`)
      continue
    }
    fatal.push(`${file} collected tests but EXECUTED NONE — every one skipped, `
      + 'and the file is not named in ALL_SKIPPED_OK. Silencing a spec with '
      + 'test.skip is not the same as fixing it.')
  }

  // ── Refusal 2d: a floor PER FILE, not a floor on the sum ─────────────
  // EXECUTED_FLOOR above is a floor on a SUM, and this session already
  // measured what that is worth: `import-boundary` printed "boundary
  // holds" with a real violation planted, because its frontend half
  // collapsed 517 → 1 while the TOTAL stayed above one global floor
  // (design_review/FALSE_GREEN_FINDINGS.md, R3). The same hole is here:
  // modes.spec.ts alone carries ~52 tests, so it could collapse to 1 and
  // this suite would still clear 150 comfortably.
  //
  // So every contributing file carries its OWN recorded expectation, and
  // a file with no recorded expectation is a failure rather than a file
  // that silently checks nothing.
  const missingFloors = []
  for (const [file, ran] of [...ranByFile].sort()) {
    if (ran === 0) continue // handled above
    const floor = FILE_FLOORS.get(file)
    if (floor === undefined) { missingFloors.push([file, ran]); continue }
    if (ran < floor) {
      fatal.push(`${file} executed ${ran} test(s), floor ${floor}. Collection `
        + 'collapsed in THIS file. The suite total can stay healthy while one '
        + 'file goes dark — that is exactly what a per-file floor is for.')
    }
  }
  if (missingFloors.length) {
    fatal.push(`${missingFloors.length} spec file(s) ran with NO recorded floor. `
      + 'An unrecorded file can collapse to one test for free. Paste the '
      + 'measured floors into FILE_FLOORS:\n'
      + missingFloors.map(([f, n]) => `        ['${f}', ${n}],`).join('\n'))
  }
  for (const file of FILE_FLOORS.keys()) {
    if (!filesOnDisk.includes(file)) {
      fatal.push(`FILE_FLOORS names ${file}, which is not on disk. A stale `
        + 'expectation is a loose ratchet: remove it deliberately, so deleting '
        + 'a spec file is a decision somebody made rather than a silent loss.')
    }
  }

  // ── Refusal 3 ────────────────────────────────────────────────────────
  const byKey = new Map(rows.map((r) => [r.key, r.status]))
  for (const k of MUST_PASS) {
    const st = byKey.get(k)
    if (st === undefined) {
      fatal.push(`CANARY MISSING: ${k}\n      This gate proves nothing if its own `
        + 'plumbing test has vanished. Retarget the canary or fix the suite — '
        + 'do not delete the canary to make the gate green.')
    } else if (st !== 'expected') {
      fatal.push(`CANARY ${st.toUpperCase()}: ${k}`)
    }
  }

  if (fatal.length) {
    console.log('')
    console.log('FAIL — the gate itself is not sound:')
    for (const f of fatal) console.log(`  ${f}`)
    shutdown()
    process.exit(1)
  }
  console.log(`  canaries: ${MUST_PASS.length}/${MUST_PASS.length} ran and passed`)

  // ── The ratchet ──────────────────────────────────────────────────────
  const keys = failed.map((r) => r.key).sort()

  if (WRITE) {
    writeFileSync(join(ROOT, BASELINE), keys.join('\n') + '\n')
    console.log('')
    console.log(`WROTE ${keys.length} failing tests to ${BASELINE}`)
    shutdown()
    process.exit(0)
  }

  let baseline = []
  try {
    baseline = readFileSync(join(ROOT, BASELINE), 'utf8')
      .split('\n').map((l) => l.trim()).filter(Boolean)
  } catch { /* no baseline: every failure is new */ }

  const remaining = baseline.slice()
  const fresh = []
  for (const k of keys) {
    const i = remaining.indexOf(k)
    if (i === -1) fresh.push(k)
    else remaining.splice(i, 1)
  }

  console.log(`  ${keys.length} failing (baseline ${baseline.length}, `
    + `new ${fresh.length}, healed ${remaining.length})`)

  // BOTH lists print before either exits. An early `process.exit` on the
  // healed branch hid the planted NEW failure behind four flaky axe
  // tests during this gate's own plant run — the more urgent signal
  // suppressed by the less urgent one. A gate that reports half of what
  // it found teaches the reader to distrust the half it showed.
  if (fresh.length) {
    console.log('')
    console.log('FAIL — NEW failing tests:')
    for (const k of fresh) console.log(`  ${k}`)
    console.log('')
    console.log('Fix the assertion or fix the app. Do NOT add these to the')
    console.log('baseline — the baseline only ever shrinks.')
  }

  // A healed test left in the baseline is a loose ratchet: it could
  // regress tomorrow and this gate would call it known debt.
  if (remaining.length) {
    console.log('')
    console.log('FAIL — these now PASS but are still baselined, which leaves')
    console.log('room for them to regress for free. Tighten the ratchet:')
    console.log('  node scripts/run_playwright_gate.mjs --write-baseline')
    for (const k of remaining.sort()) console.log(`  ${k}`)
  }

  // Both lists non-empty at once is the FLAKE signature, not two
  // separate regressions: the same run cannot honestly have both fixed
  // and broken things unless the suite is unstable. Say so, because
  // "new 4, healed 4" read as a code change is a wrong story.
  if (fresh.length && remaining.length) {
    console.log('')
    console.log('NOTE — NEW and HEALED in the same run is the signature of a')
    console.log('FLAKY suite, not of two independent changes. Re-run with')
    console.log('E2E_WORKERS=1 (the committed config) before believing either')
    console.log('list; if a test moves between runs with no edit, it is flaky')
    console.log('and belongs neither in the baseline nor out of it until fixed.')
  }

  if (fresh.length || remaining.length) {
    shutdown()
    process.exit(1)
  }

  console.log('')
  console.log(`PASS — no NEW e2e failures (${keys.length} known, ${BASELINE}); `
    + `${executed.length} tests actually executed.`)
  shutdown()
  process.exit(0)
}

process.on('SIGINT', () => { shutdown(); process.exit(130) })
main().catch((e) => { console.error(e); shutdown(); process.exit(1) })
