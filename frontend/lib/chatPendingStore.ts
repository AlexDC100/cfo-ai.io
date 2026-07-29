// chatPendingStore.ts — global "an Ask CFO AI reply is in flight" signal.
//
// 2026-07-24: the chat send pipeline lives inside CFOChatShell, so once
// the user navigates to another tab the only place that knew a reply was
// still being generated unmounted with it. This module-level counter
// survives navigation (the in-flight fetch keeps running in its closure
// and still persists the answer), letting distant surfaces — the nav
// rail's "Ask CFO AI" item — show a thinking spinner.
//
// Counter, not boolean: the page shell and the slide-over panel could
// each have a send in flight.

import { useSyncExternalStore } from "react";

let count = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function beginChatReply(): void {
  count += 1;
  emit();
}

export function endChatReply(): void {
  count = Math.max(0, count - 1);
  emit();
}

// ── Per-conversation abort handles (2026-07-25) ─────────────────────
// Deleting a conversation while its reply is still generating should
// stop the "thinking" state immediately. The send pipeline registers an
// abort handle per conversation; useChatStore.remove() fires it. The
// aborted fetch rejects, the pipeline's finally runs endChatReply(),
// and the nav-rail spinner stops.

const aborters = new Map<string, () => void>();

export function registerChatReplyAbort(conversationId: string, abort: () => void): void {
  aborters.set(conversationId, abort);
}

export function unregisterChatReplyAbort(conversationId: string): void {
  aborters.delete(conversationId);
}

/** True while a reply is generating for this conversation. Used by chat
 *  hydration to keep the LOCAL copy of an active conversation — the server
 *  copy doesn't have the pending assistant placeholder the in-flight
 *  completion is about to write into. */
export function hasChatReplyInFlight(conversationId: string): boolean {
  return aborters.has(conversationId);
}

/** Abort the in-flight reply for a conversation (no-op when none). */
export function abortChatReply(conversationId: string): void {
  const abort = aborters.get(conversationId);
  aborters.delete(conversationId);
  try { abort?.(); } catch { /* already settled — ignore */ }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** True while at least one Ask CFO AI reply is being generated. */
export function useChatReplyPending(): boolean {
  return useSyncExternalStore(subscribe, () => count > 0, () => false);
}
