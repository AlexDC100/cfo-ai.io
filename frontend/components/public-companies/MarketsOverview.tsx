// MarketsOverview — Layer 1 of the public-companies redesign.
//
// 2026-05-25 — replaces the 200-row wall of rows that used to dominate
// the page. Users now land on a magazine-style overview:
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ Peer-pair pill     (CFH ↔ Scandia — a single pill, not a card) │
//   │ Filter pills       (Movers / Themes / Sectors / Featured       │
//   │                     comparisons — bare wrap-flow groups, all    │
//   │                     pills always visible; clicking toggles the  │
//   │                     grid filter)                                │
//   │ Romanian Listed (BVB) — logo grid: every loaded firm as a       │
//   │                     logo tile, ordered by data completeness,     │
//   │                     paged with left/right arrows (CompanyGrid;   │
//   │                     the older row-list RomanianListedCard was    │
//   │                     removed 2026-07-24 — one BVB view, not two;  │
//   │                     top gainer/loser tiles carry a price sleeve; │
//   │                     the separate "Today's movers" list was       │
//   │                     removed 2026-07-24 as redundant with those)  │
//   └──────────────────────────────────────────────────────────────┘
//
// Filter pills narrow the company grid IN PLACE (the old Layer-2
// "Market universe" drill-down table was removed 2026-07-24). Typing in
// the search panel above this component is the other way to reach a
// specific company.
//
// Everything here is derived client-side from the already-loaded
// universe payload — no new backend endpoints. Themes are computed
// from absolute thresholds (Mega-caps = marketCap ≥ $200B, etc.) so
// any universe row can be tagged into a theme without a server pass.
// Featured comparisons are hardcoded ticker lists; tickers missing
// from the universe are auto-pruned so a comparison card never
// promises a row it can't deliver.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { TrendingUp, TrendingDown, ChevronLeft, ChevronRight, Info, Sparkles } from "lucide-react";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import { UNIVERSE_SECTORS } from "@/lib/publicCompanyUniverse";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CompanyLogo } from "./CompanyLogo";
import { useWorkspaceName } from "@/lib/workspaceName";
import { useActivePeriod } from "@/lib/activePeriod";

/** An active filter on the company grid — set by clicking an Explore
 *  pill (toggled off by clicking the same pill again or the ✕ chip in
 *  the grid header), or pushed in from outside via `drillFilter`
 *  (Risk Radar category drill). */
export interface GridFilter {
  /** Unique across all pill groups (prefixed: theme-/sector-/comparison-/drill-). */
  key: string;
  label: string;
  tickers: string[];
}

interface Props {
  rows: PublicCompanyFinancialSnapshot[];
  onSelectTicker: (ticker: string) => void;
  /** Externally-requested grid filter (e.g. Risk Radar drill). Applied
   *  whenever the reference changes; the user can still clear it. */
  drillFilter?: GridFilter | null;
  /** Active search (from CompanySearchPanel, owned by the page) — the
   *  grid narrows to its tickers and a selected "Search" pill renders
   *  first in the filter list; toggling the pill off clears the search
   *  via onClearSearch. */
  searchFilter?: GridFilter | null;
  onClearSearch?: () => void;
}

// ── Theme definitions ────────────────────────────────────────────────────
// Each theme is a label + predicate. Predicates run against a snapshot
// and decide whether the row qualifies. The Markets-overview computes
// the set of qualifying tickers per theme at render time so the card
// counts are always accurate to the loaded universe.

interface ThemeDef {
  key: string;
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
    label: "Mega-caps",
    description: ">$200B market cap · The largest businesses on the market",
    predicate: (r) => (r.marketCap ?? 0) >= 200_000_000_000,
  },
  {
    key: "quality-operators",
    label: "Quality operators",
    description: "EBITDA >25% · Net margin >12% · ROE >20% · Best-in-class businesses",
    predicate: (r) =>
      (r.ebitdaMargin ?? 0) >= 25
      && (r.netMargin ?? 0) >= 12
      && (r.roe ?? 0) >= 20,
  },
  {
    key: "cash-returners",
    label: "Cash returners",
    description: "FCF yield >5% · Strong cash generation · Funds dividends + buybacks",
    predicate: (r) => (r.fcfYield ?? 0) >= 5,
  },
  {
    key: "value-plays",
    label: "Value plays",
    description: "P/E < 15 · Profitable · Looking cheap",
    predicate: (r) =>
      (r.peRatio ?? 0) > 0 && (r.peRatio ?? Infinity) < 15 && (r.netMargin ?? 0) > 0,
  },
  {
    key: "distressed",
    label: "Distressed",
    description: "Negative EBITDA · Refinancing pressure",
    predicate: (r) => r.ebitdaMargin != null && r.ebitdaMargin < 0,
  },
];

// Featured comparisons (curated peer-group pills) were removed
// 2026-07-24 — recoverable from git history if the concept returns.

// ── Featured peer pairing ────────────────────────────────────────────────
// Hardcoded "your private company ↔ this BVB-listed peer" anchor. Moved
// here from RomanianListedCard 2026-07-24 (was a highlighted callout box
// inside that card; now a single pill between the search bar and the
// company grid). Answers the question users arrive at the Markets page
// with: "how do I compare against listed names in my sector?"

interface PeerPair {
  /** Anchor ticker on BVB. */
  bvbTicker: string;
  /** Fallback customer-side label, used only when no workspace name /
   *  loaded period is available (signed-out, nothing uploaded). */
  privateLabel: string;
  /** Fallback turnover (RON) + period for the same no-data case. */
  privateRevenue: number;
  privatePeriod: string;
  /** Category-pill text on the private tile. */
  privateCategory: string;
  /** Section caption — templated with the resolved private-company name
   *  and its compact revenue readout so the copy tracks the user's own
   *  figures, not the calibration case's. */
  rationale: (privateName: string, revenueShort: string) => string;
}

const FEATURED_PEER_PAIRS: ReadonlyArray<PeerPair> = [
  {
    bvbTicker: "CFH",
    privateLabel: "Scandia Food",
    privateRevenue: 413_727_560, // FY2025 net turnover (calibration case)
    privatePeriod: "FY2025",
    privateCategory: "Food Processing — Meat",
    rationale: (name, rev) =>
      `Both are Romanian meat processors. Comparable scale (CFH ~RON 1.2B turnover · ${name} ~${rev}). Closer peer than any US name.`,
  },
];

// ── Component ────────────────────────────────────────────────────────────

export function MarketsOverview({
  rows,
  onSelectTicker,
  drillFilter,
  searchFilter,
  onClearSearch,
}: Props) {
  // ── Active grid filters — Explore pills toggle membership in this
  //    list (multi-select since 2026-07-24; the grid shows the UNION of
  //    the selected categories' tickers). ──
  const [gridFilters, setGridFilters] = useState<GridFilter[]>([]);

  const toggleGridFilter = useCallback((f: GridFilter) => {
    setGridFilters((cur) =>
      cur.some((g) => g.key === f.key)
        ? cur.filter((g) => g.key !== f.key)
        : [...cur, f],
    );
  }, []);

  // External drill (Risk Radar) — replaces the selection whenever a new
  // drill arrives.
  useEffect(() => {
    if (drillFilter) setGridFilters([drillFilter]);
  }, [drillFilter]);

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

  // ── Pill items for the Explore grid — built as plain arrays (not
  //    JSX) so PillGrid can paginate them. Clicking a pill toggles the
  //    company-grid filter below (selected = filter currently active). ──
  const themeItems: PillItem[] = useMemo(
    () =>
      THEMES.map((t) => {
        const tickers = themeRows.get(t.key) ?? [];
        const count = tickers.length;
        const key = `theme-${t.key}`;
        return {
          label: t.label,
          description: t.description,
          count,
          disabled: count === 0,
          selected: gridFilters.some((f) => f.key === key),
          onClick: () => toggleGridFilter({ key, label: t.label, tickers }),
          testId: `theme-${t.key}`,
        };
      }),
    [themeRows, gridFilters, toggleGridFilter],
  );

  const sectorItems: PillItem[] = useMemo(
    () =>
      UNIVERSE_SECTORS.filter((s) => (sectorRows.get(s) ?? []).length > 0).map((s) => {
        const tickers = sectorRows.get(s) ?? [];
        const key = `sector-${s}`;
        return {
          label: s,
          count: tickers.length,
          selected: gridFilters.some((f) => f.key === key),
          onClick: () => toggleGridFilter({ key, label: s, tickers }),
          testId: `sector-tile-${s.toLowerCase().replace(/\s+/g, "-")}`,
        };
      }),
    [sectorRows, gridFilters, toggleGridFilter],
  );

  // ── Grid rows — narrowed to the active filter, then ordered by data
  //    completeness so the first page shows the best-covered firms and
  //    "data pending" rows sink to the back. Sort is stable, so rows
  //    with equal coverage keep their upstream (BVB-preferred) order. ──
  const gridRows = useMemo(() => {
    let subset = [...rows];
    // Search narrows first (intersection) — the grid shows what the user
    // searched, further scoped by any selected category pills.
    if (searchFilter) {
      const hit = new Set(searchFilter.tickers);
      subset = subset.filter((r) => hit.has(r.ticker));
      // Preserve the search's relevance ranking (best match first)
      // instead of the coverage sort used for browsing.
      const rank = new Map(searchFilter.tickers.map((t, i) => [t, i] as const));
      subset.sort((a, b) => (rank.get(a.ticker) ?? 0) - (rank.get(b.ticker) ?? 0));
    }
    if (gridFilters.length) {
      const wanted = new Set(gridFilters.flatMap((f) => f.tickers));
      subset = subset.filter((r) => wanted.has(r.ticker));
    }
    if (!searchFilter) {
      subset.sort((a, b) => snapshotCoverage(b) - snapshotCoverage(a));
    }
    return subset;
  }, [rows, gridFilters, searchFilter]);

  // ── Mover direction per ticker — tiles of today's top gainers/losers
  //    carry a price+change sleeve at the bottom. ──
  const moverDirs = useMemo(() => {
    const m = new Map<string, "up" | "down">();
    for (const r of gainers) m.set(r.ticker, "up");
    for (const r of losers) m.set(r.ticker, "down");
    return m;
  }, [gainers, losers]);

  // ── Mover filter pills — Top gainers / Top losers as grid filters.
  //    Empty in demo/static mode (no live priceChangePct), in which
  //    case the whole group hides rather than showing two dead pills. ──
  const moverItems: PillItem[] = useMemo(() => {
    const items: PillItem[] = [];
    if (gainers.length > 0) {
      const key = "movers-gainers";
      items.push({
        label: "Top gainers",
        description: "Largest day-over-day price gains among live-quoted companies",
        count: gainers.length,
        selected: gridFilters.some((f) => f.key === key),
        onClick: () =>
          toggleGridFilter({
            key,
            label: "Top gainers",
            tickers: gainers.map((r) => r.ticker),
          }),
        testId: "mover-pill-gainers",
      });
    }
    if (losers.length > 0) {
      const key = "movers-losers";
      items.push({
        label: "Top losers",
        description: "Largest day-over-day price drops among live-quoted companies",
        count: losers.length,
        selected: gridFilters.some((f) => f.key === key),
        onClick: () =>
          toggleGridFilter({
            key,
            label: "Top losers",
            tickers: losers.map((r) => r.ticker),
          }),
        testId: "mover-pill-losers",
      });
    }
    return items;
  }, [gainers, losers, gridFilters, toggleGridFilter]);

  return (
    <div data-testid="markets-overview" className="space-y-6">
      {/* PeerSection (the user's company vs. its BVB peer) no longer
          renders here — the page hosts it beside its header (2026-07-24).
          It's exported below for that. */}

      {/* ── Romanian Listed (BVB) — logo grid ─────────────────────────
            Added 2026-07-24: a fixed grid of every company in `rows`,
            each tile a logo + ticker + name, paged with left/right
            arrows since the full universe never fits on one screen.
            Clicking a tile opens the same StockDetailDrawer as every
            other entry point. The old row-list version of this section
            (RomanianListedCard, with its own "BVB · RON / Romanian
            Listed (BVB)" header) was removed 2026-07-24 — this grid is
            now the only BVB browsing surface, so there's one "Romanian
            Listed (BVB)" section, not two. `key` remounts the grid on
            filter change so paging resets to page 1. */}
      <CompanyGrid
        key={
          [searchFilter?.key, ...gridFilters.map((f) => f.key)]
            .filter(Boolean)
            .join("+") || "all"
        }
        rows={gridRows}
        onSelect={onSelectTicker}
        moverDirs={moverDirs}
        filters={
          /* ── Filters — one flat list of every pill (movers + themes +
              sectors; group labels dropped 2026-07-24, featured
              comparisons removed the same day). auto-fill grid columns
              give every pill the SAME width so sizes don't vary with
              label length; long labels marquee on hover. Multi-select:
              clicking toggles membership in the grid filter. */
          <div data-testid="markets-explore">
            {/* Section title (2026-07-26 per operator) — the pill field had
                none, so it read as loose chrome rather than a filter list. */}
            <div className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-mute mb-2">
              Filter the universe
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-1.5">
            {/* Active search renders as a synthetic selected pill first
                in the list — clicking it clears the search. */}
            {searchFilter && (
              <Pill
                label={searchFilter.label}
                description="Companies matching your search — click to clear"
                count={searchFilter.tickers.length}
                selected
                onClick={() => onClearSearch?.()}
                testId="search-filter-pill"
              />
            )}
            {[...moverItems, ...themeItems, ...sectorItems].map((it) => (
              <Pill key={it.testId} {...it} />
            ))}
            </div>
          </div>
        }
      />

      {/* Today's movers section removed 2026-07-24 — gainers/losers now
          surface as the "Movers" filter pills above the grid plus the
          price+change sleeve on their tiles, so a separate list was
          redundant. */}
    </div>
  );
}

// ── Peer section (CFH ↔ Scandia) ─────────────────────────────────────────
// Replaced the single "Your real peer" pill 2026-07-24: the user's own
// company and its BVB-listed peer now render side by side as two tiles
// in the SAME style as the company grid (CompanyTile for the listed
// side; a hand-built twin for the private side, since a private company
// has no universe row to feed CompanyTile). Renders nothing if the
// anchor ticker (CFH) isn't in the loaded universe — same fail-quiet
// convention the pill had.

export function PeerSection({
  rows,
  onSelect,
  moverDirs,
}: {
  rows: PublicCompanyFinancialSnapshot[];
  onSelect: (ticker: string) => void;
  moverDirs?: Map<string, "up" | "down">;
}) {
  const active = useMemo(() => {
    const byTicker = new Map(
      rows.filter((r) => r.exchange === "BVB").map((r) => [r.ticker, r] as const),
    );
    for (const p of FEATURED_PEER_PAIRS) {
      const row = byTicker.get(p.bvbTicker);
      if (row) return { pair: p, row };
    }
    return null;
  }, [rows]);

  // The private side is the USER'S company: workspace name + the loaded
  // period's own revenue/period label. The pair's hardcoded calibration
  // figures are only the fallback for signed-out / nothing-uploaded.
  const workspaceName = useWorkspaceName();
  const period = useActivePeriod();

  if (!active) return null;
  // Only render once the user has a REAL uploaded trial balance loaded —
  // without one there is no "your company" side to pair, and showing the
  // hardcoded calibration fallback reads as someone else's data.
  if (!(period.isLoaded && period.source === "upload" && period.statements)) {
    return null;
  }
  const { pair, row } = active;

  const privateName =
    workspaceName || period.statements?.companyName || pair.privateLabel;
  const privateRevenue =
    period.statements?.incomeStatement.revenue ?? pair.privateRevenue;
  const privatePeriodLabel = period.statements?.periodLabel ?? pair.privatePeriod;
  // Letter-avatar mark — first word of the name, same all-caps style the
  // listed tiles' ticker fallback uses.
  const privateMark = (privateName.split(/\s+/)[0] || privateName).toUpperCase();

  return (
    // ask-ai-anim-fill = the same animated teal-gradient background the
    // "Ask CFO AI" pill in the top header uses (sweeping brand tint,
    // static border on the element; see index.css).
    // Card treatment ported from "Start from the official template"
    // (2026-07-26 per operator): brand left sleeve, oversized faint mark
    // clipped bottom-left, serif title, dense description. The animated
    // gradient fill stays — it's what marks this as the AI-picked peer.
    <section
      data-testid="markets-peer-section"
      className="relative flex overflow-hidden w-full max-w-[860px] rounded-3xl border border-brand/40"
    >
      <div className="w-2 shrink-0 bg-brand" />
      <div className="ask-ai-anim-fill [--af-band:360px] [--af-shift:2036.47px] [animation-duration:28.8s] [--af-a1:0.14] [--af-a2:0.06] relative flex-1 min-w-0 px-4 sm:px-5 py-4">
        {/* Oversized decorative mark — bottom-left, clipped by the card. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-16 -left-10 text-brand opacity-[0.08]"
        >
          <Sparkles size={240} strokeWidth={1} />
        </div>

        {/* Header — the original callout's title + rationale (restored
            2026-07-24, was a hover tooltip in the pill era). */}
        <div className="relative mb-3">
          <h3 className="font-serif text-[24px] text-ink leading-tight tracking-[-0.01em]">
            Your real peer · {privateName} vs. {row.companyName}
          </h3>
          <p className="mt-1.5 text-[12.5px] text-ink-soft leading-relaxed">
            {pair.rationale(privateName, fmtRonShort(privateRevenue))}
          </p>
        </div>
      {/* Tiles centred with a "vs" separator between them. */}
      <div className="flex items-center justify-center gap-3 sm:gap-4">
        {/* Private-company tile — same shell as CompanyTile, but built
            by hand: no universe row exists for a private company, so
            the ticker-text avatar (via CompanyLogo's fallback) is the
            background and the figures come from the user's loaded
            period (pair fallback when nothing is loaded). Not
            clickable — there's no drawer for a private company. */}
        <div
          data-testid="peer-tile-private"
          className="
            group relative w-[200px] sm:w-[220px] aspect-[4/3]
            rounded-2xl border border-rule overflow-hidden
            text-left
          "
        >
          <CompanyLogo ticker={privateMark} fill />
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-black/0" />
          <div
            className="
              absolute top-2 right-2 max-w-[80%] rounded-full border border-rule
              bg-surface px-3 py-1
              text-[11px] font-medium text-ink
            "
          >
            <HoverMarquee text={pair.privateCategory} />
          </div>
          <div className="absolute inset-x-0 bottom-0 p-2.5 min-w-0">
            <div className="font-mono font-semibold text-[12px] text-white tabular-nums">
              {privateMark}
            </div>
            <div className="text-[10.5px] text-white/85 hover-marquee">
              <span>{privateName}</span>
            </div>
            <div className="mt-0.5 text-[10px] tabular-nums leading-tight">
              <span className="text-white font-medium">
                {fmtRonShort(privateRevenue)}
              </span>
              <span className="text-white/60"> · {privatePeriodLabel}</span>
            </div>
          </div>
        </div>

        {/* Separator text between the two companies. */}
        <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-mute font-semibold">
          vs
        </span>

        {/* Listed peer — exactly the grid's tile. Width-capped wrapper
            since CompanyTile is fluid (fills its grid cell in the main
            grid). */}
        <div className="w-[200px] sm:w-[220px]">
          <CompanyTile
            row={row}
            onSelect={() => onSelect(row.ticker)}
            moverDir={moverDirs?.get(row.ticker)}
          />
        </div>
      </div>
      {/* Compare CTA — bottom-right, styled like the search panel's
          Search button (flat bg-brand, no arrow). */}
      <div className="flex justify-end mt-3">
        <button
          type="button"
          onClick={() => onSelect(row.ticker)}
          data-testid={`peer-pair-cta-${row.ticker}`}
          className="
            inline-flex items-center justify-center
            h-12 px-5 rounded-xl
            bg-brand text-paper
            text-[13.5px] font-medium
            hover:bg-brand-dark
            transition-colors
          "
        >
          Compare
        </button>
      </div>
      </div>
    </section>
  );
}

// ── Data-sources info button ("i" in the grid header) ────────────────────
// Click-to-open popover (not a hover tooltip — several lines of content,
// and it should be reachable on touch) explaining where every piece of
// data on this surface comes from. Sits beside the pagination arrows.

export function DataSourcesInfoButton() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="About the data sources"
          data-testid="company-grid-sources-info"
          className="
            h-7 w-7 flex items-center justify-center rounded-full border border-rule
            text-ink-soft transition-colors
            hover:bg-bg-2 hover:text-ink
          "
        >
          <Info size={13} strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-[320px] p-4">
        <div className="text-[11px] uppercase tracking-[0.08em] text-ink-mute font-semibold mb-2">
          Data sources
        </div>
        <ul className="space-y-2.5 text-[12px] text-ink-soft leading-relaxed">
          <li>
            <span className="font-medium text-ink">Financial figures</span> —
            FY2024 issuer disclosures (annual reports and preliminary results)
            plus statutory filings from{" "}
            <a
              href="https://www.anaf.ro"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              ANAF
            </a>{" "}
            Bilanț for Romanian-incorporated companies. Rows marked{" "}
            <span className="font-mono text-[10.5px]">FY2024 · ANAF</span> take
            their P&amp;L from the statutory filing. All values in RON.
          </li>
          <li>
            <span className="font-medium text-ink">Prices &amp; day change</span> —
            live{" "}
            <a
              href="https://www.bvb.ro"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              Bucharest Stock Exchange
            </a>{" "}
            quotes, refreshed every few minutes while the data engine is
            running. Bundled figures never include prices, so a stale quote is
            never shown.
          </li>
          <li>
            <span className="font-medium text-ink">Logos</span> — official
            brand assets from company websites and press kits,{" "}
            <a
              href="https://commons.wikimedia.org"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              Wikimedia Commons
            </a>
            , and{" "}
            <a
              href="https://www.bvb.ro"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              BVB
            </a>{" "}
            issuer profiles.
          </li>
          <li>
            <span className="font-medium text-ink">Coverage</span> — companies
            whose statutory figures aren't loaded yet show{" "}
            <span className="italic">data pending</span> rather than
            estimates. Nothing on this surface is modeled or inferred.
          </li>
        </ul>
      </PopoverContent>
    </Popover>
  );
}

// ── Measured hover-marquee ────────────────────────────────────────────────
// Sibling of the pure-CSS `.hover-marquee` utility (index.css), for
// shrink-to-fit elements: the CSS version relies on `container-type:
// inline-size`, whose size containment collapses a width-by-content
// element (like the category pill) to zero width. This variant sizes
// naturally — the wrapper fits its text up to whatever max-width the
// caller sets — and measures the actual overflow in px, sliding by
// exactly that much while the surrounding `.group` is hovered. Text
// that fits measures 0 overflow and never moves.

function HoverMarquee({ text }: { text: string }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    const measure = () =>
      setShift(Math.max(0, inner.scrollWidth - outer.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [text]);

  // Scroll duration scales with the overflow distance (~25px/s, floor
  // 3s) so long labels don't whip across; the keyframed animation
  // bounces between the two ends (alternate) for as long as the hover
  // lasts, pausing briefly at each end (see marquee-bounce keyframes in
  // index.css). Text that fits has shift 0 — animation is a no-op.
  const durationS = Math.max(3, shift / 25);

  return (
    <div
      ref={outerRef}
      className="overflow-hidden whitespace-nowrap text-ellipsis group-hover:[text-overflow:clip]"
    >
      <span
        ref={innerRef}
        style={
          {
            "--mq-shift": `${-shift}px`,
            "--mq-duration": `${durationS}s`,
          } as CSSProperties
        }
        className="inline-block group-hover:[animation:marquee-bounce_var(--mq-duration)_ease-in-out_infinite_alternate]"
      >
        {text}
      </span>
    </div>
  );
}

// ── Data-coverage score (grid ordering) ───────────────────────────────────
// Counts how many of the headline financial fields a snapshot actually
// carries. Used only to ORDER the company grid (fullest rows first) —
// never displayed, never used to filter anything out.

const COVERAGE_FIELDS = [
  "marketCap",
  "revenue",
  "netIncome",
  "netMargin",
  "ebitda",
  "equity",
  "cash",
  "peRatio",
  "roe",
  "roa",
  "dividendYield",
  "debtToEquity",
] as const;

function snapshotCoverage(r: PublicCompanyFinancialSnapshot): number {
  let n = 0;
  for (const f of COVERAGE_FIELDS) {
    const v = (r as Record<string, unknown>)[f];
    if (typeof v === "number" && Number.isFinite(v)) n += 1;
  }
  return n;
}

// ── Company grid (logo tiles + arrow paging) ──────────────────────────────
// The literal "browse every firm" surface — a fixed grid of logo tiles,
// paged with left/right arrows. Distinct from PillGrid below: pills page
// through *categories* (themes/sectors/comparisons), this pages through
// the *companies themselves*. Order follows `rows` as given by the parent
// (already BVB-preferred / live-first upstream) — no re-sorting here.

// 4 rows tall at the widest breakpoint (lg:grid-cols-6 × 4 = 24). Narrower
// breakpoints have fewer columns so the same page reflows into more rows —
// a single page size can't hold "4 rows" exactly at every column count.
const COMPANIES_PER_PAGE = 24;

function CompanyGrid({
  rows,
  onSelect,
  moverDirs,
  filters,
}: {
  rows: PublicCompanyFinancialSnapshot[];
  onSelect: (ticker: string) => void;
  /** Tickers among today's top gainers ("up") / losers ("down") — their
   *  tiles get a price+change sleeve at the bottom. */
  moverDirs?: Map<string, "up" | "down">;
  /** Filter pills rendered between the title/subtitle header and the
   *  tiles. */
  filters?: ReactNode;
}) {
  const [page, setPage] = useState(0);
  if (rows.length === 0) return null;

  const pageCount = Math.max(1, Math.ceil(rows.length / COMPANIES_PER_PAGE));
  const current = Math.min(page, pageCount - 1);
  const start = current * COMPANIES_PER_PAGE;
  const pageRows = rows.slice(start, start + COMPANIES_PER_PAGE);
  const canPrev = current > 0;
  const canNext = current < pageCount - 1;

  return (
    // Bare section (2026-07-24) — the rounded-card wrapper (border +
    // bg-surface) was removed; the grid sits directly on the page like
    // the filter groups above it.
    <section data-testid="markets-company-grid">
      {/* Header removed entirely 2026-07-24 — the data-sources "i"
          button now sits beside the search button (CompanySearchPanel). */}
      {filters && <div className="pb-4">{filters}</div>}
      {/* Pager arrows flank the grid, vertically centred against it. */}
      <div className="flex items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={!canPrev}
          aria-label="Previous companies"
          data-testid="company-grid-prev"
          className="
            shrink-0 h-11 w-11 flex items-center justify-center rounded-full border border-rule
            text-ink-soft transition-colors
            hover:bg-bg-2 hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent
          "
        >
          <ChevronLeft size={20} strokeWidth={2} />
        </button>
        {/* key={current} remounts the page's tiles on prev/next so the
            fade-in entrance replays for each page swap. */}
        <div
          key={current}
          className="flex-1 min-w-0 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2 animate-fade-in"
        >
          {pageRows.map((r) => (
            <CompanyTile
              key={r.ticker}
              row={r}
              onSelect={() => onSelect(r.ticker)}
              moverDir={moverDirs?.get(r.ticker)}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          disabled={!canNext}
          aria-label="Next companies"
          data-testid="company-grid-next"
          className="
            shrink-0 h-11 w-11 flex items-center justify-center rounded-full border border-rule
            text-ink-soft transition-colors
            hover:bg-bg-2 hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent
          "
        >
          <ChevronRight size={20} strokeWidth={2} />
        </button>
      </div>
      {/* Range readout — centred beneath the grid. */}
      <div className="mt-3 text-center text-[11px] text-ink-mute tabular-nums">
        {start + 1}–{Math.min(start + COMPANIES_PER_PAGE, rows.length)} of {rows.length}
      </div>
    </section>
  );
}

// ── Company tile (shared by CompanyGrid and PeerSection) ─────────────────
// One tile = logo background + category pill + ticker/name/revenue stack
// + optional mover sleeve. Extracted from CompanyGrid 2026-07-24 so the
// peer section can render the peer company in exactly the same style.

function CompanyTile({
  row: r,
  onSelect,
  moverDir,
}: {
  row: PublicCompanyFinancialSnapshot;
  onSelect: () => void;
  moverDir?: "up" | "down";
}) {
  const displayTicker = r.ticker.replace(/\.BVB$/, "");
  const hasMoverSleeve =
    moverDir != null
    && typeof r.priceChangePct === "number"
    && Number.isFinite(r.priceChangePct);
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`company-grid-tile-${r.ticker}`}
      className="
        group relative block w-full aspect-[4/3] rounded-2xl border border-rule overflow-hidden
        text-left transition-all duration-200
        hover:border-rule-strong cursor-pointer
        has-[.logo-loaded]:hover:border-brand/50
        has-[.logo-loaded]:hover:shadow-[0_10px_28px_-10px_rgba(0,0,0,0.35)]
        has-[.logo-loaded]:hover:-translate-y-0.5
      "
    >
      {/* The logo IS the tile background (fill mode: 100% of the
          button; object-contain on a white/dark backdrop — the
          bundled BVB logos are mostly wide wordmarks, which
          object-cover would crop illegibly). Missing/failed
          logos read as the ticker-text colour avatar instead of
          a blank square. */}
      <CompanyLogo ticker={displayTicker} fill />
      {/* Scrim so the text stays legible over any logo. */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-black/0" />
      {/* Category pill — top-right corner of the tile, sized to
          its text (capped at 80% of the tile). Styled to match
          the filter pills above the grid (border-rule +
          bg-surface + ink text), just smaller so it fits a
          tile. Uses the measured HoverMarquee, NOT the CSS
          `.hover-marquee` utility — that one's size containment
          collapses a shrink-to-fit pill to zero width. */}
      {(r.sector || r.industry) && (
        <div
          className="
            absolute top-2 right-2 max-w-[80%] rounded-full border border-rule
            bg-surface/80 backdrop-blur-sm px-3 py-1
            text-[11px] font-medium text-ink
          "
        >
          <HoverMarquee
            text={`${r.sector ?? "—"}${r.industry ? ` · ${r.industry}` : ""}`}
          />
        </div>
      )}
      <div
        className={`absolute inset-x-0 p-2.5 min-w-0 ${
          hasMoverSleeve ? "bottom-7" : "bottom-0"
        }`}
      >
        <div className="font-mono font-semibold text-[12px] text-white tabular-nums">
          {displayTicker}
        </div>
        <div className="text-[10.5px] text-white/85 hover-marquee">
          <span>{r.companyName}</span>
        </div>
        {/* Same revenue readout as the right side of RomanianListedCard's
            BvbRow — "data pending" for rows without a hydrated snapshot. */}
        <div className="mt-0.5 text-[10px] tabular-nums leading-tight">
          {r.revenue == null ? (
            <span className="text-white/60 italic">data pending</span>
          ) : (
            <>
              <span className="text-white font-medium">{fmtRonShort(r.revenue)}</span>
              <span className="text-white/60"> · {r.latestPeriod ?? "FY2024"}</span>
            </>
          )}
        </div>
      </div>
      {/* Mover sleeve — only on tiles that are among today's top
          gainers/losers: trend icon + live price + day change,
          pinned as a solid strip across the tile bottom (the
          text stack above shifts up to make room). */}
      {hasMoverSleeve && (
        <div
          data-testid={`company-grid-mover-${r.ticker}`}
          className="
            absolute inset-x-0 bottom-0 h-7 px-2.5
            flex items-center gap-1.5
            bg-surface border-t border-rule
            text-[11px] tabular-nums
          "
        >
          {moverDir === "up" ? (
            <TrendingUp
              size={12}
              strokeWidth={2}
              className="shrink-0 text-[#2AA89B] dark:text-[#8FE3D9]"
            />
          ) : (
            <TrendingDown
              size={12}
              strokeWidth={2}
              className="shrink-0 text-red-700 dark:text-red-300"
            />
          )}
          <span className="text-ink truncate">
            {fmtUsdPrice(r.price, r.currency)}
          </span>
          <span
            className={`ml-auto shrink-0 font-medium ${
              moverDir === "up"
                ? "text-[#2AA89B] dark:text-[#8FE3D9]"
                : "text-red-700 dark:text-red-300"
            }`}
          >
            {fmtSignedPct(r.priceChangePct)}
          </span>
        </div>
      )}
    </button>
  );
}

// ── Pill items ───────────────────────────────────────────────────────────
// 2026-07-24: pills render as ONE flat wrap-flow list (no group labels;
// the earlier PillGroup / PillGrid wrappers are gone). Each pill
// stretches (flex-1) so every row fills the full available width.

interface PillItem {
  label: string;
  description?: string;
  count: number;
  disabled?: boolean;
  /** Filter currently applied to the company grid — brand-accent style. */
  selected?: boolean;
  onClick: () => void;
  testId: string;
}

// ── Pill (theme / sector / mover — one shared shape) ─────────────────────
// Sectors have no description (never did); themes + featured comparisons
// carry one, shown as a hover tooltip since the pill itself has no room
// for a paragraph.

function Pill({
  label,
  description,
  count,
  disabled = false,
  selected = false,
  onClick,
  testId,
}: PillItem) {
  const button = (
    // `group` scopes the HoverMarquee to THIS pill — hovering it
    // scrolls its own label (capped at 180px) without touching its
    // siblings.
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      aria-pressed={selected}
      className={`
        group flex w-full items-center justify-center gap-1.5 h-7 px-2.5 rounded-full border
        text-[11.5px] font-medium transition-colors
        ${disabled
          ? "opacity-40 cursor-not-allowed border-rule text-ink-mute"
          : selected
            ? "border-brand/60 bg-brand/15 text-ink hover:bg-brand/25 cursor-pointer"
            : "border-rule bg-surface text-ink hover:bg-bg-2 hover:border-rule-strong cursor-pointer"
        }
      `}
    >
      <span className="min-w-0 max-w-[150px]">
        <HoverMarquee text={label} />
      </span>
      <span className="text-[10px] text-ink-mute tabular-nums shrink-0">{count}</span>
    </button>
  );

  if (!description) return button;

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[240px] text-xs">
        {description}
      </TooltipContent>
    </Tooltip>
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

/** Compact RON formatting — same helper as RomanianListedCard's BvbRow,
 *  duplicated rather than imported since it's a 5-line local format
 *  function, not shared state. Keep the two in sync if the format
 *  convention changes. */
function fmtRonShort(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `RON ${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `RON ${(value / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `RON ${(value / 1e3).toFixed(0)}K`;
  return `RON ${value.toFixed(0)}`;
}
