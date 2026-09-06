// LR1 / LR2 / LR3 — the launch cut, asserted at the ROUTE.
//
// Hermetic: local Vite (`.env.local` pins VITE_SUPABASE_URL at
// https://test.supabase.co, so nothing here can reach the production
// project) + the local engine serving /api/features/status. Never point
// this at production.
//
// THE PROPERTY UNDER TEST
// ======================
// The launch ships eight surfaces. Everything else is switched off. "Off"
// has a precise meaning that a nav-bar filter alone does not satisfy:
// a route is reachable by typing the URL, by an old bookmark, by a link in
// an email and by browser history, so hiding the sidebar item leaves the
// half-verified page one keystroke away. Each gate below states what it
// reds on.
//
//   LR1 — every route in App.tsx renders EITHER its own working root OR
//         the PendingState root. Never an error boundary, never an empty
//         <main>, never a spinner still spinning at 10 s, never a bare
//         string dumped into the document.
//   LR2 — zero console errors and zero uncaught page errors per route.
//   LR3 — the string "Coming soon" appears ONLY where the registry says
//         that feature is `coming_soon`, and never on a PendingState
//         screen. "Coming soon" is reserved for capability that does not
//         exist; a launch-cut surface is built and switched off, and says
//         so in its own words.

import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";

// ── The route table ───────────────────────────────────────────────────
// Every path <Route> declares in frontend/App.tsx, plus the legal routes.
// `expect` says which of the two acceptable outcomes this route must
// produce. Adding a route to App.tsx without adding it here is itself the
// drift this gate exists to catch, so the last test cross-checks the
// count against the source file.

type Outcome = "working" | "pending" | "either";

interface RouteCase {
  path: string;
  expect: Outcome;
  /** Why this route is in the launch scope, or why it is cut. */
  note: string;
  /**
   * Path the browser is expected to END on, when that is not `path`.
   * Declaring it is mandatory for any route that redirects: it is the
   * only thing standing between this gate and asserting the wrong page.
   */
  landsOn?: string;
}

// `VITE_PUBLIC_TEST_MODE=1` replaces the four public entry points with a
// redirect to /dashboard. That is the product's own behaviour, not the
// harness's, so the gate declares it rather than pretending it does not
// happen — and the marketing pages themselves are walked by the second
// project below, against a Vite WITHOUT test mode.
const TEST_MODE = process.env.LAUNCH_GATE_TEST_MODE !== "0";
const REDIRECTED = TEST_MODE ? "/dashboard" : undefined;

const PUBLIC_ROUTES: RouteCase[] = [
  { path: "/", expect: "working", note: "launch 1 — marketing", landsOn: REDIRECTED },
  { path: "/pricing", expect: "working", note: "launch 1 + 8 — pricing/billing entry", landsOn: REDIRECTED },
  { path: "/contact-sales", expect: "working", note: "launch 1" },
  { path: "/login", expect: "working", note: "launch 2", landsOn: REDIRECTED },
  { path: "/signup", expect: "working", note: "launch 2", landsOn: REDIRECTED },
  { path: "/privacy", expect: "working", note: "survival — legal page present" },
  { path: "/terms", expect: "working", note: "survival — legal page present" },
  { path: "/cookies", expect: "working", note: "survival — legal page present" },
  { path: "/roadmap", expect: "pending", note: "CUT — not in the eight" },
  { path: "/public-companies", expect: "pending", note: "CUT — post-launch wave" },
  { path: "/this-route-does-not-exist", expect: "working", note: "404 is a designed page" },
  // /public-companies is auth-optional: signed-in it lives under AppLayout,
  // signed-out it is a standalone route. Both are wrapped in FeatureRoute,
  // so PendingState is the answer either way.
];

// These are walked only in the test-mode run, which HAS a session — so the
// expectations are the strict ones. An earlier version marked every row
// "either", which read as caution and was in fact a hole: flipping
// `benchmarks` back to `active` in the registry left the gate green while
// /benchmark served its real, unwalked screen. "either" asserts nothing
// about the cut, so no cut route may use it.
const AUTHED_ROUTES: RouteCase[] = [
  { path: "/dashboard", expect: "working", note: "launch 3-6" },
  { path: "/workspace", expect: "working", note: "launch 2-3" },
  { path: "/settings", expect: "working", note: "launch 7-8" },
  // /ops is an operator surface behind its own admin gate, not a product
  // route: a non-admin session legitimately gets a denial rather than the
  // page. Shape only — the one row where "either" is the honest answer.
  { path: "/ops", expect: "either", note: "operator surface — admin-gated" },
  { path: "/dashboard/scenarios", expect: "pending", note: "CUT" },
  { path: "/dashboard/variance", expect: "pending", note: "CUT" },
  { path: "/products", expect: "pending", note: "CUT" },
  { path: "/inventory", expect: "pending", note: "CUT — had no route at all before" },
  { path: "/invoices", expect: "pending", note: "CUT — was a redirect to a dead tab" },
  { path: "/chat", expect: "pending", note: "CUT" },
  { path: "/benchmark", expect: "pending", note: "CUT" },
  { path: "/report", expect: "pending", note: "CUT" },
  { path: "/peer-report", expect: "pending", note: "CUT" },
];

// ── Console capture ───────────────────────────────────────────────────

const IGNORABLE = [
  // ── The harness's own failures, not the page's ────────────────────
  // `.env.local` pins VITE_SUPABASE_URL at https://test.supabase.co, a
  // host that deliberately does not resolve — that pin IS the hermeticity
  // guarantee. Every Supabase SDK call therefore fails, and the SDK logs
  // it. These patterns are matched against the console entry INCLUDING its
  // stack, so they are anchored on a `supabase-js` frame or on the
  // test-mode boot's own prefix. A genuine app error has neither, so this
  // filter cannot swallow one.
  //
  // LIMITATION, stated rather than hidden: because the pin makes every
  // auth call fail, this run cannot observe console errors that only occur
  // AFTER a session exists. Those belong to the authed walk, which is
  // BLOCKED until a QA account exists.
  /supabase[-_]supabase-js/,
  /\[test-mode\] setSession returned error/,
  /AuthRetryableFetchError/,
  /test\.supabase\.co/,
  /net::ERR_NAME_NOT_RESOLVED/,
  /Failed to load resource/,
  /favicon\.ico/,
  // Vite's dev-only HMR chatter.
  /\[vite\]/,
];

function collectConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

function realErrors(errors: string[]): string[] {
  return errors.filter((e) => !IGNORABLE.some((re) => re.test(e)));
}

// ── The shape assertions ──────────────────────────────────────────────

/**
 * A route "renders a working screen" when it puts real content on screen
 * and is NOT the error boundary. Deliberately shape-based rather than a
 * per-page testid list: a testid list would have to be maintained beside
 * this file and would go stale silently, which is the same class of bug
 * the gate is for.
 */
async function classify(page: Page): Promise<{
  pending: boolean;
  errorBoundary: boolean;
  text: string;
}> {
  const pending = (await page.locator('[data-testid="pending-state"]').count()) > 0;
  // RouteErrorBoundary / ErrorBoundary render one of these.
  const errorBoundary =
    (await page.locator('[data-testid="route-error"], [data-testid="error-boundary"]').count()) > 0;
  const text = (await page.locator("body").innerText()).trim();
  return { pending, errorBoundary, text };
}

// LAUNCH_GATE_SCOPE=public walks ONLY the public table. It exists because
// the authed routes require a session: without test mode every one of them
// bounces to /login, which the landed-URL assertion correctly reds. Two
// runs cover the app — test-mode for the authed half, non-test-mode for
// the marketing/auth half whose real pages test mode replaces.
const SCOPE = process.env.LAUNCH_GATE_SCOPE ?? "all";
const CASES =
  SCOPE === "public" ? PUBLIC_ROUTES : [...PUBLIC_ROUTES, ...AUTHED_ROUTES];

for (const rc of CASES) {
  test(`LR1/LR2 ${rc.path} — ${rc.note}`, async ({ page }, testInfo) => {
    const errors = collectConsole(page);
    await page.goto(rc.path, { waitUntil: "domcontentloaded" });
    // 10 s is the gate's own budget: a surface still showing nothing but a
    // spinner after ten seconds is a broken screen, not a slow one.
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

    const { pending, errorBoundary, text } = await classify(page);

    // ── LR0: am I even looking at the page I asked for? ──
    // Found the hard way. `isPublicTestMode` turns `/`, `/pricing`,
    // `/login` and `/signup` into <Navigate to="/dashboard">, so in a
    // test-mode hermetic run all four resolved to the dashboard — which
    // renders fine, so every assertion below passed while measuring a
    // completely different screen. A gate that cannot tell which page it
    // is on is not a gate. Landing somewhere else is allowed only when
    // this table says so, by name.
    const landed = new URL(page.url()).pathname;
    expect(landed, `${rc.path} silently resolved to ${landed}`).toBe(
      rc.landsOn ?? rc.path,
    );

    // ── LR1 ──
    expect(errorBoundary, `${rc.path} rendered an error boundary`).toBe(false);
    expect(text.length, `${rc.path} rendered an empty screen`).toBeGreaterThan(20);
    if (rc.expect === "pending") {
      expect(pending, `${rc.path} must render PendingState, not its real screen`).toBe(true);
    }
    if (rc.expect === "working") {
      expect(pending, `${rc.path} must render its real screen`).toBe(false);
    }

    // ── LR2 ──
    expect(realErrors(errors), `${rc.path} console errors`).toEqual([]);

    await page.screenshot({
      path: testInfo.outputPath(`route${rc.path.replace(/\//g, "_")}.png`),
    });
  });
}

// ── LR3 ───────────────────────────────────────────────────────────────
// "Coming soon" is reserved for capability that DOES NOT EXIST. A
// launch-cut surface is built and switched off — different statement,
// different words (PendingState's).
//
// The first version of this gate banned the string on any working screen
// and immediately red on /settings, whose two-factor row legitimately says
// it: 2FA genuinely does not exist. Banning it there would have forced the
// copy to lie in the other direction. So the gate is scoped to the claim
// that can actually be wrong — a "Coming soon" whose feature is NOT
// `coming_soon` in the registry.
//
// Every allowed occurrence is listed with the feature it describes, and
// the registry status of that feature is asserted live. Promote
// `two_factor_auth` to `active` and forget the copy, and this reds.

const COMING_SOON_ALLOWED: Array<{ path: string; featureKey: string }> = [
  // Two-factor sign-in: genuinely does not exist.
  { path: "/settings", featureKey: "two_factor_auth" },
  // The /pricing billing-cycle toggle's disabled Annual segment. The
  // registry row `annual_billing` was added when this gate found the
  // string unbacked — the copy now has a status behind it rather than
  // being a hardcoded promise nothing tracks.
  { path: "/pricing", featureKey: "annual_billing" },
];

async function registryStatus(page: Page, key: string): Promise<string | undefined> {
  const api = process.env.VITE_API_URL ?? "http://127.0.0.1:8010";
  const body = await page.evaluate(async (url) => {
    const r = await fetch(`${url}/api/features/status`);
    return (await r.json()) as { features: Record<string, { status: string }> };
  }, api);
  return body.features?.[key]?.status;
}

// Reds on: a route showing "Coming soon" with no allowed entry naming the
// feature it refers to — i.e. the copy attached to something that is not,
// in the registry, a coming_soon feature.
test("LR3 — 'Coming soon' only where the registry says coming_soon", async ({ page }) => {
  test.setTimeout(180_000);
  const offenders: string[] = [];
  for (const rc of CASES) {
    await page.goto(rc.path, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
    const { pending, text } = await classify(page);
    if (!/coming soon/i.test(text)) continue;
    // A cut surface must never carry the string, allowed-list or not.
    if (pending) {
      offenders.push(`${rc.path} (PendingState must not say it)`);
      continue;
    }
    const allowed = COMING_SOON_ALLOWED.filter((a) => a.path === rc.path);
    if (allowed.length === 0) {
      offenders.push(`${rc.path} (no allowed entry names the feature)`);
      continue;
    }
    for (const a of allowed) {
      const status = await registryStatus(page, a.featureKey);
      if (status !== "coming_soon") {
        offenders.push(
          `${rc.path} says "Coming soon" for ${a.featureKey}, whose registry status is ${status ?? "undefined"}`,
        );
      }
    }
  }
  expect(offenders, "'Coming soon' attached to something that is not coming_soon").toEqual([]);
});

// Reds on: PendingState itself drifting back to the "Coming soon" copy.
test("LR3 — PendingState never says 'Coming soon'", async ({ page }) => {
  await page.goto("/roadmap", { waitUntil: "domcontentloaded" });
  const root = page.locator('[data-testid="pending-state"]');
  await expect(root).toHaveCount(1);
  await expect(root).not.toContainText(/coming soon/i);
});

// Reds on: a route added to App.tsx that this file does not cover. The
// count is read from the source, so the gate cannot be satisfied by
// forgetting to extend it.
test("every <Route path> in App.tsx is covered by this file", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(
    new URL("../frontend/App.tsx", import.meta.url),
    "utf-8",
  );
  const declared = new Set(
    [...src.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]),
  );
  const covered = new Set([...PUBLIC_ROUTES, ...AUTHED_ROUTES].map((r) => r.path));

  const uncovered = [...declared].filter((p) => {
    if (p === "*") return false; // covered by the 404 case above
    if (p.includes(":")) return false; // parameterised — covered by its parent
    // Legacy redirect paths land on a covered destination; assert the
    // destination, not every alias.
    const LEGACY = new Set([
      "/upload", "/cash", "/profit", "/financial-statements", "/today", "/app",
      "/briefing", "/reports", "/configuration", "/skus", "/history", "/anchors",
      "/decisions", "/alerts", "/multi-year-history", "/onboarding",
      "/account/settings", "/auth/callback", "/dashboard/public/search",
    ]);
    if (LEGACY.has(p)) return false;
    return !covered.has(p);
  });

  expect(uncovered, "routes in App.tsx with no case in launch-route-cut.spec.ts").toEqual([]);
});
