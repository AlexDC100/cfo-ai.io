// Reference-format P&L renderer.
//
// Produces the visible P&L for the financial-statements tab. Layout matches
// the spec the user provided exactly: account codes in the left column,
// labels in the middle, amounts right-aligned with tabular-nums, EBITDA
// boxed with double borders, financial items with explicit ± signs, key
// margins + reconciliation footnote below.
//
// All visual conventions live in the .pl-* classes — see plStatementView.css.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PLStatement, PLSection, PLSectionRole, PLLine } from "@/lib/plStructure";
import { formatPercent } from "@/lib/formatRon";
import { useAmountFormatter, useDisplayCurrency } from "@/stores/currency";
// THE DIAL — Simple mode opens statements totals-first: item rows hide
// behind "Show all lines", labels with a glossary match get the <Term>
// plain-language affordance. Pro renders exactly what exists today
// (every branch below is gated on useIsSimple; values never change).
import { useIsSimple } from "@/lib/viewMode";
import { Term } from "@/components/instrument/Term";
import { ShowAllLinesToggle } from "@/components/cfo/simple/ShowAllLines";
import { SimpleTermLabel } from "@/components/cfo/simple/SimpleTermLabel";
import { termForRow } from "@/components/cfo/simple/termForRow";
import { TRACEABLE_TARGET_ATTR } from "@/lib/traceableSource";
import { useHighlightFromUrl } from "./useHighlightFromUrl";
import {
  CmpCells,
  CmpColumnHeader,
  activeColumnCount,
  cmpColumnTemplate,
  useComparativeContext,
} from "./ComparativeCells";
import { sourceDocumentLine } from "@/lib/comparatives";
import { LearnableNumber } from "@/components/learning/LearnableNumber";
import { bucketToConcept } from "@/lib/learning/bucketToConcept";
import { GuideMeButton } from "@/components/learning/GuideMeButton";
import { PL_GUIDE } from "@/components/learning/pageGuides";
import { AccountChip, splitAccountParen, StatementCurrencyChip } from "./AccountChip";
import "./plStatementView.css";

/**
 * THE REFERENCE LAYOUT'S SECTIONS, BY ROLE.
 *
 * Both RO builders insert an OTHER OPERATING INCOME section (account 758)
 * after operating revenue whenever the book carries one — most books. This
 * view used to read the sections by INDEX, `[revenue, opex, d&a,
 * financial, closing]`, so on such a book the 758 section took the
 * operating-expenses slot, the EBITDA box landed between it and the
 * operating expenses, and the sixth section — profit before tax, income
 * tax, net profit — was never rendered at all. Sections that name their
 * `role` are now placed by it. A statement that names none keeps the old
 * positional reading, unchanged: that is the public-company adapter, whose
 * SIX sections (revenue, cost of revenue, operating expenses, EBIT,
 * financial items, net profit) this reading mis-places the same way — its
 * NET PROFIT section is not rendered either. That page is a separate fix:
 * its operating expenses include D&A, so the EBITDA box has no place in
 * its structure that this layout could choose for it.
 */
function plLayout(sections: readonly PLSection[]): {
  operatingRevenue?: PLSection;
  otherOperatingIncome?: PLSection;
  operatingExpenses?: PLSection;
  depreciationSection?: PLSection;
  financialItems?: PLSection;
  closingSection?: PLSection;
} {
  if (sections.some((s) => s.role)) {
    const by = (role: PLSectionRole) => sections.find((s) => s.role === role);
    return {
      operatingRevenue: by("operatingRevenue"),
      otherOperatingIncome: by("otherOperatingIncome"),
      operatingExpenses: by("operatingExpenses"),
      depreciationSection: by("depreciation"),
      financialItems: by("financialItems"),
      closingSection: by("closing"),
    };
  }
  const [operatingRevenue, operatingExpenses, depreciationSection, financialItems, closingSection] = sections;
  return { operatingRevenue, operatingExpenses, depreciationSection, financialItems, closingSection };
}

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
  const { t, i18n } = useTranslation();
  const fmt = useAmountFormatter(statement.currency);
  const display = useDisplayCurrency();
  // COMPARATIVES — present only when the dashboard wrapped this view in a
  // <ComparativeProvider> with an engine document. The grid widens by the
  // columns the reader switched on; every cell is painted by <CmpCells>,
  // which refuses any row whose figure is not the engine's own line.
  const cmp = useComparativeContext();
  const cmpCount = cmp ? activeColumnCount(cmp.columns) : 0;
  const cmpStyle = cmp && cmpCount > 0
    ? ({ "--cmp-cols": cmpColumnTemplate(cmp.columns) } as React.CSSProperties)
    : undefined;
  // THE DIAL — Simple opens totals-first; "Show all lines" expands to the
  // untouched full table. keyOnly hides only `style: "item"` rows —
  // subtotal/total/boxed rows (the builder-marked headline rows) always
  // render, so every figure that remains is one the builder computed.
  const isSimple = useIsSimple();
  const [showAll, setShowAll] = useState(false);
  const keyOnly = isSimple && !showAll;

  const {
    operatingRevenue,
    otherOperatingIncome,
    operatingExpenses,
    depreciationSection,
    financialItems,
    closingSection,
  } = plLayout(statement.sections);

  return (
    <div
      className={`pl-statement${cmpCount > 0 ? " pl-cmp" : ""}`}
      data-testid="pl-statement"
      data-comparative={cmp ? cmp.doc.prior.period_id : undefined}
      style={cmpStyle}
    >
      <div className="pl-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h2>
            {t("statements.pl.title")} — {statement.entity} — {statement.period} ({display})
          </h2>
          <StatementCurrencyChip currency={statement.currency} />
        </div>
        {!hideGuide && <GuideMeButton pageId="pnl" title="P&L" steps={PL_GUIDE} />}
      </div>

      {/* THE DIAL — Simple-only disclosure toggle. Pro never renders it. */}
      {isSimple && (
        <ShowAllLinesToggle
          open={showAll}
          onToggle={() => setShowAll((v) => !v)}
          testid="pl-show-all"
        />
      )}

      {cmp && cmpCount > 0 && (
        <CmpColumnHeader
          currentLabel={cmp.doc.current.label}
          priorLabel={cmp.doc.prior.label}
          currentTitle={sourceDocumentLine(cmp.doc.current)}
          priorTitle={sourceDocumentLine(cmp.doc.prior)}
          shareLabel={t("statements.cmp.colShare")}
          columns={cmp.columns}
        />
      )}
      <div className="pl-body">
        {/* OPERATING REVENUE */}
        <div data-guide="pl-revenue">
          {operatingRevenue && (
            <PLSectionView section={operatingRevenue} currency={statement.currency} keyOnly={keyOnly} />
          )}
        </div>

        {/* OTHER OPERATING INCOME (758) — present only when the book carries it */}
        {otherOperatingIncome && (
          <PLSectionView section={otherOperatingIncome} currency={statement.currency} keyOnly={keyOnly} />
        )}

        {/* OPERATING EXPENSES */}
        {operatingExpenses && (
          <PLSectionView section={operatingExpenses} currency={statement.currency} keyOnly={keyOnly} />
        )}

        {/* EBITDA — boxed off with double borders. */}
        <div
          className="pl-ebitda-box"
          data-guide="pl-ebitda"
          {...{ [TRACEABLE_TARGET_ATTR]: "ebitda" }}
        >
          <div className="pl-row pl-total">
            <span className="pl-label">
              <SimpleTermLabel termId="ebitda">{t("statements.pl.ebitda")}</SimpleTermLabel>
            </span>
            <LearnableNumber conceptKey="ebitda" value={statement.ebitda} className="pl-amount" block>
              {fmt(statement.ebitda)}
            </LearnableNumber>
            <CmpCells rowKey="ebitda" amount={statement.ebitda} />
          </div>
        </div>

        {/* D&A → EBIT */}
        {depreciationSection && (
          <PLSectionView section={depreciationSection} currency={statement.currency} keyOnly={keyOnly} />
        )}

        {/* FINANCIAL ITEMS */}
        {financialItems && (
          <PLSectionView section={financialItems} currency={statement.currency} keyOnly={keyOnly} />
        )}

        {/* PBT → NET PROFIT (operational headline) */}
        <div data-guide="pl-net-profit">
          {closingSection && (
            <PLSectionView section={closingSection} currency={statement.currency} keyOnly={keyOnly} />
          )}
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
              {m.refusal ? (
                // The engine's refusal (engine.ratios.margin_meaning), in the
                // reader's language: a margin over a negligible turnover is
                // stated as not meaningful, never printed as a percent.
                <span className="pl-margin-value" data-testid="pl-margin-refused">
                  {i18n.language?.startsWith("ro") ? m.refusal.ro : m.refusal.en}
                </span>
              ) : (
                <span className="pl-margin-value">{formatPercent(m.value)}</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* Reconciliation footnote — surfaces 722/231/628 wash */}
      {/* `!!` — a capitalizedOwnWorkMemo of exactly 0 used to short-circuit
          this chain with the NUMBER 0, which React paints as a stray "0"
          under the key margins (visible on any book with no 722). */}
      {showFootnote && !!statement.capitalizedOwnWorkMemo && statement.capitalizedOwnWorkMemo > 0 && (
        <PLFootnote statement={statement} />
      )}
    </div>
  );
}

function PLSectionView({
  section,
  currency,
  keyOnly = false,
}: {
  section: PLSection;
  currency: string;
  /** THE DIAL — Simple collapsed state: render only builder-marked
   *  headline rows (subtotal/total/boxed); `item` lines hide. */
  keyOnly?: boolean;
}) {
  // Hook BEFORE the empty-section bail-out — see the same note in
  // BSStatementView. A section that loses its lines between renders must not
  // change this component's hook count.
  const fmt = useAmountFormatter(currency);
  if (section.lines.length === 0 && !section.subtotalLabel) return null;
  const visibleLines = keyOnly
    ? section.lines.filter((l) => l.style !== "item")
    : section.lines;
  if (keyOnly && visibleLines.length === 0 && !section.subtotalLabel) return null;
  const subtotalAttrs = section.subtotalBucket
    ? { [TRACEABLE_TARGET_ATTR]: section.subtotalBucket }
    : {};
  const subtotalConceptKey = bucketToConcept(section.subtotalBucket);
  return (
    <div className="pl-section">
      {section.header && <div className="pl-section-header">{section.header}</div>}

      {visibleLines.map((line, i) => (
        <PLLineView key={`${line.accountCode ?? "x"}-${i}`} line={line} currency={currency} />
      ))}

      {section.subtotalLabel && (
        <>
          <div className="pl-subtotal-rule" />
          <div className="pl-row pl-subtotal" {...subtotalAttrs}>
            <span className="pl-label">
              <SimpleTermLabel termId={termForRow(section.subtotalBucket)}>
                {section.subtotalLabel}
              </SimpleTermLabel>
            </span>
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
            <CmpCells rowKey={section.subtotalBucket} amount={section.subtotalAmount} folds={section.subtotalFolds} />
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
        <span className="pl-label">
          <SimpleTermLabel termId={termForRow(line.bucket)}>{line.label}</SimpleTermLabel>
        </span>
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
        <CmpCells rowKey={line.bucket} amount={line.amount} />
      </div>
    );
  }

  // Two vocabularies that never quite met: `LineSign` has three members
  // ("positive" | "negative" | "neutral") while the money formatter's
  // `sign` option has two. Passing "neutral" fell through the formatter's
  // sign branches to "render with the value's own sign" — which IS what
  // neutral means, so nothing was visibly wrong, but the mismatch was
  // load-bearing by accident: it was the formatter's DEFAULT that saved
  // it, not any decision here. Making the mapping explicit keeps the
  // rendered string byte-identical and stops a future fourth member (or a
  // reordered branch in `formatAmountFrom`) from changing a money sign
  // silently.
  const explicitSign =
    line.sign === "positive" || line.sign === "negative" ? line.sign : undefined;
  const amount = explicitSign
    ? fmt(line.amount ?? 0, { sign: explicitSign })
    : fmt(line.amount);
  const amountClass =
    line.sign === "negative" ? "pl-neg" : line.sign === "positive" ? "pl-pos" : "";

  // Account code renders AFTER the label as a muted chip. When the builder
  // baked a pure code list into the label text ("… (601/602/607)"), peel it
  // into the chip; prose parentheses stay in the label. When the label IS
  // the bare code (unlabeled accounts in synthetic files), skip the chip —
  // "607 [607]" reads as a bug.
  const split = line.accountCode ? null : splitAccountParen(line.label);
  const labelText = split?.code ? split.text : line.label;
  const rawChip = line.accountCode ?? split?.code;
  const chipCode = rawChip && rawChip !== labelText.trim() ? rawChip : undefined;

  return (
    <div className={`pl-row pl-row-item ${line.style}`} {...lineAttrs}>
      <span className="pl-label">
        <SimpleTermLabel termId={termForRow(line.bucket, line.accountCode)}>
          {labelText}
        </SimpleTermLabel>
        <AccountChip code={chipCode} />
      </span>
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
      <CmpCells rowKey={line.bucket} amount={line.amount} />
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
        <span className="pl-label">
          {t("statements.pl.recon.capitalizedOwnWork")}
          <AccountChip code="722" />
        </span>
        <span className="pl-amount">{fmt(capitalizedOwnWork)}</span>
      </div>
      <div className="pl-row pl-recon-total">
        <span className="pl-label">{t("statements.pl.recon.statutoryTotal")}</span>
        <LearnableNumber conceptKey="net_profit" value={statutory} className="pl-amount" block>
          {fmt(statutory)}
        </LearnableNumber>
        <CmpCells rowKey="netIncomeStatutory" amount={statutory} />
      </div>
      <div className="pl-recon-note">
        {t("tablesV2.pl.reconNote", {
          defaultValue:
            "Operational net profit ({{amount}} {{currency}}) is the headline figure across this report. Account 722 is a non-cash credit that capitalizes internally-incurred costs into CIP (account 231); the offsetting cost sits inside account 628 (third-party services). Net P&L effect of the 722/628 wash is ~zero; statutory ct 121 is shown above as the reconciled total — not as a competing headline.",
          amount: fmt(operational),
          currency: display,
        })}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Reconciliation footnote — the capitalized own-work / 231 / 628 wash.
// ────────────────────────────────────────────────────────────────────────

function PLFootnote({ statement }: { statement: PLStatement }) {
  const { t } = useTranslation();
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
  // THE 706 FAMILY IS READ OFF THE BOOK'S OWN REVENUE FAMILIES
  // (`revenueFamilyAmounts`: the leaves, "7061" and "706.01" folded into
  // "706"), never off a line whose `accountCode` happens to equal "706".
  // On the aggregates path that code is the row's CHIP — a label listing
  // the families the book holds — so `=== "706"` read a landlord's chip
  // as its rent and a goods seller's "701/704/706/707/709" as none; on a
  // sub-account ledger it matched nothing at all. The line lookup stays
  // only for a statement built without leaves to read.
  const families = statement.revenueFamilyAmounts;
  const rental706 = families
    ? (families["706"] ?? 0)
    : (statement.sections[0]?.lines.find((l) => l.accountCode === "706")?.amount ?? 0);
  const rentalOnly =
    rental706 +
    (statement.sections[0]?.lines.find((l) => l.accountCode === "767")?.amount ?? 0);
  const rentalDominated =
    revenueExOwnWork > 0 && rentalOnly / revenueExOwnWork >= 0.6;
  // The OPERATING EXPENSES section, by role — `sections[1]` is the 758
  // section on a book that carries one (see `plLayout`).
  const opexExcl628 = (plLayout(statement.sections).operatingExpenses?.subtotalAmount ?? 0) - ext628;
  return (
    <div className="pl-footnote" data-testid="pl-footnote">
      <p>
        <strong>
          {rentalDominated
            ? t("statements.pl.footnote.flag", "Two things worth flagging given the structure:")
            : t("tablesV2.pl.footnote.flagOne", "Worth flagging given the structure:")}
        </strong>
      </p>
      <ol>
        <li>
          <strong>
            {t("tablesV2.pl.footnote.ownWorkTitle", {
              defaultValue:
                "Account 722 (Capitalized own work) — {{amount}} {{currency}} is not external revenue.",
              amount: fmt(ownWork),
              currency: display,
            })}
          </strong>{" "}
          {t("tablesV2.pl.footnote.ownWorkBody", {
            defaultValue:
              "It is the credit-side offset that capitalizes internally-incurred construction costs into CIP (account 231 — YTD movement matches 722 exactly). The corresponding cost is sitting inside 628 Other third-party services ({{ext}}). Net P&L effect: ~zero. For a \"clean\" operating view, strip both: revenue drops to ~{{revenue}}, opex drops to ~{{opex}}, clean EBITDA ≈ {{ebitda}}.",
            ext: fmt(ext628),
            revenue: fmt(revenueExOwnWork),
            opex: fmt(opexExcl628),
            ebitda: fmt(revenueExOwnWork - opexExcl628),
          })}
        </li>
        {rentalDominated && (
          <li>
            <strong>
              {t("tablesV2.pl.footnote.rentalTitle", {
                defaultValue:
                  "Real cash-generative operating revenue is essentially just rental income (706): {{amount}} {{currency}}.",
                amount: fmt(rentalOnly),
                currency: display,
              })}
            </strong>{" "}
            {t("tablesV2.pl.footnote.rentalBody", "Against that base, the underlying property-management EBITDA is the more meaningful number.")}
          </li>
        )}
      </ol>
    </div>
  );
}
