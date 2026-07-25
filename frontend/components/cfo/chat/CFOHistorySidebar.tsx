// CFOHistorySidebar — ChatGPT/Claude-style conversation history column.
//
// Renders:
//   · "New chat" CTA at the top
//   · search-input below the CTA
//   · scrollable list, grouped Today / Previous 7 days / Older
//   · hover actions: rename / delete
//   · honest empty-state when no conversations exist yet
//
// The component is presentation-only — it consumes a ChatStore handle
// passed from the shell. Both the full /chat page and the slide-over
// panel mount it (the panel uses the same store).

import { useMemo, useState } from "react";
import { Plus, Search, Trash2, X } from "lucide-react";
import { relativeTime, type ChatStore } from "./useChatStore";
import type { ChatConversation } from "./types";

interface Props {
  store: ChatStore;
  /** Optional close callback — used by the slide-over panel to also
   *  close itself when the user picks an item. The full-page mount
   *  passes `undefined` so picks just switch focus. */
  onAfterPick?: () => void;
  /** Tighter spacing for the slide-over variant. */
  compact?: boolean;
}

export function CFOHistorySidebar({ store, onAfterPick, compact = false }: Props) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return store.conversations;
    return store.conversations.filter((c) =>
      c.title.toLowerCase().includes(q) ||
      c.messages.some((m) => m.content.toLowerCase().includes(q)),
    );
  }, [store.conversations, query]);

  return (
    <aside
      className={`
        h-full flex flex-col pl-7 pr-2
        ${compact ? "w-[280px]" : "w-[280px]"}
      `}
      data-testid="chat-history-sidebar"
      aria-label="Conversation history"
    >
      {/* Header: search + icon-only New chat button (flush to the section
          edges — no left/right gutter). */}
      <div className="pb-1.5 flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search
            size={12}
            strokeWidth={2}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-mute pointer-events-none"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            data-testid="chat-history-search"
            className="
              w-full h-8 pl-7 pr-7 rounded-md
              bg-bg-2/50 border border-rule
              text-[12.5px] text-ink placeholder:text-ink-mute
              focus:outline-none focus:bg-surface focus:border-rule
              transition-colors
            "
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded text-ink-mute hover:text-ink"
            >
              <X size={11} />
            </button>
          )}
        </div>

        {/* Icon-only New chat button — animated gradient accent (same
            treatment as the "Ask CFO AI" pill). */}
        <button
          type="button"
          onClick={() => { store.createNew(); onAfterPick?.(); }}
          aria-label="New chat"
          title="New chat"
          className="
            shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-md
            ask-ai-anim-fill [animation-duration:10s]
            border border-brand/40 text-ink
          "
          data-testid="chat-new-conversation"
        >
          <Plus size={16} strokeWidth={2} />
        </button>
      </div>

      {/* List — thin app-themed inside scrollbar (kept within the panel so it's
          never clipped by the slide-in animation's overflow), soft top/bottom
          fade on the scroll edges. */}
      <div className="chat-scroll chat-list-fade flex-1 overflow-y-auto px-0 pb-2 pt-1.5">
        {store.conversations.length === 0 ? (
          <EmptyHistory />
        ) : filtered.length === 0 ? (
          <NoMatch query={query} />
        ) : (
          // Flat list, most-recent first — no time-period section headers.
          <ul className="space-y-0.5">
            {filtered.map((c) => (
              <ConversationRow
                key={c.id}
                conv={c}
                active={c.id === store.currentId}
                onPick={() => { store.select(c.id); onAfterPick?.(); }}
                onDelete={() => store.remove(c.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

// ─── Row ───────────────────────────────────────────────────────────
function ConversationRow({
  conv, active, onPick, onDelete,
}: {
  conv: ChatConversation;
  active: boolean;
  onPick: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      className={`
        group relative rounded-md
        ${active ? "bg-surface border border-rule" : "hover:bg-bg-2/60 border border-transparent"}
        transition-colors
      `}
    >
      <button
        type="button"
        onClick={onPick}
        className="w-full text-left pl-3 pr-7 py-2.5 flex items-center gap-2 min-w-0"
        data-testid="chat-history-item"
        data-active={active ? "true" : "false"}
      >
        <span className="min-w-0 flex-1">
          <span className={`block text-[12.5px] truncate ${active ? "text-ink font-medium" : "text-ink-soft"}`}>
            {conv.title}
          </span>
          <span className="block text-[10.5px] text-ink-mute mt-px">
            {relativeTime(conv.updatedAt)} · {conv.messages.filter((m) => m.role === "user").length || 0} msg
          </span>
        </span>
      </button>

      {/* Delete button — appears on hover (always visible for the active
          row), sits at the right edge, and never triggers row selection. */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        aria-label="Delete conversation"
        className={`
          absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded
          text-ink-mute hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10
          transition-opacity
          opacity-0 group-hover:opacity-100
          focus-visible:opacity-100
        `}
      >
        <Trash2 size={13} strokeWidth={1.75} />
      </button>
    </li>
  );
}

// ─── Empty + no-match ──────────────────────────────────────────────
function EmptyHistory() {
  return (
    <div className="px-3 py-6 text-center" data-testid="chat-history-empty">
      <p className="text-[12.5px] text-ink-soft">No conversations yet</p>
      <p className="text-[11px] text-ink-mute mt-1 leading-snug">
        Start by asking CFO AI about your numbers.
      </p>
    </div>
  );
}

function NoMatch({ query }: { query: string }) {
  return (
    <div className="px-3 py-6 text-center">
      <p className="text-[12.5px] text-ink-soft">No matches for &ldquo;{query}&rdquo;.</p>
    </div>
  );
}
