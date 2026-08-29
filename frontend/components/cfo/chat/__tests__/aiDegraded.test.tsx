// D8 — the central AI-error boundary (A2).
//
// Before this boundary, a chat failure stamped the RAW error payload —
// status code, request_id, JSON braces and all — straight into the
// conversation as message content. This suite mocks exactly that case
// (a 400 whose JSON body carries a request_id) and proves:
//
//   1. NONE of the raw payload reaches the DOM — no "request_id", no
//      status code, no JSON braces;
//   2. the user sees the calm degraded panel with the headline, a Retry
//      button, and a quiet "details" disclosure with a HUMAN-READABLE
//      reason;
//   3. the raw payload goes to console.debug (and nowhere louder);
//   4. the composer + suggestion chips are disabled with a tooltip while
//      degraded, and the lock auto-clears on the next successful turn.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// No network in this suite — the store must work purely in-memory
// (same mock set as chatScope.test.ts).
vi.mock("../chatRemote", () => ({
  chatIdentity: async () => null,
  deleteMessages: async () => true,
  deleteThread: async () => true,
  fetchConversations: async () => null,
  importLocalConversations: async () => 0,
  insertMessage: async () => true,
  insertThread: async () => true,
  updateThread: async () => true,
}));
vi.mock("@/lib/org", () => ({ useActiveOrg: () => ({ org: null, loading: false }) }));

// Partial-mock the API client: the REAL CfoApiError class (instanceof
// checks in the pipeline must hold), a controllable chatLlm.
const chatLlmMock = vi.fn();
vi.mock("@/lib/cfoApi", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/cfoApi")>();
  return { ...orig, cfoApi: { ...orig.cfoApi, chatLlm: chatLlmMock } };
});

const { CfoApiError } = await import("@/lib/cfoApi");
const { startChatTurn } = await import("../chatTurns");
const { getChatConversation, resetChatLiveState, chatRemove, visibleConversations } =
  await import("../useChatStore");
const { getAiDegraded, clearAiDegraded, classifyAiFailure } = await import("@/lib/aiDegraded");
const { CFOMessageList } = await import("../CFOMessageList");
const { CFOComposer } = await import("../CFOComposer");
const { FALLBACK_PAYLOAD } = await import("@/lib/rates");

// The raw wire payload the boundary must SWALLOW. If any of these
// fragments show up in the DOM, the boundary has failed.
const RAW_400_DETAIL = {
  request_id: "req_01HZXK7Q2M9V",
  error: { type: "invalid_request_error", message: "messages: field required" },
  status: 400,
};

function turnCtx() {
  return {
    orgId: null,
    text: "What is our EBITDA?",
    attachments: [],
    periodId: null,
    periodLabel: null,
    groundedLabel: null,
    workspaceSnapshot: undefined,
    companyName: null,
    displayCurrency: "RON" as const,
    sourceCurrency: "RON" as const,
    rates: FALLBACK_PAYLOAD,
  };
}

async function failOneTurn(): Promise<string> {
  chatLlmMock.mockRejectedValueOnce(
    new CfoApiError(JSON.stringify(RAW_400_DETAIL), 400, RAW_400_DETAIL),
  );
  startChatTurn(turnCtx());
  const conv = getChatConversation(null, latestConversationId());
  await waitFor(() => {
    const c = getChatConversation(null, conv!.id);
    expect(c?.messages[c.messages.length - 1]?.failed).toBeTruthy();
  });
  return conv!.id;
}

function latestConversationId(): string {
  // startChatTurn auto-creates the conversation synchronously; the
  // freshest one is at the head of the visible list.
  return visibleConversations(null)[0].id;
}

beforeEach(() => {
  // This jsdom build ships a localStorage whose `clear` is not callable
  // (the same quirk behind the pre-existing chatScope.test.ts failures).
  // The store reads storage through try/catch everywhere, so a
  // best-effort wipe is enough for isolation here.
  try {
    if (typeof localStorage.clear === "function") localStorage.clear();
    else for (const k of Object.keys(localStorage)) localStorage.removeItem?.(k);
  } catch { /* ignore — module reset below is the real isolation */ }
  resetChatLiveState(null);
  clearAiDegraded();
  chatLlmMock.mockReset();
});

describe("A2 — central AI-error boundary (D8)", () => {
  it("renders the calm panel on a 400 and leaks NOTHING of the raw payload into the DOM", async () => {
    const convId = await failOneTurn();
    const conv = getChatConversation(null, convId)!;

    const { container } = render(
      <CFOMessageList messages={conv.messages} onRetryFailed={() => {}} />,
    );

    // The calm panel is there, with the exact reassurance line.
    expect(screen.getByTestId("chat-ai-degraded")).toBeTruthy();
    expect(container.textContent).toContain(
      "CFO AI is unavailable right now — your figures are unaffected.",
    );

    // The raw payload is NOT: no request id, no status code, no JSON.
    const text = container.textContent ?? "";
    expect(text).not.toContain("request_id");
    expect(text).not.toContain("req_01HZXK7Q2M9V");
    expect(text).not.toContain("400");
    expect(text).not.toContain("{");
    expect(text).not.toContain("}");
    expect(text).not.toContain("invalid_request_error");
    // ...and not hidden in attributes either.
    expect(container.innerHTML).not.toContain("request_id");
    expect(container.innerHTML).not.toContain("req_01HZXK7Q2M9V");
  });

  it("offers Retry on the failed turn and a details disclosure with a human-readable reason", async () => {
    const convId = await failOneTurn();
    const conv = getChatConversation(null, convId)!;
    const onRetry = vi.fn();

    render(<CFOMessageList messages={conv.messages} onRetryFailed={onRetry} />);

    fireEvent.click(screen.getByTestId("chat-ai-degraded-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);

    // The details disclosure carries the mapped reason — words, not codes.
    const reason = screen.getByTestId("chat-ai-degraded-reason");
    expect(reason.textContent).toBe("Service temporarily unavailable.");
  });

  it("sends the raw payload to console.debug only", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      await failOneTurn();
      const logged = debugSpy.mock.calls.some((args) =>
        args.some(
          (a) =>
            (typeof a === "object" && a !== null && JSON.stringify(a).includes("req_01HZXK7Q2M9V")) ||
            (typeof a === "string" && a.includes("req_01HZXK7Q2M9V")),
        ),
      );
      expect(logged).toBe(true);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("locks the composer with a tooltip while degraded (visible, not hidden)", async () => {
    await failOneTurn();
    expect(getAiDegraded()).toBe("service");

    render(
      <CFOComposer
        pending={false}
        onSubmit={vi.fn()}
        degradedReason="CFO AI is unavailable — use Retry on the last message."
      />,
    );

    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(textarea.title).toContain("Retry");
    expect((screen.getByTestId("chat-attach") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("chat-send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("auto-recovers on the next successful turn", async () => {
    const convId = await failOneTurn();
    expect(getAiDegraded()).toBe("service");

    chatLlmMock.mockResolvedValueOnce({ answer: "EBITDA is on the dashboard.", model: null, usage: null });
    startChatTurn(turnCtx());
    await waitFor(() => expect(getAiDegraded()).toBeNull());

    // The recovered conversation renders normally again.
    const conv = getChatConversation(null, convId)!;
    const last = conv.messages[conv.messages.length - 1];
    expect(last.failed).toBeUndefined();
    expect(last.content).toBe("EBITDA is on the dashboard.");
  });

  it("releases the degraded lock when the conversation holding the failed turn is deleted", async () => {
    const convId = await failOneTurn();
    expect(getAiDegraded()).toBe("service");
    chatRemove(null, convId);
    expect(getAiDegraded()).toBeNull();
  });

  it("intercepts the Edge Function's wrapped upstream error (HTTP 200 whose answer IS the raw payload)", async () => {
    // supabase/functions/chat-llm returns upstream Anthropic failures as a
    // 200 with this literal answer shape — the raw 400 body rides inside.
    chatLlmMock.mockResolvedValueOnce({
      answer: `Couldn't reach Claude: 400 {"type":"error","request_id":"req_01HZXK7Q2M9V"}. Try again in a moment.`,
      model: null,
      usage: null,
    });
    startChatTurn(turnCtx());
    const convId = latestConversationId();
    await waitFor(() => {
      const c = getChatConversation(null, convId);
      expect(c?.messages[c.messages.length - 1]?.failed).toBe("service");
    });
    expect(getAiDegraded()).toBe("service");

    const conv = getChatConversation(null, convId)!;
    const { container } = render(
      <CFOMessageList messages={conv.messages} onRetryFailed={() => {}} />,
    );
    const text = container.textContent ?? "";
    expect(screen.getByTestId("chat-ai-degraded")).toBeTruthy();
    expect(text).not.toContain("Couldn't reach Claude");
    expect(text).not.toContain("request_id");
    expect(text).not.toContain("400");
    expect(text).not.toContain("{");
  });

  it("classifies failures onto the three human reasons", () => {
    expect(classifyAiFailure(new CfoApiError("x", 400, RAW_400_DETAIL))).toBe("service");
    expect(classifyAiFailure(new CfoApiError("x", 503, null))).toBe("service");
    expect(classifyAiFailure(new CfoApiError("x", 429, null))).toBe("usage");
    expect(classifyAiFailure(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifyAiFailure("garbage")).toBe("service");
  });
});
