// Message stream — renders an array of ChatMessage in chronological
// order, auto-scrolls to the bottom on new content (unless the user
// has scrolled up to read history), and surfaces a typing indicator
// for the trailing pending assistant turn.

import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, X } from "lucide-react";

import { useChatSearchHighlight } from "./useChatSearchHighlight";
import { CFOMessageBubble } from "./CFOMessageBubble";
import { CFOTypingIndicator } from "./CFOTypingIndicator";
import type { ChatMessage } from "./types";

interface Props {
  messages: ChatMessage[];
  /** Default grounded label (for the typing indicator). */
  groundedLabel?: string | null;
  /** When true, adds generous bottom padding so the last message clears a
   *  floating/overlay composer and stays fully in view when scrolled to the
   *  bottom. Used by the full-page chat where the composer overlays content. */
  bottomInset?: boolean;
  /** When true, adds top padding so the first message clears the translucent
   *  app header the conversation scrolls underneath. Full-page chat only. */
  topInset?: boolean;
  /** When true, the CONTENT column follows the dashboard rendering rule
   *  (dashboard horizontal padding + left-anchored `max-w-[1760px]`) while the
   *  scroller stays full-bleed so the scrollbar keeps hugging the screen edge.
   *  Full-page chat only; the compact panel keeps its own narrow padding. */
  wideContent?: boolean;
  /** When true, the list does NOT create its own scroller — messages flow in
   *  the document and the WINDOW scrolls, so the full /chat page uses the same
   *  document scrollbar (under the top bar) as every other tab. Default false =
   *  self-contained inner scroller (used by the compact slide-over panel). */
  documentScroll?: boolean;
  /** Find-in-conversation term, mirrored from the history sidebar's search
   *  box. Matches are tinted in place and counted in a floating pill. */
  searchQuery?: string;
  /** Clear the search from the pill's ✕. */
  onClearSearch?: () => void;
  /** A2 — re-run the trailing failed turn through the send pipeline.
   *  Offered only on the conversation's LAST message; older failed turns
   *  render the degraded panel without a Retry button. */
  onRetryFailed?: () => void;
}

export function CFOMessageList({
  messages, groundedLabel, bottomInset = false, topInset = false, wideContent = false,
  documentScroll = false, searchQuery = "", onClearSearch, onRetryFailed,
}: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);
  // Root for find-in-conversation. In document-scroll mode `ref` isn't
  // attached to anything, so the highlighter gets its own container ref.
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Revision = "the rendered text may have changed": message count plus the
  // length of the last body, which is what grows while an answer types out.
  const revision = `${messages.length}:${messages[messages.length - 1]?.content.length ?? 0}`;
  const search = useChatSearchHighlight(contentRef, searchQuery, revision);
  const stickToBottom = useRef(true);

  // ── Typewriter bookkeeping ──────────────────────────────────────
  // We type out ONLY a freshly-arrived assistant answer — never history
  // on load, and never old answers when switching conversations. To do
  // that we remember which message ids have already been shown, keyed by
  // conversation. `convKey` uses the first message's id as a cheap,
  // stable proxy for "which conversation is this?".
  const animatedRef = useRef<Set<string>>(new Set());
  const convKeyRef = useRef<string | null | undefined>(undefined);
  const convKey = messages[0]?.id ?? null;
  if (convKeyRef.current !== convKey) {
    // First mount or a conversation switch: existing messages count as
    // already-seen so history doesn't re-type. But do NOT pre-mark a
    // still-pending (or empty) assistant placeholder — the answer that's
    // about to arrive for it must still type out (this is what makes the
    // first turn of a brand-new conversation animate).
    animatedRef.current = new Set(
      messages
        .filter((m) => !(m.role === "assistant" && (m.pending || !m.content)))
        .map((m) => m.id),
    );
    convKeyRef.current = convKey;
    // Land at the bottom of the freshly-opened conversation.
    stickToBottom.current = true;
  }

  // Keep the view pinned to the newest text as the typewriter reveals it
  // (messages array doesn't change during the reveal, so the effect below
  // won't fire — the animating bubble calls this on each tick instead).
  const scrollToBottom = useCallback(() => {
    if (!stickToBottom.current) return;
    if (documentScroll) {
      window.scrollTo({ top: document.documentElement.scrollHeight });
    } else if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [documentScroll]);

  // Track whether the user has scrolled away from the bottom; if they
  // have, don't yank the scroll back on every new chunk. In documentScroll
  // mode the WINDOW is the scroller; otherwise it's our own inner div.
  useEffect(() => {
    const slack = 24;
    if (documentScroll) {
      const onScroll = () => {
        const doc = document.documentElement;
        stickToBottom.current = doc.scrollHeight - window.scrollY - window.innerHeight < slack;
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      return () => window.removeEventListener("scroll", onScroll);
    }
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      if (!el) return;
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < slack;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [documentScroll]);

  // Auto-scroll on new messages while pinned to bottom.
  useEffect(() => {
    if (!stickToBottom.current) return;
    if (documentScroll) {
      window.scrollTo({ top: document.documentElement.scrollHeight });
    } else if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [messages, documentScroll]);

  const lastIsPendingAssistant =
    messages.length > 0 &&
    messages[messages.length - 1].role === "assistant" &&
    messages[messages.length - 1].pending === true;

  // Visual list. Pending assistant is rendered as a typing indicator
  // in place of an empty bubble so the layout doesn't flash.
  const visible = lastIsPendingAssistant ? messages.slice(0, -1) : messages;

  // The single message to type out: the last visible turn, when it's a
  // freshly-completed assistant answer we haven't revealed yet. We mark
  // it as animated immediately so subsequent re-renders don't restart it.
  let animateId: string | null = null;
  const lastVisible = visible[visible.length - 1];
  if (
    lastVisible &&
    lastVisible.role === "assistant" &&
    !lastVisible.pending &&
    lastVisible.content &&
    !animatedRef.current.has(lastVisible.id)
  ) {
    animateId = lastVisible.id;
    animatedRef.current.add(lastVisible.id);
  }

  const body = (
    <div className={wideContent ? "w-full max-w-[1760px]" : "w-full"}>
      {visible.map((m) => (
        <CFOMessageBubble
          key={m.id}
          message={m}
          animate={m.id === animateId}
          onType={m.id === animateId ? scrollToBottom : undefined}
          // Retry only on the trailing failed turn — the one whose user
          // message rollbackLastPair can still restore.
          onRetry={
            m.failed && m.id === messages[messages.length - 1]?.id
              ? onRetryFailed
              : undefined
          }
        />
      ))}
      {lastIsPendingAssistant && (
        <CFOTypingIndicator grounded={groundedLabel ?? null} />
      )}
    </div>
  );

  const searchPill = searchQuery.trim() ? (
    <div
      className="sticky top-2 z-20 flex justify-center pointer-events-none"
      data-testid="chat-search-pill"
    >
      <div className="pointer-events-auto inline-flex items-center gap-1 h-8 pl-3 pr-1.5 rounded-full border border-rule bg-surface/95 backdrop-blur shadow-[0_8px_24px_-16px_rgba(0,0,0,0.5)]">
        <span className="text-[11.5px] tabular-nums text-ink-soft">
          {search.count === 0
            ? t("chatX.search.noMatches")
            : t("chatX.search.matchCount", { current: search.index + 1, total: search.count })}
        </span>
        <button
          type="button"
          onClick={search.prev}
          disabled={search.count === 0}
          aria-label={t("chatX.search.prevMatch")}
          data-testid="chat-search-prev"
          className="grid place-items-center h-6 w-6 rounded-md text-ink-mute hover:text-ink hover:bg-bg-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronUp size={13} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={search.next}
          disabled={search.count === 0}
          aria-label={t("chatX.search.nextMatch")}
          data-testid="chat-search-next"
          className="grid place-items-center h-6 w-6 rounded-md text-ink-mute hover:text-ink hover:bg-bg-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronDown size={13} strokeWidth={2} />
        </button>
        {onClearSearch && (
          <button
            type="button"
            onClick={onClearSearch}
            aria-label={t("productsX.clearSearch")}
            data-testid="chat-search-clear"
            className="grid place-items-center h-6 w-6 rounded-md text-ink-mute hover:text-ink hover:bg-bg-2 transition-colors"
          >
            <X size={13} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  ) : null;

  // Document-scroll mode (full /chat page): no inner scroller — the messages
  // flow in the document and the page's own scrollbar (under the top bar)
  // scrolls them, exactly like every other tab.
  if (documentScroll) {
    return (
      <div
        className={`${wideContent ? "px-5 sm:px-8 lg:px-11" : "px-4 sm:px-6"} pt-1 ${bottomInset ? "pb-8" : "pb-6"}`}
        role="log"
        aria-live="polite"
        data-testid="chat-messages"
      >
        {searchPill}
        <div ref={contentRef}>{body}</div>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={`chat-scroll ${topInset ? "chat-scroll-header-inset" : ""} flex-1 min-h-0 overflow-y-auto overscroll-contain ${wideContent ? "px-4 sm:px-6 lg:px-8" : "px-4 sm:px-6"} ${topInset ? "pt-[4.5rem]" : "pt-6"} ${bottomInset ? "pb-48" : "pb-6"}`}
      role="log"
      aria-live="polite"
      data-testid="chat-messages"
    >
      {/* `min-h-full` + `justify-end` anchor the thread to the bottom and use
          the FULL available height (short conversations sit just above the
          composer instead of floating at the top). The content column spans
          the full available width (no centering) so the conversation uses all
          horizontal space; the scroller's scrollbar still hugs the screen's
          right edge. */}
      {searchPill}
      <div ref={contentRef} className="min-h-full flex flex-col justify-end">
        {body}
      </div>
    </div>
  );
}
