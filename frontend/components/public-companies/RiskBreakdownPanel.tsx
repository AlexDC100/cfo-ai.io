// RiskBreakdownPanel — per-ticker risk score with 7-category breakdown.
//
// Used by:
//   · StockDetailDrawer's Risk tab (per-ticker)
//   · Future per-company AI Market Read surface
//
// Calls /api/public/intelligence/companies/{ticker}/risk-score. The
// endpoint returns the deterministic risk score from risk_scoring_engine.py
// + top 3 risks + top 3 opportunities + a deterministic explanation.
//
// A refused score is null with its reason on `refusals` (engine ruling
// 2026-09-15: absent is never a neutral number). This reader renders the
// refusal sentence in place of the number — it used to run the level ladder
// on a null category (`null >= 25` is false, so "low") and draw a 2% bar,
// which styled "Financial / Operational — low" on every universe ticker
// while the explanation said the composite was unavailable.
//
// R-PUBLIC-ABSENT (2026-09-19): a category the row's data producer can
// never fill is DROPPED (null, refusal code `risk_category_dropped`), its
// weight redistributed, and the engine states what the composite covers in
// `coverage`. This reader renders that as "not scored" with the reason and
// prints the applied weights from the block (TC-10) — never a level, never
// a bar, never "unavailable" (that word is this company's own gap).

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, TrendingUp } from "lucide-react";
import {
  categoryDropFor,
  fetchTickerRiskScore,
  scoreRefusalFor,
  type PublicCompanyRiskScore,
  type RiskCategoryScores,
  type ScoreCoverage,
  severityToBgClass,
  severityToTextClass,
} from "@/lib/publicCompanyIntelligence";

interface Props {
  ticker: string;
}

export function RiskBreakdownPanel({ ticker }: Props) {
  const q = useQuery({
    queryKey: ["intelligence", "risk-score", ticker.toUpperCase()],
    queryFn: () => fetchTickerRiskScore(ticker),
    staleTime: 3 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    enabled: Boolean(ticker),
  });

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-ink-soft">
        <Loader2 size={16} className="animate-spin mr-2" />
        <span className="text-[13px]">Computing risk profile…</span>
      </div>
    );
  }

  if (q.isError || !q.data) {
    return (
      <div className="rounded-xl border border-alert/30 bg-alert/5 p-4 text-[13px] text-alert">
        Couldn't load risk profile.{" "}
        <button onClick={() => q.refetch()} className="underline">
          Retry
        </button>
      </div>
    );
  }

  const score = q.data;

  return (
    <div className="space-y-5">
      <HeadlineCard score={score} />
      <CategoryGrid score={score} />
      <TopRisksList score={score} />
      <TopOpportunitiesList score={score} />
      <Disclosure confidence={score.confidence} />
    </div>
  );
}

// ─── Headline card ──────────────────────────────────────────────────────

export function HeadlineCard({ score }: { score: PublicCompanyRiskScore }) {
  if (score.overall_risk_score === null || score.risk_level === null) {
    const refusal = scoreRefusalFor(score, "overall");
    return (
      <div
        className="rounded-2xl border border-rule bg-surface/80 p-5"
        data-testid="risk-composite-unavailable"
      >
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <span className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium">
            Composite risk
          </span>
          <span className="inline-flex items-center text-[10.5px] uppercase tracking-[0.1em] font-medium px-2 py-0.5 rounded-full border border-rule text-ink-mute">
            unavailable
          </span>
        </div>
        <p className="text-[12.5px] text-ink-soft leading-relaxed">
          {refusal?.text ?? score.explanation}
        </p>
      </div>
    );
  }
  const sevText = severityToTextClass(score.risk_level);
  const sevBg = severityToBgClass(score.risk_level);
  return (
    <div className="rounded-2xl border border-rule bg-surface/80 p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <span className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium">
          Composite risk
        </span>
        <span
          className={`
            inline-flex items-center gap-1
            text-[10.5px] uppercase tracking-[0.1em] font-medium
            px-2 py-0.5 rounded-full border
            ${sevBg} ${sevText}
          `}
        >
          {score.risk_level === "critical" && <AlertTriangle size={10} strokeWidth={2} />}
          {score.risk_level}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className={`font-mono text-[34px] font-medium tabular-nums leading-none ${sevText}`}>
          {score.overall_risk_score}
        </span>
        <span className="text-[12px] text-ink-mute">/ 100</span>
      </div>
      <p className="text-[12.5px] text-ink-soft mt-3 leading-relaxed">
        {score.explanation}
      </p>
      <CoverageNote coverage={score.coverage ?? null} />
    </div>
  );
}

/** What the composite covers, rendered from the served block: the dropped
 *  categories with the producer's reason and the weights actually applied.
 *  Renders nothing when nothing was dropped (the declared weights apply). */
export function CoverageNote({ coverage }: { coverage: ScoreCoverage | null }) {
  if (!coverage || coverage.dropped.length === 0) return null;
  const total = coverage.scored.length + coverage.dropped.length;
  const dropped = coverage.dropped.map((d) => CATEGORY_LABEL[d.category] ?? d.category);
  const reasons = Array.from(new Set(coverage.dropped.map((d) => d.reason)));
  const weights = coverage.scored
    .map((cat) => `${CATEGORY_LABEL[cat] ?? cat} ${fmtWeight(coverage.applied_weights[cat])}`)
    .join(" · ");
  return (
    <div
      className="mt-3 rounded-lg border border-rule/60 bg-bg-2/30 px-3 py-2 text-[11px] text-ink-mute leading-snug"
      data-testid="risk-coverage"
    >
      <span className="text-ink-soft">
        Scored over {coverage.scored.length} of {total} categories.
      </span>{" "}
      Not scored: {dropped.join(", ")} — {reasons.join("; ")}.{" "}
      Weights applied: {weights}.
    </div>
  );
}

function fmtWeight(w: number | undefined): string {
  return w === undefined || !Number.isFinite(w) ? "—" : `${(w * 100).toFixed(1)}%`;
}

// ─── Category grid ──────────────────────────────────────────────────────

const CATEGORY_ORDER: Array<keyof RiskCategoryScores> = [
  "financial",
  "valuation",
  "supply_chain",
  "macro",
  "geopolitical",
  "operational",
  "regulatory",
];

const CATEGORY_LABEL: Record<keyof RiskCategoryScores, string> = {
  financial:     "Financial",
  valuation:     "Valuation",
  supply_chain:  "Supply chain",
  macro:         "Macro",
  geopolitical:  "Geopolitical",
  operational:   "Operational",
  regulatory:    "Regulatory",
};

export function CategoryGrid({
  score: parent,
}: {
  score: Pick<PublicCompanyRiskScore, "categories" | "refusals" | "coverage">;
}) {
  const categories = parent.categories;
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-2">
        Category breakdown
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {CATEGORY_ORDER.map((cat) => {
          const score = categories[cat];
          if (score === null) {
            const dropped = categoryDropFor(parent, cat);
            if (dropped) {
              // The engine's full sentence when it served one (names the
              // input and the redistributed weight), else the block's reason.
              const droppedText = scoreRefusalFor(parent, cat)?.text ?? dropped.reason;
              // Dropped by the producer's coverage: "not scored" with the
              // reason. No number, no bar, no level — and not "unavailable",
              // which would read as this company's gap.
              return (
                <div
                  key={cat}
                  className="flex flex-col gap-1 px-3 py-2 rounded-lg border border-rule/60 bg-bg-2/30"
                  data-testid={`risk-category-${cat}`}
                  data-state="dropped"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[12px] text-ink-soft">{CATEGORY_LABEL[cat]}</span>
                    <span className="text-[11px] text-ink-mute">not scored</span>
                  </div>
                  <span className="text-[11px] text-ink-mute leading-snug">{droppedText}</span>
                </div>
              );
            }
            // No number, no bar, no level: the refusal sentence instead.
            const refusal = scoreRefusalFor(parent, cat);
            return (
              <div
                key={cat}
                className="flex flex-col gap-1 px-3 py-2 rounded-lg border border-rule/60 bg-bg-2/30"
                data-testid={`risk-category-${cat}`}
                data-state="unavailable"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[12px] text-ink-soft">{CATEGORY_LABEL[cat]}</span>
                  <span className="text-[11px] text-ink-mute">unavailable</span>
                </div>
                {refusal && (
                  <span className="text-[11px] text-ink-mute leading-snug">{refusal.text}</span>
                )}
              </div>
            );
          }
          const level: "low" | "medium" | "high" | "critical" =
            score >= 75 ? "critical" :
            score >= 50 ? "high" :
            score >= 25 ? "medium" :
                          "low";
          const text = severityToTextClass(level);
          return (
            <div
              key={cat}
              className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-rule/60 bg-bg-2/30"
              data-testid={`risk-category-${cat}`}
            >
              <span className="text-[12px] text-ink-soft">{CATEGORY_LABEL[cat]}</span>
              <div className="flex items-center gap-2 min-w-[100px]">
                <div className="h-1 w-16 rounded-full bg-bg-2 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      level === "critical" ? "bg-alert" :
                      level === "high"     ? "bg-brand" :
                      level === "medium"   ? "bg-brand" :
                                             "bg-brand"
                    }`}
                    style={{ width: `${Math.max(2, Math.min(100, score))}%` }}
                  />
                </div>
                <span className={`text-[12px] font-semibold tabular-nums w-7 text-right ${text}`}>
                  {score}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Top risks + opportunities ──────────────────────────────────────────

function TopRisksList({ score }: { score: PublicCompanyRiskScore }) {
  if (!score.top_risks.length) return null;
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-2">
        Top risks
      </div>
      <ul className="space-y-2">
        {score.top_risks.map((r) => {
          const sevText = severityToTextClass(r.severity);
          const sevBg = severityToBgClass(r.severity);
          return (
            <li
              key={r.key}
              data-testid={`top-risk-${r.key}`}
              className="flex items-start gap-3 p-3 rounded-lg border border-rule/60 bg-bg-2/30"
            >
              <div className={`mt-0.5 inline-flex items-center justify-center h-6 w-6 rounded-md border ${sevBg} ${sevText} shrink-0`}>
                <AlertTriangle size={12} strokeWidth={2} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[13px] font-medium text-ink leading-snug">
                    {r.label}
                  </span>
                  <span className={`text-[10.5px] uppercase tracking-[0.06em] ${sevText}`}>
                    {r.severity}
                  </span>
                </div>
                {r.channels.length > 0 && (
                  <div className="text-[11px] text-ink-mute mt-1">
                    Impact channels: {r.channels.slice(0, 3).map(c => c.replace(/_/g, " ")).join(" · ")}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TopOpportunitiesList({ score }: { score: PublicCompanyRiskScore }) {
  if (!score.top_opportunities.length) return null;
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-2">
        Top opportunities
      </div>
      <ul className="space-y-2">
        {score.top_opportunities.map((o) => (
          <li
            key={o.key}
            data-testid={`top-opportunity-${o.key}`}
            className="flex items-start gap-3 p-3 rounded-lg border border-rule/60 bg-bg-2/30"
          >
            <div className="mt-0.5 inline-flex items-center justify-center h-6 w-6 rounded-md border bg-brand-tint border-transparent text-brand-dark dark:text-brand-light shrink-0">
              <TrendingUp size={12} strokeWidth={2} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[13px] font-medium text-ink leading-snug">
                  {o.label}
                </span>
                <span className="text-[10.5px] uppercase tracking-[0.06em] text-brand-dark dark:text-brand-light">
                  {o.strength}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Disclosure({ confidence }: { confidence: number }) {
  return (
    <div className="text-[11px] text-ink-mute leading-relaxed border-t border-rule/40 pt-3">
      Risk score is deterministic — computed from the company's sector exposure
      profile, the in-repo sector risk library, and the financial snapshot. The
      LLM never produces the numeric score. Confidence: {Math.round(confidence * 100)}%.
    </div>
  );
}
