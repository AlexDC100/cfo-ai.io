#!/usr/bin/env bash
# HOLE-PUBLIC-TABLES GATE — supabase/schema_phase_public_tables_write_revoke.sql
#
# The hole (measured 2026-10-03): twelve public-market / intelligence tables
# were created WITHOUT row level security and carry Supabase's default
# grants — the anon key alone inserts, updates and deletes their rows.
# (calibration_rules — row level security ON, a policy that admits a global
# rule — is its own file and its own gate: hole-calibration-queue.)
#
# What it proves, one PASS/FAIL line per case, in a scratch database built
# from this repository's SQL (scripts/entitlement_holes/lib.sh). THE LIST is
# read from the migration — the one place it is written:
#   OPEN   the report says "hole_open": true and, on EVERY listed table, the
#          write LANDS: the anon key inserts a row, updates one and deletes
#          one;
#   RUN 1  the migration applies as one batch and says, per table, what it
#          revoked; the report says "hole_open": false; on every listed
#          table every write of anon and of a signed-in user is refused and
#          the table is byte-identical; the SERVICE ROLE still inserts,
#          updates and deletes (the engine and the seed scripts); SELECT
#          answers exactly as before for anon and for a signed-in user; row
#          level security and the policies are as found;
#   RUN 2  a second run changes nothing and says so;
#   AN ABSENT TABLE  is skipped and named (production's schema is not this
#          repository's); with ALL TWELVE absent — production, as read
#          2026-10-04 — the report says "hole_open": false and the migration
#          changes nothing and says there was nothing to do (that case is
#          measured in scripts/check_hole_calibration_queue.sh, where the one
#          table production does hold is closed beside it);
#   RE-OPENED BY HAND  `grant all … to anon, authenticated`, a grant to
#          PUBLIC, a column-level grant — shown OPEN again, then closed;
#   THE CENSUS  with the four revoke files applied, every table that is
#          still open is one this repository has CLASSIFIED (a user's JWT
#          writes it, or another file closes it); a table created without
#          row level security that nobody classified is RED; a hand-made
#          VIEW an API role can write through is named by the report (and
#          the write through it is shown to land, past the revoke);
#   AN EMPTY DATABASE  the report and the migration answer where none of the
#          listed tables exists;
#   OBJECTS ANOTHER ROLE OWNS  (what the dashboard's role created): the
#          report says the hole is open and that this role cannot change the
#          object; the migration applies WITHOUT an error, changes nothing and
#          names what it could not close; the report still says open.
#
# WHAT IT CANNOT SEE. PostgREST and pg_graphql themselves (a request is
# reproduced as the SQL it is, in an `authenticator` session); a grant made
# by a THIRD role holding the grant option on a table this role owns (the
# migration reports it under "not_closed" — not exercised; a table ANOTHER
# role owns is, in the last block); TABLES THIS REPOSITORY DOES NOT
# DEFINE — production holds some; only the preflight report, run there, sees
# them; whether a classified "a user's JWT writes it" table is scoped (that
# is the tenancy probe in the builder's report, not this gate).
#
# LOCAL ONLY, never by default: see scripts/entitlement_holes/lib.sh.
#   ENTITLEMENT_HOLES_DB_URL=postgresql://postgres:postgres@127.0.0.1:<port>/<db> \
#   [ENTITLEMENT_HOLES_DB_CONTAINER=<container>] scripts/check_hole_public_tables.sh
#   HOLE_MIGRATION=<a planted copy>   apply that file instead (plants)
#   HOLE_REPORT=<a planted copy>      read that report instead (plants)
# Exit: 0 every case passed (or VACUOUS) · 1 a case failed · 2 refused ·
#       3 a PLANTED file passed every case (never a pass: the gate did not see it).

set -u
set -o pipefail
GATE="hole-public-tables"
# shellcheck source=scripts/entitlement_holes/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/entitlement_holes/lib.sh"

MIGRATION="${HOLE_MIGRATION:-$HOLES_SQL_DIR/schema_phase_public_tables_write_revoke.sql}"
REPO_MIGRATION="$HOLES_SQL_DIR/schema_phase_public_tables_write_revoke.sql"
REPORT_SQL="${HOLE_REPORT:-$HOLES_SQL_DIR/preflight/schema_phase_public_tables_write_revoke_preflight_report.sql}"
DERIVED_MIGRATION="$HOLES_SQL_DIR/schema_phase_derived_tables_write_revoke.sql"
CALIBRATION_MIGRATION="$HOLES_SQL_DIR/schema_phase_calibration_queue_write_revoke.sql"
DASHBOARD_MIGRATION="$HOLES_SQL_DIR/schema_phase_dashboard_config_caller.sql"

echo "HOLE-PUBLIC-TABLES GATE — $(basename "$MIGRATION")"
holes_connect
[ -f "$MIGRATION" ] || holes_die "the migration file does not exist: $MIGRATION"
[ -f "$REPORT_SQL" ] || holes_die "the preflight report does not exist: $REPORT_SQL"

RLS_OFF="$(tables_between "$REPO_MIGRATION" PUBLIC-TABLES-RLS-OFF | tr '\n' ' ')"
ALL_TABLES="$RLS_OFF"
set -- $RLS_OFF; N_RLS_OFF=$#
set -- $ALL_TABLES; N_ALL=$#
case " $RLS_OFF" in *" public_companies "*) ;; *) echo "FAIL the migration's list names public_companies — read: '$RLS_OFF'"; echo "GATE-WORK $GATE units=0"; exit 1 ;; esac
[ "$N_RLS_OFF" -ge 12 ] || { echo "FAIL the migration lists at least the twelve measured tables — read $N_RLS_OFF"; echo "GATE-WORK $GATE units=0"; exit 1; }

holes_build_scratch h3
USER_A="a0000000-0000-4000-8000-0000000000a3"
new_user "$USER_A" h3-user

# One complete row per listed table. $1 = a small integer that makes it unique.
row_sql() { # table n → an INSERT statement (no trailing semicolon)
  local n="$2"
  case "$1" in
    company_exposure_profiles) echo "insert into company_exposure_profiles (ticker, confidence, source) values ('GATE$n', 0.5, 'manual')" ;;
    intelligence_signals) echo "insert into intelligence_signals (signal_type, title, summary, source, severity, time_horizon, confidence) values ('macro', 'gate signal $n', 's', 'gate', 'low', 'short', 0.5)" ;;
    company_signal_links) echo "insert into company_signal_links (signal_id, ticker) values ((select id from intelligence_signals limit 1), 'GATE$n')" ;;
    macro_signal_cache) echo "insert into macro_signal_cache (cache_key, provider, payload, expires_at) values ('gate-$n', 'gate', '{}'::jsonb, now() + interval '1 day')" ;;
    nasdaq_responses) echo "insert into nasdaq_responses (table_name, query_hash, payload, expires_at) values ('gate', 'hash-$n', '{}'::jsonb, now() + interval '1 day')" ;;
    public_companies) echo "insert into public_companies (ticker, name) values ('GATE$n', 'Gate Fixture Co $n')" ;;
    public_company_opportunity_scores) echo "insert into public_company_opportunity_scores (ticker, overall_opportunity_score, strength_level) values ('GATE$n', 50, 'medium')" ;;
    public_company_periods) echo "insert into public_company_periods (public_company_id, dimension, fiscal_period_end, period_label) values ((select id from public_companies order by ticker limit 1), 'ARY', date '2000-12-31' + $n * 365, 'FY$n')" ;;
    public_company_quotes) echo "insert into public_company_quotes (public_company_id, as_of) values ((select id from public_companies order by ticker limit 1), date '2000-01-01' + $n)" ;;
    public_company_risk_scores) echo "insert into public_company_risk_scores (ticker, overall_risk_score, risk_level, categories) values ('GATE$n', 50, 'medium', '{}'::jsonb)" ;;
    risk_interpretations) echo "insert into risk_interpretations (subject, subject_kind, headline, summary, model_id, feed_status) values ('GATE$n', 'ticker', 'h', 's', 'm', 'ok')" ;;
    sector_risk_models) echo "insert into sector_risk_models (sector) values ('gate sector $n')" ;;
    *) return 1 ;;
  esac
}
for t in $ALL_TABLES; do
  row_sql "$t" 1 >/dev/null || holes_die "the gate has no row fixture for listed table '$t' — add one to row_sql() in scripts/check_hole_public_tables.sh"
done
# seed order: parents first
SEEDED=""
for t in public_companies intelligence_signals $ALL_TABLES; do
  case " $SEEDED " in *" $t "*) continue ;; esac
  out="$(q "$(row_sql "$t" 1);")"
  case "$out" in *ERROR*) holes_die "could not seed $t: $out" ;; esac
  SEEDED="$SEEDED $t"
done

rows() { q "select count(*) from public.$1;"; }
attempt() { # role sub write-statement → verdict word
  write_verdict "$(sql_as "$1" "$2" "with x as ($3 returning 1) select count(*) from x;")"
}
report_says() { # label want-hole_open
  run_report "$REPORT_SQL"
  if [ "$REPORT_RC" != 0 ]; then fail "$1" "the report failed: $REPORT"; return; fi
  check "$1" "$(jget "$REPORT" '{hole_open}')" "$2"
}

NONCE=10
refused_everywhere() { # tag — every write of anon and of a signed-in user, on every listed table
  local tag="$1" t before v
  for t in $ALL_TABLES; do
    before="$(table_digest "$t")"
    NONCE=$((NONCE + 1))
    v="$(attempt anon "" "$(row_sql "$t" "$NONCE")")";                      check "$tag $t: anon INSERT is refused" "$v" "refused: no privilege"
    v="$(attempt anon "" "update public.$t set $(first_col "$t") = $(first_col "$t") where true")"
    check "$tag $t: anon UPDATE is refused" "$v" "refused: no privilege"
    v="$(attempt anon "" "delete from public.$t where true")";               check "$tag $t: anon DELETE is refused" "$v" "refused: no privilege"
    NONCE=$((NONCE + 1))
    v="$(attempt authenticated "$USER_A" "$(row_sql "$t" "$NONCE")")";      check "$tag $t: a signed-in user's INSERT is refused" "$v" "refused: no privilege"
    v="$(attempt authenticated "$USER_A" "update public.$t set $(first_col "$t") = $(first_col "$t") where true")"
    check "$tag $t: a signed-in user's UPDATE is refused" "$v" "refused: no privilege"
    v="$(attempt authenticated "$USER_A" "delete from public.$t where true")"; check "$tag $t: a signed-in user's DELETE is refused" "$v" "refused: no privilege"
    v="$(sql_as authenticated "$USER_A" "truncate public.$t cascade;")"
    check_has "$tag $t: TRUNCATE is refused" "$v" "permission denied for table"
    check "$tag $t: byte-identical after every attack" "$(table_digest "$t")" "$before"
  done
}
first_col() { q "select quote_ident(attname) from pg_attribute where attrelid = 'public.$1'::regclass and attnum > 0 and not attisdropped order by attnum limit 1;"; }

# ── OPEN ─────────────────────────────────────────────────────────────────
echo "── OPEN — the schema this repository's other files build"
report_says "O1 the report on the fresh schema says hole_open: true" "true"
check "O1b … every listed table is open" "$(jget "$REPORT" '{listed_open_count}')" "$N_ALL"
check "O1b2 … and every listed table exists here (listed_existing_count)" "$(jget "$REPORT" '{listed_existing_count}')" "$N_ALL"
check "O1c … and nothing open is unknown to the repository" "$(jget "$REPORT" '{open_tables_not_known_to_this_repository}')" "[]"
for t in $RLS_OFF; do
  check "O2 $t: row level security is OFF" "$(q "select relrowsecurity from pg_class where oid = 'public.$t'::regclass;")" "f"
  n0="$(rows "$t")"
  v="$(attempt anon "" "$(row_sql "$t" 2)")"
  check "O3 OPEN $t: the anon key alone INSERTS a row" "$v|$(rows "$t")" "LANDED|$((n0 + 1))"
  v="$(attempt anon "" "update public.$t set $(first_col "$t") = $(first_col "$t") where true")"
  check "O4 OPEN $t: … UPDATES every row" "$v" "LANDED"
  v="$(attempt anon "" "delete from public.$t where ctid = (select max(ctid) from public.$t)")"
  check "O5 OPEN $t: … and DELETES one" "$v|$(rows "$t")" "LANDED|$n0"
done
check "O6 calibration_rules is NOT this file's: the report names it in the census, closed by its own file" "$(jsql "$REPORT" "select x ->> 'this_repository_says' from jsonb_array_elements(:'j'::jsonb -> 'other_open_tables') x where x ->> 'table' = 'calibration_rules';")" "closed by schema_phase_calibration_queue_write_revoke.sql"
ANON_READ_BEFORE=""; USER_READ_BEFORE=""
for t in $ALL_TABLES; do
  ANON_READ_BEFORE="$ANON_READ_BEFORE $t=$(sql_as anon "" "select count(*) from public.$t;")"
  USER_READ_BEFORE="$USER_READ_BEFORE $t=$(sql_as authenticated "$USER_A" "select count(*) from public.$t;")"
done
CATALOG_BEFORE="$(q "select md5(string_agg(c.relname || ':' || c.relrowsecurity || ':' || (select count(*) from pg_policy p where p.polrelid = c.oid), ',' order by c.relname)) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r';")"

# ── RUN 1 ────────────────────────────────────────────────────────────────
echo "── RUN 1 — the migration, one batch"
apply_migration "$MIGRATION"
check "M1 the migration applies (exit 0)" "$MIG_RC" "0"
[ "$MIG_RC" = 0 ] || echo "     | $MIG_OUT"
check "M2 its last statement names the file" "$(jget "$MIG_RESULT" '{migration}')" "schema_phase_public_tables_write_revoke.sql"
check "M3 … revoked something on every listed table" "$(jsql "$MIG_RESULT" "select count(*) from jsonb_object_keys(:'j'::jsonb -> 'revoked');")" "$N_ALL"
check_has "M4 … anon's INSERT on public_companies among them" "$(jget "$MIG_RESULT" '{revoked,public_companies}')" "anon:INSERT"
check "M5 … no table was absent, nothing left open" "$(jget "$MIG_RESULT" '{tables_absent_here}')|$(jget "$MIG_RESULT" '{not_closed}')" "[]|[]"
check "M5b … and calibration_rules keeps its grants (not this file's table)" "$(jget "$MIG_RESULT" '{revoked,calibration_rules}')|$(q "select has_table_privilege('authenticated', 'public.calibration_rules', 'INSERT');")" "null|t"
report_says "C1 the report after the migration says hole_open: false" "false"
check "C1b … no listed table is open" "$(jget "$REPORT" '{listed_open_count}')" "0"
refused_everywhere "C2"

echo "   legitimate paths"
for t in $ALL_TABLES; do
  NONCE=$((NONCE + 1)); n0="$(rows "$t")"
  v="$(attempt service_role "" "$(row_sql "$t" "$NONCE")")"
  check "C3 $t: the service role still INSERTS (the engine, the seed scripts)" "$v|$(rows "$t")" "LANDED|$((n0 + 1))"
  v="$(attempt service_role "" "update public.$t set $(first_col "$t") = $(first_col "$t") where true")"
  check "C4 $t: … UPDATES" "$v" "LANDED"
  v="$(attempt service_role "" "delete from public.$t where ctid = (select max(ctid) from public.$t)")"
  check "C5 $t: … and DELETES" "$v|$(rows "$t")" "LANDED|$n0"
done
ANON_READ_AFTER=""; USER_READ_AFTER=""
for t in $ALL_TABLES; do
  ANON_READ_AFTER="$ANON_READ_AFTER $t=$(sql_as anon "" "select count(*) from public.$t;")"
  USER_READ_AFTER="$USER_READ_AFTER $t=$(sql_as authenticated "$USER_A" "select count(*) from public.$t;")"
done
check "C6 SELECT is left exactly as found: anon reads what it read before, table by table" "$ANON_READ_AFTER" "$ANON_READ_BEFORE"
check "C7 … and so does a signed-in user" "$USER_READ_AFTER" "$USER_READ_BEFORE"
check_has "C7b … (the read is real: anon counted rows in public_companies)" "$ANON_READ_BEFORE" "public_companies=1"
check "C8 row level security and every policy are as found (no table switched, none created or dropped)" "$(q "select md5(string_agg(c.relname || ':' || c.relrowsecurity || ':' || (select count(*) from pg_policy p where p.polrelid = c.oid), ',' order by c.relname)) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r';")" "$CATALOG_BEFORE"

# ── RUN 2 ────────────────────────────────────────────────────────────────
echo "── RUN 2 — the same file again (statement by statement)"
apply_migration "$MIGRATION" autocommit
check "R1 the second run applies (exit 0)" "$MIG_RC" "0"
check "R2 … and changes nothing" "$(jget "$MIG_RESULT" '{changed_count}')|$(jget "$MIG_RESULT" '{revoked}')" "0|{}"
report_says "R3 still hole_open: false" "false"

# ── an absent table ──────────────────────────────────────────────────────
echo "── AN ABSENT TABLE — production's schema is not this repository's"
q "drop table public.sector_risk_models;" >/dev/null
apply_migration "$MIGRATION"
check "A1 the migration applies with a listed table missing (exit 0)" "$MIG_RC" "0"
check "A2 … and names it" "$(jget "$MIG_RESULT" '{tables_absent_here}')" '["sector_risk_models"]'
report_says "A3 the report answers too: hole_open false" "false"
check "A3b … and says the table does not exist here" "$(jsql "$REPORT" "select (x ->> 'exists') from jsonb_array_elements(:'j'::jsonb -> 'listed') x where x ->> 'table' = 'sector_risk_models';")" "false"
check "A3c … one fewer listed table exists (listed_existing_count)" "$(jget "$REPORT" '{listed_existing_count}')" "$((N_ALL - 1))"
q "create table public.sector_risk_models (sector text primary key, model jsonb);" >/dev/null   # default grants again: open
ALL_BUT="$(printf '%s\n' $ALL_TABLES | grep -v '^sector_risk_models$' | tr '\n' ' ')"

# ── RE-OPENED BY HAND ────────────────────────────────────────────────────
echo "── RE-OPENED BY HAND — grant all; a grant to PUBLIC; a column-level grant; a table re-created with the default grants"
q "grant all on public.public_companies to anon, authenticated;
   grant insert on public.macro_signal_cache to public;
   grant update (title) on public.intelligence_signals to authenticated;" >/dev/null
report_says "H1 the report says hole_open: true" "true"
check "H1b … four tables" "$(jget "$REPORT" '{listed_open_count}')" "4"
n0="$(rows public_companies)"
v="$(attempt anon "" "$(row_sql public_companies 90)")"
check "H2 OPEN AGAIN: the anon key inserts into public_companies" "$v|$(rows public_companies)" "LANDED|$((n0 + 1))"
v="$(attempt anon "" "$(row_sql macro_signal_cache 90)")"
check "H3 OPEN AGAIN: … and into macro_signal_cache through the grant to PUBLIC" "$v" "LANDED"
v="$(attempt authenticated "$USER_A" "update public.intelligence_signals set title = 'rewritten' where true")"
check "H4 OPEN AGAIN: a signed-in user rewrites intelligence_signals.title through the column grant" "$v" "LANDED"
apply_migration "$MIGRATION"
check "H5 the migration applies on the re-opened database (exit 0)" "$MIG_RC" "0"
check_has "H6 … and revoked PUBLIC's grant" "$(jget "$MIG_RESULT" '{revoked,macro_signal_cache}')" "PUBLIC:INSERT"
check_has "H6b … and the column-level one" "$(jget "$MIG_RESULT" '{revoked,intelligence_signals}')" "authenticated:UPDATE"
check "H7 nothing left open" "$(jget "$MIG_RESULT" '{not_closed}')" "[]"
report_says "H8 the report says hole_open: false" "false"
q "delete from public.public_companies where ticker = 'GATE90'; delete from public.macro_signal_cache where cache_key = 'gate-90';" >/dev/null
q "insert into sector_risk_models (sector) values ('gate sector 1');" >/dev/null
refused_everywhere "H9"

# ── THE CENSUS ───────────────────────────────────────────────────────────
echo "── THE CENSUS — with the four revoke files applied, every open table is one the repository has classified"
apply_migration "$CALIBRATION_MIGRATION"; check "N0 schema_phase_calibration_queue_write_revoke.sql applies" "$MIG_RC" "0"
apply_migration "$DERIVED_MIGRATION";  check "N1 schema_phase_derived_tables_write_revoke.sql applies" "$MIG_RC" "0"
apply_migration "$DASHBOARD_MIGRATION"; check "N2 schema_phase_dashboard_config_caller.sql applies" "$MIG_RC" "0"
run_report "$REPORT_SQL"
check "N3 no open table is unknown to the repository" "$(jget "$REPORT" '{open_tables_not_known_to_this_repository}')" "[]"
STILL="$(jsql "$REPORT" "select coalesce(string_agg(x ->> 'table', ' ' order by x ->> 'table'), '') from jsonb_array_elements(:'j'::jsonb -> 'other_open_tables') x where (x ->> 'this_repository_says') like 'closed by schema_phase_%';")"
check "N4 no table one of these files closes is still open" "$STILL" ""
N_OPEN="$(jsql "$REPORT" "select jsonb_array_length(:'j'::jsonb -> 'other_open_tables');")"
if [ "$N_OPEN" -ge 20 ] 2>/dev/null; then pass "N5 the census is not empty: $N_OPEN tables a user's JWT writes are open by design, each classified"; else fail "N5 the census is not empty" "open tables classified: $N_OPEN (expected 20 or more — is the census reading the catalog?)"; fi
check "N6 it examined the whole schema" "$(q "select ($(jget "$REPORT" '{public_tables_examined}') >= 80)::text;")" "true"
q "create table public.somebody_forgot_rls (id bigint primary key, note text);" >/dev/null
run_report "$REPORT_SQL"
check "N7 a NEW table created without row level security is named as unknown and open" "$(jget "$REPORT" '{rls_off_tables_not_known_to_this_repository}')" '["somebody_forgot_rls"]'
check "N8 the repository defines no view an API role can write through" "$(jget "$REPORT" '{api_writable_views}')" "[]"
# A hand-made view over a listed table: it writes AS ITS OWNER, past the revoke.
q "create view public.handmade_company_view as select * from public.public_companies;" >/dev/null
n0="$(rows public_companies)"
v="$(attempt anon "" "insert into public.handmade_company_view (ticker, name) values ('VIEW1', 'Through a view')")"
check "N9 measured: the anon key INSERTS into a revoked table through a hand-made view (default grants, not security_invoker)" "$v|$(rows public_companies)" "LANDED|$((n0 + 1))"
run_report "$REPORT_SQL"
check "N10 … and the report names that view" "$(jsql "$REPORT" "select string_agg((x ->> 'view') || ':' || (x ->> 'security_invoker'), ',') from jsonb_array_elements(:'j'::jsonb -> 'api_writable_views') x;")" "handmade_company_view:false"
check "N11 … while hole_open stays about the listed tables (false)" "$(jget "$REPORT" '{hole_open}')" "false"
q "drop view public.handmade_company_view; delete from public.public_companies where ticker = 'VIEW1';" >/dev/null

# ── AN EMPTY DATABASE ────────────────────────────────────────────────────
echo "── AN EMPTY DATABASE — none of the listed tables"
holes_on_an_empty_database "E1" "$REPORT_SQL" "$MIGRATION"
check "E1 … the report said none of the listed tables exists there (listed_existing_count 0 — nothing to do)" "$(jget "$REPORT" '{listed_existing_count}')" "0"
check_has "E1 … and its last row SAYS there was nothing to do (skipped — never an empty answer, never a failure)" "$(jget "$MIG_RESULT" '{skipped}')" "none of the 12 listed tables exists in this database — nothing to do"

# ── OBJECTS ANOTHER ROLE OWNS ────────────────────────────────────────────
echo "── OBJECTS ANOTHER ROLE OWNS — a listed table created by the dashboard's role, with its own grants"
holes_on_objects_another_role_owns "X1" "$REPORT_SQL" "$MIGRATION" '{listed_this_role_cannot_revoke}' '["public_companies"]' <<'SQL'
create table public.public_companies (id int primary key, ticker text, name text);
grant all on public.public_companies to anon, authenticated, service_role;
SQL

holes_finish
