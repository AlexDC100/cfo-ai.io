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
import { ArrowRight, Check, FileText, ShieldCheck, X } from "lucide-react";
import { AppShell } from "@/components/cfo/AppShell";
import { useActivePeriod } from "@/lib/activePeriod";
import {
  computeRatios,
  generateRecommendations,
  formatCurrency,
  type Recommendation,
  type RecommendationPriority,
} from "@/lib/financialReport";

type Severity = "critical" | "high" | "medium" | "low" | "info";

const SEVERITY_FROM_PRIORITY: Record<RecommendationPriority, Severity> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  info: "info",
};

const SEVERITY_TONE: Record<Severity, string> = {
  critical: "bg-red-50 text-red-700 border-red-200",
  high:     "bg-amber-50 text-amber-700 border-amber-200",
  medium:   "bg-blue-50 text-blue-700 border-blue-200",
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
  const period = useActivePeriod();
  if (!period.isLoaded || !period.statements) {
    return (
      <AppShell>
        <AlertsEmptyState />
      </AppShell>
    );
  }
  return (
    <AppShell>
      <AlertsLoaded statements={period.statements} />
    </AppShell>
  );
}

function AlertsEmptyState() {
  return (
    <section className="max-w-[680px] mx-auto py-16 text-center" data-testid="alerts-empty">
      <div className="mx-auto h-14 w-14 rounded-2xl bg-bg-2 text-ink-mute flex items-center justify-center mb-4">
        <FileText size={22} strokeWidth={1.5} />
      </div>
      <h1 className="font-serif text-[34px] sm:text-[40px] leading-[1.1] tracking-[-0.02em] text-ink">
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
  const ratios = useMemo(() => computeRatios(statements), [statements]);
  const recommendations = useMemo(() => generateRecommendations(statements, ratios), [statements, ratios]);
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
        <h1 className="mt-2 font-serif text-[36px] leading-[1.1] tracking-[-0.02em]">
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
          <ShieldCheck size={28} className="mx-auto text-emerald-600 mb-3" strokeWidth={1.5} />
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
  isResolved,
  onResolve,
  onDismiss,
}: {
  rec: Recommendation;
  severity: Severity;
  currency: string;
  isResolved: boolean;
  onResolve: () => void;
  onDismiss: () => void;
}) {
  const tone = SEVERITY_TONE[severity];
  return (
    <li
      data-testid="alert-card"
      className={`rounded-2xl border bg-surface p-5 transition-opacity ${isResolved ? "opacity-60" : ""}`}
    >
      <div className="flex items-start gap-3 mb-2">
        <span className={`inline-flex items-center text-[10.5px] font-semibold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full border ${tone}`}>
          {severity}
        </span>
        <h3 className={`font-serif text-[17px] text-ink leading-tight ${isResolved ? "line-through" : ""}`}>{rec.title}</h3>
      </div>
      <p className="text-[13px] text-ink-soft leading-snug mt-2">{rec.rationale}</p>
      {rec.estimatedImpact && (
        <div className="mt-2 inline-flex items-center text-[11.5px] font-medium text-emerald-700 bg-emerald-50 px-3 py-1 rounded-md">
          Estimated impact: ~{formatCurrency(rec.estimatedImpact, currency)} / year
        </div>
      )}
      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={onResolve}
          className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-medium border transition-colors ${
            isResolved
              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
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
