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
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info, AlertCircle, CheckCircle2 } from "lucide-react";
import type { PeriodRecommendation, PeriodAlertItem } from "@/lib/activePeriod";
import type { Currency } from "@/lib/rates";
import {
  dedupeAlerts,
  dedupeRecommendations,
  type DedupedAlert,
  type DedupedRecommendation,
} from "@/lib/dedupeNotes";
import { linkifyAlertBody } from "@/lib/linkifyAlertBody";
import { NarrativeText } from "@/lib/narrativeMoney";
import { buildFindingsReport, type Finding } from "@/lib/findings";
import { AllChecksList, FindingCard } from "@/components/cfo/findings";

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

// Severity-rank for ordering inside the visible bucket. Critical items appear
// first; recommendations land last unless explicitly filtered to. Module-level
// because it's static — and because it used to be declared BELOW the
// empty-state early return, which is what forced the sorting hooks down there
// with it (see the hook-order note in the component).
const SEVERITY_RANK: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4,
};

/** Which statement a contract finding is about. `Account.statement` is
 *  the engine's own answer ("BS" / "PL" / "CF"); the keyword regex is
 *  only consulted for a finding whose accounts declare nothing. */
function findingBelongsTo(f: Finding, scope: StatementNotesScope): boolean {
  const declared = (f.elements.subject?.accounts ?? [])
    .map((a) => (a.statement ?? "").toUpperCase())
    .filter(Boolean);
  if (declared.length) return declared.includes(scope.toUpperCase());
  const hay = `${f.title ?? ""} ${f.body ?? ""} ${f.category}`;
  return RELEVANCE_KEYWORDS[scope].test(hay);
}

export function StatementNotes({ recommendations, alerts, relevantTo }: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<SeverityFilter>("all");

  // CONTRACT ROWS FIRST. A row carrying `contract_elements` was written
  // by `_finding.to_payload`, which means it has already been judged
  // against the seven; it renders as a FindingCard and never enters the
  // legacy dedup/keyword pipeline below. Rows without them predate the
  // rebuild and keep the old path — running one row through both would
  // list the same finding twice in two different voices.
  const { report, legacyAlerts } = useMemo(() => {
    const contract: unknown[] = [];
    const legacy: PeriodAlertItem[] = [];
    for (const a of alerts) {
      if (a && typeof a === "object" && "contract_elements" in a) contract.push(a);
      else legacy.push(a);
    }
    return { report: buildFindingsReport(contract), legacyAlerts: legacy };
  }, [alerts]);

  const scopedFindings = useMemo(
    () => report.surfaced.filter((f) => findingBelongsTo(f, relevantTo)),
    [report.surfaced, relevantTo],
  );

  const { relevantAlerts, otherAlerts, relevantRecs, otherRecs, counts } = useMemo(() => {
    const dedupedAlerts = dedupeAlerts(legacyAlerts);
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
  }, [recommendations, legacyAlerts, relevantTo]);

  const totalCount = counts.all;

  // ALL hooks run before the empty-state return below (2026-07-26). These two
  // useMemos used to sit under it, so a period with notes followed by one
  // without ran four hooks and then two on the same component instance —
  // React's "Rendered fewer hooks than expected", which is exactly what
  // crashed the dashboard when switching to a period with no trial balance.
  // Their inputs all come from the useMemo above, so hoisting is free.

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

  // Honest empty state. Never fabricate filler.
  //
  // NOTE the `!report.hasContractRows` guard: a period whose alerts are
  // ALL contract rows has `totalCount === 0` on the legacy pipeline, and
  // returning "no notes generated" there would deny findings that are
  // sitting right above. Silence is a claim about checks that ran, and
  // this branch cannot make it.
  if (totalCount === 0 && !report.hasContractRows) {
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
          {t("tablesV2.notes.heading", "Notes & recommendations")}
        </h3>
        <div className="rounded-lg border border-rule bg-bg-2/40 px-4 py-3 text-[12.5px] text-ink-soft flex items-center gap-2">
          <Info size={14} className="text-ink-mute flex-shrink-0" />
          <span>{t("tablesV2.notes.empty", "No notes generated for this period.")}</span>
        </div>
      </section>
    );
  }

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
          {t("tablesV2.notes.heading", "Notes & recommendations")}
        </h3>
        <span className="text-[11.5px] text-ink-mute">
          {t("tablesV2.notes.unique", {
            defaultValue: "{{count}} unique",
            count: totalCount + scopedFindings.length,
          })}
        </span>
      </div>

      {/* Contract findings for THIS statement, then everything that did
          not become one. A demoted row appears only under All checks —
          never in the note list above it. */}
      {scopedFindings.length > 0 || report.checks.length > 0 ? (
        <div className="mb-4 space-y-3" data-testid={`statement-findings-${relevantTo}`}>
          {scopedFindings.map((f) => (
            <FindingCard key={f.key} finding={f} compact />
          ))}
          {/* The checks list is period-wide, not statement-scoped: a rule
              that ran is a rule that ran wherever you are standing. It is
              rendered only when there is something in it — an empty
              "no checks recorded" note on a tab whose sibling just
              surfaced a finding would be a false claim about the run. */}
          {report.checks.length > 0 ? <AllChecksList report={report} /> : null}
        </div>
      ) : null}

      {/* Severity filter pills — legacy rows only. Suppressed entirely
          when the period carries none, so a fully-rebuilt period does
          not show five zero-count filters over an empty list. */}
      {totalCount === 0 ? null : (
      <>
      <div className="flex flex-wrap items-center gap-1.5 mb-3.5">
        <FilterPill label={t("tablesV2.notes.filterAll", "All")}                         count={counts.all}             active={filter === "all"}             onClick={() => { setFilter("all"); }} />
        <FilterPill label={t("tablesV2.notes.filterCritical", "Critical")}               count={counts.critical}        active={filter === "critical"}        onClick={() => { setFilter("critical"); }} tone="critical" />
        <FilterPill label={t("tablesV2.notes.filterWatch", "Watch")}                     count={counts.watch}           active={filter === "watch"}           onClick={() => { setFilter("watch"); }} tone="watch" />
        <FilterPill label={t("tablesV2.notes.filterInfo", "Info")}                       count={counts.info}            active={filter === "info"}            onClick={() => { setFilter("info"); }} tone="info" />
        <FilterPill label={t("tablesV2.notes.filterRecommendations", "Recommendations")} count={counts.recommendations} active={filter === "recommendations"} onClick={() => { setFilter("recommendations"); }} tone="rec" />
      </div>

      {/* Card list ────────────────────────────────────────────── */}
      <ul className="space-y-2">
        {shown.length === 0 && (
          <li className="rounded-lg border border-rule bg-bg-2/40 px-4 py-3 text-[12.5px] text-ink-soft">
            {t("tablesV2.notes.emptyFilter", "No items in this filter.")}
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
      </>
      )}

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
    tone === "critical" ? "data-[active=true]:bg-alert-tint data-[active=true]:text-alert"
    : tone === "watch"  ? "data-[active=true]:bg-brand-tint data-[active=true]:text-brand-d dark:data-[active=true]:text-brand-l"
    : tone === "info"   ? "data-[active=true]:bg-brand-tint data-[active=true]:text-brand-d dark:data-[active=true]:text-brand-l"
    : tone === "rec"    ? "data-[active=true]:bg-brand-tint data-[active=true]:text-brand-d dark:data-[active=true]:text-brand-l"
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

/** The currency the alert's facts are denominated in. Engine rows carry
 *  it explicitly; older rows predate the field and are RON — every one of
 *  the 128 production periods is. */
function sourceCurrencyOf(alert: PeriodAlertItem): Currency {
  const c = (alert.source_currency ?? "").toUpperCase();
  return c === "EUR" || c === "USD" ? (c as Currency) : "RON";
}

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
            {/* ONE CURRENCY PER CLAIM — title included.
              *
              * The title used to render RAW while the body one line below
              * was linkified and converted. 8 of the 17 engine rules put
              * money in the title, and 10 live rows read two currencies
              * across those two lines — including every
              * `concentration_intercompany_loan` row, the reported 461
              * defect's own rule. Both halves now go through the same
              * renderer, which resolves named facts rather than guessing
              * money out of rendered text. Rows with no template fall
              * back to the stored string unchanged. */}
            <span className="text-[13px] text-ink font-medium leading-snug">
              <NarrativeText
                text={alert.title}
                template={alert.title_template}
                facts={alert.facts_cited}
                factUnits={alert.fact_units}
                sourceCurrency={sourceCurrencyOf(alert)}
              />
            </span>
            <DuplicateCountPill count={deduped.duplicateCount} sourceIds={deduped.sourceIds} />
          </div>
          {alert.body && (
            <div className="mt-1 text-[12.5px] text-ink-soft leading-relaxed">
              <NarrativeText
                text={alert.body}
                template={alert.body_template}
                facts={alert.facts_cited}
                factUnits={alert.fact_units}
                sourceCurrency={sourceCurrencyOf(alert)}
              />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

// ─── Recommendation card ────────────────────────────────────────
function RecCard({ deduped }: { deduped: DedupedRecommendation }) {
  const { t } = useTranslation();
  const rec = deduped.rec;
  const isDone = (rec.status ?? "").toLowerCase() === "done";
  const Icon = isDone ? CheckCircle2 : Info;

  // Recommendations are their own "recommendation" category — teal/brand tint
  // (color-coded like the other severities: critical=red, watch=amber,
  // info=blue, recommendation=teal).
  return (
    <li
      className="
        relative rounded-lg border border-rule border-l-[3px] border-l-brand
        bg-brand/[0.06]
        px-3.5 py-2.5
      "
    >
      <div className="flex items-start gap-2.5">
        <Icon size={14} className="flex-shrink-0 mt-[3px] text-brand" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="text-[10px] uppercase tracking-[0.1em] text-brand font-semibold">
              {t("tablesV2.notes.recommendation", "Recommendation")}
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
  const { t } = useTranslation();
  if (count <= 1) return null;
  const ids = `${sourceIds.slice(0, 8).join(", ")}${sourceIds.length > 8 ? `, +${sourceIds.length - 8}` : ""}`;
  return (
    <span
      className="inline-flex items-center rounded-full bg-ink-mute/15 px-1.5 py-px text-[10px] font-medium text-ink-mute tabular-nums"
      title={t("tablesV2.notes.dupTitle", { defaultValue: "Fired {{count}}× this period. Source row ids: {{ids}}", count, ids })}
      aria-label={t("tablesV2.notes.dupAria", { defaultValue: "This alert was emitted {{count}} times in this period — collapsed.", count })}
    >
      ×{count}
    </span>
  );
}
