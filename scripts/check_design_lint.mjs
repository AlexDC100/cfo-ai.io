#!/usr/bin/env node
/**
 * THE INSTRUMENT — design style lint (gates D5 + D10).
 *
 * Scans frontend source and fails on three classes of identity drift:
 *
 *   D5-HEX     raw hex colors in component files. All color flows through
 *              the token sheet (frontend/index.css) — a hex literal in a
 *              component bypasses both themes at once.
 *   D10-SHADOW resting-shadow utilities (shadow-lg / xl / 2xl / 3 / 4)
 *              outside the floating-layer allowlist. shadow-sm/md resolve
 *              to transparent tokens so they are inert; lg+ are real and
 *              belong only to layers that literally float (dialog,
 *              popover, dropdown, tooltip, sheet, toast, palette).
 *   D10-SERIF  serif display (font-serif) on authenticated screens
 *              (pages/cfo + components/cfo). The serif voice survives
 *              only on marketing pages and designated empty states.
 *
 * Zero dependencies; run with `node scripts/check_design_lint.mjs`.
 * Exit 1 when any violation is found; prints a per-rule table.
 *
 * Escape hatch (hex rule only): a literal that genuinely cannot be a
 * token (e.g. canvas 2D drawing, an SVG export baked for email) may
 * carry the comment  design-lint-allow-hex  on the same line or the
 * line directly above it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname — the repo path contains spaces and
// pathname would keep them percent-encoded.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FE = join(ROOT, "frontend");

// ── file walk ──────────────────────────────────────────────────────────

const EXTS = new Set([".tsx", ".ts", ".css"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".vite"]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(p);
    } else if (EXTS.has(p.slice(p.lastIndexOf(".")))) {
      yield p;
    }
  }
}

// Normalized repo-relative path with forward slashes (stable on any OS).
const rel = (p) => relative(ROOT, p).split(sep).join("/");

const isTestFile = (f) =>
  /(\.test\.|\.spec\.)/.test(f) || f.includes("/__tests__/") || f.includes("/test/");

// ── D5: raw hex ────────────────────────────────────────────────────────

// Files that ARE the color source of truth (or generate it) — the only
// places hex may live. One comment per entry: why it is exempt.
const HEX_ALLOWED_FILES = new Set([
  "frontend/index.css", // THE token sheet — hex is defined here
  "frontend/styles/marketing-tokens.css", // marketing --m-* token namespace
  "frontend/styles/eeiBoard.css", // --eei-* board token namespace
  "frontend/theme/tokens.ts", // TS mirror of the token sheet
  // Documented escape hatch: static palettes for canvas / SVG generation /
  // email — surfaces that cannot read CSS vars. NOTE it still carries the
  // retired #5CD3C5 teal; retheming it is a migration-lane task, but as a
  // palette-definition file it is allowlisted like tokens.ts.
  "frontend/theme/theme.ts",
]);
// Config files at repo root (tailwind/vite/postcss) are outside frontend/
// and never reach this walk, but keep the intent explicit:
const HEX_ALLOWED_PATTERNS = [
  /(^|\/)(tailwind|vite|vitest|postcss)\.config\.(ts|js|mjs)$/,
];

// Hex color literal: #RGB / #RGBA / #RRGGBB / #RRGGBBAA.
// (?<!&) drops HTML entities (&#8211;); (?<![\w-]) drops url fragments
// glued to words; the length alternation drops anchors like #overview.
const HEX_RE = /(?<!&)(?<![\w-])#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-fA-F])/g;

// ── D10: resting shadows ───────────────────────────────────────────────

// Floating layers only — surfaces that render above the page in a portal
// or overlay. One comment per entry.
const SHADOW_ALLOWED = new Set([
  "frontend/components/ui/dialog.tsx", // modal overlay
  "frontend/components/ui/alert-dialog.tsx", // modal overlay
  "frontend/components/ui/popover.tsx", // floating panel
  "frontend/components/ui/dropdown-menu.tsx", // floating menu
  "frontend/components/ui/tooltip.tsx", // floating tip
  "frontend/components/ui/sheet.tsx", // slide-over overlay
  "frontend/components/ui/toast.tsx", // toast layer
  "frontend/components/ui/toaster.tsx", // toast mount
  "frontend/components/ui/sonner.tsx", // toast layer (sonner)
  "frontend/components/cfo/command/CommandCenter.tsx", // command palette (floats)
  "frontend/components/cfo/SearchDialog.tsx", // ⌘K search dialog (floats)
  "frontend/components/instrument/Amount.tsx", // provenance tooltip is a floating layer
]);
const SHADOW_ALLOWED_DIRS = [
  "frontend/components/instrument/shell/", // shell floating chrome (palette etc.)
];

// shadow-lg / shadow-xl / shadow-2xl / shadow-3 / shadow-4 (with optional
// Tailwind variant prefixes like hover: / dark:lg: etc.). hover: shadows
// still violate: a panel must not float on hover either.
const SHADOW_RE = /(?<![\w/-])(?:[\w-]+:)*shadow-(?:lg|xl|2xl|3|4)(?![\w-])/g;

// ── D10: serif on authenticated screens ────────────────────────────────

const SERIF_SCOPES = ["frontend/pages/cfo/", "frontend/components/cfo/"];
// Marketing pages — serif display is the marketing voice.
const SERIF_MARKETING = new Set([
  "frontend/pages/cfo/Landing.tsx", // marketing landing
  "frontend/pages/cfo/Pricing.tsx", // marketing pricing page
  "frontend/pages/cfo/RoadmapPage.tsx", // marketing roadmap
  "frontend/pages/cfo/ContactSalesPage.tsx", // marketing contact
  "frontend/pages/cfo/landingStrings.ts", // landing copy module
]);
// Designated empty states — the one in-app place serif survives.
const SERIF_EMPTY_STATES = new Set([
  "frontend/components/cfo/chat/CFOEmptyState.tsx", // chat zero state
  "frontend/components/cfo/RouteErrorBoundary.tsx", // route error / empty state
]);

const SERIF_RE = /(?<![\w/-])(?:[\w-]+:)*font-serif(?![\w-])/g;

// ── scan ───────────────────────────────────────────────────────────────

const violations = { hex: [], shadow: [], serif: [] };

function findAll(re, line) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(line)) !== null) out.push(m[0]);
  return out;
}

for (const abs of walk(FE)) {
  const file = rel(abs);
  if (isTestFile(file)) continue; // test fixtures may hold literals
  const lines = readFileSync(abs, "utf8").split("\n");

  const hexExempt =
    HEX_ALLOWED_FILES.has(file) || HEX_ALLOWED_PATTERNS.some((p) => p.test(file));
  const shadowExempt =
    SHADOW_ALLOWED.has(file) || SHADOW_ALLOWED_DIRS.some((d) => file.startsWith(d));
  const serifScoped =
    SERIF_SCOPES.some((s) => file.startsWith(s)) &&
    !SERIF_MARKETING.has(file) &&
    !SERIF_EMPTY_STATES.has(file);

  lines.forEach((line, i) => {
    if (!hexExempt) {
      const hits = findAll(HEX_RE, line);
      if (hits.length) {
        const prev = i > 0 ? lines[i - 1] : "";
        const escaped =
          line.includes("design-lint-allow-hex") || prev.includes("design-lint-allow-hex");
        if (!escaped) {
          violations.hex.push({ file, line: i + 1, match: hits.join(" ") });
        }
      }
    }
    if (!shadowExempt) {
      for (const hit of findAll(SHADOW_RE, line)) {
        violations.shadow.push({ file, line: i + 1, match: hit });
      }
    }
    if (serifScoped) {
      for (const hit of findAll(SERIF_RE, line)) {
        violations.serif.push({ file, line: i + 1, match: hit });
      }
    }
  });
}

// ── report ─────────────────────────────────────────────────────────────

const RULES = [
  ["D5-HEX", "raw hex color outside the token sheet", violations.hex],
  ["D10-SHADOW", "resting shadow (lg+) outside floating layers", violations.shadow],
  ["D10-SERIF", "serif display on an authenticated screen", violations.serif],
];

let total = 0;
for (const [code, label, list] of RULES) {
  console.log(`\n${code} — ${label}: ${list.length ? list.length + " violation(s)" : "clean"}`);
  const width = Math.max(0, ...list.map((v) => `${v.file}:${v.line}`.length));
  for (const v of list) {
    console.log(`  ${`${v.file}:${v.line}`.padEnd(width)}  ${v.match}`);
  }
  total += list.length;
}

console.log(
  `\ndesign lint: ${total === 0 ? "PASS" : "FAIL"} (${violations.hex.length} hex, ${violations.shadow.length} shadow, ${violations.serif.length} serif)`,
);
process.exit(total === 0 ? 0 : 1);
