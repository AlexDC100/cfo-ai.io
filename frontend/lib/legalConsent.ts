// legalConsent — recording WHICH documents a user accepted, and WHEN.
//
// THE REQUIREMENT, precisely. "Record the timestamp and the document version
// accepted, per user." A boolean `accepted_terms: true` does not satisfy it:
// six months and three policy revisions later it cannot answer the only
// question that matters in a dispute — *what did this person actually agree
// to?* So the record stores, per document, the version identifier and the
// sha256 of the exact source bytes that were published at the moment they
// ticked the box. `content/legal/*.md` is in git, so any recorded hash can be
// resolved back to the literal text by checking out the commit whose
// `legalDocuments.generated.ts` carries it.
//
// WHY IT IS WRITTEN LATE, NOT AT SUBMIT. When email confirmation is on
// (mailer_autoconfirm=false, which is prod), `signUp()` returns with NO
// session — there is no authenticated user to attach a preference row to,
// and `set_user_pref` is a SECURITY DEFINER RPC that resolves the user from
// `auth.uid()`. So the record is parked in localStorage and flushed the
// first time a session exists. This is exactly the shape lib/newsletterOptIn
// already uses for the same reason, deliberately: one pattern, one failure
// mode, one place to look when a signup-time intent goes missing.
//
// WHY `set_user_pref` AND NOT A DEDICATED TABLE. There is no migration
// budget in this lane, and `user_prefs.prefs` is a jsonb bag with the
// merge-server-side RPC already in place (supabase/schema_phase_prefs.sql).
// It is a legitimate home — the row is per-user, RLS-scoped to
// `auth.uid()`, and merged with `||` server-side so a concurrent theme write
// cannot clobber it. What it is NOT is append-only: a later write under the
// same key REPLACES the record. That is why `legal_consent` holds a HISTORY
// array rather than one object, and why `recordConsent` appends instead of
// overwriting. A dedicated append-only `legal_acceptances` table with a
// server-side timestamp remains the better long-term home — flagged, not
// built, because it needs a migration the owner has not budgeted.

import { setPref, getRemotePref, hydrateUserPrefs } from "./prefs";
import { legalDocument, docLangOf } from "./legalDocs";
import type { LegalDocId, LegalLang } from "./legalConfig";

/** The two documents the signup line makes the user accept. Terms first,
 *  matching the sentence: "I accept the Terms and the Privacy Policy". */
export const CONSENTED_DOCS: LegalDocId[] = ["terms", "privacy"];

export const LEGAL_CONSENT_PREF_KEY = "legal_consent";

/**
 * Sentinel used when an acceptance is parked before the address is known.
 *
 * The password signup path parks the acceptance under the email the user
 * typed, and the flush refuses to attach it to a session with a different
 * address — the shared-browser case where one person signs up, never
 * confirms, and someone else signs in first. An OAuth signup has no address
 * to match against until the provider redirects back, so it parks under this
 * sentinel and the flush accepts whichever session lands.
 *
 * WHAT THAT COSTS, stated plainly: if a user ticks the box, is redirected to
 * Google, abandons the flow, and a DIFFERENT account signs in on the same
 * browser before the entry is consumed, that account gets the record. The
 * window is one redirect long and both people are at the same keyboard. The
 * alternative — no consent record at all for every Google signup — is worse,
 * because it is a silent, permanent gap rather than a narrow, documented one.
 */
export const OAUTH_PENDING_EMAIL = "*oauth-pending*";
const PENDING_KEY = "cfo-ai-legal-consent-pending-v1";

export interface AcceptedDocument {
  doc: LegalDocId;
  /** e.g. "terms-en@2026-09-06+17fea120b6c6" */
  version: string;
  /** sha256 of that language section's source bytes. */
  sha256: string;
  /** The document's own publication date. */
  published: string;
  lang: LegalLang;
}

export interface LegalConsentRecord {
  /** Client clock. Honest about what it is — see the caveat in the report. */
  accepted_at: string;
  /** Where the acceptance happened. Today only "signup". */
  source: "signup";
  /** The UI language the user was reading in when they accepted. */
  ui_language: LegalLang;
  documents: AcceptedDocument[];
}

/** Build the record for a user accepting right now, in `language`. */
export function buildConsentRecord(language: string | null | undefined): LegalConsentRecord {
  const lang = docLangOf(language);
  return {
    accepted_at: new Date().toISOString(),
    source: "signup",
    ui_language: lang,
    documents: CONSENTED_DOCS.map((doc) => {
      const d = legalDocument(doc, lang);
      return {
        doc,
        version: d.version,
        sha256: d.sha256,
        published: d.published,
        lang: d.lang,
      };
    }),
  };
}

interface PendingConsent {
  email: string;
  record: LegalConsentRecord;
}

/** Park an acceptance until a session exists. */
export function markLegalConsentPending(email: string, record: LegalConsentRecord): void {
  try {
    const payload: PendingConsent = { email: email.trim().toLowerCase(), record };
    localStorage.setItem(PENDING_KEY, JSON.stringify(payload));
  } catch {
    /* private mode / quota — must never block signup */
  }
}

export function clearLegalConsentPending(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

export function readLegalConsentPending(): PendingConsent | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingConsent;
    if (!p || typeof p.email !== "string" || !p.record) return null;
    return p;
  } catch {
    return null;
  }
}

/**
 * Append `record` to the user's consent history.
 *
 * APPEND, not replace: `set_user_pref` merges at the TOP level of the bag,
 * so writing `legal_consent` twice keeps only the second value. Re-reading
 * the existing array and appending is a read-modify-write, which prefs.ts
 * warns against for concurrent single-key writes — but the two writers here
 * are the same user accepting on two devices minutes or months apart, not
 * two tabs racing, and losing an entry to a genuine race is preferable to
 * losing the whole history to an unconditional overwrite. Flagged in the
 * report as the reason a dedicated append-only table is the right end state.
 */
export async function recordConsent(record: LegalConsentRecord): Promise<void> {
  let history: LegalConsentRecord[] = [];
  try {
    // HYDRATE FIRST. `getRemotePref` is synchronous and answers `undefined`
    // both for "unset" and for "the bag has not been fetched yet" — and this
    // runs on the first auth state change, which is exactly when it has not.
    // Reading before hydrating would silently start a fresh history and the
    // append would overwrite every earlier acceptance.
    await hydrateUserPrefs();
    const existing = getRemotePref<LegalConsentRecord[] | LegalConsentRecord>(
      "user",
      LEGAL_CONSENT_PREF_KEY,
    );
    if (Array.isArray(existing)) history = existing;
    else if (existing && typeof existing === "object") history = [existing];
  } catch {
    /* first acceptance, or prefs unavailable — start a fresh history */
  }
  // Same version accepted again (a re-signup on the same account) is not
  // worth a duplicate row; a DIFFERENT version is the whole point.
  const key = (r: LegalConsentRecord) => r.documents.map((d) => d.version).sort().join("|");
  if (history.some((h) => key(h) === key(record))) return;
  setPref("user", LEGAL_CONSENT_PREF_KEY, [...history, record]);
}

/**
 * Flush a parked acceptance now that `sessionEmail` is signed in. No-op when
 * nothing is pending, so it is safe on every auth state change.
 */
export async function flushLegalConsent(sessionEmail: string | null | undefined): Promise<void> {
  const pending = readLegalConsentPending();
  if (!pending) return;
  const current = (sessionEmail ?? "").trim().toLowerCase();
  if (!current) return;
  // A shared browser: someone signs up, never confirms, a different account
  // signs in first. Attaching the first person's acceptance to the second
  // person's record would be a fabricated consent, which is worse than none.
  if (pending.email !== OAUTH_PENDING_EMAIL && current !== pending.email) {
    clearLegalConsentPending();
    return;
  }
  try {
    await recordConsent(pending.record);
    clearLegalConsentPending();
  } catch {
    // Keep the pending entry so the next sign-in retries. An acceptance that
    // failed to persist is not an acceptance we may claim to hold.
  }
}
