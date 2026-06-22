// Decisions — action queue for the active period.
//
// Step 4 of FIX-NOW: replaced the SKU-bucket recommendation queue (which
// was wrong for non-FMCG companies) with the engine's prioritized financial
// recommendations from generateRecommendations(statements, ratios). Each
// card surfaces severity, rationale, action steps, and estimated RON
// impact — and the spec's three workflow buttons (mark in progress / done
// / dismiss) toggle a per-recommendation status held in component state
// (persistence to the recommendations table comes with Phase G's schema apply).

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Check, Clock, FileText, X } from "lucide-react";
import { AppShell } from "@/components/cfo/AppShell";
import { useActivePeriod } from "@/lib/activePeriod";
import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";
import { usePeriodFacts } from "@/lib/periodFacts";
import { RecommendationsView } from "@/components/cfo/RecommendationsView";
import { Money } from "@/components/ui/Money";
import type { Currency } from "@/lib/rates";
import { linkifyAlertBody } from "@/lib/linkifyAlertBody";
import {
  computeRatios,
  generateRecommendations,
  type Recommendation,
  type RecommendationPriority,
} from "@/lib/financialReport";

type Status = "open" | "in_progress" | "done" | "dismissed";

const PRIORITY_ORDER: RecommendationPriority[] = ["critical", "high", "medium", "info"];
const PRIORITY_LABEL: Record<RecommendationPriority, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  info: "Info",
};
const PRIORITY_TONE: Record<RecommendationPriority, string> = {
  critical: "bg-red-50 text-red-700 border-red-200",
  high:     "bg-amber-50 text-amber-700 border-amber-200",
  medium:   "bg-blue-50 text-blue-700 border-blue-200",
  info:     "bg-bg-2 text-ink-soft border-rule",
};

export default function Decisions() {
  // 2026-05-24 — auto-resolve active period when URL lacks ?period=.
  // Without this, sidebar navigation shows empty Decisions even with docs.
  useActivePeriodFallback();
  const period = useActivePeriod();
  const facts = usePeriodFacts();
  if (!period.isLoaded || !period.statements) {
    return (
      <AppShell>
        <DecisionsEmptyState />
      </AppShell>
    );
  }
  return (
    <AppShell>
      {/* Single-source-of-truth recommendations driven by deterministic
          rule detection over PeriodFacts. Same facts always produce the
          same conditions; each card's numbers come straight from the
          canonical facts (no LLM-derived numerics).

          The legacy DecisionsLoaded panel below still renders so the
          existing workflow (mark in progress / done / dismiss) keeps
          working until the server-side recommendations table is migrated
          to consume the rule output. */}
      {facts && (
        <section className="max-w-[860px] mx-auto pt-6 mb-10">
          <RecommendationsView facts={facts} />
        </section>
      )}
      <DecisionsLoaded statements={period.statements} />
    </AppShell>
  );
}

function DecisionsEmptyState() {
  return (
    <section className="max-w-[680px] mx-auto py-16 text-center" data-testid="decisions-empty">
      <div className="mx-auto h-14 w-14 rounded-2xl bg-bg-2 text-ink-mute flex items-center justify-center mb-4">
        <FileText size={22} strokeWidth={1.5} />
      </div>
      <h1 className="font-serif text-[34px] sm:text-[40px] leading-[1.1] tracking-[-0.02em] text-ink">
        No decisions yet
      </h1>
      <p className="mt-4 text-[15px] text-ink-soft max-w-[480px] mx-auto">
        Recommendations are derived from a loaded P&L + balance sheet. Open
        Statements to load a sample or upload your own.
      </p>
      <Link
        to="/dashboard"
        className="mt-6 inline-flex items-center gap-2 h-11 px-5 rounded-lg bg-brand text-paper text-[14px] font-medium hover:bg-brand-d transition-colors"
      >
        Open Financial Statements
        <ArrowRight size={14} strokeWidth={2} />
      </Link>
    </section>
  );
}

function DecisionsLoaded({ statements }: { statements: NonNullable<ReturnType<typeof useActivePeriod>["statements"]> }) {
  const period = useActivePeriod();
  // F2.2 — Pass engine-canonical metrics map so this page's ratios
  // match the dashboard Ratios tab to the cent.
  const metricsByName = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const mt of period.metrics) {
      out[mt.name] = typeof mt.value === "number" ? mt.value : null;
    }
    return out;
  }, [period.metrics]);
  const ratios = useMemo(
    () => computeRatios(statements, undefined, metricsByName),
    [statements, metricsByName],
  );
  // Server-generated (Opus 4.7) recommendations win when available — they
  // carry industry context the local rule-based generator lacks. For samples
  // (no remote payload) we fall back to the client-side recommendations.
  const recommendations = useMemo<Recommendation[]>(() => {
    if (period.recommendations.length > 0) {
      const urgencyToPriority: Record<string, RecommendationPriority> = {
        critical: "critical", high: "high", medium: "medium", low: "info",
      };
      return period.recommendations.map((r) => ({
        id: r.id,
        priority: urgencyToPriority[r.urgency ?? "medium"] ?? "medium",
        title: r.title,
        rationale: r.explanation ?? "",
        action: r.explanation?.split("Actions:")[1]?.replace(/\n[•·]\s*/g, " ").trim()
              ?? "Review the rationale and take corrective action.",
        estimatedImpact: r.expected_cash_impact_kron ?? undefined,
        category: "financial",
      } as Recommendation));
    }
    return generateRecommendations(statements, ratios);
  }, [period.recommendations, statements, ratios]);
  const cur = statements.currency;

  const [statusMap, setStatusMap] = useState<Record<string, Status>>({});
  const [filter, setFilter] = useState<RecommendationPriority | "all">("all");

  const visible = useMemo(() => {
    let xs = recommendations.filter((r) => statusMap[r.id] !== "dismissed");
    if (filter !== "all") xs = xs.filter((r) => r.priority === filter);
    return xs.sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority));
  }, [recommendations, statusMap, filter]);

  const counts: Record<RecommendationPriority | "all", number> = {
    all: recommendations.filter((r) => statusMap[r.id] !== "dismissed").length,
    critical: recommendations.filter((r) => r.priority === "critical" && statusMap[r.id] !== "dismissed").length,
    high: recommendations.filter((r) => r.priority === "high" && statusMap[r.id] !== "dismissed").length,
    medium: recommendations.filter((r) => r.priority === "medium" && statusMap[r.id] !== "dismissed").length,
    info: recommendations.filter((r) => r.priority === "info" && statusMap[r.id] !== "dismissed").length,
  };

  const totalImpact = visible.reduce((s, r) => s + (r.estimatedImpact ?? 0), 0);

  return (
    <div className="space-y-7" data-testid="decisions-body">
      <header>
        <div className="label-eyebrow">Decisions</div>
        <h1 className="mt-2 font-serif text-[36px] leading-[1.1] tracking-[-0.02em]">
          {visible.length} prioritized action{visible.length === 1 ? "" : "s"}
        </h1>
        <p className="mt-3 text-[14.5px] text-ink-soft max-w-[640px]">
          {totalImpact > 0
            ? <>Combined estimated impact: <span className="text-ink font-medium">~<Money value={totalImpact} fromCurrency={cur as Currency} compact /> / year</span>.</>
            : "Recommendations are tracked here. Mark them in-progress, done, or dismiss as appropriate."}
        </p>
      </header>

      {/* Filter strip */}
      <div className="flex items-center gap-1 flex-wrap">
        {(["all", "critical", "high", "medium", "info"] as const).map((p) => (
          <button
            key={p}
            onClick={() => setFilter(p)}
            data-testid={`decisions-filter-${p}`}
            className={`rounded-md px-2.5 py-1 text-[12px] border transition-colors ${
              filter === p
                ? "bg-ink text-paper border-ink"
                : "bg-surface text-ink-soft border-rule hover:text-ink hover:border-rule-strong"
            }`}
          >
            {p === "all" ? "All" : PRIORITY_LABEL[p]}
            <span className={`ml-1.5 ${filter === p ? "text-paper/70" : "text-ink-mute"}`}>{counts[p]}</span>
          </button>
        ))}
      </div>

      {/* Recommendation cards */}
      <div className="space-y-3">
        {visible.length === 0 && (
          <div className="rounded-2xl border border-rule bg-surface px-6 py-12 text-center text-[13.5px] text-ink-soft">
            No decisions match this filter.
          </div>
        )}
        {visible.map((rec) => (
          <DecisionCard
            key={rec.id}
            rec={rec}
            currency={cur}
            status={statusMap[rec.id] ?? "open"}
            onStatusChange={(next) => setStatusMap((m) => ({ ...m, [rec.id]: next }))}
          />
        ))}
      </div>
    </div>
  );
}

function DecisionCard({
  rec,
  currency,
  status,
  onStatusChange,
}: {
  rec: Recommendation;
  currency: string;
  status: Status;
  onStatusChange: (next: Status) => void;
}) {
  const tone = PRIORITY_TONE[rec.priority];
  const inProgress = status === "in_progress";
  const done = status === "done";

  return (
    <article
      data-testid="recommendation-card"
      className={`rounded-2xl border bg-surface p-5 transition-opacity ${done ? "opacity-60" : ""}`}
    >
      <div className="flex items-start gap-3 mb-2">
        <span className={`inline-flex items-center text-[10.5px] font-semibold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full border ${tone}`}>
          {PRIORITY_LABEL[rec.priority]}
        </span>
        {/* CUR-FIX — pipe title/rationale/action through linkifyAlertBody so
            the recommendation's "RON X" mentions convert live when the user
            toggles the global currency. `rec.factsCited` carries the raw
            facts the rule emitted; linkify matches them to RON figures in
            the prose and replaces with currency-aware <TraceableNumber>s. */}
        <h3 className={`font-serif text-[17px] text-ink leading-tight ${done ? "line-through" : ""}`}>
          {linkifyAlertBody(rec.title, rec.factsCited as Record<string, number> | undefined)}
        </h3>
      </div>
      <p className="text-[13px] text-ink-soft leading-snug mt-2">
        <span className="text-ink font-medium">Why:</span>{" "}
        {linkifyAlertBody(rec.rationale, rec.factsCited as Record<string, number> | undefined)}
      </p>
      <p className="text-[13px] text-ink-soft leading-snug mt-2">
        <span className="text-ink font-medium">Action:</span>{" "}
        {linkifyAlertBody(rec.action, rec.factsCited as Record<string, number> | undefined)}
      </p>
      {rec.estimatedImpact && (
        <div className="mt-3 inline-flex items-center text-[11.5px] font-medium text-emerald-700 bg-emerald-50 px-3 py-1 rounded-md">
          Estimated impact: ~<Money value={rec.estimatedImpact} fromCurrency={currency as Currency} compact /> / year
        </div>
      )}
      <div className="mt-4 flex items-center gap-2 flex-wrap">
        <button
          onClick={() => onStatusChange(inProgress ? "open" : "in_progress")}
          data-testid="rec-action-progress"
          className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-medium border transition-colors ${
            inProgress ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-surface text-ink-soft border-rule hover:text-ink hover:border-rule-strong"
          }`}
        >
          <Clock size={12} strokeWidth={2} />
          {inProgress ? "In progress" : "Mark in progress"}
        </button>
        <button
          onClick={() => onStatusChange(done ? "open" : "done")}
          data-testid="rec-action-done"
          className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-medium border transition-colors ${
            done ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-surface text-ink-soft border-rule hover:text-ink hover:border-rule-strong"
          }`}
        >
          <Check size={12} strokeWidth={2} />
          {done ? "Done" : "Mark done"}
        </button>
        <button
          onClick={() => onStatusChange("dismissed")}
          data-testid="rec-action-dismiss"
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-medium text-ink-mute hover:text-ink hover:bg-bg-2 transition-colors ml-auto"
        >
          <X size={12} strokeWidth={2} />
          Dismiss
        </button>
      </div>
    </article>
  );
}
