// Wraps internal pages. Redirects unauthenticated visitors to /login with a
// `next=` query param so post-auth navigation can return them to the page
// they were trying to reach.
//
// "Authenticated" means: signed in via Supabase OR running in demo mode.
// While the auth context is still hydrating (loading), we render nothing
// to avoid a flash of the redirect.
//
// On top of auth, the guard also enforces *onboarding completion*: a signed-in
// user whose active org doesn't yet have an industry_key set is bounced to
// /onboarding. This happens once per signup, then never again.

import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useActiveOrg } from "@/lib/org";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { status, isAuthenticated, demoActive } = useAuth();
  const { org, loading: orgLoading, needsOnboarding } = useActiveOrg();
  const location = useLocation();

  if (status === "loading") {
    return <div className="min-h-screen bg-[#05070A]" aria-hidden />;
  }

  if (!isAuthenticated) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  // Demo mode skips onboarding (no real org to configure).
  // The /onboarding route itself shouldn't bounce to /onboarding — that loops.
  const onOnboardingRoute = location.pathname === "/onboarding";

  if (!demoActive && !onOnboardingRoute) {
    if (orgLoading) {
      return <div className="min-h-screen bg-[#05070A]" aria-hidden />;
    }
    if (needsOnboarding && org) {
      return <Navigate to="/onboarding" replace />;
    }
  }

  return <>{children}</>;
}
