// Wraps internal pages. Redirects unauthenticated visitors to /login with a
// `next=` query param so post-auth navigation can return them to the page
// they were trying to reach.
//
// "Authenticated" means: signed in via Supabase. Demo mode was removed in
// the demo-strip pass — there's only one path into the app now (real auth).
//
// On top of auth, the guard also enforces *onboarding completion*: a signed-in
// user whose active org doesn't yet have an industry_key set is bounced to
// /onboarding. This happens once per signup, then never again.

import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useActiveOrg } from "@/lib/org";
import { isPublicTestMode } from "@/lib/testMode";
import { AppLoader } from "@/components/cfo/AppLoader";

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
  const { org, loading: orgLoading, needsOnboarding } = useActiveOrg();
  const location = useLocation();
  /* eslint-enable react-hooks/rules-of-hooks */

  // Refresh / cold visit: hold the screen with the branded loader rather than
  // an empty page (2026-07-26 per operator). Both waits below gate every
  // authed route, so there is genuinely nothing to render until they land.
  if (status === "loading") {
    return <AppLoader label="Signing you in…" />;
  }

  if (!isAuthenticated) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  // Onboarding lives on /workspace now (the setup wizard there) — the
  // standalone /onboarding page was removed 2026-07-23. Don't bounce when
  // already on /workspace, that would loop.
  //
  // /chat is exempt too (2026-07-26 per operator: "make Ask CFO AI available
  // always"). It's the one surface that is fully useful with no workspace
  // data — open-domain finance/accounting/strategy Q&A — and it runs on a
  // Supabase Edge Function, so it depends on nothing the onboarding wizard
  // sets up. Exempting it can't loop: it's a leaf route, not a redirect target.
  const onWorkspaceRoute =
    location.pathname === "/workspace" || location.pathname === "/chat";

  if (!onWorkspaceRoute) {
    if (orgLoading) {
      return <AppLoader />;
    }
    if (needsOnboarding && org) {
      return <Navigate to="/workspace" replace />;
    }
  }

  return <>{children}</>;
}
