"""Account 121 anchors `net_income_statutory` on EVERY path, not just persist.

CLAUDE.md Appendix A §3 / Step 11: the CLOSING BALANCE OF ACCOUNT 121 IS
the statutory net profit; the class-6/7 reconstruction is the validation
check. `assemble_statements()` implements that rule but can only see the
anchor through its `account_121_anchor_override` kwarg, because
`accounts_to_assemble_shape()` routes 121 to `ignore_control` and drops
the row before assembly.

The persist path threaded it. The three REBUILD-FROM-LINE-ITEMS paths did
not, so the same books served a raw reconstruction under the statutory
name on the Statements P&L, the Valuation tab, the cash-flow statement,
the NAV cascade, the Capsule statements context, Radar and the briefing.
Measured before the fix (this file re-measures it every run):

    book                    account 121      rebuild served    factor
    saga_10_col_realestate    -801,604.14   -30,391,418.38      37.9x
    saga_10_col_agras        7,533,676.02    14,106,102.03       1.9x
    saga_10_col_carniprod    1,435,533.59     5,843,449.04       4.1x
    saga_10_col_retail       3,205,212.62     1,161,957.98      0.36x
    saga_10_col                402,869.16       171,665.97      0.43x
    pdf_positional             650,887.06       615,350.00      0.95x

WHY IT SURVIVED: the persist path and the rebuild paths were each
individually consistent, so no single-path test could see it. This gate
is therefore CROSS-PATH by construction — it drives the REAL production
write seam (`stage_map` → `stage_persist`) and the REAL served routes
against the SAME book and demands they agree with each other.

PLANT (TC-2), two shapes, both recorded in docs/engine_book/gates.md:
  A. a rebuild site calls `_coa_mod.assemble_statements(...)` directly
     again instead of `_assemble_with_statutory_anchor(...)`
     — 36 failed, 48 passed;
  B. the helper keeps resolving and labelling but drops
     `**anchor_kwargs` on the way to the assembler, so only the VALUE
     fails to arrive — 47 failed, 37 passed.
RED: the failing assertion names the book, the account-121 anchor, the
reconstruction served in its place, and the gap. REVERT: green.

NO FAKE ASSEMBLER, NO MIRROR STORE. Everything below runs the real
`assemble_statements`, the real `stage_persist`, the real FastAPI
routes. The only double is a Supabase stand-in, and it is
PROJECTION-FAITHFUL — it honours `columns=`, so a route whose real
projection omits `assembled_canonical_v1` cannot pass here by being
handed the envelope anyway (that is precisely how the Radar surface
differs, and this gate pins the difference rather than papering over it).
"""

from __future__ import annotations

import contextlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

CORPUS = REPO / "corpus"
REPLAY_SCRIPT = REPO / "scripts" / "corpus_replay.py"

from engine.api import pipeline as P  # noqa: E402


def _load(name: str, path: Path):
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


corpus_replay = _load("corpus_replay", REPLAY_SCRIPT)

#: Books that must be covered. The brief's floor is 5; the corpus
#: currently supplies 7. Asserted in `test_corpus_anchor_coverage_floor`
#: so shrinking the corpus below the floor fails loudly instead of
#: quietly reducing this gate to a handful of cases.
ANCHOR_BOOK_FLOOR = 5

#: Books whose reconstruction diverges enough that the assembler's
#: override actually FIRES (status `anchored`). These are the cases that
#: prove the defect; a corpus that stops carrying them makes this gate
#: vacuous, so the count is asserted too.
OVERRIDE_FIRING_FLOOR = 5


# ── Corpus discovery ───────────────────────────────────────────────────


def _p121_of(case_dir: Path) -> Optional[float]:
    """Account 121 as frozen in the case's served-envelope golden."""
    golden = case_dir / "expected" / "served_envelope.json"
    if not golden.is_file():
        return None
    env = json.loads(golden.read_text(encoding="utf-8"))
    block = ((env.get("invariants") or {}).get("p121_cross_check") or {})
    val = block.get("p121")
    return None if val is None else float(val)


def _anchor_cases() -> List[Tuple[str, Path, float]]:
    if not CORPUS.is_dir():
        return []
    out: List[Tuple[str, Path, float]] = []
    for case_dir in sorted(corpus_replay.discover_cases(CORPUS)):
        p121 = _p121_of(case_dir)
        if p121 is not None:
            out.append((case_dir.name, case_dir, p121))
    return out


ANCHOR_CASES = _anchor_cases()
CASE_IDS = [c[0] for c in ANCHOR_CASES]


# ── Real production write path, replayed offline ───────────────────────


class _Book:
    """One corpus book carried through the REAL production write path:
    parse → `stage_map` (pipeline.py, the persist-path assembly) →
    `stage_persist`. Exposes exactly what a served route would later
    read back out of the database."""

    def __init__(self, case_dir: Path) -> None:
        pack = corpus_replay.get_pack("RO")
        meta = corpus_replay._load_meta(case_dir)
        input_path = corpus_replay._input_path(case_dir)
        content = input_path.read_bytes()
        tb_rows = (
            pack.parse_trial_balance_csv(content, input_path.name)
            if str(meta["expected_parser"]) == "csv"
            else pack.parse_trial_balance(content, input_path.name)
        )
        _tb, shaped, _assembled = pack.assemble_parsed_tb(
            tb_rows, company_name=input_path.stem,
            period_label="Imported period",
        )
        doc = corpus_replay._doc_for(case_dir.name, input_path, content, meta)
        parsed = P._deterministic_tb_parsed(
            doc, tb_rows, shaped,
            pack.compute_statutory_net_profit_anchor(tb_rows),
            pack.compute_source_imbalance(tb_rows),
        )
        # THE PRODUCTION WRITE SEAM. `run_pipeline` calls exactly this
        # (pipeline.py `assembled = stage_map(doc, parsed, industry)`),
        # not the pack helper above — the pack helper only exists here to
        # satisfy stage_persist's input contract before stage_map runs.
        self.doc = doc
        self.parsed = parsed
        self.persist_assembled = P.stage_map(doc, parsed, None)
        with corpus_replay.fake_persist_seam() as fake:
            self.period_id = P.stage_persist(doc, parsed, self.persist_assembled)
            self.line_items = [dict(r) for r in fake.inserted_line_items]
            self.period = dict(fake.period_rows[0])
        self.org = {"id": doc["org_id"], "name": "Corpus Entity"}

    # The row shapes a served route can be handed.
    def full_row(self) -> Dict[str, Any]:
        return dict(self.period)

    def light_row_with_envelope(self) -> Dict[str, Any]:
        """A narrow projection that still selects the envelope column."""
        keep = ("id", "org_id", "period_start", "period_end", "currency",
                "assembled_canonical_v1")
        return {k: v for k, v in self.period.items() if k in keep}

    def light_row_without_envelope(self) -> Dict[str, Any]:
        """The REAL Radar projection (`_radar.LIGHT_PERIOD_COLUMNS`):
        it selects `assembled_canonical_v1->>schema_version` as an alias
        but never the envelope object itself."""
        keep = ("id", "org_id", "period_start", "period_end", "currency",
                "source_document_id", "updated_at", "caen_code")
        row = {k: v for k, v in self.period.items() if k in keep}
        env = self.period.get("assembled_canonical_v1") or {}
        row["snapshot_hash"] = ((env.get("provenance") or {}).get("content_hash"))
        row["has_envelope"] = env.get("schema_version")
        return row


_BOOKS: Dict[str, _Book] = {}


def _book(case_id: str, case_dir: Path) -> _Book:
    if case_id not in _BOOKS:
        _BOOKS[case_id] = _Book(case_dir)
    return _BOOKS[case_id]


# ── Assertion vocabulary — every failure names the book and both figures ──


def _pl_of(payload: Dict[str, Any]) -> Dict[str, Any]:
    statements = payload.get("statements") if "statements" in payload else payload
    pl = (statements or {}).get("assembled_pl")
    assert isinstance(pl, dict), "no assembled_pl on the payload: %r" % (
        sorted((statements or {}).keys()),
    )
    return pl


def _assert_anchored(case_id: str, where: str, pl: Dict[str, Any],
                     p121: float) -> None:
    served = pl.get("net_income_statutory")
    status = pl.get("net_income_anchor_status")
    recon = pl.get("net_income_reconstructed")
    assert status in (P.NET_INCOME_ANCHOR_ANCHORED,
                      P.NET_INCOME_ANCHOR_WITHIN_TOLERANCE), (
        "[%s] %s: net_income_anchor_status is %r — the account-121 anchor "
        "did not reach the assembler (it was %s). Account 121 = %s; the "
        "class-6/7 reconstruction being served under the statutory name "
        "= %s (gap %s)."
        % (case_id, where, status,
           "never resolved" if pl.get("net_income_statutory_anchor") is None
           else "resolved as %s but not passed to assemble_statements()"
                % f"{float(pl['net_income_statutory_anchor']):,.2f}",
           f"{p121:,.2f}",
           "n/a" if served is None else f"{float(served):,.2f}",
           "n/a" if served is None else f"{float(served) - p121:,.2f}")
    )
    if status == P.NET_INCOME_ANCHOR_ANCHORED:
        assert served is not None and abs(float(served) - p121) < 0.005, (
            "[%s] %s: net_income_statutory = %s but account 121 = %s "
            "(gap %s). The 121 closing balance IS the statutory net "
            "profit (CLAUDE.md Appendix A §3); the class-6/7 "
            "reconstruction is only the validation check. "
            "net_income_reconstructed = %s."
            % (case_id, where, f"{float(served):,.2f}", f"{p121:,.2f}",
               f"{float(served) - p121:,.2f}",
               "n/a" if recon is None else f"{float(recon):,.2f}")
        )
    else:
        # `within_tolerance`: an anchor exists and the assembler
        # deliberately kept the reconstruction (inside its 5%-of-
        # max(|121|, 100k) band). The served number must still be
        # labelled and the anchor itself must still be on the payload.
        assert pl.get("net_income_statutory_anchor") is not None, (
            "[%s] %s: status is within_tolerance but the anchor value is "
            "absent from the payload — the reader cannot see the gap."
            % (case_id, where)
        )
        assert abs(float(pl["net_income_statutory_anchor"]) - p121) < 0.005, (
            "[%s] %s: net_income_statutory_anchor = %s, account 121 = %s"
            % (case_id, where, pl["net_income_statutory_anchor"], p121)
        )


def _assert_sibling_fields_present(case_id: str, where: str,
                                   pl: Dict[str, Any]) -> None:
    for key in ("net_income_reconstructed", "net_income_statutory_anchor",
                "net_income_anchor_source", "net_income_anchor_status"):
        assert key in pl, (
            "[%s] %s: %r missing from assembled_pl. The anchor sibling "
            "fields are emitted on EVERY path — persist and rebuild — so "
            "a reader never has to know which seam produced a payload "
            "before it can trust net_income_statutory." % (case_id, where, key)
        )


# ── Coverage floors ────────────────────────────────────────────────────


def test_corpus_anchor_coverage_floor():
    assert len(ANCHOR_CASES) >= ANCHOR_BOOK_FLOOR, (
        "only %d corpus book(s) carry an account-121 anchor; this gate "
        "needs at least %d to be meaningful. Books found: %s"
        % (len(ANCHOR_CASES), ANCHOR_BOOK_FLOOR, CASE_IDS)
    )


@pytest.mark.skipif(not ANCHOR_CASES, reason="no corpus books with a p121")
def test_enough_books_actually_fire_the_override():
    """A gate whose every book agrees by luck proves nothing. Count the
    books where the reconstruction genuinely diverges from account 121."""
    firing = []
    for case_id, case_dir, p121 in ANCHOR_CASES:
        bk = _book(case_id, case_dir)
        pl = _pl_of(P._rebuild_assembled_for_briefing(
            bk.line_items, bk.full_row(), bk.org))
        if pl.get("net_income_anchor_status") == P.NET_INCOME_ANCHOR_ANCHORED:
            recon = float(pl.get("net_income_reconstructed"))
            if abs(recon - p121) >= 0.005:
                firing.append((case_id, p121, recon))
    assert len(firing) >= OVERRIDE_FIRING_FLOOR, (
        "only %d book(s) have a reconstruction that diverges from account "
        "121, so this gate would pass even with the anchor unthreaded. "
        "Divergent books: %s"
        % (len(firing), [(c, round(a, 2), round(r, 2)) for c, a, r in firing])
    )


# ── (1) The seam itself, three row shapes ──────────────────────────────


@pytest.mark.parametrize("case_id,case_dir,p121", ANCHOR_CASES, ids=CASE_IDS)
def test_seam_full_row_is_anchored(case_id, case_dir, p121):
    """(a) FULL period row — `_rebuild_assembled_for_briefing`, the seam
    behind the Capsule statements context, Radar's facts, the firm
    attention lane and the regenerated briefing."""
    bk = _book(case_id, case_dir)
    payload = P._rebuild_assembled_for_briefing(
        bk.line_items, bk.full_row(), bk.org)
    pl = _pl_of(payload)
    _assert_anchored(case_id, "seam/full-row", pl, p121)
    _assert_sibling_fields_present(case_id, "seam/full-row", pl)
    assert pl.get("net_income_anchor_source") == "envelope_p121_cross_check"


@pytest.mark.parametrize("case_id,case_dir,p121", ANCHOR_CASES, ids=CASE_IDS)
def test_seam_light_row_carrying_the_envelope_is_anchored(case_id, case_dir, p121):
    """(b) LIGHT row that still selects `assembled_canonical_v1`. The
    anchor must not depend on any other column being present."""
    bk = _book(case_id, case_dir)
    pl = _pl_of(P._rebuild_assembled_for_briefing(
        bk.line_items, bk.light_row_with_envelope(), bk.org))
    _assert_anchored(case_id, "seam/light-row+envelope", pl, p121)
    _assert_sibling_fields_present(case_id, "seam/light-row+envelope", pl)


@pytest.mark.parametrize("case_id,case_dir,p121", ANCHOR_CASES, ids=CASE_IDS)
def test_seam_without_envelope_or_121_line_item_says_absent(case_id, case_dir, p121):
    """(c) No envelope on the row AND no 121 among the line items — the
    anchor is genuinely unrecoverable. The payload must SAY SO rather
    than serve a reconstruction under the statutory name, and must carry
    `net_income_reconstructed` so the number stays readable.

    This is the REAL Radar projection, not a hypothetical: `_radar.
    LIGHT_PERIOD_COLUMNS` selects `assembled_canonical_v1->>
    schema_version`, never the envelope object."""
    bk = _book(case_id, case_dir)
    stripped = [li for li in bk.line_items
                if not str(li.get("ro_account_code") or "").startswith("121")]
    pl = _pl_of(P._rebuild_assembled_for_briefing(
        stripped, bk.light_row_without_envelope(), bk.org))
    _assert_sibling_fields_present(case_id, "seam/no-anchor", pl)
    assert pl["net_income_anchor_status"] == P.NET_INCOME_ANCHOR_ABSENT, (
        "[%s] seam/no-anchor: status is %r; with no envelope and no 121 "
        "line item there is no anchor, and the payload must say `absent`."
        % (case_id, pl["net_income_anchor_status"])
    )
    # `absent` here must mean "nothing was resolvable", not "an anchor was
    # resolved and then dropped on the floor" — the two are the same
    # status but only one is honest, and the second is the defect.
    assert pl["net_income_statutory_anchor"] is None, (
        "[%s] seam/no-anchor: status is `absent` yet an anchor of %s IS on "
        "the payload — it was resolved and never passed to "
        "assemble_statements()." % (case_id, pl["net_income_statutory_anchor"])
    )
    assert pl["net_income_anchor_source"] is None
    recon = pl.get("net_income_reconstructed")
    assert isinstance(recon, (int, float)), (
        "[%s] seam/no-anchor: net_income_reconstructed must be present so "
        "an unanchored figure is still readable." % case_id
    )
    # `net_income_statutory` is kept, never nulled — the frontend reads it
    # through `?? 0` fallbacks and a null would render a fabricated zero.
    assert isinstance(pl.get("net_income_statutory"), (int, float))
    assert abs(float(pl["net_income_statutory"]) - float(recon)) < 0.005, (
        "[%s] seam/no-anchor: with no anchor the served statutory figure "
        "IS the reconstruction (%s vs %s) — they must agree exactly."
        % (case_id, pl["net_income_statutory"], recon)
    )


@pytest.mark.parametrize("case_id,case_dir,p121", ANCHOR_CASES, ids=CASE_IDS)
def test_a_persisted_121_line_item_would_anchor_the_seam(case_id, case_dir, p121):
    """Fallback source 2. Today `stage_persist` never writes a 121 row
    (the account is `ignore_control` and the shaper drops it) — asserted
    below — so this path is dormant. It is covered anyway because if the
    mapping ever stops dropping 121, the line item must WIN over a
    silent reconstruction rather than be ignored."""
    bk = _book(case_id, case_dir)
    assert not [li for li in bk.line_items
                if str(li.get("ro_account_code") or "").startswith("121")], (
        "[%s] stage_persist wrote a 121 line item — the assumption behind "
        "`_statutory_anchor_for`'s ordering changed; re-read it." % case_id
    )
    synthetic = list(bk.line_items) + [{
        "statement": "BS", "bucket": "otherEquity",
        "ro_account_code": "121", "ro_account_name": "PROFIT SI PIERDERE",
        "amount": p121,
    }]
    anchor, source = P._statutory_anchor_for(
        bk.light_row_without_envelope(), synthetic)
    assert source == "line_items_121", source
    assert anchor is not None and abs(anchor - p121) < 0.005, (anchor, p121)


# ── (2) The equity result row is NOT the anchor ────────────────────────


@pytest.mark.parametrize("case_id,case_dir,p121", ANCHOR_CASES, ids=CASE_IDS)
def test_anchor_comes_from_the_invariant_not_the_equity_row(case_id, case_dir, p121):
    """`rows[id=current_year_profit].amount` looks like account 121 and
    usually equals it, but under `result_basis == "sf_closing_column"` it
    is `p121_cents + pl_net_cents` — the P&L net leaks in. Pin the
    source so a future refactor cannot quietly swap them."""
    bk = _book(case_id, case_dir)
    anchor, source = P._statutory_anchor_for(bk.full_row(), bk.line_items)
    assert source == "envelope_p121_cross_check"
    assert anchor is not None and abs(anchor - p121) < 0.005
    cbs = (bk.period.get("assembled_canonical_v1") or {}).get("canonical_bs") or {}
    rows = [r for r in (cbs.get("rows") or [])
            if r.get("id") in ("current_year_profit", "current_year_loss")]
    if rows and abs(float(rows[0]["amount"]) - p121) >= 0.005:
        # This book PROVES the two differ; make that explicit rather than
        # leaving the distinction as an unexercised comment.
        assert anchor != float(rows[0]["amount"]), (
            "[%s] the resolver returned the equity row (%s) instead of "
            "account 121 (%s)" % (case_id, rows[0]["amount"], p121)
        )


@pytest.mark.parametrize("case_id,case_dir,p121", ANCHOR_CASES, ids=CASE_IDS)
def test_a_light_projection_can_opt_back_in_with_one_scalar_column(
        case_id, case_dir, p121):
    """The Radar surface serves `absent` today because
    `_radar.LIGHT_PERIOD_COLUMNS` never selects the envelope. It can opt
    back in without paying for the whole JSONB column by adding ONE
    scalar alias — `p121:assembled_canonical_v1->canonical_bs->
    invariants->p121_cross_check->>p121`. Pinned here so that handover
    is a one-line change to the projection and nothing else."""
    bk = _book(case_id, case_dir)
    row = bk.light_row_without_envelope()
    assert P._statutory_anchor_for(row, bk.line_items) == (None, None)

    cbs = (bk.period.get("assembled_canonical_v1") or {}).get("canonical_bs") or {}
    # PostgREST returns `->>` extractions as TEXT — assert on the string
    # form, which is what the real projection would actually deliver.
    row["p121"] = str(
        (cbs.get("invariants") or {})["p121_cross_check"]["p121"])
    pl = _pl_of(P._rebuild_assembled_for_briefing(bk.line_items, row, bk.org))
    _assert_anchored(case_id, "seam/light-row+p121-alias", pl, p121)


def test_at_least_one_book_separates_the_row_from_the_anchor():
    """The distinction above is only load-bearing if some book actually
    exhibits it. Measured: saga_compact_6_col serves an equity result row
    of 500.00 against an account 121 of 0.00."""
    separating = []
    for case_id, case_dir, p121 in ANCHOR_CASES:
        bk = _book(case_id, case_dir)
        cbs = (bk.period.get("assembled_canonical_v1") or {}).get("canonical_bs") or {}
        rows = [r for r in (cbs.get("rows") or [])
                if r.get("id") in ("current_year_profit", "current_year_loss")]
        row_amount = float(rows[0]["amount"]) if rows else 0.0
        if abs(row_amount - p121) >= 0.005:
            separating.append((case_id, p121, row_amount))
    assert separating, (
        "no corpus book distinguishes the equity result row from account "
        "121, so `_statutory_anchor_for`'s source choice is untested. "
        "Books checked: %s" % CASE_IDS
    )


# ── (3) The persist path agrees with account 121 ───────────────────────


@pytest.mark.parametrize("case_id,case_dir,p121", ANCHOR_CASES, ids=CASE_IDS)
def test_persist_path_agrees_with_account_121(case_id, case_dir, p121):
    """The write path (`stage_map`) already threaded the anchor; assert it
    still does, and that it carries the same sibling labels the rebuild
    paths now emit. Without this half, the gate could go green on three
    rebuild paths that agree with each other and disagree with what was
    written."""
    bk = _book(case_id, case_dir)
    pl = _pl_of(bk.persist_assembled)
    _assert_anchored(case_id, "persist/stage_map", pl, p121)
    _assert_sibling_fields_present(case_id, "persist/stage_map", pl)
    assert pl.get("net_income_anchor_source") == "parsed_tb_rows"


@pytest.mark.parametrize("case_id,case_dir,p121", ANCHOR_CASES, ids=CASE_IDS)
def test_persist_and_rebuild_agree_field_for_field(case_id, case_dir, p121):
    """CROSS-PATH. Every numeric field of assembled_pl / assembled_bs must
    match between the write path and the rebuild. This is the assertion
    that would have caught the defect: `net_income_statutory` dragged
    `free_cash_flow_proxy`, `assembled_bs.current_year_pnl`,
    `assembled_bs.total_equity` (the NAV cascade's book-equity floor) and
    `bs_balance_delta` with it — 30 disagreeing fields across 7 books."""
    bk = _book(case_id, case_dir)
    rebuilt = P._rebuild_assembled_for_briefing(
        bk.line_items, bk.full_row(), bk.org)["statements"]
    # BOTH SIDES ARE COMPARED AS SERVED. The seam runs
    # `_apply_envelope_truth_to_statements` (Fix A1) before returning, so
    # its assembled_bs totals come from the persisted envelope rather
    # than the lossy line-item round trip. The write-path dict has not
    # had that applied, and comparing raw-against-served would surface
    # the round-trip drift that override exists to REPLACE (0.44%–35.47%
    # across the fixtures per scripts/measure_bs_drift_roundtrip.py) as
    # if it were an anchor problem. Apply the same override to the
    # written side and the comparison isolates what this gate is about.
    written = json.loads(json.dumps(bk.persist_assembled["statements"]))
    P._apply_envelope_truth_to_statements(written, bk.full_row())
    disagreements: List[str] = []
    for view in ("assembled_pl", "assembled_bs"):
        want, got = written.get(view) or {}, rebuilt.get(view) or {}
        for key in sorted(set(want) & set(got)):
            a, b = want[key], got[key]
            if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                if abs(float(a) - float(b)) > 0.005:
                    disagreements.append(
                        "%s.%s: persisted %s vs rebuilt %s"
                        % (view, key, f"{float(a):,.2f}", f"{float(b):,.2f}"))
    assert not disagreements, (
        "[%s] the write path and the rebuild serve different numbers for "
        "the same book (account 121 = %s):\n  %s"
        % (case_id, f"{p121:,.2f}", "\n  ".join(disagreements))
    )


# ── (4) Every assemble_statements call site in pipeline.py ─────────────


def test_every_rebuild_call_site_threads_the_anchor():
    """Structural. The defect was an ASYMMETRY BETWEEN CALL SITES, so
    the invariant has to be about the sites, not about one site's
    output: every `assemble_statements()` in pipeline.py either passes
    `account_121_anchor_override` explicitly (the persist path) or goes
    through `_assemble_with_statutory_anchor`. A fourth seam added later
    without either reds here, before it can serve a number."""
    import ast
    path = SRC / "engine" / "api" / "pipeline.py"
    tree = ast.parse(path.read_text(encoding="utf-8"), str(path))
    bare: List[int] = []
    direct = 0
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute)
                and func.attr == "assemble_statements"):
            continue
        direct += 1
        if not any(kw.arg == "account_121_anchor_override"
                   for kw in node.keywords):
            bare.append(node.lineno)
    assert not bare, (
        "pipeline.py calls assemble_statements() DIRECTLY, without the "
        "account-121 anchor, at line(s) %s. Either pass "
        "`account_121_anchor_override=` (the persist path does) or route "
        "the call through `_assemble_with_statutory_anchor(...)`. "
        "Threading it at one seam and forgetting the next IS the defect "
        "this gate exists for." % bare
    )
    assert direct >= 1, (
        "no direct assemble_statements() call found in pipeline.py — the "
        "AST scan is looking at the wrong shape and would pass vacuously."
    )
    routed = sum(
        1 for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        and node.func.id == "_assemble_with_statutory_anchor"
    )
    assert routed >= 3, (
        "expected the 3 rebuild seams (briefing rebuild, GET /api/period, "
        "review/reanalyze) to assemble through "
        "`_assemble_with_statutory_anchor`; found %d call(s)." % routed
    )


def test_anchor_kwarg_is_skipped_for_a_pack_that_cannot_take_it():
    """The review/reanalyze route assembles through
    `get_pack(confirmed_country_code)`. The Hungarian pack's
    `assemble_statements` has no `account_121_anchor_override`
    parameter, so passing it blind would 500 the route on an RO period
    reanalysed under a confirmed country of HU."""
    from engine.core.country_pack_registry import get_pack
    hu = get_pack("HU")
    if hu is None:  # pragma: no cover — pack not registered in this build
        pytest.skip("HU pack not registered")
    assert P._anchor_kwargs(hu.assemble_statements, 123.45) == {}
    ro = get_pack("RO")
    assert P._anchor_kwargs(ro.assemble_statements, 123.45) == {
        "account_121_anchor_override": 123.45}
    assert P._anchor_kwargs(ro.assemble_statements, None) == {}


def test_an_unappliable_anchor_is_reported_absent_not_within_tolerance():
    """When the anchor cannot be handed to the assembler, the served
    figure is a reconstruction and the label must say `absent`. Calling
    it `within_tolerance` would be the defect wearing a reassuring
    label — the served number would sit millions away from account 121
    while the payload claimed the assembler had considered it."""
    envelope = {
        "statements": {"assembled_pl": {
            "net_income_operational": 14_106_102.03,
            "capitalized_own_work_memo": 0.0,
            "net_income_statutory": 14_106_102.03,
        }}
    }
    P._annotate_net_income_anchor(
        envelope, 7_533_676.02, "envelope_p121_cross_check", applied=False)
    pl = envelope["statements"]["assembled_pl"]
    assert pl["net_income_anchor_status"] == P.NET_INCOME_ANCHOR_ABSENT
    # The resolved anchor is still surfaced so the gap stays visible.
    assert pl["net_income_statutory_anchor"] == 7_533_676.02
    assert pl["net_income_reconstructed"] == 14_106_102.03

    P._annotate_net_income_anchor(
        envelope, 14_106_102.03, "envelope_p121_cross_check", applied=True)
    assert pl["net_income_anchor_status"] == P.NET_INCOME_ANCHOR_ANCHORED


# ── (5) Through the REAL routes ────────────────────────────────────────


class _Postgrest:
    """Projection-faithful Supabase stand-in.

    `columns=` is HONOURED. That is the whole point: a route whose real
    projection omits `assembled_canonical_v1` must not be handed the
    envelope here, or this gate would certify an anchor the production
    query never selects.
    """

    def __init__(self, tables: Dict[str, List[Dict[str, Any]]]) -> None:
        self.tables = tables

    @staticmethod
    def _resolve(row: Dict[str, Any], expr: str) -> Any:
        # `col->a->>b` / `col->>a` / `col`. Normalise `->>` to `->` FIRST:
        # partitioning on `->` before that leaves a stray `>` on the head
        # of the next segment and every text-extraction alias resolves to
        # None — which would silently hand the Radar case an empty
        # projection instead of a faithful one.
        expr = expr.strip().replace("->>", "->")
        if "->" not in expr:
            return row.get(expr)
        head, _, rest = expr.partition("->")
        value = row.get(head.strip())
        for step in rest.split("->"):
            step = step.strip().strip("'\"")
            if not step:
                continue
            if not isinstance(value, dict):
                return None
            value = value.get(step)
        return value

    @classmethod
    def _project(cls, row: Dict[str, Any], columns: str) -> Dict[str, Any]:
        if not columns or columns.strip() == "*":
            return dict(row)
        out: Dict[str, Any] = {}
        for spec in columns.split(","):
            spec = spec.strip()
            if not spec or "(" in spec:
                continue
            if spec == "*":
                out.update(row)
                continue
            alias, sep, expr = spec.partition(":")
            if sep:
                out[alias.strip()] = cls._resolve(row, expr)
            else:
                out[spec] = cls._resolve(row, spec)
        return out

    def select(self, table: str, *, filters: Optional[Dict[str, Any]] = None,
               columns: str = "*", limit: Optional[int] = None,
               order: Optional[str] = None, single: bool = False):
        rows = self.tables.get(table, [])

        def _match(row: Dict[str, Any]) -> bool:
            for key, value in (filters or {}).items():
                value = str(value)
                if value.startswith("eq."):
                    if str(row.get(key)) != value[3:]:
                        return False
                elif value == "is.null":
                    if row.get(key) is not None:
                        return False
                else:
                    return False
            return True

        hits = [self._project(r, columns) for r in rows if _match(r)]
        return hits[:limit] if limit else hits

    def insert(self, table: str, rows: Any, returning: bool = True):
        rows_list = rows if isinstance(rows, list) else [rows]
        self.tables.setdefault(table, []).extend(dict(r) for r in rows_list)
        return rows_list if returning else []

    def update(self, table: str, patch: Dict[str, Any], *,
               filters: Optional[Dict[str, Any]] = None) -> None:
        for row in self.tables.get(table, []):
            if all(str(row.get(k)) == str(v)[3:]
                   for k, v in (filters or {}).items()):
                row.update(patch)

    def delete(self, table: str, *, filters: Optional[Dict[str, Any]] = None) -> None:
        table_rows = self.tables.get(table, [])
        self.tables[table] = [
            r for r in table_rows
            if not all(str(r.get(k)) == str(v)[3:]
                       for k, v in (filters or {}).items())
        ]


@contextlib.contextmanager
def _routed(book: _Book, monkeypatch):
    """Mount the real pipeline router over a projection-faithful double
    seeded with this book's persisted state."""
    tables: Dict[str, List[Dict[str, Any]]] = {
        "financial_periods": [dict(book.period)],
        "statement_line_items": [dict(li) for li in book.line_items],
        "organizations": [dict(book.org)],
        "documents": [],
        "calculated_metrics": [],
        "briefings": [],
        "recommendations": [],
        "alerts": [],
        "valuations": [],
        "org_coa_mappings_overrides": [],
    }
    db = _Postgrest(tables)

    @contextlib.contextmanager
    def _client(*_a, **_k):
        yield db

    monkeypatch.setattr(P._supabase, "admin", _client)
    monkeypatch.setattr(P._supabase, "per_user", _client)
    app = FastAPI()
    app.include_router(P.build_router())
    yield TestClient(app), db


@pytest.mark.parametrize("case_id,case_dir,p121", ANCHOR_CASES, ids=CASE_IDS)
def test_get_period_route_serves_the_anchored_figure(case_id, case_dir, p121,
                                                     monkeypatch):
    """GET /api/period/{period_id} — the Statements page P&L, the
    Valuation tab, the cash-flow statement and the NAV cascade. A DIRECT
    assembler call; it does not go through the briefing seam."""
    bk = _book(case_id, case_dir)
    with _routed(bk, monkeypatch) as (client, _db):
        resp = client.get("/api/period/%s" % bk.period_id,
                          headers={"Authorization": "Bearer test"})
    assert resp.status_code == 200, resp.text[:400]
    pl = _pl_of(resp.json())
    _assert_anchored(case_id, "GET /api/period", pl, p121)
    _assert_sibling_fields_present(case_id, "GET /api/period", pl)


@pytest.mark.parametrize("case_id,case_dir,p121", ANCHOR_CASES, ids=CASE_IDS)
def test_get_period_route_book_equity_matches_the_write_path(case_id, case_dir,
                                                             p121, monkeypatch):
    """The anchor is not a P&L-only concern: `net_income_statutory` lands
    in `assembled_bs.total_equity`, which the NAV cascade reads as the
    book-equity floor. Measured before the fix on
    saga_10_col_realestate: 10,694,320.49 served against a written
    40,284,134.73 — a 3.8x understatement of book equity."""
    bk = _book(case_id, case_dir)
    with _routed(bk, monkeypatch) as (client, _db):
        resp = client.get("/api/period/%s" % bk.period_id,
                          headers={"Authorization": "Bearer test"})
    assert resp.status_code == 200, resp.text[:400]
    served_bs = (resp.json().get("statements") or {}).get("assembled_bs") or {}
    written_bs = bk.persist_assembled["statements"]["assembled_bs"]
    for key in ("current_year_pnl", "total_equity"):
        if key not in served_bs or key not in written_bs:
            continue
        assert abs(float(served_bs[key]) - float(written_bs[key])) < 0.005, (
            "[%s] assembled_bs.%s: served %s vs written %s (account 121 = %s)"
            % (case_id, key, f"{float(served_bs[key]):,.2f}",
               f"{float(written_bs[key]):,.2f}", f"{p121:,.2f}")
        )


@pytest.mark.parametrize("case_id,case_dir,p121", ANCHOR_CASES, ids=CASE_IDS)
def test_reanalyze_route_serves_the_anchored_figure(case_id, case_dir, p121,
                                                    monkeypatch):
    """POST /api/period/{period_id}/review/reanalyze — the third direct
    assembler call. Review overrides re-bucket ACCOUNTS; they never
    re-open the statutory result, so the anchor still governs.

    The response never surfaces `assembled_pl`, only the confidence
    report — but the anchor is observable there, because
    `net_income_statutory` lands in `assembled_bs.total_equity` and so
    drives the balance-sheet reconciliation residual. Reanalysing with
    NO overrides re-buckets nothing, so the route MUST reproduce the
    write path's residual exactly. Measured with the anchor unthreaded:
    saga_10_col_agras reported a 16.85% residual against a written
    0.12%, flipped `reconciliation_status` green → red and raised
    `review_mode_required` — i.e. the missing anchor told the user their
    balance sheet did not balance when it did."""
    from engine.core.confidence_engine import (
        build_confidence_report, confidence_report_to_dict,
    )
    from engine.core.upload_classifier import classify_upload

    bk = _book(case_id, case_dir)
    with _routed(bk, monkeypatch) as (client, _db):
        resp = client.post(
            "/api/period/%s/review/reanalyze" % bk.period_id,
            headers={"Authorization": "Bearer test"},
            json={"account_buckets": {}},
        )
    assert resp.status_code == 200, resp.text[:400]
    served = resp.json().get("post_reanalysis_confidence") or {}
    written = confidence_report_to_dict(build_confidence_report(
        classify_upload(b"Moneda: RON\n", ""), bk.persist_assembled))
    for key in ("reconciliation_residual_pct", "reconciliation_status"):
        assert served.get(key) == written.get(key), (
            "[%s] POST review/reanalyze with no overrides reports %s=%r "
            "but the write path computed %r for the same book. Account "
            "121 = %s; an unanchored rebuild inflates total_equity and "
            "manufactures a balance-sheet residual."
            % (case_id, key, served.get(key), written.get(key),
               f"{p121:,.2f}")
        )


def test_the_double_actually_honours_column_projection():
    """The projection fidelity above is load-bearing — if the double
    ignored `columns=`, the Radar case would be handed an envelope the
    real query never selects and this gate would certify an anchor that
    does not exist in production."""
    db = _Postgrest({"financial_periods": [{
        "id": "p1", "currency": "RON",
        "assembled_canonical_v1": {"schema_version": "v1",
                                   "provenance": {"content_hash": "h"}},
    }]})
    full = db.select("financial_periods", filters={"id": "eq.p1"})[0]
    assert "assembled_canonical_v1" in full
    light = db.select(
        "financial_periods", filters={"id": "eq.p1"},
        columns="id,currency,"
                "snapshot_hash:assembled_canonical_v1->provenance->>content_hash,"
                "has_envelope:assembled_canonical_v1->>schema_version")[0]
    assert "assembled_canonical_v1" not in light, light
    assert light == {"id": "p1", "currency": "RON",
                     "snapshot_hash": "h", "has_envelope": "v1"}
