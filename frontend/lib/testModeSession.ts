// Shared, awaitable bootstrap for the FE Supabase session in PUBLIC_TEST_MODE.
//
// In test mode AuthProvider reports `signed_in` SYNCHRONOUSLY (a synthetic
// identity — Supabase is never consulted) while the REAL Supabase session
// arrives asynchronously from GET /api/test-mode/session. Anything that reads
// `supabase.auth.getSession()` inside that window sees "no session" even
// though the app believes it is signed in.
//
// That mismatch is what produced the junk-workspace incidents: fetchOrgsForUser
// ran before the session landed, `list_workspaces` was never called, the empty
// result read as a TRUE ZERO, and ensure-default cloned a fresh "Test
// workspace" on every cold page load (247 orgs by 2026-08-04; 8,498 by
// 2026-09-01).
//
// This module memoises ONE establish-session attempt so every consumer
// (TestModeSessionBoot for the app at large, lib/org.ts before it trusts an
// empty workspace list) awaits the SAME promise instead of racing it. A failed
// attempt clears the memo so the next caller retries rather than caching a
// dead end — during local dev the engine simply may not be up yet.

import { getSupabase } from "@/lib/supabase";
import { isPublicTestMode } from "@/lib/testMode";

let sessionPromise: Promise<boolean> | null = null;

/**
 * Resolves `true` once the supabase-js client holds a real session for the
 * synthetic test user; `false` when one can't be established (engine down,
 * Supabase env missing). Instantly `false` outside test mode.
 */
export function ensureTestModeSession(): Promise<boolean> {
  if (!isPublicTestMode) return Promise.resolve(false);
  if (!sessionPromise) {
    sessionPromise = establish()
      .catch((e) => {
        console.error("[test-mode] session setup failed:", e);
        return false;
      })
      .then((ok) => {
        // Memoise success only — a failed attempt must stay retryable.
        if (!ok) sessionPromise = null;
        return ok;
      });
  }
  return sessionPromise;
}

/** Test-only: drop the memo so each case starts from a cold client. */
export function resetTestModeSession(): void {
  sessionPromise = null;
}

async function establish(): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) {
    // Supabase env not configured at build time. The synthetic identity still
    // works for BE-routed calls; direct FE → Supabase calls won't.
    return false;
  }
  // A previous call — or a session persisted by an earlier page load — may
  // already have signed this client in.
  const { data: existing } = await supabase.auth.getSession();
  if (existing.session?.user) return true;

  const res = await fetch("/api/test-mode/session");
  if (!res.ok) {
    console.warn("[test-mode] /api/test-mode/session returned", res.status);
    return false;
  }
  const data = (await res.json()) as { access_token: string; refresh_token: string };
  const { error } = await supabase.auth.setSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
  });
  if (error) {
    console.error("[test-mode] setSession returned error:", error);
    return false;
  }
  // eslint-disable-next-line no-console
  console.log("[test-mode] Supabase session active.");
  return true;
}
