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
}

/** True when env vars are present and the SDK was initialised. */
export const supabaseEnabled = client !== null;

export function getSupabase(): SupabaseClient | null {
  return client;
}

// org_id is the signed-in user's id (auth.uid()). The schema's RLS policies
// enforce this on the server, so even if a caller sends a different value
// the database rejects it. We resolve it lazily from the current session so
// callers don't have to thread auth state through every persistence call.
async function currentOrgId(): Promise<string | null> {
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session?.user?.id ?? null;
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
  | "xlsx_workbook" | "csv" | "image" | "unknown";
export type DocumentStatus = "uploaded" | "extracting" | "mapped" | "analyzed" | "failed";

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
}

const DOC_BUCKET = "documents";

/**
 * Cheap heuristic classifier — runs purely on filename + mime. Real
 * classification happens server-side (Phase 2). The string we return is what
 * the UI shows in the documents list ("trial_balance" → "Trial balance").
 */
function detectFromName(filename: string, mime: string): DocumentDetectedType {
  const n = filename.toLowerCase();
  if (/balanta\s*verificare|trial[\s_-]?balance/.test(n)) return "trial_balance";
  if (/bilan[tț]|balance[\s_-]?sheet/.test(n)) return "bilant";
  if (/factur|invoice/.test(n)) return "invoice";
  if (/p[\s_-]?l|profit[\s_-]?loss|cont[\s_-]?profit/.test(n)) return "pl";
  if (/anual|annual[\s_-]?report/.test(n)) return "annual_report";
  if (mime.includes("spreadsheet") || /\.xlsx?$/.test(n)) return "xlsx_workbook";
  if (mime === "text/csv" || /\.csv$/.test(n)) return "csv";
  if (mime.startsWith("image/")) return "image";
  return "unknown";
}

/**
 * Upload a file to the per-user Storage folder, then insert the documents
 * row. Returns the new row (or null when Supabase isn't configured).
 *
 * Storage convention: `{user_id}/{document_id}.{ext}` — the RLS storage
 * policy in schema.sql checks (storage.foldername(name))[1] = auth.uid().
 *
 * No server pipeline kicked off here — Phase 2 wires the extraction worker.
 */
export async function uploadDocument(file: File): Promise<DocumentRow | null> {
  if (!client) return null;
  const orgId = await currentOrgId();
  if (!orgId) {
    console.warn("[supabase] uploadDocument skipped: not signed in");
    return null;
  }
  const detected = detectFromName(file.name, file.type);
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin";
  const documentId = crypto.randomUUID();
  const storagePath = `${orgId}/${documentId}.${ext}`;

  const { error: upErr } = await client.storage
    .from(DOC_BUCKET)
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (upErr) {
    console.warn("[supabase] uploadDocument storage upload failed:", upErr.message);
    return null;
  }

  const { data, error } = await client
    .from("documents")
    .insert({
      id: documentId,
      org_id: orgId,
      uploaded_by: orgId,
      storage_path: storagePath,
      original_filename: file.name,
      mime_type: file.type || "application/octet-stream",
      size_bytes: file.size,
      detected_type: detected,
      status: "uploaded" as DocumentStatus,
    })
    .select()
    .single();
  if (error) {
    console.warn("[supabase] documents insert failed:", error.message);
    // Best-effort cleanup so we don't leave orphan blobs in Storage.
    await client.storage.from(DOC_BUCKET).remove([storagePath]);
    return null;
  }
  return data as DocumentRow;
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
