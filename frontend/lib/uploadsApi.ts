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

/** Why the file lands where it does. `adopt_empty_workspace`: the company is
 *  new, and the user's empty, CUI-less workspace becomes it (a new account's
 *  first balance) — no second workspace is created. */
export type TargetReason = "cui_match" | "on_screen_company" | "new_cui" | "adopt_empty_workspace";

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
  /** The user answered the plan's extra-document question (a 402 from this
   *  route) with Confirm: the engine grants the extra to the document this
   *  commit stores — one confirmation, one document. */
  confirmExtra?: boolean;
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
      /** True when the user's empty workspace became the company. */
      adopted_company?: boolean;
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
  /** 402 `workspace_cap_reached` — a NEW company would pass the plan's
   *  company cap (the `create_workspace` SQL floor). Nothing was stored; the
   *  card says how many companies the plan allows and offers the upgrade or
   *  one of the user's companies. */
  | { status: "cap_reached"; plan: string; cap: number; message: string }
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
  /** What `revenue` is, as the engine labels it: NET TURNOVER (70x − 709)
   *  — the one-EBITDA ruling's denominator for every margin and growth.
   *  Null when the route serves no label (an older engine). */
  basis?: { ro: string; en: string } | null;
}

export class UploadApiError extends Error {
  readonly httpStatus: number;
  /** The engine's own `detail.code`, when it gave one ("format_mismatch",
   *  "empty_file", …) — the card reads it to tell a file no reader opens
   *  (final: the engine's sentence, no retry) from a failed request. */
  readonly code: string | null;
  constructor(message: string, httpStatus: number, code: string | null = null) {
    super(message);
    this.name = "UploadApiError";
    this.httpStatus = httpStatus;
    this.code = code;
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

/** The engine's `detail.code` of a FastAPI error body, or null. */
export function errorCodeFrom(body: unknown): string | null {
  const d = asRecord(asRecord(body)?.detail);
  return d && typeof d.code === "string" && d.code ? d.code : null;
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
  // A file no reader opens is refused HERE, by the engine's one upload
  // policy (`_upload_type`), in a sentence the card prints verbatim — so
  // the engine is told which language the card is read in.
  form.append("output_language", outputLanguage());
  const res = await fetch(`${API_URL}/api/uploads/identify`, {
    method: "POST",
    headers,
    body: form,
  });
  const body = await readJson(res);
  if (!res.ok) throw new UploadApiError(errorMessageFrom(body, res.status), res.status, errorCodeFrom(body));
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
        reason === "cui_match" || reason === "on_screen_company" || reason === "new_cui" || reason === "adopt_empty_workspace"
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
  if (input.confirmExtra) form.append("confirm_extra", "1");
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
        ...(typeof rec.adopted_company === "boolean" ? { adopted_company: rec.adopted_company } : {}),
      };
    }
    throw new UploadApiError("malformed_commit", 502);
  }

  // Typed refusals first — a non-RO document on a plan without it. The
  // message is the refusal CODE's sentence in the reader's language
  // (lib/uploadRefusals), never the server's plan-named one.
  const nonRo = parseUploadRefusal(body);
  if (nonRo) return { status: "refused", message: nonRo.message, httpStatus: res.status };

  if (res.status === 402) {
    const d = asRecord(rec?.detail) ?? rec ?? {};
    if (d.code === "workspace_cap_reached" && typeof d.cap === "number" && Number.isFinite(d.cap)) {
      return {
        status: "cap_reached",
        plan: typeof d.plan === "string" ? d.plan : "",
        cap: d.cap,
        message: typeof d.message === "string" ? d.message : "",
      };
    }
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

/** The first finite number of two served spellings of one figure. */
function finiteOr(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && Number.isFinite(a)) return a;
  if (typeof b === "number" && Number.isFinite(b)) return b;
  return null;
}

function basisOf(v: unknown): { ro: string; en: string } | null {
  const r = asRecord(v);
  return r && typeof r.ro === "string" && typeof r.en === "string" ? { ro: r.ro, en: r.en } : null;
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
      // Net turnover and its growth — the served `turnover` fields first
      // (the `revenue` names are the same two figures, kept for older
      // engines).
      revenue: finiteOr(r.turnover, r.revenue),
      revenue_change_pct: finiteOr(r.turnover_change_pct, r.revenue_change_pct),
      currency: typeof r.currency === "string" ? r.currency : null,
      basis: basisOf(r.basis),
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
