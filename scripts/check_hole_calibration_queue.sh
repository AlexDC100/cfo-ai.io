#!/usr/bin/env bash
# HOLE-CALIBRATION-QUEUE GATE — supabase/schema_phase_calibration_queue_write_revoke.sql
#
# What is open (one table of the census the public-tables gate starts from):
# calibration_rules — the operator's review queue of account → bucket rules —
# has row level security and ONE write policy, whose check admits a row with
# org_id NULL: a GLOBAL rule, for every company. Any signed-in user, with
# their own JWT, puts a pending global rule into the queue the operator
# approves from. Every legitimate writer is the engine's service role.
#
# What it proves, one PASS/FAIL line per case, in a scratch database built
# from this repository's SQL (scripts/entitlement_holes/lib.sh). THE LIST is
# read from the migration:
#   OPEN   the report says "hole_open": true and that the write policy admits
#          a global row; a signed-in user INSERTS a global pending rule, and
#          one for their own organization; another organization's is refused
#          (the policy's scoped half — the control, before and after); anon is
#          stopped only by a function it may not execute inside the policy;
#   RUN 1  the migration applies as one batch and says what it revoked; the
#          report says "hole_open": false; every write of a signed-in user and
#          of anon is refused and the table is byte-identical; the SERVICE
#          ROLE still inserts a proposal, approves it and deletes it (the
#          engine's review routes); a member still reads what they read before
#          (and anon as before); row level security and the policies are as
#          found;
#   RUN 2  a second run changes nothing and says so;
#   RE-OPENED BY HAND  `grant all`, a grant to PUBLIC, a column-level grant —
#          shown OPEN again (the global rule lands), then closed;
#   PRODUCTION'S SHAPE  the table present, the twelve public-market tables
#          ABSENT: this file closes its one table, and the public-tables file
#          run there changes nothing and says there was nothing to do;
#   AN ABSENT TABLE / AN EMPTY DATABASE  the report and the migration answer
#          where calibration_rules does not exist — "skipped" says so;
#   OBJECTS ANOTHER ROLE OWNS  the report says the hole is open and that this
#          role cannot change the object; the migration applies WITHOUT an
#          error, changes nothing and names what it could not close.
#
# WHAT IT CANNOT SEE. PostgREST itself (a request is reproduced as the SQL it
# is, in an `authenticator` session); a user-JWT WRITER of the table in the
# product's code — that is the static law
# (tests/engine/test_entitlement_hole_laws.py), which reds the day one
# appears; the engine's review routes themselves (their writes are reproduced
# as the service-role statements they are); what the OPERATOR approves (a
# rule the service role inserts on a user's behalf is the engine's to
# validate, not this file's); a policy production holds under another name
# (the report prints every write policy with its check expression).
#
# LOCAL ONLY, never by default: see scripts/entitlement_holes/lib.sh.
#   ENTITLEMENT_HOLES_DB_URL=postgresql://postgres:postgres@127.0.0.1:<port>/<db> \
#   [ENTITLEMENT_HOLES_DB_CONTAINER=<container>] scripts/check_hole_calibration_queue.sh
#   HOLE_MIGRATION=<a planted copy>   apply that file instead (plants)
#   HOLE_REPORT=<a planted copy>      read that report instead (plants)
# Exit: 0 every case passed (or VACUOUS) · 1 a case failed · 2 refused ·
#       3 a PLANTED file passed every case (never a pass: the gate did not see it).

set -u
set -o pipefail
GATE="hole-calibration-queue"
# shellcheck source=scripts/entitlement_holes/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/entitlement_holes/lib.sh"

MIGRATION="${HOLE_MIGRATION:-$HOLES_SQL_DIR/schema_phase_calibration_queue_write_revoke.sql}"
REPO_MIGRATION="$HOLES_SQL_DIR/schema_phase_calibration_queue_write_revoke.sql"
REPORT_SQL="${HOLE_REPORT:-$HOLES_SQL_DIR/preflight/schema_phase_calibration_queue_write_revoke_preflight_report.sql}"
PUBLIC_MIGRATION="$HOLES_SQL_DIR/schema_phase_public_tables_write_revoke.sql"
PUBLIC_REPORT="$HOLES_SQL_DIR/preflight/schema_phase_public_tables_write_revoke_preflight_report.sql"

echo "HOLE-CALIBRATION-QUEUE GATE — $(basename "$MIGRATION")"
holes_connect
[ -f "$MIGRATION" ] || holes_die "the migration file does not exist: $MIGRATION"
[ -f "$REPORT_SQL" ] || holes_die "the preflight report does not exist: $REPORT_SQL"

TABLES="$(tables_between "$REPO_MIGRATION" CALIBRATION-QUEUE | tr '\n' ' ')"
[ "$TABLES" = "calibration_rules " ] || { echo "FAIL the migration's list is calibration_rules — read: '$TABLES'"; echo "GATE-WORK $GATE units=0"; exit 1; }
T="calibration_rules"

holes_build_scratch h3c
USER_A="a0000000-0000-4000-8000-0000000000a6"; USER_B="b0000000-0000-4000-8000-0000000000b6"
new_user "$USER_A" h3c-member-a
new_user "$USER_B" h3c-member-b
org_of() { q "select org_id from memberships where user_id = '$1' limit 1;"; }
ORG_A="$(org_of "$USER_A")"; ORG_B="$(org_of "$USER_B")"
COA="$(q "select key from coa_registries order by key limit 1;")"
[ -n "$COA" ] || holes_die "the scratch database holds no coa_registries row to reference"

rule_sql() { # n org-or-null status source → an INSERT statement (no trailing semicolon)
  local org="null"; [ "$2" = "null" ] || org="'$2'"
  echo "insert into calibration_rules (coa_key, account_code, standardized_bucket, status, source, org_id) values ('$COA', '9$1', 'revenue', '$3', '$4', $org)"
}
# What the ENGINE holds already: an approved global rule and one of each member's organization.
q "$(rule_sql 001 null approved admin); $(rule_sql 002 "$ORG_A" pending review_mode); $(rule_sql 003 "$ORG_B" pending review_mode);" >/dev/null
[ "$(q "select count(*) from calibration_rules;")" = "3" ] || holes_die "could not seed calibration_rules"

rows() { q "select count(*) from public.$T;"; }
globals() { q "select count(*) from public.$T where org_id is null;"; }
attempt() { write_verdict "$(sql_as "$1" "$2" "with x as ($3 returning 1) select count(*) from x;")"; }
report_says() { # label want-hole_open
  run_report "$REPORT_SQL"
  if [ "$REPORT_RC" != 0 ]; then fail "$1" "the report failed: $REPORT"; return; fi
  check "$1" "$(jget "$REPORT" '{hole_open}')" "$2"
}
NONCE=100
refused_everywhere() { # tag
  local tag="$1" before v
  before="$(table_digest "$T")"
  NONCE=$((NONCE + 1))
  v="$(attempt authenticated "$USER_A" "$(rule_sql "$NONCE" null pending review_mode)")"
  check "$tag a signed-in user's INSERT of a GLOBAL pending rule is refused" "$v" "refused: no privilege"
  NONCE=$((NONCE + 1))
  v="$(attempt authenticated "$USER_A" "$(rule_sql "$NONCE" "$ORG_A" pending review_mode)")"
  check "$tag … of a rule for their OWN organization too (the engine writes it for them)" "$v" "refused: no privilege"
  v="$(attempt authenticated "$USER_A" "update public.$T set status = 'approved' where true")"
  check "$tag a signed-in user's UPDATE (approve) is refused" "$v" "refused: no privilege"
  v="$(attempt authenticated "$USER_A" "delete from public.$T where true")"
  check "$tag … DELETE" "$v" "refused: no privilege"
  v="$(sql_as authenticated "$USER_A" "truncate public.$T cascade;")"
  check_has "$tag … TRUNCATE" "$v" "permission denied for table"
  NONCE=$((NONCE + 1))
  v="$(attempt anon "" "$(rule_sql "$NONCE" null pending review_mode)")"
  check "$tag anon's INSERT is refused — now by the privilege" "$v" "refused: no privilege"
  v="$(attempt anon "" "delete from public.$T where true")"
  check "$tag anon's DELETE is refused" "$v" "refused: no privilege"
  check "$tag the table is byte-identical after every attack" "$(table_digest "$T")" "$before"
}

# ── OPEN ─────────────────────────────────────────────────────────────────
echo "── OPEN — the schema this repository's other files build"
report_says "O1 the report on the fresh schema says hole_open: true" "true"
check "O1b … row level security is ON (this is a policy that admits too much, not a table left open)" "$(jget "$REPORT" '{listed,0,row_level_security}')" "true"
check "O1c … and it says the INSERT policy admits a GLOBAL row" "$(jsql "$REPORT" "select string_agg((p ->> 'cmd') || ':' || (p ->> 'admits_a_global_row'), ',') from jsonb_array_elements(:'j'::jsonb #> '{listed,0,write_policies}') p;")" "INSERT:true"
n0="$(rows)"; g0="$(globals)"
v="$(attempt authenticated "$USER_A" "$(rule_sql 010 null pending review_mode)")"
check "O2 OPEN: any signed-in user INSERTS a GLOBAL (org_id null) pending rule into the operator's queue" "$v|$(globals)" "LANDED|$((g0 + 1))"
v="$(attempt authenticated "$USER_A" "$(rule_sql 011 "$ORG_A" pending review_mode)")"
check "O3 OPEN: … and one for their own organization" "$v|$(rows)" "LANDED|$((n0 + 2))"
v="$(attempt authenticated "$USER_A" "$(rule_sql 012 "$ORG_B" pending review_mode)")"
check "O4 the control: a rule for ANOTHER organization is refused by the policy" "$v" "refused: row level security"
v="$(attempt authenticated "$USER_A" "$(rule_sql 013 null approved admin)")"
check "O5 the control: an APPROVED rule is refused by the policy (a user proposes, never approves)" "$v" "refused: row level security"
v="$(attempt authenticated "$USER_A" "update public.$T set status = 'approved' where true")"
check "O6 the control: no UPDATE policy — a user approves nothing" "$v" "0 rows"
v="$(attempt anon "" "$(rule_sql 014 null pending review_mode)")"
check "O7 anon is stopped only by a function it may not execute inside the policy" "$v" "refused: a policy's function is not executable"
ANON_READ_BEFORE="$(sql_as anon "" "select count(*) from public.$T;" | tail -1)"
READ_A_BEFORE="$(sql_as authenticated "$USER_A" "select count(*) from public.$T;")"
READ_B_BEFORE="$(sql_as authenticated "$USER_B" "select count(*) from public.$T;")"
CATALOG_BEFORE="$(q "select md5(string_agg(c.relname || ':' || c.relrowsecurity || ':' || (select count(*) from pg_policy p where p.polrelid = c.oid), ',' order by c.relname)) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r';")"
POLICIES_BEFORE="$(q "select md5(string_agg(tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ',' order by tablename, policyname)) from pg_policies where schemaname = 'public';")"

# ── RUN 1 ────────────────────────────────────────────────────────────────
echo "── RUN 1 — the migration, one batch"
apply_migration "$MIGRATION"
check "M1 the migration applies (exit 0)" "$MIG_RC" "0"
[ "$MIG_RC" = 0 ] || echo "     | $MIG_OUT"
check "M2 its last statement names the file" "$(jget "$MIG_RESULT" '{migration}')" "schema_phase_calibration_queue_write_revoke.sql"
check "M3 … revoked the four write privileges from both API roles on calibration_rules" "$(jsql "$MIG_RESULT" "select string_agg(x, ',' order by x) from jsonb_array_elements_text(:'j'::jsonb #> '{revoked,calibration_rules}') x;")" "anon:DELETE,anon:INSERT,anon:TRUNCATE,anon:UPDATE,authenticated:DELETE,authenticated:INSERT,authenticated:TRUNCATE,authenticated:UPDATE"
check "M4 … 8 changes, the table not absent, nothing skipped, nothing left open" "$(jget "$MIG_RESULT" '{changed_count}')|$(jget "$MIG_RESULT" '{tables_absent_here}')|$(jget "$MIG_RESULT" '{skipped}')|$(jget "$MIG_RESULT" '{not_closed}')" "8|[]|[]|[]"
report_says "C1 the report after the migration says hole_open: false" "false"
check "C1b … (no write privilege left to an API role)" "$(jget "$REPORT" '{listed,0,api_write_privileges}')" "[]"
refused_everywhere "C2"

echo "   legitimate paths"
n0="$(rows)"
v="$(attempt service_role "" "$(rule_sql 020 "$ORG_A" pending review_mode)")"
check "C3 the service role still INSERTS a proposal (the engine's review route)" "$v|$(rows)" "LANDED|$((n0 + 1))"
v="$(attempt service_role "" "update public.$T set status = 'approved', approved_at = now() where account_code = '9020'")"
check "C4 … APPROVES it (the operator's route)" "$v|$(q "select status from public.$T where account_code = '9020';")" "LANDED|approved"
v="$(attempt service_role "" "delete from public.$T where account_code = '9020'")"
check "C5 … and DELETES it" "$v|$(rows)" "LANDED|$n0"
check "C6 SELECT is left exactly as found: a member reads what they read before" "$(sql_as authenticated "$USER_A" "select count(*) from public.$T;")|$(sql_as authenticated "$USER_B" "select count(*) from public.$T;")" "$READ_A_BEFORE|$READ_B_BEFORE"
check "C6b … (the read is real and scoped: the global rules and their own organization's, not the other's)" "$READ_A_BEFORE" "$(q "select count(*) from public.$T where org_id is null or org_id = '$ORG_A';")"
check "C6c … and anon answers what it answered before" "$(sql_as anon "" "select count(*) from public.$T;" | tail -1)" "$ANON_READ_BEFORE"
check "C7 row level security and the number of policies are as found, on every table" "$(q "select md5(string_agg(c.relname || ':' || c.relrowsecurity || ':' || (select count(*) from pg_policy p where p.polrelid = c.oid), ',' order by c.relname)) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r';")" "$CATALOG_BEFORE"
check "C7b … and every policy's text (none created, dropped or altered)" "$(q "select md5(string_agg(tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ',' order by tablename, policyname)) from pg_policies where schemaname = 'public';")" "$POLICIES_BEFORE"
check "C8 SELECT, REFERENCES and TRIGGER are still held by authenticated (only the four write privileges went)" "$(q "select has_table_privilege('authenticated', 'public.$T', 'SELECT')::text || has_table_privilege('authenticated', 'public.$T', 'REFERENCES')::text || has_table_privilege('authenticated', 'public.$T', 'TRIGGER')::text;")" "truetruetrue"
check "C9 no other table lost a privilege (the twelve public-market tables are not this file's)" "$(q "select has_table_privilege('anon', 'public.public_companies', 'INSERT')::text || has_table_privilege('authenticated', 'public.documents', 'INSERT')::text;")" "truetrue"

# ── RUN 2 ────────────────────────────────────────────────────────────────
echo "── RUN 2 — the same file again (statement by statement)"
apply_migration "$MIGRATION" autocommit
check "R1 the second run applies (exit 0)" "$MIG_RC" "0"
check "R2 … and changes nothing" "$(jget "$MIG_RESULT" '{changed_count}')|$(jget "$MIG_RESULT" '{revoked}')" "0|{}"
report_says "R3 still hole_open: false" "false"

# ── RE-OPENED BY HAND ────────────────────────────────────────────────────
echo "── RE-OPENED BY HAND — grant all; a grant to PUBLIC; a column-level grant"
q "grant all on public.$T to authenticated;" >/dev/null
report_says "H1 after \`grant all … to authenticated\` the report says hole_open: true" "true"
g0="$(globals)"
v="$(attempt authenticated "$USER_A" "$(rule_sql 030 null pending review_mode)")"
check "H2 OPEN AGAIN: a signed-in user inserts a global pending rule" "$v|$(globals)" "LANDED|$((g0 + 1))"
apply_migration "$MIGRATION"
check_has "H3 the migration says what it revoked" "$(jget "$MIG_RESULT" '{revoked,calibration_rules}')" "authenticated:INSERT"
report_says "H4 the report says hole_open: false" "false"
q "grant insert on public.$T to public;" >/dev/null
report_says "H5 after a grant to PUBLIC the report says hole_open: true" "true"
v="$(attempt authenticated "$USER_A" "$(rule_sql 031 null pending review_mode)")"
check "H6 OPEN AGAIN through PUBLIC's grant" "$v" "LANDED"
apply_migration "$MIGRATION"
check_has "H7 the migration revoked PUBLIC's grant" "$(jget "$MIG_RESULT" '{revoked,calibration_rules}')" "PUBLIC:INSERT"
report_says "H8 the report says hole_open: false" "false"
q "grant insert (coa_key, account_code, standardized_bucket, status, source, org_id) on public.$T to authenticated;" >/dev/null
report_says "H9 after a COLUMN-LEVEL grant the report says hole_open: true" "true"
v="$(attempt authenticated "$USER_A" "$(rule_sql 032 null pending review_mode)")"
check "H10 OPEN AGAIN through the column grant" "$v" "LANDED"
apply_migration "$MIGRATION"
check "H11 nothing left open" "$(jget "$MIG_RESULT" '{not_closed}')" "[]"
report_says "H12 the report says hole_open: false" "false"
refused_everywhere "H13"

# ── PRODUCTION'S SHAPE ───────────────────────────────────────────────────
# As the coordinator read it (2026-10-04): calibration_rules is there with
# its member-write policy; none of the twelve public-market tables is.
echo "── PRODUCTION'S SHAPE — calibration_rules present, the twelve public-market tables absent"
q "grant all on public.$T to anon, authenticated;" >/dev/null
for t in $(tables_between "$PUBLIC_MIGRATION" PUBLIC-TABLES-RLS-OFF); do
  q "drop table if exists public.$t cascade;" >/dev/null
done
check "P1 the scratch database now has that shape: none of the twelve, calibration_rules with its policy" "$(q "select (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname in ('public_companies', 'intelligence_signals', 'sector_risk_models')) || '|' || (select count(*) from pg_policies where tablename = '$T' and cmd = 'INSERT');")" "0|1"
report_says "P2 there THIS report says hole_open: true" "true"
run_report "$PUBLIC_REPORT"
check "P3 … and the public-tables report says hole_open: false — none of its twelve exists, nothing to do" "$REPORT_RC|$(jget "$REPORT" '{hole_open}')|$(jget "$REPORT" '{listed_existing_count}')" "0|false|0"
check "P3b … while its census names calibration_rules as open and closed by THIS file" "$(jsql "$REPORT" "select x ->> 'this_repository_says' from jsonb_array_elements(:'j'::jsonb -> 'other_open_tables') x where x ->> 'table' = '$T';")" "closed by schema_phase_calibration_queue_write_revoke.sql"
ACL_BEFORE="$(q "select md5(string_agg(c.relname || ':' || coalesce(c.relacl::text, ''), ',' order by c.relname)) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r';")"
apply_migration "$PUBLIC_MIGRATION"
check "P4 the public-tables MIGRATION run there applies (exit 0), changes nothing and says there was nothing to do" "$MIG_RC|$(jget "$MIG_RESULT" '{changed_count}')|$(jsql "$MIG_RESULT" "select jsonb_array_length(:'j'::jsonb -> 'tables_absent_here');")|$(jget "$MIG_RESULT" '{skipped}')" '0|0|12|["none of the 12 listed tables exists in this database — nothing to do"]'
check "P4b … not one grant on any table moved" "$(q "select md5(string_agg(c.relname || ':' || coalesce(c.relacl::text, ''), ',' order by c.relname)) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r';")" "$ACL_BEFORE"
apply_migration "$MIGRATION"
check "P5 this migration closes its one table there (8 privileges)" "$MIG_RC|$(jget "$MIG_RESULT" '{changed_count}')" "0|8"
report_says "P6 the report says hole_open: false" "false"
v="$(attempt authenticated "$USER_A" "$(rule_sql 040 null pending review_mode)")"
check "P7 a signed-in user's global rule is refused" "$v" "refused: no privilege"

# ── AN ABSENT TABLE ──────────────────────────────────────────────────────
echo "── AN ABSENT TABLE — calibration_rules dropped"
q "drop table public.$T cascade;" >/dev/null
apply_migration "$MIGRATION"
check "A1 the migration applies with the table missing (exit 0), changes nothing, names it and says there was nothing to do" "$MIG_RC|$(jget "$MIG_RESULT" '{changed_count}')|$(jget "$MIG_RESULT" '{tables_absent_here}')|$(jget "$MIG_RESULT" '{skipped}')" '0|0|["calibration_rules"]|["public.calibration_rules does not exist in this database — nothing to do"]'
report_says "A2 the report answers too: hole_open false" "false"
check "A2b … and says the table does not exist here" "$(jget "$REPORT" '{listed,0,exists}')" "false"

# ── AN EMPTY DATABASE ────────────────────────────────────────────────────
echo "── AN EMPTY DATABASE — none of the objects"
holes_on_an_empty_database "E1" "$REPORT_SQL" "$MIGRATION"
check_has "E1 … and its last row SAYS there was nothing to do (skipped — never an empty answer, never a failure)" "$(jget "$MIG_RESULT" '{skipped}')" "public.calibration_rules does not exist in this database — nothing to do"

# ── OBJECTS ANOTHER ROLE OWNS ────────────────────────────────────────────
echo "── OBJECTS ANOTHER ROLE OWNS — the table created by the dashboard's role, with its own grants"
holes_on_objects_another_role_owns "X1" "$REPORT_SQL" "$MIGRATION" '{listed_this_role_cannot_revoke}' '["calibration_rules"]' <<'SQL'
create table public.calibration_rules (id int primary key, org_id uuid, status text);
grant all on public.calibration_rules to anon, authenticated, service_role;
SQL

holes_finish
