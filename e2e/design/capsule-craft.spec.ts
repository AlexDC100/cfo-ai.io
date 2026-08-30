/**
 * THE CAPSULE — CRAFT GATES G1–G7 (live browser half).
 *
 * Part F, lane 2. This lane owns no product code. It owns the proof that
 * the redesigned surface reads as a CONVERSATION and not as a command
 * menu — and, crucially, the proof that every invariant the old surface
 * kept is still kept by the new one.
 *
 *   G1  PROPORTION      resting overlay ≤ 440px at 1440, dead space ≤ 8px,
 *                       typing and answering ≤ 70vh.
 *   G2  COMPOSER ANCHOR the input is the BOTTOM-MOST thing in every
 *                       state, and its y is stable within 2px across
 *                       rest → typing → answering.
 *   G3  NO DUPLICATED   no static hint restates the placeholder, and no
 *       HINTS           row carries a `title` (the native-tooltip bug).
 *   G4  NO CATEGORY     navigation rows carry no right-aligned section
 *       COLUMN          label ("Overview", "Analyze").
 *   G5  CLS 0           on open, on close, on typing growth, on streaming.
 *   G6  CONTRAST        every text token AA on the glass in BOTH themes,
 *                       MEASURED — the token, not the impression.
 *   G7  INVARIANTS      Tier-0 spends nothing at the Enter boundary, C1
 *                       numerals, C3 provenance, C5 missing-data honesty,
 *                       the read-only seams, router < 5 ms, header == 4.
 *
 * ── THE TWO DISEASES THIS FILE IS BUILT NOT TO CARRY ─────────────────
 *
 * 1. THE VACUOUS SELECTOR. A gate whose selector matches nothing is a
 *    false green, and nobody reads a green gate's runtime. So every
 *    selector this file depends on is declared once in ANCHORS and
 *    PROVEN LIVE in the first test. Any negative assertion below is
 *    therefore a real ban: the thing it forbids is a thing this surface
 *    can render.
 *
 * 2. THE VACUOUS ZERO. Three C-gates in this repo passed while watching
 *    an endpoint that was never called; each would have kept passing
 *    with its invariant deleted. Every assertion of the shape "this list
 *    is empty" in this file is therefore paired with a POSITIVE CONTROL
 *    in the same run — the same detector, pointed at a case that MUST
 *    trip it. A zero that is never contrasted with a one is not a
 *    measurement, it is a hope.
 *
 * Every count this file relies on is also asserted against a FLOOR after
 * the loop that produced it — never inside it. A canary inside a
 * discovery loop cannot fire when discovery returns nothing, which is
 * the one case it exists to catch (design_review/FALSE_GREEN_FINDINGS.md).
 *
 * NO MODEL SPEND. Anthropic credits are live and billing. Generation and
 * the tool endpoint are intercepted and fulfilled from fixtures; what is
 * under test is the SURFACE.
 *
 * Needs the authed test-mode stack: vite :5173 + engine :8000
 * PUBLIC_TEST_MODE. Run:
 *   npx playwright test e2e/design/capsule-craft.spec.ts --project=chromium
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { dismissPublicTestBanner, preseedLearningMode } from "../_helpers";

const VIEWPORT = { width: 1440, height: 900 } as const;
test.use({ viewport: VIEWPORT });

test.skip(
  ({ baseURL }) => !/localhost|127\.0\.0\.1/.test(baseURL ?? ""),
  "capsule craft gates need the authed test-mode stack (vite :5173 + engine :8000 PUBLIC_TEST_MODE)",
);

const SETTLE_MS = 8000;
const ACTION_MS = 20_000;

// ══════════════════════════════════════════════════════════════════════
// ANCHORS — every selector this file depends on, declared once
// ══════════════════════════════════════════════════════════════════════

const ANCHORS = {
  /** The header pill that opens the surface. */
  trigger: '[data-testid="header-command-bar"]',
  /** The overlay root. */
  overlay: '[data-testid="command-palette"]',
  /** The header's account trigger — how the app-shell header is found. */
  accountTrigger: '[data-testid="account-menu-trigger"]',
  /** THE COMPOSER, matched by ROLE and by tag rather than by testid: the
   *  composer is whatever the craft lane builds, and "a text field the
   *  reader types into" is the contract, not a data attribute. In the
   *  answering state this resolves to the follow-up field, which is the
   *  correct subject — it is the composer FOR THAT STATE. */
  composer:
    '[data-testid="command-palette"] textarea, ' +
    '[data-testid="command-palette"] input[type="text"], ' +
    '[data-testid="command-palette"] [role="combobox"], ' +
    '[data-testid="command-palette"] [contenteditable="true"]',
  /** The answer surface. */
  answer: '[data-testid="capsule-answer"]',
  /** One finished turn. */
  turn: '[data-testid="capsule-turn"]',
} as const;

/** Anchors that MUST resolve with the surface CLOSED. */
const ANCHORS_CLOSED: ReadonlyArray<keyof typeof ANCHORS> = ["trigger", "accountTrigger"];
/** Anchors that MUST resolve with the surface OPEN and nothing typed. */
const ANCHORS_OPEN: ReadonlyArray<keyof typeof ANCHORS> = ["overlay", "composer"];
/** Anchors that MUST resolve once an answer has been asked for. */
const ANCHORS_ANSWERED: ReadonlyArray<keyof typeof ANCHORS> = ["answer", "turn"];

// ══════════════════════════════════════════════════════════════════════
// BUDGETS — every number this file gates on, in one place
// ══════════════════════════════════════════════════════════════════════

const BUDGET = {
  /** G1. The resting overlay at 1440×900. */
  restHeightPx: 440,
  /** G1. overlay.bottom − deepest painted descendant.bottom. */
  deadSpacePx: 8,
  /** G1. Typing and answering, as a fraction of the viewport. */
  tallStateVh: 0.7,
  /** G2. Drift of the composer's bottom edge across the three states. */
  composerDriftPx: 2,
  /** G2. How far below the composer any other painted thing may reach.
   *  Sized to permit the composer block's own padding and NOT a line of
   *  text: an 11px line set on 14px leading, offset 4px, lands 18px
   *  below — outside this. */
  belowComposerPx: 16,
  /** G3. Content-word overlap with the placeholder that counts as a
   *  restatement. 0.6 = "most of what it says, the placeholder said". */
  restatementOverlap: 0.6,
  /** G5. Cumulative layout shift, per interaction. */
  cls: 0,
  /** G7. Live keystroke → rows, p95. The router is < 5 ms in isolation;
   *  this budget carries React's commit on top of it. */
  routerP95Ms: 50,
  /** G7. Header controls at 1440. */
  headerControls: 4,
} as const;

/**
 * VACUITY FLOORS. Each is asserted AFTER the loop that produced the
 * count, against the total — never inside the loop, where a discovery
 * that returned nothing would skip the check entirely.
 *
 * A floor is a COLLAPSE DETECTOR, not a target: set from a measured run
 * and then rounded DOWN, so it catches "the selector stopped matching"
 * without failing because the design legitimately got leaner. Every
 * number here is a measurement, and every measurement is recorded with
 * its date in design_review/capsule-craft/GATES.md — raising a floor to
 * make a red go green would be the exact fraud these gates exist to
 * prevent, and lowering one without recording the measurement is the
 * same fraud running the other way.
 */
const FLOOR = {
  /** G3 — static hint texts examined for restatement. Measured 3-4. */
  hintTexts: 2,
  /** G4 — navigation rows summoned across the query sweep. Measured 9
   *  (2026-08-30, after the jump list moved behind a keystroke). */
  navRows: 5,
  /** G6 — text nodes measured for contrast, per theme, at rest.
   *  Measured 21 before the redesign, 9-10 after it thinned the resting
   *  surface to a strip + one suggestion + the composer. */
  contrastNodes: 6,
  /** G7 — keystroke samples behind the router p95. */
  routerSamples: 8,
} as const;

// ══════════════════════════════════════════════════════════════════════
// NETWORK — the seams, and the fixtures that stand in for them
// ══════════════════════════════════════════════════════════════════════

const GENERATION_URL = "**/functions/v1/chat-llm";
const TOOLS_URL = "**/api/capsule/tools/**";

/** The two seams that cost money. Named, because a gate that says
 *  "something spent" and cannot say WHAT is a gate nobody can act on. */
const MODEL_SEAMS: readonly { label: string; match: RegExp }[] = Object.freeze([
  { label: "/api/capsule/tools/get_facts (engine tool endpoint)", match: /\/api\/capsule\/tools\// },
  { label: "functions/v1/chat-llm (Edge Function)", match: /functions\/v1\/chat-llm/ },
]);
const isSpend = (url: string) => MODEL_SEAMS.some((s) => s.match.test(url));

/** A ct1 payload — the shape `_capsule_tools.to_payload()` emits. */
const TOOL_PAYLOAD = {
  version: "ct1", tool: "get_facts", read_only: true, ok: true,
  values: [
    {
      kind: "money", fact: "total_assets", metric: "total_assets", unit: "money",
      amount_minor: 390000, value: 3900, currency: "RON", scope: "December 2024",
      label_key: "capsule.metric.total_assets",
      provenance: {
        period_id: "p-dec", period_label: "December 2024", entity_id: "org-1",
        source: "assembled_canonical_v1", tier: "canonical_bs", snapshot_id: "sha256-p-dec",
      },
    },
    {
      kind: "ratio", fact: "current_ratio", metric: "current_ratio", unit: "ratio",
      value: 2.8, numerator_minor: 140000, denominator_minor: 50000,
      operand_currency: "RON", scope: "December 2024",
      label_key: "capsule.metric.current_ratio",
      provenance: {
        period_id: "p-dec", period_label: "December 2024", entity_id: "org-1",
        source: "assembled_canonical_v1", tier: "canonical_bs", snapshot_id: "sha256-p-dec",
      },
    },
  ],
  rows: [], gaps: [], limitations: [], notes: [],
};

/** THE SAME TOOL, REFUSING. C5's subject: state the absence, state no
 *  number. */
const TOOL_PAYLOAD_GAP = {
  version: "ct1", tool: "get_facts", read_only: true, ok: false,
  values: [], rows: [],
  gaps: [
    {
      code: "no_source_file", tool: "get_facts",
      detail_key: "capsule.gap.no_source_file",
      detail: "October 2024 has no attached file.", scope: "October 2024",
    },
  ],
  limitations: [], notes: [],
};

/** Grounded prose: every figure arrives as a token the renderer resolves
 *  WITH provenance. */
const GROUNDED_ANSWER =
  "Total assets stand at {{money:total_assets}} for December 2024, with a " +
  "current ratio of {{fact:current_ratio|d2}}.";

/** The same claim as the model would type it if nothing stopped it. The
 *  hardcoded money string IS the defect under test. */
const FABRICATED_ANSWER =
  // eslint-disable-next-line no-restricted-syntax
  "Total assets stand at RON 3,900 for December 2024, with a current ratio " +
  "of 2.8 — roughly 15% better than last month.";
const FABRICATED_FRAGMENTS = ["RON 3,900", "3,900", "15%"];

/** A question Tier 0 holds locally — the ZERO-SPEND subject. */
const TIER0_QUESTION = "total assets";
/** A question Tier 0 must refuse — the POSITIVE CONTROL, and the subject
 *  of every model-path gate. Without this in the same file, "no spend"
 *  would be indistinguishable from "no surface". */
const TIER1_QUESTION = "why are total assets at this level";

/** Identifiers a figure gate may see without calling them figures: a
 *  period label, an account code, a year. */
const ALLOWED_IDENTIFIERS = [
  "December 2024", "November 2024", "October 2024", "461", "5121", "2024", "2025", "2026",
];

// ── KNOWN GAP, quarantined by name (a ratchet, not an exemption) ──────
//
// `NarrativeText` attributes MONEY parts but renders a resolved
// DIMENSIONLESS fact — a ratio, a percent, a day count — as a bare
// span. In the DOM that figure is indistinguishable from one a model
// typed, which is exactly what C1/C3 exist to distinguish.
// `narrativeMoney.tsx` is import-only for every lane in this session, so
// the gate stays strict and licenses only the exact string the fixture's
// ratio resolves to. When the dimensionless branch gains
// `data-narrative-fact`, delete this constant: the gate gets stricter
// for free.
const KNOWN_UNATTRIBUTED_DIMENSIONLESS = ["2.80"];

// ══════════════════════════════════════════════════════════════════════
// HARNESS
// ══════════════════════════════════════════════════════════════════════

function appHeader(page: Page): Locator {
  return page.locator("header").filter({ has: page.locator(ANCHORS.accountTrigger) }).first();
}

async function boot(page: Page, route = "/dashboard"): Promise<void> {
  await preseedLearningMode(page);
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS);
  await dismissPublicTestBanner(page);
}

async function openSurface(page: Page): Promise<Locator> {
  // The trigger is waited for BEFORE it is clicked. With five lanes
  // editing this tree, a Vite rebuild between navigation and click made
  // the first test of a run fail on the harness's patience rather than
  // on the product — which is the one failure mode a gate may never
  // have, because it teaches the reader to ignore a red.
  const trigger = appHeader(page).locator(ANCHORS.trigger);
  await expect(trigger, "the Capsule trigger never mounted").toBeVisible({ timeout: ACTION_MS });
  await trigger.click({ timeout: ACTION_MS });
  const overlay = page.locator(ANCHORS.overlay);
  await expect(overlay).toBeVisible({ timeout: ACTION_MS });
  // Radix portals + the open animation. Geometry read before this
  // settles measures the animation, not the design.
  await page.waitForTimeout(600);
  await composer(page).waitFor({ state: "visible", timeout: ACTION_MS });
  return overlay;
}

function composer(page: Page): Locator {
  return page.locator(ANCHORS.composer).locator("visible=true").first();
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

/** Type and commit. ASK-FIRST: no Tab first, ever. If the surface
 *  regresses to needing one, every gate that asks a question fails —
 *  which is the correct blast radius. */
async function ask(page: Page, question: string): Promise<Locator> {
  const input = composer(page);
  await input.click({ timeout: ACTION_MS });
  await input.fill(question, { timeout: ACTION_MS });
  await page.waitForTimeout(250);
  await input.press("Enter", { timeout: ACTION_MS });
  const answer = page.locator(ANCHORS.answer);
  await expect(answer).toBeVisible({ timeout: ACTION_MS });
  return answer;
}

// ── geometry ──────────────────────────────────────────────────────────

interface Geometry {
  overlay: { top: number; bottom: number; height: number; width: number };
  /** Deepest painted descendant's bottom, in viewport px. */
  contentBottom: number;
  /** overlay.bottom − contentBottom. */
  deadSpace: number;
  composer: { top: number; bottom: number } | null;
  /** Painted, text-bearing or interactive things that reach BELOW the
   *  composer, with how far. */
  below: { tag: string; testid: string | null; text: string; overhang: number }[];
  /** Focusables that come AFTER the composer in DOM order and live
   *  OUTSIDE the composer's own block. A send button beside the input is
   *  part of the composer; a row after it is not. */
  focusablesAfterComposer: string[];
  focusables: string[];
}

async function geometry(page: Page): Promise<Geometry> {
  return page.locator(ANCHORS.overlay).evaluate((root: Element, composerSel: string) => {
    const painted = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
    };
    const rr = root.getBoundingClientRect();

    let contentBottom = rr.top;
    root.querySelectorAll("*").forEach((el) => {
      if (!painted(el)) return;
      contentBottom = Math.max(contentBottom, el.getBoundingClientRect().bottom);
    });

    const stripped = composerSel
      .split(",")
      .map((s) => s.trim().replace('[data-testid="command-palette"] ', ""))
      .join(", ");
    const comps = [...root.querySelectorAll(stripped)].filter(painted);
    const comp = comps[comps.length - 1] ?? null;
    const cb = comp ? comp.getBoundingClientRect() : null;

    const below: Geometry["below"] = [];
    if (comp && cb) {
      root.querySelectorAll("*").forEach((el) => {
        if (!painted(el)) return;
        if (el === comp || el.contains(comp) || comp.contains(el)) return;
        const r = el.getBoundingClientRect();
        // Only things that CARRY something: own text, or interactive.
        let own = "";
        el.childNodes.forEach((n) => { if (n.nodeType === 3) own += n.textContent; });
        own = own.trim();
        const interactive = el.matches(
          'button, a[href], [role="button"], [role="option"], input, select, textarea',
        );
        if (!own && !interactive) return;
        // sr-only and hairlines carry nothing a reader sees.
        if (r.height < 2) return;
        const overhang = Math.round(r.bottom - cb.bottom);
        if (overhang > 0) {
          below.push({
            tag: el.tagName, testid: el.getAttribute("data-testid"),
            text: (own || el.getAttribute("aria-label") || "").slice(0, 48), overhang,
          });
        }
      });
    }

    const focusSel =
      'button, a[href], input, select, textarea, [role="option"], [tabindex]:not([tabindex="-1"])';
    const focusables = [...root.querySelectorAll(focusSel)].filter(painted);
    const label = (el: Element) =>
      el.getAttribute("data-testid") || el.getAttribute("aria-label") ||
      (el.textContent || "").trim().slice(0, 28) || el.tagName;

    // THE COMPOSER BLOCK — the composer's nearest ancestor that is a
    // direct child of the overlay. A send or attach button that ships
    // WITH the input is part of the composer and may follow it in tab
    // order; a suggestion row that follows it is the surface still
    // being a menu.
    let block: Element | null = comp;
    while (block && block.parentElement && block.parentElement !== root) {
      block = block.parentElement;
    }
    const ci = comp ? focusables.indexOf(comp) : -1;
    const focusablesAfterComposer =
      ci < 0 ? [] :
        focusables.slice(ci + 1).filter((el) => !block || !block.contains(el)).map(label);

    return {
      overlay: {
        top: Math.round(rr.top), bottom: Math.round(rr.bottom),
        height: Math.round(rr.height), width: Math.round(rr.width),
      },
      contentBottom: Math.round(contentBottom),
      deadSpace: Math.round(rr.bottom - contentBottom),
      composer: cb ? { top: Math.round(cb.top), bottom: Math.round(cb.bottom) } : null,
      below: below.sort((a, b) => b.overhang - a.overhang),
      focusablesAfterComposer,
      focusables: focusables.map(label),
    };
  }, ANCHORS.composer);
}

// ── contrast ──────────────────────────────────────────────────────────

interface TextNode {
  txt: string; px: number; large: boolean; ratio: number; req: number;
  color: string; cls: string; decorative: boolean;
}

/**
 * WCAG 1.4.3, measured on the COMPOSITED colour — every ancestor's
 * background-color alpha-composited down to the document background,
 * then the text's own alpha composited onto that. Measuring
 * `getComputedStyle().color` against a guessed backdrop is how a token
 * at 3.53:1 passes on a glass panel: the impression is fine, the token
 * is not.
 *
 * DECORATIVE, and the rule is stated rather than assumed: a node whose
 * entire text is separator punctuation AND which is `aria-hidden` is
 * pure decoration under 1.4.3 and is reported advisory. A separator that
 * is NOT aria-hidden is gating — declaring it decorative in the
 * accessibility tree is the price of the exemption.
 */
async function measureContrast(page: Page, sel: string): Promise<TextNode[]> {
  return page.locator(sel).evaluate((root: Element) => {
    const srgb = (c: number) => {
      const x = c / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    const lum = (p: number[]) => 0.2126 * srgb(p[0]) + 0.7152 * srgb(p[1]) + 0.0722 * srgb(p[2]);
    const parse = (s: string) => {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
    };
    const over = (fg: number[], bg: number[], a: number) => fg.map((c, i) => c * a + bg[i] * (1 - a));
    const bgOf = (el: Element) => {
      const stack: { rgb: number[]; a: number }[] = [];
      let n: Element | null = el;
      while (n && n !== document.documentElement) {
        const p = parse(getComputedStyle(n).backgroundColor);
        if (p && p.a > 0) stack.push(p);
        n = n.parentElement;
      }
      const rootP = parse(getComputedStyle(document.documentElement).backgroundColor);
      let base = rootP && rootP.a > 0 ? rootP.rgb : [255, 255, 255];
      for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i].rgb, base, stack[i].a);
      return base;
    };
    const SEPARATOR_ONLY = /^[·•|/\\\-–—:,]+$/;

    const out: TextNode[] = [];
    root.querySelectorAll("*").forEach((el) => {
      let txt = "";
      el.childNodes.forEach((c) => { if (c.nodeType === 3) txt += c.textContent; });
      txt = txt.trim();
      if (!txt) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 2) return;   // sr-only carries no visible token
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return;
      const fgP = parse(cs.color);
      if (!fgP) return;
      const bg = bgOf(el);
      const fg = over(fgP.rgb, bg, fgP.a);
      const L1 = lum(fg), L2 = lum(bg);
      const ratio = Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100;
      const px = parseFloat(cs.fontSize);
      const bold = parseInt(cs.fontWeight, 10) >= 700;
      const large = px >= 24 || (px >= 18.66 && bold);
      const hidden = el.closest("[aria-hidden='true']") !== null;
      out.push({
        txt: txt.slice(0, 44), px, large, ratio, req: large ? 3 : 4.5,
        color: cs.color, cls: String((el as HTMLElement).className || "").replace(/\s+/g, " ").slice(0, 64),
        decorative: SEPARATOR_ONLY.test(txt) && hidden,
      });
    });
    return out;
  }) as Promise<TextNode[]>;
}

// ── CLS ───────────────────────────────────────────────────────────────

async function armCls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__craftCls = 0;
    w.__craftShifts = [];
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as {
        value: number; hadRecentInput: boolean; sources?: { node?: Element }[];
      }[]) {
        if (e.hadRecentInput) continue;
        w.__craftCls = (w.__craftCls as number) + e.value;
        (w.__craftShifts as unknown[]).push({
          v: Math.round(e.value * 10000) / 10000,
          nodes: (e.sources ?? []).map(
            (s) => s.node?.getAttribute?.("data-testid") ?? s.node?.tagName ?? "?",
          ),
        });
      }
    });
    po.observe({ type: "layout-shift", buffered: true });
    w.__craftPo = po;
  });
}
async function resetCls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__craftCls = 0;
    w.__craftShifts = [];
  });
}
async function readCls(page: Page): Promise<{ cls: number; shifts: unknown[] }> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return { cls: w.__craftCls as number, shifts: w.__craftShifts as unknown[] };
  });
}

// ── the figure law, mirrored (an in-page evaluator cannot import) ─────

const PROVENANCE_ATTRS = [
  "data-narrative-money", "data-traceable-source-statement", "data-provenance", "data-fact",
];
const PROVENANCE_CONTAINERS = [
  '[data-testid="capsule-figure-row"]', '[data-testid="capsule-citation"]',
  '[data-testid="capsule-fact-card"]', '[data-testid="capsule-trace"]',
  '[data-testid="capsule-comparison"]', '[data-testid="capsule-sparkline"]',
];

async function unprovenancedFigures(
  scope: Locator, allowed: string[],
): Promise<{ text: string; html: string }[]> {
  return scope.evaluate(
    (root, { attrs, containers, allowedTokens }) => {
      const SEPARATORS = ".,   ";
      const DIGIT_RUN = /\d[\d.,   ]*\d|\d/g;
      const GROUPED = /\d[.,   ]\d/;
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
        if (GROUPED.test(stripped) || CURRENCY.test(stripped)) return [stripped.trim()];
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
      const offenders: { text: string; html: string }[] = [];
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

// ── restatement (G3) ──────────────────────────────────────────────────

const STOPWORDS = new Set([
  // EN
  "a", "an", "the", "or", "and", "to", "of", "in", "on", "at", "for", "is", "it",
  "your", "you", "this", "that", "with", "by", "as", "be", "can", "will",
  // RO
  "sau", "si", "și", "la", "de", "din", "un", "o", "cu", "ca", "să", "sa", "te",
  "îți", "iti", "ți", "ti", "pe", "e", "ce",
]);

/** Content words, lightly stemmed to 5 characters so `întreabă` and
 *  `întrebi` count as the same word. Latin-1 folded so diacritics do not
 *  make two spellings of one word look like two words. */
function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => w.slice(0, 5));
}

/** Fraction of the CANDIDATE's content words that the placeholder also
 *  says. Asymmetric on purpose: a short hint that is entirely contained
 *  in a longer placeholder is a restatement; a long hint that merely
 *  shares a word is not. */
function overlapWithPlaceholder(candidate: string, placeholder: string): number {
  const c = contentWords(candidate);
  if (c.length === 0) return 0;
  const p = new Set(contentWords(placeholder));
  return c.filter((w) => p.has(w)).length / c.length;
}

// ══════════════════════════════════════════════════════════════════════
// ANCHOR LIVENESS — this file may not carry the disease it treats
// ══════════════════════════════════════════════════════════════════════

test.describe("G0 — every anchor this file depends on resolves live", () => {
  test.setTimeout(120_000);

  test("closed, open and answered anchors all match a real element", async ({ page }) => {
    await stubTools(page);
    await stubGeneration(page, GROUNDED_ANSWER);
    await boot(page);

    for (const key of ANCHORS_CLOSED) {
      await expect(
        page.locator(ANCHORS[key]).first(),
        `G0: anchor "${key}" (${ANCHORS[key]}) matched nothing with the surface ` +
          `closed. Every negative assertion in this file is only a ban if the ` +
          `thing it forbids is renderable — an anchor that matches nothing turns ` +
          `all of them into decoration.`,
      ).toBeVisible({ timeout: ACTION_MS });
    }

    await openSurface(page);
    for (const key of ANCHORS_OPEN) {
      await expect(
        page.locator(ANCHORS[key]).first(),
        `G0: anchor "${key}" (${ANCHORS[key]}) matched nothing with the surface open.`,
      ).toBeVisible({ timeout: ACTION_MS });
    }

    await ask(page, TIER1_QUESTION);
    for (const key of ANCHORS_ANSWERED) {
      await expect(
        page.locator(ANCHORS[key]).first(),
        `G0: anchor "${key}" (${ANCHORS[key]}) matched nothing after an answer.`,
      ).toBeVisible({ timeout: ACTION_MS });
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// G1 — PROPORTION
// ══════════════════════════════════════════════════════════════════════
//
// The resting surface is the one a reader meets before they have said a
// word. 700px of mostly-empty panel is the surface telling them it does
// not know what it is for. The budget is a ceiling on the panel AND a
// ceiling on the gap between the panel and what is painted in it — a
// short panel with 200px of air at the bottom fails the second even
// though it passes the first.

test.describe("G1 — proportion: the panel is the size of what is in it", () => {
  test.setTimeout(150_000);

  test("resting panel fits the budget and holds no dead space", async ({ page }) => {
    await boot(page);
    await openSurface(page);
    const g = await geometry(page);

    console.log(`[G1 rest] height=${g.overlay.height}px content=${g.contentBottom} ` +
      `dead=${g.deadSpace}px width=${g.overlay.width}`);

    expect(
      g.overlay.height,
      `G1: the resting overlay is ${g.overlay.height}px at ${VIEWPORT.width}×` +
        `${VIEWPORT.height}. The budget is ${BUDGET.restHeightPx}px. A panel that ` +
        `opens taller than the thing it has to say is a menu with the lights on.`,
    ).toBeLessThanOrEqual(BUDGET.restHeightPx);

    expect(
      g.deadSpace,
      `G1: ${g.deadSpace}px of the resting panel is painted with nothing. The ` +
        `panel's height must be the sum of what is actually true — the gap ` +
        `between the last painted pixel (${g.contentBottom}) and the panel's own ` +
        `bottom (${g.overlay.bottom}) is dead space.`,
    ).toBeLessThanOrEqual(BUDGET.deadSpacePx);
  });

  test("typing and answering stay inside 70vh with no dead space", async ({ page }) => {
    await stubTools(page);
    await stubGeneration(page, GROUNDED_ANSWER);
    await boot(page);
    await openSurface(page);

    const ceiling = Math.round(VIEWPORT.height * BUDGET.tallStateVh);

    const input = composer(page);
    await input.click();
    await input.fill(TIER0_QUESTION);
    await page.waitForTimeout(450);
    const typing = await geometry(page);
    console.log(`[G1 typing] height=${typing.overlay.height}px dead=${typing.deadSpace}px`);

    await ask(page, TIER1_QUESTION);
    await page.waitForTimeout(1400);
    const answering = await geometry(page);
    console.log(`[G1 answering] height=${answering.overlay.height}px dead=${answering.deadSpace}px`);

    for (const [label, g] of [["typing", typing], ["answering", answering]] as const) {
      expect(
        g.overlay.height,
        `G1: the ${label} panel is ${g.overlay.height}px — over the ${ceiling}px ` +
          `(70vh) ceiling. Past that the panel stops being an overlay and becomes ` +
          `the page.`,
      ).toBeLessThanOrEqual(ceiling);
      expect(
        g.deadSpace,
        `G1: ${g.deadSpace}px of dead space in the ${label} state.`,
      ).toBeLessThanOrEqual(BUDGET.deadSpacePx);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// G2 — COMPOSER ANCHOR
// ══════════════════════════════════════════════════════════════════════
//
// This is the single measurement that separates "a conversation" from "a
// command menu". In a conversation the thing you type into is at the
// bottom, it stays where your hands are, and what you said scrolls above
// it. In a menu the query box is at the top and the results push down
// away from it.
//
// Two complementary measures, because either alone is gameable:
//   · GEOMETRIC — nothing painted reaches below the composer;
//   · ORDINAL   — the composer is the last focusable thing in the panel.
// A footer hint under the input trips the first; a row under the input
// trips both.

test.describe("G2 — the composer is the bottom of the surface, and it stays put", () => {
  test.setTimeout(180_000);

  test("nothing is painted below the composer, in any state", async ({ page }) => {
    await stubTools(page);
    await stubGeneration(page, GROUNDED_ANSWER);
    await boot(page);
    await openSurface(page);

    const states: { label: string; g: Geometry }[] = [];
    states.push({ label: "rest", g: await geometry(page) });

    const input = composer(page);
    await input.click();
    await input.fill(TIER0_QUESTION);
    await page.waitForTimeout(450);
    states.push({ label: "typing", g: await geometry(page) });

    await ask(page, TIER1_QUESTION);
    await page.waitForTimeout(1400);
    states.push({ label: "answering", g: await geometry(page) });

    // FLOOR, after the loop that produced the states — not inside it.
    expect(
      states.length,
      "G2 VACUITY: no states were measured. The gate would have passed by " +
        "examining nothing.",
    ).toBe(3);

    for (const { label, g } of states) {
      expect(g.composer, `G2: no composer found in the ${label} state`).not.toBeNull();
      const offenders = g.below.filter((b) => b.overhang > BUDGET.belowComposerPx);
      console.log(`[G2 ${label}] composerBottom=${g.composer?.bottom} ` +
        `below=${offenders.length} after=${JSON.stringify(g.focusablesAfterComposer)}`);
      expect(
        offenders,
        `G2: in the ${label} state ${offenders.length} painted element(s) sit ` +
          `below the composer:\n` +
          offenders.map((o) => `  +${o.overhang}px  ${o.tag}${o.testid ? `[${o.testid}]` : ""} "${o.text}"`).join("\n") +
          `\nThe composer must be the bottom of the surface. Anything under it ` +
          `is the surface asking the reader to look away from where they type.`,
      ).toEqual([]);
      expect(
        g.focusablesAfterComposer,
        `G2: in the ${label} state ${g.focusablesAfterComposer.length} focusable ` +
          `element(s) follow the composer from OUTSIDE its own block: ` +
          `${g.focusablesAfterComposer.join(", ")}.\n` +
          `Tab order is: ${g.focusables.join(" → ")}.\n` +
          `Controls that ship with the input (send, attach) may follow it — they ` +
          `are the composer. Anything else after it means the reader tabs PAST ` +
          `where they speak into something else, which is the shape of a form.`,
      ).toEqual([]);
    }
  });

  test("the composer's y is stable within 2px across rest → typing → answering",
    async ({ page }) => {
      await stubTools(page);
      await stubGeneration(page, GROUNDED_ANSWER);
      await boot(page);
      await openSurface(page);

      const ys: { label: string; y: number }[] = [];
      const read = async (label: string) => {
        const g = await geometry(page);
        expect(g.composer, `G2: no composer in the ${label} state`).not.toBeNull();
        ys.push({ label, y: g.composer!.bottom });
      };

      await read("rest");
      const input = composer(page);
      await input.click();
      await input.fill(TIER0_QUESTION);
      await page.waitForTimeout(450);
      await read("typing");
      await ask(page, TIER1_QUESTION);
      await page.waitForTimeout(1400);
      await read("answering");

      // FLOOR after the loop: three readings, or the drift below is a
      // comparison of one number with itself.
      expect(
        ys.length,
        "G2 VACUITY: fewer than three composer positions were read; a drift " +
          "computed over one reading is always zero.",
      ).toBe(3);

      const min = Math.min(...ys.map((v) => v.y));
      const max = Math.max(...ys.map((v) => v.y));
      const drift = max - min;
      console.log(`[G2 drift] ${ys.map((v) => `${v.label}=${v.y}`).join(" ")} → ${drift}px`);

      expect(
        drift,
        `G2: the composer moves ${drift}px between states ` +
          `(${ys.map((v) => `${v.label}=${v.y}`).join(", ")}). The budget is ` +
          `${BUDGET.composerDriftPx}px. A composer that jumps when the answer ` +
          `arrives is a form redrawing itself, not a conversation continuing. ` +
          `The panel has to grow UPWARD from a fixed bottom edge.`,
      ).toBeLessThanOrEqual(BUDGET.composerDriftPx);
    });
});

// ══════════════════════════════════════════════════════════════════════
// G3 — NO DUPLICATED HINTS
// ══════════════════════════════════════════════════════════════════════

test.describe("G3 — the surface says each thing once", () => {
  test.setTimeout(150_000);

  test("no static hint restates the placeholder", async ({ page }) => {
    await boot(page);
    const overlay = await openSurface(page);

    const placeholder = await composer(page).getAttribute("placeholder");
    expect(
      placeholder,
      "G3: the composer has no placeholder, so 'the footer restates the " +
        "placeholder' cannot be measured. That is a broken gate, not a pass.",
    ).toBeTruthy();

    const candidates = await overlay.evaluate((root: Element) => {
      const painted = (el: Element) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 2) return false;   // sr-only excluded
        const cs = getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
      };
      // A STATIC HINT is chrome, not content: it carries its own text,
      // it is not a row the reader can act on, and it is not part of an
      // answer. Rows and answers are excluded because they legitimately
      // echo the reader's own words.
      const EXCLUDE = '[role="option"], [data-testid="capsule-answer"], ' +
        '[data-testid="capsule-turn"], [data-testid="capsule-suggestion"], ' +
        '[data-testid="capsule-tier0"]';
      const out: { text: string; testid: string | null; cls: string }[] = [];
      root.querySelectorAll("*").forEach((el) => {
        if (!painted(el)) return;
        if (el.closest(EXCLUDE)) return;
        let own = "";
        el.childNodes.forEach((n) => { if (n.nodeType === 3) own += n.textContent; });
        own = own.trim();
        if (own.length < 8) return;   // "esc" is a key cap, not a sentence
        out.push({
          text: own, testid: el.getAttribute("data-testid"),
          cls: String((el as HTMLElement).className || "").replace(/\s+/g, " ").slice(0, 48),
        });
      });
      return out;
    });

    // FLOOR after the discovery loop. A surface with no chrome text at
    // all would otherwise pass this gate by having nothing to compare.
    expect(
      candidates.length,
      `G3 VACUITY: only ${candidates.length} static hint text(s) were found in ` +
        `the overlay (floor ${FLOOR.hintTexts}). Either the selector stopped ` +
        `matching or the surface stopped speaking; either way this gate ` +
        `measured nothing.`,
    ).toBeGreaterThanOrEqual(FLOOR.hintTexts);

    const scored = candidates
      .map((c) => ({ ...c, overlap: overlapWithPlaceholder(c.text, placeholder!) }))
      .sort((a, b) => b.overlap - a.overlap);
    const restatements = scored.filter((c) => c.overlap >= BUDGET.restatementOverlap);

    console.log(`[G3] placeholder="${placeholder}" · examined ${candidates.length} hints · ` +
      `${restatements.length} restate it`);
    for (const c of scored) {
      console.log(`   ${String(Math.round(c.overlap * 100)).padStart(3)}%  "${c.text}"`);
    }

    expect(
      restatements,
      `G3: ${restatements.length} hint(s) restate the placeholder:\n` +
        restatements.map((r) =>
          `  ${Math.round(r.overlap * 100)}% overlap  "${r.text}"` +
          `${r.testid ? ` [${r.testid}]` : ""}`).join("\n") +
        `\n  placeholder: "${placeholder}"\n` +
        `Saying it twice is the surface not trusting the reader to have read it ` +
        `once. The second copy is the one to delete.`,
    ).toEqual([]);
  });

  test("no row carries a native browser tooltip", async ({ page }) => {
    await stubTools(page);
    await stubGeneration(page, GROUNDED_ANSWER);
    await boot(page);
    const overlay = await openSurface(page);

    // ROWS ONLY. A provenance dot whose `title` says "Open the source
    // row" is a control describing itself, which is what `title` is for;
    // a suggestion whose `title` repeats its own visible label is the
    // native tooltip bug — a second, unstyled, delayed copy of text the
    // reader is already looking at.
    const rowTitles = async () => overlay.evaluate((root: Element) => {
      const ROWS = '[role="option"], [data-testid="capsule-suggestion"], ' +
        '[data-testid="capsule-jump-row"], [data-testid="capsule-ask-fallback"], ' +
        '[data-testid="capsule-followup-chip"], [data-testid="capsule-question-chip"]';
      const rows = [...root.querySelectorAll(ROWS)];
      const offenders: { testid: string | null; title: string; text: string }[] = [];
      for (const row of rows) {
        const nodes = [row, ...row.querySelectorAll("[title]")];
        for (const n of nodes) {
          const title = n.getAttribute("title");
          if (!title) continue;
          offenders.push({
            testid: row.getAttribute("data-testid"),
            title, text: (row.textContent || "").trim().slice(0, 60),
          });
        }
      }
      return { rows: rows.length, offenders };
    });

    const rest = await rowTitles();
    const input = composer(page);
    await input.click();
    await input.fill("dash");
    await page.waitForTimeout(400);
    const typing = await rowTitles();
    await input.fill(TIER1_QUESTION);
    await page.waitForTimeout(200);
    await input.press("Enter");
    await page.locator(ANCHORS.answer).waitFor({ timeout: ACTION_MS });
    await page.waitForTimeout(1400);
    const answered = await rowTitles();

    const totalRows = rest.rows + typing.rows + answered.rows;
    // FLOOR after all three collections. Zero rows examined would make
    // "no row carries a title" true and meaningless.
    expect(
      totalRows,
      `G3 VACUITY: ${totalRows} rows examined across three states (floor ` +
        `${FLOOR.navRows}). The row selector matched nothing, so the tooltip ban ` +
        `was never tested.`,
    ).toBeGreaterThanOrEqual(FLOOR.navRows);

    const offenders = [...rest.offenders, ...typing.offenders, ...answered.offenders];
    console.log(`[G3 tooltips] rows examined: rest=${rest.rows} typing=${typing.rows} ` +
      `answered=${answered.rows} · offenders=${offenders.length}`);

    expect(
      offenders,
      `G3: ${offenders.length} row(s) carry a native \`title\` tooltip:\n` +
        offenders.map((o) => `  [${o.testid}] title="${o.title}"\n      row text: "${o.text}"`).join("\n") +
        `\nThe browser renders \`title\` as an unstyled yellow box after a delay ` +
        `the design does not control, duplicating text already on screen. If the ` +
        `row's own label cannot say it, the row needs a better label — not a ` +
        `second one nobody asked for.`,
    ).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// G4 — NO CATEGORY COLUMN
// ══════════════════════════════════════════════════════════════════════
//
// "Dashboard … Overview". "Scenarios … Analyze". The right-hand word is
// the name of the rail group the destination lives in, which is
// information the reader needed while BUILDING the app and never needs
// while USING it. It also makes every row identical in rhythm, which is
// precisely what makes the surface read as a table of contents.

test.describe("G4 — navigation rows carry no category column", () => {
  test.setTimeout(150_000);

  test("no nav row ends in a right-aligned section label", async ({ page }) => {
    await boot(page);
    const overlay = await openSurface(page);

    const scan = async (label: string) => {
      const r = await overlay.evaluate((root: Element) => {
        const ROWS = '[data-testid="capsule-jump-row"], ' +
          '[role="option"]:not([data-testid="capsule-suggestion"])';
        const painted = (el: Element) => {
          const b = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return b.width > 0 && b.height > 0 && cs.visibility !== "hidden";
        };
        const rows = [...root.querySelectorAll(ROWS)].filter(painted);
        const offenders: { row: string; trailing: string; gap: number }[] = [];
        for (const row of rows) {
          const rb = row.getBoundingClientRect();
          // Leaf text spans inside the row, in visual order.
          const leaves: { el: Element; text: string; box: DOMRect }[] = [];
          row.querySelectorAll("*").forEach((el) => {
            let own = "";
            el.childNodes.forEach((n) => { if (n.nodeType === 3) own += n.textContent; });
            own = own.trim();
            if (!own || !painted(el)) return;
            leaves.push({ el, text: own, box: el.getBoundingClientRect() });
          });
          if (leaves.length < 2) continue;
          leaves.sort((a, b) => a.box.left - b.box.left);
          const first = leaves[0];
          const last = leaves[leaves.length - 1];
          if (last === first) continue;
          // A KEY CAP is not a category — it names a keystroke.
          if (last.el.tagName === "KBD" || last.el.closest("kbd")) continue;
          // A category column is a WORD (not a symbol, not a number)
          // parked against the right edge, separated from the label by a
          // real gap. Icons and arrows have no letters; a truncation
          // ellipsis has no letters either.
          if (!/[A-Za-zĂÂÎȘȚăâîșț]{3,}/.test(last.text)) continue;
          const gap = Math.round(last.box.left - first.box.right);
          const rightAligned = rb.right - last.box.right < 40;
          if (rightAligned && gap > 24) {
            offenders.push({
              row: first.text.slice(0, 32), trailing: last.text.slice(0, 32), gap,
            });
          }
        }
        return { rows: rows.length, offenders };
      });
      console.log(`[G4 ${label}] rows=${r.rows} offenders=${r.offenders.length}`);
      return r;
    };

    // A SWEEP, not one query. The resting surface may legitimately show
    // no navigation at all (navigation lives behind a keystroke), so the
    // rows have to be summoned — and summoned from several queries, or
    // the census is one row deciding a law about every row.
    const QUERIES = ["dash", "sce", "work", "bench", "prod", "sett", "cash", "bal"];
    const scans = [await scan("rest")];
    const input = composer(page);
    await input.click();
    for (const q of QUERIES) {
      await input.fill("");
      await input.fill(q);
      await page.waitForTimeout(320);
      scans.push(await scan(`typing:${q}`));
    }

    // FLOOR after every scan, against the total. Asserted here and not
    // inside the loop: a sweep that returned nothing must be visible as
    // a number, and a canary inside the loop cannot fire when the loop
    // never runs.
    const totalRows = scans.reduce((n, s) => n + s.rows, 0);
    expect(
      totalRows,
      `G4 VACUITY: ${totalRows} navigation rows examined across ${scans.length} ` +
        `states (floor ${FLOOR.navRows}). With no rows, "no row has a category ` +
        `column" is true of nothing.`,
    ).toBeGreaterThanOrEqual(FLOOR.navRows);

    const offenders = scans.flatMap((s) => s.offenders);
    expect(
      offenders,
      `G4: ${offenders.length} navigation row(s) carry a right-aligned category ` +
        `label:\n` +
        offenders.map((o) => `  "${o.row}"${" ".repeat(Math.max(1, 28 - o.row.length))}→ "${o.trailing}" (${o.gap}px gutter)`).join("\n") +
        `\nThe trailing word names the rail group the page lives in. The reader ` +
        `is looking for the page, not for the menu it was filed under, and the ` +
        `column makes every row the same shape — which is what makes this read ` +
        `as a directory instead of an answer.`,
    ).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// G5 — CLS 0
// ══════════════════════════════════════════════════════════════════════

test.describe("G5 — nothing on this surface jumps", () => {
  test.setTimeout(180_000);

  // THE DETECTOR CAN FAIL. First, prove the observer sees a shift when
  // there is one to see; only then is a zero worth reading. A CLS gate
  // that has never observed a non-zero is a gate measuring whether
  // PerformanceObserver was constructed.
  test("G5.a — the observer registers a planted shift", async ({ page }) => {
    await boot(page);
    await armCls(page);
    await openSurface(page);
    await resetCls(page);

    await page.evaluate(() => {
      const root = document.querySelector('[data-testid="command-palette"]');
      if (!root) throw new Error("G5 PLANT: no overlay to plant into");
      const shim = document.createElement("div");
      shim.setAttribute("data-craft-plant", "1");
      shim.style.height = "80px";
      root.insertBefore(shim, root.firstChild);
    });
    await page.waitForTimeout(700);
    const planted = await readCls(page);
    console.log(`[G5.a plant] cls=${planted.cls} shifts=${JSON.stringify(planted.shifts)}`);
    expect(
      planted.cls,
      "G5 PLANT: inserting an 80px block at the top of the open overlay produced " +
        "NO recorded layout shift. The observer is blind, so every zero below is " +
        "vacuous.",
    ).toBeGreaterThan(0);

    await page.evaluate(() => document.querySelector("[data-craft-plant]")?.remove());
  });

  test("G5.b — open, typing growth, streaming and close all shift nothing",
    async ({ page }) => {
      await stubTools(page);
      await stubGeneration(page, GROUNDED_ANSWER);
      await boot(page);
      await armCls(page);
      await page.waitForTimeout(400);

      const measured: { label: string; cls: number; shifts: unknown[] }[] = [];
      const phase = async (label: string, run: () => Promise<void>) => {
        await resetCls(page);
        await run();
        await page.waitForTimeout(800);
        const r = await readCls(page);
        measured.push({ label, ...r });
        console.log(`[G5 ${label}] cls=${r.cls}`);
      };

      await phase("open", async () => { await openSurface(page); });
      await phase("typing", async () => {
        const input = composer(page);
        await input.click();
        await input.type(TIER0_QUESTION, { delay: 45 });
      });
      await phase("streaming", async () => {
        const input = composer(page);
        await input.fill(TIER1_QUESTION);
        await input.press("Enter");
        await page.locator(ANCHORS.answer).waitFor({ timeout: ACTION_MS });
        await page.waitForTimeout(1600);
      });
      await phase("close", async () => {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(600);
      });

      // FLOOR after the loop, against the totals.
      expect(
        measured.length,
        "G5 VACUITY: fewer than four phases were measured.",
      ).toBe(4);

      for (const m of measured) {
        expect(
          m.cls,
          `G5: ${m.label} shifted the layout by ${m.cls}. Budget ${BUDGET.cls}. ` +
            `Sources: ${JSON.stringify(m.shifts)}`,
        ).toBeLessThanOrEqual(BUDGET.cls);
      }
    });
});

// ══════════════════════════════════════════════════════════════════════
// G6 — CONTRAST, MEASURED
// ══════════════════════════════════════════════════════════════════════
//
// "The glass looks fine" is not a measurement. A previous pass found AA
// failing on 10 of 16 text nodes with the glass exonerated: `ink-mute`
// measured 3.53:1 ON ITS OWN. So this measures the composited colour of
// every text-bearing node, in both themes, and prints the whole census —
// a gate that only prints its failures teaches nobody where the margin is.

test.describe("G6 — every text token clears AA on the glass, in both themes", () => {
  test.setTimeout(240_000);

  for (const theme of ["light", "dark"] as const) {
    test(`${theme}: rest, typing and answering`, async ({ page }) => {
      await page.addInitScript((th) => {
        window.localStorage.setItem("cfoai_theme", th);
      }, theme);
      await stubTools(page);
      await stubGeneration(page, GROUNDED_ANSWER);
      await boot(page);
      await openSurface(page);

      const phases: { label: string; nodes: TextNode[] }[] = [];
      phases.push({ label: "rest", nodes: await measureContrast(page, ANCHORS.overlay) });

      const input = composer(page);
      await input.click();
      await input.fill(TIER0_QUESTION);
      await page.waitForTimeout(450);
      phases.push({ label: "typing", nodes: await measureContrast(page, ANCHORS.overlay) });

      await ask(page, TIER1_QUESTION);
      await page.waitForTimeout(1400);
      phases.push({ label: "answering", nodes: await measureContrast(page, ANCHORS.overlay) });

      // FLOORS after the collection loop, against the totals. A theme
      // that failed to apply, or a selector that stopped matching, shows
      // up here as an empty census rather than as a clean pass.
      const restCount = phases[0].nodes.length;
      expect(
        restCount,
        `G6 VACUITY (${theme}): only ${restCount} text nodes measured at rest ` +
          `(floor ${FLOOR.contrastNodes}). An empty census passes every contrast ` +
          `assertion ever written.`,
      ).toBeGreaterThanOrEqual(FLOOR.contrastNodes);

      const allFails: string[] = [];
      const advisory: string[] = [];
      for (const { label, nodes } of phases) {
        for (const n of nodes) {
          if (n.ratio >= n.req) continue;
          const line = `  [${theme}/${label}] ${n.ratio}:1 (needs ${n.req}) ` +
            `${n.px}px "${n.txt}" color=${n.color} class=${n.cls}`;
          if (n.decorative) advisory.push(line); else allFails.push(line);
        }
        console.log(`[G6 ${theme}/${label}] ${nodes.length} text nodes · ` +
          `min ratio ${Math.min(...nodes.map((n) => n.ratio))}:1`);
      }
      if (advisory.length) {
        console.log(`[G6 ${theme}] advisory (aria-hidden separators, exempt under ` +
          `1.4.3 as pure decoration):\n${advisory.join("\n")}`);
      }

      expect(
        allFails,
        `G6 (${theme}): ${allFails.length} text token(s) below AA on the glass:\n` +
          allFails.join("\n") +
          `\nMeasured on the COMPOSITED colour — every ancestor background alpha- ` +
          `composited down to the document, then the text's own alpha on top. Fix ` +
          `the token, not the backdrop: a token that fails here fails everywhere ` +
          `it is used.`,
      ).toEqual([]);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════
// G7 — EVERY EXISTING INVARIANT, RE-PROVEN ON THE REDESIGNED SURFACE
// ══════════════════════════════════════════════════════════════════════

test.describe("G7/K10 — Tier 0 spends nothing at the Enter boundary", () => {
  test.setTimeout(240_000);

  // POSITIVE CONTROL FIRST, in the same file, on the same detector.
  // "No request reached a model seam" is the exact shape of assertion
  // that passed three times in this repo while the endpoint was never
  // called at all. This test is what makes the next one mean something.
  test("G7.a — the detector sees a real spend on a question Tier 0 refuses",
    async ({ page }) => {
      const seen: string[] = [];
      page.on("request", (r) => { if (isSpend(r.url())) seen.push(`${r.method()} ${r.url()}`); });
      await stubTools(page);
      await stubGeneration(page, GROUNDED_ANSWER);
      await boot(page);
      await openSurface(page);
      await ask(page, TIER1_QUESTION);
      await page.waitForTimeout(1600);

      console.log(`[G7.a control] ${seen.length} seam request(s):\n  ${seen.join("\n  ")}`);
      expect(
        seen.length,
        `G7 PLANT: "${TIER1_QUESTION}" reached NEITHER ` +
          MODEL_SEAMS.map((s) => s.label).join(" NOR ") +
          `. If a real spend cannot be observed here, the zero-spend assertion ` +
          `below is measuring nothing.`,
      ).toBeGreaterThan(0);
    });

  test("G7.b — Enter on a Tier-0 question issues no request to either seam",
    async ({ page }) => {
      const seen: string[] = [];
      page.on("request", (r) => { if (isSpend(r.url())) seen.push(`${r.method()} ${r.url()}`); });
      await stubTools(page);
      await stubGeneration(page, GROUNDED_ANSWER);
      await boot(page);
      await openSurface(page);

      const answer = await ask(page, TIER0_QUESTION);
      await page.waitForTimeout(1200);

      // ── ORDER MATTERS, and it was measured ─────────────────────────
      //
      // SPEND FIRST. An earlier draft asserted "a turn painted" before
      // it read the wire, so when the short-circuit was disabled for the
      // G8 plant the red said `capsule-turn not visible` — true (the
      // stub answers slowly and the canvas is mid-flight) and silent
      // about money. A gate whose red does not name the defect gets
      // triaged as flake. Both assertions still run in the same test:
      // spend proves the invariant, the canvas proves the zero was not
      // bought by rendering nothing.
      expect(
        seen,
        `G7/K10: pressing Enter on "${TIER0_QUESTION}" reached a model seam:\n  ` +
          (seen.join("\n  ") || "(none)") +
          `\nThe seams that must stay silent: ` +
          MODEL_SEAMS.map((s) => s.label).join(", ") +
          `\nTier 0 already holds this answer, with provenance, in microseconds. ` +
          `Paying for it is paying twice for a figure the client had.`,
      ).toEqual([]);

      // THE ANSWER ACTUALLY PAINTED. Without this, "zero spend" is
      // satisfied by a surface that did nothing at all — the exact
      // vacuous pass this section exists to refuse.
      await expect(
        answer.locator(ANCHORS.turn).first(),
        `G7: Enter on "${TIER0_QUESTION}" painted no turn. A zero-spend gate ` +
          `over an empty canvas measures nothing.`,
      ).toBeVisible({ timeout: ACTION_MS });
      const figures = await answer.locator("text=/\\d/").count();
      expect(
        figures,
        `G7: the Tier-0 turn carries no figure. Tier 0's contract is a FULL ` +
          `answer, not a placeholder that spends nothing by saying nothing.`,
      ).toBeGreaterThan(0);
    });
});

test.describe("G7/C1 — a fabricated figure never reaches the reader", () => {
  test.setTimeout(150_000);

  test("the model's own numerals are rejected, and the turn still renders",
    async ({ page }) => {
      await stubTools(page);
      await stubGeneration(page, FABRICATED_ANSWER);
      await boot(page);
      await openSurface(page);
      const answer = await ask(page, TIER1_QUESTION);
      await page.waitForTimeout(1600);

      // The turn rendered — so the rejection below is a rejection, not
      // an absence.
      await expect(
        answer.locator(ANCHORS.turn).first(),
        "G7/C1: no turn rendered, so 'the fabricated numeral is absent' is true " +
          "of an empty canvas.",
      ).toBeVisible({ timeout: ACTION_MS });

      const html = await answer.innerHTML();
      for (const fragment of FABRICATED_FRAGMENTS) {
        expect(
          html.includes(fragment),
          `G7/C1: the model's own numeral "${fragment}" is on screen. Every ` +
            `figure must be resolved by the client from a fact with provenance; ` +
            `a numeral the model typed is a number with no source.`,
        ).toBe(false);
      }
    });
});

test.describe("G7/C3 — every figure in an answer traces to a fact", () => {
  test.setTimeout(150_000);

  test("no unprovenanced figure survives to the DOM", async ({ page }) => {
    await stubTools(page);
    await stubGeneration(page, GROUNDED_ANSWER);
    await boot(page);
    await openSurface(page);
    const answer = await ask(page, TIER1_QUESTION);
    await page.waitForTimeout(1600);

    const provenanced = await answer
      .locator(PROVENANCE_CONTAINERS.join(", ") + ", [data-narrative-money]")
      .count();
    // FLOOR: an answer with no attributed figure at all would make "no
    // UNattributed figure" trivially true.
    expect(
      provenanced,
      "G7/C3 VACUITY: the answer carries no provenanced figure at all, so " +
        "'nothing is unprovenanced' is a statement about an empty set.",
    ).toBeGreaterThan(0);

    const offenders = await unprovenancedFigures(answer, [
      ...ALLOWED_IDENTIFIERS, ...KNOWN_UNATTRIBUTED_DIMENSIONLESS,
    ]);
    expect(
      offenders,
      `G7/C3: ${offenders.length} figure(s) in the answer carry no provenance:\n` +
        offenders.map((o) => `  "${o.text}"\n      ${o.html}`).join("\n"),
    ).toEqual([]);
  });
});

test.describe("G7/C5 — missing data is stated, never filled in", () => {
  test.setTimeout(150_000);

  test("a refused read shows the absence and renders no zero", async ({ page }) => {
    await stubTools(page, TOOL_PAYLOAD_GAP);
    await stubGeneration(page, "October 2024 has no attached file, so there is nothing to read.");
    await boot(page);
    await openSurface(page);
    const answer = await ask(page, "what were total assets in October 2024");
    await page.waitForTimeout(1600);

    const text = (await answer.innerText()).trim();
    expect(
      text.length,
      "G7/C5: a refused read showed the reader nothing at all. Silence is not " +
        "honesty — the absence has to be stated.",
    ).toBeGreaterThan(0);

    const zeros = await answer.evaluate((root: Element) => {
      const bad: string[] = [];
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n: Node | null = w.nextNode();
      while (n) {
        const t = (n.textContent ?? "").trim();
        if (/(^|\s)(0|0[.,]00|RON\s*0|0\s*RON|—\s*0)(\s|$)/.test(t)) bad.push(t.slice(0, 80));
        n = w.nextNode();
      }
      return bad;
    });
    expect(
      zeros,
      `G7/C5: the surface rendered a zero where the engine refused to state a ` +
        `figure:\n  ${zeros.join("\n  ")}\nABSENT ≠ ZERO. The only thing worse ` +
        `than not knowing is a number standing in for not knowing.`,
    ).toEqual([]);

    const offenders = await unprovenancedFigures(answer, ALLOWED_IDENTIFIERS);
    expect(
      offenders,
      `G7/C5: an unprovenanced figure appeared on the refusal path:\n` +
        offenders.map((o) => `  "${o.text}"`).join("\n"),
    ).toEqual([]);
  });
});

test.describe("G7/C2 — the surface is READ-ONLY at the wire", () => {
  test.setTimeout(150_000);

  test("every tool request is a read, named from the allowlist, with no mutation body",
    async ({ page }) => {
      const toolCalls: { method: string; path: string; body: string }[] = [];
      page.on("request", (req) => {
        const url = req.url();
        if (!/\/api\/capsule\/tools/.test(url)) return;
        toolCalls.push({
          method: req.method(),
          path: new URL(url).pathname,
          body: (req.postData() ?? "").slice(0, 240),
        });
      });
      await stubTools(page);
      await stubGeneration(page, GROUNDED_ANSWER);
      await boot(page);
      await openSurface(page);
      await ask(page, TIER1_QUESTION);
      await page.waitForTimeout(1600);

      // FLOOR after the turn: a read-only gate over zero requests is the
      // canonical vacuous pass. This is the one that bit K9/C2's
      // ancestor when Tier 0 started short-circuiting the question it
      // used to ask.
      expect(
        toolCalls.length,
        `G7/C2 VACUITY: the tool endpoint was never called during the turn, so ` +
          `"no write reached it" is true of nothing. This gate must ask a ` +
          `question that actually retrieves.`,
      ).toBeGreaterThan(0);

      // SEAM 1 — the verb. There is no PUT/PATCH/DELETE in the client by
      // construction; this asserts the construction held.
      const badVerb = toolCalls.filter((c) => c.method !== "POST" && c.method !== "GET");
      // SEAM 2 — the name. A tool whose leading verb mutates never
      // reaches the wire.
      const WRITE_VERBS = /\/(set|put|post_|create|update|delete|insert|patch|mutate|write|remove|drop)/i;
      const badName = toolCalls.filter((c) => WRITE_VERBS.test(c.path));
      // SEAM 3 — the body. A read invoked by POST is fine; a POST whose
      // body names a mutation is the seam that matters.
      const badBody = toolCalls.filter((c) =>
        /"(?:write|update|delete|insert|patch|mutate|create)"/i.test(c.body));

      console.log(`[G7/C2] ${toolCalls.length} tool request(s): ` +
        toolCalls.map((c) => `${c.method} ${c.path}`).join(", "));

      expect(
        [...badVerb, ...badName, ...badBody],
        `G7/C2: the Capsule attempted a write. Refusals are structural in ` +
          `engine/api/_capsule_tools.py (allowlist, frozen registry, dispatch ` +
          `re-check); this gate proves the SURFACE never asks in the first place.\n` +
          [...badVerb, ...badName, ...badBody]
            .map((c) => `  ${c.method} ${c.path} body=${c.body}`).join("\n"),
      ).toEqual([]);
    });
});

test.describe("G7/C4 — typing a destination reaches neither seam, fast", () => {
  test.setTimeout(200_000);

  const DESTINATIONS = [
    "dashboard", "scenarios", "benchmark", "products", "settings",
    "cash flow", "balance sheet", "461", "upload a document", "bilanț",
  ];

  test("no spend for any navigation query, and the router keeps up", async ({ page }) => {
    const spends: string[] = [];
    page.on("request", (r) => { if (isSpend(r.url())) spends.push(`${r.method()} ${r.url()}`); });
    await boot(page);
    await openSurface(page);
    const input = composer(page);

    const samples: number[] = [];
    let rowsSeenTotal = 0;
    for (const q of DESTINATIONS) {
      await input.fill("");
      const t0 = Date.now();
      await input.fill(q);
      const rows = page.locator(`${ANCHORS.overlay} [role="option"]`);
      await rows.first().waitFor({ timeout: 4000 }).catch(() => {});
      samples.push(Date.now() - t0);
      rowsSeenTotal += await rows.count();
      await page.waitForTimeout(90);
    }
    await page.waitForTimeout(700);

    // FLOORS after the loop, against the totals. `samples.length` guards
    // the percentile; `rowsSeenTotal` guards the claim that the router
    // was actually asked to do something.
    expect(
      samples.length,
      `G7 VACUITY: ${samples.length} keystroke samples (floor ${FLOOR.routerSamples}).`,
    ).toBeGreaterThanOrEqual(FLOOR.routerSamples);
    expect(
      rowsSeenTotal,
      `G7 VACUITY: the router produced ZERO rows across ${DESTINATIONS.length} ` +
        `destination queries. "Typing a destination spent nothing" would then be ` +
        `true because typing did nothing.`,
    ).toBeGreaterThan(0);

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
    console.log(`[G7 router] p50=${sorted[Math.floor(sorted.length / 2)]}ms p95=${p95}ms ` +
      `rows=${rowsSeenTotal}`);

    expect(
      spends,
      `G7/C4: typing destinations spent ${spends.length} request(s). Anthropic ` +
        `credits are live; this is a bug with an invoice attached.\n  ` +
        spends.join("\n  "),
    ).toEqual([]);
    expect(
      p95,
      `G7: slowest keystroke → rows was ${p95}ms. The router is measured under ` +
        `5ms in isolation (frontend/lib/__tests__); this live budget of ` +
        `${BUDGET.routerP95Ms}ms carries React's commit on top of it.`,
    ).toBeLessThanOrEqual(BUDGET.routerP95Ms);
  });
});

test.describe("G7/H1 — the header still holds exactly four controls at 1440", () => {
  test.setTimeout(120_000);

  test("four top-level interactive elements, and the Capsule is one of them",
    async ({ page }) => {
      await boot(page);
      const census = await appHeader(page).evaluate((headerEl: Element) => {
        const sel = 'button, a[href], [role="button"], input, select, textarea, ' +
          '[tabindex]:not([tabindex="-1"])';
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
        };
        const inOverlay = (el: Element) => !!el.closest('[data-testid="command-palette"]');
        const all = [...headerEl.querySelectorAll(sel)].filter((el) => visible(el) && !inOverlay(el));
        const top = all.filter((el) => {
          let p = el.parentElement;
          while (p && p !== headerEl) { if (all.includes(p)) return false; p = p.parentElement; }
          return true;
        });
        return {
          count: top.length,
          items: top.map((el) =>
            el.getAttribute("data-testid") || el.getAttribute("aria-label") ||
            (el.textContent || "").trim().slice(0, 24) || el.tagName),
        };
      });

      console.log(`[G7/H1] ${census.count} controls: ${census.items.join(" · ")}`);
      expect(
        census.count,
        `G7/H1: the header carries ${census.count} top-level controls at ` +
          `${VIEWPORT.width}px — the law is ${BUDGET.headerControls}. ` +
          `Present: ${census.items.join(" · ")}. The craft lane anchors a coach ` +
          `mark in this header; anchoring is not the same as ADDING, and this ` +
          `gate is the difference.`,
      ).toBe(BUDGET.headerControls);
      expect(
        census.items.some((i) => /command-bar|capsule/i.test(i)),
        "G7/H1: the Capsule is not among the header's controls.",
      ).toBe(true);
    });
});
