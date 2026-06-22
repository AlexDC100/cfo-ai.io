// Selected-company snapshot panel — the spec's biggest missing piece.
//
// Renders above the benchmark section when a watchlist row is clicked.
// 12-tile KPI grid + 4 action buttons (Open Full Analysis / Add as Peer /
// Refresh / Ask CFO AI). Uses live data via getPublicCompany() when the
// ticker is in the live envelope; falls back to the centralized demo
// watchlist when in demo mode or while loading.
//
// Premium financial density: tabular numbers, compact tiles, source pill
// per data block. No big gradient hero — this is a working surface, not
// a marketing card.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Plus, RefreshCw, Sparkles, Check, X, Clock } from "lucide-react";
import { Money } from "@/components/ui/Money";
import type { Currency } from "@/lib/rates";
import { PublicCompanySourceBadge } from "./PublicCompanySourceBadge";
import {
  addPeer, isPeer, removePeer, useBenchmarkPeers,
} from "@/lib/benchmarkPeersStore";
import {
  getPublicCompany,
  type PublicCompanyEnvelope,
} from "@/lib/publicCompanyApi";
import { DEMO_WATCHLIST, type WatchlistRow } from "@/lib/publicCompanyWatchlist";
import { openAskCfoAi } from "@/components/cfo/chat/openAskCfoAi";

interface Props {
  ticker: string;
  onClear: () => void;
}

interface Snapshot {
  ticker: string;
  name: string;
  exchange: string | null;
  sector: string | null;
  currency: Currency;
  source: "nasdaq" | "demo";
  asOf: string;
  // Money
  marketCap: number | null;
  revenue: number | null;
  ebitda: number | null;
  netIncome: number | null;
  cash: number | null;
  grossDebt: number | null;
  netDebt: number | null;
  fcf: number | null;
  // Ratios / %
  ebitdaMargin: number | null;
  netDebtToEbitda: number | null;
  peRatio: number | null;
  evEbitda: number | null;
  fcfYield: number | null;
}

export function PublicCompanySnapshotPanel({ ticker, onClear }: Props) {
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // F5.0 Phase 4.5 (2026-06-07) — the legacy `showComingSoon` modal was
  // removed; the FullAnalysisComingSoonDialog component definition is
  // retained further down for any future re-use, but no call site
  // triggers it. "Open full analysis" now navigates directly to the
  // live /dashboard/public/:ticker route (Wave 4 LearnableMetricCard
  // KPI tiles render against live Sharadar SF1 data).
  useBenchmarkPeers(); // subscribe so peer toggle re-renders
  const alreadyPeer = isPeer(ticker);

  const load = async (signal?: AbortSignal) => {
    setLoading(true);
    const r = await getPublicCompany(ticker, { dimension: "ARY", limit: 1, signal });
    if (signal?.aborted) return;
    if (r.ok && r.value.periods.length > 0) {
      setSnapshot(buildSnapshotFromEnvelope(r.value));
    } else {
      setSnapshot(fallbackToDemo(ticker));
    }
    setLoading(false);
  };

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const togglePeer = () => {
    if (alreadyPeer) {
      removePeer(ticker);
    } else if (snapshot) {
      addPeer({
        ticker,
        name: snapshot.name,
        sector: snapshot.sector,
        exchange: snapshot.exchange,
        currency: snapshot.currency,
      });
    }
  };

  return (
    <section
      data-testid="public-company-snapshot-panel"
      className="
        rounded-3xl border border-rule
        bg-gradient-to-br from-surface to-bg-2/30
        overflow-hidden
      "
    >
      {/* Header strip — ticker, name, source, actions */}
      <header className="px-5 sm:px-6 py-4 border-b border-rule flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-mono text-[20px] font-semibold text-ink tabular-nums tracking-tight">
              {ticker}
            </span>
            <span className="text-[15px] text-ink truncate">{snapshot?.name ?? "Loading…"}</span>
            {snapshot && (
              <PublicCompanySourceBadge variant={snapshot.source} />
            )}
          </div>
          <div className="text-[11.5px] text-ink-mute mt-0.5 flex items-center gap-2 flex-wrap">
            {snapshot?.exchange && <span>{snapshot.exchange}</span>}
            {snapshot?.sector && <><span className="opacity-50">·</span><span>{snapshot.sector}</span></>}
            {snapshot?.asOf && <><span className="opacity-50">·</span><span>As of {snapshot.asOf}</span></>}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={togglePeer}
            disabled={!snapshot}
            data-testid="snapshot-toggle-peer"
            className={`
              inline-flex items-center gap-1.5
              h-8 px-3 rounded-lg
              text-[12px] font-medium
              ring-1 ring-inset
              transition-all
              disabled:opacity-50
              ${alreadyPeer
                ? "bg-brand/10 text-brand-d ring-brand/30 hover:bg-brand/15"
                : "bg-gradient-to-b from-brand to-brand-d text-paper ring-white/15 hover:shadow-[0_8px_22px_-8px_rgba(45,191,179,0.7)]"
              }
            `}
          >
            {alreadyPeer ? <Check size={12} strokeWidth={2} /> : <Plus size={12} strokeWidth={2} />}
            {alreadyPeer ? "Peer saved" : "Add as peer"}
          </button>
          <button
            onClick={handleRefresh}
            disabled={refreshing || !snapshot}
            data-testid="snapshot-refresh"
            className="
              inline-flex items-center gap-1.5
              h-8 px-2.5 rounded-lg
              border border-rule bg-surface
              text-[12px] text-ink-soft
              hover:bg-bg-2/50 hover:text-ink
              disabled:opacity-50
              transition-all
            "
          >
            <RefreshCw size={11} strokeWidth={1.75} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Syncing" : "Refresh"}
          </button>
          {/* F5.0 Phase 4.5 (2026-06-07) — direct route to the live
              per-ticker dashboard (/dashboard/public/:ticker). The
              previous gate routed to a coming-soon modal because the
              full Overview / P&L / BS / CF / Ratios / Valuation tab set
              hadn't been calibrated end-to-end; Wave 4 finished the
              Overview-tab LearnableMetricCard wiring against live
              Sharadar SF1 data, so the route is now production-ready.
              Browser-verified on prod against AAPL (all 8 KPI tiles
              click-to-popover with plain-English + formula + Ask CFO AI).
              Keep `data-testid` stable so the older Playwright spec
              that asserted "modal opens" can be updated to assert
              "navigation occurs" without renaming the selector. */}
          <button
            type="button"
            onClick={() => navigate(`/dashboard/public/${ticker}`)}
            data-testid="snapshot-open-full-coming-soon"
            title={`Full per-ticker analysis for ${ticker}`}
            className="
              inline-flex items-center gap-1.5
              h-8 px-3 rounded-lg
              border border-rule bg-surface
              text-[12px] text-ink-soft font-medium
              hover:bg-bg-2/50 hover:text-ink hover:border-rule-strong
              transition-all
            "
          >
            Open full analysis
          </button>
          <button
            type="button"
            onClick={() =>
              openAskCfoAi(
                `Tell me about ${snapshot?.name || ticker} (${ticker}) — `
                  + `what should I notice in the FY2024 numbers?`,
              )
            }
            data-testid="snapshot-ask-cfo-ai"
            className="
              inline-flex items-center gap-1.5
              h-8 px-2.5 rounded-lg
              text-[12px] text-ink-soft hover:text-brand-d
              hover:bg-brand/10 transition-all
            "
          >
            <Sparkles size={11} strokeWidth={1.75} />
            Ask CFO AI
          </button>
          <button
            onClick={onClear}
            data-testid="snapshot-close"
            aria-label="Close snapshot"
            className="
              inline-flex items-center justify-center
              h-8 w-8 rounded-lg
              text-ink-mute hover:bg-bg-2 hover:text-ink
              transition-colors
            "
          >
            <X size={13} strokeWidth={1.75} />
          </button>
        </div>
      </header>

      {/* KPI grid */}
      {loading && !snapshot ? (
        <div className="flex items-center justify-center py-16 text-ink-mute text-[13px] gap-2">
          <Loader2 size={14} className="animate-spin" /> Fetching snapshot…
        </div>
      ) : snapshot ? (
        <div className="px-5 sm:px-6 py-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5 mb-5">
            <KpiTile label="Market Cap"      value={moneyOrDash(snapshot.marketCap, snapshot.currency)} />
            <KpiTile label="Revenue"         value={moneyOrDash(snapshot.revenue, snapshot.currency)} />
            <KpiTile label="EBITDA"          value={moneyOrDash(snapshot.ebitda, snapshot.currency)} />
            <KpiTile label="EBITDA margin"   value={pctOrDash(snapshot.ebitdaMargin)} muted={snapshot.ebitdaMargin == null} />
            <KpiTile label="Net Income"      value={moneyOrDash(snapshot.netIncome, snapshot.currency)} />
            <KpiTile label="Cash"            value={moneyOrDash(snapshot.cash, snapshot.currency)} />
            <KpiTile label="Gross Debt"      value={moneyOrDash(snapshot.grossDebt, snapshot.currency)} />
            <KpiTile label="Net Debt"        value={moneyOrDash(snapshot.netDebt, snapshot.currency)} />
            <KpiTile label="Net Debt / EBITDA" value={multipleOrDash(snapshot.netDebtToEbitda)} muted={snapshot.netDebtToEbitda == null} />
            <KpiTile label="Free Cash Flow"  value={moneyOrDash(snapshot.fcf, snapshot.currency)} />
            <KpiTile label="P/E"             value={multipleOrDash(snapshot.peRatio)} muted={snapshot.peRatio == null} />
            <KpiTile label="EV / EBITDA"     value={multipleOrDash(snapshot.evEbitda)} muted={snapshot.evEbitda == null} />
          </div>
          {snapshot.source === "demo" && (
            <p className="text-[11px] text-ink-mute pt-3 border-t border-rule/60">
              Showing demo snapshot. Live data activates the moment Nasdaq Sharadar SF1
              entitlement reaches this ticker.
            </p>
          )}
        </div>
      ) : null}

      {/* F5.0 Phase 4.5 (2026-06-07) — FullAnalysisComingSoonDialog mount
          removed. The dialog component is still defined below for
          historical reference; if a future surface needs a temporary
          gate it can be re-mounted. */}
    </section>
  );
}

/**
 * FullAnalysisComingSoonDialog — premium modal that explains why the
 * per-ticker full-analysis view is gated, what's coming, and what works
 * today. Replaces the silent disabled state with an explicit, friendly
 * "in progress" surface. Centered backdrop, ESC-to-close, focus trapped
 * on the primary CTA. Matches the rest of the app's modal language
 * (rounded-2xl, navy gradient header, amber accent for "soon" framing).
 */
function FullAnalysisComingSoonDialog({
  ticker,
  name,
  onClose,
}: {
  ticker: string;
  name: string;
  onClose: () => void;
}) {
  // ESC to close — copied from IndustryConfirmModal's accessibility pattern.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="full-analysis-soon-title"
      data-testid="full-analysis-coming-soon-modal"
      className="
        fixed inset-0 z-50 flex items-center justify-center
        p-4 sm:p-6
        bg-ink/40 backdrop-blur-sm
      "
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="
          relative w-full max-w-[480px]
          rounded-2xl border border-rule/60 bg-surface
          shadow-[0_24px_56px_-12px_rgba(0,0,0,0.32)]
          overflow-hidden
        "
      >
        {/* Header strip — navy gradient + amber accent for "soon" */}
        <div className="relative px-6 pt-6 pb-5 text-paper"
             style={{ background: "linear-gradient(135deg, #003366 0%, #1a5490 100%)" }}>
          <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.12em] opacity-85">
            <Clock size={11} strokeWidth={2} className="text-amber-300" />
            New feature · in development
          </div>
          <h2 id="full-analysis-soon-title" className="mt-2 font-serif text-[22px] leading-tight">
            Full per-ticker analysis is coming soon
          </h2>
          <p className="mt-1.5 text-[12.5px] opacity-90">
            For <span className="font-mono font-semibold">{ticker}</span> · {name}
          </p>
          <button
            onClick={onClose}
            aria-label="Close"
            className="
              absolute top-4 right-4
              inline-flex items-center justify-center
              h-7 w-7 rounded-lg
              text-paper/70 hover:bg-paper/10 hover:text-paper
              transition-colors
            "
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          <p className="text-[13px] text-ink leading-relaxed">
            We're calibrating the per-ticker canonical synthesis so the full
            P&amp;L, Balance Sheet, Cash Flow, and Ratios pages match
            statutory filings tick-for-tick across every NASDAQ ticker —
            not just the calibration set.
          </p>

          <div className="rounded-xl border border-emerald-300/40 bg-emerald-50/50 dark:bg-emerald-500/[0.06] px-4 py-3">
            <div className="text-[10.5px] uppercase tracking-[0.1em] text-emerald-800 dark:text-emerald-300 font-semibold mb-1.5">
              Available today
            </div>
            <ul className="text-[12.5px] text-ink-soft space-y-1 list-disc pl-4">
              <li>The snapshot panel above (12 KPIs, audited Sharadar feed)</li>
              <li>Add this ticker as a benchmark peer on the comparison panel</li>
              <li>Ask CFO AI any question about the snapshot or peer set</li>
            </ul>
          </div>

          <div className="rounded-xl border border-amber-300/40 bg-amber-50/40 dark:bg-amber-500/[0.05] px-4 py-3">
            <div className="text-[10.5px] uppercase tracking-[0.1em] text-amber-800 dark:text-amber-300 font-semibold mb-1.5">
              Shipping next
            </div>
            <ul className="text-[12.5px] text-ink-soft space-y-1 list-disc pl-4">
              <li>Full reconstructed P&amp;L / BS / CF per ticker</li>
              <li>5-year trend + segment breakdown</li>
              <li>One-click "compare against your company" overlay</li>
            </ul>
          </div>
        </div>

        {/* Footer actions */}
        <footer className="border-t border-rule/60 bg-bg-2/30 px-6 py-3.5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            data-testid="full-analysis-coming-soon-close"
            className="
              inline-flex items-center
              h-9 px-4 rounded-lg
              text-[13px] font-medium text-ink-soft hover:text-ink
              hover:bg-bg-2 transition-colors
            "
          >
            Got it
          </button>
        </footer>
      </div>
    </div>
  );
}

function KpiTile({
  label, value, muted = false,
}: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="rounded-xl border border-rule/60 bg-surface/60 backdrop-blur-sm px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-[0.1em] font-semibold text-ink-mute">
        {label}
      </div>
      <div className={`mt-0.5 font-serif text-[16px] tabular-nums leading-tight ${muted ? "text-ink-mute" : "text-ink"}`}>
        {value}
      </div>
    </div>
  );
}

function moneyOrDash(value: number | null, currency: Currency): React.ReactNode {
  if (value == null) return <span className="text-ink-mute text-[12.5px]">Unavailable</span>;
  return <Money value={value} fromCurrency={currency} compact />;
}
function pctOrDash(value: number | null): React.ReactNode {
  if (value == null) return <span className="text-ink-mute text-[12.5px]">Unavailable</span>;
  return `${value.toFixed(1)}%`;
}
function multipleOrDash(value: number | null): React.ReactNode {
  if (value == null) return <span className="text-ink-mute text-[12.5px]">Unavailable</span>;
  return `${value.toFixed(2)}×`;
}

// ── Adapters ─────────────────────────────────────────────────────────

function buildSnapshotFromEnvelope(env: PublicCompanyEnvelope): Snapshot {
  const p = env.periods[0];
  const h = p.headline;
  const m = p.market_metrics;
  const ebitdaMargin = h.revenue && h.ebitda ? (h.ebitda / h.revenue) * 100 : null;
  const netDebt = h.total_debt != null && h.cash != null ? h.total_debt - h.cash : null;
  return {
    ticker: env.ticker,
    name: env.ticker_info.name || env.ticker,
    exchange: env.ticker_info.exchange ?? null,
    sector: env.ticker_info.sector ?? null,
    currency: (p.currency as Currency) || "USD",
    source: "nasdaq",
    asOf: p.fiscal_period_end,
    marketCap: m?.market_cap ?? null,
    revenue: h.revenue,
    ebitda: h.ebitda,
    netIncome: h.net_income,
    cash: h.cash,
    grossDebt: h.total_debt,
    netDebt,
    fcf: h.free_cash_flow,
    ebitdaMargin,
    netDebtToEbitda: netDebt != null && h.ebitda ? netDebt / h.ebitda : null,
    peRatio: m?.pe_ratio ?? null,
    evEbitda: m?.ev_ebitda ?? null,
    fcfYield: m?.market_cap && h.free_cash_flow ? (h.free_cash_flow / m.market_cap) * 100 : null,
  };
}

function fallbackToDemo(ticker: string): Snapshot {
  const r: WatchlistRow | undefined = DEMO_WATCHLIST.find((w) => w.ticker === ticker.toUpperCase());
  if (!r) {
    return {
      ticker: ticker.toUpperCase(), name: ticker.toUpperCase(),
      exchange: null, sector: null, currency: "USD", source: "demo", asOf: "",
      marketCap: null, revenue: null, ebitda: null, netIncome: null, cash: null,
      grossDebt: null, netDebt: null, fcf: null,
      ebitdaMargin: null, netDebtToEbitda: null, peRatio: null, evEbitda: null, fcfYield: null,
    };
  }
  return {
    ticker: r.ticker, name: r.name, exchange: r.exchange, sector: r.sector,
    currency: "USD", source: "demo", asOf: r.last_updated_iso,
    marketCap: r.market_cap_usd, revenue: r.revenue_usd,
    ebitda: r.revenue_usd * (r.ebitda_margin_pct / 100),
    netIncome: null, cash: null,
    grossDebt: null,
    netDebt: r.revenue_usd * (r.ebitda_margin_pct / 100) * r.net_debt_to_ebitda,
    fcf: r.market_cap_usd * (r.fcf_yield_pct / 100),
    ebitdaMargin: r.ebitda_margin_pct,
    netDebtToEbitda: r.net_debt_to_ebitda,
    peRatio: r.pe_ratio, evEbitda: r.ev_ebitda, fcfYield: r.fcf_yield_pct,
  };
}
