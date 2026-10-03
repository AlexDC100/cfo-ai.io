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
#       (the two write policies present, the default grants in place) — and
#       the attack is first shown to SUCCEED there, so the harness is known to
#       see an open hole;
#   (b) the hand-applied three-statement STOPGAP (the two write policies
#       dropped; insert, update, delete, truncate, references, trigger revoked
#       from anon and authenticated) — the migration must run on top of it
#       without an error and still close what the stopgap left;
#   (c) the migration's own result (a second run: idempotent, and silent);
#   (d) a locked database somebody RE-OPENED BY HAND under names the migration
#       has never heard of (a `for all` policy to authenticated, a permissive
#       `using (true)` read, a column-level `grant update (tier, status)`, row
#       level security off on a meter, privileges handed back to anon) — shown
#       OPEN first (the attacker writes ANOTHER user's tier), then closed.
# In each: every write of a signed-in user to their own row is refused
# (status, the body's reason, and the row read back with the service role is
# byte-identical), on every sold tier and every entitlement column; INSERT
# when no row exists, DELETE, and every write to another user's row; anon
# sees nothing; the user still reads their own row and only that; the service
# role's webhook-shaped upsert, a brand-new signup's seeded row and the
# document / chat reserve-commit RPCs still work; every sibling entitlement
# table refuses a user write. Beside the behaviour, the catalog laws: row
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
# apart, never a pass.
#
# LOCAL ONLY. The database is SUBS_LOCKDOWN_DB_URL (default: the local test
# stack, postgresql://postgres:postgres@127.0.0.1:54322/postgres) and the API
# is SUBS_LOCKDOWN_API_URL (default http://127.0.0.1:54321). A host that is
# not a loopback address is REFUSED (exit 2) before anything is opened: this
# script creates users, re-creates the open state (a) and applies a migration.
#
# VACUOUS, never green, when the local stack is not running: it prints
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
DB_URL="${SUBS_LOCKDOWN_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
API_URL="${SUBS_LOCKDOWN_API_URL:-http://127.0.0.1:54321}"
CONTAINER="${SUBS_LOCKDOWN_DB_CONTAINER:-supabase_db_cfo-ai-test}"
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
     && docker port "$CONTAINER" 5432/tcp 2>/dev/null | grep -q ":$DB_PORT\$"; then
  run_psql() { docker exec -i "$CONTAINER" psql -U postgres -d postgres -X -At -q -v ON_ERROR_STOP=1 "$@"; }
else
  vacuous "no psql on this host and no container '$CONTAINER' publishing port $DB_PORT"
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

RUN="$(date +%s)$$"
DOMAIN="subs-gate.invalid"
MONTH="$(date -u +%Y-%m)"
TODAY="$(date -u +%Y-%m-%d)"

apply_file() { # file → APPLY_OUT, returns psql's status (one transaction, like Studio)
  APPLY_OUT="$(run_psql --single-transaction -f - < "$1" 2>&1)"
}

FIXTURE_VIEW="subs_gate_cohort_public"
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
LIST
}
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
rpc() { req POST "/rest/v1/rpc/$1" "$SERVICE_KEY" "$2"; }
first_col() { sql "select attname from pg_attribute where attrelid = 'public.$1'::regclass and attnum = 1;" | head -1; }

# ── The four starting states ─────────────────────────────────────────────
# (a) the catalog of a database built from this repository BEFORE the fix —
#     measured on a fresh stack: the three policies of the old schema.sql,
#     Supabase's default grants on the three user-readable tables.
state_a() {
  sql "set client_min_messages = warning;
       drop policy if exists \"subscriptions self select\" on public.subscriptions;
       drop policy if exists \"subscriptions self insert\" on public.subscriptions;
       drop policy if exists \"subscriptions self update\" on public.subscriptions;
       create policy \"subscriptions self select\" on public.subscriptions for select using (auth.uid() = user_id);
       create policy \"subscriptions self insert\" on public.subscriptions for insert with check (auth.uid() = user_id);
       create policy \"subscriptions self update\" on public.subscriptions for update using (auth.uid() = user_id);
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
# Views over a listed table that an API role holds a privilege on: name,
# security_invoker, whether the view can be written through, the privileges.
api_views() {
  sql "select coalesce(string_agg(x, ' ; ' order by x), '(none)') from (
         select v.relname
                || ' invoker=' || coalesce((select option_value from pg_options_to_table(v.reloptions) where option_name = 'security_invoker'), 'false')
                || ' updatable=' || ((pg_relation_is_updatable(v.oid, false) & 28) <> 0)
                || ' ' || (select string_agg(r || ':' || p, ',' order by r, p)
                             from unnest(array['anon', 'authenticated']) r, unnest(array['DELETE', 'INSERT', 'SELECT', 'UPDATE']) p
                            where has_table_privilege(r, v.oid, p)) as x
           from pg_class v
          where v.relkind in ('v', 'm') and v.relnamespace = 'public'::regnamespace
            and exists (select 1 from pg_rewrite w
                          join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = w.oid and d.refclassid = 'pg_class'::regclass
                          join pg_class t on t.oid = d.refobjid
                         where w.ev_class = v.oid and t.relkind = 'r' and t.relnamespace = 'public'::regnamespace
                           and t.relname = any (string_to_array('$(echo $ALL_TABLES)', ' ')))
            and exists (select 1 from unnest(array['anon', 'authenticated']) r, unnest(array['DELETE', 'INSERT', 'SELECT', 'UPDATE']) p
                         where has_table_privilege(r, v.oid, p))) q;" | head -1
}
migrate() { # label
  apply_file "$MIGRATION"; local rc=$?
  if [ $rc -eq 0 ]; then
    case "$APPLY_OUT" in
      *ERROR*|*WARNING*) fail "$1" "$(echo "$APPLY_OUT" | grep -E 'ERROR|WARNING' | head -3)" ;;
      *) pass "$1" ;;
    esac
  else fail "$1" "$(echo "$APPLY_OUT" | grep -v '^$' | tail -4)"; fi
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
  echo "authenticated on subscriptions: $(sql "select coalesce(string_agg(privilege_type, ',' order by privilege_type), '(none)') from information_schema.role_table_grants where table_schema = 'public' and table_name = 'subscriptions' and grantee = 'authenticated';")"
  echo "anon on subscriptions: $(sql "select coalesce(string_agg(privilege_type, ',' order by privilege_type), '(none)') from information_schema.role_table_grants where table_schema = 'public' and table_name = 'subscriptions' and grantee = 'anon';")"
  echo "views over a listed table an API role may use: $(api_views)"
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
  echo "GATE-WORK $GATE units=0"
  exit 0
fi

# ══ The catalog law, one line per listed table ═══════════════════════════
# rls · policies that are not SELECT · what anon holds · what authenticated
# holds (table OR column level) · what PUBLIC holds.
catalog_of() {
  sql "select 'rls=' || c.relrowsecurity
          || ' non-select-policies=' || (select count(*) from pg_policies p
                                          where p.schemaname = 'public' and p.tablename = c.relname and p.cmd <> 'SELECT')
          || ' anon=' || coalesce((select string_agg(x, ',' order by x) from unnest(array['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']) x
                                    where case when x in ('INSERT','UPDATE','REFERENCES','SELECT') then has_any_column_privilege('anon', c.oid, x)
                                               else has_table_privilege('anon', c.oid, x) end), '-')
          || ' authenticated=' || coalesce((select string_agg(x, ',' order by x) from unnest(array['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']) x
                                    where case when x in ('INSERT','UPDATE','REFERENCES','SELECT') then has_any_column_privilege('authenticated', c.oid, x)
                                               else has_table_privilege('authenticated', c.oid, x) end), '-')
          || ' public=' || coalesce((select string_agg(a.privilege_type, ',' order by a.privilege_type)
                                       from aclexplode(c.relacl) a where a.grantee = 0), '-')
       from pg_class c where c.oid = 'public.$1'::regclass;" | head -1
}
ONE_POLICY="subscriptions self select|SELECT|{authenticated}|(auth.uid() = user_id)|"
policies_of_subscriptions() {
  sql "select coalesce(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ' ; ' order by policyname), '(none)')
         from pg_policies where schemaname = 'public' and tablename = 'subscriptions';" | head -1
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
    "$(policies_of_subscriptions)" "$ONE_POLICY"
  check "$S L3 no function an API role may call names a listed table, but the product's two" \
    "$(api_callable_functions)" "create_workspace,delete_my_account"
  check "$S L4 the only view over a listed table an API role may use is the gate's own aggregate: SELECT only, not writable through" \
    "$(api_views)" "$FIXTURE_VIEW invoker=false updatable=false anon:SELECT,authenticated:SELECT"

  # ── W. every write to subscriptions is refused, and the row is byte-identical ──
  baseline
  while IFS='|' read -r label method path who body uid; do
    before="$(fp "$uid")"
    fire "$method" "$path" "$who" "$body"
    after="$(fp "$uid")"
    want="403"; [ "$who" = "anon" ] && want="401"
    case "$HTTP_BODY" in *"permission denied for table subscriptions"*) got="$HTTP_STATUS denied" ;; *) got="$HTTP_STATUS $HTTP_BODY" ;; esac
    [ "$before" = "$after" ] && got="$got unchanged" || got="$got ROW CHANGED: $(show "$uid")"
    check "$S W  $label — refused, the row unchanged" "$got" "$want denied unchanged"
  done <<LIST
$(attacks)
LIST
  for label in "$NOROW_SOLD|multi" "$NOROW_OWNER|owner"; do
    take_row
    fire POST "/rest/v1/subscriptions" user "$(norow_body "${label##*|}")"
    case "$HTTP_BODY" in *"permission denied for table subscriptions"*) got="$HTTP_STATUS denied" ;; *) got="$HTTP_STATUS $HTTP_BODY" ;; esac
    check "$S W  ${label%%|*} — refused, and there is still no row" "$got $(fp "$A")" "403 denied (no row)"
    return_row
  done

  # ── R. what a signed-in user and anon can read ──
  baseline
  req GET "/rest/v1/subscriptions?select=user_id" "$ATK_TOKEN"
  check "$S R1 a signed-in user still reads their own row — and only that row" "$HTTP_STATUS $HTTP_BODY" "200 [{\"user_id\":\"$A\"}]"
  req GET "$VIC&select=user_id" "$ATK_TOKEN"
  check "$S R2 another user's row is invisible to them" "$HTTP_STATUS $HTTP_BODY" "200 []"
  req GET "/rest/v1/subscriptions?select=user_id" "$ANON_KEY"
  check_has "$S R3 anon sees nothing: the read itself is refused" "$HTTP_STATUS $HTTP_BODY" "401 "
  check_has "$S R3b … with the table's own refusal" "$HTTP_BODY" "permission denied for table subscriptions"

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
# The hole, seen by this harness: without these three the suite below could
# be refusing for a reason of its own.
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
migrate "A4 the migration applies on state (a), with no error and no warning"
check_has "A5 … and names what it dropped (the NOTICEs an operator reads)" "$APPLY_OUT" 'dropped policy "subscriptions self update" (UPDATE) on public.subscriptions'
suite "a"

# ══ B. from state (b): the hand-applied stopgap ══════════════════════════
state_a >/dev/null
out="$(state_b)"
check "B0 state (b) is built: the stopgap ran without an error" "$out" ""
check "B1 the stopgap alone leaves anon's SELECT on subscriptions and the meters' write grants in place" \
  "$(sql "select has_table_privilege('anon', 'public.subscriptions', 'SELECT'), has_table_privilege('authenticated', 'public.user_usage', 'UPDATE'), has_table_privilege('anon', 'public.plan_chat_daily_usage', 'DELETE');")" \
  "t|t|t"
migrate "B2 the migration applies ON TOP of the stopgap: nothing errors on a missing policy or an already-revoked privilege"
suite "b"

# ══ C. from state (c): the migration's own result ════════════════════════
migrate "C0 the migration applies a second time (idempotent)"
case "$APPLY_OUT" in
  *"dropped policy"*) fail "C1 the second run drops nothing (it found its own end state)" "$(echo "$APPLY_OUT" | grep 'dropped policy' | head -3)" ;;
  *) pass "C1 the second run drops nothing (it found its own end state)" ;;
esac
suite "c"

# ══ D. from state (d): locked, then re-opened by hand under other names ══
out="$(state_d)"
check "D0 state (d) is built on the migration's result: a FOR ALL policy, a permissive read, a column-level grant, RLS off on a meter, anon re-granted" \
  "$out|$(sql "select string_agg(policyname || ' [' || cmd || ']', ',' order by policyname) from pg_policies where schemaname = 'public' and tablename = 'subscriptions';")|$(sql "select has_column_privilege('authenticated', 'public.subscriptions', 'tier', 'UPDATE'), has_table_privilege('authenticated', 'public.subscriptions', 'UPDATE'), (select relrowsecurity from pg_class where oid = 'public.plan_chat_daily_usage'::regclass), has_table_privilege('anon', 'public.founding_members', 'INSERT');")" \
  "|billing can write [ALL],everyone reads plans [SELECT],subscriptions self select [SELECT]|t|f|f|t"
baseline
fire PATCH "$VIC" user '{"tier":"multi","status":"active"}'
check "D1 in state (d) the hole is OPEN again, and wider: the attacker PATCHes ANOTHER user's tier → multi" \
  "$HTTP_STATUS $(show "$V" | cut -d' ' -f1-5)" "200 multi / professional / active"
req GET "/rest/v1/subscriptions?select=user_id" "$ATK_TOKEN"
check_has "D1b … and reads every user's plan row (the permissive read)" "$HTTP_STATUS $HTTP_BODY" "$V"
migrate "D2 the migration applies over the hand-made openings, with no error and no warning"
check_has "D3 … and names the FOR ALL policy it dropped" "$APPLY_OUT" 'dropped policy "billing can write" (ALL) on public.subscriptions'
check_has "D3b … and the permissive read — a second SELECT policy on subscriptions goes too" "$APPLY_OUT" 'dropped policy "everyone reads plans" (SELECT) on public.subscriptions'
check_has "D3c … and the hand-made UPDATE policy on a meter" "$APPLY_OUT" 'dropped policy "users write own usage" (UPDATE) on public.user_usage'
suite "d"

# ══ E. both orders against schema_phase_owner_plan.sql ═══════════════════
if [ -f "$OWNER_PLAN_MIGRATION" ]; then
  apply_file "$OWNER_PLAN_MIGRATION"; rc=$?
  check "E0 schema_phase_owner_plan.sql applies AFTER the lockdown" "$rc" "0"
  got=""
  for t in $ALL_TABLES; do got="$got$(catalog_of "$t" | sed 's/ public=.*//; s/rls=true non-select-policies=0 //') "; done
  check "E1 … and re-opens nothing: every listed table, plan_assignment_audit included, is closed" "$got" \
    "anon=- authenticated=SELECT anon=- authenticated=SELECT anon=- authenticated=SELECT anon=- authenticated=- anon=- authenticated=- anon=- authenticated=- anon=- authenticated=- "
  baseline; before="$(fp "$A")"
  fire PATCH "$OWN" user '{"tier":"multi","status":"active"}'
  check "E2 … a signed-in user's PATCH is still refused, the row unchanged" \
    "$HTTP_STATUS $( [ "$before" = "$(fp "$A")" ] && echo unchanged || echo CHANGED )" "403 unchanged"
  migrate "E3 the lockdown applies AFTER schema_phase_owner_plan.sql (the other order)"
  check "E4 … and plan_assignment_audit is on its list: closed, row level security on" \
    "$(catalog_of plan_assignment_audit)" "rls=true non-select-policies=0 anon=- authenticated=- public=-"
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
  "$(policies_of_subscriptions)|$(catalog_of subscriptions)" \
  "$ONE_POLICY|rls=true non-select-policies=0 anon=- authenticated=SELECT public=-"

echo "GATE-WORK $GATE units=$UNITS"
[ "$SKIPS" -gt 0 ] && echo "SKIPPED $SKIPS case(s) — NOT passes: they need an object schema_phase_owner_plan.sql creates"
if [ "$FAILS" -gt 0 ]; then
  echo "SUBSCRIPTIONS-WRITE-LOCKDOWN GATE: FAIL — $FAILS of $UNITS case(s) failed"
  exit 1
fi
echo "SUBSCRIPTIONS-WRITE-LOCKDOWN GATE: PASS — $UNITS case(s), $SKIPS skipped, users removed, the tables left closed"
exit 0
