/**
 * THE CAPSULE — SURFACE-LANE GATES S1–S2.
 *
 * ── Why this file exists next to `capsule-craft.spec.ts` ─────────────
 *
 * That file is lane 2's and it is thorough: proportion, composer anchor,
 * duplicated hints, category columns, CLS, contrast, and every invariant
 * the old surface kept. This lane did not write it and does not edit it.
 *
 * What it cannot see are the two ways THIS redesign fails SILENTLY —
 * both of which actually happened during the build, and neither of which
 * changes anything a screenshot or a geometry census would notice:
 *
 *   S1  THE ANIMATED HEIGHT IS APPLIED, NOT MERELY COMPUTED.
 *       The card's height is measured from its content and transitioned,
 *       so the composer pinned to the bottom edge travels instead of
 *       teleporting. For two rounds it did nothing at all: the stack
 *       carried `flex-1`, `flex: 1 1 0%` replaces `height` as a flex
 *       item's main size, and the browser silently used the content
 *       height instead. The panel LOOKED right — content height is what
 *       it wanted anyway — so no geometry gate, no screenshot and no
 *       type error could tell. Only a comparison of what the hook
 *       COMPUTED against what the box actually IS can.
 *
 *   S2  THE COMPOSER PAINTS NO BOX.
 *       "It reads as a FORM FIELD, not a composer" was never caused by a
 *       border in the component — there has never been one. It is
 *       `index.css`'s global
 *           :where(… textarea …):focus-visible { box-shadow: … }
 *       and this input is autofocused the moment the surface opens, so
 *       the ring is on in every frame. One deleted utility class
 *       (`focus-visible:shadow-none`) brings the whole complaint back,
 *       from a file this lane does not own, with nothing else changing.
 *
 * ── VACUITY ──────────────────────────────────────────────────────────
 *
 * Every assertion here is preceded by a POSITIVE CONTROL that plants the
 * defect live, in the page, and requires the detector to see it — so a
 * gate whose selector stopped matching cannot report compliance. The
 * plant is then removed and the real state measured. Work-count floors
 * are asserted AFTER the loops that produce them, never inside.
 *
 * NO MODEL SPEND: this file never asks a question.
 *
 * Needs the authed test-mode stack (vite :5173 + engine :8000
 * PUBLIC_TEST_MODE), same as every other spec in this directory:
 *   npx playwright test e2e/design/capsule-craft-surface.spec.ts --project=chromium
 */
import { test, expect, type Page } from "@playwright/test";
import { dismissPublicTestBanner, preseedLearningMode } from "../_helpers";

test.use({ viewport: { width: 1440, height: 900 } });

test.skip(
  ({ baseURL }) => !/localhost|127\.0\.0\.1/.test(baseURL ?? ""),
  "the Capsule needs the authed test-mode stack (vite :5173 + engine :8000 PUBLIC_TEST_MODE)",
);

const ANCHORS = {
  trigger: '[data-testid="header-command-bar"]',
  overlay: '[data-testid="command-palette"]',
  stack: '[data-testid="capsule-stack"]',
  composerBlock: '[data-testid="capsule-composer-block"]',
  input: '[data-testid="command-palette"] textarea',
} as const;

const ACTION_MS = 20_000;
const SETTLE_MS = 8_000;

async function boot(page: Page): Promise<void> {
  await preseedLearningMode(page);
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS);
  await dismissPublicTestBanner(page);
}

async function openSurface(page: Page): Promise<void> {
  await page.locator(ANCHORS.trigger).click({ timeout: ACTION_MS });
  await expect(page.locator(ANCHORS.overlay)).toBeVisible({ timeout: ACTION_MS });
  // Past the morph: geometry read during the growth measures the
  // animation, not the design.
  await page.waitForTimeout(700);
}

// ══════════════════════════════════════════════════════════════════════
// S0 — the anchors resolve, or every assertion below is about nothing
// ══════════════════════════════════════════════════════════════════════

test.describe("S0 — anchors", () => {
  test("every selector this file asserts on matches a real element", async ({ page }) => {
    await boot(page);
    const closed = await page.locator(ANCHORS.trigger).count();
    expect(closed, `S0: ${ANCHORS.trigger} matched nothing with the surface closed`)
      .toBeGreaterThan(0);

    await openSurface(page);
    const found: Record<string, number> = {};
    for (const key of ["overlay", "stack", "composerBlock", "input"] as const) {
      found[key] = await page.locator(ANCHORS[key]).count();
    }
    // FLOOR AFTER the loop, against the totals — a check inside it
    // cannot fire when the loop body never runs.
    expect(
      Object.keys(found).length,
      "S0 VACUITY: no anchors were probed at all.",
    ).toBe(4);
    for (const [key, n] of Object.entries(found)) {
      expect(n, `S0: ${ANCHORS[key as keyof typeof ANCHORS]} matched nothing`).toBeGreaterThan(0);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// S1 — the measured height reaches the box
// ══════════════════════════════════════════════════════════════════════

interface HeightReading {
  /** What `useCapsuleHeight` computed, off `data-measured`. */
  computed: number | null;
  /** What the element actually is. */
  used: number;
  /** The composer's distance from the stack's bottom edge. */
  composerGap: number | null;
}

async function readHeight(page: Page): Promise<HeightReading> {
  return page.evaluate((sel) => {
    const stack = document.querySelector(sel.stack);
    const comp = document.querySelector(sel.composerBlock);
    if (!stack) return { computed: null, used: 0, composerGap: null };
    const attr = stack.getAttribute("data-measured");
    const sr = stack.getBoundingClientRect();
    const cr = comp?.getBoundingClientRect() ?? null;
    return {
      computed: attr === null ? null : Number(attr),
      used: Math.round(sr.height),
      composerGap: cr ? Math.round(sr.bottom - cr.bottom) : null,
    };
  }, { stack: ANCHORS.stack, composerBlock: ANCHORS.composerBlock });
}

test.describe("S1 — the card's height is measured AND applied", () => {
  test.setTimeout(120_000);

  test("the hook RAN, the box obeys it, and a flex-basis override is detected",
    async ({ page }) => {
      await boot(page);
      await openSurface(page);

      // ── the hook ran at all ──────────────────────────────────────
      const rest = await readHeight(page);
      expect(
        rest.computed,
        "S1: the stack carries no `data-measured`, so `useCapsuleHeight` never " +
          "produced a number. An anchor that is written, exported, unit-tested " +
          "and never CALLED is this repo's signature defect — the morph anchor " +
          "shipped that way once, measured live at 30px of drift with an empty " +
          "inline style attribute.",
      ).not.toBeNull();
      expect(rest.computed!).toBeGreaterThan(0);

      // ── POSITIVE CONTROL: plant the exact defect, live ───────────
      //
      // `flex: 1 1 0%` is what `flex-1` expands to, and a flex item's
      // flex-basis REPLACES height as its main size. If the detector
      // cannot see the divergence it plants here, the assertion after
      // it is decoration.
      //
      // PLANTED IN THE TYPING STATE, NOT AT REST, and the first version
      // of this gate got that wrong and reported `Received: 0`.
      // `data-measured` IS the content height whenever the content fits,
      // so at rest the override and the measurement agree to the pixel
      // and the plant is invisible. The two only diverge where the
      // `min(70vh, 520)` CLAMP binds — a long result list, where the
      // measurement says 520 and flex-basis says "as tall as the
      // content". So the plant needs a query with a long list under it,
      // which is also the exact state the clamp exists for.
      await page.locator(ANCHORS.input).first().fill("cash");
      await page.waitForTimeout(600);
      const beforePlant = await readHeight(page);
      expect(
        beforePlant.computed,
        "S1 PLANT SETUP: no measurement in the typing state.",
      ).not.toBeNull();

      await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) el.style.setProperty("flex", "1 1 0%");
      }, ANCHORS.stack);
      await page.waitForTimeout(350);
      const planted = await readHeight(page);
      expect(
        Math.abs(planted.used - (planted.computed ?? 0)),
        "S1 PLANT: `flex: 1 1 0%` was applied to the stack and its used height " +
          "still matched `data-measured`. The detector cannot see the very " +
          "override that silently disabled this animation for two rounds, so " +
          "the assertion below proves nothing.",
      ).toBeGreaterThan(2);

      await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) el.style.removeProperty("flex");
      }, ANCHORS.stack);
      await page.locator(ANCHORS.input).first().fill("");
      await page.waitForTimeout(500);

      // ── the real state ───────────────────────────────────────────
      const after = await readHeight(page);
      expect(
        Math.abs(after.used - (after.computed ?? 0)),
        `S1: the stack computed ${after.computed}px and is ${after.used}px. ` +
          `Something is overriding the measured height — most likely a flex ` +
          `shorthand back on the stack. The height then stops animating, and ` +
          `the composer teleports instead of travelling.`,
      ).toBeLessThanOrEqual(2);

      // The composer is flush with the edge it is pinned to.
      expect(
        after.composerGap,
        "S1: the composer is not flush with the stack's bottom edge.",
      ).not.toBeNull();
      expect(Math.abs(after.composerGap!)).toBeLessThanOrEqual(2);
    });

  test("the height tracks content — typing changes it, and it stays applied",
    async ({ page }) => {
      await boot(page);
      await openSurface(page);
      const rest = await readHeight(page);

      const readings: HeightReading[] = [];
      for (const q of ["cash", "dash", "balance"]) {
        await page.locator(ANCHORS.input).first().fill(q);
        await page.waitForTimeout(500);
        readings.push(await readHeight(page));
      }

      // WORK FLOOR, after the loop.
      expect(
        readings.length,
        "S1 VACUITY: no typing states were measured — the loop produced nothing " +
          "and every assertion below would be about an empty array.",
      ).toBe(3);

      for (const r of readings) {
        expect(r.computed, "S1: `data-measured` vanished while typing").not.toBeNull();
        expect(
          Math.abs(r.used - (r.computed ?? 0)),
          "S1: the measured height stopped reaching the box while typing.",
        ).toBeLessThanOrEqual(2);
      }

      // And it is not a constant pretending to be a measurement.
      const distinct = new Set([rest.used, ...readings.map((r) => r.used)]);
      expect(
        distinct.size,
        `S1: the card was ${[...distinct].join("/")}px across four different ` +
          `contents. A height that never changes is not measured from content, ` +
          `whatever the attribute says.`,
      ).toBeGreaterThan(1);
    });
});

// ══════════════════════════════════════════════════════════════════════
// S2 — the composer paints no box
// ══════════════════════════════════════════════════════════════════════

interface BoxReading {
  boxShadow: string;
  borderWidths: string[];
  borderStyles: string[];
  outlineWidth: string;
  outlineStyle: string;
  outlineColor: string;
  borderColors: string[];
  focused: boolean;
}

async function readBox(page: Page): Promise<BoxReading> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const cs = getComputedStyle(el);
    return {
      boxShadow: cs.boxShadow,
      borderWidths: [
        cs.borderTopWidth, cs.borderRightWidth,
        cs.borderBottomWidth, cs.borderLeftWidth,
      ],
      borderStyles: [
        cs.borderTopStyle, cs.borderRightStyle,
        cs.borderBottomStyle, cs.borderLeftStyle,
      ],
      borderColors: [
        cs.borderTopColor, cs.borderRightColor,
        cs.borderBottomColor, cs.borderLeftColor,
      ],
      outlineWidth: cs.outlineWidth,
      outlineStyle: cs.outlineStyle,
      outlineColor: cs.outlineColor,
      focused: document.activeElement === el,
    };
  }, ANCHORS.input);
}

/**
 * A box is anything that ENCLOSES the text: a ring, a border, an
 * outline. The accent underline is not one — it is a single edge, it is
 * a sibling element, and it never reaches this node's computed style.
 *
 * ── A COMPUTED STYLE IS NOT A PAINTED BOX ────────────────────────────
 *
 * The first version of this predicate failed on the CORRECT surface,
 * twice, and both cases are worth keeping as comments because both look
 * like defects in `getComputedStyle` output and are not:
 *
 *   · Tailwind's `shadow-none` does not compute to `none`. It computes
 *     to `rgba(0,0,0,0) 0px 0px 0px 0px, …` — fully transparent shadows
 *     of zero size, because the utility sets the shadow custom
 *     properties rather than clearing the property. Nothing is painted.
 *   · `outline-width` is `2px` on a node whose `outline-style` is
 *     `none`. The used width of an absent outline is not zero; the
 *     STYLE is what decides whether anything is drawn.
 *   · and then, after fixing that one, `outline: 2px solid` — WITH a
 *     style, and still painting nothing, because Tailwind's
 *     `outline-none` utility is literally
 *         outline: 2px solid transparent; outline-offset: 2px;
 *     rather than `outline: none`. So COLOUR is the third thing that
 *     has to be checked, and a predicate that stopped at width and
 *     style would have failed the correct surface a second time.
 *
 * A gate that called either of those a violation would have forced the
 * next person to "fix" a surface that was already right — which is the
 * false-red twin of the false green this session is about.
 */
function boxOffenders(b: BoxReading): string[] {
  const out: string[] = [];

  // Any shadow layer with a visible colour AND a non-zero geometry.
  const layers = (b.boxShadow ?? "").split(/,(?![^(]*\))/).map((s) => s.trim());
  const invisible = (c: string) =>
    !c || c === "transparent" || /rgba?\([^)]*,\s*0\s*\)/.test(c);

  const visible = layers.filter((layer) => {
    if (!layer || layer === "none") return false;
    if (/rgba?\([^)]*,\s*0\s*\)/.test(layer)) return false;   // alpha 0
    const lengths = layer.match(/-?[\d.]+px/g) ?? [];
    return lengths.some((l) => parseFloat(l) !== 0);
  });
  if (visible.length) out.push(`box-shadow: ${visible.join(", ")}`);

  for (let i = 0; i < b.borderWidths.length; i++) {
    if (
      parseFloat(b.borderWidths[i]) > 0 &&
      b.borderStyles[i] !== "none" &&
      !invisible(b.borderColors[i])
    ) {
      out.push(`border: ${b.borderWidths[i]} ${b.borderStyles[i]} ${b.borderColors[i]}`);
      break;
    }
  }
  if (
    parseFloat(b.outlineWidth) > 0 &&
    b.outlineStyle !== "none" &&
    !invisible(b.outlineColor)
  ) {
    out.push(`outline: ${b.outlineWidth} ${b.outlineStyle} ${b.outlineColor}`);
  }
  return out;
}

test.describe("S2 — the composer is a composer, not a form field", () => {
  test.setTimeout(120_000);

  test("no border, ring or outline encloses the input — while it is FOCUSED",
    async ({ page }) => {
      await boot(page);
      await openSurface(page);

      // FOCUS IS THE WHOLE POINT. The global rule that drew the box is
      // `:focus-visible`, and this input is autofocused on open — so a
      // gate that measured it blurred would measure the one state in
      // which the defect is invisible.
      const rest = await readBox(page);
      expect(
        rest.focused,
        "S2: the composer is not focused when the surface opens. Either the " +
          "autofocus regressed (a reader now has to click before typing) or " +
          "this gate is about to measure the wrong state.",
      ).toBe(true);

      // ── POSITIVE CONTROL ─────────────────────────────────────────
      //
      // Re-plant `index.css`'s global rule, scoped to this node. If the
      // detector cannot see the ring it just re-created, its silence
      // afterwards means nothing.
      await page.addStyleTag({
        content: `[data-testid="command-palette"] textarea:focus-visible {
          box-shadow: 0 0 0 2px rgba(255,0,0,0.9) !important;
        }`,
      });
      await page.locator(ANCHORS.input).first().click();
      await page.waitForTimeout(250);
      const planted = await readBox(page);
      expect(
        boxOffenders(planted).length,
        "S2 PLANT: a 2px focus ring was applied to the composer and the " +
          "detector reported no box. The assertion below would then pass over " +
          "a surface with the original defect fully restored.",
      ).toBeGreaterThan(0);

      // ── the real state, on a clean page ──────────────────────────
      await boot(page);
      await openSurface(page);
      const real = await readBox(page);
      expect(
        boxOffenders(real),
        `S2: the composer is enclosed by ${boxOffenders(real).join(", ")}.\n` +
          `It reads as a FORM FIELD — type a query, get a list — which is the ` +
          `wrong promise on a surface that answers. NOTE: the usual cause is ` +
          `NOT a border in the component. It is index.css's global\n` +
          `    :where(… textarea …):focus-visible { box-shadow: var(--ring-focus) }\n` +
          `re-taking effect because CapsuleComposer's ` +
          `\`focus-visible:shadow-none\` was removed. The focus indicator is ` +
          `the 2px accent underline plus the brand caret, not a ring.`,
      ).toEqual([]);
    });

  test("the accent underline IS present, so focus is still visible", async ({ page }) => {
    await boot(page);
    await openSurface(page);
    // WCAG 2.4.7: removing the ring is only legitimate because something
    // else states focus. If this ever renders at zero width the ring
    // removal above becomes an accessibility regression, not a design
    // decision.
    const underline = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="capsule-underline"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { w: Math.round(r.width), h: Math.round(r.height), opacity: cs.opacity };
    });
    expect(underline, "S2: no `capsule-underline` on the surface").not.toBeNull();
    expect(
      underline!.w,
      "S2: the accent underline is 0px wide while the composer is focused. " +
        "The composer then has NO visible focus indicator at all, because the " +
        "browser's own was deliberately suppressed.",
    ).toBeGreaterThan(100);
    expect(Number(underline!.opacity)).toBeGreaterThan(0.5);
  });
});
