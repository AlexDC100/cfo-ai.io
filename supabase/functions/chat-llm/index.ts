// Ask CFO AI conversational chat — Supabase Edge Function.
//
// Ports two things out of the Python engine so chat no longer needs
// `cfo-ai-backend` running at all (local dev or prod):
//   1. `src/engine/api/cfo_ai.py::chat_llm` — the Anthropic call + the
//      workspace/inventory system-prompt builders (`_build_workspace_chat_
//      system_prompt`, `_build_chat_system_prompt`, `_build_currency_
//      directive`, `_build_public_company_directive`).
//   2. `src/engine/api/_usage_gate.py` + `_plan_state.py` + `_pricing_
//      config.py` — Pricing V3 chat-cap enforcement. The atomic RPCs
//      (`reserve_user_chat` / `commit_user_chat` / `release_user_chat`)
//      already live in Postgres (supabase/schema_phase_pricing_v3_atomic.sql)
//      so only the plan-tier -> cap lookup needed porting, not the RPCs.
//
// KEEP IN SYNC: if the persona copy, currency directive, or plan caps
// change in the Python files above, mirror the change here too. There
// is deliberately no shared module between the two runtimes (Python
// engine vs Deno edge function) — duplication is the accepted tradeoff
// for removing the backend as a hard dependency for chat.
//
// Model + call shape (model id, max_tokens, output_config, cache_control)
// are copied byte-for-byte from cfo_ai.py's `client.messages.create(...)`
// so prompt-caching behavior is unaffected by which runtime answers.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

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

// ── Pricing V3 — plan tiers (mirrors _pricing_config.py, chat fields only) ─

type PlanKey = "trial" | "intro" | "starter" | "pro";

interface PlanConfig {
  key: PlanKey;
  display_name: string;
  chat: { daily: number | null; monthly: number | null };
}

function envInt(name: string, def: number): number {
  const raw = Deno.env.get(name);
  if (!raw || raw.trim() === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
}

const PLANS: Record<PlanKey, PlanConfig> = {
  trial: {
    key: "trial",
    display_name: "Free trial",
    chat: {
      daily: envInt("PRICING_CHAT_DAILY_CAP_TRIAL", 3),
      monthly: envInt("PRICING_CHAT_MONTHLY_CAP_TRIAL", 5),
    },
  },
  intro: {
    key: "intro",
    display_name: "Intro unlock",
    chat: {
      daily: envInt("PRICING_CHAT_DAILY_CAP_INTRO", 5),
      monthly: envInt("PRICING_CHAT_MONTHLY_CAP_INTRO", 10),
    },
  },
  starter: {
    key: "starter",
    display_name: "Starter",
    chat: {
      daily: envInt("PRICING_CHAT_DAILY_CAP_STARTER", 10),
      monthly: envInt("PRICING_CHAT_MONTHLY_CAP_STARTER", 50),
    },
  },
  pro: {
    key: "pro",
    display_name: "Pro",
    chat: {
      daily: envInt("PRICING_CHAT_DAILY_CAP_PRO", 40),
      monthly: envInt("PRICING_CHAT_MONTHLY_CAP_PRO", 200),
    },
  },
};

// Mirrors _pricing_config.py's legacy_tier_map — pre-V2 subscribers keep
// working under the new tier keys without a data migration.
const LEGACY_TIER_MAP: Record<string, PlanKey> = {
  solo: "starter",
  business: "pro",
  professional: "pro",
  professional_contact: "pro",
};

function planFor(rawKey: string | null | undefined): PlanConfig {
  const k = (rawKey ?? "").trim().toLowerCase();
  if (k in PLANS) return PLANS[k as PlanKey];
  const legacy = LEGACY_TIER_MAP[k];
  if (legacy) return PLANS[legacy];
  return PLANS.trial;
}

function enforcementEnabled(): boolean {
  const raw = (Deno.env.get("USAGE_LIMITS_ENABLED") ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

// ── Chat-cap RPCs (already exist in Postgres — see _usage_gate.py) ───────

async function callRpc(
  admin: SupabaseClient,
  name: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const { data, error } = await admin.rpc(name, payload);
    if (error) {
      console.warn(`[usage-gate] RPC ${name} failed`, error);
      return null;
    }
    if (Array.isArray(data)) return (data[0] as Record<string, unknown>) ?? null;
    return (data as Record<string, unknown>) ?? null;
  } catch (e) {
    console.error(`[usage-gate] RPC ${name} exception`, e);
    return null;
  }
}

type ChatReserveKind = "allowed" | "daily_cap_reached" | "monthly_cap_reached" | "disabled";

interface ChatReserveDecision {
  kind: ChatReserveKind;
  plan: PlanConfig;
  daily_used: number;
  monthly_used: number;
  message: string;
}

function todayParts(): { day: string; month: string } {
  const day = new Date().toISOString().slice(0, 10);
  return { day, month: day.slice(0, 7) };
}

async function reserveChat(admin: SupabaseClient, userId: string): Promise<ChatReserveDecision> {
  if (!enforcementEnabled()) {
    return { kind: "disabled", plan: PLANS.trial, daily_used: 0, monthly_used: 0, message: "" };
  }

  // Resolve the user's plan the same way _plan_state.get_plan_state does:
  // a service-role read of `subscriptions`, degrading to trial on any
  // failure or missing row (better to under-bill than reject a payer
  // because of a transient read error).
  let rawTier: string | null = null;
  try {
    const { data } = await admin
      .from("subscriptions")
      .select("tier, plan")
      .eq("user_id", userId)
      .maybeSingle();
    rawTier = (data?.tier ?? data?.plan ?? null) as string | null;
  } catch (e) {
    console.error("[plan-state] subscriptions read failed — degrading to trial", e);
  }
  const plan = planFor(rawTier);

  const { day, month } = todayParts();
  const body = (await callRpc(admin, "reserve_user_chat", {
    p_user_id: userId,
    p_month: month,
    p_day: day,
    p_daily_cap: plan.chat.daily,
    p_monthly_cap: plan.chat.monthly,
  })) ?? {};

  const kind = (body.kind as string) ?? "monthly_cap_reached";
  const daily_used = Number(body.daily_used ?? 0);
  const monthly_used = Number(body.monthly_used ?? 0);

  if (kind === "allowed") {
    return { kind: "allowed", plan, daily_used, monthly_used, message: "" };
  }
  if (kind === "daily_cap_reached") {
    return {
      kind: "daily_cap_reached",
      plan,
      daily_used,
      monthly_used,
      message:
        `Daily Ask CFO AI limit reached for the ${plan.display_name} plan ` +
        `(${plan.chat.daily} messages / day). Resets at midnight UTC.`,
    };
  }
  return {
    kind: "monthly_cap_reached",
    plan,
    daily_used,
    monthly_used,
    message:
      `Monthly Ask CFO AI limit reached for the ${plan.display_name} plan ` +
      `(${plan.chat.monthly} messages / month). Resets at the start of your next billing period.`,
  };
}

async function commitChat(admin: SupabaseClient, userId: string): Promise<void> {
  if (!enforcementEnabled()) return;
  const { day, month } = todayParts();
  await callRpc(admin, "commit_user_chat", { p_user_id: userId, p_month: month, p_day: day });
}

async function releaseChat(admin: SupabaseClient, userId: string): Promise<void> {
  if (!enforcementEnabled()) return;
  const { day, month } = todayParts();
  await callRpc(admin, "release_user_chat", { p_user_id: userId, p_month: month, p_day: day });
}

// ── Request shape (mirrors LlmChatRequest / LlmFxContext / LlmPublicCompanyContext) ─

interface LlmChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface LlmFxContext {
  source_currency?: string;
  display_currency?: string;
  rate?: number;
  rate_date?: string | null;
  provider?: string | null;
}

interface LlmPublicCompanyContext {
  ticker: string;
  company_name?: string | null;
  sector?: string | null;
  industry?: string | null;
  exchange?: string | null;
  currency?: string | null;
  latest_period?: string | null;
  latest_period_end?: string | null;
  revenue?: number | null;
  ebitda?: number | null;
  net_income?: number | null;
  total_assets?: number | null;
  total_equity?: number | null;
  cash?: number | null;
  net_debt?: number | null;
  free_cash_flow?: number | null;
  market_cap?: number | null;
  enterprise_value?: number | null;
  pe_ratio?: number | null;
  ev_to_ebitda?: number | null;
  ebitda_margin?: number | null;
  net_margin?: number | null;
  roe?: number | null;
  net_debt_to_ebitda?: number | null;
  source?: string | null;
}

interface LlmChatRequest {
  messages: LlmChatMessage[];
  dataset_summary?: string | null;
  page?: string;
  company_name?: string;
  mode?: string | null;
  display_currency?: string | null;
  fx_context?: LlmFxContext | null;
  public_company?: LlmPublicCompanyContext | null;
}

// ── System-prompt builders (verbatim port of cfo_ai.py's) ────────────────

function buildCurrencyDirective(
  displayCurrency: string | null | undefined,
  fx: LlmFxContext | null | undefined,
): string {
  if (!displayCurrency && !fx) return "";

  let source: string, display: string, rate: number, rateDate: string, provider: string;
  if (fx) {
    source = (fx.source_currency || "RON").toUpperCase();
    display = (fx.display_currency || displayCurrency || source).toUpperCase();
    rate = fx.rate || 1.0;
    rateDate = fx.rate_date || "today";
    provider = fx.provider || "BNR";
  } else {
    source = "RON";
    display = (displayCurrency || "RON").toUpperCase();
    rate = 1.0;
    rateDate = "today";
    provider = "BNR";
  }

  if (source === display) {
    return (
      "\n\n=== Display-currency rule ===\n" +
      `The user is viewing this workspace in ${display}. The underlying ` +
      `data is also stored in ${display}, so cite money figures in ` +
      `${display} directly — no conversion needed.\n` +
      "Ratios, multiples, days, counts, and percentages stay as-is " +
      "regardless of currency.\n" +
      "=== End rule ===\n"
    );
  }

  return (
    "\n\n=== Display-currency rule ===\n" +
    `The user is viewing this workspace in ${display}. The underlying ` +
    `snapshot below is stored in ${source}.\n` +
    `Reference FX rate: 1 ${source} = ${rate.toFixed(4)} ${display} ` +
    `(source: ${provider}, ${rateDate}).\n` +
    "When you cite money figures from the snapshot:\n" +
    `  · Show the value in ${display} as the primary unit.\n` +
    "  · For non-trivial conversions, note the source briefly, e.g. " +
    `"~${display} 918k (converted from ${source} 4.58M at ${provider} rate)".\n` +
    "  · For ratios, multiples, days, counts, percentages: present " +
    "unchanged regardless of currency.\n" +
    "  · Never invent or extrapolate a different FX rate. Use only " +
    "the rate provided above; if the user asks for a currency outside " +
    "RON/EUR/USD, say you don't have the rate.\n" +
    "=== End rule ===\n"
  );
}

function fmtMoney(v: number | null | undefined): string {
  return v != null ? `USD ${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—";
}
function fmtPct(v: number | null | undefined): string {
  return v != null ? `${v.toFixed(1)}%` : "—";
}
function fmtMult(v: number | null | undefined): string {
  return v != null ? `${v.toFixed(1)}x` : "—";
}

function buildPublicCompanyDirective(pc: LlmPublicCompanyContext | null | undefined): string {
  if (!pc) return "";

  const label = (pc.company_name || pc.ticker).trim();
  const period = pc.latest_period || "latest available period";
  const sourceLine =
    (pc.source || "").toLowerCase() === "demo"
      ? "Demo (FY2024-indicative — not live SF1 data)"
      : "Sharadar SF1 (live)";

  const lines = [
    `Ticker / company: ${pc.ticker}  ·  ${label}`,
    `Exchange · sector · industry: ${pc.exchange || "—"} · ${pc.sector || "—"} · ${pc.industry || "—"}`,
    `Currency: ${pc.currency || "USD"}    Period: ${period}` +
      (pc.latest_period_end ? `  (ended ${pc.latest_period_end})` : ""),
    `Source: ${sourceLine}`,
    "",
    "Headline (raw USD unless noted):",
    `  · Revenue          ${fmtMoney(pc.revenue)}`,
    `  · EBITDA           ${fmtMoney(pc.ebitda)}  (${fmtPct(pc.ebitda_margin)} margin)`,
    `  · Net income       ${fmtMoney(pc.net_income)}  (${fmtPct(pc.net_margin)} margin)`,
    `  · Total assets     ${fmtMoney(pc.total_assets)}`,
    `  · Total equity     ${fmtMoney(pc.total_equity)}`,
    `  · Cash             ${fmtMoney(pc.cash)}`,
    `  · Net debt         ${fmtMoney(pc.net_debt)}  (${fmtMult(pc.net_debt_to_ebitda)} ND/EBITDA)`,
    `  · Free cash flow   ${fmtMoney(pc.free_cash_flow)}`,
    "",
    "Market:",
    `  · Market cap       ${fmtMoney(pc.market_cap)}`,
    `  · Enterprise value ${fmtMoney(pc.enterprise_value)}`,
    `  · P/E              ${fmtMult(pc.pe_ratio)}`,
    `  · EV / EBITDA      ${fmtMult(pc.ev_to_ebitda)}`,
    `  · ROE              ${fmtPct(pc.roe)}`,
  ];

  return (
    "\n\n=== Public-company context ===\n" +
    "The user is currently viewing this Nasdaq-listed company on the " +
    "Public Company Intelligence page. Use the figures below when the " +
    "user asks about this ticker — never invent or extrapolate beyond " +
    "these numbers. If they ask for a metric not shown here (e.g. " +
    "segment revenue, geographic mix), say so plainly and suggest the " +
    "Sharadar SF1 query that would surface it.\n\n" +
    lines.join("\n") +
    "\n=== End public-company context ===\n"
  );
}

function buildWorkspaceChatSystemPrompt(req: LlmChatRequest): string {
  const persona =
    "You are CFO AI, a capable general assistant with access to the " +
    "user's CFO AI financial workspace. Answer any question helpfully " +
    "— finance, strategy, industry, the app itself, general knowledge. " +
    "You are NOT a refuse-everything-ungrounded bot; open-domain " +
    "questions are welcome and should be answered with the same care " +
    "as a knowledgeable colleague would.\n\n" +
    "Voice:\n" +
    "  · Direct, specific, warm. Skip preambles like \"Great " +
    "question!\" or \"That's an interesting one\".\n" +
    "  · Use markdown for structure when it helps — short headers, " +
    "bullet lists, bold for key numbers.\n" +
    "  · Multi-turn — earlier turns are context for the next one.\n\n" +
    "Workspace grounding rules (non-negotiable):\n" +
    "  · When you state a number about THIS user's company, it must " +
    "come from the workspace snapshot below. Cite the period and the " +
    "figure (e.g. \"FY2025 EBITDA of 2.13M RON, from the snapshot\").\n" +
    "  · If the user asks for a specific company figure that is NOT " +
    "in the snapshot, say so plainly. Do not guess, infer, or " +
    "fabricate the user's own numbers. Suggest they upload the " +
    "relevant document or check the active period.\n" +
    "  · General-knowledge numbers (e.g. typical industry margins, " +
    "WACC ranges, benchmark ratios) are fine to share as general " +
    "guidance, but make clear they are NOT this user's data.\n\n" +
    "Open-domain latitude:\n" +
    "  · You may discuss accounting concepts, Romanian RAS / IFRS " +
    "differences, tax theory, valuation methodology, M&A processes, " +
    "strategy frameworks, or anything else the user asks. You are " +
    "not required to refuse non-workspace topics.\n" +
    "  · For Romanian regulatory / tax / legal specifics, advise the " +
    "user to confirm with a qualified Romanian advisor before acting " +
    "— the persistent disclosure in the UI states this; you can echo " +
    "it briefly when relevant but do not nag.\n\n" +
    "Final-decision posture:\n" +
    "  · Frame recommendations as analysis, not commands. \"The data " +
    "suggests\", \"a CFO playbook here would be\", \"if it were my " +
    "call\". Final decisions remain with the user.\n";

  const pageLine = `\nThe operator is currently viewing the ${req.page ?? "Today"} page.`;
  const companyLine = `\nCompany context: ${req.company_name ?? "Demo workspace"}.`;

  let grounding: string;
  if (req.dataset_summary && req.dataset_summary.trim()) {
    grounding =
      "\n\n=== Active workspace snapshot ===\n" +
      req.dataset_summary.trim() +
      "\n=== End snapshot ===\n" +
      "\n" +
      "Use this snapshot for any company-specific answer. Cite the " +
      "period and the figure when you do. If something the user " +
      "asks about isn't in this snapshot, say so — never guess " +
      "their numbers.\n";
  } else {
    grounding =
      "\n\nNo workspace data is loaded yet. Open-domain questions " +
      "remain fully answerable; for any question that needs THIS " +
      "user's specific company figures, tell them to load a period " +
      "from the Dashboard first.\n";
  }

  const fxDirective = buildCurrencyDirective(req.display_currency, req.fx_context);
  const publicDirective = buildPublicCompanyDirective(req.public_company);
  return persona + pageLine + companyLine + grounding + fxDirective + publicDirective;
}

function buildChatSystemPrompt(req: LlmChatRequest): string {
  const persona =
    "You are CFO AI, a senior financial AI advisor for inventory-heavy " +
    "businesses. You help operators decide what to protect, fix, reduce, " +
    "liquidate, or scale across their portfolio.\n\n" +
    "Voice:\n" +
    "  · Warm but direct. Specific, not vague. Skip preambles like " +
    "\"Great question!\" or \"That's an interesting one\".\n" +
    "  · Use real numbers when they're given. kEUR / pp / DIO / CCC " +
    "are part of your everyday vocabulary.\n" +
    "  · Markdown is welcome — short headers, bullet lists, bold for " +
    "key numbers. Code blocks for any structured data.\n" +
    "  · Multi-turn — assume the operator's previous questions are " +
    "context for the next one.\n\n" +
    "Scope:\n" +
    "  · Engage with whatever the operator asks. Inventory, working " +
    "capital, financial mentoring, general questions about CFO craft, " +
    "spreadsheet help, anything they bring up. Do NOT refuse to " +
    "discuss off-topic questions.\n" +
    "  · When you don't know a specific number, say so plainly — " +
    "don't fabricate numbers. The operator can run an upload to get " +
    "fresh data if needed.\n\n" +
    "Final-decision posture:\n" +
    "  · Frame recommendations as analysis, not as commands. Use " +
    "phrases like \"the data suggests\", \"a CFO playbook here would " +
    "be\", or \"if it were my call\". Final decisions remain with the " +
    "operator's management team.\n";

  const pageLine = `\nThe operator is currently viewing the ${req.page ?? "Today"} page.`;
  const companyLine = `\nCompany context: ${req.company_name ?? "Demo workspace"}.`;

  let grounding: string;
  if (req.dataset_summary && req.dataset_summary.trim()) {
    grounding =
      "\n\n=== Current portfolio snapshot ===\n" +
      req.dataset_summary.trim() +
      "\n=== End snapshot ===\n" +
      "\n" +
      "Anchor your answers in this snapshot when the operator asks " +
      "about their portfolio. Don't repeat the snapshot back at them " +
      "— they already know — just use it to give pointed answers.\n";
  } else {
    grounding =
      "\n\nNo portfolio data is loaded yet. If the operator asks " +
      "about specifics (their categories, alerts, capital trapped), " +
      "tell them to upload a workbook from the sidebar to get " +
      "grounded answers, then offer general CFO guidance for the " +
      "topic they raised.\n";
  }

  const fxDirective = buildCurrencyDirective(req.display_currency, req.fx_context);
  const publicDirective = buildPublicCompanyDirective(req.public_company);
  return persona + pageLine + companyLine + grounding + fxDirective + publicDirective;
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

  let payload: LlmChatRequest;
  try {
    payload = await req.json();
  } catch {
    return json({ detail: "Invalid JSON body" }, 400, cors);
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return json({ detail: "messages is required" }, 400, cors);
  }

  if (!ANTHROPIC_API_KEY) {
    return json(
      {
        answer:
          "Conversational AI isn't configured on this build — " +
          "ANTHROPIC_API_KEY is missing. Set it as a Supabase Edge " +
          "Function secret to chat with Claude Opus 4.7.",
        model: null,
        usage: null,
      },
      200,
      cors,
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Resolve the calling user, same as the Python endpoint: optional.
  // Unauthenticated calls still work (legacy / logged-out callers) but
  // skip cap enforcement, matching `if authorization and ...` in cfo_ai.py.
  let userId: string | null = null;
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    try {
      const jwt = authHeader.slice(7).trim();
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data } = await userClient.auth.getUser(jwt);
      userId = data.user?.id ?? null;
    } catch (e) {
      console.warn("[chat] auth.getUser failed", e);
      userId = null;
    }
  }

  if (userId) {
    const decision = await reserveChat(admin, userId);
    if (decision.kind !== "allowed" && decision.kind !== "disabled") {
      return json(
        {
          detail: {
            code: "chat_cap_reached",
            kind: decision.kind,
            plan_key: decision.plan.key,
            daily_used: decision.daily_used,
            daily_cap: decision.plan.chat.daily,
            monthly_used: decision.monthly_used,
            monthly_cap: decision.plan.chat.monthly,
            message: decision.message,
            upgrade_url: "/pricing",
          },
        },
        429,
        cors,
      );
    }
  }

  const mode = (payload.mode ?? "").trim().toLowerCase();
  const systemText =
    mode === "workspace" ? buildWorkspaceChatSystemPrompt(payload) : buildChatSystemPrompt(payload);

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 2000,
        system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
        messages: payload.messages.map((m) => ({ role: m.role, content: m.content })),
        output_config: { effort: "high" },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      if (userId) await releaseChat(admin, userId);
      return json(
        {
          answer: `Couldn't reach Claude: ${resp.status} ${errText.slice(0, 300)}. Try again in a moment.`,
          model: "claude-opus-4-7",
          usage: null,
        },
        200,
        cors,
      );
    }

    const data = await resp.json();
    const text = (data.content ?? [])
      .filter((b: { type?: string }) => b.type === "text")
      .map((b: { text?: string }) => b.text ?? "")
      .join("")
      .trim();

    if (userId) await commitChat(admin, userId);

    return json(
      {
        answer: text,
        model: data.model,
        usage: {
          input_tokens: data.usage?.input_tokens ?? 0,
          output_tokens: data.usage?.output_tokens ?? 0,
          cache_read_input_tokens: data.usage?.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: data.usage?.cache_creation_input_tokens ?? 0,
        },
      },
      200,
      cors,
    );
  } catch (e) {
    if (userId) await releaseChat(admin, userId);
    return json(
      {
        answer: `Couldn't reach Claude: ${String(e)}. Try again in a moment.`,
        model: "claude-opus-4-7",
        usage: null,
      },
      200,
      cors,
    );
  }
});
