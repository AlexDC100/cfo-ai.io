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

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, ArrowUp } from "lucide-react";
import type { CashFlowStatement } from "@/lib/cfStructure";
import { useAmountFormatter, useDisplayCurrency } from "@/stores/currency";
// THE DIAL — Simple mode opens the CF totals-first: adjustment / working-
// capital / investing / financing detail rows hide behind "Show all lines";
// section totals and the cash reconciliation block (an honesty surface)
// always render. Pro is untouched; no VALUE depends on mode.
import { useIsSimple } from "@/lib/viewMode";
import { ShowAllLinesToggle } from "@/components/cfo/simple/ShowAllLines";
import { SimpleTermLabel } from "@/components/cfo/simple/SimpleTermLabel";
import { LearnableNumber } from "@/components/learning/LearnableNumber";
import { GuideMeButton } from "@/components/learning/GuideMeButton";
import { CF_GUIDE } from "@/components/learning/pageGuides";
import { AccountChip, StatementCurrencyChip } from "./AccountChip";
import "./cashFlowStatementView.css";

interface Props {
  statement: CashFlowStatement;
  /** Hide the inline "Guide me" button (dashboard consolidates guides). */
  hideGuide?: boolean;
}

export function CashFlowStatementView({ statement, hideGuide = false }: Props) {
  const { t } = useTranslation();
  const { operating, investing, financing, reconciliation, notes } = statement;
  const driftExceedsTolerance = Math.abs(reconciliation.drift) > 1;
  const showApproximationBanner = statement.isApproximated;
  // 2026-05-24 — currency conversion via display-currency toggle.
  const fmt = useAmountFormatter(statement.currency);
  const display = useDisplayCurrency();
  // THE DIAL — Simple collapsed state (detail rows only; totals + the
  // reconciliation block and every honesty banner always render).
  const isSimple = useIsSimple();
  const [showAll, setShowAll] = useState(false);
  const keyOnly = isSimple && !showAll;

  return (
    <div className={(showApproximationBanner || notes.length > 0) ? "lg:grid lg:grid-cols-[auto_minmax(440px,560px)] lg:gap-3 lg:items-start lg:justify-center" : ""}>
      <div className="cf-statement" data-testid="cf-statement">
      <div className="cf-header" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h2>
              {t("statements.cf.title")} — {statement.entity} — {statement.period} ({display})
            </h2>
            <StatementCurrencyChip currency={statement.currency} />
          </div>
          <p className="cf-method">{t("statements.cf.indirectMethod")}</p>
        </div>
        {!hideGuide && <GuideMeButton pageId="cash-flow" title="Cash Flow" steps={CF_GUIDE} />}
      </div>

      {/* THE DIAL — Simple-only disclosure toggle. Pro never renders it. */}
      {isSimple && (
        <ShowAllLinesToggle
          open={showAll}
          onToggle={() => setShowAll((v) => !v)}
          testid="cf-show-all"
        />
      )}

      <div className="cf-body">
        {/* ── OPERATING ACTIVITIES ─────────────────────────────────── */}
        <section className="cf-section" data-testid="cf-section-operating" data-guide="cf-operating">
          <div className="cf-section-header">{t("statements.cf.operating.header")}</div>

          {!keyOnly && (
            <>
              <div className="cf-row cf-row-item">
                <span className="cf-label">
                  <SimpleTermLabel termId="net_profit">
                    {t("statements.cf.operating.netProfit")}
                  </SimpleTermLabel>
                </span>
                <LearnableNumber conceptKey="net_profit" value={operating.netProfit} className="cf-amount" block>
                  {fmt(operating.netProfit)}
                </LearnableNumber>
              </div>
              <div className="cf-row cf-row-item">
                <span className="cf-label">
                  <SimpleTermLabel termId="depreciation">
                    {t("statements.cf.operating.depreciation")}
                  </SimpleTermLabel>
                </span>
                <LearnableNumber conceptKey="depreciation_amortization" value={operating.depreciation} className="cf-amount" block>
                  {fmt(operating.depreciation)}
                </LearnableNumber>
              </div>

              <div className="cf-subtotal-rule" />
            </>
          )}
          <div className="cf-row cf-subtotal">
            <span className="cf-label">{t("statements.cf.operating.cfBeforeWc")}</span>
            <LearnableNumber conceptKey="operating_cash_flow_before_wc" value={operating.cfBeforeWcChanges} className="cf-amount" block>
              {fmt(operating.cfBeforeWcChanges)}
            </LearnableNumber>
          </div>

          {!keyOnly && operating.wcChanges.length > 0 && (
            <>
              <div className="cf-subsection-header">{t("statements.cf.operating.wcChanges")}</div>
              {operating.wcChanges.map((wc, i) => (
                <div
                  key={`${wc.label}-${i}`}
                  className={`cf-row cf-row-wc ${wc.isPlug ? "cf-row-plug" : ""}`}
                  data-testid={wc.isPlug ? "cf-row-plug" : "cf-row-wc"}
                >
                        <span className="cf-label">
                    {wc.label}
                    {wc.accounts && wc.accounts !== "residual" && (
                      <AccountChip code={wc.accounts} />
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
            <span className="cf-label">
              <SimpleTermLabel termId="cash_flow">
                {t("statements.cf.operating.cashFromOperating")}
              </SimpleTermLabel>
            </span>
            <LearnableNumber conceptKey="operating_cash_flow" value={operating.cashFromOperating} className="cf-amount" block>
              {fmt(operating.cashFromOperating)}
            </LearnableNumber>
          </div>
        </section>

        {/* ── INVESTING ACTIVITIES ─────────────────────────────────── */}
        <section className="cf-section" data-testid="cf-section-investing" data-guide="cf-investing">
          <div className="cf-section-header">{t("statements.cf.investing.header")}</div>
          {!keyOnly && investing.items.map((item, i) => (
            <div key={`${item.label}-${i}`} className="cf-row cf-row-item">
                <span className="cf-label">
                {item.label}
                <AccountChip code={item.accounts} />
              </span>
              <LearnableNumber conceptKey="capex" value={item.amount} className="cf-amount" block>
                {fmt(item.amount, { paren: true })}
              </LearnableNumber>
            </div>
          ))}
          <div className="cf-subtotal-rule" />
          <div className="cf-row cf-section-total" data-testid="cf-cash-used-investing">
            <span className="cf-label">{t("statements.cf.investing.cashUsed")}</span>
            <LearnableNumber conceptKey="investing_cash_flow" value={investing.cashUsedInInvesting} className="cf-amount" block>
              {fmt(investing.cashUsedInInvesting, { paren: true })}
            </LearnableNumber>
          </div>
        </section>

        {/* ── FINANCING ACTIVITIES ─────────────────────────────────── */}
        <section className="cf-section" data-testid="cf-section-financing" data-guide="cf-financing">
          <div className="cf-section-header">{t("statements.cf.financing.header")}</div>
          {!keyOnly && (
          <>
          <div className="cf-row cf-row-item">
            <span className="cf-label">
              {t("statements.cf.financing.ltDraws")}
              <AccountChip code="1621" />
              <span className="cf-account-ref">{t("tablesV2.cf.ytdCredit", "YTD credit")}</span>
            </span>
            <LearnableNumber conceptKey="lt_debt_drawdowns" value={financing.bankLoanDrawdowns} className="cf-amount" block>
              {financing.bankLoanDrawdowns > 0
                ? fmt(financing.bankLoanDrawdowns, { sign: "positive" })
                : "—"}
            </LearnableNumber>
          </div>
          <div className="cf-row cf-row-item">
            <span className="cf-label">
              {t("statements.cf.financing.ltRepays")}
              <AccountChip code="1621" />
              <span className="cf-account-ref">{t("tablesV2.cf.ytdDebit", "YTD debit")}</span>
            </span>
            <LearnableNumber conceptKey="lt_debt_repayments" value={financing.bankLoanRepayments} className="cf-amount" block>
              {financing.bankLoanRepayments < 0
                ? fmt(financing.bankLoanRepayments, { paren: true })
                : "—"}
            </LearnableNumber>
          </div>
          <div className="cf-row cf-row-item">
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
          </>
          )}
          <div className="cf-subtotal-rule" />
          <div className="cf-row cf-section-total" data-testid="cf-cash-from-financing">
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
            <span className="cf-label">{t("statements.cf.recon.netChange")}</span>
            <LearnableNumber conceptKey="net_change_in_cash" value={reconciliation.netChangeInCash} className="cf-amount" block>
              {reconciliation.netChangeInCash >= 0
                ? fmt(reconciliation.netChangeInCash, { sign: "positive" })
                : fmt(reconciliation.netChangeInCash, { paren: true })}
            </LearnableNumber>
          </div>
          <div className="cf-row cf-recon-row">
            <span className="cf-label">{t("statements.cf.recon.opening")}</span>
            <LearnableNumber conceptKey="opening_cash" value={reconciliation.openingCash} className="cf-amount" block>
              {fmt(reconciliation.openingCash)}
            </LearnableNumber>
          </div>
          <div className="cf-row cf-recon-row cf-closing" data-testid="cf-closing-cash">
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
      </div>
      </div>
        {/* ── HONESTY BANNER ── OUTSIDE the .cf-statement bordered card
            (2026-07-25): a sibling in the grid, to the RIGHT of the statement,
            shown when the period was computed from a single trial balance. */}
        {(showApproximationBanner || notes.length > 0) && (
          <aside className="mt-2 lg:mt-0 space-y-4">
            {showApproximationBanner && (
            <div
              data-testid="cf-approximation-banner"
              className="relative overflow-hidden rounded-2xl border-2 border-dashed border-rule/80 bg-gradient-to-br from-bg-2/30 via-surface/60 to-surface/40 p-5"
            >
              {/* Dropzone-style atmospheric glow + oversized clipped mark. */}
              <div aria-hidden className="pointer-events-none absolute -top-16 -right-10 h-40 w-40 rounded-full bg-brand/8 blur-3xl" />
              <div aria-hidden className="pointer-events-none absolute -bottom-24 -left-12 text-ink opacity-[0.06]">
                <Cloud size={260} strokeWidth={1} />
                <ArrowUp size={92} strokeWidth={2.5} className="absolute left-1/2 top-[60%] -translate-x-1/2 -translate-y-1/2" />
              </div>
              <div className="relative flex items-start gap-2.5">
                <span aria-hidden className="text-brand mt-0.5">ⓘ</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-brand-d dark:text-ink">
                    {t("statements.cf.approximated.heading")}
                  </div>
                  <p className="text-[12px] text-brand-d/85 dark:text-ink/85 mt-1 leading-relaxed">
                    {t("statements.cf.approximated.body")}
                  </p>
                  {statement.approximationNotes.length > 0 && (
                    <ul className="text-[11.5px] text-brand-d/80 dark:text-ink/80 mt-2 ml-3 list-disc space-y-0.5">
                      {statement.approximationNotes.map((note, i) => (
                        <li key={i}>{note}</li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <a
                      href="/financials"
                      data-testid="cf-upload-prior-cta"
                      className="inline-flex items-center gap-1.5 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink px-3 py-1.5 text-[12px] font-medium hover:border-brand/60 transition-colors"
                    >
                      {t("statements.cf.approximated.cta")}
                    </a>
                    <span className="text-[11.5px] text-brand-d/70 dark:text-ink/70">
                      {t("statements.cf.approximated.hint")}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            )}
            {/* NOTES — moved OUT of the .cf-statement card (2026-07-25), to the
                right, under the approximation callout. */}
            {notes.length > 0 && (
              <section className="cf-notes-aside rounded-2xl border border-rule bg-surface p-4" data-testid="cf-notes">
                <h4 className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold mb-2">
                  {t("statements.cf.notes")}
                </h4>
                <div className="space-y-2">
                  {notes.map((note, i) => (
                    <p key={i} className="text-[12px] text-ink-soft leading-relaxed">{note}</p>
                  ))}
                </div>
              </section>
            )}
          </aside>
        )}
      </div>
  );
}
