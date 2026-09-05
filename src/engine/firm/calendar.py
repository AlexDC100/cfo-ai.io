"""THE FISCAL CALENDAR — packs/firm/calendar_<jurisdiction>.yaml, read.

A jurisdiction is an OPAQUE string. It resolves to a file by NAME
(``calendar_<code lower-cased>.yaml``) and is never compared to a literal
in code — a second jurisdiction is a second file with the same shape,
and a jurisdiction with no file yields :data:`None`: NO deadline items
and a stated absence, never a borrowed calendar.

Every due date is computed from an ``as_of`` the caller supplies.
Nothing here reads a clock.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import calendar as _cal
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from .pack import packs_dir

SHAPE_MONTHLY = "monthly"
SHAPE_QUARTERLY = "quarterly"
SHAPE_ANNUAL = "annual"
_SHAPES = (SHAPE_MONTHLY, SHAPE_QUARTERLY, SHAPE_ANNUAL)

ROLE_TRIAL_BALANCE_CLOSE = "trial_balance_close"
ROLE_FILING = "filing"


class CalendarError(ValueError):
    """The calendar file is malformed. Raised at load."""


@dataclass(frozen=True)
class CalendarRule:
    id: str
    role: str
    label: str
    shape: str
    day: int
    month: Optional[int]
    basis: str


@dataclass(frozen=True)
class Deadline:
    rule_id: str
    role: str
    label: str
    due_at: date
    period_end: Optional[date]           # the period the deadline belongs to
    basis: str

    def to_payload(self) -> Dict[str, Any]:
        return {
            "rule_id": self.rule_id, "role": self.role, "label": self.label,
            "due_at": self.due_at.isoformat(),
            "period_end": (self.period_end.isoformat() if self.period_end else None),
            "basis": self.basis,
        }


def _month_end(year: int, month: int) -> date:
    return date(year, month, _cal.monthrange(year, month)[1])


def _add_months(d: date, months: int) -> date:
    """Month arithmetic that lands on the END of the target month —
    period ends are month ends by convention."""
    idx = d.year * 12 + (d.month - 1) + months
    year, month = divmod(idx, 12)
    return _month_end(year, month + 1)


def _clamped(year: int, month: int, day: int) -> date:
    return date(year, month, min(day, _cal.monthrange(year, month)[1]))


class FiscalCalendar(object):
    def __init__(self, raw: Dict[str, Any], origin: str) -> None:
        self.origin = origin
        self.version = str(raw.get("version") or "")
        self.jurisdiction = str(raw.get("jurisdiction") or "")
        if not self.version or not self.jurisdiction:
            raise CalendarError("%s: version and jurisdiction are required" % origin)
        rules = []  # type: List[CalendarRule]
        for r in raw.get("rules") or ():
            shape = str(r.get("shape") or "")
            if shape not in _SHAPES:
                raise CalendarError(
                    "%s: rule %r shape %r is not one of %r"
                    % (origin, r.get("id"), shape, _SHAPES))
            month = r.get("month")
            if shape == SHAPE_ANNUAL and not month:
                raise CalendarError(
                    "%s: annual rule %r needs a month" % (origin, r.get("id")))
            rules.append(CalendarRule(
                id=str(r["id"]), role=str(r.get("role") or ROLE_FILING),
                label=str(r.get("label_en") or r["id"]), shape=shape,
                day=int(r.get("day") or 1),
                month=(None if month is None else int(month)),
                basis=str(r.get("basis") or "")))
        if not rules:
            raise CalendarError("%s: no rules" % origin)
        self.rules = tuple(rules)
        self._by_id = dict((r.id, r) for r in self.rules)

    def rule(self, rule_id: str) -> Optional[CalendarRule]:
        return self._by_id.get(rule_id)

    # -- due dates -------------------------------------------------------

    def due_for_period(self, rule_id: str, period_end: date) -> Optional[Deadline]:
        """The due date a rule attaches to ONE period (the month/quarter/
        year ending on ``period_end``). None when the rule is unknown."""
        rule = self._by_id.get(rule_id)
        if rule is None:
            return None
        if rule.shape == SHAPE_MONTHLY:
            nxt = _add_months(period_end, 1)
            due = _clamped(nxt.year, nxt.month, rule.day)
        elif rule.shape == SHAPE_QUARTERLY:
            nxt = _add_months(period_end, 1)
            due = _clamped(nxt.year, nxt.month, rule.day)
        else:
            due = _clamped(period_end.year + 1, int(rule.month or 1), rule.day)
        return Deadline(rule_id=rule.id, role=rule.role, label=rule.label,
                        due_at=due, period_end=period_end, basis=rule.basis)

    def deadlines_in_window(self, as_of: date, window_days: int,
                            roles: Tuple[str, ...] = (ROLE_FILING,)) -> List[Deadline]:
        """Every rule occurrence due within ``[as_of, as_of + window]``,
        in due-date order. Deterministic for a given ``as_of``."""
        horizon = as_of + timedelta(days=max(0, int(window_days)))
        out = []  # type: List[Deadline]
        for rule in self.rules:
            if rule.role not in roles:
                continue
            for period_end in self._period_ends_around(rule, as_of, horizon):
                dl = self.due_for_period(rule.id, period_end)
                if dl is not None and as_of <= dl.due_at <= horizon:
                    out.append(dl)
        out.sort(key=lambda d: (d.due_at, d.rule_id))
        return out

    @staticmethod
    def _period_ends_around(rule: CalendarRule, as_of: date,
                            horizon: date) -> List[date]:
        """Candidate period ends whose due date could fall in the window:
        walk from a few periods before ``as_of`` to just past the horizon."""
        ends = []  # type: List[date]
        if rule.shape == SHAPE_MONTHLY:
            start = _add_months(as_of, -3)
            cur = start
            while cur <= _add_months(horizon, 1):
                ends.append(cur)
                cur = _add_months(cur, 1)
        elif rule.shape == SHAPE_QUARTERLY:
            q_end_month = ((as_of.month - 1) // 3) * 3 + 3
            cur = _add_months(_month_end(as_of.year, q_end_month), -6)
            while cur <= _add_months(horizon, 3):
                ends.append(cur)
                cur = _add_months(cur, 3)
        else:
            for year in (as_of.year - 2, as_of.year - 1, as_of.year, as_of.year + 1):
                ends.append(date(year, 12, 31))
        return ends


def calendar_path(jurisdiction: str, base: Optional[Path] = None) -> Path:
    """packs/firm/calendar_<jurisdiction>.yaml — by NAME, no branch."""
    root = base or packs_dir()
    return root / ("calendar_%s.yaml" % str(jurisdiction or "").strip().lower())


def load_calendar(jurisdiction: str,
                  base: Optional[Path] = None) -> Optional[FiscalCalendar]:
    """The jurisdiction's calendar, or None when none is declared. A
    missing calendar is an ABSENCE the caller must state, not an error."""
    target = calendar_path(jurisdiction, base)
    if not target.is_file():
        return None
    with open(str(target), "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    if not isinstance(raw, dict):
        raise CalendarError("%s: top level must be a mapping" % target)
    return FiscalCalendar(raw, origin=str(target))


__all__ = [
    "CalendarError", "CalendarRule", "Deadline", "FiscalCalendar",
    "ROLE_FILING", "ROLE_TRIAL_BALANCE_CLOSE", "SHAPE_ANNUAL", "SHAPE_MONTHLY",
    "SHAPE_QUARTERLY", "calendar_path", "load_calendar",
]
