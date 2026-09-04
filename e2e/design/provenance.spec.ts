/**
 * PROVENANCE ON HOVER — the live gates P0–P5, per surface.
 *
 * ── What this file proves that the static census cannot ──────────────
 *
 * `scripts/check_provenance_census.mjs` counts affordance-bearing tags in
 * SOURCE. It cannot see whether the component that owns the tag is the
 * component that PAINTS the screen (TC-7), whether the card that opens
 * names an origin a reader can actually follow (P5), or whether a
 * keyboard user can reach it at all (P3). Each of those needs a browser,
 * a real payload, and an assertion on what appeared.
 *
 * ── The payload is REAL ENGINE OUTPUT, served from the browser (TC-1) ──
 *
 * The sanctioned test-mode stack (vite :5173 + engine :8000 with
 * PUBLIC_TEST_MODE=1) holds NO periods in the shared test workspace, and
 * this suite must never write one: `.env.local` pins the browser's
 * Supabase URL to the unreachable manifest host precisely so nothing a
 * test does can land in production (8,880 junk organisations did, once —
 * see scripts/check_test_env_isolation.mjs). So the period is FULFILLED
 * FROM THE BROWSER: `GET /api/period/{id}` answers with
 * `e2e/fixtures/provenance/carniprod_period.json`, which is assembled
 * from real engine outputs only — the served canonical balance-sheet
 * envelope of `corpus/saga_10_col_carniprod` (44 rows, account codes to
 * the cent), the engine's own regression-baseline statements for the same
 * company, and the findings `s_engine.run_single_period` emits over them.
 * `build_carniprod_period.py` beside it regenerates the file byte-
 * identically; nothing in it is typed by hand.
 *
 * The public-companies surfaces need no fixture: the engine's local
 * public-market store already holds AAPL's SEC companyfacts document,
 * with a provenance block per figure, and `/api/public/universe` serves
 * the seeded BVB + demo rows the Markets overview paints.
 *
 * ── The gates ────────────────────────────────────────────────────────
 *
 *   P0  anchors resolve; the run reached NO real Supabase host and
 *       performed NO engine mutation; the fixture was actually served.
 *   P1  a figure whose payload carries provenance and renders NO
 *       affordance FAILS — asserted row-by-row against the served
 *       envelope (statements) and finding-by-finding (findings).
 *   P2  a FABRICATED affordance FAILS — a card with nothing in it, a
 *       Source that names a period, a field path the served envelope does
 *       not hold, a figure that is not the field's value, a `computed`
 *       time that is the engine's process clock, a zero standing in for
 *       an absent feed value. EVERY surface with a runtime path is read
 *       (2026-09-04: dashboard, trust receipt, findings limits/impact,
 *       report, P&L + cash-flow tabs, markets overview, and the silent
 *       surfaces — the first draft read four).
 *   P3  focus works like hover (a real Tab keystroke reaches the figure
 *       and opens the card); Escape dismisses it.
 *   P4  PER-SURFACE recorded floors (TC-6) — each its own test, each
 *       message naming the surface, so a total across surfaces cannot
 *       hide one surface losing every dot.
 *   P5  the target RESOLVES: every account the card names is in the
 *       served envelope; every sheet is the extraction's sheet; every
 *       field path is a field of the served statements and the figure IS
 *       that field's value; every SEC concept and accession is in the
 *       companyfacts document.
 *   UNWITNESSED — a surface with NO runtime path on this stack is a
 *       first-class printed state, not a pass: each such test PROBES the
 *       precondition that blocks it and FAILS the day the precondition
 *       lifts, so a witness gets written instead of a stale excuse.
 *
 * Every plant, its red, and its revert: design_review/provenance/GATES.md.
 *
 * NO MODEL SPEND: the only Capsule question asked is a Tier-0 fact
 * ("total assets"), answered from the local index without a request.
 *
 * Run: npx playwright test e2e/design/provenance.spec.ts --project=chromium
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  dismissPublicTestBanner,
  preseedLearningMode,
  seedViewMode,
} from "../_helpers";

test.skip(
  ({ baseURL }) => !/localhost|127\.0\.0\.1/.test(baseURL ?? ""),
  "provenance gates need the test-mode stack (vite :5173 + engine :8000 PUBLIC_TEST_MODE)",
);

// ══════════════════════════════════════════════════════════════════════
// THE FIXTURE — read once, and read back rather than restated
// ══════════════════════════════════════════════════════════════════════

// fileURLToPath, not URL.pathname — this repo's path contains spaces.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "../..");
const FIX_DIR = resolve(HERE, "../fixtures/provenance");
const PERIOD_RAW = readFileSync(resolve(FIX_DIR, "carniprod_period.json"), "utf-8");
const PERIODS_RAW = readFileSync(resolve(FIX_DIR, "carniprod_periods.json"), "utf-8");

interface EnvelopeRow {
  id: string;
  label: string;
  account_codes?: string[];
  leaf_ids?: string[];
}
interface FindingProvenance {
  period_id: string;
  snapshot_id: string;
  line_refs: string[];
  source: string;
}
interface Fixture {
  period: { id: string; period_end: string; source_document: { filename: string } };
  statements: Record<string, unknown> & {
    canonical_bs: {
      rows: EnvelopeRow[];
      extraction: { sheet: string; method: string };
      mapping_version: string;
      difference: number;
    };
    assembled_cf: { is_approximated?: boolean };
  };
  line_items: Array<{ ro_account_code: string }>;
  alerts: Array<{
    rule_key: string;
    disposition?: string;
    contract_elements?: {
      evidence?: { provenance?: FindingProvenance };
      threshold?: { source: string; rule_id: string; parameter: string };
      impact?: { kind: string; metric: string };
    };
  }>;
}
const FIXTURE = JSON.parse(PERIOD_RAW) as Fixture;
const PERIOD_ID = FIXTURE.period.id;
const ENVELOPE = FIXTURE.statements.canonical_bs;
/** The envelope's own words. If the corpus changes, the laws move. */
const SHEET = ENVELOPE.extraction.sheet;
const METHOD = ENVELOPE.extraction.method;
const PACK = ENVELOPE.mapping_version;
/** The uploaded document every READ figure names as its source. */
const DOCUMENT = FIXTURE.period.source_document.filename;
/** Every account code the served rows name — the set a reference must
 *  land in to have RESOLVED (P5). Leaf ids are the analytic sub-accounts
 *  ("5121.04.01"); a finding's line_ref may name a class prefix. */
const ENVELOPE_CODES = new Set<string>(ENVELOPE.rows.flatMap((r) => r.account_codes ?? []));
const ENVELOPE_LEAVES = new Set<string>(ENVELOPE.rows.flatMap((r) => r.leaf_ids ?? []));
const CODED_ROWS = ENVELOPE.rows.filter((r) => (r.account_codes ?? []).length > 0);
/** Every account the engine CLASSIFIED in the trial balance — classes 1-7,
 *  analytic ("6811.01"). A finding cites statement lines, and a P&L line
 *  (601, 681) is not in the balance-sheet envelope but is in here. */
const CLASSIFIED_CODES = new Set<string>(FIXTURE.line_items.map((li) => li.ro_account_code));
/** Findings, by rule key, with their engine-emitted provenance. */
const FINDING_PROVENANCE = new Map(
  FIXTURE.alerts
    .filter((a) => a.contract_elements?.evidence?.provenance)
    .map((a) => [a.rule_key, a.contract_elements!.evidence!.provenance!] as const),
);
const FINDING_THRESHOLD = new Map(
  FIXTURE.alerts
    .filter((a) => a.contract_elements?.threshold)
    .map((a) => [a.rule_key, a.contract_elements!.threshold!] as const),
);
const FINDING_IMPACT = new Map(
  FIXTURE.alerts
    .filter((a) => a.contract_elements?.impact)
    .map((a) => [a.rule_key, a.contract_elements!.impact!] as const),
);

/** The manifest host the browser is pinned to. Anything else that looks
 *  like Supabase is a real project, and a test must never reach one. */
const MANIFEST = JSON.parse(
  readFileSync(resolve(HERE, "../../frontend/test/hermeticEnv.json"), "utf-8"),
) as { env: Record<string, string | null> };
const MANIFEST_HOST = new URL(MANIFEST.env.VITE_SUPABASE_URL as string).host;

const ENGINE = "http://127.0.0.1:8000";
const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";

// ══════════════════════════════════════════════════════════════════════
// ANCHORS
// ══════════════════════════════════════════════════════════════════════

const AFF = '[data-provenance="true"]';
const A = {
  statement: ".bs-statement",
  statementRow: ".bs-statement .bs-row",
  subtotalAff: `.bs-subtotal ${AFF}`,
  plStatement: '[data-testid="pl-statement"]',
  plCell: '[data-testid="pl-statement"] .pl-amount',
  cfStatement: '[data-testid="cf-statement"]',
  cfCell: '[data-testid="cf-statement"] .cf-amount',
  findings: '[data-testid="fnd-panel"]',
  findingCard: '[data-testid^="fnd-card-"]',
  figureCell: '[data-testid^="fnd-figure-"]',
  threshold: '[data-testid="fnd-threshold"]',
  impact: '[data-testid="fnd-impact"]',
  allChecks: '[data-testid="fnd-all-checks"]',
  keyMetrics: '[data-testid="key-metrics"]',
  heroVerdict: '[data-testid="hero-verdict"]',
  trustDot: '[data-testid="trust-dot"]',
  trustReceipt: '[data-testid="trust-receipt"]',
  report: '[data-testid="comprehensive-report"]',
  reportSection: '[data-testid^="report-section-"]',
  capsuleTrigger: '[data-testid="header-command-bar"]',
  capsule: '[data-testid="command-palette"]',
  capsuleInput:
    '[data-testid="command-palette"] [role="combobox"], ' +
    '[data-testid="command-palette"] textarea, ' +
    '[data-testid="command-palette"] input[type="text"]',
  tier0: '[data-testid="capsule-tier0"]',
  marketTabUs: '[data-testid="market-tab-us"]',
  marketInput: '[data-testid="market-ticker-input-us"]',
  marketSubmit: '[data-testid="market-ticker-submit-us"]',
  marketDoc: '[data-testid^="market-document-"]',
  marketsOverview: '[data-testid="markets-overview"]',
  companyGrid: '[data-testid="markets-company-grid"]',
  companyTile: '[data-testid^="company-grid-tile-"]',
  pulseStrip: '[data-testid="market-pulse-strip"]',
  peerRail: '[data-testid="peer-suggest-rail"]',
  tooltip: '[role="tooltip"]',
} as const;

// ══════════════════════════════════════════════════════════════════════
// P4 — THE RECORDED EXPECTATIONS, ONE PER SURFACE (TC-6)
// ══════════════════════════════════════════════════════════════════════
//
// Floors, not equalities: a figure added to a surface must not red this
// gate, a surface losing its dots must. Each is what THIS tree is MEASURED
// to render against the fixture (2026-09-04), with ~10% margin.
//
//   statements        94 measured — 44 account-coded rows x 2 cells, minus
//                     the rows that render a <LearnableNumber> (the
//                     KNOWN GAP in BSStatementView) plus subtotals.
//   findings          38 measured — 18 cited-figure cells + 10 threshold
//                     (limit + observed) + 10 impact (both endpoints).
//   capsule            3 measured — the resting fact tiles; the Tier-0
//                     answer adds 1 and is asserted separately.
//   public-companies   6 measured — every figure of AAPL's companyfacts
//                     document carries a provenance block.
//   dashboard         10 measured — hero verdict, 4 key metrics, 5 tiles.
//   trust-receipt      1 measured — the difference row; the two
//                     reconciliation rows need a receipt the fixture
//                     envelope does not carry (`reconciliation: null`).
//   report            51 measured — 13 P&L + 17 BS + 21 CF rows.
//   markets-overview  73 measured — 24 tiles x 3 + the pulse median.
const SURFACE_FLOORS = {
  dashboard: 9,
  "trust-receipt": 1,
  statements: 80,
  findings: 34,
  capsule: 3,
  "public-companies": 5,
  report: 45,
  "markets-overview": 65,
} as const;
type Surface = keyof typeof SURFACE_FLOORS;

const SETTLE_MS = 8_000;
const ACTION_MS = 20_000;

// ══════════════════════════════════════════════════════════════════════
// HARNESS
// ══════════════════════════════════════════════════════════════════════

interface Ledger {
  requests: Array<{ method: string; url: string }>;
  periodServed: number;
}

/**
 * Boot the test-mode app with the fixture period on the wire.
 *
 * Four routes, all read-only and all recorded in the ledger:
 *   auth/v1/user     the browser's Supabase host does not resolve, so
 *                    `setSession` (TestModeSessionBoot) fails on its
 *                    user lookup and no period fetch ever carries a
 *                    token. Answering the lookup with the fixed test
 *                    identity lets the app's own boot complete.
 *   /api/period/ID   the fixture — the whole point.
 *   periods-with-documents  the same period, so the stepper agrees.
 *   pipeline/recover-stuck  a watchdog the page POSTs on every boot;
 *                    stubbed so this spec performs NO engine mutation.
 */
async function boot(page: Page): Promise<Ledger> {
  const ledger: Ledger = { requests: [], periodServed: 0 };
  page.on("request", (r) => ledger.requests.push({ method: r.method(), url: r.url() }));

  await preseedLearningMode(page, "subtle");
  // PRO: Simple mode collapses every item row behind "Show all lines",
  // and the first jsdom run of the statement law found 0 affordances for
  // exactly that reason.
  await seedViewMode(page, "pro");

  await page.route(/\/auth\/v1\/user(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: TEST_USER_ID,
        aud: "authenticated",
        role: "authenticated",
        email: "test@cfo-ai.io",
        app_metadata: {},
        user_metadata: {},
        created_at: "2026-01-01T00:00:00Z",
      }),
    }),
  );
  await page.route(new RegExp(`/api/period/${PERIOD_ID}(\\?|$)`), (route) => {
    ledger.periodServed += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: PERIOD_RAW });
  });
  await page.route(/\/api\/org\/periods-with-documents/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: PERIODS_RAW }),
  );
  await page.route(/\/api\/pipeline\/recover-stuck/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );

  // Warm boot: the test-mode session is minted asynchronously and the
  // FIRST period fetch of a fresh context races it (measured: the
  // fixture page rendered the upload state once, then loaded on every
  // later navigation). One plain visit lets the session land.
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6_000);
  return ledger;
}

async function openPeriod(page: Page, tab?: string): Promise<void> {
  const q = tab ? `&tab=${tab}` : "";
  await page.goto(`/dashboard?period=${PERIOD_ID}${q}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS);
  await dismissPublicTestBanner(page);
}

async function openRoute(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS);
  await dismissPublicTestBanner(page);
}

async function openCapsule(page: Page): Promise<Locator> {
  await page.locator(A.capsuleTrigger).click({ timeout: ACTION_MS });
  const overlay = page.locator(A.capsule);
  await expect(overlay).toBeVisible({ timeout: ACTION_MS });
  await page.waitForTimeout(1_200);
  return overlay;
}

async function openAaplDocument(page: Page): Promise<Locator> {
  await openRoute(page, "/public-companies");
  await page.locator(A.marketTabUs).click({ timeout: ACTION_MS });
  await page.locator(A.marketInput).fill("AAPL", { timeout: ACTION_MS });
  await page.locator(A.marketSubmit).click({ timeout: ACTION_MS });
  const doc = page.locator(A.marketDoc).first();
  await expect(doc).toBeVisible({ timeout: ACTION_MS });
  await page.waitForTimeout(1_000);
  return doc;
}

async function openTrustReceipt(page: Page): Promise<Locator> {
  await page.locator(A.trustDot).first().click({ timeout: ACTION_MS });
  const sheet = page.locator(A.trustReceipt);
  await expect(sheet).toBeVisible({ timeout: ACTION_MS });
  await page.waitForTimeout(800);
  return sheet;
}

/** Affordances on the overview that belong to the DASHBOARD surface —
 *  everything outside the findings panel and the Capsule. */
async function dashboardAffordances(page: Page): Promise<number> {
  return page.evaluate(
    ({ aff, findings, capsule }) =>
      Array.from(document.querySelectorAll(aff)).filter(
        (el) => !el.closest(findings) && !el.closest(capsule),
      ).length,
    { aff: AFF, findings: A.findings, capsule: A.capsule },
  );
}

/** The isolation law, asserted at the END of every test that booted. */
function assertIsolation(ledger: Ledger): void {
  const foreign = ledger.requests.filter((r) => {
    let host = "";
    try {
      host = new URL(r.url).host;
    } catch {
      return false;
    }
    return /supabase\.(co|in)$/.test(host) && host !== MANIFEST_HOST;
  });
  expect(
    foreign.map((r) => `${r.method} ${r.url}`),
    `P0 ISOLATION: the browser reached a Supabase host other than the manifest's ` +
      `${MANIFEST_HOST}. A test that can reach a real project can write to it.`,
  ).toEqual([]);

  const mutations = ledger.requests.filter(
    (r) =>
      r.method !== "GET" &&
      r.method !== "HEAD" &&
      r.method !== "OPTIONS" &&
      /\/api\//.test(r.url) &&
      !/\/api\/pipeline\/recover-stuck/.test(r.url),
  );
  expect(
    mutations.map((r) => `${r.method} ${r.url}`),
    "P0 ISOLATION: this spec sent a mutating request to the engine. It is read-only by law.",
  ).toEqual([]);
}

// ── the card ───────────────────────────────────────────────────────────

interface Card {
  source?: string;
  accounts?: string;
  period?: string;
  method?: string;
  pack?: string;
  /** "computed … · snapshot …" */
  tail?: string;
  /** The full-precision first line, when the card carries one. */
  exact?: string;
  text: string;
}

/** Open the affordance on `el` by FOCUS (no delay) and read the card
 *  back. Falls back to hover when focus did not open it, and reports
 *  which mechanism worked so a focus regression is visible in the log. */
async function readCard(page: Page, el: Locator): Promise<Card & { via: "focus" | "hover" }> {
  await el.scrollIntoViewIfNeeded();
  const tooltip = page.locator(A.tooltip).last();
  let via: "focus" | "hover" = "focus";
  await el.focus();
  const opened = await tooltip
    .waitFor({ state: "visible", timeout: 1_500 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    via = "hover";
    await el.hover();
    await tooltip.waitFor({ state: "visible", timeout: 2_500 });
  }
  const card = await tooltip.evaluate((root) => {
    const norm = (s: string | null | undefined) =>
      (s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
    const out: Record<string, string> = { text: norm(root.textContent) };
    for (const row of Array.from(root.querySelectorAll("dl > div"))) {
      const dt = row.querySelector("dt");
      const dd = row.querySelector("dd");
      if (dt && dd) {
        out[norm(dt.textContent).toLowerCase()] = norm(dd.textContent);
      } else if (!dt) {
        const t = norm(row.textContent);
        if (/computed|snapshot/.test(t)) out.tail = t;
      }
    }
    // The exact line is the only child of the card that precedes the <dl>.
    const dl = root.querySelector("dl");
    const first = dl?.previousElementSibling;
    if (first) out.exact = norm(first.textContent);
    return out;
  });
  // Close it and WAIT for it to be gone, so the next read cannot see
  // this card and call it the next figure's.
  await page.keyboard.press("Escape");
  await el.evaluate((n) => (n as HTMLElement).blur());
  await page.mouse.move(2, 2);
  await page
    .locator(A.tooltip)
    .first()
    .waitFor({ state: "hidden", timeout: 2_500 })
    .catch(() => {});
  return { ...(card as unknown as Card), via };
}

/** A Source that names a PERIOD is the fabrication that shipped. */
const PERIOD_LIKE =
  /^(FY\s?\d{2,4}|\d{4}|[QH][1-4]\s?\d{4}|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\d{4}-\d{2}(-\d{2})?)$/i;

function cardHasSubstance(c: Card): boolean {
  return Boolean(c.source || c.accounts || c.method || c.pack || (c.tail && /snapshot/.test(c.tail)));
}

/** The universal laws every card obeys, whatever the surface. */
function commonProblems(where: string, c: Card): string[] {
  const out: string[] = [];
  if (!cardHasSubstance(c)) out.push(`${where}: EMPTY card — ${c.text}`);
  if (c.source && PERIOD_LIKE.test(c.source)) out.push(`${where}: Source names a PERIOD (${c.source})`);
  return out;
}

/** Does a finding's line_ref land on something the envelope actually
 *  holds? Exact code, a class/prefix ("531" → 5311, 5314; "4" → 4xx), or
 *  a class range ("1-5"). */
function lineRefResolves(ref: string): boolean {
  const r = ref.trim();
  if (!r) return false;
  const universe = [ENVELOPE_CODES, ENVELOPE_LEAVES, CLASSIFIED_CODES];
  if (universe.some((set) => set.has(r))) return true;
  const range = /^(\d)-(\d)$/.exec(r);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    for (const set of universe) {
      for (const c of set) {
        const k = Number(c[0]);
        if (k >= lo && k <= hi) return true;
      }
    }
    return false;
  }
  for (const set of universe) for (const c of set) if (c.startsWith(r)) return true;
  return false;
}

/** A field path the card names (`assembled_pl.revenue`,
 *  `statements.balanceSheet.cash`, `canonical_bs.difference`), resolved
 *  against the SERVED fixture. `found` is false when any segment is
 *  absent — an absent field wearing a source is the LACKS_SHOWS
 *  fabrication (`?? 0`) the census could not see inside a HAS_SHOWS file. */
function resolveField(path: string): { found: boolean; value: unknown } {
  const segs = path.split(".").filter(Boolean);
  const roots: unknown[] = [FIXTURE.statements, FIXTURE];
  for (const root of roots) {
    let cur: unknown = root;
    let ok = true;
    for (const s of segs) {
      if (cur && typeof cur === "object" && s in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[s];
      } else {
        ok = false;
        break;
      }
    }
    if (ok) return { found: true, value: cur };
  }
  return { found: false, value: undefined };
}

/** "input.xlsx · assembled_pl.revenue" → { doc, path }; a bare doc or a
 *  bare path is allowed (the dashboard's revenue names the document only,
 *  a derived figure names nothing). */
function splitSource(source: string | undefined): { doc?: string; path?: string } {
  if (!source) return {};
  const parts = source.split("·").map((s) => s.trim()).filter(Boolean);
  const out: { doc?: string; path?: string } = {};
  for (const p of parts) {
    if (/\.(xlsx|xls|csv|pdf)$/i.test(p)) out.doc = p;
    else if (/^[\w$]+(\.[\w$]+)+$/.test(p)) out.path = p;
    else if (p === SHEET) out.path = undefined;
  }
  return out;
}

/** "-3,122,134.74 RON" / "(3.1 M RON)" / "86,217,270.73" → number. */
function parseExact(s: string | undefined): number | null {
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s.trim()) || /^-|^−/.test(s.trim());
  const digits = s.replace(/[^\d.]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** The figure IS the field: equal to the cent, sign per the method
 *  ("presented negative" rows negate the served value). */
function figureMatchesField(c: Card, value: unknown): string | null {
  if (typeof value !== "number") return `field value is not a number (${JSON.stringify(value)})`;
  const shown = parseExact(c.exact);
  if (shown === null) return null; // no exact line on this card — nothing to compare
  const expected = /presented negative/.test(c.method ?? "") ? -value : value;
  if (Math.abs(shown - expected) > 0.005) {
    return `figure ${c.exact} is not the field's value ${expected}`;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// P0 — anchors, isolation, and "the fixture was actually served"
// ══════════════════════════════════════════════════════════════════════

test.describe("P0 — anchors resolve and the run is isolated", () => {
  test.setTimeout(240_000);

  test("every anchor matches on the live surface; no real Supabase host; no engine mutation", async ({ page }) => {
    const ledger = await boot(page);

    // The findings PANEL lives on the overview; the statement tabs render
    // the same cards through StatementNotes, without the panel wrapper.
    await openPeriod(page);
    const found: Record<string, number> = {};
    for (const k of ["findings", "findingCard", "figureCell", "threshold", "impact", "keyMetrics", "heroVerdict", "trustDot", "capsuleTrigger"] as const) {
      found[k] = await page.locator(A[k]).count();
    }
    await openTrustReceipt(page);
    found.trustReceipt = await page.locator(A.trustReceipt).count();
    await page.keyboard.press("Escape");
    await openPeriod(page, "balance_sheet");
    for (const k of ["statement", "statementRow", "subtotalAff"] as const) found[k] = await page.locator(A[k]).count();
    await openPeriod(page, "pl");
    for (const k of ["plStatement", "plCell"] as const) found[k] = await page.locator(A[k]).count();
    await openPeriod(page, "cash_flow");
    for (const k of ["cfStatement", "cfCell"] as const) found[k] = await page.locator(A[k]).count();
    await openPeriod(page);
    await openCapsule(page);
    for (const k of ["capsule", "capsuleInput"] as const) found[k] = await page.locator(A[k]).count();
    await openRoute(page, `/report?period=${PERIOD_ID}`);
    for (const k of ["report", "reportSection"] as const) found[k] = await page.locator(A[k]).count();
    await openRoute(page, "/public-companies");
    for (const k of ["marketsOverview", "companyGrid", "companyTile", "pulseStrip", "marketTabUs"] as const) {
      found[k] = await page.locator(A[k]).count();
    }

    // FLOOR AFTER the loop, against the totals.
    expect(Object.keys(found).length, "P0 VACUITY: no anchors probed").toBeGreaterThanOrEqual(24);
    for (const [key, n] of Object.entries(found)) {
      expect(n, `P0: anchor "${key}" (${A[key as keyof typeof A]}) matched nothing`).toBeGreaterThan(0);
    }
    expect(
      ledger.periodServed,
      "P0: the fixture period was never requested — every law below would be about the wrong page",
    ).toBeGreaterThan(0);
    console.log(`[p0] anchors: ${JSON.stringify(found)} · fixture served ${ledger.periodServed}x`);
    assertIsolation(ledger);
  });
});

// ══════════════════════════════════════════════════════════════════════
// P1 — HAS provenance → the affordance is there
// ══════════════════════════════════════════════════════════════════════

test.describe("P1 — a figure WITH provenance and NO affordance fails", () => {
  test.setTimeout(150_000);

  test("statements: every account-coded row of the served envelope wears it", async ({ page }) => {
    const ledger = await boot(page);
    await openPeriod(page, "balance_sheet");

    // Every rendered row: its label, whether it renders a <button> (the
    // <LearnableNumber> rows — BSStatementView's KNOWN GAP, skipped to
    // avoid nesting interactive elements), and how many amount cells
    // carry the affordance.
    const rows = await page.locator(A.statementRow).evaluateAll((els) =>
      els.map((el) => ({
        label: (el.querySelector(".bs-label")?.textContent ?? "").replace(/\s+/g, " ").trim(),
        chip: (el.querySelector('[data-testid="account-chip"]')?.textContent ?? "").trim(),
        learnable: !!el.querySelector("button"),
        cells: el.querySelectorAll(".bs-amount").length,
        withAff: el.querySelectorAll('.bs-amount[data-provenance="true"]').length,
      })),
    );

    const missing: string[] = [];
    let matched = 0;
    for (const row of CODED_ROWS) {
      const dom = rows.find((r) => r.label.startsWith(row.label));
      if (!dom || dom.learnable) continue;
      matched += 1;
      if (dom.withAff < dom.cells) {
        missing.push(
          `"${row.label}" (accounts ${row.account_codes!.join(", ")}) — ` +
            `${dom.withAff} of ${dom.cells} amount cells carry the affordance`,
        );
      }
    }
    // FLOOR AFTER the loop: a law over zero rows is a statement about
    // nothing (TC-3).
    expect(
      matched,
      `P1[statements] VACUITY: only ${matched} account-coded envelope rows were found on ` +
        `screen (fixture holds ${CODED_ROWS.length}). The statement did not render, or ` +
        "its labels no longer match the served rows.",
    ).toBeGreaterThanOrEqual(20);
    expect(
      missing,
      "P1[statements]: rows whose payload carries account codes, a sheet, a method and a " +
        "pack render NO provenance affordance:\n  " + missing.join("\n  "),
    ).toEqual([]);
    console.log(`[p1] statements: ${matched} account-coded rows checked, 0 missing`);
    assertIsolation(ledger);
  });

  test("findings: every cited figure of a provenance-bearing finding wears it", async ({ page }) => {
    const ledger = await boot(page);
    await openPeriod(page);

    const cells = await page.locator(`${A.findings} ${A.findingCard} ${A.figureCell}`).evaluateAll(
      (els) =>
        els.map((el) => ({
          fact: el.getAttribute("data-testid") ?? "",
          rule: (el.closest('[data-testid^="fnd-card-"]')?.getAttribute("data-testid") ?? "").replace(
            /^fnd-card-/,
            "",
          ),
          withAff: !!el.querySelector('[data-provenance="true"]'),
        })),
    );

    const missing: string[] = [];
    let checked = 0;
    for (const c of cells) {
      if (!FINDING_PROVENANCE.has(c.rule)) continue;
      checked += 1;
      if (!c.withAff) missing.push(`${c.rule} → ${c.fact}`);
    }
    expect(
      checked,
      `P1[findings] VACUITY: ${checked} cited-figure cells found under findings that carry ` +
        `provenance (fixture holds ${FINDING_PROVENANCE.size} such findings). The panel did not render.`,
    ).toBeGreaterThanOrEqual(10);
    expect(
      missing,
      "P1[findings]: figures cited by a finding whose evidence names line_refs, a snapshot " +
        "and a source render NO affordance:\n  " + missing.join("\n  "),
    ).toEqual([]);
    console.log(`[p1] findings: ${checked} cited figures checked across ${FINDING_PROVENANCE.size} findings`);
    assertIsolation(ledger);
  });
});

// ══════════════════════════════════════════════════════════════════════
// P2 + P5 — no fabricated card; every reference resolves — EVERY SURFACE
// ══════════════════════════════════════════════════════════════════════

test.describe("P2/P5 — every card has substance and every reference lands", () => {
  test.setTimeout(300_000);

  test("statements: sheet, accounts, method and pack are the envelope's own", async ({ page }) => {
    const ledger = await boot(page);
    await openPeriod(page, "balance_sheet");

    const affs = page.locator(`${A.statement} ${AFF}`);
    const total = await affs.count();
    expect(total, "P2[statements] VACUITY: no affordance on the statement").toBeGreaterThan(0);

    // Every ITEM row's closing cell (odd indices are closing cells: the
    // row renders opening then closing), plus every subtotal. Reading all
    // 94 costs ~2 minutes and proves nothing the closing cell does not.
    const problems: string[] = [];
    let read = 0;
    let viaHover = 0;
    for (let i = 1; i < total; i += 2) {
      const el = affs.nth(i);
      const rowText = ((await el.evaluate((n) => n.parentElement?.textContent ?? "")) as string)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 50);
      const card = await readCard(page, el);
      read += 1;
      if (card.via === "hover") viaHover += 1;
      problems.push(...commonProblems(`"${rowText}"`, card));
      const isSubtotal = await el.evaluate((n) => !!n.closest(".bs-subtotal"));
      if (isSubtotal) {
        if (card.source !== "engine subtotal") problems.push(`"${rowText}": subtotal source is "${card.source}"`);
        if (card.accounts) problems.push(`"${rowText}": a subtotal names accounts (${card.accounts})`);
      } else {
        if (card.source !== SHEET) problems.push(`"${rowText}": source "${card.source}" is not the extraction sheet "${SHEET}"`);
        if (!card.accounts) problems.push(`"${rowText}": an item row names no accounts`);
        for (const code of (card.accounts ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
          if (!ENVELOPE_CODES.has(code)) {
            problems.push(`"${rowText}": account ${code} is NOT in the served envelope — a dangling reference`);
          }
        }
      }
      if (card.method !== METHOD) problems.push(`"${rowText}": method "${card.method}" ≠ "${METHOD}"`);
      if (card.pack !== PACK) problems.push(`"${rowText}": pack "${card.pack}" ≠ "${PACK}"`);
    }
    expect(read, "P2[statements] VACUITY: no card was read").toBeGreaterThanOrEqual(30);
    expect(
      problems,
      "P2/P5[statements]: cards with nothing behind them, or references that land nowhere:\n  " +
        problems.join("\n  "),
    ).toEqual([]);
    console.log(`[p2/p5] statements: ${read} cards read (${viaHover} needed hover), every reference resolves`);
    assertIsolation(ledger);
  });

  test("statements-pl-cf: the P&L and cash-flow tabs paint figures and wear NOTHING while HAS_MISSING", async ({ page }) => {
    // Two of the three statements were invisible to the first census. The
    // registry says HAS_MISSING for both (the payload carries account codes
    // and a document; the amounts sit inside <LearnableNumber> buttons). A
    // zero here is the LAW until that work lands — and the day it lands,
    // this test must be rewritten into a row-by-row P1, not loosened.
    const ledger = await boot(page);
    await openPeriod(page, "pl");
    const plCells = await page.locator(A.plCell).count();
    const plAff = await page.locator(`${A.plStatement} ${AFF}`).count();
    await openPeriod(page, "cash_flow");
    const cfCells = await page.locator(A.cfCell).count();
    const cfAff = await page.locator(`${A.cfStatement} ${AFF}`).count();
    expect(plCells, "P2[statements-pl] VACUITY: the P&L rendered no amount cells").toBeGreaterThanOrEqual(8);
    expect(cfCells, "P2[statements-cf] VACUITY: the cash flow rendered no amount cells").toBeGreaterThanOrEqual(8);
    expect(
      plAff,
      `P2[statements-pl]: ${plAff} affordance(s) on the P&L while the census says HAS_MISSING. Either the work ` +
        "landed (re-state the verdict, write the P1 law) or something wears a card it cannot back.",
    ).toBe(0);
    expect(
      cfAff,
      `P2[statements-cf]: ${cfAff} affordance(s) on the cash flow while the census says HAS_MISSING (same rule).`,
    ).toBe(0);
    console.log(`[p2] statements-pl-cf: P&L ${plCells} cells / ${plAff} affordances · CF ${cfCells} cells / ${cfAff} affordances (HAS_MISSING, silence is the law)`);
    assertIsolation(ledger);
  });

  test("findings: line_refs, snapshot and source are the engine's own", async ({ page }) => {
    const ledger = await boot(page);
    await openPeriod(page);

    const cells = page.locator(`${A.findings} ${A.findingCard} ${A.figureCell} ${AFF}`);
    const total = await cells.count();
    expect(total, "P2[findings] VACUITY: no affordance under findings").toBeGreaterThan(0);

    const problems: string[] = [];
    let read = 0;
    for (let i = 0; i < total; i += 1) {
      const el = cells.nth(i);
      const rule = ((await el.evaluate(
        (n) => n.closest('[data-testid^="fnd-card-"]')?.getAttribute("data-testid") ?? "",
      )) as string).replace(/^fnd-card-/, "");
      const fact = (await el.evaluate(
        (n) => n.closest('[data-testid^="fnd-figure-"]')?.getAttribute("data-testid") ?? "",
      )) as string;
      const expected = FINDING_PROVENANCE.get(rule);
      if (!expected) continue;
      const card = await readCard(page, el);
      read += 1;
      const where = `${rule} → ${fact}`;
      problems.push(...commonProblems(where, card));
      if (card.source !== expected.source) problems.push(`${where}: source "${card.source}" ≠ engine "${expected.source}"`);
      const refs = (card.accounts ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (refs.join(", ") !== expected.line_refs.join(", ")) {
        problems.push(`${where}: accounts "${card.accounts}" ≠ line_refs "${expected.line_refs.join(", ")}"`);
      }
      for (const ref of refs) {
        if (!lineRefResolves(ref)) problems.push(`${where}: line_ref "${ref}" lands on nothing in the served envelope`);
      }
      if (!card.tail || !card.tail.includes(`snapshot ${expected.snapshot_id}`)) {
        problems.push(`${where}: snapshot line "${card.tail}" does not name ${expected.snapshot_id}`);
      }
    }
    expect(read, "P2[findings] VACUITY: no card was read").toBeGreaterThanOrEqual(10);
    expect(problems, "P2/P5[findings]:\n  " + problems.join("\n  ")).toEqual([]);
    console.log(`[p2/p5] findings: ${read} cards read, every line_ref resolves in the envelope`);
    assertIsolation(ledger);
  });

  test("findings-limits: the limit names its parameter file, the observed and impact figures the finding's own evidence", async ({ page }) => {
    // The 23-site wave threaded ThresholdMeter (limit + observed) and
    // ImpactRow (both endpoints). Neither was read live before.
    const ledger = await boot(page);
    await openPeriod(page);

    const problems: string[] = [];
    let limits = 0;
    let observed = 0;
    let impacts = 0;
    const ruleOf = async (el: Locator) =>
      ((await el.evaluate(
        (n) => n.closest('[data-testid^="fnd-card-"]')?.getAttribute("data-testid") ?? "",
      )) as string).replace(/^fnd-card-/, "");

    const th = page.locator(`${A.findings} ${A.threshold} ${AFF}`);
    const nTh = await th.count();
    for (let i = 0; i < nTh; i += 1) {
      const el = th.nth(i);
      const rule = await ruleOf(el);
      const card = await readCard(page, el);
      const where = `${rule} → threshold #${i + 1}`;
      problems.push(...commonProblems(where, card));
      const limit = FINDING_THRESHOLD.get(rule);
      const prov = FINDING_PROVENANCE.get(rule);
      if (card.method?.startsWith("rule ")) {
        // LIMIT: the parameter file path, the rule as method, NO accounts
        // and NO snapshot — a limit is not measured on a balance sheet.
        limits += 1;
        if (!limit) problems.push(`${where}: a limit card on a finding the fixture gives no threshold`);
        else {
          if (card.source !== limit.source) problems.push(`${where}: limit source "${card.source}" ≠ threshold.source "${limit.source}"`);
          if (card.method !== `rule ${limit.rule_id}`) problems.push(`${where}: limit method "${card.method}" ≠ "rule ${limit.rule_id}"`);
        }
        if (card.accounts) problems.push(`${where}: a LIMIT names accounts (${card.accounts}) — a limit is not read from a cell`);
        if (card.tail && /snapshot/.test(card.tail)) problems.push(`${where}: a LIMIT names a snapshot (${card.tail})`);
      } else {
        // OBSERVED: the finding's provenance, measured by the rule.
        observed += 1;
        if (!prov) problems.push(`${where}: an observed card on a finding without evidence provenance`);
        else {
          if (card.source !== prov.source) problems.push(`${where}: observed source "${card.source}" ≠ "${prov.source}"`);
          const refs = (card.accounts ?? "").split(",").map((s) => s.trim()).filter(Boolean);
          if (refs.join(", ") !== prov.line_refs.join(", ")) problems.push(`${where}: accounts "${card.accounts}" ≠ line_refs "${prov.line_refs.join(", ")}"`);
          for (const ref of refs) if (!lineRefResolves(ref)) problems.push(`${where}: line_ref "${ref}" lands nowhere`);
          if (!card.tail?.includes(`snapshot ${prov.snapshot_id}`)) problems.push(`${where}: snapshot line "${card.tail}" does not name ${prov.snapshot_id}`);
          if (!card.method?.startsWith(`measured by rule ${rule}`)) problems.push(`${where}: observed method "${card.method}" does not say measured by rule ${rule}`);
        }
      }
    }

    const im = page.locator(`${A.findings} ${A.impact} ${AFF}`);
    const nIm = await im.count();
    for (let i = 0; i < nIm; i += 1) {
      const el = im.nth(i);
      const rule = await ruleOf(el);
      const card = await readCard(page, el);
      const where = `${rule} → impact #${i + 1}`;
      impacts += 1;
      problems.push(...commonProblems(where, card));
      const prov = FINDING_PROVENANCE.get(rule);
      const impact = FINDING_IMPACT.get(rule);
      if (!prov || !impact) {
        problems.push(`${where}: an impact card on a finding the fixture gives no provenance/impact`);
        continue;
      }
      if (card.source !== prov.source) problems.push(`${where}: source "${card.source}" ≠ "${prov.source}"`);
      const refs = (card.accounts ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (refs.join(", ") !== prov.line_refs.join(", ")) problems.push(`${where}: accounts "${card.accounts}" ≠ line_refs "${prov.line_refs.join(", ")}"`);
      if (!card.tail?.includes(`snapshot ${prov.snapshot_id}`)) problems.push(`${where}: snapshot line "${card.tail}" does not name ${prov.snapshot_id}`);
      // The method must SAY it is a projection or a baseline and name the
      // metric the engine recomputed — a reader must not mistake a
      // what-if for a reading.
      if (!card.method?.includes(impact.kind) || !card.method.includes(impact.metric)) {
        problems.push(`${where}: method "${card.method}" does not name kind "${impact.kind}" and metric "${impact.metric}"`);
      }
      if (!/baseline|projection/.test(card.method ?? "")) problems.push(`${where}: method "${card.method}" says neither baseline nor projection`);
    }

    expect(limits, "P2[findings-limits] VACUITY: no LIMIT card was read").toBeGreaterThanOrEqual(4);
    expect(observed, "P2[findings-limits] VACUITY: no OBSERVED card was read").toBeGreaterThanOrEqual(4);
    expect(impacts, "P2[findings-limits] VACUITY: no IMPACT card was read").toBeGreaterThanOrEqual(8);
    expect(problems, "P2/P5[findings-limits]:\n  " + problems.join("\n  ")).toEqual([]);
    console.log(`[p2/p5] findings-limits: ${limits} limit + ${observed} observed + ${impacts} impact cards read against the fixture's thresholds and evidence`);
    assertIsolation(ledger);
  });

  test("dashboard: every headline names the document and a field the served statements hold, and IS that field's value", async ({ page }) => {
    const ledger = await boot(page);
    await openPeriod(page);

    const all = page.locator(AFF);
    const total = await all.count();
    const problems: string[] = [];
    let read = 0;
    let withField = 0;
    for (let i = 0; i < total; i += 1) {
      const el = all.nth(i);
      const inside = await el.evaluate(
        (n, sel) => !!n.closest(sel.findings) || !!n.closest(sel.capsule),
        { findings: A.findings, capsule: A.capsule },
      );
      if (inside) continue;
      const where = ((await el.evaluate(
        (n) => (n.closest("[data-testid]") as HTMLElement | null)?.getAttribute("data-testid") ?? "figure",
      )) as string);
      const card = await readCard(page, el);
      read += 1;
      problems.push(...commonProblems(where, card));
      const { doc, path } = splitSource(card.source);
      if (card.source && !doc && !path) problems.push(`${where}: source "${card.source}" names neither the document nor a field`);
      if (doc && doc !== DOCUMENT) problems.push(`${where}: source names document "${doc}", the period's is "${DOCUMENT}"`);
      if (path) {
        withField += 1;
        const r = resolveField(path);
        if (!r.found) problems.push(`${where}: source names ${path}, which the served statements do not hold — a card over an absent field`);
        else {
          const mismatch = figureMatchesField(card, r.value);
          if (mismatch) problems.push(`${where}: ${mismatch} (${path})`);
        }
      }
      for (const code of (card.accounts ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!ENVELOPE_CODES.has(code) && !CLASSIFIED_CODES.has(code)) problems.push(`${where}: account ${code} is in neither the envelope nor the classified accounts`);
      }
      if (!card.source && !card.method) problems.push(`${where}: neither a source nor a method — a derived figure must at least say how`);
    }
    expect(read, "P2[dashboard] VACUITY: no dashboard card was read").toBeGreaterThanOrEqual(8);
    expect(withField, "P2[dashboard] VACUITY: no card named a served field — the P5 resolution proved nothing").toBeGreaterThanOrEqual(3);
    expect(problems, "P2/P5[dashboard]:\n  " + problems.join("\n  ")).toEqual([]);
    console.log(`[p2/p5] dashboard: ${read} cards read, ${withField} named a served field and matched its value`);
    assertIsolation(ledger);
  });

  test("trust-receipt: the difference row names the served envelope field, its method and its pack", async ({ page }) => {
    const ledger = await boot(page);
    await openPeriod(page);
    const sheet = await openTrustReceipt(page);
    const affs = sheet.locator(AFF);
    const total = await affs.count();
    expect(total, "P2[trust-receipt] VACUITY: the receipt carries no affordance").toBeGreaterThan(0);
    const problems: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const card = await readCard(page, affs.nth(i));
      const where = `receipt row #${i + 1}`;
      problems.push(...commonProblems(where, card));
      const { path } = splitSource(card.source);
      if (!path) problems.push(`${where}: source "${card.source}" names no field path`);
      else {
        const r = resolveField(path);
        if (!r.found) problems.push(`${where}: ${path} is not a field of the served envelope`);
        else {
          const mismatch = figureMatchesField(card, r.value);
          if (mismatch) problems.push(`${where}: ${mismatch}`);
        }
      }
      if (card.method !== METHOD) problems.push(`${where}: method "${card.method}" ≠ "${METHOD}"`);
      if (card.pack !== PACK) problems.push(`${where}: pack "${card.pack}" ≠ "${PACK}"`);
    }
    expect(problems, "P2/P5[trust-receipt]:\n  " + problems.join("\n  ")).toEqual([]);
    console.log(`[p2/p5] trust-receipt: ${total} card(s) read; difference = ${ENVELOPE.difference}`);
    assertIsolation(ledger);
  });

  test("report: every row names a field of the served statements and IS its value; no absent field wears a source", async ({ page }) => {
    // The `?? 0` fabrication lived here: 23 rows painted "0" with
    // "Source: input.xlsx · assembled_cf.<field>" for fields the envelope
    // never carried. Reading every card against the fixture is the only
    // test that cannot be fooled by a fallback.
    const ledger = await boot(page);
    await openRoute(page, `/report?period=${PERIOD_ID}`);
    const root = page.locator(A.report);
    await expect(root, "P2[report]: the report did not render").toBeVisible({ timeout: ACTION_MS });
    const affs = root.locator(AFF);
    const total = await affs.count();
    expect(total, "P2[report] VACUITY: no affordance on the report").toBeGreaterThan(0);

    const problems: string[] = [];
    let read = 0;
    let withField = 0;
    const approximated = FIXTURE.statements.assembled_cf.is_approximated === true;
    for (let i = 0; i < total; i += 1) {
      const el = affs.nth(i);
      const where = ((await el.evaluate(
        (n) =>
          `${(n.closest('[data-testid^="report-section-"]') as HTMLElement | null)?.getAttribute("data-testid") ?? "?"} · ` +
          `${(n.closest("tr")?.querySelector("td")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 32)}`,
      )) as string);
      const card = await readCard(page, el);
      read += 1;
      problems.push(...commonProblems(where, card));
      const { doc, path } = splitSource(card.source);
      if (doc && doc !== DOCUMENT) problems.push(`${where}: document "${doc}" ≠ "${DOCUMENT}"`);
      if (card.source && !path) problems.push(`${where}: source "${card.source}" names no field path`);
      if (path) {
        withField += 1;
        const r = resolveField(path);
        if (!r.found) problems.push(`${where}: source names ${path}, which the served statements DO NOT HOLD — a figure the payload never carried, wearing a source`);
        else {
          const mismatch = figureMatchesField(card, r.value);
          if (mismatch) problems.push(`${where}: ${mismatch} (${path})`);
        }
        if (path.startsWith("assembled_cf.") && approximated && !/approximated/.test(card.method ?? "")) {
          problems.push(`${where}: a cash-flow row over an approximated envelope does not say so (method "${card.method}")`);
        }
      } else if (!card.method) {
        problems.push(`${where}: neither a field nor a method`);
      }
    }
    expect(read, "P2[report] VACUITY: no card was read").toBeGreaterThanOrEqual(30);
    expect(withField, "P2[report] VACUITY: no card named a field").toBeGreaterThanOrEqual(25);
    expect(problems, "P2/P5[report]:\n  " + problems.join("\n  ")).toEqual([]);
    console.log(`[p2/p5] report: ${read} cards read, ${withField} named a served field and matched its value to the cent`);
    assertIsolation(ledger);
  });

  test("Capsule: the resting tiles and the Tier-0 answer name the sheet and real accounts", async ({ page }) => {
    const ledger = await boot(page);
    await openPeriod(page);
    const overlay = await openCapsule(page);

    const problems: string[] = [];
    let read = 0;
    const check = async (el: Locator, where: string, requireAccounts: boolean) => {
      const card = await readCard(page, el);
      read += 1;
      problems.push(...commonProblems(where, card));
      if (!card.source || !card.source.includes(`sheet ${SHEET}`)) {
        problems.push(`${where}: source "${card.source}" does not name the extraction sheet "${SHEET}"`);
      }
      const codes = (card.accounts ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (requireAccounts && codes.length === 0) problems.push(`${where}: an account-level tile names no accounts`);
      for (const c of codes) {
        if (!ENVELOPE_CODES.has(c)) problems.push(`${where}: account ${c} is NOT in the served envelope`);
      }
      if (!card.method) problems.push(`${where}: no method`);
    };

    const tiles = overlay.locator(AFF);
    const nTiles = await tiles.count();
    for (let i = 0; i < nTiles; i += 1) await check(tiles.nth(i), `resting tile #${i + 1}`, false);

    // Tier 0: answered from the local index, no request, no spend.
    await page.locator(A.capsuleInput).first().fill("total assets", { timeout: ACTION_MS });
    const tier0 = page.locator(A.tier0).first();
    await expect(tier0, "P2[capsule]: no Tier-0 answer for a fact the index holds").toBeVisible({ timeout: 8_000 });
    const answerAffs = tier0.locator(AFF);
    const nAns = await answerAffs.count();
    expect(nAns, "P2[capsule] VACUITY: the Tier-0 answer painted no provenance-bearing figure").toBeGreaterThan(0);
    for (let i = 0; i < nAns; i += 1) await check(answerAffs.nth(i), `tier-0 figure #${i + 1}`, false);

    expect(read, "P2[capsule] VACUITY: no card was read").toBeGreaterThanOrEqual(2);
    expect(problems, "P2/P5[capsule]:\n  " + problems.join("\n  ")).toEqual([]);
    console.log(`[p2/p5] capsule: ${nTiles} tiles + ${nAns} answer figure(s) read`);
    assertIsolation(ledger);
  });

  test("public-companies: SEC concept and accession are the companyfacts document's own", async ({ page, request }) => {
    const ledger = await boot(page);
    const doc = await openAaplDocument(page);

    // The authority: the same store the page read, fetched directly.
    const res = await request.get(`${ENGINE}/api/public/markets/company/us/AAPL`);
    expect(res.ok(), "P5[public-companies]: the engine's public-market store did not answer for us/AAPL").toBe(true);
    const body = (await res.json()) as {
      envelope: { figures: Record<string, { provenance?: Record<string, unknown> }> };
    };
    const figures = Object.values(body.envelope.figures);
    const byConcept = new Map(
      figures
        .filter((f) => typeof f.provenance?.concept === "string")
        .map((f) => [f.provenance!.concept as string, f.provenance!] as const),
    );
    expect(byConcept.size, "P5[public-companies] VACUITY: the document carries no figure provenance").toBeGreaterThan(0);

    const affs = doc.locator(AFF);
    const total = await affs.count();
    expect(total, "P2[public-companies] VACUITY: no affordance on the document").toBeGreaterThan(0);
    const problems: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const el = affs.nth(i);
      const label = ((await el.evaluate((n) => n.closest("div")?.parentElement?.textContent ?? "")) as string)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 30);
      const card = await readCard(page, el);
      const where = `figure #${i + 1} (${label})`;
      problems.push(...commonProblems(where, card));
      const concept = (card.source ?? "").split("·").map((s) => s.trim()).pop() ?? "";
      const prov = byConcept.get(concept);
      if (!prov) {
        problems.push(`${where}: source "${card.source}" names concept "${concept}", which is not a figure in the document`);
        continue;
      }
      if (card.method !== prov.form) problems.push(`${where}: method "${card.method}" ≠ form "${String(prov.form)}"`);
      const accession = String(prov.accession_or_version ?? prov.accession ?? "");
      if (!card.tail || !card.tail.includes(`snapshot ${accession}`)) {
        problems.push(`${where}: snapshot line "${card.tail}" does not name accession ${accession}`);
      }
    }
    expect(problems, "P2/P5[public-companies]:\n  " + problems.join("\n  ")).toEqual([]);
    console.log(`[p2/p5] public-companies: ${total} cards read against ${byConcept.size} documented concepts`);
    assertIsolation(ledger);
  });

  test("markets-overview: every tile figure names the feed row's own source; no zero stands in for an absent change; no `computed` is the engine's process clock", async ({ page, request }) => {
    // Three of the wave's sites (MarketsOverview, PeerSuggestRail,
    // MarketPulseStrip) were never read live. Two of the critics'
    // fabrications lived here: `priceChangePct ?? 0` painting "+0.00%"
    // with a source for rows the feed gave no change, and `lastUpdated`
    // stamped with the process clock at engine boot (bvb_seed.py,
    // demo_universe.py) and shown as "computed …".
    const ledger = await boot(page);
    await openRoute(page, "/public-companies");
    const grid = page.locator(A.companyGrid);
    await expect(grid, "P2[markets-overview]: the company grid did not render").toBeVisible({ timeout: ACTION_MS });

    // The authority: the same feed the page painted.
    const res = await request.get(`${ENGINE}/api/public/universe`);
    expect(res.ok(), "P5[markets-overview]: /api/public/universe did not answer").toBe(true);
    const body = (await res.json()) as {
      companies: Array<{
        ticker: string;
        source?: string;
        latestPeriod?: string | null;
        lastUpdated?: string | null;
        priceChangePct?: number | null;
        marketCap?: number | null;
        price?: number | null;
      }>;
    };
    const rows = new Map(body.companies.map((r) => [r.ticker, r]));
    expect(rows.size, "P5[markets-overview] VACUITY: the universe is empty").toBeGreaterThan(0);
    // The process-clock signature: a `lastUpdated` shared, to the SECOND,
    // by (almost) every row of the feed is the moment the engine booted,
    // not the moment any snapshot was taken.
    const bySecond = new Map<string, number>();
    for (const r of body.companies) {
      if (!r.lastUpdated) continue;
      const k = r.lastUpdated.slice(0, 19);
      bySecond.set(k, (bySecond.get(k) ?? 0) + 1);
    }
    const clockSeconds = new Set([...bySecond].filter(([, n]) => n >= Math.max(10, body.companies.length * 0.5)).map(([k]) => k));

    const tiles = grid.locator(A.companyTile);
    const nTiles = await tiles.count();
    expect(nTiles, "P2[markets-overview] VACUITY: no company tiles").toBeGreaterThan(0);
    const problems: string[] = [];
    let read = 0;
    let zeroChecks = 0;
    for (let i = 0; i < nTiles; i += 1) {
      const tile = tiles.nth(i);
      const ticker = ((await tile.getAttribute("data-testid")) ?? "").replace("company-grid-tile-", "");
      const row = rows.get(ticker);
      if (!row) {
        problems.push(`${ticker}: a tile for a ticker the feed does not hold`);
        continue;
      }
      const affs = tile.locator(AFF);
      const n = await affs.count();
      for (let j = 0; j < n; j += 1) {
        const el = affs.nth(j);
        const text = ((await el.textContent()) ?? "").replace(/\s+/g, " ").trim();
        const card = await readCard(page, el);
        read += 1;
        const where = `${ticker} "${text}"`;
        problems.push(...commonProblems(where, card));
        if (card.source !== row.source) problems.push(`${where}: source "${card.source}" ≠ the row's feed "${row.source}"`);
        if (card.period && card.period !== row.latestPeriod) problems.push(`${where}: period "${card.period}" ≠ the row's latestPeriod "${row.latestPeriod}"`);
        const computed = /computed (\S+)/.exec(card.tail ?? "")?.[1];
        if (computed && clockSeconds.has(computed.slice(0, 19))) {
          problems.push(`${where}: computed ${computed} is the engine's PROCESS CLOCK (shared to the second by ${bySecond.get(computed.slice(0, 19))} of ${body.companies.length} feed rows) — not a snapshot time`);
        }
        // A percentage figure on a row whose feed carries no change is a
        // zero wearing a source.
        if (/%$/.test(text)) {
          zeroChecks += 1;
          if (row.priceChangePct == null) problems.push(`${where}: the feed row has NO priceChangePct, yet a change figure wears the affordance — ABSENT is not ZERO`);
        }
      }
    }
    // The pulse median: a derivation that names its sample and no source.
    const pulse = page.locator(`${A.pulseStrip} ${AFF}`);
    const nPulse = await pulse.count();
    for (let i = 0; i < nPulse; i += 1) {
      const card = await readCard(page, pulse.nth(i));
      read += 1;
      problems.push(...commonProblems("pulse median", card));
      if (card.source) problems.push(`pulse median: a derived median claims a source (${card.source})`);
      if (!/derived · median day change over \d+ quoted rows/.test(card.method ?? "")) problems.push(`pulse median: method "${card.method}" does not name the derivation and its sample`);
    }
    expect(read, "P2[markets-overview] VACUITY: no card was read").toBeGreaterThanOrEqual(30);
    expect(zeroChecks, "P2[markets-overview] VACUITY: no change figure was checked against its row").toBeGreaterThanOrEqual(10);
    expect(problems, "P2/P5[markets-overview]:\n  " + problems.join("\n  ")).toEqual([]);
    console.log(`[p2/p5] markets-overview: ${read} cards over ${nTiles} tiles read against ${rows.size} feed rows (${zeroChecks} change figures checked; ${clockSeconds.size} process-clock second(s) in the feed)`);
    assertIsolation(ledger);
  });

  test("silent surfaces: variance, scenarios and settings paint figures and wear NOTHING", async ({ page }) => {
    // LACKS_SILENT / HAS_MISSING surfaces: a zero is the law, and a page
    // that did not render is not a zero (the heading is asserted first).
    const ledger = await boot(page);
    const counts: Record<string, number> = {};
    for (const [name, path] of [
      ["variance", `/dashboard/variance?period=${PERIOD_ID}`],
      ["scenarios", `/dashboard/scenarios?period=${PERIOD_ID}`],
      ["settings", "/settings"],
    ] as const) {
      await openRoute(page, path);
      const h1 = ((await page.locator("h1").first().textContent().catch(() => "")) ?? "").trim();
      expect(h1, `P2[${name}] VACUITY: the page rendered no heading`).not.toBe("");
      counts[name] = await page.locator(AFF).count();
      expect(counts[name], `P2[${name}]: ${counts[name]} affordance(s) on a surface the census says claims nothing (${h1})`).toBe(0);
    }
    console.log(`[p2] silent: ${JSON.stringify(counts)} — zero is the law on these`);
    assertIsolation(ledger);
  });
});

// ══════════════════════════════════════════════════════════════════════
// P3 — focus works like hover; Escape dismisses
// ══════════════════════════════════════════════════════════════════════

test.describe("P3 — hover, a real Tab keystroke, and Escape", () => {
  test.setTimeout(150_000);

  test("a statement figure opens on hover, opens on Tab-focus, and closes on Escape", async ({ page }) => {
    const ledger = await boot(page);
    await openPeriod(page, "balance_sheet");

    const affs = page.locator(`${A.statement} ${AFF}`);
    expect(await affs.count(), "P3 VACUITY: no affordance to drive").toBeGreaterThan(1);
    const first = affs.nth(0);
    const second = affs.nth(1);
    await second.scrollIntoViewIfNeeded();

    // HOVER opens; leaving closes. The pointer leaves STRAIGHT DOWN, in
    // steps: the card opens to the LEFT of a statement cell, and a jump
    // towards the top-left corner crosses Radix's grace area between the
    // trigger and its content, which keeps the card open by design
    // (measured: move(2,2) left it open; 200 px straight down closed it).
    await second.hover();
    const tip = page.locator(A.tooltip).last();
    await expect(tip, "P3: hovering the figure did not open the card").toBeVisible({ timeout: 3_000 });
    const box = (await second.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200, { steps: 15 });
    await expect(page.locator(A.tooltip).first(), "P3: the card did not close when the pointer left").toBeHidden({ timeout: 3_000 });

    // A REAL TAB from the previous figure must land here. `tabIndex={0}`
    // is what makes that true; dispatching a synthetic focus event would
    // pass with it deleted.
    await first.focus();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    const landed = await second.evaluate((n) => document.activeElement === n);
    expect(landed, "P3: Tab from the previous figure did not reach this one — it is not in the tab order").toBe(true);
    await expect(page.locator(A.tooltip).last(), "P3: focus did not open the card").toBeVisible({ timeout: 3_000 });

    // ESCAPE dismisses the card and leaves focus where it was.
    await page.keyboard.press("Escape");
    await expect(page.locator(A.tooltip).first(), "P3: Escape did not dismiss the card").toBeHidden({ timeout: 3_000 });
    expect(await second.evaluate((n) => document.activeElement === n), "P3: Escape moved focus").toBe(true);
    assertIsolation(ledger);
  });
});

// ══════════════════════════════════════════════════════════════════════
// P4 — PER-SURFACE FLOORS (TC-6): one test per surface, each named
// ══════════════════════════════════════════════════════════════════════

function floorMessage(surface: Surface, count: number): string {
  return (
    `P4[${surface}]: the ${surface} surface renders ${count} provenance affordance(s), ` +
    `floor ${SURFACE_FLOORS[surface]}. A total across surfaces would not have said which ` +
    "one lost its dots; this one did."
  );
}

test.describe("P4 — each surface keeps its own floor", () => {
  test.setTimeout(150_000);

  test("P4[statements]", async ({ page }) => {
    const ledger = await boot(page);
    await openPeriod(page, "balance_sheet");
    const n = await page.locator(`${A.statement} ${AFF}`).count();
    console.log(`[p4] statements=${n} floor=${SURFACE_FLOORS.statements}`);
    expect(n, floorMessage("statements", n)).toBeGreaterThanOrEqual(SURFACE_FLOORS.statements);
    assertIsolation(ledger);
  });

  test("P4[findings]", async ({ page }) => {
    const ledger = await boot(page);
    await openPeriod(page);
    const n = await page.locator(`${A.findings} ${AFF}`).count();
    console.log(`[p4] findings=${n} floor=${SURFACE_FLOORS.findings}`);
    expect(n, floorMessage("findings", n)).toBeGreaterThanOrEqual(SURFACE_FLOORS.findings);
    assertIsolation(ledger);
  });

  test("P4[capsule]", async ({ page }) => {
    const ledger = await boot(page);
    await openPeriod(page);
    const overlay = await openCapsule(page);
    const n = await overlay.locator(AFF).count();
    console.log(`[p4] capsule=${n} floor=${SURFACE_FLOORS.capsule}`);
    expect(n, floorMessage("capsule", n)).toBeGreaterThanOrEqual(SURFACE_FLOORS.capsule);
    assertIsolation(ledger);
  });

  test("P4[public-companies]", async ({ page }) => {
    const ledger = await boot(page);
    const doc = await openAaplDocument(page);
    const n = await doc.locator(AFF).count();
    console.log(`[p4] public-companies=${n} floor=${SURFACE_FLOORS["public-companies"]}`);
    expect(n, floorMessage("public-companies", n)).toBeGreaterThanOrEqual(SURFACE_FLOORS["public-companies"]);
    assertIsolation(ledger);
  });

  test("P4[dashboard]", async ({ page }) => {
    const ledger = await boot(page);
    await openPeriod(page);
    // The dashboard surface is the overview MINUS the findings panel and
    // the Capsule: the headline figures (KeyMetricsRow / StoryOverview),
    // the configurable tiles (MetricCard), the hero verdict.
    const n = await dashboardAffordances(page);
    console.log(`[p4] dashboard=${n} floor=${SURFACE_FLOORS.dashboard}`);
    expect(n, floorMessage("dashboard", n)).toBeGreaterThanOrEqual(SURFACE_FLOORS.dashboard);
    assertIsolation(ledger);
  });

  test("P4[trust-receipt]", async ({ page }) => {
    const ledger = await boot(page);
    await openPeriod(page);
    const sheet = await openTrustReceipt(page);
    const n = await sheet.locator(AFF).count();
    console.log(`[p4] trust-receipt=${n} floor=${SURFACE_FLOORS["trust-receipt"]}`);
    expect(n, floorMessage("trust-receipt", n)).toBeGreaterThanOrEqual(SURFACE_FLOORS["trust-receipt"]);
    assertIsolation(ledger);
  });

  test("P4[report]", async ({ page }) => {
    const ledger = await boot(page);
    await openRoute(page, `/report?period=${PERIOD_ID}`);
    const n = await page.locator(`${A.report} ${AFF}`).count();
    console.log(`[p4] report=${n} floor=${SURFACE_FLOORS.report}`);
    expect(n, floorMessage("report", n)).toBeGreaterThanOrEqual(SURFACE_FLOORS.report);
    assertIsolation(ledger);
  });

  test("P4[markets-overview]", async ({ page }) => {
    const ledger = await boot(page);
    await openRoute(page, "/public-companies");
    const n = await page.locator(`${A.marketsOverview} ${AFF}, ${A.pulseStrip} ${AFF}`).count();
    console.log(`[p4] markets-overview=${n} floor=${SURFACE_FLOORS["markets-overview"]}`);
    expect(n, floorMessage("markets-overview", n)).toBeGreaterThanOrEqual(SURFACE_FLOORS["markets-overview"]);
    assertIsolation(ledger);
  });
});

// ══════════════════════════════════════════════════════════════════════
// UNWITNESSED — surfaces with NO runtime path on this stack, as a state
// ══════════════════════════════════════════════════════════════════════
//
// A surface the census records as HAS_SHOWS but nothing has ever painted
// in a browser is a claim, not evidence. These tests do not pass for it;
// they PROBE the one precondition that blocks a witness and print
// UNWITNESSED while it holds. The day it lifts, the test FAILS with the
// instruction to write the witness — so an excuse cannot outlive its
// reason (TC-9: a clean result must be distinguishable from no subject).

// ══════════════════════════════════════════════════════════════════════
// P7 — AN ABSENT LEAF IS STILL ABSENT IN THE DOM, AND WEARS NO CARD
// ══════════════════════════════════════════════════════════════════════
//
// Every probe above this asks: does a figure that HAS provenance show the
// affordance? That is one direction. It cannot see the opposite failure,
// and the opposite failure is the one that shipped:
//
//   frontend/lib/buildBsStatement.ts   `opening: row.opening ?? row.amount`
//
// The BUILDER substituted closing for an absent opening, so by the time
// any component saw it the value was a finite number, every guard in
// ProvenanceAffordance correctly waved it through, and 47 opening cells
// wore data-provenance="true" naming sheet `Balanta`, account 211, method
// `deterministic`, pack `ro_omfp1802_v2` — for a balance that is in none
// of them. The column header said 01.01.2025 and the delta column read 0.
// P1 was green throughout: the cells DID have cards, which is exactly what
// P1 asks.
//
// THE FIXTURE IS THE INSTRUMENT. `carniprod_period.json` is real engine
// output and it serves `opening: null` on ALL 44 rows — so the entire
// opening column is a column of absent leaves, and the correct render is
// 44 gap glyphs and zero cards. This test drives the real builder through
// the real BSStatementView into a real DOM and asserts exactly that.
//
// It is the direction a static census structurally cannot have: the census
// checks that a site RECORDS a verdict, never that the number arriving
// there is one the engine served.
test.describe("P7 — an absent served leaf must not paint, and must not claim", () => {
  test.setTimeout(150_000);

  test("statements: the opening column is absent in the fixture and absent on screen", async ({
    page,
  }) => {
    const ledger = await boot(page);
    await openPeriod(page, "balance_sheet");

    // The fixture's own witness: if a future fixture DID carry openings,
    // this test would be asserting nothing, so it says so and stops.
    const servedOpenings = ENVELOPE.rows.filter(
      (r) => (r as { opening?: number | null }).opening != null,
    ).length;
    expect(
      servedOpenings,
      `P7 PRECONDITION LOST: the fixture now serves ${servedOpenings} opening balance(s). ` +
        "This test exists because it served NONE — rewrite it against the new envelope " +
        "rather than letting it assert a column that is no longer absent.",
    ).toBe(0);

    const rows = await page.locator(A.statementRow).evaluateAll((els) =>
      els.map((el) => {
        const cells = Array.from(el.querySelectorAll(".bs-amount"));
        return {
          label: (el.querySelector(".bs-label")?.textContent ?? "").replace(/\s+/g, " ").trim(),
          learnable: !!el.querySelector("button"),
          n: cells.length,
          openingText: (cells[0]?.textContent ?? "").replace(/\s+/g, " ").trim(),
          closingText: (cells[1]?.textContent ?? "").replace(/\s+/g, " ").trim(),
          openingClaims: cells[0]?.getAttribute("data-provenance") === "true",
        };
      }),
    );

    // Only rows that render BOTH amount cells through the plain path are
    // in scope; a <LearnableNumber> row renders buttons, not .bs-amount.
    const inScope = rows.filter((r) => !r.learnable && r.n === 2);

    const claimed: string[] = [];
    const painted: string[] = [];
    for (const r of inScope) {
      if (r.openingClaims) {
        claimed.push(
          `"${r.label}" — opening cell carries data-provenance="true" over a balance the ` +
            "envelope served as null",
        );
      }
      // A substituted closing is the exact shape of the shipped defect:
      // an opening that is not absent AND equals its own closing.
      if (r.openingText !== "" && r.openingText === r.closingText) {
        painted.push(`"${r.label}" — opening "${r.openingText}" equals closing`);
      }
    }

    // FLOORS AFTER THE LOOP (TC-3): a law over zero rows is a statement
    // about nothing, and this whole block would pass on a blank page.
    expect(
      inScope.length,
      `P7[statements] VACUITY: only ${inScope.length} plain amount rows were found on ` +
        `screen (the envelope holds ${ENVELOPE.rows.length}). The statement did not ` +
        "render, or the .bs-amount contract moved.",
    ).toBeGreaterThanOrEqual(20);

    expect(
      claimed,
      "P7[statements] A FABRICATED CARD: opening cells offer a provenance jump for a " +
        "balance the envelope never carried. ABSENT is not ZERO, and a gap wearing a " +
        "Source teaches the reader every Source is decoration:\n  " + claimed.join("\n  "),
    ).toEqual([]);

    expect(
      painted,
      "P7[statements] A SUBSTITUTED FIGURE: the opening column paints a number equal to " +
        "closing while the envelope serves opening: null on every row — the " +
        "`row.opening ?? row.amount` shape, or one like it, is back in the builder:\n  " +
        painted.join("\n  "),
    ).toEqual([]);

    console.log(
      `[p7] statements: ${inScope.length} plain rows; opening served null x` +
        `${ENVELOPE.rows.length}; 0 cards claimed, 0 figures substituted`,
    );
    assertIsolation(ledger);
  });
});

test.describe("UNWITNESSED — a printed state, not a pass", () => {
  test.setTimeout(60_000);

  const unwitnessed = (surface: string, why: string) => {
    test.info().annotations.push({ type: "unwitnessed", description: `${surface}: ${why}` });
    console.log(`[unwitnessed] ${surface} — ${why}`);
  };

  test("public-company-dashboard (PublicCompanyDashboard.tsx, 10 affordances): needs a Nasdaq key", async ({ request }) => {
    const res = await request.get(`${ENGINE}/api/public/companies/AAPL`);
    const body = await res.text();
    if (res.status() === 503 && /nasdaq_key_missing/.test(body)) {
      unwitnessed("public-company-dashboard", `/api/public/companies/AAPL answers 503 nasdaq_key_missing on this stack`);
      return;
    }
    expect.soft(false, `the precondition LIFTED: /api/public/companies/AAPL answered ${res.status()}. Write the P2/P5 witness for /dashboard/public/AAPL now — do not keep this excuse.`).toBe(true);
  });

  test("benchmark (BenchmarkReport.tsx, 3 affordances): the report endpoint refuses the test identity", async ({ request }) => {
    const res = await request.get(`${ENGINE}/api/benchmarks/report/${PERIOD_ID}`);
    if (res.status() === 401) {
      unwitnessed("benchmark", `/api/benchmarks/report/{period} answers 401 (Missing Bearer token) on this stack`);
      return;
    }
    expect.soft(false, `the precondition LIFTED: /api/benchmarks/report answered ${res.status()}. Write the P2/P5 witness for /benchmark now.`).toBe(true);
  });

  test("products (Products.tsx, 8 affordances): no sales dataset in the test workspace", async ({ request }) => {
    const res = await request.get(`${ENGINE}/api/sales-datasets`);
    const body = (await res.json().catch(() => ({}))) as { datasets?: unknown[] };
    if (res.ok() && Array.isArray(body.datasets) && body.datasets.length === 0) {
      unwitnessed("products", "/api/sales-datasets answers {datasets: []} — the SKU table needs one, and this spec must not upload");
      return;
    }
    expect.soft(false, `the precondition LIFTED: /api/sales-datasets answered ${res.status()} with ${JSON.stringify(body).slice(0, 80)}. Write the P2/P5 witness for /products now.`).toBe(true);
  });

  test("multi-year-history (MultiYearHistory.tsx, 7 affordances): the route is compile-gated off", async () => {
    const features = readFileSync(resolve(REPO, "frontend/config/features.ts"), "utf-8");
    const off = /export const PUBLIC_RECORDS_ENABLED = false/.test(features);
    if (off) {
      unwitnessed("multi-year-history", "config/features.ts: PUBLIC_RECORDS_ENABLED = false — /multi-year-history redirects to /dashboard");
      return;
    }
    expect.soft(false, "the precondition LIFTED: PUBLIC_RECORDS_ENABLED is no longer false. Write the P2/P5 witness for /multi-year-history now.").toBe(true);
  });

  test("decisions-alerts (Alerts.tsx / Decisions.tsx, LACKS_SILENT): the routes are compile-gated off", async () => {
    const features = readFileSync(resolve(REPO, "frontend/config/features.ts"), "utf-8");
    const off = /export const DECISIONS_ALERTS_ENABLED = false/.test(features);
    if (off) {
      unwitnessed("decisions-alerts", "config/features.ts: DECISIONS_ALERTS_ENABLED = false — /decisions and /alerts redirect to /dashboard");
      return;
    }
    expect.soft(false, "the precondition LIFTED: DECISIONS_ALERTS_ENABLED is no longer false. Add /decisions and /alerts to the silent-surfaces law now.").toBe(true);
  });

  test("findings all-checks (AllChecksList.tsx, 2 affordances): the fixture carries no all_checks rows", async () => {
    const allChecks = FIXTURE.alerts.filter((a) => a.disposition === "all_checks").length;
    if (allChecks === 0) {
      unwitnessed("findings all-checks", "carniprod_period.json holds 0 rows with disposition all_checks — AllChecksList renders only over report.checks");
      return;
    }
    expect.soft(false, `the precondition LIFTED: the fixture now holds ${allChecks} all_checks row(s). Extend P2[findings-limits] to the fnd-all-checks list now.`).toBe(true);
  });

  test("peer-suggest-rail (PeerSuggestRail.tsx, 1 affordance): hidden without a real workspace period", async ({ page }) => {
    const ledger = await boot(page);
    await openRoute(page, "/public-companies");
    const n = await page.locator(A.peerRail).count();
    if (n === 0) {
      unwitnessed("peer-suggest-rail", "the rail renders only when a real period is loaded in the workspace; the test workspace holds none and this spec must not create one");
      assertIsolation(ledger);
      return;
    }
    expect.soft(false, "the precondition LIFTED: the peer rail rendered on /public-companies. Read its revenue card against the universe row now.").toBe(true);
    assertIsolation(ledger);
  });

  test("marketing-ops (Landing.tsx, LACKS_SILENT): test mode signs the visitor in and redirects `/` to the dashboard", async ({ page }) => {
    const ledger = await boot(page);
    await openRoute(page, "/");
    if (/\/dashboard/.test(page.url())) {
      unwitnessed("marketing-ops", `/ redirected to ${new URL(page.url()).pathname} under PUBLIC_TEST_MODE — the landing page has no runtime path here`);
      assertIsolation(ledger);
      return;
    }
    expect.soft(false, `the precondition LIFTED: / stayed at ${page.url()}. Assert the landing's synthetic figures wear NO affordance now.`).toBe(true);
    assertIsolation(ledger);
  });
});

// ══════════════════════════════════════════════════════════════════════
// P8 — THE INDICATOR IS PAINTED, IN A REAL BROWSER
// ══════════════════════════════════════════════════════════════════════
//
// R10 added a jsdom render witness that the static census EXECUTES, so a
// gutted `hasProvenance` or `ProvenanceCard` can no longer reach a green
// census. jsdom proves the CLASS is applied; it cannot prove the class
// RESOLVES. `decoration-dotted decoration-brand/80` is a Tailwind utility
// — drop it from the safelist, lose it to a purge, shadow it with a later
// rule, and every affordance in the product keeps its `data-provenance`
// marker, keeps its card, and stops being visible before you hover it.
//
// That is the WCAG 1.4.11 half of this lane: the dotted rule is the only
// thing that tells a reader a figure HAS provenance, which makes it a
// non-text UI indicator at a 3:1 floor. `check_provenance_contrast.mjs`
// measures the COLOUR from the token sheet; nothing measured whether the
// line is drawn at all. This does, on the live DOM, on the two surfaces
// with the most affordances.
test.describe("P8 — the dotted rule is actually drawn, not just classed", () => {
  test.setTimeout(150_000);

  /** Computed text-decoration on the first N affordances of a locator. */
  async function decorations(scope: Locator, limit: number) {
    const els = await scope.locator(AFF).all();
    const out: { line: string; style: string; color: string }[] = [];
    for (const el of els.slice(0, limit)) {
      out.push(
        await el.evaluate((n) => {
          const s = getComputedStyle(n as HTMLElement);
          return {
            line: s.textDecorationLine,
            style: s.textDecorationStyle,
            color: s.textDecorationColor,
          };
        }),
      );
    }
    return out;
  }

  test("P8[statements] — every affordance draws a dotted underline", async ({ page }) => {
    const ledger = await boot(page);
    await openPeriod(page, "balance_sheet");
    const rows = page.locator(A.statement);
    const seen = await decorations(rows, 12);
    console.log(`[p8] statements: ${seen.length} affordance(s) measured`);
    expect(seen.length, "no affordance to measure on the statements surface").toBeGreaterThan(0);
    const bad = seen.filter((d) => !/underline/.test(d.line) || d.style !== "dotted");
    expect(
      bad.length,
      `${bad.length} of ${seen.length} affordances draw no dotted underline: ` +
        `${JSON.stringify(bad.slice(0, 3))}. The class is applied (the unit witness proves ` +
        "that); the STYLE is not resolving. A figure whose provenance is invisible until " +
        "you happen to hover it is a figure with no affordance.",
    ).toBe(0);
    // The colour is `brand/80`, never fully transparent and never the
    // inherited text colour at 40% that measured 1.78:1 in light.
    for (const d of seen) {
      expect(d.color, `decoration colour ${d.color} is transparent`).not.toMatch(
        /rgba?\([^)]*,\s*0\)$/,
      );
    }
    assertIsolation(ledger);
  });

  test("P8[findings] — same law on the findings surface", async ({ page }) => {
    const ledger = await boot(page);
    await openPeriod(page);
    const seen = await decorations(page.locator(A.findings), 12);
    console.log(`[p8] findings: ${seen.length} affordance(s) measured`);
    expect(seen.length, "no affordance to measure on the findings surface").toBeGreaterThan(0);
    const bad = seen.filter((d) => !/underline/.test(d.line) || d.style !== "dotted");
    expect(
      bad.length,
      `${bad.length} of ${seen.length} findings affordances draw no dotted underline: ` +
        `${JSON.stringify(bad.slice(0, 3))}.`,
    ).toBe(0);
    assertIsolation(ledger);
  });
});
