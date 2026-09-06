/**
 * THE CAPSULE BRIEF — gates N1–N8, live browser half.
 *
 * Part F, gates lane. This lane owns no product code. It owns the proof
 * that the resting capsule EARNS ITS SPACE.
 *
 *   N1  NO RESTING DUPLICATION  no resting row's destination matches a
 *                               VISIBLE sidebar item
 *   N2  DERIVED CONTENT         every tile and chip traces to a
 *                               workspace-state computation
 *   N3  ZERO SPEND AT REST      opening and reading makes no model call
 *   N4  PROVENANCE              every tile numeral traces to a snapshot
 *                               fact; an absent value renders the GAP
 *                               STATE — never a blank, never an estimate
 *   N5  ACCOUNT LOOKUP          a code resolves from the fact index in
 *                               <100ms with provenance, or says honestly
 *                               that it is not in this period
 *   N6  HANDOFF                 on /chat the handoff FOCUSES THE
 *                               EXISTING COMPOSER; no second thread
 *   N7  ROW BUDGET              <=8 rows in any typing state; <=3 tiles
 *                               and <=3 chips at rest
 *   N8  every gate demonstrates a red, asserts a PER-COMPONENT recorded
 *       expectation, and confirms which component actually renders
 *
 * The static + pure half is `scripts/check_capsule_brief.mjs` (B1–B5):
 * the resting mount's wiring, the derivation differential, the declared
 * budgets, and account resolution against the committed real fixtures.
 *
 * ══ THE ONE DISEASE THIS FILE IS BUILT NOT TO CARRY ═══════════════════
 *
 * FOUR OF THESE SEVEN LAWS ARE BANS, and a ban is satisfied by an empty
 * surface. That is not hypothetical here — it is the measured state.
 *
 * MEASURED 2026-09-01, live stack, workspace `demo-meridian`, /chat:
 *
 *     resting overlay 680x208
 *     tiles 0 · chips 1 · jumps 0 · activatable rows 3
 *     sidebar destinations visible: 9
 *     resting rows whose destination matches a sidebar item: 0
 *
 * So N1 is ALREADY SATISFIED at HEAD — vacuously. There are no resting
 * destination rows at all, and the ban would keep passing if the whole
 * surface were deleted. TC-9 asks whether a "clean" result is
 * distinguishable from "no subject"; here, at HEAD, it is not.
 *
 * EVERY BAN IN THIS FILE IS THEREFORE PAIRED WITH TWO THINGS:
 *
 *   1. a SUBJECT FLOOR, asserted AFTER the loop that produced the count
 *      and never inside it. A law with no subject FAILS as NO-SUBJECT.
 *      It never passes.
 *   2. a POSITIVE CONTROL in the same run — the same detector pointed at
 *      a case that MUST trip it. N1's detector is run against the TYPING
 *      state, where navigation rows legitimately appear and legitimately
 *      DO match the sidebar; if it finds nothing there, the detector is
 *      blind and the resting zero means nothing.
 *
 * ══ TC-7 — WHICH COMPONENT ACTUALLY RENDERS ══════════════════════════
 *
 * A fix once landed on `CapsuleJumpList` while the nodes on screen were
 * painted by `CapsulePaletteRow`: correct code, wrong surface, gate
 * green. So every node this file examines is reported with the
 * component that emitted it (`data-row-source`, else its testid), and
 * the census is printed on every run — including green ones.
 *
 * ══ NO MODEL SPEND ═══════════════════════════════════════════════════
 *
 * Anthropic credits are live and billing. Both paid seams are
 * intercepted and fulfilled locally; the interceptor COUNTS attempts, so
 * N3 measures what the surface tried to do without paying for it.
 *
 * Needs the authed test-mode stack: vite :5173 + engine :8000
 * PUBLIC_TEST_MODE. Run:
 *   npx playwright test e2e/design/capsule-brief.spec.ts --project=chromium
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { dismissPublicTestBanner, preseedLearningMode } from "../_helpers";

const VIEWPORT = { width: 1440, height: 900 } as const;
test.use({ viewport: VIEWPORT });

test.skip(
  ({ baseURL }) => !/localhost|127\.0\.0\.1/.test(baseURL ?? ""),
  "the capsule brief gates need the authed test-mode stack (vite :5173 + engine :8000 PUBLIC_TEST_MODE)",
);

const SETTLE_MS = 8000;
const ACTION_MS = 20_000;

// ══════════════════════════════════════════════════════════════════════
// ANCHORS — every selector this file depends on, declared once and
// PROVEN LIVE in the first test. A negative assertion below is therefore
// a real ban: the thing it forbids is a thing this surface can render.
// ══════════════════════════════════════════════════════════════════════

const ANCHORS = {
  trigger: '[data-testid="header-command-bar"]',
  overlay: '[data-testid="command-palette"]',
  composer: '[data-testid="capsule-composer"]',
  restingRoot: '[data-testid="capsule-empty-state"]',
  contextStrip: '[data-testid="capsule-context-strip"]',
  chip: '[data-testid="capsule-suggestion"]',
  /** The resting fact tiles. The brief's headline addition; MEASURED
   *  absent at HEAD, which is a FINDING this file reports, not a reason
   *  to skip N2/N4/N7's tile half. */
  tile: '[data-testid="capsule-fact-tile"], [data-testid^="capsule-tile"]',
  /** A resting destination row — the thing N1 bans. */
  jump: '[data-testid="capsule-jump"], [data-testid^="capsule-jump-"]',
  /** A typing-state palette row — N1's positive control and N7's subject. */
  paletteRow: '[data-row-source="palette-row"]',
  // NOT `app-sidebar` — no such testid exists, and the stale-gates census
  // caught it. The rail is identified by the destination rows it actually
  // renders (Sidebar.tsx uses per-item testIds like `sidebar-chat`), with
  // <nav> as the structural fallback. A selector naming an element that
  // was never there is the false-green class this suite exists to police.
  sidebarRail: 'nav:has([data-testid^="sidebar-"]), nav',
} as const;

/** The two seams that cost money. NAMED, because a gate that says
 *  "something spent" and cannot say WHAT is a gate nobody can act on. */
const MODEL_SEAMS: readonly { label: string; match: RegExp }[] = Object.freeze([
  { label: "/api/capsule/tools/get_facts (engine tool endpoint)", match: /\/api\/capsule\/tools\// },
  { label: "functions/v1/chat-llm (Edge Function)", match: /functions\/v1\/chat-llm/ },
]);

// ══════════════════════════════════════════════════════════════════════
// RECORDED EXPECTATIONS — per component, never a shared sum (TC-6)
// ══════════════════════════════════════════════════════════════════════
//
// A floor on a SUM cannot see one addend collapse; that has been caught
// seven times in this repo. Every number below names ONE component and
// is checked against that component alone.
//
// MEASURED 2026-09-01 on the live test-mode stack, /chat, 1440x900.
// Raw output: design_review/capsule-brief/probe.json, probe-n5.json.
// design_review/capsule-brief/GATES.md carries the full table and the
// date each number was taken.

const EXPECT = {
  /** N1's control set. MEASURED: 9 sidebar destinations painted in the
   *  left rail at 1440 (/chat, /dashboard, /workspace,
   *  /dashboard/scenarios, /benchmark, /products, /dashboard/variance,
   *  /public-companies, /settings). Floored well below to catch the
   *  selector dying, not to pin the nav. */
  sidebarDestinations: 6,
  /** N1's SUBJECT floor. The resting surface must SAY something for
   *  "it does not duplicate the sidebar" to be a claim about anything.
   *  MEASURED at HEAD: 1 chip + 1 context strip + 1 in-strip action. */
  restingContentUnits: 2,
  /** N1's positive control. MEASURED: the query "dash" paints 1 palette
   *  row pointing at /dashboard — a destination the sidebar also shows.
   *  If the detector cannot see THAT, its resting zero is meaningless. */
  controlDuplicatesFound: 1,
  /** N7, per zone. */
  maxTilesAtRest: 3,
  maxChipsAtRest: 3,
  maxRowsWhileTyping: 8,
  /** N7's subject floor — the typing states swept. */
  typingStatesSwept: 5,
  /** N4. Every numeral inside a tile must sit under [data-provenance].
   *  No floor on the COUNT of numerals: a tile set that legitimately
   *  renders all gap-states carries zero. The floor is on TILES. */
  minTilesForProvenanceLaw: 1,
  /** N5. */
  accountPaintMs: 100,
  /** N5's subject floor — codes probed. */
  accountCodesProbed: 4,
  /** N6. Threads before and after the handoff. */
  maxNewThreads: 0,
} as const;

// ══════════════════════════════════════════════════════════════════════
// HARNESS
// ══════════════════════════════════════════════════════════════════════

/** Per-test spend ledger. Counts ATTEMPTS and fulfils locally, so the
 *  measurement costs nothing. */
interface Ledger {
  hits: { url: string; seam: string }[];
  since(mark: number): { url: string; seam: string }[];
  mark(): number;
}

async function interceptSpend(page: Page): Promise<Ledger> {
  const hits: { url: string; seam: string }[] = [];
  await page.route(/\/api\/capsule\/tools\/|functions\/v1\/chat-llm/, async (route) => {
    const url = route.request().url();
    const seam = MODEL_SEAMS.find((s) => s.match.test(url))?.label ?? url;
    hits.push({ url, seam });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: "ct1", tool: "get_facts", read_only: true, ok: true,
        values: [], rows: [], gaps: [], limitations: [], notes: [],
        answer: "intercepted by the capsule-brief gate — no model was called",
      }),
    });
  });
  return {
    hits,
    mark: () => hits.length,
    since: (m: number) => hits.slice(m),
  };
}

async function boot(page: Page, route = "/chat"): Promise<void> {
  await preseedLearningMode(page);
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS);
  await dismissPublicTestBanner(page);
  // The reload resolves the active workspace; its readiness is AWAITED,
  // not slept for.
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await expect(
    page.locator(ANCHORS.trigger).first(),
    "the app shell never re-mounted after boot()'s reload",
  ).toBeVisible({ timeout: ACTION_MS });
  await dismissPublicTestBanner(page);
  await page.waitForTimeout(1500);
}

async function openCapsule(page: Page): Promise<Locator> {
  await page.locator(ANCHORS.trigger).first().click({ timeout: ACTION_MS });
  const overlay = page.locator(ANCHORS.overlay);
  await expect(overlay).toBeVisible({ timeout: ACTION_MS });
  await page.waitForTimeout(900);
  return overlay;
}

/** One painted, activatable node inside the overlay, with the component
 *  that emitted it (TC-7) and where it points. */
interface Row {
  component: string;
  testid: string | null;
  destination: string | null;
  text: string;
}

async function readRows(page: Page): Promise<Row[]> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return [];
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const s = getComputedStyle(el);
      return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
    };
    return Array.from(root.querySelectorAll('button, a[href], [role="option"]'))
      .filter(visible)
      .map((el) => ({
        component:
          el.getAttribute("data-row-source") ??
          el.getAttribute("data-testid") ??
          el.tagName.toLowerCase(),
        testid: el.getAttribute("data-testid"),
        destination:
          el.getAttribute("data-nav-to") ??
          el.getAttribute("href") ??
          null,
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 90),
      }));
  }, ANCHORS.overlay);
}

/** The sidebar destinations a reader can SEE. Path only — the app
 *  appends `?period=…` to every rail link, and a destination that
 *  differs from a sidebar item only by query string is the same place. */
async function readSidebar(page: Page): Promise<{ path: string; label: string }[]> {
  return page.evaluate(() => {
    const out: { path: string; label: string }[] = [];
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      const r = a.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.right > 300) continue;               // the 240px rail
      const s = getComputedStyle(a);
      if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) < 0.05) continue;
      out.push({
        path: (a.getAttribute("href") ?? "").split("?")[0],
        label: (a.textContent ?? "").replace(/\s+/g, " ").trim(),
      });
    }
    return out;
  });
}

const pathOf = (dest: string | null): string | null =>
  dest ? dest.split("?")[0].split("#")[0] : null;

/** The detector both N1 and its control run. Kept as ONE function so the
 *  control genuinely exercises the same code — a control that runs a
 *  second, kinder implementation proves nothing. */
function duplicatesAgainst(rows: Row[], sidebar: { path: string }[]): Row[] {
  const paths = new Set(sidebar.map((s) => s.path).filter(Boolean));
  return rows.filter((r) => {
    const p = pathOf(r.destination);
    return !!p && paths.has(p);
  });
}

function census(title: string, lines: string[]): void {
  console.log(`\n── ${title} ──`);
  for (const l of lines) console.log(`   ${l}`);
}

// ══════════════════════════════════════════════════════════════════════
// N0 — the anchors resolve. Every ban below depends on this.
// ══════════════════════════════════════════════════════════════════════

test("N0 · every anchor this file bans against is a thing the surface can render", async ({ page }) => {
  await interceptSpend(page);
  await boot(page);

  await expect(page.locator(ANCHORS.trigger).first()).toBeVisible({ timeout: ACTION_MS });
  const overlay = await openCapsule(page);
  await expect(overlay.locator(ANCHORS.composer)).toBeVisible({ timeout: ACTION_MS });
  await expect(overlay.locator(ANCHORS.restingRoot)).toBeVisible({ timeout: ACTION_MS });

  // The palette row must be PRODUCIBLE — N1's control and N7's subject
  // both depend on it. Proven by summoning one, not by asserting zero.
  await overlay.locator(ANCHORS.composer).fill("dash");
  await page.waitForTimeout(600);
  const rowCount = await overlay.locator(ANCHORS.paletteRow).count();
  expect(
    rowCount,
    `ANCHORS.paletteRow (${ANCHORS.paletteRow}) matched nothing with "dash" typed. ` +
      "Every negative assertion in this file that depends on it would be a " +
      "tautology. Retarget the anchor at whatever paints navigation rows now.",
  ).toBeGreaterThan(0);

  census("N0 anchors", [
    `trigger, overlay, composer, resting root: resolved`,
    `palette rows summoned by "dash": ${rowCount}`,
  ]);
});

// ══════════════════════════════════════════════════════════════════════
// N1 — NO RESTING DUPLICATION
// ══════════════════════════════════════════════════════════════════════

test("N1 · no resting row restates a visible sidebar destination", async ({ page }) => {
  await interceptSpend(page);
  await boot(page);

  const sidebar = await readSidebar(page);
  const overlay = await openCapsule(page);
  const restRows = await readRows(page);

  // ── the resting content census, printed on green runs too ──────────
  const tiles = await overlay.locator(ANCHORS.tile).count();
  const chips = await overlay.locator(ANCHORS.chip).count();
  const strips = await overlay.locator(ANCHORS.contextStrip).count();
  const restingUnits = tiles + chips + strips;

  census("N1 resting census (TC-7: component that emitted each node)", [
    `sidebar destinations visible: ${sidebar.length} — ${sidebar.map((s) => s.path).join(", ")}`,
    `resting tiles=${tiles} chips=${chips} contextStrips=${strips}`,
    ...restRows.map((r) => `row  [${r.component}]  ->${r.destination ?? "—"}  "${r.text}"`),
  ]);

  // ── the CONTROL, first: can the detector see a duplicate at all? ────
  //
  // Run BEFORE the ban is asserted, deliberately. A control that runs
  // after a passing ban is a control nobody reads when the ban is green,
  // which is exactly when it matters.
  await overlay.locator(ANCHORS.composer).fill("dash");
  await page.waitForTimeout(700);
  const typingRows = await readRows(page);
  const controlDupes = duplicatesAgainst(typingRows, sidebar);

  census("N1 positive control — the SAME detector, on the typing state", [
    `typing rows: ${typingRows.length}`,
    ...controlDupes.map((r) => `DUPLICATE  [${r.component}]  ->${r.destination}  "${r.text}"`),
  ]);

  expect(
    controlDupes.length,
    "THE DETECTOR IS BLIND. Typing \"dash\" paints a navigation row aimed at " +
      "/dashboard, which the sidebar also shows — the detector must find that. " +
      "It found nothing, so its zero on the resting state says nothing about " +
      "the resting state. Fix the detector before reading N1's verdict.",
  ).toBeGreaterThanOrEqual(EXPECT.controlDuplicatesFound);

  // ── back to rest ────────────────────────────────────────────────────
  await overlay.locator(ANCHORS.composer).fill("");
  await page.waitForTimeout(700);
  const restAgain = await readRows(page);

  // ── the SUBJECT FLOOR, after the loops that produced the counts ─────
  expect(
    sidebar.length,
    `Only ${sidebar.length} sidebar destination(s) painted; recorded expectation ` +
      `is >= ${EXPECT.sidebarDestinations}. N1 compares against this set, so an ` +
      "empty one satisfies the ban without examining anything.",
  ).toBeGreaterThanOrEqual(EXPECT.sidebarDestinations);

  expect(
    restingUnits,
    `The resting surface paints ${restingUnits} content unit(s) ` +
      `(tiles ${tiles} + chips ${chips} + strips ${strips}); recorded expectation ` +
      `is >= ${EXPECT.restingContentUnits}.\n` +
      "N1 says the capsule must not restate the sidebar. A capsule that says " +
      "NOTHING satisfies that and fails the brief: the surface has to tell the " +
      "reader something they cannot already see. A clean N1 over an empty " +
      "surface is indistinguishable from no subject (TC-9), so the floor is " +
      "asserted here rather than left implied.",
  ).toBeGreaterThanOrEqual(EXPECT.restingContentUnits);

  // ── THE LAW ─────────────────────────────────────────────────────────
  const dupes = duplicatesAgainst(restAgain, sidebar);
  expect(
    dupes.map((d) => `[${d.component}] -> ${d.destination} "${d.text}"`),
    "A resting row points where a VISIBLE sidebar item already points. The " +
      "owner's evidence was four of these — Dashboard, Scenarios, Workspaces, " +
      "Benchmark — all four two inches to the left. Destinations belong behind " +
      "the first keystroke, under their own label.",
  ).toEqual([]);
});

// ══════════════════════════════════════════════════════════════════════
// N2 + N4 — DERIVED CONTENT and PROVENANCE
// ══════════════════════════════════════════════════════════════════════
//
// The DERIVATION itself is proven in the node gate, by driving the real
// builders through a mutation matrix (a hardcoded string is invariant
// under every mutation, whatever it spells). What is provable HERE, and
// only here, is that what reached the DOM carries its basis and its
// provenance — the render can drop both without the builder changing.

test("N2/N4 · every resting unit declares its basis, and every tile numeral its provenance", async ({ page }) => {
  await interceptSpend(page);
  await boot(page);
  const overlay = await openCapsule(page);

  const units = await page.evaluate(
    ({ overlaySel, tileSel, chipSel }) => {
      const root = document.querySelector(overlaySel);
      if (!root) return { tiles: [], chips: [], gapNodes: 0 };
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        const s = getComputedStyle(el);
        return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
      };
      const describe = (el: Element) => {
        // Every numeral this unit paints, and whether it sits under a
        // provenance carrier. A DATE is not a figure and a COUNT is not
        // money — but a tile's VALUE is, so the law is scoped to tiles.
        const numerals: { text: string; provenanced: boolean }[] = [];
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = w.nextNode())) {
          const s = (n.nodeValue ?? "").trim();
          if (!/\d/.test(s)) continue;
          const p = n.parentElement;
          if (!p || !visible(p)) continue;
          numerals.push({
            text: s.slice(0, 60),
            provenanced: !!p.closest("[data-provenance]"),
          });
        }
        return {
          component: el.getAttribute("data-testid") ?? el.tagName.toLowerCase(),
          // A unit declares its basis EITHER as an attribute the render
          // stamps, OR as the honest provenance line the chips already
          // paint. Both are accepted: the law is "say where this came
          // from", not "say it in one particular attribute".
          basis:
            el.getAttribute("data-basis") ??
            el.getAttribute("data-derived-from") ??
            el.getAttribute("data-fact") ??
            ((el.querySelector('[data-testid="capsule-suggestion-basis"]')?.textContent ?? "").trim() ||
              null),
          gap: el.getAttribute("data-gap"),
          text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 110),
          numerals,
        };
      };
      return {
        tiles: Array.from(root.querySelectorAll(tileSel)).filter(visible).map(describe),
        chips: Array.from(root.querySelectorAll(chipSel)).filter(visible).map(describe),
        gapNodes: root.querySelectorAll("[data-gap]").length,
      };
    },
    { overlaySel: ANCHORS.overlay, tileSel: ANCHORS.tile, chipSel: ANCHORS.chip },
  );

  census("N2/N4 resting units (TC-7)", [
    `tiles: ${units.tiles.length}`,
    ...units.tiles.map((t) => `  [${t.component}] basis=${t.basis ?? "NONE"} gap=${t.gap ?? "—"} numerals=${t.numerals.length} "${t.text}"`),
    `chips: ${units.chips.length}`,
    ...units.chips.map((c) => `  [${c.component}] basis=${c.basis ?? "NONE"} "${c.text}"`),
    `nodes declaring a gap state: ${units.gapNodes}`,
  ]);

  // ── SUBJECT FLOOR — tiles ───────────────────────────────────────────
  expect(
    units.tiles.length,
    `The resting surface paints ${units.tiles.length} fact tile(s); the brief's ` +
      `resting state is <=3 fact tiles and <=3 question chips, and N2/N4's tile ` +
      "laws need at least one tile to be about.\n" +
      "MEASURED 2026-09-01 at HEAD: 0 tiles. The chips exist and are derived " +
      "(proven by scripts/check_capsule_brief.mjs's mutation differential); the " +
      "TILES do not exist, so the tile half of N2 and all of N4 have no subject. " +
      "This gate reports that as a failure rather than a clean sweep — a census " +
      "that finds nothing is broken, not clean (TC-3).",
  ).toBeGreaterThanOrEqual(EXPECT.minTilesForProvenanceLaw);

  // ── SUBJECT FLOOR — chips ───────────────────────────────────────────
  expect(units.chips.length, "no question chips at rest — N2's chip law has no subject")
    .toBeGreaterThan(0);

  // ── THE LAWS ────────────────────────────────────────────────────────
  const unbased = [...units.tiles, ...units.chips].filter((u) => !u.basis);
  expect(
    unbased.map((u) => `[${u.component}] "${u.text}"`),
    "A resting unit reached the DOM with no declared basis. N2: every tile and " +
      "chip must trace to a workspace-state computation, and the trace has to " +
      "survive the render — a builder can be perfectly derived and still paint " +
      "a row that says nothing about where it came from.",
  ).toEqual([]);

  const unprovenanced = units.tiles.flatMap((t) =>
    t.numerals.filter((n) => !n.provenanced).map((n) => `[${t.component}] "${n.text}"`),
  );
  expect(
    unprovenanced,
    "A tile paints a numeral that does not sit under [data-provenance]. N4/C3: " +
      "a figure reaches the reader with its source or it does not reach the " +
      "reader. An absent value renders the GAP STATE — never a blank, never an " +
      "estimate.",
  ).toEqual([]);
});

// ══════════════════════════════════════════════════════════════════════
// N3 — ZERO SPEND AT REST
// ══════════════════════════════════════════════════════════════════════

test("N3 · opening the capsule and reading the tiles makes no model call", async ({ page }) => {
  const ledger = await interceptSpend(page);
  await boot(page);

  const mark = ledger.mark();
  const overlay = await openCapsule(page);
  // Sit at rest and READ — the whole behaviour under test.
  await page.waitForTimeout(3000);
  await overlay.locator(ANCHORS.tile).count();
  await overlay.locator(ANCHORS.chip).count();
  await page.waitForTimeout(1000);
  const atRest = ledger.since(mark);

  census("N3 spend ledger", [
    `open + 4s at rest + read tiles/chips: ${atRest.length} seam hit(s)`,
    ...atRest.map((h) => `  ${h.seam}  ${h.url}`),
  ]);

  expect(
    atRest.map((h) => h.seam),
    "Reading the resting capsule spent a model call. Tier-0 answers from the " +
      "local fact index and `answerLocally` cannot spend by construction; a " +
      "resting surface that reaches a paid seam has routed around it.",
  ).toEqual([]);

  // ── THE POSITIVE CONTROL — the counter is wired ─────────────────────
  //
  // THE REPLANT, done as a control rather than a source edit. A zero
  // that is never contrasted with a one is not a measurement; this
  // proves the ledger CAN see a hit, and names both seams when it does.
  const paidMark = ledger.mark();
  await overlay.locator(ANCHORS.composer).fill(
    "why did the interest coverage ratio move against the covenant this quarter",
  );
  await page.waitForTimeout(300);
  await overlay.locator(ANCHORS.composer).press("Enter");
  await page.waitForTimeout(6000);
  const paid = ledger.since(paidMark);

  census("N3 positive control — a prose question, deliberately", [
    `seam hits: ${paid.length}`,
    ...paid.map((h) => `  ${h.seam}`),
  ]);

  expect(
    paid.length,
    "THE SPEND LEDGER IS BLIND. A prose question the local index cannot hold " +
      "must reach a paid seam, and the ledger saw nothing — so the zero it " +
      "reported at rest is not evidence of anything. Both seams it watches are " +
      `named in MODEL_SEAMS: ${MODEL_SEAMS.map((s) => s.label).join(" and ")}. ` +
      "Confirm they are still the seams the surface uses.",
  ).toBeGreaterThan(0);
});

// ══════════════════════════════════════════════════════════════════════
// N5 — ACCOUNT LOOKUP
// ══════════════════════════════════════════════════════════════════════
//
// SCOPE, and why it is split. The RESOLVE half — "a code resolves from
// the fact index in <100ms with provenance" — is measured in the node
// gate against the three committed real period fixtures, because the
// test-mode workspace `demo-meridian` is a CLIENT-SIDE demo with no
// backend period and therefore no account facts at all; asserting
// resolution there would be asserting over an empty set.
//
// What IS measurable on any workspace, including an empty one, is the
// HONESTY half: a real code and a fabricated one must not produce the
// same surface. MEASURED 2026-09-01 at HEAD: they do. Typing 5121 and
// typing 9999 both paint `Answer "NNNN"` with zero provenance nodes, and
// pressing Enter on either spends one model call and answers
// "Reading account NNNN … unavailable".

test("N5 · an account code paints fast, and a fabricated code is not answered like a real one", async ({ page }) => {
  const ledger = await interceptSpend(page);
  await boot(page);
  const overlay = await openCapsule(page);

  /** Time from the FINAL keystroke to the first paint that follows it.
   *  The observer is armed on a settled surface with all but the last
   *  character typed, so the number is the surface's and not the
   *  harness's sleep. An earlier probe timed its own `waitForTimeout`
   *  and reported ~280ms for what is really ~7ms. */
  async function paintAfterLastKeystroke(code: string) {
    const input = overlay.locator(ANCHORS.composer);
    await input.fill("");
    await page.waitForTimeout(200);
    await input.fill(code.slice(0, -1));
    await page.waitForTimeout(350);
    await page.evaluate((sel) => {
      const root = document.querySelector(sel)!;
      const w = window as unknown as Record<string, unknown>;
      (w.__cbObs as MutationObserver | undefined)?.disconnect();
      w.__cbT0 = null; w.__cbPaint = null;
      const obs = new MutationObserver(() => {
        if (w.__cbT0 != null && w.__cbPaint == null) w.__cbPaint = performance.now();
      });
      obs.observe(root, { childList: true, subtree: true, characterData: true });
      w.__cbObs = obs;
    }, ANCHORS.overlay);
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__cbT0 = performance.now();
    });
    await page.keyboard.type(code.slice(-1));
    await page.waitForTimeout(500);
    const ms = await page.evaluate(() => {
      const w = window as unknown as Record<string, number | null>;
      return w.__cbPaint == null || w.__cbT0 == null ? null : w.__cbPaint - w.__cbT0;
    });
    const shape = await page.evaluate((sel) => {
      const root = document.querySelector(sel)!;
      return {
        provenance: root.querySelectorAll("[data-provenance]").length,
        gap: root.querySelectorAll("[data-gap]").length,
        // The whole painted answer region, normalised with the code
        // itself removed — two different codes must not reduce to the
        // same sentence, and leaving the code in would make every
        // comparison trivially unequal.
        text: (root.textContent ?? "").replace(/\s+/g, " ").trim(),
      };
    }, ANCHORS.overlay);
    return { ms, ...shape };
  }

  const REAL = ["5121", "411", "401"];
  const FABRICATED = ["9999", "8888"];
  const probed: { code: string; real: boolean; ms: number | null; provenance: number; gap: number; shape: string }[] = [];

  for (const code of [...REAL, ...FABRICATED]) {
    const r = await paintAfterLastKeystroke(code);
    probed.push({
      code,
      real: REAL.includes(code),
      ms: r.ms,
      provenance: r.provenance,
      gap: r.gap,
      // strip the code so the SHAPE is comparable across codes
      shape: r.text.split(code).join("«code»").slice(0, 260),
    });
  }

  census("N5 account probe", probed.map((p) =>
    `${p.code.padEnd(6)} ${p.real ? "REAL      " : "FABRICATED"} ` +
    `paint=${p.ms == null ? "NO-PAINT" : p.ms.toFixed(1) + "ms"} ` +
    `provenance=${p.provenance} gap=${p.gap}\n         shape="${p.shape.slice(0, 150)}"`,
  ));

  // ── SUBJECT FLOOR, after the loop ───────────────────────────────────
  expect(
    probed.length,
    "no account codes were probed — N5 examined nothing",
  ).toBeGreaterThanOrEqual(EXPECT.accountCodesProbed);

  // ── THE LATENCY LAW ─────────────────────────────────────────────────
  const slow = probed.filter((p) => p.ms == null || p.ms > EXPECT.accountPaintMs);
  expect(
    slow.map((p) => `${p.code}: ${p.ms == null ? "no paint at all" : p.ms.toFixed(1) + "ms"}`),
    `A code took longer than ${EXPECT.accountPaintMs}ms to paint, or painted ` +
      "nothing. N5: typing a code resolves from the fact index in <100ms.",
  ).toEqual([]);

  // ── THE HONESTY LAW ─────────────────────────────────────────────────
  //
  // The one that matters, and the one HEAD fails. If a real code and a
  // fabricated code reduce to the same surface, the capsule is not
  // resolving anything — it is echoing what was typed, and it will echo
  // an account that does not exist with exactly the same confidence.
  const realShapes = new Set(probed.filter((p) => p.real).map((p) => p.shape));
  const collisions = probed
    .filter((p) => !p.real && realShapes.has(p.shape))
    .map((p) => p.code);

  expect(
    collisions,
    "A FABRICATED ACCOUNT CODE PRODUCES THE SAME SURFACE AS A REAL ONE.\n" +
      "MEASURED at HEAD: 5121 and 9999 both paint the ask fallback with zero " +
      "provenance nodes and zero gap nodes, and Enter on either spends a model " +
      "call to be told the account is unavailable.\n" +
      "N5: a code resolves from the fact index WITH PROVENANCE, or the surface " +
      "states honestly that the account is not in this period. Those are two " +
      "different sentences. One sentence for both cases is not honesty — it is " +
      "the surface declining to know.",
  ).toEqual([]);

  census("N5 spend during the probe", [`${ledger.hits.length} seam hit(s) total`]);
});

// ══════════════════════════════════════════════════════════════════════
// N6 — HANDOFF
// ══════════════════════════════════════════════════════════════════════

test("N6 · on /chat the handoff focuses the existing composer and starts no second thread", async ({ page }) => {
  await interceptSpend(page);
  await boot(page, "/chat");

  const threadCounts = () =>
    page.evaluate(() => {
      const out: Record<string, number> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith("cfo-ai-chat-history")) continue;
        try {
          const v = JSON.parse(localStorage.getItem(k) ?? "[]");
          out[k] = Array.isArray(v) ? v.length : -1;
        } catch { out[k] = -2; }
      }
      return out;
    });

  const before = await threadCounts();
  const totalBefore = Object.values(before).reduce((a, b) => a + Math.max(b, 0), 0);

  const overlay = await openCapsule(page);
  const QUESTION = "what moved gross margin";
  await overlay.locator(ANCHORS.composer).fill(QUESTION);
  await page.waitForTimeout(300);
  await page.keyboard.press("Meta+Enter");        // the documented handoff
  await page.waitForTimeout(3000);

  const after = await threadCounts();
  const totalAfter = Object.values(after).reduce((a, b) => a + Math.max(b, 0), 0);

  const focus = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName?.toLowerCase() ?? null,
      testid: el?.getAttribute?.("data-testid") ?? null,
      isTextField: !!el && (el.tagName === "TEXTAREA" || el.getAttribute("contenteditable") === "true"),
      inCapsule: !!el?.closest?.('[data-testid="command-palette"]'),
    };
  });

  const composers = await page.evaluate(() =>
    Array.from(document.querySelectorAll("textarea"))
      .filter((t) => t.getBoundingClientRect().height > 0)
      .map((t) => ({
        testid: t.getAttribute("data-testid"),
        value: t.value.slice(0, 60),
        inCapsule: !!t.closest('[data-testid="command-palette"]'),
      })),
  );

  census("N6 handoff", [
    `url after: ${page.url()}`,
    `threads before: ${JSON.stringify(before)}  (total ${totalBefore})`,
    `threads after : ${JSON.stringify(after)}  (total ${totalAfter})`,
    `focus after: ${JSON.stringify(focus)}`,
    `visible composers: ${JSON.stringify(composers)}`,
  ]);

  // ── SUBJECT FLOOR ───────────────────────────────────────────────────
  expect(
    composers.length,
    "no visible composer after the handoff — N6 has nothing to check focus against",
  ).toBeGreaterThan(0);

  // ── THE LAWS ────────────────────────────────────────────────────────
  expect(
    totalAfter - totalBefore,
    `The handoff created ${totalAfter - totalBefore} new thread(s).\n` +
      `Keys before: ${Object.keys(before).join(", ") || "(none)"}\n` +
      `Keys after : ${Object.keys(after).join(", ") || "(none)"}\n` +
      "N6: on /chat the handoff continues the conversation the reader is " +
      "already in. AppShell's OPEN_ASK_CFO_AI_EVENT handler calls " +
      "`handle.newChat()` unconditionally, which is the mechanism.\n" +
      "MEASURED at HEAD: +1 thread, and it landed under the BARE legacy key " +
      "`cfo-ai-chat-history-v1` rather than the org-scoped " +
      "`cfo-ai-chat-history-v1:<orgId>` — so the handoff also writes outside " +
      "the workspace the reader is in.",
  ).toBeLessThanOrEqual(EXPECT.maxNewThreads);

  expect(
    focus.isTextField && !focus.inCapsule,
    `Focus landed on <${focus.tag} data-testid="${focus.testid}"> rather than on ` +
      "the page's composer. N6: the handoff FOCUSES THE EXISTING COMPOSER — the " +
      "reader should be able to keep typing, not hunt for the field.\n" +
      "MEASURED at HEAD: focus landed on the header trigger button.",
  ).toBe(true);
});

// ══════════════════════════════════════════════════════════════════════
// N7 — ROW BUDGET
// ══════════════════════════════════════════════════════════════════════

test("N7 · <=3 tiles and <=3 chips at rest, <=8 rows in any typing state", async ({ page }) => {
  await interceptSpend(page);
  await boot(page);
  const overlay = await openCapsule(page);

  const tiles = await overlay.locator(ANCHORS.tile).count();
  const chips = await overlay.locator(ANCHORS.chip).count();

  // Per-state, not a flat total. A budget on the SUM across states
  // cannot see one state blow past it while another is empty.
  const QUERIES = ["a", "cash", "dash", "period", "bal", "5121"];
  const perState: { q: string; rows: number; components: string[] }[] = [];
  for (const q of QUERIES) {
    await overlay.locator(ANCHORS.composer).fill("");
    await page.waitForTimeout(180);
    await overlay.locator(ANCHORS.composer).fill(q);
    await page.waitForTimeout(600);
    const rows = await readRows(page);
    perState.push({
      q,
      rows: rows.length,
      components: [...new Set(rows.map((r) => r.component))],
    });
  }

  census("N7 budget census", [
    `at rest: tiles=${tiles} chips=${chips}`,
    ...perState.map((s) =>
      `typing "${s.q}": ${s.rows} row(s)  painted by [${s.components.join(", ")}]`,
    ),
  ]);

  // ── SUBJECT FLOOR, after the sweep ──────────────────────────────────
  expect(
    perState.length,
    "no typing states were swept — N7's row budget examined nothing",
  ).toBeGreaterThanOrEqual(EXPECT.typingStatesSwept);
  expect(
    perState.reduce((n, s) => n + s.rows, 0),
    "every swept typing state painted zero rows. A budget over an empty surface " +
      "is satisfied by construction; the sweep has stopped summoning rows and " +
      "the cap below is measuring nothing.",
  ).toBeGreaterThan(0);

  // ── THE LAWS, per zone ──────────────────────────────────────────────
  expect(tiles, `${tiles} resting tiles; N7 caps them at ${EXPECT.maxTilesAtRest}`)
    .toBeLessThanOrEqual(EXPECT.maxTilesAtRest);
  expect(chips, `${chips} resting chips; N7 caps them at ${EXPECT.maxChipsAtRest}`)
    .toBeLessThanOrEqual(EXPECT.maxChipsAtRest);

  const over = perState.filter((s) => s.rows > EXPECT.maxRowsWhileTyping);
  expect(
    over.map((s) => `"${s.q}" painted ${s.rows} rows`),
    `A typing state paints more than ${EXPECT.maxRowsWhileTyping} rows.\n` +
      'MEASURED 2026-09-01 at HEAD: "a" painted 19 and "cash" painted 14, ' +
      "against `const visible = out.slice(0, 18)` in CommandPalette.tsx.\n" +
      "N7: a list that long is the menu the capsule exists to stop being — the " +
      "reader scans it instead of reading it, which is the same complaint the " +
      "resting jump rows earned.",
  ).toEqual([]);
});
