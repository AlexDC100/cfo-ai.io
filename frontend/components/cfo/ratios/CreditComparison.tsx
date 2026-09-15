// The credit composites against the prior period, and the as-filed
// disclosure, for the dashboard hero and the Risks tab.
//
// Both read the served documents only: the three composite rows
// (Altman Z″, composite credit score, letter grade) of the comparatives
// `ratios` block, printed through the one formatter, and the current
// period's served credit block (`assembled_metrics.ratio_table.credit`)
// for the as-filed sentence, which renders only when the engine says the
// filed composite differs from the served one.
//
// A prior composite the engine could not score prints the engine's
// reason; nothing here renders a dash, and no second credit model runs
// for the prior.

import { useTranslation } from "react-i18next";

import { useRatioCompareView } from "@/components/cfo/ComparativesPanel";
import { PriorStateNote, toneText } from "@/components/cfo/ratios/RatioComparisonTable";
import {
  asFiledSentence,
  printCreditComparison,
  serializePrintedRow,
} from "@/lib/ratioCompareView";

export function CreditComparison({ surface }: { surface: "hero" | "risks" }) {
  const { t, i18n } = useTranslation();
  const view = useRatioCompareView();
  if (!view) return null;
  const loc = i18n.language;
  const rows = printCreditComparison(view, loc);
  const asFiled = asFiledSentence(view.periodTable?.credit ?? null, loc);
  if (rows.length === 0 && asFiled === null && view.prior.kind === "no_comparison") return null;
  return (
    <div
      className="mt-4 border-t border-rule pt-3 text-[12px] text-ink-soft"
      data-testid={`credit-comparison-${surface}`}
      data-prior-state={view.prior.kind}
    >
      {rows.length > 0 ? (
        <>
          <div className="text-[10.5px] font-mono uppercase tracking-[0.08em] text-ink-mute mb-1.5">
            {t("statements.ratioCmp.ui.creditAgainst", {
              prior: view.priorLabel ?? "",
              current: view.currentLabel,
            })}
          </div>
          <dl className="grid gap-1.5 sm:grid-cols-3">
            {rows.map((r) => (
              <div
                key={r.key}
                data-testid={`credit-prior-${r.key}`}
                data-ratio-key={r.key}
                data-ratio-prior={r.priorStatus}
                data-ratio-cmp-json={serializePrintedRow(r)}
              >
                <dt className="text-ink-mute">{r.label}</dt>
                <dd className="font-mono tabular-nums text-ink">
                  <span data-col="prior">{r.prior}</span>
                  <span aria-hidden className="mx-1 text-ink-mute">→</span>
                  <span data-col="current">{r.current}</span>
                </dd>
                <dd className={`font-mono tabular-nums text-[11.5px] ${toneText(r.deltaTone)}`}>
                  <span data-col="delta">{r.delta}</span>
                  {r.deltaSecondary ? <span className="ml-1 text-ink-mute" data-col="delta_secondary">{r.deltaSecondary}</span> : null}
                </dd>
                <dd className={`text-[11.5px] ${toneText(r.movementTone)}`} data-col="movement">
                  {r.movement}
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <PriorStateNote view={view} />
      )}
      {asFiled !== null ? (
        <p className="mt-2 text-[11.5px] text-caution leading-snug" data-testid={`credit-as-filed-${surface}`}>
          {asFiled}
        </p>
      ) : null}
    </div>
  );
}
