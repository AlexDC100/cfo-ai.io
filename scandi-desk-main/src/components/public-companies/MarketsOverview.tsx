// MarketsOverview — Layer 1 of the public-companies redesign.
//
// 2026-05-25 — replaces the 200-row wall of rows that used to dominate
// the page. Users now land on a magazine-style overview:
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ Today's movers       (top 3 gainers + top 3 losers)          │
//   │ Explore by theme     (5 client-side derived quick views)     │
//   │ Sectors              (12 sector cards with live counts)      │
//   │ Featured comparisons (curated peer groups: Mag 7, Pharma…)   │
//   └──────────────────────────────────────────────────────────────┘
//
// Clicking any card calls `onExplore(filter)` — the parent flips the
// page from overview mode into Layer 2 (the redesigned 5-col table,
// pre-filtered to the clicked subset). The full 200-row list is now
// only reachable via the explicit "Browse all" button or by typing in
// the search panel above this component.
//
// Everything here is derived client-side from the already-loaded
// universe payload — no new backend endpoints. Themes are computed
// from absolute thresholds (Mega-caps = marketCap ≥ $200B, etc.) so
// any universe row can be tagged into a theme without a server pass.
// Featured comparisons are hardcoded ticker lists; tickers missing
// from the universe are auto-pruned so a comparison card never
// promises a row it can't deliver.

import { useMemo } from "react";
import { TrendingUp, TrendingDown, ChevronRight, Search } from "lucide-react";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import { UNIVERSE_SECTORS } from "@/lib/publicCompanyUniverse";
import { CompanyLogo } from "./CompanyLogo";
import { RomanianListedCard } from "./RomanianListedCard";

export type ExploreFilter =
  | { kind: "all"; label: string; description?: string }
  | { kind: "theme"; key: string; label: string; description: string; emoji: string; tickers: string[] }
  | { kind: "sector"; key: string; label: string; tickers: string[] }
  | { kind: "comparison"; key: string; label: string; description: string; emoji: string; tickers: string[] };

interface Props {
  rows: PublicCompanyFinancialSnapshot[];
  onExplore: (filter: ExploreFilter) => void;
  onSelectTicker: (ticker: string) => void;
}

// ── Theme definitions ────────────────────────────────────────────────────
// Each theme is a label + predicate. Predicates run against a snapshot
// and decide whether the row qualifies. The Markets-overview computes
// the set of qualifying tickers per theme at render time so the card
// counts are always accurate to the loaded universe.

interface ThemeDef {
  key: string;
  emoji: string;
  label: string;
  description: string;
  predicate: (r: PublicCompanyFinancialSnapshot) => boolean;
}

// 2026-05-25 — calibrated against the live Sharadar SF1 universe.
//   Reliably populated fields (200+/203 rows): ebitdaMargin, netMargin,
//   peRatio, roe, fcfYield, netDebtToEbitda, evToEbitda, debtToEquity.
//   NOT populated by the current normalizer (≤2 rows): revenueGrowth,
//   grossMargin, dividendYield. Themes are filtered against the
//   populated set so every card shows real companies. Backend
//   enrichment of growth + dividend fields is queued separately —
//   when those land we can swap predicates in without touching the
//   surrounding UI.
const THEMES: ReadonlyArray<ThemeDef> = [
  {
    key: "mega-caps",
    emoji: "🚀",
    label: "Mega-caps",
    description: ">$200B market cap · The largest businesses on the market",
    predicate: (r) => (r.marketCap ?? 0) >= 200_000_000_000,
  },
  {
    key: "quality-operators",
    emoji: "💹",
    label: "Quality operators",
    description: "EBITDA >25% · Net margin >12% · ROE >20% · Best-in-class businesses",
    predicate: (r) =>
      (r.ebitdaMargin ?? 0) >= 25
      && (r.netMargin ?? 0) >= 12
      && (r.roe ?? 0) >= 20,
  },
  {
    key: "cash-returners",
    emoji: "💎",
    label: "Cash returners",
    description: "FCF yield >5% · Strong cash generation · Funds dividends + buybacks",
    predicate: (r) => (r.fcfYield ?? 0) >= 5,
  },
  {
    key: "value-plays",
    emoji: "⚡",
    label: "Value plays",
    description: "P/E < 15 · Profitable · Looking cheap",
    predicate: (r) =>
      (r.peRatio ?? 0) > 0 && (r.peRatio ?? Infinity) < 15 && (r.netMargin ?? 0) > 0,
  },
  {
    key: "distressed",
    emoji: "⚠️",
    label: "Distressed",
    description: "Negative EBITDA · Refinancing pressure",
    predicate: (r) => r.ebitdaMargin != null && r.ebitdaMargin < 0,
  },
];

// ── Featured comparisons ─────────────────────────────────────────────────
// Curated peer groups — hardcoded ticker lists. Useful starting points
// for ad-hoc comparisons (the user's "I just want to compare big tech")
// intent. Tickers missing from the loaded universe are dropped from the
// card automatically; we never promise a ticker we can't show.

interface ComparisonDef {
  key: string;
  emoji: string;
  label: string;
  description: string;
  tickers: string[];
}

const FEATURED_COMPARISONS: ReadonlyArray<ComparisonDef> = [
  // ── Romanian groups first (BVB Phase 1, 2026-05-31). These are the
  //    comparisons that actually serve the customer base (RO SMEs +
  //    mid-caps). NASDAQ groups follow as the secondary universe.
  {
    key: "ro-meat-processors",
    emoji: "🥩",
    label: "Romanian meat processors",
    description:
      "BVB-listed food processors — Scandia Food's real peer group, not Apple",
    tickers: ["CFH"],
  },
  {
    key: "ro-energy",
    emoji: "⚡",
    label: "Romanian energy",
    description:
      "BVB-listed O&G / power — OMV Petrom · Romgaz · Hidroelectrica · Transgaz · Nuclearelectrica",
    tickers: ["SNP", "SNG", "H2O", "TGN", "SNN"],
  },
  {
    key: "ro-banks",
    emoji: "🏦",
    label: "Romanian banks",
    description: "BVB-listed banks — Banca Transilvania · BRD",
    tickers: ["TLV", "BRD"],
  },
  {
    key: "ro-grid",
    emoji: "🔌",
    label: "Romanian grid & utilities",
    description: "Transmission + distribution — Electrica · Transelectrica",
    tickers: ["EL.BVB", "TEL"],
  },
  // ── NASDAQ groups (secondary universe) ──
  {
    key: "mag-7",
    emoji: "🥇",
    label: "The Mag 7",
    description: "AAPL · MSFT · GOOGL · AMZN · META · NVDA · TSLA",
    tickers: ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"],
  },
  {
    key: "big-retail",
    emoji: "🛒",
    label: "Big retail",
    description: "Mass-market retail — every household name",
    tickers: ["WMT", "COST", "TGT", "HD", "LOW", "TJX"],
  },
  {
    key: "pharma-giants",
    emoji: "💊",
    label: "Pharma giants",
    description: "The largest pharma + biotech businesses",
    tickers: ["LLY", "JNJ", "ABBV", "MRK", "PFE", "BMY", "AMGN", "GILD"],
  },
  {
    key: "big-banks",
    emoji: "🏦",
    label: "Big banks",
    description: "Wall Street's bulge bracket",
    tickers: ["JPM", "BAC", "WFC", "C", "GS", "MS"],
  },
  {
    key: "cloud-leaders",
    emoji: "☁️",
    label: "Cloud leaders",
    description: "Public cloud, SaaS, data platforms",
    tickers: ["AMZN", "MSFT", "GOOGL", "ORCL", "CRM", "NOW", "SNOW", "WDAY"],
  },
  {
    key: "auto",
    emoji: "🚗",
    label: "Auto",
    description: "Global automakers — ICE + EV",
    tickers: ["TSLA", "F", "GM"],
  },
];

// ── Component ────────────────────────────────────────────────────────────

export function MarketsOverview({ rows, onExplore, onSelectTicker }: Props) {
  // ── Today's movers — top 3 gainers + top 3 losers by priceChangePct ──
  // Rows without a priceChangePct are excluded (mostly demo rows). When
  // the universe is in demo mode this section will be empty — that's
  // intentional: showing fake movers is worse than showing nothing.
  const { gainers, losers } = useMemo(() => {
    const withChange = rows.filter(
      (r) => typeof r.priceChangePct === "number" && Number.isFinite(r.priceChangePct),
    );
    const sorted = [...withChange].sort(
      (a, b) => (b.priceChangePct ?? 0) - (a.priceChangePct ?? 0),
    );
    return {
      gainers: sorted.slice(0, 3),
      losers: sorted.slice(-3).reverse(),
    };
  }, [rows]);

  // ── Theme counts — predicate-based ──
  const themeRows = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of THEMES) {
      m.set(t.key, rows.filter(t.predicate).map((r) => r.ticker));
    }
    return m;
  }, [rows]);

  // ── Sector counts — straight tally ──
  const sectorRows = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of rows) {
      const s = r.sector ?? "Unknown";
      if (!m.has(s)) m.set(s, []);
      m.get(s)!.push(r.ticker);
    }
    return m;
  }, [rows]);

  // ── Featured comparison rows — auto-prune tickers not in universe ──
  const comparisonRows = useMemo(() => {
    const have = new Set(rows.map((r) => r.ticker));
    return FEATURED_COMPARISONS.map((c) => ({
      ...c,
      tickers: c.tickers.filter((t) => have.has(t)),
    }));
  }, [rows]);

  const hasAnyMovers = gainers.length > 0 || losers.length > 0;

  return (
    <div data-testid="markets-overview" className="space-y-6">
      {/* ── Romanian Listed (BVB) — PRIMARY ─────────────────────────
            2026-05-31 — BVB Phase 1. This card leads the page so the
            customer base's actual peer set is visible first. NASDAQ
            sections (themes / sectors / Mag 7 / etc) follow as the
            secondary universe. */}
      <RomanianListedCard
        rows={rows}
        onSelectTicker={onSelectTicker}
        onExplore={(tickers) =>
          onExplore({
            kind: "comparison",
            key: "romanian-all",
            label: "Romanian Listed (BVB)",
            description: `${tickers.length} BET-index names`,
            emoji: "🇷🇴",
            tickers,
          })
        }
      />

      {/* ── Today's movers ─────────────────────────────────────────── */}
      {hasAnyMovers && (
        <section
          data-testid="markets-movers"
          className="rounded-3xl border border-rule bg-surface overflow-hidden"
        >
          <header className="px-5 sm:px-6 pt-4 pb-2 flex items-baseline justify-between gap-3">
            <h2 className="font-serif text-[16px] text-ink tracking-[-0.005em]">
              Today's movers
            </h2>
            <span className="text-[11px] text-ink-mute">
              By day-over-day price change
            </span>
          </header>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-rule/30">
            <MoverColumn
              title="Top gainers"
              tone="positive"
              rows={gainers}
              onSelect={onSelectTicker}
            />
            <MoverColumn
              title="Top losers"
              tone="negative"
              rows={losers}
              onSelect={onSelectTicker}
            />
          </div>
        </section>
      )}

      {/* ── Explore by theme ───────────────────────────────────────── */}
      <section
        data-testid="markets-themes"
        className="rounded-3xl border border-rule bg-surface overflow-hidden"
      >
        <header className="px-5 sm:px-6 pt-4 pb-3">
          <h2 className="font-serif text-[16px] text-ink tracking-[-0.005em]">
            Explore by theme
          </h2>
        </header>
        <ul className="divide-y divide-rule/40">
          {THEMES.map((t) => {
            const tickers = themeRows.get(t.key) ?? [];
            const count = tickers.length;
            return (
              <ThemeRow
                key={t.key}
                emoji={t.emoji}
                label={t.label}
                description={t.description}
                count={count}
                disabled={count === 0}
                onClick={() =>
                  onExplore({
                    kind: "theme",
                    key: t.key,
                    label: t.label,
                    description: t.description,
                    emoji: t.emoji,
                    tickers,
                  })
                }
                testId={`theme-${t.key}`}
              />
            );
          })}
        </ul>
      </section>

      {/* ── Sectors ─────────────────────────────────────────────────── */}
      <section
        data-testid="markets-sectors"
        className="rounded-3xl border border-rule bg-surface overflow-hidden"
      >
        <header className="px-5 sm:px-6 pt-4 pb-3">
          <h2 className="font-serif text-[16px] text-ink tracking-[-0.005em]">
            Sectors
          </h2>
        </header>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-rule/30">
          {UNIVERSE_SECTORS.map((s) => {
            const tickers = sectorRows.get(s) ?? [];
            const count = tickers.length;
            if (count === 0) return null;
            return (
              <SectorTile
                key={s}
                label={s}
                count={count}
                onClick={() =>
                  onExplore({
                    kind: "sector",
                    key: s,
                    label: s,
                    tickers,
                  })
                }
                testId={`sector-tile-${s.toLowerCase().replace(/\s+/g, "-")}`}
              />
            );
          })}
        </div>
      </section>

      {/* ── Featured comparisons ────────────────────────────────────── */}
      <section
        data-testid="markets-comparisons"
        className="rounded-3xl border border-rule bg-surface overflow-hidden"
      >
        <header className="px-5 sm:px-6 pt-4 pb-3 flex items-baseline justify-between gap-3">
          <h2 className="font-serif text-[16px] text-ink tracking-[-0.005em]">
            Featured comparisons
          </h2>
          <span className="text-[11px] text-ink-mute">
            Curated peer groups · click to compare
          </span>
        </header>
        <ul className="divide-y divide-rule/40">
          {comparisonRows.map((c) => {
            if (c.tickers.length === 0) return null;
            return (
              <ThemeRow
                key={c.key}
                emoji={c.emoji}
                label={c.label}
                description={c.description}
                count={c.tickers.length}
                onClick={() =>
                  onExplore({
                    kind: "comparison",
                    key: c.key,
                    label: c.label,
                    description: c.description,
                    emoji: c.emoji,
                    tickers: c.tickers,
                  })
                }
                testId={`comparison-${c.key}`}
              />
            );
          })}
        </ul>
      </section>

      {/* ── Browse all escape hatch ─────────────────────────────────── */}
      <div className="text-center">
        <button
          type="button"
          onClick={() =>
            onExplore({
              kind: "all",
              label: "Browse all companies",
              description: `${rows.length} companies across the universe`,
            })
          }
          data-testid="browse-all-btn"
          className="
            inline-flex items-center gap-2 h-10 px-5 rounded-full
            border border-rule bg-surface text-[13px] font-medium text-ink-soft
            hover:text-ink hover:bg-bg-2 transition-colors
          "
        >
          <Search size={13} strokeWidth={1.75} />
          Browse all {rows.length} companies
          <ChevronRight size={13} strokeWidth={2} />
        </button>
        <p className="text-[11px] text-ink-mute mt-2">
          Or jump straight to a ticker with the search bar above
        </p>
      </div>
    </div>
  );
}

// ── Mover column (gainers / losers) ──────────────────────────────────────

function MoverColumn({
  title,
  tone,
  rows,
  onSelect,
}: {
  title: string;
  tone: "positive" | "negative";
  rows: PublicCompanyFinancialSnapshot[];
  onSelect: (ticker: string) => void;
}) {
  if (rows.length === 0) return null;
  const Icon = tone === "positive" ? TrendingUp : TrendingDown;
  const toneCls =
    tone === "positive"
      ? "text-emerald-700 dark:text-emerald-300"
      : "text-red-700 dark:text-red-300";
  return (
    <div className="bg-surface">
      <header className="px-5 sm:px-6 py-2.5 flex items-center gap-2 border-b border-rule/40">
        <Icon size={13} strokeWidth={2} className={toneCls} />
        <span className="text-[11.5px] uppercase tracking-[0.08em] text-ink-mute font-semibold">
          {title}
        </span>
      </header>
      <ul>
        {rows.map((r) => (
          <li key={r.ticker}>
            <button
              type="button"
              onClick={() => onSelect(r.ticker)}
              data-testid={`mover-${r.ticker}`}
              className="
                w-full flex items-center gap-3 px-5 sm:px-6 py-2.5
                hover:bg-bg-2/40 transition-colors text-left
              "
            >
              <CompanyLogo ticker={r.ticker} size={28} />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono font-semibold text-[12.5px] text-ink tabular-nums">
                    {r.ticker}
                  </span>
                  <span
                    className="text-[12px] text-ink-soft truncate"
                    title={r.companyName}
                  >
                    {r.companyName}
                  </span>
                </div>
              </div>
              <div className="flex flex-col items-end shrink-0">
                <span className="text-[12.5px] tabular-nums text-ink-soft">
                  {fmtUsdPrice(r.price, r.currency)}
                </span>
                <span
                  className={`text-[11.5px] tabular-nums font-medium ${toneCls}`}
                >
                  {fmtSignedPct(r.priceChangePct)}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Theme / comparison row (full-width clickable card) ───────────────────

function ThemeRow({
  emoji,
  label,
  description,
  count,
  disabled = false,
  onClick,
  testId,
}: {
  emoji: string;
  label: string;
  description: string;
  count: number;
  disabled?: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        data-testid={testId}
        className={`
          w-full flex items-center gap-4 px-5 sm:px-6 py-3.5
          transition-colors text-left
          ${disabled
            ? "opacity-40 cursor-not-allowed"
            : "hover:bg-bg-2/40 cursor-pointer"
          }
        `}
      >
        <span className="text-[22px] leading-none shrink-0">{emoji}</span>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold text-ink leading-tight">
            {label}
          </div>
          <div className="text-[11.5px] text-ink-mute mt-0.5 leading-relaxed">
            {description}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 text-ink-soft">
          <span className="text-[12px] tabular-nums">
            {count} {count === 1 ? "company" : "companies"}
          </span>
          <ChevronRight size={14} strokeWidth={2} className="text-ink-mute" />
        </div>
      </button>
    </li>
  );
}

// ── Sector tile (compact, 2-column grid) ─────────────────────────────────

function SectorTile({
  label,
  count,
  onClick,
  testId,
}: {
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
      className="
        flex items-center justify-between gap-3
        px-5 sm:px-6 py-3
        bg-surface hover:bg-bg-2/40 transition-colors
        group
      "
    >
      <span className="text-[13px] text-ink font-medium">{label}</span>
      <span className="inline-flex items-center gap-1.5 text-ink-mute">
        <span className="text-[12px] tabular-nums">{count}</span>
        <ChevronRight
          size={12}
          strokeWidth={2}
          className="text-ink-mute/60 group-hover:text-ink-mute group-hover:translate-x-0.5 transition-all"
        />
      </span>
    </button>
  );
}

// ── Format helpers ───────────────────────────────────────────────────────

function fmtUsdPrice(value: number | null | undefined, currency: string): string {
  if (value == null || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function fmtSignedPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}
