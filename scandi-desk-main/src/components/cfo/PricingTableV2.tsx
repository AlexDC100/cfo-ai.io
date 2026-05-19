// PricingTableV2.tsx — dark-premium pricing table for /pricing and /landing.
//
// LAYOUT (May 2026 redesign spec §6)
//   ┌─────────────────────────────┐  ┌─────────────────────────────┐
//   │  STARTER                    │  │  PRO          Most popular │
//   │  €14.99 / month              │  │  €39.99 / month              │
//   │  ...features...              │  │  ...features...              │
//   │  [ Start Starter ]           │  │  [ Start Pro ]               │
//   └─────────────────────────────┘  └─────────────────────────────┘
//                          ─ Intro Unlock strip ─
//                       Or start a 7-day free trial →
//
// READS
//   GET /api/pricing/config — server is the single source of truth
//   for prices, included docs, extra-doc prices, and chat caps.
//
// WIRING
//   Plan CTAs route to `/api/checkout/start?tier=<key>` (existing
//   Stripe checkout). New tier price_ids are wired via env vars; until
//   that ships the endpoint returns a 501-style stub and the FE shows
//   a "Billing not connected" toast (caught at the page level).
//
// COPY RULES
//   · €0.99 intro is a one-time 7-day unlock — never "/month".
//   · "Most popular" on Pro per spec §6.
//   · Starter gets "Best for owners" badge.
//   · Free trial is messaged as a smaller link, not a 4th card.

import { Check, Sparkles, Zap } from "lucide-react";
import { Link } from "react-router-dom";

import { IntroUnlockCallout } from "./pricing/IntroUnlockCallout";
import {
  type PlanConfig,
  type PlanKey,
  formatEur,
  usePricingConfig,
} from "@/lib/pricingConfig";

interface Props {
  /** Optional — when provided, the "Start Starter / Start Pro" CTA flips
   *  to "Current plan" + disabled for the matching tier. The page-level
   *  /pricing surface passes this from `usePlanState`; the public landing
   *  page leaves it undefined so all CTAs are active. */
  currentPlanKey?: PlanKey | null;
  /** Click handler for the Intro Unlock callout. Defaults to the existing
   *  checkout endpoint with `tier=intro`. Provide a custom handler from
   *  /pricing to show the "billing not connected" copy if Stripe price_ids
   *  aren't wired. */
  onUnlockIntro?: () => void;
}

export function PricingTableV2({ currentPlanKey = null, onUnlockIntro }: Props) {
  const { config, loading } = usePricingConfig();

  if (loading || !config) {
    return (
      <section className="max-w-[1080px] mx-auto px-5 sm:px-8 py-12 text-center text-[13px] text-ink-mute">
        Loading pricing…
      </section>
    );
  }

  const starter = config.plans.find((p) => p.key === "starter");
  const pro = config.plans.find((p) => p.key === "pro");
  const intro = config.plans.find((p) => p.key === "intro");

  return (
    <section
      data-testid="pricing-table-v2"
      className="max-w-[1080px] mx-auto px-5 sm:px-8 pt-2 pb-10"
    >
      {/* Two prominent plan cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {starter && (
          <PlanCard
            plan={starter}
            badge="Best for owners"
            highlight={false}
            current={currentPlanKey === "starter"}
            features={STARTER_FEATURES}
            ctaLabel="Start Starter"
            extraDocCopy={`€${(starter.extra_doc_eur ?? 0).toFixed(2)} per extra document, shown and confirmed before processing`}
          />
        )}
        {pro && (
          <PlanCard
            plan={pro}
            badge="Most popular"
            highlight
            current={currentPlanKey === "pro"}
            features={PRO_FEATURES}
            ctaLabel="Start Pro"
            extraDocCopy={`€${(pro.extra_doc_eur ?? 0).toFixed(2)} per extra document, shown and confirmed before processing`}
          />
        )}
      </div>

      {/* Intro Unlock — small one-time strip BELOW the main plans.
          Strictly NOT a plan card. The component refuses to render if
          the backend ever marked intro recurring (defence-in-depth). */}
      {intro && (
        <div className="mt-6">
          <IntroUnlockCallout
            plan={intro}
            onUnlock={
              onUnlockIntro ??
              (() => {
                window.location.href = "/api/checkout/start?tier=intro";
              })
            }
          />
        </div>
      )}

      {/* Free trial tail-link — spec §6 doesn't show trial as a plan
          card, but new users still need a 'try first' entry point.
          A small link beneath the cards is the lightest-weight surface. */}
      <p className="mt-6 text-center text-[12.5px] text-ink-soft">
        Or{" "}
        <Link
          to="/signup"
          className="font-medium text-brand-d hover:text-brand underline-offset-2 hover:underline"
          data-testid="pricing-trial-link"
        >
          start a 7-day free trial
        </Link>{" "}
        — one document, no card required.
      </p>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Plan features — these are copy contracts from spec §6. Keep stable;
// changing them changes the marketing surface.
// ─────────────────────────────────────────────────────────────────────

const STARTER_FEATURES = [
  "5 financial documents / month",
  "Romanian bilanț, balanță, invoices, public filings",
  "CFO AI financial summary",
  "Basic ratios and risk flags",
  "PDF / HTML report export",
  "Ask CFO AI: 10/day, 50/month",
];

const PRO_FEATURES = [
  "15 financial documents / month",
  "Full CFO reports",
  "Trial balance analysis",
  "Benchmark intelligence",
  "Valuation module",
  "Board-ready reports",
  "Ask CFO AI: 40/day, 200/month",
  "Faster processing priority",
];

// ─────────────────────────────────────────────────────────────────────
// PlanCard
// ─────────────────────────────────────────────────────────────────────

function PlanCard({
  plan,
  badge,
  highlight,
  current,
  features,
  ctaLabel,
  extraDocCopy,
}: {
  plan: PlanConfig;
  badge: string;
  highlight: boolean;
  current: boolean;
  features: string[];
  ctaLabel: string;
  extraDocCopy: string;
}) {
  const ctaHref = `/api/checkout/start?tier=${plan.key}`;
  return (
    <article
      data-testid={`pricing-plan-${plan.key}`}
      data-highlight={highlight ? "true" : "false"}
      className={`
        relative rounded-2xl bg-surface/85 backdrop-blur-sm
        overflow-hidden
        ${highlight
          ? "border-2 border-brand/45 shadow-[0_24px_60px_-22px_rgba(45,191,179,0.55)] lg:-translate-y-2"
          : "border border-rule"}
        transition-transform
      `}
    >
      {/* Highlighted plan gets a thin colored accent strip along the top
          edge so the "Most popular" emphasis reads at a glance, not just
          via the small badge. Non-highlighted cards get no strip. */}
      {highlight && (
        <div
          aria-hidden
          data-testid={`pricing-plan-${plan.key}-accent`}
          className="h-1 w-full bg-gradient-to-r from-brand via-brand-d to-brand"
        />
      )}

      <div className="px-6 py-6">
        <span
          data-testid={`pricing-plan-${plan.key}-badge`}
          className={`
            inline-flex items-center gap-1.5 rounded-full px-2.5 py-1
            text-[10.5px] uppercase tracking-[0.1em] font-semibold
            ${highlight ? "bg-brand/15 text-brand-d" : "bg-bg-2 text-ink-soft"}
          `}
        >
          {highlight && <Sparkles size={10} strokeWidth={2} />}
          {badge}
        </span>

        <header className="mt-4">
          <h3 className="font-serif text-[26px] text-ink leading-tight">
            {plan.display_name}
          </h3>
          <p className="mt-1 text-[12.5px] text-ink-soft leading-snug">
            {plan.blurb}
          </p>
        </header>

        <div className="mt-5 flex items-baseline gap-2">
          <span
            data-testid={`pricing-plan-${plan.key}-price`}
            className={`
              font-semibold tabular-nums leading-none
              ${highlight
                ? "text-[44px] bg-gradient-to-br from-ink to-brand-d bg-clip-text text-transparent"
                : "text-[40px] text-ink"}
            `}
          >
            {formatEur(plan.price_eur)}
          </span>
          <span className="text-[13px] text-ink-soft">/ month</span>
        </div>
        <p className="mt-1 text-[11.5px] text-ink-mute">
          7-day free trial, then {formatEur(plan.price_eur)} / month
        </p>

        <ul className="mt-5 space-y-2 text-[13px] text-ink leading-snug">
          {features.map((f) => (
            <li key={f} className="flex items-start gap-2.5">
              <Check
                size={13}
                strokeWidth={2}
                className={`mt-0.5 shrink-0 ${highlight ? "text-brand" : "text-brand-d"}`}
              />
              <span>{f}</span>
            </li>
          ))}
        </ul>

        <div
          data-testid={`pricing-plan-${plan.key}-extra-doc`}
          className="mt-5 rounded-xl bg-bg-2/40 border border-rule/60 px-3 py-2.5 text-[11.5px] text-ink-soft leading-snug flex items-start gap-2"
        >
          <Zap size={11} strokeWidth={2} className="text-ink-mute mt-0.5 shrink-0" />
          <span>Above quota: {extraDocCopy}</span>
        </div>

        <div className="mt-5">
          {current ? (
            <button
              type="button"
              disabled
              data-testid={`pricing-plan-${plan.key}-current`}
              className="inline-flex items-center justify-center w-full h-11 rounded-xl border border-brand/40 bg-brand/10 text-brand-d text-[13.5px] font-medium cursor-default"
            >
              Current plan
            </button>
          ) : (
            <a
              href={ctaHref}
              data-testid={`pricing-plan-${plan.key}-cta`}
              className={`
                inline-flex items-center justify-center w-full h-11 rounded-xl
                text-[13.5px] font-medium transition-colors
                ${highlight
                  ? "bg-brand text-paper hover:bg-brand-d shadow-[0_8px_18px_-8px_rgba(45,191,179,0.6)]"
                  : "bg-ink text-paper hover:bg-ink/90"}
              `}
            >
              {ctaLabel}
            </a>
          )}
        </div>
      </div>
    </article>
  );
}
