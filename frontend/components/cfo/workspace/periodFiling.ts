// periodFiling.ts — how a period knows which month it belongs to, and
// how a person corrects it.
//
// WHAT THIS READS, AND WHY IT DOESN'T COMPUTE
// -------------------------------------------
// `stage_persist` stamps a PERIOD-DETECTION RECORD onto every envelope it
// writes: which signal actually decided the period's identity, what the
// document's own evidence said, and whether the two disagree. This module
// reads that record and never re-derives a verdict. The distinction is
// load-bearing — a UI that recomputed detection would be answering a
// question about a row it did not write, and could disagree with the
// engine while looking authoritative.
//
// `period_detection` is `null` on every period written before 2026-08-30.
// That is ABSENCE, not "no mismatch": callers must render nothing there.
// `hasVerdict()` is the guard.
//
// WHY ITS OWN FETCHER
// -------------------
// The workspace list comes from `fetchWorkspacePeriodsDirect` (a direct
// Supabase read, because the engine feed deliberately hides doc-less
// periods and the settings tab manages containers, not analyses). That
// reader selects a narrow column set and is shared with other surfaces,
// so this module fetches the two facts it needs — the detection record
// and the period's declared analysis source — from the engine feed under
// its own query key, and joins by period_id. Periods with no documents
// have neither fact, so nothing is lost by the join.

import { useQuery } from "@tanstack/react-query";

import { getSupabase } from "@/lib/supabase";

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

// ── the engine's shapes ──────────────────────────────────────────────────

/** What the hint-free detection service found in the document itself. */
export interface DetectedPeriod {
  proposed_period_end: string | null;
  confidence: number;
  signal_used: "in_document" | "closing_balance" | "filename" | "none";
  evidence_snippet: string | null;
  candidates: Array<{
    signal: string;
    period_end: string;
    evidence_snippet: string;
  }>;
}

/** Ground truth, written at persist time: what decided this period's date. */
export interface PeriodDetection {
  resolved_period_end: string | null;
  signal_used:
    | "user_confirmed"
    | "in_document"
    | "closing_balance"
    | "filename"
    | "fallback_today";
  confidence: number;
  evidence_snippet: string | null;
  hint: string | null;
  detected: DetectedPeriod | null;
  /** Written by the engine. Read it; never recompute it. */
  mismatch: boolean;
}

export interface PeriodFilingFacts {
  period_id: string;
  period_end: string | null;
  /** The document the period's numbers are read from, as the engine
   *  declares it. `null` on legacy rows — fall back, never invent. */
  source_document_id: string | null;
  period_detection: PeriodDetection | null;
}

export type FilingIndex = Record<string, PeriodFilingFacts | undefined>;

// ── read ─────────────────────────────────────────────────────────────────

async function authHeaders(orgId: string): Promise<Record<string, string> | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, "X-Org-Id": orgId };
}

export async function fetchPeriodFiling(orgId: string): Promise<FilingIndex> {
  const headers = await authHeaders(orgId);
  if (!headers) return {};
  const res = await fetch(`${API_URL}/api/org/periods-with-documents`, { headers });
  if (!res.ok) return {};
  const payload = (await res.json()) as {
    periods?: Array<Record<string, unknown>>;
  };
  const index: FilingIndex = {};
  for (const row of payload.periods ?? []) {
    const id = row.period_id as string | undefined;
    if (!id) continue;
    index[id] = {
      period_id: id,
      period_end: (row.period_end as string | null) ?? null,
      source_document_id: (row.source_document_id as string | null) ?? null,
      period_detection: (row.period_detection as PeriodDetection | null) ?? null,
    };
  }
  return index;
}

export function usePeriodFiling(orgId: string) {
  return useQuery({
    queryKey: ["period-filing", orgId],
    queryFn: () => fetchPeriodFiling(orgId),
    enabled: !!orgId,
    staleTime: 60_000,
  });
}

// ── reading the record ───────────────────────────────────────────────────

/** True when the engine recorded a verdict for this period at all. A
 *  period written before the detection stamp shipped has none, and the
 *  honest render for it is nothing — not a reassuring "no problem". */
export function hasVerdict(facts: PeriodFilingFacts | undefined): boolean {
  return !!facts?.period_detection;
}

/** The period disagrees with its own document's evidence. Straight off
 *  the engine's `mismatch` flag. */
export function isMismatch(facts: PeriodFilingFacts | undefined): boolean {
  return !!facts?.period_detection?.mismatch;
}

/** Filed under the upload day because nothing was known. Its own state —
 *  not a mismatch (there is nothing to disagree with) but still a period
 *  whose date no one has ever confirmed. */
export function isUnconfirmed(facts: PeriodFilingFacts | undefined): boolean {
  return facts?.period_detection?.signal_used === "fallback_today";
}

export function needsAttention(facts: PeriodFilingFacts | undefined): boolean {
  return isMismatch(facts) || isUnconfirmed(facts);
}

/** What the document itself pointed at, or null when it said nothing. */
export function detectedPeriodEnd(facts: PeriodFilingFacts | undefined): string | null {
  return facts?.period_detection?.detected?.proposed_period_end ?? null;
}

/** The one document a period's detection record describes: the analysis
 *  source. The record is stamped from the envelope, and the envelope is
 *  built from exactly one document, so attributing it to any other
 *  attached file would be a fabrication. */
export function verdictAppliesTo(
  facts: PeriodFilingFacts | undefined,
  documentId: string,
): boolean {
  return !!facts?.source_document_id && facts.source_document_id === documentId;
}

/** Which document is the period's ANALYSIS SOURCE.
 *
 *  Prefers the engine's declared pointer over any client-side heuristic:
 *  the old "most recently analyzed" guess silently picked a winner on a
 *  period holding two companies' files, which is one half of the bug this
 *  lane exists to fix. `fallback` is used only when the engine has not
 *  declared one (legacy rows) — and callers should say so rather than
 *  present a guess as a fact. */
export function resolveSourceDocumentId(
  facts: PeriodFilingFacts | undefined,
  liveDocumentIds: readonly string[],
  fallback: string | null,
): { id: string | null; declared: boolean } {
  const declared = facts?.source_document_id ?? null;
  if (declared && liveDocumentIds.includes(declared)) {
    return { id: declared, declared: true };
  }
  return { id: fallback, declared: false };
}

// ── write: the correction path ───────────────────────────────────────────

export interface MoveResult {
  ok: boolean;
  moved: boolean;
  document_id: string;
  period_end_hint: string | null;
  from: { period_id: string | null; period_end: string | null; action: string };
  to: { period_end: string; period_id: string | null };
  rebuild_document_id: string | null;
  /** W4's verdict on the move that just ran. Always expected empty; a
   *  non-empty list is a real defect and the UI says so. */
  orphaned_after: unknown[];
}

export interface MakeSourceResult {
  changed: boolean;
  document_id: string;
  period_id: string;
  period_end: string | null;
  requeue_document_id: string | null;
  orphaned_after: unknown[];
}

async function post<T>(path: string, orgId: string, body?: unknown): Promise<T> {
  const headers = await authHeaders(orgId);
  if (!headers) throw new Error("Not signed in.");
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const detail = (await res.json()) as { detail?: unknown };
      if (typeof detail.detail === "string") message = detail.detail;
      else if (detail.detail && typeof detail.detail === "object") {
        message =
          ((detail.detail as { message?: string }).message as string) ?? message;
      }
    } catch {
      /* keep the status code */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/** Re-file one document under a month the user just confirmed for it.
 *
 *  `periodEnd` must come from the user's own choice against the file —
 *  never from the period row the file happens to be sitting in. Writing
 *  a drop target's date into this channel is the original bug. */
export function moveDocumentToPeriod(
  orgId: string,
  documentId: string,
  periodEnd: string,
): Promise<MoveResult> {
  return post<MoveResult>(
    `/api/documents/${encodeURIComponent(documentId)}/move-period`,
    orgId,
    { period_end: periodEnd },
  );
}

/** Make this document the period's analysis source; the others stay
 *  attached as attachments. */
export function makeDocumentSource(
  orgId: string,
  documentId: string,
): Promise<MakeSourceResult> {
  return post<MakeSourceResult>(
    `/api/documents/${encodeURIComponent(documentId)}/make-active`,
    orgId,
  );
}

/** The outcome of asking the engine about a file's own month.
 *
 *  "The engine answered, and the answer was nothing" and "we never got an
 *  answer" are DIFFERENT, and collapsing them is the same class of error
 *  this lane exists to fix: it states a fact about a document
 *  ("this file doesn't say which month it covers") on the strength of
 *  something that never came off the document. */
export type DetectOutcome =
  | { kind: "answered"; detection: DetectedPeriod }
  | { kind: "unavailable" };

/** Ask the engine what the FILE ITSELF says about its month.
 *
 *  Stateless and hint-free by construction (`detect_period` accepts only
 *  the document's own evidence — there is no parameter through which the
 *  open period could reach it). Used to ground the move dialog so the
 *  user confirms a date that came off the document rather than off the
 *  screen. */
export async function detectPeriodForFilename(
  orgId: string,
  filename: string,
): Promise<DetectOutcome> {
  const headers = await authHeaders(orgId);
  if (!headers) return { kind: "unavailable" };
  const url = `${API_URL}/api/period/detect?filename=${encodeURIComponent(filename)}`;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return { kind: "unavailable" };
    return { kind: "answered", detection: (await res.json()) as DetectedPeriod };
  } catch {
    return { kind: "unavailable" };
  }
}
