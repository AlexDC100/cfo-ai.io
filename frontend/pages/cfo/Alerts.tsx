// Alerts — exception surface for the active period.
//
// Step 4 of FIX-NOW: replaced the legacy SKU-derived alert engine with
// period-aware alert cards from the same generateRecommendations() engine
// that powers Decisions. Each alert is a critical/high recommendation
// surfaced as a dismissable card. Dismissal is local-only for now;
// persistence to the alerts table arrives with Phase G's schema apply.
//
// The original 614-line SKU/inventory alerts page is preserved in git
// history; this rewrite makes the page actually correct for non-FMCG
// companies and keeps the data flowing downward from the active period.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Check, ChevronRight, FileText, ShieldCheck, X } from "lucide-react";
import { useActivePeriod } from "@/lib/activePeriod";
import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";
import {
  computeRatios,
  generateRecommendations,
  type Recommendation,
  type RecommendationPriority,
} from "@/lib/financialReport";
import { Money } from "@/components/ui/Money";
import { useAmountFormatter } from "@/stores/currency";
import type { Currency } from "@/lib/rates";
import { linkifyAlertBody } from "@/lib/linkifyAlertBody";

type Severity = "critical" | "high" | "medium" | "low" | "info";

const SEVERITY_FROM_PRIORITY: Record<RecommendationPriority, Severity> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  info: "info",
};

const SEVERITY_TONE: Record<Severity, string> = {
  critical: "bg-alert-tint text-alert border-alert/30",
  high:     "bg-brand-tint text-brand border-brand-l/50",
  medium:   "bg-brand-tint text-brand border-brand-l/50",
  low:      "bg-bg-2 text-ink-soft border-rule",
  info:     "bg-bg-2 text-ink-soft border-rule",
};

const TABS: { id: "all" | Severity; label: string }[] = [
  { id: "all",      label: "All" },
  { id: "critical", label: "Critical" },
  { id: "high",     label: "High" },
  { id: "medium",   label: "Medium" },
];

export default function Alerts() {
  // 2026-05-24 — auto-resolve active period when URL lacks ?period=.
  // Same pattern as Dashboard / Benchmark / Products. Without this,
  // landing on /alerts from sidebar shows AlertsEmptyState even with docs.
  useActivePeriodFallback();
  const period = useActivePeriod();
  if (!period.isLoaded || !period.statements) {
    return (
      <>
        <AlertsEmptyState />
      </>
    );
  }
  return (
    <>
      <AlertsLoaded statements={period.statements} />
    </>
  );
}

function AlertsEmptyState() {
  return (
    <section className="max-w-[680px] mx-auto py-16 text-center" data-testid="alerts-empty">
      <div className="mx-auto h-14 w-14 rounded-2xl bg-bg-2 text-ink-mute flex items-center justify-center mb-4">
        <FileText size={22} strokeWidth={1.5} />
      </div>
      {/* design-lint-allow-serif: empty-state voice — one serif line per the brief */}
        <h1 className="font-serif text-[44px] sm:text-[56px] leading-[1.04] tracking-[-0.02em] text-ink">
        No alerts yet
      </h1>
      <p className="mt-4 text-[15px] text-ink-soft max-w-[480px] mx-auto">
        Alerts surface deviations against ratio thresholds. Open Statements to load
        a sample or upload your own.
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

function AlertsLoaded({ statements }: { statements: NonNullable<ReturnType<typeof useActivePeriod>["statements"]> }) {
  const period = useActivePeriod();
  // F2.2 — Engine-canonical metrics map so alert thresholds fire against
  // canonical ratio values (matching the dashboard's Ratios tab).
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
  // For uploads, server-generated alerts (Opus 4.7 + validation) are the
  // source of truth. We coerce them into the Recommendation shape this page
  // already knows how to render. For samples, fall back to the client-side
  // generator so the dev preview keeps working.
  // Server-generated alerts carry the canonical `facts_cited` payload
  // (every number traced back to period_facts). We thread it through to
  // the card via a sidecar map keyed by recommendation id, so the card's
  // "Facts backing this alert" expander shows the exact JSON values.
  const factsByAlertId = useMemo(() => {
    const m = new Map<string, { facts: Record<string, number>; ruleKey?: string }>();
    for (const a of period.alerts) {
      if (a.facts_cited) m.set(a.id, { facts: a.facts_cited, ruleKey: a.rule_key });
    }
    return m;
  }, [period.alerts]);
  const recommendations = useMemo<Recommendation[]>(() => {
    if (period.alerts.length > 0) {
      const sevToPriority: Record<string, RecommendationPriority> = {
        critical: "critical", high: "high", medium: "medium", low: "info", info: "info",
      };
      return period.alerts.map((a) => ({
        id: a.id,
        priority: sevToPriority[a.severity] ?? "medium",
        title: a.title,
        rationale: a.body ?? "",
        action: "Review the data and take action — see the rationale above.",
        category: a.category,
      } as Recommendation));
    }
    return generateRecommendations(statements, ratios);
  }, [period.alerts, statements, ratios]);
  const cur = statements.currency;

  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<typeof TABS[number]["id"]>("all");

  const allAlerts = useMemo(
    () =>
      recommendations
        .filter((r) => !dismissed.has(r.id))
        .map((r) => ({ rec: r, severity: SEVERITY_FROM_PRIORITY[r.priority] }))
        // Alerts page surfaces deviations; "info" rec ≠ alert. Filter out.
        .filter((a) => a.severity !== "info"),
    [recommendations, dismissed],
  );

  const visible = useMemo(
    () => (tab === "all" ? allAlerts : allAlerts.filter((a) => a.severity === tab)),
    [allAlerts, tab],
  );

  const counts = {
    all: allAlerts.length,
    critical: allAlerts.filter((a) => a.severity === "critical").length,
    high: allAlerts.filter((a) => a.severity === "high").length,
    medium: allAlerts.filter((a) => a.severity === "medium").length,
  };

  return (
    <div className="space-y-7" data-testid="alerts-body">
      <header>
        <div className="label-eyebrow">Alerts</div>
        <h1 className="mt-2 text-[22px] font-semibold leading-tight tracking-tight text-ink">
          {visible.length} active alert{visible.length === 1 ? "" : "s"}
        </h1>
        <p className="mt-3 text-[14.5px] text-ink-soft max-w-[640px]">
          Threshold deviations across leverage, liquidity, profitability, and bankruptcy
          screens. Resolve as you address them — or dismiss when not applicable.
        </p>
      </header>

      {/* Severity tabs */}
      <div className="flex items-center gap-1 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            data-testid={`alerts-tab-${t.id}`}
            className={`rounded-md px-2.5 py-1 text-[12px] border transition-colors ${
              tab === t.id
                ? "bg-ink text-paper border-ink"
                : "bg-surface text-ink-soft border-rule hover:text-ink hover:border-rule-strong"
            }`}
          >
            {t.label}
            <span className={`ml-1.5 ${tab === t.id ? "text-paper/70" : "text-ink-mute"}`}>
              {counts[t.id as keyof typeof counts]}
            </span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="rounded-2xl border border-rule bg-surface px-6 py-16 text-center">
          <ShieldCheck size={28} className="mx-auto text-brand mb-3" strokeWidth={1.5} />
          <h3 className="text-[15px] font-medium text-ink">No alerts in this severity</h3>
          <p className="mt-1 text-[13px] text-ink-soft">
            Either nothing crossed the threshold, or every flagged item has been resolved or dismissed.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map(({ rec, severity }) => (
            <AlertCard
              key={rec.id}
              rec={rec}
              severity={severity}
              currency={cur}
              factsBacking={factsByAlertId.get(rec.id)}
              isResolved={resolved.has(rec.id)}
              onResolve={() =>
                setResolved((s) => {
                  const next = new Set(s);
                  if (next.has(rec.id)) next.delete(rec.id);
                  else next.add(rec.id);
                  return next;
                })
              }
              onDismiss={() => setDismissed((s) => new Set(s).add(rec.id))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function AlertCard({
  rec,
  severity,
  currency,
  factsBacking,
  isResolved,
  onResolve,
  onDismiss,
}: {
  rec: Recommendation;
  severity: Severity;
  currency: string;
  factsBacking?: { facts: Record<string, number>; ruleKey?: string };
  isResolved: boolean;
  onResolve: () => void;
  onDismiss: () => void;
}) {
  const tone = SEVERITY_TONE[severity];
  const [factsOpen, setFactsOpen] = useState(false);
  // Currency-aware formatter for the per-key facts table (numeric values
  // get converted to display currency; non-numeric values pass through).
  const fmt = useAmountFormatter(currency);
  return (
    <li
      data-testid="alert-card"
      className={`rounded-2xl border bg-surface p-5 transition-opacity ${isResolved ? "opacity-60" : ""}`}
    >
      <div className="flex items-start gap-3 mb-2">
        <span className={`inline-flex items-center text-[10.5px] font-semibold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full border ${tone}`}>
          {severity}
        </span>
        {factsBacking?.ruleKey && (
          <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-mute">
            {factsBacking.ruleKey}
          </span>
        )}
        {/* CUR-FIX — pipe titles + rationale through `linkifyAlertBody` so any
            "RON X,XXX,XXX" string emitted by the rules engine (which writes
            in source RON) is replaced with a <TraceableNumber> that converts
            live when the user toggles EUR/USD in TopHeader. Without this,
            titles like "Refinance window: ... RON 14M debt" stayed in RON
            forever even after the toggle flipped. */}
        <h3 className={`text-[15px] font-semibold text-ink leading-tight ${isResolved ? "line-through" : ""}`}>
          {linkifyAlertBody(rec.title, factsBacking?.facts)}
        </h3>
      </div>
      <p className="text-[13px] text-ink-soft leading-snug mt-2">
        {linkifyAlertBody(rec.rationale, factsBacking?.facts)}
      </p>
      {rec.estimatedImpact && (
        <div className="mt-2 inline-flex items-center text-[11.5px] font-medium text-brand bg-brand-tint px-3 py-1 rounded-md">
          Estimated impact: ~<Money value={rec.estimatedImpact} fromCurrency={currency as Currency} compact /> / year
        </div>
      )}
      {factsBacking?.facts && Object.keys(factsBacking.facts).length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setFactsOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 text-[12px] text-ink-soft hover:text-ink transition-colors"
            data-testid="alert-facts-toggle"
          >
            <ChevronRight
              size={12}
              strokeWidth={2}
              className={`transition-transform ${factsOpen ? "rotate-90" : ""}`}
            />
            Facts backing this alert
          </button>
          {factsOpen && (
            <div className="mt-2 rounded-lg border border-rule bg-bg-2/40 p-3 font-mono text-[11.5px] leading-relaxed">
              {Object.entries(factsBacking.facts).map(([k, v]) => (
                <div
                  key={k}
                  className="flex items-baseline justify-between py-0.5 border-b border-rule/40 last:border-0"
                >
                  <span className="text-ink-soft">{k}</span>
                  <span className="text-ink tabular-nums">
                    {typeof v === "number" && Math.abs(v) > 1 ? fmt(v) : String(v)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={onResolve}
          className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-medium border transition-colors ${
            isResolved
              ? "bg-success-tint text-success border-success/30"
              : "bg-surface text-ink-soft border-rule hover:text-ink hover:border-rule-strong"
          }`}
        >
          <Check size={12} strokeWidth={2} />
          {isResolved ? "Resolved" : "Mark resolved"}
        </button>
        <button
          onClick={onDismiss}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-medium text-ink-mute hover:text-ink hover:bg-bg-2 transition-colors ml-auto"
        >
          <X size={12} strokeWidth={2} />
          Dismiss
        </button>
      </div>
    </li>
  );
}
