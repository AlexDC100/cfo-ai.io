// THE ARTIFACTS — 7/8 COMPARISON. Period vs period, company vs peer.
//
// The one thing this card must never do is put two rulers side by side
// and call the gap a difference. A US_GAAP filer and an IFRS filer
// capitalise leases, revenue and goodwill differently; their EBITDA
// margins are not the same measurement, so the space between them is
// not a result. `benchmarkGroups.computeBenchmarkStats` THROWS on a
// heterogeneous cohort rather than asking callers to be careful, and
// this card inherits that posture: `guardArtifactSpec` REFUSES a
// comparison whose columns declare more than one accounting standard,
// and refuses one that mixes currencies.
//
// So by the time this component runs there is exactly one standard, and
// the card's job is to NAME it. A comparison that is honest but silent
// about its basis leaves the reader to assume — and the assumption they
// make is the blend we just refused to draw.

import { useTranslation } from "react-i18next";

import "./artifactI18n";
import { ArtifactFigure } from "./ArtifactFigure";
import { artifactLabel } from "./artifactI18n";
import type { ComparisonSpec } from "./artifactSpec";
import {
  figuresOf,
  resolveComparison,
  type ResolvedComparison,
  type ResolvedFigure,
} from "./artifactResolve";
import type { CapsuleEvidence } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerTypes";

const BASIS_KEY: Record<ResolvedComparison["basis"], string> = {
  period: "artifact.comparison.basis.period",
  peer: "artifact.comparison.basis.peer",
  budget: "artifact.comparison.basis.budget",
  scenario: "artifact.comparison.basis.scenario",
};

export function ComparisonArtifact({ comparison }: { comparison: ResolvedComparison }) {
  const { t } = useTranslation();

  return (
    <div data-testid="artifact-comparison" data-comparison-basis={comparison.basis}>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-mute">
        <span data-testid="artifact-comparison-basis">{t(BASIS_KEY[comparison.basis])}</span>
        {comparison.standard && (
          <span data-testid="artifact-comparison-standard" className="text-ink-soft">
            {t("artifact.comparison.oneRuler", { standard: comparison.standard })}
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[360px] border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-rule">
              <th scope="col" className="py-1.5 pr-3 text-left font-mono text-[10px] font-normal uppercase tracking-[0.06em] text-ink-mute" />
              {comparison.columns.map((c, i) => (
                <th
                  key={i}
                  scope="col"
                  className="py-1.5 pl-3 text-right font-mono text-[10px] font-normal uppercase tracking-[0.06em] text-ink-mute"
                >
                  {artifactLabel(t, c.label)}
                  {c.currency && (
                    <span className="ml-1 text-ink-faint">{c.currency}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((label, ri) => (
              <tr key={ri} className="border-b border-rule-soft last:border-0">
                <th
                  scope="row"
                  className="py-1.5 pr-3 text-left text-[12px] font-normal text-ink-soft"
                >
                  {artifactLabel(t, label)}
                </th>
                {comparison.columns.map((c, ci) => (
                  <td key={ci} className="py-1.5 pl-3 text-right align-baseline">
                    <ArtifactFigure figure={c.cells[ri] ?? { present: false, fact: null }} className="text-ink" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function comparisonFrom(
  spec: ComparisonSpec,
  evidence: CapsuleEvidence,
  trust: string | null = null,
) {
  const { artifact, comparison } = resolveComparison(spec, evidence, trust);
  return { artifact, comparison, figures: figuresOf(comparison) };
}
