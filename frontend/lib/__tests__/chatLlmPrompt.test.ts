// THE CHAT FUNCTION'S OWN SOURCE: the stock-claim rule is in its system
// prompt, and nothing in it can switch the cap off.
//
// 1. THE STOCK-CLAIM RULE (owner spec 2026-09-26 P1.5, design B5; CLAUDE.md
//    §25: "It stays [in the snapshot] until chat-llm is redeployed with the
//    rule in its own system prompt"). The rule is in the prompt now — both
//    personas, every call, the owner's Romanian and its English — in the
//    words frontend/lib/inventoryDays.STOCK_SLOW_CLAIM_RULE holds and the
//    snapshot law (chatSnapshotInventoryDays.test.ts) pins. The snapshot
//    line stays; that law is untouched.
//
// 2. NO SWITCH, NO SECOND DOOR — read off the function's source with the
//    comments removed: it reads five environment names and the plan
//    overrides, none of them USAGE_LIMITS_ENABLED; it makes ONE fetch; it
//    calls three RPCs and reads one table (the plan row), never a counter;
//    the model call is reachable only through guard.handleChat; the pure
//    modules touch no Deno global. The model request is ONE fetch carrying
//    the guard's deadline, pinned line for line; index.ts reads two request
//    headers (Origin, Authorization), its method and its JSON body — nothing
//    else of a request, so nothing in it can name who is metered; and module
//    scope holds constants only — nothing is remembered between requests.
//
//    And the redeploy changes the prompt by the rule ALONE: with its section
//    taken out, every prompt hashes to what main's function sent (pins
//    computed from main's own builders) — and, since the owner's order of
//    2026-10-04, by the FIGURE FORMAT: three named changes inside the
//    display-currency rule and the public-company block, each reversed by
//    name before the same pins are taken (`asMainSentIt`); a request that
//    carries no display currency and no ticker needs no reversal at all.
//    The CORS allowlist is the same six
//    origins and still decides the echoed origin — together with the ONE
//    thing the deployed function carries that main's file did not: the LAN
//    dev allowance (a private-range host on the Vite port), kept byte for
//    byte and executed here against origins it must and must not admit.
//
// WHAT IT REDS ON (TC-11): the rule dropped from either persona, reworded on
// one side only, or moved after a per-request fragment (which would void the
// prompt cache); a kill switch, a second fetch, a counter read (a pre-check
// outside the RPC), a fourth RPC, or a model call outside the guard coming
// back into the function; a loop or a second try around the model request,
// or the request sent without the deadline's signal; a third request header
// (or the URL) being read; a module-level variable or container (a bearer or
// a plan remembered across requests); a byte of a persona, of the currency rule or of the
// public-company block changing without its pin (the figure-format rule
// reworded, or one of the order's three changes drifting from what
// `asMainSentIt` reverses); an origin added to, or the
// caller's origin echoed past, the CORS allowlist; the LAN dev allowance
// dropped by the redeploy, or widened to a public address, another port or
// an unanchored match.
//
// 3. THE PREFLIGHT REPORT the coordinator runs on production BEFORE the
//    deploy (supabase/preflight/chat_cap_always_preflight_report.sql). The
//    function fails closed, so a database without the three metering
//    functions turns the chat off for everyone: the report says whether they
//    are there. It is held here to the two things it describes — the SQL
//    that defines the functions and the names index.ts calls them with — and
//    to being ONE statement that only reads (the Management API returns the
//    last statement's result, as the postgres role). And its fact about
//    the plan row and the counter tables being closed to a browser's roles
//    reads the SAME three tables the function depends on, from the catalog
//    alone.
//
// WHAT IT CANNOT SEE: what the DEPLOYED function's source is — the
// coordinator diffs the downloaded source against this tree before deploy.
// What the report ANSWERS on a database: scripts/check_chat_cap_real.py runs
// it on the local stack and on an empty database.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { STOCK_SLOW_CLAIM_RULE } from "@/lib/inventoryDays";
import {
  FIGURE_FORMAT_SECTION,
  STOCK_CLAIM_SECTION,
  STOCK_SLOW_CLAIM_RULE as FUNCTION_RULE,
  buildChatSystemPrompt,
  buildSystemPrompt,
  buildWorkspaceChatSystemPrompt,
  conversionExample,
  type LlmChatRequest,
} from "../../../supabase/functions/chat-llm/prompt";

const FN_DIR = resolve(__dirname, "../../../supabase/functions/chat-llm");
const FILES = readdirSync(FN_DIR).filter((f) => f.endsWith(".ts")).sort();
const raw = (f: string) => readFileSync(resolve(FN_DIR, f), "utf-8");

/** Source with `//` line comments and block comments removed. String
 *  contents stay: a URL's `//` is kept because only a `//` that starts a
 *  line, or follows whitespace, opens a comment in these files. */
function code(f: string): string {
  return raw(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}
const count = (hay: string, needle: string | RegExp) =>
  typeof needle === "string" ? hay.split(needle).length - 1 : (hay.match(needle) ?? []).length;

const msg = (content: string) => [{ role: "user" as const, content }];
const REQUESTS: [string, LlmChatRequest][] = [
  ["workspace, no snapshot", { messages: msg("q"), mode: "workspace" }],
  ["workspace, a snapshot", { messages: msg("q"), mode: "workspace", dataset_summary: "Period: FY2025\n  · Revenue: 1", page: "Ask CFO AI", company_name: "Invented SRL" }],
  ["workspace, FX + ticker", { messages: msg("q"), mode: "workspace", display_currency: "EUR", fx_context: { source_currency: "RON", display_currency: "EUR", rate: 0.2 }, public_company: { ticker: "AAPL" } }],
  ["inventory persona (no mode)", { messages: msg("q") }],
  ["inventory persona, a snapshot", { messages: msg("q"), mode: "inventory", dataset_summary: "42 SKUs" }],
];

describe("the stock-claim rule is in the function's system prompt", () => {
  it("the function's two sentences ARE the frontend's (the snapshot law's words), byte for byte", () => {
    expect(FUNCTION_RULE.ro).toBe(STOCK_SLOW_CLAIM_RULE.ro);
    expect(FUNCTION_RULE.en).toBe(STOCK_SLOW_CLAIM_RULE.en);
    expect(FUNCTION_RULE.ro).toBe(
      "Nu descrie stocurile ca lente sau mari pe baza soldului de la o singură dată; citează împărțirea pe tipuri de stoc și media.",
    );
  });

  it.each(REQUESTS)("%s: the prompt carries the rule once, Romanian and English, as a non-negotiable", (_name, req) => {
    const system = buildSystemPrompt(req);
    expect(count(system, STOCK_SLOW_CLAIM_RULE.en)).toBe(1);
    expect(count(system, STOCK_SLOW_CLAIM_RULE.ro)).toBe(1);
    expect(system).toContain("Stock claims (non-negotiable):\n  · " + STOCK_SLOW_CLAIM_RULE.en + " (RO: " + STOCK_SLOW_CLAIM_RULE.ro + ")\n");
    expect(system).toContain('"Claim policy" line says whether stock MAY be called slow or high');
    expect(count(system, STOCK_CLAIM_SECTION)).toBe(1);
  });

  it("both personas carry it — the chooser cannot route around it", () => {
    const req: LlmChatRequest = { messages: msg("q") };
    expect(buildWorkspaceChatSystemPrompt(req)).toContain(STOCK_CLAIM_SECTION);
    expect(buildChatSystemPrompt(req)).toContain(STOCK_CLAIM_SECTION);
    expect(buildSystemPrompt({ ...req, mode: " Workspace " })).toBe(buildWorkspaceChatSystemPrompt({ ...req, mode: " Workspace " }));
    expect(buildSystemPrompt({ ...req, mode: "anything else" })).toBe(buildChatSystemPrompt({ ...req, mode: "anything else" }));
  });

  it("the snapshot's own rule line still rides: a snapshot that carries it is forwarded whole, so the model reads the rule there too", () => {
    const line = `  · Rule: ${STOCK_SLOW_CLAIM_RULE.en} (RO: ${STOCK_SLOW_CLAIM_RULE.ro})`;
    const system = buildSystemPrompt({ messages: msg("q"), mode: "workspace", dataset_summary: `Inventory days\n${line}` });
    expect(system).toContain(line);
    expect(count(system, STOCK_SLOW_CLAIM_RULE.en)).toBe(2);
  });

  it("the rule sits in the STATIC head of the prompt: everything up to the first per-request fragment is identical across requests (the cached prefix)", () => {
    const head = (s: string) => s.slice(0, s.indexOf("\nThe operator is currently viewing the "));
    const workspace = REQUESTS.filter(([, r]) => r.mode === "workspace").map(([, r]) => head(buildSystemPrompt(r)));
    expect(new Set(workspace).size).toBe(1);
    expect(workspace[0]).toContain(STOCK_CLAIM_SECTION);
    const inventory = REQUESTS.filter(([, r]) => r.mode !== "workspace").map(([, r]) => head(buildSystemPrompt(r)));
    expect(new Set(inventory).size).toBe(1);
    expect(inventory[0]).toContain(STOCK_CLAIM_SECTION);
  });

  it("no clock and no random in the prompt builders", () => {
    const c = code("prompt.ts");
    for (const volatile of ["Date.now", "new Date", "Math.random", "crypto.", "randomUUID"]) expect(c, volatile).not.toContain(volatile);
  });
});

// ── C7: the redeploy changes the prompt by the rule, and by nothing else ──
//
// Each pin is the sha256 of a system prompt as MAIN's function built it
// (supabase/functions/chat-llm/index.ts at 4a7b82bc) — computed by running
// THAT file's builders over the request, not these. With the rule's section
// taken out, this branch's prompt must hash the same: the two personas, the
// currency rule and the public-company block did not move by a byte. A
// deliberate edit of any of them changes its pin in the same commit; an
// accidental one reds here.
//
// MOVED ON PURPOSE (owner order 2026-10-04: "make chat … write numbers in
// Romanian format in Romanian text …, currency after the figure. Use the
// product's own formatting standard, with a gate"). NO PIN VALUE MOVED. The
// order changed three things, all inside fragments only Ask CFO AI's request
// (a display currency) or a ticker's request carries; `asMainSentIt` takes
// each back out BY NAME and the result must still hash to main's:
//   1. the figure-format rule — FIGURE_FORMAT_SECTION, present exactly once
//      when the request carries a display currency, never otherwise (its own
//      bytes are pinned below: rewording the rule moves that pin);
//   2. the conversion note — the old line TAUGHT the wrong shape
//      (`e.g. "~EUR 918k (converted from RON 4.58M at BNR rate)"`: the code
//      before the figure, an English magnitude whatever the language of the
//      answer); it is `conversionExample(...)` now, in both languages, in the
//      product's own prints;
//   3. the public-company block — "USD 1,000" became "1,000 USD".
// The personas were not touched: the "bare" and the "live ticker, no
// figures" requests hash to main's with no reversal at all, and the law says
// so (`reversed` is false for them).
describe("apart from the rule, the system prompt is byte for byte what the function sent before", () => {
  const q = msg("q");
  const PINNED: [string, LlmChatRequest, string, string][] = [
    ["bare", { messages: q },
      "458406798779609bf5d4160250fc25c1b94e5e17287fd629ca37d67b29268906",
      "12a682036a0d0707f3ae1e933b8facaaba5be596800754cfeebe237b1b074a64"],
    ["a snapshot, a converted currency, a demo ticker with every figure", {
      messages: q, page: "Ask CFO AI", company_name: "Invented SRL",
      dataset_summary: "Period: FY2025\n  · Revenue: 1", display_currency: "EUR",
      fx_context: { source_currency: "RON", display_currency: "EUR", rate: 0.2011, rate_date: "2026-10-02", provider: "BNR" },
      public_company: {
        ticker: "AAPL", company_name: "Apple Inc.", sector: "Technology", industry: "Consumer Electronics", exchange: "NASDAQ", currency: "USD",
        latest_period: "FY2024", latest_period_end: "2024-09-28", revenue: 1000, ebitda: 300, net_income: 200, total_assets: 5000, total_equity: 2000, cash: 400,
        net_debt: 100, free_cash_flow: 250, market_cap: 9000, enterprise_value: 9100, pe_ratio: 30.5, ev_to_ebitda: 22.25, ebitda_margin: 30, net_margin: 20, roe: 10,
        net_debt_to_ebitda: 0.33, source: "demo",
      },
    },
      "c9e698941905efb503b77029bce1e7a76d335a2071beeba9763e543d6ac82e81",
      "da98069d9462283cfeb5a6f33dae550136f7e7841c3d283be0791e4eecd50ed1"],
    ["the display currency is the stored one", { messages: q, display_currency: "ron" },
      "13cf069e938ba211f54c8262bdab96d8079389244c0e711153355cb6a35a8342",
      "160219c06083f8318884649c2518b90f839b146d0b8ecfd6c2b27d4735f29d48"],
    ["a live ticker with no figures", { messages: q, public_company: { ticker: "MSFT", source: "nasdaq" } },
      "c0547ade4e81a7dc31231e0a5e4545a35907d0ff19db0e9adb1120461c28e806",
      "4a5a4f0463eecab8947a76ae5a3af19c6334c2cab6371c0dc212af93b924166d"],
  ];
  const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
  const withoutTheRule = (prompt: string) => {
    expect(count(prompt, STOCK_CLAIM_SECTION)).toBe(1); // …the one thing that IS new
    return prompt.replace(STOCK_CLAIM_SECTION, "");
  };
  /** The prompt with the order's three changes taken back out — what main's
   *  function sent for this request. Each step checks that the thing it
   *  removes is there exactly as often as the request says it must be. */
  const asMainSentIt = (prompt: string, req: LlmChatRequest): { prompt: string; reversed: boolean } => {
    let p = withoutTheRule(prompt);
    const before = p;
    // 1. the figure-format rule: once iff the request names a display currency.
    const carriesCurrency = !!(req.display_currency || req.fx_context);
    expect(count(p, FIGURE_FORMAT_SECTION)).toBe(carriesCurrency ? 1 : 0);
    p = p.replace(FIGURE_FORMAT_SECTION, "");
    // 2. the conversion note (only where display ≠ stored): back to the legacy literal.
    const fx = req.fx_context;
    if (fx) {
      const display = (fx.display_currency || req.display_currency || "").toUpperCase();
      const source = (fx.source_currency || "RON").toUpperCase();
      const provider = fx.provider || "BNR";
      const now = "briefly — " + conversionExample(display, source, provider) + ".\n";
      expect(count(p, now)).toBe(display === source ? 0 : 1);
      p = p.replace(now, `briefly, e.g. "~${display} 918k (converted from ${source} 4.58M at ${provider} rate)".\n`);
    }
    // 3. the public-company block: "N USD" back to "USD N".
    const from = p.indexOf("=== Public-company context ==="), to = p.indexOf("=== End public-company context ===");
    if (from >= 0) p = p.slice(0, from) + p.slice(from, to).replace(/(\d[\d,]*) USD\b/g, "USD $1") + p.slice(to);
    return { prompt: p, reversed: p !== before };
  };
  /** Which pinned requests the order touched at all: a display currency, or a ticker WITH figures. */
  const TOUCHED = new Set(["a snapshot, a converted currency, a demo ticker with every figure", "the display currency is the stored one"]);

  it.each(PINNED)("workspace persona — %s", (name, req, workspace) => {
    const main = asMainSentIt(buildWorkspaceChatSystemPrompt(req), req);
    expect(sha256(main.prompt)).toBe(workspace);
    expect(main.reversed).toBe(TOUCHED.has(name));
  });

  it.each(PINNED)("inventory persona — %s", (name, req, _workspace, inventory) => {
    const main = asMainSentIt(buildChatSystemPrompt(req), req);
    expect(sha256(main.prompt)).toBe(inventory);
    expect(main.reversed).toBe(TOUCHED.has(name));
  });

  it("the figure-format rule's own bytes are pinned: rewording it moves this hash on purpose", () => {
    // MOVED ON PURPOSE 2026-10-05 (was 121639d7…, length 1090): the two example
    // ratios of the section were a real company's, read off a live screen, and
    // this repository is public. They are invented ones now (8,75% / 2,35×) —
    // the same shapes, two characters shorter in all. Nothing else of the
    // section changed.
    expect(sha256(FIGURE_FORMAT_SECTION)).toBe("94250ebc3095913624f67f1694fd9cc164373b2790b51a925c0c0ad7010a6671");
    expect(FIGURE_FORMAT_SECTION.length).toBe(1088);
    expect(FIGURE_FORMAT_SECTION.startsWith("Figure format (non-negotiable):\n")).toBe(true);
  });

  it("the old conversion note — the shape production printed on 2026-10-04 — is in no prompt the function builds", () => {
    for (const [, req] of PINNED) {
      for (const p of [buildWorkspaceChatSystemPrompt(req), buildChatSystemPrompt(req)]) {
        expect(p).not.toMatch(/e\.g\. "~[A-Z]{3} 918k|converted from [A-Z]{3} 4\.58M|USD \d/);
      }
    }
  });
});

describe("no switch, no second door — the function's source", () => {
  it("POSITIVE CONTROL: the function is these four files, and the comment stripper keeps code and URLs", () => {
    expect(FILES).toEqual(["guard.ts", "index.ts", "plans.ts", "prompt.ts"]);
    // eslint-disable-next-line no-console
    console.log(`GATE-WORK chat-cap-always function-files=${FILES.length} code-lines=${FILES.reduce((n, f) => n + code(f).split("\n").filter((l) => l.trim()).length, 0)}`);
    expect(code("guard.ts")).toContain('"https://api.anthropic.com"');
    expect(code("index.ts")).toContain("Deno.serve(");
    expect(raw("guard.ts")).toContain("USAGE_LIMITS_ENABLED"); // …it IS named, in the comment that says it is gone
    expect(code("index.ts")).not.toContain("THE CAP IS ALWAYS ENFORCED"); // …and comments are really stripped
  });

  it("nothing reads USAGE_LIMITS_ENABLED: the cap has no off switch", () => {
    for (const f of FILES) {
      expect(code(f), f).not.toContain("USAGE_LIMITS_ENABLED");
      expect(code(f), f).not.toMatch(/enforcementEnabled|limitsEnabled|"disabled"/);
    }
  });

  it("the environment the function reads is exactly: three Supabase values, the model key, the loopback upstream override, and the plan overrides", () => {
    const named = [...code("index.ts").matchAll(/Deno\.env\.get\(\s*"([A-Z0-9_]+)"\s*\)/g)].map((m) => m[1]).sort();
    expect(named).toEqual(["ANTHROPIC_API_KEY", "CHAT_LLM_UPSTREAM_BASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL"]);
    // The one dynamic read is the plan table's (PRICING_CHAT_* names only — chatLlmPlans.test.ts).
    expect(count(code("index.ts"), "Deno.env")).toBe(named.length + 1);
    expect(code("index.ts")).toContain("buildPlans((name) => Deno.env.get(name))");
    const planNames = [...code("plans.ts").matchAll(/envInt\("([A-Z0-9_]+)"/g)].map((m) => m[1]);
    expect(planNames.length).toBe(10);
    for (const n of planNames) expect(n).toMatch(/^PRICING_CHAT_(DAILY|MONTHLY)_CAP_(TRIAL|INTRO|SOLO|PRO|MULTI)$/);
  });

  it("the pure modules touch no Deno global, import no package and make no request", () => {
    for (const f of ["guard.ts", "plans.ts", "prompt.ts"]) {
      const c = code(f);
      expect(c, f).not.toMatch(/\bDeno\b/);
      expect(c, f).not.toMatch(/from\s+"(npm:|jsr:|https?:)/);
      expect(c, f).not.toMatch(/\bfetch\s*\(/);
      for (const imp of [...c.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])) expect(imp, f).toMatch(/^\.\/(guard|plans|prompt)\.ts$/);
    }
  });

  it("ONE fetch in the whole function — the model request — and it is reachable only through the guard", () => {
    const all = FILES.map(code).join("\n");
    expect(count(all, /\bfetch\s*\(/g)).toBe(1);
    const index = code("index.ts");
    expect(index).toContain("fetch(`${UPSTREAM_BASE}/v1/messages`");
    // callModel: its definition, and ONE use — inside the dependencies handed to handleChat.
    expect(count(index, /\bcallModel\(/g)).toBe(2);
    expect(index).toMatch(/await handleChat\(\s*\{[\s\S]*callModel: \(input, signal\) => callModel\(ANTHROPIC_API_KEY as string, input, signal\),[\s\S]*\},\s*\{ authorization: req\.headers\.get\("authorization"\), body \},\s*\)/);
    expect(count(index, "handleChat(")).toBe(1);
    // No retry loop around the model call, and no SDK underneath that would retry on its own.
    expect(all).not.toMatch(/@anthropic-ai\/sdk|maxRetries|max_retries/);
  });

  // MEASURED 2026-10-04, each planted alone in index.ts: a retry on a 5xx
  // inside the one `fetch(` left this gate green (only the real gate saw it —
  // and that gate is vacuous without the stack); and with no deadline a hung
  // upstream held the reservation until the platform cut the function off.
  it("the model request is these lines and nothing else: ONE fetch carrying the guard's deadline — no loop, no second try, no timer of its own", () => {
    const index = code("index.ts");
    const fn = /async function callModel\([\s\S]*?\n}\n/.exec(index)?.[0] ?? "";
    expect(fn).toBe(
      [
        "async function callModel(apiKey: string, input: ModelInput, signal: AbortSignal): Promise<ModelResult> {",
        "  const resp = await fetch(`${UPSTREAM_BASE}/v1/messages`, {",
        '    method: "POST",',
        "    headers: {",
        '      "x-api-key": apiKey,',
        '      "anthropic-version": "2023-06-01",',
        '      "content-type": "application/json",',
        "    },",
        "    body: JSON.stringify(buildModelRequestBody(input)),",
        "    signal,",
        "  });",
        "  if (!resp.ok) return { ok: false, status: resp.status, errorText: await resp.text() };",
        "  return { ok: true, ...readModelResponse(await resp.json()) };",
        "}",
        "",
      ].join("\n"),
    );
    // No loop anywhere in the wiring; the deadline is guard.ts's alone.
    expect(index).not.toMatch(/\b(for|while|do)\s*[({]/);
    expect(index).not.toMatch(/setTimeout|setInterval|AbortSignal\.|new AbortController|\.catch\s*\(|retry/i);
    // guard.ts: the ONE place the model is called — once, under the deadline, the signal handed over.
    const guard = code("guard.ts");
    expect(count(guard, "deps.callModel(")).toBe(1);
    expect(guard).toMatch(
      /result = await withTimeout\(\s*deps\.callModel\(\{ system, messages: parsed\.req\.messages \}, deadline\.signal\),\s*deps\.modelTimeoutMs \?\? MODEL_TIMEOUT_MS,\s*"the model request",\s*\(e\) => deadline\.abort\(e\),\s*\);/,
    );
    expect(guard).toContain("export const MODEL_TIMEOUT_MS = 100_000;");
  });

  // MEASURED 2026-10-04, planted alone: index.ts reading the plan row for an
  // id the caller put in a header (a trial user on a paying user's caps) left
  // both gates green.
  it("index.ts reads two request headers — Origin and Authorization — its method and its JSON body, and nothing else of a request: who is metered is never the request's to say", () => {
    const index = code("index.ts");
    expect([...index.matchAll(/\breq\.(\w+)/g)].map((m) => m[1]).sort()).toEqual(["headers", "headers", "json", "method", "method"]);
    expect([...index.matchAll(/req\.headers\.get\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1])).toEqual(["origin", "authorization"]);
    expect(count(index, /\breq\b/g)).toBe(6); // the handler's parameter and those five reads: the request is handed to nothing else
    expect(index).not.toMatch(/\bURL\b|searchParams|\.url\b|\bcookie\b/i);
    // The plan row is read for the id guard.ts hands over, and metered under the same one.
    expect(index).toContain("readPlan: (userId) => readPlan(admin, userId),");
    expect(count(index, /\breadPlan\(/g)).toBe(2); // its definition, and that one use
    expect(index).toContain("const meterPayload = (a: MeterArgs) => ({ p_user_id: a.userId, p_month: a.month, p_day: a.day });");
    // …and in guard.ts that id has ONE source: the auth server's answer.
    const guard = code("guard.ts");
    expect(guard).toContain("const userId = who.userId;");
    expect(count(guard, /\buserId\s*=[^=]/g)).toBe(1);
    expect(guard).toContain("deps.readPlan(userId)");
    expect(guard).toContain("const meter: MeterArgs = { userId, month, day };");
  });

  // MEASURED 2026-10-04, planted alone: index.ts remembering a bearer once it
  // had verified (a deleted or signed-out user's token kept working in a warm
  // instance) left both gates green.
  it("nothing is remembered between requests: module scope holds constants only — no variable, no container, nothing a request could write to", () => {
    const index = code("index.ts");
    const top = [...index.matchAll(/^(?:export\s+)?(const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(top).toEqual([
      "const SUPABASE_URL", "const SERVICE_ROLE_KEY", "const ANON_KEY", "const ANTHROPIC_API_KEY", "const UPSTREAM_BASE", "const PLANS", "const SERVER_AUTH",
      "const ALLOWED_ORIGINS", "const LAN_DEV_ORIGIN", "function corsHeaders", "function json",
      "async function verifyUser", "async function readPlan", "async function rpc", "const meterPayload", "async function callModel",
    ]);
    expect(index).not.toMatch(/new (Map|WeakMap|WeakSet|WeakRef)\b|globalThis|\bcaches\b|openKv|localStorage|sessionStorage|\?\?=|\|\|=/);
    expect(count(index, /new Set\(/g)).toBe(1); // the CORS allowlist — and nothing is ever added to it:
    expect(index).not.toMatch(/\.(set|add|push|unshift|splice|delete)\s*\(/);
    for (const [name, uses] of [["ALLOWED_ORIGINS", 2], ["PLANS", 2], ["SERVER_AUTH", 3], ["UPSTREAM_BASE", 2], ["ANTHROPIC_API_KEY", 4]] as const) {
      expect(count(index, new RegExp(`\\b${name}\\b`, "g")), name).toBe(uses);
    }
    // The pure modules: no module-level variable and no container either.
    for (const f of ["guard.ts", "plans.ts", "prompt.ts"]) {
      const c = code(f);
      expect(c, f).not.toMatch(/^(?:export\s+)?(let|var)\s/m);
      expect(c, f).not.toMatch(/new (Map|WeakMap|WeakSet|WeakRef)\b|globalThis|\?\?=|\|\|=/);
    }
  });

  it("the function never reads a usage counter: it calls three RPCs and reads one table — the plan row", () => {
    const all = FILES.map(code).join("\n");
    for (const counter of ["user_usage", "plan_chat_daily_usage", "llm_calls"]) expect(all, counter).not.toContain(counter);
    const rpcs = [...code("index.ts").matchAll(/rpc\(admin, "([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(rpcs).toEqual(["commit_user_chat", "release_user_chat", "reserve_user_chat"]);
    expect(count(code("index.ts"), ".rpc(")).toBe(1); // the one helper they all go through
    const tables = [...all.matchAll(/\.from\(\s*"([a-z_]+)"\s*\)/g)].map((m) => m[1]);
    expect(tables).toEqual(["subscriptions"]);
    expect(code("index.ts")).toMatch(/\.from\("subscriptions"\)\s*\.select\("tier, plan"\)\s*\.eq\("user_id", userId\)\s*\.maybeSingle\(\)/);
    expect(all).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
  });

  it("a read or an RPC that errors THROWS — it is never turned into null and carried on", () => {
    const index = code("index.ts");
    expect(index).toContain("if (error) throw new Error(`subscriptions read failed: ${error.message}`);");
    expect(index).toContain("if (error) throw new Error(`RPC ${name} failed: ${error.message}`);");
    expect(index).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*return null/);
  });

  it("the CORS preflight is answered as it always was, and only POST goes further", () => {
    const index = code("index.ts");
    expect(index).toContain('if (req.method === "OPTIONS") {\n    return new Response(null, { headers: cors });\n  }');
    expect(index).toContain('if (req.method !== "POST") {\n    return json({ detail: "Method not allowed" }, 405, cors);\n  }');
    expect(index).toContain('"authorization, x-client-info, apikey, content-type, x-org-id"');
    for (const origin of ["https://cfo-ai.io", "https://www.cfo-ai.io", "https://cfo-ai.finance", "https://www.cfo-ai.finance", "http://localhost:5173", "http://127.0.0.1:5173"]) {
      expect(index).toContain(`"${origin}"`);
    }
  });

  it("the allowlist — not the caller — decides the origin that is echoed: the same six origins, and any other gets the default", () => {
    const index = code("index.ts");
    const listed = /const ALLOWED_ORIGINS = new Set\(\[([\s\S]*?)\]\);/.exec(index)?.[1] ?? "";
    expect([...listed.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([
      "https://cfo-ai.io", "https://www.cfo-ai.io", "https://cfo-ai.finance", "https://www.cfo-ai.finance", "http://localhost:5173", "http://127.0.0.1:5173",
    ]);
    // The ONE line that decides: a listed origin, or the LAN dev pattern
    // (next law) — the caller's own origin is never taken on its word.
    expect(index).toContain('const allow = origin && (ALLOWED_ORIGINS.has(origin) || LAN_DEV_ORIGIN.test(origin)) ? origin : "https://cfo-ai.io";');
    expect(count(index, /\ballow\s*=/g)).toBe(1);
    // ONE place writes the header, and it writes `allow`.
    expect(count(index, "Access-Control-Allow-Origin")).toBe(1);
    expect(index).toContain('"Access-Control-Allow-Origin": allow,');
  });

  // THE DEPLOYED FUNCTION CARRIES ONE THING MAIN'S FILE DID NOT (read off
  // the downloaded source, 2026-10-04): a CORS allowance for the iOS shell's
  // LAN dev server — a private-range host on the Vite port. The redeploy
  // KEEPS it (dropping it breaks chat in the shell's LAN dev build) and
  // widens it by nothing: the pattern is read off index.ts and EXECUTED.
  it("the LAN dev allowance the deployed function carries is kept, byte for byte — a private-range host on :5173 and nothing else", () => {
    const index = raw("index.ts");
    const literal = /^const LAN_DEV_ORIGIN = \/(.+)\/;$/m.exec(index)?.[1] ?? "";
    expect(literal).toBe(
      String.raw`^http:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):5173$`,
    );
    expect(count(code("index.ts"), "LAN_DEV_ORIGIN")).toBe(2); // its definition, and the one line that decides
    const lan = new RegExp(literal);
    for (const yes of [
      "http://10.0.0.5:5173", "http://10.255.255.255:5173", "http://192.168.1.20:5173", "http://192.168.0.1:5173",
      "http://172.16.0.1:5173", "http://172.20.10.2:5173", "http://172.31.255.255:5173",
    ]) expect(lan.test(yes), yes).toBe(true);
    for (const no of [
      "https://10.0.0.5:5173",             // not the dev server's scheme
      "http://10.0.0.5:5174",              // another port
      "http://10.0.0.5:51730",
      "http://10.0.0.5",                   // no port
      "http://10.0.0.5:5173/",             // an origin has no path
      "http://10.0.0.5:5173.evil.example", // a suffix
      "http://evil.example/http://10.0.0.5:5173",
      "http://evil.example:5173",          // a name, not a private address
      "http://10.0.0.5.evil.example:5173",
      "http://11.0.0.5:5173",              // public ranges, on the Vite port
      "http://8.8.8.8:5173",
      "http://172.15.0.1:5173",
      "http://172.32.0.1:5173",
      "http://192.169.1.1:5173",
      "http://169.254.1.1:5173",
      "http://localhost:5174",
      "http://[::1]:5173",
      "null",
      "",
    ]) expect(lan.test(no), no).toBe(false);
  });
});

describe("the preflight report the coordinator runs before the deploy", () => {
  const REPO = resolve(__dirname, "../../..");
  const REPORT = readFileSync(resolve(REPO, "supabase/preflight/chat_cap_always_preflight_report.sql"), "utf-8");
  const ATOMIC = readFileSync(resolve(REPO, "supabase/schema_phase_pricing_v3_atomic.sql"), "utf-8");
  /** The file without its `--` comments. */
  const statement = REPORT.split("\n").map((l) => l.split("--")[0]).join("\n").trim();
  /** The rows of the report's `want` list: name → signature types, argument names, md5. */
  const wanted = Object.fromEntries(
    [...statement.matchAll(/\('(\w+)',\s*'public\.(\w+)\(([^)]*)\)',\s*array\[([^\]]*)\],\s*'([0-9a-f]{32})'\)/g)].map((m) => [
      m[1],
      { fn: m[2], types: m[3].split(",").map((t) => t.trim()), args: [...m[4].matchAll(/'(\w+)'/g)].map((a) => a[1]), md5: m[5] },
    ]),
  );
  const NAMES = ["commit_user_chat", "release_user_chat", "reserve_user_chat"];
  /** A function as supabase/schema_phase_pricing_v3_atomic.sql defines it. */
  function defined(name: string): { args: string[]; types: string[]; md5: string } {
    const m = new RegExp(`create or replace function ${name}\\(([\\s\\S]*?)\\) returns jsonb[\\s\\S]*?\\nas \\$\\$([\\s\\S]*?)\\$\\$;`).exec(ATOMIC);
    if (!m) throw new Error(`${name} is not defined in the SQL`);
    const params = m[1].split("\n").map((l) => l.split("--")[0].trim().replace(/,$/, "")).filter(Boolean).map((l) => l.split(/\s+/));
    return {
      args: params.map((p) => p[0]),
      types: params.map((p) => (p[1] === "int" ? "integer" : p[1])),
      md5: createHash("md5").update(m[2], "utf8").digest("hex"),
    };
  }

  it("it is ONE statement and it only reads: nothing in it writes, locks, sets or notifies", () => {
    expect(statement.slice(0, 4).toLowerCase()).toBe("with");
    expect(statement.endsWith(";")).toBe(true);
    expect(count(statement, ";")).toBe(1);
    const writes =
      /\b(insert|update|delete|truncate|merge|alter|create|drop|grant|revoke|notify|listen|lock|copy|call|do|vacuum|analyze|refresh|reindex|cluster|comment|set|reset|begin|commit|rollback|prepare|set_config|nextval|setval|pg_notify|pg_sleep|pg_advisory\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|dblink\w*|lo_\w+)\b|\bfor\s+(update|share|no\s+key)\b|\binto\b/gi;
    expect(statement.match(writes) ?? []).toEqual([]);
    // POSITIVE CONTROL: the scanner sees a write when one is there.
    expect("select set_config('x','y',true)".match(writes)).toEqual(["set_config"]);
    expect("select 1 from t for update".match(writes)).toEqual(["for update"]);
    // …and the file does read rows where it says it does (counts only):
    // the stored keys, users with no row, users with MORE than one row (the
    // function refuses those: its plan read is one row per user), and the
    // day's and the month's counters.
    expect(count(statement, "query_to_xml(")).toBe(5);
    for (const key of ["rows_by_stored_key", "users_without_a_row", "users_with_more_than_one_row", "daily_rows_today", "monthly_rows_this_month"]) {
      expect(count(statement, `'${key}'`), key).toBe(1);
    }
  });

  // MEASURED 2026-10-04 on the local stack: the report answered ready and
  // meter_closed_to_browser_roles true while a trial user at the cap raised
  // their own tier with their own session and was served — it looked at the
  // three FUNCTIONS only. What the fact ANSWERS, shape by shape, is the real
  // gate's (a scratch database); here: that it is there, reads the catalog
  // alone, and looks at the same three tables the function depends on.
  it("it says whether a browser's roles can write the plan row or the counters — one fact over the SAME three tables, read from the catalog alone", () => {
    for (const key of ["plan_and_counters_closed_to_browser_roles", "browser_role_row_writes", "browser_role_truncate_grants", "row_security"]) {
      expect(count(statement, `'${key}'`), key).toBe(1);
    }
    // The doors are computed over `tbl` — the list `ready` is computed over — for the two browser roles…
    const door = /\bdoor as \(([\s\S]*?)\n\),\nblocking as/.exec(statement)?.[1] ?? "";
    expect(door).toContain("from tbl t");
    expect(door).toContain("cross join browser b");
    expect(statement).toContain("where r.rolname in ('anon', 'authenticated')");
    // …for each of the three row-writing privileges (spelled in halves: the file carries no write keyword)…
    expect(statement).toContain("values ('INS' || 'ERT', 'a'), ('UPD' || 'ATE', 'w'), ('DEL' || 'ETE', 'd')");
    // …a privilege on the table or on any column, and row security off, bypassed, or a PERMISSIVE policy for that command or for all.
    expect(door).toContain("has_table_privilege(b.oid, k.oid, w.priv)");
    expect(door).toContain("has_any_column_privilege(b.oid, k.oid, w.priv)");
    expect(count(door, "not k.relrowsecurity")).toBe(2);
    expect(count(door, "p.polpermissive")).toBe(2);
    expect(count(door, "p.polcmd::text in (w.polcmd, '*')")).toBe(2);
    // "closed" is: no door — and null, not true, where a table is missing.
    expect(statement).toMatch(/'plan_and_counters_closed_to_browser_roles', case\s+when exists \(select 1 from tbl_facts where not present\) then null\s+else not exists \(select 1 from door\) end,/);
    // It reads no ROW for this: the five row reads are the five counted ones.
    expect(door).not.toContain("query_to_xml");
    expect(count(statement, "query_to_xml(")).toBe(5);
  });

  it("its three md5 literals ARE the function bodies in schema_phase_pricing_v3_atomic.sql, and its signatures are that file's", () => {
    expect(Object.keys(wanted).sort()).toEqual(NAMES);
    for (const n of NAMES) {
      const d = defined(n);
      expect(wanted[n].fn, n).toBe(n);
      expect(wanted[n].md5, n).toBe(d.md5);
      expect(wanted[n].types, n).toEqual(d.types);
      expect(wanted[n].args, n).toEqual(d.args);
    }
  });

  it("the argument names it requires are the ones index.ts calls the functions with — and the tables it checks are the ones those functions use", () => {
    const index = code("index.ts");
    const meter = [...(/const meterPayload = \(a: MeterArgs\) => \(\{([^}]*)\}\)/.exec(index)?.[1] ?? "").matchAll(/\b(p_[a-z_]+):/g)].map((m) => m[1]);
    expect(meter).toEqual(["p_user_id", "p_month", "p_day"]);
    const reserveBlock = /rpc\(admin, "reserve_user_chat", \{([\s\S]*?)\}\)/.exec(index)?.[1] ?? "";
    expect(reserveBlock).toContain("...meterPayload(a)");
    const reserve = [...meter, ...[...reserveBlock.matchAll(/\b(p_[a-z_]+):/g)].map((m) => m[1])];
    expect(wanted.commit_user_chat.args).toEqual(meter);
    expect(wanted.release_user_chat.args).toEqual(meter);
    expect(wanted.reserve_user_chat.args).toEqual(reserve);
    // The plan row's columns are the ones index.ts selects; the two counter
    // tables and their columns are the ones the three bodies name.
    expect(statement).toContain("('public.subscriptions',          array['user_id', 'tier', 'plan'])");
    for (const [table, cols] of [["user_usage", ["user_id", "month", "llm_calls", "llm_calls_reserved"]], ["plan_chat_daily_usage", ["user_id", "day", "count", "reserved", "updated_at"]]] as const) {
      expect(statement).toMatch(new RegExp(`\\('public\\.${table}',\\s*array\\[${cols.map((c) => `'${c}'`).join(", ")}\\]\\)`));
      const bodies = NAMES.map((n) => new RegExp(`create or replace function ${n}\\([\\s\\S]*?\\nas \\$\\$([\\s\\S]*?)\\$\\$;`).exec(ATOMIC)?.[1] ?? "").join("\n");
      const tableStatements = bodies.split(";").filter((st) => new RegExp(`\\b${table}\\b`).test(st)).join(";");
      expect(tableStatements.length, table).toBeGreaterThan(0);
      for (const c of cols) expect(tableStatements, `${table}.${c}`).toMatch(new RegExp(`\\b${c}\\b`));
    }
  });
});
