// First-touch attribution capture (Lane 5 — public funnel honesty).
//
// Captures utm_* params + ft_cui (the public company page a visitor
// arrived from) off the URL ON FIRST LOAD into localStorage, before the
// dashboard family rewrites the querystring. The record is immutable:
// once captured it is never overwritten — that is what makes it a
// FIRST touch. At signup, frontend/lib/auth.tsx passes it through
// supabase.auth.signUp options.data as `first_touch`, and the
// on_auth_user_created_public_funnel trigger
// (supabase/schema_phase_public_funnel.sql) lifts it into
// profiles.first_touch jsonb.
//
// Everything is wrapped in try/catch — attribution must never break a
// page (private windows throw on localStorage; SSR/tests have no
// window).

const KEY = "cfoai.first_touch.v1";
const MAX_UTM_KEYS = 8;
const MAX_VALUE_LEN = 120;

export interface FirstTouch {
  utm?: Record<string, string>;
  ft_cui?: string;
  landing_path?: string;
  referrer?: string;
  captured_at: string; // ISO
}

/** Read the stored first-touch record, or null. Never throws. */
export function getFirstTouch(): FirstTouch | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FirstTouch;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Capture utm_* + ft_cui from the current URL if (a) nothing was
 *  captured before and (b) there is actually something to capture.
 *  Called once at app boot (frontend/lib/auth.tsx module scope). */
export function captureFirstTouch(): void {
  try {
    if (typeof window === "undefined") return;
    if (getFirstTouch()) return; // first touch is immutable

    const params = new URLSearchParams(window.location.search);
    const utm: Record<string, string> = {};
    let utmCount = 0;
    params.forEach((value, key) => {
      if (/^utm_[a-z0-9_]{1,24}$/.test(key) && utmCount < MAX_UTM_KEYS) {
        utm[key] = value.slice(0, MAX_VALUE_LEN);
        utmCount += 1;
      }
    });
    const ftCuiRaw = params.get("ft_cui") ?? "";
    const ftCui = /^[0-9]{2,10}$/.test(ftCuiRaw) ? ftCuiRaw : undefined;

    // Nothing attributable on this URL — capture nothing (an organic
    // visit stays "unattributed"; we never fabricate attribution).
    if (utmCount === 0 && !ftCui) return;

    const record: FirstTouch = {
      ...(utmCount > 0 ? { utm } : {}),
      ...(ftCui ? { ft_cui: ftCui } : {}),
      landing_path: window.location.pathname.slice(0, 300),
      referrer: (document.referrer || "").slice(0, 300) || undefined,
      captured_at: new Date().toISOString(),
    };
    localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    /* private window / quota / no DOM — attribution is best-effort */
  }
}

/** Test/support helper — drop the stored record. */
export function clearFirstTouch(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
