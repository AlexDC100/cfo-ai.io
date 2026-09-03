#!/usr/bin/env node
/**
 * THE AFFORDANCE, MEASURED FOR CONTRAST — both themes, every colour node.
 *
 * ══ WHY THIS EXISTS ═══════════════════════════════════════════════════
 *
 * The provenance card's secondary text was `text-ink-mute`. It reads
 * fine. It measures 3.53:1 against `--popover` in the LIGHT theme, which
 * fails WCAG AA for normal text (4.5:1) — and every label in the card
 * ("Source", "Accounts", "Method", "Pack") plus the whole snapshot line
 * used it. A previous pass on this codebase found AA failing on 10 of 16
 * text nodes with the same root cause: one token that is fine on paper
 * and not fine on a popover.
 *
 * The dotted underline was worse in kind. It is the ONLY thing that
 * tells a reader a figure carries provenance before they hover it, which
 * makes it a non-text UI indicator at a 3:1 floor (WCAG 1.4.11).
 * `brand/40` composites to 1.78:1 in light and 2.27:1 in dark.
 *
 * Judging by eye is what let both through. This computes the ratios from
 * the ACTUAL token values in `frontend/index.css`.
 *
 * ══ THE GATE'S OWN FIRST BUG, KEPT AS A COMMENT ═══════════════════════
 *
 * Version one declared its subjects as constants in this file —
 * `["provenance underline", "brand", 0.4]` and a hand-written list of
 * text tokens. Lowering the COMPONENT's alpha back to 40%, which is the
 * exact defect the gate exists to catch, left it GREEN: it was measuring
 * its own copy of the design, not the design.
 *
 * That is TC-7 — confirm WHICH COMPONENT ACTUALLY RENDERS — and it is
 * the same shape as the fix that once landed on CapsuleJumpList while
 * CommandPalette.renderRow was what painted. Every subject below is now
 * PARSED out of `Provenance.tsx`. Change a class there and the gate
 * measures the new one; delete the underline and the gate loses its
 * subject and fails on its floor rather than reporting clean.
 *
 * ══ WHAT IS NOT MEASURED ══════════════════════════════════════════════
 *
 * Anything needing a rendered browser. This reads declared tokens and
 * declared classes, which is where both defects lived. A screenshot
 * sweep would catch a different class (an overlay, a blend mode) and is
 * a different gate.
 *
 * Zero dependencies. `node scripts/check_provenance_contrast.mjs`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CSS = join(ROOT, "frontend", "index.css");
const COMPONENT_REL = "frontend/components/instrument/Provenance.tsx";
const COMPONENT = join(ROOT, COMPONENT_REL);

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3.0;
/** Colour nodes measured across both themes. Below this the gate
 *  examined too little to be evidence (TC-3). */
const FLOOR_MEASUREMENTS = 6;

// ── the subjects, read out of the component ────────────────────────────

/** COMMENTS STRIPPED FIRST, and the reason is a false positive this gate
 *  produced on its own author: the file's header explains that the card
 *  USED to paint `text-ink-mute`, and the scanner dutifully measured the
 *  prose at 3.53:1 and failed the build over a sentence. A gate that
 *  cannot tell code from commentary about code reports defects that are
 *  not there, which costs exactly as much trust as missing real ones. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const componentSrc = stripComments(readFileSync(COMPONENT, "utf-8"));

/**
 * Every distinct `text-<ink token>` the affordance paints, with its
 * opacity suffix if it has one. `text-ink-soft/70` is not
 * `text-ink-soft`, and a gate that collapsed the two would certify a
 * colour nobody renders.
 */
function textNodesFromComponent(src) {
  const found = [];
  const seen = new Set();
  const re = /\btext-(ink(?:-[a-z0-9]+)?)(?:\/(\d{1,3}))?\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const alpha = m[2] ? Number(m[2]) / 100 : 1;
    const key = `${m[1]}@${alpha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // No line number: the source has had its comments stripped, so any
    // number here would point at the wrong line in the real file.
    found.push({ node: `text-${m[1]}${m[2] ? "/" + m[2] : ""}`, token: m[1], alpha });
  }
  return found;
}

/** The trigger's dotted rule — `decoration-<token>/<alpha>`. */
function underlineFromComponent(src) {
  const m = src.match(/\bdecoration-([a-z0-9-]+)\/(\d{1,3})\b/);
  if (!m) return null;
  return { token: m[1], alpha: Number(m[2]) / 100 };
}

const TEXT_NODES = textNodesFromComponent(componentSrc);
const UNDERLINE = underlineFromComponent(componentSrc);

// ── token parsing ──────────────────────────────────────────────────────

const css = readFileSync(CSS, "utf-8");

/**
 * Both themes' token blocks, located by their `--bg:` declaration rather
 * than by a hardcoded selector — the selector is the part that would go
 * stale silently when the theme switch is rewritten.
 */
function themeBlocks() {
  const out = {};
  const bgDecls = [...css.matchAll(/--bg:\s*[^;]+;/g)];
  if (bgDecls.length < 2) return out;
  for (let i = 0; i < bgDecls.length; i += 1) {
    const at = bgDecls[i].index;
    const open = css.lastIndexOf("{", at);
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth += 1;
      else if (css[j] === "}") depth -= 1;
      j += 1;
    }
    out[i === 0 ? "light" : "dark"] = css.slice(open + 1, j - 1);
  }
  return out;
}

function token(body, name) {
  const m = body.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) return null;
  const raw = m[1].trim();
  const alias = raw.match(/^var\(--([a-z0-9-]+)\)$/i);
  if (alias) return token(body, alias[1]);
  const parts = raw.split(/\s+/);
  if (parts.length < 3) return null;
  const [h, s, l] = parts.slice(0, 3).map(parseFloat);
  if ([h, s, l].some((v) => Number.isNaN(v))) return null;
  return [h, s, l];
}

// ── colour maths ───────────────────────────────────────────────────────

function hslToRgb([h, s, l]) {
  const H = h / 360;
  const S = s / 100;
  const L = l / 100;
  const k = (n) => (n + H * 12) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => v * 255);
}

function relLuminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg, bg) {
  const l1 = relLuminance(fg);
  const l2 = relLuminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Source-over composite. An alpha a gate does not composite is an alpha
 *  that silently fails. */
function over(fg, bg, alpha) {
  return fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));
}

// ── run ────────────────────────────────────────────────────────────────

console.log("PROVENANCE AFFORDANCE — CONTRAST");
console.log("=".repeat(62));
console.log(`  subjects parsed from ${COMPONENT_REL}`);

const themes = themeBlocks();
const failures = [];
let measurements = 0;

if (!themes.light || !themes.dark) {
  console.log("FAIL — could not locate both theme token blocks in frontend/index.css");
  process.exit(1);
}

for (const [themeName, body] of Object.entries(themes)) {
  const popover = token(body, "popover") ?? token(body, "surface");
  const surface = token(body, "surface");
  if (!popover || !surface) {
    failures.push(`${themeName}: --popover / --surface not resolvable`);
    continue;
  }
  const popoverRgb = hslToRgb(popover);
  const surfaceRgb = hslToRgb(surface);

  console.log(`\n${themeName.toUpperCase()} — card ground hsl(${popover.join(" ")})`);

  // --probe-vacuity empties the roster. A gate over a FIXED list is the
  // easiest kind to hollow out — delete entries and it measures less and
  // says PASS — so the probe must prove the count floor below actually
  // fires. The flag was previously ignored: exit 0, full measurements.
  const PROBE_VACUITY = process.argv.includes("--probe-vacuity");
  for (const { node, token: tokenName, alpha } of (PROBE_VACUITY ? [] : TEXT_NODES)) {
    const t = token(body, tokenName);
    if (!t) {
      failures.push(`${themeName}: token --${tokenName} not found (node "${node}")`);
      continue;
    }
    const fg = alpha < 1 ? over(hslToRgb(t), popoverRgb, alpha) : hslToRgb(t);
    const r = ratio(fg, popoverRgb);
    measurements += 1;
    const label = alpha < 1 ? `--${tokenName} @ ${alpha * 100}%` : `--${tokenName}`;
    console.log(
      `  ${r >= AA_TEXT ? "PASS" : "FAIL"}  ${r.toFixed(2).padStart(5)}:1  ` +
        `${node.padEnd(16)} ${label}`,
    );
    if (r < AA_TEXT) {
      failures.push(
        `${themeName}: ${COMPONENT_REL} paints \`${node}\` at ${r.toFixed(2)}:1 ` +
          `on the popover — below AA ${AA_TEXT}:1 for normal text. Every string in ` +
          "this card is 10.5-13px, so the large-text allowance does not apply.",
      );
    }
  }

  if (!UNDERLINE) {
    failures.push(
      `${themeName}: no \`decoration-<token>/<alpha>\` in ${COMPONENT_REL}. Either ` +
        "the affordance has no visible resting indicator, or this gate can no " +
        "longer see it. Neither is a pass.",
    );
    continue;
  }
  const ut = token(body, UNDERLINE.token);
  if (!ut) {
    failures.push(`${themeName}: token --${UNDERLINE.token} not found (underline)`);
    continue;
  }
  const ur = ratio(over(hslToRgb(ut), surfaceRgb, UNDERLINE.alpha), surfaceRgb);
  measurements += 1;
  console.log(
    `  ${ur >= AA_NON_TEXT ? "PASS" : "FAIL"}  ${ur.toFixed(2).padStart(5)}:1  ` +
      `underline  --${UNDERLINE.token} @ ${UNDERLINE.alpha * 100}% on --surface ` +
      "(non-text 3:1)",
  );
  if (ur < AA_NON_TEXT) {
    failures.push(
      `${themeName}: the provenance underline (--${UNDERLINE.token} @ ` +
        `${UNDERLINE.alpha * 100}%) composites to ${ur.toFixed(2)}:1 — below the ` +
        `${AA_NON_TEXT}:1 WCAG 1.4.11 threshold for a non-text indicator. It is ` +
        "the only thing that says a figure HAS provenance before you hover it.",
    );
  }
}

console.log("");
console.log(
  `GATE-WORK provenance-contrast units=${measurements} floor=${FLOOR_MEASUREMENTS} ` +
    "label=colour-nodes-measured-in-both-themes",
);
console.log(
  `  ${TEXT_NODES.length} text class(es) + ${UNDERLINE ? 1 : 0} underline, ` +
    "parsed from the component, measured in 2 themes",
);

if (measurements < FLOOR_MEASUREMENTS) {
  failures.push(
    `DISCOVERY BROKEN: ${measurements} measurements, floor ${FLOOR_MEASUREMENTS}. ` +
      "A contrast gate that measured nothing is not a passing gate.",
  );
}

console.log("");
if (failures.length) {
  console.log(`FAIL — ${failures.length} finding(s):`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log(
  `PASS — ${measurements} colour node(s) measured across both themes; every text ` +
    `node at or above AA ${AA_TEXT}:1 and the underline above ${AA_NON_TEXT}:1.`,
);
