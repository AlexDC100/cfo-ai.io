// THE CAPSULE — "Open in chat", without re-asking.
//
// The reader has already had the conversation. Handing the QUESTION to
// the chat page and making them press send again would re-spend a model
// call on an answer they are looking at, and — worse — the second answer
// would be produced by a surface with no placeholder contract, so the
// two would disagree on figures.
//
// So the whole thread is TRANSPLANTED: each turn is written into a fresh
// conversation as a completed user/assistant pair through the chat
// store's own public API. The chat page opens on a thread that already
// reads exactly as it did inline, and the reader continues from there.
//
// The transplanted text is NATIVE currency, explicitly labelled — see
// `answerToNativeText`. The chat surface has no placeholder renderer and
// no rate table; a display-converted figure pasted into it would carry a
// rate nobody can see, and mixing the two inside one sentence is the 461
// defect exactly.
//
// Every import is dynamic: the palette must not pull the chat module
// graph into the shell bundle for a button most sessions never press.

export interface HandoffTurn {
  question: string;
  answer: string;
}

export interface HandoffContext {
  periodId: string | null;
  periodLabel: string | null;
}

/** Returns true when the thread was transplanted. False means the caller
 *  should fall back to the plain "open chat with this prompt" path — a
 *  degraded hand-off is still better than a dead button. */
export async function handOffThreadToChat(
  turns: readonly HandoffTurn[],
  ctx: HandoffContext,
): Promise<boolean> {
  if (turns.length === 0) return false;
  try {
    const store = await import("@/components/cfo/chat/useChatStore");
    let orgId: string | null = null;
    try {
      const { currentOrgId } = await import("@/lib/supabase");
      orgId = await currentOrgId();
    } catch {
      orgId = null;
    }

    store.chatCreateNew(orgId, {
      organizationId: orgId,
      periodId: ctx.periodId,
      periodLabel: ctx.periodLabel,
    });

    for (const turn of turns) {
      const { conversationId, assistantId } = store.chatAppendUserTurn(orgId, {
        content: turn.question,
        periodId: ctx.periodId,
        periodLabel: ctx.periodLabel,
      });
      store.chatCompleteAssistantTurn(orgId, {
        conversationId,
        assistantId,
        content: turn.answer || "",
        groundedPeriod: ctx.periodLabel,
      });
    }
    return true;
  } catch {
    return false;
  }
}
