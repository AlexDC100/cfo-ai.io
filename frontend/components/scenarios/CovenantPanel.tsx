// F6.0.5 (2026-06-20) — Covenant impact panel.
//
// The single most valuable scenario output for a CFO with bank debt:
// "if this happens, do my covenants still hold?" For each covenant we show
// the threshold, the baseline value, the scenario value, and a status pill
// (pass / near / breach) computed by the deterministic covenant engine.
//
// detectCovenantBreaches returns only the non-passing covenants; we iterate
// the full covenant set so passing ones still render (green), giving the
// reader a complete compliance picture rather than only the alarms.

import {
  detectCovenantBreaches,
  computeMetric,
  type Covenant,
  type CovenantMetricKey,
} from "@/lib/scenarios/covenants";
import type { CascadeState } from "@/lib/scenarios/cascade";
import { cn } from "@/lib/utils";
import { ShieldCheck, ShieldAlert, ShieldX } from "lucide-react";

interface Props {
  baseline: CascadeState;
  scenario: CascadeState;
  covenants: Covenant[];
  active: boolean;
}

type Status = "pass" | "near" | "breach" | "na";

const METRIC_LABEL: Record<CovenantMetricKey, string> = {
  net_debt_to_ebitda: "Net debt / EBITDA",
  ebitda_to_interest: "Interest coverage",
  current_ratio: "Current ratio",
  quick_ratio: "Quick ratio",
  debt_to_equity: "Debt / equity",
};

function fmt(metric: CovenantMetricKey, v: number | null): string {
  if (v === null || Number.isNaN(v)) return "n/a";
  // EBITDA ≤ 0 / equity ≤ 0 surface as +Infinity (worst-case sentinel from
  // computeMetric). Show ">99×" rather than "Infinity×" — the breach pill
  // carries the alarm; this just says "off the scale".
  if (!Number.isFinite(v)) return ">99×";
  return `${v.toFixed(2)}×`;
}

function opGlyph(op: Covenant["operator"]): string {
  return op === "<=" ? "≤" : op === ">=" ? "≥" : op;
}

export function CovenantPanel({ baseline, scenario, covenants, active }: Props) {
  if (covenants.length === 0) return null;

  // Severity map keyed by covenantId for the ACTIVE (scenario) state.
  const scenarioBreaches = detectCovenantBreaches(
    active ? scenario : baseline,
    covenants,
  );
  const sevById = new Map(scenarioBreaches.map((b) => [b.covenantId, b.severity]));

  const breachCount = scenarioBreaches.filter((b) => b.severity === "breach").length;

  return (
    <div
      data-testid="covenant-panel"
      className="rounded-xl border border-rule bg-surface overflow-hidden"
    >
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-rule bg-bg-2/40">
        <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-semibold">
          Covenant impact
        </div>
        {active && breachCount > 0 && (
          <span
            data-testid="covenant-breach-count"
            className="text-[10.5px] font-semibold text-rose-600 dark:text-rose-400"
          >
            {breachCount} breach{breachCount > 1 ? "es" : ""}
          </span>
        )}
        {active && breachCount === 0 && (
          <span className="text-[10.5px] font-semibold text-[hsl(173,57%,42%)] dark:text-[hsl(173,57%,60%)]">
            All clear
          </span>
        )}
      </div>

      <div className="divide-y divide-rule/60">
        {covenants.map((cov) => {
          const baseVal = computeMetric(baseline, cov.metric);
          const scenVal = computeMetric(scenario, cov.metric);
          const status: Status = !active
            ? statusFromSeverity(sevById.get(cov.id), baseVal)
            : statusFromSeverity(sevById.get(cov.id), scenVal);
          return (
            <div
              key={cov.id}
              data-testid={`covenant-row-${cov.metric}`}
              data-status={status}
              className="px-4 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-ink truncate">
                    {cov.name}
                  </div>
                  <div className="text-[11px] text-ink-mute mt-0.5">
                    {METRIC_LABEL[cov.metric]} {opGlyph(cov.operator)} {cov.threshold.toFixed(2)}×
                  </div>
                </div>
                <StatusPill status={status} />
              </div>

              <div className="mt-2 flex items-center gap-4 text-[11.5px]">
                <span className="text-ink-mute">
                  Baseline{" "}
                  <span className="tabular-nums text-ink-soft">{fmt(cov.metric, baseVal)}</span>
                </span>
                {active && (
                  <span className="text-ink-mute">
                    Scenario{" "}
                    <span
                      className={cn(
                        "tabular-nums font-semibold",
                        status === "breach"
                          ? "text-rose-600 dark:text-rose-400"
                          : status === "near"
                            ? "text-[#2AA89B] dark:text-[#5CD3C5]"
                            : "text-ink",
                      )}
                    >
                      {fmt(cov.metric, scenVal)}
                    </span>
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function statusFromSeverity(
  sev: "breach" | "warning" | undefined,
  value: number | null,
): Status {
  if (value === null || Number.isNaN(value)) return "na";
  if (sev === "breach") return "breach";
  if (sev === "warning") return "near";
  return "pass";
}

function StatusPill({ status }: { status: Status }) {
  const map: Record<Status, { label: string; cls: string; Icon: typeof ShieldCheck }> = {
    pass: {
      label: "Pass",
      cls: "bg-[hsl(173,57%,55%)]/10 text-[hsl(173,57%,42%)] dark:text-[hsl(173,57%,60%)]",
      Icon: ShieldCheck,
    },
    near: {
      label: "Near limit",
      cls: "bg-[#5CD3C5]/10 text-[#2AA89B] dark:text-[#5CD3C5]",
      Icon: ShieldAlert,
    },
    breach: {
      label: "Breach",
      cls: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
      Icon: ShieldX,
    },
    na: {
      label: "n/a",
      cls: "bg-white/[0.04] text-ink-mute",
      Icon: ShieldAlert,
    },
  };
  const { label, cls, Icon } = map[status];
  return (
    <span
      data-testid="covenant-status-pill"
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-md shrink-0",
        "text-[10.5px] font-semibold whitespace-nowrap",
        cls,
      )}
    >
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
}
