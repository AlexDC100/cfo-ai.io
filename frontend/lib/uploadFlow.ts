// uploadFlow.ts — the one upload flow of the workspace redesign.
//
//   drop (anywhere) ─► identify ─► confirmation card ─► Analyse ─► commit
//                                   │  company · CUI · period · industry,
//                                   │  each with where it came from
//                                   └► Change (another of my companies, a new
//                                      one, another period or industry)
//   commit ─► queued ─► job (5 live steps) ─► done / failed
//                                              toast + bell, done opens the
//                                              analysed company's dashboard
//
// Two pieces of state, both module singletons read with useSyncExternalStore
// so the drop overlay (AppShell), the home drop zone and a company page's
// next-year tile all drive the SAME card:
//
//   · flow — the single file being confirmed right now. Not persisted: a
//     File cannot survive a reload, and a half-confirmed upload that silently
//     reappeared after one would be worse than asking again.
//   · jobs — analyses that were queued. Persisted (localStorage) so a reload
//     mid-analysis keeps its progress and still announces the result.
//
// The store is UI-free: toasts, navigation and the extra-document dialog live
// in UploadFlowHost, which reads this store and calls these actions.

import { useSyncExternalStore } from "react";

import type { DocumentStatus } from "@/lib/supabase";
import { sniffFileMismatch, type KindMismatch } from "@/lib/fileKind";
import { isAcceptedFinancialUpload } from "@/lib/uploadAccept";
import {
  commitUpload,
  identifyUpload,
  UploadApiError,
  type CommitResult,
  type ExtraDocConfirmation,
  type IdentifyResult,
} from "@/lib/uploadsApi";

// ── Types ──────────────────────────────────────────────────────────────

export type FlowPhase =
  | "idle"
  | "identifying"
  | "confirm"
  | "committing"
  | "duplicate"
  | "error"
  | "progress";

/** What the card will send on Analyse. Starts as what the document says;
 *  "Change" edits it. `edited` flips a field's source to "chosen by you". */
export interface FlowChoice {
  mode: "existing" | "new";
  /** Existing target company (mode === "existing"). */
  orgId: string | null;
  orgName: string;
  /** New company (mode === "new"). */
  newName: string;
  newCui: string | null;
  periodEnd: string | null;
  industryKey: string | null;
  industryLabel: string | null;
  edited: { company: boolean; period: boolean; industry: boolean };
}

export type FlowErrorCode = "unsupported" | "wrong_kind" | "identify" | "commit" | "refused" | "cancelled" | "cap";

export interface FlowState {
  phase: FlowPhase;
  file: File | null;
  /** The company on screen when the file was dropped (X-Org-Id). */
  onScreenOrgId: string | null;
  result: IdentifyResult | null;
  choice: FlowChoice | null;
  /** Set for phase "duplicate": the analysed period this file already backs. */
  duplicate: { documentId: string; periodId: string | null; orgId: string; companyName: string } | null;
  error: {
    code: FlowErrorCode;
    message: string | null;
    kind?: KindMismatch;
    /** code "cap": the plan and the number of companies it allows. */
    cap?: { plan: string; count: number };
  } | null;
  /** Phase "progress": the job this card is following. */
  jobDocId: string | null;
  /** More than one file was dropped; the card took the first. */
  extraFilesIgnored: number;
}

export interface AnalysisJob {
  docId: string;
  orgId: string;
  companyName: string;
  filename: string;
  status: DocumentStatus;
  periodId: string | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
  /** True once the host has announced the terminal state (toast + bell). */
  announced: boolean;
  /** The 0-based step the document was on when its status turned `failed`
   *  — the last live status it reported (queued → 0 … narrating → 4). The
   *  card marks THAT step as failed and keeps the earlier ones done; it
   *  used to reset to step 1 for every failure. Null while not failed (and
   *  on a job persisted before this field existed → step 1). */
  failedStep: number | null;
}

const IDLE: FlowState = {
  phase: "idle",
  file: null,
  onScreenOrgId: null,
  result: null,
  choice: null,
  duplicate: null,
  error: null,
  jobDocId: null,
  extraFilesIgnored: 0,
};

// ── The five steps ─────────────────────────────────────────────────────
// The pipeline reports queued → extracting → mapping → computing → narrating
// → analyzed (the same statuses ScanProgressView maps for trial balances).
// Step i is done once the ordinal passes it; the step AT the ordinal is the
// one running now.

export const ANALYSIS_STEP_COUNT = 5;

const STATUS_ORDINAL: Record<DocumentStatus, number> = {
  queued: 0,
  extracting: 1,
  mapping: 2,
  computing: 3,
  narrating: 4,
  analyzed: 5,
  failed: 0,
};

/** 0-based index of the running step (5 = all done). */
export function stepOrdinal(status: DocumentStatus): number {
  return STATUS_ORDINAL[status] ?? 0;
}

export function isJobDone(job: Pick<AnalysisJob, "status">): boolean {
  return job.status === "analyzed" || job.status === "failed";
}

// ── Flow store ─────────────────────────────────────────────────────────

let flow: FlowState = IDLE;
// Every async step captures the token current when it started; a result that
// comes back after the user dropped another file (or closed the card) is
// dropped instead of overwriting the newer flow.
let token = 0;

const flowListeners = new Set<() => void>();
function setFlow(next: FlowState): void {
  flow = next;
  flowListeners.forEach((l) => l());
}
function subscribeFlow(cb: () => void): () => void {
  flowListeners.add(cb);
  return () => {
    flowListeners.delete(cb);
  };
}

export function useUploadFlow(): FlowState {
  return useSyncExternalStore(subscribeFlow, () => flow, () => IDLE);
}

export function readUploadFlow(): FlowState {
  return flow;
}

/** The choice the card starts from — what the document itself says. */
export function defaultChoice(result: IdentifyResult): FlowChoice {
  const { identity, target } = result;
  const isNew = target.is_new || !target.org_id;
  return {
    mode: isNew ? "new" : "existing",
    orgId: isNew ? null : target.org_id,
    orgName: target.name ?? identity.company_name ?? "",
    newName: identity.company_name ?? target.name ?? "",
    newCui: identity.cui,
    periodEnd: identity.period_end,
    industryKey: identity.industry_key,
    industryLabel: identity.industry_label,
    edited: { company: false, period: false, industry: false },
  };
}

/** The name the card and the progress line use for the target company. */
export function choiceCompanyName(choice: FlowChoice | null): string {
  if (!choice) return "";
  return (choice.mode === "new" ? choice.newName : choice.orgName).trim();
}

/** Why Analyse is not available yet, or null when it is. */
export function analyseBlocker(choice: FlowChoice | null): "period" | "company" | null {
  if (!choice) return "company";
  if (choice.mode === "new" ? !choice.newName.trim() : !choice.orgId) return "company";
  if (!choice.periodEnd) return "period";
  return null;
}

/**
 * Start the flow for a drop or a pick. Only the first file is taken — the
 * card confirms one document at a time. Replaces a flow that is still being
 * confirmed; ignored while a commit is in flight (a second commit racing the
 * first would be the one way to store a file twice from this screen).
 */
export async function startUploadFlow(
  files: File[] | FileList | null | undefined,
  onScreenOrgId: string | null,
): Promise<void> {
  const list = files ? Array.from(files) : [];
  const file = list[0];
  if (!file) return;
  if (flow.phase === "committing") return;

  const my = ++token;
  const base: FlowState = {
    ...IDLE,
    file,
    onScreenOrgId,
    extraFilesIgnored: Math.max(0, list.length - 1),
  };
  // Drag-and-drop bypasses the input's `accept`, so the extension is
  // re-checked against the same list every financial upload uses.
  if (!isAcceptedFinancialUpload(file.name)) {
    setFlow({ ...base, phase: "error", error: { code: "unsupported", message: null } });
    return;
  }
  setFlow({ ...base, phase: "identifying" });
  // The real type, from the bytes: a Word document renamed .pdf is told so
  // here and never leaves the browser (lib/fileKind).
  const mismatch = await sniffFileMismatch(file);
  if (my !== token) return;
  if (mismatch) {
    setFlow({ ...base, phase: "error", error: { code: "wrong_kind", message: null, kind: mismatch } });
    return;
  }
  try {
    const result = await identifyUpload(file, onScreenOrgId);
    if (my !== token) return;
    if (result.duplicate) {
      const dupOrg =
        result.companies.find((c) => c.org_id === result.duplicate!.org_id)?.name ??
        (result.target.org_id === result.duplicate.org_id ? result.target.name : null) ??
        result.identity.company_name ??
        "";
      setFlow({
        ...base,
        phase: "duplicate",
        result,
        choice: defaultChoice(result),
        duplicate: {
          documentId: result.duplicate.document_id,
          periodId: result.duplicate.period_id,
          orgId: result.duplicate.org_id,
          companyName: dupOrg,
        },
      });
      return;
    }
    setFlow({ ...base, phase: "confirm", result, choice: defaultChoice(result) });
  } catch (err) {
    if (my !== token) return;
    setFlow({
      ...base,
      phase: "error",
      error: { code: "identify", message: err instanceof Error ? err.message : null },
    });
  }
}

/** Retry the identify step for the file already in the card. */
export function retryIdentify(): void {
  const { file, onScreenOrgId } = flow;
  if (file) void startUploadFlow([file], onScreenOrgId);
}

export function updateChoice(patch: Partial<FlowChoice>): void {
  if (!flow.choice) return;
  setFlow({ ...flow, choice: { ...flow.choice, ...patch, edited: { ...flow.choice.edited, ...patch.edited } } });
}

/** Close the card. A running analysis keeps going (its job is separate). */
export function closeUploadFlow(): void {
  token++;
  setFlow(IDLE);
}

/** Reopen the card on a job (the floating progress chip does this). */
export function showJobInFlow(docId: string): void {
  if (flow.phase === "committing") return;
  token++;
  setFlow({ ...IDLE, phase: "progress", jobDocId: docId });
}

export type AnalyseOutcome =
  | {
      kind: "queued";
      docId: string;
      orgId: string;
      companyName: string;
      created: boolean;
      /** The user's empty workspace became the company (renamed). */
      adopted: boolean;
    }
  /** The plan asks first (402); nothing was stored. Confirm, then Analyse again. */
  | { kind: "needs_confirmation"; confirmation: ExtraDocConfirmation }
  /** A new company would pass the plan's company cap (402); nothing was
   *  stored. The card says so and offers the upgrade or an existing company. */
  | { kind: "cap_reached" }
  | { kind: "duplicate" }
  | { kind: "refused" }
  | { kind: "failed" }
  | { kind: "blocked" };

/** Send the confirmed choice. The host turns a `queued` outcome into a job
 *  (trackJob) and switches the screen to the target company. */
export async function analyseUpload(opts: { confirmExtra?: boolean } = {}): Promise<AnalyseOutcome> {
  const { file, choice, onScreenOrgId, result } = flow;
  if (!file || !choice || flow.phase !== "confirm") return { kind: "blocked" };
  if (analyseBlocker(choice)) return { kind: "blocked" };
  const my = ++token;
  setFlow({ ...flow, phase: "committing", error: null });
  const created = choice.mode === "new";
  let res: CommitResult;
  try {
    res = await commitUpload({
      file,
      onScreenOrgId,
      periodEnd: choice.periodEnd as string,
      industryKey: choice.industryKey,
      ...(opts.confirmExtra ? { confirmExtra: true } : {}),
      targetOrgId: created ? null : choice.orgId,
      createCompany: created
        ? {
            name: choice.newName.trim(),
            cui: choice.newCui,
            caen_code: result?.identity.caen_code ?? null,
            industry_key: choice.industryKey,
          }
        : null,
    });
  } catch (err) {
    if (my === token) {
      setFlow({
        ...flow,
        phase: "confirm",
        error: {
          code: "commit",
          message: err instanceof UploadApiError || err instanceof Error ? err.message : null,
        },
      });
    }
    return { kind: "failed" };
  }
  if (my !== token) return { kind: "failed" };

  if (res.status === "duplicate") {
    const name =
      res.company_name ??
      result?.companies.find((c) => c.org_id === res.org_id)?.name ??
      choiceCompanyName(choice);
    setFlow({
      ...flow,
      phase: "duplicate",
      duplicate: { documentId: res.document_id, periodId: res.period_id, orgId: res.org_id, companyName: name },
    });
    return { kind: "duplicate" };
  }
  if (res.status === "refused") {
    setFlow({ ...flow, phase: "confirm", error: { code: "refused", message: res.message } });
    return { kind: "refused" };
  }
  if (res.status === "needs_confirmation") {
    // Back to the card, choice intact: the dialog asks, and a confirmed
    // answer sends the same commit again.
    setFlow({ ...flow, phase: "confirm", error: null });
    return { kind: "needs_confirmation", confirmation: res.confirmation };
  }
  if (res.status === "cap_reached") {
    // Back to the card, choice intact: it says how many companies the plan
    // allows — never "We couldn't save the file" — with the upgrade and the
    // choice of one of the user's companies.
    setFlow({
      ...flow,
      phase: "confirm",
      error: { code: "cap", message: null, cap: { plan: res.plan, count: res.cap } },
    });
    return { kind: "cap_reached" };
  }
  return {
    kind: "queued",
    docId: res.document_id,
    orgId: res.org_id,
    companyName: res.company_name || choiceCompanyName(choice),
    // The engine says whether it made a company (a "new" CUI it already
    // holds is reused, not duplicated; an empty workspace is adopted, not
    // duplicated); the choice is the fallback.
    created: res.adopted_company ? false : res.created_company ?? created,
    adopted: res.adopted_company === true,
  };
}

/** The card moves on to following `docId` (after a queued commit). */
export function followJob(docId: string): void {
  token++;
  setFlow({ ...IDLE, phase: "progress", jobDocId: docId });
}

/** Back to the confirmation card with a message (e.g. the extra-document
 *  dialog was dismissed — nothing ran, the choice is still on screen). */
export function returnToConfirm(error: { code: FlowErrorCode; message: string | null } | null): void {
  if (!flow.file || !flow.choice) {
    setFlow(IDLE);
    return;
  }
  setFlow({ ...flow, phase: "confirm", error });
}

// ── Jobs store ─────────────────────────────────────────────────────────

export const JOBS_STORAGE_KEY = "cfo-analysis-jobs-v1";
const IN_FLIGHT_MAX_AGE_MS = 30 * 60 * 1000;
const DONE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let jobs: AnalysisJob[] | null = null;
const jobListeners = new Set<() => void>();

function readJobs(): AnalysisJob[] {
  if (jobs) return jobs;
  try {
    const raw = localStorage.getItem(JOBS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    const now = Date.now();
    jobs = (Array.isArray(parsed) ? parsed : [])
      .filter((j): j is AnalysisJob => !!j && typeof (j as AnalysisJob).docId === "string")
      .filter((j) => {
        const age = now - (j.updatedAt ?? j.startedAt ?? 0);
        return isJobDone(j) ? age < DONE_MAX_AGE_MS : age < IN_FLIGHT_MAX_AGE_MS;
      });
  } catch {
    jobs = [];
  }
  return jobs;
}

function writeJobs(next: AnalysisJob[]): void {
  jobs = next;
  try {
    localStorage.setItem(JOBS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode — progress still works in memory */
  }
  jobListeners.forEach((l) => l());
}

function subscribeJobs(cb: () => void): () => void {
  jobListeners.add(cb);
  return () => {
    jobListeners.delete(cb);
  };
}

const NO_JOBS: AnalysisJob[] = [];

export function useAnalysisJobs(): AnalysisJob[] {
  return useSyncExternalStore(subscribeJobs, readJobs, () => NO_JOBS);
}

export function readAnalysisJobs(): AnalysisJob[] {
  return readJobs();
}

export function addJob(job: Omit<AnalysisJob, "startedAt" | "updatedAt" | "announced" | "status" | "periodId" | "error" | "failedStep"> & { status?: DocumentStatus }): AnalysisJob {
  const now = Date.now();
  const next: AnalysisJob = {
    ...job,
    status: job.status ?? "queued",
    periodId: null,
    error: null,
    startedAt: now,
    updatedAt: now,
    announced: false,
    failedStep: null,
  };
  writeJobs([next, ...readJobs().filter((j) => j.docId !== job.docId)].slice(0, 12));
  return next;
}

export function patchJob(docId: string, patch: Partial<Omit<AnalysisJob, "docId" | "startedAt">>): void {
  const list = readJobs();
  const i = list.findIndex((j) => j.docId === docId);
  if (i < 0) return;
  const cur = list[i]!;
  const next: AnalysisJob = { ...cur, ...patch, updatedAt: Date.now() };
  // A status never walks backwards: a late poll answering "extracting" after
  // the socket already said "computing" must not rewind the steps on screen.
  if (
    patch.status &&
    !isJobDone({ status: patch.status }) &&
    stepOrdinal(patch.status) < stepOrdinal(cur.status)
  ) {
    next.status = cur.status;
  }
  // The failure lands on the step the document was on: the last live
  // status it reported names it (a document that failed while "computing"
  // failed at step 4, with steps 1-3 done).
  if (patch.status === "failed" && !isJobDone(cur)) {
    next.failedStep = stepOrdinal(cur.status);
  }
  const copy = list.slice();
  copy[i] = next;
  writeJobs(copy);
}

export function removeJob(docId: string): void {
  writeJobs(readJobs().filter((j) => j.docId !== docId));
}

/** Test-only: reset both stores. */
export function __resetUploadFlowForTest(): void {
  token++;
  flow = IDLE;
  jobs = [];
  try {
    localStorage.removeItem(JOBS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  flowListeners.forEach((l) => l());
  jobListeners.forEach((l) => l());
}
