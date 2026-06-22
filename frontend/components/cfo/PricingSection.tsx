// Pricing section embedded on the landing page (also routable via /pricing).
//
// MODEL: one product, two introductory prices.
//   · Founding Member — €1 charged at signup, then €99/year. Limited to first 500 sign-ups.
//   · Standard        — 14-day free trial, then €99/year.
//
// The full €99/year renewal price appears at equal visual weight to the €1
// — "then €99/year" is the line that prevents chargebacks at month 3. The
// FAQ surfaces the renewal email expectation and the cancel rule explicitly.
//
// The Founding Member card displays a live seats-remaining counter via
// useFounderCohort() (reads the public founder_cohort_public view, polls
// every 60s). When seats_left hits 0 the card hides automatically; only
// Standard renders.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Sparkle, Zap } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useFounderCohort } from "@/lib/founder";
import { useToast } from "@/hooks/use-toast";
import { getSupabase } from "@/lib/supabase";

const FEATURES_SHARED = [
  "Unlimited document uploads",
  "CFO-grade analysis with 25+ ratios",
  "Industry-aware recommendations",
  "Ask CFO AI mastermind assistant",
  "EBITDA × peer-multiple valuation",
  "SKU portfolio analytics",
  "Multi-country, multi-language (15 EU countries)",
  "Email support",
] as const;

type PlanKey = "founder" | "standard";

async function startCheckout(plan: PlanKey, locale: string): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) return null;
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  try {
    const res = await fetch(`${apiUrl}/api/checkout/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ plan, locale }),
    });
    if (res.status === 409) {
      return "FOUNDER_SOLD_OUT";
    }
    if (!res.ok) return null;
    const body = await res.json();
    return body.url as string;
  } catch {
    return null;
  }
}

export function PricingSection() {
  const navigate = useNavigate();
  const { status, user } = useAuth();
  const { toast } = useToast();
  const cohort = useFounderCohort();
  const [submitting, setSubmitting] = useState<PlanKey | null>(null);

  const founderAvailable = cohort.seats_left > 0;

  async function handlePick(plan: PlanKey) {
    if (status !== "signed_in") {
      // Persist intent across the signup roundtrip so AuthCard can echo
      // the choice and the post-signup redirect knows where to go.
      try {
        localStorage.setItem("cfo.intent.plan", plan);
      } catch { /* private mode */ }
      navigate(`/signup?plan=${plan}`);
      return;
    }

    setSubmitting(plan);
    const url = await startCheckout(plan, (navigator.language || "en").slice(0, 2));
    setSubmitting(null);
    if (url === "FOUNDER_SOLD_OUT") {
      toast({
        title: "Founding Member is sold out",
        description: "Choose Standard or join the waitlist.",
        variant: "destructive",
      });
      return;
    }
    if (!url) {
      toast({
        title: "Couldn't start checkout",
        description: "Please try again, or contact support if this persists.",
        variant: "destructive",
      });
      return;
    }
    window.location.href = url;
  }

  return (
    <section
      data-testid="pricing-section"
      id="pricing"
      className="px-5 sm:px-8 lg:px-10 py-16 sm:py-20 bg-bg"
    >
      <div className="max-w-[1100px] mx-auto">
        <header className="text-center mb-12">
          <div className="inline-flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-soft font-medium">
            <span className="inline-block h-[7px] w-[7px] bg-[hsl(var(--brand))]" aria-hidden />
            Pricing
          </div>
          <h2 className="mt-4 font-serif text-[36px] sm:text-[44px] text-ink leading-[1.05]">
            One product. Two ways to start.
          </h2>
          <p className="mt-3 text-[15px] text-ink-soft max-w-[600px] mx-auto">
            Same product, same full feature set. Choose how you want to begin.
          </p>
        </header>

        <div className={`grid gap-5 ${founderAvailable ? "lg:grid-cols-2" : "lg:grid-cols-1 max-w-[480px] mx-auto"}`}>
          {founderAvailable && (
            <PlanCard
              testId="plan-founder"
              eyebrow={
                <span
                  className="
                    inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full
                    bg-amber-100 text-amber-900
                    dark:bg-amber-900/30 dark:text-amber-300
                    font-mono text-[10.5px] uppercase tracking-[0.16em] font-semibold
                  "
                >
                  <Zap size={11} strokeWidth={2.25} />
                  Limited · {cohort.seats_left} of {cohort.cap} seats left
                </span>
              }
              name="Founding Member"
              headlinePrice="€1"
              headlineSuffix="for 3 months"
              renewalLine="Then €99/year, renewing annually"
              cta="Start for €1"
              ctaPrimary
              loading={submitting === "founder"}
              onClick={() => handlePick("founder")}
              features={[
                "Full product access (same as Standard)",
                "Card charged €1 immediately on signup",
                "Email reminders 14 days and 3 days before renewal",
                "Cancel anytime — never charged €99 if you cancel in the first 3 months",
              ]}
            />
          )}

          <PlanCard
            testId="plan-standard"
            eyebrow={null}
            name="Standard"
            headlinePrice="€99"
            headlineSuffix="/ year"
            renewalLine="14-day free trial · card required after trial"
            cta="Start free trial"
            ctaPrimary={!founderAvailable}
            loading={submitting === "standard"}
            onClick={() => handlePick("standard")}
            features={[
              "Full product access",
              "No charge during 14-day trial",
              "Cancel anytime during the trial — no charge",
              "Renews annually at €99",
            ]}
          />
        </div>

        {/* Shared feature list */}
        <div data-testid="pricing-shared-features" className="mt-12 rounded-2xl border border-rule bg-surface p-6 sm:p-8">
          <h3 className="font-serif text-[18px] text-ink">What's included in both</h3>
          <ul className="mt-4 grid sm:grid-cols-2 gap-x-6 gap-y-2">
            {FEATURES_SHARED.map((f) => (
              <li key={f} className="flex items-start gap-2 text-[13.5px] text-ink-soft">
                <Check size={14} strokeWidth={2.25} className="shrink-0 mt-[3px] text-brand-d" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>

        <div data-testid="pricing-faq" className="mt-12 max-w-[760px] mx-auto">
          <h3 className="font-serif text-[20px] text-ink">Frequently asked</h3>
          <dl className="mt-5 space-y-5">
            <FaqEntry q="When am I charged?">
              On Founding Member, your card is charged €1 the moment you add it.
              Three months later, the same card is charged €99 for the next 12 months of access.
              On Standard, your card is charged €99 at the end of your 14-day free trial.
            </FaqEntry>
            <FaqEntry q="What happens after the 3 months on Founding Member?">
              We'll send a reminder email 14 days before renewal and a final reminder 3 days before.
              If you keep the subscription, your card is charged €99 for 12 months. You can manage everything
              from Settings → Billing.
            </FaqEntry>
            <FaqEntry q="Can I cancel?">
              Yes, anytime, in two clicks from Settings → Billing. If you cancel during the first 3 months on
              Founding Member, you keep access until month 3 and are <strong>never charged the €99</strong>.
              On Standard, cancel anytime during the 14-day trial and you're never charged.
            </FaqEntry>
            <FaqEntry q="What's the difference between the two plans?">
              None — the product, features, and support are identical. The only difference is how you start:
              Founding Member is a €1 paid trial (real charge, real card, real customer), Standard is a 14-day free trial.
              The Founding Member price is the introductory rate for the first 500 customers and disappears
              once those seats are taken.
            </FaqEntry>
            <FaqEntry q="Why €1 instead of free?">
              A €1 charge converts you from "trying" to "customer" in a way a free trial doesn't.
              It also forces card capture upfront so the renewal isn't a surprise.
              Compared to free trials, paid trials renew at 5–8× the rate, which lets us keep the standard price
              at €99 instead of pricing for the 90% who never convert.
            </FaqEntry>
          </dl>
        </div>

        <p className="mt-10 text-center text-[12.5px] text-ink-mute">
          Prices in EUR. VAT added at checkout if applicable. Card processing by Stripe.
        </p>
      </div>
    </section>
  );
}

interface PlanCardProps {
  testId: string;
  eyebrow: React.ReactNode | null;
  name: string;
  headlinePrice: string;
  headlineSuffix: string;
  renewalLine: string;
  cta: string;
  ctaPrimary?: boolean;
  loading?: boolean;
  onClick: () => void;
  features: string[];
}

function PlanCard({
  testId, eyebrow, name, headlinePrice, headlineSuffix, renewalLine,
  cta, ctaPrimary, loading, onClick, features,
}: PlanCardProps) {
  return (
    <article
      data-testid={testId}
      className={`rounded-2xl border ${
        ctaPrimary ? "border-brand bg-brand-tint/40" : "border-rule bg-surface"
      } p-7 flex flex-col`}
    >
      {eyebrow && <div className="mb-4">{eyebrow}</div>}
      <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-soft font-medium">{name}</h3>
      <div className="mt-4 flex items-baseline gap-2">
        <span
          data-testid={`${testId}-headline-price`}
          className={`num-hero text-[64px] sm:text-[72px] leading-none ${
            ctaPrimary ? "text-gradient-cfo" : "text-ink"
          }`}
        >
          {headlinePrice}
        </span>
        <span className="text-[14.5px] text-ink-soft">{headlineSuffix}</span>
      </div>
      <div data-testid={`${testId}-renewal-line`} className="mt-2 text-[13.5px] text-ink-soft font-medium">
        {renewalLine}
      </div>

      <ul className="mt-6 space-y-2.5 flex-1">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-[13.5px] text-ink">
            <Check size={14} strokeWidth={2.25} className="shrink-0 mt-[3px] text-brand-d" />
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <button
        type="button"
        data-testid={`${testId}-cta`}
        onClick={onClick}
        disabled={loading}
        className={`mt-7 h-11 px-5 rounded-xl text-[14px] font-medium transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed hover:-translate-y-[1px] active:translate-y-0 ${
          ctaPrimary
            ? "bg-gradient-cfo text-white shadow-2 hover:shadow-3"
            : "bg-ink text-paper hover:bg-ink/90"
        }`}
      >
        {loading ? "Opening checkout…" : cta}
      </button>
    </article>
  );
}

function FaqEntry({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div data-testid="faq-entry" className="border-b border-rule pb-4">
      <dt className="font-medium text-[14.5px] text-ink">{q}</dt>
      <dd className="mt-1.5 text-[13.5px] text-ink-soft leading-relaxed">{children}</dd>
    </div>
  );
}

// Quick re-export to keep existing imports happy (PricingSection is sometimes
// imported by the legacy /pricing route shell that wrapped the section in a layout).
export { Sparkle };
