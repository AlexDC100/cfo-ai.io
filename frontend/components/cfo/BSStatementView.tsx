// Reference-format Balance Sheet renderer.
//
// Layout (4-column grid):
//   [label + account code] [opening 01.01] [closing 31.12] [Δ delta]
//
// Same visual language as PLStatementView: monospace + tabular-nums for
// digit alignment, uppercase tracked section headers, double-line borders
// around TOTAL ASSETS and TOTAL EQUITY & LIABILITIES, contra-asset rows
// (accumulated depreciation) in parens.

import { useTranslation } from "react-i18next";
import type { BSStatement, BSSection, BSLine } from "@/lib/bsStructure";
import { useAmountFormatter, useDisplayCurrency } from "@/stores/currency";
import { TRACEABLE_TARGET_ATTR } from "@/lib/traceableSource";
import { useHighlightFromUrl } from "./useHighlightFromUrl";
import { LearnableNumber } from "@/components/learning/LearnableNumber";
import { LearnableRowLabel } from "@/components/learning/LearnableRowLabel";
import { bucketToConcept } from "@/lib/learning/bucketToConcept";
import { GuideMeButton } from "@/components/learning/GuideMeButton";
import { BalanceSheetMap } from "@/components/learning/BalanceSheetMap";
import { BALANCE_SHEET_GUIDE } from "@/components/learning/balanceSheetGuide";
import { AccountChip, splitAccountParen, StatementCurrencyChip } from "./AccountChip";
import "./bsStatementView.css";

interface Props {
  statement: BSStatement;
  /** Hide the inline "Guide me" button (dashboard consolidates guides). */
  hideGuide?: boolean;
}

export function BSStatementView({ statement, hideGuide = false }: Props) {
  useHighlightFromUrl();
  const { t } = useTranslation();
  // 2026-05-24 — currency-aware formatting. `fmt(value)` converts the
  // value from statement.currency to the user's current display currency
  // and formats in the appropriate locale (no symbol — header chip
  // already shows it). `display` is the active display currency code
  // for the header.
  const fmt = useAmountFormatter(statement.currency);
  const display = useDisplayCurrency();

  return (
    <div className={statement.note ? "lg:grid lg:grid-cols-[minmax(0,820px)_minmax(340px,440px)] lg:gap-5 lg:items-start lg:justify-center" : ""}>
      <div className="bs-statement" data-testid="bs-statement">
      <div className="bs-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>{t("statements.bs.title")} — {statement.entity} ({display})</span>
          <StatementCurrencyChip currency={statement.currency} />
        </span>
        {!hideGuide && (
          <GuideMeButton
            pageId="balance-sheet"
            title="Balance Sheet"
            steps={BALANCE_SHEET_GUIDE}
          />
        )}
      </div>

      {/* F5.0 Wave 3 — Balance Sheet Map: compact learning rail above the table. */}
      <BalanceSheetMap />

      {/* Column header row */}
      <div className="bs-col-header">
        <span />
        <span>{statement.comparativeDate}</span>
        <span>{statement.asOf}</span>
        <span>Δ</span>
      </div>

      {/* ASSETS */}
      <div className="bs-section-title" data-guide="bs-assets">{t("statements.bs.assets")}</div>
      {statement.assetSections.map((section, i) => (
        <BSSectionView key={`a-${i}`} section={section} currency={statement.currency} />
      ))}
      <div
        className="bs-total-row"
        data-guide="bs-total-assets"
        data-learnable-row="true"
        {...{ [TRACEABLE_TARGET_ATTR]: "totalAssets" }}
      >
        <span className="bs-total-label">
          <LearnableRowLabel
            conceptKey="total_assets"
            value={statement.totalAssets.closing}
            data-testid="bs-total-assets-label"
          >
            {t("statements.bs.totalAssets")}
          </LearnableRowLabel>
        </span>
        <LearnableNumber conceptKey="total_assets" value={statement.totalAssets.opening} className="bs-amount" block>
          {fmt(statement.totalAssets.opening)}
        </LearnableNumber>
        <LearnableNumber conceptKey="total_assets" value={statement.totalAssets.closing} className="bs-amount" block>
          {fmt(statement.totalAssets.closing)}
        </LearnableNumber>
        <span className="bs-delta">{formatDelta(statement.totalAssets.delta, fmt)}</span>
      </div>

      {/* EQUITY & LIABILITIES */}
      <div className="bs-section-title" data-guide="bs-equity">{t("statements.bs.equityLiab")}</div>
      <div data-guide="bs-liabilities" />
      {statement.equityLiabSections.map((section, i) => (
        <BSSectionView key={`el-${i}`} section={section} currency={statement.currency} />
      ))}
      <div
        className="bs-total-row"
        data-learnable-row="true"
        {...{ [TRACEABLE_TARGET_ATTR]: "totalLiabilitiesAndEquity" }}
      >
        <span className="bs-total-label">
          <LearnableRowLabel
            conceptKey="total_equity_liab"
            value={statement.totalEquityLiab.closing}
            data-testid="bs-total-equity-liab-label"
          >
            {t("statements.bs.totalEquityLiab")}
          </LearnableRowLabel>
        </span>
        <LearnableNumber conceptKey="total_equity_liab" value={statement.totalEquityLiab.opening} className="bs-amount" block>
          {fmt(statement.totalEquityLiab.opening)}
        </LearnableNumber>
        <LearnableNumber conceptKey="total_equity_liab" value={statement.totalEquityLiab.closing} className="bs-amount" block>
          {fmt(statement.totalEquityLiab.closing)}
        </LearnableNumber>
        <span className="bs-delta">{formatDelta(statement.totalEquityLiab.delta, fmt)}</span>
      </div>

      {/* Balance check */}
      {Math.abs(statement.balanceCheck) > 1 && (
        <div className="bs-imbalance-warning">
          ⚠ {t("statements.bs.drift")}: {display} {fmt(statement.balanceCheck)}.
        </div>
      )}
      </div>
      {/* Note — moved OUTSIDE the .bs-statement bordered card (2026-07-25), to
          its right (a sibling in the grid). */}
      {statement.note && (
        <aside className="mt-4 lg:mt-0">
          <section className="rounded-2xl border border-rule bg-surface p-4" data-testid="bs-note">
            <p className="text-[12px] text-ink-soft leading-relaxed">
              <strong className="text-ink">{t("statements.bs.note")}.</strong> {statement.note}
            </p>
          </section>
        </aside>
      )}
    </div>
  );
}

function BSSectionView({ section, currency }: { section: BSSection; currency: string }) {
  // Hook BEFORE the empty-section bail-out (2026-07-26): this used to sit
  // under it, so a re-render in which a section lost its lines ran one fewer
  // hook than the previous render and React threw "Rendered fewer hooks than
  // expected" — which is what crashed the dashboard on switching to a period
  // with no trial balance behind it.
  const fmt = useAmountFormatter(currency);
  if (section.lines.length === 0 && !section.subtotalLabel) return null;
  const subtotalAttrs = section.subtotalBucket
    ? { [TRACEABLE_TARGET_ATTR]: section.subtotalBucket }
    : {};
  const subtotalConceptKey = bucketToConcept(section.subtotalBucket);
  return (
    <div className="bs-section">
      {section.header && <div className="bs-section-header">{section.header}</div>}
      {section.lines.map((line, i) => (
        <BSLineView key={i} line={line} currency={currency} />
      ))}
      {section.subtotalLabel && (
        <>
          <div className="bs-subtotal-rule" />
          <div
            className="bs-row bs-subtotal"
            {...subtotalAttrs}
            {...(subtotalConceptKey ? { "data-learnable-row": "true" } : {})}
          >
            <span className="bs-label">
              {subtotalConceptKey ? (
                <LearnableRowLabel
                  conceptKey={subtotalConceptKey}
                  value={section.subtotalClosing ?? 0}
                  data-testid={`bs-subtotal-label-${subtotalConceptKey}`}
                >
                  {section.subtotalLabel}
                </LearnableRowLabel>
              ) : (
                section.subtotalLabel
              )}
            </span>
            {subtotalConceptKey ? (
              <>
                <LearnableNumber
                  conceptKey={subtotalConceptKey}
                  value={section.subtotalOpening ?? 0}
                  className="bs-amount"
                  block
                >
                  {fmt(section.subtotalOpening)}
                </LearnableNumber>
                <LearnableNumber
                  conceptKey={subtotalConceptKey}
                  value={section.subtotalClosing ?? 0}
                  className="bs-amount"
                  block
                >
                  {fmt(section.subtotalClosing)}
                </LearnableNumber>
              </>
            ) : (
              <>
                <span className="bs-amount">{fmt(section.subtotalOpening)}</span>
                <span className="bs-amount">{fmt(section.subtotalClosing)}</span>
              </>
            )}
            <span className="bs-delta">{formatDelta(section.subtotalDelta ?? 0, fmt)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function BSLineView({ line, currency }: { line: BSLine; currency: string }) {
  const fmt = useAmountFormatter(currency);
  const lineAttrs = line.bucket ? { [TRACEABLE_TARGET_ATTR]: line.bucket } : {};
  const conceptKey = bucketToConcept(line.bucket);

  if (line.style === "subtotal") {
    return (
      <>
        <div className="bs-subtotal-rule" />
        <div
          className="bs-row bs-subtotal"
          {...lineAttrs}
          {...(conceptKey ? { "data-learnable-row": "true" } : {})}
        >
          <span className="bs-label">
            {conceptKey ? (
              <LearnableRowLabel
                conceptKey={conceptKey}
                value={line.closing ?? 0}
                data-testid={`bs-subtotal-line-${conceptKey}`}
              >
                {line.label}
              </LearnableRowLabel>
            ) : (
              line.label
            )}
          </span>
          {conceptKey ? (
            <>
              <LearnableNumber
                conceptKey={conceptKey}
                value={line.opening ?? 0}
                className="bs-amount"
                block
              >
                {fmt(line.opening)}
              </LearnableNumber>
              <LearnableNumber
                conceptKey={conceptKey}
                value={line.closing ?? 0}
                className="bs-amount"
                block
              >
                {fmt(line.closing)}
              </LearnableNumber>
            </>
          ) : (
            <>
              <span className="bs-amount">{fmt(line.opening)}</span>
              <span className="bs-amount">{fmt(line.closing)}</span>
            </>
          )}
          <span className="bs-delta">
            {formatDelta((line.closing ?? 0) - (line.opening ?? 0), fmt)}
          </span>
        </div>
      </>
    );
  }

  // Account code renders AFTER the label as a muted chip. Labels that carry
  // a pure code list baked in by the builder are split; prose parens stay.
  // Chip suppressed when it would just repeat the label verbatim.
  const split = line.accountCode ? null : splitAccountParen(line.label);
  const labelText = split?.code ? split.text : line.label;
  const rawChip = line.accountCode ?? split?.code;
  const chipCode = rawChip && rawChip !== labelText.trim() ? rawChip : undefined;

  // Contra-asset rows (accumulated depreciation, etc.) render in parens.
  // Use the formatter's `paren` opt for negatives; for absolute values
  // wrap manually since the source data may carry the negative pre-applied.
  const openingFmt = line.isContra
    ? `(${fmt(Math.abs(line.opening ?? 0))})`
    : fmt(line.opening);
  const closingFmt = line.isContra
    ? `(${fmt(Math.abs(line.closing ?? 0))})`
    : fmt(line.closing);
  const deltaValue = line.delta ?? (line.closing ?? 0) - (line.opening ?? 0);

  return (
    <div
      className={`bs-row bs-row-item ${line.isContra ? "bs-contra" : ""}`}
      {...lineAttrs}
      {...(conceptKey ? { "data-learnable-row": "true" } : {})}
    >
      <span className="bs-label">
        {conceptKey ? (
          <LearnableRowLabel
            conceptKey={conceptKey}
            value={line.closing ?? 0}
            data-testid={`bs-row-label-${conceptKey}`}
          >
            {labelText}
          </LearnableRowLabel>
        ) : (
          labelText
        )}
        <AccountChip code={chipCode} />
      </span>
      {conceptKey ? (
        <>
          <LearnableNumber
            conceptKey={conceptKey}
            value={line.opening ?? 0}
            className="bs-amount"
            block
          >
            {openingFmt}
          </LearnableNumber>
          <LearnableNumber
            conceptKey={conceptKey}
            value={line.closing ?? 0}
            className="bs-amount"
            block
          >
            {closingFmt}
          </LearnableNumber>
        </>
      ) : (
        <>
          <span className="bs-amount">{openingFmt}</span>
          <span className="bs-amount">{closingFmt}</span>
        </>
      )}
      <span className="bs-delta">{formatDelta(deltaValue, fmt)}</span>
    </div>
  );
}

/** Delta column formatter. Δ shows the change in display currency, no
 *  decimals (deltas are coarse-grained). Uses the same fmt() to ensure
 *  the converted value uses the user's display currency. */
function formatDelta(value: number, fmt: (v: number | null | undefined, o?: { signed?: boolean; sign?: "positive" | "negative"; paren?: boolean }) => string): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.5) return "0";
  // Use signed mode to force +/−, the formatter handles currency conversion
  return fmt(value, { sign: value > 0 ? "positive" : "negative" });
}
