// AutoMasters — Supabase I/O for the am_* tables (RLS: workspace member AND
// the `automasters` grant; see supabase/schema_phase_custom_solutions.sql).
//
// Reads and writes go straight to Supabase, like chats and preferences, so
// the CFO side works with the engine stopped. The two rules that must hold
// even for a client that skips the screen — closing a month and asking for
// an export retry — are RPCs that check them in the database.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { getSupabase } from "@/lib/supabase";
import {
  CLOSE_CHECK_KEYS,
  EMPTY_DATA,
  type AmData,
  type BankLine,
  type CentreFigure,
  type CloseCheck,
  type ClosePeriod,
  type ExportItem,
  type FunnelRow,
  type ImportPayload,
  type MatchProposal,
  type OpenDocument,
  type PaymentMatch,
} from "./model";

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function client() {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase is not configured.");
  return sb;
}

function fail(error: { message?: string } | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message ?? "request failed"}`);
}

export async function loadAmData(orgId: string): Promise<AmData> {
  const sb = client();
  const q = (table: string, columns: string) => sb.from(table).select(columns).eq("org_id", orgId);
  const [bank, docs, matches, exports, centres, funnel, periods, checks] = await Promise.all([
    q("am_bank_lines", "id,external_ref,booked_on,payer,reference,amount,currency,suggested_document").order("booked_on", { ascending: false }),
    q("am_documents", "id,doc_number,customer,kind,amount,currency,issued_on").order("issued_on", { ascending: false }),
    q("am_payment_matches", "id,bank_line_id,document_id,difference,method,matched_at").order("matched_at"),
    q("am_export_items", "id,channel,ref,description,counterparty,doc_count,amount,currency,status,error_message,events,retry_requested_at,updated_at").order("updated_at", { ascending: false }),
    q("am_centre_figures", "period,centre,revenue,margin,budget_margin,dms_amount,ledger_amount,note,contributors"),
    q("am_funnel", "period,stage,position,count"),
    q("am_close_periods", "period,status,closed_at"),
    q("am_close_checks", "period,check_key,position,done,done_at"),
  ]);
  for (const [r, what] of [[bank, "bank lines"], [docs, "documents"], [matches, "matches"], [exports, "exports"],
    [centres, "profit centres"], [funnel, "funnel"], [periods, "close periods"], [checks, "close checks"]] as const) {
    fail(r.error, `Could not load ${what}`);
  }
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const rows = (r: { data: unknown }): any[] => (Array.isArray(r.data) ? r.data : []);
  return {
    bank: rows(bank).map((r): BankLine => ({ ...r, amount: n(r.amount) })),
    documents: rows(docs).map((r): OpenDocument => ({ ...r, amount: n(r.amount) })),
    matches: rows(matches).map((r): PaymentMatch => ({ ...r, difference: n(r.difference) })),
    exports: rows(exports).map((r): ExportItem => ({
      ...r, amount: n(r.amount), doc_count: n(r.doc_count), events: Array.isArray(r.events) ? r.events : [],
    })),
    centres: rows(centres).map((r): CentreFigure => ({
      ...r,
      revenue: n(r.revenue),
      margin: n(r.margin),
      budget_margin: nn(r.budget_margin),
      dms_amount: nn(r.dms_amount),
      ledger_amount: nn(r.ledger_amount),
      contributors: Array.isArray(r.contributors)
        ? r.contributors.map((c: any) => ({ name: String(c.name ?? ""), value: n(c.value) }))
        : [],
    })),
    funnel: rows(funnel).map((r): FunnelRow => ({ ...r, position: n(r.position), count: n(r.count) })),
    periods: rows(periods) as ClosePeriod[],
    checks: rows(checks).map((r): CloseCheck => ({ ...r, position: n(r.position) })),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

export const amQueryKey = (orgId: string | null) => ["automasters", orgId] as const;

export function useAmData(orgId: string | null, enabled = true) {
  return useQuery({
    queryKey: amQueryKey(orgId),
    queryFn: () => (orgId ? loadAmData(orgId) : Promise.resolve(EMPTY_DATA)),
    enabled: enabled && !!orgId,
    staleTime: 30_000,
  });
}

/** Re-read the workspace's AutoMasters data after a write. */
export function useAmRefresh(orgId: string | null) {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: amQueryKey(orgId) }), [qc, orgId]);
}

// ── Writes ──────────────────────────────────────────────────────────────

/** Upsert a validated import. Rows are keyed by their natural ids (payment
 *  ref, document number, channel + ref, period + centre, period + stage),
 *  so importing the same file twice changes nothing. */
export async function importAmData(orgId: string, p: ImportPayload): Promise<void> {
  const sb = client();
  const up = async (table: string, rows: object[], onConflict: string) => {
    if (!rows.length) return;
    const { error } = await sb.from(table)
      .upsert(rows.map((r) => ({ ...r, org_id: orgId })), { onConflict });
    fail(error, `Could not import ${table}`);
  };
  await up("am_bank_lines", p.bank_lines, "org_id,external_ref");
  await up("am_documents", p.documents, "org_id,doc_number");
  const now = new Date().toISOString();
  await up("am_export_items", p.exports.map((e) => ({ ...e, updated_at: now })), "org_id,channel,ref");
  await up("am_centre_figures", p.centres.map((c) => ({ ...c, updated_at: now })), "org_id,period,centre");
  await up("am_funnel", p.funnel, "org_id,period,stage");
}

export async function matchPayments(orgId: string, pairs: MatchProposal[], method: "manual" | "auto"): Promise<void> {
  if (!pairs.length) return;
  const { error } = await client().from("am_payment_matches").insert(
    pairs.map((p) => ({ org_id: orgId, ...p, method })),
  );
  fail(error, "Could not save the match");
}

export async function unmatchPayment(matchId: string): Promise<void> {
  const { error } = await client().from("am_payment_matches").delete().eq("id", matchId);
  fail(error, "Could not undo the match");
}

export async function requestExportRetry(id: string): Promise<{ ok: boolean; reason?: string }> {
  const { data, error } = await client().rpc("am_request_export_retry", { _id: id });
  fail(error, "Could not request the retry");
  return (data ?? { ok: false }) as { ok: boolean; reason?: string };
}

/** Start a month's close: the period row and the standard checklist. */
export async function openClosePeriod(orgId: string, period: string): Promise<void> {
  const sb = client();
  const { error } = await sb.from("am_close_periods").insert({ org_id: orgId, period });
  fail(error, "Could not open the month");
  const { error: e2 } = await sb.from("am_close_checks").insert(
    CLOSE_CHECK_KEYS.map((check_key, position) => ({ org_id: orgId, period, check_key, position })),
  );
  fail(e2, "Could not create the checklist");
}

export async function setCloseCheck(orgId: string, period: string, key: string, done: boolean, userId: string | null): Promise<void> {
  const { error } = await client().from("am_close_checks")
    .update({ done, done_at: done ? new Date().toISOString() : null, done_by: done ? userId : null })
    .eq("org_id", orgId).eq("period", period).eq("check_key", key);
  fail(error, "Could not update the checklist");
}

export type CloseResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "already_closed" | "open_checks" | "material_difference"; detail?: unknown };

export async function closeMonth(orgId: string, period: string): Promise<CloseResult> {
  const { data, error } = await client().rpc("am_close_period", { _org_id: orgId, _period: period });
  fail(error, "Could not close the month");
  return data as CloseResult;
}
