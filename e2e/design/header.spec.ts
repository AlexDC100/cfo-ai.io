/**
 * THE PLACEMENT LAW — gates H0–H7 (Part D, re-asserted in Part E).
 *
 * Permanent anti-regrowth suite for the command-deck header. The law:
 * a header element must be needed on EVERY screen, EVERY session — and
 * the budget is an EXACT sanctioned set, not a ceiling:
 *
 *     ≥1024   brand · CAPSULE · notifications · avatar          = 4
 *     <1024   nav toggle · CAPSULE · avatar                     = 3
 *
 * The bell folds into the avatar below `lg` with its badge mirrored on
 * the avatar; the brand mark yields the left slot to the nav toggle
 * there (two left-hand "go somewhere" controls on the narrowest screen
 * was the duplication). Simple|Pro left the bar entirely in Part E.
 *
 *   H0 — GATE SELF-AUDIT. Every selector this spec depends on resolves
 *        to a real element; the census selector list has no repeats.
 *        A gate aimed at a removed element passes vacuously — a false
 *        green of the same class as a false red.
 *   H1 — budget gate: the census equals the sanctioned set EXACTLY, by
 *        identity, at 1440 and at 1023 (a bare count would let brand and
 *        bell swap silently). H1b bounds composite interiors.
 *   H2 — no-duplicate law (live half): no header control resolves to a
 *        SHELL_NAV_ALL destination, and none of them is an Ask CFO AI
 *        control — checked BEHAVIOURALLY (name + destination), not by a
 *        testid that can be renamed around.
 *   H4 — one ⌘K hint: the command bar's text (excluding its <kbd>) carries
 *        no shortcut string; exactly one visible <kbd> inside the header
 *   H5 — two-interaction reachability from /dashboard: mode / currency /
 *        theme / Ask CFO AI / period switch / notifications, each ≤2
 *        interactions; mode & currency persist across reload
 *   H6 — a11y: Escape closes header popovers, visible focus rings,
 *        trust chip label-in-name, the relocation coach mark dismisses on
 *        Escape and never re-shows
 *   H3 — trust parity (live half): when a canonical period serves a trust
 *        chip, its receipt carries the locked field rows. The tone-map
 *        snapshot-lock (all six bands) is the vitest half — mocked bands
 *        can be forced there; the live stack only shows one.
 *   H7 — (vitest only) the dial is out of the bar and still reachable.
 *
 * The census — "what counts as a header control" — is defined ONCE, in
 * scripts/check_header_law.mjs, and imported by this spec AND by
 * frontend/components/cfo/__tests__/headerLaw.test.tsx. It is never
 * restated in prose, because the last time it was, a collapse-fix
 * appended [role="radiogroup"] a second time and the census reported 6
 * for a 5-control header.
 *
 * Needs the test-mode stack: vite :5173 + engine :8000 PUBLIC_TEST_MODE.
 * Run: npx playwright test e2e/design/header.spec.ts --project=chromium
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  dismissPublicTestBanner,
  pinOrgPrefs,
  preseedLearningMode,
  seedViewMode,
} from "../_helpers";
import {
  INTERACTIVE_SELECTORS,
  COMPOSITE_SELECTORS,
  MAX_COMPOSITE_CHILDREN,
  headerCensus,
  formatCensus,
} from "../../scripts/check_header_law.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// H1's headline case is specified at 1440 — override the project default.
test.use({ viewport: { width: 1440, height: 900 } });

// Every gate needs the AUTHED test-mode header; the config's "prod"
// project runs signed-out against cfo-ai.io and would fail on
// environment, not product. This guard keeps a bare `npx playwright
// test` honest too.
test.skip(
  ({ baseURL }) => !/localhost|127\.0\.0\.1/.test(baseURL ?? ""),
  "header gates need the authed test-mode stack (vite :5173 + engine :8000 PUBLIC_TEST_MODE)",
);

const SETTLE_MS = 8000;
// Radix's dismissable layer eats the next click for a moment after a
// menu closes — measured on this stack, not guessed.
const RADIX_SETTLE_MS = 2500;

// ── the sanctioned sets (Part E, owner directive 2026-08-30) ───────────
//
// Identity, not arithmetic. "4 controls" would stay green if the bell
// replaced the brand mark; this will not.

const SANCTIONED_DESKTOP = [
  "header-brand",
  "header-capsule",
  "notifications-button",
  "account-menu-trigger",
];
const SANCTIONED_COMPACT = ["header-nav-toggle", "header-capsule", "account-menu-trigger"];

// ── selector classification (read by scripts/check_header_law.mjs, L6) ─
//
// Every data-testid this spec touches must appear in exactly one list.
// That is what makes a deleted element a RED gate instead of a silent
// vacuous pass.

/** Must resolve in the live app after the "open everything" sweep (H0). */
const REQUIRED_TESTIDS = [
  "header-brand",
  "header-nav-toggle",
  "header-capsule",
  "header-command-bar",
  "notifications-button",
  "account-menu-trigger",
  "account-menu-notifications",
  "notifications-row",
  "notifications-dialog",
  "mode-switch",
  "mode-switch-simple",
  "mode-switch-pro",
  "currency-toggle-eur",
  "currency-toggle-ron",
  "sidebar-theme-toggle",
  "sidebar-chat",
  "command-palette",
];

/** Exists in source, but legitimately absent from a given live boot —
 *  the spec says so in an annotation instead of passing silently. */
const CONDITIONAL_TESTIDS = [
  "trust-chip",
  "trust-receipt",
  "header-coach-mark",
  "header-coach-mark-dismiss",
];

/** Must NOT appear in the header. Kept as a cheap anti-regrowth trip;
 *  the load-bearing check is the BEHAVIOURAL one in H2, because a
 *  renamed testid would walk straight past this list. */
const BANNED_TESTIDS = ["topheader-ask-cfo-ai", "currency-menu-trigger"];

// ── plumbing ───────────────────────────────────────────────────────────

interface CensusItem {
  tag: string;
  role: string | null;
  testid: string | null;
  aria: string | null;
  text: string;
}
interface HeaderCensus {
  count: number;
  items: CensusItem[];
  composites: Array<CensusItem & { children: CensusItem[] }>;
}

/** The app-shell header: the fixed bar that owns the account trigger. */
function appHeader(page: Page): Locator {
  return page
    .locator("header")
    .filter({ has: page.locator('[data-testid="account-menu-trigger"]') })
    .first();
}

async function censusOf(page: Page): Promise<HeaderCensus> {
  const header = appHeader(page);
  await expect(header, "app-shell header not rendered").toBeVisible();
  return header.evaluate(headerCensus, {
    selectors: INTERACTIVE_SELECTORS,
    composites: COMPOSITE_SELECTORS,
  }) as Promise<HeaderCensus>;
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

/** Attach the inventory to the report on EVERY run, pass or fail — the
 *  census is evidence, not just an assertion input. */
async function reportCensus(label: string, census: HeaderCensus): Promise<void> {
  const body =
    `${label} — ${census.count} top-level interactive element(s)\n` +
    formatCensus(census) +
    "\n" +
    census.composites
      .map(
        (c) =>
          `  composite ${c.testid ?? c.role}: ${c.children.length} interactive descendant(s) — ` +
          c.children.map((k) => k.testid ?? k.tag).join(", "),
      )
      .join("\n");
  // eslint-disable-next-line no-console
  console.log("\n" + body);
  await test.info().attach(`census-${label}`, { body, contentType: "text/plain" });
}

// ── H0 · the gate audits itself ────────────────────────────────────────

test.describe("H0 — gate self-audit (no double counting, no stale selectors)", () => {
  test.setTimeout(120_000);

  test("the census selector list has no repeats and no orphan composite", () => {
    const repeats = INTERACTIVE_SELECTORS.filter(
      (s: string, i: number) => INTERACTIVE_SELECTORS.indexOf(s) !== i,
    );
    expect(
      repeats,
      "H0: a repeated selector double-counts its element — the exact bug that once reported 6 for a " +
        "5-control header. A gate reporting a violation that does not exist is as bad as a false green.",
    ).toEqual([]);
    const orphans = COMPOSITE_SELECTORS.filter((s: string) => !INTERACTIVE_SELECTORS.includes(s));
    expect(
      orphans,
      "H0: a composite must be matched by the ONE census pass, never appended to the result afterwards",
    ).toEqual([]);
  });

  test("every REQUIRED selector resolves live (no gate aimed at a deleted element)", async ({ page }) => {
    await boot(page);

    // Each id is probed WHERE IT LIVES. Radix unmounts popover content,
    // so probing a menu-scoped id with the menu shut is exactly the
    // false-negative this gate is supposed to catch in others.
    const found = new Set<string>();
    const sweep = async (ids: string[]) => {
      for (const id of ids) {
        if ((await page.locator(`[data-testid="${id}"]`).count()) > 0) found.add(id);
      }
    };

    // 1 · the bar and the rail, at rest.
    await sweep([
      "header-brand",
      "header-capsule",
      "header-command-bar",
      "notifications-button",
      "account-menu-trigger",
      "sidebar-theme-toggle",
      "sidebar-chat",
    ]);

    // 2 · inside the avatar menu (the dial's + currency's home). The
    //     notifications rows render here too, `lg:hidden` — present in
    //     the tree at 1440, painted only below lg.
    await page.getByTestId("account-menu-trigger").click();
    await expect(page.getByTestId("mode-switch").first()).toBeVisible();
    await sweep([
      "mode-switch",
      "mode-switch-simple",
      "mode-switch-pro",
      "currency-toggle-eur",
      "currency-toggle-ron",
      "account-menu-notifications",
      "notifications-row",
    ]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("mode-switch")).toHaveCount(0);
    await page.waitForTimeout(RADIX_SETTLE_MS);

    // 3 · inside the palette.
    await page.getByTestId("header-command-bar").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await sweep(["command-palette"]);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(RADIX_SETTLE_MS);

    // 4 · the compact-width surface.
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForTimeout(500);
    await sweep(["header-nav-toggle"]);
    await page.getByTestId("account-menu-trigger").click();
    const row = page.getByTestId("notifications-row");
    if ((await row.count()) > 0) {
      await row.click();
      await sweep(["notifications-dialog"]);
      await page.keyboard.press("Escape");
    }

    const missing = REQUIRED_TESTIDS.filter((id) => !found.has(id));
    expect(
      missing,
      "H0: these REQUIRED_TESTIDS no longer resolve — the gate that uses them is aimed at a removed " +
        "element and would pass vacuously (or fail for the wrong reason). Fix the selector, not the DOM.",
    ).toEqual([]);
  });
});

// ── H1 · the budget gate ───────────────────────────────────────────────

test.describe("H1 — header budget: EXACTLY the sanctioned control set", () => {
  test.setTimeout(120_000);

  for (const route of ["/dashboard", "/chat"]) {
    test(`desktop set holds on ${route} @1440`, async ({ page }) => {
      await boot(page, route);
      const census = await censusOf(page);
      await reportCensus(`1440${route}`, census);
      expect(
        census.items.map((i) => i.testid),
        `PLACEMENT LAW: the header at 1440 must be EXACTLY ${SANCTIONED_DESKTOP.join(" · ")}. ` +
          `Counted ${census.count}:\n${formatCensus(census)}`,
      ).toEqual(SANCTIONED_DESKTOP);
    });
  }

  test("compact set holds on /dashboard @1023 (bell folded into the avatar)", async ({ page }) => {
    await page.setViewportSize({ width: 1023, height: 900 });
    await boot(page);
    const census = await censusOf(page);
    await reportCensus("1023/dashboard", census);
    expect(
      census.items.map((i) => i.testid),
      `PLACEMENT LAW: the header below 1024 must be EXACTLY ${SANCTIONED_COMPACT.join(" · ")}. ` +
        `Counted ${census.count}:\n${formatCensus(census)}`,
    ).toEqual(SANCTIONED_COMPACT);

    // The fold is only legitimate if the bell's content actually landed
    // in the avatar — otherwise this is a deletion wearing a budget.
    await page.getByTestId("account-menu-trigger").click();
    await expect(
      page.getByTestId("notifications-row"),
      "H1: the bell left the compact header but its row is not in the avatar menu — that is a removal, not a fold",
    ).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("H1b — a composite may not become a hiding place", async ({ page }) => {
    await boot(page);
    const census = await censusOf(page);
    await reportCensus("1440/dashboard-composites", census);
    for (const c of census.composites) {
      expect(
        c.children.length,
        `H1b: composite "${c.testid ?? c.role}" holds ${c.children.length} interactive descendants ` +
          `(max ${MAX_COMPOSITE_CHILDREN}). Collapsing a composite to one control is only honest while ` +
          "it stays small — otherwise the census hides a growing cluster.",
      ).toBeLessThanOrEqual(MAX_COMPOSITE_CHILDREN);
    }
  });

  test("the Simple|Pro dial is not in the bar at any width", async ({ page }) => {
    await boot(page);
    const header = appHeader(page);
    for (const width of [1440, 1023, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      expect(
        await header.locator('[data-testid="mode-switch"]').count(),
        `H1: the Simple|Pro dial is back in the header at ${width}px — its homes are the avatar menu, ` +
          "Settings > Appearance and the ⌘K palette action (MODE_PALETTE_ACTION in ModeSwitch.tsx).",
      ).toBe(0);
    }
  });
});

// ── H2 · the no-duplicate law (live half) ──────────────────────────────

test.describe("H2 — no header action duplicates a sidebar destination", () => {
  test.setTimeout(90_000);

  test("no Ask-CFO-AI control at header level — checked by behaviour, not by testid", async ({ page }) => {
    await boot(page);
    const header = appHeader(page);

    // (a) the historical testid, kept as a cheap trip.
    for (const id of BANNED_TESTIDS) {
      await expect(
        header.locator(`[data-testid="${id}"]`),
        `H2: a banned control (${id}) is back at header level.`,
      ).toHaveCount(0);
    }

    // (b) the check that cannot be renamed around: NOTHING in the header
    //     announces itself as Ask/chat. (a) alone is a false green the
    //     moment someone ships the button under a new testid.
    const named = await header.evaluate((el) =>
      [...el.querySelectorAll("button, a[href], [role='button']")]
        .map((c) => `${c.getAttribute("aria-label") ?? ""} ${c.textContent ?? ""}`.trim())
        .filter((s) => /\bask\b|cfo ai|\bchat\b|întreab/i.test(s)),
    );
    expect(
      named,
      "H2: a header control announces itself as Ask CFO AI — its homes are the sidebar accent row " +
        "(⌘J) and the palette. This is the bug class the law exists for.",
    ).toEqual([]);

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
  test.setTimeout(150_000);

  test("mode switch: 2 interactions via the avatar, persists across reload", async ({ page }) => {
    // The reload half of this test is only meaningful if the shared
    // identity's bag cannot re-answer the question: `view_mode` is a
    // synced pref, and an adopted value would revert the click this
    // test just made. Absent = the app's own default, adopting nothing.
    await seedViewMode(page, null);
    await boot(page);
    await page.getByTestId("account-menu-trigger").click(); // 1
    const pro = page.getByTestId("mode-switch-pro").first();
    await expect(pro, "H5: the dial is not reachable from the avatar menu").toBeVisible();
    await pro.click(); // 2
    await expect(pro).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(SETTLE_MS);
    await dismissPublicTestBanner(page);
    await page.getByTestId("account-menu-trigger").click();
    await expect(
      page.getByTestId("mode-switch-pro").first(),
      "H5 regression: mode did not persist across reload",
    ).toHaveAttribute("aria-checked", "true");
    // restore
    await page.getByTestId("mode-switch-simple").first().click();
    await page.keyboard.press("Escape");
  });

  test("currency: 2 interactions via the avatar, persists across reload", async ({ page }) => {
    // Display currency is a COMPANY pref on the one shared test org, and
    // this test asserts persistence across a reload — the exact sequence
    // the shared bag breaks. The click writes localStorage and calls
    // `setPref("org", …)`; that RPC never confirms in PUBLIC_TEST_MODE, so
    // the value survives only because a page-scoped `pendingWrites` entry
    // shadows the server's. The reload throws that shadow away, the older
    // bag value is adopted back, and the assertion below reads it.
    // MEASURED on the unmodified tree: 5 failures in 6 runs. Pinning the
    // key ABSENT makes localStorage authoritative, which is what "persists"
    // means for a single-device user.
    await pinOrgPrefs(page, { currency_display: null });
    await boot(page);
    await page.getByTestId("account-menu-trigger").click(); // 1
    const eur = page.getByTestId("currency-toggle-eur");
    await expect(eur, "H5: currency option not reachable after opening the menu").toBeVisible();
    await eur.click(); // 2
    await expect(eur).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(SETTLE_MS);
    await dismissPublicTestBanner(page);
    await page.getByTestId("account-menu-trigger").click();
    await expect(
      page.getByTestId("currency-toggle-eur"),
      "H5 regression: currency did not persist across reload",
    ).toHaveAttribute("aria-checked", "true");
    // restore
    await page.getByTestId("currency-toggle-ron").click();
    await page.keyboard.press("Escape");
  });

  test("notifications: 2 interactions via the avatar at compact width", async ({ page }) => {
    await page.setViewportSize({ width: 1023, height: 900 });
    await boot(page);
    await page.getByTestId("account-menu-trigger").click(); // 1
    const row = page.getByTestId("notifications-row");
    await expect(row, "H5: notifications not reachable from the avatar below lg").toBeVisible();
    await row.click(); // 2
    await expect(
      page.getByTestId("notifications-dialog"),
      "H5: the folded notifications row opened nothing",
    ).toBeVisible();
    await page.keyboard.press("Escape");
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

  test("period switch: 2 interactions via the Capsule", async ({ page }) => {
    await boot(page);
    await page.getByTestId("header-capsule").click(); // 1
    const popover = page.getByTestId("command-palette");
    await expect(popover, "H5: the Capsule opened no palette").toBeVisible();
    const rows = popover.locator("button");
    const n = await rows.count();
    expect(n, "H5: the palette offers no actionable rows").toBeGreaterThan(0);
    // Interaction 2 is clicking a row; visible+enabled proves actionable.
    await expect(rows.first()).toBeEnabled();
  });
});

// ── H6 · a11y: keyboard, focus, names, coach marks ─────────────────────

test.describe("H6 — header a11y", () => {
  test.setTimeout(150_000);

  test("Escape closes every header popover", async ({ page }) => {
    await boot(page);
    for (const [trigger, content] of [
      ["account-menu-trigger", null],
      // The Capsule is a composite <div>; its FOCUSABLE trigger is the
      // command bar inside it. Naming the wrapper here made the gate
      // assert focus-return onto an element that can never hold focus —
      // the same class of defect as a stale selector, in reverse.
      ["header-command-bar", "command-palette"],
    ] as const) {
      await page.waitForTimeout(RADIX_SETTLE_MS);
      await page.getByTestId(trigger).click();
      const overlay = content
        ? page.getByTestId(content)
        : page.locator('[data-radix-popper-content-wrapper], [role="menu"], [role="dialog"]').last();
      await expect(overlay, `H6: ${trigger} opened nothing`).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(overlay, `H6: Escape did not close ${trigger}'s popover`).toBeHidden();
    }
  });

  /** Where focus lands after Escape, reported per trigger. */
  async function focusAfterEscape(page: Page, trigger: string, content: string | null) {
    await page.waitForTimeout(RADIX_SETTLE_MS);
    await page.getByTestId(trigger).click();
    const overlay = content
      ? page.getByTestId(content)
      : page.locator('[data-radix-popper-content-wrapper], [role="menu"], [role="dialog"]').last();
    await expect(overlay).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(overlay).toBeHidden();
    return page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? `${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? "—"}]` : "none";
    });
  }

  test("Escape returns focus to the avatar trigger", async ({ page }) => {
    await boot(page);
    expect(
      await focusAfterEscape(page, "account-menu-trigger", null),
      "H6: focus did not return to the avatar after Escape",
    ).toBe("button[account-menu-trigger]");
  });

  test("Escape returns focus to the Capsule's command bar", async ({ page }) => {
    await boot(page);
    // ⚠ CROSS-LANE DEFECT, measured 2026-08-30 on the live test stack:
    // focus lands on <body>. The ⌘K palette is a Radix Dialog opened
    // from AppShell state rather than from a <DialogTrigger>, so nothing
    // owns the restore. A keyboard user who Escapes the palette loses
    // their place and must Tab from the top of the document
    // (WCAG 2.4.3 Focus Order).
    //
    // THE FIX (one line, in the palette lane's file, NOT this one):
    //   <DialogPrimitive.Content
    //     onCloseAutoFocus={(e) => {
    //       e.preventDefault();
    //       document.querySelector<HTMLElement>('[data-testid="header-command-bar"]')?.focus();
    //     }}
    // This gate is left RED on purpose. It is a real defect in shipped
    // behaviour; making it green from here would mean either bending the
    // law or bolting a MutationObserver onto TopHeader to paper over
    // another surface's focus management.
    expect(
      await focusAfterEscape(page, "header-command-bar", "command-palette"),
      "H6: focus did not return to the command bar after Escape — see the fix in the comment above " +
        "this assertion. Owner: the palette lane (CommandPalette.tsx / AppShell), not the header lane.",
    ).toBe("button[header-command-bar]");
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
      test.info().annotations.push({
        type: "h6-trust-skipped",
        description:
          "CONDITIONAL selector: no canonical envelope on the booted period — trust chip absent by " +
          "design (no fake trust). The tone-map + receipt locks still run in headerLaw.test.tsx.",
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

  test("the relocation coach mark dismisses on Escape and never re-shows", async ({ page }) => {
    // The mark arms only for a user who actually holds an explicit
    // view-mode choice — someone who USED the dial while it was in the
    // bar. Seed that, or the gate would pass vacuously on a fresh
    // profile, which is precisely the false green H0 exists to kill.
    // Seed ONLY the arming condition. `addInitScript` runs on every
    // load — clearing the dismissed key here would clear it on the
    // reload too, and the gate would report a re-show that the product
    // never performed.
    await seedViewMode(page, "simple");
    await boot(page);

    const mark = page.getByTestId("header-coach-mark");
    await expect(
      mark,
      "H6: the relocation coach mark did not arm for a user who holds an explicit view-mode choice — " +
        "moving a control the user operated without telling them is the regression this gate covers.",
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(mark, "H6: coach mark did not dismiss on Escape").toBeHidden();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(SETTLE_MS);
    await dismissPublicTestBanner(page);
    await expect(
      page.getByTestId("header-coach-mark"),
      "H6: a dismissed coach mark re-showed after reload",
    ).toHaveCount(0);
  });

  test("the coach mark spends no header budget", async ({ page }) => {
    await seedViewMode(page, "simple");
    await boot(page);
    await expect(page.getByTestId("header-coach-mark")).toBeVisible();
    const census = await censusOf(page);
    await reportCensus("1440/dashboard-with-coachmark", census);
    expect(
      census.items.map((i) => i.testid),
      "H6/H1: the coach mark leaked into the header census — it is portaled to <body> precisely so a " +
        "hint about a control never counts as one.",
    ).toEqual(SANCTIONED_DESKTOP);
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
          "CONDITIONAL selector: no canonical envelope on the booted period — receipt unreachable " +
          "live. Authoritative field-parity lock runs in headerLaw.test.tsx (mocked envelope).",
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
