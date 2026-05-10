import { useEffect } from "react";
import { ThemeProvider } from "@/theme";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Landing from "./pages/cfo/Landing";
import Login from "./pages/cfo/Login";
import Signup from "./pages/cfo/Signup";
import Pricing from "./pages/cfo/Pricing";
// Dashboard is now the unified financial-analysis surface (was
// /dashboard). The standalone /dashboard page from the previous
// round was deleted; its Overview content survives as Dashboard's Overview
// tab inside FinancialStatements.tsx.
import Dashboard from "./pages/cfo/FinancialStatements";
import UploadPage from "./pages/cfo/Upload";
import Cash from "./pages/cfo/Cash";
import Profit from "./pages/cfo/Profit";
import Decisions from "./pages/cfo/Decisions";
import Products from "./pages/cfo/Products";
import Alerts from "./pages/cfo/Alerts";
import Settings from "./pages/cfo/Settings";
import Onboarding from "./pages/cfo/Onboarding";
import NotFound from "./pages/NotFound";
import { heartbeatIfIdentified } from "@/lib/identity";
import { AuthProvider } from "@/lib/auth";
import { AuthGuard } from "@/components/cfo/AuthGuard";
import { ErrorBoundary } from "@/components/cfo/ErrorBoundary";

const queryClient = new QueryClient();

function App() {
  useEffect(() => {
    heartbeatIfIdentified();
    const t = window.setInterval(heartbeatIfIdentified, 5 * 60 * 1000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <ErrorBoundary>
    <ThemeProvider defaultTheme="system" enableSystem>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/login" element={<Login />} />
              <Route path="/signup" element={<Signup />} />
              {/* /pricing is public — but signed-in users see it as the
                  upgrade picker. Used as the post-signup destination too. */}
              <Route path="/pricing" element={<Pricing />} />

              {/* Onboarding: industry pick + workspace name. Reached after
                  signup or when AuthGuard sees an org without industry_key. */}
              <Route path="/onboarding" element={<AuthGuard><Onboarding /></AuthGuard>} />

              {/* Authenticated app — gated by AuthGuard. Visiting any of these
                  paths without sign-in OR demo-mode redirects to "/". */}
              <Route path="/dashboard" element={<AuthGuard><Dashboard /></AuthGuard>} />
              <Route path="/upload" element={<AuthGuard><UploadPage /></AuthGuard>} />
              <Route path="/cash" element={<AuthGuard><Cash /></AuthGuard>} />
              <Route path="/profit" element={<AuthGuard><Profit /></AuthGuard>} />
              <Route path="/decisions" element={<AuthGuard><Decisions /></AuthGuard>} />
              <Route path="/products" element={<AuthGuard><Products /></AuthGuard>} />
              <Route path="/alerts" element={<AuthGuard><Alerts /></AuthGuard>} />
              <Route path="/settings" element={<AuthGuard><Settings /></AuthGuard>} />

              {/* UNIFY: legacy paths redirect to /dashboard. The query string
                  (?period=, ?tab=) carries through so deep links survive. */}
              <Route path="/financial-statements" element={<RedirectPreservingQuery to="/dashboard" />} />
              <Route path="/today"                element={<RedirectPreservingQuery to="/dashboard" />} />
              <Route path="/app"                  element={<RedirectPreservingQuery to="/dashboard" />} />
              <Route path="/briefing"             element={<RedirectPreservingQuery to="/dashboard" />} />
              {/* /reports + /invoices map onto specific Dashboard tabs. */}
              <Route path="/reports"   element={<RedirectPreservingQuery to="/dashboard" tab="export" />} />
              <Route path="/invoices"  element={<RedirectPreservingQuery to="/dashboard" tab="invoices" />} />

              <Route path="/configuration" element={<Navigate to="/settings" replace />} />
              <Route path="/skus" element={<Navigate to="/products" replace />} />
              <Route path="/category/:slug" element={<Navigate to="/products" replace />} />
              <Route path="/history" element={<Navigate to="/decisions?status=done" replace />} />
              <Route path="/anchors" element={<Navigate to="/products?bucket=PROTECT" replace />} />

              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
    </ErrorBoundary>
  );
}

/**
 * Preserves the active query string when redirecting between merged routes.
 * /dashboard?period=eei → /dashboard?period=eei
 * /reports?period=eei → /dashboard?tab=export&period=eei (when `tab` provided)
 *
 * Navigate from react-router-dom does NOT carry the query through by default,
 * so deep links from the old paths would otherwise lose their period context.
 */
function RedirectPreservingQuery({ to, tab }: { to: string; tab?: string }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  if (tab) params.set("tab", tab);
  const qs = params.toString();
  return <Navigate to={qs ? `${to}?${qs}` : to} replace />;
}

export default App;
