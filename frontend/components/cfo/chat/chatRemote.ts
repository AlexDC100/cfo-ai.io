// chatRemote.ts — Supabase persistence for Ask CFO AI conversations.
//
// Backs `useChatStore` with the `chat_threads` / `chat_messages` tables
// (supabase/schema_phase_chat.sql). Those tables are shared with the engine's
// /api/ask endpoint, which has always written to them — the column names here
// mirror ask.py exactly (`active_period_id`, `thread_id`, `tokens_*`).
//
// Conversations are scoped to the active WORKSPACE and to the signed-in user;
// RLS enforces both, so these queries never filter by user_id themselves.
//
// Every function is fail-soft: it returns null / false rather than throwing
// when Supabase is off, nobody is signed in, or the migration hasn't been
// applied. The store stays localStorage-first so chat keeps working regardless.

import { getSupabase, currentOrgId } from "@/lib/supabase";
import type { ChatAttachment, ChatConversation, ChatMessage } from "./types";

interface ThreadRow {
  id: string;
  org_id: string;
  title: string;
  active_period_id: string | null;
  active_period_label: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  grounded_period: string | null;
  attachments: ChatAttachment[] | null;
  created_at: string;
}

const THREAD_COLUMNS =
  "id,org_id,title,active_period_id,active_period_label,created_at,updated_at";
const MESSAGE_COLUMNS =
  "id,thread_id,role,content,grounded_period,attachments,created_at";

function warn(op: string, message: string): void {
  console.warn(`[chat] ${op} failed — staying local-only: ${message}`);
}

function ms(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

/** The signed-in user + active workspace, or null when we shouldn't sync. */
export async function chatIdentity(): Promise<{ userId: string; orgId: string } | null> {
  const client = getSupabase();
  if (!client) return null;
  const { data } = await client.auth.getSession();
  const userId = data.session?.user?.id;
  if (!userId) return null;
  const orgId = await currentOrgId();
  if (!orgId) return null;
  return { userId, orgId };
}

/**
 * Every conversation in this workspace, newest first, with its messages.
 * Returns null when the read fails so the caller can keep the local cache
 * instead of blanking the sidebar.
 */
export async function fetchConversations(orgId: string): Promise<ChatConversation[] | null> {
  const client = getSupabase();
  if (!client) return null;

  const { data: threads, error: tErr } = await client
    .from("chat_threads")
    .select(THREAD_COLUMNS)
    .eq("org_id", orgId)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (tErr) {
    warn("fetchConversations", tErr.message);
    return null;
  }
  const rows = (threads ?? []) as ThreadRow[];
  if (rows.length === 0) return [];

  // One round-trip for every message in the workspace rather than N+1.
  const { data: messages, error: mErr } = await client
    .from("chat_messages")
    .select(MESSAGE_COLUMNS)
    .in("thread_id", rows.map((t) => t.id))
    .order("created_at", { ascending: true });
  if (mErr) {
    warn("fetchConversations(messages)", mErr.message);
    return null;
  }

  const byThread = new Map<string, ChatMessage[]>();
  for (const m of (messages ?? []) as MessageRow[]) {
    const list = byThread.get(m.thread_id) ?? [];
    list.push({
      id: m.id,
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content ?? "",
      createdAt: ms(m.created_at),
      groundedPeriod: m.grounded_period,
      attachments: m.attachments ?? undefined,
      pending: false,
    });
    byThread.set(m.thread_id, list);
  }

  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    createdAt: ms(t.created_at),
    updatedAt: ms(t.updated_at),
    organizationId: t.org_id,
    periodId: t.active_period_id,
    periodLabel: t.active_period_label,
    messages: byThread.get(t.id) ?? [],
  }));
}

/**
 * Create the thread row. Called lazily on the FIRST message rather than when
 * the user clicks "New chat" — an empty placeholder conversation isn't worth a
 * row, and persisting it would litter the sidebar on every other device.
 */
export async function insertThread(
  identity: { userId: string; orgId: string },
  conv: Pick<ChatConversation, "id" | "title" | "periodId" | "periodLabel" | "createdAt">,
): Promise<boolean> {
  const client = getSupabase();
  if (!client) return false;
  const { error } = await client.from("chat_threads").insert({
    id: conv.id,
    org_id: identity.orgId,
    user_id: identity.userId,
    title: conv.title,
    active_period_id: conv.periodId ?? null,
    active_period_label: conv.periodLabel ?? null,
    created_at: new Date(conv.createdAt).toISOString(),
  });
  if (error) {
    warn("insertThread", error.message);
    return false;
  }
  return true;
}

export async function updateThread(
  threadId: string,
  patch: { title?: string; periodId?: string | null; periodLabel?: string | null; touch?: boolean },
): Promise<boolean> {
  const client = getSupabase();
  if (!client) return false;
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.periodId !== undefined) row.active_period_id = patch.periodId;
  if (patch.periodLabel !== undefined) row.active_period_label = patch.periodLabel;
  if (patch.touch) row.updated_at = new Date().toISOString();
  if (Object.keys(row).length === 0) return true;

  const { error } = await client.from("chat_threads").update(row).eq("id", threadId);
  if (error) {
    warn("updateThread", error.message);
    return false;
  }
  return true;
}

export async function deleteThread(threadId: string): Promise<boolean> {
  const client = getSupabase();
  if (!client) return false;
  const { error } = await client.from("chat_threads").delete().eq("id", threadId);
  if (error) {
    warn("deleteThread", error.message);
    return false;
  }
  return true;
}

/** Persist one turn. `pending` placeholders are never written. */
export async function insertMessage(threadId: string, msg: ChatMessage): Promise<boolean> {
  const client = getSupabase();
  if (!client) return false;
  const { error } = await client.from("chat_messages").insert({
    id: msg.id,
    thread_id: threadId,
    role: msg.role,
    content: msg.content,
    grounded_period: msg.groundedPeriod ?? null,
    attachments: msg.attachments ?? null,
    created_at: new Date(msg.createdAt).toISOString(),
  });
  if (error) {
    warn("insertMessage", error.message);
    return false;
  }
  return true;
}

export async function deleteMessages(ids: string[]): Promise<boolean> {
  const client = getSupabase();
  if (!client || ids.length === 0) return false;
  const { error } = await client.from("chat_messages").delete().in("id", ids);
  if (error) {
    warn("deleteMessages", error.message);
    return false;
  }
  return true;
}

/**
 * One-time upload of conversations that only ever existed in this browser.
 * Ids are client-generated UUIDs and are reused as primary keys, so a repeat
 * run collides on the PK and is skipped rather than duplicating history.
 */
export async function importLocalConversations(
  identity: { userId: string; orgId: string },
  conversations: ChatConversation[],
): Promise<number> {
  let imported = 0;
  for (const conv of conversations) {
    if (conv.messages.length === 0) continue; // nothing worth keeping
    const ok = await insertThread(identity, conv);
    if (!ok) continue;
    for (const m of conv.messages) {
      if (m.pending || !m.content) continue;
      await insertMessage(conv.id, m);
    }
    await updateThread(conv.id, { touch: false });
    imported += 1;
  }
  return imported;
}
