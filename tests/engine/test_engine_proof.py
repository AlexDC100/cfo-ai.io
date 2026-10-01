"""engine-proof — THE COMMITTED PROOF IS WHAT THIS TREE MEASURES.

`frontend/data/engineProof.json` is the one source of every accuracy number
a public page prints (the landing's proof block, the FAQ). It is written by
`scripts/build_engine_proof.py`, which RUNS the checks. `landing-proof`
(vitest) holds the page to the file; this gate holds the file to the engine.

WHY IT EXISTS. On 2026-10-01 the landing said "eight calibration fixtures"
in one sentence and "9 / 9" beside it — both typed on 2026-09-08, tied to no
run, no date and no list of what was checked. The only "proof source" a gate
read was a markdown table that was itself stale on one row. A generated file
is only better than a typed number if something re-generates it and
compares.

THE LAWS (numbered EP1–EP6: the engine book reserves the bare P-numbers for
the pipeline's property invariants, and harvests them from test files)
  EP1  re-running the script agrees with the committed file. With the local
      calibration books present (files/ — client trial balances, never
      committed) EVERY check is re-measured. Without them the script
      re-measures what the committed corpus carries — the engine identity,
      the rerun and replay counts, account 121, the listing counts — and
      says which checks it could not; it never passes by measuring nothing.
  EP2  the committed file is a FULL proof, shaped as the page expects: five
      checks, each with what is checked in two languages, how, a count of
      distinct books, a result, a date; every check passed.
  EP3  books are counted once: no check claims more subjects than there are
      real books, and the rerun check counts books, not the paths it read.
  EP4  the public file names no company and carries no figure of company
      size; the filed turnover figures stay inside the script.
  EP5  the engine identity in the file is this tree's (a stale proof is red).
  EP6  the script REFUSES to write a proof over the committed subset.

PLANTS (docs/engine_book/gates.md, "engine-proof"):
  A  a count edited by hand in the JSON            → EP1 red
  B  a file under src/engine changed, not re-run   → EP1 and EP5 red
  C  a fixture label written into the JSON         → EP4 red
  D  the scope guard removed from the script       → EP6 red
"""
from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "build_engine_proof.py"
PROOF = REPO / "frontend" / "data" / "engineProof.json"

CHECK_IDS = [
    "rerun_identical",
    "balance_sheet_closes",
    "net_income_equals_121",
    "turnover_equals_filing",
    "ebitda_variants_agree",
]


def _load_script():
    name = "build_engine_proof_under_test"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, str(SCRIPT))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture(scope="module")
def proof() -> dict:
    assert PROOF.is_file(), (
        "frontend/data/engineProof.json is not committed — the landing has no "
        "proof source. Measure it: python scripts/build_engine_proof.py")
    return json.loads(PROOF.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def check_run() -> subprocess.CompletedProcess:
    """ONE re-measurement for the module (≈40 s with the local books)."""
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--check"],
        cwd=str(REPO), capture_output=True, text=True, timeout=600,
    )


# ── EP1 ────────────────────────────────────────────────────────────────


def test_rerunning_the_proof_script_agrees_with_the_committed_file(check_run):
    out = check_run.stdout + check_run.stderr
    assert check_run.returncode == 0, (
        "the committed engineProof.json is NOT what this tree measures.\n"
        "Either the engine changed and the proof was not re-measured, or a "
        "number in the file was edited by hand.\n\n%s" % out[-3000:])
    assert "ENGINE PROOF: IN AGREEMENT" in out, out[-1500:]
    work = re.search(r"GATE-WORK engine-proof checks=(\d+) subjects=(\d+) scope=(\S+)", out)
    assert work, "the script printed no work count:\n%s" % out[-1500:]
    checks, subjects, scope = int(work.group(1)), int(work.group(2)), work.group(3)
    # Never a pass over nothing: the committed corpus alone carries the
    # rerun check and account 121 — two checks, eleven books.
    assert checks >= 2 and subjects >= 11, (checks, subjects, scope)
    print("SCOPE engine-proof %s — %d check(s), %d subject(s) re-measured"
          % (scope, checks, subjects))
    if scope != "full":
        assert "NOT RE-MEASURED here" in out
        print("NOTICE engine-proof: the local calibration books are absent; "
              "balance_sheet_closes, turnover_equals_filing and "
              "ebitda_variants_agree were compared by identity only.")


# ── EP2 ────────────────────────────────────────────────────────────────


def test_the_committed_file_is_a_full_dated_proof(proof):
    assert proof["schema"] == "engine_proof/1"
    assert proof["scope"] == "full", (
        "a proof over the committed subset was written to the public file — "
        "every count on the landing would silently shrink")
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", proof["measured_at"])
    assert [c["id"] for c in proof["checks"]] == CHECK_IDS
    for c in proof["checks"]:
        for key in ("what_en", "what_ro", "how", "subjects_kind", "measured_at"):
            assert isinstance(c[key], str) and c[key].strip(), (c["id"], key)
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", c["measured_at"]), c["id"]
        assert isinstance(c["subjects"], int) and c["subjects"] > 0, c["id"]
        assert c["passed"] is True, "%s did not hold and is published" % c["id"]
        assert c["result"], c["id"]
        assert all(isinstance(v, (int, float)) and not isinstance(v, bool)
                   for v in c["result"].values()), c["id"]
    assert set(proof["formats"]) == {"xlsx_10_column_layout", "pdf_positional_layout"}
    assert proof["counts"]["bvb_listings"] >= proof["counts"]["bvb_listings_with_financials"] > 0


# ── EP3 ────────────────────────────────────────────────────────────────


def test_books_are_counted_once(proof):
    total = proof["real_books_total"]
    assert isinstance(total, int) and total > 0
    by_id = {c["id"]: c for c in proof["checks"]}
    for c in proof["checks"]:
        assert c["subjects"] <= total, (
            "%s claims %d subjects; there are %d distinct real books"
            % (c["id"], c["subjects"], total))
    rerun = by_id["rerun_identical"]
    assert rerun["subjects"] <= rerun["result"]["paths_examined"], rerun
    # The retired "9 / 9" counted PATHS. If the two numbers are ever equal
    # again while local twins are on disk, books are being double-counted.
    script = _load_script()
    import verify_determinism as V  # noqa: E402 — on sys.path via the script
    local_twins = sum(1 for p, _l, _e, required in V.FIXTURES
                      if not required and p.is_file())
    if local_twins:
        assert rerun["result"]["paths_examined"] > rerun["subjects"], (
            "the rerun check counts %d books over %d paths with %d local twin(s) "
            "present — a twin is being counted as a second book"
            % (rerun["subjects"], rerun["result"]["paths_examined"], local_twins))
    assert sum(proof["formats"].values()) <= total
    turnover = by_id["turnover_equals_filing"]
    assert (turnover["subjects"] + turnover["result"]["books_not_checkable"]
            == turnover["result"]["real_books_total"] == total)
    assert turnover["subjects"] == len(script.FILED_TURNOVER_RON)


# ── EP4 ────────────────────────────────────────────────────────────────


def _fixture_labels() -> set:
    labels = set()
    drift = (REPO / "scripts" / "measure_bs_drift.py").read_text(encoding="utf-8")
    block = re.search(r"_PER_FIXTURE_THRESHOLD\s*=\s*\{(.*?)\}", drift, re.S)
    assert block, "fixture label table not found in measure_bs_drift.py"
    labels.update(m.lower() for m in re.findall(r'"([A-Za-z]+)"\s*:', block.group(1)))
    for case in (REPO / "corpus").iterdir():
        m = re.fullmatch(r"saga_10_col_([a-z]+)", case.name)
        if m:
            labels.add(m.group(1))
    det = (REPO / "scripts" / "verify_determinism.py").read_text(encoding="utf-8")
    for lab in re.findall(r'"\s*,\s*"([a-z_]+)"\s*,', det):
        labels.update(part for part in lab.split("_") if len(part) > 3)
    labels -= {"corpus", "saga", "prod"}
    return labels


def test_the_public_file_names_no_company_and_no_company_figure(proof):
    labels = _fixture_labels()
    assert len(labels) >= 8, labels
    text = PROOF.read_text(encoding="utf-8").lower()
    named = sorted(l for l in labels if re.search(r"\b%s\b" % re.escape(l), text))
    assert not named, "engineProof.json names calibration book(s): %s" % named

    def numbers(o):
        if isinstance(o, bool):
            return
        if isinstance(o, (int, float)):
            yield o
        elif isinstance(o, dict):
            for v in o.values():
                yield from numbers(v)
        elif isinstance(o, list):
            for v in o:
                yield from numbers(v)

    big = [n for n in numbers(proof) if abs(n) >= 1000]
    assert not big, "a figure of company size is in the public proof: %s" % big
    script = _load_script()
    for filed in script.FILED_TURNOVER_RON.values():
        assert str(filed) not in text and "{:,}".format(filed) not in text


# ── EP5 ────────────────────────────────────────────────────────────────


def test_the_engine_identity_is_this_trees(proof):
    script = _load_script()
    now = script.engine_identity()
    assert proof["engine"] == now, (
        "STALE PROOF — src/engine or packs changed since the proof was "
        "measured (committed %s…, tree %s…). Re-measure: "
        "python scripts/build_engine_proof.py"
        % (proof["engine"]["tree_sha256"][:16], now["tree_sha256"][:16]))
    assert now["tree_files"] > 400, now["tree_files"]


def test_the_identity_digest_moves_with_any_engine_file(tmp_path, monkeypatch):
    """The digest is over every file under src/engine and packs: adding one
    byte anywhere changes it. Proven on a COPY of two small roots, never by
    touching the real tree."""
    script = _load_script()
    root = tmp_path / "repo"
    (root / "src" / "engine").mkdir(parents=True)
    (root / "packs").mkdir()
    (root / "src" / "engine" / "a.py").write_text("x = 1\n", encoding="utf-8")
    (root / "packs" / "p.yaml").write_text("k: v\n", encoding="utf-8")
    monkeypatch.setattr(script, "REPO", root)
    before, n = script.tree_sha256()
    assert n == 2
    (root / "src" / "engine" / "__pycache__").mkdir()
    (root / "src" / "engine" / "__pycache__" / "a.cpython-311.pyc").write_bytes(b"\0")
    assert script.tree_sha256() == (before, 2), "a bytecode cache moved the digest"
    (root / "packs" / "p.yaml").write_text("k: w\n", encoding="utf-8")
    after, _ = script.tree_sha256()
    assert after != before


# ── EP6 ────────────────────────────────────────────────────────────────


def test_the_script_refuses_to_write_a_proof_over_the_committed_subset(tmp_path, monkeypatch, capsys):
    script = _load_script()
    out = tmp_path / "engineProof.json"
    monkeypatch.setattr(script, "_full_scope_available", lambda: False)
    code = script.main(["--out", str(out)])
    printed = capsys.readouterr().out
    assert code == 2, printed
    assert not out.exists(), "a subset proof was written"
    assert "NOT MEASURED" in printed and "silently shrink" in printed
