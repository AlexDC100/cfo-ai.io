// Fire-and-forget bootstrap for the FE Supabase session in PUBLIC_TEST_MODE.
//
// Mounted once in App.tsx alongside <TestModeBanner />. On mount it fetches
// the BE-minted Supabase access_token + refresh_token from
// /api/test-mode/session and calls supabase.auth.setSession(...).
//
// Why this lives in a separate component instead of inside AuthProvider:
// AuthProvider's test-mode branch is intentionally hooks-free (an early
// return before any useState/useEffect call) so the "rules of hooks"
// can't trip on conditional-render edge cases (Strict Mode double render,
// Suspense unmount/remount, HMR). Doing the session setup in a sibling
// component sidesteps that — the bootstrap effect runs in its own
// component instance with a stable hook count.
//
// Renders nothing — pure side-effect. Returns null in production posture.
//
// Race-condition note: there is a brief window after mount where the FE
// supabase-js client has no session but the dashboard is already rendered.
// If a visitor uploads a file in that window (~hundreds of ms), the
// upload may 401. In practice the visitor takes several seconds to drag
// a file in, so the window is well-covered. If it ever proves
// insufficient, the upload-enqueue path could `await
// supabase.auth.getSession()` first, but that's premature optimisation.

import { useEffect } from "react";
import { getSupabase } from "@/lib/supabase";
import { isPublicTestMode } from "@/lib/testMode";

export function TestModeSessionBoot() {
  useEffect(() => {
    if (!isPublicTestMode) return;
    let cancelled = false;

    async function setup() {
      const supabase = getSupabase();
      if (!supabase) {
        // Supabase env not configured at build time. Test mode
        // synthetic identity still works for BE-routed calls; direct
        // FE → Supabase calls won't.
        return;
      }
      try {
        const res = await fetch("/api/test-mode/session");
        if (!res.ok) {
          console.warn(
            "[test-mode] /api/test-mode/session returned",
            res.status,
          );
          return;
        }
        const data = (await res.json()) as {
          access_token: string;
          refresh_token: string;
        };
        if (cancelled) return;
        const { error } = await supabase.auth.setSession({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
        });
        if (error) {
          console.error("[test-mode] setSession returned error:", error);
        } else {
          // eslint-disable-next-line no-console
          console.log("[test-mode] Supabase session active.");
        }
      } catch (e) {
        console.error("[test-mode] session setup failed:", e);
      }
    }

    void setup();
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
