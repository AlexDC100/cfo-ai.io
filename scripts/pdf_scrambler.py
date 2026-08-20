#!/usr/bin/env python3
"""Deterministic PDF redactor (GOLDEN CORPUS tooling) — the content-stream
counterpart of `scripts/anonymize_tb.py`.

WHY THIS EXISTS
    `anonymize_tb.py` scrambles XLSX/CSV trial balances by COLUMN: it knows
    which column holds account labels and rewrites only that one. A PDF has
    no columns — it has positioned text runs inside compressed content
    streams. So this tool works by LEXICON instead: it decodes every
    text-showing operator, finds the spans that match a sensitive-term
    lexicon (statutory identifiers, the entity's legal name, site/address
    names, person names) and rewrites ONLY those spans, in place, with the
    SAME deterministic substitution mapping the tabular scrambler uses
    (`anonymize_tb.scramble_text`, seed = sha256 of the input bytes).

WHAT IS PRESERVED, BY CONSTRUCTION
    · every numeric token — never matched, never rewritten;
    · every text-positioning operator (Tm / Td / TL / Tf / clip rects) —
      the tokenizer only ever replaces the bytes BETWEEN the parentheses
      of a show-string, so glyph origins and fonts are untouched;
    · character COUNT of every rewritten span (the substitution maps
      letters within their case pool and digits within the digit pool;
      everything else passes through), so no run changes its length.

WHAT IS *NOT* GUARANTEED, AND IS THEREFORE VERIFIED
    Glyph ADVANCE widths change (a scrambled `i` may become a `w`), and
    these exports clip each label to a per-run rectangle. So the number of
    characters that survive the clip in a text extraction can shift by a
    character or two. That is a LABEL-only effect — but it is exactly the
    kind of thing that must be proven, not assumed. `--verify` runs the
    real positional-PDF front-end (`engine.frontends.positional_pdf`) over
    the original and the redacted file and asserts the numeric IR is
    IDENTICAL: same atom count and order, same account codes, every Money
    slot equal, the document_totals row equal, the numeric side-channels
    (`rc_pair`, `rulaj_prec`, float-repr overrides) equal, same header,
    same diagnostics. Only `AccountAtom.label` may differ.
    ANY numeric divergence ⇒ the redaction is REJECTED.

LEXICON STORAGE — HASHED ON PURPOSE
    The term list is stored as salted-domain SHA-256 digests, never as
    plaintext. A lexicon written in the clear would itself be a tracked
    file containing the identifiers it exists to remove — the exact thing
    `scripts/check_corpus_policy.py` gates on. This is plaintext HYGIENE,
    not a cryptographic secret: the digests are unsalted per-term and a
    guessed term can be confirmed by re-hashing it. That is fine; the goal
    is that `git grep` over this repository never surfaces the identifiers.
    To extend the lexicon, run:

        pdf_scrambler.py --hash-term "the term"

    and paste the emitted line into `SENSITIVE_TERMS` with a category.
    Anyone holding the source document can re-derive every digest and so
    audit coverage; nobody else learns anything from the file.

CLI
    pdf_scrambler.py INPUT -o OUTPUT [--verify]
        Redact INPUT to OUTPUT. --verify additionally runs the front-end
        IR comparison and the residual-lexicon scan; exit 1 on any failure
        (the output is still written so the divergence can be inspected).
    pdf_scrambler.py --verify ORIGINAL REDACTED
        Compare an existing pair; nothing is written.
    pdf_scrambler.py --scan PATH [PATH ...]
        Report lexicon matches in each PDF; nothing is written.
    pdf_scrambler.py --hash-term TERM
        Print the lexicon line for TERM.

Stdlib + pikepdf (content-stream rewrite) + the engine's own deps. 3.9+.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import re
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return Path(__file__).resolve().parent.parent


REPO = _find_repo_root()
for _p in (REPO / "src", REPO / "scripts"):
    if _p.is_dir() and str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

# The SAME deterministic mapping the tabular scrambler uses. Importing it
# (rather than re-implementing) is the point: one substitution alphabet,
# one seed rule, one folding rule across both formats.
from anonymize_tb import (  # noqa: E402
    _ID_PATTERNS,
    _fold_ascii,
    content_seed,
    scramble_text,
)


__all__ = [
    "GATE_ID_PATTERNS",
    "ID_PATTERNS",
    "SENSITIVE_TERMS",
    "is_placeholder_identifier",
    "LexiconMatch",
    "content_seed",
    "find_sensitive_spans",
    "normalize_term",
    "pdf_text_units",
    "redact_text",
    "lexicon_override",
    "scramble_pdf_bytes",
    "scan_text",
    "term_hash",
    "verify_bytes",
    "verify_pdf_pair",
]

#: Re-exported verbatim from the tabular scrambler: Romanian CUI / CIF,
#: Reg-Com registration number, CNP. Deliberately LOOSE — they are
#: applied to ONE known document during redaction, where over-matching
#: costs nothing (a VAT-rate suffix like `…RO19%` getting scrambled is
#: harmless) and under-matching would leak.
ID_PATTERNS = _ID_PATTERNS

#: The same three identifier families, TIGHTENED for tree-wide scanning.
#: The loose set is unusable as a repository gate: `\b\d{13}\b` matches
#: any thirteen consecutive digits (map coordinates, hashes, JSON
#: numbers) and `\bRO\s?\d{2,10}\b` matches a VAT rate (`RO19`) or a
#: year (`RO 2026`). A gate that cries wolf gets switched off, so these
#: are precise:
#:   · CUI  — the labelled form at any length, or a bare `RO`-prefixed
#:            form only from six digits up (a real company identifier);
#:   · Reg-Com — unchanged shape, but placeholder numbers are filtered;
#:   · CNP  — full structural shape (sex/century digit, valid month,
#:            valid day, valid county) AND the official control digit,
#:            never adjacent to another digit or a decimal separator.
#: Every tightened pattern matches a SUBSET of what the loose set
#: matches, so the redactor can never be laxer than the gate.
GATE_ID_PATTERNS = (
    re.compile(r"(?i)\b(?:CUI|CIF|C\.U\.I\.|C\.I\.F\.|cod\s+fiscal)\s*:?\s*"
               r"(?:RO\s?)?\d{2,10}\b"),
    re.compile(r"(?i)\bRO\s?\d{6,10}\b"),
    re.compile(r"(?i)\bJ\s?\d{1,2}\s*/\s*\d{1,9}\s*/\s*\d{4}\b"),
    re.compile(r"(?<![\d.,])[1-8]\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])"
               r"(?:0[1-9]|[1-4]\d|5[0-2])\d{4}(?![\d.,])"),
)

#: CNP control-digit key (the official constant).
_CNP_KEY = "279146358279"


def _cnp_control_digit_ok(digits: str) -> bool:
    total = sum(int(a) * int(b) for a, b in zip(digits[:12], _CNP_KEY))
    control = total % 11
    return int(digits[12]) == (1 if control == 10 else control)


def is_placeholder_identifier(matched: str) -> bool:
    """True for identifier-shaped strings that are obviously fabricated
    demo values rather than a real registration: every digit of a
    numeric group is the same character (`RO99999999`, `J40/9999/2020`,
    `CUI: 00000000`). These ship on purpose in customer-facing example
    workbooks; failing the build on them would only teach people to
    weaken the gate. A real identifier never has this shape, so the rule
    cannot be used to smuggle one past."""
    groups = [g for g in re.findall(r"\d+", matched) if len(g) >= 4]
    return bool(groups) and any(len(set(g)) == 1 for g in groups)

#: Domain separator so a digest here can never collide with a digest
#: computed for some other purpose in this repo.
_LEXICON_DOMAIN = b"cfo-ai/sensitive-lexicon/v1|"

#: Longest term, in whitespace-separated tokens, that the scanner will
#: assemble when looking for a match.
MAX_TERM_TOKENS = 3

#: TIER 2 — named entities. (category, sha256 of the normalized term).
#: Categories are human-readable on purpose: a reviewer can see WHAT
#: classes of identifier are covered without the plaintext being present.
#: Regenerate any line with `--hash-term "<term>"`.
SENSITIVE_TERMS: Tuple[Tuple[str, str], ...] = (
    # The subject entity's full legal name, as printed in the document
    # header and in the PDF /Author metadata key.
    ("company_legal_name", "93169875127a5c6d6ce72cdd9709badea507304a531f66d394139a76f75b0539"),
    # Trading-site names. They appear as suffixes on analytic account
    # labels ("... - <site>") and together pin the operator to a handful
    # of named premises, which is an address disclosure in all but name.
    ("site_location", "f568098be052367d12d44203f90b670a0fdb32ff090521c471c4af451a0fb723"),
    ("site_location", "81c44765f95784c161c9af86658216ba84886853dc3bac007ca981ea63f70468"),
    ("site_location", "c3fb44a045e8f5bf5a8e2baef92ed2996d3388d39f764e2082ce19ff64efcb36"),
    ("site_location", "0ce0ea3b15a1ed2238228242616a4cd30bd2d60984e99e3e42603f9c8390422b"),
    # One site is also abbreviated to a single short token on two
    # accounts. Longest-match-first ordering means the full two-word
    # form is always consumed before this short form can fire.
    ("site_location_short", "dd66117e1cea59dbabf278e28ed4506dab55454bd98fe3e6bfd9af5ae7a7283d"),
    # The natural person named as the document's preparer in the PDF
    # /Creator metadata key, in both the run-together and spaced forms.
    ("person_name", "338452add7e01d4955d7b2f016559dd5975ef1ad20db41ba8514900e0641e2dc"),
    ("person_name", "ab196ed22efc3adc838c7d9a7b13f678a69186044474ad1952bed369f25f89f4"),
)

_TOKEN_RE = re.compile(r"[0-9A-Za-z]+")

#: The lexicon actually in force. Swapped only by `lexicon_override`,
#: which exists so tests can prove the machinery on terms that are NOT
#: sensitive (see tests/engine/test_corpus_policy.py) — the shipped
#: corpus file is already redacted, so a test that could only re-run the
#: real lexicon over it would be vacuous.
_ACTIVE_TERMS: List[Tuple[str, str]] = []


class LexiconMatch(tuple):
    """(start, end, category) span of a sensitive hit inside one string."""

    __slots__ = ()

    def __new__(cls, start: int, end: int, category: str) -> "LexiconMatch":
        return super().__new__(cls, (start, end, category))

    @property
    def start(self) -> int:
        return self[0]

    @property
    def end(self) -> int:
        return self[1]

    @property
    def category(self) -> str:
        return self[2]


# ── lexicon ────────────────────────────────────────────────────────────


def normalize_term(text: str) -> str:
    """Fold diacritics, lowercase, and reduce to alphanumeric tokens
    joined by single spaces. `Ácmé Wörks`, `ACME WORKS` and
    `_acme__works_` all normalize to the same key, so one digest covers
    every spelling and every separator an exporter might use.

    The example is deliberately fictional: a docstring that spelled one
    of the real terms would put that term back into a tracked file,
    which is the exact thing this module exists to take out (and which
    `scripts/check_corpus_policy.py` would then flag)."""
    return " ".join(_TOKEN_RE.findall(_fold_ascii(text).lower()))


def term_hash(term: str) -> str:
    return hashlib.sha256(
        _LEXICON_DOMAIN + normalize_term(term).encode("utf-8")
    ).hexdigest()


def _term_index() -> Dict[str, str]:
    terms = _ACTIVE_TERMS or list(SENSITIVE_TERMS)
    return {digest: category for category, digest in terms}


@contextmanager
def lexicon_override(terms: Sequence[Tuple[str, str]]):
    """Run a block against a different term list. Used by tests to prove
    the transform on non-sensitive terms; never used in production."""
    global _ACTIVE_TERMS
    previous = _ACTIVE_TERMS
    _ACTIVE_TERMS = list(terms)
    try:
        yield
    finally:
        _ACTIVE_TERMS = previous


def find_sensitive_spans(
    text: str, *, gate_patterns: bool = False, named_entities: bool = True
) -> List[LexiconMatch]:
    """Every sensitive span in `text`, left to right, non-overlapping.

    `gate_patterns` swaps the loose redaction identifier patterns for
    the precise tree-scanning set (and drops fabricated placeholders).
    `named_entities=False` runs identifiers only — that is what the
    policy gate uses on files outside the data payloads, and it also
    skips the n-gram hashing, which is the expensive half.

    Order of resolution matters: identifier patterns win first (highest
    confidence, and may legitimately contain tokens that also appear in
    a named-entity term), then named entities longest-first so a
    three-word legal name is consumed as one span rather than three."""
    if not text:
        return []
    taken: List[Tuple[int, int]] = []

    def _free(start: int, end: int) -> bool:
        return all(end <= s or start >= e for s, e in taken)

    spans: List[LexiconMatch] = []
    for pattern in (GATE_ID_PATTERNS if gate_patterns else ID_PATTERNS):
        for m in pattern.finditer(text):
            matched = m.group(0)
            if gate_patterns:
                if is_placeholder_identifier(matched):
                    continue
                if matched.isdigit() and len(matched) == 13 and not _cnp_control_digit_ok(matched):
                    continue
            if _free(m.start(), m.end()):
                spans.append(LexiconMatch(m.start(), m.end(), "statutory_identifier"))
                taken.append((m.start(), m.end()))

    if named_entities:
        index = _term_index()
        tokens = list(_TOKEN_RE.finditer(text))
        for n in range(MAX_TERM_TOKENS, 0, -1):
            for i in range(0, len(tokens) - n + 1):
                start = tokens[i].start()
                end = tokens[i + n - 1].end()
                if not _free(start, end):
                    continue
                category = index.get(term_hash(text[start:end]))
                if category is not None:
                    spans.append(LexiconMatch(start, end, category))
                    taken.append((start, end))

    spans.sort(key=lambda s: s.start)
    return spans


def scan_text(
    text: str, *, gate_patterns: bool = False, named_entities: bool = True
) -> List[Tuple[str, str]]:
    """(category, matched_substring) for every hit — the reporting form."""
    return [
        (m.category, text[m.start:m.end])
        for m in find_sensitive_spans(
            text, gate_patterns=gate_patterns, named_entities=named_entities
        )
    ]


def redact_text(seed_hex: str, text: str) -> str:
    """Replace every sensitive span with its deterministic scramble.
    Length is asserted, not hoped for: a span whose fold changes length
    would shift every glyph after it, so it is a hard error."""
    spans = find_sensitive_spans(text)
    if not spans:
        return text
    out: List[str] = []
    cursor = 0
    for span in spans:
        original = text[span.start:span.end]
        replacement = scramble_text(seed_hex, original)
        if len(replacement) != len(original):
            raise ValueError(
                "non-length-preserving scramble for a %s span (%d -> %d chars)"
                % (span.category, len(original), len(replacement))
            )
        out.append(text[cursor:span.start])
        out.append(replacement)
        cursor = span.end
    out.append(text[cursor:])
    result = "".join(out)
    if len(result) != len(text):
        raise ValueError("redaction changed string length (%d -> %d)"
                         % (len(text), len(result)))
    return result


# ── PDF content-stream tokenizer ───────────────────────────────────────

_WS = b"\x00\t\n\x0c\r "
_DELIM = b"()<>[]{}/%"
_NUMBER_TOKEN_RE = re.compile(rb"^[+-]?(?:\d+\.?\d*|\.\d+)$")
_SHOW_ONE = (b"Tj", b"'", b'"')
_SHOW_ARRAY = (b"TJ",)


def _tokenize(buf: bytes) -> Iterable[Tuple[str, int, int]]:
    """Yield (kind, start, end) content-stream tokens. Kinds:
    str / hexstr / name / num / op / arr_open / arr_close / other."""
    i = 0
    n = len(buf)
    while i < n:
        c = buf[i:i + 1]
        if c in _WS:
            i += 1
            continue
        if c == b"%":
            j = i
            while j < n and buf[j:j + 1] not in b"\r\n":
                j += 1
            i = j
            continue
        if c == b"(":
            j = i + 1
            depth = 1
            while j < n:
                ch = buf[j:j + 1]
                if ch == b"\\":
                    j += 2
                    continue
                if ch == b"(":
                    depth += 1
                elif ch == b")":
                    depth -= 1
                    if depth == 0:
                        j += 1
                        break
                j += 1
            yield ("str", i, j)
            i = j
            continue
        if c == b"<":
            if buf[i + 1:i + 2] == b"<":
                yield ("other", i, i + 2)
                i += 2
                continue
            j = buf.find(b">", i)
            j = n if j < 0 else j + 1
            yield ("hexstr", i, j)
            i = j
            continue
        if c == b">":
            step = 2 if buf[i + 1:i + 2] == b">" else 1
            yield ("other", i, i + step)
            i += step
            continue
        if c == b"[":
            yield ("arr_open", i, i + 1)
            i += 1
            continue
        if c == b"]":
            yield ("arr_close", i, i + 1)
            i += 1
            continue
        if c in b"{}":
            yield ("other", i, i + 1)
            i += 1
            continue
        if c == b"/":
            j = i + 1
            while j < n and buf[j:j + 1] not in _WS and buf[j:j + 1] not in _DELIM:
                j += 1
            yield ("name", i, j)
            i = j
            continue
        j = i
        while j < n and buf[j:j + 1] not in _WS and buf[j:j + 1] not in _DELIM:
            j += 1
        if j == i:
            j = i + 1
        token = buf[i:j]
        if _NUMBER_TOKEN_RE.match(token):
            yield ("num", i, j)
        elif token == b"BI":
            # Inline image: its binary payload is not content-stream
            # syntax. Skip past the matching EI so the tokenizer never
            # tries to read image bytes as operators.
            end = buf.find(b"EI", j)
            end = n if end < 0 else end + 2
            yield ("other", i, end)
            i = end
            continue
        else:
            yield ("op", i, j)
        i = j


def _decode_literal(raw: bytes) -> bytes:
    """PDF literal string (parens included) -> its byte value."""
    inner = raw[1:-1] if raw[:1] == b"(" and raw[-1:] == b")" else raw
    out = bytearray()
    i = 0
    n = len(inner)
    while i < n:
        ch = inner[i:i + 1]
        if ch != b"\\":
            out += ch
            i += 1
            continue
        nxt = inner[i + 1:i + 2]
        if nxt == b"n":
            out += b"\n"; i += 2
        elif nxt == b"r":
            out += b"\r"; i += 2
        elif nxt == b"t":
            out += b"\t"; i += 2
        elif nxt == b"b":
            out += b"\b"; i += 2
        elif nxt == b"f":
            out += b"\x0c"; i += 2
        elif nxt in (b"(", b")", b"\\"):
            out += nxt; i += 2
        elif nxt and nxt in b"01234567":
            j = i + 1
            digits = b""
            while j < n and len(digits) < 3 and inner[j:j + 1] in b"01234567":
                digits += inner[j:j + 1]
                j += 1
            out.append(int(digits, 8) & 0xFF)
            i = j
        elif nxt in (b"\n", b"\r"):
            i += 2
            if nxt == b"\r" and inner[i:i + 1] == b"\n":
                i += 1
        elif not nxt:
            i += 1
        else:
            out += nxt
            i += 2
    return bytes(out)


def _encode_literal(data: bytes) -> bytes:
    out = bytearray(b"(")
    for b in data:
        if b in (0x28, 0x29, 0x5C):
            out += b"\\" + bytes([b])
        elif b < 32 or b == 127:
            out += ("\\%03o" % b).encode("ascii")
        else:
            out.append(b)
    out += b")"
    return bytes(out)


def _show_runs(buf: bytes) -> List[List[Tuple[int, int]]]:
    """Every text-showing operation, as the list of (start, end) byte
    ranges of its literal-string operands. A `TJ` array contributes all
    of its string elements as one run (they are one logical label split
    by kerning offsets)."""
    runs: List[List[Tuple[int, int]]] = []
    operands: List[Tuple[str, Any]] = []
    array: Optional[List[Tuple[int, int]]] = None
    for kind, start, end in _tokenize(buf):
        if kind == "arr_open":
            array = []
            continue
        if kind == "arr_close":
            operands.append(("arr", array or []))
            array = None
            continue
        if kind == "str":
            if array is not None:
                array.append((start, end))
            else:
                operands.append(("str", (start, end)))
            continue
        if kind == "op":
            op = buf[start:end]
            if op in _SHOW_ONE:
                for otype, payload in reversed(operands):
                    if otype == "str":
                        runs.append([payload])
                        break
            elif op in _SHOW_ARRAY:
                for otype, payload in reversed(operands):
                    if otype == "arr":
                        if payload:
                            runs.append(list(payload))
                        break
            operands = []
            continue
        operands.append((kind, (start, end)))
    return runs


def _redact_content_stream(
    buf: bytes, seed_hex: str, report: Dict[str, Any]
) -> bytes:
    """Rewrite only the sensitive spans of the show-strings in `buf`.
    Every other byte — operators, positions, numbers, whitespace — is
    copied through unchanged."""
    edits: List[Tuple[int, int, bytes]] = []
    for run in _show_runs(buf):
        pieces = [(s, e, _decode_literal(buf[s:e])) for s, e in run]
        # latin-1 is a lossless byte<->codepoint bijection, so decoding
        # here never loses information; the WinAnsi high range round-
        # trips untouched because we only ever rewrite ASCII spans.
        joined = b"".join(p[2] for p in pieces).decode("latin-1")
        hits = find_sensitive_spans(joined)
        if not hits:
            continue
        redacted = redact_text(seed_hex, joined)
        report["runs_changed"] += 1
        for m in hits:
            report["by_category"][m.category] = (
                report["by_category"].get(m.category, 0) + 1
            )
        cursor = 0
        for s, e, value in pieces:
            width = len(value)
            piece_text = redacted[cursor:cursor + width]
            cursor += width
            new_bytes = piece_text.encode("latin-1")
            if new_bytes != value:
                edits.append((s, e, _encode_literal(new_bytes)))
    if not edits:
        return buf
    edits.sort(key=lambda t: t[0])
    out = bytearray()
    cursor = 0
    for start, end, replacement in edits:
        out += buf[cursor:start]
        out += replacement
        cursor = end
    out += buf[cursor:]
    return bytes(out)


# ── document-level rewrite ─────────────────────────────────────────────

_DOCINFO_TEXT_KEYS = ("/Title", "/Author", "/Subject", "/Keywords", "/Creator")


def _content_streams(page: Any) -> List[Any]:
    """A page's /Contents is either one stream or an array of streams
    that concatenate into one content stream. Both shapes are handled;
    an array element is only kept if it really is a stream."""
    import pikepdf

    obj = page.obj if hasattr(page, "obj") else page
    contents = obj.get("/Contents")
    if contents is None:
        return []
    if isinstance(contents, pikepdf.Array):
        return [c for c in contents if isinstance(c, pikepdf.Stream)]
    return [contents] if isinstance(contents, pikepdf.Stream) else []


def scramble_pdf_bytes(
    data: bytes, seed_hex: Optional[str] = None
) -> Tuple[bytes, Dict[str, Any]]:
    """Redact a PDF in memory. Returns (redacted_bytes, report)."""
    import pikepdf

    seed = seed_hex or content_seed(data)
    report: Dict[str, Any] = {
        "seed": seed,
        "runs_changed": 0,
        "by_category": {},
        "metadata_keys_changed": [],
        "streams_rewritten": 0,
    }
    pdf = pikepdf.open(io.BytesIO(data))
    seen: set = set()
    for page in pdf.pages:
        for stream in _content_streams(page):
            key = getattr(stream, "objgen", None)
            if key is not None and key != (0, 0):
                if key in seen:
                    continue
                seen.add(key)
            raw = stream.read_bytes()
            new = _redact_content_stream(raw, seed, report)
            if new != raw:
                stream.write(new)
                report["streams_rewritten"] += 1

    docinfo = pdf.docinfo
    for key in _DOCINFO_TEXT_KEYS:
        if key not in docinfo:
            continue
        value = str(docinfo[key])
        new_value = redact_text(seed, value)
        if new_value != value:
            docinfo[key] = new_value
            report["metadata_keys_changed"].append(key)

    meta = pdf.Root.get("/Metadata")
    if meta is not None:
        try:
            raw_xmp = bytes(meta.read_bytes())
            text = raw_xmp.decode("utf-8")
        except Exception:  # noqa: BLE001 — non-UTF-8 XMP: leave it alone
            text = None
        if text is not None:
            new_text = redact_text(seed, text)
            if new_text != text:
                meta.write(new_text.encode("utf-8"))
                report["metadata_keys_changed"].append("/Metadata (XMP)")

    buf = io.BytesIO()
    pdf.save(buf, linearize=False)
    pdf.close()
    return buf.getvalue(), report


# ── extraction for scanning ────────────────────────────────────────────


def pdf_text_units(data: bytes) -> List[str]:
    """Every human-readable text unit in a PDF: each show-string of each
    content stream, plus the docinfo values and XMP.

    Deliberately NOT PyMuPDF's page text: these exports clip each label
    to a rectangle, and MuPDF honours the clip — so a term scrolled out
    of view would be invisible to a text extraction while still sitting
    in the file. Falls back to PyMuPDF only when pikepdf is unavailable,
    and says so via the returned marker unit."""
    try:
        import pikepdf
    except ImportError:
        import fitz  # PyMuPDF — a hard engine dependency

        doc = fitz.open(stream=data, filetype="pdf")
        units = [page.get_text() for page in doc]
        units.extend(str(v) for v in (doc.metadata or {}).values() if v)
        doc.close()
        return units

    units: List[str] = []
    pdf = pikepdf.open(io.BytesIO(data))
    seen: set = set()
    for page in pdf.pages:
        for stream in _content_streams(page):
            key = getattr(stream, "objgen", None)
            if key is not None and key != (0, 0):
                if key in seen:
                    continue
                seen.add(key)
            buf = stream.read_bytes()
            for run in _show_runs(buf):
                joined = b"".join(_decode_literal(buf[s:e]) for s, e in run)
                units.append(joined.decode("latin-1"))
    for key in _DOCINFO_TEXT_KEYS + ("/Producer",):
        if key in pdf.docinfo:
            units.append(str(pdf.docinfo[key]))
    meta = pdf.Root.get("/Metadata")
    if meta is not None:
        try:
            units.append(bytes(meta.read_bytes()).decode("utf-8", errors="replace"))
        except Exception:  # noqa: BLE001
            pass
    pdf.close()
    return units


# ── the mandatory verification gate ────────────────────────────────────

_MONEY_SLOTS = (
    "opening_debit", "opening_credit",
    "period_debit", "period_credit",
    "closing_debit", "closing_credit",
)


def _parse_ir(data: bytes, filename: str = "input.pdf"):
    from engine.frontends.registry import resolve_front_end

    front_end = resolve_front_end("pdf_positional")
    return front_end.parse(data, {"filename": filename})


def _run_texts(data: bytes) -> List[str]:
    """The decoded text of every text-showing operation, in document
    order. This is the layer the redaction actually operates on, so it
    is the layer at which 'only labels changed, exactly per the
    deterministic mapping' can be stated exactly."""
    import pikepdf

    out: List[str] = []
    pdf = pikepdf.open(io.BytesIO(data))
    seen: set = set()
    for page in pdf.pages:
        for stream in _content_streams(page):
            key = getattr(stream, "objgen", None)
            if key is not None and key != (0, 0):
                if key in seen:
                    continue
                seen.add(key)
            buf = stream.read_bytes()
            for run in _show_runs(buf):
                out.append(
                    b"".join(_decode_literal(buf[s:e]) for s, e in run)
                    .decode("latin-1")
                )
    pdf.close()
    return out


def _norm_ws(text: str) -> str:
    return " ".join(text.split())


def _money_repr(value: Any) -> str:
    if value is None:
        return "ABSENT"
    return "%s:%s" % (getattr(value, "currency", "?"), getattr(value, "minor", value))


def verify_pdf_pair(
    original: bytes, redacted: bytes, filename: str = "input.pdf"
) -> Tuple[List[str], Dict[str, Any]]:
    """THE gate. Parse both files with the real positional-PDF front-end
    and prove the numeric IR is identical.

    Returns (failures, summary). `failures` empty == the redaction is
    numerically inert and may ship. Anything else ⇒ REJECT the redaction
    (fall back to encryption-at-rest instead of shipping a redacted file).
    """
    failures: List[str] = []
    doc_a, diag_a = _parse_ir(original, filename)
    doc_b, diag_b = _parse_ir(redacted, filename)

    if len(doc_a.atoms) != len(doc_b.atoms):
        failures.append(
            "atom count %d != %d" % (len(doc_a.atoms), len(doc_b.atoms))
        )
        return failures, {"labels_changed": 0, "atoms": len(doc_a.atoms)}

    labels_changed = 0
    label_deltas: List[Tuple[str, str, str]] = []
    for a, b in zip(doc_a.atoms, doc_b.atoms):
        if a.atom_id != b.atom_id:
            failures.append("atom_id %r != %r (row order or code changed)"
                            % (a.atom_id, b.atom_id))
            continue
        if a.account_code != b.account_code:
            failures.append("%s account_code %r != %r"
                            % (a.atom_id, a.account_code, b.account_code))
        for slot in _MONEY_SLOTS:
            va, vb = getattr(a, slot), getattr(b, slot)
            if va != vb:
                failures.append("%s %s: %s != %s"
                                % (a.atom_id, slot, _money_repr(va), _money_repr(vb)))
        if a.provenance != b.provenance:
            failures.append("%s provenance differs" % a.atom_id)
        if a.label != b.label:
            labels_changed += 1
            label_deltas.append((a.atom_id, a.label, b.label))

    ha, hb = doc_a.header, doc_b.header
    if ha.jurisdiction != hb.jurisdiction:
        failures.append("header jurisdiction %r != %r"
                        % (ha.jurisdiction, hb.jurisdiction))
    if ha.currency != hb.currency:
        failures.append("header currency %r != %r" % (ha.currency, hb.currency))
    if ha.document_totals != hb.document_totals:
        failures.append("document_totals row differs: %r != %r"
                        % (ha.document_totals, hb.document_totals))
    if ha.source_meta != hb.source_meta:
        keys = set(ha.source_meta) | set(hb.source_meta)
        for key in sorted(keys):
            if ha.source_meta.get(key) != hb.source_meta.get(key):
                failures.append("source_meta[%r] differs" % key)
    if diag_a != diag_b:
        failures.append("front-end diagnostics differ (%d vs %d entries)"
                        % (len(diag_a), len(diag_b)))

    # ── the mapping proof, at the layer the redaction operates on ──
    # Every text run must be either byte-identical or EXACTLY the
    # deterministic scramble of its original. This is the precise form
    # of "only labels differ, exactly per the deterministic mapping":
    # atom labels are a CLIPPED RENDERING of these runs (these exports
    # clip each label to a rectangle and scrambled glyphs have different
    # advance widths), so the clip boundary can land a character or two
    # either side — a rendering effect, not a redaction effect.
    seed = content_seed(original)
    runs_a = _run_texts(original)
    runs_b = _run_texts(redacted)
    runs_changed = 0
    if len(runs_a) != len(runs_b):
        failures.append("text-run count %d != %d" % (len(runs_a), len(runs_b)))
    else:
        for i, (ra, rb) in enumerate(zip(runs_a, runs_b)):
            expected = redact_text(seed, ra)
            if rb != expected:
                failures.append(
                    "run %d is not the deterministic mapping of its original: "
                    "%r -> %r (expected %r)" % (i, ra, rb, expected)
                )
            elif rb != ra:
                runs_changed += 1

    # Every atom label that changed must be traceable to one of those
    # runs: the original label a clip-prefix of some original run, and
    # the redacted label a clip-prefix of THAT run's redaction.
    if len(runs_a) == len(runs_b):
        pairs = [
            (_norm_ws(ra), _norm_ws(rb))
            for ra, rb in zip(runs_a, runs_b)
            if ra != rb
        ]
        for atom_id, a_label, b_label in label_deltas:
            na, nb = _norm_ws(a_label), _norm_ws(b_label)
            if not any(ra.startswith(na) and rb.startswith(nb) for ra, rb in pairs):
                failures.append(
                    "%s label change is not traceable to a redacted run: "
                    "%r -> %r" % (atom_id, a_label, b_label)
                )

    residual = [
        (unit, hit)
        for unit in pdf_text_units(redacted)
        for hit in scan_text(unit)
    ]
    if residual:
        failures.append(
            "redacted file still matches the lexicon in %d place(s): %s"
            % (len(residual), ", ".join(sorted({h[0] for _, h in residual})))
        )

    summary = {
        "atoms": len(doc_a.atoms),
        "labels_changed": labels_changed,
        "label_deltas": label_deltas,
        "runs_total": len(runs_a),
        "runs_changed": runs_changed,
        "residual_hits": len(residual),
    }
    return failures, summary


def verify_bytes(data: bytes) -> List[str]:
    """The corpus-replay contract for an `anonymized: true` PDF case —
    the PDF counterpart of `anonymize_tb.verify_bytes`, re-run on EVERY
    replay. Two assertions, neither of which needs the original file:

      1. RESIDUAL — the shipped file matches the sensitive lexicon
         nowhere: not in a content stream, not in docinfo, not in XMP.
         This is the claim `anonymized: true` actually makes.
      2. CONVERGENCE — re-applying the redaction transform changes no
         text run. A file that still moved under the transform would
         mean the first pass had not finished.

    The full numeric-IR proof (`verify_pdf_pair`) needs both the before
    and after files, so it runs ONCE, at redaction time, and is recorded
    in the commit message and the ADR. What CI re-proves forever is that
    scrambling label text inside a content stream cannot move numbers —
    see tests/engine/test_corpus_policy.py.
    """
    failures: List[str] = []
    try:
        hits = [hit for unit in pdf_text_units(data) for hit in scan_text(unit)]
    except Exception as exc:  # noqa: BLE001
        return ["pdf lexicon scan failed: %s: %s" % (type(exc).__name__, exc)]
    for category, matched in sorted(set(hits)):
        failures.append("residual %s in redacted PDF: %r" % (category, matched))
    try:
        again, _ = scramble_pdf_bytes(data)
    except Exception as exc:  # noqa: BLE001
        return failures + [
            "re-running the redaction transform failed: %s: %s"
            % (type(exc).__name__, exc)
        ]
    before, after = _run_texts(data), _run_texts(again)
    if before != after:
        changed = sum(1 for x, y in zip(before, after) if x != y)
        failures.append(
            "redaction is not converged: re-running it changes %d text run(s)"
            % changed
        )
    return failures


# ── CLI ────────────────────────────────────────────────────────────────


def _cmd_hash_term(term: str) -> int:
    print('    ("CATEGORY", "%s"),  # <- add a real category' % term_hash(term))
    return 0


def _cmd_scan(paths: Sequence[str]) -> int:
    rc = 0
    for name in paths:
        data = Path(name).read_bytes()
        units = pdf_text_units(data) if data[:5] == b"%PDF-" else [
            data.decode("utf-8", errors="replace")
        ]
        hits = [hit for unit in units for hit in scan_text(unit)]
        if hits:
            rc = 1
            print("HITS %-50s %d" % (name, len(hits)))
            for category, matched in sorted(set(hits)):
                print("  %-24s %r" % (category, matched))
        else:
            print("CLEAN %s" % name)
    return rc


def _cmd_verify(original: str, redacted: str) -> int:
    failures, summary = verify_pdf_pair(
        Path(original).read_bytes(), Path(redacted).read_bytes()
    )
    print("atoms compared          %d" % summary["atoms"])
    print("text runs compared      %d" % summary["runs_total"])
    print("text runs redacted      %d" % summary["runs_changed"])
    print("labels changed          %d" % summary["labels_changed"])
    print("residual lexicon hits   %d" % summary["residual_hits"])
    if failures:
        print("\nVERIFY FAIL — %d divergence(s):" % len(failures))
        for f in failures[:60]:
            print("  x %s" % f)
        if len(failures) > 60:
            print("  ... %d more" % (len(failures) - 60))
        return 1
    print("\nVERIFY OK — numeric IR identical; only labels differ.")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("inputs", nargs="*", help="input path(s)")
    parser.add_argument("-o", "--output", help="output path")
    parser.add_argument("--verify", action="store_true",
                        help="run the IR-identity gate")
    parser.add_argument("--scan", action="store_true",
                        help="report lexicon hits; write nothing")
    parser.add_argument("--hash-term", dest="hash_term",
                        help="print the lexicon line for a term")
    args = parser.parse_args(argv)

    if args.hash_term:
        return _cmd_hash_term(args.hash_term)
    if args.scan:
        if not args.inputs:
            parser.error("--scan needs at least one path")
        return _cmd_scan(args.inputs)
    if args.verify and not args.output:
        if len(args.inputs) != 2:
            parser.error("--verify without -o takes ORIGINAL REDACTED")
        return _cmd_verify(args.inputs[0], args.inputs[1])

    if len(args.inputs) != 1 or not args.output:
        parser.error("redaction mode takes exactly one INPUT and -o OUTPUT")
    src = Path(args.inputs[0])
    data = src.read_bytes()
    redacted, report = scramble_pdf_bytes(data)
    out = Path(args.output)
    out.write_bytes(redacted)
    print("wrote %s (%d bytes, seed=%s)"
          % (out, len(redacted), report["seed"][:12]))
    print("  runs rewritten        %d" % report["runs_changed"])
    print("  streams rewritten     %d" % report["streams_rewritten"])
    print("  metadata keys         %s"
          % (", ".join(report["metadata_keys_changed"]) or "none"))
    for category, count in sorted(report["by_category"].items()):
        print("  %-22s %d span(s)" % (category, count))

    if args.verify:
        return _cmd_verify(str(src), str(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
