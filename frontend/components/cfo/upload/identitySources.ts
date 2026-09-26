// identitySources.ts — the words the user reads for "where did this come from".
//
// /api/uploads/identify says, per field, which signal produced it
// (`sources.<field>.signal`). The engine owns those tokens
// (src/engine/workspaces/company_identity.py and _period_detect.SIGNALS);
// the card owns the phrase. Tokens as of 2026-09-21:
//
//   cui           document_header_cui · registry_name_match ·
//                 filename_registry_match · operator_verified
//   company_name  registry · document_header_label · document_header_title ·
//                 sheet_name · filename · operator_verified
//   caen_code     registry · document_header · operator_verified
//   industry_key  caen_catalogue
//   period_end    in_document · closing_balance · (filename → dropped by the
//                 engine before it reaches the card: G2) · none
//
// Mapping is by family rather than by exact token, so a new spelling of the
// same origin still reads right, and an unknown token falls back to the honest
// minimum — "from the document" — never to a guess about a registry the
// engine did not consult. "none" is not an origin: the card shows nothing.
//
// Deliberately never the words "source" or "attachment" (either language):
// the card says WHERE a value came from in a plain phrase instead.

export type SourcePhrase =
  | "document_header"
  | "period_line"
  | "closing_balance"
  | "registry"
  | "caen"
  | "sheet"
  | "filename"
  | "verified"
  | "on_screen_company"
  | "company_settings"
  | "user"
  | "document";

export function sourcePhrase(signal: string | null | undefined, field?: string): SourcePhrase {
  const s = (signal ?? "").toLowerCase();
  if (!s || s === "none") return "document";
  if (s === "user" || s.includes("manual") || s.includes("chosen") || s.startsWith("user_")) return "user";
  if (s.includes("on_screen") || s.includes("fallback") || s.includes("active_org")) return "on_screen_company";
  if (s.includes("operator") || s.includes("verified")) return "verified";
  // Before "registry": a registry match found from the FILE NAME is, first of
  // all, a file-name reading — the weakest origin, and the card says so.
  if (s.startsWith("filename") || s.includes("file_name")) return "filename";
  if (s.includes("org_prefs") || s.includes("settings") || s.includes("existing_company") || s.includes("membership")) {
    return "company_settings";
  }
  if (s.includes("registry") || s.includes("onrc") || s.includes("anaf") || s.includes("public_ro") || /(^|_)mf($|_)/.test(s)) {
    return "registry";
  }
  if (s.includes("caen")) return "caen";
  if (s.includes("sheet")) return "sheet";
  if (field === "period_end" || s.includes("period")) {
    if (s.includes("closing")) return "closing_balance";
    if (s === "in_document" || s.includes("period")) return "period_line";
  }
  if (s.includes("header") || s.includes("heading") || s.includes("title")) return "document_header";
  return "document";
}

/** i18n key for a signal — `wsV2.from.<phrase>`. */
export function sourceKey(signal: string | null | undefined, field?: string): string {
  return `wsV2.from.${sourcePhrase(signal, field)}`;
}
