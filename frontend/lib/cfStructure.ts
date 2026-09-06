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

export interface CashFlowStatement {
  entity: string;
  period: string;
  method: "indirect";
  currency: string;

  operating: {
    netProfit: number;
    /** ABSENT-CAPABLE. The public adapter derives D&A from the
     *  EBITDA − EBIT identity when the feed carries no
     *  `depreciation_total` leaf; when either term of that identity is
     *  missing there is no D&A figure, and a `0` on this line reads as
     *  "this company depreciates nothing". */
    depreciation: number | null;
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
