// Every served ratio in one table: [current] [prior] [change] [band now]
// [band prior] [band movement], the census rows in served order, then
// Altman Z″, the composite credit score and the letter grade, then the
// credit sub-scores as supporting detail.
//
// Each cell is a string from `printRatioRow` (lib/ratioCompareView.ts),
// which is the one formatter over the served rows; each row embeds that
// printed form as `data-ratio-cmp-json` so the report and the workbook
// can be held byte-equal to it. Nothing here formats a number.

import { useTranslation } from "react-i18next";

import type { ChipTone } from "@/components/instrument/Panel";
import {
  printRatioRow,
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
 *  language, never left to an empty column. */
export function PriorStateNote({ view }: { view: RatioCompareView }) {
  const { t } = useTranslation();
  const p = view.prior;
  if (p.kind === "compared") return null;
  const text =
    p.kind === "refused"
      ? t("statements.ratioCmp.ui.comparisonRefused", { message: p.message })
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

function Row({ row, compared }: { row: PrintedRatioRow; compared: boolean }) {
  const { i18n } = useTranslation();
  return (
    <tr
      className="border-t border-rule-soft align-top"
      data-testid="ratio-compare-row"
      data-ratio-key={row.key}
      data-movement={row.movementStatus ?? "none"}
      data-ratio-cmp-json={serializePrintedRow(row)}
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
      <td className="py-1.5 px-3 text-right font-mono tabular-nums text-ink" data-col="current">{row.current}</td>
      {compared ? (
        <>
          <td className="py-1.5 px-3 text-right font-mono tabular-nums text-ink-soft" data-col="prior">{row.prior}</td>
          <td className={`py-1.5 px-3 text-right font-mono tabular-nums ${toneText(row.deltaTone)}`}>
            <div data-col="delta">{row.delta}</div>
            {row.deltaSecondary ? (
              <div className="text-[11px] text-ink-mute" data-col="delta_secondary">{row.deltaSecondary}</div>
            ) : null}
          </td>
          <td className="py-1.5 px-3 text-ink" data-col="band_now">{row.bandNow}</td>
          <td className="py-1.5 px-3 text-ink-soft" data-col="band_prior">{row.bandPrior}</td>
          <td className={`py-1.5 pl-3 ${toneText(row.movementTone)}`} data-col="movement">{row.movement}</td>
        </>
      ) : (
        <td className="py-1.5 px-3 text-ink" data-col="band_now">{row.bandNow}</td>
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
                  <th scope="col" className="py-2 px-3 text-right font-medium">{priorLabel}</th>
                  <th scope="col" className="py-2 px-3 text-right font-medium">{t("statements.ratioCmp.ui.colChange")}</th>
                  <th scope="col" className="py-2 px-3 text-left font-medium">{t("statements.ratioCmp.ui.colBandNow", { label: view.currentLabel })}</th>
                  <th scope="col" className="py-2 px-3 text-left font-medium">{t("statements.ratioCmp.ui.colBandPrior", { label: priorLabel })}</th>
                  <th scope="col" className="py-2 pl-3 text-left font-medium">{t("statements.ratioCmp.ui.colMovement")}</th>
                </>
              ) : (
                <th scope="col" className="py-2 px-3 text-left font-medium">{t("statements.ratioCmp.ui.colBandNow", { label: view.currentLabel })}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {census.map((r) => <Row key={r.key} row={r} compared={compared} />)}
          </tbody>
          {composites.length > 0 ? (
            <tbody data-testid="ratio-compare-composites">
              <tr><th colSpan={cols} scope="colgroup" className="pt-3 pb-1 text-left text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">{t("statements.ratioCmp.ui.compositesTitle")}</th></tr>
              {composites.map((r) => <Row key={r.key} row={r} compared={compared} />)}
            </tbody>
          ) : null}
          {subscores.length > 0 ? (
            <tbody data-testid="ratio-compare-subscores">
              <tr><th colSpan={cols} scope="colgroup" className="pt-3 pb-1 text-left text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">{t("statements.ratioCmp.ui.subscoresTitle")}</th></tr>
              {subscores.map((r) => <Row key={r.key} row={r} compared={compared} />)}
            </tbody>
          ) : null}
        </table>
      </div>
    </section>
  );
}
