// Benchmarking panel — peer-group medians + range for the headline metrics.
//
// 2026-08-04 (PCI redesign) — benchmark contamination fix. The old panel
// computed ONE median across the whole demo watchlist, silently blending
// BVB names (CFH, TLV) with NVDA/TSLA/PEP — a Romanian food processor
// "lagging" NVIDIA's EBITDA margin is not a finding, it's a category
// error. Now:
//
//   · The watchlist is split into GROUPS by listing — "Peers BVB"
//     (watchlist BVB rows ∪ the user's own added peers, resolved against
//     the loaded universe) vs "Global"; sector subgroups materialize
//     automatically at n ≥ 3 (see pciData.buildBenchGroups).
//   · ALL stats (median, P25/P75, leader/laggard) are computed strictly
//     per group. Every stat carries its n=.
//   · Default selected group follows the active workspace's industry
//     (sector subgroup when one exists, else Peers BVB).
//   · Tiles are clickable → a drill-down panel with per-company
//     horizontal bars for that metric across the ACTIVE group, with the
//     user's own company overlaid as a highlighted "Compania ta" bar
//     when the loaded period carries that metric.
//
// Also fixes a latent leader/laggard bug: the old code indexed the
// FILTERED value list back into the UNFILTERED row list, so any row with
// a missing metric shifted the leader attribution onto the wrong company.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Layers,
  Percent,
  Scale,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import { DEMO_WATCHLIST, type WatchlistRow } from "@/lib/publicCompanyWatchlist";
import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import { useBenchmarkPeers } from "@/lib/benchmarkPeersStore";
import { Amount } from "@/components/instrument/Amount";
import { Chip as StateChip } from "@/components/instrument/Panel";
import { CompanyLogo } from "./CompanyLogo";
import {
  buildBenchGroups,
  defaultBenchGroupKey,
  type BenchGroup,
  type WorkspaceBenchMetrics,
} from "./pciData";
import "./pciI18n";

interface Props {
  rows?: WatchlistRow[];
  /** Loaded universe — resolves the user's added peers into metric rows. */
  universeRows?: PublicCompanyFinancialSnapshot[];
  /** "Compania ta" metrics for the drill-down overlay (null → no overlay). */
  workspace?: WorkspaceBenchMetrics | null;
  /** Universe sector matching the active workspace's industry — picks the
   *  default group. */
  workspaceSector?: string | null;
}

type MetricKey =
  | "revenue_growth_pct"
  | "ebitda_margin_pct"
  | "net_debt_to_ebitda"
  | "fcf_yield_pct"
  | "ev_ebitda"
  | "dividend_yield_pct";

interface Metric {
  key: MetricKey;
  labelKey: string;
  shortKey: string;
  icon: typeof Activity;
  unit: "pct" | "x";
  goodHigh: boolean; // affects leader/laggard + drill sort direction
  /** Reads the workspace's value for the overlay; undefined = metric is
   *  market-linked and a private company cannot have it. */
  you?: (w: WorkspaceBenchMetrics) => number | null;
}

const METRICS: Metric[] = [
  { key: "revenue_growth_pct", labelKey: "pci.bench.metric.growth", shortKey: "pci.bench.metric.growthShort", icon: TrendingUp, unit: "pct", goodHigh: true, you: (w) => w.revenue_growth_pct },
  { key: "ebitda_margin_pct", labelKey: "pci.bench.metric.ebitda", shortKey: "pci.bench.metric.ebitdaShort", icon: Percent, unit: "pct", goodHigh: true, you: (w) => w.ebitda_margin_pct },
  { key: "net_debt_to_ebitda", labelKey: "pci.bench.metric.leverage", shortKey: "pci.bench.metric.leverageShort", icon: Scale, unit: "x", goodHigh: false, you: (w) => w.net_debt_to_ebitda },
  { key: "fcf_yield_pct", labelKey: "pci.bench.metric.fcf", shortKey: "pci.bench.metric.fcfShort", icon: Wallet, unit: "pct", goodHigh: true },
  { key: "ev_ebitda", labelKey: "pci.bench.metric.evEbitda", shortKey: "pci.bench.metric.evEbitdaShort", icon: Layers, unit: "x", goodHigh: false },
  { key: "dividend_yield_pct", labelKey: "pci.bench.metric.dividend", shortKey: "pci.bench.metric.dividendShort", icon: Activity, unit: "pct", goodHigh: true },
];

export function BenchmarkingPanel({
  rows = DEMO_WATCHLIST,
  universeRows = [],
  workspace = null,
  workspaceSector = null,
}: Props) {
  const { t } = useTranslation();
  const peers = useBenchmarkPeers();

  const groups = useMemo(
    () => buildBenchGroups(rows, universeRows, peers.map((p) => p.ticker)),
    [rows, universeRows, peers],
  );

  const [groupKey, setGroupKey] = useState<string | null>(null);
  const activeKey =
    groupKey && groups.some((g) => g.key === groupKey)
      ? groupKey
      : defaultBenchGroupKey(groups, workspaceSector);
  const active = groups.find((g) => g.key === activeKey) ?? groups[0];

  const [drill, setDrill] = useState<MetricKey | null>(null);

  if (!active) return null;

  const groupLabel = (g: BenchGroup) => (g.labelKey ? t(g.labelKey) : g.label ?? g.key);

  return (
    <section data-testid="public-companies-benchmark-panel">
      {/* Section header — the panel-header voice (13px caps), no serif on
          authenticated screens. */}
      <div className="mb-4">
        <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-ink-soft">
          {t("pci.bench.title")}
        </h2>
        <p className="text-[12px] text-ink-soft mt-1 max-w-[640px]">
          {t("pci.bench.subtitle")}
        </p>
      </div>

      {/* Group selector — never blended: exactly one group is active and
          every stat below reads only that group's rows. */}
      <div
        data-testid="benchmark-group-chips"
        className="
          mb-4 flex gap-1.5 overflow-x-auto pb-1 -mb-1 sm:flex-wrap sm:overflow-visible sm:pb-0
          [scrollbar-width:none] [&::-webkit-scrollbar]:hidden
        "
      >
        {groups.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => {
              setGroupKey(g.key);
              setDrill(null);
            }}
            aria-pressed={g.key === active.key}
            data-testid={`benchmark-group-${g.key}`}
            className={`
              shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-full border
              text-[11.5px] font-medium transition-colors duration-micro cursor-pointer
              ${g.key === active.key
                ? "border-brand/50 bg-brand-tint text-brand-dark dark:text-brand-light"
                : "border-rule bg-surface text-ink hover:bg-bg-2 hover:border-rule-strong"}
            `}
          >
            {groupLabel(g)}
            <span
              className={`font-mono text-[10px] tabular-nums ${
                g.key === active.key ? "" : "text-ink-soft"
              }`}
            >
              {t("pci.bench.n", { n: g.rows.length })}
            </span>
          </button>
        ))}
      </div>

      <div className="cards-stagger grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {METRICS.map((m) => (
          <BenchmarkTile
            key={m.key}
            metric={m}
            rows={active.rows}
            active={drill === m.key}
            onClick={() => setDrill((cur) => (cur === m.key ? null : m.key))}
          />
        ))}
      </div>

      {drill && (
        <DrillDownPanel
          metric={METRICS.find((m) => m.key === drill)!}
          group={active}
          groupLabel={groupLabel(active)}
          workspace={workspace}
          onClose={() => setDrill(null)}
        />
      )}
    </section>
  );
}

// ── Metric tile ──────────────────────────────────────────────────────────

function BenchmarkTile({
  metric,
  rows,
  active,
  onClick,
}: {
  metric: Metric;
  rows: WatchlistRow[];
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  // Pair rows with values FIRST, then filter — leader/laggard attribution
  // stays aligned with the company it belongs to.
  const pairs = rows
    .map((r) => [r, r[metric.key] as number] as const)
    .filter(([, v]) => Number.isFinite(v));
  if (!pairs.length) return null;

  const sorted = [...pairs].sort((a, b) => a[1] - b[1]).map(([, v]) => v);
  const med = quantile(sorted, 0.5);
  const p25 = quantile(sorted, 0.25);
  const p75 = quantile(sorted, 0.75);

  const best = pairs.reduce((acc, cur) =>
    (metric.goodHigh ? cur[1] > acc[1] : cur[1] < acc[1]) ? cur : acc,
  );
  const worst = pairs.reduce((acc, cur) =>
    (metric.goodHigh ? cur[1] < acc[1] : cur[1] > acc[1]) ? cur : acc,
  );

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={`public-companies-benchmark-${metric.key}`}
      className={`
        relative flex flex-col rounded-md border bg-surface text-left cursor-pointer
        transition-colors duration-micro
        ${active ? "border-brand/60" : "border-rule hover:border-rule-strong"}
      `}
    >
      <div className="p-4 w-full">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] uppercase tracking-[0.1em] font-medium text-ink-soft">
            {t(metric.shortKey)}
          </span>
          <span
            className="font-mono text-[10px] tabular-nums text-ink-soft"
            data-testid={`benchmark-n-${metric.key}`}
          >
            {t("pci.bench.n", { n: pairs.length })}
          </span>
        </div>

        <div className="mt-2.5">
          <div className="text-[10.5px] text-ink-soft">{t("pci.bench.median")}</div>
          <MetricAmount
            value={med}
            unit={metric.unit}
            className="text-[24px] font-medium leading-tight text-ink"
          />
          <div className="mt-1 flex items-baseline gap-1 text-[10.5px] text-ink-soft">
            P25 <MetricAmount value={p25} unit={metric.unit} className="text-[10.5px]" />
            <span aria-hidden>·</span>
            P75 <MetricAmount value={p75} unit={metric.unit} className="text-[10.5px]" />
          </div>
        </div>
      </div>

      {/* Bottom sleeve — leader + laggard within THIS group. */}
      <div className="mt-auto w-full border-t border-rule-soft bg-bg-2 px-4 py-2.5 space-y-1 rounded-b-md">
        <LeaderRow
          icon={<ArrowUp size={11} className="text-success" />}
          label={t("pci.bench.leader")}
          ticker={best[0].ticker}
          value={<MetricAmount value={best[1]} unit={metric.unit} className="text-[11px] text-ink-soft" />}
        />
        <LeaderRow
          icon={<ArrowDown size={11} className="text-ink-soft" />}
          label={t("pci.bench.laggard")}
          ticker={worst[0].ticker}
          value={<MetricAmount value={worst[1]} unit={metric.unit} className="text-[11px] text-ink-soft" />}
        />
      </div>
    </button>
  );
}

function LeaderRow({
  icon, label, ticker, value,
}: { icon: React.ReactNode; label: string; ticker: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11.5px]">
      <span className="inline-flex items-center gap-1 text-ink-soft">
        {icon} {label}
      </span>
      <span className="inline-flex items-baseline gap-1.5 text-ink">
        <span className="font-mono font-medium">{ticker}</span>
        {value}
      </span>
    </div>
  );
}

// ── Drill-down — per-company bars across the active group ────────────────

function DrillDownPanel({
  metric,
  group,
  groupLabel,
  workspace,
  onClose,
}: {
  metric: Metric;
  group: BenchGroup;
  groupLabel: string;
  workspace: WorkspaceBenchMetrics | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  interface Bar {
    ticker: string;
    name: string;
    value: number;
    you?: boolean;
  }

  const bars: Bar[] = group.rows
    .map((r) => ({ ticker: r.ticker, name: r.name, value: r[metric.key] as number }))
    .filter((b) => Number.isFinite(b.value));

  const youValue = workspace && metric.you ? metric.you(workspace) : null;
  const youSupported = !!metric.you;
  if (workspace && youValue != null && Number.isFinite(youValue)) {
    bars.push({ ticker: "—", name: workspace.name, value: youValue, you: true });
  }

  // Best-first ordering; bar width normalized over the value span so
  // negatives render too (minimum sliver width keeps every bar visible).
  bars.sort((a, b) => (metric.goodHigh ? b.value - a.value : a.value - b.value));
  const min = Math.min(...bars.map((b) => b.value));
  const max = Math.max(...bars.map((b) => b.value));
  const span = max - min;
  const widthPct = (v: number) => (span === 0 ? 100 : 6 + ((v - min) / span) * 94);

  if (!bars.length) return null;

  return (
    <div
      data-testid={`benchmark-drill-${metric.key}`}
      className="mt-3 rounded-md border border-rule bg-surface p-4 animate-in fade-in slide-in-from-top-1 duration-overlay"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[13px] font-medium text-ink">
            {t("pci.bench.drillTitle", { metric: t(metric.labelKey), group: groupLabel })}
          </div>
          <div className="font-mono text-[10.5px] text-ink-soft tabular-nums mt-0.5">
            {t("pci.bench.n", { n: bars.filter((b) => !b.you).length })}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("pci.bench.close")}
          className="h-11 w-11 -m-2 flex items-center justify-center text-ink-soft hover:text-ink transition-colors"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      <div className="mt-3 space-y-1.5">
        {bars.map((b) => (
          <div
            key={`${b.ticker}-${b.you ? "you" : "row"}`}
            className="flex items-center gap-2.5 min-w-0"
            data-testid={b.you ? "benchmark-drill-you" : `benchmark-drill-row-${b.ticker}`}
          >
            <span className="w-[92px] shrink-0 flex items-center gap-1.5 min-w-0">
              {b.you ? (
                <StateChip tone="accent" className="truncate text-[9.5px]">
                  {t("pci.bench.you")}
                </StateChip>
              ) : (
                <>
                  <CompanyLogo ticker={b.ticker} variant="monogram" size={16} className="rounded-sm" />
                  <span className="font-mono text-[10.5px] font-medium text-ink tabular-nums truncate">
                    {b.ticker}
                  </span>
                </>
              )}
            </span>
            <div className="flex-1 min-w-0 h-4 rounded-sm bg-bg-2 overflow-hidden">
              <div
                className={`h-full rounded-sm transition-[width] duration-overlay ${
                  b.you ? "bg-brand" : "bg-brand/30"
                }`}
                style={{ width: `${widthPct(b.value)}%` }}
              />
            </div>
            <span className="w-[64px] shrink-0 text-right">
              <MetricAmount value={b.value} unit={metric.unit} className="text-[11px] text-ink" />
            </span>
          </div>
        ))}
      </div>

      {/* Overlay honesty note — metric exists for listed companies but
          not for the private workspace (market-linked, or missing from
          the loaded period). */}
      {workspace && (!youSupported || youValue == null) && (
        <div className="mt-3 text-[10.5px] text-ink-soft italic">
          {t("pci.bench.noOverlay")}
        </div>
      )}
    </div>
  );
}

// ── Math / formatting ────────────────────────────────────────────────────

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

/** The one way a benchmark figure renders — through <Amount>, so mono
 *  tabular + locale come for free. Percent values arrive in percentage
 *  POINTS from the watchlist rows; <Amount kind="percent"> takes ratios. */
function MetricAmount({
  value,
  unit,
  className,
}: {
  value: number;
  unit: "pct" | "x";
  className?: string;
}) {
  if (unit === "pct") {
    return <Amount kind="percent" value={value / 100} fractionDigits={1} className={className} />;
  }
  return <Amount kind="multiple" value={value} className={className} />;
}
