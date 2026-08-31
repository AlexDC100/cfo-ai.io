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
// suite cannot reach production. `https://test.supabase.co` is the value the
// two files above already stub, so the whole suite now agrees on one.
//
// Plain assignment rather than `vi.stubEnv`: a stub is undone by
// `vi.unstubAllEnvs()`, which any test may legitimately call. This is the
// baseline the run starts from, not a per-test override — tests that need a
// different value still stub over it normally.
//
// NOTE: no test asserts the unconfigured path today (grepped: nothing asserts
// "Chat isn't configured"). If one is ever added, it should stub the value away
// explicitly rather than depend on the ambient environment being empty.

const env = import.meta.env as unknown as Record<string, string>;

env.VITE_SUPABASE_URL = "https://test.supabase.co";
env.VITE_SUPABASE_ANON_KEY = "test-anon-key";

export {};
