// AutoMasters — small shared pieces for the six screens. CFO AI's own
// tokens throughout (surface / rule / ink / brand, the semantic success /
// caution / alert): the addon is part of CFO AI, not a reskin of it.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useActiveLocale } from "@/lib/locale";
import { formatMoney, formatPct } from "@/lib/automasters/model";

export type Tone = "ok" | "warn" | "danger" | "info" | "muted";

const DOT: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-caution",
  danger: "bg-alert",
  info: "bg-info",
  muted: "bg-ink-mute",
};

const PILL: Record<Tone, string> = {
  ok: "bg-success-tint text-success",
  warn: "bg-caution-tint text-caution",
  danger: "bg-alert-tint text-alert",
  info: "bg-info-tint text-info",
  muted: "bg-bg-2 text-ink-soft",
};

export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cn("inline-block h-2 w-2 shrink-0 rounded-full", DOT[tone], className)} />;
}

/** A status always carries its word, never colour alone. */
export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
      PILL[tone],
    )}>
      <Dot tone={tone} />
      {children}
    </span>
  );
}

export function Card({ title, actions, children, className, bodyClassName }: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("rounded-md border border-rule bg-surface", className)}>
      {(title || actions) && (
        <header className="flex min-h-[44px] items-center gap-3 border-b border-rule px-4 py-2">
          {title && (
            <h2 className="flex-1 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-soft">{title}</h2>
          )}
          {actions}
        </header>
      )}
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Empty({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {body && <p className="max-w-[56ch] text-[13.5px] leading-relaxed text-ink-soft">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Amounts: monospace, tabular, never rounded — cents always shown. */
export function Amount({ value, currency = "EUR", className, strong }: {
  value: number | null;
  currency?: string;
  className?: string;
  strong?: boolean;
}) {
  const locale = useActiveLocale();
  return (
    <span className={cn("whitespace-nowrap font-mono tabular-nums", strong && "font-semibold text-ink", className)}>
      {value === null ? "—" : formatMoney(value, currency, locale)}
    </span>
  );
}

export function Pct({ value, signed, className }: { value: number | null; signed?: boolean; className?: string }) {
  const locale = useActiveLocale();
  return (
    <span className={cn("whitespace-nowrap font-mono tabular-nums", className)}>
      {formatPct(value, locale, signed)}
    </span>
  );
}

/** A blocked action names its reason in one line beside the button. */
export function BlockedNote({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="rounded-sm bg-alert-tint px-3 py-2 text-[13px] leading-snug text-alert">
      {children}
    </p>
  );
}
