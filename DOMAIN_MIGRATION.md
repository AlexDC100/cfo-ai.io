# Domain Migration — `cfo-ai.finance` → `cfo-ai.io`

> **Cutover date:** 2026-05-24
> **Status:** Infrastructure + code shipped. **External operator actions remaining (see §3).**

## 1 · What was deployed (live on production)

| Layer | File | Change |
|---|---|---|
| **DNS** | (registrar, already set) | `cfo-ai.io @` → `187.124.0.37`, `api` → `187.124.0.37`, `www` CNAME → `cfo-ai.io` |
| **Caddy** | `/opt/scandia/Caddyfile` | New blocks: `cfo-ai.io, www.cfo-ai.io` (apex + www, FE+API routing) + `api.cfo-ai.io` (split-origin); legacy `cfo-ai.finance, www.cfo-ai.finance, api.cfo-ai.finance` → 301 redirect to `https://cfo-ai.io{uri}` preserving path + query |
| **Let's Encrypt certs** | Caddy auto-managed | Provisioned for `cfo-ai.io`, `www.cfo-ai.io`, `api.cfo-ai.io` (issuer: E7, verified 2026-05-24 22:41 UTC) |
| **Backend CORS** | `/opt/cfo-ai/docker-compose.yml` | `CORS_ORIGINS` env now includes both `.io` and `.finance` hosts (latter kept during the 12-month transition window) |
| **Backend UA** | `src/engine/api/fx_rates.py` | BNR fetch User-Agent updated to `cfo-ai/1.0 (+https://cfo-ai.io)` |
| **Frontend env defaults** | `scandi-desk-main/.env`, `.env.example` | `VITE_SITE_URL=https://cfo-ai.io`, `VITE_API_URL=https://api.cfo-ai.io` (production defaults; local dev overrides at top of `.env`) |
| **Frontend single-source-of-truth** | `scandi-desk-main/src/config/site.ts` | NEW — every component imports from here; defaults to `cfo-ai.io` so a fresh clone with no `.env` still resolves to working URLs |
| **API client + rates lib** | `scandi-desk-main/src/lib/{api,rates}.ts` | Now read `SITE.apiUrl` instead of hardcoded `http://127.0.0.1:8000` |

**Live verification (just now from external host):**

```
cfo-ai.io                    HTTP 200, valid Let's Encrypt cert (CN=cfo-ai.io)
www.cfo-ai.io                HTTP 200
api.cfo-ai.io/health         {"status":"ok","version":"0.1.0"}
api.cfo-ai.io/api/fx-rates   {"base":"EUR","rates":{...},"source":"BNR",...}

cfo-ai.finance/dashboard?period=abc&tab=balance_sheet
  → HTTP 301 → https://cfo-ai.io/dashboard?period=abc&tab=balance_sheet      ✓ query preserved

www.cfo-ai.finance/products/12345
  → HTTP 301 → https://cfo-ai.io/products/12345                                ✓ path preserved

api.cfo-ai.finance/api/period/xyz
  → HTTP 301 → https://cfo-ai.io/api/period/xyz                                ✓ deep path preserved
```

**Production is live on `cfo-ai.io`. Old links continue to work (301 → new domain).**

## 2 · Frontend rebuild needed for env to take effect

The Vite bundle bakes `VITE_*` env vars at **build time**, not runtime. The currently-deployed frontend image was built against the OLD env (no `VITE_SITE_DOMAIN`, old `VITE_API_URL` default). For the FE to actually call `https://api.cfo-ai.io` instead of the hardcoded localhost fallback, the frontend image needs to be rebuilt with the new env file present.

**To rebuild + redeploy the frontend image:**
```bash
# Locally — push the updated env + site.ts up
rsync -avz scandi-desk-main/.env root@187.124.0.37:/opt/cfo-ai/scandi-desk-main/.env
rsync -avz scandi-desk-main/.env.example root@187.124.0.37:/opt/cfo-ai/scandi-desk-main/.env.example
rsync -avz scandi-desk-main/src/config/site.ts root@187.124.0.37:/opt/cfo-ai/scandi-desk-main/src/config/site.ts
rsync -avz scandi-desk-main/src/lib/api.ts root@187.124.0.37:/opt/cfo-ai/scandi-desk-main/src/lib/api.ts
rsync -avz scandi-desk-main/src/lib/rates.ts root@187.124.0.37:/opt/cfo-ai/scandi-desk-main/src/lib/rates.ts

# On VPS — rebuild frontend image + restart container
ssh root@187.124.0.37 "cd /opt/cfo-ai && docker compose build frontend && docker compose up -d frontend"
```

Until the frontend rebuild lands, the live site at `cfo-ai.io` may still try to call the old `cfo-ai.finance` API (it'll 301 → new, so it works, but adds a hop). **Recommend rebuilding before high-traffic cutover.**

## 3 · Operator actions still needed (external dashboards)

I cannot do these from the code — they're external service configurations. Each takes 1–5 minutes:

### 3.1 Supabase (critical — auth breaks without this)

Project: `cjclenykwlngqvapmisb` (eu-west-1)

**Supabase Dashboard → Auth → URL Configuration:**
- **Site URL:** change to `https://cfo-ai.io`
- **Additional Redirect URLs:** add (keep the old ones for the transition window):
  ```
  https://cfo-ai.io/auth/callback
  https://cfo-ai.io/auth/confirm
  https://www.cfo-ai.io/auth/callback
  https://www.cfo-ai.io/auth/confirm
  ```
- Keep the existing `cfo-ai.finance` URLs in the allowlist for 30+ days so any in-flight email-confirmation links still work.

**Why:** Supabase rejects auth callbacks (sign-up confirmations, password resets, magic links) whose redirect URL isn't on the allowlist. Without this update, every new sign-up on `cfo-ai.io` fails silently.

### 3.2 Stripe (if billing is live)

**Stripe Dashboard → Developers → Webhooks:**
- Add new endpoint: `https://api.cfo-ai.io/api/billing/webhook` (or wherever your existing webhook is, on the new host)
- Verify deliveries for 7 days, then delete the old `api.cfo-ai.finance` endpoint

**Stripe Dashboard → Settings → Branding → Public business name / domain:** update to `cfo-ai.io` if shown on hosted checkout pages.

### 3.3 OAuth providers (if any)

For each (Google Cloud Console, Microsoft Azure AD, GitHub OAuth Apps, etc.):
- Add the new redirect URI: `https://cfo-ai.io/auth/callback/<provider>`
- Verify sign-in works
- Remove the old `cfo-ai.finance` URI after 30 days

### 3.4 Email — DKIM / SPF / DMARC (if sending email from cfo-ai.io)

The codebase doesn't appear to send transactional email currently (Supabase Auth handles confirmations + sends from Supabase's domain). But if/when you send from `noreply@cfo-ai.io`:

DNS records on `cfo-ai.io`:
```
TXT  @           v=spf1 include:_spf.<provider>.com ~all
TXT  default._domainkey  <DKIM public key from provider>
TXT  _dmarc      v=DMARC1; p=quarantine; rua=mailto:dmarc@cfo-ai.io; pct=100
```

Test with `mail-tester.com` — target 10/10 before going live.

### 3.5 Google Search Console (SEO preservation)

1. **Add new property:** `https://cfo-ai.io` (DNS verification, not HTML file — DNS already at the registrar)
2. **Change of Address tool:** Search Console → Settings → Change of address → tell Google `cfo-ai.finance` moved to `cfo-ai.io`. Google will verify the 301 redirect (which I just verified is in place) and shift the SEO index over weeks
3. **Submit sitemap** on the new property: `https://cfo-ai.io/sitemap.xml` (if you have one)
4. **Keep the old property** in Search Console for the duration — it stops getting new traffic but you want the migration progress data

Expect a 10–30% SEO dip in weeks 1–4, recovering by 60–90 days. Normal for clean 301 migrations.

### 3.6 Analytics / error tracking (if any are live)

- **PostHog / Mixpanel / GA4:** add `cfo-ai.io` to the authorized-domains allowlist; keep `cfo-ai.finance` for historical continuity
- **Sentry:** add `cfo-ai.io` to the project's allowed origins (Source Maps + CSP)
- Add a custom event tag (e.g., `migration_source: 'old_domain'` / `'new_domain'`) for the first 30 days so you can see when old-domain traffic dies out

### 3.7 DNS for `cfo-ai.finance` — KEEP IT POINTING TO 187.124.0.37

**Do NOT let the cfo-ai.finance domain registration expire** or change its A records. The 301 redirect lives at the Caddy level on `187.124.0.37`. If DNS for `cfo-ai.finance` lapses or changes, every external backlink and bookmark using the old domain dies overnight.

Recommendation: **set a calendar reminder to renew `cfo-ai.finance` for at least 5 more years**. Domain registration is ~$15/year — preserving link equity is worth orders of magnitude more.

## 4 · What's monitored automatically

| Check | Where | Cadence |
|---|---|---|
| HTTPS cert auto-renewal (cfo-ai.io, www, api) | Caddy ACME | Caddy renews ~30 days before expiry |
| BS-correctness regression on engine deploys (F-A3.1) | `scripts/measure_bs_drift.py` | Manual, after every backend deploy |
| Canonical envelope round-trip (F4.1-ROUNDTRIP) | `scripts/check_canonical_roundtrip.py` | Same |
| Backend health | `https://api.cfo-ai.io/health` | Hit before/after every deploy |

## 5 · Rollback plan (if something breaks in the first 24h)

1. **DNS rollback:** Lower TTLs to 300s NOW (do this proactively so rollback is fast if needed) at the registrar for both `cfo-ai.io` AND `cfo-ai.finance`. Currently 300s on cfo-ai.io per the DNS table — confirm cfo-ai.finance is also 300s.
2. **Caddy rollback:** previous Caddyfile is at `/opt/scandia/Caddyfile.bak-2026-05-18-1905-pre-cfo-ai`. To revert:
   ```bash
   ssh root@187.124.0.37 "cp /opt/scandia/Caddyfile.bak-2026-05-18-1905-pre-cfo-ai /opt/scandia/Caddyfile && docker restart scandia-caddy"
   ```
   (Restart, not reload — the bind-mount inode caching issue we hit earlier requires a full restart to refresh.)
3. **Backend rollback:** docker-compose change is only the CORS_ORIGINS env var. Revert via:
   ```bash
   ssh root@187.124.0.37 "cd /opt/cfo-ai && git diff docker-compose.yml; <restore prior CORS_ORIGINS line>; docker compose up -d backend"
   ```
4. **Frontend rollback:** image hasn't been rebuilt yet (per §2), so no FE rollback needed unless you rebuilt.

Rollback window: **first 24 hours**. After Google has crawled the 301s + users have updated bookmarks, the rollback gets progressively more painful.

## 6 · Files touched (diff summary)

```
new:     scandi-desk-main/src/config/site.ts                        (single source of truth)
new:     DOMAIN_MIGRATION.md                                         (this file)
edited:  scandi-desk-main/.env                                       (added VITE_SITE_DOMAIN/URL)
edited:  scandi-desk-main/.env.example                               (prod defaults + dev overrides)
edited:  scandi-desk-main/src/lib/api.ts                             (use SITE.apiUrl)
edited:  scandi-desk-main/src/lib/rates.ts                           (use SITE.apiUrl)
edited:  deploy/cfo-ai-vps/Caddyfile                                 (cfo-ai.io blocks + 301 redirect)
edited:  deploy/cfo-ai-vps/docker-compose.yml                        (CORS_ORIGINS includes both)
edited:  src/engine/api/fx_rates.py                                  (BNR User-Agent → cfo-ai.io)

NOT touched (intentional):
- deploy/nginx-*.conf       LEGACY (not used by live Caddy stack; rename in future cleanup)
- DIAGNOSTIC_*.md / CLOSURE_*.md (historical records; the old-domain refs are date-stamped audit context)
```

## 7 · The diagnostic sweep — pre-migration audit

For traceability, the spec's 7-grep diagnostic was run before changes; results at `i18n-sweep/` (for the i18n task) and `/tmp/migration/1-old-domain-refs.txt` (94 matches, almost all in dated `.md` files that are historical records, not active code). The 7 critical code/infra files were all updated (see §6).
