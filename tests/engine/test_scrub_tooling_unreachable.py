"""History-scrub reachability — proof by absence, in the standard battery.

`scripts/history-scrub/` REWRITES GIT HISTORY. It must be reachable only
by a human who has read `docs/decisions/ADR-corpus-history-sibiu.md` and
decided to run it — never by a push, a cron, a merge, an editable
install, an image build or a pytest collection.

`scripts/check_scrub_tooling_unreachable.py` enforces that. This suite
enforces the ENFORCER, in three layers:

  1. CI parity — the real tree passes, via the same subprocess
     invocation the workflow runs.
  2. The gate BITES — synthetic trees that wire the scrub tooling into a
     workflow, into a script a workflow invokes, into a local git hook,
     into a package.json script and into a Makefile are each caught, at
     the right layer. A control that has never been observed failing is
     not a control.
  3. The gate does not over-reach — a documented prose reference in a
     corpus data payload is reported as a NOTICE and stays green, which
     is what keeps the ADR writable. A gate that fails on its own
     documentation is un-passable by design, and an un-passable gate
     teaches people to ignore it.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from typing import List

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "check_scrub_tooling_unreachable.py"


def _load_checker():
    spec = importlib.util.spec_from_file_location(
        "check_scrub_tooling_unreachable", SCRIPT
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


@pytest.fixture(scope="module")
def checker():
    return _load_checker()


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _install(monkeypatch, checker, root: Path, tracked: List[str]):
    """Point the checker at a synthetic tree with a known file list."""
    monkeypatch.setattr(checker, "REPO", root)
    monkeypatch.setattr(checker, "tracked_paths", lambda: list(tracked))


# ────────────────────────────────────────────────────────────────────
# 1. The real tree passes (CI parity)
# ────────────────────────────────────────────────────────────────────


def test_script_exists():
    assert SCRIPT.is_file(), "the reachability gate itself is missing"


def test_real_tree_has_no_automation_path_to_the_scrub_tooling():
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)],
        cwd=str(REPO), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    out = proc.stdout.decode("utf-8", "replace")
    assert proc.returncode == 0, (
        "an automation path can reach scripts/history-scrub/:\n%s" % out
    )
    assert "SCRUB-TOOLING REACHABILITY: PASS" in out


def test_proof_record_is_auditable():
    """The gate must say WHAT it proved, not merely that it found
    nothing — an unfalsifiable green is worth nothing."""
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), "--json"],
        cwd=str(REPO), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    assert proc.returncode == 0
    import json

    report = json.loads(proc.stdout.decode("utf-8", "replace"))
    assert report["failures"] == []
    # The closure must actually have covered the workflows we care about.
    assert ".github/workflows/tier1-validation.yml" in report["surfaces"]
    assert ".github/workflows/nightly-deep.yml" in report["surfaces"]
    assert report["executable_count"] > 100
    assert report["tracked_count"] > 100


def test_no_workflow_file_names_the_scrub_tooling():
    """Direct, dependency-free restatement of the invariant, so a broken
    checker cannot masquerade as a clean tree."""
    offenders = []
    workflows = REPO / ".github" / "workflows"
    for path in sorted(workflows.glob("*.y*ml")):
        text = path.read_text(encoding="utf-8")
        if "history-scrub" in text or "history_scrub" in text:
            offenders.append(path.name)
    assert offenders == [], "workflow(s) name the scrub tooling: %s" % offenders


def test_gate_name_is_invokable(checker):
    """The gate must be nameable from a workflow WITHOUT tripping itself.

    An earlier draft was called `check_no_history_scrub_automation.py`.
    Its own filename matched the forbidden token, so the moment a
    workflow named it in a `run:` step the workflow became an L1
    violation — the gate made itself un-passable. It caught that on its
    first real run against this repo, which is the point, but the fix
    belongs here as a lock rather than in someone's memory: no file this
    gate needs OTHER automation to reference may contain the token.
    """
    for rel in (
        "scripts/check_scrub_tooling_unreachable.py",
        "tests/engine/test_scrub_tooling_unreachable.py",
    ):
        assert not checker.FORBIDDEN.search(rel), (
            "%s cannot be invoked without tripping the gate it implements" % rel
        )


def test_self_exemptions_point_at_real_files(checker):
    """The only exemptions are the two files that must name the token in
    order to police it. If one is renamed, the exemption must move with
    it — a stale exemption is a silent hole."""
    for rel in checker.SELF_EXEMPT:
        assert (REPO / rel).is_file(), "stale self-exemption: %s" % rel


# ────────────────────────────────────────────────────────────────────
# 2. The gate bites
# ────────────────────────────────────────────────────────────────────


def test_catches_reference_inside_a_workflow(tmp_path, monkeypatch, checker):
    _write(tmp_path, ".github/workflows/ci.yml",
           "jobs:\n  x:\n    steps:\n"
           "      - run: bash scripts/history-scrub/run.sh\n")
    _install(monkeypatch, checker, tmp_path, [".github/workflows/ci.yml"])

    code, lines, report = checker.run()
    assert code == 1
    layers = {f["layer"] for f in report["failures"]}
    assert any(layer.startswith("L1") for layer in layers), layers
    assert "FAIL" in "\n".join(lines)


def test_catches_underscore_spelling(tmp_path, monkeypatch, checker):
    """A rename to `history_scrub` must not slip through."""
    _write(tmp_path, ".github/workflows/ci.yml",
           "jobs:\n  x:\n    steps:\n      - run: python scripts/history_scrub.py\n")
    _install(monkeypatch, checker, tmp_path, [".github/workflows/ci.yml"])

    code, _lines, _report = checker.run()
    assert code == 1


def test_catches_reference_one_hop_away(tmp_path, monkeypatch, checker):
    """The workflow is clean; the script it invokes is not. This is the
    layer a plain grep over .github/ would miss entirely."""
    _write(tmp_path, ".github/workflows/ci.yml",
           "jobs:\n  x:\n    steps:\n      - run: bash deploy/release.sh\n")
    _write(tmp_path, "deploy/release.sh",
           "#!/bin/bash\nexec scripts/history-scrub/rewrite.sh \"$@\"\n")
    _install(monkeypatch, checker, tmp_path,
             [".github/workflows/ci.yml", "deploy/release.sh"])

    code, _lines, report = checker.run()
    assert code == 1
    offenders = {f["path"] for f in report["failures"]}
    assert "deploy/release.sh" in offenders


def test_catches_reference_two_hops_away(tmp_path, monkeypatch, checker):
    """Closure, not a single hop: workflow -> wrapper -> scrubber."""
    _write(tmp_path, ".github/workflows/ci.yml",
           "jobs:\n  x:\n    steps:\n      - run: bash deploy/a.sh\n")
    _write(tmp_path, "deploy/a.sh", "#!/bin/bash\nbash deploy/b.sh\n")
    _write(tmp_path, "deploy/b.sh", "#!/bin/bash\nscripts/history-scrub/go.sh\n")
    _install(monkeypatch, checker, tmp_path,
             [".github/workflows/ci.yml", "deploy/a.sh", "deploy/b.sh"])

    code, _lines, report = checker.run()
    assert code == 1
    assert {"deploy/b.sh"} <= {f["path"] for f in report["failures"]}


def test_catches_local_git_hook(tmp_path, monkeypatch, checker):
    """`.git/hooks/` is untracked but executes on every commit/push, so
    it is a surface even though `git ls-files` never reports it."""
    _write(tmp_path, ".git/hooks/pre-push",
           "#!/bin/sh\nexec scripts/history-scrub/rewrite.sh\n")
    _install(monkeypatch, checker, tmp_path, [])

    code, _lines, report = checker.run()
    assert code == 1
    assert ".git/hooks/pre-push" in {f["path"] for f in report["failures"]}


def test_ignores_git_sample_hooks(tmp_path, monkeypatch, checker):
    """Every clone ships inert `*.sample` hooks; git will not run them,
    so they must not be able to fail the gate."""
    _write(tmp_path, ".git/hooks/pre-push.sample",
           "#!/bin/sh\n# scripts/history-scrub/rewrite.sh\n")
    _install(monkeypatch, checker, tmp_path, [])

    code, _lines, _report = checker.run()
    assert code == 0


def test_catches_package_json_script(tmp_path, monkeypatch, checker):
    _write(tmp_path, "package.json",
           '{"scripts": {"clean": "bash scripts/history-scrub/run.sh"}}\n')
    _install(monkeypatch, checker, tmp_path, ["package.json"])

    code, _lines, report = checker.run()
    assert code == 1
    assert "package.json" in {f["path"] for f in report["failures"]}


def test_catches_makefile_target(tmp_path, monkeypatch, checker):
    _write(tmp_path, "Makefile", "scrub:\n\t./scripts/history-scrub/run.sh\n")
    _install(monkeypatch, checker, tmp_path, ["Makefile"])

    code, _lines, _report = checker.run()
    assert code == 1


def test_catches_conftest(tmp_path, monkeypatch, checker):
    """pytest executes conftest.py at collection — that is automation."""
    _write(tmp_path, "tests/conftest.py",
           "import subprocess\nsubprocess.run(['scripts/history-scrub/go.sh'])\n")
    _install(monkeypatch, checker, tmp_path, ["tests/conftest.py"])

    code, _lines, _report = checker.run()
    assert code == 1


def test_catches_unwired_executable_in_tree(tmp_path, monkeypatch, checker):
    """L3: code that names the scrub tooling but is not wired up YET is
    one `run:` line away from being wired up. Fail it now."""
    _write(tmp_path, "scripts/helper.py",
           "SCRUB = 'scripts/history-scrub/rewrite.sh'\n")
    _install(monkeypatch, checker, tmp_path, ["scripts/helper.py"])

    code, _lines, report = checker.run()
    assert code == 1
    assert any(f["layer"].startswith("L3") for f in report["failures"])


# ────────────────────────────────────────────────────────────────────
# 3. The gate does not over-reach
# ────────────────────────────────────────────────────────────────────


def test_documented_prose_reference_is_a_notice_not_a_failure(
    tmp_path, monkeypatch, checker
):
    """The ADR and the corpus meta.yaml are SUPPOSED to name the tooling.
    They are reported, never failed."""
    _write(tmp_path, "docs/decisions/ADR-corpus-history-sibiu.md",
           "Run scripts/history-scrub/ before proceeding.\n")
    _write(tmp_path, "corpus/pdf_positional/meta.yaml",
           "source_notes: >\n  ...require running scripts/history-scrub/ first.\n")
    _install(monkeypatch, checker, tmp_path, [
        "docs/decisions/ADR-corpus-history-sibiu.md",
        "corpus/pdf_positional/meta.yaml",
    ])

    code, lines, report = checker.run()
    assert code == 0
    assert report["failures"] == []
    assert set(report["documented_mentions"]) == {
        "docs/decisions/ADR-corpus-history-sibiu.md",
        "corpus/pdf_positional/meta.yaml",
    }
    assert any("NOTICE" in line and "documented references" in line
               for line in lines)


def test_a_paths_filter_is_a_trigger_not_an_invocation(
    tmp_path, monkeypatch, checker
):
    """A workflow whose `paths:` filter names `corpus/**` declares when
    to RUN, it does not invoke 17 fixtures. Chasing those would drag the
    corpus data payloads into the closure and flag the ADR's own
    documented reference as if it were a wired-up call."""
    _write(tmp_path, ".github/workflows/ci.yml",
           'on:\n  pull_request:\n    paths:\n      - "corpus/**"\n')
    _write(tmp_path, "corpus/pdf_positional/meta.yaml",
           "source_notes: run scripts/history-scrub/ by hand\n")
    _install(monkeypatch, checker, tmp_path, [
        ".github/workflows/ci.yml", "corpus/pdf_positional/meta.yaml",
    ])

    code, _lines, report = checker.run()
    assert code == 0
    assert report["documented_mentions"] == ["corpus/pdf_positional/meta.yaml"]


def test_clean_tree_is_green(tmp_path, monkeypatch, checker):
    _write(tmp_path, ".github/workflows/ci.yml",
           "jobs:\n  x:\n    steps:\n      - run: python3 scripts/corpus_replay.py\n")
    _write(tmp_path, "scripts/corpus_replay.py", "print('ok')\n")
    _install(monkeypatch, checker, tmp_path,
             [".github/workflows/ci.yml", "scripts/corpus_replay.py"])

    code, lines, report = checker.run()
    assert code == 0
    assert report["failures"] == []
    assert any("PASS" in line for line in lines)
