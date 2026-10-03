// THE CHAT FUNCTION AND THE ENGINE AGREE ABOUT A USER'S CAP.
//
// The plan card in the app prints what the engine resolves
// (src/engine/api/_plan_state.get_plan_state → _pricing_config.plan_for);
// the cap that is ENFORCED is the Edge Function's (it is what calls
// reserve_user_chat). Two runtimes, one deliberate copy of the table
// (CLAUDE.md, Milestone D) — so this law READS THE PYTHON FILES and holds
// supabase/functions/chat-llm/plans.ts to them: the numbers, the environment
// names that override them, the legacy map, and the text of the three engine
// functions the resolution mirrors.
//
// WHAT IT REDS ON (TC-11): a cap changed on one side only; a plan added to
// the engine that the function would silently read as the trial caps (or the
// reverse); a legacy key mapped differently; an override variable the two
// read under different names; the engine's resolution (`tier or plan`,
// plan_for, _env_int) edited without this function being revisited.
//
// WHAT IT CANNOT SEE: the engine EXECUTING — it reads source text. The
// executed cross-check (the real `_pricing_config.plan_for` against the real
// plans.ts, over a matrix of rows) is scripts/check_chat_cap_real.py. And it
// cannot see the environment of either deployed runtime: a PRICING_CHAT_*
// override set on the engine container and not among the function's secrets
// (or the reverse) makes them disagree in production with every law green.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  LEGACY_TIER_MAP,
  buildPlans,
  envIntFrom,
  planFor,
  planForRow,
  storedTier,
  type PlanKey,
} from "../../../supabase/functions/chat-llm/plans";

const REPO = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf-8");
const PRICING = read("src/engine/api/_pricing_config.py");
const PLAN_STATE = read("src/engine/api/_plan_state.py");

// ── Reading the engine's table out of its source ───────────────────────

interface EnginePlan {
  key: string;
  dailyEnv: string; daily: number;
  monthlyEnv: string; monthly: number;
  purchasable: boolean;
}

function enginePlans(): EnginePlan[] {
  // Each plan is `<name> = PlanConfig( … )` at one indent inside _load().
  const out: EnginePlan[] = [];
  const rx = /\n    (\w+) = PlanConfig\(\n([\s\S]*?)\n    \)\n/g;
  for (let m = rx.exec(PRICING); m; m = rx.exec(PRICING)) {
    const body = m[2];
    const key = /key="(\w+)"/.exec(body)?.[1];
    const d = /daily=_env_int\("([A-Z_]+)",\s*(\d+)\)/.exec(body);
    const mo = /monthly=_env_int\("([A-Z_]+)",\s*(\d+)\)/.exec(body);
    if (!key || !d || !mo) throw new Error(`could not read the engine plan "${m[1]}" — the law's reader is out of date`);
    out.push({ key, dailyEnv: d[1], daily: Number(d[2]), monthlyEnv: mo[1], monthly: Number(mo[2]), purchasable: !/purchasable=False/.test(body) });
  }
  return out;
}

function engineLegacyMap(): Record<string, string> {
  const block = /legacy_tier_map: Dict\[str, PlanKey\] = \{([\s\S]*?)\n    \}/.exec(PRICING)?.[1];
  if (block === undefined) throw new Error("could not read legacy_tier_map — the law's reader is out of date");
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = /^\s*"(\w+)":\s*"(\w+)",?\s*$/.exec(line); // comment lines do not match
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function engineConfigKeys(): string[] {
  const m = /plans=\{([^}]*)\}/.exec(PRICING);
  if (!m) throw new Error("could not read CONFIG.plans — the law's reader is out of date");
  return [...m[1].matchAll(/"(\w+)":/g)].map((x) => x[1]);
}

/** A Python function's source with comments, docstrings and blank lines
 *  removed — what the function DOES, not how it is explained. */
function pyFunction(source: string, name: string): string {
  const start = source.indexOf(`\ndef ${name}(`);
  if (start < 0) throw new Error(`def ${name} not found`);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?=\S)/); // the next top-level statement
  const text = end < 0 ? rest : rest.slice(0, end);
  return text
    .replace(/"""[\s\S]*?"""/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+#.*$/, "").replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"))
    .join("\n");
}

const ENGINE = enginePlans();
const LEGACY = engineLegacyMap();
const byKey = Object.fromEntries(ENGINE.map((p) => [p.key, p]));

/** `_pricing_config.plan_for`, re-stated over what was read from the file. */
function engineResolve(raw: string | null | undefined): EnginePlan | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase();
  const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key); // a Python dict has no prototype
  if (has(byKey, k)) {
    const plan = byKey[k];
    if (!plan.purchasable && has(LEGACY, k)) return byKey[LEGACY[k]];
    return plan;
  }
  return has(LEGACY, k) ? byKey[LEGACY[k]] : null;
}

const NO_ENV = () => undefined;
const PLANS = buildPlans(NO_ENV);

describe("the function's tier → chat caps table is the engine's (_pricing_config.py, read from source)", () => {
  it("POSITIVE CONTROL: the reader found the engine's plans, their caps and the legacy map", () => {
    // eslint-disable-next-line no-console
    console.log(`GATE-WORK chat-cap-always engine-plans=${ENGINE.length} legacy-keys=${Object.keys(LEGACY).length}`);
    expect(ENGINE.map((p) => p.key).sort()).toEqual(engineConfigKeys().sort());
    expect(ENGINE.length).toBeGreaterThanOrEqual(6);
    expect(byKey.trial).toMatchObject({ daily: 3, monthly: 5, dailyEnv: "PRICING_CHAT_DAILY_CAP_TRIAL" });
    expect(byKey.multi).toMatchObject({ daily: 40, monthly: 200 });
    expect(byKey.starter.purchasable).toBe(false);
    expect(Object.keys(LEGACY).length).toBeGreaterThanOrEqual(5);
  });

  it("every tier string the engine knows resolves to the SAME daily and monthly cap here", () => {
    const keys = [...ENGINE.map((p) => p.key), ...Object.keys(LEGACY)];
    for (const k of keys) {
      const engine = engineResolve(k)!;
      const mine = planFor(PLANS, k);
      expect({ k, key: mine.key, daily: mine.chat.daily, monthly: mine.chat.monthly })
        .toEqual({ k, key: engine.key, daily: engine.daily, monthly: engine.monthly });
    }
  });

  it("the function knows no plan the engine does not: each of its plans is an engine plan with the engine's numbers", () => {
    for (const key of Object.keys(PLANS) as PlanKey[]) {
      expect(byKey[key], `the function has a plan "${key}" the engine does not`).toBeTruthy();
      expect(PLANS[key].chat).toEqual({ daily: byKey[key].daily, monthly: byKey[key].monthly });
      expect(PLANS[key].key).toBe(key);
    }
    // …and no purchasable engine plan is missing from it (a missing one would read as the trial caps).
    for (const p of ENGINE.filter((x) => x.purchasable)) expect(Object.keys(PLANS)).toContain(p.key);
  });

  it("the legacy map is the engine's, key for key", () => {
    expect(LEGACY_TIER_MAP).toEqual(LEGACY);
  });

  it("an override moves both: each cap is read from the environment variable the engine reads it from", () => {
    for (const p of ENGINE) {
      if (!p.purchasable) continue; // 'starter' is resolved through the legacy map on both sides
      const overridden = buildPlans((name) => (name === p.dailyEnv ? "777" : name === p.monthlyEnv ? "8888" : undefined));
      expect(overridden[p.key as PlanKey].chat, p.key).toEqual({ daily: 777, monthly: 8888 });
    }
  });

  it("an override is parsed as the engine's _env_int parses it — never parseInt's '30.5 → 30'", () => {
    const envInt = (raw: string | undefined) => envIntFrom(() => raw)("X", 3);
    for (const [raw, want] of [
      [undefined, 3], ["", 3], ["   ", 3], ["30", 30], [" 30 ", 30], ["+7", 7], ["-1", -1], ["1_000", 1000], ["0", 0],
      ["30.5", 3], ["30abc", 3], ["abc", 3], ["1e3", 3], ["0x10", 3], ["3 0", 3], ["_3", 3], ["3_", 3], ["1__0", 3],
    ] as const) expect(envInt(raw), JSON.stringify(raw)).toBe(want);
  });
});

describe("a subscriptions row resolves here exactly as _plan_state.get_plan_state resolves it", () => {
  // (tier, plan) → what the engine reads: `row.get("tier") or row.get("plan") or ""`.
  const engineStored = (row: { tier?: unknown; plan?: unknown } | null) =>
    row ? String((row.tier || row.plan || "") as string) : "";

  const ROWS: ({ tier?: unknown; plan?: unknown } | null)[] = [
    null,
    {},
    { tier: null, plan: null },
    // THE SIGNUP TRIGGER'S ROW (supabase/schema.sql handle_new_user): plan
    // 'professional', tier NULL. Both runtimes read 'professional'.
    { tier: null, plan: "professional" },
    { plan: "professional" },
    { tier: "", plan: "professional" },      // the case `??` got wrong: an EMPTY tier
    { tier: "   ", plan: "professional" },   // truthy in Python and in JS: the blank tier wins, and is unknown
    { tier: "trial", plan: "professional" },
    { tier: "intro", plan: "professional" },
    { tier: "solo", plan: "professional" },
    { tier: "pro", plan: "professional" },
    { tier: "multi", plan: "professional" },
    { tier: "starter", plan: "professional" },
    { tier: "pro_legacy", plan: "professional" },
    { tier: "business", plan: "solo" },
    { tier: "professional_contact", plan: "" },
    { tier: " PRO ", plan: "trial" },
    { tier: "Multi", plan: null },
    { tier: "enterprise", plan: "professional" }, // unknown tier: the trial caps, the plan column NOT consulted
    { tier: "owner", plan: "professional" },      // unknown on main (see the merge note in CLAUDE.md)
    { tier: null, plan: "solo" },
    { tier: null, plan: "starter" },
    { tier: null, plan: "nonsense" },
    { tier: "toString", plan: null },
    { tier: "constructor", plan: null },
    { tier: "__proto__", plan: null },
    { tier: "hasOwnProperty", plan: "pro" },
  ];

  it.each(ROWS.map((r) => [JSON.stringify(r), r] as const))("%s", (_name, row) => {
    const engine = engineResolve(engineStored(row)) ?? byKey.trial;
    const mine = planForRow(PLANS, row);
    expect(storedTier(row)).toBe(engineStored(row));
    expect({ key: mine.key, daily: mine.chat.daily, monthly: mine.chat.monthly })
      .toEqual({ key: engine.key, daily: engine.daily, monthly: engine.monthly });
  });

  it("what that means, stated: the signup trigger's default row (tier NULL, plan 'professional') is on the MULTI caps in both runtimes — and only a row with no plan named at all, or tier 'trial', is on the trial caps", () => {
    expect(planForRow(PLANS, { tier: null, plan: "professional" })).toMatchObject({ key: "multi", chat: { daily: 40, monthly: 200 } });
    expect(planForRow(PLANS, { tier: "trial", plan: "professional" })).toMatchObject({ key: "trial", chat: { daily: 3, monthly: 5 } });
    expect(planForRow(PLANS, null)).toMatchObject({ key: "trial", chat: { daily: 3, monthly: 5 } });
  });
});

describe("the engine code this resolution mirrors has not moved (edit plans.ts in the same commit, then this pin)", () => {
  it("_plan_state.get_plan_state reads the row's plan as `tier or plan`, and resolves it with plan_for", () => {
    expect(PLAN_STATE).toContain('raw_tier = row.get("tier") or row.get("plan") or ""');
    expect(PLAN_STATE).toContain("plan = _pricing_config.plan_for(str(raw_tier))");
    expect(PLAN_STATE).toContain('plan = _pricing_config.CONFIG.plans["trial"]');
  });

  it("_pricing_config.plan_for", () => {
    expect(pyFunction(PRICING, "plan_for")).toBe([
      "def plan_for(key: str) -> Optional[PlanConfig]:",
      "    if not key:",
      "        return None",
      "    k = key.strip().lower()",
      "    if k in CONFIG.plans:",
      "        plan = CONFIG.plans[k]",
      "        if not plan.purchasable:",
      "            mapped = CONFIG.legacy_tier_map.get(k)",
      "            if mapped:",
      "                return CONFIG.plans[mapped]",
      "        return plan",
      "    legacy = CONFIG.legacy_tier_map.get(k)",
      "    if legacy:",
      "        return CONFIG.plans[legacy]",
      "    return None",
    ].join("\n"));
  });

  it("_pricing_config._env_int", () => {
    expect(pyFunction(PRICING, "_env_int")).toBe([
      "def _env_int(name: str, default: int) -> int:",
      "    raw = os.environ.get(name)",
      '    if raw is None or raw.strip() == "":',
      "        return default",
      "    try:",
      "        return int(raw)",
      "    except (TypeError, ValueError):",
      '        logger.warning("[pricing] %s=%r is not a valid int — using default %s", name, raw, default)',
      "        return default",
    ].join("\n"));
  });
});
