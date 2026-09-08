// plans.ts — WHICH PLAN IDS A SIGNUP LINK MAY RESOLVE. Nothing else.
//
// WHAT THIS FILE USED TO BE, AND WHY IT WAS WRONG
//   Until 2026-09-08 this module carried a hand-written three-tier
//   catalog — `starter` €99, `professional` €499, `enterprise` custom —
//   with features, limits, CTAs and a `formatPriceLabel()` helper. The
//   backend sells none of them. `_pricing_config.py` sells `solo` €4.99,
//   `pro` €9.99 and `multi` €16.99; `starter` (€14.99) is retired
//   (`purchasable=False`) and `professional` is only a LEGACY ALIAS that
//   resolves to `multi` (`_pricing_config.py` legacy_tier_map).
//
//   The consequence was live and reachable. `AuthCard` resolves
//   `?plan=` through `getPlan()`, so `/signup?plan=professional` — the
//   shape old marketing links and emails carry — rendered a "Selected
//   plan · Professional — €499/month" chip for a plan the checkout sells
//   at €16.99, a 29× overstatement, beside a 14-day trial stamped by
//   `billing.ts` while the configured window is seven days. Meanwhile
//   the LIVE landing links (`/signup?plan=solo|pro|multi`, Landing.tsx)
//   resolved to nothing at all, because none of those ids were in the
//   catalog — so the only ids that worked were the three fabricated
//   ones.
//
// WHAT IT IS NOW
//   The id set, and nothing that can go stale. There is no price, no
//   feature list and no display name in this file: the signup surface
//   reads all three from `lib/pricingConfig.ts`, the same live
//   `GET /api/pricing/config` the pricing page reads. A price the
//   frontend cannot invent is a price that cannot drift.
//
//   `PlanId` is an alias of `PlanKey`, so the enum lives in exactly one
//   place (pricingConfig.ts, mirroring _pricing_config.py) rather than
//   being copied here to fall behind again.
//
// GATED BY
//   `lib/__tests__/shippedClaimsMatchCode.test.ts` — "a signup surface
//   resolves only plan ids the backend sells" parses the plan keys and
//   `purchasable` flags straight out of `_pricing_config.py` and reds if
//   SELLABLE_PLAN_IDS drifts from them in either direction, and if any
//   shipped copy names a plan the backend does not sell.

import type { PlanKey } from "@/lib/pricingConfig";

/** Every plan key the backend's pricing config knows — including the
 *  non-purchasable ones a legacy subscription row may still carry. */
export type PlanId = PlanKey;

export type BillingCycle = "monthly" | "yearly";

/** Every key `_pricing_config.py` defines. Used to validate a persisted
 *  row, not to decide what may be sold. */
export const ALL_PLAN_IDS: PlanId[] = [
  "trial",
  "intro",
  "starter",
  "solo",
  "pro",
  "multi",
];

/** The recurring plans the backend will actually sell today —
 *  `purchasable=True` and `recurring=True` in `_pricing_config.py`.
 *
 *  `starter` is deliberately absent: it is retired from purchase and
 *  survives only so existing subscribers resolve. `trial` and `intro`
 *  are absent because they are not something a `?plan=` link selects.
 *  `professional`, `professional_contact`, `business` and `enterprise`
 *  are absent because they are legacy aliases or were never real —
 *  resolving them is what quoted €499 for a €16.99 plan. */
export const SELLABLE_PLAN_IDS: PlanId[] = ["solo", "pro", "multi"];

/** True when a `?plan=` value names a plan a new customer can buy.
 *
 *  A retired or aliased id returns false rather than mapping through to
 *  its successor: a stale link must land the user on the pricing page,
 *  where the live config states the real name and price, instead of on
 *  a signup card confidently quoting a plan nobody chose. */
export function isSellablePlanId(id: string | null | undefined): id is PlanId {
  if (!id) return false;
  return (SELLABLE_PLAN_IDS as string[]).includes(id);
}

/** Narrow an arbitrary persisted value to a known plan key. */
export function isKnownPlanId(id: string | null | undefined): id is PlanId {
  if (!id) return false;
  return (ALL_PLAN_IDS as string[]).includes(id);
}
