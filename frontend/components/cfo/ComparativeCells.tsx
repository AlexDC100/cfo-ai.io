// ComparativeCells — the [prior][Δ][Δ %][share] cells a statement row may
// carry, and the context that hands them down without prop-drilling
// through PLSectionView / PLLineView / BSSectionView / BSLineView.
//
// A statement view wraps itself in <ComparativeProvider> when it has an
// engine comparatives document; rows call <CmpCells rowKey amount /> after
// their own amount. Outside a provider the component renders nothing, so
// every view keeps its exact single-period markup when there is no prior.
//
// THE SHARE COLUMN IS NOT A COMPARISON COLUMN (owner ruling 2026-10-04:
// "'% din venituri' must work for a single year without a comparison").
// With NO document — no prior resolves, the reader chose "No comparison",
// the company has one period, the request was refused or failed — the
// provider hands down the period's OWN served shares
// (`statements.common_size`, lib/commonSize.ts) and the rows paint ONE
// extra column from it. Two contexts on purpose: `useComparativeContext`
// keeps meaning "a document is on screen" (its `doc` is never null), and a
// view asks `useShareOnlyContext` for the single-period column.
//
// WHAT A CELL MAY SAY. A number the engine served; the engine's own Δ %;
// a share and its change in POINTS; or a word — "new", "no longer
// present", "not disclosed at this detail level", "no base" — for the
// case the engine refused. Never a zero standing in for an absence, never
// a percentage the FE divided itself: every share on the P&L and on the
// balance sheet, with a document or without, is the engine's served
// fraction through the one printer (`formatShare`). A move from zero, to
// zero or across sign carries the one classifier's words ("turned
// negative") in the Δ % column, never a percent (plan_contract_v2 section
// 7, defect 0.4).
import { createContext, useContext, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  cellForRow,
  formatDeltaPct,
  formatPts,
  formatShare,
  rowIsEngineFigure,
  type CommonSizeRowDto,
  type ComparativeCell,
  type ComparativesResponse,
  indexCells,
} from "@/lib/comparatives";
import {
  shareForRow,
  shareReasonKey,
  shareWordKey,
  type CommonSizeBlock,
  type ShareOutcome,
} from "@/lib/commonSize";
import { absentLineWordKey, priorIsEarlier } from "@/lib/comparisonState";
import type { ComparativeColumns } from "@/stores/comparativesView";
import { useAmountFormatter } from "@/stores/currency";
import { MONEY_MISSING } from "@/lib/money";
import { pickLang, readRefusal } from "@/lib/servedOneEbitda";
import {
  ROUNDED_MONEY_ZERO_FLOOR,
  changeKindWordKey,
  classifyChange,
  isWordKind,
} from "@/lib/changeKind";

export interface ComparativeContextValue {
  doc: ComparativesResponse;
  cells: Map<string, ComparativeCell>;
  /** The document's common-size rows by key — the registry lines AND the
   *  canonical balance-sheet rows (`bs.row.<id>` …), which have no column. */
  shareRows: Map<string, CommonSizeRowDto>;
  /** The period's own share block, when served: what a balance-sheet row's
   *  amount is held against before the document's share is printed. */
  block: CommonSizeBlock | null;
  /** The engine says the comparison period is the EARLIER one. When it is
   *  not, a line one period lacks is not called "new" / "no longer present"
   *  (lib/comparisonState.ts `absentLineWordKey`). */
  ordered: boolean;
  columns: ComparativeColumns;
  /** "PL" | "BS" — which statement base the share column is against. */
  statement: "PL" | "BS";
  currency: string;
}

const Ctx = createContext<ComparativeContextValue | null>(null);

/** The single-period share column: the period's own served block, and the
 *  statement whose base the column is struck against. */
export interface ShareOnlyContextValue {
  block: CommonSizeBlock;
  statement: "PL" | "BS";
}

const ShareOnlyCtx = createContext<ShareOnlyContextValue | null>(null);

/** The columns of a single-period render: the share, and nothing else. */
export const SHARE_ONLY_COLUMNS: ComparativeColumns = {
  prior: false,
  delta: false,
  deltaPct: false,
  share: true,
};

export function ComparativeProvider({
  doc,
  columns,
  statement,
  currency,
  commonSize = null,
  children,
}: {
  doc: ComparativesResponse | null;
  columns: ComparativeColumns;
  statement: "PL" | "BS";
  currency: string;
  /** The period's own share block (`readCommonSize(statements)`), on the
   *  tabs that have a share column — the P&L and the balance sheet. With no
   *  document and the share box ticked, the rows paint the share from it. */
  commonSize?: CommonSizeBlock | null;
  children: ReactNode;
}) {
  if (!doc) {
    if (!commonSize || !columns.share) return <>{children}</>;
    return <ShareOnlyCtx.Provider value={{ block: commonSize, statement }}>{children}</ShareOnlyCtx.Provider>;
  }
  const value: ComparativeContextValue = {
    doc,
    cells: indexCells(doc),
    shareRows: new Map(doc.common_size.map((r) => [r.key, r])),
    block: commonSize,
    ordered: priorIsEarlier(doc),
    columns,
    statement,
    currency,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The two-period comparison on screen, or null. Its `doc` is never null. */
export function useComparativeContext(): ComparativeContextValue | null {
  return useContext(Ctx);
}

/** The single-period share column, or null — never set beside a document. */
export function useShareOnlyContext(): ShareOnlyContextValue | null {
  return useContext(ShareOnlyCtx);
}

/** THE EBITDA DEFINITION the statement on screen is served on
 *  (`assembled_pl.ebitda_definition`). A P&L view provides it around its
 *  rows so every row on the one EBITDA is held to a prior assembled on the
 *  same definition (lib/comparatives.ts `PL_ROW_ONE_EBITDA_KEYS`). Null —
 *  the default — holds nothing (a payload the engine did not assemble). */
const DefinitionCtx = createContext<string | null>(null);

export function ComparativeDefinitionProvider({
  definition,
  children,
}: {
  definition: string | null | undefined;
  children: ReactNode;
}) {
  return <DefinitionCtx.Provider value={definition ?? null}>{children}</DefinitionCtx.Provider>;
}

/** The prior period's own refusal for an engine line, in the reader's
 *  language, from the served comparatives document's `prior_statements`:
 *  the stock variation's refusal on its row, the EBITDA refusal on every
 *  row built on it. Null when the prior refused nothing. */
function priorRefusalText(priorStatements: unknown, key: string, lang: string | undefined): string | null {
  const ps = priorStatements as { assembled_pl?: Record<string, unknown> } | null | undefined;
  const apl = ps?.assembled_pl;
  if (!apl || typeof apl !== "object") return null;
  const component =
    key === "pl.inventory_variation" ? (apl.inventory_variation as { refusal?: unknown } | undefined)?.refusal : null;
  const refusal = readRefusal(component) ?? readRefusal(apl.ebitda_refusal);
  return refusal ? pickLang(refusal.text, lang) : null;
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
 * ONE SHARE CELL of a single-period render: the served fraction through the
 * one printer, or — for a line with no share — a word ("no base", "refused",
 * "not disclosed at this detail level") or the gap glyph, each with the
 * reason in the reader's language as its title. Never 0 % for an absence.
 */
function ShareOnlyCell({ outcome, statement }: { outcome: ShareOutcome; statement: "PL" | "BS" }) {
  const { t, i18n } = useTranslation();
  const gap = (title?: string) => (
    <span className="cmp-cell cmp-cell--gap" title={title} aria-label={title}>
      {MONEY_MISSING}
    </span>
  );
  let cell: ReactNode;
  let status = "unmapped";
  if (outcome.kind === "share") {
    status = "share";
    cell = <span className="cmp-cell">{formatShare(outcome.share, i18n.language)}</span>;
  } else if (outcome.kind === "none") {
    status = outcome.status;
    const reason = t(shareReasonKey(outcome.status, statement));
    const wordKey = shareWordKey(outcome.status);
    cell = wordKey
      ? <span className="cmp-cell cmp-cell--word" title={reason}>{t(wordKey)}</span>
      : gap(reason);
  } else if (outcome.kind === "definition_differs") {
    status = "definition-differs";
    cell = gap(t("statements.cmp.share.definitionDiffers"));
  } else {
    // No engine line for this row: a blank cell, no claim.
    cell = gap();
  }
  return (
    <span
      className="cmp-cells"
      data-cmp="share-only"
      data-share-status={status}
      data-cmp-key={outcome.kind === "unmapped" ? undefined : outcome.key}
    >
      {cell}
    </span>
  );
}

/**
 * The cells for one row. `rowKey` is the row's `bucket` / `subtotalBucket`
 * (or a full engine key like "pl.ebitda"); `amount` is what the row shows,
 * which the parity guard compares against the engine's current figure. A
 * row on the one EBITDA is first held to a prior served on the same EBITDA
 * definition as the statement on screen (`ComparativeDefinitionProvider`),
 * the prior's stamp read off the served document.
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
  const single = useShareOnlyContext();
  const currentDefinition = useContext(DefinitionCtx);
  const { t, i18n } = useTranslation();
  const fmt = useAmountFormatter(ctx?.currency ?? "RON");
  if (!ctx) {
    // No document: the period's own share, or nothing at all.
    if (!single) return null;
    return <ShareOnlyCell outcome={shareForRow(single.block, rowKey, amount)} statement={single.statement} />;
  }
  const outcome = cellForRow(ctx.cells, rowKey, amount, {
    currentDefinition,
    priorStatements: ctx.doc.prior_statements,
  });
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
      case "absent_prior": return t(absentLineWordKey("absent_prior", ctx.ordered));
      case "absent_current": return t(absentLineWordKey("absent_current", ctx.ordered));
      case "not_disclosed_at_this_detail_level": return t("statements.cmp.notAtLevel");
      case "incomparable": return t("statements.cmp.notAtLevel");
      // The engine refused the figure in one period: no movement exists.
      case "refused": return t("statements.cmp.refused");
      default: return null;
    }
  };
  const refused = refusalWord();
  // A refusal's title is the refusing period's own reason, in the reader's
  // language, when the prior is the one that refused; else the engine note.
  const priorReason =
    c.status === "refused" && c.prior === null
      ? priorRefusalText(ctx.doc.prior_statements, c.key, i18n.language)
      : null;
  // In the reader's language (§26): decimal comma and "p.p." in Romanian.
  const deltaPctText = formatDeltaPct(c.deltaPct, i18n.language);
  const shareText = formatShare(c.currentShare, i18n.language);
  const ptsText = formatPts(c.deltaPts, i18n.language);

  return (
    <span className="cmp-cells" data-cmp={c.status} data-cmp-key={c.key}>
      {!bs && cols.prior && (
        c.prior === null
          ? (refused ? word(refused, priorReason ?? c.note) : gap(c.note))
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
        c.changeKind != null && isWordKind(c.changeKind)
          ? <span className="cmp-cell cmp-cell--word" title={c.note} data-change-kind={c.changeKind}>
              {t(changeKindWordKey(c.changeKind))}
            </span>
          : deltaPctText === null
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
 * Balance-sheet cells: Δ % and share.
 *
 * THE SHARE IS THE ENGINE'S (2026-10-04). It used to be divided here —
 * closing over total assets, a second division for the prior, a subtraction
 * for the points — the one share on the page the engine never computed. The
 * engine now serves it per canonical row: `shareKey` is the row's engine key
 * (`bs.row.<id>`, `bs.section.<id>`, `bs.total.assets`, …), the cell prints
 * the comparatives document's `current_share` and its change in points, and
 * — with no document — the period's own block. A row with no engine key (the
 * legacy, non-canonical build) carries no share: blank, never computed.
 *
 * The Δ % stays the one classifier's over the row's own opening and closing
 * (lib/changeKind.ts): the engine serves no percentage for a canonical row.
 */
export function BsCmpCells({
  opening,
  closing,
  shareKey,
  absentWord,
}: {
  opening: number | null | undefined;
  closing: number | null | undefined;
  /** The row's engine share key; undefined on a row the engine has no line
   *  for. */
  shareKey?: string;
  /** The word for a line one period lacks — "new" (the prior period has
   *  no such line) or "no longer present" (the current period has none).
   *  The view knows which side was unfilled because a period lacked the
   *  row. */
  absentWord?: string;
}) {
  const ctx = useComparativeContext();
  const single = useShareOnlyContext();
  const { t, i18n } = useTranslation();
  if (!ctx) {
    if (!single) return null;
    return <ShareOnlyCell outcome={shareForRow(single.block, shareKey, closing)} statement="BS" />;
  }
  const cols = ctx.columns;
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const gap = (title?: string) => (
    <span className="cmp-cell cmp-cell--gap" title={title}>{MONEY_MISSING}</span>
  );
  const word = (text: string) => <span className="cmp-cell cmp-cell--word" title={text}>{text}</span>;

  let pctNode: ReactNode = gap();
  if (isNum(opening) && isNum(closing)) {
    // The one classifier (plan_contract_v2 section 7): a percent only for a
    // same-sign move off a non-zero opening; words for every other kind.
    const change = classifyChange(opening, closing, ROUNDED_MONEY_ZERO_FLOOR);
    if (change.kind === "from_zero" || (change.kind === "compared" && change.deltaPct === null)) {
      pctNode = word(t("statements.cmp.noBase"));
    } else if (isWordKind(change.kind)) {
      pctNode = word(t(changeKindWordKey(change.kind)));
    } else {
      const ratio = Number(change.deltaPct);
      const text = formatDeltaPct(ratio, i18n.language);
      pctNode = text === null ? gap() : <span className={`cmp-cell ${signClass(ratio)}`}>{text}</span>;
    }
  } else if (!isNum(opening) && isNum(closing) && absentWord) {
    pctNode = word(absentWord);
  } else if (isNum(opening) && !isNum(closing) && absentWord) {
    pctNode = word(absentWord);
  }

  const row = shareKey ? ctx.shareRows.get(shareKey) : undefined;
  let shareNode: ReactNode;
  let shareStatus = "unmapped";
  if (!row) {
    // The document carries no share for this row (a row with no engine key,
    // or an engine that predates the canonical shares): blank, not computed.
    shareNode = gap(t("statements.cmp.share.unavailable"));
  } else if (ctx.block && !rowIsEngineFigure(closing, ctx.block.rows.get(row.key)?.current ?? null)) {
    // The row guard: the amount on the row is not the engine's for this key.
    shareStatus = "definition-differs";
    shareNode = gap(t("statements.cmp.share.definitionDiffers"));
  } else {
    shareStatus = row.status;
    const shareText = formatShare(row.current_share, i18n.language);
    const ptsText = formatPts(row.delta_pts, i18n.language);
    const noShare =
      row.status === "no_base"
        ? "statements.cmp.share.noBaseBs"
        : row.status === "absent_current" || row.status === "absent_both"
          ? "statements.cmp.share.absent"
          : "statements.cmp.share.unavailable";
    shareNode = shareText === null
      ? gap(t(noShare))
      : (
        <span className="cmp-cell" title={ptsText ? `${shareText} (${ptsText})` : shareText}>
          {shareText}
          {ptsText && <span className={`cmp-cell--pts ${signClass(row.delta_pts)}`}> {ptsText}</span>}
        </span>
      );
  }
  return (
    <span className="cmp-cells" data-cmp="bs" data-share-status={shareStatus} data-cmp-key={row?.key}>
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
  priorRefused = null,
}: {
  current: number | null | undefined;
  prior: number | null | undefined;
  /** The PRIOR statement is refused (its net result refused by the engine:
   *  no account 121, net 711 refused) — its reason. The prior cell and the
   *  delta print "refused" with it, never a figure built on a net profit
   *  nobody stated. */
  priorRefused?: string | null;
}) {
  const ctx = useComparativeContext();
  const fmt = useAmountFormatter(ctx?.currency ?? "RON");
  if (!ctx) return null;
  const cols = ctx.columns;
  if (priorRefused) {
    const refused = (
      <span className="cmp-cell cmp-cell--gap" data-cmp-refused="" title={priorRefused}>refused</span>
    );
    return (
      <span className="cmp-cells" data-cmp="cf">
        {cols.prior && refused}
        {cols.delta && refused}
      </span>
    );
  }
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
  currentTitle,
  priorTitle,
}: {
  currentLabel: string;
  priorLabel: string;
  shareLabel: string;
  columns: ComparativeColumns;
  /** Cash flow: [current][prior][Δ] only. */
  cf?: boolean;
  /** The source document behind each column (`sourceDocumentLine`), as
   *  the header cell's title — the file a reader can verify a column
   *  against. Undefined when the engine did not serve one. */
  currentTitle?: string;
  priorTitle?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="cmp-col-header" data-testid="cmp-col-header">
      <span />
      <span title={currentTitle} data-testid="cmp-col-current">{currentLabel}</span>
      {columns.prior && <span title={priorTitle} data-testid="cmp-col-prior">{priorLabel}</span>}
      {columns.delta && <span>{t("statements.cmp.colDelta")}</span>}
      {!cf && columns.deltaPct && <span>{t("statements.cmp.colDeltaPct")}</span>}
      {!cf && columns.share && <span>{shareLabel}</span>}
    </div>
  );
}
