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

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CFOComposer, type CFOComposerHandle } from "./CFOComposer";
import { CFOMessageList } from "./CFOMessageList";
import { CFOEmptyState, WORKSPACE_PROMPTS, GENERAL_PROMPTS } from "./CFOEmptyState";
import { promptsForIndustry } from "./industryPrompts";
import { useActiveOrg } from "@/lib/org";
import { CFOHistorySidebar } from "./CFOHistorySidebar";
import { PageHeader } from "@/components/cfo/ui/PageHeader";
import { useChatStore } from "./useChatStore";
import { CfoApiError, cfoApi } from "@/lib/cfoApi";
import {
  beginChatReply,
  endChatReply,
  registerChatReplyAbort,
  unregisterChatReplyAbort,
} from "@/lib/chatPendingStore";
import { useCurrency } from "@/stores/currency";
import { useAuth } from "@/lib/auth";
import { getActiveOrgId } from "@/lib/activeOrg";
import { readPeriodVerdict } from "@/lib/dataPresence";
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
  // See the sidebar-entrance rule below (page variant) — true once this
  // mounted shell has rendered the no-conversations empty state.
  const sawEmptyRef = useRef(false);
  // Entrance policy (2026-07-25): animations play ONLY after the user has
  // interacted inside the tab (pointer or keyboard). Anything that changes
  // during entry — store hydration swapping the empty state for a live
  // conversation, the sidebar appearing — renders instantly at its end
  // state instead of animating. `stillEntrance` additionally applies the
  // `.chat-entrance-still` CSS freeze (index.css) that halts EVERY css
  // animation/transition in the subtree until the first interaction.
  const interactedRef = useRef(false);
  const [stillEntrance, setStillEntrance] = useState(true);
  const markInteracted = () => {
    interactedRef.current = true;
    if (stillEntrance) setStillEntrance(false);
  };
  // The measured culprit on tab entry (2026-07-25 probe): the TopHeader
  // "Ask CFO AI" pill and the currency toggle's selected segment run
  // continuous gradient sweeps OUTSIDE this shell's subtree, so the
  // subtree freeze never reached them. While the entrance window is
  // open, stamp a global freeze class on <html> and release it on the
  // first pointer/key interaction ANYWHERE (window capture — a click on
  // the header itself must also count as "in the tab now").
  useEffect(() => {
    if (variant !== "page") return;
    const root = document.documentElement;
    if (stillEntrance) root.classList.add("chat-entrance-still-global");
    else root.classList.remove("chat-entrance-still-global");
    return () => root.classList.remove("chat-entrance-still-global");
  }, [variant, stillEntrance]);
  useEffect(() => {
    if (variant !== "page" || !stillEntrance) return;
    const release = () => {
      interactedRef.current = true;
      setStillEntrance(false);
    };
    window.addEventListener("pointerdown", release, { capture: true });
    window.addEventListener("keydown", release, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", release, { capture: true });
      window.removeEventListener("keydown", release, { capture: true });
    };
  }, [variant, stillEntrance]);
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
  // Entrance stability (2026-07-25) — entering /chat via the sidebar drops
  // ?period=, so the first render is ungrounded and the REAL grounding only
  // lands after useActivePeriodFallback's resolve→navigate→fetch chain. That
  // made all 8 suggestion cards render the general set and then visibly swap
  // to the workspace set moments after entry. The persisted period verdict
  // (lib/dataPresence, sync from localStorage) already knows whether this
  // user has a period — use it to pick the FINAL prompt set on frame one.
  const { user } = useAuth();
  const expectGrounded =
    hasPeriod || Boolean(user?.id && typeof readPeriodVerdict(user.id) === "string");
  const groundedLabel = periodLabel ?? null;
  // Quick-prompt pills shown above the composer during an active conversation
  // (the empty state already shows the full prompt cards). Same set the empty
  // state uses — workspace-grounded when a period is loaded (or known to be
  // about to load), otherwise the workspace-industry-tailored set (falling
  // back to the generic one).
  const { org, loading: orgLoading } = useActiveOrg();
  // No-workspace verdict, resolved in the BACKGROUND and cached per-user so the
  // NEXT tab entry paints the adapted content immediately — no flash, no shift:
  //   · first paint reads the cached verdict (falling back to the localStorage
  //     active-org id for a brand-new session), so content is already adapted;
  //   · an effect reconciles it once `org` actually resolves, and persists it
  //     for the next entry.
  const wsPresentKey = user?.id ? `cfo-ws-present:${user.id}` : null;
  const [noWorkspace, setNoWorkspace] = useState<boolean>(() => {
    try {
      if (wsPresentKey) {
        const cached = localStorage.getItem(wsPresentKey);
        if (cached === "0") return true;
        if (cached === "1") return false;
      }
    } catch { /* ignore */ }
    return !getActiveOrgId(user?.id ?? null);
  });
  useEffect(() => {
    if (orgLoading) return;
    const present = !!org;
    setNoWorkspace(!present);
    if (wsPresentKey) {
      try { localStorage.setItem(wsPresentKey, present ? "1" : "0"); } catch { /* ignore */ }
    }
  }, [org, orgLoading, wsPresentKey]);
  const promptPills = expectGrounded
    ? WORKSPACE_PROMPTS
    : (promptsForIndustry(org?.industry_key) ?? GENERAL_PROMPTS);
  // Pyramid arrangement — two rows tall, fewer pills up top and more on the
  // bottom (e.g. 8 pills → 3 on top / 5 on the bottom). Left-aligned.
  const pyramidRows = ((items: typeof promptPills) => {
    const n = items.length;
    const topCount = Math.floor((n - 1) / 2); // strictly fewer than the bottom
    return [items.slice(0, topCount), items.slice(topCount)];
  })(promptPills);

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

    // Global in-flight signal — keeps the nav rail's "Ask CFO AI" item
    // showing a thinking spinner if the user switches tabs mid-reply.
    beginChatReply();
    // Abort handle — deleting THIS conversation mid-reply cancels the
    // request so the thinking state ends immediately (useChatStore.remove
    // fires abortChatReply).
    const aborter = new AbortController();
    registerChatReplyAbort(conversationId, () => aborter.abort());
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
      }, aborter.signal);
      const answer = (response?.answer ?? "").trim() || "(no response)";
      store.completeAssistantTurn({
        conversationId,
        assistantId,
        content: answer,
        groundedPeriod: groundedLabel,
      });
    } catch (err) {
      // Conversation was deleted mid-reply — the fetch was aborted on
      // purpose. Nothing to render (the conversation is gone); just let
      // the finally block clear the in-flight state.
      if (aborter.signal.aborted) return;
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
    } finally {
      unregisterChatReplyAbort(conversationId);
      endChatReply();
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
              <CFOEmptyState hasPeriod={expectGrounded} companyName={companyName} onPick={pickPrompt} />
            </div>
          ) : (
            <CFOMessageList messages={store.current.messages} groundedLabel={groundedLabel} />
          )}
        </div>

        <CFOComposer
          // Keyed by conversation so switching chats remounts the composer
          // with that conversation's saved draft (see chatDrafts.ts).
          key={store.currentId ?? "new"}
          draftKey={store.currentId ?? "new"}
          ref={composerRef}
          pending={pending}
          onSubmit={send}
          placeholder={expectGrounded ? `Ask about ${companyName || "your company"}…` : "Ask CFO AI anything…"}
          contextLine={contextLine}
          disclosure={disclosure}
          blockedReason={capBlocked}
          compact
        />
      </div>
    );
  }

  // Full /chat page — history sidebar (lg+) + message column. The page
  // scrolls at the DOCUMENT level (like every other tab): the conversation
  // flows in the page and the standard document scrollbar (under the top bar)
  // scrolls it. Nothing is sticky — the sidebar, messages and composer all
  // scroll with the page.
  const noConversations = store.conversations.length === 0;
  // Sidebar entrance rule: a sidebar present from this shell's FIRST
  // render (entering the tab with history) must appear instantly, but
  // when the user starts their first chat while on the empty screen the
  // panel should visibly slide open. Track "this mount has shown the
  // empty state" in a ref — render-phase write, no re-render needed.
  if (noConversations) sawEmptyRef.current = true;
  // With the sidebar present, the message content hugs closer to it (tighter
  // left gap); with no sidebar (the empty no-chats screen) it keeps the wider
  // padding so the header still lines up with the dashboard.
  const contentPadX = noConversations ? "px-4 sm:px-8 lg:px-10" : "px-4 sm:px-6 lg:px-8";
  // The composer matches the MESSAGE list's padding (not the tighter empty/
  // prompt padding) so the input box spans the same content box as the bubbles
  // — its right edge then lines up with the right-aligned user message bubbles,
  // while still honoring the px-6 side padding.
  const composerPadX = noConversations ? "px-4 sm:px-8 lg:px-10" : "px-4 sm:px-6 lg:px-8";
  return (
    // Cancel AppShell's large bottom padding for this page only (it lives on
    // the shared content wrapper) so the composer sits near the bottom instead
    // of leaving a tall empty gap below it.
    <div
      // Fully cancel AppShell's content-wrapper left padding (px-4/8/10) so the
      // chat's own inner padding (empty-state header, messages, composer — each
      // px-4/8/10) lands at exactly the same left edge as the dashboard header,
      // rather than double-padding. Also pulls the conversation list flush to
      // the app nav rail when the sidebar is shown.
      // No flex `gap` here — the space between the sidebar and the message
      // column is an animated margin ON the sidebar instead, so it collapses
      // smoothly with the width on exit (a static gap would snap away only
      // when the sidebar unmounts, stuttering at the end of the animation).
      className={`flex -ml-4 sm:-ml-8 lg:-ml-10 ${stillEntrance ? "chat-entrance-still" : ""}`}
      style={{ marginBottom: "calc(-1 * max(8rem, calc(env(safe-area-inset-bottom) + 6rem)))" }}
      data-testid="chat-page-shell"
      // Capture-phase so ANY interaction in the tab flips the flag before
      // the resulting state change renders (see entrance policy above).
      onPointerDownCapture={markInteracted}
      onKeyDownCapture={markInteracted}
    >
      {/* History sidebar (lg+). Own internal list scroller for long histories.
          `relative z-20` keeps it (and its slightly-outset scrollbar) painted
          above the message column. The negative left margin on the row above
          pulls the conversation list closer to the app's nav rail. Hidden
          entirely on the no-conversations screen — there's nothing to list or
          search yet, so the empty-state header gets the full width. */}
      {/* The conversation list appears only once there's at least one chat.
          `AnimatePresence initial={false}` skips the enter animation on page
          loads that already have chats, but when the user creates their FIRST
          chat (noConversations → false) the panel smoothly slides open from
          the left (width reveal), emerging from alongside the main app nav
          rail. It pins at 76px — level with the main nav sidebar's top edge —
          with a matching resting top so it never settles on scroll. */}
      <AnimatePresence initial={false}>
        {!noConversations && (
          <motion.div
            key="chat-history-sidebar"
            // Entering the tab WITH history: appear instantly (initial=false).
            // First chat started from the empty screen BY the user (this
            // mount has seen noConversations AND the user has interacted):
            // slide open from width 0. Hydration-driven appearance on entry
            // stays instant. Exit always animates on delete (an in-tab act).
            initial={
              sawEmptyRef.current && interactedRef.current
                ? { width: 0, opacity: 0, marginRight: 0 }
                : false
            }
            animate={{ width: 280, opacity: 1, marginRight: 0 }}
            exit={{ width: 0, opacity: 0, marginRight: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-20 hidden lg:block shrink-0 self-start sticky top-[76px] -mt-3 sm:-mt-7 lg:-mt-9 h-[calc(100dvh-76px)] overflow-hidden"
          >
            <div className="w-[280px] h-full">
              <CFOHistorySidebar
                store={store}
                onAfterPick={onPickConversationFromHistory}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative flex-1 min-w-0 flex flex-col min-h-[calc(100dvh-7rem)]">
        {/* mode="wait" + exit fade: sending the first message fades the
            header + suggested-question cards OUT before the conversation
            takes over, instead of hard-swapping. initial={false} keeps
            tab entry instant — only the exit animates. */}
        <AnimatePresence mode="wait" initial={false}>
        {!store.current || store.current.messages.length === 0 ? (
          // An empty conversation shows the SAME content as the no-chats
          // screen: the dashboard-style header + prompt starters.
          <motion.div
            key="chat-empty-content"
            exit={{ opacity: 0 }}
            // Duration 0 until the user interacts: a hydration-driven swap
            // on tab entry snaps to the end state; a user-sent first
            // message fades the empty state out.
            transition={{ duration: interactedRef.current ? 0.2 : 0, ease: "easeOut" }}
            className={`flex-1 ${contentPadX} pb-8`}
          >
            <PageHeader
              hero
              eyebrow="Ask CFO AI"
              title={<>Ask anything about your <span className="text-grad">company, documents, or finance</span>.</>}
              subtitle="CFO AI answers from your loaded workspace — P&L, Balance Sheet, Cash Flow, ratios, valuation, risk and recommendations — citing the period and the figures it used. With no workspace loaded it still answers open-domain finance, accounting and strategy questions. Pick a starter below or type your own."
              testid="chat-empty-header"
            />
            <CFOEmptyState hasPeriod={expectGrounded} companyName={companyName} onPick={pickPrompt} hideHeader />
          </motion.div>
        ) : (
          <div key="chat-live-content" className="flex-1 -mt-3 sm:-mt-7 lg:-mt-9">
            <CFOMessageList messages={store.current.messages} groundedLabel={groundedLabel} bottomInset wideContent documentScroll />
          </div>
        )}
        </AnimatePresence>

        {/* Composer + context pill are pinned to the bottom of the viewport
            (sticky) so they stay visible while the conversation scrolls behind
            them. The gradient fades the conversation into the input. */}
        <div className={`sticky bottom-0 z-10 ${composerPadX} bg-gradient-to-t from-bg via-bg/90 to-transparent pt-6 pb-1`}>
          {/* Quick-prompt pills — only inside an active conversation (the empty
              state shows the full prompt cards). Single scrollable row so they
              stay compact above the input. */}
          {store.current && store.current.messages.length > 0 && (
            <div className="max-w-[1760px] flex flex-col items-start gap-1.5 pb-2">
              {pyramidRows.map((row, r) => (
                <div key={r} className="flex flex-wrap justify-start gap-1.5">
                  {row.map((p) => (
                    <button
                      key={p.title}
                      type="button"
                      onClick={() => pickPrompt(p.prompt)}
                      className="shrink-0 whitespace-nowrap inline-flex items-center rounded-full border border-rule bg-surface px-3 py-1 text-[11.5px] text-ink-soft hover:border-brand/30 hover:text-ink hover:bg-surface transition-colors"
                      data-testid="chat-prompt-pill"
                    >
                      {p.title}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          <div className="max-w-[1760px]">
            <CFOComposer
              // Keyed by conversation so switching chats remounts the
              // composer with that conversation's saved draft.
              key={store.currentId ?? "new"}
              draftKey={store.currentId ?? "new"}
              ref={composerRef}
              pending={pending}
              onSubmit={send}
              placeholder={expectGrounded ? `Ask about ${companyName || "your company"}…` : "Ask CFO AI anything…"}
              blockedReason={capBlocked}
            />
          </div>
          {/* Context pill + general-answer disclosure — in line, under the input.
              The pill renders only when a workspace is grounded; the
              "No workspace loaded — open-domain mode" variant was removed
              per the operator (2026-07-25). */}
          <div className="max-w-[1760px] pt-0.5 pb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            {hasPeriod && (
              <span className="shrink-0 inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-bg-2 border border-rule text-[11.5px] text-ink-soft whitespace-nowrap">
                {contextLine}
              </span>
            )}
            <span className="min-w-0 text-[11px] text-ink-mute leading-snug">
              {disclosure}
            </span>
            {noWorkspace && (
              <span
                data-testid="chat-no-workspace-pill"
                title="No workspace is selected, so answers can't be grounded in your company's data."
                className="ml-auto shrink-0 inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-amber-500/10 border border-amber-500/30 text-[11.5px] font-medium text-amber-600 dark:text-amber-400 whitespace-nowrap"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
                No workspace selected — affects answers
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

// ─── Headers ──────────────────────────────────────────────────────
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
