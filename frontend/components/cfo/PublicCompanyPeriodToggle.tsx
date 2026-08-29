// NASDAQ-9 — Annual / Quarterly / TTM segmented control.
//
// Maps to Sharadar SF1 dimension codes ARY/ARQ/ART. Re-uses the same
// styling DNA as the RON/EUR/USD currency toggle in TopHeader so the
// platform feels coherent.

import type { Dimension } from "@/lib/publicCompanyApi";

interface Props {
  value: Dimension;
  onChange: (next: Dimension) => void;
  disabled?: boolean;
}

const OPTIONS: { code: Dimension; label: string; sub: string }[] = [
  { code: "ARY", label: "Annual",    sub: "as reported" },
  { code: "ARQ", label: "Quarterly", sub: "as reported" },
  { code: "ART", label: "TTM",       sub: "trailing 12mo" },
];

export function PublicCompanyPeriodToggle({ value, onChange, disabled = false }: Props) {
  return (
    <div
      data-testid="public-company-period-toggle"
      role="radiogroup"
      aria-label="Period dimension"
      className="
        inline-flex items-center gap-0.5
        h-8 p-0.5 rounded-sm
        border border-rule bg-bg-2/40
      "
    >
      {OPTIONS.map((opt) => {
        const active = value === opt.code;
        return (
          <button
            key={opt.code}
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.code)}
            data-testid={`public-company-period-${opt.code}`}
            className={`
              inline-flex items-center
              h-full px-3 rounded-sm
              text-[12.5px] font-medium
              transition-colors duration-micro
              disabled:opacity-50 disabled:cursor-not-allowed
              ${active
                ? "bg-surface text-ink ring-1 ring-inset ring-rule"
                : "text-ink-mute hover:text-ink"}
            `}
            title={opt.sub}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
