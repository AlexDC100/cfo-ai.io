// RiskRadar — 8 risk-category cards driven by /api/public/intelligence/risk-radar.
//
// Renders the universe-wide aggregation: each card shows the category score
// (0–100), severity level, the sectors + top tickers affected, the signal
// count, and the top 1–3 signals. Click a card to drill into the universe
// table filtered to the affected tickers — same pattern as MarketsOverview
// → handleExplore.
//
// Per brief §14. Per design plan §25.6, this is the Phase A surface that
// works WITHOUT a live news feed: signals come from the static sector
// library + cross-sector themes, computed_at refreshes on the 5-min cache.

import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Boxes,
  Cpu,
  DollarSign,
  Flame,
  Gavel,
  Globe,
  Loader2,
  TrendingDown,
  Users,
} from "lucide-react";
import {
  fetchRiskRadar,
  type RiskCategory,
  RISK_CATEGORY_BLURB,
  RISK_CATEGORY_LABEL,
  severityToBgClass,
  severityToTextClass,
  type Severity,
} from "@/lib/publicCompanyIntelligence";

interface Props {
  /** Click handler fired when the user clicks a card. The page uses this to
   *  switch from radar view → universe table filtered to the affected tickers. */
  onDrillToCategory?: (category: RiskCategory, tickers: string[]) => void;
}

// Lucide icon for each category — keeps the iconography consistent across
// cards (one icon per risk dimension). Easy to swap as we calibrate.
const CATEGORY_ICON: Record<RiskCategory, typeof Globe> = {
  geopolitical:    Globe,
  supply_chain:    Boxes,
  energy:          Flame,
  rates_credit:    DollarSign,
  fx:              TrendingDown,
  regulation:      Gavel,
  technology:      Cpu,
  consumer_demand: Users,
};

const CATEGORY_ORDER: RiskCategory[] = [
  "geopolitical",
  "supply_chain",
  "rates_credit",
  "energy",
  "technology",
  "consumer_demand",
  "regulation",
  "fx",
];

export function RiskRadar({ onDrillToCategory }: Props) {
  const radarQuery = useQuery({
    queryKey: ["intelligence", "risk-radar"],
    queryFn: fetchRiskRadar,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  if (radarQuery.isLoading) {
    return (
      <div className="rounded-2xl border border-rule bg-surface/60 p-10 flex items-center justify-center text-ink-soft">
        <Loader2 size={16} className="animate-spin mr-2" />
        <span className="text-[13px]">Computing risk radar…</span>
      </div>
    );
  }

  if (radarQuery.isError || !radarQuery.data) {
    return (
      <div className="rounded-2xl border border-alert/30 bg-alert/5 p-6 text-center text-[13px] text-alert">
        Couldn't load risk radar. Try refreshing.
      </div>
    );
  }

  const { categories, feed_status, computed_at } = radarQuery.data;

  return (
    <div className="space-y-4">
      {/* ── Header strip ──────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h2 className="font-serif text-[20px] sm:text-[22px] text-ink leading-tight">
            AI Risk Radar
          </h2>
          <p className="text-[12.5px] text-ink-soft mt-1 max-w-[640px] leading-relaxed">
            Macro-to-micro risk view across the 200-ticker universe. Click a card
            to drill into the affected companies.
          </p>
        </div>
        <FeedStatusBadge status={feed_status} computedAt={computed_at} />
      </div>

      {/* ── Card grid: 1 col mobile, 2 col tablet, 4 col desktop ─────── */}
      <div
        className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
        data-testid="risk-radar-grid"
      >
        {CATEGORY_ORDER.map((cat) => {
          const data = categories[cat];
          if (!data) return null;
          return (
            <RadarCard
              key={cat}
              category={cat}
              score={data.score}
              level={data.level}
              affectedSectors={data.affected_sectors}
              affectedTickers={data.affected_tickers}
              signalCount={data.signal_count}
              topSignalTitles={(data.top_signals ?? []).map((s) => s.title).slice(0, 2)}
              onClick={
                onDrillToCategory
                  ? () => onDrillToCategory(cat, data.affected_tickers)
                  : undefined
              }
            />
          );
        })}
      </div>

      {/* ── Disclosure footer ─────────────────────────────────────────── */}
      <div className="rounded-xl border border-rule/60 bg-bg-2/40 p-3.5 text-[11.5px] text-ink-mute leading-relaxed">
        Scores derived from the in-repo sector risk library + cross-sector
        themes (AI datacenter, Taiwan, Red Sea, EV demand, oil, rates, defense,
        GLP-1, datacenter power, consumer slowdown).{" "}
        {feed_status === "sector_model_only" && (
          <>
            Live news feed not connected — when a provider is wired up,
            real-time signals will overlay these defaults.
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Individual radar card
// ─────────────────────────────────────────────────────────────────────────

interface RadarCardProps {
  category: RiskCategory;
  score: number;
  level: Severity;
  affectedSectors: string[];
  affectedTickers: string[];
  signalCount: number;
  topSignalTitles: string[];
  onClick?: () => void;
}

function RadarCard({
  category,
  score,
  level,
  affectedSectors,
  affectedTickers,
  signalCount,
  topSignalTitles,
  onClick,
}: RadarCardProps) {
  const Icon = CATEGORY_ICON[category];
  const sevText = severityToTextClass(level);
  const sevBg = severityToBgClass(level);
  const interactive = Boolean(onClick);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!interactive}
      data-testid={`risk-radar-card-${category}`}
      data-category={category}
      data-level={level}
      className={`
        group relative w-full text-left
        rounded-2xl border border-rule bg-surface/80
        p-4 sm:p-5
        transition-all
        ${interactive
          ? "hover:border-brand/40 hover:bg-surface focus-visible:border-brand/60 cursor-pointer"
          : "cursor-default"}
        focus-visible:outline-none
        focus-visible:ring-2 focus-visible:ring-brand/30
      `}
    >
      {/* Header — icon + category + severity pill */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className={`inline-flex items-center justify-center h-9 w-9 rounded-lg ${sevBg} border ${sevText}`}>
          <Icon size={16} strokeWidth={1.75} />
        </div>
        <span
          className={`
            inline-flex items-center gap-1
            text-[10.5px] uppercase tracking-[0.1em] font-medium
            px-2 py-0.5 rounded-full border
            ${sevBg} ${sevText}
          `}
        >
          {level === "critical" && <AlertTriangle size={10} strokeWidth={2} />}
          {level}
        </span>
      </div>

      {/* Title + blurb */}
      <div className="mb-3">
        <div className="text-[13.5px] font-medium text-ink leading-tight">
          {RISK_CATEGORY_LABEL[category]}
        </div>
        <div className="text-[11.5px] text-ink-mute mt-1 leading-snug">
          {RISK_CATEGORY_BLURB[category]}
        </div>
      </div>

      {/* Score bar */}
      <div className="mb-3">
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium">
            Score
          </span>
          <span className={`text-[18px] font-semibold tabular-nums ${sevText}`}>
            {score}
            <span className="text-[10.5px] text-ink-mute font-normal ml-0.5">/100</span>
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-bg-2 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              level === "critical" ? "bg-alert" :
              level === "high"     ? "bg-orange-400" :
              level === "medium"   ? "bg-amber-400" :
                                     "bg-emerald-400"
            }`}
            style={{ width: `${Math.max(2, Math.min(100, score))}%` }}
          />
        </div>
      </div>

      {/* Sectors affected — short list */}
      {affectedSectors.length > 0 && (
        <div className="mb-2">
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-1">
            Sectors
          </div>
          <div className="flex flex-wrap gap-1">
            {affectedSectors.slice(0, 3).map((s) => (
              <span
                key={s}
                className="text-[11px] text-ink-soft bg-bg-2/60 border border-rule/60 rounded px-1.5 py-0.5"
              >
                {s}
              </span>
            ))}
            {affectedSectors.length > 3 && (
              <span className="text-[11px] text-ink-mute py-0.5">
                +{affectedSectors.length - 3}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Top tickers — small monospace chips */}
      {affectedTickers.length > 0 && (
        <div className="mb-2">
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-1">
            Companies
          </div>
          <div className="flex flex-wrap gap-1">
            {affectedTickers.slice(0, 5).map((t) => (
              <span
                key={t}
                className="text-[10.5px] font-mono text-ink-soft tabular-nums"
              >
                {t}
              </span>
            ))}
            {affectedTickers.length > 5 && (
              <span className="text-[10.5px] text-ink-mute">+{affectedTickers.length - 5}</span>
            )}
          </div>
        </div>
      )}

      {/* Top signals (titles only — full feed lives on Macro Signals tab) */}
      {topSignalTitles.length > 0 && (
        <div className="border-t border-rule/40 pt-2.5 mt-2.5">
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-1">
            {signalCount} signal{signalCount === 1 ? "" : "s"}
          </div>
          <ul className="space-y-1">
            {topSignalTitles.map((title, i) => (
              <li
                key={i}
                className="text-[11.5px] text-ink-soft leading-snug line-clamp-2"
              >
                · {title}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Interaction hint */}
      {interactive && (
        <div className="absolute top-3.5 right-3.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {/* nothing — hover indication is handled by border + bg */}
        </div>
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Feed status badge — shows "Sector model only" vs "Live feed active"
// ─────────────────────────────────────────────────────────────────────────

function FeedStatusBadge({
  status,
  computedAt,
}: {
  status: string;
  computedAt: string;
}) {
  const label =
    status === "live_feed_active"     ? "Live feed active"
    : status === "sector_model_only"  ? "Sector model only"
    :                                   "Feed not connected";

  const tone =
    status === "live_feed_active"
      ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30"
      : "bg-amber-400/10 text-amber-400 border-amber-400/30";

  let computedLabel = "";
  try {
    const d = new Date(computedAt);
    if (!isNaN(d.getTime())) {
      computedLabel = d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  } catch {
    /* ignore */
  }

  return (
    <div className="flex items-center gap-2">
      <span
        className={`
          inline-flex items-center gap-1.5
          h-7 px-2.5 rounded-full border
          text-[11px] font-medium
          ${tone}
        `}
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-current" />
        {label}
      </span>
      {computedLabel && (
        <span className="text-[11px] text-ink-mute">as of {computedLabel}</span>
      )}
    </div>
  );
}
