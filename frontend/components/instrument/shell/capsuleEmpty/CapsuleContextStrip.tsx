// THE CAPSULE — ZONE 1: the context strip.
//
// ONE LINE. Not a section, not a card, not a header — a single 28px band
// that answers "what am I asking about" and then gets out of the way.
//
// It replaced `CapsuleContextZone`, which was a three-line block with its
// own heading, its own chip and its own counts stacked vertically. That
// block was one of the five sections the empty state used to stack, and
// the reason the surface opened 18 rows tall before it had said anything.
//
// ── What it holds, left to right ──────────────────────────────────────
//
//   · a STATUS DOT — the engine's balance band as colour, nothing else
//   · the PERIOD MONTH — "Dec 2025". Never a company name (the r0 loop
//     caught exactly that; `useCapsuleSnapshot` is where it was fixed)
//   · the verdict WORD, the engine's own
//   · "N periods without a file" — as a BUTTON, because a count the
//     reader cannot act on is a statistic, and this one has a fix
//
// Everything here is a count or a label. No amount, no ratio, no
// converted anything, so nothing in this file needs the money path.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import "./capsuleEmptyI18n";
import type { CapsuleContextModel, CapsuleTrustBand } from "@/lib/capsuleSuggestions";

/** Band → the dot's colour token. Mirrors TrustChip, so the header dot
 *  and this strip can never disagree about the same period. */
const BAND_DOT: Record<CapsuleTrustBand, string> = {
  balanced: "bg-success",
  reconciled: "bg-caution",
  needs_review: "bg-caution",
  minor_drift: "bg-caution",
  material_imbalance: "bg-alert",
  unverified: "bg-ink-mute",
};

export interface CapsuleContextStripProps {
  context: CapsuleContextModel;
  /** The engine presenter's display string for the active period, in the
   *  active language. Null when the period carries no verdict — the
   *  strip then says "Not verified" rather than wearing a badge it did
   *  not earn. */
  trustLabel: string | null;
  /** Jump to the first period still waiting for a document. Omitted, the
   *  count renders as plain text instead of a dead button. */
  onFixUnattached?: (periodId: string) => void;
  /** Jump to the upload surface when no period is loaded at all. */
  onUpload?: () => void;
  /**
   * Increments once per Tier-0 resolution. The strip pulses ONCE on each
   * change and settles.
   *
   * A COUNTER, not a boolean, and deliberately: "pulse once" is an event,
   * and a boolean cannot express two consecutive events without the host
   * having to flip it back down — which is a second render whose only job
   * is to arm the first. It is also why this is a CSS TRANSITION rather
   * than an animation: a keyframe would need a `@keyframes` block, and
   * both the token sheet and the Tailwind config are owned elsewhere.
   * Two transitions (out fast, back slow) say "once" without either.
   */
  pulseKey?: number;
}

/** True for ~200ms after `key` changes. Skips the very first value, so
 *  opening the surface does not read as a resolution that never happened. */
function usePulse(key: number): boolean {
  const [on, setOn] = useState(false);
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (seen.current === null) {
      seen.current = key;
      return;
    }
    if (seen.current === key) return;
    seen.current = key;
    setOn(true);
    const timer = window.setTimeout(() => setOn(false), 200);
    return () => window.clearTimeout(timer);
  }, [key]);
  return on;
}

const SEP = (
  <span aria-hidden className="text-ink-soft/60">
    ·
  </span>
);

export function CapsuleContextStrip({
  context,
  trustLabel,
  onFixUnattached,
  onUpload,
  pulseKey = 0,
}: CapsuleContextStripProps) {
  const { t } = useTranslation();
  const pulse = usePulse(pulseKey);

  const linkCls =
    "rounded-sm underline decoration-rule underline-offset-2 transition-colors " +
    "duration-micro hover:text-ink hover:decoration-ink-soft " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  // No period at all: one line, one offer. The surface still works —
  // search, navigation and actions are untouched — so this is an
  // invitation, not an error.
  if (!context.hasPeriod) {
    return (
      <div
        data-testid="capsule-context-strip"
        data-state="no-period"
        className="flex h-7 items-center gap-2 px-4 text-[11.5px] text-ink-soft"
      >
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-mute" />
        <span className="truncate">{t("capsuleEmpty.strip.noPeriod")}</span>
        {onUpload && (
          <>
            {SEP}
            <button type="button" onClick={onUpload} className={linkCls}>
              {t("capsuleEmpty.strip.noPeriodAction")}
            </button>
          </>
        )}
      </div>
    );
  }

  const band = context.trustBand;
  const verdict =
    band && band !== "unverified"
      ? trustLabel ?? t(`capsuleEmpty.trust.${band}`)
      : t("capsuleEmpty.strip.unverified");
  const unattached = context.unattachedFirst;

  return (
    <div
      data-testid="capsule-context-strip"
      data-state="period"
      className="flex h-7 items-center gap-2 overflow-hidden px-4 text-[11.5px] text-ink-soft"
    >
      <span
        data-testid="capsule-status-dot"
        data-pulse={pulse ? "true" : undefined}
        aria-hidden
        className={`
          h-1.5 w-1.5 shrink-0 rounded-full ${BAND_DOT[band ?? "unverified"]}
          transition-transform ease-quint motion-reduce:transition-none
          ${pulse ? "scale-[2.2] duration-micro" : "scale-100 duration-overlay"}
        `}
      />

      {/* A period whose month could not be resolved is NAMED AS SUCH.
          Three rounds of the loop landed here:
            r0  the slot fell back to `activePeriod.label` and printed a
                COMPANY where a month belongs;
            r1  the fallback was deleted, and the strip read a bare
                "Not verified" with no subject — true, but stunted;
            r2  it says what is actually the case. The demo period really
                does carry no `period_end`, and "Period not dated" is the
                honest sentence. Note the header shows "Aug 2026" here —
                that is ITS current-month fallback, not this period's
                month, and copying it would be inventing a date. */}
      <span data-testid="capsule-context-period" className="shrink-0 text-ink-soft">
        {context.periodLabel ?? t("capsuleEmpty.strip.undated")}
      </span>
      {SEP}
      <span data-testid="capsule-context-trust" className="shrink-0 truncate">
        {verdict}
      </span>

      {context.unattachedCount > 0 && (
        <>
          {SEP}
          {onFixUnattached && unattached ? (
            <button
              type="button"
              data-testid="capsule-fix-unattached"
              onClick={() => onFixUnattached(unattached.periodId)}
              className={`shrink-0 ${linkCls}`}
            >
              {t("capsuleEmpty.strip.unattached", { count: context.unattachedCount })}
            </button>
          ) : (
            <span className="shrink-0">
              {t("capsuleEmpty.strip.unattached", { count: context.unattachedCount })}
            </span>
          )}
        </>
      )}

      {context.findingCount > 0 && (
        <>
          {SEP}
          <span data-testid="capsule-context-findings" className="shrink-0">
            {t("capsuleEmpty.strip.findings", { count: context.findingCount })}
          </span>
        </>
      )}
    </div>
  );
}
