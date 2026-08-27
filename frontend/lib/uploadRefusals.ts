// uploadRefusals.ts — typed refusals from the upload/scan path.
//
// 2026-08 tier restructure: non-Romanian documents (jurisdiction
// resolver != RO) are ONLY allowed on the Multi-Country tier. The
// backend refuses them with a typed payload:
//
//     { "error": "non_ro_not_included", "upgrade_to": "multi", "message": … }
//
// which may arrive either bare or wrapped in FastAPI's `detail`
// envelope (HTTPException serialization). This module recognizes both
// shapes — plus `code` as an alternate discriminator field name, since
// the existing pipeline refusals (`extra_doc_confirmation_required`,
// `doc_quota_blocked`) use `code` — so the FE renders a friendly
// upgrade prompt instead of a raw error toast regardless of which
// spelling the backend lane settled on.
//
// Parsing is pure (unit-tested in lib/__tests__/pricingTiersSpec.test.ts
// without touching the Supabase client module); only the humanizer at
// the bottom reads the i18next instance, and only when initialized.

import i18next from "i18next";

export interface NonRoRefusal {
  kind: "non_ro_blocked";
  /** Tier that unlocks non-RO uploads. Defaults to "multi" per spec. */
  upgradeTo: string;
  message: string;
}

const NON_RO_CODE = "non_ro_not_included";

/** Default user-facing copy — callers should prefer i18n keys
 *  (`pricing.nonRoBlockedDesc`) and use the server `message` only as
 *  supplementary detail. */
const DEFAULT_MESSAGE =
  "This document isn't a Romanian filing. Non-RO documents are included on the Multi-Country plan.";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Inspect an error-response body (already JSON-parsed) and return the
 *  typed non-RO refusal when present, else null. Never throws. */
export function parseUploadRefusal(body: unknown): NonRoRefusal | null {
  const outer = asRecord(body);
  if (!outer) return null;
  // FastAPI wraps HTTPException payloads in `detail`; bare shape also valid.
  const d = asRecord(outer.detail) ?? outer;
  const discriminator = d.error ?? d.code;
  if (discriminator !== NON_RO_CODE) return null;
  return {
    kind: "non_ro_blocked",
    upgradeTo: typeof d.upgrade_to === "string" && d.upgrade_to ? d.upgrade_to : "multi",
    message: typeof d.message === "string" && d.message ? d.message : DEFAULT_MESSAGE,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Persisted-error humanizer.
//
// The pipeline's non-RO gate runs DURING processing (jurisdiction is
// resolved at the extract stage), so the refusal is persisted verbatim
// as JSON into `documents.error` and reaches the FE through the
// document-status subscription — not the enqueue HTTP response. Every
// failure surface (scan card, toasts, DocumentChip) renders that field
// raw; this helper swaps the JSON blob for the friendly upgrade copy at
// the subscription seam so no surface ever shows `{"error": …}`.
// ─────────────────────────────────────────────────────────────────────

const NONRO_QUOTA_CODE = "nonro_quota_exhausted";

function extractRefusalJson(err: string): unknown {
  try {
    return JSON.parse(err);
  } catch {
    // Refusal JSON embedded inside a longer error string.
    const m = err.match(/\{[^{}]*\}/s);
    if (m) {
      try { return JSON.parse(m[0]); } catch { return null; }
    }
    return null;
  }
}

/** Map a persisted `documents.error` string to user-facing copy.
 *  Non-refusal errors pass through untouched. Localized via i18next
 *  when the app instance is initialized; falls back to English. */
export function friendlyDocumentError(err: string | null | undefined): string | null | undefined {
  if (!err || !err.includes("non") /* cheap pre-filter */) return err;
  const parsed = extractRefusalJson(err);
  const refusal = parseUploadRefusal(parsed);
  if (refusal) {
    // The bare i18next instance (initialized by `@/i18n` at app boot).
    // When it isn't initialized (pure unit tests), fall back to the
    // refusal's own message.
    if (i18next.isInitialized) return i18next.t("pricing.nonRoBlockedDesc");
    return refusal.message;
  }
  const d = asRecord(parsed);
  if (d && (d.error === NONRO_QUOTA_CODE || d.code === NONRO_QUOTA_CODE)) {
    return typeof d.message === "string" && d.message ? d.message : err;
  }
  return err;
}
