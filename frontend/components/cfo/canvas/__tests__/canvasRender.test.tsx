// THE CANVAS — RENDER GATES (CV-R1 … CV-R3).
//
// These are the gates that watch the DOM, because the store gates cannot
// see the one failure that matters most: a figure REACHING THE READER
// that should not have.
//
// ══ THE TURNS ARE REAL PIPELINE OUTPUT (TC-1) ══════════════════════════
//
// Every `CapsuleTurn` in this file is produced by running the ACTUAL
// pipeline — `runAnswerTurn`, over `planRetrieval`'s plan, through the
// capsule lane's contract-following fixture transport. Not one is
// hand-built. A hand-built turn encodes this author's belief about the
// shape of `CapsuleEvidence`, and the test would then verify the
// component against that belief rather than against what the pipeline
// emits. Three defects surfaced in this codebase the moment a single
// fixture stopped being hand-built.
//
// (The transport itself SYNTHESISES ct1 payloads from the plan's own
// arguments rather than replaying blobs — the capsule lane's documented
// choice, and the closest thing to real engine output available in this
// tree. It breaks loudly if the planner sends something the tool layer
// does not accept, which a stored blob would not.)
//
// ══ WHY EVERY "NO DIGIT" ASSERTION HAS A CONTROL ═══════════════════════
//
// `digitsIn(node)` is pointed at a LIVE render first and required to
// find figures. Only then is it pointed at the stale render and required
// to find none. Without the first half, "no digits" is satisfied by a
// component that rendered nothing at all — which is exactly the vacuous
// pass TC-9 names, and which three instruments in this repo have already
// achieved.

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  runAnswerTurn,
  type CapsuleTurn,
} from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerClient";
import {
  fixtureGenerationTransport,
  fixtureToolTransport,
  FIXTURE_PERIODS,
} from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerFixtures";
import { planRetrieval } from "@/components/instrument/shell/capsuleAnswer/capsuleRetrieval";
import { CurrencyProvider } from "@/stores/currency";
import { scopeKey, type CanvasEntry } from "@/lib/canvasThread";

import { CanvasEntryView } from "../CanvasEntryView";
import {
  __resetLiveTurnsForTests,
  setLiveTurn,
} from "../canvasLiveTurns";

const PERIOD = FIXTURE_PERIODS[0];
const LIVE_SCOPE = scopeKey(PERIOD.id);
const OTHER_SCOPE = scopeKey("p-2026-01");

const RETRIEVAL = {
  periodId: PERIOD.id,
  periodLabel: PERIOD.label,
  periods: FIXTURE_PERIODS.map((p) => ({ id: p.id, label: p.label })),
};

/** A grounded answer: every figure arrives as a placeholder the renderer
 *  resolves WITH provenance. */
// NOTE the placeholder vocabulary: `{{money:FACT}}` is one of the seven
// shapes `PLACEHOLDER_RE` accepts. An earlier draft of this file wrote
// `{{literal:Dec 2025}}`, which is NOT one — the guard refused the whole
// answer and the CONTROL below went red saying "a grounded answer
// painted no caption". That red was correct and it was the control
// doing its job: it caught the FIXTURE being wrong before the fixture
// could quietly make the fabrication assertion vacuous.
const GROUNDED = "Total assets stand at {{money:total_assets}} for the period on file.";

/**
 * The same claim as a model would type it if nothing stopped it. The
 * hardcoded money string IS the defect under test.
 *
 * THE VALUE IS DELIBERATELY ONE THE EVIDENCE DOES NOT HOLD. The first
 * draft used 293,050,085 — which is exactly the fixture's real
 * `total_assets`, so the ban could never distinguish "the model's digit
 * leaked" from "the engine's own figure rendered correctly". A gate
 * whose forbidden string is also its expected string is not a gate.
 */
const FABRICATED =
  // eslint-disable-next-line no-restricted-syntax
  "Total assets stand at RON 411,222,333 for Dec 2025, roughly 77% above November.";

/**
 * Fragments as DIGIT RUNS, separator-stripped.
 *
 * Measured, not assumed: `linkifyAlertBody` — the fallback
 * `NarrativeText` uses for a template it cannot parse — REFORMATS a
 * numeral it finds in legacy text, so "RON 411,222,333" comes out as
 * "411.222.333,00 RON" under the Romanian grouping. Matching the literal
 * string the model typed would therefore report a clean DOM while the
 * model's own figure sat on screen in different clothes. That is the
 * single most instructive thing this file learned.
 */
const FABRICATED_FRAGMENTS = ["411222333", "77%"];

/** Separator-insensitive view of rendered text, so a reformatted leak is
 *  still a leak. */
function flatten(text: string): string {
  return text.replace(/[.,\s\u00A0\u202F]/g, "");
}

/** Run the real pipeline and return the finished turn. */
async function realTurn(
  question: string,
  answer: string = GROUNDED,
): Promise<CapsuleTurn> {
  const plan = planRetrieval(question, RETRIEVAL);
  expect(
    plan.length,
    `CV-R: planRetrieval produced NO steps for "${question}". The turn ` +
      `below would then carry no evidence, and every figure assertion in ` +
      `this file would be measuring an empty object.`,
  ).toBeGreaterThan(0);
  return runAnswerTurn({
    turnId: "t-real",
    question,
    history: [],
    plan,
    toolTransport: fixtureToolTransport(0),
    generate: fixtureGenerationTransport(answer),
    language: "en",
    companyName: "Scandia Food SRL",
    page: "Canvas",
    onUpdate: () => {},
  });
}

function entryFor(turnId: string, scope: string): CanvasEntry {
  return {
    id: turnId,
    question: "total assets",
    askedAt: 1_700_000_000_000,
    scope,
    command: null,
    steps: [],
    artifacts: [{ id: turnId, kind: "figures", titleKey: "canvas.artifact.figures" }],
    attachment: null,
  };
}

/** The two providers the render path genuinely needs: a currency
 *  context (`NarrativeText` reads the display currency and the rates)
 *  and a router (a provenance dot is a link to a statement row). Nothing
 *  else — a failure here should be a failure of THIS lane, not of the
 *  app shell around it. */
function mount(el: ReactElement) {
  return render(
    <MemoryRouter>
      <CurrencyProvider>{el}</CurrencyProvider>
    </MemoryRouter>,
  );
}

/**
 * IDENTIFIERS A FIGURE GATE MAY SEE WITHOUT CALLING THEM FIGURES.
 *
 * A period label carries a year, and the stale card's own action reads
 * "Recompute for Dec 2025" — that is chrome naming a PERIOD, not a
 * value. The capsule lane's live gate keeps the same list for the same
 * reason (`ALLOWED_IDENTIFIERS`).
 *
 * It is a list of exact strings, deliberately, not a pattern: a pattern
 * like "any 4-digit run" would also swallow a real amount that happened
 * to be four digits, and this gate's whole job is to notice one.
 */
const ALLOWED_IDENTIFIERS = FIXTURE_PERIODS.map((p) => p.label);

/** Every digit-bearing text node under a root. THE DETECTOR — pointed at
 *  a live render first and required to fire, then at a stale one and
 *  required not to, so its zero means something. */
function digitsIn(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n) {
    let text = (n.textContent ?? "").trim();
    for (const id of ALLOWED_IDENTIFIERS) text = text.split(id).join("");
    if (/\d/.test(text)) out.push((n.textContent ?? "").trim());
    n = walker.nextNode();
  }
  return out;
}

function view(entry: CanvasEntry, scope: string) {
  return (
    <CanvasEntryView
      entry={entry}
      scope={scope}
      mode="pro"
      periodLabel={PERIOD.label}
      pinnedIds={() => false}
      onPin={() => {}}
      onRecompute={() => {}}
      onJump={() => {}}
    />
  );
}

beforeEach(() => {
  __resetLiveTurnsForTests();
});
afterEach(cleanup);

// ══════════════════════════════════════════════════════════════════════
// CV-R1 — a stale entry renders no figure
// ══════════════════════════════════════════════════════════════════════

describe("CV-R1 — figures appear only under the scope they were computed for", () => {
  it("live: the card paints figures (the CONTROL)", async () => {
    const turn = await realTurn("total assets");
    setLiveTurn("t-real", turn);

    const { container } = mount(view(entryFor("t-real", LIVE_SCOPE), LIVE_SCOPE));

    expect(
      screen.queryByTestId("canvas-artifact-stale"),
      "CV-R1 CONTROL: the live render came back STALE. Everything below " +
        "would then be asserting the absence of figures on a card that " +
        "never tries to draw one.",
    ).toBeNull();

    const digits = digitsIn(container);
    expect(
      digits.length,
      "CV-R1 CONTROL: a LIVE canvas card painted no digit at all. The " +
        "stale assertion below would be satisfied by a component that " +
        "renders nothing in either state — the exact vacuous pass TC-9 names.",
    ).toBeGreaterThan(0);
    expect(screen.getByTestId("canvas-artifact-figures")).toBeInTheDocument();
  });

  it("stale by SCOPE: the same turn under another period paints no digit", async () => {
    const turn = await realTurn("total assets");
    setLiveTurn("t-real", turn);

    // The identical entry and the identical live turn — only the scope on
    // screen has moved on. This is the January-dashboard-showing-December
    // failure, and it is the reason the store refuses to persist figures.
    const { container } = mount(view(entryFor("t-real", OTHER_SCOPE), LIVE_SCOPE));

    expect(screen.getByTestId("canvas-artifact-stale")).toBeInTheDocument();
    const digits = digitsIn(container);
    expect(
      digits,
      `CV-R1: an entry answered against ${OTHER_SCOPE} painted ` +
        `${digits.length} digit-bearing node(s) while the surface is scoped ` +
        `to ${LIVE_SCOPE}:\n  ${digits.join("\n  ")}\n` +
        `The answer would still be TRUE and would look like it was about ` +
        `the period on screen, which is worse than showing nothing.`,
    ).toEqual([]);
  });

  it("stale by RESTORE: an entry with no live turn paints no digit", async () => {
    // No `setLiveTurn` — this is what a reload leaves behind: the
    // question survived, the figures did not.
    const { container } = mount(view(entryFor("t-restored", LIVE_SCOPE), LIVE_SCOPE));

    expect(screen.getByTestId("canvas-artifact-stale")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-artifact-recompute")).toBeInTheDocument();
    expect(
      digitsIn(container),
      "CV-R1: a RESTORED entry painted a figure. Its numbers were never " +
        "written to storage, so any digit here was invented by the render.",
    ).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// CV-R2 — C1 holds on the canvas render path
// ══════════════════════════════════════════════════════════════════════

describe("CV-R2 — a fabricated figure never reaches the canvas", () => {
  /**
   * ══ HOW THIS GATE WAS MADE ABLE TO FAIL, AND THE ATTEMPT THAT WASN'T ══
   *
   * The first plant made the card render `turn.streaming` — the raw text
   * as it arrives, before the guard runs. It produced NO RED, and the
   * reason is worth recording: on a refused turn the pipeline clears
   * `streaming` to "" and leaves `blocks` empty (measured:
   * `streaming=""`, `blocks=[]`, `deterministic=true`, one violation).
   * There was nothing at that field to leak. A plant that cannot inject
   * the defect is not evidence, so it was discarded rather than counted.
   *
   * What the gate actually needs to prove is narrower and truer: THE
   * CARD'S ONLY PROSE SOURCE IS `turn.blocks`, AND THE CARD DOES RENDER
   * `turn.blocks` TO THE DOM. The second half is the control — without
   * it, "the fabricated text is absent" is satisfied by a card that
   * never draws prose in any state, which is precisely the vacuous pass
   * this file exists to refuse.
   *
   * So the control below takes the REAL refused turn and injects the
   * fabricated sentence into `blocks` — one field, on genuine pipeline
   * output — and requires the fragments to APPEAR. Then the unmodified
   * turn is required to show none of them.
   */
  it("the card renders block prose (CONTROL), and refuses what the guard refused", async () => {
    const turn = await realTurn("total assets", FABRICATED);

    // The pipeline refused it: no prose survived the guard.
    expect(
      turn.blocks.length,
      "CV-R2: the guard let the fabricated answer through as prose. Either " +
        "the fixture stopped being fabricated or the guard stopped running.",
    ).toBe(0);
    expect(turn.deterministic || turn.violations.length > 0).toBe(true);

    // ── CONTROL: the card DOES paint block prose ──────────────────────
    const forced: CapsuleTurn = {
      ...turn,
      blocks: [{ kind: "para" as const, template: FABRICATED }],
    };
    setLiveTurn("forced", forced);
    const control = mount(view(entryFor("forced", LIVE_SCOPE), LIVE_SCOPE));
    const controlText = flatten(control.container.textContent ?? "");
    for (const fragment of FABRICATED_FRAGMENTS) {
      expect(
        controlText.includes(flatten(fragment)),
        `CV-R2 CONTROL: the card did not render "${fragment}" even when it ` +
          `WAS in turn.blocks. The ban below would then be watching a ` +
          `render path the card never takes.`,
      ).toBe(true);
    }
    cleanup();

    // ── THE BAN: the real refused turn shows none of it ───────────────
    setLiveTurn("f", turn);
    const { container } = mount(view(entryFor("f", LIVE_SCOPE), LIVE_SCOPE));
    const text = flatten(container.textContent ?? "");
    for (const fragment of FABRICATED_FRAGMENTS) {
      expect(
        text.includes(flatten(fragment)),
        `CV-R2: the fabricated fragment "${fragment}" reached the DOM. The ` +
          `model typed that figure; nothing resolved it. A digit with no ` +
          `gateway behind it is the defect C1 exists to make impossible, ` +
          `and the canvas is a NEW render path that has to prove it too.`,
      ).toBe(false);
    }

    // And the card did not go silent: the evidence still painted.
    expect(
      screen.queryByTestId("canvas-artifact-figures"),
      "CV-R2: refusing the prose also erased the figures. A refused " +
        "sentence is not a refused answer — the engine's own numbers are " +
        "still true and still have to be shown.",
    ).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
// CV-R3 — the question is the reader's, and it is not an artifact
// ══════════════════════════════════════════════════════════════════════

describe("CV-R3 — the entry's own chrome", () => {
  it("renders the question compactly and the plan steps as a checklist", async () => {
    const entry: CanvasEntry = {
      ...entryFor("p-1", LIVE_SCOPE),
      question: "build me a board pack for December",
      command: null,
      steps: [
        { id: "statements", labelKey: "canvas.plan.step.statements", status: "done" },
        { id: "charts", labelKey: "canvas.plan.step.charts", status: "running" },
        { id: "assemble", labelKey: "canvas.plan.step.assemble", status: "pending" },
      ],
      artifacts: [],
    };
    mount(view(entry, LIVE_SCOPE));

    expect(screen.getByTestId("canvas-question")).toHaveTextContent(
      "build me a board pack for December",
    );
    const steps = screen.getByTestId("canvas-steps").querySelectorAll("li");
    expect(
      steps.length,
      "CV-R3: the plan checklist rendered no rows. A multi-step run that " +
        "shows no steps is a spinner with extra words.",
    ).toBe(3);
    // Each step's status is legible to a gate AND to a stylesheet.
    expect([...steps].map((li) => li.getAttribute("data-step-status"))).toEqual([
      "done",
      "running",
      "pending",
    ]);
  });
});
