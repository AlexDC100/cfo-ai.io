#!/usr/bin/env node
/**
 * THE INSTRUMENT — design CI (gate D2 + orchestration).
 *
 * D2 CONTRAST MATRIX: parses the token sheet (frontend/index.css) for the
 * `:root` (Paper) and `.dark` (Terminal) HSL triplets, resolves var()
 * chains, and computes WCAG contrast for every pair that carries text.
 * Thresholds:
 *   - numeric-data pairs (ink on bg / surface): AAA 7.0 — numbers are ink,
 *     and the ledger must be readable at 11px mono in both themes;
 *   - regular text pairs: AA 4.5;
 *   - ink-mute (explicitly a large/label-only tone): AA-large 3.0.
 *
 * Also chains the D5/D10 style lint (scripts/check_design_lint.mjs) so
 * `npm run design:gates` is one command; both halves always run and both
 * report before the combined exit code.
 *
 * Zero dependencies. Node >= 18.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── token sheet parsing ────────────────────────────────────────────────

const css = readFileSync(join(ROOT, "frontend", "index.css"), "utf8");

/**
 * Collect custom-property declarations from every `:root {}` / `.dark {}`
 * block. Only HSL triplets (`171 80% 27%`) and var() references are kept;
 * gradient/hex declarations in the top-of-file gradient block don't match
 * and are irrelevant to text contrast.
 */
function collectBlocks(selector) {
  const decls = {};
  // Match `SELECTOR {` at line start (inside @layer base it is indented).
  const re = new RegExp(`(^|\\n)\\s*${selector.replace(".", "\\.")}\\s*\\{`, "g");
  let m;
  while ((m = re.exec(css)) !== null) {
    // Walk to the matching close brace (blocks here never nest).
    const start = css.indexOf("{", m.index) + 1;
    const end = css.indexOf("}", start);
    const body = css.slice(start, end);
    for (const line of body.split("\n")) {
      const d = line.match(/--([\w-]+)\s*:\s*([^;]+);/);
      if (!d) continue;
      const [, name, raw] = d;
      const value = raw.trim();
      const hsl = value.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
      const ref = value.match(/^var\(--([\w-]+)\)$/);
      if (hsl) decls[name] = { h: +hsl[1], s: +hsl[2], l: +hsl[3] };
      else if (ref) decls[name] = { ref: ref[1] };
    }
  }
  return decls;
}

const rootDecls = collectBlocks(":root");
const darkDecls = collectBlocks(".dark");

function resolve(theme, name, depth = 0) {
  if (depth > 8) throw new Error(`var() chain too deep at --${name}`);
  const decls = theme === "dark" ? { ...rootDecls, ...darkDecls } : rootDecls;
  const v = decls[name];
  if (!v) throw new Error(`token --${name} not found for theme ${theme}`);
  return v.ref ? resolve(theme, v.ref, depth + 1) : v;
}

// ── WCAG math ──────────────────────────────────────────────────────────

function hslToRgb({ h, s, l }) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const l1 = luminance(hslToRgb(fg));
  const l2 = luminance(hslToRgb(bg));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// ── the pair list ──────────────────────────────────────────────────────
// Every row is a pair that actually carries text somewhere in the app.
// threshold: 7.0 = AAA (numeric data — numbers are ink), 4.5 = AA text,
// 3.0 = AA large (ink-mute is documented as label/large-only).
// assert:false rows print for visibility but never fail the gate —
// they are drift telemetry for the wave coordinator.

const PAIRS = [
  // numeric data — AAA
  { fg: "ink", bg: "bg", t: 7.0, note: "numeric data on page" },
  { fg: "ink", bg: "surface", t: 7.0, note: "numeric data on panel" },
  // body text — AA
  { fg: "ink-2", bg: "bg", t: 4.5, note: "secondary text" },
  { fg: "ink-soft", bg: "bg", t: 4.5, note: "muted text" },
  { fg: "ink-soft", bg: "surface", t: 4.5, note: "muted text on panel" },
  { fg: "ink-mute", bg: "bg", t: 3.0, note: "labels only (AA large)" },
  // accent text — AA
  { fg: "brand-d", bg: "bg", t: 4.5, note: "accent text (text-brand-d)" },
  { fg: "brand-l", bg: "bg", t: 4.5, themes: ["dark"], note: "accent text (dark:text-brand-l)" },
  // primary button — AA
  { fg: "primary-foreground", bg: "brand", t: 4.5, note: "button label on accent" },
  // semantic fg on its tint — AA (chips, banners)
  { fg: "success", bg: "success-tint", t: 4.5, note: "verified chip" },
  { fg: "caution", bg: "caution-tint", t: 4.5, note: "RECONCILED chip" },
  { fg: "alert", bg: "alert-tint", t: 4.5, note: "IMBALANCED chip" },
  { fg: "info", bg: "info-tint", t: 4.5, note: "info chip" },
  // chip system (Panel.tsx CHIP_TONES)
  { fg: "ink-2", bg: "bg-2", t: 4.5, note: "neutral chip" },
  { fg: "brand-d", bg: "brand-tint", t: 4.5, themes: ["light"], note: "accent chip (Paper)" },
  { fg: "brand-l", bg: "brand-tint", t: 4.5, themes: ["dark"], note: "accent chip (Terminal)" },
  // semantic fg on plain bg — used for inline status text
  { fg: "success", bg: "bg", t: 4.5, note: "verified text on page" },
  { fg: "caution", bg: "bg", t: 4.5, note: "caution text on page" },
  { fg: "alert", bg: "bg", t: 4.5, note: "alert text on page" },
];

// ── run D2 ─────────────────────────────────────────────────────────────

console.log("D2 CONTRAST MATRIX — token sheet: frontend/index.css\n");
const header = `${"theme".padEnd(6)} ${"fg".padEnd(20)} ${"bg".padEnd(14)} ${"ratio".padStart(6)}  ${"min".padStart(4)}  ${"".padEnd(5)} note`;
console.log(header);
console.log("-".repeat(header.length + 10));

let d2Failures = 0;
for (const theme of ["light", "dark"]) {
  for (const p of PAIRS) {
    if (p.themes && !p.themes.includes(theme)) continue;
    let row;
    try {
      const ratio = contrast(resolve(theme, p.fg), resolve(theme, p.bg));
      const ok = ratio >= p.t;
      if (!ok) d2Failures++;
      row = `${theme.padEnd(6)} ${("--" + p.fg).padEnd(20)} ${("--" + p.bg).padEnd(14)} ${ratio.toFixed(2).padStart(6)}  ${p.t.toFixed(1).padStart(4)}  ${(ok ? "pass" : "FAIL").padEnd(5)} ${p.note}`;
    } catch (e) {
      d2Failures++;
      row = `${theme.padEnd(6)} ${("--" + p.fg).padEnd(20)} ${("--" + p.bg).padEnd(14)} ${"?".padStart(6)}  ${p.t.toFixed(1).padStart(4)}  ${"FAIL".padEnd(5)} ${e.message}`;
    }
    console.log(row);
  }
}
console.log(`\nD2 contrast: ${d2Failures === 0 ? "PASS" : `FAIL (${d2Failures} pair(s) under threshold)`}`);

// ── chain the style lint (D5 + D10) ────────────────────────────────────

console.log("\n" + "=".repeat(72));
const lint = spawnSync(process.execPath, [join(ROOT, "scripts", "check_design_lint.mjs")], {
  stdio: "inherit",
});
const lintFailed = lint.status !== 0;

console.log("\n" + "=".repeat(72));
console.log(`design gates: contrast ${d2Failures === 0 ? "PASS" : "FAIL"} · style lint ${lintFailed ? "FAIL" : "PASS"}`);
process.exit(d2Failures === 0 && !lintFailed ? 0 : 1);
