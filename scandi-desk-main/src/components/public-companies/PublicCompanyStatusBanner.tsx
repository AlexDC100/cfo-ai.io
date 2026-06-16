// Compact status banner — single source of truth for Nasdaq connection state.
//
// Replaces the previous big amber explainer + scattered "Demo data" pills
// + separate API-key-status badge in the search panel header. One pill,
// top-right of the page header. Color codes the three live states:
//   · live + entitled        → emerald  "Live · Nasdaq connected"
//   · live + no entitlement  → amber    "Nasdaq connected · dataset unavailable"
//   · no key                 → amber    "Demo mode · Nasdaq key missing"
//
// On hover/click, expands with a one-line tooltip explaining the next step.

import { CheckCircle2, AlertTriangle, ShieldAlert } from "lucide-react";

interface Props {
  keyConfigured: boolean;
  subscriptionRequired: boolean | null;
  keyTag?: string;
  className?: string;
}

export function PublicCompanyStatusBanner({
  keyConfigured,
  subscriptionRequired,
  className = "",
}: Props) {
  const status: "live" | "no-entitlement" | "no-key" =
    !keyConfigured ? "no-key"
    : subscriptionRequired === true ? "no-entitlement"
    : "live";

  const config = {
    live: {
      icon: CheckCircle2,
      label: "Live",
      sub: "Nasdaq connected",
      tone: "emerald" as const,
    },
    "no-entitlement": {
      icon: AlertTriangle,
      label: "Nasdaq connected",
      sub: "Dataset unavailable for this ticker",
      tone: "amber" as const,
    },
    "no-key": {
      icon: ShieldAlert,
      label: "Demo mode",
      sub: "Nasdaq key missing",
      tone: "amber" as const,
    },
  }[status];

  const toneClass = config.tone === "emerald"
    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20"
    : "bg-amber-500/10 text-amber-800 dark:text-amber-200 border-amber-500/30";

  const Icon = config.icon;
  return (
    <span
      data-testid="public-company-status-banner"
      data-status={status}
      className={`
        inline-flex items-center gap-2
        h-8 px-3 rounded-full
        text-[11.5px] font-medium tabular-nums
        border ${toneClass}
        ${className}
      `}
      title={config.sub}
    >
      <Icon size={12} strokeWidth={2} />
      <span>{config.label}</span>
      <span className="opacity-60">·</span>
      <span className="opacity-80">{config.sub}</span>
    </span>
  );
}
