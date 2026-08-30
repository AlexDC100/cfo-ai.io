// MarketsOverview — Layer 1 of the public-companies redesign.
//
// 2026-08-04 (PCI redesign) — the logo-tile grid became an information
// card grid (Koyfin / Simply-Wall-St clarity):
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ Filter chips  (smart screens + sectors, horizontal scroll on  │
//   │                mobile; zero-count screens hidden)             │
//   │ Company cards (monogram avatar + ticker/name + sector chip +  │
//   │                30-day sparkline + price/day change + market   │
//   │                cap + ONE standout metric per group leader;    │
//   │                compare checkboxes feed the sticky compare bar)│
//   │ Compare tray  (2-3 companies → side-by-side sheet, workspace  │
//   │                company optionally included)                   │
//   └──────────────────────────────────────────────────────────────┘
//
// Everything is derived client-side from the already-loaded universe
// payload — no new backend endpoints. Rows without statutory figures
// render as calm "processing" skeletons (never dead/empty cards) and
// sink below fully-populated rows via the coverage sort.
//
// Image logos are GONE on this surface (Google's favicon service mixed
// real marks with generic globes — see tickerLogos.ts history); every
// avatar is the deterministic ticker monogram (CompanyLogo
// variant="monogram") so the page reads as one system.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  TrendingUp,
  TrendingDown,
  ChevronLeft,
  ChevronRight,
  Info,
  Check,
} from "lucide-react";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import { UNIVERSE_SECTORS } from "@/lib/publicCompanyUniverse";
import { marketIdForSnapshot, type MarketEntry } from "@/lib/marketApi";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sparkline } from "@/components/dashboard/Sparkline";
import { Amount } from "@/components/instrument/Amount";
import { Chip as StateChip } from "@/components/instrument/Panel";
import { pickMagnitude } from "@/lib/amountFormat";
import { CompanyLogo } from "./CompanyLogo";
import { CompareTray } from "./CompareTray";
import {
  computeStandouts,
  fmtStandoutValue,
  isPendingRow,
  useCardSparkline,
  type Standout,
  type WorkspaceBenchMetrics,
} from "./pciData";
import "./pciI18n";
import "./marketI18n";

/** An active filter on the company grid — set by clicking a filter chip
 *  (toggled off by clicking the same chip again), or pushed in from
 *  outside via `drillFilter` (Risk Radar category drill). */
export interface GridFilter {
  /** Unique across all chip groups (prefixed: screen-/sector-/movers-/drill-). */
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
  /** Active search (from CompanySearchPanel, owned by the page). */
  searchFilter?: GridFilter | null;
  onClearSearch?: () => void;
  /** "Compania ta" metrics for the compare sheet — null when no real
   *  period is loaded. */
  workspace?: WorkspaceBenchMetrics | null;
  /** Market registry (2026-08-30, global-markets wave). Used only to
   *  label a card with the market it belongs to. */
  markets?: MarketEntry[];
  /** Render the market + currency chips on each card. The page sets this
   *  when the visible grid actually spans more than one market: on a
   *  single-market tab the page header already declares the market, and
   *  repeating it on every card is noise rather than information. */
  showMarketChips?: boolean;
}

// ── Smart screens ────────────────────────────────────────────────────────
// Thresholds (documented per the 2026-08-04 operator spec; calibrated so
// each screen is populated on the FY2024 BVB seed):
//   · value      — P/E strictly between 0 and 15 AND positive net margin:
//                  profitable and priced under ~15 years of earnings.
//   · distressed — EBITDA margin < 0: operating losses at the EBITDA
//                  line, i.e. refinancing pressure territory.
//   · quality    — EBITDA margin ≥ 25 pp AND net margin ≥ 12 pp AND
//                  ROE ≥ 20 pp: best-in-class operators on all three.
// Zero-count screens are hidden entirely (never a dead chip).

interface ScreenDef {
  key: string;
  labelKey: string;
  whyKey: string;
  predicate: (r: PublicCompanyFinancialSnapshot) => boolean;
}

const SCREENS: ReadonlyArray<ScreenDef> = [
  {
    key: "value",
    labelKey: "pci.filters.value",
    whyKey: "pci.filters.valueWhy",
    predicate: (r) =>
      (r.peRatio ?? 0) > 0 && (r.peRatio ?? Infinity) < 15 && (r.netMargin ?? 0) > 0,
  },
  {
    key: "distressed",
    labelKey: "pci.filters.distressed",
    whyKey: "pci.filters.distressedWhy",
    predicate: (r) => r.ebitdaMargin != null && r.ebitdaMargin < 0,
  },
  {
    key: "quality",
    labelKey: "pci.filters.quality",
    whyKey: "pci.filters.qualityWhy",
    predicate: (r) =>
      (r.ebitdaMargin ?? 0) >= 25 && (r.netMargin ?? 0) >= 12 && (r.roe ?? 0) >= 20,
  },
];

// ── Component ────────────────────────────────────────────────────────────

export function MarketsOverview({
  rows,
  onSelectTicker,
  drillFilter,
  searchFilter,
  onClearSearch,
  workspace,
  markets,
  showMarketChips = false,
}: Props) {
  const { t } = useTranslation();

  // ── Active grid filters — chips toggle membership (multi-select; the
  //    grid shows the UNION of the selected categories' tickers). ──
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

  // ── Today's movers — top 3 gainers + top 3 losers by priceChangePct.
  //    Rows without a live change are excluded; in demo/static mode the
  //    chips hide (fake movers are worse than none). ──
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

  // ── Screen + sector tallies ──
  const screenRows = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of SCREENS) {
      m.set(s.key, rows.filter(s.predicate).map((r) => r.ticker));
    }
    return m;
  }, [rows]);

  const sectorRows = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of rows) {
      const s = r.sector ?? "Unknown";
      if (!m.has(s)) m.set(s, []);
      m.get(s)!.push(r.ticker);
    }
    return m;
  }, [rows]);

  // ── Chip items ──
  const moverItems: ChipItem[] = useMemo(() => {
    const items: ChipItem[] = [];
    if (gainers.length > 0) {
      const key = "movers-gainers";
      items.push({
        label: t("pci.filters.gainers"),
        description: t("pci.filters.gainersWhy"),
        count: gainers.length,
        selected: gridFilters.some((f) => f.key === key),
        onClick: () =>
          toggleGridFilter({
            key,
            label: t("pci.filters.gainers"),
            tickers: gainers.map((r) => r.ticker),
          }),
        testId: "mover-pill-gainers",
      });
    }
    if (losers.length > 0) {
      const key = "movers-losers";
      items.push({
        label: t("pci.filters.losers"),
        description: t("pci.filters.losersWhy"),
        count: losers.length,
        selected: gridFilters.some((f) => f.key === key),
        onClick: () =>
          toggleGridFilter({
            key,
            label: t("pci.filters.losers"),
            tickers: losers.map((r) => r.ticker),
          }),
        testId: "mover-pill-losers",
      });
    }
    return items;
  }, [gainers, losers, gridFilters, toggleGridFilter, t]);

  const screenItems: ChipItem[] = useMemo(
    () =>
      SCREENS.flatMap((s) => {
        const tickers = screenRows.get(s.key) ?? [];
        if (tickers.length === 0) return []; // zero-count screens hidden
        const key = `screen-${s.key}`;
        return [{
          label: t(s.labelKey),
          description: t(s.whyKey),
          count: tickers.length,
          selected: gridFilters.some((f) => f.key === key),
          onClick: () => toggleGridFilter({ key, label: t(s.labelKey), tickers }),
          testId: `theme-${s.key}`,
        }];
      }),
    [screenRows, gridFilters, toggleGridFilter, t],
  );

  const sectorItems: ChipItem[] = useMemo(
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
  //    completeness so populated companies lead and "processing" rows
  //    sink to the back. ──
  const gridRows = useMemo(() => {
    let subset = [...rows];
    if (searchFilter) {
      const hit = new Set(searchFilter.tickers);
      subset = subset.filter((r) => hit.has(r.ticker));
      const rank = new Map(searchFilter.tickers.map((tk, i) => [tk, i] as const));
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

  // ── Standout metric per card — computed on the VISIBLE group (the
  //    filtered subset), so "highest margin" always means "in what you
  //    are looking at". Group leaders (rank ≤ 3) get the chip. ──
  const standouts = useMemo(() => computeStandouts(gridRows), [gridRows]);

  const moverDirs = useMemo(() => {
    const m = new Map<string, "up" | "down">();
    for (const r of gainers) m.set(r.ticker, "up");
    for (const r of losers) m.set(r.ticker, "down");
    return m;
  }, [gainers, losers]);

  // ── Compare mode — up to 3 tickers picked via card checkboxes. ──
  const [compareSel, setCompareSel] = useState<string[]>([]);
  const toggleCompare = useCallback((ticker: string) => {
    setCompareSel((cur) => {
      if (cur.includes(ticker)) return cur.filter((x) => x !== ticker);
      if (cur.length >= 3) return cur; // limit — tray shows the cap note
      return [...cur, ticker];
    });
  }, []);
  const compareRows = useMemo(
    () =>
      compareSel
        .map((tk) => rows.find((r) => r.ticker === tk))
        .filter((r): r is PublicCompanyFinancialSnapshot => !!r),
    [compareSel, rows],
  );

  return (
    <div data-testid="markets-overview" className="space-y-6">
      <CompanyGrid
        key={
          [searchFilter?.key, ...gridFilters.map((f) => f.key)]
            .filter(Boolean)
            .join("+") || "all"
        }
        rows={gridRows}
        onSelect={onSelectTicker}
        moverDirs={moverDirs}
        standouts={standouts}
        compareSel={compareSel}
        onToggleCompare={toggleCompare}
        markets={markets}
        showMarketChips={showMarketChips}
        filters={
          <div data-testid="markets-explore">
            <div className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-soft mb-2">
              {t("pci.filters.title")}
            </div>
            {/* One horizontal chip rail — scrolls inside its own overflow
                container on mobile (zero page-level overflow), wraps on
                sm+. Multi-select; counts on every chip. */}
            <div
              className="
                flex gap-1.5 overflow-x-auto pb-1 -mb-1
                sm:flex-wrap sm:overflow-visible sm:pb-0 sm:mb-0
                [scrollbar-width:none] [&::-webkit-scrollbar]:hidden
              "
            >
              {searchFilter && (
                <Chip
                  label={searchFilter.label}
                  description={t("pci.filters.searchPillDesc")}
                  count={searchFilter.tickers.length}
                  selected
                  onClick={() => onClearSearch?.()}
                  testId="search-filter-pill"
                />
              )}
              {[...moverItems, ...screenItems, ...sectorItems].map((it) => (
                <Chip key={it.testId} {...it} />
              ))}
            </div>
          </div>
        }
      />

      {/* Sticky compare bar + side-by-side sheet (bottom sheet on mobile). */}
      <CompareTray
        rows={compareRows}
        workspace={workspace ?? null}
        onRemove={(tk) => setCompareSel((cur) => cur.filter((x) => x !== tk))}
        onClear={() => setCompareSel([])}
        atLimit={compareSel.length >= 3}
      />
    </div>
  );
}

// ── Data-sources info button ("i" beside the search bar) ────────────────

export function DataSourcesInfoButton() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="About the data sources"
          data-testid="company-grid-sources-info"
          className="
            h-11 w-11 flex items-center justify-center rounded-full border border-rule
            text-ink-soft transition-colors
            hover:bg-bg-2 hover:text-ink
          "
        >
          <Info size={13} strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-[320px] p-4">
        <div className="text-[11px] uppercase tracking-[0.08em] text-ink-soft font-semibold mb-2">
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
            <span className="font-medium text-ink">Coverage</span> — companies
            whose statutory figures aren't loaded yet show a processing
            placeholder rather than estimates. Nothing on this surface is
            modeled or inferred.
          </li>
        </ul>
      </PopoverContent>
    </Popover>
  );
}

// ── Measured hover-marquee ───────────────────────────────────────────────
// Sibling of the pure-CSS `.hover-marquee` utility (index.css), for
// shrink-to-fit elements. Measures the actual overflow in px and slides
// by exactly that much while the surrounding `.group` is hovered.

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

// ── Data-coverage score (grid ordering) ──────────────────────────────────
// Counts how many of the headline financial fields a snapshot actually
// carries. Used only to ORDER the company grid (fullest rows first).

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
    // `f` comes from COVERAGE_FIELDS, a `const` tuple of real keys, so the
    // snapshot indexes directly — the previous `as Record<string, unknown>`
    // asserted a shape onto the value and would have kept compiling if a
    // field were renamed out of the snapshot, silently dropping it from the
    // coverage count (i.e. quietly changing which companies rank as
    // well-covered). Indexing by the real key makes that a compile error.
    const v: unknown = r[f];
    if (typeof v === "number" && Number.isFinite(v)) n += 1;
  }
  return n;
}

// ── Company grid (info cards + arrow paging) ─────────────────────────────

// 24 per page — 6 rows of 4 at the xl breakpoint; narrower breakpoints
// reflow into more rows.
const COMPANIES_PER_PAGE = 24;

function CompanyGrid({
  rows,
  onSelect,
  moverDirs,
  standouts,
  compareSel,
  onToggleCompare,
  filters,
  markets,
  showMarketChips,
}: {
  rows: PublicCompanyFinancialSnapshot[];
  onSelect: (ticker: string) => void;
  moverDirs?: Map<string, "up" | "down">;
  standouts: Map<string, Standout>;
  compareSel: string[];
  onToggleCompare: (ticker: string) => void;
  filters?: ReactNode;
  markets?: MarketEntry[];
  showMarketChips?: boolean;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  if (rows.length === 0) return null;

  const pageCount = Math.max(1, Math.ceil(rows.length / COMPANIES_PER_PAGE));
  const current = Math.min(page, pageCount - 1);
  const start = current * COMPANIES_PER_PAGE;
  const pageRows = rows.slice(start, start + COMPANIES_PER_PAGE);
  const canPrev = current > 0;
  const canNext = current < pageCount - 1;

  return (
    <section data-testid="markets-company-grid">
      {filters && <div className="pb-4">{filters}</div>}
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={!canPrev}
          aria-label={t("pci.grid.prev")}
          data-testid="company-grid-prev"
          className="
            hidden sm:flex shrink-0 h-11 w-11 items-center justify-center rounded-full border border-rule
            text-ink-soft transition-colors
            hover:bg-bg-2 hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent
          "
        >
          <ChevronLeft size={20} strokeWidth={2} />
        </button>
        {/* key={current} remounts the page's cards on prev/next so the
            staggered entrance replays for each page swap (transform/
            opacity only; disabled under prefers-reduced-motion). */}
        <div
          key={current}
          className="cards-stagger flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3"
        >
          {pageRows.map((r) => (
            <CompanyCard
              key={r.ticker}
              row={r}
              onSelect={() => onSelect(r.ticker)}
              moverDir={moverDirs?.get(r.ticker)}
              standout={standouts.get(r.ticker)}
              compareSelected={compareSel.includes(r.ticker)}
              onToggleCompare={() => onToggleCompare(r.ticker)}
              markets={markets}
              showMarketChips={showMarketChips}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          disabled={!canNext}
          aria-label={t("pci.grid.next")}
          data-testid="company-grid-next"
          className="
            hidden sm:flex shrink-0 h-11 w-11 items-center justify-center rounded-full border border-rule
            text-ink-soft transition-colors
            hover:bg-bg-2 hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent
          "
        >
          <ChevronRight size={20} strokeWidth={2} />
        </button>
      </div>
      {/* Mobile pager — arrows below the single-column list. */}
      <div className="mt-3 flex items-center justify-center gap-3 sm:hidden">
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={!canPrev}
          aria-label={t("pci.grid.prev")}
          className="h-11 w-11 flex items-center justify-center rounded-full border border-rule text-ink-soft disabled:opacity-30"
        >
          <ChevronLeft size={20} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          disabled={!canNext}
          aria-label={t("pci.grid.next")}
          className="h-11 w-11 flex items-center justify-center rounded-full border border-rule text-ink-soft disabled:opacity-30"
        >
          <ChevronRight size={20} strokeWidth={2} />
        </button>
      </div>
      {/* Range readout — centred beneath the grid. */}
      <div className="mt-3 text-center text-[11px] text-ink-soft tabular-nums">
        {t("pci.grid.range", {
          from: start + 1,
          to: Math.min(start + COMPANIES_PER_PAGE, rows.length),
          total: rows.length,
        })}
      </div>
    </section>
  );
}

// ── Company card ─────────────────────────────────────────────────────────
// One card = monogram + ticker/name + sector chip + 30-day sparkline +
// price/day change + market cap (or revenue) + optional standout chip.
// Rows without statutory figures render a shimmer skeleton with the
// "processing" chip — any live price stays visible.

function CompanyCard({
  row: r,
  onSelect,
  moverDir,
  standout,
  compareSelected,
  onToggleCompare,
  markets,
  showMarketChips,
}: {
  row: PublicCompanyFinancialSnapshot;
  onSelect: () => void;
  moverDir?: "up" | "down";
  standout?: Standout;
  compareSelected: boolean;
  onToggleCompare: () => void;
  markets?: MarketEntry[];
  showMarketChips?: boolean;
}) {
  const { t } = useTranslation();
  const displayTicker = r.ticker.replace(/\.BVB$/, "");
  const marketId = marketIdForSnapshot(r, markets ?? undefined);
  const pending = isPendingRow(r);
  const hasPrice = typeof r.price === "number" && Number.isFinite(r.price);
  const hasChange =
    typeof r.priceChangePct === "number" && Number.isFinite(r.priceChangePct);
  const changeUp = (r.priceChangePct ?? 0) >= 0;
  // The universe snapshot's own timestamp, date-only. Absent → no stamp.
  const priceAsOf =
    hasPrice && typeof r.lastUpdated === "string" && r.lastUpdated
      ? r.lastUpdated.slice(0, 10)
      : null;

  // 30-day sparkline from the existing price-history endpoint (1M range,
  // cached 30 min per ticker). Missing/failed history → no sparkline row.
  const spark = useCardSparkline(r.ticker, true);
  const sparkData = spark.data && spark.data.length >= 2 ? spark.data : null;
  const sparkUp = sparkData
    ? sparkData[sparkData.length - 1].value >= sparkData[0].value
    : true;

  return (
    // D1 axe (nested-interactive): the tile is a PLAIN div — the open action
    // is a stretched sibling <button> at z-0, so the compare checkbox is no
    // longer a button nested inside an interactive wrapper.
    <div
      data-testid={`company-grid-tile-${r.ticker}`}
      className="
        group relative flex flex-col gap-2 rounded-md border border-rule bg-surface p-3 min-w-0
        text-left select-none
        transition-colors duration-micro hover:border-rule-strong
      "
    >
      <button
        type="button"
        aria-label={`${displayTicker} — ${r.companyName}`}
        onClick={onSelect}
        className="absolute inset-0 z-0 rounded-md cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      />
      {/* Header — monogram + ticker/name + compare checkbox. */}
      <div className="flex items-start gap-2.5 min-w-0">
        <CompanyLogo
          ticker={displayTicker}
          variant="monogram"
          size={36}
          className="rounded-sm"
        />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-mono font-medium text-[12.5px] text-ink tabular-nums">
              {displayTicker}
            </span>
            {moverDir === "up" && (
              <TrendingUp size={12} strokeWidth={2} className="shrink-0 text-success" />
            )}
            {moverDir === "down" && (
              <TrendingDown size={12} strokeWidth={2} className="shrink-0 text-alert" />
            )}
          </div>
          <div className="text-[11px] text-ink-soft truncate">{r.companyName}</div>
        </div>
        {/* Compare checkbox — 44px touch target, 20px visual circle.
            z-[1] lifts it above the stretched open-trigger. */}
        <button
          type="button"
          aria-pressed={compareSelected}
          aria-label={t("pci.card.select", { ticker: displayTicker })}
          data-testid={`compare-check-${r.ticker}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCompare();
          }}
          className="relative z-[1] -m-2.5 h-11 w-11 shrink-0 flex items-center justify-center"
        >
          <span
            className={`
              h-5 w-5 rounded-full border flex items-center justify-center
              transition-colors duration-150
              ${compareSelected
                ? "border-brand bg-brand text-paper"
                : "border-rule bg-surface text-transparent group-hover:border-rule-strong"}
            `}
          >
            <Check size={12} strokeWidth={3} />
          </span>
        </button>
      </div>

      {/* Sector chip, plus the market + currency chips when the grid
          spans more than one market. `marketIdForSnapshot` returns null
          for an exchange the registry does not know — the chip is then
          omitted rather than guessed, because a wrong market chip
          attaches the wrong currency and the wrong licence to a real
          number. The currency chip always reads the row's OWN currency
          field, never the market's, so a foreign-currency filer is
          labelled by what it actually reports. */}
      {(r.sector || r.industry || (showMarketChips && (marketId || r.currency))) && (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {showMarketChips && marketId && (
            <span
              data-testid={`company-card-market-${r.ticker}`}
              aria-label={`${t("pcm.card.marketAria")}: ${marketId.toUpperCase()}`}
              className="
                inline-flex shrink-0 items-center rounded-full border border-rule bg-surface
                px-2 py-0.5 font-mono text-[10px] font-medium text-ink-soft
              "
            >
              {marketId.toUpperCase()}
            </span>
          )}
          {showMarketChips && r.currency && (
            <span
              data-testid={`company-card-currency-${r.ticker}`}
              aria-label={`${t("pcm.card.currencyAria")}: ${r.currency}`}
              className="
                inline-flex shrink-0 items-center rounded-full border border-rule bg-surface
                px-2 py-0.5 font-mono text-[10px] font-medium text-ink-soft
              "
            >
              {r.currency}
            </span>
          )}
          {(r.sector || r.industry) && (
            <span
              className="
                inline-flex max-w-full min-w-0 items-center rounded-full border border-rule bg-bg-2
                px-2 py-0.5 text-[10px] font-medium text-ink-soft truncate
              "
            >
              {r.sector ?? r.industry}
            </span>
          )}
        </div>
      )}

      {/* Body — sparkline + standout, or the processing skeleton. */}
      {pending ? (
        <div className="space-y-2" data-testid={`company-card-pending-${r.ticker}`}>
          <div className="space-y-1.5 pt-0.5">
            <div className="h-2 rounded bg-bg-2 animate-pulse w-4/5" />
            <div className="h-2 rounded bg-bg-2 animate-pulse w-3/5" />
            <div className="h-2 rounded bg-bg-2 animate-pulse w-2/5" />
          </div>
          {/* Caution = "still reconciling", the one amber meaning. */}
          <StateChip tone="caution">{t("pci.card.pending")}</StateChip>
        </div>
      ) : (
        <>
          {sparkData && (
            <div className="pointer-events-none -mx-0.5">
              <Sparkline
                data={sparkData}
                idKey={`pci-${displayTicker}`}
                positive={sparkUp}
                height={34}
              />
            </div>
          )}
          {standout && (
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <span
                  data-testid={`company-card-standout-${r.ticker}`}
                  className="
                    relative z-[1] inline-flex max-w-full items-center gap-1.5 self-start rounded-full
                    bg-brand-tint px-2 py-0.5
                    text-[10.5px] font-medium text-brand-dark dark:text-brand-light truncate
                  "
                >
                  {t(`pci.card.metric.${standout.key}`)}{" "}
                  <span className="font-mono tabular-nums">
                    {fmtStandoutValue(standout.key, standout.value)}
                  </span>
                  {/* D1 axe: no opacity de-emphasis — 70% brand-dark lands
                      ~3.4:1 on the tint; full strength clears AA. */}
                  <span>
                    {t("pci.card.rank", { rank: standout.rank, n: standout.n })}
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[240px] text-xs">
                {t(`pci.card.why.${standout.key}`)}
              </TooltipContent>
            </Tooltip>
          )}
        </>
      )}

      {/* Footer — price + day change | market cap (or revenue). */}
      <div className="mt-auto flex items-end justify-between gap-2 pt-1 border-t border-rule-soft text-[11px] min-w-0">
        <div className="min-w-0">
          {hasPrice ? (
            <>
              <Amount
                value={r.price}
                currency={r.currency}
                fractionDigits={2}
                className="text-[11px] text-ink"
              />
              {hasChange && (
                <Amount
                  kind="percent"
                  value={(r.priceChangePct ?? 0) / 100}
                  fractionDigits={2}
                  className={`ml-1.5 text-[11px] ${changeUp ? "text-success" : "text-alert"}`}
                />
              )}
              {/* As-of stamp — rendered ONLY when the payload carries
                  one. A price with no as-of is a price whose age we do
                  not know, and inventing "today" would be the exact
                  fabrication this surface refuses. */}
              {priceAsOf && (
                <div
                  data-testid={`company-card-price-asof-${r.ticker}`}
                  className="text-[9.5px] text-ink-mute"
                >
                  {t("pcm.card.asOf", { date: priceAsOf })}
                </div>
              )}
            </>
          ) : (
            <span className="text-ink-soft">—</span>
          )}
        </div>
        <div className="text-right shrink-0">
          {r.marketCap != null && Number.isFinite(r.marketCap) ? (
            <>
              <div className="text-[9.5px] uppercase tracking-[0.08em] text-ink-soft">
                {t("pci.card.mktCap")}
              </div>
              {/* No inline currency on magnitude-scaled figures — "40,00
                  BRON" reads as a fake currency; the page declares RON
                  once in the header chips. */}
              <Amount
                value={r.marketCap}
                magnitude={pickMagnitude([r.marketCap])}
                className="text-[11px] text-ink"
              />
            </>
          ) : r.revenue != null && Number.isFinite(r.revenue) ? (
            <>
              <div className="text-[9.5px] uppercase tracking-[0.08em] text-ink-soft">
                {t("pci.compare.row.revenue")}
              </div>
              <Amount
                value={r.revenue}
                magnitude={pickMagnitude([r.revenue])}
                className="text-[11px] text-ink"
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Filter chip ──────────────────────────────────────────────────────────

interface ChipItem {
  label: string;
  description?: string;
  count: number;
  selected?: boolean;
  onClick: () => void;
  testId: string;
}

function Chip({
  label,
  description,
  count,
  selected = false,
  onClick,
  testId,
}: ChipItem) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={selected}
      className={`
        group shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-full border
        text-[11.5px] font-medium transition-colors duration-micro cursor-pointer
        ${selected
          ? "border-brand/50 bg-brand-tint text-brand-dark dark:text-brand-light"
          : "border-rule bg-surface text-ink hover:bg-bg-2 hover:border-rule-strong"}
      `}
    >
      <span className="min-w-0 max-w-[150px]">
        <HoverMarquee text={label} />
      </span>
      <span
        className={`font-mono text-[10px] tabular-nums shrink-0 ${
          selected ? "" : "text-ink-soft"
        }`}
      >
        {count}
      </span>
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
