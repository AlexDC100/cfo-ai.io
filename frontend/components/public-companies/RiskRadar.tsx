// RiskRadar — 8 risk-category cards driven by /api/public/intelligence/risk-radar.
//
// Per-card rendering:
//   · Header  — icon, category label, severity pill
//   · Score   — 0-100 bar
//   · Sectors — short chip list
//   · Companies — affected_tickers_rich rows with:
//       · 🇷🇴 emoji prefix for country='RO' (no Romania filter toggle —
//         country is metadata, not filter axis)
//       · exposure-bar per row (0.0-1.0 score → 0-100% width, green<0.5
//         amber 0.5-0.7 red >0.7)
//       · source-provenance badge (sector / BVB / 10-K / curated)
//       · clicking a row expands CompanyExposureDetail inline below
//   · Structural-correlation footnote — when this category overlaps a
//     documented sibling, e.g. "Shares 8 of 12 with Geopolitical — both
//     driven by Semiconductors (Taiwan exposure)." Italic, soft tint,
//     visually distinct from a warning. The trust signal that turns
//     documented overlap from a bug-shaped artifact into product honesty.
//   · Signals — top 1-2 titles
//
// One global "expanded ticker" state — clicking a ticker in one card
// collapses any previously expanded ticker (same or different card). Keeps
// the page focused on one drill-down at a time.

import { useState } from "react";
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
  type AffectedTickerRich,
  type ExposureSource,
  type RiskCategory,
  type RiskRadarCategory,
  type RiskRadarResponse,
  type StructuralCorrelation,
  RISK_CATEGORY_BLURB,
  RISK_CATEGORY_LABEL,
  severityToBgClass,
  severityToTextClass,
  type Severity,
} from "@/lib/publicCompanyIntelligence";
import {
  CompanyExposureDetail,
  ExposureBar,
} from "@/components/public-companies/CompanyExposureDetail";

interface Props {
  /** Click handler fired when the user clicks a card's category header.
   *  The page uses this to switch from radar view → universe table filtered
   *  to the affected tickers. NOT fired by ticker-row clicks (those expand
   *  CompanyExposureDetail inline instead). */
  onDrillToCategory?: (category: RiskCategory, tickers: string[]) => void;
}

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

// Short labels for the source-provenance chip. Kept in sync with the same
// table in CompanyExposureDetail.tsx (single source of truth would be nice;
// for now both reference the ExposureSource type so any new value triggers
// a TS error here too).
const SOURCE_LABEL: Record<ExposureSource, string> = {
  sector_model: "sector",
  sec_filing: "10-K",
  operator_curated: "curated",
  bvb_override: "BVB",
};

const SOURCE_TINT: Record<ExposureSource, string> = {
  sector_model: "bg-bg-2/60 text-ink-mute border-rule/60",
  sec_filing: "bg-sky-400/10 text-sky-500 border-sky-400/30",
  operator_curated: "bg-amber-400/10 text-amber-500 border-amber-400/30",
  bvb_override: "bg-indigo-400/10 text-indigo-500 border-indigo-400/30",
};

export function RiskRadar({ onDrillToCategory }: Props) {
  const radarQuery = useQuery({
    queryKey: ["intelligence", "risk-radar"],
    queryFn: fetchRiskRadar,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  // Single global expanded-ticker state. `{ category, ticker }` so clicking
  // the same ticker in the same card collapses, but clicking the same
  // ticker in a DIFFERENT card opens the new card's expansion (since the
  // context category changes).
  const [expanded, setExpanded] = useState<{
    category: RiskCategory;
    ticker: string;
  } | null>(null);

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
            Macro-to-micro risk view across the universe (US-listed + Romanian
            BVB). Click a company row to see its factor breakdown; click a
            card header to filter the universe table.
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
              data={data}
              allCategories={categories}
              expandedTicker={
                expanded?.category === cat ? expanded.ticker : null
              }
              onExpandTicker={(ticker) =>
                setExpanded((cur) =>
                  cur?.category === cat && cur.ticker === ticker
                    ? null
                    : { category: cat, ticker },
                )
              }
              onCategoryHeaderClick={
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
        themes (AI datacenter, Taiwan, Red Sea, EV demand, oil, rates,
        defense, GLP-1, datacenter power, consumer slowdown). Per-ticker
        scores reflect company-specific exposure profiles where available
        (SEC filings, BVB overrides, operator-curated), sector defaults
        otherwise — see the source chip on each row.{" "}
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
  data: RiskRadarCategory;
  allCategories: Record<RiskCategory, RiskRadarCategory>;
  expandedTicker: string | null;
  onExpandTicker: (ticker: string) => void;
  onCategoryHeaderClick?: () => void;
}

function RadarCard({
  category,
  data,
  allCategories,
  expandedTicker,
  onExpandTicker,
  onCategoryHeaderClick,
}: RadarCardProps) {
  const Icon = CATEGORY_ICON[category];
  const sevText = severityToTextClass(data.level);
  const sevBg = severityToBgClass(data.level);
  const rich: AffectedTickerRich[] = data.affected_tickers_rich ?? [];
  const correlations: StructuralCorrelation[] = data.structural_correlations ?? [];
  const expandedRow = rich.find((r) => r.ticker === expandedTicker);

  return (
    <div
      data-testid={`risk-radar-card-${category}`}
      data-category={category}
      data-level={data.level}
      className="
        group relative w-full text-left
        rounded-2xl border border-rule bg-surface/80
        p-4 sm:p-5
        transition-colors
        focus-within:border-brand/30
      "
    >
      {/* Header — icon + category + severity pill — click goes to category drill */}
      <button
        type="button"
        onClick={onCategoryHeaderClick}
        disabled={!onCategoryHeaderClick}
        className={`
          w-full flex items-start justify-between gap-2 mb-3
          ${onCategoryHeaderClick
            ? "cursor-pointer hover:opacity-90"
            : "cursor-default"}
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 rounded
        `}
      >
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
          {data.level === "critical" && <AlertTriangle size={10} strokeWidth={2} />}
          {data.level}
        </span>
      </button>

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
            {data.score}
            <span className="text-[10.5px] text-ink-mute font-normal ml-0.5">/100</span>
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-bg-2 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              data.level === "critical" ? "bg-alert" :
              data.level === "high"     ? "bg-orange-400" :
              data.level === "medium"   ? "bg-amber-400" :
                                          "bg-emerald-400"
            }`}
            style={{ width: `${Math.max(2, Math.min(100, data.score))}%` }}
          />
        </div>
      </div>

      {/* Sectors affected — short chip list */}
      {data.affected_sectors.length > 0 && (
        <div className="mb-3">
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-1">
            Sectors
          </div>
          <div className="flex flex-wrap gap-1">
            {data.affected_sectors.slice(0, 3).map((s) => (
              <span
                key={s}
                className="text-[11px] text-ink-soft bg-bg-2/60 border border-rule/60 rounded px-1.5 py-0.5"
              >
                {s}
              </span>
            ))}
            {data.affected_sectors.length > 3 && (
              <span className="text-[11px] text-ink-mute py-0.5">
                +{data.affected_sectors.length - 3}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Companies — rich rows with exposure bars + 🇷🇴 flag + source chip */}
      {rich.length > 0 ? (
        <div className="mb-3">
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-1.5">
            Companies
          </div>
          <div className="space-y-1">
            {rich.slice(0, 6).map((row) => (
              <TickerRow
                key={row.ticker}
                row={row}
                isExpanded={row.ticker === expandedTicker}
                onClick={() => onExpandTicker(row.ticker)}
              />
            ))}
            {rich.length > 6 && (
              <div className="text-[10.5px] text-ink-mute pl-1 pt-0.5">
                +{rich.length - 6} more
              </div>
            )}
          </div>
        </div>
      ) : (
        // Back-compat: legacy bare-list when affected_tickers_rich not present
        data.affected_tickers.length > 0 && (
          <div className="mb-3">
            <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-1">
              Companies
            </div>
            <div className="flex flex-wrap gap-1">
              {data.affected_tickers.slice(0, 6).map((t) => (
                <span key={t} className="text-[10.5px] font-mono text-ink-soft tabular-nums">
                  {t}
                </span>
              ))}
            </div>
          </div>
        )
      )}

      {/* Expansion — factor breakdown for clicked ticker */}
      {expandedRow && (
        <CompanyExposureDetail
          ticker={expandedRow}
          category={category}
          onClose={() => onExpandTicker(expandedRow.ticker)}
        />
      )}

      {/* Structural-correlation footnote — the trust signal. Each correlation
          gets its own line with named sectors + named driver. Italic + muted
          tint so it reads as explanation, not warning. */}
      {correlations.length > 0 && (
        <div
          className="border-t border-rule/40 pt-2.5 mt-3 space-y-1.5"
          data-testid={`structural-correlation-${category}`}
        >
          {correlations.map((corr) => (
            <CorrelationFootnote
              key={corr.related}
              category={category}
              corr={corr}
              allCategories={allCategories}
            />
          ))}
        </div>
      )}

      {/* Top signals (titles only — full feed lives on Macro Signals tab) */}
      {data.top_signals.length > 0 && (
        <div className="border-t border-rule/40 pt-2.5 mt-2.5">
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-1">
            {data.signal_count} signal{data.signal_count === 1 ? "" : "s"}
          </div>
          <ul className="space-y-1">
            {data.top_signals.slice(0, 2).map((s, i) => (
              <li
                key={i}
                className="text-[11.5px] text-ink-soft leading-snug line-clamp-2"
              >
                · {s.title}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Per-ticker row — flag, ticker, exposure bar, source chip
// ─────────────────────────────────────────────────────────────────────────

function TickerRow({
  row,
  isExpanded,
  onClick,
}: {
  row: AffectedTickerRich;
  isExpanded: boolean;
  onClick: () => void;
}) {
  const flag = row.country === "RO" ? "🇷🇴 " : "";
  const sourceLabel = SOURCE_LABEL[row.source] ?? "sector";
  const sourceTint = SOURCE_TINT[row.source] ?? SOURCE_TINT.sector_model;

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`radar-row-${row.ticker}`}
      data-country={row.country}
      className={`
        w-full text-left rounded px-1.5 py-1
        transition-colors
        ${isExpanded
          ? "bg-brand/5 ring-1 ring-brand/20"
          : "hover:bg-bg-2/50"}
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30
      `}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11.5px] text-ink tabular-nums min-w-[64px] shrink-0">
          {flag}
          {row.ticker}
        </span>
        <div className="flex-1 min-w-0">
          <ExposureBar score={row.category_score} />
        </div>
        <span className="text-[10px] font-mono text-ink-mute tabular-nums w-9 text-right shrink-0">
          {row.category_score.toFixed(2)}
        </span>
        <span
          className={`
            text-[9.5px] uppercase tracking-wide font-medium shrink-0
            px-1 py-px rounded border whitespace-nowrap
            ${sourceTint}
          `}
          title={`Source: ${row.source}`}
        >
          {sourceLabel}
        </span>
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Structural-correlation footnote — the trust signal
// ─────────────────────────────────────────────────────────────────────────
// Renders ONE line per documented correlation pair, naming the OTHER
// category, the overlap count (set-intersection of affected_tickers_rich),
// and the human-readable driver. Italic + muted color distinguishes it
// from a warning — this is explanation, not error.
//
// Example output:
//   "Shares 8 of 12 with Geopolitical — both driven by Semiconductors
//    (Taiwan exposure)."

function CorrelationFootnote({
  category,
  corr,
  allCategories,
}: {
  category: RiskCategory;
  corr: StructuralCorrelation;
  allCategories: Record<RiskCategory, RiskRadarCategory>;
}) {
  const ourRich = allCategories[category]?.affected_tickers_rich ?? [];
  const theirRich = allCategories[corr.related]?.affected_tickers_rich ?? [];

  // Use the affected_tickers (legacy bare-list) as the back-compat fallback
  // if rich payload not present. The N/M ratio is the empirical overlap
  // count — surfaces the magnitude of the correlation in concrete terms.
  const ourSet = new Set(
    ourRich.length > 0
      ? ourRich.map((r) => r.ticker)
      : (allCategories[category]?.affected_tickers ?? []),
  );
  const theirTickers =
    theirRich.length > 0
      ? theirRich.map((r) => r.ticker)
      : (allCategories[corr.related]?.affected_tickers ?? []);
  const shared = theirTickers.filter((t) => ourSet.has(t)).length;
  const total = theirTickers.length;

  // Render nothing if we can't compute overlap — better silent than half-rendered.
  if (total === 0) return null;

  return (
    <div className="text-[10.5px] text-ink-mute leading-snug italic">
      Shares <span className="font-medium tabular-nums not-italic">{shared}</span>
      <span> of </span>
      <span className="font-medium tabular-nums not-italic">{total}</span>
      <span> with </span>
      <span className="font-medium not-italic">
        {RISK_CATEGORY_LABEL[corr.related]}
      </span>
      <span> — both driven by </span>
      <span className="text-ink-soft not-italic">{corr.drivers}</span>
      <span>.</span>
    </div>
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
