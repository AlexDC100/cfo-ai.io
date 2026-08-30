#!/usr/bin/env node
/**
 * Screenshot loop for the ATTACH/REPLACE CONFIRM STEP (period-assignment
 * fix, Part C).
 *
 * `design_shots.mjs` captures routes at rest, and this dialog is never at
 * rest — it exists only between a dropped file and a confirmed month. So
 * this harness drives it into each state that matters and captures all of
 * them at the brief's three viewports, in both themes:
 *
 *   detected  the step as it opens: pre-filled from the DOCUMENT, with the
 *             evidence line saying which signal produced the month
 *   absent    nothing detected — empty field, "not detected", confirm off
 *   mismatch  a month the file contradicts: the guard + its explicit
 *             acknowledgement
 *   entity    a second company in one month: the warning, with "Attach to
 *             a new period" as the primary way out
 *   replace   what is being replaced — filename, period, upload date
 *
 * ROUTE: a fixture harness page (design_review/period/harness-attach-
 * confirm.html) served by the dev server, which mounts the REAL component
 * with only its two seams stubbed. Taking these from /workspace itself
 * would mean finishing the preview stack's onboarding wizard, which
 * CREATES a workspace in the shared test-mode database (CLAUDE.md memory:
 * "test-mode junk workspaces incident"). The script still tries the live
 * drop gesture first and captures it whenever real period rows exist.
 *
 *   node scripts/design_shots_attach_confirm.mjs --label period-r1 --theme both
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ARGS = process.argv.slice(2);
function arg(name, dflt) {
  const i = ARGS.indexOf("--" + name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : dflt;
}

const LABEL = arg("label", "attach-confirm");
const BASE = arg("base", "http://localhost:5173");
const THEME = arg("theme", "both");
const HARNESS = "/design_review/period/harness-attach-confirm.html";
const STATES = ["detected", "absent", "mismatch", "entity", "replace"];

const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "laptop-1280", width: 1280, height: 800 },
  { name: "mobile-390", width: 390, height: 844 },
];

// A real Romanian trial-balance preamble, for the live-app attempt: the
// company line the entity guard reads and the closing date the period
// detection reads.
const FILE_NAME = "Carniprod Trial Balance 2025.csv";
const FILE_BODY = [
  "S.C. CARNIPROD S.R.L.",
  "C.U.I.: RO 1234567   Reg. Com.: J37/123/1994",
  "BALANTA DE VERIFICARE la data de 31.12.2025",
  "Simbol cont;Denumire cont;Sold initial D;Sold initial C;Rulaj D;Rulaj C;Sold final D;Sold final C",
  "1012;Capital subscris varsat;0;500000;0;0;0;500000",
].join("\n");

const outDir = join("design_review", LABEL);
mkdirSync(outDir, { recursive: true });

const themes = THEME === "both" ? ["light", "dark"] : [THEME];
const browser = await chromium.launch();

async function pinTheme(page, theme) {
  await page.evaluate((t) => {
    try {
      localStorage.setItem("theme", t);
    } catch {}
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(t);
    root.style.colorScheme = t;
  }, theme);
  await page.waitForTimeout(300);
}

for (const theme of themes) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      colorScheme: theme === "dark" ? "dark" : "light",
    });
    const page = await ctx.newPage();

    // ── the five states, from the fixture harness ─────────────────────
    for (const state of STATES) {
      try {
        await page.goto(`${BASE}${HARNESS}?state=${state}`, {
          waitUntil: "networkidle",
          timeout: 45000,
        });
      } catch {
        // networkidle can starve behind HMR sockets — carry on.
      }
      await pinTheme(page, theme);
      try {
        await page.getByTestId("attach-confirm-dialog").waitFor({ timeout: 15000 });
        await page.getByTestId("attach-confirm-evidence").waitFor({ timeout: 15000 });
        if (state === "mismatch") {
          await page.getByTestId("attach-confirm-month").fill("2017-12");
          await page.getByTestId("attach-confirm-mismatch").waitFor({ timeout: 5000 });
        }
        if (state === "entity") {
          await page.getByTestId("attach-confirm-entity").waitFor({ timeout: 8000 });
        }
        await page.waitForTimeout(350);
        const name = `attach-${state}--${vp.name}--${theme}.png`;
        await page.screenshot({ path: join(outDir, name) });
        process.stdout.write(`shot ${name}\n`);
      } catch (err) {
        console.log(`skip ${state}/${theme}/${vp.name}: ${String(err).split("\n")[0]}`);
      }
    }

    // ── the live gesture, when the preview stack actually has periods ──
    try {
      await page.goto(BASE + "/workspace", { waitUntil: "networkidle", timeout: 45000 });
    } catch {}
    await pinTheme(page, theme);
    try {
      const d = page.getByTestId("test-mode-banner-dismiss");
      if (await d.isVisible({ timeout: 800 })) await d.click();
    } catch {}
    const row = page.locator('[data-testid^="wsset-period-row-"]').first();
    try {
      await row.waitFor({ state: "visible", timeout: 6000 });
      await row.scrollIntoViewIfNeeded();
      await page.evaluate(
        ({ name, body }) => {
          const el = document.querySelector('[data-testid^="wsset-period-row-"]');
          if (!el) return;
          const dt = new DataTransfer();
          dt.items.add(new File([body], name, { type: "text/csv" }));
          for (const type of ["dragover", "drop"]) {
            el.dispatchEvent(
              new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
            );
          }
        },
        { name: FILE_NAME, body: FILE_BODY },
      );
      await page.getByTestId("attach-confirm-dialog").waitFor({ timeout: 10000 });
      await page.getByTestId("attach-confirm-evidence").waitFor({ timeout: 15000 });
      await page.waitForTimeout(350);
      const name = `attach-live-drop--${vp.name}--${theme}.png`;
      await page.screenshot({ path: join(outDir, name) });
      process.stdout.write(`shot ${name}\n`);
    } catch {
      console.log(
        `skip live-drop/${theme}/${vp.name}: no period rows in the preview workspace`,
      );
    }

    await ctx.close();
  }
}

await browser.close();
console.log(`\nDONE -> ${outDir}`);
