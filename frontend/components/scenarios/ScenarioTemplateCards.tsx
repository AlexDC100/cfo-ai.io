// Scenario template cards — the "Start from a template" entry point.
//
// 2026-07-26: lifted out of AdjustmentEditor and placed ABOVE the
// drivers + results grid (full width). One click seeds the relevant
// levers via applyTemplate.
//
// Instrument pass (2026-08): each template is a Panel; the SELECTED one
// carries the accent left rule + brand-tinted ground, the rest sit on
// plain hairlines (an always-on accent rail on four idle cards would
// spend the one accent on nothing).

import { useScenario, SCENARIO_TEMPLATES } from "@/stores/scenario";
import {
  RotateCcw,
  Scissors,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  recession: TrendingDown,
  aggressive_growth: TrendingUp,
  cost_optimization: Scissors,
  covenant_stress_test: ShieldAlert,
};

export function ScenarioTemplateCards({ headerRight }: { headerRight?: ReactNode }) {
  const { activeTemplateKey, isDirty, applyTemplate, reset } = useScenario();

  return (
    <div data-testid="scenario-templates">
      <div className="flex items-center justify-between gap-4 mb-2">
        <div className="flex items-center gap-4 min-w-0 flex-wrap">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-soft font-medium shrink-0">
            Start from a template
          </div>
          {/* Live scenario impact summary — sits to the right of the label
              (2026-07-26 per operator). */}
          {headerRight}
        </div>
        {isDirty && (
          <button
            type="button"
            onClick={reset}
            data-testid="scenario-reset"
            className="inline-flex items-center gap-1 text-[11.5px] text-ink-soft hover:text-ink min-h-[28px] px-1.5 rounded-sm shrink-0"
          >
            <RotateCcw className="w-3 h-3" />
            Reset
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        {SCENARIO_TEMPLATES.map((tpl) => {
          const Icon = TEMPLATE_ICONS[tpl.key] ?? TrendingDown;
          const isActive = activeTemplateKey === tpl.key;
          return (
            <button
              key={tpl.key}
              type="button"
              onClick={() => applyTemplate(tpl.key)}
              data-testid={`scenario-template-${tpl.key}`}
              aria-pressed={isActive}
              className={cn(
                "rounded-md border p-3 text-left",
                "transition-colors duration-micro ease-out",
                "focus:outline-none focus:ring-2 focus:ring-brand/30",
                isActive
                  ? "border-rule border-l-[3px] border-l-brand bg-brand-tint/50"
                  : "border-rule border-l-[3px] border-l-transparent bg-surface hover:bg-bg-2",
              )}
            >
              <div className="flex items-center gap-2">
                <Icon
                  size={16}
                  strokeWidth={1.75}
                  className={cn("shrink-0", isActive ? "text-brand-dark dark:text-brand-light" : "text-ink-soft")}
                />
                <span className="text-[12.5px] font-medium text-ink leading-tight">{tpl.name}</span>
              </div>
              <p className="mt-1.5 text-[11.5px] text-ink-soft leading-relaxed line-clamp-3">{tpl.description}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
