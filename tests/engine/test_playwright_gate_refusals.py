"""The playwright gate refuses before it runs — and says why.

OWNER RULING 2026-10-02. With nothing listening on the dev server's port the
gate ran the whole suite anyway and printed "353 ran, 349 failing (new 178)":
a verdict on the product that was really "nothing on :5173". It now probes
the app and the engine's /health first; either one silent is a refusal that
NAMES it, and no test is run. An unknown flag is refused too — the script had
no --help, so any flag it did not know ran the whole suite.

Everything here runs the REAL script (``node scripts/check_playwright.mjs``)
against local recorders on free ports. No browser, no suite: every case ends
at a refusal, or at ``--probe``.

WHAT THIS FILE REDS ON (TC-11)
  · the gate starting the runner (or printing a failure count) with the app
    or the engine not answering;
  · the refusal not naming which origin was silent;
  · an engine that answers /health with an error being taken for a stack;
  · an unknown flag running anything;
  · a non-local engine origin being probed;
  · the committed baseline holding a key twice.
WHAT IT CANNOT SEE
  · that the stack answering is the commit under test, or that it points at
    the local test Supabase — the operator's (CLAUDE.md §27 guards the
    second: test mode refuses a hosted project at boot);
  · the suite itself: nothing here runs a test.
"""
from __future__ import annotations

import http.server
import os
import re
import shutil
import signal
import socket
import subprocess
import threading
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = "scripts/check_playwright.mjs"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(
    NODE is None, reason="node is not installed: the playwright gate's refusals cannot be executed here")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _Recorder:
    """A local HTTP server that answers every GET with one status and
    records the paths it was asked for."""

    def __init__(self, status: int = 200):
        self.paths = []
        recorder = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                recorder.paths.append(self.path)
                self.send_response(status)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()

    @property
    def origin(self) -> str:
        return "http://127.0.0.1:%d" % self.port


def _run(args, env_extra, timeout=40):
    """Run the real gate. Every case here ends at a refusal (or at --probe)
    within seconds; a gate still running after ``timeout`` has started the
    runner, which is the defect — its whole process group is killed (the
    runner and its browsers are grandchildren) and the test fails."""
    env = dict(os.environ)
    env.pop("E2E_BASE_URL", None)
    env.pop("E2E_ENGINE_URL", None)
    env.update(env_extra)
    t0 = time.monotonic()
    proc = subprocess.Popen([NODE, SCRIPT] + list(args), cwd=REPO, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, start_new_session=True)
    try:
        out, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate()
        pytest.fail("the gate was still running after %ss with %r — it did not "
                    "refuse, it started the runner" % (timeout, list(args)))
    return proc.returncode, out, time.monotonic() - t0


def _no_suite_ran(out: str) -> None:
    assert "GATE-WORK playwright units=" not in out, out
    # no count of tests run or failing — the words alone appear in the usage text
    assert not re.search(r"\d+ (ran|failing|skipped|known failure)", out), out
    assert "wrote design_review/PLAYWRIGHT_BASELINE.txt" not in out, out


def test_nothing_listening_is_stack_not_running_never_a_failure_count():
    web, api = _free_port(), _free_port()
    code, out, took = _run([], {"E2E_BASE_URL": "http://127.0.0.1:%d" % web,
                                "E2E_ENGINE_URL": "http://127.0.0.1:%d" % api})
    assert code == 1, out
    assert "REFUSED — STACK NOT RUNNING" in out, out
    assert "the app at http://127.0.0.1:%d" % web in out, out
    assert "the engine at http://127.0.0.1:%d/health" % api in out, out
    assert "GATE-WORK playwright-stack answering=0" in out, out
    _no_suite_ran(out)
    assert took < 30, took


def test_the_app_alone_is_not_a_stack_and_the_refusal_names_the_engine():
    with _Recorder() as web:
        api = _free_port()
        code, out, _ = _run([], {"E2E_BASE_URL": web.origin,
                                 "E2E_ENGINE_URL": "http://127.0.0.1:%d" % api})
    assert code == 1, out
    assert "REFUSED — STACK NOT RUNNING" in out
    assert "the engine at http://127.0.0.1:%d/health" % api in out, out
    assert "the app at" not in out, out
    _no_suite_ran(out)


def test_the_engine_alone_is_not_a_stack_and_the_refusal_names_the_app():
    with _Recorder() as api:
        web = _free_port()
        code, out, _ = _run([], {"E2E_BASE_URL": "http://127.0.0.1:%d" % web,
                                 "E2E_ENGINE_URL": api.origin})
        assert api.paths == ["/health"], api.paths
    assert code == 1, out
    assert "the app at http://127.0.0.1:%d" % web in out, out
    assert "the engine at" not in out, out
    _no_suite_ran(out)


def test_an_engine_whose_health_answers_an_error_is_not_a_stack():
    with _Recorder() as web, _Recorder(status=503) as api:
        code, out, _ = _run([], {"E2E_BASE_URL": web.origin, "E2E_ENGINE_URL": api.origin})
    assert code == 1, out
    assert "REFUSED — STACK NOT RUNNING" in out
    assert "answered HTTP 503" in out, out
    _no_suite_ran(out)


def test_write_baseline_is_refused_the_same_way_and_writes_nothing():
    baseline = REPO / "design_review" / "PLAYWRIGHT_BASELINE.txt"
    before = baseline.read_bytes()
    code, out, _ = _run(["--write-baseline"],
                        {"E2E_BASE_URL": "http://127.0.0.1:%d" % _free_port(),
                         "E2E_ENGINE_URL": "http://127.0.0.1:%d" % _free_port()})
    assert code == 1 and "REFUSED — STACK NOT RUNNING" in out, out
    assert baseline.read_bytes() == before
    _no_suite_ran(out)


def test_probe_on_an_answering_stack_says_so_and_runs_no_test():
    with _Recorder() as web, _Recorder() as api:
        code, out, took = _run(["--probe"], {"E2E_BASE_URL": web.origin,
                                             "E2E_ENGINE_URL": api.origin})
        assert api.paths == ["/health"], api.paths
        assert len(web.paths) == 1, web.paths
    assert code == 0, out
    assert "GATE-WORK playwright-stack answering=2" in out, out
    assert "No test was run." in out
    _no_suite_ran(out)
    assert took < 30, took


def test_an_unknown_flag_is_refused_and_runs_nothing():
    with _Recorder() as web, _Recorder() as api:
        for flag in ("--help", "--list", "--write-baselin"):
            code, out, took = _run([flag], {"E2E_BASE_URL": web.origin,
                                            "E2E_ENGINE_URL": api.origin})
            assert code == 1, (flag, out)
            assert "REFUSED — unknown argument(s): %s" % flag in out, (flag, out)
            _no_suite_ran(out)
            assert took < 30, (flag, took)
        # refused before the probe: neither origin was asked anything
        assert web.paths == [] and api.paths == []


def test_a_non_local_engine_origin_is_refused_not_probed():
    with _Recorder() as web:
        code, out, _ = _run([], {"E2E_BASE_URL": web.origin,
                                 "E2E_ENGINE_URL": "https://engine.example.invalid"})
        assert web.paths == [], web.paths
    assert code == 1, out
    assert "REFUSED — E2E_ENGINE_URL is" in out and "local one only" in out, out
    _no_suite_ran(out)


def test_the_baseline_file_holds_each_key_once():
    lines = [l for l in (REPO / "design_review" / "PLAYWRIGHT_BASELINE.txt")
             .read_text(encoding="utf-8").splitlines() if l]
    assert lines, "the baseline is empty"
    twice = sorted({l for l in lines if lines.count(l) > 1})
    assert not twice, "keys recorded more than once: %s" % twice[:5]
    src = (REPO / SCRIPT).read_text(encoding="utf-8")
    assert "[...new Set(failures)]" in src, "the writer no longer records distinct keys"
