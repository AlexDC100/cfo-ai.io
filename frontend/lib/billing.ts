// Subscription state — Supabase-backed when signed in, localStorage when in
// demo mode or pre-signup. Never blocks the UI: every helper has a fallback.
//
// The backing table is `subscriptions` (one row per user, see schema.sql).
// THE BROWSER READS IT AND NEVER WRITES IT. `src/engine/api/_billing.py`
// owns every write — the Stripe webhook and the checkout routes — and it
// is the only thing that may decide a user is entitled.
//
// ── 2026-09-08 — THREE FABRICATIONS REMOVED ──────────────────────────
// This module used to mint subscription state from the browser:
//
//   · `ensureTrialSubscription()` INSERTED a row with
//     `plan: "professional"` and a 14-day trial whenever the read came
//     back empty. `professional` is a legacy alias that
//     `_pricing_config.py` maps to `multi`, the €16.99 top plan, and the
//     configured trial window is SEVEN days — so a signup that raced the
//     `on_auth_user_created` trigger handed itself the most expensive
//     plan on a trial length nothing in the product sells.
//   · `setPlan()` upserted `status: "active"` with a 30- or 365-day
//     period after signup, with no payment anywhere in the path. It was
//     dormant only by accident: `getPlan()` resolved three ids no live
//     link uses, so the pre-pick was almost always empty. Repairing the
//     ids (lib/plans.ts) would have woken it.
//   · `setSelectedPlanLocal()` stamped a third trial length —
//     `trialEnd = now + 14 days` — onto a value that is a SELECTION, not
//     a subscription.
//
// What remains is read-only: a persisted pre-signup plan CHOICE, used to
// show "Selected plan · X" on the signup card, cleared once the account
// exists. It grants nothing and promises no window.

import { useEffect, useSyncExternalStore } from "react";
import {
  isKnownPlanId,
  type BillingCycle,
  type PlanId,
} from "@/lib/plans";
import { getSupabase, supabaseEnabled } from "@/lib/supabase";

const KEY = "cfoai_subscription";

export type SubscriptionStatus = "trial" | "founding_trial" | "active" | "past_due" | "canceled" | "incomplete" | "expired" | "demo";

/** What the rest of the app reads. Mirrors the DB row plus a couple of
 *  computed fields the UI needs (days left, trial flag). */
export interface Subscription {
  id?: string;
  planId: PlanId;
  billingCycle: BillingCycle;
  status: SubscriptionStatus;
  trialStart?: string | null;
  trialEnd?: string | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  /** Set to true when the row was synthesised from localStorage (demo). */
  isLocal?: boolean;
}

// ─── Local-storage shim (demo mode + pre-signup) ────────────────────────────

const listeners = new Set<() => void>();
function emit() { listeners.forEach(l => l()); }

let cachedRaw: string | null = null;
let cachedSub: Subscription | null = null;

function readLocal(): Subscription | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) { cachedRaw = null; cachedSub = null; return null; }
    if (raw === cachedRaw && cachedSub) return cachedSub;
    cachedRaw = raw;
    const parsed = JSON.parse(raw) as Subscription;
    if (!isKnownPlanId(parsed.planId)) return null;
    cachedSub = parsed;
    return parsed;
  } catch { return null; }
}

function writeLocal(sub: Subscription | null) {
  try {
    if (sub === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(sub));
    cachedSub = sub;
    cachedRaw = sub === null ? null : localStorage.getItem(KEY);
  } catch { /* quota — best effort */ }
  emit();
}

function subscribeStore(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) emit(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
}

// ─── Supabase round-trip ────────────────────────────────────────────────────

interface SubscriptionRow {
  id: string;
  user_id: string;
  plan: PlanId;
  billing_cycle: BillingCycle;
  status: Exclude<SubscriptionStatus, "demo">;
  trial_start: string | null;
  trial_end: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  cancel_at_period_end: boolean;
  created_at: string;
  updated_at: string;
}

function rowToSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    planId: row.plan,
    billingCycle: row.billing_cycle,
    status: row.status,
    trialStart: row.trial_start,
    trialEnd: row.trial_end,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    isLocal: false,
  };
}

/** Fetch the signed-in user's subscription. Returns null when not signed in
 *  or when Supabase is disabled. */
export async function fetchSubscription(): Promise<Subscription | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data: sess } = await sb.auth.getSession();
  const userId = sess.session?.user?.id;
  if (!userId) return null;

  const { data, error } = await sb
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.warn("[billing] fetchSubscription failed:", error.message);
    return null;
  }
  if (!data) {
    // NO ROW MEANS NO SUBSCRIPTION. This used to call
    // `ensureTrialSubscription(userId)`, which INSERTED
    // `plan: "professional"` on a 14-day trial — a plan key that aliases
    // to the €16.99 top tier and a window the pricing config does not
    // sell. Absence is reported as absence; the backend
    // (`_billing.py`, the Stripe webhook, the on_auth_user_created
    // trigger) is the only thing that may create entitlement.
    return null;
  }
  return rowToSubscription(data as SubscriptionRow);
}

// `ensureTrialSubscription()` used to sit here. Deleted 2026-09-08: see
// the header. It inserted `plan: "professional"` on a 14-day trial, both
// of which the backend's pricing config contradicts.

// ─── Public API ─────────────────────────────────────────────────────────────

/** Snapshot of the local-storage subscription. Sync — for the chip on the
 *  sign-up card and other places that need a value without await. */
export function useLocalSubscription(): Subscription | null {
  return useSyncExternalStore(subscribeStore, readLocal, () => null);
}

/** The canonical hook. Pulls from Supabase when signed in, falls back to
 *  the local-storage row otherwise (used pre-signup so the pricing card's
 *  "Selected plan" chip survives the trip to /signup). */
export function useSubscription(): {
  subscription: Subscription | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setPlan: (planId: PlanId, cycle?: BillingCycle) => Promise<Subscription | null>;
  cancel: () => Promise<Subscription | null>;
  reactivate: () => Promise<Subscription | null>;
} {
  const local = useLocalSubscription();
  // Naive cache: a global mutable sub kept in sync via emit() so multiple
  // hook callers all see the same Supabase row.
  return useSubscriptionInternal(local);
}

let remoteCache: Subscription | null = null;
let remoteLoaded = false;
const remoteListeners = new Set<() => void>();
function emitRemote() { remoteListeners.forEach(l => l()); }

function setRemote(s: Subscription | null) {
  remoteCache = s;
  remoteLoaded = true;
  emitRemote();
}

function subscribeRemote(cb: () => void) {
  remoteListeners.add(cb);
  return () => { remoteListeners.delete(cb); };
}

function useSubscriptionInternal(local: Subscription | null) {
  const remote = useSyncExternalStore(subscribeRemote, () => remoteCache, () => null);
  const subscription = remote ?? local;
  const loading = supabaseEnabled && !remoteLoaded;

  useEffect(() => {
    if (!supabaseEnabled) return;
    let cancelled = false;
    fetchSubscription().then(s => { if (!cancelled) setRemote(s); });
    // Re-fetch on auth state change (sign in / out) so the cache reflects
    // the new user's subscription, or clears on sign-out.
    const sb = getSupabase();
    const sub = sb?.auth.onAuthStateChange(async () => {
      const fresh = await fetchSubscription();
      setRemote(fresh);
    });
    return () => { cancelled = true; sub?.data.subscription.unsubscribe(); };
  }, []);

  async function refresh() {
    setRemote(await fetchSubscription());
  }

  /** Record a pre-signup plan CHOICE, or clear it once an account exists.
   *
   *  Stripe is live (`/api/health` → `"stripe":{"livemode":true}`) and
   *  `_billing.py` owns `subscriptions`. This function used to upsert
   *  `status: "active"` with a 30- or 365-day period straight from the
   *  browser after signup — a paid entitlement granted with no payment
   *  in the path. It only ever stayed dormant because `getPlan()`
   *  resolved three ids that no live link carries; repairing the ids
   *  would have woken it on the very next `/signup?plan=solo` click.
   *
   *  The authenticated branch now writes NOTHING. It clears the local
   *  pick and returns whatever the server already says, so the user
   *  reaches checkout with their choice remembered and no entitlement
   *  invented on the way. */
  async function setPlan(planId: PlanId, cycle: BillingCycle = "monthly"): Promise<Subscription | null> {
    const sb = getSupabase();
    const { data: sess } = sb ? await sb.auth.getSession() : { data: { session: null } };
    const userId = sess.session?.user?.id;

    if (!sb || !userId) {
      // No session — persist the CHOICE so /signup can show it. Status is
      // "incomplete": chosen, not paid for. No trial window is stamped;
      // the only trial the product has is the one _pricing_config.py
      // configures, and it starts on the server, not here.
      const next: Subscription = {
        planId,
        billingCycle: cycle,
        status: "incomplete",
        trialStart: null,
        trialEnd: null,
        cancelAtPeriodEnd: false,
        isLocal: true,
      };
      writeLocal(next);
      return next;
    }

    // Authenticated — the choice has done its job. Drop it and re-read
    // the server's own answer.
    writeLocal(null);
    const fresh = await fetchSubscription();
    setRemote(fresh);
    return fresh;
  }

  async function cancel(): Promise<Subscription | null> {
    const sb = getSupabase();
    const userId = (await sb?.auth.getSession())?.data.session?.user?.id;
    if (!sb || !userId) return null;

    // TODO: when Stripe is wired, also call stripe.subscriptions.update(id,
    //   { cancel_at_period_end: true }) so the customer portal stays in sync.

    const { data, error } = await sb
      .from("subscriptions")
      .update({ cancel_at_period_end: true })
      .eq("user_id", userId)
      .select()
      .single();
    if (error) {
      console.warn("[billing] cancel failed:", error.message);
      return null;
    }
    const next = rowToSubscription(data as SubscriptionRow);
    setRemote(next);
    return next;
  }

  async function reactivate(): Promise<Subscription | null> {
    const sb = getSupabase();
    const userId = (await sb?.auth.getSession())?.data.session?.user?.id;
    if (!sb || !userId) return null;

    // TODO: when Stripe is wired, also call stripe.subscriptions.update(id,
    //   { cancel_at_period_end: false }) so the customer portal matches.

    const { data, error } = await sb
      .from("subscriptions")
      .update({ cancel_at_period_end: false, status: "active" })
      .eq("user_id", userId)
      .select()
      .single();
    if (error) {
      console.warn("[billing] reactivate failed:", error.message);
      return null;
    }
    const next = rowToSubscription(data as SubscriptionRow);
    setRemote(next);
    return next;
  }

  return { subscription, loading, refresh, setPlan, cancel, reactivate };
}

// ─── Helpers used by Settings / pricing UI ──────────────────────────────────

/** Days remaining in the trial — 0 once expired or non-trial. */
export function trialDaysLeft(sub: Subscription | null): number {
  if (!sub) return 0;
  if (sub.status !== "trial" && sub.status !== "founding_trial") return 0;
  if (!sub.trialEnd) return 0;
  const ms = new Date(sub.trialEnd).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/** True when the user has paying access right now (active or in trial). */
export function isSubscriptionEntitled(sub: Subscription | null): boolean {
  if (!sub) return false;
  if (sub.status === "trial" || sub.status === "founding_trial") return trialDaysLeft(sub) > 0;
  return sub.status === "active";
}

// `planFor(sub)` used to live here, returning a `Plan` out of the
// fabricated PLANS catalog. Deleted with the catalog (2026-09-08): it
// had no callers, and a plan's NAME and PRICE now come from
// `lib/pricingConfig.ts` — the live `GET /api/pricing/config` — so the
// frontend has no second copy of either to drift.

// ─── Pre-signup convenience (unchanged surface) ─────────────────────────────

/** Persist a plan choice locally — used by PricingSection when nobody is
 *  signed in yet. After signup, AuthCard calls setPlan() which migrates
 *  this into the DB. */
export function setSelectedPlanLocal(planId: PlanId, billingCycle: BillingCycle = "monthly") {
  // A SELECTION, not a subscription. It used to stamp
  // `trialEnd = now + 14 days` — a third trial length beside the seven
  // days `_pricing_config.py` configures and the seven the landing FAQ
  // quotes. A window nobody grants is a window nobody should write.
  const sub: Subscription = {
    planId,
    billingCycle,
    status: "incomplete",
    trialStart: null,
    trialEnd: null,
    cancelAtPeriodEnd: false,
    isLocal: true,
  };
  writeLocal(sub);
  return sub;
}

export function clearLocalSubscription() {
  writeLocal(null);
}

// Legacy exports for components that haven't migrated to the new hook yet.
// These will be removed once every caller is on useSubscription().
// `getSelectedPlan()` went with the fabricated catalog it read from
// (lib/plans.ts's PLANS): it had zero callers, and the only thing it
// could return was a name and a price the backend does not sell.
export const setSelectedPlan = setSelectedPlanLocal;
export function markSubscriptionActivated(): void {
  // No-op for local subs — the real state machine lives in setPlan() now.
  // Kept so legacy AuthCard code doesn't break.
}
export function clearSubscription() { clearLocalSubscription(); }
