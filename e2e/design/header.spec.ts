/**
 * THE PLACEMENT LAW — gates H1–H6 (Part D of the header consolidation).
 *
 * Permanent anti-regrowth suite for the command-deck header. The law:
 * a header element must be needed on EVERY screen, EVERY session — and
 * the hard budget is ≤6 interactive elements as direct header children
 * at 1440px, enforced here, not by taste.
 *
 *   H1 — budget gate: ≤6 top-level interactive elements in <header> @1440
 *   H2 — no-duplicate law (live half): no header-level action resolves to
 *        a SHELL_NAV_ALL destination (brand→/dashboard idiom exempt; the
 *        full destination law lives in headerLaw.test.tsx + check_header_law.mjs)
 *   H4 — one ⌘K hint: the command bar's text (excluding its <kbd>) carries
 *        no shortcut string; exactly one visible <kbd> inside the header
 *   H5 — two-interaction reachability from /dashboard: mode / currency /
 *        theme / Ask CFO AI / period switch, each ≤2 interactions; plus
 *        mode & currency persist across reload via their new homes
 *   H6 — a11y: Escape closes header popovers, visible focus rings,
 *        trust chip label-in-name, coach marks (if any) dismiss on Escape
 *        and never re-show after dismissal
 *   H3 — trust parity (live half): when a canonical period serves a trust
 *        chip, its receipt carries the locked field rows. The tone-map
 *        snapshot-lock (all six bands) is the vitest half — mocked bands
 *        can be forced there; the live stack only shows one.
 *
 * "Top-level interactive" (H1) is defined ONCE, in countHeaderInteractive
 * below, and mirrored word-for-word in design_review/header/GATES.md:
 * an element matching the interactive selector set, visible (non-zero
 * rect, not display:none/visibility:hidden), not inside an open overlay
 * (dialog / menu / radix popper portal content), and with NO ancestor
 * inside the header that also matches the selector set. Composite widgets
 * (role="radiogroup" — the Simple|Pro dial) match the set themselves and
 * therefore count as ONE; their inner radios are swallowed by the
 * ancestor rule. Deliberately NOT depth-limited: one extra wrapper <div>
 * must never change the count.
 *
 * Needs the test-mode stack: vite :5173 + engine :8000 PUBLIC_TEST_MODE.
 * Run: npx playwright test e2e/design/header.spec.ts
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { dismissPublicTestBanner, preseedLearningMode } from "../_helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// H1 is specified at 1440 — override the project's 1280 default.
test.use({ viewport: { width: 1440, height: 900 } });

// Every gate needs the AUTHED test-mode header; the config's "prod"
// project runs signed-out against cfo-ai.io and would fail on
// environment, not product. `npm run header:e2e` pins --project=chromium;
// this guard keeps a bare `npx playwright test` honest too.
test.skip(
  ({ baseURL }) => !/localhost|127\.0\.0\.1/.test(baseURL ?? ""),
  "header gates need the authed test-mode stack (vite :5173 + engine :8000 PUBLIC_TEST_MODE)",
);

const SETTLE_MS = 8000;
// OWNER AMENDMENT 2026-08-30: the Capsule consolidation landed at 4
// (brand · capsule · bell · avatar). The owner then asked for the
// Simple|Pro dial back in the header — "leave that there, it was a
// nice touch" — making the sanctioned set FIVE. The budget is an
// anti-regrowth law, so it is tightened to the new exact number
// rather than left slack at the old 6.
const HEADER_BUDGET = 5;

// ── the one H1 definition ──────────────────────────────────────────────

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  '[role="radiogroup"]',
  '[role="combobox"]',
].join(", ");

interface HeaderCensus {
  count: number;
  items: Array<{ tag: string; role: string | null; testid: string | null; aria: string | null; text: string }>;
}

/** The app-shell header: the fixed bar that owns the account trigger. */
function appHeader(page: Page): Locator {
  return page
    .locator("header")
    .filter({ has: page.locator('[data-testid="account-menu-trigger"]') })
    .first();
}

async function countHeaderInteractive(page: Page): Promise<HeaderCensus> {
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
    const all = [...headerEl.querySelectorAll(sel)].filter(
      (el) => visible(el) && !inOverlay(el),
    );
    // A SEGMENTED CONTROL IS ONE ELEMENT. The Simple|Pro dial renders a
    // role="radiogroup" of two radio buttons; the PLACEMENT LAW counts
    // distinct controls a user must scan, not DOM nodes, so a radiogroup
    // collapses to its container. Any control nested inside another
    // counted control is likewise not double-counted.
    const topLevel = all.filter((el) => {
      let p = el.parentElement;
      while (p && p !== headerEl) {
        if (p.matches(sel)) return false;
        if (p.getAttribute("role") === "radiogroup") return false;
        p = p.parentElement;
      }
      return true;
    });
    // ...and the radiogroup itself counts once.
    const groups = [...headerEl.querySelectorAll('[role="radiogroup"]')].filter(
      (el) => visible(el) && !inOverlay(el),
    );
    topLevel.push(...groups);
    return {
      count: topLevel.length,
      items: topLevel.map((el) => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        testid: el.getAttribute("data-testid"),
        aria: el.getAttribute("aria-label"),
        text: (el.textContent ?? "").trim().slice(0, 40),
      })),
    };
  }, INTERACTIVE_SELECTOR);
}

/** SHELL_NAV_ALL destinations, read from the source of truth TEXT (the
 *  sidebar module has heavy runtime imports — parsing the literal keeps
 *  this spec side-effect free while still tracking the real list). */
function shellNavDestinations(): string[] {
  const src = readFileSync(
    path.join(REPO_ROOT, "frontend/components/cfo/Sidebar.tsx"),
    "utf-8",
  );
  const block = src.match(/SHELL_NAV_ALL[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!block) throw new Error("H2: SHELL_NAV_ALL literal not found in Sidebar.tsx");
  const tos = [...block[1].matchAll(/to:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (tos.length < 5) throw new Error(`H2: suspiciously few nav destinations parsed (${tos.length})`);
  return tos;
}

async function boot(page: Page, route = "/dashboard"): Promise<void> {
  await preseedLearningMode(page);
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS);
  await dismissPublicTestBanner(page);
}

// ── H1 · the budget gate ───────────────────────────────────────────────

test.describe("H1 — header budget: exactly the sanctioned control set @1440", () => {
  test.setTimeout(90_000);

  for (const route of ["/dashboard", "/chat"]) {
    test(`budget holds on ${route}`, async ({ page }) => {
      await boot(page, route);
      const census = await countHeaderInteractive(page);
      expect(
        census.count,
        `PLACEMENT LAW: header carries ${census.count} top-level interactive elements ` +
          `(budget ${HEADER_BUDGET}). Inventory:\n` +
          census.items
            .map((i) => `  · <${i.tag}> testid=${i.testid} role=${i.role} aria=${i.aria} "${i.text}"`)
            .join("\n"),
      ).toBeLessThanOrEqual(HEADER_BUDGET);
    });
  }
});

// ── H2 · the no-duplicate law (live half) ──────────────────────────────

test.describe("H2 — no header action duplicates a sidebar destination", () => {
  test.setTimeout(90_000);

  test("no Ask-CFO-AI control at header level (the bug class that started this)", async ({ page }) => {
    await boot(page);
    const header = appHeader(page);
    // The sidebar's promoted accent Ask row + ⌘J is the ONE home. A header
    // Ask control — labeled or icon-only — is the duplicate the law bans.
    await expect(
      header.locator('[data-testid="topheader-ask-cfo-ai"]'),
      "H2: an Ask CFO AI control is back at header level — its home is the sidebar accent row (+⌘J, and the palette).",
    ).toHaveCount(0);
    // The sidebar home must actually exist, or the removal above would
    // have orphaned the product's headline capability.
    await expect(
      page.locator('[data-testid="sidebar-chat"]').first(),
      "H2 precondition: the sidebar Ask CFO AI row is missing — the header removal is only safe with the sidebar home live.",
    ).toBeVisible();
  });

  test("no header-level link resolves to a SHELL_NAV_ALL destination", async ({ page }) => {
    await boot(page);
    const navDests = new Set(shellNavDestinations());
    const header = appHeader(page);
    const hrefs = await header.evaluate((el) =>
      [...el.querySelectorAll("a[href]")].map((a) => new URL((a as HTMLAnchorElement).href).pathname),
    );
    // Brand→/dashboard is the one grandfathered idiom (logo-home); it is
    // rendered as a <button>, so any <a> duplicate is a violation outright.
    const dupes = hrefs.filter((h) => navDests.has(h));
    expect(
      dupes,
      `H2: header anchors duplicate sidebar destinations: ${dupes.join(", ")}`,
    ).toEqual([]);
  });
});

// ── H4 · one ⌘K hint ───────────────────────────────────────────────────

test.describe("H4 — exactly one shortcut hint in the header", () => {
  test.setTimeout(90_000);

  test("command-bar text carries no shortcut string; exactly one <kbd> renders", async ({ page }) => {
    await boot(page);
    const header = appHeader(page);
    const bar = header.locator('[data-testid="header-command-bar"]');
    await expect(bar, "header command bar missing").toBeVisible();

    const textExKbd = await bar.evaluate((el) => {
      const c = el.cloneNode(true) as HTMLElement;
      c.querySelectorAll("kbd").forEach((k) => k.remove());
      return (c.textContent ?? "").trim();
    });
    expect(
      textExKbd,
      `H4: the command bar's text ("${textExKbd}") repeats the shortcut — the <kbd> is the ONE hint.`,
    ).not.toMatch(/⌘|ctrl|cmd|K\b/i);

    const kbdCount = await header.evaluate((el) => {
      const visible = (k: Element) => {
        const r = k.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      return [...el.querySelectorAll("kbd")].filter(visible).length;
    });
    expect(kbdCount, "H4: the header must render exactly one <kbd> (the ⌘K badge)").toBe(1);
  });
});

// ── H5 · two-interaction reachability + persistence ────────────────────

test.describe("H5 — every relocated control is ≤2 interactions from /dashboard", () => {
  test.setTimeout(120_000);

  test("mode switch: 1 interaction, persists across reload", async ({ page }) => {
    await boot(page);
    const pro = page.getByTestId("mode-switch-pro").first();
    await expect(pro, "H5: mode switch not directly visible").toBeVisible(); // interaction 1 is the click itself
    await pro.click();
    await expect(pro).toHaveAttribute("aria-checked", "true");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(SETTLE_MS);
    await dismissPublicTestBanner(page);
    await expect(
      page.getByTestId("mode-switch-pro").first(),
      "H5 regression: mode did not persist across reload",
    ).toHaveAttribute("aria-checked", "true");
    // restore
    await page.getByTestId("mode-switch-simple").first().click();
  });

  test("currency: 2 interactions, persists across reload", async ({ page }) => {
    await boot(page);
    const trigger = page.getByTestId("currency-menu-trigger");
    await trigger.click(); // 1
    const eur = page.getByTestId("currency-menu-eur");
    await expect(eur, "H5: currency option not reachable after opening the menu").toBeVisible();
    await eur.click(); // 2
    await expect(trigger).toContainText("EUR");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(SETTLE_MS);
    await dismissPublicTestBanner(page);
    await expect(
      page.getByTestId("currency-menu-trigger"),
      "H5 regression: currency did not persist across reload",
    ).toContainText("EUR");
    // restore
    await page.getByTestId("currency-menu-trigger").click();
    await page.getByTestId("currency-menu-ron").click();
  });

  test("theme: 1 interaction via the rail footer toggle", async ({ page }) => {
    await boot(page);
    const toggle = page.getByTestId("sidebar-theme-toggle");
    await expect(toggle, "H5: theme toggle not directly visible in the rail footer").toBeVisible();
    const before = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    await toggle.click(); // 1
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.classList.contains("dark")), {
        message: "H5: theme toggle did not flip the document theme",
      })
      .toBe(!before);
    await toggle.click(); // restore
  });

  test("Ask CFO AI: 1 interaction via the sidebar accent row", async ({ page }) => {
    await boot(page);
    const ask = page.locator('[data-testid="sidebar-chat"]').first();
    await expect(ask, "H5: sidebar Ask CFO AI row not visible").toBeVisible();
    await ask.click(); // 1
    await expect(page).toHaveURL(/\/chat/);
  });

  test("period switch: 2 interactions via the ContextObject", async ({ page }) => {
    await boot(page);
    await page.getByTestId("context-object").click(); // 1
    const popover = page.getByTestId("context-object-popover");
    await expect(popover, "H5: ContextObject popover did not open").toBeVisible();
    const rows = popover.locator("button");
    const n = await rows.count();
    expect(n, "H5: ContextObject popover offers no actionable rows").toBeGreaterThan(0);
    // Interaction 2 is clicking a row; visible+enabled proves actionable.
    await expect(rows.first()).toBeEnabled();
  });
});

// ── H6 · a11y: keyboard, focus, names, coach marks ─────────────────────

test.describe("H6 — header a11y", () => {
  test.setTimeout(120_000);

  test("Escape closes each header popover and returns focus", async ({ page }) => {
    await boot(page);
    for (const [trigger, content] of [
      ["currency-menu-trigger", null],
      ["context-object", "context-object-popover"],
      ["account-menu-trigger", null],
    ] as const) {
      const t = page.getByTestId(trigger);
      await t.click();
      const overlay = content
        ? page.getByTestId(content)
        : page.locator('[data-radix-popper-content-wrapper], [role="menu"], [role="dialog"]').last();
      await expect(overlay, `H6: ${trigger} opened nothing`).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(overlay, `H6: Escape did not close ${trigger}'s popover`).toBeHidden();
      const focusBack = await page.evaluate(
        (id) => document.activeElement?.getAttribute("data-testid") === id,
        trigger,
      );
      expect(focusBack, `H6: focus did not return to ${trigger} after Escape`).toBe(true);
    }
  });

  test("keyboard focus is visible on header controls", async ({ page }) => {
    await boot(page);
    const header = appHeader(page);
    // Walk focus into the header and assert the focused control paints a
    // ring (box-shadow) or outline — THE INSTRUMENT uses ring-2.
    await header.evaluate((el) => {
      const first = el.querySelector<HTMLElement>("button, a[href], [role='radiogroup'] button");
      first?.focus();
    });
    for (let i = 0; i < 8; i++) {
      const probe = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || !el.closest("header")) return null;
        const cs = getComputedStyle(el);
        return {
          testid: el.getAttribute("data-testid") ?? el.tagName,
          ringed:
            (cs.boxShadow && cs.boxShadow !== "none") ||
            (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth || "0") > 0),
        };
      });
      if (!probe) break; // focus left the header — walk done
      expect(probe.ringed, `H6: focused header control ${probe.testid} paints no visible ring`).toBe(true);
      await page.keyboard.press("Tab");
    }
  });

  test("trust chip: accessible name carries the full trust sentence (label-in-name)", async ({ page }) => {
    await boot(page);
    const chip = page.getByTestId("trust-chip");
    if ((await chip.count()) === 0) {
      test
        .info()
        .annotations.push({
          type: "h6-trust-skipped",
          description:
            "No canonical envelope on the booted period — trust chip absent by design (no fake trust). " +
            "The tone-map + receipt locks still run in headerLaw.test.tsx with mocked bands.",
        });
      return;
    }
    const visibleLabel = (await chip.textContent())?.trim() ?? "";
    const accName =
      (await chip.getAttribute("aria-label")) ?? (await chip.evaluate((el) => el.textContent?.trim() ?? ""));
    expect(
      accName.toLowerCase(),
      `H6: trust control's accessible name ("${accName}") must contain its visible trust sentence ("${visibleLabel}")`,
    ).toContain(visibleLabel.toLowerCase().split("·")[0].trim());
  });

  test("coach marks (if any) dismiss on Escape and never re-show", async ({ page }) => {
    await boot(page);
    const marks = page.locator('[data-coachmark], [data-testid*="coach-mark"], [data-testid^="coachmark"]');
    if ((await marks.count()) === 0) {
      test.info().annotations.push({
        type: "h6-coachmarks-absent",
        description: "No coach marks rendered on /dashboard — gate passes vacuously.",
      });
      return;
    }
    await page.keyboard.press("Escape");
    await expect(marks.first(), "H6: coach mark did not dismiss on Escape").toBeHidden();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(SETTLE_MS);
    await dismissPublicTestBanner(page);
    await expect(
      page.locator('[data-coachmark], [data-testid*="coach-mark"], [data-testid^="coachmark"]'),
      "H6: a dismissed coach mark re-showed after reload",
    ).toHaveCount(0);
  });
});

// ── H3 · trust parity (live half — receipt field rows) ─────────────────

test.describe("H3 — trust receipt parity (live)", () => {
  test.setTimeout(90_000);

  test("receipt sheet carries the locked field rows", async ({ page }) => {
    await boot(page);
    const chip = page.getByTestId("trust-chip");
    if ((await chip.count()) === 0) {
      test.info().annotations.push({
        type: "h3-live-skipped",
        description:
          "No canonical envelope on the booted period — receipt unreachable live. " +
          "Authoritative field-parity lock runs in headerLaw.test.tsx (mocked envelope).",
      });
      return;
    }
    await chip.click();
    const receipt = page.getByTestId("trust-receipt");
    await expect(receipt, "H3: receipt sheet did not open").toBeVisible();
    // Status sentence + method are unconditional; Difference always renders.
    for (const label of ["Status", "Difference"]) {
      await expect(
        receipt.getByText(label, { exact: false }).first(),
        `H3: receipt lost its "${label}" row`,
      ).toBeVisible();
    }
    await page.keyboard.press("Escape");
    await expect(receipt).toBeHidden();
  });
});
