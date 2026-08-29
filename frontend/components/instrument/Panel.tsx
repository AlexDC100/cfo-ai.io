// THE INSTRUMENT — Panel, Chip, PageHeader: the resting-surface system.
//
// A Panel is what a "card" becomes under this identity: hairline
// border, 10px radius, NO shadow at rest (depth is functional only —
// shadow tokens 1/2 are transparent, so even a stray shadow class
// flattens). The standard header row — 13px caps-muted title + actions
// — lives here so every screen's panels scan identically.
//
// Chip is the ONE chip system: trust states, jurisdictions, AI-read
// badges — semantic colors only from tokens, rounded-full, mono for
// values inside.
//
// PageHeader is the compact in-app header that replaces serif heroes:
// 11px caps eyebrow → 18-20px title + context + actions. The serif
// display voice survives only on marketing pages and empty states.

import { HTMLAttributes, ReactNode, forwardRef } from "react";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ── Panel ──────────────────────────────────────────────────────────────

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Quiet inset variant (bg-2) for nested regions. */
  inset?: boolean;
}

export const Panel = forwardRef<HTMLDivElement, PanelProps>(function Panel(
  { className, inset, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cx(
        "rounded-md border border-rule",
        inset ? "bg-bg-2" : "bg-surface",
        className,
      )}
      {...rest}
    />
  );
});

export function PanelHeader({
  title,
  actions,
  className,
}: {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex min-h-[40px] items-center justify-between gap-3 border-b border-rule-soft px-4 py-2",
        className,
      )}
    >
      <h3 className="text-[13px] font-medium uppercase tracking-[0.08em] text-ink-soft">
        {title}
      </h3>
      {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export function PanelBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("px-4 py-3", className)} {...rest} />;
}

// ── Chip ───────────────────────────────────────────────────────────────

export type ChipTone =
  | "neutral"   // ink on quiet fill
  | "accent"    // verified green-teal
  | "success"   // balanced / verified
  | "caution"   // RECONCILED (auto-adjusted) — amber
  | "alert"     // IMBALANCED — red, reserved
  | "info";     // slate

const CHIP_TONES: Record<ChipTone, string> = {
  neutral: "border-rule bg-bg-2 text-ink-2",
  accent: "border-transparent bg-brand-tint text-brand-d dark:text-brand-l",
  success: "border-transparent bg-success-tint text-success",
  caution: "border-transparent bg-caution-tint text-caution",
  alert: "border-transparent bg-alert-tint text-alert",
  info: "border-transparent bg-info-tint text-info",
};

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  /** Leading dot in the tone color (status chips). */
  dot?: boolean;
}

export function Chip({ tone = "neutral", dot, className, children, ...rest }: ChipProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-5",
        CHIP_TONES[tone],
        className,
      )}
      {...rest}
    >
      {dot ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

// ── PageHeader ─────────────────────────────────────────────────────────

export function PageHeader({
  eyebrow,
  title,
  context,
  actions,
  className,
}: {
  /** 11px caps line above the title ("FINANCIAL ANALYSIS"). */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Inline context after the title (period chip, meta). */
  context?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx("flex flex-wrap items-end justify-between gap-3 py-1", className)}>
      <div className="min-w-0">
        {eyebrow ? (
          <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-mute">
            {eyebrow}
          </div>
        ) : null}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h1 className="text-[19px] font-semibold leading-tight tracking-tight text-ink">
            {title}
          </h1>
          {context ? <div className="flex items-center gap-2 text-[13px] text-ink-soft">{context}</div> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
