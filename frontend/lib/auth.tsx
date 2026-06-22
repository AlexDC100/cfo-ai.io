// Auth context + hook backed by Supabase Auth.
//
// Wraps the entire app via <AuthProvider> in main.tsx. Components read the
// current session via useAuth(); auth actions (sign in / sign up / sign out)
// come back through the same hook.
//
// When Supabase isn't configured, useAuth() returns a "disabled" state and
// every action returns a friendly error so callers can fall back gracefully.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session, User, AuthError } from "@supabase/supabase-js";
import { getSupabase, supabaseEnabled } from "@/lib/supabase";
import { queryClient } from "@/lib/queryClient";
import {
  isPublicTestMode,
  TEST_USER_ID,
  TEST_USER_EMAIL,
  TEST_DISPLAY_NAME,
  TEST_WORKSPACE_LABEL,
} from "@/lib/testMode";

type AuthStatus = "loading" | "signed_out" | "signed_in" | "disabled";

const WORKSPACE_KEY = "cfoai_workspace";

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  user: User | null;
  displayName: string | null;
  initials: string | null;
  /** Workspace label shown in the app shell — company name when signed in. */
  workspaceLabel: string | null;
  companyName: string | null;
  /** Demo mode is removed; field retained for source compat — always false. */
  demoActive: boolean;
  /** True when the user has a real Supabase session. */
  isAuthenticated: boolean;
}

export interface AuthActions {
  signUp: (input: {
    email: string;
    password: string;
    displayName?: string;
    companyName?: string;
    industryKey?: string;
    industryDisplayName?: string;
  }) => Promise<{ error: AuthError | null; needsConfirmation: boolean }>;
  signIn: (input: { email: string; password: string }) => Promise<{ error: AuthError | null }>;
  signOut: () => Promise<{ error: AuthError | null }>;
  /** Issue #7 (2026-06-16) — OAuth sign-in via Supabase Auth providers.
   *  Currently wired for Google + Apple. Returns immediately with the
   *  provider redirect URL; the browser navigates away and Supabase
   *  redirects back to `/auth/callback` once the provider completes.
   *  Operator-side requirement: provider must be enabled in Supabase
   *  Dashboard → Authentication → Providers, with OAuth client ID/secret
   *  registered at the provider's developer console. Without that,
   *  Supabase returns "Unsupported provider" — the AuthCard surfaces a
   *  human-friendly fallback message in that case. */
  signInWithOAuth: (provider: "google" | "apple") => Promise<{ error: AuthError | null }>;
  /** No-op — demo mode was removed. Kept on the interface so legacy callers
   *  don't break; the body navigates to the real /signup flow if invoked. */
  enterDemo: () => void;
  exitDemo: () => void;
}

const AuthContext = createContext<(AuthState & AuthActions) | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // PUBLIC_TEST_MODE — open-access posture. Return a synthetic test user
  // immediately; never touch Supabase. Downstream components see a
  // signed-in identity (`isAuthenticated=true`, `user.id=TEST_USER_ID`,
  // `workspaceLabel="Test workspace"`) and behave as if a real user is
  // signed in. The BE sees the same TEST_USER_ID via its own bypass
  // (see `src/engine/api/_test_mode.py`). See `src/lib/testMode.ts`.
  //
  // Critically: we early-return BEFORE calling `useState` for the
  // session-tracking machinery, because in test mode we never receive
  // an `onAuthStateChange` event from Supabase (we never initialize
  // the client). The synthetic identity below is static for the
  // session — the test user doesn't sign in or out at runtime.
  if (isPublicTestMode) {
    // Synthetic identity for the test workspace. The real Supabase
    // session — needed for direct FE → Supabase calls (Storage uploads,
    // INSERT into documents, RLS-scoped selects) — is set up
    // asynchronously by <TestModeSessionBoot /> mounted in App.tsx.
    // It calls `supabase.auth.setSession(...)` with the JWT minted by
    // the BE's GET /api/test-mode/session endpoint.
    //
    // Critically: we early-return BEFORE calling any hooks so this
    // block has zero hook calls. The conditional-hooks pattern is
    // technically OK with a build-time constant but trips React's
    // runtime hooks counter in some edge cases (Strict Mode double
    // render, Suspense fallback unmount/remount). Keeping this block
    // hooks-free sidesteps the whole problem.
    const testUser = {
      id: TEST_USER_ID,
      email: TEST_USER_EMAIL,
      user_metadata: {
        display_name: TEST_DISPLAY_NAME,
        company_name: TEST_WORKSPACE_LABEL,
      },
      app_metadata: {},
      aud: "authenticated",
      created_at: new Date(0).toISOString(),
    } as unknown as User;

    const value: AuthState & AuthActions = {
      status: "signed_in",
      session: null,
      user: testUser,
      displayName: TEST_DISPLAY_NAME,
      initials: "TM",
      workspaceLabel: TEST_WORKSPACE_LABEL,
      companyName: TEST_WORKSPACE_LABEL,
      demoActive: false,
      isAuthenticated: true,
      signUp: async () => ({ error: testModeUnavailable(), needsConfirmation: false }),
      signIn: async () => ({ error: testModeUnavailable() }),
      signOut: async () => ({ error: null }),
      // Issue #7 — OAuth no-op in test mode (no provider redirect possible
      // without a real Supabase project). Surface the same testModeUnavailable
      // error so the AuthCard renders a consistent fallback.
      signInWithOAuth: async () => ({ error: testModeUnavailable() }),
      enterDemo: () => { /* test mode IS the demo */ },
      exitDemo: () => { /* no-op */ },
    };
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
  }

  const supabase = getSupabase();
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>(
    supabaseEnabled ? "loading" : "disabled",
  );

  // Hydrate the current session on mount + subscribe to changes.
  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setStatus(data.session ? "signed_in" : "signed_out");
    });
    // Track the prior auth identity so we can detect *transitions* (signOut,
    // user-switch) and clear the query cache exactly when ownership changes.
    // Without this guard, every onAuthStateChange tick would clear the cache —
    // including TOKEN_REFRESHED + USER_UPDATED which fire periodically and
    // would invalidate the user's perfectly good cached data mid-session.
    let priorUserId: string | null = null;
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      const nextUserId = s?.user?.id ?? null;

      // B-H5: clear the react-query cache when ownership changes hands.
      // Three transitions matter:
      //   · signed-in → signed-out: prevent leaking the previous user's
      //     dashboard data to the next person on this device.
      //   · signed-in user A → signed-in user B: same risk; user-switch
      //     on shared devices is rare but real.
      //   · SIGNED_OUT event with no prior user: no-op (first-ever boot).
      // The narrow `priorUserId !== nextUserId` check makes us a no-op on
      // TOKEN_REFRESHED + USER_UPDATED + INITIAL_SESSION (same user across
      // those events), so a long-running tab doesn't dump its cache every
      // hour when Supabase rotates the access_token.
      if (priorUserId !== null && priorUserId !== nextUserId) {
        queryClient.clear();
      } else if (event === "SIGNED_OUT" && priorUserId !== null) {
        // Defensive belt-and-braces: SIGNED_OUT with a prior user id should
        // always clear, even if the user-id-equality check somehow missed.
        queryClient.clear();
      }
      priorUserId = nextUserId;

      setSession(s);
      setStatus(s ? "signed_in" : "signed_out");
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  const user = session?.user ?? null;
  const displayName = useMemo(() => extractDisplayName(user), [user]);
  const companyName = useMemo(() => extractCompanyName(user), [user]);
  const initials = useMemo(() => extractInitials(displayName, user?.email), [displayName, user]);
  const workspaceLabel = useMemo(() => {
    if (companyName) return companyName;
    if (displayName) return `${displayName}'s workspace`;
    return null;
  }, [companyName, displayName]);

  const signUp = useCallback<AuthActions["signUp"]>(async ({ email, password, displayName, companyName, industryKey, industryDisplayName }) => {
    if (!supabase) {
      return { error: disabledError(), needsConfirmation: false };
    }
    // Bootstrap trigger (handle_new_user_v2 in supabase/schema_phase3.sql)
    // reads these `pending_*` keys from raw_user_meta_data to seed the user's
    // first organization + membership atomically with the auth.users insert.
    const meta: Record<string, string> = {};
    if (displayName) meta.display_name = displayName;
    if (companyName) {
      meta.company_name = companyName;
      meta.pending_org_name = companyName;
    }
    if (industryKey) meta.pending_industry_key = industryKey;
    if (industryDisplayName) meta.pending_industry_display = industryDisplayName;
    // emailRedirectTo MUST match a route that:
    //   (a) is reachable on the deployed origin (whitelisted under Supabase
    //       → Auth → URL Configuration → Redirect URLs), and
    //   (b) actually completes the SDK's token exchange instead of leaving
    //       the user on a generic landing page with a long token-laden URL.
    // /auth/callback satisfies both — see src/pages/cfo/AuthCallback.tsx.
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: Object.keys(meta).length > 0 ? meta : undefined,
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    // Mirror the workspace label into localStorage so the app shell can
    // show it even before the next page render reads user_metadata.
    if (companyName) {
      try { localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ name: companyName })); } catch { /* quota */ }
    }
    const needsConfirmation = !error && !!data.user && !data.session;
    return { error, needsConfirmation };
  }, [supabase]);

  const signIn = useCallback<AuthActions["signIn"]>(async ({ email, password }) => {
    if (!supabase) return { error: disabledError() };
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  }, [supabase]);

  // Issue #7 (2026-06-16) — OAuth sign-in via Supabase Auth.
  // Provider must be enabled in Supabase Dashboard → Authentication →
  // Providers, with Google OAuth client ID/secret OR Apple Services ID
  // registered. emailRedirectTo points at the existing /auth/callback
  // route that the email-confirmation flow already uses, so token
  // exchange happens in one place.
  const signInWithOAuth = useCallback<AuthActions["signInWithOAuth"]>(async (provider) => {
    if (!supabase) return { error: disabledError() };
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    return { error };
  }, [supabase]);

  const signOut = useCallback<AuthActions["signOut"]>(async () => {
    try {
      localStorage.removeItem(WORKSPACE_KEY);
      // Clean up any legacy demo flags from older builds so a returning
      // user with a stale localStorage doesn't accidentally re-enable demo.
      localStorage.removeItem("cfoai_user");
    } catch { /* ignore */ }
    if (!supabase) return { error: null };
    const { error } = await supabase.auth.signOut();
    return { error };
  }, [supabase]);

  // Demo mode was removed in this pass. The interface keeps stubs so any
  // remaining caller doesn't break; if invoked they no-op (and a returning
  // user with a stale demo flag in localStorage gets cleared on next signOut).
  const enterDemo = useCallback(() => { /* removed */ }, []);
  const exitDemo  = useCallback(() => { /* removed */ }, []);

  const demoActive = false;
  const isAuthenticated = status === "signed_in";

  const value = useMemo<AuthState & AuthActions>(() => ({
    status,
    session,
    user,
    displayName,
    initials,
    workspaceLabel,
    companyName,
    demoActive,
    isAuthenticated,
    signUp,
    signIn,
    signOut,
    signInWithOAuth,
    enterDemo,
    exitDemo,
  }), [status, session, user, displayName, initials, workspaceLabel, companyName, isAuthenticated, signUp, signIn, signOut, signInWithOAuth, enterDemo, exitDemo]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState & AuthActions {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth() called outside <AuthProvider>");
  }
  return ctx;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function disabledError(): AuthError {
  // Supabase returns AuthError instances; we mimic the shape for parity.
  return {
    name: "AuthError",
    message: "Sign-in is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.",
    status: 0,
  } as AuthError;
}

function testModeUnavailable(): AuthError {
  // Returned by signUp/signIn when the app is in PUBLIC_TEST_MODE.
  // Should never reach the user — login/signup routes redirect to
  // /dashboard before any form submission happens — but provides a
  // safe fallback if a caller bypasses the redirect.
  return {
    name: "AuthError",
    message: "This deployment is in TEST MODE. Sign-in is disabled; everyone shares the test workspace.",
    status: 0,
  } as AuthError;
}

function extractDisplayName(user: User | null): string | null {
  if (!user) return null;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name = meta.display_name ?? meta.full_name ?? meta.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  if (user.email) return user.email.split("@")[0];
  return null;
}

function extractCompanyName(user: User | null): string | null {
  if (!user) return null;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const name = meta.company_name ?? meta.organization;
  if (typeof name === "string" && name.trim()) return name.trim();
  return null;
}

function extractInitials(displayName: string | null, email?: string | null): string | null {
  const source = displayName ?? email ?? "";
  if (!source) return null;
  const parts = source.split(/[\s.@_-]+/).filter(Boolean);
  if (parts.length === 0) return source.slice(0, 1).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
