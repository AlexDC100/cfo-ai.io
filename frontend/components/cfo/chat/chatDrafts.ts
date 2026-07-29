// chatDrafts.ts — device-local per-conversation composer drafts.
//
// Remembers what the user had typed in the message input for EACH
// conversation, so switching between chats in the history sidebar (or
// reloading the page) restores the unsent text where they left it.
// Deliberately localStorage-only, NOT synced to Supabase prefs: a
// half-typed message describes this screen, not the user or the company
// (same reasoning as the other device-local UI state — see root
// CLAUDE.md §16 Milestone C "Deliberately NOT synced").
//
// Keys are conversation ids (client-generated UUIDs, stable across
// devices' persistence layer) plus the "new" sentinel for the
// not-yet-created conversation. Drafts are removed when the text is
// cleared or the message is sent, so the bag only holds live drafts.

const STORAGE_KEY = "cfo-ai-chat-drafts-v1";
// Safety cap — a runaway bag (e.g. many abandoned drafts) gets pruned
// oldest-first rather than growing without bound.
const MAX_DRAFTS = 50;

interface DraftEntry {
  text: string;
  updatedAt: number;
}

function readAll(): Record<string, DraftEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, DraftEntry>;
  } catch {
    return {};
  }
}

function persist(all: Record<string, DraftEntry>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota / private mode — drafts degrade to in-memory only */
  }
}

export function readDraft(key: string): string {
  return readAll()[key]?.text ?? "";
}

export function writeDraft(key: string, text: string): void {
  const all = readAll();
  if (text) {
    all[key] = { text, updatedAt: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > MAX_DRAFTS) {
      keys
        .sort((a, b) => (all[a]?.updatedAt ?? 0) - (all[b]?.updatedAt ?? 0))
        .slice(0, keys.length - MAX_DRAFTS)
        .forEach((k) => delete all[k]);
    }
  } else {
    if (!(key in all)) return; // nothing to clear — skip the write
    delete all[key];
  }
  persist(all);
}

/** Drop a conversation's draft outright (e.g. when it's deleted). */
export function clearDraft(key: string): void {
  writeDraft(key, "");
}
