// THE CAPSULE — CRAFT GATES, the jsdom half (Part F, lane 2).
//
// The browser half is `e2e/design/capsule-craft.spec.ts`. This file holds
// the three claims that are cheaper and STRICTER to make against the real
// components than against a rendered page:
//
//   G3  NO NATIVE TOOLTIP — no row renders a `title` attribute. In the
//       browser a `title` is only visible after a hover delay, so a live
//       gate has to synthesise the hover and hope; in the DOM it is an
//       attribute, and an attribute is a fact.
//   G4  NO CATEGORY COLUMN — the navigation row renders no right-aligned
//       section label, EVEN WHEN THE HOST SUPPLIES ONE. Driven with a
//       hint on every item on purpose: a gate that renders items without
//       hints proves only that the fixture had none.
//   G7  THE SPEND BOUNDARY, REPLANTED — press Enter on the REAL
//       `CommandPalette` and count what reaches the two seams by name.
//
// ── WHY G7 IS HERE AND NOT ONLY IN capsuleSpendBoundary.test.tsx ──────
//
// That file belongs to the speed lane and this lane may not edit it. The
// redesign moves the composer, changes what Enter is bound to, and
// rebuilds the empty state — every one of which is a way to reintroduce
// the defect it closed. A craft lane that changes the Enter boundary and
// owns no proof of the Enter boundary is a lane shipping on someone
// else's gate. So this is an INDEPENDENT restatement: different mount,
// different assertions, the same two seams named in the failure text.
//
// ── VACUITY ──────────────────────────────────────────────────────────
//
// Every "this is empty" assertion here is preceded by a POSITIVE CONTROL
// on the same detector, and every count is checked against a floor AFTER
// the loop that produced it. Five battery gates in this repo were just
// caught passing while examining nothing, including one whose canary sat
// inside its own discovery loop and therefore could never fire.
//
// NO MODEL SPEND. `fetch` is trapped and answered locally; the trap
// RECORDS, it never forwards.

import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Statements } from "@/lib/financialReport";

const REPO_ROOT = resolve(__dirname, "../../../../..");

/** REAL ENGINE OUTPUT — a served envelope captured through /api/period.
 *  Per this project's testing convention the numbers are the engine's;
 *  only the delivery channel is stubbed. */
const CARNIPROD = JSON.parse(
  readFileSync(
    resolve(REPO_ROOT, "frontend/lib/__tests__/fixtures/capsuleTier0/period_carniprod_fy2025.json"),
    "utf-8",
  ),
) as Statements;

// ── host context (provided, never the subject) ────────────────────────

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "user-under-test" } }) }));
vi.mock("@/lib/activeOrg", () => ({
  getActiveOrgId: () => "org-under-test",
  subscribeActiveOrg: () => () => {},
}));
vi.mock("@/lib/activePeriod", () => ({
  useActivePeriod: () => ({
    id: "p-2025", label: "Carniprod SRL", periodEnd: "2025-12-31", industry: null,
    statements: CARNIPROD, invoices: null, metrics: [], recommendations: [], alerts: [],
    briefing: null, availableTypes: [], isLoaded: true, isLoading: false, source: "upload",
    valuation: null, lineItems: [], detectedType: "trial_balance",
    sourceDocumentFilename: "carniprod_fy2025.xlsx",
  }),
}));
vi.mock("@/lib/usePeriodStepper", () => ({
  usePeriodStepper: () => ({
    periods: [{ period_id: "p-2025", period_end: "2025-12-31" }],
    selectedEnd: "2025-12-31", selectedMonth: "Dec 2025", selectedYear: "2025",
    prevTarget: null, nextTarget: null, showStepper: false, goToPeriod: () => {},
  }),
}));
vi.mock("@/lib/runStore", () => ({ useDailyRun: () => null }));
vi.mock("@/lib/bvbStaticUniverse", () => ({ staticBvbRows: () => [] }));
vi.mock("@/lib/cfoDerive", () => ({ flattenSkus: () => [] }));
vi.mock("@/components/cfo/Sidebar", () => ({
  useShellNav: () => [
    {
      key: "core", label: "Core",
      items: [{ to: "/dashboard", labelKey: "sidebar.dashboard", icon: undefined }],
    },
  ],
  SIDEBAR_TOGGLE_EVENT: "cfo-ai-sidebar-toggle",
}));
vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({
    display: "RON" as const,
    rates: { rates: { RON: 1, EUR: 5, USD: 4.6 }, as_of: "2026-08-01" },
    setDisplay: () => {}, refresh: async () => {}, refreshing: false,
  }),
}));

import { CommandPalette } from "../CommandPalette";
import { CapsuleJumpList, type CapsuleJumpItem } from "../capsuleEmpty/CapsuleJumpList";
import {
  CapsulePaletteRow,
  CAPSULE_ROW_FAMILIES,
  type CapsulePaletteRowItem,
} from "../CapsulePaletteRow";
import { suppressNativeTooltips } from "../CapsuleTooltipGuard";
import { CapsuleSuggestionList } from "../capsuleEmpty/CapsuleSuggestionList";
import type { CapsuleSuggestion } from "@/lib/capsuleSuggestions";
import { checkCapsuleAsk, resetCapsuleAskGuard } from "../capsuleEmpty/capsuleAskGuard";
import { __resetCapsuleThreadForTests } from "../capsuleAnswer/capsuleThread";

// ══════════════════════════════════════════════════════════════════════
// THE SEAMS — named, because a gate that says "something spent" and
// cannot say WHAT is a gate nobody can act on.
// ══════════════════════════════════════════════════════════════════════

const MODEL_SEAMS: readonly { label: string; match: RegExp }[] = Object.freeze([
  { label: "/api/capsule/tools/get_facts (engine tool endpoint)", match: /\/api\/capsule\/tools\// },
  { label: "functions/v1/chat-llm (Edge Function)", match: /functions\/v1\/chat-llm/ },
]);
const SEAM_NAMES = MODEL_SEAMS.map((s) => s.label).join(" · ");

interface FetchTrap { all: string[]; spend: () => string[]; restore: () => void }

/** Records every request and answers with a calm 503 so the pipeline
 *  degrades instead of hanging. The RECORD is the measurement; the
 *  response exists only so nothing waits forever. */
function trapFetch(): FetchTrap {
  const all: string[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = g.fetch;
  g.fetch = async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    all.push(url);
    return new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } });
  };
  return {
    all,
    spend: () => all.filter((u) => MODEL_SEAMS.some((s) => s.match.test(u))),
    restore: () => { g.fetch = saved; },
  };
}

const USER = "user-under-test";
/** True when a chat reservation was taken since the last reset. Read out
 *  of the guard's OWN ledger, not a spy. */
const reservationTaken = () => !checkCapsuleAsk(USER).allowed;

function mount() {
  const onOpenChange = vi.fn();
  render(
    <MemoryRouter>
      <CommandPalette open onOpenChange={onOpenChange} onOpenAi={() => {}} />
    </MemoryRouter>,
  );
  return { onOpenChange };
}

function typeAndEnter(question: string) {
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: question } });
  fireEvent.keyDown(input, { key: "Enter" });
}

let trap: FetchTrap;
beforeEach(() => {
  resetCapsuleAskGuard();
  __resetCapsuleThreadForTests();
  trap = trapFetch();
});
afterEach(() => {
  trap.restore();
  cleanup();
});

// ══════════════════════════════════════════════════════════════════════
// G3 — NO ROW CARRIES A NATIVE BROWSER TOOLTIP
// ══════════════════════════════════════════════════════════════════════
//
// `title` renders as an unstyled OS tooltip after a delay the design does
// not control, showing text the reader is already looking at. It is not
// an accessible name (screen readers announce the visible label), it is
// not keyboard-reachable, and on touch it does not exist at all. If the
// row's own label cannot say it, the row needs a better label.

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
// ── THE DEFECT THIS BLOCK USED TO HAVE (TC-7) ────────────────────────
//
// It drove `CapsuleJumpList`, asserted that a supplied `hint` never
// reached the DOM, and went green. It was green because `CapsuleJumpList`
// never printed a hint — and it never printed a hint because the round
// before had removed it there. Meanwhile `CommandPalette`'s own inline
// row renderer, the thing that paints EVERY row in the typing state,
// still printed `{item.hint}` right-aligned. Measured on the shipped
// build: 13 rows in the typing state at 1440, thirteen of thirteen
// carrying a trailing category word ("Cash Flow" ×7, "Liquidity" ×2,
// "Working Capital"); 13 of 13 at 390 too.
//
// Correct code. Wrong surface. A passing gate.
//
// So this block now drives `CapsulePaletteRow` — the component the
// palette actually renders, extracted into its own file precisely so a
// test can reach it — and it asserts the RENDERER'S IDENTITY as part of
// the check: every node examined must carry `data-row-source="palette-row"`.
// A future move of the row into some other component fails here loudly
// instead of passing quietly.

describe("G4 — the palette row prints no category column", () => {
  /** The five shapes the host actually builds, each carrying the string
   *  the old `hint` field would have parked against the right edge. */
  const ROWS: { item: CapsulePaletteRowItem; wasHint: string }[] = [
    { item: { id: "page", family: "page", group: "Pages", label: "Dashboard",
              searchText: "Overview", run: () => {} }, wasHint: "Overview" },
    { item: { id: "concept", family: "concept", group: "Learn", label: "Free cash flow",
              searchText: "Cash Flow", run: () => {} }, wasHint: "Cash Flow" },
    { item: { id: "period", family: "period", group: "Recent periods", label: "Dec 2025",
              searchText: "Switch period", run: () => {} }, wasHint: "Switch period" },
    { item: { id: "cat", family: "category", group: "Products", label: "Salami",
              searchText: "Category", run: () => {} }, wasHint: "Category" },
    // The bucket badge's row. `searchText` carries the exact word the
    // `<BucketChip>` used to paint against the right edge, so the check
    // below is a REAL one: a string the host supplied, that the reader
    // must not see. Given `searchText: "SKU"` instead, "Protect" would
    // be a word no code path could ever print and the assertion would
    // pass by construction.
    { item: { id: "sku", family: "sku", group: "Products", label: "Core 200g",
              searchText: "Protect", run: () => {} }, wasHint: "Protect" },
    { item: { id: "co", family: "company", group: "Companies", label: "Banca Transilvania",
              qualifier: "TLV", searchText: "Open company", run: () => {} },
      wasHint: "Open company" },
  ];

  const renderAll = () =>
    render(
      <ul>
        {ROWS.map(({ item }, i) => (
          <li key={item.id}>
            <CapsulePaletteRow item={item} index={i} active={false} onActivate={() => {}} />
          </li>
        ))}
      </ul>,
    );

  it("THE RENDERER UNDER TEST IS THE ONE THE PALETTE USES", () => {
    renderAll();
    const rows = screen.getAllByRole("option");
    // FLOOR after the query, against the total — never inside a loop.
    expect(
      rows.length,
      `G4 VACUITY: ${rows.length} rows rendered from ${ROWS.length} items.`,
    ).toBe(ROWS.length);

    const sources = rows.map((r) => r.getAttribute("data-row-source"));
    const tally: Record<string, number> = {};
    for (const src of sources) tally[src ?? "UNSTAMPED"] = (tally[src ?? "UNSTAMPED"] ?? 0) + 1;

    expect(
      tally,
      "TC-7: the nodes under test were painted by " + JSON.stringify(tally) +
        ".\nThis gate is only worth its green if the component it drives is the " +
        "component the reader sees. The last round asserted a row-level fix " +
        "against `CapsuleJumpList`, which paints zero rows in the state that " +
        "was complained about, while `CommandPalette` painted thirteen with " +
        "the defect intact.",
    ).toEqual({ "palette-row": ROWS.length });
  });

  it("no supplied string is parked against the row's right edge", () => {
    renderAll();
    const rows = screen.getAllByRole("option");
    expect(rows.length).toBe(ROWS.length);

    // POSITIVE CONTROL on the same detector: the LABEL does reach the
    // DOM. Without it, "the category is absent" is satisfied by a row
    // that rendered nothing at all.
    for (const { item } of ROWS) {
      expect(
        screen.queryByText(new RegExp(item.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))),
        `G4 CONTROL: the row label "${item.label}" is missing, so the absence of ` +
          `a category below proves nothing about categories.`,
      ).not.toBeNull();
    }

    const printed = ROWS.flatMap(({ item, wasHint }, i) => {
      const text = rows[i].textContent ?? "";
      return text.includes(wasHint) ? [`${item.label} → "${wasHint}"`] : [];
    });

    expect(
      printed,
      `G4: ${printed.length} row(s) print the string the old category column ` +
        `carried:\n  ${printed.join("\n  ")}\n` +
        `The trailing word names the group the row was filed under — the reader ` +
        `is looking for the row, not for the menu it lives in — and it gives ` +
        `every row the same two-column rhythm, which is what makes eight ` +
        `different choices read as one undifferentiated list.`,
    ).toEqual([]);
  });

  it("every row DECLARES its family, and the declared set is the whole set", () => {
    renderAll();
    const rows = screen.getAllByRole("option");
    expect(rows.length, "G4 VACUITY: nothing rendered.").toBe(ROWS.length);

    const stamped = rows.map((r) => r.getAttribute("data-row-family"));
    expect(
      stamped.filter((f) => f === null).length,
      `TC-6: ${stamped.filter((f) => f === null).length} row(s) painted with no ` +
        `\`data-row-family\`. G4's live sweep floors itself PER FAMILY — a row ` +
        `that cannot name its family is a row no expectation can be recorded ` +
        `for, which is how twenty offending Product rows sat under a green ` +
        `nine-query sweep.`,
    ).toBe(0);
    expect(
      stamped.filter((f) => !CAPSULE_ROW_FAMILIES.includes(f as never)),
      "TC-6: a row declared a family that is not in `CAPSULE_ROW_FAMILIES`.",
    ).toEqual([]);
    // The stamp is the ITEM's, not a constant: two different items must
    // not stamp the same word, or the census cannot tell them apart.
    expect(new Set(stamped).size).toBe(ROWS.length);
  });

  it("a qualifier is part of the row's NAME, inline, not a right-hand column", () => {
    renderAll();
    const qualifiers = screen.getAllByTestId("capsule-row-qualifier");
    // The ticker is the one second string that survives, and it must
    // still be on screen — deleting information is not the same fix as
    // deleting decoration.
    expect(
      qualifiers.length,
      "G4 VACUITY: no qualifier rendered, so 'the qualifier is inline' is a " +
        "claim about nothing. The company row's ticker must still be painted.",
    ).toBe(1);
    expect(qualifiers[0].textContent).toContain("TLV");

    // INLINE means: inside the same truncating element as the label. A
    // sibling of the label is free to be pushed to the right edge by a
    // `flex-1`; a child of it is not.
    //
    // The row is found BY ITS QUALIFIER rather than by index: this array
    // was indexed at [4] and a SKU row was later inserted at [4], which
    // would have silently moved this assertion onto a row that has no
    // qualifier and made `contains()` false for the wrong reason.
    const row = screen.getAllByRole("option")
      .find((r) => r.contains(qualifiers[0]))!;
    const label = row.querySelector(".flex-1");
    expect(
      label?.contains(qualifiers[0]),
      "G4: the qualifier is a SIBLING of the label, not part of it. A sibling " +
        "is one `flex-1` away from being a right-aligned column again, which " +
        "is exactly the shape that was removed.",
    ).toBe(true);
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

// ══════════════════════════════════════════════════════════════════════
// G7 — THE SPEND BOUNDARY, REPLANTED ON THE REDESIGNED SURFACE
// ══════════════════════════════════════════════════════════════════════

// G7.a — THE DETECTOR CAN FAIL.
//
// Before asserting that Tier-0 questions spend nothing, prove the harness
// can SEE a spend. Both detectors — the wire and the reservation ledger —
// must fire on a question Tier 0 must refuse.
describe("G7.a — the detector fires on a question that MUST reach the model", () => {
  it("an interpretation request takes a reservation and hits a named seam", async () => {
    mount();
    expect(reservationTaken()).toBe(false);

    typeAndEnter("why is cash down this month?");

    await waitFor(() => {
      expect(
        trap.spend().length,
        `G7 PLANT: no request reached ${SEAM_NAMES} for a question Tier 0 ` +
          `refuses. If a real spend cannot be seen here, every zero below is ` +
          `vacuous.`,
      ).toBeGreaterThan(0);
    });

    expect(
      reservationTaken(),
      "G7 PLANT: no chat reservation was taken for a question that reached the " +
        "model. `reserveCapsuleAsk` is the ledger the burst guard bills against; " +
        "if it stays empty the second detector is blind.",
    ).toBe(true);
  });
});

// G7.b — TIER 0 SPENDS NOTHING AT THE ENTER BOUNDARY.
//
// The questions are Tier-0-resolvable against THIS workspace: a bare
// metric, an opener-wrapped metric, a derived metric, a Romanian metric,
// and a workspace-meta question. Each is typed into the real input and
// committed with a real Enter.
const TIER0_QUESTIONS: readonly string[] = Object.freeze([
  "total assets",
  "how much cash do we have",
  "what is our working capital",
  "cifra de afaceri",
  "is it balanced",
]);

describe("G7.b — Enter on a Tier-0 question issues no model request", () => {
  for (const question of TIER0_QUESTIONS) {
    it(`"${question}" — zero reservations, zero seam requests, full answer`, async () => {
      mount();
      typeAndEnter(question);

      const turn = await screen.findByTestId("capsule-turn");
      // Let any stray async dispatch land before reading the detectors,
      // or the gate passes by being EARLY rather than by being right.
      await new Promise((r) => setTimeout(r, 60));

      // ── ORDER MATTERS, and it was measured ─────────────────────────
      //
      // The SPEND assertions come first. When the plant (disabling the
      // short-circuit in `enterAnswerMode`) was applied, an earlier
      // draft of this test asserted the fact card first — so the red it
      // produced was `Unable to find [data-testid="capsule-fact-card"]`,
      // which is TRUE (the model path 503s in the trap and paints no
      // card) and tells the reader nothing about money. A gate whose red
      // does not name the defect gets diagnosed as a flaky test.
      //
      // Spend first, canvas second, and both in the same test: if spend
      // is zero the canvas check then refuses the vacuous pass, and if
      // spend is non-zero the reader is told which seam took the money.
      expect(
        trap.spend(),
        `G7/K10: Enter on "${question}" reached a model seam. Observed:\n  ` +
          (trap.spend().join("\n  ") || "(none)") +
          `\nThe seams that must stay silent: ${SEAM_NAMES}.\n` +
          `Tier 0 already holds this answer, with provenance, in microseconds — ` +
          `paying for it is paying twice for a figure the client had.`,
      ).toEqual([]);

      expect(
        reservationTaken(),
        `G7/K10: Enter on "${question}" took a chat reservation. A reservation is ` +
          `budget spent whether or not a request follows, and Tier 0's contract ` +
          `is "works offline / credits-down".`,
      ).toBe(false);

      // THE ANSWER IS REAL. A zero-spend assertion over an empty canvas
      // is the vacuous pass this whole section exists to refuse.
      expect(
        within(turn).getByTestId("capsule-fact-card"),
        `G7: "${question}" spent nothing because it answered nothing.`,
      ).toBeTruthy();
      // IT SAYS WHERE IT CAME FROM. Deliberately not "it has a
      // provenance DOT": the dot hangs on a figure, and "is it balanced"
      // resolves to a VERDICT with no figure to hang one on. It still
      // carries a citation and the Tier-0 note, which is the invariant —
      // C3 is "every answer traces to a fact", not "every answer wears a
      // particular ornament". Asserting the ornament would have made
      // this gate fail on a correct answer, which is how a gate teaches
      // the next lane to delete it.
      const attribution = [
        "capsule-provenance-dot", "capsule-citation", "capsule-tier0-note",
      ].filter((id) => within(turn).queryAllByTestId(id).length > 0);
      expect(
        attribution,
        `G7: the Tier-0 turn for "${question}" says nowhere where it came from — ` +
          `no provenance dot, no citation, no Tier-0 note. A free answer without ` +
          `a source is not the cheap version of a good answer, it is a rumour ` +
          `rendered quickly.`,
      ).not.toEqual([]);
    });
  }
});

// G7.c — THE ONE DOOR TO TIER 1 IS THE READER'S OWN KEYSTROKE.
describe("G7.c — a Tier-0 answer offers a route to interpretation, and only that spends", () => {
  it("the chip exists, is not local, and spends only when clicked", async () => {
    mount();
    typeAndEnter("total assets");

    const chips = await screen.findAllByTestId("capsule-followup-chip");
    expect(
      chips.length,
      "G7 VACUITY: the Tier-0 turn offered no follow-up chips at all, so the " +
        "assertions about which chip spends have nothing to stand on.",
    ).toBeGreaterThan(0);

    const interpret = chips.find((c) => c.getAttribute("data-kind") === "interpret");
    expect(
      interpret,
      "G7: a Tier-0 answer offered no route to the interpretation. The figure is " +
        "on screen without a reading of it, so the reader needs a deliberate " +
        "one-keystroke way to ask for one — otherwise the honest cheap answer is " +
        "a dead end and they retype the question.",
    ).toBeTruthy();

    // Still nothing spent — the chip is an OFFER, not a dispatch.
    expect(trap.spend()).toEqual([]);
    expect(reservationTaken()).toBe(false);

    fireEvent.click(interpret!);
    await waitFor(() => {
      expect(
        trap.spend().length,
        `G7: activating the interpretation chip reached neither ${SEAM_NAMES}. A ` +
          `chip that promises a reading and delivers nothing is worse than no chip.`,
      ).toBeGreaterThan(0);
    });
    expect(reservationTaken()).toBe(true);
  });
});
