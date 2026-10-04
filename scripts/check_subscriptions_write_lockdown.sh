#!/usr/bin/env bash
# SUBSCRIPTIONS-WRITE-LOCKDOWN GATE —
# supabase/schema_phase_subscriptions_write_lockdown.sql, exercised on the
# LOCAL Supabase stack through REAL PostgREST with a REAL GoTrue session
# (no double, no mirror, no `set role` standing in for the API).
#
# The incident (2026-10-03): supabase/schema.sql gave every signed-in user an
# INSERT and an UPDATE policy on their own public.subscriptions row, and
# Supabase's default grants gave `authenticated` the privileges to use them —
# a PATCH of {"tier":"multi","status":"active"} from the browser was a paid
# plan with no payment.
#
# What it proves, one PASS/FAIL line per case, from FOUR starting states that
# must each end in the same catalog and the same refused-attack table:
#   (a) the catalog a database built from this repository has BEFORE the fix
#       (the two write policies present, the default grants in place, the
#       three own-row SELECT policies as the old files created them: with no
#       `to authenticated`, so `to public`) — and the attack is first shown to
#       SUCCEED there, so the harness is known to see an open hole;
#   (b) the hand-applied three-statement STOPGAP on top of (a) (the two write
#       policies dropped; insert, update, delete, truncate, references, trigger
#       revoked from anon and authenticated on subscriptions) — what a
#       production database built from the old files holds once the stopgap
#       was run. The migration must run on top of it without an error and
#       still close what the stopgap left: anon's SELECT, MAINTAIN, the two
#       meters' default ALL, and the three policies' `to public`;
#   (c) the migration's own result (a second run: idempotent, and silent);
#   (d) a locked database somebody RE-OPENED BY HAND under names the migration
#       has never heard of (a `for all` policy to authenticated, a permissive
#       `using (true)` read, a column-level `grant update (tier, status)`, row
#       level security off on a meter, privileges handed back to anon) — shown
#       OPEN first (the attacker writes ANOTHER user's tier), then closed.
# In each: every write of a signed-in user to their own row is refused
# (status, the body's reason, and the row read back with the service role is
# byte-identical), on every sold tier and every entitlement column; INSERT
# when no row exists, DELETE, and every write to another user's row — and the
# same write through the GraphQL endpoint (/graphql/v1) where the stack serves
# it; anon sees nothing; the user still reads their own row and only that; the service
# role's webhook-shaped upsert, a brand-new signup's seeded row and the
# document / chat reserve-commit RPCs still work; every sibling entitlement
# table refuses a user write. THE FENCE: every application of the migration
# is bracketed by a fingerprint of every row of every listed table — a
# migration that only restricts access changes no row, and the audit report's
# `row_fingerprints` (the instrument an operator has in production) must say
# the same. Beside the behaviour, the catalog laws: row
# level security on, no policy that is not a SELECT policy, no privilege for
# anon, no write privilege for authenticated, on every table of THE LIST —
# which this script reads from the migration (one list); no function an API
# role may call names a listed table but the product's two; no view over a
# listed table that an API role can write through — while a public AGGREGATE
# view over one (the shape of production's founder_cohort_public, which no
# file in this repository creates) still answers anon.
#
# OWNER-PLAN. The migration is correct with and without
# supabase/schema_phase_owner_plan.sql. A case that needs an owner-plan
# object (plan_assignment_audit, assign_internal_plan, the both-orders run)
# is SKIPPED when the object is not there — printed as `SKIP`, counted
# apart, never a pass. The GraphQL row is skipped the same way on a stack
# that serves no /graphql/v1.
#
# LOCAL ONLY, AND ONLY WHERE IT IS TOLD. The database is SUBS_LOCKDOWN_DB_URL
# and the API is SUBS_LOCKDOWN_API_URL; there is NO default. With either one
# unset the gate is VACUOUS: a machine's standard local stack is shared, and
# this script creates users, re-creates the open state (a) and applies a
# migration. A host that is not a loopback address is REFUSED (exit 2) before
# anything is opened.
#
# VACUOUS, never green, when no stack is named or the named one is not running: it prints
# `GATE-WORK subscriptions-write-lockdown units=0` and exits 0;
# scripts/run_battery.py reports that as PASS(VACUOUS).
#
# It creates its own users (…@subs-gate.invalid) and removes them, their
# workspaces and their counters on exit. It never resets or drops a table.
# ON EXIT IT RE-APPLIES THE REPOSITORY'S MIGRATION, whatever happened in
# between and whatever file the run was pointed at: states (a), (b) and (d)
# are open holes, and neither a run that dies half-way nor a plant run
# (SUBS_LOCKDOWN_MIGRATION=<a planted copy>) may leave the stack open.
#
# Usage:  scripts/check_subscriptions_write_lockdown.sh               the gate
#         … --observe          apply NOTHING, assert nothing: print the attack
#                              table as this database answers it today
#         … --before a|b|c|d   build that starting state (a, b and d OPEN the
#                              hole on the local stack), print the table;
#                              the migration is re-applied on exit
#         … --after  a|b|c|d   build it, apply the migration, print the table
#         (the BEFORE / AFTER tables of docs/engine_book/gates.md)
# Exit:   0 every case passed (or vacuous, or a table mode) · 1 a case failed
#         · 2 refused (not local, or an argument this script does not know)

set -u
set -o pipefail

GATE="subscriptions-write-lockdown"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION="${SUBS_LOCKDOWN_MIGRATION:-$REPO/supabase/schema_phase_subscriptions_write_lockdown.sql}"
OWNER_PLAN_MIGRATION="${SUBS_LOCKDOWN_OWNER_PLAN_MIGRATION:-$REPO/supabase/schema_phase_owner_plan.sql}"
# NO DEFAULT STACK. A machine's standard local stack is shared: this gate
# creates users on it and holds the hole open for seconds at a time, under
# whatever else runs there. It runs only where it is TOLD which stack.
DB_URL="${SUBS_LOCKDOWN_DB_URL:-}"
API_URL="${SUBS_LOCKDOWN_API_URL:-}"
CONTAINER="${SUBS_LOCKDOWN_DB_CONTAINER:-}"
PREFLIGHT_REPORT="$REPO/supabase/schema_phase_subscriptions_write_lockdown_preflight_report.sql"
AUDIT_REPORT="$REPO/supabase/schema_phase_subscriptions_write_lockdown_audit_report.sql"
PREFLIGHT_GRIDS="$REPO/supabase/schema_phase_subscriptions_write_lockdown_preflight.sql"
REPO_MIGRATION="$REPO/supabase/schema_phase_subscriptions_write_lockdown.sql"
MODE="gate"; STATE=""
usage() {
  echo "usage: $(basename "$0") [--observe | --before a|b|c|d | --after a|b|c|d]"
  echo "GATE-WORK $GATE units=0"
  exit 2
}
case "${1:-}" in
  "") ;;
  --observe) MODE="observe" ;;
  --before|--after)
    MODE="${1#--}"; STATE="${2:-}"
    case "$STATE" in a|b|c|d) ;; *) usage ;; esac ;;
  *) usage ;;
esac

echo "SUBSCRIPTIONS-WRITE-LOCKDOWN GATE — $(basename "$MIGRATION") on the local stack"

if [ -z "$DB_URL" ] || [ -z "$API_URL" ]; then
  echo "VACUOUS — SUBS_LOCKDOWN_DB_URL and SUBS_LOCKDOWN_API_URL are not both set."
  echo "This gate addresses NO stack by default: it creates users and re-opens the hole to"
  echo "prove it sees one, and a machine's standard local stack is shared with other work."
  echo "Name an isolated local stack, both its database and its API:"
  echo "  SUBS_LOCKDOWN_DB_URL=postgresql://postgres:postgres@127.0.0.1:<db port>/postgres \\"
  echo "  SUBS_LOCKDOWN_API_URL=http://127.0.0.1:<api port> $0"
  echo "The write lockdown was NOT exercised; this line is not a pass."
  echo "GATE-WORK $GATE units=0"
  exit 0
fi

# ── The local-only guard (the database AND the API) ──────────────────────
host_port() { # url → "host port" (port may be empty)
  local hp="${1#*://}"; hp="${hp#*@}"; hp="${hp%%/*}"; hp="${hp%%\?*}"
  case "$hp" in
    \[*\]*) local h="${hp%%]*}"; h="${h#[}"; local p="${hp##*]}"; echo "$h ${p#:}" ;;
    *:*)    echo "${hp%%:*} ${hp##*:}" ;;
    *)      echo "$hp " ;;
  esac
}
refuse_remote() { # label host
  case "$2" in
    127.0.0.1|localhost|::1) return 0 ;;
  esac
  echo "REFUSED — $1 names host '$2'. This gate creates users, re-creates the open"
  echo "pre-fix state and applies a migration; it runs against a loopback stack only"
  echo "(127.0.0.1, localhost, ::1)."
  echo "GATE-WORK $GATE units=0"
  exit 2
}
set -- $(host_port "$DB_URL");  DB_HOST="${1:-}";  DB_PORT="${2:-5432}"
set -- $(host_port "$API_URL"); API_HOST="${1:-}"; API_PORT="${2:-80}"
refuse_remote SUBS_LOCKDOWN_DB_URL "$DB_HOST"
refuse_remote SUBS_LOCKDOWN_API_URL "$API_HOST"
API_URL="${API_URL%/}"

# ── Is the local stack running? ──────────────────────────────────────────
vacuous() {
  echo "VACUOUS — $1"
  echo "The write lockdown was NOT exercised on this host. Start the local stack"
  echo "(supabase start) and run this gate again; this line is not a pass."
  echo "GATE-WORK $GATE units=0"
  exit 0
}
(exec 3<>"/dev/tcp/$DB_HOST/$DB_PORT") 2>/dev/null \
  || vacuous "nothing is listening on $DB_HOST:$DB_PORT (the local Supabase stack is not running)"
(exec 3<>"/dev/tcp/$API_HOST/$API_PORT") 2>/dev/null \
  || vacuous "nothing is listening on $API_HOST:$API_PORT (the local Supabase API is not running)"
command -v curl >/dev/null 2>&1    || vacuous "no curl on this host"
command -v openssl >/dev/null 2>&1 || vacuous "no openssl on this host (the service-role key is minted from the stack's own secret)"

# The connection: host psql when there is one, else psql inside the local
# stack's database container — and only when that container is the one that
# publishes the port the URL names (so a URL can never be swapped under it).
if command -v psql >/dev/null 2>&1; then
  run_psql() { psql "$DB_URL" -X -At -q -v ON_ERROR_STOP=1 "$@"; }
elif command -v docker >/dev/null 2>&1 \
     && { [ -n "$CONTAINER" ] || CONTAINER="$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep ":$DB_PORT->5432/tcp" | head -1 | cut -d' ' -f1)"; } \
     && [ -n "$CONTAINER" ] \
     && docker port "$CONTAINER" 5432/tcp 2>/dev/null | grep -q ":$DB_PORT\$"; then
  run_psql() { docker exec -i "$CONTAINER" psql -U postgres -d postgres -X -At -q -v ON_ERROR_STOP=1 "$@"; }
else
  vacuous "no psql on this host and no database container publishing port $DB_PORT"
fi

if [ ! -f "$MIGRATION" ]; then
  echo "FAIL the migration file exists — $MIGRATION not found"
  echo "GATE-WORK $GATE units=0"
  exit 1
fi

# ── Helpers ──────────────────────────────────────────────────────────────
UNITS=0
FAILS=0
SKIPS=0
W_FAILS=0
pass() { UNITS=$((UNITS + 1)); echo "PASS $1"; }
fail() { UNITS=$((UNITS + 1)); FAILS=$((FAILS + 1)); echo "FAIL $1"; shift; for l in "$@"; do echo "     | $l"; done; }
# A case that needs an object this database does not have. NOT a pass: it is
# printed, counted apart, and never adds to GATE-WORK.
skip() { SKIPS=$((SKIPS + 1)); echo "SKIP $1 — $2"; }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "got:  $2" "want: $3"; fi; }
check_has() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1" "got:  $2" "want it to contain: $3" ;; esac; }

sql() { run_psql 2>&1 <<SQL
$1
SQL
}

# THE LIST — read from the migration, the one place it is written.
tables_between() {
  sed -n "/$1-BEGIN/,/$1-END/p" "$MIGRATION" | sed -n "s/^[[:space:]]*'\([a-z_0-9]*\)'.*/\1/p"
}
USER_READABLE="$(tables_between ENTITLEMENT-TABLES-USER-READABLE | tr '\n' ' ')"
SERVICE_ONLY="$(tables_between ENTITLEMENT-TABLES-SERVICE-ONLY | tr '\n' ' ')"
ALL_TABLES="$USER_READABLE$SERVICE_ONLY"
case " $USER_READABLE" in
  *" subscriptions "*) ;;
  *) echo "FAIL the migration's list names subscriptions — read: '$ALL_TABLES'"
     echo "GATE-WORK $GATE units=0"; exit 1 ;;
esac
exists_table() { [ "$(sql "select to_regclass('public.$1') is not null;")" = "t" ]; }
is_user_readable() { case " $USER_READABLE" in *" $1 "*) return 0 ;; esac; return 1; }

# ── Keys: minted from the stack's own JWT secret, never typed, never printed ─
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
mint() { # role → an HS256 token the local PostgREST verifies
  local now exp hdr pl sig
  now="$(date +%s)"; exp=$((now + 3600))
  hdr="$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)"
  pl="$(printf '{"role":"%s","iss":"supabase-demo","iat":%s,"exp":%s}' "$1" "$now" "$exp" | b64url)"
  sig="$(printf '%s.%s' "$hdr" "$pl" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)"
  printf '%s.%s.%s' "$hdr" "$pl" "$sig"
}
JWT_SECRET="$(sql "select coalesce(current_setting('app.settings.jwt_secret', true), '');" | head -1)"
SERVICE_KEY="${SUBS_LOCKDOWN_SERVICE_ROLE_KEY:-}"
ANON_KEY="${SUBS_LOCKDOWN_ANON_KEY:-}"
if [ -z "$SERVICE_KEY" ] || [ -z "$ANON_KEY" ]; then
  [ -n "$JWT_SECRET" ] || vacuous "the stack does not expose app.settings.jwt_secret and no SUBS_LOCKDOWN_SERVICE_ROLE_KEY / SUBS_LOCKDOWN_ANON_KEY was given"
  SERVICE_KEY="$(mint service_role)"; ANON_KEY="$(mint anon)"
fi

# ── HTTP through the stack's own gateway (kong → PostgREST / GoTrue) ─────
BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/subs-lockdown.XXXXXX")"
HTTP_STATUS=""; HTTP_BODY=""
req() { # METHOD PATH BEARER [BODY] [PREFER]  → HTTP_STATUS, HTTP_BODY
  local prefer="${5:-return=representation}"
  if [ -n "${4:-}" ]; then
    HTTP_STATUS="$(curl -s -o "$BODY_FILE" -w '%{http_code}' -X "$1" "$API_URL$2" \
      -H "apikey: $ANON_KEY" -H "Authorization: Bearer $3" \
      -H "Content-Type: application/json" -H "Prefer: $prefer" -d "$4")"
  else
    HTTP_STATUS="$(curl -s -o "$BODY_FILE" -w '%{http_code}' -X "$1" "$API_URL$2" \
      -H "apikey: $ANON_KEY" -H "Authorization: Bearer $3" -H "Prefer: $prefer")"
  fi
  HTTP_BODY="$(head -c 600 "$BODY_FILE" | tr '\n' ' ')"
}
req GET "/rest/v1/subscriptions?select=user_id&limit=1" "$SERVICE_KEY"
[ "$HTTP_STATUS" = "200" ] \
  || vacuous "the service-role key is not accepted by the local PostgREST (HTTP $HTTP_STATUS) — pass SUBS_LOCKDOWN_SERVICE_ROLE_KEY and SUBS_LOCKDOWN_ANON_KEY"

# The GraphQL endpoint (pg_graphql behind /graphql/v1) is a second door onto
# the same privileges. Where the stack serves it, the attack is made through
# it too; where it does not, that row is a SKIP — never a pass.
GRAPHQL=0
req POST "/graphql/v1" "$ANON_KEY" '{"query":"{ __typename }"}'
case "$HTTP_STATUS $HTTP_BODY" in "200 "*'"Query"'*) GRAPHQL=1 ;; esac
graphql_body() { # user id → the mutation that writes that user's tier
  printf '{"query":"mutation { updatesubscriptionsCollection(set: {tier: \\"multi\\", status: \\"active\\"}, filter: {user_id: {eq: \\"%s\\"}}) { affectedCount } }"}' "$1"
}

rpc() { req POST "/rest/v1/rpc/$1" "$SERVICE_KEY" "$2"; }

RUN="$(date +%s)$$"
DOMAIN="subs-gate.invalid"
MONTH="$(date -u +%Y-%m)"
TODAY="$(date -u +%Y-%m-%d)"

apply_file() { # file → APPLY_OUT, returns psql's status (one transaction, like Studio)
  APPLY_OUT="$(run_psql --single-transaction -f - < "$1" 2>&1)"
}

FIXTURE_VIEW="subs_gate_cohort_public"
apply_batch() { # file → APPLY_OUT; the WHOLE file as ONE multi-statement query — one
  # implicit transaction, the way Studio's editor and the Management API send it
  APPLY_OUT="$(run_psql -c "$(cat "$1")" 2>&1)"
}
read_only() { # file → its output, run inside a READ ONLY transaction: a write would error
  { echo "begin transaction read only;"; cat "$1"; echo; echo "rollback;"; } | run_psql -f - 2>&1
}
in_rolled_back_txn() { # SQL text → its output. Everything it does is rolled back: an
  # error ends the session (ON_ERROR_STOP), which rolls back too. Nothing here persists.
  { echo "begin;"; printf '%s\n' "$1"; echo "rollback;"; } | run_psql -f - 2>&1
}
json_field() { # json text, key → a boolean or string value, as jsonb prints it
  printf '%s' "$1" | grep -o "\"$2\": \(true\|false\|\"[^\"]*\"\)" | head -1 | sed 's/^"[^"]*": //; s/"//g'
}
verdict_of() { # → what …_preflight_report.sql says of this database, read-only
  local out; out="$(read_only "$PREFLIGHT_REPORT")"
  case "$out" in *ERROR*) echo "ERROR $(printf '%s' "$out" | grep ERROR | head -1)"; return ;; esac
  echo "$(json_field "$out" state) hole_open=$(json_field "$out" hole_open) stopgap_in_place=$(json_field "$out" stopgap_in_place) fully_locked=$(json_field "$out" fully_locked)"
}
remedies_of() { # an INCOMPLETE error → the statements its lines end with
  printf '%s\n' "$1" | sed -n 's/.*Run: //p' | sed 's/  (or end the membership.*//'
}

cleanup() {
  run_psql >/dev/null 2>&1 <<SQL
drop view if exists public.$FIXTURE_VIEW;
do \$\$
declare
  v_users uuid[] := array(select id from auth.users where email like '%@$DOMAIN');
  v_orgs  uuid[] := array(select org_id from public.memberships where user_id = any(v_users));
begin
  if to_regclass('public.plan_assignment_audit') is not null then
    execute 'delete from public.plan_assignment_audit where user_id = any(\$1)' using v_users;
  end if;
  if to_regclass('public.document_quota_ledger') is not null then
    delete from public.document_quota_ledger where user_id = any(v_users);
  end if;
  delete from public.founding_members where user_id = any(v_users) or stripe_subscription_id like 'sub_subsgate%';
  delete from public.billing_events where stripe_event_id like 'evt_subsgate%';
  delete from public.memberships where user_id = any(v_users);
  delete from public.organizations where id = any(v_orgs);
  if to_regclass('public.plan_chat_daily_usage') is not null then
    delete from public.plan_chat_daily_usage where user_id = any(v_users);
  end if;
  delete from public.user_usage where user_id = any(v_users);
  delete from public.subscriptions where user_id = any(v_users);
  delete from auth.users where id = any(v_users);
end
\$\$;
SQL
}
on_exit() {
  cleanup
  # Never leave an open state behind, however the run ended — and whatever
  # file it was pointed at: the REPOSITORY's migration closes the stack, so a
  # plant run leaves no plant.
  if [ "$MODE" != observe ]; then
    local f="$REPO_MIGRATION"; [ -f "$f" ] || f="$MIGRATION"
    run_psql --single-transaction -f - < "$f" >/dev/null 2>&1
  fi
  rm -f "$BODY_FILE"
}
trap on_exit EXIT
cleanup   # a previous run that died mid-way

# ── The users ────────────────────────────────────────────────────────────
# The ATTACKER signs up through GoTrue and carries the access token GoTrue
# issued — the session a browser holds. The victim is created directly (it
# never signs in); both get their rows from the signup trigger.
ATK_EMAIL="attacker-$RUN@$DOMAIN"
req POST "/auth/v1/signup" "$ANON_KEY" "{\"email\":\"$ATK_EMAIL\",\"password\":\"gate-$RUN-password\"}"
ATK_TOKEN="$(sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p' "$BODY_FILE" | head -1)"
A="$(sql "select id from auth.users where email = '$ATK_EMAIL';" | head -1)"
V="$(sql "insert into auth.users (id, email, raw_user_meta_data, aud, role)
          values (gen_random_uuid(), 'victim-$RUN@$DOMAIN', '{\"full_name\":\"victim gate\"}', 'authenticated', 'authenticated')
          returning id;" | tail -1)"
case "$ATK_TOKEN$A$V" in
  *ERROR*|"") fail "setup: an invented user signs up through GoTrue and receives a session" "HTTP $HTTP_STATUS $HTTP_BODY" "attacker=$A victim=$V"
              echo "GATE-WORK $GATE units=$UNITS"; exit 1 ;;
esac
[ -n "$ATK_TOKEN" ] || { fail "setup: GoTrue issued an access token at signup" "HTTP $HTTP_STATUS $HTTP_BODY"; echo "GATE-WORK $GATE units=$UNITS"; exit 1; }

OWN="/rest/v1/subscriptions?user_id=eq.$A"
VIC="/rest/v1/subscriptions?user_id=eq.$V"

# Both users get a row in each meter, written the way the engine writes them
# (the reserve / commit RPCs, service role): a user must read their own and
# never the other's.
if [ "$MODE" != observe ]; then
  for u in "$A" "$V"; do
    rpc reserve_user_upload "{\"p_user_id\":\"$u\",\"p_month\":\"$MONTH\",\"p_base_cap\":50,\"p_allow_extra\":false}"
    rpc commit_user_upload "{\"p_user_id\":\"$u\",\"p_month\":\"$MONTH\",\"p_was_extra\":false}"
    rpc reserve_user_chat "{\"p_user_id\":\"$u\",\"p_month\":\"$MONTH\",\"p_day\":\"$TODAY\",\"p_daily_cap\":500,\"p_monthly_cap\":5000}"
    rpc commit_user_chat "{\"p_user_id\":\"$u\",\"p_month\":\"$MONTH\",\"p_day\":\"$TODAY\"}"
  done
fi

# A PUBLIC AGGREGATE VIEW over a listed table — the shape of production's
# `founder_cohort_public`, which the pricing page reads with the anon key and
# which NO FILE IN THIS REPOSITORY CREATES. A plain view runs with its owner's
# rights: the lockdown must leave its anon read working (P6), and it is not a
# way to write (L4). Created by the gate, removed by cleanup; never in
# --observe, which applies nothing.
if [ "$MODE" != observe ]; then
  sql "create or replace view public.$FIXTURE_VIEW as
         select count(*)::int as seats_claimed from public.founding_members;
       revoke all on public.$FIXTURE_VIEW from public, anon, authenticated;
       grant select on public.$FIXTURE_VIEW to anon, authenticated;
       notify pgrst, 'reload schema';" >/dev/null
  for _try in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do   # PostgREST learns of a new relation on reload
    req GET "/rest/v1/$FIXTURE_VIEW?select=seats_claimed" "$SERVICE_KEY"
    [ "$HTTP_STATUS" = "200" ] && break
    sleep 0.5
  done
fi

# The row, read back as the database owner. `fp` is its whole content
# (updated_at included: a write that changed nothing visible still moves it).
fp()   { local r; r="$(sql "select md5(row_to_json(s)::text) from public.subscriptions s where s.user_id = '$1';" | head -1)"; echo "${r:-(no row)}"; }
show() { local r; r="$(sql "select coalesce(tier, '∅') || ' / ' || plan || ' / ' || status
                    || ' / founding=' || is_founding_member || ' / limits=' || coalesce(custom_limits::text, '∅')
                    || ' / cus=' || coalesce(stripe_customer_id, '∅')
                    from public.subscriptions where user_id = '$1';" | head -1)"; echo "${r:-(no row)}"; }
tfp()  { # table → every row of the table, as one fingerprint
  sql "select count(*) || ':' || coalesce(md5(string_agg(row_to_json(t)::text, '' order by row_to_json(t)::text)), '-') from public.$1 t;" | head -1
}
baseline() { # the two rows as a signup leaves them (service role; the trigger sets updated_at)
  sql "update public.subscriptions
          set tier = null, plan = 'professional', status = 'trial', is_founding_member = false,
              custom_limits = null, cancel_at_period_end = false, billing_cycle = 'monthly',
              stripe_customer_id = null, stripe_subscription_id = null,
              intro_unlock_expiry = null, extra_docs_billed_period = 0,
              current_period_end = created_at + interval '14 days', trial_end = created_at + interval '14 days'
        where user_id in ('$A', '$V');" >/dev/null
}

# THE ATTACK LIST — "label|METHOD|path|who|body|whose row". who: user = the
# attacker's GoTrue session, anon = the anon key. One list, used by --observe
# (the table) and by the gate (every line must be refused).
attacks() {
  local t
  for t in solo pro multi intro starter pro_legacy business professional enterprise owner; do
    echo "PATCH own tier → $t, status → active|PATCH|$OWN|user|{\"tier\":\"$t\",\"status\":\"active\"}|$A"
  done
  cat <<LIST
PATCH own status → active|PATCH|$OWN|user|{"status":"active"}|$A
PATCH own plan → enterprise|PATCH|$OWN|user|{"plan":"enterprise"}|$A
PATCH own custom_limits|PATCH|$OWN|user|{"custom_limits":{"docs":100000,"workspaces":100000}}|$A
PATCH own is_founding_member → true|PATCH|$OWN|user|{"is_founding_member":true}|$A
PATCH own current_period_end → 2099|PATCH|$OWN|user|{"current_period_end":"2099-01-01T00:00:00Z"}|$A
PATCH own trial_end → 2099|PATCH|$OWN|user|{"trial_end":"2099-01-01T00:00:00Z"}|$A
PATCH own intro_unlock_expiry → 2099|PATCH|$OWN|user|{"intro_unlock_expiry":"2099-01-01T00:00:00Z"}|$A
PATCH own extra_docs_billed_period → 0 (the billed-extras tally)|PATCH|$OWN|user|{"extra_docs_billed_period":0}|$A
PATCH own stripe_customer_id (what /api/billing/portal hands to Stripe)|PATCH|$OWN|user|{"stripe_customer_id":"cus_subsgate$RUN"}|$A
PATCH own stripe_subscription_id (what /api/billing/cancel hands to Stripe)|PATCH|$OWN|user|{"stripe_subscription_id":"sub_subsgate$RUN"}|$A
PATCH own billing_cycle → yearly|PATCH|$OWN|user|{"billing_cycle":"yearly"}|$A
PATCH own cancel_at_period_end (the browser's old cancel())|PATCH|$OWN|user|{"cancel_at_period_end":true}|$A
PATCH own cancel_at_period_end + status → active (the browser's old reactivate())|PATCH|$OWN|user|{"cancel_at_period_end":false,"status":"active"}|$A
PATCH every row the session can see (no user filter)|PATCH|/rest/v1/subscriptions?user_id=not.is.null|user|{"tier":"multi","status":"active"}|$A
UPSERT own row (POST on_conflict=user_id, merge)|UPSERT|/rest/v1/subscriptions?on_conflict=user_id|user|{"user_id":"$A","tier":"multi","status":"active"}|$A
DELETE own row|DELETE|$OWN|user||$A
PATCH ANOTHER user's tier → multi|PATCH|$VIC|user|{"tier":"multi","status":"active"}|$V
DELETE ANOTHER user's row|DELETE|$VIC|user||$V
INSERT a second row for ANOTHER user's id|POST|/rest/v1/subscriptions|user|{"user_id":"$V","tier":"multi","status":"active"}|$V
ANON: PATCH a user's tier → multi|PATCH|$VIC|anon|{"tier":"multi","status":"active"}|$V
ANON: DELETE a user's row|DELETE|$VIC|anon||$V
ANON: INSERT a row|POST|/rest/v1/subscriptions|anon|{"user_id":"$V","tier":"multi","status":"active"}|$V
GraphQL (/graphql/v1): mutation updatesubscriptionsCollection, own tier → multi, status → active|POST|/graphql/v1|user|$(graphql_body "$A")|$A
LIST
}
# ONE WRITE PER COLUMN of public.subscriptions, generated from the catalog at
# run time: a column added tomorrow is attacked the day it exists. The value
# is one the column's type and CHECKs admit, so that in the open state the
# write LANDS (a refused attack must be refused by the lockdown, not by a
# constraint).
GATE_UUID="$(sql "select gen_random_uuid();" | head -1)"
column_attacks() {
  sql "select a.attname || '|' || format_type(a.atttypid, a.atttypmod)
         from pg_attribute a
        where a.attrelid = 'public.subscriptions'::regclass and a.attnum > 0 and not a.attisdropped
        order by a.attnum;" |
  while IFS='|' read -r col typ; do
    case "$col" in
      tier) v='"multi"' ;;
      status) v='"active"' ;;
      plan) v='"enterprise"' ;;
      billing_cycle) v='"yearly"' ;;
      stripe_customer_id) v="\"cus_subsgate$RUN\"" ;;
      stripe_subscription_id) v="\"sub_subsgate$RUN\"" ;;
      *) case "$typ" in
           boolean) v='true' ;;
           integer|bigint|smallint|numeric*|real|"double precision") v='0' ;;
           "timestamp with time zone"|"timestamp without time zone") v='"2099-01-01T00:00:00Z"' ;;
           date) v='"2099-01-01"' ;;
           jsonb|json) v='{"docs":100000,"workspaces":100000}' ;;
           uuid) v="\"$GATE_UUID\"" ;;
           *) v='"subsgate"' ;;
         esac ;;
    esac
    echo "COLUMN $col ($typ): PATCH own row|PATCH|$OWN|user|{\"$col\":$v}|$A"
  done
}
NCOLS="$(column_attacks | grep -c '^COLUMN ')"
NNAMED=$(( $(attacks | grep -c '|') + 2 ))
fire() { # METHOD path who body → HTTP_STATUS, HTTP_BODY
  local tok="$ATK_TOKEN"; [ "$3" = "anon" ] && tok="$ANON_KEY"
  if [ "$1" = "UPSERT" ]; then req POST "$2" "$tok" "$4" "return=representation,resolution=merge-duplicates"
  else req "$1" "$2" "$tok" "$4"; fi
}
# The INSERT of a row by a user who has NONE: the attacker's own row is taken
# away (service role), the insert is attempted, the row is put back.
NOROW_SOLD="INSERT the row when the user has none: tier → multi, plan → enterprise, 2099"
NOROW_OWNER="INSERT the row when the user has none: tier → owner"
norow_body() { # tier
  echo "{\"user_id\":\"$A\",\"tier\":\"$1\",\"status\":\"active\",\"plan\":\"enterprise\",\"current_period_end\":\"2099-01-01T00:00:00Z\"}"
}
take_row()   { sql "delete from public.subscriptions where user_id = '$A';" >/dev/null; }
return_row() {
  sql "delete from public.subscriptions where user_id = '$A';
       insert into public.subscriptions (user_id, plan, billing_cycle, status, trial_start, trial_end, current_period_start, current_period_end)
       values ('$A', 'professional', 'monthly', 'trial', now(), now() + interval '14 days', now(), now() + interval '14 days');" >/dev/null
}

# The sibling tables' attacks. The two meters get the real attack (zero your
# own counter) on a row the service role's RPCs wrote; every listed table
# gets the three verbs. `seed_meters` runs the REAL reserve / commit RPCs
# through PostgREST as the service role — the path the engine takes.
first_col() { sql "select attname from pg_attribute where attrelid = 'public.$1'::regclass and attnum = 1;" | head -1; }

# ── The four starting states ─────────────────────────────────────────────
# (a) the catalog of a database built from this repository BEFORE the fix —
#     measured on a fresh stack: the three policies of the old schema.sql,
#     Supabase's default grants on the three user-readable tables, and the two
#     meters' own-row SELECT policies as schema_phase5_usage_limits.sql and
#     schema_phase_pricing_v2.sql created them before 2026-10-03 — with no
#     `to authenticated`, which Postgres records as roles {public}.
state_a() {
  sql "set client_min_messages = warning;
       drop policy if exists \"subscriptions self select\" on public.subscriptions;
       drop policy if exists \"subscriptions self insert\" on public.subscriptions;
       drop policy if exists \"subscriptions self update\" on public.subscriptions;
       create policy \"subscriptions self select\" on public.subscriptions for select using (auth.uid() = user_id);
       create policy \"subscriptions self insert\" on public.subscriptions for insert with check (auth.uid() = user_id);
       create policy \"subscriptions self update\" on public.subscriptions for update using (auth.uid() = user_id);
       drop policy if exists \"users_see_own_usage\" on public.user_usage;
       create policy \"users_see_own_usage\" on public.user_usage for select using (auth.uid() = user_id);
       drop policy if exists \"plan_chat_daily_usage_own_select\" on public.plan_chat_daily_usage;
       create policy \"plan_chat_daily_usage_own_select\" on public.plan_chat_daily_usage for select using (user_id = auth.uid());
       grant all on public.subscriptions, public.user_usage, public.plan_chat_daily_usage to anon, authenticated;
       notify pgrst, 'reload schema';"
}
# (b) the stopgap, verbatim (owner, 2026-10-03).
state_b() {
  sql "set client_min_messages = warning;
       drop policy if exists \"subscriptions self insert\" on public.subscriptions;
       drop policy if exists \"subscriptions self update\" on public.subscriptions;
       revoke insert, update, delete, truncate, references, trigger on public.subscriptions from anon, authenticated;
       notify pgrst, 'reload schema';"
}
# (d) a LOCKED database somebody re-opened by hand, under names the migration
#     has never heard of. Built on top of the migration's own result.
state_d() {
  sql "set client_min_messages = warning;
       drop policy if exists \"billing can write\" on public.subscriptions;
       drop policy if exists \"everyone reads plans\" on public.subscriptions;
       drop policy if exists \"users write own usage\" on public.user_usage;
       drop policy if exists \"everyone reads usage\" on public.user_usage;
       create policy \"everyone reads usage\" on public.user_usage for select using (true);
       create policy \"billing can write\" on public.subscriptions for all to authenticated using (true) with check (true);
       create policy \"everyone reads plans\" on public.subscriptions for select using (true);
       create policy \"users write own usage\" on public.user_usage for update using (auth.uid() = user_id);
       grant update (tier, status) on public.subscriptions to authenticated;
       grant update on public.user_usage to authenticated;
       alter table public.plan_chat_daily_usage disable row level security;
       grant insert, update, delete on public.plan_chat_daily_usage to authenticated;
       grant all on public.founding_members to anon;
       notify pgrst, 'reload schema';"
}
state_title() {
  case "$1" in
    a) echo "a database built from this repository before the fix" ;;
    b) echo "the hand-applied three-statement stopgap" ;;
    c) echo "the migration already applied" ;;
    d) echo "locked, then re-opened by hand under other names" ;;
  esac
}
build_state() { # a|b|c|d — quietly; every state starts from (a)
  state_a >/dev/null
  case "$1" in
    b) state_b >/dev/null ;;
    c) apply_file "$MIGRATION" ;;
    d) apply_file "$MIGRATION"; state_d >/dev/null ;;
  esac
}
# What a role holds on subscriptions, as the ACL has it (MAINTAIN shows on
# Postgres 17 and later).
acl_of() {
  sql "select coalesce(string_agg(a.privilege_type, ',' order by a.privilege_type), '(none)')
         from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
        where c.oid = 'public.subscriptions'::regclass
          and a.grantee = (select oid from pg_roles where rolname = '$1');" | head -1
}
# Views that read a listed table — DIRECTLY OR THROUGH ANOTHER VIEW — and on
# which an API role holds a privilege: name, depth, security_invoker, whether
# the view can be written through, the privileges.
api_views() {
  sql "with recursive listed as (
         select c.oid from pg_class c
          where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
            and c.relname = any (string_to_array('$(echo $ALL_TABLES)', ' '))
       ), walk (view_oid, depth) as (
         select w.ev_class, 1
           from pg_rewrite w
           join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = w.oid and d.refclassid = 'pg_class'::regclass
           join listed t on t.oid = d.refobjid
          where w.ev_class <> d.refobjid
         union
         select w.ev_class, walk.depth + 1
           from walk
           join pg_depend d on d.refclassid = 'pg_class'::regclass and d.refobjid = walk.view_oid and d.classid = 'pg_rewrite'::regclass
           join pg_rewrite w on w.oid = d.objid
          where w.ev_class <> walk.view_oid and walk.depth < 10
       )
       select coalesce(string_agg(x, ' ; ' order by x), '(none)') from (
         select v.relname || ' depth=' || min(walk.depth)
                || ' invoker=' || coalesce((select option_value from pg_options_to_table(v.reloptions) where option_name = 'security_invoker'), 'false')
                || ' updatable=' || ((pg_relation_is_updatable(v.oid, false) & 28) <> 0)
                || ' ' || (select string_agg(r || ':' || p, ',' order by r, p)
                             from unnest(array['anon', 'authenticated']) r, unnest(array['DELETE', 'INSERT', 'SELECT', 'UPDATE']) p
                            where has_table_privilege(r, v.oid, p)) as x
           from walk
           join pg_class v on v.oid = walk.view_oid and v.relkind in ('v', 'm')
          where exists (select 1 from unnest(array['anon', 'authenticated']) r, unnest(array['DELETE', 'INSERT', 'SELECT', 'UPDATE']) p
                         where has_table_privilege(r, v.oid, p))
          group by v.oid, v.relname, v.reloptions) q;" | head -1
}
# Any view in public, WHATEVER IT READS, on which an API role holds a write
# privilege (a new public view gets ALL by default): the door a name scan of
# function bodies or a dependency walk can miss.
writable_public_views() {
  sql "select coalesce(string_agg(v.relname || ' ' || (select string_agg(r || ':' || p, ',' order by r, p)
                                    from unnest(array['anon', 'authenticated']) r, unnest(array['DELETE', 'INSERT', 'UPDATE']) p
                                   where has_table_privilege(r, v.oid, p)), ' ; ' order by v.relname), '(none)')
         from pg_class v
        where v.relnamespace = 'public'::regnamespace and v.relkind in ('v', 'm')
          and exists (select 1 from unnest(array['anon', 'authenticated']) r, unnest(array['DELETE', 'INSERT', 'UPDATE']) p
                       where has_table_privilege(r, v.oid, p));" | head -1
}
# THE FENCE (owner, 2026-10-03: "migrations that only remove or restrict
# access … may not delete or alter customer rows"). Every row of every listed
# table that exists, as one line: "table=<rows>:<md5 of every row, whole>".
rows_of_listed() {
  local t out=""
  for t in $ALL_TABLES; do
    if exists_table "$t"; then out="$out$t=$(tfp "$t") "; fi
  done
  echo "$out"
}
# The same question, asked of the instrument an operator has in production:
# …_audit_report.sql's `row_fingerprints`, read inside a READ ONLY transaction.
audit_rows_of_listed() {
  local out t r; out="$(read_only "$AUDIT_REPORT")"; r=""
  case "$out" in *ERROR*) echo "ERROR $(printf '%s' "$out" | grep ERROR | head -1)"; return ;; esac
  for t in $ALL_TABLES; do
    r="$r$t=$(printf '%s' "$out" | grep -o "\"$t\": \"[^\"]*\"" | head -1 | sed 's/^"[^"]*": "//; s/"$//') "
  done
  echo "$r"
}
# What the audit's fingerprint must be, computed here on its own: the number of
# rows, and one md5 over the md5 of every row's whole content.
expected_rows_of_listed() {
  local t r=""
  for t in $ALL_TABLES; do
    if exists_table "$t"; then
      r="$r$t=$(sql "select count(*) || ':' || coalesce(md5(string_agg(md5(row_to_json(t)::text), '' order by md5(row_to_json(t)::text))), '-') from public.$t t;" | head -1) "
    else r="$r$t=absent "; fi
  done
  echo "$r"
}
migrate() { # label — its first word is the case id; the fence case is that id + "f"
  local rows_before; rows_before="$(rows_of_listed)"
  apply_file "$MIGRATION"; local rc=$?
  if [ $rc -eq 0 ]; then
    case "$APPLY_OUT" in
      *ERROR*|*WARNING*) fail "$1" "$(echo "$APPLY_OUT" | grep -E 'ERROR|WARNING' | head -3)" ;;
      *) pass "$1" ;;
    esac
  else fail "$1" "$(echo "$APPLY_OUT" | grep -v '^$' | tail -4)"; fi
  check "${1%% *}f … and it changed NO ROW: every listed table holds the same rows, byte for byte, before and after it (the fence — a migration that only restricts access)" \
    "$(rows_of_listed)" "$rows_before"
}


# ══ The table modes: --observe (nothing applied), --before / --after <state> ══
if [ "$MODE" != gate ]; then
  owner_plan="not applied"; [ "$(sql "select to_regproc('public.assign_internal_plan') is not null;")" = "t" ] && owner_plan="applied"
  case "$MODE" in
    observe)
      echo "OBSERVE — nothing is applied and nothing is asserted. schema_phase_owner_plan.sql: $owner_plan." ;;
    *)
      build_state "$STATE"
      if [ "$MODE" = after ]; then
        apply_file "$MIGRATION" || { echo "THE MIGRATION DID NOT APPLY:"; echo "$APPLY_OUT" | grep -v '^$' | tail -4; }
      fi
      sql "notify pgrst, 'reload schema';" >/dev/null
      echo "$(echo "$MODE" | tr 'a-z' 'A-Z') THE MIGRATION — starting state ($STATE): $(state_title "$STATE"). schema_phase_owner_plan.sql: $owner_plan."
      echo "Nothing is asserted. The repository's migration is re-applied on exit." ;;
  esac
  echo "policies on subscriptions: $(sql "select coalesce(string_agg(policyname || ' [' || cmd || ']', ', ' order by policyname), '(none)') from pg_policies where schemaname = 'public' and tablename = 'subscriptions';")"
  echo "authenticated on subscriptions: $(acl_of authenticated)"
  echo "anon on subscriptions: $(acl_of anon)"
  echo "views over a listed table an API role may use: $(api_views)"
  echo "the pre-flight report says: $(verdict_of)"
  echo
  echo "| attack (through PostgREST) | HTTP | the row, read back with the service role: tier / plan / status / … | written? | body |"
  echo "|---|---|---|---|---|"
  attacks | while IFS='|' read -r label method path who body uid; do
    baseline; before="$(fp "$uid")"
    fire "$method" "$path" "$who" "$body"
    after="$(fp "$uid")"; w="no"; [ "$before" = "$after" ] || w="YES"
    echo "| $label | $HTTP_STATUS | $(show "$uid") | $w | $(printf '%s' "$HTTP_BODY" | cut -c1-96) |"
  done
  for pair in "$NOROW_SOLD|multi" "$NOROW_OWNER|owner"; do
    take_row; fire POST "/rest/v1/subscriptions" user "$(norow_body "${pair##*|}")"
    w="no"; [ "$(fp "$A")" = "(no row)" ] || w="YES"
    echo "| ${pair%%|*} | $HTTP_STATUS | $(show "$A") | $w | $(printf '%s' "$HTTP_BODY" | cut -c1-96) |"
    return_row
  done
  baseline
  echo
  echo "| read | HTTP | body |"
  echo "|---|---|---|"
  req GET "/rest/v1/subscriptions?select=user_id,tier,status" "$ATK_TOKEN";  echo "| signed-in user: every row the session can see | $HTTP_STATUS | $(printf '%s' "$HTTP_BODY" | sed "s/$A/<own id>/g" | cut -c1-110) |"
  req GET "$VIC&select=user_id" "$ATK_TOKEN";                                 echo "| signed-in user: ANOTHER user's row | $HTTP_STATUS | $(printf '%s' "$HTTP_BODY" | cut -c1-110) |"
  req GET "/rest/v1/subscriptions?select=user_id" "$ANON_KEY";                echo "| anon: every row | $HTTP_STATUS | $(printf '%s' "$HTTP_BODY" | cut -c1-110) |"
  echo
  echo "| the consequence, through the real seam | answer |"
  echo "|---|---|"
  req POST "/rest/v1/rpc/create_workspace" "$ATK_TOKEN" '{"p_name":"Subs gate company 2"}'
  echo "| create_workspace #2 on the signup row | $HTTP_STATUS $(printf '%s' "$HTTP_BODY" | cut -c1-120) |"
  fire PATCH "$OWN" user '{"tier":"multi","status":"active"}'
  echo "| the user PATCHes tier → multi | $HTTP_STATUS |"
  for n in 2 3; do
    req POST "/rest/v1/rpc/create_workspace" "$ATK_TOKEN" "{\"p_name\":\"Subs gate company $n\"}"
    echo "| create_workspace #$n after the PATCH | $HTTP_STATUS $(printf '%s' "$HTTP_BODY" | sed 's/"[0-9a-f-]\{36\}"/"<new workspace id>"/' | cut -c1-120) |"
  done
  echo "| live workspaces of the user | $(sql "select count(*) from memberships m join organizations o on o.id = m.org_id where m.user_id = '$A' and o.archived_at is null;") |"
  echo
  echo "| sibling table (signed-in user) | SELECT | INSERT | PATCH | DELETE |"
  echo "|---|---|---|---|---|"
  rpc reserve_user_upload "{\"p_user_id\":\"$A\",\"p_month\":\"$MONTH\",\"p_base_cap\":5,\"p_allow_extra\":false}"
  rpc commit_user_upload "{\"p_user_id\":\"$A\",\"p_month\":\"$MONTH\",\"p_was_extra\":false}"
  rpc reserve_user_chat "{\"p_user_id\":\"$A\",\"p_month\":\"$MONTH\",\"p_day\":\"$TODAY\",\"p_daily_cap\":5,\"p_monthly_cap\":50}"
  rpc commit_user_chat "{\"p_user_id\":\"$A\",\"p_month\":\"$MONTH\",\"p_day\":\"$TODAY\"}"
  for t in $ALL_TABLES; do
    [ "$t" = "subscriptions" ] && continue
    if ! exists_table "$t"; then echo "| $t | (the table does not exist here) | | | |"; continue; fi
    c="$(first_col "$t")"
    req GET "/rest/v1/$t?select=$c&limit=5" "$ATK_TOKEN"; s1="$HTTP_STATUS"
    req POST "/rest/v1/$t" "$ATK_TOKEN" "{}"; s2="$HTTP_STATUS"
    req PATCH "/rest/v1/$t?$c=is.null" "$ATK_TOKEN" "{\"$c\":null}"; s3="$HTTP_STATUS"
    req DELETE "/rest/v1/$t?$c=is.null" "$ATK_TOKEN"; s4="$HTTP_STATUS"
    echo "| $t | $s1 | $s2 | $s3 | $s4 |"
  done
  echo
  echo "| the meters, the real attack (signed-in user, own counters) | HTTP | the table |"
  echo "|---|---|---|"
  before="$(tfp user_usage)"
  req PATCH "/rest/v1/user_usage?user_id=eq.$A" "$ATK_TOKEN" '{"uploads":0,"uploads_reserved":0,"llm_calls":0}'
  echo "| PATCH own user_usage: uploads, uploads_reserved, llm_calls → 0 | $HTTP_STATUS $(printf '%s' "$HTTP_BODY" | cut -c1-70) | $( [ "$before" = "$(tfp user_usage)" ] && echo unchanged || echo CHANGED ) |"
  before="$(tfp user_usage)"
  req DELETE "/rest/v1/user_usage?user_id=eq.$A" "$ATK_TOKEN"
  echo "| DELETE own user_usage row | $HTTP_STATUS $(printf '%s' "$HTTP_BODY" | cut -c1-70) | $( [ "$before" = "$(tfp user_usage)" ] && echo unchanged || echo CHANGED ) |"
  before="$(tfp plan_chat_daily_usage)"
  req PATCH "/rest/v1/plan_chat_daily_usage?user_id=eq.$A" "$ATK_TOKEN" '{"count":0}'
  echo "| PATCH own plan_chat_daily_usage: count → 0 | $HTTP_STATUS $(printf '%s' "$HTTP_BODY" | cut -c1-70) | $( [ "$before" = "$(tfp plan_chat_daily_usage)" ] && echo unchanged || echo CHANGED ) |"
  req GET "/rest/v1/user_usage?select=uploads&user_id=eq.$A" "$ATK_TOKEN"
  echo "| GET own user_usage (the read the product keeps) | $HTTP_STATUS $(printf '%s' "$HTTP_BODY" | cut -c1-70) | |"
  req GET "/rest/v1/user_usage?select=user_id" "$ANON_KEY"
  echo "| ANON: GET user_usage | $HTTP_STATUS $(printf '%s' "$HTTP_BODY" | cut -c1-70) | |"
  echo
  echo "GATE-WORK $GATE units=0"
  exit 0
fi

# ══ The catalog law, one line per listed table ═══════════════════════════
# rls · policies that are not SELECT · what anon holds · what authenticated
# holds (table OR column level; MAINTAIN too on Postgres 17 and later, where
# the default grant carries it) · what PUBLIC holds.
catalog_of() {
  sql "select 'rls=' || c.relrowsecurity
          || ' non-select-policies=' || (select count(*) from pg_policies p
                                          where p.schemaname = 'public' and p.tablename = c.relname and p.cmd <> 'SELECT')
          || ' anon=' || coalesce((select string_agg(x, ',' order by x) from unnest(array['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'] || case when current_setting('server_version_num')::int >= 170000 then array['MAINTAIN'] else array[]::text[] end) x
                                    where case when x in ('INSERT','UPDATE','REFERENCES','SELECT') then has_any_column_privilege('anon', c.oid, x)
                                               else has_table_privilege('anon', c.oid, x) end), '-')
          || ' authenticated=' || coalesce((select string_agg(x, ',' order by x) from unnest(array['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'] || case when current_setting('server_version_num')::int >= 170000 then array['MAINTAIN'] else array[]::text[] end) x
                                    where case when x in ('INSERT','UPDATE','REFERENCES','SELECT') then has_any_column_privilege('authenticated', c.oid, x)
                                               else has_table_privilege('authenticated', c.oid, x) end), '-')
          || ' public=' || coalesce((select string_agg(a.privilege_type, ',' order by a.privilege_type)
                                       from aclexplode(c.relacl) a where a.grantee = 0), '-')
       from pg_class c where c.oid = 'public.$1'::regclass;" | head -1
}
ONE_POLICY="subscriptions self select|SELECT|{authenticated}|(auth.uid() = user_id)|"
kept_policy_roles() { # the three policies the lockdown keeps → "table:{roles} …"
  sql "select coalesce(string_agg(tablename || ':' || roles::text, ' ' order by tablename), '(none)')
         from pg_policies
        where schemaname = 'public'
          and (tablename, policyname) in (('subscriptions', 'subscriptions self select'),
                                          ('user_usage', 'users_see_own_usage'),
                                          ('plan_chat_daily_usage', 'plan_chat_daily_usage_own_select'));" | head -1
}
# What an API role holds under Supabase's DEFAULT grant, and what the stopgap
# leaves of it on subscriptions — MAINTAIN exists from Postgres 17.
if [ "$(sql "select current_setting('server_version_num')::int >= 170000;" | head -1)" = "t" ]; then
  DEFAULT_ALL="DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE"; STOPGAP_LEFT="MAINTAIN,SELECT"
else
  DEFAULT_ALL="DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE"; STOPGAP_LEFT="SELECT"
fi
policies_of() { # table → every policy on it
  sql "select coalesce(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ' ; ' order by policyname), '(none)')
         from pg_policies where schemaname = 'public' and tablename = '$1';" | head -1
}
# THE CENSUS. A SECURITY DEFINER function writes past every revoke — and a
# trigger function needs no EXECUTE privilege at all (a definer trigger on a
# browser-written table that sets a tier stayed green under the first version
# of this gate). So: every SECURITY DEFINER function in public whose body
# names a listed table is on THIS list, whoever may execute it; a new one
# reds until someone has read it and added its name here.
DEFINER_ALLOWED="_purge_org_content claim_founding_seat commit_user_chat commit_user_nonro_upload commit_user_upload create_workspace delete_my_account handle_new_user handle_new_user_v2 increment_plan_chat_daily increment_user_usage release_user_chat release_user_nonro_upload release_user_upload reserve_user_chat reserve_user_nonro_upload reserve_user_upload reserve_user_upload_extra"
# … and, where schema_phase_owner_plan.sql is applied, its four.
DEFINER_ALLOWED_OWNER_PLAN="assign_internal_plan revoke_internal_plan subscriptions_audit_internal_tier_delete user_plan_is_unlimited"
definer_allowed() {
  local l="$DEFINER_ALLOWED"
  [ "$(sql "select to_regproc('public.assign_internal_plan') is not null;")" = "t" ] && l="$l $DEFINER_ALLOWED_OWNER_PLAN"
  echo $l | tr ' ' '\n' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//'
}
definer_census() {
  local rx; rx="$(echo $ALL_TABLES | tr ' ' '|')"
  sql "select coalesce(string_agg(n, ' ' order by n collate \"C\"), '(none)')
         from (select distinct p.proname::text as n
                 from pg_proc p
                where p.pronamespace = 'public'::regnamespace and p.prosecdef
                  and p.prosrc ~* ('\\m($rx)\\M')) q;" | head -1
}
# Every trigger on a table an API role can write runs one of THESE functions,
# and none of them SECURITY DEFINER (an invoker trigger writes as the user,
# and is refused where the user is). The list is of functions, not of
# triggers: a new table's updated_at trigger is not a new door.
TRIGGER_FUNCTIONS_ALLOWED="firm_attention_pin_era set_updated_at_now"
trigger_census() {
  sql "select coalesce(string_agg(n, ' ' order by n collate \"C\"), '(none)')
         from (select distinct p.proname::text || case when p.prosecdef then '[SECURITY-DEFINER]' else '' end as n
                 from pg_trigger t
                 join pg_class c on c.oid = t.tgrelid
                 join pg_proc p on p.oid = t.tgfoid
                where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
                  and exists (select 1 from unnest(array['anon', 'authenticated']) r, unnest(array['INSERT', 'UPDATE', 'DELETE']) x
                               where has_table_privilege(r, c.oid, x))) q;" | head -1
}
# Functions an API role may EXECUTE whose body names a listed table: a
# SECURITY DEFINER function granted to `authenticated` writes past every
# revoke. The two below are the product's own (the workspace cap READS the
# plan; account deletion removes the caller's own rows).
api_callable_functions() {
  local rx; rx="$(echo $ALL_TABLES | tr ' ' '|')"
  sql "select coalesce(string_agg(distinct p.proname, ',' order by p.proname), '(none)')
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.prosrc ~* ('\\m($rx)\\M')
          and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));" | head -1
}

# ══ The suite: run once from each starting state ═════════════════════════
suite() { # state label
  local S="$1" t label method path who body uid before after want c n ok bad got

  # ── L. the catalog ──
  for t in $ALL_TABLES; do
    if ! exists_table "$t"; then
      skip "$S L1 the catalog law on $t" "the table does not exist (schema_phase_owner_plan.sql not applied)"
      continue
    fi
    if [ "$t" = "subscriptions" ]; then want="rls=true non-select-policies=0 anon=- authenticated=SELECT public=-"
    elif is_user_readable "$t"; then    want="rls=true non-select-policies=0 anon=- authenticated=SELECT public=-"
    else                                want="rls=true non-select-policies=0 anon=- authenticated=- public=-"; fi
    check "$S L1 $t: row level security on, no non-select policy, anon nothing, authenticated no write" "$(catalog_of "$t")" "$want"
  done
  check "$S L2 subscriptions carries EXACTLY ONE policy: own row, SELECT, to authenticated" \
    "$(policies_of subscriptions)" "$ONE_POLICY"
  check "$S L2b user_usage carries EXACTLY ONE policy: own row, SELECT, to authenticated" \
    "$(policies_of user_usage)" "users_see_own_usage|SELECT|{authenticated}|(auth.uid() = user_id)|"
  check "$S L2c plan_chat_daily_usage carries EXACTLY ONE policy: own row, SELECT, to authenticated" \
    "$(policies_of plan_chat_daily_usage)" "plan_chat_daily_usage_own_select|SELECT|{authenticated}|(user_id = auth.uid())|"
  check "$S L3 no function an API role may call names a listed table, but the product's two" \
    "$(api_callable_functions)" "create_workspace,delete_my_account"
  check "$S L3b THE CENSUS: every SECURITY DEFINER function in public whose body names a listed table is on the committed list, whoever may execute it" \
    "$(definer_census)" "$(definer_allowed)"
  check "$S L3c every trigger on a table an API role can write runs a function on the committed list, and none of them SECURITY DEFINER" \
    "$(trigger_census)" "$TRIGGER_FUNCTIONS_ALLOWED"
  check "$S L4 the only view over a listed table — directly or through another view — an API role may use is the gate's own aggregate: SELECT only, not writable through" \
    "$(api_views)" "$FIXTURE_VIEW depth=1 invoker=false updatable=false anon:SELECT,authenticated:SELECT"
  check "$S L4b no view in public, whatever it reads, on which anon or authenticated hold INSERT, UPDATE or DELETE" \
    "$(writable_public_views)" "(none)"

  # ── W. every write to subscriptions is refused, and the row is byte-identical ──
  check "$S W0 the per-column attacks are generated from the catalog: one per column of public.subscriptions (22 on 2026-10-03)" \
    "$( [ "$NCOLS" -ge 22 ] && echo "covers $NCOLS columns" || echo "ONLY $NCOLS columns" )" "covers $NCOLS columns"
  local fails_before_w="$FAILS"
  baseline
  while IFS='|' read -r label method path who body uid; do
    before="$(fp "$uid")"
    fire "$method" "$path" "$who" "$body"
    after="$(fp "$uid")"
    case "$label" in
      GraphQL*)
        if [ "$GRAPHQL" != 1 ]; then skip "$S W  $label" "this stack serves no /graphql/v1"; continue; fi
        # pg_graphql answers 200 either way: a role without the privilege has no such
        # mutation, and says so by name — any OTHER error is not a refusal (A3b).
        case "$HTTP_BODY" in
          *'"affectedCount"'*) got="ACCEPTED $HTTP_BODY" ;;
          *'Unknown field'*'updatesubscriptionsCollection'*) got="refused" ;;
          *) got="$HTTP_STATUS $HTTP_BODY" ;;
        esac
        [ "$before" = "$after" ] && got="$got unchanged" || got="$got ROW CHANGED: $(show "$uid")"
        check "$S W  $label — refused (no such mutation for this role), the row unchanged" "$got" "refused unchanged"
        continue ;;
    esac
    want="403"; [ "$who" = "anon" ] && want="401"
    case "$HTTP_BODY" in *"permission denied for table subscriptions"*) got="$HTTP_STATUS denied" ;; *) got="$HTTP_STATUS $HTTP_BODY" ;; esac
    [ "$before" = "$after" ] && got="$got unchanged" || got="$got ROW CHANGED: $(show "$uid")"
    check "$S W  $label — refused, the row unchanged" "$got" "$want denied unchanged"
  done <<LIST
$(attacks)
$(column_attacks)
LIST
  for label in "$NOROW_SOLD|multi" "$NOROW_OWNER|owner"; do
    take_row
    fire POST "/rest/v1/subscriptions" user "$(norow_body "${label##*|}")"
    case "$HTTP_BODY" in *"permission denied for table subscriptions"*) got="$HTTP_STATUS denied" ;; *) got="$HTTP_STATUS $HTTP_BODY" ;; esac
    check "$S W  ${label%%|*} — refused, and there is still no row" "$got $(fp "$A")" "403 denied (no row)"
    return_row
  done
  W_FAILS=$(( W_FAILS + FAILS - fails_before_w ))

  # ── R. what a signed-in user and anon can read ──
  baseline
  req GET "/rest/v1/subscriptions?select=user_id" "$ATK_TOKEN"
  check "$S R1 a signed-in user still reads their own row — and only that row" "$HTTP_STATUS $HTTP_BODY" "200 [{\"user_id\":\"$A\"}]"
  req GET "$VIC&select=user_id" "$ATK_TOKEN"
  check "$S R2 another user's row is invisible to them" "$HTTP_STATUS $HTTP_BODY" "200 []"
  req GET "/rest/v1/subscriptions?select=user_id" "$ANON_KEY"
  check_has "$S R3 anon sees nothing: the read itself is refused" "$HTTP_STATUS $HTTP_BODY" "401 "
  check_has "$S R3b … with the table's own refusal" "$HTTP_BODY" "permission denied for table subscriptions"
  req GET "/rest/v1/user_usage?select=user_id" "$ATK_TOKEN"
  check "$S R4 a signed-in user reads their own document meter — and no other user's" "$HTTP_STATUS $HTTP_BODY" "200 [{\"user_id\":\"$A\"}]"
  req GET "/rest/v1/plan_chat_daily_usage?select=user_id" "$ATK_TOKEN"
  check "$S R5 … and their own chat counter — and no other user's" "$HTTP_STATUS $HTTP_BODY" "200 [{\"user_id\":\"$A\"}]"

  # ── Y. the post-check the runbook gives the operator ──
  check "$S Y1 the post-check report (…_preflight_report.sql, run READ ONLY) reads this catalog as fully_locked" \
    "$(verdict_of)" "fully_locked hole_open=false stopgap_in_place=false fully_locked=true"

  # ── P. every legitimate writer still works ──
  # P1 the Stripe webhook's upsert (src/engine/api/_billing.py: on_conflict=user_id), service role.
  req POST "/rest/v1/subscriptions?on_conflict=user_id" "$SERVICE_KEY" \
    "{\"user_id\":\"$V\",\"tier\":\"pro\",\"billing_cycle\":\"monthly\",\"status\":\"active\",\"is_founding_member\":false,\"stripe_customer_id\":\"cus_subsgate$RUN\",\"stripe_subscription_id\":\"sub_subsgate$RUN\",\"current_period_end\":\"2026-11-03T00:00:00+00:00\",\"cancel_at_period_end\":false}" \
    "return=minimal,resolution=merge-duplicates"
  case "$HTTP_STATUS" in 200|201) got="written" ;; *) got="$HTTP_STATUS $HTTP_BODY" ;; esac
  check "$S P1 the service role's webhook-shaped upsert (on_conflict=user_id) lands" \
    "$got $(sql "select tier || '/' || status || '/' || stripe_subscription_id from public.subscriptions where user_id = '$V';")" \
    "written pro/active/sub_subsgate$RUN"
  # P2 the cancel route's stale-id PATCH, service role.
  req PATCH "$VIC" "$SERVICE_KEY" '{"stripe_customer_id":null,"stripe_subscription_id":null}' "return=minimal"
  check "$S P2 the service role's PATCH (the cancel route clearing stale Stripe ids) lands" \
    "$HTTP_STATUS $(sql "select coalesce(stripe_subscription_id, '∅') from public.subscriptions where user_id = '$V';")" "204 ∅"
  # P3 the workspace cap reads the row the service role wrote — and only that.
  req POST "/rest/v1/rpc/create_workspace" "$ATK_TOKEN" "{\"p_name\":\"Subs gate company $S 2\"}"
  check_has "$S P3 create_workspace still refuses the trial user's 2nd workspace (the cap reads the row)" \
    "$HTTP_STATUS $HTTP_BODY" "workspace_cap_reached"
  # P4/P5 the meters, through the real RPCs as the service role.
  rpc reserve_user_upload "{\"p_user_id\":\"$A\",\"p_month\":\"$MONTH\",\"p_base_cap\":50,\"p_allow_extra\":false}"; got="$(printf '%s' "$HTTP_BODY" | sed -n 's/.*"kind" *: *"\([a-z_]*\)".*/\1/p')"
  n="$(sql "select uploads from public.user_usage where user_id = '$A' and month = '$MONTH';")"
  rpc commit_user_upload "{\"p_user_id\":\"$A\",\"p_month\":\"$MONTH\",\"p_was_extra\":false}"
  check "$S P4 the document reserve / commit RPCs still count (service role): uploads +1" \
    "$got $(sql "select uploads - ${n:-0} from public.user_usage where user_id = '$A' and month = '$MONTH';")" "allowed 1"
  n="$(sql "select coalesce((select count from public.plan_chat_daily_usage where user_id = '$A' and day = '$TODAY'), 0);")"
  rpc reserve_user_chat "{\"p_user_id\":\"$A\",\"p_month\":\"$MONTH\",\"p_day\":\"$TODAY\",\"p_daily_cap\":500,\"p_monthly_cap\":5000}"; got="$(printf '%s' "$HTTP_BODY" | sed -n 's/.*"kind" *: *"\([a-z_]*\)".*/\1/p')"
  rpc commit_user_chat "{\"p_user_id\":\"$A\",\"p_month\":\"$MONTH\",\"p_day\":\"$TODAY\"}"
  check "$S P5 the chat reserve / commit RPCs still count (service role): today's turns +1" \
    "$got $(sql "select count - $n from public.plan_chat_daily_usage where user_id = '$A' and day = '$TODAY';")" "allowed 1"

  # P6 a plain aggregate view over a listed table — production's founder_cohort_public shape.
  req GET "/rest/v1/$FIXTURE_VIEW?select=seats_claimed" "$ANON_KEY"
  check "$S P6 a public aggregate view over a listed table (the shape of production's founder_cohort_public) still answers anon" \
    "$HTTP_STATUS $HTTP_BODY" "200 [{\"seats_claimed\":$(sql "select count(*) from public.founding_members;")}]"
  before="$(tfp founding_members)"
  req PATCH "/rest/v1/$FIXTURE_VIEW?seats_claimed=gte.0" "$ATK_TOKEN" '{"seats_claimed":0}'
  case "$HTTP_STATUS" in 2*) got="ACCEPTED ($HTTP_STATUS)" ;; *) got="refused" ;; esac   # an aggregate view answers "cannot update view" before any privilege is read
  req DELETE "/rest/v1/$FIXTURE_VIEW?seats_claimed=gte.0" "$ANON_KEY"
  case "$HTTP_STATUS" in 2*) got="$got, DELETE ACCEPTED ($HTTP_STATUS)" ;; *) got="$got, refused" ;; esac
  check "$S P6b … and is not a way to write: a user's PATCH and anon's DELETE through it are refused, founding_members unchanged" \
    "$got $( [ "$before" = "$(tfp founding_members)" ] && echo unchanged || echo CHANGED )" "refused, refused unchanged"

  # ── S. the sibling tables refuse a user ──
  # The real attack on the two meters: zero your own counter.
  before="$(tfp user_usage)"
  req PATCH "/rest/v1/user_usage?user_id=eq.$A" "$ATK_TOKEN" '{"uploads":0,"uploads_reserved":0,"llm_calls":0}'
  check "$S S1 a user cannot zero their own document meter (user_usage)" \
    "$HTTP_STATUS $( [ "$before" = "$(tfp user_usage)" ] && echo unchanged || echo CHANGED )" "403 unchanged"
  req DELETE "/rest/v1/user_usage?user_id=eq.$A" "$ATK_TOKEN"
  check "$S S2 … nor delete the meter row" \
    "$HTTP_STATUS $( [ "$before" = "$(tfp user_usage)" ] && echo unchanged || echo CHANGED )" "403 unchanged"
  before="$(tfp plan_chat_daily_usage)"
  req PATCH "/rest/v1/plan_chat_daily_usage?user_id=eq.$A" "$ATK_TOKEN" '{"count":0}'
  check "$S S3 a user cannot zero today's chat counter (plan_chat_daily_usage)" \
    "$HTTP_STATUS $( [ "$before" = "$(tfp plan_chat_daily_usage)" ] && echo unchanged || echo CHANGED )" "403 unchanged"
  req GET "/rest/v1/user_usage?select=uploads&user_id=eq.$A" "$ATK_TOKEN"
  check_has "$S S4 … and still reads their own meter (the select is left as found)" "$HTTP_STATUS $HTTP_BODY" '200 [{"uploads":'
  # The three verbs (and the read) on every listed table, as the user and as anon.
  for t in $ALL_TABLES; do
    [ "$t" = "subscriptions" ] && continue
    if ! exists_table "$t"; then
      skip "$S S5 $t refuses a signed-in user's INSERT / PATCH / DELETE and anon's read" "the table does not exist (schema_phase_owner_plan.sql not applied)"
      continue
    fi
    c="$(first_col "$t")"; before="$(tfp "$t")"; got=""
    if is_user_readable "$t"; then want="200"; else want="403"; fi
    req GET "/rest/v1/$t?select=$c&limit=1" "$ATK_TOKEN";              got="$got$HTTP_STATUS "
    req POST "/rest/v1/$t" "$ATK_TOKEN" "{}";                           got="$got$HTTP_STATUS "
    req PATCH "/rest/v1/$t?$c=is.null" "$ATK_TOKEN" "{\"$c\":null}";    got="$got$HTTP_STATUS "
    req DELETE "/rest/v1/$t?$c=is.null" "$ATK_TOKEN";                   got="$got$HTTP_STATUS "
    req GET "/rest/v1/$t?select=$c&limit=1" "$ANON_KEY";                got="$got$HTTP_STATUS "
    req POST "/rest/v1/$t" "$ANON_KEY" "{}";                            got="$got$HTTP_STATUS "
    [ "$before" = "$(tfp "$t")" ] && got="${got}unchanged" || got="${got}CHANGED"
    check "$S S5 $t: user SELECT $want, INSERT / PATCH / DELETE 403; anon SELECT / INSERT 401; the table unchanged" \
      "$got" "$want 403 403 403 401 401 unchanged"
  done
  # The RPCs that write the meters are not a user's to call.
  got=""
  for c in "reserve_user_upload|{\"p_user_id\":\"$A\",\"p_month\":\"$MONTH\",\"p_base_cap\":99999,\"p_allow_extra\":false}" \
           "release_user_upload|{\"p_user_id\":\"$A\",\"p_month\":\"$MONTH\",\"p_was_extra\":false}" \
           "release_user_chat|{\"p_user_id\":\"$A\",\"p_month\":\"$MONTH\",\"p_day\":\"$TODAY\"}" \
           "claim_founding_seat|{\"p_user_id\":\"$A\",\"p_tier\":\"solo\",\"p_stripe_subscription_id\":\"sub_subsgate$RUN\"}"; do
    req POST "/rest/v1/rpc/${c%%|*}" "$ATK_TOKEN" "${c#*|}"; got="$got$HTTP_STATUS "
  done
  check "$S S6 a user cannot call the meter / founding-seat RPCs (reserve, release, release chat, claim seat)" "$got" "403 403 403 403 "
  if [ "$(sql "select to_regproc('public.assign_internal_plan') is not null;")" = "t" ]; then
    req POST "/rest/v1/rpc/assign_internal_plan" "$ATK_TOKEN" "{\"p_user_id\":\"$A\",\"p_tier\":\"owner\",\"p_reason\":\"gate\",\"p_assigned_by\":\"gate\"}"
    check "$S S7 a user cannot call assign_internal_plan on themselves" "$HTTP_STATUS $(show "$A" | cut -d' ' -f1)" "403 ∅"
  else
    skip "$S S7 a user cannot call assign_internal_plan on themselves" "the function does not exist (schema_phase_owner_plan.sql not applied)"
  fi
}

# ══ A. from state (a): the repository's catalog before the fix ═══════════
out="$(state_a)"
check "A0 state (a) is built: the two write policies, the default grants" \
  "$out|$(sql "select string_agg(policyname, ',' order by policyname) from pg_policies where schemaname = 'public' and tablename = 'subscriptions';")|$(sql "select has_table_privilege('authenticated', 'public.subscriptions', 'UPDATE'), has_table_privilege('anon', 'public.subscriptions', 'INSERT');")" \
  "|subscriptions self insert,subscriptions self select,subscriptions self update|t|t"
check "A0c … and the three own-row SELECT policies are in the form the old files gave them: no \`to authenticated\`, recorded as roles {public}" \
  "$(kept_policy_roles)" "plan_chat_daily_usage:{public} subscriptions:{public} user_usage:{public}"
check "A0b the pre-flight report (…_preflight_report.sql, run READ ONLY) reads state (a) as hole_open" \
  "$(verdict_of)" "hole_open hole_open=true stopgap_in_place=false fully_locked=false"
# The hole, seen by this harness: without these the suite below could be
# refusing for a reason of its own.
baseline
fire PATCH "$OWN" user '{"tier":"multi","status":"active"}'
check "A1 in state (a) the hole is OPEN: a signed-in user PATCHes their own tier → multi, status → active" \
  "$HTTP_STATUS $(show "$A" | cut -d' ' -f1-5)" "200 multi / professional / active"
req POST "/rest/v1/rpc/create_workspace" "$ATK_TOKEN" '{"p_name":"Subs gate company A 2"}'
check "A2 … and the SQL workspace cap now reads the self-written plan: a 2nd workspace is created" \
  "$HTTP_STATUS $(sql "select count(*) from memberships m join organizations o on o.id = m.org_id where m.user_id = '$A' and o.archived_at is null;")" "200 2"
sql "delete from public.memberships where user_id = '$A' and org_id in (select id from public.organizations where name = 'Subs gate company A 2');
     delete from public.organizations where name = 'Subs gate company A 2';" >/dev/null
take_row
fire POST "/rest/v1/subscriptions" user "$(norow_body multi)"
check "A3 … and a user with NO row INSERTs one: tier multi, plan enterprise, period end 2099" \
  "$HTTP_STATUS $(show "$A" | cut -d' ' -f1-5)" "201 multi / enterprise / active"
return_row
# The same write through the OTHER door. Without this case a malformed
# mutation would read as a refusal in every suite below.
if [ "$GRAPHQL" = 1 ]; then
  baseline
  fire POST "/graphql/v1" user "$(graphql_body "$A")"
  case "$HTTP_BODY" in *'"affectedCount": 1'*|*'"affectedCount":1'*) got="landed" ;; *) got="$HTTP_STATUS $HTTP_BODY" ;; esac
  check "A3b … and through the GraphQL endpoint (/graphql/v1) the same write lands: own tier → multi, status → active" \
    "$got $(show "$A" | cut -d' ' -f1-5)" "landed multi / professional / active"
  baseline
else
  skip "A3b … and through the GraphQL endpoint (/graphql/v1) the same write lands" "this stack serves no /graphql/v1"
fi

# ── K. IT WAITS FOR NO ONE. Another session holds a row lock on subscriptions
# (the shape of an in-flight commit RPC); the file, sent as ONE batch, must
# answer "lock timeout" in about 5 s — and have applied nothing.
run_psql -c "begin; select 1 from public.subscriptions where user_id = '$A' for update; select pg_sleep(9); rollback;" >/dev/null 2>&1 &
HOLDER=$!
sleep 1
k_t0=$(date +%s)
apply_batch "$MIGRATION"
k_dt=$(( $(date +%s) - k_t0 ))
case "$APPLY_OUT" in
  *"lock timeout"*) got="lock timeout" ;;
  *) got="NO lock timeout: $(printf '%s' "$APPLY_OUT" | grep -E 'ERROR|verified' | head -2 | tr '\n' ' ')" ;;
esac
if [ "$k_dt" -le 7 ]; then got="$got, answered within 7 s"; else got="$got, answered after $k_dt s"; fi
check "K1 with a row lock held on subscriptions by another session, the file — sent as one batch — answers 'lock timeout' in about 5 s instead of waiting" \
  "$got" "lock timeout, answered within 7 s"
check "K2 … and NOTHING was applied: the three policies and the write privilege are still there (one batch is one transaction)" \
  "$(sql "select string_agg(policyname, ',' order by policyname) from pg_policies where schemaname = 'public' and tablename = 'subscriptions';")|$(sql "select has_table_privilege('authenticated', 'public.subscriptions', 'UPDATE');")" \
  "subscriptions self insert,subscriptions self select,subscriptions self update|t"
wait "$HOLDER" 2>/dev/null

migrate "A4 the migration applies on state (a), with no error and no warning"
check_has "A5 … and its LAST RESULT is the row \`applied\`: verified" "$APPLY_OUT" \
  '"verified": "every listed table is closed to anon and authenticated writes"'
check_has "A5b … which names the policy it dropped — no NOTICE is needed to know what changed" "$APPLY_OUT" \
  '{"cmd": "UPDATE", "table": "subscriptions", "policy": "subscriptions self update"}'
check_has "A5c … and says it changed something" "$APPLY_OUT" '"changed_anything": true'
suite "a"

# ══ B. from state (b): the hand-applied stopgap ══════════════════════════
state_a >/dev/null
out="$(state_b)"
check "B0 state (b) is built: the stopgap ran without an error" "$out" ""
check "B1 the stopgap alone leaves anon's SELECT on subscriptions and the meters' write grants in place" \
  "$(sql "select has_table_privilege('anon', 'public.subscriptions', 'SELECT'), has_table_privilege('authenticated', 'public.user_usage', 'UPDATE'), has_table_privilege('anon', 'public.plan_chat_daily_usage', 'DELETE');")" \
  "t|t|t"
check "B1b the pre-flight report reads state (b) as stopgap_in_place" \
  "$(verdict_of)" "stopgap_in_place hole_open=false stopgap_in_place=true fully_locked=false"
check "B1c state (b) is what a database built from the OLD files holds after the stopgap: on subscriptions anon and authenticated keep $STOPGAP_LEFT, on the two meters the default grant, and the three own-row SELECT policies are still \`to public\`" \
  "$(catalog_of subscriptions) ; $(catalog_of user_usage) ; $(catalog_of plan_chat_daily_usage) ; $(kept_policy_roles)" \
  "rls=true non-select-policies=0 anon=$STOPGAP_LEFT authenticated=$STOPGAP_LEFT public=- ; rls=true non-select-policies=0 anon=$DEFAULT_ALL authenticated=$DEFAULT_ALL public=- ; rls=true non-select-policies=0 anon=$DEFAULT_ALL authenticated=$DEFAULT_ALL public=- ; plan_chat_daily_usage:{public} subscriptions:{public} user_usage:{public}"
migrate "B2 the migration applies ON TOP of the stopgap: nothing errors on a missing policy or an already-revoked privilege"
got=""
for frag in '{"cmd": "SELECT", "table": "subscriptions", "policy": "subscriptions self select"}' \
            '{"cmd": "SELECT", "table": "user_usage", "policy": "users_see_own_usage"}' \
            '{"cmd": "SELECT", "table": "plan_chat_daily_usage", "policy": "plan_chat_daily_usage_own_select"}' \
            '{"table": "subscriptions", "policy": "subscriptions self select"}' \
            '{"table": "user_usage", "policy": "users_see_own_usage"}' \
            '{"table": "plan_chat_daily_usage", "policy": "plan_chat_daily_usage_own_select"}' \
            '"row_level_security_switched_on": []' '"changed_anything": true'; do
  case "$APPLY_OUT" in *"$frag"*) got="$got ok" ;; *) got="$got MISSING($frag)" ;; esac
done
check "B2b … and its result row says what it did there: the three own-row SELECT policies dropped (they were \`to public\`) and created again \`to authenticated\`, no table's row level security touched" \
  "$got" " ok ok ok ok ok ok ok ok"
suite "b"

# ══ C. from state (c): the migration's own result ════════════════════════
migrate "C0 the migration applies a second time (idempotent)"
got=""
for frag in '"changed_anything": false' '"policies_dropped": []' '"policies_created": []' '"row_level_security_switched_on": []'; do
  case "$APPLY_OUT" in *"$frag"*) got="$got ok" ;; *) got="$got MISSING($frag)" ;; esac
done
check "C1 the second run says so in its result row: changed_anything false, nothing dropped, nothing created, no table touched" "$got" " ok ok ok ok"
apply_batch "$MIGRATION"
case "$APPLY_OUT" in
  *ERROR*) got="$(printf '%s' "$APPLY_OUT" | grep ERROR | head -1)" ;;
  *'"applied": true'*'"changed_anything": false'*) got="applied, changed nothing" ;;
  *) got="no applied row: $(printf '%s' "$APPLY_OUT" | tail -1 | cut -c1-160)" ;;
esac
check "C1b sent as ONE multi-statement query — the way Studio's editor and the Management API send a file — it applies, and its last result is the row \`applied\`" \
  "$got" "applied, changed nothing"
out="$(in_rolled_back_txn "$(cat "$MIGRATION")
select 'LOCK ' || c.relname || ' ' || l.mode
  from pg_locks l join pg_class c on c.oid = l.relation
 where l.pid = pg_backend_pid() and l.locktype = 'relation'
   and c.relnamespace = 'public'::regnamespace and l.mode <> 'AccessShareLock'
 order by 1;")"
check "C2 a run that changes nothing takes NO lock above ACCESS SHARE on any table (it cannot stall a plan read)" \
  "$(printf '%s\n' "$out" | grep -E '^LOCK|ERROR' | tr '\n' ' ')" ""
# The repository's own files create the three kept policies. Re-running their
# statements after the lockdown must re-create them exactly as it keeps them.
rerun="$( { grep -E 'policy (if exists )?"subscriptions self' "$REPO/supabase/schema.sql"
            sed -n '/drop policy if exists "users_see_own_usage"/,/using (auth.uid() = user_id);/p' "$REPO/supabase/schema_phase5_usage_limits.sql"
            sed -n '/drop policy if exists "plan_chat_daily_usage_own_select"/,/using (user_id = auth.uid());/p' "$REPO/supabase/schema_phase_pricing_v2.sql"; } | grep -v '^[[:space:]]*--' )"
out="$(sql "set client_min_messages = warning;
$rerun")"
apply_file "$MIGRATION"
got="statements re-run: $(printf '%s\n' "$rerun" | grep -c 'create policy') create, $(printf '%s\n' "$rerun" | grep -c 'drop policy') drop; errors: $(printf '%s' "$out" | grep -c ERROR);"
case "$APPLY_OUT" in *'"changed_anything": false'*) got="$got the next lockdown run changed nothing" ;; *) got="$got THE NEXT LOCKDOWN RUN CHANGED SOMETHING: $(printf '%s' "$APPLY_OUT" | grep -o '"policies_dropped": [^]]*]' | head -1)" ;; esac
check "C3 re-running the repository's own policy statements (schema.sql, schema_phase5_usage_limits.sql, schema_phase_pricing_v2.sql) after the lockdown re-creates the three kept policies as it keeps them" \
  "$got" "statements re-run: 3 create, 5 drop; errors: 0; the next lockdown run changed nothing"
suite "c"

# ══ Y. the read-only files the runbook hands the operator ════════════════
out="$(read_only "$PREFLIGHT_GRIDS")"
case "$out" in *ERROR*) got="ERROR: $(printf '%s' "$out" | grep ERROR | head -1)" ;; *) got="no error" ;; esac
case "$out" in *"subscriptions|subscriptions self select|SELECT|PERMISSIVE|{authenticated}|(auth.uid() = user_id)|"*) got="$got, the policies grid" ;; esac
case "$out" in *"create_workspace(text,text,text)|t|f|t"*) got="$got, the functions grid" ;; esac
check "Y2 the pre-flight grids (…_preflight.sql) run whole inside a READ ONLY transaction" \
  "$got" "no error, the policies grid, the functions grid"
# The audit: a self-written row (written here with the service role, in the
# shape the attack leaves), then the same with forged Stripe ids.
sql "update public.subscriptions set tier = 'multi', status = 'active' where user_id = '$V';" >/dev/null
out="$(read_only "$AUDIT_REPORT")"
got=""
case "$out" in *ERROR*) got="ERROR: $(printf '%s' "$out" | grep ERROR | head -1)" ;; *) got="no error" ;; esac
case "$out" in *"\"user_id\": \"$V\""*'"tier set, no Stripe subscription"'*|*'"tier set, no Stripe subscription"'*"\"user_id\": \"$V\""*) got="$got, lists the row and why" ;; esac
case "$out" in *@*) got="$got, AN @ IN THE OUTPUT" ;; *) got="$got, no email" ;; esac
check "Y3 the audit report (…_audit_report.sql, READ ONLY) lists a self-written tier with no payment behind it" \
  "$got" "no error, lists the row and why, no email"
sql "update public.subscriptions set stripe_customer_id = 'cus_subsgate$RUN', stripe_subscription_id = 'sub_subsgate$RUN' where user_id = '$V';" >/dev/null
out="$(read_only "$AUDIT_REPORT")"
got=""
case "$out" in *'"subscription_id_in_no_event": true'*) got="in the second list" ;; *) got="NOT in the second list" ;; esac
case "$out" in *"subsgate$RUN"*) got="$got, A STRIPE ID VALUE IN THE OUTPUT" ;; *) got="$got, no Stripe id value" ;; esac
check "Y4 … and the same row WITH forged Stripe ids of the right shape — which the first list cannot see — in stripe_ids_in_no_billing_event" \
  "$got" "in the second list, no Stripe id value"
out="$(in_rolled_back_txn "alter table public.founding_members rename to subs_gate_fm_away;
alter table public.billing_events rename to subs_gate_be_away;
$(cat "$AUDIT_REPORT")")"
got=""
case "$out" in *ERROR*) got="ERROR: $(printf '%s' "$out" | grep ERROR | head -1)" ;; *) got="no error" ;; esac
case "$out" in *'"founding_members": false'*) got="$got, founding_members absent" ;; esac
case "$out" in *'"billing_events": false'*) got="$got, billing_events absent" ;; esac
check "Y5 … and it runs where founding_members and billing_events do not exist" \
  "$got" "no error, founding_members absent, billing_events absent"
baseline
# The audit's row_fingerprints: what an operator compares before and after the
# migration in production, where this gate cannot run.
check "Y6 the audit report's row_fingerprints: for every listed table '<rows>:<md5 over every row's whole content>' — equal to the same sum computed here — and 'absent' for a table that does not exist" \
  "$(audit_rows_of_listed)" "$(expected_rows_of_listed)"
y_before="$(audit_rows_of_listed)"
sql "update public.subscriptions set cancel_at_period_end = not cancel_at_period_end where user_id = '$V';" >/dev/null
y_moved="$(audit_rows_of_listed)"
baseline
y_before2="$(audit_rows_of_listed)"
apply_file "$MIGRATION"
y_after="$(audit_rows_of_listed)"
got=""
if [ "${y_before%% *}" != "${y_moved%% *}" ] && [ "${y_before#* }" = "${y_moved#* }" ]; then got="one write to one row moves that table's fingerprint and no other"; else got="ONE WRITE DID NOT MOVE EXACTLY ONE FINGERPRINT: $y_before -> $y_moved"; fi
if [ -n "$y_before2" ] && [ "$y_before2" = "$y_after" ]; then got="$got; identical before and after the migration"; else got="$got; THE MIGRATION MOVED A FINGERPRINT: $y_before2 -> $y_after"; fi
check "Y7 … one write to one row moves the fingerprint of that table alone, and applying the migration moves none: the same file run on both sides of it shows that no row changed (the fence, as production can read it)" \
  "$got" "one write to one row moves that table's fingerprint and no other; identical before and after the migration"

# ══ T. a grant, or a table, that is not the owner's to change ════════════
# Each case is ONE transaction that is rolled back (the roles it creates
# included): nothing here reaches another session or outlives the case.
# The runner is NAMED in every role statement: on the local stack's Postgres
# image (supabase/postgres 17.6.1.106) a GRANT of a role "to" the keyword
# CURRENT_USER SEGFAULTS the backend — the whole cluster restarts (measured
# twice, 2026-10-03, on the first draft of these cases). The named form does not.
RUNNER="$(sql "select current_user;" | head -1)"
RUNNER_ID="$(sql "select quote_ident(current_user);" | head -1)"
t_grantor="create role subs_gate_grantor nologin;
grant update, insert on public.subscriptions to subs_gate_grantor with grant option;
grant subs_gate_grantor to $RUNNER_ID;
set local role subs_gate_grantor;
grant update on public.subscriptions to authenticated;
grant insert on public.subscriptions to anon;
reset role;
revoke subs_gate_grantor from $RUNNER_ID;"
out="$(in_rolled_back_txn "$t_grantor
$(cat "$MIGRATION")")"
got=""
case "$out" in *"write lockdown INCOMPLETE — nothing was applied"*) got="INCOMPLETE" ;; *) got="NO INCOMPLETE ERROR" ;; esac
case "$out" in *"authenticated still holds UPDATE — granted by subs_gate_grantor. Run: revoke update on public.subscriptions from subs_gate_grantor cascade;"*) got="$got, names the grantor and the statement" ;; esac
case "$out" in *"anon still holds INSERT — granted by subs_gate_grantor. Run: revoke insert on public.subscriptions from subs_gate_grantor cascade;"*) got="$got, for anon too" ;; esac
check "T1 a write privilege granted by ANOTHER role: the file raises, and each line ends with the statement that removes that grant" \
  "$got" "INCOMPLETE, names the grantor and the statement, for anon too"
remedy="$(remedies_of "$out")"
out="$(in_rolled_back_txn "$t_grantor
revoke update on public.subscriptions from authenticated;
select 'OWNER-PLAIN-REVOKE ' || has_table_privilege('authenticated', 'public.subscriptions', 'UPDATE');")"
check_has "T1b … the owner's plain \`revoke update … from authenticated\` answers REVOKE and removes NOTHING (the trap the hint names)" \
  "$out" "OWNER-PLAIN-REVOKE true"
out="$(in_rolled_back_txn "$t_grantor
$remedy
$(cat "$MIGRATION")")"
case "$out" in *ERROR*) got="ERROR: $(printf '%s' "$out" | grep -A3 ERROR | head -4 | tr '\n' ' ')" ;; *'"verified": "every listed table is closed to anon and authenticated writes"'*) got="verified" ;; *) got="no verified row" ;; esac
check "T2 … and those statements, run as the owner, remove it: the file then passes" "$got" "verified"

t_column="create role subs_gate_grantor nologin;
grant update on public.subscriptions to subs_gate_grantor with grant option;
grant subs_gate_grantor to $RUNNER_ID;
set local role subs_gate_grantor;
grant update (tier) on public.subscriptions to authenticated;
reset role;
revoke subs_gate_grantor from $RUNNER_ID;"
out="$(in_rolled_back_txn "$t_column
$(cat "$MIGRATION")")"
check_has "T3 a COLUMN-level grant made by another role: named as that, with the two statements that remove it (a cascade at table level leaves it)" \
  "$out" "authenticated still holds UPDATE on column tier — a column-level grant made by subs_gate_grantor. Run: grant update (tier) on public.subscriptions to subs_gate_grantor with grant option; revoke update (tier) on public.subscriptions from subs_gate_grantor cascade;"
remedy="$(remedies_of "$out")"
out="$(in_rolled_back_txn "$t_column
$remedy
$(cat "$MIGRATION")")"
case "$out" in *ERROR*) got="ERROR: $(printf '%s' "$out" | grep -A3 ERROR | head -4 | tr '\n' ' ')" ;; *'"verified": "every listed table is closed to anon and authenticated writes"'*) got="verified" ;; *) got="no verified row" ;; esac
check "T4 … and they remove it: the file then passes" "$got" "verified"

t_member="create role subs_gate_group nologin;
grant update on public.subscriptions to subs_gate_group;
grant subs_gate_group to authenticated;"
out="$(in_rolled_back_txn "$t_member
$(cat "$MIGRATION")")"
check_has "T5 a privilege INHERITED through a role membership: named as that — not as a column-level grant — with its statement" \
  "$out" "authenticated still holds UPDATE — inherited through its membership in role subs_gate_group. Run: revoke update on public.subscriptions from subs_gate_group;"
remedy="$(remedies_of "$out")"
out="$(in_rolled_back_txn "$t_member
$remedy
$(cat "$MIGRATION")")"
case "$out" in *ERROR*) got="ERROR: $(printf '%s' "$out" | grep -A3 ERROR | head -4 | tr '\n' ' ')" ;; *'"verified": "every listed table is closed to anon and authenticated writes"'*) got="verified" ;; *) got="no verified row" ;; esac
check "T6 … and it removes it: the file then passes" "$got" "verified"

if [ "$(sql "select rolsuper from pg_roles where rolname = current_user;")" = "f" ]; then
  out="$(in_rolled_back_txn "create role subs_gate_owner nologin;
grant subs_gate_owner to $RUNNER_ID;
grant create on schema public to subs_gate_owner;
alter table public.billing_events owner to subs_gate_owner;
revoke subs_gate_owner from $RUNNER_ID;
$(cat "$MIGRATION")")"
  got=""
  case "$out" in *"which does not own every listed table — nothing was applied"*) got="stops before any change" ;; *) got="DID NOT STOP: $(printf '%s' "$out" | grep ERROR | head -1)" ;; esac
  case "$out" in *"public.billing_events is owned by subs_gate_owner. As subs_gate_owner (or a superuser) run: alter table public.billing_events owner to $RUNNER;"*) got="$got, names the table, its owner and the statement" ;; esac
  check "T7 a listed table owned by ANOTHER role: the file stops before changing anything and says what Postgres' bare 'must be owner' does not" \
    "$got" "stops before any change, names the table, its owner and the statement"
else
  skip "T7 a listed table owned by another role" "this stack runs the file as a superuser, who may act as any owner"
fi
check "T8 nothing of T outlived its transaction: no role, no grant, the table's owner" \
  "$(sql "select (select count(*) from pg_roles where rolname like 'subs\_gate\_%'), has_table_privilege('authenticated', 'public.subscriptions', 'UPDATE'), (select pg_get_userbyid(relowner) from pg_class where oid = 'public.billing_events'::regclass);")" \
  "0|f|$RUNNER"

# ── V. a view over a view over subscriptions, with the privileges a new view
# gets by default — rolled back like T. The migration does not close it; it
# must NAME it (a WARNING, and its result row), and so must the report.
out="$(in_rolled_back_txn "create view public.subs_gate_v_base as select * from public.subscriptions;
revoke all on public.subs_gate_v_base from public, anon, authenticated;
create view public.subs_gate_v_outer as select * from public.subs_gate_v_base;
$(cat "$MIGRATION")
$(cat "$PREFLIGHT_REPORT")")"
got=""
case "$out" in *"WARNING:  write lockdown: view public.subs_gate_v_outer reads a listed table (depth 2), can be written through"*) got="the migration warns at depth 2" ;; *) got="NO WARNING for the nested view" ;; esac
got="$got; named in $(printf '%s' "$out" | grep -o '"views_that_can_be_written_through": \["public.subs_gate_v_outer"\]' | wc -l | tr -d ' ') of 2 result rows (applied, report)"
check "V1 a view over a view over subscriptions can be written through: the migration says so at depth 2 and names it in its result row, and the pre-flight report names it in its verdict" \
  "$got" "the migration warns at depth 2; named in 2 of 2 result rows (applied, report)"

# ══ D. from state (d): locked, then re-opened by hand under other names ══
out="$(state_d)"
check "D0 state (d) is built on the migration's result: a FOR ALL policy, a permissive read, a column-level grant, RLS off on a meter, anon re-granted" \
  "$out|$(sql "select string_agg(policyname || ' [' || cmd || ']', ',' order by policyname) from pg_policies where schemaname = 'public' and tablename = 'subscriptions';")|$(sql "select has_column_privilege('authenticated', 'public.subscriptions', 'tier', 'UPDATE'), has_table_privilege('authenticated', 'public.subscriptions', 'UPDATE'), (select relrowsecurity from pg_class where oid = 'public.plan_chat_daily_usage'::regclass), has_table_privilege('anon', 'public.founding_members', 'INSERT');")" \
  "|billing can write [ALL],everyone reads plans [SELECT],subscriptions self select [SELECT]|t|f|f|t"
check "D0b the pre-flight report reads state (d) as hole_open" \
  "$(verdict_of)" "hole_open hole_open=true stopgap_in_place=false fully_locked=false"
baseline
fire PATCH "$VIC" user '{"tier":"multi","status":"active"}'
check "D1 in state (d) the hole is OPEN again, and wider: the attacker PATCHes ANOTHER user's tier → multi" \
  "$HTTP_STATUS $(show "$V" | cut -d' ' -f1-5)" "200 multi / professional / active"
req GET "/rest/v1/subscriptions?select=user_id" "$ATK_TOKEN"
check_has "D1b … and reads every user's plan row (the permissive read)" "$HTTP_STATUS $HTTP_BODY" "$V"
req GET "/rest/v1/user_usage?select=user_id" "$ATK_TOKEN"
check_has "D1c … and every user's document meter (a permissive read on user_usage)" "$HTTP_STATUS $HTTP_BODY" "$V"
migrate "D2 the migration applies over the hand-made openings, with no error and no warning"
got=""
for frag in '{"cmd": "ALL", "table": "subscriptions", "policy": "billing can write"}' \
            '{"cmd": "SELECT", "table": "subscriptions", "policy": "everyone reads plans"}' \
            '{"cmd": "UPDATE", "table": "user_usage", "policy": "users write own usage"}' \
            '{"cmd": "SELECT", "table": "user_usage", "policy": "everyone reads usage"}' \
            '"row_level_security_switched_on": ["plan_chat_daily_usage"]'; do
  case "$APPLY_OUT" in *"$frag"*) got="$got ok" ;; *) got="$got MISSING($frag)" ;; esac
done
check "D3 … and its result row names each hand-made policy it dropped — the FOR ALL one, both permissive reads, the UPDATE on a meter — and the table it switched row level security back on for" \
  "$got" " ok ok ok ok ok"
suite "d"

# ══ E. both orders against schema_phase_owner_plan.sql ═══════════════════
if [ -f "$OWNER_PLAN_MIGRATION" ]; then
  apply_file "$OWNER_PLAN_MIGRATION"; rc=$?
  check "E0 schema_phase_owner_plan.sql applies AFTER the lockdown" "$rc" "0"
  got=""; want=""
  for t in $ALL_TABLES; do
    got="$got$t:$(catalog_of "$t" | sed 's/ public=.*//; s/rls=true non-select-policies=0 //') "
    if is_user_readable "$t"; then want="$want$t:anon=- authenticated=SELECT "; else want="$want$t:anon=- authenticated=- "; fi
  done
  check "E1 … and re-opens nothing: every listed table, plan_assignment_audit included, is closed" "$got" "$want"
  baseline; before="$(fp "$A")"
  fire PATCH "$OWN" user '{"tier":"multi","status":"active"}'
  check "E2 … a signed-in user's PATCH is still refused, the row unchanged" \
    "$HTTP_STATUS $( [ "$before" = "$(fp "$A")" ] && echo unchanged || echo CHANGED )" "403 unchanged"
  migrate "E3 the lockdown applies AFTER schema_phase_owner_plan.sql (the other order)"
  check "E4 … and plan_assignment_audit is on its list: closed, row level security on" \
    "$(catalog_of plan_assignment_audit)" "rls=true non-select-policies=0 anon=- authenticated=- public=-"
  check "E5 … and the post-check report still reads fully_locked" \
    "$(verdict_of)" "fully_locked hole_open=false stopgap_in_place=false fully_locked=true"
else
  skip "E the two files in both orders" "supabase/schema_phase_owner_plan.sql is not in this checkout (set SUBS_LOCKDOWN_OWNER_PLAN_MIGRATION to run it)"
fi

# ══ Z. the gate leaves nothing behind, and leaves the tables closed ══════
cleanup
check "Z1 the gate's users, workspaces, counters, seats and its view are removed" \
  "$(sql "select (select count(*) from auth.users where email like '%@$DOMAIN'),
                 (select count(*) from public.organizations where name like 'Subs gate company %'),
                 (select count(*) from public.subscriptions where stripe_customer_id like 'cus_subsgate%'),
                 (select count(*) from pg_class where relname = '$FIXTURE_VIEW');")" "0|0|0|0"
check "Z2 the stack is left CLOSED: one policy on subscriptions, no write privilege for an API role" \
  "$(policies_of subscriptions)|$(catalog_of subscriptions)" \
  "$ONE_POLICY|rls=true non-select-policies=0 anon=- authenticated=SELECT public=-"

if [ "$W_FAILS" = 0 ]; then
  echo "ATTACKS on public.subscriptions — $NNAMED of $NNAMED named attacks and $NCOLS of $NCOLS per-column writes (one per column, generated from pg_attribute) REFUSED, the row byte-identical, from each of the 4 starting states"
else
  echo "ATTACKS on public.subscriptions — $W_FAILS attack case(s) NOT refused across the 4 starting states"
fi
echo "GATE-WORK $GATE units=$UNITS"
[ "$SKIPS" -gt 0 ] && echo "SKIPPED $SKIPS case(s) — NOT passes: each names what it needs (an object schema_phase_owner_plan.sql creates, or an endpoint this stack does not serve)"
if [ "$FAILS" -gt 0 ]; then
  echo "SUBSCRIPTIONS-WRITE-LOCKDOWN GATE: FAIL — $FAILS of $UNITS case(s) failed"
  exit 1
fi
echo "SUBSCRIPTIONS-WRITE-LOCKDOWN GATE: PASS — $UNITS case(s), $SKIPS skipped, users removed, the tables left closed"
exit 0
