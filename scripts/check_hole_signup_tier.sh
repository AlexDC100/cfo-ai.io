#!/usr/bin/env bash
# HOLE-SIGNUP-TIER GATE — supabase/schema_phase_signup_tier_trial.sql
#
# The hole (measured 2026-10-03): the signup trigger seeds a subscriptions
# row with NO tier (tier NULL, plan 'professional', status 'trial'). The
# engine reads `row.tier or row.plan`, and 'professional' is a legacy key
# that maps to the Multi-Country allowance — every new free account is
# metered as Multi-Country (15 documents, 5 workspaces, non-RO documents).
#
# What it proves, one PASS/FAIL line per case, in a scratch database built
# from this repository's SQL (scripts/entitlement_holes/lib.sh):
#   OPEN   on the fresh schema the report says "hole_open": true and a new
#          signup's row reads tier NULL / plan professional;
#   RUN 1  the migration applies as one batch and says which function it
#          patched; the report says "hole_open": false; a NEW signup's row
#          reads tier 'trial' and is otherwise what it was (plan, status,
#          billing cycle, a 14-day trial; the profile, the organization and
#          the owner membership are still created; the first-touch trigger
#          still runs); the function keeps its owner, SECURITY DEFINER, its
#          search_path and its grants; every row that EXISTED is byte-
#          identical (no backfill);
#   RUN 2  a second run changes nothing and says so;
#   RE-OPENED  supabase/schema_phase3.sql re-run (it re-creates the function
#          without tier) — shown OPEN again, then closed;
#   IT REFUSES TO BREAK SIGNUP  with a tier CHECK that does not accept
#          'trial' (schema_phase5's original list) the migration installs
#          NOTHING and says why, and signups still land;
#   A BODY IT DOES NOT KNOW  a signup function whose subscriptions insert is
#          not the repository's statement is NOT patched, the result names
#          it, and the report stays "hole_open": true (honest, not green).
#
# WHAT IT CANNOT SEE. GoTrue (a signup is reproduced as the auth.users row it
# inserts); what the ENGINE gives the row — that half is the static law
# (tests/engine/test_entitlement_hole_laws.py runs the real
# _pricing_config.plan_for over the row each statement seeds); existing rows
# (untouched by design: what existing free accounts are metered as is the
# owner's ruling); a subscriptions row created by anything but a trigger on
# auth.users.
#
# LOCAL ONLY, never by default: see scripts/entitlement_holes/lib.sh.
#   ENTITLEMENT_HOLES_DB_URL=postgresql://postgres:postgres@127.0.0.1:<port>/<db> \
#   [ENTITLEMENT_HOLES_DB_CONTAINER=<container>] scripts/check_hole_signup_tier.sh
#   HOLE_MIGRATION=<a planted copy>   apply that file instead (plants)
#   HOLE_REPORT=<a planted copy>      read that report instead (plants)
# Exit: 0 every case passed (or VACUOUS) · 1 a case failed · 2 refused ·
#       3 a PLANTED file passed every case (never a pass: the gate did not see it).

set -u
set -o pipefail
GATE="hole-signup-tier"
# shellcheck source=scripts/entitlement_holes/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/entitlement_holes/lib.sh"

MIGRATION="${HOLE_MIGRATION:-$HOLES_SQL_DIR/schema_phase_signup_tier_trial.sql}"
REPORT_SQL="${HOLE_REPORT:-$HOLES_SQL_DIR/preflight/schema_phase_signup_tier_trial_preflight_report.sql}"

echo "HOLE-SIGNUP-TIER GATE — $(basename "$MIGRATION")"
holes_connect
[ -f "$MIGRATION" ] || holes_die "the migration file does not exist: $MIGRATION"
[ -f "$REPORT_SQL" ] || holes_die "the preflight report does not exist: $REPORT_SQL"
holes_build_scratch h4

uid() { printf '%s0000000-0000-4000-8000-0000000000%s' "$1" "$2"; }
sub_row() { q "select coalesce(tier, 'NULL') || '|' || plan || '|' || status || '|' || billing_cycle || '|' || (trial_end - trial_start)::text from subscriptions where user_id = '$1';"; }
all_rows_digest() { q "select md5(coalesce(string_agg(s::text, E'\n' order by s.user_id), '')) from subscriptions s where s.user_id = any ('{$1}'::uuid[]);"; }
fn_attrs() { q "select p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|' || coalesce(array_to_string(p.proconfig, ','), '-') || '|' || coalesce(p.proacl::text, '-') from pg_proc p where p.oid = 'public.$1()'::regprocedure;"; }
report_says() { # label want-hole_open
  run_report "$REPORT_SQL"
  if [ "$REPORT_RC" != 0 ]; then fail "$1" "the report failed: $REPORT"; return; fi
  check "$1" "$(jget "$REPORT" '{hole_open}')" "$2"
}

# ── OPEN ─────────────────────────────────────────────────────────────────
echo "── OPEN — the schema this repository's other files build"
OLD1="$(uid a 01)"; OLD2="$(uid a 02)"
new_user "$OLD1" h4-before-1
new_user "$OLD2" h4-before-2
q "update subscriptions set tier = 'pro', status = 'active', stripe_subscription_id = 'sub_gateFixtureOnly' where user_id = '$OLD2';" >/dev/null
report_says "O1 the report on the fresh schema says hole_open: true" "true"
check_has "O1b … a new signup would be written with tier NULL" "$(jget "$REPORT" '{new_signup_tier}')" "NULL"
check "O1c … the live trigger runs handle_new_user_v2" "$(jget "$REPORT" '{signup_triggers,0,function}')" "handle_new_user_v2()"
check "O2 OPEN: a new signup's row is tier NULL, plan professional — what the engine meters as Multi-Country" "$(sub_row "$OLD1")" "NULL|professional|trial|monthly|14 days"
EXISTING="$OLD1,$OLD2,00000000-0000-4000-8000-000000000001"
DIGEST_BEFORE="$(all_rows_digest "$EXISTING")"
ATTRS_V2_BEFORE="$(fn_attrs handle_new_user_v2)"
ATTRS_V1_BEFORE="$(fn_attrs handle_new_user)"

# ── RUN 1 ────────────────────────────────────────────────────────────────
echo "── RUN 1 — the migration, one batch"
apply_migration "$MIGRATION"
check "M1 the migration applies (exit 0)" "$MIG_RC" "0"
[ "$MIG_RC" = 0 ] || echo "     | $MIG_OUT"
check "M2 its last statement names the file" "$(jget "$MIG_RESULT" '{migration}')" "schema_phase_signup_tier_trial.sql"
check_has "M3 … and says it patched handle_new_user_v2" "$MIG_RESULT" "handle_new_user_v2(): its subscriptions insert now writes tier 'trial'"
check_has "M4 … and the legacy handle_new_user" "$MIG_RESULT" "handle_new_user(): its subscriptions insert now writes tier 'trial'"
check "M5 … and that nothing is left writing tier NULL" "$(jget "$MIG_RESULT" '{not_closed}')" "[]"
report_says "C1 the report after the migration says hole_open: false" "false"
check "C1b … a new signup would be written with tier trial" "$(jget "$REPORT" '{new_signup_tier}')" "trial"
NEW1="$(uid b 01)"
q "insert into auth.users (id, email, raw_user_meta_data) values ('$NEW1', 'h4-after-1@holes-gate.invalid', '{\"company_name\":\"Gate Fixture SRL\",\"first_touch\":{\"src\":\"gate\"}}'::jsonb);" >/dev/null
check "C2 a NEW signup's row reads tier trial — plan, status, cycle and the 14-day trial as before" "$(sub_row "$NEW1")" "trial|professional|trial|monthly|14 days"
check "C3 the signup still creates the profile, the organization and the owner membership" "$(q "select (select count(*) from profiles where id = '$NEW1') || '|' || (select count(*) from memberships m join organizations o on o.id = m.org_id where m.user_id = '$NEW1' and m.role = 'owner' and o.name = 'Gate Fixture SRL');")" "1|1"
check "C4 the first-touch trigger still runs after it" "$(q "select first_touch ->> 'src' from profiles where id = '$NEW1';")" "gate"
check "C5 every row that EXISTED is byte-identical (no backfill)" "$(all_rows_digest "$EXISTING")" "$DIGEST_BEFORE"
check "C5b … the old free account still reads tier NULL" "$(sub_row "$OLD1")" "NULL|professional|trial|monthly|14 days"
check "C6 handle_new_user_v2 keeps SECURITY DEFINER, its owner, its search_path and its grants" "$(fn_attrs handle_new_user_v2)" "$ATTRS_V2_BEFORE"
check "C6b … and so does handle_new_user" "$(fn_attrs handle_new_user)" "$ATTRS_V1_BEFORE"
check_has "C6c … (SECURITY DEFINER with search_path=public, the hardened state)" "$ATTRS_V2_BEFORE" "true|postgres|search_path=public"
check "C7 the trigger on auth.users is the same one, enabled" "$(q "select tgenabled::text || '|' || tgfoid::regprocedure::text from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created';")" "O|handle_new_user_v2()"
out="$(sql_as authenticated "$NEW1" "select create_workspace('a second one');")"
check_has "C8 the new account's workspace cap is the trial's (create_workspace reads the same tier)" "$out" "workspace_cap_reached: your trial plan allows 1 workspace(s)"
check "C9 nothing else in the function changed: the patched body is the original with two words added" "$(q "select md5(replace(replace(prosrc, 'user_id, plan, tier, billing_cycle', 'user_id, plan, billing_cycle'), '''professional'', ''trial'', ''monthly''', '''professional'', ''monthly''')) from pg_proc where oid = 'public.handle_new_user_v2()'::regprocedure;")" "77d2a9f3edf4d14c61a831a5a9512921"

# ── RUN 2 ────────────────────────────────────────────────────────────────
echo "── RUN 2 — the same file again (statement by statement)"
apply_migration "$MIGRATION" autocommit
check "R1 the second run applies (exit 0)" "$MIG_RC" "0"
check "R2 … and changes nothing" "$(jget "$MIG_RESULT" '{changed_count}')" "0"
report_says "R3 still hole_open: false" "false"
NEW2="$(uid b 02)"; new_user "$NEW2" h4-after-2
check "R4 a new signup still reads tier trial" "$(sub_row "$NEW2")" "trial|professional|trial|monthly|14 days"

# ── RE-OPENED: the original file re-run ──────────────────────────────────
echo "── RE-OPENED — supabase/schema_phase3.sql re-run (it re-creates the function without tier)"
holes_psql "$HOLES_DB" --single-transaction -f - < "$HOLES_SQL_DIR/schema_phase3.sql" >/dev/null 2>&1
report_says "H1 after re-running schema_phase3.sql the report says hole_open: true" "true"
NEW3="$(uid c 01)"; new_user "$NEW3" h4-reopened-1
check "H2 OPEN AGAIN: a new signup is tier NULL" "$(sub_row "$NEW3")" "NULL|professional|trial|monthly|14 days"
apply_migration "$MIGRATION"
check_has "H3 the migration patches handle_new_user_v2 again" "$MIG_RESULT" "handle_new_user_v2(): its subscriptions insert now writes tier 'trial'"
report_says "H4 the report says hole_open: false" "false"
NEW4="$(uid c 02)"; new_user "$NEW4" h4-reopened-2
check "H5 a new signup reads tier trial" "$(sub_row "$NEW4")" "trial|professional|trial|monthly|14 days"
check "H6 the signup written while it was open is NOT rewritten (no backfill)" "$(sub_row "$NEW3")" "NULL|professional|trial|monthly|14 days"

# ── it refuses to break signup ───────────────────────────────────────────
echo "── A TIER CHECK THAT DOES NOT ACCEPT 'trial' — the migration must install nothing"
holes_psql "$HOLES_DB" --single-transaction -f - < "$HOLES_SQL_DIR/schema_phase3.sql" >/dev/null 2>&1
q "update subscriptions set tier = null where tier = 'trial';
   alter table subscriptions drop constraint subscriptions_tier_check;
   alter table subscriptions add constraint subscriptions_tier_check check (tier in ('solo', 'business', 'professional', 'starter', 'pro', 'enterprise'));" >/dev/null
MD5_OPEN="$(q "select md5(prosrc) from pg_proc where oid = 'public.handle_new_user_v2()'::regprocedure;")"
apply_migration "$MIGRATION"
check "S1 the migration still exits 0" "$MIG_RC" "0"
check "S2 … changes nothing" "$(jget "$MIG_RESULT" '{changed_count}')" "0"
check_has "S3 … and says why: the CHECK does not accept 'trial'" "$MIG_RESULT" "does not accept tier 'trial'"
check "S4 the signup function is untouched" "$(q "select md5(prosrc) from pg_proc where oid = 'public.handle_new_user_v2()'::regprocedure;")" "$MD5_OPEN"
NEW5="$(uid d 01)"; new_user "$NEW5" h4-check-1
check "S5 … and signups still land (tier NULL, as before)" "$(sub_row "$NEW5")" "NULL|professional|trial|monthly|14 days"
report_says "S6 the report says hole_open: true — and names the constraint" "true"
check "S6b …" "$(jget "$REPORT" '{subscriptions,every_tier_check_accepts_trial}')" "false"
holes_psql "$HOLES_DB" --single-transaction -f - < "$HOLES_SQL_DIR/schema_phase_plan_caps.sql" >/dev/null 2>&1

# ── a body it does not know ──────────────────────────────────────────────
echo "── A SIGNUP FUNCTION WHOSE INSERT IS NOT THE REPOSITORY'S — not patched, and said"
q "create or replace function public.handle_new_user_v2() returns trigger language plpgsql security definer set search_path = public as \$f\$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  insert into public.subscriptions (user_id, plan, status) values (new.id, 'professional', 'trial') on conflict (user_id) do nothing;
  return new;
end \$f\$;" >/dev/null
MD5_HAND="$(q "select md5(prosrc) from pg_proc where oid = 'public.handle_new_user_v2()'::regprocedure;")"
apply_migration "$MIGRATION"
check "U1 the migration exits 0" "$MIG_RC" "0"
check_has "U2 … names the function it did NOT patch" "$MIG_RESULT" "handle_new_user_v2() inserts into subscriptions, but not with the repository's statement — NOT patched"
check_has "U3 … and that a trigger still writes no tier" "$(jget "$MIG_RESULT" '{not_closed}')" "trigger on_auth_user_created on auth.users runs handle_new_user_v2()"
check "U4 the hand-made body is untouched" "$(q "select md5(prosrc) from pg_proc where oid = 'public.handle_new_user_v2()'::regprocedure;")" "$MD5_HAND"
report_says "U5 the report stays hole_open: true (not closed is not green)" "true"
check "U5b … and says the body is not the repository's" "$(jget "$REPORT" '{signup_triggers,0,function_is}')" "a body this repository does not define"
holes_psql "$HOLES_DB" --single-transaction -f - < "$HOLES_SQL_DIR/schema_phase3.sql" >/dev/null 2>&1
apply_migration "$MIGRATION"
report_says "U6 with the repository's function back, the migration closes it" "false"

# ── AN EMPTY DATABASE ────────────────────────────────────────────────────
echo "── AN EMPTY DATABASE — auth.users has no trigger and public.subscriptions does not exist"
holes_on_an_empty_database "E1" "$REPORT_SQL" "$MIGRATION"

holes_finish
