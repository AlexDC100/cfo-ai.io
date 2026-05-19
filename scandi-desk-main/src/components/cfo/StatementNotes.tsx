// StatementNotes — shared notes/recommendations block for the P&L,
// Balance Sheet, and Cash Flow statement tabs.
//
// Reads server-emitted, period-keyed recommendations and alerts from
// `useActivePeriod()` (same period UUID the rest of the tab uses).
// Renders them as a compact, integrated block at the foot of each
// statement view. NEVER fabricates filler — when the engine produced
// no notes for the loaded period, an explicit honest empty-state
// renders: "No notes generated for this period."
//
// Filtering by `relevantTo`:
//   · "pl" — surfaces items whose category/title suggests P&L
//     relevance (profitability, margin, EBITDA, revenue, cost).
//   · "bs" — surfaces items related to balance-sheet topics
//     (leverage, liquidity, equity, debt, working capital).
//   · "cf" — cash-flow / working-capital / liquidity.
//   · undefined — all items.
// Items that fail the filter still appear under "Other notes on file"
// so nothing the engine produced is hidden — empty-honest is the
// rule, suppression is also dishonest.

import { useMemo } from "react";
import { AlertTriangle, Info, AlertCircle, CheckCircle2 } from "lucide-react";
import type { PeriodRecommendation, PeriodAlertItem } from "@/lib/activePeriod";

export type StatementNotesScope = "pl" | "bs" | "cf";

interface Props {
  recommendations: PeriodRecommendation[];
  alerts: PeriodAlertItem[];
  /** Which statement is asking — controls which items are surfaced as
   *  "relevant" vs. "other notes on file". */
  relevantTo: StatementNotesScope;
}

const RELEVANCE_KEYWORDS: Record<StatementNotesScope, RegExp> = {
  // P&L: margin, profit, revenue, expense, EBITDA
  pl: /\b(margin|profit|profitab|revenue|sales|opex|cost|ebitda|ebit|gross|operating)\b/i,
  // BS: assets, equity, debt, leverage, capital, liquidity ratios
  bs: /\b(asset|equity|debt|leverage|capital|solvenc|gearing|altman|piotroski|provision|inventor|receivab|payable)\b/i,
  // CF: cash, working capital, dscr, liquidity
  cf: /\b(cash|liquidit|working\s*capital|dscr|coverage|conversion|ccc|dio|dso|dpo)\b/i,
};

export function StatementNotes({ recommendations, alerts, relevantTo }: Props) {
  // Bucket items into "relevant" vs "other on file". Each item is
  // matched on its title/explanation/category against the scope's
  // keyword set. Items that don't match still render under "other"
  // so suppression never happens — the user sees everything the
  // engine produced for this period.
  const { relevantRecs, otherRecs, relevantAlerts, otherAlerts } = useMemo(() => {
    const re = RELEVANCE_KEYWORDS[relevantTo];
    const recsRel: PeriodRecommendation[] = [];
    const recsOther: PeriodRecommendation[] = [];
    for (const r of recommendations) {
      const hay = `${r.title} ${r.explanation ?? ""}`;
      (re.test(hay) ? recsRel : recsOther).push(r);
    }
    const alertsRel: PeriodAlertItem[] = [];
    const alertsOther: PeriodAlertItem[] = [];
    for (const a of alerts) {
      const hay = `${a.title} ${a.body ?? ""} ${a.category ?? ""}`;
      (re.test(hay) ? alertsRel : alertsOther).push(a);
    }
    return {
      relevantRecs: recsRel,
      otherRecs: recsOther,
      relevantAlerts: alertsRel,
      otherAlerts: alertsOther,
    };
  }, [recommendations, alerts, relevantTo]);

  const totalCount =
    recommendations.length + alerts.length;

  // Honest empty-state: the engine did not generate anything for THIS
  // loaded period. Never fabricate.
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

  return (
    <section
      className="mt-8 pt-6 border-t border-rule"
      data-testid={`statement-notes-${relevantTo}`}
      aria-labelledby={`notes-heading-${relevantTo}`}
    >
      <h3
        id={`notes-heading-${relevantTo}`}
        className="text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-3"
      >
        Notes & recommendations
        <span className="ml-2 text-ink-mute font-normal normal-case tracking-normal">
          ({totalCount} on file for this period)
        </span>
      </h3>

      {/* Alerts — relevant first, then other-on-file */}
      {(relevantAlerts.length > 0 || otherAlerts.length > 0) && (
        <div className="mb-4">
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-1.5">
            Alerts
          </div>
          <ul className="space-y-1.5">
            {relevantAlerts.map((a) => <AlertItem key={a.id} alert={a} />)}
            {otherAlerts.length > 0 && (
              <>
                {relevantAlerts.length > 0 && (
                  <li className="text-[10.5px] uppercase tracking-[0.08em] text-ink-mute pt-1.5">
                    Other alerts on file
                  </li>
                )}
                {otherAlerts.map((a) => <AlertItem key={a.id} alert={a} muted />)}
              </>
            )}
          </ul>
        </div>
      )}

      {/* Recommendations — relevant first, then other-on-file */}
      {(relevantRecs.length > 0 || otherRecs.length > 0) && (
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-1.5">
            Recommendations
          </div>
          <ul className="space-y-1.5">
            {relevantRecs.map((r) => <RecItem key={r.id} rec={r} />)}
            {otherRecs.length > 0 && (
              <>
                {relevantRecs.length > 0 && (
                  <li className="text-[10.5px] uppercase tracking-[0.08em] text-ink-mute pt-1.5">
                    Other recommendations on file
                  </li>
                )}
                {otherRecs.map((r) => <RecItem key={r.id} rec={r} muted />)}
              </>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

function AlertItem({ alert, muted = false }: { alert: PeriodAlertItem; muted?: boolean }) {
  const Icon =
    alert.severity === "critical" || alert.severity === "high"
      ? AlertCircle
      : alert.severity === "medium"
      ? AlertTriangle
      : Info;
  const iconColor =
    alert.severity === "critical"
      ? "text-red-600"
      : alert.severity === "high"
      ? "text-red-500"
      : alert.severity === "medium"
      ? "text-amber-600"
      : "text-ink-mute";
  return (
    <li className={`flex items-start gap-2 text-[12.5px] leading-snug ${muted ? "opacity-65" : ""}`}>
      <Icon size={14} className={`flex-shrink-0 mt-0.5 ${iconColor}`} />
      <div>
        <span className="text-ink font-medium">{alert.title}</span>
        {alert.body && (
          <span className="text-ink-soft"> — {alert.body}</span>
        )}
      </div>
    </li>
  );
}

function RecItem({ rec, muted = false }: { rec: PeriodRecommendation; muted?: boolean }) {
  const isCritical = rec.urgency === "critical" || rec.urgency === "high";
  const isDone = (rec.status ?? "").toLowerCase() === "done";
  const Icon = isDone ? CheckCircle2 : isCritical ? AlertCircle : Info;
  const iconColor = isDone
    ? "text-emerald-600"
    : rec.urgency === "critical"
    ? "text-red-600"
    : rec.urgency === "high"
    ? "text-red-500"
    : rec.urgency === "medium"
    ? "text-amber-600"
    : "text-ink-mute";
  return (
    <li className={`flex items-start gap-2 text-[12.5px] leading-snug ${muted ? "opacity-65" : ""}`}>
      <Icon size={14} className={`flex-shrink-0 mt-0.5 ${iconColor}`} />
      <div>
        <span className="text-ink font-medium">{rec.title}</span>
        {rec.explanation && (
          <span className="text-ink-soft"> — {rec.explanation}</span>
        )}
      </div>
    </li>
  );
}
