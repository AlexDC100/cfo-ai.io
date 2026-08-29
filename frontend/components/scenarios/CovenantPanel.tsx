// F6.0.5 (2026-06-20) — Covenant impact panel.
//
// The single most valuable scenario output for a CFO with bank debt:
// "if this happens, do my covenants still hold?" For each covenant we show
// the threshold, the baseline value, the scenario value, and a status chip
// (pass / near / breach) computed by the deterministic covenant engine.
//
// detectCovenantBreaches returns only the non-passing covenants; we iterate
// the full covenant set so passing ones still render, giving the reader a
// complete compliance picture rather than only the alarms.
//
// Instrument pass (2026-08): Panel + Chip; multiples through the ≥99×
// discipline (a wiped-out denominator states the bound, never "Infinity×").
// Semantics: pass = success, near = caution, breach = alert — the one
// place on this screen where red is earned.

import {
  detectCovenantBreaches,
  computeMetric,
  type Covenant,
  type CovenantMetricKey,
} from "@/lib/scenarios/covenants";
import type { CascadeState } from "@/lib/scenarios/cascade";
import { Panel, PanelHeader, Chip, type ChipTone } from "@/components/instrument/Panel";
import { CappedMultiple } from "@/components/comparison/MoneyAmount";
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

function MetricValue({ v, className }: { v: number | null; className?: string }) {
  if (v === null || Number.isNaN(v)) return <span className={className}>n/a</span>;
  return <CappedMultiple value={v} cap={99} className={className} />;
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
    <Panel data-testid="covenant-panel" className="overflow-hidden">
      <PanelHeader
        title="Covenant impact"
        actions={
          active ? (
            breachCount > 0 ? (
              <Chip tone="alert" dot data-testid="covenant-breach-count">
                {breachCount} breach{breachCount > 1 ? "es" : ""}
              </Chip>
            ) : (
              <Chip tone="success" dot>All clear</Chip>
            )
          ) : undefined
        }
      />

      <div className="divide-y divide-rule-soft">
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
                  <div className="text-[11px] text-ink-soft mt-0.5">
                    {METRIC_LABEL[cov.metric]} {opGlyph(cov.operator)}{" "}
                    <span className="font-mono tabular-nums">{cov.threshold.toFixed(2)}×</span>
                  </div>
                </div>
                <StatusChip status={status} />
              </div>

              <div className="mt-2 flex items-center gap-4 text-[11.5px]">
                <span className="text-ink-soft">
                  Baseline{" "}
                  <MetricValue v={baseVal} className="text-ink-soft" />
                </span>
                {active && (
                  <span className="text-ink-soft">
                    Scenario{" "}
                    <MetricValue
                      v={scenVal}
                      className={cn(
                        "font-semibold",
                        status === "breach"
                          ? "text-alert"
                          : status === "near"
                            ? "text-caution"
                            : "text-ink",
                      )}
                    />
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
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

function StatusChip({ status }: { status: Status }) {
  const map: Record<Status, { label: string; tone: ChipTone; Icon: typeof ShieldCheck }> = {
    pass: { label: "Pass", tone: "success", Icon: ShieldCheck },
    near: { label: "Near limit", tone: "caution", Icon: ShieldAlert },
    breach: { label: "Breach", tone: "alert", Icon: ShieldX },
    na: { label: "n/a", tone: "neutral", Icon: ShieldAlert },
  };
  const { label, tone, Icon } = map[status];
  return (
    <Chip tone={tone} data-testid="covenant-status-pill" className="shrink-0">
      <Icon className="w-3 h-3" />
      {label}
    </Chip>
  );
}
