// Public Company Intelligence hub — premium financial workspace redesign.
//
// 5 sections per the spec, no duplicates, no Step labels, status banner
// top-right (single source of truth for live/demo/entitlement state).
// `selectedTicker` lifted to page state. PUB-200 — clicking a row now
// opens the StockDetailDrawer (slide-over with price chart + metrics),
// not the inline PublicCompanySnapshotPanel (deprecated; removed in the
// 2026-07 dead-code cleanup, recoverable from git history).

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity, LayoutGrid, Globe } from "lucide-react";
import { PublicShell } from "@/components/cfo/PublicShell";
import { PageHeader } from "@/components/cfo/ui/PageHeader";
import { useAuth } from "@/lib/auth";
import { CompanySearchPanel, searchUniverse } from "@/components/public-companies/CompanySearchPanel";
import { MarketsOverview, PeerSection, type GridFilter } from "@/components/public-companies/MarketsOverview";
import { BenchmarkingPanel } from "@/components/public-companies/BenchmarkingPanel";
import { StockDetailDrawer } from "@/components/public-companies/StockDetailDrawer";
// Phase A — AI Intelligence layer. RiskRadar is the new 8-card radar
// driven by /api/public/intelligence/risk-radar. Lives on its own tab so
// it never competes with the existing Markets Overview / Universe table.
import { RiskRadar } from "@/components/public-companies/RiskRadar";
// Geographic Map — Romania county (județ) choropleth (design port, 2026-07-23).
import { GeographicMapPanel } from "@/components/public-companies/GeographicMapPanel";
import { staticBvbRows } from "@/lib/bvbStaticUniverse";
import { BVBBadge } from "@/components/public-companies/BVBBadge";
import { fetchUniverse } from "@/lib/publicCompanyUniverse";
import type { PriceRange } from "@/lib/publicCompanyPriceHistory";
import {
  setPublicCompanyChatContext,
  setPublicCompanyChatFromSnapshot,
} from "@/lib/publicCompanyChatStore";

export default function PublicCompanyIntelligence() {
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  // PUB-200 — chart range is per-session preference, persisted in URL
  // so a drawer reopen lands on the same range and so deep links carry
  // it. Defaults to 1Y per the spec.
  const [chartRange, setChartRange] = useState<PriceRange>("1Y");
  const [searchParams, setSearchParams] = useSearchParams();
  // 2026-07-24 — the Layer-2 drill-down ("Market universe" table) was
  // removed; Explore pills now filter MarketsOverview's company grid in
  // place. This state only carries Risk Radar category drills INTO that
  // grid filter.
  const [radarDrill, setRadarDrill] = useState<GridFilter | null>(null);
  // Phase A intelligence layer — top-level tab selector. "overview" shows
  // the existing markets-overview + universe + benchmark + AI-interp stack;
  // "risk-radar" shows the new 8-card AI risk radar. Persisted to ?tab=
  // so deep-links land on the right view + browser back/forward works.
  type IntelView = "overview" | "risk-radar" | "map";
  const [view, setView] = useState<IntelView>(() => {
    const t = searchParams.get("tab");
    return t === "risk-radar" ? "risk-radar" : t === "map" ? "map" : "overview";
  });

  // Deep-link support: `/public-companies?ticker=X&range=1Y` auto-opens
  // the StockDetailDrawer for X at the requested range.
  useEffect(() => {
    const t = searchParams.get("ticker");
    if (t && t.toUpperCase() !== selectedTicker) {
      setSelectedTicker(t.toUpperCase());
    }
    const r = searchParams.get("range");
    if (r && r !== chartRange) {
      const valid: PriceRange[] = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"];
      if (valid.includes(r as PriceRange)) setChartRange(r as PriceRange);
    }
    const t2 = searchParams.get("tab");
    if (t2 === "risk-radar" && view !== "risk-radar") setView("risk-radar");
    else if (t2 === "map" && view !== "map") setView("map");
    else if ((!t2 || t2 === "overview") && view !== "overview") setView("overview");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, selectedTicker, chartRange]);

  // Sync view → URL so refresh + share-link both work.
  const switchView = useCallback(
    (next: IntelView) => {
      setView(next);
      const sp = new URLSearchParams(searchParams);
      if (next === "overview") sp.delete("tab");
      else sp.set("tab", next);
      setSearchParams(sp, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // Radar card click → switch to overview tab + filter the company grid
  // to the surfaced tickers.
  const handleRadarDrill = useCallback(
    (category: string, tickers: string[]) => {
      if (!tickers.length) return;
      switchView("overview");
      setRadarDrill({
        key: `drill-risk-radar-${category}`,
        label: `Risk Radar — ${category.replace("_", " & ")}`,
        tickers,
      });
    },
    [switchView],
  );

  // PUB-UPG / PUB-200-FIX-F — fetch the 200-row universe. React Query
  // caches it for the session AND auto-refetches every 5 minutes to
  // pick up the latest Sharadar DAILY values (which roll over after US
  // market close ~21:30 UTC). The Refresh button forces a server-side
  // refresh (busts the backend's 5-min warm cache too). Sharadar is
  // EOD — we can't poll faster than that meaningfully — but the 5-min
  // cadence ensures the table reflects the most recent close within
  // minutes of it landing upstream.
  const universeQuery = useQuery({
    queryKey: ["public-companies", "universe", "ARY"],
    queryFn: () => fetchUniverse(),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: false,
  });

  // Demo mode is driven by the universe payload itself
  // (`/api/public/universe` returns `mode: "demo" | "live"`).
  const demoMode = universeQuery.data?.mode === "demo";

  // NASDAQ-13 — feed the chat store whenever the selected ticker
  // changes (either via row-click or via deep link). CFOChatShell reads
  // this store to attach the public-company snapshot to every chat
  // turn. On unmount we clear the store so a chat opened from any
  // OTHER surface doesn't accidentally carry stale ticker context.
  useEffect(() => {
    if (!selectedTicker) {
      setPublicCompanyChatContext(null);
      return;
    }
    const snap = universeQuery.data?.companies.find(
      (c) => c.ticker === selectedTicker,
    );
    if (snap) {
      setPublicCompanyChatFromSnapshot(snap);
    } else {
      // Universe hasn't loaded yet OR the ticker isn't in the default
      // 57 (came via search). Seed with the bare ticker so the chat
      // can at least name the company; richer context lands once the
      // snapshot panel resolves.
      setPublicCompanyChatContext({ ticker: selectedTicker });
    }
  }, [selectedTicker, universeQuery.data]);
  useEffect(() => {
    // Clear on unmount — chat opened on /dashboard shouldn't see the
    // ticker the user last viewed on /public-companies.
    return () => setPublicCompanyChatContext(null);
  }, []);

  // PUB-200 — drawer open/close handlers. Selecting a ticker syncs the
  // URL with ?ticker=X&range=Y so deep links work and the back button
  // closes the drawer. Closing clears the URL params.
  const handleSelectTicker = useCallback((t: string | null) => {
    setSelectedTicker(t);
    const next = new URLSearchParams(searchParams);
    if (t) {
      next.set("ticker", t);
      if (chartRange) next.set("range", chartRange);
    } else {
      next.delete("ticker");
      next.delete("range");
    }
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, chartRange]);

  const handleRangeChange = useCallback((r: PriceRange) => {
    setChartRange(r);
    const next = new URLSearchParams(searchParams);
    next.set("range", r);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Search (2026-07-24) — the page owns the query so matches render IN
  // the company grid (as a synthetic selected "Search" pill + narrowed
  // rows) instead of a dropdown under the bar.
  const [searchQuery, setSearchQuery] = useState("");

  // Universe rows with static fallback (2026-07-23): while the live fetch
  // is loading/failing, every consumer — Romanian Listed card, sector
  // tallies, featured comparisons, universe table, search, map — renders
  // from the bundled BVB list (real FY2024 financials, no prices) instead
  // of an empty page. Live rows take over the moment they arrive.
  // Declared BEFORE selectedSnapshot below, which reads it.
  const liveCompanies = universeQuery.data?.companies;
  const allCompanies = liveCompanies?.length ? liveCompanies : staticBvbRows();

  // Search matches as a grid filter — MarketsOverview shows these rows
  // and a selected "Search" pill while a query is active.
  const searchFilter = useMemo<GridFilter | null>(() => {
    const q = searchQuery.trim();
    if (!q) return null;
    return {
      key: `search-${q.toLowerCase()}`,
      label: `Search "${q}"`,
      tickers: searchUniverse(allCompanies, q).map((r) => r.ticker),
    };
  }, [searchQuery, allCompanies]);

  // Drawer snapshot resolves from allCompanies, which already falls back
  // to the bundled static BVB rows — so quick-pick / search / map clicks
  // always open the drawer, with financials from the static seed when the
  // live universe isn't available.
  const selectedSnapshot = selectedTicker
    ? allCompanies.find((c) => c.ticker === selectedTicker) ?? null
    : null;

  // Shell selection: authed visitors are routed UNDER the shared AppLayout
  // (App.tsx), which already provides the one persistent AppShell — so here we
  // render content-only (Fragment) to avoid a second, remounting shell. That's
  // what keeps navigating to /public-companies from refreshing the app.
  // Anonymous visitors (landing-page "Quick try" chips / Public Companies CTA)
  // hit the standalone route and get the slimmer PublicShell — Logo + Sign in +
  // Get started CTAs. Same page body either way; "no signup · 10s" stays true.
  const { isAuthenticated } = useAuth();
  const Shell = isAuthenticated ? Fragment : PublicShell;

  return (
    <Shell>
      <div
        data-testid="public-company-intelligence"
        className={
          // Authed: render content-only into the shared AppShell, which already
          // supplies the left-anchored gutter (px-4 sm:px-8 lg:px-10 + py) AND
          // the max-w-[1760px] clamp — so we add NOTHING here. The page then
          // matches the dashboard exactly: same background, same sidebar gap,
          // and the same content width (no narrower clamp leaving an empty
          // background strip on the right).
          // Anonymous: PublicShell gives no padding, so keep the self-contained
          // centered layout that the standalone marketing route needs.
          isAuthenticated
            ? ""
            : "max-w-[1280px] mx-auto px-4 sm:px-6 py-6 sm:py-8"
        }
      >
        {/* ── Section 1 — Compact header + status banner ───────────
            2026-05-26 (mobile fix): the prior layout used
            `flex items-start justify-between gap-4 flex-wrap`
            with `flex-1` on the left column. The status pill
            ("Demo mode · Nasdaq key missing", ~180px wide) was
            wide enough to squeeze the left column to ~150px on
            iPhone SE / 14, causing the "Public Company Intelligence"
            headline to wrap to three column-stacked lines.

            Fix: stack vertically by default, switch to row at the
            sm: breakpoint (640px). Drop `flex-1` from the left
            column so it sizes to its content; the status group
            gets `sm:shrink-0` so it never forces the heading
            narrower than the heading needs. Heading also scales
            from 24px (mobile) → 28px → 34px. */}
        {/* Dashboard-hero styling: the module name reads as a small
            Sparkles eyebrow (like the dashboard's "Get started"), the
            value proposition is promoted to the large semibold headline
            (like "Upload your trial balance…"). Status banner + Docs sit
            in the header's actions slot. */}
        {/* Header row — the hero header + tab strip on the left, the
            "Your real peer" section (user's company vs. its BVB peer)
            on the right. The peer section moved up here from the top of
            MarketsOverview (2026-07-24) so it shares the header's
            horizontal band; it stacks below the header on narrower
            screens. */}
        <div className="flex flex-col xl:flex-row xl:items-start gap-6">
          <div className="min-w-0 flex-1">
            <PageHeader
              hero
              eyebrow="Public Company Intelligence"
              title={
                <>
                  Search listed companies and add them as{" "}
                  <span className="text-grad">benchmark peers</span>.{" "}
                  <span className="inline-flex align-middle">
                    <BVBBadge variant="section" />
                  </span>
                </>
              }
              subtitle="Statutory financials for every company listed on the Bucharest Stock Exchange — revenue, margins, equity and valuation, from issuer disclosures and official ANAF filings, with live BVB prices. Add any company as a benchmark peer and it slots next to your private books in the same ratios, valuation, and risk views."
            />

            {/* ── Tab strip — Overview / Risk Radar ──────────────────────
                  Segmented control sits between the header and the per-tab
                  content. Sticky-ish styling matches the rest of the app
                  (rounded pill, brand accent on active). Persists to ?tab=
                  so deep links + browser back/forward work. */}
            <div
              role="tablist"
              aria-label="Public Companies sections"
              className="mb-5 inline-flex p-1 rounded-xl border border-rule/60 bg-bg-2/40 gap-1"
              data-testid="public-intelligence-tabs"
            >
              <TabPill
                active={view === "overview"}
                onClick={() => switchView("overview")}
                icon={LayoutGrid}
                label="Overview"
                testid="tab-overview"
              />
              <TabPill
                active={view === "risk-radar"}
                onClick={() => switchView("risk-radar")}
                icon={Activity}
                label="Risk Radar"
                testid="tab-risk-radar"
              />
              <TabPill
                active={view === "map"}
                onClick={() => switchView("map")}
                icon={Globe}
                label="Geographic Map"
                testid="tab-map"
              />
            </div>
          </div>
          <div className="w-full xl:w-[720px] xl:shrink-0">
            <PeerSection rows={allCompanies} onSelect={handleSelectTicker} />
          </div>
        </div>

        {/* Risk Radar tab — short-circuit before the overview block.
            Drawer + CompanySearchPanel are NOT rendered here because the
            radar surface is universe-scoped, not single-company. */}
        {view === "risk-radar" ? (
          <div className="space-y-5">
            <RiskRadar onDrillToCategory={handleRadarDrill} />
          </div>
        ) : view === "map" ? (
          /* Geographic Map — Romania county choropleth. Company clicks open
             the same StockDetailDrawer via handleSelectTicker, so the drawer
             rendered at the bottom of this page works from this tab too. */
          <GeographicMapPanel rows={allCompanies} onSelectTicker={handleSelectTicker} />
        ) : (
        <>
        {/* ── Section 2 — Market Search ──────────────────────────── */}
        <div className="space-y-5">
          <CompanySearchPanel
            rows={allCompanies}
            onSelect={handleSelectTicker}
            query={searchQuery}
            onQueryChange={setSearchQuery}
          />

          {/* ── Section 3 — Markets overview ─────────────────────────
                Magazine-style overview: Explore pills, the BVB logo
                grid, movers. Explore pills filter the grid IN PLACE —
                the old Layer-2 drill-down ("Market universe" table,
                PublicCompaniesUniverseTable) was removed 2026-07-24.
                Risk Radar drills land in the same grid filter via
                `drillFilter`. */}
          <MarketsOverview
            rows={allCompanies}
            onSelectTicker={handleSelectTicker}
            drillFilter={radarDrill}
            searchFilter={searchFilter}
            onClearSearch={() => setSearchQuery("")}
          />

          {/* ── Section 4 — Peer benchmarking ─────────────────── */}
          <BenchmarkingPanel />

          {/* Section 5 — AI investment interpretation — removed 2026-07-25. */}
        </div>
        </>
        )}

        {/* ── StockDetailDrawer — opens on row click / deep link. ────── */}
        <StockDetailDrawer
          snapshot={selectedSnapshot}
          onClose={() => handleSelectTicker(null)}
          initialRange={chartRange}
          onRangeChange={handleRangeChange}
        />

        {/* Footer source attribution */}
        <div className="mt-10 pt-6 border-t border-rule/60 text-[11px] text-ink-mute text-center">
          Sources: <span className="font-medium">Nasdaq Data Link · Sharadar Equities Bundle (SF1 + DAILY)</span>.
          {" "}
          SEC EDGAR + Manual / CSV ingestion land in a follow-up release.
        </div>
      </div>
    </Shell>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Local helpers — tab pill component, kept inline because it's only used
// here. If a second page picks up the same pattern we'll lift it into
// src/components/cfo/.
// ─────────────────────────────────────────────────────────────────────────

interface TabPillProps {
  active: boolean;
  onClick: () => void;
  icon: typeof Activity;
  label: string;
  testid?: string;
}

function TabPill({ active, onClick, icon: Icon, label, testid }: TabPillProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      data-testid={testid}
      className={`
        inline-flex items-center gap-1.5
        h-8 px-3 rounded-lg
        text-[12.5px] font-medium
        transition-colors
        ${active
          ? "bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.2)]"
          : "text-ink-soft hover:text-ink"}
      `}
    >
      <Icon size={13} strokeWidth={1.75} />
      {label}
    </button>
  );
}
