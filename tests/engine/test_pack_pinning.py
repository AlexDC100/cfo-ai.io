"""N3 — pack pinning + effective-dated resolution (Phase 3 cutover).

Locks the four properties that make the pack cutover safe to evolve:

  · PROVENANCE: every assembled envelope records the resolved pack
    (id@version) and its content-addressed pack_hash under
    ``assembled_canonical_v1.pack_provenance`` — additive envelope-root
    fields; the served canonical_bs payload never carries them (the
    golden corpus is byte-identical by construction).
  · PINNING: a STORED envelope replays/serves under the pack_hash it was
    built with even after a different/newer pack universe exists in the
    runtime root — the serve path is a pure function of the persisted
    envelope and NEVER re-resolves a pack. Only NEW classification work
    follows the new root.
  · RESOLUTION: effective-dated resolution through the REAL runtime seam
    (``engine.packs.runtime.active_pack`` — the same function
    ``chart_of_accounts.classification_pack`` calls): the ro_2024 /
    ro_2025 fixture packs resolve by period_end; latest wins when no
    period_end is supplied; pre-window dates raise NoPackFoundError.
  · CARRY-FORWARD KEYING: the reconciliation carry-forward snapshot key
    includes pack_hash — a pack content change drops stale
    reconciliation state; an old envelope WITHOUT the stamp (pre-cutover
    snapshot) matches by rule.

MAPPING_VERSION derivation is pinned here too: pack omfp1802@v1 keeps
the frozen pre-cutover vintage string (stored envelopes + goldens carry
it), and future pack versions derive a collision-free mechanical name.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import engine.country_packs.ro_romania  # noqa: F401 — registers RomaniaPack
from engine.api import _reconcile
from engine.country_packs.ro_romania import chart_of_accounts as coa
from engine.packs import NoPackFoundError, load_pack
from engine.packs.runtime import active_pack, default_packs_root, invalidate_pack_cache

REPO = Path(__file__).resolve().parents[2]
PACK_DIR = REPO / "packs" / "ro" / "omfp1802-v1"
FIXTURE_PACKS = Path(__file__).resolve().parent / "fixtures" / "packs"


@pytest.fixture()
def swapped_root(monkeypatch):
    """Point the runtime at the ro_2024/ro_2025 FIXTURE pack universe for
    the duration of one test; always restore + re-invalidate so no other
    test can observe the swap."""
    monkeypatch.setenv("ENGINE_PACKS_ROOT", str(FIXTURE_PACKS))
    invalidate_pack_cache()
    try:
        yield FIXTURE_PACKS
    finally:
        monkeypatch.delenv("ENGINE_PACKS_ROOT", raising=False)
        invalidate_pack_cache()


def _tiny_tb_rows():
    """A minimal balanced 10-column TB (cash vs share capital)."""
    base = {"si_d": 0.0, "si_c": 0.0, "r_d": 0.0, "r_c": 0.0,
            "st_d": 0.0, "st_c": 0.0, "sf_d": 0.0, "sf_c": 0.0}
    return [
        {"cont": "5121", "nume_cont": "Banca lei", **{**base, "sf_d": 500.0}},
        {"cont": "1012", "nume_cont": "Capital subscris varsat", **{**base, "sf_c": 500.0}},
    ]


def _assembled_envelope(pack):
    _tb, _shaped, assembled = pack.assemble_parsed_tb(_tiny_tb_rows())
    env = assembled.get("assembled_canonical_v1")
    assert isinstance(env, dict), "assembly emitted no canonical envelope"
    return env


# ── provenance stamp ───────────────────────────────────────────────────


def test_envelope_records_pack_provenance(pack):
    env = _assembled_envelope(pack)
    ro_pack = load_pack(PACK_DIR)
    assert env.get("pack_provenance") == {
        "jurisdiction": "RO",
        "pack": "omfp1802@v1",
        "pack_hash": ro_pack.pack_hash,
        "mapping_version": "ro_omfp1802_v2",
    }
    # additive-only: the stamp lives at the envelope ROOT, never inside
    # the served canonical_bs (golden byte-stability).
    assert "pack_provenance" not in (env.get("canonical_bs") or {})
    served = _reconcile.served_canonical_bs(env)
    assert isinstance(served, dict)
    assert "pack_provenance" not in served


def test_mapping_version_derives_from_pack():
    # v1 keeps the frozen pre-cutover vintage (stored envelopes carry it)
    assert coa.MAPPING_VERSION == "ro_omfp1802_v2"
    assert coa.mapping_version_for(load_pack(PACK_DIR).identity) == "ro_omfp1802_v2"
    # future versions derive mechanically AND cannot collide with the
    # v1-era "..._v2" spelling
    future = SimpleNamespace(jurisdiction="RO", pack_id="omfp1802", version="v2")
    assert coa.mapping_version_for(future) == "ro_omfp1802_pack_v2"
    assert coa.mapping_version_for(future) != coa.MAPPING_VERSION


# ── pinning: serve never re-resolves ───────────────────────────────────


def test_stored_envelope_serves_pinned_after_pack_universe_changes(pack, swapped_root):
    """Build under the REAL v1 pack, then swap the runtime to a
    different pack universe: new resolution follows the new root, but
    the stored envelope's serve payload and pack_provenance are
    byte-identical — the serve path never consults the runtime."""
    # Build BEFORE the swap is observed by classification: force the
    # real root for the assembly by resolving from the default cache…
    # (the swapped_root fixture already re-pointed the env, so re-pin
    # the real universe explicitly for the build, then swap back.)
    import os
    real_env = os.environ.pop("ENGINE_PACKS_ROOT")
    invalidate_pack_cache()
    try:
        env = _assembled_envelope(pack)
        v1_hash = load_pack(PACK_DIR).pack_hash
        assert env["pack_provenance"]["pack_hash"] == v1_hash
        served_before = _reconcile.served_canonical_bs(copy.deepcopy(env))
    finally:
        os.environ["ENGINE_PACKS_ROOT"] = real_env
        invalidate_pack_cache()

    # The runtime now resolves the FIXTURE universe (a different pack)…
    fixture_pack = active_pack("RO")
    assert fixture_pack.identity.pack_id == "ro_omfp1802_test"
    assert fixture_pack.pack_hash != v1_hash
    # …and NEW classification follows it (the fixture's own vocabulary),
    # proving the runtime seam is live for new work…
    live_rule = coa.bucket_for("4111")
    assert live_rule is not None
    assert live_rule.bucket == "trade_receivables"  # fixture line id

    # …while the STORED envelope is pinned: same serve payload, same
    # provenance, no re-resolution.
    served_after = _reconcile.served_canonical_bs(copy.deepcopy(env))
    assert json.dumps(served_after, sort_keys=True) == json.dumps(
        served_before, sort_keys=True
    )
    assert env["pack_provenance"]["pack_hash"] == v1_hash


# ── effective-dated resolution through the REAL runtime seam ──────────


def test_period_dated_resolution_via_runtime(swapped_root):
    assert default_packs_root() == FIXTURE_PACKS
    p2024 = active_pack("RO", "2024-06-30")
    p2025 = active_pack("RO", "2025-06-30")
    assert p2024.identity.version == "2024.1"
    assert p2025.identity.version == "2025.1"
    assert p2024.pack_hash != p2025.pack_hash
    # latest wins when classification has no period context yet
    assert active_pack("RO").pack_hash == p2025.pack_hash
    # window edges: [effective_from, effective_to)
    assert active_pack("RO", "2024-01-01").identity.version == "2024.1"
    assert active_pack("RO", "2025-01-01").identity.version == "2025.1"
    with pytest.raises(NoPackFoundError):
        active_pack("RO", "2023-12-31")
    with pytest.raises(NoPackFoundError):
        active_pack("HU")


def test_runtime_cache_returns_same_object():
    first = active_pack("RO")
    assert active_pack("RO") is first  # cached, not re-loaded


# ── carry-forward snapshot key gains pack_hash ─────────────────────────


def _envelope_for_carry(pack_hash=None, content_hash="sha256-X"):
    env = {
        "provenance": {"content_hash": content_hash},
        "canonical_bs": {
            "mapping_version": "ro_omfp1802_v2",
            "extraction": {"parser_version": "tb_parser_v5"},
        },
    }
    if pack_hash is not None:
        env["pack_provenance"] = {"pack_hash": pack_hash}
    return env


def test_carry_forward_includes_pack_hash_in_snapshot_key():
    receipt = {"content_hash": "sha256-X", "amount_cents": 100}

    # pre-cutover old envelope (no stamp) still carries forward
    old = _envelope_for_carry(pack_hash=None)
    old["reconciliation"] = dict(receipt)
    new = _envelope_for_carry(pack_hash="hash-A")
    assert _reconcile.carry_forward_reconciliation(new, old) == "carried"
    assert new["reconciliation"] == receipt

    # same pack hash → carried
    old = _envelope_for_carry(pack_hash="hash-A")
    old["reconciliation"] = dict(receipt)
    new = _envelope_for_carry(pack_hash="hash-A")
    assert _reconcile.carry_forward_reconciliation(new, old) == "carried"

    # pack content changed (hash mismatch) → dropped, even though
    # content_hash + parser_version + mapping_version all still match
    old = _envelope_for_carry(pack_hash="hash-A")
    old["reconciliation"] = dict(receipt)
    new = _envelope_for_carry(pack_hash="hash-B")
    assert _reconcile.carry_forward_reconciliation(new, old) == "dropped_stale"
    assert "reconciliation" not in new
