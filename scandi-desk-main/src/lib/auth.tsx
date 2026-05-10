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

const DEMO_KEY = "cfoai_user";
const WORKSPACE_KEY = "cfoai_workspace";

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  user: User | null;
  displayName: string | null;
  initials: string | null;
  /** Workspace label shown in the app shell — company name when signed in, "Demo workspace" in demo mode. */
  workspaceLabel: string | null;
  companyName: string | null;
  /** True when the user is browsing in demo mode without real auth. */
  demoActive: boolean;
  /** Returns true when either signed in (Supabase) or in demo mode. */
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
  /** Enter demo mode — bypasses Supabase auth, persists across reloads. */
  enterDemo: () => void;
  /** Exit demo mode — clears the demo flag from localStorage. */
  exitDemo: () => void;
}

const AuthContext = createContext<(AuthState & AuthActions) | null>(null);

function readDemoActive(): boolean {
  try { return localStorage.getItem(DEMO_KEY) !== null; } catch { return false; }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const supabase = getSupabase();
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>(
    supabaseEnabled ? "loading" : "disabled",
  );
  const [demoActive, setDemoActive] = useState<boolean>(readDemoActive);

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

  // Sync demo state across tabs.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === DEMO_KEY) setDemoActive(readDemoActive());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const user = session?.user ?? null;
  const displayName = useMemo(() => extractDisplayName(user), [user]);
  const companyName = useMemo(() => extractCompanyName(user), [user]);
  const initials = useMemo(() => extractInitials(displayName, user?.email), [displayName, user]);
  const workspaceLabel = useMemo(() => {
    if (companyName) return companyName;
    if (demoActive && status !== "signed_in") return "Demo workspace";
    if (displayName) return `${displayName}'s workspace`;
    return null;
  }, [companyName, demoActive, status, displayName]);

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
    // Always clear demo state on sign-out so the auth-gate redirects cleanly.
    try {
      localStorage.removeItem(DEMO_KEY);
      localStorage.removeItem(WORKSPACE_KEY);
    } catch { /* ignore */ }
    setDemoActive(false);
    if (!supabase) return { error: null };
    const { error } = await supabase.auth.signOut();
    return { error };
  }, [supabase]);

  const enterDemo = useCallback(() => {
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify({ mode: "demo", since: new Date().toISOString() }));
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ name: "Demo workspace" }));
    } catch { /* quota — fine, demo state is best-effort */ }
    setDemoActive(true);
  }, []);

  const exitDemo = useCallback(() => {
    try {
      localStorage.removeItem(DEMO_KEY);
      localStorage.removeItem(WORKSPACE_KEY);
    } catch { /* ignore */ }
    setDemoActive(false);
  }, []);

  const isAuthenticated = status === "signed_in" || demoActive;

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
  }), [status, session, user, displayName, initials, workspaceLabel, companyName, demoActive, isAuthenticated, signUp, signIn, signOut, enterDemo, exitDemo]);

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
