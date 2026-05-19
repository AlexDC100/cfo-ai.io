// FinancialAssumptionsCard.tsx — central card for org-wide financial
// assumptions used across the analysis stack.
//
// SCOPE TODAY
//   · Cost of capital (annual %)  — display only; editor lands when
//                                    `simulate_cost_of_capital` flips
//                                    to active in the feature registry.
//   · Currency                    — display only; pulled from
//                                    organizations.default_currency once
//                                    the backend ships that column.
//   · Fiscal year                 — display only.
//
// HOW IT SHOULD GROW
//   Each row gates on a feature key. Editor controls (sliders / inputs)
//   appear as the underlying engine endpoints land. Until then we
//   surface the value the analysis stack actually uses (sourced from
//   the active period's metrics / org defaults) so users can see what
//   number their reports assume, even if they can't change it yet.
//
// WHY IT LIVES IN /settings (not Command Center)
//   Cleanup brief §11: financial assumptions belong here, alongside
//   industry, benchmarks, and data rules. Command Center is for quick
//   actions, not configuration.

import { Calendar, CircleDollarSign, Globe } from "lucide-react";

import { useFeatureStatus } from "@/lib/features";
import { useActivePeriod } from "@/lib/activePeriod";

// Conservative seed default — matches the legacy CommandDrawer copy
// "Cost of capital · 6.5% annual". When `simulate_cost_of_capital`
// flips to active, this becomes editable.
const DEFAULT_COST_OF_CAPITAL_PCT = 6.5;

export function FinancialAssumptionsCard() {
  const period = useActivePeriod();
  const cocStatus = useFeatureStatus("simulate_cost_of_capital");
  const editable = cocStatus === "active";

  return (
    <div className="rounded-xl border border-rule bg-surface" data-testid="settings-financial-assumptions">
      <AssumptionRow
        icon={CircleDollarSign}
        label="Cost of capital"
        value={`${DEFAULT_COST_OF_CAPITAL_PCT.toFixed(1)}% annual`}
        hint={
          editable
            ? "Used in DCF + ROIC overlays."
            : "Used in DCF + ROIC overlays. Editor lands with the simulation engine."
        }
        comingSoon={!editable}
      />
      <AssumptionRow
        icon={Globe}
        label="Reporting currency"
        // The period payload doesn't expose a `currency` field yet — we
        // surface a stable default (RON) until the backend ships one.
        value="RON"
        hint="Romanian Leu — RAS trial-balance input convention."
        comingSoon
      />
      <AssumptionRow
        icon={Calendar}
        label="Fiscal year"
        value={period.label ?? "Calendar (Jan – Dec)"}
        hint="Reads from the active period when set, otherwise calendar default."
        comingSoon={!period.label}
      />
    </div>
  );
}

function AssumptionRow({
  icon: Icon,
  label,
  value,
  hint,
  comingSoon,
}: {
  icon: typeof CircleDollarSign;
  label: string;
  value: string;
  hint: string;
  comingSoon?: boolean;
}) {
  return (
    <div
      className={`
        flex items-start gap-3 px-4 py-3 border-b border-rule last:border-b-0
        ${comingSoon ? "opacity-90" : ""}
      `}
      data-testid={`fa-row-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <span className="w-7 h-7 rounded-md grid place-items-center bg-bg-2 border border-rule text-ink-soft shrink-0">
        <Icon size={14} strokeWidth={1.75} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-[13.5px] text-ink font-medium">{label}</div>
          <div className="font-mono text-[12px] text-ink-soft tabular-nums">{value}</div>
        </div>
        <p className="text-[11.5px] text-ink-mute mt-0.5 leading-snug">{hint}</p>
      </div>
      {comingSoon && (
        <span className="
          inline-flex items-center h-5 px-2 rounded-full
          text-[9.5px] uppercase tracking-[0.1em] font-semibold
          bg-bg-2/60 border border-rule text-ink-mute
          shrink-0 mt-0.5
        ">
          Read-only
        </span>
      )}
    </div>
  );
}
