"""The deploy one-liner must actually run the probe.

Until 2026-09-15 scripts/check_migrations_applied.sh piped the emitted JSON
into ``docker exec ... python3 - --probe``. ``python3 -`` reads the PROGRAM
from stdin, so the JSON declarations were executed as a single do-nothing
dict expression: no output, exit status 0, for any database. Two operator
reports then disagreed about whether a migration was applied.

This gate runs the real shell wrapper end to end with a fake ``ssh`` on PATH
that executes the remote command locally with ``docker exec -i <container>``
removed and ``/app/`` mapped to this checkout. No database is reachable from
the test (Supabase variables are removed), so the probe prints its own
refusal; what the gate asserts is the part that was broken: the wrapper hands
the declarations to the probe PROGRAM, which prints something, never nothing.

Plant (2026-09-15): restoring ``python3 - --probe`` in the wrapper reds
test_the_wrapper_hands_the_declarations_to_the_probe_program with
"the migrations probe printed nothing (exit 0)".

Reds after repair on: any invocation that makes the remote side print
nothing (the vacuous ``python3 -`` form, a wrong path, a swallowed stdin).
Scope: the wrapper and its handoff only; the probe's schema logic is gated
elsewhere.
"""
from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _fake_ssh(tmp_path: Path) -> Path:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    ssh = bindir / "ssh"
    ssh.write_text(
        "#!/bin/sh\n"
        "# last argument is the remote command\n"
        "for a; do cmd=$a; done\n"
        "cmd=$(printf '%s' \"$cmd\" | sed -e 's/docker exec -i [^ ]* //' -e 's#/app/#" + str(ROOT) + "/#g')\n"
        "exec sh -c \"$cmd\"\n"
    )
    ssh.chmod(ssh.stat().st_mode | stat.S_IEXEC)
    return bindir


def _run(tmp_path: Path, script: Path) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PATH"] = str(_fake_ssh(tmp_path)) + os.pathsep + env.get("PATH", "")
    # The probe must not reach a real database from a test.
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"):
        env.pop(k, None)
    env["DEPLOY_HOST"] = "nobody@invalid.test"
    return subprocess.run(["sh", str(script)], cwd=str(ROOT), env=env,
                          capture_output=True, text=True, timeout=120)


def test_the_wrapper_hands_the_declarations_to_the_probe_program(tmp_path):
    proc = _run(tmp_path, ROOT / "scripts" / "check_migrations_applied.sh")
    out = (proc.stdout or "") + (proc.stderr or "")
    assert out.strip(), (
        "the migrations probe printed nothing (exit %s): the remote side did not "
        "run the probe program — the vacuous `python3 -` handoff" % proc.returncode)
    assert "python3 - --probe" not in (ROOT / "scripts" / "check_migrations_applied.sh").read_text()


def test_the_vacuous_form_is_what_this_gate_catches(tmp_path):
    # Non-vacuity (TC-3): the old invocation, run through the same fake ssh,
    # prints nothing and exits 0 — exactly the false green.
    old = tmp_path / "old.sh"
    text = (ROOT / "scripts" / "check_migrations_applied.sh").read_text().replace(
        "python3 /app/scripts/check_migrations_applied.py --probe", "python3 - --probe")
    old.write_text(text.replace('ROOT="$(cd "$(dirname "$0")/.." && pwd)"', 'ROOT="%s"' % ROOT))
    proc = _run(tmp_path, old)
    assert proc.returncode == 0 and not ((proc.stdout or "") + (proc.stderr or "")).strip()
