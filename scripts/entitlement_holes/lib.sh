# shellcheck shell=bash
# ENTITLEMENT-HOLE GATES — shared library (sourced by scripts/check_hole_*.sh).
#
# What the four gates have in common:
#
#   · LOCAL ONLY, AND NEVER BY DEFAULT. The database is
#     ENTITLEMENT_HOLES_DB_URL and there is NO default: unset, the gate
#     prints VACUOUS and `GATE-WORK <gate> units=0` and exits 0
#     (scripts/run_battery.py reports PASS(VACUOUS), never a green count).
#     A default that addressed "the local stack" would open a hole, for
#     seconds, under whatever other gate is running on that stack — the
#     write-lockdown gate's default did exactly that (review 2026-10-03).
#     A URL whose host is not a loopback address, or that is not of the one
#     plain shape postgresql://user[:password]@host[:port]/dbname, is
#     REFUSED with exit 2 before anything is opened.
#
#   · THE GATE NEVER WRITES TO THE DATABASE THE URL NAMES. It connects there
#     only to CREATE and DROP its own scratch database
#     (holes_gate_<hole>_<pid>_<random>), builds this repository's schema in
#     it from the committed SQL, runs, and drops it on exit. A served
#     database (`postgres` on a local Supabase stack) is therefore never
#     opened, re-opened or migrated by a gate run, and two gate runs never
#     share a database. The URL's role needs CREATEDB (Supabase's `postgres`
#     has it).
#
#   · A PLANT IS NEVER A PASS. HOLE_MIGRATION / HOLE_REPORT make a gate test
#     a planted copy instead of the repository's file (the plant log's
#     drivers use them; the repository file is never edited). Such a run
#     says so on its first line and ends in exit 1 (the plant was seen) or
#     exit 3 (it was not) — never 0, so a battery that inherited one of the
#     variables cannot report green over somebody's planted file.
#
#   · SQL LEVEL, AS `authenticator`. The scratch database is not Supabase
#     (no GoTrue, no PostgREST — scripts/entitlement_holes/scratch_bootstrap.sql).
#     A request is reproduced the way PostgREST runs one: a session of the
#     role PostgREST connects as (`authenticator`), `set local role
#     authenticated` (or anon, or service_role) plus the request.jwt.claims
#     setting, then the UPDATE a PATCH is and the function call an RPC is.
#     WHAT THAT CANNOT SEE is stated in each gate's header and in
#     docs/engine_book/gates.md.
#
#     ⚠ NEVER `set role anon | authenticated | service_role` IN A SESSION OF
#     `postgres` AND THEN CALL A FUNCTION THE ROLE MAY NOT EXECUTE. On the
#     local Supabase Postgres image (17.6.1.106) that SEGFAULTS THE SERVER
#     (measured 2026-10-03, nine times, on a private container: `begin; set
#     local role anon; select f(1);` with EXECUTE revoked → signal 11, every
#     session of every database on the cluster dropped). The crash is in
#     supautils, which is preloaded into every session except
#     `authenticator`'s (that role's session_preload_libraries is
#     `safeupdate`): its `supautils.hint_roles = anon, authenticated,
#     service_role` adds a HINT to permission-denied errors, and the
#     FUNCTION case dereferences nothing. The same refusal in an
#     `authenticator` session — which is what PostgREST's are — answers
#     `permission denied for function` and no more. So every request in
#     these gates goes through holes_api_psql (below), never holes_psql.
#
# psql: the host's when there is one; otherwise psql inside the container
# ENTITLEMENT_HOLES_DB_CONTAINER, and only when that container publishes the
# port the URL names (so the URL and the container cannot disagree). Inside
# the container the `authenticator` session connects over 127.0.0.1 (the
# image's pg_hba trusts loopback); from the host it uses the URL's password
# (a local Supabase stack gives every login role the same one).

HOLES_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOLES_SQL_DIR="$HOLES_REPO/supabase"
HOLES_BOOTSTRAP="$HOLES_REPO/scripts/entitlement_holes/scratch_bootstrap.sql"

# The migrations under test. They are NEVER part of the base build: a gate
# applies its own, on top of the schema the other files produce.
HOLES_UNDER_TEST=(
  schema_phase_workspace_cap_guard.sql
  schema_phase_dashboard_config_caller.sql
  schema_phase_public_tables_write_revoke.sql
  schema_phase_derived_tables_write_revoke.sql
  schema_phase_signup_tier_trial.sql
)

# THE ORDER IS A RECORD, NOT A SORT — the order scripts/test_supabase_apply.sh
# (branch fix/test-supabase-local) discovered against a fresh stack, with the
# one file main has added since. Six functions are `create or replace`d by
# more than one file and the last writer wins, so a wrong order applies
# cleanly and silently loses a guard. An entry that starts with `@` is a
# DRIFT SHIM: production holds the object, no committed file creates it, and
# a later committed file fails without it (the statements are in
# holes_drift_sql below; each is IF NOT EXISTS).
HOLES_ORDER=(
  schema.sql
  schema_phase3.sql
  schema_phase4_multicountry.sql
  schema_phase5_usage_limits.sql
  @documents_deleted_at
  @documents_display_name_is_active
  schema_phase6_dedupe.sql
  schema_phase7_benchmarks.sql
  schema_phase7b_benchmarks_deep.sql
  schema_phase_industry_intelligence.sql
  schema_phase_pricing_v2.sql
  schema_phase_pricing_v3_atomic.sql
  schema_phase_notes_period_scope.sql
  schema_phase_intelligence_engine.sql
  schema_phase_f3_calibration.sql
  schema_phase_f4_canonical_v1.sql
  schema_phase_f4_3_detection_envelope.sql
  schema_phase_3b5_pre_backfill_snapshot.sql
  schema_phase_billing_events.sql
  schema_phase_nasdaq_public_companies.sql
  schema_phase_pricing_v2_tier_check.sql
  schema_phase_dashboard_config.sql
  schema_phase_newsletter.sql
  schema_phase_multi_workspace.sql
  schema_phase_chat.sql
  schema_phase_prefs.sql
  schema_phase_workspace_purge_now.sql
  schema_phase_storage_purge_fix.sql
  schema_phase_allow_delete_last_workspace.sql
  schema_phase_period_end_hint.sql
  schema_phase_valuation_benchmarks.sql
  schema_phase_account_deletion.sql
  schema_phase_fx_rates.sql
  schema_phase_plan_caps.sql
  schema_phase_public_funnel.sql
  schema_phase_firm.sql
  schema_phase_firm_attention.sql
  schema_phase_firm_requests.sql
  schema_phase_radar.sql
  schema_phase_workspace_purge_now_hold.sql
  schema_phase_document_quota_ledger.sql
  schema_phase_archive_hold_guard.sql
  schema_phase_briefing_ebitda_definition.sql
  schema_phase_email_idempotency.sql
  schema_phase_test_mode.sql
  @detection_opus_cache
  schema_phase_security_hardening.sql
)

# Committed files that CANNOT apply to a database built from this repository,
# each as "<file> — <why>": all three only ALTER a production table that no
# committed file creates.
HOLES_SKIP=(
  "schema_phase_sku_dio_columns.sql — alters sku_aggregates; no committed file creates it"
  "schema_phase_sku_lines_dio.sql — alters sku_lines; no committed file creates it"
  "schema_phase_valuation_ebitda_definition.sql — alters user_valuation_assumptions; no committed file creates it"
)

holes_drift_sql() { # shim name → SQL
  case "$1" in
    @documents_deleted_at)
      echo "alter table documents add column if not exists deleted_at timestamptz;" ;;
    @documents_display_name_is_active)
      echo "alter table documents add column if not exists display_name text;
            alter table documents add column if not exists is_active boolean default true;" ;;
    @detection_opus_cache)
      echo "create table if not exists detection_opus_cache (
              ocr_hash text primary key, payload jsonb not null,
              created_at timestamptz not null default now());
            alter table detection_opus_cache enable row level security;" ;;
    *) return 1 ;;
  esac
}

# ── counters and verdict lines ───────────────────────────────────────────
UNITS=0
FAILS=0
pass() { UNITS=$((UNITS + 1)); echo "PASS $1"; }
fail() { UNITS=$((UNITS + 1)); FAILS=$((FAILS + 1)); echo "FAIL $1"; shift; local l; for l in "$@"; do echo "     | $l"; done; }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "got:  $2" "want: $3"; fi; }
check_has() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1" "got:  $2" "want it to contain: $3" ;; esac; }
check_lacks() { case "$2" in *"$3"*) fail "$1" "got:  $2" "it must NOT contain: $3" ;; *) pass "$1" ;; esac; }

holes_refuse() { # exit 2: not local, or a URL this script will not parse
  echo "REFUSED — $1"
  echo "GATE-WORK $GATE units=0"
  exit 2
}
holes_vacuous() {
  echo "VACUOUS — $1"
  echo "This gate was NOT exercised on this host; this line is not a pass."
  echo "To run it: ENTITLEMENT_HOLES_DB_URL=postgresql://postgres:postgres@127.0.0.1:<port>/<a database to connect to>"
  echo "           (a LOCAL Supabase Postgres; the gate creates and drops its own scratch database there)."
  echo "GATE-WORK $GATE units=0"
  exit 0
}
holes_die() { # the gate could not do its work — a red, never a vacuous pass
  echo "FAIL $GATE could not run — $1"
  echo "GATE-WORK $GATE units=$UNITS"
  exit 1
}

# ── the database URL: explicit, plain, loopback ──────────────────────────
holes_connect() {
  local url="${ENTITLEMENT_HOLES_DB_URL:-}"
  [ -n "$url" ] || holes_vacuous "ENTITLEMENT_HOLES_DB_URL is not set (there is no default — a default would address a shared stack)"
  # One plain shape. A query string, a fragment, a host list, an escape or a
  # keyword/value string can make libpq connect somewhere other than the
  # host this function checks; the message never prints the URL (password).
  case "$url" in
    *\?*|*\#*|*,*|*%*|*' '*) holes_refuse "ENTITLEMENT_HOLES_DB_URL is not of the plain shape postgresql://user[:password]@host[:port]/dbname" ;;
  esac
  local rest
  case "$url" in
    postgresql://*) rest="${url#postgresql://}" ;;
    postgres://*)   rest="${url#postgres://}" ;;
    *) holes_refuse "ENTITLEMENT_HOLES_DB_URL is not of the plain shape postgresql://user[:password]@host[:port]/dbname" ;;
  esac
  case "$rest" in *@*) ;; *) holes_refuse "ENTITLEMENT_HOLES_DB_URL names no user" ;; esac
  local userinfo="${rest%%@*}" hostpath="${rest#*@}"
  case "$hostpath" in *@*) holes_refuse "ENTITLEMENT_HOLES_DB_URL has an '@' outside its user part" ;; esac
  case "$hostpath" in */*) ;; *) holes_refuse "ENTITLEMENT_HOLES_DB_URL names no database" ;; esac
  local hostport="${hostpath%%/*}"
  HOLES_ADMIN_DB="${hostpath#*/}"
  HOLES_USER="${userinfo%%:*}"
  HOLES_PASSWORD=""
  case "$userinfo" in *:*) HOLES_PASSWORD="${userinfo#*:}" ;; esac
  case "$hostport" in
    \[*\]*) HOLES_HOST="${hostport%%]*}"; HOLES_HOST="${HOLES_HOST#[}"; HOLES_PORT="${hostport##*]}"; HOLES_PORT="${HOLES_PORT#:}" ;;
    *:*)    HOLES_HOST="${hostport%%:*}"; HOLES_PORT="${hostport##*:}" ;;
    *)      HOLES_HOST="$hostport"; HOLES_PORT="" ;;
  esac
  [ -n "$HOLES_PORT" ] || HOLES_PORT=5432
  case "$HOLES_HOST" in
    127.0.0.1|localhost|::1) ;;
    *) holes_refuse "the database host is not a loopback address (127.0.0.1, localhost, ::1). This gate builds a database, shows a hole OPEN in it and applies a migration; it never addresses a hosted database." ;;
  esac
  case "$HOLES_ADMIN_DB$HOLES_USER$HOLES_PORT" in
    *[!A-Za-z0-9_]*) holes_refuse "the user, port or database name in ENTITLEMENT_HOLES_DB_URL holds a character outside [A-Za-z0-9_]" ;;
  esac
  [ -n "$HOLES_ADMIN_DB" ] && [ -n "$HOLES_USER" ] || holes_refuse "ENTITLEMENT_HOLES_DB_URL names no user or no database"

  # libpq fills in what a URL leaves out from the environment; none of these
  # may steer the connection.
  unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGSERVICE PGSERVICEFILE PGOPTIONS

  (exec 3<>"/dev/tcp/$HOLES_HOST/$HOLES_PORT") 2>/dev/null \
    || holes_die "ENTITLEMENT_HOLES_DB_URL is set and nothing is listening on $HOLES_HOST:$HOLES_PORT"

  local container="${ENTITLEMENT_HOLES_DB_CONTAINER:-}"
  if command -v psql >/dev/null 2>&1; then
    HOLES_VIA="psql → $HOLES_HOST:$HOLES_PORT"
    holes_psql() { local db="$1"; shift; PGPASSWORD="$HOLES_PASSWORD" psql -h "$HOLES_HOST" -p "$HOLES_PORT" -U "$HOLES_USER" -d "$db" -X -q -v ON_ERROR_STOP=1 "$@"; }
    holes_api_psql() { local db="$1"; shift; PGPASSWORD="$HOLES_PASSWORD" psql -h "$HOLES_HOST" -p "$HOLES_PORT" -U authenticator -d "$db" -X -q -v ON_ERROR_STOP=1 "$@"; }
  elif [ -n "$container" ] && command -v docker >/dev/null 2>&1 \
       && docker port "$container" 5432/tcp 2>/dev/null | grep -q ":$HOLES_PORT\$"; then
    HOLES_VIA="docker exec $container psql"
    holes_psql() { local db="$1"; shift; docker exec -i "$ENTITLEMENT_HOLES_DB_CONTAINER" psql -U "$HOLES_USER" -d "$db" -X -q -v ON_ERROR_STOP=1 "$@"; }
    holes_api_psql() { local db="$1"; shift; docker exec -i "$ENTITLEMENT_HOLES_DB_CONTAINER" psql -h 127.0.0.1 -U authenticator -d "$db" -X -q -v ON_ERROR_STOP=1 "$@"; }
  else
    holes_die "no psql on this host, and ENTITLEMENT_HOLES_DB_CONTAINER is not a running container that publishes port $HOLES_PORT"
  fi
  [ "$(holes_psql "$HOLES_ADMIN_DB" -At -c 'select 1' 2>/dev/null)" = "1" ] \
    || holes_die "cannot connect to the database the URL names ($HOLES_VIA)"
  [ "$(holes_api_psql "$HOLES_ADMIN_DB" -At -c 'select session_user' 2>/dev/null)" = "authenticator" ] \
    || holes_die "cannot open a session as authenticator (the role PostgREST connects as) — the gate's requests run in one, never in a postgres session (see the header: a refused function call under set role crashes the server there)"
}

# ── the scratch database ─────────────────────────────────────────────────
HOLES_DB=""
HOLES_EMPTY_DB=""
holes_cleanup() {
  if [ -n "$HOLES_EMPTY_DB" ]; then
    holes_psql "$HOLES_ADMIN_DB" -c "drop database if exists $HOLES_EMPTY_DB with (force)" >/dev/null 2>&1 \
      || echo "WARNING could not drop scratch database $HOLES_EMPTY_DB — drop it by hand"
    HOLES_EMPTY_DB=""
  fi
  [ -n "$HOLES_DB" ] || return 0
  if [ "${ENTITLEMENT_HOLES_KEEP_DB:-}" = "1" ]; then
    echo "KEPT scratch database $HOLES_DB (ENTITLEMENT_HOLES_KEEP_DB=1) — drop it yourself"
    return 0
  fi
  holes_psql "$HOLES_ADMIN_DB" -c "drop database if exists $HOLES_DB with (force)" >/dev/null 2>&1 \
    || echo "WARNING could not drop scratch database $HOLES_DB — drop it by hand"
  HOLES_DB=""
}

holes_base_files() { # prints "<entry>" per line: ORDER, then every other committed file
  local f base known e
  for e in "${HOLES_ORDER[@]}"; do echo "$e"; done
  for f in "$HOLES_SQL_DIR"/*.sql; do
    [ -f "$f" ] || continue
    base="${f##*/}"; known=0
    for e in "${HOLES_ORDER[@]}" "${HOLES_UNDER_TEST[@]}" "${HOLES_SKIP[@]%% *}"; do
      if [ "$e" = "$base" ]; then known=1; break; fi
    done
    [ "$known" = 1 ] || echo "$base"   # a file ORDER does not know: applied after it, in name order
  done
}

holes_apply_base_file() { # entry → 0 / 1 (stderr of the failure in HOLES_ERR)
  local entry="$1" out
  case "$entry" in
    @*) out="$(holes_drift_sql "$entry" | holes_psql "$HOLES_DB" --single-transaction -f - 2>&1 >/dev/null)" ;;
    schema_phase_intelligence_engine.sql)
      # main's copy ends with six lines of pasted shell text (`# Verify before
      # push` …) that are not SQL; branch fix/test-supabase-local removes
      # them. Cut them here so the gate runs on either copy.
      out="$(sed '/^# Verify before push/,$d' "$HOLES_SQL_DIR/$entry" | holes_psql "$HOLES_DB" --single-transaction -f - 2>&1 >/dev/null)" ;;
    *)  out="$(holes_psql "$HOLES_DB" --single-transaction -f - < "$HOLES_SQL_DIR/$entry" 2>&1 >/dev/null)" ;;
  esac
  local rc=$?
  HOLES_ERR="$(printf '%s\n' "$out" | grep -E 'ERROR|FATAL' | head -3)"
  return $rc
}

holes_build_scratch() { # hole id → creates HOLES_DB with this repository's schema
  local hole="$1" e n=0
  # A PLANT RUN tests a planted copy instead of the repository's file. It is
  # said first, and it can never end in a pass (holes_finish: exit 3).
  HOLES_PLANT=""
  [ -z "${HOLE_MIGRATION:-}" ] || HOLES_PLANT="HOLE_MIGRATION=$HOLE_MIGRATION"
  [ -z "${HOLE_REPORT:-}" ] || HOLES_PLANT="${HOLES_PLANT:+$HOLES_PLANT }HOLE_REPORT=$HOLE_REPORT"
  [ -z "$HOLES_PLANT" ] || echo "PLANT RUN — $HOLES_PLANT is tested INSTEAD of the repository's file; nothing below is a verdict on the repository"
  for e in "${HOLES_ORDER[@]}"; do
    case "$e" in @*) continue ;; esac
    [ -f "$HOLES_SQL_DIR/$e" ] || holes_die "scripts/entitlement_holes/lib.sh HOLES_ORDER names supabase/$e, which does not exist"
  done
  HOLES_DB="holes_gate_${hole}_$$_${RANDOM}"
  trap holes_cleanup EXIT
  trap 'exit 130' INT TERM
  holes_psql "$HOLES_ADMIN_DB" -c "create database $HOLES_DB template template0" >/dev/null 2>&1 \
    || { HOLES_DB=""; holes_die "could not create a scratch database (the URL's role needs CREATEDB)"; }
  holes_psql "$HOLES_DB" --single-transaction -f - < "$HOLES_BOOTSTRAP" >/dev/null 2>&1 \
    || holes_die "the scratch bootstrap did not apply (scripts/entitlement_holes/scratch_bootstrap.sql) — is this a Supabase Postgres cluster (roles anon / authenticated / service_role)?"
  while IFS= read -r e; do
    n=$((n + 1))
    holes_apply_base_file "$e" \
      || holes_die "supabase/$e does not apply to a database built from this repository ($HOLES_ERR). Place it in HOLES_ORDER (or HOLES_SKIP, with its reason) in scripts/entitlement_holes/lib.sh."
  done < <(holes_base_files)
  HOLES_BASE_FILES=$n
  echo "SCRATCH $HOLES_DB — $n files applied ($HOLES_VIA); the database the URL names ($HOLES_ADMIN_DB) is not written"
}

# ── running SQL ──────────────────────────────────────────────────────────
q() { # SQL as the URL's role → output (errors included), unaligned
  holes_psql "$HOLES_DB" -At 2>&1 <<SQL
$1
SQL
}
# A request, the way PostgREST runs one: an `authenticator` session, the
# role and the claims set for one transaction. (safeupdate is loaded in that
# session, as it is in PostgREST's: an UPDATE or DELETE needs a WHERE.)
#   sql_as authenticated <user uuid> "<sql>"     a signed-in user's JWT
#   sql_as anon "" "<sql>"                       the anon key alone
#   sql_as service_role "" "<sql>"               the service-role key
sql_as() {
  local role="$1" sub="$2" body="$3" claims
  case "$role" in anon|authenticated|service_role) ;; *) echo "sql_as: unknown role $role"; return 1 ;; esac
  if [ -n "$sub" ]; then claims="{\"sub\":\"$sub\",\"role\":\"$role\"}"; else claims="{\"role\":\"$role\"}"; fi
  holes_api_psql "$HOLES_DB" -At 2>&1 <<SQL
begin;
do \$claims\$ begin perform set_config('request.jwt.claims', '$claims', true); end \$claims\$;
set local role $role;
$body
commit;
SQL
}
# A new user, the way a signup lands: one auth.users row (the trigger seeds
# the profile, the subscription, the organization and the membership).
new_user() { # uuid email-local-part
  q "insert into auth.users (id, email, raw_user_meta_data) values ('$1', '$2@holes-gate.invalid', '{}'::jsonb);" >/dev/null
}

# Apply a migration the way the coordinator does (one batch, one transaction,
# the LAST statement's result is the answer). Sets MIG_RC, MIG_OUT (stdout
# and stderr) and MIG_RESULT (the last line psql printed).
apply_migration() { # file [autocommit]
  local file="$1" mode="${2:-}"
  if [ "$mode" = "autocommit" ]; then
    MIG_OUT="$(holes_psql "$HOLES_DB" -At -f - < "$file" 2>&1)"; MIG_RC=$?
  else
    MIG_OUT="$(holes_psql "$HOLES_DB" -At --single-transaction -f - < "$file" 2>&1)"; MIG_RC=$?
  fi
  MIG_RESULT="$(printf '%s\n' "$MIG_OUT" | grep -v '^$' | tail -1)"
}
# The preflight / post-check report: ONE read-only statement, one jsonb row.
# Run inside a READ ONLY transaction, so a report that writes is an error.
run_report() { # file → REPORT (the row) and REPORT_RC
  REPORT="$( { echo 'begin transaction read only;'; cat "$1"; echo; echo 'commit;'; } | holes_psql "$HOLES_DB" -At -f - 2>&1)"; REPORT_RC=$?
  REPORT="$(printf '%s\n' "$REPORT" | grep -v '^$' | tail -1)"
}
# A jsonb value out of a result row, by path — asked of Postgres, not of sed.
jget() { # json path-as-text-array-literal, e.g. '{hole_open}'
  local json="$1" path="$2"
  holes_psql "$HOLES_DB" -At -v j="$json" -v p="$path" 2>&1 <<'SQL'
select coalesce((:'j'::jsonb #>> :'p'::text[]), 'null');
SQL
}

# SQL over a result row: the row is the psql variable j (write :'j'::jsonb).
jsql() { # json sql
  local json="$1"
  holes_psql "$HOLES_DB" -At -v j="$json" 2>&1 <<SQL
$2
SQL
}

# The table list of a migration, read from the migration (the one place it
# is written): the quoted names between <MARKER>-BEGIN and <MARKER>-END.
tables_between() { # file marker
  sed -n "/$2-BEGIN/,/$2-END/p" "$1" | sed -n "s/^[[:space:]]*'\([a-z_0-9]*\)'.*/\1/p"
}
# The whole content of a table, as one digest (as the table's owner).
table_digest() { q "select md5(coalesce(string_agg(t::text, E'\n' order by t::text), '')) || ':' || count(*) from public.$1 t;"; }
# What a write attempt answered, in one word.
write_verdict() { # output of `with x as (<write> returning 1) select count(*) from x`
  case "$1" in
    *"permission denied for table"*) echo "refused: no privilege" ;;
    *"permission denied for function"*) echo "refused: a policy's function is not executable" ;;
    *"violates row-level security"*) echo "refused: row level security" ;;
    *ERROR*) echo "error: $(printf '%s' "$1" | grep ERROR | head -1)" ;;
    0) echo "0 rows" ;;
    *[!0-9]*|"") echo "unreadable: $1" ;;
    *) echo "LANDED" ;;
  esac
}

# A DATABASE THAT HOLDS NONE OF THE OBJECTS (the bootstrap only — the roles,
# auth.users, nothing of this repository). Production's schema is not this
# repository's: a report or a migration that assumes a table, a column or a
# function raises there, and through the Management API a raise is all the
# coordinator gets. Three cases per file pair: the report answers one row
# with "hole_open": false; the migration applies; it changes nothing.
holes_on_an_empty_database() { # tag report-file migration-file
  local tag="$1" report="$2" migration="$3" keep="$HOLES_DB"
  HOLES_EMPTY_DB="${keep}_empty"
  if ! holes_psql "$HOLES_ADMIN_DB" -c "create database $HOLES_EMPTY_DB template template0" >/dev/null 2>&1 \
     || ! holes_psql "$HOLES_EMPTY_DB" --single-transaction -f - < "$HOLES_BOOTSTRAP" >/dev/null 2>&1; then
    fail "$tag an empty scratch database could be built" "create database / bootstrap failed"
    return
  fi
  HOLES_DB="$HOLES_EMPTY_DB"
  run_report "$report"
  check "$tag the report answers where NONE of the objects exist: one row, hole_open false" "$REPORT_RC|$(jget "$REPORT" '{hole_open}')" "0|false"
  apply_migration "$migration"
  check "$tag the migration applies there (exit 0)" "$MIG_RC" "0"
  [ "$MIG_RC" = 0 ] || echo "     | $MIG_OUT"
  check "$tag … and changes nothing" "$(jget "$MIG_RESULT" '{changed_count}')" "0"
  HOLES_DB="$keep"
  holes_psql "$HOLES_ADMIN_DB" -c "drop database if exists $HOLES_EMPTY_DB with (force)" >/dev/null 2>&1 && HOLES_EMPTY_DB=""
}

holes_finish() {
  echo "GATE-WORK $GATE units=$UNITS"
  if [ "$FAILS" -gt 0 ]; then
    echo "FAIL $GATE — $FAILS of $UNITS cases failed"
    exit 1
  fi
  if [ -n "${HOLES_PLANT:-}" ]; then
    # Every case passed over a planted file: the gate did not see the plant.
    # Never exit 0 — a battery that inherited the variable must not go green
    # over a file that is not the repository's.
    echo "PLANT NOT SEEN $GATE — all $UNITS cases passed over a planted file ($HOLES_PLANT)"
    exit 3
  fi
  echo "PASS $GATE — $UNITS cases"
  exit 0
}
