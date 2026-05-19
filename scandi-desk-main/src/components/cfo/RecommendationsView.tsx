// Reference-format recommendations renderer.
//
// Pure-frontend: reads the canonical PeriodFacts, runs deterministic rule
// detection, renders each detected condition as a card with rationale +
// actions + facts-backing expander.
//
// When the backend supplies LLM-generated rationale/actions (server-side
// recommendations table populated by the Opus 4.7 call), those override
// the static fallbacks. Until then, the static fallbacks render as-is —
// always grounded in the exact facts, never hallucinated numbers.

import { useState } from "react";
import { ChevronRight, AlertOctagon, AlertTriangle, Info } from "lucide-react";
import type { PeriodFacts } from "@/lib/periodFacts";
import {
  detectConditions,
  severityRank,
  type DetectedCondition,
  type Severity,
} from "@/lib/recommendationRules";
import { formatRON } from "@/lib/formatRon";

interface Props {
  facts: PeriodFacts;
}

export function RecommendationsView({ facts }: Props) {
  const conditions = detectConditions(facts).sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
  );

  if (conditions.length === 0) {
    return (
      <div className="rounded-2xl border border-rule bg-surface p-8 text-center text-ink-soft">
        <p className="font-serif text-[20px] text-ink mb-2">No conditions flagged</p>
        <p className="text-[13.5px]">
          The detection rules examined ratios, cash flow, and balance-sheet flags — nothing triggered.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-[22px] text-ink">Recommendations</h2>
        <p className="text-[12px] text-ink-mute font-mono uppercase tracking-[0.14em]">
          {conditions.length} condition{conditions.length === 1 ? "" : "s"} detected
        </p>
      </div>

      {conditions.map((c) => (
        <ConditionCard key={c.ruleKey} condition={c} />
      ))}

      <p className="text-[12px] text-ink-mute pt-2">
        Detection rules are deterministic — the same {facts.entity} facts always produce the same conditions.
        Each card cites exact numbers from <code>period_facts</code> (expandable via "Facts backing").
      </p>
    </div>
  );
}

function ConditionCard({ condition }: { condition: DetectedCondition }) {
  const [factsOpen, setFactsOpen] = useState(false);
  const sevPalette = severityClasses(condition.severity);
  const Icon = severityIcon(condition.severity);

  return (
    <article
      className={`rounded-2xl border bg-surface overflow-hidden ${sevPalette.border}`}
      data-testid={`rec-card-${condition.ruleKey}`}
    >
      {/* Header */}
      <div className={`px-5 py-3 flex items-start gap-3 ${sevPalette.headerBg}`}>
        <Icon size={18} strokeWidth={2} className={`mt-0.5 shrink-0 ${sevPalette.iconColor}`} />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full font-mono text-[10px] uppercase tracking-[0.16em] font-semibold ${sevPalette.pillBg}`}
            >
              {condition.severity}
            </span>
            <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-mute">
              {condition.ruleKey}
            </span>
          </div>
          <h3 className="mt-1.5 text-[14.5px] font-medium text-ink leading-snug">
            {condition.title}
          </h3>
        </div>
      </div>

      {/* Body */}
      <div className="px-5 py-4 space-y-4">
        <p className="text-[13.5px] text-ink-soft leading-relaxed">{condition.rationaleFallback}</p>

        <div>
          <h4 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-mute mb-2">
            Suggested actions
          </h4>
          <ul className="space-y-1.5">
            {condition.actionsFallback.map((a, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] text-ink">
                <span className="text-brand-d mt-0.5">→</span>
                <span>{a}</span>
              </li>
            ))}
          </ul>
        </div>

        {condition.whatNotToDoFallback && (
          <div className="rounded-lg p-3 bg-caution-tint/60 border-l-2 border-caution">
            <p className="text-[13px] text-ink">
              <strong className="text-ink">What not to do:</strong> {condition.whatNotToDoFallback}
            </p>
          </div>
        )}

        <button
          type="button"
          onClick={() => setFactsOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 text-[12px] text-ink-soft hover:text-ink transition-colors"
        >
          <ChevronRight
            size={12}
            strokeWidth={2}
            className={`transition-transform ${factsOpen ? "rotate-90" : ""}`}
          />
          Facts backing this recommendation
        </button>
        {factsOpen && (
          <div className="rounded-lg border border-rule bg-bg-2/40 p-3 font-mono text-[11.5px] leading-relaxed">
            {Object.entries(condition.factsCited).map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between py-0.5 border-b border-rule/40 last:border-0">
                <span className="text-ink-soft">{k}</span>
                <span className="text-ink tabular-nums">
                  {typeof v === "number" && Math.abs(v) > 1 ? formatRON(v) : String(v)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

// ─── Severity styling ───────────────────────────────────────────────────

function severityClasses(s: Severity) {
  switch (s) {
    case "critical":
      return {
        border: "border-alert/60",
        headerBg: "bg-alert/10",
        iconColor: "text-alert",
        pillBg: "bg-alert text-paper",
      };
    case "attention":
      return {
        border: "border-caution/60",
        headerBg: "bg-caution-tint",
        iconColor: "text-caution",
        pillBg: "bg-caution text-ink",
      };
    case "info":
      return {
        border: "border-info/40",
        headerBg: "bg-info-tint/60",
        iconColor: "text-info",
        pillBg: "bg-info text-paper",
      };
  }
}

function severityIcon(s: Severity) {
  switch (s) {
    case "critical":
      return AlertOctagon;
    case "attention":
      return AlertTriangle;
    case "info":
      return Info;
  }
}
