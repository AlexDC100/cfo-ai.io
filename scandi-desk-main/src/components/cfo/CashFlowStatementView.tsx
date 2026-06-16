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

import { useTranslation } from "react-i18next";
import type { CashFlowStatement } from "@/lib/cfStructure";
import { useAmountFormatter, useDisplayCurrency } from "@/stores/currency";
import { LearnableNumber } from "@/components/learning/LearnableNumber";
import { GuideMeButton } from "@/components/learning/GuideMeButton";
import { CF_GUIDE } from "@/components/learning/pageGuides";
import "./cashFlowStatementView.css";

interface Props {
  statement: CashFlowStatement;
}

export function CashFlowStatementView({ statement }: Props) {
  const { t } = useTranslation();
  const { operating, investing, financing, reconciliation, notes } = statement;
  const driftExceedsTolerance = Math.abs(reconciliation.drift) > 1;
  const showApproximationBanner = statement.isApproximated;
  // 2026-05-24 — currency conversion via display-currency toggle.
  const fmt = useAmountFormatter(statement.currency);
  const display = useDisplayCurrency();

  return (
    <div className="cf-statement" data-testid="cf-statement">
      <div className="cf-header" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2>
            {t("statements.cf.title")} — {statement.entity} — {statement.period} ({display})
          </h2>
          <p className="cf-method">{t("statements.cf.indirectMethod")}</p>
        </div>
        <GuideMeButton pageId="cash-flow" title="Cash Flow" steps={CF_GUIDE} />
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
                {t("statements.cf.approximated.heading")}
              </div>
              <p className="text-[12px] text-amber-900/85 dark:text-amber-100/85 mt-1 leading-relaxed">
                {t("statements.cf.approximated.body")}
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
                  {t("statements.cf.approximated.cta")}
                </a>
                <span className="text-[11.5px] text-amber-900/70 dark:text-amber-100/70">
                  {t("statements.cf.approximated.hint")}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="cf-body">
        {/* ── OPERATING ACTIVITIES ─────────────────────────────────── */}
        <section className="cf-section" data-testid="cf-section-operating" data-guide="cf-operating">
          <div className="cf-section-header">{t("statements.cf.operating.header")}</div>

          <div className="cf-row cf-row-item">
            <span className="cf-code" />
            <span className="cf-label">{t("statements.cf.operating.netProfit")}</span>
            <LearnableNumber conceptKey="net_profit" value={operating.netProfit} className="cf-amount" block>
              {fmt(operating.netProfit)}
            </LearnableNumber>
          </div>
          <div className="cf-row cf-row-item">
            <span className="cf-code" />
            <span className="cf-label">{t("statements.cf.operating.depreciation")}</span>
            <LearnableNumber conceptKey="depreciation_amortization" value={operating.depreciation} className="cf-amount" block>
              {fmt(operating.depreciation)}
            </LearnableNumber>
          </div>

          <div className="cf-subtotal-rule" />
          <div className="cf-row cf-subtotal">
            <span className="cf-code" />
            <span className="cf-label">{t("statements.cf.operating.cfBeforeWc")}</span>
            <LearnableNumber conceptKey="operating_cash_flow_before_wc" value={operating.cfBeforeWcChanges} className="cf-amount" block>
              {fmt(operating.cfBeforeWcChanges)}
            </LearnableNumber>
          </div>

          {operating.wcChanges.length > 0 && (
            <>
              <div className="cf-subsection-header">{t("statements.cf.operating.wcChanges")}</div>
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
                  <LearnableNumber conceptKey="working_capital_changes" value={wc.delta} className="cf-amount" block>
                    {wc.delta >= 0
                      ? fmt(wc.delta, { sign: "positive" })
                      : fmt(wc.delta, { sign: "negative" })}
                  </LearnableNumber>
                </div>
              ))}
            </>
          )}

          <div className="cf-subtotal-rule" />
          <div className="cf-row cf-section-total" data-testid="cf-cash-from-operating">
            <span className="cf-code" />
            <span className="cf-label">{t("statements.cf.operating.cashFromOperating")}</span>
            <LearnableNumber conceptKey="operating_cash_flow" value={operating.cashFromOperating} className="cf-amount" block>
              {fmt(operating.cashFromOperating)}
            </LearnableNumber>
          </div>
        </section>

        {/* ── INVESTING ACTIVITIES ─────────────────────────────────── */}
        <section className="cf-section" data-testid="cf-section-investing" data-guide="cf-investing">
          <div className="cf-section-header">{t("statements.cf.investing.header")}</div>
          {investing.items.map((item, i) => (
            <div key={`${item.label}-${i}`} className="cf-row cf-row-item">
              <span className="cf-code" />
              <span className="cf-label">
                {item.label}
                <span className="cf-account-ref"> ({item.accounts})</span>
              </span>
              <LearnableNumber conceptKey="capex" value={item.amount} className="cf-amount" block>
                {fmt(item.amount, { paren: true })}
              </LearnableNumber>
            </div>
          ))}
          <div className="cf-subtotal-rule" />
          <div className="cf-row cf-section-total" data-testid="cf-cash-used-investing">
            <span className="cf-code" />
            <span className="cf-label">{t("statements.cf.investing.cashUsed")}</span>
            <LearnableNumber conceptKey="investing_cash_flow" value={investing.cashUsedInInvesting} className="cf-amount" block>
              {fmt(investing.cashUsedInInvesting, { paren: true })}
            </LearnableNumber>
          </div>
        </section>

        {/* ── FINANCING ACTIVITIES ─────────────────────────────────── */}
        <section className="cf-section" data-testid="cf-section-financing" data-guide="cf-financing">
          <div className="cf-section-header">{t("statements.cf.financing.header")}</div>
          <div className="cf-row cf-row-item">
            <span className="cf-code" />
            <span className="cf-label">
              {t("statements.cf.financing.ltDraws")}
              <span className="cf-account-ref"> (1621 YTD credit)</span>
            </span>
            <LearnableNumber conceptKey="lt_debt_drawdowns" value={financing.bankLoanDrawdowns} className="cf-amount" block>
              {financing.bankLoanDrawdowns > 0
                ? fmt(financing.bankLoanDrawdowns, { sign: "positive" })
                : "—"}
            </LearnableNumber>
          </div>
          <div className="cf-row cf-row-item">
            <span className="cf-code" />
            <span className="cf-label">
              {t("statements.cf.financing.ltRepays")}
              <span className="cf-account-ref"> (1621 YTD debit)</span>
            </span>
            <LearnableNumber conceptKey="lt_debt_repayments" value={financing.bankLoanRepayments} className="cf-amount" block>
              {financing.bankLoanRepayments < 0
                ? fmt(financing.bankLoanRepayments, { paren: true })
                : "—"}
            </LearnableNumber>
          </div>
          <div className="cf-row cf-row-item">
            <span className="cf-code" />
            <span className="cf-label">
              {t("statements.cf.financing.dividendsPaid")}
              {financing.dividendsPaid === 0 && (
                <span className="cf-account-ref"> ({t("statements.cf.financing.onlyDeclared")})</span>
              )}
            </span>
            <LearnableNumber conceptKey="dividends_paid" value={financing.dividendsPaid} className="cf-amount" block>
              {fmt(financing.dividendsPaid)}
            </LearnableNumber>
          </div>
          <div className="cf-subtotal-rule" />
          <div className="cf-row cf-section-total" data-testid="cf-cash-from-financing">
            <span className="cf-code" />
            <span className="cf-label">{t("statements.cf.financing.cashFromFinancing")}</span>
            <LearnableNumber conceptKey="financing_cash_flow" value={financing.cashFromFinancing} className="cf-amount" block>
              {financing.cashFromFinancing >= 0
                ? fmt(financing.cashFromFinancing, { sign: "positive" })
                : fmt(financing.cashFromFinancing, { paren: true })}
            </LearnableNumber>
          </div>
        </section>

        {/* ── RECONCILIATION ───────────────────────────────────────── */}
        <section className="cf-reconciliation" data-testid="cf-reconciliation">
          <div className="cf-double-rule" />
          <div className="cf-row cf-recon-row">
            <span className="cf-code" />
            <span className="cf-label">{t("statements.cf.recon.netChange")}</span>
            <LearnableNumber conceptKey="net_change_in_cash" value={reconciliation.netChangeInCash} className="cf-amount" block>
              {reconciliation.netChangeInCash >= 0
                ? fmt(reconciliation.netChangeInCash, { sign: "positive" })
                : fmt(reconciliation.netChangeInCash, { paren: true })}
            </LearnableNumber>
          </div>
          <div className="cf-row cf-recon-row">
            <span className="cf-code" />
            <span className="cf-label">{t("statements.cf.recon.opening")}</span>
            <LearnableNumber conceptKey="opening_cash" value={reconciliation.openingCash} className="cf-amount" block>
              {fmt(reconciliation.openingCash)}
            </LearnableNumber>
          </div>
          <div className="cf-row cf-recon-row cf-closing" data-testid="cf-closing-cash">
            <span className="cf-code" />
            <span className="cf-label">{t("statements.cf.recon.closing")}</span>
            <LearnableNumber conceptKey="closing_cash" value={reconciliation.closingCashComputed} className="cf-amount" block>
              {fmt(reconciliation.closingCashComputed)}
            </LearnableNumber>
          </div>
          <div className="cf-double-rule" />

          {driftExceedsTolerance && (
            <div className="cf-drift-warning" data-testid="cf-drift-warning">
              ⚠ {t("statements.cf.recon.drift")}: {fmt(reconciliation.drift)} ({fmt(reconciliation.closingCashActual)}).
            </div>
          )}
        </section>

        {/* ── NOTES ────────────────────────────────────────────────── */}
        {notes.length > 0 && (
          <section className="cf-notes" data-testid="cf-notes">
            <h4>{t("statements.cf.notes")}</h4>
            {notes.map((note, i) => (
              <p key={i} className="cf-note">{note}</p>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
