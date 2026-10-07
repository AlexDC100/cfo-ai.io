// The upload portal's CLOUD route — for a phone on any connection.
//
// Ported from DocVex's lib/phoneUploadCloud. The phone opens
// <site>/phone-upload.html#m=cloud&t=<token>&k=<key>&…, seals each file with
// the key in the fragment and sends it to a private bucket through the
// `phone-upload` Edge Function (supabase/schema_phase_phone_upload.sql). This
// side — the signed-in PC — hears each file arrive (Realtime, with a slow
// poll behind it), downloads it, OPENS it (every tag checked) and offers it
// to the upload section. On the user's decision the object is deleted (the
// bucket is a hand-off, not a store) and the decision written on the row,
// which the phone reads back.
//
// The address is KEPT per account and upload section (localStorage), so the
// QR code is the same every time and a phone can keep its page open; "New
// address" throws it away (new token AND new key).

import { getSupabase } from "@/lib/supabase";
import { SITE } from "@/config/site";
import { isSealKey, looksSealed, newSealKey, unseal, SEALED_MIME } from "./seal";
import type { ArrivalSink, PortalAddress, PortalError, PortalSurface } from "./types";

const BUCKET = "phone-upload";
const POLL_MS = 5000;

const keptKey = (uid: string, surface: string) => `cfo:phone-upload:cloud:v1:${uid || "_"}:${surface}`;
interface Kept {
  token: string;
  sessionId: string;
  key: string;
}
function loadKept(uid: string, surface: string): Kept | null {
  try {
    const v = JSON.parse(localStorage.getItem(keptKey(uid, surface)) || "null") as Kept | null;
    return v && v.token && v.sessionId && isSealKey(v.key) ? v : null;
  } catch {
    return null;
  }
}
function saveKept(uid: string, surface: string, v: Kept | null) {
  try {
    if (v) localStorage.setItem(keptKey(uid, surface), JSON.stringify(v));
    else localStorage.removeItem(keptKey(uid, surface));
  } catch {
    /* storage refused — the address just won't be kept */
  }
}

/**
 * Where the phone page lives. A PC on localhost can't hand a phone
 * "localhost", so a dev build points at the public site's copy.
 */
export function portalPageOrigin(): string {
  const here = typeof window !== "undefined" ? window.location.origin : "";
  if (!here || /\/\/(localhost|127\.|\[::1\])/.test(here)) return SITE.url.replace(/\/$/, "");
  return here;
}

export interface CloudPortal extends PortalAddress {
  token: string;
  sessionId: string;
  key: string;
}

export interface StartOptions {
  surface: PortalSurface;
  orgId?: string | null;
  fresh?: boolean;
  /** The upload section's `accept` (narrows the phone's picker). */
  accept?: string;
  /** The section takes a single file. */
  single?: boolean;
}

export async function startCloudPortal(opts: StartOptions): Promise<CloudPortal | PortalError> {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "not_configured" };
  const { data: sess } = await sb.auth.getSession();
  const uid = sess.session?.user?.id;
  if (!uid) return { ok: false, error: "not_signed_in" };

  const kept = loadKept(uid, opts.surface);
  if (opts.fresh && kept) {
    await stopCloudPortal(kept.sessionId);
    saveKept(uid, opts.surface, null);
  }
  const reuse = opts.fresh ? null : kept;
  try {
    const { data, error } = await sb.functions.invoke("phone-upload", {
      body: { action: "create", orgId: opts.orgId || null, surface: opts.surface, token: reuse?.token },
    });
    if (error) {
      const status = (error as { context?: { status?: number } }).context?.status;
      return { ok: false, error: status === 404 ? "not_deployed" : status === 401 ? "not_signed_in" : "unreachable" };
    }
    if (!data?.ok) return { ok: false, error: String(data?.error || "failed") };
    // The same session keeps its key; a new one gets a new key.
    const same = reuse && reuse.sessionId === data.sessionId && reuse.token === data.token;
    const key = same ? reuse.key : newSealKey();
    saveKept(uid, opts.surface, { token: data.token, sessionId: data.sessionId, key });

    const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
    const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? "";
    const frag = new URLSearchParams({ m: "cloud", t: data.token, k: key, f: `${base}/functions/v1/phone-upload`, s: opts.surface });
    if (anon) frag.set("a", anon);
    if (opts.accept) frag.set("acc", opts.accept);
    if (opts.single) frag.set("one", "1");
    return {
      ok: true,
      token: data.token,
      sessionId: data.sessionId,
      key,
      expiresAt: data.expiresAt ? Date.parse(data.expiresAt) : null,
      url: `${portalPageOrigin()}/phone-upload.html#${frag.toString()}`,
    };
  } catch {
    return { ok: false, error: "unreachable" };
  }
}

/** Pause a portal (the window closed) — reopened by the next start. */
export async function stopCloudPortal(sessionId: string): Promise<void> {
  const sb = getSupabase();
  if (!sb || !sessionId) return;
  try {
    await sb.functions.invoke("phone-upload", { body: { action: "close", sessionId } });
  } catch {
    /* it lapses anyway */
  }
}

/**
 * The PC's decision about a file. Only now does the object leave the bucket
 * (until then, a window closed by accident shows the file again next time);
 * the row stays — it carries the decision back to the phone.
 */
export async function decideCloud(rowId: string, status: "accepted" | "rejected"): Promise<void> {
  const sb = getSupabase();
  if (!sb || !rowId) return;
  try {
    const { data } = await sb.from("phone_upload_files").select("path").eq("id", rowId).maybeSingle();
    if (data?.path) await sb.storage.from(BUCKET).remove([data.path as string]);
    const now = new Date().toISOString();
    await sb.from("phone_upload_files").update({ status, taken_at: now, decided_at: now }).eq("id", rowId);
  } catch {
    /* the phone just doesn't learn it; the sweep removes the object */
  }
}

interface FileRow {
  id: string;
  path: string;
  name: string;
  size: number;
  mime: string | null;
}

/** Take every file of a portal as it arrives. Returns a stop function. */
export function watchCloudPortal(portal: Pick<CloudPortal, "sessionId" | "token" | "key">, sink: ArrivalSink): () => void {
  const sb = getSupabase();
  if (!sb) return () => {};
  let stopped = false;
  const handled = new Set<string>();
  let busy: Promise<void> = Promise.resolve();

  const refuse = async (row: FileRow) => {
    try {
      await sb.storage.from(BUCKET).remove([row.path]);
    } catch {
      /* the sweep takes it */
    }
    const now = new Date().toISOString();
    await sb.from("phone_upload_files").update({ taken_at: now, status: "rejected", decided_at: now }).eq("id", row.id);
  };

  const take = (row: FileRow) => {
    if (!row?.id || handled.has(row.id) || stopped) return;
    handled.add(row.id);
    const key = `cloud:${row.id}`;
    busy = busy.then(async () => {
      if (stopped) return;
      sink({ key, route: "cloud", id: row.id, name: "Encrypted file", size: row.size, state: "taking" });
      try {
        const { data: blob, error } = await sb.storage.from(BUCKET).download(row.path);
        if (error || !blob) throw new Error("download_failed");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (row.mime !== SEALED_MIME || !looksSealed(bytes)) {
          await refuse(row);
          sink({ key, route: "cloud", id: row.id, name: "File", size: row.size, state: "error", error: "not_encrypted" });
          return;
        }
        let opened;
        try {
          opened = await unseal(bytes, portal.key, portal.token);
        } catch {
          await refuse(row);
          sink({ key, route: "cloud", id: row.id, name: "Encrypted file", size: row.size, state: "error", error: "not_decrypted" });
          return;
        }
        // It stays in the bucket until the user decides (decideCloud).
        const file = new File([opened.data], opened.name, { type: opened.type || "application/octet-stream" });
        sink({ key, route: "cloud", id: row.id, name: opened.name, size: file.size, state: "waiting", file });
      } catch (e) {
        handled.delete(row.id); // the next poll tries again
        sink({ key, route: "cloud", id: row.id, name: "Encrypted file", size: row.size, state: "error", error: (e as Error)?.message || "failed" });
      }
    });
  };

  const channel = sb
    .channel(`phone-upload:${portal.sessionId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "phone_upload_files", filter: `session_id=eq.${portal.sessionId}` },
      (p) => take(p.new as FileRow),
    )
    .subscribe();

  const poll = async () => {
    if (stopped) return;
    const { data } = await sb
      .from("phone_upload_files")
      .select("id,path,name,size,mime")
      .eq("session_id", portal.sessionId)
      .is("taken_at", null)
      .order("created_at");
    for (const row of (data as FileRow[] | null) || []) take(row);
  };
  const timer = setInterval(() => void poll(), POLL_MS);
  void poll();

  return () => {
    stopped = true;
    clearInterval(timer);
    void sb.removeChannel(channel);
  };
}
