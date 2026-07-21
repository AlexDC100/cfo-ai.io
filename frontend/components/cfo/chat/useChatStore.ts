// useChatStore — localStorage-backed conversation store for CFO AI chat.
//
// Why localStorage (not a backend table yet):
//   The spec says: "If chat persistence already exists, use it. If
//   not, create frontend/local placeholder history with structure
//   ready for backend." That's this. The shape mirrors what a future
//   `chat_conversations` + `chat_messages` Supabase pair would carry,
//   so swapping the persistence layer later is a single-file change
//   (replace this hook with a React-Query-backed version, keep the
//   API the consumers use).
//
// Cross-tab safety: every write also fires a `storage` event; other
// open tabs listening with the same key get the update for free.
// In practice this is one tab, but it costs nothing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CHAT_STORAGE_KEY, CHAT_CURRENT_KEY, type ChatConversation, type ChatMessage } from "./types";

// ── Storage helpers ────────────────────────────────────────────────
function safeReadAll(): ChatConversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive shape filter — drop any malformed entries quietly so
    // a corrupted store doesn't take the whole sidebar down.
    return parsed
      .filter((c) =>
        c &&
        typeof c.id === "string" &&
        Array.isArray(c.messages) &&
        typeof c.createdAt === "number",
      )
      .map((c) => ({
        id: String(c.id),
        title: String(c.title ?? "New conversation"),
        createdAt: Number(c.createdAt),
        updatedAt: Number(c.updatedAt ?? c.createdAt),
        organizationId: c.organizationId ?? null,
        periodId: c.periodId ?? null,
        periodLabel: c.periodLabel ?? null,
        messages: c.messages.map((m: ChatMessage) => ({
          id: String(m.id),
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content ?? ""),
          createdAt: Number(m.createdAt ?? Date.now()),
          groundedPeriod: m.groundedPeriod ?? null,
          attachments: Array.isArray(m.attachments) ? m.attachments : undefined,
          pending: false,  // Never persist `pending` — a refresh shouldn't show a spinner.
        })),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function safeWriteAll(conversations: ChatConversation[]): void {
  if (typeof window === "undefined") return;
  try {
    // Strip transient flags before persisting.
    const cleaned = conversations.map((c) => ({
      ...c,
      messages: c.messages.map((m) => ({ ...m, pending: false })),
    }));
    window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(cleaned));
  } catch {
    // Quota exceeded / private-mode: fail soft so the chat still works
    // in-memory for the session. Next message just won't survive a refresh.
  }
}

// The id the user last had open. Persisted so switching tabs (which
// unmounts /chat) and returning restores the SAME conversation rather than
// snapping to the most-recently-updated one.
function safeReadCurrentId(all: ChatConversation[]): string | null {
  const fallback = all.length > 0 ? all[0].id : null;
  if (typeof window === "undefined") return fallback;
  try {
    const saved = window.localStorage.getItem(CHAT_CURRENT_KEY);
    // Only honor it if it still points at a conversation that exists.
    if (saved && all.some((c) => c.id === saved)) return saved;
  } catch {
    /* private mode — fall through */
  }
  return fallback;
}

function safeWriteCurrentId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(CHAT_CURRENT_KEY, id);
    else window.localStorage.removeItem(CHAT_CURRENT_KEY);
  } catch {
    /* private mode — ignore */
  }
}

// ── Title derivation ──────────────────────────────────────────────
// Produce a concise, Claude-Code-style label from the first user message:
// strip a leading filler phrase ("can you…", "what is…"), capitalize, drop
// trailing punctuation, and cap on a word boundary. Deterministic — same
// message always yields the same title (no LLM round-trip needed).
const TITLE_MAX = 48;
const LEADING_FILLERS = [
  "can you", "could you", "would you", "please", "i want to", "i need to",
  "i'd like to", "i would like to", "help me", "tell me about", "tell me",
  "what is", "what's", "what are", "whats", "how do i", "how can i",
  "how do you", "how to", "give me", "show me", "explain", "describe",
  "let's", "lets", "do a", "run a", "generate a", "create a", "write a",
];
function deriveTitle(message: string): string {
  const base = message.replace(/\s+/g, " ").trim();
  if (!base) return "New conversation";

  // Strip a leading filler phrase for a punchier title.
  let t = base;
  const lower = t.toLowerCase();
  for (const f of LEADING_FILLERS) {
    if (lower.startsWith(f + " ")) { t = t.slice(f.length).trim(); break; }
  }
  // Remove leftover leading punctuation, then fall back if we stripped it all.
  t = t.replace(/^[\s:,.\-–—]+/, "");
  if (!t) t = base;

  // Capitalize the first character; trim trailing punctuation.
  t = t.charAt(0).toUpperCase() + t.slice(1);
  t = t.replace(/[?.!,;:\s]+$/, "");
  if (!t) return "New conversation";

  if (t.length <= TITLE_MAX) return t;
  // Cut on a word boundary near the limit.
  const slice = t.slice(0, TITLE_MAX);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 20 ? slice.slice(0, lastSpace) : slice).trim() + "…";
}

// ── ID generator ──────────────────────────────────────────────────
function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── Hook interface ────────────────────────────────────────────────
export interface ChatStore {
  conversations: ChatConversation[];
  currentId: string | null;
  current: ChatConversation | null;
  /** Create a new (empty) conversation and select it. Returns its id. */
  createNew: (ctx?: { organizationId?: string | null; periodId?: string | null; periodLabel?: string | null }) => string;
  /** Switch focus to an existing conversation. */
  select: (id: string) => void;
  /** Rename a conversation (user-driven). */
  rename: (id: string, title: string) => void;
  /** Delete a conversation. If it was current, falls back to the next-most-recent. */
  remove: (id: string) => void;
  /** Append a user turn + an empty assistant placeholder (with pending=true).
   *  Returns { conversationId, assistantId } so the caller can update the
   *  assistant message in place once the API responds. */
  appendUserTurn: (input: {
    content: string;
    attachments?: ChatMessage["attachments"];
    organizationId?: string | null;
    periodId?: string | null;
    periodLabel?: string | null;
  }) => { conversationId: string; assistantId: string };
  /** Fulfil the pending assistant turn with real content (or an error). */
  completeAssistantTurn: (params: {
    conversationId: string;
    assistantId: string;
    content: string;
    groundedPeriod?: string | null;
    error?: boolean;
  }) => void;
  /** Roll back the last pair (user + pending assistant) — used when the
   *  API call throws so the input box re-populates and history isn't
   *  polluted with orphaned messages. */
  rollbackLastPair: (conversationId: string) => string | null;
}

export function useChatStore(): ChatStore {
  const [conversations, setConversations] = useState<ChatConversation[]>(() => safeReadAll());
  const [currentId, setCurrentId] = useState<string | null>(() => safeReadCurrentId(safeReadAll()));

  // Persist on every change. Use a ref-guarded effect so we don't write
  // back what we just read on first render.
  const initialised = useRef(false);
  useEffect(() => {
    if (!initialised.current) { initialised.current = true; return; }
    safeWriteAll(conversations);
  }, [conversations]);

  // Remember which conversation is open so a tab switch (chat unmounts)
  // returns to the same one. Runs on mount too, which is harmless — it
  // just re-affirms the restored id.
  useEffect(() => {
    safeWriteCurrentId(currentId);
  }, [currentId]);

  // Sync across tabs.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== CHAT_STORAGE_KEY) return;
      setConversations(safeReadAll());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const current = useMemo(
    () => conversations.find((c) => c.id === currentId) ?? null,
    [conversations, currentId],
  );

  const createNew: ChatStore["createNew"] = useCallback((ctx) => {
    // Don't spawn a duplicate blank chat — if an empty conversation already
    // exists, just focus it (matches ChatGPT/Claude: "New chat" is a no-op
    // when you're already sitting on a fresh, unused conversation).
    //
    // DEV-ONLY escape hatch: on localhost (`import.meta.env.DEV`) we skip this
    // guard so you can spin up multiple empty chats while testing. The check is
    // compiled out of production builds, so a deploy always keeps the guard.
    if (!import.meta.env.DEV) {
      const existingEmpty = conversations.find((c) => c.messages.length === 0);
      if (existingEmpty) {
        setCurrentId(existingEmpty.id);
        return existingEmpty.id;
      }
    }

    const id = newId();
    const now = Date.now();
    const conv: ChatConversation = {
      id,
      title: "New conversation",
      createdAt: now,
      updatedAt: now,
      organizationId: ctx?.organizationId ?? null,
      periodId: ctx?.periodId ?? null,
      periodLabel: ctx?.periodLabel ?? null,
      messages: [],
    };
    setConversations((cs) => [conv, ...cs]);
    setCurrentId(id);
    return id;
  }, []);

  const select: ChatStore["select"] = useCallback((id) => setCurrentId(id), []);

  const rename: ChatStore["rename"] = useCallback((id, title) => {
    const clean = title.trim() || "Untitled conversation";
    setConversations((cs) =>
      cs.map((c) => (c.id === id ? { ...c, title: clean, updatedAt: Date.now() } : c)),
    );
  }, []);

  const remove: ChatStore["remove"] = useCallback((id) => {
    setConversations((cs) => {
      const next = cs.filter((c) => c.id !== id);
      if (currentId === id) {
        setCurrentId(next.length > 0 ? next[0].id : null);
      }
      return next;
    });
  }, [currentId]);

  const appendUserTurn: ChatStore["appendUserTurn"] = useCallback((input) => {
    const now = Date.now();
    const userMsg: ChatMessage = {
      id: newId(),
      role: "user",
      content: input.content,
      createdAt: now,
      attachments: input.attachments,
    };
    const assistantMsg: ChatMessage = {
      id: newId(),
      role: "assistant",
      content: "",
      createdAt: now + 1,
      groundedPeriod: input.periodLabel ?? null,
      pending: true,
    };

    let targetId = currentId;
    let createdId: string | null = null;

    setConversations((cs) => {
      let target = targetId ? cs.find((c) => c.id === targetId) ?? null : null;
      if (!target) {
        // Auto-create on first message.
        createdId = newId();
        target = {
          id: createdId,
          title: deriveTitle(input.content),
          createdAt: now,
          updatedAt: now,
          organizationId: input.organizationId ?? null,
          periodId: input.periodId ?? null,
          periodLabel: input.periodLabel ?? null,
          messages: [],
        };
        return [
          { ...target, messages: [userMsg, assistantMsg], updatedAt: now },
          ...cs.filter((c) => c.id !== target!.id),
        ];
      }
      const updated: ChatConversation = {
        ...target,
        // First user message → seed the title. Subsequent messages keep
        // whatever title was set (auto or user-renamed).
        title: target.messages.length === 0 ? deriveTitle(input.content) : target.title,
        updatedAt: now,
        organizationId: target.organizationId ?? input.organizationId ?? null,
        periodId: target.periodId ?? input.periodId ?? null,
        periodLabel: target.periodLabel ?? input.periodLabel ?? null,
        messages: [...target.messages, userMsg, assistantMsg],
      };
      return [updated, ...cs.filter((c) => c.id !== target!.id)];
    });

    if (createdId) {
      targetId = createdId;
      setCurrentId(createdId);
    }
    return { conversationId: targetId ?? createdId ?? newId(), assistantId: assistantMsg.id };
  }, [currentId]);

  const completeAssistantTurn: ChatStore["completeAssistantTurn"] = useCallback((params) => {
    setConversations((cs) =>
      cs.map((c) => {
        if (c.id !== params.conversationId) return c;
        return {
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map((m) =>
            m.id === params.assistantId
              ? {
                  ...m,
                  content: params.content,
                  groundedPeriod: params.groundedPeriod ?? m.groundedPeriod ?? null,
                  pending: false,
                }
              : m,
          ),
        };
      }),
    );
  }, []);

  const rollbackLastPair: ChatStore["rollbackLastPair"] = useCallback((conversationId) => {
    let restoredUserContent: string | null = null;
    setConversations((cs) =>
      cs.map((c) => {
        if (c.id !== conversationId) return c;
        // Drop trailing assistant + user pair.
        const ms = [...c.messages];
        const last = ms[ms.length - 1];
        if (last && last.role === "assistant") ms.pop();
        const userLast = ms[ms.length - 1];
        if (userLast && userLast.role === "user") {
          restoredUserContent = userLast.content;
          ms.pop();
        }
        return { ...c, messages: ms, updatedAt: Date.now() };
      }),
    );
    return restoredUserContent;
  }, []);

  return {
    conversations,
    currentId,
    current,
    createNew,
    select,
    rename,
    remove,
    appendUserTurn,
    completeAssistantTurn,
    rollbackLastPair,
  };
}

// ── History grouping helpers (for the sidebar) ────────────────────
export type HistoryBucket = "today" | "previous_7_days" | "older";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function bucketize(c: ChatConversation, now = Date.now()): HistoryBucket {
  const age = now - c.updatedAt;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (c.updatedAt >= startOfToday.getTime()) return "today";
  if (age < 7 * ONE_DAY_MS) return "previous_7_days";
  return "older";
}

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h`;
  if (diff < 7 * ONE_DAY_MS) return `${Math.floor(diff / ONE_DAY_MS)}d`;
  return new Date(ts).toLocaleDateString("en-GB", { month: "short", day: "numeric" });
}
