// useChatStore — Supabase-backed conversation store for CFO AI chat.
//
// Conversations live in `chat_threads` / `chat_messages` (see
// supabase/schema_phase_chat.sql) and are scoped to the ACTIVE WORKSPACE:
// switching to another company shows that company's chats, because a
// conversation's answers are grounded in one company's numbers and would be
// misleading anywhere else. RLS also scopes them to the signed-in user.
//
// localStorage remains as a per-workspace CACHE so the sidebar paints
// instantly and the chat keeps working signed-out / offline / before the
// migration is applied. The store is optimistic: every mutation updates React
// state immediately and persists in the background — the UI never waits on the
// network mid-conversation.
//
// Threads are written LAZILY, on the first real message. Clicking "New chat"
// creates nothing server-side; an empty placeholder isn't worth a row and
// would litter the sidebar on every other device.
//
// Ids are client-generated UUIDs reused as primary keys, so persistence never
// has to remap them and a repeated import collides on the PK instead of
// duplicating history.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveOrg } from "@/lib/org";
import {
  chatIdentity,
  deleteMessages,
  deleteThread,
  fetchConversations,
  importLocalConversations,
  insertMessage,
  insertThread,
  updateThread,
} from "./chatRemote";
import { CHAT_STORAGE_KEY, CHAT_CURRENT_KEY, type ChatConversation, type ChatMessage } from "./types";
import { clearDraft } from "./chatDrafts";
import { abortChatReply } from "@/lib/chatPendingStore";

// ── Storage helpers ────────────────────────────────────────────────
// The cache is keyed per workspace; the bare legacy key is the pre-workspace
// history, read once and imported into the active workspace.
function cacheKey(orgId: string | null): string {
  return orgId ? `${CHAT_STORAGE_KEY}:${orgId}` : CHAT_STORAGE_KEY;
}

const LEGACY_IMPORTED_KEY = "cfo-ai-chat-history-imported-v1";

function parseConversations(raw: string | null): ChatConversation[] {
  if (!raw) return [];
  try {
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

function safeReadAll(orgId: string | null): ChatConversation[] {
  if (typeof window === "undefined") return [];
  try {
    return parseConversations(window.localStorage.getItem(cacheKey(orgId)));
  } catch {
    return [];
  }
}

function safeWriteAll(orgId: string | null, conversations: ChatConversation[]): void {
  if (typeof window === "undefined") return;
  try {
    // Strip transient flags before persisting.
    const cleaned = conversations.map((c) => ({
      ...c,
      messages: c.messages.map((m) => ({ ...m, pending: false })),
    }));
    window.localStorage.setItem(cacheKey(orgId), JSON.stringify(cleaned));
  } catch {
    // Quota exceeded / private-mode: fail soft so the chat still works
    // in-memory for the session. Next message just won't survive a refresh.
  }
}

// ── Deletion tombstones ────────────────────────────────────────────
// A deleted conversation must STAY deleted (operator-reported 2026-07-25:
// deleted chats reappeared on the next tab entry). remove() deletes the
// row server-side, but that request can race the initial fetch, fail
// offline, or — before this fix — never fire at all, because it was gated
// on the `persisted` set, which is only populated once the remote fetch
// resolves. Tombstones remember every locally-deleted id (per workspace,
// in localStorage) so hydration filters them out of fetch results and
// retries the server-side delete until it sticks.
const DELETED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function deletedKey(orgId: string | null): string {
  return orgId ? `cfo-ai-chat-deleted-v1:${orgId}` : "cfo-ai-chat-deleted-v1";
}

function readTombstones(orgId: string | null): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(deletedKey(orgId)) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Prune stale entries — once the server delete has stuck for a month,
    // the id can't come back, so the tombstone is just dead weight.
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const [id, ts] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof ts === "number" && now - ts < DELETED_TTL_MS) out[id] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

function writeTombstones(orgId: string | null, tombstones: Record<string, number>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(deletedKey(orgId), JSON.stringify(tombstones));
  } catch {
    /* private mode / quota — deletion still applied locally + remotely */
  }
}

function addTombstone(orgId: string | null, id: string): void {
  const t = readTombstones(orgId);
  t[id] = Date.now();
  writeTombstones(orgId, t);
}

function clearTombstone(orgId: string | null, id: string): void {
  const t = readTombstones(orgId);
  if (id in t) {
    delete t[id];
    writeTombstones(orgId, t);
  }
}

/** Pre-workspace history, or [] once it has been imported. */
function readLegacyConversations(): ChatConversation[] {
  if (typeof window === "undefined") return [];
  try {
    if (window.localStorage.getItem(LEGACY_IMPORTED_KEY) === "1") return [];
    return parseConversations(window.localStorage.getItem(CHAT_STORAGE_KEY));
  } catch {
    return [];
  }
}

function markLegacyImported(): void {
  try {
    window.localStorage.setItem(LEGACY_IMPORTED_KEY, "1");
  } catch {
    /* private mode — the PK collision on re-import is the real safety net */
  }
}

// The id the user last had open. Persisted so switching tabs (which
// unmounts /chat) and returning restores the SAME conversation rather than
// snapping to the most-recently-updated one. Device-local by design.
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
// UUIDs, because they become the `chat_threads.id` / `chat_messages.id`
// primary keys verbatim.
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
  const { org } = useActiveOrg();
  const orgId = org?.id ?? null;

  // Seed from the ACTIVE workspace's cache when the org is already
  // resolved at mount (every in-app navigation) — not the legacy bare
  // key. Reading the workspace cache only in the effect below meant the
  // first render was always empty, so opening /chat with existing
  // history mounted the sidebar a frame late and replayed its
  // slide-open entrance every visit.
  const [conversations, setConversations] = useState<ChatConversation[]>(() => safeReadAll(orgId));
  const [currentId, setCurrentId] = useState<string | null>(() =>
    safeReadCurrentId(safeReadAll(orgId)),
  );

  // Mirror of state for the mutation callbacks. Persisting needs to know what
  // a conversation looked like BEFORE the update (was it new? is this its
  // first message?), and reading that inside a setState updater would mean
  // firing network calls from a reducer.
  const convsRef = useRef<ChatConversation[]>(conversations);
  useEffect(() => { convsRef.current = conversations; }, [conversations]);

  // Threads known to exist server-side, so appendUserTurn knows whether to
  // INSERT the thread or just append to it.
  const persisted = useRef<Set<string>>(new Set());
  const identityRef = useRef<{ userId: string; orgId: string } | null>(null);
  // In-flight thread inserts, keyed by conversation id.
  //
  // The assistant turn can complete before its thread row lands (a cached or
  // errored reply returns in milliseconds, the INSERT takes a round-trip).
  // Without this, completeAssistantTurn would find the thread "not persisted
  // yet" and silently drop the answer from history. Everything that writes a
  // message awaits this promise first.
  const threadInserts = useRef<Map<string, Promise<boolean>>>(new Map());

  const ensureThread = useCallback(async (conv: ChatConversation): Promise<boolean> => {
    if (persisted.current.has(conv.id)) return true;
    const inflight = threadInserts.current.get(conv.id);
    if (inflight) return inflight;

    const promise = (async () => {
      const identity = identityRef.current ?? (await chatIdentity());
      identityRef.current = identity;
      if (!identity) return false;
      // A conversation restored from the pre-workspace cache has no
      // organizationId; it belongs to whichever workspace is open now. Only
      // refuse when it explicitly names a DIFFERENT one, which means the user
      // switched workspaces while a reply was in flight.
      if (conv.organizationId && conv.organizationId !== identity.orgId) return false;
      const ok = await insertThread(identity, conv);
      if (ok) persisted.current.add(conv.id);
      return ok;
    })();
    threadInserts.current.set(conv.id, promise);
    void promise.finally(() => threadInserts.current.delete(conv.id));
    return promise;
  }, []);

  const applyConversations = useCallback(
    (next: ChatConversation[]) => {
      convsRef.current = next;
      setConversations(next);
      safeWriteAll(orgId, next);
    },
    [orgId],
  );

  // Load the workspace's conversations: cache first (instant), then the
  // server (authoritative). A failed fetch leaves the cache in place rather
  // than blanking the sidebar.
  useEffect(() => {
    let cancelled = false;

    const cached = safeReadAll(orgId);
    convsRef.current = cached;
    setConversations(cached);
    setCurrentId(safeReadCurrentId(cached));
    persisted.current = new Set();

    void (async () => {
      const identity = await chatIdentity();
      if (cancelled) return;
      identityRef.current = identity;
      if (!identity || identity.orgId !== orgId) return;

      // One-time lift of the pre-workspace history into this workspace.
      // Tombstoned ids are skipped — re-importing a deleted conversation
      // would recreate its server rows.
      const legacy = readLegacyConversations().filter(
        (c) => !(c.id in readTombstones(orgId)),
      );
      if (legacy.length > 0) {
        const imported = await importLocalConversations(identity, legacy);
        if (imported > 0) markLegacyImported();
      }

      const fetched = await fetchConversations(identity.orgId);
      if (cancelled || fetched === null) return;
      // Never resurrect a deleted conversation: drop tombstoned ids from
      // the fetch result and retry their server-side delete (covers a
      // delete that raced this fetch or failed offline in a past session).
      const tombstones = readTombstones(orgId);
      const remote = fetched.filter((c) => !(c.id in tombstones));
      for (const c of fetched) {
        if (c.id in tombstones) {
          void deleteThread(c.id).then((ok) => {
            if (ok) clearTombstone(orgId, c.id);
          });
        }
      }
      for (const c of remote) persisted.current.add(c.id);
      // Preserve local-only BLANK conversations (never persisted by
      // design — the thread row is written on the first message). A
      // "New chat" created while this fetch was in flight — e.g. the
      // Ask CFO AI button navigating here and immediately calling
      // newChat() — must survive the remote adoption; replacing the
      // list wholesale silently wiped it and dumped the user back into
      // their latest existing conversation.
      const localBlanks = convsRef.current.filter(
        (c) => c.messages.length === 0 && !remote.some((r) => r.id === c.id),
      );
      const merged = [...localBlanks, ...remote];
      convsRef.current = merged;
      setConversations(merged);
      safeWriteAll(orgId, merged);
      setCurrentId((prev) => (prev && merged.some((c) => c.id === prev) ? prev : merged[0]?.id ?? null));
    })();

    return () => { cancelled = true; };
  }, [orgId]);

  // Remember which conversation is open so a tab switch (chat unmounts)
  // returns to the same one.
  useEffect(() => {
    safeWriteCurrentId(currentId);
  }, [currentId]);

  // Sync across tabs.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== cacheKey(orgId)) return;
      const next = safeReadAll(orgId);
      convsRef.current = next;
      setConversations(next);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [orgId]);

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
      const existingEmpty = convsRef.current.find((c) => c.messages.length === 0);
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
      organizationId: ctx?.organizationId ?? orgId,
      periodId: ctx?.periodId ?? null,
      periodLabel: ctx?.periodLabel ?? null,
      messages: [],
    };
    // Not persisted here — the thread row is written on the first message.
    applyConversations([conv, ...convsRef.current]);
    setCurrentId(id);
    return id;
  }, [applyConversations, orgId]);

  const select: ChatStore["select"] = useCallback((id) => setCurrentId(id), []);

  const rename: ChatStore["rename"] = useCallback((id, title) => {
    const clean = title.trim() || "Untitled conversation";
    applyConversations(
      convsRef.current.map((c) => (c.id === id ? { ...c, title: clean, updatedAt: Date.now() } : c)),
    );
    if (persisted.current.has(id)) void updateThread(id, { title: clean, touch: true });
  }, [applyConversations]);

  const remove: ChatStore["remove"] = useCallback((id) => {
    const next = convsRef.current.filter((c) => c.id !== id);
    applyConversations(next);
    setCurrentId((prev) => (prev === id ? (next.length > 0 ? next[0].id : null) : prev));
    clearDraft(id); // drop the unsent composer draft along with the chat
    abortChatReply(id); // cancel an in-flight reply — stop "thinking" now
    // Tombstone + UNCONDITIONAL server delete. `persisted` only knows about
    // threads this mount has seen (remote fetch or own sends) — gating the
    // delete on it let server rows survive and resurface on the next entry.
    // Deleting a row that doesn't exist is a harmless no-op; the tombstone
    // is cleared only once the delete confirms, so a failed request gets
    // retried by the next hydration.
    addTombstone(orgId, id);
    persisted.current.delete(id);
    void deleteThread(id).then((ok) => {
      if (ok) clearTombstone(orgId, id);
    });
  }, [applyConversations, orgId]);

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

    const existing = currentId
      ? convsRef.current.find((c) => c.id === currentId) ?? null
      : null;

    const target: ChatConversation = existing
      ? {
          ...existing,
          // First user message → seed the title. Subsequent messages keep
          // whatever title was set (auto or user-renamed).
          title: existing.messages.length === 0 ? deriveTitle(input.content) : existing.title,
          updatedAt: now,
          organizationId: existing.organizationId ?? input.organizationId ?? orgId,
          periodId: existing.periodId ?? input.periodId ?? null,
          periodLabel: existing.periodLabel ?? input.periodLabel ?? null,
          messages: [...existing.messages, userMsg, assistantMsg],
        }
      : {
          // Auto-create on first message.
          id: newId(),
          title: deriveTitle(input.content),
          createdAt: now,
          updatedAt: now,
          organizationId: input.organizationId ?? orgId,
          periodId: input.periodId ?? null,
          periodLabel: input.periodLabel ?? null,
          messages: [userMsg, assistantMsg],
        };

    applyConversations([target, ...convsRef.current.filter((c) => c.id !== target.id)]);
    if (!existing) setCurrentId(target.id);

    // Persist: create the thread on its first message, then the user turn.
    // The assistant placeholder is deliberately NOT written — it has no
    // content yet and completeAssistantTurn writes the real one.
    const wasPersisted = persisted.current.has(target.id);
    void (async () => {
      const ok = await ensureThread(target);
      if (!ok) return;
      // The title is derived from the first message, which only exists now.
      if (wasPersisted && existing && existing.messages.length === 0) {
        await updateThread(target.id, { title: target.title });
      }
      await insertMessage(target.id, userMsg);
    })();

    return { conversationId: target.id, assistantId: assistantMsg.id };
  }, [applyConversations, currentId, orgId, ensureThread]);

  const completeAssistantTurn: ChatStore["completeAssistantTurn"] = useCallback((params) => {
    let finished: ChatMessage | null = null;
    const next = convsRef.current.map((c) => {
      if (c.id !== params.conversationId) return c;
      return {
        ...c,
        updatedAt: Date.now(),
        messages: c.messages.map((m) => {
          if (m.id !== params.assistantId) return m;
          const done: ChatMessage = {
            ...m,
            content: params.content,
            groundedPeriod: params.groundedPeriod ?? m.groundedPeriod ?? null,
            pending: false,
          };
          finished = done;
          return done;
        }),
      };
    });
    applyConversations(next);

    // An errored turn stays in the UI (so the user sees what happened) but is
    // not written to history — a reopened conversation shouldn't replay it.
    const conv = next.find((c) => c.id === params.conversationId);
    if (finished && !params.error && conv) {
      const msg = finished as ChatMessage;
      void (async () => {
        // Awaits the thread INSERT if it's still in flight, so a fast reply
        // can't outrun its own conversation row.
        const ok = await ensureThread(conv);
        if (!ok) return;
        await insertMessage(params.conversationId, msg);
        await updateThread(params.conversationId, { touch: true });
      })();
    }
  }, [applyConversations, ensureThread]);

  const rollbackLastPair: ChatStore["rollbackLastPair"] = useCallback((conversationId) => {
    let restoredUserContent: string | null = null;
    const dropped: string[] = [];
    const next = convsRef.current.map((c) => {
      if (c.id !== conversationId) return c;
      // Drop trailing assistant + user pair.
      const ms = [...c.messages];
      const last = ms[ms.length - 1];
      if (last && last.role === "assistant") { dropped.push(last.id); ms.pop(); }
      const userLast = ms[ms.length - 1];
      if (userLast && userLast.role === "user") {
        restoredUserContent = userLast.content;
        dropped.push(userLast.id);
        ms.pop();
      }
      return { ...c, messages: ms, updatedAt: Date.now() };
    });
    applyConversations(next);
    if (dropped.length > 0 && persisted.current.has(conversationId)) {
      void deleteMessages(dropped);
    }
    return restoredUserContent;
  }, [applyConversations]);

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
