// DEV-only backend circuit breaker.
//
// When the local FastAPI backend (VITE_API_URL, default http://127.0.0.1:8000)
// isn't running — the common case during frontend-only development — every
// scattered `fetch()` to it fails with ERR_CONNECTION_REFUSED. That spams the
// console and makes each page wait on (and retry) a doomed round-trip on every
// navigation.
//
// This installs a tiny circuit breaker around `window.fetch`: the first request
// to the backend origin that fails to connect "opens" the breaker, and for a
// short cooldown every further request to that origin short-circuits INSTANTLY —
// rejecting with the exact same `TypeError` a real connection failure throws, so
// existing catch blocks / empty-state fallbacks behave identically, just without
// the network attempt (no console error, no wait). After the cooldown one probe
// is allowed through; the moment the backend answers again the breaker closes.
//
// Scope guarantees:
//   · Installed ONLY in dev (import.meta.env.DEV) — a complete no-op in
//     production, where the backend is expected to be up.
//   · Only requests to the backend origin are touched; Supabase and every other
//     origin pass straight through to the untouched original fetch.
//   · Self-healing — a single successful response closes the breaker.

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

// Same-origin mode (2026-09-08): `VITE_API_URL=` is deliberately EMPTY in
// LAN dev so every engine call is relative (`/api/*`, `/health`) and the
// Vite proxy forwards it. An empty string is not nullish, so it used to fall
// through to `apiOrigin = ""` — and `url.startsWith("")` is true for EVERY
// URL. One failed fetch anywhere (the Edge Functions rejecting a LAN origin
// via CORS, for instance) then tripped the breaker for ALL origins, and for
// the next 4 s every Supabase auth/REST call was rejected instantly — a
// sign-in that "fails to fetch", a workspace list that never arrives.
// Backend requests in this mode are the proxied paths only.
const SAME_ORIGIN = API_URL.trim() === "";
const SAME_ORIGIN_PATHS = ["/api/", "/health"];

let apiOrigin = API_URL;
if (!SAME_ORIGIN) {
  try {
    apiOrigin = new URL(API_URL).origin;
  } catch {
    /* keep the raw string — startsWith still matches `${API_URL}/api/...` */
  }
}

// Cooldown while the breaker is open. Short so recovery (backend started
// mid-session) is picked up within a few seconds, without a page reload.
const COOLDOWN_MS = 4000;
let openUntil = 0;

function targetsBackend(input: RequestInfo | URL): boolean {
  try {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (SAME_ORIGIN) {
      const path = url.startsWith("/") ? url : new URL(url, window.location.href).origin === window.location.origin ? new URL(url, window.location.href).pathname : null;
      return path !== null && SAME_ORIGIN_PATHS.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p));
    }
    return url.startsWith(apiOrigin);
  } catch {
    return false;
  }
}

export function installDevBackendCircuitBreaker(): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === "undefined") return;
  const w = window as typeof window & { __cfoBackendBreaker?: boolean };
  if (w.__cfoBackendBreaker) return;
  w.__cfoBackendBreaker = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // Anything not aimed at our backend (Supabase auth/storage, assets, …)
    // is never gated.
    if (!targetsBackend(input)) return originalFetch(input, init);

    // Breaker OPEN — fail fast, no network attempt, no console noise. Mimic a
    // real connection failure so callers' existing error handling is unchanged.
    if (Date.now() < openUntil) {
      throw new TypeError(
        "Failed to fetch — backend unreachable (dev circuit breaker open)",
      );
    }

    try {
      const res = await originalFetch(input, init);
      openUntil = 0; // reachable again → close the breaker
      return res;
    } catch (err) {
      // A connection-level failure (ERR_CONNECTION_REFUSED, DNS, offline) throws
      // a TypeError. Trip the breaker so the burst of sibling calls that follow
      // short-circuit instead of each hammering the dead port. HTTP errors
      // (4xx/5xx) resolve normally and never reach here, so a running-but-erroring
      // backend is not mistaken for an unreachable one.
      if (err instanceof TypeError) {
        openUntil = Date.now() + COOLDOWN_MS;
      }
      throw err;
    }
  };
}
