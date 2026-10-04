"""GATE ai-figures-engine — A BRIEFING'S FIGURES ARE WRITTEN IN THE READER'S
FORMAT, AND NO VALUE CHANGES ON THE WAY.

OWNER ORDER (2026-10-04, verbatim): "Add to the next release: make chat and
briefings write numbers in Romanian format in Romanian text (413.727.560
RON, ~77,4 mil. EUR), currency after the figure. Use the product's own
formatting standard, with a gate."

WHAT WAS TRUE BEFORE. A briefing is prose a model wrote, stored as written.
One prompt hint asked for the format ("Numbers in RO locale; cite currency
as 'RON' (e.g. '1.234.567 RON')") and nothing HELD it: the day the model
writes "~EUR 12.3M (marjă 11.25%)" in a Romanian sentence — the shape the
chat printed in production on 2026-10-04 — that is what is stored, answered
by the regenerate route and served to every member of the workspace.

"With a gate" means the OUTPUT is held, not only the prompt. So this file
drives the REAL `stage_narrate`, the real regenerate route, the real
`stage_persist_narrative` and the real GET /api/period with a scripted
provider that answers wrong-format replies a model really writes, and reads
what comes out with a detector that is NOT the code under test.

THE LAWS
  E1  THE TWIN. `engine.ai.figure_format.normalise_figures` over the shared
      corpus (tests/engine/fixtures/ai_figures/reply_corpus.json — `expected`
      typed by hand) and the shared grid (grid.json — 984 figures as
      frontend/lib/money prints them): the output is `expected` / lib/money's
      print byte for byte, every token left is the one the corpus names with
      the reason it names, the digit sequence never changes, a second pass
      changes nothing, and a lone three-digit group comes back byte-identical
      — with or without handed figures equal to either reading. Handed
      figures change nothing but `bare_decimal` / `bare_groups` tokens. The
      browser's `frontend/lib/readerFigures.ts` is held to the SAME two files.
  E2  THE STANDARD. `STANDARD` and `HINT_EXAMPLES` equal standard.json —
      which vitest writes from frontend/lib/money and re-generates on every
      run (frontend/lib/__tests__/chatLlmFigureFormat.test.ts) — and the
      magnitude words equal the engine's own packs' `money_display`.
  E3  THE DETECTOR IS THE FRONTEND'S. Its patterns are read out of
      frontend/test/numberLanguage.ts and compiled here — no second copy.
      It is what reads every output below (never the normaliser itself:
      "never compare a printed figure only against the same printer").
  E4  THE SEAM. The real `stage_narrate`, the provider answering each
      briefing case of the corpus as the briefing AND as a recommendation's
      title, rationale and action — Romanian and English, RON and EUR: what
      it returns is `expected`, passes the detector, is usable, and no field
      that is not prose moved.
  E5  STORED = ANSWERED = SERVED. The real regenerate route (metered) and
      the real `stage_persist_narrative` store, answer and serve exactly the
      bytes `stage_narrate` returned; one provider call; the unit committed
      once; a converted ("Regenerează în EUR") narration is answered
      normalised and never stored.
  E6  OTHER LANGUAGES ARE NOT TOUCHED. A de / fr / es / it / pt / nl / pl
      narration, and one in a code the narrator has no instruction for, is
      the model's text byte for byte, and its LANGUAGE line is the one main
      sent (written out below).
  E7  NEVER BREAKS A NARRATION. With the pass made to raise, or the module
      made unimportable: the narration is the model's text, usable, stored.
  E8  THE HINT. For ro / en x RON / EUR the system prompt the provider
      received carries the figure format with the product's own example
      strings and the code AFTER the figure; the phrases the route gate
      asserts ("cite currency as '<CODE>'", "pre-converted to <CODE>") stay.
  E9  FAILURES AND THE NUMERAL GUARD. Every failure branch returns its text
      untouched and the pass is never run on it; AI_NUMERAL_GUARD off /
      observe give the same normalised narration; enforce withholds as it
      always did.
  E10 NO SPEND. No socket was attempted (run with `-p netblock`), and the
      model was only ever the stand-in.

REDS ON, with the repair in place (TC-11): a rule of the normaliser changed
on one runtime only (the corpus / grid differ); a value guessed (a lone
group rewritten, with or without a handed figure); a digit dropped; the
run-time proof removed; STANDARD or the hint's examples retyped away from
what lib/money prints; the pass removed from `stage_narrate`, moved before
the numeral guard's verdict, run on a failure result, or extended to a
field that is not prose; a writer or the route storing something other than
what the narrator returned; another language's narration or hint changing
by a byte; an exception of the pass reaching a caller.

CANNOT SEE: what a model WRITES (the provider is a script); rows stored
before this release (no stored row is rewritten — the browser's card repairs
what it shows); a narration the model wrote in ANOTHER language than it was
asked for (it is normalised in the asked language — notation only, never a
value); a token left by design — a lone three-digit group ("162,365 RON" in
Romanian text) passes every law and the detector; a recommendation whose
`actions` is one string instead of a list (the numeral guard does not walk
it either); the non-statement (SKU / invoice register) prompt's own wording
beyond carrying the same hint; whether a figure is TRUE.

PLANT LOG: docs/engine_book/gates.md "ai-figures-engine".
"""
from __future__ import annotations

import ast
import copy
import json
import re
import sys
import types
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import pytest

import _real_app_comparatives as RA
import _served_books as SB
import test_briefing_keep_last_good_route as ROUTE
import test_briefing_keep_last_good_served as SERVED
from engine.ai import figure_format as F
from engine.api import pipeline as P

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "tests" / "engine" / "fixtures" / "ai_figures"
NUMBER_LANGUAGE_TS = REPO / "frontend" / "test" / "numberLanguage.ts"

CORPUS: List[Dict[str, Any]] = json.loads((FIXTURES / "reply_corpus.json").read_text(encoding="utf-8"))["cases"]
GRID: Dict[str, Any] = json.loads((FIXTURES / "grid.json").read_text(encoding="utf-8"))
STANDARD_JSON: Dict[str, Any] = json.loads((FIXTURES / "standard.json").read_text(encoding="utf-8"))

#: What this gate did, for the battery's canary (printed by the last test).
WORK = {"corpus": 0, "grid": 0, "narrations": 0}

#: The nine narration languages (pipeline.NARRATION_LANGUAGES), written out.
ALL_LANGUAGES = ("en", "ro", "de", "fr", "es", "it", "pt", "nl", "pl")
OTHER_LANGUAGES = ("de", "fr", "es", "it", "pt", "nl", "pl")

_AMBIENT = ("PUBLIC_TEST_MODE", "ENGINE_TEST_MODE", "USAGE_LIMITS_ENABLED", "USAGE_UNMETERED_USER_IDS",
            "AI_NUMERAL_GUARD", "ANTHROPIC_API_KEY")


@pytest.fixture(autouse=True)
def _no_ambient_environment(monkeypatch):
    for name in _AMBIENT:
        monkeypatch.delenv(name, raising=False)


def plain(text: str) -> str:
    """U+00A0 / U+202F read as a space — the corpus states plain spaces."""
    return text.replace("\u00a0", " ").replace("\u202f", " ")


def digits(text: str) -> str:
    return re.sub(r"[^0-9]", "", text)


# ══ E3 — the detector, read out of the frontend's file ════════════════════

_TS = NUMBER_LANGUAGE_TS.read_text(encoding="utf-8")
PATTERN_NAMES = ("ROMANIAN_NUMBER", "ENGLISH_NUMBER", "NOT_PROSE", "ROMANIAN_NUMBER_IN_PROSE",
                 "ENGLISH_NUMBER_IN_PROSE", "CURRENCY_BEFORE_FIGURE")


def _pattern(name: str) -> str:
    """The regex literal `name` of frontend/test/numberLanguage.ts."""
    m = re.search(r"^(?:export )?const %s =\n  /(.+)/;$" % re.escape(name), _TS, re.M)
    assert m, "the pattern %s can no longer be read out of %s" % (name, NUMBER_LANGUAGE_TS.name)
    return m.group(1)


# re.ASCII: a JavaScript regex's \d, \w, \s and \b are ASCII without the
# unicode-sets flag; the patterns name U+00A0 themselves where they mean it.
_NOT_PROSE = re.compile(_pattern("NOT_PROSE"), re.ASCII)
_FOREIGN = {
    "en": re.compile(_pattern("ROMANIAN_NUMBER") + "|" + _pattern("ROMANIAN_NUMBER_IN_PROSE"), re.ASCII),
    "ro": re.compile(_pattern("ENGLISH_NUMBER") + "|" + _pattern("ENGLISH_NUMBER_IN_PROSE"), re.ASCII),
}
_BEFORE = re.compile(_pattern("CURRENCY_BEFORE_FIGURE"), re.ASCII)


def findings(text: str, lang: str, kept: Sequence[Dict[str, str]] = (),
             allowed: Sequence[Dict[str, str]] = ()) -> List[str]:
    """Every figure of `text` in the OTHER language's format, and every
    currency standing before a figure — after what is not prose, what the
    standard leaves by rule (`allowed`) and what was left on purpose
    (`kept`, as WHOLE number tokens) is masked. Empty is the only pass."""
    t = _NOT_PROSE.sub(lambda m: " " * len(m.group(0)), text)
    for a in allowed:
        t = t.replace(a["text"], "#" * len(a["text"]))
    for k in kept:
        t = re.sub(r"(?<![0-9.,])%s(?![0-9]|[.,][0-9])" % re.escape(k["token"]),
                   lambda m: "#" * len(m.group(0)), t)
    return [m.group(0) for m in _FOREIGN[lang].finditer(t)] + [m.group(0) for m in _BEFORE.finditer(t)]


def test_e3_the_detector_is_the_frontends_every_pattern_is_read_out_of_its_file_and_compiles():
    for name in PATTERN_NAMES:
        re.compile(_pattern(name), re.ASCII)
    # POSITIVE CONTROL — the incident's sentence, in shape, and what the
    # reader must see instead (both typed here).
    wrong = ("cu o cifră de afaceri netă de ~EUR 12.3M (convertit din RON 64,567,890 "
             "la cursul BNR 0.1905).")
    right = ("cu o cifră de afaceri netă de ~12,3 mil. EUR (convertit din 64.567.890 RON "
             "la cursul BNR 0,1905).")
    # (each pattern starts at ONE digit, so a hit is the tail of the figure)
    assert findings(wrong, "ro") == ["2.3", "4,567,890", "0.1905", "EUR 1", "RON 6"]
    assert findings(right, "ro") == []
    assert findings(right, "en") == ["2,3", "4.567.890", "0,1905"]
    # The two blind spots of the base patterns, each seen: a short decimal
    # that ends a sentence, a decimal of three or more places.
    assert findings("iar Z este 2.87.", "ro") == ["2.87"]
    assert findings("la cursul 0.1905", "ro") == ["0.1905"]
    # A date, a clock time, a URL and a code span are not prose.
    assert findings("La 31.12.2025, ora 12:30, vezi `RON 4.58M` și https://example.test/a?v=1.5", "ro") == []
    # A lone three-digit group is matched by NOTHING: no detector can call it wrong.
    assert findings("Numerarul este 162,365 RON sau 162.365 RON.", "ro") == []
    assert findings("Numerarul este 162,365 RON sau 162.365 RON.", "en") == []


# ══ E2 — the standard ═════════════════════════════════════════════════════

def test_e2_the_standard_and_the_hint_examples_are_what_lib_money_prints():
    assert F.FIGURE_LANGUAGES == ("ro", "en")
    assert F.STANDARD["codes"] == STANDARD_JSON["codes"] == ["RON", "EUR", "USD"]
    assert F.STANDARD["symbols"] == STANDARD_JSON["symbols"]
    assert F.STANDARD["languages"] == STANDARD_JSON["languages"]
    assert sorted(F.STANDARD) == ["codes", "languages", "symbols"]
    for lang in F.FIGURE_LANGUAGES:
        assert F.HINT_EXAMPLES[lang] == STANDARD_JSON["hint"][lang], lang
    assert sorted(F.HINT_EXAMPLES) == ["en", "ro"]
    # The owner's two shapes, in the standard's own bytes (written out):
    ro = STANDARD_JSON["languages"]["ro"]
    assert (ro["group"], ro["decimal"], ro["magnitudes"]["M"]) == (".", ",", "mil.")
    assert ro["magnitude_joiner"] == ro["code_joiner"] == "\u00a0"
    assert STANDARD_JSON["hint"]["ro"]["whole"] == "1.234.567"
    assert STANDARD_JSON["hint"]["en"]["compact"] == "12.3M"


def test_e2_the_magnitude_words_are_the_engines_own_packs_money_display():
    from engine.ratios.margin_meaning import margin_meaning_pack

    money = margin_meaning_pack().money_display
    for size, key in (("million", "M"), ("thousand", "K")):
        for lang in F.FIGURE_LANGUAGES:
            template = money[size][lang]
            m = re.fullmatch(r"\{value\}(.*?) RON", template)
            assert m, template
            assert m.group(1).strip() == F.STANDARD["languages"][lang]["magnitudes"][key], (size, lang)


# ══ E1 — the twin: the shared corpus and the shared grid ══════════════════

def test_the_corpus_is_what_it_says_it_is():
    """POSITIVE CONTROL of every law below: the corpus is not empty, its
    first case is the incident's sentence in shape, every wrong input IS
    flagged by the detector and every expected string passes it."""
    assert len(CORPUS) >= 110
    assert len(set(c["id"] for c in CORPUS)) == len(CORPUS)
    first = CORPUS[0]
    assert first["id"] == "incident-shape" and first["lang"] == "ro" and first["wrong"] is True
    assert "~EUR 12.3M (convertit din RON 64,567,890 la cursul BNR 0.1905)" in first["input"]
    assert "~12,3 mil. EUR (convertit din 64.567.890 RON la cursul BNR 0,1905)" in first["expected"]
    reasons = set()
    for c in CORPUS:
        assert c["lang"] in ("ro", "en") and c["surface"] in ("chat", "briefing", "both"), c["id"]
        assert c["wrong"] is (c["expected"] != c["input"]), c["id"]
        assert "\u00a0" not in c["expected"] and "\u202f" not in c["expected"], c["id"]
        assert findings(c["expected"], c["lang"], c["kept"], c.get("allowed", ())) == [], c["id"]
        if c["wrong"]:
            assert findings(c["input"], c["lang"]) != [], "not seen as wrong: %s" % c["id"]
        for k in c["kept"]:
            # A token is reported AS THE MODEL WROTE IT (a number between two
            # codes is still rewritten; only the codes stay where they were).
            assert k["reason"] in F.LEFT_REASONS and k["token"] in c["input"], (c["id"], k)
            reasons.add(k["reason"])
    # Every reason a token can be left for is exercised (proof_failed cannot
    # be produced by a text: it is planted below).
    assert reasons == set(F.LEFT_REASONS) - {"proof_failed"}
    assert sum(1 for c in CORPUS if c["wrong"]) >= 75
    assert sum(1 for c in CORPUS if c["lang"] == "en") >= 20
    # No figure of the incident itself: invented figures only.
    blob = json.dumps(CORPUS, ensure_ascii=False)
    for real in ("413,727,560", "413.727.560", "46.547.947", "77.4M", "77,4 mil", "0.1871", "0,1871"):
        assert real not in blob, real


@pytest.mark.parametrize("case", CORPUS, ids=[c["id"] for c in CORPUS])
def test_e1_the_corpus_the_output_is_the_expected_string_and_every_token_left_is_named(case):
    anchors = case.get("anchors") or ()
    out, report = F.normalise_figures(case["input"], case["lang"], anchors)
    WORK["corpus"] += 1
    assert plain(out) == case["expected"]
    left = [{"token": t, "reason": why} for t, why in report["left"]]
    assert left == case["kept"]
    # NO VALUE CHANGES: no digit added, dropped or reordered …
    assert digits(out) == digits(case["input"])
    # … a second pass changes nothing …
    again, _ = F.normalise_figures(out, case["lang"], anchors)
    assert again == out
    # … and a reply already right is not touched by a byte.
    if not case["wrong"]:
        assert out == case["input"]
        assert report["rewritten"] == 0
    else:
        assert report["rewritten"] >= 1
    # The independent detector, on what the reader sees.
    assert findings(out, case["lang"], case["kept"], case.get("allowed", ())) == []


def test_e1_the_grid_every_figure_lib_money_prints_comes_out_as_lib_moneys_print_or_untouched():
    rows = GRID["rows"]
    assert len(rows) == 984
    outcomes = {"rewritten": 0, "single_group": 0}
    for target, written, printed, outcome in rows:
        source = "en" if target == "ro" else "ro"
        text = GRID["frames"][target].replace("{figure}", written)
        out, report = F.normalise_figures(text, target)
        if outcome == "single_group":
            # A lone three-digit group: byte-identical, counted, never guessed.
            assert out == text, text
            assert [why for _t, why in report["left"]] == ["single_group"], text
        else:
            assert outcome == "rewritten"
            # lib/money's own bytes — the U+00A0 joiners included.
            assert out == GRID["frames"][target].replace("{figure}", printed), text
            assert report["left"] == [], text
            assert findings(out, target) == [], out
        assert digits(out) == digits(text)
        assert F.normalise_figures(out, target)[0] == out
        # Read in the WRONG language, the same print loses no digit either —
        # and where the code already stands after the figure, nothing moves.
        native = GRID["frames"][source].replace("{figure}", written)
        nout, _ = F.normalise_figures(native, source)
        assert digits(nout) == digits(native)
        if not re.match(r"^-?[A-Z]{3} ", written):
            assert plain(nout) == plain(native), native
        outcomes[outcome] += 1
    assert outcomes == {"rewritten": 864, "single_group": 120}
    WORK["grid"] = len(rows)


#: A lone three-digit group in every position the spec names — it has two
#: readings (1234 or 1.234), so it comes back byte-identical, currency
#: position included, whatever was handed.
LONE_GROUPS = [
    "{n}", "{n} RON", "RON {n}", "{n}\u00a0RON", "-RON {n}", "RON -{n}", "~EUR {n}", "{n} EUR", "{n}M RON",
    "{n} mil. RON", "{n}%", "{n} %", "{n}x", "{n} zile", "{n} lei", "€{n}", "${n}", "({n} RON)", "**{n} RON**",
]


@pytest.mark.parametrize("number", ["1,234", "1.234", "162,365", "162.365", "999.999", "7.459"])
@pytest.mark.parametrize("lang", ["ro", "en"])
def test_e1_a_lone_three_digit_group_is_never_guessed_with_or_without_handed_figures(number, lang):
    as_groups = float(number.replace(",", "").replace(".", ""))
    as_decimal = as_groups / 1000.0
    frame = "Valoarea este %s acum." if lang == "ro" else "The value is %s today."
    for shape in LONE_GROUPS:
        text = frame % shape.replace("{n}", number)
        for anchors in ((), (as_groups,), (as_decimal,), (as_groups, as_decimal), (as_groups + 0.12,)):
            out, report = F.normalise_figures(text, lang, anchors)
            assert out == text, (text, anchors, out)
            assert ("single_group" in [why for _t, why in report["left"]]), (text, report)


def test_e1_handed_figures_change_nothing_but_bare_decimals_and_bare_groups():
    """A handed figure is EVIDENCE that a value-unique token is a figure —
    it never chooses between two values. Over every corpus case, with every
    number of the text itself handed back (both readings of every token)."""
    changed = 0
    for c in CORPUS:
        text, lang = c["input"], c["lang"]
        tokens = re.findall(r"[0-9][0-9.,]*[0-9]|[0-9]", text)
        handed: List[float] = []
        for t in tokens:
            for value in (t.replace(",", ""), t.replace(".", "").replace(",", "."), re.sub(r"[.,]", "", t)):
                try:
                    handed.append(float(value))
                except ValueError:
                    pass
        bare, bare_report = F.normalise_figures(text, lang)
        out, report = F.normalise_figures(text, lang, handed)
        assert digits(out) == digits(text), c["id"]
        left_bare = [x for x in bare_report["left"]]
        left_handed = [x for x in report["left"]]
        repaired = list(left_bare)
        for x in left_handed:
            assert x in repaired, (c["id"], x)      # nothing NEW is left
            repaired.remove(x)
        for _token, why in repaired:                # what the handed figures proved
            assert why in ("bare_decimal", "bare_groups"), (c["id"], _token, why)
        changed += len(repaired)
        # A lone group, a date, a reference, an outline, a leading zero: untouched by any handed figure.
        for token, why in left_bare:
            if why not in ("bare_decimal", "bare_groups"):
                assert (token, why) in left_handed, (c["id"], token, why)
    assert changed >= 20, "no token was repaired by a handed figure: the law above ran on nothing"


def test_e1_the_run_time_proof_refuses_a_result_whose_digits_differ(monkeypatch):
    """PLANTED HERE, not in the source: a `_swap` that drops a digit. The
    text comes back exactly as it was written, counted proof_failed."""
    text = "EBITDA de RON 7,654,321.50 (marjă 11.85%)."
    good, report = F.normalise_figures(text, "ro")
    assert plain(good) == "EBITDA de 7.654.321,50 RON (marjă 11,85%)." and report["left"] == []
    real = F._swap
    monkeypatch.setattr(F, "_swap", lambda tok, lang: real(tok, lang)[:-1])
    out, report = F.normalise_figures(text, "ro")
    assert out == text
    assert [why for _t, why in report["left"]] == ["proof_failed"] and report["rewritten"] == 0


def test_e1_what_is_not_a_string_or_not_a_language_of_the_standard_comes_back_as_given():
    text = "Umsatz RON 64,567,890 (Marge 11.25%)."
    for lang in OTHER_LANGUAGES + ("xx", "", "RO", None):
        out, report = F.normalise_figures(text, lang)  # type: ignore[arg-type]
        assert out is text and report == {"rewritten": 0, "left": []}, lang
    for value in (None, 42, 1.5, True, ["RON 1,234.50"], {"a": 1}, b"RON 1,234.50", ""):
        out, report = F.normalise_figures(value, "ro")
        assert out is value and report["rewritten"] == 0
    # Handed figures that are not numbers are ignored, never parsed.
    out, _ = F.normalise_figures("Rata este 1.42.", "ro", ["1.42", None, True, float("nan"), float("inf")])
    assert out == "Rata este 1.42."
    assert F.anchors_of({"a": 1.42, "b": [2, "3.5", None, True, {"c": float("nan"), "d": -7.25}]}, None, "9") == [
        1.42, 2.0, -7.25]


# ══ the narrator, with a scripted provider ════════════════════════════════

FX = {"EUR": 1.0, "RON": 5.0, "USD": 1.25}


def _narrate(monkeypatch, reply: Any, lang: Optional[str], *, currency: Optional[str] = None,
             guard: Optional[str] = None) -> Tuple[Dict[str, Any], Any]:
    """The REAL `stage_narrate` over the agras corpus book (the production
    write path's own assembly), the provider answering `reply`."""
    provider = SERVED._install_provider(monkeypatch, reply, guard=guard)
    bk = SB.book("agras")
    doc = dict(bk.doc)
    doc.pop("detected_language", None)
    if lang is not None:
        doc["detected_language"] = lang
    kwargs: Dict[str, Any] = {}
    if currency is not None:
        kwargs = {"display_currency": currency, "fx_rates": dict(FX)}
    out = P.stage_narrate(doc, copy.deepcopy(bk.persist_assembled), [], {"industry_key": "generic"},
                          period_id="p-figures", parsed=bk.parsed, **kwargs)
    WORK["narrations"] += 1
    return out, provider


def _reply(briefing: Any, recommendations: Any = None) -> str:
    return json.dumps({"briefing": briefing,
                       "recommendations": [] if recommendations is None else recommendations},
                      ensure_ascii=False)


#: The corpus cases a briefing can hold whose expected string does not depend
#: on what was handed (the seam hands the book's own facts): no case with
#: its own anchors, none that leaves a bare decimal or bare groups.
SEAM_CASES = [c for c in CORPUS
              if c["surface"] in ("briefing", "both") and "anchors" not in c
              and not any(k["reason"] in ("bare_decimal", "bare_groups") for k in c["kept"])]


def test_the_seam_cases_are_a_real_share_of_the_corpus_in_both_languages():
    assert len(SEAM_CASES) >= 60
    assert sum(1 for c in SEAM_CASES if c["lang"] == "en") >= 12
    assert sum(1 for c in SEAM_CASES if c["wrong"]) >= 45
    assert "briefing-all-wrong-with-units" in [c["id"] for c in SEAM_CASES]


@pytest.mark.parametrize("case", SEAM_CASES, ids=[c["id"] for c in SEAM_CASES])
def test_e4_the_seam_the_real_narrator_returns_every_prose_field_in_the_readers_format(case, monkeypatch):
    text, lang = case["input"], case["lang"]
    recommendation = {
        "severity": "high", "category": "financial", "title": text, "rationale": text,
        "actions": [text, "Fără cifre aici." if lang == "ro" else "No figure here.", 7, None],
        # NOT prose: a number, a numeric string in the OTHER notation, an id.
        "estimated_ron_impact": 1234567.89, "metric_referenced": "RON 1,234.50 (11.25%)",
        "note": "RON 9,876.50",
    }
    out, provider = _narrate(monkeypatch, _reply(text, [recommendation, "not an object", 3]), lang)
    assert len(provider.calls) == 1 and provider.constructed == 1
    assert P.narration_unavailable_code(out) is None and "unavailable" not in out

    rec = out["recommendations"][0]
    prose = [out["briefing"], rec["title"], rec["rationale"], rec["actions"][0]]
    for field in prose:
        assert plain(field) == case["expected"]
        assert digits(field) == digits(text)
        assert findings(field, lang, case["kept"], case.get("allowed", ())) == []
    assert len(set(prose)) == 1   # the same bytes in every prose field
    # What is not prose did not move: the structure, the non-strings, the
    # fields the numeral guard does not walk.
    assert rec["actions"][1:] == recommendation["actions"][1:]
    for key in ("severity", "category", "estimated_ron_impact", "metric_referenced", "note"):
        assert rec[key] == recommendation[key], key
    assert out["recommendations"][1:] == ["not an object", 3]
    assert out["alerts"] == []
    assert sorted(out) == ["alerts", "briefing", "recommendations"]


WRONG_RO = ("Cifra de afaceri este de RON 64,567,890, cu un EBITDA de RON 7,654,321 (marjă 11.85%); "
            "datoria netă/EBITDA este 1.19×, iar zilele de stoc sunt 45.5 zile.")
RIGHT_RO = ("Cifra de afaceri este de 64.567.890 RON, cu un EBITDA de 7.654.321 RON (marjă 11,85%); "
            "datoria netă/EBITDA este 1,19×, iar zilele de stoc sunt 45,5 zile.")
WRONG_RO_EUR = "Cifra de afaceri este de EUR 12.3M, cu un EBITDA de EUR 1,458,148.25 (marjă 11.85%)."
RIGHT_RO_EUR = "Cifra de afaceri este de 12,3 mil. EUR, cu un EBITDA de 1.458.148,25 EUR (marjă 11,85%)."
WRONG_EN = ("Net turnover for the year was 64.567.890 RON (EBITDA margin 11,85%), with the net debt at "
            "1,5 mil. RON and leverage of 1,19x.")
RIGHT_EN = ("Net turnover for the year was 64,567,890 RON (EBITDA margin 11.85%), with the net debt at "
            "1.5M RON and leverage of 1.19x.")
WRONG_EN_EUR = "Turnover is 12,3 mil. EUR, with an EBITDA of EUR 1.458.148,25 (margin 11,85%)."
RIGHT_EN_EUR = "Turnover is 12.3M EUR, with an EBITDA of 1,458,148.25 EUR (margin 11.85%)."


#: (language, display currency, the model's text, what the reader must see,
#: the U+00A0 joiners the pass writes: one before each Romanian magnitude
#: word and one before each code it MOVED — a code the model already wrote
#: after the figure keeps its own space).
SEAM_LANGUAGES = [
    ("ro", None, WRONG_RO, RIGHT_RO, 2), ("ro", "EUR", WRONG_RO_EUR, RIGHT_RO_EUR, 3),
    ("en", None, WRONG_EN, RIGHT_EN, 0), ("en", "EUR", WRONG_EN_EUR, RIGHT_EN_EUR, 1),
    ("RO", None, WRONG_RO, RIGHT_RO, 2), ("ro-RO", None, WRONG_RO, RIGHT_RO, 2),
]


@pytest.mark.parametrize("lang,currency,wrong,right,joiners", SEAM_LANGUAGES,
                         ids=["ro_RON", "ro_EUR", "en_RON", "en_EUR", "RO_uppercase", "ro_RO_locale"])
def test_e4_romanian_and_english_in_the_stored_currency_and_in_a_converted_one(lang, currency, wrong, right,
                                                                              joiners, monkeypatch):
    out, provider = _narrate(monkeypatch, _reply(wrong), lang, currency=currency)
    assert len(provider.calls) == 1
    assert plain(out["briefing"]) == right
    assert findings(out["briefing"], lang.lower()[:2]) == []
    assert findings(wrong, lang.lower()[:2]) != []            # …and the model's text was wrong
    assert out["briefing"].count("\u00a0") == joiners          # the product's own joiner bytes
    assert "unavailable" not in out
    # The model was told the display currency it then cited.
    assert "cite currency as '%s'" % (currency or "RON") in provider.calls[0]["system"]


def test_e4_a_document_with_no_language_is_narrated_in_english_and_normalised_as_english(monkeypatch):
    out, provider = _narrate(monkeypatch, _reply(WRONG_EN), None)
    assert "LANGUAGE: Reply in English." in provider.calls[0]["system"]
    assert plain(out["briefing"]) == RIGHT_EN


def _a_handed_ratio(call: Dict[str, Any]) -> float:
    """A ratio the REAL narrator handed the model for this book: a float
    between 1 and 1000 that, cited to two decimals, is not day.month or
    hour.minute shaped (a two-digit head with a fraction a date could hold)."""
    payload = json.loads(call["messages"][0]["content"])
    found: List[float] = []

    def walk(node: Any) -> None:
        if isinstance(node, bool):
            return
        if isinstance(node, float) and 1.0 <= abs(node) < 1000.0:
            head, fraction = ("%.2f" % abs(node)).split(".")
            if not (len(head) == 2 and int(fraction) <= 59):
                found.append(abs(node))
        elif isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(payload["briefing_facts"])
    walk(payload.get("inventory_days"))
    assert found, "the book hands the model no such ratio: pick another shape"
    return found[0]


def _every_number(node: Any, out: List[float]) -> List[float]:
    if isinstance(node, bool):
        return out
    if isinstance(node, (int, float)):
        out.append(abs(float(node)))
    elif isinstance(node, dict):
        for v in node.values():
            _every_number(v, out)
    elif isinstance(node, list):
        for v in node:
            _every_number(v, out)
    return out


def test_e4_a_ratio_the_model_was_handed_is_proved_a_figure_one_it_was_not_handed_is_left(monkeypatch):
    # Round 1 only reads what the narrator hands the model for this book.
    _out, provider = _narrate(monkeypatch, _reply("Fără cifre."), "ro")
    ratio = _a_handed_ratio(provider.calls[0])
    handed = "%.2f" % ratio                       # the model cites it, English notation, nothing beside it
    # …and a ratio it was NOT handed: equal to no number of the whole payload, rounded or cut.
    payload_numbers = _every_number(json.loads(provider.calls[0]["messages"][0]["content"]), [])
    taken = set("%.2f" % n for n in payload_numbers) | set("%d.%02d" % divmod(int(n * 100), 100)
                                                           for n in payload_numbers if n < 1e9)
    other = next("%.2f" % (ratio + step / 100.0) for step in range(137, 700, 23)
                 if "%.2f" % (ratio + step / 100.0) not in taken)
    assert handed in taken and other not in taken and handed != other
    sentence = "Indicatorul este %s, iar un altul este %s, fără alte repere."
    out, _ = _narrate(monkeypatch, _reply(sentence % (handed, other)), "ro")
    assert out["briefing"] == sentence % (handed.replace(".", ","), other)
    assert digits(out["briefing"]) == digits(sentence % (handed, other))


# ══ E5 — stored = answered = served ═══════════════════════════════════════

def _record_narrator(monkeypatch) -> List[Dict[str, Any]]:
    """The REAL stage_narrate, with what it returned recorded."""
    returned: List[Dict[str, Any]] = []
    real = P.stage_narrate

    def recorded(*a: Any, **kw: Any) -> Dict[str, Any]:
        out = real(*a, **kw)
        returned.append(copy.deepcopy(out))
        return out

    monkeypatch.setattr(P, "stage_narrate", recorded)
    return returned


def test_e5_the_regenerate_route_stores_answers_and_serves_what_the_narrator_returned(monkeypatch):
    double = SERVED._world(briefing=SERVED._usable_row())
    provider = SERVED._install_provider(monkeypatch, _reply(WRONG_RO))
    meter = SERVED._meter_on(monkeypatch)
    returned = _record_narrator(monkeypatch)

    resp = SERVED._regenerate(double, {"intent": "user", "language": "ro", "currency": "RON"})
    assert resp.status_code == 200, resp.text[:400]
    answer = resp.json()
    assert (answer["ok"], answer["regenerated"], answer["persisted"]) == (True, True, True)
    assert len(provider.calls) == 1 and len(returned) == 1
    WORK["narrations"] += 1

    body = returned[0]["briefing"]
    assert plain(body) == RIGHT_RO and findings(body, "ro") == []
    assert answer["briefing"] == body                       # ANSWERED
    assert answer["briefing_length"] == len(body)
    rows = SERVED._briefing_rows(double)
    assert len(rows) == 1 and rows[0]["body"] == body        # STORED
    assert rows[0]["language"] == "ro"
    served = SERVED._served(double)
    assert served["body"] == body                            # SERVED
    assert served["unavailable"] is False and served["stale"] is None
    # ONE unit, committed once, on the verified caller's meter.
    assert [name for name, _payload in meter] == ["reserve_user_chat", "commit_user_chat"], meter


def test_e5_a_converted_regenerate_is_answered_normalised_and_never_stored(monkeypatch):
    double = SERVED._world(briefing=SERVED._usable_row())
    provider = SERVED._install_provider(monkeypatch, _reply(WRONG_RO_EUR))
    from engine.api import fx_rates as _fx

    monkeypatch.setattr(_fx, "get_fx_rates", lambda *_a, **_k: copy.deepcopy(ROUTE.FX_PAYLOAD))
    returned = _record_narrator(monkeypatch)
    before = SERVED._store(double)

    resp = SERVED._regenerate(double, {"intent": "user", "language": "ro", "currency": "EUR"})
    assert resp.status_code == 200, resp.text[:400]
    answer = resp.json()
    assert (answer["ok"], answer["regenerated"], answer["persisted"]) == (True, True, False)
    assert len(provider.calls) == 1
    WORK["narrations"] += 1
    assert answer["briefing"] == returned[0]["briefing"]
    assert plain(answer["briefing"]) == RIGHT_RO_EUR and findings(answer["briefing"], "ro") == []
    assert "cite currency as 'EUR'" in provider.calls[0]["system"]
    # The stored RON briefing is byte-identical: nothing was written.
    assert SERVED._store(double) == before


def test_e5_the_pipelines_own_writer_stores_what_the_narrator_returned(monkeypatch):
    double = SERVED._world()
    recommendation = {"severity": "high", "category": "financial", "title": "Reduceți datoria netă sub 2.5× EBITDA",
                      "rationale": "Un tampon de RON 3,505,910.20 acoperă 5.4% din datoriile curente.",
                      "actions": ["Reduceți DSO de la 61.4 la 48.0 zile."], "estimated_ron_impact": 3505910.2}
    narrated, provider = _narrate(monkeypatch, _reply(WRONG_RO, [recommendation]), "ro")
    assert len(provider.calls) == 1
    with RA.installed(double):
        P.stage_persist_narrative(dict(SERVED.DOC, detected_language="ro"), SERVED.PID, narrated, [])
    rows = SERVED._briefing_rows(double)
    assert len(rows) == 1 and rows[0]["body"] == narrated["briefing"]
    assert plain(rows[0]["body"]) == RIGHT_RO
    assert SERVED._served(double)["body"] == narrated["briefing"]
    stored = double.tables.get("recommendations", [])
    assert len(stored) == 1
    assert plain(stored[0]["title"]) == "Reduceți datoria netă sub 2,5× EBITDA"
    assert plain(stored[0]["explanation"]) == (
        "Un tampon de 3.505.910,20 RON acoperă 5,4% din datoriile curente."
        "\n\nActions:\n• Reduceți DSO de la 61,4 la 48,0 zile.")
    for field in (stored[0]["title"], stored[0]["explanation"]):
        assert findings(field, "ro") == []
    # The cash impact is a NUMBER and stays the number the model gave.
    assert 3505910.2 in [v for v in stored[0].values() if isinstance(v, float)]


# ══ E6 — every other language is not touched ══════════════════════════════

#: The LANGUAGE line of the system prompt as main's `stage_narrate` builds
#: it, per language — written out, not read from the function under test.
MAIN_LANGUAGE_LINE = {
    "de": ("Antworten Sie auf Deutsch.", "1.234.567"),
    "fr": ("Répondez en français.", "1 234 567"),
    "es": ("Responde en español.", "1.234.567"),
    "it": ("Rispondi in italiano.", "1.234.567"),
    "pt": ("Responda em português.", "1.234.567"),
    "nl": ("Antwoord in het Nederlands.", "1.234.567"),
    "pl": ("Odpowiedz po polsku.", "1.234.567"),
}
#: A reply whose figures are in English notation with the code first — what
#: the pass would rewrite if it ran.
FOREIGN_TEXT = "Umsatz RON 64,567,890, EBITDA ~EUR 12.3M (Marge 11.25%), Verschuldung 1.19x, 45.5 Tage."


def _language_line(system: str) -> str:
    lines = [l for l in system.split("\n") if l.startswith("LANGUAGE: ")]
    assert len(lines) == 1, lines
    return lines[0]


@pytest.mark.parametrize("lang", OTHER_LANGUAGES)
@pytest.mark.parametrize("currency", [None, "EUR"], ids=["RON", "EUR"])
def test_e6_a_narration_in_another_language_and_its_hint_are_byte_for_byte_what_they_were(lang, currency,
                                                                                         monkeypatch):
    recommendation = {"title": FOREIGN_TEXT, "rationale": FOREIGN_TEXT, "actions": [FOREIGN_TEXT]}
    out, provider = _narrate(monkeypatch, _reply(FOREIGN_TEXT, [recommendation]), lang, currency=currency)
    assert out == {"briefing": FOREIGN_TEXT, "recommendations": [recommendation], "alerts": []}
    code = currency or "RON"
    instruction, example = MAIN_LANGUAGE_LINE[lang]
    assert _language_line(provider.calls[0]["system"]) == (
        "LANGUAGE: %s Numbers in %s locale; cite currency as '%s' (e.g. '%s %s'). Every monetary figure in "
        "`briefing_facts` is pre-converted to %s — do NOT re-convert."
        % (instruction, lang.upper(), code, example, code, code))


@pytest.mark.parametrize("lang", ["xx", "zh", "r", "12"])
def test_e6_a_language_code_the_narrator_has_no_instruction_for_is_not_normalised(lang, monkeypatch):
    """`narration_language()` would read these as English; the narrator's own
    `output_language` does not, and that is the one the pass follows."""
    out, provider = _narrate(monkeypatch, _reply(WRONG_EN), lang)
    assert out["briefing"] == WRONG_EN
    assert _language_line(provider.calls[0]["system"]) == (
        "LANGUAGE: Reply in English. Numbers in %s locale; cite currency as 'RON' (e.g. '1.234.567 RON'). "
        "Every monetary figure in `briefing_facts` is pre-converted to RON — do NOT re-convert."
        % lang.upper()[:2])


def test_e6_the_nine_narration_languages_are_the_two_of_the_standard_and_the_seven_left_alone():
    assert tuple(P.NARRATION_LANGUAGES) == ALL_LANGUAGES
    assert set(ALL_LANGUAGES) - set(F.FIGURE_LANGUAGES) == set(OTHER_LANGUAGES) == set(MAIN_LANGUAGE_LINE)


# ══ E7 — the pass never breaks a narration ════════════════════════════════

def test_e7_a_pass_that_raises_leaves_the_models_text_usable_and_stored(monkeypatch, caplog):
    def boom(*_a: Any, **_k: Any) -> Any:
        raise RuntimeError("planted: the formatter failed")

    monkeypatch.setattr(F, "normalise_narrate_result", boom)
    double = SERVED._world(briefing=SERVED._usable_row())
    provider = SERVED._install_provider(monkeypatch, _reply(WRONG_RO))
    with caplog.at_level("ERROR", logger=P.logger.name):
        resp = SERVED._regenerate(double, {"intent": "user", "language": "ro", "currency": "RON"})
    assert resp.status_code == 200, resp.text[:400]
    answer = resp.json()
    assert (answer["ok"], answer["persisted"]) == (True, True)
    assert len(provider.calls) == 1
    WORK["narrations"] += 1
    assert answer["briefing"] == WRONG_RO                          # as the model wrote it
    assert SERVED._briefing_rows(double)[0]["body"] == WRONG_RO
    assert "narration figure format failed" in caplog.text        # one logged exception, no token in it
    assert "64,567,890" not in "".join(r.getMessage() for r in caplog.records)


def test_e7_a_module_that_cannot_be_imported_leaves_the_narration_and_the_old_hint(monkeypatch):
    import engine.ai as ai_package

    monkeypatch.delattr(ai_package, "figure_format")
    monkeypatch.setitem(sys.modules, "engine.ai.figure_format", None)
    out, provider = _narrate(monkeypatch, _reply(WRONG_RO), "ro")
    assert out == {"briefing": WRONG_RO, "recommendations": [], "alerts": []}
    assert _language_line(provider.calls[0]["system"]) == (
        "LANGUAGE: Răspunde în limba română. Numbers in RO locale; cite currency as 'RON' "
        "(e.g. '1.234.567 RON'). Every monetary figure in `briefing_facts` is pre-converted to RON "
        "— do NOT re-convert.")


def test_e7_whatever_shape_the_model_returned_the_walker_returns_it_and_never_raises():
    odd = [None, 3, "text", [], ["a"], {}, {"briefing": None}, {"briefing": 42, "recommendations": "x"},
           {"briefing": WRONG_RO, "recommendations": [None, 1, "s", {}, {"title": None, "rationale": 5,
                                                                         "actions": "RON 1,234.50"},
                                                      {"actions": [None, 2, {"x": 1}, WRONG_RO]}]}]
    for payload in odd:
        before = copy.deepcopy(payload)
        out, report = F.normalise_narrate_result(payload, "ro")
        assert payload == before                      # the input is never mutated
        assert sorted(report) == ["fields_changed", "fields_checked", "left", "left_by_reason", "rewritten"]
    out, report = F.normalise_narrate_result(odd[-1], "ro")
    assert plain(out["briefing"]) == RIGHT_RO
    assert out["recommendations"][:4] == [None, 1, "s", {}]
    assert out["recommendations"][4] == {"title": None, "rationale": 5, "actions": "RON 1,234.50"}
    assert out["recommendations"][5]["actions"][:3] == [None, 2, {"x": 1}]
    assert plain(out["recommendations"][5]["actions"][3]) == RIGHT_RO
    assert report["fields_checked"] == 2 and report["fields_changed"] == 2 and report["rewritten"] == 10
    # The report that is LOGGED holds counts by reason — never a token.
    _o, r = F.normalise_narrate_result({"briefing": "Numerar RON 162,365 și rata 1.42."}, "ro")
    assert r["left"] == 2 and r["left_by_reason"] == {"bare_decimal": 1, "single_group": 1}
    assert "162" not in json.dumps(r)


# ══ E8 — the hint ═════════════════════════════════════════════════════════

RO_RON_LINE = ("LANGUAGE: Răspunde în limba română. Numbers in RO locale; cite currency as 'RON' AFTER the "
               "figure — never before it, never a symbol, never 'lei' (e.g. '1.234.567 RON', "
               "'1.234.567,89 RON', '12,3 mil. RON'); percentages, multiples and other ratios in the same "
               "locale (e.g. '11,25%', '1,19×'). Every monetary figure in `briefing_facts` is "
               "pre-converted to RON — do NOT re-convert.")
EN_EUR_LINE = ("LANGUAGE: Reply in English. Numbers in EN locale; cite currency as 'EUR' AFTER the "
               "figure — never before it, never a symbol, never 'lei' (e.g. '1,234,567 EUR', "
               "'1,234,567.89 EUR', '12.3M EUR'); percentages, multiples and other ratios in the same "
               "locale (e.g. '11.25%', '1.19×'). Every monetary figure in `briefing_facts` is "
               "pre-converted to EUR — do NOT re-convert.")


@pytest.mark.parametrize("lang", ["ro", "en"])
@pytest.mark.parametrize("currency", [None, "EUR"], ids=["RON", "EUR"])
def test_e8_the_hint_carries_the_products_own_example_strings_with_the_code_after_the_figure(lang, currency,
                                                                                          monkeypatch):
    _out, provider = _narrate(monkeypatch, _reply("Fără cifre." if lang == "ro" else "No figures."), lang,
                              currency=currency)
    code = currency or "RON"
    line = _language_line(provider.calls[0]["system"])
    examples = STANDARD_JSON["hint"][lang]                 # what lib/money prints
    for key in ("whole", "decimals", "compact"):
        assert "'%s %s'" % (examples[key], code) in line, key
    for key in ("percent", "multiple"):
        assert "'%s'" % examples[key] in line, key
    assert "cite currency as '%s'" % code in line          # the route gate's phrase
    assert "pre-converted to %s" % code in line
    # Read by the detector: no figure of the other language, no code before a figure.
    assert findings(line, lang) == []
    assert len(findings(line, "en" if lang == "ro" else "ro")) >= 4      # …and it does read the line
    assert "(e.g. '1.234.567 %s')." % code not in line     # the one-example hint is gone for ro / en
    if (lang, code) == ("ro", "RON"):
        assert line == RO_RON_LINE
    if (lang, code) == ("en", "EUR"):
        assert line == EN_EUR_LINE


def test_e8_the_hint_function_names_no_language_it_has_no_standard_for():
    assert F.currency_hint("ro", "RON") == RO_RON_LINE[len("LANGUAGE: Răspunde în limba română. "):]
    for lang in OTHER_LANGUAGES + ("xx", "", "RO"):
        assert F.currency_hint(lang, "RON") is None, lang
    assert F.currency_hint("ro", "") is None and F.currency_hint("ro", None) is None  # type: ignore[arg-type]


# ══ E9 — failures, and the numeral guard ══════════════════════════════════

def _count_the_pass(monkeypatch) -> List[str]:
    calls: List[str] = []
    real = F.normalise_narrate_result

    def counted(payload: Any, lang: str, anchors: Any = ()) -> Any:
        calls.append(lang)
        return real(payload, lang, anchors)

    monkeypatch.setattr(F, "normalise_narrate_result", counted)
    return calls


@pytest.mark.parametrize("branch", sorted(SERVED.BRANCHES))
def test_e9_a_failed_narration_is_returned_as_it_was_and_the_pass_is_never_run_on_it(branch, monkeypatch):
    kwargs, code, text = SERVED.BRANCHES[branch]
    calls = _count_the_pass(monkeypatch)
    SERVED._install_provider(monkeypatch, **kwargs)
    bk = SB.book("agras")
    out = P.stage_narrate(dict(bk.doc, detected_language="ro"), copy.deepcopy(bk.persist_assembled), [],
                          {"industry_key": "generic"}, period_id="p-figures", parsed=bk.parsed)
    assert out.get("unavailable") == code and out["briefing"] == text and out["recommendations"] == []
    assert calls == []


def test_e9_a_reply_fragment_holding_wrong_format_figures_is_not_rewritten(monkeypatch):
    """The not-JSON branch hands on the head of the reply as its text: it is
    a failure, and a failure is not touched — figures or not."""
    fragment = "Cifra de afaceri este de RON 64,567,890 (marjă 11.85%)"
    calls = _count_the_pass(monkeypatch)
    out, _ = _narrate(monkeypatch, fragment, "ro")
    assert out["unavailable"] == "unparseable_reply" and out["briefing"] == fragment
    assert calls == []


@pytest.mark.parametrize("guard", [None, "observe", "off"])
def test_e9_the_numeral_guard_off_or_observing_the_narration_is_normalised_the_same(guard, monkeypatch):
    calls = _count_the_pass(monkeypatch)
    out, _ = _narrate(monkeypatch, _reply(WRONG_RO), "ro", guard=guard)
    assert plain(out["briefing"]) == RIGHT_RO and "unavailable" not in out
    assert calls == ["ro"]


def test_e9_the_numeral_guard_enforcing_withholds_as_before_and_the_pass_does_not_run(monkeypatch):
    calls = _count_the_pass(monkeypatch)
    out, _ = _narrate(monkeypatch, _reply(WRONG_RO), "ro", guard="enforce")
    assert out["unavailable"] == "withheld_numerals"
    assert out["briefing"] == SERVED.WITHHELD_SENTENCE
    assert calls == []


def test_e9_the_pass_stands_after_the_numeral_guard_and_is_the_last_thing_before_the_return():
    """Source census: one call of the pass in the pipeline, inside
    `stage_narrate`, after the guard, guarded by the failure code."""
    src = (REPO / "src" / "engine" / "api" / "pipeline.py").read_text(encoding="utf-8")
    assert src.count("normalise_narrate_result(") == 1
    # Two function-local imports (the hint, the pass) — none at module level.
    assert re.findall(r"^( *)from engine\.ai import figure_format as (\w+)$", src, re.M) == [
        (" " * 12, "_figure_format"), (" " * 12, "_figures")]
    start = src.index("\ndef stage_narrate(")
    end = src.index("\ndef ", start + 1)
    body = src[start:end]
    guard_at = body.index("_numerals.guard_narrate_result(")
    pass_at = body.index("_figures.normalise_narrate_result(")
    assert guard_at < pass_at
    assert 'if output_language in ("ro", "en") and not narrated.get("unavailable"):' in body[guard_at:pass_at]
    tail = body[pass_at:]
    assert tail.rstrip().endswith("return narrated")
    assert tail.count("return ") == 1
    # The log line names counts, never a token of the text.
    assert '"[pipeline] narration figures (%s): %d rewritten, left %s — doc=%s"' in tail
    # The module itself: stdlib only, no printer, no model.
    module = (REPO / "src" / "engine" / "ai" / "figure_format.py").read_text(encoding="utf-8")
    tree = ast.parse(module)
    imports = sorted(set(
        (node.module if isinstance(node, ast.ImportFrom) else alias.name)
        for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))
        for alias in node.names))
    assert imports == ["__future__", "math", "re", "typing", "unicodedata"], imports
    # Every string the module holds that is not a docstring: no model, no
    # locale machinery — and no `\\d` / `\\w` (the twin's regexes are ASCII:
    # Python's `\\d` is every Unicode digit, the browser's is 0-9).
    docstrings = set(
        id(node.body[0].value) for node in ast.walk(tree)
        if isinstance(node, (ast.Module, ast.FunctionDef)) and node.body
        and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant))
    strings = [node.value for node in ast.walk(tree)
               if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings]
    assert len(strings) > 150
    for text in strings:
        for forbidden in ("anthropic", "openai", "\\d", "\\w", "\\b"):
            assert forbidden not in text, (forbidden, text)
    names = set(node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)) | set(
        node.id for node in ast.walk(tree) if isinstance(node, ast.Name))
    assert not names & {"format", "locale", "Decimal", "round", "strftime", "format_map"}, names


# ══ E10 — no spend ════════════════════════════════════════════════════════

def test_e10_no_socket_was_attempted_and_the_model_was_only_ever_the_stand_in():
    netblock = sys.modules.get("netblock")
    if netblock is None:
        pytest.skip("run this gate with `-p netblock`: python -m pytest -p netblock tests/engine/test_ai_figure_format.py")
    assert netblock.ATTEMPTS == [], netblock.ATTEMPTS
    real = sys.modules.get("anthropic")
    assert real is None or isinstance(real, types.SimpleNamespace) or not getattr(real, "__file__", None), (
        "the real anthropic SDK was imported by this run")
    assert WORK["corpus"] == len(CORPUS) and WORK["grid"] == 984 and WORK["narrations"] >= 100, WORK
    print("\nGATE-WORK ai-figures-engine corpus=%d grid=%d narrations=%d languages=%d"
          % (WORK["corpus"], WORK["grid"], WORK["narrations"], len(ALL_LANGUAGES)))
