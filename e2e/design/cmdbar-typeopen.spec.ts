/**
 * G12 — TYPE-TO-OPEN, live (found checking the production deploy of
 * 2026-09-27: a hidden automation tab froze the close animation and read as
 * "the first letter is dropped"; this law settles it in a visible browser).
 * A letter typed outside any input opens the bar AND is the first letter of
 * the query; a reopen from the header pill starts empty; a second
 * type-to-open keeps its letter again. Both companies.
 * Plant (pendingChar.current = e.key removed): 2 failed, Expected "stoc",
 * Received "toc". Restored: 2 passed.
 */
import { expect, test, type Page } from "@playwright/test";
import { AGRAS, ORG_AGRAS, ORG_SCANDIA, SCANDIA, WorkspaceDouble } from "../workspace-v2.double";

test.skip(() => process.env.E2E_HERMETIC !== "1", "hermetic only");
const C = [
  { org: ORG_SCANDIA, period: SCANDIA.period.period.id as string, name: "Scandia Food SRL" },
  { org: ORG_AGRAS, period: AGRAS.period.period.id as string, name: "Agras SRL" },
];
async function open(page: Page, c: (typeof C)[number]) {
  const double = new WorkspaceDouble({ theme: "dark", language: "en" });
  double.periods[ORG_AGRAS] = [AGRAS];
  await double.install(page);
  await page.goto(`/dashboard?period=${c.period}&org=${c.org}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("header-command-bar")).toContainText(c.name, { timeout: 25_000 });
  await page.waitForTimeout(1500);
}
for (const c of C) {
  test(`type-to-open keeps the first letter and a reopen starts empty — ${c.name}`, async ({ page }) => {
    await open(page, c);
    await page.locator("body").click({ position: { x: 5, y: 700 } });
    await page.keyboard.type("stoc", { delay: 60 });
    const composer = page.getByTestId("capsule-composer");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await expect(composer).toHaveValue("stoc");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).toBeHidden();
    await page.waitForTimeout(600);
    await page.getByTestId("header-command-bar").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await expect(composer).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).toBeHidden();
    await page.waitForTimeout(600);
    await page.keyboard.type("p", { delay: 60 });
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await expect(composer).toHaveValue("p");
  });
}
