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
  glued           "v2.1", "1.5T" — part of a word.
  proof_failed    the run-time proof below refused the result.

A handed figure is EVIDENCE that a value-unique token is a figure — it
never chooses between two readings.

RUN-TIME PROOF (every call): the digit sequence of the output equals the
input's, or the text is returned exactly as it came.

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
    "glued", "proof_failed",
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
_UNIT_WORDS = (
    "zile", "zi", "days", "day", "ani", "years", "year", "luni", "months", "month", "ori", "times",
    "pp", "p.p.", "puncte", "points", "milioane", "miliarde", "million", "millions", "billion",
    "billions", "thousand", "lei", "leu", "euro", "euros", "dolari", "dollars",
)
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
_TENOR_WORDS = ("robor", "euribor", "libor", "sofr", "ircc", "saron", "estr", "€str")

_SIGNS = ("-", "−", "+")
_DASHES = ("-", "–", " - ", " – ")

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
    return "native_or_plain"


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
    unit, a currency."""
    t: Dict[str, Any] = {"mag": None, "mag_len": 0, "unit": False, "currency": None, "currency_len": 0}
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
        t["unit"] = True
        return t
    k = j
    if _is_space(_at(s, k)):
        k += 1
    elif _at(s, k) not in _SYMBOL_CODE:
        return t
    if _at(s, k) == "%":
        t["unit"] = True
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
        if _at(s, at) in _SYMBOL_CODE and not _is_letter(nxt) and not _is_digit(nxt):
            t["currency"], t["currency_len"] = _SYMBOL_CODE[_at(s, at)], at + 1 - j
            return t
    for w in _UNIT_WORDS:
        if s.startswith(w, at) and not _is_letter(_at(s, at + len(w))):
            t["unit"] = True
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


def _read_head(s: str, i: int, floor: int) -> Dict[str, Any]:
    """A currency written BEFORE the number that starts at `i` (never
    reaching back past `floor`, the end of the previous figure)."""
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
            return {"currency": None, "start": i, "sign": "", "evidence_only": True}
        return {"currency": _SYMBOL_CODE[s[k - 1]], "start": k - 1, "sign": sign, "evidence_only": False}
    if k - 3 >= floor:
        code = s[k - 3:k]
        before = _at(s, k - 4)
        if code in _CODES and not _is_letter(before) and not _is_digit(before) and before != "/":
            if _word_before(s, k - 3) in _RATE_WORDS:
                return {"currency": None, "start": i, "sign": "", "evidence_only": True}
            return {"currency": code, "start": k - 3, "sign": sign, "evidence_only": False}
    return {"currency": None, "start": i, "sign": "", "evidence_only": False}


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
    """`^(?:\\s*$|\\s*\\n|\\s+\\p{Lu})` — the text ends, the line ends, or a
    new sentence starts."""
    n = 0
    while n < len(rest) and rest[n] in _JS_SPACE_SET:
        n += 1
    if n == len(rest) or "\n" in rest[:n]:
        return True
    return n >= 1 and unicodedata.category(rest[n]) == "Lu"


def _normalise_segment(s: str, lang: str, left_out: List[Tuple[str, str]],
                       anchors: Sequence[float]) -> Tuple[str, int]:
    left: List[Tuple[str, str]] = []
    fd = _notation(lang)["fd"]
    native = STANDARD["languages"][lang]
    items: List[Dict[str, Any]] = []
    floor = 0
    for m in _NUM.finditer(s):
        st, en = m.start(), m.end()
        prev = _at(s, st - 1)
        head = _read_head(s, st, floor)
        glued = _is_letter(prev) or (prev in ("_", "#", "/", "\\", "^") and prev != "")
        tail = _read_tail(s, en)
        nxt = _at(s, en)
        ok = (not glued
              and not (_is_letter(nxt) and not tail["mag"]
                       and not (nxt == "x" and not _is_letter(_at(s, en + 1))))
              and nxt != "/" and nxt != "^")
        items.append({
            "s": st, "e": en, "tok": m.group(0), "shape": _shape(m.group(0), lang),
            "head": head, "tail": tail, "ok": ok,
            # Something beside the number says it is a figure.
            "adjacent": bool(head["currency"] or head["evidence_only"] or tail["currency"]
                             or tail["unit"] or tail["mag"]),
        })
        floor = en + tail["mag_len"] + tail["currency_len"]
    # A range: "1.2-1.5%", "între 8.5 și 13.2%" — the first number takes the
    # second one's evidence. The joiner word counts only after a range opener.
    for a, b in zip(items, items[1:]):
        between = s[a["e"]:b["s"]]
        dash = between in _DASHES
        word = between in _RANGE_JOINERS and _word_before(s, a["s"]) in _RANGE_OPENERS
        if (dash or word) and b["adjacent"] and not a["adjacent"] and not a["tail"]["mag"]:
            a["adjacent"] = True

    out, rewritten = s, 0
    for it in reversed(items):
        tok, head, tail = it["tok"], it["head"], it["tail"]
        if not it["ok"]:
            if it["shape"] != "native_or_plain":
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
            list_like = bool(_LIST_LIKE.fullmatch(tok))
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

    # THE RUN-TIME PROOF: no digit added, dropped or reordered.
    if _digits_of(out) != _digits_of(s):
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
            seg, n = _normalise_segment(text[at:m.start()], lang, left, handed)
            parts.append(seg)
            parts.append(m.group(0))
            rewritten += n
            at = m.end()
        seg, n = _normalise_segment(text[at:], lang, left, handed)
        parts.append(seg)
        out = "".join(parts)
        # The proof again, over the whole text (each segment already passed).
        if _digits_of(out) != _digits_of(text):
            return text, {"rewritten": 0, "left": [(text[:40], "proof_failed")]}
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
