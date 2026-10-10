# supabase/ — migration order

> Written 2026-10-10 (owner addendum of that day, item 2: "every change applied to
> production must exist as a committed migration file in the repo, in the order
> applied, so a fresh database built from the repo matches production").
> Everything below is traced to a file header under `supabase/`, to a CLAUDE.md
> section (§14, §16, §27, §29, §31, §32, §33) or to a timestamped entry of the
> session's `specs-durable/ops_log.md`. Where a fact could not be traced it says so.

There is no migration runner in this project. Each file is applied by hand, once,
in the order below, with the **two-step protocol of CLAUDE.md §14** for anything that
adds or changes a table or column:

1. run the file — in Supabase Studio, or from a checkout with
   `supabase db query --linked -f supabase/<file>.sql` (one batch, executed as
   `postgres`; only the LAST statement's rows come back);
2. immediately click **Supabase Dashboard → Settings → API → "Reload schema cache"**.
   The `NOTIFY pgrst, 'reload schema'` at the bottom of each file is optimistic on
   Supabase's managed PostgREST; the Dashboard click is the deterministic step.
   Then verify through the REST API (`GET /rest/v1/<table>?select=<new column>&limit=1`
   must answer 200), never through `pg_catalog` alone.

A REVOKE, a dropped policy, a trigger or a new index needs no reload (Postgres
enforces them on the next statement — measured 2026-10-04 09:43Z with no NOTIFY sent),
but the click is kept as discipline.

`scripts/check_migrations_applied.sh` probes the production database for every
table and column the files declare (indexes, policies, functions are reported as
unverifiable); its `DECLARED_NOT_APPLIED` list in `scripts/check_migrations_applied.py`
is the authoritative list of files production deliberately does NOT have (section A.4).

---

## A. Base files, in dependency order

The order is read from each file's own "Apply after …" / "depends on …" sentence
and, where a file has none, from the objects it alters. Every file is idempotent
unless its row says otherwise. "Prod" = present in production on 2026-10-04
(catalog read with the Supabase CLI, ops_log 03:35Z; 59 public tables), or declared
absent by `check_migrations_applied.py`.

### A.1 Foundation

| # | file | what it creates / why it is here | order rule (source) | prod |
|---|---|---|---|---|
| 1 | `schema.sql` | profiles, documents, financial_periods, alerts, recommendations, subscriptions, usage, signup trigger `handle_new_user` … | first; "apply once … re-running is safe" (header). **The committed version no longer creates the two `subscriptions` write policies** (15d9d120, §29); a checkout older than 2026-10-03 does — see D.2 | yes |
| 2 | `schema_phase3.sql` | organizations, memberships, `is_member_of()`, `handle_new_user_v2`, pipeline persistence (briefings, line items, metrics) | "AFTER schema.sql" (header) | yes |
| 3 | `schema_phase4_multicountry.sql` | countries, coa_registries, coa_account_mappings | "after schema.sql + schema_phase3.sql" (header) | yes |
| 4 | `schema_phase5_usage_limits.sql` | `subscriptions.tier`, user_usage, founding_members, contact-sales leads, two views | "AFTER schema.sql + any earlier phaseN" (header) | yes |
| 5 | `schema_phase_security_hardening.sql` | the two phase-5 views become `security_invoker`, anon/authenticated revoked, PUBLIC EXECUTE revoked on SECURITY DEFINER functions | **after** phase5 — and **again after any re-run of phase5** (header ⚠, §16) | applied 2026-07-23 (§16) |
| 6 | `schema_phase6_dedupe.sql` | `documents.content_hash` + period delete cascade | additive on `documents` | yes |
| 7 | `schema_phase7_benchmarks.sql` | CAEN mapping + `industry_benchmarks` | after schema.sql (`calculated_metrics`) | yes |
| 8 | `schema_phase7b_benchmarks_deep.sql` | peers, leader reasons, dynamics | after phase7 (extends it) | yes |
| 9 | `schema_phase_valuation_benchmarks.sql` | the `industry_key`-shaped rows `_valuation.py` reads | after phase7 (same table) | not read — not in `DECLARED_NOT_APPLIED` |
| 10 | `schema_phase_f3_calibration.sql` | calibration_rules / fixtures / results | "after schema_phase4_multicountry.sql" (header) | yes (`calibration_*` present) |
| 11 | `schema_phase_f4_canonical_v1.sql` | `financial_periods.assembled_canonical_v1` | "after schema_phase_f3_calibration.sql" (header) | yes |
| 12 | `schema_phase_f4_3_detection_envelope.sql` | `financial_periods.detection_envelope` | "after schema_phase_f4_canonical_v1.sql" (header) | yes |
| 13 | `schema_phase_notes_period_scope.sql` | `alerts.period_id`, recommendations scoped to a period | after schema.sql; the file whose non-application broke alerts for months (`check_migrations_applied.py` WHY) | yes |
| 14 | `schema_phase_period_end_hint.sql` | `documents.period_end_hint` | additive on `documents` | yes |
| 15 | `schema_phase_sku_dio_columns.sql` | DIO columns on `sku_aggregates` | additive — **`sku_aggregates` itself is created by no committed file** (section E) | yes |
| 16 | `schema_phase_sku_lines_dio.sql` | `sku_lines.dio_days` | additive — **`sku_lines` itself is created by no committed file** (ticket T55) | yes |
| 17 | `schema_phase_industry_intelligence.sql` | industry_profiles, aliases, assignments, change audit | after phase3 (`organizations.caen_code`) | yes (`industry_*` present) |

### A.2 Workspaces, chat, preferences (CLAUDE.md §16 states this order)

| # | file | what | order rule | prod |
|---|---|---|---|---|
| 18 | `schema_phase_multi_workspace.sql` | workspace == organization; `archived_at` / `purge_after`; user_prefs; RPCs `list/create/archive/restore/purge_expired_workspaces` | after phase3; **read its pre-flight query first** (must return all zeros — it drops `org_id … default auth.uid()` from 10 tables) | yes |
| 19 | `schema_phase_chat.sql` | chat_threads / chat_messages | "Apply schema_phase_multi_workspace.sql FIRST" (header) | yes |
| 20 | `schema_phase_prefs.sql` | org_prefs, `set_user_pref` / `set_org_pref` | after the other two (§16 Milestone C) | yes |
| 21 | `schema_phase_allow_delete_last_workspace.sql` | archive_workspace may archive the last workspace | "after schema_phase_multi_workspace.sql" (header) | yes |
| 22 | `schema_phase_workspace_purge_now.sql` | `purge_workspace()` ("Delete forever") | after multi_workspace | yes (`purge_workspace` executable) |
| 23 | `schema_phase_storage_purge_fix.sql` | sets `storage.allow_delete_query` around the purge's object delete | after workspace_purge_now (it fixes `_purge_org_data()`) | assumed (not read) |
| 24 | `schema_phase_workspace_purge_now_hold.sql` | a held archive (`purge_after` NULL) can never be purged from the hub | "AFTER schema_phase_workspace_purge_now.sql"; **re-run after any re-run of purge_now** (header) | assumed (not read) |
| 25 | `schema_phase_archive_hold_guard.sql` | a held archive can be neither re-archived with a date nor restored behind the operator | "AFTER multi_workspace, allow_delete_last_workspace AND workspace_purge_now_hold"; **re-run after any re-run of the first two** (header) | assumed (not read) |
| 26 | `schema_phase_account_deletion.sql` | `delete_all_my_data()`, `delete_my_account()` | after the workspace files (it erases workspaces) | yes (both functions present, 03:35Z) |

### A.3 Pricing, billing, mail, rates, briefings

| # | file | what | order rule | prod |
|---|---|---|---|---|
| 27 | `schema_phase_pricing_v2.sql` | `intro_unlock_expiry`, extra-docs columns on `subscriptions` | after phase5 | yes (columns present) |
| 28 | `schema_phase_pricing_v2_tier_check.sql` | the `tier` CHECK accepts trial / intro / starter / pro | after pricing_v2 | yes |
| 29 | `schema_phase_pricing_v3_atomic.sql` | reserved counters + the six atomic RPCs (`reserve/commit/release_user_upload`, `…_user_chat`), service_role only | after pricing_v2; **required by the `chat-llm` function** (§32: the function fails closed without them) | yes (chat pre-flight `ready: true`, ops_log 07:55Z) |
| 30 | `schema_phase_plan_caps.sql` | `create_workspace()` body replaced with the per-tier cap; non-RO meter columns + RPCs | after multi_workspace AND pricing_v3 (same reservation model) | yes (`nonro_*` columns present) |
| 31 | `schema_phase_document_quota_ledger.sql` | what the plan has counted, per document, where the browser cannot write | after plan_caps | yes |
| 32 | `schema_phase_billing_events.sql` | Stripe webhook idempotency log | after phase5 | yes |
| 33 | `schema_phase_newsletter.sql` | newsletter_subscribers, email_send_log, broadcasts, **renewal_email_queue** | after schema.sql | yes (`renewal_email_queue` present) |
| 34 | `schema_phase_fx_rates.sql` | `fx_rates_cache` for the `fx-rates` Edge Function | standalone | yes |
| 35 | `schema_phase_briefing_ebitda_definition.sql` | `briefings.ebitda_definition` | after phase3; apply BEFORE the backend that writes it (header) | applied 2026-09-27 12:37Z (§25) |
| 36 | `schema_phase_valuation_ebitda_definition.sql` | `user_valuation_assumptions.ebitda_definition` | same | applied 2026-09-27 12:37Z (§25) |
| 37 | `schema_phase_briefing_stale.sql` | `briefings.stale_since` / `stale_reason` (a failed regenerate keeps the last good briefing) | after phase3; apply BEFORE the briefing hotfix backend (ops_log 2026-10-03 ~18:35Z) | applied by the owner before 2026-10-04 06:58Z (ops_log 05:10Z, 06:58Z) |

### A.4 Files production deliberately does NOT have

From `scripts/check_migrations_applied.py` `DECLARED_NOT_APPLIED` (each with its reason
there) and the production read of 2026-10-04 03:35Z. **Skip these when building a
database that must match production.** A development database that wants the whole
surface applies them in this order:

| file | reason it is absent in production | order if applied |
|---|---|---|
| `schema_phase_firm.sql` | Firm Cockpit is hidden; the firm surface is unbuilt (`create_firm`, `import_firm_client` absent, 03:35Z) | after multi_workspace |
| `schema_phase_firm_attention.sql` | part of the Cockpit | after firm |
| `schema_phase_firm_requests.sql` | part of the Cockpit; "schema_phase_firm.sql MUST be applied before this file" (header) | after firm_attention |
| `schema_phase_radar.sql` | anomaly radar hidden, router not mounted | after f4_canonical_v1 |
| `schema_phase_nasdaq_public_companies.sql` | superseded: no path reads its five tables (ruling 2026-09-18) | after f4_canonical_v1 (header) |
| `schema_phase_intelligence_engine.sql` | no live surface reads it | after nasdaq_public_companies |
| `schema_phase_public_tables_write_revoke.sql` (H3) | its twelve tables are absent in production (ops_log 2026-10-04 09:45–09:47Z: "ABSENT — not applied") | "after schema_phase_nasdaq_public_companies.sql and schema_phase_intelligence_engine.sql" (header) |
| `schema_phase_dashboard_config.sql` | the table is absent (03:35Z) — the router IS mounted since 2026-07-26 (§31 correction) but writes through the service role | after multi_workspace |
| `schema_phase_dashboard_config_caller.sql` (H2) | its function is absent (not applied, 09:45–09:47Z) | after dashboard_config; **re-run after any re-run of dashboard_config** (header ⚠) |
| `schema_phase_3b5_pre_backfill_snapshot.sql` | one-off backfill column; the backfill is finished | — |
| `schema_phase_public_funnel.sql` | the funnel writes `engine.public_ro`'s own store | — |
| `schema_phase_test_mode.sql` | **test mode only** — seeds the synthetic test user/workspace; "Only run … when the deployment will be flipped into PUBLIC_TEST_MODE" (header). Never on production (the test identities there are banned — section E) | last, local stacks only |

---

## B. The 2026-10 restrict-only files, in the order applied to production

All applied with `supabase db query --linked -f <file>` by the coordinator; each file is
ONE transaction that returns one jsonb row saying what it did, each takes a
fingerprint (row count + content hash) of every row it could touch before and after
and refuses to commit if a row changed. Outputs: the session's
`specs-durable/prod_sql/out/`. Apply them **after every file of section A** on a fresh
database (a `create table` hands Supabase's default grants out again; D.2).

| when (ops_log) | file | what it closes | pre-flight / post-check (read-only) |
|---|---|---|---|
| 2026-10-04 09:43Z | `schema_phase_subscriptions_write_lockdown.sql` | entitlement tables (`subscriptions`, `user_usage`, `plan_chat_daily_usage`, `document_quota_ledger`, `founding_members`, `billing_events`, `renewal_email_queue`, `plan_assignment_audit` where it exists) are written by the service role only: every non-SELECT policy dropped, every privilege revoked from anon/PUBLIC, writes (and MAINTAIN) revoked from authenticated | `schema_phase_subscriptions_write_lockdown_preflight_report.sql` (`verdict.fully_locked` must be true after), `…_audit_report.sql` (`row_fingerprints` equal before/after) — §29 |
| 2026-10-04 09:45Z | `schema_phase_workspace_cap_guard.sql` (H1) | trigger `organizations_guard_write`: a browser session cannot write `archived_at` / `purge_after` / `firm_id` / `cui`; a restore (or create) is held to `create_workspace`'s own cap under a per-user advisory lock. No function replaced (md5 of the workspace functions checked before/after) | `preflight/schema_phase_workspace_cap_guard_preflight_report.sql` — §31 |
| 2026-10-04 09:46Z | `schema_phase_signup_tier_trial.sql` (H4) | the signup trigger's function (`handle_new_user_v2`, and the unattached `handle_new_user`) seeds `tier = 'trial'` — FORWARD ONLY, no existing row read | `preflight/schema_phase_signup_tier_trial_preflight_report.sql` — §31 |
| 2026-10-04 09:53Z | `schema_phase_calibration_queue_write_revoke.sql` (H3c) | INSERT/UPDATE/DELETE/TRUNCATE revoked from anon/authenticated on `calibration_rules` (8 privileges) | `preflight/schema_phase_calibration_queue_write_revoke_preflight_report.sql`; "Run this file after supabase/schema_phase_f3_calibration.sql" (header) |
| 2026-10-04 09:53Z | `schema_phase_derived_tables_write_revoke.sql` (H3b) | the same revoke on the six engine-written tables `statement_line_items`, `calculated_metrics`, `briefings`, `benchmark_reports`, `sku_analyses`, `org_coa_mappings_overrides` (48 privileges); SELECT untouched | `preflight/schema_phase_derived_tables_write_revoke_preflight_report.sql` |
| 2026-10-10 03:14Z | `schema_phase_email_idempotency.sql` | ADDS one unique index `renewal_email_queue_dedupe_uidx` (one reminder per subscription × template × renewal date) — "adds only", allowed by the owner order of 2026-10-10 | the session's `prod_sql/read_17_email_idempotency_preflight.sql` (duplicate_groups must be 0); after `schema_phase_newsletter.sql`; "apply it before a scheduler is pointed at the cron" (header) |

Not applied, their objects being absent in production: `schema_phase_dashboard_config_caller.sql`
(H2) and `schema_phase_public_tables_write_revoke.sql` (H3) — see A.4. They stay in the
repository for fresh environments and would be applied right after the files that
create their objects.

---

## C. Files that are REPORTS or PRE-FLIGHTS — never "apply" them

Each is one read-only statement (or a set of SELECT grids) returning one jsonb row.
They change nothing and are meant to be run BEFORE and AFTER the migration they belong to.

| file | belongs to | what it answers |
|---|---|---|
| `schema_phase_subscriptions_write_lockdown_preflight_report.sql` | lockdown | `report.verdict`: `hole_open` / `stopgap_in_place` / `fully_locked`; the post-check |
| `schema_phase_subscriptions_write_lockdown_audit_report.sql` | lockdown | rows whose entitlement has no payment behind them; `row_fingerprints` (the fence) |
| `schema_phase_subscriptions_write_lockdown_preflight.sql` | lockdown | the same questions as grids for a person in Studio / psql |
| `schema_phase_subscriptions_write_lockdown_probe.js` | lockdown | browser-console probe, signed in; must print `CLOSED` |
| `preflight/schema_phase_workspace_cap_guard_preflight_report.sql` | H1 | `hole_open`, `users_over_their_cap` (a count), `organizations_fingerprint` |
| `preflight/schema_phase_signup_tier_trial_preflight_report.sql` | H4 | `signup_triggers`, `every_tier_check_accepts_trial`, `existing_rows` counts |
| `preflight/schema_phase_dashboard_config_caller_preflight_report.sql` | H2 | whether the function/table exist and who may execute |
| `preflight/schema_phase_public_tables_write_revoke_preflight_report.sql` | H3 | `open_tables_not_known_to_this_repository`, `api_writable_views` |
| `preflight/schema_phase_calibration_queue_write_revoke_preflight_report.sql` | H3c | `hole_open` on `calibration_rules` |
| `preflight/schema_phase_derived_tables_write_revoke_preflight_report.sql` | H3b | `hole_open` on the six tables |
| `preflight/chat_cap_always_preflight_report.sql` | the `chat-llm` function | `ready`, `blocking`, `functions_are_this_repository`, `meter_closed_to_browser_roles`, `plan_and_counters_closed_to_browser_roles`, `users_with_more_than_one_row` — run before every `chat-llm` deploy (§32) |

Each migration's own header names its report and the verdict value to expect
("`hole_open` true → apply → `hole_open` false").

---

## D. Re-run rules

**D.1 Everything is written to be re-run** (IF NOT EXISTS / create-or-replace / DO
blocks), so a fresh environment can be built by applying A then B top to bottom. The
exceptions are the three one-shots the headers mark: the one-time cutover block inside
`schema_phase_plan_caps.sql` (run once at the 2026-08 tier deploy, deliberately not part
of the idempotent file), `schema_phase_3b5_pre_backfill_snapshot.sql`, and
`schema_phase_test_mode.sql` (test mode only).

**D.2 A re-run of an EARLIER file re-opens a LATER one — re-run the later file, always:**

| after re-running … | re-run … | why (source) |
|---|---|---|
| `schema_phase5_usage_limits.sql` | `schema_phase_security_hardening.sql` | phase5 re-creates the two views without `security_invoker` and re-grants them to anon (§16; hardening header ⚠) |
| `schema.sql` from a checkout older than 2026-10-03, any logical restore, any file that CREATES a listed entitlement table | `schema_phase_subscriptions_write_lockdown.sql` | the old schema.sql re-creates the two write policies; a `create table` hands the default grants out again (lockdown header ⚠, §29) |
| `schema.sql` or `schema_phase3.sql` | `schema_phase_signup_tier_trial.sql` | both re-create their signup function without `tier`; schema.sql re-attaches the legacy function to the trigger (header ⚠) |
| `schema_phase_dashboard_config.sql` | `schema_phase_dashboard_config_caller.sql` | it re-creates the function without the caller check (header ⚠) |
| `schema_phase_multi_workspace.sql` or `schema_phase_allow_delete_last_workspace.sql` | `schema_phase_archive_hold_guard.sql` | they re-create `archive_workspace` / `restore_workspace` without the hold guard (header) |
| `schema_phase_workspace_purge_now.sql` | `schema_phase_workspace_purge_now_hold.sql` | it removes the purge-side hold (header) |
| `schema_phase_f3_calibration.sql`, `schema_phase_nasdaq_public_companies.sql`, `schema_phase_intelligence_engine.sql` (fresh database only) | the matching `*_write_revoke.sql` | a `create table` re-grants; re-running those on a database that already has the tables re-grants nothing (headers) |
| `schema_phase_multi_workspace.sql` / `schema_phase_plan_caps.sql` | nothing for H1 — `schema_phase_workspace_cap_guard.sql`'s cap sits on the TABLE, not in `restore_workspace` (§31) | — |

**D.3 The Dashboard reload** (§14) after every file that adds or changes a column or
table, then a REST read of the new column. Before an orchestrator script writes a newly
added column it must call `scripts/_pgrst_visibility.py::verify_pgrst_visibility`. If
the column still answers 400 after NOTIFY + the Dashboard click + toggling an API
setting, that is the persistent-staleness case of §14: pause, open a Supabase ticket.

**D.4 The lockdown's own list.** A NEW entitlement table (a plan row, a meter, a
ledger, a seat, a billing log or queue) gets Supabase's default grants on the day it is
created: add it to THE LIST in `schema_phase_subscriptions_write_lockdown.sql` (and the
two read-only files that carry the list — `tests/engine/test_entitlement_write_laws.py`
reds when they differ) and re-run the file.

---

## E. Production changes that have NO file, and objects no file creates

| change / object | what happened | status |
|---|---|---|
| The 2026-10-03 **three-statement stopgap** on `public.subscriptions` (drop the two write policies; revoke insert/update/delete/truncate/references/trigger from anon, authenticated; notify) — run by the owner in Studio (ops_log 2026-10-03 15:51Z) | **superseded** by `schema_phase_subscriptions_write_lockdown.sql` (applied 2026-10-04 09:43Z, whose pre-flight read `stopgap_in_place` and whose post-check read `fully_locked`). A fresh database needs only the lockdown file | no file needed |
| The 2026-10-10 **test-identity ban** (`banned_until = 2099-12-31` on the project's own test-mode and Playwright identities; ops_log 2026-10-10T06:05Z) | kept only in the session's notes as `prod_sql/write_01_ban_test_identities.sql` | **committed here as `supabase/ops/2026-10-10_ban_test_identities.sql`** — applied 2026-10-10; operational, not a schema migration; not needed on a fresh database |
| `valuations`, `sku_lines`, `sku_aggregates`, `user_valuation_assumptions` (engine-written tables) | exist in production (03:35Z catalog); **no committed file CREATEs them** (grep over `supabase/*.sql`, 2026-10-10) — `schema_phase_sku_dio_columns.sql`, `schema_phase_sku_lines_dio.sql` and `schema_phase_valuation_ebitda_definition.sql` only ALTER them. A fresh database built from the repository lacks them until the engine's first write fails or a CREATE is committed | ticket T55: read their grants, commit a CREATE for fresh environments |
| `profiles.language` | written by the frontend (`i18n/index.ts`), defined by no committed file (§31 ruling 7) | ticket T57 |
| the six `set_updated_at()` triggers | do not exist on a repository-built database; unknown on production (§31 ruling 7) | ticket T57 |
| `founder_cohort_public` view | read by the pricing page with the anon key; created by no file; **absent in production** (ops_log 2026-10-03 20:35Z) | §29 "created by NO file in this repository" |
| the signup function on production before H4 | production's trigger ran `handle_new_user_v2` seeding `plan = 'professional'`, no `tier` — the committed `schema_phase3.sql` shape; H4 patched it in place (ops_log 09:46Z). Not a missing file: the *files* had drifted from the *rule*, which H4 restores | — |

---

## F. The two Edge Functions — committed == deployed

| function | source | deployed version | state at `471273f4` (release r-next) |
|---|---|---|---|
| `chat-llm` | `supabase/functions/chat-llm/{index,guard,plans,prompt}.ts` | v4 2026-10-04 07:55Z from `6986d20a`; **v5 09:49Z from `041497e4`** (fix/chat-cap-always) — the cap enforced on every call, sign-in required, 100 s model deadline (ops_log) | `prompt.ts` moved after v5 (a00d781a, 9d71375e, 5bc3dbb6 — the figure-format section, §38.2). **The release of 2026-10-10 redeploys it**; after that redeploy the committed four files are the deployed ones. The deploy keeps the `LAN_DEV_ORIGIN` CORS allowance the live function carried (d313cc7b) |
| `fx-rates` | `supabase/functions/fx-rates/{index,bnr}.ts` | redeployed **2026-10-04 05:40Z** from release/r-trust, "function dir identical to fix/fx-bnr-feed @ 7b3264d7" (ops_log) — reads `curs.bnr.ro`, serves a current BNR rate | the last commit touching the directory in the range is `24496c86` (2026-10-03), before that deploy: **committed == deployed**, unchanged by this release. (The task brief called the live version "v3"; the ops_log calls the previous one v1 of 2026-07-27 and the tickets inventory calls the live one v2 — the number was not re-read for this document.) |

Redeploy commands (§16 Milestone D, §30, §32): `supabase functions deploy <name>
--project-ref cjclenykwlngqvapmisb --use-api --no-verify-jwt`; secrets with
`supabase secrets set NAME=… --project-ref cjclenykwlngqvapmisb` (values are the owner's).
Rollback = redeploy the previous source (the session keeps copies under
`specs-durable/function_backups_2026-10-04/`; for `chat-llm` the pre-v4 source is the
open, unmetered function — only with no working key among the secrets).

---

## G. Building a fresh database that matches production — the short recipe

1. Section A.1 → A.2 → A.3 in the numbered order (skip A.4 entirely).
2. Section B, top to bottom (skip the two "not applied" files, whose objects you did not create).
3. `supabase/preflight/chat_cap_always_preflight_report.sql` must answer `ready: true`
   before `chat-llm` is deployed against the database.
4. Run `scripts/check_migrations_applied.sh` (or the `.py --emit | --probe` pair inside
   the backend container) — every declared table and column must be present; the
   A.4 files must show as DECLARED ABSENT.
5. Do NOT run section C, section E's ban file, or `schema_phase_test_mode.sql`.
