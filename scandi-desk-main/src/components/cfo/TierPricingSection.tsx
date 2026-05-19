// Phase 5 — Public pricing page section.
//
// Three cards: Solo + Business (self-serve, "Start for €1") + Professional
// (contact-sales). Founding-member banner shows real DB-backed seats
// remaining from `founding_member_count`. Billing toggle: monthly | annual.
//
// NEVER show "Unlimited" anywhere on this page. The actual numbers are the
// trust-building feature; per the spec we'd rather give honest small numbers
// than vague unlimiteds we can't sustain.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { getSupabase } from "@/lib/supabase";
import { TIERS, type Tier, type SelfServeTierKey } from "@/lib/pricingTiers";

type BillingCycle = "monthly" | "annual";

interface FoundingCount {
  claimed: number;
  remaining: number;
  cap: number;
}

async function fetchFoundingCount(): Promise<FoundingCount | null> {
  const apiUrl =
    (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  try {
    const r = await fetch(`${apiUrl}/api/founding-member/count`);
    if (!r.ok) return null;
    return (await r.json()) as FoundingCount;
  } catch {
    return null;
  }
}

async function startCheckout(
  tier: SelfServeTierKey,
  cycle: BillingCycle,
  claimFounding: boolean,
): Promise<string | { error: string } | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) return null;
  const apiUrl =
    (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  try {
    const res = await fetch(`${apiUrl}/api/billing/create-checkout`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tier,
        billing_cycle: cycle,
        claim_founding: claimFounding,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return {
        error:
          body?.detail?.message ||
          body?.detail ||
          body?.error ||
          "Couldn't reach checkout.",
      };
    }
    const body = await res.json();
    return body.checkout_url as string;
  } catch {
    return null;
  }
}

export function TierPricingSection() {
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  const [founding, setFounding] = useState<FoundingCount | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const c = await fetchFoundingCount();
      if (!cancelled) setFounding(c);
    };
    void poll();
    const timer = setInterval(poll, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const foundingAvailable = !!founding && founding.remaining > 0;

  return (
    <section className="mx-auto max-w-[1240px] px-5 sm:px-8 py-14">
      <header className="text-center mb-8">
        <h1 className="text-[34px] sm:text-[42px] font-semibold tracking-tight text-ink">
          Pricing
        </h1>
        <p className="mt-3 text-[14.5px] text-ink-soft max-w-[640px] mx-auto">
          One product, two tiers for self-serve. Professional is a conversation
          — every advisory firm is different.
        </p>
      </header>

      <div className="flex justify-center mb-6">
        <div
          role="tablist"
          aria-label="Billing cycle"
          className="inline-flex rounded-full border border-rule p-1 bg-surface"
        >
          <button
            role="tab"
            aria-selected={cycle === "monthly"}
            onClick={() => setCycle("monthly")}
            className={
              "text-[12.5px] px-4 py-1.5 rounded-full transition-colors " +
              (cycle === "monthly"
                ? "bg-ink text-bg"
                : "text-ink-soft hover:text-ink")
            }
          >
            Monthly
          </button>
          <button
            role="tab"
            aria-selected={cycle === "annual"}
            onClick={() => setCycle("annual")}
            className={
              "text-[12.5px] px-4 py-1.5 rounded-full transition-colors " +
              (cycle === "annual"
                ? "bg-ink text-bg"
                : "text-ink-soft hover:text-ink")
            }
          >
            Annual <span className="ml-1 text-[10px] tracking-wide uppercase opacity-70">save 17%</span>
          </button>
        </div>
      </div>

      {foundingAvailable && <FoundingBanner remaining={founding!.remaining} />}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-2">
        <TierCard
          tier={TIERS.solo}
          billingCycle={cycle}
          foundingAvailable={foundingAvailable}
        />
        <TierCard
          tier={TIERS.business}
          billingCycle={cycle}
          foundingAvailable={foundingAvailable}
          featured
        />
        <TierCardContactSales tier={TIERS.professional_contact} />
      </div>

      <FAQ />
      <RoadmapPreview />
    </section>
  );
}

function FoundingBanner({ remaining }: { remaining: number }) {
  return (
    <div className="mb-6 mx-auto max-w-[760px] rounded-xl border border-amber-500/30 bg-amber-500/5 px-5 py-3 flex items-center justify-center gap-3 flex-wrap">
      <span className="text-[13px] font-medium text-ink">
        Founding Member offer · €1 first month
      </span>
      <span className="text-[12px] text-ink-soft">
        <strong className="text-ink">{remaining}</strong> of 500 seats remaining
      </span>
    </div>
  );
}

function TierCard({
  tier,
  billingCycle,
  foundingAvailable,
  featured,
}: {
  tier: Tier;
  billingCycle: BillingCycle;
  foundingAvailable: boolean;
  featured?: boolean;
}) {
  const navigate = useNavigate();
  const { status } = useAuth();
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);

  const price =
    billingCycle === "monthly" ? tier.pricing.monthly_eur : tier.pricing.annual_eur;
  const period = billingCycle === "monthly" ? "mo" : "year";
  const savings = billingCycle === "annual" ? tier.pricing.annual_savings_eur : null;

  const tierKey = tier.key as SelfServeTierKey;
  const ctaLabel = foundingAvailable ? "Start for €1" : "Start free trial";
  const finePrint = foundingAvailable
    ? `€1 first month, then €${price}/${period}. Cancel anytime in first 30 days.`
    : `30-day free trial, then €${price}/${period}.`;

  async function handleStart() {
    if (status !== "signed_in") {
      try {
        localStorage.setItem(
          "cfo.intent.tier",
          JSON.stringify({ tier: tierKey, cycle: billingCycle, founding: foundingAvailable }),
        );
      } catch {
        /* private mode */
      }
      navigate(`/signup?tier=${tierKey}&cycle=${billingCycle}`);
      return;
    }
    setSubmitting(true);
    const result = await startCheckout(tierKey, billingCycle, foundingAvailable);
    setSubmitting(false);
    if (result === null) {
      toast({
        title: "Checkout unavailable",
        description:
          "Couldn't reach the payment backend. If you're an admin, set STRIPE_SECRET_KEY and the STRIPE_PRICE_* env vars.",
        variant: "destructive",
      });
      return;
    }
    if (typeof result === "object") {
      toast({
        title: "Setup pending",
        description: result.error,
      });
      return;
    }
    window.location.href = result;
  }

  return (
    <article
      className={
        "relative rounded-2xl border bg-surface p-6 sm:p-7 flex flex-col " +
        (featured
          ? "border-ink shadow-lg ring-1 ring-ink/10"
          : "border-rule")
      }
    >
      {featured && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-ink text-bg text-[10.5px] tracking-wide uppercase">
          Most popular
        </span>
      )}

      <h3 className="text-[20px] font-semibold text-ink">{tier.displayName}</h3>
      <p className="mt-1 text-[12.5px] text-ink-soft min-h-[44px]">{tier.audience}</p>

      <div className="mt-5 flex items-baseline gap-1">
        <span className="text-[34px] font-semibold text-ink">€{price}</span>
        <span className="text-[13px] text-ink-soft">/{period}</span>
      </div>
      {savings && (
        <p className="text-[11.5px] text-emerald-500 mt-1">
          Save €{savings} vs monthly
        </p>
      )}

      <ul className="mt-6 space-y-2 flex-1">
        <li className="text-[10.5px] uppercase tracking-wider text-ink-soft pt-1">
          Usage
        </li>
        <Feature
          on
          label={
            <>
              <strong>{tier.limits.uploads_per_month}</strong> documents per
              month
            </>
          }
        />
        <Feature
          on
          label={
            <>
              <strong>{tier.limits.max_companies}</strong> company workspace
              {tier.limits.max_companies > 1 ? "s" : ""}
            </>
          }
        />
        <Feature
          on
          label={
            <>
              <strong>{tier.limits.max_users}</strong> user
              {tier.limits.max_users > 1 ? "s" : ""}
            </>
          }
        />
        <Feature
          on
          label={
            <>
              <strong>{tier.limits.llm_calls_per_month}</strong> AI analysis
              calls per month
            </>
          }
        />

        <li className="text-[10.5px] uppercase tracking-wider text-ink-soft pt-3">
          What's included
        </li>
        <Feature on label="P&L · Balance Sheet · Cash Flow" />
        <Feature
          on
          label={tier.features.full_ratios ? "25+ financial ratios" : "12 essential ratios"}
        />
        <Feature on label="EBITDA evaluation" />
        <Feature
          on
          label={
            tier.features.altman_piotroski_full
              ? "Credit rating (Altman Z″, Piotroski, composite)"
              : "Basic Altman Z-score"
          }
        />
        {tier.features.nav_cascade && (
          <Feature on label={<strong>NAV cascade (4-layer)</strong>} />
        )}
        {tier.features.valuation_suite && (
          <Feature
            on
            label={<strong>Valuation suite (cap rate, EBITDA, NAV)</strong>}
          />
        )}
        {tier.features.industry_benchmarks && (
          <Feature on label="15-country EU benchmarks" />
        )}
        {tier.features.ai_mastermind && (
          <Feature on label={<strong>AI Mastermind chat</strong>} />
        )}
        {tier.features.recommendations_engine && (
          <Feature on label="Industry-aware recommendations" />
        )}
        {tier.features.monthly_email_reports && (
          <Feature on label="Monthly email reports" />
        )}

        {!tier.features.nav_cascade && <Feature off label="No NAV cascade" />}
        {!tier.features.ai_mastermind && <Feature off label="No AI Mastermind chat" />}
        {!tier.features.valuation_suite && <Feature off label="No valuation suite" />}
      </ul>

      <button
        onClick={handleStart}
        disabled={submitting}
        className={
          "w-full mt-6 py-2.5 rounded-lg text-[13px] font-medium transition-colors " +
          (featured
            ? "bg-ink text-bg hover:bg-ink/90"
            : "border border-rule text-ink hover:bg-surface-hover")
        }
      >
        {submitting ? "Opening checkout…" : ctaLabel}
      </button>
      <p className="text-[11px] text-ink-soft text-center mt-2 leading-snug">
        {finePrint}
      </p>
      <p className="text-[10px] text-ink-mute text-center mt-1 italic leading-snug">
        Automated extraction with ~90%+ accuracy. Always verify before external use.
      </p>
    </article>
  );
}

function TierCardContactSales({ tier }: { tier: Tier }) {
  const navigate = useNavigate();
  return (
    <article className="relative rounded-2xl border border-rule bg-surface p-6 sm:p-7 flex flex-col">
      <h3 className="text-[20px] font-semibold text-ink">{tier.displayName}</h3>
      <p className="mt-1 text-[12.5px] text-ink-soft min-h-[44px]">{tier.audience}</p>

      <div className="mt-5">
        <span className="text-[24px] font-semibold text-ink">Contact Sales</span>
      </div>
      <p className="text-[11.5px] text-ink-soft mt-1 leading-snug">
        Every advisory firm is different. We size limits, support level, and
        price to your actual workflow.
      </p>

      <ul className="mt-6 space-y-2 flex-1">
        <li className="text-[10.5px] uppercase tracking-wider text-ink-soft pt-1">
          Everything in Business, plus
        </li>
        <Feature on label={<strong>Multi-entity portfolio view</strong>} />
        <Feature on label={<strong>Consolidated holding analysis</strong>} />
        <Feature on label={<strong>API access</strong>} />
        <Feature on label={<strong>Dedicated onboarding (1 hour)</strong>} />
        <Feature
          on
          label={<strong>Priority support (4h email SLA, phone)</strong>}
        />
        <Feature on label="Custom limits sized to your actual workload" />
      </ul>

      <button
        onClick={() => navigate("/contact-sales")}
        className="w-full mt-6 py-2.5 rounded-lg text-[13px] font-medium bg-ink text-bg hover:bg-ink/90 transition-colors"
      >
        Talk to us
      </button>
      <p className="text-[11px] text-ink-soft text-center mt-2 leading-snug">
        We typically reply within 4 business hours. No pitch — just a
        conversation about whether we're a fit.
      </p>
    </article>
  );
}

function Feature({
  on,
  off,
  label,
}: {
  on?: boolean;
  off?: boolean;
  label: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 text-[13px]">
      {on && (
        <Check
          size={14}
          className="mt-1 text-emerald-500 shrink-0"
          aria-hidden
        />
      )}
      {off && (
        <X size={14} className="mt-1 text-ink-soft/50 shrink-0" aria-hidden />
      )}
      <span className={off ? "text-ink-soft/70" : "text-ink"}>{label}</span>
    </li>
  );
}

function FAQ() {
  return (
    <section className="mt-16 max-w-[760px] mx-auto">
      <h2 className="text-[22px] font-semibold text-ink mb-5">Questions</h2>
      <FaqItem q="How does the €1 first month work?">
        Pick Solo or Business, pay €1 today, full access for 30 days. On day 31
        your card is charged the regular price (€19.99 or €59) and the
        subscription continues monthly or annually. Cancel anytime in the first
        30 days from Settings → Billing and you're never charged again. Limited
        to the first 500 customers — the counter at the top of the page shows
        remaining seats.
      </FaqItem>
      <FaqItem q="Why is Professional contact-sales?">
        Advisory firms vary widely — some manage 5 clients, some manage 50.
        Some need API access, some need monthly reports, some need both. A
        fixed price doesn't fit. We'd rather have a 20-minute conversation
        about your workflow and propose limits and pricing that match. Typical
        Pro pricing lands between €179 and €499/month depending on scope.
      </FaqItem>
      <FaqItem q="What's the difference in AI analysis between tiers?">
        <p>
          <strong>Solo (30 AI calls/month):</strong> covers the CFO briefing and
          a few follow-up questions. Suitable for analyzing one company per
          month.
        </p>
        <p>
          <strong>Business (100 AI calls/month):</strong> enough for monthly
          reporting on 5 companies plus the AI Mastermind chat for deep-dive
          questions.
        </p>
        <p>
          <strong>Professional (negotiated):</strong> sized to your actual
          workflow. We set the limit during onboarding.
        </p>
      </FaqItem>
      <FaqItem q="What happens if I exceed my limit?">
        On Solo and Business, you can buy extra document uploads at €4 (Solo)
        or €3 (Business) per document. Or upgrade to the next tier. P&L,
        Balance Sheet, Cash Flow, and ratios remain available regardless — only
        AI-generated content is gated.
      </FaqItem>
      <FaqItem q="Can I switch from monthly to annual or upgrade tier?">
        Yes, anytime from Settings → Billing. Upgrades take effect immediately
        with pro-rated billing. Downgrades take effect at the next renewal so
        you don't lose access mid-month.
      </FaqItem>
      <FaqItem q="What features are coming soon?">
        See our <a href="/roadmap" className="underline">Roadmap</a> for honest
        target dates. We don't promise features that aren't in design.
        Currently in active development: NAV cascade Layer 4 (liquidation),
        monthly email reports, share read-only links.
      </FaqItem>
      <FaqItem q="Is my financial data secure?">
        Yes. All data is encrypted at rest and in transit. Each user's data is
        isolated via row-level security (no cross-account access). We do not
        share or use your data to train models. GDPR-compliant; data export and
        deletion on request.
      </FaqItem>
      <FaqItem q="Do you offer refunds?">
        If you cancel within the first 30 days of any new subscription, you pay
        only the €1 founding fee (or €0 if you didn't use founding). After 30
        days, monthly plans don't refund mid-month but you can cancel anytime
        to stop future charges. Annual plans get a pro-rated refund minus a
        30-day evaluation period if you cancel within 90 days.
      </FaqItem>
    </section>
  );
}

function FaqItem({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="group border-b border-rule py-3">
      <summary className="cursor-pointer list-none flex justify-between items-center text-[14px] font-medium text-ink">
        {q}
        <span className="text-ink-soft group-open:rotate-45 transition-transform text-[18px] leading-none">
          +
        </span>
      </summary>
      <div className="mt-2 text-[13px] text-ink-soft space-y-2 leading-relaxed">
        {children}
      </div>
    </details>
  );
}

function RoadmapPreview() {
  return (
    <div className="mt-14 mx-auto max-w-[760px] text-center px-5">
      <p className="text-[13.5px] text-ink-soft">
        Looking for something not listed here?{" "}
        <a href="/roadmap" className="text-ink underline underline-offset-2">
          Check the roadmap
        </a>{" "}
        for what we're building and honest target dates.
      </p>
    </div>
  );
}
