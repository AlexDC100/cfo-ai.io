"""OFFLINE == SERVED. Same file, same P&L, to the cent — gate 2c.

Two code paths turn one Romanian trial balance into an assembled P&L,
and until now nothing made them agree:

  REFERENCE   ``RomaniaPack.run_deterministic_tb(bytes, filename=...)``
              — the offline composition. `scripts/verify_determinism.py`,
              `scripts/reprocess_documents.py`,
              `scripts/measure_bs_drift.py`,
              `scripts/measure_error_budget.py` and
              `scripts/corpus_replay.py` all audit THIS one.

  PRODUCTION  ``stage_extract`` (xlsx / csv / pdf deterministic branch)
              → ``pack.parse_trial_balance``
              → ``pack.accounts_to_assemble_shape``
              → ``_deterministic_tb_parsed``
              → ``stage_map`` — what a real upload actually runs.

Every measurement the repo takes of its own numbers is taken on the
reference path; every number a customer reads comes off the production
path. A difference between them is invisible by construction: each path
is internally consistent, so no single-path test can see it, and the
harnesses that would notice are all pointed at the wrong one. That is
the same shape as the defect recorded in
`tests/engine/test_rebuild_net_income_anchor.py` (persist threaded the
account-121 anchor, the rebuild seams did not, and the served P&L was
37.9x off on `saga_10_col_realestate`) — one seam further out.

WHAT THIS GATE FOUND, 2026-09-09, on all 15 deterministic corpus books:
every VALUE agreed to the cent, and the FIELD SETS did not.
`pipeline.stage_map` stamped four anchor-provenance fields
(`net_income_reconstructed`, `net_income_statutory_anchor`,
`net_income_anchor_source`, `net_income_anchor_status`) that the offline
seam never stamped — even though the helper's own docstring claimed it
ran on "EVERY path that produces an `assembled_pl` ... so the field set
never depends on which seam the reader came through". Consequence: the
offline harnesses audited a P&L that could not say whether its own
`net_income_statutory` was account 121 or a class-6/7 reconstruction, so
an anchor-labelling regression was undetectable there. Repaired by
moving the rule into `engine.core.net_income_anchor` — ONE code object,
called by both seams. This gate is what keeps it that way.

WHAT IT FAILS ON NOW THAT THE DEFECT IS REPAIRED (TC-11):
  · any assembled_pl field present on one path and absent on the other
    (the repaired defect, in either direction);
  · any assembled_pl value that differs, reported with the cent delta;
  · any assembled_bs field or canonical_bs total that differs;
  · any difference anywhere in `statements` or in
    `assembled_canonical_v1`, by JSON path;
  · a book whose meta declares a deterministic lane that the reference
    parser can no longer read;
  · the corpus shrinking below the coverage floor, or losing its
    real-money books, which would make the gate vacuous.

PLANT-PROVEN (see the task report for the verbatim reds):
  A. drop the `annotate_from_parsed_tb_rows` call from
     `RomaniaPack.assemble_parsed_tb` — reinstates the exact defect
     above; reds naming each missing field.
  B. `_deterministic_tb_parsed` returns
     `"statutory_net_profit_anchor": None` — the production path serves
     the reconstruction while the reference serves account 121; reds on
     `net_income_statutory` with the money delta.
  C. `pack.parse_trial_balance` raises inside the xlsx fast-path — the
     production path falls through to Claude; the second gate below reds
     with the skip log line verbatim.

NOT COMPARED, AND WHY: `assembled["pl_sanity"]`. The offline seam
ATTACHES the structural-impossibility findings (it is a library entry
point that must answer perturbed books rather than refuse them); the
production seam is supposed to RAISE on them instead
(`pipeline.stage_map`'s "THE PRODUCT SEAM"). They are different by
design. That the production refusal is currently unreachable — nothing
ever puts `tb_rows`/`rows` into the `parsed` payload the guard reads, so
`pl_sanity.assert_servable` is never called on any real upload — is a
SEPARATE finding, reported to the owner rather than pinned here.

NO MIRROR, NO FAKE STORE. Both paths below are the real functions. The
only double is the storage fetch: `stage_extract` resolves a Supabase
signed URL and HTTP-GETs the bytes, and this gate hands it the corpus
file instead. Nothing that parses, maps, assembles or labels is stubbed
— which is the whole point, since a mirror store is exactly what hid
twenty defects the last time (corpus/README.md, `check_public_e2e.py`).
"""

from __future__ import annotations

import contextlib
import importlib.util
import sys
import types
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

import pytest
import yaml

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

CORPUS = REPO / "corpus"
REPLAY_SCRIPT = REPO / "scripts" / "corpus_replay.py"

import engine.country_packs.ro_romania  # noqa: E402,F401 — registers RomaniaPack
from engine.api import pipeline as P  # noqa: E402
from engine.core.country_pack_registry import get_pack  # noqa: E402
from engine.core.net_income_anchor import (  # noqa: E402
    NET_INCOME_ANCHOR_FIELDS,
)


def _load(name: str, path: Path):
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


corpus_replay = _load("corpus_replay", REPLAY_SCRIPT)

#: `meta.yaml: expected_parser` values that name a lane the RO
#: deterministic parser owns. A case declaring one of these MUST parse
#: offline and MUST take the deterministic branch in production — the
#: two gates below both key off this set, so a lane can never be quietly
#: dropped from coverage by renaming it.
DETERMINISTIC_LANES = frozenset({
    "saga_10_col",
    "saga_compact_6_col",
    "generic_4_col",
    "csv",
    "pdf_positional",
})

#: Lanes that are deliberately NOT deterministic-parseable: a scanned
#: PDF with no text layer, a Hungarian book (the AI lane owns it), and a
#: public-records JSON summary that is not a trial balance at all.
#: Listed so that a case which STOPS parsing shows up as a lane change
#: rather than as silent shrinkage of this gate.
NON_DETERMINISTIC_LANES = frozenset({
    "ro_llm_fallback",
    "hu_ai_lane",
    "public_summary",
})

#: The corpus supplies 15 deterministic books today. The floor exists so
#: that deleting cases (or breaking discovery) fails loudly instead of
#: reducing this gate to a handful — or to zero, which would still be
#: "green".
COVERAGE_FLOOR = 15

#: Books whose net turnover is real money rather than a synthetic
#: round number. A parity gate over all-zero P&Ls proves nothing, so the
#: count of covered books carrying revenue is asserted too.
REAL_MONEY_FLOOR = 6


# ── Corpus discovery ───────────────────────────────────────────────────


def _meta(case_dir: Path) -> Dict[str, Any]:
    loaded = yaml.safe_load((case_dir / "meta.yaml").read_text(encoding="utf-8"))
    return loaded if isinstance(loaded, dict) else {}


def _input_of(case_dir: Path) -> Optional[Path]:
    found = sorted(p for p in case_dir.iterdir() if p.name.startswith("input."))
    return found[0] if found else None


def _cases() -> List[Tuple[str, Path, str]]:
    """(case_id, input_path, expected_parser) for every corpus case."""
    if not CORPUS.is_dir():
        return []
    out: List[Tuple[str, Path, str]] = []
    for case_dir in corpus_replay.discover_cases(CORPUS):
        inp = _input_of(case_dir)
        if inp is None:
            continue
        out.append((case_dir.name, inp, str(_meta(case_dir).get("expected_parser") or "")))
    return out


ALL_CASES = _cases()
DETERMINISTIC_CASES = [
    (cid, path) for cid, path, lane in ALL_CASES if lane in DETERMINISTIC_LANES
]
DETERMINISTIC_IDS = [cid for cid, _ in DETERMINISTIC_CASES]


# ── The one double: storage hands over the corpus bytes ────────────────


class _StorageResponse:
    def __init__(self, content: bytes) -> None:
        self.content = content
        self.status_code = 200

    def raise_for_status(self) -> None:
        return None


class _StorageAdmin:
    """Stands in for `_supabase.admin()` — signs a URL, nothing else."""

    def signed_url(self, *_a: Any, **_k: Any) -> str:
        return "corpus-local://input"

    def __enter__(self) -> "_StorageAdmin":
        return self

    def __exit__(self, *_a: Any) -> bool:
        return False


def _httpx_serving(content: bytes) -> types.SimpleNamespace:
    class _Client:
        def __init__(self, *_a: Any, **_k: Any) -> None:
            pass

        def __enter__(self) -> "_Client":
            return self

        def __exit__(self, *_a: Any) -> bool:
            return False

        def get(self, _url: str, *_a: Any, **_k: Any) -> _StorageResponse:
            return _StorageResponse(content)

    return types.SimpleNamespace(Client=_Client)


class LlmLaneReached(AssertionError):
    """Raised the instant the production path builds an Anthropic client."""


def _sentinel_anthropic() -> types.ModuleType:
    module = types.ModuleType("anthropic")

    class _Anthropic:  # noqa: D401 — a tripwire, not a client
        def __init__(self, *_a: Any, **_k: Any) -> None:
            raise LlmLaneReached(
                "stage_extract constructed an Anthropic client for a book the "
                "deterministic parser can read — the LLM lane was taken"
            )

    module.Anthropic = _Anthropic  # type: ignore[attr-defined]
    return module


@contextlib.contextmanager
def _production_environment(
    monkeypatch: pytest.MonkeyPatch, content: bytes,
) -> Iterator[None]:
    """Everything `stage_extract` needs that is not the engine itself.

    · storage serves `content` (the only double);
    · an API key is present, so the LLM tail is REACHABLE — a missing
      key would make this gate pass by accident, on an exception, for a
      book that had in fact fallen out of the deterministic branch;
    · `anthropic.Anthropic` is a tripwire;
    · the two shadow lanes are forced OFF so an exported env var in a
      developer's shell cannot change which branch runs under the gate.
    """
    monkeypatch.setattr(P._supabase, "admin", lambda: _StorageAdmin())
    monkeypatch.setattr(P, "httpx", _httpx_serving(content))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "gate-key-never-used")
    monkeypatch.setitem(sys.modules, "anthropic", _sentinel_anthropic())
    monkeypatch.delenv("AI_STRUCTURAL_READER", raising=False)
    monkeypatch.delenv("CONSENSUS_ENABLED", raising=False)
    monkeypatch.delenv("CONSENSUS_SHADOW", raising=False)
    monkeypatch.delenv("SHADOW_CLASSIFY", raising=False)
    yield


def _doc_for(case_id: str, input_path: Path) -> Dict[str, Any]:
    """The `documents` row shape `stage_extract` reads. `mime_type` is
    left empty on purpose: `_classify_file` then dispatches on the
    filename exactly as it does for an upload whose browser sent no
    type."""
    return {
        "id": "doc-parity-%s" % case_id,
        "org_id": "org-parity",
        "original_filename": input_path.name,
        "storage_path": "corpus/%s/%s" % (case_id, input_path.name),
        "mime_type": "",
    }


# ── The two paths ──────────────────────────────────────────────────────


def _reference(input_path: Path, industry: Optional[str]) -> Dict[str, Any]:
    """`RomaniaPack.run_deterministic_tb` — the offline reference.

    `company_name` / `period_label` are set to the SAME values
    `_deterministic_tb_parsed` derives, so the comparison is about the
    engine and not about two callers passing different labels.
    """
    _tb, _shaped, assembled = get_pack("RO").run_deterministic_tb(
        input_path.read_bytes(),
        filename=input_path.name,
        company_name=input_path.stem,
        period_label="Imported period",
        industry=industry,
    )
    return assembled


def _production(
    monkeypatch: pytest.MonkeyPatch,
    case_id: str,
    input_path: Path,
    industry: Optional[str],
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """The REAL pipeline path. Returns (parsed, assembled)."""
    content = input_path.read_bytes()
    doc = _doc_for(case_id, input_path)
    with _production_environment(monkeypatch, content):
        parsed = P.stage_extract(doc)
        assembled = P.stage_map(doc, parsed, industry)
    return parsed, assembled


# ── Comparison helpers ─────────────────────────────────────────────────


def _flatten(value: Any, prefix: str = "") -> Dict[str, Any]:
    """Deep JSON-path flattening, so a difference is reported at the leaf
    that actually moved instead of as two large dict reprs."""
    out: Dict[str, Any] = {}
    if isinstance(value, dict):
        for key in value:
            out.update(_flatten(value[key], "%s.%s" % (prefix, key)))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            out.update(_flatten(item, "%s[%d]" % (prefix, index)))
    else:
        out[prefix or "$"] = value
    return out


_MISSING = "<field absent on this path>"


def _describe(field: str, ref: Any, prod: Any) -> str:
    line = "  %-34s reference=%r  production=%r" % (field, ref, prod)
    if isinstance(ref, (int, float)) and isinstance(prod, (int, float)):
        line += "  (delta %+.2f)" % (float(prod) - float(ref))
    return line


def _diff(ref: Dict[str, Any], prod: Dict[str, Any]) -> List[str]:
    return [
        _describe(field, ref.get(field, _MISSING), prod.get(field, _MISSING))
        for field in sorted(set(ref) | set(prod))
        if ref.get(field, _MISSING) != prod.get(field, _MISSING)
    ]


def _statements(assembled: Dict[str, Any]) -> Dict[str, Any]:
    return (assembled.get("statements") or {})


def _pl(assembled: Dict[str, Any]) -> Dict[str, Any]:
    return _statements(assembled).get("assembled_pl") or {}


def _bs(assembled: Dict[str, Any]) -> Dict[str, Any]:
    return _statements(assembled).get("assembled_bs") or {}


def _canonical_totals(assembled: Dict[str, Any]) -> Dict[str, Any]:
    envelope = assembled.get("assembled_canonical_v1") or {}
    return ((envelope.get("canonical_bs") or {}).get("totals") or {})


# ── 1. The corpus is actually covered ──────────────────────────────────


def test_every_corpus_case_declares_a_known_lane():
    """A case whose `expected_parser` is neither deterministic nor a
    declared AI/summary lane is invisible to this gate. Fail rather than
    skip it."""
    assert ALL_CASES, "no corpus cases discovered under %s" % CORPUS
    unknown = [
        (cid, lane) for cid, _p, lane in ALL_CASES
        if lane not in DETERMINISTIC_LANES and lane not in NON_DETERMINISTIC_LANES
    ]
    assert not unknown, (
        "corpus case(s) declare a lane this parity gate does not classify, so "
        "they are covered by nothing:\n  %s\nAdd the lane to "
        "DETERMINISTIC_LANES (it parses offline) or to "
        "NON_DETERMINISTIC_LANES (it does not)."
        % "\n  ".join("%s: expected_parser=%r" % pair for pair in unknown)
    )


def test_coverage_floor_holds():
    assert len(DETERMINISTIC_CASES) >= COVERAGE_FLOOR, (
        "offline-vs-served parity covers only %d corpus book(s); the floor is "
        "%d. A shrinking corpus makes this gate vacuous while it stays green.\n"
        "  covered: %s" % (
            len(DETERMINISTIC_CASES), COVERAGE_FLOOR, ", ".join(DETERMINISTIC_IDS),
        )
    )


def test_the_covered_books_carry_real_money():
    """Parity over all-zero P&Ls proves nothing. Count the covered books
    whose reference path reports non-zero net turnover."""
    with_revenue = []
    for case_id, input_path in DETERMINISTIC_CASES:
        revenue = _pl(_reference(input_path, None)).get("revenue")
        if isinstance(revenue, (int, float)) and abs(float(revenue)) > 0.0:
            with_revenue.append((case_id, float(revenue)))
    assert len(with_revenue) >= REAL_MONEY_FLOOR, (
        "only %d covered book(s) carry non-zero revenue (floor %d) — this gate "
        "would pass on empty statements.\n  %s" % (
            len(with_revenue), REAL_MONEY_FLOOR,
            "\n  ".join("%s: revenue=%.2f" % pair for pair in with_revenue)
            or "(none)",
        )
    )


# ── 2. THE PARITY GATE ─────────────────────────────────────────────────


@pytest.mark.parametrize("case_id,input_path", DETERMINISTIC_CASES, ids=DETERMINISTIC_IDS)
def test_assembled_pl_is_identical_field_for_field(case_id, input_path, monkeypatch):
    """Every assembled_pl field, both directions, to the cent."""
    reference = _pl(_reference(input_path, None))
    _parsed, produced = _production(monkeypatch, case_id, input_path, None)
    production = _pl(produced)

    assert reference, "%s: the reference path produced an empty assembled_pl" % case_id
    assert production, "%s: the production path produced an empty assembled_pl" % case_id

    missing_in_production = sorted(set(reference) - set(production))
    missing_in_reference = sorted(set(production) - set(reference))
    assert not missing_in_production and not missing_in_reference, (
        "%s: the two paths disagree on WHICH P&L fields exist, so a reader's "
        "field set depends on which seam produced the payload.\n"
        "  present offline, absent in production: %s\n"
        "  present in production, absent offline: %s\n"
        "  (the anchor-provenance four are %s)"
        % (case_id, missing_in_production or "none", missing_in_reference or "none",
           ", ".join(NET_INCOME_ANCHOR_FIELDS))
    )

    differing = _diff(reference, production)
    assert not differing, (
        "%s: the offline reference and the production pipeline assembled "
        "DIFFERENT P&Ls from the same bytes (%s).\n"
        "  reference:  RomaniaPack.run_deterministic_tb\n"
        "  production: stage_extract -> _deterministic_tb_parsed -> stage_map\n%s"
        % (case_id, input_path.name, "\n".join(differing))
    )


@pytest.mark.parametrize("case_id,input_path", DETERMINISTIC_CASES, ids=DETERMINISTIC_IDS)
def test_balance_sheet_totals_are_identical(case_id, input_path, monkeypatch):
    """assembled_bs field-for-field, plus the canonical_bs totals the
    frontend actually renders."""
    reference = _reference(input_path, None)
    _parsed, production = _production(monkeypatch, case_id, input_path, None)

    bs_diff = _diff(_bs(reference), _bs(production))
    assert not bs_diff, (
        "%s: assembled_bs differs between the offline reference and the "
        "production pipeline.\n%s" % (case_id, "\n".join(bs_diff))
    )

    ref_totals = _canonical_totals(reference)
    prod_totals = _canonical_totals(production)
    assert ref_totals, "%s: reference emitted no canonical_bs totals" % case_id
    totals_diff = _diff(ref_totals, prod_totals)
    assert not totals_diff, (
        "%s: canonical_bs.totals differ between the offline reference and the "
        "production pipeline — the served balance sheet is not the audited "
        "one.\n%s" % (case_id, "\n".join(totals_diff))
    )


@pytest.mark.parametrize("case_id,input_path", DETERMINISTIC_CASES, ids=DETERMINISTIC_IDS)
def test_statements_and_canonical_envelope_are_identical(case_id, input_path, monkeypatch):
    """Nothing else in the two reader-facing payloads may differ either.

    `statements` is what the P&L / BS tabs render; `assembled_canonical_v1`
    is what gets persisted and re-served. Compared deep, by JSON path, so
    a divergence in a nested block (invariants, source_anchor, extraction,
    reconciliation) is caught at the leaf.
    """
    reference = _reference(input_path, None)
    _parsed, production = _production(monkeypatch, case_id, input_path, None)

    for label, extract in (
        ("statements", _statements),
        ("assembled_canonical_v1", lambda a: a.get("assembled_canonical_v1") or {}),
    ):
        differing = _diff(_flatten(extract(reference)), _flatten(extract(production)))
        assert not differing, (
            "%s: %s differs between the offline reference and the production "
            "pipeline.\n%s" % (case_id, label, "\n".join(differing))
        )


def test_the_industry_kwarg_reaches_both_paths_identically():
    """An industry that reaches one seam and not the other would make the
    parity above true only for the default. Proven on one real book."""
    case = next(((c, p) for c, p in DETERMINISTIC_CASES if c == "saga_10_col_agras"), None)
    if case is None:
        pytest.skip("saga_10_col_agras not in the corpus")
    case_id, input_path = case
    monkeypatch = pytest.MonkeyPatch()
    try:
        reference = _pl(_reference(input_path, "food_manufacturing"))
        _parsed, produced = _production(
            monkeypatch, case_id, input_path, "food_manufacturing",
        )
    finally:
        monkeypatch.undo()
    differing = _diff(reference, _pl(produced))
    assert not differing, (
        "%s: with industry='food_manufacturing' the two paths assembled "
        "different P&Ls.\n%s" % (case_id, "\n".join(differing))
    )


# ── 3. The production path never quietly hands the book to Claude ──────


#: The three log lines `stage_extract` writes when a deterministic
#: fast-path raises and the document falls through to the LLM. Matched
#: on the shared substring so a reworded suffix cannot slip past.
FALLBACK_LOG_MARK = "fast-path skipped"

#: What the deterministic branches log when they DO take the book.
DETERMINISTIC_LOG_MARKS = (
    "[stage_extract] deterministic TB path:",
    "[stage_extract] deterministic CSV TB path:",
    "[stage_extract] deterministic PDF TB path:",
)


@pytest.mark.parametrize("case_id,input_path", DETERMINISTIC_CASES, ids=DETERMINISTIC_IDS)
def test_the_deterministic_branch_is_the_one_taken(case_id, input_path, caplog, monkeypatch):
    """For a book the deterministic parser CAN read, production must read
    it deterministically — never fall through to Claude.

    The fallback is silent by construction: `stage_extract` catches every
    exception from `pack.parse_trial_balance`, logs one INFO line and
    hands the file to the LLM, which answers with plausible numbers. A
    customer sees a report either way. Three independent signals are
    asserted here so no single one can be the whole gate:

      1. the "fast-path skipped" log line is never written;
      2. one of the deterministic-path log lines IS written;
      3. the parse result is stamped `extraction.method == "deterministic"`
         rather than the LLM stamp `_stamp_llm_extraction` applies;

    and a fourth, live during the call: constructing an Anthropic client
    raises `LlmLaneReached` immediately.
    """
    caplog.set_level("INFO", logger="engine.api.pipeline")
    try:
        parsed, _assembled = _production(monkeypatch, case_id, input_path, None)
    except LlmLaneReached as exc:
        skipped = [r.getMessage() for r in caplog.records if FALLBACK_LOG_MARK in r.getMessage()]
        pytest.fail(
            "%s (%s): %s\n  stage_extract logged: %s"
            % (case_id, input_path.name, exc, skipped or "(no skip line captured)")
        )

    messages = [record.getMessage() for record in caplog.records]
    skipped = [m for m in messages if FALLBACK_LOG_MARK in m]
    assert not skipped, (
        "%s (%s): the deterministic parser CAN read this book, but production "
        "fell through to the LLM lane.\n  %s"
        % (case_id, input_path.name, "\n  ".join(skipped))
    )

    took_it = [m for m in messages if any(mark in m for mark in DETERMINISTIC_LOG_MARKS)]
    assert took_it, (
        "%s (%s): no deterministic fast-path log line was written. The book was "
        "extracted by some other branch — check the statutory detector and the "
        "AI-lane jurisdiction gate, both of which run BEFORE the fast-path.\n"
        "  lines seen: %s" % (case_id, input_path.name, messages or "(none)")
    )

    extraction = parsed.get("extraction") or {}
    assert extraction.get("method") == "deterministic", (
        "%s (%s): stage_extract returned extraction.method=%r (source_format=%r) "
        "— the deterministic branches stamp 'deterministic'; the LLM lane stamps "
        "'llm'/'llm_freeform'."
        % (case_id, input_path.name, extraction.get("method"),
           extraction.get("source_format"))
    )
    assert parsed.get("detected_type") == "trial_balance", (
        "%s (%s): stage_extract classified this book as %r, not a trial balance"
        % (case_id, input_path.name, parsed.get("detected_type"))
    )


def test_the_reference_parser_reads_every_book_that_declares_a_deterministic_lane():
    """The other half of the claim above: a case whose meta declares a
    deterministic lane must in fact parse offline. Without this, a book
    that stopped parsing would silently drop out of `DETERMINISTIC_CASES`
    and every parity assertion would keep passing on a smaller set."""
    pack = get_pack("RO")
    broken: List[str] = []
    for case_id, input_path, lane in ALL_CASES:
        if lane not in DETERMINISTIC_LANES:
            continue
        try:
            rows, _shaped, _assembled = pack.run_deterministic_tb(
                input_path.read_bytes(), filename=input_path.name,
            )
        except Exception as exc:  # noqa: BLE001 — the message IS the finding
            broken.append("%s (%s): %s: %s" % (case_id, lane, type(exc).__name__, exc))
            continue
        if not rows:
            broken.append("%s (%s): parsed to zero rows" % (case_id, lane))
    assert not broken, (
        "corpus case(s) declare a deterministic lane the reference parser can no "
        "longer read:\n  %s" % "\n  ".join(broken)
    )
