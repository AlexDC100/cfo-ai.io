// Message stream — renders an array of ChatMessage in chronological
// order, auto-scrolls to the bottom on new content (unless the user
// has scrolled up to read history), and surfaces a typing indicator
// for the trailing pending assistant turn.
//
// The list is ALWAYS its own scroller (2026-09-10 redo of the chat page):
// the page never scrolls at the document level, so nothing on it is
// position: fixed. Inside the iOS WebView that is what keeps the composer
// still and its caret in place — WKWebView composites fixed elements a
// frame late during document scrolls and draws the caret in document
// coordinates, so a fixed composer over a scrolling document lagged and
// its caret drifted. It also re-pins to the bottom whenever its own
// height changes (the keyboard shrinking the viewport), frame by frame.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ChevronDown, ChevronUp, X } from "lucide-react";

import { useChatSearchHighlight } from "./useChatSearchHighlight";
import { CFOMessageBubble } from "./CFOMessageBubble";
import { CFOTypingIndicator } from "./CFOTypingIndicator";
import type { ChatMessage } from "./types";

export interface CFOMessageListHandle {
  /** Scroll to the newest message. `smooth` glides; otherwise it jumps. Marks
   *  the list as pinned so later growth keeps it at the bottom. */
  scrollToBottom: (smooth?: boolean) => void;
}

interface Props {
  messages: ChatMessage[];
  /** Default grounded label (for the typing indicator). */
  groundedLabel?: string | null;
  /** Extra space above the first message, as a CSS length. The full page
   *  inside the native shell passes the status-bar inset so the thread
   *  scrolls under the shell's top fade. Default: 1.5rem. */
  padTop?: string;
  /** Space under the last message, as a CSS length. Default: 1.5rem. */
  padBottom?: string;
  /** Where the "scroll to newest" arrow sits: px from the list's bottom
   *  edge. Default: just above `padBottom`. */
  arrowBottom?: number;
  /** The shell draws the arrow natively — don't render the web one. */
  hideArrow?: boolean;
  /** Fires when "there is more below" flips; drives the native arrow. */
  onHasMoreBelowChange?: (more: boolean) => void;
  /** When true, the CONTENT column follows the dashboard rendering rule
   *  (dashboard horizontal padding + left-anchored `max-w-[1760px]`) while the
   *  scroller stays full-bleed so the scrollbar keeps hugging the screen edge.
   *  Full-page chat only; the compact panel keeps its own narrow padding. */
  wideContent?: boolean;
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

export const CFOMessageList = forwardRef<CFOMessageListHandle, Props>(function CFOMessageList({
  messages, groundedLabel, padTop = "1.5rem", padBottom = "1.5rem", arrowBottom, hideArrow = false,
  onHasMoreBelowChange, wideContent = false, searchQuery = "", onClearSearch, onRetryFailed,
}: Props, handleRef) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);
  // Root for find-in-conversation.
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Revision = "the rendered text may have changed": message count plus the
  // length of the last body, which is what grows while an answer types out.
  const revision = `${messages.length}:${messages[messages.length - 1]?.content.length ?? 0}`;
  const search = useChatSearchHighlight(contentRef, searchQuery, revision);
  const stickToBottom = useRef(true);
  // Whether there is more of the thread below the viewport — drives the
  // "scroll to newest" arrow (2026-09-10 per operator). Only ever set to
  // a different value, so it doesn't re-render on every scroll tick.
  const [hasMoreBelow, setHasMoreBelow] = useState(false);
  const moreCb = useRef(onHasMoreBelowChange);
  moreCb.current = onHasMoreBelowChange;
  useEffect(() => { moreCb.current?.(hasMoreBelow); }, [hasMoreBelow]);
  // The spacer under the thread that lets a just-sent message reach the
  // top of the viewport (see "anchor on send" below). Sized straight on the
  // DOM — it changes on every typed chunk and must never re-render the list.
  const tailRef = useRef<HTMLDivElement | null>(null);
  const tailHeight = () => tailRef.current?.offsetHeight ?? 0;
  const measureBelow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setHasMoreBelow(el.scrollHeight - tailHeight() - el.scrollTop - el.clientHeight > 80);
  }, []);

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

  // While a requested glide is running, re-pins keep gliding instead of
  // jumping — otherwise the keyboard's resize would cut the motion short.
  const glideUntil = useRef(0);
  const pin = useCallback((smooth: boolean) => {
    const el = ref.current;
    if (!el) return;
    // "Bottom" is the end of the thread itself, not of the tail spacer.
    const top = Math.max(0, el.scrollHeight - tailHeight() - el.clientHeight);
    if (smooth) el.scrollTo({ top, behavior: "smooth" });
    else el.scrollTop = top;
  }, []);

  // ── Anchor on send (2026-09-10 per operator) ─────────────────────
  // A message the user has just sent glides to the TOP of the viewport and
  // the answer types out beneath it. A short thread has no room for that,
  // so the tail spacer grows by exactly what is missing; as the answer
  // fills that room the spacer gives it back. The anchor is dropped on a
  // conversation switch (the spacer with it) and replaced by the next send.
  const anchorRef = useRef<{ id: string; top: number } | null>(null);
  const lastUserIdRef = useRef<string | null | undefined>(undefined);
  // Re-size the spacer so the anchored message can still sit at the top.
  const fitTail = useCallback(() => {
    const el = ref.current;
    const tail = tailRef.current;
    if (!el || !tail) return;
    const a = anchorRef.current;
    if (!a) {
      if (tail.style.height) tail.style.height = "";
      return;
    }
    const contentMax = el.scrollHeight - tail.offsetHeight - el.clientHeight;
    const need = Math.max(0, Math.ceil(a.top - contentMax));
    const cur = Math.round(tail.offsetHeight);
    if (need !== cur) tail.style.height = need ? `${need}px` : "";
  }, []);
  const anchorMessage = useCallback((id: string) => {
    const el = ref.current;
    const node = contentRef.current?.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    if (!el || !node) return false;
    const padTopPx = parseFloat(getComputedStyle(el).paddingTop) || 0;
    const top = Math.max(0, node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - padTopPx);
    anchorRef.current = { id, top };
    fitTail();
    stickToBottom.current = false;
    glideUntil.current = Date.now() + 900;
    el.scrollTo({ top, behavior: "smooth" });
    return true;
  }, [fitTail]);

  // Keep the view pinned to the newest text as the typewriter reveals it
  // (messages array doesn't change during the reveal, so the effect below
  // won't fire — the animating bubble calls this on each tick instead).
  const scrollToBottom = useCallback(() => {
    if (!stickToBottom.current) return;
    pin(Date.now() < glideUntil.current);
  }, [pin]);

  useImperativeHandle(handleRef, () => ({
    scrollToBottom: (smooth = false) => {
      stickToBottom.current = true;
      if (smooth) glideUntil.current = Date.now() + 900;
      pin(smooth);
    },
  }), [pin]);

  // Track whether the user has scrolled away from the bottom; if they
  // have, don't yank the scroll back on every new chunk.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const slack = 24;
    const onScroll = () => {
      measureBelow();
      // A glide in progress passes through "not at the bottom" — ignore it.
      if (Date.now() < glideUntil.current) return;
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < slack;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [measureBelow]);

  // Re-pin whenever the scroller's own height changes — the on-screen
  // keyboard shrinking the page, a rotation, the sidebar toggling. The
  // keyboard animation resizes it every frame, so this is what keeps the
  // newest message sitting on the composer through the whole motion.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      fitTail();
      if (stickToBottom.current) pin(Date.now() < glideUntil.current);
      measureBelow();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [pin, measureBelow, fitTail]);

  // The thread's own growth — an answer typing out, an attachment chip, a
  // late image — hands the tail spacer back and updates the arrow. The
  // messages array doesn't change while an answer types, so the effect
  // below can't see this; the content box's size can.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      fitTail();
      measureBelow();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureBelow, fitTail]);

  // On a conversation switch the anchor (and its spacer) goes; the thread
  // lands at its bottom like before.
  useEffect(() => {
    anchorRef.current = null;
    lastUserIdRef.current = undefined;
    fitTail();
  }, [convKey, fitTail]);

  // New messages: a message the user just sent is anchored at the top;
  // otherwise, while pinned to the bottom, stay there.
  useEffect(() => {
    let lastUser: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") { lastUser = messages[i].id; break; }
    }
    const prev = lastUserIdRef.current;
    lastUserIdRef.current = lastUser;
    // `undefined` = first render of this conversation: nothing was sent.
    const sent = prev !== undefined && lastUser !== null && lastUser !== prev;
    if (!(sent && anchorMessage(lastUser as string))) {
      fitTail();
      if (stickToBottom.current) pin(false);
    }
    measureBelow();
  }, [messages, pin, measureBelow, anchorMessage, fitTail]);

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
        <div key={m.id} data-mid={m.id}>
        <CFOMessageBubble
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
        </div>
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
      {/* Floating layer — the one place a real shadow belongs (token 3). */}
      <div className="pointer-events-auto inline-flex items-center gap-1 h-8 pl-3 pr-1.5 rounded-full border border-rule bg-surface/95 backdrop-blur shadow-lg">
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
          className="grid place-items-center h-6 w-6 rounded-md text-ink-soft hover:text-ink hover:bg-bg-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronUp size={13} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={search.next}
          disabled={search.count === 0}
          aria-label={t("chatX.search.nextMatch")}
          data-testid="chat-search-next"
          className="grid place-items-center h-6 w-6 rounded-md text-ink-soft hover:text-ink hover:bg-bg-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronDown size={13} strokeWidth={2} />
        </button>
        {onClearSearch && (
          <button
            type="button"
            onClick={onClearSearch}
            aria-label={t("productsX.clearSearch")}
            data-testid="chat-search-clear"
            className="grid place-items-center h-6 w-6 rounded-md text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors"
          >
            <X size={13} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  ) : null;

  return (
    // The scroller plus, floating over its bottom edge, the arrow that
    // brings a reader who scrolled up back to the newest message. The arrow
    // is outside the scroller so it never moves with the content.
    <div className="relative flex-1 min-h-0 flex flex-col">
    <div
      ref={ref}
      className={`chat-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain ${wideContent ? "px-4 sm:px-6 lg:px-8" : "px-4 sm:px-6"}`}
      style={{ paddingTop: padTop, paddingBottom: padBottom }}
      role="log"
      aria-live="polite"
      data-testid="chat-messages"
    >
      {searchPill}
      <div ref={contentRef} className="min-h-full flex flex-col justify-end">
        {body}
      </div>
      {/* Tail spacer — sized by fitTail() for the anchored message. */}
      <div ref={tailRef} aria-hidden data-testid="chat-tail-space" />
    </div>
    {!hideArrow && (
    <button
      type="button"
      // Scrolling only (2026-09-10 per operator): the press must not take
      // focus, or the composer would blur and the keyboard would close.
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        stickToBottom.current = true;
        glideUntil.current = Date.now() + 900;
        pin(true);
      }}
      aria-label={t("chatX.scrollToNewest")}
      title={t("chatX.scrollToNewest")}
      aria-hidden={!hasMoreBelow}
      tabIndex={-1}
      data-testid="chat-scroll-to-bottom"
      // Just above the input box floating over the list's bottom, at the
      // right so it never covers the rows stacked over the input.
      style={{ bottom: arrowBottom != null ? arrowBottom : `calc(${padBottom} + 4px)` }}
      className={`absolute left-1/2 -translate-x-1/2 z-20 inline-flex h-9 w-9 items-center justify-center rounded-full border border-rule bg-surface text-ink-soft shadow-sm transition-[opacity,transform] duration-200 hover:text-ink hover:border-rule-strong active:bg-bg-2 ${hasMoreBelow ? "opacity-100" : "pointer-events-none opacity-0 translate-y-1"}`}
    >
      <ArrowDown size={16} strokeWidth={2} />
    </button>
    )}
    </div>
  );
});
