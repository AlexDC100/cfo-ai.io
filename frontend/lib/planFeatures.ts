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
import { fillProof } from "@/lib/engineProof";
import { COMING_SOON_PLAN_IDS, isComingSoonPlanId } from "@/lib/plans";

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
//   · benchmarks             → `benchmarks` — no longer a plan line (2026-10-02):
//     the sector comparison is not gated by plan, so no card sells it.
//   · chat allowances        → `chat_page` (active since 2026-09; the
//     history below is why the key is named at all). It was HIDDEN: the
//     slide-over Ask CFO AI panel was deleted 2026-07-24, so every ask
//     affordance in the app navigates to /chat, which <FeatureRoute
//     featureKey="chat_page"> renders as PendingState. `ask_cfo_ai` is
//     still `active` in the registry but has no reachable surface —
//     backlogged, not silently used here to make the copy pass.
//   · valuation / export / workspace counts → `null`: the Valuation and
//     Export tabs (`lib/financialStatementTabs.ts`) and the /workspace
//     route carry no registry gate at all, so there is no key to name.
// ─────────────────────────────────────────────────────────────────────

// ── 2026-10-02: A CARD LISTS WHAT THE PLAN CHANGES, AND NOTHING ELSE ──
// `_pricing_config.py` is the whole of what differs between plans: the
// documents included, the price of an extra one, the chat caps and the
// number of workspaces. Nothing in the backend gates the ANALYSIS by
// plan — a trial document gets the same statements, ratios, valuation
// range, sector comparison and credit score as a Pro document. The cards
// used to sell "Benchmark intelligence", a "Valuation module" and "AI
// reading of scanned PDFs" as things Pro adds, "Basic ratios" on the
// trial and "Full ratio and risk analysis" on Solo: differences that do
// not exist. Each paid card now says what the analysis is (once, on
// Solo), and the others say "the same analysis" and list their limits.
//
// The two model-written features carry coverage.json's availability,
// through the `{coverage.chat.suffix}` / `{coverage.briefing.suffix}`
// tokens (lib/engineProof.aiFeatureNote): empty when the feature is
// available, the unavailable wording or a dated "not verified since"
// otherwise. They are never sold bare.
const ANALYSIS_EN = "P&L, balance sheet, cash-flow estimate, ratios, valuation range and credit score";
const ANALYSIS_RO = "Cont de profit și pierdere, bilanț, estimare a fluxului de numerar, indicatori, interval de evaluare și scor de credit";
const SAME_ANALYSIS_EN = "The same analysis as a paid plan";
const SAME_ANALYSIS_RO = "Aceeași analiză ca într-un plan plătit";
const BRIEFING_EN = "Briefing written by an AI model{coverage.briefing.suffix}";
const BRIEFING_RO = "Briefing scris de un model AI{coverage.briefing.suffix}";

const chatLine = (daily: number, monthly: number): Pick<PlanFeatureBullet, "en" | "ro"> => ({
  en: `Ask CFO AI: ${daily}/day, ${monthly}/month{coverage.chat.suffix}`,
  ro: `Întreabă CFO AI: ${daily}/zi, ${monthly}/lună{coverage.chat.suffix}`,
});

const PLAN_FEATURES: PlanFeatureTable = {
  // Retired from purchase (2026-08) — kept ONLY for legacy holders'
  // current-plan card. Never rendered on the pricing grid.
  starter: [
    {
      featureKey: "upload_trial_balance",
      en: "5 financial documents / month",
      ro: "5 documente financiare / lună",
    },
    // 2026-10-01: this line listed "bilanț, balanță de verificare, annual
    // report". Only the trial balance is read by the deterministic engine;
    // the other two need the AI reader (coverage.json row `ai_read`).
    {
      featureKey: "upload_trial_balance",
      en: "Romanian trial balance (balanță de verificare), Excel or PDF",
      ro: "Balanță de verificare românească, Excel sau PDF",
    },
    { featureKey: "dashboard", en: ANALYSIS_EN, ro: ANALYSIS_RO },
    { featureKey: "dashboard", en: BRIEFING_EN, ro: BRIEFING_RO },
    {
      featureKey: null,
      en: "HTML and Excel report export",
      ro: "Export raport HTML și Excel",
    },
    { featureKey: "chat_page", ...chatLine(10, 50) },
  ],

  // ── 2026-08 tier restructure. Numbers mirror THE TIER SPEC; when a
  //    bullet states a number it must match /api/pricing/config. ──────
  solo: [
    {
      featureKey: "upload_trial_balance",
      en: "3 Romanian documents / month",
      ro: "3 documente românești / lună",
    },
    // 2026-10-01: this line listed "bilanț, balanță de verificare, annual
    // report". Only the trial balance is read by the deterministic engine;
    // the other two need the AI reader (coverage.json row `ai_read`).
    {
      featureKey: "upload_trial_balance",
      en: "Romanian trial balance (balanță de verificare), Excel or PDF",
      ro: "Balanță de verificare românească, Excel sau PDF",
    },
    { featureKey: "dashboard", en: ANALYSIS_EN, ro: ANALYSIS_RO },
    { featureKey: "dashboard", en: BRIEFING_EN, ro: BRIEFING_RO },
    {
      featureKey: null,
      en: "HTML and Excel report export",
      ro: "Export raport HTML și Excel",
    },
    { featureKey: "chat_page", ...chatLine(10, 50) },
    { featureKey: null, en: "1 workspace", ro: "1 spațiu de lucru" },
  ],

  // Pro changes the LIMITS, not the analysis (see the note above).
  pro: [
    {
      featureKey: "dashboard",
      en: "The same analysis as RO Solo, with higher limits",
      ro: "Aceeași analiză ca în RO Solo, cu limite mai mari",
    },
    {
      featureKey: "upload_trial_balance",
      en: "15 Romanian documents / month",
      ro: "15 documente românești / lună",
    },
    { featureKey: "chat_page", ...chatLine(25, 150) },
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
    // 2026-10-01 — COMING SOON. This plan sold "8 non-RO documents / month"
    // and "Any accounting jurisdiction". No file from another country is
    // analysed correctly today (coverage.json row `other_countries`), so
    // the plan is not on sale and the line says what is true.
    {
      featureKey: null,
      en: "Documents from other countries — not supported yet",
      ro: "Documente din alte țări — încă nesuportate",
    },
    { featureKey: "chat_page", ...chatLine(40, 200) },
    {
      featureKey: null,
      en: "Up to 5 workspaces",
      ro: "Până la 5 spații de lucru",
    },
  ],

  // Trial and intro have no card on /pricing — trial is a tail-link and
  // intro is a strip below the grid — so these two exist only for the
  // current-plan card, which has to be able to describe every tier a user
  // can actually be on. The trial's first line is the trial line of
  // /pricing ("One document, analysed in full"): the two used to disagree
  // ("Basic ratios and risk flags").
  trial: [
    {
      featureKey: "upload_trial_balance",
      en: "1 document, analysed in full, within 7 days",
      ro: "1 document, analizat complet, în 7 zile",
    },
    { featureKey: "dashboard", en: SAME_ANALYSIS_EN, ro: SAME_ANALYSIS_RO },
    { featureKey: "chat_page", ...chatLine(3, 5) },
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
      en: "1 extra document",
      ro: "1 document suplimentar",
    },
    { featureKey: "dashboard", en: SAME_ANALYSIS_EN, ro: SAME_ANALYSIS_RO },
    { featureKey: "chat_page", ...chatLine(5, 10) },
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

/** The copy of one bullet in the given UI language (falls back to en).
 *  `{coverage.…}` tokens are filled from frontend/data/coverage.json. */
export function bulletText(b: PlanFeatureBullet, lang: string): string {
  const ro = lang?.startsWith("ro");
  return fillProof(ro ? b.ro : b.en, ro ? "ro" : "en");
}

/** Plans that are shown but NOT on sale. Multi-Country is coming soon:
 *  international coverage is not available yet, so its card stays visible,
 *  is marked, and nothing on it starts a checkout. Existing subscribers
 *  are untouched — their card still reads "Current plan". */
export const COMING_SOON_PLANS: readonly PlanKey[] = COMING_SOON_PLAN_IDS;

export function isComingSoonPlan(key: PlanKey): boolean {
  return isComingSoonPlanId(key);
}

/** Feature bullets for a plan in the given UI language (falls back to en). */
export function planFeaturesFor(key: PlanKey, lang: string): string[] {
  return planFeatureBulletsFor(key).map((b) => bulletText(b, lang));
}
