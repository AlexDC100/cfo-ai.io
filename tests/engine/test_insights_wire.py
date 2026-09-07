"""THE WIRE — `statements.insights` reaches the reader, down EVERY served path.

WHAT THIS GATE IS FOR
=====================
`src/engine/insights/` was built, tested (95 engine tests) and committed,
and it was CALLED FROM NO ROUTE. `statements.insights` was absent on every
served payload, so the owner read the report and correctly said nothing had
changed. This file gates the wire, not the engine: lane A's four suites
already pin what `build_insights` computes; nothing here re-asserts a
detector's arithmetic.

THE HAZARD IT IS SHAPED AROUND
==============================
CLAUDE.md §14 and `memory/two-assembly-paths-anchor-asymmetry`: the
account-121 anchor was threaded into the persist path and not into the
served rebuild paths, and every served "statutory" net income was a raw
reconstruction for months, because each path was internally consistent and
no single-path test could see it. So this gate is CROSS-PATH by
construction:

  * `test_the_seam_census_...` reds when a NEW served-statements seam
    appears in pipeline.py without the block — a source census, not a
    hand-kept list, so a third path cannot be added silently.
  * `test_the_two_seams_serve_the_same_block...` compares the block the
    HTTP route serves with the block the shared rebuild seam serves, byte
    for byte, on every corpus book.

THE TWO SEAMS (both measured here, both over the real routes/seam):
  1. `pipeline.get_period`                      — GET /api/period/{id}
  2. `pipeline._rebuild_assembled_for_briefing` — Capsule / Radar / firm
                                                  attention / briefing

WHAT IT REDS ON, AFTER THE REPAIR (TC-11)
=========================================
  * `statements.insights` missing from the GET /api/period response on a
    corpus book that carries canonical rows;
  * the two seams disagreeing on so much as one byte of the block;
  * a new function in pipeline.py that serves an `assembled_pl` (or runs
    `_apply_envelope_truth_to_statements`) and does not attach the block;
  * the block being served on a book whose canonical rows were NOT served
    — the false-all-clear case measured in
    `test_a_book_whose_rows_were_not_served_gets_no_block...`;
  * an empty block (`insights: []` AND `not_fired: []`) being attached,
    i.e. `[]` served where ABSENT is the truth;
  * an account inside a served insight that no served line item, no
    single-account canonical row and no `unmapped` entry vouches for;
  * a severity basis that disagrees with the served `assembled_bs` figure
    of the same name — one concept, two values, on one payload;
  * the Agras findings the owner asked for going missing or moving
    (70.44% depreciated, the current-ratio collapse, the 46.6%
    reconstruction step, account 413's 46,613.06);
  * a field `frontend/lib/insights.ts` reads disappearing from the wire;
  * `build_insights` raising and taking the whole response down with it.

WHAT IT CANNOT SEE
==================
  * Whether the report RENDERS the block. Nothing in `financialReport.ts`
    / `financialExports.ts` / `ComprehensiveReport.tsx` reads
    `readInsights` yet — that is lanes B/C's gate to write, and until they
    do, a green run here means the data is on the wire and nothing more.
  * Whether the detectors' figures are RIGHT. Lane A's suites own that.
  * Production. The Supabase double below is projection-faithful and the
    routes are the real ones, but no live deploy is exercised.
  * The AI narrative lane: `drafter=None` at the wire, so every narrative
    served is the deterministic template. A gate for a wired drafter does
    not exist because a wired drafter does not exist.

NO FAKE ASSEMBLER, NO MIRROR STORE. Every book below is a real corpus
workbook carried through the real production write path (`stage_map` →
`stage_persist`) and read back through the real routes. The one double is
the projection-faithful Supabase stand-in from
`test_rebuild_net_income_anchor` — reused rather than re-written so the
two cross-path gates cannot drift apart in what they consider "served".
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from engine.api import pipeline as P  # noqa: E402

# The cross-path harness: `_Book` (corpus → stage_map → stage_persist),
# `_routed` (the real router over a projection-faithful Supabase double)
# and the corpus case list. Imported, not copied — two gates that disagree
# about what "served" means would each be green over a different product.
import test_rebuild_net_income_anchor as ANCHOR  # noqa: E402

CASES = ANCHOR.ANCHOR_CASES
CASE_IDS = ANCHOR.CASE_IDS

PIPELINE_SRC = SRC / "engine" / "api" / "pipeline.py"

#: The book the owner read, and the four findings they named.
AGRAS = "saga_10_col_agras"

#: Every key `frontend/lib/insights.ts` reads off an insight. The reader
#: is tolerant (it defaults a missing field), which is exactly why the
#: wire has to be gated here: a field that stops being emitted degrades
#: silently into a blank card instead of an error.
INSIGHT_KEYS = (
    "id", "title", "claim", "claim_template", "formula", "severity",
    "measures", "accounts", "facts", "rank", "rank_basis", "in_summary",
    "narrative",
)
SEVERITY_KEYS = ("level", "basis", "basis_label", "basis_value", "magnitude",
                 "materiality", "bands", "why")
LEVELS = ("critical", "high", "medium", "low", "info")
UNITS = ("money", "ratio", "pct", "multiple", "days", "years", "count")


# ── helpers ───────────────────────────────────────────────────────────


def _canon(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def _book(case_id: str, case_dir: Path):
    return ANCHOR._book(case_id, case_dir)


def _served_via_route(bk, monkeypatch, period_row_patch: Optional[Dict[str, Any]] = None
                      ) -> Tuple[int, Dict[str, Any]]:
    """GET /api/period/{id} through the real router. `period_row_patch`
    edits the seeded `financial_periods` row before the read, so a period
    whose envelope was never persisted can be driven too."""
    with ANCHOR._routed(bk, monkeypatch) as (client, db):
        if period_row_patch:
            db.tables["financial_periods"][0].update(period_row_patch)
        resp = client.get("/api/period/%s" % bk.period_id,
                          headers={"Authorization": "Bearer test"})
    return resp.status_code, (resp.json() if resp.status_code == 200 else {})


def _served_via_seam(bk) -> Dict[str, Any]:
    return P._rebuild_assembled_for_briefing(
        bk.line_items, bk.full_row(), bk.org)["statements"]


def _block_of(statements: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    return (statements or {}).get("insights")


def _insight(block: Dict[str, Any], insight_id: str) -> Dict[str, Any]:
    for ins in block["insights"]:
        if ins["id"] == insight_id:
            return ins
    raise AssertionError(
        "the served block carries no %r insight; it carries %s"
        % (insight_id, [i["id"] for i in block["insights"]]))


def _measure(insight: Dict[str, Any], key: str) -> Any:
    for m in insight["measures"]:
        if m["key"] == key:
            return m["value"]
    raise AssertionError(
        "%s has no measure %r; it has %s"
        % (insight["id"], key, [m["key"] for m in insight["measures"]]))


# ══ 1. THE SEAM CENSUS — no third path can be added silently ══════════


def _functions_calling(tree: ast.AST, names: Tuple[str, ...]) -> Dict[str, set]:
    """Every function in the module (nested route handlers included) and
    which of `names` it calls directly in its own body."""
    found: Dict[str, set] = {}

    class Walk(ast.NodeVisitor):
        def __init__(self) -> None:
            self.stack: List[str] = []

        def _enter(self, node: Any) -> None:
            self.stack.append(node.name)
            key = ".".join(self.stack)
            found.setdefault(key, set())
            for sub in ast.walk(node):
                if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name):
                    if sub.func.id in names:
                        # Attribute the call to the INNERMOST enclosing
                        # function, so a route handler's call is not
                        # credited to `build_router`.
                        found[key].add(sub.func.id)
            self.generic_visit(node)
            self.stack.pop()

        def visit_FunctionDef(self, node):  # noqa: N802
            self._enter(node)

        def visit_AsyncFunctionDef(self, node):  # noqa: N802
            self._enter(node)

    Walk().visit(tree)
    return found


def _innermost_callers(name: str) -> List[str]:
    """Qualified names of the functions whose OWN body calls `name`
    (a call inside a nested def is credited to the nested def only)."""
    tree = ast.parse(PIPELINE_SRC.read_text(encoding="utf-8"))
    found = _functions_calling(tree, (name,))
    hits = sorted(k for k, v in found.items() if name in v)
    # Drop enclosing functions that only "call" it via a nested def.
    return [h for h in hits
            if not any(other != h and other.startswith(h + ".") for other in hits)]


def test_the_seam_census_every_served_statements_seam_attaches_the_block():
    """THE ANTI-ASYMMETRY GATE. Any function in pipeline.py that finishes a
    served `statements` dict must attach the insight block. "Finishes a
    served statements dict" is read off the source two ways — it runs the
    envelope-truth override, or it writes `statements["assembled_pl"]` —
    so a new seam written in either idiom is caught.

    This is the gate the account-121 defect did not have."""
    source = PIPELINE_SRC.read_text(encoding="utf-8")
    tree = ast.parse(source)
    calls = _functions_calling(
        tree, ("_apply_envelope_truth_to_statements", "_attach_insights_block"))

    # Idiom A — runs the envelope-truth override.
    override = set(_innermost_callers("_apply_envelope_truth_to_statements"))
    # Idiom B — writes statements["assembled_pl"].
    assembles: set = set()

    class Assign(ast.NodeVisitor):
        def __init__(self) -> None:
            self.stack: List[str] = []

        def _fn(self, node):
            self.stack.append(node.name)
            self.generic_visit(node)
            self.stack.pop()

        visit_FunctionDef = _fn
        visit_AsyncFunctionDef = _fn

        def visit_Subscript(self, node):  # noqa: N802
            target = node.value
            index = node.slice
            if (isinstance(target, ast.Name) and target.id == "statements"
                    and isinstance(index, ast.Constant)
                    and index.value == "assembled_pl" and self.stack):
                assembles.add(".".join(self.stack))
            self.generic_visit(node)

    Assign().visit(tree)

    seams = sorted(override | assembles)
    assert len(seams) >= 2, (
        "the census found %d served-statements seam(s) in pipeline.py — it "
        "needs at least the two known ones (get_period and "
        "_rebuild_assembled_for_briefing) or it is asserting nothing: %s"
        % (len(seams), seams))
    missing = [s for s in seams if "_attach_insights_block" not in calls.get(s, set())]
    assert not missing, (
        "ASSEMBLY-PATH ASYMMETRY — %s in pipeline.py finish(es) a served "
        "`statements` dict and never call `_attach_insights_block`, so "
        "`statements.insights` is ABSENT down that path while the other "
        "seam(s) %s serve it. This is the shape of the account-121 anchor "
        "defect (CLAUDE.md §14): each path self-consistent, the reader "
        "getting a different book depending on which one answered."
        % (missing, [s for s in seams if s not in missing]))


def test_the_census_names_the_two_seams_we_know_about():
    """A census is only as good as its reach. Name the two seams so a
    RENAME that moves the wire out of the census' sight is a red, not a
    quiet pass over a shrunken population."""
    seams = set(_innermost_callers("_attach_insights_block"))
    for expected in ("_rebuild_assembled_for_briefing",
                     "build_router.get_period"):
        assert expected in seams, (
            "%r no longer calls `_attach_insights_block` (callers found: "
            "%s). If the seam was renamed, re-point this list; if it was "
            "deleted, the wire lost a path." % (expected, sorted(seams)))


# ══ 2. THE WIRE ITSELF — the block is on the served envelope ══════════


@pytest.mark.parametrize("case_id,case_dir,_p121", CASES, ids=CASE_IDS)
def test_get_period_serves_the_insight_block(case_id, case_dir, _p121, monkeypatch):
    """GET /api/period/{id} — the payload the report reads. Before the
    wire this key was absent on every book and `readInsights` returned
    null, so the report showed nothing."""
    bk = _book(case_id, case_dir)
    status, body = _served_via_route(bk, monkeypatch)
    assert status == 200
    statements = body.get("statements") or {}
    block = _block_of(statements)
    assert block is not None, (
        "[%s] GET /api/period served no `statements.insights`. The book "
        "carries canonical rows (%d) and an assembled P&L, so the engine "
        "had everything it needs — the wire is broken, not the book."
        % (case_id, len(((statements.get("canonical_bs") or {}).get("rows")) or [])))
    assert block["schema_version"] == "insights/1", block["schema_version"]
    assert block["currency"] == (statements.get("currency") or "RON")
    assert isinstance(block["insights"], list)
    assert isinstance(block["not_fired"], list)
    assert block["insights"] or block["not_fired"], (
        "[%s] an EMPTY block was served — no insight and no stated gap. "
        "`[]` here reads to the reader as 'checked, nothing wrong'; "
        "absence is the honest answer and the wire must omit the key."
        % case_id)


@pytest.mark.parametrize("case_id,case_dir,_p121", CASES, ids=CASE_IDS)
def test_the_two_seams_serve_the_same_block_byte_for_byte(
        case_id, case_dir, _p121, monkeypatch):
    """CROSS-PATH. The HTTP route and the shared rebuild seam (Capsule,
    Radar, firm attention, briefing regenerate) must serve ONE block. A
    reader must not get a different set of findings depending on which
    surface answered."""
    bk = _book(case_id, case_dir)
    _status, body = _served_via_route(bk, monkeypatch)
    route = _block_of(body.get("statements") or {})
    seam = _block_of(_served_via_seam(bk))
    assert _canon(route) == _canon(seam), (
        "[%s] the two served seams disagree about the insight block. "
        "route ids=%s seam ids=%s"
        % (case_id,
           None if route is None else [i["id"] for i in route["insights"]],
           None if seam is None else [i["id"] for i in seam["insights"]]))


@pytest.mark.parametrize("case_id,case_dir,_p121", CASES, ids=CASE_IDS)
def test_the_served_block_is_deterministic(case_id, case_dir, _p121, monkeypatch):
    """Same book, same bytes. `build_insights` is called with
    `drafter=None`, so no clock, no model and no network can enter the
    served payload."""
    bk = _book(case_id, case_dir)
    _s1, first = _served_via_route(bk, monkeypatch)
    _s2, second = _served_via_route(bk, monkeypatch)
    assert _canon(_block_of(first.get("statements") or {})) == \
        _canon(_block_of(second.get("statements") or {})), case_id


def test_the_wire_runs_no_model_and_serves_the_deterministic_narrative():
    """The advisory lane is NOT wired. Every narrative on the served block
    is the engine's own template; nothing on this path can call a model,
    so no served figure can come from one."""
    bk = _book(AGRAS, REPO / "corpus" / AGRAS)
    block = _block_of(_served_via_seam(bk))
    sources = sorted(set(i["narrative"]["source"] for i in block["insights"]))
    assert sources == ["deterministic"], (
        "the wire served an AI-authored narrative (%s) although it passes "
        "no drafter. Something else is reaching a model on this path."
        % sources)


# ══ 3. ABSENT != ZERO ════════════════════════════════════════════════


def test_a_book_whose_rows_were_not_served_gets_no_block_at_all(monkeypatch):
    """THE LAW, and the measurement behind it.

    When the persisted canonical envelope is absent the served payload
    carries no canonical rows — `_apply_envelope_truth_to_statements`
    withholds them deliberately, because the re-assembled ones are a
    round-trip artifact. Build the block anyway on that payload and the
    engine says, of the very book that carries 46,613.06 under an
    Unclassified row:

        Every account in the book matched a classification rule; no
        balance is carried under an Unclassified row.

    That is a false all-clear manufactured out of absence. So the wire
    refuses: no rows, no block, and the reader renders nothing."""
    bk = _book(AGRAS, REPO / "corpus" / AGRAS)

    # The book really does carry the unmapped balance.
    unmapped = (((bk.period.get("assembled_canonical_v1") or {})
                 .get("canonical_bs") or {}).get("unmapped")) or []
    codes = dict((str(u.get("code")), float(u.get("sf_d") or 0)) for u in unmapped)
    assert codes.get("413") == pytest.approx(46613.06, abs=0.005), codes

    status, body = _served_via_route(
        bk, monkeypatch, period_row_patch={"assembled_canonical_v1": None})
    assert status == 200, "withholding the envelope must not break the read"
    statements = body.get("statements") or {}
    assert statements.get("canonical_bs") is None, (
        "the premise moved: the payload DOES carry served canonical rows, "
        "so this case no longer exercises the refusal.")
    assert "insights" not in statements, (
        "a block was served over a book whose canonical rows were never "
        "served. Its `not_fired` would then claim every account matched a "
        "classification rule on a book that carries %s under an "
        "Unclassified row." % codes)

    # And the claim that justifies the refusal is real, not asserted.
    from engine.insights import build_insights
    would_have = build_insights({"statements": statements,
                                 "line_items": bk.line_items})
    reasons = dict((n["id"], n["reason"]) for n in would_have["not_fired"])
    assert "unclassified_balances" in reasons, sorted(reasons)
    assert "matched a classification rule" in reasons["unclassified_balances"], (
        "the false all-clear this refusal exists to stop is no longer the "
        "text the engine produces: %r" % reasons["unclassified_balances"])


def test_a_stated_gap_is_served_and_is_not_silence():
    """The other half of ABSENT != ZERO. On a book that WAS read, a
    detector that could not conclude lands in `not_fired` with a reason
    the reader can print — never dropped, never a zero."""
    case = "saga_compact_6_col"
    bk = _book(case, REPO / "corpus" / case)
    block = _block_of(_served_via_seam(bk))
    assert block is not None, case
    assert block["not_fired"], (
        "[%s] this book fires almost nothing; its stated gaps are the "
        "whole content of the block and they are missing." % case)
    for entry in block["not_fired"]:
        assert entry["id"] and entry["title"], entry
        assert len(entry["reason"].split()) >= 5, (
            "a stated gap must state something: %r" % entry)


def test_a_measure_the_book_does_not_carry_is_null_not_zero():
    """`null` survives the wire. The reader prints "not reported" for it;
    a 0.0 arriving instead would be printed as a figure."""
    seen_null = []
    for case_id, case_dir, _p121 in CASES:
        bk = _book(case_id, case_dir)
        block = _block_of(_served_via_seam(bk))
        if not block:
            continue
        for ins in block["insights"]:
            for m in ins["measures"]:
                assert m["value"] is None or isinstance(m["value"], (int, float)), m
                if m["value"] is None:
                    seen_null.append((case_id, ins["id"], m["key"]))
    assert seen_null, (
        "no served measure on any corpus book is null, so this gate never "
        "exercises the absent branch — it would stay green if the wire "
        "started coercing absent measures to 0.0.")


# ══ 4. ONE AUTHORITY — the block agrees with the payload it rides ═════


@pytest.mark.parametrize("case_id,case_dir,_p121", CASES, ids=CASE_IDS)
def test_every_account_named_by_an_insight_is_vouched_for_by_the_payload(
        case_id, case_dir, _p121):
    """TRACEABILITY. Every account code an insight prints must resolve, at
    the balance it prints, to something else on the SAME served payload:
    a line item, a canonical row that names exactly that one account, or
    an `unmapped` entry. An insight naming a figure nothing else on the
    payload carries is unauditable by the reader."""
    bk = _book(case_id, case_dir)
    statements = _served_via_seam(bk)
    block = _block_of(statements)
    if not block:
        pytest.skip("no block on %s" % case_id)
    by_code = {}
    for li in bk.line_items:
        code = str(li.get("ro_account_code") or "")
        if code:
            by_code[code] = float(li.get("amount") or 0)
    cbs = statements.get("canonical_bs") or {}
    single_row = {}
    for row in (cbs.get("rows") or []):
        leaves = [str(x) for x in (row.get("leaf_ids") or [])]
        if len(leaves) == 1:
            single_row[leaves[0]] = float(row.get("amount") or 0)
    unmapped = {}
    for entry in (cbs.get("unmapped") or []):
        unmapped[str(entry.get("code"))] = (
            float(entry.get("sf_d") or 0) - float(entry.get("sf_c") or 0))

    orphans: List[str] = []
    for ins in block["insights"]:
        for acct in ins["accounts"]:
            code, amount = acct["code"], float(acct["amount"])
            candidates = [by_code.get(code), single_row.get(code),
                          unmapped.get(code)]
            if by_code.get(code) is not None:
                candidates.append(-by_code[code])
            if not any(c is not None and abs(c - amount) < 0.005
                       for c in candidates):
                orphans.append(
                    "%s/%s: %s = %.2f, and the payload's own figures for it "
                    "are line_item=%s row=%s unmapped=%s"
                    % (ins["id"], code, code, amount, by_code.get(code),
                       single_row.get(code), unmapped.get(code)))
    assert not orphans, "[%s] untraceable insight accounts:\n  %s" % (
        case_id, "\n  ".join(orphans))


@pytest.mark.parametrize("case_id,case_dir,_p121", CASES, ids=CASE_IDS)
def test_a_severity_basis_is_the_same_figure_the_statements_serve(
        case_id, case_dir, _p121):
    """ONE CONCEPT, ONE VALUE. A severity chip that says "19.2% of total
    assets" must be scaled against the total assets THIS payload serves —
    not the write-path figure, which differs by the unmapped balance on
    the Agras book (39,319,114.09 served against 39,272,501.03
    assembled). The insight rides beside the ratio cards; if its
    denominator is a different book's, the two disagree on one screen."""
    bk = _book(case_id, case_dir)
    statements = _served_via_seam(bk)
    block = _block_of(statements)
    if not block:
        pytest.skip("no block on %s" % case_id)
    bs = statements.get("assembled_bs") or {}
    pl = statements.get("assembled_pl") or {}
    served_for = {
        "total_assets": bs.get("total_assets"),
        "total_equity": bs.get("total_equity"),
        "total_current_liabilities": bs.get("total_current_liabilities"),
        "revenue": pl.get("revenue"),
    }
    for ins in block["insights"]:
        sev = ins["severity"]
        expected = served_for.get(sev["basis"])
        if expected is None or sev["basis_value"] is None:
            continue
        assert abs(float(sev["basis_value"]) - abs(float(expected))) < 0.005, (
            "[%s] %s is graded against %s = %s, but the served statements "
            "carry %s for it."
            % (case_id, ins["id"], sev["basis"], sev["basis_value"], expected))


# ══ 5. THE SHAPE `frontend/lib/insights.ts` READS ════════════════════


@pytest.mark.parametrize("case_id,case_dir,_p121", CASES, ids=CASE_IDS)
def test_the_served_block_satisfies_the_reader_contract(case_id, case_dir, _p121):
    """Every field `readInsights` picks up, on every served insight. The
    reader defaults a missing field rather than throwing, so a field that
    silently stopped being emitted would render as a blank card — this is
    the only place that can catch it."""
    bk = _book(case_id, case_dir)
    block = _block_of(_served_via_seam(bk))
    if not block:
        pytest.skip("no block on %s" % case_id)
    assert set(block) == {"schema_version", "currency", "insights",
                          "summary_ids", "not_fired"}, sorted(block)
    ids = [i["id"] for i in block["insights"]]
    assert len(ids) == len(set(ids)), ids
    assert [i["rank"] for i in block["insights"]] == list(range(1, len(ids) + 1)), (
        "ranks must be 1..N in served order: %s" % [i["rank"] for i in block["insights"]])
    assert len(block["summary_ids"]) <= 5, block["summary_ids"]
    assert block["summary_ids"] == [i["id"] for i in block["insights"]
                                    if i["in_summary"]], (
        "summary_ids and in_summary disagree — the contract names "
        "summary_ids as the authority and the reader can read either.")
    assert set(block["summary_ids"]) <= set(ids)

    for ins in block["insights"]:
        for key in INSIGHT_KEYS:
            assert key in ins, "%s/%s missing %r" % (case_id, ins["id"], key)
        sev = ins["severity"]
        for key in SEVERITY_KEYS:
            assert key in sev, "%s/%s.severity missing %r" % (case_id, ins["id"], key)
        assert sev["level"] in LEVELS, sev["level"]
        assert sev["basis"] and sev["basis_label"], sev
        assert sev["bands"], (
            "%s/%s serves no ladder — TC-10: the cutoffs must render from "
            "the same data the verdict used." % (case_id, ins["id"]))
        assert sev["level"] in [b["level"] for b in sev["bands"]], sev
        assert any(b["at_least"] is None for b in sev["bands"]), (
            "%s/%s: the ladder has no floor band" % (case_id, ins["id"]))
        assert len(sev["why"].split()) >= 8, sev["why"]
        for m in ins["measures"]:
            assert m["unit"] in UNITS, m
            assert m["key"] and m["label"], m
        for a in ins["accounts"]:
            assert a["code"] and a["role"], a
            assert isinstance(a["amount"], (int, float)), a
        for f in ins["facts"]:
            assert f["name"] and f["label"] and f["unit"] in UNITS, f
        nar = ins["narrative"]
        assert nar["source"] in ("ai", "deterministic"), nar
        assert nar["explanation"] and nar["so_what"], (
            "%s/%s serves an empty narrative" % (case_id, ins["id"]))
        assert "{" not in ins["claim"] and "}" not in ins["claim"], (
            "%s/%s served an un-substituted placeholder in its claim: %r"
            % (case_id, ins["id"], ins["claim"]))


# ══ 6. THE AGRAS FINDINGS THE OWNER ASKED FOR, OFF THE WIRE ══════════


def _agras_block(monkeypatch) -> Dict[str, Any]:
    bk = _book(AGRAS, REPO / "corpus" / AGRAS)
    status, body = _served_via_route(bk, monkeypatch)
    assert status == 200
    block = _block_of(body.get("statements") or {})
    assert block is not None, "the Agras book served no insight block"
    return block


def test_agras_serves_the_depreciated_asset_base(monkeypatch):
    """"70.4% of gross PP&E is already depreciated" — the first thing the
    owner said the report never told them."""
    ins = _insight(_agras_block(monkeypatch), "asset_age")
    assert ins["severity"]["level"] == "high"
    assert _measure(ins, "depreciated_share") == pytest.approx(0.704407, abs=5e-6)
    assert _measure(ins, "gross_ppe") == pytest.approx(37400897.02, abs=0.005)
    assert "70.4%" in ins["claim"], ins["claim"]
    codes = set(a["code"] for a in ins["accounts"])
    assert {"2131.01", "2813.01"} <= codes, sorted(codes)


def test_agras_serves_the_current_ratio_collapse(monkeypatch):
    """The headline current ratio against the one that survives removing
    non-trade receivables. Both figures come off the SERVED book, so they
    are the ratio the report's own cards print."""
    ins = _insight(_agras_block(monkeypatch), "liquidity_quality")
    headline = _measure(ins, "current_ratio")
    trade_only = _measure(ins, "current_ratio_trade_only")
    assert headline > trade_only > 1.0, (headline, trade_only)
    assert round(headline, 2) == 2.10 and round(trade_only, 2) == 1.50, (
        "the served collapse is %.4f -> %.4f. NOTE: the owner quoted "
        "2.11 -> 1.51, which is the figure off the WRITE-PATH statements "
        "(total_current_assets 27,476,056.94); the SERVED payload carries "
        "the envelope-true 27,371,337.47, so the report's own ratio card "
        "reads 2.10. The insight must agree with the card beside it."
        % (headline, trade_only))
    assert _measure(ins, "non_trade") == pytest.approx(7803433.57, abs=0.005)


def test_agras_serves_the_reconstruction_gap(monkeypatch):
    """The 46.6% step between the rebuilt P&L and account 121."""
    ins = _insight(_agras_block(monkeypatch), "reconstruction_gap")
    assert _measure(ins, "graded_share") == pytest.approx(0.465928, abs=5e-6)
    assert _measure(ins, "statutory") == pytest.approx(7533676.02, abs=0.005)
    assert _measure(ins, "reconstructed") == pytest.approx(14106102.03, abs=0.005)
    assert _measure(ins, "step") == pytest.approx(-6572426.01, abs=0.005)
    assert [a["code"] for a in ins["accounts"]] == ["121"], ins["accounts"]


def test_agras_serves_account_413(monkeypatch):
    """46,613.06 RON sitting under an Unclassified row — the balance the
    owner said the report never mentions. It is now on the wire, with the
    account code that carries it."""
    ins = _insight(_agras_block(monkeypatch), "unclassified_balances")
    assert [a["code"] for a in ins["accounts"]] == ["413"], ins["accounts"]
    assert ins["accounts"][0]["amount"] == pytest.approx(46613.06, abs=0.005)
    assert "46,613.06" in ins["claim"], ins["claim"]


def test_agras_carries_all_eight_findings_into_the_summary_ordering(monkeypatch):
    """The whole reading, ranked, with the top five flagged for the
    executive summary."""
    block = _agras_block(monkeypatch)
    assert [i["id"] for i in block["insights"]] == [
        "asset_age", "liquidity_quality", "reconstruction_gap",
        "related_party_exposure", "unclassified_balances",
        "earnings_quality", "trade_float", "financial_position",
    ], [i["id"] for i in block["insights"]]
    assert block["summary_ids"] == [
        "asset_age", "liquidity_quality", "reconstruction_gap",
        "related_party_exposure", "unclassified_balances",
    ], block["summary_ids"]
    assert block["not_fired"] == []


# ══ 7. THE WIRE NEVER COSTS THE READER THE REPORT ════════════════════


def test_a_failing_insight_engine_leaves_the_key_absent_and_the_report_intact(
        monkeypatch):
    """The block is a supplement, not a precondition. If `build_insights`
    raises, the response is still a 200 carrying the whole report and the
    key is ABSENT — never half-written, never an empty list."""
    bk = _book(AGRAS, REPO / "corpus" / AGRAS)

    import engine.insights as insights_mod

    def _boom(*_a, **_k):
        raise RuntimeError("planted: the insight engine is down")

    monkeypatch.setattr(insights_mod, "build_insights", _boom)
    status, body = _served_via_route(bk, monkeypatch)
    assert status == 200, "a failing insight engine took the period read down"
    statements = body.get("statements") or {}
    assert "insights" not in statements
    assert (statements.get("assembled_pl") or {}).get("net_income_statutory") \
        is not None, "the rest of the report must be untouched"


def test_the_block_is_not_attached_without_an_assembled_pl():
    """No P&L, no reading. Every detector's basis comes off the assembled
    P&L or the canonical rows; a payload with neither would produce eight
    gaps computed from nothing."""
    statements: Dict[str, Any] = {"currency": "RON"}
    P._attach_insights_block(statements, [])
    assert "insights" not in statements


def test_the_helper_never_raises_on_a_malformed_payload():
    for payload in ({}, {"assembled_pl": "not a dict"},
                    {"assembled_pl": {"revenue": 1}, "canonical_bs": []},
                    {"assembled_pl": {"revenue": 1},
                     "assembled_canonical_v1": {"canonical_bs": {"rows": "x"}}}):
        P._attach_insights_block(payload, None)  # must not raise
        assert "insights" not in payload, payload
