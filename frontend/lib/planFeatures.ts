// Plan feature bullets — the "what you get" list per tier.
//
// Lives in its own module because two components render it: the /pricing
// grid (`components/cfo/PricingTableV2`) and Settings → Plan's single
// current-plan card (`components/cfo/CurrentPlanCard`). Keeping the lists
// inside PricingTableV2 and exporting them from there worked, but a file
// that exports both a component and constants loses React fast refresh
// (react-refresh/only-export-components), so the shared data moved here.
//
// NOT server-driven, deliberately: /api/pricing/config carries the numbers
// that must match Stripe (price, included docs, chat caps) — these are the
// marketing bullets around them. If a bullet ever needs to state a number,
// read it from the config rather than hardcoding it here, so the two can't
// disagree.

import type { PlanKey } from "@/lib/pricingConfig";

export const STARTER_FEATURES = [
  "5 financial documents / month",
  "Romanian bilanț, balanță, invoices, public filings",
  "CFO AI financial summary",
  "Basic ratios and risk flags",
  "PDF / HTML report export",
  "Ask CFO AI: 10/day, 50/month",
];

export const PRO_FEATURES = [
  "15 financial documents / month",
  "Full CFO reports",
  "Trial balance analysis",
  "Benchmark intelligence",
  "Valuation module",
  "Board-ready reports",
  "Ask CFO AI: 40/day, 200/month",
  "Faster processing priority",
];

// Trial and intro have no card on /pricing — trial is a tail-link and
// intro is a strip below the grid — so these two exist only for the
// current-plan card, which has to be able to describe every tier a user
// can actually be on.
export const TRIAL_FEATURES = [
  "1 financial document",
  "CFO AI financial summary",
  "Basic ratios and risk flags",
  "No card required",
];

export const INTRO_FEATURES = [
  "7-day unlock, one-time payment",
  "3 financial documents",
  "CFO AI financial summary",
  "Full ratio and risk analysis",
];

export const PLAN_FEATURES: Record<PlanKey, string[]> = {
  trial: TRIAL_FEATURES,
  intro: INTRO_FEATURES,
  starter: STARTER_FEATURES,
  pro: PRO_FEATURES,
};
