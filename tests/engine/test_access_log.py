"""E1 — facts-gateway access log (engine.serving.access_log).

The trust-boundary requirement: every construction of the served-truth
reader (``FactsGateway.from_envelope`` — the ONE public entry through
which served facts are obtained) leaves an append-only audit record
``{who, when, doc, accessor}`` as JSONL under ``data/obs/``.

Contract locked here (written RED-FIRST, before the module existed):
  * A1  from_envelope appends exactly one record per construction, with
        the four keys, ``doc`` = the envelope's provenance snapshot id
        and ``accessor`` = "FactsGateway.from_envelope".
  * A2  ``who`` is the CALLER — resolved from outside engine.serving,
        so the record names the consuming module, not the gateway.
  * A3  The hook NEVER raises and NEVER changes gateway behavior:
        an unwritable log target still returns a working gateway.
  * A4  ``ENGINE_ACCESS_LOG=0`` disables it; ``ENGINE_ACCESS_LOG_DIR``
        redirects it (tests never write the repo's real data/obs/).
  * A5  Records are append-only JSONL — one JSON object per line, new
        records only ever added at the end.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from datetime import datetime
from pathlib import Path

import pytest

from engine.serving import FactsGateway


def _load_by_path(name: str, path: Path):
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# The REAL-composition envelope builders (same source of truth as
# test_facts_gateway.py).
_trec = _load_by_path(
    "reconciliation_fixture_builders",
    Path(__file__).resolve().parent / "test_reconciliation.py",
)
_row = _trec._row
_envelope_for = _trec._envelope_for
CONTENT_HASH = _trec.CONTENT_HASH

BALANCED_ROWS = [
    _row("212", sf_d=2500.00),
    _row("5121", sf_d=1000.00),
    _row("1012", sf_c=3000.00),
    _row("401", sf_c=500.00),
]


@pytest.fixture()
def log_dir(tmp_path, monkeypatch):
    target = tmp_path / "obs"
    monkeypatch.setenv("ENGINE_ACCESS_LOG_DIR", str(target))
    monkeypatch.delenv("ENGINE_ACCESS_LOG", raising=False)
    return target


def _records(target: Path):
    log_file = target / "facts_access.jsonl"
    if not log_file.is_file():
        return []
    return [
        json.loads(line)
        for line in log_file.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


# ── A1 + A2: the record and its shape ─────────────────────────────────


def test_a1_from_envelope_appends_one_full_record(pack, log_dir):
    env = _envelope_for(pack, BALANCED_ROWS)
    gw = FactsGateway.from_envelope(env)
    assert gw is not None  # behavior unchanged — the gateway still builds

    records = _records(log_dir)
    assert len(records) == 1
    rec = records[0]
    assert set(rec) == {"who", "when", "doc", "accessor"}
    assert rec["accessor"] == "FactsGateway.from_envelope"
    assert rec["doc"] == CONTENT_HASH
    # `when` is ISO-8601 UTC and parseable.
    parsed = datetime.fromisoformat(str(rec["when"]).replace("Z", "+00:00"))
    assert parsed.tzinfo is not None


def test_a2_who_names_the_caller_not_the_gateway(pack, log_dir):
    env = _envelope_for(pack, BALANCED_ROWS)
    FactsGateway.from_envelope(env)
    rec = _records(log_dir)[0]
    who = str(rec["who"])
    assert who  # never empty
    # The caller is THIS test module — never the gateway package itself.
    assert not who.startswith("engine.serving")


def test_a5_records_append_only(pack, log_dir):
    env = _envelope_for(pack, BALANCED_ROWS)
    FactsGateway.from_envelope(env)
    first = _records(log_dir)
    FactsGateway.from_envelope(env)
    both = _records(log_dir)
    assert len(both) == len(first) + 1
    assert both[: len(first)] == first  # prior lines untouched


# ── A3: never raises, never changes behavior ──────────────────────────


def test_a3_unwritable_target_still_serves(pack, tmp_path, monkeypatch):
    # Point the log DIR at an existing FILE so mkdir/open must fail.
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("occupied", encoding="utf-8")
    monkeypatch.setenv("ENGINE_ACCESS_LOG_DIR", str(blocker))
    env = _envelope_for(pack, BALANCED_ROWS)
    gw = FactsGateway.from_envelope(env)  # must not raise
    assert gw is not None
    assert gw.total_assets().amount_minor == 350000


# ── A4: env kill-switch and redirect ──────────────────────────────────


def test_a4_disabled_via_env_writes_nothing(pack, tmp_path, monkeypatch):
    target = tmp_path / "obs"
    monkeypatch.setenv("ENGINE_ACCESS_LOG_DIR", str(target))
    monkeypatch.setenv("ENGINE_ACCESS_LOG", "0")
    env = _envelope_for(pack, BALANCED_ROWS)
    assert FactsGateway.from_envelope(env) is not None
    assert _records(target) == []


# ── Module-direct API (the seam other accessors will reuse) ───────────


def test_record_access_explicit_who_and_doc(log_dir):
    from engine.serving import access_log

    access_log.record_access(
        doc="sha256:abc", accessor="unit.test", who="tests.explicit"
    )
    rec = _records(log_dir)[0]
    assert rec == {
        "who": "tests.explicit",
        "when": rec["when"],
        "doc": "sha256:abc",
        "accessor": "unit.test",
    }


def test_record_access_never_raises_without_git_or_dir(monkeypatch):
    from engine.serving import access_log

    monkeypatch.setenv("ENGINE_ACCESS_LOG_DIR", "/dev/null/impossible")
    access_log.record_access(doc=None, accessor="unit.test")  # must not raise
