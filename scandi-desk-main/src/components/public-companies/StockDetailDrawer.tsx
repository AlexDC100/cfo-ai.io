// StockDetailDrawer — Apple Stocks-inspired slide-over for one ticker.
//
// PUB-200 §11+12+13 — opens when the user clicks a row in
// PublicCompaniesUniverseTable. Three-tier body:
//   1. Header: ticker / name / exchange / sector + price + delta
//   2. Range selector + price chart
//   3. Metric grid (Market / Financial / Quality)
// Footer actions: Open full analysis · Add as benchmark peer ·
// Ask CFO AI · Refresh.
//
// Width: 560px desktop, full-screen mobile. Slides in from the right.
// Backdrop closes the drawer; ESC closes the drawer.
//
// Data flow:
//   · Universe table passes the already-loaded snapshot via prop —
//     no extra fetch needed for KPIs.
//   · Price history is fetched fresh per-(ticker, range) via React
//     Query; cached across opens.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw, Sparkles, X, Check, ArrowUpRight, BookOpen } from "lucide-react";

import { Money } from "@/components/ui/Money";
import {
  addPeer,
  isPeer,
  removePeer,
  useBenchmarkPeers,
} from "@/lib/benchmarkPeersStore";
import { setPublicCompanyChatFromSnapshot } from "@/lib/publicCompanyChatStore";
import { openAskCfoAi } from "@/components/cfo/chat/openAskCfoAi";
import {
  fetchPriceHistory,
  priceDelta,
  type PriceRange,
} from "@/lib/publicCompanyPriceHistory";
import { snapshotCurrency } from "@/lib/publicCompanyUniverse";
import { CompanyLogo } from "./CompanyLogo";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import { toast } from "@/hooks/use-toast";

import { PublicCompanySourceBadge } from "./PublicCompanySourceBadge";
import { StockChartRangeSelector } from "./StockChartRangeSelector";
import { StockMetricGrid } from "./StockMetricGrid";
import { StockPriceChart } from "./StockPriceChart";
// Phase A — AI Intelligence layer panels.
import { RiskBreakdownPanel } from "./RiskBreakdownPanel";
import { AIMarketReadPanel } from "./AIMarketReadPanel";
// Note: Sparkles is already imported above (line 23) for the existing
// "Ask CFO AI" CTA. We only need the two new icons for the drawer tab strip.
import { Activity, BarChart3 } from "lucide-react";

interface Props {
  /** Snapshot currently selected — null when drawer should be closed. */
  snapshot: PublicCompanyFinancialSnapshot | null;
  /** Close handler. Backdrop click + ESC + X button all wire here. */
  onClose: () => void;
  /** Default range to load on open. Persisted across opens via URL ?range=. */
  initialRange?: PriceRange;
  /** Notify parent when the user changes range so it can sync the URL. */
  onRangeChange?: (range: PriceRange) => void;
}

export function StockDetailDrawer({
  snapshot,
  onClose,
  initialRange = "1Y",
  onRangeChange,
}: Props) {
  const [range, setRange] = useState<PriceRange>(initialRange);
  // Phase A — drawer internal tabs. "overview" keeps the original
  // chart + metric grid; "risk" surfaces the deterministic 7-category
  // risk breakdown; "ai-read" renders the LLM-or-deterministic Market
  // Read narrative. Tab state is per-drawer-open — closing + reopening
  // resets to "overview" so the chart is always the first thing seen.
  type DrawerTab = "overview" | "risk" | "ai-read";
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("overview");
  const navigate = useNavigate();
  useBenchmarkPeers(); // subscribe so peer-toggle re-renders

  // ESC closes
  useEffect(() => {
    if (!snapshot) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snapshot, onClose]);

  // Body-scroll lock while drawer open
  useEffect(() => {
    if (!snapshot) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [snapshot]);

  // Sync the chat store so "Ask CFO AI" includes this ticker's context
  useEffect(() => {
    if (!snapshot) return;
    setPublicCompanyChatFromSnapshot(snapshot);
  }, [snapshot]);

  // Reset range when ticker changes (each ticker re-opens at the
  // caller's preferred initial range)
  useEffect(() => {
    if (snapshot) setRange(initialRange);
  }, [snapshot?.ticker, initialRange]);

  const ticker = snapshot?.ticker ?? "";
  const priceHistoryQuery = useQuery({
    queryKey: ["public-companies", "price-history", ticker, range],
    queryFn: () => fetchPriceHistory(ticker, range),
    enabled: !!ticker,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  const delta = useMemo(
    () => priceDelta(priceHistoryQuery.data?.points ?? []),
    [priceHistoryQuery.data],
  );

  const handleRangeChange = useCallback(
    (r: PriceRange) => {
      setRange(r);
      onRangeChange?.(r);
    },
    [onRangeChange],
  );

  // 2026-05-25 — TEMPORARY "Coming soon" gate. The full Add-as-Peer flow
  // (peer benchmarking against private companies) is built but not
  // production-ready end-to-end. Until the peer-integration QA pass
  // lands, clicking shows a clear "coming soon" banner instead of
  // silently adding a peer that doesn't yet feed into Benchmark.
  //
  // To restore: swap this body with the commented-out original below
  // and re-enable `removePeer` / `addPeer` / `isPeer` from the
  // benchmarkPeersStore imports.
  const handleAddPeer = useCallback(() => {
    if (!snapshot) return;
    toast({
      title: "Coming soon",
      description: `Adding ${snapshot.ticker} as a benchmark peer is in active development. We'll let you know the moment it ships.`,
    });
  }, [snapshot]);

  // Original handler, preserved for restoration once the peer pipeline is ready:
  //
  // const handleAddPeer = useCallback(() => {
  //   if (!snapshot) return;
  //   if (isPeer(snapshot.ticker)) {
  //     removePeer(snapshot.ticker);
  //     toast({ title: `${snapshot.ticker} removed from peers.` });
  //     return;
  //   }
  //   addPeer({
  //     ticker: snapshot.ticker,
  //     name: snapshot.companyName,
  //     sector: snapshot.sector ?? null,
  //     exchange: snapshot.exchange ?? null,
  //     currency: snapshot.currency,
  //     source: "public",
  //   });
  //   const msg = snapshot.source === "demo"
  //     ? `Added demo peer ${snapshot.ticker}. Connect Nasdaq for live peer data.`
  //     : `Added ${snapshot.ticker} as Nasdaq peer.`;
  //   toast({ title: msg });
  // }, [snapshot]);

  const handleAskCfoAi = useCallback(() => {
    if (!snapshot) return;
    openAskCfoAi(
      `Tell me about ${snapshot.companyName} (${snapshot.ticker}) — `
        + `what stands out in the FY2024 numbers and how does it compare `
        + `to peers in ${snapshot.sector ?? "this sector"}?`,
    );
  }, [snapshot]);

  const handleRefresh = useCallback(() => {
    void priceHistoryQuery.refetch();
  }, [priceHistoryQuery]);

  /** Per-ticker public-company dashboard (NASDAQ-9) — full statements,
   *  ratios, valuation, benchmark integration.
   *
   *  2026-06-07 (F5.0 Phase 4.5) — Coming-soon gate REMOVED. The full
   *  /dashboard/public/:ticker page is now live with Wave 4 LearnableMetricCard
   *  KPI tiles (Revenue / EBITDA / Net Profit / Total Assets / Cash /
   *  Total Debt / Operating CF / Free Cash Flow) and Wave 2 plain-English
   *  popovers wired against live Sharadar SF1 data. Browser-verified on
   *  prod against AAPL, all 8 tiles render and click-to-popover works.
   *
   *  Old gate (replaced): a `toast({ title: "Coming soon", ... })` call
   *  surfaced because the route existed but tabs weren't fully wired.
   *  That is no longer the case — the Overview tab is the Wave 4 KPI
   *  surface, and downstream tabs (P&L / BS / CF / Ratios / Valuation)
   *  reuse the private-company renderers (NASDAQ-10).
   */
  const handleOpenFullAnalysis = useCallback(() => {
    if (!snapshot) return;
    onClose();
    navigate(`/dashboard/public/${snapshot.ticker}`);
  }, [snapshot, onClose, navigate]);

  if (!snapshot) return null;

  const currency = snapshotCurrency(snapshot);
  const alreadyPeer = isPeer(snapshot.ticker);
  const positiveDelta = (delta?.abs ?? 0) >= 0;
  const exchange = snapshot.exchange ?? "NASDAQ";
  // BVB Phase 2 (2026-06-01) — strip the .BVB namespace suffix on
  // display. Storage keeps the namespaced form (e.g. "EL.BVB" to avoid
  // colliding with NASDAQ's Estée Lauder), but the user sees the bare
  // BVB ticker since the exchange chip already disambiguates context.
  // CompanyLogo also reads the bare form (logo CDN doesn't know about
  // our namespace).
  const displayTicker = snapshot.ticker.replace(/\.BVB$/, "");
  const sectorLine = [
    exchange,
    snapshot.sector,
    snapshot.latestPeriod || "FY2024",
  ].filter(Boolean).join(" · ");

  return (
    <div
      data-testid="stock-detail-drawer"
      className="fixed inset-0 z-50 flex"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close drawer"
        data-testid="stock-drawer-backdrop"
        onClick={onClose}
        className="
          absolute inset-0 bg-ink/30 backdrop-blur-[2px]
          animate-in fade-in duration-150
        "
      />

      {/* Panel — right-aligned slide-over */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="stock-drawer-title"
        className="
          relative ml-auto h-full w-full sm:w-[560px]
          bg-bg shadow-2xl
          flex flex-col
          animate-in slide-in-from-right duration-200
        "
      >
        {/* ── Header ────────────────────────────────────────────── */}
        <header className="
          flex items-start justify-between gap-3
          px-5 pt-5 pb-4
          border-b border-rule
        ">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            {/* Company logo — Clearbit + letter-avatar fallback. Same
                visual treatment as the universe list so the user sees
                the same brand mark on hover, click, and detail. */}
            <CompanyLogo ticker={displayTicker} size={44} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h2
                  id="stock-drawer-title"
                  className="text-[20px] font-bold text-ink tracking-tight"
                >
                  {displayTicker}
                </h2>
                <PublicCompanySourceBadge
                  variant={
                    // BVB Phase 2 (2026-06-01) — dispatch on source so
                    // BVB seed rows show the BVB badge instead of
                    // inheriting the misleading Nasdaq fallback.
                    snapshot.source === "seed_bvb"
                      ? "bvb"
                      : snapshot.source === "demo"
                        ? "demo"
                        : "nasdaq"
                  }
                />
              </div>
              <div className="text-[14px] text-ink-soft font-medium truncate">
                {snapshot.companyName}
              </div>
              <div className="text-[11px] text-ink-mute mt-0.5">
                {sectorLine}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="stock-drawer-close"
            className="
              inline-flex items-center justify-center h-8 w-8
              rounded-lg text-ink-mute
              hover:bg-bg-2 hover:text-ink transition-colors
            "
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>

        {/* ── Unified scrollable body ─────────────────────────────
            PUB-200-FIX-B: header + footer are sticky; everything
            below (price + delta + range selector + chart + metric
            grid) shares ONE overflow-y-auto so users on shorter
            viewports can scroll the entire body, not get stuck
            between a height-locked chart and a hidden metric grid. */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* ── Price + delta ──────────────────────────────────── */}
          <div className="px-5 py-4 border-b border-rule/60 flex items-baseline gap-3 flex-wrap">
            <div className="text-[28px] font-semibold text-ink tabular-nums">
              {delta ? (
                <Money value={delta.last} fromCurrency={currency} />
              ) : snapshot.price ? (
                <Money value={snapshot.price} fromCurrency={currency} />
              ) : (
                <span className="text-ink-mute">—</span>
              )}
            </div>
            {delta && (
              <div
                data-testid="stock-drawer-delta"
                className={`text-[13px] font-medium tabular-nums ${
                  positiveDelta ? "text-green-700" : "text-red-700"
                }`}
              >
                {positiveDelta ? "+" : ""}
                {delta.abs.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                {" · "}
                {positiveDelta ? "+" : ""}
                {delta.pct.toFixed(2)}% ({range})
              </div>
            )}
          </div>

          {/* ── Drawer tab strip — Overview / Risk / AI Read ──── */}
          <div
            role="tablist"
            aria-label="Stock detail sections"
            className="px-5 py-2.5 border-b border-rule/60 flex gap-1 overflow-x-auto"
            data-testid="stock-drawer-tabs"
          >
            <DrawerTabPill
              active={drawerTab === "overview"}
              onClick={() => setDrawerTab("overview")}
              icon={BarChart3}
              label="Overview"
              testid="drawer-tab-overview"
            />
            <DrawerTabPill
              active={drawerTab === "risk"}
              onClick={() => setDrawerTab("risk")}
              icon={Activity}
              label="Risk"
              testid="drawer-tab-risk"
            />
            <DrawerTabPill
              active={drawerTab === "ai-read"}
              onClick={() => setDrawerTab("ai-read")}
              icon={Sparkles}
              label="AI Read"
              testid="drawer-tab-ai-read"
            />
          </div>

          {/* ── Overview tab — original chart + metrics ─────── */}
          {drawerTab === "overview" && (
            <>
              <div className="px-5 pt-3 pb-4 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <StockChartRangeSelector
                    value={range}
                    onChange={handleRangeChange}
                    compact
                  />
                  <button
                    type="button"
                    onClick={handleRefresh}
                    aria-label="Refresh chart"
                    data-testid="stock-drawer-refresh"
                    disabled={priceHistoryQuery.isRefetching}
                    className="
                      inline-flex items-center justify-center h-7 w-7
                      rounded-md border border-rule
                      text-ink-soft hover:bg-bg-2 hover:text-ink
                      disabled:opacity-60 transition-colors
                    "
                  >
                    <RefreshCw
                      size={12}
                      strokeWidth={1.75}
                      className={priceHistoryQuery.isRefetching ? "animate-spin" : ""}
                    />
                  </button>
                </div>
                <StockPriceChart
                  data={priceHistoryQuery.data}
                  range={range}
                  isLoading={priceHistoryQuery.isLoading}
                  isError={!!priceHistoryQuery.error}
                />
              </div>
              <div className="px-5 pb-4 pt-2 border-t border-rule/60">
                <StockMetricGrid snapshot={snapshot} />
              </div>
            </>
          )}

          {/* ── Risk tab — 7-category breakdown + top risks/opps ── */}
          {drawerTab === "risk" && (
            <div className="px-5 py-4">
              <RiskBreakdownPanel ticker={snapshot.ticker} />
            </div>
          )}

          {/* ── AI Read tab — deterministic-or-LLM narrative ──── */}
          {drawerTab === "ai-read" && (
            <div className="px-5 py-4">
              <AIMarketReadPanel ticker={snapshot.ticker} />
            </div>
          )}
        </div>

        {/* ── Footer actions ──────────────────────────────── */}
        <footer className="
          px-5 py-3 border-t border-rule
          flex items-center gap-2 flex-wrap
          bg-bg-2/30
        ">
          <button
            type="button"
            onClick={handleOpenFullAnalysis}
            data-testid="stock-drawer-open-full"
            className="
              inline-flex items-center gap-1.5
              h-8 px-3 rounded-lg
              border border-rule bg-surface
              text-[12px] font-medium text-ink
              hover:bg-bg-2 transition-colors
            "
          >
            <BookOpen size={12} strokeWidth={2} />
            Open full analysis
            <ArrowUpRight size={11} strokeWidth={2} className="text-ink-mute" />
          </button>
          {/* Add-as-peer — gated by a "Coming soon" toast (see handler).
              The `alreadyPeer` state still drives the visual chip so any
              previously-added peers stay visually marked, but the button
              click no longer mutates the peer set. */}
          <button
            type="button"
            onClick={handleAddPeer}
            data-testid="stock-drawer-add-peer"
            className="
              inline-flex items-center gap-1.5
              h-8 px-3 rounded-lg
              border border-rule bg-surface text-[12px] font-medium text-ink
              hover:bg-bg-2 transition-colors
            "
          >
            <Plus size={12} strokeWidth={2} />
            Add as peer
          </button>
          <button
            type="button"
            onClick={handleAskCfoAi}
            data-testid="stock-drawer-ask-cfo-ai"
            className="
              inline-flex items-center gap-1.5
              h-8 px-3 rounded-lg
              text-[12px] font-medium
              text-ink-soft hover:text-brand-d
              hover:bg-brand/10 transition-colors
            "
          >
            <Sparkles size={12} strokeWidth={1.75} />
            Ask CFO AI
          </button>
          <a
            href={`https://data.nasdaq.com/data/SHARADAR/SF1-${snapshot.ticker}`}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="stock-drawer-sf1-link"
            className="
              ml-auto inline-flex items-center gap-1
              h-8 px-2 rounded-lg
              text-[11px] text-ink-mute
              hover:text-ink hover:bg-bg-2 transition-colors
            "
          >
            <BookOpen size={11} strokeWidth={1.75} />
            SF1 source
            <ArrowUpRight size={10} strokeWidth={1.75} />
          </a>
        </footer>
      </aside>
    </div>
  );
}

// ─── Drawer tab pill (Phase A) ──────────────────────────────────────────
// Compact segmented button used by the in-drawer tab strip. Mirrors the
// pattern used in PublicCompanyIntelligence's top-level tab pill but
// scaled for the drawer's narrower context.

function DrawerTabPill({
  active,
  onClick,
  icon: Icon,
  label,
  testid,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Activity;
  label: string;
  testid?: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      data-testid={testid}
      className={`
        inline-flex items-center gap-1.5 shrink-0
        h-7 px-2.5 rounded-md
        text-[11.5px] font-medium
        transition-colors
        ${active
          ? "bg-bg-2 text-ink"
          : "text-ink-soft hover:text-ink hover:bg-bg-2/60"}
      `}
    >
      <Icon size={12} strokeWidth={1.75} />
      {label}
    </button>
  );
}
