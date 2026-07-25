// StatementNotes — Apple-style notes & recommendations panel.
//
// Rendered at the foot of every statement tab (P&L, Balance Sheet,
// Cash Flow). The pre-redesign version was a flat unordered list that
// could grow to 80+ rows when an engine re-run wrote duplicate alerts.
// D-quick (Phase D-quick) added FE-side dedup at render. THIS file
// (Phase Notes-Redesign) replaces the layout entirely:
//
//   · Severity filter pills at the top — Critical / Watch / Info /
//     Recommendations / All — with counts, click to focus.
//   · Card per item (not flat <li>): severity-colored left rule,
//     icon, single-line title with × N dedup pill, 1-2 line body
//     where any recognised RON figure is wrapped in TraceableNumber
//     so a click jumps to its source row on the relevant statement.
//   · Default-collapsed: first 5 items by severity rank shown; the
//     rest hidden behind "Show N more". Critical items always
//     count toward the visible cap so a quiet "watch" alert never
//     pushes a critical one off-screen.
//   · Honest empty state: "No notes generated for this period." —
//     never filler.
//
// All inputs (PeriodAlertItem, PeriodRecommendation) and the dedup
// pass (dedupeAlerts / dedupeRecommendations from D-quick) are kept.
// This file is a layout swap only — the data layer is intact.

import { useMemo, useState } from "react";
import { AlertTriangle, Info, AlertCircle, CheckCircle2 } from "lucide-react";
import type { PeriodRecommendation, PeriodAlertItem } from "@/lib/activePeriod";
import {
  dedupeAlerts,
  dedupeRecommendations,
  type DedupedAlert,
  type DedupedRecommendation,
} from "@/lib/dedupeNotes";
import { linkifyAlertBody } from "@/lib/linkifyAlertBody";

export type StatementNotesScope = "pl" | "bs" | "cf";

interface Props {
  recommendations: PeriodRecommendation[];
  alerts: PeriodAlertItem[];
  /** Which statement is asking — controls which items are surfaced as
   *  "relevant" vs. "other notes on file". */
  relevantTo: StatementNotesScope;
}

const RELEVANCE_KEYWORDS: Record<StatementNotesScope, RegExp> = {
  pl: /\b(margin|profit|profitab|revenue|sales|opex|cost|ebitda|ebit|gross|operating)\b/i,
  bs: /\b(asset|equity|debt|leverage|capital|solvenc|gearing|altman|piotroski|provision|inventor|receivab|payable)\b/i,
  cf: /\b(cash|liquidit|working\s*capital|dscr|coverage|conversion|ccc|dio|dso|dpo)\b/i,
};

type SeverityFilter = "all" | "critical" | "watch" | "info" | "recommendations";

export function StatementNotes({ recommendations, alerts, relevantTo }: Props) {
  const [filter, setFilter] = useState<SeverityFilter>("all");

  const { relevantAlerts, otherAlerts, relevantRecs, otherRecs, counts } = useMemo(() => {
    const dedupedAlerts = dedupeAlerts(alerts);
    const dedupedRecs = dedupeRecommendations(recommendations);
    const re = RELEVANCE_KEYWORDS[relevantTo];

    const recsRel: DedupedRecommendation[] = [];
    const recsOther: DedupedRecommendation[] = [];
    for (const dr of dedupedRecs) {
      const hay = `${dr.rec.title} ${dr.rec.explanation ?? ""}`;
      (re.test(hay) ? recsRel : recsOther).push(dr);
    }
    const alertsRel: DedupedAlert[] = [];
    const alertsOther: DedupedAlert[] = [];
    for (const da of dedupedAlerts) {
      const hay = `${da.alert.title} ${da.alert.body ?? ""} ${da.alert.category ?? ""}`;
      (re.test(hay) ? alertsRel : alertsOther).push(da);
    }

    // Counts for the severity pill badges — drives the filter UI.
    const counts: Record<SeverityFilter, number> = {
      all: dedupedAlerts.length + dedupedRecs.length,
      critical: dedupedAlerts.filter((d) => d.alert.severity === "critical" || d.alert.severity === "high").length,
      watch:    dedupedAlerts.filter((d) => d.alert.severity === "medium").length,
      info:     dedupedAlerts.filter((d) => d.alert.severity === "low" || d.alert.severity === "info").length,
      recommendations: dedupedRecs.length,
    };

    return {
      relevantAlerts: alertsRel,
      otherAlerts: alertsOther,
      relevantRecs: recsRel,
      otherRecs: recsOther,
      counts,
    };
  }, [recommendations, alerts, relevantTo]);

  const totalCount = counts.all;

  // Honest empty state. Never fabricate filler.
  if (totalCount === 0) {
    return (
      <section
        className="mt-8 pt-6 border-t border-rule"
        data-testid={`statement-notes-${relevantTo}`}
        aria-labelledby={`notes-heading-${relevantTo}`}
      >
        <h3
          id={`notes-heading-${relevantTo}`}
          className="text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-2"
        >
          Notes & recommendations
        </h3>
        <div className="rounded-lg border border-rule bg-bg-2/40 px-4 py-3 text-[12.5px] text-ink-soft flex items-center gap-2">
          <Info size={14} className="text-ink-mute flex-shrink-0" />
          <span>No notes generated for this period.</span>
        </div>
      </section>
    );
  }

  // Severity-rank for ordering inside the visible bucket. Critical
  // items appear first; recommendations land last unless explicitly
  // filtered to.
  const SEVERITY_RANK: Record<string, number> = {
    critical: 0, high: 1, medium: 2, low: 3, info: 4,
  };

  // Apply severity filter, sort, then split visible vs. hidden.
  const visibleAlerts = useMemo(() => {
    const all = [...relevantAlerts, ...otherAlerts];
    const filtered =
      filter === "all" ? all
      : filter === "critical" ? all.filter((d) => d.alert.severity === "critical" || d.alert.severity === "high")
      : filter === "watch"    ? all.filter((d) => d.alert.severity === "medium")
      : filter === "info"     ? all.filter((d) => d.alert.severity === "low" || d.alert.severity === "info")
      : []; // "recommendations" filter → no alerts visible
    return [...filtered].sort(
      (a, b) =>
        (SEVERITY_RANK[a.alert.severity] ?? 9) - (SEVERITY_RANK[b.alert.severity] ?? 9),
    );
  }, [filter, relevantAlerts, otherAlerts]);

  const visibleRecs = useMemo(() => {
    const all = [...relevantRecs, ...otherRecs];
    return filter === "all" || filter === "recommendations" ? all : [];
  }, [filter, relevantRecs, otherRecs]);

  const allVisible = [
    ...visibleAlerts.map((a) => ({ kind: "alert" as const, deduped: a })),
    ...visibleRecs.map((r) => ({ kind: "rec" as const, deduped: r })),
  ];

  // Always show every note (2026-07-25) — the show-more/less toggle was removed
  // and the list defaults to fully expanded.
  const shown = allVisible;

  return (
    <section
      className="mt-8 pt-6 border-t border-rule scroll-mt-24"
      data-testid={`statement-notes-${relevantTo}`}
      aria-labelledby={`notes-heading-${relevantTo}`}
    >
      {/* Header + total badge ──────────────────────────────────── */}
      <div className="flex items-baseline gap-2 mb-3">
        <h3
          id={`notes-heading-${relevantTo}`}
          className="text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold"
        >
          Notes & recommendations
        </h3>
        <span className="text-[11.5px] text-ink-mute">
          {totalCount} unique
        </span>
      </div>

      {/* Severity filter pills ─────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3.5">
        <FilterPill label="All"             count={counts.all}             active={filter === "all"}             onClick={() => { setFilter("all"); }} />
        <FilterPill label="Critical"        count={counts.critical}        active={filter === "critical"}        onClick={() => { setFilter("critical"); }} tone="critical" />
        <FilterPill label="Watch"           count={counts.watch}           active={filter === "watch"}           onClick={() => { setFilter("watch"); }} tone="watch" />
        <FilterPill label="Info"            count={counts.info}            active={filter === "info"}            onClick={() => { setFilter("info"); }} tone="info" />
        <FilterPill label="Recommendations" count={counts.recommendations} active={filter === "recommendations"} onClick={() => { setFilter("recommendations"); }} tone="rec" />
      </div>

      {/* Card list ────────────────────────────────────────────── */}
      <ul className="space-y-2">
        {shown.length === 0 && (
          <li className="rounded-lg border border-rule bg-bg-2/40 px-4 py-3 text-[12.5px] text-ink-soft">
            No items in this filter.
          </li>
        )}
        {shown.map((entry) =>
          entry.kind === "alert" ? (
            <AlertCard key={entry.deduped.alert.id} deduped={entry.deduped} />
          ) : (
            <RecCard key={entry.deduped.rec.id} deduped={entry.deduped} />
          ),
        )}
      </ul>

    </section>
  );
}

// ─── Filter pill ─────────────────────────────────────────────────
function FilterPill({
  label, count, active, onClick, tone,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone?: "critical" | "watch" | "info" | "rec";
}) {
  const toneStyles =
    tone === "critical" ? "data-[active=true]:bg-red-100 data-[active=true]:text-red-800 dark:data-[active=true]:bg-red-500/[0.18] dark:data-[active=true]:text-red-300"
    : tone === "watch"  ? "data-[active=true]:bg-[#E6F7F4] data-[active=true]:text-[#1B7268] dark:data-[active=true]:bg-[#5CD3C5]/[0.18] dark:data-[active=true]:text-[#8FE3D9]"
    : tone === "info"   ? "data-[active=true]:bg-[#E6F7F4] data-[active=true]:text-[#1B7268] dark:data-[active=true]:bg-[#5CD3C5]/[0.18] dark:data-[active=true]:text-[#8FE3D9]"
    : tone === "rec"    ? "data-[active=true]:bg-[#E6F7F4] data-[active=true]:text-[#1B7268] dark:data-[active=true]:bg-[#5CD3C5]/[0.18] dark:data-[active=true]:text-[#8FE3D9]"
    :                     "data-[active=true]:bg-ink/[0.08] data-[active=true]:text-ink";

  return (
    <button
      type="button"
      onClick={onClick}
      data-active={active}
      className={`
        inline-flex items-center gap-1.5
        h-7 px-2.5 rounded-full
        text-[11.5px] font-medium
        border border-rule
        text-ink-soft hover:text-ink hover:bg-bg-2/60
        ${toneStyles}
        transition-colors
      `}
    >
      <span>{label}</span>
      <span className="text-ink-mute tabular-nums">{count}</span>
    </button>
  );
}

// ─── Alert card ─────────────────────────────────────────────────
function AlertCard({ deduped }: { deduped: DedupedAlert }) {
  const alert = deduped.alert;
  const Icon =
    alert.severity === "critical" || alert.severity === "high"
      ? AlertCircle
      : alert.severity === "medium"
      ? AlertTriangle
      : Info;

  // Severity color coding — critical/high = red, watch (medium) = amber,
  // info (low/info) = blue. Tints the whole card (left rule + bg) so items
  // read at a glance.
  const tone =
    alert.severity === "critical" || alert.severity === "high"
      ? { rule: "border-l-red-500", bg: "bg-red-500/[0.06]", icon: "text-red-600" }
      : alert.severity === "medium"
      ? { rule: "border-l-amber-500", bg: "bg-amber-500/[0.07]", icon: "text-amber-600" }
      : { rule: "border-l-blue-500", bg: "bg-blue-500/[0.06]", icon: "text-blue-600" };

  return (
    <li
      className={`
        relative rounded-lg border border-rule border-l-[3px] ${tone.rule}
        ${tone.bg}
        px-3.5 py-2.5
        transition-colors
      `}
    >
      <div className="flex items-start gap-2.5">
        <Icon size={14} className={`flex-shrink-0 mt-[3px] ${tone.icon}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="text-[13px] text-ink font-medium leading-snug">
              {alert.title}
            </span>
            <DuplicateCountPill count={deduped.duplicateCount} sourceIds={deduped.sourceIds} />
          </div>
          {alert.body && (
            <div className="mt-1 text-[12.5px] text-ink-soft leading-relaxed">
              {linkifyAlertBody(alert.body, alert.facts_cited)}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

// ─── Recommendation card ────────────────────────────────────────
function RecCard({ deduped }: { deduped: DedupedRecommendation }) {
  const rec = deduped.rec;
  const isDone = (rec.status ?? "").toLowerCase() === "done";
  const Icon = isDone ? CheckCircle2 : Info;

  // Recommendations are their own "recommendation" category — teal/brand tint
  // (color-coded like the other severities: critical=red, watch=amber,
  // info=blue, recommendation=teal).
  return (
    <li
      className="
        relative rounded-lg border border-rule border-l-[3px] border-l-[#5CD3C5]
        bg-[#5CD3C5]/[0.06]
        px-3.5 py-2.5
      "
    >
      <div className="flex items-start gap-2.5">
        <Icon size={14} className="flex-shrink-0 mt-[3px] text-[#2AA89B]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="text-[10px] uppercase tracking-[0.1em] text-[#2AA89B] dark:text-[#5CD3C5] font-semibold">
              Recommendation
            </span>
            <span className="text-[13px] text-ink font-medium leading-snug">
              {rec.title}
            </span>
            <DuplicateCountPill count={deduped.duplicateCount} sourceIds={deduped.sourceIds} />
          </div>
          {rec.explanation && (
            <div className="mt-1 text-[12.5px] text-ink-soft leading-relaxed">
              {linkifyAlertBody(rec.explanation, null /* recs don't carry facts_cited today */)}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

// ─── Duplicate count pill (carried over from D-quick) ──────────
function DuplicateCountPill({ count, sourceIds }: { count: number; sourceIds: string[] }) {
  if (count <= 1) return null;
  return (
    <span
      className="inline-flex items-center rounded-full bg-ink-mute/15 px-1.5 py-px text-[10px] font-medium text-ink-mute tabular-nums"
      title={`Fired ${count}× this period. Source row ids: ${sourceIds.slice(0, 8).join(", ")}${sourceIds.length > 8 ? `, +${sourceIds.length - 8} more` : ""}`}
      aria-label={`This alert was emitted ${count} times in this period — collapsed.`}
    >
      ×{count}
    </span>
  );
}
