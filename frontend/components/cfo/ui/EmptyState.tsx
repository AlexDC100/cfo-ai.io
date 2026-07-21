// EmptyState — unified empty/pre-data surface used wherever a page
// has no data yet. Replaces ad-hoc one-off empty markers across
// Benchmark, Decisions, Alerts, etc. with a single visual vocabulary
// that matches the rest of the design system.
//
// Composition:
//   · large rounded icon tile (gradient ring matches brand accent)
//   · title (sans, font-semibold)
//   · supporting copy
//   · primary + optional secondary CTA
//   · optional footnote / hint
//
// Does NOT manufacture data. Honest empty-state is its whole purpose.

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface Props {
  icon: LucideIcon;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Primary action — full brand-gradient pill. */
  primary?: { label: string; onClick: () => void; testid?: string };
  /** Secondary action — outlined glass pill. */
  secondary?: { label: string; onClick: () => void; testid?: string };
  /** Optional footnote rendered under the CTA row (italic, ink-mute). */
  footnote?: ReactNode;
  /** Wider card variant — defaults to the standard centred layout. */
  variant?: "centered" | "panel";
  testid?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  subtitle,
  primary,
  secondary,
  footnote,
  variant = "centered",
  testid,
}: Props) {
  const isPanel = variant === "panel";
  return (
    <section
      data-testid={testid ?? "empty-state"}
      className={`
        relative overflow-hidden
        rounded-3xl border border-rule
        bg-gradient-to-br from-bg-2/40 via-surface to-surface
        ring-1 ring-inset ring-white/[0.03]
        shadow-[0_24px_48px_-30px_rgba(0,0,0,0.18)]
        ${isPanel ? "px-6 sm:px-8 py-7 sm:py-8" : "px-6 sm:px-8 py-10 sm:py-12 text-center"}
      `}
    >
      <div aria-hidden className="pointer-events-none absolute -top-16 -right-16 h-44 w-44 rounded-full bg-brand/10 blur-3xl" />

      <div className={`relative ${isPanel ? "" : "max-w-[520px] mx-auto"}`}>
        <span
          className={`
            inline-flex items-center justify-center
            h-12 w-12 rounded-2xl
            bg-gradient-to-br from-brand/15 to-brand-d/20
            text-brand-d
            ring-1 ring-brand/15
            ${isPanel ? "" : "mb-4"}
          `}
        >
          <Icon size={20} strokeWidth={1.75} />
        </span>
        <h2 className={`${isPanel ? "mt-4" : ""} text-[22px] sm:text-[24px] leading-tight font-semibold tracking-[-0.005em] text-ink`}>
          {title}
        </h2>
        {subtitle && (
          <p className="mt-2 text-[13.5px] text-ink-soft leading-relaxed">
            {subtitle}
          </p>
        )}
        {(primary || secondary) && (
          <div className={`mt-5 flex ${isPanel ? "" : "justify-center"} items-center gap-2 flex-wrap`}>
            {primary && (
              <button
                type="button"
                onClick={primary.onClick}
                data-testid={primary.testid}
                className="
                  inline-flex items-center gap-2 h-10 px-4 rounded-lg
                  bg-gradient-to-b from-brand to-brand-d text-paper text-[13px] font-medium
                  shadow-[0_8px_22px_-8px_rgba(42,168,155,0.6)]
                  hover:shadow-[0_10px_26px_-8px_rgba(42,168,155,0.75)]
                  ring-1 ring-inset ring-white/15
                  transition-all
                "
              >
                {primary.label}
              </button>
            )}
            {secondary && (
              <button
                type="button"
                onClick={secondary.onClick}
                data-testid={secondary.testid}
                className="
                  inline-flex items-center gap-2 h-10 px-4 rounded-lg
                  border border-rule bg-surface text-ink text-[13px] font-medium
                  hover:bg-bg-2/60 hover:border-rule-strong
                  transition-colors
                "
              >
                {secondary.label}
              </button>
            )}
          </div>
        )}
        {footnote && (
          <p className={`mt-4 text-[11px] text-ink-mute italic ${isPanel ? "" : "max-w-[420px] mx-auto"}`}>
            {footnote}
          </p>
        )}
      </div>
    </section>
  );
}
