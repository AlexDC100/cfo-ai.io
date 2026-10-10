"""GATE ai-figures-engine — A BRIEFING'S FIGURES ARE WRITTEN IN THE READER'S
FORMAT, AND NO VALUE CHANGES ON THE WAY.

OWNER ORDER (2026-10-04, verbatim): "Add to the next release: make chat and
briefings write numbers in Romanian format in Romanian text (413.727.560
RON, ~77,4 mil. EUR), currency after the figure. Use the product's own
formatting standard, with a gate."

WHAT WAS TRUE BEFORE. A briefing is prose a model wrote, stored as written.
One prompt hint asked for the format ("Numbers in RO locale; cite currency
as 'RON' (e.g. '1.234.567 RON')") and nothing HELD it: the day the model
writes "~EUR 12.3M (marjă 8.75%)" in a Romanian sentence — the shape the
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
  E11 WHAT A FIGURE IS BOUND TO (review 2026-10-05: the gate compared digits
      and nothing else, so a code moved onto the wrong number passed — and
      with such an output typed in as `expected`, every law stayed green).
      An INDEPENDENT reader (tests/engine/_figure_reader.py — none of the
      normaliser's tables) reads every figure's amount (value x magnitude),
      currency, sign and unit before and after: over the corpus's own
      `expected` strings, over the grid, and over a GRAMMAR of code-first
      amounts (heads x numbers x magnitudes x what follows: a range, a list,
      a number that goes on, a magnitude the standard does not print,
      another currency, a date). Nothing may differ.
  E12 NEVER HALF A TEXT. A text holding a lone three-digit group is
      returned whole, byte for byte, counted `text_held` — rewriting the
      figures around it would leave the one token with two readings alone in
      the other notation.
  E13 THE COMPOSED SET (fixtures/ai_figures/compose.json, 12,000 texts
      composed from parts by integer arithmetic): no digit moves, a second
      pass changes nothing, no text is half rewritten — and the sha256 of
      every output equals the fixture's `digest`, which the browser's twin
      must reproduce too (a rule changed on one runtime moves one digest).
  E14 THE RUN-TIME PROOF BEYOND DIGITS. With a rule made to read "Bn" as a
      million, to drop a sign, or to move a code inside a number, the text
      comes back exactly as written, counted proof_failed.

  E15 WHAT IS NOT A FIGURE, BESIDE ONE (review 2026-10-05, round 2: "Contul
      5121.01 – 1.234.567,89 RON" came back "Contul 5121,01 – …", "Sold la
      31.12 – 5,2 mil. RON" as "31,12", in one pass or in the second — with
      both gates green: no fixture held an id before a spaced dash, and the
      reader reads amounts, not whether a token is one). THE LABEL GRAMMAR
      (fixtures/ai_figures/labels.json — an account word, a date word, a
      reference word, a list marker, a plain noun, a period word x an id that
      is not an amount x a separator x an amount in either notation, 29,263
      texts): the id's bytes survive, a second pass changes nothing, the
      independent reader sees no figure bound to anything else, and the
      sha256 of every output is the fixture's `digest` in BOTH runtimes.
  E16 THE READER OVER THE COMPOSED SET. The independent reader is run over
      all 12,000 composed outputs: what it flags is EXACTLY the set written
      out below, each read by hand (glued garbage, a code inside a span the
      pass never enters). One more flag is a red.
  E17 ONE RECOMMENDATION IS ONE TEXT. The writer stores a recommendation's
      rationale and actions as one explanation under its title: a lone group
      in any field and a reshaped figure in any other return EVERY field as
      the model wrote it — read off the stored row, not off the walker.
  E18 A CODE THAT ONLY CHANGES SIDES HOLDS NOTHING. Beside a lone group, a
      text whose numbers are already in its own notation still gets its
      codes moved: no number token changes by a byte, so the lone group reads
      as it did.
  E19 NEVER SLOW. A 20 KB unbroken run (word characters, "1.5%1.5%…",
      "1.5-1.5-…", bare decimals on one line, "](a](a…", with and without an
      "@") is formatted inside a time limit: the pass runs inside the request.

REDS ON, with the repair in place (TC-11): an account, a date, a note number
or a year re-spelt or given a currency because a figure follows it; a second
pass that changes what the first returned; a code moved before a hedged range
("între EUR 1.5 și aproximativ 2.5M"), inside a number grouped with any
in-line space, off a year-shaped amount onto a count, or onto a bare integer;
one bound of an opener's range rewritten and the other left; a "$" named USD
behind emphasis or a colon; a tenor after a code re-spelt as a million; a
recommendation stored half rewritten; a text held although only codes would
move; a 20 KB run that stalls the worker; a code moved onto another number
(before a range, a list, a spaced or apostrophe-grouped number, an unread
magnitude, a second currency; a code between two numbers taken by the first);
a "$" named USD where the reply names another dollar; a bare run of groups
re-printed as one number; a text half rewritten around a lone group; a
magnitude, a sign or a ratio mark changed; an `expected` string of the corpus
that binds a figure differently from its input; a rule of the normaliser
changed on one runtime only (the corpus / grid / digest differ); a value
guessed (a lone
group rewritten, with or without a handed figure); a digit dropped; the
run-time proof removed; STANDARD or the hint's examples retyped away from
what lib/money prints; the pass removed from `stage_narrate`, moved before
the numeral guard's verdict, run on a failure result, or extended to a
field that is not prose; a writer or the route storing something other than
what the narrator returned; another language's narration or hint changing
by a byte; an exception of the pass reaching a caller.

CANNOT SEE: a NON-FIGURE the pass re-spells because a currency or a unit
stands RIGHT beside it and no account word before it ("Versiunea 2.1 RON",
"Pe 5.11 lei") — the independent reader reads the same value before and
after, no reader can know a version from an amount, and the label grammar
puts a separator between the id and the amount; a label id of the shape
NNN.NNN outside an account word (it is a lone group to every reader, and
holds the text); a text HELD as written (it is counted, and it still holds the
model's notation: the detector is not run on it); a code left before its
figure on purpose (counted `code_before` / `open_amount`); what a model
WRITES (the provider is a script); rows stored
before this release (no stored row is rewritten — the browser's card repairs
what it shows); a narration the model wrote in ANOTHER language than it was
asked for (it is normalised in the asked language — notation only, never a
value); a token left by design — a lone three-digit group ("258,419 RON" in
Romanian text) passes every law and the detector; the non-statement (SKU / invoice register) prompt's own wording
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

import _figure_compose as COMPOSE
import _figure_reader as READER
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

COMPOSE_SPEC: Dict[str, Any] = json.loads(COMPOSE.FIXTURE.read_text(encoding="utf-8"))
LABEL_SPEC: Dict[str, Any] = json.loads(COMPOSE.LABELS.read_text(encoding="utf-8"))

#: What this gate did, for the battery's canary (printed by the last test).
WORK = {"corpus": 0, "grid": 0, "narrations": 0, "grammar": 0, "composed": 0, "labels": 0, "mixed": 0}

_NUMBER = re.compile(r"[0-9][0-9.,]*[0-9]|[0-9]")
_MAGNITUDE = re.compile(r"[0-9](?:[ \u00a0\u202f]?(?:mil\.|mld\.|mii)|Bn|bn|[KMBk])(?![A-Za-z0-9])")


def numbers_as_written(text: str) -> List[str]:
    """Every number token and every magnitude of `text`, byte for byte, in order."""
    return _NUMBER.findall(text) + [m.group(0)[1:].strip(" \u00a0\u202f") for m in _MAGNITUDE.finditer(text)]


#: Corpus outputs that hold both notations after the pass (measured; the list
#: only shrinks: a rule that produces one more half-converted output reds).
MIXED_OUTPUTS_AT_MOST = 45


def held(case: Dict[str, Any]) -> bool:
    """The case is a text returned whole because it holds a lone group."""
    return any(k["reason"] == "text_held" for k in case["kept"])

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
    assert findings("Numerarul este 258,419 RON sau 258.419 RON.", "ro") == []
    assert findings("Numerarul este 258,419 RON sau 258.419 RON.", "en") == []


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
    assert len(CORPUS) >= 190
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
        if held(c):
            # A text returned whole: it IS what the model wrote — and the
            # detector says so (the hold is counted, never a silent pass).
            assert c["expected"] == c["input"] and c["kept"][-1] == {"token": "", "reason": "text_held"}, c["id"]
            assert any(k["reason"] == "single_group" for k in c["kept"]), c["id"]
            assert findings(c["input"], c["lang"]) != [], c["id"]
        else:
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
    assert sum(1 for c in CORPUS if c["wrong"]) >= 95
    assert sum(1 for c in CORPUS if c["lang"] == "en") >= 26
    # The shapes the review of 2026-10-05 found the corpus without — each is
    # in it now, by the reason the normaliser must give.
    counted = {why: sum(1 for c in CORPUS for k in c["kept"] if k["reason"] == why)
               for why in ("open_amount", "code_before", "text_held", "bare_groups")}
    assert counted["open_amount"] >= 25 and counted["code_before"] >= 10, counted
    assert counted["text_held"] >= 4 and counted["bare_groups"] >= 5, counted
    # The shapes the review of round 2 found it without: a label id before a
    # spaced dash, a hedged range, an in-line space the product does not write,
    # a year-shaped amount before a count, a bare integer beside a code.
    for needle, why in ((" \u2013 ", "reference"), (" - ", "possible_date"), ("circa", "open_amount"),
                        ("\u2009", "open_amount"), ("\u2007", "open_amount"), ("2000 RON 100", "open_amount"),
                        ("EUR 3 scenarii", "code_before"), ("**CAD** $", "code_before"), ("EUR 3M", "tenor")):
        assert any(needle in c["input"] and any(k["reason"] == why for k in c["kept"]) for c in CORPUS), needle


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
    # The independent detector, on what the reader sees (a text HELD whole is
    # the model's own, counted: there is nothing of ours to read in it).
    if not held(case):
        assert findings(out, case["lang"], case["kept"], case.get("allowed", ())) == []
    # NEVER HALF A TEXT: where a number was RESHAPED, no lone group is left —
    # beside one, at most a code changed sides (E18): every number token and
    # every magnitude is byte for byte what the model wrote.
    reasons = [why for _t, why in report["left"]]
    if "single_group" in reasons:
        assert numbers_as_written(out) == numbers_as_written(case["input"]), case["id"]
    assert ("text_held" in reasons) is held(case)
    # (counted for the canary: an output that still holds BOTH notations — a
    # token left on purpose beside rewritten ones)
    WORK["mixed"] += bool(out != case["input"] and findings(out, case["lang"]) != [])
    # WHAT EVERY FIGURE IS BOUND TO — read by the independent reader, on the
    # output and on the hand-typed string alike.
    assert READER.changed_amounts(case["input"], out, case["lang"]) == []
    assert READER.changed_amounts(case["input"], case["expected"], case["lang"]) == []


def test_e1_the_grid_every_figure_lib_money_prints_comes_out_as_lib_moneys_print_or_untouched():
    rows = GRID["rows"]
    assert len(rows) == 984
    outcomes = {"rewritten": 0, "single_group": 0, "code_before": 0}
    for target, written, printed, outcome in rows:
        source = "en" if target == "ro" else "ro"
        text = GRID["frames"][target].replace("{figure}", written)
        out, report = F.normalise_figures(text, target)
        if outcome == "single_group":
            # A lone three-digit group: byte-identical, counted, never guessed.
            assert out == text, text
            assert [why for _t, why in report["left"]] == ["single_group"], text
        elif outcome == "code_before":
            # A bare integer beside a code is not known to be an amount ("cont
            # RON 5121", "În EUR 3 scenarii"): byte-identical, counted.
            assert re.fullmatch(r"-?[A-Z]{3} [0-9]+", written), written
            assert out == text, text
            assert report["left"] == [(written.lstrip("-"), "code_before")], text
        else:
            assert outcome == "rewritten"
            # lib/money's own bytes — the U+00A0 joiners included.
            assert out == GRID["frames"][target].replace("{figure}", printed), text
            assert report["left"] == [], text
            assert findings(out, target) == [], out
        assert digits(out) == digits(text)
        assert READER.changed_amounts(text, out, target) == [], text
        assert F.normalise_figures(out, target)[0] == out
        # Read in the WRONG language, the same print loses no digit either —
        # and where the code already stands after the figure, nothing moves.
        native = GRID["frames"][source].replace("{figure}", written)
        nout, _ = F.normalise_figures(native, source)
        assert digits(nout) == digits(native)
        if not re.match(r"^-?[A-Z]{3} ", written):
            assert plain(nout) == plain(native), native
        outcomes[outcome] += 1
    assert outcomes == {"rewritten": 828, "single_group": 120, "code_before": 36}
    WORK["grid"] = len(rows)


#: A lone three-digit group in every position the spec names — it has two
#: readings (1234 or 1.234), so it comes back byte-identical, currency
#: position included, whatever was handed.
LONE_GROUPS = [
    "{n}", "{n} RON", "RON {n}", "{n}\u00a0RON", "-RON {n}", "RON -{n}", "~EUR {n}", "{n} EUR", "{n}M RON",
    "{n} mil. RON", "{n}%", "{n} %", "{n}x", "{n} zile", "{n} lei", "€{n}", "${n}", "({n} RON)", "**{n} RON**",
]


@pytest.mark.parametrize("number", ["1,234", "1.234", "258,419", "258.419", "999.999", "7.459"])
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
        assert READER.changed_amounts(text, out, lang) == [], c["id"]
        left_bare = [x for x in bare_report["left"]]
        left_handed = [x for x in report["left"]]
        if ("", "text_held") in left_handed:
            # The handed figure proved a token beside a lone group: nothing
            # may then be rewritten at all — the text is returned whole.
            assert out == text, c["id"]
            left_handed.remove(("", "text_held"))
            if ("", "text_held") in left_bare:
                left_bare.remove(("", "text_held"))
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
    text = "Umsatz RON 64,567,890 (Marge 8.75%)."
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


# ══ E11 — what a figure is bound to ═══════════════════════════════════════

#: Outputs the normaliser PRODUCED before the review of 2026-10-05, each a
#: figure bound to something else than the model wrote (typed here from the
#: review's transcripts; figures invented). The independent reader must see
#: every one — it is the law's positive control.
MISBOUND = [
    ("ro", "este între EUR 40 și 55 milioane, în", "este între 40 EUR și 55 milioane, în"),
    ("ro", "a fost de $10–12M în ultimii", "a fost de 10 USD–12M în ultimii"),
    ("ro", "buget de EUR 1.5-2.5M, în funcție", "buget de 1,5 EUR-2,5 mil., în funcție"),
    ("ro", "este de RON 4.58 mil în această", "este de 4,58 RON mil în această"),
    ("ro", "este de EUR 1 milion pentru", "este de 1 EUR milion pentru"),
    ("ro", "este de RON 4.58 M în", "este de 4,58 RON M în"),
    ("ro", "este de EUR 12 300 000 în", "este de 12 EUR 300 000 în"),
    ("ro", "sunt de CAD $7.5M în", "sunt de CAD 7,5 mil. USD în"),
    ("ro", "sunt de $7.5M CAD în", "sunt de 7,5 mil. USD CAD în"),
    ("en", "is between USD 1,5 and 2,5 mil. for", "is between 1.5 USD and 2.5M for"),
    ("ro", "este de USD 4.58Bn în", "este de 4,58 mil. USD în"),            # a billion read as a million
    ("ro", "este de RON +4.58M față", "este de 4,58 mil. RON față"),         # a sign dropped
    ("ro", "este de RON -4.58M față", "este de 4,58 mil. RON față"),
    ("ro", "este 2.5‰ din", "este 2,5% din"),                                # a per-mille made a percentage
    ("ro", "este de RON 4.58M în", "este de 4,58 mil. EUR în"),              # another currency
    ("ro", "este de RON 4.58M în", "este de 45,8 mil. RON în"),              # (digits kept, the mark moved)
    # round 2 (review 2026-10-05): a hedge between the bounds, an in-line space
    # the product does not write, a year-shaped amount before a count.
    ("ro", "este între EUR 40 și circa 55 milioane, în", "este între 40 EUR și circa 55 milioane, în"),
    ("ro", "este de la RON 10 la aproximativ 12 milioane, în", "este de la 10 RON la aproximativ 12 milioane, în"),
    ("en", "is between USD 1,5 and roughly 2,5 mil. for", "is between 1.5 USD and roughly 2.5M for"),
    ("ro", "este estimat la RON 10 \u2013 max. 12M în", "este estimat la 10 RON \u2013 max. 12M în"),
    ("ro", "este de EUR 12\u2009300\u2009000 în", "este de 12 EUR\u2009300\u2009000 în"),
    ("ro", "este de RON 64\u2007567\u2007890 în", "este de 64 RON\u2007567\u2007890 în"),
    ("ro", "social 2000 RON 100 părți în", "social 2000 100 RON părți în"),
]


def test_e11_the_independent_reader_sees_a_figure_bound_to_something_else():
    for lang, before, after in MISBOUND:
        assert READER.changed_amounts(before, after, lang) != [], (before, after)
        assert digits(before) == digits(after), "the control must keep every digit: %r" % (after,)
        # …and the normaliser no longer produces it: the amount keeps its binding.
        out, _report = F.normalise_figures("Valoarea %s această perioadă." % before, lang)
        assert READER.changed_amounts("Valoarea %s această perioadă." % before, out, lang) == [], out
    # What is RIGHT passes it: the same amount, code after, the reader's marks.
    for lang, before, after in [
        ("ro", "este de RON 4.58M în", "este de 4,58 mil. RON în"),
        ("ro", "este de ~EUR 12.3M (din RON 64,567,890)", "este de ~12,3 mil. EUR (din 64.567.890 RON)"),
        ("ro", "este de RON -2,577,640.82, adică", "este de -2.577.640,82 RON, adică"),
        ("en", "was 12,3 mil. EUR and 8,75% of", "was 12.3M EUR and 8.75% of"),
        ("ro", "sunt de 1.5-2.5M EUR în", "sunt de 1,5-2,5 mil. EUR în"),
    ]:
        assert READER.changed_amounts(before, after, lang) == [], (before, after)
    # It shares nothing with the code under test.
    source = (REPO / "tests" / "engine" / "_figure_reader.py").read_text(encoding="utf-8")
    imports = sorted(set(
        (node.module if isinstance(node, ast.ImportFrom) else alias.name)
        for node in ast.walk(ast.parse(source)) if isinstance(node, (ast.Import, ast.ImportFrom))
        for alias in node.names))
    assert imports == ["__future__", "re", "typing"], imports


NB, TH = "\u00a0", "\u202f"
#: THE GRAMMAR of a code-first amount: every head x number x magnitude x
#: what follows. The followers are the review's shapes — a range, a list, a
#: number that goes on, a magnitude the standard does not print, another
#: currency, a date — beside the ones a sentence ordinarily has.
GRAMMAR_FRAMES = {"ro": "Valoarea este de {x} în această perioadă.",
                  "en": "The value was {x} for the year and that is the total."}
GRAMMAR_HEADS = ["RON ", "EUR ", "USD ", "$", "€", "~EUR ", "-RON ", "RON -", "RON +", "RON" + NB]
GRAMMAR_NUMBERS = {"ro": ["1.5", "12.5", "4.58", "64,567,890", "1,234,567.89", "40", "5", "0.19"],
                   "en": ["1,5", "12,5", "4,58", "64.567.890", "1.234.567,89", "40", "5", "0,19"]}
GRAMMAR_MAGNITUDES = ["", "M", "B", "K", "bn", "Bn", " mil.", " mld.", " mii"]
GRAMMAR_FOLLOWERS = [
    "", ",", ";", ")", " și restul", " and more", "-2.5M", "–3", " - 7 mil.", " – 9", " și 55 milioane",
    " and 55 million", ", 50 sau 55 milioane", " 300 000", NB + "300" + NB + "000", TH + "300", "'234", " mil", " mld",
    " M", " milion", " milioane", " trillion", " bn", " mio.", " CAD", " (AUD)", " EUR", "%", " %", "x", " zile",
    " la 31.12", " la 7 milioane", ", 12.5% peste", " și EUR 3.5M", "$3", " €3", "\n2. Altceva", " to 9M", " sau 7",
    "-year", " (2025)", "/an", "**", " | 5", " de mii", " de milioane", "\u2014adică", "/6",
    # round 2: a hedge before the second bound, an en dash as its sign, every in-line space as a group separator
    " și circa 55 milioane", " to roughly 55 million", ", eventual 12 milioane", " \u2013 max. 12M",
    ", respectiv \u20133.1M", " până la maximum 2.5M", "\u2009300\u2009000", "\u2007300", "\t300", "\u3000300",
]
#: What stands before the code — a number that could own it, a rate word, a
#: range opener, another currency's code (with the three plain magnitudes).
GRAMMAR_BEFORE = ["la 31.12 ", "nota 4.2 ", "la 3M ", "În 2025 ", "CAD ", "între ", "de la ", "curs ", "7.5M ",
                  "Contul ", "Capital 2000 "]


def _grammar():
    for lang in ("ro", "en"):
        numbers = GRAMMAR_NUMBERS[lang]
        for head in GRAMMAR_HEADS:
            for number in numbers:
                for magnitude in GRAMMAR_MAGNITUDES:
                    for follower in GRAMMAR_FOLLOWERS:
                        yield lang, head + number + magnitude + follower
        for before in GRAMMAR_BEFORE:
            for head in GRAMMAR_HEADS:
                for number in numbers[:3]:
                    for magnitude in ("", "M", " mil."):
                        for follower in GRAMMAR_FOLLOWERS:
                            # (a symbol glued behind a code that is not moved reads as nothing to either reader)
                            if follower == "$3" and before in ("curs ", "CAD "):
                                continue
                            yield lang, before + head + number + magnitude + follower


def test_e11_the_grammar_no_code_first_amount_is_bound_to_anything_else_after_the_pass():
    checked = changed = frozen = 0
    for lang, expression in _grammar():
        text = GRAMMAR_FRAMES[lang].replace("{x}", expression)
        out, report = F.normalise_figures(text, lang)
        checked += 1
        assert digits(out) == digits(text), text
        assert READER.changed_amounts(text, out, lang) == [], (text, out)
        assert F.normalise_figures(out, lang)[0] == out, text
        reasons = [why for _t, why in report["left"]]
        assert not (out != text and "single_group" in reasons), text
        changed += out != text
        frozen += "open_amount" in reasons
    # The law ran on something: thousands rewritten, thousands left as one expression.
    assert checked >= 120_000 and changed >= 30_000 and frozen >= 40_000, (checked, changed, frozen)
    WORK["grammar"] = checked


#: The review's sentences (2026-10-05, invented figures): each came back with
#: the code on another number. Now each comes back exactly as written,
#: counted as ONE expression — in both languages' texts.
LEFT_AS_ONE_EXPRESSION = [
    ("ro", "Bugetul este de EUR 1.5-2.5M, în funcție de cerere.", "EUR 1.5-2.5M"),
    ("ro", "Necesarul este estimat la RON 10-12M pentru 12 luni.", "RON 10-12M"),
    ("ro", "Capex-ul a fost de $10–12M în ultimii ani.", "$10–12M"),
    ("ro", "Dobânda la creditele în EUR 5-7% este mare.", "EUR 5-7"),
    ("en", "The range is EUR 40-55M for this company and that is the envelope.", "EUR 40-55M"),
    ("ro", "EBITDA este de RON 4.58 mln în această perioadă.", "RON 4.58"),
    ("ro", "EBITDA este de RON 458 mil în această perioadă.", "RON 458"),
    ("ro", "Cifra de afaceri este de EUR 12" + NB + "300" + NB + "000 în această perioadă.", "EUR 12" + NB + "300" + NB + "000"),
    ("ro", "Cifra de afaceri este de EUR 12" + TH + "300" + TH + "000 în această perioadă.", "EUR 12" + TH + "300" + TH + "000"),
    ("ro", "Perioada 01.03-31.03 RON 5M este acoperită.", "31.03 RON 5M"),
    ("ro", "Costul este de $7.5M (AUD) pe an.", "$7.5M"),
    ("en", "The balance at 31,12 EUR 5,2 mil. is higher than before and that is good.", "31,12 EUR 5,2 mil."),
]


@pytest.mark.parametrize("lang,text,token", LEFT_AS_ONE_EXPRESSION, ids=[t[1][:28] for t in LEFT_AS_ONE_EXPRESSION])
def test_e11_the_reviews_sentences_come_back_as_written_and_counted(lang, text, token):
    out, report = F.normalise_figures(text, lang)
    assert out == text
    assert report["rewritten"] == 0
    assert (token, "open_amount") in report["left"], report["left"]
    # …with a handed figure equal to every number in it, too.
    handed = [float(t.replace(",", "")) for t in re.findall(r"[0-9]+(?:[.,][0-9]+)?", text)
              if t.replace(",", "").replace(".", "", 1).isdigit() and t.count(".") + t.count(",") <= 1]
    assert F.normalise_figures(text, lang, handed)[0] == text


def test_e11_joiners_the_product_did_not_write_are_read_as_spaces_and_kept_as_bytes():
    """U+00A0 / U+202F inside what the model wrote (review 2026-10-05): a
    code-after amount is rewritten and keeps the model's own joiner; a
    code-first one is moved behind the figure with the product's."""
    text = "EBITDA este 4.58M" + NB + "RON, adică 12.5" + NB + "% din total și RON" + TH + "7.5M în plus."
    out, report = F.normalise_figures(text, "ro")
    assert out == "EBITDA este 4,58" + NB + "mil." + NB + "RON, adică 12,5" + NB + "% din total și 7,5" + NB + "mil." + NB + "RON în plus."
    assert report == {"rewritten": 3, "left": []}
    assert READER.changed_amounts(text, out, "ro") == []


# ══ E12 — never half a text ═══════════════════════════════════════════════

HELD_RO = ("Cifra de afaceri este RON 98,765,432.10, EBITDA este RON 9.8M (marjă 10.7%), iar dobânzile sunt "
           "RON 386,102 în această perioadă.")


def test_e12_a_text_holding_a_lone_group_is_returned_whole_whatever_else_it_holds():
    out, report = F.normalise_figures(HELD_RO, "ro")
    assert out == HELD_RO and report["rewritten"] == 0
    assert report["left"] == [("386,102", "single_group"), ("", "text_held")]
    # POSITIVE CONTROL: without the lone group every figure of it IS rewritten …
    without = HELD_RO.replace("RON 386,102", "RON 386,102.50")
    converted, r2 = F.normalise_figures(without, "ro")
    assert plain(converted) == ("Cifra de afaceri este 98.765.432,10 RON, EBITDA este 9,8 mil. RON (marjă 10,7%), "
                                "iar dobânzile sunt 386.102,50 RON în această perioadă.")
    assert r2 == {"rewritten": 4, "left": []}
    # … and the HALF text the pass used to return is what the reader would
    # misread: the one comma group among Romanian figures reads 386 lei.
    half = ("Cifra de afaceri este 98.765.432,10 RON, EBITDA este 9,8 mil. RON (marjă 10,7%), iar dobânzile sunt "
            "RON 386,102 în această perioadă.")
    assert plain(out) != half
    # A handed figure equal to either reading changes nothing (never guessed).
    for anchors in ((386102.0,), (386.102,), (386101.85,), (386102.0, 386.102)):
        assert F.normalise_figures(HELD_RO, "ro", anchors)[0] == HELD_RO
    # A lone group with NOTHING to rewrite beside it holds nothing: no marker.
    alone = "Dobânzile sunt de 386.102 RON, iar marja este 10,7%."
    assert F.normalise_figures(alone, "ro") == (alone, {"rewritten": 0, "left": [("386.102", "single_group")]})
    # In English text, and inside an expression left as written.
    en = "Cash: 1.234 RON; debt 12.345,67 RON; margin 8,75% for the year."
    assert F.normalise_figures(en, "en") == (en, {"rewritten": 0, "left": [("1.234", "single_group"), ("", "text_held")]})
    ranged = "Valoarea este între EUR 1,500 și 2,500, cu o marjă de 8.75%."
    out, report = F.normalise_figures(ranged, "ro")
    assert out == ranged and ("", "text_held") in report["left"]


#: Texts already in their OWN notation, one lone group in each (the seam
#: review's three, invented figures): the only thing to do is move a code.
CODE_ONLY = [
    ("en", "Net turnover was RON 64,567,890 and interest expense RON 386,102 (margin 11.85%).",
     "Net turnover was 64,567,890 RON and interest expense RON 386,102 (margin 11.85%)."),
    ("ro", "Cifra de afaceri este RON 64.567.890, iar dobânzile sunt RON 386.102 (marjă 11,85%).",
     "Cifra de afaceri este 64.567.890 RON, iar dobânzile sunt RON 386.102 (marjă 11,85%)."),
    ("en", "Net turnover was RON 64,567,890, EBITDA RON 7,654,321 and cash RON 258,419.",
     "Net turnover was 64,567,890 RON, EBITDA 7,654,321 RON and cash RON 258,419."),
]


@pytest.mark.parametrize("lang,text,expected", CODE_ONLY, ids=[c[1][:30] for c in CODE_ONLY])
def test_e18_a_code_that_only_changes_sides_beside_a_lone_group_is_moved_and_no_number_changes(lang, text, expected):
    out, report = F.normalise_figures(text, lang)
    assert plain(out) == expected
    reasons = [why for _t, why in report["left"]]
    assert reasons == ["single_group"] and report["rewritten"] >= 1
    # WHY THIS CANNOT MISLEAD: every number token is byte for byte the model's
    # (no separator exchanged, no magnitude re-spelt), so the notation around
    # the lone group — what it is read by — is exactly what it was.
    assert numbers_as_written(out) == numbers_as_written(text)
    assert READER.changed_amounts(text, out, lang) == []
    assert F.normalise_figures(out, lang)[0] == out
    # POSITIVE CONTROL: one figure in the OTHER notation beside it, and the text is held whole.
    foreign = text.replace("11.85%", "11,85%") if lang == "en" else text.replace("11,85%", "11.85%")
    if foreign != text:
        held_out, held_report = F.normalise_figures(foreign, lang)
        assert held_out == foreign and ("", "text_held") in held_report["left"]


def test_e17_one_recommendation_is_one_text_a_lone_group_in_any_field_holds_every_field():
    """The writer stores a recommendation's rationale and actions as ONE
    explanation under its title (review 2026-10-05, round 2: held per field,
    the stored text came out half rewritten — "RON 386,102" alone in the
    other notation, among Romanian figures). The briefing is its own text."""
    title = "Reduceți datoria netă sub 2.5× EBITDA"
    rationale = "Un tampon de RON 3,505,910.20 acoperă 5.4% din datoriile curente."
    actions = ["Renegociați dobânzile de RON 386,102 pe an.", "Reduceți DSO de la 61.4 la 48.0 zile."]
    payload = {"briefing": WRONG_RO,
               "recommendations": [{"title": title, "rationale": rationale, "actions": list(actions)},
                                   {"title": title, "rationale": rationale, "actions": actions[1]}]}
    out, report = F.normalise_narrate_result(payload, "ro")
    # The briefing holds no lone group: rewritten, whatever a recommendation holds.
    assert plain(out["briefing"]) == RIGHT_RO
    # The first recommendation holds one (in an action): EVERY field of it is the model's.
    assert out["recommendations"][0] == {"title": title, "rationale": rationale, "actions": actions}
    # POSITIVE CONTROL: the same fields without the lone group ARE rewritten — `actions` as one string too.
    assert plain(out["recommendations"][1]["title"]) == "Reduceți datoria netă sub 2,5× EBITDA"
    assert plain(out["recommendations"][1]["rationale"]) == "Un tampon de 3.505.910,20 RON acoperă 5,4% din datoriile curente."
    assert plain(out["recommendations"][1]["actions"]) == "Reduceți DSO de la 61,4 la 48,0 zile."
    assert report["left_by_reason"] == {"single_group": 1, "text_held": 3}
    assert report["fields_checked"] == 8 and report["fields_changed"] == 4 and report["errors"] == 0
    assert "386" not in json.dumps(report)
    # A lone group in the TITLE holds the rationale; one in the briefing holds only the briefing.
    out, report = F.normalise_narrate_result(
        {"briefing": HELD_RO, "recommendations": [{"title": "Dobânzi de RON 386,102", "rationale": rationale},
                                                  {"title": title, "rationale": rationale}]}, "ro")
    assert out["briefing"] == HELD_RO
    assert out["recommendations"][0] == {"title": "Dobânzi de RON 386,102", "rationale": rationale}
    assert plain(out["recommendations"][1]["rationale"]).startswith("Un tampon de 3.505.910,20 RON")
    # A lone group beside fields the pass would NOT reshape holds nothing (codes only change sides).
    out, report = F.normalise_narrate_result(
        {"recommendations": [{"title": "Dobânzi de RON 386.102", "rationale": "Un tampon de RON 3.505.910,20 ajunge."}]}, "ro")
    assert plain(out["recommendations"][0]["rationale"]) == "Un tampon de 3.505.910,20 RON ajunge."
    assert report["left_by_reason"] == {"single_group": 1}


def test_e17_the_stored_recommendation_is_never_half_rewritten(monkeypatch):
    """Read off the STORED row — `explanation` is the rationale and the
    actions joined by the writer — with the real narrator and the real writer."""
    double = SERVED._world()
    recommendation = {"severity": "high", "category": "financial", "title": "Renegociați dobânzile de RON 386,102",
                      "rationale": "Un tampon de RON 3,505,910.20 acoperă 5.4% din datoriile curente.",
                      "actions": ["Renegociați dobânzile de RON 386,102 pe an.", "Reduceți DSO de la 61.4 la 48.0 zile."],
                      "estimated_ron_impact": 3505910.2}
    narrated, provider = _narrate(monkeypatch, _reply(WRONG_RO, [recommendation]), "ro")
    assert len(provider.calls) == 1
    with RA.installed(double):
        P.stage_persist_narrative(dict(SERVED.DOC, detected_language="ro"), SERVED.PID, narrated, [])
    stored = double.tables.get("recommendations", [])
    assert len(stored) == 1
    assert stored[0]["title"] == recommendation["title"]
    assert stored[0]["explanation"] == (
        "Un tampon de RON 3,505,910.20 acoperă 5.4% din datoriile curente."
        "\n\nActions:\n• Renegociați dobânzile de RON 386,102 pe an.\n• Reduceți DSO de la 61.4 la 48.0 zile.")
    # ONE notation in the stored text: the detector finds the model's figures
    # (it is held, counted) and NOT ONE of ours beside them.
    assert "5,4%" not in stored[0]["explanation"] and "3.505.910,20" not in stored[0]["explanation"]
    assert numbers_as_written(stored[0]["explanation"]) == numbers_as_written(
        recommendation["rationale"] + " " + " ".join(recommendation["actions"]))
    # The briefing beside it is its own text, and is rewritten.
    assert plain(SERVED._briefing_rows(double)[0]["body"]) == RIGHT_RO


def test_e17_the_pass_never_changes_what_a_stored_briefing_is_read_as(monkeypatch):
    """`stored_briefing_failure_code` reads a body that BEGINS "Error code: N"
    as a provider failure. A briefing "Error code: RON 1,250.50 …" with the
    code moved would begin exactly so: it keeps the model's text."""
    body = "Error code: RON 1,250.50 a fost raportat de bancă la plata din 12.5% a creditului."
    moved, _ = F.normalise_narrate_result({"briefing": body}, "ro")
    assert plain(moved["briefing"]).startswith("Error code: 1.250,50 RON")           # POSITIVE CONTROL
    assert P.stored_briefing_failure_code(moved["briefing"]) != P.stored_briefing_failure_code(body)
    out, report = F.normalise_narrate_result({"briefing": body}, "ro", briefing_verdict=P.stored_briefing_failure_code)
    assert out["briefing"] == body
    assert report["left_by_reason"] == {"text_held": 1} and report["rewritten"] == 0 and report["fields_changed"] == 0
    narrated, _provider = _narrate(monkeypatch, _reply(body), "ro")
    assert narrated["briefing"] == body and not narrated.get("unavailable")
    # A verdict that raises keeps the model's text too.
    out, _ = F.normalise_narrate_result({"briefing": body}, "ro", briefing_verdict=lambda _s: 1 / 0)
    assert out["briefing"] == body


# ══ E13 — the composed set ════════════════════════════════════════════════

def test_e13_the_composed_set_no_digit_moves_nothing_is_half_rewritten_and_the_twin_digest_holds():
    spec = COMPOSE_SPEC
    assert spec["count"] == 12000
    changed = held_texts = left_open = 0
    for i in range(spec["count"]):
        text, lang, anchors = COMPOSE.compose(spec, i)
        out, report = F.normalise_figures(text, lang, anchors)
        assert digits(out) == digits(text), text
        reasons = [why for _t, why in report["left"]]
        if "text_held" in reasons:
            assert out == text and report["rewritten"] == 0 and "single_group" in reasons, text
            held_texts += 1
        # Beside a lone group at most a code changed sides: no number token moved by a byte.
        if "single_group" in reasons:
            assert numbers_as_written(out) == numbers_as_written(text), text
        # A second pass changes nothing: what is stored and what is shown are one text.
        assert F.normalise_figures(out, lang, anchors)[0] == out, text
        # The run-time proof holds on what was returned.
        assert F._structure_held(text, out), text
        changed += out != text
        left_open += "open_amount" in reasons
    assert changed >= 4000 and held_texts >= 500 and left_open >= 1500, (changed, held_texts, left_open)
    # POSITIVE CONTROL of the composition: the first text, written out.
    assert COMPOSE.compose(spec, 0) == COMPOSE.compose(spec, 0)
    assert len(set(COMPOSE.compose(spec, i)[0] for i in range(200))) >= 195
    # THE TWIN: the browser's normaliser must reproduce the same digest over
    # the same texts (frontend/lib/__tests__/readerFigures.test.ts).
    assert COMPOSE.digest_of(spec, F.normalise_figures) == spec["digest"], (
        "the engine's outputs over the composed set changed: %s — if the rule change is deliberate and made in "
        "BOTH runtimes, commit this digest in compose.json" % COMPOSE.digest_of(spec, F.normalise_figures))
    WORK["composed"] = spec["count"]


# ══ E16 — the independent reader over the composed set ════════════════════

#: Every composed text the independent reader flags, by index — each READ BY
#: HAND (round 2; the set re-read in round 3, when the grammar gave the second
#: number a `pre` of its own). None is a figure bound to something else:
READER_FLAGS_ON_THE_COMPOSED_SET = {
    # a sentence stop merged into "mil." (the judged "one stop, not two"): the
    # reader then reads the list comma that follows and inherits the next code
    619: "'1234.567M., USD 12,5B' -> '1234,567 mil., USD 12,5B': the merged stop, then a list comma",
    4198: "'1,234.56M., ora 28,281,291 lei' -> '1.234,56 mil., ora …': the same merged stop",
    # "CAD" is the tail of a URL — a span the pass never enters — and the "$"
    # after it is written USD
    1593: "'https://x.test/CAD $1.5' -> '… 1.5 USD'",
    5285: "the same URL tail",
    8652: "the same URL tail",
    # glued garbage: a magnitude letter glued to a symbol ("k€0.19", "B$3",
    # "bn€10"): the pass re-spells the letter in place, the symbol stays where
    # it was, and the reader reads the two as one currency name
    2161: "'k€0.19 %' -> 'mii€0,19 %'",
    2170: "'K$1234,567' -> 'mii$1234,567'",
    3295: "'999,999.99B$3' -> '999.999,99 mld.$3'",
    3730: "'1.5M€401.404.408pp' -> '1,5 mil.€401.404.408pp'",
    4106: "'401.404.408bn€1234.567k' -> '401,404,408B€1234.567k'",
    7129: "'2.5B€5×' -> '2,5 mld.€5×'",
    7409: "'4,58bn€1234,567T' -> '4.58B€1234,567T'",
    7589: "'31.12M$1.5T' -> '31,12 mil.$1.5T'",
    7682: "'0,1905 mii$999,999.99M' -> '0.1905K$999,999.99M'",
    8028: "'12,5Bn€1,234,567K' -> '12.5B€1,234,567K'",
    8783: "'31.12k$28,281,291M' -> '31,12 mii$28.281.291 mil.'",
    9663: "'31.12k$1.5' -> '31,12 mii$1,5' (the '$' after a letter is evidence only, and stays)",
    9863: "'401.404.408bn€10×' -> '401,404,408B€10×'",
    10477: "'14.30bn$10 %' -> '14,30 mld.$10 %'",
    # the reader's forward inheritance: a number after ", <word>" / " and
    # <word>" behind a code-first amount that was CLOSED (its code moved behind
    # it) — the reader called the first amount's code shared before the move
    2318: "'~EUR 0,19B, între 1.234,56 USDart.' -> '~0.19B EUR, între 1,234.56 USDart.'",
    4437: "'RON 1,234.56 and art. 1.234,56 milcurs' -> '1,234.56 RON and art. 1,234.56 milcurs'",
    # the reader's second-code artefact: a code standing between two numbers
    # ("de lei RON +1,234,567", "0.1905 CAD USD 401…", "mii (RON 3") is read
    # as a SECOND code of the first number; the pass reads it as the next
    # number's head (no digit stands before it) and moves it behind that one
    3906: "'C$0.19 de lei RON +1,234,567' -> 'C$0,19 de lei +1.234.567 RON'",
    6827: "'(83,6 de lei RON 4.58' -> '(83.6 de lei 4.58 RON'",
    7822: "'curs EUR 0.1905 CAD USD 401.404.408M' -> 'curs EUR 0,1905 CAD 401.404.408 mil. USD'",
    8654: "'RON -0.1905 de lei EUR 1234.567 miide' -> 'RON -0,1905 de lei 1234,567 EUR miide'",
    10578: "'RON -64.567.890 mii (RON  3 mii' -> '-64,567,890K RON (RON  3 mii'",
    # (round 2's 9241 — "a magnitude letter written against a URL, read as the
    # magnitude it is" — is gone: a URL's first character is read with the
    # segment now, so "14.30Bhttps://" is the glued non-magnitude it is in
    # prose, and the text is left as written)
    # an en dash written AGAINST a reference word ("64,567,890–art. 83,6m"):
    # the reader reads a range joiner with a hedge and lends the first number
    # the second's magnitude; the pass reads an unspaced en dash against a word
    # as a break and closes the first amount
    11900: "'**RON 64,567,890–art. 83,6m' -> '**64.567.890 RON–art. 83,6m'",
}


def test_e16_the_reader_over_the_composed_set_flags_exactly_what_was_read_by_hand():
    flagged = []
    for i in range(COMPOSE_SPEC["count"]):
        text, lang, anchors = COMPOSE.compose(COMPOSE_SPEC, i)
        out, _report = F.normalise_figures(text, lang, anchors)
        if READER.changed_amounts(text, out, lang):
            flagged.append(i)
    assert flagged == sorted(READER_FLAGS_ON_THE_COMPOSED_SET), (
        "the independent reader flags another composed output — read it before pinning it: %s"
        % sorted(set(flagged) ^ set(READER_FLAGS_ON_THE_COMPOSED_SET)))


# ══ E15 — what is not a figure, beside one ════════════════════════════════

def test_e15_the_label_grammar_an_id_beside_an_amount_survives_and_a_second_pass_changes_nothing():
    spec = LABEL_SPEC
    checked = changed = 0
    by_class: Dict[str, int] = {}
    for lang, cls, label, ident, text in COMPOSE.label_texts(spec):
        out, report = F.normalise_figures(text, lang)
        checked += 1
        by_class[cls] = by_class.get(cls, 0) + 1
        # THE ID'S BYTES SURVIVE: an account, a date, a note number, a year is
        # nobody's amount, whatever follows it.
        assert out.startswith(label + ident), (text, out)
        assert digits(out) == digits(text), text
        # A SECOND PASS CHANGES NOTHING: what is stored and what is shown are one text.
        assert F.normalise_figures(out, lang)[0] == out, (text, out)
        assert READER.changed_amounts(text, out, lang) == [], (text, out)
        reasons = [why for _t, why in report["left"]]
        assert "proof_failed" not in reasons, text
        changed += out != text
    assert checked == 29263 and sorted(by_class) == ["account", "date", "line", "period", "plain", "reference"], by_class
    # The law ran on REWRITTEN texts: the amount beside the id is still formatted.
    assert changed >= 15_000, changed
    # POSITIVE CONTROL of the shapes: the review's sentences are IN the grammar.
    texts = set(text for _l, _c, _a, _i, text in COMPOSE.label_texts(spec))
    for needle in ("Contul 5121.01 \u2013 1.234.567,89 RON în această perioadă.", "Sold la 31.12 - RON 5.2M în această perioadă.",
                   "Nota 4.2 \u2013 5,2 mil. RON în această perioadă.", "- 4111.01 - 1.234.567,89 RON în această perioadă.",
                   "Analiticul 401.15 - 15% în această perioadă.", "În 2025 RON 5.2M în această perioadă.",
                   "Account 5121,01 - 1.234.567,89 RON for the period and that is the total."):
        assert needle in texts, needle
    # THE TWIN: the browser's normaliser must reproduce the same digest
    # (frontend/lib/__tests__/readerFigures.test.ts).
    assert COMPOSE.label_digest_of(spec, F.normalise_figures) == spec["digest"], (
        "the engine's outputs over the label grammar changed: %s — if the rule change is deliberate and made in "
        "BOTH runtimes, commit this digest in labels.json" % COMPOSE.label_digest_of(spec, F.normalise_figures))
    WORK["labels"] = checked


# ══ E20 — an opener's range whose second bound is code-first ══════════════

#: THE OPENER GRAMMAR (round 3): opener × first bound × joiner × code-first
#: second bound. The confirmer of round 2 found "de la 2,811,386,091 la USD
#: 596,202,009" rewritten at the SECOND bound by the first pass and at the
#: first by the second — the engine and the chat STORE pass 1, the card and
#: the bubble SHOW pass 2 — because the pair gap was read to the second
#: number's digit, so " la USD " was not the opener's joiner until the code
#: had moved. Every text here must come out of ONE pass rewritten at both
#: bounds or at neither, and out of a second pass unchanged.
OPENER_FRAMES = {"ro": "Valoarea a variat {x} în această perioadă.", "en": "The value moved {x} over the period."}
OPENER_PAIRS = {"ro": [("între ", " și "), ("intre ", " si "), ("de la ", " la "), ("de la ", " până la ")],
                "en": [("between ", " and "), ("from ", " to ")]}
#: The first bound: the other notation, signed, a run of groups, "0.", its own notation.
OPENER_FIRST = {"ro": ["8.5", "-8.5", "29,38", "1,234.56", "596,202,009", "0.19", "8,5"],
                "en": ["8,5", "-8,5", "29.38", "1.234,56", "596.202.009", "0,19", "8.5"]}
#: The second bound's head: a code or a symbol, with a sign, a tilde, a no-break space.
OPENER_HEADS = ["RON ", "EUR ", "USD ", "$", "€", "-RON ", "-€", "~EUR ", "RON" + NB, "-$"]
OPENER_SECOND = {"ro": ["13.2", "2.5", "504", "2,811,386,091", "31.2", "0.6034"],
                 "en": ["13,2", "2,5", "504", "2.811.386.091", "31,2", "0,6034"]}
OPENER_MAGS = ["", "M", "K", "B", " mil.", "bn"]


def _opener_grammar():
    for lang in ("ro", "en"):
        for opener, joiner in OPENER_PAIRS[lang]:
            for first in OPENER_FIRST[lang]:
                for head in OPENER_HEADS:
                    for second in OPENER_SECOND[lang]:
                        for mag in OPENER_MAGS:
                            yield lang, first, opener + first + joiner + head + second + mag


def test_e20_an_openers_range_with_a_code_first_second_bound_is_rewritten_at_both_bounds_or_neither_in_one_pass():
    checked = both = neither = 0
    for lang, first, expression in _opener_grammar():
        text = OPENER_FRAMES[lang].replace("{x}", expression)
        out, report = F.normalise_figures(text, lang)
        checked += 1
        assert digits(out) == digits(text), text
        # A SECOND PASS CHANGES NOTHING: what is stored and what is shown are one text.
        assert F.normalise_figures(out, lang)[0] == out, (text, out)
        assert READER.changed_amounts(text, out, lang) == [], (text, out)
        # BOTH BOUNDS OR NEITHER: where the pass changed anything, the first
        # bound was not left in the other notation beside its partner.
        left = {tok: why for tok, why in report["left"]}
        if out != text:
            assert left.get(first) not in ("bare_decimal", "bare_groups"), (text, out, report["left"])
            both += 1
        else:
            neither += 1
    # (measured 14,970 / 150: the texts left whole are the English ones whose second bound carries " mil.")
    assert checked == 15120 and both >= 14_000 and neither >= 100, (checked, both, neither)
    # The confirmer's sentences, written out: one pass, both bounds.
    for lang, text, expected in [
        ("ro", "de la 2,811,386,091 la USD 596,202,009", "de la 2.811.386.091 la 596.202.009 USD"),
        ("en", "between 29,38 and RON 31.2B.", "between 29.38 and 31.2B RON."),
        ("ro", "între 68.5 și €504K", "între 68,5 și 504 mii EUR"),
        ("en", "from 1,5 to EUR 2.5M", "from 1.5 to 2.5M EUR"),
        ("ro", "între -68.5 și -€504K", "între -68,5 și -504 mii EUR"),
    ]:
        out, report = F.normalise_figures(text, lang)
        assert plain(out) == expected and report["left"] == [], (text, out, report)
        assert F.normalise_figures(out, lang)[0] == out


# ══ E19 — never slow ══════════════════════════════════════════════════════

#: One unbroken run per shape (review 2026-10-05, round 2: the e-mail
#: alternative and the backward word scans were QUADRATIC in the run's length —
#: 0.4 to 10 seconds for 20 KB of these, inside the request, with the GIL
#: held). The unit is repeated to the size asked for.
SLOW_SHAPES = {
    "word characters": ("a", ""),
    "letters and digits": ("ab_9", ""),
    "percentages": ("1.5%", ""),
    "dashed decimals": ("1.5-", ""),
    "bare decimals on one line": ("1.5 ", ""),
    "word characters and an address": ("a", " x@y.ro"),
    "dashed decimals and an address": ("1.5-", " x@y.ro"),
}
#: NOT in the law: "](a](a…" — the link-target pattern reads to the end of the
#: line by itself (0.3 s for 20 KB before and after; a reply of 2,000 tokens
#: cannot hold more of them).


def _timed(unit: str, tail: str, size: int) -> Tuple[float, str, str]:
    import time

    text = "Marja este " + unit * (size // len(unit)) + tail + " și 4.5% acum."
    best, out = None, ""
    for _ in range(3):                       # (the best of three: the machine is shared)
        started = time.perf_counter()
        out, _report = F.normalise_figures(text, "ro")
        elapsed = time.perf_counter() - started
        best = elapsed if best is None else min(best, elapsed)
        if elapsed > 4.0:                    # (already past any limit: do not measure it twice more)
            break
    return float(best or 0.0), text, out


@pytest.mark.parametrize("shape", sorted(SLOW_SHAPES))
def test_e19_the_time_of_a_long_unbroken_run_grows_with_its_length_not_with_its_square(shape):
    """10 KB against 40 KB of the same shape: four times the text may cost
    about four times the time (a quadratic rule costs sixteen) — and never
    more than a second and a half."""
    unit, tail = SLOW_SHAPES[shape]
    small, _text, _out = _timed(unit, tail, 10_000)
    big, text, out = _timed(unit, tail, 40_000)
    assert out.endswith("și 4,5% acum."), shape
    assert digits(out) == digits(text)
    assert big < 1.5, "%s: 40 KB took %.2f s" % (shape, big)
    assert big < 0.05 or big / max(small, 1e-6) < 8.0, "%s: 10 KB %.3f s, 40 KB %.3f s" % (shape, small, big)


def test_e19_the_shortcuts_change_no_output():
    """The three shortcuts — no digit, no '@', a bounded word scan — are the
    same outputs by construction: shown on the texts they could differ on."""
    # no digit: the text as given, nothing counted
    for text in ("Fără nicio cifră aici.", "x@y.ro și `cod` https://x.test/a", ""):
        assert F.normalise_figures(text, "ro") == (text, {"rewritten": 0, "left": []})
    # an address is still never entered — with the bounded local part, too
    for text in ("Scrie la a.b-1.5@firma1.5.ro pentru RON 1,234.50.", "x" * 80 + "1.5@y.ro și 2.5%"):
        out, _ = F.normalise_figures(text, "ro")
        assert "@" in out and out.split("@")[1].startswith(text.split("@")[1][:8]), out
    assert plain(F.normalise_figures("Scrie la a.b-1.5@firma1.5.ro pentru RON 1,234.50.", "ro")[0]) == (
        "Scrie la a.b-1.5@firma1.5.ro pentru 1.234,50 RON.")
    # a reference word is still read at the end of a very long line
    long_line = "x " * 4_000 + "Vezi art. 7.25 și marja de 4.5%."
    out, report = F.normalise_figures(long_line, "ro", [7.25])
    assert out.endswith("Vezi art. 7.25 și marja de 4,5%.") and ("7.25", "reference") in report["left"]


# ══ E14 — the run-time proof beyond the digits ════════════════════════════

def test_e14_the_proof_refuses_a_changed_magnitude_a_dropped_sign_and_a_code_on_another_number(monkeypatch):
    """PLANTED HERE, not in the source — each keeps every digit, so the digit
    proof alone passes all three."""
    text = "Capitalizarea este de USD 4.58Bn, iar variația de RON +2.5M față de buget."
    good, report = F.normalise_figures(text, "ro")
    assert plain(good) == "Capitalizarea este de 4,58 mld. USD, iar variația de +2,5 mil. RON față de buget."
    assert report["left"] == []

    # 1 — a rule that reads "Bn" as a million.
    monkeypatch.setattr(F, "_MAG_GLUED", (("Bn", "M"),) + F._MAG_GLUED[1:])
    out, report = F.normalise_figures(text, "ro")
    assert out == text and [why for _t, why in report["left"]] == ["proof_failed"]
    monkeypatch.undo()

    # 2 — a head reader that loses the sign.
    real_head = F._read_head
    monkeypatch.setattr(F, "_read_head", lambda s, i, floor: dict(real_head(s, i, floor), sign=""))
    out, report = F.normalise_figures(text, "ro")
    assert out == text and [why for _t, why in report["left"]] == ["proof_failed"]
    monkeypatch.undo()

    # 3 — the closure made blind: the code would land inside a spaced number.
    # (Its first group carries a decimal comma: a BARE first group is no
    # longer moved at all — a bare integer beside a code stays.)
    spaced = "Cifra de afaceri este de RON 64,5 567 890 în această perioadă."
    assert F.normalise_figures(spaced, "ro")[0] == spaced
    monkeypatch.setattr(F, "_amount_ends", lambda *_a, **_k: True)
    out, report = F.normalise_figures(spaced, "ro")
    assert out == spaced and [why for _t, why in report["left"]] == ["proof_failed"]
    monkeypatch.undo()

    # 4 — the same, the number grouped with a THIN space (round 2: the proof
    # read three spaces, so "64,5 RON\u2009567" looked like the same structure).
    thin = "Cifra de afaceri este de RON 64,5\u2009567\u2009890 în această perioadă."
    assert F.normalise_figures(thin, "ro")[0] == thin
    monkeypatch.setattr(F, "_amount_ends", lambda *_a, **_k: True)
    out, report = F.normalise_figures(thin, "ro")
    assert out == thin and [why for _t, why in report["left"]] == ["proof_failed"]
    monkeypatch.undo()

    # POSITIVE CONTROL: with the proof itself blinded, plant 3 DOES produce the misbound text.
    monkeypatch.setattr(F, "_amount_ends", lambda *_a, **_k: True)
    monkeypatch.setattr(F, "_structure_held", lambda *_a: True)
    out, _ = F.normalise_figures(spaced, "ro")
    assert plain(out) == "Cifra de afaceri este de 64,5 RON 567 890 în această perioadă."
    assert READER.changed_amounts(spaced, out, "ro") != []


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
    assert len(SEAM_CASES) >= 85
    assert sum(1 for c in SEAM_CASES if c["lang"] == "en") >= 18
    assert sum(1 for c in SEAM_CASES if c["wrong"]) >= 55
    assert sum(1 for c in SEAM_CASES if held(c)) >= 3
    assert "briefing-all-wrong-with-units" in [c["id"] for c in SEAM_CASES]


@pytest.mark.parametrize("case", SEAM_CASES, ids=[c["id"] for c in SEAM_CASES])
def test_e4_the_seam_the_real_narrator_returns_every_prose_field_in_the_readers_format(case, monkeypatch):
    text, lang = case["input"], case["lang"]
    recommendation = {
        "severity": "high", "category": "financial", "title": text, "rationale": text,
        "actions": [text, "Fără cifre aici." if lang == "ro" else "No figure here.", 7, None],
        # NOT prose: a number, a numeric string in the OTHER notation, an id.
        "estimated_ron_impact": 1234567.89, "metric_referenced": "RON 1,234.50 (8.75%)",
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
        assert READER.changed_amounts(text, field, lang) == []
        if not held(case):
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
            "datoria netă/EBITDA este 2.35×, iar zilele de stoc sunt 45.5 zile.")
RIGHT_RO = ("Cifra de afaceri este de 64.567.890 RON, cu un EBITDA de 7.654.321 RON (marjă 11,85%); "
            "datoria netă/EBITDA este 2,35×, iar zilele de stoc sunt 45,5 zile.")
WRONG_RO_EUR = "Cifra de afaceri este de EUR 12.3M, cu un EBITDA de EUR 1,458,148.25 (marjă 11.85%)."
RIGHT_RO_EUR = "Cifra de afaceri este de 12,3 mil. EUR, cu un EBITDA de 1.458.148,25 EUR (marjă 11,85%)."
WRONG_EN = ("Net turnover for the year was 64.567.890 RON (EBITDA margin 11,85%), with the net debt at "
            "1,5 mil. RON and leverage of 2,35x.")
RIGHT_EN = ("Net turnover for the year was 64,567,890 RON (EBITDA margin 11.85%), with the net debt at "
            "1.5M RON and leverage of 2.35x.")
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
FOREIGN_TEXT = "Umsatz RON 64,567,890, EBITDA ~EUR 12.3M (Marge 8.75%), Verschuldung 2.35x, 45.5 Tage."


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


def test_e7_a_field_the_pass_raised_on_keeps_the_models_text_and_is_counted_and_logged_as_a_defect(monkeypatch, caplog):
    """An honest refusal of the proof and a DEFECT in the pass looked the same
    in the log — a `proof_failed` count at INFO, no word that anything raised
    (review 2026-10-05, round 2). A field the pass raised on is counted
    `errors`, and the pipeline says so at WARNING."""
    def boom(*_a: Any, **_k: Any) -> Any:
        raise RecursionError("planted: the pass failed inside a field")

    monkeypatch.setattr(F, "_normalise_segment", boom)
    out, report = F.normalise_narrate_result({"briefing": WRONG_RO, "recommendations": [{"title": WRONG_RO}]}, "ro")
    assert out == {"briefing": WRONG_RO, "recommendations": [{"title": WRONG_RO}]}
    assert report["errors"] == 2 and report["left_by_reason"] == {"proof_failed": 2} and report["rewritten"] == 0
    with caplog.at_level("INFO", logger=P.logger.name):
        narrated, provider = _narrate(monkeypatch, _reply(WRONG_RO), "ro")
    assert narrated["briefing"] == WRONG_RO and not narrated.get("unavailable")     # as the model wrote it, usable
    assert len(provider.calls) == 1
    warnings = [r for r in caplog.records if r.levelname == "WARNING" and "the pass raised on" in r.getMessage()]
    assert len(warnings) == 1 and "1 field" in warnings[0].getMessage()
    # What THIS seam logs holds counts — never a token of the text.
    ours = [r.getMessage() for r in caplog.records if "narration figures" in r.getMessage()]
    assert len(ours) == 2 and "64,567,890" not in "".join(ours) and "7,654,321" not in "".join(ours)
    # POSITIVE CONTROL: a refusal of the PROOF is not an error.
    monkeypatch.undo()
    monkeypatch.setattr(F, "_structure_held", lambda *_a: False)
    _out, refused = F.normalise_narrate_result({"briefing": WRONG_RO}, "ro")
    assert refused["errors"] == 0 and refused["left_by_reason"] == {"proof_failed": 1}


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
        assert sorted(report) == ["errors", "fields_changed", "fields_checked", "left", "left_by_reason", "rewritten"]
    out, report = F.normalise_narrate_result(odd[-1], "ro")
    assert plain(out["briefing"]) == RIGHT_RO
    assert out["recommendations"][:4] == [None, 1, "s", {}]
    # (`actions` as ONE string is what the writer stores too: it is walked)
    assert {k: (plain(v) if isinstance(v, str) else v) for k, v in out["recommendations"][4].items()} == {
        "title": None, "rationale": 5, "actions": "1.234,50 RON"}
    assert out["recommendations"][5]["actions"][:3] == [None, 2, {"x": 1}]
    assert plain(out["recommendations"][5]["actions"][3]) == RIGHT_RO
    assert report["fields_checked"] == 3 and report["fields_changed"] == 3 and report["rewritten"] == 11
    assert report["errors"] == 0
    # The report that is LOGGED holds counts by reason — never a token.
    _o, r = F.normalise_narrate_result({"briefing": "Numerar RON 258,419 și rata 1.42."}, "ro")
    assert r["left"] == 2 and r["left_by_reason"] == {"bare_decimal": 1, "single_group": 1}
    assert "258" not in json.dumps(r)


# ══ E8 — the hint ═════════════════════════════════════════════════════════

RO_RON_LINE = ("LANGUAGE: Răspunde în limba română. Numbers in RO locale; cite currency as 'RON' AFTER the "
               "figure — never before it, never a symbol, never 'lei' (e.g. '1.234.567 RON', "
               "'1.234.567,89 RON', '12,3 mil. RON'); percentages, multiples and other ratios in the same "
               "locale (e.g. '8,75%', '2,35×'). Every monetary figure in `briefing_facts` is "
               "pre-converted to RON — do NOT re-convert.")
EN_EUR_LINE = ("LANGUAGE: Reply in English. Numbers in EN locale; cite currency as 'EUR' AFTER the "
               "figure — never before it, never a symbol, never 'lei' (e.g. '1,234,567 EUR', "
               "'1,234,567.89 EUR', '12.3M EUR'); percentages, multiples and other ratios in the same "
               "locale (e.g. '8.75%', '2.35×'). Every monetary figure in `briefing_facts` is "
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

    def counted(payload: Any, lang: str, anchors: Any = (), **kwargs: Any) -> Any:
        calls.append(lang)
        return real(payload, lang, anchors, **kwargs)

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
    assert WORK["corpus"] == len(CORPUS) and WORK["grid"] == 984 and WORK["narrations"] >= 130, WORK
    assert WORK["grammar"] >= 120_000 and WORK["composed"] == 12000 and WORK["labels"] == 29263, WORK
    # `mixed`: corpus outputs that still hold BOTH notations — a token left on
    # purpose beside rewritten ones. Printed so the number is seen, and held:
    # a rule that leaves more half-converted outputs moves it.
    assert WORK["mixed"] <= MIXED_OUTPUTS_AT_MOST, WORK
    print("\nGATE-WORK ai-figures-engine corpus=%d grid=%d narrations=%d languages=%d grammar=%d composed=%d "
          "labels=%d mixed=%d"
          % (WORK["corpus"], WORK["grid"], WORK["narrations"], len(ALL_LANGUAGES), WORK["grammar"],
             WORK["composed"], WORK["labels"], WORK["mixed"]))
