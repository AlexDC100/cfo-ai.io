// Wraps internal pages. Redirects unauthenticated visitors to /login with a
// `next=` query param so post-auth navigation can return them to the page
// they were trying to reach.
//
// "Authenticated" means: signed in via Supabase. Demo mode was removed in
// the demo-strip pass — there's only one path into the app now (real auth).
//
// Workspace posture (2026-08-02): the guard no longer walls the app behind
// onboarding. The signup DB trigger creates a workspace automatically;
// org.ts auto-creates one for true-zero accounts; the ONLY redirect left is
// "no live workspace but archived ones exist" → /workspace (Restore/Create).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation } from "react-router-dom";
import { RotateCw } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useActiveOrg } from "@/lib/org";
import { isPublicTestMode } from "@/lib/testMode";
import { AppLoader } from "@/components/cfo/AppLoader";

/** How long "Signing you in…" may spin before the loader says why it might
 *  be stuck and offers a reload. */
export const SIGNING_IN_HINT_AFTER_MS = 12_000;

/**
 * "Signing you in…" — and, past SIGNING_IN_HINT_AFTER_MS, what to do about it.
 *
 * Reading the session takes supabase-js's auth Web Lock, which EVERY tab of
 * the origin shares. A tab that floods that lock (2026-09-26: 35,066 queued
 * requests from one looping tab) left every other tab on this spinner with no
 * way to tell it apart from a slow network. After 12 s it says so and offers
 * the reload — never an endless spinner.
 */
export function SigningInLoader() {
  const { t } = useTranslation();
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setStuck(true), SIGNING_IN_HINT_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <AppLoader label={t("auth.signing_in")}>
      {stuck && (
        <div className="flex flex-col items-center gap-3" data-testid="signing-in-stuck">
          <p className="max-w-[300px] text-center text-[12.5px] leading-relaxed text-ink-soft">
            {t("auth.still_signing_in")}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            data-testid="signing-in-reload"
            className="inline-flex h-9 items-center gap-2 rounded-md bg-brand px-4 text-[13px] font-medium text-paper transition-colors hover:bg-brand-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCw size={14} strokeWidth={2} aria-hidden />
            {t("auth.reload")}
          </button>
        </div>
      )}
    </AppLoader>
  );
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  // PUBLIC_TEST_MODE — open-access posture. Every gated route renders
  // for any visitor without checking session state. AuthProvider injects
  // a synthetic test user so downstream `useAuth()` consumers see a
  // signed-in identity. The real Supabase session for FE → Supabase
  // calls is set up by <TestModeSessionBoot /> in App.tsx.
  if (isPublicTestMode) {
    return <>{children}</>;
  }

  // isPublicTestMode is a BUILD-TIME constant — the early return above is
  // taken either always or never for a given bundle, so hook order is in
  // fact stable across renders. Same deliberate pattern as AuthProvider.
  /* eslint-disable react-hooks/rules-of-hooks */
  const { status, isAuthenticated } = useAuth();
  const { orgs, archived, loading: orgLoading, loadError } = useActiveOrg();
  const location = useLocation();
  /* eslint-enable react-hooks/rules-of-hooks */

  // Refresh / cold visit: hold the screen with the branded loader rather than
  // an empty page (2026-07-26 per operator). Both waits below gate every
  // authed route, so there is genuinely nothing to render until they land.
  if (status === "loading") {
    return <SigningInLoader />;
  }

  if (!isAuthenticated) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  // /workspace hosts the setup wizard + restore shelf; /chat is exempt
  // (2026-07-26 per operator: "make Ask CFO AI available always") — it's fully
  // useful with no workspace data and runs on a Supabase Edge Function.
  // Exempting them can't loop: they're leaf routes, not redirect targets.
  const onWorkspaceRoute =
    location.pathname === "/workspace" || location.pathname === "/chat";

  if (!onWorkspaceRoute) {
    if (orgLoading) {
      return <AppLoader />;
    }
    // 2026-08-02 (workspace-flow fix): the old gate here bounced EVERY route
    // to /workspace while the active org had no industry_key — which forced
    // each fresh signup through the full 3-step wizard before ever seeing the
    // dashboard, even though the signup trigger had already created a working
    // workspace. Industry only matters for benchmarking, and the Benchmark
    // page prompts for it in context — so the wall is gone; onboarding is
    // optional, not a gate.
    //
    // The one state that still redirects: NO live workspace but ARCHIVED ones
    // exist. That user deliberately deleted their last workspace, so
    // auto-creating a fresh one (org.ts's ensure-default handles the true-zero
    // case) would race their intent to Restore — send them to /workspace,
    // where both Restore and Create are one click. A list-fetch ERROR never
    // redirects (the user may have workspaces; org.ts exposes loadError and
    // the surfaces render a retry state instead).
    if (!loadError && orgs.length === 0 && archived.length > 0) {
      return <Navigate to="/workspace" replace />;
    }
  }

  return <>{children}</>;
}
