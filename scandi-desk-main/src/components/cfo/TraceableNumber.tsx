// <TraceableNumber> — a clickable number that knows where it came from.
//
// Wraps any displayed RON figure / ratio / day-count. On click:
//   1. Navigates to the source statement tab (?tab=balance_sheet etc.)
//   2. Sets ?highlight=<bucket> on the URL
//   3. The target page's useHighlightFromUrl() hook reads the param,
//      scrolls the matching row into view, and pulses it for ~1500ms.
//
// Pure presentation otherwise — looks like a normal number with a
// subtle hover affordance (underline + cursor-pointer). No icon, no
// emoji, no chrome. Apple-style: the interactivity reveals itself,
// it doesn't shout.
//
// Usage pattern (drop-in for B / C):
//
//   <TraceableNumber
//     value={ratios.cash + ratios.ar}
//     format="currency"
//     source={{ statement: "bs", bucket: "accountsReceivable",
//               hint: "Trade receivables (4111)" }}
//   />

import { useCallback } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { formatRON, formatPercent } from "@/lib/formatRon";
import {
  STATEMENT_TAB,
  HIGHLIGHT_PARAM,
  TAB_PARAM,
  type TraceableSource,
} from "@/lib/traceableSource";

type Format = "currency" | "ratio" | "days" | "percent" | "raw";

interface Props {
  /** The numeric value to display. */
  value: number | null | undefined;
  /** How to format the value. Defaults to "currency". */
  format?: Format;
  /** Optional override of the default decimals (currency: 2, ratio: 2,
   *  days: 0, percent: 1). */
  decimals?: number;
  /** Origin metadata — what page + row this number traces back to. */
  source: TraceableSource;
  /** Optional className passthrough (e.g. for size / weight on
   *  headline values). */
  className?: string;
  /** Optional override: if provided, renders instead of the formatted
   *  value. Use sparingly — e.g. for "—" placeholders. */
  children?: React.ReactNode;
}

/** Render a value as a clickable number that traces back to its source row. */
export function TraceableNumber({
  value,
  format = "currency",
  decimals,
  source,
  className = "",
  children,
}: Props) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();

  const display = children ?? renderFormat(value, format, decimals);

  // The click handler preserves every existing query param (period_id
  // especially — we never want to drop the loaded period) and just
  // updates `tab` + `highlight`. react-router-dom's `navigate({...})`
  // shape lets us pass relative `pathname + search` while keeping
  // history clean (back button works).
  const onClick = useCallback(
    (e: React.MouseEvent | React.KeyboardEvent) => {
      e.preventDefault();
      const next = new URLSearchParams(searchParams);
      next.set(TAB_PARAM, STATEMENT_TAB[source.statement]);
      next.set(HIGHLIGHT_PARAM, source.bucket);
      navigate({ pathname: location.pathname, search: `?${next.toString()}` });
    },
    [navigate, searchParams, location.pathname, source.statement, source.bucket],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "Enter" || e.key === " ") onClick(e);
    },
    [onClick],
  );

  const tooltip = `View source: ${source.hint ?? source.bucket} on ${labelForStatement(source.statement)}`;

  return (
    <button
      type="button"
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={
        // Inline-friendly. Looks like text by default. Hover reveals a
        // subtle underline + slight color shift. Keyboard-focus ring
        // matches the project's existing focus style (ring-2 / accent).
        // tabular-nums keeps digit columns aligned with surrounding rows.
        "inline align-baseline cursor-pointer text-inherit bg-transparent border-0 p-0 m-0 " +
        "font-inherit tabular-nums " +
        "underline-offset-2 decoration-dotted decoration-ink-mute/40 " +
        "hover:underline hover:decoration-accent hover:text-accent " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:rounded " +
        "transition-colors duration-150 " +
        className
      }
      title={tooltip}
      aria-label={tooltip}
      data-traceable-source-statement={source.statement}
      data-traceable-source-bucket={source.bucket}
    >
      {display}
    </button>
  );
}

// ─── Format helpers ─────────────────────────────────────────────────────

function renderFormat(
  value: number | null | undefined,
  format: Format,
  decimalsOverride?: number,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  switch (format) {
    case "currency":
      return formatRON(value);
    case "percent":
      return formatPercent(value);
    case "ratio": {
      const d = decimalsOverride ?? 2;
      return `${value.toFixed(d)}×`;
    }
    case "days": {
      const d = decimalsOverride ?? 0;
      return `${value.toFixed(d)}d`;
    }
    case "raw":
    default: {
      const d = decimalsOverride ?? 0;
      return value.toLocaleString("en-US", {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      });
    }
  }
}

function labelForStatement(s: TraceableSource["statement"]): string {
  switch (s) {
    case "bs":
      return "Balance Sheet";
    case "pl":
      return "P&L";
    case "cf":
      return "Cash Flow";
  }
}
