// Fire-and-forget bootstrap for the FE Supabase session in PUBLIC_TEST_MODE.
//
// Mounted once in App.tsx alongside <TestModeBanner />. On mount it kicks off
// the shared session establisher in lib/testModeSession.ts, which fetches the
// BE-minted access_token + refresh_token from /api/test-mode/session and calls
// supabase.auth.setSession(...).
//
// Why this lives in a separate component instead of inside AuthProvider:
// AuthProvider's test-mode branch is intentionally hooks-free (an early
// return before any useState/useEffect call) so the "rules of hooks"
// can't trip on conditional-render edge cases (Strict Mode double render,
// Suspense unmount/remount, HMR). Doing the session setup in a sibling
// component sidesteps that — the bootstrap effect runs in its own
// component instance with a stable hook count.
//
// The work itself is memoised in ensureTestModeSession() so that code which
// NEEDS the session before it can act — lib/org.ts, before it trusts an empty
// workspace list — awaits the same promise instead of racing this mount
// effect. That race is what cloned a junk "Test workspace" per cold page load.
//
// Renders nothing — pure side-effect. No-op in production posture.

import { useEffect } from "react";
import { isPublicTestMode } from "@/lib/testMode";
import { ensureTestModeSession } from "@/lib/testModeSession";

export function TestModeSessionBoot() {
  useEffect(() => {
    if (!isPublicTestMode) return;
    void ensureTestModeSession();
  }, []);

  return null;
}
