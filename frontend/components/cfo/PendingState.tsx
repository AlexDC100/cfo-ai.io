// PendingState — the ONE surface a not-yet-launched route renders.
//
// WHY THIS EXISTS AND WHY IT IS NOT `ComingSoon`
// ==============================================
// `ComingSoon.tsx` blurs a MOUNTED, half-built surface behind a "Coming
// soon" pill. That copy is reserved for capability that genuinely does
// not exist yet (connectors, annual billing) — it promises a roadmap.
//
// A launch-scope cut is a different statement: the feature is BUILT, it
// is simply not in the eight surfaces the launch supports, so it is
// switched off until it has been walked end-to-end. Rendering the real
// (half-verified) screen behind a blur would still ship the half-working
// screen — a deep link reaches it, its queries still fire, its console
// errors still happen. PendingState REPLACES the route instead.
//
// Contract (asserted by the LR1 gate):
//   · root carries data-testid="pending-state"
//   · never an error boundary, never a spinner, never a raw string
//   · says what the feature will do, and what it is waiting on
//   · offers "Notify me", recorded per user per feature through the
//     existing `set_user_pref` RPC (no migration): the user prefs bag
//     gets `feature_interest.<key>` = ISO date. /ops reads the counts
//     with the service role behind its existing admin gate.
//
// The component takes plain strings, not i18n keys, so a caller may pass
// either a t()-resolved string or a literal. Every call site in App.tsx
// passes t() output.

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Panel } from "@/components/instrument/Panel";
import { useAuth } from "@/lib/auth";
import { getRemotePref, setPref } from "@/lib/prefs";

export interface PendingStateProps {
  /** Registry key — also the interest-pref suffix. */
  featureKey: string;
  /** Human name of the surface, e.g. "Scenario planning". */
  title: string;
  /** ONE line: what this will do when it is on. */
  description: string;
  /** ONE line: what it is waiting on ("3+ periods", "enabled after launch"). */
  requirement: string;
}

export const FEATURE_INTEREST_PREFIX = "feature_interest.";

/** Pref key for one feature's "notify me" record. Exported so /ops and
 *  the unit test read the same string rather than two spellings. */
export function featureInterestKey(featureKey: string): string {
  return `${FEATURE_INTEREST_PREFIX}${featureKey}`;
}

export function PendingState({
  featureKey,
  title,
  description,
  requirement,
}: PendingStateProps) {
  const { t } = useTranslation();
  // Signed-out visitors get no "Notify me": `set_user_pref` needs a
  // session, so the RPC would no-op and the button would show a
  // confirmed state for a record that was never written.
  const { isAuthenticated } = useAuth();
  const prefKey = featureInterestKey(featureKey);
  // Seed from the already-hydrated prefs bag so a return visit shows the
  // confirmed state without a second round-trip.
  const [notified, setNotified] = useState<boolean>(
    () => typeof getRemotePref<string>("user", prefKey) === "string",
  );

  const onNotify = useCallback(() => {
    // Optimistic: setPref mirrors locally and holds the write until the
    // RPC confirms, so a failed sync degrades to device-local rather than
    // bouncing the button back.
    setPref("user", prefKey, new Date().toISOString());
    setNotified(true);
  }, [prefKey]);

  return (
    <div className="px-6 sm:px-10 py-10" data-testid="pending-state" data-feature={featureKey}>
      <Panel className="max-w-[620px] p-7">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-mute">
          {t("pending.eyebrow")}
        </div>
        <h1 className="mt-3 text-[20px] font-medium text-ink">{title}</h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-ink-soft">{description}</p>

        <div className="mt-5 rounded-md border border-rule bg-bg-2 px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
            {t("pending.needs")}
          </div>
          <div className="mt-1 text-[13px] text-ink-2">{requirement}</div>
        </div>

        <div className="mt-6 flex items-center gap-3">
          {!isAuthenticated ? null : notified ? (
            <span
              data-testid="pending-notify-confirmed"
              className="inline-flex h-9 items-center rounded-full border border-brand/40 px-4 text-[12.5px] text-ink"
            >
              {t("pending.notified")}
            </span>
          ) : (
            <button
              type="button"
              data-testid="pending-notify"
              onClick={onNotify}
              className="inline-flex h-9 items-center rounded-full bg-brand px-4 text-[12.5px] font-medium text-paper transition-colors hover:bg-brand-dark"
            >
              {t("pending.notify")}
            </button>
          )}
        </div>
      </Panel>
    </div>
  );
}

export default PendingState;
