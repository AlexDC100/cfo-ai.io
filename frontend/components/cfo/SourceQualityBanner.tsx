// SourceQualityBanner — F3.11 surfaces the F3.9 source-data telemetry.
//
// When the engine's pre-routing audit detects that the raw trial-balance
// closing-side sums (Σ sf_d vs Σ sf_c) are imbalanced beyond the 2%
// threshold, render a prominent amber WARN banner above the analysis so
// the operator understands: the engine drift on this file will exceed
// normal range because the source file itself is imbalanced. Engine
// cannot fix what the source file got wrong; the analysis is still
// produced, but reconciliation will reflect the underlying source
// quality.
//
// F3.14 (B1) — extends behavior with a `telemetryAvailable` prop. When
// set to false (Claude-extracted upload, where raw sf_d/sf_c are not
// preserved because Claude is normalizing as it extracts), renders a
// quiet info pill explaining that source-data imbalance check is RAS-TB
// specific and pointing to the BS reconciliation rec instead. Per
// ADR_F3_14_DEFERRED_ITEMS.md — ADR-1.
//
// Hidden when:
//   · Telemetry IS available but warn=false (source data is balanced).
//
// Visual: amber-tinted card mirroring the DataDepthBanner styling so it
// reads as "first-class informational signal" without alarming the user.

import { useState } from "react";
import { AlertTriangle, ChevronDown, Info } from "lucide-react";
import { Money } from "@/components/ui/Money";
import type { Currency } from "@/lib/rates";

interface Props {
  /** Source-data quality telemetry from `statements.sourceDataQuality`.
   *  Pass `undefined` to hide the banner entirely. */
  sourceQuality?: {
    raw_imbalance_pct: number;
    raw_imbalance_abs: number;
    sum_closing_debit: number;
    sum_closing_credit: number;
    warn: boolean;
    warn_threshold_pct?: number;
  } | null;
  /** Optional currency label for the absolute imbalance line.
   *  Defaults to "RON" (the most common case on this platform). */
  currency?: string;
  /** F3.14 B1 — when explicitly set to false (and no `sourceQuality` is
   *  available), render the quiet "n/a" info pill for Claude-extracted
   *  uploads. Pass `true` (the default) when telemetry is expected; the
   *  component will simply hide if telemetry is absent in that case
   *  (pre-F3.11 cached periods). */
  telemetryAvailable?: boolean;
}

function fmtRon(value: number, _currency: string): string {
  // Deprecated: the `_currency` arg used to hardcode the suffix without
  // FX conversion, so toggling EUR/USD in the top bar left the banner
  // frozen in RON. Banner now wraps the imbalance value in <Money> at
  // the render site so it follows the global currency switcher.
  try {
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${Math.round(value).toLocaleString()}`;
  }
}

export function SourceQualityBanner({ sourceQuality, currency = "RON", telemetryAvailable = true }: Props) {
  const [open, setOpen] = useState(false);

  // F3.14 B1 — Claude-path "n/a" pill. Renders a quiet info row when the
  // caller explicitly signals telemetry is unavailable for this upload
  // type (Claude-extracted from financial statements; raw sf_d/sf_c not
  // preserved). Links the words "BS reconciliation" to the existing
  // Recommendations anchor — operators can drill into the equivalent
  // integrity signal from there.
  if (!sourceQuality && telemetryAvailable === false) {
    return (
      <div
        className="rounded-md mb-3 inline-flex items-center gap-2 px-3 py-1.5 text-[11px]"
        style={{
          background: "rgba(42,168,155,0.06)",
          border: "1px solid rgba(42,168,155,0.20)",
          color: "#2AA89B",
        }}
        data-testid="source-quality-na-pill"
        role="note"
      >
        <Info className="h-3.5 w-3.5 shrink-0" />
        <span>
          Debit/credit imbalance check available for RAS trial balance inputs only.
          This file was extracted from financial statements — balance integrity is
          verified via{" "}
          <a
            href="#recommendations"
            className="underline font-semibold"
            style={{ color: "#2AA89B" }}
          >
            BS reconciliation
          </a>
          {" "}instead (see Recommendations).
        </span>
      </div>
    );
  }

  // Hide unless telemetry present AND warn flag set.
  if (!sourceQuality || !sourceQuality.warn) {
    return null;
  }

  const pct = sourceQuality.raw_imbalance_pct;
  const absVal = sourceQuality.raw_imbalance_abs;
  const sumD = sourceQuality.sum_closing_debit;
  const sumC = sourceQuality.sum_closing_credit;
  const threshold = sourceQuality.warn_threshold_pct ?? 2.0;

  // Amber accent palette — matches existing DataDepthBanner level-1
  // amber so the dashboard's warning vocabulary stays consistent.
  const accent = "#2AA89B";
  const accentBg = "rgba(92,211,197,0.10)";
  const accentBorder = "rgba(92,211,197,0.40)";

  return (
    <div
      className="rounded-lg overflow-hidden mb-4"
      style={{ background: accentBg, border: `1px solid ${accentBorder}` }}
      data-testid="source-quality-warn-banner"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2 min-w-0">
          <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: accent }} />
          <span className="text-[12px] font-semibold" style={{ color: accent }}>
            Source-data imbalance: {pct.toFixed(2)}%
          </span>
          <span className="text-[12px] text-ink-soft truncate">
            · the trial-balance closing-side sums don&apos;t match (exceeds {threshold.toFixed(1)}% threshold)
          </span>
        </div>
        <ChevronDown
          className="h-4 w-4 shrink-0 transition-transform"
          style={{
            color: accent,
            transform: open ? "rotate(180deg)" : "rotate(0)",
          }}
        />
      </button>

      {open && (
        <div className="px-4 pb-3 pt-1 text-[12px] leading-relaxed" style={{ color: "#1a1a1a" }}>
          <p className="mb-2">
            Every Romanian trial balance should satisfy Σ closing-debit = Σ closing-credit.
            This file violates that by{" "}
            <strong><Money value={absVal} fromCurrency={(currency as Currency) ?? "RON"} /></strong> ({pct.toFixed(2)}% of total).
            The engine cannot reconcile what the source already got wrong — the analysis
            is still produced, but the BS reconciliation gap will be proportionally larger.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 font-mono text-[11px]">
            <div>Σ sf_d (closing debit):  <strong><Money value={sumD} fromCurrency={(currency as Currency) ?? "RON"} /></strong></div>
            <div>Σ sf_c (closing credit): <strong><Money value={sumC} fromCurrency={(currency as Currency) ?? "RON"} /></strong></div>
            <div>Absolute gap: <strong><Money value={absVal} fromCurrency={(currency as Currency) ?? "RON"} /></strong></div>
            <div>Imbalance %: <strong>{pct.toFixed(4)}%</strong></div>
          </div>
          <div className="mt-3 flex items-start gap-2 text-[11px]" style={{ color: accent }}>
            <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              Common causes: year-end closing entries posted with pending counter-entries,
              extended-layout SAGA/WinMENTOR exports that snapshot mid-reconciliation, or
              source-document errors. Re-exporting the trial balance after the accountant
              completes closing entries usually resolves it.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
