// rerunRefusals.ts — why "Re-run analysis" was refused, in words.
//
// `POST /api/pipeline/retry` refuses a re-run that would reset a period which
// is not the document's own (src/engine/api/pipeline.py
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
