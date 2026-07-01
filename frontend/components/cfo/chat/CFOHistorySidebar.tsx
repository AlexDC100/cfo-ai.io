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
import { MessageSquarePlus, Search, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import { bucketize, relativeTime, type ChatStore, type HistoryBucket } from "./useChatStore";
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

const BUCKET_LABEL: Record<HistoryBucket, string> = {
  today: "Today",
  previous_7_days: "Previous 7 days",
  older: "Older",
};

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

  const grouped = useMemo(() => {
    const now = Date.now();
    const groups: Record<HistoryBucket, ChatConversation[]> = {
      today: [],
      previous_7_days: [],
      older: [],
    };
    for (const c of filtered) groups[bucketize(c, now)].push(c);
    return groups;
  }, [filtered]);

  return (
    <aside
      className={`
        h-full flex flex-col bg-bg-2/30 border-r border-rule
        ${compact ? "w-[280px]" : "w-[280px]"}
      `}
      data-testid="chat-history-sidebar"
      aria-label="Conversation history"
    >
      {/* Header: New chat + search */}
      <div className="px-3 pt-3 pb-2 border-b border-rule/60 space-y-2">
        <button
          type="button"
          onClick={() => { store.createNew(); onAfterPick?.(); }}
          className="
            w-full inline-flex items-center gap-2 h-9 px-3 rounded-lg
            border border-rule bg-surface
            text-[13px] font-medium text-ink
            hover:border-brand/30 hover:bg-surface/90
            transition-colors
          "
          data-testid="chat-new-conversation"
        >
          <MessageSquarePlus size={14} strokeWidth={1.75} />
          <span>New chat</span>
        </button>

        <div className="relative">
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
              bg-bg-2/50 border border-transparent
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
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {store.conversations.length === 0 ? (
          <EmptyHistory />
        ) : filtered.length === 0 ? (
          <NoMatch query={query} />
        ) : (
          (["today", "previous_7_days", "older"] as HistoryBucket[]).map((b) =>
            grouped[b].length > 0 ? (
              <Group
                key={b}
                label={BUCKET_LABEL[b]}
                items={grouped[b]}
                currentId={store.currentId}
                onPick={(id) => { store.select(id); onAfterPick?.(); }}
                onRename={store.rename}
                onDelete={store.remove}
              />
            ) : null,
          )
        )}
      </div>
    </aside>
  );
}

// ─── Group ─────────────────────────────────────────────────────────
function Group({
  label, items, currentId, onPick, onRename, onDelete,
}: {
  label: string;
  items: ChatConversation[];
  currentId: string | null;
  onPick: (id: string) => void;
  onRename: (id: string, t: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="mb-3">
      <div className="px-2 mb-1 text-[10px] uppercase tracking-[0.14em] text-ink-mute font-medium">
        {label}
      </div>
      <ul className="space-y-0.5">
        {items.map((c) => (
          <ConversationRow
            key={c.id}
            conv={c}
            active={c.id === currentId}
            onPick={() => onPick(c.id)}
            onRename={(t) => onRename(c.id, t)}
            onDelete={() => onDelete(c.id)}
          />
        ))}
      </ul>
    </div>
  );
}

// ─── Row ───────────────────────────────────────────────────────────
function ConversationRow({
  conv, active, onPick, onRename, onDelete,
}: {
  conv: ChatConversation;
  active: boolean;
  onPick: () => void;
  onRename: (t: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conv.title);
  const [menuOpen, setMenuOpen] = useState(false);

  function commitRename() {
    setEditing(false);
    setMenuOpen(false);
    if (draft.trim() && draft.trim() !== conv.title) onRename(draft.trim());
  }

  return (
    <li
      className={`
        group relative rounded-md
        ${active ? "bg-surface border border-rule" : "hover:bg-bg-2/60 border border-transparent"}
        transition-colors
      `}
    >
      {editing ? (
        <div className="px-2.5 py-1.5">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") { setEditing(false); setDraft(conv.title); }
            }}
            onBlur={commitRename}
            className="w-full bg-transparent text-[12.5px] text-ink focus:outline-none"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={onPick}
          className="w-full text-left px-2.5 py-1.5 flex items-center gap-2 min-w-0"
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
      )}

      {/* Hover actions */}
      {!editing && (
        <div className={`absolute right-1 top-1/2 -translate-y-1/2 ${menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"} focus-within:opacity-100 transition-opacity`}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            aria-label="Conversation actions"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-mute hover:text-ink hover:bg-bg-2"
          >
            <MoreHorizontal size={13} strokeWidth={2} />
          </button>
          {menuOpen && (
            <>
              {/* Outside-click catcher — replaces the fragile onMouseLeave
                  that dismissed the menu the instant the pointer moved from
                  the ⋯ button onto a menu item. Row hover also no longer
                  hides it (wrapper is forced opacity-100 while open). */}
              <div
                className="fixed inset-0 z-10"
                onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }}
                aria-hidden
              />
            <div
              className="absolute right-0 top-7 z-20 w-32 rounded-md border border-rule bg-surface shadow-lg py-1"
            >
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setEditing(true); setMenuOpen(false); }}
                className="w-full text-left px-3 py-1.5 text-[12.5px] text-ink-soft hover:bg-bg-2/60 inline-flex items-center gap-2"
              >
                <Pencil size={11} strokeWidth={1.75} /> Rename
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDelete(); setMenuOpen(false); }}
                className="w-full text-left px-3 py-1.5 text-[12.5px] text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 inline-flex items-center gap-2"
              >
                <Trash2 size={11} strokeWidth={1.75} /> Delete
              </button>
            </div>
            </>
          )}
        </div>
      )}
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
