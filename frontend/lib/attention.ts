// attention.ts — "Ce contează acum" (attention/1), the command bar's empty
// state, as the ENGINE serves it (GET /api/period/{id}/attention,
// src/engine/attention/now.py, packs/serving/attention.yaml).
//
// ONE AUTHORITY. The engine ranks the three most material items for THIS
// company and period (biggest movement vs the same-length prior, worst
// ratio vs sector, biggest improvement — or, with no prior, the period's
// own findings) and chooses the two or three actions. Every item carries
// the SERVED object it was read from (a comparatives column, a sector row,
// a ratio compare row, an insight measure) verbatim. The browser orders
// nothing, ranks nothing and computes nothing: it prints each item's
// served figure through the printer that surface already uses
// (components/instrument/shell/cmdbar/cmdbarFigures.ts).
//
// Absent is never empty: fewer material items means fewer items, and each
// empty slot carries its reason in `unfilled`.

import { useQuery } from "@tanstack/react-query";

import { authOrgHeaders } from "@/lib/apiHeaders";
import type { ComparativeColumnDto } from "@/lib/comparatives";
import type { InsightMeasure } from "@/lib/insights";
import type { RatioCompareRow } from "@/lib/ratioTable";
import type { SectorRow } from "@/lib/sectorBenchmark";

export const ATTENTION_SCHEMA = "attention/1";

export interface Bilingual {
  ro: string;
  en: string;
}

export interface AttentionReason {
  code: string;
  inputs?: unknown[];
  [k: string]: unknown;
}

export type AttentionFigure =
  | {
      kind: "comparatives_column";
      column: ComparativeColumnDto;
      current_label: string | null;
      prior_label: string | null;
    }
  | { kind: "sector_row"; row: SectorRow; min_peers: number }
  | { kind: "ratio_compare_row"; row: RatioCompareRow }
  | { kind: "insight_measure"; measure: InsightMeasure; currency: string | null };

export type AttentionEvidence =
  | { kind: "statement"; tab: string; line: string; prior_period_id?: string | null }
  | { kind: "benchmark_row"; route: string; row: string }
  | { kind: "ratio"; tab: string; ratio: string; accounts?: string[] }
  | {
      kind: "account";
      account: string | null;
      accounts: string[];
    }
  | { kind: string; [k: string]: unknown };

export interface AttentionItem {
  slot: "movement" | "worst_vs_sector" | "improvement" | "finding";
  family: "statement_line" | "sector_row" | "ratio_band" | "insight";
  key: string;
  identity: string;
  rank: number;
  subject: Bilingual;
  basis_label: Bilingual | null;
  figure: AttentionFigure;
  verdict: "improved" | "deteriorated" | "worse" | "better" | null;
  claim_policy?: { may_call_slow: boolean; verdict_word: boolean; reason: string };
  materiality: Record<string, unknown>;
  source: { document: string; path: string };
  evidence: AttentionEvidence;
}

export type AttentionActionTarget =
  | { kind: "compare"; period_id: string | null; prior_period_id: string | null }
  | { kind: "upload"; org_id: string | null; period_end: string | null }
  | { kind: "forecast_bank_export"; route: string; period_id: string | null }
  | { kind: "report_pdf"; route: string; tab: string; period_id: string | null }
  | { kind: "route"; route: string; period_id: string | null };

export interface AttentionAction {
  key: string;
  label: Bilingual;
  requires_feature?: string;
  target: AttentionActionTarget;
}

export interface AttentionDoc {
  schema: string;
  period: {
    id: string | null;
    period_start: string | null;
    period_end: string | null;
    label: string | null;
    company_name: string | null;
    org_id: string | null;
    currency: string | null;
  };
  mode: "with_prior" | "single_period";
  /** The credit model's regime for this period (revision 5, owner ruling
   *  R1): the served envelope's `regime` block verbatim, or null under the
   *  standard model. Read with `lib/creditRegime.readCreditRegime`; the bar
   *  prints it ONCE. Absent on a document served before the ruling. */
  credit_regime?: unknown;
  prior: {
    status: "found" | "absent" | "off" | string;
    period_id: string | null;
    period_end: string | null;
    available_period_id?: string | null;
    available_period_end?: string | null;
    reason?: AttentionReason | null;
  };
  items: AttentionItem[];
  unfilled: { slot: string; reason: AttentionReason | null }[];
  actions: AttentionAction[];
  caveats: { key: string; text: Bilingual }[];
  sources: Record<string, unknown>;
}

/** The served document, shape-checked; anything else is null. */
export function readAttention(doc: unknown): AttentionDoc | null {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  if (d.schema !== ATTENTION_SCHEMA) return null;
  if (!Array.isArray(d.items) || !Array.isArray(d.actions) || !Array.isArray(d.caveats)) return null;
  if (typeof d.period !== "object" || d.period === null) return null;
  return doc as AttentionDoc;
}

/** Which comparison the document is composed against: the engine's own
 *  same-length prior ("auto"), none (the reader switched comparisons off
 *  for this company), or a named period of the same company. */
export type AttentionPrior = "auto" | "none" | string;

export type AttentionFetch =
  | { kind: "ok"; data: AttentionDoc }
  | { kind: "refused"; code: string }
  | { kind: "error"; status: number };

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

/** GET /api/period/{id}/attention, asked of the company the period belongs
 *  to (X-Org-Id = `orgId`; the engine validates the membership and reads
 *  every period org-filtered). */
export async function fetchAttention(
  periodId: string,
  orgId: string,
  prior: AttentionPrior,
): Promise<AttentionFetch> {
  const headers = await authOrgHeaders();
  if (!headers) return { kind: "error", status: 401 };
  headers["X-Org-Id"] = orgId;
  const q = prior === "auto" ? "" : `?prior=${encodeURIComponent(prior)}`;
  try {
    const res = await fetch(`${API_URL}/api/period/${encodeURIComponent(periodId)}/attention${q}`, { headers });
    if (res.ok) {
      const doc = readAttention(await res.json());
      return doc ? { kind: "ok", data: doc } : { kind: "error", status: 0 };
    }
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    const detail = (body as { detail?: { code?: string } } | null)?.detail;
    if (detail && typeof detail === "object" && typeof detail.code === "string") {
      return { kind: "refused", code: detail.code };
    }
    return { kind: "error", status: res.status };
  } catch {
    return { kind: "error", status: 0 };
  }
}

/** The company, the period and the comparison are all in the key: one
 *  company's "what matters now" is never served from another's entry. */
export const attentionQueryKey = (orgId: string, periodId: string, prior: AttentionPrior) =>
  ["attention", orgId, periodId, prior] as const;

export function useAttention(periodId: string | null, orgId: string | null, prior: AttentionPrior) {
  return useQuery({
    queryKey: attentionQueryKey(orgId ?? "", periodId ?? "", prior),
    queryFn: () => fetchAttention(periodId!, orgId!, prior),
    enabled: !!orgId && !!periodId,
    staleTime: 5 * 60_000,
  });
}
