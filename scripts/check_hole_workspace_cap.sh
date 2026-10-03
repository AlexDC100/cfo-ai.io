#!/usr/bin/env bash
# HOLE-WORKSPACE-CAP GATE — supabase/schema_phase_workspace_cap_guard.sql
#
# The hole (measured 2026-10-03): a trial user (workspace cap 1) reached 2, 3
# … live workspaces without touching the plan row — (i) PATCH
# organizations.archived_at on their own workspace, create_workspace, PATCH it
# back; (ii) archive_workspace, create_workspace, restore_workspace (which
# never re-checked the cap). purge_after, firm_id and cui were writable by a
# member the same way — firm_id to ANOTHER tenant's firm.
#
# What it proves, one PASS/FAIL line per case, in a scratch database built
# from this repository's SQL (scripts/entitlement_holes/lib.sh):
#   OPEN   on the fresh schema the report says "hole_open": true and both
#          paths LAND (2 live workspaces on a 1-workspace plan), and a member
#          attaches their workspace to another user's firm;
#   RUN 1  the migration applies as one batch; create_workspace,
#          restore_workspace and archive_workspace are BYTE-IDENTICAL before
#          and after (the cap numbers are not this file's to touch); the
#          report says "hole_open": false; a direct write of archived_at,
#          purge_after, firm_id or cui is refused and the row is unchanged;
#          restore at the cap is refused with create_workspace's OWN message;
#          and everything legitimate still works — rename / industry / CAEN
#          with the user's JWT, archive, restore under the cap, purge, the
#          firm functions, the service role's un-archive (the workspace
#          migration's rollback), the SQL editor, a paid plan's restore;
#          the user who was ALREADY over the cap keeps every workspace;
#          the cap probe leaves no workspace behind;
#   RUN 2  a second run changes nothing and says so; still closed;
#   OLD FILES RE-RUN  schema_phase_multi_workspace.sql and
#          schema_phase_archive_hold_guard.sql (they re-create
#          restore_workspace) do NOT re-open it — the cap is on the table;
#   RE-OPENED BY HAND  the trigger disabled; then dropped and its function
#          gutted — shown OPEN again each time, then closed by the migration.
#
# Path (iii) — create_firm → import_firm_client ×N → detach — is NOT closed
# (the owner's ruling). The gate prints what it measures there as a NOTE,
# which is neither a pass nor a fail.
#
# WHAT IT CANNOT SEE. PostgREST itself (a PATCH is reproduced as the UPDATE it
# is, in an `authenticator` session with the role and the claims PostgREST
# sets); production's own create_workspace (the guard asks whatever is
# installed — here, this repository's); a NEW SECURITY DEFINER function that
# un-archives for a service-role caller on a user's behalf (the service role
# is not asked for a cap); a superuser or the table's owner disabling the
# trigger (the preflight report is what sees that, and the last block here).
#
# LOCAL ONLY, never by default: see scripts/entitlement_holes/lib.sh.
#   ENTITLEMENT_HOLES_DB_URL=postgresql://postgres:postgres@127.0.0.1:<port>/<db> \
#   [ENTITLEMENT_HOLES_DB_CONTAINER=<container>] scripts/check_hole_workspace_cap.sh
#   HOLE_MIGRATION=<a planted copy>   apply that file instead (plants)
# Exit: 0 every case passed (or VACUOUS) · 1 a case failed · 2 refused.

set -u
set -o pipefail
GATE="hole-workspace-cap"
# shellcheck source=scripts/entitlement_holes/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/entitlement_holes/lib.sh"

MIGRATION="${HOLE_MIGRATION:-$HOLES_SQL_DIR/schema_phase_workspace_cap_guard.sql}"
REPORT_SQL="$HOLES_SQL_DIR/preflight/schema_phase_workspace_cap_guard_preflight_report.sql"

echo "HOLE-WORKSPACE-CAP GATE — $(basename "$MIGRATION")"
holes_connect
[ -f "$MIGRATION" ] || holes_die "the migration file does not exist: $MIGRATION"
[ -f "$REPORT_SQL" ] || holes_die "the preflight report does not exist: $REPORT_SQL"
holes_build_scratch h1

uid() { printf '%s0000000-0000-4000-8000-0000000000%s' "$1" "$2"; }
U_I="$(uid a 01)";  U_II="$(uid a 02)"; U_FIRMOWNER="$(uid a 03)"
U_C1="$(uid b 01)"; U_C2="$(uid b 02)"; U_C3="$(uid b 03)"; U_PRO="$(uid b 04)"; U_SVC="$(uid b 05)"
U_R1="$(uid c 01)"; U_R2="$(uid c 02)"; U_H1="$(uid d 01)"; U_H2="$(uid d 02)"; U_H3="$(uid d 03)"
U_III="$(uid e 01)"
n=0
for u in "$U_I" "$U_II" "$U_FIRMOWNER" "$U_C1" "$U_C2" "$U_C3" "$U_PRO" "$U_SVC" "$U_R1" "$U_R2" "$U_H1" "$U_H2" "$U_H3" "$U_III"; do
  n=$((n + 1)); new_user "$u" "h1-user-$n"
done

live()     { q "select count(*) from memberships m join organizations o on o.id = m.org_id where m.user_id = '$1' and o.archived_at is null;"; }
archived() { q "select count(*) from memberships m join organizations o on o.id = m.org_id where m.user_id = '$1' and o.archived_at is not null;"; }
first_org() { q "select m.org_id from memberships m join organizations o on o.id = m.org_id where m.user_id = '$1' order by o.created_at, o.id limit 1;"; }
org_row()  { q "select coalesce(archived_at::text, 'live') || '|' || coalesce(purge_after::text, '-') || '|' || coalesce(firm_id::text, '-') || '|' || coalesce(cui, '-') from organizations where id = '$1';"; }
fn_md5()   { q "select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), ' ' order by p.oid::regprocedure::text) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('create_workspace', 'restore_workspace', 'archive_workspace');"; }
report_says() { # label want-hole_open
  run_report "$REPORT_SQL"
  if [ "$REPORT_RC" != 0 ]; then fail "$1" "the report failed: $REPORT"; return; fi
  check "$1" "$(jget "$REPORT" '{hole_open}')" "$2"
}

# The two attacks, as the requests they are. Each leaves the user with as
# many live workspaces as the database let them have.
attack_i() { # user → PATCH archived_at, create, PATCH back
  local u="$1" org; org="$(first_org "$u")"
  ATTACK_OUT="$(sql_as authenticated "$u" "update organizations set archived_at = now() where id = '$org';")"
  ATTACK_OUT="$ATTACK_OUT
$(sql_as authenticated "$u" "select create_workspace('second, behind a hand-archived first');")"
  ATTACK_OUT="$ATTACK_OUT
$(sql_as authenticated "$u" "update organizations set archived_at = null where id = '$org';")"
}
attack_ii() { # user → archive (RPC), create, restore (RPC)
  local u="$1" org; org="$(first_org "$u")"
  sql_as authenticated "$u" "select archive_workspace('$org');" >/dev/null
  sql_as authenticated "$u" "select create_workspace('second, behind an archived first');" >/dev/null
  ATTACK_OUT="$(sql_as authenticated "$u" "select restore_workspace('$org');")"
}

closed_checks() { # tag user-for-(i) user-for-(ii)
  local tag="$1" ui="$2" uii="$3" org before out
  org="$(first_org "$ui")"; before="$(org_row "$org")"
  out="$(sql_as authenticated "$ui" "update organizations set archived_at = now() where id = '$org';")"
  check_has "$tag (i) a member's direct write of archived_at is refused" "$out" "organizations.archived_at is not writable directly"
  out="$(sql_as authenticated "$ui" "update organizations set purge_after = now() + interval '10 years' where id = '$org';")"
  check_has "$tag (i) … of purge_after" "$out" "organizations.purge_after is not writable directly"
  out="$(sql_as authenticated "$ui" "update organizations set firm_id = '$FIRM' where id = '$org';")"
  check_has "$tag (i) … of firm_id (another tenant's firm)" "$out" "organizations.firm_id is not writable directly"
  out="$(sql_as authenticated "$ui" "update organizations set cui = 'RO00000000' where id = '$org';")"
  check_has "$tag (i) … of cui" "$out" "organizations.cui is not writable directly"
  out="$(sql_as authenticated "$ui" "update organizations set name = 'renamed with an archive smuggled in', archived_at = now() where id = '$org';")"
  check_has "$tag (i) … of archived_at beside a legitimate column in one PATCH" "$out" "organizations.archived_at is not writable directly"
  check "$tag (i) the workspace row is byte-identical after every refused write" "$(org_row "$org")" "$before"
  check "$tag (i) the user still has exactly 1 live workspace" "$(live "$ui")" "1"
  out="$(sql_as authenticated "$ui" "select create_workspace('a second one');")"
  check_has "$tag (i) … and create_workspace still refuses the second" "$out" "workspace_cap_reached: your trial plan allows 1 workspace(s)"

  attack_ii "$uii"
  check_has "$tag (ii) restore_workspace at the cap is refused with create_workspace's own message" "$ATTACK_OUT" "workspace_cap_reached: your trial plan allows 1 workspace(s). Upgrade to add more."
  check "$tag (ii) the user has exactly 1 live workspace" "$(live "$uii")" "1"
  check "$tag (ii) … and the archived one is still archived, in its recovery window" "$(q "select count(*) from memberships m join organizations o on o.id = m.org_id where m.user_id = '$uii' and o.archived_at is not null and o.purge_after is not null;")" "1"
  check "$tag the cap probe left no workspace behind" "$(q "select count(*) from organizations where name like 'workspace cap probe%';")" "0"
}

# ── OPEN: the fresh schema ───────────────────────────────────────────────
echo "── OPEN — the schema this repository's other files build"
FIRM="$(sql_as authenticated "$U_FIRMOWNER" "select create_firm('Another tenant''s accounting firm');")"
case "$FIRM" in ????????-????-????-????-????????????) pass "O0 a firm exists for the cross-tenant case (create_firm)";;
  *) fail "O0 a firm exists for the cross-tenant case (create_firm)" "got: $FIRM";; esac
report_says "O1 the report on the fresh schema says hole_open: true" "true"
check "O1b … direct_write_open" "$(jget "$REPORT" '{direct_write_open}')" "true"
check "O1c … restore_uncapped" "$(jget "$REPORT" '{restore_uncapped}')" "true"
out="$(sql_as authenticated "$U_I" "select create_workspace('a second one');")"
check_has "O2 control: a trial user's SECOND workspace is refused by create_workspace" "$out" "workspace_cap_reached: your trial plan allows 1 workspace(s)"
attack_i "$U_I"
check "O3 OPEN (i): PATCH archived_at → create → PATCH back = 2 live workspaces on a 1-workspace plan" "$(live "$U_I")" "2"
attack_ii "$U_II"
check "O4 OPEN (ii): archive → create → restore = 2 live workspaces on a 1-workspace plan" "$(live "$U_II")" "2"
ORG_I="$(first_org "$U_I")"
sql_as authenticated "$U_I" "update organizations set firm_id = '$FIRM', cui = 'RO12345678' where id = '$ORG_I';" >/dev/null
check "O5 OPEN: a member attaches their workspace to ANOTHER tenant's firm with a direct write" "$(q "select firm_id::text || '|' || cui from organizations where id = '$ORG_I';")" "$FIRM|RO12345678"
q "update organizations set firm_id = null, cui = null where id = '$ORG_I';" >/dev/null

# ── RUN 1 ────────────────────────────────────────────────────────────────
echo "── RUN 1 — the migration, one batch"
MD5_BEFORE="$(fn_md5)"
apply_migration "$MIGRATION"
check "M1 the migration applies (exit 0)" "$MIG_RC" "0"
[ "$MIG_RC" = 0 ] || echo "     | $MIG_OUT"
check "M2 its last statement names the file" "$(jget "$MIG_RESULT" '{migration}')" "schema_phase_workspace_cap_guard.sql"
check_has "M3 … and says the guard function was created" "$MIG_RESULT" "_organizations_guard_write(): created"
check_has "M4 … and the trigger" "$MIG_RESULT" "trigger organizations_guard_write created"
check "M5 … and that no workspace function body changed" "$(jget "$MIG_RESULT" '{workspace_function_bodies_unchanged}')" "true"
check "M6 create_workspace, restore_workspace and archive_workspace are byte-identical (md5 of each, read by the gate)" "$(fn_md5)" "$MD5_BEFORE"
check_has "M6b … and create_workspace is among them" "$MD5_BEFORE" "create_workspace(text,text,text)="
report_says "C1 the report after the migration says hole_open: false" "false"
check "C1b … guard_in_place (the trigger runs exactly the body the report expects)" "$(jget "$REPORT" '{guard_in_place}')" "true"
closed_checks "C2" "$U_C1" "$U_C2"

echo "   legitimate paths"
ORG_C3="$(first_org "$U_C3")"
out="$(sql_as authenticated "$U_C3" "update organizations set name = 'Renamed SRL', industry_key = 'food_manufacturing', industry_display_name = 'Food manufacturing', caen_code = '1013' where id = '$ORG_C3' returning name || '|' || industry_key || '|' || caen_code;")"
check "C3 a member renames the workspace and sets its industry and CAEN with their own JWT" "$out" "Renamed SRL|food_manufacturing|1013"
out="$(sql_as authenticated "$U_C3" "select archive_workspace('$ORG_C3') is not null;")"
check "C4 archive_workspace still archives" "$out|$(live "$U_C3")|$(archived "$U_C3")" "t|0|1"
out="$(sql_as authenticated "$U_C3" "select restore_workspace('$ORG_C3');")"
check "C5 restore_workspace UNDER the cap is allowed (0 live → 1)" "$(live "$U_C3")|$(archived "$U_C3")" "1|0"
# The cap-holder who archives the live one may restore the first: still 1 live.
ORG_C2_LIVE="$(q "select m.org_id from memberships m join organizations o on o.id = m.org_id where m.user_id = '$U_C2' and o.archived_at is null limit 1;")"
ORG_C2_ARCH="$(q "select m.org_id from memberships m join organizations o on o.id = m.org_id where m.user_id = '$U_C2' and o.archived_at is not null limit 1;")"
sql_as authenticated "$U_C2" "select archive_workspace('$ORG_C2_LIVE');" >/dev/null
out="$(sql_as authenticated "$U_C2" "select restore_workspace('$ORG_C2_ARCH');")"
check "C6 at the cap: archive the live one, then restore the other — allowed, still 1 live" "$(live "$U_C2")|$(archived "$U_C2")" "1|1"
out="$(sql_as authenticated "$U_C2" "select purge_workspace('$ORG_C2_LIVE');" 2>&1)"
check "C7 purge_workspace (\"Delete forever\") still erases an archived workspace" "$(q "select count(*) from organizations where id = '$ORG_C2_LIVE';")" "0"
# A paid plan: the cap create_workspace reads for it is the cap on a restore.
q "update subscriptions set tier = 'pro' where user_id = '$U_PRO';" >/dev/null
ORG_PRO="$(first_org "$U_PRO")"
sql_as authenticated "$U_PRO" "select create_workspace('pro second'); select create_workspace('pro third');" >/dev/null
sql_as authenticated "$U_PRO" "select archive_workspace('$ORG_PRO');" >/dev/null
out="$(sql_as authenticated "$U_PRO" "select restore_workspace('$ORG_PRO');")"
check "C8 a paid plan restores within ITS cap (tier pro: 2 live + 1 restored = 3)" "$(live "$U_PRO")" "3"
# The service role: the workspace migration and its rollback archive and
# un-archive through PostgREST as the service role. Not capped, not refused.
ORG_SVC="$(first_org "$U_SVC")"
sql_as authenticated "$U_SVC" "select archive_workspace('$ORG_SVC');" >/dev/null
sql_as authenticated "$U_SVC" "select create_workspace('the one that fills the cap');" >/dev/null
out="$(sql_as service_role "" "update organizations set archived_at = null, purge_after = null where id = '$ORG_SVC';")"
check "C9 the service role un-archives with a direct write, whatever the owner's cap (the migration's rollback)" "$(live "$U_SVC")" "2"
out="$(sql_as service_role "" "update organizations set archived_at = now(), purge_after = null where id = '$ORG_SVC';")"
check "C10 … and archives one as HELD (no deletion date)" "$(q "select (archived_at is not null and purge_after is null)::text from organizations where id = '$ORG_SVC';")" "true"
check "C11 the SQL editor (the table's owner, no JWT) writes the columns" "$(q "update organizations set archived_at = null where id = '$ORG_SVC' returning (archived_at is null)::text;")" "true"
# The firm functions are SECURITY DEFINER: they change firm_id and pass.
ORG_FO="$(first_org "$U_FIRMOWNER")"
out="$(sql_as authenticated "$U_FIRMOWNER" "select attach_workspace_to_firm('$ORG_FO', '$FIRM');")"
check "C12 attach_workspace_to_firm (a firm function) still sets firm_id" "$(q "select firm_id::text from organizations where id = '$ORG_FO';")" "$FIRM"
out="$(sql_as authenticated "$U_FIRMOWNER" "select detach_workspace_from_firm('$ORG_FO');")"
check "C13 detach_workspace_from_firm still clears it" "$(q "select coalesce(firm_id::text, 'null') from organizations where id = '$ORG_FO';")" "null"
# The user who was over the cap BEFORE the migration: nothing of theirs moved.
check "C14 the user who was already over the cap keeps both workspaces (no row altered)" "$(live "$U_I")|$(live "$U_II")" "2|2"
out="$(sql_as authenticated "$U_I" "update organizations set name = 'still mine' where id = '$ORG_I' returning name;")"
check "C15 … and still renames them" "$out" "still mine"
check "C16 the report counts them, and names nobody" "$(run_report "$REPORT_SQL"; jget "$REPORT" '{users_over_their_cap}')" "$(q "select count(*) from (select m.user_id from memberships m join organizations o on o.id = m.org_id left join subscriptions s on s.user_id = m.user_id where o.archived_at is null group by m.user_id, s.tier having count(*) > case lower(coalesce(s.tier, '')) when 'pro' then 5 else 1 end) x;")"
check_lacks "C16b … (no user id in the report)" "$REPORT" "$U_I"
check "C17 the cap probe left no workspace behind" "$(q "select count(*) from organizations where name like 'workspace cap probe%';")" "0"

# ── RUN 2 ────────────────────────────────────────────────────────────────
echo "── RUN 2 — the same file again (statement by statement)"
apply_migration "$MIGRATION" autocommit
check "R1 the second run applies (exit 0)" "$MIG_RC" "0"
check "R2 … and changes nothing" "$(jget "$MIG_RESULT" '{changed_count}')" "0"
check "R3 the workspace functions are still byte-identical" "$(fn_md5)" "$MD5_BEFORE"
report_says "R4 still hole_open: false" "false"
closed_checks "R5" "$U_R1" "$U_R2"

# ── the old files, re-run ────────────────────────────────────────────────
echo "── OLD FILES RE-RUN — they re-create restore_workspace; the cap is not in it"
holes_psql "$HOLES_DB" --single-transaction -f - < "$HOLES_SQL_DIR/schema_phase_multi_workspace.sql" >/dev/null 2>&1
holes_psql "$HOLES_DB" --single-transaction -f - < "$HOLES_SQL_DIR/schema_phase_allow_delete_last_workspace.sql" >/dev/null 2>&1
holes_psql "$HOLES_DB" --single-transaction -f - < "$HOLES_SQL_DIR/schema_phase_archive_hold_guard.sql" >/dev/null 2>&1
holes_psql "$HOLES_DB" --single-transaction -f - < "$HOLES_SQL_DIR/schema_phase_plan_caps.sql" >/dev/null 2>&1
report_says "F1 after re-running the four files that define the workspace functions: still hole_open: false" "false"
attack_ii "$U_H1"
check_has "F2 … and restore at the cap is still refused" "$ATTACK_OUT" "workspace_cap_reached"
check "F3 … 1 live workspace" "$(live "$U_H1")" "1"

# ── RE-OPENED BY HAND ────────────────────────────────────────────────────
echo "── RE-OPENED BY HAND — the trigger disabled; then dropped and its function gutted"
q "alter table public.organizations disable trigger organizations_guard_write;" >/dev/null
report_says "H1 with the trigger DISABLED the report says hole_open: true" "true"
attack_i "$U_H2"
check "H2 OPEN AGAIN (i): 2 live workspaces on a 1-workspace plan" "$(live "$U_H2")" "2"
apply_migration "$MIGRATION"
check_has "H3 the migration says it enabled the trigger" "$MIG_RESULT" "trigger organizations_guard_write enabled (it was DISABLED)"
report_says "H4 the report says hole_open: false" "false"
q "drop trigger organizations_guard_write on public.organizations;
   create or replace function public._organizations_guard_write() returns trigger language plpgsql as \$g\$ begin return new; end \$g\$;
   create trigger organizations_guard_write before update on public.organizations for each row execute function public._organizations_guard_write();" >/dev/null
report_says "H5 with the guard function GUTTED (the trigger still there, enabled) the report says hole_open: true" "true"
attack_ii "$U_H3"
check "H6 OPEN AGAIN (ii): 2 live workspaces on a 1-workspace plan" "$(live "$U_H3")" "2"
apply_migration "$MIGRATION"
check "H7 the migration applies on the re-opened database (exit 0)" "$MIG_RC" "0"
check_has "H8 … and says it replaced the guard's body" "$MIG_RESULT" "_organizations_guard_write(): body replaced"
report_says "H9 the report says hole_open: false" "false"
out="$(sql_as authenticated "$U_H1" "update organizations set archived_at = now() where id = '$(first_org "$U_H1")';")"
check_has "H10 a direct write of archived_at is refused again" "$out" "not writable directly"
check "H11 the workspace functions are still byte-identical to the start" "$(fn_md5)" "$MD5_BEFORE"

# ── path (iii): measured, NOT closed ─────────────────────────────────────
FIRM3="$(sql_as authenticated "$U_III" "select create_firm('A firm of one');")"
sql_as authenticated "$U_III" "select import_firm_client('$FIRM3', 'Client One SRL', 'RO90000001', null, null, null, null, '{}'::jsonb);
select import_firm_client('$FIRM3', 'Client Two SRL', 'RO90000002', null, null, null, null, '{}'::jsonb);" >/dev/null 2>&1
echo "NOTE path (iii), NOT closed by this migration (the owner's ruling): a trial user who creates a firm and imports 2 clients holds $(live "$U_III") live workspaces (cap 1). Neither a pass nor a fail."

holes_finish
