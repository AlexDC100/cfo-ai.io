// Settings → Billing — a single card showing the plan the user is ON.
//
// VISUAL SOURCE: the marketing site's pricing cards (`pricingGrid` in
// pages/cfo/Landing.tsx). Those are raw HTML strings inside a template
// literal, not a component, so they can't be imported — this is a React
// port of the same design, matched value-for-value against the featured
// ("Most popular") variant:
//
//   border   1.5px solid var(--brand)        → border-[1.5px] border-brand
//   radius   20px                            → rounded-[20px]
//   padding  30px                            → p-[30px]
//   shadow   0 24px 60px -30px rgba(92,211,197,.5)
//   badge    absolute top:-11px left:30px, mono 10px, brand fill, #04110F text
//   name     mono 11px uppercase, letter-spacing .16em, brand
//   price    serif 52px, ink   ·   suffix 14px ink-soft
//   note     12.5px ink-mute
//   blurb    13.5px ink-soft, margin-top 14px
//   features 13.5px, 11px gap, teal ✓ bullets
//
// DATA SOURCE is deliberately NOT the landing page's. Landing hardcodes
// Solo €19.99 / Business €59 — plan names with no checkout wiring. This
// card reads the live tier from /api/plan/state + /api/pricing/config, the
// same server truth PricingTableV2 and the AccountMenu use, so a signed-in
// user never sees a plan or price that doesn't exist in Stripe.

import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import { usePlanState } from "@/lib/planState";
import {
  formatEur,
  usePricingConfig,
  type PlanConfig,
  type PlanKey,
} from "@/lib/pricingConfig";
// Shared with /pricing's grid — see lib/planFeatures.ts for why the lists
// live outside both components.
import { planFeaturesFor } from "@/lib/planFeatures";
import { formatDateOnly } from "@/lib/locale";

export function CurrentPlanCard() {
  const { state, loading: planLoading } = usePlanState();
  const { config, loading: configLoading } = usePricingConfig();
  const { i18n } = useTranslation();

  if (planLoading || configLoading) {
    return (
      <div
        data-testid="current-plan-card-loading"
        className="rounded-[20px] border border-rule bg-surface p-[30px] text-[13px] text-ink-soft"
      >
        Loading your plan…
      </div>
    );
  }

  const key = (state?.plan_key ?? "trial") as PlanKey;
  // Prefer the pricing config's copy (blurb, canonical price); fall back to
  // plan state so the card still renders if /api/pricing/config is down.
  const plan: Pick<PlanConfig, "display_name" | "blurb" | "price_eur" | "recurring"> =
    config?.plans.find((p) => p.key === key) ?? {
      display_name: state?.plan_display_name ?? "Free trial",
      blurb: "",
      price_eur: state?.plan_price_eur ?? 0,
      recurring: state?.plan_recurring ?? false,
    };

  // Landing quotes recurring plans as "€X /mo". A one-time intro unlock and
  // a zero-price trial are not per-month, so they get their own suffix
  // rather than a "/mo" that would misstate what's charged.
  const priceSuffix = plan.recurring
    ? "/mo"
    : plan.price_eur > 0
      ? "one-time"
      : "";

  const features = planFeaturesFor(key, i18n.language);

  return (
    <article
      data-testid="current-plan-card"
      data-plan-key={key}
      // `relative` anchors the badge, which the landing design hangs off
      // the top edge at -11px.
      className="
        relative rounded-[20px] border-[1.5px] border-brand bg-surface p-[30px]
        shadow-[0_24px_60px_-30px_rgba(92,211,197,0.5)]
      "
    >
      {/* Badge carries the tier name itself, matching the landing cards
          where the badge slot names the plan. "Current plan" was redundant
          with the section it sits in. */}
      <span className="absolute -top-[11px] left-[30px] rounded-full bg-brand px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#04110F]">
        {plan.display_name}
      </span>

      {/* Landing stacks identity → price → features vertically because it
          shows three cards side by side. Here there's only one card, so the
          full width is available: identity/price on the left, features
          beside them. Wraps back to stacked below ~640px. */}
      <div className="flex flex-wrap items-start gap-x-10 gap-y-6">
        <div className="min-w-[180px]">
          {/* The mono plan-name eyebrow above the price was dropped — the
              badge hanging off the card's top edge already names the tier,
              so it appeared twice within 40px. */}
          <div className="flex items-baseline gap-1.5">
            <span className="font-serif text-[52px] leading-none text-ink">
              {formatEur(plan.price_eur)}
            </span>
            {priceSuffix && (
              <span className="text-[14px] text-ink-soft">{priceSuffix}</span>
            )}
          </div>

          {state?.window_expires_at && !plan.recurring && (
            <div className="mt-1.5 text-[12.5px] text-ink-mute">
              {t("pricing.accessUntil", {
                date: formatDateOnly(state.window_expires_at, {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                }),
              })}
            </div>
          )}

          {plan.blurb && (
            <p className="mt-[14px] max-w-[280px] text-[13.5px] text-ink-soft">
              {plan.blurb}
            </p>
          )}
        </div>

        {features.length > 0 && (
          // Vertical rule separates the identity/price column from the
          // feature list. `self-stretch` isn't available on the <ul> in a
          // wrapping flex row, so the border is on the list itself and
          // drops to a top border once the row wraps to stacked.
          <ul className="flex-1 min-w-[240px] flex flex-col gap-[11px] text-[13.5px] text-ink border-t sm:border-t-0 sm:border-l border-rule pt-6 sm:pt-0 sm:pl-10">
            {features.map((f) => (
              <li key={f} className="flex items-start gap-2.5">
                <Check size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-brand" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
