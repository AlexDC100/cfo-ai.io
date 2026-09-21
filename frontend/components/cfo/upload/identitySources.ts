// identitySources.ts — the words the user reads for "where did this come from".
//
// /api/uploads/identify says, per field, which signal produced it
// (`sources.<field>.signal`). The engine owns those tokens; the card owns the
// phrase. Mapping is by family rather than by exact token so a new spelling of
// the same origin (`document_header` / `header_cui` / `pdf_header`) still reads
// right, and an unknown token falls back to the honest minimum — "from the
// document" — never to a guess about a registry the engine did not consult.
//
// Deliberately never the words "source" or "attachment" (either language):
// the card says WHERE a value came from in a plain phrase instead.

export type SourcePhrase =
  | "document_header"
  | "period_line"
  | "registry"
  | "caen"
  | "on_screen_company"
  | "company_settings"
  | "user"
  | "document";

export function sourcePhrase(signal: string | null | undefined): SourcePhrase {
  const s = (signal ?? "").toLowerCase();
  if (!s) return "document";
  if (s === "user" || s.includes("manual") || s.includes("chosen") || s.includes("user_")) return "user";
  if (s.includes("on_screen") || s.includes("fallback") || s.includes("active_org")) return "on_screen_company";
  if (s.includes("org_prefs") || s.includes("settings") || s.includes("existing_company") || s.includes("membership")) {
    return "company_settings";
  }
  if (s.includes("registry") || s.includes("onrc") || s.includes("anaf") || s.includes("public_ro") || /(^|_)mf($|_)/.test(s)) {
    return "registry";
  }
  if (s.includes("caen")) return "caen";
  if (s.includes("period")) return "period_line";
  if (s.includes("header") || s.includes("heading") || s.includes("title")) return "document_header";
  return "document";
}

/** i18n key for a signal — `wsV2.from.<phrase>`. */
export function sourceKey(signal: string | null | undefined): string {
  return `wsV2.from.${sourcePhrase(signal)}`;
}
