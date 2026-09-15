// The headline of the Ratios page: which ratios crossed a band between
// the prior period and this one.
//
// The lists are the served `band_movements.improved` and `.deteriorated`
// keys IN SERVED ORDER (the engine ranks them); the order sentence under
// them is the served `rank_basis.sentence_key`, and the counts are the
// lengths of the served lists beside the served `coverage.both_sides`.
// Nothing crossed prints the served counts rather than an empty box, so
// an empty list can never read as "nothing was checked".

import { useTranslation } from "react-i18next";

import { PriorStateNote, toneText } from "@/components/cfo/ratios/RatioComparisonTable";
import {
  printBandMovements,
  serializePrintedRow,
  type PrintedRatioRow,
  type RatioCompareView,
} from "@/lib/ratioCompareView";

function Item({ row, rank }: { row: PrintedRatioRow; rank: number }) {
  return (
    <li
      className="py-1.5 border-t border-rule-soft first:border-t-0"
      data-testid="band-movement-item"
      data-ratio-key={row.key}
      data-rank={rank}
      data-ratio-cmp-json={serializePrintedRow(row)}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12.5px] text-ink">{row.label}</span>
        <span className={`text-[12px] whitespace-nowrap ${toneText(row.movementTone)}`} data-col="movement">
          {row.movement}
        </span>
      </div>
      <div className="mt-0.5 font-mono tabular-nums text-[11.5px] text-ink-soft">
        <span data-col="prior">{row.prior}</span>
        <span aria-hidden className="mx-1 text-ink-mute">→</span>
        <span data-col="current">{row.current}</span>
        <span className={`ml-2 ${toneText(row.deltaTone)}`} data-col="delta">{row.delta}</span>
        {row.deltaSecondary ? <span className="ml-1 text-ink-mute" data-col="delta_secondary">{row.deltaSecondary}</span> : null}
      </div>
    </li>
  );
}

export function BandMovementLists({ view }: { view: RatioCompareView }) {
  const { t, i18n } = useTranslation();
  const printed = printBandMovements(view, i18n.language);
  if (!printed) {
    return (
      <section data-testid="band-movements" data-prior-state={view.prior.kind}>
        <PriorStateNote view={view} />
      </section>
    );
  }
  const c = printed.counts;
  const nothing = c.improved === 0 && c.deteriorated === 0;
  const prior = view.priorLabel ?? "";
  return (
    <section
      className="rounded-md border border-rule bg-surface p-4 space-y-3"
      data-testid="band-movements"
      data-prior-state={view.prior.kind}
      data-improved={c.improved}
      data-deteriorated={c.deteriorated}
    >
      <h2 className="text-[10.5px] uppercase tracking-[0.14em] text-ink-soft font-semibold">
        {t("statements.ratioCmp.ui.movementsTitle", { prior, current: view.currentLabel })}
      </h2>
      {nothing ? (
        <p className="text-[12.5px] text-ink" data-testid="band-movements-nothing">
          {t("statements.ratioCmp.ui.nothingCrossed", { prior, current: view.currentLabel })}
        </p>
      ) : null}
      <p className="text-[12px] text-ink-soft" data-testid="band-movements-counts">
        {t("statements.ratioCmp.ui.movementsCounts", {
          improved: c.improved,
          deteriorated: c.deteriorated,
          unchanged: c.unchanged,
          notComparable: c.notComparable,
          refused: c.refused,
          bothSides: c.bothSides,
        })}
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <div data-testid="band-improved">
          <h3 className="text-[10.5px] font-mono uppercase tracking-[0.08em] text-success mb-1">
            {t("statements.ratioCmp.ui.improvedTitle")}
          </h3>
          {printed.improved.length === 0 ? (
            <p className="text-[12px] text-ink-mute">{t("statements.ratioCmp.ui.improvedEmpty")}</p>
          ) : (
            <ol>{printed.improved.map((r, i) => <Item key={r.key} row={r} rank={i + 1} />)}</ol>
          )}
        </div>
        <div data-testid="band-deteriorated">
          <h3 className="text-[10.5px] font-mono uppercase tracking-[0.08em] text-alert mb-1">
            {t("statements.ratioCmp.ui.deterioratedTitle")}
          </h3>
          {printed.deteriorated.length === 0 ? (
            <p className="text-[12px] text-ink-mute">{t("statements.ratioCmp.ui.deterioratedEmpty")}</p>
          ) : (
            <ol>{printed.deteriorated.map((r, i) => <Item key={r.key} row={r} rank={i + 1} />)}</ol>
          )}
        </div>
      </div>
      <p className="text-[11px] text-ink-mute leading-snug" data-testid="band-movements-rank-basis">
        {t("statements.ratioCmp.ui.rankBasisLead", { sentence: printed.rankBasis })}
      </p>
    </section>
  );
}
