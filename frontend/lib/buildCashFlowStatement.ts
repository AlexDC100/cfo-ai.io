// Cash Flow statement — indirect method. Builds a renderable
// CashFlowStatement from the canonical period_facts views
// (`assembled_pl`, `assembled_bs`, `assembled_cf`) the backend attaches
// to the `/api/period` response.
//
// Reconciliation guarantee: closing_cash_computed equals
// balanceSheet.cash within RON 1. When the model can't compute working-
// capital deltas line-by-line (no prior-period data threaded through),
// the residual is captured as a single "WC reconciliation" plug line —
// transparent, explained in the notes block, never silently absorbed.
//
// Sign convention (standard indirect method):
//   • Operating: starting at NI, add back non-cash D&A, then signed WC
//     deltas (asset ↑ = negative, liability ↑ = positive).
//   • Investing: outflows negative (rendered in parens by the view).
//   • Financing: drawdowns positive, repayments negative.

import type { ApiLineItem } from "./plStructure";
import type { CFInvestingLine, CFWorkingCapitalLine, CashFlowStatement } from "./cfStructure";

interface BuildArgs {
  /** Canonical PL view from the backend (`statements.assembled_pl`). */
  pl: Record<string, number> | undefined;
  /** Canonical BS view (`statements.assembled_bs`). */
  bs: Record<string, number> | undefined;
  /** Canonical CF view (`statements.assembled_cf`). Mixed types — most
   *  fields are numeric, but `is_approximated` is boolean and
   *  `approximation_notes` is a string[]. The build function narrows. */
  cf: Record<string, number | boolean | string[] | undefined> | undefined;
  /** Per-account line items — used to read account 1621 (LT bank debt)
   *  closing balance when computing a plug-free financing line. Optional. */
  lineItems?: ApiLineItem[];
  /** Entity name + period label for the rendered header. */
  entity: string;
  period: string;
  currency?: string;
  /** Year label for notes (e.g. "2025"). */
  yearLabel?: string;
}

export function buildCashFlowStatement(args: BuildArgs): CashFlowStatement {
  const currency = args.currency ?? "RON";
  const pl = args.pl ?? {};
  const bs = args.bs ?? {};
  const cf = args.cf ?? {};
  const yearLabel = args.yearLabel ?? "the period";

  // ── OPERATING ────────────────────────────────────────────────────────
  // Net profit (statutory — the same view the P&L tab + briefing use).
  const netProfit = pl.net_income_statutory ?? cf.net_profit ?? 0;
  const depreciation = pl.depreciation ?? cf.depreciation ?? 0;
  const cfBeforeWcChanges = netProfit + depreciation;

  // ── INVESTING — REAL capex (CIP additions), not D&A ──────────────────
  // The canonical view exposes capex_real as negative cash. When the FE
  // builder finds per-account 231 (CIP) movements, it surfaces them
  // separately; else it falls back to the canonical aggregate.
  const cipCapex = cf.capitalized_construction ?? -((pl.capitalized_own_work_memo ?? 0));
  const otherLtRecvDelta = cf.net_change_other_lt_receivables ?? 0;
  const investingItems: CFInvestingLine[] = [
    {
      label: "Capitalized construction",
      accounts: "231 additions",
      amount: cipCapex,
    },
  ];
  if (otherLtRecvDelta !== 0) {
    investingItems.push({
      label: "Net change in other LT receivables",
      accounts: "2678",
      amount: otherLtRecvDelta,
    });
  }
  const cashUsedInInvesting =
    cf.cash_used_in_investing ?? investingItems.reduce((s, it) => s + it.amount, 0);

  // ── FINANCING ────────────────────────────────────────────────────────
  // YTD bank drawdowns / repayments come from raw account 1621 (st_c /
  // st_d). The canonical view surfaces them when extraction populates
  // them; absent that, we default to zero and let the WC plug capture
  // the financing flow (a single line item the user can audit).
  const bankLoanDrawdowns = cf.bank_loan_drawdowns ?? 0;
  const bankLoanRepayments = cf.bank_loan_repayments ?? 0; // negative (cash out)
  const dividendsPaid = cf.dividends_paid ?? 0;
  const cashFromFinancing = bankLoanDrawdowns + bankLoanRepayments + dividendsPaid;

  // ── RECONCILE ────────────────────────────────────────────────────────
  // The backend canonical_cf gives us closing_cash_actual. Opening cash:
  // closing − net_change_in_cash when supplied, else closing − the
  // computed (CFO + investing + financing) which collapses the model.
  const closingCashActual = cf.closing_cash_actual ?? bs.cash ?? 0;
  // When the backend provided a real opening cash we use it. Otherwise,
  // approximate from net change — degrades gracefully to a single
  // reconciliation plug rather than producing a nonsense delta.
  const reportedNetChange = cf.net_change_in_cash;
  const openingCash =
    typeof reportedNetChange === "number"
      ? closingCashActual - reportedNetChange
      : closingCashActual; // fall back: no opening data → no apparent change

  // ── WORKING CAPITAL: line-by-line when we can; plug otherwise ───────
  // The synthetic stub doesn't carry prior-period balances, so wcChanges
  // is just the reconciliation plug. When real prior-period data lands
  // (multi-period uploads), we'll itemize Δ trade receivables, Δ trade
  // payables, Δ tax & social, etc., and the plug will shrink toward zero.
  const actualNetChangeInCash = closingCashActual - openingCash;
  const modeledCfo = cfBeforeWcChanges; // (no per-account WC deltas yet)
  const netChangeBeforePlug = modeledCfo + cashUsedInInvesting + cashFromFinancing;
  const wcReconciliationPlug = actualNetChangeInCash - netChangeBeforePlug;

  const wcChanges: CFWorkingCapitalLine[] = [];
  if (Math.abs(wcReconciliationPlug) > 1) {
    wcChanges.push({
      label: "WC reconciliation (other unmodeled accounts)",
      accounts: "residual",
      delta: wcReconciliationPlug,
      isPlug: true,
    });
  }
  const cashFromOperating = modeledCfo + wcReconciliationPlug;

  const netChangeInCash = cashFromOperating + cashUsedInInvesting + cashFromFinancing;
  const closingCashComputed = openingCash + netChangeInCash;
  const drift = closingCashComputed - closingCashActual; // should be < RON 1

  // ── NOTES ────────────────────────────────────────────────────────────
  const notes: string[] = [];
  const dividendsPayable = bs.ap_dividends ?? 0;
  if (dividendsPayable > 1000) {
    notes.push(
      `Dividends of RON ${Math.round(dividendsPayable).toLocaleString()} were ` +
      `DECLARED (debit to 1171 retained earnings, credit to 457 dividends ` +
      `payable) but NOT paid in cash during ${yearLabel} — they sit on the ` +
      `balance sheet as a current liability awaiting distribution. Cash ` +
      `distribution would reduce cash by RON ${Math.round(dividendsPayable).toLocaleString()} ` +
      `if paid out next period.`
    );
  }
  if (Math.abs(wcReconciliationPlug) > 50_000) {
    const direction = wcReconciliationPlug < 0 ? "use of" : "source of";
    notes.push(
      `Working capital reconciliation includes a RON ` +
      `${Math.round(Math.abs(wcReconciliationPlug)).toLocaleString()} ${direction} cash ` +
      `for movements in accounts not explicitly modeled (working-capital ` +
      `deltas, financing flows where YTD st_c / st_d are missing, retained-` +
      `earnings adjustments). The statement balances to the BS cash position ` +
      `of RON ${Math.round(closingCashActual).toLocaleString()} within RON 1.`
    );
  }
  if (
    bankLoanDrawdowns === 0 &&
    bankLoanRepayments === 0 &&
    (bs.total_debt ?? 0) > 0
  ) {
    notes.push(
      `Financing detail unavailable: the trial balance extraction did not ` +
      `surface YTD drawdowns (1621:st_c) and repayments (1621:st_d) ` +
      `separately. Once raw account movements thread through the pipeline, ` +
      `these will appear as explicit financing lines and the WC ` +
      `reconciliation plug will shrink accordingly.`
    );
  }

  // Honesty rails — drive the FE banner + upload-prior CTA. The backend
  // sets `is_approximated=true` whenever it computed CF from a single
  // period (no prior_bs to diff against). Approximation notes spell out
  // exactly what was estimated.
  const isApproximated = Boolean(cf.is_approximated ?? true);
  const approximationNotes: string[] = Array.isArray(cf.approximation_notes)
    ? (cf.approximation_notes as unknown[]).map((n) => String(n))
    : [];

  return {
    entity: args.entity,
    period: args.period,
    method: "indirect",
    currency,
    operating: {
      netProfit,
      depreciation,
      cfBeforeWcChanges,
      wcChanges,
      cashFromOperating,
    },
    investing: {
      items: investingItems,
      cashUsedInInvesting,
    },
    financing: {
      bankLoanDrawdowns,
      bankLoanRepayments,
      dividendsPaid,
      cashFromFinancing,
    },
    reconciliation: {
      netChangeInCash,
      openingCash,
      closingCashComputed,
      closingCashActual,
      drift,
    },
    isApproximated,
    approximationNotes,
    notes,
  };
}
