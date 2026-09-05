"""Client filing cadence — engine.firm.cadence.

WHAT IT DECIDES
  For one client: which period ends the firm expects a trial balance
  for, when each is due, whether the client is CURRENT / STALE /
  NEVER_FILED as of a date, and which reminders are due today.

WHAT IT REFUSES TO DO
  · read a clock — `as_of` is an explicit argument everywhere, so the
    same inputs give the same verdict on any day (determinism);
  · carry a cadence, a deadline or a nudge day in code — every number
    comes from packs/firm/cadence.yaml or from the client's stored
    override (data, not code);
  · name a firm, a client or a profile — no string comparison against
    an identity anywhere in this file (the no-name-branches rule the RO
    profiles pack lives under; token-scanned by the firm gates suite);
  · turn absence into zero — a client with no filed period is
    `never_filed`, and `periods_behind` is None, not 0.

HOW STALE IS DEFINED
  `latest_due` is the most recent expected period end whose deadline
  (period_end + deadline_days) is on or before `as_of`. A client whose
  latest filed period end is at or after `latest_due` is CURRENT; one
  whose latest filed period end is earlier is STALE by the number of
  expected period ends in (latest_filed, latest_due]. `days_overdue` is
  measured from the OLDEST missing period's deadline — the most severe
  fact, which is the one an accountant chases first.

Python 3.9 — no `match`, no `X | Y` unions. Stdlib + yaml only; this
module must never import engine.api or engine.ai.
"""
from __future__ import annotations

import calendar
import copy
import os
import threading
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

import yaml

#: Pack file schema tag (bump on shape changes, with a migration note).
SCHEMA = "firm_cadence_v1"

#: Env override for the pack file (ops + tests).
PATH_ENV = "FIRM_CADENCE_PACK_PATH"

#: Verdict vocabulary. `never_filed` is a GAP state, not a zero.
STATE_NEVER_FILED = "never_filed"
STATE_CURRENT = "current"
STATE_STALE = "stale"
STATES = (STATE_NEVER_FILED, STATE_CURRENT, STATE_STALE)


class CadencePackError(RuntimeError):
    """packs/firm/cadence.yaml is missing, unreadable, or fails validation.

    Loud on purpose: a cadence that silently fell back to a guessed
    deadline would file "current" verdicts against a number nobody
    chose."""


class CadenceInputError(ValueError):
    """A caller handed a value the pack does not define (an unknown
    cadence id, a fiscal month outside 1..12, an unparseable date)."""


# ── Pack ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CadenceSpec:
    id: str
    period_months: int
    deadline_days_after_period_end: int


@dataclass(frozen=True)
class CadencePack:
    default_cadence: str
    cadences: Dict[str, CadenceSpec]
    nudge_days_before_deadline: Tuple[int, ...]
    request_link_ttl_days: int
    lookback_periods: int
    source: str = ""

    def spec(self, cadence_id: str) -> CadenceSpec:
        spec = self.cadences.get(cadence_id)
        if spec is None:
            raise CadenceInputError(
                "unknown cadence %r (the pack defines: %s)"
                % (cadence_id, ", ".join(sorted(self.cadences))))
        return spec


_LOCK = threading.Lock()
_CACHE = {}  # type: Dict[str, CadencePack]


def default_pack_path() -> Path:
    # src/engine/firm/cadence.py -> parents[3] == the repo root.
    return Path(__file__).resolve().parents[3] / "packs" / "firm" / "cadence.yaml"


def _resolve_path(path: Optional[Any]) -> Path:
    if path is not None:
        return Path(path)
    env = os.environ.get(PATH_ENV)
    if env:
        return Path(env)
    return default_pack_path()


def _fail(path: Path, message: str) -> None:
    raise CadencePackError("firm cadence pack %s: %s" % (path, message))


def _positive_int(path: Path, value: Any, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        _fail(path, "%s must be an integer >= 1 (got %r)" % (what, value))
    return value


def _validate(path: Path, raw: Any) -> CadencePack:
    if not isinstance(raw, dict):
        _fail(path, "top level must be a mapping")
    if raw.get("schema") != SCHEMA:
        _fail(path, "schema must be %r (got %r)" % (SCHEMA, raw.get("schema")))
    cadences_raw = raw.get("cadences")
    if not isinstance(cadences_raw, dict) or not cadences_raw:
        _fail(path, "'cadences' must be a non-empty mapping")
    cadences = {}  # type: Dict[str, CadenceSpec]
    for cid, params in cadences_raw.items():
        if not isinstance(params, dict):
            _fail(path, "cadence %r must be a mapping" % cid)
        cadences[str(cid)] = CadenceSpec(
            id=str(cid),
            period_months=_positive_int(
                path, params.get("period_months"), "cadence %r period_months" % cid),
            deadline_days_after_period_end=_positive_int(
                path, params.get("deadline_days_after_period_end"),
                "cadence %r deadline_days_after_period_end" % cid),
        )
        if 12 % cadences[str(cid)].period_months != 0:
            _fail(path, "cadence %r period_months must divide 12" % cid)
    default = raw.get("default_cadence")
    if default not in cadences:
        _fail(path, "default_cadence %r is not a defined cadence" % default)
    nudges_raw = raw.get("nudge_days_before_deadline")
    if not isinstance(nudges_raw, list) or not nudges_raw:
        _fail(path, "'nudge_days_before_deadline' must be a non-empty list")
    nudges = tuple(sorted(
        (_positive_int(path, n, "nudge day") for n in nudges_raw), reverse=True))
    if len(set(nudges)) != len(nudges):
        _fail(path, "'nudge_days_before_deadline' repeats a value")
    return CadencePack(
        default_cadence=str(default),
        cadences=cadences,
        nudge_days_before_deadline=nudges,
        request_link_ttl_days=_positive_int(
            path, raw.get("request_link_ttl_days"), "request_link_ttl_days"),
        lookback_periods=_positive_int(
            path, raw.get("lookback_periods"), "lookback_periods"),
        source=str(path),
    )


def load_cadence_pack(path: Optional[Any] = None) -> CadencePack:
    """Load + validate + cache the pack (deep copy out, so a caller can
    never mutate the cached table)."""
    resolved = _resolve_path(path)
    key = str(resolved)
    with _LOCK:
        cached = _CACHE.get(key)
        if cached is None:
            if not resolved.is_file():
                _fail(resolved, "file not found")
            try:
                raw = yaml.safe_load(resolved.read_text(encoding="utf-8"))
            except Exception as exc:  # noqa: BLE001 — wrap into the loud typed error
                _fail(resolved, "unreadable YAML (%s)" % exc)
            cached = _validate(resolved, raw)
            _CACHE[key] = cached
        return copy.deepcopy(cached)


def clear_cache() -> None:
    with _LOCK:
        _CACHE.clear()


# ── Per-client cadence ───────────────────────────────────────────────────


@dataclass(frozen=True)
class ClientCadence:
    """One client's effective cadence: the pack default plus whatever the
    firm stored for this client. `source` says which."""

    client_org_id: str
    cadence_id: str
    period_months: int
    deadline_days: int
    fiscal_year_end_month: int
    nudge_days: Tuple[int, ...]
    source: str  # "pack_default" | "stored"

    def to_payload(self) -> Dict[str, Any]:
        return {
            "client_org_id": self.client_org_id,
            "cadence": self.cadence_id,
            "period_months": self.period_months,
            "deadline_days_after_period_end": self.deadline_days,
            "fiscal_year_end_month": self.fiscal_year_end_month,
            "nudge_days_before_deadline": list(self.nudge_days),
            "source": self.source,
        }


def _opt_int(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def resolve_client_cadence(client_org_id: str,
                           stored: Optional[Dict[str, Any]],
                           pack: Optional[CadencePack] = None) -> ClientCadence:
    """The pack default, overridden field-by-field by the stored row
    (`firm_client_cadence`). A stored row naming a cadence the pack does
    not define is a caller error, not a silent fallback."""
    pack = pack or load_cadence_pack()
    row = stored or {}
    cadence_id = str(row.get("cadence") or pack.default_cadence)
    spec = pack.spec(cadence_id)
    deadline_days = _opt_int(row.get("deadline_days_after_period_end"))
    if deadline_days is not None and deadline_days < 1:
        raise CadenceInputError("deadline_days_after_period_end must be >= 1")
    fye = _opt_int(row.get("fiscal_year_end_month"))
    if fye is None:
        fye = 12
    if fye < 1 or fye > 12:
        raise CadenceInputError("fiscal_year_end_month must be 1..12 (got %r)" % fye)
    nudges_raw = row.get("nudge_days_before")
    nudges = pack.nudge_days_before_deadline
    if isinstance(nudges_raw, list) and nudges_raw:
        parsed = []  # type: List[int]
        for n in nudges_raw:
            v = _opt_int(n)
            if v is None or v < 1:
                raise CadenceInputError("nudge_days_before entries must be integers >= 1")
            parsed.append(v)
        nudges = tuple(sorted(set(parsed), reverse=True))
    return ClientCadence(
        client_org_id=str(client_org_id),
        cadence_id=cadence_id,
        period_months=spec.period_months,
        deadline_days=(deadline_days if deadline_days is not None
                       else spec.deadline_days_after_period_end),
        fiscal_year_end_month=fye,
        nudge_days=nudges,
        source=("stored" if stored else "pack_default"),
    )


# ── Calendar arithmetic ──────────────────────────────────────────────────


def month_end(year: int, month: int) -> date:
    return date(year, month, calendar.monthrange(year, month)[1])


def _add_months(year: int, month: int, delta: int) -> Tuple[int, int]:
    index = year * 12 + (month - 1) + delta
    return index // 12, index % 12 + 1


def is_period_end_month(cadence: ClientCadence, month: int) -> bool:
    """Monthly: every month. Quarterly (period_months=3): the months that
    sit a whole number of periods from the fiscal-year-end month."""
    return (month - cadence.fiscal_year_end_month) % cadence.period_months == 0


def deadline_for(cadence: ClientCadence, period_end: date) -> date:
    return period_end + timedelta(days=cadence.deadline_days)


def previous_period_end(cadence: ClientCadence, period_end: date) -> date:
    y, m = _add_months(period_end.year, period_end.month, -cadence.period_months)
    return month_end(y, m)


def next_period_end(cadence: ClientCadence, period_end: date) -> date:
    y, m = _add_months(period_end.year, period_end.month, cadence.period_months)
    return month_end(y, m)


def latest_period_end_on_or_before(cadence: ClientCadence, day: date) -> date:
    """The most recent period end on or before `day`."""
    y, m = day.year, day.month
    candidate = month_end(y, m)
    if candidate > day:
        y, m = _add_months(y, m, -1)
        candidate = month_end(y, m)
    while not is_period_end_month(cadence, candidate.month):
        y, m = _add_months(y, m, -1)
        candidate = month_end(y, m)
    return candidate


def latest_due_period_end(cadence: ClientCadence, as_of: date) -> date:
    """The most recent period end whose DEADLINE has passed as of `as_of`."""
    candidate = latest_period_end_on_or_before(cadence, as_of)
    while deadline_for(cadence, candidate) > as_of:
        candidate = previous_period_end(cadence, candidate)
    return candidate


def expected_period_ends(cadence: ClientCadence, as_of: date,
                         lookback: int) -> List[date]:
    """The last `lookback` expected period ends whose deadlines have
    passed, oldest first."""
    if lookback < 1:
        raise CadenceInputError("lookback must be >= 1")
    ends = []  # type: List[date]
    candidate = latest_due_period_end(cadence, as_of)
    for _ in range(lookback):
        ends.append(candidate)
        candidate = previous_period_end(cadence, candidate)
    ends.reverse()
    return ends


# ── The verdict ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CadenceStatus:
    client_org_id: str
    cadence_id: str
    as_of: date
    state: str
    latest_due_period_end: date
    latest_due_deadline: date
    latest_filed_period_end: Optional[date]
    #: None when nothing was ever filed — ABSENT, not zero.
    periods_behind: Optional[int]
    #: The expected period ends the client is BEHIND on — every expected
    #: period end after the latest filing (all of the lookback window
    #: when nothing was ever filed), oldest first. Empty when current.
    missing_period_ends: Tuple[date, ...]
    #: Holes BEFORE the latest filing inside the lookback window. History
    #: gaps, reported separately: a client who filed July is current even
    #: if April never arrived, and the two facts must not blur.
    history_gaps: Tuple[date, ...]
    #: Days past the OLDEST period in `missing_period_ends`' deadline;
    #: None when current. `overdue_basis` names which period it is.
    days_overdue: Optional[int]
    overdue_basis: Optional[date]
    #: The next period end after `as_of`'s open period, and its deadline.
    next_period_end: date
    next_deadline: date
    #: Whether the currently OPEN period (ended, deadline ahead) has a file.
    open_period_end: Optional[date]
    open_period_filed: Optional[bool]

    def to_payload(self) -> Dict[str, Any]:
        return {
            "client_org_id": self.client_org_id,
            "cadence": self.cadence_id,
            "as_of": self.as_of.isoformat(),
            "state": self.state,
            "latest_due_period_end": self.latest_due_period_end.isoformat(),
            "latest_due_deadline": self.latest_due_deadline.isoformat(),
            "latest_filed_period_end": (self.latest_filed_period_end.isoformat()
                                        if self.latest_filed_period_end else None),
            "periods_behind": self.periods_behind,
            "missing_period_ends": [d.isoformat() for d in self.missing_period_ends],
            "history_gaps": [d.isoformat() for d in self.history_gaps],
            "days_overdue": self.days_overdue,
            "overdue_basis": (self.overdue_basis.isoformat()
                              if self.overdue_basis else None),
            "next_period_end": self.next_period_end.isoformat(),
            "next_deadline": self.next_deadline.isoformat(),
            "open_period_end": (self.open_period_end.isoformat()
                                if self.open_period_end else None),
            "open_period_filed": self.open_period_filed,
        }


def _as_date(value: Any, what: str) -> date:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        raise CadenceInputError("%s is not a date: %r" % (what, value))


def assess(cadence: ClientCadence, filed_period_ends: Iterable[Any],
           as_of: Any, lookback: Optional[int] = None,
           pack: Optional[CadencePack] = None) -> CadenceStatus:
    """The verdict for one client on one day. Pure: the same inputs give
    the same status whatever the wall clock says."""
    pack = pack or load_cadence_pack()
    day = _as_date(as_of, "as_of")
    window = lookback if lookback is not None else pack.lookback_periods
    filed = sorted(set(_as_date(v, "filed period end") for v in filed_period_ends))
    latest_filed = filed[-1] if filed else None

    latest_due = latest_due_period_end(cadence, day)
    expected = expected_period_ends(cadence, day, window)
    filed_set = set(filed)
    gaps = [d for d in expected if d not in filed_set]
    if latest_filed is None:
        missing = tuple(gaps)
        history = ()  # type: Tuple[date, ...]
    else:
        missing = tuple(d for d in gaps if d > latest_filed)
        history = tuple(d for d in gaps if d < latest_filed)

    # The OPEN period: ended, deadline still ahead. Reported so a nudge
    # can be scheduled before the deadline, never as "stale".
    open_end = latest_period_end_on_or_before(cadence, day)
    if deadline_for(cadence, open_end) <= day:
        open_period_end = None  # type: Optional[date]
        open_filed = None  # type: Optional[bool]
    else:
        open_period_end = open_end
        open_filed = open_end in filed_set
    nxt = next_period_end(cadence, open_end if open_period_end else latest_due)

    basis = None  # type: Optional[date]
    if latest_filed is None:
        state = STATE_NEVER_FILED
        behind = None  # type: Optional[int]
        overdue = None  # type: Optional[int]
        if missing:
            basis = missing[0]
            overdue = (day - deadline_for(cadence, basis)).days
    elif latest_filed >= latest_due:
        state = STATE_CURRENT
        behind = 0
        overdue = None
    else:
        state = STATE_STALE
        behind = 0
        candidate = latest_due
        while candidate > latest_filed:
            behind += 1
            candidate = previous_period_end(cadence, candidate)
        # The window may be shorter than the backlog; the oldest period
        # the client is behind on is then the one just after the filing.
        basis = missing[0] if missing else next_period_end(cadence, latest_filed)
        overdue = (day - deadline_for(cadence, basis)).days
    return CadenceStatus(
        client_org_id=cadence.client_org_id,
        cadence_id=cadence.cadence_id,
        as_of=day,
        state=state,
        latest_due_period_end=latest_due,
        latest_due_deadline=deadline_for(cadence, latest_due),
        latest_filed_period_end=latest_filed,
        periods_behind=behind,
        missing_period_ends=missing,
        history_gaps=history,
        days_overdue=overdue,
        overdue_basis=basis,
        next_period_end=nxt,
        next_deadline=deadline_for(cadence, nxt),
        open_period_end=open_period_end,
        open_period_filed=open_filed,
    )


# ── Nudges ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Nudge:
    """One reminder that is due: `days_before` the deadline of
    `period_end`, sendable on or after `send_on`."""

    client_org_id: str
    period_end: date
    deadline: date
    days_before: int
    send_on: date

    def key(self) -> Tuple[str, int]:
        return (self.period_end.isoformat(), self.days_before)

    def to_payload(self) -> Dict[str, Any]:
        return {
            "client_org_id": self.client_org_id,
            "period_end": self.period_end.isoformat(),
            "deadline": self.deadline.isoformat(),
            "days_before": self.days_before,
            "send_on": self.send_on.isoformat(),
        }


def nudges_due(cadence: ClientCadence, filed_period_ends: Iterable[Any],
               as_of: Any,
               already_sent: Iterable[Tuple[str, int]] = ()) -> List[Nudge]:
    """Reminders due on `as_of` for periods that have ENDED, whose
    deadline is still AHEAD, and for which no file has landed. A nudge
    fires once per (period_end, days_before); the caller records what it
    sent and hands it back as `already_sent`. Past-deadline periods are
    the STALE verdict's business, not a reminder's."""
    day = _as_date(as_of, "as_of")
    filed = set(_as_date(v, "filed period end") for v in filed_period_ends)
    sent = set((str(k[0]), int(k[1])) for k in already_sent)
    out = []  # type: List[Nudge]
    candidate = latest_period_end_on_or_before(cadence, day)
    # Only the open period(s): ended, deadline ahead. With a 25-day
    # deadline and monthly cadence that is at most one period; the loop
    # is general for longer deadlines.
    while candidate <= day and deadline_for(cadence, candidate) > day:
        if candidate not in filed:
            deadline = deadline_for(cadence, candidate)
            for days_before in cadence.nudge_days:
                send_on = deadline - timedelta(days=days_before)
                if send_on <= day and (candidate.isoformat(), days_before) not in sent:
                    out.append(Nudge(
                        client_org_id=cadence.client_org_id,
                        period_end=candidate, deadline=deadline,
                        days_before=days_before, send_on=send_on))
        candidate = previous_period_end(cadence, candidate)
    return out


__all__ = [
    "SCHEMA", "PATH_ENV", "STATES", "STATE_NEVER_FILED", "STATE_CURRENT",
    "STATE_STALE", "CadencePackError", "CadenceInputError", "CadenceSpec",
    "CadencePack", "ClientCadence", "CadenceStatus", "Nudge",
    "load_cadence_pack", "clear_cache", "default_pack_path",
    "resolve_client_cadence", "month_end", "deadline_for",
    "is_period_end_month", "previous_period_end", "next_period_end",
    "latest_period_end_on_or_before", "latest_due_period_end",
    "expected_period_ends", "assess", "nudges_due",
]
