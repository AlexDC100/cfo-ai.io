// THE CAPSULE — context zone.
//
// The first thing the empty state says is WHERE YOU ARE: which period is
// loaded, what the engine's balance verdict on it is, and what the
// workspace is still missing. Suggestions come after — a question is only
// as good as the reader's certainty about what it is a question ABOUT.
//
// Trust wording is the ENGINE'S OWN (`presentStatus().displayEn/displayRo`,
// passed in verbatim by the snapshot hook). This file re-words nothing;
// its only fallback, when no presenter string arrived, is the band's own
// key — never an invented sentence, and never a chip on a period that
// carries no verdict at all (the TrustChip render-nothing rule).

import { useTranslation } from "react-i18next";

import "./capsuleEmptyI18n";
import { Chip, type ChipTone } from "@/components/instrument/Panel";
import type { CapsuleContextModel, CapsuleTrustBand } from "@/lib/capsuleSuggestions";

/** Band → chip tone. Mirrors TrustChip so the header dot and this strip
 *  can never disagree about the same period. */
const BAND_TONE: Record<CapsuleTrustBand, ChipTone> = {
  balanced: "success",
  reconciled: "caution",
  needs_review: "caution",
  minor_drift: "caution",
  material_imbalance: "alert",
  unverified: "neutral",
};

export interface CapsuleContextZoneProps {
  context: CapsuleContextModel;
  /** The engine presenter's display string for the active period, in the
   *  active language. Null when the period carries no verdict. */
  trustLabel: string | null;
}

export function CapsuleContextZone({ context, trustLabel }: CapsuleContextZoneProps) {
  const { t } = useTranslation();

  if (!context.hasPeriod) {
    return (
      <div
        data-testid="capsule-context-zone"
        className="flex flex-col gap-1 border-b border-rule-soft px-4 py-3"
      >
        <span className="text-[12.5px] text-ink">{t("capsuleEmpty.context.noPeriod")}</span>
        <span className="text-[11.5px] leading-relaxed text-ink-mute">
          {t("capsuleEmpty.context.noPeriodHint")}
        </span>
      </div>
    );
  }

  const band = context.trustBand;
  // An unverified (or verdict-less) period gets NO chip. Badging it would
  // be claiming a check that never ran.
  const showTrust = band !== null && band !== "unverified";

  return (
    <div
      data-testid="capsule-context-zone"
      className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-rule-soft px-4 py-2.5"
    >
      {/* The name renders only when there IS one. A period whose label
          was refused by the figure guard still shows its verdict and its
          counts — it is loaded, and saying otherwise would be false. */}
      {context.periodLabel && (
        <>
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-mute">
            {t("capsuleEmpty.context.period")}
          </span>
          <span data-testid="capsule-context-period" className="text-[12.5px] text-ink">
            {context.periodLabel}
          </span>
        </>
      )}

      {showTrust && (
        <Chip tone={BAND_TONE[band]} dot data-testid="capsule-context-trust">
          {trustLabel ?? t(`capsuleEmpty.trust.${band}`)}
        </Chip>
      )}
      {!showTrust && (
        <span
          data-testid="capsule-context-unverified"
          title={t("capsuleEmpty.context.unverifiedHint")}
          className="text-[11.5px] text-ink-mute"
        >
          {t("capsuleEmpty.context.unverified")}
        </span>
      )}

      {/* Counts, not amounts — a count of rows never converts currency and
          never needs a provenance tooltip. */}
      {context.unattachedCount > 0 && (
        <span className="text-[11.5px] text-ink-mute">
          {t("capsuleEmpty.context.unattached", { n: context.unattachedCount })}
        </span>
      )}
      {context.findingCount > 0 && (
        <span className="text-[11.5px] text-ink-mute">
          {t("capsuleEmpty.context.findings", { n: context.findingCount })}
        </span>
      )}
    </div>
  );
}
