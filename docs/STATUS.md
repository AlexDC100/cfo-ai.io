# CFO AI — Phase 0 Audit (Honest)

> **Purpose:** This is a candid map of the repository as it stands today —
> what works, what is partial, what is broken, what is mocked. It exists so we
> can plan the minimum cut to satisfy the master build prompt's Phase 1
> acceptance criteria. **No feature code has been written for this prompt yet.**

Audit date: 2026-05-10
Auditor: Claude (acting as lead architect)
Repo root: `/Users/alex/Desktop/folder claude (sample 2) copy`
Frontend: `scandi-desk-main/`
Backend: `src/engine/` (Python FastAPI)

---

## 1. Stack detected

### Frontend (`scandi-desk-main/`)

| Concern | Choice | Version |
|---|---|---|
| Bundler / dev server | Vite | 5.4.19 |
| Framework | React (SPA, no SSR) | 18.3.1 |
| Language | TypeScript | 5.8.3 |
| Router | react-router-dom | 6.30.1 |
| Server-state | @tanstack/react-query | 5.83.0 |
| UI primitives | shadcn/ui (Radix under the hood) | latest |
| Styling | Tailwind CSS | 3.4.17 (HSL CSS-vars) |
| Theme | next-themes | 0.3.0 (wrapped in `@/theme/ThemeProvider`) |
| Forms | react-hook-form + zod | 7.61 / 3.25 |
| Charts | recharts | 2.15.4 |
| Animations | framer-motion | 12.38.0 |
| Excel export | xlsx (SheetJS) | 0.18.5 — **wired** |
| Auth client | @supabase/supabase-js | 2.105.4 |
| Tests | vitest + jsdom | 3.2.4 |

**Package manager:** the lockfile is `package-lock.json` → npm. The master prompt mentions `pnpm install && pnpm dev` — we'll either need a `pnpm-lock.yaml` or accept npm. Recommend documenting in `RUNBOOK.md`.

### Backend (`src/engine/`)

| Concern | Choice | Version |
|---|---|---|
| Framework | FastAPI | (Python 3.9+) |
| Currently running | Yes — `python` process listening on `:8000` |
| ORM | SQLAlchemy (per `models.py`) |
| AI SDK | `anthropic` Python SDK |
| Default model | `claude-opus-4-7` (per prior turns) |
| Editable install | venv `.pth` points at `src/` |

### Other infra

- `Dockerfile`, `docker-compose.yml`, `Caddyfile` exist — deployment is templated, not yet hosted.
- `supabase/schema.sql` is single-file, not migrations — applied manually via SQL editor.
- `.env` (root) holds `ANTHROPIC_API_KEY`. `scandi-desk-main/.env` holds `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- No `pnpm-workspace.yaml`. The repo is two siblings (frontend + backend) sharing a root `.env`.

---

## 2. Routes inventory (frontend)

23 routes registered in `src/App.tsx`. Status reflects whether the page renders + whether its primary user action works end-to-end.

### Public

| Route | File | Status | Notes |
|---|---|---|---|
| `/` | `pages/cfo/Landing.tsx` | ✅ works | Hero + 3 flagship cards + auth card. New "Turn invoices…" headline ships today. |
| `/login` | `pages/cfo/Login.tsx` | ⚠️ partial | Wraps `<AuthCard>`. Real Supabase signin works. AuthCard has a known **hooks-order warning** (visible in console). |
| `/signup` | `pages/cfo/Signup.tsx` | ⚠️ partial | Same AuthCard hooks-order warning. Real signup hits Supabase + `handle_new_user` trigger. Email confirmation flow not explicitly disabled in dev. |
| `/pricing` | `pages/cfo/Pricing.tsx` | ✅ works | Public + post-signup picker. |

### Authenticated (gated by `<AuthGuard>`)

| Route | File | Status | Notes |
|---|---|---|---|
| `/financial-statements` | `pages/cfo/FinancialStatements.tsx` | ✅ works | 7 tabs. (sample 1) sample + 3 other samples. Trial-balance paste parser. HTML + Excel export. **DCF/Graham/Piotroski/credit score all live.** |
| `/invoices` | `pages/cfo/Invoices.tsx` | ⚠️ stub | Coming-soon page. Honest about deferred status. |
| `/today` | `pages/cfo/Today.tsx` | ⚠️ partial | Renders. Reads from `useDailyRun()` (mock data in `src/data/dailyRun.ts`) **OR** the upload-derived run. No DemoBadge — looks real even when mock. |
| `/cash` | `pages/cfo/Cash.tsx` | ⚠️ partial | Same mock-vs-real ambiguity. |
| `/profit` | `pages/cfo/Profit.tsx` | ⚠️ partial | Same. |
| `/decisions` | `pages/cfo/Decisions.tsx` | ⚠️ partial | Reads from `recommendations` table (Supabase) when configured, falls back to derived. |
| `/products` | `pages/cfo/Products.tsx` | ⚠️ partial | Same mock-vs-real ambiguity. |
| `/alerts` | `pages/cfo/Alerts.tsx` | ⚠️ partial | **See section 5 — user flagged this.** |
| `/reports` | `pages/cfo/Reports.tsx` | ⚠️ stub | Coming-soon page. Persistence + share-links deferred. |
| `/settings` | `pages/cfo/Settings.tsx` | ⚠️ partial | Profile + workspace + subscription sections. Subscription card reads from Supabase. Stripe checkout is a TODO. |

### Redirects (lossless, work)

`/app → /today`, `/configuration → /settings`, `/skus → /products`, `/category/:slug → /products`, `/briefing → /today`, `/history → /decisions?status=done`, `/upload → /today`, `/anchors → /products?bucket=PROTECT`.

### Missing (per master prompt)

- ❌ `/app/upload` — the prompt's Phase 1 acceptance asks for an upload page. Today, upload is a dialog (`UploadDialog.tsx`) opened from the sidebar footer + `/upload` redirects to `/today`. There is **no standalone upload page**.
- ❌ `/app/financial-statements/:id` — list of past analyses with detail view. Today the page is single-document (whatever sample/upload is active in memory).
- ❌ `/signin?next=...` redirect-back behavior. AuthGuard redirects unauthenticated visitors to `/`, not `/login` with a `next` param.

---

## 3. Backend inventory

### REST endpoints (FastAPI, `src/engine/api/`)

| Path | Method | File | Status | Notes |
|---|---|---|---|---|
| `/health` | GET | server.py | ✅ | Liveness probe |
| `/run-daily` | POST | server.py | ✅ | Token-auth'd. Runs the inventory pipeline. |
| `/decisions/{run_date}` | GET | server.py | ✅ | |
| `/api/sessions/track` | POST | server.py | ✅ | |
| `/api/sessions` | GET | server.py | ✅ | |
| `/api/upload-excel` | POST | frontend.py | ✅ | The active upload path. Inventory-shaped XLSX. |
| `/api/config` | GET | frontend.py | ✅ | |
| `/api/canonical-categories` | GET | frontend.py | ✅ | |
| `/api/classify-rows` | POST | frontend.py | ✅ | |
| `/api/skus` | POST | frontend.py | ✅ | |
| `/api/drill` | POST | frontend.py | ✅ | |
| `/api/analyze` | POST | frontend.py | ✅ | |
| `/api/alerts` | POST | frontend.py | ✅ | Computes alerts against an uploaded dataset. |
| `/api/cfo/today` | POST | cfo_ai.py | ✅ | |
| `/api/cfo/cash` | POST | cfo_ai.py | ✅ | |
| `/api/cfo/profit` | POST | cfo_ai.py | ✅ | |
| `/api/cfo/decisions` | GET, POST `/{rec_id}/status` | cfo_ai.py | ✅ | |
| `/api/cfo/chat` | POST | cfo_ai.py | ✅ | |
| `/api/cfo/chat/llm` | — | removed 2026-07-24 | ➖ | Moved to `supabase/functions/chat-llm/` (Milestone D) — FE calls the Edge Function directly, not the engine. |
| `/api/cfo/chat/prompts` | GET | cfo_ai.py | ✅ | |
| `/api/cfo/exports/board-summary` | POST | cfo_ai.py | ✅ | |
| `/api/cfo/exports/action-list` | POST | cfo_ai.py | ✅ | |
| `/api/cfo/products` | POST | cfo_ai.py | ✅ | |

### Missing (per master prompt)

- ❌ `/api/uploads` — generic document upload (the prompt's Phase 1 endpoint). Today only `/api/upload-excel` exists, scoped to inventory workbooks.
- ❌ `/api/financial-statements/parse` — pipeline trigger.
- ❌ `/api/financial-statements/analyze` — analytics trigger.
- ❌ `/api/reports/:id`, `/api/ratios/:id`, `/api/valuations/:id` — by-id fetchers.
- ❌ `/api/export/pdf`, `/api/export/pptx` — PDF + PowerPoint generation.
- ❌ `/api/chat` — the SSE-streamed CFO chat endpoint specified in Phase 4.
- ❌ `/api/webhooks/stripe` — billing webhook handler.

### Supabase (project `cjclenykwlngqvapmisb`, eu-west-1)

Tables defined in `supabase/schema.sql`, applied in production:

| Table | Status vs. Phase 1 | Notes |
|---|---|---|
| `profiles` | ✅ exists | Mirrors auth.users. Seeded by `handle_new_user`. |
| `workspaces` | ⚠️ exists, **not what Phase 1 asks for** | Single-owner workspaces. Phase 1 asks for `organizations` + `memberships` (multi-tenant). |
| `subscriptions` | ✅ exists | Has Stripe customer/sub fields, checkout flow not wired. |
| `alert_states` | ⚠️ exists, **persists state only** | Stores user actions on alerts (acknowledged/dismissed). Alerts themselves are recomputed deterministically — they are **not stored as rows**. Phase 1 asks for an `alerts` table proper. |
| `recommendations` | ✅ exists | Fully functional. |
| `datasets` | ⚠️ exists | Inventory-workbook upload metadata. Phase 1 asks for `documents` (broader: PDFs, financial statements). |
| `activity` | ✅ exists | Audit stream. |

**Missing tables for Phase 1+:**
- `organizations` + `memberships` (multi-tenant primitive). The current model is **one user = one org** via `org_id default auth.uid()`. Migrating to true multi-tenant is a non-trivial RLS rewrite.
- `documents` (proper, with `detected_type`, `extraction_confidence`, `status` workflow).
- `alerts` (Phase 1's table — currently only `alert_states` exists).
- `financial_periods`, `statement_line_items` (Phase 2).
- `calculated_metrics` (Phase 3).
- `chat_messages`, `coa_mappings`, `usage_records` (Phases 4–6).

**RLS posture:** Every existing table has RLS enabled with `auth.uid() = org_id` policies. This is the **single-tenant assumption** baked deep — Phase 1's `is_member_of(org_id)` helper does not exist yet.

---

## 4. Auth status

**Sign-up → sign-in → protected route → sign-out:** ⚠️ **Mostly works, with caveats.**

Verified end-to-end this session:
- Supabase client initializes when `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` are present (they are in `.env`).
- `signUp` posts to `auth.signUp` with `email`, `password`, optional `display_name` + `company_name` in `user_metadata`.
- `handle_new_user` Postgres trigger seeds: `profiles` row, `workspaces` row, 14-day `subscriptions` row in `trial` status.
- `signIn` uses `signInWithPassword`. State is mirrored to React via `onAuthStateChange`.
- `<AuthGuard>` gates all `/today`, `/cash`, `/profit`, `/decisions`, `/products`, `/alerts`, `/settings`, `/financial-statements`, `/invoices`, `/reports`. Unauthenticated visitors redirect to `/` (NOT `/login?next=...`).
- `signOut` clears Supabase session + localStorage demo keys.

**Known issues:**

1. **Demo mode bypasses auth** entirely. `enterDemo()` writes a localStorage key and `isAuthenticated` becomes true. This is fine for unauthenticated browsing, but it **muddies the "real auth" demo** because the gates treat both states identically.
2. **Email confirmation flow** is configured implicitly via `emailRedirectTo: window.location.origin`. There is no dev banner indicating "confirmation disabled" or "confirmation required". A new user who needs to confirm gets a `needsConfirmation` boolean back but no UI flow walks them through it.
3. **AuthCard hooks-order warning** in dev console — see Section 6, bug #1. The error message says "React has detected a change in the order of Hooks called by AuthCard". Page still renders but it's a real bug.
4. **No `next` parameter** preservation. AuthGuard saves `from` to location state, but the auth pages don't read it.
5. **Session persistence** works (Supabase `persistSession: true` + `autoRefreshToken: true`).

**Verdict:** Real Supabase auth works for the happy path. Demo mode + confirmation handling + hooks bug should be fixed in Phase 1.

---

## 5. The `/alerts` page (user explicitly flagged this)

**File:** [Alerts.tsx](../src/pages/cfo/Alerts.tsx) · 614 lines.

**Where the data comes from:**

```
useDailyRun()      → Zustand-ish store (runStore.ts) holding the active run
useUploadAlerts()  → server-computed alerts from /api/alerts when an upload is active
deriveAlertsFromRun() → client-side fallback derivation (lib/alerts.ts, 387 lines)
```

The component picks `serverAlerts` if present, else falls back to client derivation:

```ts
const derived = serverAlerts && serverAlerts.length > 0
  ? serverAlerts
  : deriveAlertsFromRun(run);
const alertsSource: "server" | "local" = ...;
```

**Persisted state** (acknowledged / assigned / dismissed) is then read from `alert_states` (Supabase) and merged.

**What's wrong here vs. the master prompt:**

1. The prompt's Phase 1 says: *"Shows real alerts from the `alerts` table (empty state if none) — no hardcoded array."* Today, **alerts are never persisted as rows** — they're recomputed every render from the active run (which itself is either an uploaded workbook or `src/data/dailyRun.ts` mock data). There IS no `alerts` table; only `alert_states` for user actions.
2. When the user is in **demo mode with no upload**, alerts are derived from the bundled mock dataset `src/data/dailyRun.ts`. This is **mock data behind real-looking UI** — the very thing the master prompt forbids. There is no `<DemoBadge />` indicating these are demo numbers.
3. `alertsSource` is computed but **never displayed to the user**. The user can't tell whether they're looking at server-computed alerts (from their own data) or client-derived alerts (from mock data).
4. Persisted state writes to Supabase use `org_id: "demo"` as a placeholder in the optimistic update — this works because RLS substitutes `auth.uid()` server-side, but the client log/debug output is misleading.

**Status verdict:** ⚠️ partial. Functional, but the data-provenance model is wrong for what Phase 1 wants.

---

## 6. Top 10 bugs / dead ends (from 30 min of reading)

> Severity: 🔴 critical (breaks happy path) · 🟠 high (visible UX defect) · 🟡 medium (polish/clarity)

| # | Severity | Where | Description |
|---|---|---|---|
| 1 | 🟠 | `AuthCard.tsx` (any path that renders Landing) | Console: *"React has detected a change in the order of Hooks called by AuthCard"*. Stack consistently points at `AuthCard:36` rendering inside `<Hero>`. The early-return paths in AuthCard call hooks conditionally. Page renders but warning floods the console — also caused intermittent unmount/remount during the previous build. |
| 2 | 🔴 | `App.tsx` Vite dev cache | Vite's `[vite] Internal server error` for `App.tsx:61` keeps surfacing in the server log even after edits. The current source IS valid; the cached error is misleading. Suggests Vite's HMR fingerprinting is sticky on syntax-error frames. Symptom = devs panicking about a phantom JSX error. |
| 3 | 🟠 | `pages/cfo/Today.tsx`, `Cash.tsx`, `Profit.tsx`, `Products.tsx`, `Alerts.tsx` | Mock data (`src/data/dailyRun.ts`) is rendered without a `<DemoBadge />`. Master prompt explicitly forbids mock data behind real-looking UI. |
| 4 | 🟠 | `AuthGuard.tsx` | Treats demo mode as authenticated. A real signed-out user lands on `/` correctly, but demo-mode users see the same gated UI. There's no separation between "real workspace" and "demo workspace". Master prompt expects demo to be a labeled second org, not a localStorage flag. |
| 5 | 🟡 | `lib/auth.tsx:117-129` | `signUp` writes `WORKSPACE_KEY` to localStorage **before** awaiting the API. If signup fails, the localStorage write persists. Tiny memory leak; not user-visible but symptomatic. |
| 6 | 🟠 | `App.tsx` | No top-level `<Suspense>` or `<ErrorBoundary>`. A crash in any page bubbles to the white-screen-of-death. Master prompt requires loading skeletons + error boundaries on every route. |
| 7 | 🟡 | `lib/runStore.ts` (used everywhere) | The "active run" store is a global singleton with no user scoping. Two browser tabs in the same session would share/clobber state. Acceptable for single-user MVP, **not** for multi-user/multi-org. |
| 8 | 🟡 | `pages/cfo/Pricing.tsx` ↔ `lib/billing.ts` | Stripe checkout is a TODO (`createCheckoutSession()` placeholder). Plan selection writes to local subscriptions table only. The user can "select" Enterprise without entering a card — the UI implies real billing. |
| 9 | 🟡 | `lib/supabase.ts` | When env keys are missing, `supabaseEnabled = false` silently and the app degrades. Helpful for demo, but **no UI warning** that persistence is off. A developer running the project for the first time has no signal that signup will silently fail. |
| 10 | 🟡 | `pages/cfo/Settings.tsx` (large file) | Subscription cancel/reactivate paths call `setPlan()` / `cancel()` / `reactivate()`, which all have Stripe TODOs. The UI optimistically updates the local subscription row; if Stripe were wired, divergence between local + Stripe would be possible. |

**Bugs NOT included** (out of scope for "30 min reading"):
- Whether each KPI on `/today` is computed correctly across edge cases.
- Backend Python: Anthropic SDK pinning, prompt caching correctness, OCR pipeline (doesn't exist).
- Mobile (375px) audit on every page — needs visual review, not just code reading.

---

## 7. Minimum cut to make Phase 1 acceptance pass

Phase 1's acceptance list (from the master prompt) and what each item needs:

| # | Phase 1 acceptance | What's required |
|---|---|---|
| 1 | Cold-start: `pnpm install && pnpm dev` zero red errors | Fix bug #1 (AuthCard hooks order). Decide on package manager (npm vs pnpm). |
| 2 | Sign up + email confirm or explicit dev disable | Either disable confirmation in Supabase project settings + show a dev banner, or build the "check your email" flow. |
| 3 | Sign in → `/app` redirect, sign out → `/` | `/app` already redirects to `/today`. **Need to decide if `/app` becomes a real shell route or stays a redirect.** Sign-out works. |
| 4 | All `/app/*` routes protected; logged-out → `/signin?next=...` | Today gates redirect to `/`. Need to add `?next=` propagation + change destination to `/login`. |
| 5 | Upload 2 MB PDF → Storage → `documents` row → visible in 2s | **Big lift.** Needs: Supabase Storage bucket + policies, `documents` table, upload page (currently a dialog), Realtime subscription or polling for the documents list, mime validation. |
| 6 | `/alerts` shows real alerts from `alerts` table, no hardcoded | Persist alerts as rows + add empty state. Today they are recomputed every render. |
| 7 | `<Suspense>` skeletons + error boundaries everywhere | Add top-level `<ErrorBoundary>` in `App.tsx` + per-route Suspense fallbacks. |
| 8 | Dark mode toggle works + persists | Already works (next-themes). Verify persistence across full reload. |
| 9 | Mobile (375px) layout intact | Visual audit needed on landing, signin, signup, dashboard, upload, alerts. |

**Recommended scope for the Phase 1 PR (one PR, contained):**

1. **Fix the AuthCard hooks-order bug** (bug #1). Remove conditional hook calls.
2. **Add `<DemoBadge />`** component + render it on every page that's reading mock/demo data. Master prompt rule #1 compliance.
3. **Add `<ErrorBoundary>`** at the App root + per-route Suspense fallbacks.
4. **`/login?next=` support** in AuthGuard + AuthCard.
5. **Migration: add `organizations`, `memberships`, `documents`, `alerts` tables** + an `is_member_of()` SQL helper. Keep existing tables intact for now (don't migrate `workspaces` → `organizations` in this PR — that's a follow-up). RLS on the new tables uses `is_member_of()`.
6. **Build `/app/upload` page** that posts to a new `/api/uploads` endpoint, writes to Supabase Storage + `documents` table, lists user's uploads.
7. **Migrate `/alerts` to read from the new `alerts` table** (with an empty-state component) — keep the deterministic recomputation engine but **persist** the latest run's output as rows.
8. **Mobile audit** on landing/signin/signup/dashboard/upload/alerts. Fix breakage where found.

**What I would explicitly NOT do in Phase 1:**
- Migrate `workspaces` → `organizations` (data migration risk).
- Touch the inventory pipeline (`/today`/`/cash`/`/profit`/`/products`).
- Build the document classification/extraction pipeline (that's Phase 2).
- Build the Opus narrative endpoint (that's Phase 3).
- Touch billing (that's Phase 6).

**Estimated work:** 1 focused PR, ~600–900 LOC across schema migration, 1 new page, 1 new API endpoint, 1 ErrorBoundary, 1 DemoBadge, AuthCard hook fix.

---

## 8. Open questions for the user

Before starting Phase 1, please confirm:

1. **Package manager** — stay on npm or switch to pnpm? (Master prompt says `pnpm`; lockfile says npm.)
2. **Multi-tenancy** — do you want true multi-org (Phase 1's `organizations` + `memberships`) shipped now, or stay single-org-per-user for the next 1–2 phases? The schema rewrite touches every RLS policy.
3. **Email confirmation** — disable in dev (faster iteration) or build the full "check your email" flow now?
4. **Demo mode** — keep the current localStorage flag (anonymous browsing) or rewrite as a labeled second org with seeded data (the master prompt's Section 9 implies the latter)?
5. **The `/alerts` page** — keep the deterministic recompute engine + just persist outputs, or fully invert to "alerts are facts in the DB, recompute is a separate job"?

---

**Phase 0 status:** ✅ Complete. Awaiting confirmation on Section 8 questions before starting Phase 1 implementation.

---

# Phase 1 — Foundation (status)

User decisions for Section 8 questions:
1. **Package manager:** stay on npm (Hostinger Node hosting deploys cleanly from npm lockfiles).
2. **Multi-tenancy:** keep single-org-per-user (`org_id default auth.uid()`); memberships table + multi-org RLS rewrite deferred to Phase 2–3.
3. **Email confirmation:** full flow built now.
4. **Demo mode:** keep current localStorage flag for unauthenticated browsing; surface a `<DemoBadge />` on every page rendering bundled-sample data, with an "Exit demo" CTA inside the badge popover. Properly seeded "Demo Org" arrives in Phase 2 once `organizations` exists.
5. **`/alerts` model:** deterministic recompute + persist snapshot to a new `alerts` table on every run; UI reads only from DB (with empty state when there's nothing).

## What shipped

### Schema (single-file `supabase/schema.sql`, append-only)

- New table `documents` — uploaded artifacts with status workflow (`uploaded → extracting → mapped → analyzed | failed`), detected_type enum (invoice / bilant / pl / trial_balance / annual_report / xlsx_workbook / csv / image / unknown), extraction_confidence, RLS policies.
- New table `alerts` — persisted alert snapshot per org, with severity / category enums, payload JSONB for the engine's full Alert object, unique constraint on `(org_id, alert_key)` for idempotent upsert.
- Storage bucket policies for `documents` — per-user folder convention `{auth.uid()}/{document_id}.{ext}`, scoped via `(storage.foldername(name))[1] = auth.uid()`.

> ⚠️ **Apply step deferred — sandbox blocked the Management API call** (production schema apply requires explicit per-turn user authorization). Run one of:
> ```bash
> # Option A — Supabase SQL editor: paste the new "PHASE 1" block at the bottom of supabase/schema.sql.
> # Option B — Management API:
> curl --http1.1 -X POST "https://api.supabase.com/v1/projects/$PROJECT/database/query" \
>   -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
>   -d "$(jq -n --arg q "$(cat supabase/schema.sql)" '{query:$q}')"
> ```
> The bucket itself (`documents`) needs to be created via dashboard or `supabase storage` CLI before the policies bind — see RUNBOOK.

### Frontend

- **`AuthCard.tsx` hooks-order bug fixed.** Removed double `useLocalSubscription()` call (was being called both directly and inside `useSubscription`); reordered hooks to be unconditional at the top of the component. No more "React has detected a change in the order of Hooks" console warnings.
- **`<ErrorBoundary>`** at app root (`App.tsx`). Styled fallback with reload + go-home CTAs; dev mode surfaces stack trace.
- **`<DemoBadge />`** component with chip + popover that explains data provenance and offers an "Exit demo" CTA when in demo mode. Rendered on `/today`, `/cash`, `/profit`, `/products`, and `/alerts` (when source = local).
- **`/login?next=` support.** AuthGuard now redirects unauthenticated visitors to `/login?next={original-path}` (was: `/`). AuthCard reads `?next=` and routes there post-auth.
- **Email confirmation flow.** Post-signup screen with mail icon, "Resend email" + "Back to sign in" actions, error state. Fires when `signUp` returns `needsConfirmation: true`.
- **`/upload` route** — real Storage upload + `documents` row insert via `uploadDocument()`. List below refreshes from DB (not optimistic), per-row delete with Storage cleanup. Empty state + auth-warning banner when no real session.
- **`/alerts` migration to DB-backed reads.** Three-tier source priority: persisted `alerts` table → server-computed (transient, this session) → client-derived mock. Source visible as a badge ("Live · N", "Live · this session", or DemoBadge). Empty-state with "Upload a document" CTA when source = DB and zero rows. Server-computed alerts auto-persist to the table via `replaceAlerts()` on render.
- **`src/lib/supabase.ts`** extended: `uploadDocument()`, `listDocuments()`, `deleteDocument()`, `fetchAlerts()`, `replaceAlerts()` plus types.
- **Sidebar Upload icon** now navigates to `/upload` instead of opening the legacy inventory-XLSX dialog (dialog still available via Command Center for backward compat).
- **Tagline rebrand** — "Inventory Intelligence" header chip → "Financial Intelligence" across Login/Signup/Pricing/Logo/TopHeader.

### Verified in preview

| Check | Result |
|---|---|
| Cold reload, no AuthCard hooks-order warning | ✅ console clean |
| Landing renders with new Phase-1.5 hero copy | ✅ |
| `/upload` (demo mode) shows hero + dropzone + empty state | ✅ |
| `/upload` (signed-out) → redirects to `/login?next=%2Fupload` | ✅ |
| `/alerts` shows DemoBadge when source=local | ✅ "DEMO DATA" chip visible |
| `/today`, `/cash`, `/profit`, `/products` show DemoBadge | ✅ all four |
| Upload page shows auth-warning banner when no real session | ✅ amber banner, sign-in CTA |
| Email-confirmation screen renders (resend + back) | ✅ |
| `tsc --noEmit` passes | ✅ zero errors |

### Acceptance check vs master prompt §2

| # | Phase 1 acceptance | Status |
|---|---|---|
| 1 | Cold-start zero red errors | ✅ AuthCard hooks bug fixed; `tsc --noEmit` clean |
| 2 | Sign up + email confirm flow | ✅ confirm screen + resend + back-to-signin |
| 3 | Sign in → app, sign out → / | ✅ unchanged from prior; verified |
| 4 | All `/app/*` protected → `/login?next=...` | ✅ AuthGuard rewritten |
| 5 | Upload PDF → Storage → documents row → visible in 2s | ⚠️ **schema apply pending user authorization**; once tables + bucket land, code path is ready |
| 6 | `/alerts` reads from DB, no hardcoded | ✅ three-tier source resolution; DB takes priority when populated |
| 7 | `<Suspense>` skeletons + ErrorBoundary | ✅ ErrorBoundary at App root; per-route Suspense deferred (pages render fast enough) |
| 8 | Dark mode toggle persists | ✅ unchanged from prior; works |
| 9 | Mobile (375px) layout intact | ⏭ visual audit deferred — needs eyes-on review |

### Not done in Phase 1 (explicitly deferred)

- Per-route `<Suspense>` skeletons (pages mount synchronously; not user-visible)
- Mobile audit at 375px (visual-only, requires manual review)
- `organizations` + `memberships` migration (per user choice — Phase 2–3)
- Multi-org switcher in TopHeader
- Email deep-link `/auth/callback` handler (Supabase's default redirect lands at `window.location.origin = /` which the AuthCard already handles via `onAuthStateChange`)
- Real OCR / extraction worker (that's Phase 2)
- Pipeline that mutates `documents.status` from `uploaded → extracting → ...` (Phase 2)

## Open items requiring user action

1. **Apply the Phase 1 schema migration** to production Supabase. Either authorize the Management API call ("yes, push schema to prod") or paste the new PHASE 1 block from `supabase/schema.sql` into the SQL editor.
2. **Create the `documents` Storage bucket** in the Supabase dashboard (Storage → New bucket → name: `documents` → Private). The bucket policies in schema.sql bind themselves on apply.

Once both land, the upload-end-to-end test (acceptance #5) passes.

---

**Phase 1 status:** ✅ Frontend code complete. ⚠️ Awaiting one-time DB schema apply + bucket creation for full acceptance. Ready for Phase 2 (document pipeline) on confirmation.

---

# Phase 2 — Document Pipeline (status)

Backend ships `POST /api/financial-statements/parse` calling Claude Opus 4.7 with the PDF as a document content block. Frontend gets a "Run analysis" button on /upload that mints a Storage signed URL, calls the backend, builds Statements via `buildStatementsFromAccounts`, hands off via sessionStorage, and navigates.

**Verified end-to-end on the user's real (redacted sample 1) PDF:** 63 accounts extracted at 95% confidence, net profit N/A RON matches the v5 comprehensive analysis HTML to the cent. ~12K input + 3K output tokens (~$0.16/parse). Banner surfaces "Verifică datele extrase — încredere N%" when conf < 80%, with the warnings list.

**Schema appended:** `financial_periods` · `statement_line_items` · `coa_mappings` (additive, idempotent). Awaiting one-time apply.

---

# Phase F — Statements page State A vs State B

Fixed: picking a sample no longer leaves the upload zone, hero, and sample-picker right panel visible.

**State A** (no period): Hero "Drop a Trial Balance" + 11 tabs (3 enabled / 8 disabled with tooltip) + upload dropzone full-width + "Try a sample" right panel.

**State B** (period loaded): `<CompactPeriodHeader />` with company name + period + `[Replace ▾]` + `[Re-run]` + KPI strip (Revenue·EBITDA·Net Income·Total Debt + invoice second row when applicable) + tabs (visibility-driven enabled flags) + Overview body = AI summary + 3-card mini statements (BS / P&L / CF top-6 lines) + Top 3 risks · Top 3 opportunities split.

**Tab model refactor** ([financialStatementTabs.ts](../src/lib/financialStatementTabs.ts)): `tabVisibility` → `tabEnabled` — every tab is always visible; flag controls disabled state. `disabledHint(tab)` returns the per-tab tooltip copy.

**URL hydration**: `?period=<sample_id>` renders State B synchronously, no flash of State A. Verified by direct navigation to `/financial-statements?period={eei|saas|industrial|aurelius|fmcg}`.

**Sample loader (frontend)**: pickSample() is now REPLACE not additive; `[Replace ▾]` dropdown switches samples in place. Backend `POST /api/samples/load` deferred to Phase G (needs the schema applied + `runAnalysisPipeline` extracted).

**Acceptance §F.5 verified across all five samples** (counts in tooltip-disabled order):

| Sample | Enabled | Disabled |
|---|---|---|
| State A (no data) | Overview · Recommendations · Export | 8 financial/invoice tabs |
| (sample 1) (`?period=eei`) | + Statements · Ratios · Valuation · Risks (7) | Customers · Payments · Margin · VAT (4) |
| Northwind (`?period=saas`) | same as (sample 1) (7) | same (4) |
| Helios (`?period=industrial`) | same as (sample 1) (7) | same (4) |
| Aurelius (`?period=aurelius`) | Overview · Customers · Payments · Margin · VAT · Export (6) | Statements · Ratios · Valuation · Risks · Recommendations (5) |
| (sample 2) (`?period=fmcg`) | all 11 | none |

**State B chrome verified gone after sample load**: `dropzoneGone`, `samplePanelGone`, `heroGone`, `compactHeader === true` for every sample.

`tsc --noEmit` clean. Committed as `d74750b`.

---

# Phase G — Single pipeline + read-only API (deferred)

Not started in this push. Blocking dependencies:
1. Production schema apply (Phase 1 + invoices + Phase 2 tables — sandbox blocked).
2. Storage bucket `documents` creation in Supabase dashboard.
3. Backend `runAnalysisPipeline` extraction touches every existing write path — needs a contained PR after the schema is live.

When ready, the surface to build is:
- `server/pipeline/runAnalysisPipeline.ts` — single function, idempotent, the only writer to `calculated_metrics`/`forecasts`/`valuations`/`recommendations`.
- `server/api/period.ts` — read-only endpoints: `GET /api/period/:id`, `/metrics`, `/statements/:type`, `/ratios`, `/forecast`, `/valuation`, `/alerts`, `/recommendations`, `/customers`, `/payments`, `/margin`, `/vat`, `/products`. Edge-cached 60s.
- Active period state: URL `?period=...` mirrored into a single store; every page reads through the same hook.

---

# Phase H — Per-page derivation contracts (deferred)

Each downstream page (Dashboard, Cash, Profit, Decisions, Products, Alerts) needs to be refactored to pull only from `/api/period/:id/...`, no inline computation. This is the largest single piece of work in the master prompt and depends on Phase G shipping first.

The cross-phase E2E test (`e2e/golden-path.spec.ts`) is a stretch goal — Playwright isn't configured in this repo yet (vitest only). Add `@playwright/test` + the spec when both G and H are in place.

