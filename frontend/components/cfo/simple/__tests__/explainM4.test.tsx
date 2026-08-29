// GATE M4 — Explain Anything works with AI DEAD (Prompt 12, Part D).
//
// Mocks cfoApi.chatLlm dead in BOTH failure shapes:
//   1. a thrown network error (fetch TypeError), and
//   2. the Edge Function's 200-with-error sentinel answer,
// then proves the drawer renders the deterministic TEMPLATE text with:
//   · no error UI (calm one-line note + Retry only),
//   · no raw payload fragment anywhere in the DOM (no request_id, no
//     JSON braces, no "Couldn't reach Claude"),
//   · the "Standard explanation" source caption.
// Also proves the healthy path swaps in the AI text + its caption, and
// that the button is Simple-mode-only (Pro renders nothing).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

// This jsdom build exposes localStorage as a bare object with no working
// methods (same as viewModes.test.ts) — install an in-memory Storage.
const bag = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => void bag.set(k, String(v)),
    removeItem: (k: string) => void bag.delete(k),
    clear: () => void bag.clear(),
    key: (i: number) => [...bag.keys()][i] ?? null,
    get length() { return bag.size; },
  },
});

const chatLlmMock = vi.fn();
vi.mock("@/lib/cfoApi", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/cfoApi")>();
  return { ...orig, cfoApi: { ...orig.cfoApi, chatLlm: chatLlmMock } };
});

const { ExplainButton } = await import("@/components/cfo/simple/ExplainButton");
const { templateExplanation } = await import("@/lib/explain");
import type { ExplainInput } from "@/lib/explain";

const REQUEST: ExplainInput = {
  panelId: "benchmark-profitability",
  panelKind: "benchmark",
  snapshotKey: "period-m4",
  title: "Profitability",
  figures: [
    { termId: "ebitda", label: "EBITDA margin", value: "12.4%", compare: "9.8%" },
  ],
};

const TEMPLATE_TEXT = templateExplanation({ ...REQUEST, lang: "en" });

// Raw fragments that must NEVER reach the DOM.
const RAW_SENTINEL =
  'Couldn\'t reach Claude: 529 {"type":"error","error":{"type":"overloaded_error"},"request_id":"req_011X"}';
const FORBIDDEN = ["request_id", "req_011X", "overloaded_error", "Couldn't reach Claude", "{"];

function openDrawer() {
  render(<ExplainButton request={REQUEST} />);
  fireEvent.click(screen.getByTestId("explain-button-benchmark-profitability"));
}

async function expectCalmTemplateState() {
  // The template paints and stays.
  const text = await screen.findByTestId("explain-text");
  expect(text.textContent).toContain("12.4%");
  expect(text.textContent).toBe(TEMPLATE_TEXT);

  // A2-calm degraded row: quiet note + Retry, no error styling/state.
  await waitFor(() => expect(screen.getByTestId("explain-degraded")).toBeInTheDocument());
  expect(screen.getByTestId("explain-retry")).toBeInTheDocument();

  // Source caption says template.
  expect(screen.getByTestId("explain-source").textContent).toBe("Standard explanation");

  // No raw payload fragment anywhere in the rendered document.
  const dom = document.body.textContent ?? "";
  for (const frag of FORBIDDEN) {
    expect(dom).not.toContain(frag);
  }
}

beforeEach(() => {
  cleanup();
  chatLlmMock.mockReset();
  localStorage.clear();
});

describe("M4 — drawer with AI dead", () => {
  it("network error -> template text, calm retry, no raw payload", async () => {
    chatLlmMock.mockRejectedValue(new TypeError("Failed to fetch"));
    openDrawer();
    await expectCalmTemplateState();
  });

  it("200-with-error sentinel -> template text, calm retry, no raw payload", async () => {
    chatLlmMock.mockResolvedValue({ answer: RAW_SENTINEL, model: null, usage: null });
    openDrawer();
    await expectCalmTemplateState();
  });

  it("retry re-asks and a recovered AI answer replaces the template", async () => {
    chatLlmMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    openDrawer();
    await waitFor(() => expect(screen.getByTestId("explain-degraded")).toBeInTheDocument());

    chatLlmMock.mockResolvedValue({ answer: "Plain words about your margin.", model: null, usage: null });
    fireEvent.click(screen.getByTestId("explain-retry"));

    await waitFor(() =>
      expect(screen.getByTestId("explain-text").textContent).toBe("Plain words about your margin."),
    );
    expect(screen.getByTestId("explain-source").textContent).toBe(
      "AI explanation · grounded in your figures",
    );
    expect(screen.queryByTestId("explain-degraded")).not.toBeInTheDocument();
  });
});

describe("healthy AI path", () => {
  it("shows the template first, then the AI text + AI caption", async () => {
    let resolve!: (v: { answer: string; model: null; usage: null }) => void;
    chatLlmMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    openDrawer();

    // Synchronous floor: template visible while the AI call is in flight.
    expect(screen.getByTestId("explain-text").textContent).toBe(TEMPLATE_TEXT);
    expect(screen.getByTestId("explain-asking")).toBeInTheDocument();

    resolve({ answer: "Your margin runs ahead of the industry.", model: null, usage: null });
    await waitFor(() =>
      expect(screen.getByTestId("explain-text").textContent).toBe(
        "Your margin runs ahead of the industry.",
      ),
    );
    expect(screen.getByTestId("explain-source").textContent).toBe(
      "AI explanation · grounded in your figures",
    );
  });
});

describe("mode gating", () => {
  it("renders nothing in Pro mode (the Instrument stays untouched)", () => {
    localStorage.setItem("cfo-view-mode-v1", "pro");
    render(<ExplainButton request={REQUEST} />);
    expect(screen.queryByTestId("explain-button-benchmark-profitability")).not.toBeInTheDocument();
    localStorage.removeItem("cfo-view-mode-v1");
  });
});
