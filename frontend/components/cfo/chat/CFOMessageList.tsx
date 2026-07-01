// Message stream — renders an array of ChatMessage in chronological
// order, auto-scrolls to the bottom on new content (unless the user
// has scrolled up to read history), and surfaces a typing indicator
// for the trailing pending assistant turn.

import { useCallback, useEffect, useRef } from "react";
import { CFOMessageBubble } from "./CFOMessageBubble";
import { CFOTypingIndicator } from "./CFOTypingIndicator";
import type { ChatMessage } from "./types";

interface Props {
  messages: ChatMessage[];
  /** Default grounded label (for the typing indicator). */
  groundedLabel?: string | null;
}

export function CFOMessageList({ messages, groundedLabel }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
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
    // First mount or a conversation switch: everything currently on
    // screen counts as already-seen, so nothing pre-existing re-types.
    animatedRef.current = new Set(messages.map((m) => m.id));
    convKeyRef.current = convKey;
  }

  // Keep the view pinned to the newest text as the typewriter reveals it
  // (messages array doesn't change during the reveal, so the effect below
  // won't fire — the animating bubble calls this on each tick instead).
  const scrollToBottom = useCallback(() => {
    if (ref.current && stickToBottom.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, []);

  // Track whether the user has scrolled away from the bottom; if they
  // have, don't yank the scroll back on every new chunk.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const slack = 24;
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < slack;
    }
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll on new messages while pinned to bottom.
  useEffect(() => {
    if (!ref.current || !stickToBottom.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages]);

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

  return (
    <div
      ref={ref}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 sm:px-6 py-6"
      role="log"
      aria-live="polite"
      data-testid="chat-messages"
    >
      {/* `min-h-full` + `justify-end` anchor the thread to the bottom and use
          the FULL available height (short conversations sit just above the
          composer instead of floating at the top). Crucially the SCROLLER
          above stays a normal block — the flex column lives one level in — so
          long threads scroll all the way to the top without the flex+auto-
          margin clipping bug. `max-w-[820px] mx-auto` centres the column. */}
      <div className="min-h-full flex flex-col justify-end">
        <div className="w-full max-w-[820px] mx-auto">
          {visible.map((m) => (
            <CFOMessageBubble
              key={m.id}
              message={m}
              animate={m.id === animateId}
              onType={m.id === animateId ? scrollToBottom : undefined}
            />
          ))}
          {lastIsPendingAssistant && (
            <CFOTypingIndicator grounded={groundedLabel ?? null} />
          )}
        </div>
      </div>
    </div>
  );
}
