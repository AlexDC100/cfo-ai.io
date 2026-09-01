// THE ARTIFACTS — 8/8 FINDING. An Anomaly Radar finding, in the thread.
//
// Two halves.
//
// THE FINDING ITSELF is rendered from the engine's own template through
// `NarrativeText` — the same path the Radar uses — so the figures inside
// the sentence are the engine's, resolved through the money path, and
// the claim cannot straddle a conversion boundary. This component never
// re-words a finding; a finding whose wording is the model's is a
// different finding.
//
// "RECOMPUTE WITHOUT THIS ITEM" is the half that earns the card. A
// finding says "account 461 holds X, 19.6% of total assets"; the
// question a CFO actually asks next is "and where does that leave the
// ratio if I take it out". `artifactScenario.evaluateExclusion` answers
// it by subtracting the item's own amount from the metric's MONEY
// operands and re-running the same registry formula — and it REFUSES
// rather than guesses in three named ways:
//
//   · the item carries no money amount to remove;
//   · removing it would take an operand below the amount removed (a
//     counterfactual that invents a sign flip);
//   · the recomputation itself refused (absent or zero operand).
//
// Each refusal is printed by name. A counterfactual that is quietly
// wrong is worse than one that is absent, because the reader has no way
// to tell the difference from the shape of the answer.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Amount } from "@/components/instrument/Amount";
import { NarrativeText } from "@/lib/narrativeMoney";
import type { Finding } from "@/lib/findings";
// One narrowing helper for the whole app: the engine's `sourceCurrency`
// is a free string, and `NarrativeText` takes the three-member union.
// Reusing the findings lane's narrower rather than writing a second one
// keeps a currency this build does not know falling back to RON in
// exactly one place.
import { asCurrency } from "@/components/cfo/findings/parts";

import "./artifactI18n";
import { artifactLabel } from "./artifactI18n";
import { amountKindFor, ArtifactFigure } from "./ArtifactFigure";
import type { FindingSpec } from "./artifactSpec";
import { citationFrom, makeResolver, type ResolvedArtifact } from "./artifactResolve";
import { evaluateExclusion } from "./artifactScenario";
import type { CapsuleEvidence } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerTypes";

const SEVERITY_CLASS: Record<string, string> = {
  critical: "border-alert/40 bg-alert-tint text-alert",
  high: "border-caution/40 bg-caution-tint text-caution",
  medium: "border-rule bg-bg-2 text-ink-soft",
  low: "border-rule bg-bg-2 text-ink-mute",
  info: "border-rule bg-bg-2 text-ink-mute",
};

export interface FindingArtifactProps {
  spec: FindingSpec;
  evidence: CapsuleEvidence;
  /** The engine's own finding row, supplied by the host. Absent when
   *  the thread pulled a finding this build no longer holds — the card
   *  then shows only the cited figures, never an invented headline. */
  finding?: Finding | null;
}

export function FindingArtifact({ spec, evidence, finding }: FindingArtifactProps) {
  const { t } = useTranslation();
  const resolver = useMemo(() => makeResolver(evidence), [evidence]);

  const exclusion = useMemo(() => {
    if (!spec.recomputeMetric || !spec.recomputeExclude) return null;
    return evaluateExclusion(evidence, spec.recomputeMetric, spec.recomputeExclude);
  }, [evidence, spec.recomputeMetric, spec.recomputeExclude]);

  const severity = finding?.effectiveSeverity ?? finding?.severity ?? "info";

  return (
    <div data-testid="artifact-finding" data-finding-key={spec.findingKey}>
      {finding && (
        <div
          data-testid="artifact-finding-severity"
          className={`mb-2 inline-block rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] ${
            SEVERITY_CLASS[severity] ?? SEVERITY_CLASS.info
          }`}
        >
          {severity}
        </div>
      )}

      {finding && (
        // The engine's own words, through the engine's own money path.
        <div data-testid="artifact-finding-body" className="text-[13px] leading-relaxed text-ink-soft">
          <NarrativeText
            text={finding.body ?? ""}
            template={finding.bodyTemplate}
            facts={finding.factsCited}
            factUnits={finding.factUnits}
            sourceCurrency={asCurrency(finding.sourceCurrency)}
          />
        </div>
      )}

      {/* The cited figures, restated as a strip so they can be scanned
          and hovered for provenance without re-reading the sentence. */}
      <dl
        data-testid="artifact-finding-facts"
        className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3"
      >
        {spec.facts.map((fact, i) => {
          const figure = resolver.figure(fact, spec.factLabels?.[i]);
          return (
            <div key={fact} className="min-w-0">
              <dt className="truncate font-mono text-[10px] uppercase tracking-[0.06em] text-ink-mute">
                {artifactLabel(t, spec.factLabels?.[i] ?? fact)}
              </dt>
              <dd className="text-[13px]">
                <ArtifactFigure figure={figure} className="text-ink" />
              </dd>
            </div>
          );
        })}
      </dl>

      {exclusion && (
        <div
          data-testid="artifact-finding-recompute"
          data-refusal={exclusion.refusal ?? "none"}
          className="mt-3 rounded-sm border border-rule bg-bg-2 px-3 py-2"
        >
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-mute">
            {t("artifact.finding.recompute")}
          </div>
          {exclusion.refusal ? (
            <p className="mt-1 text-[11.5px] text-caution">
              {t(`artifact.finding.refusal.${exclusion.refusal}`)}
            </p>
          ) : (
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <span className="inline-flex items-baseline gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
                  {t("artifact.finding.withItem")}
                </span>
                <span data-fact={exclusion.outputId} data-unit={exclusion.unit} data-derived="served">
                  <Amount
                    value={exclusion.withItem}
                    kind={amountKindFor(exclusion.unit)}
                    className="text-ink-soft"
                  />
                </span>
              </span>
              <span className="inline-flex items-baseline gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-faint">
                  {t("artifact.finding.withoutItem")}
                </span>
                <span
                  data-fact={`${exclusion.outputId}__excluding_${spec.recomputeExclude ?? ""}`}
                  data-unit={exclusion.unit}
                  data-derived="exclusion"
                >
                  <Amount
                    value={exclusion.withoutItem}
                    kind={amountKindFor(exclusion.unit)}
                    className="text-ink"
                  />
                </span>
              </span>
              <span className="font-mono text-[10px] text-ink-faint">
                {t("artifact.finding.touched", { operands: exclusion.touched.join(", ") })}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function findingFrom(
  spec: FindingSpec,
  evidence: CapsuleEvidence,
  trust: string | null = null,
): ResolvedArtifact {
  return { spec, citation: citationFrom(evidence, trust), unresolved: [] };
}
