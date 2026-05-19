// Reference-format Cash Flow renderer.
//
// Produces the visible Cash Flow for the dashboard's Cash Flow tab.
// Indirect method. Visual conventions match PLStatementView /
// BSStatementView: monospace numbers, tabular-nums, double-line borders
// around the header + reconciliation block, parens for investing/
// financing outflows.
//
// Reads from buildCashFlowStatement(...) — the builder reconciles
// closing cash to the Balance Sheet within RON 1 and surfaces a
// transparent "WC reconciliation" plug line when prior-period data
// isn't available to itemize working-capital deltas.

import type { CashFlowStatement } from "@/lib/cfStructure";
import { formatRON, formatRONParen, formatRONSigned } from "@/lib/formatRon";
import "./cashFlowStatementView.css";

interface Props {
  statement: CashFlowStatement;
}

export function CashFlowStatementView({ statement }: Props) {
  const { operating, investing, financing, reconciliation, notes } = statement;
  const driftExceedsTolerance = Math.abs(reconciliation.drift) > 1;
  const showApproximationBanner = statement.isApproximated;

  return (
    <div className="cf-statement" data-testid="cf-statement">
      <div className="cf-header">
        <h2>
          CASH FLOW — {statement.entity} — {statement.period} ({statement.currency})
        </h2>
        <p className="cf-method">Indirect method</p>
      </div>

      {/* ── HONESTY BANNER ─────────────────────────────────────────── */}
      {/* Surfaced whenever the pipeline computed CF from a single period.
          Per CLAUDE.md Appendix A Section 4: "If only closing trial balance
          available, mark working capital changes as ~approximated with
          ±15% uncertainty band." The banner explains exactly what the user
          is looking at AND offers the upload-prior CTA so the limitation
          turns into an engagement loop. */}
      {showApproximationBanner && (
        <div
          data-testid="cf-approximation-banner"
          className="rounded-xl border border-amber-300/50 bg-amber-50/40 dark:bg-amber-500/[0.08] px-4 py-3 mb-4"
        >
          <div className="flex items-start gap-2.5">
            <span aria-hidden className="text-amber-700 dark:text-amber-300 mt-0.5">ⓘ</span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-amber-900 dark:text-amber-100">
                Cash flow is approximated
              </div>
              <p className="text-[12px] text-amber-900/85 dark:text-amber-100/85 mt-1 leading-relaxed">
                This is a single-period upload, so working-capital movements
                and financing detail can't be computed exactly. The
                reconciliation plug absorbs unmodeled accounts. For exact
                figures, upload the <strong>prior year trial balance</strong> as well.
              </p>
              {statement.approximationNotes.length > 0 && (
                <ul className="text-[11.5px] text-amber-900/80 dark:text-amber-100/80 mt-2 ml-3 list-disc space-y-0.5">
                  {statement.approximationNotes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <a
                  href="/financials"
                  data-testid="cf-upload-prior-cta"
                  className="inline-flex items-center gap-1.5 rounded-md bg-amber-700 hover:bg-amber-800 text-white px-3 py-1.5 text-[12px] font-medium transition-colors"
                >
                  Upload prior period
                </a>
                <span className="text-[11.5px] text-amber-900/70 dark:text-amber-100/70">
                  e.g. balanță FY2024 alongside FY2025
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="cf-body">
        {/* ── OPERATING ACTIVITIES ─────────────────────────────────── */}
        <section className="cf-section" data-testid="cf-section-operating">
          <div className="cf-section-header">OPERATING ACTIVITIES</div>

          <div className="cf-row cf-row-item">
            <span className="cf-code" />
            <span className="cf-label">Net profit</span>
            <span className="cf-amount">{formatRON(operating.netProfit)}</span>
          </div>
          <div className="cf-row cf-row-item">
            <span className="cf-code" />
            <span className="cf-label">+ Depreciation &amp; amortization</span>
            <span className="cf-amount">{formatRON(operating.depreciation)}</span>
          </div>

          <div className="cf-subtotal-rule" />
          <div className="cf-row cf-subtotal">
            <span className="cf-code" />
            <span className="cf-label">Operating CF before WC changes</span>
            <span className="cf-amount">{formatRON(operating.cfBeforeWcChanges)}</span>
          </div>

          {operating.wcChanges.length > 0 && (
            <>
              <div className="cf-subsection-header">Working capital changes:</div>
              {operating.wcChanges.map((wc, i) => (
                <div
                  key={`${wc.label}-${i}`}
                  className={`cf-row cf-row-wc ${wc.isPlug ? "cf-row-plug" : ""}`}
                  data-testid={wc.isPlug ? "cf-row-plug" : "cf-row-wc"}
                >
                  <span className="cf-code" />
                  <span className="cf-label">
                    {wc.label}
                    {wc.accounts && wc.accounts !== "residual" && (
                      <span className="cf-account-ref"> ({wc.accounts})</span>
                    )}
                  </span>
                  <span className="cf-amount">
                    {wc.delta >= 0
                      ? formatRONSigned(wc.delta, "positive")
                      : formatRONSigned(wc.delta, "negative")}
                  </span>
                </div>
              ))}
            </>
          )}

          <div className="cf-subtotal-rule" />
          <div className="cf-row cf-section-total" data-testid="cf-cash-from-operating">
            <span className="cf-code" />
            <span className="cf-label">Cash from operating activities</span>
            <span className="cf-amount">{formatRON(operating.cashFromOperating)}</span>
          </div>
        </section>

        {/* ── INVESTING ACTIVITIES ─────────────────────────────────── */}
        <section className="cf-section" data-testid="cf-section-investing">
          <div className="cf-section-header">INVESTING ACTIVITIES</div>
          {investing.items.map((item, i) => (
            <div key={`${item.label}-${i}`} className="cf-row cf-row-item">
              <span className="cf-code" />
              <span className="cf-label">
                {item.label}
                <span className="cf-account-ref"> ({item.accounts})</span>
              </span>
              <span className="cf-amount">{formatRONParen(item.amount)}</span>
            </div>
          ))}
          <div className="cf-subtotal-rule" />
          <div className="cf-row cf-section-total" data-testid="cf-cash-used-investing">
            <span className="cf-code" />
            <span className="cf-label">Cash used in investing</span>
            <span className="cf-amount">{formatRONParen(investing.cashUsedInInvesting)}</span>
          </div>
        </section>

        {/* ── FINANCING ACTIVITIES ─────────────────────────────────── */}
        <section className="cf-section" data-testid="cf-section-financing">
          <div className="cf-section-header">FINANCING ACTIVITIES</div>
          <div className="cf-row cf-row-item">
            <span className="cf-code" />
            <span className="cf-label">
              LT bank loan drawdowns
              <span className="cf-account-ref"> (1621 YTD credit)</span>
            </span>
            <span className="cf-amount">
              {financing.bankLoanDrawdowns > 0
                ? formatRONSigned(financing.bankLoanDrawdowns, "positive")
                : "—"}
            </span>
          </div>
          <div className="cf-row cf-row-item">
            <span className="cf-code" />
            <span className="cf-label">
              LT bank loan repayments
              <span className="cf-account-ref"> (1621 YTD debit)</span>
            </span>
            <span className="cf-amount">
              {financing.bankLoanRepayments < 0
                ? formatRONParen(financing.bankLoanRepayments)
                : "—"}
            </span>
          </div>
          <div className="cf-row cf-row-item">
            <span className="cf-code" />
            <span className="cf-label">
              Dividends paid in cash
              {financing.dividendsPaid === 0 && (
                <span className="cf-account-ref"> (only declared, see note)</span>
              )}
            </span>
            <span className="cf-amount">{formatRON(financing.dividendsPaid)}</span>
          </div>
          <div className="cf-subtotal-rule" />
          <div className="cf-row cf-section-total" data-testid="cf-cash-from-financing">
            <span className="cf-code" />
            <span className="cf-label">Cash from financing</span>
            <span className="cf-amount">
              {financing.cashFromFinancing >= 0
                ? formatRONSigned(financing.cashFromFinancing, "positive")
                : formatRONParen(financing.cashFromFinancing)}
            </span>
          </div>
        </section>

        {/* ── RECONCILIATION ───────────────────────────────────────── */}
        <section className="cf-reconciliation" data-testid="cf-reconciliation">
          <div className="cf-double-rule" />
          <div className="cf-row cf-recon-row">
            <span className="cf-code" />
            <span className="cf-label">Net change in cash</span>
            <span className="cf-amount">
              {reconciliation.netChangeInCash >= 0
                ? formatRONSigned(reconciliation.netChangeInCash, "positive")
                : formatRONParen(reconciliation.netChangeInCash)}
            </span>
          </div>
          <div className="cf-row cf-recon-row">
            <span className="cf-code" />
            <span className="cf-label">Opening cash</span>
            <span className="cf-amount">{formatRON(reconciliation.openingCash)}</span>
          </div>
          <div className="cf-row cf-recon-row cf-closing" data-testid="cf-closing-cash">
            <span className="cf-code" />
            <span className="cf-label">Closing cash</span>
            <span className="cf-amount">{formatRON(reconciliation.closingCashComputed)}</span>
          </div>
          <div className="cf-double-rule" />

          {driftExceedsTolerance && (
            <div className="cf-drift-warning" data-testid="cf-drift-warning">
              ⚠ Reconciliation drift: RON {reconciliation.drift.toFixed(2)} — closing
              cash on this statement does not match the Balance Sheet position
              ({formatRON(reconciliation.closingCashActual)}) within RON 1.
            </div>
          )}
        </section>

        {/* ── NOTES ────────────────────────────────────────────────── */}
        {notes.length > 0 && (
          <section className="cf-notes" data-testid="cf-notes">
            <h4>NOTES</h4>
            {notes.map((note, i) => (
              <p key={i} className="cf-note">{note}</p>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
