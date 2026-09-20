#!/bin/sh
# Every migration in supabase/ is applied in the database production uses.
#
# The migrations live in the repo; the service-role key lives in the
# container. Neither machine has both, so the declarations are parsed here
# and probed there. See check_migrations_applied.py for what is verified
# (tables and columns, exactly) and what is not (indexes, policies,
# constraints, functions — PostgREST cannot see them, and they are reported
# rather than assumed).
set -e
# `python3 -` would read the PROGRAM from stdin, so the emitted JSON ran as a
# do-nothing expression: no output, exit 0, whatever the database held
# (2026-09-15). The probe script ships in the image at /app/scripts and
# reads the declarations from stdin. tests/engine/test_migrations_probe_invocation.py.
HOST="${DEPLOY_HOST:-root@187.124.0.37}"
CONTAINER="${DEPLOY_CONTAINER:-cfo-ai-backend}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$ROOT/scripts/check_migrations_applied.py" --emit \
  | ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" \
      "docker exec -i $CONTAINER python3 /app/scripts/check_migrations_applied.py --probe"
