// PublicCompaniesUniverseTable — Apple-Stocks-style list of public companies.
//
// 2026-05-25 REDESIGN — replaces the 14-column / 1800px-wide table that
// crammed every metric into a horizontal scroll. The previous layout
// failed the "scan 200 rows in 30 seconds" test the user explicitly
// called out. New layout follows the Apple Stocks pattern:
//
//   ┌────────────────────────────────────────────────────────────────┐
//   │ [Logo]  NVDA · NVIDIA Corp.                $967.60   $4.65T   │
//   │         Semiconductors · NASDAQ           ─────────  ▲ EBITDA │
//   └────────────────────────────────────────────────────────────────┘
//
// Five elements per row, every one of them legible at a glance:
//   1. Brand logo (Clearbit → letter-avatar fallback)
//   2. Ticker + company name + sector (text stack on the left)
//   3. Last close price
//   4. Market cap (the dominant data point on the right)
//   5. Headline metric: EBITDA margin, colour-coded vs absolute health bands
//
// Currency default — NATIVE (USD for Nasdaq tickers). The user reported
// "20.5 tril. RON" on Apple's market cap; that nonsense came from
// blindly converting USD source values to the user's global RON toggle.
// We now lock public-company values to their source currency by default.
// A toolbar toggle lets power users opt back into the global currency
// switcher when they explicitly want everything in their working currency.
//
// Full per-company detail (P/E, EV/EBITDA, ROE, FCF Yield, all the metrics
// that USED to be columns) lives in the side drawer — click any row to
// open it. That keeps the list scannable AND preserves drill-down depth.

import { memo, useMemo, useState } from "react";
import { ArrowUpDown, ArrowDown, ArrowUp, RefreshCw, Search, TrendingUp, TrendingDown } from "lucide-react";
import { Money } from "@/components/ui/Money";
import type {
  PublicCompanyFinancialSnapshot,
  UniverseSource,
} from "@/lib/publicCompanyUniverse";
import { snapshotCurrency, UNIVERSE_SECTORS } from "@/lib/publicCompanyUniverse";
import { PublicCompanySourceBadge } from "./PublicCompanySourceBadge";
import { CompanyLogo } from "./CompanyLogo";
// Phase A — AI risk score per ticker, fetched in batch from
// /api/public/intelligence/risk-scores. The parent (PublicCompanyIntelligence)
// passes the map in; null/undefined means scores aren't loaded yet or the
// intelligence endpoint is unreachable — the row falls back to no chip.
import type { UniverseRiskScoreRow } from "@/lib/publicCompanyIntelligence";

interface Props {
  rows: PublicCompanyFinancialSnapshot[];
  mode: "live" | "demo";
  lastUpdated?: string | null;
  isLoading?: boolean;
  isRefetching?: boolean;
  onRefresh?: () => void;
  onSelect?: (ticker: string) => void;
  selectedTicker?: string | null;
  /** AI risk scores keyed by uppercase ticker. Optional — when undefined,
   *  rows render without the AI Risk chip. */
  riskScores?: Record<string, UniverseRiskScoreRow> | null;
}

type SortKey = "ticker" | "companyName" | "sector" | "price" | "marketCap" | "ebitdaMargin" | "riskScore" | "opportunityScore";
type SortDir = "asc" | "desc";

export function PublicCompaniesUniverseTable({
  rows,
  mode,
  lastUpdated,
  isLoading = false,
  isRefetching = false,
  onRefresh,
  onSelect,
  selectedTicker = null,
  riskScores = null,
}: Props) {
  const [sector, setSector] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("marketCap");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  // Native-currency mode: when true (default), every monetary value is
  // rendered in its source currency (USD for Nasdaq) WITHOUT converting
  // to the user's global display currency. When false, the global
  // currency toggle applies — useful when comparing US peers to a RON-
  // denominated portfolio. The fix for the "Apple market cap shows as
  // 20.5 tril. RON" complaint.
  const [nativeCurrency, setNativeCurrency] = useState(true);

  // Per-sector row counts — drives the chip badges below. Pre-computed
  // once per `rows` change so chip rendering is O(1) per chip.
  const sectorCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const s = r.sector ?? "Unknown";
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return counts;
  }, [rows]);

  // Filter + sort pipeline. Pure useMemo so re-renders on parent state
  // don't re-pay the cost.
  const visible = useMemo(() => {
    let out = rows;
    if (sector) {
      out = out.filter((r) => (r.sector ?? "Unknown") === sector);
    }
    if (search.trim()) {
      const q = search.trim().toUpperCase();
      out = out.filter(
        (r) =>
          r.ticker.toUpperCase().includes(q) ||
          r.companyName.toUpperCase().includes(q),
      );
    }
    const dir = sortDir === "asc" ? 1 : -1;
    const numericSort = sortKey === "price" || sortKey === "marketCap" || sortKey === "ebitdaMargin";
    // The two AI-intelligence keys (riskScore + opportunityScore) read from
    // a separate map keyed by ticker, not from the snapshot. Handled here
    // as a parallel branch so the original sort path stays untouched.
    const isIntelSort = sortKey === "riskScore" || sortKey === "opportunityScore";
    out = [...out].sort((a, b) => {
      if (isIntelSort) {
        const ar = riskScores?.[a.ticker.toUpperCase()];
        const br = riskScores?.[b.ticker.toUpperCase()];
        const an = ar
          ? (sortKey === "riskScore" ? ar.risk_score : ar.opportunity_score)
          : null;
        const bn = br
          ? (sortKey === "riskScore" ? br.risk_score : br.opportunity_score)
          : null;
        if (an === null && bn === null) return 0;
        if (an === null) return 1;   // rows without scores sink to bottom
        if (bn === null) return -1;
        return (an - bn) * dir;
      }
      const av = a[sortKey as keyof PublicCompanyFinancialSnapshot] as unknown;
      const bv = b[sortKey as keyof PublicCompanyFinancialSnapshot] as unknown;
      if (numericSort) {
        const an = typeof av === "number" ? av : null;
        const bn = typeof bv === "number" ? bv : null;
        if (an === null && bn === null) return 0;
        if (an === null) return 1;
        if (bn === null) return -1;
        return (an - bn) * dir;
      }
      const as = String(av ?? "").toLowerCase();
      const bs = String(bv ?? "").toLowerCase();
      if (as < bs) return -1 * dir;
      if (as > bs) return 1 * dir;
      return 0;
    });
    return out;
  }, [rows, sector, search, sortKey, sortDir, riskScores]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      const numeric = key === "price" || key === "marketCap" || key === "ebitdaMargin";
      setSortDir(numeric ? "desc" : "asc");
    }
  };

  return (
    <section
      data-testid="public-companies-universe"
      className="rounded-3xl border border-rule bg-surface overflow-hidden"
    >
      {/* Header — count + last-updated + refresh */}
      <header className="flex items-baseline justify-between gap-3 px-5 sm:px-6 py-3.5 border-b border-rule">
        <div className="flex items-baseline gap-3">
          <h2 className="font-serif text-[18px] text-ink leading-tight tracking-[-0.005em]">
            Market universe
          </h2>
          <span className="text-[11.5px] text-ink-mute tabular-nums">
            {visible.length} of {rows.length} companies
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {lastUpdated && (
            <span
              className="text-[10.5px] text-ink-mute"
              title="Sharadar SF1 + DAILY are end-of-day datasets. Auto-refreshes every 5 minutes; the latest US-market close lands here ~30 minutes after market close (21:30 UTC)."
            >
              Updated {new Date(lastUpdated).toLocaleTimeString(undefined, {
                hour: "2-digit", minute: "2-digit",
              })}
              <span className="ml-1 text-ink-mute/70">· EOD</span>
            </span>
          )}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={isRefetching}
              data-testid="universe-refresh-btn"
              className="
                inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md
                border border-rule bg-bg-2/40 text-[11.5px] text-ink-soft
                hover:text-ink hover:bg-bg-2 hover:border-rule-strong
                disabled:opacity-50 disabled:cursor-not-allowed
                transition-all
              "
              title="Force a fresh server-side fetch from Nasdaq (bypasses the 5-min cache)"
            >
              <RefreshCw
                size={11}
                strokeWidth={2}
                className={isRefetching ? "animate-spin" : ""}
              />
              {isRefetching ? "Refreshing" : "Refresh"}
            </button>
          )}
        </div>
      </header>

      {/* Sector chips with row counts. Click "All" or a sector chip to
          filter. Counts are pre-computed from the full rows array, so
          they reflect the universe not the current filter — that way
          the user can see "Tech 42" and know exactly what they'd get. */}
      <div
        data-testid="universe-filters"
        className="flex flex-wrap items-center gap-1.5 px-5 sm:px-6 py-3 border-b border-rule bg-bg-2/30"
      >
        <SectorChip
          active={sector === null}
          label="All"
          count={rows.length}
          onClick={() => setSector(null)}
          testId="sector-chip-all"
        />
        {UNIVERSE_SECTORS.map((s) => {
          const count = sectorCounts.get(s) ?? 0;
          if (count === 0) return null; // hide empty sectors entirely
          return (
            <SectorChip
              key={s}
              active={sector === s}
              label={s}
              count={count}
              onClick={() => setSector(sector === s ? null : s)}
              testId={`sector-chip-${s.toLowerCase().replace(/\s+/g, "-")}`}
            />
          );
        })}
      </div>

      {/* Toolbar — search, sort, currency mode */}
      <div className="flex flex-wrap items-center gap-3 px-5 sm:px-6 py-2.5 border-b border-rule bg-bg-2/15">
        <div
          className="
            inline-flex items-center gap-2 h-8 px-2.5 rounded-lg
            border border-rule bg-surface
            focus-within:border-brand/50 focus-within:ring-2 focus-within:ring-brand/20
            transition-all
          "
        >
          <Search size={12} strokeWidth={1.75} className="text-ink-mute" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Ticker or name…"
            data-testid="universe-search-input"
            className="
              w-[180px] bg-transparent outline-none
              text-[12.5px] text-ink placeholder:text-ink-mute
            "
          />
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-ink-mute">
          <span>Sort:</span>
          <SortPicker sortKey={sortKey} sortDir={sortDir} onChange={toggleSort} />
        </div>
        <div className="flex-1" />
        {/* Native-currency toggle. Sticky checkbox-style so power users
            can opt out when they explicitly want everything in their
            working currency. Default ON because the user's complaint
            was that Nasdaq tickers should show in USD, not RON. */}
        <label
          className="inline-flex items-center gap-2 text-[11.5px] text-ink-soft cursor-pointer select-none"
          title="When on, market caps + prices render in the company's reporting currency (USD for Nasdaq). When off, they convert to the global currency set in the top bar."
          data-testid="universe-native-currency-toggle"
        >
          <input
            type="checkbox"
            checked={nativeCurrency}
            onChange={(e) => setNativeCurrency(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-rule"
          />
          <span>
            Native currency <span className="text-ink-mute">(USD for US-listed)</span>
          </span>
        </label>
      </div>

      {/* Row list — semantically a list, not a table, because each row
          renders as a card-style block with mixed-typography content
          (logo + 3-line text stack on the left, numeric stack on the
          right). The 1800px-wide table is GONE. */}
      <ul
        data-testid="universe-row-list"
        className="divide-y divide-rule/40"
      >
        {isLoading && rows.length === 0 && (
          <li className="px-5 sm:px-6 py-12 text-center text-ink-mute text-[12.5px]">
            Loading universe…
          </li>
        )}
        {!isLoading && visible.length === 0 && (
          <li className="px-5 sm:px-6 py-12 text-center text-ink-mute text-[12.5px]">
            No companies match this filter.
          </li>
        )}
        {visible.map((row) => (
          <UniverseRow
            key={row.ticker}
            row={row}
            riskScore={riskScores?.[row.ticker.toUpperCase()] ?? null}
            selected={selectedTicker === row.ticker}
            onSelect={onSelect}
            nativeCurrency={nativeCurrency}
          />
        ))}
      </ul>

      {mode === "demo" && (
        <footer className="border-t border-rule px-5 sm:px-6 py-2.5 bg-amber-50/30 dark:bg-amber-500/[0.05] text-[11px] text-amber-800 dark:text-amber-200">
          Demo data shown. Connect <code className="font-mono">NASDAQ_DATA_LINK_API_KEY</code> on the backend for live SF1 fundamentals across the full universe.
        </footer>
      )}
    </section>
  );
}

// ── Single row ──────────────────────────────────────────────────────────
// Memoized so re-renders triggered by parent state (search input, sector
// chip toggle) skip rows whose props haven't changed. With 200+ rows the
// memo is the difference between snappy and laggy on every keystroke.

interface UniverseRowProps {
  row: PublicCompanyFinancialSnapshot;
  riskScore?: UniverseRiskScoreRow | null;
  selected: boolean;
  onSelect?: (ticker: string) => void;
  nativeCurrency: boolean;
}

const UniverseRow = memo(UniverseRowInner, (prev, next) =>
  prev.row === next.row
  && prev.riskScore === next.riskScore
  && prev.selected === next.selected
  && prev.onSelect === next.onSelect
  && prev.nativeCurrency === next.nativeCurrency,
);

function UniverseRowInner({
  row,
  riskScore,
  selected,
  onSelect,
  nativeCurrency,
}: UniverseRowProps) {
  const cur = snapshotCurrency(row);
  return (
    <li
      data-testid={`universe-row-${row.ticker}`}
      onClick={() => onSelect?.(row.ticker)}
      className={`
        relative flex items-center gap-3 sm:gap-4
        px-5 sm:px-6 py-3
        transition-colors cursor-pointer group
        ${selected
          ? "bg-brand/[0.06] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-brand"
          : "hover:bg-bg-2/40"
        }
      `}
    >
      {/* 1. Logo */}
      <CompanyLogo ticker={row.ticker} size={36} />

      {/* 2. Ticker + name + sector — left-aligned text stack */}
      <div className="flex-1 min-w-0 grid grid-cols-[auto_1fr] gap-x-2 items-baseline">
        <span className="font-mono font-semibold text-[13.5px] text-ink tabular-nums">
          {row.ticker}
        </span>
        <span
          className="text-[13px] text-ink-soft truncate"
          title={row.companyName}
        >
          {row.companyName}
        </span>
        <span className="col-span-2 text-[11px] text-ink-mute mt-0.5">
          {row.sector ?? "Unknown sector"}
          {row.source && (
            <span className="ml-2 inline-block align-baseline">
              <PublicCompanySourceBadge variant={row.source as UniverseSource} />
            </span>
          )}
        </span>
      </div>

      {/* 3. Price — small, secondary on the right */}
      <div className="hidden sm:flex flex-col items-end text-[11.5px] text-ink-mute tabular-nums shrink-0 min-w-[80px]">
        <span className="text-ink-soft">
          <MoneyCell value={row.price} currency={cur} native={nativeCurrency} />
        </span>
        <span className="text-[10.5px] uppercase tracking-[0.06em] mt-0.5">price</span>
      </div>

      {/* 4. Market cap — the dominant data point */}
      <div className="flex flex-col items-end text-right tabular-nums shrink-0 min-w-[100px]">
        <span className="text-[15px] font-semibold text-ink">
          <MoneyCell value={row.marketCap} currency={cur} native={nativeCurrency} />
        </span>
        <span className="text-[10.5px] uppercase tracking-[0.06em] text-ink-mute mt-0.5">
          market cap
        </span>
      </div>

      {/* 5. Headline metric — EBITDA margin with up/down + colour coding.
          Color thresholds are absolute health bands, not sector-relative
          (computing sector-relative needs a percentile pass — out of
          scope here). Green ≥20%, amber 5–20%, red <5%, neutral when
          missing. */}
      <div className="hidden md:flex flex-col items-end shrink-0 min-w-[100px]">
        <EbitdaBadge value={row.ebitdaMargin} />
        <span className="text-[10.5px] uppercase tracking-[0.06em] text-ink-mute mt-0.5">
          EBITDA mgn
        </span>
      </div>

      {/* 6. AI Risk chip — only when intelligence data is loaded. Hidden
          on tablet and below so the row stays readable on narrow widths
          (the chip is also visible in the detail drawer's Risk tab). */}
      {riskScore && (
        <div className="hidden lg:flex flex-col items-end shrink-0 min-w-[88px]">
          <AiRiskChip score={riskScore.risk_score} level={riskScore.risk_level} />
          <span
            className="text-[10.5px] uppercase tracking-[0.06em] text-ink-mute mt-0.5"
            title={riskScore.main_risk ?? undefined}
          >
            {riskScore.main_risk
              ? riskScore.main_risk.length > 18
                ? riskScore.main_risk.slice(0, 16) + "…"
                : riskScore.main_risk
              : "AI risk"}
          </span>
        </div>
      )}
    </li>
  );
}

// ── AI Risk chip ────────────────────────────────────────────────────────
// Mirrors the colour vocabulary of severityToBgClass in publicCompanyIntelligence.ts.
// Inline here (not imported) to keep the table free of stray helper deps.

function AiRiskChip({
  score,
  level,
}: {
  score: number;
  level: "low" | "medium" | "high" | "critical";
}) {
  const palette =
    level === "critical" ? "bg-alert/15 text-alert border-alert/30" :
    level === "high"     ? "bg-orange-400/15 text-orange-400 border-orange-400/30" :
    level === "medium"   ? "bg-amber-400/15 text-amber-400 border-amber-400/30" :
                           "bg-emerald-400/15 text-emerald-400 border-emerald-400/30";
  return (
    <span
      className={`
        inline-flex items-center gap-1
        h-[22px] px-2 rounded-md border
        text-[11.5px] font-semibold tabular-nums
        ${palette}
      `}
      data-testid="ai-risk-chip"
      data-level={level}
    >
      {score}
    </span>
  );
}

// ── Cell formatters ─────────────────────────────────────────────────────

/** Money cell that honours the native-currency toggle. When `native`
 *  is true, we hand `<Money>` a `fromCurrency` that matches what the
 *  display would be — net effect: no FX conversion happens, the value
 *  renders in the row's source currency with the correct symbol. When
 *  `native` is false, we let Money's normal path apply the global
 *  currency switcher. */
function MoneyCell({
  value,
  currency,
  native,
}: {
  value?: number | null;
  currency: import("@/lib/rates").Currency;
  native: boolean;
}) {
  if (value == null || !Number.isFinite(value)) return <Dash />;
  if (native) {
    // Render directly in the source currency. We use Intl.NumberFormat
    // with compact notation + the source currency code so we get
    // "$4.65T" / "€1.5B" / "£820M" universally — no Romanian "tril."
    // creeping in on Nasdaq rows.
    return <NativeMoney value={value} currency={currency} />;
  }
  return <Money value={value} fromCurrency={currency} compact />;
}

function NativeMoney({
  value,
  currency,
}: {
  value: number;
  currency: import("@/lib/rates").Currency;
}) {
  // Always en-US locale so abbreviations are "T/B/M/K" universally,
  // even when the rest of the UI is in Romanian. The locale of the
  // source currency drives display conventions, not the UI language.
  const formatted = useMemo(() => {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        notation: "compact",
        compactDisplay: "short",
        maximumFractionDigits: 2,
      }).format(value);
    } catch {
      return `${currency} ${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    }
  }, [value, currency]);
  return <span>{formatted}</span>;
}

function EbitdaBadge({ value }: { value?: number | null }) {
  if (value == null || !Number.isFinite(value)) {
    return <span className="text-[12px] text-ink-mute">—</span>;
  }
  const isHigh = value >= 20;
  const isLow = value < 5;
  const tone = isHigh
    ? "text-emerald-700 dark:text-emerald-300"
    : isLow
    ? "text-red-700 dark:text-red-300"
    : "text-amber-700 dark:text-amber-300";
  const Icon = isLow ? TrendingDown : TrendingUp;
  return (
    <span className={`inline-flex items-center gap-1 text-[13px] font-medium tabular-nums ${tone}`}>
      <Icon size={11} strokeWidth={2.25} />
      {value.toFixed(1)}%
    </span>
  );
}

function Dash() {
  return <span className="text-ink-mute">—</span>;
}

// ── Sector chip ─────────────────────────────────────────────────────────

function SectorChip({
  active,
  label,
  count,
  onClick,
  testId,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={[
        "inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-[11.5px] transition-all border",
        active
          ? "bg-ink text-paper border-ink"
          : "bg-surface text-ink-soft border-rule hover:border-rule-strong hover:text-ink",
      ].join(" ")}
    >
      <span>{label}</span>
      <span
        className={[
          "tabular-nums",
          active ? "text-paper/70" : "text-ink-mute",
        ].join(" ")}
      >
        {count}
      </span>
    </button>
  );
}

// ── Sort picker ─────────────────────────────────────────────────────────
// Replaces the per-column sort headers from the old table layout. With
// only ~5 things you might sort by, a dropdown is more honest than
// pretending the row layout is a sortable table.

const SORT_OPTIONS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "marketCap",        label: "Market cap" },
  { key: "ebitdaMargin",     label: "EBITDA margin" },
  // Phase A intelligence — surface AI Risk + Opportunity scores as
  // sortable options. Rows without scores sink to the bottom (handled
  // in the sort comparator above).
  { key: "riskScore",        label: "AI Risk" },
  { key: "opportunityScore", label: "AI Opportunity" },
  { key: "price",            label: "Price" },
  { key: "ticker",           label: "Ticker" },
  { key: "companyName",      label: "Name" },
  { key: "sector",           label: "Sector" },
];

function SortPicker({
  sortKey,
  sortDir,
  onChange,
}: {
  sortKey: SortKey;
  sortDir: SortDir;
  onChange: (k: SortKey) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1">
      <select
        value={sortKey}
        onChange={(e) => onChange(e.target.value as SortKey)}
        data-testid="universe-sort-select"
        className="
          h-7 pl-2 pr-6 rounded-md border border-rule bg-surface
          text-[11.5px] text-ink-soft cursor-pointer
          hover:text-ink hover:border-rule-strong
          focus:outline-none focus:ring-2 focus:ring-brand/20
        "
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onChange(sortKey)}
        data-testid="universe-sort-direction-btn"
        title={sortDir === "asc" ? "Ascending" : "Descending"}
        className="
          h-7 w-7 inline-flex items-center justify-center rounded-md
          border border-rule bg-surface text-ink-soft
          hover:text-ink hover:border-rule-strong
        "
      >
        {sortDir === "asc"
          ? <ArrowUp size={11} strokeWidth={2.5} />
          : <ArrowDown size={11} strokeWidth={2.5} />
        }
      </button>
      <ArrowUpDown size={10} strokeWidth={2} className="text-ink-mute/0" />
    </div>
  );
}
