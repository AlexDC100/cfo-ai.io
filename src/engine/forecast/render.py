"""A deterministic plain-text rendering of a projection.

Deliberately austere: this is the operator/CI view, and its job is to
make the balance check and the funding line VISIBLE for every period,
not to be pretty. Wave 2's surfaces read ``Projection.as_dict()`` /
``Projection.series()``; nothing here is on the numeric path.

TC-10 — no cutoff is written as prose. The balance line prints the
difference the check itself measured; the funding block prints the
amounts the draw was computed from. A reader can re-derive the verdict
from the same figures the verdict used.

Python 3.9 — no ``match``, no ``X | Y``.
"""

from __future__ import annotations

from typing import Any, List

from .money import days_fmt, fmt
from .opening import ASSET_LINES, EL_LINES
from .project import CF_LINES, PL_LINES, Projection

__all__ = ["render_text"]

_WIDTH = 30


def _row(label: str, cents: int, indent: int = 0) -> str:
    return "%s%-*s %20s" % (" " * indent, _WIDTH - indent, label, fmt(cents))


def render_text(projection: Projection, *, company: str = "",
                statements: bool = True) -> str:
    out = []  # type: List[str]
    add = out.append
    opening = projection.opening

    add("=" * 74)
    add("PROJECTION%s" % ((" — " + company) if company else ""))
    add("opening position: closing balances at %s, currency %s"
        % (opening.period_end, opening.currency))
    add("source snapshot:  %s" % (opening.snapshot_id or "(not carried)"))
    add("=" * 74)

    add("")
    add("OPENING POSITION (read from the canonical balance sheet)")
    for line in ASSET_LINES:
        add(_row(line, opening.cents(line), 2))
    add(_row("TOTAL ASSETS", opening.total_assets_cents()))
    for line in EL_LINES:
        add(_row(line, opening.cents(line), 2))
    add(_row("TOTAL EQUITY + LIABILITIES", opening.total_el_cents()))
    add("  served canonical totals: assets %s / equity+liabilities %s"
        % (fmt(opening.totals["assets"]),
           fmt(opening.totals["equity_plus_liabilities"])))
    add("  opening check: forecast lines minus served totals = %s / %s"
        % (fmt(opening.total_assets_cents() - opening.totals["assets"]),
           fmt(opening.total_el_cents()
               - opening.totals["equity_plus_liabilities"])))

    add("")
    add("ASSUMPTIONS — every driver, and where it came from")
    for item in projection.assumptions.items():
        value = item.value()
        if item.source == "unavailable" or value is None:
            # A driver the book could not answer reads the same whatever
            # its unit. Printing "0.00" beside the word "unavailable" is
            # the two meanings of zero back in one cell.
            shown = "(unavailable)"
        elif item.unit == "ratio":
            shown = "%.4f%%" % (value * 100.0)
        elif item.unit == "money":
            shown = fmt(item.exact)
        elif item.unit == "days":
            shown = "%s days" % days_fmt(item.exact)
        else:
            shown = str(value)
        add("  %-38s %-16s %s" % (item.key, shown, item.source))
        add("      %s" % item.basis)
    if not projection.assumptions.debt_schedule.is_empty():
        add("  debt schedule:")
        for move in projection.assumptions.debt_schedule.as_list():
            add("      period %-3d st +%s -%s   lt +%s -%s"
                % (move["period_index"], move["st_draw"], move["st_repay"],
                   move["lt_draw"], move["lt_repay"]))

    add("")
    add("BALANCE CHECK — assets minus (equity + liabilities), every period")
    add("  %-12s %20s %20s %14s" % ("period", "assets",
                                    "equity+liabilities", "difference"))
    for projected in projection.periods:
        add("  %-12s %20s %20s %14s"
            % (projected.label, fmt(projected.total_assets_cents()),
               fmt(projected.total_el_cents()),
               fmt(projected.total_assets_cents()
                   - projected.total_el_cents())))

    add("")
    add("FUNDING LINE — cash before the line, the draw, the balance")
    drawn = projection.funding_periods()
    if not drawn:
        add("  never drawn. Lowest cash before the funding line across the "
            "projection: %s, against a floor of %s."
            % (fmt(min(_cash_before(p) for p in projection.periods)),
               fmt(projection.assumptions.cents("min_cash"))))
    for projected in projection.periods:
        draw = projected.checks["funding_line_draw_cents"]
        repay = projected.checks["funding_line_repay_cents"]
        if draw == 0 and repay == 0 and projected.bs["revolver"] == 0:
            continue
        add("  %-12s cash before %18s  draw %16s  repay %16s  balance %16s"
            % (projected.label, fmt(_cash_before(projected)),
               fmt(draw), fmt(repay), fmt(projected.bs["revolver"])))
    if drawn:
        add("  peak funding line: %s across %d period(s)"
            % (fmt(projection.peak_funding_cents()), len(drawn)))

    if statements:
        add("")
        add("PROJECTED PROFIT & LOSS")
        _matrix(add, projection, PL_LINES, lambda p, k: p.pl[k])
        add("")
        add("PROJECTED BALANCE SHEET")
        _matrix(add, projection, ASSET_LINES + EL_LINES, lambda p, k: p.bs[k])
        add("")
        add("PROJECTED CASH FLOW")
        _matrix(add, projection, CF_LINES, lambda p, k: p.cf[k])

    if projection.notes:
        add("")
        add("WHAT THIS BOOK COULD NOT TELL US")
        for note in projection.notes:
            add("  - %s" % note)

    return "\n".join(out) + "\n"


def _cash_before(projected: Any) -> int:
    """Cash as the articulation left it, BEFORE the funding line moved —
    recomputed from the cash-flow integers so the display never
    round-trips through a float."""
    return (projected.cf["opening_cash"] + projected.cf["net_change_in_cash"]
            - projected.cf["funding_line_movement"])


def _matrix(add: Any, projection: Projection, lines, getter) -> None:
    labels = [p.label for p in projection.periods]
    add("  %-32s%s" % ("", "".join("%18s" % l for l in labels)))
    for key in lines:
        add("  %-32s%s"
            % (key, "".join("%18s" % fmt(getter(p, key))
                            for p in projection.periods)))
