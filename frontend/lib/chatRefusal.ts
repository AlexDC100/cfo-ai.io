// chatRefusal — what the Ask CFO AI function REFUSED, read as a CODE and
// rendered in the reader's language.
//
// The Edge Function (supabase/functions/chat-llm) answers three refusals
// without calling the model (owner, 2026-10-03: the cap is enforced on every
// call, signed in or not):
//
//   401  sign_in_required      no verified user — no bearer, or one the auth
//                              server does not vouch for
//   429  chat_cap_reached      the plan's daily or monthly message cap
//   503  metering_unavailable  the plan row or the meter could not be read:
//                              the function refuses rather than answer
//                              unmetered
//
// Each carries an English (or request-language) `message` for a caller with
// no words of its own. THE APP NEVER PRINTS IT: a sentence a server composed
// is in the server's language and names the plan in the server's words. The
// code, the cap period and the cap NUMBER are read here; the sentence is the
// app's, from components/cfo/chat/chatRefusalStrings.json.
//
// Anything else the function answers (auth_unavailable, an upstream failure,
// a transport error) is NOT a refusal: it goes through lib/aiDegraded's
// mapper as before.

import i18n from "@/i18n";
import "@/components/cfo/chat/chatRefusalI18n";
import { CfoApiError } from "@/lib/cfoApi";

export type ChatRefusal =
  | { code: "sign_in_required" }
  | { code: "metering_unavailable" }
  | {
      code: "chat_cap_reached";
      period: "daily" | "monthly";
      /** The plan's cap for that period, when the function said it. */
      cap: number | null;
      /** Where "See plans" goes — a same-site path, never a foreign URL. */
      href: string;
    };

const codeOf = (detail: unknown): string | null => {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as { code?: unknown; error?: unknown };
  if (typeof d.code === "string") return d.code;
  return typeof d.error === "string" ? d.error : null;
};

const capNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;

/** A same-site path ("/pricing"), or the default. Never "//host" or a URL. */
const sitePath = (v: unknown): string =>
  typeof v === "string" && /^\/(?!\/)[A-Za-z0-9\-._~/?=&%]*$/.test(v) ? v : "/pricing";

/** The refusal a thrown chat error carries, or null when it is not one. */
export function chatRefusalOf(err: unknown): ChatRefusal | null {
  if (!(err instanceof CfoApiError)) return null;
  const code = codeOf(err.detail);
  if (code === "chat_cap_reached" && err.status === 429) {
    const d = err.detail as { kind?: unknown; daily_cap?: unknown; monthly_cap?: unknown; upgrade_url?: unknown };
    const period = d.kind === "daily_cap_reached" ? "daily" : "monthly";
    return {
      code: "chat_cap_reached",
      period,
      cap: capNumber(period === "daily" ? d.daily_cap : d.monthly_cap),
      href: sitePath(d.upgrade_url),
    };
  }
  if (code === "metering_unavailable") return { code: "metering_unavailable" };
  // A 401 from this function has one meaning, with or without its body.
  if (code === "sign_in_required" || err.status === 401) return { code: "sign_in_required" };
  return null;
}

export interface ChatRefusalCopy {
  headline: string;
  body: string;
  link: { label: string; href: string } | null;
}

/** The sentences for a refusal, in `lang` (default: the active UI language). */
export function chatRefusalCopy(refusal: ChatRefusal, lang?: string): ChatRefusalCopy {
  const t = lang ? i18n.getFixedT(lang) : i18n.t.bind(i18n);
  switch (refusal.code) {
    case "sign_in_required":
      return {
        headline: t("chatRefusal.signInHeadline"),
        body: t("chatRefusal.signInBody"),
        link: { label: t("chatRefusal.signInLink"), href: "/login?next=%2Fchat" },
      };
    case "metering_unavailable":
      return { headline: t("chatRefusal.meteringHeadline"), body: t("chatRefusal.meteringBody"), link: null };
    case "chat_cap_reached":
      return {
        headline: t(refusal.period === "daily" ? "chatX.cap.dailyHeadline" : "chatX.cap.monthlyHeadline"),
        body:
          refusal.cap === null
            ? t("chatX.cap.body")
            : t(refusal.period === "daily" ? "chatRefusal.capDailyBody" : "chatRefusal.capMonthlyBody", { cap: refusal.cap }),
        link: { label: t("chatX.seePlans"), href: refusal.href },
      };
  }
}

/** The refusal as the markdown an assistant turn renders. */
export function chatRefusalMarkdown(copy: ChatRefusalCopy): string {
  const link = copy.link ? `\n\n[${copy.link.label} →](${copy.link.href})` : "";
  return `**${copy.headline}**\n\n${copy.body}${link}`;
}
