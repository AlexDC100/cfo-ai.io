// THE CAPSULE — THE SPEND BOUNDARY (K10).
//
// ══ WHY THIS GATE EXISTS, AND WHY THE OTHER ONES DID NOT CATCH IT ═══════
//
// K3 measures `resolveTier0` in isolation and reports a coverage
// percentage. K9 measures `routeQuery` in isolation and asserts
// `willCallModel`. Both were green while the shipped surface spent a
// model call on every question Tier 0 could already answer, because
// `enterAnswerMode` called `askModel` unconditionally and nothing
// consulted the resolver at the Enter boundary.
//
// Those are different claims. "The resolver can answer this for free" is
// not "the product answers this for free". The gap between them is where
// the money went, so this gate measures the second one:
//
//     PRESS ENTER ON THE REAL COMPONENT.
//     COUNT WHAT REACHES THE MODEL SEAMS.
//
// ══ WHAT IS REAL HERE AND WHAT IS PROVIDED ═════════════════════════════
//
// REAL — the whole subject under test:
//   · `CommandPalette` itself, rendered and driven by keyboard
//   · `capsuleRouter`, `capsuleFactIndex`, `capsuleTier0` — untouched
//   · `capsuleAskGuard` — the reservation ledger is REAL module state,
//     read back through `checkCapsuleAsk`. No spy, no mock: a taken
//     reservation is observed in the guard's own memory.
//   · `useCapsuleAnswer` / `capsuleThread` / `CapsuleAnswerPanel`
//   · `fetch` — trapped and recorded, never replaced with a fake client
//
// PROVIDED — the host context a mounted palette needs, and nothing else:
//   which period is open, which rows the rail offers, who the user is.
//   None of it is the subject, and the one that matters — the period's
//   STATEMENTS — is REAL ENGINE OUTPUT loaded from the same served
//   fixture the speed lane's own suite uses
//   (`__tests__/fixtures/capsuleTier0/period_carniprod_fy2025.json`,
//   captured through the real `/api/period` composition). Per the
//   project's testing convention, the numbers are the engine's; only the
//   delivery channel is stubbed.
//
// NO MODEL SPEND. Anthropic credits are live and billing. Every request
// this file provokes is answered by the trap, and the trap records
// rather than forwards.

import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Statements } from "@/lib/financialReport";

const REPO_ROOT = resolve(__dirname, "../../../../..");

/** REAL ENGINE OUTPUT — a served envelope captured through /api/period. */
const CARNIPROD = JSON.parse(
  readFileSync(
    resolve(
      REPO_ROOT,
      "frontend/lib/__tests__/fixtures/capsuleTier0/period_carniprod_fy2025.json",
    ),
    "utf-8",
  ),
) as Statements;

// ── host context (provided, not faked-under-test) ──────────────────────

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "user-under-test" } }) }));
vi.mock("@/lib/activeOrg", () => ({
  getActiveOrgId: () => "org-under-test",
  subscribeActiveOrg: () => () => {},
}));
vi.mock("@/lib/activePeriod", () => ({
  useActivePeriod: () => ({
    id: "p-2025",
    label: "Carniprod SRL",
    periodEnd: "2025-12-31",
    industry: null,
    statements: CARNIPROD,
    invoices: null,
    metrics: [],
    recommendations: [],
    alerts: [],
    briefing: null,
    availableTypes: [],
    isLoaded: true,
    isLoading: false,
    source: "upload",
    valuation: null,
    lineItems: [],
    detectedType: "trial_balance",
    sourceDocumentFilename: "carniprod_fy2025.xlsx",
  }),
}));
vi.mock("@/lib/usePeriodStepper", () => ({
  usePeriodStepper: () => ({
    periods: [{ period_id: "p-2025", period_end: "2025-12-31" }],
    selectedEnd: "2025-12-31",
    selectedMonth: "Dec 2025",
    selectedYear: "2025",
    prevTarget: null,
    nextTarget: null,
    showStepper: false,
    goToPeriod: () => {},
  }),
}));
vi.mock("@/lib/runStore", () => ({ useDailyRun: () => null }));
vi.mock("@/lib/bvbStaticUniverse", () => ({ staticBvbRows: () => [] }));
vi.mock("@/lib/cfoDerive", () => ({ flattenSkus: () => [] }));
vi.mock("@/components/cfo/Sidebar", () => ({
  useShellNav: () => [
    {
      key: "core",
      label: "Core",
      items: [{ to: "/dashboard", labelKey: "sidebar.dashboard", icon: undefined }],
    },
  ],
  SIDEBAR_TOGGLE_EVENT: "cfo-ai-sidebar-toggle",
}));
vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({
    display: "RON" as const,
    rates: { rates: { RON: 1, EUR: 5, USD: 4.6 }, as_of: "2026-08-01" },
    setDisplay: () => {},
    refresh: async () => {},
    refreshing: false,
  }),
}));

import { CommandPalette } from "../CommandPalette";
import {
  checkCapsuleAsk,
  resetCapsuleAskGuard,
} from "../capsuleEmpty/capsuleAskGuard";
import { __resetCapsuleThreadForTests } from "../capsuleAnswer/capsuleThread";

// ══════════════════════════════════════════════════════════════════════
// THE SEAMS
// ══════════════════════════════════════════════════════════════════════
//
// The two the gates lane already named, by the substring that identifies
// them in a URL. Everything else a mounted palette might fetch (fonts,
// Supabase auth, telemetry) is recorded but NOT counted as spend —
// counting it would make the gate fail for reasons that have nothing to
// do with a model call, and a gate that cries wolf gets deleted.

const MODEL_SEAMS: readonly { label: string; match: RegExp }[] = Object.freeze([
  { label: "engine tool endpoint", match: /\/api\/capsule\/tools\// },
  { label: "chat-llm Edge Function", match: /functions\/v1\/chat-llm/ },
]);

interface FetchTrap {
  all: string[];
  spend: () => string[];
  restore: () => void;
}

/** Records every request and answers it with a calm 503 so the pipeline
 *  degrades instead of hanging. The RECORD is the measurement; the
 *  response only exists so nothing waits forever. */
/** How long the trap holds a request before answering.
 *
 *  Zero for every gate whose subject is "did this request happen at
 *  all". Non-zero for K10.f, whose subject is what the surface does
 *  WHILE a turn is in flight — with an instant answer the first turn is
 *  already finished by the time the second Enter is pressed, and the
 *  gate would then be measuring nothing. Reset in `beforeEach`. */
let trapDelayMs = 0;

function trapFetch(): FetchTrap {
  const all: string[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = g.fetch;
  g.fetch = async (input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : String((input as { url?: string })?.url ?? input);
    all.push(url);
    if (trapDelayMs > 0) await new Promise((r) => setTimeout(r, trapDelayMs));
    return new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } });
  };
  return {
    all,
    spend: () =>
      all.filter((u) => MODEL_SEAMS.some((s) => s.match.test(u))),
    restore: () => {
      g.fetch = saved;
    },
  };
}

/** True when a chat reservation was taken since the last reset. Read out
 *  of the guard's OWN ledger — `reserveCapsuleAsk` records a timestamp
 *  and `checkCapsuleAsk` then reports a cooldown, so an untaken
 *  reservation is `allowed: true` and a taken one is not. */
function reservationTaken(userKey: string): boolean {
  return !checkCapsuleAsk(userKey).allowed;
}

const USER = "user-under-test";

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
  trapDelayMs = 0;
  resetCapsuleAskGuard();
  __resetCapsuleThreadForTests();
  trap = trapFetch();
});

afterEach(() => {
  trap.restore();
  cleanup();
});

// ══════════════════════════════════════════════════════════════════════
// K10.a — THE DETECTOR CAN FAIL
// ══════════════════════════════════════════════════════════════════════
//
// A gate that has never been observed going red is a decoration. Before
// asserting that Tier-0 questions spend nothing, prove the harness can
// SEE a spend: drive the same Enter boundary with a question Tier 0 must
// refuse ("why is cash down" — an interpretation request) and watch both
// detectors fire.
//
// This is the planted-defect control in permanent form. The one-off
// plant — reverting the short-circuit in `CommandPalette.enterAnswerMode`
// and re-running — is recorded in `design_review/capsule/GATES.md`.

describe("K10.a — the detector fires on a question that MUST reach the model", () => {
  it("an interpretation request takes a reservation and hits a model seam", async () => {
    mount();
    expect(reservationTaken(USER)).toBe(false);

    typeAndEnter("why is cash down this month?");

    await waitFor(() => {
      expect(
        trap.spend().length,
        "K10 PLANT: the harness observed NO request to either model seam for a " +
          "question Tier 0 refuses. If a real spend cannot be seen here, the " +
          "zero-spend assertions below are vacuous.",
      ).toBeGreaterThan(0);
    });

    expect(
      reservationTaken(USER),
      "K10 PLANT: no chat reservation was taken for a question that reached " +
        "the model. `reserveCapsuleAsk` is the ledger the burst guard bills " +
        "against; if it stays empty the second detector is blind.",
    ).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// K10.b — TIER-0 QUESTIONS SPEND NOTHING AT THE ENTER BOUNDARY
// ══════════════════════════════════════════════════════════════════════
//
// The questions are Tier-0-resolvable against THIS workspace: a bare
// metric, an opener-wrapped metric, a Romanian metric, a workspace meta
// question, and an account-code lookup. Each is typed into the real
// input and committed with a real Enter.

const TIER0_QUESTIONS: readonly string[] = Object.freeze([
  "total assets",
  "how much cash do we have",
  "what is our working capital",
  "cifra de afaceri",
  "is it balanced",
]);

describe("K10.b — Enter on a Tier-0 question issues no model request", () => {
  for (const question of TIER0_QUESTIONS) {
    it(`"${question}" — zero reservations, zero model-seam requests`, async () => {
      mount();
      typeAndEnter(question);

      // The answer canvas is up; give any stray async dispatch a chance
      // to land before reading the detectors, or the gate would pass by
      // being early rather than by being right.
      await screen.findByTestId("capsule-answer");
      await new Promise((r) => setTimeout(r, 60));

      expect(
        trap.spend(),
        `K10: pressing Enter on "${question}" reached a model seam. Tier 0 ` +
          `already holds this answer, with provenance, in microseconds — ` +
          `paying for it is paying twice for a figure the client had.`,
      ).toEqual([]);

      expect(
        reservationTaken(USER),
        `K10: pressing Enter on "${question}" took a chat reservation. A ` +
          `reservation is budget spent whether or not a request follows, and ` +
          `Tier 0's contract is "works offline / credits-down".`,
      ).toBe(false);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════
// K10.c — A TIER-0 ANSWER IS A FULL ANSWER
// ══════════════════════════════════════════════════════════════════════
//
// Not spending is only half of it. The brief: "The fact card, provenance
// dot, citation footer and follow-up chips must all still render; a
// Tier-0 answer is a full answer, not a preview that dead-ends." So the
// canvas is inspected for each of those, on the real DOM.

describe("K10.c — the canvas a Tier-0 answer paints", () => {
  it("renders the fact card, a provenance dot, the citation footer and chips", async () => {
    mount();
    typeAndEnter("total assets");

    const turn = await screen.findByTestId("capsule-turn");
    expect(within(turn).getByTestId("capsule-fact-card")).toBeTruthy();
    expect(within(turn).getAllByTestId("capsule-provenance-dot").length).toBeGreaterThan(0);
    expect(within(turn).getByTestId("capsule-citation")).toBeTruthy();
    expect(within(turn).getByTestId("capsule-followups")).toBeTruthy();
    // It says where it came from, and it is NOT wearing the fallback
    // note — "the assistant's wording was rejected" would be an apology
    // for an assistant that was never asked.
    expect(within(turn).getByTestId("capsule-tier0-note")).toBeTruthy();
    expect(within(turn).queryByTestId("capsule-fallback-note")).toBeNull();
    expect(trap.spend()).toEqual([]);
  });

  it("offers a chip that routes to Tier 1 — and only that chip spends", async () => {
    mount();
    typeAndEnter("total assets");

    const chips = await screen.findAllByTestId("capsule-followup-chip");
    const interpret = chips.find((c) => c.getAttribute("data-kind") === "interpret");
    expect(
      interpret,
      "K10: a Tier-0 answer offered no route to the interpretation. The " +
        "figure is on screen without a reading of it, so the reader needs a " +
        "deliberate one-keystroke way to ask for one — otherwise the honest " +
        "cheap answer is a dead end and they retype the question.",
    ).toBeTruthy();
    expect(
      interpret!.getAttribute("data-local"),
      "K10: the interpretation chip is marked local. A local chip expands " +
        "what is already on screen; this one must reach the model, and the " +
        "reader must be the one who chose it.",
    ).toBeNull();

    // Still nothing spent — the chip is an offer, not a dispatch.
    expect(trap.spend()).toEqual([]);
    expect(reservationTaken(USER)).toBe(false);

    fireEvent.click(interpret!);

    await waitFor(() => {
      expect(
        trap.spend().length,
        "K10: activating the interpretation chip reached no model seam. A " +
          "chip that promises a reading and delivers nothing is worse than " +
          "no chip.",
      ).toBeGreaterThan(0);
    });
    expect(reservationTaken(USER)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// K10.d — THE INTERROGATIVE FORM OF AN ACTION QUERY
// ══════════════════════════════════════════════════════════════════════
//
// The router resolves "how do i export the balance sheet" to the
// imperative inside it. This asserts the SURFACE honours that: Enter
// navigates and closes, with nothing reaching a model seam. Measured on
// the component, because the router being right about the lane is not
// the same as the palette acting on it — and the palette's own Enter
// rule ("exact name, or ask") would have sent this to the model on its
// own.

describe("K10.d — a navigation question with a question mark on it", () => {
  // Both halves of the redirect: a ROUTE row and an ACTION row. The
  // action case also exercises `COMMAND_ITEM_ID`, the small cross-lane
  // map that joins the router's published `commandId` to the palette row
  // that runs it — an untested map is a map that quietly stops matching.
  const REDIRECTED: readonly [string, string][] = Object.freeze([
    ["how do i export the balance sheet", "route → the balance-sheet page"],
    ["how do i upload a trial balance", "action → the upload command"],
  ]);

  for (const [question, shape] of REDIRECTED) {
    it(`"${question}" (${shape}) navigates instead of asking, and spends nothing`, async () => {
      const { onOpenChange } = mount();
      typeAndEnter(question);

      await waitFor(() => {
        // Running either row closes the palette — the observable effect.
        expect(
          onOpenChange,
          `K10: Enter on "${question}" did not navigate. The imperative form ` +
            `reaches the same place for free; the question form must not cost ` +
            `a model call to get there.`,
        ).toHaveBeenCalledWith(false);
      });
      await new Promise((r) => setTimeout(r, 60));

      expect(trap.spend()).toEqual([]);
      expect(reservationTaken(USER)).toBe(false);
      // And the answer canvas was never entered at all.
      expect(screen.queryByTestId("capsule-answer")).toBeNull();
    });
  }

  // The other half of the router's rule, at the SURFACE. Without it the
  // gate above could be satisfied by redirecting every "how do i …" to
  // whichever route token it happens to contain.
  it("a how-to that wants ADVICE still reaches the model", async () => {
    mount();
    typeAndEnter("how do i improve cash flow");

    await screen.findByTestId("capsule-answer");
    await waitFor(() => {
      expect(
        trap.spend().length,
        "K10: \"how do i improve cash flow\" was answered without the model. " +
          "It names a route token and asks for a judgement; opening a page " +
          "would be an instant answer to a question nobody asked.",
      ).toBeGreaterThan(0);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// K10.e / K10.f — THE ONE COMPOSER
// ══════════════════════════════════════════════════════════════════════
//
// The craft pass deleted `CapsuleAnswerPanel`'s own composer: the
// question and the follow-up are now typed into the SAME textarea, which
// is what makes the answer state a continuation of the resting state
// rather than a second surface. Two guarantees came with that composer
// and had to survive the move, and both are the host's now.
//
// They used to be asserted in `capsuleAnswer/__tests__/
// capsuleAnswerPanel.test.tsx` against a callback prop. Here they are
// asserted against the REAL surface and the REAL model seams, which is
// a stronger claim — the panel-level version would have stayed green
// with the whole spend boundary removed.

describe("K10.e — Shift+Enter composes a newline, it does not ask", () => {
  it("a question Tier 0 refuses spends NOTHING when committed with Shift", async () => {
    mount();
    const input = screen.getByRole("combobox");
    // The SAME question K10.a proves reaches the model on a plain Enter.
    // That is what makes this a real assertion rather than a statement
    // about a string nobody would have billed for anyway.
    fireEvent.change(input, { target: { value: "why is cash down this month?" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    await new Promise((r) => setTimeout(r, 80));

    expect(
      trap.spend(),
      "K10.e: Shift+Enter reached a model seam. It is the newline key — the " +
        "field is a textarea precisely so a long question can be composed " +
        "before it is sent — and a newline must never be a purchase.",
    ).toEqual([]);
    expect(reservationTaken(USER)).toBe(false);
    expect(screen.queryByTestId("capsule-answer")).toBeNull();
  });
});

describe("K10.f — one turn at a time", () => {
  it("Enter while a turn is still running does not start a second one", async () => {
    // Hold the model seam open, so the first turn is genuinely still
    // running when the second Enter arrives. Without this the trap
    // answers in the same microtask, the turn finishes, `busy` is
    // already false, and the gate below asserts nothing.
    trapDelayMs = 2000;
    mount();

    // Turn one: an interpretation request, so the model path is the one
    // under test and `busy` is genuinely true for a while.
    typeAndEnter("why is cash down this month?");
    await screen.findByTestId("capsule-answer");
    const before = screen.getAllByTestId("capsule-turn").length;
    expect(before).toBe(1);

    // ── THE CONFOUND, REMOVED ────────────────────────────────────────
    //
    // `capsuleAskGuard` enforces a minimum gap between asks, so a second
    // Enter fired straight after the first would be refused by the
    // THROTTLE whether or not the busy guard exists — and the assertion
    // below would pass with `runPrimary`'s `if (answer.busy) return`
    // deleted. That is exactly the vacuous-gate shape this session is
    // about. Clearing the ledger here leaves the busy guard as the only
    // thing that can stop the second turn.
    resetCapsuleAskGuard();

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "and what about receivables?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 60));

    expect(
      screen.getAllByTestId("capsule-turn").length,
      "K10.f: a second turn started while the first was still running — two " +
        "threads racing into one canvas. THREE guards have to be gone for " +
        "this to fail (`CommandPalette.runPrimary`, and `useCapsuleAnswer`'s " +
        "`ask` and `answerLocally`), which is exactly what the plant record " +
        "in design_review/capsule-craft/ shows: removing any ONE of them " +
        "leaves this green.",
    ).toBe(before);
  });
});
