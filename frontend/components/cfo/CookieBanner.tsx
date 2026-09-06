// CookieBanner — the first-visit consent prompt, app-wide.
//
// ONE BANNER, EVERYWHERE. Before this pass the prompt lived inside
// Landing.tsx as an HTML-string modal, so it appeared on the marketing home
// page and nowhere else: someone who arrived straight at /pricing, /login or
// a shared /dashboard link was never asked, and the signed-in app had no
// prompt at all. This component is mounted once in App.tsx, above the
// router, so every route inherits it and there is exactly one implementation
// to keep consistent with the Cookie Policy.
//
// WHAT IT OFFERS, AND WHY THOSE EXACTLY. content/legal/cookies-ro.md
// declares three categories and gates one of them:
//   · strictly necessary — always on, no consent (says so in the policy);
//   · preferences (language, currency, theme) — delivered as part of the
//     service the user asked for, so not gated either;
//   · analytics — "only enabled with your consent".
// So the banner has one real choice. A row of toggles where two are
// permanently locked on is theatre; it invites the reader to believe they
// are deciding something they are not. The two locked categories are stated
// as fact, with a link to the policy that describes them in full.
//
// "Reject" is a first-class button beside "Accept", same weight, no dark
// pattern — the policy says analytics "can be declined with no effect on the
// functioning of the service", and a banner that makes declining harder than
// accepting contradicts its own document.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  hasDecidedCookies,
  onCookieConsentChange,
  readCookieConsent,
  saveCookieConsent,
} from "@/lib/cookieConsent";
import { docLangOf } from "@/lib/legalDocs";
import { legalDocPath } from "@/lib/legalConfig";

/** Dispatch on `window` to re-open the prompt — the marketing footer's
 *  "Cookie settings" link and the Settings row both use it, so neither has
 *  to own a second copy of this UI. */
export const OPEN_COOKIE_SETTINGS_EVENT = "cfo-open-cookie-settings";

export function openCookieSettings(): void {
  try {
    window.dispatchEvent(new Event(OPEN_COOKIE_SETTINGS_EVENT));
  } catch {
    /* non-browser */
  }
}

export function CookieBanner() {
  const { t, i18n } = useTranslation();
  const lang = docLangOf(i18n.language);
  // Start CLOSED and open in an effect. Reading localStorage during the
  // first render would make the banner flash on a page the visitor already
  // answered on, and would throw in a private-mode context during SSR-style
  // prerendering of the legal pages.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!hasDecidedCookies()) setOpen(true);
    const offChange = onCookieConsentChange(() => {
      if (hasDecidedCookies()) setOpen(false);
    });
    const reopen = () => setOpen(true);
    window.addEventListener(OPEN_COOKIE_SETTINGS_EVENT, reopen);
    return () => {
      offChange();
      window.removeEventListener(OPEN_COOKIE_SETTINGS_EVENT, reopen);
    };
  }, []);

  const decide = useCallback(
    (analytics: boolean) => {
      saveCookieConsent(analytics, lang);
      setOpen(false);
    },
    [lang],
  );

  if (!open) return null;
  const current = readCookieConsent();

  return (
    <div
      data-testid="cookie-banner"
      role="dialog"
      aria-modal="false"
      aria-label={t("cookieConsent.title")}
      className="fixed inset-x-0 bottom-0 z-[95] flex justify-center px-3 pb-3 sm:px-4 sm:pb-4"
    >
      <div className="w-full max-w-[620px] rounded-2xl border border-rule-strong bg-surface p-5 shadow-[0_30px_80px_-24px_rgba(0,0,0,0.55)]">
        <div className="text-[14px] font-semibold text-ink">{t("cookieConsent.title")}</div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
          {t("cookieConsent.body")}{" "}
          <Link
            to={legalDocPath("cookies")}
            data-testid="cookie-banner-policy-link"
            className="text-brand underline underline-offset-2"
          >
            {t("cookieConsent.policyLink")}
          </Link>
        </p>
        <ul className="mt-3 space-y-1 text-[12px] text-ink-mute">
          <li data-testid="cookie-banner-necessary">· {t("cookieConsent.necessary")}</li>
          <li data-testid="cookie-banner-preferences">· {t("cookieConsent.preferences")}</li>
          <li data-testid="cookie-banner-analytics">· {t("cookieConsent.analytics")}</li>
        </ul>
        <div className="mt-4 flex flex-wrap gap-2.5">
          <button
            type="button"
            data-testid="cookie-accept"
            onClick={() => decide(true)}
            className="h-10 min-w-[140px] flex-1 rounded-full bg-brand px-4 text-[13px] font-medium text-paper hover:bg-brand-dark"
          >
            {t("cookieConsent.accept")}
          </button>
          <button
            type="button"
            data-testid="cookie-reject"
            onClick={() => decide(false)}
            className="h-10 min-w-[140px] flex-1 rounded-full border border-rule-strong px-4 text-[13px] font-medium text-ink hover:border-brand"
          >
            {t("cookieConsent.reject")}
          </button>
        </div>
        {current && (
          <p className="mt-3 text-[11px] text-ink-mute" data-testid="cookie-banner-current">
            {t("cookieConsent.currentChoice", {
              value: current.analytics
                ? t("cookieConsent.stateAllowed")
                : t("cookieConsent.stateDeclined"),
            })}
          </p>
        )}
      </div>
    </div>
  );
}

export default CookieBanner;
