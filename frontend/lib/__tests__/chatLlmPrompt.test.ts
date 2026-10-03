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
//    modules touch no Deno global.
//
// WHAT IT REDS ON (TC-11): the rule dropped from either persona, reworded on
// one side only, or moved after a per-request fragment (which would void the
// prompt cache); a kill switch, a second fetch, a counter read (a pre-check
// outside the RPC), a fourth RPC, or a model call outside the guard coming
// back into the function.
//
// WHAT IT CANNOT SEE: what the DEPLOYED function's source is — the
// coordinator diffs the downloaded source against this tree before deploy.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { STOCK_SLOW_CLAIM_RULE } from "@/lib/inventoryDays";
import {
  STOCK_CLAIM_SECTION,
  STOCK_SLOW_CLAIM_RULE as FUNCTION_RULE,
  buildChatSystemPrompt,
  buildSystemPrompt,
  buildWorkspaceChatSystemPrompt,
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
    expect(index).toMatch(/await handleChat\(\s*\{[\s\S]*callModel: \(input\) => callModel\(ANTHROPIC_API_KEY as string, input\)[\s\S]*\},\s*\{ authorization: req\.headers\.get\("authorization"\), body \},\s*\)/);
    expect(count(index, "handleChat(")).toBe(1);
    // No retry loop around the model call, and no SDK underneath that would retry on its own.
    expect(all).not.toMatch(/@anthropic-ai\/sdk|maxRetries|max_retries/);
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
});
