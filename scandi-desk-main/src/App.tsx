import { lazy, Suspense, useEffect } from "react";
import "@/i18n"; // i18n bootstrap — must run before any component imports t()
import { ThemeProvider } from "@/theme";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
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
import { CurrencyProvider } from "@/stores/currency";
import { useHtmlLangSync } from "@/hooks/useHtmlLangSync";
import { PopoverStackProvider } from "@/components/learning/PopoverStackProvider";
import { PopoverStackRenderer } from "@/components/learning/PopoverStackRenderer";
import { MetricGlossaryDrawer } from "@/components/learning/MetricGlossaryDrawer";
import { LearningModeProvider } from "@/stores/learningMode";
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
const Onboarding = lazy(() => import("./pages/cfo/Onboarding"));
const Chat = lazy(() => import("./pages/cfo/Chat"));
// NASDAQ-8 — public-company search page (/dashboard/public/search).
const PublicCompanySearchPage = lazy(() => import("./pages/cfo/PublicCompanySearchPage"));
// NASDAQ-9 — per-company dashboard at /dashboard/public/:ticker.
const PublicCompanyDashboard = lazy(() => import("./pages/cfo/PublicCompanyDashboard"));
// Public Company Intelligence hub — first-class module at /public-companies.
// Auth-optional (renders its own shell at runtime based on session state);
// still lazy-loaded because it pulls in StockPriceChart + universe table.
const PublicCompanyIntelligence = lazy(() => import("./pages/cfo/PublicCompanyIntelligence"));

import { PUBLIC_RECORDS_ENABLED, DECISIONS_ALERTS_ENABLED } from "./config/features";
import { heartbeatIfIdentified } from "@/lib/identity";
import { AuthProvider } from "@/lib/auth";
import { AuthGuard } from "@/components/cfo/AuthGuard";
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

  return (
    <ErrorBoundary>
    <ThemeProvider defaultTheme="system" enableSystem>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
        <CurrencyProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
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
          <BrowserRouter>
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
function AppRoutes() {
  const { pathname } = useLocation();
  return (
    <RouteErrorBoundary key={pathname}>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          {/* PUBLIC_TEST_MODE — the Landing page assumes a sign-up funnel
              (CTAs, pricing teasers, account hooks). In test mode there's
              no auth, so landing on `/` should drop the visitor straight
              into the app shell with the synthetic identity. */}
          <Route
            path="/"
            element={isPublicTestMode ? <Navigate to="/dashboard" replace /> : <Landing />}
          />
          {/* PUBLIC_TEST_MODE — /login + /signup are dead-ends when auth is
              disabled; redirect to the dashboard so any bookmark or stale
              link still works for visitors. */}
          <Route
            path="/login"
            element={isPublicTestMode ? <Navigate to="/dashboard" replace /> : <Login />}
          />
          <Route
            path="/signup"
            element={isPublicTestMode ? <Navigate to="/dashboard" replace /> : <Signup />}
          />
          {/* /auth/callback — Supabase confirmation/recovery/magic-link
              redirect target. The SDK exchanges the URL fragment for a
              session as soon as createClient() runs; AuthCallback just
              waits for the SIGNED_IN event then forwards to /onboarding
              (or /login?reset=1 for password recovery). See
              src/lib/auth.tsx signUp() — emailRedirectTo points here.
              In test mode the email-confirm flow can never trigger (sign-up
              is disabled), but we keep the route as a no-op redirect so any
              stale email link lands safely on /dashboard instead of 404. */}
          <Route
            path="/auth/callback"
            element={isPublicTestMode ? <Navigate to="/dashboard" replace /> : <AuthCallback />}
          />
          {/* /pricing is public — but signed-in users see it as the
              upgrade picker. Used as the post-signup destination too.
              In PUBLIC_TEST_MODE, billing is disabled — redirect to the
              dashboard so the visitor never sees plan tiers / Stripe CTAs. */}
          <Route
            path="/pricing"
            element={isPublicTestMode ? <Navigate to="/dashboard" replace /> : <Pricing />}
          />
          <Route path="/roadmap" element={<RoadmapPage />} />
          <Route path="/contact-sales" element={<ContactSalesPage />} />

          {/* Onboarding: industry pick + workspace name. Reached after
              signup or when AuthGuard sees an org without industry_key. */}
          <Route path="/onboarding" element={<AuthGuard><Onboarding /></AuthGuard>} />

          {/* Authenticated app — gated by AuthGuard. Visiting any of these
              paths without sign-in OR demo-mode redirects to "/". */}
          <Route path="/dashboard" element={<AuthGuard><Dashboard /></AuthGuard>} />
          {/* F6.0.5 — Scenario planning / what-if. Cascades the live period
              through revenue/cost/working-capital levers and shows the impact
              on leverage + covenants. AuthGuard like the rest of the app. */}
          <Route path="/dashboard/scenarios" element={<AuthGuard><Scenarios /></AuthGuard>} />
          {/* F6.0.1b — Budget vs Actual vs Last-Year variance report. */}
          <Route path="/dashboard/variance" element={<AuthGuard><Variance /></AuthGuard>} />
          {/* NASDAQ-8 — public-company search surface. Reached from the
              DashboardPublicCompanyCard on the empty-state dashboard.
              /dashboard/public/:ticker (the per-company dashboard) lands
              in NASDAQ-9; until then the search results temporarily route
              to /dashboard with a query param hint. */}
          <Route path="/dashboard/public/search" element={<AuthGuard><PublicCompanySearchPage /></AuthGuard>} />
          {/* NASDAQ-9 — per-company dashboard. Renders Overview headline
              KPIs from the assembled_canonical_v1 envelope returned by
              /api/public/companies/:ticker. Other tabs (P&L / BS / CF /
              Ratios / Valuation) land in NASDAQ-10 by feeding the same
              envelope into the existing private-side renderers. */}
          <Route path="/dashboard/public/:ticker" element={<AuthGuard><PublicCompanyDashboard /></AuthGuard>} />
          {/* Public Company Intelligence hub — first-class module page.
              Watchlist + benchmarking + AI interpretation, with demo
              data fallback when SF1 isn't entitled.
              2026-05-24 — DROPPED AuthGuard. The landing-page "Quick try"
              ticker chips + the Public Companies entry card promise
              "no signup · 10s". The page itself reads from the open
              `/api/public/*` routes (no auth required), and the
              page picks its own shell at render time:
                · isAuthenticated → AppShell (full sidebar + nav)
                · anonymous       → PublicShell (Logo + Sign in CTAs)
              See PublicCompanyIntelligence.tsx for the shell-pick
              logic. */}
          <Route path="/public-companies" element={<PublicCompanyIntelligence />} />
          {/* /upload was a separate page; consolidated into Dashboard's
              empty-state zone + Replace dropdown. Legacy redirect kept so
              bookmarks / external links / onboarding redirects all land
              on the canonical surface without a 404. */}
          <Route path="/upload" element={<RedirectPreservingQuery to="/dashboard" />} />
          {/* Legacy /cash and /profit routes — Cash + Profit are now
              sections inside the Dashboard. Redirect preserves any
              external bookmarks while landing the user on the right
              section anchor (the Statements tab handles the actual
              rendering). */}
          <Route path="/cash" element={<Navigate to="/dashboard?tab=statements#cash-flow" replace />} />
          <Route path="/profit" element={<Navigate to="/dashboard?tab=statements#profit-loss" replace />} />
          {/* /decisions and /alerts — gated by DECISIONS_ALERTS_ENABLED.
              When the flag is off (current product positioning), direct
              navigation to either redirects cleanly to /dashboard with
              ?period= preserved by RedirectPreservingQuery. The Decisions
              and Alerts components, their data hooks, and the underlying
              backend endpoints all remain functional on disk — flipping
              the flag to `true` restores both surfaces with zero further
              change. */}
          <Route
            path="/decisions"
            element={
              DECISIONS_ALERTS_ENABLED
                ? <AuthGuard><Decisions /></AuthGuard>
                : <RedirectPreservingQuery to="/dashboard" />
            }
          />
          <Route path="/products" element={<AuthGuard><Products /></AuthGuard>} />
          <Route
            path="/alerts"
            element={
              DECISIONS_ALERTS_ENABLED
                ? <AuthGuard><Alerts /></AuthGuard>
                : <RedirectPreservingQuery to="/dashboard" />
            }
          />
          {/* /chat — Ask CFO AI universal open-domain chat. Reuses the
              /api/cfo/chat/llm endpoint that powers the Opus briefing
              and grounds responses in the active period's workspace
              context (statements, ratios, briefing, recommendations).
              No new persistence: session history lives in component
              state for the lifetime of the tab. */}
          <Route path="/chat" element={<AuthGuard><Chat /></AuthGuard>} />
          <Route path="/benchmark" element={<AuthGuard><BenchmarkReport /></AuthGuard>} />
          {/* /report — the 8-section institutional memo (Section 1 Overview
              → Section 8 Recommendations + 90-day plan). Reads from the
              same /api/period endpoint as the dashboard, so no extra
              compute. Export PDF button hits /api/report/:period/pdf
              (WeasyPrint). */}
          <Route path="/report" element={<AuthGuard><ComprehensiveReport /></AuthGuard>} />
          {/* /peer-report — Transavia-style side-by-side memo. Reads the
              same /api/benchmarks/report payload BenchmarkReport uses, but
              renders as a printable institutional memo with: headline
              verdict, row-by-row P&L gap (with financial impact in RON),
              named peer landscape, why-the-leader-leads reasons, target
              tiers, and industry dynamics. Export PDF = browser print. */}
          <Route path="/peer-report" element={<AuthGuard><PeerComparisonReport /></AuthGuard>} />
          {/* /multi-year-history — listafirme.ro / termene.ro / firme.info
              public-records summary view. Gated behind PUBLIC_RECORDS_ENABLED.
              When the flag is off (current product positioning), any direct
              navigation here redirects to /dashboard rather than rendering
              the public-records view. The component remains imported and
              importable so flipping the flag back on restores the route
              with zero code change. */}
          <Route
            path="/multi-year-history"
            element={
              PUBLIC_RECORDS_ENABLED
                ? <AuthGuard><MultiYearHistory /></AuthGuard>
                : <Navigate to="/dashboard" replace />
            }
          />
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
      </Suspense>
    </RouteErrorBoundary>
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
