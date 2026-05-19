// IntroUnlockCallout.tsx — small one-time-purchase strip rendered BELOW
// the two main plan cards on /pricing.
//
// Spec hard rules (§6):
//   · Never use "€0.99/month"
//   · Never show "renews monthly"
//   · Never put Intro Unlock inside the monthly plan toggle
//   · NOT a subscription
//
// This component reads `intro` from the pricing config (single source of
// truth), so if the env var PRICING_INTRO_PRICE_EUR is overridden, the
// callout reflects it without touching code. The price + duration are
// rendered as a one-time charge over a fixed window — never as a per-
// period rate.

import { Sparkles, Zap } from "lucide-react";

import { type PlanConfig, formatEur } from "@/lib/pricingConfig";

interface Props {
  /** The "intro" PlanConfig from `usePricingConfig().config.plans`. */
  plan: PlanConfig;
  /** Click handler — routes to the existing /api/checkout/start?tier=intro
   *  flow, which honors `is_recurring_eligible_for_stripe_subscription`
   *  and creates a one-time charge (not a subscription). */
  onUnlock: () => void;
}

export function IntroUnlockCallout({ plan, onUnlock }: Props) {
  // Defence-in-depth: refuse to render if backend somehow returned
  // a `recurring: true` intro plan (would violate spec §6 hard rule).
  // The is_recurring_eligible_for_stripe_subscription guard already
  // catches this on the server, but the UI is the last line.
  if (plan.recurring) {
    if (typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.error(
        "[IntroUnlockCallout] refusing to render: intro plan marked recurring",
      );
    }
    return null;
  }

  const windowDays = plan.window_days ?? 7;

  return (
    <div
      data-testid="intro-unlock-callout"
      data-plan-key={plan.key}
      className="
        relative max-w-[680px] mx-auto rounded-2xl border border-brand/25
        bg-gradient-to-r from-brand/8 via-bg-2/40 to-brand/8
        backdrop-blur-sm px-5 py-4
        flex flex-col sm:flex-row sm:items-center gap-4
      "
    >
      <div className="flex items-center gap-3 min-w-0">
        <span
          aria-hidden
          className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-brand/15 text-brand-d shrink-0"
        >
          <Zap size={16} strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <div className="font-medium text-[14px] text-ink leading-tight">
            Need one more analysis?
          </div>
          <p className="text-[12.5px] text-ink-soft leading-snug mt-0.5">
            Unlock one extra document for {windowDays} days.{" "}
            <span
              data-testid="intro-not-a-subscription"
              className="font-medium text-ink-soft/90"
            >
              Not a subscription.
            </span>
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 sm:ml-auto shrink-0">
        <div className="text-right">
          <div
            data-testid="intro-price"
            className="text-[16px] font-semibold text-ink tabular-nums"
          >
            {formatEur(plan.price_eur)}
          </div>
          <div
            data-testid="intro-cadence"
            className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute"
          >
            One-time · {windowDays}-day window
          </div>
        </div>
        <button
          type="button"
          onClick={onUnlock}
          data-testid="intro-unlock-cta"
          className="
            inline-flex items-center gap-1.5 h-9 px-4 rounded-full
            bg-brand text-paper text-[12.5px] font-medium
            hover:bg-brand-d transition-colors
            shadow-[0_6px_14px_-6px_rgba(45,191,179,0.6)]
          "
        >
          <Sparkles size={12} strokeWidth={2} />
          Unlock one document
        </button>
      </div>
    </div>
  );
}
