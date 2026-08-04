import { lazy, Suspense, useEffect, useLayoutEffect } from "react";
import "@/i18n"; // i18n bootstrap — must run before any component imports t()
import { ThemeProvider } from "@/theme";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CurrencyProvider } from "@/stores/currency";
import { useHtmlLangSync } from "@/hooks/useHtmlLangSync";
import { PopoverStackProvider } from "@/components/learning/PopoverStackProvider";
import { PopoverStackRenderer } from "@/components/learning/PopoverStackRenderer";
import { MetricGlossaryDrawer } from "@/components/learning/MetricGlossaryDrawer";
import { LearningModeProvider } from "@/stores/learningMode";
import { LanguageSwitchOverlay } from "@/components/LanguageSwitchOverlay";
import { PeriodSwitchOverlay } from "@/components/cfo/PeriodSwitchOverlay";
import "@/styles/learning.css";

// ──────────────────────────────────────────────────────────────────────
// Code splitting policy (perf pass — 2026-05-26)
//
// Before: every page was a static import at the top of this file. Result:
// the main bundle was 744 KB gzipped, every visitor — including someone
// who never signs in — downloaded Dashboard + Products + Markets + every
// chart library on first paint. Mobile 4G users waited 2-5s on JS alone.
//
// Policy now:
//   · SYNC (eager)  — Landing, Login, Signup, Pricing, Roadmap, Contact,
//                     NotFound. These are the LCP-critical paths a fresh
//                     visitor sees first; loading them lazily costs an
//                     extra round-trip and hurts more than it saves.
//   · LAZY          — everything behind AuthGuard, plus PublicCompany*
//                     (the auth-optional public-companies hub). These
//                     load on navigation; the user sees a skeleton for
//                     a single network round-trip, then the page mounts.
//
// Suspense fallback (<RouteFallback />) deliberately matches the
// AppShell layout (sidebar visible, content-area skeleton) so the
// transition between routes feels instant — no layout shift, no flash
// of empty screen.
//
// Each lazy() call becomes its own JS chunk in dist/assets/. Vite emits
// them with content-hash filenames + immutable Cache-Control, so once
// a chunk is fetched it sticks in the browser cache for a year.
// ──────────────────────────────────────────────────────────────────────

// LCP-critical (sync) — these load on `/`, `/login`, `/signup`, `/pricing`
import Landing from "./pages/cfo/Landing";
import Login from "./pages/cfo/Login";
import Signup from "./pages/cfo/Signup";
// AuthCallback is the destination Supabase redirects to after a user clicks
// the email verification link. It's tiny (~5 KB) and must be on the synchronous
// chunk because the email link lands here cold — if it lazy-loaded, the user
// would see a blank flash while React fetches the chunk, *then* the SDK does
// the token exchange. Inlining it makes the verify→onboarding hand-off feel
// instant.
import AuthCallback from "./pages/cfo/AuthCallback";
import Pricing from "./pages/cfo/Pricing";
import RoadmapPage from "./pages/cfo/RoadmapPage";
import ContactSalesPage from "./pages/cfo/ContactSalesPage";
import NotFound from "./pages/NotFound";

// Lazy (auth-gated) — the heavy authenticated app. Each is its own chunk.
// Dashboard is the unified financial-analysis surface (was /dashboard).
// The previously-deleted standalone /dashboard's Overview content lives
// inside FinancialStatements.tsx's Overview tab.
const Dashboard = lazy(() => import("./pages/cfo/FinancialStatements"));
const Workspace = lazy(() => import("./pages/cfo/Workspace"));
const Decisions = lazy(() => import("./pages/cfo/Decisions"));
const Products = lazy(() => import("./pages/cfo/Products"));
// F6.0.5 — Scenario planning / what-if (/dashboard/scenarios).
const Scenarios = lazy(() => import("./pages/cfo/Scenarios"));
// F6.0.1b — Budget vs Actual vs Last-Year variance (/dashboard/variance).
const Variance = lazy(() => import("./pages/cfo/Variance"));
const Alerts = lazy(() => import("./pages/cfo/Alerts"));
const Settings = lazy(() => import("./pages/cfo/Settings"));
const BenchmarkReport = lazy(() => import("./pages/cfo/BenchmarkReport"));
const ComprehensiveReport = lazy(() => import("./pages/cfo/ComprehensiveReport"));
const PeerComparisonReport = lazy(() => import("./pages/cfo/PeerComparisonReport"));
const MultiYearHistory = lazy(() => import("./pages/cfo/MultiYearHistory"));
// Settings without the app shell — reached from the landing account menu.
const AccountSettings = lazy(() => import("./pages/cfo/AccountSettings"));
const Chat = lazy(() => import("./pages/cfo/Chat"));
// NASDAQ-8's standalone US search page was removed 2026-07-23 (Romania-only
// coverage) — /dashboard/public/search now redirects to /public-companies.
// NASDAQ-9 — per-company dashboard at /dashboard/public/:ticker.
const PublicCompanyDashboard = lazy(() => import("./pages/cfo/PublicCompanyDashboard"));
// Public Company Intelligence hub — first-class module at /public-companies.
// Auth-optional (renders its own shell at runtime based on session state);
// still lazy-loaded because it pulls in StockPriceChart + universe table.
const PublicCompanyIntelligence = lazy(() => import("./pages/cfo/PublicCompanyIntelligence"));

import { PUBLIC_RECORDS_ENABLED, DECISIONS_ALERTS_ENABLED } from "./config/features";
import { heartbeatIfIdentified } from "@/lib/identity";
import { AuthProvider, useAuth } from "@/lib/auth";
import { AuthGuard } from "@/components/cfo/AuthGuard";
import { AppShell } from "@/components/cfo/AppShell";
import { ErrorBoundary } from "@/components/cfo/ErrorBoundary";
import { RouteErrorBoundary } from "@/components/cfo/RouteErrorBoundary";
import { LanguageSync } from "@/i18n/LanguageSync";
import { TestModeBanner } from "@/components/cfo/TestModeBanner";
import { TestModeSessionBoot } from "@/components/cfo/TestModeSessionBoot";
import { isPublicTestMode } from "@/lib/testMode";
// RouteFallback — the skeleton shown while a lazy chunk fetches. Mirrors
// the AppShell silhouette so the transition feels instant rather than
// a jarring flash of nothing.
import { RouteFallback } from "@/components/cfo/RouteFallback";

// The QueryClient lives in src/lib/queryClient.ts so non-component modules
// (auth context, navigation helpers) can call `.clear()` directly without
// piping the client through React Context. See that file for the tuning
// rationale (staleTime / gcTime / refetchOnMount).

function App() {
  // Keep <html lang> in sync with i18n.language. Screen readers, browser
  // spell-check, and translation services all key off this attribute;
  // without the sync they continue to think the page is in the language
  // shipped in index.html (typically "en") regardless of user choice.
  useHtmlLangSync();

  useEffect(() => {
    heartbeatIfIdentified();
    const t = window.setInterval(heartbeatIfIdentified, 5 * 60 * 1000);
    return () => window.clearInterval(t);
  }, []);

  // Warm every lazy page chunk in the background once the app is idle. The
  // specifiers below are IDENTICAL to the lazy() thunks, so they populate the
  // SAME module cache — after this runs, navigating to any tab resolves its
  // React.lazy() synchronously (no network wait, no visible fallback → the
  // content appears instantly). This does NOT hurt initial load: it fires
  // after first paint on idle, and failed prefetches fall back to on-demand.
  useEffect(() => {
    let cancelled = false;
    const warm = () => {
      if (cancelled) return;
      const jobs: Array<() => Promise<unknown>> = [
        () => import("./pages/cfo/FinancialStatements"),
        () => import("./pages/cfo/Products"),
        () => import("./pages/cfo/Chat"),
        () => import("./pages/cfo/BenchmarkReport"),
        () => import("./pages/cfo/Scenarios"),
        () => import("./pages/cfo/Variance"),
        () => import("./pages/cfo/Settings"),
        () => import("./pages/cfo/Decisions"),
        () => import("./pages/cfo/Alerts"),
        () => import("./pages/cfo/ComprehensiveReport"),
        () => import("./pages/cfo/PeerComparisonReport"),
        () => import("./pages/cfo/MultiYearHistory"),
        () => import("./pages/cfo/PublicCompanyDashboard"),
        () => import("./pages/cfo/PublicCompanyIntelligence"),
      ];
      // Light stagger so we don't fire 16 chunk requests in a single burst.
      jobs.forEach((job, i) =>
        window.setTimeout(() => { if (!cancelled) job().catch(() => {}); }, i * 120),
      );
    };
    const ric = window.requestIdleCallback;
    const id = ric ? ric(warm) : window.setTimeout(warm, 1500);
    return () => {
      cancelled = true;
      if (ric && window.cancelIdleCallback) window.cancelIdleCallback(id as number);
      else window.clearTimeout(id as number);
    };
  }, []);

  return (
    <ErrorBoundary>
    {/* 2026-07-25 — dark-only. The theme toggles were removed app-wide
        (operator directive); forcedTheme guarantees dark even for users
        whose localStorage still carries an old "light"/"system" pick. */}
    <ThemeProvider defaultTheme="dark" enableSystem={false} forcedTheme="dark">
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
        <CurrencyProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          {/* Fullscreen brand-accent spinner shown while the user switches
              the UI language — covers both the landing site and the app.
              Mounted above BrowserRouter so it survives route transitions;
              renders into document.body via a portal. */}
          <LanguageSwitchOverlay />
          {/* Fullscreen cover while the active month switches — the period
              change re-scopes every tab at once, so without it the page
              repaints piecemeal as each query settles. Inside
              QueryClientProvider: it dismisses on the live fetch count. */}
          <PeriodSwitchOverlay />
          {/* TestModeBanner — mounted ABOVE BrowserRouter so it persists
              across route transitions without re-mounting and without
              depending on any route-scoped context. Renders null when
              VITE_PUBLIC_TEST_MODE!=1 — zero-cost when test mode is off. */}
          <TestModeBanner />
          {/* TestModeSessionBoot — fetches the BE-minted Supabase JWT
              and calls supabase.auth.setSession(...) so direct FE →
              Supabase calls (uploads, INSERT into documents, RLS-scoped
              selects) work in test mode. No-op in production posture. */}
          <TestModeSessionBoot />
          {/* basename follows Vite's `base`. It is "/" for the VPS build (the
              app is served at the domain root) and "/<repo>/" for GitHub
              Pages project sites, where every route is nested under the repo
              path. Reading it from BASE_URL means one build config drives
              both — hardcoding either one breaks the other. Vite's BASE_URL
              carries a trailing slash; React Router wants none. */}
          <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            {/* LanguageSync resolves the active UI language each render
                via the auth-aware priority chain in useLanguage.ts and
                pushes the result into i18next + <html lang="...">.
                Must be inside <BrowserRouter> (needs URL) and
                <AuthProvider> (needs session). */}
            <LanguageSync />
            {/* F5.0 Phase 1.5 — global popover stack provider. Every
                <LearnableNumber> click pushes onto this stack. The
                stack renderer (mounted as a sibling below) paints all
                popovers at the app root, escaping z-index conflicts in
                nested cards / drawers. Must be inside BrowserRouter so
                route changes can clear the stack. */}
            {/* F5.0 Step 1 (CFO AI Learn) — learning-mode provider
                mirrors the active mode (guided / subtle / off) onto
                <html data-learning-mode="…"> so learning.css can branch
                affordance visibility via attribute selectors. Sits OUTSIDE
                PopoverStackProvider because mode changes don't need to
                clear the stack. */}
            <LearningModeProvider>
            <PopoverStackProvider>
              {/* AppRoutes wraps Routes in a RouteErrorBoundary keyed by the
                  current pathname. A throw inside any single route renders
                  the in-card error fallback instead of unmounting the whole
                  AuthProvider + QueryClient + BrowserRouter stack — so the
                  user's session and cached data survive a page-level crash.
                  Navigation resets the boundary automatically because the
                  key changes on every pathname transition. */}
              <AppRoutes />
              <PopoverStackRenderer />
              {/* F5.0 Step 3 — Glossary drawer is a global modal. Mounted
                  here so any page can dispatch the open event. */}
              <MetricGlossaryDrawer />
            </PopoverStackProvider>
            </LearningModeProvider>
          </BrowserRouter>
        </TooltipProvider>
        </CurrencyProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
    </ErrorBoundary>
  );
}

/**
 * All app routes, wrapped in RouteErrorBoundary + Suspense.
 *
 * Why this lives in a sub-component: the boundary needs a `key` that changes
 * on every navigation so a thrown error in route A doesn't persist when the
 * user navigates to route B. `useLocation()` only works inside <BrowserRouter>,
 * which is why this is a child of <App />, not the top-level component.
 *
 * Order of wrappers (outer → inner):
 *   1. RouteErrorBoundary — catches render throws in route subtrees. Keyed
 *      by pathname so navigation auto-resets.
 *   2. Suspense — handles the in-flight lazy-chunk fetch with RouteFallback.
 *   3. Routes — the matcher itself.
 *
 * A ChunkLoadError thrown by Suspense after a deploy invalidated the chunk
 * hash bubbles to RouteErrorBoundary, which detects it specifically and tells
 * the user "we just shipped — reload to pick up the new code" instead of the
 * generic "this page hit an error" copy.
 */
/**
 * Reset the document scroll to the top on every route change. Without
 * this, React Router preserves the previous page's scroll offset — so
 * arriving on a long tab (e.g. /public-companies) after scrolling far
 * down elsewhere landed the user mid/bottom of the new page. Pathname
 * only, deliberately: query-param changes (?period=, ?tab=, ?ticker=)
 * are in-page state and must NOT yank the user to the top. /chat is
 * skipped — its message list owns the scroll and pins to the bottom.
 */
function ScrollToTopOnNavigate() {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    if (pathname.startsWith("/chat")) return;
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function AppRoutes() {
  // NOTE: the outer error boundary is intentionally UNKEYED. Keying it by
  // pathname (as before) tore down the entire route subtree — including the
  // authenticated AppShell — on every navigation, which is exactly what made
  // tab switches feel like a full-page refresh. The per-navigation reset now
  // lives on the INNER boundary inside <AppLayout> (around the page <Outlet>),
  // so authed content resets on nav while the shell stays mounted.
  //
  // `isAuthenticated` decides WHERE /public-companies mounts: under the shared
  // AppLayout for signed-in users (so it reuses the one persistent AppShell and
  // never remounts on nav), or as a standalone route for anonymous visitors
  // (the page renders its own PublicShell there).
  const { isAuthenticated } = useAuth();
  return (
    <RouteErrorBoundary>
      <ScrollToTopOnNavigate />
      {/* Outer Suspense: only for lazy routes that are NOT under the shared
          shell (today just PublicCompanyIntelligence, which picks its own
          shell). Authed pages suspend against the INNER boundary in AppLayout,
          so the shell never unmounts while the next page chunk loads. */}
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          {/* ── Public / unauthenticated routes ─────────────────────────── */}
          <Route
            path="/"
            element={isPublicTestMode ? <Navigate to="/dashboard" replace /> : <Landing />}
          />
          <Route
            path="/login"
            element={isPublicTestMode ? <Navigate to="/dashboard" replace /> : <Login />}
          />
          <Route
            path="/signup"
            element={isPublicTestMode ? <Navigate to="/dashboard" replace /> : <Signup />}
          />
          <Route
            path="/auth/callback"
            element={isPublicTestMode ? <Navigate to="/dashboard" replace /> : <AuthCallback />}
          />
          <Route
            path="/pricing"
            element={isPublicTestMode ? <Navigate to="/dashboard" replace /> : <Pricing />}
          />
          <Route path="/roadmap" element={<RoadmapPage />} />
          <Route path="/contact-sales" element={<ContactSalesPage />} />

          {/* /onboarding was removed (2026-07-23) — the /workspace setup
              wizard owns first-run naming + industry now. Old links land on
              the redirect below. */}
          <Route path="/onboarding" element={<Navigate to="/workspace" replace />} />

          {/* Settings without the app shell (landing account menu → Settings). */}
          <Route path="/account/settings" element={<AuthGuard><AccountSettings /></AuthGuard>} />

          {/* Public Company Intelligence — auth-optional. Anonymous visitors
              get the standalone route (the page renders PublicShell). Signed-in
              visitors get it as a child of AppLayout below, so it shares the one
              persistent AppShell (no refresh when navigating in-app). */}
          {!isAuthenticated && (
            <Route path="/public-companies" element={<PublicCompanyIntelligence />} />
          )}

          {/* ── Authenticated app — ONE persistent shell ──────────────────
              AppLayout mounts AuthGuard + AppShell a single time and renders
              the matched page into its <Outlet>. Switching between these routes
              swaps only the page content; the sidebar/header never remount, so
              navigation is instant and shell state (sidebar collapse, open
              chat panel, etc.) is preserved. */}
          <Route element={<AppLayout />}>
            <Route path="/workspace" element={<Workspace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/dashboard/scenarios" element={<Scenarios />} />
            <Route path="/dashboard/variance" element={<Variance />} />
            <Route path="/dashboard/public/search" element={<Navigate to="/public-companies" replace />} />
            <Route path="/dashboard/public/:ticker" element={<PublicCompanyDashboard />} />
            <Route path="/products" element={<Products />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/benchmark" element={<BenchmarkReport />} />
            <Route path="/report" element={<ComprehensiveReport />} />
            <Route path="/peer-report" element={<PeerComparisonReport />} />
            <Route path="/settings" element={<Settings />} />
            {/* Flag-gated: render the page when enabled, else redirect. */}
            <Route
              path="/decisions"
              element={DECISIONS_ALERTS_ENABLED ? <Decisions /> : <RedirectPreservingQuery to="/dashboard" />}
            />
            <Route
              path="/alerts"
              element={DECISIONS_ALERTS_ENABLED ? <Alerts /> : <RedirectPreservingQuery to="/dashboard" />}
            />
            <Route
              path="/multi-year-history"
              element={PUBLIC_RECORDS_ENABLED ? <MultiYearHistory /> : <Navigate to="/dashboard" replace />}
            />
            {/* Signed-in: share the persistent shell (see anonymous route above). */}
            {isAuthenticated && (
              <Route path="/public-companies" element={<PublicCompanyIntelligence />} />
            )}
          </Route>

          {/* ── Legacy redirects (query string preserved where relevant) ─── */}
          <Route path="/upload" element={<RedirectPreservingQuery to="/dashboard" />} />
          <Route path="/cash" element={<Navigate to="/dashboard?tab=statements#cash-flow" replace />} />
          <Route path="/profit" element={<Navigate to="/dashboard?tab=statements#profit-loss" replace />} />
          <Route path="/financial-statements" element={<RedirectPreservingQuery to="/dashboard" />} />
          <Route path="/today"                element={<RedirectPreservingQuery to="/dashboard" />} />
          <Route path="/app"                  element={<RedirectPreservingQuery to="/dashboard" />} />
          <Route path="/briefing"             element={<RedirectPreservingQuery to="/dashboard" />} />
          <Route path="/reports"   element={<RedirectPreservingQuery to="/dashboard" tab="export" />} />
          <Route path="/invoices"  element={<RedirectPreservingQuery to="/dashboard" tab="invoices" />} />
          <Route path="/configuration" element={<Navigate to="/settings" replace />} />
          <Route path="/skus" element={<Navigate to="/products" replace />} />
          <Route path="/category/:slug" element={<Navigate to="/products" replace />} />
          <Route path="/history" element={<Navigate to="/decisions?status=done" replace />} />
          <Route path="/anchors" element={<Navigate to="/products?bucket=PROTECT" replace />} />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </RouteErrorBoundary>
  );
}

/**
 * AppLayout — the ONE authenticated shell. Mounts AuthGuard + AppShell a single
 * time; child routes render into <Outlet>. The keyed inner boundary + a
 * content-only Suspense fallback reset per navigation WITHOUT tearing down the
 * shell, so switching tabs never remounts the sidebar/header (no full refresh).
 */
function AppLayout() {
  const { pathname } = useLocation();
  return (
    <AuthGuard>
      <AppShell>
        <RouteErrorBoundary key={pathname}>
          <Suspense fallback={<ContentFallback pathname={pathname} />}>
            {/* Keyed enter animation (native-mobile pass): each page rises
                in over 200ms — transform/opacity only, 60fps-safe. */}
            <div key={pathname} className="page-enter">
              <Outlet />
            </div>
          </Suspense>
        </RouteErrorBoundary>
      </AppShell>
    </AuthGuard>
  );
}

/**
 * Content-only fallback for the in-shell Suspense. Covers just the content
 * area while the next page chunk loads (the shell — sidebar/header — is already
 * mounted). Loading skeletons were removed app-wide (2026-07-25): this is a
 * neutral, still placeholder that just holds the space, so the page's own
 * empty/upload/data state is the first real thing the user sees rather than a
 * pulsing dashboard silhouette that collapses into it.
 */
function ContentFallback(_props: { pathname?: string }) {
  return (
    <div aria-hidden className="min-h-[30vh] px-6 sm:px-10 pt-10 space-y-4">
      {/* Minimal shimmer (2026-08-04 perf pass) — abstract bars, not a
          page-shaped silhouette; only visible on slow connections. */}
      <div className="h-6 w-1/3 rounded-lg bg-bg-2/80 animate-pulse" />
      <div className="h-4 w-2/3 rounded bg-bg-2/60 animate-pulse [animation-delay:120ms]" />
      <div className="h-4 w-1/2 rounded bg-bg-2/60 animate-pulse [animation-delay:240ms]" />
    </div>
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
