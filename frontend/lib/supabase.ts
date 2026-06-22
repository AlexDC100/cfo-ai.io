// Supabase client + persistence layer for alert state, recommendations, and
// activity. Env-driven and fail-safe: when VITE_SUPABASE_URL / ANON_KEY are
// missing the helpers no-op silently and the app keeps working with the
// in-memory derivations. This means the demo workspace works out of the box
// and persistence is purely additive.
//
// Schema lives in /supabase/schema.sql — apply it once via the Supabase SQL
// editor (or `supabase db push`) before flipping persistence on.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Alert, AlertStatus } from "@/lib/alerts";

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

let client: SupabaseClient | null = null;
if (URL && ANON_KEY) {
  client = createClient(URL, ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });
} else {
  // B-H4: loud-failure on boot when Supabase env vars are missing.
  //
  // Until this warning was added, the app silently ran with no auth — every
  // signIn/signUp returned a friendly "Sign-in is not configured" error from
  // AuthCard, but if you were debugging "why does the dashboard show empty
  // state" or "why does upload fail with no error," there was no breadcrumb
  // pointing at the missing env. The console.warn below is impossible to miss
  // for anyone with DevTools open during a fresh deploy.
  //
  // We log specifically which vars are missing — `URL && ANON_KEY` is a
  // single failure mode at the top level, but the operator usually has one
  // of the two set (e.g. a partial copy/paste from the Supabase Dashboard
  // settings tab) and the missing one is the actionable fix.
  const missing: string[] = [];
  if (!URL) missing.push("VITE_SUPABASE_URL");
  if (!ANON_KEY) missing.push("VITE_SUPABASE_ANON_KEY");
  // eslint-disable-next-line no-console
  console.warn(
    `[supabase] auth disabled — missing build env: ${missing.join(", ")}. ` +
      `Sign-in, sign-up, file upload, and persistence will all return a friendly error. ` +
      `Set these in .env (dev) or your deploy environment (prod) and rebuild.`,
  );
}

/** True when env vars are present and the SDK was initialised. */
export const supabaseEnabled = client !== null;

export function getSupabase(): SupabaseClient | null {
  return client;
}

// Resolves the active org_id for the signed-in user. Phase 3 introduced
// a real organizations table — `currentOrgId()` reads the user's first
// membership instead of using auth.uid(). The is_member_of() RLS policy
// validates server-side, so a client sending a stale value gets 403.
//
// During the rollout window where some users still have legacy rows whose
// org_id == auth.uid(), the legacy "owner" RLS policies remain in place
// alongside the new "member" ones so reads keep working. Writes always
// use the membership-derived org_id below.
async function currentOrgId(): Promise<string | null> {
  if (!client) return null;
  const { data: session } = await client.auth.getSession();
  const user = session.session?.user;
  if (!user) return null;
  const { data, error } = await client
    .from("memberships")
    .select("org_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    // Fallback during the rollout: legacy data uses auth.uid() as org_id.
    return user.id;
  }
  return data.org_id;
}

// ─────────── Alert state persistence ───────────────────────────────────────

export interface AlertStateRow {
  alert_id: string;
  org_id: string;
  status: AlertStatus;
  owner: string | null;
  notes: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  updated_by: string | null;
  updated_at: string;
}

export interface AlertStatePatch {
  status?: AlertStatus;
  owner?: string | null;
  notes?: string | null;
  updated_by?: string | null;
}

/**
 * Read every persisted alert state for the current org.
 *
 * Returns an empty map when Supabase isn't configured — callers should treat
 * a missing entry as the alert's default state ("new").
 */
export async function fetchAlertStates(): Promise<Record<string, AlertStateRow>> {
  if (!client) return {};
  const orgId = await currentOrgId();
  if (!orgId) return {}; // not signed in — RLS would return [] anyway
  const { data, error } = await client
    .from("alert_states")
    .select("*")
    .eq("org_id", orgId);
  if (error) {
    console.warn("[supabase] fetchAlertStates failed:", error.message);
    return {};
  }
  const map: Record<string, AlertStateRow> = {};
  for (const row of (data ?? []) as AlertStateRow[]) {
    map[row.alert_id] = row;
  }
  return map;
}

/**
 * Write or update an alert state, then log the action to the activity feed.
 *
 * The status transition is also recorded in `activity` so the dashboard can
 * show "Alex acknowledged Core Range's anchor health alert at 14:02" without
 * scanning the alert states table.
 */
export async function persistAlertState(
  alert: Alert,
  patch: AlertStatePatch,
): Promise<AlertStateRow | null> {
  if (!client) return null;
  const orgId = await currentOrgId();
  if (!orgId) {
    console.warn("[supabase] persistAlertState skipped: not signed in");
    return null;
  }

  const now = new Date().toISOString();
  const row: Partial<AlertStateRow> & { alert_id: string; org_id: string } = {
    alert_id: alert.id,
    org_id: orgId,
    ...patch,
    updated_at: now,
  };
  if (patch.status === "acknowledged") row.acknowledged_at = now;
  if (patch.status === "resolved") row.resolved_at = now;

  const { data, error } = await client
    .from("alert_states")
    .upsert(row, { onConflict: "org_id,alert_id" })
    .select()
    .single();
  if (error) {
    console.warn("[supabase] persistAlertState failed:", error.message);
    return null;
  }

  // Best-effort activity log; never block the main path on it.
  if (patch.status) {
    await logActivity({
      kind: `alert.${patch.status}`,
      target_type: alert.target_type,
      target_id: alert.target_id,
      payload: {
        alert_type: alert.alert_type,
        severity: alert.severity,
        title: alert.title,
        owner: patch.owner ?? null,
      },
      actor: patch.updated_by ?? null,
    });
  }

  return data as AlertStateRow;
}

// ─────────── Activity feed ─────────────────────────────────────────────────

export interface ActivityEntry {
  kind: string;
  target_type?: string | null;
  target_id?: string | null;
  payload?: Record<string, unknown>;
  actor?: string | null;
}

export async function logActivity(entry: ActivityEntry): Promise<void> {
  if (!client) return;
  const orgId = await currentOrgId();
  if (!orgId) return;
  const { error } = await client.from("activity").insert({
    org_id: orgId,
    ...entry,
  });
  if (error) console.warn("[supabase] logActivity failed:", error.message);
}

export async function fetchRecentActivity(limit = 50): Promise<ActivityFeedRow[]> {
  if (!client) return [];
  const orgId = await currentOrgId();
  if (!orgId) return [];
  const { data, error } = await client
    .from("activity")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[supabase] fetchRecentActivity failed:", error.message);
    return [];
  }
  return (data ?? []) as ActivityFeedRow[];
}

export interface ActivityFeedRow {
  id: string;
  org_id: string;
  actor: string | null;
  kind: string;
  target_type: string | null;
  target_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

// ─────────── Dataset upload metadata ───────────────────────────────────────

export interface DatasetRow {
  id: string;
  file_name: string | null;
  row_count: number | null;
  period: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Wipe the signed-in user's persisted state across all tables.
 *
 * Use case: "Delete dataset" — the operator has finished with one workbook
 * and wants a clean slate before uploading another. RLS policies guarantee
 * we can only delete our own org's rows, so this is safe to call without
 * extra plumbing. Returns the count of rows removed per table for the toast.
 */
export async function clearUserPersistedState(): Promise<{
  alert_states: number;
  recommendations: number;
  datasets: number;
  activity: number;
} | null> {
  if (!client) return null;
  const orgId = await currentOrgId();
  if (!orgId) return null;

  const tables = ["alert_states", "recommendations", "datasets", "activity"] as const;
  const counts: Record<string, number> = {};
  for (const table of tables) {
    // Count first, then delete — Supabase doesn't return affected-row count
    // on a single delete, and we want an honest "removed N rows" toast.
    const { count } = await client
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("org_id", orgId);
    const { error } = await client.from(table).delete().eq("org_id", orgId);
    if (error) {
      console.warn(`[supabase] clearUserPersistedState ${table} failed:`, error.message);
    }
    counts[table] = count ?? 0;
  }
  return counts as Awaited<ReturnType<typeof clearUserPersistedState>>;
}

export async function recordDataset(input: {
  file_name: string;
  row_count: number;
  period?: string;
  uploaded_by?: string;
  metadata?: Record<string, unknown>;
}): Promise<DatasetRow | null> {
  if (!client) return null;
  const orgId = await currentOrgId();
  if (!orgId) return null;
  const { data, error } = await client
    .from("datasets")
    .insert({ org_id: orgId, ...input })
    .select()
    .single();
  if (error) {
    console.warn("[supabase] recordDataset failed:", error.message);
    return null;
  }
  return data as DatasetRow;
}

// ─────────── Documents (Phase 1: real uploads → Storage + DB row) ─────────

export type DocumentDetectedType =
  | "invoice" | "bilant" | "pl" | "trial_balance" | "annual_report"
  // Statutory ANAF filing (Formular F30 P&L + F10 Bilanț). Distinct
  // from `trial_balance` because the extraction is aggregate-only —
  // no per-account drilldown, no SKU rollups, no 711 inventory memo.
  | "statutory_f30_f10"
  // Public-records aggregator PDF (listafirme.ro / termene.ro /
  // firme.info / risco.ro). 6-aggregate × N-year table parsed
  // deterministically — NOT a trial balance. Routes to /multi-year-history
  // after analysis instead of /dashboard, since there's no period to
  // hydrate the financial-statements view from.
  | "public_records_summary"
  | "xlsx_workbook" | "csv" | "image" | "unknown";
// Phase 3 pipeline: 7 stages plus 'failed'. 'queued' is the entry state
// (replaces legacy 'uploaded'); 'analyzed' is the terminal state.
export type DocumentStatus =
  | "queued"
  | "extracting"
  | "mapping"
  | "computing"
  | "narrating"
  | "analyzed"
  | "failed";

export interface DocumentRow {
  id: string;
  org_id: string;
  uploaded_by: string | null;
  storage_path: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  detected_type: DocumentDetectedType | null;
  status: DocumentStatus;
  extraction_confidence: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  duration_ms?: number | null;
  pipeline_started_at?: string | null;
  /** Filled by the pipeline once status hits 'analyzed' — the period the
   *  frontend should hydrate Dashboard/Cash/Profit/etc. from. */
  period_id?: string | null;
}

const DOC_BUCKET = "documents";

/**
 * Cheap heuristic classifier — runs purely on filename + mime. Real
 * classification happens server-side (Phase 2). The string we return is what
 * the UI shows in the documents list ("trial_balance" → "Trial balance").
 */
function detectFromName(filename: string, mime: string): DocumentDetectedType {
  const n = filename.toLowerCase();
  if (/balanta\s*verificare|trial[\s_-]?balance|^tb_/.test(n)) return "trial_balance";
  if (/bilan[tț]|balance[\s_-]?sheet|^bs_/.test(n)) return "bilant";
  if (/factur|invoice|saft|d406|smartbill/.test(n)) return "invoice";
  if (/p[\s_-]?l|profit[\s_-]?loss|cont[\s_-]?profit|^pl_/.test(n)) return "pl";
  if (/anual|annual[\s_-]?report/.test(n)) return "annual_report";
  if (mime.includes("spreadsheet") || /\.xlsx?$/.test(n)) return "xlsx_workbook";
  if (mime === "text/csv" || /\.csv$/.test(n)) return "csv";
  if (mime.startsWith("image/")) return "image";
  return "unknown";
}

/**
 * Trigger the Phase 3 pipeline. Backend kicks off detect → ocr → extract →
 * map → assemble → validate → compute → narrate, persisting each stage and
 * mutating documents.status as it progresses. The frontend subscribes to
 * status changes via subscribeToDocumentStatus() and renders a progress card.
 *
 * Returns true on enqueue (HTTP 202); the actual analysis runs async.
 */
/**
 * Pricing V3 — typed result from `enqueuePipeline`. The legacy
 * boolean return value couldn't distinguish "extra-doc confirmation
 * required" (HTTP 402) from "blocked, upgrade needed" (HTTP 429) from
 * generic transport failure. Callers now get a discriminated union so
 * the upload flow can show the right UX for each.
 */
export type EnqueuePipelineResult =
  | { kind: "queued" }
  | {
      kind: "extra_doc_required";
      planKey: string;
      docsUsed: number;
      docsIncluded: number;
      extraDocEur: number | null;
      message: string;
    }
  | {
      kind: "quota_blocked";
      planKey: string;
      docsUsed: number;
      docsIncluded: number;
      message: string;
      upgradeUrl?: string;
    }
  | { kind: "transport_failed"; message: string };

export async function enqueuePipeline(documentId: string): Promise<EnqueuePipelineResult> {
  if (!client) return { kind: "transport_failed", message: "Supabase not configured." };
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    console.warn("[supabase] enqueuePipeline: no access token");
    return { kind: "transport_failed", message: "Not signed in." };
  }
  // Active UI language → tells the backend's narrate stage what language to
  // reply in. The user's pick on Settings → Language wins; otherwise i18n
  // falls back to browser locale.
  let outputLanguage = "en";
  try {
    const { getActiveLanguage } = await import("@/i18n");
    outputLanguage = (getActiveLanguage() || "en").slice(0, 2);
  } catch { /* i18n not booted yet — fall through to en */ }
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  try {
    const res = await fetch(`${apiUrl}/api/pipeline/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ document_id: documentId, output_language: outputLanguage }),
    });
    if (res.ok) return { kind: "queued" };

    // Pricing V3 surface — 402 = extra-doc confirmation required.
    if (res.status === 402) {
      try {
        const body = (await res.json()) as {
          detail?: {
            code?: string;
            plan_key?: string;
            docs_used?: number;
            docs_included?: number;
            extra_doc_eur?: number | null;
            message?: string;
          };
        };
        const d = body.detail ?? {};
        if (d.code === "extra_doc_confirmation_required") {
          return {
            kind: "extra_doc_required",
            planKey: d.plan_key ?? "starter",
            docsUsed: d.docs_used ?? 0,
            docsIncluded: d.docs_included ?? 0,
            extraDocEur: d.extra_doc_eur ?? null,
            message: d.message ?? "This will be an extra document — confirm to proceed.",
          };
        }
      } catch { /* fall through to generic transport_failed below */ }
    }

    // 429 = quota blocked (trial / intro / over-cap with no extras).
    if (res.status === 429) {
      try {
        const body = (await res.json()) as {
          detail?: {
            code?: string;
            plan_key?: string;
            docs_used?: number;
            docs_included?: number;
            message?: string;
            upgrade_url?: string;
          };
        };
        const d = body.detail ?? {};
        return {
          kind: "quota_blocked",
          planKey: d.plan_key ?? "trial",
          docsUsed: d.docs_used ?? 0,
          docsIncluded: d.docs_included ?? 0,
          message: d.message ?? "You've used all your documents on this plan.",
          upgradeUrl: d.upgrade_url ?? "/pricing",
        };
      } catch { /* fall through */ }
    }

    const txt = await res.text();
    console.warn("[pipeline] enqueue failed:", res.status, txt);
    return { kind: "transport_failed", message: `HTTP ${res.status}` };
  } catch (err) {
    console.warn("[pipeline] enqueue error:", err);
    return {
      kind: "transport_failed",
      message: err instanceof Error ? err.message : "Network error.",
    };
  }
}

/**
 * Re-run the pipeline for a document that previously failed (or analyzed —
 * useful for re-extraction after the user uploads a corrected file). The
 * server resets the status to 'queued' and wipes prior derivatives.
 */
export async function retryPipeline(documentId: string): Promise<boolean> {
  if (!client) return false;
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return false;
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  try {
    const res = await fetch(`${apiUrl}/api/pipeline/retry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ document_id: documentId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Generic watchdog — POST /api/pipeline/recover-stuck.
 *
 * Asks the backend to find every doc in the caller's org sitting at
 * status='queued' with pipeline_started_at=null and older than 5s, then
 * re-enqueue them. Idempotent and safe to call repeatedly.
 *
 * Call this on mount of any page that renders an in-flight progress card
 * (Products, FinancialStatements). It fixes the "Step 0 of 6 forever"
 * silent hang when /api/pipeline/run failed at upload moment (env crash,
 * backend restart during the upload→enqueue handoff, network blip).
 *
 * Returns recovered count + the doc records so callers can toast / log.
 * Returns null on network failure — the page should still render.
 */
export async function recoverStuckPipelines(): Promise<
  { recovered_count: number; recovered: Array<{ id: string; filename: string | null; scope: string | null }> } | null
> {
  if (!client) return null;
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  try {
    const res = await fetch(`${apiUrl}/api/pipeline/recover-stuck`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as {
      recovered_count: number;
      recovered: Array<{ id: string; filename: string | null; scope: string | null }>;
    };
  } catch {
    return null;
  }
}

/**
 * Subscribe to status changes for a single document via Postgres Changes.
 * Returns the unsubscribe function. Pass null `documentId` to subscribe to
 * all of the user's documents (RLS scopes the channel server-side).
 */
export function subscribeToDocumentStatus(
  documentId: string | null,
  onChange: (row: DocumentRow) => void,
): () => void {
  if (!client) return () => {};
  const filter = documentId ? `id=eq.${documentId}` : undefined;
  const channelName = documentId ? `doc-${documentId}` : "docs-all";
  const channel = client
    .channel(channelName)
    .on(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "postgres_changes" as any,
      { event: "UPDATE", schema: "public", table: "documents", filter },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (payload: any) => onChange(payload.new as DocumentRow),
    )
    .subscribe();
  return () => {
    void client?.removeChannel(channel);
  };
}

export interface UploadResult {
  row: DocumentRow | null;
  /** Specific failure reason, surfaced to the user. */
  error: string | null;
}

/**
 * Upload a file to the per-org Storage folder, then insert the documents row.
 *
 * Storage convention: `{org_id}/uploads/{document_id}.{ext}` — the RLS
 * storage policy in schema_phase3.sql checks
 * is_member_of((storage.foldername(name))[1]::uuid).
 *
 * `scope` separates two concepts:
 *   - 'financial' (default): the upload is a financial statement (PDF
 *     bilanț, P&L, trial balance). Pipeline writes financial_periods +
 *     calculated_metrics + briefings — drives Dashboard / Cash / Profit.
 *   - 'sku': the upload is a SKU/inventory/sales analysis (XLSX trading
 *     analysis, invoice register, sales-by-product). Pipeline writes
 *     sku_analyses ONLY — never touches financial_periods, never appears
 *     on the dashboard. Drives the Products page.
 */
export async function uploadDocument(
  file: File,
  options: { scope?: "financial" | "sku" } = {},
): Promise<UploadResult> {
  if (!client) return { row: null, error: "Authentication isn't configured (missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY)." };

  const { data: session } = await client.auth.getSession();
  const userId = session.session?.user?.id ?? null;
  if (!userId) return { row: null, error: "Sign in to upload documents." };

  const orgId = await currentOrgId();
  if (!orgId) {
    return {
      row: null,
      error: "No organization found for this user. Apply supabase/schema_phase3.sql so the bootstrap trigger seeds an org + membership on signup.",
    };
  }

  // iPhone-friendly path: HEIC photos (default camera format on iOS) are
  // neither accepted by Supabase Storage's MIME allow-list nor by the
  // Anthropic vision API. Convert to JPEG in the browser before upload.
  // Skipped entirely for non-HEIC files (zero cost on the hot path).
  const lowerName = (file.name || "").toLowerCase();
  const lowerType = (file.type || "").toLowerCase();
  if (
    lowerName.endsWith(".heic") || lowerName.endsWith(".heif") ||
    lowerType === "image/heic" || lowerType === "image/heif"
  ) {
    try {
      const { default: heic2any } = await import("heic2any");
      const converted = await heic2any({
        blob: file,
        toType: "image/jpeg",
        quality: 0.85,
      });
      const blob = Array.isArray(converted) ? converted[0] : converted;
      const newName = file.name.replace(/\.(heic|heif)$/i, ".jpg");
      file = new File([blob], newName, { type: "image/jpeg", lastModified: Date.now() });
    } catch (err) {
      console.warn("[supabase] HEIC → JPEG conversion failed:", err);
      return {
        row: null,
        error: "Couldn't read this HEIC photo. Try opening it in Photos and re-exporting as JPEG, or take the photo with 'Most Compatible' selected in Settings → Camera → Formats.",
      };
    }
  }

  const detected = detectFromName(file.name, file.type);
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin";
  const documentId = crypto.randomUUID();
  const storagePath = `${orgId}/uploads/${documentId}.${ext}`;

  // Content-hash dedupe — compute SHA-256 of the file bytes BEFORE uploading
  // and check if the same content already exists in this org's documents.
  // Gracefully degrades to "no dedupe" when the `content_hash` column
  // hasn't been migrated yet (schema_phase6_dedupe.sql).
  let contentHash: string | null = null;
  let contentHashSupported = true;
  try {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    contentHash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const dupResp = await client
      .from("documents")
      .select("id,original_filename,period_id,created_at")
      .eq("org_id", orgId)
      .eq("content_hash", contentHash)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1);
    if (dupResp.error) {
      const msg = (dupResp.error.message || "").toLowerCase();
      if (msg.includes("content_hash") && (msg.includes("schema cache") || msg.includes("does not exist") || msg.includes("column"))) {
        // Migration not applied — silently skip dedupe and don't include
        // the column on insert below.
        contentHashSupported = false;
        contentHash = null;
        console.info("[supabase] content_hash column missing — dedupe disabled until schema_phase6_dedupe.sql is applied");
      }
    } else if (dupResp.data && dupResp.data.length > 0) {
      const existing = dupResp.data[0] as { id: string; original_filename: string; period_id: string | null; created_at: string };
      const ok = window.confirm(
        `Looks like you already uploaded this exact file ("${existing.original_filename}") on ${new Date(existing.created_at).toLocaleString()}.\n\n` +
          `Upload again anyway?\n\n` +
          `OK = create a new analysis (will overwrite the existing period at the same date)\n` +
          `Cancel = keep the existing one`,
      );
      if (!ok) {
        return {
          row: null,
          error: "Duplicate upload canceled — the existing copy is unchanged.",
        };
      }
    }
  } catch (e) {
    console.warn("[supabase] content-hash dedupe skipped:", e);
  }

  const { error: upErr } = await client.storage
    .from(DOC_BUCKET)
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (upErr) {
    console.warn("[supabase] storage upload failed:", upErr.message);
    // Map common Supabase storage errors to actionable messages.
    const msg = upErr.message.toLowerCase();
    if (msg.includes("bucket not found")) {
      return { row: null, error: "The 'documents' Storage bucket doesn't exist. Create it in Supabase → Storage → New bucket (private, 25 MB limit), then re-run schema_phase3.sql." };
    }
    if (msg.includes("row-level") || msg.includes("rls") || msg.includes("policy") || msg.includes("not authorized") || msg.includes("403")) {
      return { row: null, error: `Storage policy rejected the upload (path: ${storagePath}). Apply supabase/schema_phase3.sql to bind the new is_member_of-based policies on the 'documents' bucket.` };
    }
    return { row: null, error: `Storage upload failed: ${upErr.message}` };
  }

  const { data, error } = await client
    .from("documents")
    .insert({
      id: documentId,
      org_id: orgId,
      uploaded_by: userId,
      storage_path: storagePath,
      original_filename: file.name,
      mime_type: file.type || "application/octet-stream",
      size_bytes: file.size,
      detected_type: detected,
      status: "queued" as DocumentStatus,
      scope: options.scope ?? "financial",
      // content_hash is added by schema_phase6_dedupe.sql. When the migration
      // hasn't run yet, the dedupe SELECT above sets contentHashSupported=false
      // and we skip the column here so the insert doesn't error with
      // "Could not find the 'content_hash' column of 'documents'".
      ...(contentHash && contentHashSupported ? { content_hash: contentHash } : {}),
    })
    .select()
    .single();
  if (error) {
    console.warn("[supabase] documents insert failed:", error.message);
    // Best-effort cleanup so we don't leave orphan blobs in Storage.
    await client.storage.from(DOC_BUCKET).remove([storagePath]);
    const msg = error.message.toLowerCase();
    if (msg.includes("row-level") || msg.includes("rls") || msg.includes("policy") || msg.includes("violates")) {
      return { row: null, error: "Database policy rejected the row — apply supabase/schema_phase3.sql so member-scoped policies bind on documents." };
    }
    if (msg.includes("check constraint") && msg.includes("status")) {
      return { row: null, error: "documents.status check constraint rejected 'queued' — apply schema_phase3.sql to update the constraint to the new 7-state pipeline enum." };
    }
    return { row: null, error: `Database insert failed: ${error.message}` };
  }
  return { row: data as DocumentRow, error: null };
}

export async function listDocuments(limit = 50): Promise<DocumentRow[]> {
  if (!client) return [];
  const orgId = await currentOrgId();
  if (!orgId) return [];
  const { data, error } = await client
    .from("documents")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[supabase] listDocuments failed:", error.message);
    return [];
  }
  return (data ?? []) as DocumentRow[];
}

export async function deleteDocument(doc: DocumentRow): Promise<boolean> {
  if (!client) return false;
  // Remove the row first; if it's gone but the blob lingers, the periodic
  // cleanup job (TODO) sweeps orphans. RLS prevents deleting other users'.
  await client.storage.from(DOC_BUCKET).remove([doc.storage_path]);
  const { error } = await client.from("documents").delete().eq("id", doc.id);
  if (error) {
    console.warn("[supabase] deleteDocument failed:", error.message);
    return false;
  }
  return true;
}

/**
 * Mint a short-lived signed URL the backend can fetch the PDF through. We
 * use 5 minutes — long enough for the Opus extraction call, short enough
 * not to leak the document.
 */
export async function signedDocumentUrl(doc: DocumentRow, expiresInSeconds = 300): Promise<string | null> {
  if (!client) return null;
  const { data, error } = await client.storage
    .from(DOC_BUCKET)
    .createSignedUrl(doc.storage_path, expiresInSeconds);
  if (error || !data?.signedUrl) {
    console.warn("[supabase] signedDocumentUrl failed:", error?.message);
    return null;
  }
  return data.signedUrl;
}

export async function setDocumentStatus(
  doc: DocumentRow,
  patch: { status?: DocumentStatus; extraction_confidence?: number; error?: string | null; detected_type?: DocumentDetectedType }
): Promise<boolean> {
  if (!client) return false;
  const { error } = await client.from("documents").update(patch).eq("id", doc.id);
  if (error) {
    console.warn("[supabase] setDocumentStatus failed:", error.message);
    return false;
  }
  return true;
}

// ─────────── Alerts (Phase 1: persisted snapshot per org) ─────────────────

export type AlertSeverity = "critical" | "high" | "medium" | "low" | "info";
export type AlertCategory =
  | "liquidity" | "leverage" | "margin" | "inventory" | "compliance"
  | "data_quality" | "working_capital" | "customer" | "supplier" | "opportunity";

export interface AlertRow {
  id: string;
  org_id: string;
  alert_key: string;
  severity: AlertSeverity;
  category: AlertCategory;
  title: string;
  body: string | null;
  document_id: string | null;
  payload: unknown | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AlertUpsertInput {
  alert_key: string;
  severity: AlertSeverity;
  category: AlertCategory;
  title: string;
  body?: string | null;
  document_id?: string | null;
  payload?: unknown;
}

/** Read every active (un-resolved) alert for the current org. */
export async function fetchAlerts(): Promise<AlertRow[]> {
  if (!client) return [];
  const orgId = await currentOrgId();
  if (!orgId) return [];
  const { data, error } = await client
    .from("alerts")
    .select("*")
    .eq("org_id", orgId)
    .is("resolved_at", null)
    .order("severity", { ascending: true })
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("[supabase] fetchAlerts failed:", error.message);
    return [];
  }
  return (data ?? []) as AlertRow[];
}

/** Replace the org's alert set with the supplied list. Used after every
 *  recompute so the persisted snapshot reflects the latest run.
 *  Returns the number of rows written, or null on failure. */
export async function replaceAlerts(alerts: AlertUpsertInput[]): Promise<number | null> {
  if (!client) return null;
  const orgId = await currentOrgId();
  if (!orgId) return null;
  // Delete current rows for this org, then insert the new batch.
  const { error: delErr } = await client.from("alerts").delete().eq("org_id", orgId);
  if (delErr) {
    console.warn("[supabase] replaceAlerts delete failed:", delErr.message);
    return null;
  }
  if (alerts.length === 0) return 0;
  const rows = alerts.map((a) => ({ org_id: orgId, ...a }));
  const { error: insErr } = await client.from("alerts").insert(rows);
  if (insErr) {
    console.warn("[supabase] replaceAlerts insert failed:", insErr.message);
    return null;
  }
  return alerts.length;
}
