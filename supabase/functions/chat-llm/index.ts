// Ask CFO AI conversational chat — Supabase Edge Function.
//
// THIN WIRING. The decision — who is asking, what their plan allows, whether
// the meter let this call through, and only then one model request — is
// guard.ts (pure, injected, held by the vitest laws in
// frontend/lib/__tests__/chatLlm*.test.ts). This file gives it the real
// things: the auth server, the `subscriptions` row, the three metering RPCs
// (reserve_user_chat / commit_user_chat / release_user_chat —
// supabase/schema_phase_pricing_v3_atomic.sql, service_role only) and one
// `fetch` to the model.
//
//   plans.ts    the tier → chat caps table and the plan resolution, held to
//               src/engine/api/_pricing_config.py + _plan_state.py
//   prompt.ts   the request shape and the system-prompt builders
//   guard.ts    the order: verify → validate → plan → reserve → ONE model
//               request → commit | release
//
// THE CAP IS ALWAYS ENFORCED (owner, 2026-10-03). A call with no bearer, or
// a bearer the auth server does not vouch for, is answered 401 before
// anything else happens; a verified user is metered on EVERY call. There is
// no switch: this function does not read USAGE_LIMITS_ENABLED (unset in
// production, it used to leave every caller uncapped), and no environment
// variable turns the cap off.
//
// Deployed with --no-verify-jwt: the platform gateway lets the request
// through and THIS function verifies the bearer (auth.getUser) — so its own
// 401 carries a typed body the app can render, and the CORS preflight is
// answered here.
//
// One reservation → one upstream request: a single `fetch`, no SDK retry
// underneath, no retry here.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

import {
  buildModelRequestBody,
  handleChat,
  readModelResponse,
  resolveUpstreamBase,
  type MeterArgs,
  type ModelInput,
  type ModelResult,
  type ReserveArgs,
  type VerifyResult,
} from "./guard.ts";
import { buildPlans, type SubscriptionRow } from "./plans.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

// The model upstream. Production leaves CHAT_LLM_UPSTREAM_BASE_URL unset and
// this is https://api.anthropic.com; the only other value honoured is a
// loopback address (the local recorder scripts/check_chat_cap_real.sh serves).
const UPSTREAM_BASE = resolveUpstreamBase(Deno.env.get("CHAT_LLM_UPSTREAM_BASE_URL"));

const PLANS = buildPlans((name) => Deno.env.get(name));

const SERVER_AUTH = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

// ── CORS ────────────────────────────────────────────────────────────────
// Edge Functions get no automatic CORS handling — mirrors the CORS_ORIGINS
// allowlist the Python backend sets (docker-compose.yml / cfo_ai engine env).
const ALLOWED_ORIGINS = new Set([
  "https://cfo-ai.io",
  "https://www.cfo-ai.io",
  "https://cfo-ai.finance",
  "https://www.cfo-ai.finance",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://cfo-ai.io";
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-org-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ── The real dependencies guard.ts is handed ────────────────────────────

/** Who the bearer is, according to the auth server — never the token's own
 *  claims. A 4xx is the server saying "nobody"; anything else (a network
 *  failure, a 5xx) is "could not ask", which guard.ts refuses as well. */
async function verifyUser(bearer: string): Promise<VerifyResult> {
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${bearer}` } },
    auth: SERVER_AUTH,
  });
  const { data, error } = await userClient.auth.getUser(bearer);
  const id = data?.user?.id;
  if (typeof id === "string" && id) return { kind: "verified", userId: id };
  if (error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 500) return { kind: "unverified" };
    console.error("[chat] auth.getUser could not be asked", error);
    return { kind: "unavailable" };
  }
  return { kind: "unverified" };
}

/** The user's plan columns; null when there is no row. THROWS when the row
 *  cannot be read — guard.ts answers 503, never "trial". */
async function readPlan(admin: SupabaseClient, userId: string): Promise<SubscriptionRow | null> {
  const { data, error } = await admin
    .from("subscriptions")
    .select("tier, plan")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`subscriptions read failed: ${error.message}`);
  return (data as SubscriptionRow | null) ?? null;
}

/** One metering RPC. THROWS on any error — guard.ts decides what that means
 *  (reserve: refuse; commit / release: log). */
async function rpc(admin: SupabaseClient, name: string, payload: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await admin.rpc(name, payload);
  if (error) throw new Error(`RPC ${name} failed: ${error.message}`);
  return data;
}

const meterPayload = (a: MeterArgs) => ({ p_user_id: a.userId, p_month: a.month, p_day: a.day });

/** ONE upstream request. */
async function callModel(apiKey: string, input: ModelInput): Promise<ModelResult> {
  const resp = await fetch(`${UPSTREAM_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(buildModelRequestBody(input)),
  });
  if (!resp.ok) return { ok: false, status: resp.status, errorText: await resp.text() };
  return { ok: true, ...readModelResponse(await resp.json()) };
}

// ── Handler ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }
  if (req.method !== "POST") {
    return json({ detail: "Method not allowed" }, 405, cors);
  }

  // Read once, here; guard.ts refuses an unverified caller BEFORE it looks
  // at what was sent (the body is only consulted for its `language`).
  let body: unknown = undefined;
  try {
    body = await req.json();
  } catch {
    body = undefined;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: SERVER_AUTH });

  const reply = await handleChat(
    {
      plans: PLANS,
      modelConfigured: Boolean(ANTHROPIC_API_KEY),
      now: () => new Date(),
      verifyUser,
      readPlan: (userId) => readPlan(admin, userId),
      reserve: (a: ReserveArgs) =>
        rpc(admin, "reserve_user_chat", {
          ...meterPayload(a),
          p_daily_cap: a.dailyCap,
          p_monthly_cap: a.monthlyCap,
        }),
      commit: (a) => rpc(admin, "commit_user_chat", meterPayload(a)),
      release: (a) => rpc(admin, "release_user_chat", meterPayload(a)),
      callModel: (input) => callModel(ANTHROPIC_API_KEY as string, input),
      log: (level, message, extra) => (level === "error" ? console.error : console.warn)(message, extra ?? ""),
    },
    { authorization: req.headers.get("authorization"), body },
  );

  return json(reply.body, reply.status, cors);
});
