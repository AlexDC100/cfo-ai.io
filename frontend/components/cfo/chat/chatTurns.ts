// chatTurns — the background send pipeline for Ask CFO AI.
//
// A turn is started with everything it needs captured up front and then runs
// ENTIRELY at module level: no component owns it, so navigating away from
// /chat (which unmounts the shell) changes nothing — the request keeps
// going, the answer lands in the module store (useChatStore.ts), and the
// conversation is fully up to date whenever the user returns. The nav rail's
// thinking spinner (chatPendingStore) covers the "am I still generating?"
// signal while the user is elsewhere.
//
// Also owns:
//   · stopChatTurn — the composer's Stop button. Aborts the request and
//     stamps a muted "Interrupted" marker into the thread (assistant side),
//     never persisted server-side.
//   · the chat-cap lockout (Pricing V3 429) — module state, so hitting the
//     cap survives tab switches instead of resetting with the shell.

import { useSyncExternalStore } from "react";
import i18n from "@/i18n";
import { CfoApiError, cfoApi } from "@/lib/cfoApi";
import {
  classifyUpstreamAnswer,
  clearAiDegraded,
  reportAiFailure,
  setAiDegraded,
} from "@/lib/aiDegraded";
import {
  beginChatReply,
  endChatReply,
  registerChatReplyAbort,
  unregisterChatReplyAbort,
} from "@/lib/chatPendingStore";
import {
  chatAppendUserTurn,
  chatCompleteAssistantTurn,
  getChatConversation,
} from "./useChatStore";
import type { ChatAttachment } from "./types";
import type { RatesPayload } from "@/lib/rates";

type ChatLlmRequest = Parameters<typeof cfoApi.chatLlm>[0];

export interface ChatTurnContext {
  /** Active workspace — scopes which store bucket the turn writes into. */
  orgId: string | null;
  text: string;
  attachments: ChatAttachment[];
  periodId: string | null;
  periodLabel: string | null;
  /** Label stamped onto the finished assistant turn ("Grounded in …"). */
  groundedLabel: string | null;
  workspaceSnapshot?: string;
  companyName: string | null;
  // CUR-FIX — display currency + FX context so the backend system prompt can
  // instruct the model to cite figures in the user's chosen currency.
  displayCurrency: NonNullable<ChatLlmRequest["display_currency"]>;
  sourceCurrency: NonNullable<ChatLlmRequest["display_currency"]>;
  rates: RatesPayload;
  // NASDAQ-13 — only set when the operator has a Nasdaq ticker open.
  publicCompany?: ChatLlmRequest["public_company"];
}

// ── In-flight registry ─────────────────────────────────────────────
// One generating turn per conversation. `stopRequested` distinguishes the
// user's Stop button (render "Interrupted") from an abort caused by deleting
// the conversation (nothing left to render into).
interface InflightTurn {
  assistantId: string;
  controller: AbortController;
  stopRequested: boolean;
}
const inflight = new Map<string, InflightTurn>();

/** True while a reply is generating for this conversation. */
export function isChatTurnInFlight(conversationId: string): boolean {
  return inflight.has(conversationId);
}

/** The composer's Stop button. Safe to call when nothing is in flight. */
export function stopChatTurn(conversationId: string): void {
  const turn = inflight.get(conversationId);
  if (!turn) return;
  turn.stopRequested = true;
  try { turn.controller.abort(); } catch { /* already settled — ignore */ }
}

// ── Chat-cap lockout (Pricing V3, refined spec §14) ────────────────
// When the backend returns 429 chat_cap_reached the composer is locked for
// the rest of the session. Module state: the lock must survive the shell
// unmounting, or a tab switch would silently re-enable the input.
export interface ChatCapBlock { headline: string; body: string; href: string }
let capBlock: ChatCapBlock | null = null;
const capListeners = new Set<() => void>();

function setCapBlock(next: ChatCapBlock | null): void {
  capBlock = next;
  for (const l of capListeners) l();
}

function subscribeCap(cb: () => void): () => void {
  capListeners.add(cb);
  return () => { capListeners.delete(cb); };
}

export function useChatCapBlocked(): ChatCapBlock | null {
  return useSyncExternalStore(subscribeCap, () => capBlock, () => null);
}

// ── The pipeline ───────────────────────────────────────────────────

export function startChatTurn(ctx: ChatTurnContext): void {
  // 1. Optimistic UI — the user turn + a pending assistant placeholder go
  //    into the module store synchronously. The store auto-creates a
  //    conversation on the very first message of a brand-new session.
  const { conversationId, assistantId } = chatAppendUserTurn(ctx.orgId, {
    content: ctx.text,
    attachments: ctx.attachments.length > 0 ? ctx.attachments : undefined,
    organizationId: null,
    periodId: ctx.periodId,
    periodLabel: ctx.periodLabel,
  });

  // 2. Build the message-history payload. The module store is synchronous,
  //    so the conversation already contains the just-appended user turn —
  //    no React-flush race to defend against anymore.
  const conv = getChatConversation(ctx.orgId, conversationId);
  const payloadMessages = (conv?.messages ?? [])
    .filter((m) => !m.pending && m.content && !m.interrupted)
    .map((m) => ({ role: m.role, content: m.content }));

  // 3. Register the in-flight turn. `beginChatReply` keeps the nav rail's
  //    "Ask CFO AI" item showing a thinking spinner anywhere in the app;
  //    the abort handle lets deleting the conversation cancel the request.
  const controller = new AbortController();
  const turn: InflightTurn = { assistantId, controller, stopRequested: false };
  inflight.set(conversationId, turn);
  beginChatReply();
  registerChatReplyAbort(conversationId, () => controller.abort());

  void (async () => {
    try {
      const fxRate =
        ctx.displayCurrency === ctx.sourceCurrency
          ? 1
          : (ctx.rates.rates[ctx.displayCurrency] ?? 1) /
            (ctx.rates.rates[ctx.sourceCurrency] ?? 1);
      const response = await cfoApi.chatLlm({
        messages: payloadMessages,
        dataset_summary: ctx.workspaceSnapshot,
        page: "Ask CFO AI",
        company_name: ctx.companyName ?? "Workspace",
        mode: "workspace",
        display_currency: ctx.displayCurrency,
        fx_context: {
          source_currency: ctx.sourceCurrency,
          display_currency: ctx.displayCurrency,
          rate: fxRate,
          // RatesPayload uses `as_of` (date the upstream published the
          // rate) and `source` (BNR or fallback). The backend's
          // LlmFxContext expects `rate_date` + `provider` so we map here.
          rate_date: ctx.rates.as_of,
          provider: ctx.rates.source,
        },
        public_company: ctx.publicCompany,
      }, controller.signal);
      const answer = (response?.answer ?? "").trim() || "(no response)";
      // A2 — the Edge Function wraps upstream Anthropic errors in an
      // HTTP 200 whose answer is a raw "Couldn't reach Claude: <status>
      // <json>" string. That is a FAILURE wearing an answer's clothes:
      // route it through the same boundary as a thrown error so the raw
      // payload never renders.
      const upstreamKind = classifyUpstreamAnswer(answer);
      if (upstreamKind) {
        // eslint-disable-next-line no-console
        console.debug("[ai] chat turn failed upstream", { kind: upstreamKind, answer });
        setAiDegraded(upstreamKind);
        chatCompleteAssistantTurn(ctx.orgId, {
          conversationId,
          assistantId,
          content: "",
          error: true,
          failed: upstreamKind,
        });
        return;
      }
      chatCompleteAssistantTurn(ctx.orgId, {
        conversationId,
        assistantId,
        content: answer,
        groundedPeriod: ctx.groundedLabel,
      });
      // A2 auto-recover — a successful turn releases the degraded lock.
      clearAiDegraded();
    } catch (err) {
      if (controller.signal.aborted) {
        if (turn.stopRequested) {
          // User pressed Stop — leave the muted "Interrupted" marker in the
          // assistant slot. Never persisted (interrupted implies error-like
          // handling in the store).
          chatCompleteAssistantTurn(ctx.orgId, {
            conversationId,
            assistantId,
            content: "Interrupted",
            interrupted: true,
          });
        }
        // Aborted by deletion: the conversation is gone — nothing to render.
        return;
      }
      // Pricing V3 — render the chat-cap-reached 429 as a friendly
      // upgrade-CTA message, not as a generic transport error.
      // Detail shape from backend:
      //   { code: 'chat_cap_reached', kind: 'daily_cap_reached' |
      //     'monthly_cap_reached', plan_key, daily_used, daily_cap,
      //     monthly_used, monthly_cap, message, upgrade_url }
      if (err instanceof CfoApiError && err.status === 429) {
        const detail = (err.detail ?? {}) as {
          code?: string;
          kind?: string;
          message?: string;
          upgrade_url?: string;
        };
        if (detail.code === "chat_cap_reached") {
          // Strings resolve at runtime (the 429 lands mid-session), so the
          // module-level i18n instance already carries the active language.
          const headline = i18n.t(
            detail.kind === "daily_cap_reached"
              ? "chatX.cap.dailyHeadline"
              : "chatX.cap.monthlyHeadline",
          );
          const body = detail.message ?? i18n.t("chatX.cap.body");
          const link = detail.upgrade_url ?? "/pricing";
          chatCompleteAssistantTurn(ctx.orgId, {
            conversationId,
            assistantId,
            content: `**${headline}**\n\n${body}\n\n[${i18n.t("chatX.seePlans")} →](${link})`,
            error: false,
          });
          // Lock the composer for the rest of the session (spec §14
          // "disable + message if blocked"). The thread already shows
          // the long-form 429 card; the composer banner is the short
          // form + a hard input-disable so users can't keep retrying.
          setCapBlock({ headline, body, href: link });
          return;
        }
      }
      // A2 — EVERY other AI failure funnels through the one mapper. The
      // raw payload (status, request_id, JSON body) goes to console.debug
      // inside reportAiFailure and never reaches the DOM; the message
      // carries only the classified kind, which the bubble renders as the
      // calm degraded panel with Retry + a human-readable reason.
      const kind = reportAiFailure(err);
      setAiDegraded(kind);
      chatCompleteAssistantTurn(ctx.orgId, {
        conversationId,
        assistantId,
        content: "",
        error: true,
        failed: kind,
      });
    } finally {
      inflight.delete(conversationId);
      unregisterChatReplyAbort(conversationId);
      endChatReply();
    }
  })();
}
