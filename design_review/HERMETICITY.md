# HERMETICITY — what the vitest suite reached, and the gate that stops it

**Lane:** hermeticity. **Tree:** `42c5986` + working tree, frontend only.
**Two questions, both the owner's words.** (1) *"confirm nothing in that suite
ever wrote to the live Supabase project."* (2) *"add a hermeticity gate — the
suite must fail loudly if any required env var resolves from an untracked
local file rather than the test harness."*

Answer to (1) up front, because the honest version is not a clean yes:

> **No test ever sent a write. Every request the suite made was a `GET` with
> no body — measured, not inferred, across all 103 test files in five
> configurations.** But the one live endpoint it reached, `fx-rates`, is an
> Edge Function that runs with the SERVICE ROLE key and **upserts a row as a
> side effect of a plain GET**. So the suite could have caused a server-side
> write to one shared cache row. I cannot rule that out from this side of the
> wire, and §4 says exactly what evidence would settle it.

---

## 1. How this was measured

Static reading cannot answer "what did it reach" — the whole defect was that
nobody could see it. So the suite was instrumented and replayed.

`netAudit.ts` (scratchpad, not committed) is a setup file loaded **before**
`frontend/test/setup.ts`. It records and then **blocks** every egress path:

| Layer | Patched | Why |
|---|---|---|
| semantic | `fetch` | gives METHOD + URL + body |
| semantic | `XMLHttpRequest` | jsdom's client, in case anything uses it |
| semantic | `WebSocket` | supabase realtime |
| **chokepoint** | `net.Socket.prototype.connect`, `tls.connect` | **no socket can open at all** |

The chokepoint is what made it safe to re-arm the pre-fix configuration and
replay the whole suite: a client I failed to anticipate still cannot reach the
network, and still gets recorded. Each record carries method, URL, whether a
body was present, a body preview, the test file, and a stack.

Five full-suite runs, 103 files each:

| # | Configuration | Egress recorded |
|---|---|---|
| A | **pre-fix reconstruction** — `envPin` undone, real `.env` values restored | 34 · 33 GET `https://cjclenykwlngqvapmisb.supabase.co/functions/v1/fx-rates`, 1 GET `http://127.0.0.1:8000/api/features/status` |
| B | pre-fix, but blocked calls answered with a synthetic **200** so downstream code proceeds | 18 · same two URLs, no new endpoint appears |
| C | **HEAD as shipped** (`envPin` active) | 34 · 33 GET `https://test.supabase.co/…` (unresolvable), 1 GET localhost. **0 to the real project** |
| D | HEAD with `.env.local` removed (the CI case) | 34 · same as C |
| E | **bare clone** — no `.env`, no `.env.local`, no pin | 34 · **33 GET `https://api.cfo-ai.io/api/fx-rates` — PRODUCTION** |

Aggregate across all five, every record:

```
kinds: {"fetch":34}   verbs: {"GET":34}   withBody: 0
```

Zero XHR. Zero WebSocket. Zero raw sockets. **Zero request bodies. No verb
other than GET, ever.**

Run B matters: blocking a call hides whatever a *successful* response would
have triggered next. Answering 200 instead explored past the block, and no new
endpoint appeared — the fx-rates response is written to `localStorage`, not
back to any server.

Run E is the reproduction check: it fails **exactly** `G7.a`, `K10.a`, `K10.f`
and nothing else, which is the reported defect's fingerprint.

---

## 2. What could reach a real endpoint, and by what verb

**One product path, not one test.** `frontend/stores/currency.tsx`
(`CurrencyProvider`) kicks off a rate fetch on mount; `frontend/lib/rates.ts:63`
builds the URL:

```ts
if (SUPABASE_URL) {
  if (SUPABASE_ANON_KEY) headers.apikey = SUPABASE_ANON_KEY;
  return { url: `${SUPABASE_URL}/functions/v1/fx-rates${qs}`, headers };
}
return { url: `${API_URL}/api/fx-rates${qs}`, headers };   // ← run E goes here
```

Five test files mount that provider and do not mock `@/lib/rates`:
`accountMenu`, `currencyToggle`, `modeParityM1`, `scenarioModes`,
`productsInstrument`. `GET`, no body, `Accept: application/json`, `apikey`
header, **no `Authorization` and no session** — so any RLS the request met was
evaluated as `anon` with `auth.uid()` null.

`?refresh=true` (the Settings "Refresh now" path, which forces a BNR refetch
+ upsert on every call) was **never** used: all 33 URLs were bare.

The second URL, `http://127.0.0.1:8000/api/features/status`, comes from
`frontend/lib/features.ts:116`; `featureRegistry.test.tsx`'s own header says it
runs "without a backend", and one of its cases still fetches. It is localhost —
but only because `features.ts:30` happens to default to `127.0.0.1:8000`.
`config/site.ts:29` defaults the *same variable* to `https://api.cfo-ai.io`.
Two defaults for one variable is how run E ends up at production.

**What the suite never touched, in any configuration:** `/rest/v1/` (tables),
`/rest/v1/rpc/` (functions), `/auth/v1/` (sessions), `/storage/v1/` (files).
No user data, no schema, no auth state was read or written by any test.

---

## 3. Key scope

Measured locally, no network call, values never printed:

| Variable | Shape | Reachable from a frontend test? |
|---|---|---|
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_…` (46 ch) | **yes** — `VITE_` prefixed, so Vite exposes it |
| `SUPABASE_SERVICE_ROLE_KEY` | `sb_secret_…` (41 ch) | **no** — measured `undefined` in both `import.meta.env` and `process.env` |
| `ANTHROPIC_API_KEY` | — | **no** — same, measured `undefined` |

`sb_publishable_*` is the successor to the anon JWT: it maps to the Postgres
`anon` role and is RLS-bound. It is designed to ship to browsers.

Its write scope, from the tracked migrations: **`anon` appears in exactly three
places, all SELECT** — `founding_member_count` and `current_user_usage` grants
(`schema_phase5_usage_limits.sql:119,177`) and one read policy
(`schema_phase_fx_rates.sql:60-64`). No `for insert` / `for update` /
`for delete` / `for all` policy names `anon` anywhere in `supabase/*.sql`, and
`schema_phase_security_hardening.sql` revoked the default `PUBLIC EXECUTE` on
every `SECURITY DEFINER` function. `fx_rates_cache` carries an explicit comment
saying so:

> `-- No INSERT/UPDATE/DELETE policy on purpose: the service role bypasses RLS`

---

## 4. The part I cannot close, stated plainly

**`fx-rates` writes.** `supabase/functions/fx-rates/index.ts` builds a client
with `SERVICE_ROLE_KEY` and, when the cached row is missing or older than 24 h,
fetches BNR and does:

```ts
await db.from("fx_rates_cache").upsert({ id: "current", … }, { onConflict: "id" })
```

So a `GET` from a test **can** produce a server-side write. Bounded: one row,
`id = 'current'`, in a table whose only content is public central-bank
reference rates, written with exactly the same values the production web app
writes on the first request of any day. No user data, no other table. But it is
a write, and "the suite never wrote" would be false.

**What I did not do, deliberately:** I did not query the live project. Answering
this conclusively means reading production, and that is the owner's call, not
mine. The `supabase` MCP server in this session is unauthenticated anyway.

**The evidence that would settle it**, none of which I have:

1. **Edge Function logs** for `fx-rates` (Supabase Dashboard → Edge Functions →
   Logs) — invocation count and source IPs over 2026-07-27 → 2026-08-31. Test
   traffic would appear as bursts of ~5 invocations from a developer IP with no
   `Origin` header (jsdom sends none, and the function's CORS allowlist would
   have fallen back to `https://cfo-ai.io`).
2. **`select id, source, as_of, fetched_at, updated_at from fx_rates_cache`** —
   one row; if `updated_at` clusters on days someone ran the suite, the upsert
   fired.
3. **Postgres logs / `pg_stat_statements`** for any write outside the function.
4. **Live RLS drift.** §3 is read from the tracked migrations, not from the
   database. The repo itself documents that re-running
   `schema_phase5_usage_limits.sql` silently re-grants `anon` — a live
   `select * from pg_policies where 'anon' = any(roles)` is the only way to know
   what `anon` can actually do today.

---

## 5. How long the exposure lasted

| Date | Event | Evidence |
|---|---|---|
| 2026-05-10 20:20 | `.env` last written — real `VITE_SUPABASE_URL` present and unchanged from here on | `stat` mtime |
| 2026-06-22 | repo history begins (`bde8847`, squashed "your message") | `git log` — **nothing before this is knowable** |
| 2026-07-26 | `currencyToggle.test.tsx` lands, mounting `CurrencyProvider` unmocked | `git log --diff-filter=A` |
| **2026-07-27** | **`1d69d6e` "FX rates on Supabase" — `rates.ts` starts building `${VITE_SUPABASE_URL}/functions/v1/fx-rates`. Exposure begins.** | `git log -S 'functions/v1/fx-rates'` |
| 2026-08-29 | three more provider-mounting test files land | `git log` |
| **2026-08-31** | `42c5986` adds `envPin.ts`. Exposure ends. | `git log -- frontend/test/envPin.ts` |

**≈ 35 days.** Before 2026-07-27 the same five files hit `${API_URL}/api/fx-rates`
instead — the engine, i.e. localhost on this machine, `https://api.cfo-ai.io`
on one without `.env.local`.

**Narrowing:** no CI job runs vitest. `npm test` is `vitest run`, and no
workflow in `.github/workflows/` invokes it — `grep` for `vitest` / `npm test`
across all three workflow files returns nothing. So the exposure is bounded to
developer machines holding a real `.env`, which as far as this repo shows is
this one. **How many times it ran is not recoverable from anything on disk.**

**Adjacent, checked and clean:** the Playwright suite's URLs come from the same
`.env`, and `e2e/design/capsule-craft.spec.ts:324` intercepts
`**/functions/v1/chat-llm` with `route.fulfill()`, so the `POST` that appears in
its log never leaves the browser. Its hermeticity is by interception, not by
configuration — if that glob ever stops matching the URL shape, a real POST to
a paid seam goes out. Not my lane; flagged.

---

## 6. What the reported fix left open

The shipped `envPin.ts` pinned the two variables the incident named. The audit
found **two more still resolving from the untracked `.env.local`**:

```
VITE_PUBLIC_TEST_MODE=1        → isPublicTestMode true here, false everywhere else
VITE_API_URL=http://127.0.0.1:8000
```

`VITE_API_URL` is the serious one. It is the fallback target for the *same*
fx-rates call, and its `config/site.ts` default is `https://api.cfo-ai.io`.
Run E measured the consequence: **33 GETs at production**. On this machine the
untracked file was the only thing preventing that — the leak was load-bearing.

Both are now pinned. Measured safe before pinning: deleting them from a full
run leaves `1470 passed | 1 skipped`, identical to baseline.

`frontend/test/hermeticEnv.json` now records **all 14** `VITE_` variables the
frontend reads — 4 pinned, 10 must-be-absent — with values chosen to be
*unreachable*, not merely different (`test.supabase.co` and `api.test.invalid`
both `ENOTFOUND`, and `.invalid` is reserved by RFC 2606 so it can never be
registered). One file, two consumers: `envPin.ts` applies it, the gate verifies
it.

---

## 7. The gate — `scripts/check_hermetic.mjs`

`"Is the env correct?"` cannot be answered by reading the env: a leaked value
and a pinned value are indistinguishable from inside the run. So the gate runs
**twice** and compares.

```
LOCAL     envDir = repo root   → Vite loads .env / .env.local, as `npx vitest run` does
HERMETIC  envDir = empty dir   → Vite loads no dotenv file, as a fresh clone / CI does
```

A variable whose value **differs** between them came from an untracked local
file. That is the hazard stated exactly, with no proxy in between.

Four layers, because each catches what the others cannot:

1. **Mechanism self-test, first.** A sentinel is written into a throwaway
   dotenv file, and the gate proves it can see it *appear* and *disappear*
   across the two configurations. An instrument that cannot detect a leak it
   planted itself does not get to certify a machine.
2. **Per-variable differential, 28 comparisons** — 14 variables × 2
   environments, each named. Plus per-variable agreement with the recorded
   value, because two runs agreeing on a *wrong* value is still wrong (that is
   what "pinned to a real project URL" would look like).
3. **Suite differential** — the full 1488-test suite run both ways, comparing
   per-file executed counts and the **set of failing test names**. This is the
   only layer that can catch a leak through a path the census never enumerated,
   and it is the layer that names `G7.a / K10.a / K10.f` on the pre-fix tree.
4. **Ambient shell scan** — `envDir` governs dotenv *files*; a variable
   `export`ed in the shell (or a CI job-level `env:` block, which
   `tier1-validation.yml` really does set) is present in **both** runs, so no
   differential can ever see it. Checked directly instead.

Plus, in the suite itself, `frontend/test/hermeticity.test.ts` — 17 assertions,
one per variable, so a regression is loud in `npx vitest run` and not only in
the gate. Its last assertion is the live one: *no `VITE_` variable reaches the
run that the manifest does not name*, which catches the **next** variable
rather than the last one.

**TC-3.** The canary and both floors are asserted *after* the discovery loop.
`GATE-WORK hermetic units=14`. Runtime ≈ 50 s.

**TC-6 — three separate recorded expectations, because a sum hides an addend:**

- one per variable per environment (28), never a "leaks: 0" count;
- a floor on the **source scan** (`MIN_SOURCE_VARS`) *separate* from the floor
  on the census — the census is a union of three sources, so it is a sum. This
  is not hypothetical: **PLANT C dropped the source scan 14 → 3 and the census
  stayed at 14**, padded by the manifest. Only the canary noticed. The
  per-source floor was added because of that plant;
- per-file executed counts in the suite differential, not just the total.

**Secrets.** The gate reports observed values only when they equal a recorded
(tracked, fake) value; anything else is reduced to `<redacted len=… sha256:…>`.
This was added after PLANT B printed a real `sb_publishable_…` key to stdout —
a hermeticity gate whose output lands in CI logs must not become the leak.

---

## 8. Plant log (TC-2) — every gate below was proven able to fail

Each: plant → RED → revert → GREEN. No plant was ever staged or committed.

### PLANT A — the owner's ask: a var back onto the untracked path

```diff
--- .env.local          (gitignored: .gitignore:16)
+++ .env.local
@@ -2,2 +2,3 @@
  VITE_API_URL=http://127.0.0.1:8000
+VITE_WORKSPACE_HINT=acme-srl
```

**RED, two independent mechanisms:**

```
 - VITE_WORKSPACE_HINT RESOLVES FROM THE MACHINE, NOT THE HARNESS.
       with .env files loaded : "acme-srl"
       with none loaded       : undefined
       supplied by            : .env.local (untracked)
 - FAILS ONLY BECAUSE OF A LOCAL FILE — frontend/test/hermeticity.test.ts >
       … no VITE_ variable reaches the run that the manifest does not name
```

and bare `npx vitest run frontend/test/hermeticity.test.ts`:
`Tests 1 failed | 16 passed (17)`.
**Revert** → `.env.local` restored, `shasum -a 256 -c` **OK** → gate exit 0.

### PLANT B — the original defect, reintroduced the way it would really come back

The `??=` the file's own comment forbids:

```diff
-    env[name] = value;
+    env[name] ??= value;
```

**RED, exit 1 — 12 problems.** 4 variables caught
(`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL`,
`VITE_PUBLIC_TEST_MODE`), each reported twice (differential + recorded value),
plus 4 suite-differential findings. Redacted output:

```
  - VITE_SUPABASE_URL RESOLVES FROM THE MACHINE, NOT THE HARNESS.
        with .env files loaded : <redacted len=40 sha256:f3f6073c>
        with none loaded       : "https://test.supabase.co"
        supplied by            : .env (untracked)
        read at load by        : frontend/lib/__tests__/jurisdictionUploadHint.test.ts, …
```

**Revert** → `diff` against backup identical → exit 0.

### PLANT C — discovery narrowed (the `tsc --noEmit` incident's shape)

```diff
-scan('frontend')
+scan('frontend/config')
```

**RED, exit 1.** `CANARY MISSING: VITE_SUPABASE_URL was not found anywhere in
frontend/**`. **And the census floor did NOT fire — 14, unchanged.** That is
the TC-6 violation this plant found in my own gate; `MIN_SOURCE_VARS` was added
in response, after which the same plant reds twice:

```
 - SOURCE-SCAN FLOOR: 3 variable(s) found in frontend/**, floor 12, measured 14.
       … the census floor below CANNOT catch this — the manifest pads the union
       back up to full size, which is why the two halves are floored separately.
```

**Revert** → exit 0.

### PLANT D — the instrument made vacuous

```diff
-const emptyEnvDir = join(work, 'no-env');       mkdirSync(emptyEnvDir)
+const emptyEnvDir = ROOT;
```

Both runs then load the same files and can never disagree. **The sentinel stayed
green under this** — it proves the loader works, not that the two configurations
differ. Two structural checks were added because of it, and now:

```
 - MECHANISM BLIND: the hermetic envDir IS the repo root …
 - MECHANISM BLIND: the two measured runs did not use the two intended envDirs.
```

**Revert** → exit 0.

### PLANT E — the sentinel itself defeated

Delete the line that writes the sentinel dotenv file (equivalent to Vite no
longer honouring `envDir`). **RED:**

```
 - MECHANISM BLIND: a dotenv file in envDir defined VITE_HERMETIC_SENTINEL_… and
       the probe did not see it. … every check below reports "no leak" for a
       machine it cannot actually read.
```

**Revert** → exit 0.

### PLANT F — ambient shell variable

`VITE_ROGUE_FLAG=1 node scripts/check_hermetic.mjs` → **RED:**

```
 - VITE_ROGUE_FLAG is exported in the ambient shell and has no entry in
       frontend/test/hermeticEnv.json. The two-environment differential cannot
       see this: a shell variable is present in both runs, so they agree while
       both are wrong.
```

Without the export → exit 0.

### Two false-positive modes found and fixed during bring-up

- **The gate examined nothing and said so.** Its first four runs reported
  `comparisons: 0` and *failed* — the temp config could not resolve
  `vitest/config`, and macOS's `/var → /private/var` symlink made Vite refuse
  the probe file. Both are now handled (configs under `node_modules/`,
  `realpathSync` on the temp dir), but the gate's first instinct was to refuse
  rather than to pass with an empty measurement.
- **A race, not a leak.** One run reported `G4 … PASSES ONLY BECAUSE OF A LOCAL
  FILE`. It was not: another lane was editing
  `frontend/components/instrument/shell/**` *between* the two suite runs.
  A confirmation pass now re-runs the divergent files back to back; a
  divergence that does not reproduce is reported as `NOT REPRODUCIBLE` — still
  a failure, because a differential cannot measure a moving target, but never
  mislabelled as a leak.

---

## 9. Wiring it into the battery

`scripts/run_battery.py` is not mine to edit. Ready to paste into
`_frontend_gates()`:

```python
# HERMETICITY. `npx vitest run` was green here and red on every other
# machine for 35 days: a gitignored .env supplied a real VITE_SUPABASE_URL
# and three money-boundary tests reached a live seam through it. Runs the
# suite with and without the local dotenv files and compares, per variable
# and per failing-test name. Plant log: design_review/HERMETICITY.md §8.
Gate("hermetic", ["node", "scripts/check_hermetic.mjs"],
     work_rx=r"GATE-WORK hermetic units=(\d+)", floor=12,
     units="build-time env variables",
     canaries=('VITE_SUPABASE_URL = "https://test.supabase.co" with the local dotenv files loaded',
               "sentinel VITE_HERMETIC_SENTINEL_")),
```

Both canaries are printable only after real work: the first carries a value
that exists only if both probes ran and returned it; the second only if the
sentinel round-trip completed. Do not pass `--no-suite` in the battery — it
drops layer 3, the only one that can name a test.

---

## 10. Files

| File | |
|---|---|
| `frontend/test/hermeticEnv.json` | new — the recorded expectation, one entry per variable |
| `frontend/test/envPin.ts` | rewritten — applies the manifest (2 variables → 14) |
| `frontend/test/hermeticity.test.ts` | new — 17 in-suite assertions, one per variable |
| `scripts/check_hermetic.mjs` | new — the gate |
| `vitest.config.ts` | **unchanged** (mirrored by the gate, which fails if it drifts) |

Nothing under `frontend/components/instrument/shell/**` was touched.

## 11. Verification

```
node scripts/check_tsc.mjs        673 project files, 10 errors (baseline 10, new 0) — PASS
                                  (all three new files confirmed in the tsc program via --listFiles)
node scripts/check_no_plants.mjs  862 product source files — PASS
node scripts/check_capsule_craft.mjs  units=143 — PASS
node scripts/check_design_lint.mjs    0 hex, 0 shadow, 0 serif — PASS
npx playwright test e2e/design/capsule-craft.spec.ts --project=chromium   22 passed (4.3m)
npx vitest run frontend/test/     3 files, 24 tests passed
node scripts/check_hermetic.mjs   units=14, 28 comparisons, 1488 tests both ways — OK (50s)
```

**Battery, verbatim:**

```
BATTERY: PASS — 30/31 gates green, 1 VACUOUS (public-sitemaps)
```

---

# The Supabase write question — CLOSED with production evidence

Owner-approved read-only query against production, 2026-08-31, run
through the backend container's service-role credentials. **Selects
only; nothing was written.**

## What the table actually holds

```
GET /rest/v1/fx_rates_cache?select=*
200
[{"id":"current","base":"EUR",
  "rates":{"EUR":1,"RON":5.2489,"USD":1.1541116974494283},
  "source":"BNR","as_of":"2026-08-05",
  "fetched_at":"2026-08-05T11:09:17.271+00:00",
  "updated_at":"2026-08-05T11:09:17.271+00:00"}]

GET /rest/v1/fx_rates_cache?select=id   (Prefer: count=exact)
Content-Range: 0-0/1
```

**Exactly one row in the entire table** — a singleton keyed `current`.
Its content is public BNR reference rates. No user data, no
organisation scope, no foreign key to anything.

## The verdict

A write **did** occur inside the exposure window (2026-07-27 →
2026-08-31): `updated_at` is 2026-08-05. So the earlier answer — "not a
clean yes" — was the right one to give, and the mechanism named then is
the mechanism that fired: a client-side `GET functions/v1/fx-rates`
causes a service-role `upsert` when the cached row is older than 24h.

What the evidence establishes:

- **Blast radius is one singleton row of public exchange rates.** That
  is the maximum, not an estimate — the table cannot hold more.
- **No other table was written.** The suite's recorded traffic never
  touched `/rest/v1/`, `/rest/v1/rpc/`, `/auth/v1/` or `/storage/v1/`;
  the only live URL reached was the fx-rates function.
- **Not attributable to the test suite specifically.** Production uses
  the same Edge Function, so the 2026-08-05 refresh could be any caller.
  Attribution would need the function's invocation logs.

**Still unchecked, and named rather than glossed:** the fx-rates Edge
Function invocation logs, which would attribute the Aug-5 write to a
caller. Everything else the earlier report listed as missing is now
answered by the two queries above.

**Closing position: harmless, but recorded.** One row of public FX data
refreshed once in a 35-day window, by a caller that cannot be
identified from the data alone. Nothing user-owned was reachable, and
the anon key in `.env` is `sb_publishable_…` — RLS-bound, no service
scope.

Incidentally: `updated_at` has not moved in 26 days, which means the
>24h refresh is not firing in production either. That is a separate
question about FX freshness, not about this incident, and it is left
for the owner rather than folded into this closure.
