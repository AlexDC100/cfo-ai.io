import { ReactNode } from "react";
import { motion } from "framer-motion";

interface Props {
  label: string;
  value: ReactNode;
  hint?: string;
  trend?: "up" | "down" | "flat";
  accent?: "default" | "danger" | "success" | "warning" | "info";
}

// Each accent corresponds to a token-aligned color for the number, plus a
// soft halo of the same hue on hover. Halo opacity stays ≤30% so it never
// competes with the data — it's a presence cue, not a chrome element.
const ACCENT_NUMBER: Record<NonNullable<Props["accent"]>, string> = {
  default: "text-ink",
  danger:  "text-alert",
  success: "text-success",
  warning: "text-caution",
  info:    "text-info",
};

const ACCENT_HALO: Record<NonNullable<Props["accent"]>, string> = {
  default: "bg-brand/30",
  danger:  "bg-alert/30",
  success: "bg-success/40",
  warning: "bg-caution/40",
  info:    "bg-info/40",
};

/**
 * KPI card — the most-used surface across CFO AI's authenticated views.
 *
 * Cleo-style treatment:
 *   - Number renders in Instrument Serif italic (`num-hero`) at 44px instead
 *     of regular serif at 36px. The italic + tabular-nums combo reads like
 *     a financial publication tear-out, not a dashboard widget.
 *   - Subtle lift + shadow + accent-hued halo on hover. The halo is the
 *     "alive" cue — desktops feel responsive without being noisy.
 *   - Label still uses the existing label-eyebrow utility so the visual
 *     identity of cards across the app stays consistent.
 *
 * No entrance animation: cards render at full opacity immediately so
 * switching into a tab never fades content in.
 */
export function KpiCard({ label, value, hint, accent = "default" }: Props) {
  return (
    <motion.div
      whileHover={{ y: -3, scale: 1.012 }}
      // Spring on the hover state — snappier than the entrance.
      style={{ transformStyle: "preserve-3d" }}
    >
      <div className="relative cfo-surface px-6 py-5 transition-shadow hover:shadow-2 overflow-hidden group">
        {/* Accent halo — bloom of the value's color in the corner on hover. */}
        <div
          aria-hidden
          className={`pointer-events-none absolute -top-10 -right-10 w-32 h-32 rounded-full blur-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 ${ACCENT_HALO[accent]}`}
        />
        <div className="relative label-eyebrow text-ink-soft">{label}</div>
        <div
          className={`relative mt-3 num-hero text-[clamp(28px,7vw,44px)] leading-[1.05] ${ACCENT_NUMBER[accent]}`}
        >
          {value}
        </div>
        {hint && <div className="relative mt-2 text-[13px] text-ink-soft">{hint}</div>}
      </div>
    </motion.div>
  );
}
