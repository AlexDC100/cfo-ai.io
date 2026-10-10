"""MARGIN-MEANING — one rule for when a margin over turnover is not
meaningful, held on every surface that prints one, over every corpus book.

THE DEFECT (measured live 2026-09-26, reproduced here on the corpus twin
``saga_10_col_realestate``): a property developer in a building year books
its construction cost through class 6 and capitalises it into stock through
account 711; its turnover is a little rent. The served ratio table printed
an EBITDA margin of -17,884.9%, the forecast cockpit printed "margin
-17,886.1% · today -17,884.9%" and its sentence repeated both. The owner's
acceptance rule: no absurd "100x"-style figure on any screen.

THE RULE (``packs/ratios/margin_meaning.yaml``, ``engine.ratios.
margin_meaning``): a margin over turnover is not meaningful when turnover is
non-zero and |turnover| < max(floor, share_below x total operating expense).
ONE rule, asked by the ratio table (every margin row the pack lists refuses
as ``margin_not_meaningful``, with the share, the threshold and the text),
by GET /api/period (``statements.margin_meaning``, which the dashboard
reads before printing any margin) and by the forecast cockpit (the four
numbers, the sentence, the bank export built from them).

WHAT THIS REDS ON, AFTER THE REPAIR (TC-11):

  · THE RULE — a share exactly at the threshold refused (the comparison is
    strict), one just below it served, a zero or absent turnover or an
    absent activity judged at all, the floor not applied;
  · THE PACK — a malformed pack loaded instead of refused (at first use and
    at boot), a display without its placeholder, a note requirement this
    revision does not evaluate, the note's money display differing from the
    cockpit's;
  · THE MEASUREMENT — a corpus book whose measured share is not the one the
    pack's comment table states, or a book other than the developer on the
    wrong side of the threshold;
  · NO OTHER BOOK MOVES — on EVERY corpus book the real write path and the
    real GET /api/period can serve (every RO trial-balance lane, the mocked
    scanned-PDF lane, the mocked HU lane), the served body with the rule is
    the body with the rule neutralised, byte for byte — the verdict block is
    served only where the rule refuses — except on the developer, where
    exactly the five margin rows (and the coverage entries that count them)
    differ and the verdict is served;
  · THE DEVELOPER SHOWS THE REFUSAL EVERYWHERE — the served verdict, all
    five ratio rows (value and printed value null, code, share, threshold,
    the RO and EN text), the one note — which since the 711 ruling
    (2026-09-26) says EBITDA INCLUDES the stock variation and quotes the
    measured net 711, "29.589,8 mii RON" / "29,589.8K RON" in the unit of
    the EBITDA above it (551,0 mii RON), read off
    ``assembled_pl.inventory_variation.value`` — never the retired
    ``ebitda_statutory_with_711``, never a note saying EBITDA excludes 711;
    the cockpit's final-year and today's margins null with their reason,
    the sentence with no margin clause and no percent, base_period's margin
    null, the note naming its year, the bank export carrying all of it;
  · NO OTHER COCKPIT MOVES — on the four corpus books the cockpit serves
    (and the owner's local pair when FORECAST_LOCAL_SCANDIA is set), the
    cockpit with the rule is the cockpit with it neutralised, byte for byte
    apart from the pin that names the rule's pack.

PLANTS (TC-2), in this file and in docs/engine_book/gates.md
("margin-meaning"): a threshold that reaches normal books, a threshold under
the developer's share, a ratio table that ignores the verdict, a cockpit
that ignores it. Each is run through the same checker the gate runs, and the
checker must RED on it.

CANNOT SEE: what the page paints (the frontend gates in
frontend/lib/__tests__/marginMeaning*.test.ts* read the served shapes), a
book outside the corpus, whether 10% is the right threshold (the pack says
why it was chosen; the owner rules).
"""
from __future__ import annotations

import base64
import contextlib
import copy
import json
import os
import re
import types
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

import pytest
import yaml
from _pytest.monkeypatch import MonkeyPatch

import _served_books as SB
import test_rebuild_net_income_anchor as ANCHOR
from engine.comparatives import LINE_SPECS
from engine.ratios import margin_meaning as MM

REPO = Path(__file__).resolve().parents[2]
PACK = REPO / "packs" / "ratios" / "margin_meaning.yaml"
COCKPIT_PACK = REPO / "packs" / "forecast" / "cockpit.yaml"
CR = ANCHOR.corpus_replay

DEVELOPER = "saga_10_col_realestate"
MARGIN_KEYS = ("gross_margin", "operating_margin", "ebitda_margin", "core_ebitda_margin", "net_margin")

#: What the owner reads on the developer, RO and EN, to the character.
DEVELOPER_REFUSAL = {
    "ro": "marjă nesemnificativă: cifra de afaceri este 0,6% din activitate",
    "en": "margin not meaningful: turnover is 0.6% of activity",
}
#: The note (owner ruling 2026-09-26: EBITDA INCLUDES the stock variation).
#: Its money prints with the ISO code after the figure in both languages
#: (owner ruling 2026-09-29 — codes, never "lei" or a code before it).
#: The amount is the developer's measured net 711 (the account-121 bridge,
#: 29,589,814.24 — measure.md T7), printed in the unit of the served EBITDA
#: above it (550,976.12 → thousands). Before the ruling this note said the
#: EBITDA above did NOT include 711 and quoted a second EBITDA.
DEVELOPER_NOTE = {
    "ro": ("Pentru un dezvoltator imobiliar, costurile de construcție capitalizate în stocuri "
           "trec prin contul 711 (Variația stocurilor de produse): EBITDA de mai sus le include — "
           "29.589,8 mii RON."),
    "en": ("For a property developer, construction costs capitalised into inventory run through "
           "account 711 (Variația stocurilor de produse): the EBITDA above includes them — "
           "29,589.8K RON."),
}
#: The note under the cockpit's final PLAN year (and the bank export). That
#: EBITDA projects net 711 at 0 (design A6 — the card's own year0_step says
#: "not projected: 0 in every plan year"), so the note must NOT say the
#: EBITDA above includes the stock variation: it names the actual year the
#: figure belongs to and says the plan years carry none. The amount prints in
#: the unit of the plan-year EBITDA above it (millions).
#: REWRITTEN 2026-09-27 (fixer round 1), not re-captured: the previous law
#: pinned "the EBITDA above includes them — RON 29.6M in 2025." under an
#: FY2030 EBITDA of RON −32.9M that includes nothing of the kind — the gate
#: encoded the defect.
DEVELOPER_COCKPIT_NOTE = {
    "ro": ("Pentru un dezvoltator imobiliar, costurile de construcție capitalizate în stocuri "
           "trec prin contul 711 (Variația stocurilor de produse): EBITDA din 2025 le-a inclus — "
           "29,6 mil. RON; anii de plan proiectează variația stocurilor la 0, deci EBITDA de mai "
           "sus nu le include."),
    "en": ("For a property developer, construction costs capitalised into inventory run through "
           "account 711 (Variația stocurilor de produse): the 2025 EBITDA included them — "
           "29.6M RON; the plan years project the stock variation at 0, so the EBITDA above "
           "does not include them."),
}

#: turnover / total operating expense, MEASURED on every corpus book that
#: carries turnover (the served assembled_pl through the real route). The
#: pack's comment states the same table; test_the_pack_states_the_measured_table
#: holds the two together.
MEASURED_SHARES = {
    "saga_10_col_carniprod": "0.9989",
    "saga_10_col_retail": "1.0008",
    "saga_10_col": "1.0478",
    "saga_10_col_agras": "1.0719",
    "pdf_positional": "1.0843",
    "saga_compact_6_col": "2.6667",
    DEVELOPER: "0.0055",
}

#: The one corpus case that is not a served period: the public storefront's
#: summary lane (data.gov.ro indicators, no trial balance, never
#: GET /api/period). Stated, so the sweep's coverage is a declaration.
NOT_A_PERIOD = {"public_summary_ro": "public_summary"}

WORK: Dict[str, Any] = {"units": 0, "books": [], "cockpits": [], "plants": []}


# ── the corpus, served ───────────────────────────────────────────────────────


def _lane_book(case_dir: Path) -> Any:
    """A mocked-lane corpus book (scanned PDF, HU AI lane) carried through its
    lane with the scripted client, the REAL stage_map / stage_persist, and
    exposed as the persisted rows a served route reads."""
    from engine.api import pipeline as P

    meta = CR._load_meta(case_dir)
    inp = CR._input_path(case_dir)
    content = inp.read_bytes()
    doc = CR._doc_for(case_dir.name, inp, content, meta)
    parser = str(meta["expected_parser"])
    if parser == "ro_llm_fallback":
        response = json.loads((case_dir / "mock_model_response.json").read_text("utf-8"))["parse_document"]
        from engine.api.financial_statements import ParseRequest, build_router
        handler = next(r.endpoint for r in build_router().routes
                       if getattr(r, "name", None) == "parse_document")
        with CR.scripted_anthropic_module(response):
            served = handler(ParseRequest(pdf_b64=base64.standard_b64encode(content).decode("ascii"),
                                          original_filename=inp.name))
            parsed = served.model_dump() if hasattr(served, "model_dump") else dict(served)
            parsed = P._stamp_llm_extraction(parsed)
        assembled = P.stage_map(doc, parsed, None)
    elif parser == "hu_ai_lane":
        mocks = json.loads((case_dir / "mock_model_responses.json").read_text("utf-8"))
        resolution = CR._lane.resolve_jurisdiction(dict(doc), content)
        client = CR.ScriptedLaneClient([mocks["format_detect"], mocks["extract"], mocks["classify"]])
        cache = CR.FakeAdminClient()
        parsed = CR._lane.run_ai_lane(doc=dict(doc), file_bytes=content,
                                      kind=inp.suffix.lstrip(".").lower() or "csv",
                                      resolution=resolution, client_factory=lambda: client,
                                      admin_factory=lambda: CR.FakeAdminCtx(cache))
        assembled = parsed["ai_lane"]["assembled"]
    else:
        raise AssertionError("no mocked lane for %s (%s)" % (case_dir.name, parser))
    with CR.fake_persist_seam() as fake:
        period_id = P.stage_persist(doc, parsed, assembled)
        line_items = [dict(r) for r in fake.inserted_line_items]
        period = dict(fake.period_rows[0])
    return types.SimpleNamespace(period=period, line_items=line_items,
                                 org={"id": doc["org_id"], "name": "Corpus Entity"},
                                 period_id=period_id)


_BOOKS: Dict[str, Any] = {}


def corpus_cases() -> List[Path]:
    return sorted(CR.discover_cases(REPO / "corpus"))


def corpus_book(case_dir: Path) -> Any:
    if case_dir.name not in _BOOKS:
        parser = str(CR._load_meta(case_dir)["expected_parser"])
        _BOOKS[case_dir.name] = (_lane_book(case_dir) if parser in ("ro_llm_fallback", "hu_ai_lane")
                                 else ANCHOR._Book(case_dir))
    return _BOOKS[case_dir.name]


def served_books() -> List[Path]:
    return [d for d in corpus_cases() if d.name not in NOT_A_PERIOD]


# ── the pack, planted ────────────────────────────────────────────────────────


@contextlib.contextmanager
def pack_with(tmp: Path, **rule: str) -> Iterator[Path]:
    """The committed pack with ``rule`` values replaced, read through
    MARGIN_MEANING_PACKS_DIR for the duration; the committed pack after."""
    raw = yaml.safe_load(PACK.read_text("utf-8"))
    raw["rule"].update(rule)
    tmp.mkdir(parents=True, exist_ok=True)
    (tmp / MM.PACK_NAME).write_text(yaml.safe_dump(raw, allow_unicode=True, sort_keys=False), "utf-8")
    mp = MonkeyPatch()
    mp.setenv("MARGIN_MEANING_PACKS_DIR", str(tmp))
    MM._load.cache_clear()
    try:
        yield tmp / MM.PACK_NAME
    finally:
        mp.undo()
        MM._load.cache_clear()


#: A threshold no real turnover falls under, and no floor: the rule as if it
#: were not there — the body production served before it.
NEUTRAL = {"share_below": "0.000000001", "floor": "0"}


def serve_all(neutral_dir: Optional[Path] = None, **rule: str) -> Dict[str, Dict[str, Any]]:
    """GET /api/period through the real router for every served corpus book,
    under the committed pack (no argument) or a planted one."""
    ctx = pack_with(neutral_dir, **rule) if neutral_dir is not None else contextlib.nullcontext()
    with ctx:
        return dict((d.name, SB.routed_body(corpus_book(d))) for d in served_books())


def _without_verdict(body: Dict[str, Any]) -> Dict[str, Any]:
    out = copy.deepcopy(body)
    (out.get("statements") or {}).pop("margin_meaning", None)
    return out


def _rows(body: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    table = (body.get("assembled_metrics") or {}).get("ratio_table") or {}
    return dict((r["key"], r) for r in table.get("rows") or [])


def _share_rows(body: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    block = (body.get("statements") or {}).get("common_size") or {}
    return dict((r["key"], r) for r in block.get("rows") or [])


#: The statement lines whose share of turnover is a margin — every RESULT
#: over turnover, and nothing else. WRITTEN HERE, not read off the registry:
#: read off it, the sweep below agreed with a registry that declared a COST
#: line a margin (plant MM1 left the gate green until this list was its own).
MARGIN_LINE_KEYS = ("pl.gross_profit", "pl.ebitda", "pl.ebit", "pl.pretax",
                    "pl.net_income_operational", "pl.net_income")


def _paths_that_differ(a: Any, b: Any, path: str = "$") -> List[str]:
    if type(a) is not type(b):
        return [path]
    if isinstance(a, dict):
        out: List[str] = []
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                out.append("%s.%s" % (path, k))
            else:
                out.extend(_paths_that_differ(a[k], b[k], "%s.%s" % (path, k)))
        return out
    if isinstance(a, list):
        if len(a) != len(b):
            return [path]
        out = []
        for i, (x, y) in enumerate(zip(a, b)):
            out.extend(_paths_that_differ(x, y, "%s[%d]" % (path, i)))
        return out
    return [] if a == b else [path]


# ── THE CHECKERS (the gate runs these; the plants must red them) ─────────────


def sweep_failures(active: Dict[str, Dict[str, Any]],
                   neutral: Dict[str, Dict[str, Any]]) -> List[str]:
    """Every book but the developer: the active body IS the neutral body,
    apart from the verdict block. The developer: only its margin rows and
    the coverage entries counting them differ."""
    failures = []
    for book in sorted(active):
        a, n = _without_verdict(active[book]), _without_verdict(neutral[book])
        verdict = (active[book].get("statements") or {}).get("margin_meaning") or {}
        if book != DEVELOPER:
            if "margin_meaning" in (active[book].get("statements") or {}):
                failures.append("%s: serves a margin verdict on a book the rule does not refuse" % book)
            if verdict.get("status") == MM.NOT_MEANINGFUL:
                failures.append("%s: the rule refuses a normal book's margins (share %s, threshold %s)"
                                % (book, verdict.get("share"), verdict.get("threshold")))
            diff = _paths_that_differ(a, n)
            if diff:
                failures.append("%s: the served body moved at %s" % (book, ", ".join(diff[:8])))
            continue
        # AMENDED 2026-10-04 (gate common-size-single, fix round). A result
        # line's share of turnover IS a margin, so the rule also governs the
        # period's own share block (`statements.common_size`): on the
        # developer the block's margin lines carry no share and say why —
        # their share, status and note move; their amount, and every other
        # row of the block, do not (checked below, line by line).
        allowed = re.compile(
            r"^\$\.assembled_metrics\.ratio_table\.(rows\[\d+\]\.(value|value_q|band|band_status|ladder|"
            r"ladder_floor|reason)(\..+)?|coverage\.(served|refused|band_withheld)(\..+)?)$"
            r"|^\$\.statements\.common_size\.rows\[\d+\]\.(share|status|note)$")
        moved = _paths_that_differ(a, n)
        stray = [p for p in moved if not allowed.match(p)]
        if stray:
            failures.append("%s: the served body moved outside the margin rows at %s" % (book, ", ".join(stray[:8])))
        rows_a, rows_n = _rows(a), _rows(n)
        moved_keys = sorted(k for k in rows_a if rows_a[k] != rows_n[k])
        if moved_keys != sorted(MARGIN_KEYS):
            failures.append("%s: the rows that moved are %s, not the five margins" % (book, moved_keys))
        declared = sorted(spec.key for spec in LINE_SPECS if spec.margin)
        if declared != sorted(MARGIN_LINE_KEYS):
            failures.append("%s: the registry declares %s as margins, not the result lines %s"
                            % (book, declared, sorted(MARGIN_LINE_KEYS)))
        shares_a, shares_n = _share_rows(a), _share_rows(n)
        moved_lines = sorted(k for k in shares_a if shares_a[k] != shares_n.get(k))
        if moved_lines != sorted(MARGIN_LINE_KEYS):
            failures.append("%s: the share rows that moved are %s, not the result lines %s"
                            % (book, moved_lines, sorted(MARGIN_LINE_KEYS)))
        for key in moved_lines:
            refused, free = shares_a[key], shares_n[key]
            if (refused["status"], refused["share"]) != (MM.MARGIN_NOT_MEANINGFUL, None):
                failures.append("%s: %s is served %r / %r under a refused margin"
                                % (book, key, refused["status"], refused["share"]))
            if free["status"] != "share" or free["share"] is None:
                failures.append("%s: %s takes no share even under a rule that refuses nothing" % (book, key))
            if refused["current"] != free["current"] or refused["current"] is None:
                failures.append("%s: the rule moved the AMOUNT of %s" % (book, key))
    return failures


def developer_failures(body: Dict[str, Any]) -> List[str]:
    """The developer's served period shows the refusal, and the note, everywhere."""
    failures = []
    verdict = (body.get("statements") or {}).get("margin_meaning") or {}
    if verdict.get("status") != MM.NOT_MEANINGFUL:
        failures.append("the developer's served verdict is %r, not not_meaningful" % verdict.get("status"))
    if verdict.get("display") != DEVELOPER_REFUSAL:
        failures.append("the developer's served refusal reads %r" % verdict.get("display"))
    note = verdict.get("note") or {}
    if note.get("display") != DEVELOPER_NOTE:
        failures.append("the developer's note reads %r" % note.get("display"))
    apl = (body.get("statements") or {}).get("assembled_pl") or {}
    served_711 = (apl.get("inventory_variation") or {}).get("value")
    if (note.get("figure") or {}).get("source") != "assembled_pl.inventory_variation.value" or \
            (note.get("figure") or {}).get("value") != served_711 or served_711 is None:
        failures.append("the note's figure is not the served net 711 (%r): %r" % (served_711, note.get("figure")))
    # The retired figures stay retired: no served field quotes the gross 711.
    for retired in ("ebitda_statutory_with_711", "inventory_variation_memo"):
        if retired in apl:
            failures.append("the developer's assembled_pl still serves the retired %s" % retired)
    # The note sits under the ONE EBITDA, which includes the variation.
    for lang, text in (note.get("display") or {}).items():
        if "does not include" in text or "nu le include" in text:
            failures.append("the %s note says EBITDA excludes 711: %r" % (lang, text))
    rows = _rows(body)
    for key in MARGIN_KEYS:
        row = rows.get(key) or {}
        reason = row.get("reason") or {}
        if row.get("value") is not None or row.get("value_q") is not None:
            failures.append("%s printed %r on the developer" % (key, row.get("value_q")))
        if row.get("band_status") != "refused" or reason.get("code") != MM.MARGIN_NOT_MEANINGFUL:
            failures.append("%s: %s / %r, not refused as margin_not_meaningful" % (
                key, row.get("band_status"), reason.get("code")))
        if reason.get("display") != DEVELOPER_REFUSAL:
            failures.append("%s's reason reads %r" % (key, reason.get("display")))
        if reason.get("threshold") != "0.10" or reason.get("share") != verdict.get("share"):
            failures.append("%s's reason carries share %r / threshold %r" % (
                key, reason.get("share"), reason.get("threshold")))
    return failures


_PERCENT = re.compile(r"[−-]?\d[\d.,]*\s?%")


def cockpit_failures(active: Dict[str, Dict[str, Any]], neutral: Dict[str, Dict[str, Any]]) -> List[str]:
    """Every cockpit but the developer's: the same bytes (the margin pack's pin
    and the body hash over it aside). The developer's: the refusal in both
    margins, no margin clause and no percent in the sentence, base_period's
    margin null, the note naming its year."""
    failures = []
    for book in sorted(active):
        a, n = copy.deepcopy(active[book]), copy.deepcopy(neutral[book])
        for body in (a, n):
            body.pop("recompute_ms", None)
            body.pop("pins", None)
        if book != "realestate":
            diff = _paths_that_differ(a, n)
            if diff:
                failures.append("cockpit %s moved at %s" % (book, ", ".join(diff[:8])))
            if "margin_refused" in json.dumps(active[book]):
                failures.append("cockpit %s serves a margin refusal" % book)
            continue
        e = active[book]["numbers"]["ebitda_final_year"]
        for lang in ("ro", "en"):
            d = e["display"][lang]
            if d.get("margin") is not None or d.get("margin_year0") is not None:
                failures.append("cockpit developer %s prints margins %r / %r" % (
                    lang, d.get("margin"), d.get("margin_year0")))
            if d.get("margin_refused") != DEVELOPER_REFUSAL[lang] or \
                    d.get("margin_year0_refused") != DEVELOPER_REFUSAL[lang]:
                failures.append("cockpit developer %s refusals read %r / %r" % (
                    lang, d.get("margin_refused"), d.get("margin_year0_refused")))
            expected_note = DEVELOPER_COCKPIT_NOTE[lang]
            if d.get("note") != expected_note:
                failures.append("cockpit developer %s note reads %r" % (lang, d.get("note")))
            # The EBITDA above the note is a PLAN year's, which projects net
            # 711 at 0: a note claiming it includes the stock variation
            # contradicts the card's own year-0 step.
            if ("above includes" in (d.get("note") or "")
                    or "de mai sus le include" in (d.get("note") or "")):
                failures.append("cockpit developer %s note says the plan-year EBITDA includes 711: %r"
                                % (lang, d.get("note")))
            if not (e.get("year0_step") or {}).get("inventory_variation"):
                failures.append("cockpit developer carries no year-0 stock-variation step beside its note")
            sentence = active[book]["sentence"][lang]
            if _PERCENT.search(sentence) or "marj" in sentence or "margin" in sentence:
                failures.append("cockpit developer %s sentence carries a margin: %r" % (lang, sentence))
        if e.get("margin_ppm") is not None or e.get("margin_year0_ppm") is not None:
            failures.append("cockpit developer serves margin ppm %r / %r" % (
                e.get("margin_ppm"), e.get("margin_year0_ppm")))
        if active[book]["base_period"]["figures"].get("ebitda_margin_ppm") is not None:
            failures.append("cockpit developer base_period serves a margin")
        if active[book]["sentence"]["template"][-1] != "ebitda_margin_not_meaningful":
            failures.append("cockpit developer sentence template %r" % active[book]["sentence"]["template"])
        for key in ("margin_meaning", "margin_year0_meaning"):
            if (e.get(key) or {}).get("status") != MM.NOT_MEANINGFUL:
                failures.append("cockpit developer %s is %r" % (key, e.get(key)))
    return failures


# ── 1. the rule ──────────────────────────────────────────────────────────────


def test_the_rule_is_strict_at_the_threshold_and_exact_on_floats():
    t = MM.margin_meaning_pack().share_below
    assert str(t) == "1/10", t
    # exactly at the threshold: meaningful (the comparison is strict)
    assert MM.judge(10, 100).status == MM.MEANINGFUL
    # a hair under it: refused, with the share it read
    v = MM.judge(9.999999, 100)
    assert v.status == MM.NOT_MEANINGFUL and v.reason == MM.REASON_SHARE
    # a float is read bit for bit: 0.1 * 100 is not exactly 10
    assert MM.judge(0.1 * 100, 100).status == MM.MEANINGFUL
    # sign: |turnover| is what is compared
    assert MM.judge(-5, 100).status == MM.NOT_MEANINGFUL and MM.judge(-50, 100).status == MM.MEANINGFUL
    WORK["units"] += 6


def test_the_rule_does_not_judge_what_it_cannot_read():
    assert MM.judge(0, 100).reason == "turnover_zero"
    assert MM.judge(None, 100).reason == "turnover_absent"
    assert MM.judge(float("nan"), 100).reason == "turnover_absent"
    assert MM.judge(100, None).reason == "activity_absent"
    for v in (MM.judge(0, 100), MM.judge(None, 100), MM.judge(100, None)):
        assert v.status == MM.NOT_APPLICABLE and not v.refused
        assert MM.refusal_display(v) is None
    # no activity at all and a real turnover: nothing to be negligible against
    assert MM.judge(500, 0).status == MM.MEANINGFUL
    WORK["units"] += 8


def test_the_floor_is_the_packs_and_speaks_its_currency():
    v = MM.judge(0.5, 0)
    assert v.status == MM.NOT_MEANINGFUL and v.reason == MM.REASON_FLOOR
    assert MM.refusal_display(v, "RON") == {
        "ro": "marjă nesemnificativă: cifra de afaceri este sub 1 RON",
        "en": "margin not meaningful: turnover is below 1 RON"}
    assert MM.judge(1, 0).status == MM.MEANINGFUL
    WORK["units"] += 3


def test_the_note_is_the_packs_one_case_only():
    """Every requirement of note.requires is necessary: the margin refused,
    the account mix read as real estate, a positive 711. The corpus refuses
    one book, so each requirement is proven here on the verdict itself."""
    refused = MM.judge(162365.46, 29280043.3)
    served = dict(industry_family="real_estate", inventory_variation=29589814.24,
                  unit_of=550976.12)
    assert MM.note_block(refused, **served)["display"] == DEVELOPER_NOTE
    assert MM.note_block(refused, **served)["figure"] == {
        "source": "assembled_pl.inventory_variation.value", "value": 29589814.24, "year": None}
    for family in ("manufacturing", "trade", "services", None):
        assert MM.note_block(refused, **dict(served, industry_family=family)) is None, family
    # a zero, negative or REFUSED (None) net 711 serves no note
    for net_711 in (0, -1.0, None):
        assert MM.note_block(refused, **dict(served, inventory_variation=net_711)) is None, net_711
    assert MM.note_block(MM.judge(110798309.14, 103367367.84), **served) is None
    # the amount prints in the unit of the EBITDA above it
    assert MM.note_block(refused, **dict(served, unit_of=4000000))["display"]["ro"].endswith(
        "EBITDA de mai sus le include — 29,6 mil. RON.")
    WORK["units"] += 11


def test_a_share_is_never_printed_as_zero():
    v = MM.judge(3, 100000000)
    assert MM.refusal_display(v)["en"] == "margin not meaningful: turnover is 0.000003% of activity"
    assert MM.refusal_display(MM.judge(162365.46, 29280043.3)) == DEVELOPER_REFUSAL
    WORK["units"] += 2


# ── 2. the pack ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("edit,message", [
    (lambda raw: raw["rule"].update(share_below="1.5"), "share_below: must lie in"),
    (lambda raw: raw["rule"].update(share_below=0.1), "a decimal string is required"),
    (lambda raw: raw["rule"].update(activity="total_operating_revenue_statutory"), "rule.activity"),
    (lambda raw: raw["rule"].update(floor="-1"), "floor: must not be negative"),
    (lambda raw: raw["display"]["share"].update(ro="marjă nesemnificativă"), "must place {share}"),
    (lambda raw: raw["note"]["requires"].update(industry_family="manufacturing"), "note.requires"),
    (lambda raw: raw.update(schema_version="margin_meaning/0"), "schema_version"),
])
def test_a_broken_pack_is_refused_at_first_use_and_at_boot(tmp_path, monkeypatch, edit, message):
    raw = yaml.safe_load(PACK.read_text("utf-8"))
    edit(raw)
    (tmp_path / MM.PACK_NAME).write_text(yaml.safe_dump(raw, allow_unicode=True), "utf-8")
    monkeypatch.setenv("MARGIN_MEANING_PACKS_DIR", str(tmp_path))
    MM._load.cache_clear()
    try:
        with pytest.raises(MM.MarginMeaningPackError, match=re.escape(message)):
            MM.margin_meaning_pack()
        from engine import boot_verify
        with pytest.raises(RuntimeError, match=r"margin-meaning pack .* is unusable"):
            boot_verify.verify_margin_meaning_pack()
    finally:
        monkeypatch.delenv("MARGIN_MEANING_PACKS_DIR")
        MM._load.cache_clear()
    WORK["units"] += 2


def test_the_notes_money_display_is_the_cockpits():
    mine = yaml.safe_load(PACK.read_text("utf-8"))["money_display"]
    cockpit = yaml.safe_load(COCKPIT_PACK.read_text("utf-8"))["money_display"]
    assert mine == cockpit, (mine, cockpit)
    WORK["units"] += 1


def test_the_pack_states_the_measured_table():
    """The pack's comment table is the measurement, not a paraphrase of it."""
    text = " ".join(PACK.read_text("utf-8").split())
    for case, share in MEASURED_SHARES.items():
        assert "%s %s" % (case, share) in text, "the pack's table does not state %s %s" % (case, share)
    WORK["units"] += len(MEASURED_SHARES)


# ── 3. every corpus book, served ─────────────────────────────────────────────


@pytest.fixture(scope="module")
def served_active() -> Dict[str, Dict[str, Any]]:
    return serve_all()


@pytest.fixture(scope="module")
def served_neutral(tmp_path_factory) -> Dict[str, Dict[str, Any]]:
    return serve_all(tmp_path_factory.mktemp("neutral-pack"), **NEUTRAL)


def test_every_corpus_case_is_served_or_declared_not_a_period(served_active):
    names = set(d.name for d in corpus_cases())
    assert set(served_active) | set(NOT_A_PERIOD) == names, sorted(names ^ (set(served_active) | set(NOT_A_PERIOD)))
    for case, parser in NOT_A_PERIOD.items():
        assert str(CR._load_meta(REPO / "corpus" / case)["expected_parser"]) == parser, case
    assert len(served_active) >= 17, sorted(served_active)
    WORK["units"] += len(names)


def test_the_measured_shares_are_the_corpus_and_only_the_developer_is_refused(served_active):
    """The rule over every served body's own statements, and the block the
    route serves: present exactly where the rule refuses, and equal to the
    rule's own block there."""
    measured = {}
    refused = []
    for book, body in sorted(served_active.items()):
        statements = body["statements"]
        verdict, inputs = MM.period_verdict(statements)
        if verdict.share is not None:
            measured[book] = "%.4f" % float(verdict.share)
        served = statements.get("margin_meaning")
        if verdict.refused:
            refused.append(book)
            assert served is not None and served["version"] == MM.SCHEMA_VERSION, (book, served)
            assert served["status"] == MM.NOT_MEANINGFUL and served["share"] == MM.served_block(
                verdict, inputs)["share"], (book, served)
        else:
            assert served is None, (book, "a verdict that refuses nothing is not served", served)
        print("MM-SWEEP %s status=%s share=%s" % (
            book, verdict.status, None if verdict.share is None else "%.6f" % float(verdict.share)))
        WORK["books"].append(book)
    assert measured == MEASURED_SHARES, measured
    assert refused == [DEVELOPER], refused
    WORK["units"] += len(served_active)


def test_no_corpus_book_but_the_developer_moves_on_the_served_period(served_active, served_neutral):
    failures = sweep_failures(served_active, served_neutral)
    assert not failures, "\n  ".join(["THE RULE MOVED A BOOK IT MUST NOT:"] + failures)
    WORK["units"] += sum(len(json.dumps(b)) > 0 for b in served_active.values())


def test_the_developer_shows_the_refusal_and_the_note_on_the_served_period(served_active):
    failures = developer_failures(served_active[DEVELOPER])
    assert not failures, "\n  ".join(["THE DEVELOPER PRINTS A MARGIN:"] + failures)
    body = served_active[DEVELOPER]
    # what the rule read is what the statements serve
    apl = body["statements"]["assembled_pl"]
    verdict = body["statements"]["margin_meaning"]
    assert float(verdict["turnover"]) == pytest.approx(apl["revenue"], abs=1e-6)
    assert float(verdict["activity"]) == pytest.approx(apl["total_operating_expense"], abs=1e-6)
    # the note is the case's alone: no other book carries one
    print("MM-DEVELOPER %s refused on %d ratio rows, the served verdict and the note"
          % (DEVELOPER, len(MARGIN_KEYS)))
    WORK["units"] += len(MARGIN_KEYS) * 4 + 4


def test_only_the_developer_carries_the_note(served_active):
    carriers = sorted(b for b, body in served_active.items()
                      if (body["statements"].get("margin_meaning") or {}).get("note"))
    assert carriers == [DEVELOPER], carriers
    WORK["units"] += len(served_active)


def test_the_benchmark_page_refuses_the_margin_the_card_refused(served_active):
    """The sector benchmark's company side IS the ratio card where their
    definitions agree (engine.benchmarks_ro.sector): the developer's net
    margin card refuses, so the page refuses the same figure — it used to
    restate −493.7% from the filed basis beside a card that printed none.
    Every other book keeps the card's figure."""
    from engine.benchmarks_ro.sector import company_figures
    dev = company_figures(served_active[DEVELOPER])["net_margin"]
    assert dev["value"] is None and dev["reason"]["code"] == "company_margin_not_meaningful", dev
    assert dev["basis"] == "ratio_table.net_margin", dev
    for book in ("saga_10_col_agras", "saga_10_col_carniprod", "saga_10_col_retail"):
        figure = company_figures(served_active[book])["net_margin"]
        assert figure["value"] is not None and figure["reason"] is None, (book, figure)
    WORK["units"] += 4


def test_no_absurd_percent_is_served_on_the_developer(served_active):
    """The owner's acceptance rule, on the served ratio table: no percent the
    developer is served reaches a hundredfold of its turnover."""
    for row in served_active[DEVELOPER]["assembled_metrics"]["ratio_table"]["rows"]:
        if row["display_unit"] == "pct" and row["value"] is not None:
            assert abs(row["value"]) < 1000, (row["key"], row["value_q"])
    WORK["units"] += 1


def test_the_frontend_fixture_is_what_the_route_serves_today():
    """frontend/lib/__tests__/exportBooks.ts joins this file onto the four
    firm books: a stale copy would test the page against a verdict the
    engine no longer serves."""
    import importlib.util
    path = REPO / "tests" / "engine" / "fixtures" / "firm" / "capture_margin_meaning.py"
    spec = importlib.util.spec_from_file_location("capture_margin_meaning", str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    on_disk = (REPO / "tests" / "engine" / "fixtures" / "firm" / "margin_meaning.json").read_text("utf-8")
    assert on_disk == mod.serialise(mod.capture()), (
        "tests/engine/fixtures/firm/margin_meaning.json is stale; rerun capture_margin_meaning.py")
    WORK["units"] += len(mod.BOOKS)


# ── 4. the cockpit ───────────────────────────────────────────────────────────

COCKPIT_BOOKS = ("agras", "carniprod", "retail", "realestate")


def _cockpit_books() -> Tuple[str, ...]:
    import test_forecast_cockpit as C
    return tuple(C.BOOKS)


def _cockpits(requests: Tuple[Tuple[str, Dict[str, Any]], ...] = (("base", {}),),
              route: str = "cockpit") -> Dict[str, Dict[str, Any]]:
    import test_forecast_cockpit as C
    out = {}
    for name in _cockpit_books():
        with C._World(name) as world:
            for label, body in requests:
                key = name if label == "base" else "%s/%s" % (name, label)
                out[key] = world.ok(body, route=route)
    return out


@pytest.fixture(scope="module")
def cockpit_active() -> Dict[str, Dict[str, Any]]:
    return _cockpits()


@pytest.fixture(scope="module")
def cockpit_neutral(tmp_path_factory) -> Dict[str, Dict[str, Any]]:
    with pack_with(tmp_path_factory.mktemp("neutral-cockpit"), **NEUTRAL):
        return _cockpits()


def test_no_cockpit_but_the_developers_moves_and_the_developer_shows_the_refusal(cockpit_active,
                                                                                 cockpit_neutral):
    failures = cockpit_failures(cockpit_active, cockpit_neutral)
    assert not failures, "\n  ".join(["THE COCKPIT:"] + failures)
    WORK["cockpits"].extend(sorted(cockpit_active))
    WORK["units"] += len(cockpit_active) * 3


def test_the_developers_cockpit_reads_the_rule_on_its_own_plan_year(cockpit_active):
    e = cockpit_active["realestate"]["numbers"]["ebitda_final_year"]
    final = e["margin_meaning"]
    today = e["margin_year0_meaning"]
    assert final["inputs"] == ["pl.revenue", "pl.cost_of_sales+pl.operating_costs+pl.depreciation+pl.amortisation"]
    assert today["inputs"] == ["assembled_pl.revenue", "assembled_pl.total_operating_expense"]
    # the final year's own operands, from the served statements of that year
    stmts = cockpit_active["realestate"]["statements"]["pl"]
    last = dict((r["line"], r["values"][-1]["amount_minor"]) for r in stmts)
    activity = -(last["pl.cost_of_sales"] + last["pl.operating_costs"] + last["pl.depreciation"]
                 + last["pl.amortisation"])
    assert final["turnover"] == "%d.%02d0000" % divmod(last["pl.revenue"], 100)
    assert final["activity"] == "%d.%02d0000" % divmod(activity, 100)
    WORK["units"] += 4


def test_a_slider_that_grows_turnover_is_judged_again(cockpit_active):
    """The final year is judged on the plan the reader moved to: thirty per
    cent a year for five years leaves the developer's turnover negligible
    against its construction cost, and the refusal says so with the new
    share."""
    import test_forecast_cockpit as C
    with C._World("realestate") as world:
        moved = world.ok({"levers": {"revenue_growth": "0.30"}})
    e = moved["numbers"]["ebitda_final_year"]
    assert e["display"]["en"]["margin"] is None
    assert e["margin_meaning"]["status"] == MM.NOT_MEANINGFUL
    assert e["margin_meaning"]["share"] != cockpit_active["realestate"]["numbers"]["ebitda_final_year"][
        "margin_meaning"]["share"]
    WORK["units"] += 3


def test_the_bank_export_carries_the_refusal_and_the_note():
    import test_forecast_cockpit as C
    with C._World("realestate") as world:
        doc = world.ok({}, route="cockpit/export")
    e = doc["cockpit"]["numbers"]["ebitda_final_year"]
    assert e["display"]["ro"]["margin_refused"] == DEVELOPER_REFUSAL["ro"]
    assert e["display"]["en"]["margin_year0_refused"] == DEVELOPER_REFUSAL["en"]
    assert e["display"]["ro"]["note"] == DEVELOPER_COCKPIT_NOTE["ro"]
    assert e["display"]["en"]["note"] == DEVELOPER_COCKPIT_NOTE["en"]
    for lang in ("ro", "en"):
        assert not _PERCENT.search(doc["document"]["sentence"][lang]), doc["document"]["sentence"][lang]
    WORK["units"] += 5


def test_the_developers_committed_cockpit_fixtures_are_what_the_route_serves():
    """frontend/lib/__tests__/marginMeaning.test.tsx reads these bytes (the
    developer's base cockpit and its bank export); regenerate with
    scripts/gen_cockpit_fixtures.py --book realestate --requests base,export."""
    import test_forecast_cockpit as C
    fixtures = REPO / "tests" / "engine" / "fixtures" / "forecast"
    wanted = dict((name, (route, body)) for name, route, body in C.FIXTURE_REQUESTS
                  if name in ("base", "export"))
    assert set(wanted) == {"base", "export"}, sorted(wanted)
    with C._World("realestate") as world:
        for name, (route, body) in sorted(wanted.items()):
            served = world.ok(body, route=route)
            on_disk = json.loads((fixtures / ("cockpit_realestate_%s.json" % name)).read_text("utf-8"))
            assert (on_disk.get("cockpit") or on_disk)["pins"]["body_hash"] == \
                (served.get("cockpit") or served)["pins"]["body_hash"], (
                "cockpit_realestate_%s.json is stale; regenerate it" % name)
    WORK["units"] += 2


# ── 5. PLANTS — each must red the checker the gate runs ──────────────────────


def test_plant_a_threshold_that_reaches_a_normal_book_reds_the_sweep(served_neutral, tmp_path):
    """share_below 0.999 refuses every book whose turnover is under 99.9% of
    its operating expense — the normal carniprod book (0.9989), and no other.
    The sweep must name it as refused AND as moved; a planted pack the rule
    cannot read (a threshold of 1 or more) is a different red, at the pack."""
    planted = serve_all(tmp_path / "plant", share_below="0.999")
    failures = sweep_failures(planted, served_neutral)
    assert any(f.startswith("saga_10_col_carniprod: the rule refuses a normal book's margins") for f in failures), failures
    assert any(f.startswith("saga_10_col_carniprod: the served body moved") for f in failures), failures
    assert not any(f.startswith(("saga_10_col_agras", "saga_10_col_retail", "pdf_positional")) for f in failures), failures
    WORK["plants"].append("threshold-reaches-a-normal-book")
    WORK["units"] += 3


def test_plant_a_threshold_under_the_developer_reds_the_developer_check(tmp_path):
    planted = serve_all(tmp_path / "plant", share_below="0.001")
    failures = developer_failures(planted[DEVELOPER])
    assert any("not not_meaningful" in f for f in failures), failures
    assert any("ebitda_margin printed" in f for f in failures), failures
    WORK["plants"].append("threshold-under-the-developer")
    WORK["units"] += 2


def test_plant_a_ratio_table_that_ignores_the_verdict_reds(monkeypatch, served_neutral):
    monkeypatch.setattr(MM, "margin_keys", lambda: ())
    planted = SB.routed_body(corpus_book(REPO / "corpus" / DEVELOPER))
    failures = developer_failures(planted)
    assert any("net_margin printed" in f for f in failures), failures
    WORK["plants"].append("table-ignores-the-verdict")
    WORK["units"] += 1


def test_plant_a_cockpit_that_ignores_the_verdict_reds(monkeypatch, cockpit_neutral):
    from engine.forecast import cockpit as CK

    class Blind(object):
        def __getattr__(self, name):
            return getattr(MM, name)

        @staticmethod
        def judge(turnover, activity):
            return MM.Verdict(MM.MEANINGFUL, None, None, None, None)

        @staticmethod
        def period_verdict(statements):
            return MM.Verdict(MM.MEANINGFUL, None, None, None, None), MM.PERIOD_INPUTS

    monkeypatch.setattr(CK, "margin_meaning", Blind())
    planted = _cockpits()
    failures = cockpit_failures(planted, cockpit_neutral)
    assert any("prints margins" in f for f in failures), failures
    assert any("sentence carries a margin" in f for f in failures), failures
    WORK["plants"].append("cockpit-ignores-the-verdict")
    WORK["units"] += 2


# ── scope and work ───────────────────────────────────────────────────────────


def test_zz_scope_and_work(capsys):
    with capsys.disabled():
        print("\nSCOPE margin-meaning (packs/ratios/margin_meaning.yaml): %d served corpus books "
              "through the real write path and GET /api/period, the forecast cockpit and its bank "
              "export on %s, and %d plants" % (len(WORK["books"]), ", ".join(_cockpit_books()),
                                                len(WORK["plants"])))
        print("MM-SWEEP books: %s" % ", ".join(WORK["books"]))
        print("MM-PLANTS: %s" % ", ".join(WORK["plants"]))
        print("GATE-WORK margin-meaning units=%d" % WORK["units"])
    assert WORK["books"], "TC-3: the sweep judged no book"
