// One place that maps the active UI language to a BCP-47 locale for every
// Intl call in the app (dates, numbers). Hardcoding "en-GB"/"en-US" per
// call site is how RO users ended up reading Romanian text around
// English-formatted dates.

import { useTranslation } from "react-i18next";
import i18n from "@/i18n";

export function localeFor(lang: string | undefined | null): string {
  return lang?.startsWith("ro") ? "ro-RO" : "en-GB";
}

/** Non-hook accessor for module-level / event-handler code. */
export function activeLocale(): string {
  return localeFor(i18n.language);
}

/** Hook — re-renders the caller when the UI language changes. */
export function useActiveLocale(): string {
  const { i18n: inst } = useTranslation();
  return localeFor(inst.language);
}

/** Date-only ISO strings (period ends, invoice dates) must be rendered in
 *  UTC — local-time parsing shows Dec 31 as Dec 30 anywhere west of
 *  Greenwich. Timestamps (createdAt etc) should NOT use this; they render
 *  in the viewer's timezone by design. */
export function formatDateOnly(
  iso: string | null | undefined,
  opts: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(activeLocale(), { ...opts, timeZone: "UTC" });
}

/** Full timestamps — viewer's local timezone, active-language locale. */
export function formatDateTime(
  iso: string | null | undefined,
  opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(activeLocale(), opts);
}
