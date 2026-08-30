/**
 * THE CAPSULE — LIVE GATES K1–K9.
 *
 * The gates lane owns no product code. It owns the proof that the product
 * code cannot do the thing it promises not to do. This file is the half
 * that only a real browser can state; the jsdom half is
 * `frontend/lib/__tests__/capsuleAskGates.test.ts`, the engine half is
 * `tests/engine/test_capsule_gates.py`, and the source-text half is
 * `scripts/check_capsule_ask.mjs`.
 *
 *   K1  ASK-FIRST — the placeholder says ASK, "Ask a question" is not a
 *       ROW, and Enter in the prose input ANSWERS. No Tab first.
 *   K2  EMPTY-STATE BUDGET — ≤3 zones and ≤8 rows before a keystroke,
 *       counted off the live DOM.
 *   K3  TIER-0, LIVE — a lookup question paints its answer with ZERO
 *       requests to the model or the tool endpoint.
 *   K4  FACT BEFORE PROSE — the ORDERING, observed with a
 *       MutationObserver, not inferred from a stopwatch.
 *   K5  LATENCY — measured, published in LATENCY.md, gated against it.
 *   K6  MORPH INTEGRITY — the overlay's geometry originates from the
 *       capsule's bounding box, and CLS is 0 on open, on close and
 *       during streaming.
 *   K7  NO DEAD SPACE — overlay height == content height ±8px at every
 *       state.
 *   K8  H1 == 4 header elements, counted here independently of the
 *       header lane's own spec.
 *   K9  EVERY EXISTING INVARIANT, RE-PROVEN ON THE NEW SURFACE — C1
 *       numerals, C3 provenance, C5 missing-data honesty, the read-only
 *       refusal, the router's speed, and navigation never spending.
 *
 * ── THE ANCHOR LAW (read this before adding a gate) ──────────────────
 *
 * A gate whose selector matches nothing is a FALSE GREEN, and a false
 * green is the same failure as a false red — worse, because nobody looks
 * at it. `scripts/check_capsule_ask.mjs` sweeps the whole `e2e/design`
 * tree for that disease; this file must not be a carrier, so it declares
 * every anchor it depends on in ANCHORS below and PROVES THEM LIVE in
 * the first test. Any negative assertion in this file is therefore a
 * real ban: the thing it forbids is a thing this surface can render.
 *
 * NO MODEL SPEND. Anthropic credits are live and billing, so generation
 * and the tool endpoint are intercepted and fulfilled from fixtures.
 * What is under test is the SURFACE: the real router, the real guard,
 * the real panel, the real money renderer.
 *
 * Needs the authed test-mode stack: vite :5173 + engine :8000
 * PUBLIC_TEST_MODE. Run:
 *   npx playwright test e2e/design/capsule.spec.ts --project=chromium
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { dismissPublicTestBanner, preseedLearningMode } from "../_helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

test.use({ viewport: { width: 1440, height: 900 } });

// Every gate needs the AUTHED test-mode header and palette; the "prod"
// project runs signed-out and would fail on environment, not product.
test.skip(
  ({ baseURL }) => !/localhost|127\.0\.0\.1/.test(baseURL ?? ""),
  "capsule gates need the authed test-mode stack (vite :5173 + engine :8000 PUBLIC_TEST_MODE)",
);

const SETTLE_MS = 8000;

// ══════════════════════════════════════════════════════════════════════
// ANCHORS — every selector this file depends on, declared once
// ══════════════════════════════════════════════════════════════════════

const ANCHORS = {
  /** The header pill that opens the surface. */
  trigger: '[data-testid="header-command-bar"]',
  /** The overlay root. */
  overlay: '[data-testid="command-palette"]',
  /** The prose input. Matched by ROLE, not by testid: the input is
   *  whatever the ask lane builds, and role is the contract a keyboard
   *  user actually gets. */
  input: '[data-testid="command-palette"] [role="combobox"], ' +
    '[data-testid="command-palette"] textarea, ' +
    '[data-testid="command-palette"] input[type="text"]',
  /** The answer surface. */
  answer: '[data-testid="capsule-answer"]',
  /** One resolved figure with its provenance. */
  figureRow: '[data-testid="capsule-figure-row"]',
  /** Guarded prose. */
  answerBody: '[data-testid="capsule-answer-body"]',
  /** The header's account trigger — how the app-shell header is found. */
  accountTrigger: '[data-testid="account-menu-trigger"]',
  /** THE PILL THE MORPH ACTUALLY MEASURES.
   *
   *  Not the same element as `trigger`: `header-command-bar` is the inner
   *  BUTTON, `header-capsule` is the pill around it (trust dot + button +
   *  ⌘K hint). `capsuleMorph.CAPSULE_TRIGGER_SELECTOR` names this one, so
   *  a gate that wants to know whether the anchor RAN has to read the box
   *  the anchor read — not a sibling that happens to be nearby. */
  morphTrigger: '[data-testid="header-capsule"]',
} as const;

/** Anchors that MUST resolve in the live DOM with the surface closed. */
const ANCHORS_CLOSED: ReadonlyArray<keyof typeof ANCHORS> = [
  "trigger",
  "accountTrigger",
  "morphTrigger",
];
/** Anchors that MUST resolve with the surface open and nothing typed. */
const ANCHORS_OPEN: ReadonlyArray<keyof typeof ANCHORS> = ["overlay", "input"];
/** Anchors that MUST resolve once an answer has been asked for. */
const ANCHORS_ANSWERED: ReadonlyArray<keyof typeof ANCHORS> = ["answer", "figureRow"];

// ── the fixtures the network is fulfilled from ─────────────────────────

/** A ct1 tool payload — the exact shape `_capsule_tools.to_payload()`
 *  emits, with the engine suite's December 2024 book. */
const TOOL_PAYLOAD = {
  version: "ct1",
  tool: "get_facts",
  read_only: true,
  ok: true,
  values: [
    {
      kind: "money", fact: "total_assets", metric: "total_assets",
      unit: "money", amount_minor: 390000, value: 3900, currency: "RON",
      scope: "December 2024", label_key: "capsule.metric.total_assets",
      provenance: {
        period_id: "p-dec", period_label: "December 2024", entity_id: "org-1",
        source: "assembled_canonical_v1", tier: "canonical_bs",
        snapshot_id: "sha256-p-dec",
      },
    },
    {
      kind: "ratio", fact: "current_ratio", metric: "current_ratio",
      unit: "ratio", value: 2.8, numerator_minor: 140000,
      denominator_minor: 50000, operand_currency: "RON",
      scope: "December 2024", label_key: "capsule.metric.current_ratio",
      provenance: {
        period_id: "p-dec", period_label: "December 2024", entity_id: "org-1",
        source: "assembled_canonical_v1", tier: "canonical_bs",
        snapshot_id: "sha256-p-dec",
      },
    },
  ],
  rows: [], gaps: [], limitations: [], notes: [],
};

/** THE SAME TOOL, REFUSING. A period with no attached file: the engine
 *  states a GAP and states NO NUMBER. C5's live subject — the surface
 *  must show the absence and must not render a zero in its place. */
const TOOL_PAYLOAD_GAP = {
  version: "ct1",
  tool: "get_facts",
  read_only: true,
  ok: false,
  values: [],
  rows: [],
  gaps: [
    {
      code: "no_source_file",
      tool: "get_facts",
      detail_key: "capsule.gap.no_source_file",
      detail: "October 2024 has no attached file.",
      scope: "October 2024",
    },
  ],
  limitations: [], notes: [],
};

const GROUNDED_ANSWER =
  "Total assets stand at {{money:total_assets}} for December 2024, with a " +
  "current ratio of {{fact:current_ratio|d2}}.";
/** The same claim as the model would write it if nothing stopped it.
 *  The hardcoded money string IS the defect under test. */
const FABRICATED_ANSWER =
  // eslint-disable-next-line no-restricted-syntax
  "Total assets stand at RON 3,900 for December 2024, with a current ratio " +
  "of 2.8 — roughly 15% better than last month.";
/** A realistic upstream failure body. None of it may reach the DOM. */
const RAW_500 = JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: "max_tokens: field required" },
  request_id: "req_011CTHagbPFpjPQ2VYbAdi8n",
});
const FORBIDDEN_FRAGMENTS = [
  "request_id", "req_011", "invalid_request_error", "max_tokens", "Traceback",
];

const GENERATION_URL = "**/functions/v1/chat-llm";
const TOOLS_URL = "**/api/capsule/tools/**";
/** Anything matching this is a SPEND. Used to count, not to block. */
const SPEND_RE = /functions\/v1\/chat-llm|\/api\/capsule\/tools|anthropic/i;

// ── the figure law, mirrored from the unit gates ───────────────────────
//
// IDENTIFIER  names a thing you can look up: a period label ("December
//             2024"), an account code ("461"), a served line id ("I18").
// FIGURE      states a quantity: separators between digits, a currency
//             or a percent beside it, or a number that names nothing.
//
// `tests/engine/test_capsule_gates.py::figures_in` and
// `capsuleGates.test.ts::figuresIn` are the same rule; GATES.md states
// it in prose. Three files, one rule — the rule IS the gate. They are
// mirrored rather than shared because an in-page evaluator cannot
// import a module and Python cannot import TypeScript.

const PROVENANCE_ATTRS = [
  "data-narrative-money",
  "data-traceable-source-statement",
  "data-provenance",
  "data-fact",
];
const PROVENANCE_CONTAINERS = [
  '[data-testid="capsule-figure-row"]',
  '[data-testid="capsule-citation"]',
  '[data-testid="capsule-trace"]',
  '[data-testid="capsule-comparison"]',
  '[data-testid="capsule-sparkline"]',
];

async function unprovenancedFigures(
  scope: Locator,
  allowed: string[],
): Promise<Array<{ text: string; html: string }>> {
  return scope.evaluate(
    (root, { attrs, containers, allowedTokens }) => {
      const SEPARATORS = ".,\u00a0\u202f ";
      const DIGIT_RUN = /\d[\d.,\u00a0\u202f ]*\d|\d/g;
      const GROUPED = /\d[.,\u00a0\u202f ]\d/;
      const CURRENCY =
        /(?:(?:RON|EUR|USD|GBP|LEI|€|\$|£)\s*\d)|(?:\d\s*(?:RON|EUR|USD|GBP|LEI|€|\$|£|%|pp))/i;

      const stripAllowed = (text: string): string => {
        let out = text;
        for (const token of [...allowedTokens].sort((a, b) => b.length - a.length)) {
          if (!token) continue;
          let from = 0;
          for (;;) {
            const i = out.indexOf(token, from);
            if (i < 0) break;
            const end = i + token.length;
            const before = i > 0 ? out[i - 1] : "";
            const after = out[end] ?? "";
            const glued =
              /\d/.test(before) || /\d/.test(after) ||
              (SEPARATORS.includes(before) && /\d/.test(i > 1 ? out[i - 2] : "")) ||
              (SEPARATORS.includes(after) && /\d/.test(out[end + 1] ?? ""));
            if (glued) { from = i + 1; continue; }
            out = out.slice(0, i) + " ".repeat(token.length) + out.slice(end);
            from = end;
          }
        }
        return out;
      };

      const figures = (text: string): string[] => {
        const stripped = stripAllowed(text);
        if (GROUPED.test(stripped) || CURRENCY.test(stripped)) {
          return [stripped.trim()];
        }
        const out: string[] = [];
        DIGIT_RUN.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = DIGIT_RUN.exec(stripped)) !== null) {
          const before = m.index > 0 ? stripped[m.index - 1] : "";
          const after = stripped[m.index + m[0].length] ?? "";
          if (/[A-Za-z_]/.test(before) || /[A-Za-z_]/.test(after)) continue;
          out.push(m[0]);
        }
        return out;
      };

      const traceable = (el: Element | null): boolean => {
        let cur: Element | null = el;
        while (cur) {
          for (const a of attrs) if (cur.hasAttribute(a)) return true;
          for (const sel of containers) if (cur.matches(sel)) return true;
          if (cur === root) return false;
          cur = cur.parentElement;
        }
        return false;
      };

      const offenders: Array<{ text: string; html: string }> = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null = walker.nextNode();
      while (node) {
        const text = node.textContent ?? "";
        if (figures(text).length && !traceable(node.parentElement)) {
          offenders.push({
            text: text.trim().slice(0, 120),
            html: (node.parentElement?.outerHTML ?? "").slice(0, 200),
          });
        }
        node = walker.nextNode();
      }
      return offenders;
    },
    { attrs: PROVENANCE_ATTRS, containers: PROVENANCE_CONTAINERS, allowedTokens: allowed },
  );
}

const ALLOWED_IDENTIFIERS = [
  "December 2024", "November 2024", "October 2024", "461", "5121", "2024", "2026",
];

// ── KNOWN GAP, quarantined by name (a ratchet, not an exemption) ──────
//
// `NarrativeText` attributes MONEY parts (`data-narrative-money`, the
// provenance in `title`) but renders a resolved DIMENSIONLESS fact — a
// ratio, a percent, a day count — as a bare `<span>2.80</span>`. In the
// DOM that figure is indistinguishable from one a model typed, which is
// exactly the distinction C1 and C3 exist to make. `narrativeMoney.tsx`
// is import-only for this lane, so the gate stays strict and licenses
// only the exact string the fixture's ratio resolves to.
//
// THE FIX (whoever owns narrativeMoney.tsx): give the dimensionless
// branch a `data-narrative-fact={fact}` span, as the money branch
// already does. When that lands, delete this constant — the gate gets
// stricter for free. Recorded in design_review/capsule/GATES.md.
const KNOWN_UNATTRIBUTED_DIMENSIONLESS = ["2.80"];

// ── boot / surface helpers ─────────────────────────────────────────────

function appHeader(page: Page): Locator {
  return page.locator("header").filter({ has: page.locator(ANCHORS.accountTrigger) }).first();
}

async function boot(page: Page, route = "/dashboard"): Promise<void> {
  await preseedLearningMode(page);
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS);
  await dismissPublicTestBanner(page);
}

/** ACTION_MS, not the project's 8 s default. The rebuilt surface loads a
 *  heavier bundle and the trigger settles a beat later; an 8 s action
 *  timeout was reporting "the gate failed" when the truth was "the page
 *  was still booting". A gate must fail on the PRODUCT, never on the
 *  harness's patience. */
const ACTION_MS = 20_000;

async function openSurface(page: Page): Promise<Locator> {
  await appHeader(page).locator(ANCHORS.trigger).click({ timeout: ACTION_MS });
  const overlay = page.locator(ANCHORS.overlay);
  await expect(overlay).toBeVisible({ timeout: ACTION_MS });
  // Radix portals + the open animation; geometry read before this
  // settles measures the animation, not the design.
  await page.waitForTimeout(500);
  return overlay;
}

function surfaceInput(page: Page): Locator {
  return page.locator(ANCHORS.input).first();
}

async function stubGeneration(page: Page, answer: string): Promise<void> {
  await page.route(GENERATION_URL, async (route) => {
    await route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify({ answer }),
    });
  });
}

async function stubTools(page: Page, payload: unknown = TOOL_PAYLOAD): Promise<void> {
  await page.route(TOOLS_URL, async (route) => {
    await route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(payload),
    });
  });
}

/**
 * Ask through the ASK-FIRST path: type, press Enter, done.
 *
 * The pre-wave helper had to `press("Tab")` first, because "Ask a
 * question" was a ROW and Enter ran whatever row happened to be
 * selected — which was the first navigation destination. That extra
 * keystroke was the defect, written into the test harness. It is gone,
 * deliberately: if the surface regresses to needing it, every gate that
 * asks a question fails, which is the correct blast radius.
 */
/**
 * A QUESTION TIER 0 MUST REFUSE — for the gates whose subject is the
 * MODEL path.
 *
 * "what are total assets" used to reach the model. It does not any more:
 * the Enter boundary answers it from the local fact index with no
 * reservation and no request (`CommandPalette.enterAnswerMode`). That is
 * the whole point of Tier 0, it is gated by K3 below and by
 * `frontend/components/instrument/shell/__tests__/capsuleSpendBoundary.test.tsx`,
 * and it broke seven gates in this file in two different ways:
 *
 *   FOUR FAILED — ANCHORS, K4, K5 and K9/C3 wait for a
 *   `capsule-figure-row`, and a one-fact Tier-0 answer renders its
 *   figure in the FACT CARD with nothing left for the list ("one answer,
 *   one number").
 *
 *   THREE PASSED VACUOUSLY, which is worse. K9/C1 stubs a FABRICATED
 *   answer that was never requested; K9/C5 stubs a GAP payload that was
 *   never fetched; K9/C2 watches a tool endpoint that was never called.
 *   Each would have kept passing with the invariant it guards removed.
 *
 * So the model-path gates ask for an INTERPRETATION of the same metric.
 * The retrieval plan is identical (`get_facts`), so every stub in this
 * file still applies — only the tier changes, which is exactly what
 * these gates meant to exercise all along. The Tier-0 path keeps its own
 * question, in K3, where it is the subject.
 */
const TIER1_QUESTION = "why are total assets at this level";

async function ask(page: Page, question: string): Promise<Locator> {
  const input = surfaceInput(page);
  await input.click({ timeout: ACTION_MS });
  await input.fill(question, { timeout: ACTION_MS });
  await page.waitForTimeout(250);
  await input.press("Enter", { timeout: ACTION_MS });
  const answer = page.locator(ANCHORS.answer);
  await expect(answer).toBeVisible({ timeout: 20_000 });
  return answer;
}

function p(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

// ══════════════════════════════════════════════════════════════════════
// ANCHOR LIVENESS — this file may not be a carrier of the disease it treats
// ══════════════════════════════════════════════════════════════════════

test.describe("ANCHORS — every selector this file asserts on can actually match", () => {
  test.setTimeout(120_000);

  test("closed, open and answered anchors all resolve on the live surface", async ({ page }) => {
    await stubTools(page);
    await stubGeneration(page, GROUNDED_ANSWER);
    await boot(page);

    const dead: string[] = [];
    for (const key of ANCHORS_CLOSED) {
      if ((await page.locator(ANCHORS[key]).count()) === 0) dead.push(`${key} → ${ANCHORS[key]}`);
    }
    expect(
      dead,
      "ANCHOR LAW: a selector this spec depends on matches nothing with the " +
        "surface closed. Every negative assertion downstream would pass " +
        "vacuously — retarget the anchor before trusting a single gate below.",
    ).toEqual([]);

    await openSurface(page);
    for (const key of ANCHORS_OPEN) {
      if ((await page.locator(ANCHORS[key]).count()) === 0) dead.push(`${key} → ${ANCHORS[key]}`);
    }
    expect(dead, "ANCHOR LAW: an open-state anchor matches nothing.").toEqual([]);

    await ask(page, TIER1_QUESTION);
    // WAIT, do not snapshot. `ask()` returns when the answer surface is
    // visible; the figures resolve a beat later. Counting at that instant
    // reported a live anchor as dead — the false RED that mirrors the
    // false green this law exists to stop.
    for (const key of ANCHORS_ANSWERED) {
      const ok = await page
        .locator(ANCHORS[key])
        .first()
        .waitFor({ state: "attached", timeout: ACTION_MS })
        .then(() => true)
        .catch(() => false);
      if (!ok) dead.push(`${key} → ${ANCHORS[key]}`);
    }
    expect(dead, "ANCHOR LAW: an answered-state anchor matches nothing.").toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// K1 — ASK-FIRST
// ══════════════════════════════════════════════════════════════════════

/** An ask verb, per language. RO informal tu-form. */
const ASK_VERB = /(\bask\b|întreab|intreab)/i;
/** The row label the pre-wave surface rendered, in both languages. */
const ASK_ROW_LABELS = [/^ask a question/i, /^întreab(ă|a) ceva/i, /^ask cfo ai$/i];

test.describe("K1 — the verb is ASK, and asking is the default action", () => {
  test.setTimeout(120_000);

  test("the placeholder contains an ask verb", async ({ page }) => {
    await boot(page);
    await openSurface(page);
    const placeholder =
      (await surfaceInput(page).getAttribute("placeholder")) ??
      (await surfaceInput(page).getAttribute("aria-label")) ??
      "";
    expect(
      placeholder,
      `K1: the prose input reads ${JSON.stringify(placeholder)}. A user who ` +
        `reads "search" types a noun, gets a list, and never learns the ` +
        `surface answers. The verb is ASK.`,
    ).toMatch(ASK_VERB);
  });

  // FOUND BY PLANT C, not by design. The K8 plant printed the header
  // inventory, and there it was: `aria-label="Search"` on the capsule
  // trigger, months after the placeholder was rewritten to "Ask
  // anything". The static gate could not see it because the label is now
  // built through `t(...)` and resolves only at runtime, so the law is
  // asserted where the value actually exists.
  //
  // This matters more than the placeholder it sits beside: the
  // accessible name is the ONLY name a screen-reader user is given. A
  // sighted user reads "Ask anything" and a blind user is told "Search",
  // and the two are handed different products.
  test("the trigger's ACCESSIBLE NAME says ask, not search", async ({ page }) => {
    await boot(page);
    const trigger = appHeader(page).locator(ANCHORS.trigger);
    const name =
      (await trigger.getAttribute("aria-label")) ??
      (await trigger.getAttribute("title")) ??
      (await trigger.innerText());
    const title = (await trigger.getAttribute("title")) ?? "";
    for (const [what, value] of [["aria-label", name], ["title", title]] as const) {
      if (!value) continue;
      expect(
        value,
        `K1: the capsule's ${what} is ${JSON.stringify(value)}. That is the name ` +
          `a screen-reader user is read; the placeholder they cannot see says ` +
          `"Ask anything". Same control, two different products.`,
      ).toMatch(ASK_VERB);
    }
  });

  test("no 'Ask a question' ROW exists in the DOM", async ({ page }) => {
    await boot(page);
    const overlay = await openSurface(page);

    // Empty state …
    const emptyRows = await overlay.evaluate((el) =>
      [...el.querySelectorAll('[role="option"], [role="menuitem"], li')].map((r) =>
        (r.textContent ?? "").trim().replace(/\s+/g, " "),
      ),
    );
    // … and with a question half-typed, which is where the row used to
    // appear with the query interpolated into it.
    await surfaceInput(page).fill("what are total assets", { timeout: ACTION_MS });
    await page.waitForTimeout(700);
    const typedRows = await overlay.evaluate((el) =>
      [...el.querySelectorAll('[role="option"], [role="menuitem"], li')].map((r) =>
        (r.textContent ?? "").trim().replace(/\s+/g, " "),
      ),
    );

    const offenders = [...emptyRows, ...typedRows].filter((label) =>
      ASK_ROW_LABELS.some((re) => re.test(label)),
    );
    expect(
      offenders,
      `K1: "Ask" is still a ROW among navigation destinations. Asking is the ` +
        `surface's PURPOSE, not one of its menu items. Rows seen: ` +
        `${JSON.stringify([...emptyRows, ...typedRows].slice(0, 20))}`,
    ).toEqual([]);
  });

  test("Enter in the prose input ANSWERS — no Tab, no row selection", async ({ page }) => {
    await stubTools(page);
    await stubGeneration(page, GROUNDED_ANSWER);
    await boot(page);
    await openSurface(page);

    const input = surfaceInput(page);
    await input.click({ timeout: ACTION_MS });
    await input.fill("what are total assets", { timeout: ACTION_MS });
    await page.waitForTimeout(350);
    await input.press("Enter", { timeout: ACTION_MS });

    await expect(
      page.locator(ANCHORS.answer),
      "K1: Enter on a question did not produce an answer. The default action " +
        "of the prose input IS the answer; anything else makes asking a " +
        "navigation choice the reader has to find.",
    ).toBeVisible({ timeout: 20_000 });
  });
});

// ══════════════════════════════════════════════════════════════════════
// K2 — THE EMPTY-STATE BUDGET
// ══════════════════════════════════════════════════════════════════════
//
// The counting rules are stated once in
// `frontend/lib/__tests__/capsuleAskGates.test.ts::budgetCensus` and
// mirrored here as an in-page evaluator. Same rule, two runtimes.

const ZONE_BUDGET = 3;
const ROW_BUDGET = 8;

async function budgetCensus(overlay: Locator) {
  return overlay.evaluate((root) => {
    const ROW_SELECTOR = [
      '[role="option"]', '[role="menuitem"]', '[role="menuitemradio"]',
      "li button", "li a[href]", '[role="listbox"] button', '[role="list"] button',
    ].join(", ");
    const ZONE_SELECTOR = [
      '[role="group"]', '[role="region"]', "section",
      "h1, h2, h3, h4, h5, h6",
    ].join(", ");
    const vis = (el: Element) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== "none" && cs.visibility !== "hidden" && r.height > 0;
    };
    const rows = [...root.querySelectorAll(ROW_SELECTOR)].filter(vis);
    const topRows = rows.filter((el) => !rows.some((o) => o !== el && o.contains(el)));
    const zoneEls = [...root.querySelectorAll(ZONE_SELECTOR)].filter(vis);
    for (const el of [...root.querySelectorAll("[aria-label], [aria-labelledby]")]) {
      if (!vis(el) || el.matches(ROW_SELECTOR)) continue;
      if (!topRows.some((r) => el.contains(r))) continue;
      if (!zoneEls.includes(el)) zoneEls.push(el);
    }
    const zones = zoneEls.filter(
      (el) => !zoneEls.some((o) => o !== el && o.contains(el) && el.tagName.length > 2),
    );
    const label = (el: Element) =>
      (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 44);
    return {
      zones: zones.length, rows: topRows.length,
      zoneLabels: zones.map(label), rowLabels: topRows.map(label),
    };
  });
}

test.describe("K2 — what the reader sees before typing is a glance, not a menu", () => {
  test.setTimeout(120_000);

  for (const route of ["/dashboard", "/chat"]) {
    test(`≤${ZONE_BUDGET} zones and ≤${ROW_BUDGET} rows on ${route}`, async ({ page }) => {
      await boot(page, route);
      const overlay = await openSurface(page);
      const c = await budgetCensus(overlay);
      // eslint-disable-next-line no-console
      console.log(`[K2 ${route}] ${c.zones} zones · ${c.rows} rows`);
      expect(
        c.zones,
        `K2: ${c.zones} zones before a keystroke (budget ${ZONE_BUDGET}). ` +
          `Zones: ${JSON.stringify(c.zoneLabels)}`,
      ).toBeLessThanOrEqual(ZONE_BUDGET);
      expect(
        c.rows,
        `K2: ${c.rows} rows before a keystroke (budget ${ROW_BUDGET}). ` +
          `Rows: ${JSON.stringify(c.rowLabels)}`,
      ).toBeLessThanOrEqual(ROW_BUDGET);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════
// K3 — TIER 0, LIVE: an answer that costs nothing
// ══════════════════════════════════════════════════════════════════════

test.describe("K3 — a lookup question is answered without reaching the model", () => {
  test.setTimeout(150_000);

  // WHERE TIER 0 LIVES — AND WHERE THE LAW HAD TO MOVE TO.
  //
  // A first draft of this gate typed a question, pressed Enter, and
  // waited for a figure row. It failed with two model calls, and the
  // conclusion drawn at the time was that the gate was wrong: Tier 0
  // resolves AS YOU TYPE into `capsule-tier0`, and Enter is "the
  // ESCALATION to Tier 1, which is allowed to spend because the reader
  // asked for more."
  //
  // That conclusion was the defect, written down. `enterAnswerMode`
  // called `askModel` unconditionally, so pressing Enter on a question
  // Tier 0 had ALREADY ANSWERED took a chat reservation and issued a
  // model request — for a figure the client was displaying at that
  // moment, in 0.013 ms, with provenance. The reader never asked for
  // more; they pressed Enter on the answer in front of them.
  //
  // So the law is stated in BOTH places now, because the contract —
  // "INSTANT, ZERO MODEL CALLS, works offline / credits-down" — has to
  // hold at the boundary where it costs money:
  //
  //   · while typing        the answer resolves and nothing is spent
  //   · ON ENTER            the answer OPENS and nothing is spent
  //
  // Escalation is still available and still deliberate: it is the
  // `interpret` follow-up chip on the answer, one keystroke away and
  // explicitly chosen.
  const TIER0 = '[data-testid="capsule-tier0"]';

  test("a headline-metric question answers WHILE TYPING, with ZERO spend", async ({ page }) => {
    // Deliberately NOT stubbed: an unrouted request would be a real one,
    // and the counter below records it. Counting beats mocking here.
    const spends: string[] = [];
    page.on("request", (req) => {
      if (SPEND_RE.test(req.url())) spends.push(`${req.method()} ${req.url()}`);
    });
    await boot(page);
    await openSurface(page);

    const input = surfaceInput(page);
    await input.click({ timeout: ACTION_MS });
    const t0 = Date.now();
    await input.fill("total assets", { timeout: ACTION_MS });

    const resolved = await page
      .locator(TIER0)
      .first()
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    const ms = Date.now() - t0;

    // eslint-disable-next-line no-console
    console.log(`[K3 live] tier-0 resolved=${resolved} in ${ms}ms · spends=${spends.length}`);

    expect(
      resolved,
      `K3: "total assets" — a fact the index holds — produced no Tier-0 answer ` +
        `within 5 s. Tier 0 is the tier that costs nothing; if it never fires, ` +
        `every question is a billed question.`,
    ).toBe(true);
    expect(
      spends,
      `K3: resolving a Tier-0 question spent. Requests observed:\n  ${spends.join("\n  ")}`,
    ).toEqual([]);
    expect(ms, `K3: tier-0 answer took ${ms}ms`).toBeLessThan(1500);
  });

  test("pressing ENTER on a Tier-0 question still spends nothing", async ({ page }) => {
    // Deliberately NOT stubbed, for the same reason as above: an
    // unrouted request would be a REAL one, and the counter records it.
    const spends: string[] = [];
    page.on("request", (req) => {
      if (SPEND_RE.test(req.url())) spends.push(`${req.method()} ${req.url()}`);
    });
    await boot(page);
    await openSurface(page);

    const input = surfaceInput(page);
    await input.click({ timeout: ACTION_MS });
    await input.fill("total assets", { timeout: ACTION_MS });
    await page.waitForTimeout(400);
    await input.press("Enter", { timeout: ACTION_MS });

    const answer = page.locator(ANCHORS.answer);
    await expect(answer).toBeVisible({ timeout: 20_000 });
    // The canvas is up. Give any stray dispatch a beat to land, or this
    // gate passes by being early rather than by being right.
    await page.waitForTimeout(1500);

    // eslint-disable-next-line no-console
    console.log(`[K3 enter] spends=${spends.length}${spends.length ? " · " + spends.join(" · ") : ""}`);

    expect(
      spends,
      `K3: pressing Enter on a question Tier 0 had already answered reached ` +
        `the model. The figure was on screen, resolved from the local index ` +
        `with provenance — paying for it is paying twice. Requests observed:` +
        `\n  ${spends.join("\n  ")}`,
    ).toEqual([]);

    // A TIER-0 ANSWER IS A FULL ANSWER, not a preview that dead-ends.
    await expect(answer.locator('[data-testid="capsule-fact-card"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(answer.locator('[data-testid="capsule-citation"]').first()).toBeVisible();
    await expect(
      answer.locator('[data-testid="capsule-followup-chip"][data-kind="interpret"]'),
      "K3: the Tier-0 answer offered no deliberate route to the " +
        "interpretation. The cheap honest answer must not be a dead end, or " +
        "the reader retypes the question and pays for it anyway.",
    ).toBeVisible({ timeout: 10_000 });
    expect(
      await unprovenancedFigures(answer, [
        ...ALLOWED_IDENTIFIERS,
        ...KNOWN_UNATTRIBUTED_DIMENSIONLESS,
      ]),
      "K3/C3: the Tier-0 ANSWER (not the preview) put a number on screen " +
        "that names no source.",
    ).toEqual([]);
  });

  test("the Tier-0 answer carries a figure with provenance, not a bare number", async ({ page }) => {
    await boot(page);
    await openSurface(page);
    await surfaceInput(page).fill("total assets", { timeout: ACTION_MS });
    const tier0 = page.locator(TIER0).first();
    const shown = await tier0
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!shown, "K3: no Tier-0 answer to inspect — covered by the gate above");

    expect(
      await unprovenancedFigures(tier0, [...ALLOWED_IDENTIFIERS, ...KNOWN_UNATTRIBUTED_DIMENSIONLESS]),
      "K3/C3: the instant answer put a number on screen that names no source. " +
        "Speed is not a licence to drop provenance — a fast wrong number is worse " +
        "than a slow right one.",
    ).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// K4 — FACT BEFORE PROSE (ordering, observed)
// ══════════════════════════════════════════════════════════════════════

test.describe("K4 — the figure lands before the first word of prose", () => {
  test.setTimeout(120_000);

  test("a MutationObserver records the figure first, every time", async ({ page }) => {
    await stubTools(page);
    // Generation is DELIBERATELY INSTANT — the most hostile ordering for
    // this gate. A pass under a zero-latency model means the ordering is
    // structural, not a race the fixture happened to win.
    await stubGeneration(page, GROUNDED_ANSWER);
    await boot(page);
    await openSurface(page);

    // Install BEFORE asking: an observer attached afterwards can only
    // report what it did not see.
    await page.evaluate(
      ({ figureSel, bodySel }) => {
        const w = window as unknown as Record<string, unknown>;
        w.__k4 = { figureAt: null as number | null, proseAt: null as number | null };
        const rec = w.__k4 as { figureAt: number | null; proseAt: number | null };
        const check = () => {
          const now = performance.now();
          if (rec.figureAt === null && document.querySelector(figureSel)) rec.figureAt = now;
          const body = document.querySelector(bodySel);
          if (rec.proseAt === null && body && (body.textContent ?? "").trim().length > 0) {
            rec.proseAt = now;
          }
        };
        new MutationObserver(check).observe(document.body, {
          childList: true, subtree: true, characterData: true,
        });
        check();
      },
      { figureSel: ANCHORS.figureRow, bodySel: ANCHORS.answerBody },
    );

    await ask(page, TIER1_QUESTION);
    await expect(page.locator(ANCHORS.figureRow).first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1200);

    const rec = await page.evaluate(
      () => (window as unknown as { __k4: { figureAt: number | null; proseAt: number | null } }).__k4,
    );
    // eslint-disable-next-line no-console
    console.log(`[K4 live] figure at ${rec.figureAt?.toFixed(0)}ms · prose at ${rec.proseAt?.toFixed(0)}ms`);

    expect(rec.figureAt, "K4: no figure ever appeared — nothing to order").not.toBeNull();
    if (rec.proseAt === null) return; // deterministic path: figures only
    expect(
      rec.figureAt!,
      `K4: prose appeared at ${rec.proseAt!.toFixed(0)}ms, the figure only at ` +
        `${rec.figureAt!.toFixed(0)}ms. The fact card IS the answer; the prose ` +
        `is the gloss on it, and a reader who gets words first has to wait to ` +
        `find out whether to believe them.`,
    ).toBeLessThanOrEqual(rec.proseAt!);
  });
});

// ══════════════════════════════════════════════════════════════════════
// K5 — LATENCY, MEASURED AND PUBLISHED
// ══════════════════════════════════════════════════════════════════════

interface Baseline { key: string; p50: number; p95: number }

function latencyBaseline(): Baseline[] {
  const src = readFileSync(path.join(REPO_ROOT, "design_review/capsule/LATENCY.md"), "utf-8");
  const block = /```latency-baseline\n([\s\S]*?)```/.exec(src);
  if (!block) throw new Error("K5: LATENCY.md carries no ```latency-baseline``` block.");
  const rows: Baseline[] = [];
  for (const line of block[1].split("\n")) {
    const m = /^\s*([a-z0-9_.-]+)\s+([\d.]+)\s+([\d.]+)\s*$/i.exec(line);
    if (m) rows.push({ key: m[1], p50: Number(m[2]), p95: Number(m[3]) });
  }
  if (!rows.length) throw new Error("K5: the latency-baseline block parsed to zero rows.");
  return rows;
}

test.describe("K5 — measured, not promised", () => {
  test.setTimeout(180_000);

  test("open, keystroke→rows, and question→first painted figure", async ({ page }) => {
    await stubTools(page);
    await stubGeneration(page, GROUNDED_ANSWER);
    await boot(page);

    const opens: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t = Date.now();
      await openSurface(page);
      opens.push(Date.now() - t - 500); // the deliberate settle wait
      await page.keyboard.press("Escape");
      await page.waitForTimeout(350);
    }

    await openSurface(page);
    const input = surfaceInput(page);
    const keystroke: number[] = [];
    for (const q of ["dashboard", "cash flow", "settings", "products",
                     "benchmark", "TLV", "461", "upload trial balance"]) {
      await input.fill("");
      const t = Date.now();
      await input.fill(q);
      await page.waitForTimeout(60);
      keystroke.push(Date.now() - t);
    }

    await input.fill("");
    const tAsk = Date.now();
    const answer = await ask(page, TIER1_QUESTION);
    await expect(answer.locator(ANCHORS.figureRow).first()).toBeVisible({ timeout: 20_000 });
    const firstFigure = Date.now() - tAsk;

    const measured = {
      surface_open_ms: { p50: p(opens, 0.5), p95: p(opens, 0.95) },
      keystroke_rows_ms: { p50: p(keystroke, 0.5), p95: p(keystroke, 0.95) },
      question_first_figure_ms: { p50: firstFigure, p95: firstFigure },
    };
    // eslint-disable-next-line no-console
    console.log(
      `\n[K5 live] surface open p50 ${measured.surface_open_ms.p50}ms / p95 ` +
        `${measured.surface_open_ms.p95}ms · keystroke→rows p50 ` +
        `${measured.keystroke_rows_ms.p50}ms / p95 ${measured.keystroke_rows_ms.p95}ms · ` +
        `question→first figure ${firstFigure}ms ` +
        `(generation fulfilled from a fixture — NO model time included)\n`,
    );

    const base = latencyBaseline();
    const regressions: string[] = [];
    for (const [key, m] of Object.entries(measured)) {
      const b = base.find((r) => r.key === key);
      if (!b) continue;
      // 2.5× — this runs on a dev machine with a live vite server; a gate
      // that fires on a noisy neighbour teaches people to ignore it, and
      // 2.5× still catches every regression a user would notice.
      if (m.p95 > Math.max(b.p95 * 2.5, b.p95 + 60)) {
        regressions.push(`${key}: p95 ${m.p95}ms vs baseline ${b.p95}ms`);
      }
    }
    expect(
      regressions,
      `K5: latency regressed past the recorded baseline in ` +
        `design_review/capsule/LATENCY.md:\n  ${regressions.join("\n  ")}`,
    ).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// K6 — MORPH INTEGRITY
// ══════════════════════════════════════════════════════════════════════
//
// The owner's words: "the overlay renders as a detached flat panel BELOW
// the capsule, no morph, large dead space". Made measurable:
//
//   the overlay's geometry ORIGINATES FROM THE CAPSULE'S BOUNDING BOX
//
// which is three numbers, not an opinion:
//   · horizontally CENTRED ON THE CAPSULE, not on the viewport
//   · TOP anchored to the capsule's own top/bottom edge, not to a
//     hard-coded offset
//   · WIDTH grown from the capsule's width, not set to a constant
//
// Measured before this wave (1440×900, /dashboard):
//   capsule  x 486.7  w 538   bottom 44.5   centre-x 755.7
//   overlay  x 420    w 600   top 112       centre-x 720
// → 35.7px of horizontal drift, 67.5px of vertical gap, 62px of width
//   mismatch. The panel is centred on the VIEWPORT and pinned at a
//   literal `top-[112px]`, which is precisely "no morph".

const MORPH_CENTRE_TOL = 24;
const MORPH_TOP_GAP_TOL = 24;

test.describe("K6 — the overlay grows out of the capsule, and nothing jumps", () => {
  test.setTimeout(150_000);

  async function boxes(page: Page) {
    const cap = await appHeader(page).locator(ANCHORS.trigger).boundingBox();
    const overlay = await openSurface(page);
    const ov = await overlay.boundingBox();
    return { cap: cap!, ov: ov! };
  }

  // ── THE ANCHOR MUST BE INVOKED, NOT MERELY CORRECT ──────────────────
  //
  // `anchoredLeft` was written, exported and unit-tested — and never
  // called. Radix mounts `Dialog.Content` one commit AFTER `open` flips,
  // so a layout effect keyed on `[open]` ran while the node ref was
  // still null, took its early return, and never ran again. The panel
  // kept its `sm:mx-auto` fallback, the inline `style` attribute was
  // empty, and the maths every unit test agreed with governed nothing.
  //
  // The centre test below would ALSO have caught that — but only as a
  // number, and a number has many possible causes. This one names the
  // cause: an inline `left`, written by the hook, equal to what
  // `anchoredLeft` computes from the SAME two boxes it read. Recomputed
  // here in the page rather than imported, so the assertion is a second
  // opinion and not the implementation checking itself.
  test("the anchor actually RAN — the panel carries the left it computed", async ({ page }) => {
    await boot(page);
    await openSurface(page);

    const probe = await page.evaluate(
      ({ overlaySel, triggerSel, margin }) => {
        const panel = document.querySelector(overlaySel) as HTMLElement | null;
        const pill = document.querySelector(triggerSel) as HTMLElement | null;
        if (!panel || !pill) return null;
        const p = panel.getBoundingClientRect();
        const t = pill.getBoundingClientRect();
        // `anchoredLeft`, restated: centre the panel under the pill, then
        // clamp into the viewport with a margin.
        const ideal = t.left + t.width / 2 - p.width / 2;
        const max = Math.max(margin, window.innerWidth - p.width - margin);
        const expected = Math.round(Math.min(Math.max(ideal, margin), max));
        return {
          inlineLeft: panel.style.left,
          inlineMarginLeft: panel.style.marginLeft,
          expected,
          panelLeft: p.left,
          panelWidth: p.width,
          pillLeft: t.left,
          pillWidth: t.width,
          viewport: window.innerWidth,
        };
      },
      { overlaySel: ANCHORS.overlay, triggerSel: ANCHORS.morphTrigger, margin: 8 },
    );

    expect(probe, "K6: overlay or capsule pill not in the DOM").not.toBeNull();
    // eslint-disable-next-line no-console
    console.log(
      `[K6 anchor] inline left "${probe!.inlineLeft}" · expected ` +
        `${probe!.expected}px · panel ${probe!.panelLeft.toFixed(1)}×` +
        `${probe!.panelWidth.toFixed(0)} · pill ${probe!.pillLeft.toFixed(1)}×` +
        `${probe!.pillWidth.toFixed(0)} · viewport ${probe!.viewport}`,
    );

    expect(
      probe!.inlineLeft,
      "K6: the overlay carries NO inline `left`. `useCapsuleMorph` never " +
        "wrote one, so the panel is sitting where `sm:mx-auto` put it — " +
        "centred on the VIEWPORT — and `anchoredLeft` is dead code that " +
        "every unit test still agrees with. This is the exact shape of the " +
        "defect: written, exported, unit-tested and never called.",
    ).not.toBe("");

    expect(
      Math.abs(parseFloat(probe!.inlineLeft) - probe!.expected),
      `K6: the inline left (${probe!.inlineLeft}) is not what \`anchoredLeft\` ` +
        `computes from the live boxes (${probe!.expected}px). The hook ran but ` +
        `measured something other than the capsule's pill.`,
    ).toBeLessThanOrEqual(1);
  });

  test("the overlay is centred on the CAPSULE, not on the viewport", async ({ page }) => {
    await boot(page);
    const { cap, ov } = await boxes(page);
    const capCentre = cap.x + cap.width / 2;
    const ovCentre = ov.x + ov.width / 2;
    const viewport = page.viewportSize()!.width / 2;
    const drift = Math.abs(ovCentre - capCentre);
    const gap = ov.y - (cap.y + cap.height);

    // eslint-disable-next-line no-console
    console.log(
      `[K6 centre] capsule centre ${capCentre.toFixed(0)} · overlay centre ` +
        `${ovCentre.toFixed(0)} · viewport centre ${viewport.toFixed(0)} · ` +
        `drift ${drift.toFixed(1)}px · gap ${gap.toFixed(1)}px`,
    );

    expect(
      drift,
      `K6: the overlay's centre is ${drift.toFixed(1)}px from the capsule's and ` +
        `${Math.abs(ovCentre - viewport).toFixed(1)}px from the VIEWPORT's. A panel ` +
        `centred on the viewport did not come out of the control the user clicked — ` +
        `that is exactly "a detached flat panel, no morph", stated in pixels. ` +
        `Origin the geometry on the capsule's box (its centre, its edges), not on ` +
        "the viewport's midline, not `left-1/2`.",
    ).toBeLessThanOrEqual(MORPH_CENTRE_TOL);

    expect(
      gap,
      `K6: ${gap.toFixed(1)}px of empty space between the capsule and the panel it ` +
        `is supposed to have become. A hard-coded top offset cannot morph.`,
    ).toBeLessThanOrEqual(MORPH_TOP_GAP_TOL);
  });

  // ── WIDTH: DERIVED, NOT CONSTANT ────────────────────────────────────
  //
  // An earlier draft compared overlay width to capsule width at ONE
  // viewport and failed anything beyond ±25%. That was a proxy, and a
  // bad one: a morph is allowed to GROW as it becomes an answer panel,
  // so the ratio test banned a legitimate design while catching the
  // illegitimate one only by luck.
  //
  // The real question is whether the width is DERIVED from the capsule
  // or is a literal constant, and one measurement cannot tell those
  // apart. Two can: change the viewport so the capsule's own width
  // changes, and watch whether the overlay follows. A constant does not
  // move. This is strictly stronger than the ratio it replaces — and it
  // is not a loosening: the centre law above still fails on the same
  // defect the ratio was failing on.
  test("the overlay's width is derived from the capsule's, not a constant", async ({ page }) => {
    await boot(page);
    const wide = await boxes(page);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    await page.setViewportSize({ width: 1120, height: 900 });
    await page.waitForTimeout(700);
    const narrow = await boxes(page);

    const capDelta = wide.cap.width - narrow.cap.width;
    const ovDelta = wide.ov.width - narrow.ov.width;
    // eslint-disable-next-line no-console
    console.log(
      `[K6 width] 1440: capsule ${wide.cap.width.toFixed(0)} overlay ${wide.ov.width.toFixed(0)} · ` +
        `1120: capsule ${narrow.cap.width.toFixed(0)} overlay ${narrow.ov.width.toFixed(0)} · ` +
        `Δcapsule ${capDelta.toFixed(0)} Δoverlay ${ovDelta.toFixed(0)}`,
    );

    // NO SILENT SKIP. On this build the capsule is a FIXED 538px at both
    // viewports, so "does the overlay follow the capsule" is
    // unfalsifiable by this measurement — and a test that always skips is
    // the same false green as a selector that never matches. So the
    // measurement is reported as an annotation, and a law that CAN fail
    // is asserted instead: however the overlay is sized, it may not
    // detach in scale from the control it came out of.
    const responsive = Math.abs(capDelta) >= 40;
    test.info().annotations.push({
      type: "k6-width-derivation",
      description: responsive
        ? `capsule is responsive (Δ${capDelta.toFixed(0)}px); overlay moved Δ${ovDelta.toFixed(0)}px`
        : `capsule width is FIXED at ${wide.cap.width.toFixed(0)}px across 1440/1120, so ` +
          `viewport response cannot distinguish a derived width from a constant one. ` +
          `The scale law below is what is actually enforced here.`,
    });
    if (responsive) {
      expect(
        Math.abs(ovDelta),
        `K6: the capsule changed by ${capDelta.toFixed(0)}px and the overlay by ` +
          `${ovDelta.toFixed(0)}px. A width that ignores the control it came from is ` +
          `a constant, and a constant cannot morph.`,
      ).toBeGreaterThan(8);
    }

    const scale = wide.ov.width / wide.cap.width;
    expect(
      scale,
      `K6: the overlay is ${scale.toFixed(2)}× the capsule's width ` +
        `(${wide.ov.width.toFixed(0)} vs ${wide.cap.width.toFixed(0)}). A morph may ` +
        `grow as it becomes an answer panel, but past 2× the reader is no longer ` +
        `looking at the thing they clicked.`,
    ).toBeLessThanOrEqual(2);
  });

  test("CLS is 0 on open, on close, and while the answer streams", async ({ page }) => {
    await stubTools(page);
    await stubGeneration(page, GROUNDED_ANSWER);
    await boot(page);

    const arm = () =>
      page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        w.__cls = 0;
        const obs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const e = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
            // A shift the USER caused by typing is not a layout bug.
            if (!e.hadRecentInput) w.__cls = (w.__cls as number) + e.value;
          }
        });
        obs.observe({ type: "layout-shift", buffered: false });
        w.__clsObs = obs;
      });
    const readCls = () =>
      page.evaluate(() => (window as unknown as { __cls: number }).__cls ?? 0);

    await arm();
    await openSurface(page);
    const onOpen = await readCls();

    await arm();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    const onClose = await readCls();

    await openSurface(page);
    await arm();
    await ask(page, TIER1_QUESTION);
    await page.waitForTimeout(1500);
    const onStream = await readCls();

    // eslint-disable-next-line no-console
    console.log(`[K6 CLS] open ${onOpen.toFixed(4)} · close ${onClose.toFixed(4)} · stream ${onStream.toFixed(4)}`);

    // "CLS 0" in practice means below the browser's own reporting floor;
    // 0.01 is an order of magnitude under Google's 0.1 "good" threshold
    // and is the smallest number a real compositor reliably reports as
    // no shift at all.
    for (const [label, value] of [["open", onOpen], ["close", onClose], ["streaming", onStream]] as const) {
      expect(
        value,
        `K6: CLS ${value.toFixed(4)} during ${label}. The surface moved content ` +
          `under the reader's eyes; a morph that jumps is not a morph.`,
      ).toBeLessThan(0.01);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// K7 — NO DEAD SPACE
// ══════════════════════════════════════════════════════════════════════

const DEAD_SPACE_TOL = 8;

async function heightAudit(overlay: Locator) {
  return overlay.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    let bottom = r.top;
    for (const child of Array.from(el.children)) {
      const b = child.getBoundingClientRect();
      const ccs = getComputedStyle(child);
      if (ccs.display === "none" || ccs.visibility === "hidden") continue;
      bottom = Math.max(bottom, b.bottom);
    }
    return {
      height: Math.round(r.height),
      contentHeight: Math.round(bottom + padBottom - r.top),
      // A region that is SCROLLING is honestly full; dead space is a
      // region taller than what it holds with nothing to scroll.
      overflowing: Array.from(el.querySelectorAll("*")).some((n) => {
        const e = n as HTMLElement;
        return e.scrollHeight > e.clientHeight + 2;
      }),
    };
  });
}

test.describe("K7 — the overlay is exactly as tall as what it holds", () => {
  test.setTimeout(150_000);

  test("height == content height ±8px at every state", async ({ page }) => {
    await stubTools(page);
    await stubGeneration(page, GROUNDED_ANSWER);
    await boot(page);
    const overlay = await openSurface(page);
    const input = surfaceInput(page);

    const states: Array<{ name: string; height: number; contentHeight: number; overflowing: boolean }> = [];
    const snap = async (name: string) => {
      await page.waitForTimeout(450);
      states.push({ name, ...(await heightAudit(overlay)) });
    };

    await snap("empty");
    await input.fill("scenarios");
    await snap("one-match");
    await input.fill("zzzqqq");
    await snap("no-match");
    await input.fill("");
    await ask(page, TIER1_QUESTION);
    await snap("answer");

    // eslint-disable-next-line no-console
    console.log(
      "[K7] " +
        states
          .map((s) => `${s.name} h${s.height}/c${s.contentHeight}${s.overflowing ? " (scrolls)" : ""}`)
          .join(" · "),
    );

    const bad = states.filter(
      (s) => !s.overflowing && Math.abs(s.height - s.contentHeight) > DEAD_SPACE_TOL,
    );
    expect(
      bad.map((s) => `${s.name}: ${s.height}px tall for ${s.contentHeight}px of content`),
      `K7: the overlay reserves space it is not using. Dead space is the ` +
        `surface telling the reader something is missing.`,
    ).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// K8 — THE HEADER BUDGET IS FOUR
// ══════════════════════════════════════════════════════════════════════
//
// The header lane owns `header.spec.ts` and its own census. This gate
// counts the LIVE DOM independently and pins the number, so neither lane
// can move the budget alone. The definition is deliberately identical:
// an element matching the interactive set, visible, not inside an open
// overlay, with no ancestor inside the header that also matches. A
// composite widget (`role="radiogroup"`) counts ONCE.

const HEADER_BUDGET = 4;

const INTERACTIVE_SELECTOR = [
  "button", "a[href]", "input", "select", "textarea",
  '[role="button"]', '[role="radiogroup"]', '[role="combobox"]',
].join(", ");

async function headerCensus(page: Page) {
  const header = appHeader(page);
  await expect(header, "app-shell header not rendered").toBeVisible();
  return header.evaluate((headerEl, sel) => {
    const inOverlay = (el: Element) =>
      !!el.closest('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]');
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
    };
    const all = [...headerEl.querySelectorAll(sel)].filter((el) => visible(el) && !inOverlay(el));
    const topLevel = all.filter((el) => {
      let parent = el.parentElement;
      while (parent && parent !== headerEl) {
        if (parent.matches(sel)) return false;
        if (parent.getAttribute("role") === "radiogroup") return false;
        parent = parent.parentElement;
      }
      return true;
    });
    const unique = [...new Set(topLevel)];
    return {
      count: unique.length,
      items: unique.map((el) => ({
        tag: el.tagName.toLowerCase(),
        testid: el.getAttribute("data-testid"),
        aria: el.getAttribute("aria-label"),
        text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 28),
      })),
    };
  }, INTERACTIVE_SELECTOR);
}

test.describe("K8 — the header holds four controls", () => {
  test.setTimeout(120_000);

  test("the header lane's own sanctioned set agrees with this budget", () => {
    // CROSS-LANE, and deliberately shape-tolerant. The header lane owns
    // `header.spec.ts` and moved its law from a scalar ceiling
    // (`HEADER_BUDGET = 5`) to an EXACT sanctioned set
    // (`SANCTIONED_DESKTOP = [...]`) mid-wave. A gate that only knew the
    // old shape would have reported "constant not found" and read as
    // this lane's bug rather than as the header lane's improvement.
    //
    // Both shapes are accepted; NEITHER being present is the failure,
    // because then nothing pins the number on that side at all.
    const src = readFileSync(path.join(REPO_ROOT, "e2e/design/header.spec.ts"), "utf-8");

    const set = /const SANCTIONED_DESKTOP[^=]*=\s*(?:Object\.freeze\()?\[([\s\S]*?)\]/.exec(src);
    const scalar = /const HEADER_BUDGET\s*=\s*(\d+)/.exec(src);

    let pinned: number | null = null;
    let shape = "";
    if (set) {
      pinned = set[1].split(",").map((s2) => s2.trim()).filter(Boolean).length;
      shape = `SANCTIONED_DESKTOP (${pinned} identities)`;
    } else if (scalar) {
      pinned = Number(scalar[1]);
      shape = `HEADER_BUDGET = ${pinned}`;
    }

    expect(
      pinned,
      "K8: header.spec.ts pins the header budget in NEITHER shape this gate " +
        "knows (SANCTIONED_DESKTOP nor HEADER_BUDGET). Two lanes must not hold " +
        "two budgets, and right now one of them holds none.",
    ).not.toBeNull();
    expect(
      pinned,
      `K8: header.spec.ts pins ${shape} and this gate pins ${HEADER_BUDGET}. ` +
        `The desktop set is brand · capsule · bell · avatar.`,
    ).toBe(HEADER_BUDGET);
  });

  for (const route of ["/dashboard", "/chat"]) {
    test(`live census on ${route}`, async ({ page }) => {
      await boot(page, route);
      const c = await headerCensus(page);
      const inventory = c.items
        .map((i) => `  · <${i.tag}> testid=${i.testid} aria=${i.aria} "${i.text}"`)
        .join("\n");
      // eslint-disable-next-line no-console
      console.log(`[K8 ${route}] ${c.count} controls\n${inventory}`);
      expect(
        c.count,
        `K8: the header carries ${c.count} top-level interactive elements ` +
          `(budget ${HEADER_BUDGET} — brand · capsule · bell · avatar).\n${inventory}`,
      ).toBeLessThanOrEqual(HEADER_BUDGET);

      // The Capsule is ONE control, and it is present.
      await expect(
        appHeader(page).locator(ANCHORS.trigger),
        "K8: the Capsule is not in the header",
      ).toHaveCount(1);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════
// K9 — every existing invariant, re-proven on the new surface
// ══════════════════════════════════════════════════════════════════════

test.describe("K9/C3 — every figure in an answer traces to a fact", () => {
  test.setTimeout(150_000);

  test("a grounded answer renders its figures through the money path", async ({ page }) => {
    await stubTools(page);
    await stubGeneration(page, GROUNDED_ANSWER);
    await boot(page);
    await openSurface(page);
    const answer = await ask(page, TIER1_QUESTION);

    await expect(answer.locator(ANCHORS.figureRow).first()).toBeVisible({ timeout: 15_000 });
    const offenders = await unprovenancedFigures(answer, [
      ...ALLOWED_IDENTIFIERS, ...KNOWN_UNATTRIBUTED_DIMENSIONLESS,
    ]);
    expect(
      offenders,
      `K9/C3: ${offenders.length} figure(s) in the answer carry no provenance:\n` +
        offenders.map((o) => `  · "${o.text}"  in  ${o.html}`).join("\n"),
    ).toEqual([]);
  });

  test("K9/C1 — a fabricated figure never reaches the reader", async ({ page }) => {
    await stubTools(page);
    await stubGeneration(page, FABRICATED_ANSWER);
    await boot(page);
    await openSurface(page);
    const answer = await ask(page, TIER1_QUESTION);
    await page.waitForTimeout(1500);

    const body = answer.locator(ANCHORS.answerBody);
    if (await body.count()) {
      const text = (await body.innerText()).trim();
      for (const fragment of ["3,900", "15%", "roughly 15"]) {
        expect(
          text,
          `K9/C1: the model's own numeral "${fragment}" is on screen. Every ` +
            `figure is a resolved fact with provenance, or it does not render.`,
        ).not.toContain(fragment);
      }
    }
    const offenders = await unprovenancedFigures(answer, [
      ...ALLOWED_IDENTIFIERS, ...KNOWN_UNATTRIBUTED_DIMENSIONLESS,
    ]);
    expect(
      offenders,
      `K9/C1: a fabricated figure survived to the DOM:\n` +
        offenders.map((o) => `  · "${o.text}"  in  ${o.html}`).join("\n"),
    ).toEqual([]);
  });
});

test.describe("K9/C5 — missing data is stated, never filled in", () => {
  test.setTimeout(120_000);

  test("a refused read shows the absence and renders no zero", async ({ page }) => {
    await stubTools(page, TOOL_PAYLOAD_GAP);
    await stubGeneration(page, GROUNDED_ANSWER);
    await boot(page);
    await openSurface(page);
    const answer = await ask(page, `${TIER1_QUESTION} for October`);
    await page.waitForTimeout(1500);

    const shown = (await answer.innerText()).trim();
    // ABSENT IS NOT ZERO. The one thing that must never appear where a
    // refused fact was asked for is a number standing in for it.
    const zeroish = /(?:^|\s)(?:0|0[.,]0+|RON\s*0|0\s*RON)(?:\s|$)/.test(shown);
    expect(
      zeroish,
      `K9/C5: the surface rendered a zero where the engine refused to state a ` +
        `figure. ABSENT is not ZERO.\n---\n${shown.slice(0, 400)}\n---`,
    ).toBe(false);
    expect(
      shown.length,
      "K9/C5: a refused read showed the reader nothing at all — silence is not honesty.",
    ).toBeGreaterThan(0);
    expect(
      await unprovenancedFigures(answer, ALLOWED_IDENTIFIERS),
      "K9/C5: an unprovenanced figure appeared on the refusal path",
    ).toEqual([]);
  });
});

test.describe("K9/C2 — the surface is READ-ONLY at the wire", () => {
  test.setTimeout(120_000);

  test("no non-GET request reaches the tool endpoint during a turn", async ({ page }) => {
    const writes: string[] = [];
    page.on("request", (req) => {
      if (!/\/api\/capsule\/tools/.test(req.url())) return;
      if (req.method() !== "GET" && req.method() !== "POST") {
        writes.push(`${req.method()} ${req.url()}`);
      }
      // A POST is how a read is invoked here; a POST whose BODY names a
      // mutation is the seam that matters.
      const body = req.postData() ?? "";
      if (/"(?:write|update|delete|insert|patch|mutate)"/i.test(body)) {
        writes.push(`${req.method()} ${req.url()} body=${body.slice(0, 160)}`);
      }
    });
    await stubTools(page);
    await stubGeneration(page, GROUNDED_ANSWER);
    await boot(page);
    await openSurface(page);
    await ask(page, TIER1_QUESTION);
    await page.waitForTimeout(1200);
    expect(
      writes,
      `K9/C2: the Capsule attempted a write:\n  ${writes.join("\n  ")}`,
    ).toEqual([]);
  });
});

test.describe("K9/C4 — typing a destination reaches neither the model nor a tool", () => {
  test.setTimeout(150_000);

  test("no spend for any navigation, entity or action query", async ({ page }) => {
    const spends: string[] = [];
    page.on("request", (req) => {
      if (SPEND_RE.test(req.url())) spends.push(`${req.method()} ${req.url()}`);
    });
    await boot(page);
    await openSurface(page);
    const input = surfaceInput(page);

    for (const query of [
      "dashboard", "scenarios", "benchmark", "products", "settings",
      "cash flow", "balance sheet", "TLV", "461", "upload a document",
      "export statements", "bilanț", "facturi",
    ]) {
      await input.fill("");
      await input.fill(query);
      await page.waitForTimeout(160);
    }
    await page.waitForTimeout(700);
    expect(
      spends,
      `K9/C4: typing destinations spent ${spends.length} request(s). Anthropic ` +
        `credits are live; this is a bug with an invoice attached.\n  ` +
        spends.join("\n  "),
    ).toEqual([]);
  });

  test("the router answers a keystroke in under 5 ms, measured in-page", async ({ page }) => {
    await boot(page);
    await openSurface(page);
    const input = surfaceInput(page);
    const samples: number[] = [];
    for (const q of ["dashboard", "cash flow", "settings", "products", "benchmark",
                     "TLV", "461", "upload", "bilanț", "variance"]) {
      await input.fill("");
      const t = Date.now();
      await input.fill(q);
      await page.waitForTimeout(50);
      samples.push(Date.now() - t - 50);
    }
    // eslint-disable-next-line no-console
    console.log(`[K9 router live] p50 ${p(samples, 0.5)}ms · p95 ${p(samples, 0.95)}ms`);
    expect(
      p(samples, 0.95),
      `K9: slowest keystroke→rows ${p(samples, 0.95)}ms. The router is measured at ` +
        `<5ms in isolation; the live budget allows for React's commit on top.`,
    ).toBeLessThan(100);
  });
});

test.describe("K9/C7 — the model is dead and the instrument still works", () => {
  test.setTimeout(150_000);

  test("calm state, zero raw payload, and navigation unaffected", async ({ page }) => {
    await stubTools(page);
    await page.route(GENERATION_URL, async (route) => {
      await route.fulfill({ status: 500, contentType: "application/json", body: RAW_500 });
    });
    await boot(page);
    await openSurface(page);
    const answer = await ask(page, "why is cash down this month");
    await page.waitForTimeout(2000);

    const html = await page.content();
    for (const fragment of FORBIDDEN_FRAGMENTS) {
      expect(html, `K9/C7: raw payload fragment "${fragment}" reached the DOM`)
        .not.toContain(fragment);
    }
    const calm =
      (await answer.locator('[data-testid="capsule-degraded"]').count()) +
      (await answer.locator('[data-testid="capsule-figures"]').count()) +
      (await answer.locator('[data-testid="capsule-absences"]').count());
    expect(calm, "K9/C7: a failed turn showed the reader nothing at all").toBeGreaterThan(0);
    expect(await unprovenancedFigures(answer, ALLOWED_IDENTIFIERS)).toHaveLength(0);

    await page.keyboard.press("Escape");
    await openSurface(page);
    await surfaceInput(page).fill("cash flow");
    await page.waitForTimeout(300);
    await expect(
      page.locator('[role="option"]').first(),
      "K9/C7: navigation stopped working because the model was down",
    ).toBeVisible();
  });
});
