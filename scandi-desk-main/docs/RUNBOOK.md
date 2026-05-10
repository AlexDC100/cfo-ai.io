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
