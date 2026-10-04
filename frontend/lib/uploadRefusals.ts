// uploadRefusals.ts — the plan refusals of the upload / re-run path, in words.
//
// Owner ruling 2026-10-02: the WORKSPACE's plan gates a re-run, and a plan
// name is never written into the shared `documents.error`. The engine stores
// a NEUTRAL CODE there —
//
//     NonRoNotIncludedError: {"error": "<code>"}
//
// — and every viewer's browser renders the sentence for that code, in that
// viewer's language. So this module reads the CODE only and prints the
// sentence written for it (the pattern of lib/comparisonRefusal.ts). The
// server's `message` is never printed for a known code: before this ruling a
// stored refusal named the uploader's plan ("…aren't included in the RO Solo
// plan"), and every member of the company read it.
//
// Rows stored before the ruling still carry `plan_key` and `message`; they
// are read by their code like any other, so the old text is never shown
// either.
//
// The same codes can arrive over HTTP (bare, or wrapped in FastAPI's `detail`
// envelope, under `error` or `code`); `parseUploadRefusal` recognises the one
// that opens the dialog. That dialog is not an upgrade prompt (2026-10-01): no
// file from another country is analysed correctly today, on any plan
// (frontend/data/coverage.json), so the sentence for `non_ro_not_included`
// says "not supported yet" and sells nothing.
//
// Statically imported everywhere (lib/__tests__/uploadStoreFailedState.test.ts):
// a module on an error path is never behind a lazy import.

import i18next from "i18next";

/** The refusal codes the engine stores in `documents.error`. */
export const UPLOAD_REFUSAL_CODES = [
  "non_ro_not_included",
  "nonro_quota_exhausted",
  "metering_unavailable",
] as const;
export type UploadRefusalCode = (typeof UPLOAD_REFUSAL_CODES)[number];

/** The i18n key of the sentence for a refusal code. */
export function uploadRefusalKey(code: UploadRefusalCode): string {
  switch (code) {
    case "non_ro_not_included":
      return "pricing.nonRoBlockedDesc";
    case "nonro_quota_exhausted":
      return "pricing.nonRoQuotaExhausted";
    case "metering_unavailable":
      return "pricing.meteringUnavailable";
  }
}

/** The same sentences in English, for the one case i18next is not
 *  initialised (a pure unit test, a module read before app boot). Held equal
 *  to en.json by lib/__tests__/uploadRefusalCodes.test.ts. */
export const UPLOAD_REFUSAL_ENGLISH: Readonly<Record<string, string>> = {
  "pricing.nonRoBlockedDesc":
    "This looks like a document from outside Romania. Today CFO AI reads Romanian trial balances only; other countries are not supported yet, on any plan.",
  "pricing.nonRoQuotaExhausted":
    "This company has reached this month's limit for documents from outside Romania.",
  "pricing.meteringUnavailable":
    "We couldn't check the plan just now. Nothing was charged — try again in a few minutes.",
};

/** A refusal code's sentence in the viewer's language (`lng` pins one;
 *  omitted, the active UI language). Never the server's message. */
export function uploadRefusalSentence(code: UploadRefusalCode, lng?: string): string {
  const key = uploadRefusalKey(code);
  if (i18next.isInitialized) {
    const out = lng ? i18next.t(key, { lng }) : i18next.t(key);
    if (typeof out === "string" && out && out !== key) return out;
  }
  return UPLOAD_REFUSAL_ENGLISH[key];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asCode(v: unknown): UploadRefusalCode | null {
  return typeof v === "string" && (UPLOAD_REFUSAL_CODES as readonly string[]).includes(v)
    ? (v as UploadRefusalCode)
    : null;
}

/** The refusal code of an already-parsed body (bare or under `detail`,
 *  discriminated by `error` or `code`), else null. */
function codeOfBody(body: unknown): { code: UploadRefusalCode; fields: Record<string, unknown> } | null {
  const outer = asRecord(body);
  if (!outer) return null;
  // FastAPI wraps HTTPException payloads in `detail`; bare shape also valid.
  const d = asRecord(outer.detail) ?? outer;
  const code = asCode(d.error ?? d.code);
  return code ? { code, fields: d } : null;
}

export interface NonRoRefusal {
  kind: "non_ro_blocked";
  /** Tier that unlocks non-RO uploads. Defaults to "multi" per spec. */
  upgradeTo: string;
  /** The CODE's sentence in the viewer's language — never the server's
   *  message, which named the caller's plan. */
  message: string;
}

/** Inspect an error-response body (already JSON-parsed) and return the
 *  typed non-RO refusal when present, else null. Never throws. */
export function parseUploadRefusal(body: unknown): NonRoRefusal | null {
  const found = codeOfBody(body);
  if (!found || found.code !== "non_ro_not_included") return null;
  const upgradeTo = found.fields.upgrade_to;
  return {
    kind: "non_ro_blocked",
    upgradeTo: typeof upgradeTo === "string" && upgradeTo ? upgradeTo : "multi",
    message: uploadRefusalSentence("non_ro_not_included"),
  };
}

// ─────────────────────────────────────────────────────────────────────
// The stored error, read by its code.
//
// The pipeline's plan gate runs DURING processing (jurisdiction is resolved
// at the extract stage), so the refusal is persisted into `documents.error`
// and reaches the browser through the document-status subscription, the
// one-shot status read, and the engine routes that serve the row. Every
// failure surface prints that field; the two seams in lib/supabase.ts and
// the surfaces that read an API-served copy pass it through here first.
// ─────────────────────────────────────────────────────────────────────

function extractRefusalJson(err: string): unknown {
  try {
    return JSON.parse(err);
  } catch {
    // Refusal JSON embedded inside a longer error string
    // ("NonRoNotIncludedError: {…}").
    const m = err.match(/\{[^{}]*\}/s);
    if (m) {
      try { return JSON.parse(m[0]); } catch { return null; }
    }
    return null;
  }
}

/** The refusal code a stored `documents.error` carries, else null. Reads the
 *  JSON form (bare or behind a class prefix) and the bare code (alone, or
 *  behind a class prefix) — never a sentence that merely mentions a code. */
export function documentRefusalCode(err: string | null | undefined): UploadRefusalCode | null {
  if (!err || typeof err !== "string") return null;
  // Cheap pre-filter: no known code in the text, nothing to parse.
  if (!UPLOAD_REFUSAL_CODES.some((c) => err.includes(c))) return null;
  const fromJson = codeOfBody(extractRefusalJson(err));
  if (fromJson) return fromJson.code;
  const bare = err.trim().match(/^(?:[A-Za-z_][A-Za-z0-9_.]*:\s*)?["']?([a-z_]+)["']?$/);
  return bare ? asCode(bare[1]) : null;
}

/** The i18n key for a stored error that is a plan refusal, else null — for a
 *  component that prints with its own `t()` and so follows a language switch. */
export function documentRefusalKey(err: string | null | undefined): string | null {
  const code = documentRefusalCode(err);
  return code ? uploadRefusalKey(code) : null;
}

/** Map a persisted `documents.error` string to user-facing copy: a plan
 *  refusal becomes its code's sentence in the viewer's language (never the
 *  server's message, never the raw blob); any other error passes through
 *  untouched. */
export function friendlyDocumentError(err: string | null | undefined): string | null | undefined {
  const code = documentRefusalCode(err);
  return code ? uploadRefusalSentence(code) : err;
}
