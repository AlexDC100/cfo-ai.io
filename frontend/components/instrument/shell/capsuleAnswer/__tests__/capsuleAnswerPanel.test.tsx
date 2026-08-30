// ANSWER MODE — what actually reaches the DOM.
//
// The three rules this file exists to keep honest:
//   1. a figure on screen came from a FACT, rendered by <Amount> /
//      <NarrativeText> — never from the model's own characters;
//   2. no raw failure payload reaches the DOM, ever (A2);
//   3. a period with no canonical envelope wears no trust badge.

import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({
    display: "RON" as const,
    rates: { rates: { RON: 5, EUR: 1, USD: 1.1 }, as_of: "2026-08-01" },
    setDisplay: () => {},
    refresh: async () => {},
    refreshing: false,
  }),
}));

import { runAnswerTurn, type CapsuleTurn } from "../capsuleAnswerClient";
import { planRetrieval } from "../capsuleRetrieval";
import {
  ANSWER_FIXTURES,
  FIXTURE_PERIODS,
  fixtureGenerationTransport,
  fixtureToolTransport,
} from "../capsuleAnswerFixtures";
import { __resetCapsulePackForTests } from "../capsuleExportPack";
import { CapsuleAnswerPanel, type HostCitation } from "../CapsuleAnswerPanel";

const CTX = {
  periodId: FIXTURE_PERIODS[0].id,
  periodLabel: FIXTURE_PERIODS[0].label,
  periods: FIXTURE_PERIODS.map((p) => ({ id: p.id, label: p.label })),
};

const CITATION: HostCitation = {
  periodLabel: "Dec 2025",
  sourceFile: "Scandia Trial Balance 2025.xlsx",
  trustLabel: "Balanced",
  trustTone: "success",
};

async function turnFor(id: string, answer?: string): Promise<CapsuleTurn> {
  const f = ANSWER_FIXTURES.find((x) => x.id === id)!;
  return runAnswerTurn({
    turnId: `panel-${id}`,
    question: f.question,
    history: [],
    plan: planRetrieval(f.question, CTX),
    toolTransport: fixtureToolTransport(),
    generate: fixtureGenerationTransport(answer ?? f.answer),
    language: "en",
  });
}

function renderPanel(turns: CapsuleTurn[], overrides: Partial<React.ComponentProps<typeof CapsuleAnswerPanel>> = {}) {
  const props = {
    turns,
    busy: false,
    citation: CITATION,
    onAsk: vi.fn(),
    onRetry: vi.fn(),
    onJump: vi.fn(),
    onOpenInChat: vi.fn(),
    ...overrides,
  };
  render(
    <MemoryRouter>
      <TooltipProvider>
        <CapsuleAnswerPanel {...props} />
      </TooltipProvider>
    </MemoryRouter>,
  );
  return props;
}

afterEach(() => {
  cleanup();
  __resetCapsulePackForTests();
});

describe("a resolved answer", () => {
  it("pins the question and renders the prose with a RESOLVED figure", async () => {
    const turn = await turnFor("assets");
    renderPanel([turn]);
    expect(screen.getByText("what are our total assets")).toBeInTheDocument();
    const body = screen.getByTestId("capsule-answer-body");
    // The placeholder must NOT survive to the DOM, and the resolved
    // figure must be there in its place.
    expect(body.textContent).not.toContain("{{");
    expect(body.textContent).toMatch(/293[.,\s]?050[.,\s]?085/);
  });

  it("lists only the facts the sentence cited, each with its period", async () => {
    const turn = await turnFor("assets");
    renderPanel([turn]);
    const rows = screen.getAllByTestId("capsule-figure-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Total assets");
    expect(rows[0].textContent).toContain("Dec 2025");
  });

  it("gives the figure a provenance dot that jumps to the source row", async () => {
    const turn = await turnFor("assets");
    const props = renderPanel([turn]);
    const dot = screen.getAllByTestId("capsule-provenance-dot")[0];
    expect(dot).toHaveAttribute("data-traceable-source-bucket", "totalAssets");
    fireEvent.click(dot);
    expect(props.onJump).toHaveBeenCalledWith(
      expect.objectContaining({ statement: "bs", bucket: "totalAssets" }),
    );
  });

  it("draws the comparison mini table with a delta chip", async () => {
    const turn = await turnFor("compare-revenue");
    renderPanel([turn]);
    const cmp = screen.getByTestId("capsule-comparison");
    expect(within(cmp).getByTestId("capsule-delta-chip")).toBeInTheDocument();
    expect(cmp.textContent).toContain("Nov 2025");
    expect(cmp.textContent).toContain("Dec 2025");
  });

  it("draws the sparkline from the four reads", async () => {
    const turn = await turnFor("trend-revenue");
    renderPanel([turn]);
    const spark = screen.getByTestId("capsule-sparkline");
    expect(spark.querySelector("path")?.getAttribute("d")).toMatch(/^M/);
  });

  it("cites period, source file, snapshot and the engine's trust verdict", async () => {
    const turn = await turnFor("assets");
    renderPanel([turn]);
    const cite = screen.getByTestId("capsule-citation");
    expect(cite.textContent).toContain("Dec 2025");
    expect(cite.textContent).toContain("Scandia Trial Balance 2025.xlsx");
    expect(cite.textContent).toContain("snap-a1b");
    expect(cite.textContent).toContain("Balanced");
  });

  it("says 'not verified' rather than wearing a badge it did not earn", async () => {
    const turn = await turnFor("assets");
    renderPanel([turn], {
      citation: { ...CITATION, trustLabel: null, trustTone: "neutral" },
    });
    expect(screen.getByTestId("capsule-citation").textContent).toContain(
      "Not verified by the engine",
    );
  });

  it("offers the four per-answer actions", async () => {
    const turn = await turnFor("assets");
    const props = renderPanel([turn]);
    const actions = screen.getByTestId("capsule-actions");
    expect(actions.textContent).toContain("Open in chat");
    expect(actions.textContent).toContain("Copy");
    expect(actions.textContent).toContain("Add to export pack");
    fireEvent.click(within(actions).getByText("Open in chat"));
    expect(props.onOpenInChat).toHaveBeenCalled();
  });

  it("Show evidence widens the list to everything retrieved", async () => {
    const turn = await turnFor("health");
    renderPanel([turn]);
    const before = screen.getAllByTestId("capsule-figure-row").length;
    fireEvent.click(screen.getByTestId("capsule-evidence-toggle"));
    expect(screen.getAllByTestId("capsule-figure-row").length).toBeGreaterThan(before);
  });

  it("adds a native-text entry to the export pack", async () => {
    const turn = await turnFor("assets");
    renderPanel([turn]);
    fireEvent.click(screen.getByTestId("capsule-pack"));
    const { packEntries } = await import("../capsuleExportPack");
    const [entry] = packEntries();
    expect(entry.answer).not.toContain("{{");
    expect(entry.periods).toEqual(["Dec 2025"]);
  });
});

describe("the deterministic floor", () => {
  it("shows the note and the figures, and no prose at all", async () => {
    const turn = await turnFor("assets", "Total assets are 293,050,085 RON.");
    renderPanel([turn]);
    expect(screen.getByTestId("capsule-fallback-note")).toBeInTheDocument();
    expect(screen.queryByTestId("capsule-answer-body")).toBeNull();
    expect(screen.getAllByTestId("capsule-figure-row").length).toBeGreaterThan(0);
  });

  it("the rejected model sentence never reaches the DOM", async () => {
    const turn = await turnFor("assets", "Total assets are 293,050,085 RON exactly.");
    const { container } = render(
      <MemoryRouter>
        <TooltipProvider>
          <CapsuleAnswerPanel
            turns={[turn]}
            busy={false}
            citation={CITATION}
            onAsk={vi.fn()}
            onRetry={vi.fn()}
            onJump={vi.fn()}
            onOpenInChat={vi.fn()}
          />
        </TooltipProvider>
      </MemoryRouter>,
    );
    expect(container.textContent).not.toContain("exactly");
  });
});

describe("degraded (A2)", () => {
  it("renders one calm state and no payload", async () => {
    const f = ANSWER_FIXTURES[0];
    const turn = await runAnswerTurn({
      turnId: "panel-degraded",
      question: f.question,
      history: [],
      plan: planRetrieval(f.question, CTX),
      toolTransport: fixtureToolTransport(),
      generate: async function* () {
        throw new TypeError("Failed to fetch");
          yield "";
      },
      language: "en",
    });
    const props = renderPanel([turn]);
    const panel = screen.getByTestId("capsule-degraded");
    expect(panel.textContent).toContain("The assistant is unavailable");
    expect(panel.textContent).toContain("Search, navigation and your figures keep working.");
    expect(panel.textContent).not.toContain("Failed to fetch");
    fireEvent.click(screen.getByText("Retry"));
    expect(props.onRetry).toHaveBeenCalled();
    // The figures that DID arrive are still on screen.
    expect(screen.getAllByTestId("capsule-figure-row").length).toBeGreaterThan(0);
  });

  it("states the absence when the engine could not be read", async () => {
    const { deadToolTransport } = await import("../capsuleAnswerFixtures");
    const f = ANSWER_FIXTURES[0];
    const turn = await runAnswerTurn({
      turnId: "panel-dead",
      question: f.question,
      history: [],
      plan: planRetrieval(f.question, CTX),
      toolTransport: deadToolTransport(),
      generate: fixtureGenerationTransport("Nothing is on file for that yet."),
      language: "en",
    });
    renderPanel([turn]);
    expect(screen.getByTestId("capsule-absences").textContent).toContain(
      "The engine did not answer",
    );
  });
});

describe("the follow-up input", () => {
  it("Enter asks, Shift+Enter does not", async () => {
    const turn = await turnFor("assets");
    const props = renderPanel([turn]);
    const input = screen.getByTestId("capsule-followup");
    fireEvent.change(input, { target: { value: "and equity?" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(props.onAsk).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onAsk).toHaveBeenCalledWith("and equity?");
  });

  it("refuses to fire while a turn is still running", async () => {
    const turn = await turnFor("assets");
    const props = renderPanel([turn], { busy: true });
    const input = screen.getByTestId("capsule-followup");
    fireEvent.change(input, { target: { value: "and equity?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onAsk).not.toHaveBeenCalled();
  });
});

describe("while the answer is being built", () => {
  it("shows the retrieval trace, not an empty box", () => {
    const inflight: CapsuleTurn = {
      id: "x", question: "what are our total assets", status: "retrieving",
      trace: [
        { id: "get_facts:0", key: "capsuleAnswer.trace.get_facts",
          params: { metric: "total_assets", period: "Dec 2025" }, state: "pending" },
      ],
      evidence: {
        facts: {}, factUnits: {}, factMeta: {}, currency: null, values: [], rows: [],
        gaps: [], limitations: [], notes: [], tools: [], periods: [], snapshots: [],
        literals: [],
      },
      blocks: [], streaming: "", visuals: [], citedFacts: [],
      deterministic: false, regenerated: false, violations: [], degraded: null,
      timing: { startedAt: 0, retrievalMs: null, firstTokenMs: null, totalMs: null },
    };
    renderPanel([inflight]);
    expect(screen.getByTestId("capsule-trace").textContent).toContain("Dec 2025");
    expect(screen.queryByTestId("capsule-citation")).toBeNull();
  });
});
