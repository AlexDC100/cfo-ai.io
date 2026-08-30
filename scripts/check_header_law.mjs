#!/usr/bin/env node
/**
 * check_header_law.mjs — the static tripwire for the PLACEMENT LAW
 * (gates H2 + H4, no browser, no test runner — runs in CI in <100ms).
 *
 * The runtime halves live in:
 *   · frontend/components/cfo/__tests__/headerLaw.test.tsx  (H2/H3/H4 DOM)
 *   · e2e/design/header.spec.ts                             (H1/H4/H5/H6 live)
 *
 * Laws enforced here:
 *   L1  no header-level Ask CFO AI: TopHeader.tsx must not wire onOpenAi
 *       to any rendered element (onClick={onOpenAi} / onClick={() =>
 *       onOpenAi(...)}). The sidebar accent row + ⌘J + the palette are
 *       Ask's homes; a header control is the duplicate that started this.
 *   L2  no destination duplicates: TopHeader.tsx must not navigate() or
 *       <Link/NavLink to=> any SHELL_NAV_ALL destination. One idiom is
 *       grandfathered: at most ONE navigate("/dashboard") — the brand
 *       mark's logo-home. "/login" (signed-out) is not a nav destination.
 *   L3  one ⌘K hint: shellStrings.json palette hints (en+ro) carry no
 *       shortcut text ("⌘", "{{mod}}", "ctrl", "cmd") — the <kbd> is the
 *       one hint — and TopHeader.tsx renders at most one <kbd>.
 *
 * Exit 0 clean; exit 1 with one ✗ line per violation.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf-8");

const failures = [];
const ok = [];
const fail = (law, msg) => failures.push(`  ✗ [${law}] ${msg}`);
const pass = (law, msg) => ok.push(`  ✓ [${law}] ${msg}`);

// ── inputs ─────────────────────────────────────────────────────────────

const topHeader = read("frontend/components/cfo/TopHeader.tsx");
const sidebar = read("frontend/components/cfo/Sidebar.tsx");
const shellStrings = JSON.parse(
  read("frontend/components/instrument/shell/shellStrings.json"),
);

// Strip comments so commented-out code can't trip (or hide behind) a law.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
const headerSrc = stripComments(topHeader);

// SHELL_NAV_ALL destinations — parsed from the source of truth literal.
const navBlock = sidebar.match(/SHELL_NAV_ALL[^=]*=\s*\[([\s\S]*?)\n\];/);
if (!navBlock) {
  fail("L2", "SHELL_NAV_ALL literal not found in Sidebar.tsx — the law lost its source of truth");
}
const navDests = navBlock
  ? [...navBlock[1].matchAll(/to:\s*"([^"]+)"/g)].map((m) => m[1])
  : [];
if (navBlock && navDests.length < 5) {
  fail("L2", `parsed only ${navDests.length} destinations from SHELL_NAV_ALL — parser or list broke`);
}

// ── L1 · no header-level Ask ───────────────────────────────────────────

const askWirings = [
  ...headerSrc.matchAll(/onClick=\{\s*(?:\(\s*\)\s*=>\s*)?onOpenAi\b/g),
];
if (askWirings.length > 0) {
  fail(
    "L1",
    `TopHeader.tsx wires onOpenAi to ${askWirings.length} rendered element(s) — ` +
      "Ask CFO AI's homes are the sidebar accent row (⌘J) and the palette, never the header bar",
  );
} else {
  pass("L1", "no header-level Ask CFO AI control");
}

// ── L2 · no destination duplicates ─────────────────────────────────────

const navigateTargets = [...headerSrc.matchAll(/navigate\(\s*["'`]([^"'`]+)["'`]/g)].map(
  (m) => m[1].split("?")[0],
);
const linkTargets = [...headerSrc.matchAll(/<(?:Nav)?Link[^>]*\sto=\{?["'`]([^"'`]+)["'`]/g)].map(
  (m) => m[1].split("?")[0],
);
const dests = new Set(navDests);
const dupes = [];
let dashboardNavigates = 0;
for (const t of navigateTargets) {
  if (t === "/dashboard") {
    dashboardNavigates += 1;
    if (dashboardNavigates > 1) dupes.push(`navigate("/dashboard") ×${dashboardNavigates} (only the brand mark is grandfathered)`);
    continue;
  }
  if (dests.has(t)) dupes.push(`navigate("${t}")`);
}
for (const t of linkTargets) {
  if (dests.has(t)) dupes.push(`<Link to="${t}">`);
}
if (dupes.length > 0) {
  fail("L2", `TopHeader.tsx duplicates sidebar destinations: ${dupes.join(", ")}`);
} else {
  pass("L2", `no SHELL_NAV_ALL destination re-wired in the header (${navDests.length} destinations checked)`);
}

// ── L3 · one ⌘K hint ───────────────────────────────────────────────────

for (const lang of ["en", "ro"]) {
  const hint = shellStrings?.[lang]?.shell?.palette?.hint ?? "";
  if (/⌘|\{\{mod\}\}|ctrl|cmd/i.test(hint)) {
    fail("L3", `shell.palette.hint (${lang}) repeats the shortcut: "${hint}" — the <kbd> is the ONE hint`);
  } else {
    pass("L3", `palette hint (${lang}) carries no shortcut text`);
  }
}
const kbdCount = (headerSrc.match(/<kbd[\s>]/g) ?? []).length;
if (kbdCount > 1) {
  fail("L3", `TopHeader.tsx renders ${kbdCount} <kbd> elements — exactly one (the ⌘K badge) is the law`);
} else {
  pass("L3", `TopHeader.tsx renders ${kbdCount} <kbd> element(s)`);
}

// ── verdict ────────────────────────────────────────────────────────────

console.log("header law — static tripwire (H2/H4)");
for (const line of ok) console.log(line);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  console.error(`\n${failures.length} violation(s). The PLACEMENT LAW is documented in design_review/header/GATES.md.`);
  process.exit(1);
}
console.log("  all clean.");
