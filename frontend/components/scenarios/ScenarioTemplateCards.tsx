// Scenario template cards — the "Start from a template" entry point.
//
// 2026-07-26: lifted out of AdjustmentEditor and placed ABOVE the
// drivers + results grid (full width), and restyled to match the Ask CFO AI
// suggested-prompt cards (left brand rule, centered icon + title, hairline
// divider, description) so the two "pick a starting point" surfaces read the
// same. One click seeds the relevant levers via applyTemplate.

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
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-semibold shrink-0">
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
            className="inline-flex items-center gap-1 text-[11.5px] text-ink-mute hover:text-ink min-h-[28px] px-1.5 rounded shrink-0"
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
                "rounded-lg border border-l-[3px] p-3 text-center",
                "transition-colors duration-150 ease-out",
                "focus:outline-none focus:ring-2 focus:ring-brand/30",
                isActive
                  ? "border-brand/60 border-l-brand bg-brand/[0.06] ring-1 ring-brand/20"
                  : "border-rule border-l-brand bg-surface hover:bg-transparent",
              )}
            >
              {/* Icon + title — vertically centered together (the template
                  names are single-line, so items-center keeps the icon and its
                  title on the same axis). Fixed min-height so the divider lands
                  at the same spot on every card. */}
              <div className="flex items-center justify-center gap-2 min-h-[52px] text-center">
                <Icon size={24} strokeWidth={1.75} className="text-brand-d shrink-0" />
                <span className="text-[12.5px] font-medium text-ink leading-tight">{tpl.name}</span>
              </div>
              <div aria-hidden className="w-40 max-w-full mx-auto h-px bg-gradient-to-r from-transparent via-rule-strong to-transparent mt-1 mb-3" />
              <p className="text-[11.5px] text-ink-soft leading-relaxed line-clamp-3">{tpl.description}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
