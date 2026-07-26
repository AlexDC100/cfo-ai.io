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

import { useScenario } from "@/stores/scenario";
import { SCENARIO_LEVERS, type ScenarioLever } from "@/lib/scenarios/levers";
import { X } from "lucide-react";
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
    setLever,
    removeLever,
  } = useScenario();

  return (
    <div className="space-y-5" data-testid="adjustment-editor">
      {/* Levers — the templates ("Start from a template") moved above the
          drivers + results grid (ScenarioTemplateCards) 2026-07-26. */}
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
