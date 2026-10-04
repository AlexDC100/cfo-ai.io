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
// Response shape is byte-compatible with the engine's:
//   { base, rates: {EUR,RON,USD}, source, as_of, fetched_at, stale }
// `stale: true` means "not a BNR file accepted inside the 24 h window" — the
// last cached row after BNR stopped answering, or the bundled fallback.
// `frontend/lib/rates.ts` asks the engine as well whenever it reads that.
//
// THIS FILE IS THE WIRING ONLY: the HTTP method, the CORS allowlist, the
// Cache-Control header and the three statements that touch the row.
// Everything that can be wrong about the feed — the address list, the parser,
// the plausibility bounds, the freshness rule, the fallback constants, when
// BNR may be asked again, and the order in which a request reads the row,
// asks BNR and writes the row (`resolveRates`) — lives in `./bnr.ts`, which
// has no Deno global and is run by the gate `fx-browser` on BNR's own bytes.
// Until 2026-10-03 all of it sat inside `Deno.serve`, no test could reach it,
// and the one address it knew had been dead for two months (see bnr.ts).
//
// THE FAILURE COOLDOWN, AND WHERE IT IS KEPT. `fx_rates_cache` holds exactly
// one row (`check (id = 'current')`), so there is no second row to write a
// failure into without a migration. The row's `updated_at` is used instead:
// a success writes `fetched_at = updated_at = now`; a FAILED attempt touches
// `updated_at` alone. "BNR was last asked at" is therefore
// max(fetched_at, updated_at), shared by every instance. When there is no row
// yet (BNR has never answered this project) there is nothing to touch, and
// the cooldown falls back to a timestamp in this instance's memory — one
// attempt per window per instance, not per project. The same memory holds the
// last file this instance accepted, so a row that cannot be read or written
// does not turn every request into a BNR fetch. No migration either way.
//
// REDEPLOY (the CLI must be signed in) — docs/engine_book/gates.md,
// "fx-browser", carries the command and the before/after probe:
//   supabase functions deploy fx-rates --project-ref <ref> --use-api --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  newInstanceMemory,
  resolveRates,
  type CacheRow,
  type FeedFetch,
  type RatesPayload,
  type RatesStore,
} from "./bnr.ts";

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

function json(body: RatesPayload | { error: string }, status: number, cors: Record<string, string>): Response {
  // A CURRENT rate may be reused by the browser/CDN for an hour (the row is
  // refreshed daily; this absorbs the "every tab on mount" fan-out). A STALE
  // answer must not be: the moment BNR answers again, the next request should
  // see it — an hour of browser cache on a stale payload is an hour of the
  // wrong rate after the repair.
  const fresh = "stale" in body && body.stale === false;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": fresh ? "public, max-age=3600" : "no-store",
    },
  });
}

/** This instance's memory of its last attempt and its last accepted file —
 *  the cooldown's and the cache's fallback when the row cannot carry them
 *  (see the header). */
const memory = newInstanceMemory();

// ── Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, cors);

  // Service role: the cache row is world-READABLE but service-role-writable
  // only, and this request may need to write it.
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // supabase-js reports a failed statement in `error` and does not throw;
  // each of the three raises it so `resolveRates` logs it and carries on.
  const store: RatesStore = {
    async read() {
      const { data, error } = await db
        .from("fx_rates_cache")
        .select("base, rates, source, as_of, fetched_at, updated_at")
        .eq("id", "current")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data ?? null) as CacheRow | null;
    },
    async writeAccepted(payload) {
      const { error } = await db.from("fx_rates_cache").upsert(
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
      if (error) throw new Error(error.message);
    },
    async stampFailedAttempt(atIso) {
      const { error } = await db
        .from("fx_rates_cache")
        .update({ updated_at: atIso })
        .eq("id", "current");
      if (error) throw new Error(error.message);
    },
  };

  const payload = await resolveRates({
    store,
    fetchFn: fetch as unknown as FeedFetch,
    now: new Date(),
    forceRefresh: new URL(req.url).searchParams.get("refresh") === "true",
    memory,
    warn: (message, error) => console.warn(message, error),
  });
  return json(payload, 200, cors);
});
