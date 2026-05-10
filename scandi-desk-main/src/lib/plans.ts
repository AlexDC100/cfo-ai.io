// CFO AI plan catalog — three tiers (Starter / Professional / Enterprise).
//
// One source of truth for pricing, limits, and feature lists. Used by:
//   · PricingSection on the landing page
//   · AuthCard / Signup to surface "Selected plan: X — €Y/month"
//   · Settings → Subscription card
//   · billing.ts for the database round-trip + Stripe placeholders
//
// Plan IDs match the Supabase `subscriptions.plan` enum ('starter',
// 'professional', 'enterprise'). NEVER hard-code plan ids elsewhere — read
// from this catalog so the price + name + limits stay in sync everywhere.

export type PlanId = "starter" | "professional" | "enterprise";
export type BillingCycle = "monthly" | "yearly";

export interface PlanLimits {
  /** Max users on the workspace. `null` = no enforced cap. */
  users: number | null;
  /** Max distinct workspaces. */
  workspaces: number | null;
  /** Soft cap on SKU rows. `null` = unbounded. */
  skuLimit: number | null;
  /** Integration tier: false (none), 'basic', 'advanced'. */
  integrations: false | "basic" | "advanced";
  /** SLA + dedicated infrastructure (Enterprise only). */
  slaSupport: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** Monthly price in EUR. `null` for "custom / contact sales". */
  monthly: number | null;
  /** Stripe price ids — populate when checkout flips on. See billing.ts. */
  stripePriceMonthly?: string;
  stripePriceYearly?: string;
  /** Display "from €X" instead of a fixed price. */
  fromPrice: boolean;
  description: string;
  audience: string;
  features: string[];
  cta: string;
  /** Pricing card badge (e.g. "Most popular"). */
  badge?: string;
  /** Enterprise tier opens a contact path instead of self-serve checkout. */
  contactSales?: boolean;
  limits: PlanLimits;
}

/** Yearly = 10× monthly = 2 months free. Industry-standard SaaS pricing. */
export function yearlyPriceFor(plan: Plan): number | null {
  if (plan.monthly === null) return null;
  return plan.monthly * 10;
}

/** Effective per-month display price for the selected billing cycle. */
export function displayMonthlyPrice(plan: Plan, cycle: BillingCycle): number | null {
  if (plan.monthly === null) return null;
  if (cycle === "monthly") return plan.monthly;
  return Math.round((plan.monthly * 10) / 12);
}

export const PLANS: Record<PlanId, Plan> = {
  starter: {
    id: "starter",
    name: "Starter",
    monthly: 99,
    fromPrice: false,
    description: "For small operators getting their first dataset under control.",
    audience: "Small team",
    features: [
      "1 workspace",
      "Up to 5 users",
      "CSV / Excel upload",
      "Basic AI insights",
      "SKU profitability analysis",
      "Cash-trapped overview",
      "Export summaries",
    ],
    cta: "Start free trial",
    limits: { users: 5, workspaces: 1, skuLimit: 1000, integrations: false, slaSupport: false },
  },
  professional: {
    id: "professional",
    name: "Professional",
    monthly: 499,
    fromPrice: false,
    description: "For growing companies with serious working capital and inventory at stake.",
    audience: "Growing operator",
    features: [
      "Unlimited users",
      "ERP integrations",
      "Advanced AI recommendations",
      "Full alerting system",
      "Multi-dataset workspaces",
      "Recommendations queue",
      "Weekly executive briefing",
      "Priority support",
    ],
    cta: "Start free trial",
    badge: "Most popular",
    limits: { users: null, workspaces: 5, skuLimit: 50000, integrations: "advanced", slaSupport: false },
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    monthly: null,
    fromPrice: true,
    description: "For mid-market and up — SSO, custom integrations, dedicated support.",
    audience: "Mid-market+",
    features: [
      "SSO / SAML",
      "Dedicated infrastructure",
      "Custom integrations",
      "SLA-backed support",
      "Unlimited workspaces",
      "Audit logs + retention",
      "Custom thresholds + reporting",
      "Onboarding white-glove",
    ],
    cta: "Contact sales",
    contactSales: true,
    limits: { users: null, workspaces: null, skuLimit: null, integrations: "advanced", slaSupport: true },
  },
};

export const ALL_PLAN_IDS: PlanId[] = ["starter", "professional", "enterprise"];

export function getPlan(id: string | null | undefined): Plan | null {
  if (!id) return null;
  if (id in PLANS) return PLANS[id as PlanId];
  return null;
}

/** Format the price label that appears on the pricing card. */
export function formatPriceLabel(plan: Plan, cycle: BillingCycle): {
  amount: string;
  unit: string;
  footnote: string;
} {
  if (plan.monthly === null) {
    return { amount: "Custom", unit: "", footnote: "Tailored agreement" };
  }
  const monthly = displayMonthlyPrice(plan, cycle)!;
  const prefix = plan.fromPrice ? "From €" : "€";
  return {
    amount: `${prefix}${monthly}`,
    unit: "/month",
    footnote:
      cycle === "yearly"
        ? `€${yearlyPriceFor(plan)} billed annually · 2 months free`
        : `Billed monthly`,
  };
}
