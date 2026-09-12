// ComparativeCells — the [prior][Δ][Δ %][share] cells a statement row may
// carry, and the context that hands them down without prop-drilling
// through PLSectionView / PLLineView / BSSectionView / BSLineView.
//
// A statement view wraps itself in <ComparativeProvider> when it has an
// engine comparatives document; rows call <CmpCells rowKey amount /> after
// their own amount. Outside a provider the component renders nothing, so
// every view keeps its exact single-period markup when there is no prior.
//
// WHAT A CELL MAY SAY. A number the engine served; the engine's own Δ %;
// a share and its change in POINTS; or a word — "new", "no longer
// present", "not disclosed at this detail level", "no base" — for the
// case the engine refused. Never a zero standing in for an absence, never
// a percentage the FE divided itself.
import { createContext, useContext, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  cellForRow,
  formatDeltaPct,
  formatPts,
  formatShare,
  type ComparativeCell,
  type ComparativesResponse,
  indexCells,
} from "@/lib/comparatives";
import type { ComparativeColumns } from "@/stores/comparativesView";
import { useAmountFormatter } from "@/stores/currency";
import { MONEY_MISSING } from "@/lib/money";

export interface ComparativeContextValue {
  doc: ComparativesResponse;
  cells: Map<string, ComparativeCell>;
  columns: ComparativeColumns;
  /** "PL" | "BS" — which statement base the share column is against. */
  statement: "PL" | "BS";
  currency: string;
}

const Ctx = createContext<ComparativeContextValue | null>(null);

export function ComparativeProvider({
  doc,
  columns,
  statement,
  currency,
  children,
}: {
  doc: ComparativesResponse | null;
  columns: ComparativeColumns;
  statement: "PL" | "BS";
  currency: string;
  children: ReactNode;
}) {
  if (!doc) return <>{children}</>;
  const value: ComparativeContextValue = {
    doc,
    cells: indexCells(doc),
    columns,
    statement,
    currency,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useComparativeContext(): ComparativeContextValue | null {
  return useContext(Ctx);
}

/** How many comparative columns are switched on (0 → the views render
 *  their single-period grid). */
export function activeColumnCount(columns: ComparativeColumns): number {
  return [columns.prior, columns.delta, columns.deltaPct, columns.share].filter(Boolean).length;
}

/**
 * The `--cmp-cols` grid template for the columns switched on. The
 * balance sheet already carries [opening][closing][Δ] of its own, so it
 * only adds Δ % and share; cash flow adds prior and Δ only.
 */
export function cmpColumnTemplate(
  columns: ComparativeColumns,
  variant: "pl" | "bs" | "cf" = "pl",
): string {
  const parts: string[] = [];
  if (variant !== "bs" && columns.prior) parts.push(variant === "cf" ? "160px" : "150px");
  if (variant !== "bs" && columns.delta) parts.push("120px");
  if (variant !== "cf" && columns.deltaPct) parts.push(variant === "bs" ? "80px" : "84px");
  if (variant !== "cf" && columns.share) parts.push("96px");
  return parts.join(" ");
}

function signClass(v: number | null): string {
  if (v === null || !Number.isFinite(v) || Math.abs(v) < 0.005) return "";
  return v > 0 ? "cmp-cell--pos" : "cmp-cell--neg";
}

/**
 * The cells for one row. `rowKey` is the row's `bucket` / `subtotalBucket`
 * (or a full engine key like "pl.ebitda"); `amount` is what the row shows,
 * which the parity guard compares against the engine's current figure.
 */
export function CmpCells({
  rowKey,
  amount,
  bs,
}: {
  rowKey: string | undefined;
  amount: number | null | undefined;
  /** Balance-sheet rows already carry opening/closing/Δ; they only get
   *  the Δ % and share cells here. */
  bs?: boolean;
}) {
  const ctx = useComparativeContext();
  const { t } = useTranslation();
  const fmt = useAmountFormatter(ctx?.currency ?? "RON");
  if (!ctx) return null;
  const outcome = cellForRow(ctx.cells, rowKey, amount);
  const cols = ctx.columns;

  const gap = (title?: string) => (
    <span className="cmp-cell cmp-cell--gap" title={title} aria-label={title}>
      {MONEY_MISSING}
    </span>
  );
  const word = (text: string, title?: string) => (
    <span className="cmp-cell cmp-cell--word" title={title ?? text}>{text}</span>
  );

  if (outcome.kind === "unmapped") {
    // No engine line for this row: blank cells, no claim.
    return (
      <span className="cmp-cells" data-cmp="unmapped">
        {!bs && cols.prior && gap()}
        {!bs && cols.delta && gap()}
        {cols.deltaPct && gap()}
        {cols.share && gap()}
      </span>
    );
  }
  if (outcome.kind === "definition_differs") {
    const title = t("statements.cmp.definitionDiffers");
    return (
      <span className="cmp-cells" data-cmp="definition-differs" data-cmp-key={outcome.key}>
        {!bs && cols.prior && gap(title)}
        {!bs && cols.delta && gap(title)}
        {cols.deltaPct && gap(title)}
        {cols.share && gap(title)}
      </span>
    );
  }

  const c = outcome.cell;
  const refusalWord = (): string | null => {
    switch (c.status) {
      case "absent_prior": return t("statements.cmp.new");
      case "absent_current": return t("statements.cmp.gone");
      case "not_disclosed_at_this_detail_level": return t("statements.cmp.notAtLevel");
      case "incomparable": return t("statements.cmp.notAtLevel");
      default: return null;
    }
  };
  const refused = refusalWord();
  const deltaPctText = formatDeltaPct(c.deltaPct);
  const shareText = formatShare(c.currentShare);
  const ptsText = formatPts(c.deltaPts);

  return (
    <span className="cmp-cells" data-cmp={c.status} data-cmp-key={c.key}>
      {!bs && cols.prior && (
        c.prior === null
          ? (refused ? word(refused, c.note) : gap(c.note))
          : <span className="cmp-cell cmp-cell--prior" title={c.note}>{fmt(c.prior)}</span>
      )}
      {!bs && cols.delta && (
        c.delta === null
          ? (refused ? word(refused, c.note) : gap(c.note))
          : <span className={`cmp-cell ${signClass(c.delta)}`} title={c.note}>
              {fmt(c.delta, { sign: c.delta > 0 ? "positive" : "negative" })}
            </span>
      )}
      {cols.deltaPct && (
        deltaPctText === null
          ? (c.status === "compared_no_base"
              ? word(t("statements.cmp.noBase"), c.note)
              : refused ? word(refused, c.note) : gap(c.note))
          : <span className={`cmp-cell ${signClass(c.deltaPct)}`} title={c.note}>{deltaPctText}</span>
      )}
      {cols.share && (
        shareText === null
          ? gap(c.note)
          : <span className="cmp-cell" title={ptsText ? `${shareText} (${ptsText})` : shareText}>
              {shareText}
              {ptsText && <span className={`cmp-cell--pts ${signClass(c.deltaPts)}`}> {ptsText}</span>}
            </span>
      )}
    </span>
  );
}

/**
 * Balance-sheet cells: Δ % and share, computed from the row's OWN
 * opening/closing — both engine canonical figures, both built the same
 * way — against the two periods' total assets. Nothing here is divided
 * against a zero: an absent opening or a zero base yields the gap glyph
 * or a word, exactly as the engine's column model does.
 */
export function BsCmpCells({
  opening,
  closing,
  baseCurrent,
  basePrior,
  absentWord,
}: {
  opening: number | null | undefined;
  closing: number | null | undefined;
  baseCurrent: number | null;
  basePrior: number | null;
  /** The word for "the prior period has no such line" — the view knows
   *  whether the opening was unfilled because the prior lacked the row. */
  absentWord?: string;
}) {
  const ctx = useComparativeContext();
  const { t } = useTranslation();
  if (!ctx) return null;
  const cols = ctx.columns;
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const gap = (title?: string) => (
    <span className="cmp-cell cmp-cell--gap" title={title}>{MONEY_MISSING}</span>
  );
  const word = (text: string) => <span className="cmp-cell cmp-cell--word" title={text}>{text}</span>;

  let pctNode: ReactNode = gap();
  if (isNum(opening) && isNum(closing)) {
    if (Math.abs(opening) < 0.005) pctNode = word(t("statements.cmp.noBase"));
    else {
      const ratio = (closing - opening) / Math.abs(opening);
      const text = formatDeltaPct(ratio);
      pctNode = text === null ? gap() : <span className={`cmp-cell ${signClass(ratio)}`}>{text}</span>;
    }
  } else if (!isNum(opening) && isNum(closing) && absentWord) {
    pctNode = word(absentWord);
  }

  let shareNode: ReactNode = gap();
  if (isNum(closing) && isNum(baseCurrent) && Math.abs(baseCurrent) >= 0.005) {
    const cur = closing / Math.abs(baseCurrent);
    const pri = isNum(opening) && isNum(basePrior) && Math.abs(basePrior) >= 0.005
      ? opening / Math.abs(basePrior) : null;
    const pts = pri === null ? null : (cur - pri) * 100;
    const shareText = formatShare(cur);
    const ptsText = formatPts(pts);
    shareNode = (
      <span className="cmp-cell" title={ptsText ? `${shareText} (${ptsText})` : shareText ?? undefined}>
        {shareText}
        {ptsText && <span className={`cmp-cell--pts ${signClass(pts)}`}> {ptsText}</span>}
      </span>
    );
  }
  return (
    <span className="cmp-cells" data-cmp="bs">
      {cols.deltaPct && pctNode}
      {cols.share && shareNode}
    </span>
  );
}

/**
 * Cash-flow cells: the prior period's figure for the same line and the
 * change. Both periods ran the same indirect-method builder on their own
 * envelope, so the two are like for like — and both are approximations
 * when the builder says so, which is why there is no percentage column.
 */
export function CfCmpCells({
  current,
  prior,
}: {
  current: number | null | undefined;
  prior: number | null | undefined;
}) {
  const ctx = useComparativeContext();
  const fmt = useAmountFormatter(ctx?.currency ?? "RON");
  if (!ctx) return null;
  const cols = ctx.columns;
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const gap = <span className="cmp-cell cmp-cell--gap">{MONEY_MISSING}</span>;
  const delta = isNum(current) && isNum(prior) ? current - prior : null;
  return (
    <span className="cmp-cells" data-cmp="cf">
      {cols.prior && (isNum(prior)
        ? <span className="cmp-cell cmp-cell--prior">{fmt(prior)}</span>
        : gap)}
      {cols.delta && (delta === null
        ? gap
        : <span className={`cmp-cell ${signClass(delta)}`}>
            {fmt(delta, { sign: delta > 0 ? "positive" : "negative" })}
          </span>)}
    </span>
  );
}

/** Column header for a P&L / cash-flow grid carrying comparatives. */
export function CmpColumnHeader({
  currentLabel,
  priorLabel,
  shareLabel,
  columns,
  cf,
}: {
  currentLabel: string;
  priorLabel: string;
  shareLabel: string;
  columns: ComparativeColumns;
  /** Cash flow: [current][prior][Δ] only. */
  cf?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="cmp-col-header" data-testid="cmp-col-header">
      <span />
      <span>{currentLabel}</span>
      {columns.prior && <span>{priorLabel}</span>}
      {columns.delta && <span>{t("statements.cmp.colDelta")}</span>}
      {!cf && columns.deltaPct && <span>{t("statements.cmp.colDeltaPct")}</span>}
      {!cf && columns.share && <span>{shareLabel}</span>}
    </div>
  );
}
