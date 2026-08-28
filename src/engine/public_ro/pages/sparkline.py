"""Server-rendered inline SVG sparklines — pure function, no libraries.

Deterministic by construction: fixed viewBox, coordinates rounded to one
decimal with a fixed format, no ids, no timestamps. The same value list
always yields byte-identical SVG (the PS3 byte-identical render test
covers the whole page, this included).
"""
from __future__ import annotations

from typing import Optional, Sequence

_W = 220.0
_H = 44.0
_PAD = 3.0


def _fmt(x: float) -> str:
    # One fixed decimal; avoid "-0.0" so renders can't differ by sign of zero.
    v = round(x, 1)
    if v == 0.0:
        v = 0.0
    return ("%.1f" % v)


def sparkline_svg(
    values: Sequence[Optional[float]],
    *,
    css_class: str = "spark",
    baseline_zero: bool = False,
) -> str:
    """Polyline sparkline of a numeric series (Nones are skipped).

    ``baseline_zero=True`` includes 0 in the y-domain so profit/loss
    series show sign context. Returns "" for an empty series — callers
    skip the block instead of rendering an empty chart.
    """
    pts = [(i, float(v)) for i, v in enumerate(values) if v is not None]
    if not pts:
        return ""
    ys = [y for _, y in pts]
    lo, hi = min(ys), max(ys)
    if baseline_zero:
        lo, hi = min(lo, 0.0), max(hi, 0.0)
    span_x = max(len(values) - 1, 1)
    span_y = hi - lo

    def _xy(i: int, y: float) -> str:
        px = _PAD + (i / span_x) * (_W - 2 * _PAD)
        if span_y == 0:
            py = _H / 2.0
        else:
            py = _H - _PAD - ((y - lo) / span_y) * (_H - 2 * _PAD)
        return "%s,%s" % (_fmt(px), _fmt(py))

    coords = " ".join(_xy(i, y) for i, y in pts)
    last_i, last_y = pts[-1]
    last = _xy(last_i, last_y).split(",")
    parts = [
        '<svg class="%s" viewBox="0 0 %d %d" width="%d" height="%d"'
        ' role="img" aria-hidden="true" focusable="false">'
        % (css_class, int(_W), int(_H), int(_W), int(_H))
    ]
    if baseline_zero and lo < 0.0 < hi:
        zero_y = _H - _PAD - ((0.0 - lo) / span_y) * (_H - 2 * _PAD)
        parts.append(
            '<line class="spark-zero" x1="%s" y1="%s" x2="%s" y2="%s"/>'
            % (_fmt(_PAD), _fmt(zero_y), _fmt(_W - _PAD), _fmt(zero_y))
        )
    if len(pts) == 1:
        parts.append(
            '<circle class="spark-dot" cx="%s" cy="%s" r="2.5"/>'
            % (last[0], last[1])
        )
    else:
        parts.append('<polyline class="spark-line" points="%s"/>' % coords)
        parts.append(
            '<circle class="spark-dot" cx="%s" cy="%s" r="2.5"/>'
            % (last[0], last[1])
        )
    parts.append("</svg>")
    return "".join(parts)
