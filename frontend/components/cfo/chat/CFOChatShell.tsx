// CFOChatShell — the orchestrator that wires together the history
// sidebar, the message stream, the empty state, and the composer. Both
// the full /chat page and the slide-over panel mount it; they differ only
// in layout chrome (three-column page vs. compact two-row slide-over).
//
// Page layout (2026-09-10 redo): a fixed-height column — AppShell hands
// /chat the full viewport below the header — whose message list is the
// ONLY scroller and whose composer is a plain flow element at the bottom.
// Nothing scrolls at the document level and nothing is position: fixed,
// which is what makes it smooth inside the iOS WebView: the shell shrinks
// the WebView for the keyboard, the column shrinks with it, the list
// re-pins to its newest message every frame, and the composer (and its
// caret) never move relative to the screen.
//
// State ownership:
//   · The conversation STORE is owned here via `useChatStore`. The
//     same store instance backs both surfaces because both consume
//     the same localStorage key — opening the slide-over from /benchmark
//     shows the same conversations as the /chat page.
//   · The SEND PIPELINE is NOT owned here (2026-07-26 redesign): the shell
//     only gathers the context (snapshot, currency, public-company) and
//     hands it to `startChatTurn` (chatTurns.ts), which runs the request
//     at module level. Navigating away — which unmounts this shell —
//     changes nothing: the reply keeps generating in the background and
//     lands in the module store (useChatStore.ts).

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useKeyboardInset } from "./useKeyboardInset";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import { CFOComposer, type CFOComposerHandle } from "./CFOComposer";
import { CFOMessageList, type CFOMessageListHandle } from "./CFOMessageList";
import { CFOFilePreview } from "./CFOFilePreview";
import { CFOEmptyState, useWorkspacePrompts, useGeneralPrompts } from "./CFOEmptyState";
import { useIndustryPrompts } from "./industryPrompts";
import { useActiveOrg } from "@/lib/org";
import { CFOHistorySidebar } from "./CFOHistorySidebar";
import { PageHeader } from "@/components/cfo/ui/PageHeader";
import { useChatStore } from "./useChatStore";
import { startChatTurn, stopChatTurn, useChatCapBlocked } from "./chatTurns";
import { useAiDegraded } from "@/lib/aiDegraded";
import { Chip } from "@/components/instrument/Panel";
import { Info, MoreHorizontal } from "lucide-react";
import { ChatItemMenu } from "./ChatItemMenu";
import { DeleteChatDialog } from "./DeleteChatDialog";
import "./chatDegradedI18n";
import { useCurrency } from "@/stores/currency";
import { useAuth } from "@/lib/auth";
import { promptSignIn } from "@/lib/authPrompt";
import { getActiveOrgId } from "@/lib/activeOrg";
import { readPeriodVerdict } from "@/lib/dataPresence";
import { usePublicCompanyChatContext } from "@/lib/publicCompanyChatStore";
import { isNativeShell, setShellTrash, setShellChatTitle, showNativePrompt, requestNotifyPermission, postNativeComposer, NATIVE_ACTION_EVENT } from "@/lib/nativeShell";
import { readDraft, writeDraft } from "./chatDrafts";
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

// Whether the entrance freeze has already played this session.
// Module-level on purpose: it must survive the shell unmounting on every
// tab switch, which is what made the freeze re-apply on every return.
let chatEntrancePlayed = false;

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
  const { t } = useTranslation();
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
  // Find-in-conversation: the history search box also searches message
  // bodies, so the term has to reach the open conversation to highlight there
  // (2026-07-26 per operator).
  const [chatQuery, setChatQuery] = useState("");
  const interactedRef = useRef(false);
  // On-screen keyboard handling (full page only). Inside the native shell
  // the WebView itself shrinks above the keyboard, so the fixed-height
  // column simply gets shorter and `keyboardInset` is 0. In a mobile
  // BROWSER the keyboard overlays the page instead; the measured inset
  // becomes bottom padding on the column so the composer clears it.
  // `composerFocused` hides the context-pill/disclosure row under the
  // input while typing on touch devices, so the "CFO AI can answer general
  // questions…" line doesn't eat the little space above the keyboard.
  const keyboardInset = useKeyboardInset();
  const [composerFocused, setComposerFocused] = useState(false);
  // Phone-only ⓘ pill over the composer — holds the disclosure bubble open.
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const disclosureRef = useRef<HTMLDivElement>(null);
  // Dismiss the ⓘ bubble on any tap outside it or any scroll (2026-09-08 per
  // operator) — it is a transient tooltip, not a dialog. Capture-phase
  // scroll catches the conversation scroller (scroll doesn't bubble), and
  // the visual-viewport scroll covers keyboard-driven viewport shifts.
  useEffect(() => {
    if (!disclosureOpen) return undefined;
    const close = () => setDisclosureOpen(false);
    const onPointerDown = (e: PointerEvent) => {
      if (!disclosureRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", close, true);
    window.visualViewport?.addEventListener("scroll", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", close, true);
      window.visualViewport?.removeEventListener("scroll", close);
    };
  }, [disclosureOpen]);
  const coarsePointer =
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: coarse)").matches;
  // Focusing the composer never scrolls the thread (2026-09-10 per
  // operator). A reader scrolled up stays where they are; the list shows
  // its own "newer messages" arrow when there is content below.
  // The composer block floats OVER the bottom of the thread with no
  // background of its own (2026-09-10 per operator: content stays visible
  // under it), so the scrollers pad their bottom by its measured height.
  // NATIVE composer (2026-09-10 per operator, page variant in the shell):
  // the input is drawn by the shell in Liquid Glass; this page only tells
  // it what to show and reserves its height at the bottom of the thread.
  const nativeComposer = isNativeShell() && variant === "page";
  const [nativeComposerHeight, setNativeComposerHeight] = useState(0);
  const composerDraftKey = store.currentId ?? "new";
  const listRef = useRef<CFOMessageListHandle | null>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  // Files picked through the native paperclip; shown as chips above the
  // native composer and sent with the next message.
  const [nativeAttachments, setNativeAttachments] = useState<ChatAttachment[]>([]);
  const composerBlockRef = useRef<HTMLDivElement | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  const [composerBlockHeight, setComposerBlockHeight] = useState(0);
  // Where the "scroll to newest" arrow sits: just above the whole
  // composer block — the rows stacked over the input included
  // (2026-09-10 per operator, after trying it directly on the box).
  const [arrowBottom, setArrowBottom] = useState(0);
  useEffect(() => {
    const el = composerBlockRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const block = el.getBoundingClientRect();
      setComposerBlockHeight(Math.round(block.height));
      setArrowBottom(Math.round(block.height) + 2);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (composerBoxRef.current) ro.observe(composerBoxRef.current);
    return () => ro.disconnect();
  }, [variant]);
  const scrollPadBottom = `${(nativeComposer ? composerBlockHeight + nativeComposerHeight : composerBlockHeight) + 8}px`;
  // Top-right "…" disc on phones / in the shell (2026-09-10 per operator)
  // — the same disc as the shell's burger, mirrored to the other corner.
  // It opens the chat's Rename / Delete menu (ChatItemMenu).
  const [menuOpen, setMenuOpen] = useState(false);
  // In the shell the disc is NATIVE (2026-09-10 per operator): a SwiftUI
  // Menu in Liquid Glass, drawn top-right by the shell while this page has
  // a chat open, headed by the chat's title. Its items arrive as native
  // actions "chat-rename" (→ native text prompt) and "chat-delete" (→ the
  // native confirm).
  const chatOpen = variant === "page" && !!store.current && store.current.messages.length > 0;
  const [nativeDeleteOpen, setNativeDeleteOpen] = useState(false);
  const currentTitle = store.current?.title ?? "";
  useEffect(() => {
    if (!isNativeShell()) return undefined;
    setShellTrash(chatOpen);
    setShellChatTitle(chatOpen ? currentTitle : "");
    return () => { setShellTrash(false); setShellChatTitle(""); };
  }, [chatOpen, currentTitle]);
  useEffect(() => {
    if (!isNativeShell() || !chatOpen) return undefined;
    const onAction = (e: Event) => {
      const d = (e as CustomEvent<{ action?: string; id?: string }>).detail;
      // With an id it is the drawer's row menu (Sidebar handles it).
      if (!d || typeof d.id === "string") return;
      const action = d.action;
      if (action === "chat-delete") setNativeDeleteOpen(true);
      if (action === "chat-rename" && store.current) {
        const conv = store.current;
        void showNativePrompt({ title: t("chatX.rename"), defaultValue: conv.title, options: [t("common.cancel"), t("common.save")] }).then((text) => {
          const title = (text ?? "").trim();
          if (title && title !== conv.title) store.rename(conv.id, title);
        });
      }
    };
    window.addEventListener(NATIVE_ACTION_EVENT, onAction);
    return () => window.removeEventListener(NATIVE_ACTION_EVENT, onAction);
  }, [chatOpen, store, t]);
  const keyboardOpen = keyboardInset > 0 || (coarsePointer && composerFocused);
  // Once per SESSION, not per mount (2026-07-26 per operator). The freeze is
  // an entrance treatment for the first time you land on the tab; re-applying
  // it on every remount meant leaving /chat and coming back froze the typing
  // dots and the send spinner mid-animation until you clicked something —
  // and while a reply was in flight that read as the assistant having hung.
  const [stillEntrance, setStillEntrance] = useState(() => !chatEntrancePlayed);
  const markInteracted = () => {
    interactedRef.current = true;
    chatEntrancePlayed = true;
    if (stillEntrance) setStillEntrance(false);
  };

  // Safety release: never hold the freeze longer than a beat. A mount the user
  // never clicks into (they came back from another tab while a reply was in
  // flight) would otherwise keep every animation paused indefinitely.
  useEffect(() => {
    if (!stillEntrance) return;
    const t = window.setTimeout(() => {
      chatEntrancePlayed = true;
      setStillEntrance(false);
    }, 900);
    return () => window.clearTimeout(t);
  }, [stillEntrance]);
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
    // Not inside the native shell (2026-09-08 per operator): there is no
    // TopHeader there to keep still, and the app-wide freeze reached the
    // burger drawer — its staggered rows sit at opacity 0 until their
    // animation runs, so tapping a conversation left a blank drawer that
    // then took the whole freeze window to close.
    if (stillEntrance && !isNativeShell()) root.classList.add("chat-entrance-still-global");
    else root.classList.remove("chat-entrance-still-global");
    return () => root.classList.remove("chat-entrance-still-global");
  }, [variant, stillEntrance]);
  useEffect(() => {
    if (variant !== "page" || !stillEntrance) return;
    const release = () => {
      interactedRef.current = true;
      chatEntrancePlayed = true;
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
  // chat_cap_reached, chatTurns locks the composer for the rest of the
  // session (module state — survives tab switches) and this hook mirrors it
  // into the banner + hard input-disable.
  const capBlocked = useChatCapBlocked();

  // A2 — while the assistant is degraded (a turn failed and Retry hasn't
  // succeeded yet), the composer and every suggestion chip stay VISIBLE
  // but disabled with a tooltip. Cleared automatically by the next
  // successful turn (see lib/aiDegraded.ts).
  const degraded = useAiDegraded();
  const degradedTooltip = degraded ? t("chatDegraded.disabledTooltip") : null;

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
  const workspacePrompts = useWorkspacePrompts();
  const generalPrompts = useGeneralPrompts();
  const industryPrompts = useIndustryPrompts(org?.industry_key);
  const promptPills = expectGrounded
    ? workspacePrompts
    : (industryPrompts ?? generalPrompts);
  // Pyramid arrangement — two rows tall, fewer pills up top and more on the
  // bottom (e.g. 8 pills → 3 on top / 5 on the bottom). Left-aligned.
  const pyramidRows = ((items: typeof promptPills) => {
    const n = items.length;
    const topCount = Math.floor((n - 1) / 2); // strictly fewer than the bottom
    return [items.slice(0, topCount), items.slice(topCount)];
  })(promptPills);

  // ── Send pipeline ───────────────────────────────────────────────
  // Gather the context and hand off to the module-level controller. The
  // request runs in the background from here on — this shell can unmount
  // (tab switch) without affecting the turn.
  const send = useCallback((text: string, attachments: ChatAttachment[]) => {
    // Guest mode (2026-09-03): browsing the chat surface is open, but the
    // first actual message asks for an account — the turn would otherwise
    // run uncapped and its history would be unpersistable (no thread owner).
    if (!user) {
      promptSignIn();
      return;
    }
    // Shell: the answer may land while the app is in the background — ask
    // for the notification permission with the first message (2026-09-10).
    requestNotifyPermission();
    startChatTurn({
      orgId: org?.id ?? null,
      text,
      attachments,
      periodId,
      periodLabel,
      groundedLabel,
      workspaceSnapshot,
      companyName,
      displayCurrency: currencyDisplay,
      sourceCurrency: currencySource,
      rates: currencyRates,
      // NASDAQ-13 — only shipped when the operator has a Nasdaq ticker
      // open. Workspace chat without public-company context sends
      // `undefined` here and the backend skips the block.
      publicCompany: publicCompanyContext ?? undefined,
    });
  }, [
    user,
    org?.id,
    workspaceSnapshot,
    periodId,
    periodLabel,
    companyName,
    groundedLabel,
    currencyDisplay,
    currencyRates,
    publicCompanyContext,
  ]);

  // Stop button — interrupts the open conversation's generating reply.
  // chatTurns stamps the muted "Interrupted" marker into the thread.
  const stopCurrent = useCallback(() => {
    if (store.currentId) stopChatTurn(store.currentId);
  }, [store.currentId]);

  // A2 Retry — roll the failed pair back (restores the user's question)
  // and re-run it through the normal send pipeline with the CURRENT
  // context. Success clears the degraded lock; another failure re-arms it.
  const retryFailedTurn = useCallback(() => {
    if (!store.currentId) return;
    const restored = store.rollbackLastPair(store.currentId);
    if (restored) send(restored, []);
  }, [store, send]);

  const pending = useMemo(
    () => {
      if (!store.current) return false;
      const last = store.current.messages[store.current.messages.length - 1];
      return Boolean(last && last.role === "assistant" && last.pending);
    },
    [store.current],
  );

  function pickPrompt(prompt: string) {
    if (nativeComposer) {
      // The native input shows whatever the draft says for this key.
      writeDraft(composerDraftKey, prompt);
      setNativeDraftTick((n) => n + 1);
      return;
    }
    composerRef.current?.setText(prompt);
  }
  const [nativeDraftTick, setNativeDraftTick] = useState(0);
  const nativePlaceholder = expectGrounded ? t("chatX.askAboutPlaceholder", { name: companyName || t("chatX.yourCompany") }) : t("chatX.askAnythingPlaceholder");
  useEffect(() => {
    if (!nativeComposer) return undefined;
    postNativeComposer({
      show: true,
      placeholder: capBlocked ? t("chatX.pausedPlaceholder") : nativePlaceholder,
      pending,
      disabled: !!capBlocked || !!degraded,
      draft: readDraft(composerDraftKey),
      key: `${composerDraftKey}:${nativeDraftTick}`,
      arrow: moreBelow,
      info: t("chatX.disclosure"),
    });
    return () => postNativeComposer({ show: false });
    // nativeDraftTick re-sends a prompt-card pick as a fresh draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeComposer, nativePlaceholder, pending, capBlocked, degraded, composerDraftKey, nativeDraftTick, moreBelow, t]);
  useEffect(() => {
    if (!nativeComposer) return undefined;
    const onAction = (e: Event) => {
      const d = (e as CustomEvent<{ action?: string; text?: string; height?: number; name?: string; size?: number; type?: string }>).detail;
      if (!d) return;
      if (d.action === "composer-submit" && typeof d.text === "string") {
        writeDraft(composerDraftKey, "");
        setNativeAttachments((cur) => {
          send(d.text as string, cur);
          return [];
        });
      } else if (d.action === "composer-scroll") {
        listRef.current?.scrollToBottom(true);
      } else if (d.action === "composer-attach" && typeof d.name === "string") {
        // ONE attachment at a time, like the web composer.
        setNativeAttachments([{
          id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          name: d.name,
          size: typeof d.size === "number" ? d.size : 0,
          type: d.type || "application/octet-stream",
          status: "queued",
        }]);
      } else if (d.action === "composer-stop") {
        stopCurrent();
      } else if (d.action === "composer-draft" && typeof d.text === "string") {
        writeDraft(composerDraftKey, d.text);
      } else if (d.action === "composer-height" && typeof d.height === "number") {
        setNativeComposerHeight(d.height);
      }
    };
    window.addEventListener(NATIVE_ACTION_EVENT, onAction);
    return () => window.removeEventListener(NATIVE_ACTION_EVENT, onAction);
  }, [nativeComposer, composerDraftKey, send, stopCurrent]);

  // ── Disclosure + context line ───────────────────────────────────
  const disclosure = <>{t("chatX.disclosure")}</>;

  const contextLine = hasPeriod ? (
    <>
      {t("chatX.groundedIn")} <span className="text-ink-soft">{companyName || t("chatX.yourWorkspace")}</span>
      {/* The active period's label falls back to the company name, so without
          this check the pill read "X · X" (2026-07-26 per operator). */}
      {periodLabel && periodLabel !== companyName ? (
        <> · <span className="text-ink-soft">{periodLabel}</span></>
      ) : null}
    </>
  ) : (
    <>{t("chatX.noWorkspaceMode")}</>
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
            <CFOMessageList
              messages={store.current.messages}
              groundedLabel={groundedLabel}
              onRetryFailed={retryFailedTurn}
            />
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
          onStop={stopCurrent}
          placeholder={expectGrounded ? `Ask about ${companyName || "your company"}…` : "Ask CFO AI anything…"}
          contextLine={contextLine}
          disclosure={disclosure}
          blockedReason={capBlocked}
          degradedReason={degradedTooltip}
          compact
        />
      </div>
    );
  }

  // Full /chat page — history sidebar (lg+) + message column, inside the
  // fixed-height box AppShell gives /chat (see AppShell `chatPage`). The
  // message list is the only scroller; the composer block sits in flow
  // under it. Nothing here is fixed or sticky.
  const noConversations = store.conversations.length === 0;
  // Sidebar entrance rule: a sidebar present from this shell's FIRST
  // render (entering the tab with history) must appear instantly, but
  // when the user starts their first chat while on the empty screen the
  // panel should visibly slide open. Track "this mount has shown the
  // empty state" in a ref — render-phase write, no re-render needed.
  if (noConversations) sawEmptyRef.current = true;
  const inShell = isNativeShell();
  // With the sidebar present, the message content hugs closer to it (tighter
  // left gap); with no sidebar (the empty no-chats screen) it keeps the wider
  // padding so the header still lines up with the dashboard.
  const contentPadX = noConversations ? "px-4 sm:px-8 lg:px-10" : "px-4 sm:px-6 lg:px-8";
  // The composer matches the MESSAGE list's padding (not the tighter empty/
  // prompt padding) so the input box spans the same content box as the bubbles
  // — its right edge then lines up with the right-aligned user message bubbles,
  // while still honoring the px-6 side padding.
  // px-2 on phones (2026-08-18 per operator: the input should run nearly
  // edge-to-edge); sm+ keeps the message-list alignment described above.
  const composerPadX = noConversations ? "px-2 sm:px-8 lg:px-10" : "px-2 sm:px-6 lg:px-8";
  // Inside the shell the page runs edge-to-edge under the status bar, so the
  // scrollers start below the shell's top fade; browsers start under the
  // header with the usual page top padding.
  const scrollPadTop = inShell ? "calc(env(safe-area-inset-top) + 28px)" : "1.5rem";
  const emptyPadTop = inShell ? "calc(env(safe-area-inset-top) + 28px)" : undefined;
  return (
    <div
      className={`flex h-full min-h-0 w-full ${stillEntrance ? "chat-entrance-still" : ""}`}
      // A browser keyboard overlays the page: shorten the column by the
      // measured inset so the composer rides above it (0 in the shell).
      style={{ paddingBottom: keyboardInset || undefined }}
      data-testid="chat-page-shell"
      // Capture-phase so ANY interaction in the tab flips the flag before
      // the resulting state change renders (see entrance policy above).
      onPointerDownCapture={markInteracted}
      onKeyDownCapture={markInteracted}
    >
      {/* History sidebar (lg+) — a full-height column beside the thread with
          its own internal list scroller. `relative z-20` keeps it (and its
          slightly-outset scrollbar) painted above the message column. Hidden
          entirely on the no-conversations screen — there's nothing to list or
          search yet, so the empty-state header gets the full width.
          `AnimatePresence initial={false}` skips the enter animation on page
          loads that already have chats, but when the user creates their FIRST
          chat (noConversations → false) the panel smoothly slides open from
          the left (width reveal). */}
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
                ? { width: 0, opacity: 0 }
                : false
            }
            animate={{ width: 280, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-20 hidden lg:block shrink-0 h-full overflow-hidden"
          >
            <div className="w-[280px] h-full pt-3">
              <CFOHistorySidebar
                store={store}
                onAfterPick={onPickConversationFromHistory}
                query={chatQuery}
                onQueryChange={setChatQuery}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative flex-1 min-w-0 flex flex-col h-full min-h-0">
        {store.current && store.current.messages.length > 0 && (
          <>
            {!inShell && (
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label={t("chatX.chatOptions")}
              title={t("chatX.chatOptions")}
              data-testid="chat-more-button"
              className="lg:hidden absolute right-3 z-30 inline-flex h-11 w-11 items-center justify-center rounded-full border border-rule bg-surface/85 backdrop-blur-xl text-ink active:opacity-70 transition-opacity duration-micro"
              style={{ top: "0.75rem" }}
            >
              <MoreHorizontal size={18} strokeWidth={1.75} />
            </button>
            )}
            {/* Browser: the menu drops from under the web disc (12px + 44px). */}
            {!inShell && (
            <ChatItemMenu
              conversation={menuOpen ? store.current : null}
              anchor={{ kind: "corner", top: 64, right: 12 }}
              onClose={() => setMenuOpen(false)}
              onRename={(id, title) => store.rename(id, title)}
              onDelete={(id) => store.remove(id)}
            />
            )}
            {/* Shell: the native menu's Delete lands here for its confirm. */}
            {inShell && (
            <DeleteChatDialog
              open={nativeDeleteOpen}
              onOpenChange={setNativeDeleteOpen}
              onConfirm={() => {
                setNativeDeleteOpen(false);
                if (store.currentId) store.remove(store.currentId);
              }}
            />
            )}
          </>
        )}
        {/* Content swap is instant — no fade (2026-07-26 per operator:
            "remove the fade in content effect when changing chat items"). The
            empty-state ↔ conversation swap snaps rather than cross-fading. */}
        <AnimatePresence mode="wait" initial={false}>
        {!store.current || store.current.messages.length === 0 ? (
          // An empty conversation shows the SAME content as the no-chats
          // screen: the dashboard-style header + prompt starters, in their
          // own scroller above the composer.
          <motion.div
            key="chat-empty-content"
            transition={{ duration: 0 }}
            className={`chat-scroll flex-1 min-h-0 overflow-y-auto overscroll-contain ${contentPadX} pt-6 sm:pt-10 lg:pt-12`}
            style={{ paddingBottom: scrollPadBottom, ...(emptyPadTop ? { paddingTop: emptyPadTop } : {}) }}
            data-testid="chat-empty-scroller"
          >
            <PageHeader
              hero
              eyebrow={t("topbar.askCfoAi")}
              title={<Trans i18nKey="chatX.pageTitle" components={{ grad: <span className="text-grad" /> }} />}
              subtitle={t("chatX.pageSubtitle")}
              testid="chat-empty-header"
            />
            <CFOEmptyState hasPeriod={expectGrounded} companyName={companyName} onPick={pickPrompt} hideHeader />
          </motion.div>
        ) : (
          <CFOMessageList
            key="chat-live-content"
            messages={store.current.messages}
            groundedLabel={groundedLabel}
            padTop={scrollPadTop}
            padBottom={scrollPadBottom}
            ref={listRef}
            arrowBottom={arrowBottom + (nativeComposer ? nativeComposerHeight : 0)}
            hideArrow={nativeComposer}
            onHasMoreBelowChange={setMoreBelow}
            wideContent
            searchQuery={chatQuery}
            onClearSearch={() => setChatQuery("")}
            onRetryFailed={retryFailedTurn}
          />
        )}
        </AnimatePresence>

        {/* Composer block — floats over the bottom of the thread (absolute
            inside the non-scrolling column, so it never moves) with NO
            background: the conversation stays visible beneath and around
            it; the input box alone carries a surface. The home-indicator
            inset is part of its padding (the env() is 0 while the keyboard
            covers that strip). */}
        <div
          ref={composerBlockRef}
          className={`absolute inset-x-0 bottom-0 z-10 ${composerPadX} pt-2`}
          // Idle, the input sits low — just clear of the home indicator
          // (2026-09-10 per operator); with the keyboard up the env() is 0.
          style={{ paddingBottom: nativeComposer ? nativeComposerHeight : "max(0.25rem, calc(env(safe-area-inset-bottom) - 0.5rem))", background: "transparent" }}
          data-testid="chat-composer-block"
          // Only the textarea counts as "typing" — a tapped ⓘ/attach/send
          // button also takes focus on Android, and treating that as the
          // keyboard being up hid the context row before the ⓘ bubble
          // could open (2026-09-08).
          onFocusCapture={(e) => {
            if (!(e.target instanceof HTMLTextAreaElement)) return;
            setComposerFocused(true);
          }}
          onBlurCapture={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setComposerFocused(false);
            }
          }}
        >
          {/* Quick-prompt pills — only inside an active conversation (the empty
              state shows the full prompt cards). Hidden below sm: on a phone
              the two pill rows ate half the space above the composer. */}
          {store.current && store.current.messages.length > 0 && (
            <div className="max-w-[1760px] hidden sm:flex flex-col items-start gap-1.5 pb-2">
              {pyramidRows.map((row, r) => (
                <div key={r} className="flex flex-wrap justify-start gap-1.5">
                  {row.map((p) => (
                    <button
                      key={p.title}
                      type="button"
                      onClick={() => pickPrompt(p.prompt)}
                      disabled={!!degraded}
                      title={degradedTooltip ?? undefined}
                      className="shrink-0 whitespace-nowrap inline-flex items-center rounded-full border border-rule bg-surface px-3 py-1 text-[11.5px] text-ink-soft hover:border-brand/30 hover:text-ink hover:bg-surface transition-colors duration-micro disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-rule disabled:hover:text-ink-soft"
                      data-testid="chat-prompt-pill"
                    >
                      {p.title}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          <div className="max-w-[1760px] relative">
            {/* Phones (2026-09-06 per operator): one left-aligned row ABOVE
                the composer — the ⓘ disclosure button first, then the
                "No workspace selected" pill beside it. The ⓘ replaces the
                disclosure sentence (tap to read it in a bubble); the pill
                moved up here from the row under the input. ≥sm never
                renders this row — it keeps the caption row below the
                composer. Hidden while the on-screen keyboard is up, like
                the row below (2026-08-18). */}
            <div className={`${keyboardOpen ? "hidden" : "flex"} sm:hidden items-center gap-2 pb-1.5`}>
              {!nativeComposer && (
              <div className="relative shrink-0" ref={disclosureRef}>
                {disclosureOpen && (
                  <div className="absolute bottom-full left-0 mb-1.5 w-64 rounded-md border border-rule bg-surface p-2.5 text-[11px] text-ink-soft leading-snug shadow-md">
                    {disclosure}
                  </div>
                )}
                <button
                  type="button"
                  data-testid="chat-disclosure-pill"
                  aria-label={t("chatX.disclosure")}
                  aria-expanded={disclosureOpen}
                  onClick={() => setDisclosureOpen((v) => !v)}
                  className="inline-flex items-center justify-center h-6 w-6 rounded-full border border-rule bg-surface text-ink-soft shadow-sm active:bg-bg-2 transition-colors duration-micro"
                >
                  <Info size={12} strokeWidth={2} />
                </button>
              </div>
              )}
              {noWorkspace && (
                <Chip
                  tone="caution"
                  dot
                  data-testid="chat-no-workspace-pill-phone"
                  title={t("chatX.noWorkspacePillTitle")}
                  className="min-w-0 truncate"
                >
                  {t("chatX.noWorkspacePill")}
                </Chip>
              )}
            </div>
            {nativeComposer && nativeAttachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pb-2" data-testid="chat-native-attachments">
                {nativeAttachments.map((a) => (
                  <CFOFilePreview key={a.id} attachment={a} onRemove={() => setNativeAttachments((cur) => cur.filter((x) => x.id !== a.id))} />
                ))}
              </div>
            )}
            {!nativeComposer && (
            <div ref={composerBoxRef}>
              <CFOComposer
                // Keyed by conversation so switching chats remounts the
                // composer with that conversation's saved draft.
                key={store.currentId ?? "new"}
                draftKey={store.currentId ?? "new"}
                ref={composerRef}
                pending={pending}
                onSubmit={send}
                onStop={stopCurrent}
                placeholder={expectGrounded ? t("chatX.askAboutPlaceholder", { name: companyName || t("chatX.yourCompany") }) : t("chatX.askAnythingPlaceholder")}
                blockedReason={capBlocked}
                degradedReason={degradedTooltip}
              />
            </div>
            )}
          </div>
          {/* Context pill + general-answer disclosure — in line, under the input.
              The pill renders only when a workspace is grounded. Hidden while
              the on-screen keyboard is up (2026-08-18) — on a phone this row
              would eat the sliver of space above the keyboard; it returns
              when the keyboard closes. */}
          {/* On phones the row holds only the grounding chip, so without a
              period it is dropped entirely — no empty band under the input
              (2026-09-10 per operator). */}
          <div className={`max-w-[1760px] pt-1 pb-3 flex-wrap items-center gap-x-3 gap-y-1 ${keyboardOpen ? "hidden" : hasPeriod ? "flex" : "hidden sm:flex"}`}>
            {/* Grounding as a Chip (tone accent) — workspace + period. The
                grounding is a VERIFIED statement about which book the
                assistant reads, so it carries the accent, not a neutral
                pill. */}
            {hasPeriod && (
              <Chip tone="accent" dot className="shrink-0 whitespace-nowrap" data-testid="chat-grounding-chip">
                {contextLine}
              </Chip>
            )}
            {/* Honesty caption — quiet, caption-sized, unchanged meaning.
                Hidden on phones, where the ⓘ pill over the composer carries
                the same text behind a tap. */}
            <span className="hidden sm:inline min-w-0 text-[11px] text-ink-soft leading-snug">
              {disclosure}
            </span>
            {/* ≥sm only — on phones the pill sits in the row above the
                composer (2026-09-06). */}
            {noWorkspace && (
              <Chip
                tone="caution"
                dot
                data-testid="chat-no-workspace-pill"
                title={t("chatX.noWorkspacePillTitle")}
                className="ml-auto shrink-0 whitespace-nowrap hidden sm:inline-flex"
              >
                {t("chatX.noWorkspacePill")}
              </Chip>
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
  const { t } = useTranslation();
  return (
    <header className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-rule bg-surface/60">
      <div className="min-w-0 flex-1">
        <h2 className="text-[13.5px] font-medium text-ink truncate">
          {conversationTitle === "New conversation" ? t("topbar.askCfoAi") : conversationTitle}
        </h2>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onNewChat}
          className="inline-flex items-center h-7 px-2 rounded text-[11.5px] text-ink-soft hover:text-ink hover:bg-bg-2/60 transition-colors"
        >
          {t("chatX.new")}
        </button>
        {onExpandToPage && (
          <button
            type="button"
            onClick={onExpandToPage}
            className="inline-flex items-center h-7 px-2 rounded text-[11.5px] text-ink-soft hover:text-ink hover:bg-bg-2/60 transition-colors"
          >
            {t("chatX.openPage")}
          </button>
        )}
      </div>
    </header>
  );
}
