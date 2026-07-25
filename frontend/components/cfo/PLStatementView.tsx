// Reference-format P&L renderer.
//
// Produces the visible P&L for the financial-statements tab. Layout matches
// the spec the user provided exactly: account codes in the left column,
// labels in the middle, amounts right-aligned with tabular-nums, EBITDA
// boxed with double borders, financial items with explicit ± signs, key
// margins + reconciliation footnote below.
//
// All visual conventions live in the .pl-* classes — see plStatementView.css.

import { useTranslation } from "react-i18next";
import type { PLStatement, PLSection, PLLine } from "@/lib/plStructure";
import { formatPercent } from "@/lib/formatRon";
import { useAmountFormatter, useDisplayCurrency } from "@/stores/currency";
import { TRACEABLE_TARGET_ATTR } from "@/lib/traceableSource";
import { useHighlightFromUrl } from "./useHighlightFromUrl";
import { LearnableNumber } from "@/components/learning/LearnableNumber";
import { bucketToConcept } from "@/lib/learning/bucketToConcept";
import { GuideMeButton } from "@/components/learning/GuideMeButton";
import { PL_GUIDE } from "@/components/learning/pageGuides";
import "./plStatementView.css";

interface Props {
  statement: PLStatement;
  /** Show the reconciliation footnote (capitalized own-work + 628 explanation). */
  showFootnote?: boolean;
  /** Hide the inline "Guide me" button — the dashboard consolidates all tab
   *  guides into a single button in the tab bar. */
  hideGuide?: boolean;
}

export function PLStatementView({ statement, showFootnote = true, hideGuide = false }: Props) {
  useHighlightFromUrl();
  const { t } = useTranslation();
  const fmt = useAmountFormatter(statement.currency);
  const display = useDisplayCurrency();

  const [operatingRevenue, operatingExpenses, depreciationSection, financialItems, closingSection] =
    statement.sections;

  return (
    <div className="pl-statement" data-testid="pl-statement">
      <div className="pl-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2>
          {t("statements.pl.title")} — {statement.entity} — {statement.period} ({display})
        </h2>
        {!hideGuide && <GuideMeButton pageId="pnl" title="P&L" steps={PL_GUIDE} />}
      </div>

      <div className="pl-body">
        {/* OPERATING REVENUE */}
        <div data-guide="pl-revenue">
          <PLSectionView section={operatingRevenue} currency={statement.currency} />
        </div>

        {/* OPERATING EXPENSES */}
        <PLSectionView section={operatingExpenses} currency={statement.currency} />

        {/* EBITDA — boxed off with double borders. */}
        <div
          className="pl-ebitda-box"
          data-guide="pl-ebitda"
          {...{ [TRACEABLE_TARGET_ATTR]: "ebitda" }}
        >
          <div className="pl-row pl-total">
            <span className="pl-code" />
            <span className="pl-label">{t("statements.pl.ebitda")}</span>
            <LearnableNumber conceptKey="ebitda" value={statement.ebitda} className="pl-amount" block>
              {fmt(statement.ebitda)}
            </LearnableNumber>
          </div>
        </div>

        {/* D&A → EBIT */}
        <PLSectionView section={depreciationSection} currency={statement.currency} />

        {/* FINANCIAL ITEMS */}
        <PLSectionView section={financialItems} currency={statement.currency} />

        {/* PBT → NET PROFIT (operational headline) */}
        <div data-guide="pl-net-profit">
          <PLSectionView section={closingSection} currency={statement.currency} />
        </div>

        {statement.capitalizedOwnWorkMemo != null &&
          Math.abs(statement.capitalizedOwnWorkMemo) > 1 &&
          statement.netProfitStatutory != null && (
            <PLReconciliationBridge
              operational={statement.netProfit}
              capitalizedOwnWork={statement.capitalizedOwnWorkMemo}
              statutory={statement.netProfitStatutory}
              currency={statement.currency}
            />
          )}
      </div>

      {/* KEY MARGINS */}
      <div className="pl-key-margins">
        <h3>{t("statements.pl.keyMargins")}</h3>
        <ul>
          {statement.keyMargins.map((m, i) => (
            <li key={i}>
              <span>{m.label}:</span>
              <span className="pl-margin-value">{formatPercent(m.value)}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Reconciliation footnote — surfaces 722/231/628 wash */}
      {showFootnote && statement.capitalizedOwnWorkMemo && statement.capitalizedOwnWorkMemo > 0 && (
        <PLFootnote statement={statement} />
      )}
    </div>
  );
}

function PLSectionView({ section, currency }: { section: PLSection; currency: string }) {
  if (section.lines.length === 0 && !section.subtotalLabel) return null;
  const fmt = useAmountFormatter(currency);
  const subtotalAttrs = section.subtotalBucket
    ? { [TRACEABLE_TARGET_ATTR]: section.subtotalBucket }
    : {};
  const subtotalConceptKey = bucketToConcept(section.subtotalBucket);
  return (
    <div className="pl-section">
      {section.header && <div className="pl-section-header">{section.header}</div>}

      {section.lines.map((line, i) => (
        <PLLineView key={`${line.accountCode ?? "x"}-${i}`} line={line} currency={currency} />
      ))}

      {section.subtotalLabel && (
        <>
          <div className="pl-subtotal-rule" />
          <div className="pl-row pl-subtotal" {...subtotalAttrs}>
            <span className="pl-code" />
            <span className="pl-label">{section.subtotalLabel}</span>
            {subtotalConceptKey ? (
              <LearnableNumber
                conceptKey={subtotalConceptKey}
                value={section.subtotalAmount ?? 0}
                className="pl-amount"
                block
              >
                {fmt(section.subtotalAmount)}
              </LearnableNumber>
            ) : (
              <span className="pl-amount">{fmt(section.subtotalAmount)}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function PLLineView({ line, currency }: { line: PLLine; currency: string }) {
  const fmt = useAmountFormatter(currency);
  const lineAttrs = line.bucket ? { [TRACEABLE_TARGET_ATTR]: line.bucket } : {};
  const conceptKey = bucketToConcept(line.bucket);

  if (line.style === "subtotal" && !line.accountCode) {
    return (
      <div className="pl-row pl-subtotal" {...lineAttrs}>
        <span className="pl-code" />
        <span className="pl-label">{line.label}</span>
        {conceptKey ? (
          <LearnableNumber
            conceptKey={conceptKey}
            value={line.amount ?? 0}
            className="pl-amount"
            block
          >
            {fmt(line.amount)}
          </LearnableNumber>
        ) : (
          <span className="pl-amount">{fmt(line.amount)}</span>
        )}
      </div>
    );
  }

  const amount = line.sign ? fmt(line.amount ?? 0, { sign: line.sign }) : fmt(line.amount);
  const amountClass =
    line.sign === "negative" ? "pl-neg" : line.sign === "positive" ? "pl-pos" : "";

  return (
    <div className={`pl-row pl-row-item ${line.style}`} {...lineAttrs}>
      <span className="pl-code">{line.accountCode ?? ""}</span>
      <span className="pl-label">{line.label}</span>
      {conceptKey ? (
        <LearnableNumber
          conceptKey={conceptKey}
          value={line.amount ?? 0}
          className={`pl-amount ${amountClass}`}
          block
        >
          {amount}
        </LearnableNumber>
      ) : (
        <span className={`pl-amount ${amountClass}`}>{amount}</span>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// 722 reconciliation bridge — operational → +722 → statutory ct-121
// ────────────────────────────────────────────────────────────────────────
//
// Rendered below the operational net-profit headline subtotal. The
// operational figure (already shown above as the closingSection
// subtotal) is the SINGLE headline net-profit value across the entire
// dashboard. The bridge here exists so a board reader can audit the
// gap to statutory ct-121 — the legally filed number — without that
// figure ever appearing as a competing headline.
//
// NO COMPUTATION HAPPENS HERE. `operational`, `capitalizedOwnWork`,
// and `statutory` are all values the engine has already emitted via
// buildPLStatement; this component only displays them in the bridge
// layout the user requested.

function PLReconciliationBridge({
  operational,
  capitalizedOwnWork,
  statutory,
  currency,
}: {
  operational: number;
  capitalizedOwnWork: number;
  statutory: number;
  currency: string;
}) {
  const { t } = useTranslation();
  const fmt = useAmountFormatter(currency);
  const display = useDisplayCurrency();
  return (
    <div className="pl-recon-bridge" data-testid="pl-recon-bridge" role="group" aria-label="Net profit reconciliation">
      <div className="pl-recon-head">
        {t("statements.pl.recon.heading")}
      </div>
      <div className="pl-row pl-row-item pl-recon-line">
        <span className="pl-code">722</span>
        <span className="pl-label">{t("statements.pl.recon.capitalizedOwnWork")}</span>
        <span className="pl-amount">{fmt(capitalizedOwnWork)}</span>
      </div>
      <div className="pl-row pl-recon-total">
        <span className="pl-code" />
        <span className="pl-label">{t("statements.pl.recon.statutoryTotal")}</span>
        <LearnableNumber conceptKey="net_profit" value={statutory} className="pl-amount" block>
          {fmt(statutory)}
        </LearnableNumber>
      </div>
      <div className="pl-recon-note">
        Operational net profit ({fmt(operational)} {display}) is the headline figure across this report.
        Account 722 is a non-cash credit that capitalizes internally-incurred costs into CIP (account 231);
        the offsetting cost sits inside account 628 (third-party services). Net P&amp;L effect of the 722/628
        wash is ~zero; statutory ct&nbsp;121 is shown above as the reconciled total — not as a competing
        headline.
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Reconciliation footnote — the capitalized own-work / 231 / 628 wash.
// ────────────────────────────────────────────────────────────────────────

function PLFootnote({ statement }: { statement: PLStatement }) {
  const fmt = useAmountFormatter(statement.currency);
  const display = useDisplayCurrency();
  const ownWork = statement.capitalizedOwnWorkMemo ?? 0;
  const ext628 = statement.extServOther ?? 0;
  // 2026-07-25 — everything below is derived from the UPLOADED statement, not
  // asserted. Previously this footnote hardcoded a rental/property-management
  // narrative ("revenue is essentially just rental income (706)…") that fired
  // for ANY company with 722 activity — a manufacturer with capitalized own
  // work read as a landlord. Now: the 722/628-wash math is company-generic
  // (clean revenue = revenue − 722), and the rental framing renders only when
  // rental income (706 + 767) genuinely dominates the ex-own-work revenue.
  const revenueTotal = statement.sections[0]?.subtotalAmount ?? 0;
  const revenueExOwnWork = revenueTotal - ownWork;
  const rentalOnly =
    (statement.sections[0]?.lines.find((l) => l.accountCode === "706")?.amount ?? 0) +
    (statement.sections[0]?.lines.find((l) => l.accountCode === "767")?.amount ?? 0);
  const rentalDominated =
    revenueExOwnWork > 0 && rentalOnly / revenueExOwnWork >= 0.6;
  const opexExcl628 = (statement.sections[1]?.subtotalAmount ?? 0) - ext628;
  return (
    <div className="pl-footnote" data-testid="pl-footnote">
      <p>
        <strong>
          {rentalDominated
            ? "Two things worth flagging given the structure:"
            : "Worth flagging given the structure:"}
        </strong>
      </p>
      <ol>
        <li>
          <strong>
            Account 722 (Capitalized own work) — {fmt(ownWork)} {display} is not external
            revenue.
          </strong>{" "}
          It is the credit-side offset that capitalizes internally-incurred construction costs
          into CIP (account 231 — YTD movement matches 722 exactly). The corresponding cost is
          sitting inside <strong>628 Other third-party services ({fmt(ext628)})</strong>.
          Net P&amp;L effect: ~zero. For a "clean" operating view, strip both: revenue drops to
          ~{fmt(revenueExOwnWork)}, opex drops to ~{fmt(opexExcl628)}, clean EBITDA ≈{" "}
          {fmt(revenueExOwnWork - opexExcl628)}.
        </li>
        {rentalDominated && (
          <li>
            <strong>
              Real cash-generative operating revenue is essentially just rental income (706):{" "}
              {fmt(rentalOnly)} {display}.
            </strong>{" "}
            Against that base, the underlying property-management EBITDA is the more meaningful
            number.
          </li>
        )}
      </ol>
    </div>
  );
}
