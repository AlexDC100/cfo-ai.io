"""The battery's preflight: a nested ``node_modules/node_modules`` stops it.

OWNER RULING 2026-10-02. Every worktree links its ``node_modules`` to the
main checkout's. A bare ``ln -s <main>/node_modules <worktree>/node_modules``
run a second time follows the existing link and creates the new one INSIDE
the target — ``<main>/node_modules/node_modules`` — and from then on
Playwright collects zero tests in every checkout. It was removed on
2026-10-02 and was back within the hour. The battery now looks before it
starts: the entry present is a RED with its own name, and no gate is run.

WHAT THIS FILE REDS ON (TC-11)
  · the preflight no longer finding the nested entry (as a link, a broken
    link or a directory; directly or through a worktree's own link);
  · the battery starting a gate while the entry exists;
  · the entry existing in THIS repository's main checkout right now.
WHAT IT CANNOT SEE
  · who made the link, or a ``ln -s`` in a prompt or a shell history — the
    rule ("``ln -sfn``, never a bare ``ln -s``") is held only by the state
    it would leave behind.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

import run_battery as RB  # noqa: E402


def _checkout(tmp_path: Path, name: str) -> Path:
    root = tmp_path / name
    (root / "node_modules" / "left-pad").mkdir(parents=True)
    return root


def test_a_clean_checkout_has_nothing_to_report(tmp_path):
    main = _checkout(tmp_path, "main")
    assert RB.nested_node_modules([main]) == []
    # a checkout with no node_modules at all is not a finding either
    assert RB.nested_node_modules([tmp_path / "absent"]) == []


def test_the_incident_shape_is_found_ln_s_run_twice(tmp_path):
    """The exact way it is made: the second bare ``ln -s`` on a worktree
    that already has the link lands inside the main checkout."""
    main = _checkout(tmp_path, "main")
    worktree = tmp_path / "wt"
    worktree.mkdir()
    os.symlink(main / "node_modules", worktree / "node_modules")       # first: fine
    # second `ln -s <main>/node_modules <wt>/node_modules`: the existing
    # link is followed, so the new link is created inside the target.
    os.symlink(main / "node_modules", worktree / "node_modules" / "node_modules")
    assert os.path.lexists(main / "node_modules" / "node_modules")
    found = RB.nested_node_modules([main, worktree])
    assert [str(p) for p in found] == [
        os.path.join(os.path.realpath(main / "node_modules"), "node_modules")]


def test_it_is_found_from_the_worktree_alone_through_its_link(tmp_path):
    main = _checkout(tmp_path, "main")
    worktree = tmp_path / "wt"
    worktree.mkdir()
    os.symlink(main / "node_modules", worktree / "node_modules")
    os.symlink(main / "node_modules", main / "node_modules" / "node_modules")
    assert len(RB.nested_node_modules([worktree])) == 1


def test_a_broken_nested_link_and_a_nested_directory_are_found_too(tmp_path):
    broken = _checkout(tmp_path, "broken")
    os.symlink(tmp_path / "gone", broken / "node_modules" / "node_modules")
    assert len(RB.nested_node_modules([broken])) == 1
    copied = _checkout(tmp_path, "copied")
    (copied / "node_modules" / "node_modules").mkdir()
    assert len(RB.nested_node_modules([copied])) == 1


def test_a_planted_nested_link_stops_the_battery_before_any_gate(tmp_path, monkeypatch, capsys):
    main = _checkout(tmp_path, "main")
    os.symlink(main / "node_modules", main / "node_modules" / "node_modules")
    monkeypatch.setattr(RB, "_main_checkout", lambda: main)
    started = []
    monkeypatch.setattr(RB.subprocess, "run",
                        lambda *a, **k: started.append(a) or (_ for _ in ()).throw(
                            AssertionError("a gate was started past a red preflight")))
    code = RB.main([])
    out = capsys.readouterr().out
    assert code == 1
    assert started == []
    assert "RED — nested-node-modules: " in out
    assert os.path.join(os.path.realpath(main / "node_modules"), "node_modules") in out
    assert "ln -sfn" in out and "0 gates run" in out


def test_a_clean_preflight_lets_the_battery_list_and_start(tmp_path, monkeypatch):
    main = _checkout(tmp_path, "main")
    monkeypatch.setattr(RB, "_main_checkout", lambda: main)
    monkeypatch.setattr(RB, "REPO", main)
    assert RB.preflight() == []


def test_the_main_checkout_resolver_names_a_real_checkout():
    main = RB._main_checkout()
    assert (main / ".git").exists(), main
    assert (main / "scripts" / "run_battery.py").exists() or main == RB.REPO


def test_the_main_checkout_has_no_nested_node_modules_today():
    """Live: this repository, now. Red here is the incident itself."""
    assert RB.preflight() == [], RB.preflight()
