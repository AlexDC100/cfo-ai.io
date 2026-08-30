"""Typed refusal for public_market adapters (europe + prices lane).

House law: fail closed, and fail LEGIBLY. An adapter that cannot
produce a trustworthy value returns a ``Refusal`` — a small frozen
value object with a machine-checkable ``code`` — never a partial
number, never ``0.0``, never an exception swallowed into ``None``
(``None``/absence is reserved for the DESIGNED absent states, e.g. the
keyless price block).

Lane note (2026-08-29): the public_market spine lane may land its own
refusal/absence types; this module is deliberately tiny and
private-named so unifying on the spine's type later is a one-line
import swap per adapter. Flagged as a cross-lane merge point in the
lane report.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Refusal:
    """A typed 'no' — code is stable API, detail is a human line.

    ``detail`` must never carry secrets (API keys, tokens) — refusals
    travel into logs and lane reports.
    """

    code: str  # stable, snake_case, prefixed by the refusing adapter
    detail: str  # one human-readable sentence, secret-free
    source: str  # which feed refused, e.g. "filings.xbrl.org"


def refuse(code, detail, source):
    # type: (str, str, str) -> Refusal
    return Refusal(code=code, detail=detail, source=source)


def is_refusal(obj):
    # type: (object) -> bool
    return isinstance(obj, Refusal)
