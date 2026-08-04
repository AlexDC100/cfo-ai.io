// Plan feature bullets — the "what you get" list per tier, in BOTH product
// languages (i18n pass 2026-08-02; same typed-parity pattern as
// pages/cfo/landingStrings.ts — adding a bullet in one language without the
// other is a compile error).
//
// Lives in its own module because two components render it: the /pricing
// grid (`components/cfo/PricingTableV2`) and Settings → Plan's single
// current-plan card (`components/cfo/CurrentPlanCard`).
//
// NOT server-driven, deliberately: /api/pricing/config carries the numbers
// that must match Stripe (price, included docs, chat caps) — these are the
// marketing bullets around them. If a bullet ever needs to state a number,
// read it from the config rather than hardcoding it here, so the two can't
// disagree.

import type { PlanKey } from "@/lib/pricingConfig";

interface PlanFeatureSet {
  trial: string[];
  intro: string[];
  starter: string[];
  pro: string[];
}

const en: PlanFeatureSet = {
  starter: [
    "5 financial documents / month",
    "Romanian bilanț, balanță, invoices, public filings",
    "CFO AI financial summary",
    "Basic ratios and risk flags",
    "PDF / HTML report export",
    "Ask CFO AI: 10/day, 50/month",
  ],
  pro: [
    "15 financial documents / month",
    "Full CFO reports",
    "Trial balance analysis",
    "Benchmark intelligence",
    "Valuation module",
    "Board-ready reports",
    "Ask CFO AI: 40/day, 200/month",
    "Faster processing priority",
  ],
  // Trial and intro have no card on /pricing — trial is a tail-link and
  // intro is a strip below the grid — so these two exist only for the
  // current-plan card, which has to be able to describe every tier a user
  // can actually be on.
  trial: [
    "1 financial document",
    "CFO AI financial summary",
    "Basic ratios and risk flags",
    "No card required",
  ],
  intro: [
    "7-day unlock, one-time payment",
    "3 financial documents",
    "CFO AI financial summary",
    "Full ratio and risk analysis",
  ],
};

const ro: PlanFeatureSet = {
  starter: [
    "5 documente financiare / lună",
    "Bilanț, balanță de verificare, facturi, raportări publice",
    "Sinteză financiară CFO AI",
    "Indicatori de bază și semnale de risc",
    "Export rapoarte PDF / HTML",
    "Întreabă CFO AI: 10/zi, 50/lună",
  ],
  pro: [
    "15 documente financiare / lună",
    "Rapoarte CFO complete",
    "Analiza balanței de verificare",
    "Comparații cu industria (benchmark)",
    "Modul de evaluare",
    "Rapoarte pentru board",
    "Întreabă CFO AI: 40/zi, 200/lună",
    "Prioritate la procesare",
  ],
  trial: [
    "1 document financiar",
    "Sinteză financiară CFO AI",
    "Indicatori de bază și semnale de risc",
    "Fără card bancar",
  ],
  intro: [
    "Acces de 7 zile, plată unică",
    "3 documente financiare",
    "Sinteză financiară CFO AI",
    "Analiză completă de indicatori și riscuri",
  ],
};

/** Feature bullets for a plan in the given UI language (falls back to en). */
export function planFeaturesFor(key: PlanKey, lang: string): string[] {
  const set = lang?.startsWith("ro") ? ro : en;
  return set[key] ?? [];
}
