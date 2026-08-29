import { ReactNode } from "react";

interface Props {
  label: string;
  value: ReactNode;
  hint?: string;
  trend?: "up" | "down" | "flat";
  accent?: "default" | "danger" | "success" | "warning" | "info";
}

// Accent colors the figure only, via semantic tokens — never the chrome.
const ACCENT_NUMBER: Record<NonNullable<Props["accent"]>, string> = {
  default: "text-ink",
  danger:  "text-alert",
  success: "text-success",
  warning: "text-caution",
  info:    "text-info",
};

/**
 * KPI stat panel (THE INSTRUMENT).
 *
 *   - 11px caps label, mono tabular figure — the ledger voice, not the
 *     serif tear-out. Serif display survives only on marketing/empty
 *     states, and a KPI card is neither.
 *   - Hairline border, flat at rest: no hover lift, no halo, no shadow.
 *     Depth is functional only under this identity.
 *
 * API unchanged — callers keep label/value/hint/accent.
 */
export function KpiCard({ label, value, hint, accent = "default" }: Props) {
  return (
    <div className="rounded-md border border-rule bg-surface px-5 py-4 min-w-0">
      {/* D1 axe: ink-soft, not ink-mute — mute is ~3.5:1 on surface at 11px. */}
      <div className="text-[11px] uppercase tracking-[0.08em] text-ink-soft font-medium">
        {label}
      </div>
      <div
        className={`mt-2.5 font-mono tabular-nums text-[clamp(20px,4vw,28px)] font-medium leading-[1.05] [overflow-wrap:anywhere] ${ACCENT_NUMBER[accent]}`}
      >
        {value}
      </div>
      {hint && <div className="mt-1.5 text-[12.5px] text-ink-soft">{hint}</div>}
    </div>
  );
}
