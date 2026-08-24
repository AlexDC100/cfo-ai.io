"""Supply-chain gate — the enforcer, enforced (Part E trust boundary).

`scripts/check_supply_chain.py` exists because of a real incident
(2026-08-22): the Dockerfile's floating `pip install "anthropic>=0.30"`
resolved 1.0.0 on a rebuild, whose httpx2 stack removed the transitive
httpx seven engine modules import directly — the container crash-looped
and the regression was invisible until boot. These tests hold the three
properties that make the gate worth trusting:

  1. THE PLANTED VIOLATIONS ARE CAUGHT. The gate's own `--self-test`
     plants the incident Dockerfile line, an unhashed pin, floating
     image tags and runtime-concatenated fake credentials, and asserts
     every one is flagged (and every clean fixture passes). Running it
     here keeps the self-test itself from rotting.

  2. THE REAL TREE IS GREEN — HONESTLY. The actual Dockerfile installs
     from requirements-lock.txt under --require-hashes (this test was
     written RED against the pre-wiring Dockerfile that still carried
     the literal incident line, then the Dockerfile was wired); the
     actual lock is hash-locked, in digest-sync with pyproject, and
     pins anthropic INSIDE its `<1.0` ceiling.

  3. THE INCIDENT CANNOT RECUR. A hypothetical anthropic==1.0.0 pin is
     proven REJECTED by the sync check (counterproof — the gate is
     tested against the failure it was built for, not just against the
     currently-clean state), and a lock missing httpx is refused.

No test here runs the full tracked-tree secrets scan — that is CI's job
(`check_supply_chain.py --self-test && check_supply_chain.py`); pytest
exercises the pure functions on real + planted inputs so the suite
stays fast.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "check_supply_chain.py"


def _load_gate():
    for extra in (REPO / "src", REPO / "scripts"):
        if str(extra) not in sys.path:
            sys.path.insert(0, str(extra))
    spec = importlib.util.spec_from_file_location("check_supply_chain", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


@pytest.fixture(scope="module")
def gate():
    return _load_gate()


# ── 1. the planted-violation self-test stays alive ─────────────────────


def test_self_test_catches_every_planted_violation(gate):
    code, lines = gate.self_test()
    assert code == 0, "\n".join(lines)
    # The incident line specifically must be among the planted catches.
    assert any("anthropic>=0.30" in line for line in lines)


# ── 2. the real tree is green — honestly ───────────────────────────────


def test_engine_dockerfile_installs_from_lock(gate):
    """RED-FIRST WITNESS for the Dockerfile wiring: against the
    pre-wiring Dockerfile (14 c3 violations, incl. the literal incident
    line `pip install "anthropic>=0.30"` at line 21) this assertion
    failed; it passes only with the image built from the hash lock."""
    text = (REPO / "Dockerfile").read_text(encoding="utf-8")
    violations = gate.check_dockerfile_lock_install(text)
    assert violations == [], "\n".join(
        "%s: %s" % (v.category, v.detail) for v in violations
    )


def test_lock_is_hash_locked_and_in_sync_with_pyproject(gate):
    pins, extras, build, digest, c1 = gate.check_lock_shape(REPO)
    assert c1 == [], "\n".join(v.detail for v in c1)
    assert pins, "lock carries no pins"
    c2, proofs = gate.check_lock_sync(REPO, pins, extras, build, digest)
    assert c2 == [], "\n".join(v.detail for v in c2)
    # The incident proof: anthropic pinned inside its declared ceiling.
    assert any(
        p.startswith("anthropic==") and "<1.0" in p for p in proofs
    ), proofs
    assert "httpx" in pins, "httpx must be pinned (direct engine dep)"


def test_no_floating_image_tags_in_tracked_container_files(gate):
    ccp = sys.modules.get("check_corpus_policy") or __import__(
        "check_corpus_policy"
    )
    tracked = ccp.tracked_paths()
    files = [
        (p, (REPO / p).read_text(encoding="utf-8", errors="replace"))
        for p in gate._container_build_files(tracked)
    ]
    assert files, "no container build files found in the tracked tree"
    violations = gate.check_image_tags(files)
    assert violations == [], "\n".join(
        "%s: %s" % (v.path, v.detail) for v in violations
    )


# ── 3. the incident cannot recur (counterproofs) ───────────────────────


def test_hypothetical_anthropic_float_is_rejected(gate):
    """The 2026-08-22 failure, replayed against the gate: were the lock
    ever regenerated with anthropic 1.0.0 (the float that removed
    httpx), the sync check refuses it against pyproject's `<1.0`
    ceiling — before --require-hashes would refuse it at install."""
    pins, extras, build, digest, _c1 = gate.check_lock_shape(REPO)
    floated = dict(pins)
    assert "anthropic" in floated
    floated["anthropic"] = "1.0.0"
    c2, _proofs = gate.check_lock_sync(REPO, floated, extras, build, digest)
    assert any(
        v.category == "c2_lock_sync" and "anthropic==1.0.0" in v.detail
        for v in c2
    ), [v.detail for v in c2]


def test_lock_missing_httpx_is_rejected(gate):
    pins, extras, build, digest, _c1 = gate.check_lock_shape(REPO)
    gutted = {k: v for k, v in pins.items() if k != "httpx"}
    c2, _proofs = gate.check_lock_sync(REPO, gutted, extras, build, digest)
    assert any("httpx" in v.detail for v in c2)


def test_unhashed_pin_is_not_a_lock(gate):
    _p, _h, viol, _e, _b, _d = gate.parse_lock(
        "anthropic==0.125.0\n", path="<planted>"
    )
    assert any(v.category == "c1_lock_shape" for v in viol)
