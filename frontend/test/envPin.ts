// Pin the build-time env the test run sees. MUST be imported before any
// module that reads `import.meta.env` at load time.
//
// ── THE DEFECT THIS CLOSES ────────────────────────────────────────────
// `npx vitest run` was green on the owner's machine and RED anywhere else:
//
//     Tests  3 failed | 1462 passed | 1 skipped (1466)
//
// G7.a, K10.a and K10.f — three of the money-boundary tests, the ones that
// assert an interpretation question DOES reach the paid model seam — passed
// only because a gitignored `.env` happened to supply a real
// VITE_SUPABASE_URL. Proven by flipping that one variable and nothing else:
//
//     VITE_SUPABASE_URL="" npx vitest run   ->  3 failed
//     (unset the other three local vars too ->  the same 3, so it is this one)
//
// cfoApi.ts builds SUPABASE_FUNCTIONS_URL into a module-level const at load:
//
//     const SUPABASE_FUNCTIONS_URL = (() => {
//       const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
//       return base ? `${base.replace(/\/$/, "")}/functions/v1` : undefined;
//     })();
//
// With no base, `chatLlm` rejects with "Chat isn't configured" BEFORE it ever
// reaches the seam the test counts — so the assertion fails for a reason that
// has nothing to do with the behaviour under test.
//
// ── WHY HERE AND NOT IN THE THREE TESTS ───────────────────────────────
// The in-file house pattern is `vi.stubEnv(...)` + a dynamic import
// (periodGates.test.ts:78, jurisdictionUploadHint.test.ts), and it works there
// because those files import the module under test dynamically, AFTER the stub.
// capsuleCraft/capsuleSpendBoundary import `CommandPalette` statically, and ES
// imports hoist above every statement in the file — so no amount of stubbing
// inside those files can run before cfoApi is evaluated. Restructuring two test
// files to dynamic imports would fix those two and leave the trap armed for the
// next component that reaches config at module load. Setup files run before a
// test file's imports, so pinning here fixes the class in one place.
//
// This is its own module, imported first by setup.ts, for exactly the reason
// webStorageShim is: a bare statement at the top of setup.ts would still run
// AFTER setup.ts's own imports were evaluated.
//
// ── WHY FAKE VALUES, ALWAYS, AND NOT A FALLBACK ───────────────────────
// Unconditional, not `??=`. A fallback would leave the run reading whatever
// real project URL a developer has in `.env`, which keeps two machines on two
// different configs and points unit tests at a live Supabase project. A fixed
// fake makes every machine and CI evaluate the same thing and guarantees the
// suite cannot reach production.
//
// Plain assignment rather than `vi.stubEnv`: a stub is undone by
// `vi.unstubAllEnvs()`, which any test may legitimately call. This is the
// baseline the run starts from, not a per-test override — tests that need a
// different value still stub over it normally.
//
// ── WHY A TABLE, AND WHY IT COVERS FOURTEEN VARIABLES AND NOT TWO ─────
// The first version of this file pinned the two Supabase variables — the two
// the incident was about — and stopped there. An egress audit of the whole
// suite (design_review/HERMETICITY.md) showed that left two more variables
// still resolving from the untracked `.env.local` on this machine:
//
//   VITE_API_URL=http://127.0.0.1:8000   VITE_PUBLIC_TEST_MODE=1
//
// Both are read at module load, both change behaviour, and neither was
// visible to a fix aimed at the reported symptom. VITE_API_URL is the worse
// of the two: with `.env.local` absent AND the Supabase branch unavailable,
// `lib/rates.ts` falls through to `SITE.apiUrl`, whose default is
// `https://api.cfo-ai.io` — measured, 33 GETs at PRODUCTION in a bare clone.
//
// So the pin is no longer a hand-written pair of assignments. It is the whole
// census of VITE_ variables the frontend reads, recorded one entry at a time
// in hermeticEnv.json, applied here and independently verified by
// scripts/check_hermetic.mjs in two environments. Adding a variable to the
// product without adding it there fails that gate.
//
// NOTE: no test asserts the unconfigured path today (grepped: nothing asserts
// "Chat isn't configured"). If one is ever added, it should stub the value
// away explicitly rather than depend on the ambient environment being empty.

import manifest from "./hermeticEnv.json";

const HERMETIC_ENV = manifest.env as Record<string, string | null>;

const env = import.meta.env as unknown as Record<string, string | undefined>;
const proc = process.env as unknown as Record<string, string | undefined>;

for (const [name, value] of Object.entries(HERMETIC_ENV)) {
  if (value === null) {
    // Absent, not empty-string. A variable the product treats as optional
    // must be genuinely missing, the way it is in CI, so the code under test
    // takes its own default branch rather than a developer's stray value.
    delete env[name];
    delete proc[name];
  } else {
    env[name] = value;
  }
}

export { HERMETIC_ENV };
