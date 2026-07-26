// useChatStore — Supabase-backed conversation store for CFO AI chat.
//
// ARCHITECTURE (2026-07-26 redesign): all chat state lives at MODULE level,
// not in component state. The chat shell unmounts on every tab switch, and
// the send pipeline keeps running in the background (see chatTurns.ts) — so
// the store must outlive any mount. Components read it through
// `useSyncExternalStore`; every mutation is a plain module function that
// updates the module state and notifies subscribers. Consequences:
//   · A reply that finishes while the user is on another tab lands in the
//     store immediately; returning to /chat shows it with no re-mount dance.
//   · The "…" thinking placeholder survives tab switches — it's a pending
//     message IN the store, not ephemeral component state.
//   · The page shell and the slide-over panel share one state, always.
//
// Conversations live in `chat_threads` / `chat_messages` (see
// supabase/schema_phase_chat.sql) and are scoped to the ACTIVE WORKSPACE:
// switching to another company shows that company's chats, because a
// conversation's answers are grounded in one company's numbers and would be
// misleading anywhere else. RLS also scopes them to the signed-in user.
//
// localStorage remains as a per-workspace CACHE so the sidebar paints
// instantly and the chat keeps working signed-out / offline / before the
// migration is applied. The store is optimistic: every mutation updates the
// module state immediately and persists in the background — the UI never
// waits on the network mid-conversation.
//
// Threads are written LAZILY, on the first real message. Clicking "New chat"
// creates nothing server-side; an empty placeholder isn't worth a row and
// would litter the sidebar on every other device.
//
// Ids are client-generated UUIDs reused as primary keys, so persistence never
// has to remap them and a repeated import collides on the PK instead of
// duplicating history.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
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
import { abortChatReply, hasChatReplyInFlight } from "@/lib/chatPendingStore";

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
          interrupted: m.interrupted === true ? true : undefined,
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

// ═══════════════════════════════════════════════════════════════════
// MODULE STORE — the single source of truth, keyed by workspace.
// ═══════════════════════════════════════════════════════════════════

interface OrgChatState {
  conversations: ChatConversation[];
  currentId: string | null;
}

const orgStates = new Map<string, OrgChatState>();
const storeListeners = new Set<() => void>();

function stateKey(orgId: string | null): string {
  return orgId ?? "__none__";
}

function emitStore(): void {
  for (const l of storeListeners) l();
}

function subscribeStore(cb: () => void): () => void {
  storeListeners.add(cb);
  return () => { storeListeners.delete(cb); };
}

/** The workspace's state, lazily seeded from the localStorage cache on
 *  first access. The returned object is referentially stable between
 *  mutations, which is what `useSyncExternalStore` requires. */
function getOrgState(orgId: string | null): OrgChatState {
  const k = stateKey(orgId);
  let s = orgStates.get(k);
  if (!s) {
    const conversations = safeReadAll(orgId);
    s = { conversations, currentId: safeReadCurrentId(conversations) };
    orgStates.set(k, s);
  }
  return s;
}

function patchOrgState(orgId: string | null, patch: Partial<OrgChatState>): void {
  orgStates.set(stateKey(orgId), { ...getOrgState(orgId), ...patch });
  emitStore();
}

/** Drop a workspace's in-memory state so the next read re-seeds from the
 *  cache. For cache-clearing flows (sign-out, workspace purge). */
export function resetChatLiveState(orgId: string | null): void {
  orgStates.delete(stateKey(orgId));
  emitStore();
}

// ── Server-persistence bookkeeping (module-level: survives unmounts) ─
// Threads known to exist server-side, so appendUserTurn knows whether to
// INSERT the thread or just append to it. Thread ids are UUIDs, so one
// global set is safe across workspaces.
const persistedThreads = new Set<string>();
let identityCache: { userId: string; orgId: string } | null = null;
// In-flight thread inserts, keyed by conversation id.
//
// The assistant turn can complete before its thread row lands (a cached or
// errored reply returns in milliseconds, the INSERT takes a round-trip).
// Without this, completeAssistantTurn would find the thread "not persisted
// yet" and silently drop the answer from history. Everything that writes a
// message awaits this promise first.
const threadInserts = new Map<string, Promise<boolean>>();

async function ensureThread(conv: ChatConversation): Promise<boolean> {
  if (persistedThreads.has(conv.id)) return true;
  const inflight = threadInserts.get(conv.id);
  if (inflight) return inflight;

  const promise = (async () => {
    const identity = identityCache ?? (await chatIdentity());
    identityCache = identity;
    if (!identity) return false;
    // A conversation restored from the pre-workspace cache has no
    // organizationId; it belongs to whichever workspace is open now. Only
    // refuse when it explicitly names a DIFFERENT one, which means the user
    // switched workspaces while a reply was in flight.
    if (conv.organizationId && conv.organizationId !== identity.orgId) return false;
    const ok = await insertThread(identity, conv);
    if (ok) persistedThreads.add(conv.id);
    return ok;
  })();
  threadInserts.set(conv.id, promise);
  void promise.finally(() => threadInserts.delete(conv.id));
  return promise;
}

function applyConversations(orgId: string | null, next: ChatConversation[]): void {
  patchOrgState(orgId, { conversations: next });
  safeWriteAll(orgId, next);
}

function setCurrent(orgId: string | null, id: string | null): void {
  patchOrgState(orgId, { currentId: id });
  safeWriteCurrentId(id);
}

/** Read one conversation synchronously — used by the background send
 *  pipeline (chatTurns.ts) to build the request payload. */
export function getChatConversation(orgId: string | null, id: string): ChatConversation | null {
  return getOrgState(orgId).conversations.find((c) => c.id === id) ?? null;
}

// ── Module mutations ───────────────────────────────────────────────
// Exported so the background send controller (chatTurns.ts) can mutate the
// store without any component being mounted.

export function chatCreateNew(
  orgId: string | null,
  ctx?: { organizationId?: string | null; periodId?: string | null; periodLabel?: string | null },
): string {
  // Don't spawn a duplicate blank chat — if an empty conversation already
  // exists, just focus it (matches ChatGPT/Claude: "New chat" is a no-op
  // when you're already sitting on a fresh, unused conversation).
  //
  // DEV-ONLY escape hatch: on localhost (`import.meta.env.DEV`) we skip this
  // guard so you can spin up multiple empty chats while testing. The check is
  // compiled out of production builds, so a deploy always keeps the guard.
  if (!import.meta.env.DEV) {
    const existingEmpty = getOrgState(orgId).conversations.find((c) => c.messages.length === 0);
    if (existingEmpty) {
      setCurrent(orgId, existingEmpty.id);
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
  applyConversations(orgId, [conv, ...getOrgState(orgId).conversations]);
  setCurrent(orgId, id);
  return id;
}

export function chatSelect(orgId: string | null, id: string): void {
  setCurrent(orgId, id);
}

export function chatRename(orgId: string | null, id: string, title: string): void {
  const clean = title.trim() || "Untitled conversation";
  applyConversations(
    orgId,
    getOrgState(orgId).conversations.map((c) =>
      c.id === id ? { ...c, title: clean, updatedAt: Date.now() } : c,
    ),
  );
  if (persistedThreads.has(id)) void updateThread(id, { title: clean, touch: true });
}

export function chatRemove(orgId: string | null, id: string): void {
  const st = getOrgState(orgId);
  const next = st.conversations.filter((c) => c.id !== id);
  const nextCurrent = st.currentId === id ? (next[0]?.id ?? null) : st.currentId;
  patchOrgState(orgId, { conversations: next, currentId: nextCurrent });
  safeWriteAll(orgId, next);
  safeWriteCurrentId(nextCurrent);
  clearDraft(id); // drop the unsent composer draft along with the chat
  abortChatReply(id); // cancel an in-flight reply — stop "thinking" now
  // Tombstone + UNCONDITIONAL server delete. `persistedThreads` only knows
  // about threads this session has seen (remote fetch or own sends) — gating
  // the delete on it let server rows survive and resurface on the next entry.
  // Deleting a row that doesn't exist is a harmless no-op; the tombstone
  // is cleared only once the delete confirms, so a failed request gets
  // retried by the next hydration.
  addTombstone(orgId, id);
  persistedThreads.delete(id);
  void deleteThread(id).then((ok) => {
    if (ok) clearTombstone(orgId, id);
  });
}

export interface AppendUserTurnInput {
  content: string;
  attachments?: ChatMessage["attachments"];
  organizationId?: string | null;
  periodId?: string | null;
  periodLabel?: string | null;
}

export function chatAppendUserTurn(
  orgId: string | null,
  input: AppendUserTurnInput,
): { conversationId: string; assistantId: string } {
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

  const st = getOrgState(orgId);
  const existing = st.currentId
    ? st.conversations.find((c) => c.id === st.currentId) ?? null
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

  applyConversations(orgId, [target, ...st.conversations.filter((c) => c.id !== target.id)]);
  if (!existing) setCurrent(orgId, target.id);

  // Persist: create the thread on its first message, then the user turn.
  // The assistant placeholder is deliberately NOT written — it has no
  // content yet and completeAssistantTurn writes the real one.
  const wasPersisted = persistedThreads.has(target.id);
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
}

export interface CompleteAssistantTurnInput {
  conversationId: string;
  assistantId: string;
  content: string;
  groundedPeriod?: string | null;
  error?: boolean;
  /** The user pressed Stop — renders as the muted "Interrupted" marker. */
  interrupted?: boolean;
}

export function chatCompleteAssistantTurn(
  orgId: string | null,
  params: CompleteAssistantTurnInput,
): void {
  let finished: ChatMessage | null = null;
  const next = getOrgState(orgId).conversations.map((c) => {
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
          interrupted: params.interrupted === true ? true : undefined,
        };
        finished = done;
        return done;
      }),
    };
  });
  applyConversations(orgId, next);

  // An errored/interrupted turn stays in the UI (so the user sees what
  // happened) but is not written to server history — a reopened conversation
  // on another device shouldn't replay it.
  const conv = next.find((c) => c.id === params.conversationId);
  if (finished && !params.error && !params.interrupted && conv) {
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
}

export function chatRollbackLastPair(orgId: string | null, conversationId: string): string | null {
  let restoredUserContent: string | null = null;
  const dropped: string[] = [];
  const next = getOrgState(orgId).conversations.map((c) => {
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
  applyConversations(orgId, next);
  if (dropped.length > 0 && persistedThreads.has(conversationId)) {
    void deleteMessages(dropped);
  }
  return restoredUserContent;
}

// ── Hydration ──────────────────────────────────────────────────────
// Cache paints first (synchronously, via getOrgState); this pulls the
// authoritative server copy. A failed fetch leaves the cache in place
// rather than blanking the sidebar.
//
// SAFE MERGE RULE: a conversation with a reply currently generating (or a
// local-only blank) keeps its LOCAL version. The server copy of an active
// conversation has the user turn but NOT the pending assistant placeholder —
// adopting it wholesale would delete the very message id the in-flight
// completion is about to write into, silently discarding the answer. That
// was the root cause of the "reply only appears after another tab switch"
// family of bugs.
const hydratingOrgs = new Set<string>();

async function hydrateOrg(orgId: string | null): Promise<void> {
  const k = stateKey(orgId);
  if (hydratingOrgs.has(k)) return;
  hydratingOrgs.add(k);
  try {
    const identity = await chatIdentity();
    identityCache = identity;
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
    if (fetched === null) return;
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
    for (const c of remote) persistedThreads.add(c.id);

    const st = getOrgState(orgId);
    // Keep the local version of: blanks (never persisted by design) and any
    // conversation with a turn in flight (see SAFE MERGE RULE above).
    const keepLocal = st.conversations.filter(
      (c) => c.messages.length === 0 || hasChatReplyInFlight(c.id),
    );
    const merged = [
      ...keepLocal,
      ...remote.filter((r) => !keepLocal.some((l) => l.id === r.id)),
    ];
    const nextCurrent =
      st.currentId && merged.some((c) => c.id === st.currentId)
        ? st.currentId
        : merged[0]?.id ?? null;
    patchOrgState(orgId, { conversations: merged, currentId: nextCurrent });
    safeWriteAll(orgId, merged);
    safeWriteCurrentId(nextCurrent);
  } finally {
    hydratingOrgs.delete(k);
  }
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
  appendUserTurn: (input: AppendUserTurnInput) => { conversationId: string; assistantId: string };
  /** Fulfil the pending assistant turn with real content (or an error). */
  completeAssistantTurn: (params: CompleteAssistantTurnInput) => void;
  /** Roll back the last pair (user + pending assistant) — used when the
   *  API call throws so the input box re-populates and history isn't
   *  polluted with orphaned messages. */
  rollbackLastPair: (conversationId: string) => string | null;
}

export function useChatStore(): ChatStore {
  const { org } = useActiveOrg();
  const orgId = org?.id ?? null;

  const getSnapshot = useCallback(() => getOrgState(orgId), [orgId]);
  const state = useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);

  // Pull the authoritative server copy on mount / workspace switch.
  useEffect(() => {
    void hydrateOrg(orgId);
  }, [orgId]);

  // Sync across BROWSER tabs (in-app tab switches never unmount the module
  // store, so this is strictly for a second window on the same profile).
  // Skipped while a reply is generating here — adopting another window's
  // snapshot would strip this window's pending placeholder.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== cacheKey(orgId)) return;
      const st = getOrgState(orgId);
      if (st.conversations.some((c) => hasChatReplyInFlight(c.id))) return;
      patchOrgState(orgId, { conversations: safeReadAll(orgId) });
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [orgId]);

  const current = useMemo(
    () => state.conversations.find((c) => c.id === state.currentId) ?? null,
    [state],
  );

  return useMemo(
    () => ({
      conversations: state.conversations,
      currentId: state.currentId,
      current,
      createNew: (ctx) => chatCreateNew(orgId, ctx),
      select: (id) => chatSelect(orgId, id),
      rename: (id, title) => chatRename(orgId, id, title),
      remove: (id) => chatRemove(orgId, id),
      appendUserTurn: (input) => chatAppendUserTurn(orgId, input),
      completeAssistantTurn: (params) => chatCompleteAssistantTurn(orgId, params),
      rollbackLastPair: (conversationId) => chatRollbackLastPair(orgId, conversationId),
    }),
    [state, current, orgId],
  );
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
