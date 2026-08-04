// /pricing — public + post-signup pricing surface.
//
// COMPOSITION (May 2026 redesign spec §4)
//   ┌──────────────────────────────────────────┐
//   │ Logo                          Theme · Back to home │
//   ├──────────────────────────────────────────┤
//   │ PLANS & BILLING                                     │
//   │ Simple, honest pricing                              │
//   │ Subtitle …                                          │
//   │ [ Pro · active · €39.99/mo · Renews … · Cancel ]    │← status strip (authed)
//   │                                                     │
//   │            [ Monthly ]  [ Annual · Coming soon ]     │← billing-cycle toggle
//   │                                                     │
//   │   ┌─── Starter ───┐  ┌─── Pro ─── Most popular ─┐    │← two plan cards
//   │                                                     │
//   │              ─ Intro Unlock strip ─                 │
//   │            Or start a 7-day free trial →            │
//   │                                                     │
//   │            Monthly bill estimator (sliders)         │
//   │                                                     │
//   │            This month's usage (if authed)           │
//   │                                                     │
//   │                       FAQ                            │
//   │                                                     │
//   │   AI-assisted financial recommendations only.        │
//   └──────────────────────────────────────────┘
//
// CONFIG-DRIVEN. Every price, included-docs count, extra-doc fee, chat
// cap, and intro window comes from GET /api/pricing/config. The only
// hardcoded copy is marketing language (badges, FAQ answers) — those
// are spec contracts (§6, §9).

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, CheckCircle2, ShieldCheck } from "lucide-react";

import { Logo } from "@/components/cfo/Logo";
import { PricingTableV2 } from "@/components/cfo/PricingTableV2";
import {
  BillingCycleToggle,
  type BillingCycle,
} from "@/components/cfo/pricing/BillingCycleToggle";
import { MonthlyBillEstimator } from "@/components/cfo/pricing/MonthlyBillEstimator";
import { PricingFaq } from "@/components/cfo/pricing/PricingFaq";
import { UsageThisMonth } from "@/components/cfo/pricing/UsageThisMonth";

import { useAuth } from "@/lib/auth";
import { formatEur, usePricingConfig } from "@/lib/pricingConfig";
import { usePlanState } from "@/lib/planState";
import { useStripeSubscription, cancelAtPeriodEnd } from "@/lib/stripeBilling";
import { useToast } from "@/hooks/use-toast";
import { formatDateOnly } from "@/lib/locale";

export default function Pricing() {
  const { status, displayName } = useAuth();
  const isAuthed = status === "signed_in";
  const navigate = useNavigate();
  const { config } = usePricingConfig();
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  const { t } = useTranslation();

  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col">
      {/* ── Top bar ─────────────────────────────────────────────── */}
      <header className="px-5 sm:px-8 py-5 flex items-center justify-between gap-3">
        <Link to="/" className="flex items-center gap-3" aria-label={t("pricingX.home_aria")}>
          <Logo size={26} compact />
          <span className="hidden sm:inline-flex text-[10.5px] uppercase tracking-[0.18em] text-ink-soft pl-3 border-l border-rule">
            {t("authX.tagline")}
          </span>
        </Link>
        <div className="flex items-center gap-2">
          {isAuthed ? (
            <button
              onClick={() => navigate("/dashboard")}
              className="text-[13px] text-ink-soft hover:text-ink transition-colors"
              data-testid="pricing-back-to-app"
            >
              {displayName ? t("pricingX.continue_as", { name: displayName }) : t("pricingX.back_to_app")}
            </button>
          ) : (
            <Link
              to="/"
              className="text-[13px] text-ink-soft hover:text-ink transition-colors"
            >
              {t("auth.back_to_home")}
            </Link>
          )}
          {/* Sign-out intentionally NOT here — it lives in the account
              dropdown (single source of truth). See AccountMenu.tsx. */}
        </div>
      </header>

      <main className="flex-1">
        {/* ── Hero: ZERO-FRICTION OFFER ─────────────────────────────────────
            Restructured 2026-05-24 per the conversion-psychology spec:
            visitor lands on commitment level (zero), not price. The €0.99
            single-document trial + 7-day free trial are the only CTAs
            above the fold. Monthly subscription cards live BELOW the fold
            (scroll-driven discovery). Calendly / Notion / Linear playbook.

            Authed users skip this hero entirely — they already chose a
            plan and are here to manage it, so they go straight to the
            CurrentPlanStrip + the plan cards. */}
        {!isAuthed && <ZeroFrictionHero />}

        {/* ── Status strip (authed only) ───────────────────────────── */}
        {isAuthed && <CurrentPlanStrip />}

        {/* ── Authed-only hero: short utility header ─────────────── */}
        {isAuthed && (
          <section className="max-w-[860px] mx-auto px-5 sm:px-8 pt-6 pb-4 text-center">
            <h1 className="font-serif text-[28px] sm:text-[34px] leading-[1.05] tracking-[-0.02em] text-ink">
              {t("pricingX.your_plan_billing")}
            </h1>
          </section>
        )}

        {/* ── Section divider for unauth (visual cue: scrolled past hero) ── */}
        {!isAuthed && (
          <section className="max-w-[860px] mx-auto px-5 sm:px-8 pt-16 sm:pt-24 pb-2 text-center">
            <div className="inline-flex items-center gap-2 text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-medium">
              <span aria-hidden className="inline-block h-[7px] w-[7px] bg-[hsl(var(--brand))]" />
              {t("pricingX.plans_billing_eyebrow")}
            </div>
            <h2 className="mt-3 font-serif text-[28px] sm:text-[36px] leading-[1.04] tracking-[-0.02em] text-ink">
              {t("pricingX.plans_heading")}
            </h2>
            <p className="mt-3 text-[14px] text-ink-soft leading-relaxed max-w-[560px] mx-auto">
              {t("pricingX.plans_sub")}
            </p>
          </section>
        )}

        {/* ── Billing cycle toggle ───────────────────────────────── */}
        <div className="flex justify-center pt-6 pb-2">
          <BillingCycleToggle value={cycle} onChange={setCycle} />
        </div>

        {/* ── Plan cards ─────────────────────────────────────────── */}
        <PricingTableV2 currentPlanKey={isAuthed ? undefined : null} />

        {/* ── Monthly bill estimator ─────────────────────────────── */}
        {config && <MonthlyBillEstimator config={config} />}

        {/* ── This month's usage (renders only when authed; the
              component itself null-checks via usePlanState) ───── */}
        <UsageThisMonth />

        {/* ── FAQ ────────────────────────────────────────────────── */}
        <PricingFaq />

        {/* ── Footer disclaimer (spec §18) ───────────────────────── */}
        <footer className="max-w-[860px] mx-auto px-5 sm:px-8 pb-12 pt-6 text-center text-[11.5px] text-ink-mute leading-relaxed">
          {t("pricingX.disclaimer")}
        </footer>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// ZeroFrictionHero — the conversion-psychology rewrite (2026-05-24).
//
// Above-the-fold ONLY. Visitor sees commitment level (zero), not price.
// Two CTAs in priority order:
//   1. €0.99 single-document trial — lowest possible commitment short
//      of free; pay once, no subscription, see the full report
//   2. 7-day free trial            — no card required, more docs but
//      requires sign-up
//
// Monthly subscription plans live BELOW the fold. The visitor sees them
// only after scrolling, by which point they've either signed up or
// they're explicitly comparing tiers. Either way, price is the LAST
// number on the page, not the first. Calendly / Notion / Linear pattern.
//
// Authed users skip this hero entirely (they're here to manage, not
// to convert) — see the `!isAuthed && <ZeroFrictionHero />` gate above.
// ─────────────────────────────────────────────────────────────────────

function ZeroFrictionHero() {
  const { t } = useTranslation();
  return (
    <section
      data-testid="pricing-zero-friction-hero"
      className="relative overflow-hidden"
    >
      {/* Soft brand glow — visual weight without literal pricing imagery */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 w-[720px] h-[520px] rounded-full bg-brand/10 blur-[120px]"
      />

      <div className="relative max-w-[860px] mx-auto px-5 sm:px-8 pt-16 sm:pt-24 pb-12 sm:pb-20 text-center">
        {/* Eyebrow — frames the page as a trial offer, not pricing.
            2026-05-24 rev2: copy aligned to free-trial-only hero. */}
        <div className="inline-flex items-center gap-2 text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-medium">
          <span aria-hidden className="inline-block h-[7px] w-[7px] bg-[hsl(var(--brand))]" />
          {t("pricingX.hero_eyebrow")}
        </div>

        {/* Hero headline — value, not price */}
        <h1 className="mt-5 font-serif text-[44px] sm:text-[60px] lg:text-[72px] leading-[1.02] tracking-[-0.025em] text-ink">
          {t("pricingX.hero_title_pre")}{" "}
          <span className="text-gradient-cfo">{t("pricingX.hero_title_highlight")}</span>{" "}
          {t("pricingX.hero_title_post")}
        </h1>

        {/* Sub-copy — concrete value, no friction */}
        <p className="mt-5 text-[15.5px] sm:text-[16.5px] text-ink-soft leading-relaxed max-w-[600px] mx-auto">
          {t("pricingX.hero_sub")}
        </p>

        {/* Primary CTA — free trial (single big button, no secondary).
            2026-05-24 rev2: removed the €0.99 intro CTA after operator
            feedback. The intro tier remains available on the post-signup
            plan picker for users who explicitly want one-doc-only pricing. */}
        <div className="mt-9 flex items-center justify-center">
          <Link
            to="/signup?plan=trial"
            data-testid="pricing-cta-trial"
            className="
              inline-flex items-center gap-2.5
              h-14 px-8 rounded-full
              bg-gradient-cfo text-white
              text-[16px] font-medium
              shadow-2 hover:shadow-3
              transition-all hover:-translate-y-0.5
            "
          >
            {t("pricingX.hero_cta")}
            <ArrowRight size={16} strokeWidth={2.25} />
          </Link>
        </div>

        {/* Trust strip — addresses the three unspoken objections under the CTA */}
        <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[12.5px] text-ink-soft">
          <li className="inline-flex items-center gap-1.5">
            <CheckCircle2 size={13} strokeWidth={2} className="text-brand" />
            {t("pricingX.trust_no_card")}
          </li>
          <li className="inline-flex items-center gap-1.5">
            <CheckCircle2 size={13} strokeWidth={2} className="text-brand" />
            {t("pricingX.trust_full_report")}
          </li>
          <li className="inline-flex items-center gap-1.5">
            <CheckCircle2 size={13} strokeWidth={2} className="text-brand" />
            {t("pricingX.trust_cancel_anytime")}
          </li>
        </ul>

        {/* Compliance note — kept small + below the CTAs so it doesn't
            compete for attention with the primary action */}
        <p className="mt-7 inline-flex items-center gap-2 text-[11.5px] text-ink-soft/80">
          <ShieldCheck size={12} strokeWidth={1.75} className="text-brand/70" />
          {t("pricingX.hero_compliance")}
        </p>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// CurrentPlanStrip — only renders when the user has a plan_state row
// (trial / intro / starter / pro). Authed users on no plan see nothing
// (rare; shouldn't happen if signup creates a trial automatically).
// ─────────────────────────────────────────────────────────────────────

function CurrentPlanStrip() {
  const { state } = usePlanState();
  const { data: sub } = useStripeSubscription();
  const { toast } = useToast();
  const { t } = useTranslation();

  if (!state) return null;

  const isPaid = state.plan_recurring;
  const isTrial = state.plan_key === "trial";
  const isIntro = state.plan_key === "intro";
  const renews = sub?.current_period_end
    ? formatDateOnly(sub.current_period_end)
    : null;
  const cancelling = sub?.cancel_at_period_end;

  async function handleCancel() {
    const ok = await cancelAtPeriodEnd();
    toast({
      title: ok ? t("pricingX.cancel_scheduled_title") : t("pricingX.cancel_failed_title"),
      description: ok
        ? t("pricingX.cancel_scheduled_body")
        : t("pricingX.cancel_failed_body"),
      variant: ok ? undefined : "destructive",
    });
  }

  // Reference-style current-plan card (May 2026 restyle): vertical
  // hierarchy with a clear "Current plan" eyebrow → plan display name
  // (large) → price/cadence → secondary line with renewal or window
  // expiry. More prominent than the prior horizontal pill while still
  // sitting above the tier cards so the user immediately sees what
  // they're on before comparing tiers.
  const statusLabel = isTrial
    ? t("pricingX.status_trial")
    : isIntro
    ? t("pricingX.status_one_time_unlock")
    : cancelling
    ? t("pricingX.status_cancels_at_period_end")
    : t("pricingX.status_active");
  const priceLine = isPaid
    ? t("pricingX.price_per_month", { price: formatEur(state.plan_price_eur) })
    : isIntro
    ? t("pricingX.price_one_time", { price: formatEur(state.plan_price_eur) })
    : t("pricingX.price_free");
  const secondaryLine = (() => {
    if (isPaid && renews) return t("pricingX.renews_on", { date: renews });
    if (state.window_expires_at) {
      const expiry = formatDateOnly(state.window_expires_at);
      return isTrial
        ? t("pricingX.trial_expires", { date: expiry })
        : isIntro
        ? t("pricingX.unlock_expires", { date: expiry })
        : t("pricingX.expires", { date: expiry });
    }
    if (isTrial) return t("pricingX.docs_included", { count: state.included_docs });
    if (isIntro) return t("pricingX.docs_extra", { count: state.included_docs });
    return null;
  })();

  return (
    <section
      data-testid="current-plan-strip"
      data-plan-key={state.plan_key}
      className="max-w-[760px] mx-auto px-5 sm:px-8 mt-2"
    >
      <div className="rounded-2xl border border-brand/25 bg-gradient-to-br from-brand/12 via-bg-2/40 to-brand/8 backdrop-blur-sm p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-medium">
              <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-brand" />
              {t("pricingX.current_plan")}
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span
                data-testid="current-plan-name"
                className="font-serif text-[24px] sm:text-[28px] leading-tight text-ink"
              >
                {state.plan_display_name}
              </span>
              <span
                data-testid="current-plan-status"
                className={`text-[11px] uppercase tracking-[0.08em] font-semibold ${
                  cancelling ? "text-[#2AA89B]" : "text-brand-d"
                }`}
              >
                {statusLabel}
              </span>
            </div>
            <div
              data-testid="current-plan-price-line"
              className="mt-1 text-[14px] text-ink tabular-nums"
            >
              {priceLine}
            </div>
            {secondaryLine && (
              <div
                data-testid="current-plan-secondary"
                className="mt-0.5 text-[12px] text-ink-soft"
              >
                {secondaryLine}
              </div>
            )}
          </div>
          {isPaid && !cancelling && (
            <button
              type="button"
              onClick={handleCancel}
              data-testid="current-plan-cancel"
              className="
                shrink-0 inline-flex items-center h-8 px-3 rounded-md
                text-[12px] font-medium text-ink-soft
                hover:text-red-700 hover:bg-red-500/10
                transition-colors
              "
            >
              {t("pricingX.cancel_subscription")}
            </button>
          )}
          {(isTrial || isIntro) && (
            <span className="shrink-0 text-[12px] text-ink-soft">
              {t("pricingX.upgrade_anytime")}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
