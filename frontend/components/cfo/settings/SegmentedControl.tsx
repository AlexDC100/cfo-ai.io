// THE INSTRUMENT — segmented control for Settings-style either/or choices
// (language, currency, theme, density). One hairline container, quiet
// inactive segments, surface-raised active segment. No animated fills —
// state reads from contrast alone, per the flat-at-rest identity.

import { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Small mono prefix (e.g. "EN", "RO"). */
  badge?: string;
  testId?: string;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-rule bg-bg-2 p-0.5",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={opt.testId}
            onClick={() => onChange(opt.value)}
            className={cn(
              // 44px touch target on phones; 28px inside the 32px rail on sm+.
              "inline-flex h-10 items-center gap-1.5 rounded-[7px] px-3 text-[12.5px] transition-colors duration-micro sm:h-7",
              active
                ? "bg-surface font-medium text-ink ring-1 ring-rule-strong"
                : "text-ink-soft hover:text-ink",
            )}
          >
            {opt.badge ? (
              <span
                className={cn(
                  "font-mono text-[10px] tracking-[0.08em]",
                  active ? "text-brand-d" : "text-ink-mute",
                )}
              >
                {opt.badge}
              </span>
            ) : null}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
