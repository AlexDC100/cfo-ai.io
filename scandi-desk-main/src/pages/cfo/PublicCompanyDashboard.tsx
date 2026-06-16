// NASDAQ-9 — Per-company dashboard at /dashboard/public/:ticker.
//
// Mirrors the private dashboard layout (FinancialStatements.tsx) so the
// platform feels unified: header + tabs + Overview tile grid. The data
// path is different — the envelope comes from /api/public/companies/:ticker
// (NASDAQ-6) instead of /api/period/:id — but the rendering shape is
// identical because `assembled_canonical_v1` is the same.
//
// NASDAQ-9 ships the shell + Overview tab. NASDAQ-10 will plug the
// remaining tabs (P&L / BS / CF / Ratios / Valuation) into the
// existing PLStatementView / BSStatementView / CashFlowStatementView /
// NavValuationView renderers via thin Statements adapters.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Loader2, AlertTriangle } from "lucide-react";
import { AppShell } from "@/components/cfo/AppShell";
import { Money } from "@/components/ui/Money";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PublicCompanyHeader } from "@/components/cfo/PublicCompanyHeader";
import { PublicCompanyPeriodToggle } from "@/components/cfo/PublicCompanyPeriodToggle";
import { PublicCompanySubscriptionRequired } from "@/components/cfo/PublicCompanySubscriptionRequired";
import { GuideMeButton } from "@/components/learning/GuideMeButton";
import { PUBLIC_COMPANIES_GUIDE } from "@/components/learning/pageGuides";
import { LearnableMetricCard } from "@/components/learning/LearnableMetricCard";
// NASDAQ-10 — feed the public envelope into existing private renderers
import { PLStatementView } from "@/components/cfo/PLStatementView";
import { BSStatementView } from "@/components/cfo/BSStatementView";
import { CashFlowStatementView } from "@/components/cfo/CashFlowStatementView";
import { computeRatios, verdictColor, verdictLabel, formatRatio } from "@/lib/financialReport";
import { buildPublicStatements } from "@/lib/publicCompanyAdapters";
import type { Currency } from "@/lib/rates";
import {
  getPublicCompany,
  syncPublicCompany,
  type Dimension,
  type NasdaqErrorEnvelope,
  type PublicCompanyEnvelope,
} from "@/lib/publicCompanyApi";

const VALID_DIMS: Dimension[] = ["ARY", "ARQ", "ART", "MRY", "MRQ", "MRT"];
const DEFAULT_TAB = "overview";

export default function PublicCompanyDashboard() {
  const { ticker: rawTicker } = useParams<{ ticker: string }>();
  const ticker = (rawTicker ?? "").toUpperCase();
  const [searchParams, setSearchParams] = useSearchParams();

  const dimensionParam = searchParams.get("dimension");
  const dimension: Dimension =
    dimensionParam && VALID_DIMS.includes(dimensionParam as Dimension)
      ? (dimensionParam as Dimension)
      : "ARY";

  const tab = searchParams.get("tab") ?? DEFAULT_TAB;

  const [envelope, setEnvelope] = useState<PublicCompanyEnvelope | null>(null);
  const [error, setError] = useState<NasdaqErrorEnvelope["error"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // ── Load envelope ────────────────────────────────────────────────
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      const r = await getPublicCompany(ticker, { dimension, limit: 20, signal });
      if (signal?.aborted) return;
      if (r.ok) {
        setEnvelope(r.value);
        setError(null);
      } else {
        setEnvelope(null);
        setError(r.error);
      }
      setLoading(false);
    },
    [ticker, dimension],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Set a sessionStorage breadcrumb so other pages (notably Products,
  // Benchmark) can show contextual messages when the user navigates to
  // them after viewing a public company. Cleared on dashboard unmount —
  // it's tied to the active browsing session, not persistent.
  useEffect(() => {
    if (typeof sessionStorage === "undefined") return;
    try {
      sessionStorage.setItem("cfo:last-public-ticker", ticker);
      if (envelope?.ticker_info?.name) {
        sessionStorage.setItem("cfo:last-public-name", envelope.ticker_info.name);
      }
    } catch {
      // ignore quota / privacy-mode failures
    }
  }, [ticker, envelope?.ticker_info?.name]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await syncPublicCompany(ticker, { dimensions: [dimension] });
    await load();
    setRefreshing(false);
  }, [ticker, dimension, load]);

  const setDimension = (next: Dimension) => {
    setSearchParams((prev) => {
      const sp = new URLSearchParams(prev);
      sp.set("dimension", next);
      return sp;
    }, { replace: true });
  };
  const setTab = (next: string) => {
    setSearchParams((prev) => {
      const sp = new URLSearchParams(prev);
      sp.set("tab", next);
      return sp;
    }, { replace: true });
  };

  return (
    <AppShell>
      <div data-testid="public-company-dashboard">
        <PublicCompanyHeader
          ticker={ticker}
          info={envelope?.ticker_info ?? null}
          syncedAt={envelope?.synced_at ?? null}
          onRefresh={handleRefresh}
          refreshing={refreshing}
        />

        <div className="max-w-[1180px] mx-auto px-4 sm:px-6 py-6">
          {/* Period toggle row */}
          <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
            <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-mute">
              Period
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <GuideMeButton pageId="public-company" title={`${ticker} — Public Company`} steps={PUBLIC_COMPANIES_GUIDE} />
              <PublicCompanyPeriodToggle
                value={dimension}
                onChange={setDimension}
                disabled={loading}
              />
            </div>
          </div>

          {/* Error state */}
          {error && !loading && (
            <ErrorBlock error={error} ticker={ticker} />
          )}

          {/* Loading skeleton — minimal */}
          {loading && !envelope && !error && (
            <div className="flex items-center justify-center py-24 text-ink-mute text-[13px] gap-2">
              <Loader2 size={16} strokeWidth={1.75} className="animate-spin" />
              Fetching {ticker} from Nasdaq…
            </div>
          )}

          {/* Subscription-required state (free tier returned 200 + empty data) */}
          {envelope && envelope.subscription_required && (
            <PublicCompanySubscriptionRequired ticker={ticker} />
          )}

          {/* Happy path — render tabs */}
          {envelope && !envelope.subscription_required && envelope.periods.length > 0 && (
            <FullDashboard envelope={envelope} tab={tab} onTabChange={setTab} />
          )}
        </div>
      </div>
    </AppShell>
  );
}

// ── Full dashboard (all 5 tabs wired) ─────────────────────────────────

function FullDashboard({
  envelope,
  tab,
  onTabChange,
}: {
  envelope: PublicCompanyEnvelope;
  tab: string;
  onTabChange: (next: string) => void;
}) {
  // Adapt the public envelope into the shapes the private renderers expect.
  const adapted = useMemo(() => buildPublicStatements(envelope), [envelope]);
  // Compute ratios from the adapted Statements object — same engine the
  // private dashboard uses, so verdicts/benchmarks/commentary are identical.
  const ratios = useMemo(
    () => (adapted ? computeRatios(adapted.statements) : null),
    [adapted],
  );

  if (!adapted) return null;

  return (
    <Tabs value={tab} onValueChange={onTabChange} className="w-full">
      <TabsList className="grid grid-cols-3 sm:grid-cols-6 w-full h-auto">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="pl">P&amp;L</TabsTrigger>
        <TabsTrigger value="balance_sheet">Balance Sheet</TabsTrigger>
        <TabsTrigger value="cash_flow">Cash Flow</TabsTrigger>
        <TabsTrigger value="ratios">Ratios</TabsTrigger>
        <TabsTrigger value="valuation">Valuation</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="pt-5">
        <OverviewTab envelope={envelope} />
      </TabsContent>

      <TabsContent value="pl" className="pt-5">
        <PLStatementView statement={adapted.pl} showFootnote={false} />
      </TabsContent>

      <TabsContent value="balance_sheet" className="pt-5">
        <BSStatementView statement={adapted.bs} />
      </TabsContent>

      <TabsContent value="cash_flow" className="pt-5">
        <CashFlowStatementView statement={adapted.cf} />
      </TabsContent>

      <TabsContent value="ratios" className="pt-5">
        {ratios ? <RatiosTab ratios={ratios} /> : null}
      </TabsContent>

      <TabsContent value="valuation" className="pt-5">
        <ValuationTab envelope={envelope} />
      </TabsContent>
    </Tabs>
  );
}


// ── Ratios tab ────────────────────────────────────────────────────────

function RatiosTab({ ratios }: { ratios: ReturnType<typeof computeRatios> }) {
  const groups: { label: string; list: typeof ratios.profitability }[] = [
    { label: "Profitability", list: ratios.profitability },
    { label: "Liquidity",     list: ratios.liquidity },
    { label: "Leverage",      list: ratios.leverage },
    { label: "Coverage",      list: ratios.coverage },
    { label: "Efficiency",    list: ratios.efficiency },
  ];
  return (
    <div className="space-y-7" data-testid="public-company-ratios">
      {groups.map((g) => (
        <section key={g.label}>
          <h3 className="text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-mute mb-3">
            {g.label}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {g.list.map((r) => {
              const c = verdictColor(r.verdict);
              return (
                <div
                  key={r.key}
                  className="rounded-2xl border border-rule bg-surface p-4"
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="text-[11.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">
                      {r.label}
                    </div>
                    <span
                      className="text-[10px] uppercase tracking-[0.06em] font-semibold px-2 py-0.5 rounded"
                      style={{ backgroundColor: c.bg, color: c.text }}
                    >
                      {verdictLabel(r.verdict)}
                    </span>
                  </div>
                  <div className="font-serif text-[22px] text-ink leading-tight tabular-nums tracking-[-0.005em]">
                    {formatRatio(r)}
                  </div>
                  <div className="text-[11px] text-ink-mute mt-1">{r.benchmark}</div>
                  <p className="text-[12px] text-ink-soft leading-snug mt-2 line-clamp-3">
                    {r.commentary}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}


// ── Valuation tab ─────────────────────────────────────────────────────

function ValuationTab({ envelope }: { envelope: PublicCompanyEnvelope }) {
  const current = envelope.periods[0];
  const market = current?.market_metrics;
  const source = current?.currency as Currency;
  if (!current || !market) {
    return (
      <div className="rounded-2xl border border-rule bg-bg-2/30 p-6 text-[13px] text-ink-soft">
        Market metrics (market cap, EV, P/E, EV/EBITDA) are unavailable for this period.
        Try a more recent period or refresh.
      </div>
    );
  }
  return (
    <div className="space-y-6" data-testid="public-company-valuation">
      <section>
        <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-mute mb-2">
          Market valuation · as of {market.as_of}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <ValTile label="Market Cap"       value={<Money value={market.market_cap}       fromCurrency={source} compact />} />
          <ValTile label="Enterprise Value" value={<Money value={market.enterprise_value} fromCurrency={source} compact />} />
          <ValTile label="EV / EBITDA"      value={market.ev_ebitda != null ? `${market.ev_ebitda.toFixed(1)}×` : "—"} />
          <ValTile label="EV / EBIT"        value={market.ev_ebit != null   ? `${market.ev_ebit.toFixed(1)}×`   : "—"} />
          <ValTile label="EV / Revenue"     value={market.ev_revenue != null ? `${market.ev_revenue.toFixed(2)}×` : "—"} />
          <ValTile label="P / E"            value={market.pe_ratio != null  ? `${market.pe_ratio.toFixed(1)}×`  : "—"} />
          <ValTile label="P / B"            value={market.pb_ratio != null  ? `${market.pb_ratio.toFixed(1)}×`  : "—"} />
          <ValTile label="Dividend yield"   value={market.dividend_yield != null ? `${(market.dividend_yield * 100).toFixed(2)}%` : "—"} />
        </div>
      </section>
      <p className="text-[11.5px] text-ink-mute">
        DCF + Graham intrinsic value land in a follow-up release. Multiples-only here
        because for public companies, the market price is the consensus IV — DCF mainly
        adds value when the analyst overrides market assumptions on growth / discount rate.
      </p>
    </div>
  );
}

function ValTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-rule bg-surface p-4">
      <div className="text-[10.5px] uppercase tracking-[0.1em] font-semibold text-ink-mute">
        {label}
      </div>
      <div className="mt-1 font-serif text-[20px] text-ink tabular-nums leading-tight">
        {value}
      </div>
    </div>
  );
}


// ── Overview tab ──────────────────────────────────────────────────────

function OverviewTab({ envelope }: { envelope: PublicCompanyEnvelope }) {
  const mostRecent = envelope.periods[0];
  if (!mostRecent) return null;
  const h = mostRecent.headline;
  const source = mostRecent.currency as Currency;
  const market = mostRecent.market_metrics;

  return (
    <div data-testid="public-company-overview" className="space-y-6">
      {/* Period label */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-mute">
            Latest period
          </div>
          <div className="font-serif text-[24px] text-ink leading-tight tracking-[-0.005em]">
            FY ending {mostRecent.fiscal_period_end}
          </div>
        </div>
        <div className="text-[11px] text-ink-mute">
          Source: <span className="font-medium text-ink-soft">Nasdaq Sharadar SF1</span>
          {" · "}
          <span>{envelope.periods.length} periods loaded</span>
        </div>
      </div>

      {/* KPI grid — reuses the same <Money> component as the private dashboard,
          so the global RON/EUR/USD toggle Just Works. Source currency is USD
          for US-listed; the FX conversion path handles RON/EUR/USD display. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="public-company-kpi-grid">
        <KpiTile
          conceptKey="revenue"
          label="Revenue"
          value={h.revenue}
          source={source}
          sub={h.revenue ? `${(((h.ebitda ?? 0) / h.revenue) * 100).toFixed(1)}% EBITDA margin` : undefined}
        />
        <KpiTile
          conceptKey="ebitda"
          label="EBITDA"
          value={h.ebitda}
          source={source}
          sub={h.revenue && h.ebitda ? `${((h.ebitda / h.revenue) * 100).toFixed(1)}% margin` : undefined}
        />
        <KpiTile
          conceptKey="net_profit"
          label="Net profit"
          value={h.net_income}
          source={source}
          sub={h.revenue && h.net_income ? `${((h.net_income / h.revenue) * 100).toFixed(1)}% margin` : undefined}
        />
        <KpiTile
          conceptKey="total_assets"
          label="Total assets"
          value={h.total_assets}
          source={source}
          sub={h.total_equity && h.total_assets ? `${((h.total_equity / h.total_assets) * 100).toFixed(1)}% equity ratio` : undefined}
        />
      </div>

      {/* Second row — balance + cash flow + market metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile conceptKey="cash" label="Cash" value={h.cash} source={source} />
        <KpiTile conceptKey="total_debt" label="Total debt" value={h.total_debt} source={source} />
        <KpiTile conceptKey="operating_cash_flow" label="Operating CF" value={h.operating_cash_flow} source={source} />
        <KpiTile conceptKey="operating_cash_flow" label="Free cash flow" value={h.free_cash_flow} source={source} />
      </div>

      {/* Market metrics — only when present (most-recent period carries them) */}
      {market && (
        <div className="
          rounded-2xl border border-rule bg-bg-2/30 p-5
        ">
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-mute">
              Market metrics
            </div>
            <div className="text-[11px] text-ink-mute">
              as of {market.as_of}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricTile conceptKey="market_cap" label="Market cap" value={market.market_cap} source={source} />
            <MetricTile conceptKey="enterprise_value" label="Enterprise value" value={market.enterprise_value} source={source} />
            <RatioTile conceptKey="ev_ebitda_multiple" label="EV / EBITDA" value={market.ev_ebitda} suffix="×" />
            <RatioTile conceptKey="pe_ratio" label="P/E" value={market.pe_ratio} suffix="×" />
          </div>
        </div>
      )}

      {/* Quick nav to the deeper tabs */}
      <div className="text-[11.5px] text-ink-mute border-t border-rule/60 pt-4">
        Switch to the <strong>P&amp;L</strong>, <strong>Balance Sheet</strong>,
        <strong> Cash Flow</strong>, <strong>Ratios</strong>, or <strong>Valuation</strong> tabs
        above for the full statement views — same renderers as the private-company dashboard,
        powered by Sharadar SF1 fundamentals.
      </div>
    </div>
  );
}

// ── Small tile components ─────────────────────────────────────────────

function KpiTile({
  label,
  value,
  source,
  sub,
  conceptKey,
}: {
  label: string;
  value: number | null;
  source: Currency;
  sub?: string;
  /** Optional concept registry key — when set, the tile becomes a
   *  LearnableMetricCard (full-card tap → popover with formula +
   *  plain-English + source). When omitted, falls back to the plain
   *  card so unmapped metrics don't regress visually. */
  conceptKey?: string;
}) {
  if (conceptKey) {
    return (
      <LearnableMetricCard
        label={label}
        conceptKey={conceptKey}
        value={value ?? 0}
        display={value != null ? <Money value={value} fromCurrency={source} compact /> : "—"}
        sub={sub}
        tone="default"
        data-testid={`public-kpi-${conceptKey}`}
      />
    );
  }
  return (
    <div className="rounded-xl border border-rule bg-surface p-4">
      <div className="text-[10.5px] uppercase tracking-[0.12em] font-semibold text-ink-mute">
        {label}
      </div>
      <div className="mt-1 font-serif text-[20px] sm:text-[22px] text-ink leading-tight tracking-[-0.005em] tabular-nums">
        {value != null ? <Money value={value} fromCurrency={source} compact /> : "—"}
      </div>
      {sub && <div className="text-[11px] text-ink-mute mt-1">{sub}</div>}
    </div>
  );
}

function MetricTile({
  label,
  value,
  source,
  conceptKey,
}: {
  label: string;
  value: number | null;
  source: Currency;
  /** F5.0 Phase 6 — optional concept registry key. When set, the tile is
   *  rendered as a LearnableMetricCard so clicking opens the popover
   *  with plain-English + formula + sourceTrace. */
  conceptKey?: string;
}) {
  if (conceptKey) {
    return (
      <LearnableMetricCard
        label={label}
        conceptKey={conceptKey}
        value={value ?? 0}
        display={value != null ? <Money value={value} fromCurrency={source} compact /> : "—"}
        tone="default"
        data-testid={`public-market-${conceptKey}`}
      />
    );
  }
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.1em] font-semibold text-ink-mute">{label}</div>
      <div className="mt-0.5 font-serif text-[16px] text-ink tabular-nums">
        {value != null ? <Money value={value} fromCurrency={source} compact /> : "—"}
      </div>
    </div>
  );
}

function RatioTile({
  label,
  value,
  suffix = "",
  conceptKey,
}: {
  label: string;
  value: number | null;
  suffix?: string;
  /** F5.0 Phase 6 — optional concept registry key. */
  conceptKey?: string;
}) {
  if (conceptKey) {
    return (
      <LearnableMetricCard
        label={label}
        conceptKey={conceptKey}
        value={value ?? 0}
        display={value != null ? `${value.toFixed(1)}${suffix}` : "—"}
        tone="default"
        formatHint="ratio"
        data-testid={`public-market-${conceptKey}`}
      />
    );
  }
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.1em] font-semibold text-ink-mute">{label}</div>
      <div className="mt-0.5 font-serif text-[16px] text-ink tabular-nums">
        {value != null ? `${value.toFixed(1)}${suffix}` : "—"}
      </div>
    </div>
  );
}

// ── §24 inline error block ────────────────────────────────────────────

function ErrorBlock({
  error,
  ticker,
}: {
  error: NasdaqErrorEnvelope["error"];
  ticker: string;
}) {
  const friendly: Record<string, string> = {
    nasdaq_key_missing: "Nasdaq API key is not configured on the backend.",
    nasdaq_entitlement_missing: `Your Nasdaq subscription doesn't include the dataset needed for ${ticker}.`,
    nasdaq_not_found: `No public-company record found for ${ticker}. Double-check the ticker.`,
    nasdaq_rate_limited: "Nasdaq rate limit reached. Try again in a minute.",
    nasdaq_partial_data: `Some fields are unavailable from Nasdaq for ${ticker}.`,
    nasdaq_error: "Couldn't reach Nasdaq right now. Try again in a moment.",
  };
  const message = friendly[error.code] ?? error.message;
  return (
    <div className="
      rounded-2xl border border-amber-300/50 bg-amber-50/40
      dark:bg-amber-500/[0.08]
      px-5 py-4 mb-6
    ">
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="text-amber-700 dark:text-amber-300 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-amber-900 dark:text-amber-100">
            {message}
          </div>
          {error.message && error.message !== message && (
            <div className="text-[11.5px] text-amber-900/70 dark:text-amber-100/70 mt-1 font-mono">
              {error.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
