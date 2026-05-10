// Wraps internal pages. Redirects unauthenticated visitors to /login with a
// `next=` query param so post-auth navigation can return them to the page
// they were trying to reach.
//
// "Authenticated" means: signed in via Supabase OR running in demo mode.
// While the auth context is still hydrating (loading), we render nothing
// to avoid a flash of the redirect.

import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { status, isAuthenticated } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    // Brief loading window — render the same dark canvas the landing uses
    // so the transition is invisible when the user lands authed.
    return <div className="min-h-screen bg-[#05070A]" aria-hidden />;
  }

  if (!isAuthenticated) {
    // Preserve the path + search the user was trying to reach so AuthCard
    // can deep-link back after sign-in (e.g. shareable /dashboard
    // links from a teammate land on /login?next=/dashboard).
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  return <>{children}</>;
}
