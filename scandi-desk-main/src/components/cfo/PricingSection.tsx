// Pricing section embedded on the landing page (also routable via /pricing
// + the #pricing anchor on /).
//
// Three cards: Starter / Professional (highlighted) / Enterprise. Monthly /
// Yearly toggle with "2 months free" on yearly. Clicking a plan persists
// the choice and routes:
//   · signed-in   → setPlan() writes to subscriptions table → /today
//   · signed-out  → setSelectedPlanLocal() → /signup?plan=…
//   · enterprise  → mailto: contact path (no self-serve)

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Sparkle } from "lucide-react";
import {
  ALL_PLAN_IDS,
  PLANS,
  type BillingCycle,
  type Plan,
  formatPriceLabel,
} from "@/lib/plans";
import { setSelectedPlanLocal, useSubscription } from "@/lib/billing";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";

export function PricingSection() {
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  const [submitting, setSubmitting] = useState<string | null>(null);
  const navigate = useNavigate();
  const { status } = useAuth();
  const { setPlan } = useSubscription();
  const { toast } = useToast();

  async function handlePick(plan: Plan) {
    if (plan.contactSales) {
      // Enterprise — open a contact path. Replace with a /demo route + form
      // when sales ops is set up.
      window.location.href = `mailto:hello@cfoai.example?subject=${encodeURIComponent("CFO AI — Enterprise inquiry")}`;
      return;
    }

    if (status !== "signed_in") {
      // Pre-signup: persist locally so AuthCard echoes the choice in the
      // signup form, then redirect to /signup with the plan in the URL.
      setSelectedPlanLocal(plan.id, cycle);
      navigate(`/signup?plan=${plan.id}&cycle=${cycle}`);
      return;
    }

    // Signed in: write straight to the DB (status flips to active until
    // Stripe is wired). See billing.ts → setPlan() for the TODO marker.
    setSubmitting(plan.id);
    try {
      const next = await setPlan(plan.id, cycle);
      if (next) {
        toast({ title: `${plan.name} active`, description: "You can manage your plan from Settings any time." });
        navigate("/dashboard");
      } else {
        toast({ title: "Couldn't update plan", description: "Try again, or contact support.", variant: "destructive" });
      }
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <section id="pricing" className="border-t border-rule/40">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-8 py-16 sm:py-24">
        <div className="text-center max-w-[680px] mx-auto">
          <div className="text-[11px] uppercase tracking-[0.18em] text-ink-soft">Pricing</div>
          <h2 className="mt-3 font-serif text-[32px] sm:text-[40px] leading-[1.05] tracking-[-0.02em]">
            One license. Releases more cash than it costs.
          </h2>
          <p className="mt-4 text-[15px] text-ink-soft leading-relaxed">
            14-day free trial on every paid plan. €499/month is nothing if it
            frees €50k–€500k of trapped capital. Upgrade, downgrade, or cancel
            anytime from Settings.
          </p>
        </div>

        <div className="mt-8 flex justify-center">
          <CycleToggle cycle={cycle} onChange={setCycle} />
        </div>

        <div className="mt-12 grid gap-5 lg:gap-6 sm:grid-cols-2 lg:grid-cols-3 max-w-[1100px] mx-auto">
          {ALL_PLAN_IDS.map((id) => (
            <PricingCard
              key={id}
              plan={PLANS[id]}
              cycle={cycle}
              highlighted={id === "professional"}
              busy={submitting === id}
              onPick={handlePick}
            />
          ))}
        </div>

        <p className="mt-10 text-center text-[12.5px] text-ink-soft/80">
          All paid plans include the AI CFO chat, decision buckets, and the alert engine. Enterprise adds SSO + dedicated infrastructure.
        </p>
      </div>
    </section>
  );
}

/* ───────── Cycle toggle ────────────────────────────────────────────────── */

function CycleToggle({
  cycle, onChange,
}: {
  cycle: BillingCycle;
  onChange: (c: BillingCycle) => void;
}) {
  return (
    <div className="inline-flex items-center gap-3">
      <div className="inline-flex items-center p-1 rounded-full border border-rule bg-bg-2/60">
        <ToggleButton active={cycle === "monthly"} onClick={() => onChange("monthly")}>
          Monthly
        </ToggleButton>
        <ToggleButton active={cycle === "annual"} onClick={() => onChange("annual")}>
          Annual
        </ToggleButton>
      </div>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 text-brand px-2.5 py-1 text-[11px] uppercase tracking-[0.1em]">
        <Sparkle size={10} strokeWidth={2.25} />
        2 months free
      </span>
    </div>
  );
}

function ToggleButton({
  active, children, onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        h-8 px-4 rounded-full text-[12.5px] font-medium transition-colors
        ${active
          ? "bg-ink text-bg"
          : "text-ink-soft hover:text-ink"}
      `}
    >
      {children}
    </button>
  );
}

/* ───────── Card ───────────────────────────────────────────────────────── */

function PricingCard({
  plan, cycle, highlighted, busy, onPick,
}: {
  plan: Plan;
  cycle: BillingCycle;
  highlighted: boolean;
  busy: boolean;
  onPick: (p: Plan) => void;
}) {
  const { amount, unit, footnote } = formatPriceLabel(plan, cycle);

  return (
    <div
      className={`
        relative
        rounded-3xl
        p-7 sm:p-8
        flex flex-col
        transition-colors
        ${highlighted
          ? "border border-brand/40 bg-gradient-to-b from-surface to-surface-soft shadow-[0_0_60px_-12px_rgba(46,211,198,0.30)]"
          : "border border-rule bg-bg-2/40 hover:border-rule-strong/80"}
      `}
    >
      {plan.badge && (
        <div
          className={`
            absolute -top-3 left-1/2 -translate-x-1/2
            inline-flex items-center gap-1.5
            px-3 py-1 rounded-full text-[10.5px] uppercase tracking-[0.12em] font-medium
            ${highlighted
              ? "bg-brand text-[#05070A] shadow-[0_8px_24px_-8px_rgba(46,211,198,0.6)]"
              : "bg-bg-2/90 text-ink border border-rule"}
          `}
        >
          {highlighted && <Sparkle size={10} strokeWidth={2.25} />}
          {plan.badge}
        </div>
      )}

      <div className="text-[11px] uppercase tracking-[0.14em] text-ink-soft">{plan.audience}</div>
      <h3 className="mt-1.5 font-serif text-[24px] sm:text-[26px] leading-[1.1] tracking-[-0.01em] text-ink">
        {plan.name}
      </h3>
      <p className="mt-2 text-[13px] text-ink-soft leading-snug min-h-[3em]">{plan.description}</p>

      <div className="mt-5 flex items-baseline gap-1.5">
        <div
          className={`
            font-serif text-[40px] leading-none tracking-[-0.02em]
            ${highlighted ? "text-brand" : "text-ink"}
          `}
        >
          {amount}
        </div>
        {unit && <div className="text-[13px] text-ink-soft">{unit}</div>}
      </div>
      <div className="mt-1 text-[11.5px] text-ink-soft/80">{footnote}</div>

      <ul className="mt-6 space-y-2.5 text-[13px] text-ink/90 flex-1">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2.5">
            <Check
              size={13}
              strokeWidth={2.25}
              className={`mt-1 shrink-0 ${highlighted ? "text-brand" : "text-ink-soft"}`}
            />
            <span className="leading-snug">{f}</span>
          </li>
        ))}
      </ul>

      <button
        onClick={() => onPick(plan)}
        disabled={busy}
        className={`
          mt-7 w-full inline-flex items-center justify-center
          h-11 px-5 rounded-full text-[13.5px] font-medium
          transition-all
          disabled:opacity-60 disabled:cursor-not-allowed
          ${highlighted
            ? "bg-brand text-[#05070A] hover:bg-brand/90 hover:shadow-[0_0_32px_-6px_rgba(46,211,198,0.55)]"
            : "border border-rule-strong/70 hover:border-rule-strong text-ink hover:bg-bg-2/70"}
        `}
      >
        {busy ? "Saving…" : plan.cta}
      </button>
    </div>
  );
}
