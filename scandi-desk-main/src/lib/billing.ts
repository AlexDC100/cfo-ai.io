// Subscription state — Supabase-backed when signed in, localStorage when in
// demo mode or pre-signup. Never blocks the UI: every helper has a fallback.
//
// The backing table is `subscriptions` (one row per user, see schema.sql).
// The 14-day trial is seeded automatically by the on_auth_user_created
// trigger so signed-in users always have a row by the time they reach this
// module — but we still tolerate the row being absent (race window or hand-
// rolled accounts) and create one on demand from useSubscription().
//
// Pre-Stripe: status flips to 'active' the moment a user picks a plan; the
// real Stripe checkout will be inserted at the TODO sites below without
// changing the surface this file exposes.

import { useEffect, useSyncExternalStore } from "react";
import {
  ALL_PLAN_IDS,
  PLANS,
  type BillingCycle,
  type Plan,
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
    if (!ALL_PLAN_IDS.includes(parsed.planId)) return null;
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
    // The trigger usually seeds a trial row, but if it's missing (hand-
    // crafted account, race), create one now so the UI always has state.
    const seeded = await ensureTrialSubscription(userId);
    return seeded;
  }
  return rowToSubscription(data as SubscriptionRow);
}

async function ensureTrialSubscription(userId: string): Promise<Subscription | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const now = new Date().toISOString();
  const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from("subscriptions")
    .insert({
      user_id: userId,
      plan: "professional" as PlanId,
      billing_cycle: "monthly" as BillingCycle,
      status: "trial",
      trial_start: now,
      trial_end: trialEnd,
      current_period_start: now,
      current_period_end: trialEnd,
    })
    .select()
    .single();
  if (error) {
    console.warn("[billing] ensureTrialSubscription failed:", error.message);
    return null;
  }
  return rowToSubscription(data as SubscriptionRow);
}

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

  async function setPlan(planId: PlanId, cycle: BillingCycle = "monthly"): Promise<Subscription | null> {
    const sb = getSupabase();
    const { data: sess } = sb ? await sb.auth.getSession() : { data: { session: null } };
    const userId = sess.session?.user?.id;

    // TODO: when Stripe is wired, replace this branch with:
    //   const session = await createCheckoutSession({ planId, cycle, userId });
    //   window.location.href = session.url;
    // The DB row should not flip to 'active' until the checkout.session.completed
    // webhook lands — until then it stays 'incomplete'.

    if (!sb || !userId) {
      // No session — persist to local storage so /signup can read the
      // chosen plan after the user signs up.
      const next: Subscription = {
        planId, billingCycle: cycle, status: "trial",
        trialStart: new Date().toISOString(),
        trialEnd: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        cancelAtPeriodEnd: false,
        isLocal: true,
      };
      writeLocal(next);
      return next;
    }

    // Authenticated path — upsert the DB row. Status flips to 'active'
    // immediately because we have no payment processor yet; once Stripe
    // is in, the webhook handler is what flips this.
    const now = new Date().toISOString();
    const periodEnd = new Date(
      Date.now() + (cycle === "yearly" ? 365 : 30) * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data, error } = await sb
      .from("subscriptions")
      .upsert(
        {
          user_id: userId,
          plan: planId,
          billing_cycle: cycle,
          status: "active",
          current_period_start: now,
          current_period_end: periodEnd,
          cancel_at_period_end: false,
        },
        { onConflict: "user_id" },
      )
      .select()
      .single();
    if (error) {
      console.warn("[billing] setPlan failed:", error.message);
      return null;
    }
    const next = rowToSubscription(data as SubscriptionRow);
    setRemote(next);
    // Wipe the local pending pick once the DB row is the source of truth.
    writeLocal(null);
    return next;
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

export function planFor(sub: Subscription | null): Plan | null {
  if (!sub) return null;
  return PLANS[sub.planId] ?? null;
}

// ─── Pre-signup convenience (unchanged surface) ─────────────────────────────

/** Persist a plan choice locally — used by PricingSection when nobody is
 *  signed in yet. After signup, AuthCard calls setPlan() which migrates
 *  this into the DB. */
export function setSelectedPlanLocal(planId: PlanId, billingCycle: BillingCycle = "monthly") {
  const sub: Subscription = {
    planId,
    billingCycle,
    status: "trial",
    trialStart: new Date().toISOString(),
    trialEnd: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
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
export const setSelectedPlan = setSelectedPlanLocal;
export function getSelectedPlan(): Plan | null {
  return planFor(readLocal());
}
export function markSubscriptionActivated(): void {
  // No-op for local subs — the real state machine lives in setPlan() now.
  // Kept so legacy AuthCard code doesn't break.
}
export function clearSubscription() { clearLocalSubscription(); }
