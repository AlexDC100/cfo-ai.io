"""The P&L definition pack is verified at BOOT, like the credit and the
margin-meaning packs.

THE DEFECT (deploy-readiness review of feat/rulings-2, 2026-09-29).
``packs/ro/pl_definition.yaml`` (owner rulings R2 / R3: the 6812 / 6814 /
7812 / 7814 placement outside EBITDA, 7411 inside net turnover) is read
LAZILY by ``country_packs/ro_romania/pl_definition.definition()`` — on the
first Romanian period assembled. ``boot_verify.verify_config`` checked the
credit and the margin-meaning packs but not this one, so a container whose
image lost the file, or carried a malformed one, passed the /health boot
probe (CLAUDE.md §14 step 6) and then failed every request that assembled a
period.

LAW. ``verify_config`` (what ``create_app`` runs through
``verify_config_safe``) raises a RuntimeError naming the pack when the file is
missing, is not YAML, is not UTF-8 (review 2026-10-01: it escaped as a bare
UnicodeDecodeError, without the boot message), carries the wrong schema, or
crosses classes (a charge that is not a class-6 account); with the committed
pack it passes. Each case
reads a FRESH tmp directory through the loader's own override
(``RO_PL_DEFINITION_PACKS_DIR``), with the loader's per-path cache cleared
before and after, so no case can pass on another's cached pack.

REDS ON: ``verify_config`` not asking the pack (the pre-fix boot check), or
asking it and swallowing the refusal.
CANNOT SEE: whether the pack's placement is the ruling (provisions-symmetric,
turnover-7411); the container's real boot (§14 step 6 boot probe).
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional, Union

import pytest

from engine import boot_verify
from engine.country_packs.ro_romania import pl_definition as pld

COMMITTED = pld.DEFAULT_PACKS_DIR / pld.PACK_NAME
WORK = {"cases": []}


@pytest.fixture
def boot_env(monkeypatch):
    """The critical env set (verify_config fails fast without it), the
    loader's cache clear before and after, the override removed after."""
    for k in boot_verify._CRITICAL:
        monkeypatch.setenv(k, "set-for-the-test")
    monkeypatch.delenv("RO_PL_DEFINITION_PACKS_DIR", raising=False)
    pld._load.cache_clear()
    yield monkeypatch
    monkeypatch.delenv("RO_PL_DEFINITION_PACKS_DIR", raising=False)
    pld._load.cache_clear()


def _pack_dir(tmp_path: Path, name: str, text: Optional[Union[str, bytes]]) -> Path:
    d = tmp_path / name
    d.mkdir()
    if isinstance(text, bytes):
        (d / pld.PACK_NAME).write_bytes(text)
    elif text is not None:
        (d / pld.PACK_NAME).write_text(text, encoding="utf-8")
    return d


def _committed_text() -> str:
    return COMMITTED.read_text(encoding="utf-8")


def _crossed_classes() -> str:
    """The committed pack with a class-7 reversal listed among the charges."""
    import yaml
    raw = yaml.safe_load(_committed_text())
    raw["provisions_outside_ebitda"]["charges"] = list(raw["provisions_outside_ebitda"]["charges"]) + ["7812"]
    return yaml.safe_dump(raw, allow_unicode=True, sort_keys=False)


CASES = {
    "missing": None,
    "not-yaml": "schema_version: [unclosed\n  turnover: {\n",
    # The committed pack behind a UTF-16 byte-order mark: valid YAML in the
    # wrong encoding, so the read itself fails.
    "not-utf8": b"\xff\xfe" + _committed_text().encode("utf-8"),
    "wrong-schema": _committed_text().replace("ro_pl_definition/1", "ro_pl_definition/0"),
    "crossed-classes": _crossed_classes(),
}


def test_the_committed_pack_passes_the_boot_check(boot_env):
    assert COMMITTED.is_file()
    boot_verify.verify_pl_definition_pack()
    boot_verify.verify_config()
    WORK["cases"].append("committed")


@pytest.mark.parametrize("case", sorted(CASES))
def test_an_unusable_pack_fails_the_boot_check(case, boot_env, tmp_path):
    d = _pack_dir(tmp_path, case, CASES[case])
    boot_env.setenv("RO_PL_DEFINITION_PACKS_DIR", str(d))
    pld._load.cache_clear()
    # The premise: the loader itself refuses this pack.
    with pytest.raises(Exception):
        pld.definition()
    pld._load.cache_clear()
    with pytest.raises(RuntimeError, match=r"P&L definition pack at .*%s.* is unusable" % case):
        boot_verify.verify_config()
    # Restored: the committed pack loads again, fresh.
    boot_env.delenv("RO_PL_DEFINITION_PACKS_DIR")
    pld._load.cache_clear()
    boot_verify.verify_config()
    WORK["cases"].append(case)


def test_zz_scope(capsys):
    with capsys.disabled():
        print("\nBOOT-VERIFY pl_definition: %s" % ", ".join(WORK["cases"]))
    assert sorted(WORK["cases"]) == sorted(["committed", *CASES])
