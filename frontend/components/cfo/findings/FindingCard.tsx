// THE CONTRACT, MADE VISIBLE.
//
// One card, seven regions, each labelled with the element it renders:
// subject and evidence with provenance dots, the threshold that was
// breached, the quantified impact, why it matters for THIS profile, the
// action checklist, and the confidence caveat. The measured baseline
// (design_review/findings/BASELINE.md) scored 1.5 of these seven on its
// worked example, and the reason it could was that the prose was
// authored beside the elements instead of built from them. Here the
// layout has a slot per element, so a missing element is a visible hole
// rather than a sentence that quietly says less.
//
// It cannot come to that on a surfaced card: `_finding.to_payload`
// refuses to write prose for an incomplete finding, and `surfacedOf`
// re-checks the seven on arrival. A card that somehow reached this
// component incomplete renders its holes honestly instead of hiding
// them — that is what `MissingSlot` is for.
//
// SIMPLE vs PRO is a presentation dial over ONE payload. Simple shows a
// plain-language headline built from the same typed values (subject
// scope, observed, comparator, limit — two figures, so the F2 floor
// still holds on screen) plus exactly ONE action. Pro adds the rule id,
// the threshold with its source file, the recomputed ratio, the profile
// signals and the score breakdown. Neither mode branches on data:
// nothing is shown in one that was computed differently for the other.

import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";

import { ProvenanceAffordance } from "@/components/instrument/Provenance";
import { NarrativeText } from "@/lib/narrativeMoney";
import { useIsSimple } from "@/lib/viewMode";
import {
  type Finding,
  type FindingDismissal,
  type ContractElement,
} from "@/lib/findings";

import { ActionChecklist } from "./ActionChecklist";
import { EvidenceLine } from "./EvidenceLine";
import { FindingActions } from "./FindingActions";
import { ImpactRow } from "./ImpactRow";
import {
  ThresholdMeter,
  comparatorWord,
  thresholdLimitProvenance,
  thresholdObservedProvenance,
} from "./ThresholdMeter";
import {
  ABSENT,
  Chip,
  ElementLabel,
  FigureValue,
  asCurrency,
  findingProvenance,
  toneFor,
} from "./parts";
import "./findingsI18n";

export interface FindingCardProps {
  finding: Finding;
  /** Rendered inside a statement's Notes panel: tighter, no score row. */
  compact?: boolean;
  onDismiss?: (dismissal: FindingDismissal) => void;
  onComparePeriods?: (finding: Finding) => void;
}

export function FindingCard({
  finding,
  compact = false,
  onDismiss,
  onComparePeriods,
}: FindingCardProps) {
  const { t } = useTranslation();
  const simple = useIsSimple();
  const [recomputed, setRecomputed] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const tone = toneFor(finding.effectiveSeverity);
  const currency = asCurrency(finding.sourceCurrency);
  const { subject, evidence, threshold, impact, why_here, action, confidence } =
    finding.elements;
  const facts = finding.factsCited;
  const units = finding.factUnits;
  const full = !simple || expanded;
  // The finding's own provenance, mapped once. The evidence figures, the
  // observed threshold value and both impact endpoints all descend from
  // it; the limit's origin comes from the threshold itself.
  const origin = findingProvenance(evidence?.provenance);

  return (
    <article
      className={`overflow-hidden rounded-md border bg-surface ${
        finding.dismissed ? "border-rule opacity-70" : "border-rule"
      }`}
      data-testid={`fnd-card-${finding.ruleKey}`}
      data-severity={finding.effectiveSeverity}
      data-mode={simple ? "simple" : "pro"}
    >
      <div className="flex">
        <div className={`w-[3px] shrink-0 ${tone.rail}`} aria-hidden="true" />
        <div className="min-w-0 flex-1 p-4 sm:p-5">
          {/* ── meta ─────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <Chip
              tone={
                finding.effectiveSeverity === "critical" || finding.effectiveSeverity === "high"
                  ? "alert"
                  : finding.effectiveSeverity === "medium"
                    ? "caution"
                    : "quiet"
              }
            >
              {finding.effectiveSeverity}
            </Chip>
            {!simple && finding.rank > 0 ? (
              <Chip tone="quiet">{t("fnd.rank", { n: finding.rank })}</Chip>
            ) : null}
            {!simple ? (
              <span
                className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute"
                title={t("fnd.ruleId")}
              >
                {finding.ruleKey}
              </span>
            ) : null}
            {/* Materiality is a Pro concept: "19.63% of total assets
                (floor 0.50%, material)" is the policy that let this row
                through, not something a Simple reader acts on. It stays
                one disclosure away, never removed. */}
            {!simple && finding.materiality ? (
              <Chip tone="quiet" title={t("fnd.materiality")}>
                {finding.materiality.statement}
              </Chip>
            ) : null}
            {finding.persistenceLabel ? (
              <Chip tone="quiet" title={t("fnd.persistence")}>
                {finding.persistenceLabel}
              </Chip>
            ) : null}
            {finding.narrativeSource === "advisory" ? (
              <Chip tone="info" title={t("fnd.recomputeHint")}>
                advisory wording
              </Chip>
            ) : null}
          </div>

          {/* ── headline ─────────────────────────────────────────── */}
          <h3 className="mt-2 text-[15px] font-medium leading-snug text-ink">
            {simple && threshold && subject ? (
              <Trans
                i18nKey="fnd.simple.headline"
                values={{
                  scope: subject.scope,
                  comparator: comparatorWord(threshold.comparator, t),
                }}
                components={{
                  obs: (
                    <span className={tone.text}>
                      <ProvenanceAffordance
                        provenance={thresholdObservedProvenance(threshold, origin)}
                        value={threshold.observed}
                      >
                        <FigureValue
                          value={threshold.observed}
                          unit={threshold.unit}
                          facts={facts}
                          factUnits={units}
                          currency={currency}
                        />
                      </ProvenanceAffordance>
                    </span>
                  ),
                  lim: (
                    <span>
                      <ProvenanceAffordance
                        provenance={thresholdLimitProvenance(threshold)}
                        value={threshold.limit}
                      >
                        <FigureValue
                          value={threshold.limit}
                          unit={threshold.unit}
                          facts={facts}
                          factUnits={units}
                          currency={currency}
                        />
                      </ProvenanceAffordance>
                    </span>
                  ),
                }}
              />
            ) : (
              <NarrativeText
                text={finding.title}
                template={finding.titleTemplate}
                facts={facts}
                factUnits={units}
                sourceCurrency={currency}
              />
            )}
          </h3>

          {subject ? (
            <p className="mt-1 text-[12px] text-ink-mute">
              {subject.accounts.map((a) => `${a.code} (${a.name})`).join(", ")}
            </p>
          ) : (
            <MissingSlot element="subject" />
          )}

          {finding.dismissed && finding.dismissal ? (
            <p className="mt-2 rounded border-l-2 border-caution bg-caution-tint px-2.5 py-1.5 text-[12px] text-ink">
              {t("fnd.dismiss.dismissedBecause", { reason: finding.dismissal.reason })}
            </p>
          ) : null}

          {/* ── simple: impact + one action ──────────────────────── */}
          {simple && !expanded ? (
            <div className="mt-3 space-y-3">
              {impact ? (
                <ImpactRow
                  impact={impact}
                  currency={currency}
                  facts={facts}
                  factUnits={units}
                  recomputed={recomputed}
                  compact
                  provenance={origin}
                />
              ) : null}
              {action ? <ActionChecklist action={action} limit={1} /> : <MissingSlot element="action" />}
            </div>
          ) : null}

          {/* ── the seven, in full ───────────────────────────────── */}
          {full ? (
            <div className="mt-4 space-y-4">
              {/* `min-w-0` on both columns is load-bearing, not tidiness:
                  a grid item defaults to `min-width: auto`, so the
                  `truncate`d threshold-source path (a single unbreakable
                  dotted string) widened the column past the viewport and
                  the whole card scrolled sideways at 390px. */}
              <div className="grid gap-4 md:grid-cols-2 md:gap-x-6">
                <div className="min-w-0 space-y-4">
                  {evidence ? (
                    <EvidenceLine
                      evidence={evidence}
                      facts={facts}
                      factUnits={units}
                      currency={currency}
                    />
                  ) : (
                    <MissingSlot element="evidence" />
                  )}
                  {threshold ? (
                    <ThresholdMeter
                      threshold={threshold}
                      severity={finding.effectiveSeverity}
                      currency={currency}
                      facts={facts}
                      factUnits={units}
                      showSource={!compact}
                      provenance={origin}
                    />
                  ) : (
                    <MissingSlot element="threshold" />
                  )}
                </div>
                <div className="min-w-0 space-y-4">
                  {impact ? (
                    <ImpactRow
                      impact={impact}
                      currency={currency}
                      facts={facts}
                      factUnits={units}
                      recomputed={recomputed}
                      showMethod={!simple}
                      provenance={origin}
                    />
                  ) : (
                    <MissingSlot element="impact" />
                  )}
                  {why_here ? (
                    <section data-testid="fnd-whyhere">
                      <ElementLabel>{t("fnd.whyHere")}</ElementLabel>
                      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
                        {why_here.rationale}
                      </p>
                      {/* The profile, then its signals — capped. The
                          signal set belongs to the PERIOD's profile, so
                          it is identical on every card; printing all of
                          it three times crowds out the sentence that
                          differs. The rest stay one hover away. */}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Chip tone="brand" title={t("fnd.profile")}>
                          {why_here.profile_label || why_here.profile_id}
                        </Chip>
                        {why_here.signals.slice(0, 2).map((s) => (
                          <Chip key={s} tone="quiet" title={t("fnd.signals")}>
                            {s}
                          </Chip>
                        ))}
                        {why_here.signals.length > 2 ? (
                          <Chip
                            tone="quiet"
                            title={why_here.signals.slice(2).join(", ")}
                          >
                            {t("fnd.moreSignals", {
                              count: why_here.signals.length - 2,
                            })}
                          </Chip>
                        ) : null}
                      </div>
                    </section>
                  ) : (
                    <MissingSlot element="why_here" />
                  )}
                  {action ? <ActionChecklist action={action} /> : <MissingSlot element="action" />}
                </div>
              </div>

              {confidence ? (
                <section
                  className="border-t border-rule pt-3"
                  data-testid="fnd-confidence"
                >
                  <p className="text-[12px] leading-relaxed text-ink-soft">
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-mute">
                      {t("fnd.confidence")}
                    </span>{" "}
                    <span className="font-medium text-ink">
                      {t(`fnd.confidenceLevel_${confidence.level}`, {
                        defaultValue: confidence.level,
                      })}
                    </span>
                    {confidence.caveat ? <> — {confidence.caveat}</> : null}
                    <span className="text-ink-mute"> · {confidence.basis}</span>
                  </p>
                </section>
              ) : (
                <MissingSlot element="confidence" />
              )}

              {finding.contributorSummary ? (
                <p className="text-[12px] leading-relaxed text-ink-mute">
                  {finding.contributorSummary}
                </p>
              ) : null}

              {!simple && finding.score ? (
                <p className="font-mono text-[10px] leading-relaxed text-ink-mute">
                  score {finding.score.total.toFixed(3)} = impact{" "}
                  {finding.score.impact.toFixed(2)} × confidence{" "}
                  {finding.score.confidence.toFixed(2)} × persistence{" "}
                  {finding.score.persistence.toFixed(2)} × actionability{" "}
                  {finding.score.actionability.toFixed(2)}
                </p>
              ) : null}
            </div>
          ) : null}

          {showHistory ? <HistoryStrip finding={finding} /> : null}

          {/* ── controls ─────────────────────────────────────────── */}
          <div className="mt-4 space-y-2">
            {simple ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="inline-flex items-center gap-1.5 text-[12px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                data-testid="fnd-expand"
              >
                <ChevronDown
                  size={13}
                  strokeWidth={2}
                  className={`transition-transform ${expanded ? "rotate-180" : ""}`}
                />
                {expanded ? t("fnd.simple.hideFull") : t("fnd.simple.showFull")}
              </button>
            ) : null}
            <FindingActions
              finding={finding}
              /* Simple keeps the four moves a reader makes on a single
                 finding; comparing periods and assembling an export pack
                 are analyst work and appear once the full check is open. */
              minimal={simple && !expanded}
              recomputed={recomputed}
              onToggleRecompute={() => setRecomputed((v) => !v)}
              showHistory={showHistory}
              onToggleHistory={() => setShowHistory((v) => !v)}
              onDismiss={onDismiss}
              onComparePeriods={onComparePeriods}
            />
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * A contract element the payload did not carry.
 *
 * This should be unreachable on a surfaced card — and saying so out loud
 * is the point. The alternative (render nothing) is exactly how a finding
 * with two of seven elements passed for a finding with seven.
 */
function MissingSlot({ element }: { element: ContractElement }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 rounded border border-dashed border-rule px-2.5 py-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-mute">
        {t(`fnd.contract.${element}`)} — {t("fnd.contract.absent")} {ABSENT}
      </span>
    </div>
  );
}

/**
 * What the engine knows about this finding over time: the persistence
 * count the multi-period lane computed, and the correlated rules that
 * were merged into it. Deliberately not a chart — the payload carries a
 * COUNT, not a series, and drawing a series from a count would be
 * inventing data. The limitation is stated on the strip.
 */
function HistoryStrip({ finding }: { finding: Finding }) {
  const { t } = useTranslation();
  const marks = Array.from({ length: Math.min(finding.persistence, 12) });
  return (
    <section className="mt-4 rounded-md border border-rule bg-bg-2 p-3" data-testid="fnd-history">
      <ElementLabel>{t("fnd.history.title")}</ElementLabel>
      <div className="mt-2 flex items-center gap-1.5">
        {marks.map((_, i) => (
          <span
            key={i}
            className={`h-[18px] w-[8px] rounded-sm ${
              i === marks.length - 1 ? "bg-brand" : "bg-brand-l/50"
            }`}
            title={i === marks.length - 1 ? t("fnd.history.thisPeriod") : t("fnd.history.earlier")}
          />
        ))}
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">
        {t("fnd.history.note", {
          count: finding.persistence,
          root: finding.rootCause || "—",
        })}
      </p>
      {finding.mergedFrom.length ? (
        <p className="mt-1 text-[12px] leading-relaxed text-ink-mute">
          {t("fnd.history.contributors", { rules: finding.mergedFrom.join(", ") })}
        </p>
      ) : null}
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-mute">
        {t("fnd.history.limit")}
      </p>
    </section>
  );
}
