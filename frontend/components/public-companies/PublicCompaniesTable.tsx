// Watchlist table — premium financial density.
//
// Redesign per spec: drops "Step 2" label, sticky header, denser rows
// (py-2 vs py-3), per-row source pill, click-row sets selected (for
// snapshot panel). Open-full-analysis lives in the snapshot panel header,
// not as a per-row navigation. Mobile collapses to cards.

import { ArrowUpRight } from "lucide-react";
import { Money } from "@/components/ui/Money";
import { DEMO_WATCHLIST, type WatchlistRow } from "@/lib/publicCompanyWatchlist";
import { PublicCompanySourceBadge } from "./PublicCompanySourceBadge";

interface Props {
  rows?: WatchlistRow[];
  /** When set, row click sets this as the selected ticker (snapshot panel above). */
  onSelect?: (ticker: string) => void;
  selectedTicker?: string | null;
  demoMode: boolean;
}

const HEADER_CELLS = [
  { label: "Company",          align: "left" },
  { label: "Market Cap",       align: "right" },
  { label: "Revenue",          align: "right" },
  { label: "EBITDA Margin",    align: "right" },
  { label: "ND / EBITDA",      align: "right" },
  { label: "P/E",              align: "right" },
  { label: "EV / EBITDA",      align: "right" },
  { label: "FCF Yield",        align: "right" },
  { label: "Last Updated",     align: "right" },
  { label: "Source",           align: "right" },
] as const;

export function PublicCompaniesTable({
  rows = DEMO_WATCHLIST,
  onSelect,
  selectedTicker = null,
  demoMode,
}: Props) {
  return (
    <section
      data-testid="public-companies-watchlist"
      className="rounded-3xl border border-rule bg-surface overflow-hidden"
    >
      <header className="flex items-baseline justify-between gap-3 px-5 sm:px-6 py-3.5 border-b border-rule">
        <h2 className="font-serif text-[18px] text-ink leading-tight tracking-[-0.005em]">
          Watchlist
        </h2>
        <span className="text-[11.5px] text-ink-mute tabular-nums">
          {rows.length} companies
        </span>
      </header>

      {/* Mobile card list */}
      <div className="lg:hidden divide-y divide-rule">
        {rows.map((r) => (
          <MobileRow
            key={r.ticker}
            row={r}
            demoMode={demoMode}
            selected={selectedTicker === r.ticker}
            onSelect={onSelect}
          />
        ))}
      </div>

      {/* Desktop table */}
      <div className="hidden lg:block overflow-x-auto">
        <table className="w-full">
          <thead className="sticky top-0 bg-bg-2/60 backdrop-blur z-10">
            <tr className="border-b border-rule">
              {HEADER_CELLS.map((h) => (
                <th
                  key={h.label}
                  className={`
                    text-[10px] uppercase tracking-[0.1em] font-semibold text-ink-mute
                    px-3 py-2.5 ${h.align === "left" ? "text-left" : "text-right tabular-nums"}
                  `}
                >
                  {h.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <DesktopRow
                key={r.ticker}
                row={r}
                demoMode={demoMode}
                selected={selectedTicker === r.ticker}
                onSelect={onSelect}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}


function DesktopRow({
  row, demoMode, selected, onSelect,
}: {
  row: WatchlistRow; demoMode: boolean; selected: boolean;
  onSelect?: (t: string) => void;
}) {
  return (
    <tr
      data-testid={`public-companies-watchlist-row-${row.ticker}`}
      onClick={() => onSelect?.(row.ticker)}
      className={`
        group cursor-pointer
        border-b border-rule/40 last:border-b-0
        ${selected ? "bg-brand/5 hover:bg-brand/8" : "hover:bg-bg-2/30"}
        transition-colors
      `}
    >
      <td className="px-3 py-2 text-[13px]">
        <div className="flex flex-col gap-0 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="font-mono text-[13px] font-semibold text-ink tabular-nums">{row.ticker}</span>
            <span className="text-[12.5px] text-ink truncate group-hover:text-brand-d transition-colors">{row.name}</span>
          </div>
          <div className="text-[10.5px] text-ink-mute mt-0.5">
            {row.sector} · {row.exchange}
          </div>
        </div>
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-[12.5px] text-ink">
        <Money value={row.market_cap_usd} fromCurrency="USD" compact />
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-[12.5px] text-ink">
        <Money value={row.revenue_usd} fromCurrency="USD" compact />
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-[12.5px] text-ink">
        {row.ebitda_margin_pct.toFixed(1)}%
      </td>
      <td className={`
        px-3 py-2 text-right tabular-nums text-[12.5px]
        ${row.net_debt_to_ebitda < 0
          ? "text-emerald-700 dark:text-emerald-300"
          : row.net_debt_to_ebitda > 3 ? "text-amber-700 dark:text-amber-300" : "text-ink"}
      `}>
        {row.net_debt_to_ebitda.toFixed(2)}×
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-[12.5px] text-ink">
        {row.pe_ratio.toFixed(1)}×
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-[12.5px] text-ink">
        {row.ev_ebitda.toFixed(1)}×
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-[12.5px] text-ink">
        {row.fcf_yield_pct.toFixed(1)}%
      </td>
      <td className="px-3 py-2 text-right text-[10.5px] text-ink-mute tabular-nums">
        {row.last_updated_iso}
      </td>
      <td className="px-3 py-2 text-right">
        <PublicCompanySourceBadge variant={demoMode ? "demo" : "nasdaq"} />
      </td>
    </tr>
  );
}


function MobileRow({
  row, demoMode, selected, onSelect,
}: {
  row: WatchlistRow; demoMode: boolean; selected: boolean;
  onSelect?: (t: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect?.(row.ticker)}
      className={`
        block w-full text-left px-5 py-3
        ${selected ? "bg-brand/5" : "hover:bg-bg-2/30"}
        transition-colors
      `}
    >
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-mono text-[13.5px] font-semibold text-ink tabular-nums">{row.ticker}</span>
          <span className="text-[12.5px] text-ink truncate">{row.name}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <PublicCompanySourceBadge variant={demoMode ? "demo" : "nasdaq"} />
          <ArrowUpRight size={12} strokeWidth={1.75} className="text-ink-mute" />
        </div>
      </div>
      <div className="text-[10.5px] text-ink-mute mb-2">{row.sector} · {row.exchange}</div>
      <div className="grid grid-cols-3 gap-2">
        <Mini label="Market Cap" value={<Money value={row.market_cap_usd} fromCurrency="USD" compact />} />
        <Mini label="Revenue"    value={<Money value={row.revenue_usd}    fromCurrency="USD" compact />} />
        <Mini label="EBITDA %"   value={`${row.ebitda_margin_pct.toFixed(1)}%`} />
        <Mini label="ND/EBITDA"  value={`${row.net_debt_to_ebitda.toFixed(2)}×`} />
        <Mini label="P/E"        value={`${row.pe_ratio.toFixed(1)}×`} />
        <Mini label="EV/EBITDA"  value={`${row.ev_ebitda.toFixed(1)}×`} />
      </div>
    </button>
  );
}

function Mini({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-[0.08em] font-semibold text-ink-mute">{label}</div>
      <div className="font-serif text-[12.5px] text-ink tabular-nums leading-tight mt-0.5">{value}</div>
    </div>
  );
}

