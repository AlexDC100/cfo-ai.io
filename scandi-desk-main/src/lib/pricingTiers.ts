// Phase 5 — Final tier definitions.
//
// TWO public self-serve tiers (Solo, Business) + ONE contact-sales tier
// (Professional). Every limit and feature flag is the source of truth for
// the pricing page, the FE feature gates, and the backend enforcement
// middleware. Mirrored exactly in `src/engine/api/_pricing_tiers.py`.
//
// Rules of engagement (do NOT loosen without re-running the unit-economics
// math): see PART A in the pricing spec.

export type TierKey = "solo" | "business" | "professional_contact";

export interface TierLimits {
  max_users: number;
  max_companies: number;
  uploads_per_month: number;
  llm_calls_per_month: number;
  history_retention_months: number;
  /** Per-document overage price in EUR. `null` => no overage (custom). */
  overage_price_per_doc_eur: number | null;
}

export interface TierFeatures {
  pl_bs_cf: boolean;
  essential_ratios: boolean;
  full_ratios: boolean;
  ebitda_evaluation: boolean;
  altman_basic: boolean;
  altman_piotroski_full: boolean;
  nav_cascade: boolean;
  valuation_suite: boolean;
  industry_benchmarks: boolean;
  ai_mastermind: boolean;
  recommendations_engine: boolean;
  monthly_email_reports: boolean;
  multi_entity_view: boolean;
  api_access: boolean;
  share_readonly_links: boolean;
  comments_mentions: boolean;
}

export interface TierSupport {
  email_sla_hours: number;
  live_chat: boolean;
  dedicated_onboarding: boolean;
  phone_support: boolean;
}

export interface TierPricing {
  monthly_eur?: number;
  annual_eur?: number;
  annual_savings_eur?: number;
  founding_member_first_month_eur?: 1;
  contact_sales?: true;
}

export interface TierTrial {
  days: 30;
  card_required: true;
  first_month_price: 1;
}

export interface Tier {
  key: TierKey;
  displayName: string;
  audience: string;
  cta_type: "self_serve" | "contact_sales";
  pricing: TierPricing;
  trial?: TierTrial;
  limits: TierLimits;
  features: TierFeatures;
  support: TierSupport;
}

export const TIERS: Record<TierKey, Tier> = {
  // ============== SOLO — PUBLIC ==============
  solo: {
    key: "solo",
    displayName: "Solo",
    audience:
      "Individual investors, freelance analysts, founders doing personal due diligence",
    cta_type: "self_serve",
    pricing: {
      monthly_eur: 19.99,
      annual_eur: 199,
      annual_savings_eur: 41,
      founding_member_first_month_eur: 1,
    },
    trial: { days: 30, card_required: true, first_month_price: 1 },
    limits: {
      max_users: 1,
      max_companies: 1,
      uploads_per_month: 10,
      llm_calls_per_month: 30,
      history_retention_months: 12,
      overage_price_per_doc_eur: 4,
    },
    features: {
      pl_bs_cf: true,
      essential_ratios: true,
      full_ratios: false,
      ebitda_evaluation: true,
      altman_basic: true,
      altman_piotroski_full: false,
      nav_cascade: false,
      valuation_suite: false,
      industry_benchmarks: false,
      ai_mastermind: false,
      recommendations_engine: false,
      monthly_email_reports: false,
      multi_entity_view: false,
      api_access: false,
      share_readonly_links: false,
      comments_mentions: false,
    },
    support: {
      email_sla_hours: 48,
      live_chat: false,
      dedicated_onboarding: false,
      phone_support: false,
    },
  },

  // ============== BUSINESS — PUBLIC, FEATURED ==============
  business: {
    key: "business",
    displayName: "Business",
    audience:
      "SMB owners, internal finance teams, real estate holdings, family-group portfolios",
    cta_type: "self_serve",
    pricing: {
      monthly_eur: 59,
      annual_eur: 590,
      annual_savings_eur: 118,
      founding_member_first_month_eur: 1,
    },
    trial: { days: 30, card_required: true, first_month_price: 1 },
    limits: {
      max_users: 2,
      max_companies: 5,
      uploads_per_month: 25,
      // Tightened from 200 to protect margin (see spec).
      llm_calls_per_month: 100,
      history_retention_months: 60,
      overage_price_per_doc_eur: 3,
    },
    features: {
      pl_bs_cf: true,
      essential_ratios: true,
      full_ratios: true,
      ebitda_evaluation: true,
      altman_basic: true,
      altman_piotroski_full: true,
      nav_cascade: true,
      valuation_suite: true,
      industry_benchmarks: true,
      ai_mastermind: true,
      recommendations_engine: true,
      monthly_email_reports: true,
      multi_entity_view: false,
      api_access: false,
      share_readonly_links: true,
      comments_mentions: true,
    },
    support: {
      email_sla_hours: 24,
      live_chat: true,
      dedicated_onboarding: false,
      phone_support: false,
    },
  },

  // ============== PROFESSIONAL — CONTACT SALES ONLY ==============
  // NOT self-serve. Each Pro signup is a real conversation; limits and
  // price are set per contract. These tier defaults are the *starting*
  // sales-pitch limits, not what's actually delivered.
  professional_contact: {
    key: "professional_contact",
    displayName: "Professional",
    audience:
      "Advisory firms, accountants, multi-entity holdings, M&A boutiques managing 5+ companies",
    cta_type: "contact_sales",
    pricing: { contact_sales: true },
    limits: {
      max_users: 10,
      max_companies: 25,
      uploads_per_month: 200,
      llm_calls_per_month: 1000,
      history_retention_months: 60,
      overage_price_per_doc_eur: null,
    },
    features: {
      pl_bs_cf: true,
      essential_ratios: true,
      full_ratios: true,
      ebitda_evaluation: true,
      altman_basic: true,
      altman_piotroski_full: true,
      nav_cascade: true,
      valuation_suite: true,
      industry_benchmarks: true,
      ai_mastermind: true,
      recommendations_engine: true,
      monthly_email_reports: true,
      multi_entity_view: true,
      api_access: true,
      share_readonly_links: true,
      comments_mentions: true,
    },
    support: {
      email_sla_hours: 4,
      live_chat: true,
      dedicated_onboarding: true,
      phone_support: true,
    },
  },
};

export const ALL_TIER_KEYS: TierKey[] = [
  "solo",
  "business",
  "professional_contact",
];

export const SELF_SERVE_TIER_KEYS = ["solo", "business"] as const;
export type SelfServeTierKey = (typeof SELF_SERVE_TIER_KEYS)[number];

export function getTier(key: string | null | undefined): Tier | null {
  if (!key) return null;
  if (key in TIERS) return TIERS[key as TierKey];
  // The DB column stores 'professional' (not 'professional_contact'); map it.
  if (key === "professional") return TIERS.professional_contact;
  return null;
}

/** DB tier-key used in the `subscriptions.tier` column for Professional.
 *  The display key is `professional_contact` (so the UI doesn't try to
 *  self-serve Pro); the persisted key is `professional`. */
export function dbTierKey(key: TierKey): string {
  return key === "professional_contact" ? "professional" : key;
}

export interface UsageSnapshot {
  uploadsUsed: number;
  llmCallsUsed: number;
  exportsUsed: number;
}

/** Current calendar month bucket in 'YYYY-MM' (UTC) — matches DB column. */
export function currentMonthBucket(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function pctOf(used: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(100, Math.round((used / cap) * 100));
}
