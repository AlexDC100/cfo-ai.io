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
//    And the redeploy changes the prompt by the rule ALONE: with its section
//    taken out, every prompt hashes to what main's function sent (pins
//    computed from main's own builders); the CORS allowlist is the same six
//    origins and still decides the echoed origin.
//
// WHAT IT REDS ON (TC-11): the rule dropped from either persona, reworded on
// one side only, or moved after a per-request fragment (which would void the
// prompt cache); a kill switch, a second fetch, a counter read (a pre-check
// outside the RPC), a fourth RPC, or a model call outside the guard coming
// back into the function; a byte of a persona, of the currency rule or of the
// public-company block changing without its pin; an origin added to, or the
// caller's origin echoed past, the CORS allowlist.
//
// 3. THE PREFLIGHT REPORT the coordinator runs on production BEFORE the
//    deploy (supabase/preflight/chat_cap_always_preflight_report.sql). The
//    function fails closed, so a database without the three metering
//    functions turns the chat off for everyone: the report says whether they
//    are there. It is held here to the two things it describes — the SQL
//    that defines the functions and the names index.ts calls them with — and
//    to being ONE statement that only reads (the Management API returns the
//    last statement's result, as the postgres role).
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

// ── C7: the redeploy changes the prompt by the rule, and by nothing else ──
//
// Each pin is the sha256 of a system prompt as MAIN's function built it
// (supabase/functions/chat-llm/index.ts at 4a7b82bc) — computed by running
// THAT file's builders over the request, not these. With the rule's section
// taken out, this branch's prompt must hash the same: the two personas, the
// currency rule and the public-company block did not move by a byte. A
// deliberate edit of any of them changes its pin in the same commit; an
// accidental one reds here.
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

  it.each(PINNED)("workspace persona — %s", (_name, req, workspace) => {
    expect(sha256(withoutTheRule(buildWorkspaceChatSystemPrompt(req)))).toBe(workspace);
  });

  it.each(PINNED)("inventory persona — %s", (_name, req, _workspace, inventory) => {
    expect(sha256(withoutTheRule(buildChatSystemPrompt(req)))).toBe(inventory);
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

  it("the allowlist — not the caller — decides the origin that is echoed: the same six origins, and any other gets the default", () => {
    const index = code("index.ts");
    const listed = /const ALLOWED_ORIGINS = new Set\(\[([\s\S]*?)\]\);/.exec(index)?.[1] ?? "";
    expect([...listed.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([
      "https://cfo-ai.io", "https://www.cfo-ai.io", "https://cfo-ai.finance", "https://www.cfo-ai.finance", "http://localhost:5173", "http://127.0.0.1:5173",
    ]);
    expect(index).toContain('const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://cfo-ai.io";');
    // ONE place writes the header, and it writes `allow`.
    expect(count(index, "Access-Control-Allow-Origin")).toBe(1);
    expect(index).toContain('"Access-Control-Allow-Origin": allow,');
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
    // …and the file does read rows where it says it does (counts only).
    expect(count(statement, "query_to_xml(")).toBe(4);
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
