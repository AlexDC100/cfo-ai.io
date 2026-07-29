# CFO AI — Runbook

Operational notes for running CFO AI locally and deploying it.

---

## Local development

```bash
cd scandi-desk-main
npm install
npm run dev       # → http://localhost:5173
```

Backend (Python FastAPI) lives one level up at `../src/engine/`:

```bash
cd ..
source .venv/bin/activate
python -m engine.api.server   # → http://localhost:8000
```

The frontend reads `VITE_API_URL` (default `http://127.0.0.1:8000`) for the
inventory engine endpoints. Financial Statement Intelligence runs entirely
client-side (no backend dependency) but persists to Supabase.

## Environment variables

`scandi-desk-main/.env` (frontend, all `VITE_*`):

```
VITE_API_URL=http://127.0.0.1:8000
VITE_SUPABASE_URL=<project URL>
VITE_SUPABASE_ANON_KEY=<anon publishable key>
```

Repo root `.env` (backend):

```
ANTHROPIC_API_KEY=sk-ant-...
ENGINE_API_TOKEN=<bearer token n8n sends>

# Phase 3 pipeline orchestrator — admin client for service-role writes
SUPABASE_SERVICE_ROLE_KEY=<service_role secret from Supabase dashboard>
# These two are also required server-side because the orchestrator uses
# them for per-user RLS reads and Storage signed URLs:
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon publishable key>
```

Source the root `.env` before launching the FastAPI server so the pipeline
endpoints can authenticate against Supabase:

```bash
set -a && . ./.env && set +a
python -m engine.api.server
```

When `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are missing the app
degrades silently — auth is disabled, persistence no-ops, demo mode still
works. A small banner on `/login` and `/upload` calls this out.

## Supabase setup

Project: `cjclenykwlngqvapmisb` (eu-west-1).

### Apply schema

1. Open Supabase dashboard → SQL editor.
2. Paste the contents of `supabase/schema.sql`. It's idempotent — every
   `create` uses `if not exists`, every policy is `drop … if exists` then
   recreated.
3. Run.
4. Then paste + run `supabase/schema_phase3.sql`. This adds the multi-tenant
   `organizations` + `memberships` tables, the `is_member_of()` RLS helper,
   the `bootstrap_organization` trigger, and the pipeline output tables
   (`calculated_metrics`, `briefings`). Also idempotent.

The Phase 3 file:
  - Replaces the bootstrap trigger so new signups get an org + owner membership
    seeded from `pending_org_name` / `pending_industry_key` user metadata.
  - Adds membership-scoped RLS policies alongside the legacy owner-only ones,
    so existing data keeps working during the rollout.
  - Backfills an organization + membership for every pre-existing user.

Or via Management API (requires a personal access token `sbp_…`):

```bash
PAT="sbp_..."
PROJECT="cjclenykwlngqvapmisb"
curl --http1.1 -X POST "https://api.supabase.com/v1/projects/$PROJECT/database/query" \
  -H "Authorization: Bearer $PAT" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$(cat supabase/schema.sql)" '{query:$q}')"
```

Note the `--http1.1` flag — Supabase's Management API rejects HTTP/2 framed
multipart and returns `HTTP/2 stream 1 was not closed cleanly`.

### Create the `documents` Storage bucket

The Phase 1 schema's storage policies bind to a bucket called `documents`,
but the bucket itself must be created out-of-band:

1. Supabase dashboard → Storage → "New bucket".
2. Name: `documents`. Public: **off**. File size limit: 25 MB.
3. Re-run `supabase/schema.sql` once the bucket exists — the `do $$ … end$$`
   block at the bottom of the file binds the per-user folder policies.

The convention is `{auth.uid()}/{document_id}.{ext}`. The RLS policy keys
on the first folder segment, so users can only see / write their own folder.

### Auth configuration

In Supabase dashboard → Authentication → Providers → Email:

- **Confirm email**: ON (Phase 1 ships the confirmation flow).
- **Secure email change**: ON.
- **Site URL**: your production origin (e.g. `https://cfoai.app`).
- **Redirect URLs**: add the dev origin too — `http://localhost:5173`.

The `signUp()` call in `src/lib/auth.tsx` passes
`emailRedirectTo: window.location.origin` so confirmation links land back on
the same origin the user signed up from.

## Deploying

### Frontend (Vite static build)

```bash
cd scandi-desk-main
npm run build       # → dist/
```

Deploy `dist/` to any static host (Hostinger Premium hosting, Vercel,
Netlify, S3+CloudFront, Cloudflare Pages). Make sure the host serves
`index.html` for any unknown route — required for client-side routing.

For Hostinger:

1. Build locally: `npm run build`.
2. Upload `dist/*` to `public_html/` via FTP or the Hostinger File Manager.
3. Add `.htaccess` in `public_html/`:
   ```apache
   RewriteEngine On
   RewriteRule ^index\.html$ - [L]
   RewriteCond %{REQUEST_FILENAME} !-f
   RewriteCond %{REQUEST_FILENAME} !-d
   RewriteRule . /index.html [L]
   ```
4. Set `VITE_*` env vars at build time, not runtime — Vite inlines them.
5. Custom domain: point DNS A record at Hostinger's IP, enable SSL via
   the dashboard (Let's Encrypt, free).

### Backend (FastAPI)

The Python engine is dockerized (`Dockerfile`, `docker-compose.yml`).
Hostinger Cloud or VPS works; or use Fly.io / Railway / Render for a
simpler start.

The frontend's `VITE_API_URL` must point at the deployed backend's
public URL. Update `.env`, rebuild, redeploy.

## Common issues

### "Vite Internal server error … Expected '</', got 'jsx text'"

Vite's HMR sometimes shows stale syntax errors on the very next reload after
fixing. If `npx tsc --noEmit` is clean, the source is valid — refresh once
or restart `npm run dev`. The error message will match the *previous*
broken state, not the current.

### "React has detected a change in the order of Hooks called by …"

Phase 1 fixed this for AuthCard. If it reappears in another component:
look for hooks called inside conditionals, early returns, or hooks that
internally call other hooks (like `useSubscription` calling
`useLocalSubscription`). Move all hooks to the top of the function before
any `if`/`return`.

### Upload returns "Sign in is required"

The user is in demo mode (or signed out). Storage RLS keys on
`auth.uid()`, so a real Supabase session is required. Surfaced as an amber
banner on `/upload` with a "Sign in" CTA.

### Email confirmation links don't work

Check Supabase → Authentication → URL Configuration → Redirect URLs
includes the origin the user signed up from. Each origin (dev, staging,
prod) must be listed.

## Phase 3 — End-to-end pipeline

The "upload → populated dashboard" flow has six moving pieces:

  1. Real Supabase auth (Phase 1)
  2. Multi-tenancy via `organizations` + `memberships` (Phase 3)
  3. Onboarding (`/onboarding`) captures `industry_key` for each org
  4. Storage upload writes to `{org_id}/uploads/{document_id}.{ext}`
  5. The Python pipeline orchestrator on the FastAPI backend turns the doc
     into a `financial_periods` row + `calculated_metrics` + `briefings` +
     `recommendations` + `alerts`, stepping `documents.status` through
     queued → extracting → mapping → computing → narrating → analyzed.
  6. The frontend subscribes via Postgres Changes; on `analyzed` it
     navigates to `/dashboard?period=<period_id>` and `useActivePeriod()`
     fetches `/api/period/<id>` (RLS-scoped to the caller's JWT).

### Verification gates (run these after applying both schemas)

**Gate 1 — RLS isolates two users.** In an incognito window:

```sql
-- After signing up user A "Acme Test" and user B "Beta Test", run from each
-- session (Supabase SQL editor → set "Run as user" to A, then to B):
select count(*) from organizations;   -- expect 1 for each user
select count(*) from memberships where user_id = auth.uid();  -- expect 1
```

**Gate 2 — Upload + storage RLS.** Sign in as user A, upload via `/upload`,
note the `storage_path` from the document row. Sign in as user B and try:

```js
await supabase.storage.from('documents').download('<userA storage_path>');
// expect: { error: { ... 403 / not authorized ... } }
```

**Gate 3 — Pipeline reaches `analyzed`.** Watch the document row's status:

```sql
select id, status, error, period_id, duration_ms
from documents order by created_at desc limit 1;
-- expect status to advance through queued → extracting → mapping →
--        computing → narrating → analyzed within ~30-60s.
-- If it hangs at extracting: check ANTHROPIC_API_KEY is set on the backend.
-- If it hits failed: read the error column.
```

**Gate 4 — UI populated.** With the document's `period_id`, visit
`/dashboard?period=<period_id>`. Required:
- KPI cards (`kpi-revenue`, `kpi-ebitda`, `kpi-net-income`, `kpi-total-debt`)
  show non-zero values matching the source PDF.
- The CFO Briefing card (`cfo-briefing`) renders an industry-aware paragraph.
- `/decisions` shows ≥ 1 recommendation card (Opus 4.7 output).
- `/alerts` shows recommendations or an empty-state card.

**Gate 5 — Failure + retry.** Upload a non-document (a JPEG of anything).
Wait for status='failed'. The error message renders in the documents table.
Click "Re-run" — status returns to `queued` and the pipeline runs again.

**Gate 6 — Playwright real-e2e.** Set up a fixture trial-balance PDF at
`scandi-desk-main/e2e/fixtures/test-trial-balance.pdf`, then:

```bash
E2E_REAL=1 npm run test:e2e -- e2e/real-e2e.spec.ts
```

The spec creates two ephemeral test users (`playwright+<ts>@cfoai.dev`),
runs the full flow for each, asserts populated UI for user A, and checks
user B can't see user A's data via direct API access.

### Common pipeline failures

- `ANTHROPIC_API_KEY is not configured` — the backend wasn't started with
  the env sourced. Run `set -a && . ./.env && set +a; python -m engine.api.server`.
- `Could not fetch PDF from URL` — the storage signed URL expired before
  Claude downloaded it. Retry; the orchestrator mints a fresh URL each run.
- `Claude returned invalid JSON` — Opus 4.7 emitted a non-JSON preamble.
  Re-run; this is rare and usually transient.
- Pipeline never starts after upload — the frontend couldn't reach
  `VITE_API_URL`. Check the URL points at a running FastAPI process.

### CI guard against placeholder strings

`npm run lint:placeholders` (or `bash scripts/check-no-placeholders.sh`)
fails if any of the deferred-feature markers reappear in `src/`. The list
of forbidden strings lives in the script — extend it whenever you remove
another stub.
