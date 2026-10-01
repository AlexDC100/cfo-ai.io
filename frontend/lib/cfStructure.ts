// Cash Flow statement — types matching the indirect-method reference layout.
//
// The shape mirrors PLStatement / BSStatement so the renderer can reuse
// the same grid + double-rule + parenthesis-for-outflow patterns.

export interface CFWorkingCapitalLine {
  /** Human label shown to the user. */
  label: string;
  /** Romanian COA reference (e.g. "401 + 408"). Shown as a small subscript next
   *  to the label so the CFO can audit the math. `residual` is the plug label. */
  accounts: string;
  /** Signed delta. Asset increase = negative (use of cash); liability increase
   *  = positive (source of cash). */
  delta: number;
  /** True when this line is the reconciliation plug, not a real account
   *  movement. Rendered in italic / muted color. */
  isPlug?: boolean;
}

export interface CFInvestingLine {
  label: string;
  accounts: string;
  /** Cash flow effect — outflow is negative; the view renders negatives in
   *  parentheses per the accounting convention shown in the reference. */
  amount: number;
}

/** What every cash-flow statement carries, refused or not. */
interface CashFlowStatementBase {
  entity: string;
  period: string;
  method: "indirect";
  currency: string;
  /** Honesty flag — true when the backend computed working-capital movements,
   *  CapEx, financing flows, or dividends paid from approximations rather
   *  than from real period-over-period movements. Drives the FE banner +
   *  upload-prior-period CTA. The banner reads: "Cash flow is approximated —
   *  upload prior year for exact figures."
   *
   *  Set by `_ro_coa.assembled_cf.is_approximated`. Becomes `false` once a
   *  multi-period upload threads a prior-period dataframe through the
   *  pipeline (planned, not yet shipped). */
  isApproximated: boolean;
  /** Human-readable list of what was approximated and why. Each entry
   *  becomes a bullet inside the approximation banner. */
  approximationNotes: string[];
  notes: string[];
}

/** A statement the indirect method was run for: every figure. */
export interface CashFlowStatementFigures extends CashFlowStatementBase {
  operating: {
    netProfit: number;
    /** ABSENT-CAPABLE. The public adapter derives D&A from the
     *  EBITDA − EBIT identity when the feed carries no
     *  `depreciation_total` leaf; when either term of that identity is
     *  missing there is no D&A figure, and a `0` on this line reads as
     *  "this company depreciates nothing". */
    depreciation: number | null;
    /** True when the add-back is the engine's cash-flow figure (all of 68x)
     *  and it holds more than the P&L's D&A — the 6812 / 6814 provision
     *  charges the owner's R2 ruling (2026-09-28) moved to their own P&L
     *  line. The row is then labelled for what it sums, not "D&A". */
    depreciationIncludesProvisionCharges?: boolean;
    /** ABSENT when `depreciation` is — `netProfit + null` is `netProfit`,
     *  which silently drops the add-back. */
    cfBeforeWcChanges: number | null;
    wcChanges: CFWorkingCapitalLine[];
    cashFromOperating: number;
  };

  investing: {
    items: CFInvestingLine[];
    cashUsedInInvesting: number;
  };

  financing: {
    bankLoanDrawdowns: number;
    bankLoanRepayments: number;
    dividendsPaid: number;
    cashFromFinancing: number;
  };

  reconciliation: {
    netChangeInCash: number;
    openingCash: number;
    closingCashComputed: number;
    closingCashActual: number;
    drift: number;
  };

  refusal?: null;
}

/** The engine REFUSED the net result the indirect method starts from (no
 *  account 121 and a refused net 711 — the build-up lacks the unmeasured
 *  stock variation). The statement is THE REFUSAL: it carries no figure
 *  at all (critic, fixer round 1 of 2026-09-27 — the builder used to
 *  return a full column built on a net profit of 0 beside the refusal,
 *  and only the two views that knew to look for it kept it off the page;
 *  now no view can print a figure of a refused statement, because there
 *  is none to print). */
export interface RefusedCashFlowStatement extends CashFlowStatementBase {
  refusal: { code: string; text: { ro: string; en: string } };
  operating?: undefined;
  investing?: undefined;
  financing?: undefined;
  reconciliation?: undefined;
}

export type CashFlowStatement = CashFlowStatementFigures | RefusedCashFlowStatement;

/** The statement's figures, or null when it is a refusal. */
export function cashFlowFigures(
  s: CashFlowStatement | null | undefined,
): CashFlowStatementFigures | null {
  return s && !s.refusal ? (s as CashFlowStatementFigures) : null;
}
