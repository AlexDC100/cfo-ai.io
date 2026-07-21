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
//   Plan CTAs are <button onClick={handlePick}> — NOT links. Two paths:
//     · Unauthed → navigate("/signup?plan=<key>&intent=checkout"); the
//       intent is also persisted to localStorage["cfo.intent.plan"] so
//       AuthCard can echo + post-signup resume the checkout.
//     · Authed   → POST /api/checkout/start with `Authorization: Bearer
//       <Supabase JWT>` and `{ plan: <key>, locale }`; the backend
//       resolves the per-tier Stripe Price ID from STRIPE_PRICE_<TIER>
//       env vars and returns `{ url }`; we navigate there.
//   A 503 from the backend (price_id env unset, or Stripe SDK missing)
//   surfaces as a "Billing not connected" toast.
//
// COPY RULES
//   · €0.99 intro is a one-time 7-day unlock — never "/month".
//   · "Most popular" on Pro per spec §6.
//   · Starter gets "Best for owners" badge.
//   · Free trial is messaged as a smaller link, not a 4th card.

import { useState } from "react";
import { Check, Sparkles, Zap } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { IntroUnlockCallout } from "./pricing/IntroUnlockCallout";
import {
  type PlanConfig,
  type PlanKey,
  formatEur,
  usePricingConfig,
} from "@/lib/pricingConfig";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { getSupabase } from "@/lib/supabase";

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

/** POST /api/checkout/start with the user's Supabase JWT.
 *  Returns the Stripe Checkout session URL on success, null on auth/network
 *  failure, or "BILLING_NOT_CONNECTED" when the backend reports the tier's
 *  Stripe price_id env var is unset or Stripe SDK is missing (503 from
 *  `_create_simple_tier_session` / `_stripe_or_none`). The caller decides
 *  how to surface each case to the user. */
async function startCheckoutFor(plan: PlanKey): Promise<string | null | "BILLING_NOT_CONNECTED"> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) return null;
  try {
    const res = await fetch(`${API_URL}/api/checkout/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        plan,
        locale: (navigator.language || "en").slice(0, 2),
      }),
    });
    if (res.status === 503) return "BILLING_NOT_CONNECTED";
    if (!res.ok) return null;
    const body = await res.json();
    return (body.url as string) ?? null;
  } catch {
    return null;
  }
}

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
  const { status } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState<PlanKey | null>(null);

  /** Single click pathway for ALL plan CTAs (Starter, Pro, Intro Unlock).
   *  Unauthed users go through /signup; the persisted intent + ?plan param
   *  lets AuthCard echo the choice and the post-signup redirect resume the
   *  checkout. Authed users POST directly to /api/checkout/start with their
   *  Supabase JWT and land on the Stripe session URL on success. */
  async function handlePick(plan: PlanKey) {
    if (status !== "signed_in") {
      try {
        localStorage.setItem("cfo.intent.plan", plan);
      } catch {
        /* private mode — non-fatal */
      }
      navigate(`/signup?plan=${plan}&intent=checkout`);
      return;
    }

    setSubmitting(plan);
    const result = await startCheckoutFor(plan);
    setSubmitting(null);

    if (result === "BILLING_NOT_CONNECTED") {
      toast({
        title: "Billing not connected yet",
        description:
          "Stripe price IDs aren't wired for this tier yet. Please try again shortly.",
        variant: "destructive",
      });
      return;
    }
    if (!result) {
      toast({
        title: "Couldn't start checkout",
        description: "Please try again, or contact support if this persists.",
        variant: "destructive",
      });
      return;
    }
    window.location.href = result;
  }

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
            onPick={() => handlePick("starter")}
            submitting={submitting === "starter"}
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
            onPick={() => handlePick("pro")}
            submitting={submitting === "pro"}
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
            onUnlock={onUnlockIntro ?? (() => handlePick("intro"))}
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
  onPick,
  submitting,
}: {
  plan: PlanConfig;
  badge: string;
  highlight: boolean;
  current: boolean;
  features: string[];
  ctaLabel: string;
  extraDocCopy: string;
  onPick: () => void;
  submitting: boolean;
}) {
  return (
    <article
      data-testid={`pricing-plan-${plan.key}`}
      data-highlight={highlight ? "true" : "false"}
      className={`
        relative rounded-2xl bg-surface/85 backdrop-blur-sm
        overflow-hidden
        ${highlight
          ? "border-2 border-brand/45 shadow-[0_24px_60px_-22px_rgba(92,211,197,0.55)] lg:-translate-y-2"
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
            <button
              type="button"
              onClick={onPick}
              disabled={submitting}
              data-testid={`pricing-plan-${plan.key}-cta`}
              className={`
                inline-flex items-center justify-center w-full h-11 rounded-xl
                text-[13.5px] font-medium transition-colors
                disabled:opacity-60 disabled:cursor-wait
                ${highlight
                  ? "bg-brand text-paper hover:bg-brand-d shadow-[0_8px_18px_-8px_rgba(92,211,197,0.6)]"
                  : "bg-ink text-paper hover:bg-ink/90"}
              `}
            >
              {submitting ? "Opening checkout…" : ctaLabel}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
