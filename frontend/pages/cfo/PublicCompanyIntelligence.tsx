// Public Company Intelligence hub — premium financial workspace redesign.
//
// 5 sections per the spec, no duplicates, no Step labels, status banner
// top-right (single source of truth for live/demo/entitlement state).
// `selectedTicker` lifted to page state. PUB-200 — clicking a row now
// opens the StockDetailDrawer (slide-over with price chart + metrics),
// not the inline PublicCompanySnapshotPanel (deprecated; removed in the
// 2026-07 dead-code cleanup, recoverable from git history).

import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Activity, LayoutGrid, Globe } from "lucide-react";
import { PublicShell } from "@/components/cfo/PublicShell";
import { PageHeader } from "@/components/cfo/ui/PageHeader";
import { useAuth } from "@/lib/auth";
import { CompanySearchPanel, searchUniverse } from "@/components/public-companies/CompanySearchPanel";
import { MarketsOverview, type GridFilter } from "@/components/public-companies/MarketsOverview";
import { BenchmarkingPanel } from "@/components/public-companies/BenchmarkingPanel";
import { StockDetailDrawer } from "@/components/public-companies/StockDetailDrawer";
import { PeerSuggestRail } from "@/components/public-companies/PeerSuggestRail";
import { MarketPulseStrip } from "@/components/public-companies/MarketPulseStrip";
import {
  workspaceBenchMetrics,
  workspaceIndustryToSector,
} from "@/components/public-companies/pciData";
import "@/components/public-companies/pciI18n";
import { useActivePeriod } from "@/lib/activePeriod";
import { useWorkspaceName } from "@/lib/workspaceName";
import { staticBvbRows } from "@/lib/bvbStaticUniverse";
import { BVBBadge } from "@/components/public-companies/BVBBadge";
import { fetchUniverse } from "@/lib/publicCompanyUniverse";
import type { PriceRange } from "@/lib/publicCompanyPriceHistory";
import {
  setPublicCompanyChatContext,
  setPublicCompanyChatFromSnapshot,
} from "@/lib/publicCompanyChatStore";

// Phase A — AI Intelligence layer, lazy-loaded (2026-08-04): the Risk
// Radar and the Geographic Map only fetch their data + bundle chunk when
// their tab is actually opened.
const RiskRadar = lazy(() =>
  import("@/components/public-companies/RiskRadar").then((m) => ({
    default: m.RiskRadar,
  })),
);
const GeographicMapPanel = lazy(() =>
  import("@/components/public-companies/GeographicMapPanel").then((m) => ({
    default: m.GeographicMapPanel,
  })),
);

/** Minimal shimmer while a lazy tab chunk loads — abstract bars, matching
 *  the app's RouteFallback convention. */
function TabFallback() {
  return (
    <div className="space-y-3 py-6" aria-hidden>
      <div className="h-4 w-1/3 rounded bg-bg-2 animate-pulse" />
      <div className="h-40 rounded-2xl bg-bg-2/70 animate-pulse" />
      <div className="h-40 rounded-2xl bg-bg-2/50 animate-pulse" />
    </div>
  );
}

export default function PublicCompanyIntelligence() {
  const { t } = useTranslation();
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

  // ── "Compania ta" (2026-08-04) — the loaded period's own metrics, used
  //    by the peer rail, the benchmark drill-down overlay and the compare
  //    sheet. Same deriveTotals the statements surfaces use; null when no
  //    real uploaded period is loaded. ──
  const period = useActivePeriod();
  const wsName = useWorkspaceName();
  const workspaceLoaded =
    period.isLoaded && period.source === "upload" && !!period.statements;
  const workspaceMetrics = useMemo(
    () =>
      workspaceLoaded ? workspaceBenchMetrics(period.statements, wsName) : null,
    [workspaceLoaded, period.statements, wsName],
  );
  const workspaceSector = workspaceIndustryToSector(
    period.industry ?? period.statements?.industry ?? null,
  );

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
              eyebrow={t("pci.header.eyebrow")}
              title={
                <>
                  {t("pci.header.titlePre")}
                  <span className="text-grad">{t("pci.header.titleGrad")}</span>.{" "}
                  <span className="inline-flex align-middle">
                    <BVBBadge variant="section" />
                  </span>
                </>
              }
              subtitle={t("pci.header.subtitle")}
            />

            {/* ── Tab strip — Overview / Risk Radar ──────────────────────
                  Segmented control sits between the header and the per-tab
                  content. Sticky-ish styling matches the rest of the app
                  (rounded pill, brand accent on active). Persists to ?tab=
                  so deep links + browser back/forward work. */}
            <div
              role="tablist"
              aria-label={t("pci.header.tabsAria")}
              className="mb-5 inline-flex p-1 rounded-xl border border-rule/60 bg-bg-2/40 gap-1"
              data-testid="public-intelligence-tabs"
            >
              <TabPill
                active={view === "overview"}
                onClick={() => switchView("overview")}
                icon={LayoutGrid}
                label={t("pci.header.tabOverview")}
                testid="tab-overview"
              />
              <TabPill
                active={view === "risk-radar"}
                onClick={() => switchView("risk-radar")}
                icon={Activity}
                label={t("pci.header.tabRisk")}
                testid="tab-risk-radar"
              />
              <TabPill
                active={view === "map"}
                onClick={() => switchView("map")}
                icon={Globe}
                label={t("pci.header.tabMap")}
                testid="tab-map"
              />
            </div>
          </div>
          {/* "Your real peer" pairing removed (2026-07-26 per operator). The
              PeerSection component still lives in MarketsOverview.tsx if it's
              ever wanted back; nothing renders it today. */}
        </div>

        {/* Risk Radar tab — short-circuit before the overview block.
            Drawer + CompanySearchPanel are NOT rendered here because the
            radar surface is universe-scoped, not single-company. */}
        {view === "risk-radar" ? (
          <div className="space-y-5">
            <Suspense fallback={<TabFallback />}>
              <RiskRadar onDrillToCategory={handleRadarDrill} />
            </Suspense>
          </div>
        ) : view === "map" ? (
          /* Geographic Map — Romania county choropleth. Company clicks open
             the same StockDetailDrawer via handleSelectTicker, so the drawer
             rendered at the bottom of this page works from this tab too. */
          <Suspense fallback={<TabFallback />}>
            <GeographicMapPanel rows={allCompanies} onSelectTicker={handleSelectTicker} />
          </Suspense>
        ) : (
        <>
        <div className="space-y-5">
          {/* ── Hero — peers suggested for the user's own company
                (2026-08-04 redesign). Hidden when no real period is
                loaded. ── */}
          <PeerSuggestRail rows={allCompanies} onSelectTicker={handleSelectTicker} />

          {/* ── Market pulse — aggregate day read of the live-quoted
                universe (hidden entirely in static/demo mode). ── */}
          <MarketPulseStrip rows={allCompanies} onSelectTicker={handleSelectTicker} />

          {/* ── Market Search ──────────────────────────────────────── */}
          <CompanySearchPanel
            rows={allCompanies}
            onSelect={handleSelectTicker}
            query={searchQuery}
            onQueryChange={setSearchQuery}
          />

          {/* ── Markets overview — filter chips + company cards; the
                compare tray lives inside. Risk Radar drills land in the
                same grid filter via `drillFilter`. ── */}
          <MarketsOverview
            rows={allCompanies}
            onSelectTicker={handleSelectTicker}
            drillFilter={radarDrill}
            searchFilter={searchFilter}
            onClearSearch={() => setSearchQuery("")}
            workspace={workspaceMetrics}
          />

          {/* ── Peer benchmarking — per-group stats + drill-down. ── */}
          <BenchmarkingPanel
            universeRows={allCompanies}
            workspace={workspaceMetrics}
            workspaceSector={workspaceSector}
          />
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

        {/* Footer source attribution — describes what THIS page actually
            loaded (2026-07-26 per operator), not a fixed roadmap sentence.
            The counts come from the same payload the tables render, so a
            demo-mode session or a partial universe says so plainly. */}
        <div className="mt-10 pt-6 border-t border-rule/60 text-[11px] text-ink-mute text-center">
          {/* The universe fetch chokepoint filters to BVB-only rows
              (publicCompanyUniverse.fetchUniverse), so the count here is
              always the BVB listing count this page actually renders. */}
          {universeQuery.isLoading
            ? t("pci.footer.loading")
            : demoMode
              ? t("pci.footer.demo")
              : t("pci.footer.sources", { bvb: allCompanies.length })}
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
  /** Renders the tab but refuses selection. Unused since 2026-08-04 (the
   *  Risk Radar + Geographic Map tabs were re-enabled and lazy-loaded per
   *  the PCI redesign spec); kept for the next time a tab needs gating. */
  disabled?: boolean;
}

function TabPill({ active, onClick, icon: Icon, label, testid, disabled = false }: TabPillProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={onClick}
      data-testid={testid}
      title={disabled ? t("pci.header.tabUnavailable", { label }) : undefined}
      className={`
        inline-flex items-center gap-1.5
        h-8 px-3 rounded-lg
        text-[12.5px] font-medium
        transition-colors
        ${disabled
          ? "text-ink-mute opacity-40 cursor-not-allowed"
          : active
          ? "bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.2)]"
          : "text-ink-soft hover:text-ink"}
      `}
    >
      <Icon size={13} strokeWidth={1.75} />
      {label}
    </button>
  );
}
