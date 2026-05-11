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
  /** No-op — demo mode was removed. Kept on the interface so legacy callers
   *  don't break; the body navigates to the real /signup flow if invoked. */
  enterDemo: () => void;
  exitDemo: () => void;
}

const AuthContext = createContext<(AuthState & AuthActions) | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
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
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
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
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: Object.keys(meta).length > 0 ? meta : undefined,
        emailRedirectTo: window.location.origin,
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
    enterDemo,
    exitDemo,
  }), [status, session, user, displayName, initials, workspaceLabel, companyName, isAuthenticated, signUp, signIn, signOut, enterDemo, exitDemo]);

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
