#!/usr/bin/env python3
"""Mutation testing on the engine kernel — scoped mutmut runner + gate.

C1 of the engine-of-record hardening waves: run mutmut 3.3.x against the
frozen numeric kernel, score it honestly, and FAIL when the measured
mutation score of any in-scope module drops below its pinned threshold.

WHAT COUNTS AS THE KERNEL (and exactly which functions) is declared in
``KERNEL_MODULES`` below. Everything else in ``src/engine`` is copied
verbatim into the mutants tree but never mutated.

Design decisions (the why lives in docs/engine_book/mutation.md):

* mutmut 3.3.1 runs IN-PROCESS (this script imports ``mutmut.__main__``
  and drives its click CLI). Reasons:
    - the trampoline emitted into every mutated file does
      ``from mutmut.__main__ import record_trampoline_hit``; under
      ``python -m mutmut`` that RE-EXECUTES __main__ (module registered
      only as ``__main__``) and explodes on the module-level
      ``set_start_method('fork')``. Importing it as a real module first
      (what the ``mutmut`` console script also does) fixes that — and
      in-process is the only way to apply the dataclass patch below.
    - mutmut skips EVERY decorated FunctionDef/ClassDef
      (file_mutation.py: ``len(node.decorators) -> skip``). Our kernel's
      single most important type — ``engine.ir.money.Money`` — is a
      ``@dataclass(frozen=True)``: stock mutmut produces ZERO mutants
      for its methods (46 module-level mutants vs 246 with the patch).
      ``_patch_mutmut_dataclass_classes()`` narrows the skip: a
      ClassDef whose decorators are ALL ``dataclass``/``dataclass(...)``
      is descended into; its *undecorated* methods get mutated.
      Decorated FUNCTIONS stay skipped everywhere (@classmethod /
      @staticmethod / @property trampolines genuinely break — that gap
      is documented per file in mutation.md).

* The run happens in a throwaway WORKDIR (``data/mutation/work`` —
  ``/data/`` is gitignored) so nothing mutmut writes ever lands in the
  repo tree. The workdir holds symlinks to src/tests/files/scripts/
  packs/corpus/methodology/docs/config.yaml plus a GENERATED pyproject.toml
  ([tool.mutmut] + an empty [tool.pytest.ini_options] so pytest's ini
  discovery STOPS inside the mutants tree instead of walking up to the
  repo pyproject and importing its addopts). mutmut copies everything
  it needs into ``<workdir>/mutants/`` and runs tests there — the
  sacred corpus/ and packs/ are only ever READ through the copies.

* ``sitecustomize.py`` (written into the workdir, exported on
  PYTHONPATH): tests that spawn FRESH interpreters (e.g.
  test_ir_types.py TestCrossProcessDeterminism) inherit
  MUTANT_UNDER_TEST. A fresh process cannot contribute to mutmut's
  in-process stats collector, and record_trampoline_hit crashes there
  (mutmut.config is None) — so 'stats' is neutralized to '' for fresh
  interpreters. Named-mutant values are kept: a subprocess-based test
  killing a mutant is a REAL kill.

* Scoring: caught = killed + timeout; missed = survived + no_tests +
  suspicious; score = caught / (caught + missed) over IN-SCOPE mutants
  (the per-module fnmatch filters below) minus the documented
  equivalent mutants (EQUIVALENT_MUTANTS — each entry has a matching
  justification row in docs/engine_book/mutation.md). 'skipped' is
  excluded; any 'not checked' in scope makes the run INCOMPLETE (exit
  2) — a gate must never pass on a partial run.

  CAVEAT (mutant-id stability): mutmut mutant ids are positional per
  function ("<fn>__mutmut_<n>"). ANY edit to a kernel function
  renumbers its mutants and invalidates that function's
  EQUIVALENT_MUTANTS entries — re-triage the function's survivors
  after any sanctioned kernel edit.

Usage:
    .venv/bin/python scripts/run_mutation_kernel.py                # full kernel run + report
    .venv/bin/python scripts/run_mutation_kernel.py --check       # run + threshold gate
    .venv/bin/python scripts/run_mutation_kernel.py --modules money,classify
    .venv/bin/python scripts/run_mutation_kernel.py --files src/engine/ir/money.py --check
                                                                   # PR profile: only touched kernel files
    .venv/bin/python scripts/run_mutation_kernel.py --report-only --check
                                                                   # re-score existing mutants tree, no run

Exit codes: 0 ok / gate passed; 1 gate failed (score below threshold);
2 run incomplete or infrastructure failure.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import shutil
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO = Path(__file__).resolve().parents[1]
WORKDIR_DEFAULT = REPO / "data" / "mutation" / "work"
REPORT_DIR_DEFAULT = REPO / "data" / "mutation"

# ---------------------------------------------------------------------------
# Kernel scope — module name -> {file, filters, threshold}
#
# ``filters`` are fnmatch patterns over mutmut mutant names
# ("engine.api._reconcile.x_validate_proposal__mutmut_3"). Module-level
# function mangling is "x_<name>" (so "_cents" -> "x__cents"); class
# methods are "xǁClassǁ<name>". A pattern must match BOTH the mangled
# function name (test selection) and the mutant name (mutant
# selection), so every pattern ends in '*' and never in '__mutmut_*'.
#
# ``threshold`` is the pinned minimum mutation score (percent, after
# equivalent-mutant exclusions). Measured 2026-08-24 on the final
# --fresh full-kernel run: every default-gate module triaged to 100%
# of scoreable, so the floors ARE 100 — the C1 contract has no third
# category, and any future survivor must force a triage (killing test
# or an EQUIVALENT_MUTANTS row), never ride below a slack floor.
# Kill-vs-survive is deterministic for these suites (derandomized
# hypothesis profile, tmp-path isolation; timeouts count as caught),
# so the 100 floor is not flake-exposed. See docs/engine_book/
# mutation.md for the per-module triage that justifies each number.
# ---------------------------------------------------------------------------

KERNEL_MODULES: Dict[str, Dict[str, Any]] = {
    "money": {
        "file": "src/engine/ir/money.py",
        "filters": ["engine.ir.money.*"],
        "threshold": 100.0,
    },
    "reconcile": {
        # validator + trigger + placement functions ONLY (the AI
        # proposal path, persistence, undo/carry-forward orchestration
        # and HTTP routes are out of scope for C1).
        "file": "src/engine/api/_reconcile.py",
        "filters": [
            "engine.api._reconcile.x__cents*",
            "engine.api._reconcile.x__gate_ok*",
            "engine.api._reconcile.x_compute_reconcile_offer*",
            "engine.api._reconcile.x__recompute_partition_difference_cents*",
            "engine.api._reconcile.x__apply_adjustment*",
            "engine.api._reconcile.x__placement_for*",
            "engine.api._reconcile.x__target_row_id_for*",
            "engine.api._reconcile.x_validate_proposal*",
            "engine.api._reconcile.x__gate_checks*",
        ],
        "threshold": 100.0,
    },
    "classify": {
        "file": "src/engine/passes/classify.py",
        "filters": ["engine.passes.classify.*"],
        "threshold": 100.0,
    },
    "journal_events": {
        "file": "src/engine/journal/events.py",
        "filters": ["engine.journal.events.*"],
        "threshold": 100.0,
    },
    "journal": {
        # HASH-CHAIN scope (the task's own boundary): the append/write
        # path, chain read + verify, run registration/linkage, snapshot
        # recording, and the dedupe identity. DLQ, as-of reconstruction
        # and GC are deliberate C1 non-scope (still battery-tested) —
        # first item on the nightly gap-closure list in mutation.md.
        "file": "src/engine/journal/journal.py",
        "filters": [
            "engine.journal.journal.x_sanitize_key*",
            "engine.journal.journal.x_extract_snapshot_key*",
            "engine.journal.journal.x_normalized_envelope*",
            "engine.journal.journal.xǁRunHandleǁemit*",
            "engine.journal.journal.xǁRunHandleǁflush*",
            "engine.journal.journal.xǁRunHandleǁ_ensure_registered*",
            "engine.journal.journal.xǁRunHandleǁrecord_snapshot*",
            "engine.journal.journal.xǁJournalǁ_run_path*",
            "engine.journal.journal.xǁJournalǁ_index_path*",
            "engine.journal.journal.xǁJournalǁ_append_line*",
            "engine.journal.journal.xǁJournalǁ_append_event*",
            "engine.journal.journal.xǁJournalǁ_append_index*",
            "engine.journal.journal.xǁJournalǁread_run*",
            "engine.journal.journal.xǁJournalǁread_index*",
            "engine.journal.journal.xǁJournalǁregistered_runs*",
            "engine.journal.journal.xǁJournalǁchain_events*",
            "engine.journal.journal.xǁJournalǁchain_tail*",
            "engine.journal.journal.xǁJournalǁbegin_run*",
            "engine.journal.journal.xǁJournalǁobserve_serving*",
            "engine.journal.journal.xǁJournalǁverify_chain*",
        ],
        "threshold": 100.0,
    },
    "canonical_bs_v2": {
        # build_canonical_bs_v2 region only: the v2 assembler entry
        # point plus the private helpers that exist for it.
        #
        # EXCLUDED FROM THE DEFAULT GATE (default_gate False): the
        # measured first run projects 75-90 minutes on a 14-core
        # machine — dominated by timeout mutants (loop mutations in the
        # 600-line cents accumulator each burn ~30x their covering
        # tests' CPU before SIGXCPU fires). Run it explicitly with
        # --modules canonical_bs_v2 in a dedicated nightly job with its
        # own budget; see docs/engine_book/mutation.md.
        "default_gate": False,
        "file": "src/engine/country_packs/ro_romania/canonical_adapter.py",
        "filters": [
            "engine.country_packs.ro_romania.canonical_adapter.x_build_canonical_bs_v2*",
            "engine.country_packs.ro_romania.canonical_adapter.x__cents*",
            "engine.country_packs.ro_romania.canonical_adapter.x__section_for_leaf*",
            "engine.country_packs.ro_romania.canonical_adapter.x__matched_ras_prefix*",
            "engine.country_packs.ro_romania.canonical_adapter.x__excluded_reason*",
        ],
        "threshold": 85.0,
    },
}

# Overall floor across all in-scope kernel mutants (after exclusions).
OVERALL_THRESHOLD = 100.0

# ---------------------------------------------------------------------------
# Documented equivalent mutants — excluded from the score denominator.
# EVERY id here MUST have a justification row in
# docs/engine_book/mutation.md (same id). No entry lands here without
# one. Ids are position-sensitive (see module docstring caveat).
# ---------------------------------------------------------------------------

EQUIVALENT_MUTANTS = frozenset({
    # (each id has a matching justification row in
    # docs/engine_book/mutation.md — keep the two in lockstep)
    #
    # -- engine.journal.events: "utf-8" -> "UTF-8" codec alias (Python
    #    codec lookup is case-insensitive; identical bytes for every
    #    input, both paths).
    "engine.journal.events.x_canonical_bytes__mutmut_15",
    "engine.journal.events.x_canonical_bytes__mutmut_33",
    # -- engine.journal.events: ensure_ascii=False -> None. json.dumps
    #    only truth-tests ensure_ascii (falsy selects the raw-UTF-8
    #    encoder), so None is behaviorally identical to False on both
    #    the strict and the default=str fallback path.
    "engine.journal.events.x_canonical_bytes__mutmut_4",
    "engine.journal.events.x_canonical_bytes__mutmut_20",
    #
    # -- engine.api._reconcile: the `or "" -> or "XXXX"` sentinel family.
    #    The fallback string only ever feeds ==/`in` probes against fixed
    #    vocabularies that contain neither "" nor "XXXX"; it is never
    #    stored or returned. Identical control flow for every input.
    "engine.api._reconcile.x_compute_reconcile_offer__mutmut_10",
    "engine.api._reconcile.x__gate_checks__mutmut_37",
    "engine.api._reconcile.x__recompute_partition_difference_cents__mutmut_19",
    "engine.api._reconcile.x__apply_adjustment__mutmut_48",
    "engine.api._reconcile.x__apply_adjustment__mutmut_99",
    "engine.api._reconcile.x__apply_adjustment__mutmut_118",
    "engine.api._reconcile.x__placement_for__mutmut_7",
    "engine.api._reconcile.x__target_row_id_for__mutmut_11",
    #
    # -- validate_proposal gate clauses share ONE raise site: shifting
    #    which OR-clause fires (denom <=0 -> <0 at denom==0, <=0 -> <=1
    #    at denom==1) raises the SAME exception with the SAME payload —
    #    the gate clause catches everything the mutated clause released.
    "engine.api._reconcile.x_validate_proposal__mutmut_44",
    "engine.api._reconcile.x_validate_proposal__mutmut_45",
    #
    # -- _gate_ok guard-clause shifts, the boolean twin of the above:
    #    denom = max(abs, abs) is never negative (`<= 0` -> `< 0` frees
    #    only denom==0, where `|diff|*1000 <= 0` still answers False for
    #    every diff the `diff == 0` clause lets through), and no nonzero
    #    diff can satisfy `|diff|*1000 <= denom` for denom in {0, 1}
    #    (`<= 0` -> `<= 1`). Guard and ratio agree on every input —
    #    verified by exhaustive sweep over the boundary band.
    "engine.api._reconcile.x__gate_ok__mutmut_9",
    "engine.api._reconcile.x__gate_ok__mutmut_10",
    #
    # -- classify: the UNCLASSIFIED-branch constructor drops its
    #    `side_flipped=False` keyword — False IS the dataclass default
    #    (AtomClassification.side_flipped: bool = False), so the emitted
    #    entry is field-for-field identical for every input. A
    #    redundant-kwarg generation artifact, not a behavior.
    "engine.passes.classify.x_classify__mutmut_35",
    #
    # -- validator-trial placement: validate_proposal discards the trial
    #    after reading its close sums, and both placements move the SAME
    #    amount onto the E+L side (result row vs synthetic row) — the
    #    close sums are placement-invariant by construction, so forcing
    #    the trial to BS placement cannot change accept/reject.
    "engine.api._reconcile.x_validate_proposal__mutmut_73",
    "engine.api._reconcile.x_validate_proposal__mutmut_77",
    #
    # -- _apply_adjustment `elif amount_cents > 0 -> >= 0`: amount 0 is
    #    unreachable at every call site (validate_proposal rejects zero
    #    amounts; perform/auto gate on nonzero diff; carry-forward
    #    replays accepted nonzero receipts). Equivalent modulo reachable
    #    inputs — revisit if a new caller ever passes 0.
    "engine.api._reconcile.x__apply_adjustment__mutmut_158",
    #
    # -- _placement_for `> 0 -> >= 0` inside the income/expense ternary,
    #    which only evaluates under the enclosing `amount_cents != 0`
    #    guard — the two comparisons agree on every nonzero amount.
    "engine.api._reconcile.x__placement_for__mutmut_17",
    #
    # -- journal: RunHandle.flush `self._buffer = None` at the end.
    #    _buffer is only read under provisional=True; flush's first act
    #    is provisional=False and nothing ever re-enables it (the dup
    #    short-circuit path ASSIGNS [] rather than reading). Unreachable.
    "engine.journal.journal.xǁRunHandleǁflush__mutmut_9",
    # -- journal: same for the duplicate short-circuit path's
    #    `self._buffer = None` in record_snapshot — short_circuited=True
    #    makes every subsequent emit/flush/record_snapshot return before
    #    any _buffer read.
    "engine.journal.journal.xǁRunHandleǁrecord_snapshot__mutmut_69",
    # -- journal: observe_serving drops `period_id=None` from the
    #    record_snapshot call — identical to passing the default.
    "engine.journal.journal.xǁJournalǁobserve_serving__mutmut_52",
    # -- journal: _append_line fcntl guard flips (16: skip flock when
    #    present / 27: same for unlock). flock is a cross-PROCESS
    #    concurrency guard; single-process tests cannot observe its
    #    absence deterministically, and the lock is released at file
    #    close regardless. Accepted as design-reviewed concurrency
    #    hardening, not unit-killable.
    "engine.journal.journal.xǁJournalǁ_append_line__mutmut_16",
    "engine.journal.journal.xǁJournalǁ_append_line__mutmut_27",
    # -- journal: mutmut generation artifacts — the emitted mutant
    #    bodies are byte-identical to the original function (mutation
    #    landed in the `except OSError: pass` guard and rendered to the
    #    same source). Verified with a raw source diff.
    "engine.journal.journal.xǁJournalǁ_append_line__mutmut_24",
    "engine.journal.journal.xǁJournalǁ_append_line__mutmut_25",
})

# Test files given to mutmut as tests_dir (stats phase + fallback
# clean-run set). Everything here must pass INSIDE the mutants tree.
TESTS_DIR: List[str] = [
    "tests/engine/test_ir_types.py",
    "tests/engine/test_ir_invariants.py",
    "tests/engine/test_properties.py",
    "tests/engine/test_reconciliation.py",
    "tests/engine/test_envelope_contract.py",
    "tests/engine/test_metamorphic.py",
    "tests/engine/test_shadow_divergence.py",
    "tests/engine/test_assertion_witnesses.py",
    "tests/engine/test_journal.py",
    "tests/engine/test_crash_safety.py",
    "tests/engine/test_canonical_bs_invariants.py",
    "tests/engine/test_omfp_rules.py",
    "tests/engine/test_mutation_regressions.py",
]

# Repo-root resources the tests read (REPO-relative paths resolved
# against the mutants tree by the suites' own conftest logic).
ALSO_COPY = ["files", "scripts", "packs", "corpus", "methodology", "docs", "config.yaml"]

SYMLINKS = ["src", "tests", "files", "scripts", "packs", "corpus", "methodology", "docs", "config.yaml"]

STATUS_BY_EXIT_CODE = {
    1: "killed",
    3: "killed",       # pytest internal error counts as a kill
    0: "survived",
    5: "no tests",
    2: "interrupted",
    None: "not checked",
    33: "no tests",
    34: "skipped",
    35: "suspicious",
    36: "timeout",
    -24: "timeout",
    24: "timeout",
    152: "timeout",
    255: "timeout",
    -11: "segfault",
}

CAUGHT = {"killed", "timeout"}
MISSED = {"survived", "no tests", "suspicious"}
EXCLUDED = {"skipped"}
INCOMPLETE = {"not checked", "interrupted", "segfault"}


# ---------------------------------------------------------------------------
# Workdir provisioning
# ---------------------------------------------------------------------------


def provision_workdir(workdir: Path, kernel_files: List[str]) -> None:
    workdir.mkdir(parents=True, exist_ok=True)
    for name in SYMLINKS:
        target = REPO / name
        link = workdir / name
        if not target.exists():
            raise SystemExit("missing repo resource: %s" % target)
        if link.is_symlink() or link.exists():
            if link.is_symlink() and Path(os.readlink(str(link))) == target:
                continue
            if link.is_symlink():
                link.unlink()
            else:
                raise SystemExit(
                    "%s exists and is not the expected symlink — refusing to touch it"
                    % link
                )
        link.symlink_to(target)

    # do_not_mutate: EVERY engine .py except the kernel files of this
    # invocation — enumerated exactly, regenerated per run, so new
    # engine modules are never accidentally mutated.
    all_py = sorted(
        str(p.relative_to(REPO)) for p in (REPO / "src" / "engine").rglob("*.py")
    )
    ignore = [p for p in all_py if p not in set(kernel_files)]

    lines: List[str] = ["# GENERATED by scripts/run_mutation_kernel.py — do not edit", "[tool.mutmut]"]
    lines.append('paths_to_mutate = ["src/engine"]')
    lines.append("do_not_mutate = [")
    for p in ignore:
        lines.append('    "%s",' % p)
    lines.append("]")
    lines.append("also_copy = [")
    for p in ALSO_COPY:
        lines.append('    "%s",' % p)
    lines.append("]")
    lines.append("tests_dir = [")
    for t in TESTS_DIR:
        if (REPO / t).exists():
            lines.append('    "%s",' % t)
    lines.append("]")
    lines.append("debug = false")
    lines.append("")
    # The empty pytest section is load-bearing: it stops pytest's ini
    # discovery INSIDE the mutants tree (otherwise it walks up to the
    # repo pyproject and inherits its addopts -v --tb=short, and ini
    # path conflicts break collection with exit code 4).
    lines.append("[tool.pytest.ini_options]")
    lines.append('addopts = ""')
    (workdir / "pyproject.toml").write_text("\n".join(lines) + "\n", encoding="utf-8")

    # Fresh interpreters spawned BY tests inherit MUTANT_UNDER_TEST but
    # can never reach mutmut's in-process stats collector — and
    # record_trampoline_hit crashes without a loaded config. Neutralize
    # ONLY the 'stats' phase there; named mutants stay live so
    # subprocess-based tests can genuinely kill them.
    (workdir / "sitecustomize.py").write_text(
        "import os\n"
        "if os.environ.get('MUTANT_UNDER_TEST') == 'stats':\n"
        "    os.environ['MUTANT_UNDER_TEST'] = ''\n",
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# mutmut dataclass patch (see module docstring)
# ---------------------------------------------------------------------------


def _patch_mutmut_dataclass_classes() -> None:
    import libcst as cst
    from mutmut import file_mutation as fm

    if getattr(fm.MutationVisitor._skip_node_and_children, "_kernel_patched", False):
        return
    orig_skip = fm.MutationVisitor._skip_node_and_children

    def _decorator_is_dataclass(dec: "cst.Decorator") -> bool:
        node = dec.decorator
        if isinstance(node, cst.Call):
            node = node.func
        if isinstance(node, cst.Name):
            return node.value == "dataclass"
        if isinstance(node, cst.Attribute) and isinstance(node.attr, cst.Name):
            return node.attr.value == "dataclass"
        return False

    def patched(self, node):  # type: ignore[no-untyped-def]
        if (
            isinstance(node, cst.ClassDef)
            and node.decorators
            and all(_decorator_is_dataclass(d) for d in node.decorators)
        ):
            return False
        return orig_skip(self, node)

    patched._kernel_patched = True  # type: ignore[attr-defined]
    fm.MutationVisitor._skip_node_and_children = patched


# ---------------------------------------------------------------------------
# Run + parse
# ---------------------------------------------------------------------------


def run_mutmut(workdir: Path, filters: List[str], max_children: Optional[int]) -> int:
    """Drive mutmut's CLI in-process from the workdir. Returns the exit
    code (0 = the run completed; mutant kills/survivals live in .meta)."""
    assert "engine" not in sys.modules, (
        "run_mutation_kernel must not import engine before mutmut runs — "
        "a preloaded pristine engine would shadow the mutants tree"
    )
    _patch_mutmut_dataclass_classes()

    os.environ["PYTHONPATH"] = (
        str(workdir) + os.pathsep + os.environ.get("PYTHONPATH", "")
    ).rstrip(os.pathsep)
    # Never let a caller's pytest env leak flags into the mutant runs.
    os.environ.pop("PYTEST_ADDOPTS", None)
    # Keep the property suite on its derandomized "ci" profile: with
    # HYPOTHESIS_PROFILE=deep leaking in, kills would depend on fresh
    # entropy and the score would jitter run-to-run.
    os.environ.pop("HYPOTHESIS_PROFILE", None)
    # macOS fork-safety belt-and-braces for the os.fork() mutant
    # children (CoreFoundation APIs abort in forked children).
    os.environ.setdefault("OBJC_DISABLE_INITIALIZE_FORK_SAFETY", "YES")
    os.environ.setdefault("no_proxy", "*")

    import mutmut.__main__ as mutmut_main  # registers 'mutmut.__main__' in sys.modules

    # macOS: the FIRST thing mutmut's forked child does is
    # setproctitle(f'mutmut: {name}') — whose darwin backend loads a
    # CFBundle (CoreFoundation) INSIDE the forked child and dies with
    # SIGSEGV. Measured: 246/246 money mutants 'segfault', crash report
    # faulting frames spt_setproctitle -> darwin_set_process_title ->
    # _CFBundleLoadExecutableAndReturnError. The title is cosmetic;
    # no-op it. (The OBJC env guard above does NOT cover this path.)
    if sys.platform == "darwin":
        mutmut_main.setproctitle = lambda *a, **k: None

    cli = mutmut_main.cli

    argv = ["run"]
    if max_children:
        argv += ["--max-children", str(max_children)]
    argv += filters
    old_cwd = os.getcwd()
    os.chdir(str(workdir))
    try:
        cli.main(args=argv, prog_name="mutmut", standalone_mode=False)
        return 0
    except SystemExit as exc:  # mutmut calls exit() on infrastructure failures
        code = exc.code
        return int(code) if isinstance(code, int) else (0 if code is None else 2)
    finally:
        os.chdir(old_cwd)


def load_results(workdir: Path) -> Dict[str, Optional[int]]:
    """{mutant_name: exit_code} across every kernel .meta in the mutants tree."""
    out: Dict[str, Optional[int]] = {}
    for meta_path in sorted((workdir / "mutants" / "src").rglob("*.py.meta")):
        with open(str(meta_path)) as f:
            meta = json.load(f)
        out.update(meta.get("exit_code_by_key") or {})
    return out


def score_modules(
    results: Dict[str, Optional[int]],
    modules: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    report: Dict[str, Any] = {"modules": {}, "generated_at": datetime.now(timezone.utc).isoformat()}
    overall = Counter()
    overall_excluded_equivalents = 0
    for name, spec in modules.items():
        statuses: Counter = Counter()
        survivors: List[str] = []
        equivalents_seen: List[str] = []
        for mutant, exit_code in results.items():
            if not any(fnmatch.fnmatch(mutant, pat) for pat in spec["filters"]):
                continue
            if mutant in EQUIVALENT_MUTANTS:
                equivalents_seen.append(mutant)
                continue
            status = STATUS_BY_EXIT_CODE.get(exit_code, "not checked")
            statuses[status] += 1
            if status in MISSED:
                survivors.append("%s: %s" % (mutant, status))
        caught = sum(statuses[s] for s in CAUGHT)
        missed = sum(statuses[s] for s in MISSED)
        incomplete = sum(statuses[s] for s in INCOMPLETE)
        denom = caught + missed
        score = (100.0 * caught / denom) if denom else None
        report["modules"][name] = {
            "file": spec["file"],
            "threshold": spec["threshold"],
            "statuses": dict(statuses),
            "caught": caught,
            "missed": missed,
            "incomplete": incomplete,
            "equivalents_excluded": len(equivalents_seen),
            "score": round(score, 2) if score is not None else None,
            "survivors": sorted(survivors),
        }
        overall.update({"caught": caught, "missed": missed, "incomplete": incomplete})
        overall_excluded_equivalents += len(equivalents_seen)
    denom = overall["caught"] + overall["missed"]
    report["overall"] = {
        "caught": overall["caught"],
        "missed": overall["missed"],
        "incomplete": overall["incomplete"],
        "equivalents_excluded": overall_excluded_equivalents,
        "score": round(100.0 * overall["caught"] / denom, 2) if denom else None,
        "threshold": OVERALL_THRESHOLD,
    }
    return report


def print_report(report: Dict[str, Any]) -> None:
    print()
    print("mutation kernel report — %s" % report["generated_at"])
    print("-" * 78)
    for name, mod in report["modules"].items():
        score = "%6.2f%%" % mod["score"] if mod["score"] is not None else "   n/a"
        print(
            "%-16s %s  (caught %d / missed %d / incomplete %d / equiv-excluded %d)  floor %.0f%%"
            % (
                name,
                score,
                mod["caught"],
                mod["missed"],
                mod["incomplete"],
                mod["equivalents_excluded"],
                mod["threshold"],
            )
        )
        for s in mod["survivors"]:
            print("    SURVIVOR  %s" % s)
    o = report["overall"]
    print("-" * 78)
    print(
        "OVERALL          %s  (caught %d / missed %d / incomplete %d)  floor %.0f%%"
        % (
            "%6.2f%%" % o["score"] if o["score"] is not None else "   n/a",
            o["caught"],
            o["missed"],
            o["incomplete"],
            o["threshold"],
        )
    )


def gate(report: Dict[str, Any]) -> int:
    failures: List[str] = []
    incomplete = 0
    for name, mod in report["modules"].items():
        incomplete += mod["incomplete"]
        if mod["score"] is None:
            if mod["caught"] + mod["missed"] + mod["incomplete"] == 0:
                # module not part of this (scoped) run — not a failure
                continue
            failures.append("%s: no scoreable mutants" % name)
        elif mod["score"] < mod["threshold"]:
            failures.append(
                "%s: %.2f%% < floor %.2f%%" % (name, mod["score"], mod["threshold"])
            )
    o = report["overall"]
    if o["score"] is not None and o["score"] < o["threshold"]:
        failures.append("overall: %.2f%% < floor %.2f%%" % (o["score"], o["threshold"]))
    if incomplete:
        print("GATE: INCOMPLETE RUN — %d in-scope mutants not checked" % incomplete)
        return 2
    if failures:
        for f in failures:
            print("GATE FAIL: %s" % f)
        return 1
    print("GATE: PASS")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--modules", help="comma-separated subset of: %s" % ",".join(KERNEL_MODULES))
    ap.add_argument(
        "--files",
        help="comma-separated file paths (PR profile): run only kernel modules "
        "whose file is in this list; exits 0 without running when none match",
    )
    ap.add_argument("--check", action="store_true", help="enforce pinned thresholds")
    ap.add_argument("--report-only", action="store_true", help="score existing mutants tree; no run")
    ap.add_argument("--fresh", action="store_true", help="wipe the mutants tree before running")
    ap.add_argument("--max-children", type=int, default=None)
    ap.add_argument("--workdir", type=Path, default=WORKDIR_DEFAULT)
    ap.add_argument("--json-out", type=Path, default=REPORT_DIR_DEFAULT / "report-latest.json")
    args = ap.parse_args()

    selected = {
        name: spec
        for name, spec in KERNEL_MODULES.items()
        if spec.get("default_gate", True)
    }
    if args.modules:
        names = [m.strip() for m in args.modules.split(",") if m.strip()]
        unknown = [m for m in names if m not in KERNEL_MODULES]
        if unknown:
            print("unknown modules: %s" % ", ".join(unknown))
            return 2
        selected = {m: KERNEL_MODULES[m] for m in names}
    if args.files:
        wanted = {f.strip().lstrip("./") for f in args.files.split(",") if f.strip()}
        selected = {
            name: spec for name, spec in selected.items() if spec["file"] in wanted
        }
        if not selected:
            print("no kernel files touched — mutation gate out of scope, passing")
            return 0

    workdir = args.workdir
    if not args.report_only:
        if args.fresh and (workdir / "mutants").exists():
            shutil.rmtree(str(workdir / "mutants"))
        kernel_files = [spec["file"] for spec in KERNEL_MODULES.values()]
        provision_workdir(workdir, kernel_files)
        filters = [pat for spec in selected.values() for pat in spec["filters"]]
        code = run_mutmut(workdir, filters, args.max_children)
        if code not in (0,):
            print("mutmut run failed with exit code %s" % code)
            return 2

    results = load_results(workdir)
    if not results:
        print("no mutation results found under %s/mutants" % workdir)
        return 2
    report = score_modules(results, selected)
    print_report(report)
    args.json_out.parent.mkdir(parents=True, exist_ok=True)
    with open(str(args.json_out), "w") as f:
        json.dump(report, f, indent=2, sort_keys=True)
    print("report written: %s" % args.json_out)

    if args.check:
        return gate(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
