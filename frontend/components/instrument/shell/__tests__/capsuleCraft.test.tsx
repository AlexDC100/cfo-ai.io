// THE CAPSULE / COMMAND BAR — CRAFT GATES, the jsdom half.
//
// Three claims that are cheaper and STRICTER to make against the real
// components than against a rendered page:
//
//   G3  NO NATIVE TOOLTIP — no row renders a `title` attribute. In the
//       browser a `title` is only visible after a hover delay; in the DOM
//       it is an attribute, and an attribute is a fact.
//   G4  NO CATEGORY COLUMN — the command bar (cmdbar/CmdbarList, the
//       component CommandPalette paints every row with since the 2026-09-26
//       rebuild) names a group ONCE, as a heading above its run of rows,
//       and never parks the group's name beside a row.
//   C4  every `title` inside the card is re-homed, not deleted.
//
// THE SPEND BOUNDARY (G7) LEFT THIS FILE WITH THE ANSWER MODE. The bar no
// longer answers in place: every group but "Întreabă CFO AI" is served
// facts from the cache, and that last row SENDS the question to the chat,
// which spends through its own pipeline. "The bar makes no model call, in
// any interaction" is held on the real surface by commandBar.test.tsx
// (cmdbar-no-model, and "Tab jumps to Ask CFO AI; Enter SENDS it").
//
// ── VACUITY ──────────────────────────────────────────────────────────
//
// Every "this is empty" assertion is preceded by a POSITIVE CONTROL on
// the same detector, and every count is checked against a floor AFTER the
// loop that produced it.

import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CapsuleJumpList, type CapsuleJumpItem } from "../capsuleEmpty/CapsuleJumpList";
import { suppressNativeTooltips } from "../CapsuleTooltipGuard";
import { CapsuleSuggestionList } from "../capsuleEmpty/CapsuleSuggestionList";
import type { CapsuleSuggestion } from "@/lib/capsuleSuggestions";
import { CmdbarList } from "../cmdbar/CmdbarList";
import type { BarRow } from "../cmdbar/cmdbarRows";
import i18n from "@/i18n";

const REPO_ROOT = resolve(__dirname, "../../../../..");

afterEach(() => {
  cleanup();
});

const SUGGESTIONS: readonly CapsuleSuggestion[] = Object.freeze([
  {
    id: "s-unattached", kind: "unattached",
    labelKey: "capsuleEmpty.suggest.unattached.simple", labelParams: { period: "Aug 2026" },
    basisKey: "capsuleEmpty.basis.unattached", priority: 90,
  },
  {
    id: "s-trust", kind: "trust",
    labelKey: "capsuleEmpty.suggest.trust.simple", labelParams: { period: "Dec 2025" },
    basisKey: "capsuleEmpty.basis.trust", priority: 80,
  },
  {
    id: "s-covenant", kind: "covenant",
    labelKey: "capsuleEmpty.suggest.covenant.simple", labelParams: {},
    basisKey: "capsuleEmpty.basis.covenant", priority: 70,
  },
] as unknown as readonly CapsuleSuggestion[]);

describe("G3 — no row renders a native `title` tooltip", () => {
  it("suggestion rows carry no title attribute", () => {
    render(<CapsuleSuggestionList suggestions={SUGGESTIONS} onPick={() => {}} />);
    const rows = screen.getAllByTestId("capsule-suggestion");

    // FLOOR, after the query. Zero rows would make "no row has a title"
    // true of nothing — the exact shape of the five gates this repo just
    // caught passing while examining nothing.
    expect(
      rows.length,
      "G3 VACUITY: CapsuleSuggestionList rendered no rows from three supplied " +
        "suggestions, so the tooltip ban was never tested.",
    ).toBe(SUGGESTIONS.length);

    const offenders = rows.flatMap((row) =>
      [row, ...Array.from(row.querySelectorAll("[title]"))]
        .filter((n) => n.getAttribute("title"))
        .map((n) => `${row.getAttribute("data-kind")}: title="${n.getAttribute("title")}"`),
    );
    expect(
      offenders,
      "G3: suggestion rows carry native browser tooltips:\n  " + offenders.join("\n  ") +
        "\nThe tooltip repeats the row's own visible label plus its basis line. " +
        "It appears after ~1s, unstyled, in the OS chrome, and never on touch. " +
        "The basis belongs in the row (or nowhere) — not in a second copy the " +
        "browser draws.",
    ).toEqual([]);
  });

  it("jump rows carry no title attribute", () => {
    const items: CapsuleJumpItem[] = [
      { id: "dashboard", label: "Dashboard" },
      { id: "scenarios", label: "Scenarios" },
      { id: "workspace", label: "Workspace" },
      { id: "benchmark", label: "Benchmark" },
    ];
    render(<CapsuleJumpList items={items} onPick={() => {}} />);
    const rows = screen.getAllByTestId("capsule-jump-row");
    expect(rows.length, "G3 VACUITY: no jump rows rendered").toBe(items.length);

    const offenders = rows.flatMap((row) =>
      [row, ...Array.from(row.querySelectorAll("[title]"))]
        .filter((n) => n.getAttribute("title"))
        .map((n) => `${row.textContent?.trim()}: title="${n.getAttribute("title")}"`),
    );
    expect(offenders, "G3: jump rows carry native browser tooltips:\n  " +
      offenders.join("\n  ")).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// G4 — NO CATEGORY COLUMN, ON THE COMPONENT THAT ACTUALLY PAINTS THE ROWS
// ══════════════════════════════════════════════════════════════════════
//
// TC-7 still holds: the renderer under test must be the one the reader
// sees. Since the rebuild that is `CmdbarList` — asserted below from the
// palette's own source, so a future move of the rows into another
// component fails here loudly instead of passing on a component nobody
// mounts (the defect this block once had with `CapsuleJumpList`).

describe("G4 — the command bar names a group once, never beside a row", () => {
  const ROWS: BarRow[] = [
    { kind: "answer", id: "answer:net_result", view: {
      id: "answer:net_result", label: "Net result", value: "7,5 mil.", absent: null, tag: "from account 121",
      change: { state: "ok", text: "+424.8% vs Dec 2024" }, ratios: ["Net margin 6.8%"], sector: null, basis: null,
      href: "/dashboard?tab=pl", served: { value: 1, source: "x", ratioKeys: [], sectorKey: null, columnKey: null } } },
    { kind: "account", id: "account:411101:ar", view: {
      id: "account:411101:ar", code: "411101", name: "Clienti int.TT", statement: "balance sheet", value: "308,3 K",
      absent: null, keyMetric: "Days sales outstanding 90 days", basis: null, href: "/dashboard?tab=balance_sheet",
      served: { amount: 1, metricKey: "dso" } } },
    { kind: "account", id: "account:411102:ar", view: {
      id: "account:411102:ar", code: "411102", name: "Clienti int.KA", statement: "balance sheet", value: "700,9 K",
      absent: null, keyMetric: null, basis: null, href: "/dashboard?tab=balance_sheet",
      served: { amount: 1, metricKey: "dso" } } },
    { kind: "page", id: "page:tab:pl", label: "P&L", href: "/dashboard?tab=pl" },
    { kind: "action", id: "action:upload", label: "Upload a trial balance" },
    { kind: "ask", id: "ask", query: "profit" },
  ];

  it("THE RENDERER UNDER TEST IS THE ONE THE PALETTE USES", () => {
    const src = readFileSync(resolve(REPO_ROOT, "frontend/components/instrument/shell/CommandPalette.tsx"), "utf-8");
    expect(src, "CommandPalette no longer paints its rows with CmdbarList — retarget G4 at the renderer it uses")
      .toMatch(/<CmdbarList\b/);
  });

  it("one heading per group, in order; no row carries its group's name", () => {
    render(<CmdbarList header="Searching X · Dec 2025" rows={ROWS} activeIdx={0} onActivate={() => {}}
                       onRun={() => {}} caveat={null} status={null} mode="typing" />);
    const options = screen.getAllByRole("option");
    expect(options.length, "G4 VACUITY: rows rendered").toBe(ROWS.length);
    const headings = screen.getAllByTestId(/cmdbar-heading-/);
    expect(headings.map((h) => h.getAttribute("data-testid"))).toEqual([
      "cmdbar-heading-answer", "cmdbar-heading-account", "cmdbar-heading-page",
      "cmdbar-heading-action", "cmdbar-heading-ask",
    ]);
    const t = i18n.getFixedT("en");
    const groupWords: Record<string, string> = {
      answer: t("cmdbar.group.answer"), account: t("cmdbar.group.account"),
      page: t("cmdbar.group.page"), action: t("cmdbar.group.action"),
    };
    // POSITIVE CONTROL: the heading text IS on screen, so the detector can see it.
    for (const w of Object.values(groupWords)) expect(document.body.textContent).toContain(w);
    const offenders = options.flatMap((o) => {
      const kind = o.getAttribute("data-row-kind") ?? "";
      const word = groupWords[kind];
      return word && (o.textContent ?? "").includes(word) ? [`${kind}: "${o.textContent}"`] : [];
    });
    expect(offenders, "G4: a row prints its group's name beside itself").toEqual([]);
    const titled = options.filter((o) => o.hasAttribute("title") || o.querySelector("[title]"));
    expect(titled, "G3 on the bar: a row carries a native tooltip").toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// COMPLAINT 4 — NO NATIVE TOOLTIP SURVIVES THE SURFACE'S BOUNDARY
// ══════════════════════════════════════════════════════════════════════
//
// Three of the five `title` sites on this surface were deleted where they
// are written. Two belong to files this lane may not edit
// (`lib/narrativeMoney.tsx`, `components/cfo/TraceableNumber.tsx`) and are
// re-homed by `suppressNativeTooltips` at the Capsule's boundary. This
// drives that function directly, because what needs proving is the
// RE-HOMING — a guard that deleted the strings would trade one defect for
// a worse one.

describe("complaint 4 — every `title` inside the card is re-homed, not deleted", () => {
  it("an interactive node keeps the string as its accessible name", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<button id="b" title="Open the source row">•</button>';
    const moved = suppressNativeTooltips(root);
    expect(moved, "the detector moved nothing — it cannot see a title").toBe(1);
    const b = root.querySelector("#b")!;
    expect(b.hasAttribute("title")).toBe(false);
    expect(b.getAttribute("aria-label")).toBe("Open the source row");
    expect(b.getAttribute("data-suppressed-title")).toBe("Open the source row");
  });

  it("a wrapper's string joins the one control it wraps", () => {
    // THE REAL SHAPE, from `narrativeMoney.tsx` + `TraceableNumber.tsx`:
    // a non-interactive money span carrying the FX basis, wrapping the
    // button that carries the jump-to-source description.
    const root = document.createElement("div");
    root.innerHTML =
      '<span data-narrative-money="total_assets" title="47.509.482,00 € · displayed at 1 RON = 0.1905 EUR">' +
      '<button title="View source: Total assets">47.509.482,00 €</button></span>';
    const moved = suppressNativeTooltips(root);
    expect(moved).toBe(2);
    expect(root.querySelectorAll("[title]").length,
      "complaint 4: a `title` survived inside the card").toBe(0);
    const name = root.querySelector("button")!.getAttribute("aria-label") ?? "";
    expect(name, "the FX basis was DELETED rather than re-homed — a mouse user " +
      "loses a disclosure the money discipline requires").toContain("0.1905");
    expect(name).toContain("View source");
  });

  it("POSITIVE CONTROL — the detector fires on a title it has not been taught", () => {
    const root = document.createElement("div");
    root.innerHTML = '<p title="something nobody predicted">x</p>';
    expect(suppressNativeTooltips(root)).toBe(1);
    expect(root.querySelectorAll("[title]").length).toBe(0);
  });
});
