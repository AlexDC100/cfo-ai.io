// Public test-mode FE helper — env-gated open-access posture.
//
// Mirrors `src/engine/api/_test_mode.py` on the BE side. Both must be
// flipped together: FE-only test-mode shows the banner + hides auth UI
// but the BE still rejects every request with 401; BE-only test-mode
// accepts every request but the FE still shows the login wall.
//
// Read at module-load time from Vite's `import.meta.env`. The flag is
// baked into the bundle at build time, so flipping it requires a FE
// rebuild + redeploy (one-line `./scripts/deploy.sh --frontend --yes`
// after the env var is changed). The BE flag is read on every request
// so it can be flipped without rebuilding.
//
// Discovery rules:
//   - Test mode ON  → banner visible, `/login` + `/signup` redirect
//                     to `/dashboard`, AccountMenu hides personal CTAs,
//                     Pricing route shows the "test mode" message,
//                     AuthProvider injects a synthetic test user so
//                     every signed-in-required path passes.
//   - Test mode OFF → original auth + billing posture restored.
//                     Zero behavioral change vs. pre-test-mode build.

/** True iff the FE bundle was built with `VITE_PUBLIC_TEST_MODE=1`. */
export const isPublicTestMode: boolean =
  (import.meta.env.VITE_PUBLIC_TEST_MODE as string | undefined)?.trim() === "1";

/** Synthetic identity used when test mode is on. The user_id matches the
 *  default in `_test_mode.py` so FE-side state and BE-side queries agree
 *  on who's signed in. Override at build time via `VITE_TEST_USER_ID` /
 *  `VITE_TEST_ORG_ID` if the operator wants to point at a different
 *  shared workspace. */
export const TEST_USER_ID: string =
  (import.meta.env.VITE_TEST_USER_ID as string | undefined)?.trim() ||
  "00000000-0000-4000-8000-000000000001";

export const TEST_ORG_ID: string =
  (import.meta.env.VITE_TEST_ORG_ID as string | undefined)?.trim() ||
  "00000000-0000-4000-8000-000000000002";

/** Workspace label rendered in the app shell when test mode is on. */
export const TEST_WORKSPACE_LABEL = "Test workspace";
export const TEST_USER_EMAIL = "test@cfo-ai.io";
export const TEST_DISPLAY_NAME = "Test visitor";
