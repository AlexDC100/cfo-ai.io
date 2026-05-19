// Reference-format P&L renderer.
//
// Produces the visible P&L for the financial-statements tab. Layout matches
// the spec the user provided exactly: account codes in the left column,
// labels in the middle, amounts right-aligned with tabular-nums, EBITDA
// boxed with double borders, financial items with explicit ± signs, key
// margins + reconciliation footnote below.
//
// All visual conventions live in the .pl-* classes — see plStatementView.css.

import type { PLStatement, PLSection, PLLine } from "@/lib/plStructure";
import { formatRON, formatRONSigned, formatPercent } from "@/lib/formatRon";
import { TRACEABLE_TARGET_ATTR } from "@/lib/traceableSource";
import { useHighlightFromUrl } from "./useHighlightFromUrl";
import "./plStatementView.css";

interface Props {
  statement: PLStatement;
  /** Show the reconciliation footnote (capitalized own-work + 628 explanation). */
  showFootnote?: boolean;
}

export function PLStatementView({ statement, showFootnote = true }: Props) {
  // Phase A foundation: when a TraceableNumber elsewhere routes here
  // with `?highlight=<bucket>` the hook scrolls the matching row into
  // view and pulses it. Matching rows carry `data-traceable-target=`
  // — see PLSection.subtotalBucket and PLLine.bucket plus the boxed
  // EBITDA row below (hardcoded "ebitda").
  useHighlightFromUrl();

  const [operatingRevenue, operatingExpenses, depreciationSection, financialItems, closingSection] =
    statement.sections;

  return (
    <div className="pl-statement" data-testid="pl-statement">
      <div className="pl-header">
        <h2>
          P&amp;L — {statement.entity} — {statement.period} ({statement.currency})
        </h2>
      </div>

      <div className="pl-body">
        {/* OPERATING REVENUE */}
        <PLSectionView section={operatingRevenue} />

        {/* OPERATING EXPENSES */}
        <PLSectionView section={operatingExpenses} />

        {/* EBITDA — boxed off with double borders. Hardcoded bucket so
         *  Valuation page / ratios linking to `ebitda` land here. */}
        <div className="pl-ebitda-box" {...{ [TRACEABLE_TARGET_ATTR]: "ebitda" }}>
          <div className="pl-row pl-total">
            <span className="pl-code" />
            <span className="pl-label">EBITDA</span>
            <span className="pl-amount">{formatRON(statement.ebitda)}</span>
          </div>
        </div>

        {/* D&A → EBIT */}
        <PLSectionView section={depreciationSection} />

        {/* FINANCIAL ITEMS */}
        <PLSectionView section={financialItems} />

        {/* PBT → NET PROFIT (operational headline) */}
        <PLSectionView section={closingSection} />

        {/* 722 reconciliation bridge — operational → +722 → statutory ct-121.
         *  Operational stays the visual headline (above); statutory is the
         *  reconciled total here, deliberately subordinated. Only shown when
         *  capitalized own-work is materially non-zero. No new computation:
         *  both values come from the engine via buildPLStatement. */}
        {statement.capitalizedOwnWorkMemo != null &&
          Math.abs(statement.capitalizedOwnWorkMemo) > 1 &&
          statement.netProfitStatutory != null && (
            <PLReconciliationBridge
              operational={statement.netProfit}
              capitalizedOwnWork={statement.capitalizedOwnWorkMemo}
              statutory={statement.netProfitStatutory}
            />
          )}
      </div>

      {/* KEY MARGINS */}
      <div className="pl-key-margins">
        <h3>Key margins</h3>
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

function PLSectionView({ section }: { section: PLSection }) {
  if (section.lines.length === 0 && !section.subtotalLabel) return null;
  // Subtotal-row traceability: when section declares a subtotalBucket
  // (e.g. "revenue", "ebit", "netIncomeOperational"), emit the data
  // attribute so cross-page TraceableNumber clicks can land here.
  const subtotalAttrs = section.subtotalBucket
    ? { [TRACEABLE_TARGET_ATTR]: section.subtotalBucket }
    : {};
  return (
    <div className="pl-section">
      {section.header && <div className="pl-section-header">{section.header}</div>}

      {section.lines.map((line, i) => (
        <PLLineView key={`${line.accountCode ?? "x"}-${i}`} line={line} />
      ))}

      {section.subtotalLabel && (
        <>
          <div className="pl-subtotal-rule" />
          <div className="pl-row pl-subtotal" {...subtotalAttrs}>
            <span className="pl-code" />
            <span className="pl-label">{section.subtotalLabel}</span>
            <span className="pl-amount">{formatRON(section.subtotalAmount)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function PLLineView({ line }: { line: PLLine }) {
  // Line-level traceability: bucket-tagged lines become scroll-targets
  // for incoming `?highlight=<bucket>` URLs. Untagged lines render
  // exactly as before — zero visual regression.
  const lineAttrs = line.bucket ? { [TRACEABLE_TARGET_ATTR]: line.bucket } : {};

  if (line.style === "subtotal" && !line.accountCode) {
    return (
      <div className="pl-row pl-subtotal" {...lineAttrs}>
        <span className="pl-code" />
        <span className="pl-label">{line.label}</span>
        <span className="pl-amount">{formatRON(line.amount)}</span>
      </div>
    );
  }

  const amount = line.sign
    ? formatRONSigned(line.amount ?? 0, line.sign)
    : formatRON(line.amount);
  const amountClass =
    line.sign === "negative" ? "pl-neg" : line.sign === "positive" ? "pl-pos" : "";

  return (
    <div className={`pl-row pl-row-item ${line.style}`} {...lineAttrs}>
      <span className="pl-code">{line.accountCode ?? ""}</span>
      <span className="pl-label">{line.label}</span>
      <span className={`pl-amount ${amountClass}`}>{amount}</span>
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
}: {
  operational: number;
  capitalizedOwnWork: number;
  statutory: number;
}) {
  return (
    <div className="pl-recon-bridge" data-testid="pl-recon-bridge" role="group" aria-label="Net profit reconciliation">
      <div className="pl-recon-head">
        Reconciliation to statutory ct&nbsp;121
      </div>
      <div className="pl-row pl-row-item pl-recon-line">
        <span className="pl-code">722</span>
        <span className="pl-label">+ Capitalized own work</span>
        <span className="pl-amount">{formatRON(capitalizedOwnWork)}</span>
      </div>
      <div className="pl-row pl-recon-total">
        <span className="pl-code" />
        <span className="pl-label">= Net profit — statutory (ct&nbsp;121)</span>
        <span className="pl-amount">{formatRON(statutory)}</span>
      </div>
      <div className="pl-recon-note">
        Operational net profit ({formatRON(operational)} RON) is the headline figure across this report.
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
  const ownWork = statement.capitalizedOwnWorkMemo ?? 0;
  const ext628 = statement.extServOther ?? 0;
  // Rental + discounts gives "real cash-generative" revenue baseline
  const rentalOnly =
    (statement.sections[0]?.lines.find((l) => l.accountCode === "706")?.amount ?? 0) +
    (statement.sections[0]?.lines.find((l) => l.accountCode === "767")?.amount ?? 0);
  const opexExcl628 = (statement.sections[1]?.subtotalAmount ?? 0) - ext628;
  return (
    <div className="pl-footnote" data-testid="pl-footnote">
      <p>
        <strong>Two things worth flagging given the structure:</strong>
      </p>
      <ol>
        <li>
          <strong>
            Account 722 (Capitalized own work) — {formatRON(ownWork)} RON is not external
            revenue.
          </strong>{" "}
          It is the credit-side offset that capitalizes internally-incurred construction costs
          into CIP (account 231 — YTD movement matches 722 exactly). The corresponding cost is
          sitting inside <strong>628 Other third-party services ({formatRON(ext628)})</strong>.
          Net P&amp;L effect: ~zero. For a "clean" operating view, strip both: revenue drops to
          ~{formatRON(rentalOnly)}, opex drops to ~{formatRON(opexExcl628)}, clean EBITDA ≈{" "}
          {formatRON(rentalOnly - opexExcl628)}.
        </li>
        <li>
          <strong>
            Real cash-generative operating revenue is essentially just rental income (706):{" "}
            {formatRON(rentalOnly)} RON.
          </strong>{" "}
          Against that base, the underlying property-management EBITDA is the more meaningful
          number.
        </li>
      </ol>
    </div>
  );
}
