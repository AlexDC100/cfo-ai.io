"""ONE PERIOD'S SHARES — the per-side half of common size, and the only
place in the package where a share is taken.

A share is a statement about ONE period: this line over this period's own
base (net turnover for the P&L, total assets for the balance sheet). It
needs no second period. Until 2026-10-04 it was nevertheless computed only
inside the two-period document (`analysis.common_size`), so a company with
one year on file — or its earliest year on screen — had no "% of turnover"
column at all (owner ruling 2026-10-04: "'% din venituri' must work for a
single year without a comparison").

ONE COMPUTATION. `side_shares` is that computation. The two-period
document runs it once per side over the column model's own per-side
values; the single-period block served on every period payload
(`analysis.period_common_size`, `statements.common_size`) runs it over
`side_lines`, which reads the envelope through the column model's own
per-side reader (`columns.disclose_side`). Same lines, same bases, same
zero floor, same rounding — so the current column of a comparison and the
same period read alone cannot be two figures
(tests/engine/test_common_size_single.py holds them equal on every corpus
pair, both sides).

WHAT A LINE WITHOUT A SHARE SAYS. Never 0 %:

  absent        the period's book fed nothing into the line
  refused       the period's assembly refused the figure (the one EBITDA
                and what is built on it), with its reason
  not_disclosed_at_this_detail_level
                a subdivision the book's depth cannot carry
  no_base       the line is reported, and the base it would be a share OF
                is absent, refused, or below the zero floor — which holds
                for EVERY line of that statement, the base line included

Jurisdiction-blind like the rest of the package: nothing here names a
country, a chart or an account.

Python 3.9 — no `match`, no `X | Y` unions.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Sequence, Tuple

from .columns import (
    DISCLOSURE_ABSENT,
    DISCLOSURE_NOT_AT_LEVEL,
    DISCLOSURE_REFUSED,
    DISCLOSURE_REPORTED,
    disclose_side,
    refusal_text,
    round_money,
)
from .lines import LINE_SPECS, ZERO_FLOOR, LineSpec, coverage_from_envelope, unwrap_envelope

__all__ = [
    "COMMON_SIZE_BASE",
    "SHARE_DP",
    "STATUS_SHARE",
    "STATUS_NO_BASE",
    "SIDE_STATUSES",
    "SideLine",
    "SideShare",
    "take_share",
    "served_share",
    "side_lines",
    "side_shares",
]

#: The line each statement's shares are taken against.
COMMON_SIZE_BASE = {"PL": "pl.revenue", "BS": "bs.total_assets"}

#: A served share is a fraction to six places (a percentage to four).
SHARE_DP = 6

#: The ONLY status a row with a share carries.
STATUS_SHARE = "share"
#: The line is reported; its base is not there to be a share of.
STATUS_NO_BASE = "no_base"

#: Everything one period can say about one line's share. The three
#: no-figure statuses ARE the column model's per-side disclosures — one
#: vocabulary for "what this period said about this line".
SIDE_STATUSES: Tuple[str, ...] = (
    STATUS_SHARE,
    STATUS_NO_BASE,
    DISCLOSURE_ABSENT,
    DISCLOSURE_REFUSED,
    DISCLOSURE_NOT_AT_LEVEL,
)

_DISCLOSURE_WORDS = {
    DISCLOSURE_ABSENT: "absent",
    DISCLOSURE_REFUSED: "refused",
    DISCLOSURE_NOT_AT_LEVEL: "not disclosed at this detail level",
}


@dataclass(frozen=True)
class SideLine:
    """One line of ONE period, as the column model reads a side."""

    key: str
    statement: str
    label: str
    #: The line this one is a share of.
    base_key: str
    #: Money to the cent; None unless the disclosure is REPORTED.
    value: Optional[float]
    disclosure: str
    #: Why there is no figure, for a line that is not REPORTED ("" else).
    note: str = ""


@dataclass(frozen=True)
class SideShare:
    line: SideLine
    #: The share before rounding — kept ONLY so a two-period row can state
    #: its change in points from the unrounded sides, as it always has. It
    #: is never served.
    raw: Optional[float]
    #: The served share: a fraction, `SHARE_DP` places; None with no share.
    share: Optional[float]
    status: str
    note: str


def take_share(value: Optional[float], base: Optional[float]) -> Optional[float]:
    """THE DIVISION. None — never 0.0 — when either operand is missing or
    the base is below the zero floor: a base that rounds to zero is a zero
    base, not a denominator."""
    if value is None or base is None or abs(base) < ZERO_FLOOR:
        return None
    return value / abs(base)


def served_share(raw: Optional[float]) -> Optional[float]:
    """THE ROUNDING. -0.0 and 0.0 are one share; only one is rendered."""
    if raw is None:
        return None
    out = round(raw, SHARE_DP)
    return 0.0 if out == 0 else out


def _undisclosed_note(envelope: Mapping[str, Any], spec: LineSpec, disclosure: str,
                      level: str) -> str:
    if disclosure == DISCLOSURE_REPORTED:
        return ""
    if disclosure == DISCLOSURE_NOT_AT_LEVEL:
        return ("%s is a subdivision below the synthetic account boundary; not "
                "disclosed at this detail level (%s) — no share is taken"
                % (spec.label, level))
    if disclosure == DISCLOSURE_REFUSED:
        return ("%s is refused, so no share is taken — %s"
                % (spec.label, refusal_text(envelope, spec)))
    return ("the period did not report %s; absent, which is not zero — no "
            "share is taken" % spec.label)


def side_lines(
    envelope: Mapping[str, Any],
    level: str,
    specs: Optional[Sequence[LineSpec]] = None,
) -> Tuple[SideLine, ...]:
    """Every registry line of ONE assembled envelope, read exactly as
    `build_comparative_columns` reads a side of a comparable pair: the
    same reader (`disclose_side`), the same coverage, the same cent
    rounding. `level` is the book's detail level, in the vocabulary of
    `engine.comparatives.levels` — REQUIRED, as it is for a comparison.

    Pure: no clock, no I/O. Same envelope in, same lines out."""
    if specs is None:
        specs = LINE_SPECS
    # Loudly, before anything is read: a shape error must surface as an
    # error, never as a block of absences.
    unwrap_envelope(envelope)
    coverage = coverage_from_envelope(envelope)
    out = []
    for spec in specs:
        value, disclosure = disclose_side(envelope, spec, coverage, level, True)
        out.append(SideLine(
            key=spec.key,
            statement=spec.statement,
            label=spec.label,
            base_key=COMMON_SIZE_BASE.get(spec.statement, ""),
            value=None if value is None else round_money(value),
            disclosure=disclosure,
            note=_undisclosed_note(envelope, spec, disclosure, level),
        ))
    return tuple(out)


def side_shares(lines: Sequence[SideLine]) -> Tuple[SideShare, ...]:
    """THE ONE COMPUTATION: each line as a share of its base line, among
    the lines of ONE period. A line with no figure keeps its own reason; a
    reported line whose base is not there says so — and so does every
    other line of that statement, the base line itself included."""
    by_key = {}  # type: Dict[str, SideLine]
    for line in lines:
        by_key.setdefault(line.key, line)
    out = []
    for line in lines:
        if line.value is None:
            out.append(SideShare(line=line, raw=None, share=None,
                                 status=line.disclosure, note=line.note))
            continue
        base_line = by_key.get(line.base_key)
        base = None if base_line is None else base_line.value
        raw = take_share(line.value, base)
        if raw is not None:
            out.append(SideShare(line=line, raw=raw, share=served_share(raw),
                                 status=STATUS_SHARE, note="share of %s" % line.base_key))
            continue
        if base_line is None:
            why = "%s is not a line of this period" % (line.base_key or "the statement base")
        elif base is None:
            why = "%s is %s in this period" % (
                line.base_key, _DISCLOSURE_WORDS.get(base_line.disclosure, base_line.disclosure))
        else:
            why = "%s is below the %.3f zero floor in this period" % (line.base_key, ZERO_FLOOR)
        out.append(SideShare(line=line, raw=None, share=None, status=STATUS_NO_BASE,
                             note="%s; no share can be taken" % why))
    return tuple(out)
