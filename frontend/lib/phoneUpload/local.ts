// The upload portal's LOCAL NETWORK route — the phone talks straight to the
// CFO AI engine running on this computer; nothing leaves the network.
//
// Ported from DocVex's lib/phoneUploadLocal + src/phoneUploadServer.js. The
// server half is src/engine/api/_phone_upload.py: it serves the phone page
// and holds the files until this side takes them. It answers only when the
// engine runs on the user's own machine with PHONE_UPLOAD_LOCAL set — a 404
// `local_disabled` here means "use the cloud route".
//
// The address is KEPT per account and upload section (localStorage) and
// reopened with the same token, so the QR code stays the same while the
// engine runs. Plain http on a LAN address is not a secure context, so the
// phone cannot encrypt here; the files travel over the local network only.

import { getSupabase } from "@/lib/supabase";
import type { ArrivalSink, PortalAddress, PortalError, PortalSurface } from "./types";

const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const BASE = `${API_URL}/api/phone-upload/local`;
const POLL_MS = 2000;

const keptKey = (uid: string, surface: string) => `cfo:phone-upload:local:v1:${uid || "_"}:${surface}`;

async function auth(): Promise<{ uid: string; headers: Record<string, string> } | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  const uid = data.session?.user?.id;
  if (!token || !uid) return null;
  return { uid, headers: { Authorization: `Bearer ${token}` } };
}

export interface LocalPortal extends PortalAddress {
  token: string;
  sessionId: string;
  urls: string[];
  /** The engine runs in Docker and no PHONE_UPLOAD_LAN_URL is set. */
  inContainer: boolean;
}

export function localPageUrl(base: string, token: string, opts: { surface: PortalSurface; accept?: string; single?: boolean }): string {
  const frag = new URLSearchParams({ m: "local", t: token, s: opts.surface });
  if (opts.accept) frag.set("acc", opts.accept);
  if (opts.single) frag.set("one", "1");
  return `${base.replace(/\/$/, "")}/api/phone-upload/local/page#${frag.toString()}`;
}

export async function startLocalPortal(opts: {
  surface: PortalSurface;
  fresh?: boolean;
  accept?: string;
  single?: boolean;
}): Promise<LocalPortal | PortalError> {
  const a = await auth();
  if (!a) return { ok: false, error: "not_signed_in" };
  let kept = "";
  try {
    kept = opts.fresh ? "" : localStorage.getItem(keptKey(a.uid, opts.surface)) || "";
  } catch {
    /* no storage */
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: { ...a.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ surface: opts.surface, token: kept || undefined }),
    });
  } catch {
    return { ok: false, error: "engine_unreachable" };
  }
  if (res.status === 404) return { ok: false, error: "local_disabled" };
  if (res.status === 401 || res.status === 403) return { ok: false, error: "not_signed_in" };
  if (!res.ok) return { ok: false, error: "failed" };
  const data = (await res.json()) as {
    token: string;
    session_id: string;
    urls: string[];
    expires_at: number;
    in_container: boolean;
  };
  if (!data.urls?.length) return { ok: false, error: "no_network" };
  try {
    localStorage.setItem(keptKey(a.uid, opts.surface), data.token);
  } catch {
    /* not kept */
  }
  return {
    ok: true,
    token: data.token,
    sessionId: data.session_id,
    urls: data.urls,
    inContainer: !!data.in_container,
    expiresAt: data.expires_at ? data.expires_at * 1000 : null,
    url: localPageUrl(data.urls[0]!, data.token, opts),
  };
}

export async function stopLocalPortal(sessionId: string): Promise<void> {
  const a = await auth();
  if (!a || !sessionId) return;
  try {
    await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/close`, { method: "POST", headers: a.headers });
  } catch {
    /* the engine forgets it on restart anyway */
  }
}

export async function decideLocal(sessionId: string, fileId: string, status: "accepted" | "rejected"): Promise<void> {
  const a = await auth();
  if (!a) return;
  try {
    await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}/decision`, {
      method: "POST",
      headers: { ...a.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  } catch {
    /* the phone just doesn't learn it */
  }
}

interface LocalFileRow {
  id: string;
  name: string;
  size: number;
  mime: string | null;
}

/** Take every file of a local portal as it arrives. Returns a stop function. */
export function watchLocalPortal(sessionId: string, sink: ArrivalSink): () => void {
  let stopped = false;
  const handled = new Set<string>();
  const poll = async () => {
    if (stopped) return;
    const a = await auth();
    if (!a) return;
    let rows: LocalFileRow[] = [];
    try {
      const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/files`, { headers: a.headers });
      if (!res.ok) return;
      rows = ((await res.json()) as { files: LocalFileRow[] }).files || [];
    } catch {
      return;
    }
    for (const row of rows) {
      if (handled.has(row.id) || stopped) continue;
      handled.add(row.id);
      const key = `local:${row.id}`;
      sink({ key, route: "local", id: row.id, name: row.name, size: row.size, state: "taking" });
      try {
        const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(row.id)}`, {
          headers: a.headers,
        });
        if (!res.ok) throw new Error("download_failed");
        const blob = await res.blob();
        const file = new File([blob], row.name, { type: row.mime || blob.type || "application/octet-stream" });
        sink({ key, route: "local", id: row.id, name: row.name, size: file.size, state: "waiting", file });
      } catch (e) {
        handled.delete(row.id);
        sink({ key, route: "local", id: row.id, name: row.name, size: row.size, state: "error", error: (e as Error).message });
      }
    }
  };
  const timer = setInterval(() => void poll(), POLL_MS);
  void poll();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
