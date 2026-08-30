#!/usr/bin/env node
/**
 * check_header_law.mjs — the static tripwire for the PLACEMENT LAW,
 * AND the single definition of the header census the live gate counts
 * with (no browser, no test runner — runs in CI in <100ms).
 *
 * The runtime halves live in:
 *   · frontend/components/cfo/__tests__/headerLaw.test.tsx  (H1s/H2/H3/H4/H7 DOM)
 *   · e2e/design/header.spec.ts                             (H0/H1/H4/H5/H6 live)
 * Both IMPORT the census from this file, so "what counts as a header
 * control" is written down exactly once.
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
 *   L4  the dial is OUT of the bar: TopHeader.tsx renders no <ModeSwitch/>
 *       (Part E, 2026-08-30). Importing `useViewModeSync` is required and
 *       explicitly allowed — it is a hook with no UI.
 *   L5  CENSUS HYGIENE (the anti-double-count law). The selector list may
 *       not repeat an entry, and every COMPOSITE selector must also be an
 *       INTERACTIVE selector — never appended to the result as a second
 *       pass. This law exists because a collapse-fix once appended
 *       [role="radiogroup"] a second time and the census reported 6 for a
 *       5-control header: a gate that reports a violation which does not
 *       exist is as bad as a false green, because the next person
 *       silences it.
 *   L6  NO STALE / UNCLASSIFIED SELECTORS (the anti-false-green law).
 *       e2e/design/header.spec.ts must classify every data-testid it
 *       touches into REQUIRED_TESTIDS (must exist) or BANNED_TESTIDS
 *       (must not). Every REQUIRED id must appear as a data-testid in
 *       frontend/ source — a presence gate aimed at a deleted element is
 *       a false green of the same class as a double count. Every BANNED
 *       id must be absent from TopHeader.tsx.
 *
 * Exit 0 clean; exit 1 with one ✗ line per violation.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf-8");

// ══════════════════════════════════════════════════════════════════════
// THE CENSUS — one definition, imported by both runtime gates.
// ══════════════════════════════════════════════════════════════════════

/**
 * What counts as a header control.
 *
 * Two kinds of entry, and the difference matters for L6:
 *   · ROLE selectors (button, a[href], [role="radiogroup"], …) describe a
 *     CLASS of control. They are a taxonomy, not a list of elements the
 *     header is expected to have, so "nothing currently matches" is not
 *     staleness — it is the gate standing ready. [role="radiogroup"] is
 *     kept for exactly this reason after the Simple|Pro dial left the bar.
 *   · IDENTITY selectors ([data-testid="…"]) name ONE element. Those go
 *     stale, and L6 hunts them.
 *
 * The only identity selector here is the Capsule, which is listed because
 * it is a COMPOSITE: one pill the user scans once, holding the trust dot
 * and the command bar. Same precedent as the radiogroup — a segmented
 * control is one control.
 */
export const INTERACTIVE_SELECTORS = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  '[role="radiogroup"]',
  '[role="combobox"]',
  '[data-testid="header-capsule"]',
];

/**
 * Composite widgets: they match INTERACTIVE_SELECTORS themselves and
 * therefore count ONCE on their own; their interactive descendants are
 * swallowed by the top-level rule. NEVER append these to the result
 * separately — that is the double-count bug L5 exists to prevent.
 *
 * A composite is bounded: H1b (in the e2e spec) caps the interactive
 * descendants inside one at MAX_COMPOSITE_CHILDREN, so "collapse to one"
 * can never become a hiding place for a growing control cluster.
 */
export const COMPOSITE_SELECTORS = ['[role="radiogroup"]', '[data-testid="header-capsule"]'];

export const MAX_COMPOSITE_CHILDREN = 2;

/**
 * Count the top-level interactive elements inside `rootEl`.
 *
 * SELF-CONTAINED ON PURPOSE: Playwright serialises this function to the
 * page, so it may close over nothing. Both the live gate (Playwright) and
 * the DOM gate (vitest/jsdom) call it with the same arguments.
 *
 * An element counts when ALL of:
 *   1. it matches the interactive selector set;
 *   2. it is visible (non-zero rect, not display:none / visibility:hidden)
 *      — so `lg:hidden` affordances do not count at 1440;
 *   3. it is not inside an open overlay (dialog / menu / radix popper) —
 *      popover interiors are second-level homes;
 *   4. no ancestor inside the header also matches the set (so composites
 *      collapse to one, and one extra wrapper <div> can never change the
 *      count — the rule is deliberately NOT depth-limited).
 *
 * `args.structural: true` drops clause 2. jsdom has NO LAYOUT — every
 * rect is 0×0 and Tailwind's responsive classes are never resolved, so a
 * visibility clause there would return an empty census and read as a
 * green. The DOM gate therefore censuses STRUCTURE (what exists, how it
 * nests, what a composite swallows) and the LIVE gate owns responsive
 * truth. Each says which it is; neither pretends to be the other.
 */
export function headerCensus(rootEl, args) {
  const sel = args.selectors.join(", ");
  const inOverlay = (el) =>
    !!el.closest('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]');
  const visible = (el) => {
    if (args.structural) return true;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
  };
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role"),
    testid: el.getAttribute("data-testid"),
    aria: el.getAttribute("aria-label"),
    text: (el.textContent ?? "").trim().slice(0, 40),
  });
  const all = [...rootEl.querySelectorAll(sel)].filter((el) => visible(el) && !inOverlay(el));
  // ONE filter, ONE pass. Nothing is pushed back in afterwards.
  const topLevel = all.filter((el) => {
    let p = el.parentElement;
    while (p && p !== rootEl) {
      if (p.matches(sel)) return false;
      p = p.parentElement;
    }
    return true;
  });
  // Composite interiors, reported so H1b can bound them.
  const composites = [...rootEl.querySelectorAll(args.composites.join(", "))]
    .filter((el) => visible(el) && !inOverlay(el))
    .map((el) => ({
      ...describe(el),
      children: [...el.querySelectorAll(sel)].filter(visible).map(describe),
    }));
  return { count: topLevel.length, items: topLevel.map(describe), composites };
}

/** Pretty one-line-per-element inventory — the evidence a census run
 *  must paste, pass or fail. */
export function formatCensus(census) {
  return census.items
    .map(
      (i, n) =>
        `  ${n + 1}. <${i.tag}> testid=${i.testid} role=${i.role} aria="${i.aria}" text="${i.text}"`,
    )
    .join("\n");
}

// ══════════════════════════════════════════════════════════════════════
// THE STATIC TRIPWIRE (CLI)
// ══════════════════════════════════════════════════════════════════════

function runLint() {
  const failures = [];
  const ok = [];
  const fail = (law, msg) => failures.push(`  ✗ [${law}] ${msg}`);
  const pass = (law, msg) => ok.push(`  ✓ [${law}] ${msg}`);

  // ── inputs ───────────────────────────────────────────────────────────

  const topHeader = read("frontend/components/cfo/TopHeader.tsx");
  const sidebar = read("frontend/components/cfo/Sidebar.tsx");
  const spec = read("e2e/design/header.spec.ts");
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
  const specSrc = stripComments(spec);

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

  // ── L1 · no header-level Ask ─────────────────────────────────────────

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

  // ── L2 · no destination duplicates ───────────────────────────────────

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
      if (dashboardNavigates > 1)
        dupes.push(`navigate("/dashboard") ×${dashboardNavigates} (only the brand mark is grandfathered)`);
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

  // ── L3 · one ⌘K hint ─────────────────────────────────────────────────

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

  // ── L4 · the dial is out of the bar ──────────────────────────────────

  const dialRenders = (headerSrc.match(/<ModeSwitch\b/g) ?? []).length;
  if (dialRenders > 0) {
    fail(
      "L4",
      `TopHeader.tsx renders <ModeSwitch/> ×${dialRenders} — the Simple|Pro dial's homes are the ` +
        "avatar menu, Settings > Appearance and the ⌘K palette action (MODE_PALETTE_ACTION). " +
        "It is the one header candidate that is not needed on every screen of every session.",
    );
  } else if (!/useViewModeSync\s*\(\s*\)/.test(headerSrc)) {
    fail(
      "L4",
      "TopHeader.tsx no longer calls useViewModeSync() — the dial's cross-device adoption is seated " +
        "here precisely because the avatar menu's content mounts lazily. Removing it silently kills " +
        "remote view-mode adoption.",
    );
  } else {
    pass("L4", "no <ModeSwitch/> in the bar; useViewModeSync() still seated");
  }

  // ── L5 · census hygiene (anti-double-count) ──────────────────────────

  const dupSelectors = INTERACTIVE_SELECTORS.filter((s, i) => INTERACTIVE_SELECTORS.indexOf(s) !== i);
  const dupComposites = COMPOSITE_SELECTORS.filter((s, i) => COMPOSITE_SELECTORS.indexOf(s) !== i);
  const orphanComposites = COMPOSITE_SELECTORS.filter((s) => !INTERACTIVE_SELECTORS.includes(s));
  if (dupSelectors.length || dupComposites.length) {
    fail(
      "L5",
      `census selector list repeats ${[...dupSelectors, ...dupComposites].join(", ")} — a repeated ` +
        "selector double-counts its element and reports a violation that does not exist",
    );
  } else if (orphanComposites.length) {
    fail(
      "L5",
      `composite selector(s) ${orphanComposites.join(", ")} are not in INTERACTIVE_SELECTORS — a ` +
        "composite must be matched by the ONE pass, never appended to the result afterwards",
    );
  } else {
    pass(
      "L5",
      `${INTERACTIVE_SELECTORS.length} selectors, no repeats; ${COMPOSITE_SELECTORS.length} composite(s) all inside the set`,
    );
  }

  // ── L6 · no stale / unclassified selectors (anti-false-green) ────────

  const listLiteral = (name) => {
    const m = specSrc.match(new RegExp(`${name}\\s*(?::[^=]*)?=\\s*\\[([\\s\\S]*?)\\]`));
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null;
  };
  const required = listLiteral("REQUIRED_TESTIDS");
  const conditional = listLiteral("CONDITIONAL_TESTIDS");
  const banned = listLiteral("BANNED_TESTIDS");

  if (!required || !conditional || !banned) {
    fail(
      "L6",
      "e2e/design/header.spec.ts must declare REQUIRED_TESTIDS, CONDITIONAL_TESTIDS and " +
        "BANNED_TESTIDS literals — without them, every selector in the spec is unclassified and " +
        "staleness cannot be detected",
    );
  } else {
    // 6a — every REQUIRED id exists somewhere in frontend/ source.
    const sources = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "__tests__") continue;
        const p = path.join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?)$/.test(name)) sources.push(readFileSync(p, "utf-8"));
      }
    };
    walk(path.join(ROOT, "frontend"));
    const blob = sources.join("\n");
    const mustExist = [...required, ...conditional];
    const missing = mustExist.filter((id) => {
      // Literal:            data-testid="sidebar-chat"
      if (blob.includes(`data-testid="${id}"`)) return false;
      // Threaded as a prop: <Row testId="sidebar-theme-toggle" /> where
      // the shared Row renders data-testid={testId}. Common enough in
      // this codebase that ignoring it would make L6 cry wolf.
      if (/testid=/i.test(blob) && new RegExp(`testId=["']${id}["']`).test(blob)) return false;
      // Template-built:     data-testid={`mode-switch-${opt.value}`}
      const stem = id.replace(/-[a-z0-9]+$/i, "");
      return !blob.includes("data-testid={`" + stem + "-$");
    });
    if (missing.length) {
      fail(
        "L6",
        `REQUIRED/CONDITIONAL testids point at element(s) that no longer exist in frontend/: ` +
          `${missing.join(", ")} — a presence gate aimed at a deleted element passes vacuously or ` +
          "fails for the wrong reason",
      );
    } else {
      pass("L6a", `all ${mustExist.length} required+conditional testids exist in frontend/ source`);
    }

    // 6b — every BANNED id is absent from the header.
    const resurrected = banned.filter((id) => headerSrc.includes(`"${id}"`));
    if (resurrected.length) {
      fail("L6", `BANNED_TESTIDS present in TopHeader.tsx: ${resurrected.join(", ")}`);
    } else {
      pass("L6b", `all ${banned.length} banned testids absent from TopHeader.tsx`);
    }

    // 6c — no unclassified selector anywhere in the spec.
    const used = new Set(
      [
        ...[...specSrc.matchAll(/getByTestId\(\s*"([^"]+)"/g)].map((m) => m[1]),
        ...[...specSrc.matchAll(/\[data-testid="([^"]+)"\]/g)].map((m) => m[1]),
      ]
        // Interpolated selectors (`[data-testid="${id}"]`) are the loop
        // BODY of a check whose ids come from one of the classified
        // lists — the list entries are what L6 classifies, not the loop.
        .filter((id) => !id.includes("${")),
    );
    const classified = new Set([...required, ...conditional, ...banned]);
    const unclassified = [...used].filter((id) => !classified.has(id));
    if (unclassified.length) {
      fail(
        "L6",
        `header.spec.ts uses unclassified testid(s): ${unclassified.join(", ")} — add each to ` +
          "REQUIRED_TESTIDS (must exist) or BANNED_TESTIDS (must not), so the next deletion trips a gate",
      );
    } else {
      pass("L6c", `every testid the spec touches is classified (${used.size} distinct)`);
    }
  }

  // ── verdict ──────────────────────────────────────────────────────────

  console.log("header law — static tripwire (L1–L6)");
  for (const line of ok) console.log(line);
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    console.error(
      `\n${failures.length} violation(s). The PLACEMENT LAW is documented in design_review/header/GATES.md.`,
    );
    process.exit(1);
  }
  console.log("  all clean.");
}

// Run the lint only when invoked as a CLI. Imported (by header.spec.ts and
// headerLaw.test.tsx, for the census) this file is side-effect free.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) runLint();
