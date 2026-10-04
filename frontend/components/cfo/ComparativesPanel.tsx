// ComparativesPanel — the controls (which prior, which columns) and the
// summary (comparability, the variance bridge, top movers) for two
// periods side by side.
//
// Everything numeric here is the engine's document
// (`/api/period/{id}/comparatives`): the bridge steps, whether the walk
// closes, the movers and their verdicts, the materiality floor. This
// file formats and refuses; it computes nothing a reader could disagree
// with.
import { createContext, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { comparisonRefusalKey } from "@/lib/comparisonRefusal";

import {
  detailLevelLabelKey,
  formatDeltaPct,
  formatShare,
  noPriorStateOf,
  type BridgeDto,
  type ComparativesResponse,
  type MoverDto,
} from "@/lib/comparatives";
import type { ShareOffer } from "@/lib/commonSize";
import {
  columnBoxesOf,
  comparisonBackwardsOf,
  comparisonBlockOf,
  priorIsEarlier,
  type ColumnBoxReason,
  type ComparisonNote,
} from "@/lib/comparisonState";
import type { ExportComparisonState } from "@/lib/reportComparatives";
import type { OrgPeriod } from "@/lib/orgPeriods";
import type { RatioCompareView } from "@/lib/ratioCompareView";
import { formatPeriodMonth } from "@/lib/orgPeriods";
import { useActiveLocale } from "@/lib/locale";
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

/** The picker's DOM id: the notice hands focus back to it after a pick. */
export const COMPARATIVES_PRIOR_SELECT_ID = "comparatives-prior-select";
/** The notice's DOM id: the switched-off column boxes are described by it. */
export const COMPARATIVES_NO_PRIOR_NOTE_ID = "comparatives-no-prior-note";
/** The outcome note's DOM id (refused / failed): the boxes it switched off
 *  are described by it. */
export const COMPARATIVES_OUTCOME_NOTE_ID = "comparatives-outcome-note";
/** The sentence beside a share box that stands alone and is off. */
export const COMPARATIVES_SHARE_NOTE_ID = "comparatives-share-note";

/** How many of the company's earlier periods the notice offers by name; the
 *  picker lists every period. */
export const NO_PRIOR_ALTERNATIVES = 3;

export function ComparativesControls({
  periods,
  currentId,
  currentEnd,
  autoPick,
  priorId,
  currency: _currency,
  columns = true,
  share = null,
  outcome = null,
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
  /** The share column the tab on screen can paint from the period's OWN
   *  served block (P&L, balance sheet), or null on a tab with no share
   *  column of its own. The share box follows THIS, not the comparison. */
  share?: ShareOffer | null;
  /** The comparison request's outcome (lib/useRatioSurfaces.ts): a refused
   *  or failed request switches the comparison boxes off, with the reason. */
  outcome?: ExportComparisonState | null;
}) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const { view, setPriorPeriodId, setColumn } = useComparativesView();
  const candidates = periods.filter((p) => p.period_id !== currentId);
  // A company with ONE period has nothing to pick: no picker, no notice —
  // nothing claims a comparison there. The share box alone remains, on a tab
  // that can paint the period's own shares.
  const hasPicker = periods.length > 1;
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
  const label = (p: OrgPeriod) => formatPeriodMonth(p.period_end, locale) ?? p.period_label;
  // THE COMPARISON IS ON AND COMPARES NOTHING (2026-10-04, production: the
  // company's earliest period on screen — "Previous year (auto)" selected,
  // the four boxes ticked, one column in the table and no word why). The
  // picker names the balance AUTO looked for, <ComparativesNoPriorNote> says
  // so in a sentence and offers the next step, and the comparison boxes are
  // off until a comparison exists. AUTO never picks another period in its
  // place. The same when the engine refused the comparison or the request
  // failed: <ComparisonOutcomeNote> says which.
  const noPrior = hasPicker
    ? noPriorStateOf({ periods, currentId, currentEnd, stored: view.priorPeriodId, priorId })
    : null;
  const missingLabel = noPrior ? formatPeriodMonth(noPrior.missingEnd, locale) : null;
  const block = comparisonBlockOf({ stored: view.priorPeriodId, priorId, outcome, hasOtherPeriods: hasPicker });
  const boxes = columns ? columnBoxesOf({ block, share, columns: view.columns }) : [];
  if (!hasPicker && boxes.length === 0) return null;
  const allOff = boxes.length > 0 && boxes.every((b) => !b.enabled);
  const boxLabel: Record<keyof ComparativeColumns, string> = {
    prior: t("statements.cmp.colPrior"),
    delta: t("statements.cmp.colDelta"),
    deltaPct: t("statements.cmp.colDeltaPct"),
    // The share box names the base of the column on THIS tab.
    share: t(share?.base === "BS" ? "statements.cmp.colShareBs" : "statements.cmp.colShare"),
  };
  const reasonText = (reason: ColumnBoxReason | null): string | undefined =>
    reason === "no_prior"
      ? t("statements.cmp.columnsDisabled")
      : reason === "no_document"
        ? t("statements.cmp.columnsNoDocument")
        : reason === "share_not_served"
          ? t("statements.cmp.share.notServed")
          : undefined;
  const describedBy = (reason: ColumnBoxReason | null): string | undefined =>
    reason === "no_prior"
      ? COMPARATIVES_NO_PRIOR_NOTE_ID
      : reason === "no_document"
        ? COMPARATIVES_OUTCOME_NOTE_ID
        : reason === "share_not_served"
          ? COMPARATIVES_SHARE_NOTE_ID
          : undefined;
  const shareAloneOff = boxes.find((b) => b.reason === "share_not_served") ?? null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2 text-[12px] text-ink-soft"
      data-testid="comparatives-controls"
      data-comparison={
        !hasPicker
          ? "single"
          : block === "off"
            ? "off"
            : block === "no_prior"
              ? "no-prior"
              : block ?? "on"
      }
    >
      {/* min-w-0 / max-w-full: a select is as wide as its widest option, and
          the option that names a missing month is long — on a phone it
          shrinks inside the row instead of running off the screen. */}
      {hasPicker && (
      <label className="inline-flex min-w-0 max-w-full items-center gap-2">
        <span className="shrink-0 font-mono uppercase tracking-[0.08em] text-[10.5px] text-ink-mute">
          {t("statements.cmp.compareWith")}
        </span>
        <select
          id={COMPARATIVES_PRIOR_SELECT_ID}
          data-testid="comparatives-prior-select"
          className="h-8 min-w-0 max-w-full rounded-sm border border-rule bg-surface px-2 text-[12.5px] text-ink"
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
      )}
      {boxes.length > 0 && (
        <div
          className="inline-flex flex-wrap items-center gap-x-3 gap-y-1"
          data-testid="comparatives-columns"
          // "true" only when EVERY box shown is off — then the group itself
          // carries the reason; otherwise each switched-off box carries its own.
          data-disabled={allOff ? "true" : "false"}
          title={allOff ? reasonText(boxes[0].reason) : undefined}
        >
          <span className="font-mono uppercase tracking-[0.08em] text-[10.5px] text-ink-mute">
            {t("statements.cmp.columns")}
          </span>
          {boxes.map((b) => (
            <label
              key={b.key}
              className={`inline-flex items-center gap-1 ${b.enabled ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
              title={!allOff && !b.enabled ? reasonText(b.reason) : undefined}
            >
              <input
                type="checkbox"
                data-testid={`comparatives-col-${b.key}`}
                // A box that is off shows no tick: no such column is on
                // screen. The reader's stored columns are read, never
                // written, by the state — they come back with a comparison.
                checked={b.checked}
                disabled={!b.enabled}
                aria-describedby={describedBy(b.reason)}
                onChange={(e) => setColumn(b.key, e.target.checked)}
              />
              <span>{boxLabel[b.key]}</span>
            </label>
          ))}
          {/* The share box stands alone and is off: the payload carries no
              share block (an engine that predates it, a period the engine
              could not re-assemble). Said beside the box; nothing is computed
              in its place. */}
          {shareAloneOff && (
            <span
              id={COMPARATIVES_SHARE_NOTE_ID}
              data-testid="comparatives-share-unavailable"
              className="text-ink-mute"
            >
              {t("statements.cmp.share.notServed")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The sentence for a comparison that is ON and compares nothing: which
 * balance is missing, which period is therefore shown alone, and the next
 * step — where a balance is uploaded, and the company's EARLIER periods one
 * click away. Rendered by the page BELOW the sticky tab bar (inside it, it
 * made the pinned bar a third of a phone screen). Null in every other state.
 */
export function ComparativesNoPriorNote({
  periods,
  currentId,
  currentEnd,
  priorId,
  uploadHref,
}: {
  periods: readonly OrgPeriod[];
  currentId: string | null;
  currentEnd?: string | null;
  /** The prior the page compares with — null when nothing resolves. */
  priorId: string | null;
  /** Where a balance is uploaded (the workspace). */
  uploadHref?: string | null;
}) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const { view, setPriorPeriodId } = useComparativesView();
  const state = noPriorStateOf({ periods, currentId, currentEnd, stored: view.priorPeriodId, priorId });
  if (!state) return null;
  const label = (p: OrgPeriod) => formatPeriodMonth(p.period_end, locale) ?? p.period_label;
  const missingLabel = formatPeriodMonth(state.missingEnd, locale);
  const currentLabel = formatPeriodMonth(state.currentEnd, locale);
  const action =
    "inline-flex items-center min-h-[44px] sm:min-h-0 font-medium text-brand-d hover:text-brand transition-colors duration-150";
  return (
    <div
      id={COMPARATIVES_NO_PRIOR_NOTE_ID}
      role="status"
      data-testid="comparatives-no-prior"
      data-missing={missingLabel ?? ""}
      className="mt-3 rounded-sm border border-rule bg-surface px-3 py-2 text-[12.5px] leading-snug text-ink-soft"
    >
      <span className="font-medium text-ink">{t("statements.cmp.noPriorTitle")}</span>{" "}
      <span data-testid="comparatives-no-prior-body">
        {missingLabel && currentLabel
          ? t("statements.cmp.noPriorBody", { prior: missingLabel, current: currentLabel })
          : t("statements.cmp.noPriorBodyUnnamed")}
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
        {uploadHref && (
          <Link to={uploadHref} data-testid="comparatives-no-prior-upload" className={action}>
            {missingLabel
              ? t("statements.cmp.noPriorUpload", { prior: missingLabel })
              : t("statements.cmp.noPriorUploadUnnamed")}
          </Link>
        )}
        {state.earlier.slice(0, NO_PRIOR_ALTERNATIVES).map((p) => (
          <button
            key={p.period_id}
            type="button"
            data-testid="comparatives-no-prior-pick"
            data-period={p.period_id}
            onClick={() => {
              setPriorPeriodId(p.period_id);
              // The notice unmounts with the pick; the keyboard reader lands
              // on the picker, which now names the period chosen.
              document.getElementById(COMPARATIVES_PRIOR_SELECT_ID)?.focus();
            }}
            className={action}
          >
            {t("statements.cmp.noPriorCompareWith", { label: label(p) })}
          </button>
        ))}
      </span>
    </div>
  );
}

/** How long a request may be in flight before the page says so. A
 *  comparison usually answers faster than a reader can read a line; a
 *  sentence that appears and vanishes in that time is noise. Past it, "the
 *  comparison is on and nothing is compared" is said. */
export const PENDING_NOTE_DELAY_MS = 800;

/**
 * THE COMPARISON REQUEST'S OUTCOME, IN ONE SENTENCE, ON EVERY TAB THAT HAS
 * THE CONTROLS. Rendered by the page below the sticky tab bar, beside
 * <ComparativesNoPriorNote> (the two never show together: with no prior
 * nothing was asked).
 *   · refused  — the sentence for the engine's refusal CODE, never its
 *                message (lib/comparisonRefusal.ts);
 *   · failed   — the request failed (401, 5xx, no network): a sentence and
 *                "try again", which asks once more — no retry loop;
 *   · pending  — quiet, and only after PENDING_NOTE_DELAY_MS;
 *   · backwards — the comparison period closes AFTER the one on screen (or
 *                the order cannot be read): every change reads backwards in
 *                time and the engine calls nothing improved or deteriorated.
 * Null in every other state.
 */
export function ComparisonOutcomeNote({
  note,
  doc = null,
  onRetry,
  retrying = false,
  verdicts = false,
}: {
  /** `comparisonNoteOf(outcome, doc)` — the page's one reading. */
  note: ComparisonNote | null;
  /** The served document, for the two periods' own closes. */
  doc?: ComparativesResponse | null;
  /** Ask for the comparison again (the failed state's action). */
  onRetry?: () => void;
  retrying?: boolean;
  /** The tab on screen lists what improved / deteriorated (the P&L and the
   *  balance sheet): the backwards sentence then says none is given. */
  verdicts?: boolean;
}) {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const pending = note?.kind === "pending";
  const [pendingShown, setPendingShown] = useState(false);
  useEffect(() => {
    if (!pending) {
      setPendingShown(false);
      return;
    }
    const timer = window.setTimeout(() => setPendingShown(true), PENDING_NOTE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);
  if (!note) return null;
  if (note.kind === "pending") {
    if (!pendingShown) return null;
    return (
      <p
        role="status"
        data-testid="comparatives-outcome"
        data-outcome="pending"
        className="mt-3 text-[12px] text-ink-mute"
      >
        {t("statements.cmp.loading")}
      </p>
    );
  }
  const box = "mt-3 rounded-sm border border-rule bg-surface px-3 py-2 text-[12.5px] leading-snug text-ink-soft";
  if (note.kind === "refused") {
    return (
      <div
        id={COMPARATIVES_OUTCOME_NOTE_ID}
        role="status"
        data-testid="comparatives-outcome"
        data-outcome="refused"
        className={box}
      >
        <ComparativesRefusedNote code={note.code} />
      </div>
    );
  }
  if (note.kind === "failed") {
    return (
      <div
        id={COMPARATIVES_OUTCOME_NOTE_ID}
        role="status"
        data-testid="comparatives-outcome"
        data-outcome="failed"
        data-status={note.status}
        className={box}
      >
        <span className="font-medium text-ink">{t("statements.cmp.failedTitle")}</span>{" "}
        <span data-testid="comparatives-failed-body">
          {note.status > 0
            ? t("statements.cmp.failedBody", { status: note.status })
            : t("statements.cmp.failedBodyNoResponse")}
        </span>{" "}
        {onRetry && (
          <button
            type="button"
            data-testid="comparatives-retry"
            onClick={onRetry}
            disabled={retrying}
            aria-busy={retrying}
            className="inline-flex items-center min-h-[44px] sm:min-h-0 font-medium text-brand-d hover:text-brand transition-colors duration-150 disabled:opacity-50"
          >
            {t("statements.cmp.failedRetry")}
          </button>
        )}
      </div>
    );
  }
  // The two periods by their own months, in the reader's language.
  const month = (end: string | null | undefined, fallback: string | undefined) =>
    formatPeriodMonth(end, locale) ?? fallback ?? "";
  return (
    <p
      role="status"
      data-testid="comparatives-outcome"
      data-outcome="backwards"
      data-order={note.order}
      className={box}
    >
      {note.order === "prior_is_later"
        ? t(verdicts ? "statements.cmp.backwardsLater" : "statements.cmp.backwardsLaterPlain", {
            prior: month(doc?.prior?.period_end, doc?.prior?.label),
            current: month(doc?.current?.period_end, doc?.current?.label),
          })
        : t(verdicts ? "statements.cmp.backwardsUnknown" : "statements.cmp.backwardsUnknownPlain")}
    </p>
  );
}

// ── Summary ──────────────────────────────────────────────────────────

function Bridge({ bridge, title, currency, ordered, fromPeriod, toPeriod }: {
  bridge: BridgeDto;
  title: string;
  currency: string;
  /** The engine says the comparison period is the EARLIER one: the end rows
   *  read "— prior" / "— current". Otherwise (a later comparison period, the
   *  same close, an order that cannot be read) each end row names its period
   *  by the period's OWN label — a later period is never called "prior". */
  ordered: boolean;
  /** The comparison period's and the on-screen period's own months. */
  fromPeriod: string;
  toPeriod: string;
}) {
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
          <span className="text-ink-soft" data-testid="cmp-bridge-from">
            {ordered
              ? t("statements.cmp.bridgePrior", { label: bridge.from_label })
              : t("statements.cmp.bridgePeriod", { label: bridge.from_label, period: fromPeriod })}
          </span>
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
          <span className="text-ink" data-testid="cmp-bridge-to">
            {ordered
              ? t("statements.cmp.bridgeCurrent", { label: bridge.to_label })
              : t("statements.cmp.bridgePeriod", { label: bridge.to_label, period: toPeriod })}
          </span>
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
          {t("statements.cmp.materiality", {
            // The served fraction, through the one printer of a share.
            pct: formatShare(m.materiality, i18n.language),
            base: t(m.base_key === "pl.revenue" ? "statements.cmp.baseRevenue" : "statements.cmp.baseAssets"),
          })}
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
  const { t, i18n } = useTranslation();
  const locale = useActiveLocale();
  const mv = doc.movers;
  const base = mv.bases[statement];
  const baseName = t(statement === "PL" ? "statements.cmp.baseRevenue" : "statements.cmp.baseAssets");
  const floorPct = formatShare(mv.materiality_floor, i18n.language) ?? "";
  const inStatement = (m: MoverDto) => m.statement === statement;
  const top = mv.top.filter(inStatement);
  // WHICH WAY TIME RUNS is the engine's reading (`direction`). With a
  // comparison period that closes LATER — or an order it cannot read — the
  // engine serves no improved / deteriorated verdict, and none is listed
  // here whatever the lists hold (<ComparisonOutcomeNote> says why).
  const ordered = priorIsEarlier(doc);
  const ends = {
    ordered,
    fromPeriod: formatPeriodMonth(doc.prior.period_end, locale) ?? doc.prior.label,
    toPeriod: formatPeriodMonth(doc.current.period_end, locale) ?? doc.current.label,
  };
  const verdictsServed = comparisonBackwardsOf(doc) === null && !mv.verdicts_withheld;
  const improved = verdictsServed ? mv.improved.filter(inStatement) : [];
  const deteriorated = verdictsServed ? mv.deteriorated.filter(inStatement) : [];
  return (
    <section
      className="space-y-4"
      data-testid={`comparatives-summary-${statement.toLowerCase()}`}
      data-verdicts={verdictsServed ? "served" : "withheld"}
    >
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
          <Bridge bridge={doc.bridges.pl} title={`${t("statements.cmp.bridgeTitle")} — ${t("statements.cmp.bridgePl")}`} currency={currency} {...ends} />
        ) : (
          <>
            <Bridge bridge={doc.bridges.bs_assets} title={`${t("statements.cmp.bridgeTitle")} — ${t("statements.cmp.bridgeAssets")}`} currency={currency} {...ends} />
            <Bridge bridge={doc.bridges.bs_liabilities_equity} title={`${t("statements.cmp.bridgeTitle")} — ${t("statements.cmp.bridgeLe")}`} currency={currency} {...ends} />
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
