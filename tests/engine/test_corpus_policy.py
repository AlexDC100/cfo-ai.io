"""Corpus data-hygiene gate — the enforcer, enforced.

`scripts/check_corpus_policy.py` answers exactly one question: "is the
tree I am about to ship clean?". Three properties have to hold for that
answer to be worth anything, and each one is a layer below:

  1. IT PASSES HERE, AND IT PASSES HONESTLY. The real tree is green even
     though a non-anonymized blob exists in this repository's past. That
     is the whole point of the tree-only design — see
     `docs/decisions/ADR-corpus-history-sibiu.md`. A gate that went red
     on the historical blob would be red forever by design, and a
     permanently-red control is one people learn to skip.

  2. IT NEVER READS HISTORY. Enforced twice: by grepping this gate's own
     source for archaeology subcommands, and by calling its single git
     entry point with a history subcommand and requiring a refusal. The
     source-grep matters because a mock can be satisfied by code that
     would still shell out in production.

  3. IT STILL BITES. The gate was rebuilt after producing 115 findings
     of which zero were real. Precision that was bought by simply
     matching less would be a regression dressed as a fix, so the tests
     below plant real violations and require each to be caught: a
     lexicon term, an identifier inside a data payload, an
     un-anonymized real corpus case, and an unjustified exemption.

WHY NO REAL LEXICON TERM APPEARS IN THIS FILE
    The terms this gate hunts for are stored as salted digests, never as
    plaintext, precisely so that grepping the repository never surfaces
    them. A test that hard-coded one would put it back — in a tracked
    file, which the gate scans. `pdf_scrambler.lexicon_override` exists
    for this: the matching machinery is exercised against a fabricated
    term, and it is the same code path the real lexicon runs through.
    The real terms are proven caught by layer 1 (the tree is green only
    because the real hits were fixed or explicitly exempted).

WHY THE SCRUB SCRIPT IS LOCATED BY GLOB
    `scripts/check_scrub_tooling_unreachable.py` fails any executable
    file in the tree that names the operator-only scrub directory,
    because such a file is one `run:` line from being reachable from
    automation. This file is `.py`, so it is swept. It therefore finds
    the script by its distinctive basename instead of hard-coding the
    directory name — deliberately, not incidentally.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "check_corpus_policy.py"


def _load_gate():
    for extra in (REPO / "src", REPO / "scripts"):
        if str(extra) not in sys.path:
            sys.path.insert(0, str(extra))
    spec = importlib.util.spec_from_file_location("check_corpus_policy", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


@pytest.fixture(scope="module")
def gate():
    return _load_gate()


@pytest.fixture(scope="module")
def lex():
    import pdf_scrambler

    return pdf_scrambler


#: A term that is emphatically not sensitive, used to prove the
#: named-entity machinery without writing a real one down. Kept ASCII
#: deliberately — see `test_known_limitation_multi_word_diacritics`.
FAKE_TERM = "Acme Works Ltd"
FAKE_CATEGORY = "company_legal_name"


def _write(root: Path, rel: str, text: str) -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


# ────────────────────────────────────────────────────────────────────
# 1. The real tree passes — despite the blob in history
# ────────────────────────────────────────────────────────────────────


def test_gate_script_exists():
    assert SCRIPT.is_file(), "the corpus-policy gate itself is missing"


def test_real_tree_passes_via_the_same_invocation_ci_runs():
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)],
        cwd=str(REPO), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    out = proc.stdout.decode("utf-8", "replace")
    assert proc.returncode == 0, "corpus policy is RED on the real tree:\n%s" % out
    assert "CORPUS POLICY: PASS" in out


def test_the_accepted_risk_record_exists_and_is_machine_readable(gate):
    """The history NOTICE is sourced from the ADR file, not from a scan.
    If the ADR loses its counter, the notice silently reports zero and
    the accepted exposure becomes invisible."""
    adr = REPO / gate.DECISIONS_DIR / "ADR-corpus-history-sibiu.md"
    assert adr.is_file(), "the ADR three other files already reference is missing"
    notice = gate.history_notice()
    assert "risk-accepted plaintext blob" in notice
    assert "0 risk-accepted" not in notice, (
        "the ADR is present but its `%s` counter did not parse — the gate "
        "would under-report the accepted exposure. Notice was: %s"
        % (gate.ADR_COUNT_KEY, notice)
    )


def test_exemptions_are_printed_on_every_run_even_when_green():
    """An exemption that stops being visible has stopped being reviewed."""
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)],
        cwd=str(REPO), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    out = proc.stdout.decode("utf-8", "replace")
    assert proc.returncode == 0
    assert "EXEMPT" in out, "exemptions must be surfaced on every run, not only on failure"
    assert "exemption(s) on file" in out


# ────────────────────────────────────────────────────────────────────
# 2. It never reads history
# ────────────────────────────────────────────────────────────────────


def test_gate_source_names_no_history_subcommand():
    """Source-level proof. A mocked-subprocess test can be satisfied by
    code that would still shell out in production; this cannot."""
    source = SCRIPT.read_text(encoding="utf-8")
    body = source.split('"""', 2)[-1]  # skip the module docstring
    for archaeology in (
        "rev-list", "cat-file", "for-each-ref", "diff-tree",
        "reflog", "fsck", "show-ref",
    ):
        assert archaeology not in body, (
            "the gate's source names `git %s`; it must judge the working "
            "tree only" % archaeology
        )
    assert '"git log"' not in body and "'git log'" not in body


def test_only_ls_files_is_allowed(gate):
    assert gate._GIT_ALLOWED_SUBCOMMANDS == ("ls-files",)


@pytest.mark.parametrize("subcommand", ["log", "rev-list", "cat-file", "show", "rev-parse"])
def test_git_entry_point_refuses_history_subcommands(gate, subcommand):
    with pytest.raises(gate.GateError):
        gate._git(subcommand, "--all")


def test_git_entry_point_refuses_an_empty_call(gate):
    with pytest.raises(gate.GateError):
        gate._git()


# ────────────────────────────────────────────────────────────────────
# 3a. It bites — a planted lexicon term
# ────────────────────────────────────────────────────────────────────


def test_planted_lexicon_term_is_caught(gate, lex, tmp_path, monkeypatch):
    _write(tmp_path, "docs/notes.md", "prepared for %s in 2019\n" % FAKE_TERM)
    monkeypatch.setattr(gate, "REPO", tmp_path)
    with lex.lexicon_override([(FAKE_CATEGORY, lex.term_hash(FAKE_TERM))]):
        violations, exempted, _skipped = gate.check_lexicon(["docs/notes.md"], [])
    assert not exempted
    assert [(v.path, v.category) for v in violations] == [
        ("docs/notes.md", FAKE_CATEGORY)
    ]


def test_a_term_outside_the_lexicon_is_not_a_violation(gate, lex, tmp_path, monkeypatch):
    """The core precision property: shapes are not violations, terms are."""
    _write(tmp_path, "docs/notes.md", "prepared for Some Other Company SRL\n")
    monkeypatch.setattr(gate, "REPO", tmp_path)
    with lex.lexicon_override([(FAKE_CATEGORY, lex.term_hash(FAKE_TERM))]):
        violations, _exempted, _skipped = gate.check_lexicon(["docs/notes.md"], [])
    assert violations == []


def test_case_and_spacing_variants_of_a_lexicon_term_are_caught(gate, lex, tmp_path, monkeypatch):
    """One digest has to cover every spelling an exporter might emit —
    the redacted PDF itself contains more than one casing of the same
    site name."""
    _write(tmp_path, "a.md", "%s\n" % FAKE_TERM.upper())
    _write(tmp_path, "b.md", "%s\n" % FAKE_TERM.replace(" ", "  "))
    monkeypatch.setattr(gate, "REPO", tmp_path)
    with lex.lexicon_override([(FAKE_CATEGORY, lex.term_hash(FAKE_TERM))]):
        violations, _exempted, _skipped = gate.check_lexicon(["a.md", "b.md"], [])
    assert sorted(v.path for v in violations) == ["a.md", "b.md"]


def test_known_limitation_multi_word_diacritics_are_missed(gate, lex, tmp_path, monkeypatch):
    """DOCUMENTED GAP, not an accident — registered as R8 in the ADR.

    The n-gram assembler tokenizes the RAW text (`[0-9A-Za-z]+`) before
    folding, so a diacritic acts as a token separator. A SINGLE-word
    term survives that, because the character slice spans the accented
    character; a MULTI-word term does not, because the extra tokens push
    the phrase past MAX_TERM_TOKENS.

    This does not bite the shipped lexicon — its multi-word terms are
    ASCII as printed in the source document, and its accented term is a
    single word. The test exists so the gap stays visible if the lexicon
    is ever extended with an accented multi-word term, and it lives here
    rather than being silently tolerated. Fixing it means folding before
    tokenizing in `pdf_scrambler.find_sensitive_spans`, which is a
    change to the redactor, not to this gate.
    """
    accented = "Ácmé Wörks Ltd"
    single = "Bãnu"
    _write(tmp_path, "multi.md", "%s\n" % accented)
    _write(tmp_path, "single.md", "%s\n" % single)
    monkeypatch.setattr(gate, "REPO", tmp_path)

    with lex.lexicon_override([(FAKE_CATEGORY, lex.term_hash(accented))]):
        multi, _e, _s = gate.check_lexicon(["multi.md"], [])
    with lex.lexicon_override([(FAKE_CATEGORY, lex.term_hash(single))]):
        one, _e, _s = gate.check_lexicon(["single.md"], [])

    assert multi == [], "gap closed upstream — delete this test and ADR R8"
    assert len(one) == 1, "single-word accented terms must still be caught"


def test_lexicon_term_is_caught_tree_wide_not_only_in_data_payloads(
    gate, lex, tmp_path, monkeypatch
):
    """Regression guard. An earlier revision scanned named entities only
    under corpus/ and in files with a data suffix, which is exactly how a
    tracked JSON regression baseline carrying the legal name went
    unnoticed. Scope was the bug."""
    _write(tmp_path, "src/engine/fixtures/baseline.json",
           '{"company": "%s"}\n' % FAKE_TERM)
    monkeypatch.setattr(gate, "REPO", tmp_path)
    assert not gate.is_data_payload("src/engine/fixtures/baseline.json")
    with lex.lexicon_override([(FAKE_CATEGORY, lex.term_hash(FAKE_TERM))]):
        violations, _exempted, _skipped = gate.check_lexicon(
            ["src/engine/fixtures/baseline.json"], []
        )
    assert len(violations) == 1


# ────────────────────────────────────────────────────────────────────
# 3b. It bites — identifiers, but only where they mean something
# ────────────────────────────────────────────────────────────────────


def test_identifier_in_a_data_payload_is_caught(gate, tmp_path, monkeypatch):
    _write(tmp_path, "corpus/case/input.csv",
           "cont,nume\n401,Furnizor CUI 13068741\n")
    monkeypatch.setattr(gate, "REPO", tmp_path)
    violations, _exempted, _skipped = gate.check_lexicon(["corpus/case/input.csv"], [])
    assert [v.category for v in violations] == [gate.TIER_B_CATEGORY]


def test_identifier_in_source_code_is_not_reported_without_corroboration(
    gate, tmp_path, monkeypatch
):
    """A public company registration in a public-records parser is not a
    disclosure. Reporting it is how a gate earns its 115 false positives."""
    _write(tmp_path, "src/engine/parser.py", "# validated against CUI 13068741\n")
    monkeypatch.setattr(gate, "REPO", tmp_path)
    violations, _exempted, _skipped = gate.check_lexicon(["src/engine/parser.py"], [])
    assert violations == []


def test_identifier_in_source_code_IS_reported_when_a_lexicon_term_sits_beside_it(
    gate, lex, tmp_path, monkeypatch
):
    _write(tmp_path, "src/engine/parser.py",
           "# %s, CUI 13068741\n" % FAKE_TERM)
    monkeypatch.setattr(gate, "REPO", tmp_path)
    with lex.lexicon_override([(FAKE_CATEGORY, lex.term_hash(FAKE_TERM))]):
        violations, _exempted, _skipped = gate.check_lexicon(["src/engine/parser.py"], [])
    assert {v.category for v in violations} == {FAKE_CATEGORY, gate.TIER_B_CATEGORY}


def test_fabricated_demo_identifiers_are_not_violations(gate, tmp_path, monkeypatch):
    """`RO99999999` / `J40/9999/2020` ship on purpose in the customer
    example workbooks. Failing on them only teaches people to weaken the
    gate, and a real registration never has that shape."""
    _write(tmp_path, "corpus/case/input.csv",
           "CIF,RO99999999\nRegCom,J40/9999/2020\n")
    monkeypatch.setattr(gate, "REPO", tmp_path)
    violations, _exempted, _skipped = gate.check_lexicon(["corpus/case/input.csv"], [])
    assert violations == []


def test_long_numeric_data_is_not_mistaken_for_an_identifier(gate, tmp_path, monkeypatch):
    """Thirteen-digit map coordinates were 33 of the original 115
    findings. A CNP has structure and a control digit; a coordinate does
    not."""
    _write(tmp_path, "corpus/case/geo.csv",
           "x,y\n5287210462416,9438248508771\n")
    monkeypatch.setattr(gate, "REPO", tmp_path)
    violations, _exempted, _skipped = gate.check_lexicon(["corpus/case/geo.csv"], [])
    assert violations == []


def test_binary_payloads_are_never_byte_scanned(gate, tmp_path, monkeypatch):
    _write(tmp_path, "assets/logo.png", "")
    (tmp_path / "assets/logo.png").write_bytes(b"\x89PNG\x00\x00CUI 13068741\x00")
    monkeypatch.setattr(gate, "REPO", tmp_path)
    units, reason = gate.text_units("assets/logo.png")
    assert units == [] and reason == "binary"


# ────────────────────────────────────────────────────────────────────
# 3c. It bites — anonymization declarations
# ────────────────────────────────────────────────────────────────────


def test_unanonymized_real_case_fails(gate):
    failures, notices = gate.check_declarations(
        [("corpus/leaky/meta.yaml", {"synthetic": False, "anonymized": False})]
    )
    assert len(failures) == 1 and "not anonymized" in failures[0]
    assert notices == []


def test_unanonymized_real_case_under_private_is_allowed(gate):
    failures, _notices = gate.check_declarations(
        [("corpus/private/leaky/meta.yaml", {"synthetic": False, "anonymized": False})]
    )
    assert failures == []


def test_synthetic_case_may_be_unanonymized(gate):
    failures, _notices = gate.check_declarations(
        [("corpus/fake/meta.yaml", {"synthetic": True, "anonymized": False})]
    )
    assert failures == []


def test_missing_synthetic_declaration_fails(gate):
    failures, _notices = gate.check_declarations([("corpus/x/meta.yaml", {})])
    assert len(failures) == 1 and "missing `synthetic:`" in failures[0]


def test_escape_hatch_passes_but_is_always_announced(gate):
    failures, notices = gate.check_declarations([
        ("corpus/x/meta.yaml",
         {"synthetic": False, "anonymized": False, "anonymized_upstream": True}),
    ])
    assert failures == []
    assert len(notices) == 1 and "escape hatch" in notices[0]


# ────────────────────────────────────────────────────────────────────
# 3d. The exemption register cannot be abused
# ────────────────────────────────────────────────────────────────────


def _allowlist(gate, tmp_path, monkeypatch, text: str):
    _write(tmp_path, "allow.txt", text)
    monkeypatch.setattr(gate, "REPO", tmp_path)
    monkeypatch.setattr(gate, "ALLOWLIST_PATH", "allow.txt")
    return gate.load_allowlist()


def test_exemption_requires_a_reason(gate, tmp_path, monkeypatch):
    entries, failures = _allowlist(gate, tmp_path, monkeypatch,
                                  "a/b.py | site_location |\n")
    assert entries == []
    assert len(failures) == 1 and "NO REASON" in failures[0]


def test_exemption_requires_all_three_fields(gate, tmp_path, monkeypatch):
    entries, failures = _allowlist(gate, tmp_path, monkeypatch,
                                  "a/b.py | site_location\n")
    assert entries == [] and len(failures) == 1


def test_a_reasoned_exemption_parses(gate, tmp_path, monkeypatch):
    entries, failures = _allowlist(
        gate, tmp_path, monkeypatch,
        "# comment\n\na/b.py | site_location | collides with an ordinary noun\n")
    assert failures == []
    assert len(entries) == 1
    assert entries[0].path == "a/b.py"
    assert entries[0].reason == "collides with an ordinary noun"


def test_exemption_cannot_smuggle_a_lexicon_term_into_the_tree(
    gate, lex, tmp_path, monkeypatch
):
    """Without this rule, the file used to silence the leak detector
    becomes the place the leaked term lives."""
    with lex.lexicon_override([(FAKE_CATEGORY, lex.term_hash(FAKE_TERM))]):
        entries, failures = _allowlist(
            gate, tmp_path, monkeypatch,
            "a/b.py | %s | looks reasonable, smuggles the term\n" % FAKE_TERM)
    assert entries == []
    assert len(failures) == 1 and "itself a sensitive lexicon term" in failures[0]


def test_exemption_silences_only_the_path_it_names(gate, lex, tmp_path, monkeypatch):
    _write(tmp_path, "a/exempt.py", "%s\n" % FAKE_TERM)
    _write(tmp_path, "a/other.py", "%s\n" % FAKE_TERM)
    monkeypatch.setattr(gate, "REPO", tmp_path)
    entry = gate.Exemption("a/exempt.py", FAKE_CATEGORY, "reviewed collision", 1)
    with lex.lexicon_override([(FAKE_CATEGORY, lex.term_hash(FAKE_TERM))]):
        violations, exempted, _skipped = gate.check_lexicon(
            ["a/exempt.py", "a/other.py"], [entry])
    assert [v.path for v in violations] == ["a/other.py"]
    assert [f.path for f, _e in exempted] == ["a/exempt.py"]


def test_an_exempted_hit_does_not_corroborate_an_identifier(
    gate, lex, tmp_path, monkeypatch
):
    """A hit reviewed as a coincidence cannot then be used as evidence."""
    _write(tmp_path, "a/ui.py", "%s and CUI 13068741\n" % FAKE_TERM)
    monkeypatch.setattr(gate, "REPO", tmp_path)
    entry = gate.Exemption("a/ui.py", FAKE_CATEGORY, "reviewed collision", 1)
    with lex.lexicon_override([(FAKE_CATEGORY, lex.term_hash(FAKE_TERM))]):
        violations, exempted, _skipped = gate.check_lexicon(["a/ui.py"], [entry])
    assert violations == []
    assert len(exempted) == 1


def test_shipped_allowlist_is_structurally_valid(gate):
    entries, failures = gate.load_allowlist()
    assert failures == [], "the shipped exemption register is malformed: %s" % failures
    assert entries, "expected at least one reviewed exemption on file"
    assert all(e.reason for e in entries)


# ────────────────────────────────────────────────────────────────────
# 4. The scrub script is structurally incapable of rewriting history
#    when invoked without its confirmation flags.
# ────────────────────────────────────────────────────────────────────


def _scrub_script() -> Path:
    """Located by basename on purpose — see the module docstring."""
    matches = sorted(REPO.glob("scripts/*/scrub_sibiu.sh"))
    assert matches, "the operator-only scrub script is missing"
    return matches[0]


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=str(REPO), check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ).stdout.decode("utf-8", "replace")


def test_scrub_script_exists_and_is_executable():
    script = _scrub_script()
    assert script.is_file()
    import os

    assert os.access(str(script), os.X_OK), "the runbook tells operators to ./ it"


def test_scrub_script_refuses_with_no_flags_and_changes_nothing():
    """No flags, ever. Non-zero exit, and the repository is byte-for-byte
    as it was found — same HEAD, same working-tree status."""
    head_before = _git("rev-parse", "HEAD")
    status_before = _git("status", "--porcelain")

    proc = subprocess.run(
        ["bash", str(_scrub_script())],
        cwd=str(REPO), stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    out = proc.stdout.decode("utf-8", "replace")

    assert proc.returncode != 0, "the scrub script ran without confirmation:\n%s" % out
    assert "REFUSED" in out
    assert _git("rev-parse", "HEAD") == head_before, "HEAD MOVED"
    assert _git("status", "--porcelain") == status_before, "the working tree changed"


def test_scrub_script_prints_the_adr_and_the_triggers_even_when_refusing():
    """The refusal is the teaching moment: whoever hit it should learn
    where the decision lives and which triggers make this legitimate."""
    proc = subprocess.run(
        ["bash", str(_scrub_script())],
        cwd=str(REPO), stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    out = proc.stdout.decode("utf-8", "replace")
    assert "docs/decisions/ADR-corpus-history-sibiu.md" in out
    assert "REVIEW TRIGGERS" in out
    for trigger in ("read access", "visibility", "migrated", "leak"):
        assert trigger in out, "trigger list is incomplete: missing %r" % trigger


@pytest.mark.parametrize("flags", [
    ["--i-understand-force-push"],
    ["--maintainer", "Someone"],
])
def test_one_flag_is_not_enough(flags):
    head_before = _git("rev-parse", "HEAD")
    proc = subprocess.run(
        ["bash", str(_scrub_script()), *flags],
        cwd=str(REPO), stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    assert proc.returncode != 0
    assert b"REFUSED" in proc.stdout
    assert _git("rev-parse", "HEAD") == head_before


def test_even_with_both_flags_it_refuses_without_a_terminal():
    """Second line of defence behind the reachability gate: a scheduled
    job has no TTY, so wiring this up still cannot rewrite anything."""
    head_before = _git("rev-parse", "HEAD")
    proc = subprocess.run(
        ["bash", str(_scrub_script()),
         "--i-understand-force-push", "--maintainer", "Someone"],
        cwd=str(REPO), stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    out = proc.stdout.decode("utf-8", "replace")
    assert proc.returncode != 0
    assert "not a terminal" in out
    assert _git("rev-parse", "HEAD") == head_before


def test_runbook_exists_beside_the_script():
    runbook = _scrub_script().parent / "RUNBOOK.md"
    assert runbook.is_file(), "the script tells operators to read it first"
    text = runbook.read_text(encoding="utf-8")
    for topic in ("Freeze pushes", "re-clone", "rebase", "support", "unreachable"):
        assert topic.lower() in text.lower(), "runbook does not cover %r" % topic
