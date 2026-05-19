// Reference-format Balance Sheet renderer.
//
// Layout (4-column grid):
//   [label + account code] [opening 01.01] [closing 31.12] [Δ delta]
//
// Same visual language as PLStatementView: monospace + tabular-nums for
// digit alignment, uppercase tracked section headers, double-line borders
// around TOTAL ASSETS and TOTAL EQUITY & LIABILITIES, contra-asset rows
// (accumulated depreciation) in parens.

import type { BSStatement, BSSection, BSLine } from "@/lib/bsStructure";
import { formatRON } from "@/lib/formatRon";
import "./bsStatementView.css";

interface Props {
  statement: BSStatement;
}

export function BSStatementView({ statement }: Props) {
  return (
    <div className="bs-statement" data-testid="bs-statement">
      <div className="bs-header">
        BALANCE SHEET — {statement.entity} ({statement.currency})
      </div>

      {/* Column header row */}
      <div className="bs-col-header">
        <span />
        <span>{statement.comparativeDate}</span>
        <span>{statement.asOf}</span>
        <span>Δ</span>
      </div>

      {/* ASSETS */}
      <div className="bs-section-title">ASSETS</div>
      {statement.assetSections.map((section, i) => (
        <BSSectionView key={`a-${i}`} section={section} />
      ))}
      <div className="bs-total-row">
        <span className="bs-total-label">TOTAL ASSETS</span>
        <span className="bs-amount">{formatRON(statement.totalAssets.opening)}</span>
        <span className="bs-amount">{formatRON(statement.totalAssets.closing)}</span>
        <span className="bs-delta">{formatDelta(statement.totalAssets.delta)}</span>
      </div>

      {/* EQUITY & LIABILITIES */}
      <div className="bs-section-title">EQUITY &amp; LIABILITIES</div>
      {statement.equityLiabSections.map((section, i) => (
        <BSSectionView key={`el-${i}`} section={section} />
      ))}
      <div className="bs-total-row">
        <span className="bs-total-label">TOTAL EQUITY &amp; LIABILITIES</span>
        <span className="bs-amount">{formatRON(statement.totalEquityLiab.opening)}</span>
        <span className="bs-amount">{formatRON(statement.totalEquityLiab.closing)}</span>
        <span className="bs-delta">{formatDelta(statement.totalEquityLiab.delta)}</span>
      </div>

      {/* Balance check */}
      {Math.abs(statement.balanceCheck) > 1 && (
        <div className="bs-imbalance-warning">
          ⚠ Balance sheet drift: RON {formatRON(statement.balanceCheck)} between assets and equity+liabilities.
        </div>
      )}

      {/* Note (dividends declared but not paid, etc.) */}
      {statement.note && (
        <div className="bs-note">
          <strong>Note.</strong> {statement.note}
        </div>
      )}
    </div>
  );
}

function BSSectionView({ section }: { section: BSSection }) {
  if (section.lines.length === 0 && !section.subtotalLabel) return null;
  return (
    <div className="bs-section">
      {section.header && <div className="bs-section-header">{section.header}</div>}
      {section.lines.map((line, i) => (
        <BSLineView key={i} line={line} />
      ))}
      {section.subtotalLabel && (
        <>
          <div className="bs-subtotal-rule" />
          <div className="bs-row bs-subtotal">
            <span className="bs-label">{section.subtotalLabel}</span>
            <span className="bs-amount">{formatRON(section.subtotalOpening)}</span>
            <span className="bs-amount">{formatRON(section.subtotalClosing)}</span>
            <span className="bs-delta">{formatDelta(section.subtotalDelta ?? 0)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function BSLineView({ line }: { line: BSLine }) {
  if (line.style === "subtotal") {
    // Inline mid-section subtotal (e.g. "Net fixed assets")
    return (
      <>
        <div className="bs-subtotal-rule" />
        <div className="bs-row bs-subtotal">
          <span className="bs-label">{line.label}</span>
          <span className="bs-amount">{formatRON(line.opening)}</span>
          <span className="bs-amount">{formatRON(line.closing)}</span>
          <span className="bs-delta">
            {formatDelta((line.closing ?? 0) - (line.opening ?? 0))}
          </span>
        </div>
      </>
    );
  }

  const openingFmt = line.isContra
    ? `(${formatRON(Math.abs(line.opening ?? 0))})`
    : formatRON(line.opening);
  const closingFmt = line.isContra
    ? `(${formatRON(Math.abs(line.closing ?? 0))})`
    : formatRON(line.closing);
  const deltaValue = line.delta ?? (line.closing ?? 0) - (line.opening ?? 0);

  return (
    <div className={`bs-row bs-row-item ${line.isContra ? "bs-contra" : ""}`}>
      <span className="bs-label">
        {line.label}{" "}
        {line.accountCode && <span className="bs-code">({line.accountCode})</span>}
      </span>
      <span className="bs-amount">{openingFmt}</span>
      <span className="bs-amount">{closingFmt}</span>
      <span className="bs-delta">{formatDelta(deltaValue)}</span>
    </div>
  );
}

function formatDelta(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.5) return "0";
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return value > 0 ? `+${formatted}` : `−${formatted}`;
}
