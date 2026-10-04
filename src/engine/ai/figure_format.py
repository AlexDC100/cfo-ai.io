"""The reader's figure format for model-written prose (engine.ai.figure_format).

WHY THIS EXISTS (owner order 2026-10-04)
----------------------------------------
    "Make chat and briefings write numbers in Romanian format in Romanian
    text (413.727.560 RON, ~77,4 mil. EUR), currency after the figure. Use
    the product's own formatting standard, with a gate."

A briefing is prose a MODEL wrote. One prompt hint was all that held its
figures to the reader's format; the day the model writes "~EUR 12.3M
(marjă 11.25%)" in a Romanian sentence, that is what the product stores
and serves. This module is the engine's half of the answer:

  1. :func:`currency_hint` — the hint, with example strings that ARE the
     product's own prints (:data:`HINT_EXAMPLES`), never typed beside a
     prompt;
  2. :func:`normalise_narrate_result` — the pass `stage_narrate` runs over
     what the model returned, before any writer sees it: a figure written
     in the OTHER language's notation is rewritten into the text's own.

THE ONE AUTHORITY IS THE FRONTEND'S FORMATTER
---------------------------------------------
`frontend/lib/money` (through `moneyLocaleFor`) decides what a figure looks
like. The engine has no formatter and gets none here: this module holds
MARKS (:data:`STANDARD`) and example STRINGS, and both are held equal to
`tests/engine/fixtures/ai_figures/standard.json` — a file vitest writes
from lib/money and re-generates on every run. Nothing in here prints a
number from a value.

NO FIGURE'S VALUE MAY CHANGE
----------------------------
A token is rewritten by swapping its separator characters one by one — its
digits never pass through a number type. It is rewritten ONLY when

  * its numeric reading is UNIQUE, and
  * something positive says it is a figure: a currency, a unit, a
    magnitude, a range partner that has one, a leading "0.", or a figure
    the model was handed (`anchors`).

Everything else is left exactly as written and COUNTED (the report's
``left`` list, one reason each):

  single_group    "1,234" / "1.234" — one group of three digits has two
                  readings (1234 or 1.234). Never guessed: the whole token
                  stays, number, magnitude and currency position.
  bare_decimal    "1.16" with nothing beside it and no handed figure.
  bare_groups     "401,404,408" — a run of three-digit groups with nothing
                  beside it (an account list reads the same).
  reference       after "art.", "IAS", "cont", "secțiunea", …
  outline         "2.1 Lichiditate" at the start of a line.
  possible_date   "la 25.03", "ora 14.30".
  leading_zero    "01.02", "007.5".
  possible_year   "EUR 2025".
  tenor           "ROBOR 3M".
  bare_magnitude  "5M" with no currency and an unchanged number.
  two_currencies  a code on both sides of one number.
  glued           "v2.1", "1.5T" — part of a word; a number that touches a
                  date or a clock time ("1,234:99").
  open_amount     a code-first amount that is NOT READ TO ITS END, left as one
                  expression exactly as written: a range or a list ("EUR
                  1.5-2.5M", "EUR 40 și 55 milioane"), a number that goes on
                  ("RON 64 567 890"), a magnitude the standard does not print
                  ("RON 4.58 mil", "EUR 1 milion"), another currency named
                  beside it ("$7.5M CAD"), a code between two numbers
                  ("31.12 RON 5.2M").
  code_before     a code that stays before its figure, counted so the report
                  says what the reader still sees: after a rate word, before a
                  percentage, behind two spaces / a bracket / emphasis marks,
                  a "$" the reply names another dollar for.
  text_held       the text holds a lone three-digit group AND figures the pass
                  would rewrite: it is returned WHOLE, as written (see below).
  proof_failed    the run-time proof below refused the result.

A handed figure is EVIDENCE that a value-unique token is a figure — it
never chooses between two readings.

A CODE MOVES ONLY BEHIND AN AMOUNT READ TO ITS END (review 2026-10-05). "EUR
1.5-2.5M" is not "1,5 EUR-2,5 mil.", "RON 4.58 mil" is not "4,58 RON mil",
"EUR 12 300 000" is not "12 EUR 300 000": every digit was kept and the figure
was bound to something else. Whatever the pass cannot read to its end it
leaves exactly as written — the code, the number, what follows — and counts.

NEVER HALF A TEXT. A lone three-digit group is read by the notation of the
figures around it. Rewriting those and leaving it would make "RON 386,102"
read as 386 lei among Romanian figures. A text that holds one is returned
whole: every figure in it still reads the way it did.

RUN-TIME PROOF (every call): the digit sequence of the output equals the
input's; every sign and ratio mark is the same character in the same place in
the order; every number keeps its magnitude and the currency bound to it
(read with tables of the proof's own) — or the text is returned exactly as it
came.

THE TWIN
--------
`frontend/lib/readerFigures.ts` is the same rule set in the browser (the
chat's replies, Explain, the briefing card). Both are run over the same
`tests/engine/fixtures/ai_figures/reply_corpus.json` and `grid.json` and
must agree byte for byte. Twin notes, for whoever edits either side:

  * `[0-9]`, never `\\d` (Python's `\\d` is every Unicode digit);
  * a "letter" is `str.isalpha()` on ONE UTF-16 unit — a character outside
    the basic plane is two units in the browser, neither of them a letter;
  * "whitespace" where the browser's `\\s` is meant is :data:`_JS_SPACE`.

LANGUAGES: Romanian and English only (:data:`FIGURE_LANGUAGES`). Any other
narration language is returned byte for byte — its hint and its text are
not this module's to touch.

Stdlib only. Never raises.
"""
from __future__ import annotations

import math
import re
import unicodedata
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

#: The languages whose figure format the product defines.
FIGURE_LANGUAGES = ("ro", "en")

NBSP = "\u00a0"

#: THE STANDARD AS DATA — equal to tests/engine/fixtures/ai_figures/
#: standard.json (written from frontend/lib/money; gate ai-figures-engine).
#: The joiners are the bytes the product prints: U+00A0 before a Romanian
#: magnitude word and before the ISO code.
STANDARD: Dict[str, Any] = {
    "codes": ["RON", "EUR", "USD"],
    "symbols": {"€": "EUR", "$": "USD"},
    "languages": {
        "ro": {
            "locale": "ro-RO", "group": ".", "decimal": ",",
            "magnitudes": {"K": "mii", "M": "mil.", "B": "mld."},
            "magnitude_joiner": NBSP, "code_joiner": NBSP,
        },
        "en": {
            "locale": "en-US", "group": ",", "decimal": ".",
            "magnitudes": {"K": "K", "M": "M", "B": "B"},
            "magnitude_joiner": "", "code_joiner": NBSP,
        },
    },
}

#: The example strings of the narration hint — the product's own prints of
#: standard.json's `hint.values` (plain spaces: this is prompt text).
HINT_EXAMPLES: Dict[str, Dict[str, str]] = {
    "ro": {"whole": "1.234.567", "decimals": "1.234.567,89", "compact": "12,3 mil.",
           "percent": "11,25%", "multiple": "1,19×"},
    "en": {"whole": "1,234,567", "decimals": "1,234,567.89", "compact": "12.3M",
           "percent": "11.25%", "multiple": "1.19×"},
}

#: Every reason a token is left as written.
LEFT_REASONS = (
    "single_group", "bare_decimal", "bare_groups", "bare_magnitude", "two_currencies",
    "reference", "outline", "possible_date", "leading_zero", "possible_year", "tenor",
    "glued", "open_amount", "code_before", "text_held", "proof_failed",
)

_CODES: Tuple[str, ...] = tuple(STANDARD["codes"])
_SYMBOL_CODE: Dict[str, str] = dict(STANDARD["symbols"])

# A magnitude as a model writes it: glued English letters, or a Romanian
# word after one space. Read in EITHER language's text.
_MAG_GLUED = (("Bn", "B"), ("bn", "B"), ("K", "K"), ("k", "K"), ("M", "M"), ("B", "B"))
_MAG_WORDS = tuple(
    (STANDARD["languages"]["ro"]["magnitudes"][key], key) for key in ("M", "B", "K")
)

# Words after a figure that make it a quantity (never rewritten themselves).
# A RATIO word says the number is not money at all ("12 zile", "3 ori"); a
# MONEY word is a magnitude or a currency in words ("55 milioane", "5 lei").
_RATIO_WORDS = (
    "zile", "zi", "days", "day", "ani", "years", "year", "luni", "months", "month", "ori", "times",
    "pp", "p.p.", "puncte", "points",
)
_MONEY_WORDS = (
    "milioane", "miliarde", "million", "millions", "billion", "billions", "thousand", "lei", "leu",
    "euro", "euros", "dolari", "dollars",
)
_UNIT_WORDS = _RATIO_WORDS + _MONEY_WORDS
# A word that CONTINUES an amount — a magnitude the standard does not print
# ("4.58 mil", "2.5 mld", "4.58 M", "3.2 trillion", "1 milion"). After a
# code-first number one of these means the amount does not end at the number:
# the code is never moved in between ("RON 4.58 mil" is not "4,58 RON mil").
_MAG_LIKE = frozenset((
    "mil", "mld", "mii", "mie", "mio", "mln", "mlrd", "mrd", "bn", "bln", "tn", "trn", "tril", "m",
    "mm", "b", "k", "t", "milion", "milioane", "miliard", "miliarde", "trilion", "trilioane",
    "million", "millions", "billion", "billions", "trillion", "trillions", "thousand", "thousands",
    "hundred", "hundreds", "sute", "mn",
))
# A number after one of these is a reference, not a figure.
_REF_STEMS = (
    "§", "art", "alin", "pct", "punct", "lit", "cap", "sec", "anex", "nota", "note", "tabel",
    "table", "figur", "fig", "pag", "page", "nr", "no", "ias", "ifrs", "isa", "ifric", "sic", "omfp",
    "oug", "hg", "leg", "law", "vers", "cont", "account", "acct", "ct", "item", "step", "pas", "etap",
    "chapter", "clause", "paragraph", "par",
)
_DATE_WORDS = (
    "la", "pe", "din", "până", "pana", "data", "termen", "termenul", "scadența",
    "scadenta", "scadență", "scadent", "scadentă", "ora", "orele", "on", "by",
    "until", "dated", "due", "since", "from", "at",
)
# "curs EUR 4.97": the code names the rate, not the figure's denomination.
_RATE_WORDS = ("curs", "cursul", "cursului", "rata", "rate", "paritate", "paritatea", "fx", "kurs")
_RANGE_JOINERS = (" și ", " si ", " and ", " to ", " la ", " până la ", " pana la ")
_RANGE_OPENERS = ("între", "intre", "between", "from", "la")
# What can stand between two numbers of ONE expression ("40 și 55 milioane",
# "10, 12 sau 15 mil."). "la" joins only after a range opener ("de la 1.5 la
# 2.5"): "RON 5.2M la 31.12" is an amount and a date.
_JOIN_WORDS = ("și", "si", "and", "to", "sau", "or", "ori", "respectiv", "&", "până la", "pana la")
_TENOR_WORDS = ("robor", "euribor", "libor", "sofr", "ircc", "saron", "estr", "€str")

_SIGNS = ("-", "−", "+")
_DASHES = ("-", "–", " - ", " – ")
_DASH_CHARS = ("-", "\u2013", "\u2014", "\u2212")
# What may stand right after an amount that has ended: closing punctuation.
# Anything else against the number — a symbol, a bracket that opens, "=",
# "+" — and the amount is not read to its end.
_CLOSERS = frozenset(".,;:!?)]}\"'\u00bb\u201d\u2019\u2026*_|")
_APOSTROPHES = ("'", "\u2019")
# What may stand between a code and the number it was written before without
# making it another sentence: spaces, a sign, an approximation mark, an
# opening bracket, markdown emphasis ("RON  5", "RON (5)", "**RON** 5").
_LOOSE_BETWEEN = frozenset(" \u00a0\u202f\t-\u2212+\u2013\u2014~\u2248(*_")

#: What the browser's `\s` matches (the twin's regexes use it).
_JS_SPACE = "\t\n\x0b\x0c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_JS_SPACE_SET = frozenset(
    "\t\n\x0b\x0c\r \u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff"
    + "".join(chr(c) for c in range(0x2000, 0x200B))
)
_WORD = "A-Za-z0-9_"

# NEVER ENTERED: fenced and inline code, a URL, a markdown link target, a
# placeholder, an e-mail address, a date, a clock time.
_PROTECTED = re.compile("|".join((
    r"```[\s\S]*?```",
    r"`[^`\n]*`",
    r"https?://[^%s)]+" % _JS_SPACE,
    r"\]\([^)\n]*\)",
    r"\{\{[^{}\n]*\}\}",
    r"\{[A-Za-z_][A-Za-z0-9_.]*\}",
    r"[%s.+-]+@[%s-]+\.[%s.-]+" % (_WORD, _WORD, _WORD),
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}",
    r"[0-9]{1,2}\.[0-9]{1,2}\.[0-9]{2,4}",
    r"[0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4}",
    r"[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?",
)))
_NUM = re.compile(r"[0-9][0-9.,]*[0-9]|[0-9]")
_LIST_LIKE = re.compile(r"[0-9]{3}(?:[.,][0-9]{3})+")
_YEAR = re.compile(r"(?:19|20)[0-9][0-9]")
_NOT_DIGIT = re.compile(r"[^0-9]")
_TRAILING_PUNCT = re.compile(r"[:;,]+\Z")
_TRAILING_PUNCT_STOP = re.compile(r"[:;,.]+\Z")


def _at(s: str, i: int) -> str:
    return s[i] if 0 <= i < len(s) else ""


def _is_digit(c: str) -> bool:
    return len(c) == 1 and "0" <= c <= "9"


def _is_letter(c: str) -> bool:
    # ONE UTF-16 unit, as the browser indexes a string: a character outside
    # the basic plane is never "a letter beside the number" there.
    return len(c) == 1 and ord(c) <= 0xFFFF and c.isalpha()


def _is_space(c: str) -> bool:
    return c in (" ", NBSP, "\u202f") and c != ""


def _digits_of(s: str) -> str:
    return _NOT_DIGIT.sub("", s)


def _notation(lang: str) -> Dict[str, str]:
    """The marks of `lang` (native) and of the OTHER language (foreign)."""
    native = STANDARD["languages"][lang]
    foreign = STANDARD["languages"]["en" if lang == "ro" else "ro"]
    return {"fg": foreign["group"], "fd": foreign["decimal"],
            "ng": native["group"], "nd": native["decimal"]}


def _shape(tok: str, lang: str) -> str:
    n = _notation(lang)
    g, d = re.escape(n["fg"]), re.escape(n["fd"])
    if re.fullmatch(r"[0-9]{1,3}(?:%s[0-9]{3})+%s[0-9]+" % (g, d), tok):
        return "foreign_full"
    if re.fullmatch(r"[0-9]{1,3}(?:%s[0-9]{3}){2,}" % g, tok):
        return "foreign_full"
    if re.fullmatch(r"[0-9]{1,3}%s[0-9]{3}" % g, tok):
        return "single_group"
    if re.fullmatch(r"[0-9]+%s[0-9]+" % d, tok):
        if re.fullmatch(r"[1-9][0-9]{0,2}%s[0-9]{3}" % d, tok):
            return "single_group"
        return "foreign_decimal"
    # The text's own notation (the marks change places), or a plain integer.
    if re.fullmatch(r"[0-9]+|[0-9]{1,3}(?:%s[0-9]{3})+(?:%s[0-9]+)?|[0-9]+%s[0-9]+" % (d, g, g), tok):
        return "native_or_plain"
    # "83,6,2025", "12.5.999,99": a number in NEITHER notation — never touched.
    return "not_a_number"


def _swap(tok: str, lang: str) -> str:
    """The token in `lang`'s marks: separators exchanged one character at a
    time — no digit is read, added, dropped or moved."""
    n = _notation(lang)
    return "".join(n["ng"] if c == n["fg"] else n["nd"] if c == n["fd"] else c for c in tok)


def _reading(tok: str, dec: str) -> Tuple[float, int]:
    at = tok.rfind(dec)
    places = 0 if at < 0 else len(tok) - at - 1
    return float(re.sub(r"[.,]", "", tok)), places


def _anchored_by(anchors: Sequence[float], reading: Tuple[float, int]) -> bool:
    """Is the token one of the handed figures, rounded or cut to its places?"""
    scaled, places = reading
    # A token of several hundred digits is not a figure anyone was handed
    # (and 10**places would overflow): never proved.
    if not anchors or not math.isfinite(scaled) or places > 300:
        return False
    p = math.pow(10, places)
    for a in anchors:
        x = abs(a) * p
        if not math.isfinite(x):
            continue
        if math.floor(x + 0.5) == scaled or math.floor(x + 1e-9) == scaled:
            return True
    return False


def _read_tail(s: str, i: int) -> Dict[str, Any]:
    """What stands right AFTER the number that ends at `i`: a magnitude, a
    unit, a currency. `ratio`: the unit says the number is not money;
    `glued_unit`: the unit is written against the number ("2.3pp", "82.4/100")."""
    t: Dict[str, Any] = {"mag": None, "mag_len": 0, "unit": False, "ratio": False, "glued_unit": False,
                         "currency": None, "currency_len": 0}
    j = i
    for g, key in _MAG_GLUED:
        nxt = _at(s, j + len(g))
        if s.startswith(g, j) and not _is_letter(nxt) and not _is_digit(nxt):
            t["mag"], t["mag_len"] = key, len(g)
            break
    if not t["mag"] and _is_space(_at(s, j)):
        for w, key in _MAG_WORDS:
            if s.startswith(w, j + 1) and not _is_letter(_at(s, j + 1 + len(w))):
                t["mag"], t["mag_len"] = key, 1 + len(w)
                break
    j += t["mag_len"]
    c = _at(s, j)
    if c in ("%", "‰", "×") and c != "" or (c == "x" and not _is_letter(_at(s, j + 1))):
        t["unit"] = t["ratio"] = True
        return t
    if not t["mag"]:
        # "2.3pp", "82.4/100": a unit written against the number.
        if s.startswith("pp", j) and not _is_letter(_at(s, j + 2)):
            t["unit"] = t["ratio"] = t["glued_unit"] = True
            return t
        after = _at(s, j + 4)
        if (s.startswith("/100", j) and not _is_digit(after) and not _is_letter(after)
                and not (after in (".", ",") and after != "" and _is_digit(_at(s, j + 5)))):
            t["unit"] = t["ratio"] = t["glued_unit"] = True
            return t
    k = j
    if _is_space(_at(s, k)):
        k += 1
    elif _at(s, k) not in _SYMBOL_CODE:
        return t
    if _at(s, k) == "%":
        t["unit"] = t["ratio"] = True
        return t
    de = 3 if (s.startswith("de", k) and _is_space(_at(s, k + 2))) else 0  # "64.567.890 de lei"
    at = k + de
    if de == 0:
        for code in _CODES:
            nxt = _at(s, at + 3)
            if s.startswith(code, at) and not _is_letter(nxt) and not _is_digit(nxt):
                t["currency"], t["currency_len"] = code, at + 3 - j
                return t
        nxt = _at(s, at + 1)
        # ("5 €$3": a symbol against another symbol is not this number's)
        if (_at(s, at) in _SYMBOL_CODE and not _is_letter(nxt) and not _is_digit(nxt)
                and nxt not in _SYMBOL_CODE):
            t["currency"], t["currency_len"] = _SYMBOL_CODE[_at(s, at)], at + 1 - j
            return t
    for w in _UNIT_WORDS:
        if s.startswith(w, at) and not _is_letter(_at(s, at + len(w))):
            t["unit"] = True
            t["ratio"] = w in _RATIO_WORDS
            return t
    return t


def _word_before(s: str, at: int) -> str:
    j = at
    while j > 0 and _is_space(s[j - 1]):
        j -= 1
    i = j
    while i > 0 and not _is_space(s[i - 1]) and s[i - 1] not in ("(", "\n"):
        i -= 1
    return _TRAILING_PUNCT.sub("", s[i:j].lower())


def _words_before(s: str, at: int) -> List[str]:
    """The (up to) three words before `at`, nearest first."""
    out: List[str] = []
    j = at
    for _ in range(3):
        while j > 0 and _is_space(s[j - 1]):
            j -= 1
        i = j
        while i > 0 and not _is_space(s[i - 1]) and s[i - 1] not in ("(", "\n"):
            i -= 1
        if i == j:
            break
        out.append(_TRAILING_PUNCT_STOP.sub("", s[i:j].lower()))
        if i > 0 and s[i - 1] in ("(", "\n"):
            break
        j = i
    return out


def _starts_with_any(word: str, stems: Sequence[str]) -> bool:
    bare = word[:-1] if word.endswith(".") else word
    for st in stems:
        if bare == st or (len(st) >= 3 and bare.startswith(st)) or word == st + ".":
            return True
    return False


def _code_like(s: str, k: int) -> bool:
    """Three ASCII capitals standing as a word at `k` — the shape of an ISO
    currency code ("CAD", "AUD", "MXN"), whichever it is."""
    if k < 0 or k + 3 > len(s):
        return False
    for c in s[k:k + 3]:
        if not ("A" <= c <= "Z"):
            return False
    after, before = _at(s, k + 3), _at(s, k - 1)
    return not (_is_letter(after) or _is_digit(after) or _is_letter(before) or _is_digit(before))


def _figure_follows(s: str, k: int) -> bool:
    """Does a number start at `k`, after at most one space and one sign?"""
    if _is_space(_at(s, k)):
        k += 1
    if _at(s, k) in _SIGNS and _at(s, k) != "":
        k += 1
    return _is_digit(_at(s, k))


def _read_head(s: str, i: int, floor: int) -> Dict[str, Any]:
    """A currency written BEFORE the number that starts at `i` (never
    reaching back past `floor`, the end of the previous figure). `stays`:
    where a code or bare symbol starts that is read but NOT this figure's to
    move (after a rate word; a "$" the reply itself names another dollar for)."""
    j, sign = i, ""
    if j > floor and _at(s, j - 1) in _SIGNS:
        sign = s[j - 1]
        j -= 1
    k = j
    if k > floor and _is_space(_at(s, k - 1)):
        k -= 1
    if k > floor and _at(s, k - 1) in _SYMBOL_CODE:
        b = _at(s, k - 2)
        # "US$", "C$", "$B$2": a symbol with a letter, a digit or another
        # symbol before it is not this standard's to name.
        if _is_letter(b) or _is_digit(b) or b in _SYMBOL_CODE:
            return {"currency": None, "start": i, "sign": "", "evidence_only": True, "stays": None}
        # "CAD $7.5M": the reply itself says which dollar — it is not named USD.
        if _is_space(b) and _code_like(s, k - 5):
            return {"currency": None, "start": i, "sign": "", "evidence_only": True, "stays": k - 1}
        return {"currency": _SYMBOL_CODE[s[k - 1]], "start": k - 1, "sign": sign, "evidence_only": False,
                "stays": None}
    if k - 3 >= floor:
        code = s[k - 3:k]
        before = _at(s, k - 4)
        if code in _CODES and not _is_letter(before) and not _is_digit(before) and before != "/":
            if _word_before(s, k - 3) in _RATE_WORDS:
                return {"currency": None, "start": i, "sign": "", "evidence_only": True, "stays": k - 3}
            return {"currency": code, "start": k - 3, "sign": sign, "evidence_only": False, "stays": None}
    return {"currency": None, "start": i, "sign": "", "evidence_only": False, "stays": None}


def _loose_head(s: str, st: int, floor: int) -> Optional[int]:
    """Where a product code or a bare symbol starts that still stands BEFORE
    the number at `st` with something the strict reader does not cross in
    between (two spaces, a tab, an en dash, a bracket, emphasis marks) — or
    None. It is never moved; it is COUNTED, so the report says what the
    reader still sees."""
    k, n = st, 0
    while k > floor and n < 8 and s[k - 1] in _LOOSE_BETWEEN:
        k -= 1
        n += 1
    if k > floor and _at(s, k - 1) in _SYMBOL_CODE:
        b = _at(s, k - 2)
        if _is_letter(b) or _is_digit(b) or (b in _SYMBOL_CODE and b != ""):
            return None
        return k - 1
    if k - 3 >= floor and s[k - 3:k] in _CODES:
        before = _at(s, k - 4)
        if not _is_letter(before) and not _is_digit(before) and before != "/":
            return k - 3
    return None


def _at_line_start(s: str, at: int) -> bool:
    i = at
    while i > 0 and s[i - 1] != "\n":
        i -= 1
    return all(c in _JS_SPACE_SET or c in "#>*•-" for c in s[i:at])


def _outline_follows(rest: str) -> bool:
    """`^[.)]?\\s+\\p{L}` — "2.1 Lichiditate", "1.2. Venituri"."""
    n = 1 if rest[:1] in (".", ")") and rest[:1] != "" else 0
    m = n
    while m < len(rest) and rest[m] in _JS_SPACE_SET:
        m += 1
    return m > n and m < len(rest) and rest[m].isalpha()


def _sentence_ends(rest: str) -> bool:
    """`^(?:\\s*$|\\s*\\n|\\s+\\p{Lu}(?!\\p{Lu}))` — the text ends, the line
    ends, or a new sentence starts: a capitalised WORD, not an acronym or a
    code ("4,58 mil. CAD", "2,3 mil. EBITDA" go on)."""
    n = 0
    while n < len(rest) and rest[n] in _JS_SPACE_SET:
        n += 1
    if n == len(rest) or "\n" in rest[:n]:
        return True
    return (n >= 1 and unicodedata.category(rest[n]) == "Lu"
            and not (n + 1 < len(rest) and unicodedata.category(rest[n + 1]) == "Lu"))


def _full_end(it: Dict[str, Any]) -> int:
    """Where the figure ends: its number, its magnitude, its code."""
    return it["e"] + it["tail"]["mag_len"] + it["tail"]["currency_len"]


def _own_start(s: str, it: Dict[str, Any]) -> int:
    """Where the figure starts: its code (when one is written before it), its
    sign — a "-" written against the digit before it is a dash, not a sign."""
    st = it["head"]["start"] if it["head"]["currency"] else it["s"]
    if st > it["floor"] and _at(s, st - 1) in _SIGNS and not _is_digit(_at(s, st - 2)):
        st -= 1
    return st


def _connective(gap: str, opener: bool) -> Optional[str]:
    """What stands between two numbers when they may be ONE expression:
    "group" (a space or an apostrophe: "64 567 890", "1'234'567"), "dash" (a
    range: "1.5-2.5M", "10 – 12"), "list" (a comma, a joining word:
    "40 și 55 milioane") — or None: they are two sentences' worth apart."""
    g = gap.replace(NBSP, " ").replace(" ", " ").lower()
    # (nothing in between: the second number's sign is all there is)
    if g == "":
        return "dash"
    if g == " " or g in _APOSTROPHES:
        return "group"
    for d in _DASH_CHARS:
        if g in (d, " " + d + " ", " " + d, d + " "):
            return "dash"
    if g in (",", ", ", ";", "; "):
        return "list"
    for w in _JOIN_WORDS:
        if g in (" " + w + " ", ", " + w + " ", "; " + w + " "):
            return "list"
    # "la" joins a range only after an opener ("de la 1.5 la 2.5 mil."); on
    # its own it is weak: "RON 5.2M la 31.12" is an amount and a date.
    if g == " la ":
        return "list" if opener else "weak"
    return None


def _mag_like_at(s: str, k: int) -> bool:
    """Is the word at `k` a magnitude the standard does not print — also
    after the "de" Romanian puts before one ("120 de mii", "55 de milioane")?"""
    if s.startswith("de", k) and _is_space(_at(s, k + 2)):
        k += 3
    m = k
    while _is_letter(_at(s, m)):
        m += 1
    return s[k:m].lower() in _MAG_LIKE


def _has_magnitude(s: str, it: Dict[str, Any]) -> bool:
    """Does this number carry a magnitude of any spelling — one the standard
    prints, a word, or a letter the standard does not read ("14.30m")?"""
    if not it["ok"] or it["tail"]["mag"] or (it["tail"]["unit"] and not it["tail"]["ratio"]):
        return True
    j = it["e"]
    return _is_space(_at(s, j)) and _mag_like_at(s, j + 1)


def _separate(it: Dict[str, Any]) -> bool:
    """A figure that stands on its own: its own currency, or a ratio's unit."""
    return bool(it["ok"] and (it["head"]["currency"] or it["head"]["evidence_only"]
                              or it["tail"]["currency"] or it["tail"]["ratio"]))


def _amount_ends(s: str, items: List[Dict[str, Any]], i: int, joined_right: bool) -> bool:
    """Does the amount a code-first number opens provably END at that number
    (and its magnitude)? Only then is the code moved behind it. It does NOT
    when the number goes on ("64 567 890", "1'234'567"), when a magnitude the
    standard does not print follows ("4.58 mil", "1 milion", "4.58 M"), when
    another currency is named beside it ("$7.5M CAD"), or when the next
    number belongs to the same expression — a range or a list that shares
    the code and, usually, the magnitude ("EUR 1.5-2.5M", "EUR 40 și 55
    milioane")."""
    it = items[i]
    j = it["e"] + it["tail"]["mag_len"]
    c = _at(s, j)
    if c == "":
        # The segment ends at the amount: closed, unless what follows is a
        # span this pass never enters (the amount runs into it).
        if joined_right:
            return False
    elif c in _APOSTROPHES and _is_digit(_at(s, j + 1)):
        return False
    elif c in _DASH_CHARS:
        # A hyphen against a word is a compound ("EUR 5-year", "RON 3-lunar");
        # an en / em dash there is a break in the sentence.
        if c == "-" and _is_letter(_at(s, j + 1)):
            return False
    elif c == "/":
        # "RON 5.2M/an" is per year. "RON 5M/6M" is two amounts under one
        # code, "EUR 2.5M/USD 2.7M" two currencies: neither ends at the slash.
        if not _is_letter(_at(s, j + 1)) or _code_like(s, j + 1):
            return False
    elif not _is_space(c) and c not in _CLOSERS and c not in _JS_SPACE_SET:
        return False
    if _is_space(c):
        d = _at(s, j + 1)
        if _is_digit(d) or (d in _SYMBOL_CODE and d != ""):
            return False
        if d == "(" and _code_like(s, j + 2) and _at(s, j + 5) == ")":
            return False
        if _is_letter(d):
            if _code_like(s, j + 1):
                return False
            if _mag_like_at(s, j + 1):
                return False
    if i + 1 < len(items):
        nx = items[i + 1]
        opener = _word_before(s, _own_start(s, it)) in _RANGE_OPENERS
        kind = _connective(s[j:_own_start(s, nx)], opener)
        if kind in ("dash", "group"):
            return False
        if kind == "list" and (opener or not _separate(nx)):
            return False
        if kind == "weak" and not _separate(nx) and _has_magnitude(s, nx):
            return False
    return True


def _number_before_code(s: str, q: int) -> bool:
    """Does a NUMBER — bare, or with a magnitude of any spelling ("31.12",
    "3M", "31.12m", "0.19 milioane") — stand right before the code at `q`?
    Then the code has two possible owners."""
    i = q
    if i > 0 and _is_space(s[i - 1]):
        i -= 1
    de = s[max(0, i - 3):i] == " de"                # "0.19 milioane de RON 5"
    if de:
        i -= 3
    end = i
    while i > 0 and end - i < 10 and (_is_letter(s[i - 1]) or s[i - 1] == "."):
        i -= 1
    word = s[i:end].lower()
    while word.endswith("."):
        word = word[:-1]
    spaced = bool(word) and i > 0 and _is_space(s[i - 1])
    if spaced:
        i -= 1
    if not _is_digit(_at(s, i - 1)):
        return False
    if word == "":
        return not de
    if word in _MAG_LIKE or word in _MONEY_WORDS:
        return True
    # A letter or two written AGAINST the digits ("31.12m", "4.58T") is a
    # magnitude of some spelling; a short WORD after a space ("și", "la") is not.
    return not spaced and not de and len(word) <= 2


def _freeze_from(s: str, items: List[Dict[str, Any]], i: int) -> None:
    """Leave the expression that starts at item `i` exactly as written: the
    item and every number the same expression goes on to."""
    last = i
    while last + 1 < len(items) and last - i < 8:
        nx = items[last + 1]
        kind = _connective(s[_full_end(items[last]):_own_start(s, nx)], True)
        if kind is None or (kind in ("list", "weak") and _separate(nx)):
            break
        last += 1
    for k in range(i, last + 1):
        items[k]["frozen"] = True
    items[i]["open_token"] = s[_own_start(s, items[i]):_full_end(items[last])]


# THE RUN-TIME PROOF's own reading of a text (never the rule set's tables: a
# rule that reads "Bn" as a million must not be able to prove itself).
_PROOF_MARKS = frozenset("-−+%‰×")
_PROOF_GLUED = (("Bn", "B"), ("bn", "B"), ("K", "K"), ("k", "K"), ("M", "M"), ("B", "B"))
_PROOF_WORDS = (("mil.", "M"), ("mld.", "B"), ("mii", "K"))
_PROOF_CODES = ("RON", "EUR", "USD")
_PROOF_SYMBOLS = {"€": "EUR", "$": "USD"}


def _structure(s: str) -> Tuple[str, Tuple[Tuple[str, str, str], ...]]:
    """What must not change besides the digits: every sign and ratio mark, in
    order; and for each number, in order, the magnitude beside it, the
    currency written before it and the currency written after it."""
    marks = "".join(c for c in s if c in _PROOF_MARKS)
    figures: List[Tuple[str, str, str]] = []
    for m in _NUM.finditer(s):
        st, j = m.start(), m.end()
        mag = ""
        for g, key in _PROOF_GLUED:
            nxt = _at(s, j + len(g))
            if s.startswith(g, j) and not _is_letter(nxt) and not _is_digit(nxt):
                mag, j = key, j + len(g)
                break
        if not mag and _is_space(_at(s, j)):
            for w, key in _PROOF_WORDS:
                if s.startswith(w, j + 1) and not _is_letter(_at(s, j + 1 + len(w))):
                    mag, j = key, j + 1 + len(w)
                    break
        if _is_space(_at(s, j)):
            j += 1
        after = ""
        nxt = _at(s, j + 3)
        if s[j:j + 3] in _PROOF_CODES and not _is_letter(nxt) and not _is_digit(nxt):
            # (a code after a plain year and right before a figure is the figure's)
            if mag or not _YEAR.fullmatch(m.group(0)) or not _figure_follows(s, j + 3):
                after = s[j:j + 3]
        elif _at(s, j) in _PROOF_SYMBOLS:
            nxt = _at(s, j + 1)
            if not _is_letter(nxt) and not _is_digit(nxt):
                after = _PROOF_SYMBOLS[s[j]]
        b = st
        if b > 0 and s[b - 1] in _SIGNS:
            b -= 1
        if b > 0 and _is_space(s[b - 1]):
            b -= 1
        before = ""
        if b > 0 and s[b - 1] in _PROOF_SYMBOLS:
            before = _PROOF_SYMBOLS[s[b - 1]]
        elif b >= 3 and s[b - 3:b] in _PROOF_CODES:
            pre = _at(s, b - 4)
            if not _is_letter(pre) and not _is_digit(pre):
                before = s[b - 3:b]
        figures.append((mag, before, after))
    return marks, tuple(figures)


def _structure_held(before: str, after: str) -> bool:
    """THE RUN-TIME PROOF beyond the digits: the signs and ratio marks are
    the same characters in the same order; every number keeps its magnitude;
    and a currency is bound to the number it was bound to — written before
    it or after it, never beside another one."""
    marks_a, figures_a = _structure(before)
    marks_b, figures_b = _structure(after)
    if marks_a != marks_b or len(figures_a) != len(figures_b):
        return False
    for (mag_a, pre_a, post_a), (mag_b, pre_b, post_b) in zip(figures_a, figures_b):
        if mag_a != mag_b:
            return False
        if sorted(c for c in (pre_a, post_a) if c) != sorted(c for c in (pre_b, post_b) if c):
            return False
    return True


def _normalise_segment(s: str, lang: str, left_out: List[Tuple[str, str]],
                       anchors: Sequence[float], joined: Tuple[bool, bool] = (False, False)) -> Tuple[str, int]:
    """`joined`: a span this pass never enters stands right before / right
    after `s` AND meets it with a digit (a date, a clock time) — so a number
    at that edge of `s` may be a piece of it."""
    left: List[Tuple[str, str]] = []
    fd = _notation(lang)["fd"]
    native = STANDARD["languages"][lang]
    items: List[Dict[str, Any]] = []
    floor = 0
    for m in _NUM.finditer(s):
        st, en = m.start(), m.end()
        tok = m.group(0)
        prev = _at(s, st - 1)
        head = _read_head(s, st, floor)
        glued = _is_letter(prev) or (prev in ("_", "#", "/", "\\", "^") and prev != "")
        tail = _read_tail(s, en)
        nxt = _at(s, en)
        ok = (not glued
              and not (_is_letter(nxt) and not tail["mag"] and not tail["glued_unit"]
                       and not (nxt == "x" and not _is_letter(_at(s, en + 1))))
              # ("31/12" and "1/2" are not figures; "1,250.50/lună" is one, per month)
              and (nxt != "/" or tail["glued_unit"] or _is_letter(_at(s, en + 1))) and nxt != "^")
        # A number that TOUCHES a span this pass never enters is a piece of
        # it ("1,234:99" holds the clock time "34:99"; "01.02.1.234" a date):
        # not a number of its own.
        if (joined[0] and s[:st] in ("", ".", ",")) or (joined[1] and s[en:] in ("", ".", ",")):
            ok = False
        shape = _shape(tok, lang)
        if shape == "not_a_number":
            ok = False
        # A CODE BETWEEN TWO NUMBERS ("31.12 RON 5.2M", "3M RON 5.2M") has two
        # possible owners. After a plain year it is the next figure's ("În
        # 2025 RON 64.5M"); otherwise neither number may take it as evidence
        # and neither is touched.
        contested = False
        if tail["currency"] and _figure_follows(s, en + tail["mag_len"] + tail["currency_len"]):
            if not tail["mag"] and not head["currency"] and _YEAR.fullmatch(tok):
                tail = dict(tail, currency=None, currency_len=0)
            else:
                contested = True
        items.append({
            "s": st, "e": en, "tok": tok, "shape": shape,
            "head": head, "tail": tail, "ok": ok, "floor": floor,
            "contested": contested, "frozen": False, "open_token": None,
            # Something beside the number says it is a figure.
            "adjacent": bool(head["currency"] or head["evidence_only"] or tail["currency"]
                             or tail["unit"] or tail["mag"]),
        })
        floor = en + tail["mag_len"] + tail["currency_len"]

    # WHAT IS LEFT EXACTLY AS WRITTEN, as one expression (`open_amount`):
    for i, it in enumerate(items):
        # … a code between two numbers, seen from the first …
        if it["contested"] and not it["frozen"]:
            hi = min(i + 1, len(items) - 1)
            it["frozen"] = items[hi]["frozen"] = True
            it["open_token"] = s[_own_start(s, it):_full_end(items[hi])]
        # … and from the second: only a dash in between ("31.12-RON 5.2M"),
        # or a number with a magnitude the standard does not read right
        # before the code ("31.12m USD 5", "0.19 milioane USD 1.5M").
        if i > 0 and it["head"]["currency"] and not it["frozen"]:
            prev = items[i - 1]
            pe, p = _full_end(prev), _own_start(s, it)
            year = (prev["e"] == pe and not prev["head"]["currency"] and bool(_YEAR.fullmatch(prev["tok"]))
                    and s[pe:it["head"]["start"]] in (" ", NBSP, "\u202f"))
            if (p == pe or (p - pe == 1 and s[pe] in _DASH_CHARS)
                    or (not year and _number_before_code(s, it["head"]["start"]))):
                it["frozen"] = True
                if not prev["frozen"]:
                    prev["frozen"] = True
                    prev["open_token"] = s[_own_start(s, prev):_full_end(it)]
                elif it["open_token"] is None and prev["open_token"] is None:
                    it["open_token"] = s[p:_full_end(it)]
    for i, it in enumerate(items):
        # … a code-first amount that is not read to its end.
        if (not it["frozen"] and it["ok"] and it["head"]["currency"] and not it["tail"]["currency"]
                and not it["tail"]["unit"] and not _amount_ends(s, items, i, joined[1])):
            _freeze_from(s, items, i)

    # A range: "1.2-1.5%", "între 8.5 și 13.2%" — the first number takes the
    # second one's evidence. The joiner word counts only after a range opener.
    for a, b in zip(items, items[1:]):
        if a["frozen"] or b["frozen"]:
            continue
        between = s[a["e"]:b["s"]]
        dash = between in _DASHES
        word = between in _RANGE_JOINERS and _word_before(s, a["s"]) in _RANGE_OPENERS
        if (dash or word) and b["adjacent"] and not a["adjacent"] and not a["tail"]["mag"]:
            a["adjacent"] = True

    out, rewritten = s, 0
    for it in reversed(items):
        tok, head, tail = it["tok"], it["head"], it["tail"]
        if it["frozen"]:
            # Left ENTIRELY as written. A lone group inside it is still named:
            # it has two readings wherever it stands.
            if it["ok"] and it["shape"] == "single_group":
                left.append((tok, "single_group"))
            if it["open_token"] is not None:
                left.append((it["open_token"], "open_amount"))
            continue
        if not it["ok"]:
            if it["shape"] not in ("native_or_plain", "not_a_number"):
                left.append((tok, "glued"))
            continue
        # A single three-digit group has two values: left ENTIRELY as written.
        if it["shape"] == "single_group":
            left.append((tok, "single_group"))
            continue
        ws = head["start"] if head["currency"] else it["s"]
        if ws > 0 and s[ws - 1] in _SIGNS:
            ws -= 1
        before = _word_before(s, ws)
        num, num_changed = tok, False
        if it["shape"] == "foreign_full":
            # A run of groups with no decimal part ("28,281,291", "401,404,408")
            # reads the same as a LIST (accounts 28, 281 and 291): it is a
            # figure only with something beside it, or a handed figure.
            list_like = bool(_LIST_LIKE.fullmatch(tok)) or fd not in tok
            if (not list_like or it["adjacent"]
                    or (not _starts_with_any(before, _REF_STEMS)
                        and _anchored_by(anchors, _reading(tok, fd)))):
                num, num_changed = _swap(tok, lang), True
            else:
                left.append((tok, "bare_groups"))
                continue
        elif it["shape"] == "foreign_decimal":
            a, b = tok.split(fd)
            if len(a) > 1 and a[0] == "0":
                left.append((tok, "leading_zero"))
                continue
            if it["adjacent"]:
                num, num_changed = _swap(tok, lang), True
            else:
                dd, mm = float(a), float(b)
                day_month = len(b) == 2 and 1 <= dd <= 31 and 1 <= mm <= 12
                clock = len(b) == 2 and dd <= 24 and mm <= 59
                if _starts_with_any(before, _REF_STEMS):
                    left.append((tok, "reference"))
                    continue
                if _at_line_start(s, it["s"]) and _outline_follows(s[it["e"]:]):
                    left.append((tok, "outline"))
                    continue
                if (day_month or clock) and any(w in _DATE_WORDS for w in _words_before(s, ws)):
                    left.append((tok, "possible_date"))
                    continue
                # A handed figure proves a value-unique token IS a figure —
                # never a two-digit DD.MM / HH.MM, never a pair of years,
                # never a single decimal.
                two_digit_date = len(a) == 2 and (day_month or clock)
                years = bool(_YEAR.fullmatch(a)) and bool(_YEAR.fullmatch(b))
                proved = a == "0" or (len(b) >= 2 and not two_digit_date and not years
                                      and _anchored_by(anchors, _reading(tok, fd)))
                if proved:
                    num, num_changed = _swap(tok, lang), True
                else:
                    left.append((tok, "bare_decimal"))
                    continue

        two = bool(head["currency"] and tail["currency"])
        currency = head["currency"] or tail["currency"]
        mag_len, cur_len = tail["mag_len"], tail["currency_len"]
        # A year after a code ("EUR 2025") is not an amount.
        if head["currency"] and not num_changed and not tail["mag"] and _YEAR.fullmatch(tok):
            left.append((tok, "possible_year"))
            continue
        mag, mag_changed = "", False
        mag_src = out[it["e"]:it["e"] + mag_len]
        if tail["mag"]:
            want = native["magnitude_joiner"] + native["magnitudes"][tail["mag"]]
            if mag_src != want and mag_src.replace(NBSP, " ") != want.replace(NBSP, " "):
                if before in _TENOR_WORDS:
                    left.append((tok + mag_src, "tenor"))
                    continue
                if num_changed or currency:
                    mag, mag_changed = want, True
                else:
                    mag = mag_src
                    left.append((tok + mag_src, "bare_magnitude"))
            else:
                mag = mag_src
        if two:
            left.append((out[head["start"]:it["e"] + mag_len + cur_len], "two_currencies"))
        tail_src = out[it["e"] + mag_len:it["e"] + mag_len + cur_len]
        tail_want = (native["code_joiner"] + tail["currency"]) if tail["currency"] else ""
        tail_changed = (bool(tail["currency"]) and not two
                        and tail_src.replace(NBSP, " ") != " " + tail["currency"])
        # A code before a percentage or a multiple ("EUR 30%") is not that
        # number's denomination.
        move_head = bool(head["currency"]) and not two and not tail["unit"]
        # A CODE THAT STAYS BEFORE THE FIGURE is counted (`code_before`), so
        # the report says what the reader still sees: one that is not this
        # number's to move, one after a rate word, one the strict reader does
        # not reach ("RON  5", "RON (5)", "**RON** 5").
        stays: Optional[int] = None
        if head["currency"]:
            stays = None if (move_head or two) else head["start"]
        elif head["stays"] is not None:
            stays = head["stays"]
        elif not head["evidence_only"]:
            stays = _loose_head(s, it["s"], it["floor"])
        if stays is not None:
            left.append((s[stays:it["e"]], "code_before"))
        if not (num_changed or mag_changed or tail_changed or move_head):
            continue
        frm = head["start"] if move_head else it["s"]
        to = it["e"] + mag_len + (cur_len if (tail["currency"] and not two) else 0)
        piece = ((head["sign"] if move_head else "") + num + mag
                 + ((native["code_joiner"] + head["currency"]) if move_head
                    else tail_want if tail_changed
                    else tail_src if (tail["currency"] and not two) else ""))
        # One stop, not two, where "mil." ends a sentence ("4.58M." → "4,58 mil.").
        stop = 1 if (mag.endswith(".") and mag_changed and _at(out, to) == "."
                     and not _is_digit(_at(out, to + 1)) and piece.endswith(".")) else 0
        # English text: "… 2,3 mil. The" — the abbreviation's stop was the
        # sentence's too, and "M" has none.
        lost_stop = "." if (lang == "en" and mag_changed and mag_src.endswith(".")
                            and not tail["currency"] and _sentence_ends(out[it["e"] + mag_len:])) else ""
        out = out[:frm] + piece + lost_stop + out[to + stop:]
        rewritten += 1

    # THE RUN-TIME PROOF: no digit added, dropped or reordered; no sign, no
    # ratio mark, no magnitude and no currency binding changed.
    if _digits_of(out) != _digits_of(s) or not _structure_held(s, out):
        left_out.append((s[:40], "proof_failed"))
        return s, 0
    left_out.extend(reversed(left))
    return out, rewritten


def normalise_figures(text: Any, lang: str,
                      anchors: Sequence[float] = ()) -> Tuple[Any, Dict[str, Any]]:
    """`text` — prose written in `lang` ('ro' | 'en') — with every figure
    PROVEN to be in the other language's notation rewritten into `lang`'s.

    Returns ``(text, report)``; the report is ``{"rewritten": n, "left":
    [(token, reason), …]}``. Anything that is not a non-empty string, and
    any language outside :data:`FIGURE_LANGUAGES`, comes back as it was
    given. Never raises.
    """
    left: List[Tuple[str, str]] = []
    report: Dict[str, Any] = {"rewritten": 0, "left": left}
    if not isinstance(text, str) or not text or lang not in FIGURE_LANGUAGES:
        return text, report
    try:
        handed = [float(a) for a in anchors
                  if isinstance(a, (int, float)) and not isinstance(a, bool) and math.isfinite(a)]
        parts: List[str] = []
        rewritten, at = 0, 0
        for m in _PROTECTED.finditer(text):
            seg, n = _normalise_segment(text[at:m.start()], lang, left, handed,
                                        (_is_digit(_at(text, at - 1)) and at > 0, _is_digit(_at(text, m.start()))))
            parts.append(seg)
            parts.append(m.group(0))
            rewritten += n
            at = m.end()
        seg, n = _normalise_segment(text[at:], lang, left, handed,
                                    (_is_digit(_at(text, at - 1)) and at > 0, False))
        parts.append(seg)
        out = "".join(parts)
        # The proof again, over the whole text (each segment already passed).
        if _digits_of(out) != _digits_of(text):
            return text, {"rewritten": 0, "left": [(text[:40], "proof_failed")]}
        # NEVER HALF A TEXT. A lone three-digit group ("386,102") is read by
        # the notation of the figures around it. Rewriting those and leaving
        # it would make it the one token still in the other notation — read
        # a thousand times smaller, or larger, than the model wrote it. So a
        # text that holds one is returned whole, exactly as it was written:
        # every figure in it still reads the way it did.
        if rewritten + n and any(why == "single_group" for _token, why in left):
            left.append(("", "text_held"))
            return text, report
        report["rewritten"] = rewritten + n
        return out, report
    except Exception:  # noqa: BLE001 — a formatter must never break the text it formats
        return text, {"rewritten": 0, "left": [("", "proof_failed")], "error": True}


def anchors_of(*blocks: Any) -> List[float]:
    """Every finite number in the blocks the model was HANDED (recursively
    through dicts, lists and tuples). A bool is not a number; a string is
    never parsed. Never raises."""
    out: List[float] = []
    seen = 0

    def walk(node: Any, depth: int) -> None:
        nonlocal seen
        seen += 1
        if seen > 50_000 or depth > 40:
            return
        if isinstance(node, bool) or node is None:
            return
        if isinstance(node, (int, float)):
            try:
                value = float(node)
            except (OverflowError, ValueError):
                return
            if math.isfinite(value):
                out.append(value)
            return
        if isinstance(node, dict):
            for v in node.values():
                walk(v, depth + 1)
        elif isinstance(node, (list, tuple)):
            for v in node:
                walk(v, depth + 1)

    try:
        for block in blocks:
            walk(block, 0)
    except Exception:  # noqa: BLE001
        return out
    return out


def normalise_narrate_result(payload: Any, lang: str,
                             anchors: Iterable[float] = ()) -> Tuple[Any, Dict[str, Any]]:
    """Run :func:`normalise_figures` over every NARRATIVE field of a parsed
    narrate payload — exactly the fields `numerals.guard_narrate_result`
    walks: ``briefing``, and each recommendation's ``title``, ``rationale``
    and ``actions[]``. Nothing else is read or changed
    (``estimated_ron_impact``, ``severity``, ``alerts`` …), a non-string is
    passed through, and the structure is never changed.

    Returns ``(payload, report)`` with ``rewritten`` (tokens), ``left``
    (tokens), ``left_by_reason`` (counts — never a token: this is what is
    logged), ``fields_checked`` and ``fields_changed``. Never raises: a
    field the pass cannot handle keeps the model's text.
    """
    report: Dict[str, Any] = {"rewritten": 0, "left": 0, "left_by_reason": {},
                              "fields_checked": 0, "fields_changed": 0}
    if not isinstance(payload, dict) or lang not in FIGURE_LANGUAGES:
        return payload, report
    try:
        handed = [a for a in anchors]
    except Exception:  # noqa: BLE001
        handed = []
    by_reason: Dict[str, int] = {}

    def run(value: Any) -> Any:
        if not isinstance(value, str):
            return value
        report["fields_checked"] += 1
        try:
            text, field = normalise_figures(value, lang, handed)
        except Exception:  # noqa: BLE001
            by_reason["proof_failed"] = by_reason.get("proof_failed", 0) + 1
            report["left"] += 1
            return value
        report["rewritten"] += field["rewritten"]
        for _token, reason in field["left"]:
            by_reason[reason] = by_reason.get(reason, 0) + 1
            report["left"] += 1
        if text != value:
            report["fields_changed"] += 1
        return text

    try:
        out = dict(payload)
        if "briefing" in out:
            out["briefing"] = run(out["briefing"])
        recs = out.get("recommendations")
        if isinstance(recs, list):
            new_recs: List[Any] = []
            for rec in recs:
                if not isinstance(rec, dict):
                    new_recs.append(rec)
                    continue
                rec = dict(rec)
                if "title" in rec:
                    rec["title"] = run(rec["title"])
                if "rationale" in rec:
                    rec["rationale"] = run(rec["rationale"])
                actions = rec.get("actions")
                if isinstance(actions, list):
                    rec["actions"] = [run(a) for a in actions]
                new_recs.append(rec)
            out["recommendations"] = new_recs
    except Exception:  # noqa: BLE001 — whatever the model returned, the caller keeps it
        return payload, {"rewritten": 0, "left": 0, "left_by_reason": {"proof_failed": 1},
                         "fields_checked": report["fields_checked"], "fields_changed": 0}
    report["left_by_reason"] = dict(sorted(by_reason.items()))
    return out, report


def currency_hint(lang: str, code: str) -> Optional[str]:
    """The figure-format sentence of the narration prompt for `lang`, citing
    `code` — or None for a language this module does not define (the caller
    keeps the hint it had).

    The example figures are :data:`HINT_EXAMPLES` — the product's own
    prints — joined to the display code AFTER the figure. The phrases
    "cite currency as '<CODE>'" and "pre-converted to <CODE>" are the ones
    the hint always carried.
    """
    examples = HINT_EXAMPLES.get(lang)
    if not examples or not isinstance(code, str) or not code:
        return None
    money = ", ".join("'%s %s'" % (examples[k], code) for k in ("whole", "decimals", "compact"))
    return (
        "Numbers in %s locale; cite currency as '%s' AFTER the figure — never before it, "
        "never a symbol, never 'lei' (e.g. %s); percentages, multiples and other ratios in the "
        "same locale (e.g. '%s', '%s'). Every monetary figure in `briefing_facts` is "
        "pre-converted to %s — do NOT re-convert."
        % (lang.upper(), code, money, examples["percent"], examples["multiple"], code)
    )
