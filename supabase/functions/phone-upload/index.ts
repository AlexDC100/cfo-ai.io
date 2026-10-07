// phone-upload — the upload portal's CLOUD route: files from a phone into an
// upload section of the web app on a PC. Ported from DocVex's `phone-upload`.
//
// NOT DEPLOYED by the branch that wrote it. Schema: supabase/
// schema_phase_phone_upload.sql (apply first). Deploy with verify_jwt OFF:
//
//   supabase functions deploy phone-upload --project-ref <ref> --use-api --no-verify-jwt
//
// The phone is not signed in. It holds a random token (in the QR code; only
// its SHA-256 is stored) and this function, with the service role, does
// everything on its behalf — and nothing else:
//
//   create  (user JWT)  { orgId?, surface?, token? } → { token, sessionId, expiresAt }
//                       Mints a portal for the signed-in user — or, given a
//                       KEPT token of theirs, REOPENS it (the same QR code
//                       every time). Clears the user's sessions that ended a
//                       day ago.
//   close   (user JWT)  { sessionId } → { ok }   PAUSES a portal (the PC
//                       closed the window); `create` with its token reopens it.
//   info    (token)     → { ok, surface, workspace, expiresAt, files, maxBytes }
//   sign    (token)     { size } → { signedUrl, path }   one file: <session>/<uuid>
//   done    (token)     { path, size, sealed } → { ok, id }
//                       The file is checked to be in the bucket and a row is
//                       written, which the PC hears over Realtime.
//   status  (token)     { ids } → { ok, status: { id: waiting|accepted|rejected|unknown } }
//   sweep   (none)      housekeeping, safe to call any time (hourly cron).
//
// END-TO-END ENCRYPTED: the phone seals every file with a key that exists
// only in the QR code's URL fragment (frontend/lib/phoneUpload/seal.ts). This
// function, the bucket and the row never see the content, the name or the
// type: a row is written as name "encrypted", mime SEALED_MIME — and a file
// the phone does not mark sealed is refused.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const BUCKET = "phone-upload";
const SESSION_DAYS = 7; // sliding: every reopen pushes it back
const MAX_BYTES = 50 * 1024 * 1024; // the bucket's own cap (+ the seal's overhead below)
const SEAL_OVERHEAD = 64 * 1024;
const MAX_FILES = 300; // per session
const MAX_SESSION_BYTES = 2 * 1024 * 1024 * 1024;
const SEALED_MIME = "application/x-cfoai-sealed";

const SURFACES = new Set([
  "workspace", "company", "statements", "periods", "products", "sources", "budget", "chat", "upload",
]);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const action = String(body.action || "");

  const emptyFolder = async (folder: string) => {
    for (let guard = 0; guard < 50; guard++) {
      const { data: objs } = await db.storage.from(BUCKET).list(folder, { limit: 1000 });
      if (!objs?.length) return;
      const { error } = await db.storage.from(BUCKET).remove(objs.map((x) => `${folder}/${x.name}`));
      if (error) return;
    }
  };

  // ── Sweep: only ever deletes what has already lapsed ─────────────────────
  if (action === "sweep") {
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    let sessions = 0, orphans = 0;
    const { data: old } = await db.from("phone_upload_sessions").select("id").lt("expires_at", dayAgo).limit(200);
    for (const o of old || []) {
      await emptyFolder(o.id);
      await db.from("phone_upload_sessions").delete().eq("id", o.id);
      sessions++;
    }
    const { data: folders } = await db.storage.from(BUCKET).list("", { limit: 1000 });
    const ids = (folders || []).filter((f) => !f.id && UUID.test(f.name)).map((f) => f.name);
    if (ids.length) {
      const { data: live, error: liveErr } = await db.from("phone_upload_sessions").select("id").in("id", ids);
      // Never guess: without a clean answer, no folder is an orphan.
      if (liveErr || !live) return json({ ok: true, sessions, orphans });
      const keep = new Set(live.map((r) => r.id));
      for (const id of ids) if (!keep.has(id)) { await emptyFolder(id); orphans++; }
    }
    return json({ ok: true, sessions, orphans });
  }

  // ── Signed-in actions (the PC) ───────────────────────────────────────────
  if (action === "create" || action === "close") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ ok: false, error: "not_signed_in" }, 401);
    const asUser = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    });
    const { data: u } = await asUser.auth.getUser(jwt);
    const user = u?.user;
    if (!user) return json({ ok: false, error: "not_signed_in" }, 401);

    if (action === "close") {
      const id = String(body.sessionId || "");
      if (!UUID.test(id)) return json({ ok: true });
      await db.from("phone_upload_sessions").update({ closed_at: new Date().toISOString() })
        .eq("id", id).eq("user_id", user.id);
      return json({ ok: true });
    }

    // A workspace the caller belongs to — asked AS THE USER, so RLS decides.
    const orgId = typeof body.orgId === "string" && UUID.test(body.orgId) ? body.orgId : null;
    if (orgId) {
      const { data: org } = await asUser.from("organizations").select("id").eq("id", orgId).maybeSingle();
      if (!org) return json({ ok: false, error: "no_workspace" }, 403);
    }
    const surface = SURFACES.has(String(body.surface)) ? String(body.surface) : "upload";

    // Housekeeping: this user's sessions that ended a day ago.
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: old } = await db.from("phone_upload_sessions").select("id")
      .eq("user_id", user.id).lt("expires_at", dayAgo).limit(50);
    for (const o of old || []) {
      await emptyFolder(o.id);
      await db.from("phone_upload_sessions").delete().eq("id", o.id);
    }

    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
    const kept = typeof body.token === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(body.token) ? body.token : "";
    if (kept) {
      const { data: k } = await db.from("phone_upload_sessions").select("id")
        .eq("token_hash", await sha256(kept)).eq("user_id", user.id).maybeSingle();
      if (k) {
        await db.from("phone_upload_sessions")
          .update({ closed_at: null, expires_at: expiresAt, org_id: orgId, surface })
          .eq("id", k.id);
        return json({ ok: true, token: kept, sessionId: k.id, expiresAt, reopened: true });
      }
    }
    const token = newToken();
    const { data: s, error } = await db.from("phone_upload_sessions")
      .insert({ user_id: user.id, org_id: orgId, surface, token_hash: await sha256(token), expires_at: expiresAt })
      .select("id").single();
    if (error || !s) return json({ ok: false, error: "create_failed" }, 500);
    return json({ ok: true, token, sessionId: s.id, expiresAt });
  }

  // ── Token actions (the phone) ────────────────────────────────────────────
  const token = String(body.token || "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return json({ ok: false, error: "no_token" }, 401);
  const { data: s } = await db.from("phone_upload_sessions")
    .select("id,surface,expires_at,closed_at,file_count,byte_count")
    .eq("token_hash", await sha256(token)).maybeSingle();
  if (!s) return json({ ok: false, error: "unknown" }, 404);
  if (s.closed_at) return json({ ok: false, error: "closed" }, 410);
  if (new Date(s.expires_at).getTime() < Date.now()) return json({ ok: false, error: "expired" }, 410);

  if (action === "info") {
    // The workspace NAME is deliberately not sent: the phone is anonymous.
    return json({ ok: true, surface: s.surface, expiresAt: s.expires_at, files: s.file_count, maxBytes: MAX_BYTES });
  }

  if (action === "sign") {
    const size = Number(body.size) || 0;
    if (size > MAX_BYTES + SEAL_OVERHEAD) return json({ ok: false, error: "too_large", maxBytes: MAX_BYTES }, 413);
    if (s.file_count >= MAX_FILES) return json({ ok: false, error: "too_many" }, 429);
    if (s.byte_count + size > MAX_SESSION_BYTES) return json({ ok: false, error: "session_full" }, 413);
    const path = `${s.id}/${crypto.randomUUID()}`;
    const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) return json({ ok: false, error: "sign_failed" }, 500);
    return json({ ok: true, signedUrl: data.signedUrl, path });
  }

  if (action === "done") {
    const path = String(body.path || "");
    if (!path.startsWith(`${s.id}/`) || path.includes("..")) return json({ ok: false, error: "bad_path" }, 400);
    if (body.sealed !== true) return json({ ok: false, error: "not_sealed" }, 400);
    const leaf = path.slice(s.id.length + 1);
    const { data: objs } = await db.storage.from(BUCKET).list(s.id, { search: leaf, limit: 1 });
    const obj = (objs || []).find((o) => o.name === leaf);
    if (!obj) return json({ ok: false, error: "not_uploaded" }, 409);
    const size = Number((obj.metadata as Record<string, unknown> | null)?.size) || Number(body.size) || 0;
    const { data: row, error } = await db.from("phone_upload_files")
      .insert({ session_id: s.id, path, size, name: "encrypted", mime: SEALED_MIME })
      .select("id").single();
    if (error || !row) return json({ ok: false, error: "record_failed" }, 500);
    await db.from("phone_upload_sessions")
      .update({ file_count: s.file_count + 1, byte_count: s.byte_count + size }).eq("id", s.id);
    return json({ ok: true, id: row.id, held: true });
  }

  if (action === "status") {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((x) => UUID.test(x)).slice(0, 200);
    const status: Record<string, string> = {};
    for (const id of ids) status[id] = "unknown";
    if (ids.length) {
      const { data: rows } = await db.from("phone_upload_files").select("id,status")
        .eq("session_id", s.id).in("id", ids);
      for (const r of rows || []) status[r.id] = r.status || "waiting";
    }
    return json({ ok: true, status });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
