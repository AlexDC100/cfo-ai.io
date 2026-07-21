// F6.0.5 (2026-06-20) — Scenario adjustment editor (the input surface).
//
// Two ways to build a scenario:
//   1. Pick a template (Recession, Aggressive growth, Cost optimization,
//      Covenant stress test) — one click seeds the relevant levers.
//   2. Drag the levers directly (Revenue/rent, OpEx, CoS, CapEx, DSO, DIO,
//      tax rate).
//
// Lever engagement model:
//   · pct levers (revenue/opex/cogs/capex) — neutral is 0 (centre). A value
//     of 0 is a no-op and produces no adjustment.
//   · days / rate levers (dso/dio/tax) — every value is an explicit "set",
//     so they only apply once the user engages them (key present in store).
//     The reset ✕ detaches the lever.

import { useScenario, SCENARIO_TEMPLATES } from "@/stores/scenario";
import { SCENARIO_LEVERS, type ScenarioLever } from "@/lib/scenarios/levers";
import { RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";

function valueLabel(lever: ScenarioLever, v: number): string {
  if (lever.kind === "pct") {
    const sign = v > 0 ? "+" : v < 0 ? "−" : "";
    return `${sign}${Math.abs(v)}%`;
  }
  if (lever.kind === "days") return `${v}d`;
  return `${v}%`; // rate_pct
}

export function AdjustmentEditor() {
  const {
    leverValues,
    activeTemplateKey,
    isDirty,
    setLever,
    removeLever,
    applyTemplate,
    reset,
  } = useScenario();

  return (
    <div className="space-y-5" data-testid="adjustment-editor">
      {/* Templates */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-semibold">
            Start from a template
          </div>
          {isDirty && (
            <button
              type="button"
              onClick={reset}
              data-testid="scenario-reset"
              className="inline-flex items-center gap-1 text-[11.5px] text-ink-mute hover:text-ink min-h-[28px] px-1.5 rounded"
            >
              <RotateCcw className="w-3 h-3" />
              Reset
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {SCENARIO_TEMPLATES.map((tpl) => {
            const isActive = activeTemplateKey === tpl.key;
            return (
              <button
                key={tpl.key}
                type="button"
                onClick={() => applyTemplate(tpl.key)}
                data-testid={`scenario-template-${tpl.key}`}
                className={cn(
                  "text-left rounded-lg border px-3 py-2.5 transition-colors min-h-[44px]",
                  isActive
                    ? "border-[hsl(173,57%,55%)]/60 bg-[hsl(173,57%,55%)]/[0.06] ring-1 ring-[hsl(173,57%,55%)]/20"
                    : "border-rule bg-surface hover:bg-bg-2/50",
                )}
              >
                <div className="text-[12.5px] font-medium text-ink">{tpl.name}</div>
                <div className="text-[10.5px] text-ink-mute leading-snug line-clamp-2 mt-0.5">
                  {tpl.description}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Levers */}
      <div>
        <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-2">
          Adjust the drivers
        </div>
        <div className="space-y-3">
          {SCENARIO_LEVERS.map((lever) => {
            const engaged = lever.key in leverValues;
            const value = leverValues[lever.key] ?? lever.neutral;
            const showActive =
              engaged && !(lever.kind === "pct" && value === 0);
            return (
              <div
                key={lever.key}
                data-testid={`lever-${lever.key}`}
                data-engaged={showActive ? "true" : "false"}
                className={cn(
                  "rounded-lg border px-3 py-2.5 transition-colors",
                  showActive
                    ? "border-[hsl(173,57%,55%)]/40 bg-[hsl(173,57%,55%)]/[0.04]"
                    : "border-rule bg-surface",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[12.5px] font-medium text-ink">{lever.label}</div>
                  <div className="flex items-center gap-1.5">
                    <span
                      data-testid={`lever-value-${lever.key}`}
                      className={cn(
                        "text-[12px] tabular-nums font-semibold px-1.5 py-0.5 rounded",
                        showActive
                          ? "text-[hsl(173,57%,42%)] dark:text-[hsl(173,57%,60%)] bg-[hsl(173,57%,55%)]/10"
                          : "text-ink-mute",
                      )}
                    >
                      {valueLabel(lever, value)}
                    </span>
                    {engaged && (
                      <button
                        type="button"
                        onClick={() => removeLever(lever.key)}
                        aria-label={`Remove ${lever.label}`}
                        data-testid={`lever-remove-${lever.key}`}
                        className="text-ink-mute hover:text-ink min-w-[32px] min-h-[32px] grid place-items-center rounded hover:bg-bg-2"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                <input
                  type="range"
                  min={lever.min}
                  max={lever.max}
                  step={lever.step}
                  value={value}
                  onChange={(e) => setLever(lever.key, Number(e.target.value))}
                  data-testid={`lever-slider-${lever.key}`}
                  aria-label={lever.label}
                  className="w-full mt-2 accent-[hsl(173,57%,45%)] cursor-pointer touch-none"
                />
                <div className="text-[10.5px] text-ink-mute leading-snug mt-1">
                  {lever.hint}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
