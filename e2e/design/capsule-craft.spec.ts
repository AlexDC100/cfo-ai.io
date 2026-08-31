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
  /** G4 — rows summoned across the whole query sweep. Measured 70 across
   *  15 states (2026-08-31, after the sweep was widened from nine queries
   *  to one per row FAMILY); 68 of them painted by `palette-row`. */
  navRows: 40,
  /** Per TYPING state, RECORDED from measurement — not one flat number.
   *
   *  A flat floor is the wrong shape here and I measured that before
   *  believing it: most queries legitimately paint 1-2 rows while
   *  `cash` paints 13. A floor high enough to protect `cash` fails the
   *  honest states; one low enough for them protects nothing.
   *
   *  So each state carries the quantity it is supposed to produce, taken
   *  from the measured census with a margin. `cash` is the state the
   *  first complaint was about and the one an adversarial audit collapsed
   *  from 13 rows to 0 while the gate stayed green on a shared total.
   *  `range`, `core`, `trans`, `glossary` and `a` are the states the
   *  SECOND audit proved the sweep had never visited at all.
   *
   *  Measured 2026-08-31, identical at 1440 and 390:
   *    dash 1 · sce 1 · work 3 · bench 2 · prod 2 · sett 1 · cash 13 ·
   *    bal 1 · a 18 · range 9 · core 10 · trans 6 · glossary 1 ·
   *    zzqqxx 0
   *
   *  `zzqqxx` is the deliberate no-match: it must paint the ask-fallback
   *  and no palette rows, so its expectation is 0 and it is checked by
   *  the `ask` family expectation instead. */
  rowsPerTypingState: {
    dash: 1, sce: 1, work: 2, bench: 1, prod: 1,
    sett: 1, cash: 8, bal: 1, zzqqxx: 0,
    a: 12, range: 6, core: 6, trans: 4, glossary: 1,
  } as Record<string, number>,
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

  // ── THE RESTING STATE IS NOT READY WHEN THE CARD IS ────────────────
  //
  // `buildCapsuleSuggestions` runs off the workspace snapshot, and the
  // half of that snapshot which produces this workspace's one chip (an
  // unattached period) arrives over the network. `boot`'s 8s settle is
  // usually enough and SOMETIMES IS NOT: the same capture harness,
  // unchanged, produced a resting card with one chip on one run and zero
  // on the next, and G4 — run inside the full suite rather than alone —
  // reported `suggestion: 0 rows` against its floor of 1.
  //
  // That is a race, not a defect, and a gate that reds on a race teaches
  // the reader to ignore a red. It is waited out HERE, once, so every
  // gate that reads the resting state reads the same one.
  //
  // Bounded and NOT swallowed: if the chip never arrives, this returns
  // anyway and the assertions after each gate's discovery loop — G4's
  // `suggestion` family floor, G1's resting ink floor — fail on the
  // measurement rather than on the wait. A `waitFor` that threw here
  // would report "timeout" where the gate should report "the resting
  // state paints nothing".
  await page
    .locator('[data-testid="command-palette"] [data-row-source="suggestion"]')
    .first()
    .waitFor({ state: "visible", timeout: 12_000 })
    .catch(() => {});
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
          // NAME THE NODE. "DIV" is a red nobody can act on — the same
          // lesson P3 forced on the spend gates, applied here: a shift
          // report that cannot say WHAT moved gets triaged as flake.
          nodes: (e.sources ?? []).map((s) => {
            const n = s.node as Element | undefined;
            if (!n) return "?";
            const own = n.getAttribute?.("data-testid");
            if (own) return own;
            const host = n.closest?.("[data-testid]")?.getAttribute("data-testid");
            const cls = (n.getAttribute?.("class") ?? "").trim().split(/\s+/).slice(0, 3).join(".");
            return `${n.tagName}${cls ? "." + cls : ""}${host ? ` in [${host}]` : ""}`;
          }),
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
// G1 — PROPORTION, RE-DERIVED. THE OLD METRIC COULD NOT SEE THE DEFECT.
// ══════════════════════════════════════════════════════════════════════
//
// ── WHAT WAS WRONG WITH THE OLD G1 ───────────────────────────────────
//
// It measured TRAILING DEAD SPACE — `overlay.bottom − deepest painted
// descendant.bottom` — against an 8px budget, plus a height ceiling.
// Both are blind to the complaint they were written for:
//
//   · dead space is INVARIANT to air BETWEEN children. A box that hugs
//     its last child scores ~0 however much air sits above it. Measured
//     3px on the build that was complained about and 3px on the build
//     that replaced it: the number did not move while the design did;
//   · the height ceiling was 440px, and the ORIGINAL surface — the one
//     the complaint is about — was 376px. G1 would have passed it.
//
// A gate that would have passed the defect it was written for is not a
// weak gate, it is a decoration. Replaced with the two things the
// adversarial critic actually measured:
//
//   INK DENSITY  Σ(area of every text run's client rects, taken with a
//                Range over the text node — GLYPH boxes, not element
//                boxes) ÷ the card's area. "Is this card carrying what
//                its size promises." A card that grows without gaining
//                words falls; a card that pads falls. It cannot be
//                gamed by hugging the last child, because it never looks
//                at the last child.
//
//   GAPS         the tallest horizontal band inside the card that no ink
//                crosses, split into the LEADING band (above the first
//                ink) and the INTERIOR ones. Air between children counts
//                here and counted nowhere before.
//
// ── THE THRESHOLDS, AND WHY THEY ARE THESE NUMBERS ───────────────────
//
// Measured on the target design, 2026-08-31, both themes identical:
//
//   state     1440×900               390×844
//   rest      298px 33.1vh · 5.62%   268px 31.8vh ·  9.72%
//   typing    358px 39.8vh · 13.71%  590px 69.9vh · 14.16%
//   tier0     227px 25.2vh ·  5.30%  206px 24.4vh ·  7.88%
//   answering 358px 39.8vh · 14.59%  499px 59.1vh · 18.13%
//
// The floors below are those numbers rounded DOWN with roughly a tenth
// of headroom, so a design that legitimately gets leaner does not red —
// and the DEFECT is far outside them, which is the only thing that makes
// a floor worth having. Planted (P-A, recorded in GATES.md): raising the
// resting card to 640px with the same content takes rest density to
// 2.6%, less than half the floor, and the leading gap to 455px.
//
// The rest floors are the loose ones on purpose, and they are now loose
// for a different reason than when they were written. They used to
// absorb the slack in a FIXED-height resting card sized for three chips
// on a workspace that yields one; that card is gone — the resting state
// measures its content (298px → 208px at 1440, 268px → 187px at 390,
// 2026-08-31) and its density roughly doubled, to 8.05% and 13.93%. The
// floors were NOT raised to match: a workspace that does yield three
// chips is a taller card with proportionally less ink, and a floor
// tuned to this demo's one chip would red on it. The air itself is
// bounded by `REST_LEADING_GAP_PX` below, which is the instrument that
// can actually see it.

/** The two viewports every proportion gate runs at. 1440 was the only
 *  one in the whole craft suite, and the 390 regression (a typing panel
 *  at 73vh, a second answered turn at 80vh, against a 70vh budget) went
 *  unseen for exactly that reason. */
const VIEWPORTS = [
  { label: "1440", width: 1440, height: 900 },
  { label: "390", width: 390, height: 844 },
] as const;

/** Ink floors, per state, per viewport. Per BOTH, because TC-6: a single
 *  global floor survives one half collapsing while the other holds. */
const INK_FLOOR: Record<string, Record<string, number>> = {
  // RECALIBRATED 2026-08-31 against the CLIPPED metric. This is not a
  // weakening; the instrument changed. The previous floors were derived
  // from unclipped Range boxes, which counted truncated and scrolled-out
  // text in full — so `1440 typing` read 13.71% while the reader saw
  // 7.74%. Re-deriving a floor after fixing the measurement is required;
  // keeping the old number would have failed a surface that never moved.
  //
  //            rest   typing  tier0   answering
  //   1440     5.62    7.74   5.30    11.87   (visible)
  //            5.62   13.71   5.30    14.59   (old, unclipped)
  //   390      9.72   14.00   7.88    18.13   (visible)
  //
  // Rounded DOWN with ~10% headroom so a legitimately leaner design does
  // not red. The 1440 numbers sit well below 390's for a structural
  // reason and not a quality one: the card is 680px wide against 374, so
  // the same rows of left-aligned text cover roughly half the area. That
  // is also why density alone cannot police the "mostly empty" complaint
  // — the LEAD and INTERIOR GAP budgets below do that, and the 113px
  // lead gap at 1440 rest is a real open defect this floor cannot see.
  "1440": { rest: 5.0, typing: 6.9, tier0: 4.6, answering: 10.5 },
  "390": { rest: 8.5, typing: 12.5, tier0: 6.8, answering: 15.5 },
};

/** The tallest band of air allowed BETWEEN painted things. */
const INTERIOR_GAP_PX = 56;

/**
 * The tallest band allowed ABOVE the first painted thing, in ANY state.
 *
 * ── WHY THIS NUMBER MOVED FROM 130 TO 32 ─────────────────────────────
 *
 * 130 was not a budget, it was a receipt. The resting card was FIXED at
 * `CAPSULE_REST_HEIGHT`, sized for the three chips `MAX_SUGGESTIONS`
 * allows, and its content was bottom-aligned — so a workspace rendering
 * one chip left the difference as a hole ABOVE the content: 113px of a
 * 298px card at 1440 (37.9%), 104px of 268px at 390 (38.8%). This
 * ceiling was set just above those two numbers so the shipped surface
 * would pass, and the comment said so: "the 113px lead gap at 1440 rest
 * is a real open defect this floor cannot see."
 *
 * A budget set above the defect it is pointed at is a decoration. The
 * owner re-ruled the geometry (`capsuleGeometry.ts` carries the algebra
 * and what it cost): the resting card now measures its content, the
 * bottom edge is a constant that no longer depends on it, and the
 * measured lead gaps are 24px at 1440 and 24px at 390 — the card's own
 * top padding, nothing more.
 *
 * 32 is those numbers plus a third of headroom. Everything this file
 * ever measured above it was the defect. Planted and proven RED
 * (design_review/capsule-craft/GATES-close.md): restoring the resting
 * floor takes 1440 rest straight back to 113px.
 */
const REST_LEADING_GAP_PX = 32;

interface Ink {
  card: { top: number; bottom: number; height: number; width: number };
  vhFraction: number;
  density: number;
  runs: number;
  leadingGap: number;
  interiorGap: number;
  gaps: { from: number; px: number }[];
}

/**
 * Ink and air inside the card. One `evaluate`, because every number here
 * has to describe the SAME layout — two round trips can straddle a
 * height transition and produce a density that never existed.
 */
async function ink(page: Page): Promise<Ink> {
  return page.locator(ANCHORS.overlay).evaluate((root: Element) => {
    const painted = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
    };
    const rr = root.getBoundingClientRect();
    const area = Math.max(1, rr.width * rr.height);

    const bands: [number, number][] = [];
    let inkArea = 0;
    let runs = 0;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    /** Intersect a glyph rect with every scroll/clip ancestor up to the
     *  card, so clipped text contributes only what is on screen. */
    const clipToAncestors = (rect: DOMRect, from: Element) => {
      let top = rect.top, left = rect.left;
      let bottom = rect.bottom, right = rect.right;
      let el: Element | null = from;
      while (el && el !== root.parentElement) {
        const cs = getComputedStyle(el);
        const clips = /hidden|auto|scroll|clip/.test(cs.overflowY)
          || /hidden|auto|scroll|clip/.test(cs.overflowX);
        if (clips) {
          const b = el.getBoundingClientRect();
          top = Math.max(top, b.top); left = Math.max(left, b.left);
          bottom = Math.min(bottom, b.bottom); right = Math.min(right, b.right);
          if (bottom <= top || right <= left) return null;
        }
        el = el.parentElement;
      }
      return { top, left, bottom, right,
               width: right - left, height: bottom - top };
    };

    let n: Node | null;
    while ((n = walk.nextNode())) {
      if (!n.textContent || !n.textContent.trim()) continue;
      const parent = n.parentElement;
      if (!parent || !painted(parent)) continue;
      // SR-ONLY IS NOT INK, and it took a diagnostic to notice.
      // `.sr-only` is a 1×1 clipped box, so `painted()` lets it through
      // — but a Range over its text reports the text's NATURAL layout
      // boxes, unclipped. The dialog's own `<h2 class="sr-only">` title
      // therefore registered as a 20px band of ink across the top of the
      // card: it inflated density from 5.62% to 8%, and it split the
      // resting card's one 113px hole into a 2px lead and a 91px
      // interior gap — turning the number this gate exists to bound into
      // a different number under a different budget. A measurement that
      // counts text nobody can see is not measuring the reader's page.
      const pb = parent.getBoundingClientRect();
      if (pb.width < 2 || pb.height < 2) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width < 1 || rect.height < 1) continue;
        // CLIP TO WHAT IS ACTUALLY ON SCREEN.
        //
        // The sr-only lesson above was half the problem. The other half:
        // a Range reports NATURAL layout boxes, so text truncated by an
        // ellipsis or scrolled out of a list still counted in full. That
        // made OVERFLOW BUY INK — the more the card hid, the better it
        // scored — and it is reachable without a plant. On the shipped
        // build, typing `o` at 1440 renders 18 rows of which 7 are
        // visible, 830px of content in a 282px scroller, and reports
        // 15.77% against a 12.0 floor while the reader sees 3.77% —
        // below even the RESTING floor. A gate that a real query can
        // walk past is not measuring the reader's page.
        const vis = clipToAncestors(rect, parent);
        if (!vis || vis.width < 1 || vis.height < 1) continue;
        inkArea += vis.width * vis.height;
        bands.push([vis.top, vis.bottom]);
        runs += 1;
      }
    }
    // Glyphless ink — icons, the selection rule — occupies the eye and
    // therefore closes a gap, but carries no area a density should count.
    root.querySelectorAll("svg, img").forEach((el) => {
      if (!painted(el)) return;
      const r = el.getBoundingClientRect();
      bands.push([r.top, r.bottom]);
    });

    const clipped = bands
      .map(([a, b]) => [Math.max(rr.top, a), Math.min(rr.bottom, b)] as [number, number])
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const band of clipped) {
      const last = merged[merged.length - 1];
      if (last && band[0] <= last[1] + 0.5) last[1] = Math.max(last[1], band[1]);
      else merged.push([band[0], band[1]]);
    }

    const gaps: { from: number; px: number }[] = [];
    let cursor = rr.top;
    for (const [a, b] of merged) {
      if (a - cursor > 0.5) gaps.push({ from: Math.round(cursor - rr.top), px: Math.round(a - cursor) });
      cursor = Math.max(cursor, b);
    }
    if (rr.bottom - cursor > 0.5) {
      gaps.push({ from: Math.round(cursor - rr.top), px: Math.round(rr.bottom - cursor) });
    }
    const leadingGap = gaps.length && gaps[0].from === 0 ? gaps[0].px : 0;
    const interiorGap = gaps
      .filter((g) => g.from !== 0)
      .reduce((m, g) => Math.max(m, g.px), 0);

    return {
      card: {
        top: Math.round(rr.top), bottom: Math.round(rr.bottom),
        height: Math.round(rr.height), width: Math.round(rr.width),
      },
      vhFraction: Math.round((rr.height / window.innerHeight) * 1000) / 10,
      density: Math.round((inkArea / area) * 10000) / 100,
      runs,
      leadingGap,
      interiorGap,
      gaps,
    };
  });
}

for (const vp of VIEWPORTS) {
  test.describe(`G1 @${vp.label} — the card carries what its size promises`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });
    test.setTimeout(200_000);

    test("ink density, air, and the 70vh ceiling, in every state", async ({ page }) => {
      await stubTools(page);
      await stubGeneration(page, GROUNDED_ANSWER);
      await boot(page);
      await openSurface(page);

      const states: { label: string; m: Ink }[] = [];
      states.push({ label: "rest", m: await ink(page) });

      const input = composer(page);
      await input.click();
      // TWO TYPING STATES, because they are two different cards and a
      // floor that averaged them would be a floor neither has to meet:
      //   · "cash" summons the ROW LIST — the state the complaint is
      //     about, and the query the critic used;
      //   · a Tier-0 question summons the local PREVIEW and no rows, so
      //     the card stays at its resting size with less in it.
      await input.fill("cash");
      await page.waitForTimeout(520);
      states.push({ label: "typing", m: await ink(page) });

      await input.fill("");
      await input.fill(TIER0_QUESTION);
      await page.waitForTimeout(520);
      states.push({ label: "tier0", m: await ink(page) });

      await input.fill("");
      await ask(page, TIER1_QUESTION);
      await page.waitForTimeout(1500);
      states.push({ label: "answering", m: await ink(page) });

      // FLOOR AFTER THE LOOP, against the total — never inside it. A
      // sweep that produced no states would otherwise satisfy every
      // assertion below by never running one.
      expect(
        states.length,
        `G1 VACUITY @${vp.label}: ${states.length} states measured. Every ` +
          `threshold below is a claim about nothing.`,
      ).toBe(4);
      const totalRuns = states.reduce((n, s) => n + s.m.runs, 0);
      expect(
        totalRuns,
        `G1 VACUITY @${vp.label}: ${totalRuns} text runs found across four ` +
          `states. The Range walk matched nothing, so every density below is ` +
          `0/area and every floor would red for the wrong reason — or, if the ` +
          `floors were ever lowered to accommodate it, pass for the wrong one.`,
      ).toBeGreaterThanOrEqual(30);

      const ceiling = Math.floor(vp.height * BUDGET.tallStateVh);
      // TC-6: ONE ASSERTION PER STATE, each naming its own state. A
      // single worst-of check over the three would let one state collapse
      // while the other two carried the average — which is exactly how
      // `import-boundary` printed "boundary holds" over a real violation.
      for (const { label, m } of states) {
        // eslint-disable-next-line no-console
        console.log(
          `[G1 ${vp.label} ${label}] ${m.card.width}×${m.card.height} ` +
            `(${m.vhFraction}vh) ink=${m.density}% runs=${m.runs} ` +
            `lead=${m.leadingGap}px interior=${m.interiorGap}px`,
        );

        expect(
          m.card.height,
          `G1 @${vp.label}: the ${label} card is ${m.card.height}px — ` +
            `${m.vhFraction}vh, over the ${ceiling}px (70vh) ceiling. Past that ` +
            `the overlay stops being an overlay and becomes the page. Mobile is ` +
            `where that reads as a takeover, and mobile is where this budget went ` +
            `ungated: 1440×900 was the only viewport in this suite, and the 390 ` +
            `typing panel sat at 73vh through a round that certified it.`,
        ).toBeLessThanOrEqual(ceiling);

        const floor = INK_FLOOR[vp.label][label];
        expect(
          m.density,
          `G1 @${vp.label}: the ${label} card is ${m.density}% ink against a ` +
            `${floor}% floor. ${m.card.width}×${m.card.height} carrying ` +
            `${m.runs} text runs.\n` +
            `Density is area of GLYPHS over area of CARD. It falls when the card ` +
            `grows without gaining words, and it is the measurement the old dead-` +
            `space metric could not make: a box that hugs its last child scored ` +
            `3px on the build that was complained about and 3px on the build that ` +
            `replaced it.`,
        ).toBeGreaterThanOrEqual(floor);

        expect(
          m.interiorGap,
          `G1 @${vp.label}: ${m.interiorGap}px of air BETWEEN painted things in ` +
            `the ${label} state (budget ${INTERIOR_GAP_PX}px). Gaps from the ` +
            `card's top: ${JSON.stringify(m.gaps)}.\n` +
            `Air between children is the half of "mostly empty" that trailing ` +
            `dead space cannot see.`,
        ).toBeLessThanOrEqual(INTERIOR_GAP_PX);
      }

      // The leading band, per state — including the grown ones, where it
      // measures 20-27px and would catch a card that grew without its
      // content following.
      for (const { label, m } of states) {
      expect(
        m.leadingGap,
        `G1 @${vp.label}: ${m.leadingGap}px of air ABOVE the ${label} card's ` +
          `first painted thing (ceiling ${REST_LEADING_GAP_PX}px).\n` +
          `The card is measured from its content and pinned by its BOTTOM edge, ` +
          `so slack cannot collect under the content — it collects above it, and ` +
          `this is the one number that can see it. 24px is the card's own top ` +
          `padding; 113px was a resting card reserving room for three suggestion ` +
          `chips on a workspace that renders one.`,
      ).toBeLessThanOrEqual(REST_LEADING_GAP_PX);
      }
    });
  });
}

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

for (const vp of VIEWPORTS) {
test.describe(`G2 @${vp.label} — the composer is the bottom, and it stays put`, () => {
  test.use({ viewport: { width: vp.width, height: vp.height } });
  test.setTimeout(200_000);

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
        `G2 @${vp.label}: in the ${label} state ${offenders.length} painted ` +
          `element(s) sit ` +
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
        `G2 @${vp.label}: the composer moves ${drift}px between states ` +
          `(${ys.map((v) => `${v.label}=${v.y}`).join(", ")}). The budget is ` +
          `${BUDGET.composerDriftPx}px. A composer that jumps when the answer ` +
          `arrives is a form redrawing itself, not a conversation continuing. ` +
          `The panel has to grow UPWARD from a fixed bottom edge.`,
      ).toBeLessThanOrEqual(BUDGET.composerDriftPx);
    });
});
}

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

  // ── NO NATIVE TOOLTIP, ANYWHERE ON THE SURFACE, IN ANY STATE ───────
  //
  // The previous version swept ROWS inside the OVERLAY, at rest and while
  // typing. It returned `[]` and the complaint was marked closed. Two
  // things were wrong with the sweep and both were in its SCOPE:
  //
  //   · the states. An ANSWERED turn carried three native tooltips and a
  //     follow-up carried six — the count GROWS with the conversation,
  //     because a provenance dot and a money span ride every figure in
  //     every turn. Neither state was swept.
  //   · the root. The trigger pill and the header trust dot are part of
  //     this surface and live OUTSIDE the portal. Both carried a `title`
  //     the whole time; a sweep rooted at the overlay could not see
  //     either.
  //
  // So: whole document, every state, plus a second turn — and the count
  // per state is printed, because "3 then 6" is a different defect from
  // "3 then 3" and only one of them gets worse the longer you stay.
  test("no native tooltip in any state, and none that grows per turn",
    async ({ page }) => {
      await stubTools(page);
      await stubGeneration(page, GROUNDED_ANSWER);
      await boot(page);
      const overlay = await openSurface(page);

      const sweep = async () =>
        page.evaluate(() => {
          const painted = (el: Element) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" &&
              cs.display !== "none";
          };
          const surface = (el: Element) =>
            !!el.closest('[data-testid="command-palette"]') ||
            !!el.closest('[data-testid="header-capsule"]');
          const titled = [...document.querySelectorAll("[title]")].filter(painted);
          return {
            // Everything on the surface: the card, and the pill it grew
            // out of.
            onSurface: titled.filter(surface).map((el) => ({
              testid:
                el.getAttribute("data-testid") ??
                el.closest("[data-testid]")?.getAttribute("data-testid") ??
                el.tagName,
              title: (el.getAttribute("title") ?? "").slice(0, 70),
            })),
            // The rest of the page, reported but not gated — this lane
            // bans native tooltips on the CAPSULE, not app-wide.
            elsewhere: titled.filter((el) => !surface(el)).length,
            // Proof the guard ran rather than proof nothing had a title.
            guard: document
              .querySelector('[data-testid="command-palette"]')
              ?.getAttribute("data-tooltip-guard") ?? "absent",
            reHomed: Number(
              document
                .querySelector('[data-testid="command-palette"]')
                ?.getAttribute("data-tooltips-suppressed") ?? "0",
            ),
            reHomedNodes: [
              ...(document.querySelectorAll(
                '[data-testid="command-palette"] [data-suppressed-title]',
              ) as unknown as Element[]),
            ].length,
          };
        });

      const states: { label: string; r: Awaited<ReturnType<typeof sweep>> }[] = [];
      states.push({ label: "rest", r: await sweep() });

      const input = composer(page);
      await input.click();
      await input.fill("cash");
      await page.waitForTimeout(420);
      states.push({ label: "typing", r: await sweep() });

      await input.fill(TIER1_QUESTION);
      await page.waitForTimeout(220);
      await input.press("Enter");
      await page.locator(ANCHORS.answer).waitFor({ timeout: ACTION_MS });
      await page.waitForTimeout(1500);
      states.push({ label: "answered", r: await sweep() });

      // THE SECOND TURN. This is the state the complaint is actually
      // about: the count doubled here.
      const followUp = composer(page);
      await followUp.click();
      await followUp.fill("why is that");
      await page.waitForTimeout(220);
      await followUp.press("Enter");
      await page.waitForTimeout(1800);
      states.push({ label: "answered+follow-up", r: await sweep() });

      // FLOOR AFTER THE LOOP: four states, or the growth comparison below
      // is one number compared with itself.
      expect(
        states.length,
        "G3 VACUITY: fewer than four states were swept; a tooltip count that " +
          "grows per turn cannot be seen in one turn.",
      ).toBe(4);

      // POSITIVE CONTROL on the detector itself. `[title]` must be
      // findable SOMEWHERE on this page, or "zero on the surface" is
      // satisfied by a selector that matches nothing anywhere.
      const anywhere = states.reduce((n, s) => n + s.r.elsewhere, 0);
      expect(
        anywhere,
        "G3 CONTROL: the `[title]` sweep found no tooltip anywhere on the page, " +
          "not even outside the Capsule. The detector is blind, so every zero " +
          "below is vacuous — it is not evidence that the surface has none.",
      ).toBeGreaterThan(0);

      // TC-6: ONE ASSERTION PER STATE.
      for (const { label, r } of states) {
        // eslint-disable-next-line no-console
        console.log(
          `[G3 tooltips ${label}] onSurface=${r.onSurface.length} ` +
            `elsewhere=${r.elsewhere} guard=${r.guard} re-homed=${r.reHomed}/` +
            `${r.reHomedNodes}`,
        );
        expect(
          r.onSurface,
          `G3: ${r.onSurface.length} native tooltip(s) on the Capsule in the ` +
            `"${label}" state:\n` +
            r.onSurface.map((o) => `  [${o.testid}] title="${o.title}"`).join("\n") +
            `\nThe browser draws \`title\` as an unstyled box after a delay the ` +
            `design does not control, in the OS font, never on touch, and never ` +
            `for a keyboard user. Everything it carried belongs in the row's own ` +
            `label, in \`aria-label\`, or nowhere.`,
        ).toEqual([]);
      }

      // THE GROWTH CLAUSE. Stated separately because a per-turn leak is
      // worse than a static one and reads differently in a red.
      const counts = states.map((s) => s.r.onSurface.length);
      expect(
        counts[3] - counts[2],
        `G3: the tooltip count went ${counts.join(" → ")} across rest, typing, ` +
          `one answer and two. A count that climbs with the conversation is a ` +
          `leak, not a constant: it was 3 after one turn and 6 after two on the ` +
          `build that was certified clean at rest.`,
      ).toBe(0);

      // THE GUARD RAN. Two of the five `title` sites belong to files this
      // lane may not edit and are re-homed at the surface's boundary, so
      // "zero tooltips" must not be satisfiable by the guard silently not
      // mounting. It has to have MOVED something.
      const answered = states[2].r;
      expect(
        answered.guard,
        "G3: `CapsuleTooltipGuard` did not mark the card. The two foreign-owned " +
          "`title` sites (`lib/narrativeMoney.tsx`, `components/cfo/" +
          "TraceableNumber.tsx`) are only absent because it runs; without it, a " +
          "zero here means the answer painted no figures.",
      ).toBe("on");
      expect(
        answered.reHomedNodes,
        `G3: the guard mounted but re-homed ${answered.reHomedNodes} titles in ` +
          `the answered state. A figure with provenance was expected to carry ` +
          `at least one. Zero means either the answer rendered no figure — in ` +
          `which case the tooltip zero above is vacuous — or the guard is ` +
          `DELETING strings instead of moving them, which trades this defect ` +
          `for a worse one.`,
      ).toBeGreaterThan(0);

      void overlay;
    });
});

// ══════════════════════════════════════════════════════════════════════
// G4 — NO CATEGORY COLUMN, MEASURED AS THE READER SEES IT,
//      OVER EVERY FAMILY OF ROW THE PALETTE CAN PAINT
// ══════════════════════════════════════════════════════════════════════
//
// "Dashboard … Overview". "Free cash flow … Cash Flow". "Core 200g …
// Protect". The right-hand word names the group the row was filed under
// — information the reader needed while BUILDING the app and never needs
// while USING it. It also gives every row the same two-column rhythm,
// which is what makes eight different choices read as one table of
// contents.
//
// ── FAILURE 1: IT MEASURED ELEMENT BOXES, NOT GLYPHS ─────────────────
//
// It measured `trailing.left − label.right`. The label span is
// `min-w-0 flex-1`, so its box stretches to fill whatever the row does
// not use, and its right edge sits `gap-3` — 12px — from the trailing
// span NO MATTER HOW SHORT THE LABEL IS. The gutter was pinned at 12px
// against a 24px threshold, so the detector fired 0 of 17 times while
// the reader, who sees GLYPHS and not boxes, saw a 200px+ gutter on
// every one of them. Fixed: the gutter below is measured with a `Range`
// over the text nodes.
//
// ── FAILURE 2: THE FIX LANDED ON THE WRONG COMPONENT (TC-7) ──────────
//
// The round that "closed" this removed the column from `CapsuleJumpList`,
// which renders ZERO rows in the state complained about, while
// `CommandPalette`'s own inline row renderer kept it. So this gate
// asserts WHICH COMPONENT PAINTED THE NODES IT EXAMINED: every
// row-rendering component stamps `data-row-source`, the census is
// printed with the tally, and a source that contributes nothing shows as
// an absent key rather than as a silent assumption.
//
// ── FAILURE 3: THE SWEEP NEVER SUMMONED THE OFFENDING ROWS ───────────
//
// Both fixes above were live, and this gate reported ZERO offenders on a
// build where an independent audit measured 20 at 1440 and 20 at 390.
// Its predicate agreed those rows were offenders. Its NINE QUERIES —
// dash, sce, work, bench, prod, sett, cash, bal, zzqqxx — summoned not
// one of them, because every one of them was a PRODUCT row and no query
// in the list matches a category or a SKU.
//
// That is failure 2 moved one axis over: from "the fix was applied to a
// component the sweep never rendered" to "the ban was checked against a
// family the sweep never summoned". A per-STATE floor (added after an
// audit emptied `cash` from 13 rows to 0 while the shared total stayed
// green) could not see it either: every state it visited was healthy;
// the sick ones were the states it did not visit.
//
// So the axis this gate is now floored on is the FAMILY. Every kind of
// row `CommandPalette` can push is declared in `CAPSULE_ROW_FAMILIES`
// (frontend/components/instrument/shell/CapsulePaletteRow.tsx), every row
// stamps the family it declared, and every family carries a RECORDED
// expectation below. A family that stops being summoned FAILS. A family
// this file does not know about FAILS. `check_capsule_craft.mjs` (F2)
// holds the two lists to each other, so a family added to the product
// and not to this sweep is a red before a browser ever starts.

/** Every component allowed to paint a row on this surface, and what it
 *  stamps. A row with no stamp is a renderer nobody declared. */
const ROW_SOURCES = [
  "palette-row", "jump-row", "suggestion", "ask-fallback",
] as const;

/**
 * THE FAMILY SWEEP — one recorded expectation per family.
 *
 * `query` is a query MEASURED to summon that family; `floor` is the row
 * count it produced on 2026-08-31, rounded DOWN with headroom so a
 * legitimately leaner catalogue does not red. Both viewports produced
 * identical censuses, so one table serves both.
 *
 *     family      query       measured   floor
 *     page        "a"                8       6
 *     action      "a"                5       4
 *     glossary    "glossary"         1       1
 *     concept     "cash"            13       8
 *     category    "range"            2       2
 *     sku         "range"            7       5
 *     company     "trans"            6       4
 *     suggestion  ""  (rest)         1       1
 *     ask         "zzqqxx"           1       1
 *
 * `suggestion` and `ask` are not palette-row families — they are the two
 * other row-painting components — but they are on the same axis and the
 * same failure applies, so they carry expectations too. The rest state
 * and the no-match state are exactly the two states an earlier version of
 * this gate did not cover.
 */
const FAMILY_EXPECT: Record<string, { query: string; floor: number }> = {
  page: { query: "a", floor: 6 },
  action: { query: "a", floor: 4 },
  glossary: { query: "glossary", floor: 1 },
  concept: { query: "cash", floor: 8 },
  category: { query: "range", floor: 2 },
  sku: { query: "range", floor: 5 },
  company: { query: "trans", floor: 4 },
  suggestion: { query: "", floor: 1 },
  ask: { query: "zzqqxx", floor: 1 },
};

/**
 * FAMILIES THIS STACK CANNOT PAINT, AND THE PIN THAT KEEPS THAT HONEST.
 *
 * A floor of zero is the vacuity this gate exists to refuse, so these
 * are not floored — they are PINNED AT EXACTLY ZERO. If one of them ever
 * paints a row, this gate FAILS and says so: the family has become
 * reachable and belongs in `FAMILY_EXPECT` with a measured floor and the
 * query that summons it. The expectation is two-sided, so it cannot
 * drift silently in either direction.
 *
 * `period` — `usePeriodStepper().periods` is EMPTY on the test-mode
 *   stack: the demo period (`demo-meridian`) is a resolved sample id and
 *   is not a row in `financial_periods`, so the palette's period loop
 *   iterates nothing. Measured, not assumed: "aug", "dec", "202", "a",
 *   "e", "2" and "0" all match the label a period would carry
 *   ("Aug 2026") and none of them produced a Periods section, while "a"
 *   returned 18 rows — the palette's own visible cap — with the four
 *   slots after Pages/Actions/Learn filled by Products rather than by
 *   periods.
 * `jump-row` — `CapsuleJumpList` is mounted by nothing since the craft
 *   pass removed the resting jump zone. Its module is still exported
 *   (see `CommandPalette`'s cross-lane note), which is exactly why it is
 *   pinned here rather than forgotten.
 */
const FAMILY_UNREACHABLE: Record<string, string> = {
  period:
    "`usePeriodStepper().periods` is empty on the test-mode stack, so the " +
    "palette's period loop iterates nothing. If a period row appears, this " +
    "stack now has periods: move `period` into FAMILY_EXPECT with the query " +
    "that summoned it and the count it produced.",
  "jump-row":
    "`CapsuleJumpList` is mounted by no surface since the resting jump zone " +
    "was removed. If a jump row appears, some surface remounted it: give it " +
    "a measured floor, because the category-column ban has to hold there too.",
};

/** Every query the sweep types. The union of the per-family queries and
 *  the nine the previous version used — those are kept so the per-state
 *  coverage this gate already had is not traded away for the new axis. */
const SWEEP_QUERIES = [
  "dash", "sce", "work", "bench", "prod", "sett", "cash", "bal",
  "a", "range", "core", "trans", "glossary", "zzqqxx",
];

test.describe("G4 — navigation rows carry no category column", () => {
  test.setTimeout(240_000);

  test("no row's trailing text is parked against the right edge, in any family",
    async ({ page }) => {
    await boot(page);
    const overlay = await openSurface(page);

    const scan = async (label: string) => {
      const r = await overlay.evaluate((root: Element) => {
        const painted = (el: Element) => {
          const b = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return b.width > 0 && b.height > 0 && cs.visibility !== "hidden";
        };
        // Every row, however it was stamped — plus the legacy selectors,
        // so a row that FORGOT to stamp is still examined and still
        // reported as unstamped rather than quietly skipped.
        const ROWS =
          '[data-row-source], [data-testid="capsule-jump-row"], ' +
          '[role="option"], [data-testid="capsule-ask-fallback"]';
        const rows = [...root.querySelectorAll(ROWS)].filter(painted);

        const bySource: Record<string, number> = {};
        const byFamily: Record<string, number> = {};
        const offenders: {
          source: string; family: string; row: string; trailing: string;
          glyphGutter: number; elementGutter: number;
        }[] = [];

        for (const row of rows) {
          const source = row.getAttribute("data-row-source") ?? "UNSTAMPED";
          bySource[source] = (bySource[source] ?? 0) + 1;
          // The FAMILY axis. A palette row declares its own; the two
          // other row-painting components are one family each, so their
          // `data-row-source` IS their family. A row with neither is
          // "UNSTAMPED" and fails the census below.
          const family =
            row.getAttribute("data-row-family") ??
            (source === "suggestion" || source === "jump-row" ? source : "UNSTAMPED");
          byFamily[family] = (byFamily[family] ?? 0) + 1;

          // TEXT RUNS, in visual order, measured as GLYPHS.
          const leaves: { text: string; left: number; right: number; el: Element }[] = [];
          const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
          let n: Node | null;
          while ((n = walk.nextNode())) {
            const txt = (n.textContent ?? "").trim();
            if (!txt) continue;
            const parent = n.parentElement;
            if (!parent || !painted(parent)) continue;
            const range = document.createRange();
            range.selectNodeContents(n);
            const box = range.getBoundingClientRect();
            if (box.width < 1) continue;
            leaves.push({ text: txt, left: box.left, right: box.right, el: parent });
          }
          if (leaves.length < 2) continue;
          leaves.sort((a, b) => a.left - b.left);
          const first = leaves[0];
          const last = leaves[leaves.length - 1];
          if (last === first) continue;
          // A KEY CAP names a keystroke, not a category.
          if (last.el.tagName === "KBD" || last.el.closest("kbd")) continue;
          // A word, not a symbol, not a number, not an ellipsis.
          if (!/[A-Za-zĂÂÎȘȚăâîșț]{3,}/.test(last.text)) continue;

          const rb = row.getBoundingClientRect();
          const glyphGutter = Math.round(last.left - first.right);
          const fb = first.el.getBoundingClientRect();
          const lb = last.el.getBoundingClientRect();
          const elementGutter = Math.round(lb.left - fb.right);
          const rightAligned = rb.right - last.right < 40;
          if (rightAligned && glyphGutter > 24) {
            offenders.push({
              source, family,
              row: first.text.slice(0, 32), trailing: last.text.slice(0, 32),
              glyphGutter, elementGutter,
            });
          }
        }
        return { rows: rows.length, bySource, byFamily, offenders };
      });
      // eslint-disable-next-line no-console
      console.log(
        `[G4 ${label}] rows=${r.rows} by=${JSON.stringify(r.bySource)} ` +
          `fam=${JSON.stringify(r.byFamily)} offenders=${r.offenders.length}`,
      );
      return { ...r, label };
    };

    // A SWEEP OVER FAMILIES, not one query and not one state. Navigation
    // lives behind a keystroke, so the rows have to be SUMMONED — and
    // from a query per family, or the census is one family deciding a law
    // about every family. "cash" is here because it is the query the
    // first critic used; "range" because it is the query the SECOND
    // critic used, and the one that proved nine queries had been checking
    // a ban against rows they never rendered. "zzqqxx" matches NOTHING,
    // and that state was uncovered until a final capture found the
    // ask-fallback row rendering there with no `data-row-source`.
    const scans = [await scan("rest")];
    const input = composer(page);
    await input.click();
    for (const q of SWEEP_QUERIES) {
      await input.fill("");
      await input.fill(q);
      await page.waitForTimeout(340);
      scans.push(await scan(`typing:${q}`));
    }
    await input.fill("");
    await page.waitForTimeout(340);

    // ── FLOORS, AFTER every scan — PER FAMILY, PER STATE, then totals ──
    //
    // A floor on the SUM is the TC-6 disease. It has now been demonstrated
    // on this exact gate on two different axes, so all three are asserted
    // and each names the collapse it can see that the others cannot.

    const familyTally: Record<string, number> = {};
    for (const s of scans) {
      for (const [k, v] of Object.entries(s.byFamily)) {
        familyTally[k] = (familyTally[k] ?? 0) + v;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[G4 family census] ${JSON.stringify(familyTally)}`);

    // (1) EVERY DECLARED FAMILY WAS SUMMONED TO ITS FLOOR **BY THE QUERY
    //     RECORDED FOR IT**, not by the sweep as a whole.
    //
    // The first draft of this checked the SUM across every state, and
    // that is the TC-6 disease wearing the new axis's clothes: `sku` has
    // a floor of 5 and is painted by both `range` (7) and `core` (3), so
    // `range` could collapse to zero and the total would still clear the
    // floor on `core` alone. The recorded query was then decoration —
    // printed in the failure message, used by nothing, and wrong without
    // consequence.
    //
    // So the count is per (STATE × FAMILY), read from the state the
    // expectation names. A recorded query that is not in the sweep is
    // itself a failure, because an expectation aimed at a state that is
    // never visited is an expectation that can never fire.
    const perState = new Map(scans.map((s) => [s.label, s.byFamily]));
    const missingQueries: string[] = [];
    const starvedFamilies: string[] = [];
    for (const [family, exp] of Object.entries(FAMILY_EXPECT)) {
      const label = exp.query === "" ? "rest" : `typing:${exp.query}`;
      const byFamily = perState.get(label);
      if (!byFamily) {
        missingQueries.push(
          `${family}: recorded query "${exp.query || "(rest)"}" → state ` +
          `"${label}", which the sweep never visited`);
        continue;
      }
      const got = byFamily[family] ?? 0;
      if (got < exp.floor) {
        starvedFamilies.push(
          `${family}: ${got} row(s) in state "${label}", floor ${exp.floor} ` +
          `(total across the whole sweep: ${familyTally[family] ?? 0})`);
      }
    }

    expect(
      missingQueries,
      `G4 EXPECTATION AIMED AT NOTHING: a family's recorded query is not in ` +
        `SWEEP_QUERIES, so the state it names was never measured.\n` +
        missingQueries.map((s) => `  ${s}`).join("\n") +
        `\nStates visited: ${[...perState.keys()].join(" ")}`,
    ).toEqual([]);

    expect(
      starvedFamilies,
      `G4 PER-FAMILY VACUITY: a row family this surface can paint was not ` +
        `summoned to its recorded floor BY THE QUERY RECORDED FOR IT, so ` +
        `"no row of that family has a category column" is true of nothing ` +
        `THERE.\n` +
        starvedFamilies.map((s) => `  ${s}`).join("\n") +
        `\nCensus: ${JSON.stringify(familyTally)}\n` +
        `This is the exact green this gate printed over 20 offending Product ` +
        `rows: nine queries, none of which summons a category or a SKU, and a ` +
        `predicate that would have caught every one of them. Note the total ` +
        `beside each count: a family can look healthy in the aggregate while ` +
        `the state that actually renders it is empty.`,
    ).toEqual([]);

    // (2) FAMILIES PINNED AT ZERO ARE STILL AT ZERO.
    const nowReachable = Object.keys(FAMILY_UNREACHABLE)
      .filter((f) => (familyTally[f] ?? 0) > 0)
      .map((f) => `${f}: ${familyTally[f]} row(s). ${FAMILY_UNREACHABLE[f]}`);
    expect(
      nowReachable,
      `G4 PIN BROKEN: a family recorded as unreachable on this stack painted ` +
        `rows.\n${nowReachable.map((s) => `  ${s}`).join("\n")}\n` +
        `A zero that is merely observed is a vacuous pass; this pin is the ` +
        `two-sided version, and it has just told you the ground moved.`,
    ).toEqual([]);

    // (3) NO FAMILY THIS FILE DOES NOT KNOW ABOUT.
    const unknownFamilies = Object.keys(familyTally).filter(
      (f) => !(f in FAMILY_EXPECT) && !(f in FAMILY_UNREACHABLE));
    expect(
      unknownFamilies,
      `G4: rows were painted by ${JSON.stringify(unknownFamilies)}, which this ` +
        `sweep declares neither an expectation nor a pin for. Census: ` +
        `${JSON.stringify(familyTally)}.\n` +
        `"UNSTAMPED" here means a row whose renderer declared no family — the ` +
        `same defect as an unstamped \`data-row-source\`, one axis over. ` +
        `Declare it in \`CAPSULE_ROW_FAMILIES\` and give it a floor.`,
    ).toEqual([]);

    // (4) PER-STATE, the count of PALETTE rows each typing state owes.
    const typingScans = scans.filter((s) => s.label.startsWith("typing:"));
    const starved = typingScans
      .map((s) => ({ s, want: FLOOR.rowsPerTypingState[s.label.slice(7)] ?? 1 }))
      .filter(({ s, want }) => (s.bySource["palette-row"] ?? 0) < want)
      .map(({ s, want }) =>
        `${s.label}: ${s.bySource["palette-row"] ?? 0} palette-rows, expected ${want}`);
    expect(
      starved,
      `G4 PER-STATE VACUITY: a state painted fewer palette-rows than it is ` +
        `supposed to. "No row has a category column" is then true of nothing ` +
        `THERE, however healthy the total looks — an audit emptied \`cash\` ` +
        `from 13 rows to 0 and this gate printed green on the shared total. ` +
        `Census: ${typingScans.map((s) => `${s.label}=${s.bySource["palette-row"] ?? 0}`).join(" ")}`,
    ).toEqual([]);

    const totalRows = scans.reduce((n, s) => n + s.rows, 0);
    expect(
      totalRows,
      `G4 VACUITY: ${totalRows} rows examined across ${scans.length} states ` +
        `(floor ${FLOOR.navRows}). With no rows, "no row has a category column" ` +
        `is true of nothing.`,
    ).toBeGreaterThanOrEqual(FLOOR.navRows);

    // ── TC-7: WHICH COMPONENT PAINTED THEM ────────────────────────────
    const tally: Record<string, number> = {};
    for (const s of scans) {
      for (const [k, v] of Object.entries(s.bySource)) tally[k] = (tally[k] ?? 0) + v;
    }
    // eslint-disable-next-line no-console
    console.log(`[G4 TC-7 census] ${JSON.stringify(tally)}`);

    expect(
      tally.UNSTAMPED ?? 0,
      `TC-7: ${tally.UNSTAMPED ?? 0} row(s) carry no \`data-row-source\`. Census: ` +
        `${JSON.stringify(tally)}.\nAn unstamped row is a renderer this gate ` +
        `cannot name. The defect this predicate exists for was a row-level fix ` +
        `applied to a component that paints nothing in the state under test, ` +
        `while an unnamed one painted thirteen rows with the defect intact.`,
    ).toBe(0);

    expect(
      Object.keys(tally).filter((k) => !ROW_SOURCES.includes(k as never)),
      `TC-7: a row was painted by a source this file does not know about. ` +
        `Census: ${JSON.stringify(tally)}. Declare it in ROW_SOURCES — or, if ` +
        `the rows moved, this gate is now measuring the old component.`,
    ).toEqual([]);

    expect(
      tally["palette-row"] ?? 0,
      `TC-7 FLOOR: \`palette-row\` painted ${tally["palette-row"] ?? 0} rows ` +
        `across the sweep. Census: ${JSON.stringify(tally)}.\nThis is the ` +
        `component that paints the typing state. A zero here means the sweep ` +
        `never reached it — and a category-column ban that never reached the ` +
        `component with the category column is the exact green this gate ` +
        `produced last round.`,
    ).toBeGreaterThanOrEqual(FLOOR.navRows);

    const offenders = scans.flatMap((s) => s.offenders);
    expect(
      offenders,
      `G4: ${offenders.length} row(s) carry a right-aligned trailing label:\n` +
        offenders
          .map((o) =>
            `  [${o.source} · ${o.family}] "${o.row}" → "${o.trailing}"  ` +
              `glyph gutter ${o.glyphGutter}px (element gutter ${o.elementGutter}px)`,
          )
          .join("\n") +
        `\nNote the two gutters. The ELEMENT gutter is pinned near 12px by the ` +
        `label's \`flex-1\` however short the label is, which is why an earlier ` +
        `version of this gate fired 0 of 17 times. The GLYPH gutter is what the ` +
        `reader sees. Note the FAMILY too: the last 20 offenders were all one ` +
        `family, and the sweep that missed them was checking eight others.`,
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
