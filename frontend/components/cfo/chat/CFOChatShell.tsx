// CFOChatShell — the orchestrator that wires together the history
// sidebar, the message stream, the empty state, and the sticky
// composer. Both the full /chat page and the slide-over panel mount
// it; they differ only in layout chrome (full-bleed three-column
// vs. compact two-row slide-over).
//
// State ownership:
//   · The conversation STORE is owned here via `useChatStore`. The
//     same store instance backs both surfaces because both consume
//     the same localStorage key — opening the slide-over from /benchmark
//     shows the same conversations as the /chat page.
//   · The SEND PIPELINE is owned here: build messages array, build
//     workspace snapshot from props, call `cfoApi.chatLlm()`, update
//     the store. The API call shape is byte-identical to what
//     Chat.tsx used before this redesign.

import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import { CFOComposer, type CFOComposerHandle } from "./CFOComposer";
import { CFOMessageList } from "./CFOMessageList";
import { CFOEmptyState } from "./CFOEmptyState";
import { CFOHistorySidebar } from "./CFOHistorySidebar";
import { useChatStore } from "./useChatStore";
import { CfoApiError, cfoApi } from "@/lib/cfoApi";
import { useCurrency } from "@/stores/currency";
import { usePublicCompanyChatContext } from "@/lib/publicCompanyChatStore";
import type { ChatAttachment } from "./types";
import type { Currency } from "@/lib/rates";

export interface CFOChatShellHandle {
  /** Focus the composer textarea (used by the in-page "Ask CFO AI"
   *  click to keep the user in the conversation rather than navigating). */
  focusComposer: () => void;
  /** Replace the composer's text with `prompt` and focus — used when
   *  a contextual chip (e.g. "Which SKUs are loss-makers?") fires
   *  openAskCfoAi(prompt) and we want the user to land with the
   *  question already typed for them. */
  setComposer: (prompt: string) => void;
  /** Start a fresh conversation. */
  newChat: () => void;
}

interface Props {
  /** Workspace context — feeds the system prompt's `dataset_summary`.
   *  When null/empty the assistant runs in pure open-domain mode. */
  workspaceSnapshot?: string | undefined;
  /** Display label for the active period (e.g. "FY 2025"). */
  periodLabel?: string | null;
  /** Stable period id (URL ?period= UUID or sample id). Stamped onto
   *  new conversations so the history sidebar can later filter by
   *  period. */
  periodId?: string | null;
  /** Company name for the empty-state headline + system-prompt anchor. */
  companyName?: string | null;
  /** "Ask CFO AI" page if true; compact slide-over if false. Controls
   *  spacing, sidebar visibility, and the message-list max width. */
  variant?: "page" | "panel";
  /** Slide-over only — called when the user requests "Open full page". */
  onExpandToPage?: () => void;
  /** Slide-over only — called when a history item is picked so the
   *  panel can close itself. */
  onPickConversationFromHistory?: () => void;
}

export const CFOChatShell = forwardRef<CFOChatShellHandle, Props>(function CFOChatShell(
  {
    workspaceSnapshot,
    periodLabel = null,
    periodId = null,
    companyName = null,
    variant = "page",
    onExpandToPage,
    onPickConversationFromHistory,
  },
  ref,
) {
  const store = useChatStore();
  const composerRef = useRef<CFOComposerHandle | null>(null);
  // CUR-FIX — currency context for the chat send pipeline. `display` is
  // the user's chosen surface currency (TopHeader toggle); we assume the
  // workspace source is RON unless the active period's payload says
  // otherwise (most Romanian SME data IS RON). When display === source
  // no FX context is needed but we still send it so the backend system
  // prompt is consistent.
  const { display: currencyDisplay, rates: currencyRates } = useCurrency();
  const currencySource: Currency = "RON";

  // NASDAQ-13 — when the user is on /public-companies with a ticker
  // selected, this hook returns the snapshot to attach to every chat
  // turn. PublicCompanyIntelligence sets it on row select and clears
  // it on unmount, so a chat opened from anywhere else gets null and
  // the backend skips the public-company directive entirely.
  const publicCompanyContext = usePublicCompanyChatContext();

  // Pricing V3 (refined spec §14) — when the backend returns 429
  // chat_cap_reached, we lock the composer for the rest of the session and
  // surface a banner. The user still sees the cap-reached card in the
  // thread (rendered by `completeAssistantTurn` below); the banner +
  // disabled input prevents pointless retries.
  const [capBlocked, setCapBlocked] = useState<
    { headline: string; body: string; href: string } | null
  >(null);

  useImperativeHandle(ref, () => ({
    focusComposer: () => composerRef.current?.focus(),
    setComposer: (prompt: string) => composerRef.current?.setText(prompt),
    newChat: () => store.createNew({
      organizationId: null,
      periodId,
      periodLabel,
    }),
  }));

  const hasPeriod = Boolean(periodId && workspaceSnapshot);
  const groundedLabel = periodLabel ?? null;

  // ── Send pipeline ───────────────────────────────────────────────
  const send = useCallback(async (text: string, attachments: ChatAttachment[]) => {
    // 1. Optimistic UI — drop the user turn + a pending assistant
    //    placeholder into the store. The store auto-creates a
    //    conversation on the very first message of a brand-new session.
    const { conversationId, assistantId } = store.appendUserTurn({
      content: text,
      attachments: attachments.length > 0 ? attachments : undefined,
      organizationId: null,
      periodId,
      periodLabel,
    });

    // 2. Build the message-history payload from the store snapshot at
    //    THIS moment, INCLUDING the just-appended user turn. (We can't
    //    rely on a re-render here — we read the freshest state.)
    const conv = store.conversations.find((c) => c.id === conversationId);
    const priorMessages = conv
      ? conv.messages.filter((m) => !m.pending && m.content)
      : [];
    // Inject the just-sent user message (in case state hasn't flushed
    // by the time we build the payload).
    const payloadMessages = [
      ...priorMessages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: text },
    ];
    // Deduplicate consecutive identical user turns (defensive — happens
    // if the state already had the user message when we read it).
    const dedup: typeof payloadMessages = [];
    for (const m of payloadMessages) {
      const last = dedup[dedup.length - 1];
      if (last && last.role === m.role && last.content === m.content) continue;
      dedup.push(m);
    }

    try {
      // CUR-FIX — inject display currency + FX context so the backend
      // system prompt can instruct the model to cite figures in the
      // user's chosen currency. Without these, the model defaults to
      // the source currency it sees in `dataset_summary`, which is
      // wrong any time the toggle differs from the period's source.
      const fxRate =
        currencyDisplay === currencySource
          ? 1
          : (currencyRates.rates[currencyDisplay] ?? 1) /
            (currencyRates.rates[currencySource] ?? 1);
      const response = await cfoApi.chatLlm({
        messages: dedup,
        dataset_summary: workspaceSnapshot,
        page: "Ask CFO AI",
        company_name: companyName ?? "Workspace",
        mode: "workspace",
        display_currency: currencyDisplay,
        fx_context: {
          source_currency: currencySource,
          display_currency: currencyDisplay,
          rate: fxRate,
          // RatesPayload uses `as_of` (date the upstream published the
          // rate) and `source` (BNR or fallback). The backend's
          // LlmFxContext expects `rate_date` + `provider` so we map here.
          rate_date: currencyRates.as_of,
          provider: currencyRates.source,
        },
        // NASDAQ-13 — only shipped when the operator has a Nasdaq
        // ticker open. Workspace chat without public-company context
        // sends `undefined` here and the backend skips the block.
        public_company: publicCompanyContext ?? undefined,
      });
      const answer = (response?.answer ?? "").trim() || "(no response)";
      store.completeAssistantTurn({
        conversationId,
        assistantId,
        content: answer,
        groundedPeriod: groundedLabel,
      });
    } catch (err) {
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
          const headline =
            detail.kind === "daily_cap_reached"
              ? "Daily Ask CFO AI limit reached"
              : "Monthly Ask CFO AI limit reached";
          const body = detail.message ??
            "You've hit your plan's chat cap. It resets automatically — or upgrade for more headroom.";
          const link = detail.upgrade_url ?? "/pricing";
          store.completeAssistantTurn({
            conversationId,
            assistantId,
            content: `**${headline}**\n\n${body}\n\n[See plans →](${link})`,
            error: false,
          });
          // Lock the composer for the rest of the session (spec §14
          // "disable + message if blocked"). The thread already shows
          // the long-form 429 card; the composer banner is the short
          // form + a hard input-disable so users can't keep retrying.
          setCapBlocked({ headline, body, href: link });
          return;
        }
      }
      const msg = err instanceof Error ? err.message : "Couldn't reach the assistant.";
      store.completeAssistantTurn({
        conversationId,
        assistantId,
        content: `**Couldn't reach the assistant.** ${msg}\n\nTry again in a moment.`,
        error: true,
      });
    }
  }, [
    store,
    workspaceSnapshot,
    periodId,
    periodLabel,
    companyName,
    groundedLabel,
    currencyDisplay,
    currencyRates,
    publicCompanyContext,
  ]);

  const pending = useMemo(
    () => {
      if (!store.current) return false;
      const last = store.current.messages[store.current.messages.length - 1];
      return Boolean(last && last.role === "assistant" && last.pending);
    },
    [store.current],
  );

  function pickPrompt(prompt: string) {
    composerRef.current?.setText(prompt);
  }

  // ── Disclosure + context line ───────────────────────────────────
  const disclosure = (
    <>
      CFO AI can answer general questions too — answers not drawn from your workspace data
      may not be current or verified. Confirm regulatory/tax specifics before acting.
    </>
  );

  const contextLine = hasPeriod ? (
    <>
      Grounded in <span className="text-ink-soft">{companyName || "your workspace"}</span>
      {periodLabel ? <> · <span className="text-ink-soft">{periodLabel}</span></> : null}
    </>
  ) : (
    <>No workspace loaded — open-domain mode</>
  );

  // ── Layout ──────────────────────────────────────────────────────
  if (variant === "panel") {
    // Compact two-row layout for the slide-over panel.
    return (
      <div className="h-full flex flex-col bg-bg" data-testid="chat-panel-shell">
        <PanelHeader
          conversationTitle={store.current?.title ?? "New conversation"}
          onNewChat={() => store.createNew({ periodId, periodLabel })}
          onExpandToPage={onExpandToPage}
        />

        {/* Body — either empty state or messages */}
        <div className="flex-1 min-h-0 flex flex-col">
          {!store.current || store.current.messages.length === 0 ? (
            <div className="flex-1 overflow-y-auto px-4 py-2">
              <CFOEmptyState hasPeriod={hasPeriod} companyName={companyName} onPick={pickPrompt} />
            </div>
          ) : (
            <CFOMessageList messages={store.current.messages} groundedLabel={groundedLabel} />
          )}
        </div>

        <CFOComposer
          ref={composerRef}
          pending={pending}
          onSubmit={send}
          placeholder={hasPeriod ? `Ask about ${companyName || "your company"}…` : "Ask CFO AI anything…"}
          contextLine={contextLine}
          disclosure={disclosure}
          blockedReason={capBlocked}
          compact
        />
      </div>
    );
  }

  // Full /chat page — three-column workspace on lg+, single-column on mobile.
  // History sidebar hidden below lg (1024px); users can still create new
  // conversations via PageHeader's "New chat" button. Future enhancement:
  // expose history as a Sheet drawer triggered from PageHeader.
  return (
    // Header spans the full width at the top; BELOW it a row holds the
    // history sidebar (left) and the message column + composer (right).
    // (Previously the sidebar was a full-height left column and the header
    // sat only above the chat — moved per request so the header caps the
    // whole page and the sidebar lives under it.)
    <div className="h-full w-full flex flex-col bg-bg" data-testid="chat-page-shell">
      <PageHeader
        companyName={companyName}
        periodLabel={periodLabel}
        hasPeriod={hasPeriod}
        conversationTitle={store.current?.title ?? null}
      />

      <div className="flex-1 min-h-0 flex">
        <div className="hidden lg:flex">
          <CFOHistorySidebar
            store={store}
            onAfterPick={onPickConversationFromHistory}
          />
        </div>

        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 flex flex-col">
            {!store.current || store.current.messages.length === 0 ? (
              <div className="flex-1 overflow-y-auto px-6">
                <CFOEmptyState hasPeriod={hasPeriod} companyName={companyName} onPick={pickPrompt} />
              </div>
            ) : (
              <CFOMessageList messages={store.current.messages} groundedLabel={groundedLabel} />
            )}
          </div>

          <CFOComposer
            ref={composerRef}
            pending={pending}
            onSubmit={send}
            placeholder={hasPeriod ? `Ask about ${companyName || "your company"}…` : "Ask CFO AI anything…"}
            contextLine={contextLine}
            disclosure={disclosure}
            blockedReason={capBlocked}
          />
        </div>
      </div>
    </div>
  );
});

// ─── Headers ──────────────────────────────────────────────────────
function PageHeader({
  companyName, periodLabel, hasPeriod, conversationTitle,
}: {
  companyName: string | null;
  periodLabel: string | null;
  hasPeriod: boolean;
  conversationTitle: string | null;
}) {
  return (
    <header className="flex items-center justify-between gap-3 px-6 py-3 border-b border-rule bg-surface/60 backdrop-blur-sm">
      <div className="min-w-0">
        <h1 className="text-[15px] font-medium text-ink truncate">
          {conversationTitle && conversationTitle !== "New conversation"
            ? conversationTitle
            : "Ask CFO AI"}
        </h1>
        <p className="text-[11.5px] text-ink-mute mt-0.5 truncate">
          Ask about your company, documents, strategy, or finance.
        </p>
      </div>

      <div className="flex items-center gap-2">
        {hasPeriod && (
          <span className="hidden md:inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-bg-2/50 border border-rule text-[11.5px] text-ink-soft">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            <span className="truncate max-w-[200px]">{companyName || "Workspace"}{periodLabel ? ` · ${periodLabel}` : ""}</span>
          </span>
        )}
        {/* "New chat" button removed from the page header per request — a
            "New chat" action still lives at the top of the history sidebar
            (CFOHistorySidebar), so the capability isn't lost. */}
      </div>
    </header>
  );
}

function PanelHeader({
  conversationTitle, onNewChat, onExpandToPage,
}: {
  conversationTitle: string;
  onNewChat: () => void;
  onExpandToPage?: () => void;
}) {
  return (
    <header className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-rule bg-surface/60">
      <div className="min-w-0 flex-1">
        <h2 className="text-[13.5px] font-medium text-ink truncate">
          {conversationTitle === "New conversation" ? "Ask CFO AI" : conversationTitle}
        </h2>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onNewChat}
          className="inline-flex items-center h-7 px-2 rounded text-[11.5px] text-ink-soft hover:text-ink hover:bg-bg-2/60 transition-colors"
        >
          New
        </button>
        {onExpandToPage && (
          <button
            type="button"
            onClick={onExpandToPage}
            className="inline-flex items-center h-7 px-2 rounded text-[11.5px] text-ink-soft hover:text-ink hover:bg-bg-2/60 transition-colors"
          >
            Open page →
          </button>
        )}
      </div>
    </header>
  );
}
