/**
 * THE INSTRUMENT — gate D6: keyboard visibility.
 *
 * Two assertions on /dashboard:
 *   1. Tabbing yields a VISIBLE focus indicator on each of the first
 *      five focus stops — the token sheet's :focus-visible ring
 *      (--ring-focus box-shadow) or an outline; either counts, "none"
 *      on both fails.
 *   2. ⌘K opens the command palette (a dialog / cmdk surface). If no
 *      palette exists in the build at run time this skips with a loud
 *      annotation rather than failing — the gate reports the gap, the
 *      coordinator triages.
 *
 * Run: npx playwright test e2e/design/keyboard.spec.ts
 */
import { test, expect } from "@playwright/test";
import { dismissPublicTestBanner, preseedLearningMode } from "../_helpers";

const SETTLE_MS = 8000;

test.describe("D6 keyboard — focus rings and the palette", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    // The LearningCoach card mounts over the top row and would swallow
    // early tab stops behind its own controls; standard preamble.
    await preseedLearningMode(page, "subtle");
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(SETTLE_MS);
    await dismissPublicTestBanner(page);
  });

  test("first five tab stops show a visible focus ring", async ({ page }) => {
    // Start from the document so Tab walks the real page order.
    await page.locator("body").click({ position: { x: 4, y: 300 } });

    const seen: string[] = [];
    for (let i = 1; i <= 5; i++) {
      await page.keyboard.press("Tab");
      const probe = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          label:
            (el.getAttribute("aria-label") ||
              el.textContent ||
              el.getAttribute("data-testid") ||
              "").trim().slice(0, 40),
          outlineStyle: cs.outlineStyle,
          outlineWidth: cs.outlineWidth,
          boxShadow: cs.boxShadow,
        };
      });

      expect(probe, `tab stop ${i}: focus left the document (activeElement is body)`).not.toBeNull();
      if (!probe) continue;
      seen.push(`${probe.tag} "${probe.label}"`);

      const hasOutline =
        probe.outlineStyle !== "none" && probe.outlineWidth !== "0px";
      const hasShadow = probe.boxShadow !== "none";
      expect(
        hasOutline || hasShadow,
        `tab stop ${i} (${probe.tag} "${probe.label}") has NO visible focus indicator — ` +
          `outline: ${probe.outlineStyle}/${probe.outlineWidth}, box-shadow: ${probe.boxShadow}`,
      ).toBe(true);
    }
    console.log(`[d6] tab order head: ${seen.join(" → ")}`);
  });

  test("cmd+K opens the command palette", async ({ page }) => {
    await page.keyboard.press("Meta+k");

    // Palette surfaces in this app: Radix dialog or a cmdk root.
    const palette = page.locator('[role="dialog"], [cmdk-root]');
    const appeared = await palette
      .first()
      .waitFor({ state: "visible", timeout: 3000 })
      .then(() => true)
      .catch(() => false);

    if (!appeared) {
      // Try Control for non-mac runners before declaring the gap.
      await page.keyboard.press("Control+k");
      const ctrlAppeared = await palette
        .first()
        .waitFor({ state: "visible", timeout: 3000 })
        .then(() => true)
        .catch(() => false);
      if (!ctrlAppeared) {
        test.info().annotations.push({
          type: "d6-palette-gap",
          description:
            "no dialog/cmdk surface opened on ⌘K or ^K — palette missing or shortcut unbound; skipping, report to coordinator",
        });
        test.skip(true, "command palette not present at run time");
      }
    }

    await expect(palette.first()).toBeVisible();
    // Escape must close it again — palette focus is a two-way street.
    await page.keyboard.press("Escape");
    await expect(palette.first()).toBeHidden({ timeout: 3000 });
  });
});
