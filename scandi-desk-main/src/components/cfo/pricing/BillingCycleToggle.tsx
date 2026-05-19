// BillingCycleToggle.tsx — segmented Monthly | Annual control for the
// pricing page header.
//
// Annual cycle is NOT wired to the backend yet — Stripe price_ids and
// `_pricing_config.py` plan rows are monthly-only. Per the redesign spec
// §5: show the toggle so the future capability is visible, but lock the
// Annual segment as "Coming soon" + disabled so a click can't 404. When
// the backend lands annual prices, the only change here is flipping
// `annualEnabled` to true via a prop (no rewrite).
//
// Decision encoding: the toggle's onChange always emits "monthly" today.
// The Annual button is rendered as an aria-disabled tooltip-style chip
// — purely informational.

import { Sparkles } from "lucide-react";

export type BillingCycle = "monthly" | "annual";

interface Props {
  value: BillingCycle;
  onChange: (next: BillingCycle) => void;
  /** When true, the Annual segment becomes clickable. Today: always false
   *  until Stripe annual price_ids ship. Kept as a prop so a future
   *  enablement is one line at the call site, no component rewrite. */
  annualEnabled?: boolean;
}

export function BillingCycleToggle({ value, onChange, annualEnabled = false }: Props) {
  return (
    <div
      data-testid="billing-cycle-toggle"
      role="tablist"
      aria-label="Billing cycle"
      className="
        inline-flex items-center gap-0.5 p-1
        rounded-full border border-rule/70
        bg-bg-2/40 backdrop-blur-sm
      "
    >
      <Segment
        active={value === "monthly"}
        onClick={() => onChange("monthly")}
        testId="billing-cycle-monthly"
      >
        Monthly
      </Segment>
      <Segment
        active={value === "annual" && annualEnabled}
        disabled={!annualEnabled}
        onClick={() => annualEnabled && onChange("annual")}
        testId="billing-cycle-annual"
        title={!annualEnabled ? "Annual pricing is on the roadmap" : undefined}
      >
        <span className="inline-flex items-center gap-1.5">
          Annual
          {!annualEnabled && (
            <span
              data-testid="billing-cycle-annual-coming-soon"
              className="inline-flex items-center gap-1 rounded-full bg-brand/12 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-brand-d"
            >
              <Sparkles size={9} strokeWidth={2} />
              Coming soon
            </span>
          )}
        </span>
      </Segment>
    </div>
  );
}

function Segment({
  active,
  disabled,
  onClick,
  testId,
  title,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  testId: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={onClick}
      title={title}
      data-testid={testId}
      data-active={active ? "true" : "false"}
      className={`
        inline-flex items-center justify-center h-8 px-3.5 rounded-full
        text-[12.5px] font-medium transition-all
        ${active
          ? "bg-surface text-ink shadow-[0_2px_8px_-4px_rgba(0,0,0,0.25)]"
          : disabled
          ? "text-ink-mute cursor-not-allowed"
          : "text-ink-soft hover:text-ink"}
      `}
    >
      {children}
    </button>
  );
}
