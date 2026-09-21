// uploadsApi.ts — the frontend half of the workspace-redesign upload contract.
//
// Three engine routes, one shape each (the contract is fixed; this file must
// not grow a field the engine does not send, nor invent one it does not):
//
//   POST /api/uploads/identify  multipart `file` · X-Org-Id = company on screen
//        → what the document says it is (company, CUI, period, industry, and
//          where each came from), which of my companies it belongs to, and
//          whether this exact file is already stored there. Stores nothing,
//          reserves nothing — safe to call on every drop.
//   POST /api/uploads/commit    multipart `file` + the confirmed choice
//        → stores the document under the target company and queues the
//          analysis through the same quota path as /api/pipeline/run.
//   GET  /api/companies/{org_id}/years
//        → one row per analysed year, read from the SAME served figures the
//          dashboard shows (the engine owns the number; this file only
//          carries it).
//
// Headers come from authOrgHeaders (bearer + X-Org-Id), the one helper the
// orgScopedFetch gate accepts for org-resolving routes.

import { getActiveLanguage } from "@/i18n";
import { authOrgHeaders } from "@/lib/apiHeaders";
import { getSupabase } from "@/lib/supabase";
import { parseUploadRefusal } from "@/lib/uploadRefusals";

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

// ── Contract types ─────────────────────────────────────────────────────

/** Where one identified field came from. `signal` is a stable machine
 *  token (see components/cfo/upload/identitySources.ts for the words the
 *  user reads); `evidence` is the literal text or registry reference. */
export interface IdentitySource {
  signal: string;
  evidence?: string | null;
}

export interface DocumentIdentity {
  cui: string | null;
  company_name: string | null;
  /** ISO date (YYYY-MM-DD), last day of the reporting period. */
  period_end: string | null;
  caen_code: string | null;
  industry_key: string | null;
  industry_label: string | null;
  sources: Partial<Record<IdentityField, IdentitySource>>;
}

export type IdentityField =
  | "cui"
  | "company_name"
  | "period_end"
  | "caen_code"
  | "industry_key"
  | "industry_label";

export type TargetReason = "cui_match" | "on_screen_company" | "new_cui";

export interface IdentifyTarget {
  org_id: string | null;
  name: string | null;
  is_new: boolean;
  reason: TargetReason;
}

export interface DuplicateRef {
  document_id: string;
  period_id: string | null;
  org_id: string;
}

export interface CompanyRef {
  org_id: string;
  name: string;
  cui: string | null;
}

export interface IdentifyResult {
  content_hash: string;
  identity: DocumentIdentity;
  target: IdentifyTarget;
  duplicate: DuplicateRef | null;
  companies: CompanyRef[];
}

export interface CreateCompanyInput {
  name: string;
  cui: string | null;
  caen_code: string | null;
  industry_key: string | null;
}

export interface CommitInput {
  file: File;
  /** The existing company the file goes to. Omitted when creating one. */
  targetOrgId?: string | null;
  /** Create this company and put the file in it. */
  createCompany?: CreateCompanyInput | null;
  periodEnd: string;
  industryKey?: string | null;
  /** X-Org-Id — the company on screen when the file was dropped. */
  onScreenOrgId?: string | null;
}

/** The plan's extra-document question (402), as /api/pipeline/run asks it. */
export interface ExtraDocConfirmation {
  planKey: string;
  docsUsed: number;
  docsIncluded: number;
  extraDocEur: number | null;
  message: string;
}

export type CommitResult =
  | {
      status: "queued";
      document_id: string;
      org_id: string;
      company_name: string;
      /** True when this commit created the company (a new CUI). */
      created_company?: boolean;
    }
  | {
      status: "duplicate";
      document_id: string;
      period_id: string | null;
      org_id: string;
      company_name?: string | null;
    }
  /** 402 — the plan wants the user's say-so first. The meter answers BEFORE
   *  anything is stored, so the flow shows the unchanged extra-document
   *  dialog and, once confirmed, sends the same commit again. */
  | { status: "needs_confirmation"; confirmation: ExtraDocConfirmation }
  | { status: "refused"; message: string; httpStatus: number };

export interface CompanyYear {
  period_id: string;
  year: number;
  period_end: string;
  revenue: number | null;
  /** Percent change vs the prior year, in percentage points (12.3 = +12.3 %).
   *  Null for the first year on record or when either side is absent. */
  revenue_change_pct: number | null;
  /** Source currency of `revenue` when the engine sends it; RON otherwise. */
  currency?: string | null;
}

export class UploadApiError extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = "UploadApiError";
    this.httpStatus = httpStatus;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

async function headersFor(onScreenOrgId?: string | null): Promise<Record<string, string>> {
  const headers = await authOrgHeaders();
  if (!headers) throw new UploadApiError("not_signed_in", 401);
  // The company ON SCREEN, not merely the stored active one: identify routes a
  // CUI-less document to it, and commit's membership check reads it.
  if (onScreenOrgId) headers["X-Org-Id"] = onScreenOrgId;
  return headers;
}

async function readJson(res: Response): Promise<unknown> {
  const txt = await res.text().catch(() => "");
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return txt;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** The human part of a FastAPI error body (`detail` string, or
 *  `detail.message`), else a short status line. */
export function errorMessageFrom(body: unknown, status: number): string {
  const rec = asRecord(body);
  const detail = rec?.detail;
  if (typeof detail === "string" && detail) return detail;
  const d = asRecord(detail);
  if (d && typeof d.message === "string" && d.message) return d.message;
  if (typeof body === "string" && body && body.length < 300) return body;
  return `HTTP ${status}`;
}

function outputLanguage(): string {
  try {
    return (getActiveLanguage() || "en").slice(0, 2);
  } catch {
    return "en";
  }
}

// ── Calls ──────────────────────────────────────────────────────────────

export async function identifyUpload(
  file: File,
  onScreenOrgId: string | null,
): Promise<IdentifyResult> {
  const headers = await headersFor(onScreenOrgId);
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(`${API_URL}/api/uploads/identify`, {
    method: "POST",
    headers,
    body: form,
  });
  const body = await readJson(res);
  if (!res.ok) throw new UploadApiError(errorMessageFrom(body, res.status), res.status);
  return normalizeIdentify(body);
}

/** Defensive shape check — a malformed answer is an error, never a guess. */
export function normalizeIdentify(body: unknown): IdentifyResult {
  const rec = asRecord(body);
  const identity = asRecord(rec?.identity);
  const target = asRecord(rec?.target);
  if (!rec || !identity || !target) throw new UploadApiError("malformed_identify", 502);
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  const sourcesRaw = asRecord(identity.sources) ?? {};
  const sources: DocumentIdentity["sources"] = {};
  for (const [field, value] of Object.entries(sourcesRaw)) {
    const s = asRecord(value);
    if (s && typeof s.signal === "string") {
      sources[field as IdentityField] = {
        signal: s.signal,
        evidence: typeof s.evidence === "string" ? s.evidence : null,
      };
    }
  }
  const reason = target.reason;
  const dup = asRecord(rec.duplicate);
  const companies = Array.isArray(rec.companies) ? rec.companies : [];
  return {
    content_hash: String(rec.content_hash ?? ""),
    identity: {
      cui: str(identity.cui),
      company_name: str(identity.company_name),
      period_end: str(identity.period_end),
      caen_code: str(identity.caen_code),
      industry_key: str(identity.industry_key),
      industry_label: str(identity.industry_label),
      sources,
    },
    target: {
      org_id: str(target.org_id),
      name: str(target.name),
      is_new: target.is_new === true,
      reason:
        reason === "cui_match" || reason === "on_screen_company" || reason === "new_cui"
          ? reason
          : target.is_new === true
            ? "new_cui"
            : "on_screen_company",
    },
    duplicate:
      dup && typeof dup.document_id === "string" && typeof dup.org_id === "string"
        ? {
            document_id: dup.document_id,
            period_id: str(dup.period_id),
            org_id: dup.org_id,
          }
        : null,
    companies: companies
      .map((c) => asRecord(c))
      .filter((c): c is Record<string, unknown> => !!c && typeof c.org_id === "string")
      .map((c) => ({
        org_id: c.org_id as string,
        name: str(c.name) ?? "",
        cui: str(c.cui),
      })),
  };
}

export async function commitUpload(input: CommitInput): Promise<CommitResult> {
  const headers = await headersFor(input.onScreenOrgId ?? null);
  const form = new FormData();
  form.append("file", input.file, input.file.name);
  if (input.createCompany) {
    form.append("create_company", JSON.stringify(input.createCompany));
  } else if (input.targetOrgId) {
    form.append("target_org_id", input.targetOrgId);
  }
  form.append("period_end", input.periodEnd);
  if (input.industryKey) form.append("industry_key", input.industryKey);
  // The narrate stage writes in the language the user is reading. Same
  // field /api/pipeline/run takes; the engine ignores it if it has no use.
  form.append("output_language", outputLanguage());

  const res = await fetch(`${API_URL}/api/uploads/commit`, {
    method: "POST",
    headers,
    body: form,
  });
  const body = await readJson(res);
  const rec = asRecord(body);

  if (res.ok && rec) {
    if (rec.status === "duplicate" && typeof rec.document_id === "string" && typeof rec.org_id === "string") {
      return {
        status: "duplicate",
        document_id: rec.document_id,
        period_id: typeof rec.period_id === "string" ? rec.period_id : null,
        org_id: rec.org_id,
        company_name: typeof rec.company_name === "string" ? rec.company_name : null,
      };
    }
    if (rec.status === "queued" && typeof rec.document_id === "string" && typeof rec.org_id === "string") {
      return {
        status: "queued",
        document_id: rec.document_id,
        org_id: rec.org_id,
        company_name: typeof rec.company_name === "string" ? rec.company_name : "",
        ...(typeof rec.created_company === "boolean" ? { created_company: rec.created_company } : {}),
      };
    }
    throw new UploadApiError("malformed_commit", 502);
  }

  // Typed refusals first — a non-RO document on a plan without it.
  const nonRo = parseUploadRefusal(body);
  if (nonRo) return { status: "refused", message: nonRo.message, httpStatus: res.status };

  if (res.status === 402) {
    const d = asRecord(rec?.detail) ?? rec ?? {};
    if (d.code === "extra_doc_confirmation_required") {
      return {
        status: "needs_confirmation",
        confirmation: {
          planKey: typeof d.plan_key === "string" ? d.plan_key : "starter",
          docsUsed: typeof d.docs_used === "number" ? d.docs_used : 0,
          docsIncluded: typeof d.docs_included === "number" ? d.docs_included : 0,
          extraDocEur: typeof d.extra_doc_eur === "number" ? d.extra_doc_eur : null,
          message: typeof d.message === "string" ? d.message : "",
        },
      };
    }
  }
  if (res.status === 402 || res.status === 403 || res.status === 409 || res.status === 422 || res.status === 429) {
    return { status: "refused", message: errorMessageFrom(body, res.status), httpStatus: res.status };
  }
  throw new UploadApiError(errorMessageFrom(body, res.status), res.status);
}

export async function fetchCompanyYears(orgId: string): Promise<CompanyYear[]> {
  const headers = await headersFor(orgId);
  const res = await fetch(`${API_URL}/api/companies/${encodeURIComponent(orgId)}/years`, {
    headers,
  });
  const body = await readJson(res);
  if (!res.ok) throw new UploadApiError(errorMessageFrom(body, res.status), res.status);
  const rows = Array.isArray(body) ? body : Array.isArray(asRecord(body)?.years) ? (asRecord(body)!.years as unknown[]) : [];
  return rows
    .map((r) => asRecord(r))
    .filter((r): r is Record<string, unknown> => !!r && typeof r.period_id === "string")
    .map((r) => ({
      period_id: r.period_id as string,
      year: Number(r.year),
      period_end: typeof r.period_end === "string" ? r.period_end : "",
      revenue: typeof r.revenue === "number" && Number.isFinite(r.revenue) ? r.revenue : null,
      revenue_change_pct:
        typeof r.revenue_change_pct === "number" && Number.isFinite(r.revenue_change_pct)
          ? r.revenue_change_pct
          : null,
      currency: typeof r.currency === "string" ? r.currency : null,
    }))
    .filter((r) => Number.isFinite(r.year))
    .sort((a, b) => a.year - b.year);
}

/** CUI + registered name per company, from `org_prefs.prefs` (production has
 *  no organizations.cui column; the commit route writes them there). One
 *  PostgREST read for the whole list; RLS limits it to my memberships. */
export async function fetchCompanyDirectory(
  orgIds: string[],
): Promise<Record<string, { cui: string | null; companyName: string | null }>> {
  const client = getSupabase();
  if (!client || orgIds.length === 0) return {};
  const { data, error } = await client
    .from("org_prefs")
    .select("org_id, cui:prefs->>cui, company_name:prefs->>company_name")
    .in("org_id", orgIds);
  if (error || !Array.isArray(data)) return {};
  const out: Record<string, { cui: string | null; companyName: string | null }> = {};
  for (const row of data as Array<{ org_id: string; cui: string | null; company_name: string | null }>) {
    out[row.org_id] = { cui: row.cui ?? null, companyName: row.company_name ?? null };
  }
  return out;
}
