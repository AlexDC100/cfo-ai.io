// Message stream — renders an array of ChatMessage in chronological
// order, auto-scrolls to the bottom on new content (unless the user
// has scrolled up to read history), and surfaces a typing indicator
// for the trailing pending assistant turn.

import { useEffect, useRef } from "react";
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

  return (
    <div
      ref={ref}
      className="flex-1 overflow-y-auto px-4 sm:px-6 py-6"
      role="log"
      aria-live="polite"
      data-testid="chat-messages"
    >
      <div className="max-w-[820px] mx-auto">
        {visible.map((m) => (
          <CFOMessageBubble key={m.id} message={m} />
        ))}
        {lastIsPendingAssistant && (
          <CFOTypingIndicator grounded={groundedLabel ?? null} />
        )}
      </div>
    </div>
  );
}
