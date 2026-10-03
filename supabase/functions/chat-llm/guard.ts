// Ask CFO AI — THE DECISION: who is asking, what their plan allows, whether
// the meter let this call through — and only then, one model request.
//
// PURE: no Deno global, no supabase-js, no fetch. Everything that touches the
// outside (the auth server, the plan row, the three metering RPCs, the model)
// is INJECTED, so the laws in frontend/lib/__tests__/chatLlmGuard.test.ts put
// a recorder where the model call would be and "refused" MEANS "no upstream
// request". index.ts is the thin Deno wiring over this file.
//
// THE ORDER IS THE CONTRACT (owner, 2026-10-03: "enforces its cap on every
// call, signed in or not"):
//
//   1. NO VERIFIED USER, NO MODEL CALL.  No bearer, or a bearer the auth
//      server does not vouch for → 401 sign_in_required. Before the request
//      is validated, before any metering write, before any upstream request.
//   2. the request is validated; the system prompt is built (pure). With
//      no model key the call ends here: 503 ai_not_configured, nothing
//      reserved.
//   3. the plan row is read. Unreadable → 503 metering_unavailable.
//   4. reserve_user_chat — THE cap decision, atomic in Postgres. This file
//      never reads a counter and never pre-checks: two calls at cap − 1 are
//      settled by the RPC's row lock, not here.
//        allowed              → continue
//        daily/monthly cap    → 429 chat_cap_reached
//        error / timeout / a shape this file does not understand
//                             → 503 metering_unavailable
//   5. ONE upstream request for the ONE reservation (no retry here, no SDK
//      retry underneath: index.ts uses a single fetch).
//   6. answered → commit_user_chat once; failed → release_user_chat once.
//
// THERE IS NO SWITCH. `USAGE_LIMITS_ENABLED` gated steps 3–6 until
// 2026-10-03 and was unset in production — every signed-in user was
// uncapped, and a caller with no bearer skipped the meter entirely. Nothing
// in this function reads that variable any more; no environment variable
// turns the cap off.
//
// FAIL CLOSED. "Could not meter" is never "allowed": every arm that cannot
// prove a reservation returns without calling the model.

import { planForRow, type PlanConfig, type PlanTable, type SubscriptionRow } from "./plans.ts";
import {
  buildSystemPrompt,
  type LlmChatMessage,
  type LlmChatRequest,
  type LlmFxContext,
  type LlmPublicCompanyContext,
} from "./prompt.ts";

// ── What bounds ONE call (C4) ────────────────────────────────────────────
// model + max_tokens are copied from the engine's original
// `client.messages.create(...)`; they are not plan limits and not decided
// here. One reservation → one request with this body → at most MAX_TOKENS
// output tokens. INPUT is bounded only by the model's context window: the
// function forwards the whole `messages` history and the whole
// `dataset_summary` it is sent (see CLAUDE.md, "Ask CFO AI — the cap is
// always enforced", for what that costs and what is left to rule).
export const MODEL_ID = "claude-opus-4-7";
export const MAX_TOKENS = 2000;

/** How long the auth check, the plan read and each metering RPC may take
 *  before it counts as unavailable. Not a plan limit. */
export const METERING_TIMEOUT_MS = 8000;

export type Lang = "en" | "ro";

export type VerifyResult =
  | { kind: "verified"; userId: string }
  /** The auth server answered: this bearer is nobody. */
  | { kind: "unverified" }
  /** The auth server could not be asked. Never treated as verified. */
  | { kind: "unavailable" };

export interface ReserveArgs {
  userId: string;
  /** "YYYY-MM", UTC — the meter's month bucket. */
  month: string;
  /** "YYYY-MM-DD", UTC. */
  day: string;
  dailyCap: number | null;
  monthlyCap: number | null;
}

export interface MeterArgs {
  userId: string;
  month: string;
  day: string;
}

export interface ModelInput {
  system: string;
  messages: LlmChatMessage[];
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export type ModelResult =
  | { ok: true; text: string; model: unknown; usage: ModelUsage }
  | { ok: false; status: number; errorText: string };

export interface ChatDeps {
  plans: PlanTable;
  /** False when ANTHROPIC_API_KEY is not set: no model call is possible, so
   *  nothing is reserved either. */
  modelConfigured: boolean;
  now: () => Date;
  /** The bearer token, without its "Bearer " prefix. */
  verifyUser: (bearer: string) => Promise<VerifyResult>;
  /** The user's `subscriptions` row (tier, plan); null when there is no row.
   *  REJECTS when the row cannot be read. */
  readPlan: (userId: string) => Promise<SubscriptionRow | null>;
  /** reserve_user_chat's body, as returned. REJECTS when the RPC errors. */
  reserve: (args: ReserveArgs) => Promise<unknown>;
  /** commit_user_chat. REJECTS when the RPC errors. */
  commit: (args: MeterArgs) => Promise<unknown>;
  /** release_user_chat. REJECTS when the RPC errors. */
  release: (args: MeterArgs) => Promise<unknown>;
  /** ONE upstream request. */
  callModel: (input: ModelInput) => Promise<ModelResult>;
  log?: (level: "warn" | "error", message: string, extra?: unknown) => void;
  timeoutMs?: number;
}

export interface ChatCall {
  /** The Authorization header as received, or null. */
  authorization: string | null;
  /** The parsed JSON body; `undefined` when the body was not JSON. */
  body: unknown;
}

export interface ChatReply {
  status: number;
  body: unknown;
}

// ── The refusals: a CODE, and a sentence for a caller that has no words of
//    its own. The app renders its own sentence from the code, in the
//    reader's language (frontend/lib/chatRefusal.ts) — never these.
export type RefusalCode = "sign_in_required" | "metering_unavailable" | "auth_unavailable" | "ai_not_configured";

const REFUSAL_TEXT: Record<RefusalCode, Record<Lang, string>> = {
  sign_in_required: {
    en: "Sign in to use Ask CFO AI.",
    ro: "Autentifică-te ca să folosești Ask CFO AI.",
  },
  metering_unavailable: {
    en:
      "Ask CFO AI could not check your plan's message allowance, so it did not answer. " +
      "Nothing was counted. Try again in a moment.",
    ro:
      "Ask CFO AI nu a putut verifica mesajele incluse în planul tău, așa că nu a răspuns. " +
      "Nu s-a contorizat nimic. Încearcă din nou în câteva momente.",
  },
  auth_unavailable: {
    en: "Ask CFO AI could not confirm who is signed in, so it did not answer. Try again in a moment.",
    ro: "Ask CFO AI nu a putut confirma cine este autentificat, așa că nu a răspuns. Încearcă din nou în câteva momente.",
  },
  // No model key among the function's secrets. Said to the caller without
  // the internals: which variable, which model and where to set it are in
  // the function's log, not in a reader's conversation.
  ai_not_configured: {
    en: "Ask CFO AI is not available right now.",
    ro: "Ask CFO AI nu este disponibil momentan.",
  },
};

const REFUSAL_STATUS: Record<RefusalCode, number> = {
  sign_in_required: 401,
  metering_unavailable: 503,
  auth_unavailable: 503,
  ai_not_configured: 503,
};

function refusal(code: RefusalCode, lang: Lang): ChatReply {
  return {
    status: REFUSAL_STATUS[code],
    body: { error: code, detail: { code, message: REFUSAL_TEXT[code][lang] } },
  };
}

// ── Small pure helpers ──────────────────────────────────────────────────

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerOf(authorization: string | null | undefined): string | null {
  if (typeof authorization !== "string") return null;
  const m = /^bearer\s+(\S.*)$/i.exec(authorization.trim());
  const token = m ? m[1].trim() : "";
  return token ? token : null;
}

/** The request's own `language` field, if it carries one. */
export function languageOf(body: unknown): Lang {
  const raw = isRecord(body) ? body.language : undefined;
  return typeof raw === "string" && raw.trim().toLowerCase().startsWith("ro") ? "ro" : "en";
}

/** The UTC day and month the meter buckets by — read ONCE per request, so a
 *  reservation made at 23:59:59 is committed or released on the same rows. */
export function dayAndMonth(now: Date): { day: string; month: string } {
  const day = now.toISOString().slice(0, 10);
  return { day, month: day.slice(0, 7) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export type ParsedRequest =
  | { ok: true; req: LlmChatRequest }
  | { ok: false; detail: string };

/** The request the model call is built from — ONLY the fields this function
 *  knows, each in the type the app sends it in.
 *
 *  `messages` is refused unless every entry is {role: "user" | "assistant",
 *  content: <string>}: that is all the app ever sends (three callers, all
 *  through frontend/lib/cfoApi.chatLlm), and it keeps a direct caller from
 *  forwarding image or document blocks, or a `system` turn, on the owner's
 *  key. The optional context fields are NORMALISED, never refused: a value of
 *  the wrong type reads as absent, so no real request starts failing and the
 *  prompt builders cannot throw. */
export function parseRequest(body: unknown): ParsedRequest {
  if (!isRecord(body)) return { ok: false, detail: "Invalid JSON body" };
  const rawMessages = body.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return { ok: false, detail: "messages is required" };
  }
  const messages: LlmChatMessage[] = [];
  for (const m of rawMessages) {
    if (!isRecord(m) || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      return { ok: false, detail: 'each message must be {role: "user" | "assistant", content: string}' };
    }
    messages.push({ role: m.role as "user" | "assistant", content: m.content as string });
  }

  let fx: LlmFxContext | null = null;
  if (isRecord(body.fx_context)) {
    const f = body.fx_context;
    fx = {
      source_currency: str(f.source_currency),
      display_currency: str(f.display_currency),
      rate: num(f.rate) ?? undefined,
      rate_date: strOrNull(f.rate_date),
      provider: strOrNull(f.provider),
    };
  }

  let pc: LlmPublicCompanyContext | null = null;
  if (isRecord(body.public_company) && typeof body.public_company.ticker === "string" && body.public_company.ticker.trim()) {
    const p = body.public_company;
    pc = {
      ticker: p.ticker as string,
      company_name: strOrNull(p.company_name),
      sector: strOrNull(p.sector),
      industry: strOrNull(p.industry),
      exchange: strOrNull(p.exchange),
      currency: strOrNull(p.currency),
      latest_period: strOrNull(p.latest_period),
      latest_period_end: strOrNull(p.latest_period_end),
      revenue: num(p.revenue),
      ebitda: num(p.ebitda),
      net_income: num(p.net_income),
      total_assets: num(p.total_assets),
      total_equity: num(p.total_equity),
      cash: num(p.cash),
      net_debt: num(p.net_debt),
      free_cash_flow: num(p.free_cash_flow),
      market_cap: num(p.market_cap),
      enterprise_value: num(p.enterprise_value),
      pe_ratio: num(p.pe_ratio),
      ev_to_ebitda: num(p.ev_to_ebitda),
      ebitda_margin: num(p.ebitda_margin),
      net_margin: num(p.net_margin),
      roe: num(p.roe),
      net_debt_to_ebitda: num(p.net_debt_to_ebitda),
      source: strOrNull(p.source),
    };
  }

  return {
    ok: true,
    req: {
      messages,
      dataset_summary: strOrNull(body.dataset_summary),
      page: str(body.page),
      company_name: str(body.company_name),
      mode: strOrNull(body.mode),
      display_currency: strOrNull(body.display_currency),
      fx_context: fx,
      public_company: pc,
    },
  };
}

// ── The meter's answer ──────────────────────────────────────────────────

export type ReserveKind = "allowed" | "daily_cap_reached" | "monthly_cap_reached";

export interface ReserveDecision {
  kind: ReserveKind;
  dailyUsed: number | null;
  monthlyUsed: number | null;
}

/** reserve_user_chat's body → a decision, or NULL when it is not one this
 *  function understands (null, an array, a missing or unknown `kind`). NULL
 *  is never "allowed" and never a cap: the caller answers 503. */
export function readReserve(body: unknown): ReserveDecision | null {
  const row = Array.isArray(body) ? body[0] : body;
  if (!isRecord(row)) return null;
  const kind = row.kind;
  if (kind !== "allowed" && kind !== "daily_cap_reached" && kind !== "monthly_cap_reached") return null;
  return { kind, dailyUsed: num(row.daily_used), monthlyUsed: num(row.monthly_used) };
}

function capMessage(kind: ReserveKind, plan: PlanConfig, lang: Lang): string {
  if (kind === "daily_cap_reached") {
    return lang === "ro"
      ? `Ai atins limita zilnică Ask CFO AI a planului ${plan.display_name} ` +
        `(${plan.chat.daily} mesaje / zi). Se resetează la miezul nopții (UTC).`
      : `Daily Ask CFO AI limit reached for the ${plan.display_name} plan ` +
        `(${plan.chat.daily} messages / day). Resets at midnight UTC.`;
  }
  return lang === "ro"
    ? `Ai atins limita lunară Ask CFO AI a planului ${plan.display_name} ` +
      `(${plan.chat.monthly} mesaje / lună). Se resetează pe 1 ale lunii următoare (UTC).`
    : `Monthly Ask CFO AI limit reached for the ${plan.display_name} plan ` +
      `(${plan.chat.monthly} messages / month). Resets on the 1st of next month (UTC).`;
}

// ── The one model request, and what is read from its answer ─────────────

/** The body of the ONE upstream request (POST /v1/messages). */
export function buildModelRequestBody(input: ModelInput): Record<string, unknown> {
  return {
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
    messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
    output_config: { effort: "high" },
  };
}

/** A 2xx /v1/messages body → the text and the usage the app is shown. */
export function readModelResponse(data: unknown): { text: string; model: unknown; usage: ModelUsage } {
  const d = isRecord(data) ? data : {};
  const blocks = Array.isArray(d.content) ? d.content : [];
  const text = blocks
    .filter((b) => isRecord(b) && b.type === "text")
    .map((b) => (typeof (b as Record<string, unknown>).text === "string" ? ((b as Record<string, unknown>).text as string) : ""))
    .join("")
    .trim();
  const u = isRecord(d.usage) ? d.usage : {};
  return {
    text,
    model: d.model,
    usage: {
      input_tokens: num(u.input_tokens) ?? 0,
      output_tokens: num(u.output_tokens) ?? 0,
      cache_read_input_tokens: num(u.cache_read_input_tokens) ?? 0,
      cache_creation_input_tokens: num(u.cache_creation_input_tokens) ?? 0,
    },
  };
}

/** The ONLY upstream this function may be pointed at besides the real one is
 *  a loopback address — the local recorder the gate drives it with
 *  (scripts/check_chat_cap_real.sh). Anything else in
 *  CHAT_LLM_UPSTREAM_BASE_URL is ignored, so no secret set on the deployed
 *  function can send the API key to another host; production leaves the
 *  variable unset. */
export const ANTHROPIC_API_BASE = "https://api.anthropic.com";

export function resolveUpstreamBase(raw: string | undefined | null): string {
  const v = (raw ?? "").trim().replace(/\/+$/, "");
  if (!v) return ANTHROPIC_API_BASE;
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(v)
    ? v
    : ANTHROPIC_API_BASE;
}

// ── The handler ─────────────────────────────────────────────────────────

class TimedOut extends Error {
  constructor(what: string) {
    super(`${what} timed out`);
    this.name = "TimedOut";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut(what)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

export async function handleChat(deps: ChatDeps, call: ChatCall): Promise<ChatReply> {
  const log = deps.log ?? (() => {});
  const ms = deps.timeoutMs ?? METERING_TIMEOUT_MS;
  const lang = languageOf(call.body);

  // 1. NO VERIFIED USER, NO MODEL CALL.
  const bearer = bearerOf(call.authorization);
  if (!bearer) return refusal("sign_in_required", lang);
  let who: VerifyResult;
  try {
    who = await withTimeout(deps.verifyUser(bearer), ms, "verifyUser");
  } catch (e) {
    log("error", "[chat] the auth check failed — refusing", e);
    who = { kind: "unavailable" };
  }
  if (who.kind === "unavailable") return refusal("auth_unavailable", lang);
  if (who.kind !== "verified" || typeof who.userId !== "string" || !who.userId) {
    return refusal("sign_in_required", lang);
  }
  const userId = who.userId;

  // 2. The request, and the prompt it builds. Nothing is metered for a
  //    request that could never have been sent upstream.
  const parsed = parseRequest(call.body);
  if (parsed.ok === false) return { status: 400, body: { error: "invalid_request", detail: parsed.detail } };
  let system: string;
  try {
    system = buildSystemPrompt(parsed.req);
  } catch (e) {
    log("error", "[chat] the system prompt could not be built", e);
    return { status: 400, body: { error: "invalid_request", detail: "The request could not be read." } };
  }

  // No key, no model call — and so nothing to reserve. A typed 503, not an
  // "answer": until 2026-10-03 this arm returned HTTP 200 with a sentence
  // naming the missing secret and the model, which the chat stored in the
  // conversation and Explain cached as a panel's explanation.
  if (!deps.modelConfigured) {
    log("error", "[chat] ANTHROPIC_API_KEY is not set among the function's secrets — refusing (nothing reserved)");
    return refusal("ai_not_configured", lang);
  }

  // 3. The plan row. Unreadable is NOT "trial": it is "cannot meter".
  let row: SubscriptionRow | null;
  try {
    row = await withTimeout(deps.readPlan(userId), ms, "readPlan");
  } catch (e) {
    log("error", "[plan] the subscriptions row could not be read — refusing", e);
    return refusal("metering_unavailable", lang);
  }
  const plan = planForRow(deps.plans, row);

  // 4. THE cap decision: the RPC's, atomic. Nothing here reads a counter.
  const { day, month } = dayAndMonth(deps.now());
  const meter: MeterArgs = { userId, month, day };
  let decision: ReserveDecision | null;
  try {
    decision = readReserve(
      await withTimeout(
        deps.reserve({ ...meter, dailyCap: plan.chat.daily, monthlyCap: plan.chat.monthly }),
        ms,
        "reserve_user_chat",
      ),
    );
  } catch (e) {
    log("error", "[usage-gate] reserve_user_chat failed — refusing", e);
    return refusal("metering_unavailable", lang);
  }
  if (!decision) {
    log("error", "[usage-gate] reserve_user_chat returned a shape this function does not understand — refusing");
    return refusal("metering_unavailable", lang);
  }
  if (decision.kind !== "allowed") {
    return {
      status: 429,
      body: {
        error: "chat_cap_reached",
        detail: {
          code: "chat_cap_reached",
          kind: decision.kind,
          plan_key: plan.key,
          daily_used: decision.dailyUsed ?? 0,
          daily_cap: plan.chat.daily,
          monthly_used: decision.monthlyUsed ?? 0,
          monthly_cap: plan.chat.monthly,
          message: capMessage(decision.kind, plan, lang),
          upgrade_url: "/pricing",
        },
      },
    };
  }

  // 5. ONE upstream request for the ONE reservation.
  let result: ModelResult;
  let thrown: unknown = undefined;
  try {
    result = await deps.callModel({ system, messages: parsed.req.messages });
  } catch (e) {
    thrown = e;
    result = { ok: false, status: 0, errorText: String(e) };
  }

  // 6. Answered → commit, once. Failed → release, once. A meter that fails
  //    HERE cannot un-send the answer or re-send the request: it is logged.
  //    The reservation it leaves behind still counts against the cap.
  if (result.ok === false) {
    try {
      await withTimeout(deps.release(meter), ms, "release_user_chat");
    } catch (e) {
      log("error", "[usage-gate] release_user_chat failed — the reservation stays and counts against the cap", e);
    }
    const why = thrown !== undefined ? String(thrown) : `${result.status} ${result.errorText.slice(0, 300)}`;
    return {
      status: 200,
      body: { answer: `Couldn't reach Claude: ${why}. Try again in a moment.`, model: MODEL_ID, usage: null },
    };
  }

  try {
    await withTimeout(deps.commit(meter), ms, "commit_user_chat");
  } catch (e) {
    log("error", "[usage-gate] commit_user_chat failed — the answer is returned; the reservation stays and counts against the cap", e);
  }
  return { status: 200, body: { answer: result.text, model: result.model, usage: result.usage } };
}
