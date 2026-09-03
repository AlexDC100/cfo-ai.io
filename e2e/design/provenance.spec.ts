/**
 * PROVENANCE ON HOVER — the live gates P0–P5, per surface.
 *
 * ── What this file proves that the static census cannot ──────────────
 *
 * `scripts/check_provenance_census.mjs` counts `<ProvenanceAffordance`
 * tags in SOURCE. It cannot see whether the component that owns the tag
 * is the component that PAINTS the screen (TC-7), whether the card that
 * opens names an origin a reader can actually follow (P5), or whether a
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
 * The public-companies surface needs no fixture: the engine's local
 * public-market store already holds AAPL's SEC companyfacts document,
 * with a provenance block per figure, and this route never fetches from
 * the feed on a web request.
 *
 * ── The gates ────────────────────────────────────────────────────────
 *
 *   P0  anchors resolve; the run reached NO real Supabase host and
 *       performed NO engine mutation; the fixture was actually served.
 *   P1  a figure whose payload carries provenance and renders NO
 *       affordance FAILS — asserted row-by-row against the served
 *       envelope (statements) and finding-by-finding (findings).
 *   P2  a FABRICATED affordance FAILS — a card with nothing in it, a
 *       Source that names a period, or a reference that lands nowhere.
 *   P3  focus works like hover (a real Tab keystroke reaches the figure
 *       and opens the card); Escape dismisses it.
 *   P4  PER-SURFACE recorded floors (TC-6): dashboard, statements,
 *       findings, Capsule, public-companies — each its own test, each
 *       message naming the surface, so a total across surfaces cannot
 *       hide one surface losing every dot.
 *   P5  the target RESOLVES: every account the card names is in the
 *       served envelope; every sheet is the extraction's sheet; every
 *       SEC concept and accession is in the companyfacts document.
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
const FIX_DIR = resolve(HERE, "../fixtures/provenance");
const PERIOD_RAW = readFileSync(resolve(FIX_DIR, "carniprod_period.json"), "utf-8");
const PERIODS_RAW = readFileSync(resolve(FIX_DIR, "carniprod_periods.json"), "utf-8");

interface EnvelopeRow {
  id: string;
  label: string;
  account_codes?: string[];
  leaf_ids?: string[];
}
interface Fixture {
  period: { id: string };
  statements: {
    canonical_bs: {
      rows: EnvelopeRow[];
      extraction: { sheet: string; method: string };
      mapping_version: string;
    };
  };
  line_items: Array<{ ro_account_code: string }>;
  alerts: Array<{
    rule_key: string;
    contract_elements?: {
      evidence?: {
        provenance?: {
          period_id: string;
          snapshot_id: string;
          line_refs: string[];
          source: string;
        };
      };
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
  findings: '[data-testid="fnd-panel"]',
  findingCard: '[data-testid^="fnd-card-"]',
  figureCell: '[data-testid^="fnd-figure-"]',
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
  tooltip: '[role="tooltip"]',
} as const;

// ══════════════════════════════════════════════════════════════════════
// P4 — THE RECORDED EXPECTATIONS, ONE PER SURFACE (TC-6)
// ══════════════════════════════════════════════════════════════════════
//
// Floors, not equalities: a figure added to a surface must not red this
// gate, a surface losing its dots must. Each is what the committed base
// (f1e5824) is MEASURED to render against this fixture, with a margin.
//
//   statements        94 measured — 44 account-coded rows x 2 cells, minus
//                     the rows that render a <LearnableNumber> (the
//                     KNOWN GAP in BSStatementView) plus subtotals.
//   findings          18 measured — the cited-figure cells of EvidenceLine
//                     across the 5 real findings. Threshold and impact
//                     figures were HAS_MISSING at the base; a lane landing
//                     them RAISES this number and should raise the floor.
//   capsule            3 measured — the resting fact tiles; the Tier-0
//                     answer adds 1 and is asserted separately.
//   public-companies   6 measured — every figure of AAPL's companyfacts
//                     document carries a provenance block.
//   dashboard          0 at the base — KeyMetricsRow / StoryOverview /
//                     MetricCard were HAS_MISSING in the census. A floor
//                     of zero is VACUOUS and is annotated as such rather
//                     than passed off as green; the lane that threads the
//                     headline figures must raise it (measured 10 on the
//                     in-flight tree while this was written).
const SURFACE_FLOORS = {
  dashboard: 0,
  statements: 80,
  findings: 10,
  capsule: 3,
  "public-companies": 5,
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

async function openCapsule(page: Page): Promise<Locator> {
  await page.locator(A.capsuleTrigger).click({ timeout: ACTION_MS });
  const overlay = page.locator(A.capsule);
  await expect(overlay).toBeVisible({ timeout: ACTION_MS });
  await page.waitForTimeout(1_200);
  return overlay;
}

async function openAaplDocument(page: Page): Promise<Locator> {
  await page.goto("/public-companies", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS);
  await dismissPublicTestBanner(page);
  await page.locator(A.marketTabUs).click({ timeout: ACTION_MS });
  await page.locator(A.marketInput).fill("AAPL", { timeout: ACTION_MS });
  await page.locator(A.marketSubmit).click({ timeout: ACTION_MS });
  const doc = page.locator(A.marketDoc).first();
  await expect(doc).toBeVisible({ timeout: ACTION_MS });
  await page.waitForTimeout(1_000);
  return doc;
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
      (s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
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
  /^(FY\s?\d{2,4}|\d{4}|Q[1-4]\s?\d{4}|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\d{4}-\d{2}(-\d{2})?)$/i;

function cardHasSubstance(c: Card): boolean {
  return Boolean(c.source || c.accounts || c.method || c.pack || (c.tail && /snapshot/.test(c.tail)));
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

// ══════════════════════════════════════════════════════════════════════
// P0 — anchors, isolation, and "the fixture was actually served"
// ══════════════════════════════════════════════════════════════════════

test.describe("P0 — anchors resolve and the run is isolated", () => {
  test.setTimeout(150_000);

  test("every anchor matches on the live surface; no real Supabase host; no engine mutation", async ({ page }) => {
    const ledger = await boot(page);

    // The findings PANEL lives on the overview; the statement tabs render
    // the same cards through StatementNotes, without the panel wrapper.
    await openPeriod(page);
    const found: Record<string, number> = {};
    found.findings = await page.locator(A.findings).count();
    found.findingCard = await page.locator(A.findingCard).count();
    found.figureCell = await page.locator(A.figureCell).count();
    await openPeriod(page, "balance_sheet");
    found.statement = await page.locator(A.statement).count();
    found.statementRow = await page.locator(A.statementRow).count();
    found.subtotalAff = await page.locator(A.subtotalAff).count();
    found.capsuleTrigger = await page.locator(A.capsuleTrigger).count();
    await openCapsule(page);
    found.capsule = await page.locator(A.capsule).count();
    found.capsuleInput = await page.locator(A.capsuleInput).count();

    // FLOOR AFTER the loop, against the totals.
    expect(Object.keys(found).length, "P0 VACUITY: no anchors probed").toBe(9);
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
// P2 + P5 — no fabricated card; every reference resolves
// ══════════════════════════════════════════════════════════════════════

test.describe("P2/P5 — every card has substance and every reference lands", () => {
  test.setTimeout(240_000);

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
      if (!cardHasSubstance(card)) problems.push(`"${rowText}": EMPTY card — ${card.text}`);
      if (card.source && PERIOD_LIKE.test(card.source)) {
        problems.push(`"${rowText}": Source names a PERIOD (${card.source})`);
      }
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
      if (!cardHasSubstance(card)) problems.push(`${where}: EMPTY card — ${card.text}`);
      if (card.source && PERIOD_LIKE.test(card.source)) problems.push(`${where}: Source names a PERIOD (${card.source})`);
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

  test("Capsule: the resting tiles and the Tier-0 answer name the sheet and real accounts", async ({ page }) => {
    const ledger = await boot(page);
    await openPeriod(page);
    const overlay = await openCapsule(page);

    const problems: string[] = [];
    let read = 0;
    const check = async (el: Locator, where: string, requireAccounts: boolean) => {
      const card = await readCard(page, el);
      read += 1;
      if (!cardHasSubstance(card)) problems.push(`${where}: EMPTY card — ${card.text}`);
      if (card.source && PERIOD_LIKE.test(card.source)) problems.push(`${where}: Source names a PERIOD (${card.source})`);
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
      if (!cardHasSubstance(card)) problems.push(`${where}: EMPTY card — ${card.text}`);
      if (card.source && PERIOD_LIKE.test(card.source)) problems.push(`${where}: Source names a PERIOD (${card.source})`);
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
    const n = await page.evaluate(
      ({ aff, findings, capsule }) =>
        Array.from(document.querySelectorAll(aff)).filter(
          (el) => !el.closest(findings) && !el.closest(capsule),
        ).length,
      { aff: AFF, findings: A.findings, capsule: A.capsule },
    );
    console.log(`[p4] dashboard=${n} floor=${SURFACE_FLOORS.dashboard}`);
    if (SURFACE_FLOORS.dashboard === 0) {
      test.info().annotations.push({
        type: "p4-dashboard-vacuous",
        description:
          `floor is 0 — KeyMetricsRow / StoryOverview / MetricCard were HAS_MISSING in the ` +
          `census at the base commit, so this surface cannot red. Measured ${n} now; the lane ` +
          "that threads the headline figures must raise SURFACE_FLOORS.dashboard.",
      });
    }
    expect(n, floorMessage("dashboard", n)).toBeGreaterThanOrEqual(SURFACE_FLOORS.dashboard);
    assertIsolation(ledger);
  });
});
