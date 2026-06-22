// ResponsiveTable — primitive #3 of the mobile-consolidation set.
//
// Renders an actual <table> on desktop (≥768px) and a card list on mobile.
// One source of truth — the same `rows` + `columns` arrays drive both.
// No data hiding on mobile — every column's value shows up in the card grid,
// just laid out vertically instead of horizontally.
//
// Mobile card shape:
//   - First column = primary label (full-width header inside the card)
//   - Remaining columns = 2-col grid of (column.label / row value) pairs
//
// Use for: trial balance, peer-benchmark grids, any tabular dataset where
// the desktop table is the natural shape but mobile needs cards.
//
// Use PeriodComparisonCard directly for: BS / P&L / CF rows where the
// row shape is always (label + 2 periods + change). ResponsiveTable is
// the generic carrier; PeriodComparisonCard is the specialized BS shape.

import type { ReactNode } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export interface ColumnDef<T> {
  /** Stable key used as React key + lookup into row. */
  key: keyof T & string;
  /** Display label for the column header / mobile-card sublabel. */
  label: ReactNode;
  /** Custom cell renderer. Default = `row[col.key]` rendered as ReactNode. */
  render?: (row: T) => ReactNode;
  /** Optional className applied to BOTH desktop <td> and mobile cell wrapper. */
  cellClassName?: string;
  /** Desktop-only: column alignment. Defaults to right-align for the
   *  non-primary columns (typical financial layout). */
  align?: "left" | "right";
  /** Desktop-only: column header className (e.g. width hints). */
  headerClassName?: string;
}

export interface ResponsiveTableProps<T> {
  rows: T[];
  columns: ColumnDef<T>[];
  /** Stable key extractor. Defaults to row index — provide a real key
   *  whenever rows can be reordered or filtered. */
  rowKey?: (row: T, index: number) => string | number;
  /** Mobile-only: when present, a click handler is attached to each card. */
  onRowClick?: (row: T) => void;
  /** Empty-state message. Renders when rows.length === 0. */
  emptyMessage?: ReactNode;
  /** Extra className for the outer wrapper. */
  className?: string;
}

export function ResponsiveTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  emptyMessage = "No data.",
  className,
}: ResponsiveTableProps<T>) {
  const isMobile = useIsMobile();

  if (rows.length === 0) {
    return (
      <div className={cn("rounded-xl border border-rule bg-surface/60 p-6 text-center text-[13px] text-ink-soft", className)}>
        {emptyMessage}
      </div>
    );
  }

  const keyOf = (row: T, i: number) => rowKey ? rowKey(row, i) : i;

  if (isMobile) {
    return (
      <div className={cn("space-y-2", className)}>
        {rows.map((row, i) => (
          <MobileCard
            key={keyOf(row, i)}
            row={row}
            columns={columns}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={cn("overflow-x-auto rounded-xl border border-rule bg-surface/60", className)}>
      <table className="w-full text-[13px]">
        <thead className="bg-bg-2/40 text-ink-soft">
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cn(
                  "px-3 py-2 text-[11px] uppercase tracking-wider font-medium",
                  col.align === "right" ? "text-right" : "text-left",
                  col.headerClassName,
                )}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={keyOf(row, i)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                "border-t border-rule/40",
                onRowClick && "cursor-pointer hover:bg-bg-2/40",
              )}
            >
              {columns.map((col, ci) => (
                <td
                  key={col.key}
                  className={cn(
                    "px-3 py-2 align-baseline",
                    ci === 0 ? "text-ink" : "tabular-nums",
                    col.align === "right" ? "text-right" : "text-left",
                    col.cellClassName,
                  )}
                >
                  {col.render ? col.render(row) : renderCell(row[col.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Mobile card — primary col as header, rest in 2-col grid below
// ─────────────────────────────────────────────────────────────────────────

function MobileCard<T>({
  row,
  columns,
  onClick,
}: {
  row: T;
  columns: ColumnDef<T>[];
  onClick?: () => void;
}) {
  const [primary, ...rest] = columns;
  const Wrapper = onClick ? "button" : "div";

  return (
    <Wrapper
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "block w-full text-left rounded-xl border border-rule bg-surface/80 p-4 min-w-0",
        onClick && "transition-colors hover:border-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30",
      )}
    >
      {/* Primary column = card header */}
      <div className="text-[13px] font-medium text-ink mb-3 leading-snug line-clamp-2">
        {primary.render ? primary.render(row) : renderCell(row[primary.key])}
      </div>

      {/* Remaining columns in 2-col label/value grid */}
      {rest.length > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          {rest.map((col) => (
            <div key={col.key} className={cn("min-w-0", col.cellClassName)}>
              <div className="text-[10px] uppercase tracking-wider text-ink-mute mb-0.5 truncate">
                {col.label}
              </div>
              <div className="text-[13px] font-semibold tabular-nums text-ink truncate whitespace-nowrap">
                {col.render ? col.render(row) : renderCell(row[col.key])}
              </div>
            </div>
          ))}
        </div>
      )}
    </Wrapper>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Default cell renderer — render primitive cell values inline; pass through
// any ReactNode or null/undefined as em-dash for "no data" rather than empty.
// ─────────────────────────────────────────────────────────────────────────
function renderCell(value: unknown): ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return value as ReactNode;
}
