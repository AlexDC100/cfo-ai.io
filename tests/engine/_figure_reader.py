"""AN INDEPENDENT READER OF AMOUNTS — for the gate ai-figures-engine.

WHY (review 2026-10-05): the gate compared DIGITS and nothing else. A code
moved onto the wrong number ("EUR 1.5-2.5M" -> "1,5 EUR-2,5 mil."), a
magnitude read as another one ("4.58Bn" -> "4,58 mil."), a dropped sign: each
kept every digit, so each passed — and with such an output typed in as a
corpus case's `expected`, every law stayed green.

This module is NOT the normaliser and shares no table, pattern or function
with `engine.ai.figure_format` (a law reads this file's imports). It reads a
text into one record per number token:

    value x magnitude   the amount, read in the notation the text is in
    currency            the code or symbol bound to it — written before it,
                        after it, or inherited across a range ("EUR 40 și
                        55 milioane": both bounds are EUR, both are millions)
    sign, unit          "-" / "−"; "%", "x", "zile", …

and `changed_amounts(before, after, lang)` lists every token whose
EXPRESSION changed while its amount, currency, sign or unit did not stay the
same. An empty list is the only pass.

WHAT IT CANNOT SEE: a lone three-digit group has two values in any reader —
its expression never changes (the normaliser's own law), so it is never
compared here; a figure written in words; a currency this file does not
list; whether an amount is TRUE.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

NUM = re.compile(r"[0-9][0-9.,]*[0-9]|[0-9]")
SPC = "   "
CODE = r"RON|EUR|USD|CAD|AUD|GBP|CHF|HUF|MXN|JPY"
LETTER = "A-Za-zăâîșțĂÂÎȘȚ"
WORD_MAGNITUDES = {"mil.": 1e6, "mld.": 1e9, "mii": 1e3, "milioane": 1e6, "miliarde": 1e9,
                   "million": 1e6, "billion": 1e9, "thousand": 1e3, "milion": 1e6, "miliard": 1e9,
                   "mil": 1e6, "mld": 1e9, "trillion": 1e12, "mio": 1e6, "mln": 1e6}
GLUED_MAGNITUDES = {"Bn": 1e9, "bn": 1e9, "MM": 1e6, "mn": 1e6, "M": 1e6, "B": 1e9, "K": 1e3,
                    "k": 1e3, "m": 1e6, "T": 1e12}
RX_WORD_MAG = re.compile(
    r"[%s]?(mil\.|mld\.|milioane|miliarde|million|billion|thousand|trillion|milion|miliard|mii|mil|mld|mio|mln)(?![%s])"
    % (SPC, LETTER))
RX_GLUED_MAG = re.compile(r"[%s]?(Bn|bn|MM|mn|M|B|K|k|m|T)(?![%s0-9])" % (SPC, LETTER))
RX_CCY_AFTER = re.compile(r"[%s]?(?:de )?(%s|lei|euro|€|\$|£|¥)(?![%s0-9])" % (SPC, CODE, LETTER))
# (\Z, never $: Python's $ also matches before a final newline)
RX_CCY_BEFORE = re.compile(r"(?:(?<![A-Za-z0-9/])(%s)|([A-Za-z]{0,3})(€|\$|£|¥))[%s]?\Z" % (CODE, SPC))
RX_SIGN = re.compile(r"[-−+]\Z")
RX_YEAR = re.compile(r"(?:19|20)[0-9]{2}")
RX_FIGURE_NEXT = re.compile(r"[%s]?[-−+]?[0-9]" % SPC)
RX_UNIT = re.compile(r"[%s]?(%%|‰|×|x(?![A-Za-z])|(?:pp|p\.p\.|/100|zile|days|ori|ani|luni)(?![%s]))" % (SPC, LETTER))
JOIN_DASH = re.compile(r"[%s]?[-–—][%s]?\Z" % (SPC, SPC))
JOIN_WORD = re.compile(r",? (și|si|and|to|sau|or|până la|pana la) \Z")
JOIN_LA = " la "            # a range joiner only after an opener ("de la 5 la 7 milioane")
OPENERS = ("la", "între", "intre", "between", "from")
JOIN_LIST = re.compile(r", ?\Z")
SYMBOLS = {"€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY"}
WORDS = {"lei": "RON", "euro": "EUR"}


def read_number(token: str, notation: str) -> Optional[float]:
    """`token` as a number of `notation` ('en': 1,234.5 · 'ro': 1.234,5), or None."""
    group, decimal = (",", ".") if notation == "en" else (".", ",")
    g, d = re.escape(group), re.escape(decimal)
    if re.fullmatch(r"[0-9]{1,3}(?:%s[0-9]{3})+(?:%s[0-9]+)?" % (g, d), token) \
            or re.fullmatch(r"[0-9]+(?:%s[0-9]+)?" % d, token):
        return float(token.replace(group, "").replace(decimal, "."))
    return None


def expressions(text: str, first: str, second: str) -> List[Dict[str, Any]]:
    """One record per number token; `first` / `second`: the notations tried, in order."""
    out: List[Dict[str, Any]] = []
    for m in NUM.finditer(text):
        s, e = m.span()
        token = m.group(0)
        value = read_number(token, first)
        if value is None:
            value = read_number(token, second)
        after = text[e:]
        magnitude, j = 1.0, 0
        glued = RX_GLUED_MAG.match(after)
        word = RX_WORD_MAG.match(after)
        # A spaced letter ("4.58 M") is a magnitude only where no word one is read.
        if word:
            magnitude, j = WORD_MAGNITUDES[word.group(1)], word.end()
        elif glued:
            magnitude, j = GLUED_MAGNITUDES[glued.group(1)], glued.end()
        has_magnitude = bool(glued or word)
        code_after, end = None, e + j
        ca = RX_CCY_AFTER.match(after[j:])
        # A code after a plain year and right before a number is that number's
        # ("În 2025 RON 64.5M"): a year is not an amount.
        if ca and not has_magnitude and RX_YEAR.fullmatch(token) and RX_FIGURE_NEXT.match(after[j + ca.end():]):
            ca = None
        if ca:
            c = ca.group(1)
            code_after = SYMBOLS.get(c, WORDS.get(c, c))
            end = e + j + ca.end()
            # a second code right after ("$7.5M CAD", "7.5M USD (CAD)")
            second_code = re.match(r"[%s]\(?(%s)\)?(?![%s0-9])" % (SPC, CODE, LETTER), text[end:])
            if second_code:
                code_after = code_after + "|" + second_code.group(1)
        before = text[:s]
        sign, start = "", s
        sg = RX_SIGN.search(before)
        if sg:
            sign, start = sg.group(0), s - 1
            before = before[:-1]
        code_before = None
        cb = RX_CCY_BEFORE.search(before)
        if cb:
            if cb.group(1):
                code_before = cb.group(1)
            else:
                prefix, symbol = cb.group(2), cb.group(3)
                code_before = (prefix + symbol) if prefix and prefix != "US" else SYMBOLS[symbol]
                # "CAD $7.5M": a code right before the symbol names the currency
                named = re.search(r"(?<![A-Za-z0-9])(%s)[%s]\Z" % (CODE, SPC), before[:cb.start()])
                if named and not prefix:
                    code_before = named.group(1)
            start = cb.start()
            sg2 = RX_SIGN.search(text[:start])
            if sg2 and not sign:
                sign, start = sg2.group(0), start - 1
        unit = None
        um = RX_UNIT.match(after[j:])
        if um and not ca:
            unit = um.group(1)
        out.append({"token": token, "s": s, "e": e, "start": start, "end": end, "value": value,
                    "magnitude": magnitude, "has_magnitude": has_magnitude, "code_after": code_after,
                    "code_before": code_before, "sign": sign, "unit": unit})
    # A range or a list shares what its last term carries: the magnitude, the
    # currency, the unit — and the currency written before its first term.
    for a, b in zip(out, out[1:]):
        between = text[a["end"]:b["start"]]
        opened = text[:a["start"]].rstrip(SPC).lower().endswith(OPENERS)
        if (JOIN_DASH.match(between) or JOIN_WORD.match(between) or JOIN_LIST.match(between)
                or (between == JOIN_LA and opened)):
            closed = bool(a["code_after"])
            # Two terms that each carry a currency of their own are two amounts.
            own = bool((a["code_before"] or a["code_after"]) and (b["code_before"] or b["code_after"]))
            if not a["has_magnitude"] and not closed and not own and b["has_magnitude"]:
                a["magnitude"] = b["magnitude"]
            if not a["code_after"] and not a["code_before"] and (b["code_after"] or b["code_before"]):
                a["inherited"] = b["code_after"] or b["code_before"]
            # (a term with a unit of its own is a figure of its own: "RON 5M, 12% peste")
            if (not b["code_after"] and not b["code_before"] and not b["unit"]
                    and (a["code_before"] or a.get("inherited_before"))):
                b["inherited"] = b["inherited_before"] = a["code_before"] or a.get("inherited_before")
            if not a["unit"] and b["unit"] and not closed and not a["code_before"]:
                a["unit"] = b["unit"]
    for x in out:
        x["currency"] = x["code_after"] or x["code_before"] or x.get("inherited")
        x["amount"] = None if x["value"] is None else x["value"] * x["magnitude"]
        x["negative"] = x["sign"] in ("-", "−")
        x["plus"] = x["sign"] == "+"
    return out


def _plain(text: str) -> str:
    return text.replace(" ", " ").replace(" ", " ")


def changed_amounts(before: str, after: str, lang: str) -> List[str]:
    """Every number of `before` whose expression differs in `after` (text
    written in `lang`, so `before` is read in the OTHER notation first) and
    whose amount, currency, sign or unit is not what it was. Empty = held."""
    if before == after:
        return []
    foreign = "en" if lang == "ro" else "ro"
    xin = expressions(before, foreign, lang)
    xout = expressions(after, lang, foreign)
    if len(xin) != len(xout) or any(re.sub(r"[.,]", "", a["token"]) != re.sub(r"[.,]", "", b["token"])
                                    for a, b in zip(xin, xout)):
        return ["the number tokens differ: %d -> %d" % (len(xin), len(xout))]
    flags: List[str] = []
    for a, b in zip(xin, xout):
        was, now = _plain(before[a["start"]:a["end"]]), _plain(after[b["start"]:b["end"]])
        if was == now:
            continue
        same = (a["amount"] is not None and b["amount"] is not None
                and abs(a["amount"] - b["amount"]) <= 1e-9 * max(1.0, abs(a["amount"]))
                and a["currency"] == b["currency"] and a["negative"] == b["negative"]
                and a["plus"] == b["plus"] and a["unit"] == b["unit"])
        if not same:
            flags.append("%r = %s %s %s%s -> %r = %s %s %s%s" % (
                was, a["amount"], a["currency"], a["sign"] or "·", a["unit"] or "",
                now, b["amount"], b["currency"], b["sign"] or "·", b["unit"] or ""))
    return flags
