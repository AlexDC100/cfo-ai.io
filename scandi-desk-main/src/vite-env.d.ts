/// <reference types="vite/client" />

// PUBLIC_TEST_MODE — env-gated open-access posture. See `src/lib/testMode.ts`
// for the FE helper and `src/engine/api/_test_mode.py` for the BE side.
// All three vars are baked into the bundle at build time; flipping them
// requires a FE rebuild + redeploy (one-line `./scripts/deploy.sh --frontend --yes`).
interface ImportMetaEnv {
  /** "1" to enable open test-mode posture (no auth, no billing, banner shown). */
  readonly VITE_PUBLIC_TEST_MODE?: string;
  /** Override the synthetic test user's UUID. Defaults to
   *  `00000000-0000-4000-8000-000000000001` if unset. Must match the
   *  BE `TEST_USER_ID` env var to keep FE+BE in agreement. */
  readonly VITE_TEST_USER_ID?: string;
  /** Override the synthetic test org's UUID. Defaults to
   *  `00000000-0000-4000-8000-000000000002` if unset. Must match the
   *  BE `TEST_ORG_ID` env var. */
  readonly VITE_TEST_ORG_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
