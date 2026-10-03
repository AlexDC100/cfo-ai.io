// Ask CFO AI — the request shape and the system-prompt builders.
//
// PURE: no Deno global, no network, no clock. Moved out of index.ts
// unchanged (2026-10-03) so the vitest laws can read the prompt the model
// is actually sent; index.ts is thin wiring over guard.ts.
//
// KEEP IN SYNC: the persona copy, the currency directive and the
// public-company directive were ported from src/engine/api/cfo_ai.py (that
// Python copy was deleted 2026-07-24 — this file is now the only one).

// ── Request shape (mirrors LlmChatRequest / LlmFxContext / LlmPublicCompanyContext) ─

export interface LlmChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmFxContext {
  source_currency?: string;
  display_currency?: string;
  rate?: number;
  rate_date?: string | null;
  provider?: string | null;
}

export interface LlmPublicCompanyContext {
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

export interface LlmChatRequest {
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
//
// CACHE-STABILITY AUDIT (2026-08-27) — the system block below is sent with
// cache_control: ephemeral; a single volatile byte voids the ~60% saving.
// Verified: NOTHING server-side is volatile. No Date.now()/new Date(), no
// request ids, no unordered-object serialization in any builder — todayParts()
// feeds only the usage RPCs, never the prompt. toFixed(4)/toLocaleString
// ("en-US") are deterministic. The only fragments that can differ between
// turns are CLIENT-SUPPLIED: `page` (changes if the user navigates
// mid-conversation), `fx_context.rate`/`rate_date` (changes at the daily BNR
// refresh), and `dataset_summary` (changes when the active period changes).
// Each is byte-stable across turns of a normal same-page, same-day
// conversation, so the prefix caches; when one changes, a cache re-write is
// the CORRECT behavior, not a leak. Do not add timestamps, ids, or
// JSON.stringify of unsorted objects to any builder below.
// Cache-block geometry: system is a single element, so cache_control sits on
// the LAST system element (required). Measured (2026-08-27, chars/4): the
// persona+directives alone are ~550-700 tok, so the block clears Opus's
// 1024-token caching minimum only when dataset_summary is substantial
// (>~1.5KB — real workspace snapshots are); dataset-less open-domain chats
// fall below the minimum and simply don't cache — no cost penalty, just no
// saving on those.

// ── THE STOCK-CLAIM RULE (owner spec 2026-09-26 P1.5, design B5) ─────────
//
// Until this function was redeployed the rule rode ONLY in the workspace
// snapshot (`dataset_summary`), on periods whose inventory days rest on one
// balance. It is in the system prompt now — on every call, in both personas,
// in the owner's Romanian words and their English — and the snapshot line
// stays (frontend/pages/cfo/Chat.buildWorkspaceSnapshot).
//
// The two sentences are frontend/lib/inventoryDays.STOCK_SLOW_CLAIM_RULE,
// byte for byte: the function cannot import the frontend, so the law
// (frontend/lib/__tests__/chatLlmPrompt.test.ts) holds the two copies equal
// and reds on either one changing alone.
//
// STATIC TEXT: no figure, no period, no date — the cached prefix stays
// byte-stable (the cache audit above).
export const STOCK_SLOW_CLAIM_RULE = {
  ro: "Nu descrie stocurile ca lente sau mari pe baza soldului de la o singură dată; citează împărțirea pe tipuri de stoc și media.",
  en: "Do not describe the stock as slow or high on the strength of a balance at a single date; cite the split by stock type and the average.",
} as const;

export const STOCK_CLAIM_SECTION =
  "Stock claims (non-negotiable):\n" +
  "  · " + STOCK_SLOW_CLAIM_RULE.en + " (RO: " + STOCK_SLOW_CLAIM_RULE.ro + ")\n" +
  "  · Where a snapshot carries an inventory-days section, its \"Claim " +
  "policy\" line says whether stock MAY be called slow or high for that " +
  "period. Where it does not say MAY, give the days with their basis and " +
  "say that calling stock slow or high needs the split by stock type and " +
  "an average balance.\n\n";

export function buildCurrencyDirective(
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

export function buildPublicCompanyDirective(pc: LlmPublicCompanyContext | null | undefined): string {
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

export function buildWorkspaceChatSystemPrompt(req: LlmChatRequest): string {
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
    STOCK_CLAIM_SECTION +
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

export function buildChatSystemPrompt(req: LlmChatRequest): string {
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
    STOCK_CLAIM_SECTION +
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

/** The system prompt for one request — the persona its `mode` selects. */
export function buildSystemPrompt(req: LlmChatRequest): string {
  const mode = (req.mode ?? "").trim().toLowerCase();
  return mode === "workspace" ? buildWorkspaceChatSystemPrompt(req) : buildChatSystemPrompt(req);
}
