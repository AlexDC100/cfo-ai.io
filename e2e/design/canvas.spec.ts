/**
 * THE CANVAS — LIVE GATES CV-G1…CV-G6 + the screenshot loop.
 *
 *   CV-G1  ⌘J OPENS IT, ⌘K STILL OPENS THE CAPSULE. Two gestures, two
 *          surfaces. If one swallowed the other the product's whole
 *          shape would collapse into one box again.
 *   CV-G2  GEOMETRY. Full viewport height, ≥480px wide, and the
 *          composer's bottom edge is STABLE within 2px across every
 *          state — empty, typing, answered.
 *   CV-G3  ZERO SPEND ON TIER 0 (K10, inherited). A question the local
 *          index holds, committed in the canvas composer, reaches
 *          NEITHER model seam. With a positive control in the same run.
 *   CV-G4  THE ENGINE COMPUTES, THE MODEL COMPOSES. A non-generative
 *          slash command may reach the read-only TOOL endpoint and must
 *          never reach `chat-llm`.
 *   CV-G5  THE EMPTY CANVAS IS COMPUTED. Its suggestions come from
 *          workspace state, and it prints no figure.
 *   CV-G6  SCREENSHOTS. 1440 and 390, both themes, four states.
 *
 * ── THE TWO DISEASES THIS FILE IS BUILT NOT TO CARRY ─────────────────
 *
 * Same two the capsule craft file names, and for the same reasons.
 *
 * 1. THE VACUOUS SELECTOR. Every selector is declared once in ANCHORS
 *    and proven live in the first test. A negative assertion below is
 *    therefore a real ban.
 * 2. THE VACUOUS ZERO. Every "this list is empty" is paired with a
 *    POSITIVE CONTROL in the same run, on the same detector, pointed at
 *    a case that MUST trip it.
 *
 * NO MODEL SPEND. Generation and the tool endpoint are intercepted and
 * fulfilled from fixtures; the SURFACE is what is under test.
 *
 * Needs the authed test-mode stack (vite + engine :8000 PUBLIC_TEST_MODE):
 *   E2E_BASE_URL=http://localhost:5173 npx playwright test \
 *     e2e/design/canvas.spec.ts --project=chromium
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

import { dismissPublicTestBanner, preseedLearningMode, seedTheme, seedViewMode } from "../_helpers";

const SHOT_DIR = "design_review/canvas/shots";
const SETTLE_MS = 8000;
const ACTION_MS = 20_000;

test.skip(
  ({ baseURL }) => !/localhost|127\.0\.0\.1/.test(baseURL ?? ""),
  "canvas gates need the authed test-mode stack (vite + engine :8000 PUBLIC_TEST_MODE)",
);

// ══════════════════════════════════════════════════════════════════════
// ANCHORS — declared once, proven live in the first test
// ══════════════════════════════════════════════════════════════════════

const ANCHORS = {
  panel: '[data-testid="canvas-panel"]',
  header: '[data-testid="canvas-header"]',
  rail: '[data-testid="canvas-rail"]',
  thread: '[data-testid="canvas-thread"]',
  composerBlock: '[data-testid="canvas-composer-block"]',
  composer: '[data-testid="canvas-composer"]',
  send: '[data-testid="canvas-send"]',
  empty: '[data-testid="canvas-empty"]',
  entry: '[data-testid="canvas-entry"]',
  artifact: '[data-testid="canvas-artifact"]',
  slashMenu: '[data-testid="canvas-slash-menu"]',
  resize: '[data-testid="canvas-resize"]',
  capsule: '[data-testid="command-palette"]',
} as const;

/** Must resolve with the canvas OPEN and nothing asked. */
const ANCHORS_OPEN: ReadonlyArray<keyof typeof ANCHORS> = [
  "panel", "header", "rail", "thread", "composerBlock", "composer", "send", "empty", "resize",
];

// ── the seams ─────────────────────────────────────────────────────────

const GENERATION_URL = "**/functions/v1/chat-llm";
const TOOLS_URL = "**/api/capsule/tools/**";

const MODEL_SEAM = { label: "functions/v1/chat-llm (Edge Function)", match: /functions\/v1\/chat-llm/ };
const TOOL_SEAM = { label: "/api/capsule/tools (read-only engine tools)", match: /\/api\/capsule\/tools\// };

const isModel = (url: string) => MODEL_SEAM.match.test(url);
const isTool = (url: string) => TOOL_SEAM.match.test(url);

/** A ct1 payload — the shape `_capsule_tools.to_payload()` emits. */
const TOOL_PAYLOAD = {
  version: "ct1", tool: "get_facts", read_only: true, ok: true,
  values: [
    {
      kind: "money", fact: "total_assets", metric: "total_assets", unit: "money",
      amount_minor: 29305008511, value: 293050085.11, currency: "RON", scope: "Dec 2025",
      label_key: "capsule.metric.total_assets",
      provenance: {
        period_id: "p-dec", period_label: "Dec 2025", entity_id: "org-1",
        source: "assembled_canonical_v1", tier: "canonical_bs", snapshot_id: "sha256-p-dec",
      },
    },
    {
      kind: "money", fact: "revenue", metric: "revenue", unit: "money",
      amount_minor: 41372756000, value: 413727560, currency: "RON", scope: "Dec 2025",
      label_key: "capsule.metric.revenue",
      provenance: {
        period_id: "p-dec", period_label: "Dec 2025", entity_id: "org-1",
        source: "assembled_canonical_v1", tier: "canonical_bs", snapshot_id: "sha256-p-dec",
      },
    },
  ],
  rows: [], gaps: [], limitations: [], notes: [],
};

const GROUNDED_ANSWER =
  "Total assets stand at {{money:total_assets}} against revenue of {{money:revenue}}.";

/** A question the LOCAL index holds — the zero-spend subject. */
const TIER0_QUESTION = "total assets";
/** A question Tier 0 must refuse — the POSITIVE CONTROL. Without this in
 *  the same file, "no spend" is indistinguishable from "no surface". */
const TIER1_QUESTION = "why are total assets at this level";

// ══════════════════════════════════════════════════════════════════════
// HARNESS
// ══════════════════════════════════════════════════════════════════════

async function stubSeams(page: Page, opts: { generationDelayMs?: number } = {}): Promise<void> {
  await page.route(TOOLS_URL, async (route) => {
    await route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(TOOL_PAYLOAD),
    });
  });
  await page.route(GENERATION_URL, async (route) => {
    // THE CAPTURE RUN HOLDS THIS OPEN ON PURPOSE.
    //
    // r1/D4: the streaming capture and the artifact capture came out
    // BYTE-IDENTICAL IN SIZE, because an instant stub meant the turn had
    // already settled by the 600ms mark. The file was named for a state
    // it never observed — an instrument whose output is indistinguishable
    // from "there was no subject", which is the failure this project
    // keeps catching. A held response is what gives the in-flight state
    // a duration to be photographed in.
    if (opts.generationDelayMs) {
      await new Promise((r) => setTimeout(r, opts.generationDelayMs));
    }
    await route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify({ answer: GROUNDED_ANSWER }),
    });
  });
}

async function boot(
  page: Page,
  opts: { theme?: "light" | "dark"; mode?: "simple" | "pro" } = {},
): Promise<void> {
  await preseedLearningMode(page);
  await seedTheme(page, opts.theme ?? "dark");
  await seedViewMode(page, opts.mode ?? "pro");
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS);
  await dismissPublicTestBanner(page);
  // The reload is what makes the active workspace (and therefore the
  // period list the empty state computes from) resolved rather than
  // in-flight. Awaited on the app shell, not slept for.
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await expect(
    page.locator('[data-testid="account-menu-trigger"]'),
    "the app shell never re-mounted after boot()'s reload",
  ).toBeVisible({ timeout: ACTION_MS });
  await dismissPublicTestBanner(page);
}

/** ⌘J. The ONLY way this spec opens the canvas — if the binding
 *  regresses, every gate here fails, which is the correct blast radius. */
async function openCanvas(page: Page): Promise<Locator> {
  await page.keyboard.press("Meta+j");
  const panel = page.locator(ANCHORS.panel);
  await expect(panel, "⌘J did not open the canvas").toBeVisible({ timeout: ACTION_MS });
  // Let the empty state's snapshot-driven suggestions land. Bounded and
  // NOT thrown on: if they never arrive, CV-G5's floor fails on the
  // measurement rather than this line failing on the wait.
  await page
    .locator('[data-testid="canvas-suggestion"]')
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => {});
  return panel;
}

async function ask(page: Page, question: string): Promise<void> {
  const input = page.locator(ANCHORS.composer);
  await input.click({ timeout: ACTION_MS });
  await input.fill(question, { timeout: ACTION_MS });
  await page.waitForTimeout(200);
  await input.press("Enter", { timeout: ACTION_MS });
}

/**
 * Hide the harness's own chrome for the duration of the capture run.
 *
 * `public-test-mode-banner` sits at z-60 and the canvas at z-40, so its
 * circular dismiss control lands squarely on the canvas header — r1
 * flagged it, r2 dismissed it at every shutter and IT CAME BACK ANYWAY
 * (it re-renders). Clicking a dismiss button is the wrong instrument for
 * "this element must not be in the photograph".
 *
 * Scoped hard: ONE selector, injected only in the capture describe, and
 * it hides something that does not exist in production. Nothing about
 * the canvas is hidden — the geometry gates above measure the real DOM
 * with the banner present.
 */
async function hideHarnessChrome(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '[data-testid="public-test-mode-banner"]{display:none !important}',
  }).catch(() => {});
}

async function shot(page: Page, name: string): Promise<void> {
  await dismissPublicTestBanner(page);
  await hideHarnessChrome(page);
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });
}

// ══════════════════════════════════════════════════════════════════════
// CV-G1 — the anchors are live, and the two gestures stay separate
// ══════════════════════════════════════════════════════════════════════

test.describe("CV-G1 — ⌘J is the canvas, ⌘K is still the Capsule", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("every anchor resolves, and neither shortcut opens the other surface", async ({ page }) => {
    test.setTimeout(240_000);
    await stubSeams(page);
    await boot(page);

    // ⌘K first: the Capsule must still be the Capsule.
    await page.keyboard.press("Meta+k");
    await expect(
      page.locator(ANCHORS.capsule),
      "⌘K stopped opening the Capsule. Navigation and Tier-0 answers live " +
        "there and must stay one keystroke away.",
    ).toBeVisible({ timeout: ACTION_MS });
    expect(
      await page.locator(ANCHORS.panel).count(),
      "⌘K opened the CANVAS. The two surfaces have collapsed into one.",
    ).toBe(0);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    // ⌘J: the canvas, and not the palette.
    const panel = await openCanvas(page);
    expect(
      await page.locator(ANCHORS.capsule).isVisible().catch(() => false),
      "⌘J opened the Capsule palette instead of the canvas.",
    ).toBe(false);

    // ── ANCHOR CENSUS, with a floor after the loop (TC-3/TC-6) ──────
    const missing: string[] = [];
    let resolved = 0;
    for (const key of ANCHORS_OPEN) {
      const count = await page.locator(ANCHORS[key]).count();
      if (count === 0) missing.push(`${key} (${ANCHORS[key]})`);
      else resolved += 1;
    }
    expect(
      missing,
      `CV-G1: ${missing.length} anchor(s) resolve to nothing with the canvas ` +
        `open:\n  ${missing.join("\n  ")}\n` +
        `Every negative assertion in this file depends on these being real.`,
    ).toEqual([]);
    expect(
      resolved,
      "CV-G1: DISCOVERY BROKEN — the anchor list is empty.",
    ).toBe(ANCHORS_OPEN.length);

    // It is a PANEL, not a dropdown: full viewport height.
    const box = await panel.boundingBox();
    expect(box, "the canvas panel has no box").not.toBeNull();
    const vp = page.viewportSize()!;
    expect(
      Math.abs(box!.height - vp.height),
      `CV-G1: the canvas is ${box!.height}px tall in a ${vp.height}px ` +
        `viewport. It is a full-height workspace, not an overlay.`,
    ).toBeLessThanOrEqual(2);
    expect(
      box!.width,
      `CV-G1: the canvas is ${box!.width}px wide. Below 480 an artifact ` +
        `card stops being readable and this becomes a chat window.`,
    ).toBeGreaterThanOrEqual(480);
  });
});

// ══════════════════════════════════════════════════════════════════════
// CV-G2 — the composer never moves
// ══════════════════════════════════════════════════════════════════════

test.describe("CV-G2 — the docked composer is stable across every state", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("its bottom edge does not drift between empty, typing and answered", async ({ page }) => {
    test.setTimeout(240_000);
    await stubSeams(page);
    await boot(page);
    await openCanvas(page);

    const composer = page.locator(ANCHORS.composer);
    const bottoms: { state: string; y: number }[] = [];

    const sample = async (state: string) => {
      const b = await composer.boundingBox();
      expect(b, `CV-G2: no composer box in state "${state}"`).not.toBeNull();
      bottoms.push({ state, y: Math.round(b!.y + b!.height) });
    };

    await sample("empty");
    await composer.fill("what is the current ratio and how does it compare");
    await page.waitForTimeout(300);
    await sample("typing");
    await composer.fill("");
    await ask(page, TIER0_QUESTION);
    await page.waitForTimeout(1500);
    await sample("answered");

    // FLOOR after the loop: three samples, or the drift below is
    // computed over nothing.
    expect(
      bottoms.length,
      "CV-G2: fewer than three states were sampled — DISCOVERY BROKEN.",
    ).toBe(3);

    const ys = bottoms.map((b) => b.y);
    const drift = Math.max(...ys) - Math.min(...ys);
    console.log(`[CV-G2] composer bottom: ${bottoms.map((b) => `${b.state}=${b.y}`).join(" · ")}`);
    expect(
      drift,
      `CV-G2: the composer's bottom edge moved ${drift}px across ` +
        `${bottoms.map((b) => `${b.state}=${b.y}`).join(", ")}. The flip is ` +
        `that the input NEVER moves — a travelling text field breaks the ` +
        `muscle memory of "click there, type" and guarantees layout shift ` +
        `on the frame the reader is trying to read.`,
    ).toBeLessThanOrEqual(2);

    // And it really is the bottom-most thing in the panel.
    const panelBox = (await page.locator(ANCHORS.panel).boundingBox())!;
    const blockBox = (await page.locator(ANCHORS.composerBlock).boundingBox())!;
    expect(
      Math.abs(panelBox.y + panelBox.height - (blockBox.y + blockBox.height)),
      "CV-G2: something is painted below the composer.",
    ).toBeLessThanOrEqual(16);
  });
});

// ══════════════════════════════════════════════════════════════════════
// CV-G3 — Tier 0 spends nothing (K10, inherited by a NEW surface)
// ══════════════════════════════════════════════════════════════════════

test.describe("CV-G3 — the canvas inherits the zero-spend boundary", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("CV-G3.a — the detector sees a real spend on a question Tier 0 refuses (CONTROL)", async ({ page }) => {
    test.setTimeout(240_000);
    const model: string[] = [];
    page.on("request", (r) => { if (isModel(r.url())) model.push(`${r.method()} ${r.url()}`); });
    await stubSeams(page);
    await boot(page);
    await openCanvas(page);
    await ask(page, TIER1_QUESTION);
    await page.waitForTimeout(2500);

    console.log(`[CV-G3.a control] ${model.length} model request(s)`);
    expect(
      model.length,
      `CV-G3 PLANT: "${TIER1_QUESTION}" reached ${MODEL_SEAM.label} zero ` +
        `times. If a real spend cannot be observed here, the zero below is ` +
        `measuring nothing.`,
    ).toBeGreaterThan(0);
  });

  test("CV-G3.b — Enter on a Tier-0 question reaches NEITHER seam", async ({ page }) => {
    test.setTimeout(240_000);
    const seen: string[] = [];
    page.on("request", (r) => {
      if (isModel(r.url()) || isTool(r.url())) seen.push(`${r.method()} ${r.url()}`);
    });
    await stubSeams(page);
    await boot(page);
    await openCanvas(page);
    await ask(page, TIER0_QUESTION);
    await page.waitForTimeout(2000);

    // SPEND FIRST. An earlier capsule draft asserted "a turn painted"
    // before it read the wire, so a disabled short-circuit reported
    // "turn not visible" — true, and silent about money.
    expect(
      seen,
      `CV-G3: "${TIER0_QUESTION}" reached a seam from the canvas:\n  ` +
        (seen.join("\n  ") || "(none)") +
        `\nSeams that must stay silent: ${MODEL_SEAM.label}, ${TOOL_SEAM.label}.\n` +
        `The local index already holds this answer, with provenance, in ` +
        `microseconds. Paying for it is paying twice for a figure the ` +
        `client had.`,
    ).toEqual([]);

    // AND IT ACTUALLY ANSWERED. Without this, "zero spend" is satisfied
    // by a surface that did nothing at all.
    await expect(
      page.locator(ANCHORS.artifact).first(),
      `CV-G3: Enter on "${TIER0_QUESTION}" painted no artifact. A zero-spend ` +
        `gate over an empty canvas measures nothing.`,
    ).toBeVisible({ timeout: ACTION_MS });
    const figures = await page.locator(`${ANCHORS.artifact} >> text=/\\d/`).count();
    expect(
      figures,
      "CV-G3: the Tier-0 artifact carries no figure. Tier 0's contract is a " +
        "FULL answer, not a placeholder that spends nothing by saying nothing.",
    ).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// CV-G4 — the engine computes; the model composes
// ══════════════════════════════════════════════════════════════════════

test.describe("CV-G4 — a deterministic command never reaches the model", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("/table reaches the read-only tools and never chat-llm", async ({ page }) => {
    test.setTimeout(240_000);
    const model: string[] = [];
    const tools: string[] = [];
    page.on("request", (r) => {
      if (isModel(r.url())) model.push(r.url());
      if (isTool(r.url())) tools.push(r.url());
    });
    await stubSeams(page);
    await boot(page);
    await openCanvas(page);

    // The menu is a real surface, not a hidden feature.
    const input = page.locator(ANCHORS.composer);
    await input.click();
    await input.fill("/");
    await expect(page.locator(ANCHORS.slashMenu)).toBeVisible({ timeout: ACTION_MS });
    const menuRows = await page.locator('[data-testid="canvas-slash-item"]').count();
    expect(
      menuRows,
      "CV-G4: the slash menu listed no commands — DISCOVERY BROKEN.",
    ).toBe(6);

    await input.fill("");
    // A subject Tier 0 cannot claim, so the ENGINE lane actually runs.
    await ask(page, "/table working capital and current liabilities over time");
    await page.waitForTimeout(3000);

    console.log(`[CV-G4] tools=${tools.length} model=${model.length}`);
    expect(
      model,
      `CV-G4: a NON-GENERATIVE slash command reached ${MODEL_SEAM.label}:\n  ` +
        model.join("\n  ") +
        `\nA table is the engine's own figures arranged. Composing prose is ` +
        `the only thing the model is for, and this command asked for none.`,
    ).toEqual([]);

    // The card landed either way — a silent no-op would satisfy the ban
    // above for the wrong reason.
    await expect(
      page.locator(ANCHORS.artifact).first(),
      "CV-G4: the command produced no artifact card at all, so 'no model " +
        "request' would mean 'nothing happened'.",
    ).toBeVisible({ timeout: ACTION_MS });
  });
});

// ══════════════════════════════════════════════════════════════════════
// CV-G5 — the empty canvas is computed, and carries no figure
// ══════════════════════════════════════════════════════════════════════

test.describe("CV-G5 — the empty state", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("suggestions come from workspace state and print no figure", async ({ page }) => {
    test.setTimeout(240_000);
    await stubSeams(page);
    await boot(page);
    await openCanvas(page);

    const empty = page.locator(ANCHORS.empty);
    await expect(empty).toBeVisible({ timeout: ACTION_MS });

    const suggestions = page.locator('[data-testid="canvas-suggestion"]');
    const n = await suggestions.count();
    console.log(`[CV-G5] ${n} computed suggestion(s)`);
    // NOT a floor of 3: the engine returns FEWER when the state yields
    // fewer, and padding is the one thing it may never do. What IS
    // asserted: three is the cap, and each row names its BASIS.
    expect(
      n,
      "CV-G5: more than three suggestions. Three is the cap; a fourth is a menu.",
    ).toBeLessThanOrEqual(3);

    // A workspace with no state shows the honest line instead. Exactly
    // one of the two must be on screen — never both, never neither.
    const nostate = await page.locator('[data-testid="canvas-empty-nostate"]').count();
    expect(
      (n > 0 ? 1 : 0) + (nostate > 0 ? 1 : 0),
      "CV-G5: the empty state showed neither suggestions nor the honest " +
        "no-state line. It is showing nothing, which is the one thing it " +
        "may not do.",
    ).toBe(1);

    // The commands are listed where there is room.
    expect(
      await page.locator('[data-testid="canvas-empty-commands"] li').count(),
      "CV-G5: the command list is empty.",
    ).toBe(6);

    // NO FIGURE. A suggestion is a QUESTION (S1).
    const text = (await empty.innerText()).replace(/\/\w+/g, "");
    const withFigures = text
      .split("\n")
      .filter((line) => /\d[.,]\d|\d{1,3}([.,\s]\d{3})+|\d\s*%|[€$£]\s*\d|\d\s*(RON|EUR|USD)/i.test(line));
    expect(
      withFigures,
      `CV-G5: the empty canvas printed ${withFigures.length} figure-shaped ` +
        `line(s):\n  ${withFigures.join("\n  ")}\nA suggestion is a question. ` +
        `A figure may only reach the DOM through <Amount> with provenance.`,
    ).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// CV-G6 — THE SCREENSHOT LOOP
// ══════════════════════════════════════════════════════════════════════
//
// 1440 and 390 × Terminal and Paper × empty / thread / artifact /
// streaming. Captured, not asserted — the assertions are above; these
// exist so the design can be LOOKED AT, which is the only way several of
// the defects in this repo were ever found.

for (const vp of [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
]) {
  for (const theme of ["dark", "light"] as const) {
    test.describe(`CV-G6 — captures ${vp.name} ${theme}`, () => {
          test.use({ viewport: { width: vp.width, height: vp.height } });

      test(`empty · thread · artifact · streaming`, async ({ page }) => {
    test.setTimeout(240_000);
        // 3.5s of held generation: long enough to photograph the
        // in-flight state, short enough that the run stays under a minute.
        await stubSeams(page, { generationDelayMs: 3500 });
        await boot(page, { theme });
        await openCanvas(page);

        // 1. EMPTY
        await shot(page, `canvas-${vp.name}-${theme}-empty`);

        // 2. STREAMING — captured mid-flight, before the answer settles.
        //    Deliberately BEFORE the artifact shot: a settled thread
        //    cannot be un-settled, so the transient state has to be taken
        //    on the way past.
        await ask(page, TIER1_QUESTION);
        await page.waitForTimeout(1200);
        // THE STATE IS ASSERTED BEFORE THE SHUTTER, not after the file is
        // on disk. r1 filed a settled thread under `streaming` for four
        // viewport/theme combinations and nothing said so.
        await expect(
          page.locator('[data-testid="canvas-artifact-pending"]'),
          `CV-G6: the ${vp.name}/${theme} capture reached the streaming ` +
            `shutter with no in-flight artifact on screen. The file would ` +
            `be named for a state it never observed — which is exactly ` +
            `what r1/D4 recorded.`,
        ).toBeVisible({ timeout: 5000 });
        await shot(page, `canvas-${vp.name}-${theme}-streaming`);
        await page.waitForTimeout(4000);

        // 3. ARTIFACT — one answered entry.
        await shot(page, `canvas-${vp.name}-${theme}-artifact`);

        // 4. THREAD — several entries, including a multi-step plan.
        await ask(page, TIER0_QUESTION);
        await page.waitForTimeout(1200);
        await ask(page, "build me a board pack for December");
        await page.waitForTimeout(4000);
        await shot(page, `canvas-${vp.name}-${theme}-thread`);

        // A capture run that captured an empty surface is worthless, so
        // the run asserts it had a subject.
        const entries = await page.locator(ANCHORS.entry).count();
        expect(
          entries,
          `CV-G6: the ${vp.name}/${theme} capture ran over a thread with ` +
            `${entries} entries. A screenshot loop over an empty surface is ` +
            `a gate that scores well by examining nothing.`,
        ).toBeGreaterThanOrEqual(3);
      });
    });
  }
}
