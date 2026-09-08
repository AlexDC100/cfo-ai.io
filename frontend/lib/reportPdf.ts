// THE PDF EXPORT — the browser half.
//
// The Export tab already builds the whole report as a standalone HTML
// document (`financialExports.ts::buildReportHtml`). This module takes
// THAT STRING, posts it to the engine, and collects an A4 PDF of it.
//
// ── WHY THE HTML TRAVELS ──────────────────────────────────────────────
//
// Because it is the only way the PDF and the HTML cannot disagree. The
// alternative — the server rebuilding the report from the envelope —
// means two implementations of every ratio ladder, every insight
// sentence and every chart, in two languages, and the export laws for
// this product say a figure that differs between formats IS the defect.
// Sending the document itself makes format parity structural. It costs
// ~190 KB on the wire, once, per export.
//
// ── WHY IT IS ASYNCHRONOUS ────────────────────────────────────────────
//
// A render is ~300 ms on an idle renderer and unbounded on a busy one,
// because the sidecar renders at most `PDF_CONCURRENCY` documents at
// once and queues the rest. A synchronous request would hold a
// connection open through someone else's queue and time out at a proxy
// nobody in this codebase controls. So: POST returns a job, the client
// polls, and the wait has a STATE the UI can show instead of a spinner
// that says nothing.
//
// ── WHAT THIS MODULE DELIBERATELY DOES NOT DECIDE ─────────────────────
//
// The wording. `RenderState` is a machine-readable enum and
// `queuePosition` / `pages` are numbers; the server's own `progress`
// sentence is passed through as `serverProgress` for a caller with
// nothing better, but the user-facing copy — and its Romanian — belongs
// to the UI layer, not here.
//
// The filename, either. The service computes it and returns it, and
// this module uses that string verbatim. Deriving it a second time on
// the client is how the `Content-Disposition` header and the saved file
// come to disagree about the same download.

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

export type RenderState = "queued" | "rendering" | "done" | "failed";

export interface RenderProgress {
  state: RenderState;
  /** Present once the renderer has finished and counted its own output. */
  pages: number | null;
  /** Present once the service has named the file. */
  filename: string | null;
  /** How many jobs are ahead of this one, when the service said so. */
  queuePosition: number | null;
  /** The service's own sentence. A fallback for a caller with no copy
   *  of its own — never the primary source of user-facing wording. */
  serverProgress: string;
  /** Set only in the `failed` state. */
  error: string | null;
}

export interface ReportPdfMeta {
  company: string;
  period: string;
}

export interface RequestPdfOptions {
  /** Called on every poll, including the first. */
  onProgress?: (p: RenderProgress) => void;
  /** Give up after this long. Default 3 minutes — long enough for a
   *  queue, short enough that a wedged renderer does not hold a tab. */
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface ReportPdf {
  blob: Blob;
  filename: string;
  pages: number | null;
}

/**
 * The auth headers every call here carries.
 *
 * `cfoApi.ts` has this logic in its `callUrl()` chokepoint, but that
 * function parses the response as JSON and one of the two calls below
 * returns a PDF. Rather than widen a shared function's contract for one
 * caller, the two lines are repeated here and marked — if the token
 * shape ever changes, this file is the second place to look.
 */
async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  try {
    const { getSupabase } = await import("@/lib/supabase");
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb.auth.getSession();
      const token = data.session?.access_token;
      if (token) headers.Authorization = `Bearer ${token}`;
      if (data.session?.user?.id) {
        const { currentOrgId } = await import("@/lib/supabase");
        const orgId = await currentOrgId();
        if (orgId) headers["X-Org-Id"] = orgId;
      }
    }
  } catch {
    /* supabase not loaded — the engine will answer 401 and we surface it */
  }
  return headers;
}

/** `Waiting for a renderer — 3 ahead` → 3. Absent shape → null, never 0:
 *  "we could not tell" and "you are next" are different facts. */
export function parseQueuePosition(progress: string): number | null {
  const m = /—\s*(\d+)\s+ahead/.exec(progress ?? "");
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function toProgress(body: Record<string, unknown>): RenderProgress {
  const raw = typeof body.state === "string" ? body.state : "failed";
  const state: RenderState =
    raw === "queued" || raw === "rendering" || raw === "done" || raw === "failed"
      ? raw
      : "failed";
  const serverProgress = typeof body.progress === "string" ? body.progress : "";
  return {
    state,
    pages: typeof body.pages === "number" ? body.pages : null,
    filename: typeof body.filename === "string" ? body.filename : null,
    queuePosition: parseQueuePosition(serverProgress),
    serverProgress,
    error: typeof body.error === "string" ? body.error : null,
  };
}

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    const detail = (body as { detail?: unknown })?.detail;
    if (typeof detail === "string") return detail;
  } catch {
    /* not JSON */
  }
  return `${res.status} ${res.statusText}`;
}

/**
 * Poll interval.
 *
 * Fast at first because most renders finish inside a second and a
 * two-second first poll would make a 300 ms job feel like a slow one;
 * then it backs off, because a job still running at 20 seconds is
 * queued behind something and polling it ten times a second helps
 * nobody. Deterministic — a fixed ladder, no jitter, so a test can
 * reason about it.
 */
export function pollDelayMs(attempt: number): number {
  if (attempt < 4) return 250;
  if (attempt < 10) return 600;
  return 1500;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    }
  });

/**
 * Render the report to PDF and return the bytes.
 *
 * Throws with the server's own message on refusal — including the two
 * that a user can act on: 401 (the session expired) and 503 (this
 * deployment has no renderer configured). A generic "export failed"
 * would hide both.
 */
export async function requestReportPdf(
  html: string,
  meta: ReportPdfMeta,
  options: RequestPdfOptions = {},
): Promise<ReportPdf> {
  const { onProgress, deadlineMs = 180_000, signal } = options;
  const headers = await authHeaders();

  const started = await fetch(`${API_URL}/api/report/pdf`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ html, company: meta.company, period: meta.period }),
    signal,
  });
  if (!started.ok) throw new Error(await readError(started));
  const startBody = (await started.json()) as Record<string, unknown>;
  const jobId = typeof startBody.job_id === "string" ? startBody.job_id : "";
  if (jobId === "") throw new Error("The renderer accepted the document but named no job.");

  onProgress?.(toProgress(startBody));

  const deadline = Date.now() + deadlineMs;
  let attempt = 0;
  // The last state seen, so a timeout can say WHAT it timed out during
  // — "still queued after 3 minutes" and "still rendering after 3
  // minutes" send an operator to different containers.
  let last: RenderProgress = toProgress(startBody);

  while (Date.now() < deadline) {
    await sleep(pollDelayMs(attempt), signal);
    attempt += 1;
    const res = await fetch(`${API_URL}/api/report/pdf/${jobId}`, { headers, signal });
    if (!res.ok) throw new Error(await readError(res));
    last = toProgress((await res.json()) as Record<string, unknown>);
    onProgress?.(last);
    if (last.state === "failed") {
      throw new Error(last.error ?? "The renderer could not produce this document.");
    }
    if (last.state === "done") {
      const file = await fetch(`${API_URL}/api/report/pdf/${jobId}/file`, { headers, signal });
      if (!file.ok) throw new Error(await readError(file));
      const blob = await file.blob();
      // The service named it; we do not rename it.
      const filename = last.filename ?? "report.pdf";
      return { blob, filename, pages: last.pages };
    }
  }
  throw new Error(
    `The PDF did not finish within ${Math.round(deadlineMs / 1000)}s — it was still ${last.state}.`,
  );
}

/**
 * Hand the file to the browser.
 *
 * Split from `requestReportPdf` so a caller can do something else with
 * the bytes (open it in a tab, attach it) without a download firing as a
 * side effect of asking for one.
 */
export function saveReportPdf(pdf: ReportPdf): void {
  const url = URL.createObjectURL(pdf.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = pdf.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next turn: revoking synchronously races the click in
  // Safari, which reads the blob after the handler returns.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
