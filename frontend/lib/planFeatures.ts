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
//
// ── 2026-09-06: EVERY BULLET NAMES ITS FEATURE ────────────────────────
// A plan may only sell what the product serves. The registry
// (`src/engine/api/_features.py` → GET /api/features/status →
// `lib/features.ts`) is the one place that says whether a capability is
// `active`, `coming_soon` or `hidden`; before this change the bullets were
// bare strings, so three plans could go on selling "Benchmark
// intelligence" and an "Ask CFO AI" message allowance after the registry
// had switched `benchmarks` and `chat_page` to `hidden` — a paying
// customer reached "Not in this release" for a billed line item.
//
// Each bullet now carries:
//   · `featureKey` — the registry row the line names, or `null` when the
//     line states a plan QUOTA or LIMIT rather than a gated capability
//     (a document count, a workspace count). `null` is not an escape
//     hatch: see the blind-spot note on the gate below.
//   · `afterLaunch` — set ONLY when `featureKey` is not `active` today.
//     The copy in BOTH languages must then carry the marker, so the line
//     is never a bare present-tense claim.
//   · `en` / `ro` — one object per line, so a Romanian bullet cannot
//     exist without its English twin or without a key.
//
// Enforced by `frontend/lib/__tests__/pricingMatchesRegistry.test.tsx`,
// which parses the real `_features.py` (not a hand-kept list) and reds
// when a plan names a hidden, coming-soon or unknown feature, or when an
// `afterLaunch` marker outlives the flip that made the feature active.

import type { FeatureKey } from "@/lib/features";
import type { PlanKey } from "@/lib/pricingConfig";

/** Marker appended to a bullet whose feature is not `active` yet. The gate
 *  asserts the rendered string contains it, so changing the wording here
 *  and forgetting the gate is a red, not a silent drift. */
export const AFTER_LAUNCH_MARKER_EN = "available after launch";
export const AFTER_LAUNCH_MARKER_RO = "disponibil după lansare";

export interface PlanFeatureBullet {
  /** The registry row this line names. `null` = a plan quota/limit, not a
   *  registry-gated capability. */
  featureKey: FeatureKey | null;
  /** Set when `featureKey` is not `active`; both `en` and `ro` must then
   *  carry the marker above. */
  afterLaunch?: true;
  en: string;
  ro: string;
}

type PlanFeatureTable = Record<PlanKey, PlanFeatureBullet[]>;

// ─────────────────────────────────────────────────────────────────────
// Why each key was chosen (measured 2026-09-06 against the tree, not
// assumed):
//   · document counts        → `upload_trial_balance` (active): the
//     analysis a document buys is the feature; the count is the quota.
//   · statement ingest       → `upload_financial_statement` (active).
//     "invoices" and "public filings" were REMOVED from the ingest line:
//     `upload_invoice` is `coming_soon` and `public_records` is `hidden`.
//   · summary / ratios / risk→ `dashboard` (active) — these render on the
//     dashboard's statement tabs.
//   · benchmarks             → `benchmarks` (HIDDEN) → afterLaunch.
//   · chat allowances        → `chat_page` (HIDDEN) → afterLaunch. The
//     slide-over Ask CFO AI panel was deleted 2026-07-24, so every ask
//     affordance in the app navigates to /chat, which <FeatureRoute
//     featureKey="chat_page"> renders as PendingState. `ask_cfo_ai` is
//     still `active` in the registry but has no reachable surface —
//     backlogged, not silently used here to make the copy pass.
//   · valuation / export / workspace counts → `null`: the Valuation and
//     Export tabs (`lib/financialStatementTabs.ts`) and the /workspace
//     route carry no registry gate at all, so there is no key to name.
// ─────────────────────────────────────────────────────────────────────

const PLAN_FEATURES: PlanFeatureTable = {
  // Retired from purchase (2026-08) — kept ONLY for legacy holders'
  // current-plan card. Never rendered on the pricing grid.
  starter: [
    {
      featureKey: "upload_trial_balance",
      en: "5 financial documents / month",
      ro: "5 documente financiare / lună",
    },
    {
      featureKey: "upload_financial_statement",
      en: "Romanian bilanț, balanță de verificare, annual report",
      ro: "Bilanț, balanță de verificare, raportare anuală",
    },
    {
      featureKey: "dashboard",
      en: "CFO AI financial summary",
      ro: "Sinteză financiară CFO AI",
    },
    {
      featureKey: "dashboard",
      en: "Basic ratios and risk flags",
      ro: "Indicatori de bază și semnale de risc",
    },
    {
      featureKey: null,
      en: "HTML and Excel report export",
      ro: "Export raport HTML și Excel",
    },
    {
      featureKey: "chat_page",
      en: "Ask CFO AI: 10/day, 50/month",
      ro: "Întreabă CFO AI: 10/zi, 50/lună",
    },
  ],

  // ── 2026-08 tier restructure. Numbers mirror THE TIER SPEC; when a
  //    bullet states a number it must match /api/pricing/config. ──────
  solo: [
    {
      featureKey: "upload_trial_balance",
      en: "3 Romanian documents / month",
      ro: "3 documente românești / lună",
    },
    {
      featureKey: "upload_financial_statement",
      en: "Romanian bilanț, balanță de verificare, annual report",
      ro: "Bilanț, balanță de verificare, raportare anuală",
    },
    {
      featureKey: "dashboard",
      en: "CFO AI financial summary",
      ro: "Sinteză financiară CFO AI",
    },
    {
      featureKey: "dashboard",
      en: "Full ratio and risk analysis",
      ro: "Analiză completă de indicatori și riscuri",
    },
    {
      featureKey: null,
      en: "HTML and Excel report export",
      ro: "Export raport HTML și Excel",
    },
    {
      featureKey: "chat_page",
      en: "Ask CFO AI: 10/day, 50/month",
      ro: "Întreabă CFO AI: 10/zi, 50/lună",
    },
    { featureKey: null, en: "1 workspace", ro: "1 spațiu de lucru" },
  ],

  pro: [
    {
      featureKey: "upload_trial_balance",
      en: "15 Romanian documents / month",
      ro: "15 documente românești / lună",
    },
    {
      featureKey: "upload_trial_balance",
      en: "Trial balance analysis",
      ro: "Analiza balanței de verificare",
    },
    {
      featureKey: "upload_financial_statement",
      en: "Scanned-PDF extraction",
      ro: "Extragere din PDF-uri scanate",
    },
    {
      featureKey: "benchmarks",
      en: "Benchmark intelligence",
      ro: "Comparații cu industria (benchmark)",
    },
    { featureKey: null, en: "Valuation module", ro: "Modul de evaluare" },
    {
      featureKey: "chat_page",
      en: "Ask CFO AI: 25/day, 150/month",
      ro: "Întreabă CFO AI: 25/zi, 150/lună",
    },
    {
      featureKey: null,
      en: "Up to 5 workspaces",
      ro: "Până la 5 spații de lucru",
    },
  ],

  multi: [
    { featureKey: null, en: "Everything in Pro", ro: "Tot ce include Pro" },
    {
      featureKey: "upload_trial_balance",
      en: "15 Romanian documents / month",
      ro: "15 documente românești / lună",
    },
    {
      featureKey: "upload_financial_statement",
      en: "8 non-RO documents / month included",
      ro: "8 documente non-RO / lună incluse",
    },
    {
      featureKey: null,
      en: "Any accounting jurisdiction",
      ro: "Orice jurisdicție contabilă",
    },
    {
      featureKey: "upload_financial_statement",
      en: "Scanned-PDF extraction",
      ro: "Extragere din PDF-uri scanate",
    },
    {
      featureKey: "chat_page",
      en: "Ask CFO AI: 40/day, 200/month",
      ro: "Întreabă CFO AI: 40/zi, 200/lună",
    },
    {
      featureKey: null,
      en: "Up to 5 workspaces",
      ro: "Până la 5 spații de lucru",
    },
  ],

  // Trial and intro have no card on /pricing — trial is a tail-link and
  // intro is a strip below the grid — so these two exist only for the
  // current-plan card, which has to be able to describe every tier a user
  // can actually be on.
  trial: [
    {
      featureKey: "upload_trial_balance",
      en: "1 financial document",
      ro: "1 document financiar",
    },
    {
      featureKey: "dashboard",
      en: "CFO AI financial summary",
      ro: "Sinteză financiară CFO AI",
    },
    {
      featureKey: "dashboard",
      en: "Basic ratios and risk flags",
      ro: "Indicatori de bază și semnale de risc",
    },
    { featureKey: null, en: "No card required", ro: "Fără card bancar" },
  ],

  intro: [
    {
      featureKey: null,
      en: "7-day unlock, one-time payment",
      ro: "Acces de 7 zile, plată unică",
    },
    {
      featureKey: "upload_trial_balance",
      en: "3 financial documents",
      ro: "3 documente financiare",
    },
    {
      featureKey: "dashboard",
      en: "CFO AI financial summary",
      ro: "Sinteză financiară CFO AI",
    },
    {
      featureKey: "dashboard",
      en: "Full ratio and risk analysis",
      ro: "Analiză completă de indicatori și riscuri",
    },
  ],
};

/** Structured bullets for a plan — what the registry gate reads. */
export function planFeatureBulletsFor(key: PlanKey): PlanFeatureBullet[] {
  return PLAN_FEATURES[key] ?? [];
}

/** Every plan key that carries copy. */
export function planKeysWithFeatures(): PlanKey[] {
  return Object.keys(PLAN_FEATURES) as PlanKey[];
}

/** The copy of one bullet in the given UI language (falls back to en). */
export function bulletText(b: PlanFeatureBullet, lang: string): string {
  return lang?.startsWith("ro") ? b.ro : b.en;
}

/** Feature bullets for a plan in the given UI language (falls back to en). */
export function planFeaturesFor(key: PlanKey, lang: string): string[] {
  return planFeatureBulletsFor(key).map((b) => bulletText(b, lang));
}
