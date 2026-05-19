// InsightCard — small contextual surface used to explain a section
// ("what changed", "why this matters") in a calm, restrained way.
//
// Three tones:
//   · "neutral" — light surface, ink-soft text, brand-tint left accent
//   · "watch"   — amber left accent, amber-tinted icon
//   · "risk"    — red left accent, used sparingly
//
// The tone palette intentionally re-uses the app's existing semantic
// tokens (brand, caution, alert) so this component looks identical to
// other callouts and doesn't introduce a new color language.

import type { ReactNode } from "react";
import { Info, AlertTriangle, AlertCircle, Lightbulb } from "lucide-react";

export type InsightTone = "neutral" | "watch" | "risk" | "tip";

interface Props {
  tone?: InsightTone;
  /** Short title — rendered with a tiny eyebrow caption. */
  eyebrow?: string;
  /** Body content — usually a sentence or two. */
  children: ReactNode;
  testid?: string;
}

const TONE_CLS: Record<InsightTone, { rail: string; icon: string; chip: string; Icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }> }> = {
  neutral: { rail: "border-l-brand/40",   icon: "text-brand-d",  chip: "bg-brand-tint text-brand-d",            Icon: Info },
  watch:   { rail: "border-l-amber-400/70", icon: "text-amber-600", chip: "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200", Icon: AlertTriangle },
  risk:    { rail: "border-l-red-400/70", icon: "text-red-600",  chip: "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-200", Icon: AlertCircle },
  tip:     { rail: "border-l-emerald-400/70", icon: "text-emerald-600", chip: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200", Icon: Lightbulb },
};

export function InsightCard({ tone = "neutral", eyebrow, children, testid }: Props) {
  const t = TONE_CLS[tone];
  const Icon = t.Icon;
  return (
    <aside
      data-testid={testid ?? "insight-card"}
      data-tone={tone}
      className={`
        rounded-2xl border border-rule bg-surface
        border-l-[3px] ${t.rail}
        px-4 py-3.5
        flex items-start gap-2.5
      `}
    >
      <Icon size={15} strokeWidth={1.75} className={`${t.icon} mt-0.5 shrink-0`} />
      <div className="min-w-0 flex-1">
        {eyebrow && (
          <div className="text-[10px] uppercase tracking-[0.14em] font-semibold mb-1 inline-flex items-center gap-1.5">
            <span className={`inline-block h-1 w-1 rounded-full ${t.chip}`} aria-hidden />
            <span className="text-ink-soft">{eyebrow}</span>
          </div>
        )}
        <div className="text-[13px] leading-relaxed text-ink-soft">
          {children}
        </div>
      </div>
    </aside>
  );
}
