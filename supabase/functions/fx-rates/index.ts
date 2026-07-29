// FX reference rates — Supabase Edge Function.
//
// Ports `src/engine/api/fx_rates.py` (GET /api/fx-rates) out of the Python
// engine so display-currency conversion keeps working with `cfo-ai-backend`
// fully stopped — same move as chat-llm (root CLAUDE.md, "Milestone D").
//
// Why a proxy at all (unchanged from the Python version): bnr.ro sends no
// CORS headers, so the browser cannot fetch it directly.
//
// What changed vs the Python version: the cache is a Postgres row
// (`fx_rates_cache`, see supabase/schema_phase_fx_rates.sql) instead of a
// process-local dict. Edge instances are ephemeral — a per-instance cache
// would refetch BNR on every cold start and could hand two users different
// rates in the same minute.
//
// Response shape is byte-compatible with the engine's, so `frontend/lib/
// rates.ts` needed only a URL swap:
//   { base, rates: {EUR,RON,USD}, source, as_of, fetched_at, stale }
//
// KEEP IN SYNC: `_FALLBACK_RATES` / `_FALLBACK_AS_OF` in fx_rates.py mirror
// FALLBACK_* below, and `frontend/lib/rates.ts` carries a third copy for the
// first-paint case. Update all three when they drift materially (>5%).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── CORS ────────────────────────────────────────────────────────────────
// Mirrors chat-llm's allowlist (Edge Functions get no automatic CORS).
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
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}

// ── Constants (mirror fx_rates.py) ──────────────────────────────────────

const BNR_URL = "https://www.bnr.ro/nbrfxrates.xml";
const TTL_MS = 24 * 60 * 60 * 1000; // daily refresh
const FETCH_TIMEOUT_MS = 8000; // don't hang the request on BNR

const FALLBACK_RATES: Rates = { EUR: 1.0, RON: 4.97, USD: 1.08 };
const FALLBACK_AS_OF = "2026-05-01";

interface Rates {
  EUR: number;
  RON: number;
  USD: number;
}

interface RatesPayload {
  base: "EUR";
  rates: Rates;
  source: string;
  as_of: string;
  fetched_at: string;
  stale: boolean;
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      // Let the browser/CDN reuse a rate for an hour; the row itself is only
      // refreshed daily, so a short client cache costs nothing in freshness
      // and absorbs the "every tab on mount" fan-out.
      "Cache-Control": "public, max-age=3600",
    },
  });
}

// ── BNR parsing ─────────────────────────────────────────────────────────
//
// Document shape:
//   <DataSet><Header><PublishingDate>…</PublishingDate></Header>
//     <Body><Cube date="2026-07-26">
//       <Rate currency="EUR">5.2348</Rate>
//       <Rate currency="USD">4.5876</Rate>
//   …
//
// BNR quotes everything in RON ("1 EUR = X RON"); we normalise to "X units
// per 1 EUR" so the frontend has a single consistent base.
//
// Parsed with regex rather than an XML DOM: Deno has no built-in DOMParser,
// and this document is a flat, machine-generated list of <Rate> elements —
// pulling in an XML library for it would be more surface than the format
// warrants.

function parseBnrXml(xml: string): Omit<RatesPayload, "fetched_at" | "stale"> {
  const cube = xml.match(/<Cube\b[^>]*>([\s\S]*?)<\/Cube>/);
  if (!cube) throw new Error("BNR XML missing Cube");

  const dateMatch = xml.match(/<Cube\b[^>]*\bdate="([^"]+)"/);
  const asOf = dateMatch?.[1] ?? FALLBACK_AS_OF;

  // How many RON one unit of <currency> equals.
  const inRon: Record<string, number> = {};
  const rateRe = /<Rate\b([^>]*)>([^<]*)<\/Rate>/g;
  for (let m = rateRe.exec(cube[1]); m !== null; m = rateRe.exec(cube[1])) {
    const attrs = m[1];
    const cur = attrs.match(/\bcurrency="([^"]+)"/)?.[1];
    if (!cur) continue;
    let v = Number.parseFloat(m[2].trim());
    if (!Number.isFinite(v)) continue;
    // BNR publishes some currencies per 100 units (HUF, JPY, KRW) via a
    // `multiplier` attribute. Divide it out so every entry is per-1-unit.
    const mult = Number.parseFloat(attrs.match(/\bmultiplier="([^"]+)"/)?.[1] ?? "");
    if (Number.isFinite(mult) && mult !== 0) v = v / mult;
    inRon[cur] = v;
  }

  const oneEurInRon = inRon.EUR;
  const oneUsdInRon = inRon.USD;
  if (!Number.isFinite(oneEurInRon) || oneEurInRon <= 0) {
    throw new Error("BNR XML missing EUR rate");
  }
  if (!Number.isFinite(oneUsdInRon) || oneUsdInRon <= 0) {
    throw new Error("BNR XML missing USD rate");
  }

  return {
    base: "EUR",
    rates: { EUR: 1.0, RON: oneEurInRon, USD: oneEurInRon / oneUsdInRon },
    source: "BNR",
    as_of: asOf,
  };
}

async function fetchBnr(): Promise<Omit<RatesPayload, "fetched_at" | "stale">> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(BNR_URL, {
      headers: { "User-Agent": "cfo-ai/1.0 (+https://cfo-ai.io)" },
      signal: ctl.signal,
    });
    if (!resp.ok) throw new Error(`BNR HTTP ${resp.status}`);
    return parseBnrXml(await resp.text());
  } finally {
    clearTimeout(timer);
  }
}

// ── Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, cors);

  const forceRefresh = new URL(req.url).searchParams.get("refresh") === "true";
  const now = new Date();

  // Service role: the cache row is world-READABLE but service-role-writable
  // only, and we may need to write on this request.
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Read the shared cache row.
  let cached: RatesPayload | null = null;
  let cachedAt = 0;
  try {
    const { data } = await db
      .from("fx_rates_cache")
      .select("base, rates, source, as_of, fetched_at")
      .eq("id", "current")
      .maybeSingle();
    if (data?.rates?.EUR && data?.rates?.RON && data?.rates?.USD) {
      cachedAt = new Date(data.fetched_at).getTime();
      cached = {
        base: "EUR",
        rates: data.rates as Rates,
        source: data.source,
        as_of: data.as_of,
        fetched_at: data.fetched_at,
        stale: false,
      };
    }
  } catch (e) {
    // Table missing / migration not applied yet — fall through to BNR.
    console.warn("[fx-rates] cache read failed", e);
  }

  // 2. Fresh enough? Serve it.
  if (!forceRefresh && cached && now.getTime() - cachedAt < TTL_MS) {
    return json(cached, 200, cors);
  }

  // 3. Cache miss or TTL elapsed — try BNR.
  try {
    const fresh = await fetchBnr();
    const payload: RatesPayload = {
      ...fresh,
      base: "EUR",
      fetched_at: now.toISOString(),
      stale: false,
    };
    try {
      await db.from("fx_rates_cache").upsert(
        {
          id: "current",
          base: payload.base,
          rates: payload.rates,
          source: payload.source,
          as_of: payload.as_of,
          fetched_at: payload.fetched_at,
          updated_at: payload.fetched_at,
        },
        { onConflict: "id" },
      );
    } catch (e) {
      // A failed write only costs the next caller a refetch — still serve
      // the rate we just got rather than 500-ing on a cache-layer problem.
      console.warn("[fx-rates] cache write failed", e);
    }
    return json(payload, 200, cors);
  } catch (e) {
    console.warn("[fx-rates] BNR fetch failed; falling back", e);
  }

  // 4. BNR unreachable. Last-known-good beats the bundled constant.
  if (cached) return json({ ...cached, stale: true }, 200, cors);

  return json(
    {
      base: "EUR",
      rates: { ...FALLBACK_RATES },
      source: "fallback",
      as_of: FALLBACK_AS_OF,
      fetched_at: now.toISOString(),
      stale: true,
    } satisfies RatesPayload,
    200,
    cors,
  );
});
