// Every served ratio in one table: [current] [prior] [change] [band now]
// [band prior] [band movement], the census rows in served order, then
// Altman Z″, the composite credit score and the letter grade, then the
// credit sub-scores as supporting detail.
//
// Each cell is a string from `printRatioRow` (lib/ratioCompareView.ts),
// which is the one formatter over the served rows. Each row embeds the
// served row as `data-ratio-cmp-json` (the bytes the report embeds for the
// same row) and its printed form as `data-ratio-printed-json`; the six
// cells carry the report's `data-cell` ids, so the tab, the report and the
// workbook are held byte-equal cell by cell (ratioTableByteMatch.test.tsx).
// Nothing here formats a number.

import { useTranslation } from "react-i18next";

import { comparisonRefusalKey } from "@/lib/comparisonRefusal";

import type { ChipTone } from "@/components/instrument/Panel";
import {
  RATIO_DELTA_SECONDARY_CLOSE,
  RATIO_DELTA_SECONDARY_OPEN,
  ratioCompareHeadingsFor,
} from "@/lib/ratioTable";
import {
  printRatioRow,
  ratioCmpHandleOf,
  ratioGroupLabel,
  ratioKeysInServedOrder,
  serializePrintedRow,
  type PrintedRatioRow,
  type RatioCompareView,
} from "@/lib/ratioCompareView";

/** A band badge's fill by served tone (`bandTone`): the tile and the
 *  drawer badge read this one table. */
export const BADGE_BY_TONE: Record<string, string> = {
  success: "anim-fill-green border-brand/40",
  caution: "anim-fill-amber border-amber-500/40",
  alert: "anim-fill-red border-red-500/40",
  neutral: "border-rule text-ink-mute",
};

export function toneText(tone: ChipTone): string {
  switch (tone) {
    case "success":
      return "text-success";
    case "alert":
      return "text-alert";
    case "caution":
      return "text-caution";
    default:
      return "text-ink-soft";
  }
}

/** Why no prior is printed, when none is: said once, in the reader's
 *  language, never left to an empty column. A refusal is the sentence for
 *  the engine's refusal CODE — never the engine's message, which can carry
 *  a raw period id (lib/comparisonRefusal.ts). */
export function PriorStateNote({ view }: { view: RatioCompareView }) {
  const { t } = useTranslation();
  const p = view.prior;
  if (p.kind === "compared") return null;
  const text =
    p.kind === "refused"
      ? t("statements.ratioCmp.ui.comparisonRefused", { message: t(comparisonRefusalKey(p.code)) })
      : p.kind === "without_ratios"
        ? t("statements.ratioCmp.ui.comparisonWithoutRatios", { prior: p.priorLabel })
        : p.kind === "loading"
          ? t("statements.ratioCmp.ui.comparisonLoading", { current: view.currentLabel })
          : p.kind === "failed"
            ? p.status > 0
              ? t("statements.ratioCmp.ui.comparisonFailed", { status: p.status, current: view.currentLabel })
              : t("statements.ratioCmp.ui.comparisonFailedNoResponse", { current: view.currentLabel })
            : t("statements.ratioCmp.ui.noComparison", { current: view.currentLabel });
  return (
    <p className="text-[12px] text-ink-soft leading-snug" data-testid="ratio-prior-state" data-prior-state={p.kind}>
      {text}
    </p>
  );
}

function Row({ row, compared, view }: { row: PrintedRatioRow; compared: boolean; view: RatioCompareView }) {
  const { i18n } = useTranslation();
  return (
    <tr
      className="border-t border-rule-soft align-top"
      data-testid="ratio-compare-row"
      data-ratio-key={row.key}
      data-movement={row.movementStatus ?? "none"}
      data-ratio-cmp-json={ratioCmpHandleOf(view, row.key)}
      data-ratio-printed-json={serializePrintedRow(row)}
    >
      <th scope="row" className="py-1.5 pr-3 text-left font-normal text-ink">
        <div>{row.label}</div>
        {/* The served group, in the reader's words. Census rows are served
            in the engine's order, which is not grouped (net_debt_to_ebitda
            follows the efficiency rows), so the group rides on each row
            rather than as headings that would repeat. Listed rows naming a
            key no row serves carry no group. */}
        {row.group ? (
          <div className="text-[10px] uppercase tracking-[0.06em] text-ink-mute" data-col="group">
            {ratioGroupLabel(row.group, i18n.language)}
          </div>
        ) : null}
      </th>
      <td className="py-1.5 px-3 text-right font-mono tabular-nums text-ink" data-col="current" data-cell="current">{row.current}</td>
      {compared ? (
        <>
          <td className="py-1.5 px-3 text-right font-mono tabular-nums text-ink-soft" data-col="prior" data-cell="prior">{row.prior}</td>
          <td className={`py-1.5 px-3 text-right font-mono tabular-nums ${toneText(row.deltaTone)}`} data-cell="delta">
            <div data-col="delta">{row.delta}</div>
            {row.deltaSecondary ? (
              // The turns change's percent, on its own line, as the same
              // bytes the report and workbook print in one cell
              // (`joinRatioDelta`): the cell's text is "+0.28× (+15.4%)".
              <div className="text-[11px] text-ink-mute">
                {RATIO_DELTA_SECONDARY_OPEN}
                <span data-col="delta_secondary">{row.deltaSecondary}</span>
                {RATIO_DELTA_SECONDARY_CLOSE}
              </div>
            ) : null}
          </td>
          <td className="py-1.5 px-3 text-ink" data-col="band_now" data-cell="band-now">{row.bandNow}</td>
          <td className="py-1.5 px-3 text-ink-soft" data-col="band_prior" data-cell="band-prior">{row.bandPrior}</td>
          <td className={`py-1.5 pl-3 ${toneText(row.movementTone)}`} data-col="movement" data-cell="movement">{row.movement}</td>
        </>
      ) : (
        <td className="py-1.5 px-3 text-ink" data-col="band_now" data-cell="band-now">{row.bandNow}</td>
      )}
    </tr>
  );
}

export function RatioComparisonTable({ view }: { view: RatioCompareView }) {
  const { t, i18n } = useTranslation();
  const loc = i18n.language;
  const compared = view.comparison !== null;
  const keys = ratioKeysInServedOrder(view);
  const print = (ks: string[]) =>
    ks.map((k) => printRatioRow(view, k, loc)).filter((r): r is PrintedRatioRow => r !== null);
  const census = print(keys.census);
  const composites = print(keys.composites);
  const subscores = print(keys.subscores);
  const cols = compared ? 7 : 3;
  const priorLabel = view.priorLabel ?? "";
  const headings = ratioCompareHeadingsFor(view.currentLabel, priorLabel, i18n.language);
  return (
    <section
      className="space-y-2"
      data-testid="ratio-compare-table"
      data-prior-state={view.prior.kind}
      data-rows={census.length + composites.length + subscores.length}
    >
      <h2 className="text-[10.5px] uppercase tracking-[0.14em] text-ink-soft font-semibold">
        {compared
          ? t("statements.ratioCmp.ui.tableTitle", { current: view.currentLabel, prior: priorLabel })
          : view.currentLabel}
      </h2>
      <p className="text-[12px] text-ink-mute leading-snug max-w-[860px]">{t("statements.ratioCmp.ui.tableCaption")}</p>
      <PriorStateNote view={view} />
      <div className="overflow-x-auto rounded-md border border-rule bg-surface">
        <table className="w-full min-w-[760px] text-[12.5px]">
          <thead>
            <tr className="bg-bg-2/40 text-[10.5px] uppercase tracking-[0.06em] text-ink-mute">
              <th scope="col" className="py-2 pr-3 pl-0 text-left font-medium">{t("statements.ratioCmp.ui.colRatio")}</th>
              <th scope="col" className="py-2 px-3 text-right font-medium">{view.currentLabel}</th>
              {compared ? (
                <>
                  {/* The heading words are the one authority the report
                      and the workbook print (`ratioCompareHeadingsFor`). */}
                  <th scope="col" className="py-2 px-3 text-right font-medium">{headings[1]}</th>
                  <th scope="col" className="py-2 px-3 text-right font-medium">{headings[2]}</th>
                  <th scope="col" className="py-2 px-3 text-left font-medium">{headings[3]}</th>
                  <th scope="col" className="py-2 px-3 text-left font-medium">{headings[4]}</th>
                  <th scope="col" className="py-2 pl-3 text-left font-medium">{headings[5]}</th>
                </>
              ) : (
                <th scope="col" className="py-2 px-3 text-left font-medium">{headings[3]}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {census.map((r) => <Row key={r.key} row={r} compared={compared} view={view} />)}
          </tbody>
          {composites.length > 0 ? (
            <tbody data-testid="ratio-compare-composites">
              <tr><th colSpan={cols} scope="colgroup" className="pt-3 pb-1 text-left text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">{t("statements.ratioCmp.ui.compositesTitle")}</th></tr>
              {composites.map((r) => <Row key={r.key} row={r} compared={compared} view={view} />)}
            </tbody>
          ) : null}
          {subscores.length > 0 ? (
            <tbody data-testid="ratio-compare-subscores">
              <tr><th colSpan={cols} scope="colgroup" className="pt-3 pb-1 text-left text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">{t("statements.ratioCmp.ui.subscoresTitle")}</th></tr>
              {subscores.map((r) => <Row key={r.key} row={r} compared={compared} view={view} />)}
            </tbody>
          ) : null}
        </table>
      </div>
    </section>
  );
}
