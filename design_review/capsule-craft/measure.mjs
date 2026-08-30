#!/usr/bin/env node
/**
 * THE CAPSULE — craft MEASUREMENTS.
 *
 * The screenshots say what it looks like. This says what it IS: the
 * numbers the critique has to be written against, so a claim like "the
 * composer never moves" is a delta in pixels rather than an impression
 * of two PNGs.
 *
 * Prints one JSON blob per (viewport × theme).
 */
import { chromium } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ARGS = process.argv.slice(2);
const arg = (n, d) => { const i = ARGS.indexOf("--" + n); return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d; };
const LABEL = arg("label", "craft-r2");
const BASE = "http://localhost:5173";
const OUT = join("design_review", "capsule-craft", LABEL);
mkdirSync(OUT, { recursive: true });

const TOOL_PAYLOAD = {
  version: "ct1", tool: "get_facts", read_only: true, ok: true,
  values: [{
    kind: "money", fact: "total_assets", metric: "total_assets", unit: "money",
    amount_minor: 39000000, value: 390000, currency: "RON",
    scope: "December 2024", label_key: "capsule.metric.total_assets",
    provenance: { period_id: "p-dec", period_label: "December 2024", entity_id: "org-1",
      source: "assembled_canonical_v1", tier: "canonical_bs", snapshot_id: "sha256-p-dec" },
  }],
  rows: [], gaps: [], limitations: [], notes: [],
};

// WCAG relative luminance + contrast, over the real composited pixel.
const CONTRAST_FN = `
(() => {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
  const L = ([r,g,b]) => 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);
  const parse = (s) => { const m = s.match(/-?[\\d.]+/g) || []; return [ +m[0]||0, +m[1]||0, +m[2]||0, m[3] === undefined ? 1 : +m[3] ]; };
  const over = (fg, bg) => { const a = fg[3]; return [0,1,2].map(i => fg[i]*a + bg[i]*(1-a)); };
  window.__contrast = (el) => {
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    // Walk ancestors compositing every non-transparent background.
    let stack = [];
    for (let n = el; n; n = n.parentElement) {
      const b = parse(getComputedStyle(n).backgroundColor);
      if (b[3] > 0) stack.push(b);
    }
    stack.push([255,255,255,1]);
    let bg = stack[stack.length-1].slice(0,3);
    for (let i = stack.length-2; i >= 0; i--) bg = over(stack[i], bg);
    const c1 = L(over(fg, bg)) + 0.05, c2 = L(bg) + 0.05;
    return Math.round((Math.max(c1,c2)/Math.min(c1,c2)) * 100) / 100;
  };
  return true;
})()`;

const out = [];
const browser = await chromium.launch();
for (const theme of ["dark", "light"]) {
  for (const vp of [{ n: "1440", w: 1440, h: 900 }, { n: "390", w: 390, h: 844 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: theme, deviceScaleFactor: 1 });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("cfo:learning-mode:v1", JSON.stringify({ mode: "subtle", coachDismissed: true }));
        localStorage.setItem("cfo-view-mode-v1", "pro");
      } catch {}
    });
    const page = await ctx.newPage();
    await page.route("**/functions/v1/chat-llm", (r) => r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ answer: "Total assets stand at {{money:total_assets}} for December 2024." }) }));
    await page.route("**/api/capsule/tools/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TOOL_PAYLOAD) }));
    await page.goto(BASE + "/dashboard", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8000);
    await page.evaluate((t) => { try { localStorage.setItem("theme", t); } catch {} ;
      const r = document.documentElement; r.classList.remove("light","dark"); r.classList.add(t); r.style.colorScheme = t; }, theme);
    await page.waitForTimeout(400);
    const d = page.getByTestId("test-mode-banner-dismiss");
    if (await d.isVisible().catch(() => false)) { await d.click().catch(()=>{}); await page.waitForTimeout(300); }
    await page.evaluate(CONTRAST_FN);

    const rec = { theme, viewport: vp.n, states: {}, contrast: [], coach: null, tooltips: null };

    const snap = async (tag) => {
      await page.waitForTimeout(450);
      rec.states[tag] = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="command-palette"]');
        const comp = document.querySelector('[data-testid="capsule-composer-block"]');
        const stack = document.querySelector('[data-testid="capsule-stack"]');
        const list = document.getElementById("command-palette-list");
        const inner = list?.firstElementChild;
        if (!card) return null;
        const c = card.getBoundingClientRect();
        const co = comp?.getBoundingClientRect();
        const li = inner?.getBoundingClientRect();
        const ta = document.querySelector('[data-testid="command-palette"] textarea');
        const under = document.querySelector('[data-testid="capsule-underline"]');
        return {
          card: { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) },
          composerTop: co ? Math.round(co.top) : null,
          composerH: co ? Math.round(co.height) : null,
          contentH: (li && co) ? Math.round(li.height + co.height) : null,
          deadSpace: (li && co) ? Math.round(c.height - (li.height + co.height)) : null,
          composerIsLast: comp ? comp === stack?.lastElementChild : null,
          focused: ta ? document.activeElement === ta : null,
          underlineW: under ? Math.round(under.getBoundingClientRect().width) : null,
          rows: document.querySelectorAll('[data-testid="capsule-jump-row"],[data-idx]').length,
        };
      });
    };

    // rest
    const trig = page.locator('[data-testid="header-command-bar"]');
    if (await trig.isVisible().catch(() => false)) await trig.click();
    else await page.keyboard.press("Control+k");
    await page.waitForTimeout(800);
    await snap("rest");

    // contrast census over the resting surface
    rec.contrast = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="command-palette"]');
      if (!root) return [];
      const out = [];
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (c.nodeType === 3 && (c.textContent || "").trim().length > 1) {
            const el = c.parentElement;
            if (!el) continue;
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
            const px = parseFloat(cs.fontSize);
            const bold = +cs.fontWeight >= 700;
            const large = px >= 24 || (px >= 18.66 && bold);
            out.push({
              text: (c.textContent || "").trim().slice(0, 34),
              px: Math.round(px * 10) / 10,
              ratio: window.__contrast(el),
              need: large ? 3 : 4.5,
            });
          } else if (c.nodeType === 1) walk(c);
        }
      };
      walk(root);
      return out;
    });

    // native tooltips anywhere on the surface
    rec.tooltips = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="command-palette"]');
      return root ? Array.from(root.querySelectorAll("[title]")).map((e) => e.getAttribute("title")) : null;
    });

    // typing
    const input = page.locator('[data-testid="command-palette"] textarea').first();
    await input.click().catch(()=>{});
    await input.fill("cash").catch(()=>{});
    await snap("typing");

    // answer
    await input.fill("what are total assets").catch(()=>{});
    await page.waitForTimeout(300);
    await input.press("Enter").catch(()=>{});
    await page.waitForTimeout(3200);
    await snap("answer");

    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    // coach mark — armed only for a user holding an explicit view-mode choice
    const ctx2 = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: theme, deviceScaleFactor: 1 });
    await ctx2.addInitScript(() => {
      try {
        localStorage.setItem("cfo:learning-mode:v1", JSON.stringify({ mode: "subtle", coachDismissed: true }));
        localStorage.setItem("cfo-view-mode-v1", "pro");
        localStorage.removeItem("cfo:header-mode-coachmark-v1");
      } catch {}
    });
    const p2 = await ctx2.newPage();
    await p2.goto(BASE + "/dashboard", { waitUntil: "domcontentloaded" });
    await p2.waitForTimeout(8000);
    const d2 = p2.getByTestId("test-mode-banner-dismiss");
    if (await d2.isVisible().catch(() => false)) { await d2.click().catch(()=>{}); await p2.waitForTimeout(300); }
    rec.coach = await p2.evaluate(() => {
      const card = document.querySelector('[data-testid="header-coach-mark-card"]');
      const av = document.querySelector('[data-testid="account-menu-trigger"]');
      if (!card || !av) return { card: !!card, avatar: !!av };
      const c = card.getBoundingClientRect(), a = av.getBoundingClientRect();
      return {
        anchored: card.getAttribute("data-anchored"),
        hasCaret: !!document.querySelector('[data-testid="header-coach-mark-caret"]'),
        cardCentre: Math.round(c.x + c.width / 2),
        avatarCentre: Math.round(a.x + a.width / 2),
        centreDrift: Math.round(Math.abs(c.x + c.width / 2 - (a.x + a.width / 2))),
        gapBelowAvatar: Math.round(c.top - a.bottom),
        insideHeader: !!card.closest("header"),
      };
    });
    if (vp.n === "1440") await p2.screenshot({ path: join(OUT, `coach--${vp.n}--${theme}.png`), clip: { x: vp.w - 520, y: 0, width: 520, height: 220 } });
    await ctx2.close();
    await ctx.close();
    out.push(rec);
    process.stdout.write(`measured ${theme}/${vp.n}\n`);
  }
}
await browser.close();
writeFileSync(join(OUT, "MEASURE-FULL.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.map(r => ({
  theme: r.theme, vp: r.viewport,
  rest: r.states.rest && { h: r.states.rest.card.h, dead: r.states.rest.deadSpace, composerTop: r.states.rest.composerTop, last: r.states.rest.composerIsLast, focused: r.states.rest.focused, underlineW: r.states.rest.underlineW },
  typing: r.states.typing && { h: r.states.typing.card.h, dead: r.states.typing.deadSpace, composerTop: r.states.typing.composerTop },
  answer: r.states.answer && { h: r.states.answer.card.h, dead: r.states.answer.deadSpace, composerTop: r.states.answer.composerTop },
  worstContrast: r.contrast.length ? r.contrast.reduce((a,b) => (b.ratio - b.need) < (a.ratio - a.need) ? b : a) : null,
  failures: r.contrast.filter(c => c.ratio < c.need).length,
  tooltips: r.tooltips,
  coach: r.coach,
})), null, 2));
