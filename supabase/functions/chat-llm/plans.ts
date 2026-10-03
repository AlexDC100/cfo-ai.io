// Ask CFO AI — the plan table and the plan resolution, chat fields only.
//
// PURE: no Deno global, no network, no clock. `index.ts` hands in the
// environment reader; the vitest laws hand in a plain object
// (frontend/lib/__tests__/chatLlmPlans.test.ts reads the engine's Python
// table and holds this one to it, number for number).
//
// THE ENGINE IS THE AUTHORITY. The plan card in the app prints what
// `src/engine/api/_plan_state.get_plan_state` resolves; this function must
// never disagree with it about a user's cap. So every step below is the
// engine's step, named:
//
//   storedTier(row)   _plan_state.get_plan_state:
//                       raw_tier = row.get("tier") or row.get("plan") or ""
//   planFor(plans,k)  _pricing_config.plan_for
//   envInt(name,def)  _pricing_config._env_int
//   the numbers       _pricing_config._load  (ChatCaps per plan)
//   LEGACY_TIER_MAP   _pricing_config._load  (legacy_tier_map)
//
// NO CAP NUMBER IS DECIDED HERE. To change one, change _pricing_config.py
// and this table in the same commit — the parity law reds on either alone.
// A PRICING_CHAT_* override is read from each runtime's OWN environment
// (the engine container's, and this function's secrets): set it in both or
// the two disagree.
//
// TIER SPEC (2026-08-27): trial 3/5 · intro 5/10 · solo 10/50 · pro 25/150 ·
// multi 40/200 (chat turns day/month). "starter" (14.99) is retired from
// purchase but stays recognized: it maps to pro, whose caps (25/150) are
// strictly ABOVE starter's old 10/50 — legacy users never get less. The
// pre-V2 legacy keys (business/professional/…) previously resolved to
// old-pro caps 40/200, so they map to multi — exactly 40/200, never a
// downgrade.

export type PlanKey = "trial" | "intro" | "solo" | "pro" | "multi";

export interface PlanConfig {
  key: PlanKey;
  display_name: string;
  chat: { daily: number | null; monthly: number | null };
}

export type PlanTable = Record<PlanKey, PlanConfig>;

/** Reads one environment variable; undefined when it is not set. */
export type EnvReader = (name: string) => string | undefined;

/** `_pricing_config._env_int`, exactly: unset or blank → the default; a
 *  value Python's `int()` accepts → that integer; anything else → the
 *  default. (`parseInt` would read "30.5" as 30 and "30abc" as 30 where the
 *  engine keeps its default — two runtimes, two caps for one user.) */
export function envIntFrom(env: EnvReader): (name: string, def: number) => number {
  return (name, def) => {
    const raw = env(name);
    if (raw === undefined || raw === null || raw.trim() === "") return def;
    const t = raw.trim();
    // Python int(): optional sign, digits, single underscores between digits.
    if (!/^[+-]?\d+(_\d+)*$/.test(t)) return def;
    const n = Number(t.replace(/_/g, ""));
    return Number.isSafeInteger(n) ? n : def;
  };
}

export function buildPlans(env: EnvReader): PlanTable {
  const envInt = envIntFrom(env);
  return {
    trial: {
      key: "trial",
      display_name: "Free Trial",
      chat: {
        daily: envInt("PRICING_CHAT_DAILY_CAP_TRIAL", 3),
        monthly: envInt("PRICING_CHAT_MONTHLY_CAP_TRIAL", 5),
      },
    },
    intro: {
      key: "intro",
      display_name: "Intro (7 days)",
      chat: {
        daily: envInt("PRICING_CHAT_DAILY_CAP_INTRO", 5),
        monthly: envInt("PRICING_CHAT_MONTHLY_CAP_INTRO", 10),
      },
    },
    solo: {
      key: "solo",
      display_name: "RO Solo",
      chat: {
        daily: envInt("PRICING_CHAT_DAILY_CAP_SOLO", 10),
        monthly: envInt("PRICING_CHAT_MONTHLY_CAP_SOLO", 50),
      },
    },
    pro: {
      key: "pro",
      display_name: "Pro",
      chat: {
        daily: envInt("PRICING_CHAT_DAILY_CAP_PRO", 25),
        monthly: envInt("PRICING_CHAT_MONTHLY_CAP_PRO", 150),
      },
    },
    multi: {
      key: "multi",
      display_name: "Multi-Country",
      chat: {
        daily: envInt("PRICING_CHAT_DAILY_CAP_MULTI", 40),
        monthly: envInt("PRICING_CHAT_MONTHLY_CAP_MULTI", 200),
      },
    },
  };
}

// Mirrors _pricing_config.py's legacy_tier_map — retired/pre-V2 subscribers
// keep working under the new tier keys without a data migration. Every
// mapping is >= the caps the key granted before (never-downgrade):
//   starter (retired, was 10/50)              -> pro   (25/150)
//   business/professional/… (were pro 40/200) -> multi (40/200)
//   pro_legacy (the 39.99-era Pro, stamped by the webhook) -> multi
// "solo" is a first-class plan (10/50), so it does not appear here.
// KEEP IN SYNC with _pricing_config.py legacy_tier_map (the parity law
// reads both).
export const LEGACY_TIER_MAP: Record<string, PlanKey> = {
  starter: "pro",
  business: "multi",
  professional: "multi",
  professional_contact: "multi",
  pro_legacy: "multi",
};

/** The two plan columns of a `subscriptions` row, as PostgREST returns them. */
export interface SubscriptionRow {
  tier?: unknown;
  plan?: unknown;
}

/** The tier string a `subscriptions` row carries — the engine's
 *  `row.get("tier") or row.get("plan") or ""`: the FIRST TRUTHY of the two,
 *  so an empty `tier` falls through to `plan` exactly as a NULL one does.
 *  (The previous `tier ?? plan` kept an empty string and resolved that row
 *  to the trial caps while the engine's plan card read `plan`.) */
export function storedTier(row: SubscriptionRow | null | undefined): string {
  if (!row) return "";
  const raw = row.tier || row.plan || "";
  return String(raw);
}

/** `_pricing_config.plan_for`, with the caller's fallback folded in: an
 *  empty or unknown key is "no active subscription" → the trial caps. */
export function planFor(plans: PlanTable, rawKey: string | null | undefined): PlanConfig {
  if (!rawKey) return plans.trial;
  const k = String(rawKey).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(plans, k)) return plans[k as PlanKey];
  if (Object.prototype.hasOwnProperty.call(LEGACY_TIER_MAP, k)) return plans[LEGACY_TIER_MAP[k]];
  return plans.trial;
}

/** A subscriptions row (or its absence) → the plan whose chat caps apply. */
export function planForRow(plans: PlanTable, row: SubscriptionRow | null | undefined): PlanConfig {
  return planFor(plans, storedTier(row));
}
