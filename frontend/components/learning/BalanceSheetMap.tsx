// F5.0 Wave 3 — Balance Sheet Map.
//
// A compact learning rail rendered above the BS table. Three columns
// (Assets / Liabilities / Equity), each listing the major line items as
// click-to-open concept chips. The chips push the concept onto the
// popover stack the same way an underlined LearnableNumber would.
//
// Intentionally not a tour, not a guide, not a sidebar — it's the visual
// scaffold of the balance sheet equation, where every label is a doorway
// into the concept popover.

import { ArrowRight } from "lucide-react";
import { usePopoverStack } from "./PopoverStackProvider";
import { cn } from "@/lib/utils";

interface MapEntry {
  /** Concept registry key — null for headers/non-clickable items. */
  conceptKey: string | null;
  label: string;
  /** Optional small grey sub-line, e.g. RAS account range. */
  sub?: string;
}

const ASSETS: MapEntry[] = [
  { conceptKey: "non_current_assets", label: "Fixed assets", sub: "Class 2 · PP&E · Intangibles" },
  { conceptKey: "inventory", label: "Inventory", sub: "Class 3 · 301 · 345 · 371" },
  { conceptKey: "receivables", label: "Receivables", sub: "Class 4 · 411 · 413" },
  { conceptKey: "cash", label: "Cash", sub: "Class 5 · 5121 · 5124 · 531" },
];

const LIABILITIES: MapEntry[] = [
  { conceptKey: "long_term_debt", label: "Long-term debt", sub: "162 · 167" },
  { conceptKey: "short_term_debt", label: "Short-term debt", sub: "519 · 168" },
  { conceptKey: "accounts_payable", label: "Payables", sub: "401 · 403 · 408" },
  { conceptKey: "current_liabilities", label: "Taxes & payroll", sub: "42 · 43 · 44" },
];

const EQUITY: MapEntry[] = [
  { conceptKey: "share_capital", label: "Share capital", sub: "1012 · 104" },
  { conceptKey: "retained_earnings", label: "Reserves", sub: "1061 · 1068" },
  { conceptKey: "retained_earnings", label: "Retained earnings", sub: "117" },
  { conceptKey: "net_profit", label: "Current-year profit", sub: "121" },
];

interface ColumnSpec {
  title: string;
  tone: "asset" | "liability" | "equity";
  entries: MapEntry[];
}

const COLUMNS: ColumnSpec[] = [
  { title: "Assets",      tone: "asset",     entries: ASSETS },
  { title: "Liabilities", tone: "liability", entries: LIABILITIES },
  { title: "Equity",      tone: "equity",    entries: EQUITY },
];

const TONE_STYLES: Record<ColumnSpec["tone"], { dot: string; label: string }> = {
  asset:     { dot: "bg-[hsl(173,57%,55%)]",  label: "text-[hsl(173,57%,42%)]" },
  liability: { dot: "bg-[hsl(173,57%,55%)]",   label: "text-[hsl(173,57%,42%)]" },
  equity:    { dot: "bg-[hsl(173,57%,60%)]",  label: "text-[hsl(173,57%,46%)]" },
};

export function BalanceSheetMap() {
  const { push } = usePopoverStack();

  const open = (
    conceptKey: string,
    e: React.MouseEvent<HTMLButtonElement>,
  ) => {
    const rect = e.currentTarget.getBoundingClientRect();
    push({ conceptKey, value: 0, triggerRect: rect });
  };

  return (
    <aside
      data-testid="balance-sheet-map"
      data-guide="bs-map"
      aria-label="Balance Sheet Map"
      className="
        mb-5 rounded-2xl border border-rule bg-surface
        px-4 sm:px-5 py-4
      "
    >
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-[hsl(173,57%,55%)] font-semibold">
            Learning rail
          </div>
          <h3 className="mt-0.5 text-[14px] font-semibold text-ink leading-tight">
            Balance Sheet Map
          </h3>
        </div>
        <span className="text-[11px] text-ink-mute hidden sm:inline">
          Tap any item to learn it
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {COLUMNS.map((col) => (
          <div key={col.title}>
            <div className="flex items-center gap-1.5 mb-2">
              <span
                className={cn(
                  "inline-block w-1.5 h-1.5 rounded-full",
                  TONE_STYLES[col.tone].dot,
                )}
                aria-hidden
              />
              <span
                className={cn(
                  "text-[10.5px] uppercase tracking-[0.12em] font-semibold",
                  TONE_STYLES[col.tone].label,
                )}
              >
                {col.title}
              </span>
            </div>
            <ul className="space-y-1">
              {col.entries.map((entry) => (
                <li key={`${col.title}-${entry.label}`}>
                  {entry.conceptKey ? (
                    <button
                      type="button"
                      onClick={(e) => open(entry.conceptKey!, e)}
                      data-testid={`bs-map-${entry.conceptKey}`}
                      className="
                        group w-full text-left rounded-md
                        px-2 py-1.5 -mx-2
                        hover:bg-bg-2/50 transition-colors
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(173,57%,55%)]/30
                      "
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12.5px] text-ink font-medium">
                          {entry.label}
                        </span>
                        <ArrowRight
                          size={11}
                          strokeWidth={2}
                          className="text-ink-mute/50 group-hover:text-[hsl(173,57%,55%)] group-hover:translate-x-0.5 transition-all shrink-0"
                        />
                      </div>
                      {entry.sub && (
                        <div className="text-[10.5px] text-ink-mute leading-tight mt-0.5 font-mono">
                          {entry.sub}
                        </div>
                      )}
                    </button>
                  ) : (
                    <div className="px-2 py-1.5 -mx-2 text-[12.5px] text-ink-mute">
                      {entry.label}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-3 pt-3 border-t border-rule/60 text-[11px] text-ink-mute leading-relaxed">
        Assets <span className="text-ink-soft">=</span> Liabilities{" "}
        <span className="text-ink-soft">+</span> Equity. The two sides always
        agree — that's why it's called a balance sheet.
      </div>
    </aside>
  );
}
