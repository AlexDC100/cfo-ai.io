// Chat visibility scoping (2026-07-26 per operator).
//
//   · started with NO workspace → visible in EVERY workspace and with none
//     selected. It isn't about any one company.
//   · started INSIDE a workspace → visible only there, because its answers
//     are grounded in that company's numbers.
//
// The subtle half is MUTATION ROUTING: a workspace-less chat is on screen
// while a workspace is open, so edits to it arrive with that workspace as the
// caller's orgId. Writing them into the workspace's bucket would silently
// clone the conversation into whichever company happened to be open.

import { describe, it, expect, beforeEach, vi } from "vitest";

// No network in this suite — the store must work purely in-memory.
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
vi.mock("@/lib/org", () => ({ useActiveOrg: () => ({ org: null }) }));

const {
  chatAppendUserTurn,
  chatCompleteAssistantTurn,
  chatRemove,
  resetChatLiveState,
  visibleConversations,
} = await import("../useChatStore");

const ORG_A = "org-a";
const ORG_B = "org-b";

beforeEach(() => {
  localStorage.clear();
  resetChatLiveState(null);
  resetChatLiveState(ORG_A);
  resetChatLiveState(ORG_B);
});

describe("chat scoping", () => {
  it("shows a workspace-less chat in every workspace and with none selected", () => {
    const { conversationId } = chatAppendUserTurn(null, { content: "What is EBITDA?" });

    for (const scope of [null, ORG_A, ORG_B]) {
      expect(visibleConversations(scope).map((c) => c.id)).toContain(conversationId);
    }
  });

  it("keeps a workspace chat inside its own workspace", () => {
    const { conversationId } = chatAppendUserTurn(ORG_A, { content: "Our margin?" });

    expect(visibleConversations(ORG_A).map((c) => c.id)).toContain(conversationId);
    expect(visibleConversations(ORG_B).map((c) => c.id)).not.toContain(conversationId);
    expect(visibleConversations(null).map((c) => c.id)).not.toContain(conversationId);
  });

  it("does not clone a global chat into the workspace a reply lands under", () => {
    const { conversationId, assistantId } = chatAppendUserTurn(null, { content: "Hi" });

    // The reply arrives while ORG_A is open — the completion is called with
    // ORG_A, but the conversation belongs to the global bucket.
    chatCompleteAssistantTurn(ORG_A, { conversationId, assistantId, content: "Hello." });

    // Still exactly one copy, still global (so still visible from ORG_B too).
    expect(visibleConversations(ORG_A).filter((c) => c.id === conversationId)).toHaveLength(1);
    expect(visibleConversations(ORG_B).map((c) => c.id)).toContain(conversationId);

    const answered = visibleConversations(null).find((c) => c.id === conversationId);
    expect(answered?.messages.at(-1)?.content).toBe("Hello.");
    expect(answered?.messages.at(-1)?.pending).toBe(false);
  });

  it("deletes a global chat everywhere when removed from inside a workspace", () => {
    const { conversationId } = chatAppendUserTurn(null, { content: "Hi" });

    chatRemove(ORG_A, conversationId);

    for (const scope of [null, ORG_A, ORG_B]) {
      expect(visibleConversations(scope).map((c) => c.id)).not.toContain(conversationId);
    }
  });
});
