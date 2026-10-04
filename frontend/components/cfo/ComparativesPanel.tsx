// ComparativesPanel — the controls (which prior, which columns) and the
// summary (comparability, the variance bridge, top movers) for two
// periods side by side.
//
// Everything numeric here is the engine's document
// (`/api/period/{id}/comparatives`): the bridge steps, whether the walk
// closes, the movers and their verdicts, the materiality floor. This
// file formats and refuses; it computes nothing a reader could disagree
// with.
import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { comparisonRefusalKey } from "@/lib/comparisonRefusal";

import {
  comparisonHasNoPrior,
  detailLevelLabelKey,
  formatDeltaPct,
  previousYearEnd,
  type BridgeDto,
  type ComparativesResponse,
  type MoverDto,
} from "@/lib/comparatives";
import type { OrgPeriod } from "@/lib/orgPeriods";
import type { RatioCompareView } from "@/lib/ratioCompareView";
import { formatPeriodMonth } from "@/lib/orgPeriods";
import { useComparativesView, type ComparativeColumns } from "@/stores/comparativesView";
import { useAmountFormatter } from "@/stores/currency";
import { MONEY_MISSING } from "@/lib/money";

// ── The served ratio documents, for the Ratios tab, drawer and credit ──
// The view over `assembled_metrics.ratio_table` (current) and the
// comparatives document's `ratios` block (prior, change, bands, band
// movement), built once by the dashboard (`buildRatioCompareView`) and
// provided at the tab, the hero and the Risks tab. The prior used to be a
// Map of key to number recomputed in the browser by `computeRatios` over
// the prior's statements, which threw away the prior band and ladder and
// had no Altman, credit score or letter at all. There is no browser
// arithmetic on this path now: every printed string is the engine's.
export const RatioCompareCtx = createContext<RatioCompareView | null>(null);

export function useRatioCompareView(): RatioCompareView | null {
  return useContext(RatioCompareCtx);
}

// ── Controls ─────────────────────────────────────────────────────────

export function ComparativesControls({
  periods,
  currentId,
  currentEnd,
  autoPick,
  priorId,
  currency: _currency,
  columns = true,
  uploadHref,
}: {
  /** Every analysed period of the company on screen, newest first. */
  periods: readonly OrgPeriod[];
  currentId: string | null;
  /** The close of the period on screen: it names the year AUTO looked for
   *  when it found none. Read off `periods` when not given. */
  currentEnd?: string | null;
  /** What AUTO resolves to right now, for the option label. */
  autoPick: OrgPeriod | null;
  /** The prior the page compares with (`comparisonChoiceOf`'s `priorId`) —
   *  null when nothing resolves. Required: a caller that cannot say what is
   *  being compared cannot render the column boxes. */
  priorId: string | null;
  currency: string;
  /** The column toggles (Prior, Δ, Δ %, share) — statement tables only; the
   *  Overview has no columns to toggle. */
  columns?: boolean;
  /** Where a balance is uploaded (the workspace), for the no-prior notice. */
  uploadHref?: string | null;
}) {
  const { t } = useTranslation();
  const { view, setPriorPeriodId, setColumn } = useComparativesView();
  const candidates = periods.filter((p) => p.period_id !== currentId);
  // A stored choice that is not one of THIS company's periods is ignored
  // (lib/comparatives.ts, comparisonChoiceOf) — so the picker says AUTO,
  // never an option it does not list.
  const value =
    view.priorPeriodId === null
      ? "auto"
      : view.priorPeriodId === "none"
        ? "none"
        : candidates.some((p) => p.period_id === view.priorPeriodId)
          ? view.priorPeriodId
          : "auto";
  const label = (p: OrgPeriod) => formatPeriodMonth(p.period_end) ?? p.period_label;
  // THE COMPARISON IS ON AND COMPARES NOTHING (2026-10-04, production: the
  // company's earliest period on screen — "Previous year (auto)" selected,
  // the four boxes ticked, one column in the table and no word why). The
  // picker names the balance AUTO looked for, the notice below says it is not
  // uploaded and offers the next step, and the boxes are off until a
  // comparison exists. AUTO never picks another period in its place.
  const noPrior = comparisonHasNoPrior(view.priorPeriodId, priorId);
  const end = currentEnd ?? periods.find((p) => p.period_id === currentId)?.period_end ?? null;
  const missingLabel = noPrior ? formatPeriodMonth(previousYearEnd(end)) : null;
  const currentLabel = formatPeriodMonth(end);
  const toggles: { key: keyof ComparativeColumns; label: string }[] = [
    { key: "prior", label: t("statements.cmp.colPrior") },
    { key: "delta", label: t("statements.cmp.colDelta") },
    { key: "deltaPct", label: t("statements.cmp.colDeltaPct") },
    { key: "share", label: t("statements.cmp.colShare") },
  ];
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2 text-[12px] text-ink-soft"
      data-testid="comparatives-controls"
      data-comparison={view.priorPeriodId === "none" ? "off" : noPrior ? "no-prior" : "on"}
    >
      <label className="inline-flex items-center gap-2">
        <span className="font-mono uppercase tracking-[0.08em] text-[10.5px] text-ink-mute">
          {t("statements.cmp.compareWith")}
        </span>
        <select
          data-testid="comparatives-prior-select"
          className="h-8 rounded-sm border border-rule bg-surface px-2 text-[12.5px] text-ink"
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            setPriorPeriodId(v === "auto" ? null : v === "none" ? "none" : v);
          }}
        >
          <option value="auto">
            {t("statements.cmp.auto")}
            {autoPick
              ? ` — ${label(autoPick)}`
              : missingLabel
                ? ` — ${t("statements.cmp.autoMissing", { label: missingLabel })}`
                : ""}
          </option>
          <option value="none">{t("statements.cmp.none")}</option>
          {candidates.map((p) => (
            <option key={p.period_id} value={p.period_id}>{label(p)}</option>
          ))}
        </select>
      </label>
      {columns && view.priorPeriodId !== "none" && (
        <div
          className={`inline-flex items-center gap-3 ${noPrior ? "opacity-50" : ""}`}
          data-testid="comparatives-columns"
          data-disabled={noPrior ? "true" : "false"}
          title={noPrior ? t("statements.cmp.columnsDisabled") : undefined}
        >
          <span className="font-mono uppercase tracking-[0.08em] text-[10.5px] text-ink-mute">
            {t("statements.cmp.columns")}
          </span>
          {toggles.map((c) => (
            <label
              key={c.key}
              className={`inline-flex items-center gap-1 ${noPrior ? "cursor-not-allowed" : "cursor-pointer"}`}
            >
              <input
                type="checkbox"
                data-testid={`comparatives-col-${c.key}`}
                // No comparison on screen: no column is shown, so no box is
                // ticked. The reader's stored columns come back with a prior.
                checked={noPrior ? false : view.columns[c.key]}
                disabled={noPrior}
                onChange={(e) => setColumn(c.key, e.target.checked)}
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
      )}
      {noPrior && (
        <div
          role="status"
          data-testid="comparatives-no-prior"
          data-missing={missingLabel ?? ""}
          className="basis-full rounded-sm border border-rule bg-surface px-3 py-2 text-[12.5px] leading-snug text-ink-soft"
        >
          <span className="font-medium text-ink">{t("statements.cmp.noPriorTitle")}</span>{" "}
          <span data-testid="comparatives-no-prior-body">
            {missingLabel && currentLabel
              ? t("statements.cmp.noPriorBody", { prior: missingLabel, current: currentLabel })
              : t("statements.cmp.noPriorBodyUnnamed")}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
            {uploadHref && (
              <Link
                to={uploadHref}
                data-testid="comparatives-no-prior-upload"
                className="font-medium text-brand-d hover:text-brand transition-colors duration-150"
              >
                {missingLabel
                  ? t("statements.cmp.noPriorUpload", { prior: missingLabel })
                  : t("statements.cmp.noPriorUploadUnnamed")}
              </Link>
            )}
            {candidates.slice(0, NO_PRIOR_ALTERNATIVES).map((p) => (
              <button
                key={p.period_id}
                type="button"
                data-testid="comparatives-no-prior-pick"
                data-period={p.period_id}
                onClick={() => setPriorPeriodId(p.period_id)}
                className="font-medium text-brand-d hover:text-brand transition-colors duration-150"
              >
                {t("statements.cmp.noPriorCompareWith", { label: label(p) })}
              </button>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

/** How many of the company's other periods the no-prior notice offers by
 *  name; the picker above lists them all. */
const NO_PRIOR_ALTERNATIVES = 3;

// ── Summary ──────────────────────────────────────────────────────────

function Bridge({ bridge, title, currency }: { bridge: BridgeDto; title: string; currency: string }) {
  const { t } = useTranslation();
  const fmt = useAmountFormatter(currency);
  const signed = (v: number) =>
    Math.abs(v) < 0.005 ? "0" : fmt(v, { sign: v > 0 ? "positive" : "negative" });
  return (
    <div className="rounded-md border border-rule bg-surface p-4" data-testid={`cmp-bridge-${bridge.statement.toLowerCase()}`} data-closes={bridge.closes}>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h4 className="text-[13px] font-semibold text-ink">{title}</h4>
        <span className={`text-[10.5px] font-mono uppercase tracking-[0.06em] ${bridge.closes ? "text-ink-mute" : "text-alert"}`}>
          {bridge.closes ? t("statements.cmp.bridgeCloses") : t("statements.cmp.refusedTitle")}
        </span>
      </div>
      <div className="font-mono tabular-nums text-[12.5px]">
        <div className="flex justify-between gap-3 py-1 border-b border-rule-soft">
          <span className="text-ink-soft">{t("statements.cmp.bridgePrior", { label: bridge.from_label })}</span>
          <span className="text-ink">{bridge.prior_total === null ? MONEY_MISSING : fmt(bridge.prior_total)}</span>
        </div>
        {bridge.steps.map((s) => (
          <div key={s.key} className="flex justify-between gap-3 py-1" data-step={s.key} data-step-status={s.status}>
            <span className="text-ink-soft truncate">
              {s.label}
              {s.status === "new" && <span className="ml-1 text-ink-mute uppercase text-[10px]">{t("statements.cmp.new")}</span>}
              {s.status === "gone" && <span className="ml-1 text-ink-mute uppercase text-[10px]">{t("statements.cmp.gone")}</span>}
            </span>
            <span className={s.amount > 0.005 ? "text-success" : s.amount < -0.005 ? "text-alert" : "text-ink-mute"}>
              {signed(s.amount)}
            </span>
          </div>
        ))}
        <div className="flex justify-between gap-3 py-1 border-t border-rule font-semibold">
          <span className="text-ink">{t("statements.cmp.bridgeCurrent", { label: bridge.to_label })}</span>
          <span className="text-ink">{bridge.current_total === null ? MONEY_MISSING : fmt(bridge.current_total)}</span>
        </div>
      </div>
      {!bridge.closes && (
        <p className="mt-2 text-[12px] text-alert" data-testid="cmp-bridge-refused">
          {t("statements.cmp.bridgeRefused", { reason: bridge.reason })}
        </p>
      )}
    </div>
  );
}

function MoverRow({ m, currency }: { m: MoverDto; currency: string }) {
  const { t, i18n } = useTranslation();
  const fmt = useAmountFormatter(currency);
  const pct = formatDeltaPct(m.delta_pct, i18n.language);
  return (
    <li className="flex items-baseline justify-between gap-3 py-1 text-[12.5px]" data-mover={m.key} data-verdict={m.verdict ?? "none"}>
      <span className="text-ink truncate">{m.label}</span>
      <span className="font-mono tabular-nums whitespace-nowrap">
        <span className={m.delta !== null && m.delta > 0 ? "text-success" : "text-alert"}>
          {m.delta === null ? MONEY_MISSING : fmt(m.delta, { sign: m.delta > 0 ? "positive" : "negative" })}
        </span>
        {pct && <span className="ml-2 text-ink-soft">{pct}</span>}
        <span className="ml-2 text-ink-mute text-[11px]">
          {t("statements.cmp.materiality", { pct: `${(m.materiality * 100).toFixed(1)}%`, base: m.base_key === "pl.revenue" ? "revenue" : "total assets" })}
        </span>
      </span>
    </li>
  );
}

export function ComparativesSummary({
  doc,
  statement,
  currency,
}: {
  doc: ComparativesResponse;
  /** Which bridges to show on this tab. */
  statement: "PL" | "BS";
  currency: string;
}) {
  const { t } = useTranslation();
  const mv = doc.movers;
  const base = mv.bases[statement];
  const baseName = statement === "PL" ? t("statements.cmp.colShare").replace("% of ", "") : t("statements.cmp.colShareBs").replace("% of ", "");
  const floorPct = `${(mv.materiality_floor * 100).toFixed(1)}%`;
  const inStatement = (m: MoverDto) => m.statement === statement;
  const top = mv.top.filter(inStatement);
  const improved = mv.improved.filter(inStatement);
  const deteriorated = mv.deteriorated.filter(inStatement);
  return (
    <section className="space-y-4" data-testid={`comparatives-summary-${statement.toLowerCase()}`}>
      <p className="text-[12.5px] text-ink-soft" data-testid="cmp-comparability">
        {t("statements.cmp.detailNote", {
          current: doc.current.label,
          currentLevel: t(detailLevelLabelKey(doc.current.detail_level.level)),
          prior: doc.prior.label,
          priorLevel: t(detailLevelLabelKey(doc.prior.detail_level.level)),
        })}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {statement === "PL" ? (
          <Bridge bridge={doc.bridges.pl} title={`${t("statements.cmp.bridgeTitle")} — ${t("statements.cmp.bridgePl")}`} currency={currency} />
        ) : (
          <>
            <Bridge bridge={doc.bridges.bs_assets} title={`${t("statements.cmp.bridgeTitle")} — ${t("statements.cmp.bridgeAssets")}`} currency={currency} />
            <Bridge bridge={doc.bridges.bs_liabilities_equity} title={`${t("statements.cmp.bridgeTitle")} — ${t("statements.cmp.bridgeLe")}`} currency={currency} />
          </>
        )}
        <div className="rounded-md border border-rule bg-surface p-4" data-testid="cmp-movers">
          <h4 className="text-[13px] font-semibold text-ink mb-2">{t("statements.cmp.moversTitle")}</h4>
          {top.length === 0 ? (
            <p className="text-[12px] text-ink-mute">{t("statements.cmp.nothingAbove", { floor: floorPct, base: baseName })}</p>
          ) : (
            <ul className="divide-y divide-rule-soft">
              {top.map((m) => <MoverRow key={m.key} m={m} currency={currency} />)}
            </ul>
          )}
          {(improved.length > 0 || deteriorated.length > 0) && (
            <div className="grid gap-3 sm:grid-cols-2 mt-3">
              <div data-testid="cmp-improved">
                <div className="text-[10.5px] font-mono uppercase tracking-[0.08em] text-success mb-1">{t("statements.cmp.improved")}</div>
                <ul className="text-[12px] text-ink space-y-0.5">
                  {improved.map((m) => <li key={m.key}>{m.label}</li>)}
                </ul>
              </div>
              <div data-testid="cmp-deteriorated">
                <div className="text-[10.5px] font-mono uppercase tracking-[0.08em] text-alert mb-1">{t("statements.cmp.deteriorated")}</div>
                <ul className="text-[12px] text-ink space-y-0.5">
                  {deteriorated.map((m) => <li key={m.key}>{m.label}</li>)}
                </ul>
              </div>
            </div>
          )}
          <p className="mt-3 text-[11px] text-ink-mute">
            {base && base[1] !== null
              ? t("statements.cmp.belowFloor", { n: mv.below_floor, floor: floorPct, base: baseName })
              : null}
          </p>
        </div>
      </div>
    </section>
  );
}

/** The engine refused the comparison: the sentence for its CODE — never the
 *  engine's message, which can carry a raw period id; a code without a
 *  sentence of its own reads the general one (lib/comparisonRefusal.ts). */
export function ComparativesRefusedNote({ code }: { code: string }) {
  const { t } = useTranslation();
  const text = t(comparisonRefusalKey(code));
  return (
    <p className="text-[12.5px] text-ink-soft" data-testid="comparatives-refused" data-code={code}>
      {t("statements.cmp.refusedTitle")}: {text}
    </p>
  );
}
