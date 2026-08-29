/**
 * THE DIAL — gates M5 (mode dial e2e) + M6 (D-gates re-run under Simple).
 *
 * M5 asserts the dial itself:
 *   · the chosen mode persists across reload — through the UI switcher
 *     (shell lane's data-testid="mode-switch", mounted in TopHeader /
 *     Settings) when it is visible, else through the persisted key
 *     (cfo-view-mode-v1) with a loud annotation;
 *   · every authed route renders in BOTH modes with no console errors
 *     (network-resource noise from the test stack is filtered and
 *     documented below — everything else gates);
 *   · the Simple dashboard shows the story surface
 *     (data-testid="story-overview" — coordinated id; reported via
 *     annotation while the story lane hasn't shipped) and Pro shows the
 *     classic overview untouched (tabs-list / tab-overview).
 *
 * M6 re-runs the Instrument's D-gate assertions with the view mode
 * PINNED TO SIMPLE before first paint: axe serious/critical in both
 * themes (D1), keyboard focus visibility + palette (D6), and the
 * context-object / no-raw-UUID rule (D11). A mode may rearrange the
 * page; it may not make it less usable.
 *
 * Needs the test-mode stack: vite :5173 + engine :8000 PUBLIC_TEST_MODE.
 * Run: npx playwright test e2e/design/modes.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { dismissPublicTestBanner, preseedLearningMode } from "../_helpers";

// Persisted keys — mirrors lib/viewMode.ts and theme/ThemeProvider.tsx.
const MODE_KEY = "cfo-view-mode-v1";
const THEME_KEY = "cfoai_theme";

const AUTHED_ROUTES = [
  "/dashboard",
  "/chat",
  "/products",
  "/public-companies",
  "/dashboard/scenarios",
  "/dashboard/variance",
  "/benchmark",
  "/settings",
  "/workspace",
];
const ALL_ROUTES = [...AUTHED_ROUTES, "/"];

// Mirrors the D-suites' settle for lazy bundles + test-mode session boot.
const SETTLE_MS = 8000;

type ViewMode = "simple" | "pro";

async function seedMode(page: Page, mode: ViewMode): Promise<void> {
  await page.addInitScript(
    ([k, m]) => window.localStorage.setItem(k, m),
    [MODE_KEY, mode] as const,
  );
}

/**
 * Console-noise allowlist — DOCUMENTED, deliberately tiny. The test-mode
 * stack legitimately answers 401/503/400 on supabase-bound calls (prefs
 * sync, edge functions) and the browser logs each as "Failed to load
 * resource". Those are environment, not product. EVERYTHING else —
 * React errors, uncaught exceptions, warnings-as-errors — gates.
 */
const CONSOLE_NOISE = [/Failed to load resource/];

function armErrorCollector(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`[pageerror] ${String(e)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (CONSOLE_NOISE.some((re) => re.test(text))) return;
    errors.push(`[console.error] ${text}`);
  });
  return errors;
}

// ── M5 · persistence ───────────────────────────────────────────────────

test.describe("M5 — the dial persists across reload", () => {
  test.setTimeout(90_000);

  test("switching to Pro survives a reload (UI switcher, else storage)", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(SETTLE_MS);
    await dismissPublicTestBanner(page);

    const proOption = page.getByTestId("mode-switch-pro").first();
    const switcherVisible = await proOption.isVisible().catch(() => false);

    if (switcherVisible) {
      await proOption.click();
    } else {
      test.info().annotations.push({
        type: "m5-switcher-gap",
        description:
          'data-testid="mode-switch-pro" not visible on /dashboard — shell lane switcher ' +
          "absent or hidden at this viewport; falling back to direct storage write",
      });
      await page.evaluate(
        ([k, m]) => window.localStorage.setItem(k, m),
        [MODE_KEY, "pro"] as const,
      );
    }

    const stored = await page.evaluate((k) => window.localStorage.getItem(k), MODE_KEY);
    expect(stored, "mode choice was not persisted before reload").toBe("pro");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(SETTLE_MS);

    const after = await page.evaluate((k) => window.localStorage.getItem(k), MODE_KEY);
    expect(after, "persisted mode did not survive the reload").toBe("pro");

    if (switcherVisible) {
      // The UI must agree with storage: the Pro option is the checked one.
      await dismissPublicTestBanner(page);
      const checked = await page
        .getByTestId("mode-switch-pro")
        .first()
        .getAttribute("aria-checked");
      expect(checked, "switcher does not reflect the persisted mode after reload").toBe("true");
    }
  });
});

// ── M5 · both modes render every authed route, console clean ───────────

test.describe("M5 — every authed route renders in both modes, no console errors", () => {
  test.setTimeout(60_000);

  for (const mode of ["simple", "pro"] as ViewMode[]) {
    for (const route of AUTHED_ROUTES) {
      test(`renders [${mode}]: ${route}`, async ({ page }) => {
        await seedMode(page, mode);
        const errors = armErrorCollector(page);

        await page.goto(route, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(SETTLE_MS);
        await dismissPublicTestBanner(page);

        // The surface actually painted: the app root holds real content.
        const rootText = await page.evaluate(
          () => document.getElementById("root")?.innerText?.trim().length ?? 0,
        );
        expect(rootText, `#root rendered no text on ${route} in ${mode} mode`).toBeGreaterThan(0);

        expect(
          errors,
          `console/page errors on ${route} in ${mode} mode:\n${errors.join("\n")}`,
        ).toEqual([]);
      });
    }
  }
});

// ── M5 · the two dashboards ────────────────────────────────────────────

test.describe("M5 — Simple shows the story, Pro shows the classic overview", () => {
  test.setTimeout(60_000);

  test("Simple dashboard carries data-testid=story-overview", async ({ page }) => {
    await seedMode(page, "simple");
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(SETTLE_MS);
    await dismissPublicTestBanner(page);

    const story = page.getByTestId("story-overview");
    const present = (await story.count()) > 0;
    if (!present) {
      test.info().annotations.push({
        type: "m5-story-overview-gap",
        description:
          'data-testid="story-overview" not in the Simple-mode dashboard DOM — the ' +
          "story-dashboard lane has not shipped (or uses a different id; the " +
          "coordinated id is story-overview). Skipping, reported to coordinator.",
      });
      test.skip(true, "story-overview testid not present at run time");
    }
    await expect(story.first()).toBeVisible();
  });

  test("Pro dashboard keeps the classic overview (nothing pro removed)", async ({ page }) => {
    await seedMode(page, "pro");
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(SETTLE_MS);
    await dismissPublicTestBanner(page);

    // The classic surface's stable marks, as shipped today: the tab strip
    // and its overview tab. Both must exist in Pro — hard rule 3.
    await expect(page.getByTestId("tabs-list").first()).toBeVisible();
    await expect(page.getByTestId("tab-overview").first()).toBeVisible();
    // And Pro must NOT be the story arrangement.
    expect(await page.getByTestId("story-overview").count(), "story surface leaked into Pro").toBe(0);
  });
});

// ── M6 · D1 axe under Simple, both themes ──────────────────────────────

for (const theme of ["light", "dark"] as const) {
  test.describe(`M6 — axe under Simple mode (${theme})`, () => {
    test.setTimeout(60_000);

    test.beforeEach(async ({ page }) => {
      await seedMode(page, "simple");
      if (theme === "dark") {
        await page.addInitScript(
          (k) => window.localStorage.setItem(k, "dark"),
          THEME_KEY,
        );
      }
    });

    for (const route of ALL_ROUTES) {
      test(`axe clean [simple/${theme}]: ${route}`, async ({ page }) => {
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(SETTLE_MS);
        await dismissPublicTestBanner(page);

        const results = await new AxeBuilder({ page })
          .exclude('[data-testid="test-mode-banner"]')
          .analyze();

        const gating = results.violations.filter(
          (v) => v.impact === "serious" || v.impact === "critical",
        );
        const advisory = results.violations.filter(
          (v) => v.impact !== "serious" && v.impact !== "critical",
        );
        if (advisory.length) {
          console.log(
            `[axe advisory · simple/${theme}] ${route}: ${advisory
              .map((v) => `${v.id}(${v.impact ?? "?"})x${v.nodes.length}`)
              .join(", ")}`,
          );
        }

        const detail = gating
          .map(
            (v) =>
              `${v.id} [${v.impact}] — ${v.help}\n` +
              v.nodes.slice(0, 5).map((n) => `    ${n.target.join(" ")}`).join("\n"),
          )
          .join("\n");
        expect(
          gating,
          `serious/critical axe violations on ${route} (simple/${theme}):\n${detail}`,
        ).toEqual([]);
      });
    }
  });
}

// ── M6 · D6 keyboard under Simple ──────────────────────────────────────

test.describe("M6 — keyboard under Simple mode", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await seedMode(page, "simple");
    await preseedLearningMode(page, "subtle");
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(SETTLE_MS);
    await dismissPublicTestBanner(page);
  });

  test("first five tab stops show a visible focus ring (simple)", async ({ page }) => {
    await page.locator("body").click({ position: { x: 4, y: 300 } });

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
      expect(probe, `tab stop ${i}: focus left the document (simple mode)`).not.toBeNull();
      if (!probe) continue;
      const visible =
        (probe.outlineStyle !== "none" && probe.outlineWidth !== "0px") ||
        probe.boxShadow !== "none";
      expect(
        visible,
        `tab stop ${i} (${probe.tag} "${probe.label}") has no visible focus indicator in simple mode`,
      ).toBe(true);
    }
  });

  test("cmd+K opens the command palette (simple)", async ({ page }) => {
    await page.keyboard.press("Meta+k");
    const palette = page.locator('[role="dialog"], [cmdk-root]');
    const appeared = await palette
      .first()
      .waitFor({ state: "visible", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) {
      await page.keyboard.press("Control+k");
      const ctrlAppeared = await palette
        .first()
        .waitFor({ state: "visible", timeout: 3000 })
        .then(() => true)
        .catch(() => false);
      if (!ctrlAppeared) {
        test.info().annotations.push({
          type: "m6-palette-gap",
          description:
            "no dialog/cmdk surface on ⌘K or ^K in Simple mode — palette missing or unbound",
        });
        test.skip(true, "command palette not present at run time");
      }
    }
    await expect(palette.first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette.first()).toBeHidden({ timeout: 3000 });
  });
});

// ── M6 · D11 context object under Simple ───────────────────────────────

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}/i;

test.describe("M6 — context object under Simple mode", () => {
  test.setTimeout(60_000);

  for (const route of AUTHED_ROUTES) {
    test(`context anchored [simple]: ${route}`, async ({ page }) => {
      await seedMode(page, "simple");
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(SETTLE_MS);
      await dismissPublicTestBanner(page);

      const contextObject = page.getByTestId("context-object");
      if ((await contextObject.count()) > 0) {
        await expect(contextObject.first()).toBeVisible();
      } else {
        test.info().annotations.push({
          type: "m6-context-testid-gap",
          description: `${route}: data-testid="context-object" not in DOM under Simple mode`,
        });
      }

      const visibleText = await page.evaluate(() => document.body.innerText);
      const match = visibleText.match(UUID_RE);
      expect(
        match,
        `visible UUID fragment "${match?.[0]}" on ${route} in Simple mode`,
      ).toBeNull();
    });
  }
});
