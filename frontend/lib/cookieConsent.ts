// cookieConsent — the ONE store behind the cookie banner and the Settings row.
//
// THE KEY IS NOT NEW. `cfoai_consent` has existed in localStorage since the
// marketing page shipped its first-visit modal (Landing.tsx). This module
// takes ownership of that same key rather than adding a second one: two
// consent stores means the banner can be dismissed in one place and still
// reappear from the other, and — worse — an "analytics allowed" answer that
// depends on which module you asked.
//
// WHAT THE POLICY ACTUALLY PROMISES (content/legal/cookies-ro.md), and what
// this therefore has to implement:
//   · strictly necessary — no consent, always on;
//   · preferences (language, display currency, theme) — "part of delivering
//     the service you requested", so they are NOT gated either;
//   · analytics — "only enabled with your consent", declinable "with no
//     effect on the functioning of the service";
//   · "You can change your choice at any time under Settings".
// The policy names exactly those three categories and states that we use no
// advertising cookies. The old modal offered a fourth toggle, "Marketing" —
// a category the published policy does not describe. Offering consent for a
// category the policy does not declare is the same defect as declaring one
// you do not honour, so the toggle is gone. A legacy value that had it set
// is READ (the decision is kept) but never re-written; see migrate() below.
//
// ⚠ MEASURED, 2026-09-06: there is NO analytics provider wired anywhere in
// this codebase. `grep -riE 'gtag|google-analytics|googletagmanager|plausible
// |posthog|mixpanel|segment|fathom|umami|amplitude|hotjar|sentry'` over
// frontend/, src/ and index.html returns zero product hits. So today
// `analyticsAllowed()` gates NOTHING — it is a working consent wall with
// nothing behind it yet. That is deliberate and it is the point: the first
// analytics integration inherits an enforced wall instead of shipping
// tracking first and bolting consent on afterwards. See
// `loadAnalyticsIfConsented()`, which is where that integration goes.

import { LEGAL_DOCUMENTS } from "./legalDocuments.generated";

export const CONSENT_KEY = "cfoai_consent";
/** Fired on `window` after any write, so every mounted surface (banner,
 *  Settings row, marketing footer) re-reads instead of holding a stale copy.
 *  Same-tab: the `storage` event is not delivered to the tab that wrote. */
export const CONSENT_CHANGED_EVENT = "cfo-cookie-consent-changed";

export interface CookieConsent {
  /** Schema version of THIS record, not of the policy. */
  v: 2;
  /** The only consented category the policy declares. */
  analytics: boolean;
  /** When the choice was made, ISO-8601. */
  decidedAt: string;
  /** Which published Cookie Policy the choice was made against. `null` for a
   *  decision migrated from before the documents were versioned — honest
   *  about the fact that we cannot reproduce what that user was shown. */
  policyVersion: string | null;
  /** Set when this record came from the pre-versioning shape. */
  migratedFrom?: "v1";
}

/** The Cookie Policy version a choice made right now is recorded against.
 *  English and Romanian are separate texts with separate hashes; the banner
 *  records the one whose language the reader is in. */
export function currentCookiePolicyVersion(lang: "en" | "ro"): string {
  return LEGAL_DOCUMENTS[`cookies:${lang}`].version;
}

function migrate(raw: unknown): CookieConsent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.v === 2) {
    return {
      v: 2,
      analytics: !!o.analytics,
      decidedAt: typeof o.decidedAt === "string" ? o.decidedAt : new Date(0).toISOString(),
      policyVersion: typeof o.policyVersion === "string" ? o.policyVersion : null,
      ...(o.migratedFrom === "v1" ? { migratedFrom: "v1" as const } : {}),
    };
  }
  // Legacy shape: { analytics, marketing, ts }. The user made a real choice;
  // discarding it would re-prompt someone who already answered. What we
  // cannot honestly claim is WHICH policy text they answered against, so
  // policyVersion stays null.
  if ("analytics" in o || "marketing" in o || "ts" in o) {
    const ts = typeof o.ts === "number" && Number.isFinite(o.ts) ? o.ts : Date.now();
    return {
      v: 2,
      analytics: !!o.analytics,
      decidedAt: new Date(ts).toISOString(),
      policyVersion: null,
      migratedFrom: "v1",
    };
  }
  return null;
}

/** The stored decision, or null when the visitor has not answered yet. */
export function readCookieConsent(): CookieConsent | null {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    if (!raw) return null;
    return migrate(JSON.parse(raw));
  } catch {
    // Private mode, quota, or a corrupted value. Treat as "not decided":
    // asking again is the safe direction, assuming consent is not.
    return null;
  }
}

export function hasDecidedCookies(): boolean {
  return readCookieConsent() !== null;
}

/** The one question the rest of the app is allowed to ask. Absent decision
 *  means NO — consent is opt-in, never inferred from silence. */
export function analyticsAllowed(): boolean {
  return readCookieConsent()?.analytics === true;
}

export function saveCookieConsent(analytics: boolean, lang: "en" | "ro"): CookieConsent {
  const record: CookieConsent = {
    v: 2,
    analytics,
    decidedAt: new Date().toISOString(),
    policyVersion: currentCookiePolicyVersion(lang),
  };
  try {
    localStorage.setItem(CONSENT_KEY, JSON.stringify(record));
  } catch {
    /* private mode — the choice holds for this page view only */
  }
  try {
    window.dispatchEvent(new Event(CONSENT_CHANGED_EVENT));
  } catch {
    /* non-browser */
  }
  return record;
}

/** Wipe the decision — used by the "ask me again" path in Settings. */
export function clearCookieConsent(): void {
  try {
    localStorage.removeItem(CONSENT_KEY);
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new Event(CONSENT_CHANGED_EVENT));
  } catch {
    /* ignore */
  }
}

/** Subscribe to changes from this tab AND from another tab. */
export function onCookieConsentChange(fn: () => void): () => void {
  const local = () => fn();
  const cross = (e: StorageEvent) => {
    if (e.key === CONSENT_KEY) fn();
  };
  window.addEventListener(CONSENT_CHANGED_EVENT, local);
  window.addEventListener("storage", cross);
  return () => {
    window.removeEventListener(CONSENT_CHANGED_EVENT, local);
    window.removeEventListener("storage", cross);
  };
}

/**
 * THE WALL. Every analytics/measurement provider must be loaded from inside
 * this function and from nowhere else.
 *
 * It is empty today because nothing is wired (see the measurement note at
 * the top of this file). Keeping the empty function is not decoration: it
 * means the integration that eventually adds a provider has exactly one
 * correct place to put the snippet, and that place already answers "may I?"
 * before it runs. Wiring a provider into index.html or a component's
 * useEffect instead would bypass consent entirely and nothing would notice.
 */
export function loadAnalyticsIfConsented(): boolean {
  if (!analyticsAllowed()) return false;
  // ── Analytics providers go HERE, and only here. ──
  return true;
}
