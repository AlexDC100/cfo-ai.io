#!/usr/bin/env bash
# HOLE-DERIVED-TABLES GATE — supabase/schema_phase_derived_tables_write_revoke.sql
#
# What is open (the rest of the census the public-tables gate starts from):
# six tables hold what the ENGINE computes for a period — the statement
# lines, the stored metrics, the briefing, the benchmark report, the SKU
# analysis, the account overrides. Their "member" write policies are scoped
# to the caller's organization, and a member can therefore write their OWN
# organization's rows straight through the REST API: the product then serves
# — and exports as the bank report — figures the engine never computed.
# Every legitimate writer is the engine's service role.
#
# What it proves, one PASS/FAIL line per case, in a scratch database built
# from this repository's SQL (scripts/entitlement_holes/lib.sh). THE LIST is
# read from the migration:
#   OPEN   the report says "hole_open": true; on EVERY listed table a member
#          inserts, updates and deletes rows of their own organization — a
#          statement line's amount and the briefing's text are rewritten and
#          read back; another organization's rows are NOT reachable (the
#          policies are scoped: that is the control, before and after);
#   RUN 1  the migration applies as one batch and says, per table, what it
#          revoked; the report says "hole_open": false; on every listed
#          table every write of a member (and of anon) is refused and the
#          table is byte-identical; the SERVICE ROLE still inserts, updates
#          and deletes (the engine); a member still READS their own
#          organization's rows and nobody else's (the engine's per_user
#          reads); a member still DELETES their own period and document with
#          their JWT and the derived rows cascade; the policies are as found;
#   RUN 2  a second run changes nothing and says so;
#   RE-OPENED BY HAND  the privileges granted back on two tables — shown OPEN
#          again (the amount is rewritten), then closed;
#   AN EMPTY DATABASE  the report and the migration answer where none of the
#          listed tables exists;
#   OBJECTS ANOTHER ROLE OWNS  (what the dashboard's role created): the
#          report says the hole is open and that this role cannot change the
#          object; the migration applies WITHOUT an error, changes nothing and
#          names what it could not close; the report still says open.
#
# WHAT IT CANNOT SEE. PostgREST itself (a request is reproduced as the SQL it
# is, in an `authenticator` session); a user-JWT WRITER of a listed table in
# the product's code — that is the static law
# (tests/engine/test_entitlement_hole_laws.py), which reds the day one
# appears; the engine's own pipeline (its writes are reproduced as the
# service-role statements they are).
#
# LOCAL ONLY, never by default: see scripts/entitlement_holes/lib.sh.
#   ENTITLEMENT_HOLES_DB_URL=postgresql://postgres:postgres@127.0.0.1:<port>/<db> \
#   [ENTITLEMENT_HOLES_DB_CONTAINER=<container>] scripts/check_hole_derived_tables.sh
#   HOLE_MIGRATION=<a planted copy>   apply that file instead (plants)
#   HOLE_REPORT=<a planted copy>      read that report instead (plants)
# Exit: 0 every case passed (or VACUOUS) · 1 a case failed · 2 refused ·
#       3 a PLANTED file passed every case (never a pass: the gate did not see it).

set -u
set -o pipefail
GATE="hole-derived-tables"
# shellcheck source=scripts/entitlement_holes/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/entitlement_holes/lib.sh"

MIGRATION="${HOLE_MIGRATION:-$HOLES_SQL_DIR/schema_phase_derived_tables_write_revoke.sql}"
REPO_MIGRATION="$HOLES_SQL_DIR/schema_phase_derived_tables_write_revoke.sql"
REPORT_SQL="${HOLE_REPORT:-$HOLES_SQL_DIR/preflight/schema_phase_derived_tables_write_revoke_preflight_report.sql}"

echo "HOLE-DERIVED-TABLES GATE — $(basename "$MIGRATION")"
holes_connect
[ -f "$MIGRATION" ] || holes_die "the migration file does not exist: $MIGRATION"
[ -f "$REPORT_SQL" ] || holes_die "the preflight report does not exist: $REPORT_SQL"

TABLES="$(tables_between "$REPO_MIGRATION" DERIVED-TABLES | tr '\n' ' ')"
set -- $TABLES; N_ALL=$#
case " $TABLES" in *" statement_line_items "*) ;; *) echo "FAIL the migration's list names statement_line_items — read: '$TABLES'"; echo "GATE-WORK $GATE units=0"; exit 1 ;; esac

holes_build_scratch h3b
USER_A="a0000000-0000-4000-8000-0000000000a5"; USER_B="b0000000-0000-4000-8000-0000000000b5"
new_user "$USER_A" h3b-member-a
new_user "$USER_B" h3b-member-b
org_of() { q "select org_id from memberships where user_id = '$1' limit 1;"; }
ORG_A="$(org_of "$USER_A")"; ORG_B="$(org_of "$USER_B")"
COA="$(q "select key from coa_registries order by key limit 1;")"
# Two periods and two documents per organization: 1 holds the engine's rows,
# 2 is free (three of the tables hold one row per period / per document).
for o in "A $ORG_A" "B $ORG_B"; do set -- $o
  q "insert into financial_periods (id, org_id, period_start, period_end) values (md5('p1$1')::uuid, '$2', '2025-01-01', '2025-12-31'), (md5('p2$1')::uuid, '$2', '2024-01-01', '2024-12-31');
     insert into documents (id, org_id, storage_path, original_filename, mime_type, size_bytes, status) values (md5('d1$1')::uuid, '$2', '$2/one.xlsx', 'one.xlsx', 'application/vnd.ms-excel', 1, 'analyzed'), (md5('d2$1')::uuid, '$2', '$2/two.xlsx', 'two.xlsx', 'application/vnd.ms-excel', 1, 'analyzed');" >/dev/null
done
P1A="$(q "select md5('p1A')::uuid;")"; P2A="$(q "select md5('p2A')::uuid;")"; D1A="$(q "select md5('d1A')::uuid;")"; D2A="$(q "select md5('d2A')::uuid;")"
P1B="$(q "select md5('p1B')::uuid;")"; D1B="$(q "select md5('d1B')::uuid;")"

row_sql() { # table org period document n → an INSERT statement (no trailing semicolon)
  local o="$2" p="$3" d="$4" n="$5"
  case "$1" in
    statement_line_items) echo "insert into statement_line_items (period_id, statement, bucket, amount) values ('$p', 'PL', 'gate_bucket_$n', 1000.00)" ;;
    calculated_metrics) echo "insert into calculated_metrics (period_id, org_id, name, value) values ('$p', '$o', 'gate_metric_$n', 1.5)" ;;
    briefings) echo "insert into briefings (period_id, org_id, body) values ('$p', '$o', 'the engine wrote this')" ;;
    benchmark_reports) echo "insert into benchmark_reports (period_id, org_id, caen_code, report_data) values ('$p', '$o', '1013', '{\"by\": \"the engine\"}'::jsonb)" ;;
    sku_analyses) echo "insert into sku_analyses (org_id, document_id, briefing) values ('$o', '$d', 'the engine wrote this')" ;;
    org_coa_mappings_overrides) echo "insert into org_coa_mappings_overrides (org_id, coa_key, account_code, standardized_bucket) values ('$o', '$COA', '9$n', 'revenue')" ;;
    *) return 1 ;;
  esac
}
scope() { # table org period document → a WHERE clause for the organization's rows in that table
  case "$1" in
    statement_line_items) echo "period_id in (select id from financial_periods where org_id = '$2')" ;;
    *) echo "org_id = '$2'" ;;
  esac
}
for t in $TABLES; do
  row_sql "$t" x x x 1 >/dev/null || holes_die "the gate has no row fixture for listed table '$t' — add one to row_sql() in scripts/check_hole_derived_tables.sh"
  for o in "$ORG_A $P1A $D1A" "$ORG_B $P1B $D1B"; do set -- $o
    out="$(q "$(row_sql "$t" "$1" "$2" "$3" 1);")"
    case "$out" in *ERROR*) holes_die "could not seed $t: $out" ;; esac
  done
done

rows_of() { q "select count(*) from public.$1 where $(scope "$1" "$2");"; }
attempt() { write_verdict "$(sql_as "$1" "$2" "with x as ($3 returning 1) select count(*) from x;")"; }
first_col() { q "select quote_ident(attname) from pg_attribute where attrelid = 'public.$1'::regclass and attnum > 1 and not attisdropped order by attnum limit 1;"; }
report_says() { # label want-hole_open
  run_report "$REPORT_SQL"
  if [ "$REPORT_RC" != 0 ]; then fail "$1" "the report failed: $REPORT"; return; fi
  check "$1" "$(jget "$REPORT" '{hole_open}')" "$2"
}
cross_tenant_refused() { # tag — the control: another organization's rows, whatever the state
  local tag="$1" t v
  for t in $TABLES; do
    v="$(attempt authenticated "$USER_A" "update public.$t set $(first_col "$t") = $(first_col "$t") where $(scope "$t" "$ORG_B")")"
    case "$v" in "0 rows"|"refused: no privilege") pass "$tag $t: a member does not reach ANOTHER organization's rows ($v)" ;;
      *) fail "$tag $t: a member does not reach ANOTHER organization's rows" "got: $v" ;; esac
  done
}
NONCE=10
refused_everywhere() { # tag
  local tag="$1" t before v
  for t in $TABLES; do
    before="$(table_digest "$t")"
    NONCE=$((NONCE + 1))
    v="$(attempt authenticated "$USER_A" "$(row_sql "$t" "$ORG_A" "$P2A" "$D2A" "$NONCE")")"
    check "$tag $t: a member's INSERT into their own organization is refused" "$v" "refused: no privilege"
    v="$(attempt authenticated "$USER_A" "update public.$t set $(first_col "$t") = $(first_col "$t") where $(scope "$t" "$ORG_A")")"
    check "$tag $t: … UPDATE" "$v" "refused: no privilege"
    v="$(attempt authenticated "$USER_A" "delete from public.$t where $(scope "$t" "$ORG_A")")"
    check "$tag $t: … DELETE" "$v" "refused: no privilege"
    v="$(attempt anon "" "delete from public.$t where true")"
    check "$tag $t: anon's write is refused" "$v" "refused: no privilege"
    check "$tag $t: byte-identical after every attack" "$(table_digest "$t")" "$before"
  done
}

# ── OPEN ─────────────────────────────────────────────────────────────────
echo "── OPEN — the schema this repository's other files build"
report_says "O1 the report on the fresh schema says hole_open: true" "true"
check "O1b … every listed table is open" "$(jget "$REPORT" '{listed_open_count}')" "$N_ALL"
sql_as authenticated "$USER_A" "update statement_line_items set amount = 999999999.99 where period_id = '$P1A';" >/dev/null
check "O2 OPEN: a member REWRITES a statement line of their own period (the figure every statement is assembled from)" "$(q "select amount from statement_line_items where period_id = '$P1A';")" "999999999.99"
sql_as authenticated "$USER_A" "update briefings set body = 'written by a member, served as the engine''s' where org_id = '$ORG_A';" >/dev/null
check "O3 OPEN: … and the briefing's text" "$(q "select body from briefings where org_id = '$ORG_A';")" "written by a member, served as the engine's"
for t in $TABLES; do
  n0="$(rows_of "$t" "$ORG_A")"
  v="$(attempt authenticated "$USER_A" "$(row_sql "$t" "$ORG_A" "$P2A" "$D2A" 2)")"
  check "O4 OPEN $t: a member INSERTS a row into their own organization" "$v|$(rows_of "$t" "$ORG_A")" "LANDED|$((n0 + 1))"
  v="$(attempt authenticated "$USER_A" "update public.$t set $(first_col "$t") = $(first_col "$t") where $(scope "$t" "$ORG_A")")"
  check "O5 OPEN $t: … UPDATES them" "$v" "LANDED"
  v="$(attempt authenticated "$USER_A" "delete from public.$t where $(scope "$t" "$ORG_A") and ctid = (select max(ctid) from public.$t where $(scope "$t" "$ORG_A"))")"
  check "O6 OPEN $t: … and DELETES one" "$v|$(rows_of "$t" "$ORG_A")" "LANDED|$n0"
done
cross_tenant_refused "O7"
READ_A_BEFORE=""; READ_B_BEFORE=""
for t in $TABLES; do
  READ_A_BEFORE="$READ_A_BEFORE $t=$(sql_as authenticated "$USER_A" "select count(*) from public.$t;")"
  READ_B_BEFORE="$READ_B_BEFORE $t=$(sql_as authenticated "$USER_B" "select count(*) from public.$t;")"
done
POLICIES_BEFORE="$(q "select md5(string_agg(tablename || ':' || policyname || ':' || cmd, ',' order by tablename, policyname)) from pg_policies where schemaname = 'public';")"

# ── RUN 1 ────────────────────────────────────────────────────────────────
echo "── RUN 1 — the migration, one batch"
apply_migration "$MIGRATION"
check "M1 the migration applies (exit 0)" "$MIG_RC" "0"
[ "$MIG_RC" = 0 ] || echo "     | $MIG_OUT"
check "M2 its last statement names the file" "$(jget "$MIG_RESULT" '{migration}')" "schema_phase_derived_tables_write_revoke.sql"
check "M3 … revoked something on every listed table" "$(jsql "$MIG_RESULT" "select count(*) from jsonb_object_keys(:'j'::jsonb -> 'revoked');")" "$N_ALL"
check_has "M4 … authenticated's UPDATE on statement_line_items among them" "$(jget "$MIG_RESULT" '{revoked,statement_line_items}')" "authenticated:UPDATE"
check "M5 … no table was absent, nothing left open" "$(jget "$MIG_RESULT" '{tables_absent_here}')|$(jget "$MIG_RESULT" '{not_closed}')" "[]|[]"
report_says "C1 the report after the migration says hole_open: false" "false"
refused_everywhere "C2"
cross_tenant_refused "C3"

echo "   legitimate paths"
for t in $TABLES; do
  NONCE=$((NONCE + 1)); n0="$(rows_of "$t" "$ORG_A")"
  v="$(attempt service_role "" "$(row_sql "$t" "$ORG_A" "$P2A" "$D2A" "$NONCE")")"
  check "C4 $t: the service role still INSERTS (the engine's pipeline)" "$v|$(rows_of "$t" "$ORG_A")" "LANDED|$((n0 + 1))"
  v="$(attempt service_role "" "update public.$t set $(first_col "$t") = $(first_col "$t") where $(scope "$t" "$ORG_A")")"
  check "C5 $t: … UPDATES" "$v" "LANDED"
  v="$(attempt service_role "" "delete from public.$t where $(scope "$t" "$ORG_A") and ctid = (select max(ctid) from public.$t where $(scope "$t" "$ORG_A"))")"
  check "C6 $t: … and DELETES" "$v|$(rows_of "$t" "$ORG_A")" "LANDED|$n0"
done
READ_A_AFTER=""; READ_B_AFTER=""
for t in $TABLES; do
  READ_A_AFTER="$READ_A_AFTER $t=$(sql_as authenticated "$USER_A" "select count(*) from public.$t;")"
  READ_B_AFTER="$READ_B_AFTER $t=$(sql_as authenticated "$USER_B" "select count(*) from public.$t;")"
done
check "C7 a member still READS their own organization's rows, table by table (the engine's per_user reads)" "$READ_A_AFTER" "$READ_A_BEFORE"
check "C8 … and so does the other member — their own, not the first one's" "$READ_B_AFTER" "$READ_B_BEFORE"
check_has "C8b … (the read is real: one statement line each)" "$READ_A_BEFORE|$READ_B_BEFORE" "statement_line_items=1"
check "C9 every policy is as found (none created, none dropped)" "$(q "select md5(string_agg(tablename || ':' || policyname || ':' || cmd, ',' order by tablename, policyname)) from pg_policies where schemaname = 'public';")" "$POLICIES_BEFORE"
# What the BROWSER still does with the user's JWT: it deletes a period and a
# document (frontend/lib/orgPeriods.ts, frontend/lib/supabase.ts). Their
# derived rows go through the foreign keys' ON DELETE CASCADE, which Postgres
# runs as the referencing table's owner — the revoke must not stop it.
derived_of_period() { q "select (select count(*) from statement_line_items where period_id = '$1') || '|' || (select count(*) from calculated_metrics where period_id = '$1') || '|' || (select count(*) from briefings where period_id = '$1') || '|' || (select count(*) from benchmark_reports where period_id = '$1');"; }
check "C10 before: the other member's period holds a row in each of the four period-keyed tables" "$(derived_of_period "$P1B")" "1|1|1|1"
v="$(attempt authenticated "$USER_B" "delete from public.financial_periods where id = '$P1B'")"
check "C10b a member still DELETES their own period with their JWT" "$v" "LANDED"
check "C10c … and its derived rows go with it (the cascade runs as the tables' owner)" "$(derived_of_period "$P1B")" "0|0|0|0"
check "C11 before: the member's document holds a SKU analysis" "$(q "select count(*) from sku_analyses where document_id = '$D1B';")" "1"
v="$(attempt authenticated "$USER_B" "delete from public.documents where id = '$D1B'")"
check "C11b a member still DELETES their own document with their JWT" "$v" "LANDED"
check "C11c … and its SKU analysis goes with it" "$(q "select count(*) from sku_analyses where document_id = '$D1B';")" "0"

# ── RUN 2 ────────────────────────────────────────────────────────────────
echo "── RUN 2 — the same file again (statement by statement)"
apply_migration "$MIGRATION" autocommit
check "R1 the second run applies (exit 0)" "$MIG_RC" "0"
check "R2 … and changes nothing" "$(jget "$MIG_RESULT" '{changed_count}')|$(jget "$MIG_RESULT" '{revoked}')" "0|{}"
report_says "R3 still hole_open: false" "false"

# ── RE-OPENED BY HAND ────────────────────────────────────────────────────
echo "── RE-OPENED BY HAND — the privileges granted back on two tables"
q "grant insert, update, delete on public.statement_line_items to authenticated;
   grant all on public.briefings to anon, authenticated;" >/dev/null
report_says "H1 the report says hole_open: true" "true"
check "H1b … two tables" "$(jget "$REPORT" '{listed_open_count}')" "2"
sql_as authenticated "$USER_A" "update statement_line_items set amount = 123456789.01 where period_id = '$P1A';" >/dev/null
check "H2 OPEN AGAIN: a member rewrites the statement line" "$(q "select amount from statement_line_items where period_id = '$P1A';")" "123456789.01"
apply_migration "$MIGRATION"
check "H3 the migration applies on the re-opened database (exit 0)" "$MIG_RC" "0"
check_has "H4 … and says what it revoked" "$(jget "$MIG_RESULT" '{revoked,statement_line_items}')" "authenticated:UPDATE"
report_says "H5 the report says hole_open: false" "false"
refused_everywhere "H6"

# ── AN EMPTY DATABASE ────────────────────────────────────────────────────
echo "── AN EMPTY DATABASE — none of the listed tables"
holes_on_an_empty_database "E1" "$REPORT_SQL" "$MIGRATION"

# ── OBJECTS ANOTHER ROLE OWNS ────────────────────────────────────────────
echo "── OBJECTS ANOTHER ROLE OWNS — a listed table created by the dashboard's role, with its own grants"
holes_on_objects_another_role_owns "X1" "$REPORT_SQL" "$MIGRATION" '{listed_this_role_cannot_revoke}' '["statement_line_items"]' <<'SQL'
create table public.statement_line_items (id int primary key, amount numeric);
grant all on public.statement_line_items to anon, authenticated, service_role;
SQL

holes_finish
