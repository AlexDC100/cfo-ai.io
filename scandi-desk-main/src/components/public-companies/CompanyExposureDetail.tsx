// CompanyExposureDetail — inline factor breakdown shown when a user clicks
// a ticker inside a RadarCard. Renders below the affected-tickers list,
// pushing the rest of the card down (other cards stay fixed).
//
// Three sections, each addresses "why does this company score X in this
// risk category?":
//   1. Header — ticker, country flag, sector, source-of-scoring badge
//   2. Category-context score bar — the current category's exposure for this ticker
//   3. Factor breakdown — main risks + 3 strongest exposures (geographic,
//      supply-chain, or financial-sensitivity) for this ticker
//
// Data: fetches CompanyExposureProfile via existing fetchTickerExposure().
// Graceful fallback when a ticker has only sector-default scoring (no per-
// company exposure profile yet) — shows the score + sector-defaulting hint
// instead of an error state.

import { useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import {
  fetchTickerExposure,
  type RiskCategory,
  type AffectedTickerRich,
  type ExposureSource,
  RISK_CATEGORY_LABEL,
} from "@/lib/publicCompanyIntelligence";

interface Props {
  ticker: AffectedTickerRich;
  category: RiskCategory;
  onClose: () => void;
}

// Short labels + tints for the source-provenance badge. Same chip style as
// the per-row badge in the RadarCard companies list — kept consistent so
// users learn "BVB" / "10-K" / "curated" once.
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

export function CompanyExposureDetail({ ticker, category, onClose }: Props) {
  const profileQuery = useQuery({
    queryKey: ["intelligence", "exposure", ticker.ticker],
    queryFn: () => fetchTickerExposure(ticker.ticker),
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: 1,
  });

  const flag = ticker.country === "RO" ? "🇷🇴 " : "";

  return (
    <div
      className="border-t border-rule/60 pt-3 mt-3 -mx-1 px-1 animate-in fade-in slide-in-from-top-1 duration-150"
      data-testid={`exposure-detail-${ticker.ticker}`}
    >
      {/* Header — ticker, sector, source, close */}
      <div className="flex items-start justify-between gap-2 mb-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-mono text-[13px] font-medium text-ink tabular-nums">
              {flag}
              {ticker.ticker}
            </span>
            <span className="text-[10.5px] text-ink-mute truncate">{ticker.sector}</span>
            <span
              className={`
                text-[10px] uppercase tracking-wide font-medium
                px-1.5 py-0.5 rounded border
                ${SOURCE_TINT[ticker.source] ?? SOURCE_TINT.sector_model}
              `}
            >
              {SOURCE_LABEL[ticker.source] ?? "sector"}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Close factor breakdown"
          className="shrink-0 -mr-1 p-1 text-ink-mute hover:text-ink rounded transition-colors"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      {/* Category-context score bar */}
      <div className="mb-3">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium">
            {RISK_CATEGORY_LABEL[category]} exposure
          </span>
          <span className="text-[12.5px] font-medium text-ink tabular-nums">
            {ticker.category_score.toFixed(2)}
          </span>
        </div>
        <ExposureBar score={ticker.category_score} prominent />
      </div>

      {/* Factor breakdown */}
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-1.5">
        Why
      </div>
      {profileQuery.isLoading ? (
        <div className="flex items-center gap-2 text-[11.5px] text-ink-mute py-2">
          <Loader2 size={11} className="animate-spin" />
          <span>Loading factor breakdown…</span>
        </div>
      ) : profileQuery.isError || !profileQuery.data ? (
        <div className="text-[11.5px] text-ink-mute italic leading-snug">
          Sector-default scoring — no per-company exposure profile loaded for{" "}
          {ticker.ticker} yet. Score reflects {ticker.sector} sector baseline.
        </div>
      ) : (
        <FactorBreakdown
          profile={profileQuery.data}
          category={category}
          confidence={ticker.confidence}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Factor breakdown — top risks + dominant exposures relevant to this category
// ─────────────────────────────────────────────────────────────────────────

interface FactorBreakdownProps {
  profile: {
    main_risks: { key: string; label: string; severity: string; explanation: string }[];
    geographic_exposure: Record<string, number>;
    supply_chain_exposure: Record<string, number>;
    financial_sensitivity: Record<string, number>;
    source: string;
  };
  category: RiskCategory;
  confidence: number;
}

function FactorBreakdown({ profile, category, confidence }: FactorBreakdownProps) {
  // Pick the most-relevant exposure dimension for this category. Geographic
  // dominates for geopolitical/fx/regulation; supply_chain dominates for
  // supply_chain/energy; financial_sensitivity for rates_credit/fx. Keeps
  // the panel focused — we show the dimension most likely to explain WHY
  // this category lit up.
  const dominantDim = pickDominantDimension(category);
  const dominantMap =
    dominantDim === "geographic"      ? profile.geographic_exposure
    : dominantDim === "supply_chain"  ? profile.supply_chain_exposure
    :                                   profile.financial_sensitivity;
  const dimLabel =
    dominantDim === "geographic"      ? "Geographic"
    : dominantDim === "supply_chain"  ? "Supply chain"
    :                                   "Financial sensitivity";

  const topExposures = Object.entries(dominantMap)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  const topRisks = (profile.main_risks ?? [])
    .slice(0, 3)
    .filter((r) => r.label);

  return (
    <div className="space-y-3">
      {/* Top exposures in the dominant dimension for this category */}
      {topExposures.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10.5px] text-ink-mute uppercase tracking-wide">
            {dimLabel}
          </div>
          <div className="space-y-1">
            {topExposures.map(([region, score]) => (
              <div key={region} className="flex items-center gap-2">
                <span className="text-[11px] text-ink-soft min-w-[80px] truncate">
                  {region}
                </span>
                <div className="flex-1 min-w-0">
                  <ExposureBar score={score} />
                </div>
                <span className="text-[10.5px] font-mono text-ink-mute tabular-nums w-9 text-right">
                  {score.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main risks — bullet list with severity tint */}
      {topRisks.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10.5px] text-ink-mute uppercase tracking-wide">
            Main risks
          </div>
          <ul className="space-y-0.5">
            {topRisks.map((r) => (
              <li
                key={r.key}
                className="text-[11px] text-ink-soft leading-snug flex gap-1.5"
              >
                <span
                  className={`
                    inline-block w-1 h-1 rounded-full mt-1.5 shrink-0
                    ${r.severity === "critical" ? "bg-alert"
                      : r.severity === "high"    ? "bg-orange-400"
                      : r.severity === "medium"  ? "bg-amber-400"
                                                 : "bg-emerald-400"}
                  `}
                />
                <span className="min-w-0">{r.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Confidence footer */}
      <div className="text-[10px] text-ink-mute italic">
        Profile source: {profile.source} · confidence {(confidence * 100).toFixed(0)}%
      </div>
    </div>
  );
}

// Map a radar category → which exposure dimension is most explanatory.
function pickDominantDimension(category: RiskCategory): "geographic" | "supply_chain" | "financial" {
  switch (category) {
    case "geopolitical":
    case "regulation":
    case "consumer_demand":
      return "geographic";
    case "supply_chain":
    case "energy":
    case "technology":
      return "supply_chain";
    case "rates_credit":
    case "fx":
      return "financial";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Exposure bar — 0.0-1.0 → 0-100% width, color-tinted by severity threshold
// ─────────────────────────────────────────────────────────────────────────
// Green <0.5  (low exposure)
// Amber 0.5-0.7  (medium)
// Red >0.7  (high)
// Exported so RadarCard can use the same widget for its per-row mini-bars.

export function ExposureBar({
  score,
  prominent = false,
}: {
  score: number;
  prominent?: boolean;
}) {
  const pct = Math.max(2, Math.min(100, score * 100));
  const tint =
    score > 0.7 ? "bg-alert"
    : score >= 0.5 ? "bg-amber-400"
                   : "bg-emerald-400";
  return (
    <div
      className={`
        w-full rounded-full bg-bg-2 overflow-hidden
        ${prominent ? "h-2" : "h-1.5"}
      `}
    >
      <div
        className={`h-full rounded-full transition-all ${tint}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
