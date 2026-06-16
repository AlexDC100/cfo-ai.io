# PUBLIC_TEST_MODE — Operator Handoff

> **Purpose:** Keep `cfo-ai.io` live and publicly reachable as an open
> preview — no login, no billing, banner on every page. The codebase
> still supports real auth + billing; the test posture is gated entirely
> behind one BE env var and one FE env var, with one SQL seed.

> **Last updated:** 2026-05-30

---

## TL;DR

```
# Turn ON
1. Apply supabase/schema_phase_test_mode.sql (one-time, idempotent)
2. /opt/cfo-ai/.env   →  add  PUBLIC_TEST_MODE=1
3. scandi-desk-main/.env.production  →  add  VITE_PUBLIC_TEST_MODE=1
4. ./scripts/deploy.sh --frontend --backend --yes

# Turn OFF
1. /opt/cfo-ai/.env   →  remove (or set to 0)  PUBLIC_TEST_MODE
2. scandi-desk-main/.env.production  →  remove (or set to 0)  VITE_PUBLIC_TEST_MODE
3. ./scripts/deploy.sh --frontend --backend --yes
```

The seed rows from step 1 (turn-on) are safe to leave in place after
turn-off — they're inert unless the flag is on. Removing them is optional
clean-up; see "Physical clean-up" at the bottom.

---

## What test mode does (visitor-visible)

| Surface                | Test mode ON                                                                        | Test mode OFF (normal posture) |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------ |
| Persistent top banner  | Amber bar: "TEST MODE — open preview. No login required. Uploads are visible to other visitors. Do not upload confidential or production data." | Hidden                         |
| `/`                    | Redirect → `/dashboard`                                                             | Landing page                   |
| `/login`, `/signup`    | Redirect → `/dashboard`                                                             | Sign-in / sign-up forms        |
| `/auth/callback`       | Redirect → `/dashboard`                                                             | Supabase token exchange        |
| `/pricing`             | Redirect → `/dashboard`                                                             | Pricing table                  |
| `/dashboard` and all gated routes | Render for everyone with synthetic identity (`Test visitor`, workspace `Test workspace`) | Require sign-in via AuthGuard |
| Upload, ratios, ratios, briefing, chat, peers, NASDAQ search | All work; all data lands in shared test workspace | Per-user / per-org workspace |
| Stripe checkout, plan picker, doc-quota gate, chat-cap gate | All bypassed — every action returns "allowed/unlimited" | Enforced per plan |
| AccountMenu / Settings → Billing | Still mounted (no UI changes in this pass); upgrade buttons are reachable but go nowhere because /pricing redirects | Functional |

**Workspace state at first visit:** the shared test org starts empty for
real user uploads. The FE's `resolveSample` fixtures (Scandia, EEI,
Carniprod, etc.) still appear in the period picker — they're shipped in
the FE bundle, not stored in the DB. Real uploads from visitors append to
the same shared test org and are visible to everyone (per the F3.27
shared-test-org tradeoff stated in the banner copy).

**Anonymous-visitor data exposure:** the test user lands in an
**isolated synthetic workspace** (`Test workspace`, org_id
`00000000-0000-4000-8000-000000000002`). Real organization data
(Scandia, Carniprod, EEI, etc.) is *not* exposed via this workspace
because the BE's `_primary_org_for_user(TEST_USER_ID)` resolves to the
test org only, and the period-list endpoint scopes by org_id. The
fictional sample periods rendered by the FE come from the in-bundle
`resolveSample` map and are demo data, not production data.

---

## How to turn it ON

### 1. Apply the SQL seed (one-time)

Run `supabase/schema_phase_test_mode.sql` against the production Postgres
once. From the Supabase Studio SQL editor:

```sql
-- Paste the file contents (or use the Supabase SQL editor `Run` button
-- after opening supabase/schema_phase_test_mode.sql).
```

What it creates:

- `auth.users` row id `00000000-0000-4000-8000-000000000001` (email
  `test@cfo-ai.io`) — required to satisfy the `memberships.user_id` FK.
- `organizations` row id `00000000-0000-4000-8000-000000000002`
  (`Test workspace`, industry `food_manufacturing`, currency RON).
- `memberships` row linking the two with role `owner`.

All three INSERTs use `ON CONFLICT DO NOTHING` — re-running the file is a
no-op.

After running, click **Settings → API → Reload schema cache** in the
Supabase Dashboard (per the F3.24 schema-migration discipline locked in
`CLAUDE.md §14`). Since this migration is data-only and ships no DDL,
the reload is best-effort — the BE will still work without it — but the
discipline is to click it every time.

### 2. Set the BE env var

```bash
ssh root@<vps>
cd /opt/cfo-ai
# Append:
echo "PUBLIC_TEST_MODE=1" >> .env
# Optional overrides (only if the operator wants different UUIDs than
# the defaults baked into _test_mode.py — usually leave these unset):
# echo "TEST_USER_ID=00000000-0000-4000-8000-000000000001" >> .env
# echo "TEST_ORG_ID=00000000-0000-4000-8000-000000000002"  >> .env
```

The BE reads `PUBLIC_TEST_MODE` on every request (no cache), so flipping
it back to "0" doesn't strictly require a restart — but the deploy script
restarts the backend container regardless, which is the clean path.

### 3. Set the FE env var

The FE flag is read at build time from `import.meta.env`. Edit the prod
env file used by the Vite build:

```bash
# On the local dev box (where ./scripts/deploy.sh --frontend runs from):
cd scandi-desk-main
# Add to .env.production (create if missing):
echo "VITE_PUBLIC_TEST_MODE=1" >> .env.production
# Optional overrides (only if the operator wants different UUIDs than
# the defaults baked into testMode.ts):
# echo "VITE_TEST_USER_ID=00000000-0000-4000-8000-000000000001" >> .env.production
# echo "VITE_TEST_ORG_ID=00000000-0000-4000-8000-000000000002"  >> .env.production
```

If you override UUIDs, **the BE and FE values must match**, AND they must
match the rows inserted by the SQL seed.

### 4. Deploy

```bash
./scripts/deploy.sh --frontend --backend --yes
```

The frontend rebuild bakes `VITE_PUBLIC_TEST_MODE=1` into the bundle; the
backend restart re-reads `/opt/cfo-ai/.env`. The deploy script's standard
post-deploy verification still runs.

### 5. Verify

Open `https://cfo-ai.io` in an incognito window:

1. Amber banner across the top — text starts with "TEST MODE —".
2. `/` redirects to `/dashboard`. The dashboard renders without a sign-in
   screen.
3. `/login`, `/signup`, `/pricing` all redirect to `/dashboard`.
4. The workspace label in the top header reads `Test workspace`.
5. Try an upload — it lands on the shared test org. Try chat — it works
   without hitting any cap. Try `/settings/billing` — the page still
   loads (no UI hiding in this pass), but no Stripe call goes out from
   any action.

---

## How to turn it OFF

```bash
# BE:
ssh root@<vps>
sed -i '/^PUBLIC_TEST_MODE=/d' /opt/cfo-ai/.env

# FE:
sed -i '/^VITE_PUBLIC_TEST_MODE=/d' scandi-desk-main/.env.production

# Deploy:
./scripts/deploy.sh --frontend --backend --yes
```

After this:

- Banner disappears (TestModeBanner returns null when flag is off).
- AuthGuard resumes enforcing sign-in. `/login` + `/signup` work
  normally.
- BE billing endpoints resume enforcing per-plan quotas; Stripe
  checkout works.
- The seed rows from step 1 of turn-on remain in the DB but are
  inert — no one signs in as `test@cfo-ai.io` (we never set a password),
  and the synthetic org never appears in any other user's memberships.

To verify OFF: open incognito `https://cfo-ai.io` — Landing page should
render (no banner, no redirect from `/`).

---

## Physical clean-up (optional)

If you want to remove the seed rows entirely after retiring test mode,
run in Supabase Studio:

```sql
delete from memberships where user_id = '00000000-0000-4000-8000-000000000001';
delete from organizations where id   = '00000000-0000-4000-8000-000000000002';
delete from auth.users    where id   = '00000000-0000-4000-8000-000000000001';

notify pgrst, 'reload schema';
```

Click **Settings → API → Reload schema cache**.

This also wipes any uploads the test users made into the test org
(`organization_id` FK with `ON DELETE CASCADE` ripples through the
periods + extracts + briefings).

---

## Files involved

| File                                                           | Role                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| `src/engine/api/_test_mode.py`                                  | BE single source of truth — flag check, sentinel UUIDs, JWT bypass placeholder |
| `src/engine/api/_billing.py`                                    | `_require_jwt` + `_user_id_from_jwt` short-circuit on test mode |
| `src/engine/api/pipeline.py`                                    | Same two helpers — short-circuit on test mode              |
| `src/engine/api/ask.py`                                         | `_require_jwt` short-circuit                              |
| `src/engine/api/_plan_state.py`                                 | `check_doc_quota`, `record_doc_consumed`, `check_chat_cap`, `record_chat_used` — all bypass on test mode |
| `scandi-desk-main/src/lib/testMode.ts`                          | FE flag + synthetic identity constants                     |
| `scandi-desk-main/src/components/cfo/TestModeBanner.tsx`        | The amber top banner                                       |
| `scandi-desk-main/src/components/cfo/AuthGuard.tsx`             | Bypasses auth + onboarding bounce in test mode             |
| `scandi-desk-main/src/lib/auth.tsx`                             | AuthProvider injects synthetic signed-in identity          |
| `scandi-desk-main/src/App.tsx`                                  | Mounts TestModeBanner + redirects login/signup/pricing to /dashboard |
| `scandi-desk-main/src/vite-env.d.ts`                            | TypeScript declarations for `VITE_PUBLIC_TEST_MODE` etc.   |
| `supabase/schema_phase_test_mode.sql`                           | Seed: test auth.users + organization + membership          |
| `docs/test-mode-handoff.md`                                     | This file                                                  |

---

## Failure-mode reasoning

**Q: What if the FE bundle has `VITE_PUBLIC_TEST_MODE=1` but the BE
doesn't have `PUBLIC_TEST_MODE=1`?**

A: The FE shows the banner, hides login, and acts as if a synthetic user
is signed in — but every API call hits a BE that still requires a JWT,
and Supabase will reject all writes. The visitor sees an unauthenticated
"signed in" UI that 401s on every action. **Always flip BE and FE
together.**

**Q: What if BE has the flag but FE doesn't?**

A: The FE still shows the login wall (`AuthGuard` redirects to `/login`,
no banner), but the BE accepts every request and treats it as the test
user. Visitors can't reach the BE through the FE; only a CLI / curl
caller could exploit this. Less catastrophic but still incorrect. Again:
flip together.

**Q: What if the seed rows aren't applied but the flag is on?**

A: BE writes (uploads, chat-history inserts) fail with FK violations on
the `organization_id` column because `_primary_org_for_user(TEST_USER_ID)`
returns None. Visitor sees a broken upload flow. Always apply the SQL
seed before flipping the flag.

**Q: Can I roll back without the deploy script?**

A: If the deploy script is broken, you can flip the BE flag live by
SSHing in and editing `/opt/cfo-ai/.env`, then running
`docker compose up -d backend` from `/opt/cfo-ai/`. The FE flag is
build-time only — you can't flip it without a frontend rebuild.

---

## Pending UI follow-ups (not in this pass)

Per scope discipline ("Don't change anything else. This is access posture
+ disclosure only."), these surfaces were left untouched but could be
tightened in a future pass if test mode runs for an extended window:

- **AccountMenu** — still shows "Sign out" CTA (no-op in test mode but
  visually present). Should hide when `isPublicTestMode`.
- **Sidebar / TopHeader** — "Upgrade plan" CTA, account avatar, settings
  link all still mounted. Should hide / disable in test mode.
- **Settings → Billing page** — still reachable via direct URL; renders
  empty / trial-tier state because the synthetic user has no
  subscription row. Should redirect to /dashboard when test mode is on.
- **Pricing** route already redirects to /dashboard; PricingV2 internal
  card components still ship in the bundle.

None of these block the "open preview" posture — they're cosmetic
tightenings.
