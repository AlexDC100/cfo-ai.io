import { ReactNode, useRef } from "react";
import { motion, useInView } from "framer-motion";
import { ease, easeSlow } from "@/lib/motion";

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
 *   - Card enters with a soft slide-up reveal when scrolled into view (once).
 *   - Subtle lift + shadow + accent-hued halo on hover. The halo is the
 *     "alive" cue — desktops feel responsive without being noisy.
 *   - Label still uses the existing label-eyebrow utility so the visual
 *     identity of cards across the app stays consistent.
 */
export function KpiCard({ label, value, hint, accent = "default" }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 16 }}
      animate={inView ? { opacity: 1, y: 0 } : undefined}
      transition={ease}
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
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={inView ? { opacity: 1, y: 0 } : undefined}
          transition={{ ...easeSlow, delay: 0.08 }}
          className={`relative mt-3 num-hero text-[clamp(28px,7vw,44px)] leading-[1.05] ${ACCENT_NUMBER[accent]}`}
        >
          {value}
        </motion.div>
        {hint && <div className="relative mt-2 text-[13px] text-ink-soft">{hint}</div>}
      </div>
    </motion.div>
  );
}
