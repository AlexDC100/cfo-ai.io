#!/usr/bin/env bash
# HOLE-DASHBOARD-CONFIG GATE — supabase/schema_phase_dashboard_config_caller.sql
#
# The hole (measured 2026-10-03): upsert_dashboard_config(p_user_id, p_cards)
# is SECURITY DEFINER, callable by anon, and writes the row of whatever user
# id it is handed — the anon key alone overwrote another user's dashboard
# layout; and "dashboard_configs service_insert" (`with check (true)`, to
# PUBLIC) let the anon key plant a layout for any user who had none.
#
# What it proves, one PASS/FAIL line per case, in a scratch database built
# from this repository's SQL (scripts/entitlement_holes/lib.sh):
#   OPEN   on the fresh schema the report says "hole_open": true and the
#          attacks LAND (anon overwrites a victim's row through the RPC, a
#          signed-in user does, anon plants a row with a direct INSERT) — so
#          the harness is known to see the open hole;
#   RUN 1  the migration applies as one batch; its last statement says what
#          it changed; the report says "hole_open": false; every attack is
#          refused and the victim's row is byte-identical; the legitimate
#          paths still work (the service role's upsert — the engine's
#          PUT /api/dashboard/config — a user calling the RPC for THEMSELVES,
#          the user's own-row read);
#   RUN 2  a second run changes nothing and says so; still closed;
#   RE-OPENED BY HAND  the original file re-run (it re-creates the function
#          without the caller check), EXECUTE handed back to anon, the table
#          privileges handed back, a permissive policy under another name —
#          shown OPEN again (the attack lands), then closed by the migration;
#   NOTHING IS WIDENED  where authenticated could NOT execute the function
#          before the file (a database hardened by hand: the service role
#          only), it cannot after it; where authenticated and the service
#          role held EXECUTE only through PUBLIC's grant, they keep it by
#          name and anon does not;
#   A BODY IT DOES NOT KNOW  a function edited by hand is left byte for
#          byte and closed at the door (the service role only);
#   AN EMPTY DATABASE  the report and the migration answer where neither the
#          function nor the table exists.
#
# WHAT IT CANNOT SEE. PostgREST itself (the RPC is called as a SQL function
# under `set local role` + request.jwt.claims — what PostgREST does, not
# PostgREST); a grant made by a role other than the table's owner (the
# migration reports it under "not_closed" — not exercisable here); another
# function, under another name, that writes dashboard_configs for a caller-
# supplied user id (the static law names the writers the repository has);
# production's own catalog (the preflight report is what reads that).
#
# LOCAL ONLY, never by default: see scripts/entitlement_holes/lib.sh.
#   ENTITLEMENT_HOLES_DB_URL=postgresql://postgres:postgres@127.0.0.1:<port>/<db> \
#   [ENTITLEMENT_HOLES_DB_CONTAINER=<container>] scripts/check_hole_dashboard_config.sh
#   HOLE_MIGRATION=<a planted copy>   apply that file instead (plants)
# Exit: 0 every case passed (or VACUOUS) · 1 a case failed · 2 refused.

set -u
set -o pipefail
GATE="hole-dashboard-config"
# shellcheck source=scripts/entitlement_holes/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/entitlement_holes/lib.sh"

MIGRATION="${HOLE_MIGRATION:-$HOLES_SQL_DIR/schema_phase_dashboard_config_caller.sql}"
REPORT_SQL="$HOLES_SQL_DIR/preflight/schema_phase_dashboard_config_caller_preflight_report.sql"
ORIGINAL="$HOLES_SQL_DIR/schema_phase_dashboard_config.sql"

echo "HOLE-DASHBOARD-CONFIG GATE — $(basename "$MIGRATION")"
holes_connect
[ -f "$MIGRATION" ] || holes_die "the migration file does not exist: $MIGRATION"
[ -f "$REPORT_SQL" ] || holes_die "the preflight report does not exist: $REPORT_SQL"
holes_build_scratch h2

ATTACKER="a0000000-0000-4000-8000-0000000000a1"
VICTIM="b0000000-0000-4000-8000-0000000000b1"
NOROW="c0000000-0000-4000-8000-0000000000c1"
NOROW2="d0000000-0000-4000-8000-0000000000d1"
NOROW3="e0000000-0000-4000-8000-0000000000e1"
new_user "$ATTACKER" h2-attacker
new_user "$VICTIM" h2-victim
new_user "$NOROW" h2-norow
new_user "$NOROW2" h2-norow2
new_user "$NOROW3" h2-norow3

cards_of() { q "select coalesce((select cards::text from dashboard_configs where user_id = '$1'), 'NO ROW');"; }
# The engine's write: the service role upserts the row keyed on the verified id.
engine_put() { sql_as service_role "" "insert into dashboard_configs (user_id, cards, updated_at) values ('$1', '$2'::jsonb, now()) on conflict (user_id) do update set cards = excluded.cards, updated_at = now();"; }
rpc() { echo "select upsert_dashboard_config('$1', '$2'::jsonb);"; }

attacks_refused() { # label-prefix — the victim's row must come out byte-identical
  local tag="$1" before out
  engine_put "$VICTIM" '[{"id":"victims-own"}]' >/dev/null
  before="$(cards_of "$VICTIM")"
  out="$(sql_as anon "" "$(rpc "$VICTIM" '[{"planted":"anon-rpc"}]')")"
  check_has "$tag anon → rpc upsert_dashboard_config(victim) is refused" "$out" "permission denied for function upsert_dashboard_config"
  out="$(sql_as authenticated "$ATTACKER" "$(rpc "$VICTIM" '[{"planted":"user-rpc"}]')")"
  check_has "$tag signed-in user → rpc upsert_dashboard_config(ANOTHER user) is refused" "$out" "written by its own user only"
  out="$(sql_as anon "" "insert into dashboard_configs (user_id, cards) values ('$NOROW2', '[{\"planted\":\"anon-insert\"}]'::jsonb);")"
  check_has "$tag anon → INSERT a row for a user who has none is refused" "$out" "permission denied for table dashboard_configs"
  out="$(sql_as authenticated "$ATTACKER" "insert into dashboard_configs (user_id, cards) values ('$NOROW2', '[{\"planted\":\"user-insert\"}]'::jsonb);")"
  check_has "$tag signed-in user → INSERT a row for ANOTHER user is refused" "$out" "permission denied for table dashboard_configs"
  out="$(sql_as authenticated "$ATTACKER" "update dashboard_configs set cards = '[{\"planted\":\"user-update\"}]'::jsonb where user_id = '$VICTIM';")"
  check_has "$tag signed-in user → UPDATE another user's row is refused" "$out" "permission denied for table dashboard_configs"
  out="$(sql_as authenticated "$ATTACKER" "delete from dashboard_configs where user_id = '$VICTIM';")"
  check_has "$tag signed-in user → DELETE another user's row is refused" "$out" "permission denied for table dashboard_configs"
  check "$tag the victim's row is byte-identical after every attack" "$(cards_of "$VICTIM")" "$before"
  check "$tag the user who had no row still has none" "$(cards_of "$NOROW2")" "NO ROW"
}

legitimate_paths() { # label-prefix
  local tag="$1" out
  out="$(engine_put "$VICTIM" '[{"id":"engine-wrote-this"}]')"
  check "$tag the engine's write (service role upsert on the table) lands" "$(cards_of "$VICTIM")" '[{"id": "engine-wrote-this"}]'
  out="$(sql_as service_role "" "$(rpc "$VICTIM" '[{"id":"service-rpc"}]')")"
  check "$tag the service role may call the RPC for any user" "$(cards_of "$VICTIM")" '[{"id": "service-rpc"}]'
  out="$(sql_as authenticated "$ATTACKER" "$(rpc "$ATTACKER" '[{"id":"my-own-layout"}]')")"
  check "$tag a signed-in user calling the RPC for THEMSELVES writes their own row" "$(cards_of "$ATTACKER")" '[{"id": "my-own-layout"}]'
  out="$(sql_as authenticated "$ATTACKER" "select count(*) from dashboard_configs;")"
  check "$tag a signed-in user reads exactly their own row" "$out" "1"
  out="$(sql_as anon "" "select count(*) from dashboard_configs;")"
  check "$tag anon reads no row" "$out" "0"
}

report_says() { # label want-hole_open
  run_report "$REPORT_SQL"
  if [ "$REPORT_RC" != 0 ]; then fail "$1" "the report failed: $REPORT"; return; fi
  check "$1" "$(jget "$REPORT" '{hole_open}')" "$2"
}

# ── OPEN: the fresh schema ───────────────────────────────────────────────
echo "── OPEN — the schema this repository's other files build"
report_says "O1 the report on the fresh schema says hole_open: true" "true"
check "O1b … function_open (definer, unchecked body, anon may execute)" "$(jget "$REPORT" '{function_open}')" "true"
check "O1c … table_open (anon holds INSERT under a with-check-true policy)" "$(jget "$REPORT" '{table_open}')" "true"
engine_put "$VICTIM" '[{"id":"victims-own"}]' >/dev/null
sql_as anon "" "$(rpc "$VICTIM" '[{"planted":"anon-rpc"}]')" >/dev/null
check "O2 OPEN: the anon key alone OVERWRITES another user's layout through the RPC" "$(cards_of "$VICTIM")" '[{"planted": "anon-rpc"}]'
sql_as authenticated "$ATTACKER" "$(rpc "$VICTIM" '[{"planted":"user-rpc"}]')" >/dev/null
check "O3 OPEN: a signed-in user overwrites ANOTHER user's layout through the RPC" "$(cards_of "$VICTIM")" '[{"planted": "user-rpc"}]'
sql_as anon "" "insert into dashboard_configs (user_id, cards) values ('$NOROW', '[{\"planted\":\"anon-insert\"}]'::jsonb);" >/dev/null
check "O4 OPEN: the anon key alone PLANTS a layout for a user who had none (direct INSERT)" "$(cards_of "$NOROW")" '[{"planted": "anon-insert"}]'

# ── RUN 1 ────────────────────────────────────────────────────────────────
echo "── RUN 1 — the migration, one batch"
apply_migration "$MIGRATION"
check "M1 the migration applies (exit 0)" "$MIG_RC" "0"
[ "$MIG_RC" = 0 ] || echo "     | $MIG_OUT"
check "M2 its last statement names the file" "$(jget "$MIG_RESULT" '{migration}')" "schema_phase_dashboard_config_caller.sql"
check_has "M3 … and says the function body was replaced" "$MIG_RESULT" "upsert_dashboard_config: body replaced"
check_has "M4 … and that EXECUTE was revoked from PUBLIC and anon" "$MIG_RESULT" "EXECUTE revoked from PUBLIC and anon"
check_has "M5 … and that anon lost INSERT on the table" "$MIG_RESULT" "dashboard_configs: INSERT revoked from anon"
check "M6 … and that nothing was left open" "$(jget "$MIG_RESULT" '{not_closed}')" "[]"
report_says "C1 the report after the migration says hole_open: false" "false"
check "C1b the installed body is the one the report expects (the two files agree)" "$(jget "$REPORT" '{function,body_checks_the_caller}')" "true"
attacks_refused "C2"
legitimate_paths "C3"
check "C4 SELECT is left as found: authenticated still holds it" "$(q "select has_table_privilege('authenticated', 'public.dashboard_configs', 'select');")" "t"
check "C5 the three policies are left as found" "$(q "select count(*) from pg_policies where schemaname = 'public' and tablename = 'dashboard_configs';")" "3"

# ── RUN 2 ────────────────────────────────────────────────────────────────
echo "── RUN 2 — the same file again (statement by statement, as psql or the SQL editor sends it)"
apply_migration "$MIGRATION" autocommit
check "R1 the second run applies (exit 0)" "$MIG_RC" "0"
check "R2 … and changes nothing" "$(jget "$MIG_RESULT" '{changed_count}')" "0"
report_says "R3 still hole_open: false" "false"
attacks_refused "R4"

# ── RE-OPENED BY HAND ────────────────────────────────────────────────────
echo "── RE-OPENED BY HAND — the original file re-run, and the grants handed back under other names"
holes_psql "$HOLES_DB" --single-transaction -f - < "$ORIGINAL" >/dev/null 2>&1
report_says "H1 after re-running schema_phase_dashboard_config.sql the report says hole_open: true" "true"
check "H1b … because the function lost its caller check" "$(jget "$REPORT" '{function,body_checks_the_caller}')" "false"
engine_put "$VICTIM" '[{"id":"victims-own"}]' >/dev/null
sql_as authenticated "$ATTACKER" "$(rpc "$VICTIM" '[{"planted":"reopened-user-rpc"}]')" >/dev/null
check "H2 OPEN AGAIN: a signed-in user overwrites another user's layout" "$(cards_of "$VICTIM")" '[{"planted": "reopened-user-rpc"}]'
q "grant execute on function public.upsert_dashboard_config(uuid, jsonb) to anon, public;
   grant insert, update, delete, truncate on public.dashboard_configs to anon, authenticated;
   create policy \"anyone may insert\" on public.dashboard_configs for insert with check (true);" >/dev/null
sql_as anon "" "$(rpc "$VICTIM" '[{"planted":"reopened-anon-rpc"}]')" >/dev/null
check "H3 OPEN AGAIN: with the grants handed back, the anon key overwrites it too" "$(cards_of "$VICTIM")" '[{"planted": "reopened-anon-rpc"}]'
sql_as anon "" "insert into dashboard_configs (user_id, cards) values ('$NOROW3', '[{\"planted\":\"reopened-anon-insert\"}]'::jsonb);" >/dev/null
check "H4 OPEN AGAIN: … and plants a row for a user who had none (direct INSERT)" "$(cards_of "$NOROW3")" '[{"planted": "reopened-anon-insert"}]'
apply_migration "$MIGRATION"
check "H5 the migration applies on the re-opened database (exit 0)" "$MIG_RC" "0"
check_has "H6 … and says it replaced the body again" "$MIG_RESULT" "upsert_dashboard_config: body replaced"
report_says "H7 the report says hole_open: false" "false"
attacks_refused "H8"
legitimate_paths "H9"

# ── NOTHING IS WIDENED ───────────────────────────────────────────────────
echo "── NOTHING IS WIDENED — a database where authenticated could not call the function; one where PUBLIC's grant was the only one"
holes_psql "$HOLES_DB" --single-transaction -f - < "$ORIGINAL" >/dev/null 2>&1          # the unchecked body again
q "revoke all on function public.upsert_dashboard_config(uuid, jsonb) from public, anon, authenticated;" >/dev/null
check "W1 the starting state: the unchecked body, executable by the service role only" "$(q "select has_function_privilege('authenticated', 'public.upsert_dashboard_config(uuid,jsonb)', 'execute')::text || '|' || has_function_privilege('service_role', 'public.upsert_dashboard_config(uuid,jsonb)', 'execute')::text;")" "false|true"
apply_migration "$MIGRATION"
check "W2 the migration applies (exit 0)" "$MIG_RC" "0"
check_has "W3 … replaces the body" "$MIG_RESULT" "upsert_dashboard_config: body replaced"
check "W4 … and authenticated STILL cannot execute it (a privilege it did not hold is not granted)" "$(q "select has_function_privilege('authenticated', 'public.upsert_dashboard_config(uuid,jsonb)', 'execute');")" "f"
out="$(sql_as authenticated "$ATTACKER" "$(rpc "$ATTACKER" '[{"id":"not-even-my-own"}]')")"
check_has "W5 … measured: a signed-in user's call is refused at the door" "$out" "permission denied for function upsert_dashboard_config"
check_has "W6 … and the result says so" "$MIG_RESULT" "authenticated could not EXECUTE upsert_dashboard_config before this file and cannot after it"
out="$(sql_as service_role "" "$(rpc "$VICTIM" '[{"id":"service-rpc-hardened"}]')")"
check "W7 the service role still calls it" "$(cards_of "$VICTIM")" '[{"id": "service-rpc-hardened"}]'
report_says "W8 the report says hole_open: false" "false"
holes_psql "$HOLES_DB" --single-transaction -f - < "$ORIGINAL" >/dev/null 2>&1
q "revoke all on function public.upsert_dashboard_config(uuid, jsonb) from anon, authenticated, service_role;
   grant execute on function public.upsert_dashboard_config(uuid, jsonb) to public;" >/dev/null
check "K1 the starting state: PUBLIC's grant is the only one (anon, authenticated and the service role all execute through it)" "$(q "select has_function_privilege('anon', 'public.upsert_dashboard_config(uuid,jsonb)', 'execute')::text || '|' || (select count(*) from pg_proc p, aclexplode(p.proacl) a where p.oid = 'public.upsert_dashboard_config(uuid,jsonb)'::regprocedure and a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role')));")" "true|0"
report_says "K2 the report says hole_open: true" "true"
apply_migration "$MIGRATION"
check "K3 after the migration anon cannot execute it; authenticated and the service role still can — by name" "$(q "select has_function_privilege('anon', 'public.upsert_dashboard_config(uuid,jsonb)', 'execute')::text || '|' || has_function_privilege('authenticated', 'public.upsert_dashboard_config(uuid,jsonb)', 'execute')::text || '|' || has_function_privilege('service_role', 'public.upsert_dashboard_config(uuid,jsonb)', 'execute')::text;")" "false|true|true"
check_has "K4 … and the result says what it kept" "$MIG_RESULT" "EXECUTE kept for authenticated by name"
attacks_refused "K5"
legitimate_paths "K6"

# ── A BODY IT DOES NOT KNOW ──────────────────────────────────────────────
echo "── A BODY IT DOES NOT KNOW — a function edited by hand is not replaced; it is closed at the door"
q "create or replace function public.upsert_dashboard_config(p_user_id uuid, p_cards jsonb) returns jsonb
   language plpgsql security definer set search_path = public as \$f\$
   begin
     -- hand-made: keeps a copy of what it wrote
     insert into dashboard_configs (user_id, cards, updated_at) values (p_user_id, p_cards, now())
     on conflict (user_id) do update set cards = excluded.cards, updated_at = now();
     return jsonb_build_object('written_for', p_user_id);
   end \$f\$;
   grant execute on function public.upsert_dashboard_config(uuid, jsonb) to anon, authenticated, service_role;" >/dev/null
MD5_HAND="$(q "select md5(prosrc) from pg_proc where oid = 'public.upsert_dashboard_config(uuid,jsonb)'::regprocedure;")"
report_says "U1 with a hand-made body callable by anon the report says hole_open: true" "true"
check_has "U1b … and that the migration will NOT replace it" "$(jget "$REPORT" '{function,migration_will}')" "NOT replace the body"
apply_migration "$MIGRATION"
check "U2 the migration applies (exit 0)" "$MIG_RC" "0"
check "U3 … and the hand-made body is byte-identical" "$(q "select md5(prosrc) from pg_proc where oid = 'public.upsert_dashboard_config(uuid,jsonb)'::regprocedure;")" "$MD5_HAND"
check_has "U4 … the result names it as not replaced" "$(jget "$MIG_RESULT" '{skipped}')" "upsert_dashboard_config body NOT replaced: the installed function is not the repository's (md5 $MD5_HAND"
check "U5 … and only the service role can call it now" "$(q "select has_function_privilege('anon', 'public.upsert_dashboard_config(uuid,jsonb)', 'execute')::text || '|' || has_function_privilege('authenticated', 'public.upsert_dashboard_config(uuid,jsonb)', 'execute')::text || '|' || has_function_privilege('service_role', 'public.upsert_dashboard_config(uuid,jsonb)', 'execute')::text;")" "false|false|true"
engine_put "$VICTIM" '[{"id":"victims-own"}]' >/dev/null
out="$(sql_as authenticated "$ATTACKER" "$(rpc "$VICTIM" '[{"planted":"through-the-hand-made-body"}]')")"
check_has "U6 a signed-in user's call for ANOTHER user is refused at the door" "$out" "permission denied for function upsert_dashboard_config"
check "U7 … and the victim's row is untouched" "$(cards_of "$VICTIM")" '[{"id": "victims-own"}]'
report_says "U8 the report says hole_open: false" "false"
holes_psql "$HOLES_DB" --single-transaction -f - < "$ORIGINAL" >/dev/null 2>&1          # the repository's body back

# ── AN EMPTY DATABASE ────────────────────────────────────────────────────
echo "── AN EMPTY DATABASE — neither the function nor the table"
holes_on_an_empty_database "E1" "$REPORT_SQL" "$MIGRATION"

holes_finish
