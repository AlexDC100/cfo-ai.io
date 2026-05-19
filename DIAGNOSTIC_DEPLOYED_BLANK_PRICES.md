# BLANK PRICES ON DEPLOYED (cfo-ai.finance) — DIAGNOSTIC (READ-ONLY)

Generated 2026-05-18. Read-only. No source code, server, or DNS state changed during this diagnostic. The only file written is this report.

---

## TL;DR

**The domain `cfo-ai.finance` is a parked Hostinger placeholder. There is no CFO AI deployment at that hostname.** Every URL (including `/api/pricing/config`) returns the same 32 KB Hostinger "Parked Domain" HTML page with `server: hcdn`. The "blank prices" the user reports are not a React render failure — there is no React app being served at all.

Cause = **#3 stale deploy, extreme form** (nothing is deployed). Fix is operational (DNS / hosting / pipeline), not code.

---

## S0 — Deployed `GET /api/pricing/config`

```
url tested           https://cfo-ai.finance/api/pricing/config
status               HTTP/2 200
content-type         text/html   ← NOT application/json
size                 ~32 KB
server header        hcdn          (Hostinger CDN)
x-hcdn-request-id    9d95d372e5caa6794780424d049e2d30-tok-edge4
cache-control        no-store
robots meta          noindex, nofollow, noarchive, nosnippet
body                 <!DOCTYPE html>…<title>Parked Domain name on
                      Hostinger DNS system</title>… (Hostinger parking
                      template — "Get the same domain on Hostinger" CTA)
```

**Every route returns the same parked-domain page**, not just `/api/pricing/config`:

| URL | HTTP | content-type | body |
|---|---|---|---|
| `https://cfo-ai.finance/` | 200 | text/html (32 012 bytes) | Parked HTML |
| `https://cfo-ai.finance/pricing` | 200 | text/html | Parked HTML |
| `https://cfo-ai.finance/api/pricing/config` | 200 | text/html | Parked HTML |
| `https://cfo-ai.finance/api/pricing/admin` | 200 | text/html | Parked HTML |
| `https://cfo-ai.finance/api/plan/state` | 200 | text/html | Parked HTML |
| `https://www.cfo-ai.finance/` | 200 | text/html (32 012 bytes) | Parked HTML (same) |

Common app/api subdomains do not resolve:

```
app.cfo-ai.finance      NXDOMAIN
api.cfo-ai.finance      NXDOMAIN
staging.cfo-ai.finance  NXDOMAIN
dev.cfo-ai.finance      NXDOMAIN
```

DNS:

```
cfo-ai.finance.       A   2.57.91.91     ← Hostinger parking range
www.cfo-ai.finance.   A   2.57.91.91     (same IP)
```

**Deployed frontend API base** — recorded from source (relevant if a deploy did exist, which it doesn't):

```
src/lib/pricingConfig.ts:16-17
  const API_URL =
    (import.meta.env.VITE_API_URL as string | undefined)
      ?? "http://127.0.0.1:8000";
```

Same default in `src/lib/planState.ts:20-21` and three sites in `src/lib/supabase.ts:400 / 486 / 524`. If a build is ever produced without `VITE_API_URL` set at build time, the bundled JS will call `http://127.0.0.1:8000/api/pricing/config` — i.e. the visitor's own localhost, which won't have a backend. This is a latent second cause that would surface the moment a deploy is attempted without that env var.

**Does the pricing/config request fire on the deployed page?** N/A — the deployed page is not the React app, it's the Hostinger parking HTML. No JS fetch from `pricingConfig.ts` can fire because the bundle is never loaded.

---

## S1 — Deployed-vs-source comparison

| Question | Answer | Evidence |
|---|---|---|
| What is the deployed build's provenance? | **There is no build deployed.** | Parked Hostinger page on every path. |
| Does the deployed FE have `PricingTableV2`/`pricingConfig` wiring? | N/A — no FE deployed | No `index.html` from Vite; no `/assets/index-*.js` referenced; markup is Hostinger's template. |
| Does the deployed BE have `/api/pricing/config` route? | N/A — no BE deployed | The route is served by Hostinger's CDN as the parked-domain HTML, not by FastAPI. |
| Does the source have the pricing work? | YES (in working tree, not committed) | `git log --oneline -5` shows the latest 5 commits are about Datasets panel + Products portfolio — none are about pricing. The pricing V2/V3 work (PricingTableV2, BillingSection, AccountMenu, PricingFaq, MonthlyBillEstimator, etc.) is in the **working tree only**, not in any commit on the current branch. |

Last 5 commits on master (none touch pricing):

```
af6d65c feat: Datasets panel + comparison view + Playwright spec (steps 4-6)
63bc504 chore: gitignore .claude/ runtime state
462c8cb feat: real 406-SKU portfolio — sales-dataset pipeline (steps 1-3)
ed28f56 test: Playwright ratchet for Documents panel (Step 5)
69582ea feat: per-document actions in Docs panel (Step 4)
```

---

## CONCLUSION (cause, with evidence)

- [ ] #1 endpoint unreachable/erroring on deployed (route or API-base)
- [ ] #2 shape mismatch (deployed payload vs component read path)
- [x] **#3 stale deploy** — in its most extreme form: **no deploy exists at all**

**Evidence:** `cfo-ai.finance` resolves to `2.57.91.91` (Hostinger parking IP). Every path returns the identical 32 012-byte Hostinger "Parked Domain" HTML with `server: hcdn`. No JSON ever leaves the server. No CFO AI HTML or JS asset is served. The `/pricing` route returns the parking page, not the React SPA — so even the page that would render the prices is not deployed.

Local source is fine. The pricing work renders correctly when the source is run locally (verified earlier this session: prices populated via `__setPricingConfigForTest` on the live dev server, confirming the components, hooks, and config-driven plumbing all work).

This is consistent with the user's report: locally the prices show, on cfo-ai.finance they're blank. Reason: locally the React app is running and the backend responds; on cfo-ai.finance neither exists.

---

## MINIMAL FIX SURFACE (recorded, NOT implemented)

Smallest action set, in order. Each step is operational, none is a code edit.

1. **Point DNS / hosting at a real CFO AI deployment.**
   The current A record `cfo-ai.finance → 2.57.91.91` is Hostinger's parking server. Either:
   - (a) host the CFO AI frontend + backend on Hostinger and replace the parked-domain default with the actual app, OR
   - (b) re-point the A record at the chosen host (Vercel, Fly, Cloud Run, etc.) where the app actually runs.

2. **Commit the pricing work and produce a build.**
   The pricing V2/V3 work is uncommitted on `master` — `git status` shows ~30 modified + new files, none in commits. Until at least a commit + build exists, there is nothing to deploy.

3. **Set `VITE_API_URL` at build time** to the deployed backend's URL (NOT `http://127.0.0.1:8000`). Without this, the production JS bundle defaults to `127.0.0.1:8000`, which from a visitor's browser resolves to the visitor's own machine and fails.
   References (read-only):
   - `src/lib/pricingConfig.ts:16-17`
   - `src/lib/planState.ts:20-21`
   - `src/lib/supabase.ts:400, 486, 524`

4. **Add the production frontend origin to backend CORS** (`src/engine/api/server.py:103-107` currently allows only `localhost:5173 / 8080 / 4173`). Without this, even with #1–#3 in place the production frontend will get CORS errors when calling `/api/pricing/config`. Read-only — no edit made.

5. **Process finding (recorded):** The GREEN pricing closure report verified **local source**, not deployed reality. There was no deploy step in the closure verification. Recommend that future "GREEN" reports either (a) explicitly tag scope ("LOCAL GREEN") or (b) include a deploy gate that hits the production hostname and asserts JSON on `/api/pricing/config`.

---

## STATUS

- [x] **COMPLETE** (read-only, nothing changed on server, in DNS, in source, or in the repo other than writing this single diagnostic report)

## RECORDED (not fixed — defects + process findings, numbered for a future targeted fix prompt)

1. **No production deployment exists** at `cfo-ai.finance`. Domain is parked on Hostinger (IP `2.57.91.91`, `server: hcdn`). Fix = deploy the app or re-point DNS. No source code is broken.

2. **Pricing work is uncommitted.** All Pricing V2/V3 / restyle / billing-card work that the GREEN report covered lives in the working tree only — not in any commit on `master`. Last commit `af6d65c` is unrelated (Datasets panel). Until committed there is nothing to ship.

3. **Latent FE-default API base is `http://127.0.0.1:8000`** in four read sites (`pricingConfig.ts`, `planState.ts`, `supabase.ts` ×3). If a production build is produced without `VITE_API_URL`, the bundle will try to fetch from the visitor's localhost. Would manifest as "Failed to fetch" / "Loading pricing…" stuck state on the deployed site once #1 is fixed without #3 also being set.

4. **Backend CORS allowlist** in `server.py:103-107` permits only dev origins. Production frontend origin would need to be added (env override `cors_origins` exists per the function signature) before #1–#3 can succeed end-to-end.

5. **Process gap.** GREEN report did not test the deployed hostname. Recommend adding a single curl assertion (`curl -fsSL https://cfo-ai.finance/api/pricing/config | jq .plans[0].key`) to the verification checklist for future pricing-relevant closures, so a stale or absent deploy can never be reported GREEN again.
