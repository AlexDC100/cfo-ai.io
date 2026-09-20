"""GATE for the gate — scripts/check_fresh_upload.py.

Owner ruling 2026-09-20: a deploy is not done until a fresh upload completes
all five steps. This proves that gate can actually FAIL.

Fails on: a broken step passing; the AI step (05) being allowed to fail the
deploy, or being allowed to pass silently when it is unavailable; a missing
book passing (vacuous); the gate re-deriving its own balance verdict instead
of reading the engine's; the gate writing anything.
"""
from __future__ import annotations

import importlib.util
from decimal import Decimal
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("check_fresh_upload", ROOT / "scripts" / "check_fresh_upload.py")
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)

BOOK = ROOT / "corpus" / "saga_10_col"
REACHABLE = lambda: (True, "narrate reachable (test)")  # noqa: E731
UNREACHABLE = lambda: (False, "narrate unavailable: no key")  # noqa: E731


def _steps(result):
    return {s["step"][:2]: s for s in result["steps"]}


def test_a_real_book_passes_every_numeric_step():
    r = gate.run_book(BOOK, narrate_probe=REACHABLE)
    assert r["ok"] is True
    steps = _steps(r)
    assert set(steps) == {"01", "02", "03", "04", "05"}
    assert all(s["ok"] for s in steps.values())
    assert not any(s["degraded"] for s in steps.values())
    assert r["accounts"] > 100 and r["metrics"] > 10, "non-vacuity: the book must carry real content"
    assert "BALANCED" in steps["03"]["detail"]
    assert gate.exit_code([r]) == 0


def test_the_ai_step_degrades_the_report_but_never_the_deploy():
    r = gate.run_book(BOOK, narrate_probe=UNREACHABLE)
    step5 = _steps(r)["05"]
    assert step5["degraded"] is True and step5["ok"] is True
    assert "unavailable" in step5["detail"], "a degraded step must say WHY"
    assert gate.exit_code([r]) == 0, "the pipeline treats narrate as non-fatal; so must the gate"


def test_a_narrate_probe_that_lies_silently_cannot_hide():
    """A probe returning no reason is still rendered as a reason-bearing line."""
    r = gate.run_book(BOOK, narrate_probe=lambda: (False, ""))
    assert _steps(r)["05"]["degraded"] is True


@pytest.mark.parametrize("break_it,expect", [
    ("format", "01"),
    ("rows", "02"),
    ("balance", "03"),
    ("metrics", "04"),
])
def test_each_numeric_step_reds_when_its_stage_breaks(monkeypatch, break_it, expect):
    from engine.country_packs.ro_romania import pack as packmod
    real = packmod.RomaniaPack.run_deterministic_tb

    def sabotaged(self, content, filename="", **kw):
        tb, shaped, asm = real(self, content, filename=filename, **kw)
        if break_it == "format":
            tb.extraction = dict(tb.extraction or {}); tb.extraction["source_format"] = None
        if break_it == "rows":
            tb.rows = []
        if break_it == "balance":
            cbs = asm["assembled_canonical_v1"]["canonical_bs"]
            cbs["totals"] = dict(cbs["totals"]); cbs["totals"]["assets"] = float(cbs["totals"]["assets"]) + 1000.0
        if break_it == "metrics":
            asm["statements"] = {"balanceSheet": {}, "incomeStatement": {}}
        return tb, shaped, asm

    monkeypatch.setattr(packmod.RomaniaPack, "run_deterministic_tb", sabotaged)
    r = gate.run_book(BOOK, narrate_probe=REACHABLE)
    assert r["ok"] is False, f"planting {break_it} did not red the gate"
    assert _steps(r)[expect]["ok"] is False, f"the wrong step reported {break_it}"
    assert gate.exit_code([r]) == 1


def test_the_gate_reads_the_engines_verdict_rather_than_its_own(monkeypatch):
    """Plant a canonical_bs whose totals tie but whose own status says otherwise:
    the gate must follow the ENGINE, not its own subtraction."""
    from engine.country_packs.ro_romania import pack as packmod
    real = packmod.RomaniaPack.run_deterministic_tb

    def lying_status(self, content, filename="", **kw):
        tb, shaped, asm = real(self, content, filename=filename, **kw)
        asm["assembled_canonical_v1"]["canonical_bs"]["status"] = "IMBALANCED"
        return tb, shaped, asm

    monkeypatch.setattr(packmod.RomaniaPack, "run_deterministic_tb", lying_status)
    r = gate.run_book(BOOK, narrate_probe=REACHABLE)
    assert r["ok"] is False and "IMBALANCED" in _steps(r)["03"]["detail"]


def test_a_missing_book_is_red_not_green(tmp_path, capsys):
    assert gate.main(["--book", "corpus/does_not_exist"]) == 2
    assert "RED" in capsys.readouterr().out


def test_an_empty_run_is_red():
    assert gate.exit_code([]) == 2


def test_the_default_probe_never_spends_a_completion(monkeypatch):
    """It may read the key and the SDK; it may not construct a request."""
    import anthropic
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key-abcd")
    monkeypatch.setattr(anthropic, "Anthropic",
                        lambda *a, **k: pytest.fail("the probe built a client"))
    ok, detail = gate.default_narrate_probe()
    assert ok is True and "abcd" in detail and "not probed" in detail
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    ok, detail = gate.default_narrate_probe()
    assert ok is False and "ANTHROPIC_API_KEY" in detail
