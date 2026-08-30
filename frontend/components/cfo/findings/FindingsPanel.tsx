// The findings surface: the recommendations, then everything that did
// not become one.
//
// The order on screen is the order of the argument. Surfaced findings
// first, in the engine's rank — quantified impact × confidence ×
// persistence × actionability, each factor printed on the card in Pro so
// the ordering is reconstructable rather than taken on faith. Then the
// cap statement, so "we found 23 things and are showing you 7" is
// visible instead of implied. Then All checks, which is where every
// demoted, immaterial, held-back and quiet rule lives.
//
// Three states, and only three:
//   · something surfaced  → the cards, plus All checks
//   · nothing surfaced    → the silence claim, plus All checks (open)
//   · no contract rows    → render NOTHING and let the caller fall back.
//     A period whose payload predates the rebuild has not been checked
//     by these rules, and claiming silence over it would be the one lie
//     this feature cannot afford.

import { useTranslation } from "react-i18next";

import type { Finding, FindingDismissal, FindingsReport } from "@/lib/findings";
import { useExportPack } from "@/lib/findings";

import { AllChecksList } from "./AllChecksList";
import { FindingCard } from "./FindingCard";
import { SilenceCard } from "./SilenceCard";
import "./findingsI18n";

export interface FindingsPanelProps {
  report: FindingsReport;
  currency?: string;
  /** Rendered inside a statement's Notes panel — heading suppressed. */
  compact?: boolean;
  onDismiss?: (dismissal: FindingDismissal) => void;
  onComparePeriods?: (finding: Finding) => void;
}

export function FindingsPanel({
  report,
  currency,
  compact = false,
  onDismiss,
  onComparePeriods,
}: FindingsPanelProps) {
  const { t } = useTranslation();
  const pack = useExportPack();

  if (!report.hasContractRows) return null;

  const packed = report.surfaced.filter((f) => pack.includes(f.key)).length;
  const heldBack = report.counts.heldBack;
  const totalCandidates = report.counts.surfaced + heldBack;

  return (
    <div className="space-y-4" data-testid="fnd-panel">
      {compact ? null : (
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-[17px] font-semibold text-ink">{t("fnd.heading")}</h2>
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-mute">
            {t("fnd.headingSub", { count: report.surfaced.length })}
          </p>
        </header>
      )}

      {/* WHY THE ORDER LOOKS LIKE THAT. The queue is scored, not sorted
          by severity, so a MEDIUM can sit above a HIGH — which reads as
          a bug unless the rule is stated. Pro shows each card's
          multiplicands; this line is the one-sentence version, and it
          appears wherever a reader can see two cards at once. */}
      {!compact && report.surfaced.length > 1 ? (
        <p className="max-w-[80ch] text-[12px] leading-relaxed text-ink-mute">
          {t("fnd.rankNote")}
        </p>
      ) : null}

      {report.surfaced.length > 0 ? (
        <>
          {report.surfaced.map((f) => (
            <FindingCard
              key={f.key}
              finding={f}
              compact={compact}
              onDismiss={onDismiss}
              onComparePeriods={onComparePeriods}
            />
          ))}

          {heldBack > 0 && report.cap ? (
            <p className="text-[12px] leading-relaxed text-ink-mute">
              {t("fnd.capNote", {
                shown: report.surfaced.length,
                total: totalCandidates,
              })}
            </p>
          ) : null}
        </>
      ) : (
        <SilenceCard report={report} currency={currency} />
      )}

      {/* The info tier: complete findings that did not clear the
          materiality floor. Rendered UNDER a label that says so — an
          unlabelled card here reads as a recommendation, which is the
          "sixty findings is the same as none" failure returning through
          the side door. */}
      {report.info.length > 0 ? (
        <div className="space-y-3" data-testid="fnd-info-rows">
          <div className="pt-1">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-mute">
              {t("fnd.infoTier.title")} · {report.info.length}
            </p>
            <p className="mt-1 max-w-[70ch] text-[12px] leading-relaxed text-ink-soft">
              {t("fnd.infoTier.note")}
            </p>
          </div>
          {report.info.map((f) => (
            <FindingCard key={f.key} finding={f} compact onDismiss={onDismiss} />
          ))}
        </div>
      ) : null}

      {report.surfaced.length > 0 ? (
        <AllChecksList report={report} currency={currency} />
      ) : null}

      {packed > 0 ? (
        <p
          className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-mute"
          data-testid="fnd-pack-count"
        >
          {t("fnd.act.packCount", { count: packed })}
        </p>
      ) : null}
    </div>
  );
}
