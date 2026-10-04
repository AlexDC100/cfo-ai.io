// rerunRefusals.ts — why "Re-run analysis" was refused, in words.
//
// `POST /api/pipeline/retry` refuses a re-run that would replace the analysis
// of a period which is not the document's own (src/engine/api/pipeline.py
// `_own_periods_for_rerun`, gate rerun-data-loss). It answers with a CODE and
// nothing else — no sentence, no period id, no document id:
//
//     409 {"detail": {"code": "document_superseded"}}
//     409 {"detail": {"code": "rerun_period_not_own"}}
//     503 {"detail": {"code": "rerun_unavailable"}}
//
// Before 2026-10-04 the Docs panel discarded the body of every failed retry
// and said only "Couldn't start re-run" — and the server, which did not
// refuse, deleted the newer upload's month. Now the reader is told what
// happened and what to do, in their language, from the code alone (the
// pattern of lib/comparisonRefusal.ts and lib/uploadRefusals.ts). Whatever
// else a body carries is never printed.
//
// "Upload it again" is the one action named: the upload stages beside the
// month and replaces it only once its analysis has succeeded. "Make source"
// is NOT named — it empties the month's analysis before its own re-run.
//
// Statically imported (never behind a lazy import: a module on an error path
// that is its own chunk 404s in a tab older than the last deploy — §24).

/** The refusal codes of POST /api/pipeline/retry. */
export const RERUN_REFUSAL_CODES = [
  "document_superseded",
  "rerun_period_not_own",
  "rerun_unavailable",
] as const;
export type RerunRefusalCode = (typeof RERUN_REFUSAL_CODES)[number];

/** The i18n key of the sentence for a refusal code. */
export function rerunRefusalKey(code: RerunRefusalCode): string {
  switch (code) {
    case "document_superseded":
      return "panels.rerunSuperseded";
    case "rerun_period_not_own":
      return "panels.rerunPeriodNotOwn";
    case "rerun_unavailable":
      return "panels.rerunUnavailable";
  }
}

/** The same sentences in English, for a caller without i18next (a unit
 *  test, a module read before app boot). Held equal to en.json by
 *  lib/__tests__/rerunRefusals.test.ts. */
export const RERUN_REFUSAL_ENGLISH: Readonly<Record<string, string>> = {
  "panels.rerunSuperseded":
    "Another upload has replaced this file for its month, so it was not re-analysed and the month was not changed. To use this file for the month again, upload it again.",
  "panels.rerunPeriodNotOwn":
    "This file isn't linked to an analysis of its own, so it was not re-analysed and nothing was changed. To analyse it, upload the file again.",
  "panels.rerunUnavailable":
    "We couldn't read this file's analysis just now, so the re-run didn't start. Nothing was changed — try again in a moment.",
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** The refusal code of an already-parsed response body — under FastAPI's
 *  `detail` envelope or bare — when it is one of the known codes; else null.
 *  Reads the CODE only. Never throws. */
export function rerunRefusalCode(body: unknown): RerunRefusalCode | null {
  const outer = asRecord(body);
  if (!outer) return null;
  const code = (asRecord(outer.detail) ?? outer).code;
  return typeof code === "string" && (RERUN_REFUSAL_CODES as readonly string[]).includes(code)
    ? (code as RerunRefusalCode)
    : null;
}

// ── A re-run that was accepted and did not finish ───────────────────────
//
// Since 2026-10-04 "Re-run analysis" is STAGED beside the file's own month:
// the month keeps being served while the run goes, and a run that fails
// leaves the file `analyzed` over the analysis it had. Nothing on the row
// would say a re-run had been tried — so the engine stores
//
//     documents.error = "rerun_failed: <remainder>"
//
// (src/engine/api/pipeline.py RERUN_FAILED_PREFIX; the row keeps its status).
// The remainder is one of two codes, or the run's own diagnostic text — which
// is NEVER printed: the reader gets one of three sentences, by KIND. (A third
// code, `rerun_not_a_trial_balance` — the file now reads as a public-records
// summary and the re-run was refused before any write — has no sentence of
// its own: the previous analysis is still the one served, the `kept` line.)

/** `documents.error` begins with this when the file's last re-run did not
 *  finish. The same literal as pipeline.RERUN_FAILED_PREFIX. */
export const RERUN_FAILED_PREFIX = "rerun_failed: ";

/** What the remainder says. */
export const RERUN_FAILED_KINDS = ["interrupted", "month_taken", "kept"] as const;
export type RerunFailedKind = (typeof RERUN_FAILED_KINDS)[number];

/** The kind of a stored `documents.error` that a staged re-run wrote, else
 *  null. `interrupted`: the run died while it was replacing the analysis —
 *  the month may be mid-replacement until the next re-run completes it.
 *  `month_taken`: the file now reads as a month that has its own analysis.
 *  `kept`: anything else — the previous analysis is still the one served. */
export function rerunFailedKind(error: string | null | undefined): RerunFailedKind | null {
  if (typeof error !== "string" || !error.startsWith(RERUN_FAILED_PREFIX)) return null;
  const remainder = error.slice(RERUN_FAILED_PREFIX.length).trim();
  if (remainder === "interrupted_replacing") return "interrupted";
  if (remainder === "rerun_month_taken") return "month_taken";
  return "kept";
}

/** What follows the prefix — for a caller that looks for a known CODE in it
 *  (a plan refusal, lib/uploadRefusals). Never for printing. */
export function rerunFailedRemainder(error: string | null | undefined): string | null {
  return rerunFailedKind(error) === null ? null : (error as string).slice(RERUN_FAILED_PREFIX.length);
}

/** The i18n key of the sentence for a kind. */
export function rerunFailedKey(kind: RerunFailedKind): string {
  switch (kind) {
    case "interrupted":
      return "panels.rerunInterrupted";
    case "month_taken":
      return "panels.rerunMonthTaken";
    case "kept":
      return "panels.rerunFailedKept";
  }
}

/** The same sentences in English (see RERUN_REFUSAL_ENGLISH). */
export const RERUN_FAILED_ENGLISH: Readonly<Record<string, string>> = {
  "panels.rerunInterrupted":
    "The last re-run was interrupted while it was replacing the analysis. Run it again.",
  "panels.rerunMonthTaken":
    "The last re-run was not applied: the file now reads as a month that already has its own analysis. Nothing was changed.",
  "panels.rerunFailedKept":
    "The last re-run didn't finish. You're still seeing the previous analysis.",
};
